'use strict';
const test=require('node:test'),a=require('node:assert/strict'),R=require('../lib/person-refresh'),F=require('../test-support/people/fixture');
const at='2026-10-14T12:00:00.000Z',item={uri:'https://boxd.it/a',title:'Film',year:2000,date:null,rating:4};
const film=({rating,...r})=>r;
const session=r=>({...r,watchedDate:r.date,rewatch:false});
test('only terminal exact count or proved empty removes old export values',()=>{const h=F.history({ratings:[item],likes:[film(item)],watchlist:[film(item)]});for(const dataset of ['ratings','likes','watchlist']){for(const evidence of [{expectedCount:1,terminalPage:true},{expectedCount:0,terminalPage:false},{expectedCount:0,terminalPage:true,capped:true},{expectedCount:0,terminalPage:true,repeatedPage:true}]){const result=R.envelope({dataset,items:[],startedAt:at,completedAt:at,...evidence});a.deepEqual(R.merge(h,result)[dataset],h[dataset]);}const empty=R.envelope({dataset,expectedCount:0,terminalPage:true,emptyConfirmed:true,startedAt:at,completedAt:at});const next=R.merge(h,empty);a.deepEqual(next[dataset],[]);a.deepEqual(R.merge(next,R.envelope({dataset,startedAt:at}))[dataset],[]);}});
test('failed reads retain last complete date and public identity is checked',()=>{const h=F.history();h.coverage.likes.completedAt='2026-10-01T12:00:00.000Z';const result=R.envelope({dataset:'likes',startedAt:at});a.equal(R.merge(h,result).coverage.likes.completedAt,h.coverage.likes.completedAt);a.throws(()=>R.merge(h,{...result,personId:'marco'}),/owner/);});
test('traversal refuses page cap, cycle, second page 404 and invalid destination',async()=>{for(const mode of ['cycle','404','escape','cap']){let calls=0;const r=await R.traverse({dataset:'watchlist',startedAt:new Date().toISOString(),completedAt:at,maxPages:mode==='cap'?1:300,http:async()=>({status:mode==='404'&&calls++?404:200,text:'fixture'}),parse:()=>({expectedCount:2,items:[item],next:mode==='escape'?'https://example.com':'/friend-a/watchlist/'})});a.notEqual(r.state,'complete');}});
test('unverified likes/diary preserve the export and never claim live coverage',async()=>{const h=F.history({likes:[film(item)],diary:[session({...item,entryId:'zip:0'})]});const next=await R.refresh(h,{capturedAt:at});a.deepEqual(next.likes,h.likes);a.deepEqual(next.diary,h.diary);a.equal(next.coverage.likes.state,'stale');});
test('unavailable refresh preserves every diary session, including rewatches and aliases',async()=>{
 const diary=[{...item,date:'2024-01-02',entryId:'zip:0'},{...item,date:'2025-02-03',entryId:'zip:1'},{...item,uri:'https://letterboxd.com/film/film/',date:'2026-03-04',entryId:'zip:2'}].map(session);
 const h=F.history({diary});h.coverage.diary.completedAt=at;
 for(const collectors of [{},{diary:async()=>{throw Error('offline');}}]) {
  const next=await R.refresh(h,{capturedAt:at,collectors,identities:{[item.uri]:{canonicalUri:'https://letterboxd.com/film/film/'}}});
  a.deepEqual(next.diary,diary);a.deepEqual(h.diary,diary);
  a.equal(next.coverage.diary.state,'stale');a.equal(next.coverage.diary.completedAt,at);
  a.equal(next.coverage.diary.observedCount,0);
 }
});

const W=require('../test-support/will-refresh-fixtures');
function source(html,{end=at,urlOverride}={}) {let time=Date.parse(at);const links=[];return {links,collectors:R.publicCollectors({capturedAt:at,links,clock:()=>time,http:{get:async url=>{time=Date.parse(end);return {status:200,url:urlOverride||url,text:html};}}})};}
const nose={uri:'https://boxd.it/f5eG',title:'Nosferatu',year:2024,date:'2026-01-01',rating:5};
test('complete all-films collection clears an unrated rating, keeps watched and unifies export lid',async()=>{
 const s=source(W.films({unrated:true}),{end:'2026-10-14T12:01:00.000Z'});
 const next=await R.refresh(F.history({watched:[film(nose)],ratings:[nose],likes:[film(nose)]}),{capturedAt:at,...s});
 a.equal(next.ratings.some(r=>r.uri===nose.uri),false);
 a.equal(next.ratings.some(r=>r.rating==null),false);
 a.equal(next.watched.filter(r=>r.uri===nose.uri).length,1);
 a.equal(next.watched.some(r=>r.uri==='https://letterboxd.com/film/nosferatu-2024/'),false);
 a.equal(next.coverage.ratings.state,'complete');
 a.equal(next.coverage.ratings.observedCount,next.ratings.length);
 a.equal(next.coverage.ratings.traversalCount,next.watched.length);
 a.equal(next.coverage.ratings.traversalCountScope,'watched-films');
 a.equal(next.coverage.ratings.completedAt,'2026-10-14T12:01:00.000Z');
 a.equal(Iload(next).films.get(nose.uri).pendingIdentity,false);
});
const Iload=h=>require('../lib/person-input').loadHistory(h);
test('partial unrated observations cannot delete export ratings; unresolved homonyms remain conservative',async()=>{
 const s=source(W.films({unrated:true,next:'/friend-a/films/page/3/'}));
 const unknown={...nose,uri:'https://boxd.it/unknown'};
 const h=F.history({watched:[film(nose),film(unknown)],ratings:[nose,unknown]});
 const next=await R.refresh(h,{capturedAt:at,...s});
 a.equal(next.ratings.find(r=>r.uri===nose.uri).rating,5);
 a.equal(next.ratings.find(r=>r.uri===unknown.uri).rating,5);
 a.equal(next.coverage.ratings.state,'stale');
 const full=source(W.films({unrated:true}));
 const complete=await R.refresh(h,{capturedAt:at,...full});
 a.equal(complete.ratings.find(r=>r.uri===unknown.uri).rating,5);
 a.equal(complete.coverage.ratings.reason,'IDENTITY_UNRESOLVED');
});
test('explicit IMDb/canonical links resolve; title equality never supplies a link and conflicts stay pending',()=>{
 const uri='https://boxd.it/abc',canonicalUri='https://letterboxd.com/film/film/';
 const resolve=R.identityResolver({identities:{[uri]:{imdbId:'tt1234567'}},films:{film:{imdbId:'tt1234567'}}});
 a.equal(resolve(uri),canonicalUri);a.equal(resolve('https://boxd.it/other'),null);
 a.equal(R.identityResolver({identities:{[uri]:{canonicalUri}},links:[[uri,'https://letterboxd.com/film/other/']]})(uri),null);
});
test('following uses reviewed parser, retains previous members and has no invented exact total',async()=>{
 const s=source(W.following()),h=F.history({following:[{user:'oldfriend',name:'Old Friend'}]});
 const next=await R.refresh(h,{capturedAt:at,...s});
 a.deepEqual(next.following.map(r=>r.user),['oldfriend','matheushector','wimwenders','friend-e']);
 a.equal(next.coverage.following.state,'stale');a.equal(next.coverage.following.completedAt,undefined);
});
test('duplicate content at distinct URLs, skipped pages and exact-user redirects never complete',async()=>{
 for(const mode of ['duplicate','skip','redirect','count','challenge','error','cap']) {
  let calls=0;
  const r=await R.traverse({dataset:'ratings',startedAt:at,clock:()=>Date.parse(at),maxPages:mode==='cap'?1:3,
   http:async url=>{calls++;if(mode==='error'&&calls===2) throw Error('offline');return {status:200,url:mode==='redirect'?'https://letterboxd.com/mgusmao/films/':url,text:mode==='challenge'?'challenge-platform':'fixture'};},
   parse:()=>({items:[{...nose,uri:mode==='count'&&calls===2?'https://boxd.it/b':nose.uri}],expectedCount:mode==='count'&&calls===2?3:2,next:calls===1?`/friend-a/films/page/${mode==='skip'?3:2}/`:null})});
  a.notEqual(r.state,'complete',mode);
  a.equal(R.merge(F.history({ratings:[nose]}),r).ratings.find(r=>r.uri===nose.uri).rating,5);
 }
});
test('bounded fields and duplicate records are refused before complete replacement',()=>{
 for(const change of [{title:'x'.repeat(501)},{title:'<script>'},{uri:'https://evil.test/x'},{rating:99}]) a.throws(()=>R.envelope({dataset:'ratings',items:[{...nose,...change}]}));
 a.notEqual(R.envelope({dataset:'ratings',items:[nose,nose],terminalPage:true,expectedCount:2}).state,'complete');
 a.throws(()=>R.envelope({dataset:'following',items:[{user:'../mgusmao',name:'Marco'}]}));
});
test('private update materializes following for the build without reading shared friends',async t=>{
 const fs=require('node:fs'),path=require('node:path'),fixture=F.fixture(t),dir=fixture.privateDir;
 fixture.write(path.relative(fixture.root,path.join(dir,'history.json')),F.history());
 fixture.write('cache/friends.json',{following:{user:'mgusmao',users:[['marco_only','Marco']]},users:{marco_only:{rating:5}}});
 const s=source(W.following());
 await require('../scripts/update-person').update({root:fixture.root,privateDir:dir,capturedAt:at,collectors:s.collectors});
 const cache=JSON.parse(fs.readFileSync(path.join(dir,'cache/friends.json')));
 a.equal(cache.following.user,'friend-a');a.equal(cache.following.users.length,3);a.deepEqual(cache.users,{});a.equal(cache.following.partial,true);a.equal(cache.following.fetchedAt,null);
});
test('a terminal one-page response redirected to Marco cannot replace Will history',async()=>{
 const r=await R.traverse({dataset:'ratings',startedAt:at,clock:()=>Date.parse(at),http:async()=>({status:200,url:'https://letterboxd.com/mgusmao/films/',text:'fixture'}),parse:()=>({items:[{...nose,rating:null}],expectedCount:1,next:null})});
 a.equal(r.state,'unavailable');
 a.deepEqual(R.merge(F.history({ratings:[nose]}),r).ratings,[nose]);
});
test('complete canonical watchlist removal preserves unresolved export rows only',async()=>{
 const short={...nose,uri:'https://boxd.it/mapped'},unknown={...nose,uri:'https://boxd.it/unresolved'};
 const h=F.history({watchlist:[film(short),film(unknown)]});
 const r=R.envelope({dataset:'watchlist',expectedCount:0,terminalPage:true,emptyConfirmed:true,startedAt:at,completedAt:at});
 const next=await R.refresh(h,{capturedAt:at,identities:{[short.uri]:{canonicalUri:'https://letterboxd.com/film/nosferatu-2024/'}},collectors:{watchlist:async()=>r}});
 a.deepEqual(next.watchlist,[film(unknown)]);a.equal(next.coverage.watchlist.state,'stale');
});
test('a forward pagination link without a parsed next never licenses removal',async()=>{
 const html=W.films().replace('</body>','<a href="/friend-a/films/page/2/">2</a></body>');
 const next=await source(html).collectors.watched();a.equal(next.state,'unavailable');
});
test('existing private following cache members survive partial collection and foreign cache owner is rejected',async t=>{
 const fs=require('node:fs'),path=require('node:path'),fixture=F.fixture(t),dir=fixture.privateDir;
 const write=(name,data)=>fixture.write(path.relative(fixture.root,path.join(dir,name)),data);
 write('history.json',F.history());write('cache/friends.json',{version:1,films:{},users:{},following:{user:'friend-a',users:[['oldfriend','Old Friend']]}});
 await require('../scripts/update-person').update({root:fixture.root,privateDir:dir,capturedAt:at,collectors:source(W.following()).collectors});
 a.equal(JSON.parse(fs.readFileSync(path.join(dir,'cache/friends.json'))).following.users[0][0],'oldfriend');
 write('cache/friends.json',{following:{user:'mgusmao',users:[]}});
 await a.rejects(require('../scripts/update-person').update({root:fixture.root,privateDir:dir,capturedAt:at,collectors:{}}),/owner/);
});

test('a changed public rating does not inherit the old export rating date',()=>{
 const r=R.envelope({dataset:'ratings',items:[{...nose,rating:3}],expectedCount:1,terminalPage:true,startedAt:at,completedAt:at});
 const next=R.merge(F.history({ratings:[nose]}),r);
 a.equal(next.ratings[0].rating,3);a.equal(next.ratings[0].date,null);
});
