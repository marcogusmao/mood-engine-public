import test from 'node:test';
import assert from 'node:assert/strict';
import {rig} from './upload-fixtures/sqlite.js';
import {canonical,identity,digest} from '../src/upload/protocol.js';
import {createUploadApi} from '../src/upload/api.js';

test('stored ZIP chunks keep one binary content type and exact bytes through the public API adapter',async t=>{
 const r=await rig();t.after(()=>r.ctx.db.close());
 const bytes=new Uint8Array(262144).map((_,i)=>i%251);
 await r.upload(bytes);const lease=r.call('claim',identity())[1];
 const p={blobId:lease.sourceBlobId,ordinal:0,requestId:lease.requestId,leaseEpoch:lease.leaseEpoch};
 const direct=await r.state.fetch(new Request('https://state/operation',{headers:{'X-Mood-Operation':canonical({name:'blobChunk',p,actor:r.oidc})}}));
 assert.equal(direct.headers.get('Content-Type'),'application/octet-stream');
 assert.equal(direct.headers.get('Content-Length'),String(bytes.length));
 const api=createUploadApi({verifyOidc:async()=>r.oidc});
 const env={WILL_UPLOAD_ENABLED:'true',WILL_BROWSER_ORIGIN:'https://marcogusmao.github.io',WILL_PAGES_BASE:'https://marcogusmao.github.io/mood-engine',WILL_REPOSITORY_ID:'1413569629',WILL_REPOSITORY_OWNER_ID:'50679408',WILL_STATE:{idFromName:()=>0,get:()=>r.state}};
 const res=await api(new Request(`https://worker/api/internal/v1/friend-a/blobs/${lease.sourceBlobId}/chunks/0`,{headers:{Authorization:'Bearer synthetic','X-Request-Id':lease.requestId,'X-Lease-Epoch':String(lease.leaseEpoch)}}),env);
 assert.equal(res.status,200);assert.equal(res.headers.get('Content-Type'),'application/octet-stream');
 assert.equal(res.headers.get('Content-Length'),String(bytes.length));
 assert.equal(res.headers.get('X-Chunk-SHA256'),await digest(bytes));
 assert.deepEqual(new Uint8Array(await res.arrayBuffer()),bytes);
});
