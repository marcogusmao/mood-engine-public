'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module'),crypto=require('node:crypto'),os=require('node:os');
const clone=x=>JSON.parse(JSON.stringify(x));
function inputHashes(root){const names=['config.json',...fs.readdirSync(path.join(root,'cache')).filter(n=>n.endsWith('.json')).map(n=>'cache/'+n),...fs.readdirSync(path.join(root,'data/letterboxd')).filter(n=>n.endsWith('.csv')).map(n=>'data/letterboxd/'+n)];return Object.fromEntries(names.sort().map(n=>[n,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,n))).digest('hex')]));}
// neutralLists: ids of the lists to keep (the reference's), and no list signal: the 11/10/2026 catalog expansion (Marco: list films as
// candidates, agreement weights, the critic/director exception and 63 new lists) switched off, so what is left must be v2.3 itself.
// dropMoods: moods of config.json that the capture must not see. The reference is the v2.3 pipeline with eight moods; a mood added later
// (slow, 11/10/2026) is proven by its own tests, and the pin compares everything else with that mood switched off.
// neutralLoved: no film is vouched for by a favourite director's love (lib/directors-loved.js vouched() gives nothing): the director half of
// the one floor exception switched off. The row and menu "Loved by your directors" still exist; the pin leaves them out (withoutNew).
// mapConfig: (parsed config.json) → the config the build reads instead (a test's own variation).
// mapSignals: (lib/list-signal.js signals() result, the options the build passed it) → the signal the build uses instead (a test's own
// variation of the list weights; the options let a test read what the build handed signals(), its ratingOf included).
// Marco, 13/10/2026: every Board row refills the place the recommendation rule opens (PRODUCT.md). floorFirst runs the REFERENCE's own selection over the films that pass the rule: its candidates,
// its rewatch list and the pool of its rows (From your lists, Short and good, New for you, the week) are filtered first, which is what the current builders do, and Friends loved is cut by it; the cuts of
// Discover keep every film, as the current build does. `passes` is the rule of the repository under test; floorFirst is the Map of ratings of the CURRENT build (the reference predates the rule and
// has none), so the pin captures the current build first.
function floorFirstPool(P,passes){const ok=rs=>rs.filter(r=>passes(r.id));return {...P,fromListsRow:(recs,size)=>P.fromListsRow(ok(recs),size),shortRow:(recs,o)=>P.shortRow(ok(recs),o),newRow:(recs,o)=>P.newRow(ok(recs),o),weekRow:o=>P.weekRow({...o,isSeen:r=>o.isSeen(r)||!passes(r.imdbId)})};}
async function capture(root,{date='2026-10-10',capturedAt='2026-10-10T12:00:00.000Z',noFloor=false,identityFix=false,yearFix=false,ownRecord=false,friendsRecordFix=false,ratingsIgnored=null,searchLinks=null,neutralLists=null,dropMoods=[],neutralLoved=false,mapConfig=null,mapSignals=null,floorFirst=false}={}){
 root=path.resolve(root);const req=createRequire(path.join(root,'build.js'));let finish,fail,preQ,ratings,ranked,result,index;const refusals=[],picked=new Map(),lines=[];let history=null,linker=null;const done=new Promise((resolve,reject)=>{finish=resolve;fail=reject;});let writes=0,network=0;
 const passes=tt=>require('../lib/recommendation-quality').qualifies((floorFirst instanceof Map?floorFirst:ratings)?.get(tt)),dropped=new Set(dropMoods),configFile=path.join(root,'config.json'),neutralConfig=file=>{let c=JSON.parse(fs.readFileSync(file,'utf8'));if(neutralLists)c.lists=c.lists.filter(l=>neutralLists.includes(l.id));if(dropped.size)c.moods=c.moods.filter(m=>!dropped.has(m.id));if(mapConfig)c=mapConfig(c);return JSON.stringify(c);};
 const readOnly=new Proxy(fs,{get:(target,key)=>['writeFileSync','mkdirSync','renameSync','rmSync','unlinkSync','appendFileSync','copyFileSync','cpSync','chmodSync'].includes(key)?()=>{writes++;throw Error('Unexpected VM write');}:key==='readFileSync'&&(neutralLists||dropped.size||mapConfig)?(file,...x)=>path.resolve(String(file))===configFile?neutralConfig(file):target.readFileSync(file,...x):target[key]});
 const oldOffline=process.env.OFFLINE;process.env.OFFLINE='1';
 try{
 const context={__dirname:root,Buffer,URL,URLSearchParams,setTimeout,clearTimeout,Date,console:{log:(...x)=>lines.push(x.join(' ')),error:fail},process:{argv:[process.execPath,path.join(root,'build.js'),'--offline','--cache-only','--skip-posters','--out',path.join(os.tmpdir(),'integration-reference-out-never-written'),'--captured-at',capturedAt],env:{...process.env,OFFLINE:'1',SKIP_RSS:'1',MOOD_DATE:date},version:process.version,memoryUsage:()=>process.memoryUsage(),exit:()=>fail(Error('Build exited'))},fetch:()=>{network++;throw Error('Unexpected VM fetch');},require:id=>{
  if(id==='fs')return readOnly;
  // Marco, 11/10/2026: apply the approved TV-id correction to the older reference; all other selection comparisons stay exact.
  // Marco, 22/10/2026 (PR #69 and #70): the ratings of the people in config.json `ratingsIgnored` (the list: benreiss; the general rule: one value in 0.95 of 50 ratings or more, which takes itscharlibb and nalyd) are not used
  // by any row. The v2.3 reference knows neither, so "Friends loved" differed from position 4 on and test 4 was red on main from PR #69 (281cd27). ratingsIgnored gives the reference that one rule: it is
  // ratingsPolicy(config.json) of the PRESENT build (the reference's own config.json has no such key), and the judgement is the present lib/friends.js ratingsIgnoredBy, so the list and the rule are decided in one
  // place only. Their ratings read as null in users and crowd; what they saw and want (films, diary dates, watchlist) stays. Every other comparison stays exact. The identityFix line below is the same
  // wrapper as before, now composed with this one when both options come in the same call.
  if(id==='./lib/friends'&&(identityFix||ratingsIgnored)){const F=req(id);let view=F.viewFriends;
   if(identityFix){const {consistentFilms}=require('../lib/tmdb-identity'),movies=JSON.parse(fs.readFileSync(path.join(root,'cache/tmdb.json'),'utf8')).movie||{},inner=view;view=(cache,cfg)=>{const v=inner(cache,cfg);return {...v,films:consistentFilms(v.films,id=>movies[id]?.v||null).films};};}
   if(ratingsIgnored){const C=require('../lib/friends'),inner=view,nulled=(cache,p)=>C.ratingsIgnoredBy(cache,p.user,ratingsIgnored)?{...p,films:new Map([...p.films].map(([k,f])=>[k,{...f,rating:null}]))}:p;view=(cache,cfg)=>{const v=inner(cache,cfg);return {...v,users:v.users.map(p=>nulled(cache,p)),crowd:v.crowd.map(p=>nulled(cache,p))};};}
   return {...F,viewFriends:view};}
  // Marco, 13/10/2026: the year of a film (the 'New for you' row and the decade cuts read it) is Letterboxd's first, its own TMDB record's as the reserve; the older reference
  // gets that one rule (APPROVED_YEAR_RULE below, a fixed text, put in place of the reference's TMDB-first line), and every other selection comparison stays exact.
  // Marco, 21/10/2026: the pool ranks and shows a film from its OWN TMDB record only (build.js gives buildPool lib/pool.js ownDetail; BACKLOG 21/10/2026). The older reference reads whatever record sits under
  // Letterboxd's tmdbId, so for tt0204394, tt8101850 and tt5580146 (cached records with no IMDb id, of other titles) it ranked them by that record and moved every other film's z-score by about 0.01,
  // which swaps neighbours in the rows. ownRecord gives the reference that one rule (a record whose `imdb` is not the film's is no record), and every other selection comparison stays exact.
  if(id==='./lib/pool'){let P=yearFix?poolWithCurrentYear(root):req(id);if(ownRecord){const B=P.buildPool;P={...P,buildPool:o=>B({...o,detail:r=>{const d=o.detail?o.detail(r):null;return d&&r.imdbId&&d.imdb===r.imdbId?d:null;}})};}return floorFirst?floorFirstPool(P,tt=>passes(tt)):P;}
  // Capture the full index in both orders: legacy writer after publish and the current in-staging publisher.
  if(id==='./lib/index-export')return {...req(id),buildIndex:(...x)=>{index=req(id).buildIndex(...x);return index;},writeIndex:()=>{}};
  // Every search hit the current build refuses (lib/search-link.js), so the pin can hold the exact list (test/v21-quality-integration.test.js).
  if(id==='./lib/search-link'){const S=req(id);return {...S,makeSearchLinker:o=>{const l=S.makeSearchLinker(o);return {...l,check:x=>{const r=l.check(x);if(!r.ok&&x.pick!=null)refusals.push([x.title,x.year,r.reason,x.pick,r.relink?.imdb||null]);return r;}};}};}
  // Marco, 11/10/2026: the homonym correction applied to an older reference. searchLinks = a FROZEN list ([title, year, reason, search hit,
  // relink IMDb, relinked TMDB id]) — used only when the inputs are the approved ones, so the rule itself is under test — or 'rule':
  // lib/search-link.js of this repository decides (inputs the nightly build rewrote). Either way a refused hit gives the relinked film
  // or nothing, and a watched film's refused hit still counts as seen.
  if(searchLinks&&(id==='./lib/tmdb'||id==='./lib/letterboxd'||id==='./lib/guard')){const M=req(id),key=(t,y)=>t+'|'+y,frozen=searchLinks==='rule'?null:new Map(searchLinks.map(e=>[key(e[0],e[1]),e]));
   if(id==='./lib/tmdb')return {...M,Tmdb:class extends M.Tmdb{async search(title,year){const pick=await super.search(title,year);
    if(frozen){const e=frozen.get(key(title,year));if(!e)return pick;if(e[3]!==pick)throw Error('frozen search hit changed: '+title);picked.set(key(title,year),pick);return e[5];}
    const S=require('../lib/search-link'),U=require('../lib/util');if(!linker){const fr=JSON.parse(fs.readFileSync(path.join(root,'cache/friends.json'),'utf8'));linker=S.makeSearchLinker({movies:this.cache.movie,lbFilms:fr.films||{},mine:{films:fr.me?.slugs||[],watchlist:(fr.watchlist?.items||[]).map(([slug])=>slug)}});}
    const f=history.get(U.filmKey(title,year)),r=linker.check({title,year,entry:this.cache.search[U.filmKey(title,year)],pick,watched:!!f?.watched,watchlist:!!f?.watchlist});if(r.ok)return pick;
    picked.set(key(title,year),pick);const m=r.relink?.imdb?await S.relinkTo(this,linker,r.relink):null;return m?m.id:null;}}};
   if(id==='./lib/letterboxd')return {...M,loadHistory:(...x)=>{const h=M.loadHistory(...x);history=h.films;return h;}};
   return {...M,seenImdbIds:o=>{for(const f of history.values())if(f.watched&&picked.has(key(f.title,f.year)))o.seenIds.add(picked.get(key(f.title,f.year)));return M.seenImdbIds(o);}};}
  if(id==='./lib/floor'&&noFloor){const F=req(id);return {...F,makeFloor:options=>F.makeFloor({...options,cfg:null})};}
  if(id==='./lib/rows'){let R=req(id);if(friendsRecordFix)R=rowsWithFriendsRecordRule(R,JSON.parse(fs.readFileSync(path.join(root,'cache/tmdb.json'),'utf8')));return {...R,...(floorFirst?{buildFriendRows:o=>{const out=R.buildFriendRows(o);if(out.rows['friends-love'])out.rows['friends-love']=out.rows['friends-love'].filter(x=>passes(x.id));return out;}}:{}),buildRows:options=>{const r=R.buildRows(floorFirst?{...options,pool:options.pool.filter(c=>passes(c.film.imdb)),rewatch:options.rewatch.filter(x=>passes(x.film.imdb))}:options);ranked=Object.fromEntries(Object.entries(r.ranked).map(([k,v])=>[k,v.map(c=>({id:c.film.imdb,score:c.rank,fit:c.fitInfo.norm}))]));return r;}};}
  if(id==='./lib/directors-loved'&&neutralLoved){const M=req(id);return {...M,vouched:()=>new Map()};}
  if(id==='./lib/list-signal'&&neutralLists){const M=req(id);return {...M,signals:()=>M.NONE};}
  if(id==='./lib/list-signal'&&mapSignals){const M=req(id);return {...M,signals:(...x)=>mapSignals(M.signals(...x),...x)};}
  if(id==='./lib/recommendation-quality'){const Q=req(id);return {...Q,index:(...options)=>{ratings=Q.index(...options);return ratings;},applyPlan:(plan,index)=>{preQ=clone(plan);return Q.applyPlan(plan,index);}};}
  if(id==='./lib/publish')return {...req(id),publish:options=>{result=clone(options);finish();return {catalogs:0,files:0,covers:0};}};
  return req(id);
 }};
 vm.runInNewContext(fs.readFileSync(path.join(root,'build.js'),'utf8'),context,{filename:path.join(root,'build.js')});await done;
 if(writes||network)throw Error('VM performed side effects');return {refusals,log:lines.join('\n'),plan:result.plan,webData:result.webData,preQ,ratings,ranked,cfg:result.cfg,index:result.index || index,writes,network};
 }finally{if(oldOffline===undefined)delete process.env.OFFLINE;else process.env.OFFLINE=oldOffline;}
}
// 22/10/2026: hide series in friends' film rows. PRODUCT.md records the extension to Discover collections
// as an interpretation of that session already integrated in a4c38b3, not a new approval from Marco.
// Apply that fixed rule ONLY to the reference's friends builder, before sorting and taking its cap.
// Do not call today's rows or noRecord helper: a change there must still turn the historical comparison red.
function rowsWithFriendsRecordRule(rows, cache) {
 const named = new Set(Object.values(cache.movie || {}).flatMap(e => e?.v?.imdb ? [e.v.imdb] : []));
 const keep = r => {
  if (!/^tt\d+$/.test(r?.imdbId || '') || named.has(r.imdbId)) return true;
  const found = cache.find?.[r.imdbId];
  return !(found ? found.v == null || cache.movie?.[found.v]?.v === null : !!r.tmdbId && cache.movie?.[r.tmdbId]?.v === null);
 };
 return {...rows, buildFriendRows: options => rows.buildFriendRows({...options,
  view: {...options.view, films: Object.fromEntries(Object.entries(options.view.films).filter(([,r]) => keep(r)))}})};
}
// The rule Marco approved on 13/10/2026, as FIXED text (not read from lib/pool.js): the pin stays a second guard on the year rule, so a change to lib/pool.js yearOf turns it red.
const APPROVED_YEAR_RULE='(rec) => rec.year || (rec.detail && rec.detail.imdb === rec.id && rec.detail.year) || null';
function poolWithCurrentYear(root){const file=path.join(root,'lib/pool.js'),src=fs.readFileSync(file,'utf8'),old='const yearOf = (rec) => (rec.detail && rec.detail.year) || rec.year || null;';
 if(src.split(old).length!==2)throw Error('reference lib/pool.js: the year rule is not where the correction expects it');
 const M=require('node:module'),m=new M(file,null);m.filename=file;m.paths=M._nodeModulePaths(path.dirname(file));m._compile(src.replace(old,'const yearOf = '+APPROVED_YEAR_RULE+';'),file);return m.exports;}
function identities(plan){return {board:plan.board.map(r=>({id:r.id,name:r.name,items:r.items.map(i=>i.id)})),discover:plan.discover.map(c=>({id:c.id,name:c.name,options:c.options.map(o=>({label:o.label,items:o.items.map(i=>i.id)}))}))};}
// Catalogs Marco approved after the v2.3 reference, which the reference cannot have; everything else in the plan must still match it.
// "Loved by your directors": Board row + Discover menu (Marco, 11/10/2026, lib/directors-loved.js; test/directors-loved.test.js holds them).
const SINCE_REFERENCE={board:['directors-loved'],discover:['mood-engine-directors-loved']};
function withoutNew(plan){return {board:plan.board.filter(r=>!SINCE_REFERENCE.board.includes(r.id)),discover:plan.discover.filter(c=>!SINCE_REFERENCE.discover.includes(c.id))};}
// The v2.1 pin with the homonym correction (Marco, 11/10/2026). The approved list (lib/search-links-approved.json) is compared exactly only
// on the inputs it was measured on; on inputs the nightly build rewrote the reference applies lib/search-link.js and nothing is compared
// about the list (the build logs what entered and left). Everything else must match either way.
const SEARCH_INPUTS=n=>n==='cache/tmdb.json'||n==='cache/friends.json'||n.startsWith('data/letterboxd/');
function searchInputs(root){return Object.fromEntries(Object.entries(inputHashes(root)).filter(([n])=>SEARCH_INPUTS(n)));}
// Marco, 13/10/2026: Tonight holds 10 films (the reference's six) and config.json exclude.films takes Paterson out of every recommendation (the reference
// has it): the pin runs with both switched off, like the moods and lists above. test/tonight-exclude.test.js holds them. Same day, the row sizes (row 30 → 50,
// discover 60 → 100, friends 30 → 50, watchlist 40 → 100): the pin runs with the reference's; test/row-sizes.test.js holds the new ones.
// Marco, 14/10/2026 (PR5, the Board of 54 rows in config.json): the reference has no `board` (the v2 family and its rows are proven by their own tests: test/legacy-parity.test.js,
// test/board-*.test.js, test/special-rows.test.js, test/row-filters.test.js), so the pin runs without it, and with the legacy moods alone (MOODS_AFTER_V23 below).
// Marco, 19/10/2026 (questionnaire): Tonight now draws evenly (config.json tonight.bias 1); the reference draws with the exponent 1.6, so the pin runs with tonight.bias 1.6, the same
// way it runs with the reference's sizes: the pin proves that the knob at 1.6 gives the reference's Tonight exactly. test/tonight-draw.test.js holds the uniform draw itself.
// Marco, 14/11/2026 (questionnaire, "Bigger pool + 30 days without repeating"): Tonight draws from the top 40 of each mood and holds back the films of its last 30 days (config.json tonight.depth and
// tonight.noRepeatDays, lib/tonight-memory.js); the reference draws from the top 12 and remembers nothing, so the pin runs with depth 12 and noRepeatDays 0 (no memory file is read, whatever the caches of the
// reference folder hold): it proves that the two knobs give the reference's Tonight exactly. Without them the pin is red on the row `tonight` alone (measured 14/11/2026).
// What this pin does NOT do (review of 14/11/2026, R9): it never exercises the new Tonight. With the two knobs set back it proves only that the code can still give the row of before; a defect in the top 40,
// in the 30 days or in the relief leaves it green. The new rule is held by test/tonight-memory.test.js (worlds made in the test) and, on the real build with a planted memory, by
// test/tonight-exclude.test.js ("build --cache-only with a planted tonight-memory.json").
// Marco, 22/10/2026 ~06:40 UTC: the music rule (config.json music.needsEvidence, lib/pool.js musicGate) is in every row that recommends; the reference has no such rule, so the pin runs with it switched off, the way it runs with
// the reference's sizes and Tonight's exponent: it proves the build with the knob off is the reference's selection. The rule itself is proven by test/music-all-rows.test.js (a small world through every builder) and test/music-all-rows-build.test.js (the real caches on and off).
// Marco, 22/10/2026 (~04:05 UTC, short names of the lists): the reference names a Discover option by the list's `name`; the current build names it by `short` (config.json lists[].short, one line on the
// phone), so the pin runs without that field and the option labels are the full names on both sides. The short names themselves are held by worker/test/list-short-names.test.js and test/index-export.test.js.
const SINCE_REFERENCE_CONFIG=({board:_board,...c})=>({...c,lists:(c.lists||[]).map(({short:_short,...l})=>l),sizes:{...c.sizes,tonight:6,row:30,discover:60,watchlist:40,friends:30},exclude:{films:[]},tonight:{bias:1.6,depth:12,noRepeatDays:0},music:{needsEvidence:false}});
// Moods added after the v2.3 reference: the pin below runs with them switched off.
// slow (11/10/2026), then the 21 moods of the v2 Board (14/10/2026, PR5: config.json "moods" holds them, board.legacyMoods keeps them out of the legacy family). One id missing here and that mood
// reaches the capture of the current build while the reference has none: the pin turns red.
const MOODS_AFTER_V23=['slow','noir','whodunit','mindbender','lol','deadpan','gentle','rainy','road','summer','slasher','horror-comedy','adrenaline','swoon','twotalk','comingofage','docs','midnight','hidden','anthology','winter','visual'];
async function homonymPin(root,reference){const a=require('node:assert/strict'),Q=require(path.join(path.resolve(root),'lib/recommendation-quality')),APPROVED=JSON.parse(fs.readFileSync(path.join(path.resolve(root),'lib/search-links-approved.json'),'utf8'));
 const approvedInputs=JSON.stringify(searchInputs(root))===JSON.stringify(APPROVED.inputs);
 // Marco, 11/10/2026, catalog expansion: the pin holds the build with the expansion switched off (the reference's lists, no list signal)
 // with the moods added after v2.3 (slow) switched off, and with no film vouched for by a favourite director's love (the two catalogs
// "Loved by your directors" are left out by withoutNew).
  const refConfig=JSON.parse(fs.readFileSync(path.join(path.resolve(reference),'config.json'),'utf8'));
  // The historical comparison uses the same friends, order and friend lists on both sides. The seven-friend expansion
  // approved on 28/10 and the later list removal are guarded by friends.test.js / friends-cards-build.test.js;
  // they must not change the inputs of this older selection comparison. Only the VM's config is mapped.
  const now=await capture(root,{neutralLists:refConfig.lists.map(l=>l.id),dropMoods:MOODS_AFTER_V23,neutralLoved:true,mapConfig:c=>({...SINCE_REFERENCE_CONFIG(c),friends:refConfig.friends,friendLists:refConfig.friendLists})}),old=await capture(reference,{noFloor:true,floorFirst:now.ratings,identityFix:true,yearFix:true,ownRecord:true,friendsRecordFix:true,ratingsIgnored:require('../lib/friends').ratingsPolicy(JSON.parse(fs.readFileSync(path.join(path.resolve(root),'config.json'),'utf8'))),searchLinks:approvedInputs?APPROVED.links:'rule'});
 if(approvedInputs){const order=x=>[...x].map(e=>JSON.stringify(e)).sort();a.deepEqual(order(now.refusals),order(APPROVED.links.map(e=>e.slice(0,5))),'the refused search hits changed on the approved inputs: a new list needs Marco');}
 // Marco, 13/10/2026: every row refills the place the rule opens, so the reference runs over the films that pass it (floorFirst) and the ranked lists of the current build, which keep every film that fits (the picker, the Moods slices), are compared on the films that pass.
 a.deepEqual(Object.fromEntries(Object.entries(now.ranked).map(([k,v])=>[k,v.filter(x=>Q.qualifies(now.ratings.get(x.id)))])),old.ranked);a.deepEqual(identities(withoutNew(now.preQ)),identities(old.plan));a.deepEqual(identities(withoutNew(now.plan)),identities(Q.applyPlan(structuredClone(old.plan),now.ratings)));return {approvedInputs,now};}
module.exports={capture,inputHashes,identities,withoutNew,SINCE_REFERENCE,SINCE_REFERENCE_CONFIG,MOODS_AFTER_V23,searchInputs,homonymPin};
