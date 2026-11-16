// node --test            (no dependencies)
// The Board of 54 rows in config.json (Marco, 13-14/10/2026, PR5 of the Board v2): the production config declares, in his order and under his names, the 54 rows of the manifest and the
// "Friends this week" option of the Moods menu; the 21 moods of the v2 family sit in "moods" and stay out of the legacy family through board.legacyMoods. This file reads config.json
// itself, not a fixture: the order and the names below are COPIED from the final Board of 13/10/2026 (PRODUCT.md, "Board of 54 rows"), so a row that moves or is renamed in config.json
// turns it red. The "mutations" test at the end keeps the build's first-step refusals (lib/board.js) honest for THIS config; the mutations of the nine moods are in the commit message. Parity of the legacy files with and without the board: test/legacy-parity.test.js ("PRODUCTION config"). The rows themselves: test/row-filters.test.js, test/board-combine.test.js,
// test/special-rows.test.js. The 21 moods against the v2.1 pin: test/v21-quality-integration.test.js (MOODS_AFTER_V23 in test-support/integration-reference.js).

const test = require("node:test");
const assert = require("node:assert/strict");

const BD = require("../lib/board");
const { legacyConfig } = require("../lib/board-shared");
const SR = require("../lib/special-rows");
const S = require("../lib/learning/schema");
const R = require("../test-support/integration-reference");
const { validateLists } = require("../lib/list-signal");

const CONFIG = require("../config.json");
const BOARD = CONFIG.board;
const clone = (x) => JSON.parse(JSON.stringify(x));

// the final Board of 13/10/2026: id → the name Stremio shows (the parenthesis of that table is a note, not part of the name).
// Marco, 21/10/2026 ~22:15 UTC (questionnaire): the five rows with a name of their own — escape "Fun and adventure", adrenaline "Action and thrills", wicked "Horror", letin "Sad and beautiful", slow "Slow and quiet" — KEEP those names. At ~19:40 UTC
// he had renamed them to their mood's name in config.json `moods` ("Full escape", "Adrenaline", "Something wicked", "Let it in", "Slow and still") on the premise that the Moods menu shows that name; it shows the mood's short word (Escape,
// Catharsis, Wicked, Slow, Adrenaline), so the premise was wrong and the rename was reverted. What the description's best-fit label writes for these five moods is the Board's name (lib/best-mood.js `rowNames`, test/best-mood.test.js).
const ROWS = [
  ["tonight", "🎯 Tonight: 10 picks"], ["watchlist", "📋 Your watchlist, newest first"], ["my-series", "📺 Series to watch"], ["top-picks", "⭐ Friend's top picks"],
  ["friends-watchlist", "🤝 Friends want to see this too"], ["newforyou", "🆕 New releases for you"], ["friends-love", "👥 Friends loved it"], ["short", "⏱️ Under 95 minutes"],
  ["escape", "🎳 Fun and adventure"], ["fromlists", "🎞️ Best of your lists"], ["directors", "🎬 From directors you love"], ["untried-directors", "🧭 Great directors you've never seen"],
  ["directors-loved", "🎥 Your directors' favourite films"], ["criterion", "📚 Criterion Closet picks"], ["awards", "🏆 Cannes, Venice and Berlin winners"], ["friends-split", "🆚 Friends can't agree"],
  ["comingofage", "🧒 Growing up"], ["oldfriends", "📼 Worth watching again"], ["small-kind", "🫂 Warm and gentle"], ["out-there", "🛣️ Journeys and far away"], ["visual", "🎨 Visually striking"],
  ["comedy", "😂 Comedy"], ["winter", "🎄 Winter and Christmas"], ["reinvent", "🧭 Starting over"], ["adrenaline", "🔥 Action and thrills"], ["wicked", "🎃 Horror"], ["swoon", "💘 Love stories"],
  ["twotalk", "🗣️ Two people talking"], ["midnight", "🌙 Cult and strange"], ["hidden", "💎 Hidden gems"], ["letin", "🌧️ Sad and beautiful"], ["after-midnight", "🌃 Night, crime and mystery"],
  ["anthology", "🧩 Anthology films"], ["slow", "🕯️ Slow and quiet"], ["docs", "🎥 Documentaries"], ["1970s", "🕰️ 1970s"], ["1980s", "📼 1980s"], ["1990s", "💿 1990s"], ["2000s", "📀 2000s"],
  ["2010s", "📱 2010s"], ["2020s", "🆕 2020s"], ["latin-america", "🌎 Latin America"], ["europe", "🇪🇺 Europe"], ["british", "🇬🇧 British and Irish cinema"], ["nordic", "🧊 Nordic countries"],
  ["eastern-bloc", "🧱 Eastern Europe and Russia"], ["middle-east", "🕌 Middle East"], ["india", "🇮🇳 India"], ["asia", "🌏 East and Southeast Asia"], ["africa", "🌍 Africa"],
  ["sight-sound", "🎓 Sight & Sound greatest films"], ["lb250", "🗳️ Letterboxd Top 250"], ["actor-week", "🧑‍🎤 Actor of the week"], ["friends-month", "📈 Friends watched this month"],
];
const LEGACY = ["lift", "escape", "reinvent", "letin", "night", "wicked", "wander", "slow", "music"];
const NEW_MOODS = ["noir", "whodunit", "mindbender", "lol", "deadpan", "gentle", "rainy", "road", "summer", "slasher", "horror-comedy", "adrenaline", "swoon", "twotalk", "comingofage", "docs", "midnight", "hidden", "anthology", "winter", "visual"];
const MENU_ONLY = ["lift", "night", "wander", "music", "noir", "whodunit", "mindbender", "lol", "deadpan", "gentle", "rainy", "road", "summer", "slasher", "horror-comedy"]; // components: only in the Moods menu

test("config.json declares the Board of 54 rows in Marco's order and under his names, plus Friends this week as an option of the Moods menu", () => {
  assert.equal(ROWS.length, 54);
  assert.deepEqual(BD.problems(CONFIG), [], "the board is sound for this config");
  assert.deepEqual(BOARD.order, [...ROWS.map(([id]) => id), "friends-week"]);
  assert.deepEqual(Object.entries(BOARD.names), [...ROWS, ["friends-week", "👥 Friends watched this week"]], "one name for every id of order, in order, and no other");
  assert.deepEqual(BOARD.place, { "friends-week": "menu" }, "the only row served as a Moods option alone");
  const spec = BD.parse(CONFIG);
  assert.equal(spec.entries.filter((e) => e.place === "board").length, 54);
  assert.deepEqual(spec.entries.filter((e) => e.place === "board").map((e) => e.id), ROWS.map(([id]) => id));
  assert.equal(new Set(ROWS.map(([, n]) => n)).size, 54, "no name twice");
  assert.equal(spec.entries.find((e) => e.id === "my-series").series, true, "the series row is the Worker's");
});

test("the nine moods of the legacy family are board.legacyMoods and the first nine of config.json; the 21 others exist in the v2 family alone", () => {
  assert.deepEqual(BOARD.legacyMoods, LEGACY);
  assert.deepEqual(CONFIG.moods.slice(0, 9).map((m) => m.id), LEGACY);
  assert.deepEqual(CONFIG.moods.slice(9).map((m) => m.id), NEW_MOODS);
  assert.deepEqual(legacyConfig(CONFIG).moods.map((m) => m.id), LEGACY);
  assert.equal("board" in legacyConfig(CONFIG), false, "the legacy config has no board");
  assert.deepEqual(BOARD.legacyMoods, S.MOODS, "the nine the learning schema, the profiles and the picker read");
  assert.equal(BOARD.moods, undefined, "the 21 are in config.json \"moods\" (the PR2 fixtures define them in board.moods instead)");
  for (const m of CONFIG.moods.slice(9)) {
    assert.ok(m.name && m.word && m.blurb, `${m.id}: name, word and blurb`);
    assert.equal(m.pins, undefined, `${m.id}: a pin of a v2 mood would be a film the legacy pool never had`);
    assert.ok(typeof m.minFit === "number", `${m.id}: minFit spelled out`);
  }
  // test-support/integration-reference.js MOODS_AFTER_V23 (the v2.1 pin runs with these switched off): every mood of config.json that is not in the reference is listed there, and only they
  assert.deepEqual([...R.MOODS_AFTER_V23].sort(), ["slow", ...NEW_MOODS].sort(), "the pin drops slow and the 21 moods of the v2 Board");
  assert.deepEqual(CONFIG.moods.map((m) => m.id).filter((id) => !LEGACY.includes(id) || id === "slow").sort(), [...R.MOODS_AFTER_V23].sort(), "no mood of config.json escapes the pin");
});

test("the Moods menu has the 30 moods, the nine of today first, and Friends this week; the components that leave the Board are only there", () => {
  assert.deepEqual(BOARD.moodMenu, [...LEGACY, "noir", "whodunit", "mindbender", "lol", "deadpan", "gentle", "rainy", "road", "summer", "slasher", "horror-comedy", ...NEW_MOODS.filter((id) => !["noir", "whodunit", "mindbender", "lol", "deadpan", "gentle", "rainy", "road", "summer", "slasher", "horror-comedy"].includes(id)), "friends-week"]);
  assert.equal(BOARD.moodMenu.length, 31);
  assert.deepEqual(BOARD.menuLabels, { "friends-week": "Friends this week" });
  for (const id of MENU_ONLY) {
    assert.ok(BOARD.moodMenu.includes(id), `${id} is a Moods option`);
    assert.ok(!BOARD.order.includes(id), `${id} is not a Board row (the Discover keeps it, the Board mixes it)`);
  }
  for (const m of CONFIG.moods) assert.ok(BOARD.moodMenu.includes(m.id), `${m.id} is in the menu`);
});

test("regions, countries and the recipes of the rows: the decisions of Marco are in config.json", () => {
  assert.equal(BOARD.countries.length, 46);
  assert.equal(new Set(BOARD.countries).size, 46);
  const rows = Object.fromEntries(BOARD.rows.map((r) => [r.id, r]));
  for (const d of ["1970s", "1980s", "1990s", "2000s", "2010s", "2020s"]) assert.deepEqual(Object.keys(rows[d].where), ["years"], `${d}: years alone, any country and any genre`);
  assert.deepEqual(rows["2020s"].where.years, { min: 2020, max: 2029 });
  for (const r of ["europe", "british", "nordic", "eastern-bloc", "middle-east", "india", "asia", "africa"]) assert.deepEqual(rows[r].where, { region: r });
  assert.deepEqual(rows["brazil-now"].where, { countries: ["BR"], years: { min: 2001 } }, "Brazil includes 2001-2004 (Marco, 13/10/2026)");
  assert.deepEqual(rows["latin-america"].parts, ["brazil-now", "brazil-classic", "latam-hisp"], "equal shares: no boost, no tune");
  assert.equal(rows["latin-america"].boost, undefined);
  assert.deepEqual(rows["small-kind"], { id: "small-kind", kind: "combine", parts: ["gentle", "lift", "rainy"], boost: [{ part: "rainy", weekdays: [0], x: 2 }] }, "more weight on Sundays");
  assert.deepEqual(rows["out-there"].boost, [{ part: "summer", months: [12, 1, 2], x: 2 }], "more weight from December to February");
  assert.deepEqual(rows["after-midnight"].parts, ["night", "noir", "whodunit", "mindbender"]);
  assert.equal(rows["after-midnight"].tune, "taste");
  assert.deepEqual(rows.comedy.parts, ["lol", "deadpan"]);
  assert.deepEqual(rows.wicked.parts, ["wicked", "slasher", "horror-comedy"]);
  assert.equal(rows.hidden, undefined, "Hidden gems is a mood with a where gate, not a recipe of rows");
  const hidden = CONFIG.moods.find((m) => m.id === "hidden");
  assert.deepEqual(hidden.where, { lb: { min: 3.8 }, lbCount: { max: 9999 } });
});

test("the ten special rows carry the parameters Marco decided", () => {
  const rows = Object.fromEntries(BOARD.rows.map((r) => [r.id, r]));
  assert.deepEqual(rows["top-picks"].people, ["friend-f", "friend-g", "friend-a", "friend-e", "friend-d", "friend-c", "friend-b"]); // Marco, 29/10/2026: the seventh, friend-b, enters the daily rotation (six until then)
  assert.equal(rows["top-picks"].size, 100); // Marco, 14/11/2026: "Up to 100 in every row" (60 until then)
  assert.equal(rows["top-picks"].minStars, 4.5);
  assert.equal(rows["top-picks"].fillStars, 4, "completed with the 4-star films up to 100");
  assert.deepEqual([rows["friends-split"].minRatings, rows["friends-split"].minSd], [3, 1.0]);
  assert.equal(rows["friends-month"].days, 30);
  assert.deepEqual([rows["untried-directors"].minFilms, rows["untried-directors"].minStars, rows["untried-directors"].perDirector, rows["untried-directors"].rotate], [3, 3.8, 3, "week"]);
  assert.deepEqual([rows["actor-week"].minRated, rows["actor-week"].minAvg, rows["actor-week"].minEligible], [3, 4, 5]);
  assert.equal(rows["friends-watchlist"].onlyConfiguredFriends, false, "everybody he follows");
  assert.deepEqual(rows.criterion.listIds, ["snFyM", "tp03m"]);
  assert.deepEqual(rows["sight-sound"].listIds, ["jlyNq", "jrR92"]);
  assert.deepEqual(rows.lb250.listIds, ["nVqt6"]);
  assert.deepEqual(rows.awards.sources.map((s) => s.label), ["Cannes", "Venice", "Berlin"]);
  assert.deepEqual(rows.awards.sources[0].prizes, SR.CANNES_PRIZES, "Cannes: Palme d'Or, Grand Prix, Jury Prize only");
  for (const id of Object.keys(rows)) if (SR.KINDS.includes(rows[id].kind)) assert.ok(BOARD.order.includes(id), `${id} is on the Board`);
});

test("Visually striking: the three lists of cinematography, the image directors and the keywords the cache has", () => {
  const lists = Object.fromEntries(CONFIG.lists.map((l) => [l.id, l]));
  assert.equal(CONFIG.lists.length, 147); // 142 + the four TSPDT top 250 lists (Marco, 22/10/2026) + the Beyond the Sight & Sound Canon A-List (Marco, 22/10/2026 ~15:05 UTC)
  assert.deepEqual(["GAsK", "2mL0U", "100b4"].map((id) => lists[id] && lists[id].trust), ["fan", "critic", "fan"], "GAsK is fan until Marco decides (it is a poll of critics, but the poll's tail is single votes); the ASC list is the guild's");
  assert.deepEqual(lists["2mL0U"].checked, { on: "2026-10-13", films: 100 });
  assert.doesNotThrow(() => validateLists(CONFIG.lists), "every list has its trust and a name of its own");
  const names = CONFIG.lists.map((l) => l.name);
  assert.equal(new Set(names).size, names.length, "the Discover menu needs a name per list");
  const visual = CONFIG.moods.find((m) => m.id === "visual");
  assert.deepEqual(Object.keys(visual.lists).sort(), ["100b4", "2mL0U", "GAsK"]);
  for (const id of Object.keys(visual.lists)) assert.ok(lists[id], `${id} is a list of config.json`);
  assert.ok(Object.keys(visual.directors).length >= 9, "Wong Kar-wai, Malick, Villeneuve, Refn, Kubrick, Zhang Yimou, Wes Anderson, Tarsem, Jodorowsky");
  assert.ok(Object.keys(visual.keywords).length >= 8);
});

// Marco, 14/10/2026, questionnaire on the front shuffle (spec 2026-10-14-shuffle-inteligente-spec.md, section 7): strong intensity (tau 15, penalty 10), the memory of what was up front saved
// once a night in cache/front-memory.json, a film in the first screen of at most 3 rows a day and opening at most 1, Tonight and the Watchlist left out, the front is the first 8 places.
// The last two knobs are the spec's fixed ones (7 days, half-life 2 days). A number changed here without his answer turns this red.
test("config.json board.shuffle is exactly what Marco decided on 14/10/2026", () => {
  assert.deepEqual(BOARD.shuffle, { front: 8, tau: 15, penalty: 10, maxFronts: 3, maxLeads: 1, memory: "file", memoryDays: 7, halfLifeDays: 2, keep: ["tonight", "watchlist"] });
  assert.deepEqual(BD.parse(CONFIG).shuffle, BOARD.shuffle, "and parse() hands it to the build as it is (no default adds or changes a knob)");
  assert.ok(!JSON.stringify(legacyConfig(CONFIG)).includes("shuffle"), "the legacy config has no board, so the legacy family never reads the shuffle");
});

// A recipe of the Board that has gone wrong must stop the build at its first step: the mutations of PR5, in memory.
test("mutations of the production board in memory: an id outside order, a name twice, a row without a name, a row outside order", () => {
  const patched = (f) => { const c = clone(CONFIG); f(c.board); return c; };
  assert.match(BD.problems(patched((b) => { b.order.push("nope"); b.names.nope = "Nope"; })).join("\n"), /order: "nope" is not a row the build can make/);
  assert.match(BD.problems(patched((b) => { b.names.europe = b.names.british; })).join("\n"), /are both called/);
  assert.match(BD.problems(patched((b) => { delete b.names.africa; })).join("\n"), /names: "africa" has no name/);
  assert.match(BD.problems(patched((b) => { b.order = b.order.filter((id) => id !== "africa"); })).join("\n"), /names: "africa" is not in order|rows\[\d+\] \(africa\): "africa" is not in order/);
});

// Found 14/10/2026 (PR5): with the board in config.json, a --skip-friends build (the tests of the search links, of the learning replay and of the legacy manifest all use it; the legacy manifest and the replay depend on this block) stopped at index-v2 with
// "meta.countriesAll names Chile, and no film of the index has that country": 1,100 films cannot fill the frozen country menu. build.js leaves the board of config.json out of such a build (BOARD_SKIPPED).
// Mutation: delete the BOARD_SKIPPED block of build.js → this test, test/review-replay.test.js "skip-friends selection…" and the offline build of test/friends.test.js turn red (test/search-link.test.js does NOT: its --skip-friends build fails on the awards leak of test/special-rows.test.js, not on the country menu).
test("a --skip-friends build leaves the board of config.json out and publishes the legacy family alone; a board named with --board stays", { timeout: 300000 }, () => {
  const fs = require("fs"), os = require("os"), path = require("path"), { spawnSync } = require("child_process");
  const ROOT = path.join(__dirname, "..");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mood-skip-board-"));
  try {
    fs.mkdirSync(path.join(work, "cache"));
    for (const n of fs.readdirSync(path.join(ROOT, "cache"))) if (n.endsWith(".json")) fs.copyFileSync(path.join(ROOT, "cache", n), path.join(work, "cache", n));
    const run = (name, extra) => {
      const out = path.join(work, name);
      const r = spawnSync(process.execPath, [path.join(ROOT, "build.js"), "--offline", "--skip-friends", "--skip-posters", "--date", "2026-10-14", "--captured-at", "2026-10-14T12:00:00.000Z", "--cache-dir", path.join(work, "cache"), "--out", out, ...extra], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" } });
      assert.equal(r.status, 0, `${name}: the build failed\n${(r.stderr || "").slice(-1500)}\n${(r.stdout || "").slice(-800)}`);
      return { out, log: r.stdout };
    };
    const plain = run("plain", []);
    assert.match(plain.log, /config\.json's board is left out of a --skip-friends build/);
    assert.deepEqual(fs.readdirSync(path.join(plain.out, "data")).filter((f) => /^index-v2/.test(f)), [], "no file of the v2 family");
    assert.equal(JSON.parse(fs.readFileSync(path.join(plain.out, "manifest.json"), "utf8")).catalogs.some((c) => c.id === "europe"), false);
    const rehearsal = run("rehearsal", ["--board", path.join(__dirname, "fixtures", "board-v2-pr3.json")]);
    assert.doesNotMatch(rehearsal.log, /left out of a --skip-friends build/);
    assert.ok(fs.existsSync(path.join(rehearsal.out, "data", "index-v2-menus.json")), "a board the caller names is built");
    // 22/10/2026: this build read no lists, so the Discover by subject (data/discover-catalogs.json, whose options point at lists) has nothing to point at: it is left out and says so, and the build does not stop
    assert.match(rehearsal.log, /Discover: left out of this build, which read no lists/);
    assert.equal("discover" in JSON.parse(fs.readFileSync(path.join(rehearsal.out, "data", "index-v2-menus.json"), "utf8")), false);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
