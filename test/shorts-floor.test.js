// node --test            (no dependencies; reads no cache: every world is made here)
// Marco, 14/11/2026 ("Keep shorts only in the Short row"): a film whose KNOWN runtime is under config.json shortRow.minMinutes (40) is in no row that recommends a film he has not seen.
// A film with no runtime stays (lib/pool.js isShort: unknown is not a short). The rows that show what a source holds keep their shorts: the watchlist, the friends' collections, the lists.
// The mutations this file is written to kill are listed in the commit message of this change (test-support/lugares-mutacoes.js shorts plants each in a copy of the code).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const P = require("../lib/pool");
const { buildRows, buildFriendRows } = require("../lib/rows");
const BR = require("../lib/board-rows");
const SR = require("../lib/special-rows");
const { compile } = require("../lib/moods");
const { learn } = require("../lib/taste");

const ROOT = path.join(__dirname, "..");
const tt = (n) => `tt${String(3000000 + n)}`;
// runtimes: 1 = 15 min (a short), 2 = 100, 3 = unknown, 4 = 39 (a short by one minute), 5 = 40 (a feature: the floor is "under 40"), 6 = 120
const RT = { 1: 15, 2: 100, 3: null, 4: 39, 5: 40, 6: 120 };
const SHORTS = [tt(1), tt(4)];
const film = (n, o = {}) => ({ id: n, imdb: tt(n), title: `F${n}`, year: 2000, runtime: RT[n], genres: ["G"], keywords: [], directors: [{ id: 100 + n, name: `D${n}` }], cast: [], countries: [], va: 7, vc: 500, overview: "", ...o });
// the shorts are the best ranked: a row that forgot the floor would show them first
const cand = (n, o = {}) => ({ id: n, film: film(n, o.film), tasteZ: n === 1 || n === 4 ? 5 : 1 - n * 0.1, qualityZ: 0, recCount: 0, seeds: [], pins: [], contributions: [], watchlist: n === 1, ...o.c });
const POOL = [1, 2, 3, 4, 5, 6].map((n) => cand(n));
const MOODS = compile([{ id: "a", name: "A", word: "A", genres: { G: 2 }, keywords: {}, minFit: 1 }]);
const SIZES = { tonight: 6, row: 50, discover: 100, because: 20, directors: 24, oldFriends: 24, watchlist: 100, friendsDiscover: 60 };
const cfgOf = (shortRow = { minMinutes: 40, maxMinutes: 95 }) => ({ sizes: SIZES, build: { directors: 15 }, shortRow });
const legacy = (cfg = cfgOf(), o = {}) => buildRows({ pool: POOL, rewatch: [], moods: MOODS, cfg, model: { stats: new Map() }, recentSeeds: [], today: "2026-11-14", ...o });
const ids = (items) => items.map((i) => i.id);
const noShort = (items, where) => { for (const s of SHORTS) assert.ok(!ids(items).includes(s), `${where}: ${s} is a short and is there`); };

test("the number lives in one place: config.json shortRow.minMinutes is 40, and the helper reads it", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  assert.equal(cfg.shortRow.minMinutes, 40);
  assert.equal(P.minFeatureMinutes(cfg), 40);
  assert.equal(P.minFeatureMinutes({ shortRow: { minMinutes: 25 } }), 25);
  assert.equal(P.minFeatureMinutes({}), P.MIN_FEATURE_MINUTES, "a config without the key: 40");
  assert.equal(P.MIN_FEATURE_MINUTES, 40);
});

test("isShort: a known runtime under the floor; 40 itself is a feature; an unknown or zero runtime is not a short", () => {
  assert.equal(P.isShort(15, 40), true);
  assert.equal(P.isShort(39, 40), true);
  assert.equal(P.isShort(40, 40), false);
  assert.equal(P.isShort(120, 40), false);
  for (const x of [null, undefined, 0, "15"]) assert.equal(P.isShort(x, 40), false, String(x));
});

test("legacy rows: the mood row, its Moods-menu list and Tonight take no short; the unknown runtime and the 40-minute film stay; `ranked` keeps the shorts", () => {
  const out = legacy(cfgOf(), { exempt: { moods: new Set(["a"]), eligible: () => true } });
  noShort(out.rows.a, "mood row a");
  assert.deepEqual(ids(out.rows.a), [tt(2), tt(3), tt(5), tt(6)]);
  noShort(out.menu.a, "Moods menu list of a");
  assert.equal(out.menu.a.length, 4);
  noShort(out.rows.tonight, "Tonight");
  assert.deepEqual(ids(out.rows.tonight).sort(), [tt(2), tt(3), tt(5), tt(6)].sort(), "Tonight holds every feature and nothing else");
  assert.ok(ids(out.ranked.a.map((c) => ({ id: c.film.imdb }))).includes(tt(1)), "ranked (the index's mood membership) still has the short");
});

test("legacy rows: the watchlist row shows its short (a source row)", () => {
  assert.ok(ids(legacy().rows.watchlist).includes(tt(1)));
});

test("control: with shortRow.minMinutes 10 the 15-minute film is back in the mood row and Tonight (the floor is read from the config, not written in the code)", () => {
  const out = legacy(cfgOf({ minMinutes: 10, maxMinutes: 95 }));
  assert.equal(out.rows.a[0].id, tt(1));
  assert.ok(ids(out.rows.tonight).includes(tt(1)));
  assert.ok(!ids(legacy().rows.a).includes(tt(1)), "and with 40 it is out");
});

test("legacy rows: Because you loved and Directors you trust take no short", () => {
  const seed = { tmdbId: 999, title: "Seed", rating: 5 };
  const pool = POOL.map((c) => ({ ...c, seedIds: new Set([999]) }));
  const stats = new Map([["d:101", { type: "director", key: "d:101", label: "D1", n: 3, w: 1, avg: 4.8 }], ["d:102", { type: "director", key: "d:102", label: "D2", n: 3, w: 0.9, avg: 4.6 }]]);
  const out = buildRows({ pool, rewatch: [], moods: MOODS, cfg: cfgOf(), model: { stats }, recentSeeds: [seed], today: "2026-11-14" }).rows;
  noShort(out.because, "Because you loved");
  assert.ok(out.because.length >= 4);
  noShort(out.directors, "Directors you trust");
  assert.deepEqual(ids(out.directors), [tt(2)], "D1 has only the short; D2's film is the one");
});

// ── the v2 Board ─────────────────────────────────────────────────────────────

const SPEC = {
  entries: [{ id: "f" }, { id: "m" }, { id: "c" }, { id: "watchlist" }],
  rows: { f: { kind: "filter", where: { years: { min: 1900 } } }, c: { kind: "combine", parts: ["m", "f"] } },
};
const v2 = (cfg = cfgOf()) => BR.buildBoardRows({ cands: POOL, watchlistCands: POOL.filter((c) => c.watchlist), moods: compile([{ id: "m", name: "M", word: "M", genres: { G: 2 }, keywords: {}, minFit: 1 }]), legacy: new Set(), ranked: {}, spec: SPEC, cfg, today: "2026-11-14" }).rows;

test("v2 Board: the filter, mood and combined rows take no short; the watchlist keeps its short", () => {
  const rows = v2();
  for (const id of ["f", "m", "c"]) { noShort(rows[id], id); assert.equal(rows[id].length, 4, id); }
  assert.deepEqual(ids(rows.watchlist), [tt(1)]);
});

test("control: v2 Board with shortRow.minMinutes 10: the 15-minute film is in the three rows", () => {
  const rows = v2(cfgOf({ minMinutes: 10 }));
  for (const id of ["f", "m", "c"]) assert.ok(ids(rows[id]).includes(tt(1)), id);
});

// ── the special rows that recommend ─────────────────────────────────────────

const slug = (n) => `film-${n}`;
const lbRec = (n) => ({ imdbId: tt(n), title: `F${n}`, year: 2000, r: 4.2, rt: RT[n] });
const person = (user, ratings) => ({ user, name: user, films: new Map(Object.entries(ratings).map(([n, rating], i) => [slug(n), { slug: slug(n), title: `F${n}`, year: 2000, rating, order: i, watched: null }])), watchlist: new Map() });
const FILMS = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [slug(n), lbRec(n)]));
const ALL6 = { 1: 5, 2: 5, 3: 5, 4: 5, 5: 5, 6: 5 };
function ctxOf(o = {}) {
  return {
    today: "2026-11-14", sizes: { row: 50, discover: 100 }, view: { users: [], crowd: o.crowd || [], films: FILMS, me: new Set() }, recs: [], cands: o.cands || [], rated: o.rated || [], seenDirectors: new Set(),
    lb: () => 4.2, awards: {}, isSeen: () => false, detail: () => null, allowed: () => true, model: learn([]), favourites: null, userOf: null, watched: o.watched || (() => new Map()), tmdbOfImdb: () => null,
    ...(o.min !== undefined ? { minFeatureMinutes: o.min } : {}),
  };
}

test("special rows: Friend's top picks and Friends can't agree take no short (the Letterboxd runtime of the friend's film)", () => {
  const crowd = [person("ann", ALL6), person("bob", { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 }), person("cy", { 1: 3, 2: 3, 3: 3, 4: 3, 5: 3, 6: 3 })];
  const specs = [{ id: "top-picks", kind: "top-picks", people: ["ann"], minStars: 4.5, fillStars: 4, size: 60 }, { id: "friends-split", kind: "friends-split", minRatings: 3, minSd: 1 }];
  const out = SR.build(ctxOf({ crowd, min: 40 }), specs).rows;
  for (const id of ["top-picks", "friends-split"]) { noShort(out[id], id); assert.equal(out[id].length, 4, id); }
  const control = SR.build(ctxOf({ crowd, min: 10 }), specs).rows;
  for (const id of ["top-picks", "friends-split"]) assert.ok(ids(control[id]).includes(tt(1)), `control ${id}`);
});

test("special rows: a ctx without minFeatureMinutes (an older caller) still floors at 40", () => {
  const out = SR.build(ctxOf({ crowd: [person("ann", ALL6)] }), [{ id: "top-picks", kind: "top-picks", people: ["ann"], minStars: 4.5, fillStars: 4, size: 60 }]).rows;
  noShort(out["top-picks"], "top-picks");
});

test("special rows: Great directors you've never seen and Actor of the week take no short", () => {
  const cast = [{ id: 7, name: "Actor" }];
  const cands = [1, 2, 3, 4, 5, 6].map((n) => cand(n, { film: { directors: [{ id: 9, name: "Dir" }], cast } }));
  const rated = [11, 12, 13].map((n) => ({ film: film(n, { cast }), rating: 5 }));
  const specs = [{ id: "untried-directors", kind: "untried-directors", minFilms: 3, minStars: 3.8, perDirector: 6, rotate: "none" }, { id: "actor-week", kind: "actor-week", minRated: 3, minAvg: 4, minEligible: 4 }];
  const out = SR.build(ctxOf({ cands, rated, min: 40 }), specs).rows;
  for (const id of ["untried-directors", "actor-week"]) { noShort(out[id], id); assert.equal(out[id].length, 4, id); }
  const control = SR.build(ctxOf({ cands, rated, min: 10 }), specs).rows;
  for (const id of ["untried-directors", "actor-week"]) assert.ok(ids(control[id]).includes(tt(1)), `control ${id}`);
});

test("special rows: Friends watched this month takes no short; P.weekRow without minRuntime keeps it (Friends watched this week gets the number from build.js)", () => {
  const week = new Map([1, 2, 3, 4, 5, 6].map((n) => [slug(n), [{ name: "ann", rating: 4, watched: "2026-11-10" }]]));
  const out = SR.build(ctxOf({ watched: () => week, min: 40 }), [{ id: "friends-month", kind: "friends-month", days: 30 }]).rows;
  noShort(out["friends-month"], "friends-month");
  assert.equal(out["friends-month"].length, 4);
  const plain = P.weekRow({ week, view: { films: FILMS }, isSeen: () => false });
  assert.ok(ids(plain.items).includes(tt(1)), "control: no minRuntime, no floor");
  const floored = P.weekRow({ week, view: { films: FILMS }, isSeen: () => false, minRuntime: 40 });
  noShort(floored.items, "weekRow minRuntime 40");
  assert.equal(floored.stats.shorts, 2);
});

test("Friends loved takes no short; the friends' Top collections keep theirs", () => {
  const view = { users: [person("ann", ALL6)], crowd: [person("ann", ALL6), person("bob", ALL6)], films: FILMS, lists: [] };
  const out = buildFriendRows({ view, cfg: cfgOf(), isSeen: () => false, onMyWatchlist: () => false, keepEmpty: true });
  noShort(out.rows["friends-love"], "friends-love");
  assert.equal(out.rows["friends-love"].length, 4);
  assert.ok(ids(out.rows["friends-top-ann"]).includes(tt(1)), "a friend's collection shows what the friend rated");
  const control = buildFriendRows({ view, cfg: cfgOf({ minMinutes: 10 }), isSeen: () => false, onMyWatchlist: () => false });
  assert.ok(ids(control.rows["friends-love"]).includes(tt(1)), "control");
});

test("Discover cuts: no short in the decade, country and rating cuts (the runtime cut already had it), counted once in missing.shortFilms", () => {
  const recs = [1, 2, 3, 4, 5, 6].map((n) => ({ id: tt(n), title: `F${n}`, year: 2005, lbRuntime: RT[n], lb: 4.3, lbCountries: ["FR"], rank: n === 1 || n === 4 ? 9 : -n, contributions: [], tags: { watchlist: true, lists: new Map(), friendsTop: new Map(), friendsWatch: new Map() } }));
  const out = P.cuts(recs, { size: 60, countries: 3, minRuntime: 40, today: "2026-11-14" });
  for (const k of ["decade", "country", "rating", "runtime"]) for (const o of out[k]) noShort(o.items, `${k} ${o.label}`);
  assert.equal(out.decade.find((o) => o.label === "2000s").items.length, 4);
  assert.equal(out.missing.shortFilms, 2);
  const control = P.cuts(recs, { size: 60, countries: 3, minRuntime: 10, today: "2026-11-14" });
  assert.ok(ids(control.decade.find((o) => o.label === "2000s").items).includes(tt(1)), "control");
});

test("build.js hands the config's number to every builder that is not handed the config", () => {
  const src = fs.readFileSync(path.join(ROOT, "build.js"), "utf8");
  assert.match(src, /minFeatureMinutes: P\.minFeatureMinutes\(cfg\)/, "the special rows' ctx");
  assert.match(src, /size: cfg\.sizes\.row, eligible: recommendable, minRuntime: P\.minFeatureMinutes\(cfg\) \}\)/, "Friends watched this week");
  assert.match(src, /const features = passing\.filter\(\(r\) => !P\.isShort\(P\.runtimeOf\(r\), P\.minFeatureMinutes\(cfg\)\)\)/);
  for (const row of ["fromListsRow", "shortRow", "newRow"]) assert.match(src, new RegExp(`P\\.${row}\\(features,`), row);
  assert.match(src, /P\.cuts\([^\n]*minRuntime: P\.minFeatureMinutes\(cfg\)/, "the cuts");
});

test("build.js's `features` statement, run on a small pool: the short leaves, the feature and the film with no runtime stay (a behaviour check: a comment holding the text would not pass)", () => {
  const src = fs.readFileSync(path.join(ROOT, "build.js"), "utf8");
  const m = /\n\s*const features = ([^;]*);/.exec(src);
  assert.ok(m, "the statement is in build.js");
  const passing = [{ id: "tt1", lbRuntime: 15 }, { id: "tt2", lbRuntime: 100 }, { id: "tt3" }, { id: "tt4", detail: { runtime: 39, imdb: "tt4" } }];
  const run = new Function("passing", "P", "cfg", `return (${m[1]});`);
  assert.deepEqual(run(passing, P, { shortRow: { minMinutes: 40 } }).map((r) => r.id), ["tt2", "tt3"]);
  assert.deepEqual(run(passing, P, { shortRow: { minMinutes: 10 } }).map((r) => r.id), ["tt1", "tt2", "tt3", "tt4"], "control: the config's number decides");
});

test("the web page's mood picker (engine.json films) drops its shorts and Tonight's ids follow; its rewatch films keep theirs (Marco, 15/11/2026: \"Only where you or a source put them\")", () => {
  const src = fs.readFileSync(path.join(ROOT, "build.js"), "utf8");
  const m = /\n  \{ \/\/ Marco, 15\/11\/2026 \(questionnaire, shorts[^\n]*\n([\s\S]*?)\n  \}\n/.exec(src);
  assert.ok(m, "the block is in build.js");
  const webData = { films: [{ i: "tt1", t: 0, r: 15 }, { i: "tt2", t: 1, r: 100 }, { i: "tt3", t: 2, r: null }, { i: "tt4", t: 3, r: 39 }], tonight: [0, 1, 3], rewatch: [{ i: "tt9", r: 12 }] };
  new Function("webData", "P", "cfg", "log", m[1])(webData, P, { shortRow: { minMinutes: 40 } }, () => {});
  assert.deepEqual(webData.films.map((x) => x.i), ["tt2", "tt3"]);
  assert.deepEqual(webData.tonight, [1]);
  assert.equal(webData.rewatch.length, 1);
  assert.deepEqual(P.dropShortPicks([{ r: 15 }, { r: 50 }], 10).length, 2, "control: the number is read");
});
