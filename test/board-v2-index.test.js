// node --test            (no dependencies)
// The v2 index family (Marco, 13/10/2026: the 54-row Board, PR1): lib/board.js validates config.json "board", buildPlan puts plan.board2 NEXT TO plan.board,
// buildIndex({ v2 }) builds the second index, writeIndex writes index-v2*.json next to the legacy files, verify.js and lib/learning/public.js accept them.
// The fixture is test/fixtures/board-v2.json: six rows that exist today, in another order and under new names, friends-week as a menu row, a Moods menu of three moods.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BD = require("../lib/board");
const { buildIndex, writeIndex, pieces2 } = require("../lib/index-export");
const { buildPlan, guardRows, boardRows } = require("../lib/plan");
const { planItems, attachRatings } = require("../lib/crowd");
const { decode } = require("../lib/index-rows");
const { compile } = require("../lib/moods");
const { findLeaks } = require("../lib/guard");
const Q = require("../lib/recommendation-quality");
const EX = require("../lib/exclude");
const PUB = require("../lib/learning/public");
const { verifyIndex } = require("../verify");
const { spawnSync } = require("child_process");
const vm = require("node:vm");
const crypto = require("node:crypto");
const PO = require("../lib/posters");
const { withV2Films } = require("../lib/index-export");
const { validateIndex } = require("../lib/index-validation");

const CONFIG = require("../lib/board-shared").legacyConfig(require("../config.json")); // PR5 (14/10/2026): config.json carries the Board now; these tests lay their own fixture board on the config WITHOUT it and with the nine legacy moods
const FIXTURE = require("./fixtures/board-v2.json");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mood-board-v2-"));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const item = (id, title) => ({ id, tmdb: null, slug: null, title, year: 2000, why: ["row text"], overview: "", genres: [], directors: [] });
const A = item("tt0000001", "Alpha"), B = item("tt0000002", "Beta"), C = item("tt0000003", "Gamma"), D = item("tt0000004", "Delta"), E = item("tt0000005", "Epsilon"), F = item("tt0000006", "Zeta");
const MOODS = compile(CONFIG.moods.filter((m) => ["lift", "escape", "slow"].includes(m.id)));
const fit = (film, norm, rank) => ({ film: { imdb: film.id }, fitInfo: { norm }, rank });
// who fits which mood: the slices of the mood files must hold exactly these
const RANKED = { escape: [fit(A, 0.9, 3), fit(C, 0.8, 2)], slow: [fit(D, 0.7, 1)], lift: [fit(A, 0.6, 0.5)] };
const ROWS = { tonight: [A, B], escape: [A, C], slow: [D], lift: [A], directors: [], oldfriends: [], watchlist: [] };
const EXTRA = { fromlists: [], short: [E], newforyou: [F], "friends-week": [B, F], "directors-loved": [] };
const SIZES = { row: 30, friends: 30, discover: 60 };
const withBoard = (patch) => ({ ...CONFIG, board: { ...FIXTURE, ...patch } });

// the frozen country menu of the small world: the countries its one film carries (the real fixture's ten are checked by the build over the real caches)
const V2_BOARD = { ...FIXTURE, countries: ["Japan", "Spain", "Brazil"] };
const VIEW = { users: [], films: { alpha: { slug: "alpha", title: "Alpha", year: 1999, imdbId: "tt0000001", c: ["Japan", "Spain", "Brazil"] } } };

/** The legacy index and the v2 index of one small world, the way build.js makes them. */
function world(board = V2_BOARD) {
  const cfg = { ...CONFIG, board };
  const spec = BD.parse(cfg);
  const plan = buildPlan({ moods: MOODS, rows: ROWS, extra: EXTRA, sizes: SIZES, board: spec });
  const base = { cfg, view: VIEW, today: "2026-10-10", builtAt: "2026-10-10T12:00:00.000Z", moods: MOODS, ranked: RANKED, quality: { eligible: () => true, minStars: 3.5 } };
  const menu = BD.menuFor(spec, MOODS);
  const ix = buildIndex({ ...base, plan });
  const ix2 = buildIndex({ ...base, plan: { board: plan.board2, discover: plan.discover }, moods: menu.moods, v2: { menu: menu.menu, countries: spec.countries } });
  return { spec, plan, ix, ix2, menu, base };
}
const ids = (xs) => xs.map((f) => f.tt || f.id).sort();
const tts = (piece) => ids(piece.films);

test("board: the fixture is a sound board for config.json, and parse() gives the Board in the order of `order`, under `names`, with place and the Moods menu", () => {
  const spec = BD.parse(withBoard({}));
  assert.deepEqual(spec.entries, [
    { id: "short", name: "⏱️ Under 95 minutes", place: "board" },
    { id: "tonight", name: "🎯 Tonight: 10 picks", place: "board" },
    { id: "escape", name: "🎳 Fun and adventure", place: "board" },
    { id: "friends-week", name: "👥 Friends watched this week", place: "menu" },
    { id: "newforyou", name: "🆕 New releases for you", place: "board" },
    { id: "directors", name: "🎬 From directors you love", place: "board" },
  ], "the order of `order` (the fixture lists `names` alphabetically, so the order cannot come from there)");
  assert.deepEqual(spec.menu, [{ id: "escape", mood: true }, { id: "slow", mood: true }, { id: "lift", mood: true }, { id: "friends-week", mood: false, label: "Friends this week" }]);
  assert.equal(BD.parse(CONFIG), null, "a config with no board: nothing changes");
});

test("board: a board the build cannot honour stops it, naming the problem", () => {
  const bad = (patch, re) => assert.throws(() => BD.parse(withBoard(patch)), re);
  const names = FIXTURE.names;
  bad({ order: [...FIXTURE.order, "nope"], names: { ...names, nope: "Nope" } }, /order: "nope" is not a row the build can make/); // an id that no row has would publish an empty row under a name Stremio installs
  bad({ order: ["short", "short"], names: { short: "S" }, moodMenu: ["escape"], place: {}, menuLabels: {} }, /order lists "short" twice/);
  bad({ order: ["Short"], names: { Short: "S" }, place: {}, moodMenu: ["escape"], menuLabels: {} }, /"Short" is not a row id/);
  bad({ names: Object.fromEntries(Object.entries(names).filter(([k]) => k !== "short")) }, /names: "short" has no name/);
  bad({ names: { ...names, tonight: " padded " } }, /names: "tonight" has no name/);
  bad({ names: { ...names, ghost: "Ghost" } }, /names: "ghost" is not in order/);
  bad({ place: { "friends-week": "menus" } }, /place: "friends-week" is "menus", expected "fixed" or "menu"/);
  bad({ place: { ghost: "menu" } }, /place: "ghost" is not in order/);
  bad({ legacyMoods: ["lift", "nope"] }, /legacyMoods: "nope" is not a mood of config.json/);
  bad({ moodMenu: ["escape", "tonight", "friends-week"] }, /moodMenu: "tonight" is neither a mood of config.json nor a row of order with place "menu"/);
  bad({ moodMenu: ["escape", "escape", "friends-week"] }, /moodMenu lists "escape" twice/);
  bad({ moodMenu: ["escape"] }, /place: "friends-week" is a menu row and is not in moodMenu/);
  bad({ menuLabels: {} }, /menuLabels: "friends-week" is in moodMenu and is not a mood, so it needs a label/);
  bad({ tonightMoods: ["night"], legacyMoods: ["lift"], moodMenu: ["lift", "friends-week"] }, /tonightMoods: "night" is not in legacyMoods/);
  bad({ countries: ["France", "France"] }, /countries lists a country twice/);
  bad({ bogus: 1 }, /unexpected key "bogus"/);
  assert.throws(() => BD.parse({ ...CONFIG, board: [] }), /board must be an object/);
});

test("v2 index: the Board is in the order of config.json, under its names, each row with its place; the legacy index keeps today's Board and carries no place", () => {
  const { ix, ix2, spec } = world();
  assert.deepEqual(ix2.board, spec.entries);
  assert.deepEqual(Object.keys(ix2.rows), FIXTURE.order);
  assert.deepEqual(ix2.board.map((r) => r.place), ["board", "board", "board", "menu", "board", "board"]);
  assert.equal(ix2.board.find((r) => r.id === "friends-week").place, "menu", "friends-week is a Moods option, not a catalog of the manifest");
  assert.deepEqual(ix2.rows.tonight, ["tt0000001", "tt0000002"]);
  assert.deepEqual(ix2.rows["friends-week"], ["tt0000002", "tt0000006"], "a menu row keeps its films: its file serves the Moods menu");
  assert.ok(ix2.rowDesc.tonight.every((t) => typeof t === "string") && ix2.rowDesc.tonight.length === 2);
  assert.deepEqual(ix2.moodMenu, [{ id: "escape", label: "Escape" }, { id: "slow", label: "Slow" }, { id: "lift", label: "Uplift" }, { id: "friends-week", label: "Friends this week" }]);
  assert.deepEqual(ix2.moods.map((m) => m.id), ["escape", "slow", "lift"], "the moods are the menu's, in the menu's order");
  assert.deepEqual(ix2.meta.countriesAll, V2_BOARD.countries);
  // the legacy family: the Board of today, and nothing of the v2 vocabulary
  assert.equal(ix.board[0].id, "tonight");
  assert.ok(ix.board.every((r) => Object.keys(r).join() === "id,name"), "a legacy Board entry is { id, name } alone");
  assert.equal(ix.moodMenu, undefined);
  assert.equal(ix.meta.countriesAll, undefined);
  assert.deepEqual(ix.moods.map((m) => m.id), ["lift", "escape", "slow"]);
});

test("v2 index: the board changes nothing in the legacy index (same plan without a board, same bytes)", () => {
  const { plan, base, ix } = world();
  const noBoard = buildPlan({ moods: MOODS, rows: ROWS, extra: EXTRA, sizes: SIZES });
  assert.equal(noBoard.board2, undefined, "without a board the plan has no board2");
  assert.deepEqual(plan.board, noBoard.board);
  assert.deepEqual(plan.discover, noBoard.discover);
  assert.equal(JSON.stringify(ix), JSON.stringify(buildIndex({ ...base, plan: noBoard })), "the legacy buildIndex ignores board2");
});

test("v2 index: a series row is a board entry with no films and no file of its own", () => {
  const board = { ...V2_BOARD, order: ["tonight", "short", "my-series", "escape", "friends-week"], names: { tonight: "T", short: "S", "my-series": "📺 Series to watch", escape: "E", "friends-week": "W" } };
  const { ix2 } = world(board);
  assert.deepEqual(ix2.board.find((r) => r.id === "my-series"), { id: "my-series", name: "📺 Series to watch", place: "board", series: true });
  assert.deepEqual(ix2.rows["my-series"], []);
  assert.ok(!pieces2(ix2).some((p) => p.rel.includes("my-series")), "the Worker builds it: no index-v2-row-my-series.json");
  assert.throws(() => BD.parse(withBoard({ order: ["my-series", "friends-week"], names: { "my-series": "S", "friends-week": "W" }, place: { "my-series": "menu", "friends-week": "menu" } })), /the series row "my-series" cannot be a menu option/);
});

test("v2 files: a row's slice holds exactly its films, a mood's exactly the films that fit it, the menus none", () => {
  const { ix2 } = world();
  const parts = Object.fromEntries(pieces2(ix2).map((p) => [p.part, p.obj]));
  assert.deepEqual(Object.keys(parts).sort(), ["v2-menus", "v2-mood:escape", "v2-mood:lift", "v2-mood:slow", ...FIXTURE.order.map((id) => `v2-row:${id}`)].sort(), "friends-week is not a mood: no mood file, its row file serves the menu");
  for (const id of FIXTURE.order) {
    const p = parts[`v2-row:${id}`];
    assert.deepEqual(tts(p), [...ix2.rows[id]].sort(), `row ${id}: exactly its films`);
    assert.deepEqual(p.board, [ix2.board.find((r) => r.id === id)]);
    assert.deepEqual(p.rows, { [id]: ix2.rows[id] });
    assert.deepEqual(p.rowDesc, { [id]: ix2.rowDesc[id] });
    assert.equal(p.meta.count, p.films.length);
  }
  assert.deepEqual(tts(parts["v2-mood:escape"]), ["tt0000001", "tt0000003"]);
  assert.deepEqual(tts(parts["v2-mood:slow"]), ["tt0000004"]);
  assert.deepEqual(tts(parts["v2-mood:lift"]), ["tt0000001"]);
  assert.deepEqual(parts["v2-mood:escape"].board, []);
  const menus = parts["v2-menus"];
  assert.deepEqual(menus.films, [], "the menus file carries no film");
  assert.equal(menus.meta.count, 0);
  assert.deepEqual(menus.board, ix2.board, "…and the whole Board");
  assert.deepEqual(menus.moodMenu, ix2.moodMenu);
  assert.deepEqual(menus.rows, Object.fromEntries(FIXTURE.order.map((id) => [id, []])), "rows name every row, with no film");
  assert.deepEqual(menus.meta.countriesAll, V2_BOARD.countries);
});

test("v2 files on disk: written next to the legacy files, decodable, and verify.js accepts them; each way a slice can be wrong is named", () => {
  const out = tmp();
  try {
    const { ix, ix2 } = world();
    const w = writeIndex(out, ix, ix2);
    require("../test-support/film-page-fixture").writeMinimalPages(out, ix2); // 24/10/2026: a v2 index is verified together with its 100 film-page shards
    assert.equal(w.v2.films, ix2.films.length);
    assert.equal(w.v2.files, 1 + FIXTURE.order.length + 3, "menus + one per row + one per mood");
    const names = fs.readdirSync(path.join(out, "data")).filter((n) => n.startsWith("index-v2")).sort();
    assert.deepEqual(names, ["index-v2-menus.json", "index-v2-mood-escape.json", "index-v2-mood-lift.json", "index-v2-mood-slow.json", ...FIXTURE.order.map((id) => `index-v2-row-${id}.json`), "index-v2.json"].sort());
    assert.ok(fs.existsSync(path.join(out, "data", "index.json")) && fs.existsSync(path.join(out, "data", "index-board.json")), "the legacy files are still there");
    assert.deepEqual(decode(JSON.parse(fs.readFileSync(path.join(out, "data", "index-v2.json"), "utf8"))), ix2);
    const ok = verifyIndex(out);
    assert.equal(ok.ok, true, ok.problems.join("\n"));
    assert.equal(ok.stats.v2.films, ix2.films.length);

    const edit = (name, fn) => {
      const file = path.join(out, "data", name), before = fs.readFileSync(file, "utf8"), j = JSON.parse(before);
      fn(j);
      fs.writeFileSync(file, JSON.stringify(j));
      try { return verifyIndex(out).problems.join("\n"); } finally { fs.writeFileSync(file, before); }
    };
    // a row's slice without one of its films
    assert.match(edit("index-v2-row-tonight.json", (j) => { j.films.pop(); j.meta.count--; }), /index-v2-row-tonight: 1 film\(s\) it should hold are missing/);
    // a row's slice with a film that is not in the row
    const foreign = JSON.parse(fs.readFileSync(path.join(out, "data", "index-v2.json"), "utf8")).films.find((r) => r[0] === "tt0000004");
    assert.match(edit("index-v2-row-tonight.json", (j) => { j.films.push(foreign); j.meta.count++; }), /index-v2-row-tonight: 1 film\(s\) it should not hold/);
    // the menus with a film
    assert.match(edit("index-v2-menus.json", (j) => { j.films.push(foreign); j.meta.count++; }), /index-v2-menus: 1 film\(s\) it should not hold/);
    // a mood's slice without a member, and with a stranger
    assert.match(edit("index-v2-mood-escape.json", (j) => { j.films.pop(); j.meta.count--; }), /index-v2-mood-escape: 1 film\(s\) it should hold are missing/);
    assert.match(edit("index-v2-mood-slow.json", (j) => { j.films.push(JSON.parse(fs.readFileSync(path.join(out, "data", "index-v2.json"), "utf8")).films.find((r) => r[0] === "tt0000002")); j.meta.count++; }), /index-v2-mood-slow: 1 film\(s\) it should not hold/);
    // the Board of a row's file is that row alone; the menus' board is the whole one
    assert.match(edit("index-v2-row-tonight.json", (j) => { j.board[0].name = "Other"; }), /index-v2-row-tonight: board must be this row's entry alone/);
    assert.match(edit("index-v2-menus.json", (j) => { j.board.reverse(); }), /index-v2-menus: board differs from index-v2|rows and board do not list the same rows/);
    // the order and the places live in the whole index
    assert.match(edit("index-v2.json", (j) => { j.board[3].place = "board"; }), /place "menu"|moodMenu option friends-week is neither/);
    // a v2 file the index does not account for, and a v2 file with no whole index
    fs.writeFileSync(path.join(out, "data", "index-v2-row-ghost.json"), "{}");
    assert.match(verifyIndex(out).problems.join("\n"), /data\/index-v2-row-ghost\.json is a v2 file the index does not account for/);
    fs.rmSync(path.join(out, "data", "index-v2-row-ghost.json"));
    const v2Text = fs.readFileSync(path.join(out, "data", "index-v2.json"));
    fs.copyFileSync(path.join(out, "data", "index.json"), path.join(out, "data", "index-v2.json")); // a legacy index under the v2 name
    assert.match(verifyIndex(out).problems.join("\n"), /index-v2: no moodMenu, so this is not a v2 index/);
    fs.writeFileSync(path.join(out, "data", "index-v2.json"), v2Text);
    fs.rmSync(path.join(out, "data", "index-v2.json"));
    assert.match(verifyIndex(out).problems.join("\n"), /is there and data\/index-v2\.json is not/);
  } finally { rm(out); }
});

test("v2 index: a legacy index that carries place/series is refused (the v2 Board leaking into the legacy family)", () => {
  const { ix } = world();
  ix.board[0].place = "board"; // what a v2 entry in the legacy Board would look like
  const out = tmp();
  try {
    assert.throws(() => writeIndex(out, ix), /board row tonight carries place\/series, which only the v2 family/);
  } finally { rm(out); }
});

test("v2 index: the country column keeps the countries of the frozen menu beyond the first two; the legacy index keeps its own menu", () => {
  const view = { users: [], films: { alpha: { slug: "alpha", title: "Alpha", year: 1999, imdbId: "tt0000001", c: ["Japan", "Spain", "Brazil"] } } };
  const { plan, base, menu, spec } = world();
  const entry = (index) => index.films.find((f) => f.tt === "tt0000001");
  assert.deepEqual(entry(buildIndex({ ...base, view, plan })).countries, ["Japan", "Spain"], "the legacy menu holds neither Brazil nor anything else here");
  assert.deepEqual(entry(buildIndex({ ...base, view, plan: { board: plan.board2, discover: plan.discover }, moods: menu.moods, v2: { menu: menu.menu, countries: spec.countries } })).countries, ["Japan", "Spain", "Brazil"], "Brazil is in the board's frozen menu");
});

test("v2 index: writeIndex refuses an invalid v2 index before writing anything", () => {
  const { ix, ix2 } = world();
  ix2.board[0].place = "nowhere";
  const out = tmp();
  try {
    assert.throws(() => writeIndex(out, ix, ix2), /^Error: index-v2: Invalid index board place/, "the message names the v2 family, not \"index\"");
    assert.deepEqual(fs.readdirSync(out), []);
  } finally { rm(out); }
});

test("v2 index: a row over 100 films is refused", () => {
  const many = Array.from({ length: 101 }, (_, i) => item(`tt${String(i + 10).padStart(7, "0")}`, `Film ${i}`));
  const spec = BD.parse(withBoard({}));
  const plan = buildPlan({ moods: MOODS, rows: ROWS, extra: { ...EXTRA, short: many }, sizes: SIZES, board: spec });
  const menu = BD.menuFor(spec, MOODS);
  const ix2 = buildIndex({ cfg: { ...CONFIG, board: FIXTURE }, today: "2026-10-10", builtAt: "2026-10-10T12:00:00.000Z", moods: menu.moods, ranked: RANKED, quality: { eligible: () => true, minStars: 3.5 }, plan: { board: plan.board2, discover: plan.discover }, v2: { menu: menu.menu, countries: null } });
  assert.throws(() => require("../lib/index-validation").validateIndex(ix2), /row short has 101 films, more than 100/);
});

test("guard, quality floor, exclude.films and the covers walk the v2 Board as they walk the legacy one", () => {
  // the seen-film guard: a film planted only in a v2 row is named, under that row's v2 key
  const { plan } = world();
  const seen = { seenIds: new Set(), seenTts: new Set(["tt0000099"]), titleSeen: () => false, seenSlugs: new Set() };
  assert.deepEqual(findLeaks(guardRows(plan), seen), []);
  plan.board2.find((r) => r.id === "short").items.push(item("tt0000099", "Planted"));
  assert.deepEqual(findLeaks(guardRows(plan), seen), ["Planted (2000) in short/v2"], "refused in the v2 row; the legacy short row does not hold it");
  // …and Old friends, the one row allowed to hold seen films, stays exempt in the v2 Board
  const old = world({ ...V2_BOARD, order: [...FIXTURE.order, "oldfriends"], names: { ...FIXTURE.names, oldfriends: "📼 Worth watching again" } });
  old.plan.board2.find((r) => r.id === "oldfriends").items.push(item("tt0000099", "Seen long ago"));
  assert.deepEqual(findLeaks(guardRows(old.plan), seen), [], "oldfriends/v2 is exempt like oldfriends");
  // the quality floor: Gamma has a Letterboxd average of 3.0, below 3.5
  const w = world();
  const ratings = new Map([A, B, C, D, E, F].map((it) => [it.id, { lb: it.id === "tt0000003" ? 3 : 4, fr: null }]));
  Q.applyPlan(w.plan, ratings);
  assert.deepEqual(w.plan.board2.find((r) => r.id === "escape").items.map((i) => i.id), ["tt0000001"], "Gamma is under the floor in the v2 Board too");
  assert.deepEqual(w.plan.board.find((r) => r.id === "escape").items.map((i) => i.id), ["tt0000001"]);
  // exclude.films
  const x = world();
  EX.applyToPlan(x.plan, new Set(["tt0000001"]));
  assert.deepEqual(x.plan.board2.find((r) => r.id === "tonight").items.map((i) => i.id), ["tt0000002"]);
  assert.deepEqual(x.plan.board2.find((r) => r.id === "escape").items.map((i) => i.id), ["tt0000003"]);
  // the covers and the numbers reach the items of the v2 Board
  const y = world();
  const inBoards = boardRows(y.plan).reduce((n, r) => n + r.items.length, 0), inDiscover = y.plan.discover.flatMap((c) => c.options).reduce((n, o) => n + o.items.length, 0);
  assert.ok(y.plan.board2.flatMap((r) => r.items).length > 0);
  assert.equal(planItems(y.plan).length, inBoards + inDiscover, "every item of both Boards and of Discover");
  attachRatings(y.plan, { find: () => ({ seenBy: 1, friendsAvg: null, wantBy: 0 }) });
  assert.ok(y.plan.board2.flatMap((r) => r.items).length > 0 && y.plan.board2.flatMap((r) => r.items).every((i) => i.ratings && i.ratings.seenBy === 1));
});

test("public output: the names of the v2 family are allowed, the legacy names still are, a path trick or a stray name is not", () => {
  for (const rel of ["data/index-v2.json", "data/index-v2-menus.json", "data/index-v2-row-tonight.json", "data/index-v2-row-after-midnight.json", "data/index-v2-row-1970s.json", "data/index-v2-mood-slow.json"])
    assert.equal(PUB.isPublicFile(rel), true, rel);
  for (const rel of ["data/index.json", "data/index-board.json", "data/index-moods.json", "data/index-friends.json", "data/index-directors.json", "data/index-list-crit_5.json", "data/film-languages.json", "manifest.json", "catalog/movie/europe.json"])
    assert.equal(PUB.isPublicFile(rel), true, rel);
  for (const rel of ["data/index-v2-../x.json", "data/index-v2-.json", "data/index-v2--x.json", "data/index-v2-Row.json", "data/index-v2-row-a_b.json", "data/index-v2/x.json", "data/index-v3.json", "data/index-anything.json", "data/engine.json.bak", "../data/index-v2.json"])
    assert.equal(PUB.isPublicFile(rel), false, rel);
});

test("build.js --self-test-guard with a board: the film planted in a v2 row is refused too, or the build says so and exits 2", { timeout: 120000 }, () => {
  const out = tmp();
  try {
    const r = spawnSync(process.execPath, [path.join(__dirname, "..", "build.js"), "--offline", "--cache-only", "--skip-posters", "--date", "2026-10-13", "--captured-at", "2026-10-13T12:00:00.000Z", "--board", path.join(__dirname, "fixtures", "board-v2.json"), "--self-test-guard", "--out", out], {
      cwd: path.join(__dirname, ".."), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" },
    });
    assert.equal(r.status, 0, (r.stderr || "") + (r.stdout || "").slice(-1500));
    assert.match(r.stdout, /self-test: and in a row of the v2 Board → .* in short\/v2/);
    assert.deepEqual(fs.readdirSync(out), [], "the self-test publishes nothing");
  } finally { rm(out); }
});

test("build.js applies the private feedback (Not for me) to the rows of the v2 Board as to the legacy ones", async () => {
  // the same slice of build.js that test/review-fixes.test.js runs: from `const permitted =` to `const planted =`, with the globals it reads
  const F = require("../lib/learning/feedback"), UI = require("../web/feedback");
  const c = UI.createController({ storage: { save: async () => {} }, clock: () => "2026-10-10T12:00:00.000Z", uuid: () => crypto.randomUUID() });
  await c.record("not_for_me", "tt1");
  const plan = { board: [{ id: "lift", items: [{ id: "tt1" }, { id: "tt2" }] }], board2: [{ id: "lift", name: "Lift", place: "board", items: [{ id: "tt1" }, { id: "tt2" }] }, { id: "my-series", name: "Series", place: "board", series: true, items: [] }], discover: [] };
  const source = fs.readFileSync(path.join(__dirname, "..", "build.js"), "utf8"), start = source.indexOf("  const permitted ="), end = source.indexOf("  const planted =", start);
  assert.ok(start > 0 && end > start);
  vm.runInNewContext(source.slice(start, end), { LF: F, feedbackState: c.state(), plan, moods: [{ id: "lift", word: "Lift" }], ranked: {} });
  assert.deepEqual(plan.board[0].items.map((i) => i.id), ["tt2"]);
  assert.deepEqual(plan.board2[0].items.map((i) => i.id), ["tt2"], "the film Marco marked 'not for me' is gone from the v2 row too");
});

test("build.js gives the drawn cover to the films of the v2 index as to the legacy one", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "build.js"), "utf8"), start = source.indexOf("  if (covers) for (const e of index.films)"), end = source.indexOf("  // 6 ──", start);
  assert.ok(start > 0 && end > start);
  const films = () => [{ tt: "tt0000001" }, { tt: "tt0000002" }];
  // 19/10/2026: the address carries the version of the drawing (?v=, lib/posters.js) in the legacy index and in the v2 one alike
  const covers = () => ({ tts: new Set(["tt0000001"]), versions: new Map([["tt0000001", "abc12345"]]) });
  const ctx = { covers: covers(), index: { films: films() }, index2: { films: films() }, PO: { posterUrl: PO.posterUrl }, cfg: { posters: { base: "https://example.test/posters/" } } };
  vm.runInNewContext(source.slice(start, end), ctx);
  assert.deepEqual(ctx.index.films, [{ tt: "tt0000001", poster: "https://example.test/posters/tt0000001.jpg?v=abc12345" }, { tt: "tt0000002" }]);
  assert.deepEqual(ctx.index2.films, ctx.index.films, "the v2 index carries the same covers, with the same version");
  const none = { covers: covers(), index: { films: films() }, index2: null, PO: ctx.PO, cfg: ctx.cfg };
  vm.runInNewContext(source.slice(start, end), none); // no board: no index2, nothing to give a cover to
  assert.equal(none.index.films[0].poster, "https://example.test/posters/tt0000001.jpg?v=abc12345");
});

test("v2 index: the Moods menu refuses a repeated id; two moods with the same word get two labels; the publisher refuses a v2 index without the legacy one", () => {
  const { ix2, spec } = world();
  ix2.moodMenu.push({ ...ix2.moodMenu[0] });
  assert.throws(() => require("../lib/index-validation").validateIndex(ix2), /Duplicate index moodMenu id/);
  const twins = [{ id: "escape", word: "Same", name: "A" }, { id: "slow", word: "Same", name: "B" }, { id: "lift", word: "Other", name: "C" }];
  assert.deepEqual(BD.menuFor(spec, twins).menu.map((o) => o.label), ["Same", "Same 2", "Other", "Friends this week"]);
  assert.throws(() => require("../lib/publish").publish({ outDir: path.join(os.tmpdir(), "mood-board-v2-never-created"), webDir: __dirname, cfg: CONFIG, plan: {}, webData: {}, index2: {} }), /never alone/);
});

test("board: the legacy moods must include the nine the profiles read; two rows may not share a name; a mood is not a menu row; the message names where the board came from", () => {
  const bad = (patch, re, source) => assert.throws(() => BD.parse(withBoard(patch), source), re);
  bad({ legacyMoods: ["lift", "escape"], moodMenu: ["escape", "friends-week"] }, /legacyMoods: "reinvent" is missing, and the profiles and the picker read it from the legacy family/);
  bad({ names: { ...FIXTURE.names, tonight: FIXTURE.names.short } }, /names: "tonight" and "short" are both called "⏱️ Under 95 minutes"/);
  bad({ place: { "friends-week": "menu", escape: "menu" } }, /place: "escape" is a mood of config.json: it cannot also be a menu row/);
  bad({ bogus: 1 }, /^Error: config\.json board: unexpected key "bogus"/);
  bad({ bogus: 1 }, /^Error: --board \/x\/b\.json: unexpected key "bogus"/, "--board /x/b.json");
  assert.throws(() => BD.parse({ ...CONFIG, board: [] }, "--board /x/b.json"), /^Error: --board \/x\/b\.json must be an object/);
});

// Marco, 14/10/2026 (front shuffle, lib/front-shuffle.js): board.shuffle is optional, validated key by key, and every message names the key.
test("board.shuffle: absent means no shuffle; present gets its defaults; an unknown key, a non-number, a value out of range, a memory that is not file or none and a keep outside order are refused, each naming the key", () => {
  assert.equal(BD.parse(withBoard({})).shuffle, null, "the fixtures and the parity test's boards have no shuffle: nothing changes");
  assert.deepEqual(BD.parse(withBoard({ shuffle: {} })).shuffle, require("../lib/front-shuffle").DEFAULTS, "an empty object is the defaults");
  const sound = BD.parse(withBoard({ shuffle: { tau: 15, penalty: 10, maxFronts: 3, keep: ["tonight"] } })).shuffle;
  assert.deepEqual([sound.tau, sound.penalty, sound.maxFronts, sound.maxLeads, sound.front, sound.keep], [15, 10, 3, 1, 8, ["tonight"]], "what is said wins, the rest is default");
  const bad = (shuffle, re) => assert.throws(() => BD.parse(withBoard({ shuffle })), re);
  bad({ tau: 0 }, /shuffle\.tau must be a number above 0 and at most 100, got 0/);
  bad({ tau: -3 }, /shuffle\.tau must be a number above 0/);
  bad({ tau: 101 }, /shuffle\.tau must be a number above 0 and at most 100/);
  bad({ tau: "15" }, /shuffle\.tau must be a number above 0 and at most 100, got "15"/);
  bad({ halfLifeDays: 0 }, /shuffle\.halfLifeDays must be a number above 0/);
  bad({ penalty: "10" }, /shuffle\.penalty must be a number, 0 or more, got "10"/);
  bad({ penalty: -1 }, /shuffle\.penalty must be a number, 0 or more/);
  bad({ maxFronts: 0 }, /shuffle\.maxFronts must be a whole number from 1 to 54, got 0/);
  bad({ maxFronts: 2.5 }, /shuffle\.maxFronts must be a whole number/);
  bad({ maxLeads: 0 }, /shuffle\.maxLeads must be a whole number/);
  bad({ front: 0 }, /shuffle\.front must be a whole number from 1 to 20/);
  bad({ front: 21 }, /shuffle\.front must be a whole number from 1 to 20/);
  bad({ memoryDays: 31 }, /shuffle\.memoryDays must be a whole number from 0 to 30/);
  bad({ memory: "x" }, /shuffle\.memory must be "file" or "none", got "x"/);
  bad({ memory: "replay" }, /shuffle\.memory must be "file" or "none"/);
  bad({ keep: ["nope"] }, /shuffle\.keep: "nope" is not in order/);
  bad({ keep: "tonight" }, /shuffle\.keep must be a list of row ids/);
  bad({ colour: 1 }, /shuffle: unexpected key "colour" \(allowed: front, tau, penalty, maxFronts, maxLeads, memory, memoryDays, halfLifeDays, keep\)/);
  bad(null, /shuffle must be an object/);
  bad([], /shuffle must be an object/);
  bad(false, /shuffle must be an object/);
  assert.throws(() => BD.parse(withBoard({ shuffle: { tau: 0, maxFronts: 0 } })), (e) => /shuffle\.tau/.test(e.message) && /shuffle\.maxFronts/.test(e.message), "every problem at once, as for the rest of the board");
  assert.throws(() => BD.parse(withBoard({ shuffle: { tau: 0 } }), "--board /x/b.json"), /^Error: --board \/x\/b\.json: shuffle\.tau/, "the message says where the board came from");
});

test("v2 index: a country of the frozen menu that no film of the index has is refused, with its name", () => {
  const { ix2 } = world();
  ix2.meta.countriesAll = [...ix2.meta.countriesAll, "Atlantis"];
  assert.throws(() => validateIndex(ix2, "index-v2"), /Invalid index-v2: index-v2: meta\.countriesAll names "Atlantis", and no film of the index has that country/);
});

test("v2 index: the errors of the v2 family say index-v2; the legacy ones keep saying index", () => {
  const { ix, ix2 } = world();
  const out = path.join(os.tmpdir(), "mood-board-v2-never-created");
  const { publish } = require("../lib/publish");
  ix2.rows.short.push("tt0000999"); // a row that names a film the index lacks
  ix2.rowDesc.short.push("text");
  assert.throws(() => publish({ outDir: out, webDir: __dirname, cfg: CONFIG, plan: {}, webData: {}, index: ix, index2: ix2 }), /^Error: Invalid index-v2: index-v2: tt0000999 in row short is not among the films/);
  assert.throws(() => writeIndex(out, ix, ix2), /^Error: Invalid index-v2: index-v2: tt0000999/);
  ix.rows.tonight.push("tt0000999"); ix.rowDesc.tonight.push("text");
  assert.throws(() => validateIndex(ix), /^Error: Invalid index: index: tt0000999 in row tonight is not among the films/);
});

// ── legacyMoods filters every reader that feeds the legacy family (Marco, 13/10/2026; the new moods exist in the v2 family alone) ──
const NOIR = { ...CONFIG.moods.find((m) => m.id === "lift"), id: "noir", word: "Noir", name: "Noir", keywords: { zzznoir: 1 }, pins: undefined };
const CFG_NOIR = { ...CONFIG, moods: [...CONFIG.moods, NOIR] };
const BOARD_NOIR = { ...V2_BOARD, moodMenu: ["escape", "slow", "lift", "noir", "friends-week"] };

test("legacyMoods, reader 1 (lib/index-export.js, the search words): a keyword only a new mood knows is not in the legacy index, and is in the v2 one", () => {
  const spec = BD.parse({ ...CFG_NOIR, board: BOARD_NOIR });
  const all = compile(CFG_NOIR.moods.filter((m) => ["lift", "escape", "slow", "noir"].includes(m.id)));
  const plan = buildPlan({ moods: all, rows: ROWS, extra: EXTRA, sizes: SIZES, board: spec });
  const cands = [{ film: { id: 1, imdb: "tt0000001", title: "Alpha", keywords: ["zzznoir"], genres: [], directors: [], countries: [] }, tasteZ: 0, qualityZ: 0 }];
  const base = { cfg: { ...CFG_NOIR, board: BOARD_NOIR }, view: VIEW, cands, today: "2026-10-10", builtAt: "2026-10-10T12:00:00.000Z", ranked: RANKED, quality: { eligible: () => true, minStars: 3.5 } };
  const alpha = (index) => index.films.find((f) => f.tt === "tt0000001");
  assert.equal(alpha(buildIndex({ ...base, moods: all.filter((m) => m.id !== "noir"), plan })).keywords, undefined, "legacy: only the nine moods' words");
  const menu = BD.menuFor(spec, all);
  assert.deepEqual(alpha(buildIndex({ ...base, plan: { board: plan.board2, discover: plan.discover }, moods: menu.moods, v2: { menu: menu.menu, countries: spec.countries } })).keywords, ["zzznoir"], "v2: every mood's words");
});

test("legacyMoods, reader 2 (lib/plan.js, the Board): a new mood has no row in the legacy Board, and the v2 menu has it", () => {
  const spec = BD.parse({ ...CFG_NOIR, board: BOARD_NOIR });
  const all = compile(CFG_NOIR.moods.filter((m) => ["lift", "escape", "slow", "noir"].includes(m.id)));
  const plan = buildPlan({ moods: all, rows: { ...ROWS, noir: [A] }, extra: EXTRA, sizes: SIZES, board: spec });
  assert.ok(!plan.board.some((r) => r.id === "noir"), "no legacy Board row (so no catalog/movie/noir.json, no manifest entry, no index-board row)");
  assert.ok(plan.board.some((r) => r.id === "lift") && plan.board.some((r) => r.id === "slow"));
  assert.deepEqual(BD.menuFor(spec, all).menu.map((o) => o.id), ["escape", "slow", "lift", "noir", "friends-week"]);
});

test("legacyMoods, reader 3 (lib/plan.js, the static Discover Moods menu): a new mood is not an option there", () => {
  const spec = BD.parse({ ...CFG_NOIR, board: BOARD_NOIR });
  const all = compile(CFG_NOIR.moods.filter((m) => ["lift", "escape", "slow", "noir"].includes(m.id)));
  const plan = buildPlan({ moods: all, rows: { ...ROWS, noir: [A] }, extra: EXTRA, sizes: SIZES, board: spec });
  const moodsCatalog = plan.discover.find((c) => c.id === "mood-engine");
  assert.deepEqual(moodsCatalog.options.map((o) => o.label), ["Uplift", "Escape", "Slow"]);
});

// ── covers (13/10/2026): a film only a v2 row holds, and the index lacks, never abandons the covers of the night ──
const coverStepOf = (ctx) => {
  const code = fs.readFileSync(path.join(__dirname, "..", "build.js"), "utf8").split("async function coverStep(")[1].split("\n/**")[0];
  return vm.runInNewContext("(async function coverStep(" + code + ")", ctx);
};
const fakeDraw = async ({ targets }) => { for (const t of targets.values()) for (const item of t.items) item.poster = PO.posterUrl(null, t.tt); return { stats: { mb: 0 }, tts: new Set(targets.keys()), receipt: [] }; };

test("covers: a film in a v2 row that the index lacks is skipped with a warning of its own; the legacy covers are still drawn", async () => {
  const lone = item("tt9999999", "Only In V2");
  const plan = { board: [{ id: "x", items: [{ ...A, poster: "/original.jpg" }] }], board2: [{ id: "x", name: "X", place: "board", items: [{ ...A, poster: "/original.jpg" }, lone] }], discover: [] };
  const index = buildIndex({ cfg: { addon: { version: "1" }, moods: [] }, today: "2026-10-12", plan: { board: plan.board, discover: [] } }); // the legacy index: no tt9999999
  const logs = [];
  const run = coverStepOf({ PO: { ...PO, drawCovers: fakeDraw }, CO: { attachCountries: () => ({ unknownLanguages: {} }) }, SKIP_POSTERS: false, CACHE_ONLY: true, COVER_RECEIPT: "/receipt-fixture.json", process: { env: {} }, CACHE_DIR: "/cache", ROOT: path.resolve(__dirname, ".."), cfg: {}, today: "2026-10-12", path, log: (m) => logs.push(m), require: () => ({ writePrivate() {} }) });
  const r = await run({ plan, index, coverFacts: new Map(), countries: {} });
  assert.ok(r, "the covers of the night were not abandoned");
  assert.deepEqual([...r.tts], ["tt0000001"]);
  assert.equal(plan.board[0].items[0].poster, PO.posterUrl(null, "tt0000001"), "the legacy cover is drawn");
  assert.equal(plan.board2[0].items[0].poster, PO.posterUrl(null, "tt0000001"));
  assert.equal(lone.poster, undefined, "the v2-only film keeps no cover");
  assert.equal(logs.filter((l) => /Cover skipped for tt9999999 \(Only In V2\) in the v2 row x/.test(l)).length, 1);
  assert.ok(!logs.some((l) => /every film keeps the cover address it had/.test(l)));
});

test("covers: a film of the LEGACY plan that the index lacks still stops the covers (the build has a hole)", async () => {
  const plan = { board: [{ id: "x", items: [A, item("tt9999999", "Hole")] }], discover: [] };
  const index = buildIndex({ cfg: { addon: { version: "1" }, moods: [] }, today: "2026-10-12", plan: { board: [{ id: "x", items: [A] }], discover: [] } });
  const logs = [];
  const run = coverStepOf({ PO: { ...PO, drawCovers: fakeDraw }, CO: { attachCountries: () => ({ unknownLanguages: {} }) }, SKIP_POSTERS: false, CACHE_ONLY: true, COVER_RECEIPT: "/r.json", process: { env: {} }, CACHE_DIR: "/cache", ROOT: path.resolve(__dirname, ".."), cfg: {}, today: "2026-10-12", path, log: (m) => logs.push(m), require: () => ({ writePrivate() {} }) });
  assert.equal(await run({ plan, index, coverFacts: new Map(), countries: {} }), null);
  assert.ok(logs.some((l) => /Planned cover missing from full index: tt9999999/.test(l)));
});

test("covers: the cover step walks the legacy index plus the films only the v2 index has, so a v2-only film gets its cover", () => {
  const lone = item("tt9999999", "Only In V2");
  const plan = { board: [{ id: "x", items: [A] }], board2: [{ id: "x", name: "X", place: "board", items: [A, lone] }], discover: [] };
  const mk = (rows) => buildIndex({ cfg: { addon: { version: "1" }, moods: [] }, today: "2026-10-12", plan: { board: rows, discover: [] } });
  const index = mk(plan.board), index2 = mk(plan.board2);
  const union = withV2Films(index, index2);
  assert.deepEqual(union.films.map((f) => f.tt).sort(), ["tt0000001", "tt9999999"]);
  assert.equal(withV2Films(index, null), index);
  const skipped = [];
  const targets = PO.collectTargets(plan, { index: union, onSkip: (it) => skipped.push(it.id) });
  assert.deepEqual([...targets.keys()].sort(), ["tt0000001", "tt9999999"]);
  assert.deepEqual(skipped, []);
});

test("build.js: a rejected --board file stops the build at once and says it was the --board file; the cover step gets the legacy index plus the films only v2 has", async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "bad-board.json");
    fs.writeFileSync(file, JSON.stringify({ ...FIXTURE, bogus: 1 }));
    const r = spawnSync(process.execPath, [path.join(__dirname, "..", "build.js"), "--offline", "--cache-only", "--skip-posters", "--board", file, "--out", path.join(dir, "out")], { cwd: path.join(__dirname, ".."), encoding: "utf8", env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" } });
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes(`✖ --board ${file}: unexpected key "bogus"`), r.stderr.slice(0, 400));
  } finally { rm(dir); }
  // the snippet of build.js that hands the index to the cover step, run with the films of a v2-only row
  const source = fs.readFileSync(path.join(__dirname, "..", "build.js"), "utf8"), start = source.indexOf("  const coverIndex ="), end = source.indexOf("  if (covers) for (const e of index.films)", start);
  assert.ok(start > 0 && end > start);
  const lone = item("tt9999999", "Only In V2");
  const mk = (rows) => buildIndex({ cfg: { addon: { version: "1" }, moods: [] }, today: "2026-10-12", plan: { board: rows, discover: [] } });
  let handed = null;
  await vm.runInNewContext(`(async () => { ${source.slice(start, end)} })()`, {
    withV2Films, index: mk([{ id: "x", items: [A] }]), index2: mk([{ id: "x", items: [A, lone] }]), linkedCoverFacts: new Map(), linkedCoverFacts2: new Map(),
    CF: { fallback: () => new Map(), countries: () => ({}) }, tmdb: { cache: { movie: {} } }, require: () => ({ read: () => new Map() }), plan: {}, countries: {}, PO: { watchlistIds: () => new Set() }, cands: [], src: { recs: [] },
    coverStep: async (o) => { handed = o; return null; },
  });
  assert.deepEqual(handed.index.films.map((f) => f.tt).sort(), ["tt0000001", "tt9999999"], "the cover step walks the v2-only film too");
});

// ── the row's name leads the reason line in the v2 rows too (Marco, 13/10/2026) ──

test("v2 slices: the second line of every row text (rowDesc of index-v2-row-*) says \"Mood: <the row's v2 name>\" in a mood row and no mood in the others (Tonight: the mood the pick was drawn for, when it has one)", () => {
  const { ix2, plan } = world();
  const parts = Object.fromEntries(pieces2(ix2).map((p) => [p.part, p.obj]));
  let checked = 0;
  for (const entry of ix2.board) {
    const texts = parts[`v2-row:${entry.id}`].rowDesc[entry.id];
    assert.equal(texts.length, ix2.rows[entry.id].length, entry.id);
    for (const t of texts) {
      const reason = t.split("\n\n")[0].split("\n")[1] || "";
      // description v3 (Marco, 20/10/2026): "Mood: <the row's v2 name>" in a mood row; Tonight "Mood: <the mood it was drawn for>" or none; every other row says no ROW mood (since 21/10/2026, D3, a real build gives those rows the film's best fit; the items of this plan carry no `fitMood`, so the line starts with the genres here)
      if (["escape", "slow", "lift"].includes(entry.id)) assert.ok(reason.startsWith(`Mood: ${entry.name}`), `${entry.id}: "${reason}" should start with "Mood: ${entry.name}"`);
      else assert.ok(!reason.startsWith("Mood: ") || entry.id === "tonight", `${entry.id}: "${reason}" is no mood row`);
      assert.ok(!reason.includes("Why:"));
      checked++;
    }
  }
  assert.ok(checked >= 6, `${checked} row texts checked`);
  // a mood row's items carry the legacy mood name from lib/rows.js; the v2 row says its own name
  const escape = plan.board2.find((r) => r.id === "escape");
  assert.ok(escape.items.every((it) => it.mood === FIXTURE.names.escape));
  // Tonight keeps the mood a pick was drawn for when the item has one
  const tonightPlan = buildPlan({ moods: MOODS, rows: { ...ROWS, tonight: [{ ...A, mood: "Tonight · ☀️ Lift me out" }, B] }, extra: EXTRA, sizes: SIZES, board: BD.parse({ ...CONFIG, board: V2_BOARD }) });
  assert.deepEqual(tonightPlan.board2.find((r) => r.id === "tonight").items.map((it) => it.mood), ["Tonight · ☀️ Lift me out", FIXTURE.names.tonight]);
  // the legacy Board is untouched by the v2 names
  assert.ok(plan.board.every((r) => r.items.every((it) => !String(it.mood).includes("Tonight:") )));
});

// Marco, 21/10/2026 ~22:15 UTC (questionnaire): the best-fit label names a mood by its Board row when the Board has one, so the Moods menu of the v2 index, where the Worker takes "Mood: <name>" from (`moods[].name`, worker/src/catalogs.js), has to
// say the row's name too. The fixture Board calls the escape row "Fun and adventure" and the mood is "Full escape" (config.json `moods`); slow and lift have no row here. The legacy index keeps the mood's name (its Board rows are named so).
test("the Moods menu of the v2 index names a mood by its Board row (menuFor); a mood without a row, and the legacy index, keep the mood's own name (B, 21/10/2026 ~22:15 UTC)", () => {
  const { ix, ix2, menu } = world();
  const own = Object.fromEntries(MOODS.map((m) => [m.id, m.name]));
  assert.equal(FIXTURE.names.escape, "🎳 Fun and adventure");
  assert.notEqual(own.escape, FIXTURE.names.escape, "the fixture is a mood whose Board name is another one");
  const names = (index) => Object.fromEntries(index.moods.map((m) => [m.id, m.name]));
  assert.equal(names(ix2).escape, FIXTURE.names.escape, "v2: the row's name");
  assert.equal(names(ix2).slow, own.slow, "v2, no row: the mood's name");
  assert.equal(names(ix2).lift, own.lift, "v2, no row: the mood's name");
  assert.deepEqual(names(ix), own, "legacy: every mood by its own name");
  const alias = (index) => Object.fromEntries(index.moods.filter((m) => m.alias).map((m) => [m.id, m.alias]));
  assert.deepEqual(alias(ix2), { escape: own.escape }, "v2: the mood's own name is kept as `alias` when the row's name is another one, so the search still finds \"full escape\"");
  assert.deepEqual(alias(ix), {}, "legacy: no alias");
  assert.deepEqual(ix2.moods.map((m) => m.label), menu.moods.map((m) => m.word), "the menu shows the words (Escape, Slow…), which the names do not touch");
  assert.equal(MOODS.find((m) => m.id === "escape").name, own.escape, "menuFor does not change the compiled mood it was given");
});

// Marco, 21/10/2026 ~22:15 UTC: the Tonight of the v2 Board writes the mood a pick was drawn for with the name of the mood's row in that Board when it has one. lib/rows.js writes "Tonight · <the mood's name>"; 4 of the 10 cards of the
// build of 21/10/2026 said "Full escape"/"Something wicked"/"Slow and still"/"Let it in" where the Board's rows are "Fun and adventure"/"Horror"/"Slow and quiet"/"Sad and beautiful". The fixture Board names the escape row "Fun and adventure"
// (the mood is "Full escape"); lift has no row there, so its pick keeps the mood's name; the legacy Tonight is not touched.
test("the v2 Tonight names the drawn mood by its Board row when it has one, the mood's own name when it has none; the legacy Tonight keeps the mood's name", () => {
  const drawn = (m) => ({ ...A, mood: `Tonight · ${m}` });
  const own = Object.fromEntries(MOODS.map((m) => [m.id, m.name]));
  assert.notEqual(own.escape, FIXTURE.names.escape, "the fixture is a mood whose Board name is another one");
  const plan = buildPlan({ moods: MOODS, rows: { ...ROWS, tonight: [drawn(own.escape), { ...B, mood: `Tonight · ${own.lift}` }, { ...C, mood: "Tonight · a name that is no mood" }] }, extra: EXTRA, sizes: SIZES, board: BD.parse({ ...CONFIG, board: V2_BOARD }) });
  assert.deepEqual(plan.board2.find((r) => r.id === "tonight").items.map((it) => it.mood), [`Tonight · ${FIXTURE.names.escape}`, `Tonight · ${own.lift}`, "Tonight · a name that is no mood"]);
  assert.deepEqual(plan.board.find((r) => r.id === "tonight").items.map((it) => it.mood), [`Tonight · ${own.escape}`, `Tonight · ${own.lift}`, "Tonight · a name that is no mood"], "the legacy Tonight is the same objects, unchanged");
});
