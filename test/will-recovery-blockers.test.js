'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{execFileSync,spawnSync}=require('node:child_process'),F=require('../test-support/people/fixture'),B=require('../scripts/build-people');
const source=fs.readFileSync(path.join(F.ROOT,'build.js'),'utf8'),origin='https://mood-engine.mood-engine-worker.workers.dev';
function extract(start,end){return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));}
test('online personal gatherSources consumes frozen lists/social; Marco still executes generic collectors',async()=>{
 for(const personOptions of [{person:{id:'friend-a'}},null]){
 const calls=[],cache={films:{},users:{}},view={films:{},users:[],me:[]};
 const L={refreshLists:async opts=>{calls.push(['lists',opts.cacheOnly]);return {lists:[],problems:[]};},choosePeople:()=>({people:[]}),readFollowing:async()=>{calls.push(['following']);return {people:[]};},readCrowd:async()=>{calls.push(['crowd']);return {};},watchedThisWeek:()=>new Map(),capLookups:()=>({now:[],later:new Set(),unknown:0})};
 const context={CACHE_ONLY:false,personOptions,log:()=>{},makeOnWatch:()=>()=>false,L,F:{viewFriends:()=>view,roundRobin:()=>[],slugsRefused:{n:0}},cfg:{build:{}},path,CACHE_DIR:'/synthetic',http:{},flag:()=>false,fcache:cache,friendsFile:'/synthetic/friends.json',LOOKUP_LIMIT:1,ENRICH_MAX:1,CROWD_LIMIT:1,today:'2026-10-15',SL:{apply:()=>({films:{},stats:[],problems:[]})},tmdb:{peek:()=>null},require:()=>({consistentFilms:()=>({conflicts:[]})}),refreshFriends:async opts=>{calls.push(['friends']);await opts.extra({cache});return {view,resolved:{},problems:[]};}};
 const gather=vm.runInNewContext(extract('  async function gatherSources','  /** "On your watchlist"')+';gatherSources',context);
 await gather({all:[],live:{ok:false}});
 a.deepEqual(calls,personOptions?[['lists',true]]:[['lists',false],['friends'],['following'],['crowd']]);
 }
});
test('personal RSS and live watchlist stay frozen online; Marco keeps both readers',async()=>{
 for(const personal of [true,false]){let rss=0,watch=0;const ctx={personOptions:personal?{}:null,process:{env:{},argv:[]},cfg:{letterboxd:'synthetic'},fetchRss:async()=>{rss++;return [];}};
 await vm.runInNewContext('(async()=>{'+extract('  const rss =','  const { films, diary }')+'})()',ctx);
 const body=extract('  let live =','  // where each film stands');
 await vm.runInNewContext('(async()=>{'+body+'})()',{...ctx,http:{},SKIP_FRIENDS:false,CACHE_ONLY:false,films:new Map(),L:{readLiveWatchlist:async()=>{watch++;return {ok:false};}},log:()=>{}});
 a.equal(rss,personal?0:1);a.equal(watch,personal?0:1);
 }
});
test('online coverStep downloads a synthetic JPEG and invokes real Pillow rendering for Will',async t=>{
 const f=F.fixture(t),raw=path.join(f.root,'raw.jpg');execFileSync('python3',['-c',"from PIL import Image; import sys; Image.new('RGB',(500,750),(90,120,150)).save(sys.argv[1])",raw]);const bytes=fs.readFileSync(raw),PO=require('../lib/posters');let downloads=0;
 const item={id:'tt1234567',title:'Synthetic',poster:'https://image.tmdb.org/t/p/w500/synthetic.jpg'};
 const targets=new Map([['tt1234567',{tt:'tt1234567',year:2000,ratings:{lb:4},items:[item],poster:item.poster}]]);
 const logs=[],context={SKIP_POSTERS:false,CACHE_ONLY:false,personOptions:{},CACHE_DIR:path.join(f.root,'cache'),cfg:{posters:{base:'https://marcogusmao.github.io/mood-engine/u/friend-a/r/r-'+ '1'.repeat(32)+'/posters/'}},today:'2026-10-15',COVER_RECEIPT:null,opt:()=>true,path,log:m=>logs.push(m),PO:{collectTargets:()=>targets,drawCovers:opts=>{a.equal(opts.cacheOnly,false);return PO.drawCovers({...opts,workers:1,fetchImpl:async()=>{downloads++;return new Response(bytes,{headers:{'Content-Type':'image/jpeg'}});},sleepImpl:async()=>{}});}},CO:{attachCountries:()=>({unknownLanguages:{}})}};
 const cover=vm.runInNewContext(extract('async function coverStep','\n/**\n * --self-test-guard')+';coverStep',context);const result=await cover({plan:{},index:{},countries:{}});
 a.ok(result,logs.join('\n'));a.equal(result.stats.drawn,1);a.equal(downloads,1);a(result.tts.has('tt1234567'));a(fs.statSync(path.join(f.root,'cache/posters-out/tt1234567.jpg')).size>1000);
});
function marco(f){const dir=path.join(f.root,'marco'),cfg={addon:{id:'com.mgusmao.moodengine',name:'Synthetic',version:'1',description:'Synthetic'}},plan={board:[],discover:[]},index=require('../lib/index-export').buildIndex({cfg,plan,today:'2026-10-15',builtAt:'2026-10-15T12:00:00.000Z'});require('../lib/publish').publish({outDir:dir,webDir:path.join(F.ROOT,'web'),cfg,plan,webData:{},index});return {marcoDir:dir,outDir:path.join(f.root,'docs'),webDir:path.join(F.ROOT,'web')};}
function legacy(url){if(url.endsWith('/api/v1/friend-a/publication')||url===origin+'/u/friend-a/manifest.json')return Response.json({err:'not found'},{status:404});if(url===origin+'/manifest.json')return Response.json({id:'com.mgusmao.moodengine.live',types:['movie'],catalogs:[]});if(url==='https://marcogusmao.github.io/mood-engine/u/friend-a/')return new Response('GitHub Pages 404',{status:404});throw Error('unexpected fixed URL');}
test('bootstrap first rollout uses explicit legacy Worker and absent Pages shell; continues Marco over consecutive nights',async t=>{
 const f=F.fixture(t),opts=marco(f);for(let n=0;n<2;n++){let result;await a.doesNotReject(async()=>{result=await B.bootstrap({...opts,fetchImpl:async url=>legacy(url)});});a.equal(result.state,'legacy');a.deepEqual(fs.readFileSync(path.join(opts.outDir,'manifest.json')),fs.readFileSync(path.join(opts.marcoDir,'manifest.json')));a(!fs.existsSync(path.join(opts.outDir,'u')));}
});
test('bootstrap never interprets active/new Worker, 503, network failure or existing Will shell as first rollout',async t=>{
 const f=F.fixture(t),opts=marco(f);fs.mkdirSync(opts.outDir);fs.writeFileSync(path.join(opts.outDir,'sentinel'),'old-public');
 for(const fetchImpl of [async()=>Response.json({schemaVersion:1,personId:'friend-a',state:'ready',activePublication:{revision:'r-'+ '1'.repeat(32)}}),async()=>new Response('',{status:503}),async()=>{throw Error('network down');},async url=>url.includes('github.io')?new Response('existing Will shell'):legacy(url),async url=>url===origin+'/manifest.json'?new Response('',{status:503}):legacy(url),async()=>Response.json({error:{code:'NOT_FOUND'}},{status:404})]){await a.rejects(()=>B.bootstrap({...opts,fetchImpl}));a.equal(fs.readFileSync(path.join(opts.outDir,'sentinel'),'utf8'),'old-public');}
});
// 20/10/2026, owner review of 8e37c23, item 1: the nightly failed closed with the Worker config default (WILL_UPLOAD_ENABLED "false" makes the Worker answer 503 CONFIG_MISSING
// on /api/v1/friend-a/publication, and the bootstrap, which ran every night even with the GitHub variable off, refused anything but a 404 or a 200).
// The bootstrap now asks for the Worker only when the GitHub variable is on.
const BAD_FETCH=async url=>{throw Error('the night asked the network with the intake off: '+url);};
test('bootstrap with the GitHub variable off makes no request at all and publishes Marco alone, exit state skipped',async t=>{
 const f=F.fixture(t),opts=marco(f);
 for(let n=0;n<2;n++){const result=await B.bootstrap({...opts,enabled:false,fetchImpl:BAD_FETCH});
  a.deepEqual(result,{state:'skipped',willPublished:false});
  a.deepEqual(fs.readFileSync(path.join(opts.outDir,'manifest.json')),fs.readFileSync(path.join(opts.marcoDir,'manifest.json')));a(!fs.existsSync(path.join(opts.outDir,'u')));}
 // Also with a configured origin that is not the fixed one: with the variable off nothing about the Worker is read.
 await a.doesNotReject(()=>B.bootstrap({...opts,enabled:false,origin:'https://arbitrary.example',fetchImpl:BAD_FETCH}));
 // A Will release already inside docs stops a manual local run. It does not protect the GitHub runner: there docs/ is in .gitignore and empty when the step starts, so this guard never fires (BACKLOG, 20/10/2026).
 fs.mkdirSync(path.join(opts.outDir,'u/friend-a/r/r-'+'1'.repeat(32)),{recursive:true});
 await a.rejects(()=>B.bootstrap({...opts,enabled:false,fetchImpl:BAD_FETCH}),/DISABLED_LOCAL_RELEASE_REQUIRES_AUTHENTICATED_PRESERVATION/);
});
test('bootstrap with the variable on and the Worker disabled (503 CONFIG_MISSING, the default of its config) refuses: that state must not be left',async t=>{
 const f=F.fixture(t),opts=marco(f);fs.mkdirSync(opts.outDir);fs.writeFileSync(path.join(opts.outDir,'sentinel'),'old-public');let asked=[];
 const fetchImpl=async url=>{asked.push(url);return Response.json({error:{code:'CONFIG_MISSING',retryable:true}},{status:503});};
 await a.rejects(()=>B.bootstrap({...opts,enabled:true,fetchImpl}),/DISABLED_PUBLICATION_STATE_UNVERIFIED/);
 a.deepEqual(asked,[origin+'/api/v1/friend-a/publication']);a.equal(fs.readFileSync(path.join(opts.outDir,'sentinel'),'utf8'),'old-public');
});
test('bootstrap with the variable on and the Worker answering not_ready (200) goes on and composes Marco with the Will shell',async t=>{
 const f=F.fixture(t),opts=marco(f);let asked=0;
 const result=await B.bootstrap({...opts,enabled:true,fetchImpl:async()=>{asked++;return Response.json({schemaVersion:1,personId:'friend-a',state:'not_ready',activePublication:null});}});
 a.equal(asked,1);a.equal(result,opts.outDir);a(fs.existsSync(path.join(opts.outDir,'u/friend-a/index.html')));
});
test('the command line reads WILL_UPLOAD_ENABLED: unset, empty, "false", "yes", "1" or "on" never touches fetch (exit 0); "true", "TRUE" and "True" ask the Worker (a stub fetch answering 503: refused), as GitHub compares `== \'true\'` without regard to case',async t=>{
 const f=F.fixture(t),opts=marco(f),preload=path.join(f.root,'preload-fetch.js'),log=path.join(f.root,'fetch-log.txt');
 fs.writeFileSync(preload,`const fs=require('node:fs');globalThis.fetch=async url=>{fs.appendFileSync(${JSON.stringify(log)},String(url)+'\\n');return new Response('{}',{status:503});};`);
 const run=extra=>{const env={...process.env};delete env.WILL_UPLOAD_ENABLED;delete env.WILL_API_ORIGIN;return spawnSync(process.execPath,['--require',preload,path.join(F.ROOT,'scripts/build-people.js'),'--bootstrap','--marco',opts.marcoDir,'--out',opts.outDir],{env:{...env,...extra},encoding:'utf8'});};
 // 20/10/2026 (re-review): GitHub treats TRUE and True as on (the workflow's `== 'true'` conditions are case-blind), so the bootstrap must not treat them as off and erase Will from Pages; yes, 1 and on are off for GitHub too.
 for(const extra of [{},{WILL_UPLOAD_ENABLED:'false'},{WILL_UPLOAD_ENABLED:''},{WILL_UPLOAD_ENABLED:'yes'},{WILL_UPLOAD_ENABLED:'1'},{WILL_UPLOAD_ENABLED:'on'}]){const r=run(extra);a.equal(r.status,0,r.stderr);a(!fs.existsSync(log),'asked the network with '+JSON.stringify(extra));a(fs.existsSync(path.join(opts.outDir,'manifest.json')));}
 for(const value of ['true','TRUE','True']){fs.rmSync(log,{force:true});const r=run({WILL_UPLOAD_ENABLED:value});a.notEqual(r.status,0,value);a.match(r.stderr,/DISABLED_PUBLICATION_STATE_UNVERIFIED/,value);a.equal(fs.readFileSync(log,'utf8'),origin+'/api/v1/friend-a/publication\n',value);}
});
// The shell condition of the nightly step is run as written, with the values GitHub's own `== 'true'` would call on or off (case-blind; yes, 1, on, empty are off).
test('the nightly step\'s shell condition agrees with the workflow conditions: true, TRUE and True are on; false, yes, 1, on and empty are off',()=>{
 const workflow=fs.readFileSync(path.join(F.ROOT,'.github/workflows/mood-engine.yml'),'utf8'),step=workflow.slice(workflow.indexOf('- name: Build rows from Letterboxd + TMDB'),workflow.indexOf('- name: Remove this runner'));
 const condition=/^\s*(if \[ .* \]); then$/m.exec(step);a(condition,'no if line in the step');
 const decide=value=>spawnSync('sh',['-c',condition[1]+'; then echo ON; else echo OFF; fi'],{env:{PATH:process.env.PATH,WILL_UPLOAD_ENABLED:value},encoding:'utf8'}).stdout.trim();
 for(const value of ['true','TRUE','True'])a.equal(decide(value),'ON',value);
 for(const value of ['false','yes','1','on',''])a.equal(decide(value),'OFF',JSON.stringify(value));
});
// The workflow hands the variable to the step through env (not spliced into the shell text), and the else branch is the bootstrap.
test('the nightly step passes WILL_UPLOAD_ENABLED to --bootstrap through the environment',()=>{
 const workflow=fs.readFileSync(path.join(F.ROOT,'.github/workflows/mood-engine.yml'),'utf8'),step=workflow.slice(workflow.indexOf('- name: Build rows from Letterboxd + TMDB'),workflow.indexOf('- name: Remove this runner'));
 a.match(step,/\n {10}WILL_UPLOAD_ENABLED: \$\{\{ vars\.WILL_UPLOAD_ENABLED \}\}\n/);a.match(step,/if \[ "\$\(printf %s "\$WILL_UPLOAD_ENABLED" \| tr A-Z a-z\)" = "true" \]; then\n\s+node scripts\/build-people\.js --hosted\n\s+else\n[^]*--bootstrap/);
});
