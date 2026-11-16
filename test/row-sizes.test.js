// node --test
// Marco, 14/11/2026 ("Up to 100 in every row"): sizes.row, because, directors, oldFriends, friends 100, Friend's top picks and Loved by your directors 100; the Discover caps stay (below).
// Marco, 13/10/2026: the sizes of the rows. sizes.discover 60 → 100 (the mood rows and the Discover mood catalog ONLY: the decade/runtime/country/rating cuts and
// the Loved by directors menu have their own sizes.cuts, kept at 60), sizes.row 30 → 50 (from your lists, friends watched this week, short, new for you;
// Loved by your directors stays at 30, directorsLoved.size), sizes.friends 30 → 50 (friends loved), sizes.watchlist 40 → 100. The Worker serves 100 per page (worker/src/catalogs.js PAGE), so none may pass 100.
// sizes.row used to be ALSO the number of places of a mood row that count toward "a film is in at most 2 mood rows" (lib/rows.js): that window is now
// sizes.moodRepeatWindow, and raising sizes.row must not move it.

const test = require("node:test");
const os = require("os");
const { spawnSync } = require("child_process");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { buildRows } = require("../lib/rows");
const { compile } = require("../lib/moods");

const ROOT = path.join(__dirname, "..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));

test("config.json sizes: the new row sizes are fixed here, the others did not move, and none that a Worker page serves passes 100", () => {
  const page = Number(/export const PAGE = (\d+);/.exec(fs.readFileSync(path.join(ROOT, "worker", "src", "catalogs.js"), "utf8"))[1]);
  assert.equal(page, 100);
  // Marco, 14/11/2026 ("Up to 100 in every row"): row, because, directors, oldFriends and friends 100 (they were 50, 20, 24, 24, 50); tonight 10, the Discover caps (cuts, friendsDiscover 60), lists and discover unchanged
  // Marco, 15/11/2026 (questionnaire, Discover: "Yes, Discover to 100 too"): cuts and friendsDiscover 60 -> 100
  assert.deepEqual(cfg.sizes, { tonight: 10, row: 100, discover: 100, cuts: 100, moodRepeatWindow: 30, because: 100, directors: 100, oldFriends: 100, watchlist: 100, friends: 100, friendsDiscover: 100, lists: 300 });
  assert.equal(cfg.directorsLoved.size, 100, "Loved by your directors, a Board row (30 by default, lib/directors-loved.js)");
  assert.equal(cfg.board.rows.find((r) => r.id === "top-picks").size, 100, "Friend's top picks (60 until 14/11/2026)");
  // `lists` (300) is the whole list, read by pages with skip; every other size is a row or a menu option the Worker serves in one page
  for (const [k, v] of Object.entries(cfg.sizes)) if (k !== "lists") assert.ok(v <= page, `sizes.${k} ${v} is over the ${page} of a page`);
});

// three moods that fit the same 120 films in the same order: the second and third rows compete for the films the first already took
const moods = compile(["a", "b", "c"].map((id) => ({ id, name: id, word: id, genres: { G: 2 }, keywords: {}, minFit: 1 })));
const pool = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, film: { id: i + 1, imdb: "tt" + (2000 + i + 1), title: "F" + i, year: 2000, genres: ["G"], keywords: [], directors: [{ id: i + 1, name: "D" + i }], cast: [], countries: [], va: 7, vc: 500, overview: "" },
  tasteZ: 5 - i * 0.03, qualityZ: 0, recCount: 0, seeds: [], pins: [], contributions: [] }));
const rowsOf = (sizes) => buildRows({ pool, rewatch: [], moods, cfg: { sizes: { tonight: 3, because: 20, directors: 24, oldFriends: 24, watchlist: 100, discover: 100, ...sizes }, build: { directors: 15 } }, model: { stats: new Map() }, recentSeeds: [], today: "2026-10-13" }).rows;
const ids = (r) => r.map((x) => x.id);

test("the 2-mood-rows cap counts the first 30 places of a mood row, and raising sizes.row does not move it", () => {
  const before = rowsOf({ row: 30, moodRepeatWindow: 30 }), after = rowsOf({ row: 50, moodRepeatWindow: 30 });
  assert.equal(after.a.length, 100, "sizes.discover 100: the mood row holds a hundred");
  for (const m of ["a", "b", "c"]) assert.deepEqual(ids(after[m]), ids(before[m]), `mood ${m}`);
  // what the cap does here: a and b took the top 30 twice, so c skips them and starts at the 31st film
  assert.equal(after.c[0].id, "tt2031");
  assert.deepEqual(ids(after.a).slice(0, 2), ["tt2001", "tt2002"]);
});

test("control: with a window of 50 the third row starts at the 51st film, so the check above would see the cap move", () => {
  assert.equal(rowsOf({ row: 50, moodRepeatWindow: 50 }).c[0].id, "tt2051");
});

test("a config without sizes.moodRepeatWindow (the older fixtures) keeps reading sizes.row", () => {
  assert.equal(rowsOf({ row: 30 }).c[0].id, "tt2031");
  assert.equal(rowsOf({ row: 40 }).c[0].id, "tt2041");
});

const have = ["friends.json", "lists.json", "tmdb.json", "imdb-ratings.json"].every((f) => fs.existsSync(path.join(ROOT, "cache", f)));

test("build --cache-only: the mood catalog goes past 60 films, the cuts and the Loved by directors menu stop at 100 (sizes.cuts, 60 until 15/11/2026), Loved by your directors goes past 30 and stops at 100 (needs the caches)", { skip: !have && "no caches", timeout: 300000 }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "mood-sz-")), cache = fs.mkdtempSync(path.join(os.tmpdir(), "mood-sz-cache-"));
  for (const f of ["friends.json", "lists.json", "tmdb.json", "directors.json", "imdb-ratings.json"]) fs.copyFileSync(path.join(ROOT, "cache", f), path.join(cache, f));
  try {
    const r = require("child_process").spawnSync(process.execPath, ["build.js", "--offline", "--cache-only", "--cache-dir", cache, "--out", out], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "", MOOD_DATE: "2026-10-13" } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const max = (dir) => Math.max(...fs.readdirSync(path.join(out, "catalog", "movie", dir)).map((f) => JSON.parse(fs.readFileSync(path.join(out, "catalog", "movie", dir, f), "utf8")).metas.length));
    assert.ok(max("mood-engine") > 60 && max("mood-engine") <= 100, `mood catalog ${max("mood-engine")}`);
    for (const dir of ["mood-engine-decade", "mood-engine-runtime", "mood-engine-country", "mood-engine-rating", "mood-engine-directors-loved"]) assert.ok(max(dir) <= 100, `${dir} ${max(dir)}`);
    assert.ok(max("mood-engine-decade") > 60, `and the decade cut goes past the 60 of before (${max("mood-engine-decade")})`);
    const row = JSON.parse(fs.readFileSync(path.join(out, "catalog", "movie", "directors-loved.json"), "utf8")).metas.length;
    assert.ok(row > 30 && row <= 100, `Loved by your directors ${row} (30 until 14/11/2026, config.json directorsLoved.size 100)`);
  } finally { fs.rmSync(out, { recursive: true, force: true }); fs.rmSync(cache, { recursive: true, force: true }); }
});

// Marco, 14/11/2026 ("Up to 100 in every row"): Friends loved is a Board row and takes sizes.friends (100); the friends' Discover collections keep the Discover cap, sizes.friendsDiscover (60).
// Until then the love row was cut at friendsDiscover too, so raising sizes.friends alone left it at 60 (measured on the offline build of 14/11/2026: 59 films with friends 100).
test("Friends loved takes sizes.friends, a friend's Top collection sizes.friendsDiscover", () => {
  const { buildFriendRows } = require("../lib/rows");
  const n = 6, slug = (i) => `f-${i}`;
  const films = Object.fromEntries(Array.from({ length: n }, (_, i) => [slug(i), { imdbId: `tt${4000000 + i}`, title: `F${i}`, year: 2000, r: 4 }]));
  const person = (user) => ({ user, name: user, films: new Map(Array.from({ length: n }, (_, i) => [slug(i), { slug: slug(i), title: `F${i}`, year: 2000, rating: 5, order: i, watched: null }])), watchlist: new Map() });
  const view = { users: [person("ann")], crowd: [person("ann"), person("bob")], films, lists: [] };
  const out = buildFriendRows({ view, cfg: { sizes: { friends: 4, friendsDiscover: 2 } }, isSeen: () => false, onMyWatchlist: () => false });
  assert.equal(out.rows["friends-love"].length, 4);
  assert.equal(out.rows["friends-top-ann"].length, 2);
  assert.equal(buildFriendRows({ view, cfg: { sizes: { friendsDiscover: 2 } }, isSeen: () => false, onMyWatchlist: () => false }).rows["friends-love"].length, 2, "a config without sizes.friends: the cap of before");
});
