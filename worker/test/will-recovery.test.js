import test from 'node:test';import a from 'node:assert/strict';
import {rig} from './upload-fixtures/sqlite.js';import {identity,digest,canonical} from '../src/upload/protocol.js';
import {verifyTerminalRun,createWillStateClass} from '../src/upload/state.js';
const terminal=p=>({id:Number(p.runId),run_attempt:Number(p.runAttempt),status:'completed',conclusion:'failure',head_sha:p.codeSha,repository:{full_name:'marcogusmao/mood-engine'},path:'.github/workflows/mood-engine.yml'});
function terminalProof(r,p,overrides={}){r.receipts.set(`https://api.github.com/repos/marcogusmao/mood-engine/actions/runs/${p.runId}/attempts/${p.runAttempt}`,JSON.stringify({...terminal(p),...overrides}));}
function abandonment(s){return identity({expectedGeneration:s.prep.generation||1,terminalRunId:'123',terminalRunAttempt:'1',reasonCode:'REPLAY_MISMATCH'});}
test('will-recovery prepared read is scoped to sealed candidate, cannot write or read another owner/revision/blob',async()=>{
 const r=await rig();try{const s=await r.stage(),p={revision:s.lease.revision,blobId:s.snapshot.snapshotId},fresh={...r.oidc,runId:'999',codeSha:'a'.repeat(40)};
 a.equal(r.call('replay',null,{},fresh)[1].publications[0].snapshotId,s.snapshot.snapshotId);
 a.equal(r.call('replayManifest',null,p,fresh)[1].sealed,true);a.deepEqual(new Uint8Array(r.call('replayChunk',null,{...p,ordinal:0},fresh)[1]),s.bytes);
 for(const q of [{...p,revision:'r-'+'f'.repeat(32)},{...p,blobId:crypto.randomUUID()}])a.throws(()=>r.call('replayManifest',null,q,fresh),{code:'REPLAY_FORBIDDEN'});
 a.throws(()=>r.call('replayManifest',null,p,{...fresh,role:'credential'}));
 for(const name of ['heartbeat','snapshots','seal','fail'])a.throws(()=>r.call(name,identity({requestId:s.id,leaseEpoch:s.lease.leaseEpoch}),{},fresh),{code:'STALE_LEASE'});
 a.throws(()=>r.call('blobManifest',null,{blobId:s.snapshot.snapshotId,requestId:s.id,leaseEpoch:s.lease.leaseEpoch},fresh),{code:'STALE_LEASE'});
 a.equal(r.state.owner().activeRevision,null);
 }finally{r.ctx.db.close();}
});
test('will-recovery idle authenticated retained descriptors include active and predecessor without a lease',async()=>{
 const r=await rig();try{for(let n=0;n<2;n++){const s=await r.stage();await r.state.acknowledge('ack',s.lease.revision,identity({receiptSha256:s.prep.receiptSha256}),{...r.oidc,role:'deploy'});}
 const o=r.state.owner();o.lastRefreshDay=new Date(r.clock).toISOString().slice(0,10);r.state.saveOwner(o);a.equal(r.call('claim',identity())[0],204);
 a.deepEqual(r.call('retained',null)[1].publications.map(p=>p.revision),[o.activeRevision,o.previousRevision]);a(r.call('retained',null)[1].publications.every(p=>p.receiptSha256&&!p.snapshotId));
 }finally{r.ctx.db.close();}
});
test('will-recovery terminal verification rejects running, wrong attempt, hash, repository and bounded response',async()=>{
 const p={runId:'123',runAttempt:'1',codeSha:'e'.repeat(40)},good=terminal(p);
 for(const change of [{status:'in_progress'},{run_attempt:2},{head_sha:'f'.repeat(40)},{repository:{full_name:'else/repo'}},{path:'.github/workflows/other.yml'}])await a.rejects(()=>verifyTerminalRun({...p,token:'READ_ONLY',fetchImpl:async()=>Response.json({...good,...change})}),{code:'RUN_NOT_TERMINAL'});
 await a.rejects(()=>verifyTerminalRun({...p,token:'READ_ONLY',fetchImpl:async()=>new Response('x'.repeat(65537))}));
 await verifyTerminalRun({...p,token:'READ_ONLY',fetchImpl:async(url,o)=>{a.equal(url,'https://api.github.com/repos/marcogusmao/mood-engine/actions/runs/123/attempts/1');a.equal(o.redirect,'error');return Response.json(good);}});
});
test('will-recovery abandonment verifies endpoint terminal state, preserves active, fences stale ACK and bounds fourth slot through repeats/restart',async()=>{
 const r=await rig();try{
 for(let n=0;n<2;n++){const s=await r.stage();await r.state.acknowledge('ack',s.lease.revision,identity({receiptSha256:s.prep.receiptSha256}),{...r.oidc,role:'deploy'});}
 let s=await r.stage();const active=r.state.owner().activeSnapshotId,previous=r.state.owner().previousSnapshotId;
 for(let round=0;round<3;round++){
  const p=r.state.row('publications',s.lease.revision),body={...abandonment(s),expectedGeneration:p.generation};
  terminalProof(r,p,{status:'in_progress'});await a.rejects(()=>r.state.abandon(s.lease.revision,body,'READ_ONLY'),{code:'RUN_NOT_TERMINAL'});a.equal(r.state.request(s.id).state,'publishing');
  terminalProof(r,p);await a.rejects(()=>r.state.abandon(s.lease.revision,{...body,terminalRunAttempt:'2'},'READ_ONLY'),{code:'STALE_PUBLICATION'});
  await r.state.abandon(s.lease.revision,body,'READ_ONLY');
  await a.rejects(()=>r.state.acknowledge('reconcile',s.lease.revision,identity({receiptSha256:s.prep.receiptSha256}),{...r.oidc,role:'deploy'}),{code:'PUBLICATION_MISMATCH'});
  const source=s.snapshot.snapshotId,lease=r.call('claim',identity())[1];a.equal(lease.sourceBlobId,source);a.notEqual(lease.revision,s.lease.revision);
  const bytes=new Uint8Array([40+round]),hash=await digest(bytes),manifest=identity({requestId:s.id,leaseEpoch:lease.leaseEpoch,bytes:1,chunks:[{ordinal:0,bytes:1,sha256:hash}],contentSha256:hash});
  let allocated;a.doesNotThrow(()=>{allocated=r.call('snapshots',manifest,{requestId:s.id})[1];});a.equal(r.state.all('blobs').filter(b=>b.kind==='snapshot').length,4);a(r.state.row('blobs',source)?.sealedAt);
  a.throws(()=>r.ctx.storage.transactionSync(()=>r.state.newBlob('snapshot',s.id,{bytes:1,chunks:[],contentSha256:hash},lease.leaseEpoch)),{code:'SNAPSHOT_SLOTS'});
  // Restart the class over the same durable SQL before sealing the replacement.
  const Class=createWillStateClass({now:()=>r.clock,fetchImpl:async u=>r.receipts.has(u)?new Response(r.receipts.get(u)):new Response('',{status:404})});r.state=new Class(r.ctx,{WILL_PAGES_BASE:'https://marcogusmao.github.io/mood-engine'});
  r.ctx.storage.transactionSync(()=>r.state.execute('snapshotChunk',{blobId:allocated.snapshotId,ordinal:0,requestId:s.id,leaseEpoch:lease.leaseEpoch},null,r.oidc,{bytes,hash}));
  r.call('seal',identity({requestId:s.id,leaseEpoch:lease.leaseEpoch,parserVersion:1,coverage:{}}),{blobId:allocated.snapshotId});
  a.equal(r.state.row('blobs',source),null);a.equal(r.state.all('blobs').filter(b=>b.kind==='snapshot').length,3);a(r.state.row('blobs',active));a(r.state.row('blobs',previous));
  // Prepare the new snapshot using the prior synthetic public receipt for this transition test.
  const prep={...s.prep,leaseEpoch:lease.leaseEpoch,revision:lease.revision,snapshotId:allocated.snapshotId};r.call('prepare',prep,{requestId:s.id});s={...s,lease,snapshot:allocated,prep};
 }
 a.equal(r.state.owner().activeSnapshotId,active);a.equal(r.state.owner().previousSnapshotId,previous);
 }finally{r.ctx.db.close();}
});
test('will-recovery fourth slot still reserves total bytes atomically; ordinary snapshots stay at three',async()=>{
 const r=await rig();try{const s=await r.stage();for(let n=0;n<2;n++)r.state.put('blobs',crypto.randomUUID(),{kind:'snapshot',bytes:1,sealedAt:r.clock});
 a.throws(()=>r.ctx.storage.transactionSync(()=>r.state.newBlob('snapshot',s.id,{bytes:1})),{code:'SNAPSHOT_SLOTS'});
 const before=canonical(r.state.all('blobs'));a.throws(()=>r.ctx.storage.transactionSync(()=>r.state.newBlob('snapshot',s.id,{bytes:268435456})),{code:'STORAGE_LIMIT'});a.equal(canonical(r.state.all('blobs')),before);
 }finally{r.ctx.db.close();}
});
test('will-recovery HTTP routes keep exact build authority and replay offers GET only',async()=>{
 const {createUploadApi}=await import('../src/upload/api.js'),{ApiError}=await import('../src/upload/protocol.js');const r=await rig();
 try{const s=await r.stage(),env={WILL_UPLOAD_ENABLED:'true',WILL_BROWSER_ORIGIN:'https://marcogusmao.github.io',WILL_PAGES_BASE:'https://marcogusmao.github.io/mood-engine',WILL_REPOSITORY_ID:'1413569629',WILL_REPOSITORY_OWNER_ID:'50679408',WILL_STATE:{idFromName:()=>'',get:()=>r.state}};
 const api=createUploadApi({verifyOidc:async(token,role)=>{if(token!=='valid-'+role)throw new ApiError(401,'OIDC_REJECTED');return {...r.oidc,role,runId:'999'};}}),get=(suffix,token='valid-build',method='GET')=>api(new Request('https://fixture.test/api/internal/v1/friend-a'+suffix,{method,headers:{Authorization:'Bearer '+token}}),env);
 for(const suffix of ['/retained','/replay',`/replay/${s.lease.revision}/blobs/${s.snapshot.snapshotId}/manifest`,`/replay/${s.lease.revision}/blobs/${s.snapshot.snapshotId}/chunks/0`]){a.equal((await get(suffix)).status,200);a.equal((await get(suffix,'valid-admin')).status,401);a.equal((await get(suffix,'valid-deploy')).status,401);a.equal((await get(suffix,'valid-build','PUT')).status,405);}
 a.equal((await get(`/replay/${s.lease.revision}/blobs/${crypto.randomUUID()}/manifest`)).status,403);
 const url=`https://fixture.test/api/internal/v1/friend-a/publications/${s.lease.revision}/abandon`;
 const response=await api(new Request(url,{method:'POST',headers:{Authorization:'Bearer valid-admin','Content-Type':'application/json'},body:JSON.stringify(abandonment(s))}),env);a.equal(response.status,403);a.equal(r.state.request(s.id).state,'publishing');
 }finally{r.ctx.db.close();}
});
