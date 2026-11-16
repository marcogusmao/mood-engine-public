'use strict';
// films — the compact projection the CLI reads instead of the raw caches (Fatia 1, 11/10/2026).
// Pure: takes already-parsed sources, returns plain JSON. Eligibility comes from lib/recommendation-quality.js
// and friend views from lib/friends.js, so the CLI can never drift from the build's rule. The rule is the current one (Marco, 11/10/2026):
// community >= 3.5, OR a configured friend >= 3.5, OR a vouched film (critic/director list, a favourite director's love) with a
// Letterboxd average >= 2.5 or none. The vouched sets are computed by tools/films/store.js from the repository files and handed in.
// Covered by tools/films/films.test.js.

const Q = require('../../lib/recommendation-quality');
const F = require('../../lib/friends');
const { norm } = require('../../lib/util');
const CO = require('../../lib/countries');
const SL = require('../../lib/static-lists');
const { correct } = require('../../lib/lists');

const OVERVIEW_MAX = 600; // UTF-16 units of TMDB synopsis kept per film. Measured 12/10/2026: the longest overview in cache/tmdb.json has 1,000 and 414 of them are over 600; no code limits the cache itself
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
// Same key lib/tmdb.js uses for its search cache (`${norm(title)}|${year || ""}`); lookup only, never a network call.
const searchKey = (title, year) => `${norm(title)}|${year || ''}`;

/**
 * sources: { tmdb, friends, cfg, history: Map from lib/letterboxd.loadHistory, lists, times: { export, files },
 *            vouched, loved, staticFilms }
 *   vouched      Map tt → { list, trust, why? }: films in a critic or director list (lib/list-signal.js vouchedFromCaches)
 *   loved        Map tt → { list, trust, why }, or a function (records) → that Map: a favourite director's love (lib/directors-loved.js
 *                vouched). The function form exists because the favourites come from Marco's ratings, which this projection resolves;
 *                it receives the records with `me` filled in and must be pure.
 *   staticFilms  Letterboxd's film records with the static lists laid over them (lib/static-lists.js filmsFor), as the build's view.films;
 *                absent → the records of `friends.films`.
 *   staticLists  [{ id, fetchedAt, items }]: the static lists of config.json with lib/static-lists.js apply() already run over them (a series
 *                or a refused item sits under a dead slug), as store.js hands them; absent → a static list has no members.
 * → { meta, films: [record], people: { user → … }, lists: { id → … }, me: … }
 */
function project({ tmdb, friends, cfg, history, lists = { lists: {} }, times = {}, vouched = new Map(), loved = new Map(), staticFilms = null, staticLists = null, directors = new Map() }) {
  const movies = tmdb.movie || {};
  const peek = (id) => (id != null ? movies[id]?.v || null : null);
  const lbFilms = friends.films || {};
  const view = F.viewFriends(friends, cfg); // users = configured friends only; crowd = everyone followed + configured
  const quality = Q.index(view);

  // ── identity: IMDb id first (the build's join key), then TMDB, then Letterboxd slug ──
  const byId = new Map();
  const slugToId = new Map();
  const tmdbToId = new Map();
  const conflicts = [];
  const rec = (id) => {
    if (!byId.has(id)) byId.set(id, { id, tmdb: null, slugs: [], title: null, year: null });
    return byId.get(id);
  };
  for (const [tid, entry] of Object.entries(movies)) {
    const v = entry?.v;
    if (!v) continue;
    const id = /^tt\d+$/.test(v.imdb || '') ? v.imdb : `tmdb:${tid}`;
    const r = rec(id);
    r.tmdb = Number(tid);
    tmdbToId.set(Number(tid), id);
  }
  for (const [slug, f] of Object.entries(lbFilms)) {
    if (!f || f.gone) continue;
    const viaTmdb = f.tmdbId != null ? tmdbToId.get(Number(f.tmdbId)) : null;
    let id;
    if (/^tt\d+$/.test(f.imdbId || '')) {
      id = f.imdbId;
      // Old friends.json records (v2) can hold a TV id from TMDB that names another film in the movie cache (Evangelion → "Brother of Sleep").
    } else id = viaTmdb || `lb:${slug}`;
    if (viaTmdb && viaTmdb !== id) conflicts.push({ slug, letterboxd: id, tmdb: viaTmdb });
    const r = rec(id);
    r.slugs.push(slug);
    const conflict = viaTmdb && viaTmdb !== id;
    if (conflict) r.tmdbConflict = Number(f.tmdbId); // facts then come from Letterboxd only, never from the other film
    else if (r.tmdb == null && f.tmdbId != null) r.tmdb = Number(f.tmdbId);
    slugToId.set(slug, id);
  }

  // ── facts per film ──
  for (const r of byId.values()) {
    const d = peek(r.tmdb);
    const lbs = r.slugs.map((s) => lbFilms[s]);
    const lb0 = lbs[0] || null;
    r.title = d?.title || lb0?.title || null;
    r.titleSrc = d?.title ? 'tmdb' : lb0?.title ? 'letterboxd' : null;
    r.originalTitle = d?.originalTitle || null;
    r.year = d?.year ?? lb0?.year ?? null;
    r.yearSrc = d?.year != null ? 'tmdb' : lb0?.year != null ? 'letterboxd' : null;
    r.lbTitles = lbs.map((x) => [x.title, x.year]); // the build's guard also matches Letterboxd's own title/year (lib/guard.js)
    const lbRt = lbs.map((x) => x.rt).find((n) => Number.isFinite(n) && n > 0);
    if (Number.isFinite(d?.runtime) && d.runtime > 0) { r.rt = d.runtime; r.rtSrc = 'tmdb'; }
    else if (lbRt) { r.rt = lbRt; r.rtSrc = 'letterboxd'; }
    else { r.rt = null; r.rtSrc = null; }
    r.lang = d?.lang || null;
    // Letterboxd stores English names ("Japan", "USA"); turn them into TMDB's alpha-2 through lib/countries (USSR → RU, its flag successor).
    r.countries = d?.countries?.length ? d.countries : (lb0?.c || []).map((n) => CO.flagOfName(n)?.toUpperCase()).filter(Boolean);
    // TMDB's origin_country (22/10/2026; null = the record never carried it) and the film's MAIN country, the one the card and the Board's regions read (lib/countries.js mainCountry).
    // `countries` stays the list of producers, so for a film whose origin is not a producer (Manakamana: producers NP + US, origin NE) `mainCountry` is not in `countries`.
    r.origin = Array.isArray(d?.origin) ? [...d.origin] : null;
    r.genres = d?.genres || [];
    r.keywords = d?.keywords || [];
    r.directors = d?.directors || [];
    const why = CO.mainCountryWhy({ countries: r.countries, lang: r.lang, origin: r.origin, directors: r.directors }, undefined, undefined, directors instanceof Map ? directors : new Map()); // the CLI never reads the process's registry: cache/directors.json arrives as `directors` (tools/films/store.js)
    r.mainCountry = why.iso;
    r.mainCountrySrc = why.from; // "director" (Wikidata), "origin" (TMDB) or "rule" (the rule of 14/10/2026): who decided, for the dossier
    r.cast = (d?.cast || []).slice(0, 4);
    // The TMDB synopsis, only for the film's own TMDB record. A Letterboxd record whose TMDB id names another film (tmdbConflict) inherits nothing
    // from it; but when the record it holds is the film's own (that TMDB entry carries this record's IMDb id: `tmdbOwn`), the conflict is only the
    // other slug's stray id, the facts above already come from the own record, and the synopsis comes with them (12/10/2026: 4 of the 62 conflicts).
    // The IMDb comparison is the explicit guard: today `r.tmdb` is only ever set to a record that already carries `r.id`, so `d` alone would do, and a test
    // cannot tell the two apart; the guard stays so a change in the identity pass above cannot hand a synopsis to a record whose TMDB entry is another film.
    // Third-party text, kept exactly as TMDB has it: no trim, no cut at a word. Longer than OVERVIEW_MAX it is cut at that many UTF-16 units
    // with an ellipsis after; a lone high surrogate is not left at the cut, so the emoji goes whole or not at all.
    if (r.tmdbConflict && d && /^tt\d+$/.test(r.id) && d.imdb === r.id) r.tmdbOwn = true;
    const ov = (!r.tmdbConflict || r.tmdbOwn) && typeof d?.overview === 'string' && d.overview.trim() ? d.overview : null;
    r.overview = ov == null ? null : ov.length > OVERVIEW_MAX ? `${ov.slice(0, /[\ud800-\udbff]/.test(ov[OVERVIEW_MAX - 1]) ? OVERVIEW_MAX - 1 : OVERVIEW_MAX)}…` : ov;
    r.overviewSrc = r.overview == null ? null : 'tmdb';
    r.tTmdb = iso(movies[r.tmdb]?.t);
    r.tLb = iso(Math.max(...lbs.map((x) => x.t).filter(Number.isFinite), -Infinity)) || null;
    // Unrounded community average exactly as the build reads it (lowest when two slugs share one IMDb id).
    const q = quality.get(r.id);
    const lbVals = lbs.map((x) => x.r).filter(Q.valid);
    r.lb = q ? q.lb : lbVals.length ? Math.min(...lbVals) : null;
    r.lbN = Math.max(...lbs.map((x) => x.rn).filter(Number.isFinite), -Infinity);
    if (!Number.isFinite(r.lbN)) r.lbN = null;
    r.fr = []; // configured friends' own ratings: [name, rating]
    r.me = { r: null, liked: false, wl: false, seen: [] };
  }
  for (const u of view.users) for (const [slug, f] of u.films) {
    const id = slugToId.get(slug);
    if (id && Q.valid(f.rating)) byId.get(id).fr.push([u.name, f.rating]);
  }

  // ── Marco: export CSVs (title+year → TMDB through the search cache), Letterboxd /films/ slugs, live watchlist ──
  // A title+year hit in the TMDB search cache is a guess: lib/tmdb.js takes the best-scoring result, and a homonym with the same title
  // and year (a 21-minute short called "The Hand", 2020) can win. The brief says resolution returns candidates and never picks, so a
  // hit becomes a link only when something else confirms it (see linkOf); otherwise the row is pending, with the candidates listed.
  const pending = [];
  const ambiguous = [];
  const lbByTitle = new Map(); // norm(title) → [[id, year]] from the Letterboxd records the repo already maps to an IMDb/TMDB id
  const movieByTitle = new Map(); // norm(title | original title) → [[id, year]] from the TMDB movie cache
  const push = (m, k, id, y) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push([id, y]); };
  for (const [slug, f] of Object.entries(lbFilms)) if (f && !f.gone && slugToId.has(slug)) push(lbByTitle, norm(f.title), slugToId.get(slug), f.year ?? null);
  for (const [tid, entry] of Object.entries(movies)) {
    const v = entry?.v;
    if (!v || !tmdbToId.has(Number(tid))) continue;
    for (const t of new Set([v.title, v.originalTitle].filter(Boolean).map(norm))) push(movieByTitle, t, tmdbToId.get(Number(tid)), v.year ?? null);
  }
  // Same title in the same year first; only if none, ±1 (festival vs release year), as the search itself tolerates.
  const near = (list, year) => {
    if (!year) return new Set((list || []).map(([id]) => id));
    const exact = (list || []).filter(([, y]) => y === year);
    return new Set((exact.length ? exact : (list || []).filter(([, y]) => y != null && Math.abs(y - year) === 1)).map(([id]) => id));
  };
  /** { id } when the search hit is confirmed, { candidates, searchPick } when it is not. */
  const linkOf = (h, entry, searchId) => {
    if (entry.exact) return { id: searchId }; // written by lib/tmdb.js remember() from an RSS item that carried the TMDB id
    const L = near(lbByTitle.get(norm(h.title)), h.year);
    const M = near(movieByTitle.get(norm(h.title)), h.year);
    M.add(searchId);
    if (L.size === 1 && L.has(searchId)) return { id: searchId }; // Letterboxd names this same film for that title and year, and only it
    if (!L.size && M.size === 1) {
      // Nothing else carries that title and year, but a hit with no IMDb id that runs under 40 minutes is a short of the same name
      // ("One Day" 2024 4★ → a 3-minute film), not the feature the export means: its rival is simply not in any cache.
      const hit = byId.get(searchId);
      if (!/^tt\d+$/.test(searchId) && Number.isFinite(hit?.rt) && hit.rt < 40) return { searchPick: searchId, candidates: [searchId], reason: 'short-without-imdb' };
      return { id: searchId }; // nothing else carries that title and year
    }
    return { searchPick: searchId, candidates: [...new Set([...L, ...M])].sort() };
  };
  const exportFilms = [...(history?.values?.() || [])];
  const seenTitles = new Map();
  for (const h of exportFilms) {
    const entry = tmdb.search?.[searchKey(h.title, h.year)] || null;
    const tid = entry?.v ?? null;
    let id = tid != null ? tmdbToId.get(Number(tid)) || null : null;
    let doubt = null;
    if (id) { const l = linkOf(h, entry, id); if (l.id) id = l.id; else { doubt = l; id = null; } }
    if (h.watched) {
      const k = norm(h.title);
      if (!seenTitles.has(k)) seenTitles.set(k, []);
      seenTitles.get(k).push(h.year);
    }
    if (doubt) {
      const cand = doubt.candidates.map((c) => ({ id: c, title: byId.get(c)?.title ?? null, year: byId.get(c)?.year ?? null, rt: byId.get(c)?.rt ?? null }));
      ambiguous.push({ title: h.title, year: h.year, rated: h.rating != null, watchlist: !!h.watchlist, searchPick: doubt.searchPick, candidates: cand });
      if (h.rating != null) pending.push({ title: h.title, year: h.year, reason: doubt.reason || 'ambiguous', searchPick: doubt.searchPick, candidates: cand });
      continue;
    }
    if (!id) { if (h.rating != null) pending.push({ title: h.title, year: h.year }); continue; }
    const m = byId.get(id).me;
    if (h.rating != null) m.r = h.rating;
    if (h.liked) m.liked = true;
    if (h.watchlist) m.wl = true;
    if (h.watched && !m.seen.includes('export')) m.seen.push('export');
  }
  const canonToId = new Map(Object.entries(lbFilms).filter(([, f]) => f?.canon && !f.gone).map(([slug, f]) => [f.canon, slugToId.get(slug)]));
  for (const slug of friends.me?.slugs || []) {
    const id = slugToId.get(slug) || canonToId.get(slug); // lib/guard.js: me.has(slug) || me.has(r.canon)
    if (id && !byId.get(id).me.seen.includes('letterboxd')) byId.get(id).me.seen.push('letterboxd');
  }
  for (const [slug] of friends.watchlist?.items || []) {
    const id = slugToId.get(slug);
    if (id) byId.get(id).me.wl = true;
  }
  // The build's safety net (build.js titleSeen): same title within ±1 year counts as seen.
  // Titles checked: TMDB title, TMDB original title (build.js isSeen) and every Letterboxd title/year (lib/guard.js seenImdbIds).
  const titleSeen = (t, y) => (seenTitles.get(norm(t)) || []).some((sy) => !sy || !y || Math.abs(sy - y) <= 1);
  for (const r of byId.values()) {
    if (r.me.seen.length) continue;
    const pairs = [[r.title, r.year], [r.originalTitle, r.year], ...r.lbTitles].filter(([t]) => t);
    if (pairs.some(([t, y]) => titleSeen(t, y))) r.me.seen.push('title±1y');
  }
  for (const r of byId.values()) delete r.lbTitles;

  // ── eligibility: the build's rule (build.js builds one index for every surface: Q.index(view, { vouched, loved })) ──
  // Computed after Marco's ratings are resolved because the favourite directors come from them (the taste model).
  const lovedMap = typeof loved === 'function' ? loved([...byId.values()]) : loved;
  const rule = Q.index({ ...view, films: staticFilms || view.films }, { vouched, loved: lovedMap });
  for (const r of byId.values()) {
    const q = /^tt\d+$/.test(r.id) ? rule.get(r.id) : null;
    r.cv = false; r.onlyByException = false;
    if (q?.cv === 1) { r.cv = true; r.cvList = q.cvList; r.cvTrust = q.cvTrust; if (q.cvWhy) r.cvWhy = q.cvWhy; }
    if (!/^tt\d+$/.test(r.id)) { r.elig = null; r.eligWhy = 'no IMDb id: the build never publishes it, rule not applicable'; }
    else if (q && Q.qualifies(q)) { r.elig = true; r.eligWhy = Q.reason(q); r.onlyByException = Q.onlyByException(q); }
    else if (q?.cv === 1) { r.elig = false; r.eligWhy = `vouched (“${q.cvList}”) but community ${String(q.lb)} < ${Q.VOUCHED_MIN_STARS}, the floor of a vouched film`; }
    else { r.elig = false; r.eligWhy = `community ${Q.valid(q?.lb) ? String(q.lb) : 'unknown'} < ${Q.MIN_STARS}, no configured friend ≥ ${Q.MIN_STARS}, not vouched by a critic or director list nor loved by a favourite director`; }
  }
  // Films only data/directors-loved.json names (no Letterboxd page, not in the TMDB cache) have an entry in the rule's index but no record here.
  const lovedWithoutRecord = [...lovedMap.keys()].filter((tt) => !byId.has(tt)).length;

  // ── people: configured friends + everyone followed (the 51 crowd accounts) ──
  const configured = new Set(view.users.map((u) => u.user.toLowerCase()));
  const people = {};
  for (const u of view.crowd) {
    const rated = [], watchlist = [], seen = [];
    let unresolved = 0;
    for (const [slug, f] of u.films) {
      const id = slugToId.get(slug);
      // An account in config.json ratingsIgnored (22/10/2026) has no ratings in the view (lib/friends.js userView), and this record lists the films a person saw BY their
      // rating: reading it as it came would erase what he saw. His films go to `seen` (every film of his /films/ page and diary, unrated included), `rated` stays empty.
      if (u.ratingsIgnored) { if (id) seen.push(id); else unresolved++; continue; }
      if (!Q.valid(f.rating)) continue;
      if (id) rated.push([id, f.rating]); else unresolved++;
    }
    for (const slug of u.watchlist.keys()) {
      const id = slugToId.get(slug);
      if (id) watchlist.push(id); else unresolved++;
    }
    people[u.user] = { name: u.name, configured: configured.has(u.user.toLowerCase()), fetchedAt: u.fetchedAt, rated, watchlist, unresolved, ...(u.ratingsIgnored ? { ratingsIgnored: true, ratingsIgnoredBy: u.ratingsIgnoredBy, ...(u.ratingSpread ? { ratingSpread: u.ratingSpread } : {}), seen } : {}) };
  }
  // ── curated lists, as the build sees them (build.js refreshLists → lib/index-export.js): the config's lists in the config's order, the
  // curator's corrections applied (lib/lists.js correct: the cache stays what Letterboxd says), a static list from its file with the
  // series and the refused items already moved to dead slugs (lib/static-lists.js apply), one position per film (the first), a gone or
  // refused item unresolved. `positions[i]` is the curator's 1-based position of `ids[i]` (the number the published index carries).
  // Without cfg.lists (a bare fixture) the lists of the cache are taken as they are.
  const cacheLists = lists.lists || {};
  const configured_ = Array.isArray(cfg.lists) && cfg.lists.length ? cfg.lists : Object.keys(cacheLists).map((id) => ({ id }));
  const outLists = {};
  for (const l of configured_) {
    const lid = l.id;
    const isStatic = SL.isStatic(l);
    const cached = cacheLists[lid];
    const stat = isStatic ? (staticLists || []).find((x) => x.id === lid) : null;
    const items = isStatic
      ? stat?.items || []
      : correct(l, ((cached && cached.items) || []).map(([slug, title, year]) => ({ slug, title, year })));
    const ids = [], positions = [], seenIds = new Set();
    let unresolved = 0;
    items.forEach((it, i) => {
      // a static item names its film by IMDb id in the file; the Letterboxd slug is only a second way to the same film
      const dead = isStatic && /^(tv|refused):/.test(it.slug); // apply() moved a series or a refused item to a slug no page has: no film of this list
      const id = dead ? null : isStatic && it.imdb && byId.has(it.imdb) ? it.imdb : slugToId.get(it.slug);
      if (!id) { unresolved++; return; }
      if (seenIds.has(id)) return;
      seenIds.add(id);
      ids.push(id);
      positions.push(i + 1);
    });
    outLists[lid] = { name: cached?.title || l.name || lid, fetchedAt: (isStatic ? stat?.fetchedAt : cached?.fetchedAt) || null, ids, positions, unresolved };
  }

  // When each cache was last written, from the records themselves (the newest `t` / fetchedAt), not from the file's modification time, which is the
  // time of a checkout. A stamp is a number (ms) or a string (ISO); none → null.
  const newest = (vals) => { const ms = vals.map((x) => (typeof x === 'number' ? x : Date.parse(x))).filter(Number.isFinite); return ms.length ? iso(ms.reduce((a, b) => (b > a ? b : a), -Infinity)) : null; };
  const cacheNewest = {
    tmdb: newest(Object.values(movies).map((e) => e?.t)),
    letterboxdFilms: newest(Object.values(lbFilms).map((f) => f?.t)),
    friends: newest(Object.values(people).map((p) => p.fetchedAt)),
    lists: newest(Object.values(cacheLists).map((l) => l?.fetchedAt)),
  };

  return {
    meta: {
      cacheNewest,
      films: byId.size,
      exportAt: times.export || null,
      meAt: friends.me?.fetchedAt || null,
      watchlistAt: friends.watchlist?.fetchedAt || null,
      files: times.files || {},
      ratedPending: pending,
      ambiguous,
      identityConflicts: conflicts,
      lovedWithoutRecord,
      ...(Object.values(people).some((p) => p.ratingsIgnored) ? { ratingsIgnored: Object.entries(people).filter(([, p]) => p.ratingsIgnored).map(([user]) => user), ratingsIgnoredBy: Object.fromEntries(Object.entries(people).filter(([, p]) => p.ratingsIgnored).map(([user, p]) => [user, p.ratingsIgnoredBy])) } : {}), // config.json ratingsIgnored (the list and the general rule), as the build reads it: who, and "list" or "rule" for each
    },
    films: [...byId.values()],
    people,
    lists: outLists,
    moods: cfg.moods || [],
    // the config lists that are the signal of a mood (lib/moods.js compile(moods, lists)): id, name (the hit label) and { mood id: weight }
    moodLists: (cfg.lists || []).filter((l) => l && l.moods && typeof l.moods === 'object').map((l) => ({ id: l.id, name: l.name, moods: l.moods })),
  };
}

module.exports = { project, searchKey };
