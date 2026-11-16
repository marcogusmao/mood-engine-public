'use strict';
const I = require('./person-input');
const DATASETS = ['watched', 'ratings', 'watchlist', 'likes', 'diary', 'following'];
const FILM = /^https:\/\/letterboxd\.com\/film\/([a-z0-9][a-z0-9-]{0,199})\/$/;
const SHORT = /^https:\/\/boxd\.it\/[A-Za-z0-9]{1,32}$/;
const USER = /^[a-z0-9_]{1,40}$/;
const validUser = user => typeof user === 'string' && USER.test(user) && !['__proto__','constructor','prototype'].includes(user);
const bounded = (s, n) => typeof s === 'string' && s.length <= n && !/[\x00-\x1f\x7f<>]/.test(s);
function rows(dataset, items) {
 if (!Array.isArray(items) || items.length > 50000) throw Error('Invalid collection bounds');
 return items.map(r => {
  if (dataset === 'following') {
   if (!validUser(r.user) || r.user === 'friend-a' || !bounded(r.name, 200)) throw Error('Invalid following record');
   return {user:r.user, name:r.name};
  }
  if (!(FILM.test(r.uri) || SHORT.test(r.uri)) || !bounded(r.title, 500) || !r.title || !(r.year === null || Number.isInteger(r.year) && r.year >= 1800 && r.year <= 2200)) throw Error('Invalid film record');
  if ((dataset === 'ratings' || dataset === 'watched' && r.rating !== undefined) && !(r.rating === null || Number.isFinite(r.rating) && r.rating >= 0.5 && r.rating <= 5 && Number.isInteger(r.rating * 2))) throw Error('Invalid rating');
  return {uri:r.uri, title:r.title, year:r.year, date:null, ...(['ratings','watched'].includes(dataset) && r.rating !== undefined ? {rating:r.rating} : {})};
 });
}
// Ratings observations cover ALL films, including explicit nulls. The total is not a rated-film count.
function envelope({dataset,items=[],expectedCount=null,terminalPage=false,capped=false,repeatedPage=false,emptyConfirmed=false,reason=null,startedAt,completedAt,subjectUser='friend-a'}) {
 if (!DATASETS.includes(dataset) || !validUser(subjectUser)) throw Error('Invalid collection context');
 items = rows(dataset, items);
 const unique = new Set(items.map(r => r.uri || r.user)).size === items.length;
 const complete = terminalPage && !capped && !repeatedPage && unique && Number.isInteger(expectedCount) && expectedCount === items.length && (items.length > 0 || emptyConfirmed) && !reason;
 return {personId:'friend-a',subjectUser,dataset,mode:'full',startedAt,completedAt:complete?completedAt:null,expectedCount,observedCount:items.length,countScope:['watched','ratings'].includes(dataset)?'watched-films':dataset,terminalPage,capped,repeatedPage:repeatedPage||!unique,emptyConfirmed,state:complete?'complete':items.length?'partial':'unavailable',reason:complete?null:reason||'COMPLETENESS_UNPROVEN',items};
}
// Explicit URI -> canonical URI / IMDb evidence only. No title/year joins.
function identityResolver({identities={}, films={}, links=[]}={}) {
 const targets = new Map();
 const add = (uri, canonical) => { if (!(SHORT.test(uri) || FILM.test(uri)) || !FILM.test(canonical)) return; if (!targets.has(uri)) targets.set(uri,new Set()); targets.get(uri).add(canonical); };
 const imdb = new Map();
 for (const [slug, f] of Object.entries(films)) if (/^tt\d{7,10}$/.test(f.imdbId)) { if (!imdb.has(f.imdbId)) imdb.set(f.imdbId,[]); imdb.get(f.imdbId).push(`https://letterboxd.com/film/${slug}/`); }
 for (const [uri, value] of Object.entries(identities)) {
  if (!value || typeof value !== 'object') continue;
  if (value.canonicalUri) add(uri,value.canonicalUri);
  for (const canonical of imdb.get(value.imdbId) || []) add(uri,canonical);
 }
 for (const [uri, canonical] of links) add(uri,canonical);
 return uri => targets.has(uri) ? (targets.get(uri).size === 1 ? [...targets.get(uri)][0] : null) : FILM.test(uri) ? uri : null;
}
function merge(history, result, {resolve=uri=>uri}={}) {
 I.validateHistory(history);
 if (result.personId !== 'friend-a' || result.subjectUser !== 'friend-a' || !DATASETS.includes(result.dataset)) throw Error('Collection owner mismatch');
 const h=structuredClone(history), k=result.dataset, evidence=envelope(result);
 if (result.state === 'complete' && evidence.state !== 'complete') throw Error('Invalid completeness evidence');
 // A failed read changes coverage only. In particular, diary rows are sessions,
 // so indexing them by film would erase rewatches even with no new observations.
 if (evidence.state === 'unavailable') {
  const prior=h.coverage[k];
  h.coverage[k]={...prior,state:!prior||prior.state==='unknown'?'unknown':'stale',source:prior?.source||'unknown',reason:evidence.reason,observedCount:0,traversalCount:0,traversalCountScope:evidence.countScope,observation:{state:'unavailable',attemptedAt:result.startedAt,reason:evidence.reason}};
  return h;
 }
 const complete=evidence.state === 'complete', old=h[k]||[], key=r=>k==='following'?r.user:resolve(r.uri);
 const prior=new Map(old.map(r=>[key(r)||r.uri,r]));
 const preferred=new Map();
 if(k!=='following') for(const name of ['watched','ratings','likes','diary','watchlist']) for(const r of h[name]) { const id=resolve(r.uri); if(id&&!preferred.has(id)) preferred.set(id,r.uri); }
 // Keep unresolved export identities, even after a complete public traversal.
 const retained=complete?old.filter(r=>!key(r)):old;
 const m=new Map(retained.map(r=>[key(r)||r.uri,r]));
 for (const r of evidence.items) {
  const id=key(r)||r.uri, previous=prior.get(id);
  if (k==='ratings' && r.rating===null) { if (complete) m.delete(id); continue; }
  const clean={...r}; if(k==='watched') delete clean.rating;
  m.set(id,{...clean,...(preferred.has(id)?{uri:preferred.get(id)}:{}),...(previous?.uri?{uri:previous.uri,date:k==='ratings'&&previous.rating!==r.rating?null:previous.date}: {})});
 }
 h[k]=[...m.values()];
 const unresolved=complete && retained.length>0;
 const source=complete&&!unresolved||!retained.length||h.coverage[k]?.source==='public'?'public':'mixed';
 h.coverage[k]={...(h.coverage[k]||{}),state:complete&&!unresolved?'complete':'stale',source,reason:unresolved?'IDENTITY_UNRESOLVED':evidence.reason,observedCount:k==='ratings'?evidence.items.filter(r=>r.rating!==null).length:evidence.observedCount,traversalCount:evidence.observedCount,traversalCountScope:evidence.countScope,observation:{state:evidence.state,attemptedAt:result.startedAt,reason:evidence.reason}};
 if (complete&&!unresolved) h.coverage[k].completedAt=result.completedAt;
 return h;
}
async function traverse({dataset,http,parse,startedAt,maxPages=300,clock=Date.now,subjectUser='friend-a'}) {
 if(!validUser(subjectUser)) throw Error('Invalid collection subject');
 const prefix=`https://letterboxd.com/${subjectUser}/${['watched','ratings'].includes(dataset)?'films':dataset}/`;
 const visited=new Set(),seen=new Set(),items=[];let next=prefix,expectedCount=null,emptyConfirmed=false;
 const result=extra=>envelope({dataset,subjectUser,items,expectedCount,emptyConfirmed,startedAt,...extra});
 try {
  while(next) {
   if(visited.has(next)) return result({repeatedPage:true});
   if(visited.size>=Math.min(maxPages,dataset==='following'?40:300)) return result({capped:true});
   if(!Number.isFinite(Date.parse(startedAt)) || clock()-Date.parse(startedAt)>30*60*1000) throw Error('SOURCE_DEADLINE');
   const expected=visited.size===0?prefix:`${prefix}page/${visited.size+1}/`;
   if(next!==expected) throw Error('SOURCE_NEXT_INVALID');
   visited.add(next);
   const response=await http(next);
   if(response.status!==200 || (response.url && response.url!==next)) throw Error('SOURCE_UNAVAILABLE');
   const text=response.text;
   if(typeof text!=='string'||Buffer.byteLength(text)>2*1024*1024||/challenge-platform|cf-chl-|<title>\s*Just a moment|captcha challenge/i.test(text)) throw Error('SOURCE_UNAVAILABLE');
   const page=parse(text,next), batch=rows(dataset,page.items);
   if(visited.size===1) { expectedCount=page.expectedCount;emptyConfirmed=page.emptyConfirmed===true; }
   else if(page.expectedCount!=null && page.expectedCount!==expectedCount) throw Error('SOURCE_COUNT_CHANGED');
   if(batch.some(r=>seen.has(r.uri||r.user))) return result({repeatedPage:true});
   for(const r of batch) { seen.add(r.uri||r.user);items.push(r); }
   if(items.length>50000) throw Error('SOURCE_BOUNDS');
   next=page.next?new URL(page.next,prefix).href:null;
  }
  return result({terminalPage:true,completedAt:new Date(clock()).toISOString()});
 } catch { return result({reason:'SOURCE_UNAVAILABLE'}); }
}
function publicCollectors({http,capturedAt,clock=Date.now,links=[],subjectUser='friend-a',maxPages=300}) {
 const F=require('./friends'), L=require('./lists');
 if(!validUser(subjectUser)) throw Error('Invalid collection subject');
 const collect=dataset=>traverse({dataset,subjectUser,maxPages,http:async url=>{const r=await http.get(url);if(r.url!==url)throw Error('SOURCE_SUBJECT_MISMATCH');return r;},startedAt:capturedAt,clock,parse:(text,url)=>{
  const owner=text.match(/\bdata-person="([^"]+)"/)?.[1];
  if(owner&&owner!==subjectUser)throw Error('SOURCE_SUBJECT_MISMATCH');
  const pageNo=Number(new URL(url).pathname.match(/page\/(\d+)\//)?.[1]||1);
  const next=F.parseNext(text);
  const section=dataset==='watched'?'films':dataset;
  const forward=[...text.matchAll(/href="([^"]+)"/g)].some(m=>{try{const u=new URL(m[1],url),p=u.pathname.match(new RegExp('^/'+subjectUser+'/'+section+'/page/(\\d+)/$'));return u.origin==='https://letterboxd.com'&&p&&Number(p[1])>pageNo;}catch{return false;}});
  if(!next&&forward) throw Error('SOURCE_NEXT_UNPARSED');
  if(dataset==='following') return {items:L.parseFollowingPage(text),expectedCount:null,next};
  const grid=text.match(/<ul class="(?:grid|poster-list)[ "][^>]*>([\s\S]*?)<\/ul>/);
  if(!grid) throw Error('SOURCE_GRID_MISSING');
  const items=[];
  for(const chunk of grid[1].matchAll(/<li\b[^>]*class="(?:griditem|posteritem)[^"]*"[^>]*>([\s\S]*?)<\/li>/g)) {
   const parsed=F.parseFilmsPage(chunk[0]);
   if(parsed.length!==1) throw Error('SOURCE_POSTER_INVALID');
   const r=parsed[0], uri=`https://letterboxd.com/film/${r.slug}/`;
   const name=F.decode((chunk[1].match(/data-item-name="([^"]*)"/)||[])[1]||'').replace(/\s*\(\d{4}\)\s*$/,'');
   const raw=(chunk[1].match(/data-postered-identifier=(['"])(.*?)\1/)||[])[2];
   if(raw) { const id=JSON.parse(F.decode(raw)); if(id.type==='film' && /^[A-Za-z0-9]{1,32}$/.test(id.lid)) links.push([`https://boxd.it/${id.lid}`,uri]); }
   items.push({uri,title:name||r.title,year:r.year,date:null,...(dataset==='watched'?{rating:r.rating}: {})});
  }
  // The reviewed captures do not prove an empty-state or following total schema.
  return {items,expectedCount:dataset==='watched'?F.parseFilmsTotal(text):L.parseWatchlistTotal(text),emptyConfirmed:false,next};
 }});
 let films;
 return {watched:async()=>{films=await collect('watched');return films;},ratings:async()=>{films=films||await collect('watched');return {...films,dataset:'ratings'};},watchlist:()=>collect('watchlist'),following:()=>collect('following')};
}
async function refresh(history,{capturedAt,collectors={},identities={},films={},links=[]}) {
 let h=structuredClone(history);
 // Collect first: identity links from watchlist also resolve earlier watched/ratings rows.
 const results=[];
 for(const dataset of DATASETS) {
  try { const result=collectors[dataset]?await collectors[dataset]():envelope({dataset,startedAt:capturedAt,reason:'MARKUP_UNVERIFIED'}); if(result.dataset!==dataset) throw Error('Collection dataset mismatch'); results.push(result); }
  catch { results.push(envelope({dataset,startedAt:capturedAt,reason:'SOURCE_UNAVAILABLE'})); }
 }
 const resolve=identityResolver({identities,films,links});
 for(const r of results) h=merge(h,r,{resolve});
 return h;
}
module.exports={envelope,merge,traverse,refresh,publicCollectors,identityResolver,DATASETS};

const CHALLENGE = /challenge-platform|cf-chl-|<title>\s*Just a moment|captcha challenge/i;
// One budget shared by Will, followed accounts and metadata. No retries or redirects.
function boundedHttp({http,fetchImpl=globalThis.fetch,clock=Date.now,limits={}}={}) {
 const bound=(key,fallback,max)=>Number.isInteger(limits[key])&&limits[key]>0?Math.min(limits[key],max):fallback;
 const maxRequests=bound('maxRequests',400,400),maxMs=bound('maxMs',300000,300000),requestMs=bound('requestMs',15000,15000);
 const start=clock(),wallStart=Date.now();let requests=0,stopped=null;
 const elapsed=()=>Math.max(clock()-start,Date.now()-wallStart);
 const state=()=>({requests,maxRequests,stopped,elapsedMs:elapsed()});
 return {state,async get(url) {
  if(stopped)throw Error(stopped);
  if(requests>=maxRequests||elapsed()>=maxMs){stopped='RUN_BUDGET';throw Error(stopped);}
  const u=new URL(url);
  if(u.origin!=='https://letterboxd.com'||u.search||u.hash||u.username||u.password)throw Error('SOURCE_URL');
  requests++;
  const controller=new AbortController();let timer;
  try {
   const read=async()=>{
    if(http)return http.get(url,{signal:controller.signal});
    const r=await fetchImpl(url,{redirect:'manual',signal:controller.signal,headers:{'User-Agent':'MoodEngine/1.0','Accept-Language':'en-US,en;q=0.9'}});
    if(r.status!==200){await r.body?.cancel();return {status:r.status,url:r.url,text:''};}
    const chunks=[];let size=0;const reader=r.body.getReader();
    try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024)throw Error('SOURCE_BOUNDS');chunks.push(Buffer.from(value));}}finally{await reader.cancel();}
    return {status:r.status,url:r.url,text:Buffer.concat(chunks).toString('utf8')};
   };
   const r=await Promise.race([read(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('SOURCE_TIMEOUT'));},Math.max(1,Math.min(requestMs,maxMs-elapsed())));})]);
   if(r.status===403||r.status===429||CHALLENGE.test(r.text||'')){stopped='SOURCE_STOP';throw Error(stopped);}
   if(elapsed()>=maxMs){stopped='RUN_BUDGET';throw Error(stopped);}
   if(typeof r.text!=='string'||Buffer.byteLength(r.text)>2*1024*1024)throw Error('SOURCE_BOUNDS');
   return r;
  }catch(e){if(e.message==='SOURCE_TIMEOUT')stopped='SOURCE_TIMEOUT';throw e;}
  finally{clearTimeout(timer);}
 }};
}
function mergeAccount(previous,result,user) {
 if(!validUser(user)||user==='friend-a'||result.subjectUser!==user||result.personId!=='friend-a'||!['watched','watchlist'].includes(result.dataset))throw Error('Account subject mismatch');
 if(previous?.subjectUser && previous.subjectUser!==user)throw Error('Account cache subject mismatch');
 const evidence=envelope(result);
 if(result.state==='complete'&&evidence.state!=='complete')throw Error('Invalid completeness evidence');
 // A failed read cannot downgrade or rewrite a previous complete snapshot. Attempt status lives separately.
 if(evidence.state==='unavailable')return previous;
 const out=structuredClone(previous||{subjectUser:user,films:[],watchlist:[]}), field=result.dataset==='watched'?'films':'watchlist',complete=evidence.state==='complete';
 out.subjectUser=user;
 const old=new Map((out[field]||[]).map(r=>[r[0],r])), merged=complete?new Map():new Map(old);
 for(const r of evidence.items) {
  const slug=FILM.exec(r.uri)?.[1];if(!slug)throw Error('Account film identity missing');
  const prior=old.get(slug),rating=!complete&&prior?prior[3]:r.rating;
  merged.set(slug,[slug,r.title,r.year,...(field==='films'?[rating??null]:[])]);
 }
 out[field]=[...merged.values()];out[field+'Partial']=!complete;
 if(complete)out[field+'At']=result.completedAt;
 out.coverage={...(out.coverage||{}),[field]:{state:complete?'complete':'partial',subjectUser:user,observedCount:evidence.observedCount,expectedCount:evidence.expectedCount,reason:evidence.reason,...(complete?{completedAt:result.completedAt}:out.coverage?.[field]?.completedAt?{completedAt:out.coverage[field].completedAt}:{})}};
 return out;
}
async function acquireFollowed(cache,{following,http,capturedAt,clock=Date.now,maxAccounts=40,maxPages=40,maxMetadata=40}) {
 if(cache.following?.user && cache.following.user!=='friend-a')throw Error('Following cache owner mismatch');
 const people=rows('following',following),out=structuredClone(cache);
 out.users||={};out.films||={};
 const cap=(n,max)=>Number.isInteger(n)&&n>=0?Math.min(n,max):max;
 const attempts=[],metadata=new Set();let processed=0;
 for(const person of people.slice(0,cap(maxAccounts,40))) {
  if(http.state().stopped)break;
  const user=person.user,links=[], collectors=publicCollectors({http,capturedAt,clock,links,subjectUser:user,maxPages:cap(maxPages,40)});
  const old=Object.hasOwn(out.users,user)?out.users[user]:undefined;
  if(old?.subjectUser && old.subjectUser!==user)throw Error('Account cache subject mismatch');
  let record=old;
  for(const dataset of ['watched','watchlist']) {
   if(http.state().stopped)break;
   const result=await collectors[dataset]();
   attempts.push({subjectUser:user,dataset,state:result.state,reason:result.reason,observedCount:result.observedCount});
   record=mergeAccount(record,result,user);
   for(const r of result.items) {const slug=FILM.exec(r.uri)?.[1];if(slug)metadata.add(slug);}
  }
  if(record && record!==old){
   record.name=person.name;record.identities||={};
   const resolve=identityResolver({identities:record.identities,films:out.films,links});
   for(const [uri] of links){const canonicalUri=resolve(uri);if(canonicalUri)record.identities[uri]={canonicalUri};}
   out.users[user]=record;
  }
  processed++;
 }
 // Only exact slug-addressed public film pages supply new shared facts. No title searches or account data.
 let metadataRead=0;
 for(const slug of metadata) {
  if(http.state().stopped||metadataRead>=cap(maxMetadata,40))break;
  if(out.films[slug]?.imdbId)continue;
  const url=`https://letterboxd.com/film/${slug}/`;metadataRead++;
  try {
   const r=await http.get(url);if(r.status!==200||r.url!==url)continue;
   const f=require('./friends').parseFilmPage(r.text);
   if(!/^tt\d{7,10}$/.test(f.imdbId)||!bounded(f.title,500)||!f.title||!(f.year===null||Number.isInteger(f.year)&&f.year>=1800&&f.year<=2200))continue;
   // Conflicting canonical markup is not evidence for the requested film.
   const canonicalTags=[...r.text.matchAll(/<link\b[^>]*>/gi)].filter(m=>/\brel=["']canonical["']/i.test(m[0]));
   if(canonicalTags.some(m=>m[0].match(/\bhref=["']([^"']+)["']/i)?.[1]!==url))continue;
   out.films[slug]={title:f.title,year:f.year,imdbId:f.imdbId,tmdbId:Number.isSafeInteger(f.tmdbId)&&f.tmdbId>0?f.tmdbId:null,tmdbType:f.tmdbType==='movie'?'movie':null,t:clock(),v:2,...(Number.isFinite(f.rating)&&f.rating>=0&&f.rating<=5?{r:f.rating}:{}),...(Number.isSafeInteger(f.ratings)&&f.ratings>=0?{rn:f.ratings}:{}),...(Number.isFinite(f.runtime)&&f.runtime>0&&f.runtime<=10000?{rt:f.runtime}:{}),c:f.countries.filter(c=>bounded(c,100)).slice(0,30)};
  }catch{/* Unavailable metadata does not erase an existing record. */}
 }
 out.followedAcquisition={personId:'friend-a',processed,totalAccounts:people.length,remaining:people.length-processed,metadataRead,attempts,...http.state()};
 return out;
}
module.exports.boundedHttp=boundedHttp;
module.exports.mergeAccount=mergeAccount;
module.exports.acquireFollowed=acquireFollowed;
