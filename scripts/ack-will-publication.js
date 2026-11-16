#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),PUB=require('../lib/people-publication'),I=require('../lib/person-input'),{createClient,bounded}=require('./will-private-client');
const PAGES='https://marcogusmao.github.io',BASE='/mood-engine/u/friend-a/';
function pagesFetcher({revision,fetchImpl=fetch,signal}){if(!PUB.REV.test(revision))throw Error('Invalid public revision');return async(name,cap)=>{if(name.includes('\\')||name.split('/').some(p=>!p||p==='.'||p==='..')||!(require('../lib/learning/public').isPublicFile(name)||/^posters\/tt\d+\.jpg$/.test(name)))throw Error('Invalid public fetch path');const url=PAGES+BASE+'r/'+revision+'/'+name;const r=await fetchImpl(url,{redirect:'error',cache:'no-store',headers:{'Cache-Control':'no-cache'},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});if(!r.ok)throw Error('PUBLIC_FILE_UNAVAILABLE');return bounded(r,cap);};}
async function verifyLive({descriptor,fetchImpl=fetch,signal}){
 if(!PUB.REV.test(descriptor.revision))throw Error('Invalid prepared revision');const get=pagesFetcher({revision:descriptor.revision,fetchImpl,signal});
 const receipt=await get('publication.json',8192);if(I.sha(receipt)!==descriptor.receiptSha256)throw Error('PUBLIC_RECEIPT_MISMATCH');const r=JSON.parse(receipt);
 if(r.personId!=='friend-a'||r.revision!==descriptor.revision||r.filesSha256!==descriptor.fileManifestSha256||r.personContextSha256!==descriptor.personContextSha256||r.codeSha!==descriptor.codeSha)throw Error('PUBLIC_RECEIPT_IDENTITY_MISMATCH');
 const raw=await get('files.json',2*1024*1024);if(I.sha(raw)!==descriptor.fileManifestSha256)throw Error('PUBLIC_MANIFEST_MISMATCH');const files=JSON.parse(raw);if(!Array.isArray(files)||files.length>30000)throw Error('PUBLIC_MANIFEST_INVALID');let total=0;const seen=new Set();for(const f of files){if(!f||typeof f.path!=='string'||seen.has(f.path)||!Number.isInteger(f.bytes)||f.bytes<0||!/^[a-f0-9]{64}$/.test(f.sha256)||Object.keys(f).sort().join(',')!=='bytes,path,sha256')throw Error('PUBLIC_MANIFEST_INVALID');seen.add(f.path);total+=f.bytes;}if(total>256*1024*1024||!seen.has('data/person.json'))throw Error('PUBLIC_MANIFEST_INVALID');
 let cursor=0,context=null;await Promise.all(Array.from({length:Math.min(4,files.length)},async()=>{while(cursor<files.length){const f=files[cursor++],b=await get(f.path,f.bytes);if(b.length!==f.bytes||I.sha(b)!==f.sha256)throw Error('PUBLIC_FILE_MISMATCH');if(f.path==='data/person.json'){context=PUB.validateContext(JSON.parse(b));if(context.revision!==descriptor.revision||I.sha(b)!==descriptor.personContextSha256)throw Error('PUBLIC_CONTEXT_MISMATCH');}}}));
 const shell=await fetchImpl(PAGES+BASE,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)});if(!shell.ok)throw Error('PUBLIC_SHELL_UNAVAILABLE');await bounded(shell,1024*1024);return context;
}
// The two checks after the acknowledgement, and how long they keep asking (21/10/2026, Marco, lote 1 item 4). The Worker keeps the active publication 60 s in the memory of each isolate (S1, worker/README.md); the
// acknowledgement drops that copy only in the isolate that handled it, so another isolate that read the pointer in the last minute still answers with the PREVIOUS revision, and a single check right after the
// acknowledgement failed with ACKED_PUBLIC_STATUS_MISMATCH / ACKED_LIVE_ADDON_MISMATCH on a night when Will's page or addon had been open (and, in the `reconcile-will` job, that failure skipped Marco's own night).
// Now: nothing is read until `settleMs` (60 s, the length of that copy) after the acknowledgement; then both checks are repeated every `pollMs` until they agree with the new revision `consecutive` times in a
// row (a reading that disagrees or fails starts the count again); if that has not happened `limitMs` after the acknowledgement, ACKED_NOT_CONVERGED (the script exits 1; the acknowledgement itself is accepted
// and stays). The acknowledgement cannot wait for the checks: the new revision is not the pointer until the Worker accepts it. Per isolate, best effort; not measured on Cloudflare.
const PROPAGATION={settleMs:60000,pollMs:5000,consecutive:3,limitMs:120000};
async function checkAcknowledged({origin,descriptor,fetchImpl}){
 const publicRes=await fetchImpl(origin+'/api/v1/friend-a/publication',{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)});if(!publicRes.ok)throw Error('ACKED_PUBLIC_STATUS_UNAVAILABLE');const pub=JSON.parse(await bounded(publicRes,16384));if(pub.personId!=='friend-a'||pub.activePublication?.revision!==descriptor.revision)throw Error('ACKED_PUBLIC_STATUS_MISMATCH');
 const manifest=await fetchImpl(origin+'/u/friend-a/manifest.json',{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)});const body=JSON.parse(await bounded(manifest,65536));if(!manifest.ok||manifest.headers.get('X-Mood-Person')!=='friend-a'||manifest.headers.get('X-Mood-Revision')!==descriptor.revision||body.id!=='com.mgusmao.moodengine.live.friend-a'||body.types.some(v=>v!=='movie')||body.resources.some(v=>(typeof v==='string'?v:v.name)!=='catalog'))throw Error('ACKED_LIVE_ADDON_MISMATCH');
}
async function waitForPropagation({check,clock,sleep,propagation,log,revision}){
 const {settleMs,pollMs,consecutive,limitMs}=propagation,start=clock();let streak=0,last=null,rounds=0;
 log(`acknowledgement of ${revision} accepted; waiting ${Math.round(settleMs/1000)} s for the copies of the previous revision in other isolates to expire, then ${consecutive} agreeing readings in a row (at most ${Math.round(limitMs/1000)} s)`);
 while(true){
  const elapsed=clock()-start;
  if(elapsed<settleMs){await sleep(settleMs-elapsed);continue;}
  rounds++;try{await check();streak++;}catch(e){streak=0;last=e;}
  if(streak>=consecutive){log(`public status and live addon name ${revision} in ${consecutive} readings in a row`);return;}
  if(clock()-start+pollMs>=limitMs||rounds>=1000)break; // the next reading would start at or after the limit
  await sleep(pollMs);
 }
 throw Error(`ACKED_NOT_CONVERGED: the acknowledgement of ${revision} was accepted, but the public status and the live addon did not name it in ${consecutive} readings in a row within ${Math.round(limitMs/1000)} s (last reading: ${last?last.message:'none failed, the count did not reach '+consecutive}). Another isolate may still hold the previous revision, or the Worker does not serve this one; read GET /api/v1/friend-a/publication by hand. The acknowledgement is not undone.`);
}
async function acknowledge({client,origin,descriptor,reconcile=false,fetchImpl=fetch,clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),windowMs=600000,propagation=PROPAGATION,log=()=>{}}){
 const deadline=clock()+windowMs;while(true){try{await verifyLive({descriptor,fetchImpl,signal:windowMs>0?AbortSignal.timeout(Math.max(1,deadline-clock())):undefined});break;}catch(e){if(clock()+10000>=deadline)throw e;await sleep(10000);}}
 const result=await client.request('POST',`/publications/${descriptor.revision}/${reconcile?'reconcile':'ack'}`,{body:{receiptSha256:descriptor.receiptSha256}});
 await waitForPropagation({check:()=>checkAcknowledged({origin,descriptor,fetchImpl}),clock,sleep,propagation,log,revision:descriptor.revision});return result;
}
async function reconcilePrepared(options){try{return await acknowledge({...options,reconcile:true,windowMs:0});}catch(e){if(['PUBLIC_FILE_UNAVAILABLE','PUBLIC_SHELL_UNAVAILABLE'].includes(e.message))return {replayRequired:true};throw e;}}
// `deps` exists for the tests (a fake client, fetch, clock and propagation); the nightly passes none. `--reconcile` and the plain run both go through `acknowledge`, so both wait for the propagation (21/10/2026).
async function main(args,deps={}){const origin=deps.origin??process.env.WILL_API_ORIGIN,client=deps.client||createClient({origin,role:'deploy'}),extra={...(deps.fetchImpl?{fetchImpl:deps.fetchImpl}:{}),...(deps.clock?{clock:deps.clock}:{}),...(deps.sleep?{sleep:deps.sleep}:{}),...(deps.propagation?{propagation:deps.propagation}:{}),log:deps.log||(m=>console.error(m))},prepared=await client.request('GET','/prepared');if(prepared.publications.length>1)throw Error('Multiple prepared publications');const results=[];for(const descriptor of prepared.publications)results.push(await (args.includes('--reconcile')?reconcilePrepared({client,origin,descriptor,...extra}):acknowledge({client,origin,descriptor,reconcile:true,...extra})));console.log(JSON.stringify({verified:results.filter(r=>!r.replayRequired).length,replayRequired:results.some(r=>r.replayRequired)}));}
/** The exit code of a run: 0 when `main` finishes, 1 with the message on stderr when it throws (ACKED_NOT_CONVERGED included). */
async function cli(args,deps){try{await main(args,deps);return 0;}catch(e){console.error(e.message);return 1;}}
if(require.main===module)cli(process.argv.slice(2)).then(code=>{process.exitCode=code;});
module.exports={reconcilePrepared,PAGES,BASE,pagesFetcher,verifyLive,acknowledge,main,cli,waitForPropagation,PROPAGATION};
