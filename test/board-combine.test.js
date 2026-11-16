// node --test            (no dependencies)
// The combined rows of the v2 Board (Marco, 13/10/2026, PR2 of the 54-row Board; lib/board-rows.js): 2 to 4 moods with equal shares, interleaved A1 B1 C1 A2 …, no film twice;
// `boost` multiplies the share of a part on a day or in a season and never decides who is IN; `tune: "taste"` weighs the shares by what Marco rates; a film is in at most two
// mood or combined rows, filters outside that ceiling; the "wicked" of the v2 Board is the combined one and the legacy "wicked" is not. Synthetic films here; the real caches are
// in test/row-filters.test.js, which builds the whole Board offline.
//
// Mutations this file is meant to turn red (recorded in the commit of 13/10/2026):
//   the places of a combined row not interleaved (the parts one after the other)        → "equal shares interleave"
//   Sunday without the boost (the weekday never matches)                                → "boost: a Sunday doubles"
//   a boost that drops its part off season (inclusion decided by the boost)             → "boost: off season the part is still in"
//   a filter row counting toward the ceiling of two rows                                → "the ceiling of two rows"
//   tune "taste" ignored                                                                → "tune taste"

const test = require("node:test");
const assert = require("node:assert/strict");

const BR = require("../lib/board-rows");
const BD = require("../lib/board");
const { compile } = require("../lib/moods");
const { buildPlan } = require("../lib/plan");
const CONFIG = require("../lib/board-shared").legacyConfig(require("../config.json")); // PR5 (14/10/2026): config.json carries the Board now; these tests lay their own fixture board on the config WITHOUT it and with the nine legacy moods

let n = 0;
/** A candidate the way build.js hands it over: the TMDB record in `film` and the z-scores. */
function cand(o = {}) {
  const id = ++n;
  const film = { id, imdb: `tt${String(id).padStart(7, "0")}`, title: `Film ${id}`, year: 1990, runtime: 100, genres: ["Drama"], keywords: [], directors: [{ id: 5000 + id, name: `Director ${id}` }], countries: ["US"], lang: "en", va: 7, vc: 100, overview: "", poster: null, ...o.film };
  return { id, film, tasteZ: 0, qualityZ: 0, contributions: [], seeds: [], pins: [], recCount: 0, ...o.cand };
}
const ranked = (cands) => cands.map((c, i) => ({ ...c, fitInfo: { norm: 1, hits: [] }, rank: 100 - i }));
const tts = (xs) => xs.map((c) => c.film.imdb);
const ids = (items) => items.map((i) => i.id);
const spec = (ids, rows = {}) => ({ entries: ids.map((id) => ({ id, name: id, place: "board" })), rows, legacyMoods: [] });
const SIZES = { discover: 100, moodRepeatWindow: 30, watchlist: 100, row: 50 };

// ── the shares and the places ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test("shares: whole numbers in proportion to the weights, summing to the size, the earlier part winning a tie", () => {
  assert.deepEqual(BR.shares([1, 1, 1], 100), [34, 33, 33]);
  assert.deepEqual(BR.shares([1, 1, 2], 100), [25, 25, 50]);
  assert.deepEqual(BR.shares([1, 1, 1, 1], 10), [3, 3, 2, 2]);
  assert.deepEqual(BR.shares([1, 1], 5), [3, 2]);
  for (const w of [[1, 2, 3], [0.37, 0.41, 0.2, 0.9], [5, 1]]) assert.equal(BR.shares(w, 100).reduce((a, b) => a + b, 0), 100, JSON.stringify(w));
});

test("weave: equal shares interleave A1 B1 C1 A2 B2 C2, a part with twice the share comes twice as often", () => {
  assert.deepEqual(BR.weave([2, 2, 2]), [0, 1, 2, 0, 1, 2]);
  assert.deepEqual(BR.weave([1, 1, 2]), [2, 0, 1, 2]);
  assert.deepEqual(BR.weave([3, 0, 1]), [0, 0, 2, 0], "a part with no share has no place; on a tie in time the earlier part goes first");
});

test("combine: equal shares interleave, the parts in the order given, and no part is finished before another starts", () => {
  const A = ranked([cand(), cand(), cand(), cand()]), B = ranked([cand(), cand(), cand(), cand()]), C = ranked([cand(), cand(), cand(), cand()]);
  const { picked, share } = BR.combine({ parts: [{ id: "a", list: A, weight: 1 }, { id: "b", list: B, weight: 1 }, { id: "c", list: C, weight: 1 }], size: 6 });
  assert.deepEqual(share, [2, 2, 2]);
  assert.deepEqual(tts(picked), [A[0], B[0], C[0], A[1], B[1], C[1]].map((c) => c.film.imdb), "A1 B1 C1 A2 B2 C2, not A1 A2 B1 B2 C1 C2");
  assert.deepEqual(picked.map((c) => c._part), ["a", "b", "c", "a", "b", "c"]);
});

test("combine: a film in two parts is in the row once, and the second part moves on to its next film", () => {
  const shared = cand();
  const A = ranked([shared, cand(), cand()]), B = ranked([{ ...shared }, cand(), cand()]);
  const { picked } = BR.combine({ parts: [{ id: "a", list: A, weight: 1 }, { id: "b", list: B, weight: 1 }], size: 4 });
  assert.equal(new Set(tts(picked)).size, 4, "four different films");
  assert.equal(tts(picked).filter((t) => t === shared.film.imdb).length, 1);
  assert.equal(picked[0]._part, "a", "the earlier part takes it");
  assert.equal(picked[1].film.imdb, B[1].film.imdb, "B passes over the film A took and goes to its second");
});

test("combine: two films by one director at most; a part that runs dry gives its places to the others, at the end", () => {
  const same = { directors: [{ id: 7, name: "One Director" }] };
  const A = ranked([cand({ film: same }), cand({ film: same }), cand({ film: same }), cand({ film: same })]);
  const B = ranked(Array.from({ length: 8 }, () => cand()));
  const { picked, short } = BR.combine({ parts: [{ id: "a", list: A, weight: 1 }, { id: "b", list: B, weight: 1 }], size: 6 });
  assert.equal(picked.filter((c) => c.film.directors[0].id === 7).length, 2, "the third and fourth film of A are refused by the director cap");
  assert.equal(picked.length, 6, "B fills the places A could not");
  assert.equal(short.a, 1, "A had three places and filled two");
  assert.deepEqual(picked.slice(-1).map((c) => c._part), ["b"], "the leftover place comes after the woven ones");
  const dry = BR.combine({ parts: [{ id: "a", list: ranked([cand()]), weight: 1 }, { id: "b", list: B, weight: 1 }], size: 6 });
  assert.equal(dry.picked.length, 6);
  assert.equal(dry.picked.filter((c) => c._part === "a").length, 1);
  assert.equal(dry.short.a, 2);
});

test("combine: accept() decides who may enter (the recommendation rule, the ceiling of two rows)", () => {
  const A = ranked([cand(), cand(), cand()]), B = ranked([cand(), cand(), cand()]);
  const refused = new Set([A[0].film.imdb, B[1].film.imdb]);
  const { picked } = BR.combine({ parts: [{ id: "a", list: A, weight: 1 }, { id: "b", list: B, weight: 1 }], size: 4, accept: (c) => !refused.has(c.film.imdb) });
  assert.ok(picked.every((c) => !refused.has(c.film.imdb)));
  assert.equal(picked.length, 4);
});

// ── boost and tune ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const PARTS = [{ id: "gentle", mood: compile([{ id: "gentle", minFit: 1 }])[0] }, { id: "lift", mood: compile([{ id: "lift", minFit: 1 }])[0] }, { id: "rainy", mood: compile([{ id: "rainy", minFit: 1 }])[0] }];
const weights = (def, today, extra = {}) => BR.partWeights(PARTS, def, { today, ...extra }).map((p) => p.weight);

test("boost: a Sunday doubles the share of the part, any other day leaves the three equal (2026-10-11 is a Sunday)", () => {
  const def = { boost: [{ part: "rainy", weekdays: [0], x: 2 }] };
  assert.deepEqual(weights(def, "2026-10-11"), [1, 1, 2]);
  assert.deepEqual(BR.shares(weights(def, "2026-10-11"), 100), [25, 25, 50]);
  assert.deepEqual(weights(def, "2026-10-12"), [1, 1, 1]);
  assert.deepEqual(BR.shares(weights(def, "2026-10-12"), 100), [34, 33, 33]);
});

test("boost: December to February doubles the part, the other months do not; both conditions given must both hold", () => {
  const def = { boost: [{ part: "rainy", months: [12, 1, 2], x: 2 }] };
  assert.deepEqual(weights(def, "2026-12-15"), [1, 1, 2]);
  assert.deepEqual(weights(def, "2027-02-01"), [1, 1, 2]);
  assert.deepEqual(weights(def, "2026-07-01"), [1, 1, 1]);
  const both = { boost: [{ part: "rainy", months: [12], weekdays: [0], x: 3 }] };
  assert.deepEqual(weights(both, "2026-12-13"), [1, 1, 3], "a Sunday of December");
  assert.deepEqual(weights(both, "2026-12-15"), [1, 1, 1], "a Tuesday of December");
  assert.deepEqual(weights(both, "2026-10-11"), [1, 1, 1], "a Sunday of October");
});

test("boost: off season the part is still in the row (a boost changes a share, it never decides who is in)", () => {
  const mk = (n) => ranked(Array.from({ length: n }, () => cand()));
  const lists = { gentle: mk(10), lift: mk(10), rainy: mk(10) };
  for (const today of ["2026-10-11", "2026-10-12"]) {
    const w = BR.partWeights(PARTS, { boost: [{ part: "rainy", weekdays: [0], x: 2 }] }, { today });
    const { picked } = BR.combine({ parts: w.map((p) => ({ id: p.id, weight: p.weight, list: lists[p.id] })), size: 12 });
    assert.ok(picked.filter((c) => c._part === "rainy").length >= 3, `${today}: rainy has a share of its own whatever the day`);
  }
});

test("tune taste: the share of a part grows with the films Marco rated 4.5 or more that fit it, (L + 1) / (R + 4)", () => {
  const fits = (g) => ({ id: g, genres: { [g]: 3 }, minFit: 2 });
  const mood = (g) => compile([fits(g)])[0];
  const parts = [{ id: "Comedy", mood: mood("Comedy") }, { id: "Horror", mood: mood("Horror") }, { id: "Western", mood: mood("Western") }];
  const rated = [];
  for (let i = 0; i < 10; i++) rated.push({ film: { imdb: `tt9${i}`, genres: ["Comedy"], keywords: [] }, rating: i < 4 ? 5 : 3 }); // 4 of 10 loved
  for (let i = 0; i < 6; i++) rated.push({ film: { imdb: `tt8${i}`, genres: ["Horror"], keywords: [] }, rating: 4 }); // 6, none at 4.5
  const w = BR.partWeights(parts, { tune: "taste" }, { today: "2026-10-13", rated });
  assert.deepEqual(w.map((p) => p.weight), [5 / 14, 1 / 10, 1 / 4], "Comedy (4+1)/(10+4), Horror (0+1)/(6+4), Western (0+1)/(0+4)");
  assert.deepEqual(BR.partWeights(parts, {}, { today: "2026-10-13", rated }).map((p) => p.weight), [1, 1, 1], "without tune every part weighs 1");
  const boosted = BR.partWeights(parts, { tune: "taste", boost: [{ part: "Horror", weekdays: [2], x: 2 }] }, { today: "2026-10-13", rated }).map((p) => p.weight);
  assert.deepEqual(boosted, [5 / 14, 2 / 10, 1 / 4], "the boost multiplies the tuned weight");
});

// ── the rows of a Board, in its order ───────────────────────────────────────────────────────────────────────────────────────────────────

const M = (id, genre) => compile([{ id, genres: { [genre]: 3 }, minFit: 2 }])[0];
const run = (cands, spec_, moods, extra = {}) => BR.buildBoardRows({ cands, moods, legacy: new Set(), ranked: {}, spec: spec_, cfg: { sizes: SIZES }, today: "2026-10-13", ...extra });

test("the ceiling of two rows: a film is in two mood or combined rows of the v2 Board and not in a third; filter rows are outside it", () => {
  // two films that fit all three moods, and four that fit only the third
  const popular = [1985, 1986].map((year, i) => cand({ film: { genres: ["Comedy", "Horror", "Western"], year }, cand: { tasteZ: 5 - i } }));
  const others = [1990, 1991, 1992, 1993].map((year) => cand({ film: { genres: ["Western"], year }, cand: { tasteZ: -5 } }));
  const moods = [M("m1", "Comedy"), M("m2", "Horror"), M("m3", "Western")];
  const filterRow = (id) => ({ id, kind: "filter", where: { years: { min: 1980, max: 1989 } } });
  // two filters first: if they counted, the two popular films would be at the ceiling before the first mood row looked at them
  const out = run([...popular, ...others], spec(["f1", "f2", "m1", "m2", "m3"], { f1: filterRow("f1"), f2: filterRow("f2") }), moods);
  const has = (row, c) => out.rows[row].some((it) => it.id === c.film.imdb);
  assert.ok(has("f1", popular[0]) && has("f2", popular[0]), "both filters list the film");
  assert.deepEqual(tts(popular), out.rows.m1.map((it) => it.id), "it is still in the first mood row: the filters did not use its places");
  assert.deepEqual(tts(popular), out.rows.m2.map((it) => it.id), "and in the second");
  assert.ok(!has("m3", popular[0]) && !has("m3", popular[1]), "but not in the third");
  assert.deepEqual(out.rows.m3.map((it) => it.id).sort(), tts(others).sort(), "which takes the films that are left");
});

test("the ceiling of two rows: only the first sizes.moodRepeatWindow films of a row count", () => {
  const cands = Array.from({ length: 6 }, (_, i) => cand({ film: { genres: ["Comedy"] }, cand: { tasteZ: 10 - i } }));
  const moods = [M("m1", "Comedy"), M("m2", "Comedy"), M("m3", "Comedy")];
  const out = run(cands, spec(["m1", "m2", "m3"]), moods, { cfg: { sizes: { ...SIZES, moodRepeatWindow: 2 } } });
  assert.equal(out.rows.m1.length, 6);
  assert.equal(out.rows.m3.length, 4, "the first two films of m1 and of m2 are at the ceiling, the other four of m1 are not counted");
  assert.ok(out.rows.m3.every((it) => !tts(cands.slice(0, 2)).includes(it.id)));
});

test("mood rows and combined rows are filled from the films the recommendation rule lets through, and a refused film takes no place", () => {
  const comedies = Array.from({ length: 130 }, (_, i) => cand({ film: { genres: ["Comedy"] }, cand: { tasteZ: 300 - i } }));
  const horrors = Array.from({ length: 130 }, (_, i) => cand({ film: { genres: ["Horror"] }, cand: { tasteZ: 300 - i } }));
  const refused = new Set([...comedies.slice(0, 10), ...horrors.slice(0, 10)].map((c) => c.film.imdb));
  const eligible = (tt) => !refused.has(tt);
  const moods = [M("lol", "Comedy"), M("scary", "Horror")];
  const out = run([...comedies, ...horrors], spec(["lol", "mix"], { mix: { id: "mix", kind: "combine", parts: ["lol", "scary"] } }), moods, { eligible });
  assert.equal(out.rows.lol.length, 100, "130 fit, 10 are refused, the row still has its 100");
  assert.ok(ids(out.rows.lol).every(eligible));
  assert.equal(out.rows.lol[0].id, comedies[10].film.imdb);
  assert.ok(ids(out.rows.mix).every(eligible) && out.rows.mix.length === 100);
});

test("the nine moods of today are not the v2 builder's: no row for a legacy id, and the v2 ceiling never reads them", () => {
  const cands = Array.from({ length: 5 }, () => cand({ film: { genres: ["Comedy"] } }));
  const legacy = compile([{ id: "lift", genres: { Comedy: 3 }, minFit: 2 }]);
  const out = BR.buildBoardRows({ cands, moods: [...legacy, M("m1", "Comedy")], legacy: new Set(["lift"]), ranked: { lift: ranked(cands) }, spec: spec(["lift", "m1"]), cfg: { sizes: SIZES }, today: "2026-10-13" });
  assert.equal(out.rows.lift, undefined, "the legacy row stands: buildPlan takes it from the legacy rows");
  assert.deepEqual(Object.keys(out.ranked), ["m1"], "only a mood the v2 family adds is ranked here");
  assert.equal(out.rows.m1.length, 5);
});

test("combined rows run in the Board's order with the ceiling, take the parts' lists as they are, and report their shares", () => {
  const comedies = Array.from({ length: 6 }, () => cand({ film: { genres: ["Comedy"] } }));
  const horrors = Array.from({ length: 6 }, () => cand({ film: { genres: ["Horror"] } }));
  const moods = [M("lol", "Comedy"), M("scary", "Horror")];
  const out = run([...comedies, ...horrors], spec(["mix"], { mix: { id: "mix", kind: "combine", parts: ["lol", "scary"] } }), moods);
  assert.equal(out.rows.mix.length, 12);
  const kinds = out.rows.mix.map((it) => (comedies.some((c) => c.film.imdb === it.id) ? "C" : "H")).join("");
  assert.equal(kinds, "CHCHCHCHCHCH", "interleaved");
  assert.match(out.report[0].note, /^lol 50 .* · scary 50 /, "the log line says how many places each part had (50 of 100) and how many it could not fill");
});

test("a combined row can be made of filters: Latin America is Brazil from 2001, Brazil to 2000 and the Spanish-speaking Americas, equal shares, interleaved", () => {
  const br = (year, n) => Array.from({ length: n }, (_, i) => cand({ film: { countries: ["BR"], lang: "pt", year: year + i } }));
  const mx = Array.from({ length: 4 }, () => cand({ film: { countries: ["MX"], lang: "es", year: 1990 } }));
  const us = cand({ film: { countries: ["US"], lang: "en", year: 1990 }, cand: { tasteZ: 99 } });
  const rows = {
    "brazil-now": { id: "brazil-now", kind: "filter", part: true, where: { countries: ["BR"], years: { min: 2001 } } },
    "brazil-classic": { id: "brazil-classic", kind: "filter", part: true, where: { countries: ["BR"], years: { max: 2000 } } },
    "latam-hisp": { id: "latam-hisp", kind: "filter", part: true, where: { region: "latam-hisp" } },
    "latin-america": { id: "latin-america", kind: "combine", parts: ["brazil-now", "brazil-classic", "latam-hisp"] },
  };
  const now = br(2005, 4), classic = br(1960, 4);
  const out = run([us, ...mx, ...classic, ...now], spec(["latin-america"], rows), []);
  const part = (it) => (now.some((c) => c.film.imdb === it.id) ? "N" : classic.some((c) => c.film.imdb === it.id) ? "C" : mx.some((c) => c.film.imdb === it.id) ? "H" : "?");
  assert.equal(out.rows["latin-america"].map(part).join(""), "NCHNCHNCHNCH", "Brazil now, Brazil before, Hispanic: A1 B1 C1 A2 B2 C2 …, and no American film");
  assert.equal(Object.keys(out.rows).join(), "latin-america", "a part is not a Board row: it has no row of its own");
  assert.match(out.report[0].note, /^brazil-now 34 .* · brazil-classic 33 .* · latam-hisp 33 /);
});

test("buildPlan: the combined 'wicked' of the v2 Board wins over the legacy 'wicked', and the legacy Board keeps its own", () => {
  const item = (id) => ({ id, tmdb: null, slug: null, title: id, year: 2000, why: [], overview: "", genres: [], directors: [] });
  const moods = compile(CONFIG.moods);
  const legacyRows = { tonight: [], wicked: [item("tt1")], lift: [], escape: [], reinvent: [], letin: [], night: [], wander: [], slow: [], music: [], directors: [], oldfriends: [], watchlist: [] };
  const board = BD.parse({ ...CONFIG, board: { order: ["wicked", "tonight"], names: { wicked: "🎃 Horror", tonight: "T" }, legacyMoods: moods.map((m) => m.id), moodMenu: ["lift"] } });
  const plan = buildPlan({ moods, rows: legacyRows, extra: { fromlists: [], short: [], newforyou: [], "friends-week": [], "directors-loved": [] }, sizes: SIZES, board, rows2: { wicked: [item("tt2"), item("tt3")] } });
  assert.deepEqual(plan.board.find((r) => r.id === "wicked").items.map((i) => i.id), ["tt1"], "the legacy family does not change");
  assert.deepEqual(plan.board2.find((r) => r.id === "wicked").items.map((i) => i.id), ["tt2", "tt3"]);
  assert.deepEqual(plan.board2.find((r) => r.id === "tonight").items, [], "a row the v2 builder did not make is the legacy list of that id");
});

// ── the recipes in the board ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("board: the recipes of moods and rows are checked before the build starts", () => {
  const FIXTURE = require("./fixtures/board-v2-pr2.json");
  const withBoard = (patch) => ({ ...CONFIG, board: { ...FIXTURE, ...patch } });
  assert.deepEqual(BD.problems(withBoard({})), [], "the PR2 fixture is a sound board");
  const spec_ = BD.parse(withBoard({}));
  assert.deepEqual(spec_.rows["after-midnight"].parts, ["night", "noir", "whodunit", "mindbender"]);
  assert.equal(spec_.moods.length, 21);
  const bad = (patch, re) => assert.throws(() => BD.parse(withBoard(patch)), re);
  const row = (r) => ({ rows: [...FIXTURE.rows.filter((x) => x.id !== r.id), r] });
  bad(row({ id: "comedy", kind: "combine", parts: ["lol"] }), /parts must be 2 to 4 mood ids/);
  bad(row({ id: "comedy", kind: "combine", parts: ["lol", "deadpan", "noir", "road", "summer"] }), /parts must be 2 to 4 mood ids/);
  bad(row({ id: "comedy", kind: "combine", parts: ["lol", "nope"] }), /part "nope" is neither a mood nor a filter with part: true/);
  bad(row({ id: "comedy", kind: "combine", parts: ["lol", "lol"] }), /parts lists a mood twice/);
  bad(row({ id: "comedy", kind: "combine", parts: ["lol", "deadpan"], tune: "mood" }), /tune must be "taste"/);
  bad(row({ id: "comedy", kind: "combine", parts: ["lol", "deadpan"], boost: [{ part: "lol", x: 2 }] }), /a boost needs months \(1-12\) or weekdays/);
  bad(row({ id: "comedy", kind: "combine", parts: ["lol", "deadpan"], boost: [{ part: "noir", weekdays: [0], x: 2 }] }), /part "noir" is not one of the parts/);
  bad(row({ id: "comedy", kind: "combine", parts: ["lol", "deadpan"], boost: [{ part: "lol", weekdays: [7], x: 2 }] }), /weekdays must be 0 \(Sunday\) to 6/);
  bad(row({ id: "comedy", kind: "combine", parts: ["lol", "deadpan"], boost: [{ part: "lol", months: [13], x: 2 }] }), /months must be 1 to 12/);
  bad(row({ id: "comedy", kind: "combine", parts: ["lol", "deadpan"], boost: [{ part: "lol", weekdays: [0], x: 0 }] }), /x must be a number above 0/);
  bad(row({ id: "comedy", kind: "combine", parts: ["lol", "deadpan"], boost: [{ part: "lol", season: [12], x: 2 }] }), /unexpected key "season" \(allowed: part, x, months, weekdays\)/);
  assert.deepEqual(BD.problems(withBoard({ rows: [...FIXTURE.rows, { id: "only-a-part", kind: "filter", part: true, where: { region: "europe" } }, { id: "mix", kind: "combine", parts: ["only-a-part", "lol"] }], order: [...FIXTURE.order, "mix"], names: { ...FIXTURE.names, mix: "Mix" } })), [], "a filter with part: true is a sound part of a combined row, outside order");
  bad({ rows: FIXTURE.rows.map((r) => (r.id === "brazil-now" ? { ...r, part: undefined } : r)) }, /"brazil-now" is not in order/);
  bad({ order: [...FIXTURE.order, "brazil-now"], names: { ...FIXTURE.names, "brazil-now": "BR now" } }, /"brazil-now" is a part of a combined row and is also in order/);
  bad(row({ id: "comedy", kind: "combine", parts: ["lol", "deadpan"], part: true }), /only a filter row can be a part/);
  bad({ rows: FIXTURE.rows.map((r) => (r.id === "brazil-now" ? { ...r, part: "yes" } : r)) }, /part must be true or absent/);
  // a recipe may not take the id of a row or a mood the build already makes (it would win in silence in plan.board2), except the combined "wicked"
  for (const id of ["watchlist", "tonight", "friends-week", "my-series", "lift", "noir", "short"]) {
    const p = BD.problems(withBoard({ rows: [...FIXTURE.rows, { id, kind: "filter", where: { region: "europe" } }], order: FIXTURE.order.includes(id) ? FIXTURE.order : [...FIXTURE.order, id], names: { ...FIXTURE.names, [id]: `X ${id}` } }));
    assert.ok(p.some((x) => x.includes(`"${id}" is already`) && x.includes("replace it in silence")), id);
  }
  assert.ok(BD.problems(withBoard({ rows: FIXTURE.rows.map((r) => (r.id === "wicked" ? { id: "wicked", kind: "filter", where: { region: "europe" } } : r)) })).some((x) => x.includes('"wicked" is already')), "wicked may be replaced only by a combined row");
  assert.deepEqual(BD.problems(withBoard({})), [], "and the fixture's combined wicked is the intentional replacement");
  bad(row({ id: "comedy", kind: "stack", parts: ["lol", "deadpan"] }), /kind must be one of filter, combine/);
  bad(row({ id: "ghost", kind: "filter", where: { region: "europe" } }), /"ghost" is not in order/);
  bad({ moods: [...FIXTURE.moods, { ...FIXTURE.moods[0] }] }, /"noir" is already a mood/);
  bad({ moods: [{ ...FIXTURE.moods[0], pins: ["tt0137863"] }, ...FIXTURE.moods.slice(1)] }, /unexpected key "pins" \(a pin would add a film to the pool of the legacy family\)/);
  bad({ moods: [{ ...FIXTURE.moods[0], id: "lift" }, ...FIXTURE.moods.slice(1)] }, /"lift" is already a mood/);
});
