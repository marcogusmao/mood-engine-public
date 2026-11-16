// node --test
// "A vouched list film with no Letterboxd average yet passes as 'no average'; a fan list's film with no average does not" (PRODUCT.md,
// Marco 11/10/2026; BACKLOG, final review of catalog-expansion, item 2: no test on the committed caches had such a film). This runs the
// real build twice on a copy of the caches: once as they are, once with the Letterboxd average of two films erased, as a film whose
// page was never read would be. One is vouched by a critic or director list, the other is only in fan lists; before, both qualified
// by their average (≥ 3.5). After, the vouched one must still be published as eligible, and the fan one must not.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const LW = require("../lib/list-signal");

const ROOT = path.join(__dirname, "..");
const have = ["friends.json", "lists.json", "tmdb.json"].every((f) => fs.existsSync(path.join(ROOT, "cache", f)));
const ELIGIBLE = 4, SEEN = 1; // lib/index-rows.js flags

function build(cache, out) {
  const env = { ...process.env, OFFLINE: "1", TMDB_TOKEN: "" };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["build.js", "--offline", "--cache-only", "--skip-posters", "--cache-dir", cache, "--out", out, "--date", "2026-10-11"], { cwd: ROOT, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr.slice(0, 3000));
  const idx = JSON.parse(fs.readFileSync(path.join(out, "data", "index.json"), "utf8"));
  const col = (name) => idx.cols.indexOf(name);
  return new Map(idx.films.map((f) => [f[col("tt")], { flags: f[col("flags")] || 0, lb: f[col("lbRating")], lists: f[col("lists")] }]));
}

test("a vouched list film whose Letterboxd average is not known yet stays eligible; a fan list's film in the same state does not", { skip: !have, timeout: 600000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "me-vouched-"));
  try {
    const cache = path.join(tmp, "cache");
    fs.mkdirSync(cache);
    for (const f of ["friends.json", "lists.json", "tmdb.json", "directors.json", "imdb-ratings.json"]) fs.copyFileSync(path.join(ROOT, "cache", f), path.join(cache, f));
    const before = build(cache, path.join(tmp, "out0"));

    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
    const fc = JSON.parse(fs.readFileSync(path.join(cache, "friends.json"), "utf8"));
    const lc = JSON.parse(fs.readFileSync(path.join(cache, "lists.json"), "utf8"));
    const vouched = LW.vouchedFromCaches({ cfg, listsCache: lc, films: fc.films });
    const loved = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "data", "directors-loved.json"), "utf8")).directors.flatMap((d) => (d.films || []).map((f) => f.imdb)));
    // a configured friend's rating would let a film through by itself: leave out every film a configured friend has on record
    const ttOf = (slug) => fc.films[slug] && fc.films[slug].imdbId;
    const friendRated = new Set();
    for (const { user } of cfg.friends || []) for (const k of ["films", "rss"]) for (const row of (fc.users[user] || {})[k] || []) if (ttOf(row[0])) friendRated.add(ttOf(row[0]));
    const usable = (tt, e) => (e.flags & ELIGIBLE) && !(e.flags & SEEN) && typeof e.lb === "number" && e.lb >= 3.5 && e.lists && !friendRated.has(tt) && !loved.has(tt);
    const sorted = [...before].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const v = sorted.find(([tt, e]) => usable(tt, e) && vouched.has(tt));
    const n = sorted.find(([tt, e]) => usable(tt, e) && !vouched.has(tt));
    assert.ok(v && n, "the caches must hold a vouched and a fan-only list film that qualify by their average");
    if (process.env.ME_SHOW) console.log(`vouched ${v[0]} (${vouched.get(v[0]).list}, ${v[1].lb}★) · fan ${n[0]} (${n[1].lb}★)`);

    // erase the Letterboxd average of both, on every record that names them: as if their pages were never read
    for (const r of Object.values(fc.films)) if (r.imdbId === v[0] || r.imdbId === n[0]) { delete r.r; delete r.rn; }
    fs.writeFileSync(path.join(cache, "friends.json"), JSON.stringify(fc));
    const after = build(cache, path.join(tmp, "out1"));

    const va = after.get(v[0]);
    assert.ok(va, `${v[0]} (vouched by ${vouched.get(v[0]).list}) left the index once its average was unknown`);
    assert.equal(va.lb ?? null, null, "its average is unknown in the second build");
    assert.ok(va.flags & ELIGIBLE, `${v[0]} (vouched by ${vouched.get(v[0]).list}) is no longer eligible with no average`);
    const na = after.get(n[0]);
    assert.ok(!na || !(na.flags & ELIGIBLE), `${n[0]} is only in fan lists and has no average, yet it is published as eligible`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
