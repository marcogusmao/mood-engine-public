import {DatabaseSync} from 'node:sqlite';
import {ReleaseCoordinator} from '../../src/upload/release-coordinator.js';
import {createWillReleaseClass} from '../../src/upload/release-storage.js';
import * as V from '../../src/upload/storage-contract.js';
export function storage(path=':memory:'){
 const db=new DatabaseSync(path);let nested=false;
 return {db,sql:{exec(sql,...args){const rows=db.prepare(sql).all(...args.map(v=>v instanceof ArrayBuffer?new Uint8Array(v):v));return {toArray:()=>rows};}},transactionSync(fn){if(nested)return fn();db.exec('BEGIN IMMEDIATE');nested=true;try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}finally{nested=false;}}};
}
export async function rig({Slot=createWillReleaseClass(),Coordinator=ReleaseCoordinator,pause=async()=>{}}={}){
 const stores=Array.from({length:5},()=>storage()),slots=stores.slice(0,4).map(storage=>new Slot({storage}));let loss=false;
 const namespace={idFromName:n=>Number(n.at(-1)),get:id=>({fetch:async req=>{const res=await slots[id].fetch(req);if(loss){loss=false;throw Error('INJECTED_RESPONSE_LOSS');}return res;}})};
 const c=new Coordinator({storage:stores[4],namespace,pause});
 const r={c,slots,stores,drop:()=>{loss=true;},close:()=>stores.forEach(s=>s.db.close())};return r;
}
export const actor=(n=1)=>({role:'build',requestId:`request-${n}`,generation:1,leaseEpoch:1,runId:String(n),runAttempt:'1',codeSha:'e'.repeat(40)});
export function grant(c,a){const {role,...lease}=a;return c.grant({...lease,expiresAt:Date.now()+3600000});}
export const descriptor=pack=>Object.fromEntries(['packBytes','fileCount','chunkCount','filesRoot','chunksRoot'].map(k=>[k,pack[k]]).concat([['builtAt','2026-10-19T12:00:00.000Z'],['receiptSha256',pack.files?.find(f=>f.path==='publication.json')?.sha256||'a'.repeat(64)],['fileManifestSha256',pack.files?.find(f=>f.path==='files.json')?.sha256||'b'.repeat(64)],['personContextSha256',pack.files?.find(f=>f.path==='data/person.json')?.sha256||'c'.repeat(64)]]));
export function privateDescriptor(s){return {snapshotId:'snapshot-synthetic',contentSha256:'d'.repeat(64),sealed:true,publicRef:V.publicRef(s.allocation),allocationHash:s.allocation.allocationHash,sealReceiptSha256:s.sealReceipt.sha256};}
export async function upload(c,a,pack,file,overrides={}){const {readRange}=await import('../../../lib/will-public-pack.js').then(m=>m.default);grant(c,a);const s=await c.reserve(a,{...descriptor(pack),...overrides}),ref=V.publicRef(s.allocation);for(const page of pack.pages)await c.write(a,ref,'page',pack.pages.indexOf(page),page);for(const chunk of pack.chunks){const parts=[];for await(const b of readRange(file,chunk.ordinal*262144,chunk.bytes))parts.push(b);await c.write(a,ref,'chunk',chunk.ordinal,Buffer.concat(parts));}return ref;}
export async function seal(c,a,ref){let result;do{result=await c.seal(a,ref);}while(c.get(ref.slot).phase!=='PUBLIC_SEALED');return c.get(ref.slot);}
export function gate(){let entered,release;const reached=new Promise(r=>entered=r),waiting=new Promise(r=>release=r);return {reached,release,pause:async()=>{entered();await waiting;}};}
