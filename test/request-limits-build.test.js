// node --test
// The five outside requests of the build that had no deadline and no byte cap after v24-hardening gave them to TMDB and Letterboxd (13/10/2026):
//   letterboxdRss  lib/letterboxd.js fetchRss        diary RSS            (text)
//   boxd           lib/lists.js resolveBoxd          boxd.it redirect     (headers only; the body is cancelled, never read)
//   imdbDump       lib/posters.js downloadImdb       ratings .tsv.gz      (bytes, 200 MB)
//   coverImage     lib/posters.js fetchImage         raw covers           (bytes, 5 MB)
//   flag           lib/countries.js fetchFlag        flag PNGs            (bytes, 1 MB)
// Each: (a) an answer that never comes, or a body that starts and never ends, fails inside the deadline; (b) a body past the cap is a LimitError
// "too-large" and is NOT tried again; (c) the log has a line with `limit hit <site>` (so that a person reading the night's log can search for it;
// nothing searches it automatically). TMDB and Letterboxd write the same line for every try they cut. Also here: the per-host breaker of the covers,
// the cap on what the IMDb dump inflates to, the guard of build.js on config.json "limits", and the summary line at the end of the build.
// Deadlines are made short by changing LIMITS in the test and putting it back. No test here touches the network: every fetch is a local fake.

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const U = require("../lib/util");
const { LIMITS, LimitError } = U;
const { fetchRss } = require("../lib/letterboxd");
const L = require("../lib/lists");
const P = require("../lib/posters");
const C = require("../lib/countries");
const { Tmdb } = require("../lib/tmdb");
const F = require("../lib/friends");

const noSleep = async () => {};
const never = () => new Promise(() => {}); // a server that accepts the connection and never answers
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(200, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(3000, 2)]);
const TSV = "tconst\taverageRating\tnumVotes\ntt0000001\t5.7\t2000\n";
const timers = () => process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;

/** A response whose body is a stream of `n` chunks of `size` bytes; `pulled` counts the chunks actually read, `cancelled` the stream given back. */
function streamed(n, size, { length = null, status = 200, ok = true, extra = {} } = {}) {
  const box = { pulled: 0, cancelled: false };
  const body = new ReadableStream({
    pull(c) { if (box.pulled >= n) return c.close(); box.pulled++; c.enqueue(new Uint8Array(size).fill(32)); },
    cancel() { box.cancelled = true; },
  }, { highWaterMark: 0 });
  box.res = { status, ok, headers: { get: (h) => (String(h).toLowerCase() === "content-length" ? length : null) }, body, ...extra };
  return box;
}
/** A 200 whose body sends a few bytes and then never ends. */
const stuckBody = () => ({ status: 200, ok: true, headers: { get: () => null }, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); } }) });

/** Runs fn with LIMITS patched ({ site: { timeoutMs, maxBytes } }), puts every value back, resets the hit counters. */
async function withLimits(patch, fn) {
  const saved = JSON.parse(JSON.stringify(LIMITS));
  for (const [site, o] of Object.entries(patch)) Object.assign(LIMITS[site], o);
  U.resetLimitHits();
  try { return await fn(); } finally { for (const site of Object.keys(LIMITS)) { for (const k of Object.keys(LIMITS[site])) delete LIMITS[site][k]; Object.assign(LIMITS[site], saved[site]); } U.resetLimitHits(); }
}
const isLimit = (code, site) => (e) => e instanceof LimitError && e.code === code && e.site === site && e.message.startsWith(`limit hit ${site}: `);

test("LIMITS: the numbers of v24-hardening are kept (TMDB 30 s / 10 MB, Letterboxd 45 s / 20 MB) and the five new sites have theirs; the modules read them from here", async () => {
  assert.deepEqual(LIMITS.tmdb, { timeoutMs: 30000, maxBytes: 10 * 1024 * 1024 });
  assert.deepEqual(LIMITS.letterboxd, { timeoutMs: 45000, maxBytes: 20 * 1024 * 1024 });
  assert.deepEqual(LIMITS.letterboxdRss, { timeoutMs: 30000, maxBytes: 5 * 1024 * 1024 });
  assert.deepEqual(LIMITS.boxd, { timeoutMs: 30000 });
  assert.deepEqual(LIMITS.imdbDump, { timeoutMs: 120000, maxBytes: 200 * 1024 * 1024, maxInflatedBytes: 1024 * 1024 * 1024 });
  assert.deepEqual(LIMITS.coverImage, { timeoutMs: 30000, maxBytes: 5 * 1024 * 1024 });
  assert.deepEqual(LIMITS.flag, { timeoutMs: 20000, maxBytes: 1024 * 1024 });
  assert.deepEqual(LIMITS.wikidata, { timeoutMs: 60000, maxBytes: 20 * 1024 * 1024 }); // 23/10/2026: lib/directors.js, the director's citizenship; the summary line below has its site since then
  // a change in LIMITS reaches the TMDB client and the Letterboxd client built afterwards (the override of config.json does this before the build asks anything)
  await withLimits({ tmdb: { timeoutMs: 123, maxBytes: 456 }, letterboxd: { timeoutMs: 21 } }, async () => {
    const prev = process.env.OFFLINE; delete process.env.OFFLINE;
    try {
      const t = new Tmdb("v3key", require("path").join(require("os").tmpdir(), `me-lim-${process.pid}.json`), { fetchImpl: async () => { throw new Error("no"); }, sleepImpl: noSleep });
      assert.equal(t.timeoutMs, 123); assert.equal(t.maxBytes, 456);
    } finally { if (prev !== undefined) process.env.OFFLINE = prev; }
    const slow = F.makeHttp({ fetchImpl: () => never(), sleepImpl: noSleep, retries: 0, log: () => {} });
    await assert.rejects(slow.get("https://letterboxd.com/film/q/"), /last limit hit: no complete answer in 21 ms/);
  });
});

test("applyLimits: config.json limits override the defaults; a wrong site, a wrong key or a value that is not a positive whole number stops the build", async () => {
  await withLimits({}, async () => {
    U.applyLimits(undefined); U.applyLimits(null); // no key in config.json: nothing changes
    assert.equal(LIMITS.imdbDump.timeoutMs, 120000);
    U.applyLimits({ imdbDump: { timeoutMs: 90000 }, flag: { maxBytes: 2048 } });
    assert.deepEqual(LIMITS.imdbDump, { timeoutMs: 90000, maxBytes: 200 * 1024 * 1024, maxInflatedBytes: 1024 * 1024 * 1024 }, "a key not named keeps its value");
    assert.equal(LIMITS.flag.maxBytes, 2048);
    for (const bad of [{ imdb: { timeoutMs: 1 } }, { flag: { timeout: 1 } }, { flag: { maxBytes: 0 } }, { flag: { maxBytes: -5 } }, { flag: { maxBytes: 1.5 } }, { flag: { maxBytes: "9" } }, { boxd: { maxBytes: 5 } }, { flag: { timeoutMs: 2147483648 } }, { tmdb: { timeoutMs: 1e12 } }, { imdbDump: { maxInflatedBytes: 2 ** 53 } }, { flag: { maxBytes: 1e15 } }, { flag: 7 }, [], "x", { __proto__: null, constructor: { timeoutMs: 1 } }])
      assert.throws(() => U.applyLimits(bad), /config\.json "limits/, JSON.stringify(bad));
    U.applyLimits({ tmdb: { timeoutMs: 2147483647 }, imdbDump: { maxInflatedBytes: 5000 } }); // the largest timer Node honours, and the inflated cap, are accepted
    assert.equal(LIMITS.tmdb.timeoutMs, 2147483647);
    assert.equal(LIMITS.imdbDump.maxInflatedBytes, 5000);
    const before = JSON.stringify(LIMITS);
    assert.throws(() => U.applyLimits({ flag: { maxBytes: 99 }, imdb: {} }), /not a request site/);
    assert.equal(JSON.stringify(LIMITS), before, "a config with one wrong entry changes nothing");
  });
});

test("readCappedBytes: the cap is exact for a stream, a declared length, arrayBuffer() and text(); a stream is cancelled at the cap", async () => {
  const stream = (n, chunk) => new ReadableStream({ start(c) { for (let i = 0; i < n; i += chunk) c.enqueue(new Uint8Array(Math.min(chunk, n - i)).fill(97)); c.close(); } });
  const res = (n, length = null) => ({ headers: { get: (h) => (h === "content-length" ? length : null) }, body: stream(n, 4) });
  const ok = await U.readCappedBytes(res(10), 10);
  assert.ok(Buffer.isBuffer(ok) && ok.length === 10);
  await assert.rejects(U.readCappedBytes(res(11), 10), (e) => e instanceof LimitError && e.code === "too-large");
  assert.equal((await U.readCappedBytes(res(10, "10"), 10)).length, 10);
  await assert.rejects(U.readCappedBytes(res(10, "11"), 10), /larger than 10 bytes \(11\)/);
  const viaBuffer = (n) => ({ arrayBuffer: async () => Buffer.alloc(n, 1) }); // the tests' fakes: no headers, no stream
  assert.equal((await U.readCappedBytes(viaBuffer(10), 10)).length, 10);
  await assert.rejects(U.readCappedBytes(viaBuffer(11), 10), (e) => e.code === "too-large");
  assert.equal((await U.readCappedBytes({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }, 10)).length, 3, "a real ArrayBuffer is accepted");
  await assert.rejects(U.readCappedBytes({ text: async () => "a".repeat(11) }, 10), (e) => e.code === "too-large");
  const big = streamed(1000, 1024);
  await assert.rejects(U.readCappedBytes(big.res, 4096), (e) => e.code === "too-large");
  assert.ok(big.pulled <= 6 && big.cancelled, `pulled ${big.pulled} chunks of 1 KB with a cap of 4 KB, then gave the stream back`);
  // bytes are bytes: a binary body is not decoded or altered
  const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0xfe]);
  assert.deepEqual(await U.readCappedBytes({ headers: { get: () => null }, body: new ReadableStream({ start(c) { c.enqueue(bin.subarray(0, 3)); c.enqueue(bin.subarray(3)); c.close(); } }) }, 100), bin);
});

test("limitedFetch: a limit hit says `limit hit <site>`, is logged for the first 10 only and counted for all, and the deadline's timer is cleared", async () => {
  await withLimits({ flag: { timeoutMs: 15 } }, async () => {
    const lines = [], t0 = timers();
    for (let i = 0; i < 12; i++) await assert.rejects(U.limitedFetch("flag", () => never(), "https://x.test/", {}, { log: (l) => lines.push(l) }), isLimit("timeout", "flag"));
    assert.equal(lines.length, 10);
    assert.ok(lines.every((l) => /limit hit flag: no complete answer in 15 ms/.test(l)));
    assert.equal(U.limitHits.flag, 12);
    assert.equal(timers(), t0, "the deadline's timer is cleared when the try ends");
    const fine = await U.limitedFetch("flag", async () => ({ status: 200, ok: true, arrayBuffer: async () => PNG }), "u", {}, {});
    assert.equal(fine.body.length, PNG.length);
    assert.equal(timers(), t0);
  });
});

// ── letterboxdRss ────────────────────────────────────────────────────────────

const RSS = `<item><letterboxd:filmTitle>A</letterboxd:filmTitle><letterboxd:filmYear>2000</letterboxd:filmYear></item>`;
const rssReply = (text) => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => text });

test("letterboxdRss: a feed that never answers, or never ends its body, is given up inside the deadline; the build goes on with the export (returns [])", async () => {
  await withLimits({ letterboxdRss: { timeoutMs: 25 } }, async () => {
    const signals = [], lines = [];
    const t0 = Date.now();
    assert.deepEqual(await fetchRss("marco", { fetchImpl: (u, init) => { signals.push(init.signal); return never(); }, log: (l) => lines.push(l) }), []);
    assert.ok(Date.now() - t0 < 3000);
    assert.ok(signals[0] instanceof AbortSignal && signals[0].aborted, "the deadline aborts the request it was given to");
    assert.deepEqual(await fetchRss("marco", { fetchImpl: async () => stuckBody(), log: (l) => lines.push(l) }), []);
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => /limit hit letterboxdRss: no complete answer in 25 ms/.test(l)), lines.join("\n"));
    assert.equal(U.limitHits.letterboxdRss, 2);
  });
});

test("letterboxdRss: a feed past the cap is refused while it is read (not read whole) and logged as a limit hit; one under the cap is parsed as before", async () => {
  await withLimits({ letterboxdRss: { maxBytes: 4096 } }, async () => {
    const lines = [], box = streamed(1000, 1024);
    assert.deepEqual(await fetchRss("marco", { fetchImpl: async () => box.res, log: (l) => lines.push(l) }), []);
    assert.ok(box.pulled <= 6 && box.cancelled, `pulled ${box.pulled}`);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Letterboxd RSS unavailable \(limit hit letterboxdRss: answer larger than 4096 bytes\)/);
    const declared = streamed(1, 10, { length: "999999" });
    assert.deepEqual(await fetchRss("marco", { fetchImpl: async () => declared.res, log: (l) => lines.push(l) }), []);
    assert.ok(declared.pulled === 0 && declared.cancelled, "a declared Content-Length past the cap is refused before any byte is read");
    assert.equal((await fetchRss("marco", { fetchImpl: async () => rssReply(RSS), log: () => assert.fail("no limit hit") })).length, 1);
    // the URL asked is the user's feed, with the user name encoded
    let asked;
    await fetchRss("a b", { fetchImpl: async (u) => (asked = u, rssReply(RSS)) });
    assert.equal(asked, "https://letterboxd.com/a%20b/rss/");
  });
});

// ── boxd ─────────────────────────────────────────────────────────────────────

const redirect = (loc, extra = {}) => ({ status: 301, url: "https://boxd.it/x", headers: { get: (h) => (h.toLowerCase() === "location" ? loc : null) }, ...extra });

test("boxd: a boxd.it that never answers fails inside the deadline with `limit hit boxd`, and the request is given an abort signal", async () => {
  await withLimits({ boxd: { timeoutMs: 25 } }, async () => {
    const signals = [], lines = [];
    const t0 = Date.now();
    await assert.rejects(L.resolveBoxd("nVqt6", { fetchImpl: (u, init) => { signals.push(init.signal); return never(); }, log: (l) => lines.push(l) }), isLimit("timeout", "boxd"));
    assert.ok(Date.now() - t0 < 3000);
    assert.ok(signals[0].aborted);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /limit hit boxd: no complete answer in 25 ms/);
    // the redirect is still asked for with redirect: "manual"
    let init;
    await L.resolveBoxd("nVqt6", { fetchImpl: async (u, i) => (init = i, redirect("https://letterboxd.com/a/list/b/")) });
    assert.equal(init.redirect, "manual");
  });
});

test("boxd: the body of the redirect is never read, whatever its size: the stream is given back unread, and the list address still comes out", async () => {
  await withLimits({}, async () => {
    const box = streamed(100000, 1024, { status: 301, ok: false, extra: { headers: { get: (h) => (h.toLowerCase() === "location" ? "https://letterboxd.com/official/list/top-250/" : "9999999999") } } });
    assert.equal(await L.resolveBoxd("nVqt6", { fetchImpl: async () => box.res }), "https://letterboxd.com/official/list/top-250/");
    assert.equal(box.pulled, 0);
    assert.ok(box.cancelled, "the body is cancelled, not left to download");
    // an answer that is ok (a 200 with no Location, whose address is the page) is no different: its body is not read either
    const ok200 = streamed(100000, 1024, { extra: { url: "https://letterboxd.com/official/list/top-250/" } });
    assert.equal(await L.resolveBoxd("nVqt6", { fetchImpl: async () => ok200.res }), "https://letterboxd.com/official/list/top-250/");
    assert.equal(ok200.pulled, 0);
    assert.ok(ok200.cancelled);
    // a redirect with no Location whose body never ends is still answered (the error names the missing redirect), inside the deadline
    const t0 = timers();
    await assert.rejects(L.resolveBoxd("abc", { fetchImpl: async () => redirect(null, { body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4)); } }) }) }), /no redirect location/);
    assert.equal(timers(), t0, "the deadline's timer is cleared");
  });
});

test("boxd: refreshLists puts a limit hit in `problems` and carries on with the other lists", async () => {
  await withLimits({}, async () => {
    const dir = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "me-boxd-"));
    const file = require("path").join(dir, "lists.json");
    const cfg = { lists: [{ id: "aaaa", name: "Hung list" }] };
    const http = { get: async () => ({ status: 404, text: "", url: "" }) };
    const resolve = (id) => L.resolveBoxd(id, { fetchImpl: () => never(), log: () => {} });
    LIMITS.boxd.timeoutMs = 20;
    const r = await L.refreshLists({ cfg, file, http, resolve, sleepImpl: noSleep, gapMs: 0, log: () => {} });
    assert.ok(r.problems.some((p) => /Hung list/.test(p) && /limit hit boxd/.test(p)), JSON.stringify(r.problems));
  });
});

// ── imdbDump ─────────────────────────────────────────────────────────────────

const gz = () => zlib.gzipSync(TSV);

test("imdbDump: a dump that never answers is tried again each time inside the deadline and then fails; a body that never ends is cut too", async () => {
  await withLimits({ imdbDump: { timeoutMs: 25 } }, async () => {
    let n = 0; const signals = [], lines = [];
    const t0 = Date.now();
    await assert.rejects(P.downloadImdb({ fetchImpl: (u, init) => { n++; signals.push(init.signal); return never(); }, sleepImpl: noSleep, retries: 2, log: (l) => lines.push(l) }), isLimit("timeout", "imdbDump"));
    assert.ok(Date.now() - t0 < 3000);
    assert.equal(n, 3, "a deadline is a failed try: the usual retries");
    assert.ok(signals.every((s) => s.aborted));
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => /limit hit imdbDump: no complete answer in 25 ms/.test(l)));
    n = 0;
    await assert.rejects(P.downloadImdb({ fetchImpl: async () => (n++, stuckBody()), sleepImpl: noSleep, retries: 1, log: () => {} }), isLimit("timeout", "imdbDump"));
    assert.equal(n, 2);
  });
});

test("imdbDump: a file past the cap fails at once with too-large (one request, no retry, the stream given back); loadImdbRatings logs it and keeps yesterday's cache", async () => {
  await withLimits({ imdbDump: { maxBytes: 4096 } }, async () => {
    const boxes = [], lines = [];
    const fetchImpl = async () => { const b = streamed(100000, 1024); boxes.push(b); return b.res; };
    await assert.rejects(P.downloadImdb({ fetchImpl, sleepImpl: async () => assert.fail("a too-large file is not retried"), retries: 3, log: (l) => lines.push(l) }), isLimit("too-large", "imdbDump"));
    assert.equal(boxes.length, 1);
    assert.ok(boxes[0].pulled <= 6 && boxes[0].cancelled, `pulled ${boxes[0].pulled}`);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /limit hit imdbDump: answer larger than 4096 bytes/);
    // declared length
    const declared = streamed(1, 10, { length: "999999" });
    await assert.rejects(P.downloadImdb({ fetchImpl: async () => declared.res, sleepImpl: noSleep, log: () => {} }), isLimit("too-large", "imdbDump"));
    assert.equal(declared.pulled, 0);
    // the step: the night goes on with the cache of the day before
    const dir = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "me-imdb-"));
    const file = require("path").join(dir, "imdb-ratings.json");
    require("fs").writeFileSync(file, JSON.stringify({ version: 1, date: "2026-10-12", ratings: { tt0000001: [5.1, 10] }, none: [] }));
    const log = [];
    const r = await P.loadImdbRatings({ file, wanted: new Set(["tt0000001"]), today: "2026-10-13", fetchImpl, sleepImpl: noSleep, log: (l) => log.push(l) });
    assert.equal(r.source, "stale cache");
    assert.equal(r.map.get("tt0000001"), 5.1);
    assert.ok(log.some((l) => /IMDb ratings: limit hit imdbDump/.test(l)), log.join("\n"));
  });
});

test("imdbDump: the real dump is far under 200 MB and still downloads; a file of exactly the cap passes", async () => {
  await withLimits({}, async () => {
    const d = await P.downloadImdb({ fetchImpl: async () => ({ status: 200, ok: true, arrayBuffer: async () => gz() }), sleepImpl: noSleep });
    assert.equal(d.text, TSV);
    LIMITS.imdbDump.maxBytes = gz().length;
    assert.equal((await P.downloadImdb({ fetchImpl: async () => ({ status: 200, ok: true, arrayBuffer: async () => gz() }), sleepImpl: noSleep })).bytes, gz().length);
    LIMITS.imdbDump.maxBytes = gz().length - 1;
    await assert.rejects(P.downloadImdb({ fetchImpl: async () => ({ status: 200, ok: true, arrayBuffer: async () => gz() }), sleepImpl: noSleep, log: () => {} }), isLimit("too-large", "imdbDump"));
  });
});

// ── coverImage ───────────────────────────────────────────────────────────────

test("coverImage: a cover that never answers is tried again inside the deadline and fails; a body that never ends is cut; `limit hit coverImage` is logged", async () => {
  await withLimits({ coverImage: { timeoutMs: 25 } }, async () => {
    let n = 0; const signals = [], lines = [];
    const t0 = Date.now();
    await assert.rejects(P.fetchImage("https://img.test/a.jpg", { fetchImpl: (u, init) => { n++; signals.push(init.signal); return never(); }, sleepImpl: noSleep, retries: 2, log: (l) => lines.push(l) }), isLimit("timeout", "coverImage"));
    assert.ok(Date.now() - t0 < 3000);
    assert.equal(n, 3);
    assert.ok(signals.every((s) => s.aborted));
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => /limit hit coverImage: no complete answer in 25 ms/.test(l)));
    await assert.rejects(P.fetchImage("https://img.test/b.jpg", { fetchImpl: async () => stuckBody(), sleepImpl: noSleep, retries: 1, log: () => {} }), isLimit("timeout", "coverImage"));
  });
});

test("coverImage: a body past the cap fails at once with too-large (one request, no retry, not read whole); an image at the cap passes; a bad status is judged as before", async () => {
  await withLimits({ coverImage: { maxBytes: 4096 } }, async () => {
    const boxes = [], lines = [];
    await assert.rejects(P.fetchImage("https://img.test/c.jpg", { fetchImpl: async () => { const b = streamed(100000, 1024); boxes.push(b); return b.res; }, sleepImpl: async () => assert.fail("not retried"), retries: 3, log: (l) => lines.push(l) }), isLimit("too-large", "coverImage"));
    assert.equal(boxes.length, 1);
    assert.ok(boxes[0].pulled <= 6 && boxes[0].cancelled);
    assert.match(lines[0], /limit hit coverImage: answer larger than 4096 bytes/);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(4096 - 3, 2)]); // exactly 4096
    assert.equal((await P.fetchImage("u", { fetchImpl: async () => ({ status: 200, ok: true, arrayBuffer: async () => jpeg }), sleepImpl: noSleep })).length, 4096);
    await assert.rejects(P.fetchImage("u", { fetchImpl: async () => ({ status: 200, ok: true, arrayBuffer: async () => Buffer.concat([jpeg, Buffer.from([1])]) }), sleepImpl: noSleep, log: () => {} }), isLimit("too-large", "coverImage"));
    let k = 0;
    assert.ok((await P.fetchImage("u", { fetchImpl: async () => (++k < 3 ? { status: 503, ok: false } : { status: 200, ok: true, arrayBuffer: async () => JPEG }), sleepImpl: noSleep })).length > 0, "a 503 is still retried");
    await assert.rejects(P.fetchImage("u", { fetchImpl: async () => ({ status: 404, ok: false }), sleepImpl: noSleep }), /404/);
  });
});

test("coverImage: in drawCovers a cover that hits a limit is logged, falls back to the next source and never stops the step", async () => {
  await withLimits({ coverImage: { maxBytes: 4096 } }, async () => {
    const fs = require("fs"), path = require("path");
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "me-cov-"));
    const d = { raw: path.join(dir, "raw"), out: path.join(dir, "out"), state: path.join(dir, "posters.json") };
    const targets = new Map([["tt1", { tt: "tt1", tmdbPoster: "/a.jpg", ratings: { lb: null, imdb: 7.3, friendsAvg: null, seenBy: 0, wantBy: 0 }, items: [{ id: "tt1", poster: "/a.jpg" }] }]]);
    const asked = []; const log = [];
    const fetchImpl = async (url) => { asked.push(url); return streamed(100000, 1024).res; };
    const r = await P.drawCovers({ targets, dir: d, base: "https://pages.test/posters/", today: "2026-10-13", fetchImpl, render: async () => ({ drawn: 0, failed: [] }), version: "v1", sleepImpl: noSleep, log: (l) => log.push(l) });
    assert.equal(asked.length, 2, "TMDB's cover then metahub's, one request each: a too-large body is not tried again");
    assert.ok(log.filter((l) => /limit hit coverImage/.test(l)).length === 2, log.join("\n"));
    assert.equal(r.stats.downloadFailed, 1);
  });
});

// ── flag ─────────────────────────────────────────────────────────────────────

test("flag: a flag that never answers is tried again inside the deadline and fails; ensureFlags reports it as failed and goes on; `limit hit flag` is logged", async () => {
  await withLimits({ flag: { timeoutMs: 25 } }, async () => {
    let n = 0; const signals = [], lines = [];
    const t0 = Date.now();
    await assert.rejects(C.fetchFlag("jp", { fetchImpl: (u, init) => { n++; signals.push(init.signal); return never(); }, sleepImpl: noSleep, retries: 2, log: (l) => lines.push(l) }), isLimit("timeout", "flag"));
    assert.ok(Date.now() - t0 < 3000);
    assert.equal(n, 3);
    assert.ok(signals.every((s) => s.aborted));
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => /limit hit flag: no complete answer in 25 ms/.test(l)));
    await assert.rejects(C.fetchFlag("jp", { fetchImpl: async () => stuckBody(), sleepImpl: noSleep, retries: 1, log: () => {} }), isLimit("timeout", "flag"));
    // ensureFlags: the hung flag fails, the others come
    const fs = require("fs"), path = require("path");
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "me-flags-"));
    const ens = [];
    const r = await C.ensureFlags(["jp", "us"], { dir, fetchImpl: async (u) => (/jp\.png/.test(u) ? never() : { status: 200, ok: true, arrayBuffer: async () => PNG }), sleepImpl: noSleep, log: (l) => ens.push(l) });
    assert.equal(r.downloaded, 1);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].cc, "jp");
    assert.match(r.failed[0].error, /limit hit flag/);
    assert.ok(ens.some((l) => /limit hit flag/.test(l)));
    assert.ok(fs.existsSync(path.join(dir, "us.png")) && !fs.existsSync(path.join(dir, "jp.png")));
  });
});

test("flag: a body past the cap fails at once with too-large (one request, no retry, not read whole); a flag at the cap passes", async () => {
  await withLimits({ flag: { maxBytes: 1024 } }, async () => {
    const boxes = [], lines = [];
    await assert.rejects(C.fetchFlag("jp", { fetchImpl: async () => { const b = streamed(100000, 512); boxes.push(b); return b.res; }, sleepImpl: async () => assert.fail("not retried"), retries: 3, log: (l) => lines.push(l) }), isLimit("too-large", "flag"));
    assert.equal(boxes.length, 1);
    assert.ok(boxes[0].pulled <= 4 && boxes[0].cancelled, `pulled ${boxes[0].pulled}`);
    assert.match(lines[0], /limit hit flag: answer larger than 1024 bytes/);
    const png = Buffer.concat([PNG.subarray(0, 4), Buffer.alloc(1024 - 4, 1)]);
    assert.equal((await C.fetchFlag("jp", { fetchImpl: async () => ({ status: 200, ok: true, arrayBuffer: async () => png }), sleepImpl: noSleep })).length, 1024);
    await assert.rejects(C.fetchFlag("jp", { fetchImpl: async () => ({ status: 200, ok: true, arrayBuffer: async () => Buffer.concat([png, Buffer.from([1])]) }), sleepImpl: noSleep, log: () => {} }), isLimit("too-large", "flag"));
    let k = 0;
    assert.ok((await C.fetchFlag("jp", { fetchImpl: async () => (++k < 3 ? { status: 503, ok: false } : { status: 200, ok: true, arrayBuffer: async () => PNG }), sleepImpl: noSleep })).length > 0, "a 503 is still retried");
  });
});

// ── review of 13/10/2026: TMDB and Letterboxd write the same line, the other guards ─────────────────────────────────────────────

const path = require("path"), fs = require("fs"), os = require("os");
const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("TMDB and Letterboxd: every try cut by the deadline or the cap writes `limit hit tmdb|letterboxd: …` and is counted; a plain network error writes nothing; the final error keeps its `last limit hit:` text", async () => {
  await withLimits({}, async () => {
    const prev = process.env.OFFLINE; delete process.env.OFFLINE;
    try {
      const lines = [];
      const t = new Tmdb("v3key", path.join(os.tmpdir(), `me-lh-${process.pid}.json`), { fetchImpl: () => never(), sleepImpl: noSleep, timeoutMs: 20, log: (l) => lines.push(l) });
      await assert.rejects(t.get("/movie/1"), /^Error: TMDB kept failing on \/movie\/1 \(last limit hit: no complete answer in 20 ms\)$/);
      assert.equal(lines.length, 5, "one line per cut try (5 tries)");
      assert.ok(lines.every((l) => l === "  ! limit hit tmdb: no complete answer in 20 ms"), lines.join("\n"));
      assert.equal(U.limitHits.tmdb, 5);
      const big = new Tmdb("v3key", path.join(os.tmpdir(), `me-lh2-${process.pid}.json`), { fetchImpl: async () => streamed(1000, 1024).res, sleepImpl: noSleep, maxBytes: 4096, log: (l) => lines.push(l) });
      await assert.rejects(big.get("/movie/2"), /kept failing/);
      assert.ok(lines.slice(5).every((l) => /^  ! limit hit tmdb: answer larger than 4096 bytes$/.test(l)));
      const quiet = [];
      const net = new Tmdb("v3key", path.join(os.tmpdir(), `me-lh3-${process.pid}.json`), { fetchImpl: async () => { throw new Error("ECONNRESET"); }, sleepImpl: noSleep, log: (l) => quiet.push(l) });
      await assert.rejects(net.get("/movie/3"), /kept failing/);
      assert.deepEqual(quiet, []);
    } finally { if (prev !== undefined) process.env.OFFLINE = prev; }
    const ll = [];
    const http = F.makeHttp({ fetchImpl: () => never(), sleepImpl: noSleep, retries: 1, timeoutMs: 20, log: (l) => ll.push(l) });
    await assert.rejects(http.get("https://letterboxd.com/film/x/"), /last limit hit: no complete answer in 20 ms/);
    assert.deepEqual(ll, ["  ! limit hit letterboxd: no complete answer in 20 ms", "  ! limit hit letterboxd: no complete answer in 20 ms"]);
    // the 403 body past the cap is a limit hit too (it is then treated as a challenge)
    const l403 = [];
    const forb = F.makeHttp({ fetchImpl: async () => ({ status: 403, ok: false, url: "u", headers: { get: () => null }, body: streamed(1000, 1024).res.body }), sleepImpl: noSleep, retries: 2, maxBytes: 4096, log: (l) => l403.push(l) });
    await assert.rejects(forb.get("https://letterboxd.com/mubi/watchlist/"), (e) => e instanceof F.BlockedError);
    assert.ok(l403.some((l) => /limit hit letterboxd: answer larger than 4096 bytes/.test(l)), l403.join("\n"));
    assert.ok(U.limitHits.letterboxd >= 3);
  });
});

test("limitedFetch: a site with no maxBytes cannot have its body read (a configuration error, nothing is requested); as: \"none\" still works", async () => {
  await withLimits({}, async () => {
    let asked = 0;
    await assert.rejects(U.limitedFetch("boxd", async () => (asked++, { status: 200, ok: true }), "u", {}, { as: "bytes" }), /limits: "boxd" has no maxBytes/);
    await assert.rejects(U.limitedFetch("boxd", async () => (asked++, { status: 200, ok: true }), "u", {}, { as: "text" }), /has no maxBytes/);
    assert.equal(asked, 0);
    delete LIMITS.flag.maxBytes;
    await assert.rejects(U.limitedFetch("flag", async () => (asked++, {}), "u"), /limits: "flag" has no maxBytes/);
    LIMITS.flag.maxBytes = Infinity;
    await assert.rejects(U.limitedFetch("flag", async () => (asked++, {}), "u"), /has no maxBytes/, "an infinite cap is no cap");
    assert.equal(asked, 0);
    assert.equal((await U.limitedFetch("boxd", async () => ({ status: 301, ok: false }), "u", {}, { as: "none" })).res.status, 301);
  });
});

// ── the covers: one breaker per host ─────────────────────────────────────────

function coverWorld(n, { poster = false } = {}) {
  const dir = tmpDir("me-brk-");
  const d = { raw: path.join(dir, "raw"), out: path.join(dir, "out"), state: path.join(dir, "posters.json") };
  const targets = new Map(Array.from({ length: n }, (_, i) => { const tt = `tt${i + 1}`; return [tt, { tt, tmdbPoster: poster ? `/p${i}.jpg` : null, ratings: { lb: null, imdb: 7.3, friendsAvg: null, seenBy: 0, wantBy: 0 }, items: [{ id: tt, poster: null }] }]; }));
  const run = (o) => P.drawCovers({ targets, dir: d, base: "https://pages.test/posters/", today: "2026-10-13", render: async () => ({ drawn: 0, failed: [] }), version: "v1", sleepImpl: noSleep, concurrency: 1, ...o });
  return { targets, d, run };
}

test("covers: 11 covers of one host that never answers cost 10 tries in all; the 8 after the trip are skipped at once, keep their address, and are counted FAILED with the reason host-tripped", async () => {
  await withLimits({ coverImage: { timeoutMs: 15 } }, async () => {
    const w = coverWorld(11);
    const asked = [], log = []; let sleeps = 0;
    const r = await w.run({ fetchImpl: (url) => (asked.push(url), never()), sleepImpl: async () => { sleeps++; }, log: (l) => log.push(l) });
    assert.equal(asked.length, 10, "ten tries in all, then no more requests: 4 + 4 + 2 of the third cover");
    assert.equal(r.stats.downloadFailed, 11);
    assert.equal(r.stats.hostTripped, 8, "the covers that were never asked for");
    assert.equal(r.tts.size, 0);
    assert.equal(sleeps, 9, "a wait after each failed try: 4 + 4 for the first two covers, 1 for the third's first try; the try that trips waits for nothing");
    const trip = log.filter((l) => /limit hit covers/.test(l));
    assert.deepEqual(trip, ["  ! limit hit covers: host images.metahub.space tripped after 10"]);
    assert.equal(log.filter((l) => /limit hit coverImage/.test(l)).length, 10);
    assert.deepEqual([...w.targets.values()].flatMap((t) => t.items.map((i) => i.poster)), Array(11).fill(null), "every cover keeps the address it had");
    assert.deepEqual(r.receipt.map((x) => x.reason), [...Array(3).fill("downloadFailed"), ...Array(8).fill("host-tripped")]);
    assert.equal(U.limitHits.covers, 1);
  });
});

test("covers: the breaker counts tries in a row (an answer starts the count again), is per host, and a tripped TMDB falls back to metahub for the same cover", async () => {
  await withLimits({}, async () => {
    // 9 network errors, one answer, 9 more: never 10 in a row, never tripped
    const br = P.makeHostBreaker({ after: 10, log: () => assert.fail("must not trip") });
    for (let i = 0; i < 9; i++) br.failed("h"); br.answered("h"); for (let i = 0; i < 9; i++) br.failed("h");
    assert.equal(br.tripped("h"), false);
    const lines = [];
    const b2 = P.makeHostBreaker({ after: 3, log: (l) => lines.push(l) });
    b2.failed("a"); b2.failed("a"); b2.failed("b"); b2.failed("a");
    assert.deepEqual([b2.tripped("a"), b2.tripped("b")], [true, false]);
    b2.answered("a"); b2.failed("a");
    assert.equal(b2.tripped("a"), true, "a tripped host stays given up on for the night");
    assert.deepEqual(lines, ["  ! limit hit covers: host a tripped after 3"]);
    assert.deepEqual(b2.trippedHosts(), ["a"]);
    // answers of any kind (404, a body too large) are not failures: 30 covers that are all 404 never trip
    const w = coverWorld(30);
    const log = [];
    const r = await w.run({ fetchImpl: async () => ({ status: 404, ok: false }), log: (l) => log.push(l) });
    assert.equal(r.stats.hostTripped, 0);
    assert.deepEqual(log, []);
    // a body past the cap is an answer too: 30 covers that are all too large never trip the host (and each is asked once: too-large is not retried)
    LIMITS.coverImage.maxBytes = 4096; U.resetLimitHits();
    const w3 = coverWorld(30);
    const big = [];
    const r3 = await w3.run({ fetchImpl: async (u) => (big.push(u), streamed(100000, 1024).res), log: () => {} });
    assert.equal(r3.stats.hostTripped, 0);
    assert.equal(big.length, 30);
    assert.equal(U.limitHits.covers || 0, 0);
    LIMITS.coverImage.maxBytes = 5 * 1024 * 1024;
    // TMDB mute, metahub fine: after the trip the TMDB covers go straight to metahub, none is lost
    const w2 = coverWorld(14, { poster: true });
    const asked = [];
    const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(3000, 2)]);
    const r2 = await w2.run({ fetchImpl: async (url) => { asked.push(url); if (/image\.tmdb\.org/.test(url)) throw new Error("ECONNRESET"); return { status: 200, ok: true, arrayBuffer: async () => JPG }; }, log: () => {} });
    assert.equal(asked.filter((u) => /image\.tmdb\.org/.test(u)).length, 10, "TMDB images asked 10 times, not 14 x 4");
    assert.equal(asked.filter((u) => /metahub/.test(u)).length, 14, "every cover came from metahub");
    assert.equal(r2.stats.downloaded, 14);
    assert.equal(r2.stats.downloadFailed, 0);
    assert.equal(r2.stats.hostTripped, 0, "nothing was lost to the trip, so nothing is FAILED");
  });
});

// ── the IMDb dump: what it inflates to ───────────────────────────────────────

test("imdbDump: a small gzip that inflates past maxInflatedBytes is refused at once (no new try), logged as a limit hit, and loadImdbRatings keeps yesterday's cache; one under the ceiling reads as before", async () => {
  await withLimits({}, async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(2 * 1024 * 1024, 0)); // a few KB on the wire, 2 MB inflated
    assert.ok(bomb.length < 10 * 1024);
    LIMITS.imdbDump.maxInflatedBytes = 100 * 1024;
    let n = 0; const lines = [];
    const fetchImpl = async () => (n++, { status: 200, ok: true, arrayBuffer: async () => bomb });
    await assert.rejects(P.downloadImdb({ fetchImpl, sleepImpl: async () => assert.fail("not retried"), retries: 3, log: (l) => lines.push(l) }), isLimit("too-large", "imdbDump"));
    assert.equal(n, 1);
    assert.deepEqual(lines, ["  ! limit hit imdbDump: inflated file larger than 102400 bytes"]);
    const file = path.join(tmpDir("me-infl-"), "imdb-ratings.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1, date: "2026-10-12", ratings: { tt0000001: [5.1, 10] }, none: [] }));
    const log = [];
    const r = await P.loadImdbRatings({ file, wanted: new Set(["tt0000001"]), today: "2026-10-13", fetchImpl, sleepImpl: noSleep, log: (l) => log.push(l) });
    assert.equal(r.source, "stale cache");
    assert.ok(log.some((l) => /IMDb ratings: limit hit imdbDump: inflated file larger than 102400 bytes/.test(l)), log.join("\n"));
    // exactly at the ceiling passes; the real file (a few MB inflated) is far under 1 GiB
    LIMITS.imdbDump.maxInflatedBytes = Buffer.byteLength(TSV);
    assert.equal((await P.downloadImdb({ fetchImpl: async () => ({ status: 200, ok: true, arrayBuffer: async () => gz() }), sleepImpl: noSleep })).text, TSV);
    LIMITS.imdbDump.maxInflatedBytes = Buffer.byteLength(TSV) - 1;
    await assert.rejects(P.downloadImdb({ fetchImpl: async () => ({ status: 200, ok: true, arrayBuffer: async () => gz() }), sleepImpl: noSleep, log: () => {} }), isLimit("too-large", "imdbDump"));
  });
});

// ── build.js: the guard on config.json "limits" and the summary line ─────────────────────────────────────────────────────────

const { spawnSync } = require("child_process");
const ROOT = path.join(__dirname, "..");

test("build.js: a config.json with a wrong `limits` stops the build before it reads anything, naming the entry; a valid one gets past that guard", () => {
  const dir = tmpDir("me-cfg-");
  fs.copyFileSync(path.join(ROOT, "build.js"), path.join(dir, "build.js"));
  fs.cpSync(path.join(ROOT, "lib"), path.join(dir, "lib"), { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  const run = (limits) => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ ...cfg, limits }));
    return spawnSync(process.execPath, ["build.js", "--offline", "--cache-only", "--out", path.join(dir, "out")], { cwd: dir, encoding: "utf8", env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" } });
  };
  for (const [limits, re] of [[{ imdb: { timeoutMs: 1 } }, /config\.json "limits": "imdb" is not a request site/], [{ flag: { maxBytes: -1 } }, /"limits\.flag\.maxBytes" must be a positive whole number/], [{ flag: { timeoutMs: 3e9 } }, /must be at most 2147483647/]]) {
    const r = run(limits);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, re);
  }
  const ok = run({ flag: { timeoutMs: 5000 } }); // goes on to the next thing that stops this bare folder (it has no data/ in it)
  assert.notEqual(ok.status, 0);
  assert.doesNotMatch(ok.stderr, /config\.json "limits/);
  assert.match(ok.stderr, /ENOENT|No Letterboxd data yet/, "it stopped later, on the missing files of this bare folder");
});

test("limitSummary: every request site then covers, with its count", () => {
  U.resetLimitHits();
  assert.equal(U.limitSummary(), "limit hits: tmdb 0, letterboxd 0, letterboxdRss 0, boxd 0, imdbDump 0, coverImage 0, flag 0, wikidata 0, covers 0");
  U.recordLimitHit("letterboxdRss", "x", () => {}); U.recordLimitHit("covers", "y", () => {}); U.recordLimitHit("covers", "y", () => {});
  assert.equal(U.limitSummary(), "limit hits: tmdb 0, letterboxd 0, letterboxdRss 1, boxd 0, imdbDump 0, coverImage 0, flag 0, wikidata 0, covers 2");
  U.resetLimitHits();
});

test("build.js prints the summary line at the end of a build (offline, from the caches: all zero)", { skip: !fs.existsSync(path.join(ROOT, "cache", "lists.json")) && "no caches" }, () => {
  const out = tmpDir("me-sum-");
  const r = spawnSync(process.execPath, ["build.js", "--offline", "--cache-only", "--out", out], { cwd: ROOT, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, env: { ...process.env, SKIP_RSS: "1", MOOD_DATE: "2026-10-10", TMDB_TOKEN: "" } });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split("\n");
  const i = lines.findIndex((l) => /^ {5}limit hits: /.test(l));
  assert.ok(i >= 0, "no summary line");
  assert.equal(lines[i].trim(), "limit hits: tmdb 0, letterboxd 0, letterboxdRss 0, boxd 0, imdbDump 0, coverImage 0, flag 0, wikidata 0, covers 0");
  assert.match(lines[i + 1], /^✔ Done in|^\s*$/, "right before the Done line");
});
