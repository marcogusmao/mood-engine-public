// The rows of the v2 Board that are not a mood, a filter or a combination of moods (Marco, 13/10/2026, PR3 of the 54-row Board). Only the v2 family
// (plan.board2) reads them; the legacy Board, the static addon and the five profiles never see one (lib/plan.js: they walk plan.board).
//
//   kind                 row                      what it holds
//   top-picks            ⭐ Friend's top picks     the films ONE friend of seven rated (six until 29/10/2026) and Marco has not seen: the friend of the day is people[days since 1970 mod 7], the 4.5★+ first,
//                                                 completed with the 4★ up to `size` (100; 60 until 14/11/2026). A friend's profile "4 favourites" (cache/friends.json users[u].favourites, a list of
//                                                 slugs; the collector is PR7) come first when the cache has them, and are ignored when it does not.
//   friends-split        🆚 Friends can't agree   films at least `minRatings` people rated and whose ratings spread: population standard deviation >= `minSd` (see MIN_SD)
//   friends-watchlist    🤝 Friends want to see…  Marco's watchlist ∩ the watchlists of at least `minPeople` of the people he follows, the most wanted first
//   friends-month        📈 Friends watched…      what the people he follows logged in the last `days` (30), the way "Friends watched this week" is ordered (lib/pool.js weekRow)
//   awards               🏆 Cannes, Venice and…   winners of the festivals' top prizes, from data/*.json (Cannes: Palme d'Or, Grand Prix, Jury Prize only), one film once
//   untried-directors    🧭 Great directors…      directors with `minFilms` films at Letterboxd `minStars`+ in the candidates and none seen by Marco, `perDirector` (3) films each; the directors turn with the ISO week (Marco, 13/10/2026, night)
//   actor-week           🧑‍🎤 Actor of the week     one actor of the TMDB cast (first five) Marco rates well, chosen by ISO week
//   list                 criterion, sight-sound…  the unseen films of one or more of config.json lists, best for Marco first (the pool's rank: taste + 0.7 × quality)
//
// Each kind has defaults in DEFAULT_ROWS; a recipe in config.json board.rows ({ "id", "kind", …parameters }, lib/board.js) overrides an entry by id or adds a row (another `list`). Only the
// rows named in board.order are built, and they reach plan.board2 through plan.rows2 (lib/plan.js), never through `extra`. Every row: films with an IMDb id, never one Marco has seen (the build's isSeen), never one under the quality floor or in the private feedback's Not for me (`allowed`; exclude.films is applied to the plan afterwards and leaves its gap, except in the rows made from candidates that it has already filtered),
// at most 100 (V2_ROW_MAX), each once. A row with nothing to show is empty and the build says why; it is never filled with something else.
//
// Pure: build.js hands in the facts (see build() below), the tests hand in small fakes.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const P = require("./pool");
const { score } = require("./taste");
const CS = require("./critic-subset");
const { V2_ROW_MAX } = require("./board-shared");

const KINDS = ["top-picks", "friends-split", "friends-watchlist", "friends-month", "awards", "untried-directors", "actor-week", "list"];

// The seven friends of "Friend's top picks", in the fixed order of the day rotation (Marco, 13/10/2026: six; Marco, 29/10/2026, questionnaire: "a friend-b ENTRA no rodízio", so seven, she last: the six keep their order,
// the rotation is now `day mod 7` and every day's friend changes). Until 28/10/2026 friend-f and friend-g were people he follows, not configured friends (their rating never lifted a film over the quality floor
// and the comment here said they must not be added to config.json friends); Marco's answer (b) of 28/10/2026 made them, and friend-b, whole friends, so that comment is gone.
const TOP_FRIENDS = ["friend-f", "friend-g", "friend-a", "friend-e", "friend-d", "friend-c", "friend-b"];

/**
 * The spread at which friends "can't agree": a POPULATION standard deviation of 1.0 star over at least three ratings. Letterboxd ratings come in half stars, so for three
 * raters 4.5 / 3 / 2 (σ 1.03) and 5 / 4 / 2.5 (σ 1.03) are in, while 5 / 3 / 3 (σ 0.94) and 4.5 / 3 / 2.5 (σ 0.85) are out. Measured on the caches of 13/10/2026 (a probe over the
 * 534 films that 3+ of the 27 people of the crowd (the configured friends and the people read from /following/) rated and whose IMDb id is not on Marco's public /films/ page): σ >= 0.5 keeps 309, 0.75 keeps 142, 1.0 keeps 70, 1.25 keeps 19, 1.5 keeps 4; the sample
 * deviation (n-1) would keep 119 at 1.0 by inflating the groups of three. The build itself (every seen check, the floor) keeps 54 at 1.0: 1.0 is the first step that fills the row (50),
 * and it still means somebody loved it and somebody did not.
 */
const MIN_SD = 1.0;

const CANNES_PRIZES = ["Palme d'Or", "Palme d'Or especial", "Palme retroativa 1939", "Grand Prix du Festival", "Grand Prix", "Prêmio do Júri"];
const DEFAULT_ROWS = [
  { id: "top-picks", kind: "top-picks", people: TOP_FRIENDS, minStars: 4.5, fillStars: 4, size: 100 }, // 60 until 14/11/2026 (Marco: "Up to 100 in every row")
  { id: "friends-split", kind: "friends-split", minRatings: 3, minSd: MIN_SD },
  { id: "friends-watchlist", kind: "friends-watchlist", minPeople: 1, onlyConfiguredFriends: false },
  { id: "friends-month", kind: "friends-month", days: 30 },
  { id: "awards", kind: "awards", sources: [
    { file: "data/cannes-critic-prizes.json", label: "Cannes", prizes: CANNES_PRIZES }, // premios_criticos also lists Direção and Roteiro: they are not top prizes, so they are not here
    { file: "data/venice-golden-lion.json", label: "Venice" },
    { file: "data/berlin-golden-bear.json", label: "Berlin" }, // its premios_criticos leaves the five genre bears of 1951 out
  ] },
  { id: "untried-directors", kind: "untried-directors", minFilms: 3, minStars: 3.8, perDirector: 3, rotate: "week" },
  { id: "actor-week", kind: "actor-week", minRated: 3, minAvg: 4, minEligible: 5 },
  { id: "criterion", kind: "list", listIds: ["snFyM", "tp03m"] },
  { id: "sight-sound", kind: "list", listIds: ["jlyNq", "jrR92"] },
  { id: "lb250", kind: "list", listIds: ["nVqt6"] },
];
const PARAMS = {
  "top-picks": ["people", "minStars", "fillStars", "size"], "friends-split": ["minRatings", "minSd", "size"], "friends-watchlist": ["minPeople", "onlyConfiguredFriends", "size"], "friends-month": ["days", "size"],
  awards: ["sources", "size"], "untried-directors": ["minFilms", "minStars", "perDirector", "rotate", "size"], "actor-week": ["minRated", "minAvg", "minEligible", "size"], list: ["listIds", "size"],
};
const NUMBERS = ["minStars", "fillStars", "minRatings", "minSd", "minPeople", "days", "minFilms", "perDirector", "minRated", "minAvg", "minEligible", "size"];

const isObject = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const stars = (r) => `${Number.isInteger(r) ? r : r.toFixed(1)}★`; // "5★", "4.5★": the way "Friends loved" shows a rating
const byTitle = (a, b) => String(a.title || a.rec?.title || "").localeCompare(String(b.title || b.rec?.title || ""));

// ── the config: defaults, overrides, problems ────────────────────────────────

/** The keys a recipe of each kind may have in config.json board.rows (lib/board.js ROW_KINDS). */
const ROW_KEYS = Object.fromEntries(Object.entries(PARAMS).map(([kind, keys]) => [kind, ["id", "kind", ...keys]]));

/**
 * The specs of the special rows of a config: DEFAULT_ROWS, each replaced (key by key) by the recipe of the same id and kind in config.json board.rows, plus the recipes of a new id.
 * → Map id → spec. Recipes of the other kinds (filter, combine) are lib/board-rows.js's.
 */
function specs(cfg) {
  const out = new Map(DEFAULT_ROWS.map((r) => [r.id, r]));
  const defs = cfg && cfg.board && Array.isArray(cfg.board.rows) ? cfg.board.rows : [];
  for (const e of defs) {
    if (!isObject(e) || !KINDS.includes(e.kind)) continue;
    const base = out.get(e.id);
    out.set(e.id, base && base.kind === e.kind ? { ...base, ...e } : e);
  }
  return out;
}

/**
 * The problems (sentences) in the VALUES of one spec (defaults merged with the recipe); the keys and the id are lib/board.js's (ROW_KEYS, rowProblems). listIds: the ids of the lists
 * of config.json.
 */
function recipeProblems(s, listIds = []) {
  const out = [], have = new Set(listIds);
  for (const k of NUMBERS) if (s[k] !== undefined && !(typeof s[k] === "number" && Number.isFinite(s[k]) && s[k] > 0)) out.push(`${k} must be a positive number`);
  if (s.size !== undefined && !(Number.isInteger(s.size) && s.size <= V2_ROW_MAX)) out.push(`size must be a whole number up to ${V2_ROW_MAX}`);
  if (s.kind === "top-picks" && (!Array.isArray(s.people) || s.people.some((p) => typeof p !== "string" || !p) || new Set(s.people).size !== s.people.length)) out.push("people must be a list of distinct user names");
  if (s.kind === "top-picks" && s.fillStars >= s.minStars) out.push(`fillStars (${s.fillStars}) must be below minStars (${s.minStars})`);
  if (s.kind === "friends-watchlist" && s.onlyConfiguredFriends !== undefined && typeof s.onlyConfiguredFriends !== "boolean") out.push("onlyConfiguredFriends must be true or false");
  if (s.kind === "untried-directors" && s.rotate !== "week" && s.rotate !== "none") out.push('rotate must be "week" or "none"');
  if (s.kind === "list") {
    if (!Array.isArray(s.listIds) || !s.listIds.length || s.listIds.some((l) => typeof l !== "string")) out.push("listIds must be a non-empty list of list ids");
    else for (const l of s.listIds) if (!have.has(l)) out.push(`list "${l}" is not a list of config.json`);
  }
  if (s.kind === "awards") {
    if (!Array.isArray(s.sources) || !s.sources.length) out.push("sources must be a non-empty list of { file, label, prizes? }");
    else for (const src of s.sources) {
      if (!isObject(src) || typeof src.file !== "string" || !/^data\/[A-Za-z0-9._-]+\.json$/.test(src.file) || typeof src.label !== "string" || !src.label) out.push("a source needs file (data/<name>.json) and label");
      else if (src.prizes !== undefined && (!Array.isArray(src.prizes) || !src.prizes.length || src.prizes.some((p) => typeof p !== "string"))) out.push(`${src.file}: prizes must be a non-empty list of prize names`);
    }
  }
  return out;
}

// ── dates ────────────────────────────────────────────────────────────────────

/** Whole days since 1970-01-01 of a YYYY-MM-DD date (UTC): the t of "t mod 7" (the number of friends of top-picks). */
const dayNumber = (today) => Math.floor(Date.parse(`${today}T00:00:00Z`) / 864e5);

/** The ISO 8601 week of a YYYY-MM-DD date: { year, week } (the week of the Thursday: 2026-01-01 is week 1 of 2026, 2027-01-01 is week 53 of 2026). */
function isoWeek(today) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7)); // the Thursday of this week
  const year = d.getUTCFullYear(), jan4 = new Date(Date.UTC(year, 0, 4));
  return { year, week: 1 + Math.round(((d - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7) };
}
const weekKey = (today) => { const w = isoWeek(today); return `${w.year}-W${String(w.week).padStart(2, "0")}`; };

/**
 * Rendezvous choice: each id gets a number from sha256("<ISO week>|<id>"), the smallest is the pick. The pick is the same all week, whatever the night's data, and changes
 * only when the picked one leaves the list or a new id draws a smaller number (1 in N), unlike "index = week mod N", which moves whenever N does.
 */
const draw = (week, id) => crypto.createHash("sha256").update(`${week}|${id}`).digest("hex");
const byDraw = (week, key) => (a, b) => (draw(week, key(a)) < draw(week, key(b)) ? -1 : 1);

// ── awards data ──────────────────────────────────────────────────────────────

const PRIZE_TEXT = { "Palme d'Or especial": "Special Palme d'Or", "Palme retroativa 1939": "Palme d'Or (retroactive)", "Grand Prix du Festival": "Palme d'Or", "Prêmio do Júri": "Jury Prize" }; // "Grand Prix du Festival" was the Palme's name in 1946-54 and 1964-74 (the file says so)

/**
 * The prize files of an `awards` spec, read from `root`. → { sources: [{ label, file, missing, films: [{ slug, imdb, title, year, prize, years }] }], warnings }.
 * A file that is not there is a warning and the row is built without it; a file that is there and not sound stops the build (the same rule as lib/critic-subset.js).
 * A film counts by the prizes named in the file's premios_criticos and, when the source lists `prizes`, only by those (Cannes: Direção and Roteiro are in premios_criticos
 * and are not top prizes). It carries its FIRST counting prize in the order of `prizes` (the file's order without it): "Cannes Palme d'Or 1953" (the source's label, the prize, the year), never two prizes of one festival.
 */
function loadAwards(root, spec, readFile = (p) => fs.readFileSync(p, "utf8")) {
  const warnings = [], sources = [];
  for (const src of spec.sources) {
    let text;
    try { text = readFile(path.join(root, src.file)); }
    catch (e) {
      if (e.code !== "ENOENT") throw new Error(`awards: ${src.file}: ${e.message}`);
      warnings.push(`awards: ${src.file} is not there: the row is built without ${src.label}`);
      sources.push({ label: src.label, file: src.file, missing: true, films: [] });
      continue;
    }
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error(`awards: ${src.file}: ${e.message}`); }
    const bad = CS.validate(data);
    if (bad.length) throw new Error(`awards: ${src.file}: ${bad.slice(0, 5).join("; ")}${bad.length > 5 ? ` (+${bad.length - 5} more)` : ""}`);
    const critic = new Set(data.premios_criticos), names = new Set(data.filmes.flatMap((f) => Object.keys(f.prizes).map(CS.prizeName)));
    for (const p of src.prizes || []) if (!names.has(p)) warnings.push(`awards: ${src.file}: the prize "${p}" is on the list and no film of the file holds it`);
    const films = [];
    for (const f of data.filmes) {
      const counting = Object.entries(f.prizes).filter(([k]) => critic.has(k)).map(([k, years]) => ({ name: CS.prizeName(k), years: [...years].sort((a, b) => a - b) })).filter((p) => !src.prizes || src.prizes.includes(p.name));
      if (src.prizes) counting.sort((a, b) => src.prizes.indexOf(a.name) - src.prizes.indexOf(b.name));
      if (!counting.length) continue;
      films.push({ slug: f.slug, imdb: f.imdb || null, title: f.title || f.slug, year: f.year || null, prize: `${src.label} ${PRIZE_TEXT[counting[0].name] || counting[0].name} ${counting[0].years.join("/")}` }); // "Cannes Palme d'Or 1953": the festival leads the reason of the row (Marco, 21/10/2026 ~15:00 UTC, D1: "festival e ano")
    }
    sources.push({ label: src.label, file: src.file, missing: false, films });
  }
  return { sources, warnings };
}

// ── the builders ─────────────────────────────────────────────────────────────

/** A TMDB candidate's row item (the shape lib/rows.js item() makes). */
const filmItem = (f, why) => ({
  id: f.imdb, tmdb: f.id, title: f.title, originalTitle: f.originalTitle, year: f.year, runtime: f.runtime, genres: f.genres || [], directors: (f.directors || []).map((d) => d.name),
  poster: f.poster, va: f.va, vc: f.vc, why: why.filter(Boolean), overview: f.overview || "", ...P.cardFacts(f), // the countries and the cast of the first lines of the description (lib/describe.js)
});
const rankOf = (c) => c.tasteZ + 0.7 * c.qualityZ; // "Your watchlist, best first", lib/rows.js
const BIG = new Set(["awards", "untried-directors", "actor-week", "list"]); // sizes.discover (100) like the moods; the friends' rows are sizes.row (100 since 14/11/2026, it was 50), top-picks says its own (100; it was 60)
const sizeOf = (spec, ctx) => Math.min(V2_ROW_MAX, spec.size ?? (BIG.has(spec.kind) ? ctx.sizes.discover : ctx.sizes.row));
const people = (ctx) => ctx.view.crowd || ctx.view.users || [];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * ctx (what build.js hands in):
 *   today                 YYYY-MM-DD, the build's date
 *   sizes                 { row, discover }
 *   view                  lib/friends.js viewFriends(): { users, crowd, films: slug → Letterboxd record }
 *   recs                  lib/pool.js rankPool(): the unseen films of Marco's watchlist, the lists and the friends' watchlists, with .tags and .rank
 *   isSeen(rec), detail(rec)   the build's "has Marco seen it" and the TMDB record from the cache
 *   allowed(tt)           the quality floor and the private feedback (Not for me …): false drops the film BEFORE the row is cut, so a row refills up to its ceiling. NOT exclude.films: the build applies it to the plan afterwards
 *                         and the gap stays (the rule of 10/10), except in untried-directors and actor-week, whose candidates exclude.films has already filtered
 *   recommended(tt)       optional: `allowed` plus the music rule (lib/pool.js musicGate; Marco, 22/10/2026 ~06:40 UTC: a music film with no evidence from his Letterboxd is not recommended). The rows that RECOMMEND
 *                         ask it (top-picks, friends-split, untried-directors, actor-week, friends-month: the diary of the people he follows is read as a recommendation, as Friends watched this week is); the rows
 *                         that show what a source has ask `allowed` alone: the prize row, the single-list rows and Friends want to see this too (his own watchlist, which is evidence). Absent: `allowed` for all (the older tests).
 *   cands                 the unseen candidates { film, tasteZ, qualityZ } (the moods' pool)
 *   rated                 [{ film, rating }] Marco's rated films with their TMDB record
 *   seenDirectors         Set of TMDB director ids of every film Marco has watched
 *   lb(tt)                the film's Letterboxd average, or null
 *   model                 lib/taste.js learn()
 *   userOf(user)          a person of cache.users as lib/friends.js userView() reads them, or null (view.crowd lacks the people the partial /following/ list lacks)
 *   favourites(user)      the slugs of the "4 favourites" of a friend's profile, or null (PR7 collects them)
 *   watched(days)         lib/lists.js watchedThisWeek over the people he follows
 *   awards                { [row id]: loadAwards() result }
 *   tmdbOfImdb(tt)        TMDB id the cache found for an IMDb id, or null
 * → { rows: { id → items }, notes: { id → text for the log }, warnings }
 */
function build(ctx, rows) {
  const out = { rows: {}, notes: {}, warnings: [] };
  const recMemo = new Map();
  // What a row SHOWS (title, synopsis, genres, runtime) comes only from a TMDB record that carries the film's own IMDb id (lib/pool.js ownDetail, 20/10/2026: tt0204394 and
  // tt8101850 had the synopsis of another film in "Friends watched this month"). The taste ranking keeps the raw `ctx.detail`, as the friends' and week rows of build.js do (the pool no longer does: BACKLOG 21/10/2026).
  const shown = P.ownDetail((id) => ctx.detail({ tmdbId: id }), ctx.tmdbOfImdb || null); // tmdbOfImdb: the record /find found for a film whose Letterboxd number is another film's (22/10/2026)
  /** A friend's film as a pool record, or null when it has no IMDb id, is gone, or Marco has seen it. */
  const recOf = (slug) => {
    if (recMemo.has(slug)) return recMemo.get(slug);
    let rec = null;
    const r = own(ctx.view.films, slug) ? ctx.view.films[slug] : null;
    if (r && !r.gone && r.imdbId && !ctx.isSeen({ slug, ...r })) {
      rec = { id: r.imdbId, imdbId: r.imdbId, slug, tmdbId: r.tmdbId || null, canon: r.canon, title: r.title, year: r.year, lb: r.r ?? null, lbCount: r.rn ?? null, lbRuntime: r.rt ?? null, lbCountries: r.c || [] };
      rec.detail = shown(rec);
    }
    recMemo.set(slug, rec);
    return rec;
  };
  /** A TMDB candidate seen by Marco? The candidates are unseen already; the rows do not rely on it. */
  const filmSeen = (f) => ctx.isSeen({ tmdbId: f.id, imdbId: f.imdb, title: f.title, year: f.year });
  const ttOf = (slug) => (own(ctx.view.films, slug) && ctx.view.films[slug].imdbId) || null;
  const ctxx = { ...ctx, recOf, ttOf, filmSeen, shown, recommended: ctx.recommended || ctx.allowed }; // the rows that recommend ask `recommended` (floor + feedback + music rule), the ones that show a source ask `allowed`
  // Marco, 14/11/2026 ("Keep shorts only in the Short row"): the rows that recommend (top-picks, friends-split, untried-directors, actor-week, friends-month) take no short, a known runtime under
  // ctx.minFeatureMinutes (build.js: config.json shortRow.minMinutes; absent: 40); the prize row, the list rows and Friends want to see this too keep theirs
  ctxx.minMinutes = ctx.minFeatureMinutes ?? P.MIN_FEATURE_MINUTES;
  ctxx.short = (rec) => P.isShort(P.runtimeOf(rec), ctxx.minMinutes);
  for (const spec of rows) {
    const make = BUILDERS[spec.kind];
    const r = make(spec, ctxx);
    const seen = new Set();
    out.rows[spec.id] = r.items.filter((it) => !seen.has(it.id) && seen.add(it.id)).slice(0, sizeOf(spec, ctx));
    out.notes[spec.id] = r.note;
    out.warnings.push(...(r.warnings || []));
  }
  return out;
}

const BUILDERS = {
  "top-picks": topPicks, "friends-split": friendsSplit, "friends-watchlist": friendsWatchlist, "friends-month": friendsMonth, awards, "untried-directors": untriedDirectors, "actor-week": actorWeek, list: listRow,
};

/** ⭐ The friend of the day's picks. */
function topPicks(spec, ctx) {
  if (!spec.people.length) return { items: [], note: "no people configured; row left empty" };
  const user = spec.people[dayNumber(ctx.today) % spec.people.length];
  // the people he follows first, then every person the cache holds (cache.users has friend-f and friend-g, whom the partial /following/ list lacks)
  const u = people(ctx).find((p) => p.user.toLowerCase() === user.toLowerCase()) || (ctx.userOf ? ctx.userOf(user) : null);
  if (!u) return { items: [], note: `friend of the day ${user}: not in the cache`, warnings: [`top-picks: the friend of the day, ${user}, has no entry in cache/friends.json users: the row is empty`] };
  const who = u.name || user;
  const size = sizeOf(spec, ctx), fav = (ctx.favourites && ctx.favourites(user)) || [];
  const picks = [], taken = new Set();
  const add = (rec, text) => {
    if (!rec || taken.has(rec.id) || !ctx.recommended(rec.id)) return;
    if (ctx.short(rec)) return; // no short (14/11/2026)
    taken.add(rec.id);
    picks.push(P.toItem(rec, [text]));
  };
  const rating = (slug) => (u.films.has(slug) ? u.films.get(slug).rating : null);
  for (const slug of fav) if (typeof slug === "string") add(ctx.recOf(slug), rating(slug) != null ? `${who} ${stars(rating(slug))} · profile favourite` : `${who} · profile favourite`);
  const nFav = picks.length;
  // newest log first inside a rating, then the order of the friend's /films/ page (newest first), then the title: the order of "⭐ <friend>'s top picks" in Discover
  const tier = (lo, hi) => [...u.films.values()].filter((f) => f.rating != null && f.rating >= lo && f.rating < hi)
    .sort((a, b) => b.rating - a.rating || (b.watched ? 1 : 0) - (a.watched ? 1 : 0) || (b.watched || "").localeCompare(a.watched || "") || a.order - b.order || String(a.title).localeCompare(String(b.title)));
  const top = tier(spec.minStars, Infinity), fill = tier(spec.fillStars, spec.minStars);
  for (const f of top) { if (picks.length >= size) break; add(ctx.recOf(f.slug), `${who} ${stars(f.rating)}`); }
  const nTop = picks.length - nFav;
  for (const f of fill) { if (picks.length >= size) break; add(ctx.recOf(f.slug), `${who} ${stars(f.rating)}`); }
  return { items: picks, note: `friend of the day ${user} (day ${dayNumber(ctx.today)} mod ${spec.people.length} = ${dayNumber(ctx.today) % spec.people.length}): ${nFav} favourites, ${nTop} at ${spec.minStars}★+, ${picks.length - nFav - nTop} at ${spec.fillStars}★ to complete (rated ≥ ${spec.minStars}: ${top.length}, ${spec.fillStars}★: ${fill.length}, before the unseen/floor cuts)` };
}

/** "ann", "ann and ben", "ann, ben and cy", "ann, ben, cy and 3 more": at most three names (the description joins its reasons with " · ", so the names use commas). */
const nameList = (names) => (names.length <= 3 ? names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`);

/** Population standard deviation. */
const sd = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };

/** 🆚 Films the people he follows rate far apart. */
function friendsSplit(spec, ctx) {
  const byTt = new Map(); // tt → { slug, votes: Map(user → rating) }: two Letterboxd pages of one film are one film, each person once
  for (const u of people(ctx))
    for (const f of u.films.values()) {
      if (f.rating == null) continue;
      const tt = ctx.ttOf(f.slug);
      if (!tt) continue;
      const e = byTt.get(tt) || byTt.set(tt, { slug: f.slug, votes: new Map() }).get(tt);
      e.votes.set(u.user, { name: u.name || u.user, rating: f.rating });
    }
  const found = [];
  let enough = 0;
  for (const [tt, e] of byTt) {
    if (e.votes.size < spec.minRatings) continue;
    enough++;
    const spread = sd([...e.votes.values()].map((v) => v.rating));
    if (spread < spec.minSd) continue;
    const rec = ctx.recOf(e.slug);
    if (!rec || !ctx.recommended(tt)) continue;
    if (ctx.short(rec)) continue; // no short (14/11/2026)
    found.push({ rec, e, spread });
  }
  found.sort((a, b) => b.spread - a.spread || b.e.votes.size - a.e.votes.size || byTitle(a, b));
  const items = found.map(({ rec, e }) => {
    const v = [...e.votes.values()];
    const hi = v.slice().sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name))[0], lo = v.slice().sort((a, b) => a.rating - b.rating || a.name.localeCompare(b.name))[0];
    return P.toItem(rec, [`${hi.name} ${stars(hi.rating)} · ${lo.name} ${stars(lo.rating)}`]);
  });
  return { items, note: `${enough} films with ${spec.minRatings}+ ratings, ${found.length} unseen with σ ≥ ${spec.minSd}★` };
}

/** 🤝 On Marco's watchlist and on the watchlists of the people he follows. */
function friendsWatchlist(spec, ctx) {
  const want = new Map(); // tt → [user]
  // Marco, 14/10/2026: everybody he follows may be named (a Letterboxd watchlist is public); `onlyConfiguredFriends: true` narrows it to the friends of config.json (view.users) with one line of config
  const who = spec.onlyConfiguredFriends ? ctx.view.users || [] : people(ctx);
  for (const u of who) {
    const done = new Set([...u.films.keys()].map((s) => ctx.ttOf(s)).filter(Boolean)); // who has seen it does not "want" it
    for (const w of u.watchlist.values()) {
      const tt = ctx.ttOf(w.slug);
      if (!tt || done.has(tt) || u.films.has(w.slug)) continue;
      const list = want.get(tt) || want.set(tt, []).get(tt);
      if (!list.includes(u.name || u.user)) list.push(u.name || u.user);
    }
  }
  const mine = ctx.recs.filter((r) => r.tags && r.tags.watchlist && !ctx.isSeen(r)); // the pool is unseen already; the row does not rely on it
  const found = mine.filter((r) => (want.get(r.id) || []).length >= spec.minPeople && ctx.allowed(r.id));
  found.sort((a, b) => want.get(b.id).length - want.get(a.id).length || b.rank - a.rank || byTitle(a, b));
  const items = found.map((r) => {
    return P.toItem(r, [`on the watchlist of ${nameList(want.get(r.id).slice().sort((a, b) => a.localeCompare(b)))}`, P.taste(r)]);
  });
  return { items, note: `${mine.length} films on your watchlist, ${found.length} also wanted by ${spec.minPeople}+ of ${who.length} people` };
}

/** 📈 What the people he follows logged in the last `days`. */
function friendsMonth(spec, ctx) {
  const week = ctx.watched(spec.days);
  const tasteScore = (r) => (ctx.detail(r) ? score(ctx.detail(r), ctx.model).score : null);
  const row = P.weekRow({ week, view: ctx.view, isSeen: ctx.isSeen, tasteScore, detail: ctx.shown, size: Infinity, eligible: ctx.recommended, period: `in the last ${spec.days} days`, minRuntime: ctx.minMinutes });
  return { items: row.items, note: `${row.stats.films} films logged in ${spec.days} days → ${row.items.length} unseen over the floor and the music rule (${row.stats.refused || 0} refused by either, ${row.stats.seen} seen by you, ${row.stats.pending} not looked up yet, ${row.stats.noImdb} without IMDb)` };
}

/** 🏆 Winners of the top prizes. */
function awards(spec, ctx) {
  const data = ctx.awards[spec.id] || { sources: [], warnings: [] };
  const slugTt = new Map(); // a slug one file names with an IMDb id is that film in the other files too
  for (const s of data.sources) for (const f of s.films) if (f.imdb) slugTt.set(f.slug, f.imdb);
  const warnings = [...data.warnings], groups = new Map();
  let unresolved = 0;
  for (const s of data.sources)
    for (const f of s.films) {
      const r = own(ctx.view.films, f.slug) ? ctx.view.films[f.slug] : null;
      if (f.imdb && r && r.imdbId && r.imdbId !== f.imdb) { warnings.push(`awards: ${f.slug} is ${f.imdb} in ${s.file} and ${r.imdbId} on Letterboxd: left out`); continue; }
      const tt = f.imdb || slugTt.get(f.slug) || (r && !r.gone && r.imdbId) || null;
      if (!tt) { unresolved++; continue; }
      const g = groups.get(tt) || groups.set(tt, { tt, entries: [], slug: f.slug, r }).get(tt);
      g.entries.push(f);
      if (!g.r && r) g.r = r;
    }
  const pool = new Map();
  for (const g of groups.values()) {
    const e = g.entries[0], r = g.r;
    const tmdbId = (r && r.tmdbId) || ctx.tmdbOfImdb(g.tt) || null;
    const rec = { id: g.tt, imdbId: g.tt, slug: g.slug, tmdbId, canon: r && r.canon, title: (r && r.title) || e.title, year: (r && r.year) || e.year, lb: r ? r.r ?? null : null, lbCount: r ? r.rn ?? null : null, lbRuntime: r ? r.rt ?? null : null, lbCountries: (r && r.c) || [] };
    if (ctx.isSeen({ ...(r || {}), ...rec })) continue;
    const d = tmdbId ? ctx.detail(rec) : null;
    rec.detail = d && d.imdb === g.tt ? d : null; // a TMDB record that names another IMDb id is not this film
    if (!ctx.allowed(g.tt)) continue;
    rec.prizes = g.entries.map((x) => x.prize);
    pool.set(g.tt, rec);
  }
  const recs = P.rankPool(pool, ctx.model);
  recs.sort((a, b) => b.rank - a.rank || byTitle(a, b));
  const items = recs.map((r) => P.toItem(r, [r.prizes.slice(0, 2).join(", "), P.taste(r)]));
  const total = groups.size;
  return { items, note: `${data.sources.map((s) => `${s.label} ${s.missing ? "missing" : s.films.length}`).join(", ")} → ${total} films${unresolved ? ` (${unresolved} without an IMDb id)` : ""} → ${items.length} unseen over the floor`, warnings };
}

/** 🧭 Directors with several well-rated films, none seen. */
function untriedDirectors(spec, ctx) {
  const by = new Map(); // director id → { name, films: [{ c, rank }] }
  for (const c of ctx.cands) {
    const lb = ctx.lb(c.film.imdb);
    if (lb == null || lb < spec.minStars || !ctx.recommended(c.film.imdb) || ctx.filmSeen(c.film) || P.isShort(c.film.runtime, ctx.minMinutes)) continue;
    for (const d of c.film.directors || []) {
      const e = by.get(d.id) || by.set(d.id, { id: d.id, name: d.name, films: [] }).get(d.id);
      e.films.push({ c, rank: rankOf(c) });
    }
  }
  const qualified = [...by.values()].filter((e) => !ctx.seenDirectors.has(e.id) && e.films.length >= spec.minFilms);
  for (const e of qualified) e.films.sort((a, b) => b.rank - a.rank || byTitle(a.c.film, b.c.film));
  const week = weekKey(ctx.today), size = sizeOf(spec, ctx);
  // who is on the row this week: the directors in the order of the week's draw, or (rotate "none") by their best film; `perDirector` (3) films each, the best of each director in the first pass
  qualified.sort(spec.rotate === "week" ? byDraw(week, (e) => String(e.id)) : (a, b) => b.films[0].rank - a.films[0].rank || String(a.name).localeCompare(String(b.name)));
  const chosen = [], taken = new Set();
  let total = 0;
  for (const e of qualified) {
    const mine = e.films.filter((f) => !taken.has(f.c.film.imdb)).slice(0, Math.min(spec.perDirector, size - total));
    if (!mine.length) continue;
    mine.forEach((f) => taken.add(f.c.film.imdb));
    chosen.push({ e, films: mine });
    if ((total += mine.length) >= size) break;
  }
  const first = chosen.map((x) => ({ ...x.films[0], e: x.e })).sort((a, b) => b.rank - a.rank || byTitle(a.c.film, b.c.film));
  const rest = chosen.flatMap((x) => x.films.slice(1).map((f) => ({ ...f, e: x.e }))).sort((a, b) => b.rank - a.rank || byTitle(a.c.film, b.c.film));
  const items = [...first, ...rest].map(({ c, e }) => filmItem(c.film, [`${e.name} · nothing seen yet`]));
  return { items, note: `${qualified.length} directors with ${spec.minFilms}+ films at ${spec.minStars}★+ and none seen; week ${week}${spec.rotate === "week" ? "" : " (no rotation)"}: ${chosen.length} directors, ${items.length} films` };
}

/** 🧑‍🎤 The actor of the week. */
function actorWeek(spec, ctx) {
  const stat = new Map(); // actor id → { name, n, sum }, from the first five of the cast of every film Marco rated
  for (const { film, rating } of ctx.rated)
    for (const a of new Map((film.cast || []).slice(0, 5).map((x) => [x.id, x])).values()) { // an actor once per film
      const s = stat.get(a.id) || stat.set(a.id, { id: a.id, name: a.name, n: 0, sum: 0 }).get(a.id);
      s.n++; s.sum += rating;
    }
  const liked = new Map([...stat].filter(([, s]) => s.n >= spec.minRated && s.sum / s.n >= spec.minAvg));
  const films = new Map(); // actor id → [candidate]
  for (const c of ctx.cands) {
    if (P.isShort(c.film.runtime, ctx.minMinutes)) continue; // no short (14/11/2026)
    if (!ctx.recommended(c.film.imdb) || ctx.filmSeen(c.film)) continue;
    for (const id of new Set((c.film.cast || []).slice(0, 5).map((a) => a.id))) if (liked.has(id)) (films.get(id) || films.set(id, []).get(id)).push(c);
  }
  const qualified = [...liked.values()].filter((s) => (films.get(s.id) || []).length >= spec.minEligible);
  const week = weekKey(ctx.today);
  qualified.sort(byDraw(week, (s) => String(s.id)));
  const pick = qualified[0];
  if (!pick) return { items: [], note: `no actor with ${spec.minRated}+ ratings averaging ${spec.minAvg}★+ and ${spec.minEligible}+ eligible unseen films (${liked.size} liked)`, warnings: ["actor-week: no actor qualifies tonight: the row is empty"] };
  const mine = films.get(pick.id).slice().sort((a, b) => rankOf(b) - rankOf(a) || byTitle(a.film, b.film));
  const why = `${pick.name} · you rate them ${(pick.sum / pick.n).toFixed(1)}★ over ${pick.n} films`;
  return { items: mine.map((c) => filmItem(c.film, [why])), note: `${week}: ${pick.name} (${(pick.sum / pick.n).toFixed(2)}★ over ${pick.n} films, ${mine.length} eligible unseen); ${qualified.length} actors qualify, ${liked.size} liked` };
}

/** The unseen films of one or more lists, best for Marco first. */
function listRow(spec, ctx) {
  const mine = ctx.recs.filter((r) => r.tags && spec.listIds.some((l) => r.tags.lists.has(l)) && !ctx.isSeen(r) && ctx.allowed(r.id)); // the pool is unseen already; the row does not rely on it
  mine.sort((a, b) => b.rank - a.rank || byTitle(a, b));
  const items = mine.map((r) => {
    const l = spec.listIds.map((id) => [id, r.tags.lists.get(id)]).filter(([, v]) => v).sort((a, b) => a[1].pos - b[1].pos)[0][1];
    return P.toItem(r, [`“${l.name}” · #${l.pos}`, P.taste(r)]); // not "#12 in “…”": lib/index-export.js text() drops that form from a film's text, which it leaves to the Worker for the list being shown
  });
  return { items, note: `${spec.listIds.join(" + ")}: ${items.length} unseen over the floor` };
}

/**
 * How many days of diary of the people he follows the build must keep so that a "friends-month" row can see its window: the longest `days` of a friends-month row on the Board
 * plus a week (lib/lists.js readFollowing keeps max(14, weekRow.days + 7, this)). 0 when the config has no board or the Board has no such row. A Letterboxd diary feed holds the
 * last 50 entries of a person, so a very busy person may have fewer than `days` days in it whatever is kept.
 */
function retentionDays(cfg) {
  if (!cfg.board || !Array.isArray(cfg.board.order)) return 0;
  const all = specs(cfg);
  return Math.max(0, ...cfg.board.order.map((id) => all.get(id)).filter((s) => s && s.kind === "friends-month" && Number.isFinite(s.days)).map((s) => s.days + 7));
}

/** The specs of the special rows `order` names, in the order of the Board. */
const rowsFor = (cfg, order) => { const all = specs(cfg); return order.filter((id) => all.has(id)).map((id) => all.get(id)); };

module.exports = { retentionDays, KINDS, ROW_KEYS, DEFAULT_ROWS, TOP_FRIENDS, MIN_SD, CANNES_PRIZES, specs, recipeProblems, rowsFor, build, loadAwards, dayNumber, isoWeek, weekKey, draw, sd };
