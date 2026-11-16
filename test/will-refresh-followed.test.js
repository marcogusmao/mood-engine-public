'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const R=require('../lib/person-refresh'),W=require('../test-support/will-refresh-fixtures'),F=require('../test-support/people/fixture');
const at='2026-10-14T12:00:00.000Z',clock=()=>Date.parse(at),person=user=>({user,name:user});
const prior={subjectUser:'friend_a',name:'Friend',films:[['nosferatu-2024','Nosferatu',2024,5],['old-film','Old',2000,4]],watchlist:[['old-film','Old',2000]],filmsAt:at,watchlistAt:at,filmsPartial:false,watchlistPartial:false,rss:[['old-film','Old',2000,4,'2026-01-01']]};
const cache=()=>({version:1,following:{user:'friend-a',users:[['friend_a','Friend']]},users:{friend_a:structuredClone(prior)},films:{},lists:{}});
function transport(handler,limits={}){const urls=[];const http=R.boundedHttp({clock,limits,http:{get:async url=>{urls.push(url);return {status:200,url,text:'',...await handler(url)};}}});return {http,urls};}
async function run(c,t,options={}){return R.acquireFollowed(c,{following:[person('friend_a')],http:t.http,capturedAt:at,clock,maxMetadata:0,...options});}
test('followed complete traversal changes rating and removes absent watched/watchlist rows in its own account',async()=>{
 const t=transport(url=>({text:url.includes('/watchlist/')?W.watchlist():W.films({unrated:true})}));
 const c=cache();c.users.friend_b={subjectUser:'friend_b',films:[['old-film','Other',2000,1]]};
 const out=await run(c,t);
 a.equal(out.users.friend_a.films.find(r=>r[0]==='nosferatu-2024')[3],null);
 a.equal(out.users.friend_a.films.some(r=>r[0]==='old-film'),false);
 a.equal(out.users.friend_a.watchlist.some(r=>r[0]==='old-film'),false);
 a.deepEqual(out.users.friend_a.rss,prior.rss);a.deepEqual(out.users.friend_b,c.users.friend_b);
 a.equal(out.users.friend_a.coverage.films.state,'complete');
 a.equal(out.users.friend_a.identities['https://boxd.it/f5eG'].canonicalUri,'https://letterboxd.com/film/nosferatu-2024/');
 a.deepEqual(c.users.friend_a,prior);a.ok(t.urls.every(u=>u.includes('/friend_a/')));
});
test('followed partial traversal adds proven films but keeps prior ratings, watched and watchlist',async()=>{
 const t=transport(url=>({status:url.includes('/page/2/')?404:200,text:url.includes('/watchlist/')?W.watchlist({next:'/friend_a/watchlist/page/2/'}):W.films({unrated:true,next:'/friend_a/films/page/2/'})}));
 const out=await run(cache(),t),u=out.users.friend_a;
 a.equal(u.films.find(r=>r[0]==='nosferatu-2024')[3],5);a.ok(u.films.some(r=>r[0]==='old-film'));
 a.ok(u.watchlist.some(r=>r[0]==='old-film'));a.ok(u.watchlist.some(r=>r[0]==='local-hero'));
 a.equal(u.filmsAt,at);a.equal(u.watchlistAt,at);a.equal(u.filmsPartial,true);
});
test('wrong subject/redirect never imports someone else; unavailable preserves exact previous snapshot',async()=>{
 const t=transport(()=>({url:'https://letterboxd.com/mgusmao/films/',text:W.films()}));
 const out=await run(cache(),t);a.deepEqual(out.users.friend_a,prior);
 const r=R.envelope({dataset:'watched',subjectUser:'friend_b',items:[]});
 a.throws(()=>R.mergeAccount(prior,r,'friend_a'),/subject/);
 a.throws(()=>R.merge(F.history(),r),/owner/);
});
test('403, 429 and challenge stop the whole run and preserve unvisited accounts',async()=>{
 for(const kind of [403,429,'challenge']){
  const c=cache();c.users.friend_b={subjectUser:'friend_b',films:[['other','Other',2000,2]]};
  const t=transport(()=>({status:typeof kind==='number'?kind:200,text:kind==='challenge'?'challenge-platform':''}));
  const out=await run(c,t,{following:[person('friend_a'),person('friend_b')]});
  a.equal(t.urls.length,1);a.deepEqual(out.users,c.users);a.equal(out.followedAcquisition.stopped,'SOURCE_STOP');a.equal(out.followedAcquisition.remaining,1);
 }
});
test('request/page/account/time budgets are finite and partial data never permits removal',async()=>{
 const t=transport(url=>({text:W.films({next:'/friend_a/films/page/2/'})}),{maxRequests:1});
 const out=await run(cache(),t);a.equal(t.urls.length,1);a.equal(out.followedAcquisition.stopped,'RUN_BUDGET');a.ok(out.users.friend_a.films.some(r=>r[0]==='old-film'));
 const capped=transport(url=>({text:url.includes('watchlist')?W.watchlist({next:'/friend_a/watchlist/page/2/'}):W.films({next:'/friend_a/films/page/2/'})}));
 const pageOut=await run(cache(),capped,{maxPages:1,maxAccounts:1,following:[person('friend_a'),person('friend_b')]});
 a.equal(capped.urls.length,2);a.equal(pageOut.followedAcquisition.remaining,1);a.ok(pageOut.users.friend_a.watchlist.some(r=>r[0]==='old-film'));
 let time=Date.parse(at),calls=0;
 const timed=R.boundedHttp({clock:()=>time,limits:{maxMs:10},http:{get:async url=>{calls++;time+=11;return {status:200,url,text:W.films()};}}});
 await a.rejects(timed.get('https://letterboxd.com/friend_a/films/'),/BUDGET/);
 await a.rejects(timed.get('https://letterboxd.com/friend_b/films/'),/BUDGET/);a.equal(calls,1);
 const timeout=R.boundedHttp({limits:{requestMs:5},http:{get:()=>new Promise(()=>{})}});
 await a.rejects(timeout.get('https://letterboxd.com/friend_a/films/'),/TIMEOUT/);a.equal(timeout.state().requests,1);
});
test('exact count and terminal evidence gate removals, including proved empty; unknown empty remains unavailable',()=>{
 const cases=[{expectedCount:0,terminalPage:false,emptyConfirmed:true},{expectedCount:0,terminalPage:true},{expectedCount:1,terminalPage:true,emptyConfirmed:true},{expectedCount:0,terminalPage:true,emptyConfirmed:true,capped:true}];
 for(const evidence of cases){const r=R.envelope({dataset:'watchlist',subjectUser:'friend_a',items:[],...evidence});a.deepEqual(R.mergeAccount(prior,r,'friend_a'),prior);}
 const r=R.envelope({dataset:'watchlist',subjectUser:'friend_a',items:[],expectedCount:0,terminalPage:true,emptyConfirmed:true,completedAt:at});
 a.deepEqual(R.mergeAccount(prior,r,'friend_a').watchlist,[]);
});
test('metadata comes only from the requested explicit slug and matching final URL',async()=>{
 const metadata=fs.readFileSync(path.join(__dirname,'fixtures/film-with-imdb.html'),'utf8');
 // Controlled URI for the recorded metadata fixture; no claim that Nosferatu has its IMDb id.
 const filmGrid=W.films().replaceAll('nosferatu-2024','fixture-film');
 const t=transport(url=>url.includes('/film/')?{text:metadata}:{text:url.includes('watchlist')?W.watchlist():filmGrid});
 const out=await run({users:{},films:{}},t,{maxMetadata:1});
 a.equal(out.films['fixture-film'].imdbId,'tt21914684');
 a.equal(out.users.friend_a.rss,undefined);
 const wrong=transport(url=>url.includes('/film/')?{url:'https://letterboxd.com/film/other/',text:metadata}:{text:W.films()});
 a.deepEqual((await run({users:{},films:{}},wrong,{maxMetadata:1})).films,{});
 const conflict=transport(url=>url.includes('/film/')?{text:metadata+'<link href="https://letterboxd.com/film/other/" rel="canonical">'}:{text:filmGrid});
 a.deepEqual((await run({users:{},films:{}},conflict,{maxMetadata:1})).films,{});
});
test('update acquires followed accounts before persistence and never reads shared Marco users',async t=>{
 const f=F.fixture(t),dir=f.privateDir,write=(name,value)=>f.write(path.relative(f.root,path.join(dir,name)),value);
 write('history.json',F.history({following:[person('friend_a')]}));
 f.write('cache/friends.json',{users:{friend_a:{films:[['marco-only','Private',2000,5]],rss:['Marco']}},films:{}});
 const urls=[];
 await require('../scripts/update-person').update({root:f.root,privateDir:dir,capturedAt:at,clock,limits:{maxMetadata:0},collectors:{},http:{get:async url=>{urls.push(url);return {status:200,url,text:url.includes('watchlist')?W.watchlist():W.films()};}}});
 const out=JSON.parse(fs.readFileSync(path.join(dir,'cache/friends.json')));
 a.equal(urls.length,2);a.ok(out.users.friend_a.films.length>0);a.equal(out.users.friend_a.films.some(r=>r[0]==='marco-only'),false);a.equal(out.users.friend_a.rss,undefined);a.equal(out.users.friend_a.subjectUser,'friend_a');
});
test('default update uses one bounded transport for Will and followed acquisition before saving snapshot inputs',async t=>{
 const f=F.fixture(t),dir=f.privateDir;
 f.write(path.relative(f.root,path.join(dir,'history.json')),F.history({following:[person('friend_a')]}));
 const urls=[];
 await require('../scripts/update-person').update({root:f.root,privateDir:dir,capturedAt:at,clock,limits:{maxMetadata:0,maxAccounts:1},http:{get:async url=>{
  urls.push(url);const user=new URL(url).pathname.split('/')[1];
  return {status:200,url,text:url.includes('/following/')?W.following():url.includes('/watchlist/')?W.watchlist({user}):W.films()};
 }}});
 const out=JSON.parse(fs.readFileSync(path.join(dir,'cache/friends.json'))),history=JSON.parse(fs.readFileSync(path.join(dir,'history.json')));
 a.equal(out.users.friend_a.coverage.films.state,'complete');a.equal(out.followedAcquisition.requests,5);
 a.equal(history.coverage.following.state,'stale');a.equal(out.followedAcquisition.remaining,3);
 a.deepEqual(urls.map(u=>new URL(u).pathname),['/friend-a/films/','/friend-a/watchlist/','/friend-a/following/','/friend_a/films/','/friend_a/watchlist/']);
});
test('terminal films count mismatch and duplicate pages preserve previous account ratings and membership',async()=>{
 for(const mode of ['count','duplicate']){
  const t=transport(url=>({text:url.includes('watchlist')?W.watchlist({next:'/friend_a/watchlist/page/2/'}):mode==='count'?W.films({unrated:true}).replace(/(title=")[0-9]+&nbsp;films/, '$1999&nbsp;films'):W.films({unrated:true,next:url.includes('/page/2/')?null:'/friend_a/films/page/2/'})}));
  const out=await run(cache(),t);
  a.equal(out.users.friend_a.films.find(r=>r[0]==='nosferatu-2024')[3],5,mode);
  a.ok(out.users.friend_a.films.some(r=>r[0]==='old-film'),mode);
  a.ok(out.users.friend_a.watchlist.some(r=>r[0]==='old-film'),mode);
 }
});
