import assert from 'node:assert/strict';
import {rig,actor,grant,descriptor,privateDescriptor,seal,gate} from './storage-rig.js';
import {ReleaseCoordinator} from '../../src/upload/release-coordinator.js';
import * as V from '../../src/upload/storage-contract.js';
import P from '../../../lib/will-public-pack.js';
import {createWillReleaseClass} from '../../src/upload/release-storage.js';

export async function pack(){
 const sources=Array.from({length:70},(_,i)=>({path:['data/person.json','files.json','publication.json'][i]||`posters/tt${String(i).padStart(5,'0')}.jpg`,data:Buffer.alloc(i===3?300000:3,i)})).sort((a,b)=>V.comparePath(a.path,b.path));
 let offset=0;const files=sources.map(f=>{const r={path:f.path,offset,bytes:f.data.length,sha256:P.sha(f.data)};offset+=f.data.length;return r;});
 const bytes=Buffer.concat(sources.map(f=>f.data)),chunks=[],pages=[];
 for(let i=0;i<bytes.length;i+=262144)chunks.push({ordinal:chunks.length,bytes:Math.min(262144,bytes.length-i),sha256:P.sha(bytes.subarray(i,i+262144))});
 for(let i=0;i<files.length;i+=64)pages.push(files.slice(i,i+64));
 return {bytes,files,chunks,pages,packBytes:bytes.length,fileCount:files.length,chunkCount:chunks.length,filesRoot:await P.root('files',files),chunksRoot:await P.root('chunks',chunks)};
}
async function load(r,p,a=actor(),empty=false){grant(r.c,a);const s=await r.c.reserve(a,descriptor(p)),ref=V.publicRef(s.allocation);if(!empty)await fill(r,p,a,ref);return ref;}
async function fill(r,p,a,ref){for(let i=0;i<p.pages.length;i++)await r.c.write(a,ref,'page',i,p.pages[i]);for(const c of p.chunks)await r.c.write(a,ref,'chunk',c.ordinal,p.bytes.subarray(c.ordinal*262144,c.ordinal*262144+c.bytes));}
function restart(r){for(let i=0;i<4;i++)r.slots[i]=new r.slots[i].constructor({storage:r.stores[i]});r.c=new r.c.constructor({storage:r.stores[4],namespace:r.c.namespace});}
function next(a){const {role,...l}=a;return {...l,leaseEpoch:2,expiresAt:Date.now()+3600000};}
async function scope(fn,options){const r=await rig(options);try{await fn(r,await pack(),actor());}finally{r.close();}}


export const recoveryNames=["final seal response lost, freeze loss and restart preserve receipt and source", "partial seal freezes, restarts and incomplete pack becomes collectible", "expired lease internal revocation preserves sealed sources and releases incomplete", "new lease reads retained files/chunks/pages/manifest but cannot write them; freeze preserves public read", "incomplete seal through coordinator leaves uploads open", "production GET HEAD chunk status and streams perform zero SQL mutations", "aggregate metadata bound refuses growth and terminal leases are collected safely"];
recoveryNames.push("same-generation retry completes replacement and GC across restarts", "retired replacement Pair never releases the last source");
recoveryNames.push("unprotected sealed successor cannot release source", "persisted Pair must correspond to the protected successor");
recoveryNames.push("overlapping reservations share one allocation and reject conflicting descriptor");
recoveryNames.push("review3: same allocation during released source retire and GC", "review3: freeze overlaps init before commit and recovers loss/restart");
const cases={
 1: async(r,p,a)=>{
 const ref=await load(r,p,a);await r.c.seal(a,ref);await r.c.seal(a,ref);r.drop();await assert.rejects(r.c.seal(a,ref),/INJECTED_RESPONSE_LOSS/);
 const receipt=r.slots[0].state().sealReceipt;assert.ok(receipt);r.drop();await assert.rejects(r.c.freeze(a,ref),/INJECTED_RESPONSE_LOSS/);
 restart(r);await r.c.drive(0);r.c.handoff(ref,next(a));assert.deepEqual(r.c.get(0).sealReceipt,receipt);assert.equal(r.c.get(0).source,true);await assert.rejects(r.c.retire(ref),/PROTECTED/);
},
 2: async(r,p,a)=>{
 const ref=await load(r,p,a);await r.c.seal(a,ref);assert.equal(r.slots[0].state().phase,'SEALING');await r.c.freeze(a,ref);restart(r);r.c.handoff(ref,next(a));assert.equal(r.c.get(0).source,false);await r.c.retire(ref);while(!(await r.c.gc(ref)).done){}assert.equal(r.c.get(0).phase,'FREE');
},
 3: async(r,p,a)=>{
 const ref=await load(r,p,a),b=actor(2),sealed=await load(r,p,b);await seal(r.c,b,sealed);r.c.now=()=>Date.now()+7200000;
 await assert.rejects(r.c.freeze(a,ref),/LEASE_FENCED/);await assert.rejects(r.c.write(a,ref,'page',0,p.pages[0]),/LEASE_FENCED/);
 await r.c.revokeExpired(ref);await r.c.retire(ref);while(!(await r.c.gc(ref)).done){}await r.c.revokeExpired(sealed);assert.equal(r.c.get(sealed.slot).source,true);await assert.rejects(r.c.retire(sealed),/PROTECTED/);
},
 4: async(r,p,a)=>{
 const ref=await load(r,p,a);await seal(r.c,a,ref);await r.c.commitPair(a,ref,privateDescriptor(r.c.get(0)));await r.c.prepare(a,ref);await r.c.promote({role:'deploy'},ref);const b=actor(2);grant(r.c,b);
 assert.equal((await r.c.read(ref,'files.json',true,b)).status,200);assert.equal(P.sha(new Uint8Array(await (await r.c.chunk(b,ref,0)).arrayBuffer())),p.chunks[0].sha256);
 assert.deepEqual(await r.c.page(b,ref,0),p.pages[0]);assert.equal((await r.c.manifest(b,ref)).allocation.allocationHash,r.c.get(0).allocation.allocationHash);
 await assert.rejects(r.c.write(b,ref,'page',0,p.pages[0]),/LEASE_FENCED/);await assert.rejects(r.c.chunk({...b,role:'browser'},ref,0),/ROLE_REQUIRED/);
 r.drop();await assert.rejects(r.c.freeze(a,ref),/INJECTED_RESPONSE_LOSS/);assert.equal((await r.c.read(ref,'files.json',true)).status,200);await r.c.drive(ref.slot);assert.equal((await r.c.read(ref,'files.json',true)).status,200);
 // Previous, prepared and retry-only source are independently readable by B.
 const c=actor(3),active=await load(r,p,c);await seal(r.c,c,active);await r.c.commitPair(c,active,privateDescriptor(r.c.get(active.slot)));await r.c.prepare(c,active);await r.c.promote({role:'deploy'},active);
 const d=actor(4),prepared=await load(r,p,d);await seal(r.c,d,prepared);await r.c.commitPair(d,prepared,privateDescriptor(r.c.get(prepared.slot)));await r.c.prepare(d,prepared);
 const e=actor(5),source=await load(r,p,e);await seal(r.c,e,source);await r.c.freeze(e,source);r.c.handoff(source,next(e));
 for(const retained of [ref,active,prepared,source]){assert.equal((await r.c.read(retained,'files.json',true,b)).status,200);assert.deepEqual(await r.c.page(b,retained,0),p.pages[0]);assert.equal((await r.c.manifest(b,retained)).allocation.revision,retained.revision);await (await r.c.chunk(b,retained,0)).arrayBuffer();await assert.rejects(r.c.chunk(b,{...retained,slotEpoch:retained.slotEpoch+1},0),/STALE_EPOCH/);}
 await assert.rejects(r.c.read(source,'files.json',true),/NOT_PUBLIC/);
 await assert.rejects(r.c.read(source,'files.json',true,{...b,leaseEpoch:2}),/LEASE_FENCED/);
 await assert.rejects(r.c.manifest(b,{...source,extra:true}),/INVALID_DTO/);
},
 5: async(r,p,a)=>{
 const ref=await load(r,p,a,true);await assert.rejects(r.c.seal(a,ref),/INCOMPLETE_PACK/);assert.equal(r.c.get(0).phase,'WRITING');await fill(r,p,a,ref);await seal(r.c,a,ref);assert.ok(r.c.get(0).sealReceipt);
},
 6: async(r,p,a)=>{
 const ref=await load(r,p,a);await seal(r.c,a,ref);await r.c.commitPair(a,ref,privateDescriptor(r.c.get(0)));await r.c.prepare(a,ref);const writes=[];
 for(const store of r.stores){const exec=store.sql.exec;store.sql.exec=(sql,...args)=>{if(/^\s*(UPDATE|INSERT|DELETE|CREATE|ALTER)/i.test(sql))writes.push(sql);return exec(sql,...args);};}
 await (await r.c.read(ref,'posters/tt00003.jpg')).arrayBuffer();await r.c.read(ref,'files.json',true);await (await r.c.chunk(a,ref,0)).arrayBuffer();await r.c.status(ref);await r.c.page(a,ref,0);await r.c.manifest(a,ref);await r.c.metrics();assert.deepEqual(writes,[]);
},
 7: async(r,p,a)=>{
 const ref=await load(r,p,a);let refused=false;
 for(let i=2;i<46002;i++){try{grant(r.c,actor(i));}catch(e){assert.match(e.message,/METADATA_BOUNDS/);refused=true;break;}}
 assert.equal(refused,true);const size=()=>r.c.q('SELECT SUM(length(CAST(value AS BLOB))+length(CAST(requestId AS BLOB))) AS n FROM release_leases')[0].n;
 const before=size(),physical=r.stores[4].db.prepare('PRAGMA page_count').get().page_count;for(let i=0;i<20;i++)assert.throws(()=>grant(r.c,actor(90000+i)),/METADATA_BOUNDS/);assert.equal(size(),before);assert.equal(r.stores[4].db.prepare('PRAGMA page_count').get().page_count,physical);assert.ok(before+5*65536+4096<=V.LIMITS.metadataBytes);
 r.c.now=()=>Date.now()+7200000;let cursor=null;do{const result=r.c.collectLeases(cursor);cursor=result.next;}while(cursor);assert.equal(r.c.lease(a.requestId).requestId,a.requestId);assert.equal(r.c.q('SELECT COUNT(*) AS n FROM release_leases')[0].n,1);assert.ok(r.c.get(ref.slot).pending);
},
 8: async(r,p,a)=>{
 const source=await load(r,p,a);await seal(r.c,a,source);await r.c.freeze(a,source);
 const lease=next(a),b={role:'build',...lease};r.c.handoff(source,lease);restart(r);
 await assert.rejects(r.c.reserve(a,descriptor(p)),/LEASE_FENCED/);
 // Lost init response leaves a durable reservation; retransmission must reuse it.
 r.drop();await assert.rejects(r.c.reserve(b,descriptor(p)),/INJECTED_RESPONSE_LOSS/);
 const pending=r.c.slots().find(s=>s.allocation?.leaseEpoch===2);assert.equal(pending.journal.action,'init');
 restart(r);const t=await r.c.reserve(b,descriptor(p)),ref=V.publicRef(t.allocation);
 assert.equal(ref.slot,pending.slot);assert.equal(ref.slotEpoch,pending.slotEpoch);
 const again=await r.c.reserve(b,descriptor(p));assert.deepEqual(again.allocation,t.allocation);
 await assert.rejects(r.c.reserve(b,{...descriptor(p),builtAt:'2026-10-19T13:00:00.000Z'}),/ALLOCATION_EXISTS/);
 assert.equal(r.c.slots().filter(s=>s.phase!=='FREE').length,2);assert.equal(r.c.get(source.slot).source,true);
 await fill(r,p,b,ref);await fill(r,p,b,ref);
 for(const c of p.chunks)assert.equal(P.sha(new Uint8Array(await(await r.c.chunk(b,ref,c.ordinal)).arrayBuffer())),c.sha256);
 await seal(r.c,b,ref);await r.c.commitPair(b,ref,privateDescriptor(r.c.get(ref.slot)));await r.c.prepare(b,ref);
 for(const n of [3,4])await load(r,p,actor(n),true);
 const fifth=actor(5);grant(r.c,fifth);await assert.rejects(r.c.reserve(fifth,descriptor(p)),/NO_FREE_SLOT/);
 r.c.releaseSource(source,ref);r.drop();await assert.rejects(r.c.retire(source),/INJECTED_RESPONSE_LOSS/);restart(r);await r.c.drive(source.slot);
 r.drop();await assert.rejects(r.c.gc(source),/INJECTED_RESPONSE_LOSS/);restart(r);while(!(await r.c.gc(source)).done){}
 restart(r);assert.equal(r.c.get(source.slot).phase,'FREE');assert.equal(r.c.protected(r.c.get(ref.slot)),true);
 for(const c of p.chunks)assert.equal(P.sha(new Uint8Array(await(await r.c.chunk(b,ref,c.ordinal)).arrayBuffer())),c.sha256);
 await assert.rejects(r.c.status(source),/STALE_EPOCH/);await assert.rejects(r.c.retire(ref),/PROTECTED/);
 },
 9: async(r,p,a)=>{
 const source=await load(r,p,a);await seal(r.c,a,source);await r.c.freeze(a,source);
 // Higher generation also exercises the old release guard independently of reserve.
 const lease={...next(a),generation:2},b={role:'build',...lease};r.c.handoff(source,lease);
 const t=await r.c.reserve(b,descriptor(p)),ref=V.publicRef(t.allocation);await fill(r,p,b,ref);await seal(r.c,b,ref);await r.c.commitPair(b,ref,privateDescriptor(r.c.get(ref.slot)));
 // Move the replacement out of active/previous by normal publication transitions.
 await r.c.prepare(b,ref);await r.c.promote({role:'deploy'},ref);
 for(const n of [3,4]){const c=actor(n),other=await load(r,p,c);await seal(r.c,c,other);await r.c.commitPair(c,other,privateDescriptor(r.c.get(other.slot)));await r.c.prepare(c,other);await r.c.promote({role:'deploy'},other);}
 const other=r.c.pointers().active;
 assert.throws(()=>r.c.releaseSource(source,other),/PAIR_INCOMPLETE/);
 await r.c.retire(ref);assert.ok(r.c.get(ref.slot).pair);assert.equal(!!r.c.protected(r.c.get(ref.slot)),false);
 assert.throws(()=>r.c.releaseSource(source,ref),/PAIR_INCOMPLETE/);
 r.drop();await assert.rejects(r.c.gc(ref),/INJECTED_RESPONSE_LOSS/);assert.equal(r.c.get(ref.slot).phase,'GC');assert.throws(()=>r.c.releaseSource(source,ref),/PAIR_INCOMPLETE/);
 while(!(await r.c.gc(ref)).done){}assert.throws(()=>r.c.releaseSource(source,ref),/STALE_EPOCH/);
 restart(r);assert.equal(r.c.get(source.slot).source,true);await assert.rejects(r.c.retire(source),/PROTECTED/);
 assert.equal(P.sha(new Uint8Array(await(await r.c.chunk(b,source,0)).arrayBuffer())),p.chunks[0].sha256);
 }
,
 10: async(r,p,a)=>{
 const source=await load(r,p,a);await seal(r.c,a,source);await r.c.freeze(a,source);
 const lease=next(a),b={role:'build',...lease};r.c.handoff(source,lease);
 const t=await r.c.reserve(b,descriptor(p)),ref=V.publicRef(t.allocation);await fill(r,p,b,ref);await seal(r.c,b,ref);await r.c.commitPair(b,ref,privateDescriptor(r.c.get(ref.slot)));await r.c.prepare(b,ref);await r.c.promote({role:'deploy'},ref);
 for(const n of [3,4]){const c=actor(n),other=await load(r,p,c);await seal(r.c,c,other);await r.c.commitPair(c,other,privateDescriptor(r.c.get(other.slot)));await r.c.prepare(c,other);await r.c.promote({role:'deploy'},other);}
 assert.equal(r.c.get(ref.slot).phase,'PUBLIC_SEALED');assert.equal(!!r.c.protected(r.c.get(ref.slot)),false);
 assert.throws(()=>r.c.releaseSource(source,ref),/PAIR_INCOMPLETE/);assert.equal(r.c.get(source.slot).source,true);
 },
 11: async(r,p,a)=>{
 const source=await load(r,p,a);await seal(r.c,a,source);await r.c.commitPair(a,source,privateDescriptor(r.c.get(source.slot)));await r.c.freeze(a,source);
 const lease=next(a),b={role:'build',...lease};r.c.handoff(source,lease);
 const t=await r.c.reserve(b,descriptor(p)),ref=V.publicRef(t.allocation);await fill(r,p,b,ref);await seal(r.c,b,ref);await r.c.commitPair(b,ref,privateDescriptor(r.c.get(ref.slot)));
 // Explicit persisted-state fault injection: a historical but valid Pair is
 // stored against the wrong allocation. This is not a normal API transition.
 const original=r.c.get(ref.slot);r.c.tx(()=>r.c.save({...original,pair:r.c.get(source.slot).pair}));restart(r);
 assert.throws(()=>r.c.releaseSource(source,ref),/PAIR_INCOMPLETE/);await assert.rejects(r.c.retire(source),/PROTECTED/);
 r.c.tx(()=>r.c.save(original));r.c.releaseSource(source,ref);assert.equal(r.c.get(source.slot).source,false);
 }
,
 12: async(r,p,a)=>{
 const g=gate();r.c.pause=async point=>{if(point==='coordinator:before-send')await g.pause();};
 try{
  const d=descriptor(p);grant(r.c,a);
  const first=r.c.reserve(a,d),second=r.c.reserve(a,d);await g.reached;
  await assert.rejects(r.c.reserve(a,{...d,builtAt:'2026-10-19T13:00:00.000Z'}),/ALLOCATION_EXISTS/);
  assert.equal(r.c.slots().filter(s=>s.phase!=='FREE').length,1);
  g.release();const [one,two]=await Promise.all([first,second]);assert.deepEqual(one.allocation,two.allocation);
  const pair=await Promise.all([r.c.reserve(a,d),r.c.reserve(a,d)]);assert.deepEqual(pair[0].allocation,pair[1].allocation);
 }finally{g.release();}
 }
,
 13: async(r,p,a)=>{
 const source=await load(r,p,a);await seal(r.c,a,source);await r.c.freeze(a,source);
 const lease=next(a),b={role:'build',...lease};r.c.handoff(source,lease);
 const replacement=await r.c.reserve(b,descriptor(p)),ref=V.publicRef(replacement.allocation);
 await fill(r,p,b,ref);await seal(r.c,b,ref);
 assert.throws(()=>r.c.releaseSource(source,ref),/PAIR_INCOMPLETE/);
 await r.c.commitPair(b,ref,privateDescriptor(r.c.get(ref.slot)));
 const replay=async()=>{
  assert.deepEqual((await r.c.reserve(b,descriptor(p))).allocation,replacement.allocation);
  await assert.rejects(r.c.reserve(b,{...descriptor(p),builtAt:'2026-10-19T13:00:00.000Z'}),/ALLOCATION_EXISTS/);
  await assert.rejects(r.c.reserve(a,descriptor(p)),/LEASE_FENCED/);
  await assert.rejects(r.c.reserve({...b,runId:'999'},descriptor(p)),/LEASE_FENCED/);
  await assert.rejects(r.c.retire(ref),/PROTECTED/);
 };
 await replay();r.c.releaseSource(source,ref);await replay();
 r.drop();await assert.rejects(r.c.retire(source),/INJECTED_RESPONSE_LOSS/);await replay();restart(r);await replay();
 await r.c.drive(source.slot);await replay();r.drop();await assert.rejects(r.c.gc(source),/INJECTED_RESPONSE_LOSS/);await replay();restart(r);await replay();
 while(!(await r.c.gc(source)).done){}await replay();restart(r);await replay();
 for(const c of p.chunks)assert.equal(P.sha(new Uint8Array(await(await r.c.chunk(b,ref,c.ordinal)).arrayBuffer())),c.sha256);
 },
 14: async(r,p,a)=>{
 const g=gate();let sends=0;
 r.slots[0]=new (createWillReleaseClass({pause:async point=>{if(point==='slot:init:before-commit')await g.pause();}}))({storage:r.stores[0]});
 const remote=r.c.remote;r.c.remote=async function(s,action,body,bytes){if(body.action==='init')sends++;return remote.call(this,s,action,body,bytes);};
 grant(r.c,a);const pending=r.c.reserve(a,descriptor(p)).then(value=>({value}),error=>({error}));
 try{
  await bounded(g.reached);const ref=V.publicRef(r.c.get(0).allocation);
  const freezing=r.c.freeze(a,ref);freezing.catch(()=>{});
  // Give both callers the chance to enter the slot before releasing its commit.
  await new Promise(resolve=>setTimeout(resolve,20));g.release();
  await bounded(freezing);await bounded(pending);
  assert.equal(r.c.get(0).phase,'FROZEN');assert.equal(r.slots[0].state().phase,'FROZEN');
  assert.equal(sends,1,'reserve and freeze share init transport');
  await assert.rejects(r.c.write(a,ref,'page',0,p.pages[0]),/LEASE_FENCED|WRITE_FENCED/);
  restart(r);assert.equal(r.c.get(0).phase,'FROZEN');r.c.handoff(ref,next(a));await r.c.retire(ref);while(!(await r.c.gc(ref)).done){}
  // Lost init response, reboot, then freeze without first replaying reserve.
  const b=actor(20);grant(r.c,b);r.drop();await assert.rejects(r.c.reserve(b,descriptor(p)),/INJECTED_RESPONSE_LOSS/);
  const lost=V.publicRef(r.c.get(0).allocation);restart(r);
  // Drop specifically the freeze receipt, after the retransmitted init succeeded.
  const send=r.c.remote;r.c.remote=async function(s,action,body,bytes){const result=await send.call(this,s,action,body,bytes);if(body.action==='freeze')throw Error('INJECTED_RESPONSE_LOSS');return result;};
  await assert.rejects(r.c.freeze(b,lost),/INJECTED_RESPONSE_LOSS/);restart(r);await r.c.freeze(b,lost);
  assert.equal(r.c.get(0).phase,'FROZEN');await assert.rejects(r.c.write(b,lost,'page',0,p.pages[0]),/LEASE_FENCED/);
 }finally{g.release();await bounded(pending);}
 }

};
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('GATE_TIMEOUT')),3000);})]);}finally{clearTimeout(timer);}}
export const recoveryScenario=(id,options={})=>scope(cases[id],options);

const mutations=[
 {name:'review3-replay-blocked-by-released-source',id:13,module:'release-coordinator.js',from:'  if(existing){\n   const a=existing.allocation;',to:"  if(existing){\n   for(const s of candidates){if(s===existing)continue;V.check(s.source&&s.sealReceipt&&s.phase==='PUBLIC_SEALED'&&!s.journal&&s.allocation.leaseEpoch<l.leaseEpoch,'ALLOCATION_EXISTS');}\n   const a=existing.allocation;"},
 {name:'review3-freeze-unshared-init',id:14,module:'release-coordinator.js',from:'await this.sendInit(before);',to:"await this.remote(before,'control',before.journal);"},
 {name:'duplicate-init-in-flight',id:12,module:'release-coordinator.js',from:'let running=this.initializing.get(key);',to:'let running;'},
 {name:'reserve-missing-post-hash-recheck',id:12,module:'release-coordinator.js',from:'// Recheck lease identity after hashing; a concurrent reserve may have won.\n   const existing=this.reservation(l,descriptor);if(existing)return existing;',to:''},
 {name:'unprotected-successor',id:10,module:'release-coordinator.js',from:"&&!next.journal&&!!this.protected(next)",to:'&&!next.journal'},
 {name:'unrelated-persisted-pair',id:11,module:'release-coordinator.js',from:"V.sameRef(p.publicRef,a)&&p.allocationHash===a.allocationHash&&p.sealReceiptSha256===next.sealReceipt?.sha256&&\n   ['requestId','generation','leaseEpoch','codeSha','builtAt','receiptSha256','fileManifestSha256','personContextSha256'].every(k=>p[k]===a[k])",to:'true'},
 {name:'same-generation-reserve-blocked',id:8,module:'release-coordinator.js',from:"s.source&&s.sealReceipt&&s.phase==='PUBLIC_SEALED'&&!s.journal&&s.allocation.leaseEpoch<l.leaseEpoch",to:'false'},
 {name:'same-generation-release-blocked',id:8,module:'release-coordinator.js',from:"(a.generation>s.allocation.generation||(a.generation===s.allocation.generation&&a.leaseEpoch>s.allocation.leaseEpoch))",to:'a.generation>s.allocation.generation'},
 {name:'historical-pair-releases-source',id:9,module:'release-coordinator.js',from:"V.check(next.phase==='PUBLIC_SEALED'&&!next.journal&&!!this.protected(next),'PAIR_INCOMPLETE');",to:''},
 {name:'lost-seal-receipt',id:1,module:'release-coordinator.js',from:'s.sealReceipt=r.sealReceipt;s.source=true;',to:'s.source=true;'},
 {name:'partial-seal-freeze',id:2,module:'release-storage.js',from:"['WRITING','FROZEN','SEALING','SEALED'].includes(s.phase)&&c.args.writerFence",to:"['WRITING','FROZEN','SEALED'].includes(s.phase)&&c.args.writerFence"},
 {name:'expired-write-auth',id:3,module:'release-coordinator.js',from:'return this.beginFreeze(ref,true);',to:"this.auth({role:'build',...s.allocation},s.allocation);return this.beginFreeze(ref,true);"},
 {name:'retained-new-lease',id:4,module:'release-coordinator.js',from:'const retained=this.protected(s)&&!!s.sealReceipt;',to:'const retained=false;'},
 {name:'freeze-public-phase',id:4,module:'release-coordinator.js',from:"s.phase=r.phase==='SEALED'?'PUBLIC_SEALED':'FROZEN';",to:'s.phase=r.phase;'},
 {name:'incomplete-preflight',id:5,module:'release-coordinator.js',from:"V.check(status.phase==='WRITING'&&status.counts?.chunks===s.allocation.chunkCount&&status.counts?.files===s.allocation.fileCount&&status.counts?.pages===Math.ceil(s.allocation.fileCount/64),'INCOMPLETE_PACK');",to:''},
 {name:'sql-write-per-pull',id:6,module:'release-storage.js',from:'c.enqueue(raw.slice(start,start+n));',to:"c.enqueue(raw.slice(start,start+n));this.q('UPDATE slot_state SET value=value WHERE id=1');"},
 {name:'metadata-limit',id:7,module:'release-coordinator.js',from:'leaseBudget(){return V.LIMITS.metadataBytes-5*65536-4096;}',to:'leaseBudget(){return Number.MAX_SAFE_INTEGER;}'},
 {name:'terminal-lease-protection',id:7,module:'release-coordinator.js',from:'l.expiresAt>this.now()||live.has(l.requestId)',to:'l.expiresAt>this.now()'}
];
export async function runRecoveryMutations(){
 const {readFile}=await import('node:fs/promises');const results=[];
 for(const m of mutations){
  await recoveryScenario(m.id);
  let source=await readFile(new URL('../../src/upload/'+m.module,import.meta.url),'utf8');
  assert.equal(source.split(m.from).length,2,'unique mutation target: '+m.name);
  source=source.replace(m.from,m.to).replaceAll("'./storage-contract.js'",JSON.stringify(new URL('../../src/upload/storage-contract.js',import.meta.url).href)).replaceAll("'./release-storage.js'",JSON.stringify(new URL('../../src/upload/release-storage.js',import.meta.url).href));
  const loaded=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const options=m.module==='release-storage.js'?{Slot:loaded.createWillReleaseClass()}:{Coordinator:loaded.ReleaseCoordinator};
  let failure=null;try{await recoveryScenario(m.id,options);}catch(e){failure={code:e.code||'PROTOCOL_ERROR',message:e.message.split('\n')[0]};}
  results.push({name:m.name,scenario:m.id,intact:'pass',detected:!!failure,failure});
 }
 // Same scheduling as the A3 red reproduction, with the commit recheck removed.
 const {transportScenario}=await import('./storage-init-recovery.js');
 const from='const committed=this.recalled(c);if(committed)return committed;';
 let source=await readFile(new URL('../../src/upload/release-storage.js',import.meta.url),'utf8');
 assert.equal(source.split(from).length,2,'unique init commit recheck');
 source=source.replace(from,'').replaceAll("'./storage-contract.js'",JSON.stringify(new URL('../../src/upload/storage-contract.js',import.meta.url).href));
 const loaded=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const trials=[];
 for(const rebuild of [false,true])for(const expired of [false,true])for(const delayed of [false,true]){
  const options={rebuild,expired,delayed};await transportScenario(options);
  let failure=null;try{await transportScenario({...options,SlotFactory:loaded.createWillReleaseClass});}catch(e){failure={code:e.code||'PROTOCOL_ERROR',message:e.message.split('\n')[0]};}
  trials.push({...options,intact:'pass',detected:!!failure,failure});
 }
 results.push({name:'review4-init-missing-commit-recheck',detected:trials.every(t=>t.detected),trials});
 return results;
}
