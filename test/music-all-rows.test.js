// node --test test/music-all-rows.test.js
// The music rule in EVERY row that recommends (Marco, 22/10/2026 ~06:40 UTC, batch 2: "extend rule D to ALL the rows of the Board and to the cuts by country and decade").
// The first version (~03:50 UTC) was in New for you alone. Measured on the main of that morning: K-pop, Taylor Swift and One Direction concert films were still in docs 9, 2020s 6,
// untried-directors 3, asia 3, 2010s 2, british 2, hidden 2 and reinvent 1, and the catalog spec of the same day found 10 K-pop shows among the first 20 of South Korea.
//
// The rule, in one place: lib/pool.js musicGate. build.js builds it once and hands every builder `recommendable` (the quality rule AND the gate); the builders refill the places it opens.
//   - asked: Tonight, the mood rows, Because you loved, Directors you trust, the v2 filter, combined and mood rows, Friends loved, From your lists, Short and good, New for you,
//     Friend's top picks, Friends can't agree, Untried directors, Actor of the week, Friends watched this week and this month (Marco said "all the rows"; the floor already applies there), the web picker, and the Discover cuts by decade, runtime, country and rating (and, when they exist, the catalogs by country and decade: they call musicAllowed)
//     The Worker reads the same verdict from the index (bit 8 of the flags, `musicOut`): Moods and Explore, and the profiles' Tonight, Under 100 min and themes, hold the film back; worker/test/music-rule.test.js
//   - NOT asked (they show what a source holds): your watchlist, Friends want to see this too, the prize row, the single-list rows, Loved by your
//     directors, Lists, Lists (unseen), Friends. A film he has SEEN is never refused (Old friends).
// The world below is small and invented (no cache): the real numbers are in README.md and PRODUCT.md, and test/music-all-rows-build.test.js builds the real caches with the rule on and off.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const P = require("../lib/pool");
const SR = require("../lib/special-rows");
const BR = require("../lib/board-rows");
const PEOPLE = require("../lib/people");
const { buildRows, buildFriendRows } = require("../lib/rows");
const { compile } = require("../lib/moods");
const { learn } = require("../lib/taste");

const ROOT = path.join(__dirname, "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));

// ── the configuration ────────────────────────────────────────────────────────

test("musicOptions: music.needsEvidence is read when it is exactly true; the first key (newReleases.musicNeedsEvidence) still counts while the new one is absent; a new key that is there decides", () => {
  const on = (cfg) => P.musicOptions({ lists: [], ...cfg }).needsEvidence;
  assert.equal(on({ music: { needsEvidence: true } }), true);
  assert.equal(on({ music: { needsEvidence: false } }), false);
  for (const v of ["true", 1, null, {}, [], "yes"]) assert.equal(on({ music: { needsEvidence: v } }), false, JSON.stringify(v) + ": not exactly true");
  assert.equal(on({}), false, "no key at all: the rule is off (a person's build)");
  assert.equal(on({ music: {} }), false);
  // the first version of the key, written before the rename
  assert.equal(on({ newReleases: { musicNeedsEvidence: true } }), true, "the old key alone still turns the rule on");
  assert.equal(on({ newReleases: { musicNeedsEvidence: "true" } }), false, "and it is still read as exactly true");
  assert.equal(on({ music: { needsEvidence: false }, newReleases: { musicNeedsEvidence: true } }), false, "the new key that is there wins: false turns the rule off");
  assert.equal(on({ music: { needsEvidence: true }, newReleases: { musicNeedsEvidence: false } }), true);
  assert.equal(on({ music: {}, newReleases: { musicNeedsEvidence: true } }), true, "an empty `music` block does not hide the old key");
  // the lists that vouch: trust critic or director, a fan list grants nothing
  const o = P.musicOptions({ music: { needsEvidence: true }, lists: [{ id: "C", trust: "critic" }, { id: "D", trust: "director" }, { id: "F", trust: "fan" }] });
  assert.deepEqual([...o.vouchLists].sort(), ["C", "D"]);
  assert.equal(P.musicOptions(undefined).needsEvidence, false);
});

test("config.json: Marco's config has music.needsEvidence true and no first-version key; a person's derived config (Will) has neither, so his rows are built as before", () => {
  assert.equal(CONFIG.music.needsEvidence, true);
  assert.equal(CONFIG.newReleases, undefined, "the key moved: config.json no longer carries newReleases");
  const o = P.musicOptions(CONFIG);
  assert.equal(o.needsEvidence, true);
  assert.equal(o.vouchLists.has("asnPI"), false); // Top 100 Concert Films (Letterboxd): trust fan
  assert.equal(CONFIG.lists.find((l) => l.id === "asnPI").trust, "fan");
  assert.equal(o.vouchLists.has("WaoLy"), true); // Tuning In: Sonic Journeys (MUBI): trust critic
  assert.equal(o.vouchLists.size, CONFIG.lists.filter((l) => l.trust === "critic" || l.trust === "director").length);
  const will = PEOPLE.deriveConfig(CONFIG, { id: "friend-a" });
  assert.equal(will.music, undefined);
  assert.equal(will.newReleases, undefined);
  assert.equal(P.musicOptions(will).needsEvidence, false);
});

// ── the question: musicAllowed and musicGate ────────────────────────────────

const film = (genres, keywords = [], title = "A Film") => ({ title, detail: { genres, keywords }, contributions: [], tags: { watchlist: false, lists: new Map() } });
const ON = { needsEvidence: true, vouchLists: new Set(["CRITIC"]) };

test("musicAllowed: a film that is not a music film is always allowed; a music film only with evidence; with the rule off (or no options) everything is allowed", () => {
  const show = film(["Documentary", "Music"], ["k-pop", "concert film"], "Arena Tour Film");
  assert.equal(P.musicAllowed(film(["Drama"]), ON), true);
  assert.equal(P.musicAllowed(film(["Music", "Drama"], ["jazz"]), ON), true, "Music genre but no Documentary, no live keyword, no title word: not a music film");
  assert.equal(P.musicAllowed(show, ON), false);
  assert.equal(P.musicAllowed(show, { ...ON, needsEvidence: false }), true);
  assert.equal(P.musicAllowed(show), true, "no options at all: the rule is off");
  assert.equal(P.musicAllowed(show, {}), true);
  // each door, alone
  assert.equal(P.musicAllowed({ ...show, contributions: [{ type: "director", n: 2, w: 0.5, label: "D", avg: 4.5 }] }, ON), true, "a director he rated in 2 films");
  assert.equal(P.musicAllowed({ ...show, contributions: [{ type: "director", n: 1, w: 0.5, label: "D", avg: 4.5 }] }, ON), false, "ONE film of a director is not evidence");
  assert.equal(P.musicAllowed({ ...show, tags: { watchlist: true, lists: new Map() } }, ON), true, "his watchlist");
  assert.equal(P.musicAllowed({ ...show, tags: { watchlist: false, lists: new Map([["CRITIC", {}]]) } }, ON), true, "a critics' list");
  assert.equal(P.musicAllowed({ ...show, tags: { watchlist: false, lists: new Map([["FAN", {}]]) } }, ON), false, "a fan list grants nothing");
});

test("musicGate: asked by IMDb id, once per film; a film he has seen is never refused; a film the build knows nothing about is allowed; the refusals are kept for the log; off, it never looks at a film", () => {
  const show = film(["Documentary", "Music"], ["concert film"], "Arena Tour Film"), drama = film(["Drama"], [], "Plain");
  const asked = [];
  const recs = { tt1: show, tt2: drama, tt3: show };
  const recOf = (tt) => { asked.push(tt); return recs[tt] || null; };
  const g = P.musicGate({ options: ON, recOf, seen: (tt) => tt === "tt3" });
  assert.equal(g.on, true);
  assert.equal(g.ok("tt1"), false);
  assert.equal(g.ok("tt1"), false);
  assert.deepEqual(asked, ["tt1"], "the answer is kept: the record is read once");
  assert.equal(g.ok("tt2"), true);
  assert.equal(g.ok("tt3"), true, "the same music film, seen: not a recommendation, so not refused");
  assert.equal(g.ok("tt9"), true, "no record: a missing fact is never guessed");
  assert.deepEqual([...g.refused.keys()], ["tt1"]);
  assert.equal(g.refused.get("tt1").title, "Arena Tour Film");
  assert.ok(!asked.includes("tt3"), "a seen film is not even looked up");
  const off = P.musicGate({ options: { ...ON, needsEvidence: false }, recOf: () => { throw new Error("off: no film is looked at"); } });
  assert.equal(off.on, false);
  assert.equal(off.ok("tt1"), true);
  assert.equal(off.refused.size, 0);
});

// ── the world ────────────────────────────────────────────────────────────────

const DEMME = { id: 101, name: "Jonathan Demme" }, ARENA = { id: 900, name: "Arena Director" }, ACTOR = { id: 55, name: "Rated Actor" };
let n = 0;
/** A TMDB-ish record. Film k has the IMDb id tt000000k. */
function rec(title, o = {}) {
  const id = ++n;
  return { id, imdb: `tt${String(id).padStart(7, "0")}`, title, year: 2024, date: "2024-05-01", runtime: 90, genres: ["Documentary", "Music"], keywords: ["concert film"], directors: [ARENA], cast: [], countries: ["KR"], lang: "ko", va: 7.5, vc: 3000, overview: "O", ...o };
}
const SHOW = rec("K-pop Arena Tour", { keywords: ["k-pop", "boy band", "concert film"] }); //            music film, no evidence of any kind
const FAN = rec("Fan List Concert", { directors: [{ id: 901, name: "Other Director" }] }); //          music film, only in a fan list
const EVID = rec("Stop Making Sense Again", { directors: [DEMME], countries: ["US"], lang: "en" }); //   music film: a director he rated in 2 films
const WL = rec("Watchlisted Gig", { directors: [{ id: 902, name: "Third" }], genres: ["Music"], keywords: ["live performance"] }); // music film on his watchlist
const CRIT = rec("Critics' Concert", { directors: [{ id: 903, name: "Fourth" }], genres: ["Music"], keywords: ["concert"] }); //   music film in a critics' list
const PLAIN = rec("A Plain Documentary", { genres: ["Documentary"], keywords: ["nature"], directors: [{ id: 904, name: "Fifth" }] }); //  not music
const OLD = rec("Seen Concert", { directors: [{ id: 905, name: "Sixth" }], keywords: ["concert film"] }); //  music film he has SEEN
const FILMS = { SHOW, FAN, EVID, WL, CRIT, PLAIN, OLD };
const tt = (f) => f.imdb;
const SLUG = Object.fromEntries(Object.entries(FILMS).map(([k, f]) => [k, k.toLowerCase()]));
const lbFilms = Object.fromEntries(Object.entries(FILMS).map(([k, f]) => [SLUG[k], { title: f.title, year: f.year, tmdbId: f.id, imdbId: f.imdb, r: 4.4, rn: 20000, rt: f.runtime, c: ["USA"] }]));
const LISTS = [
  { id: "FANLIST", name: "Concert list", items: ["show", "fan", "evid", "plain", "wl", "crit", "old"].map((slug) => ({ slug })) },
  { id: "CRITIC", name: "Critics' list", items: [{ slug: "crit" }] },
];
const CFG_LISTS = [{ id: "FANLIST", trust: "fan" }, { id: "CRITIC", trust: "critic" }];
const MODEL = learn([
  { film: { id: 8001, title: "Stop Making Sense", year: 1984, directors: [DEMME], cast: [], genres: ["Documentary", "Music"], keywords: [], countries: ["US"], lang: "en" }, rating: 5, liked: false },
  { film: { id: 8002, title: "Philadelphia", year: 1993, directors: [DEMME], cast: [], genres: ["Drama"], keywords: [], countries: ["US"], lang: "en" }, rating: 5, liked: false },
  ...[1, 2, 3, 4, 5, 6].map((k) => ({ film: { id: 8100 + k, title: "Filler " + k, year: 1990, directors: [{ id: 300 + k, name: "Filler " + k }], cast: [], genres: ["Drama"], keywords: [], countries: ["FR"], lang: "fr" }, rating: 3, liked: false })),
]);
const SEEN = new Set([tt(OLD)]);

/** The gate the way build.js makes it, for a rule on or off. */
function gateOf(needsEvidence) {
  const options = { ...P.musicOptions({ music: { needsEvidence }, lists: CFG_LISTS }) };
  const cands = Object.values(FILMS).map((f) => ({ film: f, watchlist: f === WL }));
  const recOf = P.musicRecords({ films: lbFilms, lists: LISTS, watchlistSlugs: ["wl"], cands, peek: (id) => Object.values(FILMS).find((f) => f.id === id) || null, model: MODEL });
  return P.musicGate({ options, recOf, seen: (x) => SEEN.has(x) });
}

test("musicRecords: the facts of the gate, from what build.js holds: the film's own record, the Letterboxd title, the watchlist, the lists that hold it and the taste model's persons", () => {
  const recOf = P.musicRecords({ films: lbFilms, lists: LISTS, watchlistSlugs: ["wl"], cands: [], peek: (id) => Object.values(FILMS).find((f) => f.id === id) || null, model: MODEL });
  const e = recOf(tt(EVID)), w = recOf(tt(WL)), c = recOf(tt(CRIT)), s = recOf(tt(SHOW));
  assert.equal(e.title, "Stop Making Sense Again");
  assert.equal(P.musicEvidence(e, new Set(["CRITIC"])), "person", "Demme: two films rated 5");
  assert.equal(P.musicEvidence(w, new Set(["CRITIC"])), "watchlist", "the slug of his watchlist names the film by its IMDb id");
  assert.equal(P.musicEvidence(c, new Set(["CRITIC"])), "list");
  assert.deepEqual([...c.tags.lists.keys()].sort(), ["CRITIC", "FANLIST"], "every list that holds the film, fan lists too (musicEvidence keeps the critics' ones)");
  assert.equal(P.musicEvidence(s, new Set(["CRITIC"])), null);
  assert.equal(recOf("tt9999999"), null, "a film nobody holds");
  // the TMDB record counts only when it is the film's own: a Letterboxd page that names ANOTHER film's TMDB id has no record (lib/pool.js ownDetail)
  const foreign = P.musicRecords({ films: { show: { ...lbFilms.show, tmdbId: FAN.id } }, lists: [], watchlistSlugs: [], cands: [], peek: (id) => Object.values(FILMS).find((f) => f.id === id) || null, model: MODEL });
  assert.equal(foreign(tt(SHOW)), null);
  // a candidate's film (TMDB, found by IMDb id) stands for a page with no TMDB id
  const viaCand = P.musicRecords({ films: { show: { ...lbFilms.show, tmdbId: null } }, lists: [], watchlistSlugs: [], cands: [{ film: SHOW, watchlist: true }], peek: () => null, model: MODEL });
  assert.equal(P.musicEvidence(viaCand(tt(SHOW)), new Set()), "watchlist", "and a candidate flagged as watchlist is on the watchlist");
  // the title word of the rule is Letterboxd's title (the pool's `title`), not TMDB's: this film is a music film only because its Letterboxd page says "Tour" (Music genre, no Documentary, no live keyword)
  const quiet = rec("Night of the Show", { genres: ["Music"], keywords: ["singer"], countries: ["US"], lang: "en" });
  const viaTitle = P.musicRecords({ films: { quiet: { title: "Night Tour", year: 2024, tmdbId: quiet.id, imdbId: quiet.imdb } }, lists: [], watchlistSlugs: [], cands: [], peek: (id) => (id === quiet.id ? quiet : null), model: MODEL });
  assert.equal(viaTitle(quiet.imdb).title, "Night Tour");
  assert.equal(P.isMusicFilm(viaTitle(quiet.imdb)), true, "Letterboxd's title decides");
  assert.equal(P.isMusicFilm({ title: quiet.title, detail: quiet }), false, "control: with TMDB's title the same film is not one");
  // a page that is gone is no record
  const gone = P.musicRecords({ films: { show: { ...lbFilms.show, gone: true } }, lists: [], watchlistSlugs: [], cands: [], peek: (id) => (id === SHOW.id ? SHOW : null), model: MODEL });
  assert.equal(gone(tt(SHOW)), null);
});

// ── the rows: the same world through every builder ──────────────────────────

const ids = (items) => items.map((i) => i.id);
const SIZES = { tonight: 10, row: 50, discover: 100, moodRepeatWindow: 30, because: 20, directors: 24, oldFriends: 24, watchlist: 100, lists: 100, friendsDiscover: 60 };
const bare = (f, o = {}) => ({ id: f.id, film: f, tasteZ: 0, qualityZ: 0, contributions: [], seeds: [], seedIds: new Set(), pins: [], recCount: 0, lists: [], ...o });

/**
 * Every row of the world, as ids, for the rule on (true), off (false) or with NO gate at all (the builders' default `eligible`, which is what the code did before the rule: "none").
 * The quality floor lets everything through: the music rule is the only thing that differs.
 */
function world(needsEvidence) {
  const gate = needsEvidence === "none" ? { on: false, ok: () => true, refused: new Map() } : gateOf(needsEvidence);
  const recommendable = (x) => gate.ok(x);
  const out = {};
  const cands = Object.values(FILMS).filter((f) => !SEEN.has(f.imdb)).map((f, i) => bare(f, { tasteZ: 10 - i, watchlist: f === WL, lists: f === CRIT ? ["CRITIC", "FANLIST"] : ["FANLIST"] }));
  const moods = compile([{ id: "docs", genres: { Documentary: 3, Music: 3 }, minFit: 2 }]);
  const rewatch = [{ film: OLD, rating: 5, liked: true, lastSeen: "2020-01-01" }];

  // the legacy rows: Tonight, the mood row, Directors you trust, Old friends, the watchlist
  const legacy = buildRows({ pool: cands, rewatch, moods, cfg: { sizes: SIZES, build: { directors: 15 } }, model: MODEL, recentSeeds: [], today: "2026-10-22", eligible: recommendable });
  for (const [id, items] of Object.entries(legacy.rows)) out["rows:" + id] = ids(items);
  out["ranked:docs"] = ids(legacy.ranked.docs.map((c) => ({ id: c.film.imdb }))); // the picker and the Moods slices keep every film that fits

  // the v2 rows: a filter row, a mood row of the v2 family and the watchlist by date added
  const spec = { entries: ["docs-f", "vmood", "watchlist"].map((id) => ({ id, name: id, place: "board" })), rows: { "docs-f": { id: "docs-f", kind: "filter", where: { genresAny: ["Documentary"] } } }, legacyMoods: [] };
  const vmoods = compile([{ id: "vmood", genres: { Music: 3, Documentary: 3 }, minFit: 2 }]);
  const v2 = BR.buildBoardRows({ cands, watchlistCands: cands.filter((c) => c.watchlist), moods: vmoods, legacy: new Set(), ranked: {}, spec, cfg: { sizes: SIZES }, today: "2026-10-22", eligible: recommendable });
  for (const [id, items] of Object.entries(v2.rows)) out["v2:" + id] = ids(items);

  // the pool rows: From your lists, Short and good, New for you, and the Discover cuts
  const entries = [];
  for (const l of LISTS) l.items.forEach((it, i) => entries.push({ slug: it.slug, tag: { type: "list", id: l.id, name: l.name, pos: i + 1 } }));
  entries.push({ slug: "wl", tag: { type: "watchlist" } });
  const { pool } = P.buildPool({ entries, view: { films: lbFilms }, isSeen: (r) => SEEN.has(r.id), detail: P.ownDetail((id) => Object.values(FILMS).find((f) => f.id === id) || null) });
  const recs = P.rankPool(pool, MODEL);
  const passing = recs.filter((r) => recommendable(r.id));
  out["pool:fromlists"] = ids(P.fromListsRow(passing, 50));
  out["pool:short"] = ids(P.shortRow(passing, { size: 50 }));
  out["pool:newforyou"] = ids(P.newRow(passing, { fromYear: 2025 - 1, size: 50 }));
  const cutOut = P.cuts(recs.filter((r) => gate.ok(r.id)), { size: 60, countries: 12, today: "2026-10-22" });
  for (const cut of ["decade", "runtime", "country", "rating"]) for (const o of cutOut[cut]) out[`cut:${cut}:${o.label}`] = ids(o.items);

  // Friends loved: three people love every film
  const people = ["ann", "ben", "cy"].map((u) => ({ user: u, name: u, films: new Map(Object.keys(lbFilms).map((slug, i) => [slug, { slug, rating: 5, order: i }])), watchlist: new Map() }));
  const view = { users: people, crowd: people, films: lbFilms, lists: [] };
  const love = buildFriendRows({ view, cfg: { sizes: SIZES, friendRows: { love: { minFriends: 2 } } }, isSeen: (r) => SEEN.has(r.imdbId), onMyWatchlist: () => false, eligible: recommendable });
  out["friends-love"] = ids(love.rows["friends-love"]);

  // the special rows that recommend (Friend's top picks, Friends can't agree, Untried directors) and the ones that show a source (Friends want to see this too, a single-list row)
  const slugs = Object.keys(lbFilms);
  const person = (user, rate, watch = false) => ({ user, name: user, films: new Map(watch ? [] : slugs.map((slug, k) => [slug, { slug, title: slug, year: 2024, rating: rate, order: k }])), watchlist: new Map(watch ? slugs.map((slug) => [slug, { slug, title: slug, year: 2024 }]) : []) });
  const ctxOf = (crowd, over = {}) => ({
    today: "2026-10-13", sizes: { row: 50, discover: 100 }, view: { users: [], crowd, films: lbFilms, me: new Set() }, recs, cands, rated: [], seenDirectors: new Set(), lb: () => 4.4, awards: {},
    isSeen: (r) => SEEN.has(r.imdbId), detail: (r) => (r.tmdbId ? Object.values(FILMS).find((f) => f.id === r.tmdbId) || null : null), model: MODEL, favourites: null, userOf: null, watched: () => new Map(), tmdbOfImdb: () => null,
    allowed: () => true, recommended: recommendable, ...over,
  });
  const spc = (id, over = {}) => ({ ...SR.DEFAULT_ROWS.find((r) => r.id === id), ...over });
  const named = (res, prefix) => { for (const [id, items] of Object.entries(res.rows)) out[prefix + id] = ids(items); };
  named(SR.build(ctxOf(SR.TOP_FRIENDS.map((u) => person(u, 4.5))), [spc("top-picks")]), "special:");
  named(SR.build(ctxOf([person("ann", 1), person("ben", 3), person("cy", 5)]), [spc("friends-split", { minRatings: 3, minSd: 1 })]), "special:");
  named(SR.build(ctxOf([]), [spc("untried-directors", { minFilms: 1, minStars: 3.8, rotate: "none" })]), "special:");
  const mineRecs = recs.map((r) => ({ ...r, tags: { ...r.tags, watchlist: true } })); // every film on his watchlist in this run, so that "want to see" has a row
  named(SR.build(ctxOf([person("ann", 4, true)], { recs: mineRecs }), [spc("friends-watchlist", { minPeople: 1 })]), "special:");
  named(SR.build(ctxOf([]), [spc("sight-sound", { listIds: ["FANLIST"] })]), "special:");
  // Friends watched this month (special-rows.js friendsMonth -> P.weekRow): the diary of the last 30 days holds every film of the world, the seen one too
  const diary = new Map(slugs.map((slug) => [slug, [{ name: "ann", rating: 4.5, watched: "2026-10-20" }]]));
  named(SR.build(ctxOf([], { watched: () => diary }), [spc("friends-month")]), "special:");

  // what a source HOLDS: the lists in Discover; and Friends watched this week, which RECOMMENDS (Marco: "all the rows"; the week row asks the gate like the others)
  const cats = P.listCatalogs({ lists: LISTS, view: { films: lbFilms }, isSeen: (r) => SEEN.has(r.imdbId), detail: P.ownDetail((id) => Object.values(FILMS).find((f) => f.id === id) || null), size: 100 });
  for (const c of cats) { out["list:" + c.id + ":all"] = ids(c.all); out["list:" + c.id + ":unseen"] = ids(c.unseen); }
  const week = P.weekRow({ week: new Map(Object.keys(lbFilms).map((slug) => [slug, [{ name: "ann", rating: 4.5, watched: "2026-10-20" }]])), view: { films: lbFilms }, isSeen: (r) => SEEN.has(r.imdbId), detail: P.ownDetail((id) => Object.values(FILMS).find((f) => f.id === id) || null), size: 50, eligible: recommendable });
  out["week"] = ids(week.items);
  return { out, gate };
}

// the rows that RECOMMEND: the show with no evidence is in none of them, and the fan list's concert neither
const RECOMMENDING = (key) => /^(rows:(tonight|docs|directors|because)|v2:(docs-f|vmood)|pool:|cut:|friends-love|week|special:(top-picks|friends-split|untried-directors|friends-month))/.test(key);
// the rows that show what a source holds
const MIRRORS = ["rows:watchlist", "rows:oldfriends", "v2:watchlist", "special:friends-watchlist", "special:sight-sound", "list:FANLIST:all", "list:FANLIST:unseen"];

test("every row that recommends, in one small world: a music film with no evidence is in none of them (and the controls: with the rule off it is in each, so the world has the defect row by row)", () => {
  const on = world(true).out, off = world(false).out;
  const keys = Object.keys(off).filter(RECOMMENDING);
  // the world must reach every kind of row, or an empty row would pass the test for the wrong reason
  for (const k of ["rows:tonight", "rows:docs", "v2:docs-f", "v2:vmood", "pool:fromlists", "pool:short", "pool:newforyou", "friends-love", "special:top-picks", "special:friends-split", "special:untried-directors"]) assert.ok(keys.includes(k), `the world has the row ${k}`);
  assert.ok(keys.some((k) => k.startsWith("cut:decade:")) && keys.some((k) => k.startsWith("cut:country:")) && keys.some((k) => k.startsWith("cut:runtime:")) && keys.some((k) => k.startsWith("cut:rating:")), "and the four cuts of Discover");
  const controlMissing = [], leaked = [];
  for (const k of keys) {
    const hadShow = off[k].includes(tt(SHOW));
    if (!hadShow && !["rows:directors", "rows:because"].includes(k) && !k.startsWith("cut:")) controlMissing.push(k); // Directors and Because need seeds the world does not have (the source test below counts them); a cut holds the show in ITS option only, checked next
    if ((on[k] || []).includes(tt(SHOW)) || (on[k] || []).includes(tt(FAN))) leaked.push(k);
  }
  assert.deepEqual(controlMissing, [], "positive control: with the rule off the K-pop show is in every one of these rows");
  for (const cut of ["decade", "runtime", "country", "rating"]) assert.ok(keys.some((k) => k.startsWith(`cut:${cut}:`) && off[k].includes(tt(SHOW))), `positive control: with the rule off the show is in an option of the ${cut} cut`);
  assert.deepEqual(leaked, [], "the K-pop show and the fan list's concert are in no row that recommends");
});

test("the rows refill: what stays is what has evidence, a plain film is never lost, and the evidence doors each keep their film (director rated twice, watchlist, critics' list)", () => {
  const on = world(true).out;
  for (const k of ["v2:docs-f", "pool:fromlists", "pool:newforyou", "rows:docs"]) {
    assert.ok(on[k].includes(tt(PLAIN)), `${k}: the plain documentary stays`);
    assert.ok(on[k].includes(tt(EVID)), `${k}: a director he rated in two films`);
  }
  assert.ok(on["pool:fromlists"].includes(tt(WL)) && on["pool:fromlists"].includes(tt(CRIT)), "watchlist and critics' list");
  assert.ok(on["v2:vmood"].includes(tt(WL)) && on["v2:vmood"].includes(tt(CRIT)) && on["v2:vmood"].includes(tt(EVID)));
  assert.ok(!on["v2:vmood"].includes(tt(SHOW)));
  assert.deepEqual(on["pool:fromlists"].filter((x) => ![tt(PLAIN), tt(EVID), tt(WL), tt(CRIT)].includes(x)), [], "nothing else is in From your lists");
});

test("Friends watched this month and this week, with the diary filled: the show and the fan list's concert leave, the film with evidence (director rated twice, watchlist, critics' list) and the plain one stay, a film he has seen is in neither run (the diary row never shows a seen film), and with the rule off they are all there", () => {
  const on = world(true).out, off = world(false).out;
  for (const row of ["special:friends-month", "week"]) {
    assert.ok(off[row].includes(tt(SHOW)) && off[row].includes(tt(FAN)), `${row}: control, the rule off: both are there`);
    assert.ok(!on[row].includes(tt(SHOW)) && !on[row].includes(tt(FAN)), `${row}: the show and the fan list's concert are out`);
    for (const f of [EVID, WL, CRIT, PLAIN]) assert.ok(on[row].includes(tt(f)), `${row}: ${f.title} stays`);
    assert.ok(!on[row].includes(tt(OLD)) && !off[row].includes(tt(OLD)), `${row}: a film he has seen is never in the diary row, whatever the rule`);
    assert.equal(off[row].length - on[row].length, 2, `${row}: exactly the two refused films left`);
  }
});

test("the rows that show what a source holds are not touched: the watchlist, Friends want to see, a single-list row, Lists and Lists (unseen) keep the show; a film he has seen stays in Old friends", () => {
  const { out: on, gate } = world(true), off = world(false).out;
  for (const k of MIRRORS) assert.deepEqual(on[k], off[k], `${k}: the same with the rule on and off`);
  assert.ok(on["list:FANLIST:all"].includes(tt(SHOW)) && on["list:FANLIST:all"].includes(tt(FAN)), "the list that cites the show still lists it");
  assert.ok(on["list:FANLIST:unseen"].includes(tt(SHOW)), "and its unseen option");
  assert.ok(off["week"].includes(tt(SHOW)) && !on["week"].includes(tt(SHOW)), "Friends watched this week RECOMMENDS: the diary of the people he follows is read as a recommendation (a reading of the session, written in PRODUCT.md)");
  assert.ok(on["special:friends-watchlist"].includes(tt(SHOW)), "Friends want to see this too (his own watchlist)");
  assert.ok(on["special:sight-sound"].includes(tt(SHOW)), "a single-list row shows the list");
  assert.ok(on["rows:oldfriends"].includes(tt(OLD)), "Old friends: a music film he has seen is not a recommendation, so the rule leaves it");
  assert.ok(on["ranked:docs"].includes(tt(SHOW)), "the picker and the Moods menus keep every film that fits (the rule is in the rows)");
  assert.ok(gate.refused.has(tt(SHOW)) && gate.refused.has(tt(FAN)) && !gate.refused.has(tt(OLD)), "and the build can name what it kept out");
});

test("the rule off is the world as before: the same ids in the same order in every row as with no gate at all", () => {
  const off = world(false), none = world("none");
  assert.deepEqual(off.out, none.out);
  assert.equal(off.gate.on, false);
  assert.equal(off.gate.refused.size, 0);
  assert.ok(Object.values(off.out).some((ids_) => ids_.includes(tt(SHOW))), "and the world does have the show in its rows");
  const on = world(true).out;
  assert.notDeepEqual(on, off.out, "control: with the rule on the world is NOT the same");
});

// ── build.js wires it ────────────────────────────────────────────────────────

test("build.js hands every recommending builder the gate and the mirrors the quality rule alone (a builder that is forgotten keeps the K-pop shows in its row)", () => {
  const src = fs.readFileSync(path.join(ROOT, "build.js"), "utf8");
  const has = (re, msg) => assert.match(src, re, msg);
  has(/const recommendable = \(tt\) => eligibleTt\(tt\) && music\.ok\(tt\);/, "recommendable = the quality rule AND the gate");
  has(/buildRows\(\{ pool: cands, rewatch, moods, cfg, model, recentSeeds, today, eligible: recommendable, tonightShown: tonightStep\.shown, exempt: music\.on && musicExempt\.length \? \{ moods: new Set\(musicExempt\), eligible: eligibleTt \} : null \}\)/, "the legacy rows, and the exempt mood's Moods-menu list (22/10/2026) asked the quality rule alone");
  has(/eligible: recommendable, rated: ratedByMarco,/, "the v2 Board rows (lib/board-rows.js)");
  has(/buildFriendRows\(\{ view, cfg(?:: c)?, isSeen: seenRec, onMyWatchlist: onWatch, tasteScore, detail: shownFriends, keepEmpty: true, eligible: recommendable, unrecorded \}\)/, "Friends loved"); // `unrecorded` added 22/10/2026 (friends-cards): a film TMDB has no movie of is in no friends row
  has(/const passing = recs\.filter\(\(r\) => recommendable\(r\.id\)\);/, "From your lists, Short and good, New for you");
  has(/P\.cuts\(recs\.filter\(\(r\) => music\.ok\(r\.id\)\), \{/, "the cuts of Discover");
  has(/recommended: \(tt\) => music\.ok\(tt\) && Q\.qualifies\(qualityRatings\.get\(tt\)\)/, "the special rows that recommend");
  // and the ones that show a source keep the quality rule alone
  has(/P\.weekRow\(\{ week, view, isSeen: seenRec, tasteScore, detail: shownFriends, size: cfg\.sizes\.row, eligible: recommendable, minRuntime: P\.minFeatureMinutes\(cfg\) \}\)/, "Friends watched this week"); // minRuntime: no short (14/11/2026, test/shorts-floor.test.js)
  has(/films\.filter\(\(c\) => eligibleTt\(c\.imdb\)\)/, "Loved by your directors");
  has(/recOf: P\.musicRecords\(\{ films: lbFilms \|\| \{\}, lists: got \? got\.listsRead\.lists : \[\], watchlistSlugs: mine\.watchlist, cands: candsWithExcluded,/, "the gate reads the facts through musicRecords");
  has(/options: P\.musicOptions\(cfg\), seen: \(tt\) => seenTts\.has\(tt\)/, "options from the config, seen films never refused");
  has(/musicOut: \(tt\) => !music\.ok\(tt\), musicExemptMoods: music\.on \? musicExempt : \[\], permits:/, "the index carries the verdict (bit 8) for the Worker, and the moods exempt from it (22/10/2026)");
  has(/webData\.films = webData\.films\.filter\(\(x\) => music\.ok\(x\.i\)\);/, "the web picker recommends: the gate holds there too");
  has(/webData\.tonight = webData\.tonight\.filter\(\(id\) => kept\.has\(id\)\);/, "and its Tonight ids follow the films that stay");
  // New for you no longer asks the gate itself: it is made from `passing`
  has(/newforyou: P\.newRow\(features, newRowOpts\),/); // `features` is `passing` without the shorts (14/11/2026, test/shorts-floor.test.js)
  has(/const features = passing\.filter\(/);
  const pool = fs.readFileSync(path.join(ROOT, "lib/pool.js"), "utf8");
  assert.ok(!/musicNeedsEvidence\s*=|leftOut/.test(pool.replace(/newReleases\.musicNeedsEvidence/g, "")), "lib/pool.js newCandidates has no music rule of its own any more");
  const sr = fs.readFileSync(path.join(ROOT, "lib/special-rows.js"), "utf8");
  assert.equal((sr.match(/ctx\.recommended\(/g) || []).length, 4, "top-picks, friends-split, untried-directors, actor-week ask `recommended`");
  assert.equal((sr.match(/ctx\.allowed\(/g) || []).length, 3, "friends-watchlist, awards and the single-list rows ask `allowed`");
  assert.equal((sr.match(/eligible: ctx\.recommended, period/g) || []).length, 1, "and Friends watched this month hands weekRow `recommended`");
});
