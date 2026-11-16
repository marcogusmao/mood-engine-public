'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),crypto=require('node:crypto'),UI=require('../web/feedback'),F=require('../lib/learning/feedback'),Selector=require('../web/selector');
test('one feedback projection per ranking preserves order with fifty expired Not tonight decisions',async()=>{
 const c=UI.createController({storage:{save:async()=>{}},uuid:()=>crypto.randomUUID(),clock:()=> '2026-10-10T12:00:00.000Z'});
 for(let i=1;i<=50;i++)await c.record('not_tonight','tt'+i);
 const projected=F.project(c.events,'2026-10-11T12:00:00.000Z');
 const data={today:'2026-10-11',tonight:[],rewatch:[],films:Array.from({length:577},(_,j)=>({i:'tt'+(j+1),t:j+1,lb:4,r:90,vc:1000,l:'en',f:{lift:1},ts:j/577,q:1}))};
 const state={mood:'lift',kind:'new',time:0,safe:.3,roll:0,skipped:new Set()};let projections=0;
 const feedback={state:()=>{projections++;return F.project(c.events,'2026-10-11T12:00:00.000Z');}};
 const html=fs.readFileSync(path.join(__dirname,'../web/index.html'),'utf8'),start=html.indexOf('  function rank()'),end=html.indexOf('\n\n',start);
 const ctx={DATA:data,state,feedback,MoodFeedback:F,MoodSelector:Selector,allowed:(x,mood,kind)=>F.eligible(feedback.state(),x.i,{moodId:mood,kind})};
 vm.runInNewContext(html.slice(start,end),ctx);
 const before=performance.now(),actual=ctx.rank(),durationMs=performance.now()-before;
 const expected=Selector.rank(data,state,{eligible:(x,mood,kind)=>F.eligible(projected,x.i,{moodId:mood,kind})});
 a.deepEqual(actual,expected);console.log(JSON.stringify({projectionCount:projections,candidates:data.films.length,expiredDecisions:50,durationMs:Math.round(durationMs)}));a.equal(projections,1,'ranking must project the history once, irrespective of candidate count');
});
