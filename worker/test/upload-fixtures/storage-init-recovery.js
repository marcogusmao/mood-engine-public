import assert from 'node:assert/strict';
import {rig,actor,grant,descriptor,gate} from './storage-rig.js';
import {ReleaseCoordinator} from '../../src/upload/release-coordinator.js';
import {createWillReleaseClass} from '../../src/upload/release-storage.js';
import * as V from '../../src/upload/storage-contract.js';
import {pack} from './storage-recovery.js';

export async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('GATE_TIMEOUT')),3000);})]);}finally{clearTimeout(timer);}}
export async function transportScenario({SlotFactory=createWillReleaseClass,rebuild=false,expired=false,delayed=false}={}){
 const first=gate(),second=gate();let entered=0,slotDone,freezing;
 const r=await rig({Slot:SlotFactory({pause:async point=>{if(point==='slot:init:before-commit'){entered++;await (entered===1?first:second).pause();}}})});
 try{
  const p=await pack(),a=actor();grant(r.c,a);const base=r.c.namespace;let lose=true;
  const namespace={idFromName:n=>base.idFromName(n),get:id=>({fetch:async req=>{const pending=base.get(id).fetch(req);if(lose){lose=false;slotDone=pending;await bounded(first.reached);throw Error('INJECTED_TRANSPORT_LOSS_WITH_SLOT_IN_FLIGHT');}return pending;}})};
  r.c.namespace=namespace;
  await assert.rejects(r.c.reserve(a,descriptor(p)),/INJECTED_TRANSPORT_LOSS_WITH_SLOT_IN_FLIGHT/);
  const command=r.c.get(0).journal,ref=V.publicRef(command),permit={...ref,allocationHash:command.args.allocation.allocationHash,action:'page',address:0,leaseEpoch:1,writerFence:1,expiresAt:Date.now()+3600000};
  assert.equal(r.slots[0].state().phase,'FREE');
  if(rebuild)r.c=new ReleaseCoordinator({storage:r.stores[4],namespace});
  assert.deepEqual(r.c.get(0).journal,command);
  if(expired)r.c.now=()=>Date.now()+7200000;
  freezing=(expired?r.c.revokeExpired(ref):r.c.freeze(a,ref));freezing.catch(()=>{});
  await bounded(second.reached);assert.equal(entered,2);
  if(!delayed)first.release();second.release();
  await bounded(freezing);
  assert.equal(r.c.get(0).phase,'FROZEN');assert.equal(r.c.get(0).journal,null);assert.equal(r.slots[0].state().phase,'FROZEN');
  // The original execution may finish only after the barrier. Its old receipt
  // is an acknowledgement, never a state transition back to WRITING.
  const frozen=r.slots[0].state();
  if(delayed!=='reuse'){first.release();assert.equal((await bounded(slotDone)).status,200);assert.deepEqual(r.slots[0].state(),frozen);}
  await assert.rejects(r.c.write(a,ref,'page',0,p.pages[0]),/LEASE_FENCED/);
  await assert.rejects(r.slots[0].put(permit,p.pages[0]),/WRITE_FENCED/);
  // Full canonical command identity, including fields outside the allocation.
  for(const bad of [{...command,controlVersion:command.controlVersion+1},{...command,args:{...command.args,writerFence:2}},{...command,revision:'r-'+'f'.repeat(32)},{...command,action:'freeze',args:{writerFence:2}}])await assert.rejects(r.slots[0].control(bad),/CONTROL_CONFLICT/);
  const snapshot=r.slots[0].state();await r.slots[0].control(command);assert.deepEqual(r.slots[0].state(),snapshot);
  if(!expired){const {role,...lease}=a;r.c.handoff(ref,{...lease,leaseEpoch:2,expiresAt:Date.now()+3600000});}
  await r.c.retire(ref);const retired=r.slots[0].state();await r.slots[0].control(command);assert.deepEqual(r.slots[0].state(),retired);
  while(!(await r.c.gc(ref)).done){}
  r.c.now=()=>Date.now();const b=actor(2);grant(r.c,b);const fresh=await r.c.reserve(b,descriptor(p));assert.equal(fresh.slotEpoch,ref.slotEpoch+1);
  if(delayed==='reuse'){first.release();const stale=await bounded(slotDone);assert.equal(stale.status,409);assert.equal((await stale.json()).error,'INIT_EPOCH');}
  await assert.rejects(r.slots[0].control(command),/INIT_EPOCH/);
  await assert.rejects(r.slots[0].put(permit,p.pages[0]),/STALE_EPOCH/);
  assert.equal(r.slots[0].state().allocation.revision,fresh.allocation.revision);
 }finally{first.release();second.release();await Promise.allSettled([slotDone,freezing]);r.close();}
}

export async function conflictScenario({SlotFactory=createWillReleaseClass}={}){
 const g=gate();let entered=0;const r=await rig({Slot:SlotFactory({pause:async point=>{if(point==='slot:init:before-commit'){entered++;await g.pause();}}})});let one,two;
 try{
  const a=actor();grant(r.c,a);one=r.c.reserve(a,descriptor(await pack()));one.catch(()=>{});await bounded(g.reached);
  const command=r.c.get(0).journal;two=r.slots[0].control({...command,args:{...command.args,writerFence:9}});two.catch(()=>{});
  await bounded((async()=>{while(entered<2)await new Promise(r=>setTimeout(r,1));})());g.release();await one;
  await assert.rejects(two,/CONTROL_CONFLICT/);assert.equal(r.slots[0].state().fence,1);
 }finally{g.release();await Promise.allSettled([one,two]);r.close();}
}
