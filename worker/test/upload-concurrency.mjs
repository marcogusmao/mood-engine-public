import {spawn} from 'node:child_process';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
import {runtime,register,redeem,upload,stage,IDENTITY} from './upload-fixtures/runtime.mjs';
const option=(name,defaultValue)=>{const n=process.argv.indexOf(name);return n<0?defaultValue:Number(process.argv[n+1]);};
const clients=option('--clients',4),rounds=option('--rounds',20),archiveBytes=option('--archive-bytes',8388608);
assert.equal(clients,4);assert.equal(archiveBytes,8388608);assert.ok(rounds>=1&&rounds<=20);
async function race(configs){
 const children=configs.map(()=>spawn(process.execPath,[fileURLToPath(new URL('./upload-fixtures/race-client.mjs',import.meta.url))],{stdio:['ignore','ignore','pipe','ipc']}));
 try{
  // Every separate client reaches the barrier before any authenticated request is released.
  await Promise.all(children.map(child=>new Promise((resolve,reject)=>{child.once('message',m=>m.ready?resolve():reject(Error('missing barrier')));child.once('error',reject);child.once('exit',code=>{if(code)reject(Error('client exited before barrier'));});})));
  const result=await Promise.all(children.map((child,n)=>new Promise((resolve,reject)=>{child.once('message',m=>m.error?reject(Error(m.error)):resolve(m));child.once('error',reject);child.send(configs[n]);})));
  await Promise.all(children.map(child=>child.exitCode!==null?Promise.resolve():new Promise(resolve=>child.once('exit',resolve))));return result;
 }finally{for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');}
}
if(process.argv.includes('--sqlite-adapter')) { await (await import('./upload-fixtures/sqlite-races.mjs')).sqliteRaces({clients,rounds,archiveBytes}); } else {
const r=await runtime();let epoch=0;const receipts=[];
try{
 for(let round=0;round<rounds;round++){
  await r.clock(round*86400000);
  const invite=await register(r,epoch);epoch=invite.authEpoch;
  const credentials=Array.from({length:clients},()=>Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'));
  const redeemed=await race(credentials.map(credential=>({base:r.base,path:'/session',token:invite.invitation,body:{...IDENTITY,inviteId:invite.inviteId,credential}})));
  assert.equal(redeemed.filter(x=>x.status===201).length,1);assert.equal(redeemed.filter(x=>x.status===409).length,3);
  const token=credentials[redeemed.findIndex(x=>x.status===201)];assert.equal((await r.call('/session',{token:invite.invitation,body:{...IDENTITY,inviteId:invite.inviteId,credential:token}})).status,200);
  const requestId=await upload(r,token,new Uint8Array(archiveBytes).fill(round));
  const claims=await race(Array.from({length:clients},(_,n)=>({base:r.base,path:'/claim',role:'build',runId:String(1000+round*4+n),offset:r.offset,body:IDENTITY})));
  assert.equal(claims.filter(x=>x.status===200).length,1);assert.equal(claims.filter(x=>x.status===204).length,3);
  const lease=claims.find(x=>x.status===200).body;assert.equal(lease.requestId,requestId);
  const staged=await stage(r,lease);await r.receipts(staged.receipts);
  const acknowledged=await race(Array.from({length:clients},()=>({base:r.base,path:`/publications/${lease.revision}/ack`,role:'deploy',runId:lease.runId,offset:r.offset,body:{...IDENTITY,receiptSha256:staged.receiptSha256}})));
  assert.ok(acknowledged.every(x=>x.status===200));assert.equal((await r.call('/publication')).body.activePublication.revision,lease.revision);
  assert.equal((await r.call('/prepared',{role:'deploy'})).body.publications.length,0);
  receipts.push({round:round+1,redeemers:1,claimants:1,acknowledgedRevision:1,archiveBytes});
 }
 console.log(JSON.stringify({proof:'four separately spawned HTTP clients and SQLite DO',rounds,clients,archivesBytes:rounds*archiveBytes,results:receipts,externalNetworkCalls:0}));
}finally{await r.close();}

}
