// node --test            (no dependencies; reads config.json and the text of build.js, no cache)
// Marco, 14/11/2026 ("Include 4 stars"): Worth watching again (Old friends) takes the films he rated 4★ or more (config.json build.rewatchMinStars; it was 4.5 written in build.js) and has not
// logged in build.rewatchAfterDays. Since 15/11/2026 the places are reserved by rating (test/rewatch-shares.test.js); until then the order alone gave 4★ films 0 of 100 places.
// Mutations: test-support/lugares-mutacoes.js rewatch.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { buildRows } = require("../lib/rows");

const ROOT = path.join(__dirname, "..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const src = fs.readFileSync(path.join(ROOT, "build.js"), "utf8");

test("config.json build.rewatchMinStars is 4", () => {
  assert.equal(cfg.build.rewatchMinStars, 4);
});

test("build.js filters Worth watching again by the config's number, not a number of its own", () => {
  assert.match(src, /const REWATCH_MIN = rewatchMinStars\(cfg\);/);
  assert.match(src, /\.filter\(\(f\) => f\.film\?\.imdb && !excluded\.has\(f\.film\.imdb\) && f\.rating >= REWATCH_MIN\)/);
  assert.ok(!/excluded\.has\(f\.film\.imdb\) && f\.rating >= 4\.5\)/.test(src), "the 4.5 of before is gone");
});

// the function as build.js has it (build.js is a script: it runs when required)
const body = /function rewatchMinStars\(cfg\) \{[\s\S]*?\n\}\n/.exec(src);
const rewatchMinStars = body && new Function(`${body[0]}; return rewatchMinStars;`)();

test("rewatchMinStars: absent is 4 (the decision, not the number of before); 4.5 is read; anything that is not a number from 0.5 to 5 stops the build", () => {
  assert.ok(rewatchMinStars, "the function is in build.js");
  assert.equal(rewatchMinStars({ build: {} }), 4);
  assert.equal(rewatchMinStars({}), 4);
  assert.equal(rewatchMinStars({ build: { rewatchMinStars: 4.5 } }), 4.5);
  for (const bad of ["4", 0, 0.4, 5.5, NaN, null]) assert.throws(() => rewatchMinStars({ build: { rewatchMinStars: bad } }), /rewatchMinStars/, String(bad));
});

test("with the places reserved by rating (15/11/2026, test/rewatch-shares.test.js) a 4★ film enters even when 5★ films could fill the row", () => {
  const film = (n) => ({ id: n, imdb: `tt${5000000 + n}`, title: `F${n}`, year: 2000, genres: [], keywords: [], directors: [], cast: [], countries: [] });
  const rewatch = [...Array.from({ length: 10 }, (_, i) => ({ film: film(i), rating: 5, lastSeen: "2020-01-01" })), ...Array.from({ length: 10 }, (_, i) => ({ film: film(100 + i), rating: 4, lastSeen: "2020-01-01" }))];
  const sizes = { tonight: 0, discover: 100, row: 50, because: 20, directors: 24, oldFriends: 10, watchlist: 100 };
  const row = buildRows({ pool: [], rewatch, moods: [], cfg: { sizes, build: { directors: 15 } }, model: { stats: new Map() }, recentSeeds: [], today: "2026-11-14" }).rows.oldfriends;
  assert.equal(row.length, 10);
  assert.equal(row.filter((it) => it.why[0] === "you gave it 4★").length, 6, "10 places: 4 / 4 / 2; the 4.5★ group is empty and its 4 go below, to the 4★");
});

test("build.js's `rewatch` statement, run on a small history: 4★ and 5★ films unseen for two years are in, 3.5★, a recent one and an excluded one are out (a behaviour check)", () => {
  const m = /\n\s*const rewatch = (all[\s\S]*?);\n/.exec(src);
  assert.ok(m, "the statement is in build.js");
  const f = (n, rating, lastWatched) => ({ film: { imdb: `tt${n}` }, rating, lastWatched });
  const all = [f(1, 5, "2020-01-01"), f(2, 4, "2020-01-01"), f(3, 3.5, "2020-01-01"), f(4, 4, "2026-11-01"), f(5, 4.5, "2019-01-01"), f(6, 4, null)];
  const run = new Function("all", "excluded", "REWATCH_MIN", "daysAgo", "cfg", `return (${m[1]});`);
  const out = run(all, new Set(["tt5"]), 4, () => "2024-11-14", { build: { rewatchAfterDays: 730 } }).map((r) => r.film.imdb);
  assert.deepEqual(out, ["tt1", "tt2", "tt6"]);
});
