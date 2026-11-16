// node --test            (no dependencies; no cache read)
// Marco, 15/11/2026 (questionnaire, Worth watching again: "Reserve places by rating"): of the 100 places, 40 go to 5★ films, 35 to 4.5★ and 25 to 4★ (config.json build.rewatchShares), drawn
// inside each group as before (rating + 0.25 if liked + a draw of at most 0.9). A group with fewer films than its places gives the rest to the group just below, then to the ones above (the
// session's rule). lib/rows.js oldFriendsPicks. Mutations: test-support/lugares-mutacoes.js rewatch.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { oldFriendsPicks, rewatchShares, REWATCH_SHARES, buildRows } = require("../lib/rows");
const { seeded } = require("../lib/util");

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));
let n = 0;
const films = (rating, count) => Array.from({ length: count }, () => ({ id: ++n, rating, liked: false }));
const world = (a, b, c) => [...films(5, a), ...films(4.5, b), ...films(4, c)];
const tally = (row) => [5, 4.5, 4].map((s) => row.filter((x) => x.r.rating === s).length);
const pick = (list, size = 100, date = "2026-11-15") => oldFriendsPicks(list, { size, shares: rewatchShares(cfg), rand: seeded(date) });

test("config.json build.rewatchShares: 40 at 5★, 35 at 4.5★, 25 at 4★, the number in one place; a config without it gets the same", () => {
  assert.deepEqual(cfg.build.rewatchShares, [{ stars: 5, places: 40 }, { stars: 4.5, places: 35 }, { stars: 4, places: 25 }]);
  assert.deepEqual(rewatchShares({ build: {} }), REWATCH_SHARES);
  assert.deepEqual(REWATCH_SHARES, cfg.build.rewatchShares);
  for (const bad of [[], [{ stars: 4, places: 10 }, { stars: 5, places: 10 }], [{ stars: 5, places: 2.5 }], "40"]) assert.throws(() => rewatchShares({ build: { rewatchShares: bad } }), /rewatchShares/);
});

test("every group full: 40 / 35 / 25 on any day, no film twice, the row ordered by the key", () => {
  const list = world(90, 173, 226); // the counts of the offline build of 14/11/2026
  for (const date of ["2026-11-15", "2026-11-16", "2026-12-24"]) {
    const row = pick(list, 100, date);
    assert.deepEqual(tally(row), [40, 35, 25], date);
    assert.equal(new Set(row.map((x) => x.r.id)).size, 100);
    assert.ok(row.every((x, i) => i === 0 || row[i - 1].k >= x.k));
  }
});

test("a group short of films: the rest goes to the group just below, then to the next below, then up", () => {
  assert.deepEqual(tally(pick(world(10, 50, 50))), [10, 50, 40], "5★ short by 30: 4.5★ takes 15 (all it has), 4★ the other 15");
  assert.deepEqual(tally(pick(world(50, 5, 50))), [45, 5, 50], "4.5★ short by 30: 4★ takes 25 (all it has), then 5★ the other 5");
  assert.deepEqual(tally(pick(world(50, 50, 5))), [45, 50, 5], "4★ short by 20: no group below, 4.5★ takes 15, then 5★ 5");
  assert.deepEqual(tally(pick(world(3, 4, 5))), [3, 4, 5], "fewer films than places: all of them, once");
});

test("a rating between two shares falls in the lower one (the export has none: 5, 4.5 and 4 only)", () => {
  const row = oldFriendsPicks([{ id: "b", rating: 4.25 }, ...films(4.5, 5)], { size: 1, shares: [{ stars: 5, places: 0 }, { stars: 4.5, places: 0 }, { stars: 4, places: 1 }], rand: () => 0 });
  assert.equal(row[0].r.id, "b", "4.25 is in the 4★ group and takes its one place (in the 4.5 group it would lose to the 4.5★ films)");
  const groups = oldFriendsPicks([{ id: "a", rating: 4.75 }], { size: 1, shares: [{ stars: 5, places: 0 }, { stars: 4.5, places: 1 }], rand: () => 0 });
  assert.equal(groups[0].r.id, "a", "4.75 is in the 4.5 group: the 5★ group has no place, the 4.5 group takes it");
});

test("the draw stays under one star: in the row every 4★ film comes after every 5★ film, whatever the day", () => {
  const list = world(90, 173, 226);
  for (const date of ["2026-11-15", "2026-11-20", "2026-12-01", "2027-01-01", "2027-02-14"]) {
    const row = pick(list, 100, date);
    const lastFive = row.map((x) => x.r.rating).lastIndexOf(5), firstFour = row.map((x) => x.r.rating).indexOf(4);
    assert.ok(firstFour > lastFive, `${date}: a 4★ film at ${firstFour} before a 5★ film at ${lastFive}`);
  }
});

test("a row of another size takes the shares in proportion (10 places: 4 / 4 / 2)", () => {
  assert.deepEqual(tally(pick(world(50, 50, 50), 10)), [4, 4, 2]);
});

test("one rand() per film, in the list's order, whatever the groups: the draws after the row do not move", () => {
  let calls = 0;
  oldFriendsPicks(world(5, 5, 5), { size: 6, rand: () => { calls++; return 0.5; } });
  assert.equal(calls, 15);
});

test("buildRows: Worth watching again has the three groups of the config", () => {
  const f = (i, rating) => ({ film: { id: i, imdb: `tt${6000000 + i}`, title: `F${i}`, year: 2000, genres: [], keywords: [], directors: [], cast: [], countries: [] }, rating, lastSeen: "2020-01-01" });
  const rewatch = [...Array.from({ length: 60 }, (_, i) => f(i, 5)), ...Array.from({ length: 60 }, (_, i) => f(100 + i, 4.5)), ...Array.from({ length: 60 }, (_, i) => f(200 + i, 4))];
  const row = buildRows({ pool: [], rewatch, moods: [], cfg: { sizes: { tonight: 0, discover: 100, row: 50, because: 20, directors: 24, oldFriends: 100, watchlist: 100 }, build: { directors: 15, rewatchShares: cfg.build.rewatchShares } }, model: { stats: new Map() }, recentSeeds: [], today: "2026-11-15" }).rows.oldfriends;
  assert.deepEqual(["5★", "4.5★", "4★"].map((s) => row.filter((it) => it.why[0] === `you gave it ${s}`).length), [40, 35, 25]);
});
