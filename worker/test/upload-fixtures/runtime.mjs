import { spawn } from 'node:child_process';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';import { resolve,dirname } from 'node:path';import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
export const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
export const IDENTITY={schemaVersion:1,personId:'friend-a'};
// S7c (review of 20/10/2026): no private key is versioned. The RS256 pair that signs the fixture tokens is generated here, once per test run,
// and its public half goes to the local Worker as the WILL_LOCAL_JWKS var (see runtime() and local-entry.js). Child processes (race-client.mjs)
// inherit the private half through the environment, so they sign with the same pair; a process started alone generates its own, which no server trusts.
export const LOCAL_KID='local-generated-per-run'; // not the kid of the old versioned key: test/no-versioned-private-key.test.js keeps that one out of every code file
const RSA={name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'};
let localKeyPromise;
export function localKey() {
 return localKeyPromise??=(async()=>{
  const stored=process.env.WILL_LOCAL_SIGNING_KEY;
  const privateJwk=stored?JSON.parse(stored):await crypto.subtle.exportKey('jwk',(await crypto.subtle.generateKey({...RSA,modulusLength:2048,publicExponent:new Uint8Array([1,0,1])},true,['sign','verify'])).privateKey);
  process.env.WILL_LOCAL_SIGNING_KEY=JSON.stringify(privateJwk);
  return {privateKey:await crypto.subtle.importKey('jwk',privateJwk,RSA,false,['sign']),jwks:{keys:[{key_ops:['verify'],ext:true,alg:'RS256',kty:'RSA',n:privateJwk.n,e:privateJwk.e,kid:LOCAL_KID,use:'sig'}]}};
 })();
}
export const sha=async data=>Buffer.from(await crypto.subtle.digest('SHA-256',typeof data==='string'?new TextEncoder().encode(data):data)).toString('hex');
export const canonical=v=>{if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';};
export async function jwt(role,runId='123',runAttempt='1',offset=0) {
 const environment={build:'mood-will-build',deploy:'github-pages',admin:'mood-will-admin'}[role],now=Math.floor((Date.now()+offset)/1000);
 const claims={iss:'https://token.actions.githubusercontent.com',aud:`urn:mood-engine:friend-a:${role}:v1`,repository:'marcogusmao/mood-engine',repository_id:'1413569629',repository_owner_id:'50679408',ref:'refs/heads/main',ref_type:'branch',runner_environment:'github-hosted',environment,sub:`repo:marcogusmao/mood-engine:environment:${environment}`,workflow_ref:`marcogusmao/mood-engine/.github/workflows/${role==='admin'?'will-invitation':'mood-engine'}.yml@refs/heads/main`,event_name:'workflow_dispatch',sha:'e'.repeat(40),run_id:runId,run_attempt:runAttempt,iat:now,nbf:now,exp:now+300};
 const p=Buffer.from(JSON.stringify({alg:'RS256',kid:LOCAL_KID,typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url');
 const {privateKey:k}=await localKey();return p+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',k,new TextEncoder().encode(p))).toString('base64url');
}
export async function runtime({entry=resolve(ROOT,'worker/test/upload-fixtures/local-entry.js'),vars={}}={}) {
 const {jwks}=await localKey(),temp=await mkdtemp(resolve(tmpdir(),'mood-will-runtime-')),port=20000+Math.floor(Math.random()*20000),base=`http://127.0.0.1:${port}`;
 const config=resolve(temp,'wrangler.json');await writeFile(config,JSON.stringify({name:'mood-will-local-proof',main:entry,compatibility_date:'2025-09-01',vars:{WILL_UPLOAD_ENABLED:'true',WILL_BROWSER_ORIGIN:'https://marcogusmao.github.io',WILL_PAGES_BASE:'https://marcogusmao.github.io/mood-engine',WILL_REPOSITORY_ID:'1413569629',WILL_REPOSITORY_OWNER_ID:'50679408',WILL_LOCAL_JWKS:JSON.stringify(jwks),...vars},durable_objects:{bindings:[{name:'WILL_STATE',class_name:'WillState'}]},migrations:[{tag:'local-sqlite-v1',new_sqlite_classes:['WillState']}]}));
 let child,output='';const r={base,temp,offset:0};
 r.start=async()=>{
  output='';child=spawn(process.execPath,['--require',resolve(ROOT,'worker/test/upload-fixtures/offline.cjs'),resolve(ROOT,'worker/node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config',config,'--persist-to',resolve(temp,'persist'),'--ip','127.0.0.1','--port',String(port),'--inspector-port','0','--log-level','error'],{cwd:resolve(ROOT,'worker'),env:{...process.env,WRANGLER_SEND_METRICS:'false',CI:'true',BROWSER:'none',CLOUDFLARE_API_TOKEN:'',CLOUDFLARE_ACCOUNT_ID:'',XDG_CONFIG_HOME:temp,WRANGLER_LOG_PATH:resolve(temp,'wrangler.log')},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const end=Date.now()+30000;while(Date.now()<end){if(child.exitCode!==null)throw Error('local runtime exited: '+output);try{if((await fetch(base+'/fixture/health')).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw Error('local runtime did not start: '+output);
 };
 r.stop=async()=>{if(child&&child.exitCode===null){const done=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await Promise.race([done,new Promise(resolve=>setTimeout(resolve,5000))]);if(child.exitCode===null){child.kill('SIGKILL');await done;}}};
 r.close=async()=>{await r.stop();await rm(temp,{recursive:true,force:true});};
 r.call=async(path,{role,token,body,method,headers={},runId='123',runAttempt='1'}={})=>{
  const internal=!!role;const h={...headers};if(role)h.Authorization='Bearer '+await jwt(role,runId,runAttempt,r.offset);else if(token)h.Authorization='Bearer '+token;
  if(!internal)h.Origin='https://marcogusmao.github.io';
  let payload=body;if(body&&!(body instanceof Uint8Array)){payload=JSON.stringify(body);h['Content-Type']='application/json';}else if(body instanceof Uint8Array)h['Content-Type']='application/octet-stream';
  const res=await fetch(base+(internal?'/api/internal/v1/friend-a':'/api/v1/friend-a')+path,{method:method||(body?'POST':'GET'),headers:h,body:payload});const text=await res.text();return {status:res.status,headers:res.headers,body:text&&res.headers.get('content-type')?.includes('json')?JSON.parse(text):text};
 };
 r.clock=async(offset)=>{r.offset=offset;assert.equal((await fetch(base+'/fixture/clock',{method:'POST',body:JSON.stringify({offset})})).status,200);};
 r.receipts=async data=>{assert.equal((await fetch(base+'/fixture/receipts',{method:'POST',body:JSON.stringify(data)})).status,200);};
 try{await r.start();return r;}catch(e){await r.stop();await writeFile(resolve(ROOT,'.context/2026-10-14-local-runtime-failure.log'),output+'\n'+String(e));await rm(temp,{recursive:true,force:true});throw e;}
}
export async function register(r,epoch=0) {
 const invitation=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),inviteId=crypto.randomUUID(),credential=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
 const res=await r.call('/invitations',{role:'admin',body:{...IDENTITY,inviteId,tokenHash:await sha(invitation),expiresAt:new Date(Date.now()+r.offset+86400000).toISOString(),expectedAuthEpoch:epoch}});assert.equal(res.status,201,JSON.stringify(res.body));
 return {invitation,inviteId,credential,authEpoch:res.body.authEpoch};
}
export async function redeem(r,invite) { const res=await r.call('/session',{token:invite.invitation,body:{...IDENTITY,inviteId:invite.inviteId,credential:invite.credential}});assert.ok([200,201].includes(res.status),JSON.stringify(res.body));return invite.credential; }
export async function upload(r,token,bytes=new Uint8Array([80,75,1,2])) {
 const chunks=[];for(let pos=0;pos<bytes.length;pos+=262144){const part=bytes.slice(pos,pos+262144);chunks.push({ordinal:chunks.length,bytes:part.length,sha256:await sha(part)});}
 const requestId=crypto.randomUUID(),res=await r.call('/uploads',{token,body:{...IDENTITY,requestId,kind:'letterboxd-export',bytes:bytes.length,archiveSha256:await sha(bytes),chunks}});assert.equal(res.status,201,JSON.stringify(res.body));
 for(const c of chunks){const res=await r.call(`/uploads/${requestId}/chunks/${c.ordinal}`,{token,method:'PUT',body:bytes.slice(c.ordinal*262144,c.ordinal*262144+c.bytes),headers:{'X-Chunk-SHA256':c.sha256}});assert.equal(res.status,204,JSON.stringify(res.body));}
 const complete=await r.call(`/uploads/${requestId}/complete`,{token,body:IDENTITY});assert.equal(complete.status,202,JSON.stringify(complete.body));assert.equal(complete.body.state,'queued');return requestId;
}
export async function stage(r,lease) {
 const packageBytes=new TextEncoder().encode(canonical({...IDENTITY,parserVersion:1,sourceRequestId:lease.requestId,codeSha:'e'.repeat(40),capturedAt:'2026-10-14T12:00:00.000Z',selectionDate:'2026-10-14',files:[{path:'history.json',data:{synthetic:true},bytes:18,sha256:await sha(canonical({synthetic:true}))}]}));
 const hash=await sha(packageBytes),b={...IDENTITY,requestId:lease.requestId,leaseEpoch:lease.leaseEpoch};
 const allocated=await r.call(`/requests/${lease.requestId}/snapshots`,{role:'build',runId:lease.runId,runAttempt:lease.runAttempt,body:{...b,bytes:packageBytes.length,contentSha256:hash,chunks:[{ordinal:0,bytes:packageBytes.length,sha256:hash}]}});assert.equal(allocated.status,201,JSON.stringify(allocated.body));const snapshotId=allocated.body.snapshotId;
 assert.equal((await r.call(`/snapshots/${snapshotId}/chunks/0`,{role:'build',runId:lease.runId,runAttempt:lease.runAttempt,method:'PUT',body:packageBytes,headers:{'X-Chunk-SHA256':hash,'X-Request-Id':lease.requestId,'X-Lease-Epoch':String(lease.leaseEpoch)}})).status,204);
 assert.equal((await r.call(`/snapshots/${snapshotId}/seal`,{role:'build',runId:lease.runId,runAttempt:lease.runAttempt,body:{...b,parserVersion:1,coverage:Object.fromEntries(['watched','ratings','watchlist','likes','diary','following'].map(k=>[k,'unknown']))}})).status,200);
 const context=canonical({...IDENTITY,revision:lease.revision}),personContextSha256=await sha(context),receipt=canonical({...IDENTITY,revision:lease.revision,codeSha:'e'.repeat(40),builtAt:'2026-10-14T12:00:00.000Z',filesSha256:'f'.repeat(64),personContextSha256}),receiptSha256=await sha(receipt);
 const prep={...b,snapshotId,revision:lease.revision,codeSha:'e'.repeat(40),receiptSha256,fileManifestSha256:'f'.repeat(64),personContextSha256};
 assert.equal((await r.call(`/requests/${lease.requestId}/prepare`,{role:'build',runId:lease.runId,runAttempt:lease.runAttempt,body:prep})).status,200);
 const base=`https://marcogusmao.github.io/mood-engine/u/friend-a/r/${lease.revision}/`;
 return {snapshotId,packageBytes,prep,receiptSha256,receipts:{[base+'publication.json']:receipt,[base+'data/person.json']:context}};
}
