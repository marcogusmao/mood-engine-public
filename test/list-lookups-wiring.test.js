// node --test
// The nightly cap on film-page lookups for list films (cfg.build.listLookups, lib/lists.js capLookups) reaches the lookups that run
// (review S4-6 M1, 11/10/2026): build.js must hand refreshFriends the capped `now`, not every list slug. That wiring only runs when the
// build reads Letterboxd, so this test runs build.js WITHOUT --cache-only and with the network replaced: a preload swaps
// refreshFriends, refreshLists, the live watchlist, /following/ and the crowd for local fakes, records what build.js asks refreshFriends
// to look up last, and every fetch throws. No page is requested.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const have = fs.existsSync(path.join(ROOT, "cache", "lists.json"));

const PRELOAD = String.raw`
const fs = require("fs"), path = require("path"), root = process.env.ME_ROOT;
const read = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  const out = read.call(this, file, ...rest);
  if (path.resolve(String(file)) !== path.join(root, "config.json")) return out;
  const c = JSON.parse(String(out)); c.build.listLookups = Number(process.env.ME_CAP);
  return typeof out === "string" ? JSON.stringify(c) : Buffer.from(JSON.stringify(c));
};
global.fetch = () => { throw new Error("network forbidden in this test"); };
const F = require(path.join(root, "lib", "friends.js")), L = require(path.join(root, "lib", "lists.js"));
L.readLiveWatchlist = async () => ({ ok: false, items: [], reason: "fake" });
L.readFollowing = async () => ({ people: [], followed: 0, used: 0, limited: false, rssRead: 0, rssFailed: [] });
L.readCrowd = async () => null;
const lists = L.refreshLists; L.refreshLists = (o) => lists({ ...o, cacheOnly: true });
F.refreshFriends = async (o) => {
  const more = await o.extra({ cache: o.cache, http: null, guarded: null, problems: [], log: () => {}, now: Date.now(), force: false, old: () => false, pageGap: 0, save: () => {} });
  fs.writeFileSync(process.env.ME_SPY, JSON.stringify({ last: more.last }));
  return { view: F.viewFriends(o.cache, o.cfg), resolved: { attempted: 0, withImdb: 0, withoutImdb: 0, notFound: 0, left: 0, enriched: 0, enrichWanted: 0 }, problems: [] };
};
`;

test("the night's list lookups are capped where they run: build.js hands refreshFriends capLookups' `now`, not every list slug", { skip: !have, timeout: 600000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "me-lookups-"));
  try {
    const cache = path.join(tmp, "cache"), out = path.join(tmp, "out"), spy = path.join(tmp, "spy.json"), pre = path.join(tmp, "preload.js");
    fs.mkdirSync(cache);
    for (const f of ["friends.json", "lists.json", "tmdb.json", "directors.json", "imdb-ratings.json"]) fs.copyFileSync(path.join(ROOT, "cache", f), path.join(cache, f));
    fs.writeFileSync(pre, PRELOAD);
    const cap = 100;
    // the committed caches have looked up every list film already: forget 300 of them in the copy, so tonight has more than the cap to do
    const F = require("../lib/friends"), L = require("../lib/lists");
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
    const lc = JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "lists.json"), "utf8"));
    const SL = require("../lib/static-lists");
    // a static list (data/lists/*.json) has its films in the file, not in cache/lists.json; its series are never looked up
    const itemsOf = (l) => (SL.isStatic(l) ? SL.itemsOf(SL.load(ROOT, l)).filter((i) => !i.tv) : lc.lists[l.id] ? L.correct(l, lc.lists[l.id].items.map(([slug, title, year]) => ({ slug, title, year }))) : null);
    const slugs = F.roundRobin(cfg.lists.map(itemsOf).filter(Boolean).map((items) => items.map((i) => i.slug)));
    const fc = JSON.parse(fs.readFileSync(path.join(cache, "friends.json"), "utf8"));
    for (const s of slugs.filter((x) => fc.films[x]).filter((_, i) => i % 7 === 3).slice(0, 300)) delete fc.films[s];
    fs.writeFileSync(path.join(cache, "friends.json"), JSON.stringify(fc));
    const films = fc.films;
    const env = { ...process.env, ME_ROOT: ROOT, ME_SPY: spy, ME_CAP: String(cap), SKIP_RSS: "1", TMDB_TOKEN: "" };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ["-r", pre, "build.js", "--offline", "--no-chrome", "--skip-posters", "--cache-dir", cache, "--out", out, "--date", "2026-10-11"], { cwd: ROOT, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, r.stderr.slice(0, 3000));
    const { last } = JSON.parse(fs.readFileSync(spy, "utf8"));
    // what the cap should let through, from the same (trimmed) caches
    const unknown = slugs.filter((s) => !films[s]);
    assert.ok(unknown.length > cap, `the caches must hold more never-looked-up list films (${unknown.length}) than the cap, or the test proves nothing`);
    const asked = last.filter((s) => !films[s]);
    assert.equal(asked.length, cap, `${asked.length} never-looked-up films asked for tonight, the cap is ${cap}`);
    assert.deepEqual(asked, unknown.slice(0, cap), "the first ones in the round-robin order");
    assert.match(r.stdout, new RegExp(`lists: ${unknown.length} films never looked up; ${cap} tonight \\(cfg\\.build\\.listLookups\\), ${unknown.length - cap} the next nights`));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
