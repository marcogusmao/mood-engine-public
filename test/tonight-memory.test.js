// node --test            (no dependencies)
// Marco, 14/11/2026 (questionnaire): "Bigger pool + 30 days without repeating". Tonight draws each pick from the top 40 of its mood (it was 12) and never shows a film that was in
// Tonight on one of the 30 days before today. lib/rows.js draws; lib/tonight-memory.js keeps cache/tonight-memory.json; build.js reads it before the draw and writes it after the publication.
// Before it (the audit and the inventory in the Stremio repository, docs/research/2026-11-14-auditoria-dados.md section 3a and 2026-11-14-inventario-moods-listas.md section 8): with twelve a
// mood and no memory the row drew from 91 different films (those of the nine top-twelves that pass the recommendation rule on 14/11/2026). MEASURED on the seven days published from 08 to 14/11/2026:
// 1.50 of its 10 films were films of the day before. SIMULATED on the code by the audit: 1.36 of 10.
//
// Every world here is made in this file (moods, films, memory): NO test reads the repository's cache/ (the house rule since 15/10/2026: a test that reads the cache of the day breaks by
// itself tomorrow). The one executed proof on build.js itself is in test/tonight-exclude.test.js (a build from a copy of five named caches with a planted memory).
//
// The eight things this file holds, in order: (1) 60 days in a row, no film twice inside 30 days; (2) the 40 and the 30 are numbers of config.json and a config without them gets the new
// rule; (3) the relief when a mood has no free film in its top 40: deeper first, then the mood's place to a free film of another mood, and a film shown longest ago only when no mood has a free one;
// never a short row, never a film twice in a day; (4) a memory file that
// cannot be used is an empty memory and a line in the log; (5) only a build that PUBLISHES writes (the scheduled night and the one started by hand: TONIGHT_MEMORY_WRITE=1, its own switch since the review of 14/11/2026), a second build of the day replaces the day's entry and does not read it; (6) the same day,
// the same memory and the same films give the same row; (7) is the paragraph above; (8) the tenth film and a pinned film obey the 30 days too.
// test-support/tonight-mutacoes.js plants the defects one at a time in a COPY of the code and says which test turns red (and which defects no test sees).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { buildRows, tonightSpec, TONIGHT_DEPTH, TONIGHT_NO_REPEAT_DAYS } = require("../lib/rows");
const TM = require("../lib/tonight-memory");
const { compile } = require("../lib/moods");
const { legacyConfig } = require("../lib/board-shared");

const ROOT = path.join(__dirname, "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const tmp = (p = "tonight-memory-test-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const day = (i, from = "2027-01-01") => TM.shiftDate(from, i); // January to March 2027 for the long runs: no mood of these worlds has a season

// ── the worlds ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Nine moods; mood i is the genre "G<i>". A film of one genre belongs to one mood; `shared` films per mood carry the genre of the NEXT mood too and are ranked above every other film,
// so the top of each mood is partly the top of its neighbour (what the real index does: High and Low was #1 of two moods on 14/11/2026).
const MOOD_IDS = ["lift", "escape", "reinvent", "letin", "night", "wicked", "wander", "slow", "music"];
const moodsOf = (ids) => compile(ids.map((id) => ({ id, name: id.toUpperCase(), word: id, genres: { ["G" + MOOD_IDS.indexOf(id)]: 2 }, keywords: {}, minFit: 1 })));
const MOODS = moodsOf(MOOD_IDS);
function world({ ids = MOOD_IDS, perMood = 60, shared = 0, sizes = null } = {}) {
  let n = 0;
  const film = (genres, tasteZ, extra = {}) => {
    const k = ++n;
    return { id: k, film: { id: k, imdb: "tt" + (1000000 + k), title: "F" + k, year: 2000, genres, keywords: [], directors: [{ id: k, name: "D" + k }], cast: [], countries: [], va: 7, vc: 500, overview: "" },
      tasteZ, qualityZ: 0, recCount: 0, seeds: [], pins: [], contributions: [], ...extra };
  };
  const pool = [];
  ids.forEach((id, at) => {
    const i = MOOD_IDS.indexOf(id), next = MOOD_IDS.indexOf(ids[(at + 1) % ids.length]), own = sizes ? sizes[at] : perMood;
    for (let s = 0; s < shared; s++) pool.push(film(["G" + i, "G" + next], 5 - s * 0.01 + i * 0.001));
    for (let j = 0; j < own; j++) pool.push(film(["G" + i], 3 - j * 0.01 + i * 0.001));
  });
  return pool;
}
const SIZES = { tonight: 10, row: 30, discover: 60, because: 20, directors: 24, oldFriends: 24, watchlist: 40 };
/** One build of the rows. tonight: config.json "tonight" (absent: no key at all); shown: Map tt → date (lib/tonight-memory.js lastShown). */
const run = (pool, today, { tonight, shown, size = 10, moods = MOODS, eligible, rewatch = [] } = {}) =>
  buildRows({ pool, rewatch, moods, cfg: { sizes: { ...SIZES, tonight: size }, build: { directors: 15 }, ...(tonight ? { tonight } : {}) }, model: { stats: new Map() }, recentSeeds: [], today, eligible, tonightShown: shown });
const idsOf = (r) => r.rows.tonight.map((x) => x.id);
const moodOf = (it) => it.mood.replace("Tonight · ", "").toLowerCase(); // the mood a pick was taken for
/** The films of a mood in the order Tonight walks them (best first), as IMDb ids. */
const orderOf = (pool, mood, o = {}) => run(pool, "2027-01-01", o).ranked[mood].map((c) => c.film.imdb);
const planOf = (items) => ({ board: [{ id: "tonight", items }, { id: "watchlist", items: [{ id: "tt9999999" }] }], board2: [{ id: "tonight", items }] });

/**
 * `n` days in a row, the way the nights run: each day reads the memory file of `dir` (runInBuild), draws, and the build that publishes writes the row.
 * → [{ day, ids, relief }]
 */
function nights(pool, n, { dir, noRepeatDays = 30, tonight, from = 0 } = {}) {
  const out = [];
  for (let i = from; i < from + n; i++) {
    const step = TM.runInBuild({ noRepeatDays, today: day(i), cacheDir: dir, log: () => {} });
    const r = run(pool, day(i), { tonight, shown: step.shown });
    step.remember(planOf(r.rows.tonight), { TONIGHT_MEMORY_WRITE: "1" }, false);
    out.push({ day: day(i), ids: idsOf(r), relief: r.tonightRelief });
  }
  return out;
}
/** The shortest distance in days between two showings of one film, over a run of nights (Infinity when no film came twice), and how many showings were a film already shown in the 30 days before. */
function repetition(run60) {
  const last = new Map();
  let shortest = Infinity, inside30 = 0;
  run60.forEach((night, i) => {
    for (const id of night.ids) {
      if (last.has(id)) { const gap = i - last.get(id); shortest = Math.min(shortest, gap); if (gap <= 30) inside30++; }
      last.set(id, i);
    }
  });
  return { shortest, inside30, distinct: last.size };
}

// ── 1. sixty days, no film twice inside thirty ──────────────────────────────────────────────────────────────────────────────────────────────

test("60 days in a row with the memory file: ten different films every day, and no film of a day was in Tonight on any of the 30 days before it (a film comes back after 31 days at the earliest)", () => {
  const dir = tmp();
  try {
    const pool = world({ perMood: 60, shared: 6 });
    const run60 = nights(pool, 60, { dir });
    for (const night of run60) {
      assert.equal(night.ids.length, 10, `${night.day}: ten films`);
      assert.equal(new Set(night.ids).size, 10, `${night.day}: no film twice in the row`);
      assert.deepEqual(night.relief.filter((x) => x.kind !== "deeper"), [], `${night.day}: no mood lost its place and no film had to come back early in a world of this size`);
    }
    const rep = repetition(run60);
    assert.equal(rep.inside30, 0, `films shown again inside 30 days: ${rep.inside30} (shortest distance ${rep.shortest} days)`);
    assert.ok(rep.shortest >= 31, `the shortest distance between two showings of one film is ${rep.shortest} days`);
    // any 31 days in a row (a day and the 30 before it) hold 310 different films
    for (let i = 30; i < 60; i++) assert.equal(new Set(run60.slice(i - 30, i + 1).flatMap((x) => x.ids)).size, 310, `the 31 days ending ${run60[i].day}`);
    // the file keeps the 30 days before the last night and that night: 31 lines of films
    const kept = [...TM.readMemory(path.join(dir, TM.MEMORY_FILE)).days.keys()];
    assert.deepEqual([kept.length, kept[0], kept[kept.length - 1]], [31, day(29), day(59)]);
  } finally { rm(dir); }
});

test("control of the measure above: the same 60 days WITHOUT the memory (noRepeatDays 0) and with the old depth of twelve do repeat films inside 30 days, and the measure sees it", () => {
  const dir = tmp();
  try {
    const pool = world({ perMood: 60, shared: 6 });
    const old = repetition(nights(pool, 60, { dir, noRepeatDays: 0, tonight: { depth: 12, noRepeatDays: 0 } }));
    assert.ok(old.inside30 >= 300 && old.shortest === 1, `depth 12, no memory: ${old.inside30} showings repeat a film of the 30 days before, the shortest distance is ${old.shortest} day(s)`);
    assert.ok(old.distinct <= 9 * 12, `and the 600 places hold ${old.distinct} different films (at most 9 x 12)`);
    assert.equal(fs.existsSync(path.join(dir, TM.MEMORY_FILE)), false, "noRepeatDays 0 writes no file even on the scheduled night");
    // the bigger pool alone, still without memory, repeats too: the 30 days are what forbids it, not the 40
    const wide = repetition(nights(pool, 60, { dir, noRepeatDays: 0, tonight: { noRepeatDays: 0 } }));
    assert.ok(wide.inside30 >= 50 && wide.distinct > old.distinct, `depth 40, no memory: ${wide.inside30} repeated showings, ${wide.distinct} different films`);
  } finally { rm(dir); }
});

// ── 2. the 40 and the 30 are numbers of config.json ──────────────────────────────────────────────────────────────────────────────────────────

test("config.json says tonight.depth 40 and tonight.noRepeatDays 30; a config without the keys gets the same two (the new rule, not twelve and no memory); the legacy family's config keeps them", () => {
  assert.deepEqual([CONFIG.tonight.depth, CONFIG.tonight.noRepeatDays, CONFIG.tonight.bias], [40, 30, 1]);
  assert.deepEqual(tonightSpec(CONFIG), { bias: 1, depth: 40, noRepeatDays: 30 });
  assert.deepEqual(tonightSpec({}), { bias: 1, depth: 40, noRepeatDays: 30 }, "no `tonight` at all");
  assert.deepEqual(tonightSpec({ tonight: { bias: 1 } }), { bias: 1, depth: 40, noRepeatDays: 30 }, "the config of before 14/11/2026");
  assert.deepEqual([TONIGHT_DEPTH, TONIGHT_NO_REPEAT_DAYS], [40, 30]);
  assert.deepEqual(tonightSpec(legacyConfig(CONFIG)), { bias: 1, depth: 40, noRepeatDays: 30 });
  assert.deepEqual(tonightSpec({ tonight: { depth: 12, noRepeatDays: 0, bias: 1.6 } }), { bias: 1.6, depth: 12, noRepeatDays: 0 }, "what is written wins: the rule of before 19/10/2026 can still be asked for");
});

// Marco, 15/11/2026 (questionnaire): "Yes, same rule, his own memory". A person's build (Will; switched off since October, and nothing here switches it on) draws Tonight by Marco's rule, from a
// memory file of the person's own, where a row counts only after the build that drew it is reported as published. This replaces the test of the review of 14/11/2026, which fixed the opposite
// while nobody had decided ("a person's build keeps Tonight as it was: the top 12, no memory"): THAT IS NO LONGER PROMISED.
// What is promised: (1) the person's config carries Marco's three numbers; (2) the person's file is in the person's own cache folder and Marco's is never read for it; (3) a row is written as
// pending, under the revision of its build, and is not counted; (4) it is counted from the build that is told that revision was published; (5) a row never published is never counted.
// What is NOT promised, because it is not built (BACKLOG.md, 15/11/2026): that the file lasts from one build to the next (the person's snapshot does not carry it yet) and that anything tells the
// build which revisions were published. Until both exist a person's Tonight is the top 40 with an empty memory.
const REV = (n) => "r-" + String(n).padStart(32, "0");
test("a person's build (Will) draws Tonight by Marco's rule: the person's config carries the three numbers of config.json tonight, whatever they are, and the draw reaches below the twelfth film", () => {
  const PEOPLE = require("../lib/people");
  const will = PEOPLE.deriveConfig(CONFIG, { id: "friend-a" });
  assert.deepEqual(will.tonight, { bias: 1, depth: 40, noRepeatDays: 30 }, "the numbers, without the _doc");
  assert.deepEqual(tonightSpec(will), tonightSpec(CONFIG));
  assert.deepEqual(PEOPLE.deriveConfig({ ...CONFIG, tonight: { _doc: "x", bias: 1.6, depth: 25, noRepeatDays: 10 } }, { id: "friend-a" }).tonight, { bias: 1.6, depth: 25, noRepeatDays: 10 }, "they follow Marco's config, they are not a copy made today");
  const bare = { ...CONFIG }; delete bare.tonight;
  assert.deepEqual(tonightSpec(PEOPLE.deriveConfig(bare, { id: "friend-a" })), { bias: 1, depth: 40, noRepeatDays: 30 }, "a config with no `tonight`: the defaults, the same for both");
  const pool = world({ perMood: 44 }), lift = orderOf(pool, "lift");
  let deepest = 0;
  for (let i = 0; i < 120; i++) for (const it of run(pool, day(i), { tonight: will.tonight, size: 9 }).rows.tonight) if (moodOf(it) === "lift") deepest = Math.max(deepest, lift.indexOf(it.id));
  assert.ok(deepest >= 30 && deepest < 40, `over 120 days the deepest pick of a mood is its film number ${deepest + 1}: below the twelfth, inside the forty`);
});

test("a person's memory is a file of the person's own, and a row counts only after the build that drew it is reported as published: pending is not counted, a published revision is, a build never published never is", () => {
  const dir = tmp(), marco = tmp();
  try {
    const pool = world({ perMood: 60 }), file = path.join(dir, TM.MEMORY_FILE);
    // Marco's own memory, in another folder, says ten films were shown yesterday: a person's build does not read it
    fs.writeFileSync(path.join(marco, TM.MEMORY_FILE), `{"version":1,"days":{"${day(0)}":${JSON.stringify(idsOf(run(pool, day(1))))}}}`);
    const logs = [];
    /** one build of the person on day i, revision r, told that `published` were published; write: the build is going to be published */
    const build = (i, r, published, write = true) => {
      const step = TM.runInBuild({ noRepeatDays: 30, today: day(i), cacheDir: dir, log: (l) => logs.push(l), person: { revision: REV(r), published: new Set(published.map(REV)) } });
      const row = run(pool, day(i), { shown: step.shown });
      const w = step.remember(planOf(row.rows.tonight), write ? { TONIGHT_MEMORY_WRITE: "1" } : {}, false);
      return { ids: idsOf(row), shown: step.shown, w };
    };
    // build 1: nothing in the person's folder; Marco's file elsewhere changes nothing
    const b1 = build(1, 1, []);
    assert.equal(b1.shown.size, 0);
    assert.deepEqual(b1.ids, idsOf(run(pool, day(1))), "the row of a day with no memory, though Marco's file holds exactly these films");
    assert.equal(b1.w.written, true);
    assert.match(b1.w.why, new RegExp(`holds 10 films for ${day(1)} as a row waiting for the publication of ${REV(1)}`));
    let saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(saved, { version: 1, days: {}, pending: [{ date: day(1), revision: REV(1), films: b1.ids }] }, "written as pending: no day");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "private, like every file of a person's folder");
    assert.deepEqual(fs.readdirSync(dir), [TM.MEMORY_FILE]);
    // build 2, the next day, told of no publication: the row of build 1 is NOT counted
    const b2 = build(2, 2, []);
    assert.equal(b2.shown.size, 0, "a pending row holds no film back");
    assert.deepEqual(b2.ids, idsOf(run(pool, day(2))));
    saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(saved.pending.map((p) => p.revision), [REV(1), REV(2)], "both rows wait");
    assert.deepEqual(saved.days, {});
    // build 3: revision 1 was published, revision 2 was not (yet)
    logs.length = 0;
    const b3 = build(3, 3, [1]);
    assert.deepEqual([...b3.shown.keys()].sort(), b1.ids.slice().sort(), "the ten films of the published build are held back");
    assert.ok(b3.ids.every((id) => !b1.ids.includes(id)), "and none of them is in today's row");
    assert.match(logs.join("\n"), new RegExp(`Tonight memory of this person: 1 row now counted, their build was published \\(${day(1)}\\); 1 waiting for a publication and NOT counted`));
    saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(saved.days, { [day(1)]: b1.ids }, "now a day");
    assert.deepEqual(saved.pending.map((p) => p.revision), [REV(2), REV(3)]);
    // a build that only reads (it will not be published) counts the same rows and leaves the file alone
    const before = fs.readFileSync(file, "utf8");
    const reader = build(4, 4, [1, 2], false);
    assert.equal(reader.w.written, false);
    assert.equal(reader.shown.size, 20, "told of revision 2 as well: both rows count for this build");
    assert.equal(fs.readFileSync(file, "utf8"), before);
    // revision 2 is never published: 31 days after its row it is gone from the file, and was never counted by a build not told of it
    const late = build(33, 5, [1, 3]);
    assert.ok(b2.ids.every((id) => !late.shown.has(id)), "the row of the build that was never published is not counted");
    saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(saved.pending.map((p) => p.revision), [REV(5)], "the old pending rows left with the window");
    assert.deepEqual(Object.keys(saved.days), [day(3)], "day 1 is past the 30 days; day 3, published, stays");
    // the same revision built twice on one day: one row, the last
    build(33, 5, [1, 3]);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pending.length, 1);
    // --cache-only, no switch, no revision: nothing written
    const step = TM.runInBuild({ noRepeatDays: 30, today: day(34), cacheDir: dir, log: () => {}, person: { revision: REV(6), published: new Set() } });
    assert.equal(step.remember(planOf([{ id: "tt0000001" }]), { TONIGHT_MEMORY_WRITE: "1" }, true).written, false);
    assert.equal(step.remember(planOf([{ id: "tt0000001" }]), {}, false).written, false);
    const noRev = TM.runInBuild({ noRepeatDays: 30, today: day(34), cacheDir: dir, log: () => {}, person: { revision: "latest", published: new Set() } });
    assert.deepEqual(noRev.remember(planOf([{ id: "tt0000001" }]), { TONIGHT_MEMORY_WRITE: "1" }, false), { written: false, why: "the person's build has no revision to file the row under" });
    // Marco's own build never writes or reads `pending`, whatever the environment says
    const own = TM.runInBuild({ noRepeatDays: 30, today: day(1), cacheDir: marco, log: () => {} });
    assert.equal(own.shown.size, 10);
    own.remember(planOf([{ id: "tt0000001" }]), { TONIGHT_MEMORY_WRITE: "1", TONIGHT_PUBLISHED_REVISIONS: REV(1) }, false);
    assert.ok(!fs.readFileSync(path.join(marco, TM.MEMORY_FILE), "utf8").includes("pending"));
  } finally { rm(dir); rm(marco); }
});

// review of 15/11/2026: the person's folder was checked against a symbolic link for cache/front-memory.json and not for cache/tonight-memory.json. With a link planted there to Marco's file the
// person's build would read Marco's memory and hold back the films of Marco's Tonight (its write replaces the link and does not touch his file). The link is refused before the build reads anything.
test("a symbolic link at the person's cache/tonight-memory.json is refused before the build reads the folder (it could point at Marco's memory); a plain file there is accepted", (t) => {
  const F = require("../test-support/people/fixture"), I = require("../lib/person-input"), PEOPLE = require("../lib/people");
  const f = F.fixture(t), h = F.history();
  for (const [name, data] of Object.entries({ "history.json": h, "identities.json": {}, "coverage.json": h.coverage })) I.write(path.join(f.privateDir, name), data);
  const args = ["--person", "friend-a", "--private-dir", f.privateDir, "--person-input", path.join(f.privateDir, "history.json")];
  fs.mkdirSync(path.join(f.privateDir, "cache"), { recursive: true });
  // a plain file of the person's own: accepted
  fs.writeFileSync(path.join(f.privateDir, "cache", TM.MEMORY_FILE), '{"version":1,"days":{}}');
  assert.equal(PEOPLE.buildPersonOptions(f.root, args).cacheDir, path.join(f.privateDir, "cache"));
  // a link to Marco's file: refused
  fs.rmSync(path.join(f.privateDir, "cache", TM.MEMORY_FILE));
  const marco = f.write("cache/tonight-memory.json", { version: 1, days: { "2026-10-14": ["tt1234567"] } });
  fs.symlinkSync(marco, path.join(f.privateDir, "cache", TM.MEMORY_FILE));
  assert.throws(() => PEOPLE.buildPersonOptions(f.root, args), /Symlink/);
  // control: the same folder without the link is accepted again, so it was the link that was refused
  fs.rmSync(path.join(f.privateDir, "cache", TM.MEMORY_FILE));
  assert.doesNotThrow(() => PEOPLE.buildPersonOptions(f.root, args));
});

test("the list of published revisions and the pending rows of the file are read strictly: a malformed revision is not a publication, a malformed pending row makes the file unusable", () => {
  assert.deepEqual([...TM.revisionsOf(`${REV(1)}, ${REV(2)},r-xyz,,latest,${REV(1).toUpperCase()}`)], [REV(1), REV(2)]);
  assert.deepEqual([...TM.revisionsOf(undefined)], []);
  assert.deepEqual([...TM.revisionsOf("")], []);
  const dir = tmp();
  try {
    const file = path.join(dir, TM.MEMORY_FILE);
    const bad = (pending, re) => { fs.writeFileSync(file, JSON.stringify({ version: 1, days: {}, pending })); const r = TM.readMemory(file); assert.equal(r.pending.length, 0); assert.match(r.problem, re, JSON.stringify(pending)); };
    bad({}, /pending is not a list/);
    bad([{ revision: REV(1), films: [] }], /a pending row has no date/);
    bad([{ date: "2027-02-30", revision: REV(1), films: [] }], /a pending row has no date/);
    bad([{ date: "2027-01-01", revision: "r-1", films: [] }], /2027-01-01: the pending row has no revision/);
    bad([{ date: "2027-01-01", revision: REV(1), films: ["Mirror"] }], /2027-01-01: the pending row is not a list of IMDb ids/);
    bad([{ date: "2027-01-01", revision: REV(1) }], /not a list of IMDb ids/);
    bad(Array.from({ length: TM.MAX_PENDING + 1 }, () => ({ date: "2027-01-01", revision: REV(1), films: [] })), /pending holds 201 rows, more than 200/);
    fs.writeFileSync(file, JSON.stringify({ version: 1, days: { "2027-01-01": ["tt0000001"] }, pending: [{ date: "2027-01-02", revision: REV(1), films: ["tt0000002"] }] }));
    const ok = TM.readMemory(file);
    assert.deepEqual([ok.problem, [...ok.days], ok.pending], [null, [["2027-01-01", ["tt0000001"]]], [{ date: "2027-01-02", revision: REV(1), films: ["tt0000002"] }]]);
    // two published rows of one date: the later one in the file is the day
    const c = TM.confirmPublished(new Map(), [{ date: "2027-01-02", revision: REV(1), films: ["tt0000001"] }, { date: "2027-01-02", revision: REV(2), films: ["tt0000002"] }, { date: "2027-01-03", revision: REV(3), films: ["tt0000003"] }], new Set([REV(1), REV(2)]));
    assert.deepEqual([[...c.days], c.pending.map((p) => p.revision), c.confirmed.length], [[["2027-01-02", ["tt0000002"]]], [REV(3)], 2]);
  } finally { rm(dir); }
});

test("tonight.depth must be a whole number from 1 and tonight.noRepeatDays a whole number from 0: anything else stops the build with the key and the value in the message", () => {
  const pool = world({ perMood: 5 });
  for (const bad of [0, -1, 1.5, "40", null, NaN, Infinity, {}, true]) {
    assert.throws(() => tonightSpec({ tonight: { depth: bad } }), /tonight\.depth must be a whole number from 1/, JSON.stringify(bad));
    assert.throws(() => run(pool, "2027-01-01", { tonight: { depth: bad } }), /tonight\.depth must be a whole number from 1/, "buildRows: " + JSON.stringify(bad));
  }
  for (const bad of [-1, 1.5, "30", null, NaN, Infinity, {}, true]) {
    assert.throws(() => tonightSpec({ tonight: { noRepeatDays: bad } }), /tonight\.noRepeatDays must be a whole number from 0/, JSON.stringify(bad));
    assert.throws(() => run(pool, "2027-01-01", { tonight: { noRepeatDays: bad } }), /tonight\.noRepeatDays must be a whole number from 0/, "buildRows: " + JSON.stringify(bad));
  }
  assert.throws(() => tonightSpec({ tonight: { depth: 0 } }), /got 0$/);
  for (const good of [1, 12, 40, 500]) assert.equal(tonightSpec({ tonight: { depth: good } }).depth, good);
  for (const good of [0, 1, 7, 30, 365]) assert.equal(tonightSpec({ tonight: { noRepeatDays: good } }).noRepeatDays, good);
});

test("a bad tonight.depth or tonight.noRepeatDays in the config stops build.js at its first step, naming the key, before any cache is read or any file written", { timeout: 120000 }, () => {
  const dir = tmp();
  try {
    const attempt = (patch) => {
      const file = path.join(dir, "c.json");
      fs.writeFileSync(file, JSON.stringify({ ...CONFIG, tonight: { ...CONFIG.tonight, ...patch } }));
      return spawnSync(process.execPath, [path.join(ROOT, "build.js"), "--offline", "--cache-only", "--skip-posters", "--config", file, "--cache-dir", path.join(dir, "cache"), "--out", path.join(dir, "out")], { cwd: ROOT, encoding: "utf8", env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "", FRONT_MEMORY_WRITE: "", TONIGHT_MEMORY_WRITE: "" } });
    };
    for (const [patch, key] of [[{ depth: 0 }, "tonight.depth must be a whole number from 1"], [{ depth: "40" }, "tonight.depth must be a whole number from 1"], [{ noRepeatDays: -1 }, "tonight.noRepeatDays must be a whole number from 0"], [{ noRepeatDays: 2.5 }, "tonight.noRepeatDays must be a whole number from 0"], [{ bias: 0 }, "tonight.bias must be a positive number"]]) {
      const r = attempt(patch);
      assert.equal(r.status, 1, `${JSON.stringify(patch)}: the build stops`);
      assert.ok(r.stderr.includes(key), `${JSON.stringify(patch)}: the message names the key\n${r.stderr.slice(0, 400)}`);
      assert.equal(r.stdout, "", `${JSON.stringify(patch)}: before the first line of the log`);
      assert.deepEqual(fs.readdirSync(dir), ["c.json"], "no cache folder, no output folder");
    }
  } finally { rm(dir); }
});

test("the draw reads tonight.depth: with no key the first pass reaches the 40th film of a mood and never the 41st; with depth 12 never the 13th; with depth 20 never the 21st", () => {
  const pool = world({ perMood: 44 }), lift = orderOf(pool, "lift");
  assert.equal(lift.length, 44);
  /** over 360 days with an empty memory, how many times the first pass took each place of lift (size 9: nine moods, the first pass alone) */
  const places = (tonight) => {
    const count = Array(44).fill(0);
    for (let i = 0; i < 360; i++) {
      const picks = run(pool, day(i, "2026-01-01"), { tonight, size: 9 }).rows.tonight.filter((it) => moodOf(it) === "lift");
      assert.equal(picks.length, 1);
      count[lift.indexOf(picks[0].id)]++;
    }
    return count;
  };
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const none = places(undefined);
  assert.equal(sum(none.slice(40)), 0, `no key: places 41 to 44 are outside the forty: ${none.join(" ")}`);
  assert.ok(sum(none.slice(12, 40)) >= 200, `no key: ${sum(none.slice(12, 40))} of 360 days took a film below the twelfth (252 expected of an even draw over forty): ${none.join(" ")}`);
  assert.ok(none.slice(0, 40).filter((c) => c > 0).length >= 36 && Math.max(...none) <= 24, `no key: the forty places share the days (9 each expected): ${none.join(" ")}`);
  assert.deepEqual(places({ depth: 40 }), none, "depth 40 written is the same as no key");
  const twelve = places({ depth: 12 });
  assert.equal(sum(twelve.slice(12)), 0, `depth 12: ${twelve.join(" ")}`);
  const twenty = places({ depth: 20 });
  assert.equal(sum(twenty.slice(20)), 0, `depth 20: ${twenty.join(" ")}`);
  assert.ok(sum(twenty.slice(12, 20)) >= 90, `depth 20: places 13 to 20 are drawn (${sum(twenty.slice(12, 20))} days, 144 expected)`);
});

test("the window reads tonight.noRepeatDays: a film shown 10 days ago is held back with 30 and with 10, and free with 9; with 0 nothing is read", () => {
  const days = new Map([[day(0), ["tt1000001"]], [day(5), ["tt1000002"]], [day(10), ["tt1000003"]]]);
  assert.deepEqual([...TM.lastShown(days, day(10), 30)], [["tt1000001", day(0)], ["tt1000002", day(5)]], "today's own entry (day 10) is not read");
  assert.deepEqual([...TM.lastShown(days, day(10), 10).keys()], ["tt1000001", "tt1000002"], "the 10th day back counts");
  assert.deepEqual([...TM.lastShown(days, day(10), 9).keys()], ["tt1000002"], "the 10th day back is outside a window of 9");
  assert.deepEqual([...TM.lastShown(days, day(10), 0)], []);
  assert.deepEqual([...TM.lastShown(new Map([[day(0), ["tt1"]], [day(3), ["tt1", "tt2"]], [day(1), ["tt2"]]]), day(4), 30)], [["tt1", day(3)], ["tt2", day(3)]], "the LAST day a film was shown, whatever the order of the Map");
});

// ── 3. the relief ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("relief, first step: when the whole top 40 of a mood was shown in the last 30 days, the pick is the best film BELOW the forty that was not, without a draw; the other moods draw what they would have drawn", () => {
  const pool = world({ perMood: 50 }), lift = orderOf(pool, "lift");
  const shownTop = (n) => new Map(lift.slice(0, n).map((tt, j) => [tt, day(-1 - (j % 30))]));
  for (let i = 0; i < 12; i++) {
    const today = day(i), plain = run(pool, today, { size: 9 }), r = run(pool, today, { size: 9, shown: shownTop(40) });
    const pick = r.rows.tonight.find((it) => moodOf(it) === "lift");
    assert.equal(pick.id, lift[40], `${today}: the 41st film of lift, the best one not shown`);
    assert.deepEqual(r.tonightRelief, [{ id: lift[40], mood: "lift", kind: "deeper" }]);
    assert.deepEqual(r.rows.tonight.filter((it) => moodOf(it) !== "lift").map((x) => x.id), plain.rows.tonight.filter((it) => moodOf(it) !== "lift").map((x) => x.id), `${today}: the eight other picks are the ones of a day with no memory`);
    assert.deepEqual(plain.tonightRelief, [], "no memory: no relief");
    // the 41st and the 42nd shown too: the 43rd
    const deeper = run(pool, today, { size: 9, shown: new Map([...shownTop(40), [lift[40], day(-2)], [lift[41], day(-3)]]) });
    assert.equal(deeper.rows.tonight.find((it) => moodOf(it) === "lift").id, lift[42]);
  }
  // one film of the forty free: it is the pick on every day (a draw over one film), and that is no relief
  const one = new Map(shownTop(40)); one.delete(lift[17]);
  for (let i = 0; i < 12; i++) {
    const r = run(pool, day(i), { size: 9, shown: one });
    assert.equal(r.rows.tonight.find((it) => moodOf(it) === "lift").id, lift[17]);
    assert.deepEqual(r.tonightRelief, []);
  }
});

test("relief, second step: when EVERY film of a mood was shown in the last 30 days and another mood has a free film, the mood gets NO film and its place goes to the best free film of the first mood of the day's sequence that has one; nothing is repeated", () => {
  const pool = world({ perMood: 45 }), lift = orderOf(pool, "lift");
  const all = new Map(lift.map((tt, j) => [tt, day(-1 - (j % 25))])); // every film of lift was shown, on the days -1 … -25
  for (let i = 0; i < 12; i++) {
    const today = day(i), plain = run(pool, today, { size: 9 }), r = run(pool, today, { size: 9, shown: all });
    assert.equal(r.rows.tonight.length, 9, `${today}: the row is as long as with no memory`);
    assert.equal(new Set(idsOf(r)).size, 9);
    assert.deepEqual(r.rows.tonight.filter((it) => moodOf(it) === "lift"), [], `${today}: no film of lift: every one of them was shown`);
    assert.ok(idsOf(r).every((id) => !all.has(id)), `${today}: no film of the memory in the row`);
    // the eight other moods draw what they would have drawn (the mood that waits still makes its one rand() call) ...
    const others = plain.rows.tonight.filter((it) => moodOf(it) !== "lift");
    assert.deepEqual(r.rows.tonight.slice(0, 8).map((x) => x.id), others.map((x) => x.id), `${today}: the eight other picks, in the day's order`);
    // ... and the ninth place is the best film not in the row of the FIRST of them in the day's sequence
    const first = moodOf(others[0]), best = plain.ranked[first].map((c) => c.film.imdb).find((id) => id !== others[0].id);
    assert.deepEqual([r.rows.tonight[8].id, moodOf(r.rows.tonight[8])], [best, first], `${today}: the place of lift went to ${first}`);
    assert.deepEqual(r.tonightRelief, [{ id: best, mood: first, kind: "moved", from: "lift" }]);
  }
  // two moods wholly shown: two places move, to the first and the second mood of the sequence that have a free film
  const two = new Map([...all, ...orderOf(pool, "night").map((tt, j) => [tt, day(-1 - (j % 25))])]);
  for (let i = 0; i < 6; i++) {
    const r = run(pool, day(i), { size: 9, shown: two });
    assert.equal(r.rows.tonight.length, 9);
    assert.equal(new Set(idsOf(r)).size, 9);
    assert.ok(idsOf(r).every((id) => !two.has(id)));
    assert.deepEqual(r.tonightRelief.map((x) => [x.kind, x.from, x.mood]), [["moved", r.tonightRelief[0].from, moodOf(r.rows.tonight[0])], ["moved", r.tonightRelief[1].from, moodOf(r.rows.tonight[1])]]);
    assert.deepEqual(r.tonightRelief.map((x) => x.from).sort(), ["lift", "night"]);
  }
});

test("relief, third step: only when NO mood has a film that was not shown does a film come back, and it is the one shown longest ago (the best-ranked of those that share the day)", () => {
  const one = moodsOf(["lift"]), pool = world({ ids: ["lift"], perMood: 45 }), lift = orderOf(pool, "lift", { moods: one });
  const all = new Map(lift.map((tt, j) => [tt, day(-1 - (j % 25))])); // dates day(-1) … day(-25)
  all.set(lift[33], day(-29)); // the oldest showing
  for (let i = 0; i < 6; i++) { // six different draws: the pick does not depend on the day's number
    const r = run(pool, day(i), { moods: one, size: 1, shown: all });
    assert.deepEqual(idsOf(r), [lift[33]]);
    assert.deepEqual(r.tonightRelief, [{ id: lift[33], mood: "lift", kind: "repeat" }]);
  }
  const tie = new Map(all); tie.set(lift[7], day(-29)); tie.set(lift[40], day(-29));
  assert.deepEqual(idsOf(run(pool, "2027-01-01", { moods: one, size: 3, shown: tie })), [lift[7], lift[33], lift[40]], "three films share the oldest day: best-ranked first");
  // one film of the mood free: it is taken, and nothing of the memory with it (size 1)
  const free = new Map(all); free.delete(lift[44]);
  const r = run(pool, "2027-01-01", { moods: one, size: 1, shown: free });
  assert.deepEqual([idsOf(r), r.tonightRelief], [[lift[44]], [{ id: lift[44], mood: "lift", kind: "deeper" }]]);
});

test("relief never shortens the row and never repeats a film inside the day: ten films that pass the rule, all of them in the memory, are the ten of the row; nine give nine", () => {
  const three = moodsOf(["lift", "escape", "reinvent"]), pool = world({ ids: ["lift", "escape", "reinvent"], sizes: [4, 3, 3] });
  const tts = pool.map((c) => c.film.imdb), everything = new Map(tts.map((tt, j) => [tt, day(-1 - j)]));
  for (let i = 0; i < 10; i++) {
    const r = run(pool, day(i), { moods: three, shown: everything });
    assert.equal(r.rows.tonight.length, 10, `${day(i)}: ten films`);
    assert.deepEqual(idsOf(r).slice().sort(), tts.slice().sort(), "the ten films of the world, each once");
    assert.equal(r.tonightRelief.length, 10);
    assert.ok(r.tonightRelief.every((x) => x.kind === "repeat"));
    const nine = run(pool, day(i), { moods: three, shown: everything, eligible: (tt) => tt !== tts[0] });
    assert.equal(nine.rows.tonight.length, 9, "one film refused by the rule: nine, and no film twice to make ten");
    assert.equal(new Set(idsOf(nine)).size, 9);
    assert.ok(!idsOf(nine).includes(tts[0]));
    // no memory at all: the same ten films, by the ordinary passes
    assert.deepEqual(idsOf(run(pool, day(i), { moods: three })).slice().sort(), tts.slice().sort());
  }
});

test("a film of the memory enters the row only after every free film of every mood: a mood wholly in the memory gives nothing while another has free films, and when those run out its films return oldest first", () => {
  const two = moodsOf(["lift", "escape"]);
  const big = world({ ids: ["lift", "escape"], sizes: [6, 20] }), liftBig = orderOf(big, "lift", { moods: two });
  const shownLift = new Map(liftBig.map((tt, j) => [tt, day(-1 - j)])); // liftBig[5] is the oldest
  for (let i = 0; i < 10; i++) {
    const r = run(big, day(i), { moods: two, shown: shownLift });
    assert.equal(r.rows.tonight.length, 10);
    assert.equal(new Set(idsOf(r)).size, 10);
    assert.deepEqual(r.rows.tonight.filter((it) => moodOf(it) === "lift"), [], `${day(i)}: no film of lift: escape has free films for all ten places`);
    assert.deepEqual(r.tonightRelief.map((x) => [x.kind, x.from, x.mood]), [["moved", "lift", "escape"]], "one place moved, no film repeated");
  }
  const small = world({ ids: ["lift", "escape"], sizes: [6, 3] }), liftSmall = orderOf(small, "lift", { moods: two }), escSmall = orderOf(small, "escape", { moods: two });
  const shown2 = new Map(liftSmall.map((tt, j) => [tt, day(-1 - j)]));
  for (let i = 0; i < 10; i++) {
    const r = run(small, day(i), { moods: two, shown: shown2 }), ids = idsOf(r);
    assert.equal(ids.length, 9, "the nine films of the world");
    assert.equal(new Set(ids).size, 9);
    assert.deepEqual(ids.slice(0, 3).slice().sort(), escSmall.slice().sort(), `${day(i)}: the three free films first`);
    assert.deepEqual(ids.slice(3), [5, 4, 3, 2, 1, 0].map((j) => liftSmall[j]), "then lift's films, the oldest showing first");
    assert.deepEqual(r.tonightRelief.map((x) => x.kind), ["moved", "repeat", "repeat", "repeat", "repeat", "repeat", "repeat"]);
  }
});

test("a film that is at the top of two moods is in the row once, with or without memory", () => {
  const two = moodsOf(["lift", "escape"]), pool = world({ ids: ["lift", "escape"], sizes: [0, 0], shared: 7 }); // 14 films, every one in both moods
  assert.equal(orderOf(pool, "lift", { moods: two }).length, 14);
  for (let i = 0; i < 20; i++) {
    const ids = idsOf(run(pool, day(i), { moods: two }));
    assert.deepEqual([ids.length, new Set(ids).size], [10, 10], day(i));
    const withMemory = idsOf(run(pool, day(i), { moods: two, shown: new Map(pool.slice(0, 9).map((c, j) => [c.film.imdb, day(-1 - j)])) }));
    assert.deepEqual([withMemory.length, new Set(withMemory).size], [10, 10], `${day(i)}: 5 free films and 5 of the memory`);
  }
});

// ── 4. a memory file that cannot be used ────────────────────────────────────────────────────────────────────────────────────────────────────

test("the memory file that cannot be used is an empty memory with the reason: unreadable, not JSON, another version, a day that is not a date or not a list, a film that is not an id; a missing file is empty with no reason", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, TM.MEMORY_FILE);
    assert.deepEqual([TM.readMemory(file).days.size, TM.readMemory(file).problem], [0, null], "missing: a fresh start, nothing to say");
    const bad = (text, re) => { fs.writeFileSync(file, text); const r = TM.readMemory(file); assert.equal(r.days.size, 0, text); assert.match(r.problem, re, text); };
    bad("{not json", /tonight-memory\.json is not valid JSON/);
    bad("", /not valid JSON/);
    bad('{"version":2,"days":{}}', /version 2 is not 1/);
    bad("[]", /version/);
    bad('{"days":{}}', /version undefined is not 1/);
    bad('{"version":1,"days":[]}', /days is not an object/);
    bad('{"version":1}', /days is not an object/);
    bad('{"version":1,"days":{"2027-01-01":{"tt0000001":1}}}', /2027-01-01 is not a list of films/); // the shape of the FRONT memory is not this file's
    bad('{"version":1,"days":{"2027-01-01":"tt0000001"}}', /not a list of films/);
    bad('{"version":1,"days":{"2027-02-30":["tt0000001"]}}', /"2027-02-30" is not a date/);
    bad('{"version":1,"days":{"9999-99-99":["tt0000001"]}}', /not a date/);
    bad('{"version":1,"days":{"yesterday":["tt0000001"]}}', /not a date/);
    bad('{"version":1,"days":{"2027-01-01":["Mirror"]}}', /2027-01-01: "Mirror" is not an IMDb id/);
    bad('{"version":1,"days":{"2027-01-01":["tt0000001",7]}}', /2027-01-01: 7 is not an IMDb id/);
    bad('{"version":1,"days":{"2027-01-01":["tt0000001"],"2027-01-02":[null]}}', /2027-01-02: null is not an IMDb id/); // one bad day spoils the file: none of it is used
    bad(`{"version":1,"days":{"2027-01-01":${JSON.stringify(Array.from({ length: TM.MAX_FILMS + 1 }, (_, i) => "tt" + (1 + i)))}}}`, /holds 501 films, more than 500/);
    fs.mkdirSync(path.join(dir, "folder"));
    const r = TM.readMemory(path.join(dir, "folder"));
    assert.equal(r.days.size, 0);
    assert.match(r.problem, /cannot be read/);
    fs.writeFileSync(file, '{"version":1,"days":{}}');
    assert.deepEqual([TM.readMemory(file).days.size, TM.readMemory(file).problem], [0, null], "a sound file with no days is a sound empty memory");
    fs.writeFileSync(file, '{"version":1,"days":{"2027-01-01":[]}}');
    assert.deepEqual([...TM.readMemory(file).days], [["2027-01-01", []]], "a day with an empty row is sound");
  } finally { rm(dir); }
});

test("the night goes on with a memory file that cannot be used: one line in the log, nothing held back, Tonight is the row of a day with no memory, and the scheduled build then writes a sound file", () => {
  const dir = tmp();
  try {
    const pool = world({ perMood: 60, shared: 6 }), today = day(40), file = path.join(dir, TM.MEMORY_FILE);
    const plain = idsOf(run(pool, today));
    for (const [text, re] of [["{not json", /! tonight memory: tonight-memory\.json is not valid JSON — starting from no memory/], ['{"version":7,"days":{}}', /! tonight memory: version 7 is not 1 — starting from no memory/], [`{"version":1,"days":{"${day(39)}":{"${plain[0]}":1}}}`, /! tonight memory: .* is not a list of films — starting from no memory/]]) {
      fs.writeFileSync(file, text);
      const logs = [], step = TM.runInBuild({ noRepeatDays: 30, today, cacheDir: dir, log: (l) => logs.push(l) });
      assert.match(logs.join("\n"), re);
      assert.match(logs.join("\n"), /Tonight memory: 0 days read, 0 films held back/);
      assert.equal(step.shown.size, 0);
      assert.deepEqual(idsOf(run(pool, today, { shown: step.shown })), plain, "the row of a day with no memory");
      assert.equal(step.remember(planOf(plain.map((id) => ({ id }))), {}, false).written, false, "and a build by hand leaves the bad file alone");
      assert.equal(fs.readFileSync(file, "utf8"), text);
    }
    // control: the same file, sound, DOES hold the films back (so "the row of a day with no memory" above is not what any file gives)
    fs.writeFileSync(file, `{"version":1,"days":{"${day(39)}":${JSON.stringify(plain)}}}`);
    const logs = [], sound = TM.runInBuild({ noRepeatDays: 30, today, cacheDir: dir, log: (l) => logs.push(l) });
    assert.match(logs.join("\n"), new RegExp(`Tonight memory: 1 day read \\(${day(39)} to ${day(39)}\\), 10 films held back \\(shown in Tonight in the last 30 days\\)`));
    assert.ok(!logs.join("\n").includes("!"), "a sound file: no warning");
    const next = idsOf(run(pool, today, { shown: sound.shown }));
    assert.equal(next.filter((id) => plain.includes(id)).length, 0, "none of the ten films of the memory");
    // the scheduled night after a bad file: the file is sound again and holds today
    fs.writeFileSync(file, "{not json");
    const step = TM.runInBuild({ noRepeatDays: 30, today, cacheDir: dir, log: () => {} });
    assert.equal(step.remember(planOf(plain.map((id) => ({ id }))), { TONIGHT_MEMORY_WRITE: "1" }, false).written, true);
    assert.deepEqual([...TM.readMemory(file).days], [[today, plain]]);
  } finally { rm(dir); }
});

// ── 5. who writes, and the second build of the day ──────────────────────────────────────────────────────────────────────────────────────────

test("today's Tonight is written only by a build that publishes (TONIGHT_MEMORY_WRITE=1: the scheduled night AND the one started by hand) and never by --cache-only; the front memory's switch does not write it; noRepeatDays 0 writes nothing", () => {
  const dir = tmp(), file = path.join(dir, TM.MEMORY_FILE);
  try {
    const rem = (env, cacheOnly, noRepeatDays = 30) => TM.remember({ file, days: new Map(), today: day(0), shown: ["tt0000002", "tt0000001"], noRepeatDays, env, cacheOnly });
    assert.deepEqual(rem({}, false), { written: false, why: "TONIGHT_MEMORY_WRITE is not 1: only a build that publishes writes" }, "a build of a test, a rehearsal, a build typed in a terminal");
    assert.equal(rem({ TONIGHT_MEMORY_WRITE: "" }, false).written, false, "the nightly script sets it to empty in --ensaio");
    assert.equal(rem({ TONIGHT_MEMORY_WRITE: "true" }, false).written, false, "only the exact value 1");
    // review of 14/11/2026 (R5): the switch is Tonight's own. The front memory's (FRONT_MEMORY_WRITE=1, the scheduled night alone) does not write this file, and is not needed for it:
    // a night started by hand publishes Tonight too, with FRONT_MEMORY_WRITE empty, and its films must not come back the next day
    assert.equal(rem({ FRONT_MEMORY_WRITE: "1" }, false).written, false, "the front memory's switch alone writes nothing here");
    assert.equal(fs.existsSync(file), false);
    assert.equal(rem({ TONIGHT_MEMORY_WRITE: "1", FRONT_MEMORY_WRITE: "" }, false).written, true, "--manual: publishes, no front memory, Tonight's memory written");
    fs.rmSync(file);
    assert.deepEqual(rem({ TONIGHT_MEMORY_WRITE: "1" }, true), { written: false, why: "--cache-only writes no cache" });
    assert.equal(rem({ TONIGHT_MEMORY_WRITE: "1" }, false, 0).written, false, "no memory is kept");
    assert.equal(fs.existsSync(file), false, "none of those wrote");
    const w = rem({ TONIGHT_MEMORY_WRITE: "1" }, false);
    assert.deepEqual(w, { written: true, why: `tonight-memory.json now holds 2 films for ${day(0)}` });
    assert.deepEqual([...TM.readMemory(file).days], [[day(0), ["tt0000002", "tt0000001"]]], "the films in the order of the row");
  } finally { rm(dir); }
});

test("the memory file: a second write on the same day replaces the first, dates past the 30 days and after today go, dates are sorted, one line a day, a film is written once, and a write that dies leaves the old file", () => {
  const dir = tmp(), file = path.join(dir, TM.MEMORY_FILE);
  try {
    let memory = new Map();
    for (const i of [0, 29, 30]) { TM.writeMemory(file, memory, day(i), [`tt000000${i % 7 + 1}`], 30); memory = TM.readMemory(file).days; }
    assert.deepEqual([...memory.keys()], [day(0), day(29), day(30)], "day 0 is the 30th day before day 30: it still counts, so it is kept");
    TM.writeMemory(file, memory, day(31), ["tt0000009"], 30);
    assert.deepEqual([...TM.readMemory(file).days.keys()], [day(29), day(30), day(31)], "day 0 is 31 days before day 31: gone");
    TM.writeMemory(file, TM.readMemory(file).days, day(31), ["tt0000005", "tt0000004", "tt0000005"], 30);
    const back = TM.readMemory(file);
    assert.equal(back.problem, null);
    assert.deepEqual(back.days.get(day(31)), ["tt0000005", "tt0000004"], "the second write of the day replaced the first (no second entry, no film twice)");
    const text = fs.readFileSync(file, "utf8");
    assert.equal(text, `{"version":1,"days":{\n"${day(29)}":["tt0000002"],\n"${day(30)}":["tt0000003"],\n"${day(31)}":["tt0000005","tt0000004"]\n}}\n`);
    JSON.parse(text); // the nightly checks every cache/*.json parses
    assert.deepEqual(fs.readdirSync(dir), [TM.MEMORY_FILE], "no temporary file left behind");
    // the dates are written sorted, not in the order the Map holds them; a date after today (a clock or a typed date gone wrong) is dropped
    TM.writeMemory(file, new Map([[day(40), ["tt0000001"]], [day(38), ["tt0000001"]], [day(99), ["tt0000001"]], [day(39), ["tt0000001"]]]), day(41), ["tt0000002"], 30);
    assert.deepEqual([...TM.readMemory(file).days.keys()], [day(38), day(39), day(40), day(41)]);
    // what is not an IMDb id is not written (an item of the plan with no id would make the file unreadable for the next night)
    TM.writeMemory(file, new Map(), day(41), ["tt0000002", undefined, "x", "tt0000003"], 30);
    assert.deepEqual([...TM.readMemory(file).days], [[day(41), ["tt0000002", "tt0000003"]]]);
    // atomic: a write that dies on the way (the rename fails) leaves the file as it was
    const kept = fs.readFileSync(file), rename = fs.renameSync;
    fs.renameSync = () => { throw new Error("disk full"); };
    try { assert.throws(() => TM.writeMemory(file, TM.readMemory(file).days, day(42), ["tt0000003"], 30), /disk full/); } finally { fs.renameSync = rename; }
    assert.ok(fs.readFileSync(file).equals(kept), "the old file is untouched");
  } finally { rm(dir); }
});

test("the code build.js runs: every build reads the 30 days before today and NOT today's own entry; only the one that publishes writes, next to all the days it read; a second publishing build of the day draws the same ten films and replaces the entry", () => {
  const dir = tmp(), file = path.join(dir, TM.MEMORY_FILE);
  try {
    const pool = world({ perMood: 60, shared: 6 }), today = day(50);
    nights(pool, 3, { dir, from: 47 }); // the nights of days 47, 48 and 49
    const before = fs.readFileSync(file, "utf8");
    const logs = [];
    const build = (env, cacheOnly) => {
      const step = TM.runInBuild({ noRepeatDays: 30, today, cacheDir: dir, log: (l) => logs.push(l) });
      const r = run(pool, today, { shown: step.shown });
      return { ids: idsOf(r), shown: step.shown, w: step.remember(planOf(r.rows.tonight), env, cacheOnly) };
    };
    // a build by hand (--manual, a push, a test): reads, writes nothing
    const hand = build({}, false);
    assert.equal(hand.w.written, false);
    assert.match(logs.join("\n"), new RegExp(`Tonight memory: 3 days read \\(${day(47)} to ${day(49)}\\), 30 films held back`));
    assert.match(logs.join("\n"), /Tonight memory: not written \(TONIGHT_MEMORY_WRITE is not 1: only a build that publishes writes\)/);
    assert.equal(fs.readFileSync(file, "utf8"), before, "the file is as it was");
    assert.equal(build({ TONIGHT_MEMORY_WRITE: "1" }, true).w.written, false, "--cache-only never writes");
    assert.equal(fs.readFileSync(file, "utf8"), before);
    // the scheduled night
    const night = build({ TONIGHT_MEMORY_WRITE: "1" }, false);
    assert.equal(night.w.written, true);
    assert.deepEqual(night.ids, hand.ids, "the build by hand of the same day showed the same ten films");
    const back = TM.readMemory(file).days;
    assert.deepEqual([...back.keys()], [day(47), day(48), day(49), today], "the three days that were read are still there, and today's is added");
    assert.deepEqual(back.get(today), night.ids, "today's entry is the row of the plan as published");
    assert.equal(fs.readFileSync(file, "utf8").split("\n").slice(0, 4).join("\n"), before.split("\n").slice(0, 4).join("\n").replace(/\]$/, "],"), "the lines of the other days are untouched");
    // a second scheduled build of the same day (the first one failed further on, say): it does not read its own entry, so it holds back the same 30 films and draws the same row
    const after1 = fs.readFileSync(file, "utf8"), again = build({ TONIGHT_MEMORY_WRITE: "1" }, false);
    assert.deepEqual([...again.shown], [...night.shown], "the same memory as the first build of the day");
    assert.ok(night.ids.every((id) => !again.shown.has(id)), "none of the day's own films is held back");
    assert.deepEqual(again.ids, night.ids, "Tonight does not change in the middle of the day");
    assert.equal(fs.readFileSync(file, "utf8"), after1, "and the file is the same, byte for byte");
    // ...and when the second build of the day publishes another row (the films changed meanwhile), the entry is REPLACED, not added to
    const step = TM.runInBuild({ noRepeatDays: 30, today, cacheDir: dir, log: () => {} });
    step.remember(planOf([{ id: "tt0000042" }]), { TONIGHT_MEMORY_WRITE: "1" }, false);
    assert.deepEqual(TM.readMemory(file).days.get(today), ["tt0000042"]);
    assert.equal([...TM.readMemory(file).days.keys()].length, 4);
    // the next day reads it
    assert.ok(TM.runInBuild({ noRepeatDays: 30, today: day(51), cacheDir: dir, log: () => {} }).shown.has("tt0000042"));
    // a date after today is named in the log, not read, and the next write drops it
    fs.writeFileSync(file, `{"version":1,"days":{\n"${day(49)}":["tt0000008"],\n"${day(90)}":["tt0000009"]\n}}\n`);
    logs.length = 0;
    const future = build({ TONIGHT_MEMORY_WRITE: "1" }, false);
    assert.match(logs.join("\n"), new RegExp(`! tonight memory: 1 date after ${today} \\(${day(90)}\\) ignored; the next write drops it`));
    assert.deepEqual([...future.shown.keys()], ["tt0000008"]);
    assert.deepEqual([...TM.readMemory(file).days.keys()], [day(49), today]);
    // noRepeatDays 0: the file is neither read (a broken one gives no warning) nor written
    fs.writeFileSync(file, "{not json");
    logs.length = 0;
    const off = TM.runInBuild({ noRepeatDays: 0, today, cacheDir: dir, log: (l) => logs.push(l) });
    assert.deepEqual(logs, ["     Tonight memory: off (tonight.noRepeatDays is 0)"]);
    assert.equal(off.remember(planOf([{ id: "tt0000001" }]), { TONIGHT_MEMORY_WRITE: "1" }, false).written, false);
    assert.equal(fs.readFileSync(file, "utf8"), "{not json");
  } finally { rm(dir); }
});

test("what is recorded is the row as published: the Tonight of the v2 Board and of the legacy Board, each film once, in the row's order, and no other row", () => {
  const it = (id) => ({ id });
  assert.deepEqual(TM.publishedTonight({ board: [{ id: "tonight", items: [it("tt1"), it("tt2")] }, { id: "watchlist", items: [it("tt9")] }], board2: [{ id: "watchlist", items: [it("tt8")] }, { id: "tonight", items: [it("tt2"), it("tt1")] }] }), ["tt2", "tt1"]);
  assert.deepEqual(TM.publishedTonight({ board: [{ id: "tonight", items: [it("tt1"), it("tt2")] }] }), ["tt1", "tt2"], "a build with no v2 Board");
  assert.deepEqual(TM.publishedTonight({ board: [{ id: "tonight", items: [it("tt1"), it("tt2")] }], board2: [{ id: "tonight", items: [it("tt1")] }] }), ["tt1", "tt2"], "a film that a later step took out of one Board alone was still shown in the other");
  assert.deepEqual(TM.publishedTonight({ board: [], board2: [] }), []);
});

// ── 6. the same day, the same memory, the same films: the same row (and what moves and does not move outside Tonight) ──────────────────────────────────────────────────────────────────────────

test("the draw is seeded by the day: the same day, memory and films give the same ten films; another day or another memory gives others; and no other row that buildRows returns moves with the memory (one rand() per mood whatever it holds)", () => {
  const pool = world({ perMood: 60, shared: 6 });
  const rewatch = Array.from({ length: 30 }, (_, i) => ({ film: { id: 5000 + i, imdb: "tt" + (5000 + i), title: "R" + i, year: 1990, genres: ["G0"], directors: [], cast: [], countries: [] }, rating: 4 + (i % 3) * 0.5, liked: i % 2 === 0, lastSeen: "2020-01-01" }));
  let moved = 0, relieved = 0;
  for (let i = 0; i < 14; i++) {
    const today = day(i), plain = run(pool, today, { rewatch });
    // three memories: the day's own plain row shown yesterday; the whole top 40 of two moods (the relief "deeper"); every film of one mood (its place moves to another mood)
    const memories = [
      new Map(idsOf(plain).map((id) => [id, day(i - 1)])),
      new Map([...plain.ranked.lift.slice(0, 40), ...plain.ranked.night.slice(0, 40)].map((c, j) => [c.film.imdb, day(i - 1 - (j % 30))])),
      new Map(plain.ranked.slow.map((c, j) => [c.film.imdb, day(i - 1 - (j % 30))])),
    ];
    for (const shown of memories) {
      const a = run(pool, today, { rewatch, shown }), b = run(pool, today, { rewatch, shown: new Map(shown) });
      assert.deepEqual(a.rows.tonight, b.rows.tonight, `${today}: twice the same`);
      assert.deepEqual(a.tonightRelief, b.tonightRelief);
      assert.equal(a.rows.tonight.length, 10);
      for (const id of Object.keys(plain.rows)) if (id !== "tonight") assert.deepEqual(a.rows[id].map((x) => x.id), plain.rows[id].map((x) => x.id), `${today}: the row ${id} is the one of a day with no memory`);
      assert.equal(new Set(a.rows.oldfriends.map((x) => x.id)).size, 24, "Old friends is drawn (it reads the numbers after Tonight's)");
      if (idsOf(a).join() !== idsOf(plain).join()) moved++;
      relieved += a.tonightRelief.length;
    }
    assert.notDeepEqual(idsOf(run(pool, day(i + 1), { rewatch })), idsOf(plain), "and it still rotates with the day");
  }
  assert.equal(moved, 14 * 3, "control: every one of those memories did change Tonight itself");
  assert.ok(relieved >= 14 * 3, `control: the reliefs ran (${relieved} picks), so the rand() count was the same through them too`);
});

// second pass of the review, 15/11/2026 (N1): "Old friends keeps the order of the day whatever the memory holds" has a condition. A mood whose every film was shown makes its one rand() call and
// takes NO place in the first pass. When the row has at least as many places as there are moods, the first pass visits every mood anyway and the number of calls is the same with or without that
// mood's films: Old friends, drawn next, reads the same numbers. When the row has FEWER places than moods, the place the mood did not take lets the first pass reach one mood more, which draws
// (one call more): on such a day the order of Old friends can change, the place goes to that next mood by its ordinary draw, and tonightRelief says nothing of it.
// Production is on the promised side (sizes.tonight 10, nine moods). Only that side is asserted. The other is MEASURED and printed, so that nobody reads this test as a promise of it:
// in this world, on 15/11/2026, sizes.tonight 6 changed the order of Old friends on 29 of 40 days (the reviewer, on a world of his own: 27 of 40) and sizes.tonight 10 and 9 on 0 of 40.
test("Old friends keeps the order of the day when a mood is wholly in the memory, PROVIDED Tonight has at least as many places as there are moods (10 and 9 places, nine moods); with fewer places it is not promised", (t) => {
  const pool = world({ sizes: [60, 60, 60, 60, 60, 60, 60, 15, 60] }), slow = orderOf(pool, "slow"); // the mood slow has 15 films
  assert.equal(slow.length, 15);
  const rewatch = Array.from({ length: 30 }, (_, i) => ({ film: { id: 5000 + i, imdb: "tt" + (5000 + i), title: "R" + i, year: 1990, genres: ["G0"], directors: [], cast: [], countries: [] }, rating: 4 + (i % 3) * 0.5, liked: i % 2 === 0, lastSeen: "2020-01-01" }));
  /** over 40 days, with every film of slow shown in the last 30: on how many days Old friends has another order than with no memory, and on how many slow gave up a place */
  const measure = (size) => {
    let differs = 0, moved = 0;
    for (let i = 0; i < 40; i++) {
      const shown = new Map(slow.map((tt, j) => [tt, day(i - 1 - j)]));
      const plain = run(pool, day(i), { rewatch, size }), r = run(pool, day(i), { rewatch, size, shown });
      assert.equal(r.rows.tonight.length, size, `${day(i)}: the row is full`);
      assert.ok(idsOf(r).every((id) => !shown.has(id)), `${day(i)}: no film of the memory`);
      assert.equal(new Set(r.rows.oldfriends.map((x) => x.id)).size, 24);
      if (r.rows.oldfriends.map((x) => x.id).join() !== plain.rows.oldfriends.map((x) => x.id).join()) differs++;
      if (r.tonightRelief.some((x) => x.kind === "moved" && x.from === "slow")) moved++;
    }
    return { differs, moved };
  };
  const ten = measure(10), nine = measure(9), six = measure(6);
  // the promise: as many places as moods, or more
  assert.deepEqual(ten, { differs: 0, moved: 40 }, "10 places, 9 moods: slow gives up its place every day and Old friends never moves");
  assert.deepEqual(nine, { differs: 0, moved: 40 }, "9 places, 9 moods: the same");
  // NOT a promise: fewer places than moods. Printed, not asserted (29 of 40 days on 15/11/2026, and no moved place named on any of them).
  t.diagnostic(`sizes.tonight 6, nine moods, one of them wholly in the memory: Old friends has another order on ${six.differs} of 40 days, and tonightRelief names a moved place on ${six.moved} (not a promise; measured 29 and 0 on 15/11/2026)`);
});

// review of 14/11/2026 (R1): "no other row moves" is true of what buildRows returns (the test above) and of the legacy family. It is NOT true of the shuffled v2 Board: Tonight is a kept row there, and the
// films of its first screen count for the cap across rows (lib/front-shuffle.js: a film stands in the front of at most maxFronts rows), and for the front memory of the next days. So when the memory
// changes which films are in Tonight, the front of ANOTHER row can change. The reviewer measured it on the real Board: 1 of 53 rows (sight-sound). This is that path, on a world of two rows.
test("in the shuffled v2 Board a different Tonight can change the front of ANOTHER row: Tonight's films count for the cap across rows", () => {
  const FS = require("../lib/front-shuffle");
  const spec = { ...FS.DEFAULTS, maxFronts: 1, maxLeads: 1, keep: ["tonight", "watchlist"] };
  const tt = (n) => "tt" + String(2000000 + n), other = Array.from({ length: 30 }, (_, j) => tt(j)); // a row whose best film is tt2000000
  const tonightA = [tt(0), ...Array.from({ length: 9 }, (_, j) => tt(100 + j))]; // a Tonight that holds that film
  const tonightB = Array.from({ length: 10 }, (_, j) => tt(200 + j)); // the Tonight of a day when the memory held it back
  let withIt = 0, moved = 0;
  for (let i = 0; i < 20; i++) {
    const front = (tonight) => FS.orderRows([{ id: "tonight", place: "board", ids: tonight }, { id: "sight-sound", place: "board", ids: other }], day(i), spec).order.get("sight-sound").slice(0, 8);
    const a = front(tonightA), b = front(tonightB);
    assert.ok(!a.includes(tt(0)), `${day(i)}: the film is in Tonight's front, so the cap keeps it out of the other row's front`);
    if (b.includes(tt(0))) withIt++;
    if (a.join() !== b.join()) moved++;
  }
  assert.ok(withIt >= 10, `with the other Tonight the film is back in that row's front on ${withIt} of 20 days`);
  assert.ok(moved >= 10, `the front of the other row differs on ${moved} of 20 days, though the row's own films and the date are the same`);
});

// ── 8. the tenth film and the pins ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test("a pinned film obeys the 30 days: at the top of its mood (depth 1: the pick is the mood's best free film) it is in Tonight on day 0, on none of the 30 days after, and again on day 31 and day 62", () => {
  const dir = tmp();
  try {
    const pool = world({ perMood: 60 });
    const pinned = pool.find((c) => c.film.genres[0] === "G3" && c.tasteZ < 2.6); // a film far down the mood letin ...
    pinned.pins = ["letin"]; // ... that the pin (+10 on the rank) puts first
    assert.equal(orderOf(pool, "letin")[0], pinned.film.imdb, "the pin puts the film at the top of its mood");
    const run63 = nights(pool, 63, { dir, tonight: { depth: 1 } });
    const days = run63.map((night, i) => (night.ids.includes(pinned.film.imdb) ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(days, [0, 31, 62], "shown, held back for 30 days, shown again on the first day it is free");
    // control: with no memory the same pin is in the row every single day
    const dir2 = tmp();
    try { assert.equal(nights(pool, 63, { dir: dir2, noRepeatDays: 0, tonight: { depth: 1, noRepeatDays: 0 } }).filter((night) => night.ids.includes(pinned.film.imdb)).length, 63); } finally { rm(dir2); }
  } finally { rm(dir); }
});

test("a pinned film inside the top 40 is one candidate among the others: shown yesterday, it is not drawn for 30 days, pinned or not", () => {
  const pool = world({ perMood: 60 });
  const pins = pool.filter((c) => c.film.genres[0] === "G7").slice(20, 25); // five pins in the mood slow, as in production on 14/11/2026
  for (const c of pins) c.pins = ["slow"];
  const slow = orderOf(pool, "slow");
  assert.deepEqual(slow.slice(0, 5).slice().sort(), pins.map((c) => c.film.imdb).sort(), "the five pins are the top five of the mood");
  let drawn = 0;
  for (let i = 0; i < 120; i++) {
    const shown = new Map(pins.map((c, j) => [c.film.imdb, day(i - 1 - j * 7)])); // shown 1, 8, 15, 22 and 29 days ago
    const held = idsOf(run(pool, day(i), { shown }));
    assert.ok(pins.every((c) => !held.includes(c.film.imdb)), `${day(i)}: a pin shown in the last 30 days is not in the row`);
    if (pins.some((c) => idsOf(run(pool, day(i))).includes(c.film.imdb))) drawn++;
  }
  assert.ok(drawn >= 8, `control: with no memory a pin is in the row on ${drawn} of 120 days (5 of 40 places: 15 expected), so the assertion above had something to forbid`);
});

test("the tenth film obeys the 30 days: it is the best film of the first mood of the day's sequence that is neither in the row nor in the memory, not that mood's best film", () => {
  const pool = world({ perMood: 60 });
  let differs = 0;
  for (let i = 0; i < 20; i++) {
    const today = day(i), plain = run(pool, today), first = moodOf(plain.rows.tonight[0]), order = plain.ranked[first].map((c) => c.film.imdb);
    assert.equal(moodOf(plain.rows.tonight[9]), first, "ten places, nine moods: the tenth is the first mood's again");
    assert.equal(plain.rows.tonight[9].id, order.find((id) => id !== plain.rows.tonight[0].id), "no memory: the best film of that mood not in the row");
    const shown = new Map(order.slice(0, 3).map((id, j) => [id, day(i - 1 - j)])); // the three best films of that mood were shown in the last three days
    const r = run(pool, today, { shown });
    assert.equal(moodOf(r.rows.tonight[0]), first);
    assert.equal(r.rows.tonight[9].id, order.slice(3).find((id) => id !== r.rows.tonight[0].id), `${today}: the best of the films not shown`);
    assert.ok(!order.slice(0, 3).some((id) => idsOf(r).includes(id)));
    if (r.rows.tonight[9].id !== plain.rows.tonight[9].id) differs++;
    // the whole top 41 of that mood shown: its first pick is the 42nd film (relief "deeper"), the tenth is the 43rd, and the log entry of the tenth says "deeper" too
    const deep = run(pool, today, { shown: new Map(order.slice(0, 41).map((id, j) => [id, day(i - 1 - (j % 30))])) });
    assert.deepEqual([deep.rows.tonight[0].id, deep.rows.tonight[9].id], [order[41], order[42]]);
    assert.deepEqual(deep.tonightRelief, [{ id: order[41], mood: first, kind: "deeper" }, { id: order[42], mood: first, kind: "deeper" }]);
  }
  assert.equal(differs, 20, "control: without the memory the tenth film would have been one of the three on every one of those days");
});

// ── the wiring: build.js and the nightly's list of caches ───────────────────────────────────────────────────────────────────────────────────

test("build.js reads the memory before the draw, hands it to buildRows, and writes it after the publication with the environment and --cache-only (the text of build.js; the executed build is in test/tonight-exclude.test.js)", () => {
  const src = fs.readFileSync(path.join(ROOT, "build.js"), "utf8");
  const read = src.indexOf('const tonightStep = require("./lib/tonight-memory").runInBuild({ noRepeatDays: TONIGHT.noRepeatDays, today, cacheDir: CACHE_DIR, log, person: tonightPerson });');
  // 15/11/2026: a person's build, and only a person's, files its row under its revision and is told which revisions were published
  assert.ok(src.includes('const tonightPerson = cfg.personContext ? { revision: cfg.personContext.revision, published: require("./lib/tonight-memory").revisionsOf(process.env.TONIGHT_PUBLISHED_REVISIONS) } : null;'), "Marco's build has no person context");
  const draw = src.indexOf("today, eligible: recommendable, tonightShown: tonightStep.shown, exempt:");
  const published = src.indexOf("} = publish({ outDir: OUT_DIR");
  const write = src.indexOf("tonightStep.remember(plan, process.env, CACHE_ONLY);");
  assert.ok(read > 0 && draw > read, "the memory is read, then handed to the draw");
  assert.ok(src.slice(read, draw).includes("buildRows({ pool: cands"), "the hand-over is in the call of buildRows that makes the night's rows");
  // the call still ENDS with the exemption of the mood Music: worker/mutation.mjs plants its defects on that text ("eligible: eligibleTt } : null });"), so the new argument goes before it
  assert.ok(src.includes("exempt: music.on && musicExempt.length ? { moods: new Set(musicExempt), eligible: eligibleTt } : null });"));
  assert.ok(published > draw && write > published, "the write comes after the publication: a night that stopped before it records no row nobody saw");
  assert.equal(src.split("tonightStep.remember(").length, 2, "written in one place");
  assert.match(src, /const TONIGHT = \(\(\) => \{ try \{ return tonightSpec\(cfg\); \}/, "config.json tonight is checked before any work");
});

test("the nightly saves the file and sets its switch: tonight-memory.json is in the list of caches of scripts/noturna-mac.sh, of the boundary check and of the workflow's two loops and its git add (a cache that is not in them is wiped when the clone is brought back to origin/main); TONIGHT_MEMORY_WRITE is set by the two modes that publish", () => {
  const sh = fs.readFileSync(path.join(ROOT, "scripts", "noturna-mac.sh"), "utf8");
  assert.ok(sh.match(/readonly CACHES="([^"]+)"/)[1].split(" ").includes(TM.MEMORY_FILE), "scripts/noturna-mac.sh CACHES");
  assert.ok(require("../scripts/verify-artifact-boundaries").CACHE.includes(TM.MEMORY_FILE), "scripts/verify-artifact-boundaries.js CACHE");
  const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "mood-engine.yml"), "utf8");
  const loops = yml.split("\n").filter((l) => /^\s*for f in .*mubi-report\.json/.test(l));
  assert.equal(loops.length, 2);
  for (const l of loops) assert.match(l, /\btonight-memory\.json\b/, `a loop without the file: ${l.trim()}`);
  assert.match(yml, /^\s*git add cache\/tonight-memory\.json \|\| true\s*$/m, "git add");
  // who sets the switch (review of 14/11/2026, R5): the Mac's night in the two modes that publish, on both build lines (test/noturna-mac.test.js RUNS the three modes and reads what reached the build);
  // the workflow on the schedule alone, like the front memory's (its "Run workflow" publishes nothing while Pages serves the gh-pages branch)
  assert.match(sh, /^  if \[ "\$MODO" = agendada \] \|\| \[ "\$MODO" = manual \]; then TM=1; fi$/m, "--agendada and --manual, not --ensaio");
  assert.equal(sh.split('TONIGHT_MEMORY_WRITE="$TM"').length, 3, "the full build and the offline one both get the switch");
  const envs = yml.match(/^\s*TONIGHT_MEMORY_WRITE:.*$/gm) || [];
  assert.equal(envs.length, 1, "set once in the workflow, in the build step");
  assert.match(envs[0], /github\.event_name == 'schedule' && '1' \|\| ''/);
  const paths = yml.match(/^\s*#\s*paths: \[.*\]\s*$/m);
  assert.ok(paths && !paths[0].includes("tonight-memory"), "and a change to it alone would start no build (the on.push paths, kept as a comment, leave it out)");
});
