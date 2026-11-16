import {spawn} from 'node:child_process';import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
import {rig} from './sqlite.js';import {identity,digest} from '../../src/upload/protocol.js';
export async function sqliteRaces({clients,rounds,archiveBytes}){
 const dir=await mkdtemp(join(tmpdir(),'mood-sqlite-20-rounds-')),path=join(dir,'state.sqlite'),r=await rig({path});let epoch=1;const results=[];
 async function race(configs){const children=configs.map(()=>spawn(process.execPath,[fileURLToPath(new URL('./sqlite-process.mjs',import.meta.url)),path,String(r.clock)],{stdio:['ignore','ignore','ignore','ipc']}));try{await Promise.all(children.map(c=>new Promise((resolve,reject)=>{c.once('message',resolve);c.once('error',reject);})));const result=await Promise.all(children.map((c,n)=>new Promise((resolve,reject)=>{c.once('message',resolve);c.once('error',reject);c.send(configs[n]);})));await Promise.all(children.map(c=>c.exitCode!==null?null:new Promise(resolve=>c.once('exit',resolve))));return result;}finally{for(const c of children)if(c.exitCode===null)c.kill('SIGTERM');}}
 try{
 for(let round=0;round<rounds;round++){
  r.clock=Date.parse('2026-10-14T12:00:00.000Z')+round*86400000;
  const inviteId=crypto.randomUUID(),tokenHash=await digest('x'.repeat(43));
  r.call('invitations',identity({inviteId,tokenHash,expiresAt:new Date(r.clock+86400000).toISOString(),expectedAuthEpoch:epoch}),{},{role:'admin'});epoch++;
  const hashes=await Promise.all(Array.from({length:clients},(_,n)=>digest(`${n}`.repeat(43))));
  const sessions=await race(hashes.map(credentialHash=>({name:'session',body:identity({inviteId,credential:'synthetic-only'}),actor:{role:'invitation',hash:tokenHash,credentialHash}})));
  assert.equal(sessions.filter(s=>s.status===201).length,1);assert.equal(sessions.filter(s=>s.code==='INVITE_USED').length,clients-1);r.auth={role:'credential',hash:hashes[sessions.findIndex(s=>s.status===201)]};
  const id=await r.upload(new Uint8Array(archiveBytes).fill(round));
  const claims=await race(Array.from({length:clients},(_,n)=>({name:'claim',body:identity(),actor:{...r.oidc,runId:String(1000+4*round+n)}})));
  assert.equal(claims.filter(s=>s.status===200).length,1);assert.equal(claims.filter(s=>s.status===204).length,clients-1);const lease=claims.find(s=>s.status===200).body;assert.equal(lease.requestId,id);r.oidc={...r.oidc,runId:lease.runId};
  const staged=await r.stage(lease),acks=await race(Array.from({length:clients},()=>({name:'ack',p:{revision:lease.revision},body:identity({receiptSha256:staged.prep.receiptSha256}),actor:{...r.oidc,role:'deploy'},receipts:Object.fromEntries(r.receipts)})));
  assert.ok(acks.every(a=>a.status===200),JSON.stringify(acks));assert.equal(r.state.owner().activeRevision,lease.revision);assert.ok(r.state.all('blobs').filter(b=>b.kind==='snapshot').length<=3);
  results.push({round:round+1,invitationConsumers:1,leaseOwners:1,revisionPromotions:1,archiveBytes});
 }
 const receipt={proof:'node:sqlite file adapter, production state queries, no listening socket; does not prove workerd HTTP',clients,rounds,archivesBytes:rounds*archiveBytes,processes:clients*3*rounds,results};
 await writeFile(resolve('.context','2026-10-14-sqlite-races.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
 }finally{r.ctx.db.close();await rm(dir,{recursive:true,force:true});}
}
