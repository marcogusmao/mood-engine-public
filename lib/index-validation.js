"use strict";
// One pure structural validator shared by publication, snapshots and CLI.
const { ENTRY_KEYS } = require("./index-export");
const { decode, encode, FORMAT } = require("./index-rows");
const { V2_ROW_MAX } = require("./board-shared");
const FV = require("./friend-view");
const P = require("./pool");
const validUrl = u => {
 if(typeof u!=='string'||!/^https?:\/\/\S+$/i.test(u))return false;
 try {const parsed=new URL(u);return ['http:','https:'].includes(parsed.protocol)&&!!parsed.hostname&&!parsed.username&&!parsed.password;} catch {return false;}
};
function checkIndex(part, json, problems = [], name = null) {
 const bad = m => problems.push(m);
  const TOP = ["meta", "cols", "rules", "moods", "moodMenu", "lists", "friends", "directors", "discover", "board", "rows", "rowDesc", "films"];
  const META = ["personId", "revision", "builtAt", "version", "schema", "format", "part", "separator", "today", "count", "loveStars", "minFeatureMinutes", "shortMaxMinutes", "decades", "countries", "countriesAll"];

  const check = (part, f) => {
    const label = name || (part === "full" ? "index" : `index-${part.replace(/:/g, "-")}`);
    for (const k of Object.keys(f.json)) if (!TOP.includes(k)) bad(`${label}: unexpected top-level key "${k}"`);
    for (const k of Object.keys(f.json.meta || {})) if (!META.includes(k)) bad(`${label}: unexpected meta key "${k}"`);
    if ((f.json.meta || {}).format !== FORMAT) bad(`${label}: meta.format is ${(f.json.meta || {}).format}, the Worker reads "${FORMAT}"`);
    let ix;
    try { ix = decode(f.json); } catch (e) { bad(`${label}: the rows cannot be read: ${e.message}`); return null; }
    try { raw(ix); } catch(e) { bad(e.message); return null; }
    const m = ix.meta || {};
    const rules = ix.rules; // optional: how the build's recommendation rule reached the index (the rule itself is each film's `eligible` flag)
    if (rules !== undefined && (!rules || typeof rules.rule !== "string" || typeof rules.minStars !== "number" || !(rules.minStars >= 0 && rules.minStars <= 5) || !Array.isArray(rules.exemptCatalogs) || rules.exemptCatalogs.some((c) => typeof c !== "string")))
      bad(`${label}: rules must be { rule: text, minStars: 0 to 5, exemptCatalogs: [ids] }`);
    // rules.musicExemptMoods (Marco, 22/10/2026 ~15:15 UTC): optional, never empty (the build leaves the key out when no mood is exempt), ids of moods; where the file lists its moods, every id is one of them
    if (rules && rules.musicExemptMoods !== undefined) {
      const ex = rules.musicExemptMoods;
      if (!Array.isArray(ex) || !ex.length || ex.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) || new Set(ex).size !== ex.length) bad(`${label}: rules.musicExemptMoods must be a non-empty list of different mood ids`);
      else if (Array.isArray(ix.moods) && ix.moods.length) for (const id of ex) if (!ix.moods.some((x) => x.id === id)) bad(`${label}: rules.musicExemptMoods names "${id}", which is no mood of this index`);
    }
    if (m.schema !== 1) bad(`${label}: meta.schema is ${m.schema}, the Worker reads 1`);
    if (m.part !== part) bad(`${label}: meta.part is ${m.part}, expected ${part}`);
    if (!/^\d{4}-\d\d-\d\dT/.test(String(m.builtAt)) || Number.isNaN(Date.parse(m.builtAt))) bad(`${label}: meta.builtAt "${m.builtAt}" is not a date`);
    if (!m.version) bad(`${label}: meta.version is missing`);
    if (!Array.isArray(ix.films)) { bad(`${label}: films is not a list`); return null; }
    if (m.count !== ix.films.length) bad(`${label}: meta.count ${m.count} but ${ix.films.length} films`);

    const byTt = new Map();
    const moodIds = new Set((ix.moods || []).map((x) => x.id)), listIds = new Set((ix.lists || []).map((x) => x.id));
    // the shorts (bit 16, `shortOut`; 15/11/2026): the number of this index, and whether it is an index from before the bit (not one film carries it)
    const minFeature = Number.isFinite(m.minFeatureMinutes) ? m.minFeatureMinutes : P.MIN_FEATURE_MINUTES;
    const noShortBits = !ix.films.some((e) => e && e.shortOut === true);
    for (const e of ix.films) {
      if (!/^tt\d+$/.test(String(e.tt))) { bad(`${label}: a film has id ${e.tt}, not an IMDb id`); continue; }
      if (byTt.has(e.tt)) bad(`${label}: ${e.tt} appears twice`);
      byTt.set(e.tt, e);
      const at = `${label}: ${e.tt} (${e.name})`;
      for (const k of Object.keys(e)) if (!ENTRY_KEYS.includes(k)) bad(`${at}: key "${k}" is not an allowed field`);
      if (typeof e.name !== "string" || !e.name) bad(`${at}: no name`);
      if (e.year != null && !(e.year >= 1850 && e.year <= 2100)) bad(`${at}: year ${e.year}`);
      if (e.runtime != null && !(e.runtime >= 1 && e.runtime <= 6000)) bad(`${at}: runtime ${e.runtime}`); // Letterboxd lists hold whole TV series (Twin Peaks: The Return, 1014 min; Monster, 1800)
      if (e.lbRating != null && !(e.lbRating >= 0 && e.lbRating <= 5)) bad(`${at}: lbRating ${e.lbRating}`);
      for (const k of ["taste", "quality", "rank"]) if (e[k] != null && !Number.isFinite(e[k])) bad(`${at}: ${k} is not a number`);
      if (e.seen !== undefined && e.seen !== true) bad(`${at}: seen must be true or absent`);
      if (e.watchlist !== undefined && e.watchlist !== true) bad(`${at}: watchlist must be true or absent`);
      if (e.eligible !== undefined && e.eligible !== true) bad(`${at}: eligible must be true or absent`);
      if (e.musicOut !== undefined && e.musicOut !== true) bad(`${at}: musicOut must be true or absent`);
      if (e.musicOut && e.seen) bad(`${at}: musicOut on a film marked seen (the music rule never holds back a film he has seen)`);
      if (e.shortOut !== undefined && e.shortOut !== true) bad(`${at}: shortOut must be true or absent`);
      // one definition of a short: the bit says exactly what the film's runtime and the index's own number say (lib/pool.js isShort). An index from before 15/11/2026 has no bit on any film: accepted as it was (noShortBits).
      if (!noShortBits && (e.shortOut === true) !== P.isShort(e.runtime, minFeature)) bad(`${at}: shortOut is ${e.shortOut === true} but the runtime is ${e.runtime ?? "unknown"} and a short is under ${minFeature} minutes`);
      if (typeof e.find !== "string") bad(`${at}: no search text (find)`);
      for (const k of ["seenBy", "wantBy"]) if (e[k] !== undefined && !(Number.isInteger(e[k]) && e[k] >= 0)) bad(`${at}: ${k} ${e[k]} is not a count`);
      if (e.friendsAvg !== undefined && !(e.friendsAvg >= 0.5 && e.friendsAvg <= 5)) bad(`${at}: friendsAvg ${e.friendsAvg}`);
      if (e.imdbRating !== undefined && !(e.imdbRating >= 1 && e.imdbRating <= 10)) bad(`${at}: imdbRating ${e.imdbRating}`);
      if (e.poster !== undefined && !validUrl(e.poster)) bad(`${at}: poster "${e.poster}" is not an http(s) address`);
      for (const [id, v] of Object.entries(e.moods || {})) { if (!moodIds.has(id)) bad(`${at}: mood "${id}" is not declared`); if (!Array.isArray(v) || v.length !== 2 || !v.every(Number.isFinite)) bad(`${at}: mood "${id}" is not [fit, rank]`); }
      for (const [id, pos] of Object.entries(e.lists || {})) { if (!listIds.has(id)) bad(`${at}: list "${id}" is not declared`); if (!Number.isInteger(pos) || pos < 1) bad(`${at}: list "${id}" position ${pos}`); }
      if (e.friends) {
        for (const [n, r] of e.friends.seenBy || []) if (r != null && !(r >= 0.5 && r <= 5)) bad(`${at}: ${n} rated ${r}`); // (a person who is not in friends.people cannot be decoded: the rows are refused above)
      }
    }
    for (const [id, list] of Object.entries(ix.rows || {})) {
      const d = (ix.rowDesc || {})[id];
      if (!Array.isArray(d) || d.length !== list.length || d.some((x) => typeof x !== "string")) bad(`${label}: rowDesc of row ${id} must be one text per film of the row`);
    }
    for (const id of Object.keys(ix.rowDesc || {})) if (!(id in (ix.rows || {}))) bad(`${label}: rowDesc names a row (${id}) that is not in rows`);
    const must = (tt, where) => { if (!byTt.has(tt)) bad(`${label}: ${tt} in ${where} is not among the films`); return byTt.get(tt); };
    const boardIds = (ix.board || []).map((r) => r.id);
    if (JSON.stringify(boardIds) !== JSON.stringify(Object.keys(ix.rows || {}))) bad(`${label}: rows and board do not list the same rows`);
    // the v2 family is the index with a `moodMenu`: its Board entries say where they go, the legacy ones never do (a v2 Board that leaked into the legacy index shows here)
    const v2 = ix.moodMenu !== undefined;
    for (const r of ix.board || []) {
      if (v2 && !["board", "menu"].includes(r.place)) bad(`${label}: board row ${r.id} has place ${JSON.stringify(r.place)}, expected "board" or "menu"`);
      if (!v2 && (r.place !== undefined || r.series !== undefined)) bad(`${label}: board row ${r.id} carries place/series, which only the v2 family (it has a moodMenu) uses`);
      if (r.series && (ix.rows[r.id] || []).length) bad(`${label}: series row ${r.id} holds films, the Worker builds it`);
    }
    if (v2 && (part === "full" || part === "v2-menus")) { // only these two carry the whole Board; a row's file has its own entry alone
      const place = new Map((ix.board || []).map((r) => [r.id, r.place]));
      for (const o of ix.moodMenu) if (!moodIds.has(o.id) && place.get(o.id) !== "menu") bad(`${label}: moodMenu option ${o.id} is neither a mood of the index nor a board row with place "menu"`);
      for (const r of ix.board || []) if (r.place === "menu" && !ix.moodMenu.some((o) => o.id === r.id)) bad(`${label}: board row ${r.id} has place "menu" and is not in moodMenu`);
    }
    if (v2 && part === "full") { // the frozen country menu must be one the index can serve: a name no film carries would be an empty option in the Moods menu
      const have = new Set(ix.films.flatMap((e) => e.countries || []));
      for (const c of (ix.meta || {}).countriesAll || []) if (!have.has(c)) bad(`${label}: meta.countriesAll names "${c}", and no film of the index has that country`);
    }
    if (v2) for (const [id, list] of Object.entries(ix.rows || {})) if (list.length > V2_ROW_MAX) bad(`${label}: row ${id} has ${list.length} films, more than ${V2_ROW_MAX}`);
    // The watchlist piece of a configured friend (lib/friend-view.js; Marco, 29/10/2026) is the one row that may hold a film Marco has seen: it is the FRIEND's watchlist, read with the friend's "seen".
    const friendPiece = ((ix.friends && ix.friends.people) || []).some((n) => part === FV.piecePart(FV.slugOf(n)));
    for (const [id, list] of Object.entries(ix.rows || {}))
      for (const tt of list) {
        const e = must(tt, `row ${id}`);
        if (e && e.seen && id !== "oldfriends" && !friendPiece) bad(`${label}: ${tt} (${e.name}) is marked seen and sits in row ${id}`);
        if (e && !e.eligible && id !== "oldfriends") bad(`${label}: ${tt} (${e.name}) sits in row ${id} but is not eligible as a recommendation (the build filtered the row with the same rule)`);
      }
    for (const o of (ix.friends && ix.friends.options) || [])
      for (const tt of o.ids) { if (part === "board") break; const e = must(tt, `friends option ${o.label}`); if (e && e.seen) bad(`${label}: ${tt} (${e.name}) is marked seen and sits in friends option ${o.label}`); }
    for (const o of (ix.directors && ix.directors.options) || []) {
      if (!Array.isArray(o.ids) || !Array.isArray(o.descs) || o.descs.length !== o.ids.length || o.descs.some((x) => typeof x !== "string")) { bad(`${label}: directors option ${o.label} must have one text per film`); continue; }
      if (part !== "full" && part !== "directors") continue;
      for (const tt of o.ids) { const e = must(tt, `directors option ${o.label}`); if (e && e.seen) bad(`${label}: ${tt} (${e.name}) is marked seen and sits in directors option ${o.label}`); }
    }
    // the Discover catalogs (v2 only): a list option names a list the index declares; a calculated option holds films of the index, each once, each eligible, in the whole index and in its own piece (`v2-opt:<catalog>:<option>`) alone (every other file carries `ids: []`).
    // The seen ones stay: "Include seen" shows them, the Worker hides them otherwise.
    // Marco, 28/10/2026 (proposal 5): a CURATED option (a union of lists, a card of a director) is an editorial collection with no recommendation rule, so a film that is not `eligible` may sit in it; the
    // card of a director names (`director`) the option of index.directors.options it grew from; `explore.genre` names a catalog of the file.
    if (ix.discover) {
      if (!v2) bad(`${label}: discover belongs to the v2 family (it has no moodMenu)`);
      const lovedBy = new Set(((ix.directors && ix.directors.options) || []).map((o) => o.label));
      if (ix.discover.explore && !ix.discover.catalogs.some((c) => c.id === ix.discover.explore.genre)) bad(`${label}: discover.explore.genre names the catalog "${ix.discover.explore.genre}", which the discover does not have`);
      for (const c of ix.discover.catalogs) for (const o of c.options) {
        const at = `discover ${c.id} / ${o.label}`;
        if (o.list !== undefined) { if (!listIds.has(o.list)) bad(`${label}: ${at} names the list ${o.list}, which the index does not declare`); continue; }
        if (o.director !== undefined && !lovedBy.has(o.director)) bad(`${label}: ${at} names the director option "${o.director}", which is not among the directors' options`);
        // Marco, 29/10/2026: the piece of ONE calculated option (`v2-opt:<catalog>:<option>`) carries that option's first films, with the two totals the Worker sends as X-Total; every other option of every other file has `ids: []` and no total
        const mine = part === `v2-opt:${c.id}:${o.id}`, hasTotal = o.total !== undefined || o.totalAll !== undefined;
        if (!mine && hasTotal) bad(`${label}: ${at} carries a total, which only the piece of that option does`);
        if (part !== "full" && !mine) { if (o.ids.length) bad(`${label}: ${at} carries ${o.ids.length} films, and only the whole index carries them`); continue; }
        if (mine && !(Number.isInteger(o.total) && Number.isInteger(o.totalAll) && o.total >= 0 && o.total <= o.totalAll)) bad(`${label}: ${at} must carry total and totalAll, whole numbers, total no more than totalAll`);
        if (new Set(o.ids).size !== o.ids.length) bad(`${label}: ${at} names a film twice`);
        for (const tt of o.ids) { const e = must(tt, at); if (e && !e.eligible && !o.curated) bad(`${label}: ${tt} (${e.name}) sits in ${at} but is not eligible as a recommendation`); }
      }
    }
    return ix;
  };

 return check(part,{json});
}
function keys(x,allowed,at){if(!x||typeof x!=='object'||Array.isArray(x))throw Error('Invalid index '+at);for(const k of Object.keys(x))if(!allowed.includes(k))throw Error('Unexpected index field '+at+'.'+k);}
function raw(index){
 keys(index,['meta','rules','moods','moodMenu','lists','friends','directors','discover','board','rows','rowDesc','films'],'root');
 keys(index.meta,['personId','revision','builtAt','version','schema','format','part','separator','today','count','loveStars','minFeatureMinutes','shortMaxMinutes','decades','countries','countriesAll'],'meta');
 if(index.meta.personId!==undefined || index.meta.revision!==undefined){if(index.meta.personId!=='friend-a'||!/^r-[a-f0-9]{32}$/.test(index.meta.revision||''))throw Error('Invalid person revision');}
 if(Object.hasOwn(index.meta,'format')&&index.meta.format!==FORMAT)throw Error('Invalid index format');
 for(const k of ['moods','lists','board']){if(!Array.isArray(index[k]))throw Error('Invalid index '+k);for(const x of index[k]){
  keys(x,k==='moods'?['id','label','name','alias']:k==='lists'?['id','label','short','popular','films']:['id','name','place','series'],k);
  if(k==='board'){if(x.place!==undefined&&!['board','menu'].includes(x.place))throw Error('Invalid index board place');if(x.series!==undefined&&x.series!==true)throw Error('Invalid index board series');}
  if(typeof x.id!=='string'||!/^[A-Za-z0-9_-]+$/.test(x.id))throw Error('Unsafe index menu id');
  for(const text of ['label','short','name'])if(x[text]!==undefined&&typeof x[text]!=='string')throw Error('Invalid index menu '+text);
  if(k==='lists'&&(!Number.isInteger(x.films)||x.films<0||typeof x.popular!=='boolean'))throw Error('Invalid index list metadata');
  if(index[k].filter(e=>e.id===x.id).length!==1)throw Error('Duplicate index menu id');
 }}
 for(const k of ['countries','decades'])if(!Array.isArray(index.meta[k])||index.meta[k].some(v=>typeof v!=='string'))throw Error('Invalid index meta '+k);
 if(index.meta.countriesAll!==undefined&&(!Array.isArray(index.meta.countriesAll)||index.meta.countriesAll.some(v=>typeof v!=='string')))throw Error('Invalid index meta countriesAll');
 if(index.moodMenu!==undefined){if(!Array.isArray(index.moodMenu))throw Error('Invalid index moodMenu');for(const o of index.moodMenu){keys(o,['id','label'],'moodMenu');if(typeof o.id!=='string'||!/^[A-Za-z0-9_-]+$/.test(o.id)||typeof o.label!=='string'||!o.label)throw Error('Invalid index moodMenu option');if(index.moodMenu.filter(e=>e.id===o.id).length!==1)throw Error('Duplicate index moodMenu id');}}
 for(const k of ['version','part','separator','today','builtAt'])if(typeof index.meta[k]!=='string')throw Error('Invalid index meta '+k);
 for(const k of ['schema','count','loveStars','minFeatureMinutes','shortMaxMinutes'])if(index.meta[k]!==undefined&&!Number.isFinite(index.meta[k]))throw Error('Invalid index meta number '+k);
 if(index.rules)keys(index.rules,['rule','minStars','exemptCatalogs','musicExemptMoods'],'rules');
 // The Discover catalogs of the v2 family (lib/discover-catalogs.js; 22/10/2026). Shape only here: that the ids are films of the index, eligible, and only in the whole index, is checkIndex's.
 if(index.discover!==undefined){
  const d=index.discover,sid=/^[a-z0-9-]+$/,oid=/^[A-Za-z0-9_-]+$/;
  keys(d,['order','retire','seen','explore','catalogs'],'discover');
  for(const k of ['order','retire'])if(!Array.isArray(d[k])||d[k].some(x=>typeof x!=='string'||!sid.test(x)))throw Error('Invalid index discover '+k);
  if(d.explore!==undefined){keys(d.explore,['genre'],'discover.explore');if(typeof d.explore.genre!=='string'||!sid.test(d.explore.genre))throw Error('Invalid index discover explore');}
  keys(d.seen,['name','option'],'discover.seen');
  if(typeof d.seen.name!=='string'||!/^[a-z]+$/.test(d.seen.name)||typeof d.seen.option!=='string'||!d.seen.option)throw Error('Invalid index discover seen');
  if(!Array.isArray(d.catalogs))throw Error('Invalid index discover catalogs');
  for(const c of d.catalogs){
   keys(c,['id','name','options'],'discover.catalog');
   if(typeof c.id!=='string'||!sid.test(c.id)||typeof c.name!=='string'||!c.name||!Array.isArray(c.options))throw Error('Invalid index discover catalog');
   if(d.catalogs.filter(x=>x.id===c.id).length!==1||!d.order.includes(c.id))throw Error('Invalid index discover catalog order '+c.id);
   for(const o of c.options){
    keys(o,['id','label','ids','list','curated','director','shorts','total','totalAll'],'discover.option');
    if(typeof o.id!=='string'||!oid.test(o.id)||typeof o.label!=='string'||!o.label)throw Error('Invalid index discover option');
    if((o.ids===undefined)===(o.list===undefined))throw Error('Invalid index discover option '+o.id+': exactly one of ids or list');
    if(o.ids!==undefined&&(!Array.isArray(o.ids)||o.ids.some(t=>typeof t!=='string'||!/^tt\d+$/.test(t))))throw Error('Invalid index discover option ids');
    if(o.list!==undefined&&(typeof o.list!=='string'||!oid.test(o.list)))throw Error('Invalid index discover option list');
    if(o.curated!==undefined&&(o.curated!==true||o.ids===undefined))throw Error('Invalid index discover option '+o.id+': curated is true on an option with ids, or absent');
    if(o.director!==undefined&&(o.curated!==true||typeof o.director!=='string'||!o.director))throw Error('Invalid index discover option '+o.id+': director is the text of a directors option, on a curated option');
    // `shorts: true` by option id, not by shape (15/11/2026, review): an era with a file in data/eras, or a period Marco keeps the shorts in (lib/discover-catalogs.js SHORTS_PERIODS: the Silent era). A decade, a country, a genre, another period: refused. checkIndex runs this on every file of the family (the menus and the pieces carry the mark too), validateIndex on the whole index.
    if(o.shorts!==undefined&&(o.shorts!==true||o.ids===undefined||o.curated!==undefined||!require('./discover-catalogs').shortsOptionIds().has(o.id)))throw Error('Invalid index discover option '+o.id+': shorts is true on an era with a file (data/eras) or a period that keeps its shorts ('+require('./discover-catalogs').SHORTS_PERIODS.join(', ')+'), with ids and not curated, or absent');
    if(c.options.filter(x=>x.id===o.id).length!==1)throw Error('Duplicate index discover option '+o.id);
   }
  }
 }
 keys(index.friends,['people','options'],'friends');
 if(!Array.isArray(index.friends.people)||index.friends.people.some(n=>typeof n!=='string'))throw Error('Invalid index people');
 for(const family of ['friends','directors']){
  if(!index[family]&&family==='directors')continue;
  keys(index[family],family==='friends'?['people','options']:['options'],family);
  if(!Array.isArray(index[family].options))throw Error('Invalid index options');
  for(const o of index[family].options){keys(o,family==='friends'?['label','ids']:['label','ids','descs'],family+'.option');if(typeof o.label!=='string'||!Array.isArray(o.ids)||o.ids.some(t=>typeof t!=='string'||!/^tt\d+$/.test(t)))throw Error('Invalid index option');}
 }
 for(const k of ['rows','rowDesc']){keys(index[k],Object.keys(index[k]||{}),k);for(const [id,list] of Object.entries(index[k]))if(!/^[A-Za-z0-9_-]+$/.test(id)||!Array.isArray(list)||list.some(x=>typeof x!=='string'))throw Error(k==='rowDesc'?'rowDesc of row '+id+' must be one text per film':'Invalid index '+k);}
 if(!Array.isArray(index.films))throw Error('Invalid index films');
 for(const e of index.films){keys(e,ENTRY_KEYS,'film');
  for(const k of ['tt','name','decade','language','poster','desc','director','find'])if(e[k]!==undefined&&typeof e[k]!=='string')throw Error('Invalid index text '+k);
  for(const k of ['year','runtime','lbRating','tmdbRating','tmdbVotes','imdbRating','friendsAvg','taste','quality','rank','seenBy','wantBy'])if(e[k]!==undefined&&!Number.isFinite(e[k]))throw Error('Invalid index number '+k);
  if(e.decade!==undefined&&e.decade!==(e.year?`${Math.floor(e.year/10)*10}s`:undefined))throw Error('Invalid index decade');
  for(const k of ['countries','genres','keywords'])if(e[k]!==undefined&&(!Array.isArray(e[k])||e[k].some(v=>typeof v!=='string')))throw Error('Invalid index array '+k);
  for(const k of ['seen','watchlist','eligible','musicOut','shortOut'])if(e[k]!==undefined&&e[k]!==true)throw Error('Invalid index flag '+k);
  if(Object.hasOwn(e,'moods')){keys(e.moods,Object.keys(e.moods||{}),'film.moods');for(const id of Object.keys(e.moods))if(!index.moods.some(m=>m.id===id))throw Error('mood "'+id+'" is not declared');for(const v of Object.values(e.moods))if(!Array.isArray(v)||v.length!==2||!v.every(Number.isFinite))throw Error('Invalid index mood tuple');}
  if(Object.hasOwn(e,'lists')){keys(e.lists,Object.keys(e.lists||{}),'film.lists');for(const id of Object.keys(e.lists))if(!index.lists.some(l=>l.id===id))throw Error('list "'+id+'" is not declared');for(const [id,v] of Object.entries(e.lists))if(!Number.isInteger(v)||v<1)throw Error('list "'+id+'" position '+v);}
  if(Object.hasOwn(e,'friends')){keys(e.friends,['seenBy','wantBy','friendsAvg'],'film.friends');if(!Array.isArray(e.friends.seenBy)||e.friends.seenBy.some(v=>!Array.isArray(v)||v.length!==2||typeof v[0]!=='string'||(v[1]!==null&&!Number.isFinite(v[1])))||!Array.isArray(e.friends.wantBy)||e.friends.wantBy.some(v=>typeof v!=='string'))throw Error('Invalid index friend tuple');if(e.friends.friendsAvg!==undefined&&!Number.isFinite(e.friends.friendsAvg))throw Error('Invalid index friend average');}
 }
}
/** name: how the index is called in a message ("index", or "index-v2" for the v2 family): the problems and the thrown errors name the family they are about. */
function validateIndex(index,name='index'){
 try{raw(index);}catch(e){if(name!=='index')e.message=name+': '+e.message;throw e;}
 if(index.meta.part!=='full')throw Error('Expected full Worker index');
 if(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(JSON.stringify(index)))throw Error('Index contains an e-mail address');
 // Frozen canonical JSON sorts object keys. Board array remains the order authority.
 if(JSON.stringify(index.board.map(r=>r.id).sort())!==JSON.stringify(Object.keys(index.rows).sort()))throw Error('Invalid '+name+': rows and board do not list the same rows');
 const ordered={...index,rows:Object.fromEntries(index.board.map(r=>[r.id,index.rows[r.id]]))};
 const problems=[];const result=checkIndex(index.meta.part||'full',encode(ordered),problems,name==='index'?null:name);
 // Encoding must not erase an unknown/private field or change a malformed type.
 if(problems.length)throw Error('Invalid '+name+': '+problems.join('; '));
 require('./learning/plan-posters').indexIds(result);
 return result;
}
module.exports={checkIndex,validateIndex};
