// What the curated lists say about a film, beyond being in them (Marco, 11/10/2026).
//
//   trust     every list in config.json says who made it: "critic" (a critic, a publication or an institution), "director" (a
//             film-maker's own picks) or "fan" (a mood list, a fan's list, a ranking by the public). Written, never guessed:
//             a list without it stops the build (validateLists).
//   vouch     a film in a critic or director list is "vouched for": it may be recommended without the 3.5 Letterboxd floor
//             (lib/recommendation-quality.js) and gets the same light push at every position of the Safe bet ↔ Wildcard dial.
//             A fan list vouches for nothing: its films still need the floor.
//   subset    a `fan` list may name `criticSubset` (lib/critic-subset.js): a file of films the critics endorsed. Only those films are
//             vouched for, per film × list; the others stay fan. The list's agreement weight still covers the WHOLE list.
//   agreement each list weighs what Marco's own ratings say about it: the mean of his ratings on the films of the list he rated,
//             against his mean over everything he rated, pulled toward "no difference" by PRIOR rated films (a Bayesian mean
//             with a prior of PRIOR films at his overall mean: 4 rated films at 5★ say little, 190 say a lot). One star above
//             his mean (FULL) is the whole weight; at or below his mean the list adds nothing (it is never a penalty: the film
//             stays in the bank and the floor and the taste still decide). Recomputed on every build.
//   position  in a list longer than LONG films the weight falls with the position ONLY when his ratings show it: positions are
//             cut in bands of BAND, each band's mean is pulled toward the list's own mean by PRIOR films, and a band whose mean
//             is DROP★ or more under the list's takes that lower weight. A band with no rated film keeps the band before it.
//   combined  a film in several lists: 1 − ∏(1 − wᵢ), so two strong lists push more than one but never past 1.
//
// Pure functions: build.js feeds them the lists, the Letterboxd film records and Marco's ratings; test/catalog-expansion.test.js fakes.

const path = require("node:path");
const CS = require("./critic-subset");
const TRUST = Object.freeze(["critic", "director", "fan"]);
const VOUCHES = new Set(["critic", "director"]);
const PRIOR = 10;   // rated films the prior is worth (Marco, 11/10/2026: "puxada para o neutro quando há poucos vistos")
const FULL = 1.0;   // stars above Marco's mean for the whole weight
const LONG = 500;   // lists longer than this are measured by position
const BAND = 250;   // positions per band
const DROP = 0.15;  // stars under the list's mean for a band to count as a fall
const LIST_ORDERS = Object.freeze(["rating"]); // `order` of a list (Marco, 22/10/2026 ~19:30 UTC): absent = the source's order; "rating" = the film's Letterboxd average, highest first (lib/pool.js listSequence)
const SHORT_MAX = 28; // characters of a list's `short`, its entry in the Discover menus (Marco, 22/10/2026 ~04:05 UTC: one line on the phone, up to 28)

/** Every list has an id, a url or a boxd.it id, and a trust the config spells out. → the lists, or throws naming what is wrong. */
function validateLists(lists) {
  const problems = [], ids = new Set(), names = new Set(), shorts = new Set();
  for (const [i, l] of (lists || []).entries()) {
    const at = `lists[${i}]${l && l.id ? ` (${l.id})` : ""}`;
    if (!l || typeof l.id !== "string" || !l.id) { problems.push(`${at}: no id`); continue; }
    if (ids.has(l.id)) problems.push(`${at}: id used twice`);
    ids.add(l.id);
    if (typeof l.name !== "string" || !l.name) problems.push(`${at}: no name`);
    else if (names.has(l.name)) problems.push(`${at}: name used twice (it is the Discover menu entry)`);
    else names.add(l.name);
    // `short` (Marco, 22/10/2026 ~04:05 UTC): the Discover menu entry of the list; the source abbreviated in front, no author's handle, one line (SHORT_MAX), never a path character, one list each.
    if (l.short !== undefined) {
      if (typeof l.short !== "string" || !l.short.trim()) problems.push(`${at}: short must be a non-empty string`);
      else if (l.short.length > SHORT_MAX) problems.push(`${at}: short "${l.short}" has ${l.short.length} characters, the menu line holds ${SHORT_MAX}`);
      else if (/[()\/\\?#%]/.test(l.short)) problems.push(`${at}: short "${l.short}" has a parenthesis or a path character (the author stays in the description, not in the menu)`);
      else if (shorts.has(l.short)) problems.push(`${at}: short "${l.short}" used twice (it is the Discover menu entry)`);
      else shorts.add(l.short);
    }
    if (l.order !== undefined && !LIST_ORDERS.includes(l.order)) problems.push(`${at}: order must be ${LIST_ORDERS.map((o) => JSON.stringify(o)).join(" or ")} (or absent: the source's order), not ${JSON.stringify(l.order)}`);
    if (l.criticSubset !== undefined && (typeof l.criticSubset !== "string" || !l.criticSubset)) problems.push(`${at}: criticSubset must be a file path`);
    else if (l.criticSubset && l.trust !== "fan") problems.push(`${at}: criticSubset only on a "fan" list (a critic or director list vouches for every film already), not "${l.trust}"`);
    if (l.criticSubsetLabel !== undefined && (typeof l.criticSubsetLabel !== "string" || !l.criticSubsetLabel)) problems.push(`${at}: criticSubsetLabel must be a non-empty string`);
    if (!TRUST.includes(l.trust)) problems.push(`${at}: trust must be ${TRUST.join(", ")} (Marco, 11/10/2026: written in the config, never guessed), not ${JSON.stringify(l.trust)}`);
    for (const c of l.corrections || []) if (!c || typeof c.from !== "string" || typeof c.to !== "string" || !c.from || !c.to || typeof c.why !== "string" || !c.why) problems.push(`${at}: a correction needs from, to and why`);
    // `top` (Marco, 22/10/2026 ~06:45 UTC): only the first N films of a Letterboxd list enter; a whole-number cut, never on a list that is not read page by page
    if (l.top !== undefined) {
      if (!Number.isInteger(l.top) || l.top < 1) problems.push(`${at}: top must be a whole number of films, 1 or more, not ${JSON.stringify(l.top)}`);
      else if (l.source === "static") problems.push(`${at}: top cuts a list read from Letterboxd; a static list is cut in its own file`);
      else if (l.popular) problems.push(`${at}: top does not apply to "Popular this week" (one page, every night)`);
    }
    if (l.checked !== undefined && !(l.checked && /^\d{4}-\d{2}-\d{2}$/.test(l.checked.on || "") && Number.isInteger(l.checked.films) && l.checked.films > 0)) problems.push(`${at}: checked needs { on: YYYY-MM-DD, films }`);
  }
  if (problems.length) throw new Error(`config.json lists: ${problems.join("; ")}`);
  return lists;
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const shrunk = (sum, n, prior) => (sum + PRIOR * prior) / (n + PRIOR);
const weightOf = (mean, overall) => clamp01((mean - overall) / FULL);
const combine = (ws) => 1 - ws.reduce((p, w) => p * (1 - w), 1);

/**
 * How much Marco agreed with one list. rated: [{ pos (1-based), rating }], one per film. size: the list's length.
 * → { n, raw, mean, weight, bands: [{ from, to, n, mean, weight, fall }] | null, at(pos) → weight }
 */
function agreement(rated, { overall, size }) {
  const n = rated.length, sum = rated.reduce((a, r) => a + r.rating, 0);
  const raw = n ? sum / n : null;
  const mean = n ? shrunk(sum, n, overall) : overall;
  const weight = n ? weightOf(mean, overall) : 0; // nothing rated: exactly no weight (not a rounding error away from it)
  let bands = null;
  if (size > LONG) {
    bands = [];
    for (let from = 1; from <= size; from += BAND) {
      const inBand = rated.filter((r) => r.pos >= from && r.pos < from + BAND);
      const bn = inBand.length, bsum = inBand.reduce((a, r) => a + r.rating, 0);
      // pulled toward the list's own mean (not Marco's): a band speaks only through its own ratings
      const bmean = bn ? shrunk(bsum, bn, mean) : null;
      const prev = bands[bands.length - 1];
      const fall = bmean != null && bmean <= mean - DROP;
      const w = bmean == null ? (prev ? prev.weight : weight) : fall ? Math.min(weight, weightOf(bmean, overall)) : weight;
      bands.push({ from, to: Math.min(size, from + BAND - 1), n: bn, mean: bmean, weight: w, fall });
    }
  }
  const at = (pos) => (bands ? (bands[Math.min(bands.length - 1, Math.floor((pos - 1) / BAND))] || { weight }).weight : weight);
  return { n, raw, mean, weight, bands, at };
}

/**
 * lists     lib/lists.js refreshLists().lists (with trust; items in the curator's order, corrections applied)
 * films     slug → Letterboxd film record (cache/friends.json: imdbId, tmdbId, gone)
 * ratingOf  (record) → Marco's rating of that film (0.5–5) or null
 * overall   Marco's mean over everything he rated
 * → { lists: [{ id, name, trust, size, ...agreement }], byTt: Map(tt → film signal), overall }
 *   film signal: { lw (0–1), cv (1 or absent), cvList, cvTrust, tmdbClaims: [the TMDB ids the Letterboxd records name], lists: [{ id, pos, w }] }
 *   A claim is NOT a TMDB id yet: Letterboxd's TMDB id of a series is a TV id, and the TMDB movie with that number is another film
 *   (histoires-du-cinema names 206647, which is Spectre). joinTmdb() below turns claims into `tmdb` only when the IMDb ids agree.
 */
function signals({ lists = [], films = {}, ratingOf = () => null, overall, subsets = new Map() }) {
  const out = { lists: [], byTt: new Map(), overall, subsetWarnings: [] };
  const recs = [];
  for (const l of lists) {
    if (l.criticSubset && !subsets.has(l.id)) throw new Error(`list ${l.id} (${l.name}): criticSubset ${l.criticSubset} was not loaded (lib/critic-subset.js loadAll); refusing to treat the whole list as fan silently`);
    if (l.criticSubset) out.subsetWarnings.push(...CS.warnings(l, subsets.get(l.id), films));
    const seenTt = new Set(), rated = [], members = [];
    l.items.forEach((it, i) => {
      const r = films[it.slug];
      if (!r || r.gone || !r.imdbId || seenTt.has(r.imdbId)) return;
      seenTt.add(r.imdbId);
      members.push({ r, pos: i + 1, slug: it.slug });
      const mine = ratingOf(r);
      if (mine != null) rated.push({ pos: i + 1, rating: mine });
    });
    const a = agreement(rated, { overall, size: l.items.length });
    out.lists.push({ id: l.id, name: l.name, trust: l.trust, size: l.items.length, ...a });
    recs.push({ l, a, members, sub: l.criticSubset ? subsets.get(l.id) : null });
  }
  for (const { l, a, members, sub } of recs)
    for (const { r, pos, slug } of members) {
      const s = out.byTt.get(r.imdbId) || { lw: 0, lists: [], tmdbClaims: [] };
      s.lists.push({ id: l.id, pos, w: a.at(pos) });
      if (r.tmdbId && !s.tmdbClaims.includes(r.tmdbId)) s.tmdbClaims.push(r.tmdbId);
      if (VOUCHES.has(l.trust) && !s.cv) { s.cv = 1; s.cvList = l.name; s.cvTrust = l.trust; }
      else if (sub && !s.cv) {
        // the critics' endorsement of THIS film in THIS list; a disagreeing IMDb id in the file means the slug is not the film it meant
        const e = sub.get(slug);
        if (e && (!e.imdb || e.imdb === r.imdbId)) { s.cv = 1; s.cvList = l.name; s.cvTrust = "critic"; s.cvWhy = e.label; }
      }
      out.byTt.set(r.imdbId, s);
    }
  for (const s of out.byTt.values()) s.lw = combine(s.lists.map((x) => x.w));
  return out;
}

/** Nothing from the lists: what a build without sources (or the v2.3 reference) sees. */
const NONE = Object.freeze({ lists: [], byTt: new Map(), overall: null });

/**
 * Marco's rating of a list's film, by IMDb id on BOTH sides (review S4-C, 11/10/2026). The list film's identity is the IMDb id of its
 * Letterboxd page (r.imdbId). His film's identity is, in this order:
 *   1. the IMDb id of the TMDB record his history was matched to (f.film.imdb, after the homonym correction);
 *   2. for a rated film with no IMDb id from TMDB (Three Colours: White, Scenes from a Marriage, a series), the IMDb id of HIS OWN Letterboxd
 *      page: the one slug of his diary (`me`) whose Letterboxd record (`films`) has the same title and year, when exactly one IMDb id
 *      answers. Two answers: nothing.
 * A TMDB id is never enough: Letterboxd names a series by its TV id, and the TMDB MOVIE with that number is another film (paranoia-agent
 * names 9343, which is Fitzcarraldo: the list inherited his 4.5). Nor is a bare title and year: a film with no IMDb id rates nothing.
 * all: the build's history [{ rating, title, year, film: { imdb } }] · films: slug → Letterboxd record · me: Set of his slugs
 * → (record) → rating or null.
 */
function ratingByImdb(all, { films = {}, me = new Set() } = {}) {
  const { filmKey } = require("./util");
  const isTt = (x) => /^tt\d+$/.test(x || "");
  const own = new Map(); // title|year → Set of IMDb ids of his own Letterboxd pages
  for (const slug of me) { const r = films[slug]; if (!r || r.gone || !isTt(r.imdbId)) continue; const k = filmKey(r.title, r.year); (own.get(k) || own.set(k, new Set()).get(k)).add(r.imdbId); }
  const mine = new Map();
  for (const f of all || []) {
    if (!f || f.rating == null) continue;
    let tt = f.film && isTt(f.film.imdb) ? f.film.imdb : null;
    if (!tt) { const ids = own.get(filmKey(f.title, f.year)); if (ids && ids.size === 1) tt = [...ids][0]; }
    if (tt && !mine.has(tt)) mine.set(tt, f.rating);
  }
  return (r) => (r && mine.has(r.imdbId) ? mine.get(r.imdbId) : null);
}

/**
 * The agreement weight as the web data publishes it (review S3-A, 11/10/2026): rounded to two decimals FIRST, then kept only when the
 * ROUNDED number is above 0. A weight in (0, 0.005) rounds to 0, and 0 is not a weight the publication accepts (lib/learning/public.js
 * listWeight refuses it and the build stops), so such a film is published without `lw`, exactly like a film in no weighing list.
 * → a number in (0, 1] with at most two decimals, or undefined.
 */
function publicWeight(lw) {
  if (typeof lw !== "number" || !Number.isFinite(lw)) return undefined;
  const v = Math.round(Math.min(lw, 1) * 100) / 100;
  return v > 0 ? v : undefined;
}

/**
 * The TMDB movie of every list film, joined by the IMDb id of its Letterboxd page (the way lib/directors-loved.js joins its file):
 *   1. a claimed TMDB id whose movie record carries the same IMDb id is the film's `tmdb`;
 *   2. otherwise TMDB's /find for the IMDb id (fromImdb), which answers by IMDb id;
 *   3. otherwise the film has no `tmdb` and stays out of the candidates.
 * movie(id) → TMDB movie record or null (build.js: tmdb.movie, cached; offline: the cache only). fromImdb(tt) → TMDB id or null.
 * skip(tt) → true for films not to join (the seen ones). Sets s.tmdb on sig.byTt's signals.
 * → counts for the build's log: { confirmed, viaFind, missing } add up to the films joined or not; `refused` (a named TMDB id was another
 *   film) is a part of viaFind + missing, `refusedFound` the part of it /find answered (so refused − refusedFound ≤ missing).
 */
async function joinTmdb(sig, { movie, fromImdb, skip = () => false }) {
  const n = { confirmed: 0, viaFind: 0, refused: 0, missing: 0, refusedFound: 0 }; // refused: a named TMDB id was another film; refusedFound: of them, /find answered
  await Promise.all([...sig.byTt].filter(([tt]) => !skip(tt)).map(async ([tt, s]) => {
    delete s.tmdb;
    let refused = false;
    for (const id of s.tmdbClaims || []) {
      const p = await movie(id);
      if (p && p.imdb === tt) { s.tmdb = id; n.confirmed++; return; }
      if (p) refused = true;
    }
    if (refused) n.refused++;
    const found = await fromImdb(tt);
    if (found) { s.tmdb = found; n.viaFind++; if (refused) n.refusedFound++; } else n.missing++;
  }));
  return n;
}

/**
 * The same join for the private learning experiment's list sources (build.js runSources `shadowSources`, the `kind: "list"` items;
 * review of catalog-expansion, security finding 3; written 11/10/2026, landed 13/10/2026 in branch v24-hardening). Those items took
 * `tmdb.peek(record.tmdbId)` with no check, so the private snapshot could pair a list film's IMDb id with another film's TMDB record (a
 * series' TV id: paranoia-agent → 9343, Fitzcarraldo). Since 12/10/2026 build.js has already dropped such a wrong id from the view
 * (lib/tmdb-identity.js consistentFilms) when the cache holds that movie, so on the 13/10 caches this join adds what that drop does not:
 * the film's own record through /find (4 list films), and one rule, production's, for the claim. test/shadow-list-join.test.js pins both.
 * lists: [{ items: [{ slug }] }] · films: slug → Letterboxd record · movie / fromImdb: as joinTmdb (build.js passes the cache only:
 * production's own join has already fetched what it needed). → { tmdbOf(tt) → TMDB id or null, counts (joinTmdb's) }
 */
async function joinListFilms(lists, films, { movie, fromImdb }) {
  const byTt = new Map();
  for (const l of lists || []) for (const it of l.items || []) {
    const r = films[it.slug];
    if (!r || r.gone || !r.imdbId) continue;
    const s = byTt.get(r.imdbId) || byTt.set(r.imdbId, { tmdbClaims: [] }).get(r.imdbId);
    if (r.tmdbId && !s.tmdbClaims.includes(r.tmdbId)) s.tmdbClaims.push(r.tmdbId);
  }
  const counts = await joinTmdb({ byTt }, { movie, fromImdb });
  return { tmdbOf: (tt) => (tt && byTt.get(tt)?.tmdb) || null, counts };
}

/** The vouched films for the recommendation rule: tt → { list, trust }. */
function vouched(sig) {
  const out = new Map();
  for (const [tt, s] of sig.byTt) if (s.cv === 1) out.set(tt, s.cvWhy ? { list: s.cvList, trust: s.cvTrust, why: s.cvWhy } : { list: s.cvList, trust: s.cvTrust });
  return out;
}

/**
 * The same vouched films from the caches alone (config.json + cache/lists.json + cache/friends.json films), as a build with
 * --cache-only sees them: for whoever recomputes the recommendation rule outside build.js (the learning replay, the tests).
 */
function vouchedFromCaches({ cfg = {}, listsCache = {}, films = {}, root = path.join(__dirname, ".."), files = null,
  // the critics' subsets (Cannes) from the same place as the static lists: the frozen `files` of a snapshot, or the repository
  subsets = files ? CS.loadAll("", cfg.lists, (p) => { const k = p.replace(/^\//, ""); if (!(k in files)) throw new Error(`frozen inputs lack ${k}`); return JSON.stringify(files[k]); }) : CS.loadAll(root || path.join(__dirname, ".."), cfg.lists) }) {
  const { correct } = require("./lists");
  const SL = require("./static-lists");
  // static lists (data/lists/*.json) are read from `root` (the repository by default; pass null for none), or from `files` (name → parsed file: the frozen sources of a learning snapshot), and laid over the film records
  const staticLists = root || files ? (cfg.lists || []).filter(SL.isStatic).map((l) => ({ ...l, items: SL.itemsOf(SL.load(root, l, files)) })) : [];
  if (staticLists.length) films = SL.apply({ lists: staticLists, films }).films;
  const lists = (cfg.lists || []).map((l) => {
    const st = staticLists.find((x) => x.id === l.id);
    if (st) return st;
    if (SL.isStatic(l)) return { ...l, items: [] };
    const k = listsCache && listsCache.lists && listsCache.lists[l.id];
    return { ...l, items: correct(l, ((k && k.items) || []).map(([slug, title, year]) => ({ slug, title, year }))) };
  });
  return vouched(signals({ lists, films, overall: 0, subsets }));
}

// The listPool cut (build.js): only the films the recommendation rule lets through compete for the `cap` slots, best `prelim` first
// (ties by `id`); a film the rule refuses is left out BEFORE the cap, whatever the cap (Marco, 11/10/2026). `entryOf(film)` is the film's
// rule entry ({ lb, fr, cv }: a film with no Letterboxd record yet has no average and follows the rule for "no average"); `qualifies` is
// lib/recommendation-quality.js qualifies. Returns { kept, refused, eligible } (counts of the last two).
function cutList(films, { entryOf, qualifies, prelim, cap }) {
  const pass = films.filter((f) => qualifies(entryOf(f)));
  const kept = pass.slice().sort((a, b) => prelim(b) - prelim(a) || a.id - b.id).slice(0, cap ?? 0);
  return { kept, refused: films.length - pass.length, eligible: pass.length };
}

module.exports = { cutList, ratingByImdb, publicWeight, joinTmdb, joinListFilms, vouchedFromCaches, TRUST, VOUCHES, PRIOR, FULL, LONG, BAND, DROP, validateLists, SHORT_MAX, LIST_ORDERS, agreement, signals, combine, vouched, NONE };
