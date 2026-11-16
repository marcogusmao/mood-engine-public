'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const UI=require('../web/feedback'),F=require('../lib/learning/feedback'),S=require('../lib/learning/schema'),Q=require('../lib/recommendation-quality'),RC=require('../lib/learning/row-candidates'),EV=require('../lib/learning/evaluate');
const html=fs.readFileSync(path.join(__dirname,'../web/index.html'),'utf8');
function fn(name,next){const start=html.indexOf('  function '+name+'(');return html.slice(start,html.indexOf('  '+next,start));}
for(const key of ['localStorage','indexedDB'])test('initialization survives refused '+key+' getter',async()=>{
 const ctx={owner:'mgusmao',sessionStorageKey:'mood-session',DATA:null,state:{},sessionStorage:{getItem:()=>crypto.randomUUID()},crypto,window:{indexedDB:null},MoodFeedbackUI:UI,refreshFeedback:()=>{},status:()=>{}};
 if(key==='localStorage')ctx.localStorage=null;
 else {ctx.localStorage={getItem:()=>null};Object.defineProperty(ctx.window,'indexedDB',{get(){throw Error('SecurityError');}});}
 const start=html.indexOf('  async function init(data)'),end=html.indexOf('    const refreshExpiry=',start);
 vm.createContext(ctx);if(key==='localStorage')vm.runInContext("Object.defineProperty(globalThis,'localStorage',{get(){throw Error('SecurityError');}})",ctx);vm.runInContext(html.slice(start,end)+'this.ready=true;}this.init=init;',ctx);
 await ctx.init({films:[],rewatch:[]});a.equal(ctx.ready,true);a.equal(ctx.feedback.saved,false);
});
test('failed storage history reports in-memory decisions',()=>{
 let markup='';const ctx={owner:'mgusmao',$:()=>({}),openPanel:(_,m)=>markup=m,feedback:{saved:false,state:()=>({active:[]})},MoodFeedback:F,DATA:{films:[],rewatch:[]}};
 vm.runInNewContext(fn('openHistory','function openFeedback'),ctx);ctx.openHistory();a.match(markup,/Not saved/);a(!markup.includes('Stored on this browser'));
 ctx.feedback.saved=true;ctx.openHistory();a.match(markup,/Stored on this browser/);
});
test('all generated Discover reasons name friend evidence without changing editorial items',()=>{
 const item={id:'tt1',why:['90 min','On your watchlist']},ratings=new Map([['tt1',{lb:null,fr:3.5,friend:'Fixture friend'}]]),plan={board:[{items:[item]}],discover:[{id:'mood-engine-quality',options:[{items:[item]}]},{id:'mood-engine-lists',options:[{items:[item]}]}]};
 Q.applyPlan(plan,ratings);a(plan.discover[0].options[0].items[0].why.some(text=>text.includes(Q.planReason(ratings.get('tt1')))));a.deepEqual(plan.discover[0].options[0].items[0].why,['90 min','On your watchlist · Fixture friend 3.5★']); // Marco, 13/10/2026: the friend is 'name 3.5★', not 'rated it … on Letterboxd'
 a.deepEqual(item.why,['90 min','On your watchlist']);a.equal(plan.discover[1].options[0].items[0],item);
});
test('visible four reasons include friend quality with rewatch pin watchlist and legacy reasons',()=>{
 const why='Fixture friend rated it 3.5★ on Letterboxd',ctx={state:{mood:'lift',kind:'rewatch'},STARS:n=>String(n),MONTH:x=>x};
 vm.runInNewContext(fn('reasons','function render'),ctx);const reasons=ctx.reasons({rating:4,last:'2020-01-01',pins:['lift'],w:true,why:['Legacy one','Legacy two',why],lb:null,fr:3.5});a.equal(reasons.length,4);a(reasons.includes(why));
});
const film={imdb:'tt1',id:1,title:'Synthetic',genres:['A'],countries:['BR'],directors:[],year:2000,runtime:90,va:8,vc:100};
test('shadow selection and replay use capture clock, excluding future feedback and expiring at midnight',async()=>{
 let now='2026-10-10T20:00:00.000Z';const c=UI.createController({storage:{save:async()=>{}},uuid:()=>crypto.randomUUID(),clock:()=>now});
 await c.record('not_for_me','tt1');now='2026-10-10T22:00:00.000Z';await c.record('undo','tt1',{}, {targetEventId:c.events[0].eventId});
 const cfg={moods:[],build:{directors:0},sizes:{row:1},shortRow:{minMinutes:40,maxMinutes:95}},candidates=[{filmId:'tt1',film,sources:[]}],plan={board:[{id:'short',items:[]}],discover:[]};
 const rows=RC.freezeRows(candidates,[],cfg,'2026-10-10',c.events,plan.board,null,'2026-10-10T21:00:00.000Z');a.equal(rows[0].items.length,0);
 const snap={manifest:{effectiveDate:'2026-10-10',capturedAt:'2026-10-10T21:00:00.000Z'},bodies:{'baseline.json':{data:{plan,rowCandidates:rows}},'candidates.json':{records:candidates},'inputs.json':{sources:{'config.json':cfg},normalized:{history:[]}},'feedback.json':{events:c.events}}};a.equal(EV.shadowRows(snap).status,'evaluated');
 const d=UI.createController({storage:{save:async()=>{}},uuid:()=>crypto.randomUUID(),clock:()=> '2026-10-10T20:00:00.000Z'});await d.record('not_tonight','tt1');
 a.equal(RC.freezeRows(candidates,[],cfg,'2026-10-10',d.events,plan.board,null,'2026-10-11T03:00:00.000Z')[0].items.length,1);
});
test('adapter acknowledgement decisions are complete unique and drawn from the sent batch',async()=>{
 const responses=[()=>({acceptedEventIds:[],rejected:[]}),()=>({acceptedEventIds:[crypto.randomUUID()],rejected:[]}),id=>({acceptedEventIds:[id,id],rejected:[]}),id=>({acceptedEventIds:[id],rejected:[{eventId:id,code:'refused'}]}),id=>({acceptedEventIds:[],rejected:[{eventId:id,code:''}]})];
 for(const response of responses){let reads=0;const c=UI.createController({storage:{save:async()=>{}},uuid:()=>crypto.randomUUID(),clock:()=> '2026-10-10T20:00:00.000Z',hash:async x=>S.hash(x),adapter:{sendBatch:async b=>response(b.events[0].eventId),readSince:async()=>{reads++;return {events:[],candidateSets:[],nextCursor:null};}}});await c.record('not_for_me','tt1');await a.rejects(c.sync(),/acknowledgement/);a.equal(reads,0);}
 const c=UI.createController({storage:{save:async()=>{}},uuid:()=>crypto.randomUUID(),clock:()=> '2026-10-10T20:00:00.000Z',hash:async x=>S.hash(x),adapter:{sendBatch:async b=>({acceptedEventIds:[],rejected:b.events.map(e=>({eventId:e.eventId,code:'refused'}))}),readSince:async()=>({events:[],candidateSets:[],nextCursor:null})}});await c.record('not_for_me','tt1');a.equal((await c.sync()).status,'partial');
});
test('actual preview handler refuses sibling private paths symlinks and malformed URI',()=>{
 let handler,host;const bodies={'/fixture/docs/index.html':'public','/fixture/docs-private/experience.json':'private','/fixture/docs/link.json':'private'};
 const fakeFS={lstatSync:p=>({isSymbolicLink:()=>p.endsWith("link.json")}),existsSync:p=>p in bodies||p==='/fixture/docs',statSync:p=>({isDirectory:()=>p==='/fixture/docs'}),realpathSync:p=>p==='/fixture/docs/link.json'?'/fixture/docs-private/experience.json':p,createReadStream:p=>({pipe:res=>res.end(bodies[p])})};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../serve.js'),'utf8'),{require:id=>id==='http'?{createServer:fn=>{handler=fn;return {listen:(port,h)=>{host=h;}};}}:id==='fs'?fakeFS:path,__dirname:'/fixture',process:{env:{}},console});
 const request=url=>{const out={setHeader(){},writeHead(code){this.code=code;},end(body){this.body=body;}};handler({url},out);return out;};
 a.equal(request('/').code,200);for(const url of ['/%2e%2e/docs-private/experience.json','/link.json','/%E0%A4%A','/%00']){const out=request(url);a.notEqual(out.code,200,url);a.notEqual(out.body,'private');}a.equal(host,'127.0.0.1');
});
