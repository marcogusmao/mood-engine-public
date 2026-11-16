#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),I=require('../lib/person-input');
const ID={schemaVersion:1,personId:'friend-a'},AUD={build:'urn:mood-engine:friend-a:build:v1',deploy:'urn:mood-engine:friend-a:deploy:v1',admin:'urn:mood-engine:friend-a:admin:v1'};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function id(s){if(!UUID.test(s))throw Error('Invalid private resource ID');return s;}
async function bounded(response,cap){const chunks=[];let size=0;if(response.body){for await(const chunk of response.body){size+=chunk.length;if(size>cap)throw Error('RESPONSE_TOO_LARGE');chunks.push(chunk);}}return Buffer.concat(chunks);}
async function actionsToken(role,{fetchImpl=fetch,env=process.env}={}){
 if(!AUD[role])throw Error('Invalid OIDC role');const url=new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL||'https://invalid.invalid');if(url.protocol!=='https:'||!url.hostname.endsWith('.actions.githubusercontent.com'))throw Error('GitHub OIDC unavailable');url.searchParams.set('audience',AUD[role]);
 const response=await fetchImpl(url,{headers:{Authorization:'Bearer '+env.ACTIONS_ID_TOKEN_REQUEST_TOKEN},redirect:'error',signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error('OIDC_UNAVAILABLE');const doc=JSON.parse(await bounded(response,16384));if(typeof doc.value!=='string'||doc.value.length>16384)throw Error('OIDC_UNAVAILABLE');return doc.value;
}
function createClient({origin,role,token=()=>actionsToken(role),fetchImpl=fetch,retryDelay=ms=>new Promise(r=>setTimeout(r,ms))}){
 const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin||origin!=='https://mood-engine.mood-engine-worker.workers.dev'||!AUD[role])throw Error('Fixed HTTPS Worker origin and role required');
 const permits=(method,suffix)=>role==='build'?method==='GET'?/^(?:\/(?:retained|replay)|\/blobs\/[^/]+\/(?:manifest|chunks\/\d+)|\/replay\/r-[a-f0-9]{32}\/blobs\/[^/]+\/(?:manifest|chunks\/\d+))$/.test(suffix):/^\/(?:claim|requests\/[^/]+\/(?:heartbeat|snapshots|prepare|fail)|snapshots\/[^/]+\/(?:seal|chunks\/\d+))$/.test(suffix):role==='deploy'?method==='GET'?suffix==='/prepared':/^\/publications\/r-[a-f0-9]{32}\/(?:ack|reconcile)$/.test(suffix):/^\/(?:invitations|revoke|publications\/r-[a-f0-9]{32}\/abandon)$/.test(suffix);
 async function request(method,suffix,{body,bytes,lease,githubToken,cap=65536,raw=false}={}){
  if(body&&((body.personId!==undefined&&body.personId!=='friend-a')||(body.schemaVersion!==undefined&&body.schemaVersion!==1)))throw Error('PRIVATE_REQUEST_OWNER_MISMATCH');
  if(!permits(method,suffix))throw Error('OIDC_ROLE_OPERATION_MISMATCH');
  for(let attempt=0;attempt<3;attempt++){
   const headers={Authorization:'Bearer '+await token()};if(githubToken){if(role!=='admin'||!suffix.endsWith('/abandon'))throw Error('GITHUB_TOKEN_SCOPE');headers['X-GitHub-Read-Token']=githubToken;}if(lease){headers['X-Request-Id']=id(lease.requestId);headers['X-Lease-Epoch']=String(lease.leaseEpoch);}
   if(bytes){headers['Content-Type']='application/octet-stream';headers['X-Chunk-SHA256']=I.sha(bytes);}else if(body)headers['Content-Type']='application/json';
   let response;try{response=await fetchImpl(origin+'/api/internal/v1/friend-a'+suffix,{method,headers,body:bytes||(body?I.canonical({...ID,...body}):undefined),redirect:'error',signal:AbortSignal.timeout(20000)});}catch{if(attempt===2)throw Error('PRIVATE_SERVICE_UNAVAILABLE');await retryDelay(250*(attempt+1));continue;}
   if([429,500,502,503,504].includes(response.status)&&attempt<2){await bounded(response,16384);await retryDelay(Math.min(2000,Number(response.headers.get('Retry-After')||0)*1000||250*(attempt+1)));continue;}
   if(!response.ok){await bounded(response,16384);throw Error('PRIVATE_REQUEST_FAILED_'+response.status);}
   if(response.status===204)return null;const data=await bounded(response,cap);
   if(raw)return {bytes:data,sha256:response.headers.get('X-Chunk-SHA256'),length:response.headers.get('Content-Length')};
   let value;try{value=JSON.parse(data);}catch{throw Error('PRIVATE_RESPONSE_INVALID');}if(value.schemaVersion!==1||value.personId!=='friend-a')throw Error('PRIVATE_RESPONSE_OWNER_MISMATCH');return value;
  }
 }
 async function readBlob(blobId,lease,replayRevision){id(blobId);if(replayRevision&&!/^r-[a-f0-9]{32}$/.test(replayRevision))throw Error('Invalid replay revision');const prefix=replayRevision?`/replay/${replayRevision}/blobs/${blobId}`:`/blobs/${blobId}`;const m=await request('GET',`${prefix}/manifest`,{lease});
  const max=m.kind==='archive'?8*1024*1024:64*1024*1024;if(m.blobId!==blobId||!['archive','snapshot'].includes(m.kind)||!Number.isInteger(m.bytes)||m.bytes<1||m.bytes>max||!Array.isArray(m.chunks)||m.chunks.length!==Math.ceil(m.bytes/262144))throw Error('INVALID_SOURCE_MANIFEST');
  const parts=[];let size=0;for(let n=0;n<m.chunks.length;n++){const c=m.chunks[n];if(c.ordinal!==n||c.bytes!==Math.min(262144,m.bytes-size)||!/^[a-f0-9]{64}$/.test(c.sha256))throw Error('INVALID_SOURCE_MANIFEST');const r=await request('GET',`${prefix}/chunks/${n}`,{lease,raw:true,cap:262144});if(r.bytes.length!==c.bytes||I.sha(r.bytes)!==c.sha256||r.sha256!==c.sha256||Number(r.length)!==c.bytes)throw Error('SOURCE_CHUNK_MISMATCH');parts.push(r.bytes);size+=c.bytes;}
  const bytes=Buffer.concat(parts);if(bytes.length!==m.bytes||I.sha(bytes)!==m.contentSha256)throw Error('SOURCE_HASH_MISMATCH');return {manifest:m,bytes};
 }
 async function persistSnapshot(bytes,lease,coverage){if(bytes.length>64*1024*1024)throw Error('SNAPSHOT_TOO_LARGE');const chunks=[];for(let at=0;at<bytes.length;at+=262144){const b=bytes.subarray(at,at+262144);chunks.push({ordinal:chunks.length,bytes:b.length,sha256:I.sha(b)});}const body={requestId:lease.requestId,leaseEpoch:lease.leaseEpoch,bytes:bytes.length,chunks,contentSha256:I.sha(bytes)};
  const result=await request('POST',`/requests/${id(lease.requestId)}/snapshots`,{body});id(result.snapshotId);
  for(const c of chunks)await request('PUT',`/snapshots/${result.snapshotId}/chunks/${c.ordinal}`,{bytes:bytes.subarray(c.ordinal*262144,c.ordinal*262144+c.bytes),lease});
  const stored=await readBlob(result.snapshotId,lease);if(!stored.bytes.equals(bytes))throw Error('SNAPSHOT_RECEIPT_MISMATCH');
  await request('POST',`/snapshots/${result.snapshotId}/seal`,{body:{requestId:lease.requestId,leaseEpoch:lease.leaseEpoch,parserVersion:1,coverage}});return result.snapshotId;
 }
 return {request,readBlob,persistSnapshot,claim:()=>request('POST','/claim',{body:ID}),heartbeat:l=>request('POST',`/requests/${id(l.requestId)}/heartbeat`,{body:{requestId:l.requestId,leaseEpoch:l.leaseEpoch}})};
}
module.exports={ID,AUD,actionsToken,bounded,createClient};
