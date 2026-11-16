// node --test
// Marco, 13/10/2026 (two decisions, both in config.json):
//  A. Tonight holds 10 films (sizes.tonight 6 → 10). There are 9 moods, so lib/rows.js walks the daily sequence again and takes the next best
//     film of each mood until the row is full. With sizes.tonight 6 the row is what it was before (same seed, same films).
//     Since 14/11/2026 the draw is over a mood's top 40 and remembers 30 days (test/tonight-memory.test.js); the rows fixed here on the 13/10 code are the rows of tonight.depth 12 with no memory.
//  B. exclude.films: IMDb ids that are never recommended (scope narrowed the same day: Search, Explore and the list catalogs keep the film) (lib/exclude.js, build.js). Paterson, tt5247022, is the first.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { buildRows } = require("../lib/rows");
const { compile } = require("../lib/moods");
const EX = require("../lib/exclude");
const { decode } = require("../lib/index-rows");

const ROOT = path.join(__dirname, "..");
const tmp = (p = "mood-ex-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

// ── A. Tonight ───────────────────────────────────────────────────────────────────────────────────

// nine moods (October: "wicked" is the seasonal one), 14 films each, every film in the genre of one mood only
const MOOD_IDS = ["lift", "escape", "reinvent", "letin", "night", "wicked", "wander", "slow", "music"];
const moods = compile(MOOD_IDS.map((id, i) => ({ id, name: id.toUpperCase(), word: id, genres: { ["G" + i]: 2 }, keywords: {}, minFit: 1, ...(id === "wicked" ? { season: [10] } : {}) })));
let n = 0;
const pool = MOOD_IDS.flatMap((id, i) => Array.from({ length: 14 }, (_, j) => {
  const k = ++n;
  return { id: k, film: { id: k, imdb: "tt" + (1000 + k), title: "F" + k, year: 2000, genres: ["G" + i], keywords: [], directors: [{ id: k, name: "D" + k }], cast: [], countries: [], va: 7, vc: 500, overview: "" },
    tasteZ: 3 - j * 0.1 + i * 0.01, qualityZ: 0, recCount: 0, seeds: [], pins: [], contributions: [] };
}));
const sizes = (tonight) => ({ tonight, row: 30, discover: 60, because: 20, directors: 24, oldFriends: 24, watchlist: 40 });
const tonightOf = (size, today = "2026-10-13", p = pool, extra = {}) => buildRows({ pool: p, rewatch: [], moods, cfg: { sizes: sizes(size), build: { directors: 15 }, ...extra }, model: { stats: new Map() }, recentSeeds: [], today }).rows.tonight;
const moodOfItem = (it) => MOOD_IDS[Number(it.genres[0].slice(1))];

// Marco, 19/10/2026: the draw is uniform now (config tonight.bias 1, the default of a config without the key), so the rows fixed on the 13/10 code are the rows of
// tonight.bias 1.6, the exponent the code had then: the knob reproduces them exactly (test/tonight-draw.test.js holds the uniform draw itself).
// Marco, 14/11/2026: and of tonight.depth 12, the pool that code drew from (40 now; these worlds have 14 films a mood, so the default would draw from all fourteen).
const OLD_DRAW = { tonight: { bias: 1.6, depth: 12 } };
test("Tonight with sizes.tonight 6 is what it was before the extension: the same six films for the same seed (fixed on the code of origin/main, 13/10/2026; with the 1.6 exponent of that code)", () => {
  assert.deepEqual(tonightOf(6, "2026-10-13", pool, OLD_DRAW).map((x) => x.id), ["tt1004", "tt1043", "tt1072", "tt1029", "tt1059", "tt1021"]);
  assert.deepEqual(tonightOf(6, "2026-10-13", pool, OLD_DRAW).map((x) => moodOfItem(x)), ["lift", "letin", "wicked", "reinvent", "night", "escape"]);
  // the nine of the first pass are the first nine of any larger row: the extension only adds
  assert.deepEqual(tonightOf(9).map((x) => x.id).slice(0, 6), tonightOf(6).map((x) => x.id));
});

test("Tonight with sizes.tonight 10 and nine moods: ten distinct films, the first nine from nine different moods, the tenth from the first mood of the sequence (the best of that mood not in the row yet)", () => {
  const t = tonightOf(10);
  assert.equal(t.length, 10);
  assert.equal(new Set(t.map((x) => x.id)).size, 10, "no film twice");
  assert.equal(new Set(t.slice(0, 9).map(moodOfItem)).size, 9, "the first nine come from nine moods");
  assert.deepEqual(t.slice(0, 9).map((x) => x.id), tonightOf(9).map((x) => x.id), "the first pass is the one of before");
  // the second pass starts at the first mood of the sequence (lift) and takes that mood's best film that is still free, no draw
  const lift = pool.filter((c) => c.film.genres[0] === "G0").sort((a, b) => b.tasteZ - a.tasteZ).map((c) => c.film.imdb);
  assert.equal(moodOfItem(t[0]), "lift");
  assert.equal(t[9].id, lift.find((id) => id !== t[0].id));
  assert.equal(t[9].mood, "Tonight · LIFT", "the reason line of a Tonight film starts with the row and the mood (Marco, 13/10/2026)");
  assert.ok(t.every((x) => !x.why.some((w) => /pick for/.test(w))), "no 'pick for <weekday>' any more");
  assert.deepEqual(tonightOf(10), t, "deterministic: same seed, same row");
  assert.notDeepEqual(tonightOf(10, "2026-10-14").map((x) => x.id), t.map((x) => x.id), "and it still rotates with the day");
});

test("Tonight asked for more than the pool holds stops when no mood has a film left; a size above the moods fills through several passes", () => {
  assert.equal(tonightOf(30).length, 30, "three passes over nine moods");
  assert.equal(new Set(tonightOf(30).map((x) => x.id)).size, 30);
  const small = pool.filter((c) => c.film.genres[0] === "G0" || c.film.genres[0] === "G1").slice(0, 5); // two moods, five films in all
  assert.equal(tonightOf(10, "2026-10-13", small).length, 5, "nothing to take any more: no endless loop, no repeated film");
});

// ── B. exclude.films ─────────────────────────────────────────────────────────────────────────────

test("exclude.films: absent or empty is no exclusion; ids are tt + digits; anything else stops the build with a message that names the value", () => {
  assert.deepEqual([...EX.parse(undefined)], []);
  assert.deepEqual([...EX.parse({})], []);
  assert.deepEqual([...EX.parse({ films: [] })], []);
  assert.deepEqual([...EX.parse({ films: ["tt5247022", "tt0000001"] })], ["tt5247022", "tt0000001"]);
  for (const bad of ["5247022", "tt", "TT5247022", "tt52470a2", " tt5247022", 5247022, null, "Paterson"])
    assert.throws(() => EX.parse({ films: ["tt0000001", bad] }), (e) => e.message.includes("exclude.films") && e.message.includes(JSON.stringify(bad)) && /tt followed by digits/.test(e.message), `a bad id: ${JSON.stringify(bad)}`);
  assert.throws(() => EX.parse({ films: "tt5247022" }), /exclude\.films must be a list/);
  assert.throws(() => EX.parse(["tt5247022"]), /exclude must be/);
  assert.throws(() => EX.parse(null), /exclude must be/);
  assert.deepEqual([...EX.parse(JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")).exclude)], ["tt5247022"], "Paterson is in the config");
});

// Marco, 15/11/2026 (questionnaire): "Keep the pins, except Paterson". The pins stay, even where a film is below its mood's minimum (Local Hero, Shall We Dance?, Tampopo, the five of Slow and
// still): a pin is his choice by hand and beats the keywords. Paterson's two pins go, because Paterson is in exclude.films: until then config.json pinned it to lift and to reinvent and the build
// took it out of the candidates before any ranking, without a word. A film in both lists now stops the build.
test("no film is pinned and excluded at once: config.json has none (Paterson left the pins of lift and reinvent), the check names every such film with its moods, and the other pins stay", () => {
  const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")), excluded = EX.parse(CONFIG.exclude);
  const pinsOf = (id) => CONFIG.moods.find((m) => m.id === id).pins;
  assert.deepEqual([...excluded], ["tt5247022"], "Paterson is still never recommended");
  assert.deepEqual(EX.pinnedAndExcluded(excluded, CONFIG.moods), []);
  assert.doesNotThrow(() => EX.assertNotPinned(excluded, CONFIG.moods));
  // the pins Marco keeps (15/11/2026): Shall We Dance?, Tampopo, Local Hero in lift; Shall We Dance? and Local Hero in reinvent; the five of slow. No mood lost another film
  assert.deepEqual(pinsOf("lift"), ["tt0117615", "tt0092048", "tt0085859"]);
  assert.deepEqual(pinsOf("reinvent"), ["tt0117615", "tt0085859"]);
  assert.deepEqual(pinsOf("slow"), ["tt0079944", "tt0046438", "tt0377556", "tt1588895", "tt0120265"]);
  assert.deepEqual(CONFIG.moods.filter((m) => m.pins).map((m) => m.id), ["lift", "reinvent", "slow"], "and no other mood has pins");
  // the check itself
  const moods = [{ id: "a", pins: ["tt1", "tt2"] }, { id: "b" }, { id: "c", pins: ["tt2", "tt3"] }];
  assert.deepEqual(EX.pinnedAndExcluded(new Set(["tt2", "tt9"]), moods), [{ id: "tt2", moods: ["a", "c"] }]);
  assert.deepEqual(EX.pinnedAndExcluded(new Set(["tt1", "tt3"]), moods), [{ id: "tt1", moods: ["a"] }, { id: "tt3", moods: ["c"] }]);
  assert.deepEqual(EX.pinnedAndExcluded(new Set(), moods), []);
  assert.deepEqual(EX.pinnedAndExcluded(new Set(["tt1"]), undefined), [], "a config with no moods");
  assert.throws(() => EX.assertNotPinned(new Set(["tt2"]), moods), /config\.json: tt2 is in exclude\.films and in the pins of "a", "c"\. A film that is never recommended cannot be pinned to a mood/);
  assert.throws(() => EX.assertNotPinned(new Set(["tt1", "tt3"]), moods), /tt1 is in exclude\.films and in the pins of "a"; tt3 is in exclude\.films and in the pins of "c"\./);
  // what config.json was until 15/11/2026: the check would have stopped it
  const before = CONFIG.moods.map((m) => (m.id === "lift" || m.id === "reinvent" ? { ...m, pins: ["tt5247022", ...m.pins] } : m));
  assert.throws(() => EX.assertNotPinned(excluded, before), /tt5247022 is in exclude\.films and in the pins of "lift", "reinvent"/);
});

test("build.js stops at its first step when a film is pinned and excluded, naming the film and the moods, before any cache is read or any file written", { timeout: 120000 }, () => {
  const dir = tmp("mood-ex-pin-");
  try {
    const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
    const attempt = (cfg) => {
      const file = path.join(dir, "c.json");
      fs.writeFileSync(file, JSON.stringify(cfg));
      return spawnSync(process.execPath, [path.join(ROOT, "build.js"), "--offline", "--cache-only", "--skip-posters", "--config", file, "--cache-dir", path.join(dir, "cache"), "--out", path.join(dir, "out")], { cwd: ROOT, encoding: "utf8", env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "", FRONT_MEMORY_WRITE: "", TONIGHT_MEMORY_WRITE: "" } });
    };
    // Shall We Dance? is pinned to lift and to reinvent: excluding it without taking the pins out is the mistake of Paterson again
    const r = attempt({ ...CONFIG, exclude: { films: ["tt5247022", "tt0117615"] } });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /✖ config\.json: tt0117615 is in exclude\.films and in the pins of "lift", "reinvent"\./);
    assert.equal(r.stdout, "", "before the first line of the log");
    assert.deepEqual(fs.readdirSync(dir), ["c.json"], "no cache folder, no output folder");
    // the config as it was until 15/11/2026
    const old = attempt({ ...CONFIG, moods: CONFIG.moods.map((m) => (m.id === "lift" ? { ...m, pins: ["tt5247022", ...m.pins] } : m)) });
    assert.equal(old.status, 1);
    assert.match(old.stderr, /tt5247022 is in exclude\.films and in the pins of "lift"/);
  } finally { rm(dir); }
});

// Marco, 15/11/2026: a film in a mood's pins cannot be excluded (the build stops), so the builds below that exclude films of the real rows leave the pinned ones out of what they exclude.
const PINNED = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")).moods.flatMap((m) => m.pins || []));

const have = ["friends.json", "lists.json", "tmdb.json", "imdb-ratings.json"].every((f) => fs.existsSync(path.join(ROOT, "cache", f)));

/**
 * The real build.js, offline from the caches, with config.json's `exclude` replaced through a preload (the file on disk is not touched). → { out, status, stderr, memoryAfter }.
 * memory (14/11/2026): the text of a tonight-memory.json planted in the build's own cache folder (lib/tonight-memory.js), env: more environment for the build; memoryAfter is that file's text when the build ended (null: no such file).
 * The five caches are copied BY NAME: the repository's own tonight-memory.json and front-memory.json never reach these builds.
 */
function build(exclude, { memory = null, env = {} } = {}) {
  const out = tmp(), cache = tmp("mood-ex-cache-"), pre = path.join(tmp("mood-ex-pre-"), "pre.js");
  for (const f of ["friends.json", "lists.json", "tmdb.json", "directors.json", "imdb-ratings.json"]) fs.copyFileSync(path.join(ROOT, "cache", f), path.join(cache, f));
  const memoryFile = path.join(cache, "tonight-memory.json");
  if (memory != null) fs.writeFileSync(memoryFile, memory);
  fs.writeFileSync(pre, `const fs = require("fs"), real = fs.readFileSync, cfg = ${JSON.stringify(path.join(ROOT, "config.json"))};
fs.readFileSync = function (p, ...r) { if (p === cfg) { const c = JSON.parse(real.call(fs, p, "utf8")); c.exclude = JSON.parse(process.env.ME_EXCLUDE); return JSON.stringify(c); } return real.call(fs, p, ...r); };`);
  const r = spawnSync(process.execPath, ["-r", pre, "build.js", "--offline", "--cache-only", "--cache-dir", cache, "--out", out], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "", FRONT_MEMORY_WRITE: "", TONIGHT_MEMORY_WRITE: "", MOOD_DATE: "2026-10-13", ME_EXCLUDE: JSON.stringify(exclude), ...env } });
  const memoryAfter = fs.existsSync(memoryFile) ? fs.readFileSync(memoryFile, "utf8") : null;
  rm(cache); rm(path.dirname(pre));
  return { out, status: r.status, stderr: r.stderr + r.stdout, memoryAfter };
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
/** every catalog file of the static addon: { dir ("tonight", "mood-engine-lists" …) → Set of ids } */
function catalogs(out) {
  const base = path.join(out, "catalog", "movie"), res = {};
  const walk = (d, key) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(d, e.name), e.name);
    else if (e.name.endsWith(".json")) (res[key] ||= new Set()), readJson(path.join(d, e.name)).metas.forEach((m) => res[key].add(m.id)); } };
  for (const e of fs.readdirSync(base, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(base, e.name), e.name);
    else (res[e.name.replace(/\.json$/, "")] ||= new Set()), readJson(path.join(base, e.name)).metas.forEach((m) => res[e.name.replace(/\.json$/, "")].add(m.id));
  }
  return res;
}
// the catalogs of the static addon that recommend: an excluded film leaves them; every other Discover file keeps what it had
const RECOMMENDING = ["mood-engine", "mood-engine-directors-loved"];
let plain = null; // the build with nothing excluded, made once for the two tests that compare with it
const baseline = () => (plain ||= build({ films: [] }));
test.after(() => { if (plain) rm(plain.out); });

// Marco, 14/11/2026 ("Bigger pool + 30 days without repeating"): the executed proof that build.js hands the memory to the draw and writes nothing outside the scheduled night. The rule itself,
// on worlds made by hand, is test/tonight-memory.test.js. No number of the real caches is fixed here: the build with a memory is compared with the same build without one.
test("build --cache-only with a planted tonight-memory.json: none of the ten films the memory says were shown yesterday is in Tonight, the row still has ten, today's own entry is not read, and neither build writes the file (needs the caches)", { skip: !have && "no caches", timeout: 300000 }, () => {
  const base = baseline();
  assert.equal(base.status, 0, base.stderr);
  const bIx = decode(readJson(path.join(base.out, "data", "index.json")));
  assert.equal(bIx.rows.tonight.length, 10);
  assert.match(base.stderr, /Tonight memory: 0 days read, 0 films held back \(shown in Tonight in the last 30 days\)/);
  assert.match(base.stderr, /Tonight: 10 of 10 films, drawn from the top 40 of each mood, 0 held back by the memory/);
  assert.match(base.stderr, /Tonight memory: not written \(TONIGHT_MEMORY_WRITE is not 1: only a build that publishes writes\)/);
  assert.equal(base.memoryAfter, null, "a build of a test leaves no memory file in its cache folder");
  let mem;
  try {
    // yesterday (2026-10-12) Tonight showed the ten films the plain build draws for 2026-10-13; the entry of 2026-10-13 itself names a film the plain build does NOT have in Tonight and must not be read
    const other = bIx.rows.lift.find((tt) => !bIx.rows.tonight.includes(tt));
    const planted = `{"version":1,"days":{\n"2026-10-12":${JSON.stringify(bIx.rows.tonight)},\n"2026-10-13":${JSON.stringify([other])}\n}}\n`;
    mem = build({ films: [] }, { memory: planted, env: { TONIGHT_MEMORY_WRITE: "1" } });
    assert.equal(mem.status, 0, mem.stderr);
    const mIx = decode(readJson(path.join(mem.out, "data", "index.json")));
    assert.equal(mIx.rows.tonight.length, 10, "ten films still");
    assert.equal(new Set(mIx.rows.tonight).size, 10);
    assert.deepEqual(mIx.rows.tonight.filter((tt) => bIx.rows.tonight.includes(tt)), [], "no film of yesterday's Tonight");
    assert.match(mem.stderr, /Tonight memory: 1 day read \(2026-10-12 to 2026-10-12\), 10 films held back/, "today's own entry is not one of the days read");
    assert.match(mem.stderr, /Tonight: 10 of 10 films, drawn from the top 40 of each mood, 10 held back by the memory/);
    assert.match(mem.stderr, /Tonight memory: not written \(--cache-only writes no cache\)/, "TONIGHT_MEMORY_WRITE=1 reached the step, and --cache-only still wrote nothing");
    assert.equal(mem.memoryAfter, planted, "the file is as it was");
    // the v2 Board's Tonight is the same row, and every other row of the LEGACY Board holds the films it held, in the order it held them. That is all this asserts: in the shuffled v2 Board the front of
    // another row can change with Tonight (its first screen counts for the cap across rows of lib/front-shuffle.js; review of 14/11/2026: 1 of 53 rows on the real Board), and nothing here compares the v2 rows.
    const row2 = (out) => readJson(path.join(out, "data", "index-v2-row-tonight.json")).rows.tonight;
    assert.deepEqual(row2(mem.out), mIx.rows.tonight);
    assert.deepEqual(row2(base.out), bIx.rows.tonight);
    for (const id of Object.keys(bIx.rows)) if (id !== "tonight") assert.deepEqual(mIx.rows[id], bIx.rows[id], `row ${id}`);
  } finally { if (mem) rm(mem.out); }
});

test("applyToPlan: every Board row and the two recommending Discover catalogs lose the film; the cuts, the lists and the friends keep it", () => {
  const it = (id) => ({ id }), items = () => [it("tt1"), it("tt2"), it("tt3")];
  const plan = { board: [{ id: "tonight", items: items() }, { id: "short", items: items() }], discover: ["mood-engine", "mood-engine-directors-loved", "mood-engine-decade", "mood-engine-country", "mood-engine-lists", "mood-engine-lists-unseen", "mood-engine-friends"].map((id) => ({ id, options: [{ label: "x", items: items() }] })) };
  EX.applyToPlan(plan, new Set(["tt2"]));
  assert.deepEqual(plan.board.map((r) => r.items.map((x) => x.id)), [["tt1", "tt3"], ["tt1", "tt3"]]);
  assert.deepEqual(plan.discover.map((c) => [c.id, c.options[0].items.length]), [["mood-engine", 2], ["mood-engine-directors-loved", 2], ["mood-engine-decade", 3], ["mood-engine-country", 3], ["mood-engine-lists", 3], ["mood-engine-lists-unseen", 3], ["mood-engine-friends", 3]]);
  const same = structuredClone(plan); EX.applyToPlan(same, new Set());
  assert.deepEqual(same, plan, "nothing excluded: nothing touched");
});

test("build --cache-only with exclude.films: the film leaves every Board row, the moods (rows, picker, the index's membership) and the mood and director catalogs, the rows at their ceiling refill (one under it is one shorter, or as long when a per-director or per-seed limit lets another film in); Search, Explore (eligible), the cuts and the three list catalogs keep it (needs the caches)", { skip: !have && "no caches", timeout: 300000 }, () => {
  const base = baseline();
  assert.equal(base.status, 0, base.stderr);
  let ex;
  try {
    const bIx = decode(readJson(path.join(base.out, "data", "index.json"))), bCat = catalogs(base.out);
    // the target: a film the plain build puts in Tonight, that a list holds and that fits a mood (so every place it must leave is a place it is in)
    const byTt = new Map(bIx.films.map((f) => [f.tt, f]));
    const target = bIx.rows.tonight.find((tt) => !PINNED.has(tt) && bCat["mood-engine-lists"].has(tt) && byTt.get(tt).eligible && Object.keys(byTt.get(tt).moods || {}).length);
    assert.ok(target, "the control needs a Tonight film that is not pinned, that a list holds and a mood fits");
    // control: with no exclusion the film is where the test will look for it to be gone
    const boardRowsWith = Object.keys(bIx.rows).filter((id) => bIx.rows[id].includes(target));
    assert.ok(boardRowsWith.includes("tonight"));
    assert.ok(RECOMMENDING.some((k) => bCat[k].has(target)), "control: a mood or director catalog holds the film when nothing is excluded");
    const bWeb = readJson(path.join(base.out, "data", "engine.json"));
    assert.ok(bWeb.films.some((x) => x.i === target), "control: the picker offers the film when nothing is excluded");

    ex = build({ films: [target] });
    assert.equal(ex.status, 0, ex.stderr);
    const xIx = decode(readJson(path.join(ex.out, "data", "index.json"))), xCat = catalogs(ex.out);
    // gone from every Board row, the index's and the static addon's
    for (const [id, tts] of Object.entries(xIx.rows)) assert.ok(!tts.includes(target), `row ${id} still holds ${target}`);
    for (const r of xIx.board) assert.ok(!xCat[r.id].has(target), `static ${r.id}`);
    // gone from the mood and director catalogs ...
    for (const k of RECOMMENDING) assert.ok(!xCat[k].has(target), `catalog ${k} still holds ${target}`);
    // ... and from NO other file: each of the others holds it exactly when it did (the cuts by decade, country, rating, runtime, and the lists)
    for (const k of Object.keys(bCat)) if (!RECOMMENDING.includes(k) && !xIx.board.some((r) => r.id === k)) assert.equal(xCat[k].has(target), bCat[k].has(target), `catalog ${k}`);
    assert.ok(xCat["mood-engine-lists"].has(target), "the list catalog still holds the film");
    // the index: the film is there and eligible (Search and Explore keep it), but belongs to no mood (the Worker builds Moods and the profiles' Tonight from that)
    const e = xIx.films.find((f) => f.tt === target);
    assert.ok(e, "the film is still in the index");
    assert.equal(e.eligible, true, "eligible is untouched: Search and Explore still serve it");
    assert.deepEqual(e.moods || {}, {}, "no mood membership");
    assert.ok(Object.keys(byTt.get(target).moods).length > 0, "control: it had one");
    // nobody else changed eligibility, and the rows refilled to the length they had
    const eligible = (ix) => ix.films.filter((f) => f.eligible).map((f) => f.tt).sort();
    assert.deepEqual(eligible(xIx), eligible(bIx));
    // a row at its ceiling (Tonight's 10, any other row's 100) refills. A row under it (14/11/2026: Starting over has 91 since the whole-keyword fit) already held every film it may take:
    //   with no limit per director or per seed it is exactly one shorter; with one (every mood row: 2 per director; Directors you trust: 3; Because you loved: 6 per seed; Loved by your
    //   directors: 2) a film the limit held back may take the place, so it is one shorter or as long as before, never longer
    const LIMITED = (id) => ["directors", "because", "directors-loved"].includes(id) || Object.keys(byTt.get(target).moods || {}).includes(id) || /^(lift|escape|reinvent|letin|night|wicked|wander|slow|music)$/.test(id);
    for (const id of boardRowsWith) {
      const had = bIx.rows[id].length, now = xIx.rows[id].length, full = had === (id === "tonight" ? 10 : 100);
      if (full) assert.equal(now, had, `row ${id} refilled`);
      else if (!LIMITED(id)) assert.equal(now, had - 1, `row ${id} (under its ceiling, ${had}, no per-director or per-seed limit) loses the film and has nothing to refill with`);
      else assert.ok(now === had || now === had - 1, `row ${id} (under its ceiling, ${had}, with a per-director or per-seed limit): ${now}`);
    }
    assert.equal(xIx.rows.tonight.length, 10);
    // the picker (web data) does not offer it either
    const web = readJson(path.join(ex.out, "data", "engine.json"));
    assert.ok(!(web.films || []).some((x) => x.i === target) && !(web.rewatch || []).some((x) => x.i === target));
  } finally { if (ex) rm(ex.out); }
});

test("build --cache-only with exclude.films: the first film of EVERY Board row (the first that is not pinned: a pinned film cannot be excluded since 15/11/2026) is excluded at once, so the rows that are not made from the candidate pool (short, new for you, loved by your directors, friends) lose it too, wherever it came from (needs the caches)", { skip: !have && "no caches", timeout: 300000 }, () => {
  const base = baseline();
  assert.equal(base.status, 0, base.stderr);
  const bIx = decode(readJson(path.join(base.out, "data", "index.json")));
  const targets = [...new Set(bIx.board.map((r) => bIx.rows[r.id].find((tt) => !PINNED.has(tt))).filter(Boolean))];
  assert.ok(targets.length >= 15, `${targets.length} distinct first films of ${bIx.board.length} rows`);
  const ex = build({ films: targets });
  try {
    assert.equal(ex.status, 0, ex.stderr);
    const xIx = decode(readJson(path.join(ex.out, "data", "index.json"))), xCat = catalogs(ex.out);
    for (const r of xIx.board) {
      assert.deepEqual(xIx.rows[r.id].filter((tt) => targets.includes(tt)), [], `row ${r.id} still holds an excluded film`);
      assert.ok(xIx.rows[r.id].length <= bIx.rows[r.id].length, `row ${r.id} did not grow`);
    }
    for (const k of RECOMMENDING) assert.deepEqual(targets.filter((tt) => xCat[k].has(tt)), [], `catalog ${k}`);
    assert.deepEqual(xIx.films.filter((f) => targets.includes(f.tt) && Object.keys(f.moods || {}).length).map((f) => f.tt), [], "none of them belongs to a mood in the index");
    const eligible = (ix) => ix.films.filter((f) => f.eligible).map((f) => f.tt).sort();
    assert.deepEqual(eligible(xIx), eligible(bIx), "and none of them lost its eligibility");
    // the picker's Old friends (web data) too: the source of the rewatch draw, not only the Board row built from it
    const bWeb = readJson(path.join(base.out, "data", "engine.json")), xWeb = readJson(path.join(ex.out, "data", "engine.json"));
    assert.ok(bWeb.rewatch.some((x) => targets.includes(x.i)), "control: the plain build's rewatch holds some of them");
    assert.deepEqual(xWeb.rewatch.filter((x) => targets.includes(x.i)).map((x) => x.i), [], "the rewatch of the picker holds none of them");
    assert.deepEqual(xWeb.films.filter((x) => targets.includes(x.i)).map((x) => x.i), []);
  } finally { rm(ex.out); }
});

test("build with a bad id in exclude.films fails with the message and writes nothing", { skip: !have && "no caches", timeout: 300000 }, () => {
  const r = build({ films: ["tt5247022", "Paterson"] });
  try {
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /config\.json exclude\.films: "Paterson" is not IMDb id \(tt followed by digits/);
    assert.ok(!fs.existsSync(path.join(r.out, "manifest.json")), "nothing was published");
  } finally { rm(r.out); }
});
