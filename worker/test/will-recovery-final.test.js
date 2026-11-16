import test from 'node:test';
import a from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {rig} from './upload-fixtures/sqlite.js';
import {identity,digest} from '../src/upload/protocol.js';

for(const mode of ['retryable fail','expired lease'])for(const incomplete of [false,true])test(`will-recovery-final ${mode} (incomplete replacement ${incomplete}): sealed retry survives restart and repeated replacement`,async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'will-recovery-final-')),db=path.join(dir,'state.sqlite');
 let r=await rig({path:db});t.after(()=>{r.ctx.db.close();fs.rmSync(dir,{recursive:true,force:true});});
 for(let i=0;i<2;i++){const s=await r.stage();await r.state.acknowledge('ack',s.lease.revision,identity({receiptSha256:s.prep.receiptSha256}),{...r.oidc,role:'deploy'});}
 const owner=r.state.owner(),protectedIds=[owner.activeSnapshotId,owner.previousSnapshotId];
 // Transport fails before prepare reaches the Worker, after all snapshot bytes were sealed.
 const call=r.call;let pending;r.call=(name,body,...rest)=>{if(name==='prepare'){pending=body;throw Error('prepare transport lost');}return call(name,body,...rest);};
 await a.rejects(()=>r.stage(),/prepare transport lost/);r.call=call;
 let lease={requestId:pending.requestId,leaseEpoch:pending.leaseEpoch},source=pending.snapshotId;
 const bytes=new Uint8Array([9,8,7]),hash=await digest(bytes);
 const manifest=()=>identity({requestId:lease.requestId,leaseEpoch:lease.leaseEpoch,bytes:bytes.length,chunks:[{ordinal:0,bytes:bytes.length,sha256:hash}],contentSha256:hash});
 const snapshots=()=>r.state.all('blobs').filter(b=>b.kind==='snapshot');
 for(let round=0;round<2;round++){
  const stale={...lease};
  if(mode==='retryable fail')r.call('fail',identity({...lease,code:'BUILD_FAILED',retryable:true}));
  const clock=r.clock+(mode==='expired lease'?6*3600000+1:61*60000);
  r.ctx.db.close();r=await rig({path:db,resume:true,clock});
  lease=r.call('claim',identity())[1];a.equal(snapshots().length,3);a.equal(lease.sourceBlobId,source);a(r.state.row('blobs',source).sealedAt);
  a.throws(()=>r.call('snapshots',identity({...manifest(),leaseEpoch:stale.leaseEpoch})),e=>e.code==='STALE_LEASE');
  let candidate;a.doesNotThrow(()=>{candidate=r.call('snapshots',manifest())[1].snapshotId;},'sealed retry must reserve bounded fourth slot');
  a.equal(snapshots().length,4);for(const id of [...protectedIds,source])a(r.state.row('blobs',id));
  // Even an internal repeated allocation cannot turn the transient fourth slot into a fifth.
  a.throws(()=>r.ctx.storage.transactionSync(()=>r.state.newBlob('snapshot',lease.requestId,manifest(),lease.leaseEpoch)),e=>e.code==='SNAPSHOT_SLOTS');
  const before=JSON.stringify(snapshots());
  a.throws(()=>r.call('seal',identity({...lease,parserVersion:1,coverage:{}}),{blobId:candidate}));a.equal(JSON.stringify(snapshots()),before);
  if(incomplete&&round===0)continue; // Next lease must discard only this incomplete fourth blob.
  r.ctx.storage.transactionSync(()=>r.state.execute('snapshotChunk',{blobId:candidate,ordinal:0,requestId:lease.requestId,leaseEpoch:lease.leaseEpoch},null,r.oidc,{bytes,hash}));
  r.call('seal',identity({...lease,parserVersion:1,coverage:{}}),{blobId:candidate});
  a.equal(snapshots().length,3);a.equal(r.state.row('blobs',source),null);a.equal(r.state.chunkRows(source).length,0);source=candidate;
  for(const id of protectedIds)a(r.state.row('blobs',id)?.sealedAt);
 }
 // The retry ceiling stays three; no fourth processing attempt.
 r.clock+=6*3600000+1;a.equal(r.call('claim',identity())[0],204);
 a.equal(r.state.request(lease.requestId).state,'failed');
});

test('will-recovery-final transient reservation preserves total budget transactionally',async t=>{
 const r=await rig();t.after(()=>r.ctx.db.close());
 const id=await r.upload(),lease=r.call('claim',identity())[1];
 // Reservation is measured from manifests (without allocating 256 MiB of test buffers).
 for(let n=0;n<3;n++)r.state.put('blobs','budget-'+n,{blobId:'budget-'+n,kind:'snapshot',personId:'friend-a',requestId:id,leaseEpoch:lease.leaseEpoch-1,sealedAt:r.clock,bytes:64*1024*1024,chunks:[]});
 const o=r.state.owner();o.activeSnapshotId='budget-0';o.previousSnapshotId='budget-1';r.state.saveOwner(o);
 const req=r.state.request(id);req.sourceBlobId='budget-2';r.state.put('requests',id,req);
 const body=identity({requestId:id,leaseEpoch:lease.leaseEpoch,bytes:64*1024*1024,chunks:[],contentSha256:'a'.repeat(64)});
 const before=JSON.stringify(r.state.all('blobs'));
 a.throws(()=>r.call('snapshots',body),e=>e.code==='STORAGE_LIMIT');a.equal(JSON.stringify(r.state.all('blobs')),before);a.equal(r.state.request(id).snapshotId,null);
 r.state.del('blobs',req.archiveId);a.doesNotThrow(()=>r.call('snapshots',body));a.equal(r.state.all('blobs').reduce((n,b)=>n+b.bytes,0),256*1024*1024);
});
