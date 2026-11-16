import test from 'node:test';
import a from 'node:assert/strict';
import {rig} from './upload-fixtures/sqlite.js';
import {identity} from '../src/upload/protocol.js';

for(const mode of ['reported failure','expired lease'])test(`terminal candidate cleanup: ${mode} frees capacity for the next publication`,async t=>{
 const r=await rig();t.after(()=>r.ctx.db.close());
 for(let n=0;n<2;n++){
  const s=await r.stage();
  await r.state.acknowledge('ack',s.lease.revision,identity({receiptSha256:s.prep.receiptSha256}),{...r.oidc,role:'deploy'});
 }
 const owner=r.state.owner(),protectedIds=[owner.activeSnapshotId,owner.previousSnapshotId];
 const protectedBytes=new Map(protectedIds.map(id=>[id,r.state.sql.exec('SELECT data FROM chunks WHERE blob_id=? ORDER BY ordinal',id).toArray()]));
 let lease=r.call('claim',identity())[1];
 const failedId=lease.requestId,originalCall=r.call;
 for(let attempt=1;attempt<=3;attempt++){
  r.call=(name,...args)=>{if(name==='prepare')throw Error('lost before prepare');return originalCall(name,...args);};
  await a.rejects(()=>r.stage(lease),/lost before prepare/);r.call=originalCall;
  if(mode==='reported failure'){
   r.call('fail',identity({requestId:lease.requestId,leaseEpoch:lease.leaseEpoch,code:'BUILD_FAILED',retryable:true}));
   r.clock+=61*60000;
  }else r.clock+=6*3600000+1;
  if(attempt<3)lease=r.call('claim',identity())[1];
  else if(mode==='expired lease')a.equal(r.call('claim',identity())[0],204);
 }
 a.equal(r.state.request(failedId).state,'failed');
 const abandoned=r.state.all('blobs').filter(b=>!protectedIds.includes(b.blobId));
 a.equal(abandoned.length,1);a(abandoned[0].sealedAt);
 a.equal(r.state.owner().pending,null);
 r.clock+=86400000;
 // Use the real adapter: it must clean terminal storage before the next claim.
 const request=new Request('https://internal/operation',{headers:{'X-Mood-Operation':JSON.stringify({name:'claim',actor:r.oidc,body:identity()})}});
 const response=await r.state.fetch(request);a.equal(response.status,200);
 const next=await response.json();a.notEqual(next.requestId,failedId);
 for(const b of abandoned){a.equal(r.state.row('blobs',b.blobId),null,'terminal candidate must release its slot');a.equal(r.state.chunkRows(b.blobId).length,0);}
 for(const id of protectedIds){a(r.state.row('blobs',id)?.sealedAt);a.deepEqual(r.state.sql.exec('SELECT data FROM chunks WHERE blob_id=? ORDER BY ordinal',id).toArray(),protectedBytes.get(id));}
 a.throws(()=>r.call('heartbeat',identity({requestId:failedId,leaseEpoch:lease.leaseEpoch})),e=>e.code==='STALE_LEASE');
 const published=await r.stage(next);
 await r.state.acknowledge('ack',published.lease.revision,identity({receiptSha256:published.prep.receiptSha256}),{...r.oidc,role:'deploy'});
 a.equal(r.state.owner().activeRevision,published.lease.revision);
 a.equal(r.state.owner().previousSnapshotId,owner.activeSnapshotId);
 a.equal(r.state.all('blobs').filter(b=>b.kind==='snapshot').length,2);
});
