// node --test
// 20/10/2026 (Stremio BACKLOG item 13): 47 covers failed the download every night and the build's summary never said which HTTP answer was behind "FAILED: n download".
// Since #49 lib/posters.js records each cover that no source has (`failures` in cache/posters.json: code, tries, last, next, url, alt); the build now lists them by code with the
// ids (lib/posters.js failureReport / reportFailures, called from build.js) and a night that went to the network appends the same table to GITHUB_STEP_SUMMARY.
// Every file read here is planted; nothing reads the repository's live cache/posters.json for a number.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const P = require("../lib/posters");

const ROOT = path.join(__dirname, "..");
const tmp = (p = "mood-cover-failures-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const TODAY = "2026-10-20";
const rec = (code, extra = {}) => ({ kind: "permanent", tries: 1, code, last: "2026-10-19", next: "2026-10-26", url: "https://images.metahub.space/poster/medium/x/img", ...extra });

/** The shape of the 19/10/2026 state (47 x "404", all tried once on the 19th), scaled down and with the other codes the library can write. */
const PLANTED = {
  tt0000030: rec("404"), tt0000010: rec("404", { tries: 3 }), tt0000020: rec("404", { last: TODAY }),
  tt0000040: rec("410"), tt0000041: rec("410", { alt: { d: "2026-10-19", found: true, kind: "tmdb", ok: true } }),
  tt0000050: rec("not-image", { tries: 2, alt: { d: "2026-10-19", found: false } }),
  tt0000060: rec("404+410", { alt: { d: "2026-10-19", found: true, kind: "tmdb", ok: false, code: "404" } }),
  tt0000070: { kind: "permanent", tries: 1, last: "2026-10-19" }, // a record with no code
};

test("failureReport: counts by code, biggest group first, ids in order, tonight against waiting, and the other-source tally", () => {
  const r = P.failureReport(PLANTED, TODAY);
  assert.equal(r.total, 8);
  assert.deepEqual(r.byCode.map((g) => [g.code, g.count]), [["404", 3], ["410", 2], ["404+410", 1], ["not-image", 1], ["unknown", 1]], "by size, then by name (so 410 x2 comes before 404+410 x1, against the alphabet)");
  assert.deepEqual(r.byCode[0].ids, ["tt0000010", "tt0000020", "tt0000030"], "ids sorted, not in file order");
  assert.equal(r.byCode[0].maxTries, 3);
  assert.equal(r.byCode[0].tonight, 1, "tt0000020 was asked tonight");
  assert.equal(r.tonight, 1);
  assert.equal(r.waiting, 7);
  assert.equal(r.altFound, 2, "alt.found true");
  assert.equal(r.altNone, 1, "alt.found false");
});

test("failureReport: nothing, a list, null and junk entries are an empty report, not an error", () => {
  for (const f of [undefined, null, {}, [], "x", 5]) assert.deepEqual(P.failureReport(f, TODAY), { total: 0, tonight: 0, waiting: 0, altFound: 0, altNone: 0, byCode: [] });
  const r = P.failureReport({ tt1: null, tt2: "x", tt3: 4 }, TODAY);
  assert.deepEqual(r.byCode.map((g) => [g.code, g.count]), [["unknown", 3]]);
});

test("failureLines: a summary line with the count per code and a line per code with its ids", () => {
  const lines = P.failureLines(P.failureReport(PLANTED, TODAY));
  assert.equal(lines.length, 1 + 5);
  assert.match(lines[0], /Cover failures on record: 8 \(404 ×3, 410 ×2, 404\+410 ×1, not-image ×1, unknown ×1\)/);
  assert.match(lines[0], /1 asked tonight, 7 waiting for their next try/);
  assert.match(lines[0], /other source: 2 found, 1 looked for and not found/);
  assert.match(lines[1], /404 ×3 \(1 asked tonight, most tries 3\): tt0000010 tt0000020 tt0000030$/);
  assert.match(lines[5], /unknown ×1 .*: tt0000070$/);
  assert.deepEqual(P.failureLines(P.failureReport({}, TODAY)), ["     Cover failures on record: none"]);
});

test("failureMarkdown: a table with one row per code and the ids in code spans; nothing when nothing failed; a long list is cut with a count", () => {
  const md = P.failureMarkdown(P.failureReport(PLANTED, TODAY));
  assert.match(md, /^### Covers that fail for good\n/);
  assert.match(md, /\| 404 \| 3 \| 1 \| 3 \| `tt0000010` `tt0000020` `tt0000030` \|/);
  assert.match(md, /\| 410 \| 2 \| 0 \| 1 \| `tt0000040` `tt0000041` \|/);
  assert.equal(md.split("\n").filter((l) => /^\| /.test(l)).length, 1 + 5, "header row plus five codes");
  assert.equal(P.failureMarkdown(P.failureReport({}, TODAY)), "");
  const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`tt${String(i).padStart(7, "0")}`, rec("404")]));
  const cut = P.failureMarkdown(P.failureReport(many, TODAY));
  assert.equal((cut.match(/`tt\d+`/g) || []).length, P.MAX_IDS_IN_SUMMARY);
  assert.match(cut, /… \+50 more/);
  assert.match(P.failureMarkdown(P.failureReport({ tt1: rec("a|b") }, TODAY)), /\| a\/b \|/, "a pipe in a code cannot break the table");
});

test("reportFailures: logs the lines; appends to GITHUB_STEP_SUMMARY only on a night that went to the network, never overwrites, and never throws", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "summary.md");
    fs.writeFileSync(file, "earlier step\n");
    const logged = [];
    const r = P.reportFailures({ failures: PLANTED, today: TODAY, log: (l) => logged.push(l), env: { GITHUB_STEP_SUMMARY: file }, cacheOnly: false });
    assert.equal(r.total, 8);
    assert.equal(logged.length, 6);
    const text = fs.readFileSync(file, "utf8");
    assert.ok(text.startsWith("earlier step\n### Covers that fail for good"), "appended after what was there");
    P.reportFailures({ failures: PLANTED, today: TODAY, log: () => {}, env: { GITHUB_STEP_SUMMARY: file } });
    assert.equal((fs.readFileSync(file, "utf8").match(/### Covers that fail for good/g) || []).length, 2, "a second call appends again");
    // not written: --cache-only (the tests' builds, where a runner still has the variable), no variable, nothing failed
    const quiet = path.join(dir, "quiet.md");
    P.reportFailures({ failures: PLANTED, today: TODAY, log: () => {}, env: { GITHUB_STEP_SUMMARY: quiet }, cacheOnly: true });
    P.reportFailures({ failures: PLANTED, today: TODAY, log: () => {}, env: {}, cacheOnly: false });
    P.reportFailures({ failures: {}, today: TODAY, log: () => {}, env: { GITHUB_STEP_SUMMARY: quiet }, cacheOnly: false });
    assert.ok(!fs.existsSync(quiet));
    // an unwritable file and a log that throws are reported, not raised
    const msgs = [];
    assert.doesNotThrow(() => P.reportFailures({ failures: PLANTED, today: TODAY, log: (l) => msgs.push(l), env: { GITHUB_STEP_SUMMARY: path.join(dir, "no", "such", "dir", "s.md") }, cacheOnly: false }));
    assert.ok(msgs.some((m) => /not written to the run summary/.test(m)));
    assert.doesNotThrow(() => P.reportFailures({ failures: PLANTED, today: TODAY, log: () => { throw new Error("log broke"); }, env: {}, cacheOnly: false }));
  } finally { rm(dir); }
});

test("reportFailures with no env argument reads the process environment (build.js passes none: its test harness runs coverStep in a context with no `process`)", () => {
  const dir = tmp();
  const was = process.env.GITHUB_STEP_SUMMARY;
  try {
    const file = path.join(dir, "summary.md");
    process.env.GITHUB_STEP_SUMMARY = file;
    P.reportFailures({ failures: PLANTED, today: TODAY, log: () => {}, cacheOnly: false });
    assert.match(fs.readFileSync(file, "utf8"), /### Covers that fail for good/);
  } finally {
    if (was === undefined) delete process.env.GITHUB_STEP_SUMMARY; else process.env.GITHUB_STEP_SUMMARY = was;
    rm(dir);
  }
});

test("drawCovers hands the failure records back: the committed state's in --cache-only, and after the night's forgetting of unasked films otherwise", async () => {
  const dir = tmp();
  try {
    const d = { raw: path.join(dir, "raw"), out: path.join(dir, "out"), state: path.join(dir, "posters.json") };
    fs.writeFileSync(d.state, JSON.stringify({ version: 1, items: {}, failures: { tt1: rec("404"), tt2: rec("410", { last: "2026-09-01", next: "2026-09-08" }) } }));
    const co = await P.drawCovers({ targets: new Map(), dir: d, today: TODAY, cacheOnly: true, fetchImpl: async () => { throw new Error("no network"); } });
    assert.deepEqual(Object.keys(co.failures).sort(), ["tt1", "tt2"], "--cache-only forgets nothing");
    const live = await P.drawCovers({ targets: new Map(), dir: d, today: TODAY, cacheOnly: false, fetchImpl: async () => { throw new Error("no network"); } });
    assert.deepEqual(Object.keys(live.failures), ["tt1"], "tt2 was last asked 49 days ago and nobody asks for it: forgotten (KEEP_DAYS), so not reported either");
  } finally { rm(dir); }
});

// The real build, offline, on COPIES of the committed caches with the planted state laid over cache/posters.json.
test("build.js prints the failures by code with their ids, and a --cache-only build leaves GITHUB_STEP_SUMMARY alone even when the runner sets it", () => {
  const dir = tmp();
  try {
    const cache = path.join(dir, "cache");
    fs.mkdirSync(cache);
    for (const n of fs.readdirSync(path.join(ROOT, "cache"))) if (n.endsWith(".json") && n !== "front-memory.json" && n !== "tonight-memory.json" && n !== "posters.json") fs.copyFileSync(path.join(ROOT, "cache", n), path.join(cache, n));
    fs.writeFileSync(path.join(cache, "posters.json"), JSON.stringify({ version: 1, items: {}, failures: PLANTED }));
    const summary = path.join(dir, "summary.md");
    const r = spawnSync(process.execPath, [path.join(ROOT, "build.js"), "--offline", "--cache-only", "--date", TODAY, "--captured-at", `${TODAY}T12:00:00.000Z`, "--cache-dir", cache, "--out", path.join(dir, "out")], {
      cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "", GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Cover failures on record: 8 \(404 ×3, 410 ×2, 404\+410 ×1, not-image ×1, unknown ×1\)/);
    assert.match(r.stdout, /404 ×3 \(1 asked tonight, most tries 3\): tt0000010 tt0000020 tt0000030/);
    assert.ok(!fs.existsSync(summary), "a build that downloads nothing writes no summary");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cache, "posters.json"), "utf8")).failures, PLANTED, "--cache-only leaves the state as it found it");
  } finally { rm(dir); }
});
