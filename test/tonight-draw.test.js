// node --test            (no dependencies)
// Marco, 19/10/2026 (questionnaire): Tonight draws EVENLY among the top films of each mood. Until then the first pass was `top[floor(rand() ** 1.6 * top.length)]`, which put a
// mood's #1 in Tonight about one day in four (0.0833 ** (1 / 1.6) = 21%) and the twelfth about one in nineteen. The exponent is config.json tonight.bias, 1 in production.
// Marco, 14/11/2026 (questionnaire, "Bigger pool + 30 days without repeating"): the draw is over the top 40 (config.json tonight.depth), not the top 12. The tests of the even draw below
// say `depth: 12` where they measure the twelve places of the 19/10 rule (the knob reproduces it); the 40 and the memory of 30 days are in test/tonight-memory.test.js.
//
// Mutations this file is meant to turn red (recorded in the commit): the exponent back to 1.6 in lib/rows.js; tonight.depth not read (a constant instead); tonight.bias
// not read (a constant instead); tonightBias accepting 0, a negative number, NaN, a string or Infinity; config.json tonight.bias not 1; the first pass drawing a second
// time (a changed number of rand() calls: the order of Old friends, drawn after Tonight, moves).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { buildRows, tonightBias } = require("../lib/rows");
const { compile } = require("../lib/moods");
const { legacyConfig } = require("../lib/board-shared");

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));

// nine moods, 14 films each (two more than the twelve of tonight.depth 12), every film in the genre of one mood only; a film's rank in its mood is its place j = 0..13
const MOOD_IDS = ["lift", "escape", "reinvent", "letin", "night", "wicked", "wander", "slow", "music"];
const moods = compile(MOOD_IDS.map((id, i) => ({ id, name: id.toUpperCase(), word: id, genres: { ["G" + i]: 2 }, keywords: {}, minFit: 1 })));
let n = 0;
const pool = MOOD_IDS.flatMap((id, i) => Array.from({ length: 14 }, (_, j) => {
  const k = ++n;
  return { id: k, film: { id: k, imdb: "tt" + (1000 + k), title: "F" + k, year: 2000, genres: ["G" + i], keywords: [], directors: [{ id: k, name: "D" + k }], cast: [], countries: [], va: 7, vc: 500, overview: "" },
    tasteZ: 3 - j * 0.1 + i * 0.01, qualityZ: 0, recCount: 0, seeds: [], pins: [], contributions: [] };
}));
const rankOf = (it) => (Number(it.id.slice(2)) - 1001) % 14; // 0 = the mood's best film
const SIZES = { tonight: 9, row: 30, discover: 60, because: 20, directors: 24, oldFriends: 24, watchlist: 40 };
const build = (today, extra = {}, o = {}) => buildRows({ pool, rewatch: [], moods, cfg: { sizes: SIZES, build: { directors: 15 }, ...extra }, model: { stats: new Map() }, recentSeeds: [], today, ...o }).rows;

// 360 consecutive days from 2026-01-01 (the seed is the date, so this is the same every run)
const DAYS = Array.from({ length: 360 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
/** how many days the first pass of a config with tonight = { depth: 12, ...tonight } took each place j = 0..13 of the mood "lift" (every mood has exactly one first-pass pick) */
function liftRanks(tonight = {}) {
  const count = Array(14).fill(0);
  for (const day of DAYS) {
    const lift = build(day, { tonight: { depth: 12, ...tonight } }).tonight.filter((it) => it.genres[0] === "G0");
    assert.equal(lift.length, 1, `${day}: nine moods, nine places: one film of lift`);
    count[rankOf(lift[0])]++;
  }
  return count;
}

test("Tonight's first pass draws evenly among the top `depth`: with tonight.depth 12, over 360 days each of the twelve places is the pick between 12 and 52 times (30 expected), the 13th and 14th never", () => {
  const count = liftRanks(); // a config without tonight.bias: uniform
  assert.equal(count.reduce((a, b) => a + b, 0), 360);
  for (let j = 0; j < 12; j++) assert.ok(count[j] >= 12 && count[j] <= 52, `place ${j + 1}: ${count[j]} days of 360 (${count.join(" ")})`);
  assert.deepEqual(count.slice(12), [0, 0], `places 13 and 14 are outside the twelve: ${count.join(" ")}`);
  // the lean of the 1.6 draw would put the #1 on ~76 days and the twelfth on ~19: the bound above is what tells them apart
  assert.ok(count[0] < 52 && count[11] >= 12);
});

test("tonight.bias 1 is the same as no key; 1.6 is the old lean (the #1 about one day in four, which the uniform draw never reaches); both come from the one knob", () => {
  for (const day of DAYS.slice(0, 40)) assert.deepEqual(build(day, { tonight: { bias: 1 } }).tonight.map((x) => x.id), build(day).tonight.map((x) => x.id), day);
  const old = liftRanks({ bias: 1.6 });
  assert.ok(old[0] >= 60, `bias 1.6: the best film ${old[0]} days of 360 (expected ~76): ${old.join(" ")}`);
  assert.ok(liftRanks({ bias: 1 })[0] <= 52);
});

test("the draw takes the same number of rand() calls at any bias: the order of Old friends (drawn after Tonight) and of every other row is the same at bias 1 and 1.6", () => {
  const rewatch = Array.from({ length: 30 }, (_, i) => ({ film: { id: 5000 + i, imdb: "tt" + (5000 + i), title: "R" + i, year: 1990, genres: ["G0"], directors: [], cast: [], countries: [] }, rating: 4 + (i % 3) * 0.5, liked: i % 2 === 0, lastSeen: "2020-01-01" }));
  for (const day of DAYS.slice(0, 12)) {
    const a = build(day, { tonight: { bias: 1 } }, { rewatch }), b = build(day, { tonight: { bias: 1.6 } }, { rewatch });
    assert.deepEqual(a.oldfriends.map((x) => x.id), b.oldfriends.map((x) => x.id), `${day}: Old friends`);
    assert.equal(new Set(a.oldfriends.map((x) => x.id)).size, 24);
    for (const id of Object.keys(a)) if (id !== "tonight") assert.deepEqual(a[id].map((x) => x.id), b[id].map((x) => x.id), `${day}: ${id}`);
  }
  // the control: the rows above are not all the same by accident — Tonight itself does change with the bias on some of these days
  assert.ok(DAYS.slice(0, 12).some((day) => build(day, { tonight: { bias: 1 } }).tonight.map((x) => x.id).join() !== build(day, { tonight: { bias: 1.6 } }).tonight.map((x) => x.id).join()));
});

test("the later passes are not drawn: the tenth film is the best one left of the first mood in the day's sequence, at any bias", () => {
  for (const bias of [1, 1.6]) for (const day of DAYS.slice(0, 20)) {
    const t10 = build(day, { tonight: { bias }, sizes: { ...SIZES, tonight: 10 } }).tonight;
    assert.equal(t10.length, 10);
    const first = t10[0].genres[0]; // the first mood of the day's sequence
    const best = pool.filter((c) => c.film.genres[0] === first).sort((a, b) => b.tasteZ - a.tasteZ).map((c) => c.film.imdb);
    assert.equal(t10[9].id, best.find((id) => id !== t10[0].id), `${day} bias ${bias}`);
  }
});

test("tonight.bias must be a positive number: 0, a negative number, NaN, Infinity, a string, null and an object stop the build with the value in the message", () => {
  for (const bad of [0, -1, -0.5, NaN, Infinity, "1", null, {}, true]) {
    assert.throws(() => tonightBias({ tonight: { bias: bad } }), /tonight\.bias must be a positive number/, JSON.stringify(bad));
    assert.throws(() => build("2026-10-20", { tonight: { bias: bad } }), /tonight\.bias must be a positive number/, "buildRows: " + JSON.stringify(bad));
  }
  for (const good of [1, 1.6, 0.5, 2]) assert.equal(tonightBias({ tonight: { bias: good } }), good);
  assert.throws(() => tonightBias({ tonight: { bias: 0 } }), /a uniform draw over the top films of each mood/, "the message no longer says twelve");
  assert.equal(tonightBias({}), 1, "a config without the key: uniform, not the old 1.6");
  assert.equal(tonightBias({ tonight: {} }), 1);
});

test("config.json: tonight.bias is 1 in production, and the legacy family's config keeps it (build.js hands cfg and legacyConfig(cfg) to buildRows)", () => {
  assert.equal(CONFIG.tonight.bias, 1);
  assert.equal(tonightBias(CONFIG), 1);
  assert.equal(legacyConfig(CONFIG).tonight.bias, 1);
});
