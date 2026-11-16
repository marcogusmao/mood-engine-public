// Marco, 22/10/2026 ~06:40 UTC (lot 2): a film TMDB was asked about and has no record of stays out of the rows (see test/tmdb-no-record.test.js for the unit tests of the rule). The real build, offline, on a copy
// of the committed caches, ONE build with two films planted in the copy: East of Eden (tt21097264), asked and empty, and Dying for Sex (tt30252752), whose evidence is removed (nobody asked).
// Written against: East of Eden 2026 published as the one empty card of the Board; the rule wired to nothing in build.js (the unit tests stay green and the card stays empty); a log line that does not count
// the films; the cuts losing a film without a word (the log line of the quality net on the Discover cuts, review of 22/10/2026). Two builds took 538 s under load, hence one.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const NO_CACHE = !fs.existsSync(path.join(ROOT, "cache", "tmdb.json"));
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "cache", f))).digest("hex");
// The caches the row membership below was measured on (22/10/2026, origin/main 6698937). The nightly rewrites them: with other bytes the row assertions are not made (the films may no longer be in New releases)
// and the diagnostic says so; the flag, the index and the log assertions hold on any cache.
const MEASURED = { "tmdb.json": "2bfcdfed541a", "friends.json": "cc57c36b79ba" }; // first 12 characters of the sha256, as the docs quote them
const ASKED = { tt: "tt21097264", tmdbId: "258165" };      // East of Eden: movie 258165 and find both empty
const UNASKED = { tt: "tt30252752", name: "Dying for Sex" }; // empty in the committed cache too; the evidence is taken out of the copy
const LOG = /^\s*(\d+) films? without a TMDB record kept out of the rows \((.*)\)/;
const NET = /^\s*Quality net on the Discover cuts: (\d+) film\(s\) removed/;
const read = (out, ...p) => JSON.parse(fs.readFileSync(path.join(out, ...p), "utf8"));

test("build: a film TMDB was asked about and lacks (East of Eden) is in no Board row, is still in the index with its eligible flag off; one nobody asked about (Dying for Sex) stays; the log says how many were kept out", { skip: NO_CACHE, timeout: 900000 }, (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "me-norecord-out-")), cache = fs.mkdtempSync(path.join(os.tmpdir(), "me-norecord-cache-"));
  try {
    for (const f of ["directors.json", "friends.json", "lists.json", "imdb-ratings.json", "mubi.json"]) fs.copyFileSync(path.join(ROOT, "cache", f), path.join(cache, f));
    const tmdb = JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "tmdb.json"), "utf8"));
    const friends = JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "friends.json"), "utf8"));
    const unaskedId = Object.values(friends.films).find((f) => f.imdbId === UNASKED.tt)?.tmdbId;
    assert.ok(unaskedId, "the fixture: Letterboxd names a TMDB id for Dying for Sex");
    tmdb.movie[ASKED.tmdbId] = { t: Date.now(), v: null };   // asked: nothing
    tmdb.find[ASKED.tt] = { t: Date.now(), v: null };
    delete tmdb.movie[unaskedId]; delete tmdb.find[UNASKED.tt]; // not asked
    fs.writeFileSync(path.join(cache, "tmdb.json"), JSON.stringify(tmdb));
    const r = spawnSync(process.execPath, ["build.js", "--offline", "--cache-only", "--skip-posters", "--date", "2026-10-21", "--captured-at", "2026-10-21T23:18:00.000Z", "--cache-dir", cache, "--out", out],
      { cwd: ROOT, encoding: "utf8", env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "", MUBI_CACHE: "" } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const idx = read(out, "data", "index-v2.json");
    const tt = idx.cols.indexOf("tt"), flags = idx.cols.indexOf("flags");
    const eoe = idx.films.find((f) => f[tt] === ASKED.tt), dfs = idx.films.find((f) => f[tt] === UNASKED.tt);
    assert.ok(eoe && dfs, "the index keeps both films (search, lists, the Worker)");
    assert.equal(eoe[flags] & 4, 0, "asked and empty: the eligible flag is off");
    assert.equal(dfs[flags] & 4, 4, "not asked: eligible by its Letterboxd average, the rule does not hide what it cannot tell");
    const rowsHolding = (id) => Object.entries(idx.rows).filter(([, tts]) => tts.includes(id)).map(([row]) => row);
    assert.deepEqual(rowsHolding(ASKED.tt), [], "no Board row holds East of Eden");
    const metas = read(out, "catalog", "movie", "newforyou.json").metas;
    assert.ok(!metas.some((m) => m.id === ASKED.tt));
    for (const m of metas) assert.notEqual(m.description, "", `${m.name}: an empty card in New releases`);
    if (sha("tmdb.json").startsWith(MEASURED["tmdb.json"]) && sha("friends.json").startsWith(MEASURED["friends.json"])) {
      assert.deepEqual(rowsHolding(UNASKED.tt), ["newforyou"], "on the caches of 22/10/2026 the film nobody asked about is in New releases (the same state as East of Eden, without the evidence the rule asks for)");
      assert.ok(metas.length >= 40, "New releases refilled with the next films");
    } else t.diagnostic("cache/tmdb.json or friends.json changed since 22/10/2026: the row membership of the unasked film is not asserted");
    const lines = r.stdout.split("\n");
    const kept = lines.map((l) => l.match(LOG)).find(Boolean);
    assert.ok(kept, "the log line of the films kept out");
    assert.ok(Number(kept[1]) >= 1, `at least East of Eden: ${kept[1]}`);
    assert.match(kept[2], Number(kept[1]) > 3 ? new RegExp(` and ${Number(kept[1]) - 3} more$`) : /^[^]+$/, "the first three names, then how many more");
    const net = lines.map((l) => l.match(NET)).find(Boolean);
    assert.ok(net, "the log line of the quality net on the Discover cuts (a cut shortens without refill: the line says by how many cards)");
  } finally { fs.rmSync(out, { recursive: true, force: true }); fs.rmSync(cache, { recursive: true, force: true }); }
});
