'use strict';
// Validate normalized private content before any restore writes. These checks never
// project/strip fields: malformed input must fail even when its digest is correct.
const S = require('./learning/schema');
const need = (ok, message='Invalid personal input') => S.assert(ok, message);
const object = v => need(v !== null && typeof v === 'object' && !Array.isArray(v));
const keys = S.keys;
const datasets = ['watched','ratings','watchlist','likes','diary','following'];
const user = v => need(typeof v === 'string' && /^[a-z0-9_]{1,40}$/.test(v) && !['__proto__','constructor','prototype','friend-a'].includes(v), 'Invalid followed user');
const text = (v, max=8192) => need(typeof v === 'string' && v.length <= max && !v.includes('\0'));
const uri = v => need(typeof v === 'string' && /^https:\/\/(?:boxd\.it\/[A-Za-z0-9]+|letterboxd\.com\/film\/[a-z0-9][a-z0-9-]*\/)$/.test(v) && v.length <= 8192, 'Invalid film URI');
const slug = v => need(require('./friends').validSlug(v) && v.length <= 8192);
const count = v => need(Number.isSafeInteger(v) && v >= 0);
const year = v => need(v === null || Number.isInteger(v) && v >= 1800 && v <= 2200);
const rating = v => { if(v !== null) S.rating(v); };
const day = v => { if(v !== null) need(S.day(v),'Invalid calendar date'); };
const bool = v => need(typeof v === 'boolean');
const reason = v => { if(v !== null) need(typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(v),'Invalid reason'); };
const list = (v, check, max=50000) => { need(Array.isArray(v) && v.length <= max); v.forEach(check); };
const unique = (v, key) => need(new Set(v.map(key)).size === v.length,'Duplicate normalized identity');
const optional = (o,k,check) => { if(Object.hasOwn(o,k)) check(o[k]); };
function identities(v) {
 object(v);
 for(const [key,r] of Object.entries(v)) {
  uri(key); keys(r,['canonicalUri','imdbId'],[]); need(Object.keys(r).length>0);
  optional(r,'canonicalUri',v=>{uri(v);need(v.startsWith('https://letterboxd.com/film/'));});
  optional(r,'imdbId',S.filmId);
 }
}
function coverage(v, required=datasets.slice(0,5)) {
 keys(v,datasets,required);
 for(const [k,r] of Object.entries(v)) {
  keys(r,['state','source','reason','observedCount','traversalCount','traversalCountScope','completedAt','observation'],['state','source']);
  need(['unknown','complete','stale'].includes(r.state)); need(['export','public','mixed','unknown'].includes(r.source));
  optional(r,'reason',reason); for(const n of ['observedCount','traversalCount']) optional(r,n,count);
  optional(r,'traversalCountScope',s=>need(s===(['ratings','watched'].includes(k)?'watched-films':k)));
  optional(r,'completedAt',S.iso);
  optional(r,'observation',o=>{keys(o,['state','attemptedAt','reason']);need(['unavailable','partial','complete'].includes(o.state));S.iso(o.attemptedAt);reason(o.reason);});
 }
}
function history(h) {
 keys(h,['schemaVersion','personId','letterboxdUser','importedAt','sourceRequestId','coverage',...datasets],['schemaVersion','personId','letterboxdUser','importedAt','sourceRequestId','coverage',...datasets.slice(0,5)]);
 need(h.schemaVersion===1 && h.personId==='friend-a' && h.letterboxdUser==='friend-a','Invalid personal history identity');
 S.iso(h.importedAt); requestId(h.sourceRequestId); coverage(h.coverage);
 for(const k of datasets.slice(0,5)) {
  list(h[k],r=>{
   const fields=['uri','title','year','date',...(['ratings','diary'].includes(k)?['rating']:[]),...(k==='diary'?['entryId','watchedDate','rewatch']:[])];
   keys(r,fields); uri(r.uri);text(r.title,512);need(r.title.length>0);year(r.year);day(r.date);
   if(['ratings','diary'].includes(k)) rating(r.rating);
   if(k==='diary'){need(typeof r.entryId==='string' && /^zip:\d+$/.test(r.entryId));day(r.watchedDate);bool(r.rewatch);}
  });
  unique(h[k],r=>k==='diary'?r.entryId:r.uri);
 }
 optional(h,'following',v=>{list(v,r=>{keys(r,['user','name']);user(r.user);text(r.name,200);});unique(v,r=>r.user);});
 return h;
}
function requestId(v) { need(typeof v==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v),'Invalid source request'); }
function tuples(v, kind) {
 list(v,r=>{need(Array.isArray(r) && r.length===(kind==='films'?4:kind==='rss'?5:3));slug(r[0]);text(r[1],512);year(r[2]);if(kind!=='watchlist')rating(r[3]);if(kind==='rss')day(r[4]);});
 if(kind!=='rss')unique(v,r=>r[0]);
}
function friends(c,h) {
 keys(c,['version','films','users','lists','following','followedAcquisition'],['version','films','users','lists']);need(c.version===1);
 object(c.films);object(c.users);object(c.lists);need(Object.keys(c.lists).length===0,'Personal friend lists are not emitted');
 // Account records must be supported by this person's normalized following set.
 const allowed = new Set((h.following||[]).map(r=>r.user));
 optional(c,'following',f=>{
  keys(f,['user','users','partial','fetchedAt']);need(f.user==='friend-a','Following cache owner mismatch');bool(f.partial);if(f.fetchedAt!==null)S.iso(f.fetchedAt);
  list(f.users,r=>{need(Array.isArray(r)&&r.length===2);user(r[0]);text(r[1],200);need(allowed.has(r[0]),'Unapproved following account');});unique(f.users,r=>r[0]);
  need(S.canonical(f.users)===S.canonical((h.following||[]).map(r=>[r.user,r.name])),'Following cache differs from history');
 });
 for(const [u,r] of Object.entries(c.users)) {
  user(u);need(allowed.has(u),'Unapproved account profile');
  keys(r,['subjectUser','name','films','watchlist','filmsPartial','watchlistPartial','filmsAt','watchlistAt','coverage','identities','rss'],['subjectUser','films','watchlist']);
  need(r.subjectUser===u,'Account cache subject mismatch');optional(r,'name',v=>text(v,200));
  for(const k of ['films','watchlist']) {tuples(r[k],k);optional(r,k+'Partial',bool);optional(r,k+'At',S.iso);}
  optional(r,'rss',v=>tuples(v,'rss')); optional(r,'identities',identities);
  optional(r,'coverage',v=>{keys(v,['films','watchlist'],[]);for(const e of Object.values(v)){keys(e,['state','subjectUser','observedCount','expectedCount','reason','completedAt'],['state','subjectUser','observedCount','expectedCount','reason']);need(e.subjectUser===u);need(['complete','partial'].includes(e.state));count(e.observedCount);if(e.expectedCount!==null)count(e.expectedCount);reason(e.reason);optional(e,'completedAt',S.iso);}});
 }
 for(const [s,r] of Object.entries(c.films)) {
  slug(s); keys(r,['title','year','tmdbId','tmdbType','imdbId','t','v','r','rn','rt','c','synopsis'],[]);
  optional(r,'title',v=>{if(v!==null)text(v);});optional(r,'year',year);optional(r,'tmdbId',v=>{if(v!==null)count(v);});
  optional(r,'tmdbType',v=>need([null,'movie','tv'].includes(v)));optional(r,'imdbId',v=>{if(v!==null)S.filmId(v);});
  optional(r,'t',count);optional(r,'v',v=>need(v===2));optional(r,'r',v=>need(Number.isFinite(v)&&v>=0&&v<=5));optional(r,'rn',count);optional(r,'rt',v=>need(Number.isFinite(v)&&v>0));optional(r,'c',v=>list(v,x=>text(x,100)));optional(r,'synopsis',text);
 }
 optional(c,'followedAcquisition',r=>{
  keys(r,['personId','processed','totalAccounts','remaining','metadataRead','attempts','requests','maxRequests','stopped','elapsedMs']);need(r.personId==='friend-a');
  for(const k of ['processed','totalAccounts','remaining','metadataRead','requests','maxRequests','elapsedMs'])count(r[k]);
  need(r.processed+r.remaining===r.totalAccounts && r.requests<=r.maxRequests);reason(r.stopped);
  list(r.attempts,e=>{keys(e,['subjectUser','dataset','state','reason','observedCount']);need(allowed.has(e.subjectUser),'Unapproved account attempt');need(['watched','watchlist'].includes(e.dataset));need(['complete','partial','unavailable'].includes(e.state));reason(e.reason);count(e.observedCount);},80);
 });
}
// Shared cache envelopes are checked here; their public payload formats remain
// owned by their existing producers (TMDB/list metadata is not a private profile).
function frontMemory(c) {
 keys(c,['version','days']);need(c.version===1,'Invalid front memory version');object(c.days);
 for(const [date,films] of Object.entries(c.days)) {
  need(S.day(date),'Invalid front memory date');object(films);
  for(const [id,n] of Object.entries(films)) {S.filmId(id);need(Number.isInteger(n)&&n>=1&&n<=require('./front-shuffle').MAX_COUNT,'Invalid front memory count');}
 }
}
// cache/posters.json `failures` as lib/posters.js writes it: a cover whose every source answered 404, 410 or "not an image"; `alt` is the one look for another source.
const posterKind = v => need(['tmdb','metahub'].includes(v),'Invalid poster source');
const posterDay = v => need(S.day(v),'Invalid calendar date');
function posterFailures(c) {
 object(c);
 for(const [id,r] of Object.entries(c)) {
  S.filmId(id);keys(r,['kind','tries','code','last','next','url','alt'],['kind','tries','code','last','next','url']);
  need(r.kind==='permanent','Invalid poster failure kind');need(Number.isSafeInteger(r.tries)&&r.tries>=1);need(typeof r.code==='string'&&/^(?:404|410|not-image)(?:\+(?:404|410|not-image))*$/.test(r.code),'Invalid poster failure code');
  posterDay(r.last);posterDay(r.next);need(r.next>=r.last,'Poster retry precedes failure');need(typeof r.url==='string'&&r.url.length<=2048&&/^https:\/\/[^\s/]+\/\S*$/.test(r.url),'Invalid poster URL');
  optional(r,'alt',a=>{need(a!==null&&typeof a==='object'&&!Array.isArray(a));if(a.found===true){keys(a,['d','found','kind','ok','code']);posterKind(a.kind);bool(a.ok);need(a.ok===false);text(a.code,40);}else{keys(a,['d','found']);need(a.found===false);}posterDay(a.d);});
 }
}
function shared(name,c) {
 if(name==='cache/front-memory.json'){frontMemory(c);return;}
 if(name==='cache/mubi.json'){need(require('./mubi-cache').cacheProblems(c).length===0,'Invalid MUBI cache');return;}
 if(name==='cache/tmdb.json') {
  keys(c,['movie','recs','person','find','search'],[]);need(Object.keys(c).length>0);
  for(const [kind,records] of Object.entries(c)){object(records);for(const r of Object.values(records)){keys(r,['t','v',...(kind==='search'?['exact']:[])],['t','v']);count(r.t);optional(r,'exact',bool);}}
 } else if(name==='cache/lists.json') {
  keys(c,['version','urls','lists','menus'],['lists']);optional(c,'version',v=>need(v===1));object(c.lists);optional(c,'urls',object);optional(c,'menus',object);
 } else if(name==='cache/imdb-ratings.json') {
  keys(c,['version','date','ratings','none']);need(c.version===1);day(c.date);object(c.ratings);list(c.none,S.filmId);
  for(const [id,r] of Object.entries(c.ratings)){S.filmId(id);need(Array.isArray(r)&&r.length===2&&Number.isFinite(r[0])&&r[0]>=0&&r[0]<=10);count(r[1]);}
 } else if(name==='cache/posters.json') {
  keys(c,['version','items','failures'],['version','items']);need(c.version===1);object(c.items);optional(c,'failures',posterFailures);
  for(const [id,r] of Object.entries(c.items)){S.filmId(id);keys(r,['h','kind','s','d','switched'],['h']);need(typeof r.h==='string'&&/^[a-f0-9]{16}$/.test(r.h));optional(r,'s',v=>need(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)));optional(r,'d',v=>need(S.day(v)));optional(r,'kind',v=>need(['tmdb','metahub'].includes(v)));optional(r,'switched',v=>{keys(v,['from','to','d']);for(const k of ['from','to'])posterKind(v[k]);posterDay(v.d);});}
 }
}
// Import time is provenance, not the horizon of later public observations.
function snapshotDates(h, cache, capturedAt) {
 const ceiling=Date.parse(capturedAt), localDay=new Date(capturedAt).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
 const event=v=>need(v===null||v<=localDay,'Date beyond snapshot');
 const instant=v=>{S.iso(v);need(Date.parse(v)<=ceiling,'Coverage beyond snapshot');};
 for(const k of datasets.slice(0,5))for(const r of h[k]){event(r.date);if(k==='diary')event(r.watchedDate);}
 for(const r of Object.values(h.coverage)){optional(r,'completedAt',instant);if(r.observation)instant(r.observation.attemptedAt);}
 if(cache){
  if(cache.following?.fetchedAt!=null)instant(cache.following.fetchedAt);
  for(const r of Object.values(cache.users||{})){
   for(const k of ['filmsAt','watchlistAt'])optional(r,k,instant);
   for(const e of Object.values(r.coverage||{}))optional(e,'completedAt',instant);
   for(const row of r.rss||[])event(row[4]);
  }
 }
}
function contents(s) {
 const files=Object.fromEntries(s.files.map(f=>[f.path,f.data])),h=history(files['history.json']);
 requestId(s.sourceRequestId);need(s.sourceRequestId===h.sourceRequestId,'Snapshot source mismatch');S.iso(s.capturedAt);need(S.day(s.selectionDate));need(Date.parse(h.importedAt)<=Date.parse(s.capturedAt),'Snapshot predates import');
 snapshotDates(h,files['cache/friends.json'],s.capturedAt);
 identities(files['identities.json']);coverage(files['coverage.json']);need(S.canonical(files['coverage.json'])===S.canonical(h.coverage),'Coverage differs from history');
 for(const [name,value] of Object.entries(files))if(name==='cache/friends.json')friends(value,h);else if(name.startsWith('cache/'))shared(name,value);
 return s;
}
module.exports={history,contents};
