// node --test
// Marco, 13/10/2026: the nightly MUBI step (scripts/mubi-nightly.js, lib/mubi-cache.js, the workflow step "Collect MUBI (≤100 requests)").
// No network anywhere: the collector run here is test-support/fake-mubi-collector.py, which is the REAL scripts/collect-mubi.py (arguments, identity rules, record
// shapes, stops, exit codes) with its network function replaced by a table that cannot leave the machine.
// Each test names what it asserts; the mutations that turn them red are listed in the commit message.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { selectFilms, rowOrder, run, settled, isRetry, attemptAt } = require("../scripts/mubi-nightly");
const MC = require("../lib/mubi-cache");

const ROOT = path.join(__dirname, "..");
const NIGHTLY = path.join(ROOT, "scripts", "mubi-nightly.js");
const FAKE = path.join(ROOT, "test-support", "fake-mubi-collector.py");
const tmp = (p = "mubi-nightly-test-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const DAY = 86400000;
const T0 = Date.now();
const clockOf = (day) => new Date(T0 + day * DAY).toISOString();

const tt = (n) => "tt" + String(n).padStart(7, "0");
const film = (n, extra = {}) => ({ tt: tt(n), name: `Film ${n}`, year: 1950 + (n % 60), runtime: 90 + (n % 30), director: `Director ${n}`, ...extra });

/** The Board of the fixture lists the mood row FIRST and Tonight THIRD, on purpose: the order of the step is Tonight, watchlist, then the rest. */
function baseIndex() {
  return {
    board: [{ id: "night", name: "Night" }, { id: "watchlist", name: "Watchlist" }, { id: "tonight", name: "Tonight" }, { id: "oldfriends", name: "Old friends" }],
    rows: { night: [tt(7), tt(8)], watchlist: [tt(4), tt(5), tt(2), tt(6)], tonight: [tt(1), tt(2), tt(3)], oldfriends: [tt(9)] },
    films: [film(1), film(2), film(3), film(4), film(5), film(6, { runtime: undefined }), film(7), film(8, { director: undefined }), film(9, { director: "Ann One, Bob Two" })],
  };
}

function bigIndex(n) {
  const films = Array.from({ length: n }, (_, i) => film(i + 1));
  return { board: [{ id: "night", name: "Night" }, { id: "tonight", name: "Tonight" }], rows: { night: films.slice(10).map((f) => f.tt), tonight: films.slice(0, 10).map((f) => f.tt) }, films };
}

/** A throw-away root with cache/ and the index file; returns helpers. */
function fixture(index = baseIndex()) {
  const root = tmp();
  fs.mkdirSync(path.join(root, "cache"));
  const indexFile = path.join(root, "index-board.json");
  fs.writeFileSync(indexFile, JSON.stringify(index));
  const log = path.join(root, "collector.log");
  const cacheFile = path.join(root, "cache", "mubi.json"), reportFile = path.join(root, "cache", "mubi-report.json");
  // `day`: how many days after the first run the clock of this run is (the step asks at most once a day, so a second run on the same day is refused)
  const night = (env = {}, args = [], day = 0) => spawnSync(process.execPath, [NIGHTLY, "--root", root, "--index", indexFile, "--collector", FAKE, "--now", clockOf(day), ...args], { encoding: "utf8", env: { ...process.env, FAKE_MUBI_LOG: log, ...env } });
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { root, indexFile, cacheFile, reportFile, night, lines, cache: () => JSON.parse(fs.readFileSync(cacheFile, "utf8")), report: () => JSON.parse(fs.readFileSync(reportFile, "utf8")), clean: () => rm(root) };
}
const asked = (fx) => fx.lines().filter((l) => l.request).map((l) => decodeURIComponent(l.request.match(/query=([^&]*)/)[1]));

// ── 1. what is asked, and in which order ────────────────────────────────────────────────────────────────────────────────────────────────────

test("the films are taken Tonight first, then the watchlist, then the other rows; a film in two rows counts once; no director or no row entry means not asked", () => {
  const index = baseIndex();
  assert.deepEqual(rowOrder(index), ["tonight", "watchlist", "night", "oldfriends"]);
  const got = selectFilms({ index, cache: { films: {} } });
  assert.deepEqual(got.map((f) => f.imdb), [tt(1), tt(2), tt(3), tt(4), tt(5), tt(6), tt(7), tt(9)], "film 2 is in Tonight and in the watchlist: once, in Tonight; film 8 has no director");
  assert.deepEqual(got[0], { imdb: tt(1), title: "Film 1", year: 1951, directors: ["Director 1"], runtime: 91 }, "the collector's input shape");
  assert.equal(got.find((f) => f.imdb === tt(6)).runtime, null, "a film with no runtime goes in with null");
  assert.deepEqual(got.find((f) => f.imdb === tt(9)).directors, ["Ann One", "Bob Two"]);
});

test("a row the Board does not list comes after the listed ones, and Tonight and the watchlist come first whatever the Board says", () => {
  const index = { board: [{ id: "zzz", name: "Z" }], rows: { zzz: [tt(1)], extra: [tt(2)], watchlist: [tt(3)], tonight: [tt(4)] }, films: [film(1), film(2), film(3), film(4)] };
  assert.deepEqual(selectFilms({ index, cache: { films: {} } }).map((f) => f.imdb), [tt(4), tt(3), tt(1), tt(2)]);
});

test("films that need no request are left out: confirmed ones, not-found / ambiguous ones for 30 days, errors of today; stale films and older errors are asked again, but LAST", () => {
  const today = Date.parse("2026-10-13T06:10:00Z");
  const at = (days) => new Date(today - days * DAY).toISOString();
  const cache = { films: {
    [tt(1)]: { status: "confirmed", capturedAt: at(40) },
    [tt(2)]: { status: "confirmed", stale: true, capturedAt: at(40), lastError: { at: at(1), reason: "http-500" } },
    [tt(3)]: { status: "error", capturedAt: at(1), error: { at: at(1), reason: "network-error" } },
    [tt(4)]: { status: "not_found_in_search", capturedAt: at(31) },
    [tt(5)]: { status: "ambiguous", capturedAt: at(29) },
    [tt(6)]: { status: "error", capturedAt: at(0), error: { at: at(0), reason: "network-error" } },
  } };
  const got = selectFilms({ index: baseIndex(), cache, today });
  assert.deepEqual(got.map((f) => f.imdb), [tt(4), tt(7), tt(9), tt(2), tt(3)], "new and expired ones in Board order; the stale film (Tonight) and the error of yesterday (Tonight) after them; 1 confirmed, 5 in cooldown, 6 failed today");
});

test("settled / isRetry: the day of an error is the UTC date, not 24 hours", () => {
  const today = Date.parse("2026-10-14T09:10:00Z");
  assert.equal(settled({ status: "error", capturedAt: "2026-10-14T09:12:00.000Z" }, today), true);
  assert.equal(settled({ status: "error", capturedAt: "2026-10-13T09:12:00.000Z" }, today), false, "23 h 58 min earlier but yesterday's date: asked again (the nightly runs at 09:10 every day)");
  assert.equal(isRetry({ status: "error" }), true);
  assert.equal(isRetry({ status: "confirmed", stale: true }), true);
  assert.equal(isRetry({ status: "not_found_in_search" }), false);
  assert.equal(isRetry(undefined), false);
});

test("the list never holds more than the ceiling of 100 films", () => {
  const got = selectFilms({ index: bigIndex(150), cache: { films: {} } });
  assert.equal(got.length, 100);
  assert.deepEqual(got.slice(0, 10).map((f) => f.imdb), Array.from({ length: 10 }, (_, i) => tt(i + 1)), "Tonight's ten lead");
});

// ── 2. the nightly run ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("a night passes the collector the ceiling of 100, the 2 s interval, the input and an out folder, and never --resume or --refresh; a larger --max-requests is not honoured", () => {
  const fx = fixture(bigIndex(150));
  try {
    const r = fx.night({}, ["--max-requests", "500"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const argv = fx.lines()[0].argv;
    assert.equal(argv[argv.indexOf("--max-requests") + 1], "100");
    assert.equal(argv[argv.indexOf("--interval") + 1], "2.0");
    assert.ok(argv.includes("--input") && argv.includes("--out"));
    assert.ok(!argv.includes("--resume") && !argv.includes("--refresh"), "--resume continues a --refresh that stopped and refuses to run without one");
    const wanted = asked(fx);
    assert.equal(wanted.length, 100, "a hundred requests, no more");
    assert.deepEqual(wanted.slice(0, 3), ["Film 1", "Film 2", "Film 3"], "Tonight first");
    assert.equal(Object.keys(fx.cache().films).length, 100);
    const rep = fx.report();
    assert.equal(rep.requestsMax, 100);
    assert.equal(rep.requestsMade, 100);
  } finally { fx.clean(); }
});

test("the second night asks the films after the ones the first night confirmed, in the same order, and keeps every first-night record untouched", () => {
  const fx = fixture();
  try {
    assert.equal(fx.night({}, ["--max-requests", "3"]).status, 0);
    assert.deepEqual(asked(fx), ["Film 1", "Film 2", "Film 3"]);
    const first = fx.cache().films;
    fs.rmSync(path.join(fx.root, "collector.log"));
    assert.equal(fx.night({}, [], 1).status, 0);
    assert.deepEqual(asked(fx), ["Film 4", "Film 5", "Film 6", "Film 7", "Film 9"]);
    const second = fx.cache().films;
    for (const id of Object.keys(first)) assert.deepEqual(second[id], first[id], id + " is as the first night left it");
    assert.equal(Object.keys(second).length, 8);
  } finally { fx.clean(); }
});

test("the merge never loses a record: a collector whose output lacks the old films still leaves every old film in cache/mubi.json", () => {
  const fx = fixture();
  try {
    assert.equal(fx.night({}, ["--max-requests", "3"]).status, 0);
    const before = fx.cache().films;
    assert.equal(Object.keys(before).length, 3);
    const r = fx.night({ FAKE_MUBI_MODE: "empty-seed" }, [], 1);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const after = fx.cache().films;
    for (const id of Object.keys(before)) assert.deepEqual(after[id], before[id], id + " survived");
    assert.ok(Object.keys(after).length > 3, "and the new films were added");
  } finally { fx.clean(); }
});

test("the report says the date, the requests made, how many were found, how many have no Our Take and why it stopped", () => {
  const fx = fixture();
  try {
    const r = fx.night({ FAKE_MUBI_NO_TAKE: `${tt(2)},${tt(3)}` }, ["--max-requests", "4"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const rep = fx.report();
    assert.deepEqual(MC.reportProblems(rep), []);
    assert.match(rep.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(rep.requestsMade, 4);
    assert.equal(rep.filmsDelivered, 4);
    assert.equal(rep.filmsAsked, 4);
    assert.equal(rep.status, "ok");
    assert.equal(rep.found, 4);
    assert.equal(rep.withoutOurTake, 2);
    assert.equal(rep.stopReason, "finished");
    assert.deepEqual(rep.cache, { records: 4, confirmed: 4, withOurTake: 2 });
    assert.equal(MC.ourTakeOf(fx.cache().films[tt(1)]), "Our take on Film 1.");
    assert.equal(MC.ourTakeOf(fx.cache().films[tt(2)]), "");
  } finally { fx.clean(); }
});

// ── 3. a collector that fails never fails the night ─────────────────────────────────────────────────────────────────────────────────────────

for (const [mode, why] of [["exit1", "leaves with 1 and writes nothing"], ["network", "fails every request (three in a row, exit 4)"], ["garbage", "leaves a mubi.json that is not JSON"]]) {
  test(`the collector ${why}: the step exits 0 and cache/mubi.json is byte for byte what it was`, () => {
    const fx = fixture();
    try {
      assert.equal(fx.night({}, ["--max-requests", "3"]).status, 0);
      const before = fs.readFileSync(fx.cacheFile);
      const r = fx.night({ FAKE_MUBI_MODE: mode }, [], 1);
      assert.equal(r.status, 0, "the step must not fail the night: " + r.stdout + r.stderr);
      const after = fs.readFileSync(fx.cacheFile);
      if (mode === "network") {
        // three failures leave error records for films never confirmed; the three confirmed ones stay exactly as they were
        const a = JSON.parse(after).films;
        for (const [id, rec] of Object.entries(JSON.parse(before).films)) assert.deepEqual(a[id], rec);
        assert.equal(fx.report().stopReason, "consecutive-failures");
        assert.equal(fx.report().collectorExit, 4);
      } else {
        assert.ok(before.equals(after), "cache untouched");
        assert.equal(fx.report().stopReason, mode === "exit1" ? "collector-exit-1" : "collector-no-output");
      }
    } finally { fx.clean(); }
  });
}

test("HTTP 403 on the third request: the collector stops (exit 2), the two films it finished are kept, the old ones stay, the step exits 0 and the report says why", () => {
  const fx = fixture();
  try {
    assert.equal(fx.night({}, ["--max-requests", "3"]).status, 0);
    const old = fx.cache().films;
    const r = fx.night({ FAKE_MUBI_MODE: "403" }, [], 1);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const now = fx.cache().films;
    for (const id of Object.keys(old)) assert.deepEqual(now[id], old[id]);
    assert.equal(now[tt(4)].status, "confirmed");
    assert.equal(now[tt(5)].status, "confirmed");
    assert.equal(now[tt(6)].status, "error", "the film in progress is recorded as an error and is asked again");
    assert.equal(asked(fx).length, 3 + 3, "it stopped at once: nothing more was asked after the 403");
    const rep = fx.report();
    assert.equal(rep.stopReason, "blocked-http-403");
    assert.equal(rep.collectorExit, 2);
    assert.equal(rep.found, 2);
    assert.equal(rep.filmsDelivered, 5, "five films were handed to the collector (4, 5, 6, 7 and 9)");
    assert.equal(rep.filmsAsked, 3, "and it asked about three of them (4 and 5 answered, 6 got the 403) before it stopped");
    assert.equal(rep.requestsMade, 3);
  } finally { fx.clean(); }
});

test("a collector that cannot start (no such file) or a Board that cannot be built also exits 0 and leaves the cache alone", () => {
  const fx = fixture();
  try {
    assert.equal(fx.night({}, ["--max-requests", "3"]).status, 0);
    const before = fs.readFileSync(fx.cacheFile);
    const r = spawnSync(process.execPath, [NIGHTLY, "--root", fx.root, "--index", fx.indexFile, "--collector", path.join(fx.root, "nope.py"), "--now", clockOf(1)], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(before.equals(fs.readFileSync(fx.cacheFile)));
    fs.writeFileSync(fx.indexFile, "{broken");
    const r2 = fx.night({}, [], 2);
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.equal(fx.report().stopReason, "board-index-unreadable");
    assert.ok(before.equals(fs.readFileSync(fx.cacheFile)));
  } finally { fx.clean(); }
});

test("a cache/mubi.json that is not a schema 1 MUBI cache is never overwritten and the step still exits 0", () => {
  const fx = fixture();
  try {
    fs.writeFileSync(fx.cacheFile, '{"hello": 1}');
    const r = fx.night();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(fx.cacheFile, "utf8"), '{"hello": 1}');
    assert.equal(asked(fx).length, 0, "nothing was asked");
    assert.equal(fx.lines().length, 0, "the collector was not even started");
    assert.ok(!fs.existsSync(fx.reportFile), "and no report claims a night that did not happen");
  } finally { fx.clean(); }
});

test("an error nobody foresaw inside the step (an index with a null film) also exits 0, leaves the cache alone and says so as a warning", () => {
  const fx = fixture();
  try {
    assert.equal(fx.night({}, ["--max-requests", "3"]).status, 0);
    const before = fs.readFileSync(fx.cacheFile);
    fs.writeFileSync(fx.indexFile, JSON.stringify({ board: [], rows: { tonight: [tt(1)] }, films: [null] }));
    const r = fx.night({ GITHUB_ACTIONS: "true" }, [], 1);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /::warning title=MUBI nightly::the step failed/);
    assert.ok(before.equals(fs.readFileSync(fx.cacheFile)));
    assert.equal(fx.report().status, "failed", "and the report says so, with the message");
    assert.equal(fx.report().stopReason, "not-run", "the collector never ran, and the report does not say it finished");
    assert.match(fx.report().message, /at select: /);
  } finally { fx.clean(); }
});

test("a confirmed film that was stale and fails again stays confirmed with the new lastError: the collector is given the old cache to protect it", () => {
  const fx = fixture();
  try {
    assert.equal(fx.night().status, 0, "the first night confirms all eight");
    const cache = fx.cache();
    assert.equal(Object.keys(cache.films).length, 8);
    cache.films[tt(1)].stale = true;
    cache.films[tt(1)].lastError = { at: "2026-10-01T00:00:00.000Z", reason: "http-500" };
    fs.writeFileSync(fx.cacheFile, JSON.stringify(cache, null, 1) + "\n");
    fs.rmSync(path.join(fx.root, "collector.log"));
    const r = fx.night({ FAKE_MUBI_MODE: "network" }, [], 1);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(asked(fx), ["Film 1"], "only the stale film is asked");
    const after = fx.cache().films[tt(1)];
    assert.equal(after.status, "confirmed");
    assert.equal(after.stale, true);
    assert.equal(after.lastError.reason, "network-error", "the collector, which saw the old record, wrote the new reason");
    assert.equal(MC.ourTakeOf(after), "Our take on Film 1.");
  } finally { fx.clean(); }
});

// ── "ambiguous": the three ways the real collector makes one ───────────────────────────────────────────────────────────────────────────

test("a film that ends 'ambiguous' (two results that pass; one whose duration is 60 minutes off; the search failing and the slug route unable to check the runtime) is merged and written, on the allowlist", () => {
  // 14/10/2026 review: `candidates: list(shape(...))` called the shape as a function, every 'ambiguous' record made the merge throw, nothing was written, and the next night did the same.
  const fx = fixture();
  try {
    const r = fx.night({ FAKE_MUBI_TWO: tt(4), FAKE_MUBI_DURATION: tt(5), FAKE_MUBI_SLUG: tt(6) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!/was refused|step failed/.test(r.stdout), r.stdout);
    const films = fx.cache().films;
    const two = films[tt(4)], dur = films[tt(5)], slug = films[tt(6)];
    assert.equal(two.status, "ambiguous");
    assert.equal(two.candidates.length, 2);
    assert.ok(two.candidates.every((c) => c.why === "passes-all-checks" && c.mubi.url.startsWith("https://mubi.com/")));
    assert.equal(dur.status, "ambiguous");
    assert.deepEqual(dur.candidates.map((c) => c.why), ["duration-differs-more-than-20-min"]);
    assert.equal(slug.status, "ambiguous");
    assert.equal(slug.request.via, "slug-fallback");
    assert.equal(slug.request.slug, "film-6");
    assert.equal(slug.identity.note, "slug-fallback-runtime-unverifiable");
    assert.deepEqual(slug.candidates.map((c) => c.why), ["slug-fallback-runtime-unverifiable"]);
    for (const rec of [two, dur, slug]) assert.deepEqual(MC.recordProblems(rec), []);
    assert.deepEqual(MC.cacheProblems(fx.cache()), []);
    const rep = fx.report();
    assert.equal(rep.status, "ok");
    assert.equal(rep.ambiguous, 3);
    assert.equal(rep.found, 5, "the other five were confirmed in the same night");
    assert.equal(rep.cache.records, 8);
    // and the records are inside the cooldown the next night: not asked again for 30 days
    fs.rmSync(path.join(fx.root, "collector.log"));
    assert.equal(fx.night({}, [], 1).status, 0);
    assert.deepEqual(asked(fx), [], "nothing left to ask: confirmed, and the three ambiguous ones are in their 30 days");
  } finally { fx.clean(); }
});

test("a record with a candidate that carries a field off the allowlist names the path inside the list", () => {
  const rec = { status: "ambiguous", capturedAt: "2026-10-13T00:00:00.000Z", candidates: [{ mubi: { id: 1, slug: "a", url: "https://mubi.com/films/a" }, found: { title: "t", originalTitle: null, year: 2000, directors: ["x"], duration: 90 }, evidence: ["title"], why: "passes-all-checks", cookie: "planted-value" }] };
  assert.deepEqual(MC.recordProblems(rec), ["record.candidates[0].cookie: field not on the allowlist"]);
  rec.candidates[0] = { ...rec.candidates[0] }; delete rec.candidates[0].cookie;
  assert.deepEqual(MC.recordProblems(rec), []);
  rec.candidates = "x";
  assert.deepEqual(MC.recordProblems(rec), ["record.candidates: invalid value"]);
  rec.candidates = Array.from({ length: 21 }, () => ({}));
  assert.deepEqual(MC.recordProblems(rec), ["record.candidates: invalid value"]);
});

// ── an error of the step itself is reported, not swallowed ─────────────────────────────────────────────────────────────────────────────

test("a merge that throws leaves the cache as it was, the step answers instead of throwing, and cache/mubi-report.json says merge-failed with the message", () => {
  const fx = fixture();
  try {
    assert.equal(fx.night({}, ["--max-requests", "3"]).status, 0);
    const before = fs.readFileSync(fx.cacheFile);
    const warnings = [];
    const rep = run({ root: fx.root, indexFile: fx.indexFile, collector: FAKE, now: () => clockOf(1), merge: () => { throw new TypeError("object is not a function"); }, log: () => {}, warn: (m) => warnings.push(m) });
    assert.equal(rep.status, "merge-failed");
    assert.equal(rep.stopReason, "finished", "the collector's reason is kept: it finished; the merge is what failed (status)");
    assert.match(rep.message, /^TypeError at merge: object is not a function$/);
    assert.deepEqual(fx.report(), rep);
    assert.deepEqual(MC.reportProblems(rep), []);
    assert.ok(before.equals(fs.readFileSync(fx.cacheFile)));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /failed at merge/);
  } finally { fx.clean(); }
});

// ── 100 requests a DAY ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("the step asks at most once a day: a second run on the same UTC date does nothing, whatever the first one came to; the next date runs", () => {
  const fx = fixture();
  try {
    const first = fx.night({ FAKE_MUBI_MODE: "exit1" }, ["--max-requests", "3"]);
    assert.equal(first.status, 0);
    assert.equal(fx.report().stopReason, "collector-exit-1", "the first run failed and still wrote today's report");
    const reportBytes = fs.readFileSync(fx.reportFile);
    const started = fx.lines().length;
    const again = fx.night({}, [], 0);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /already ran today/);
    assert.equal(fx.lines().length, started, "the collector was not started again");
    assert.ok(reportBytes.equals(fs.readFileSync(fx.reportFile)), "and the report is the first run's");
    assert.ok(!fs.existsSync(fx.cacheFile));
    const later = new Date(T0 + 1000).toISOString(); // the same date, a second later: still today
    assert.match(spawnSync(process.execPath, [NIGHTLY, "--root", fx.root, "--index", fx.indexFile, "--collector", FAKE, "--now", later], { encoding: "utf8" }).stdout, /already ran today/);
    assert.equal(fx.night({}, [], 1).status, 0);
    assert.ok(fx.lines().length > started, "tomorrow it asks");
    assert.equal(Object.keys(fx.cache().films).length, 8);
  } finally { fx.clean(); }
});

test("a report of another date does not block, and a file that is not a report does not block either", () => {
  const fx = fixture();
  try {
    fs.writeFileSync(fx.reportFile, JSON.stringify({ date: "2000-01-01" }));
    assert.equal(fx.night({}, ["--max-requests", "1"]).status, 0);
    assert.equal(asked(fx).length, 1);
    fs.writeFileSync(fx.reportFile, "{broken");
    assert.equal(fx.night({}, ["--max-requests", "1"], 1).status, 0);
    assert.equal(asked(fx).length, 2);
  } finally { fx.clean(); }
});

// ── errors go last ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("three films that failed on the first night do not keep the new films from being asked on the second: the errors are asked last", () => {
  // 14/10/2026 review: errors stayed at the front of the queue and three failures in a row stop the collector, so with three films that always failed no new film was ever reached.
  const fx = fixture();
  try {
    const fail = { FAKE_MUBI_FAIL: `${tt(1)},${tt(2)},${tt(3)}` };
    assert.equal(fx.night(fail).status, 0);
    assert.deepEqual(asked(fx), ["Film 1", "Film 2", "Film 3"]);
    assert.deepEqual(Object.values(fx.cache().films).map((x) => x.status), ["error", "error", "error"]);
    assert.equal(fx.report().stopReason, "consecutive-failures");
    fs.rmSync(path.join(fx.root, "collector.log"));
    assert.equal(fx.night(fail, [], 1).status, 0);
    assert.deepEqual(asked(fx), ["Film 4", "Film 5", "Film 6", "Film 7", "Film 9", "Film 1", "Film 2", "Film 3"], "new films first, the three errors last");
    const films = fx.cache().films;
    for (const n of [4, 5, 6, 7, 9]) assert.equal(films[tt(n)].status, "confirmed", `Film ${n} was reached`);
    for (const n of [1, 2, 3]) assert.equal(films[tt(n)].status, "error");
    assert.equal(fx.report().found, 5);
    assert.equal(fx.report().stopReason, "consecutive-failures", "the errors stopped the collector at the END, after the new films");
  } finally { fx.clean(); }
});

test("films to retry are asked in the order of their last attempt, the oldest first, not in the Board's order", () => {
  // 14/10/2026 re-review: in Board order, three films that fail for good (search-5xx-slug-404, slug-fallback-mismatch, detail-id-mismatch) at the top were asked first every day, stopped the collector
  // at the third failure, and the failed films after them were never reached.
  const today = Date.parse("2026-10-16T09:10:00Z");
  const at = (days) => new Date(today - days * DAY).toISOString();
  const index = { board: [{ id: "tonight", name: "Tonight" }], rows: { tonight: [tt(1), tt(2), tt(9), tt(3), tt(4)] }, films: [film(1), film(2), film(3), film(4), film(9, { director: "Ann One" })] };
  const failed = (days) => ({ status: "error", capturedAt: at(days), error: { at: at(days), reason: "search-5xx-slug-404" } });
  const cache = { films: { [tt(1)]: failed(1), [tt(2)]: failed(1), [tt(3)]: failed(1), [tt(4)]: failed(3) } };
  assert.deepEqual(selectFilms({ index, cache, today }).map((f) => f.imdb), [tt(9), tt(4), tt(1), tt(2), tt(3)], "the new film first; then Film 4 (tried three days ago) before 1, 2 and 3 (tried yesterday), which keep the Board's order among themselves");
  cache.films[tt(2)] = { status: "confirmed", stale: true, capturedAt: at(40), lastError: { at: at(5), reason: "http-500" } };
  assert.deepEqual(selectFilms({ index, cache, today }).map((f) => f.imdb), [tt(9), tt(2), tt(4), tt(1), tt(3)], "a stale film counts from its last failed refresh");
  assert.equal(attemptAt({ status: "error" }), 0, "a record with no usable time is the oldest");
});

test("films that keep failing rotate to the back: after a night that stops on the same three, the film that failed once is asked first", () => {
  const index = { board: [{ id: "tonight", name: "Tonight" }], rows: { tonight: [tt(1), tt(2), tt(9), tt(3), tt(4)] }, films: [film(1), film(2), film(3), film(4), film(9, { director: "Ann One" })] };
  const fx = fixture(index);
  try {
    // night 1: 1, 2, 3 and 4 fail (a film that answers in between, 9, breaks the streak of three), in that order
    assert.equal(fx.night({ FAKE_MUBI_FAIL: `${tt(1)},${tt(2)},${tt(3)},${tt(4)}` }).status, 0);
    assert.deepEqual(asked(fx), ["Film 1", "Film 2", "Film 9", "Film 3", "Film 4"]);
    // night 2: 4 recovers, 1-3 do not; oldest attempt first is 1, 2, 3, 4 (equal times keep the order), so the three failures stop the collector before 4
    fs.rmSync(path.join(fx.root, "collector.log"));
    assert.equal(fx.night({ FAKE_MUBI_FAIL: `${tt(1)},${tt(2)},${tt(3)}` }, [], 1).status, 0);
    assert.deepEqual(asked(fx), ["Film 1", "Film 2", "Film 3"]);
    assert.equal(fx.cache().films[tt(4)].status, "error", "not reached tonight");
    // night 3: 1, 2 and 3 were tried last night, 4 on night 1: 4 goes first and is confirmed; in Board order 1, 2, 3 would stop the collector again and 4 would never be asked
    fs.rmSync(path.join(fx.root, "collector.log"));
    assert.equal(fx.night({ FAKE_MUBI_FAIL: `${tt(1)},${tt(2)},${tt(3)}` }, [], 2).status, 0);
    assert.deepEqual(asked(fx), ["Film 4", "Film 1", "Film 2", "Film 3"]);
    assert.equal(fx.cache().films[tt(4)].status, "confirmed");
  } finally { fx.clean(); }
});

test("errors of today are not asked again the same day; tomorrow they are, after the new films", () => {
  const fx = fixture();
  try {
    assert.equal(fx.night({ FAKE_MUBI_FAIL: `${tt(1)},${tt(2)},${tt(3)}` }, ["--max-requests", "3"]).status, 0);
    const got = selectFilms({ index: baseIndex(), cache: fx.cache(), today: T0 });
    assert.deepEqual(got.map((f) => f.imdb), [tt(4), tt(5), tt(6), tt(7), tt(9)], "the three errors are settled for today");
    const tomorrow = selectFilms({ index: baseIndex(), cache: fx.cache(), today: T0 + DAY });
    assert.deepEqual(tomorrow.map((f) => f.imdb).slice(-3), [tt(1), tt(2), tt(3)]);
  } finally { fx.clean(); }
});

// ── a text that looks like a credential never reaches the cache ──────────────────────────────────────────────────────────────────────────

test("a text with the shape of a credential makes the record invalid, the bare word does not; the merge keeps the old record and the nightly says so", () => {
  const at = "2026-10-13T09:00:00.000Z";
  const confirmed = (take) => ({ status: "confirmed", capturedAt: at, ourTake: { state: "available", text: take } });
  assert.deepEqual(MC.recordProblems(confirmed("A token gesture; he is the bearer of bad news.")), []);
  for (const bad of ["Authorization: Bearer abc", "api_key=abc", "see Cookie : a=b", "API-KEY: x"]) assert.deepEqual(MC.recordProblems(confirmed(bad)), ["record.ourTake.text: invalid value"], bad);
  const old = { schema: 1, source: "s", updatedAt: at, films: { [tt(2)]: confirmed("The old take.") } };
  const m = MC.mergeCaches(old, { ...old, updatedAt: "2026-10-14T09:00:00.000Z", films: { [tt(2)]: confirmed("Authorization: Bearer abc"), [tt(3)]: confirmed("A fine take.") } });
  assert.equal(m.cache.films[tt(2)].ourTake.text, "The old take.");
  assert.deepEqual(m.rejected.map((x) => x.id), [tt(2)]);
  assert.deepEqual(m.added, [tt(3)]);
  const fx = fixture();
  try {
    const r = fx.night({ FAKE_MUBI_CRED: tt(2) }, ["--max-requests", "4"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`a record of ${tt(2)} was refused`));
    const raw = fs.readFileSync(fx.cacheFile, "utf8");
    assert.ok(!raw.includes("api_key"), "the text is not in the file");
    assert.deepEqual(Object.keys(fx.cache().films), [tt(1), tt(3), tt(4)], "Film 2 is missing (it will be asked again tomorrow); the others were merged");
    assert.deepEqual(MC.cacheProblems(fx.cache()), []);
    assert.equal(fx.report().found, 3);
  } finally { fx.clean(); }
});

test("a bad command line is the only exit that is not 0", () => {
  const r = spawnSync(process.execPath, [NIGHTLY, "--nonsense"], { encoding: "utf8" });
  assert.equal(r.status, 2);
});

// ── 4. no index in docs/: the Board comes from an offline build of the caches ──────────────────────────────────────────────────────────

test("without docs/data/index-board.json the Board is built offline from the caches (--offline --cache-only, MUBI_CACHE removed from the environment) and a failing build exits 0", () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, "cache"));
    const idx = JSON.stringify(baseIndex());
    // a stand-in build.js: records how it was called, then writes the index the way the real one does
    fs.writeFileSync(path.join(root, "build.js"), `const fs=require("fs"),path=require("path");const a=process.argv.slice(2);fs.writeFileSync(path.join(__dirname,"build.args"),JSON.stringify({a,mubi:process.env.MUBI_CACHE||null}));if(process.env.FAIL_BUILD){console.error("boom");process.exit(1)}const o=a[a.indexOf("--out")+1];fs.mkdirSync(path.join(o,"data"),{recursive:true});fs.writeFileSync(path.join(o,"data","index-board.json"),${JSON.stringify(idx)});`);
    const log = path.join(root, "collector.log");
    const env = { ...process.env, FAKE_MUBI_LOG: log, MUBI_CACHE: "/should/not/be/seen.json" };
    const r = spawnSync(process.execPath, [NIGHTLY, "--root", root, "--collector", FAKE, "--max-requests", "2", "--now", clockOf(0)], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const call = JSON.parse(fs.readFileSync(path.join(root, "build.args"), "utf8"));
    for (const flag of ["--offline", "--cache-only", "--skip-posters", "--out"]) assert.ok(call.a.includes(flag), flag);
    assert.equal(call.mubi, null);
    assert.ok(!path.resolve(call.a[call.a.indexOf("--out") + 1]).startsWith(root), "the build writes outside the repository");
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(root, "cache", "mubi.json"), "utf8")).films).length, 2);
    // the build fails: the step exits 0, no cache is made
    fs.rmSync(path.join(root, "cache", "mubi.json"));
    const r2 = spawnSync(process.execPath, [NIGHTLY, "--root", root, "--collector", FAKE, "--now", clockOf(1)], { encoding: "utf8", env: { ...env, FAIL_BUILD: "1" } });
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.ok(!fs.existsSync(path.join(root, "cache", "mubi.json")));
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "cache", "mubi-report.json"), "utf8")).stopReason, "board-build-failed");
  } finally { rm(root); }
});

test("run() with a docs index uses it and builds nothing", () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, "cache")); fs.mkdirSync(path.join(root, "docs", "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "data", "index-board.json"), JSON.stringify(baseIndex()));
    const rep = run({ root, collector: FAKE, maxRequests: 1, log: () => {}, warn: () => {} });
    assert.equal(rep.filmsAsked, 1);
    assert.ok(!fs.existsSync(path.join(root, "build.js")));
  } finally { rm(root); }
});

// ── 5. privacy: what cache/mubi.json may hold ───────────────────────────────────────────────────────────────────────────────────────────

test("a record from the real collector is on the allowlist, and the fields the collector read but must not keep (press quote, critic rating, star rating) are not in the file", () => {
  const fx = fixture();
  try {
    assert.equal(fx.night({}, ["--max-requests", "2"]).status, 0);
    const cache = fx.cache();
    assert.deepEqual(MC.cacheProblems(cache), []);
    const raw = fs.readFileSync(fx.cacheFile, "utf8");
    for (const word of ["press_quote", "critic_review_rating", "star_rating", "default_editorial_html", "cookie", "token", "userRating"]) assert.ok(!raw.includes(word), word);
    assert.match(raw, /"average": 4\.0\b/, "the collector's own bytes are kept (Python writes 4.0; a rewrite by this script would write 4 and make the whole file a diff)");
    assert.deepEqual(Object.keys(cache).sort(), ["films", "schema", "source", "updatedAt"]);
    assert.deepEqual(Object.keys(cache.films[tt(1)]).sort(), ["capturedAt", "identity", "locale", "mubi", "ourTake", "rating", "request", "status", "synopsis"]);
    // and the build reads it: the same reader the workflow's build step uses (build.js --mubi-cache / MUBI_CACHE) takes the Our Take of both films
    const SS = require("../lib/synopsis-source");
    try { assert.deepEqual(SS.useMubi(fx.cacheFile), { available: true, takes: 2, records: 2, updatedAt: cache.updatedAt }); assert.equal(SS.ourTake(tt(1)), "Our take on Film 1."); } finally { SS.clear(); }
  } finally { fx.clean(); }
});

test("a field outside the allowlist, at any depth, makes a record invalid; the path is named and the value is not", () => {
  const fx = fixture();
  try {
    fx.night({}, ["--max-requests", "1"]);
    const good = fx.cache().films[tt(1)];
    assert.deepEqual(MC.recordProblems(good), []);
    const bad = (mutate) => { const r = JSON.parse(JSON.stringify(good)); mutate(r); return MC.recordProblems(r); };
    assert.deepEqual(bad((r) => { r.userRating = 4.5; }), ["record.userRating: field not on the allowlist"]);
    assert.deepEqual(bad((r) => { r.request.cookie = "planted-value"; }), ["record.request.cookie: field not on the allowlist"]);
    assert.deepEqual(bad((r) => { r.identity.asked.token = 7; }), ["record.identity.asked.token: field not on the allowlist"]);
    assert.deepEqual(bad((r) => { r.ourTake.html = "<p>x</p>"; }), ["record.ourTake.html: field not on the allowlist"]);
    assert.deepEqual(bad((r) => { r.mubi.url = "https://mubi.com/films/x?q=1"; }), ["record.mubi.url: invalid value"]);
    assert.deepEqual(bad((r) => { r.mubi.url = "https://example.com/x"; }), ["record.mubi.url: invalid value"]);
    assert.deepEqual(bad((r) => { r.ourTake.text = "x".repeat(4001); }), ["record.ourTake.text: invalid value"]);
    assert.ok(!JSON.stringify(bad((r) => { r.request.cookie = "planted-value"; })).includes("planted-value"), "no value in the message");
    const withOffId = { schema: 1, source: "s", updatedAt: "2026-10-13T00:00:00.000Z", films: { notanid: good } };
    assert.match(MC.cacheProblems(withOffId)[0], /not an IMDb id/);
    assert.ok(MC.cacheProblems({ ...fx.cache(), extra: 1 }).some((p) => p.includes("cache.extra")));
  } finally { fx.clean(); }
});

test("a new record with a field off the allowlist is refused: the old record stays, the rest of the night is merged, and the field never reaches the file", () => {
  const fx = fixture();
  try {
    const r = fx.night({ FAKE_MUBI_MODE: "extra" }, ["--max-requests", "3"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const raw = fs.readFileSync(fx.cacheFile, "utf8");
    assert.ok(!raw.includes("userRating") && !raw.includes("session="), "the refused field is not in the file");
    assert.deepEqual(MC.cacheProblems(fx.cache()), []);
    assert.equal(Object.keys(fx.cache().films).length, 2, "the record that carried the field was refused; the other two were merged");
    assert.match(r.stdout, /was refused/);
  } finally { fx.clean(); }
});

test("mergeCaches: every old record stays, a confirmed film is never traded for an error or an ambiguity, a refused record changes nothing, a new one is added", () => {
  const at = "2026-10-13T09:00:00.000Z";
  const rec = (status, extra = {}) => ({ status, capturedAt: at, ...extra });
  const old = { schema: 1, source: "api.mubi.com/v3", updatedAt: "2026-10-12T09:00:00.000Z", films: { [tt(1)]: rec("confirmed"), [tt(2)]: rec("confirmed"), [tt(3)]: rec("error", { error: { at, reason: "http-500" } }), [tt(9)]: rec("not_found_in_search", { searched: { results: 0 } }) } };
  const fresh = { schema: 1, source: "api.mubi.com/v3", updatedAt: at, films: {
    [tt(2)]: rec("error", { error: { at, reason: "network-error" } }),   // would downgrade a confirmed film
    [tt(3)]: rec("confirmed"),                                             // the error is now a confirmed film
    [tt(4)]: rec("confirmed", { secretNote: "x" }),                        // off the allowlist
    [tt(5)]: rec("confirmed"),                                             // new
  } };
  const m = MC.mergeCaches(old, fresh);
  assert.deepEqual(Object.keys(m.cache.films).sort(), [tt(1), tt(2), tt(3), tt(5), tt(9)]);
  assert.equal(m.cache.films[tt(2)].status, "confirmed");
  assert.deepEqual(m.kept, [tt(2)]);
  assert.equal(m.cache.films[tt(3)].status, "confirmed");
  assert.deepEqual(m.replaced, [tt(3)]);
  assert.deepEqual(m.added, [tt(5)]);
  assert.deepEqual(m.rejected.map((x) => x.id), [tt(4)]);
  assert.equal(m.cache.updatedAt, at);
  assert.equal(old.films[tt(2)].status, "confirmed", "the old object is not changed");
  const same = MC.mergeCaches(old, { ...old, updatedAt: at });
  assert.equal(same.cache.updatedAt, old.updatedAt, "a run that changed nothing does not move updatedAt");
});

test("the report file is on its own allowlist", () => {
  assert.deepEqual(MC.reportProblems({ schema: 1, date: "2026-10-13", generatedAt: "2026-10-13T09:10:00.000Z", requestsMade: 3, requestsMax: 100, filmsAsked: 3, found: 3, withoutOurTake: 0, notFound: 0, ambiguous: 0, errors: 0, stopReason: "finished", collectorExit: 0, cache: { records: 3, confirmed: 3, withOurTake: 3 } }), []);
  assert.deepEqual(MC.reportProblems({ schema: 1, apiKey: 7 }).filter((p) => p.includes("apiKey")), ["report.apiKey: field not on the allowlist"]);
});

test("if cache/mubi.json is committed, every record in it is on the allowlist", () => {
  const file = path.join(ROOT, "cache", "mubi.json");
  if (!fs.existsSync(file)) return;
  assert.deepEqual(MC.cacheProblems(JSON.parse(fs.readFileSync(file, "utf8"))), []);
  const rep = path.join(ROOT, "cache", "mubi-report.json");
  if (fs.existsSync(rep)) assert.deepEqual(MC.reportProblems(JSON.parse(fs.readFileSync(rep, "utf8"))), []);
});

// ── 6. the workflow ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "mood-engine.yml"), "utf8");
const steps = workflow.split(/\n      - /).slice(1).map((s) => "- " + s);
const stepNamed = (re) => steps.findIndex((s) => re.test(s.split("\n")[0] + "\n" + (s.match(/name: .*/) || [""])[0]));

test("the workflow collects MUBI before the build, only on the schedule, with a 10 minute limit, no secret, and does not stop the night if it fails", () => {
  const mubi = stepNamed(/Collect MUBI \(≤100 requests\)/), build = stepNamed(/Build rows from Letterboxd/);
  assert.ok(mubi > 0 && build > mubi, "the collection step comes before the build step");
  const body = steps[mubi];
  assert.match(body, /timeout-minutes: 10\b/);
  assert.match(body, /if: github\.event_name == 'schedule'/, "100 requests a DAY: a commit to main (up to 18 in one day, 13/10) or a manual run does not collect. Since 21/10/2026 the scheduled collection runs in scripts/noturna-mac.sh --agendada (this step is dormant: the schedule is commented out)");
  assert.match(body, /run: node scripts\/mubi-nightly\.js\s*$/m);
  assert.match(body, /continue-on-error: true/);
  assert.ok(!/secrets\.|TOKEN|KEY|env:/.test(body), "api.mubi.com is public: the step has no secret and no environment");
});

test("the time limits add up inside the step's: the collector's kill plus the prep build's kill leave room in the 10 minutes", () => {
  const { COLLECTOR_TIMEOUT_MS, PREP_TIMEOUT_MS } = require("../scripts/mubi-nightly");
  assert.equal(COLLECTOR_TIMEOUT_MS, 6 * 60000);
  assert.equal(PREP_TIMEOUT_MS, 2 * 60000);
  assert.ok(COLLECTOR_TIMEOUT_MS + PREP_TIMEOUT_MS <= 8 * 60000, "and two minutes are left for the merge and the report");
  assert.ok(100 * 2000 + 100 * 500 < COLLECTOR_TIMEOUT_MS, "100 requests at the 2 s interval plus half a second of answer each fit the collector's limit (about 4 minutes)");
});

test("the commits of the caches add cache/mubi.json and cache/mubi-report.json", () => {
  // Not tied to one step or to if: always(): the workflow may be split into jobs; what must hold is that both files are in the loop that commits the caches.
  assert.match(workflow, /git add cache\/mubi\.json( \|\| true)?\n/);
  assert.match(workflow, /git add cache\/mubi-report\.json( \|\| true)?\n/);
});

test("what the docs say goes on the wire is what the collector sends: the real headers, the repository in the User-Agent, per_page=10, and no cookie, e-mail or token", () => {
  const py = fs.readFileSync(path.join(ROOT, "scripts", "collect-mubi.py"), "utf8");
  for (const piece of ['"Client": "web"', '"Client-Country": "US"', '"Accept-Language": "en"', "per_page", "https://github.com/marcogusmao/mood-engine"]) assert.ok(py.includes(piece), piece);
  assert.ok(!/cookie|authorization/i.test(py.replace(/#.*$/gm, "").replace(/"""[\s\S]*?"""/g, "")), "the collector never sets a cookie or a login header");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  for (const piece of ["Client-Country: US", "per_page=10", "User-Agent", "no cookie, e-mail or token"]) assert.ok(readme.includes(piece), "README: " + piece);
  for (const text of [readme, workflow, fs.readFileSync(NIGHTLY, "utf8")]) assert.ok(!/only the film'?s? title (is|goes|sent)|sends only the film title/i.test(text), "the old 'only the title' claim is gone");
});

test("the build step gives the build no MUBI path (it reads cache/mubi.json by default), and the commented-out push trigger (21/10/2026) still lists cache/mubi.json for when it comes back", () => {
  const body = steps[stepNamed(/Build rows from Letterboxd/)];
  assert.ok(!/MUBI_CACHE|--mubi-cache/.test(body), "the default file is the one the nightly writes");
  assert.match(body, /node build\.js --out \.context\/marco-site\s*\n/, "disabled intake still uses the default root MUBI cache");
  assert.match(body, /node scripts\/build-people\.js --hosted\s*\n/, "enabled intake builds the aggregate through the hosted coordinator");
  assert.match(workflow, /^\s*#\s*paths: \[[^\]]*"cache\/mubi\.json"/m, "on.push.paths lists it, as a comment since 21/10/2026 (BACKLOG, 13/10/2026, describe-v2 (9)(a))");
});

test("the cache-saving job keeps the run's commit as base (no `ref:` on its checkout), commits only when the caches changed, and retries a rejected write once with a rebase and a JSON check (14/10/2026, run 38580879224)", () => {
  const job = workflow.slice(workflow.indexOf("\n  commit-cache:"), workflow.indexOf("\n  deploy:"));
  assert.ok(job.length > 0, "the commit-cache job exists");
  const checkout = job.split(/\n      - /).find((s) => /^(id: \w+\n\s*)?uses: actions\/checkout@/.test(s));
  assert.ok(checkout, "the job checks the repository out");
  assert.ok(!/\n\s*ref:/.test(checkout), "no `ref:` on that checkout: the tip of main would make the copy a fast-forward overwrite of a cache commit that reached main during the build");
  const save = job.split(/\n      - /).find((s) => /name: Save TMDB/.test(s));
  assert.ok(save, "the saving step exists");
  const gate = save.indexOf("if git diff --cached --quiet; then"), commit = save.indexOf("git commit -m");
  assert.ok(gate >= 0 && commit > gate, "the step leaves before committing when nothing changed (no push, no 'second try' claim)");
  assert.match(save, /\$\{\{ github\.ref_name \}\}/, "BRANCH comes from the run's branch");
  assert.match(save, /git fetch origin "\$BRANCH"[\s\S]*?git rebase "origin\/\$BRANCH"/, "a rejected write fetches the new tip and rebases the cache commit on it");
  assert.match(save, /python3 -I -c 'import json,sys; json\.load\(/, "after the rebase every cache JSON must still parse, with python in isolated mode");
  assert.match(save, /command -v python3/, "a runner without python3 is named as the reason, not reported as invalid JSON");
  for (const msg of ["could not fetch", "conflicts with what reached", "no longer valid JSON", "moved a second time", "Cache pushed on the second try"]) assert.ok(save.includes(msg), "message: " + msg);
  assert.match(save, /git rebase --abort/, "a conflicting rebase is aborted");
  assert.ok(!/\|\| echo "Cache push skipped"/.test(save), "the old single-try form is gone");
});
