'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const I=require('../lib/person-input'),P=require('../lib/people'),R=require('../lib/person-refresh'),F=require('../test-support/people/fixture'),W=require('../test-support/will-refresh-fixtures');
const at='2026-10-14T12:00:00.000Z',id='11111111-1111-4111-8111-111111111111';
const cfg=()=>P.deriveConfig(require('../config.json'),P.resolvePerson('friend-a'));
function seed(t,{likes=false}={}) {
 const f=F.fixture(t),h=I.importArchive({...f,archive:F.zip(f.root,{likes}),capturedAt:at,requestId:id});
 I.write(path.join(f.privateDir,'identities.json'),{});I.write(path.join(f.privateDir,'coverage.json'),h.coverage);I.write(path.join(f.privateDir,'person-config.json'),cfg());
 return {...f,h};
}
const snapshot=f=>JSON.parse(I.snapshot({...f,sourceRequestId:id,codeSha:'a'.repeat(40),capturedAt:at,selectionDate:'2026-10-14'}));
function change(s,name,fn){const f=s.files.find(f=>f.path===name);fn(f.data);const bytes=Buffer.from(I.canonical(f.data));f.bytes=bytes.length;f.sha256=I.sha(bytes);return s;}
function refuse(f,s) {
 const bytes=Buffer.from(I.canonical(s));
 a.throws(()=>I.validateSnapshot(s));a.throws(()=>I.unpack(bytes));
 // The package has correct canonical JSON, gzip and private file digests.
 a.throws(()=>I.unpack(zlib.gzipSync(Buffer.from(I.canonical({packageVersion:1,personId:'friend-a',snapshot:s,release:[]})))));
 const dest=path.join(f.root,'.context/private/friend-a/rejected');
 a.throws(()=>I.restore({...f,privateDir:dest,bytes}));a.equal(fs.existsSync(dest),false,'no private directory or early files written');
 a.throws(()=>I.restorePackage({...f,privateDir:dest,bytes}));a.equal(fs.existsSync(dest),false);
}
test('parsed ZIP missing likes, absent following and repeated diary sessions survives snapshot/unpack/restore',t=>{
 const f=seed(t),s=snapshot(f);a.equal(f.h.coverage.likes.state,'unknown');a.equal(f.h.following,undefined);a.equal(f.h.diary.length,2);a.notEqual(f.h.diary[0].entryId,f.h.diary[1].entryId);
 const bytes=Buffer.from(I.canonical(s));a.deepEqual(I.unpack(bytes).snapshot,s);
 const dest=path.join(f.root,'.context/private/friend-a/restored');I.restore({...f,privateDir:dest,bytes});a.deepEqual(snapshot({...f,privateDir:dest}),s);
});
for(const [name,mutate] of [
 ['rating99',h=>h.ratings[0].rating=99],
 ['extraneous privateReview',h=>h.ratings[0].privateReview='private text'],
 ['invalid date',h=>h.diary[0].watchedDate='2026-02-30'],
 ['foreign URI',h=>h.watched[0].uri='https://example.com/film/a/'],
 ['duplicate diary entryId',h=>h.diary[1].entryId=h.diary[0].entryId],
 ['extra following profile',h=>h.following=[{user:'friend_a',name:'A',email:'private'}]],
])test(`hash-correct ${name} fails before restore writes`,t=>{const f=seed(t);refuse(f,change(snapshot(f),'history.json',mutate));});
function friendSeed(t) {
 const f=seed(t);f.h.following=[{user:'friend_a',name:'Friend'}];I.write(path.join(f.privateDir,'history.json'),f.h);
 I.write(path.join(f.privateDir,'cache/friends.json'),{version:1,films:{},lists:{},users:{},following:{user:'friend-a',users:[['friend_a','Friend']],partial:true,fetchedAt:null}});
 return f;
}
test('hash-correct foreign following owner fails',t=>{const f=friendSeed(t);refuse(f,change(snapshot(f),'cache/friends.json',c=>c.following.user='mgusmao'));});
test('hash-correct unapproved account profile fails',t=>{const f=friendSeed(t);refuse(f,change(snapshot(f),'cache/friends.json',c=>c.users.stranger={subjectUser:'stranger',films:[],watchlist:[]}));});
test('hash-correct account subject and extra fields fail',t=>{
 for(const record of [{subjectUser:'other',films:[],watchlist:[]},{subjectUser:'friend_a',films:[],watchlist:[],privateReview:'x'},{subjectUser:'friend_a',films:[['a','A',2000,99]],watchlist:[]}]){const f=friendSeed(t);refuse(f,change(snapshot(f),'cache/friends.json',c=>c.users.friend_a=record));}
});
test('late invalid identities/coverage fields fail with no partial private restore',t=>{
 for(const [name,fn] of [
  ['identities.json',v=>v['https://boxd.it/a']={canonicalUri:'https://example.com/a'}],
  ['identities.json',v=>v['https://boxd.it/a']={canonicalUri:'https://letterboxd.com/film/a/',privateReview:'x'}],
  ['coverage.json',v=>v.likes.state='complete'],
 ]){const f=seed(t),s=change(snapshot(f),name,fn);s.files.sort((a,b)=>a.path===name?1:b.path===name?-1:0);refuse(f,s);}
});
test('real update emitter yields valid unavailable, partial, complete coverage and acquired account cache',async t=>{
 const f=friendSeed(t),clock=()=>Date.parse(at);
 // Default collectors, recorded HTML, real bounded transport and mergeAccount.
 const next=await require('../scripts/update-person').update({...f,capturedAt:at,clock,limits:{maxMetadata:0,maxAccounts:1},http:{get:async url=>{
  const user=new URL(url).pathname.split('/')[1];return {status:200,url,text:url.includes('/following/')?W.following():url.includes('/watchlist/')?W.watchlist({user}):W.films()};
 }}});
 a.equal(next.coverage.likes.state,'unknown');a.equal(next.coverage.diary.observation.state,'unavailable');a.equal(next.coverage.following.observation.state,'partial');a.equal(next.coverage.watchlist.observation.state,'complete');
 const cache=JSON.parse(fs.readFileSync(path.join(f.privateDir,'cache/friends.json')));a.equal(cache.users.friend_a.coverage.films.state,'complete');
 a.ok(cache.users.friend_a.identities['https://boxd.it/f5eG']);a.deepEqual(I.unpack(Buffer.from(I.canonical(snapshot(f)))).snapshot,snapshot(f));
 // A subsequent unavailable update keeps the same normalized source and sessions.
 await require('../scripts/update-person').update({...f,capturedAt:at,collectors:{}});a.doesNotThrow(()=>snapshot(f));
});
test('complete known-empty refresh collections and unavailable initial following are valid',async t=>{
 const f=seed(t);const collectors=Object.fromEntries(['watched','ratings','watchlist','following'].map(dataset=>[dataset,async()=>R.envelope({dataset,items:[],expectedCount:0,terminalPage:true,emptyConfirmed:true,startedAt:at,completedAt:at})]));
 await require('../scripts/update-person').update({...f,capturedAt:at,collectors});a.doesNotThrow(()=>snapshot(f));
 const g=seed(t);await require('../scripts/update-person').update({...g,capturedAt:at,collectors:{}});a.doesNotThrow(()=>snapshot(g));
});
// Fixtures are planted here, never read from the live cache/ (nightly jobs change it). Shapes are the ones lib/posters.js, lib/mubi-cache.js and scripts/prepare-person.js write.
const tt=n=>'tt'+String(n).padStart(7,'0'),day1='2026-10-18',day2='2026-10-19',metahub=n=>'https://images.metahub.space/poster/medium/'+tt(n)+'/img';
const item=(n,extra={})=>({h:'0123456789abcdef',kind:'tmdb',s:'a'.repeat(64),d:day1,...extra});
const postersPlain=()=>({version:1,items:{[tt(1)]:item(1),[tt(2)]:{h:'fedcba9876543210',kind:'metahub'}}});
// failures as drawCovers writes them (one plain, one after the single look for another source), and an item that was switched to the other source
const postersFull=()=>({...postersPlain(),items:{...postersPlain().items,[tt(3)]:item(3,{kind:'metahub',switched:{from:'tmdb',to:'metahub',d:day2}})},failures:{[tt(4)]:{kind:'permanent',tries:1,code:'404',last:day2,next:'2026-10-26',url:metahub(4)},[tt(5)]:{kind:'permanent',tries:3,code:'404+not-image',last:day2,next:'2026-10-26',url:metahub(5),alt:{d:day2,found:true,kind:'tmdb',ok:false,code:'410'}},[tt(6)]:{kind:'permanent',tries:2,code:'410',last:day1,next:day2,url:metahub(6),alt:{d:day1,found:false}}}});
const FILMS=1001;
function sharedSeed(t,posters) {
 const f=seed(t);
 const planted={'tmdb.json':{movie:{[tt(1)]:{t:1791674862229,v:{id:1,imdb:tt(1),title:'Planted',year:1988}}}},'lists.json':{version:1,lists:{}},'imdb-ratings.json':{version:1,date:day2,ratings:{[tt(1)]:[7.5,1000]},none:[tt(2)]},
  'mubi.json':{schema:1,source:'api.mubi.com/v3',updatedAt:'2026-10-19T12:00:00.000Z',films:{}},'friends.json':{version:1,films:Object.fromEntries(Array.from({length:FILMS},(_,n)=>['film-'+n,{title:'Film '+n,year:2000,imdbId:tt(n+1)}])),users:{},lists:{}}};
 for(const [n,v] of Object.entries(planted))f.write('cache/'+n,v);
 require('../scripts/prepare-person').preparePerson(f.root,'friend-a',f.privateDir);
 // Poster state is private generated state, not copied by preparePerson.
 I.write(path.join(f.privateDir,'cache/posters.json'),posters);
 return f;
}
test('planted shared metadata seed and poster producer cache (with and without failures/switched) remain accepted without field stripping',t=>{
 for(const [name,posters] of [['plain',postersPlain()],['with failures and switched',postersFull()]]){
  const f=sharedSeed(t,posters),s=snapshot(f);a.equal(s.files.length,9,name);a.deepEqual(I.unpack(Buffer.from(I.canonical(s))).snapshot,s,name);
  a.deepEqual(s.files.find(f=>f.path==='cache/posters.json').data,posters,name+': stored unchanged');
  const shared=s.files.find(f=>f.path==='cache/friends.json').data;a.deepEqual(shared.users,{});a.equal(Object.keys(shared.films).length,FILMS);
 }
});
test('hash-correct poster cache with an unknown field or a malformed failures/switched record fails before restore writes',t=>{
 const f=sharedSeed(t,postersFull()),fail=n=>c=>c.failures[tt(4)]=n(c.failures[tt(4)]);
 for(const [name,mutate] of [
  ['unknown top-level key',c=>c.extra={}],
  ['failures not an object',c=>c.failures=[]],
  ['failures key not a film id',c=>c.failures.notafilm=c.failures[tt(4)]],
  ['unknown field in a record',fail(r=>({...r,note:'x'}))],
  ['missing field in a record',fail(({url,...r})=>r)],
  ['kind transient',fail(r=>({...r,kind:'transient'}))],
  ['zero tries',fail(r=>({...r,tries:0}))],
  ['code of a status the producer never writes',fail(r=>({...r,code:'503'}))],
  ['impossible day',fail(r=>({...r,last:'2026-02-30'}))],
  ['retry before failure',fail(r=>({...r,next:day1}))],
  ['URL not https',fail(r=>({...r,url:'http://images.metahub.space/x'}))],
  ['URL not a string',fail(r=>({...r,url:42}))],
  ['alt found without its kind',fail(r=>({...r,alt:{d:day2,found:true,ok:false,code:'410'}}))],
  ['alt unknown field',fail(r=>({...r,alt:{d:day2,found:false,url:'x'}}))],
  ['alt that found a cover but says ok',fail(r=>({...r,alt:{d:day2,found:true,kind:'tmdb',ok:true,code:'410'}}))],
  ['alt found neither true nor false',fail(r=>({...r,alt:{d:day2,found:'yes'}}))],
  ['switched unknown source',c=>c.items[tt(3)].switched.to='unknown-source'],
  ['switched unknown field',c=>c.items[tt(3)].switched.why='x'],
  ['switched impossible day',c=>c.items[tt(3)].switched.d='2026-13-01'],
 ]){try{refuse(f,change(snapshot(f),'cache/posters.json',mutate));}catch(e){e.message=name+': '+e.message;throw e;}}
});

const tomorrow='2026-10-15T12:00:00.000Z';
const snapAt=(f,capturedAt)=>JSON.parse(I.snapshot({...f,sourceRequestId:id,codeSha:'a'.repeat(40),capturedAt,selectionDate:capturedAt.slice(0,10)}));
async function acquired(t){const f=friendSeed(t);await require('../scripts/update-person').update({...f,capturedAt:at,clock:()=>Date.parse(at),collectors:{},limits:{maxMetadata:0},http:{get:async url=>({status:200,url,text:url.includes('watchlist')?W.watchlist():W.films()})}});return f;}
test('actual producer prunes removed accounts only after normalized complete following',async t=>{
 for(const mode of ['unavailable','partial','complete']){
  const f=await acquired(t),before=JSON.parse(fs.readFileSync(path.join(f.privateDir,'cache/friends.json'))).users.friend_a;
  const following=()=>R.envelope({dataset:'following',items:mode==='partial'?[{user:'friend_b',name:'B'}]:[],startedAt:tomorrow,completedAt:tomorrow,...(mode==='complete'?{expectedCount:0,terminalPage:true,emptyConfirmed:true}:{})});
  await require('../scripts/update-person').update({...f,capturedAt:tomorrow,collectors:{following}});
  const cache=JSON.parse(fs.readFileSync(path.join(f.privateDir,'cache/friends.json')));
  if(mode==='complete'){a.deepEqual(cache.users,{});a.equal(cache.followedAcquisition,undefined);}else a.deepEqual(cache.users.friend_a,before);
  a.doesNotThrow(()=>snapAt(f,tomorrow));
 }
});
test('later public additions load snapshot and restore without changing importedAt',async t=>{
 const f=seed(t);const next=await require('../scripts/update-person').update({...f,capturedAt:tomorrow,clock:()=>Date.parse(tomorrow),limits:{maxAccounts:0,maxMetadata:0},http:{get:async url=>({status:200,url,text:url.includes('following')?W.following():url.includes('watchlist')?W.watchlist({user:'friend-a'}):W.films()})}});
 a.equal(next.importedAt,at);a.ok(next.watched.length>f.h.watched.length);a.doesNotThrow(()=>I.loadHistory(next));a.doesNotThrow(()=>snapAt(f,tomorrow));
 // The public collector currently emits null event dates. A normalized dated
 // observation on the later day must also remain readable; it is not ZIP data.
 next.watched[0].date='2026-10-15';a.doesNotThrow(()=>I.loadHistory(next));I.write(path.join(f.privateDir,'history.json'),next);
 const s=snapAt(f,tomorrow),dest=path.join(f.root,'.context/private/friend-a/later');
 a.doesNotThrow(()=>I.restore({...f,privateDir:dest,bytes:Buffer.from(I.canonical(s))}));a.equal(JSON.parse(fs.readFileSync(path.join(dest,'history.json'))).importedAt,at);
});
test('dates beyond snapshot and future coverage timestamps fail before writes',async t=>{
 const f=await acquired(t),base=snapshot(f);
 for(const [field,fn] of [
  ['history.json',h=>h.watched[0].date='2026-10-15'],
  ['history.json',h=>h.diary[0].watchedDate='2026-10-15'],
  ['cache/friends.json',c=>c.users.friend_a.coverage.films.completedAt=tomorrow],
  ['cache/friends.json',c=>c.users.friend_a.filmsAt=tomorrow],
 ])refuse(f,change(structuredClone(base),field,fn));
 for(const field of ['completedAt','observation']){
  const s=structuredClone(base);const mutate=c=>{if(field==='completedAt')c.watched.completedAt=tomorrow;else c.watched.observation.attemptedAt=tomorrow;};
  change(s,'history.json',h=>mutate(h.coverage));change(s,'coverage.json',mutate);refuse(f,s);
 }
});

test('hash-correct inserted person-config is refused before private restore',t=>{
 const f=seed(t),s=snapshot(f);a.equal(s.files.some(f=>f.path==='person-config.json'),false);
 const data=cfg(),bytes=Buffer.from(I.canonical(data));
 s.files.push({path:'person-config.json',data,bytes:bytes.length,sha256:I.sha(bytes)});
 refuse(f,s);
});
test('old normalized snapshot restores after current addon version changes',t=>{
 const f=seed(t),s=snapshot(f),bytes=Buffer.from(I.canonical(s));
 // Build config remains a local build product, excluded even when present.
 a.ok(fs.existsSync(path.join(f.privateDir,'person-config.json')));a.equal(s.files.some(f=>f.path==='person-config.json'),false);
 // Fresh child process and isolated code/config copy: never modify source config
 // or shared require caches while other tests run.
 const code=path.join(f.root,'reviewed-code');fs.mkdirSync(code);
 fs.cpSync(path.join(F.ROOT,'lib'),path.join(code,'lib'),{recursive:true});
 fs.copyFileSync(path.join(F.ROOT,'people.json'),path.join(code,'people.json'));
 const config=JSON.parse(fs.readFileSync(path.join(F.ROOT,'config.json')));config.addon.version+='-next';
 fs.writeFileSync(path.join(code,'config.json'),JSON.stringify(config));
 const input=path.join(f.root,'old-snapshot.json');fs.writeFileSync(input,bytes);
 const dest=path.join(f.root,'.context/private/friend-a/new-code');
 const child=require('node:child_process').spawnSync(process.execPath,['-e',`
  const fs=require('node:fs'),a=require('node:assert/strict'),I=require('./lib/person-input');
  const [root,privateDir,input]=process.argv.slice(1);
  const bytes=fs.readFileSync(input);const restored=I.restore({root,privateDir,bytes});
  a.equal(restored.codeSha,'a'.repeat(40));a.deepEqual(restored,I.unpack(bytes).snapshot);
 `,f.root,dest,input],{cwd:code,encoding:'utf8'});
 a.equal(child.status,0,child.stderr);a.deepEqual(JSON.parse(fs.readFileSync(path.join(dest,'history.json'))),f.h);
 a.equal(fs.existsSync(path.join(dest,'person-config.json')),false);
});
