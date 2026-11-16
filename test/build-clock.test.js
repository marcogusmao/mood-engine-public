'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const SN=require('../lib/learning/snapshot'),F=require('../lib/learning/feedback'),UI=require('../web/feedback');
// 13/10/2026: build.js now catches a capture that throws (snapshot failed, publish goes on), so the fake can no longer stop the build by throwing from capture; it returns a dummy path and the build is stopped by readSources, the first call after the shadow block that is outside any try.
test('actual build shares one feedback and capture clock across São Paulo midnight',async()=>{
 const previousOffline=process.env.OFFLINE;process.env.OFFLINE='1';
 try{
 const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'build.js'),'utf8');
 let writes=0,network=0;
 const readonlyFS=new Proxy(fs,{get(target,name){if(['writeFileSync','mkdirSync','renameSync','rmSync','unlinkSync','appendFileSync','copyFileSync','cpSync','chmodSync'].includes(name))return ()=>{writes++;throw Error('Unexpected write');};return target[name];}});
 async function run(events,fixed){
  let result,reads=0,projectAt,finish,failure;const done=new Promise(resolve=>finish=resolve);
  class Clock extends Date{constructor(...args){super(...(args.length?args:[reads++===0?'2026-10-11T02:59:59.000Z':'2026-10-11T03:00:01.000Z']));}}
  const ctx={require:id=>id==='fs'?readonlyFS:id==='./lib/learning/snapshot'?{...SN,privateDir:x=>x,readFeedback:()=>SN.batch(events),capture:options=>{result=options;return '/never/written';},writePrivate:()=>{},readSources:()=>{throw Error('CAPTURED_IN_MEMORY');}}:id==='./lib/learning/feedback'?{...F,project:(events,at)=>{projectAt=at;return F.project(events,at);}}:require(id.startsWith('./')?path.join(root,id):id),__dirname:root,Date:Clock,URL,URLSearchParams,Buffer,setTimeout,clearTimeout,fetch:()=>{network++;throw Error('Unexpected network');},console:{log(){},error:x=>failure=x},process:{env:{...process.env,OFFLINE:'1',MOOD_DATE:'2026-10-10'},argv:[process.execPath,path.join(root,'build.js'),'--offline','--cache-only','--learning','shadow','--out',path.join(require('os').tmpdir(),'build-clock-out-never-written'),'--private-dir',path.join(root,'.context/clock-test'),...(fixed?['--captured-at',fixed]:[])],version:process.version,memoryUsage:()=>process.memoryUsage(),exit:()=>finish()}};
  vm.runInNewContext(source,ctx);await done;a(result,'build did not reach capture: '+failure);return {result,projectAt};
 }
 const empty=await run([]),target=empty.result.baseline.plan.board.find(r=>r.id==='short').items[0].id;
 const c=UI.createController({storage:{save:async()=>{}},uuid:()=>crypto.randomUUID(),clock:()=> '2026-10-10T20:00:00.000Z'});await c.record('not_tonight',target);
 const crossed=await run(c.events),replayed=await run(c.events,crossed.result.capturedAt);
 a.equal(crossed.projectAt,crossed.result.capturedAt);
 a.equal(crossed.result.date,"2026-10-10");
 a.equal(crossed.result.baseline.webData.generated,crossed.result.capturedAt);
 for(const row of crossed.result.inputs.history){a.equal(row.availableAt,crossed.result.capturedAt);if(row.rating!=null){a.equal(row.firstObservedAt,crossed.result.capturedAt);a.equal(row.ratingObservedAt,crossed.result.capturedAt);}}
 const contains=run=>run.result.baseline.plan.board.find(r=>r.id==='short').items.some(x=>x.id===target);
 a.equal(contains(crossed),false);a.equal(contains(replayed),contains(crossed));
 a.equal(crossed.result.baseline.rowCandidates.find(r=>r.id==='short').items.some(x=>x.filmId===target),false);
 a.equal(writes,0);a.equal(network,0);
 }finally{if(previousOffline===undefined)delete process.env.OFFLINE;else process.env.OFFLINE=previousOffline;}
});
