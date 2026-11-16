import * as V from './storage-contract.js';
import {Meter} from './release-storage.js';
// Owns only v2 proof tables. Caller authenticates actor before entering this component.
export class ReleaseCoordinator {
 constructor({storage,namespace,now=()=>Date.now(),pause=async()=>{},meterOptions={}}){this.initializing=new Map();this.initSending=new Map();this.storage=storage;this.namespace=namespace;this.now=now;this.pause=pause;this.m=new Meter(storage,'coordinator',meterOptions);
 this.q('CREATE TABLE IF NOT EXISTS release_slots (slot INTEGER PRIMARY KEY, value TEXT NOT NULL)');
 this.q('CREATE TABLE IF NOT EXISTS release_leases (requestId TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID');
 this.q('CREATE TABLE IF NOT EXISTS release_pointers (id INTEGER PRIMARY KEY,value TEXT NOT NULL)');
 for(let slot=0;slot<4;slot++)this.q('INSERT OR IGNORE INTO release_slots VALUES (?,?)',slot,V.canonical({slot,slotEpoch:0,phase:'FREE',version:0}));
 this.q('INSERT OR IGNORE INTO release_pointers VALUES (1,?)',V.canonical({active:null,previous:null,prepared:null}));this.q('CREATE TABLE IF NOT EXISTS release_metadata (id INTEGER PRIMARY KEY, bytes INTEGER NOT NULL)');
 if(!this.q('SELECT id FROM release_metadata WHERE id=1')[0])this.q('INSERT INTO release_metadata SELECT 1, COALESCE(SUM(length(CAST(requestId AS BLOB))+length(CAST(value AS BLOB))),0) FROM release_leases');}
 q(...args){return this.m.exec(...args);}
 tx(fn){return this.storage.transactionSync(fn);}
 slots(){return this.q('SELECT value FROM release_slots ORDER BY slot').map(r=>JSON.parse(r.value));}
 get(slot){V.check(V.integer(slot,0,3));return JSON.parse(this.q('SELECT value FROM release_slots WHERE slot=?',slot)[0].value);}
 save(s){V.check(V.utf8(V.canonical(s)).length<65536,'METADATA_BOUNDS');this.q('UPDATE release_slots SET value=? WHERE slot=?',V.canonical(s),s.slot);V.check((this.storage.sql.databaseSize||0)<=V.LIMITS.coordinatorPhysicalBytes,'STORAGE_BUDGET_DEFERRED');}
 pointers(){return JSON.parse(this.q('SELECT value FROM release_pointers WHERE id=1')[0].value);}
 savePointers(p){V.check(V.utf8(V.canonical(p)).length<65536,'METADATA_BOUNDS');this.q('UPDATE release_pointers SET value=? WHERE id=1',V.canonical(p));}
 lease(id){const row=this.q('SELECT value FROM release_leases WHERE requestId=?',id)[0];V.check(row,'LEASE_REQUIRED');return JSON.parse(row.value);}
 // Slot rows reserve 64 KiB each, pointers 64 KiB, accounting 4 KiB.
 // This headroom lets revocation finish even when lease admission is full.
 leaseBudget(){return V.LIMITS.metadataBytes-5*65536-4096;}
 validateLease(l){
  V.keys(l,['requestId','generation','leaseEpoch','runId','runAttempt','codeSha','expiresAt']);
  V.check(typeof l.requestId==='string'&&l.requestId.length>0&&l.requestId.length<=100&&V.integer(l.generation,1)&&V.integer(l.leaseEpoch,1)&&V.integer(l.expiresAt,this.now()+1)&&typeof l.runId==='string'&&/^\d{1,128}$/.test(l.runId)&&typeof l.runAttempt==='string'&&/^\d{1,128}$/.test(l.runAttempt)&&/^[a-f0-9]{40}$/.test(l.codeSha));
 }
 saveLease(l){
  const value=V.canonical(l),old=this.q('SELECT value FROM release_leases WHERE requestId=?',l.requestId)[0];
  const delta=V.utf8(value).length+(old?-V.utf8(old.value).length:V.utf8(l.requestId).length);
  const total=this.q('SELECT bytes FROM release_metadata WHERE id=1')[0].bytes+delta;
  V.check(total<=this.leaseBudget(),'METADATA_BOUNDS');
  this.q('INSERT INTO release_leases VALUES (?,?) ON CONFLICT(requestId) DO UPDATE SET value=excluded.value',l.requestId,value);
  this.q('UPDATE release_metadata SET bytes=? WHERE id=1',total);
 }
 grant(lease){
  this.validateLease(lease);
  this.tx(()=>{const existing=this.q('SELECT value FROM release_leases WHERE requestId=?',lease.requestId)[0];
   if(existing)V.check(existing.value===V.canonical(lease),'HANDOFF_REQUIRED');
   else { // Reserve the future freezing marker as part of admission.
    const total=this.q('SELECT bytes FROM release_metadata WHERE id=1')[0].bytes;
    V.check(total+V.utf8(V.canonical({...lease,freezing:false})).length+V.utf8(lease.requestId).length<=this.leaseBudget()-65536,'METADATA_BOUNDS');
    this.saveLease(lease);
   }
  });return lease;
 }
 // Internal maintenance only. Expiry alone never removes a lease needed by a slot.
 collectLeases(after=null){return this.tx(()=>{
  const rows=this.q('SELECT requestId,value FROM release_leases WHERE requestId>? ORDER BY requestId LIMIT 128',after||'');
  const live=new Set(this.slots().filter(s=>s.phase!=='FREE').map(s=>s.allocation?.requestId));
  let deleted=0;
  for(const row of rows){const l=JSON.parse(row.value);if(l.expiresAt>this.now()||live.has(l.requestId))continue;
   this.q('DELETE FROM release_leases WHERE requestId=?',l.requestId);
   this.q('UPDATE release_metadata SET bytes=bytes-? WHERE id=1',V.utf8(row.value).length+V.utf8(row.requestId).length);deleted++;
  }
  return {deleted,next:rows.length===128?rows.at(-1).requestId:null};
 });}

 auth(actor,a,role='build',allowFreezing=false){V.check(actor?.role===role,'ROLE_REQUIRED');if(role==='build'){const l=this.lease(a.requestId);V.check((!l.freezing||allowFreezing)&&l.expiresAt>this.now()&&['generation','leaseEpoch','runId','runAttempt','codeSha'].every(k=>l[k]===a[k]&&l[k]===actor[k])&&actor.requestId===a.requestId,'LEASE_FENCED');return l;}}
 protected(s){const p=this.pointers();return s.pending||s.source||Object.values(p).some(r=>r&&V.sameRef(r,s.allocation));}
 command(s,action,args={}){s.version++;const c={...V.publicRef(s.allocation),operationId:crypto.randomUUID(),controlVersion:s.version,action,args};s.journal=c;s.phase={init:'INIT',freeze:'FREEZING',seal:'SEALING',retire:'RETIRING',gc:'GC'}[action];this.save(s);return c;}
 async remote(s,action,body,bytes){const stub=this.namespace.get(this.namespace.idFromName(`friend-a-public-slot-${s.slot}`));const headers={};if(action==='put')headers['X-Internal-Permit']=V.canonical(body);const response=await stub.fetch(new Request('https://will-storage.internal/'+action,{method:'POST',headers,body:action==='put'?(body.action==='page'?V.canonical(bytes):bytes):V.canonical(body)}));if(!response.ok){let e;try{e=(await response.json()).error;}catch{e='SLOT_ERROR';}throw Error(e);}return action==='read'||action==='chunk'?response:response.json();}
 // One allocation per lease. Admission of a replacement requires sealed older
 // sources; exact retries remain valid while those sources are later collected.
 reservation(l,descriptor){
  const candidates=this.slots().filter(s=>s.phase!=='FREE'&&s.allocation?.requestId===l.requestId&&s.allocation.generation===l.generation);
  const existing=candidates.find(s=>s.allocation.leaseEpoch===l.leaseEpoch);
  if(existing){
   const a=existing.allocation;
   const expected={...descriptor,...V.publicRef(a),requestId:l.requestId,generation:l.generation,leaseEpoch:l.leaseEpoch,runId:l.runId,runAttempt:l.runAttempt,codeSha:l.codeSha};
   const {allocationHash,...actual}=a;
   V.check(V.canonical(expected)===V.canonical(actual)&&['INIT','WRITING','SEALING','PUBLIC_SEALED'].includes(existing.phase),'ALLOCATION_EXISTS');
   return existing;
  }
  // Only admission of a NEW allocation depends on the other leases' sources.
  for(const s of candidates){if(s===existing)continue;V.check(s.source&&s.sealReceipt&&s.phase==='PUBLIC_SEALED'&&!s.journal&&s.allocation.leaseEpoch<l.leaseEpoch,'ALLOCATION_EXISTS');}
  return existing;
 }
 async reserved(slot,actor){
  if(slot.journal?.action==='init'){
   const key=slot.allocation.allocationHash;
   let running=this.initializing.get(key);
   if(!running){
    running=this.drive(slot.slot,actor);this.initializing.set(key,running);
   }
   try{await running;}finally{if(this.initializing.get(key)===running)this.initializing.delete(key);}

  }
  const current=this.get(slot.slot);this.auth(actor,current.allocation);return current;
 }
 async reserve(actor,descriptor){
  const l=this.lease(actor.requestId);this.auth(actor,l);
  const s=this.tx(()=>{
   this.auth(actor,l);const existing=this.reservation(l,descriptor);if(existing)return {existing};
   const free=this.slots().find(s=>s.phase==='FREE');V.check(free,'NO_FREE_SLOT');
   const a={...descriptor,storageVersion:2,personId:'friend-a',revision:'r-'+crypto.randomUUID().replaceAll('-',''),slot:free.slot,slotEpoch:free.slotEpoch+1,requestId:l.requestId,generation:l.generation,leaseEpoch:l.leaseEpoch,runId:l.runId,runAttempt:l.runAttempt,codeSha:l.codeSha};return {free,a};
  });
  if(s.existing)return this.reserved(s.existing,actor);
  const allocation={...s.a,allocationHash:await V.hash(V.canonical(s.a))};await V.validateAllocation(allocation);
  const slot=this.tx(()=>{
   this.auth(actor,l);
   // Recheck lease identity after hashing; a concurrent reserve may have won.
   const existing=this.reservation(l,descriptor);if(existing)return existing;
   const current=this.get(s.free.slot);V.check(current.phase==='FREE'&&current.slotEpoch===s.free.slotEpoch,'RESERVATION_RACE');
   const next={slot:current.slot,slotEpoch:allocation.slotEpoch,phase:'INIT',version:current.version,fence:1,allocation,pending:true,source:false,pair:null};this.command(next,'init',{allocation,writerFence:1});return next;
  });return this.reserved(slot,actor);
 }
 // All init senders share the exact durable command, including freeze/expiry.
 // Only drive applies its receipt; freeze may supersede it, and the journal CAS
 // then rejects a late receipt rather than restoring WRITING over the barrier.
 async sendInit(s){
  const c=s.journal;V.check(c?.action==='init','NO_PENDING_CONTROL');
  const key=c.operationId;let running=this.initSending.get(key);
  if(!running){running=this.remote(s,'control',c);this.initSending.set(key,running);}
  try{return await running;}finally{if(this.initSending.get(key)===running)this.initSending.delete(key);}
 }
 async drive(slot,actor){const before=this.get(slot),c=before.journal;V.check(c,'NO_PENDING_CONTROL');await this.pause('coordinator:before-send');const r=await (c.action==='init'?this.sendInit(before):this.remote(before,'control',c));await this.pause('coordinator:after-response');if((c.action==='seal'&&r.done)||(c.action==='freeze'&&r.phase==='SEALED')){await V.sealReceipt(r.sealReceipt);const a=before.allocation;V.check(V.sameRef(r.sealReceipt,a)&&['allocationHash','filesRoot','chunksRoot','packBytes','fileCount','chunkCount'].every(k=>r.sealReceipt[k]===a[k]),'INVALID_RECEIPT');}
 let leaseError;const outcome=this.tx(()=>{const s=this.get(slot);V.check(s.journal?.operationId===c.operationId&&s.version===c.controlVersion&&V.sameRef(r,c)&&r.operationId===c.operationId&&r.controlVersion===c.controlVersion&&r.action===c.action&&V.canonical(r.args)===V.canonical(c.args),'STALE_RECEIPT');
 if(c.action==='init'){try{this.auth(actor,s.allocation);}catch(e){s.pending=false;this.command(s,'retire',{writerFence:s.fence+1});leaseError=e;return r;}V.check(r.phase==='WRITING','INVALID_RECEIPT');s.phase='WRITING';}
 if(c.action==='freeze'){V.check(['FROZEN','SEALED'].includes(r.phase),'INVALID_RECEIPT');s.fence=c.args.writerFence;s.phase=r.phase==='SEALED'?'PUBLIC_SEALED':'FROZEN';
  if(r.phase==='SEALED'){s.sealReceipt=r.sealReceipt;s.source=true;}
  if(s.revocation?.expired)s.pending=false;
  s.revocation=null;}
 if(c.action==='seal'){if(!r.done)return r;V.check(r.phase==='SEALED'&&r.sealReceipt?.allocationHash===s.allocation.allocationHash,'INVALID_RECEIPT');this.auth(actor,s.allocation);s.phase='PUBLIC_SEALED';s.sealReceipt=r.sealReceipt;}
 if(c.action==='retire'){V.check(r.phase==='RETIRING','INVALID_RECEIPT');s.phase='RETIRED';}
 if(c.action==='gc'){if(!r.done)return r;V.check(r.phase==='FREE','INVALID_RECEIPT');s.phase='FREE';s.gcReceipt=r;s.pending=false;s.source=false;s.pair=null;}
 s.journal=null;this.save(s);return r;});if(leaseError)throw leaseError;return outcome;}
 target(ref){V.ref(ref);const s=this.get(ref.slot);V.check(s.allocation&&V.sameRef(ref,s.allocation)&&s.phase!=='FREE','STALE_EPOCH');return s;}
 async write(actor,ref,action,address,bytes){const s=this.target(ref),l=this.auth(actor,s.allocation);V.check(s.phase==='WRITING','WRITE_FENCED');const permit={...V.publicRef(s.allocation),allocationHash:s.allocation.allocationHash,action,address,leaseEpoch:l.leaseEpoch,writerFence:s.fence,expiresAt:Math.min(l.expiresAt,this.now()+30000)};return this.remote(s,'put',permit,bytes);}
 async freeze(actor,ref){
  const s=this.target(ref);
  // Retrying a durable barrier is allowed for the same still-valid producer.
  this.auth(actor,s.allocation,'build',true);
  return this.beginFreeze(ref,false,actor);
 }
 // Called by the coordinator's alarm/maintenance adapter, never by a browser DTO.
 async revokeExpired(ref){
  const s=this.target(ref),l=this.lease(s.allocation.requestId);
  V.check(l.expiresAt<=this.now(),'LEASE_FENCED');
  return this.beginFreeze(ref,true);
 }
 async beginFreeze(ref,expired,actor=null){
  const before=this.target(ref);
  // An unacknowledged init must reach the slot before its freeze barrier.
  if(before.journal?.action==='init'){
   await this.sendInit(before);
  }
  const slot=this.tx(()=>{
   const s=this.target(ref);
   const l=this.lease(s.allocation.requestId);
   if(expired)V.check(l.expiresAt<=this.now(),'LEASE_FENCED');
   else this.auth(actor,s.allocation,'build',true);
   if(s.journal?.action==='freeze'){
    if(expired&&!s.revocation.expired){s.revocation.expired=true;this.save(s);}
    return s.slot;
   }
   V.check(!s.journal||['init','seal'].includes(s.journal.action),'INVALID_PHASE');
   V.check(!['RETIRING','RETIRED','GC'].includes(s.phase),'INVALID_PHASE');
   l.freezing=true;this.saveLease(l);
   // Keep the superseded intention until the slot reports its state AT the barrier.
   // A status read before freeze cannot distinguish a final seal committing later.
   s.revocation={previous:s.journal||null,expired};
   this.command(s,'freeze',{writerFence:s.fence+1});return s.slot;
  });
  return this.drive(slot);
 }

 handoff(ref,next){return this.tx(()=>{const s=this.target(ref);V.check(['FROZEN','PUBLIC_SEALED','SEALED'].includes(s.phase)&&!s.journal,'FREEZE_REQUIRED');const old=this.lease(s.allocation.requestId);V.check(old.freezing&&old.leaseEpoch===s.allocation.leaseEpoch&&old.generation===s.allocation.generation&&next.requestId===old.requestId&&next.leaseEpoch===old.leaseEpoch+1,'HANDOFF_REQUIRED');V.keys(next,Object.keys(old).filter(k=>k!=='freezing'));V.check(next.expiresAt>this.now());this.validateLease(next);this.saveLease(next);s.pending=false;s.source=!!s.sealReceipt;this.save(s);return next;});}
 async seal(actor,ref){const s=this.target(ref);this.auth(actor,s.allocation);if(s.phase==='PUBLIC_SEALED')return s.sealReceipt;if(!s.journal){const status=await this.status(ref);V.check(status.phase==='WRITING'&&status.counts?.chunks===s.allocation.chunkCount&&status.counts?.files===s.allocation.fileCount&&status.counts?.pages===Math.ceil(s.allocation.fileCount/64),'INCOMPLETE_PACK');this.tx(()=>{const fresh=this.target(ref);this.auth(actor,fresh.allocation);V.check(fresh.phase==='WRITING'&&fresh.version===s.version,'STALE_CONTROL');this.command(fresh,'seal');});}return this.drive(s.slot,actor);}
 async status(ref){const s=this.target(ref);const c={...V.publicRef(s.allocation),operationId:crypto.randomUUID(),controlVersion:s.version,action:'status',args:{}};return this.remote(s,'control',c);}
 async commitPair(actor,ref,privateDescriptor){const before=this.target(ref);this.auth(actor,before.allocation);V.keys(privateDescriptor,['snapshotId','contentSha256','sealed','publicRef','allocationHash','sealReceiptSha256']);V.check(privateDescriptor.sealed===true&&V.isHash(privateDescriptor.contentSha256)&&V.sameRef(privateDescriptor.publicRef,ref)&&privateDescriptor.allocationHash===before.allocation.allocationHash&&privateDescriptor.sealReceiptSha256===before.sealReceipt?.sha256,'PAIR_INCOMPLETE');const remote=await this.status(ref);await this.pause('coordinator:pair:after-status');return this.tx(()=>{const s=this.target(ref);this.auth(actor,s.allocation);V.check(s.version===before.version&&s.pending&&s.phase==='PUBLIC_SEALED'&&remote.phase==='SEALED'&&remote.sealReceipt?.sha256===s.sealReceipt?.sha256,'PAIR_INCOMPLETE');const a=s.allocation;const p={...Object.fromEntries(['requestId','generation','leaseEpoch','codeSha','builtAt','receiptSha256','fileManifestSha256','personContextSha256'].map(k=>[k,a[k]])),snapshotId:privateDescriptor.snapshotId,contentSha256:privateDescriptor.contentSha256,publicRef:V.publicRef(a),allocationHash:a.allocationHash,sealReceiptSha256:s.sealReceipt.sha256};V.pair(p);s.pair=p;s.version++;this.save(s);return p;});}
 async prepare(actor,ref){const before=this.target(ref);this.auth(actor,before.allocation);V.check(before.pair,'PAIR_INCOMPLETE');const status=await this.status(ref);await this.pause('coordinator:prepare:after-status');return this.tx(()=>{const s=this.target(ref);this.auth(actor,s.allocation);V.check(s.version===before.version&&s.pair&&s.phase==='PUBLIC_SEALED'&&status.phase==='SEALED'&&status.sealReceipt?.sha256===s.pair.sealReceiptSha256,'STALE_PREPARATION');const p=this.pointers();V.check(!p.prepared||V.sameRef(p.prepared,ref),'PREPARED_EXISTS');p.prepared=V.publicRef(ref);this.savePointers(p);s.version++;s.pending=false;this.save(s);return s.pair;});}
 async promote(actor,ref){V.check(actor?.role==='deploy','ROLE_REQUIRED');const before=this.target(ref),p0=this.pointers();if(p0.active&&V.sameRef(p0.active,ref))return p0;V.check(p0.prepared&&V.sameRef(p0.prepared,ref)&&before.pair,'PAIR_INCOMPLETE');const status=await this.status(ref);await this.pause('coordinator:promote:after-status');return this.tx(()=>{const s=this.target(ref),p=this.pointers();V.check(s.version===before.version&&s.phase==='PUBLIC_SEALED'&&s.pair&&p.prepared&&V.sameRef(p.prepared,ref)&&status.phase==='SEALED'&&status.sealReceipt?.sha256===s.pair.sealReceiptSha256,'STALE_PROMOTION');p.previous=p.active;p.active=p.prepared;p.prepared=null;this.savePointers(p);s.version++;this.save(s);return p;});}
 abandon(actor,ref){return this.tx(()=>{const s=this.target(ref);this.auth(actor,s.allocation);V.check(!s.journal,'FREEZE_REQUIRED');const p=this.pointers();V.check(!p.active||!V.sameRef(p.active,ref),'PROTECTED');V.check(!p.previous||!V.sameRef(p.previous,ref),'PROTECTED');if(p.prepared&&V.sameRef(p.prepared,ref)){p.prepared=null;this.savePointers(p);}s.pending=false;s.source=!!s.sealReceipt;s.version++;this.save(s);return s;});}
 // Releasing a source requires its exact successor Pair to remain live and
 // protected in this transaction. A historical Pair alone proves no retention.
 releaseSource(ref,replacement){return this.tx(()=>{
  const s=this.target(ref),next=this.target(replacement),a=next.allocation,p=next.pair;
  V.check(p&&a.requestId===s.allocation.requestId&&
   (a.generation>s.allocation.generation||(a.generation===s.allocation.generation&&a.leaseEpoch>s.allocation.leaseEpoch)),'PAIR_INCOMPLETE');
  V.check(next.phase==='PUBLIC_SEALED'&&!next.journal&&!!this.protected(next),'PAIR_INCOMPLETE');
  V.check(V.sameRef(p.publicRef,a)&&p.allocationHash===a.allocationHash&&p.sealReceiptSha256===next.sealReceipt?.sha256&&
   ['requestId','generation','leaseEpoch','codeSha','builtAt','receiptSha256','fileManifestSha256','personContextSha256'].every(k=>p[k]===a[k]),'PAIR_INCOMPLETE');
  V.pair(p);s.source=false;this.save(s);
 });}
 async retire(ref){const slot=this.tx(()=>{const s=this.target(ref);V.check(!this.protected(s),'PROTECTED');V.check(!['RETIRING','RETIRED','GC'].includes(s.phase),'INVALID_PHASE');this.command(s,'retire',{writerFence:s.fence+1});return s.slot;});return this.drive(slot);}
 async gc(ref){const s=this.target(ref);V.check(['RETIRED','GC'].includes(s.phase),'GC_NOT_RETIRED');if(!s.journal)this.tx(()=>{const fresh=this.target(ref);this.command(fresh,'gc');});return this.drive(s.slot);}
 readAccess(actor,s){
  const l=this.lease(actor?.requestId);this.auth(actor,l);
  const retained=this.protected(s)&&!!s.sealReceipt;
  // Original producer may read back its candidate before sealing or retirement.
  const producer=['requestId','generation','leaseEpoch','runId','runAttempt','codeSha'].every(k=>actor[k]===s.allocation[k]);
  V.check(retained||producer,'LEASE_FENCED');
  V.check(!['RETIRING','RETIRED','GC','FREE'].includes(s.phase),'READ_RETIRED');
 }
 async read(ref,path,head=false,privateActor=null){
  const s=this.target(ref),p=this.pointers();
  if(privateActor)this.readAccess(privateActor,s);
  else V.check(Object.values(p).some(r=>r&&V.sameRef(r,ref)),'NOT_PUBLIC');
  V.check(s.sealReceipt&&['PUBLIC_SEALED','FREEZING'].includes(s.phase),'READ_RETIRED');
  await this.pause('coordinator:read:before-send');
  return this.remote(s,'read',{ref:V.publicRef(ref),path:V.path(path),head});
 }
 async chunk(actor,ref,ordinal){const s=this.target(ref);this.readAccess(actor,s);return this.remote(s,'chunk',{ref,ordinal});}
 async page(actor,ref,page){const s=this.target(ref);this.readAccess(actor,s);return this.remote(s,'page',{ref,page});}
 async manifest(actor,ref){const s=this.target(ref);this.readAccess(actor,s);return this.remote(s,'manifest',{ref});}

 async metrics(){const slots=[];for(const s of this.slots())slots.push({slot:s.slot,...await this.remote(s,'metrics',{})});return {coordinator:this.m.snapshot(),slots};}
}
