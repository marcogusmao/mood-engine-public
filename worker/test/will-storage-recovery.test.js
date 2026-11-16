import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recoveryNames,recoveryScenario,runRecoveryMutations} from './upload-fixtures/storage-recovery.js';
for(const [i,name] of recoveryNames.entries())test('recovery: '+name,()=>recoveryScenario(i+1));
test('recovery: restored defects each fail the same behavioral scenario',async()=>{const results=await runRecoveryMutations();for(const r of results)assert.equal(r.detected,true,JSON.stringify(r));});

test('recovery: freeze wins against final seal paused before its commit',async()=>{
 const {rig,actor,grant,descriptor,gate}=await import('./upload-fixtures/storage-rig.js');
 const {pack}=await import('./upload-fixtures/storage-recovery.js');
 const {createWillReleaseClass}=await import('../src/upload/release-storage.js');
 const V=await import('../src/upload/storage-contract.js');
 const g=gate();let enabled=false;
 const r=await rig({Slot:createWillReleaseClass({pause:async point=>{if(enabled&&point==='slot:seal:before-commit')await g.pause();}})});
 try{
  const p=await pack(),a=actor();grant(r.c,a);const s=await r.c.reserve(a,descriptor(p)),ref=V.publicRef(s.allocation);
  for(let i=0;i<p.pages.length;i++)await r.c.write(a,ref,'page',i,p.pages[i]);for(const c of p.chunks)await r.c.write(a,ref,'chunk',c.ordinal,p.bytes.subarray(c.ordinal*262144,c.ordinal*262144+c.bytes));
  await r.c.seal(a,ref);await r.c.seal(a,ref);enabled=true;const pending=r.c.seal(a,ref);await g.reached;
  await r.c.freeze(a,ref);g.release();await assert.rejects(pending,/STALE_CONTROL/);
  assert.equal(r.slots[0].state().phase,'FROZEN');assert.equal(r.c.get(0).sealReceipt,undefined);assert.equal(r.c.get(0).journal,null);
 }finally{g.release();r.close();}
});

test('recovery: expiry resumes an interrupted user freeze without a second revocation',async()=>{
 const {rig,actor,grant,descriptor}=await import('./upload-fixtures/storage-rig.js');
 const {pack}=await import('./upload-fixtures/storage-recovery.js');
 const {publicRef}=await import('../src/upload/storage-contract.js');
 const r=await rig();try{const a=actor();grant(r.c,a);const s=await r.c.reserve(a,descriptor(await pack())),ref=publicRef(s.allocation);r.drop();await assert.rejects(r.c.freeze(a,ref),/INJECTED_RESPONSE_LOSS/);r.c.now=()=>Date.now()+7200000;await r.c.revokeExpired(ref);assert.equal(r.c.get(0).pending,false);await r.c.retire(ref);while(!(await r.c.gc(ref)).done){}assert.equal(r.c.get(0).phase,'FREE');}finally{r.close();}
});


test('review3: init receipt delayed until after freeze cannot restore writes', {timeout:5000}, async()=>{
 const {rig,actor,grant,descriptor,gate}=await import('./upload-fixtures/storage-rig.js');
 const {pack}=await import('./upload-fixtures/storage-recovery.js');
 const V=await import('../src/upload/storage-contract.js');
 const g=gate(),r=await rig();let first=true;
 r.c.pause=async point=>{if(first&&point==='coordinator:after-response'){first=false;await g.pause();}};
 const a=actor(),p=await pack();grant(r.c,a);
 const pending=r.c.reserve(a,descriptor(p)).then(value=>({value}),error=>({error}));
 try{
  await g.reached;const ref=V.publicRef(r.c.get(0).allocation);
  await r.c.freeze(a,ref);g.release();assert.match((await pending).error.message,/STALE_RECEIPT/);
  assert.equal(r.c.get(0).phase,'FROZEN');assert.equal(r.slots[0].state().phase,'FROZEN');
  await assert.rejects(r.c.write(a,ref,'page',0,p.pages[0]),/LEASE_FENCED/);
 }finally{g.release();await pending;r.close();}
});

for(const rebuild of [false,true])for(const expired of [false,true])for(const delayed of [false,true])test(`review4: in-flight transport loss rebuild=${rebuild} expiry=${expired} delayed=${delayed}`,{timeout:10000},async()=>{
 const {transportScenario}=await import('./upload-fixtures/storage-init-recovery.js');await transportScenario({rebuild,expired,delayed});
});
test('review4: concurrent same operationId with different command is refused',{timeout:10000},async()=>{
 const {conflictScenario}=await import('./upload-fixtures/storage-init-recovery.js');await conflictScenario();
});

test('review4: original execution delayed through GC and reuse cannot initialize again',{timeout:10000},async()=>{
 const {transportScenario}=await import('./upload-fixtures/storage-init-recovery.js');await transportScenario({rebuild:true,delayed:'reuse'});
});
