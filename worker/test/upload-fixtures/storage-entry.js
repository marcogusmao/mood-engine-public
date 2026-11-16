import {ReleaseCoordinator} from '../../src/upload/release-coordinator.js';
import {createWillReleaseClass} from '../../src/upload/release-storage.js';
import {check,canonical} from '../../src/upload/storage-contract.js';
// Local-only scheduling: gates are addressed to the object which owns the await.
class Gates {
 constructor(){this.gates=new Map();}
 configure({point,action}){if(action==='arm'){check(!this.gates.has(point),'GATE_EXISTS');let release;const promise=new Promise(r=>release=r);const gate={promise,release,entered:0,timedOut:false};gate.timer=setTimeout(()=>{gate.timedOut=true;release();},15000);this.gates.set(point,gate);}if(action==='release'){clearTimeout(this.gates.get(point)?.timer);this.gates.get(point)?.release();this.gates.delete(point);}return this.status();}
 status(){return Object.fromEntries([...this.gates].map(([p,g])=>[p,g.entered]));}
 async pause(point){const g=this.gates.get(point);if(g){g.entered++;await g.promise;check(!g.timedOut,'GATE_TIMEOUT');}}
}
const Base=createWillReleaseClass({meterOptions:{persistent:true},pause:(point,instance)=>instance.gates.pause(point)});
export class WillRelease extends Base {
 constructor(ctx,env){super(ctx,env);this.gates=new Gates();this.loseInit=false;this.inFlight=[];}
 async fetch(req){
  const path=new URL(req.url).pathname;
  if(path==='/fixture-gate'){
   const body=await req.json();
   if(body.action==='lose-init-transport'){this.loseInit=true;return Response.json({armed:true});}
   if(body.action==='in-flight')return Response.json(this.inFlight);
   return Response.json(body.action?this.gates.configure(body):this.gates.status());
  }
  if(path==='/control'&&this.loseInit&&(await req.clone().json()).action==='init'){
   this.loseInit=false;const record={completed:false};this.inFlight.push(record);
   // The received execution survives the deliberately failed transport response.
   // This is BEFORE commit, not the older loss-after-commit fixture.
   const pending=super.fetch(req);
   this.ctx.waitUntil(pending.then(async res=>{record.status=res.status;record.body=await res.json();record.completed=true;}).finally(()=>this.m.flush()));
   const end=Date.now()+10000;
   while(!(this.gates.status()['slot:init:before-commit']>0)){
    check(Date.now()<end,'GATE_TIMEOUT');await new Promise(r=>setTimeout(r,5));
   }
   return Response.json({error:'INJECTED_TRANSPORT_LOSS_WITH_SLOT_IN_FLIGHT'},{status:409});
  }
  try{return await super.fetch(req);}finally{this.m.flush();}
 }
}
export class ProofState {
 constructor(ctx,env){this.gates=new Gates();this.drops=new Set();this.counts={};this.commands=[];const namespace={idFromName:n=>env.RELEASES.idFromName(n),get:id=>({fetch:async req=>{const action=new URL(req.url).pathname.slice(1);this.counts[action]=(this.counts[action]||0)+1;this.c.q('INSERT INTO proof_calls VALUES (?,?,1) ON CONFLICT(object,action) DO UPDATE SET n=n+1',String(id),action);const command=action==='control'?await req.clone().json():null,commandAction=command?.action;if(command&&commandAction!=='status'){this.commands.push(command);if(this.commands.length>32)this.commands.shift();}const res=await env.RELEASES.get(id).fetch(req);if(this.drops.delete(action)||this.drops.delete(action+':'+commandAction))throw Error('INJECTED_RESPONSE_LOSS');return res;}})};this.coordinatorOptions={storage:ctx.storage,meterOptions:{persistent:true},namespace,pause:p=>this.gates.pause(p)};this.c=new ReleaseCoordinator(this.coordinatorOptions);this.c.q('CREATE TABLE IF NOT EXISTS proof_calls (object TEXT, action TEXT, n INTEGER, PRIMARY KEY(object,action)) WITHOUT ROWID');}
 async fetch(req){const action=new URL(req.url).pathname.slice(1);try{this.c.q('INSERT INTO proof_calls VALUES (?,?,1) ON CONFLICT(object,action) DO UPDATE SET n=n+1','coordinator',action);const b=req.headers.has('X-Fixture-DTO')?{...JSON.parse(req.headers.get('X-Fixture-DTO')),bytes:new Uint8Array(await req.arrayBuffer())}:await req.json(),c=this.c;let out;
 if(action==='fixture-gate')out=b.action?this.gates.configure(b):this.gates.status();
 else if(action==='fixture-rebuild-coordinator'){c.m.flush();this.c=new ReleaseCoordinator(this.coordinatorOptions);out={rebuilt:true,scope:'coordinator only; slot execution remains live'};}
 else if(action==='fixture-drop'){this.drops.add(b.action);out={armed:true};}
 else if(action==='grant')out=c.grant(b.lease);
 else if(action==='reserve')out=await c.reserve(b.actor,b.descriptor);
 else if(action==='put'){const s=c.target(b.ref);out=await c.write(b.actor,b.ref,b.kind,b.address,b.kind==='chunk'?new Uint8Array(b.bytes):b.page);}
 else if(action==='fixture-clock'){c.now=()=>b.now;out={now:c.now()};}
 else if(action==='fixture-leases'){check(Number.isInteger(b.start)&&Number.isInteger(b.count)&&b.count>=1&&b.count<=128);let admitted=0,refused=false;for(let i=b.start;i<b.start+b.count;i++){try{c.grant({requestId:'bulk-'+i,generation:1,leaseEpoch:1,runId:String(i),runAttempt:'1',codeSha:'e'.repeat(40),expiresAt:b.expiresAt});admitted++;}catch(e){if(e.message!=='METADATA_BOUNDS')throw e;refused=true;break;}}out={admitted,refused,bytes:c.q('SELECT bytes FROM release_metadata WHERE id=1')[0].bytes,rows:c.q('SELECT COUNT(*) AS n FROM release_leases')[0].n};}
 else if(action==='fixture-expire'){c.tx(()=>{const l=c.lease(b.requestId);l.expiresAt=1;c.saveLease(l);});out={expired:true};}
 else if(action==='fixture-revoke')out=await c.revokeExpired(b.ref);
 else if(action==='fixture-collect-leases')out=c.collectLeases(b.after);
 else if(action==='page')out=await c.page(b.actor,b.ref,b.page);
 else if(action==='manifest')out=await c.manifest(b.actor,b.ref);
 else if(action==='chunk')out=await c.chunk(b.actor,b.ref,b.ordinal);
 else if(action==='read')out=await c.read(b.ref,b.path,b.head,b.actor);
 else if(action==='seal')out=await c.seal(b.actor,b.ref);
 else if(action==='pair')out=await c.commitPair(b.actor,b.ref,b.privateDescriptor);
 else if(action==='prepare')out=await c.prepare(b.actor,b.ref);
 else if(action==='promote')out=await c.promote(b.actor,b.ref);
 else if(action==='freeze')out=await c.freeze(b.actor,b.ref);
 else if(action==='handoff')out=c.handoff(b.ref,b.next);
 else if(action==='abandon')out=c.abandon(b.actor,b.ref);
 else if(action==='release-source')out=c.releaseSource(b.ref,b.replacement);
 else if(action==='retire')out=await c.retire(b.ref);
 else if(action==='gc')out=await c.gc(b.ref);
 else if(action==='retry')out=await c.drive(b.slot,b.actor);
 else if(action==='status')out=await c.status(b.ref);
 else if(action==='state')out={slots:c.slots(),pointers:c.pointers(),counts:this.counts,commands:this.commands,freezeCalls:c.q("SELECT n FROM proof_calls WHERE object='coordinator' AND action='freeze'")[0]?.n||0,reserveCalls:c.q("SELECT n FROM proof_calls WHERE object='coordinator' AND action='reserve'")[0]?.n||0};
 else if(action==='metrics'){const result=await c.metrics(),calls=c.q('SELECT * FROM proof_calls ORDER BY object,action');out={...result,calls,coordinator:c.m.snapshot()};}
 else throw Error('UNKNOWN_ACTION');return out instanceof Response?out:Response.json(out??null);
 }catch(e){return Response.json({error:e.message},{status:409});}finally{this.c.m.flush();}}
}
export default {async fetch(req,env){const u=new URL(req.url);if(u.pathname==='/fixture/health')return new Response('local v2 synthetic proof only');if(u.pathname.startsWith('/fixture/control/')){const slot=Number(u.pathname.split('/')[3]);check(Number.isInteger(slot)&&slot>=0&&slot<4);return env.RELEASES.get(env.RELEASES.idFromName(`friend-a-public-slot-${slot}`)).fetch(new Request('https://fixture/control',req));}if(u.pathname.startsWith('/fixture/slot/')){const slot=Number(u.pathname.split('/')[3]);check(Number.isInteger(slot)&&slot>=0&&slot<4);return env.RELEASES.get(env.RELEASES.idFromName(`friend-a-public-slot-${slot}`)).fetch(new Request('https://fixture/fixture-gate',req));}
 // No client-supplied internal operation headers are forwarded.
 return env.PROOF.get(env.PROOF.idFromName('coordinator')).fetch(new Request('https://fixture'+u.pathname,{method:'POST',headers:req.headers.has('X-Fixture-DTO')?{'X-Fixture-DTO':req.headers.get('X-Fixture-DTO')}:{},body:req.body,duplex:'half'}));}};
