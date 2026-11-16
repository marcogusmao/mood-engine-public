// node --test            (no dependencies)
// The front shuffle of the v2 Board (Marco, 14/10/2026; lib/front-shuffle.js, spec .context/pesquisa/2026-10-14-shuffle-inteligente-spec.md of the Stremio repository, design C).
// His four answers, pinned in test/board-production.test.js: strong intensity (tau 15, penalty 10), memory in cache/front-memory.json, at most 3 fronts for one film in a day (and 1 opening),
// Tonight and the Watchlist left alone, the front is the first 8 places.
//
// Part 1 is the pure module on small worlds: each test says what it asserts, and the commit message lists the mutation that turns each one red (and the ones that do not).
// Part 2 is the memory file and the decision to write it. Part 3 is the plan (the legacy Board is not touched). Part 4 is the workflow text (the file is in the three lists).
// Part 5 builds the real Board offline (13 s a build) from a copy of the caches: determinism, the cap on the real rows, rowDesc following the films, a corrupt memory file not stopping the build,
// a bad `shuffle` in the config stopping it naming the key. No test here pins a number of the real caches (they change every night): they compare a build with the same build without `shuffle`.

const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const FS = require("../lib/front-shuffle");

const ROOT = path.join(__dirname, "..");
const tt = (n) => "tt" + String(n).padStart(7, "0");
const PROD = { front: 8, tau: 15, penalty: 10, maxFronts: 3, maxLeads: 1, memory: "file", memoryDays: 7, halfLifeDays: 2, keep: ["tonight", "watchlist"] }; // what Marco decided
const OPEN = { ...PROD, maxFronts: 1e9, maxLeads: 1e9 }; // no cap across rows: a row on its own
const own = (r, n) => Array.from({ length: n }, (_, j) => tt(r * 1000 + j)); // n films that belong to row number r alone
const rowsOf = (n, films) => Array.from({ length: n }, (_, r) => ({ id: `row${r}`, place: "board", ids: own(r + 1, films) }));
const A = tt(1);
/** n rows of `len` films that all start with the same film A: the case the cap exists for. */
const sharedHead = (n, len = 30) => Array.from({ length: n }, (_, r) => ({ id: `s${r}`, place: "board", ids: [A, ...own(r + 10, len - 1)] }));
const days = (n, from = "2026-10-15") => Array.from({ length: n }, (_, i) => FS.shiftDate(from, i));
const front = (day, id) => day.order.get(id).slice(0, 8);
const dump = (day) => JSON.stringify([...day.order]);
const tmp = (p = "front-shuffle-test-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

// ── 1. the draw ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("the same date and the same rows give the same order; a build repeated on the day agrees with itself", () => {
  const rows = [...rowsOf(10, 60), ...sharedHead(4)];
  for (const d of days(3)) assert.equal(dump(FS.orderRows(rows, d, PROD)), dump(FS.orderRows(rows, d, PROD)), `${d}: two draws of one day`);
  assert.equal(FS.gumbel("2026-10-15", "slow", tt(5)), FS.gumbel("2026-10-15", "slow", tt(5)), "one number per (date, row, film)");
  assert.notEqual(FS.gumbel("2026-10-15", "slow", tt(5)), FS.gumbel("2026-10-15", "slow", tt(6)), "and it is not one number for all");
});

// review 15/10/2026: with the row id out of the seed 66 tests stayed green, and the 30-day simulation fell from 368 to 303 different films a day: every row would draw the same order for the same films.
test("two rows with the same films, on the same day, are drawn in different orders: the row is part of the seed", () => {
  const ids = own(1, 60);
  assert.notEqual(FS.gumbel("2026-10-15", "slow", tt(5)), FS.gumbel("2026-10-15", "letin", tt(5)), "one number per ROW as well");
  let same = 0;
  for (const d of days(20)) {
    const day = FS.orderRows([{ id: "slow", place: "board", ids }, { id: "letin", place: "board", ids }], d, OPEN);
    if (front(day, "slow").join() === front(day, "letin").join()) same++;
  }
  assert.equal(same, 0, `${same} of 20 days gave the two rows the same front`);
});

test("another date draws another front: most of 20 rows of 100 films change their first 8 places", () => {
  const rows = rowsOf(20, 100);
  const a = FS.orderRows(rows, "2026-10-15", PROD), b = FS.orderRows(rows, "2026-10-16", PROD);
  const moved = rows.filter((r) => front(a, r.id).join() !== front(b, r.id).join()).length;
  assert.ok(moved >= 16, `${moved} of 20 rows changed their front (at least 16, 80%)`);
});

test("a film's noise does not depend on the other films: taking the strict first out of a row keeps the order of all the others", () => {
  // (taking a film from the MIDDLE moves only the films below it by one place, so a pair across it may swap: that is the position weight, not the noise)
  const ids = own(1, 60);
  for (const d of days(12)) {
    const whole = FS.orderRows([{ id: "r", place: "board", ids }], d, OPEN).order.get("r");
    const cut = FS.orderRows([{ id: "r", place: "board", ids: ids.slice(1) }], d, OPEN).order.get("r");
    assert.deepEqual(cut, whole.filter((x) => x !== ids[0]), `${d}: the others in the same order`);
  }
});

test("the position weighs: in a row of 100 films over 300 dates the strict first is up front on at least half of them and the 90th on at most 2%", () => {
  const ids = own(1, 100), spec = { ...OPEN, tau: 8 };
  let first = 0, ninetieth = 0;
  const dates = days(300, "2026-01-01");
  for (const d of dates) {
    const f = FS.orderRows([{ id: "r", place: "board", ids }], d, spec).order.get("r").slice(0, 8);
    if (f.includes(ids[0])) first++;
    if (f.includes(ids[89])) ninetieth++;
  }
  assert.ok(first / 300 >= 0.5, `the first was up front ${first} of 300 days`);
  assert.ok(ninetieth / 300 <= 0.02, `the 90th was up front ${ninetieth} of 300 days`);
});

// ── 2. the cap across rows ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("six rows that all start with the same film: it is up front in at most maxFronts of them and opens at most one, over 60 days; and the cap is what holds it (it reaches the cap on some day)", () => {
  const rows = sharedHead(6);
  let reached = 0, ordersWithoutCap = 0;
  for (const d of days(60)) {
    const day = FS.orderRows(rows, d, PROD);
    assert.ok((day.fronts.get(A) || 0) <= 3, `${d}: ${A} up front in ${day.fronts.get(A)} rows`);
    assert.ok((day.leads.get(A) || 0) <= 1, `${d}: ${A} opens ${day.leads.get(A)} rows`);
    assert.equal(day.forced, 0, `${d}: nothing had to go over the cap`);
    if (day.fronts.get(A) === 3) reached++;
    if (FS.orderRows(rows, d, OPEN).fronts.get(A) > 3) ordersWithoutCap++;
  }
  assert.ok(reached > 0, "on some day the film is blocked at 3: the cap was in play");
  assert.ok(ordersWithoutCap > 0, "and without the cap the same days would put it up front in more than 3 rows");
  for (const d of days(20)) assert.ok((FS.orderRows(rows, d, { ...PROD, maxFronts: 1 }).fronts.get(A) || 0) <= 1, `${d}: maxFronts 1`);
});

test("a film over the cap is demoted and stays in the row: every row has the same films and the same length as before, and the blocked film sits after the front", () => {
  const rows = sharedHead(6);
  let blocked = 0;
  for (const d of days(60)) {
    const day = FS.orderRows(rows, d, PROD);
    for (const r of rows) {
      const out = day.order.get(r.id);
      assert.equal(out.length, r.ids.length, `${d} ${r.id}: same length`);
      assert.deepEqual([...out].sort(), [...r.ids].sort(), `${d} ${r.id}: the same films`);
    }
    const fronted = rows.filter((r) => front(day, r.id).includes(A)).length;
    for (const r of rows) if (!front(day, r.id).includes(A) && fronted === 3) { blocked++; assert.ok(day.order.get(r.id).indexOf(A) >= 8, `${d} ${r.id}: ${A} is past the front`); }
  }
  assert.ok(blocked > 0, "some row had its first film blocked");
});

test("a row too short to fill its front without the blocked film is completed with it and the build counts it (forced); so is a film that has to open a second row", () => {
  const rows = [{ id: "a", place: "board", ids: [A] }, { id: "b", place: "board", ids: [A] }, { id: "c", place: "board", ids: [A] }];
  const day = FS.orderRows(rows, "2026-10-15", { ...PROD, maxFronts: 2 });
  assert.deepEqual([...day.order.values()], [[A], [A], [A]], "a row of one film keeps its film");
  assert.equal(day.forced, 2, "the second row opens with a film that already opens one (over maxLeads), the third has nobody else (over maxFronts, and over maxLeads: one place, counted once)");
  assert.equal(day.fronts.get(A), 3);
  assert.equal(day.leads.get(A), 3);
  // review 15/10/2026: [A], [B], [A, B]: the third row has only films that already open a row, so one of them opens a second row; forced used to say 0 while the BACKLOG said "at most 1 opening unless forced"
  const ab = [{ id: "a", place: "board", ids: [A] }, { id: "b", place: "board", ids: [tt(2)] }, { id: "c", place: "board", ids: [A, tt(2)] }];
  for (const d of days(10)) {
    const r = FS.orderRows(ab, d, PROD);
    assert.equal(r.forced, 1, `${d}: one place over the opening cap`);
    assert.equal(Math.max(...r.leads.values()), 2, `${d}: and a film does open two rows`);
  }
  assert.equal(FS.orderRows([{ id: "a", place: "board", ids: [A, tt(2)] }, { id: "b", place: "board", ids: [tt(2), A] }], "2026-10-15", PROD).forced, 0, "two films that can share the openings: nothing over the cap");
});

test("Tonight and the Watchlist (keep) and a row of the Moods menu keep their order, and the front of a kept row counts for the cap", () => {
  const rows = [
    { id: "tonight", place: "board", ids: [A, ...own(50, 20)] },
    { id: "menu-row", place: "menu", ids: [A, ...own(51, 20)] },
    ...sharedHead(5),
  ];
  const spec = { ...PROD, maxFronts: 1 };
  for (const d of days(30)) {
    const day = FS.orderRows(rows, d, spec);
    assert.deepEqual(day.order.get("tonight"), rows[0].ids, `${d}: Tonight in its own order`);
    assert.deepEqual(day.order.get("menu-row"), rows[1].ids, `${d}: a menu row in its own order`);
    assert.equal(day.fronts.get(A), 1, `${d}: ${A} is in Tonight's front, so no shuffled row may put it up front too (and the menu row is not on the Board)`);
    assert.equal(day.leads.get(A), 1, `${d}: and it opens Tonight alone`);
    assert.deepEqual([day.shuffled, day.kept], [5, 1]);
  }
});

test("a row with a film twice is left in its strict order and named (skipped)", () => {
  const rows = [{ id: "dup", place: "board", ids: [A, tt(2), A, tt(3)] }, ...rowsOf(1, 30)];
  const day = FS.orderRows(rows, "2026-10-15", PROD);
  assert.deepEqual(day.order.get("dup"), rows[0].ids);
  assert.deepEqual(day.skipped, ["dup"]);
  assert.equal(day.shuffled, 1);
});

// ── 3. the memory ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("the exposure of a film: 1 a day ago and 2 three days ago and 9 a week and a day ago, and today's own entry, do not add up to more than 3 (half-life 2 days, 7 days)", () => {
  const D = "2026-10-15";
  const memory = new Map([[FS.shiftDate(D, -1), new Map([["X", 2]])], [FS.shiftDate(D, -3), new Map([["X", 2]])], [FS.shiftDate(D, -9), new Map([["X", 5]])], [D, new Map([["X", 9]])]]);
  assert.equal(FS.exposure(memory, D, PROD).get("X"), 3, "2 × 1 + 2 × 2^(-2/2); the entry of D-9 is past the horizon and the entry of D itself is never read");
  assert.equal(FS.exposure(new Map([[FS.shiftDate(D, -7), new Map([["X", 8]])]]), D, PROD).get("X"), 1, "the 7th day back still counts, at 2^(-6/2)");
  assert.equal(FS.exposure(new Map([[FS.shiftDate(D, -8), new Map([["X", 8]])]]), D, PROD).get("X"), undefined, "the 8th does not");
  assert.equal(FS.exposure(memory, D, { ...PROD, memoryDays: 0 }).size, 0, "memoryDays 0: no memory");
});

test("what was up front yesterday is less likely up front today: with the same rows, less of the front repeats when the memory of the day before is read (5 pairs of days)", () => {
  const rows = rowsOf(20, 100);
  let kept = 0, without = 0;
  for (const d1 of days(5)) {
    const d2 = FS.shiftDate(d1, 1);
    const first = FS.orderRows(rows, d1, PROD);
    const memory = new Map([[d1, first.fronts]]);
    const overlap = (day) => rows.reduce((n, r) => n + front(day, r.id).filter((x) => front(first, r.id).includes(x)).length, 0);
    kept += overlap(FS.orderRows(rows, d2, PROD, FS.exposure(memory, d2, PROD)));
    without += overlap(FS.orderRows(rows, d2, PROD));
  }
  assert.ok(kept < without, `${kept} films repeated with the memory, ${without} without it`);
  assert.ok(kept <= without * 0.8, `and the memory takes at least a fifth of the repeats off (${kept} against ${without})`);
});

test("a film with a heavy exposure is not up front, and without it the same film is: the penalty is applied to the film that earned it", () => {
  const ids = own(1, 40), X = ids[0];
  let withE = 0, without = 0;
  for (const d of days(40)) {
    if (FS.orderRows([{ id: "r", place: "board", ids }], d, OPEN, new Map([[X, 50]])).order.get("r").slice(0, 8).includes(X)) withE++;
    if (FS.orderRows([{ id: "r", place: "board", ids }], d, OPEN).order.get("r").slice(0, 8).includes(X)) without++;
  }
  assert.equal(withE, 0, "exposure 50 = 500 places down");
  assert.ok(without >= 10, `and with none it is up front on ${without} of 40 days`);
});

test("the memory file: a second write on the same day replaces the first, dates past the horizon go, dates and films are sorted, one line a day, and what is written is read back", () => {
  const dir = tmp(), file = path.join(dir, "front-memory.json");
  try {
    let memory = new Map();
    for (const d of ["2026-10-01", "2026-10-09", "2026-10-10"]) { FS.writeMemory(file, memory, d, new Map([[tt(9), 1], [tt(2), 3]]), PROD); memory = FS.readMemory(file).days; }
    assert.deepEqual([...memory.keys()], ["2026-10-09", "2026-10-10"], "2026-10-01 is more than 7 days before 2026-10-10: gone");
    FS.writeMemory(file, memory, "2026-10-10", new Map([[tt(5), 2]]), PROD);
    FS.writeMemory(file, FS.readMemory(file).days, "2026-10-10", new Map([[tt(7), 4]]), PROD);
    const back = FS.readMemory(file);
    assert.equal(back.problem, null);
    assert.deepEqual([...back.days.get("2026-10-10")], [[tt(7), 4]], "the second write of the day replaced the first (no sum, no second entry)");
    assert.deepEqual([...back.days.keys()], ["2026-10-09", "2026-10-10"]);
    const text = fs.readFileSync(file, "utf8");
    assert.equal(text.split("\n").length, 5, "{ days:, one line a day, }} and the final newline");
    assert.equal(text, `{"version":1,"days":{\n"2026-10-09":{"${tt(2)}":3,"${tt(9)}":1},\n"2026-10-10":{"${tt(7)}":4}\n}}\n`, "dates and films in order");
    assert.deepEqual(fs.readdirSync(dir), ["front-memory.json"], "no temporary file left behind");
    JSON.parse(text); // the commit-cache job checks every cache/*.json parses
    // the dates are written sorted, not in the order the Map holds them
    FS.writeMemory(file, new Map([["2026-10-10", new Map([[tt(1), 1]])], ["2026-10-08", new Map([[tt(1), 1]])], ["2026-10-09", new Map([[tt(1), 1]])]]), "2026-10-11", new Map([[tt(2), 1]]), PROD);
    assert.deepEqual(fs.readFileSync(file, "utf8").split("\n").slice(1, 5).map((l) => l.slice(1, 11)), ["2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]);
    // a date after today (a clock or a typed date gone wrong) is not part of the memory: the write drops it
    FS.writeMemory(file, new Map([["2027-01-01", new Map([[tt(1), 1]])], ["2026-10-10", new Map([[tt(1), 1]])]]), "2026-10-11", new Map([[tt(2), 1]]), PROD);
    assert.deepEqual([...FS.readMemory(file).days.keys()], ["2026-10-10", "2026-10-11"]);
    // atomic: a write that dies on the way (the rename fails) leaves the file as it was
    const kept = fs.readFileSync(file), rename = fs.renameSync;
    fs.renameSync = () => { throw new Error("disk full"); };
    try { assert.throws(() => FS.writeMemory(file, FS.readMemory(file).days, "2026-10-12", new Map([[tt(3), 3]]), PROD), /disk full/); } finally { fs.renameSync = rename; }
    assert.ok(fs.readFileSync(file).equals(kept), "the old file is untouched");
  } finally { rm(dir); }
});

test("the memory file that cannot be used is an empty memory with the reason: unreadable, not JSON, another version, a count of 0 or 55, a day that is not a date, a film that is not an id; a missing file is empty with no reason", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "m.json");
    assert.deepEqual([FS.readMemory(file).days.size, FS.readMemory(file).problem], [0, null], "missing: a fresh start, nothing to say");
    const bad = (text, re) => { fs.writeFileSync(file, text); const r = FS.readMemory(file); assert.equal(r.days.size, 0, text); assert.match(r.problem, re, text); };
    bad("{not json", /not valid JSON/);
    bad("", /not valid JSON/);
    bad('{"version":2,"days":{}}', /version 2 is not 1/);
    bad("[]", /version/);
    bad('{"version":1,"days":[]}', /days is not an object/);
    bad(`{"version":1,"days":{"2026-10-10":{"${tt(1)}":0}}}`, /count 0/);
    bad(`{"version":1,"days":{"2026-10-10":{"${tt(1)}":55}}}`, /count 55/);
    bad(`{"version":1,"days":{"2026-10-10":{"${tt(1)}":1.5}}}`, /count 1\.5/);
    bad(`{"version":1,"days":{"2026-02-30":{"${tt(1)}":1}}}`, /not a date/);
    bad(`{"version":1,"days":{"9999-99-99":{"${tt(1)}":1}}}`, /not a date/);
    bad(`{"version":1,"days":{"yesterday":{"${tt(1)}":1}}}`, /not a date/);
    bad('{"version":1,"days":{"2026-10-10":{"Mirror":1}}}', /not an IMDb id/);
    fs.mkdirSync(path.join(dir, "folder"));
    const r = FS.readMemory(path.join(dir, "folder"));
    assert.equal(r.days.size, 0);
    assert.match(r.problem, /cannot be read/);
    fs.writeFileSync(file, '{"version":1,"days":{}}');
    assert.deepEqual([FS.readMemory(file).days.size, FS.readMemory(file).problem], [0, null], "a sound file with no days is a sound empty memory");
  } finally { rm(dir); }
});

test("today's front is written only by the scheduled build (FRONT_MEMORY_WRITE=1) and never by --cache-only; memory \"none\" writes nothing", () => {
  const dir = tmp(), file = path.join(dir, "front-memory.json");
  try {
    const run = (env, cacheOnly, spec = PROD) => FS.rememberFront({ file, days: new Map(), today: "2026-10-15", fronts: new Map([[tt(1), 2]]), spec, env, cacheOnly });
    assert.equal(run({}, false).written, false, "a build of a push or a test");
    assert.equal(run({ FRONT_MEMORY_WRITE: "" }, false).written, false, "the workflow sets it to empty outside the schedule");
    assert.equal(run({ FRONT_MEMORY_WRITE: "1" }, true).written, false, "--cache-only writes no cache");
    assert.equal(run({ FRONT_MEMORY_WRITE: "1" }, false, { ...PROD, memory: "none" }).written, false);
    assert.equal(fs.existsSync(file), false, "none of those wrote");
    const w = run({ FRONT_MEMORY_WRITE: "1" }, false);
    assert.equal(w.written, true);
    assert.deepEqual([...FS.readMemory(file).days.get("2026-10-15")], [[tt(1), 2]]);
  } finally { rm(dir); }
});

test("the days that count for today are today-7 … today-1: today's own entry, older ones and dates in the future do not, and the future ones are named", () => {
  const D = "2026-10-15", day = new Map([[tt(1), 1]]);
  const memory = new Map(["2027-01-01", "2026-10-16", D, "2026-10-14", "2026-10-08", "2026-10-07", "2026-10-01"].map((d) => [d, day]));
  assert.deepEqual(FS.usedDays(memory, D, PROD), ["2026-10-08", "2026-10-14"], "the 7th day back counts, the 8th does not");
  assert.deepEqual(FS.futureDays(memory, D), ["2026-10-16", "2027-01-01"]);
  assert.deepEqual(FS.futureDays(new Map([[D, day]]), D), [], "today's own entry is not the future");
  assert.deepEqual(FS.usedDays(memory, D, { ...PROD, memoryDays: 0 }), [], "memoryDays 0");
});

// review 15/10/2026: build.js wrote the memory with `days` as an argument, and no test showed it keeps the OTHER days. runInBuild is the code build.js runs; here it runs on a plan and a cache folder of its own.
test("the code build.js runs: it reads the memory, shuffles, logs, and (scheduled, not --cache-only) writes today's front next to ALL the days it read; the same night repeated changes nothing", () => {
  const dir = tmp(), file = path.join(dir, "front-memory.json");
  try {
    const old = new Map([[tt(7), 2]]);
    FS.writeMemory(file, new Map(), "2026-10-13", old, PROD);
    FS.writeMemory(file, FS.readMemory(file).days, "2026-10-14", new Map([[tt(8), 1]]), PROD);
    const logs = [];
    const run = (env, cacheOnly) => {
      const plan = planOf();
      const step = FS.runInBuild({ plan, today: "2026-10-15", shuffle: PROD, cacheDir: dir, log: (l) => logs.push(l) });
      return { plan, w: step.remember(env, cacheOnly) };
    };
    const reads = run({}, false);
    assert.equal(reads.w.written, false, "a build of a commit only reads");
    assert.match(logs.join("\n"), /memory: 2 days read \(2026-10-13 to 2026-10-14\), 2 films carry a penalty/);
    assert.match(logs.join("\n"), /Front memory: not written \(FRONT_MEMORY_WRITE is not 1/);
    assert.deepEqual([...FS.readMemory(file).days.keys()], ["2026-10-13", "2026-10-14"], "and the file is as it was");
    assert.equal(run({ FRONT_MEMORY_WRITE: "1" }, true).w.written, false, "--cache-only never writes");
    const night = run({ FRONT_MEMORY_WRITE: "1" }, false);
    assert.equal(night.w.written, true);
    const back = FS.readMemory(file).days;
    assert.deepEqual([...back.keys()], ["2026-10-13", "2026-10-14", "2026-10-15"], "the two days that were read are still there, and today's is added");
    assert.deepEqual([...back.get("2026-10-13")], [...old], "untouched");
    const fronts = new Map();
    for (const r of night.plan.board2) if (r.place === "board" && !r.series) for (const it of r.items.slice(0, 8)) fronts.set(it.id, (fronts.get(it.id) || 0) + 1);
    assert.deepEqual([...back.get("2026-10-15")].sort(), [...fronts].sort(), "today's entry is the fronts of the plan as published (kept rows included)");
    // the same night again: it reads its own entry, ignores it, draws the same order and writes the same file
    const before = fs.readFileSync(file, "utf8"), again = run({ FRONT_MEMORY_WRITE: "1" }, false);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.deepEqual(again.plan.board2.map((r) => r.items.map((x) => x.id)), night.plan.board2.map((r) => r.items.map((x) => x.id)));
    // a date after today is named in the log, not counted, and the next write drops it
    fs.writeFileSync(file, `{"version":1,"days":{\n"2026-10-14":{"${tt(8)}":1},\n"2027-01-01":{"${tt(9)}":1}\n}}\n`);
    logs.length = 0;
    run({ FRONT_MEMORY_WRITE: "1" }, false);
    assert.match(logs.join("\n"), /! front memory: 1 date after 2026-10-15 \(2027-01-01\) ignored/);
    assert.match(logs.join("\n"), /memory: 1 day read \(2026-10-14 to 2026-10-14\), 1 films carry a penalty/);
    assert.deepEqual([...FS.readMemory(file).days.keys()], ["2026-10-14", "2026-10-15"]);
    // without board.shuffle: the strict order is measured and nothing is written
    logs.length = 0;
    const off = FS.runInBuild({ plan: planOf(), today: "2026-10-15", shuffle: null, cacheDir: dir, log: (l) => logs.push(l) });
    assert.match(logs.join("\n"), /Front shuffle \(v2 Board\): off · strict: front \d+ films/);
    assert.equal(off.remember({ FRONT_MEMORY_WRITE: "1" }, false).written, false);
  } finally { rm(dir); }
});

// ── 4. the plan ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A plan like buildPlan's: plan.board (the legacy Board) and plan.board2 (the v2 Board), their items frozen so that a write to one is an error. */
function planOf() {
  const item = (id) => Object.freeze({ id, title: id, year: 2000, mood: "m", why: [id] });
  const legacy = (id, ids) => ({ id, name: id, items: ids.map(item) });
  const v2 = (id, ids, extra = {}) => ({ id, name: id, place: "board", items: ids.map(item), ...extra });
  const sets = { tonight: [A, ...own(60, 12)], watchlist: [A, ...own(61, 20)], slow: [A, ...own(62, 60)], escape: [A, ...own(63, 60)], letin: [A, ...own(64, 60)], "friends-week": own(65, 15) };
  return {
    board: Object.entries(sets).map(([id, ids]) => legacy(id, ids)),
    board2: [v2("tonight", sets.tonight), v2("watchlist", sets.watchlist), v2("my-series", [], { series: true }), v2("slow", sets.slow), v2("escape", sets.escape), v2("letin", sets.letin), v2("friends-week", sets["friends-week"], { place: "menu" })],
    discover: [],
  };
}

test("applyToPlan reorders plan.board2 rows on the Board that are not kept, and nothing else: plan.board, the kept rows, the series row and the menu row stay as they were, and no item object is touched", () => {
  const plan = planOf(), before = JSON.stringify(plan), boardItems = plan.board.map((r) => r.items), v2Items = new Map(plan.board2.map((r) => [r.id, r.items]));
  const r = FS.applyToPlan(plan, "2026-10-15", PROD, new Map());
  assert.equal(JSON.stringify(plan.board), JSON.stringify(JSON.parse(before).board), "the legacy Board is byte for byte what it was");
  plan.board.forEach((row, i) => assert.equal(row.items, boardItems[i], `${row.id}: the very same array`));
  for (const id of ["tonight", "watchlist", "my-series", "friends-week"]) assert.equal(plan.board2.find((x) => x.id === id).items, v2Items.get(id), `${id}: untouched`);
  for (const id of ["slow", "escape", "letin"]) {
    const row = plan.board2.find((x) => x.id === id);
    assert.notEqual(row.items, v2Items.get(id), `${id}: a new array`);
    assert.deepEqual(row.items.map((x) => x.id).sort(), v2Items.get(id).map((x) => x.id).sort(), `${id}: the same films`);
    for (const it of row.items) assert.ok(v2Items.get(id).includes(it), `${id}: the very same item objects (their reason lines go with them)`);
  }
  assert.deepEqual([r.shuffled, r.kept], [3, 2]);
  assert.equal(r.strictReport.maxFronts, 5, "the strict Board has A up front in 5 rows");
  assert.ok(r.report.maxFronts <= 3, `and the shuffled one at most 3: ${JSON.stringify(r.report)}`);
  assert.equal(r.report.maxLeads, 2, "Tonight and the Watchlist both open with A (they are kept)");
  for (const id of ["slow", "escape", "letin"]) assert.notEqual(plan.board2.find((x) => x.id === id).items[0].id, A, `${id}: A already opens two rows, so it does not open a third`);
  assert.equal(r.report.places, 5 * 8, "five rows on the Board with a front of 8 (the menu row and the series row are not on it)");
});

test("applyToPlan with the memory of yesterday: the films that were up front are pushed down; without board2 (no board) it does nothing", () => {
  const plan = planOf(), strictFront = plan.board2.find((x) => x.id === "slow").items.slice(0, 8).map((x) => x.id);
  const memory = new Map([["2026-10-14", new Map(strictFront.map((x) => [x, 5]))]]);
  const r = FS.applyToPlan(plan, "2026-10-15", PROD, memory);
  assert.equal(r.exposed, 8);
  assert.equal(plan.board2.find((x) => x.id === "slow").items.slice(0, 8).filter((x) => strictFront.includes(x.id)).length <= 1, true, "a heavy exposure empties the front of its films");
  assert.doesNotThrow(() => FS.applyToPlan({ board: [] }, "2026-10-15", PROD));
});

test("frontReport counts the distinct films, the places, the most rows one film is up front in and the most it opens; rows of the menu are not on the Board", () => {
  const rows = [{ id: "a", place: "board", ids: ["x", "y"] }, { id: "b", place: "board", ids: ["x", "z", "w"] }, { id: "m", place: "menu", ids: ["x"] }];
  const strict = new Map(rows.map((r) => [r.id, r.ids]));
  assert.deepEqual(FS.frontReport(strict, rows, 2), { films: 3, places: 4, maxFronts: 2, maxLeads: 2 });
  assert.deepEqual(FS.frontReport(strict, rows, 1), { films: 1, places: 2, maxFronts: 2, maxLeads: 2 });
  assert.deepEqual(FS.frontReport(new Map(), [], 8), { films: 0, places: 0, maxFronts: 0, maxLeads: 0 });
});

// ── 5. the workflow: the memory file in the three lists ─────────────────────────────────────────────────────────────────────────────────────

test("the workflow hands front-memory.json over in both loops and commits it, writes it only on the schedule, and a change to it alone would start no build (the push trigger is commented out since 21/10/2026)", () => {
  const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "mood-engine.yml"), "utf8");
  const loops = yml.split("\n").filter((l) => /^\s*for f in .*mubi-report\.json/.test(l));
  assert.equal(loops.length, 2, "the hand-over loop of the build job and the copy loop of commit-cache");
  for (const l of loops) assert.match(l, /\bfront-memory\.json\b/, `a loop without the file: ${l.trim()}`);
  assert.match(yml, /^\s*git add cache\/front-memory\.json \|\| true\s*$/m, "git add");
  const env = yml.match(/^\s*FRONT_MEMORY_WRITE:.*$/gm) || [];
  assert.equal(env.length, 1, "set once, in the build step");
  assert.match(env[0], /github\.event_name == 'schedule' && '1' \|\| ''/, "only the schedule writes");
  const build = yml.slice(yml.indexOf("- name: Build rows from Letterboxd + TMDB"));
  assert.ok(build.indexOf("FRONT_MEMORY_WRITE") > 0 && build.indexOf("FRONT_MEMORY_WRITE") < build.indexOf("run: node build.js"), "inside the env of the build step, before its run");
  // 21/10/2026: the push trigger is a comment now (the nightly runs on the Mac); the list is kept for when it comes back, and it must still leave this file out.
  const paths = yml.match(/^\s*#\s*paths: \[.*\]\s*$/m);
  assert.ok(paths, "the on.push paths are kept as a comment (push trigger commented out since 21/10/2026)");
  assert.ok(paths[0].includes('"cache/imdb-ratings.json"') && !paths[0].includes("front-memory"), "the on.push paths list the other cache files and not this one: the nightly commit of the memory starts no build");
});

// ── 6. the real Board, offline ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const CONFIG = require("../config.json");
const BUILD_ARGS = (work, cache, out, date, config) => [path.join(ROOT, "build.js"), "--offline", "--cache-only", "--skip-posters", "--date", date, "--captured-at", `${date}T12:00:00.000Z`, "--config", config, "--cache-dir", cache, "--out", out];
let built = null;
/** Builds once for the whole file; the work folder is removed at the end. Caches are COPIES: the build must not touch the repository's. */
function builds() {
  if (built) return built;
  const work = tmp("front-shuffle-build-");
  const copyCache = (name) => {
    const dir = path.join(work, name);
    fs.mkdirSync(dir);
    // never the repository's front-memory.json: from the second scheduled night it exists there, and a test that read it would depend on the night (found in review 15/10/2026: "memory: 0 days read" went red)
    // nor its tonight-memory.json (14/11/2026, lib/tonight-memory.js), for the same reason: the Tonight of these builds is the one of a day with no memory
    for (const n of fs.readdirSync(path.join(ROOT, "cache"))) if (n.endsWith(".json") && n !== FS.MEMORY_FILE && n !== require("../lib/tonight-memory").MEMORY_FILE) fs.copyFileSync(path.join(ROOT, "cache", n), path.join(dir, n));
    return dir;
  };
  const config = path.join(work, "config.json"), configOff = path.join(work, "config-off.json");
  fs.writeFileSync(config, JSON.stringify(CONFIG));
  const off = JSON.parse(JSON.stringify(CONFIG));
  delete off.board.shuffle;
  fs.writeFileSync(configOff, JSON.stringify(off));
  const run = (name, { cache = "cache", date = "2026-10-15", cfg = config, env = {} } = {}) => {
    const out = path.join(work, name);
    const r = spawnSync(process.execPath, BUILD_ARGS(work, path.join(work, cache), out, date, cfg), { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "", FRONT_MEMORY_WRITE: "", ...env } });
    return { out, status: r.status, log: r.stdout, err: r.stderr };
  };
  copyCache("cache");
  const a1 = run("a1"), a2 = run("a2"), d2 = run("d2", { date: "2026-10-16" }), off1 = run("off", { cfg: configOff });
  // a corrupt memory file in its own copy of the caches
  copyCache("cache-bad");
  fs.writeFileSync(path.join(work, "cache-bad", "front-memory.json"), '{"version":1,"days":{"2026-10-14":{"tt0000001":0}}}');
  const bad = run("bad", { cache: "cache-bad" });
  // and a sound one that says: the front of 2026-10-15 (the a1 build) was the front of YESTERDAY for a build of 2026-10-16
  const a1fronts = new Map();
  for (const f of rowFiles(a1.out)) if (f.place === "board") for (const t of f.ids.slice(0, 8)) a1fronts.set(t, (a1fronts.get(t) || 0) + 1);
  copyCache("cache-mem");
  const memFile = path.join(work, "cache-mem", "front-memory.json");
  FS.writeMemory(memFile, new Map(), "2026-10-15", a1fronts, CONFIG.board.shuffle);
  // ...with three dates that must not count for a build of 2026-10-16: one too old, the build's own day, and one in the future
  const planted = JSON.parse(fs.readFileSync(memFile, "utf8"));
  for (const d of ["2026-10-01", "2026-10-16", "2027-01-01"]) planted.days[d] = { [tt(1)]: 1 };
  fs.writeFileSync(memFile, JSON.stringify(planted));
  const memBefore = fs.readFileSync(memFile);
  const mem = run("mem", { cache: "cache-mem", date: "2026-10-16", env: { FRONT_MEMORY_WRITE: "1" } });
  return (built = { work, a1, a2, d2, off: off1, bad, mem, memBefore, memFile, a1fronts });
}
after(() => { if (built) rm(built.work); built = null; });

/** The row files of a build: [{ id, place, ids, desc }] in the Board's order (index-v2-menus.json), without the series row. */
function rowFiles(out) {
  const data = path.join(out, "data");
  const menus = JSON.parse(fs.readFileSync(path.join(data, "index-v2-menus.json"), "utf8"));
  return menus.board.filter((b) => !b.series).map((b) => {
    const j = JSON.parse(fs.readFileSync(path.join(data, `index-v2-row-${b.id}.json`), "utf8"));
    return { id: b.id, place: b.place, ids: j.rows[b.id], desc: j.rowDesc[b.id] };
  });
}
const walk = (dir, rel = "") => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(dir, path.join(rel, e.name)) : [path.join(rel, e.name)]));
const normalised = (f) => fs.readFileSync(f, "utf8").replace(/"builtAt":"[^"]*"/g, '"builtAt":"X"');
const reportOf = (rows, keep = []) => {
  const fronts = new Map(), leads = new Map();
  let places = 0;
  for (const r of rows) if (r.place === "board" && !keep.includes(r.id)) { for (const t of r.ids.slice(0, 8)) { fronts.set(t, (fronts.get(t) || 0) + 1); places++; } if (r.ids.length) leads.set(r.ids[0], (leads.get(r.ids[0]) || 0) + 1); }
  return { films: fronts.size, places, maxFronts: Math.max(0, ...fronts.values()), maxLeads: Math.max(0, ...leads.values()) };
};
const shuffleLine = (log) => (log.split("\n").find((l) => l.includes("Front shuffle (v2 Board):")) || "");

test("the real Board, offline: every build succeeds and prints one Front shuffle line with the numbers of the day, the strict ones beside it", { timeout: 600000 }, () => {
  const { a1, a2, d2, off, bad, mem } = builds();
  for (const [name, b] of Object.entries({ a1, a2, d2, off, bad, mem })) assert.equal(b.status, 0, `${name}: the build failed\n${(b.err || "").slice(-1500)}\n${(b.log || "").slice(-1000)}`);
  const line = shuffleLine(a1.log);
  assert.match(line, /^\s+Front shuffle \(v2 Board\): 51 rows shuffled, 2 kept · tau 15, penalty 10, front 8, at most 3 fronts and 1 lead per film · memory: 0 days read/);
  assert.match(line, /front \d+ films in \d+ places, at most \d fronts for one film, \d leads \(strict: front \d+ films in \d+ places, at most \d+ fronts for one film, \d+ leads\)$/);
  assert.equal(a1.log.split("\n").filter((l) => l.includes("Front shuffle (v2 Board)")).length, 1, "one line a build");
  assert.match(shuffleLine(off.log), /Front shuffle \(v2 Board\): off · strict: front \d+ films in \d+ places, at most \d+ fronts for one film, \d+ leads$/, "without board.shuffle the strict Board is still measured");
});

test("the measures in the log are the measures of the files: the instrument reads rows[id] as published", { timeout: 600000 }, () => {
  const { a1, off } = builds();
  const num = (log, re) => log.match(re).slice(1).map(Number);
  const mine = num(shuffleLine(a1.log), /\): .*· front (\d+) films in (\d+) places, at most (\d+) fronts for one film, (\d+) leads \(strict/);
  const files = rowFiles(a1.out), r = reportOf(files);
  assert.deepEqual(mine, [r.films, r.places, r.maxFronts, r.maxLeads], "the new order, from the files");
  const strict = num(shuffleLine(off.log), /strict: front (\d+) films in (\d+) places, at most (\d+) fronts for one film, (\d+) leads/);
  const o = reportOf(rowFiles(off.out));
  assert.deepEqual(strict, [o.films, o.places, o.maxFronts, o.maxLeads], "and the strict one");
  assert.deepEqual(num(shuffleLine(a1.log), /\(strict: front (\d+) films in (\d+) places, at most (\d+) fronts for one film, (\d+) leads\)/), strict, "the strict order the shuffled build reports is the order of the build without shuffle");
});

test("the cap on the real rows: the same film is up front in at most 3 rows (more only where the log counts forced places) and opens at most 1 shuffled row; the unshuffled Board is the positive control", { timeout: 600000 }, () => {
  const { a1, off } = builds();
  const files = rowFiles(a1.out), control = reportOf(rowFiles(off.out));
  assert.ok(control.maxFronts >= 5, `positive control: the strict Board has one film up front in ${control.maxFronts} rows`);
  const forced = Number(shuffleLine(a1.log).match(/forced (\d+)/)[1]);
  const r = reportOf(files);
  assert.ok(r.maxFronts <= 3 + (forced ? 1 : 0), `${r.maxFronts} rows with the same film up front (forced ${forced})`);
  const keepLeads = reportOf(files.filter((f) => ["tonight", "watchlist"].includes(f.id)), []).maxLeads;
  assert.ok(r.maxLeads <= Math.max(1, keepLeads) || forced > 0, `a film opens ${r.maxLeads} rows (Tonight and the Watchlist alone: ${keepLeads}; forced ${forced})`);
  assert.ok(r.films > control.films, `${r.films} different films up front against ${control.films} on the strict Board`);
});

test("the same date, the same caches, the same files: two builds of one day agree (builtAt aside); another date moves the front of most of the shuffled rows", { timeout: 600000 }, () => {
  const { a1, a2, d2 } = builds();
  const a = walk(a1.out).sort(), b = walk(a2.out).sort();
  assert.deepEqual(a, b);
  const moved = a.filter((f) => normalised(path.join(a1.out, f)) !== normalised(path.join(a2.out, f)));
  assert.deepEqual(moved, [], "files that differ between two builds of the same day");
  const x = rowFiles(a1.out), y = new Map(rowFiles(d2.out).map((r) => [r.id, r]));
  const shuffled = x.filter((r) => r.place === "board" && !["tonight", "watchlist"].includes(r.id) && r.ids.length > 8);
  const changed = shuffled.filter((r) => r.ids.slice(0, 8).join() !== y.get(r.id).ids.slice(0, 8).join()).length;
  assert.ok(changed >= Math.floor(shuffled.length * 0.8), `${changed} of ${shuffled.length} shuffled rows have another front the next day`);
});

test("shuffling reorders and never drops, duplicates or renames: each row has the films it had, Tonight and the Watchlist are as without the shuffle, and every rowDesc line stays with its film", { timeout: 600000 }, () => {
  const { a1, off } = builds();
  const before = new Map(rowFiles(off.out).map((r) => [r.id, r])), after = rowFiles(a1.out);
  assert.equal(after.length, before.size);
  let reordered = 0;
  for (const r of after) {
    const o = before.get(r.id);
    assert.deepEqual([...r.ids].sort(), [...o.ids].sort(), `${r.id}: the same films`);
    assert.equal(new Set(r.ids).size, r.ids.length, `${r.id}: no film twice`);
    assert.equal(r.desc.length, r.ids.length, `${r.id}: one description a film`);
    const text = new Map(o.ids.map((t, i) => [t, o.desc[i]]));
    r.ids.forEach((t, i) => assert.equal(r.desc[i], text.get(t), `${r.id} #${i} ${t}: the description of another film`));
    if (["tonight", "watchlist"].includes(r.id) || r.place !== "board") assert.deepEqual(r.ids, o.ids, `${r.id}: not shuffled`);
    else if (r.ids.join() !== o.ids.join()) reordered++;
  }
  assert.ok(reordered >= 45, `${reordered} rows came out in another order`);
});

test("the legacy family does not move: every file that is not index-v2*.json is the file of the build without the shuffle, builtAt aside", { timeout: 600000 }, () => {
  const { a1, off } = builds();
  const V2 = /^data\/index-v2(?:-[a-z0-9-]+)?\.json$/;
  const files = walk(a1.out).map((f) => f.split(path.sep).join("/")).sort();
  assert.deepEqual(files, walk(off.out).map((f) => f.split(path.sep).join("/")).sort());
  const moved = files.filter((f) => normalised(path.join(a1.out, f)) !== normalised(path.join(off.out, f)));
  assert.deepEqual(moved.filter((f) => !V2.test(f)), [], "legacy files that moved");
  assert.ok(moved.some((f) => V2.test(f)), "and the v2 family is what moved (positive control: the comparison can see a difference)");
  assert.ok(!files.some((f) => /front-memory/.test(f)), "the memory file is a cache, not a published file");
});

test("a corrupt memory file does not stop the build: it is logged and the build starts from no memory (the same files as a build with no file)", { timeout: 600000 }, () => {
  const { a1, bad } = builds();
  assert.equal(bad.status, 0);
  assert.match(bad.log, /! front memory: .*count 0.* — starting from no memory/);
  assert.match(shuffleLine(bad.log), /memory: 0 days read/);
  const moved = walk(a1.out).filter((f) => normalised(path.join(a1.out, f)) !== normalised(path.join(bad.out, f)));
  assert.deepEqual(moved, []);
});

test("a sound memory file is read by the build and moves the front; a --cache-only build never writes it, even with FRONT_MEMORY_WRITE=1", { timeout: 600000 }, () => {
  const { a1, d2, mem, memBefore, memFile, a1fronts } = builds();
  assert.match(shuffleLine(mem.log), /memory: 1 day read \(2026-10-15 to 2026-10-15\), \d+ films carry a penalty/, "of four dates in the file only yesterday counts");
  assert.match(mem.log, /! front memory: 1 date after 2026-10-16 \(2027-01-01\) ignored; the next write drops it/);
  assert.match(mem.log, /Front memory: not written \(--cache-only writes no cache\)/);
  assert.ok(fs.readFileSync(memFile).equals(memBefore), "the file is as it was");
  const day1 = new Map(rowFiles(a1.out).map((r) => [r.id, r.ids.slice(0, 8)]));
  const overlap = (build) => rowFiles(build.out).filter((r) => r.place === "board" && !["tonight", "watchlist"].includes(r.id)).reduce((n, r) => n + r.ids.slice(0, 8).filter((t) => day1.get(r.id).includes(t)).length, 0);
  assert.ok(overlap(mem) < overlap(d2), `the next day repeats ${overlap(mem)} films of the front with the memory and ${overlap(d2)} without it`);
  assert.ok(a1fronts.size > 0);
});

test("a bad board.shuffle stops the build at its first step and names the key", { timeout: 120000 }, () => {
  const dir = tmp();
  try {
    const attempt = (patch) => {
      const cfg = JSON.parse(JSON.stringify(CONFIG));
      cfg.board.shuffle = patch === null ? "off" : { ...cfg.board.shuffle, ...patch };
      const file = path.join(dir, "c.json");
      fs.writeFileSync(file, JSON.stringify(cfg));
      return spawnSync(process.execPath, [path.join(ROOT, "build.js"), "--offline", "--cache-only", "--skip-posters", "--config", file, "--out", path.join(dir, "out")], { cwd: ROOT, encoding: "utf8", env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" } });
    };
    for (const [patch, key] of [[{ tau: 0 }, "shuffle.tau"], [{ tau: -3 }, "shuffle.tau"], [{ penalty: "10" }, "shuffle.penalty"], [{ maxFronts: 0 }, "shuffle.maxFronts"], [{ colour: 1 }, "colour"], [{ keep: ["nope"] }, "shuffle.keep"], [{ memory: "replay" }, "shuffle.memory"], [null, "shuffle must be an object"]]) {
      const r = attempt(patch);
      assert.equal(r.status, 1, `${JSON.stringify(patch)}: the build stops`);
      assert.ok(r.stderr.includes(key), `${JSON.stringify(patch)}: the message names ${key}\n${r.stderr.slice(0, 500)}`);
      assert.ok(!fs.existsSync(path.join(dir, "out")), "and publishes nothing");
    }
  } finally { rm(dir); }
});
