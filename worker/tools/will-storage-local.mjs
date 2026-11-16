import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {resolve,dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
import P from '../../lib/will-public-pack.js';import F from '../../test-support/will-storage-fixture.js';
import {publicRef} from '../src/upload/storage-contract.js';import {actor,descriptor,privateDescriptor} from '../test/upload-fixtures/storage-rig.js';
const SELF=fileURLToPath(import.meta.url),ROOT=resolve(dirname(SELF),'../..'),args=process.argv.slice(2);
const flag=k=>args.includes('--'+k),option=(k,d)=>{const i=args.indexOf('--'+k);return i<0?d:args[i+1];};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
// Each client has its own process and TCP connection. Only fixture actors, no credentials.
if(flag('http-client')){
 let raw='';for await(const b of process.stdin)raw+=b;const input=JSON.parse(raw);let result;const events=[];const measuredFetch=async(url,options)=>{const t=performance.now();const r=await fetch(url,options);events.push({action:new URL(url).pathname.slice(1),ms:performance.now()-t});return r;};
 for(let attempt=0;attempt<5;attempt++){
 const start=performance.now(),body=input.binary?Buffer.from(input.binary,'base64'):JSON.stringify(input.body),headers=input.binary?{'X-Fixture-DTO':JSON.stringify(input.body)}:{'Content-Type':'application/json'};
 const r=await measuredFetch(input.base+'/'+input.action,{method:'POST',body,headers,signal:AbortSignal.timeout(30000)});const binary=input.action==='read';let value;
 if(binary&&r.ok){const h=createHash('sha256');let bytes=0;for await(const b of r.body){h.update(b);bytes+=b.length;}value={sha256:h.digest('hex'),bytes};}else value=await r.json();result={status:r.status,body:value,ms:performance.now()-start,pid:process.pid,attempts:attempt+1};
 if(input.action==='reserve'&&value.error==='RESERVATION_RACE')continue;
 if(input.action==='reserve'&&value.error==='INJECTED_RESPONSE_LOSS'){const state=await measuredFetch(input.base+'/state',{method:'POST',body:'{}'}).then(r=>r.json()),s=state.slots.find(s=>s.allocation?.requestId===input.body.actor.requestId);assert.ok(s?.journal);const retry=await measuredFetch(input.base+'/retry',{method:'POST',body:JSON.stringify({slot:s.slot,actor:input.body.actor})});assert.equal(retry.status,200);result={...result,status:200,body:(await measuredFetch(input.base+'/state',{method:'POST',body:'{}'}).then(r=>r.json())).slots[s.slot],recoveredResponseLoss:true};}
 break;
 }
 process.stdout.write(JSON.stringify({...result,events}));
}else{
 const scenario=option('scenario','protocol'),receiptPath=resolve(ROOT,option('receipt',`.context/2026-10-19-will-storage-${scenario}.json`));
 assert.ok(flag('offline'),'--offline required');assert.ok(['protocol','recovery','retry','capacity'].includes(scenario));
 const receipt={scenario,startedAt:new Date().toISOString(),head:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),node:process.version,contractSha256:P.sha(await readFile(resolve(ROOT,'contracts/will-storage-v2.json'))),schemaSha256:P.sha(P.canonical(await Promise.all(['worker/src/upload/release-storage.js','worker/src/upload/release-coordinator.js','worker/src/upload/storage-contract.js'].map(async path=>({path,sha256:P.sha(await readFile(resolve(ROOT,path)))}))))),asserts:[],seeds:[],releases:[],mutations:[],http:{},limits:{environment:'local workerd/SQLite; synthetic opaque bytes, synthetic actors; no OIDC signature/JPEG rendering proof',cpu:'wall latency only; hosted CPU unavailable',memory:'Node heap/RSS are harness-only; native workerd buffers/hosted heap unavailable',duration:'local wall time is not billed DO active time',physical:'SQLite databaseSize high-water allocation, not provider account usage',quotas:'no hosted quota enforcement or shared account traffic simulated'}};
 const sourcePaths=['contracts/will-storage-v2.json','lib/will-public-pack.js','test-support/will-storage-fixture.js','worker/src/upload/release-storage.js','worker/src/upload/release-coordinator.js','worker/src/upload/storage-contract.js','worker/test/upload-fixtures/storage-entry.js','worker/test/upload-fixtures/storage-rig.js','worker/test/upload-fixtures/storage-mutations.js','worker/test/upload-fixtures/storage-recovery.js','worker/test/upload-fixtures/storage-init-recovery.js','worker/test/upload-fixtures/offline.cjs','worker/tools/will-storage-local.mjs','worker/test/will-storage-recovery.test.js','worker/test/will-storage-protocol.test.js','test/will-storage-format.test.js'];
 receipt.sourceHashes=Object.fromEntries(await Promise.all(sourcePaths.map(async path=>[path,P.sha(await readFile(resolve(ROOT,path)))])));
 receipt.sourceSetSha256=P.sha(P.canonical(receipt.sourceHashes));
 receipt.metricsBoundary='Fixture-only SQL persistence includes its own writes and proof_calls. Production meters are volatile; stream pulls do not flush. All streams drain before explicit pre-restart/final collection.';
 const timing={},http={},temp=await mkdtemp(join(tmpdir(),'will-storage-v2-'));let child,output='',base,config,stopped=false;
 const record=(action,ms)=>{http[action]=(http[action]||0)+1;(timing[action]??=[]).push(ms);};
 function ok(value,label){assert.ok(value,label);receipt.asserts.push(label);}
 async function call(action,body={},binary){const t=performance.now(),r=await fetch(base+'/'+action,{method:'POST',headers:binary?{'X-Fixture-DTO':JSON.stringify(body)}:{'Content-Type':'application/json'},body:binary||JSON.stringify(body),signal:AbortSignal.timeout(30000)});record(action,performance.now()-t);if(action==='read'||action==='chunk'){if(!r.ok)throw Error(await r.text());return r;}const value=await r.json();return {status:r.status,body:value};}
 async function good(action,body={},binary){const r=await call(action,body,binary);assert.equal(r.status,200,action+': '+JSON.stringify(r.body));return r.body;}
 async function denied(action,body,error){const r=await call(action,body);assert.equal(r.status,409,JSON.stringify(r));assert.equal(r.body.error,error);receipt.asserts.push(action+' refuses '+error);return r;}
 function client(action,body,binary){return new Promise((resolve,reject)=>{const cp=spawn(process.execPath,['--require',join(ROOT,'worker/test/upload-fixtures/offline.cjs'),SELF,'--http-client'],{cwd:ROOT,stdio:['pipe','pipe','pipe']});let out='',err='';cp.stdout.on('data',b=>out+=b);cp.stderr.on('data',b=>err+=b);cp.once('exit',code=>{if(code!==0)return reject(Error('HTTP child '+code+': '+err));try{const r=JSON.parse(out);for(const event of r.events)record(event.action,event.ms);resolve(r);}catch(e){reject(e);}});cp.stdin.end(JSON.stringify({base,action,body,binary:binary?Buffer.from(binary).toString('base64'):null}));});}
 async function start(){output='';child=spawn(process.execPath,['--require',join(ROOT,'worker/test/upload-fixtures/offline.cjs'),join(ROOT,'worker/node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config',config,'--persist-to',join(temp,'persist'),'--ip','127.0.0.1','--port',base.split(':').at(-1),'--inspector-port','0','--log-level','error'],{cwd:join(ROOT,'worker'),env:{...process.env,WRANGLER_SEND_METRICS:'false',CI:'true',BROWSER:'none',CLOUDFLARE_API_TOKEN:'',CLOUDFLARE_ACCOUNT_ID:'',XDG_CONFIG_HOME:temp,WRANGLER_LOG_PATH:join(temp,'wrangler.log')},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const end=Date.now()+30000;while(Date.now()<end){if(child.exitCode!==null)throw Error('workerd start: '+output);try{if((await fetch(base+'/fixture/health')).ok)return;}catch{}await wait(100);}throw Error('workerd start deadline: '+output);}
 async function stop(){if(child&&child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await Promise.race([done,wait(5000)]);if(child.exitCode===null){child.kill('SIGKILL');await done;}}}
 async function restart(){(receipt.restartCheckpoints??=[]).push(await good('metrics'));await stop();await start();receipt.restarts=(receipt.restarts||0)+1;}
 async function make(seed,files,bytes){const file=join(temp,seed+'.pack'),pack=await P.writePack({sources:F.fixture({seed,files,bytes}),destination:file});receipt.seeds.push(seed);return {seed,file,pack};}
 async function grant(a){const {role,...lease}=a;await good('grant',{lease:{...lease,expiresAt:Date.now()+3600000}});}
 async function reserve(a,pack){await grant(a);return good('reserve',{actor:a,descriptor:descriptor(pack)});}
 async function send(a,s,item){const ref=publicRef(s.allocation),{pack,file}=item;for(let i=0;i<pack.pages.length;i++)await good('put',{actor:a,ref,kind:'page',address:i,page:pack.pages[i]});const fd=await import('node:fs/promises').then(fs=>fs.open(file));try{for(const c of pack.chunks){const b=Buffer.alloc(c.bytes);assert.equal((await fd.read(b,0,b.length,c.ordinal*262144)).bytesRead,b.length);await good('put',{actor:a,ref,kind:'chunk',address:c.ordinal},b);}}finally{await fd.close();}return ref;}
 async function seal(a,ref){for(let i=0;i<10000;i++){await good('seal',{actor:a,ref});const state=await good('state');const s=state.slots[ref.slot];if(s.phase==='PUBLIC_SEALED')return s;}throw Error('seal progress bound');}
 async function publish(a,ref){const state=await good('state'),s=state.slots[ref.slot];await good('pair',{actor:a,ref,privateDescriptor:privateDescriptor(s)});await good('prepare',{actor:a,ref});await good('promote',{actor:{role:'deploy'},ref});}
 async function verify(a,ref,item,files=true){const h=createHash('sha256');let bytes=0;for(const c of item.pack.chunks){const res=await call('chunk',{actor:a,ref,ordinal:c.ordinal});const data=new Uint8Array(await res.arrayBuffer());assert.equal(P.sha(data),c.sha256);h.update(data);bytes+=data.length;}assert.equal(bytes,item.pack.packBytes);assert.equal(h.digest('hex'),item.pack.packSha256);
 if(!files){receipt.asserts.push('complete chunk readback before seal '+item.seed);return;}const samples=[item.pack.files.find(f=>f.bytes===0),item.pack.files.find(f=>f.bytes===262143),item.pack.files.find(f=>f.bytes===2100001),item.pack.files.at(-1)];for(const f of samples){const res=await call('read',{actor:a,ref,path:f.path});const b=new Uint8Array(await res.arrayBuffer());assert.equal(b.length,f.bytes);assert.equal(P.sha(b),f.sha256);}receipt.asserts.push('whole pack and empty/boundary/>2MB/tail files byte-identical '+item.seed);}
 async function collect(ref){await good('retire',{ref});for(let i=0;i<1000;i++){const r=await good('gc',{ref});if(r.done)return r;}throw Error('GC progress bound');}
 async function gateCall(slot,point,action){if(slot===null)return good('fixture-gate',{point,action});const t=performance.now(),r=await fetch(base+'/fixture/slot/'+slot,{method:'POST',body:JSON.stringify({point,action})});record('slot-gate',performance.now()-t);assert.equal(r.status,200);return r.json();}
 async function reached(slot,point,count=1){const end=Date.now()+10000;while(Date.now()<end){const s=await gateCall(slot,point);if(s[point]>=count)return;await wait(10);}throw Error('gate not reached '+point);}
 try{
 await mkdir(dirname(receiptPath),{recursive:true});base='http://127.0.0.1:'+(20000+Math.floor(Math.random()*20000));config=join(temp,'wrangler.json');await writeFile(config,JSON.stringify({name:'will-storage-phase-a-proof',main:join(ROOT,'worker/test/upload-fixtures/storage-entry.js'),compatibility_date:'2025-09-01',durable_objects:{bindings:[{name:'PROOF',class_name:'ProofState'},{name:'RELEASES',class_name:'WillRelease'}]},migrations:[{tag:'proof-storage-v2',new_sqlite_classes:['ProofState','WillRelease']}]}));
 const req=createRequire(import.meta.url);receipt.workerdPackage=JSON.parse(await readFile(req.resolve('workerd/package.json',{paths:[join(ROOT,'worker')]}),'utf8')).version;await start();
 const initial=[];
 if(scenario==='retry'){
 // Small retry proof with real disk restart and separate reserve clients.
 const item=await make('same-generation-retry',70,3500000);
 // Review4: fail the transport while the slot is still paused BEFORE commit.
 // Rebuilding only the coordinator cannot cancel the slot's waitUntil task.
 for(const rebuild of [false,true])for(const expired of [false,true]){
  const producer=actor(300+Number(rebuild)*2+Number(expired));await grant(producer);
  const slot=0,point='slot:init:before-commit';await gateCall(slot,point,'arm');await gateCall(slot,point,'lose-init-transport');
  const lost=await client('reserve',{actor:producer,descriptor:descriptor(item.pack)});
  ok(lost.status===409&&lost.body.error==='INJECTED_TRANSPORT_LOSS_WITH_SLOT_IN_FLIGHT','review4 first client observes transport failure before slot commit');
  const before=(await good('state')).slots[slot],command=before.journal,refInit=publicRef(before.allocation);
  ok(before.phase==='INIT'&&command.action==='init','review4 durable init journal retained');
  const inFlight=await gateCall(slot,point,'in-flight');ok(inFlight.at(-1).completed===false,'review4 received execution is still pending after error response');
  await reached(slot,point);
  if(rebuild)await good('fixture-rebuild-coordinator');
  if(expired)await good('fixture-expire',{requestId:producer.requestId});
  const pendingFreeze=client(expired?'fixture-revoke':'freeze',expired?{ref:refInit}:{actor:producer,ref:refInit});pendingFreeze.catch(()=>{});
  await reached(slot,point,2);ok(true,'review4 retransmission reaches pre-commit gate while original execution is live');
  await gateCall(slot,point,'release');const frozen=await pendingFreeze;
  ok(lost.pid!==frozen.pid,'review4 lost reserve and barrier use distinct client process IDs');
  ok(frozen.status===200,'review4 single barrier call succeeds rebuild='+rebuild+' expired='+expired);
  const end=Date.now()+10000;let completed;
  do{completed=(await gateCall(slot,point,'in-flight')).at(-1);if(completed.completed)break;await wait(10);}while(Date.now()<end);
  ok(completed.completed&&completed.status===200,'review4 detached original init also completes successfully');
  ok((await good('state')).slots[slot].phase==='FROZEN'&&(await good('status',{ref:refInit})).phase==='FROZEN','review4 both barrier states frozen');
  await denied('put',{actor:producer,ref:refInit,kind:'page',address:0,page:item.pack.pages[0]},'LEASE_FENCED');
  await good('fixture/control/'+slot,command);
  ok((await good('status',{ref:refInit})).phase==='FROZEN','review4 delayed init receipt does not reopen frozen state');
  await denied('fixture/control/'+slot,{...command,args:{...command.args,writerFence:9}},'CONTROL_CONFLICT');
  const barrierCommands=(await good('state')).commands.filter(c=>c.slot===slot&&c.slotEpoch===refInit.slotEpoch);
  await restart();ok((await good('status',{ref:refInit})).phase==='FROZEN','review4 full workerd restart only AFTER completed barrier');
  if(!expired){const {role,...lease}=producer;await good('handoff',{ref:refInit,next:{...lease,leaseEpoch:2,expiresAt:Date.now()+3600000}});}
  await collect(refInit);
  const oldCommands=(await good('state')).commands.filter(c=>c.slot===slot&&c.slotEpoch===refInit.slotEpoch);
  const freshActor=actor(310+Number(rebuild)*2+Number(expired)),fresh=await reserve(freshActor,item.pack),freshRef=publicRef(fresh.allocation);
  ok(freshRef.slot===slot&&freshRef.slotEpoch===refInit.slotEpoch+1,'review4 GC reuse advances slot epoch');
  for(const old of [command,...barrierCommands,...oldCommands]){const stale=await call('fixture/control/'+slot,old);ok(stale.status===409&&['INIT_EPOCH','STALE_EPOCH'].includes(stale.body.error),'review4 old '+old.action+' refused after reuse');}
  await send(freshActor,fresh,item);await verify(freshActor,freshRef,item,false);
  await good('abandon',{actor:freshActor,ref:freshRef});await collect(freshRef);
 }
 const a=actor(201),s=await reserve(a,item.pack),source=await send(a,s,item);
 await verify(a,source,item,false);await seal(a,source);await good('freeze',{actor:a,ref:source});
 const {role,...old}=a,lease={...old,leaseEpoch:2,expiresAt:Date.now()+3600000},b={role:'build',...lease};
 await good('handoff',{ref:source,next:lease});await restart();await verify(b,source,item);
 await denied('reserve',{actor:a,descriptor:descriptor(item.pack)},'LEASE_FENCED');
 await good('fixture-drop',{action:'control'});await denied('reserve',{actor:b,descriptor:descriptor(item.pack)},'INJECTED_RESPONSE_LOSS');
 const pending=(await good('state')).slots.find(s=>s.allocation?.requestId===b.requestId&&s.allocation.leaseEpoch===2);
 ok(pending.journal.action==='init','replacement init journal remains after response loss');await restart();
 // Gate the durable init while two distinct processes retransmit this lease.
 await gateCall(null,'coordinator:before-send','arm');
 const reserveCalls=(await good('state')).reserveCalls;
 const first=client('reserve',{actor:b,descriptor:descriptor(item.pack)});await reached(null,'coordinator:before-send');
 const second=client('reserve',{actor:b,descriptor:descriptor(item.pack)});
 const deadline=Date.now()+10000;let observed;
 do{observed=(await good('state')).reserveCalls;if(observed>=reserveCalls+2)break;await wait(10);}while(Date.now()<deadline);
 ok(observed>=reserveCalls+2,'two process retransmissions overlap the same durable init');
 await denied('reserve',{actor:b,descriptor:{...descriptor(item.pack),builtAt:'2026-10-19T13:00:00.000Z'}},'ALLOCATION_EXISTS');
 await gateCall(null,'coordinator:before-send','release');const results=await Promise.all([first,second]);
 for(const result of results)assert.equal(result.status,200,JSON.stringify(result));
 ok(results[0].pid!==results[1].pid,'two reserve clients have distinct process IDs');assert.deepEqual(results[0].body.allocation,results[1].body.allocation);
 const replacement=results[0].body,ref=publicRef(replacement.allocation);
 ok(ref.slot===pending.slot&&ref.slotEpoch===pending.slotEpoch,'retransmissions reuse replacement allocation epoch');
 ok((await good('state')).slots.filter(s=>s.phase!=='FREE').length===2,'source and exactly one replacement occupy two slots');
 await send(b,replacement,item);await send(b,replacement,item);await verify(b,ref,item,false);await seal(b,ref);
 const sealed=(await good('state')).slots[ref.slot];await good('pair',{actor:b,ref,privateDescriptor:privateDescriptor(sealed)});await good('prepare',{actor:b,ref});
 for(const n of [203,204])await reserve(actor(n),item.pack);const fifth=actor(205);await grant(fifth);await denied('reserve',{actor:fifth,descriptor:descriptor(item.pack)},'NO_FREE_SLOT');
 const replayReplacement=async label=>{const again=await good('reserve',{actor:b,descriptor:descriptor(item.pack)});assert.deepEqual(again.allocation,replacement.allocation);receipt.asserts.push('review3 exact replacement Allocation '+label);await denied('reserve',{actor:b,descriptor:{...descriptor(item.pack),builtAt:'2026-10-19T13:00:00.000Z'}},'ALLOCATION_EXISTS');await denied('reserve',{actor:a,descriptor:descriptor(item.pack)},'LEASE_FENCED');};
 await good('release-source',{ref:source,replacement:ref});await replayReplacement('after releaseSource');
 await good('fixture-drop',{action:'control:retire'});await denied('retire',{ref:source},'INJECTED_RESPONSE_LOSS');await replayReplacement('lost retire response');await restart();await replayReplacement('retire pending after reboot');await good('retry',{slot:source.slot});
 await good('fixture-drop',{action:'control:gc'});await denied('gc',{ref:source},'INJECTED_RESPONSE_LOSS');await replayReplacement('lost GC response');await restart();await replayReplacement('GC pending after reboot');let gc;do{gc=await good('gc',{ref:source});await replayReplacement('GC progress or terminal');}while(!gc.done);
 await restart();await verify(b,ref,item);await denied('retire',{ref},'PROTECTED');await denied('status',{ref:source},'STALE_EPOCH');
 ok((await good('state')).slots[source.slot].phase==='FREE','source collected only after successor Pair and prepare');
 // Review3: reserve and freeze arrive in separate processes while slot init is
 // paused BEFORE its transaction. Only the test entry owns this scheduling.
 for(const loseFreeze of [false,true]){
  const producer=actor(loseFreeze?207:206);await grant(producer);
  const slot=source.slot,point='slot:init:before-commit';await gateCall(slot,point,'arm');
  const pendingReserve=client('reserve',{actor:producer,descriptor:descriptor(item.pack)});
  await reached(slot,point);const state=await good('state'),initializing=state.slots[slot],initCommand=initializing.journal,refInit=publicRef(initializing.allocation);
  const count=state.freezeCalls;if(loseFreeze)await good('fixture-drop',{action:'control:freeze'});
  const pendingFreeze=client('freeze',{actor:producer,ref:refInit});
  let observed=false;const end=Date.now()+10000;
  while(Date.now()<end){if((await good('state')).freezeCalls>count){observed=true;break;}await wait(10);}
  ok(observed,'review3 freeze entered while init-before-commit gate held');
  await gateCall(slot,point,'release');const [reserved,frozen]=await Promise.all([pendingReserve,pendingFreeze]);
  ok(reserved.pid!==frozen.pid,'review3 reserve/freeze clients are distinct processes');
  ok(reserved.status===200||['LEASE_FENCED','STALE_RECEIPT'].includes(reserved.body.error),'reserve result respects concurrent revocation');
  if(loseFreeze){ok(frozen.status===409&&frozen.body.error==='INJECTED_RESPONSE_LOSS','review3 freeze receipt lost after barrier commit');await restart();await good('freeze',{actor:producer,ref:refInit});}
  else ok(frozen.status===200,'review3 freeze completes in one call over init');
  const frozenState=(await good('state')).slots[slot];ok(frozenState.phase==='FROZEN','review3 barrier durable at coordinator');
  await denied('put',{actor:producer,ref:refInit,kind:'page',address:0,page:item.pack.pages[0]},'LEASE_FENCED');
  const {role,...oldProducer}=producer;await good('handoff',{ref:refInit,next:{...oldProducer,leaseEpoch:2,expiresAt:Date.now()+3600000}});await collect(refInit);
  // Reuse the physical slot, then challenge it with the old init command.
  const oldCommands=(await good('state')).commands.filter(c=>c.slot===slot&&c.slotEpoch===refInit.slotEpoch);
  const reader=actor(loseFreeze?217:216),fresh=await reserve(reader,item.pack),freshRef=await send(reader,fresh,item);await seal(reader,freshRef);
  for(const command of [initCommand,...oldCommands]){const stale=await call('fixture/control/'+slot,command);ok(stale.status===409&&['INIT_EPOCH','STALE_EPOCH'].includes(stale.body.error),'review3 old '+command.action+' rejected after epoch reuse');}
  await good('freeze',{actor:reader,ref:freshRef});const {role:ignored,...readLease}=reader;await good('handoff',{ref:freshRef,next:{...readLease,leaseEpoch:2,expiresAt:Date.now()+3600000}});
  await verify(b,freshRef,item);await verify(b,ref,item);
  // Retained source cleanup uses a valid higher-generation successor Pair;
  // use the next loop's free slot only after a complete replacement cycle.
  const successor={role:'build',...readLease,leaseEpoch:2};
  // The other two slots are incomplete placeholders from the four-slot check.
  const placeholder=(await good('state')).slots.find(x=>x.pending&&x.phase==='WRITING');
  await good('abandon',{actor:actor(Number(placeholder.allocation.runId)),ref:publicRef(placeholder.allocation)});await collect(publicRef(placeholder.allocation));
  const nextSlot=await good('reserve',{actor:successor,descriptor:descriptor(item.pack)}),nextRef=await send(successor,nextSlot,item);await seal(successor,nextRef);await good('pair',{actor:successor,ref:nextRef,privateDescriptor:privateDescriptor((await good('state')).slots[nextRef.slot])});
  await good('release-source',{ref:freshRef,replacement:nextRef});await collect(freshRef);
  await restart();await verify(successor,nextRef,item);await verify(b,ref,item);
 }

 if(flag('mutations')){receipt.mutations=[...await import('../test/upload-fixtures/storage-mutations.js').then(m=>m.runMutations()),...await import('../test/upload-fixtures/storage-recovery.js').then(m=>m.runRecoveryMutations())];ok(receipt.mutations.every(m=>m.detected),'all original and review3 controls detected in Node fixtures; not workerd mutation runs');}
 }else if(scenario==='recovery'){
 // Small real coordinator/slot regressions. Separate from the capacity proof.
 const item=await make('recovery',70,3500000),a=actor(101),s=await reserve(a,item.pack),ref=publicRef(s.allocation);
 await denied('seal',{actor:a,ref},'INCOMPLETE_PACK');ok((await good('state')).slots[ref.slot].phase==='WRITING','incomplete coordinator seal keeps writes open');await send(a,s,item);
 await good('seal',{actor:a,ref});await good('freeze',{actor:a,ref});await restart();const {role,...next}=a;await good('handoff',{ref,next:{...next,leaseEpoch:2,expiresAt:Date.now()+3600000}});await collect(ref);ok((await good('state')).slots[ref.slot].phase==='FREE','partial seal freeze survives restart and incomplete pack is collected');
 const b=actor(102),t=await reserve(b,item.pack),sealed=await send(b,t,item);
 // Two file pages followed by one chunk-descriptor page for this corpus.
 await good('seal',{actor:b,ref:sealed});await good('seal',{actor:b,ref:sealed});await good('fixture-drop',{action:'control'});await denied('seal',{actor:b,ref:sealed},'INJECTED_RESPONSE_LOSS');
 const remoteReceipt=(await good('status',{ref:sealed})).sealReceipt;ok(!!remoteReceipt,'lost final seal response left durable receipt at slot');
 await good('fixture-drop',{action:'control'});await denied('freeze',{actor:b,ref:sealed},'INJECTED_RESPONSE_LOSS');await restart();await good('retry',{slot:sealed.slot});const {role:ignored,...nextB}=b;await good('handoff',{ref:sealed,next:{...nextB,leaseEpoch:2,expiresAt:Date.now()+3600000}});
 const recovered=(await good('state')).slots[sealed.slot];ok(recovered.source&&recovered.sealReceipt.sha256===remoteReceipt.sha256,'freeze receipt restores exact sealed source after restart');await denied('retire',{ref:sealed},'PROTECTED');
 const reader=actor(103);await grant(reader);await verify(reader,sealed,item);ok((await good('manifest',{actor:reader,ref:sealed})).sealReceipt.sha256===remoteReceipt.sha256,'new lease reads source manifest');assert.deepEqual(await good('page',{actor:reader,ref:sealed,page:0}),item.pack.pages[0]);
 const c=actor(104),u=await reserve(c,item.pack),publicRefC=await send(c,u,item);await seal(c,publicRefC);await publish(c,publicRefC);
 await good('freeze',{actor:c,ref:publicRefC});const publicHead=await call('read',{ref:publicRefC,path:'files.json',head:true});ok(publicHead.status===200,'freeze preserves public HEAD');await verify(reader,publicRefC,item);
 // A third slot is incomplete; expiration must revoke without the expired actor.
 const d=actor(105),v=await reserve(d,item.pack),incomplete=publicRef(v.allocation);await good('fixture-expire',{requestId:d.requestId});await denied('freeze',{actor:d,ref:incomplete},'LEASE_FENCED');await good('fixture-revoke',{ref:incomplete});await collect(incomplete);
 await good('fixture-expire',{requestId:b.requestId});await good('fixture-revoke',{ref:sealed});await denied('retire',{ref:sealed},'PROTECTED');ok((await good('state')).slots[sealed.slot].source,'expiry keeps sealed source');
 const beforeRead=await good('metrics');
 await (await call('read',{ref:publicRefC,path:item.pack.files.find(f=>f.bytes===2100001).path})).arrayBuffer();await call('read',{ref:publicRefC,path:'files.json',head:true});await (await call('chunk',{actor:reader,ref:publicRefC,ordinal:0})).arrayBuffer();await good('status',{ref:publicRefC});await good('page',{actor:reader,ref:publicRefC,page:0});await good('manifest',{actor:reader,ref:publicRefC});
 const afterRead=await good('metrics'),beforeSlot=beforeRead.slots[publicRefC.slot],afterSlot=afterRead.slots[publicRefC.slot];ok(afterSlot.writes-beforeSlot.writes===7,'six read operations plus metrics write only seven fixture flush rows; zero production writes');
 let batch;for(let i=1000;i<47000;i+=128){batch=await good('fixture-leases',{start:i,count:128,expiresAt:Date.now()+3600000});if(batch.refused)break;}ok(batch.refused,'aggregate metadata admission is bounded');const repeat=await good('fixture-leases',{start:90000,count:128,expiresAt:Date.now()+3600000});ok(repeat.refused&&repeat.bytes===batch.bytes&&repeat.rows===batch.rows,'rejected grants leave metadata and row count unchanged');
 await good('fixture-clock',{now:Date.now()+7200000});let after=null,deleted=0;do{const result=await good('fixture-collect-leases',{after});deleted+=result.deleted;after=result.next;}while(after);ok(deleted>0,'terminal unreferenced leases collected in bounded pages');await good('status',{ref:sealed});await good('status',{ref:publicRefC});
 receipt.recoveryMutations=await import('../test/upload-fixtures/storage-recovery.js').then(m=>m.runRecoveryMutations());ok(receipt.recoveryMutations.every(m=>m.detected),'all restored recovery defects fail Node behavioral scenarios (separate from workerd asserts)');
 }else if(scenario==='protocol'){
 assert.equal(Number(option('clients',4)),4);assert.ok(flag('restart'));assert.ok(flag('mutations'));
 const pre=await make('freeze-prelude',70,3500000),a=actor(90);await grant(a);await good('fixture-drop',{action:'control'});await gateCall(null,'coordinator:before-send','arm');await gateCall(0,'slot:init:before-commit','arm');const initPending=call('reserve',{actor:a,descriptor:descriptor(pre.pack)});await reached(null,'coordinator:before-send');ok((await good('state')).slots[0].phase==='INIT','coordinator journals init before dispatch');await gateCall(null,'coordinator:before-send','release');await reached(0,'slot:init:before-commit');ok((await good('state')).slots[0].phase==='INIT','slot pause before commit keeps coordinator reservation occupied');await gateCall(0,'slot:init:before-commit','release');const initLost=await initPending;ok(initLost.status===409&&initLost.body.error==='INJECTED_RESPONSE_LOSS','slot commit response loss is observed as failure');let interrupted=(await good('state')).slots.find(s=>s.allocation?.requestId===a.requestId);ok(interrupted.phase==='INIT'&&interrupted.journal.action==='init','init journal persists while slot response is lost');ok((await good('status',{ref:publicRef(interrupted.allocation)})).phase==='WRITING','lost init response did commit at slot');await restart();await good('retry',{slot:interrupted.slot,actor:a});const s=(await good('state')).slots[interrupted.slot],ref=await send(a,s,pre);
 const point='slot:put:after-hash';await gateCall(ref.slot,point,'arm');const pending=client('put',{actor:a,ref,kind:'chunk',address:0},await readFile(pre.file).then(b=>b.subarray(0,262144)));await reached(ref.slot,point);await good('freeze',{actor:a,ref});await gateCall(ref.slot,point,'release');const fenced=await pending;ok(fenced.status===409&&fenced.body.error==='WRITE_FENCED','old PUT cannot mutate after freeze barrier');
 const {role,...next}=a;await good('handoff',{ref,next:{...next,leaseEpoch:2,expiresAt:Date.now()+100000}});await collect(ref);
 const corpus=await Promise.all([1,2,3,4].map(n=>make('protocol-'+n,70,3500000+n*17)));const actors=[1,2,3,4].map(actor);for(const a of actors)await grant(a);await good('fixture-drop',{action:'control'});
 const reservations=await Promise.all(actors.map((a,i)=>client('reserve',{actor:a,descriptor:descriptor(corpus[i].pack)})));for(const r of reservations)assert.equal(r.status,200,JSON.stringify(r));ok(new Set(reservations.map(r=>r.pid)).size===4,'four separate HTTP client processes reserve concurrently');ok(reservations.some(r=>r.recoveredResponseLoss),'init response loss recovered from journal');ok(new Set(reservations.map(r=>r.body.slot)).size===4,'four allocations occupy distinct slots');
 for(let i=0;i<4;i++){const a=actors[i],item=corpus[i],s=reservations[i].body,ref=await send(a,s,item);await denied('prepare',{actor:a,ref},'PAIR_INCOMPLETE');await verify(a,ref,item,false);await seal(a,ref);await publish(a,ref);initial.push({a,ref,item});}
 const fifth=actor(5);await grant(fifth);await denied('reserve',{actor:fifth,descriptor:descriptor(corpus[0].pack)},'NO_FREE_SLOT');receipt.beforeRestart=await good('metrics');await restart();
 for(const x of initial)await verify(x.a,x.ref,x.item);
 const state=await good('state');await denied('retire',{ref:state.pointers.active},'PROTECTED');
 const old=initial[0],pointRead='slot:read:before-pull';await gateCall(old.ref.slot,pointRead,'arm');const reading=client('read',{actor:old.a,ref:old.ref,path:old.item.pack.files.find(f=>f.bytes===2100001).path});await reached(old.ref.slot,pointRead);await good('retire',{ref:old.ref});const gc=await good('gc',{ref:old.ref});ok(!gc.done&&gc.waitingPins===1,'GC waits for slot-local stream pin');await gateCall(old.ref.slot,pointRead,'release');const read=await reading;ok(read.status===200&&read.body.sha256===old.item.pack.files.find(f=>f.bytes===2100001).sha256,'stream admitted before retire finishes byte-identical');
 let final;do{final=await good('gc',{ref:old.ref});}while(!final.done);const replacement=actor(8);const newer=await reserve(replacement,old.item.pack);ok(newer.slot===old.ref.slot&&newer.slotEpoch===old.ref.slotEpoch+1,'reinit increases epoch');await denied('status',{ref:old.ref},'STALE_EPOCH');
 receipt.mutations=await import('../test/upload-fixtures/storage-mutations.js').then(m=>m.runMutations());ok(receipt.mutations.every(m=>m.detected),'five removed guards each break an assertion; intact scenarios pass');
 }else{
 const files=Number(option('files',11129)),bytes=Number(option('bytes',499485732)),revisions=Number(option('revisions',4)),rounds=Number(option('reuse-rounds',2));assert.equal(revisions,4);assert.equal(rounds,2);assert.ok(flag('distinct-seeds'));
 for(let i=0;i<4;i++){const item=await make('capacity-initial-'+i,files,bytes),a=actor(i+1),s=await reserve(a,item.pack),ref=await send(a,s,item);await verify(a,ref,item,false);await seal(a,ref);await publish(a,ref);initial.push({a,ref,item});receipt.releases.push({seed:item.seed,ref,bytes:item.pack.packBytes,files:item.pack.fileCount,chunks:item.pack.chunkCount,packSha256:item.pack.packSha256});receipt['initialMetrics'+i]=await good('metrics');}
 ok(new Set(initial.map(x=>x.item.pack.packSha256)).size===4,'four initial seeds have distinct complete pack hashes');await restart();for(const x of initial)await verify(x.a,x.ref,x.item);
 const lastBySlot=new Map(initial.map(x=>[x.ref.slot,x]));
 for(let round=1;round<=rounds;round++)for(let slot=0;slot<4;slot++){const previous=lastBySlot.get(slot);await collect(previous.ref);const size=Math.floor(bytes*(round===1?0.63:0.83))+slot,seed=`capacity-reuse-${round}-${slot}`,item=await make(seed,files,size),a=actor(10+round*4+slot),s=await reserve(a,item.pack),ref=await send(a,s,item);ok(ref.slot===slot&&ref.slotEpoch===previous.ref.slotEpoch+1,'slot '+slot+' epoch increases on reuse '+round);await seal(a,ref);await publish(a,ref);await verify(a,ref,item);await denied('status',{ref:previous.ref},'STALE_EPOCH');lastBySlot.set(slot,{a,ref,item});const metrics=await good('metrics');receipt.releases.push({seed,ref,bytes:size,files,chunks:item.pack.chunkCount,packSha256:item.pack.packSha256,metrics});await rm(previous.item.file,{force:true});}
 }
 receipt.metrics=await good('metrics');const samples=[...(receipt.restartCheckpoints||[]),receipt.beforeRestart,...Object.entries(receipt).filter(([k])=>k.startsWith('initialMetrics')).map(([,v])=>v),...receipt.releases.map(r=>r.metrics),receipt.metrics].filter(Boolean);receipt.physicalPeaks={slots:[0,1,2,3].map(slot=>({slot,bytes:Math.max(...samples.map(m=>m.slots.find(s=>s.slot===slot)?.databaseSize||0))})),coordinator:Math.max(...samples.map(m=>m.coordinator.databaseSize||0)),total:Math.max(...samples.map(m=>m.coordinator.databaseSize+m.slots.reduce((n,s)=>n+s.databaseSize,0)))};receipt.status='PASS';
 }catch(e){receipt.status='FAIL';receipt.error={message:e.message,stack:e.stack};receipt.runtimeOutput=output;process.exitCode=1;}
 finally{await stop();receipt.finishedAt=new Date().toISOString();receipt.elapsedMs=Date.parse(receipt.finishedAt)-Date.parse(receipt.startedAt);receipt.http=http;receipt.wallLatencyMs=Object.fromEntries(Object.entries(timing).map(([k,vs])=>{vs.sort((a,b)=>a-b);return [k,{count:vs.length,p50:vs[Math.floor((vs.length-1)*.5)],p95:vs[Math.floor((vs.length-1)*.95)],p99:vs[Math.floor((vs.length-1)*.99)],max:vs.at(-1)}];}));receipt.harnessMemory=process.memoryUsage();await mkdir(dirname(receiptPath),{recursive:true});await writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n');await rm(temp,{recursive:true,force:true});console.log(JSON.stringify({status:receipt.status,receipt:receiptPath,asserts:receipt.asserts.length,error:receipt.error?.message}));}
}
