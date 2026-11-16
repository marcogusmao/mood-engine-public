'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const F=require('../test-support/people/fixture'),I=require('../lib/person-input'),R=require('../lib/person-refresh'),G=require('../lib/learning/public'),P=require('../web/person');
const revision='r-'+'7'.repeat(32),at='2026-10-15T12:00:00.000Z';
test('published Will engine supplies exactly the identity the browser verifies; Marco has no added metadata',t=>{
 const f=F.fixture(t);
 for(const will of [false,true]){
  const cfg={addon:{id:'synthetic',name:'Synthetic',version:'1',description:'Synthetic'},...(will?{personContext:{personId:'friend-a',revision}}:{})};
  const dir=path.join(f.root,will?'will':'marco');
  require('../lib/publish').publish({outDir:dir,webDir:path.join(F.ROOT,'web'),cfg,plan:{board:[],discover:[]},webData:{}});
  const actual=JSON.parse(fs.readFileSync(path.join(dir,'data/engine.json')));
  if(will){a.doesNotThrow(()=>P.engine(actual,revision));a.deepEqual(actual.meta,{personId:'friend-a',revision});a.throws(()=>P.engine(actual,'r-'+'8'.repeat(32)));}
  else a.equal(Object.hasOwn(actual,'meta'),false);
 }
});
test('public engine metadata refuses foreign owners, bad revisions and all private additions',()=>{
 for(const meta of [{personId:'marco',revision},{personId:'friend-a',revision:'bad'},{personId:'friend-a',revision,requestId:'private'},{personId:'friend-a',revision,email:'private'},{personId:'friend-a'},null,[]])a.throws(()=>G.projection({meta}));
 a.deepEqual(G.projection({meta:{personId:'friend-a',revision}}).meta,{personId:'friend-a',revision});
});
test('unavailable public observations preserve actual ZIP origin, unknown likes and diary sessions',async t=>{
 const f=F.fixture(t),h=I.importArchive({root:f.root,privateDir:f.privateDir,archive:F.zip(f.root,{likes:false}),capturedAt:at,requestId:'11111111-1111-4111-8111-111111111111'});
 const next=await R.refresh(h,{capturedAt:at});
 for(const k of ['watched','ratings','watchlist','likes','diary']){
  a.deepEqual(next[k],h[k]);a.equal(next.coverage[k].source,'export');
  a.equal(next.coverage[k].state,k==='likes'?'unknown':'stale');
  a.equal(next.coverage[k].observation.state,'unavailable');
 }
 a.equal(I.loadHistory(next).diary.length,2);a.equal([...I.loadHistory(next).films.values()][0].rewatches,2);
});
test('partial public observations distinguish mixed retained ZIP history from complete public traversal',()=>{
 const item={uri:'https://letterboxd.com/film/a/',title:'A',year:2000,date:null};
 const incoming={...item,uri:'https://letterboxd.com/film/b/',title:'B'};
 const h=F.history({watched:[item]});
 const partial=R.merge(h,R.envelope({dataset:'watched',items:[incoming],startedAt:at}));
 a.equal(partial.coverage.watched.source,'mixed');a.equal(partial.watched.length,2);
 const full=R.merge(h,R.envelope({dataset:'watched',items:[incoming],startedAt:at,completedAt:at,expectedCount:1,terminalPage:true}));
 a.equal(full.coverage.watched.source,'public');a.equal(full.watched.length,1);
 const failed=R.merge(full,R.envelope({dataset:'watched',startedAt:at}));
 a.equal(failed.coverage.watched.source,'public');a.equal(failed.coverage.watched.completedAt,at);
});
test('public coverage and rendered copy retain export provenance when every public source is unavailable',async t=>{
 const f=F.fixture(t),h=I.importArchive({root:f.root,privateDir:f.privateDir,archive:F.zip(f.root,{likes:false}),capturedAt:at,requestId:'11111111-1111-4111-8111-111111111111'});
 const next=await R.refresh(h,{capturedAt:at}),PUB=require('../lib/people-publication');
 const coverage=PUB.publicCoverage(next);
 a.deepEqual(coverage,{history:'export',likes:'unknown',following:'unavailable',refresh:'unavailable'});
 const text=P.coverageText({inputUpdatedAt:h.importedAt,coverage});
 a.match(text,/History: your export/);a.match(text,/Likes: not available/);a.match(text,/Public updates are unavailable; your existing data is kept/);
 const partial=R.merge(next,R.envelope({dataset:'watched',items:[{uri:'https://letterboxd.com/film/another/',title:'Another',year:2000,date:null}],startedAt:at}));
 a.equal(PUB.publicCoverage(partial).history,'mixed');a.equal(PUB.publicCoverage(partial).refresh,'partial');
});
test('release refuses a missing or foreign engine identity even with a fresh correct file manifest',t=>{
 const f=F.fixture(t),PUB=require('../lib/people-publication'),dir=path.join(f.root,'release');
 const cfg={addon:{id:'com.mgusmao.moodengine.friend-a',name:'Will',version:'1',description:'Synthetic'},personContext:{personId:'friend-a',revision}},plan={board:[],discover:[]};
 const index=require('../lib/index-export').buildIndex({cfg,plan,today:'2026-10-15',builtAt:at});
 require('../lib/publish').publish({outDir:dir,webDir:path.join(F.ROOT,'web'),cfg,plan,webData:{},index});
 const file=path.join(dir,'data/engine.json'),original=JSON.parse(fs.readFileSync(file));
 for(const meta of [undefined,{personId:'friend-a',revision:'r-'+'8'.repeat(32)},{personId:'marco',revision}]){
  fs.writeFileSync(file,JSON.stringify({...original,meta}));
  a.throws(()=>PUB.stamp({dir,revision,codeSha:'a'.repeat(40),builtAt:at,history:F.history()}),/Engine person\/revision mismatch/);
 }
 fs.unlinkSync(file);a.throws(()=>PUB.stamp({dir,revision,codeSha:'a'.repeat(40),builtAt:at,history:F.history()}),/Missing person engine/);
});
