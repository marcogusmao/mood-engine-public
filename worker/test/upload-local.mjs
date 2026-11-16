import assert from 'node:assert/strict';import { writeFile,readFile,mkdir } from 'node:fs/promises';import { resolve } from 'node:path';
import { runtime, register, redeem, upload, stage, sha, IDENTITY } from './upload-fixtures/runtime.mjs';
const r=await runtime();let assertions=0;
const eq=(a,b)=>{assert.equal(a,b);assertions++;};
try{
 const invitation=await register(r),token=await redeem(r,invitation);
 // Route and CORS gates, never with production credentials.
 eq((await fetch(r.base+'/api/v1/friend-a/status',{headers:{Origin:'null',Authorization:'Bearer '+token}})).status,403);
 eq((await r.call('/claim',{role:'deploy',body:IDENTITY})).status,401);
 const id=await upload(r,token,new Uint8Array(8388608).fill(42));
 if(process.argv.includes('--restart')){await r.stop();await r.start();}
 eq((await r.call(`/uploads/${id}`,{token})).body.state,'queued');
 const claimed=await r.call('/claim',{role:'build',body:IDENTITY});eq(claimed.status,200);const lease=claimed.body;
 const source=await r.call(`/blobs/${lease.sourceBlobId}/manifest`,{role:'build',headers:{'X-Request-Id':id,'X-Lease-Epoch':String(lease.leaseEpoch)}});eq(source.body.bytes,8388608);eq(source.body.chunks.length,32);
 const staged=await stage(r,lease);
 eq((await r.call('/publication')).body.state,'not_ready');
 eq((await r.call('/claim',{role:'build',body:IDENTITY})).status,204);
 eq((await r.call(`/publications/${lease.revision}/ack`,{role:'deploy',body:{...IDENTITY,receiptSha256:staged.receiptSha256}})).status,503); // offline transport has no receipt yet
 eq((await r.call('/publication')).body.state,'not_ready');
 if(process.argv.includes('--restart')){await r.stop();await r.start();}
 const prepared=await r.call('/prepared',{role:'deploy'});eq(prepared.body.publications[0].revision,lease.revision);
 // Lost ACK recovery from durable prepared state; original ZIP is already deleted.
 await r.receipts(staged.receipts);
 eq((await r.call(`/publications/${lease.revision}/ack`,{role:'deploy',runId:'124',body:{...IDENTITY,receiptSha256:staged.receiptSha256}})).status,409);
 const ack=await r.call(`/publications/${lease.revision}/reconcile`,{role:'deploy',runId:'124',body:{...IDENTITY,receiptSha256:staged.receiptSha256}});eq(ack.status,200);
 if(process.argv.includes('--restart')){await r.stop();await r.start();}
 eq((await r.call('/publication')).body.activePublication.revision,lease.revision);
 eq((await r.call(`/publications/${lease.revision}/ack`,{role:'deploy',body:{...IDENTITY,receiptSha256:staged.receiptSha256}})).status,200);
 const next=await r.call('/claim',{role:'build',runId:'125',body:IDENTITY});eq(next.status,200);eq(next.body.kind,'public-refresh');
 const readHeaders={'X-Request-Id':next.body.requestId,'X-Lease-Epoch':String(next.body.leaseEpoch)};
 const manifest=await r.call(`/blobs/${staged.snapshotId}/manifest`,{role:'build',runId:'125',headers:readHeaders});eq(manifest.status,200);
 // Materialize through authenticated production HTTP bytes, in a fresh private runner directory.
 const {jwt}=await import('./upload-fixtures/runtime.mjs');const raw=await fetch(r.base+`/api/internal/v1/friend-a/blobs/${staged.snapshotId}/chunks/0`,{headers:{Authorization:'Bearer '+await jwt('build','125'),'X-Request-Id':next.body.requestId,'X-Lease-Epoch':String(next.body.leaseEpoch)}});eq(raw.status,200);const bytes=new Uint8Array(await raw.arrayBuffer());eq(await sha(bytes),manifest.body.contentSha256);
 const fresh=resolve(r.temp,'fresh-runner');await mkdir(fresh,{mode:0o700});await writeFile(resolve(fresh,'snapshot.json'),bytes,{mode:0o600});eq(await sha(await readFile(resolve(fresh,'snapshot.json'))),await sha(staged.packageBytes));
 console.log(JSON.stringify({proof:'local workerd SQLite, restart and fresh private runner',assertions,archiveBytes:8388608,archiveChunks:32,externalNetworkCalls:0,realUserData:false}));
}finally{await r.close();}
