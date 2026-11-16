import { DatabaseSync } from 'node:sqlite';
import { createWillStateClass } from '../../src/upload/state.js';
import { canonical, digest, identity } from '../../src/upload/protocol.js';
export function sqliteContext(path=':memory:') {
  const db=new DatabaseSync(path); db.exec('PRAGMA busy_timeout=10000'); let txn=false;
  return {db,storage:{sql:{exec(sql,...args){const stmt=db.prepare(sql);const normalized=args.map(x=>x instanceof ArrayBuffer?new Uint8Array(x):x); const rows=stmt.all(...normalized);return {toArray:()=>rows};}},transactionSync(fn){if(txn)return fn();db.exec('BEGIN IMMEDIATE');txn=true;try{const out=fn();db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}finally{txn=false;}},async setAlarm(){}}};
}
export async function rig({path,resume=false,clock=Date.parse('2026-10-14T12:00:00.000Z')}={}) {
 const ctx=sqliteContext(path),r={clock,ctx,receipts:new Map()};
 const Class=createWillStateClass({now:()=>r.clock,fetchImpl:async u=>r.receipts.has(u)?new Response(r.receipts.get(u)):new Response('missing',{status:404})});
 r.state=new Class(ctx,{WILL_PAGES_BASE:'https://marcogusmao.github.io/mood-engine'});
 r.call=(name,body,p={},actor=r.oidc)=>ctx.storage.transactionSync(()=>r.state.execute(name,p,body,actor));
 r.oidc={role:'build',runId:'123',runAttempt:'1',codeSha:'e'.repeat(40)};
 if(resume)return r;
 r.invite='a'.repeat(43);r.credential='b'.repeat(43);r.inviteId=crypto.randomUUID();
 r.call('invitations',identity({inviteId:r.inviteId,tokenHash:await digest(r.invite),expiresAt:new Date(r.clock+86400000).toISOString(),expectedAuthEpoch:0}),{},{role:'admin'});
 r.sessionActor={role:'invitation',hash:await digest(r.invite),credentialHash:await digest(r.credential)};
 r.call('session',identity({inviteId:r.inviteId,credential:r.credential}),{},r.sessionActor);
 r.auth={role:'credential',hash:await digest(r.credential)};
 r.upload=async(bytes=new Uint8Array([1,2,3]))=>{
   const id=crypto.randomUUID(),hash=await digest(bytes),chunks=[];
   for(let pos=0;pos<bytes.length;pos+=262144){const part=bytes.slice(pos,pos+262144);chunks.push({ordinal:chunks.length,bytes:part.length,sha256:await digest(part)});}
   const body=identity({requestId:id,kind:'letterboxd-export',bytes:bytes.length,archiveSha256:hash,chunks});
   r.call('uploads',body,{},r.auth);
   for(const c of chunks)ctx.storage.transactionSync(()=>r.state.execute('uploadChunk',{requestId:id,ordinal:c.ordinal},null,r.auth,{bytes:bytes.slice(c.ordinal*262144,c.ordinal*262144+c.bytes),hash:c.sha256}));
   r.call('complete',identity(),{requestId:id},r.auth);return id;
 };
 r.stage=async(existing)=>{
   const id=existing?.requestId || await r.upload(),lease=existing || r.call('claim',identity())[1];
   const bytes=new TextEncoder().encode(canonical(identity({synthetic:true}))),hash=await digest(bytes);
   const b=identity({requestId:id,leaseEpoch:lease.leaseEpoch,bytes:bytes.length,chunks:[{ordinal:0,bytes:bytes.length,sha256:hash}],contentSha256:hash});
   const [,snapshot]=r.call('snapshots',b,{requestId:id});
   ctx.storage.transactionSync(()=>r.state.execute('snapshotChunk',{blobId:snapshot.snapshotId,ordinal:0,requestId:id,leaseEpoch:lease.leaseEpoch},null,r.oidc,{bytes,hash}));
   r.call('seal',identity({requestId:id,leaseEpoch:lease.leaseEpoch,parserVersion:1,coverage:Object.fromEntries(['watched','ratings','watchlist','likes','diary','following'].map(k=>[k,'unknown']))}),{blobId:snapshot.snapshotId});
   const context=canonical(identity({revision:lease.revision})),contextHash=await digest(context);
   const receipt=canonical(identity({revision:lease.revision,codeSha:r.oidc.codeSha,builtAt:new Date(r.clock).toISOString(),filesSha256:'f'.repeat(64),personContextSha256:contextHash}));
   const prep=identity({requestId:id,leaseEpoch:lease.leaseEpoch,snapshotId:snapshot.snapshotId,revision:lease.revision,codeSha:r.oidc.codeSha,receiptSha256:await digest(receipt),fileManifestSha256:'f'.repeat(64),personContextSha256:contextHash});
   r.call('prepare',prep,{requestId:id});
   const base=`https://marcogusmao.github.io/mood-engine/u/friend-a/r/${lease.revision}/`;
   r.receipts.set(base+'publication.json',receipt);r.receipts.set(base+'data/person.json',context);
   return {id,lease,snapshot,prep,bytes};
 };
 return r;
}
