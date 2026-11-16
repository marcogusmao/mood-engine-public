// node --test            (no dependencies; the two tests that draw for real need python3 with Pillow and are skipped without it)
// Covers with the ratings drawn on them: the IMDb dataset, which cover is downloaded, when it is drawn again, what address it gets,
// and what happens when something fails (lib/posters.js, tools/selo/render.py).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");

const P = require("../lib/posters");

const ROOT = path.join(__dirname, "..");
const tmp = (p = "mood-posters-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const noSleep = async () => {};
const hasPillow = spawnSync("python3", ["-c", "import PIL"]).status === 0;

const R = (o = {}) => ({ lb: null, imdb: null, friendsAvg: null, seenBy: 0, wantBy: 0, ...o });
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2500, 7)]);
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, arrayBuffer: async () => body });

// ── the IMDb dataset ─────────────────────────────────────────────────────────

const TSV = "tconst\taverageRating\tnumVotes\ntt0000001\t5.7\t2100\ntt0049406\t8.0\t100000\ntt0068327\t7.8\t30000\ntt0000009\t0.0\t0\nnm0000001\t9.9\t5\n";

test("IMDb dataset: rating and votes for the wanted tt only; the header, other kinds of id and a rating of 0 are ignored", () => {
  const m = P.parseImdbRatings(TSV, new Set(["tt0049406", "tt0068327", "tt0000009", "nm0000001", "tt9999999"]));
  assert.deepEqual([...m], [["tt0049406", { rating: 8, votes: 100000 }], ["tt0068327", { rating: 7.8, votes: 30000 }]]);
});

function dataset(file, over = {}) {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return over.fail ? reply(Buffer.alloc(0), 503) : reply(zlib.gzipSync(over.body ?? TSV)); };
  return { calls, args: { file, fetchImpl, sleepImpl: noSleep, log: () => {}, today: "2026-10-10", ...over.args } };
}

test("loadImdbRatings: downloads once a night, keeps only the tt the files use, and tomorrow's build starts from that cache", async () => {
  const dir = tmp(), file = path.join(dir, "imdb-ratings.json");
  try {
    const d = dataset(file);
    const r = await P.loadImdbRatings({ ...d.args, wanted: new Set(["tt0049406", "tt0068327", "tt7777777"]) });
    assert.equal(r.source, "downloaded");
    assert.deepEqual([...r.map], [["tt0049406", 8], ["tt0068327", 7.8]]);
    assert.deepEqual(d.calls, [P.IMDB_RATINGS_URL]);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(saved.ratings).sort(), ["tt0049406", "tt0068327"]); // not 1.5 million rows
    assert.deepEqual(saved.none, ["tt7777777"]);
    const again = await P.loadImdbRatings({ ...d.args, wanted: new Set(["tt0049406", "tt7777777"]) });
    assert.equal(again.source, "cache");
    assert.equal(d.calls.length, 1, "the same night, nothing new wanted: no second download");
  } finally { rm(dir); }
});

test("loadImdbRatings: downloaded again the next day and when a film the cache has never seen is wanted", async () => {
  const dir = tmp(), file = path.join(dir, "imdb-ratings.json");
  try {
    const d = dataset(file);
    await P.loadImdbRatings({ ...d.args, wanted: new Set(["tt0049406"]) });
    await P.loadImdbRatings({ ...d.args, wanted: new Set(["tt0049406", "tt0068327"]) }); // a new film in tonight's files
    assert.equal(d.calls.length, 2);
    await P.loadImdbRatings({ ...d.args, today: "2026-10-11", wanted: new Set(["tt0049406"]) });
    assert.equal(d.calls.length, 3);
  } finally { rm(dir); }
});

test("loadImdbRatings: a download that fails leaves yesterday's cache in use and says so; with no cache the films just have no IMDb number", async () => {
  const dir = tmp(), file = path.join(dir, "imdb-ratings.json");
  try {
    await P.loadImdbRatings({ ...dataset(file).args, wanted: new Set(["tt0049406"]) });
    const logs = [];
    const bad = dataset(file, { fail: true, args: { today: "2026-10-11", log: (m) => logs.push(m), sleepImpl: noSleep } });
    const r = await P.loadImdbRatings({ ...bad.args, wanted: new Set(["tt0049406"]) });
    assert.equal(r.source, "stale cache");
    assert.deepEqual([...r.map], [["tt0049406", 8]]);
    assert.match(logs[0], /IMDb ratings: HTTP 503 — using the cache from 2026-10-10/);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).date, "2026-10-10", "a failed download must not rewrite the cache");
    const none = dataset(path.join(dir, "other.json"), { fail: true });
    const r2 = await P.loadImdbRatings({ ...none.args, wanted: new Set(["tt1"]) });
    assert.equal(r2.map.size, 0);
  } finally { rm(dir); }
});

test("loadImdbRatings: something that is not the ratings file (a web page) is refused; offline (--cache-only) downloads and writes nothing", async () => {
  const dir = tmp(), file = path.join(dir, "imdb-ratings.json");
  try {
    const page = dataset(file, { body: "<html>Please log in</html>" });
    const r = await P.loadImdbRatings({ ...page.args, wanted: new Set(["tt1"]) });
    assert.equal(r.source, "stale cache");
    assert.ok(!fs.existsSync(file));
    const off = dataset(file);
    const o = await P.loadImdbRatings({ ...off.args, offline: true, wanted: new Set(["tt1"]) });
    assert.equal(o.source, "cache (offline)");
    assert.equal(off.calls.length, 0);
    assert.ok(!fs.existsSync(file));
  } finally { rm(dir); }
});

// ── which cover, which hash, which address ───────────────────────────────────

test("cover source: TMDB w342 when the TMDB cache has the film's poster path, else metahub by IMDb id", () => {
  assert.deepEqual(P.posterSource({ tt: "tt1", tmdbPoster: "/abc.jpg" }), { url: "https://image.tmdb.org/t/p/w342/abc.jpg", kind: "tmdb" });
  assert.deepEqual(P.posterSource({ tt: "tt1", tmdbPoster: null }), { url: "https://images.metahub.space/poster/medium/tt1/img", kind: "metahub" });
  assert.equal(P.posterSource({ tt: "tt1", tmdbPoster: "https://x/y.jpg" }).kind, "metahub"); // only a TMDB path counts
  assert.equal(P.fallbackSource("tt1", "tmdb").kind, "metahub");
  assert.equal(P.fallbackSource("tt1", "metahub"), null);
});

test("redraw hash: numbers rounded to 0.1 — a change too small to show does not redraw, one that shows does; counts, source and the drawing code count too", () => {
  const h = (r, kind = "tmdb", v = "v1") => P.inputHash(R(r), kind, v);
  const base = { lb: 4.31, imdb: 7.3, friendsAvg: 4.52, seenBy: 3, wantBy: 5 };
  assert.equal(h(base), h({ ...base, lb: 4.34, friendsAvg: 4.5 })); // 4.31 and 4.34 both draw "4.3"
  assert.notEqual(h(base), h({ ...base, lb: 4.36 })); // "4.4"
  assert.notEqual(h(base), h({ ...base, imdb: 7.4 }));
  assert.notEqual(h(base), h({ ...base, seenBy: 4 }));
  assert.equal(h(base), h({ ...base, wantBy: 0 })); // friends' watchlists are no longer drawn
  assert.notEqual(h(base), h(base, "metahub"));
  assert.notEqual(h(base), h(base, "tmdb", "v2"));
  assert.equal(h({ ...base, imdb: null }), h({ ...base, imdb: undefined }));
  assert.deepEqual(P.shown(R({ lb: 4.36, friendsAvg: 4.25, seenBy: 2 })), { lb: 4.4, imdb: null, amigos: 4.3, viram: 2 }); // what the badge will say
  assert.equal(P.hasNumbers(P.shown(R())), false);
  assert.equal(P.hasNumbers(P.shown(R({ wantBy: 1 }))), false);
});

test("redraw hash, v2.2: the year and the flag are in it — a new year, a new flag or a flag that appears redraws the cover; the same ones do not", () => {
  const base = { lb: 4.3, imdb: 7.3, friendsAvg: 4.5, seenBy: 3, wantBy: 5 };
  const h = (top) => P.inputHash(R(base), "tmdb", "v1", top);
  assert.equal(h({ year: 2002, flag: "fr" }), h({ year: 2002, flag: "fr" }));
  assert.notEqual(h({ year: 2002, flag: "fr" }), h({ year: 2003, flag: "fr" }));
  assert.notEqual(h({ year: 2002, flag: "fr" }), h({ year: 2002, flag: "pl" }));
  assert.notEqual(h({ year: 2002, flag: "fr" }), h({ year: 2002, flag: null })); // the flag could not be downloaded last night and is there tonight
  assert.notEqual(h({ year: 2002, flag: null }), h({ year: null, flag: null }));
  assert.equal(h({}), h(undefined));
  assert.equal(h({ year: 0, flag: "", rule: "" }), h({})); // nothing to show is nothing, however it is spelled
});

test("redraw hash, v2.3: the step of the country rule that chose the flag is in it — a change of criterion redraws once, even where it picks the same flag", () => {
  const base = { lb: 4.3, imdb: 7.3, friendsAvg: 4.5, seenBy: 3, wantBy: 5 };
  const h = (rule) => P.inputHash(R(base), "tmdb", "v1", { year: 2002, flag: "fr", rule });
  assert.equal(h("language"), h("language"));
  assert.notEqual(h("language"), h("production"));
  assert.notEqual(h("language"), h("language-default"));
  assert.notEqual(h("production"), h("letterboxd"));
  assert.notEqual(h(null), h("language")); // the v2.2 hash had no rule: every v2.2 cover is drawn again once
});

test("the drawing code's version changes when the script, a mark or the font changes", () => {
  const dir = tmp();
  try {
    for (const f of ["render.py", "selo.py", "lb-dots-crop.png", "imdb-48-crop.png", "LiberationSans-Bold.ttf"]) fs.writeFileSync(path.join(dir, f), f);
    const v = P.renderVersion(dir);
    assert.equal(P.renderVersion(dir), v);
    for (const f of ["selo.py", "imdb-48-crop.png", "LiberationSans-Bold.ttf"]) {
      fs.appendFileSync(path.join(dir, f), "!");
      assert.notEqual(P.renderVersion(dir), v, f);
      fs.writeFileSync(path.join(dir, f), f);
    }
    assert.match(P.renderVersion(), /^[0-9a-f]{12}$/); // the real folder
  } finally { rm(dir); }
});

test("poster address: the base with or without a closing slash, and the default Pages address", () => {
  assert.equal(P.posterUrl("https://marcogusmao.github.io/mood-engine/posters/", "tt1"), "https://marcogusmao.github.io/mood-engine/posters/tt1.jpg");
  assert.equal(P.posterUrl("https://x.test/p", "tt1"), "https://x.test/p/tt1.jpg");
  assert.equal(P.posterUrl(undefined, "tt1"), "https://marcogusmao.github.io/mood-engine/posters/tt1.jpg");
});

test("collectTargets: one target per film however many rows it sits in, with the TMDB poster path and every item to update", () => {
  const ratings = R({ lb: 4 });
  const a1 = { id: "tt1", poster: null, ratings }, a2 = { id: "tt1", poster: "/p.jpg", ratings }, b = { id: "tt2", poster: "/q.jpg", ratings: R() };
  const t = P.collectTargets({ board: [{ id: "x", items: [a1, b] }], discover: [{ id: "c", options: [{ label: "o", items: [a2] }] }] });
  assert.equal(t.size, 2);
  assert.equal(t.get("tt1").tmdbPoster, "/p.jpg");
  assert.equal(t.get("tt1").items.length, 2);
  assert.equal(t.get("tt1").ratings, ratings);
});

test("collectTargets: the year on the cover is the item's own year; an item without one does not erase another's, and a year that cannot be right is not shown", () => {
  const ratings = R({ lb: 4 });
  const items = (...ys) => ys.map((year) => ({ id: "tt1", year, ratings }));
  const year = (...ys) => P.collectTargets({ board: [{ id: "x", items: items(...ys) }], discover: [] }).get("tt1").year;
  assert.equal(year(2002), 2002);
  assert.equal(year(null, 1957, 1960), 1957); // the first usable one
  assert.equal(year("1999"), 1999);
  for (const bad of [null, undefined, 0, "abc", 1500, 2500, NaN]) assert.equal(year(bad), null, String(bad));
  assert.equal(P.collectTargets({ board: [{ id: "x", items: items(2002) }], discover: [] }).get("tt1").cc, null); // the flag code is filled in by lib/countries.js
});

// ── downloading an image ─────────────────────────────────────────────────────

test("fetchImage: an image is returned; a web page, a tiny body or a 404 is refused at once; a 5xx is retried", async () => {
  assert.equal((await P.fetchImage("u", { fetchImpl: async () => reply(JPEG), sleepImpl: noSleep })).length, JPEG.length);
  await assert.rejects(P.fetchImage("u", { fetchImpl: async () => reply(Buffer.from("<html>" + "x".repeat(3000))), sleepImpl: noSleep }), /not an image/);
  await assert.rejects(P.fetchImage("u", { fetchImpl: async () => reply(Buffer.from([0xff, 0xd8, 0xff, 1])), sleepImpl: noSleep }), /not an image/);
  let n = 0;
  await assert.rejects(P.fetchImage("u", { fetchImpl: async () => (n++, reply(Buffer.alloc(0), 404)), sleepImpl: noSleep }), /404/);
  assert.equal(n, 1);
  let k = 0;
  const flaky = async () => (++k < 3 ? reply(Buffer.alloc(0), 502) : reply(JPEG));
  assert.ok((await P.fetchImage("u", { fetchImpl: flaky, sleepImpl: noSleep })).length > 0);
  assert.equal(k, 3);
});

// ── the whole step, with the network and Python replaced ─────────────────────

const V9 = P.coverVersion(require("crypto").createHash("sha256").update(Buffer.alloc(1500, 9)).digest("hex")); // what the fake renderer below draws: 1500 bytes of 9

function world() {
  const dir = tmp("mood-covers-");
  const d = { raw: path.join(dir, "raw"), out: path.join(dir, "out"), state: path.join(dir, "posters.json") };
  const fetched = [], drawn = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    if (/tt5/.test(url)) return reply(Buffer.alloc(0), 404); // E: nothing anywhere
    if (url.includes("image.tmdb.org") && /bad/.test(url)) return reply(Buffer.alloc(0), 404); // D: TMDB says no, metahub has it
    return reply(JPEG);
  };
  const render = async (jobs) => {
    drawn.push(...jobs.map((j) => j.tt));
    const failed = [];
    for (const j of jobs) { if (world.failDraw === j.tt) failed.push({ tt: j.tt, error: "boom" }); else fs.writeFileSync(j.out, Buffer.alloc(1500, 9)); }
    return { drawn: jobs.length - failed.length, failed };
  };
  const make = () => {
    const t = (tt, o) => ({ tt, tmdbPoster: o.poster ?? null, ratings: R(o.r), items: [{ id: tt, poster: o.poster ?? null }, { id: tt, poster: null }] });
    return new Map([
      t("tt1", { poster: "/a.jpg", r: { lb: 4.31, imdb: 7.3, friendsAvg: 4.5, seenBy: 3, wantBy: 5 } }), // A: TMDB
      t("tt2", { r: { lb: 3.9 } }), // B: metahub
      t("tt3", { r: {} }), // C: nothing to show
      t("tt4", { poster: "/bad.jpg", r: { imdb: 6 } }), // D: TMDB fails, metahub works
      t("tt5", { r: { imdb: 5 } }), // E: no cover anywhere
    ].map((x) => [x.tt, x]));
  };
  const run = (targets, o = {}) => P.drawCovers({ targets, dir: d, base: "https://pages.test/posters/", today: "2026-10-10", fetchImpl, render, version: "v1", sleepImpl: noSleep, ...o });
  return { dir, d, fetched, drawn, make, run, done: () => { world.failDraw = null; rm(dir); } };
}

test("covers: downloaded once, drawn, published; a film with nothing to show keeps its address; a TMDB miss falls back to metahub; a film with no cover anywhere keeps its address and is counted", async () => {
  const w = world();
  try {
    const targets = w.make();
    const r = await w.run(targets);
    assert.deepEqual([...r.tts].sort(), ["tt1", "tt2", "tt4"]);
    assert.equal(r.stats.unique, 5);
    assert.equal(r.stats.noNumbers, 1);
    assert.equal(r.stats.downloaded, 3);
    assert.equal(r.stats.downloadFailed, 1);
    assert.equal(r.stats.usedFallback, 1); // D went from TMDB to metahub; E asked metahub only (no TMDB path), so it had no other source to try
    assert.equal(r.stats.drawn, 3);
    assert.ok(w.fetched.includes("https://image.tmdb.org/t/p/w342/a.jpg"));
    assert.ok(w.fetched.includes("https://images.metahub.space/poster/medium/tt2/img"));
    assert.ok(w.fetched.includes("https://image.tmdb.org/t/p/w342/bad.jpg") && w.fetched.includes("https://images.metahub.space/poster/medium/tt4/img"));
    // addresses: every item of a ready film, none of the others
    assert.ok(targets.get("tt1").items.every((i) => i.poster === `https://pages.test/posters/tt1.jpg?v=${V9}`));
    assert.ok(targets.get("tt4").items.every((i) => i.poster === `https://pages.test/posters/tt4.jpg?v=${V9}`));
    assert.deepEqual(targets.get("tt3").items.map((i) => i.poster), [null, null]);
    assert.deepEqual(targets.get("tt5").items.map((i) => i.poster), [null, null]);
    assert.ok(fs.existsSync(path.join(w.d.raw, "tt1.jpg")) && !fs.existsSync(path.join(w.d.raw, "tt5.jpg")));
    assert.ok(r.stats.mb > 0);
    const state = JSON.parse(fs.readFileSync(w.d.state, "utf8")).items;
    assert.deepEqual(Object.keys(state).sort(), ["tt1", "tt2", "tt4"]);
    assert.equal(state.tt1.kind, "tmdb");
    assert.equal(state.tt4.kind, "metahub"); // the source that answered
  } finally { w.done(); }
});

test("covers: the second night, with nothing changed, downloads and draws nothing — and a fallback cover is not redrawn every night", async () => {
  const w = world();
  try {
    await w.run(w.make());
    w.fetched.length = 0; w.drawn.length = 0;
    const targets = w.make();
    const r = await w.run(targets);
    assert.equal(r.stats.unchanged, 3);
    assert.deepEqual(w.drawn, []);
    assert.deepEqual(w.fetched.filter((u) => !/tt5/.test(u) && !/\/a\.jpg|tt2|tt4|bad/.test(u)), []);
    assert.ok(!w.fetched.some((u) => /a\.jpg|tt2\/img/.test(u)), "a cover already downloaded is not downloaded again");
    assert.deepEqual([...r.tts].sort(), ["tt1", "tt2", "tt4"]);
    assert.ok(targets.get("tt4").items.every((i) => i.poster === `https://pages.test/posters/tt4.jpg?v=${V9}`));
  } finally { w.done(); }
});

test("covers: a change in a number that shows redraws that cover from the raw one (no download); a change too small to show does not", async () => {
  const w = world();
  try {
    await w.run(w.make());
    w.fetched.length = 0; w.drawn.length = 0;
    let t = w.make();
    t.get("tt1").ratings.lb = 4.34; // shows "4.3" either way
    t.get("tt2").ratings.seenBy = 2; // a new badge
    await w.run(t);
    assert.deepEqual(w.drawn, ["tt2"]);
    assert.ok(!w.fetched.some((u) => /tt2/.test(u)), "the raw cover was kept: nothing downloaded to redraw");
    w.drawn.length = 0;
    t = w.make();
    t.get("tt1").ratings.lb = 4.36; // "4.4"
    t.get("tt2").ratings.seenBy = 2;
    await w.run(t);
    assert.deepEqual(w.drawn, ["tt1"]);
  } finally { w.done(); }
});

test("covers: a drawn file that is gone is drawn again; a drawing that fails leaves that film on its old address and the others untouched", async () => {
  const w = world();
  try {
    await w.run(w.make());
    fs.rmSync(path.join(w.d.out, "tt2.jpg"));
    w.drawn.length = 0;
    const gone = w.make();
    await w.run(gone);
    assert.deepEqual(w.drawn, ["tt2"]);
    // a new number for tt1 while the drawing breaks for it
    world.failDraw = "tt1";
    const t = w.make();
    t.get("tt1").ratings.seenBy = 9;
    const r = await w.run(t);
    assert.equal(r.stats.drawFailed, 1);
    assert.ok(!r.tts.has("tt1"));
    assert.deepEqual(t.get("tt1").items.map((i) => i.poster), ["/a.jpg", null]); // untouched: the build's own address logic keeps the original
    assert.ok(r.tts.has("tt2") && r.tts.has("tt4"));
  } finally { w.done(); }
});

// 13/10/2026, adversarial review of watchlist-poster-porto: a cover counted as "unchanged" when cache/posters.json had its hash and ANY file stood in
// posters-out. The workflow restores posters-out from a weekly cache that is not saved again once the week's key exists, while posters.json is committed
// every run, so a restored file can be the drawing of an older design under a hash of today (Actions runs 38106060637: "3500 unchanged";
// 38339594653: "6534 unchanged", with covers still without the year/flag pill). The state now holds the sha256 of the JPEG it drew.
test("covers: a file in the drawn folder that is not the drawing the state recorded (restored from an old cache) is drawn again, and so is a state with no recorded drawing", async () => {
  const w = world();
  try {
    await w.run(w.make());
    // the hash matches (it is today's), the file is the one an older night drew
    fs.writeFileSync(path.join(w.d.out, "tt1.jpg"), Buffer.alloc(1500, 1));
    w.drawn.length = 0;
    const r = await w.run(w.make());
    assert.deepEqual(w.drawn, ["tt1"], "only the restored cover is drawn again");
    assert.equal(r.stats.unchanged, 2);
    assert.deepEqual(fs.readFileSync(path.join(w.d.out, "tt1.jpg")), Buffer.alloc(1500, 9));
    assert.match(JSON.parse(fs.readFileSync(w.d.state, "utf8")).items.tt1.s, /^[0-9a-f]{64}$/, "the state records the sha256 of the JPEG it drew");
    // an entry from before the state recorded drawings cannot prove its file either
    const old = JSON.parse(fs.readFileSync(w.d.state, "utf8"));
    delete old.items.tt2.s;
    fs.writeFileSync(w.d.state, JSON.stringify(old));
    w.drawn.length = 0;
    await w.run(w.make());
    assert.deepEqual(w.drawn, ["tt2"]);
    // and the next night, with the files as drawn, nothing is drawn
    w.drawn.length = 0;
    const again = await w.run(w.make());
    assert.deepEqual(w.drawn, []);
    assert.equal(again.stats.unchanged, 3);
  } finally { w.done(); }
});

test("covers --cache-only: nothing is downloaded and nothing is written; covers already on disk are still used", async () => {
  const w = world();
  try {
    await w.run(w.make());
    const before = fs.readFileSync(w.d.state, "utf8");
    w.fetched.length = 0;
    const t = w.make();
    t.get("tt2").ratings.seenBy = 7; // would need a redraw: the raw cover is on disk, so it can be done...
    t.set("tt9", { tt: "tt9", tmdbPoster: null, ratings: R({ lb: 3 }), items: [{ id: "tt9", poster: null }] }); // ...but a new film has no raw cover
    const r = await w.run(t, { cacheOnly: true });
    assert.deepEqual(w.fetched, []);
    assert.equal(r.stats.noRaw, 2); // the new film, and tt5 (no cover anywhere, so never on disk)
    assert.ok(r.tts.has("tt1") && r.tts.has("tt2") && !r.tts.has("tt9"));
    assert.equal(fs.readFileSync(w.d.state, "utf8"), before, "--cache-only must not write cache/posters.json");
  } finally { w.done(); }
});

test("covers: a cover nobody has asked for in 21 days is deleted with its raw cover; a recent one is kept; the date is refreshed weekly, not nightly", async () => {
  const w = world();
  try {
    await w.run(w.make());
    const state = JSON.parse(fs.readFileSync(w.d.state, "utf8"));
    for (const tt of ["old", "recent"]) { state.items[tt] = { h: "x", kind: "tmdb", d: tt === "old" ? "2026-09-01" : "2026-10-05" }; fs.writeFileSync(path.join(w.d.raw, `${tt}.jpg`), JPEG); fs.writeFileSync(path.join(w.d.out, `${tt}.jpg`), JPEG); }
    state.items.tt1.d = "2026-10-08"; // 2 days ago
    fs.writeFileSync(w.d.state, JSON.stringify(state));
    const r = await w.run(w.make());
    const after = JSON.parse(fs.readFileSync(w.d.state, "utf8")).items;
    assert.equal(r.stats.pruned, 1);
    assert.ok(!after.old && after.recent);
    assert.ok(!fs.existsSync(path.join(w.d.raw, "old.jpg")) && !fs.existsSync(path.join(w.d.out, "old.jpg")));
    assert.ok(fs.existsSync(path.join(w.d.out, "recent.jpg")));
    assert.equal(after.tt1.d, "2026-10-08", "used 2 days ago: not rewritten tonight, so the committed file does not change every day");
    const t2 = await w.run(w.make(), { today: "2026-10-30" });
    assert.equal(JSON.parse(fs.readFileSync(w.d.state, "utf8")).items.tt1.d, "2026-10-30"); // a week and more: refreshed
    assert.equal(t2.stats.pruned, 1); // "recent" was 5 days old on the 10th; on the 30th it is 25
  } finally { w.done(); }
});

// ── a cover that is nowhere (B3 of the 13/10 audit, 19/10/2026) ──────────────
// Defect: every nightly said "FAILED: 47 download" for a week. The 47 are films with no TMDB record whose metahub address answers 404 (measured 19/10/2026: 46 of 47 with HTTP 404, the
// 47th answered 200 that day), asked again every night forever, because the state remembered only what worked. Now a failure for good is recorded in `failures` and asked again after 7 nights.

const stateOf = (w) => JSON.parse(fs.readFileSync(w.d.state, "utf8"));
const asked = (w, tt) => w.fetched.filter((u) => u.includes(`/${tt}/`) || u.endsWith(`/${tt}.jpg`));
const NIGHTS = ["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"];
const META5 = "https://images.metahub.space/poster/medium/tt5/img";
/** A fetch for the world's other covers (they work), with `impl` answering for tt5 and tt6 only; every url asked is written to w.fetched. */
const spy = (w, impl) => async (u) => { w.fetched.push(u); return /tt5|tt6|alt\.test|\/new\.jpg|\/gone\.jpg/.test(u) ? impl(u) : reply(JPEG); };

test("B3: a cover every source refused with 404 is recorded and asked again only on the 7th night; the nights between count it as skipped (backoff) and the film keeps its address", async () => {
  const w = world();
  try {
    const r1 = await w.run(w.make(), { today: "2026-10-10" });
    assert.equal(r1.stats.downloadFailed, 1);
    assert.equal(r1.stats.skippedBackoff, 0);
    assert.deepEqual(stateOf(w).failures.tt5, { kind: "permanent", tries: 1, code: "404", last: "2026-10-10", next: "2026-10-17", url: META5 });
    for (const day of NIGHTS) {
      w.fetched.length = 0;
      const t = w.make();
      const r = await w.run(t, { today: day });
      assert.deepEqual(asked(w, "tt5"), [], `${day}: not asked`);
      assert.equal(r.stats.skippedBackoff, 1);
      assert.equal(r.stats.downloadFailed, 0, "a cover that was not asked did not fail tonight");
      assert.equal(r.receipt.find((x) => x.tt === "tt5").reason, "backoff");
      assert.deepEqual(t.get("tt5").items.map((i) => i.poster), [null, null]);
      assert.equal(stateOf(w).failures.tt5.tries, 1, "a night that did not ask changes nothing in the record");
    }
    w.fetched.length = 0;
    const r7 = await w.run(w.make(), { today: "2026-10-17" });
    assert.deepEqual(asked(w, "tt5"), [META5], "the 7th night asks once (a 404 is not retried inside the night)");
    assert.equal(r7.stats.downloadFailed, 1);
    assert.equal(r7.stats.skippedBackoff, 0);
    assert.deepEqual(stateOf(w).failures.tt5, { kind: "permanent", tries: 2, code: "404", last: "2026-10-17", next: "2026-10-24", url: META5 });
    // the covers that work are not touched by any of this
    assert.deepEqual(Object.keys(stateOf(w).items).sort(), ["tt1", "tt2", "tt4"]);
  } finally { w.done(); }
});

test("B3: 410 and a body that is not an image are failures for good too (code recorded); 403, 503 and a network error are not, and nothing is recorded for them", async () => {
  const cases = [
    ["410", async () => reply(Buffer.alloc(0), 410), "permanent", "410"],
    ["not an image", async () => reply(Buffer.from("<html>" + "x".repeat(3000))), "permanent", "not-image"],
    ["403", async () => reply(Buffer.alloc(0), 403), null],
    ["503", async () => reply(Buffer.alloc(0), 503), null],
    ["network error", async () => { throw new Error("ECONNRESET"); }, null],
  ];
  for (const [name, fetchImpl, kind, code] of cases) {
    const w = world();
    try {
      const only = new Map([["tt5", w.make().get("tt5")]]);
      const r = await w.run(only, { today: "2026-10-10", fetchImpl });
      assert.equal(r.stats.downloadFailed, 1, name);
      const f = stateOf(w).failures;
      if (kind) assert.deepEqual([f.tt5.kind, f.tt5.code, f.tt5.next], [kind, code, "2026-10-17"], name);
      else assert.equal(f, undefined, `${name}: a transient failure leaves no record`);
    } finally { w.done(); }
  }
});

test("B3: a transient failure is asked again the very next night, night after night, as before; so is a source pair where only one of the two said 404", async () => {
  const w = world();
  try {
    let calls = 0;
    const busy = async () => (calls++, reply(Buffer.alloc(0), 503));
    for (const day of ["2026-10-10", "2026-10-11", "2026-10-12"]) {
      const before = calls;
      const r = await w.run(new Map([["tt5", w.make().get("tt5")]]), { today: day, fetchImpl: busy });
      assert.ok(calls > before, `${day}: asked`);
      assert.equal(r.stats.skippedBackoff, 0);
    }
    assert.equal(stateOf(w).failures, undefined);
    // TMDB says 404 (for good) but metahub is busy (not for good): the night's failure is transient, so no backoff
    const mixed = new Map([["tt6", { tt: "tt6", tmdbPoster: "/gone.jpg", ratings: R({ imdb: 5 }), items: [{ id: "tt6", poster: null }] }]]);
    const f2 = async (url) => (url.includes("image.tmdb.org") ? reply(Buffer.alloc(0), 404) : reply(Buffer.alloc(0), 503));
    await w.run(mixed, { today: "2026-10-13", fetchImpl: f2 });
    assert.equal(stateOf(w).failures, undefined, "one source that may recover keeps the cover in the nightly queue");
    // both say 404 for good: recorded against the address that was planned (TMDB's)
    await w.run(mixed, { today: "2026-10-13", fetchImpl: async () => reply(Buffer.alloc(0), 404) });
    assert.deepEqual([stateOf(w).failures.tt6.code, stateOf(w).failures.tt6.url], ["404", "https://image.tmdb.org/t/p/w342/gone.jpg"]);
  } finally { w.done(); }
});

test("B3: a cover that comes back clears its record; a transient answer on the day it is due leaves it due; a new planned address (a TMDB poster path that appeared) is asked at once", async () => {
  const w = world();
  try {
    await w.run(w.make(), { today: "2026-10-10" });
    assert.ok(stateOf(w).failures.tt5);
    // due on the 17th, metahub is busy: the record stays (tries 1), and the 18th asks again
    const busy = spy(w, async () => reply(Buffer.alloc(0), 503));
    await w.run(w.make(), { today: "2026-10-17", fetchImpl: busy });
    assert.equal(stateOf(w).failures.tt5.tries, 1);
    w.fetched.length = 0;
    const r18 = await w.run(w.make(), { today: "2026-10-18", fetchImpl: busy });
    assert.ok(asked(w, "tt5").length > 0 && r18.stats.skippedBackoff === 0, "still due the next night");
    // a new planned address: the record of the old one does not hold it back, even before `next`
    await w.run(w.make(), { today: "2026-10-18" }); // 404 again: tries 2, next 25th
    assert.equal(stateOf(w).failures.tt5.tries, 2);
    const t = w.make();
    Object.assign(t.get("tt5"), { tmdbPoster: "/new.jpg" });
    w.fetched.length = 0;
    const r19 = await w.run(t, { today: "2026-10-19", fetchImpl: spy(w, async (u) => (u.includes("image.tmdb.org") ? reply(JPEG) : reply(Buffer.alloc(0), 404))) });
    assert.deepEqual(asked(w, "tt5").length, 0);
    assert.ok(w.fetched.includes("https://image.tmdb.org/t/p/w342/new.jpg"), "asked at the new address on the 19th, not held back until the 25th");
    assert.ok(r19.tts.has("tt5"));
    assert.equal(stateOf(w).failures, undefined, "a cover that is ready no longer fails; with no failure left the key is gone");
  } finally { w.done(); }
});

test("B3 (c): after 3 tries for good the other source is looked for once; none found is recorded and not repeated; a found one that answers switches the cover and records the switch; one that fails is recorded and not repeated", async () => {
  const days = ["2026-10-10", "2026-10-17", "2026-10-24", "2026-10-31", "2026-11-07"];
  // none to be found
  let w = world();
  try {
    const calls = [];
    const altSource = async (x) => (calls.push([x.tt, x.tries, x.code]), null);
    for (const day of days.slice(0, 2)) await w.run(w.make(), { today: day, altSource });
    assert.deepEqual(calls, [], "tries 1 and 2: no look yet");
    await w.run(w.make(), { today: days[2], altSource });
    assert.deepEqual(calls, [["tt5", 3, "404"]]);
    assert.deepEqual(stateOf(w).failures.tt5.alt, { d: days[2], found: false });
    for (const day of days.slice(3)) await w.run(w.make(), { today: day, altSource });
    assert.equal(calls.length, 1, "looked for once, not on the 4th or 5th try");
    assert.equal(stateOf(w).failures.tt5.tries, 5);
  } finally { w.done(); }
  // found, and it answers
  w = world();
  try {
    const altSource = async (x) => (x.tt === "tt5" ? { url: "https://alt.test/tt5.jpg", kind: "tmdb" } : null);
    const fetchImpl = spy(w, async (u) => (u.startsWith("https://alt.test/") ? reply(JPEG) : reply(Buffer.alloc(0), 404)));
    for (const day of days.slice(0, 2)) await w.run(w.make(), { today: day, altSource, fetchImpl });
    const t = w.make();
    const r = await w.run(t, { today: days[2], altSource, fetchImpl });
    assert.equal(r.stats.switched, 1);
    assert.equal(r.stats.downloaded, 1);
    assert.ok(r.tts.has("tt5"));
    assert.deepEqual(t.get("tt5").items.map((i) => i.poster), [`https://pages.test/posters/tt5.jpg?v=${V9}`, `https://pages.test/posters/tt5.jpg?v=${V9}`]);
    const st = stateOf(w);
    assert.deepEqual(st.items.tt5.switched, { from: "metahub", to: "tmdb", d: days[2] });
    assert.equal(st.items.tt5.kind, "tmdb");
    assert.equal(st.failures, undefined);
    // the next night it is simply an unchanged cover: no new look, no new download, no redraw
    w.fetched.length = 0; w.drawn.length = 0;
    const r2 = await w.run(w.make(), { today: days[3], altSource: async () => { throw new Error("must not be asked"); }, fetchImpl });
    assert.deepEqual(w.fetched, []);
    assert.deepEqual(w.drawn, []);
    assert.equal(r2.stats.unchanged, 4);
  } finally { w.done(); }
  // found, and it fails
  w = world();
  try {
    let n = 0;
    const altSource = async () => (n++, { url: "https://alt.test/tt5.jpg", kind: "tmdb" });
    const fetchImpl = spy(w, async () => reply(Buffer.alloc(0), 404));
    for (const day of days) await w.run(w.make(), { today: day, altSource, fetchImpl });
    assert.equal(n, 1);
    assert.deepEqual(stateOf(w).failures.tt5.alt, { d: days[2], found: true, kind: "tmdb", ok: false, code: "404" });
    // a look that throws is not recorded: it is repeated on the next try
    const w2 = world();
    try {
      let m = 0;
      const boom = async () => { m++; throw new Error("tmdb down"); };
      for (const day of days.slice(0, 4)) await w2.run(w2.make(), { today: day, altSource: boom });
      assert.equal(m, 2, "tries 3 and 4 each looked");
      assert.equal(stateOf(w2).failures.tt5.alt, undefined);
    } finally { w2.done(); }
  } finally { w.done(); }
});

test("B3: with no failure the state file has no `failures` key, so a night where all covers work changes nothing in it", async () => {
  const w = world();
  try {
    const t = w.make(); t.delete("tt5");
    await w.run(t, { today: "2026-10-10" });
    assert.deepEqual(Object.keys(stateOf(w)).sort(), ["items", "version"]);
    // a record of a film nobody asks for any more goes with the film after 21 days, not before
    await w.run(w.make(), { today: "2026-10-10" });
    assert.ok(stateOf(w).failures.tt5);
    const t2 = w.make(); t2.delete("tt5");
    await w.run(t2, { today: "2026-10-20" });
    assert.ok(stateOf(w).failures.tt5, "10 days: kept");
    await w.run(t2, { today: "2026-11-05" });
    assert.equal(stateOf(w).failures, undefined, "26 days and not asked for: dropped");
  } finally { w.done(); }
});

// ── the address changes when the drawing changes (Marco, 19/10/2026) ─────────
// Defect: "many films without the year and the flag on the cover", seen on the TV. The published covers have them (Tokyo Story, Shall We Dance?, Pulse were opened), so the TV kept the image
// it had from before 13/10, when every cover was drawn again with the year and the flag at the SAME address, posters/<tt>.jpg. The address is now posters/<tt>.jpg?v=<first 8 characters of the
// sha256 of the drawn JPEG> (Pages answers 200 to a query string): content, not date, so a cover drawn again with other bytes has a new address and one with the same bytes keeps its own.

const sha8 = (buf) => P.coverVersion(require("crypto").createHash("sha256").update(buf).digest("hex"));
const drawing = (seeds) => async (jobs) => { for (const j of jobs) fs.writeFileSync(j.out, Buffer.alloc(1500, seeds[j.tt] ?? 9)); return { drawn: jobs.length, failed: [] }; };

test("cover address: <base>/<tt>.jpg?v=<8 characters of the sha256 of the drawn JPEG>; with no version, the plain address", () => {
  assert.equal(P.coverVersion("0123456789abcdef0123"), "01234567");
  assert.equal(P.posterUrl("https://x.test/p/", "tt1", "01234567"), "https://x.test/p/tt1.jpg?v=01234567");
  assert.equal(P.posterUrl("https://x.test/p", "tt1", P.coverVersion("ffff0000ffff")), "https://x.test/p/tt1.jpg?v=ffff0000");
  assert.equal(P.posterUrl("https://x.test/p/", "tt1"), "https://x.test/p/tt1.jpg");
});

test("cover address: every item of a ready film carries the version of its own file, the result lists it, and a film with no cover has no address and no version", async () => {
  const w = world();
  try {
    const t = w.make();
    const r = await w.run(t, { render: drawing({ tt1: 1, tt2: 2, tt4: 4 }) });
    for (const [tt, seed] of [["tt1", 1], ["tt2", 2], ["tt4", 4]]) {
      const v = sha8(Buffer.alloc(1500, seed));
      assert.equal(v, sha8(fs.readFileSync(path.join(w.d.out, `${tt}.jpg`))), "the version is the one of the file that is published");
      assert.deepEqual(t.get(tt).items.map((i) => i.poster), Array(2).fill(`https://pages.test/posters/${tt}.jpg?v=${v}`));
      assert.equal(r.versions.get(tt), v);
    }
    assert.notEqual(r.versions.get("tt1"), r.versions.get("tt2"));
    assert.deepEqual(t.get("tt5").items.map((i) => i.poster), [null, null], "no cover anywhere: the original address, no ?v=");
    assert.ok(!r.versions.has("tt5") && !r.versions.has("tt3"));
    assert.ok(![...t.values()].flatMap((x) => x.items).some((i) => i.poster && !/\.jpg\?v=[0-9a-f]{8}$/.test(i.poster)), "no cover of Pages without its version");
  } finally { w.done(); }
});

test("cover address: the same cache gives the same address night after night (no new ?v= per night, whatever the date); a cover drawn again with other bytes gets a new one and no other cover does", async () => {
  const w = world();
  try {
    const seeds = { tt1: 1, tt2: 2, tt4: 4 };
    const first = await w.run(w.make(), { today: "2026-10-10", render: drawing(seeds) });
    for (const day of ["2026-10-11", "2026-10-17", "2026-10-31"]) {
      w.drawn.length = 0;
      const again = await w.run(w.make(), { today: day, render: drawing(seeds) });
      assert.equal(again.stats.unchanged, 3, `${day}: nothing redrawn`);
      assert.deepEqual([...again.versions], [...first.versions], `${day}: the same versions, so the same addresses`);
    }
    // a number that shows changes for tt2 and the drawing comes out different: only tt2 gets a new address
    const t = w.make();
    t.get("tt2").ratings.seenBy = 2;
    const changed = await w.run(t, { today: "2026-11-01", render: drawing({ ...seeds, tt2: 22 }) });
    assert.equal(changed.versions.get("tt2"), sha8(Buffer.alloc(1500, 22)));
    assert.notEqual(changed.versions.get("tt2"), first.versions.get("tt2"));
    assert.equal(changed.versions.get("tt1"), first.versions.get("tt1"));
    assert.equal(changed.versions.get("tt4"), first.versions.get("tt4"));
    assert.deepEqual(t.get("tt2").items.map((i) => i.poster), Array(2).fill(`https://pages.test/posters/tt2.jpg?v=${sha8(Buffer.alloc(1500, 22))}`));
    // a redrawing with the very same bytes keeps the address
    const same = w.make();
    same.get("tt2").ratings.seenBy = 3;
    const kept = await w.run(same, { today: "2026-11-02", render: drawing({ ...seeds, tt2: 22 }) });
    assert.equal(kept.stats.drawn, 1);
    assert.equal(kept.versions.get("tt2"), changed.versions.get("tt2"), "drawn again, same bytes: same address");
  } finally { w.done(); }
});

test("cover address: the plan-poster readers and verify.js take ?v= — the film's own cover is still recognised, a cover of another film still refused, a v that is not the file's drawing is reported", () => {
  const { indexIds, publishedIds } = require("../lib/learning/plan-posters");
  const own = (tt, q) => `https://marcogusmao.github.io/mood-engine/posters/${tt}.jpg${q}`;
  assert.deepEqual([...indexIds({ films: [{ tt: "tt1", poster: own("tt1", "?v=0123abcd") }, { tt: "tt2", poster: own("tt2", "") }, { tt: "tt3" }] })].sort(), ["tt1", "tt2"]);
  assert.throws(() => indexIds({ films: [{ tt: "tt1", poster: own("tt2", "?v=0123abcd") }] }), /Poster identity mismatch/);
  assert.deepEqual([...indexIds({ films: [{ tt: "tt1", poster: own("tt1", "?v=zzzz") }] })], [], "a query that is not a version is not one of our covers");
  const plan = { board: [{ id: "r", name: "R", items: [{ id: "tt1", poster: own("tt1", "?v=0123abcd") }] }], discover: [] };
  assert.ok(publishedIds(plan).has("tt1"));

  const { verifyDir } = require("../verify");
  const dir = tmp("mood-verify-v-");
  try {
    fs.mkdirSync(path.join(dir, "catalog", "movie"), { recursive: true });
    fs.mkdirSync(path.join(dir, "posters"));
    const jpg = Buffer.alloc(5000, 1);
    fs.writeFileSync(path.join(dir, "posters", "tt0000001.jpg"), jpg);
    fs.writeFileSync(path.join(dir, "posters", "tt0000002.jpg"), Buffer.alloc(5000, 2));
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id: "x", version: "2.1.0", catalogs: [{ type: "movie", id: "row", name: "Row" }] }));
    const pages = "https://marcogusmao.github.io/mood-engine/posters/";
    const metas = [
      { id: "tt0000001", name: "Own version", poster: `${pages}tt0000001.jpg?v=${sha8(jpg)}` },
      { id: "tt0000002", name: "Old version", poster: `${pages}tt0000002.jpg?v=${sha8(jpg)}` },
    ];
    fs.writeFileSync(path.join(dir, "catalog", "movie", "row.json"), JSON.stringify({ metas }));
    const v = verifyDir(dir);
    assert.equal(v.covers, 2, "both files exist and are the films' own");
    assert.equal(v.problems.length, 1, v.problems.join("\n"));
    assert.match(v.problems[0], /tt0000002 \(Old version\) tt0000002: the address says v=[0-9a-f]{8} but posters\/tt0000002\.jpg is the drawing [0-9a-f]{8}/);
  } finally { rm(dir); }
});

// ── year and flag on the cover (v2.2) ────────────────────────────────────────

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]);

/** Like world(), but with the flags: dir.flags holds us.png; flagcdn answers for jp and br, and for "zz" only once `net.zz` is true. */
function flagWorld() {
  const dir = tmp("mood-flagcovers-");
  const d = { raw: path.join(dir, "raw"), out: path.join(dir, "out"), state: path.join(dir, "posters.json"), flags: path.join(dir, "flags") };
  fs.mkdirSync(d.flags);
  fs.writeFileSync(path.join(d.flags, "us.png"), PNG);
  const net = { zz: false, flagUrls: [], unreadable: 0 };
  const jobs = [];
  const fetchImpl = async (url) => {
    const m = url.match(/flagcdn\.com\/w80\/(\w+)\.png/);
    if (m) { net.flagUrls.push(m[1]); return m[1] === "zz" && !net.zz ? reply(Buffer.alloc(0), 404) : reply(PNG); }
    return reply(JPEG);
  };
  const render = async (list) => { jobs.push(...list.map((j) => ({ ...j }))); for (const j of list) fs.writeFileSync(j.out, Buffer.alloc(1500, 9)); return { drawn: list.length, failed: [], flagFailed: net.unreadable }; };
  const make = (over = {}) => {
    const t = (tt, year, cc) => ({ tt, tmdbPoster: null, year, cc, ratings: R({ lb: 4.1 }), items: [{ id: tt, poster: null }], ...over[tt] });
    return new Map([t("tt1", 1957, "us"), t("tt2", 2002, "jp"), t("tt3", 1999, "zz"), t("tt4", 2010, null), t("tt5", null, "us")].map((x) => [x.tt, x]));
  };
  const run = (targets, o = {}) => P.drawCovers({ targets, dir: d, base: "https://pages.test/posters/", today: "2026-10-10", fetchImpl, render, version: "v1", sleepImpl: noSleep, ...o });
  return { dir, d, net, jobs, make, run, done: () => rm(dir) };
}

test("covers, v2.2: each job carries its film's year and the path of its flag; a flag that is not in cache/flags is downloaded once; one that cannot be gets the year alone and is counted", async () => {
  const w = flagWorld();
  try {
    const r = await w.run(w.make());
    const job = (tt) => w.jobs.find((j) => j.tt === tt);
    assert.deepEqual([job("tt1").year, job("tt1").flag], [1957, path.join(w.d.flags, "us.png")]); // already in the folder
    assert.deepEqual([job("tt2").year, job("tt2").flag], [2002, path.join(w.d.flags, "jp.png")]); // downloaded tonight
    assert.deepEqual([job("tt3").year, job("tt3").flag], [1999, null]); // flagcdn said 404
    assert.deepEqual([job("tt4").year, job("tt4").flag], [2010, null]); // no country known
    assert.deepEqual([job("tt5").year, job("tt5").flag], [null, path.join(w.d.flags, "us.png")]); // no year, only the flag
    assert.deepEqual(w.net.flagUrls.sort(), ["jp", "zz"]); // us was there: not asked for again
    assert.ok(fs.existsSync(path.join(w.d.flags, "jp.png")) && !fs.existsSync(path.join(w.d.flags, "zz.png")));
    assert.deepEqual([r.stats.withFlag, r.stats.flagMissing, r.stats.noCountry, r.stats.flagsDownloaded, r.stats.flagsFailed], [3, 1, 1, 1, 1]);
    assert.equal(r.stats.drawn, 5); // a cover with the year alone is still a cover
  } finally { w.done(); }
});

test("covers, v2.2: tomorrow nothing is redrawn; a flag that was missing and now exists, a new year and a new country each redraw that one cover and no other", async () => {
  const w = flagWorld();
  try {
    await w.run(w.make());
    w.jobs.length = 0;
    const same = await w.run(w.make());
    assert.deepEqual(w.jobs, []);
    assert.equal(same.stats.unchanged, 5);
    w.net.zz = true; // the flag for tt3 can be downloaded now
    await w.run(w.make());
    assert.deepEqual(w.jobs.map((j) => [j.tt, j.flag && path.basename(j.flag)]), [["tt3", "zz.png"]]);
    w.jobs.length = 0;
    await w.run(w.make({ tt1: { year: 1958 } })); // the year changed
    assert.deepEqual(w.jobs.map((j) => [j.tt, j.year]), [["tt1", 1958]]);
    w.jobs.length = 0;
    await w.run(w.make({ tt1: { year: 1958 }, tt2: { cc: "br" } })); // tt2 turned out Brazilian
    assert.deepEqual(w.jobs.map((j) => [j.tt, path.basename(j.flag)]), [["tt2", "br.png"]]);
    w.jobs.length = 0;
    await w.run(w.make({ tt1: { year: 1958 }, tt2: { cc: "br" }, tt4: { cc: "us" } })); // tt4 was unknown and is now American
    assert.deepEqual(w.jobs.map((j) => [j.tt, path.basename(j.flag)]), [["tt4", "us.png"]]);
    w.jobs.length = 0;
    await w.run(w.make({ tt1: { year: 1958 }, tt2: { cc: "br" }, tt4: { cc: "us" }, tt5: { ccFrom: "language" } })); // v2.3: tt5 now has its flag by the film's language: same flag, drawn again once
    assert.deepEqual(w.jobs.map((j) => [j.tt, path.basename(j.flag)]), [["tt5", "us.png"]]);
    w.jobs.length = 0;
    const calm = await w.run(w.make({ tt1: { year: 1958 }, tt2: { cc: "br" }, tt4: { cc: "us" }, tt5: { ccFrom: "language" } }));
    assert.deepEqual(w.jobs, []);
    assert.equal(calm.stats.unchanged, 5);
  } finally { w.done(); }
});

test("covers, v2.2: --cache-only downloads no flag and creates no folder; the drawing's own count of flags it could not read is carried into the stats", async () => {
  const w = flagWorld();
  try {
    fs.rmSync(w.d.flags, { recursive: true });
    fs.mkdirSync(w.d.raw); fs.mkdirSync(w.d.out); // --cache-only draws from the raw covers on disk
    for (const tt of ["tt1", "tt2", "tt3", "tt4", "tt5"]) fs.writeFileSync(path.join(w.d.raw, `${tt}.jpg`), JPEG);
    const r = await w.run(w.make(), { cacheOnly: true });
    assert.deepEqual(w.net.flagUrls, []);
    assert.ok(!fs.existsSync(w.d.flags));
    assert.deepEqual(w.jobs.map((j) => j.flag), [null, null, null, null, null]); // no flag on disk: every cover gets the year alone
    assert.deepEqual([r.stats.flagMissing, r.stats.noCountry, r.stats.withFlag, r.stats.drawn], [4, 1, 0, 5]); // tt4 has no country; the other four have one and no picture
  } finally { w.done(); }
  const w2 = flagWorld();
  try {
    w2.net.unreadable = 2;
    assert.equal((await w2.run(w2.make())).stats.flagUnreadable, 2);
  } finally { w2.done(); }
});

// ── the real drawing ─────────────────────────────────────────────────────────

test("renderWithPython: draws real covers through tools/selo/render.py (342 px wide), and a job whose cover is missing is reported, not fatal", { skip: !hasPillow && "python3 with Pillow is not installed" }, async () => {
  const dir = tmp();
  try {
    const raw = path.join(dir, "raw.png");
    assert.equal(spawnSync("python3", ["-c", `from PIL import Image; Image.new("RGB", (500, 750), (90, 120, 150)).save(${JSON.stringify(raw)})`]).status, 0);
    const jobs = [
      { tt: "tt1", raw, out: path.join(dir, "o1.jpg"), lb: 4.3, imdb: 7.3, amigos: 4.5, viram: 3, querem: 5 },
      { tt: "tt2", raw, out: path.join(dir, "o2.jpg"), imdb: 6.1 },
      { tt: "tt3", raw: path.join(dir, "missing.jpg"), out: path.join(dir, "o3.jpg"), lb: 3 },
    ];
    const res = await P.renderWithPython(jobs, { workers: 1, tmpDir: dir });
    assert.equal(res.drawn, 2);
    assert.deepEqual(res.failed.map((f) => f.tt), ["tt3"]);
    assert.match(res.failed[0].error, /FileNotFoundError|No such file/);
    const size = spawnSync("python3", ["-c", `from PIL import Image; print(*Image.open(${JSON.stringify(path.join(dir, "o1.jpg"))}).size)`], { encoding: "utf8" }).stdout.trim();
    assert.equal(size, "342 513");
    assert.ok(!fs.existsSync(path.join(dir, "o3.jpg")));
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".tmp.")), [], "no temp file is left behind");
  } finally { rm(dir); }
});

test("renderWithPython, v2.2: the year and the flag land in the top-left pill (a real flag from cache/flags); a flag that cannot be read still gives a cover with the year, and is counted", { skip: (!hasPillow && "python3 with Pillow is not installed") || (!fs.existsSync(path.join(ROOT, "cache", "flags", "jp.png")) && "no cache/flags") }, async () => {
  const dir = tmp();
  try {
    const raw = path.join(dir, "raw.png");
    assert.equal(spawnSync("python3", ["-c", `from PIL import Image; Image.new("RGB", (500, 750), (200, 200, 200)).save(${JSON.stringify(raw)})`]).status, 0);
    const jobs = [
      { tt: "tt1", raw, out: path.join(dir, "o1.jpg"), imdb: 7.3, year: 1954, flag: path.join(ROOT, "cache", "flags", "jp.png") },
      { tt: "tt2", raw, out: path.join(dir, "o2.jpg"), imdb: 7.3, year: 1954, flag: path.join(dir, "gone.png") },
      { tt: "tt3", raw, out: path.join(dir, "o3.jpg"), imdb: 7.3 },
    ];
    const res = await P.renderWithPython(jobs, { workers: 1, tmpDir: dir });
    assert.deepEqual([res.drawn, res.failed, res.flagFailed], [3, [], 1]);
    const probe = (f, code) => spawnSync("python3", ["-c", `from PIL import Image\nim = Image.open(${JSON.stringify(path.join(dir, f))}).convert("RGB")\n${code}`], { encoding: "utf8" }).stdout.trim();
    // the pill is dark at the corner; Japan's red disc is inside it; the year alone has no red
    assert.equal(probe("o1.jpg", "print(sum(im.getpixel((13, 25))) < 150)"), "True");
    assert.equal(probe("o1.jpg", "print(any(abs(p[0] - 188) < 45 and p[1] < 60 and p[2] < 90 for p in (im.getpixel((x, y)) for x in range(10, 50) for y in range(10, 40))))"), "True");
    assert.equal(probe("o2.jpg", "print(any(abs(p[0] - 188) < 45 and p[1] < 60 and p[2] < 90 for p in (im.getpixel((x, y)) for x in range(10, 50) for y in range(10, 40))))"), "False");
    assert.equal(probe("o2.jpg", "print(sum(im.getpixel((13, 25))) < 150)"), "True");
    assert.equal(probe("o3.jpg", "print(sum(im.getpixel((13, 25))) > 500)"), "True"); // no year, no pill
  } finally { rm(dir); }
});

test("renderWithPython: no Pillow or no Python is a failed result for every job, not an exception", async () => {
  const dir = tmp();
  try {
    const res = await P.renderWithPython([{ tt: "tt1", raw: "x", out: "y" }], { python: "python3-that-does-not-exist", tmpDir: dir });
    assert.equal(res.drawn, 0);
    assert.match(res.failed[0].error, /cannot run python3-that-does-not-exist/);
  } finally { rm(dir); }
});

test("tools/selo/render.py --self-test: 5 sample covers in /tmp — size, strip, the three badges, the top-left year and flag, and the corners", { skip: !hasPillow && "python3 with Pillow is not installed" }, () => {
  const r = spawnSync("python3", [path.join(ROOT, "tools", "selo", "render.py"), "--self-test"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /self-test: 5 covers drawn in \/tmp\/mood-selo-selftest/);
  assert.ok(["all.jpg", "year-only.jpg", "bad-flag.jpg", "imdb-only.jpg", "nothing.jpg"].every((f) => fs.existsSync(path.join("/tmp/mood-selo-selftest", f))));
});

// ── verify.js ────────────────────────────────────────────────────────────────

test("verify.js: every poster is a valid http(s) address; a cover on Pages must be the film's own and exist, not empty; imdbRating looks like 7.3", () => {
  const { verifyDir } = require("../verify");
  const dir = tmp("mood-verify-");
  try {
    fs.mkdirSync(path.join(dir, "catalog", "movie"), { recursive: true });
    fs.mkdirSync(path.join(dir, "posters"));
    fs.writeFileSync(path.join(dir, "posters", "tt0000001.jpg"), Buffer.alloc(5000, 1));
    fs.writeFileSync(path.join(dir, "posters", "tt0000005.jpg"), Buffer.alloc(10, 1)); // an empty (broken) file
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id: "x", version: "2.1.0", catalogs: [{ type: "movie", id: "row", name: "Row" }] }));
    const pages = "https://marcogusmao.github.io/mood-engine/posters/";
    const metas = [
      { id: "tt0000001", name: "Good cover", poster: `${pages}tt0000001.jpg`, imdbRating: "7.3" },
      { id: "tt0000002", name: "Metahub", poster: "https://images.metahub.space/poster/medium/tt0000002/img" },
      { id: "tt0000003", name: "Missing file", poster: `${pages}tt0000003.jpg` },
      { id: "tt0000004", name: "Somebody else's", poster: `${pages}tt0000001.jpg` },
      { id: "tt0000005", name: "Broken file", poster: `${pages}tt0000005.jpg` },
      { id: "tt0000006", name: "Not a url", poster: "/abc.jpg" },
      { id: "tt0000007", name: "No poster" },
      { id: "tt0000008", name: "Bad rating", poster: "https://x.test/p.jpg", imdbRating: "7,3" },
    ];
    fs.writeFileSync(path.join(dir, "catalog", "movie", "row.json"), JSON.stringify({ metas }));
    const v = verifyDir(dir);
    assert.equal(v.ok, false);
    assert.equal(v.covers, 1); // one distinct cover file that exists (the good one; "somebody else's" points at the same file)
    const text = v.problems.join("\n");
    assert.match(text, /tt0000003 \(Missing file\) points at posters\/tt0000003\.jpg, which is missing/);
    assert.match(text, /tt0000004 \(Somebody else's\) shows the cover of tt0000001/);
    assert.match(text, /tt0000005 \(Broken file\) points at posters\/tt0000005\.jpg, which is empty/);
    assert.match(text, /tt0000006 \(Not a url\) has poster "\/abc\.jpg", not an http\(s\) address/);
    assert.match(text, /tt0000007 \(No poster\) has poster undefined/);
    assert.match(text, /tt0000008 \(Bad rating\) has imdbRating "7,3"/);
    assert.ok(!/tt0000001 \(Good cover\)|tt0000002/.test(text), "the good ones are not reported");
    assert.equal(v.problems.length, 6);
  } finally { rm(dir); }
});
