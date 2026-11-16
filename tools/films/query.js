'use strict';
// films — every question the CLI answers, as pure functions over the projection (tools/films/project.js).
// Unknown stays "unknown": a missing runtime never satisfies --max-min, a missing average is never 0.
// Taste reuses lib/taste.js as is. Covered by tools/films/films.test.js.

const fs = require('node:fs');
const path = require('node:path');
const { learn, score, ALPHA } = require('../../lib/taste');
const { norm } = require('../../lib/util');
const { compile, fit, passes } = require('../../lib/moods');

const U = 'unknown';
const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

function tools(index) {
  const byId = new Map(index.films.map((f) => [f.id, f]));
  const bySlug = new Map();
  for (const f of index.films) for (const s of f.slugs) bySlug.set(s, f);
  const byTmdb = new Map();
  for (const f of index.films) if (f.tmdb != null) byTmdb.set(f.tmdb, [...(byTmdb.get(f.tmdb) || []), f]);
  const byTitle = new Map();
  for (const f of index.films) for (const t of new Set([f.title, f.originalTitle].filter(Boolean).map(norm))) if (t) byTitle.set(t, [...(byTitle.get(t) || []), f]);
  return { byId, bySlug, byTmdb, byTitle };
}

const one = (hits, how) => (hits.length === 1 ? { film: hits[0], matchedBy: how } : hits.length > 1 ? { candidates: hits } : null);

/**
 * "tt0123" | "tmdb:123" | "lb:<slug>" | "Title" | "Title 1999" | "Title (1999)" → { film, matchedBy } | { candidates } | { none }.
 * A title shared by several films returns candidates, never a pick. "Title Year" returns ONE film only when no other record with that
 * title lies within a year of the one asked: Letterboxd and TMDB disagree on festival vs release year (as the build's guard accepts), so an
 * exact-year hit with a same-title film one year off is still a homonym (Split 2016 → Kampmeier's, while Marco rated Shyamalan's; 12/10/2026).
 * Then the candidates come exact year first, ±1 after. A bare slug is tried only after titles, so "scarface" stays ambiguous.
 */
function resolve(index, query, t = tools(index)) {
  const q = String(query).trim();
  if (/^tt\d+$/.test(q)) return t.byId.has(q) ? { film: t.byId.get(q), matchedBy: 'imdb' } : { none: q };
  if (/^tmdb:\d+$/.test(q)) return one(t.byTmdb.get(Number(q.slice(5))) || [], 'tmdb') || { none: q };
  if (q.startsWith('lb:')) return t.bySlug.has(q.slice(3)) ? { film: t.bySlug.get(q.slice(3)), matchedBy: 'letterboxd slug' } : { none: q };
  const whole = t.byTitle.get(norm(q)) || [];
  const m = q.match(/^(.*?)[\s(]+(\d{4})\)?$/);
  if (m && norm(m[1])) {
    const year = Number(m[2]);
    const within = (t.byTitle.get(norm(m[1])) || []).filter((f) => f.year != null && Math.abs(f.year - year) <= 1);
    if (within.length === 1) return { film: within[0], matchedBy: within[0].year === year ? 'title + year' : 'title + year ±1' };
    if (within.length > 1) return { candidates: [...within.filter((f) => f.year === year), ...within.filter((f) => f.year !== year)] };
  }
  if (whole.length) return one(whole, 'title');
  if (t.bySlug.has(q)) return { film: t.bySlug.get(q), matchedBy: 'letterboxd slug' };
  return { none: q };
}

const seen = (f) => f.me.seen.length > 0;

/** Each constraint returns true / false; an unknown fact fails the constraint and is reported as unknown. */
function constraints(o) {
  const c = [];
  if (o.unseen) c.push(['unseen', (f) => !seen(f)]);
  if (o.seen) c.push(['seen', (f) => seen(f)]);
  if (o.watchlist) c.push(['watchlist', (f) => f.me.wl]);
  if (o.eligible) c.push(['eligible', (f) => f.elig === true]);
  if (o.maxMin != null) c.push([`runtime≤${o.maxMin}`, (f) => (f.rt == null ? U : f.rt <= o.maxMin)]);
  if (o.minMin != null) c.push([`runtime≥${o.minMin}`, (f) => (f.rt == null ? U : f.rt >= o.minMin)]);
  if (o.lang) c.push([`lang=${o.lang}`, (f) => (f.lang == null ? U : f.lang === o.lang)]);
  if (o.country) c.push([`country=${o.country}`, (f) => (!f.countries.length ? U : f.countries.includes(o.country.toUpperCase()))]);
  if (o.director) c.push([`director~${o.director}`, (f) => (!f.directors.length ? U : f.directors.some((d) => fold(d.name).includes(fold(o.director))))]);
  for (const k of o.keyword || []) c.push([`keyword=${k}`, (f) => (!f.keywords.length ? U : f.keywords.some((x) => fold(x) === fold(k)))]);
  if (o.genre) c.push([`genre=${o.genre}`, (f) => (!f.genres.length ? U : f.genres.some((g) => fold(g) === fold(o.genre)))]);
  if (o.yearFrom != null) c.push([`year≥${o.yearFrom}`, (f) => (f.year == null ? U : f.year >= o.yearFrom)]);
  if (o.yearTo != null) c.push([`year≤${o.yearTo}`, (f) => (f.year == null ? U : f.year <= o.yearTo)]);
  if (o.minLb != null) c.push([`lb≥${o.minLb}`, (f) => (f.lb == null ? U : f.lb >= o.minLb)]);
  if (o.title) c.push([`title~${o.title}`, (f) => fold(f.title).includes(fold(o.title))]);
  if (o.friendMin != null) c.push([`configured friend≥${o.friendMin}`, (f) => f.fr.some(([, r]) => r >= o.friendMin)]);
  if (o.mood) {
    const m = o.moods.find((x) => x.id === o.mood);
    if (!m) throw new Error(`unknown mood ${o.mood}; known: ${o.moods.map((x) => x.id).join(', ')}`);
    c.push([`mood=${o.mood}`, (f) => (!f.genres.length && !f.keywords.length ? U : moodFit(o.index, f, m).ok)]);
  }
  return c;
}

const SORTS = {
  lb: (a, b) => (b.lb ?? -1) - (a.lb ?? -1),
  year: (a, b) => (b.year ?? 0) - (a.year ?? 0),
  runtime: (a, b) => (a.rt ?? 1e9) - (b.rt ?? 1e9),
  id: (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
};

/**
 * The mood recipe from config.json scored by lib/moods.js, today; `runtime` is what fit() reads. Mirrors the build: the recipes are compiled
 * with the config's lists (build.js `compile(cfg.moods, cfg.lists)`) and fit() receives the ids of the lists that hold the film
 * (lib/rows.js `fit(c.film, mood, { lists: c.lists })`), because a list may be the signal of a mood (the two slow-cinema canons for `slow`).
 * Lists come from the projection: `index.moodLists` (id, name, moods of each config list that names moods) and `index.lists[id].ids`.
 */
const moodCtxs = new WeakMap();
function moodCtx(index) {
  const hit = moodCtxs.get(index);
  if (hit && hit.moods === index.moods && hit.lists === index.lists) return hit;
  const byFilm = new Map();
  for (const [lid, l] of Object.entries(index.lists || {})) for (const id of l.ids) (byFilm.get(id) || byFilm.set(id, []).get(id)).push(lid);
  const made = { moods: index.moods, lists: index.lists, byFilm, compiled: new Map(compile(index.moods || [], index.moodLists || []).map((m) => [m.id, m])) };
  moodCtxs.set(index, made);
  return made;
}
function moodFit(index, f, mood) {
  const c = moodCtx(index), m = c.compiled.get(mood.id), lists = c.byFilm.get(f.id) || [];
  const r = fit({ ...f, runtime: f.rt }, m, { lists });
  // A v2 mood may carry a hard gate (`where`: Hidden gems = Letterboxd 3.8+ on under 10,000 ratings; Documentaries = a documentary). The build applies it BEFORE the fit
  // (lib/board-rows.js rankMood: `passes(c, mood.where)`), and a film that fails it is not in the mood whatever its fit (14/10/2026: `search --mood hidden` said 10,358 films, the build 1,006).
  // The candidate is what the build hands passes(): the film, the Letterboxd year, average and count of ratings, and the lists it is in.
  if (m.where && !passes({ film: f, lbYear: f.year ?? null, lb: f.lb ?? null, lbCount: f.lbN ?? null, lists }, m.where)) return { ...r, ok: false, gated: true };
  return r;
}

function search(index, o = {}) {
  if (o.sort && o.sort !== 'taste' && !SORTS[o.sort]) throw new Error(`unknown sort ${o.sort}; known: ${[...Object.keys(SORTS), 'taste'].join(', ')}`);
  const cs = constraints({ ...o, moods: index.moods || [], index });
  // Each film is judged once per constraint: true, false, or unknown.
  const verdicts = index.films.map((f) => cs.map(([, fn]) => fn(f)));
  const all = index.films.filter((f, i) => verdicts[i].every((v) => v === true));
  // Films whose fact for this constraint is unknown and that fail no other constraint: what the answer may be missing.
  // "Fail no other" (true or unknown), not "pass every other": with --min-min and --max-min together, a film with no runtime is
  // unknown on both and must still be counted under each (12/10/2026). So the bands OVERLAP: a film unknown on two filters is in both,
  // and the sum of the bands is not a number of films. `excludedAsUnknownFilms` is: the DISTINCT films left out only because a fact is
  // unknown (unknown on at least one filter, failing none).
  const unknown = {};
  cs.forEach(([name], c) => {
    const n = verdicts.filter((v) => v[c] === U && v.every((x, o) => o === c || x !== false)).length;
    if (n) unknown[name] = n;
  });
  const excludedAsUnknownFilms = verdicts.filter((v) => v.includes(U) && v.every((x) => x !== false)).length;
  const taste = new Map();
  if (o.sort === 'taste') {
    const model = tasteModel(index);
    for (const f of all) taste.set(f.id, score(f, model).score);
    all.sort((a, b) => taste.get(b.id) - taste.get(a.id));
  } else all.sort(SORTS[o.sort || 'lb']);
  return { total: all.length, constraints: cs.map(([n]) => n), excludedAsUnknown: unknown, excludedAsUnknownFilms, films: all, taste };
}

/** Batch check: each id passes or names the constraints it fails (or "unknown"). */
function check(index, ids, o = {}) {
  const t = tools(index), cs = constraints({ ...o, moods: index.moods || [], index });
  return ids.map((q) => {
    const r = resolve(index, q, t);
    if (!r.film) return { query: q, ...(r.candidates ? { candidates: r.candidates.map(brief) } : { found: false }) };
    const fails = [], unknown = [];
    for (const [name, fn] of cs) { const v = fn(r.film); if (v === U) unknown.push(name); else if (!v) fails.push(name); }
    const caution = relatedSeen(index, r.film, t).map((o) => `${o.id} "${o.title}" (${o.year}${o.rt ? `, ${o.rt} min` : ''}${o.rating != null ? `, you rated ${o.rating}★` : ''}) is seen: this may be a different cut or version of the same film`);
    return { query: q, id: r.film.id, title: r.film.title, year: r.film.year, pass: !fails.length && !unknown.length, fails, unknown, ...(caution.length && !seen(r.film) ? { caution } : {}) };
  });
}

/**
 * Other records with the same title, within 3 years, that Marco has seen: Letterboxd and IMDb keep a TV cut and a cinema cut apart
 * (Fanny and Alexander 1982 188 min vs 1984 312 min). `seen` is NOT changed by this — the build (lib/guard.js) treats them as two films —
 * it is only a heads-up for whoever recommends the unseen one. Remakes decades apart (Scarface 1932 / 1983) are not related.
 */
function relatedSeen(index, f, t = tools(index)) {
  if (f.year == null || !norm(f.title)) return []; // titles in other scripts normalise to "" and would group unrelated films
  const known = (g) => (g.directors || []).map((d) => d.id);
  return (t.byTitle.get(norm(f.title)) || [])
    .filter((o) => o.id !== f.id && seen(o) && o.year != null && Math.abs(o.year - f.year) <= 3)
    // both directors known and none shared: two different films that happen to share a title (The Girl Next Door 2004 / 2007)
    .filter((o) => !(known(f).length && known(o).length && !known(f).some((d) => known(o).includes(d))))
    .map((o) => ({ id: o.id, title: o.title, year: o.year, rt: o.rt ?? null, rating: o.me.r }));
}

/** A candidate carries what tells homonyms apart: director, runtime, and whether Marco rated, saw or listed it (the same `me` the film record has). */
const brief = (f) => ({ id: f.id, title: f.title, year: f.year, directors: f.directors.map((d) => d.name).join(', ') || U, rt: f.rt ?? U, tmdb: f.tmdb ?? U, slugs: f.slugs,
  me: { r: f.me.r, liked: f.me.liked, wl: f.me.wl, seen: [...f.me.seen] } });

function tasteModel(index) {
  const rated = index.films.filter((f) => f.me.r != null && f.tTmdb != null) // the build learns only from rated films with TMDB details (build.js:175)
    .map((f) => ({ film: f, rating: f.me.r, liked: f.me.liked }));
  return learn(rated);
}

/** facet: director | cast | keyword | genre | country | lang | decade */
function taste(index, facet, { min = 2, limit = 20, order = 'top' } = {}) {
  const model = tasteModel(index);
  const rows = [...model.stats.values()].filter((s) => s.type === facet && s.n >= min)
    .sort((a, b) => (order === 'bottom' ? a.w - b.w : b.w - a.w));
  return {
    facet, marcoMean: +model.mean.toFixed(3), ratedFilms: model.count, totalFeatures: rows.length, weightOfFacet: ALPHA[facet] ?? U,
    rows: rows.slice(0, limit).map((s) => ({ label: s.label, n: s.n, avg: +s.avg.toFixed(2), deviation: +s.w.toFixed(3), examples: s.films })),
  };
}

const SHRINK_K = 20;
/** Affinity: centered (each person's own mean over all their ratings) cosine on films both rated, shrunk by n/(n+20). */
function friends(index, { minOverlap = 0 } = {}) {
  const mine = index.films.filter((f) => f.me.r != null);
  const myMean = mine.reduce((a, f) => a + f.me.r, 0) / (mine.length || 1);
  const myById = new Map(mine.map((f) => [f.id, f.me.r]));
  const rows = [];
  for (const [user, p] of Object.entries(index.people)) {
    const theirMean = p.rated.reduce((a, [, r]) => a + r, 0) / (p.rated.length || 1);
    let sxy = 0, sxx = 0, syy = 0, n = 0, diff = 0;
    for (const [id, r] of p.rated) {
      if (!myById.has(id)) continue;
      const x = myById.get(id) - myMean, y = r - theirMean;
      sxy += x * y; sxx += x * x; syy += y * y; n++; diff += r - myById.get(id);
    }
    const corr = n >= 2 && sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
    rows.push({ user, name: p.name, configured: p.configured, overlap: n, theirRated: p.rated.length, marcoRated: mine.length,
      corr: corr == null ? U : +corr.toFixed(3), shrunk: corr == null ? U : +(corr * n / (n + SHRINK_K)).toFixed(3),
      meanGapOnOverlap: n ? +(diff / n).toFixed(2) : U, unresolvedSlugs: p.unresolved, fetchedAt: p.fetchedAt || U,
      ...(p.ratingsIgnored ? { ratingsIgnored: true, ratingsIgnoredBy: p.ratingsIgnoredBy, theirSeen: (p.seen || []).length } : {}) });
  }
  const kept = rows.filter((r) => r.overlap >= minOverlap)
    .sort((a, b) => (b.shrunk === U ? -2 : b.shrunk) - (a.shrunk === U ? -2 : a.shrunk));
  // An account in config.json ratingsIgnored (22/10/2026) has theirRated 0 and no affinity BY RULE, not for lack of films: it is named here, with how many films it saw, so that a missing row is not read as "no data".
  const ignored = rows.filter((r) => r.ratingsIgnored).map(({ user, name, theirSeen, ratingsIgnoredBy }) => ({ user, name, by: ratingsIgnoredBy, seen: theirSeen }));
  return { accounts: rows.length, shown: kept.length, configured: rows.filter((r) => r.configured).length, ...(ignored.length ? { ratingsIgnored: ignored } : {}), method: `centered cosine on overlap, shrunk × n/(n+${SHRINK_K})`, rows: kept };
}

/** Set specs: watchlist | seen | rated[>=x] | eligible | friend:<user>[:watchlist|:rated>=x] | friends[:rated>=x] | crowd[:rated>=x] | list:<id> */
function setOf(index, spec) {
  // rated>=4 · rated>4 · rated<=2 · rated<3 · rated=5 → a predicate on the rating; no operator = every rating
  const thr = (s) => {
    const tail = s.replace(/^[a-z]+/, '');
    if (!tail) return null;
    const m = tail.match(/^(>=|<=|>|<|=)(\d+(?:\.\d+)?)$/);
    if (!m) throw new Error(`bad threshold in ${s}`);
    const v = Number(m[2]);
    return { '>=': (r) => r >= v, '<=': (r) => r <= v, '>': (r) => r > v, '<': (r) => r < v, '=': (r) => r === v }[m[1]];
  };
  const ids = new Set();
  const people = (filter) => Object.entries(index.people).filter(([u, p]) => filter(u, p));
  // A person whose ratings are ignored (config.json ratingsIgnored) has no ratings: "every rating" (no operator) means the films he SAW, and a threshold on his rating matches nothing.
  const addRated = (p, ok) => { if (p.ratingsIgnored && !ok) for (const id of p.seen || []) ids.add(id); else for (const [id, r] of p.rated) if (!ok || ok(r)) ids.add(id); };
  if (spec === 'watchlist') index.films.filter((f) => f.me.wl).forEach((f) => ids.add(f.id));
  else if (spec === 'seen') index.films.filter(seen).forEach((f) => ids.add(f.id));
  else if (spec === 'eligible') index.films.filter((f) => f.elig === true).forEach((f) => ids.add(f.id));
  else if (spec.startsWith('rated')) { const ok = thr(spec); index.films.filter((f) => f.me.r != null && (!ok || ok(f.me.r))).forEach((f) => ids.add(f.id)); }
  else if (spec.startsWith('friend:')) {
    const [, user, what = 'rated'] = spec.split(':');
    const hit = people((u) => u.toLowerCase() === user.toLowerCase());
    if (!hit.length) throw new Error(`unknown account: ${user}`);
    const p = hit[0][1];
    if (what === 'watchlist') p.watchlist.forEach((id) => ids.add(id)); else addRated(p, thr(what));
  } else if (spec.startsWith('friends') || spec.startsWith('crowd')) {
    const onlyConfigured = spec.startsWith('friends');
    const [, what = 'rated'] = spec.split(':');
    for (const [, p] of people((u, x) => !onlyConfigured || x.configured)) {
      if (what === 'watchlist') p.watchlist.forEach((id) => ids.add(id)); else addRated(p, thr(what));
    }
  } else if (spec.startsWith('list:')) {
    const l = index.lists[spec.slice(5)];
    if (!l) throw new Error(`unknown list: ${spec.slice(5)} (known: ${Object.keys(index.lists).join(', ')})`);
    l.ids.forEach((id) => ids.add(id));
  } else throw new Error(`unknown set: ${spec}`);
  return ids;
}

function overlap(index, a, b) {
  const A = setOf(index, a), B = setOf(index, b);
  const both = [...A].filter((id) => B.has(id)), onlyA = [...A].filter((id) => !B.has(id)), onlyB = [...B].filter((id) => !A.has(id));
  return { a, b, sizeA: A.size, sizeB: B.size, both: both.length, onlyA: onlyA.length, onlyB: onlyB.length, ids: { both, onlyA, onlyB } };
}

// Mirrors W in lib/rows.js (not exported there); tools/films/films.test.js reads that file and fails if the two drift.
const RANK_WEIGHTS = { fit: 1.1, taste: 1.0, quality: 0.55, lists: 0.3, vouch: 0.15 };
const FIT_CAP = 1.6; // moodRank uses Math.min(fit.norm, 1.6)
const FIT_NORM_DIVISOR = 1.75; // lib/moods.js: norm = fit / (minFit × 1.75)
const EXTRAS = { watchlist: 0.35, pin: 10, recCount: 0.12 }; // lib/rows.js; pinned to it by a test
const r2 = (x) => Math.round(x * 100) / 100;

/**
 * moodRank = 1.1×min(fitNorm,1.6) + 1.0×taste + 0.55×quality (+ 0.3×lists, + 0.15 vouch, + 0.35 watchlist, + 0.12×log2(1+recCount), + 10 pin):
 * each term as the snapshot recorded it. `lists` (the record's lw) and `vouch` (its cv) are listed only when the record carries them; a
 * record without them gets a note saying the term was not recorded (it may be 0, it may be missing: the CLI does not guess).
 */
function decompose(web, rowId) {
  if (!web || web.f?.[rowId] == null || web.ts == null || web.q == null) return undefined;
  const parts = [['fit', 'fitNorm', Math.min(web.f[rowId], FIT_CAP)], ['taste', 'taste', web.ts], ['quality', 'quality', web.q]]
    .map(([key, name, value]) => ({ name, value, weight: RANK_WEIGHTS[key], product: r2(RANK_WEIGHTS[key] * value) }));
  const extras = [];
  const hasLists = typeof web.lw === 'number' && Number.isFinite(web.lw), hasVouch = web.cv === 1;
  if (hasLists) extras.push({ name: 'lists', value: web.lw, weight: RANK_WEIGHTS.lists, product: r2(RANK_WEIGHTS.lists * web.lw) });
  if (hasVouch) extras.push({ name: 'vouch', product: RANK_WEIGHTS.vouch });
  if (web.w) extras.push({ name: 'watchlist', product: EXTRAS.watchlist });
  if (web.pins?.includes(rowId)) extras.push({ name: 'pin', product: EXTRAS.pin });
  const heaviest = [...parts, ...extras].reduce((a, c) => (c.product > a.product ? c : a)).name; // a pin (+10) outweighs everything
  const unrecorded = [!hasLists && `lists (${RANK_WEIGHTS.lists}×lw)`, !hasVouch && `vouch (+${RANK_WEIGHTS.vouch})`].filter(Boolean);
  return { formula: `moodRank = ${RANK_WEIGHTS.fit}×min(fitNorm,${FIT_CAP}) + ${RANK_WEIGHTS.taste}×taste + ${RANK_WEIGHTS.quality}×quality (+ ${RANK_WEIGHTS.lists}×lists, + ${RANK_WEIGHTS.vouch} vouch, + ${EXTRAS.watchlist} watchlist, + ${EXTRAS.pin} pin, + ${EXTRAS.recCount}×log2(1+recCount))`,
    components: parts, extras, heaviest,
    sumOfRecordedParts: r2(parts.reduce((a, c) => a + c.product, 0) + extras.reduce((a, c) => a + c.product, 0)),
    note: `fitNorm = fit / (minFit × ${FIT_NORM_DIVISOR}) (lib/moods.js), the mood-recipe score scaled by the mood's own threshold, not the raw fit. Values are the snapshot's, rounded to 2 decimals; the recCount term (${EXTRAS.recCount}×log2(1+n)) is not recorded in the snapshot, so the sum can be slightly short.`
      + (unrecorded.length ? ` Not recorded in this record: ${unrecorded.join(', ')}; the term may be 0 (the build publishes lw only above 0 and cv only for a vouched film) or the snapshot may predate the field; the CLI does not guess.` : '') };
}

/**
 * The explanation a published revision actually carried. Reads a private snapshot (build.js --private-dir) whose
 * manifest.sourceRevision or id starts with `revision`. Without one the answer names what is missing (never a bare "unknown",
 * never a reconstruction). When the snapshot has the film, `recorded.rank` splits the moodRank into fit, taste and quality.
 * `now: true` adds today's recomputation, labelled as such: it does not prove what was decided on the day.
 */
function why(index, query, { revision, row, snapshots, now = false } = {}) {
  const r = resolve(index, query);
  if (!r.film) return { query, ...(r.candidates ? { candidates: r.candidates.map(brief) } : { found: false }) };
  const f = r.film;
  const out = { id: f.id, title: f.title, year: f.year, revision: revision || U, row: row || U, recorded: U };
  const missing = snapshots ? !fs.existsSync(snapshots) : false;
  if (!revision && !snapshots) out.recorded = { status: 'no-revision', message: 'sem revisão: passe --revision <sha> para ler o registro histórico (o que está abaixo é só o cálculo de hoje)' };
  else if (!snapshots || missing) out.recorded = { status: 'snapshots-not-found', message: `registro histórico não encontrado em ${snapshots || '(nenhuma pasta indicada)'}; passe --snapshots` };
  else {
    // Every snapshot folder with a manifest and a baseline, newest capture first (ties: folder name).
    const snaps = fs.readdirSync(snapshots, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort().map((d) => {
      const mf = path.join(snapshots, d, 'manifest.json'), bf = path.join(snapshots, d, 'baseline.json');
      if (!fs.existsSync(mf)) return null;
      const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
      return { d, m, bf: fs.existsSync(bf) ? bf : null };
    }).filter(Boolean);
    const sha = (m) => String(m.sourceRevision || m.id || U).split('+')[0].slice(0, 12);
    const day = (m) => String(m.capturedAt || U).slice(0, 10);
    const pool = revision ? snaps.filter(({ m }) => String(m.sourceRevision || '').startsWith(revision) || String(m.id || '').startsWith(revision)) : snaps;
    if (revision && !pool.length) out.recorded = { status: 'revision-not-found', message: `nenhum snapshot com a revisão ${revision} em ${snapshots}` };
    else {
      const read = ({ d, m, bf }) => {
        const data = bf ? JSON.parse(fs.readFileSync(bf, 'utf8')).data || {} : {};
        return { d, m, board: data.plan?.board || [], webFilms: data.webData?.films || [], hasBaseline: !!bf };
      };
      const loaded = pool.map(read);
      const validRows = [...new Set(loaded.flatMap((x) => x.board.map((r) => r.id)))];
      const hitsOf = (x) => (row ? x.board.filter((r) => r.id === row) : x.board).map((r) => [r, (r.items || []).find((i) => i.id === f.id)]).filter(([, it]) => it);
      if (row && loaded.some((x) => x.hasBaseline) && !validRows.includes(row)) out.recorded = { status: 'unknown-row', message: `linha desconhecida: ${row}; linhas válidas: ${validRows.join(', ')}` };
      else if (revision && loaded.length && !loaded[0].hasBaseline) out.recorded = { status: 'baseline-missing', message: `snapshot ${loaded[0].d} sem baseline.json em ${snapshots}` };
      else {
        const withFilm = loaded.map((x) => ({ x, hits: hitsOf(x) })).filter((y) => y.hits.length);
        // with a revision the first matching capture is read (as before); without one, the newest capture that has the film
        // Same capturedAt: a real revision beats "local" (a dev checkout), then folder name; the tie itself is reported below.
        const isLocal = (y) => String(y.x.m.sourceRevision || '') === 'local';
        const ordered = revision ? withFilm : withFilm.sort((p, q) => String(q.x.m.capturedAt || '').localeCompare(String(p.x.m.capturedAt || '')) || (isLocal(p) - isLocal(q)) || (p.x.d < q.x.d ? -1 : 1));
        if (revision && pool.length > 1) out.snapshotsMatching = pool.map((x) => x.d); // several captures of one revision: the first is read, the others named
        if (!ordered.length) {
          const where = `${row ? ` na linha ${row}` : ''}`;
          out.recorded = revision
            ? { status: 'absent', absent: `snapshot ${pool[0].m.id || pool[0].d} (${pool[0].m.capturedAt || U}) has no such item${row ? ` in ${row}` : ''}` }
            : { status: 'no-record', message: `nenhum registro histórico com este filme em ${snapshots}${where}` };
        } else {
          const { x, hits } = ordered[0];
          const rowsOut = hits.map(([r, it]) => {
            const rank = decompose(x.webFilms.find((w) => w.i === f.id), r.id);
            return { row: r.id, position: r.items.indexOf(it) + 1, of: r.items.length, why: it.why || [], ...(rank ? { rank } : {}) };
          });
          const first = rowsOut.find((r) => r.rank) || rowsOut[0]; // the mood row (the one moodRank decided) leads; rows keeps board order
          const { rank, ...rest } = first;
          out.recorded = { ...rest, source: `snapshot ${x.m.id || x.d} (${x.m.capturedAt || U})`,
            ...(revision ? {} : { label: `registro mais recente encontrado (${day(x.m)}, revisão ${sha(x.m)})` }),
            rows: rowsOut, // every row of that snapshot that held the film, each with its reasons and its own rank when recorded
            ...(rank ? { rank } : { rankNote: 'no recorded fit/taste/quality for this film in this row (not a mood row, or the snapshot did not keep it): no decomposition is invented' }) };
          if (!revision) out.revision = sha(x.m); // the top-level field says which revision answered
          const tied = revision ? [] : ordered.filter((y) => String(y.x.m.capturedAt || '') === String(x.m.capturedAt || ''));
          if (tied.length > 1) { out.recorded.empate = true; out.recorded.revisoesEmpatadas = tied.map((y) => sha(y.x.m)); }
          if (!revision && ordered.length > 1) out.otherRecords = ordered.slice(1).map(({ x: o, hits: hs }) => ({ revision: sha(o.m), capturedAt: o.m.capturedAt || U,
            rows: hs.map(([r, it]) => ({ row: r.id, position: r.items.indexOf(it) + 1, of: r.items.length })) }));
        }
      }
    }
  }
  // Always: how each mood recipe scores this film today (lib/moods.js + config.json). Recomputed, not the revision's record.
  out.moodFitNow = (index.moods || []).map((m) => { const r = moodFit(index, f, m); return { mood: m.id, name: m.name, fit: +r.fit.toFixed(2), minFit: m.minFit ?? 2, ok: r.ok, hits: r.hits }; });
  if (now) {
    const s = score(f, tasteModel(index));
    out.recomputedNow = { note: 'today\'s taste model, not the revision\'s record', score: +s.score.toFixed(3),
      contributions: s.contributions.sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 8).map((c) => ({ type: c.type, label: c.label, n: c.n, deviation: +c.w.toFixed(3) })) };
    out.moodRankNow = { note: 'today\'s calculation; it does not prove what was decided on the day. Only the fit term is recomputed: the taste and quality z-scores are measured against the whole candidate pool of a build, which the CLI does not rebuild.',
      rows: (index.moods || []).map((m) => { const x = moodFit(index, f, m); return { mood: m.id, fitNorm: r2(x.norm), fitTerm: r2(RANK_WEIGHTS.fit * Math.min(x.norm, FIT_CAP)) }; }) };
  }
  return out;
}

function health(index) {
  const films = index.films;
  const count = (fn) => films.filter(fn).length;
  const mineRated = films.filter((f) => f.me.r != null);
  return {
    films: films.length,
    withImdb: count((f) => /^tt/.test(f.id)),
    letterboxdFilms: count((f) => f.slugs.length),
    letterboxdWithoutTmdb: count((f) => f.slugs.length && f.tmdb == null),
    letterboxdWithoutAverage: count((f) => f.slugs.length && f.lb == null),
    withoutRuntime: count((f) => f.rt == null),
    marcoRated: mineRated.length,
    marcoRatedWithoutImdb: count((f) => f.me.r != null && !/^tt/.test(f.id)),
    marcoRatedPendingTmdbMatch: index.meta.ratedPending.length,
    pendingExamples: index.meta.ratedPending.slice(0, 5).map((p) => `${p.title} (${p.year})`),
    // Rows of the export whose title+year search hit nothing confirms (a homonym may have won): not linked to any film, candidates listed.
    ambiguousTmdbMatch: (index.meta.ambiguous || []).length,
    ambiguousExamples: (index.meta.ambiguous || []).slice(0, 8).map((a) => `${a.title} (${a.year}) → ${a.candidates.map((c) => c.id).join(' | ')}`),
    eligible: count((f) => f.elig === true), ineligible: count((f) => f.elig === false), eligibilityNotApplicable: count((f) => f.elig === null),
    // the floor exception (vouched films): how many records carry it, how many pass ONLY through it, and the films data/directors-loved.json
    // names that have no record here (no Letterboxd page and not in the TMDB cache): counted, never invented as films
    vouched: count((f) => f.cv === true), eligibleOnlyByException: count((f) => f.onlyByException === true), lovedWithoutRecord: index.meta.lovedWithoutRecord ?? U,
    identityConflicts: index.meta.identityConflicts.length,
    accounts: Object.keys(index.people).length, configuredAccounts: Object.values(index.people).filter((p) => p.configured).length,
    lists: Object.keys(index.lists).length,
    // When the DATA was captured. `sources` below carries file modification times, which are the time of a checkout (git sets them), not the age of the data.
    capturedAt: { export: index.meta.exportAt || U, letterboxdMe: index.meta.meAt || U, liveWatchlist: index.meta.watchlistAt || U, indexBuilt: index.meta.builtAt || U,
      newestRecord: { tmdb: index.meta.cacheNewest?.tmdb || U, letterboxdFilms: index.meta.cacheNewest?.letterboxdFilms || U, friends: index.meta.cacheNewest?.friends || U, lists: index.meta.cacheNewest?.lists || U } },
    sources: index.meta.files,
  };
}

/** One film, everything known, unknowns spelled out. */
function dossier(index, query, t = tools(index)) {
  const r = resolve(index, query, t);
  if (!r.film) return { query, ...(r.candidates ? { candidates: r.candidates.map(brief) } : { found: false }) };
  return { query, film: r.film };
}

module.exports = { U, RANK_WEIGHTS, FIT_CAP, FIT_NORM_DIVISOR, EXTRAS, relatedSeen, tools, resolve, search, check, taste, friends, overlap, setOf, why, health, dossier, tasteModel, SHRINK_K };
