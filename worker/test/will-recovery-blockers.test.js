import test from 'node:test';import a from 'node:assert/strict';import {createRequire} from 'node:module';
import {rig} from './upload-fixtures/sqlite.js';import {identity,digest} from '../src/upload/protocol.js';import {createUploadApi} from '../src/upload/api.js';
const require=createRequire(import.meta.url),C=require('../../scripts/will-private-client'),F=require('../../test-support/people/fixture'),fs=require('node:fs');
test('intake kind remains letterboxd-export in request but archive in durable storage and backend client; cleanup deletes bytes',async t=>{
 const f=F.fixture(t),r=await rig();try{
 const bytes=fs.readFileSync(F.zip(f.root)),id=await r.upload(bytes),lease=r.call('claim',identity())[1];
 a.equal(JSON.parse(r.state.request(id).intake).kind,'letterboxd-export');
 const env={WILL_UPLOAD_ENABLED:'true',WILL_BROWSER_ORIGIN:'https://marcogusmao.github.io',WILL_PAGES_BASE:'https://marcogusmao.github.io/mood-engine',WILL_REPOSITORY_ID:'1413569629',WILL_REPOSITORY_OWNER_ID:'50679408',WILL_STATE:{idFromName:()=>'',get:()=>r.state}};
 const api=createUploadApi({verifyOidc:async(token,role)=>{a.equal(token,'synthetic-build');a.equal(role,'build');return r.oidc;}});
 const client=C.createClient({origin:'https://mood-engine.mood-engine-worker.workers.dev',role:'build',token:async()=>'synthetic-build',fetchImpl:(url,opts)=>api(new Request(url,opts),env)});
 let read;await a.doesNotReject(async()=>{read=await client.readBlob(lease.sourceBlobId,lease);});a.equal(read.manifest.kind,'archive');a.deepEqual(read.bytes,bytes);
 const stored=r.state.row('blobs',lease.sourceBlobId);a.equal(stored.kind,'archive');a.equal(stored.schemaVersion,undefined);
 r.call('fail',identity({requestId:id,leaseEpoch:lease.leaseEpoch,code:'BUILD_FAILED',retryable:false}));r.ctx.storage.transactionSync(()=>r.state.cleanup());
 a.equal(r.state.row('blobs',lease.sourceBlobId),null);a.equal(r.state.chunkRows(lease.sourceBlobId).length,0);
 const expired=await r.upload(bytes),archive=r.state.request(expired).archiveId;r.clock+=8*86400000;r.ctx.storage.transactionSync(()=>r.state.cleanup());a.equal(r.state.request(expired).error.code,'ARCHIVE_EXPIRED');a.equal(r.state.row('blobs',archive),null);a.equal(r.state.chunkRows(archive).length,0);
 }finally{r.ctx.db.close();}
});
test('storage identity and lifecycle fields cannot be supplied by a manifest; chunk metadata is projected',async()=>{
 const r=await rig();try{const hash=await digest(new Uint8Array([1]));const id=r.ctx.storage.transactionSync(()=>r.state.newBlob('archive','server-request',{bytes:1,chunks:[{ordinal:0,bytes:1,sha256:hash,extra:'ignored'}],archiveSha256:hash,contentSha256:'ignored',kind:'letterboxd-export',blobId:'forged',personId:'marco',requestId:'forged',leaseEpoch:77,createdAt:1,sealedAt:2,extra:'ignored'}));const b=r.state.row('blobs',id);
 a.equal(b.blobId,id);a.equal(b.personId,'friend-a');a.equal(b.requestId,'server-request');a.equal(b.kind,'archive');a.equal(b.leaseEpoch,null);a.equal(b.createdAt,r.clock);a.equal(b.sealedAt,null);a.equal(b.extra,undefined);a.equal(b.contentSha256,undefined);a.equal(b.chunks[0].extra,undefined);
 }finally{r.ctx.db.close();}
});
