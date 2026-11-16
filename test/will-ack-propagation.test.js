'use strict';
// 21/10/2026 (Marco, lote 1 item 4, "the ack script repeats the checks for about 70 s"). Signature: before this change scripts/ack-will-publication.js read /api/v1/friend-a/publication and the live addon's manifest ONCE
// right after the acknowledgement and threw ACKED_PUBLIC_STATUS_MISMATCH / ACKED_LIVE_ADDON_MISMATCH if either still named the previous revision. The Worker keeps the pointer 60 s per isolate (S1) and the
// acknowledgement drops it only in the isolate that handled it, so any other isolate that had read the pointer in the last minute answered with the OLD revision, and on the nightly's `reconcile-will` job that
// failure skipped Marco's own night. Here a fake server answers the old revision for X seconds after the acknowledgement and then the new one, on a fake clock (nothing sleeps for real, nothing reads the network);
// the control is the single check of before (a stale server fails it) and a server that never converges (exit code 1 inside the limit).
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),F=require('../test-support/people/fixture'),PUB=require('../lib/people-publication');
const A=require('../scripts/ack-will-publication');
const ORIGIN='https://fixed.example',OLD='r-'+'0'.repeat(32);

function release(t){const f=F.fixture(t),dir=path.join(f.root,'release'),revision='r-'+'1'.repeat(32);const cfg={addon:{id:'com.mgusmao.moodengine.friend-a',name:'Mood Engine · Will',version:'1',description:'Synthetic'},personContext:{personId:'friend-a',revision}};const plan={board:[],discover:[]};const index=require('../lib/index-export').buildIndex({cfg,plan,today:'2026-10-14',builtAt:'2026-10-14T12:00:00.000Z'});require('../lib/publish').publish({outDir:dir,webDir:path.join(F.ROOT,'web'),cfg,plan,webData:{},index});const descriptor=PUB.stamp({dir,revision,codeSha:'a'.repeat(40),builtAt:'2026-10-14T12:00:00.000Z',history:F.history()});return {...f,dir,revision,descriptor:{...descriptor,codeSha:PUB.verifyRelease(dir).receipt.codeSha}};}

/**
 * A world on a fake clock. `oldFor(sinceAck)` says whether a reader sees the PREVIOUS revision at that many ms after the acknowledgement (true = old, 'down' = HTTP 503). The public status and the addon's manifest
 * follow it together unless `split` says otherwise. `reads` records the fake time (ms since the acknowledgement) of every read of the two routes.
 */
function world(f,{oldFor=()=>false,split=null}={}){
  const w={now:0,ackedAt:null,posts:0,reads:[],sleeps:[],pagesReads:0};
  w.clock=()=>w.now;w.sleep=async ms=>{w.sleeps.push(ms);w.now+=ms;};
  w.client={request:async(method,suffix)=>{if(method==='POST'){w.posts++;w.ackedAt=w.now;}return {schemaVersion:1,personId:'friend-a',acknowledged:true};}};
  const state=(route)=>{const since=w.ackedAt===null?-1:w.now-w.ackedAt;w.reads.push({route,since});const s=(split&&split[route])?split[route](since):oldFor(since);return s;};
  w.fetchImpl=async url=>{
    if(url===ORIGIN+'/api/v1/friend-a/publication'){const s=state('publication');if(s==='down')return new Response('',{status:503});return Response.json({personId:'friend-a',activePublication:{revision:s===true?OLD:f.revision}});}
    if(url===ORIGIN+'/u/friend-a/manifest.json'){const s=state('manifest');if(s==='down')return new Response('',{status:503});return Response.json({id:'com.mgusmao.moodengine.live.friend-a',types:['movie'],resources:['catalog']},{headers:{'X-Mood-Person':'friend-a','X-Mood-Revision':s===true?OLD:f.revision}});}
    if(url===A.PAGES+A.BASE)return new Response('shell');
    w.pagesReads++;const name=decodeURIComponent(new URL(url).pathname.split('/r/'+f.revision+'/')[1]);return new Response(fs.readFileSync(path.join(f.dir,name)));
  };
  w.options=(f,extra={})=>({client:w.client,origin:ORIGIN,descriptor:f.descriptor,reconcile:true,fetchImpl:w.fetchImpl,clock:w.clock,sleep:w.sleep,windowMs:0,...extra});
  return w;
}
const secondsOfReads=w=>[...new Set(w.reads.map(r=>r.since/1000))];

test('ack propagation: a server that answers the OLD revision for 45 s after the acknowledgement: the script waits for the 60 s, reads nothing before them, and finishes with 3 agreeing readings at 60, 65 and 70 s',async t=>{
  const f=release(t),w=world(f,{oldFor:since=>since<45000});
  const result=await A.acknowledge(w.options(f));
  a.deepEqual(result,{schemaVersion:1,personId:'friend-a',acknowledged:true});
  a.equal(w.posts,1,'one acknowledgement, however many readings');
  a(w.reads.every(r=>r.since>=60000),'nothing is read before the copies of the previous revision can have expired: '+secondsOfReads(w));
  a.deepEqual(secondsOfReads(w),[60,65,70]);
  a.equal(w.reads.length,6,'both checks in every round');
  a.equal(w.now-w.ackedAt,70000);
});

test('ack propagation: control, the single check of before: the same stale server fails it with ACKED_PUBLIC_STATUS_MISMATCH',async t=>{
  const f=release(t),w=world(f,{oldFor:since=>since<45000});
  await a.rejects(()=>A.acknowledge(w.options(f,{propagation:{settleMs:0,pollMs:0,consecutive:1,limitMs:0}})),/ACKED_NOT_CONVERGED.*ACKED_PUBLIC_STATUS_MISMATCH/s);
  const w2=world(f,{split:{publication:()=>false,manifest:since=>since<45000}});
  await a.rejects(()=>A.acknowledge(w2.options(f,{propagation:{settleMs:0,pollMs:0,consecutive:1,limitMs:0}})),/ACKED_LIVE_ADDON_MISMATCH/);
});

test('ack propagation: only the live addon stale (or only the public status) is also waited out; the count starts over at every disagreement',async t=>{
  const f=release(t);
  for(const route of ['publication','manifest']){
    const w=world(f,{split:{[route]:since=>since<80000}});
    await A.acknowledge(w.options(f));
    a.deepEqual(secondsOfReads(w).slice(-3),[80,85,90],`${route}: 80 s is the first agreeing round, then two more`);
    a.equal(w.now-w.ackedAt,90000);
  }
  const flap=world(f,{oldFor:since=>since>=65000&&since<75000}); // 60 new, 65 old, 70 old, 75 new, 80 new, 85 new
  await A.acknowledge(flap.options(f));
  a.deepEqual(secondsOfReads(flap),[60,65,70,75,80,85],'one agreeing reading and then two stale ones: the count restarts, 3 more are needed');
});

test('ack propagation: a failing read (HTTP 503) is a reading that does not agree; the script goes on and finishes when the server is back',async t=>{
  const f=release(t),w=world(f,{oldFor:since=>since<62000?'down':false});
  await A.acknowledge(w.options(f));
  a.deepEqual(secondsOfReads(w),[60,65,70,75],'60 s: down; 65, 70, 75: agree');
});

test('ack propagation: a server that never converges: ACKED_NOT_CONVERGED inside the limit (120 s after the acknowledgement), with the last reading in the message; the acknowledgement is not repeated',async t=>{
  const f=release(t),w=world(f,{oldFor:()=>true});
  await a.rejects(()=>A.acknowledge(w.options(f)),e=>{
    a.match(e.message,/^ACKED_NOT_CONVERGED: the acknowledgement of r-1{32} was accepted/);
    a.match(e.message,/within 120 s/);
    a.match(e.message,/last reading: ACKED_PUBLIC_STATUS_MISMATCH/);
    a.match(e.message,/not undone/);
    return true;
  });
  a.equal(w.posts,1);
  a(w.now-w.ackedAt<=120000,`gave up at ${(w.now-w.ackedAt)/1000} s`);
  a(w.now-w.ackedAt>=115000,`but not before it had tried until the limit: ${(w.now-w.ackedAt)/1000} s`);
  a.equal(secondsOfReads(w)[0],60);
  a(Math.max(...w.reads.map(r=>r.since))<120000,'no reading starts at or after the limit: '+secondsOfReads(w));
});

test('ack propagation: a server that converges just after the limit is not waited for further than the limit',async t=>{
  const f=release(t),w=world(f,{oldFor:since=>since<119000});
  await a.rejects(()=>A.acknowledge(w.options(f)),/ACKED_NOT_CONVERGED/);
  a(w.now-w.ackedAt<=120000);
});

test('ack propagation: --reconcile (reconcilePrepared) waits the same way, and a publication whose files are missing asks for replay without waiting at all',async t=>{
  const f=release(t),w=world(f,{oldFor:since=>since<50000});
  const done=await A.reconcilePrepared({...w.options(f),reconcile:undefined});
  a.deepEqual(done,{schemaVersion:1,personId:'friend-a',acknowledged:true});
  a.deepEqual(secondsOfReads(w),[60,65,70]);
  const never=world(f,{oldFor:()=>true});
  await a.rejects(()=>A.reconcilePrepared(never.options(f)),/ACKED_NOT_CONVERGED/);
  const missing=world(f);
  const replay=await A.reconcilePrepared({...missing.options(f),fetchImpl:async url=>url.endsWith('publication.json')?new Response('',{status:404}):missing.fetchImpl(url)});
  a.deepEqual(replay,{replayRequired:true});
  a.equal(missing.posts,0);a.deepEqual(missing.sleeps,[],'nothing waited');
});

test('ack propagation: the command line: exit code 0 and one JSON line when it converges; exit code 1 and ACKED_NOT_CONVERGED on stderr when it does not, inside the limit',async t=>{
  const f=release(t);
  const run=async(oldFor,args)=>{
    const w=world(f,{oldFor}),out=[],err=[],log=console.log,error=console.error;
    w.client.request=async(method,suffix)=>{if(method==='GET')return {publications:[f.descriptor]};w.posts++;w.ackedAt=w.now;return {acknowledged:true};};
    console.log=(...x)=>out.push(x.join(' '));console.error=(...x)=>err.push(x.join(' '));
    try{const code=await A.cli(args,{client:w.client,origin:ORIGIN,fetchImpl:w.fetchImpl,clock:w.clock,sleep:w.sleep,log:m=>err.push('log: '+m)});return {code,out,err,w};}
    finally{console.log=log;console.error=error;}
  };
  const ok=await run(since=>since<45000,[]);
  a.equal(ok.code,0);a.deepEqual(ok.out,['{"verified":1,"replayRequired":false}']);
  a(ok.err.some(l=>/waiting 60 s/.test(l)),'it says it is waiting');
  const reconcile=await run(since=>since<45000,['--reconcile']);
  a.equal(reconcile.code,0);a.deepEqual(reconcile.out,['{"verified":1,"replayRequired":false}']);
  for(const args of [[],['--reconcile']]){
    const bad=await run(()=>true,args);
    a.equal(bad.code,1,'exit code 1 '+args);a.deepEqual(bad.out,[]);
    a(bad.err.some(l=>/^ACKED_NOT_CONVERGED/.test(l)),'the message is on stderr');
    a(bad.w.now-bad.w.ackedAt<=120000,'inside the limit');
  }
});

test('ack propagation: the numbers: 60 s settle (at least the 60 s copy of the pointer in the Worker), a read every 5 s, 3 agreeing readings in a row, 120 s limit',async()=>{
  const {PUBLICATION_TTL_MS}=await import('../worker/src/upload/api.js');
  a.deepEqual(A.PROPAGATION,{settleMs:60000,pollMs:5000,consecutive:3,limitMs:120000});
  a(A.PROPAGATION.settleMs>=PUBLICATION_TTL_MS,'the script waits at least as long as the Worker keeps the pointer');
  a(A.PROPAGATION.settleMs+(A.PROPAGATION.consecutive-1)*A.PROPAGATION.pollMs<=A.PROPAGATION.limitMs,'three readings fit in the limit');
});

test('ack propagation: the real process: a run that fails ends with exit code 1 and the message on stderr (here with no Worker origin configured, so nothing touches the network)',()=>{
  const {spawnSync}=require('node:child_process'),env={...process.env};delete env.WILL_API_ORIGIN;
  const r=spawnSync(process.execPath,[path.join(__dirname,'../scripts/ack-will-publication.js')],{env,encoding:'utf8',timeout:20000});
  a.equal(r.status,1);a(r.stderr.trim().length>0,'a message');a.equal(r.stdout,'');
});
