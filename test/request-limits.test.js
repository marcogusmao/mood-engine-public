// node --test
// Security findings 1 and 2 of the catalog-expansion review (BACKLOG, 11/10/2026), fixed before the first online night of v2.4:
//   1. every TMDB and Letterboxd request has a deadline that covers the answer and its body, and a byte cap on the body; past either
//      one the try is a failed try, retried like a network error (lib/util.js deadline / readCapped). The Chrome reader had its
//      deadline already and gets the same byte cap.
//   2. a Letterboxd slug read from a page must look like one (lib/friends.js SLUG_RE): `..`, `/`, `?`, `%` or capitals never become a
//      cache key or the path of https://letterboxd.com/film/<slug>/, and the refused ones are counted.
// No test here touches the network: every fetch is a local fake.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { Tmdb, TIMEOUT_MS: TMDB_TIMEOUT, MAX_BYTES: TMDB_MAX } = require("../lib/tmdb");
const F = require("../lib/friends");
const { dumpDom, MAX_BYTES: CHROME_MAX } = require("../lib/fetch-chrome");

const ROOT = path.join(__dirname, "..");
const noSleep = async () => {};
const quiet = () => {}; // the `limit hit tmdb|letterboxd: …` lines (written by default through console.warn) are asserted in request-limits-build.test.js
const never = () => new Promise(() => {}); // a server that accepts the connection and never answers
const json = (o) => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(o) });
/** A response whose body is a stream of `n` chunks of `size` bytes; `pulled` counts the chunks actually read. */
function streamed(n, size, { length = null } = {}) {
  const box = { pulled: 0 };
  const body = new ReadableStream({
    pull(c) { if (box.pulled >= n) return c.close(); box.pulled++; c.enqueue(new Uint8Array(size).fill(32)); },
    cancel() { box.cancelled = true; }, // the reader gave the stream back: the rest is never downloaded
  }, { highWaterMark: 0 });
  box.res = { status: 200, ok: true, headers: { get: (h) => (h === "content-length" ? length : null) }, body, text: async () => { throw new Error("the body is a stream: text() must not be used"); } };
  return box;
}
/** A 403 whose body starts with Letterboxd's own "Forbidden" title and then either runs on for `n` chunks of `size` bytes or never ends. */
function forbiddenBody({ n = 0, size = 1024, endless = false } = {}) {
  const head = new TextEncoder().encode("<html><head><title>Letterboxd - Forbidden</title></head><body>");
  let sent = 0;
  const body = new ReadableStream({
    pull(c) { if (sent === 0) { sent++; return c.enqueue(head); } if (endless) return new Promise(() => {}); if (sent > n) return c.close(); sent++; c.enqueue(new Uint8Array(size).fill(32)); },
  }, { highWaterMark: 0 });
  return { status: 403, ok: false, url: "u", headers: { get: () => null }, body };
}
const timers = () => process.getActiveResourcesInfo().filter((x) => x === "Timeout").length; // a deadline nobody cleared stays here for its whole length
function tmdbWith(fetchImpl, opts = {}) {
  const prev = process.env.OFFLINE; delete process.env.OFFLINE;
  try { return new Tmdb("v3key", path.join(require("os").tmpdir(), `me-tmdb-${process.pid}-${Math.random()}.json`), { fetchImpl, sleepImpl: noSleep, log: quiet, ...opts }); }
  finally { if (prev !== undefined) process.env.OFFLINE = prev; }
}
async function withOnline(fn) { const prev = process.env.OFFLINE; delete process.env.OFFLINE; try { return await fn(); } finally { if (prev !== undefined) process.env.OFFLINE = prev; } }

test("the limits are generous and documented: TMDB 30 s and 10 MB, Letterboxd 45 s and 20 MB, Chrome 20 MB per page", () => {
  assert.equal(TMDB_TIMEOUT, 30000);
  assert.equal(TMDB_MAX, 10 * 1024 * 1024);
  assert.equal(F.TIMEOUT_MS, 45000);
  assert.equal(F.MAX_BYTES, 20 * 1024 * 1024);
  assert.equal(CHROME_MAX, 20 * 1024 * 1024);
});

test("TMDB: a server that never answers fails within the deadline, after the same 5 tries as before, and each try gets an abort signal", async () => {
  const signals = [];
  const t = tmdbWith((url, init) => { signals.push(init.signal); return never(); }, { timeoutMs: 25 });
  const t0 = Date.now();
  await withOnline(() => assert.rejects(t.get("/movie/1"), /TMDB kept failing on \/movie\/1/));
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  assert.equal(t.calls, 5);
  assert.equal(t.limited, 5);
  assert.equal(signals.length, 5);
  assert.ok(signals.every((s) => s instanceof AbortSignal && s.aborted), "the deadline aborts the request it was given to");
});

test("TMDB: an answer that starts and then never ends its body is cut by the same deadline", async () => {
  const stuck = () => ({ status: 200, ok: true, headers: { get: () => null }, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); } }) }); // never closes
  const t = tmdbWith(async () => stuck(), { timeoutMs: 25 });
  await withOnline(() => assert.rejects(t.get("/movie/2"), /kept failing/));
  assert.equal(t.limited, 5);
});

test("TMDB: a body past the cap is refused while it is read (chunks counted, the stream cancelled), and so is a declared Content-Length past it", async () => {
  const boxes = [];
  const t = tmdbWith(async () => { const b = streamed(1000, 1024); boxes.push(b); return b.res; }, { maxBytes: 8 * 1024 });
  await withOnline(() => assert.rejects(t.get("/movie/3"), /kept failing/));
  assert.equal(t.limited, 5);
  assert.ok(boxes.every((b) => b.pulled <= 10), `read ${boxes.map((b) => b.pulled)} chunks of 1 KB with a cap of 8 KB: the rest is never pulled`);
  assert.ok(boxes.every((b) => b.cancelled), "the stream is cancelled when the cap is passed, not left open");
  const dboxes = [];
  const declared = tmdbWith(async () => { const b = streamed(1, 10, { length: "999999" }); dboxes.push(b); return b.res; }, { maxBytes: 1000 });
  await withOnline(() => assert.rejects(declared.get("/movie/4"), /kept failing/));
  assert.equal(declared.limited, 5);
  assert.ok(dboxes.every((b) => b.cancelled && b.pulled === 0), "a declared Content-Length past the cap is refused before any byte is read, and the stream is given back");
  // a response with no stream (the tests' fakes, text() only) is measured after reading
  const viaText = tmdbWith(async () => json({ pad: "x".repeat(2000) }), { maxBytes: 1000 });
  await withOnline(() => assert.rejects(viaText.get("/movie/8"), /kept failing/));
  assert.equal(viaText.limited, 5);
  // under the cap, by stream or by text(): read and parsed as before
  const ok = tmdbWith(async () => json({ id: 5, title: "Fine" }), { maxBytes: 1000 });
  assert.deepEqual(await withOnline(() => ok.get("/movie/5")), { id: 5, title: "Fine" });
  assert.equal(ok.limited, 0);
  const t0 = timers();
  await withOnline(() => ok.get("/movie/5b"));
  assert.equal(timers(), t0, "the deadline's timer is cleared when the try ends (an answer, or a failure)");
  const bytes = new TextEncoder().encode(JSON.stringify({ id: 6 }));
  const viaStream = tmdbWith(async () => ({ status: 200, ok: true, headers: { get: () => null }, body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) }));
  assert.deepEqual(await withOnline(() => viaStream.get("/movie/6")), { id: 6 });
});

test("TMDB: a fetch that ignores the abort signal is still given up at the deadline (the try races the deadline)", async () => {
  const t = tmdbWith(() => never(), { timeoutMs: 20 });
  await withOnline(() => assert.rejects(t.get("/movie/7"), /kept failing/));
  assert.equal(t.calls, 5);
});

test("Letterboxd: a server that never answers fails within the deadline after the usual tries; a body past the cap is a failed try too", async () => {
  let n = 0;
  const signals = [];
  const http = F.makeHttp({ log: quiet, fetchImpl: (url, init) => { n++; signals.push(init.signal); return never(); }, sleepImpl: noSleep, retries: 2, timeoutMs: 25 });
  const t0 = Date.now();
  await assert.rejects(http.get("https://letterboxd.com/film/x/"), /did not answer after 3 tries/);
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(n, 3);
  assert.ok(signals.length === 3 && signals.every((x) => x instanceof AbortSignal && x.aborted), "each try is given an abort signal and the deadline aborts it");
  const boxes = [];
  const big = F.makeHttp({ log: quiet, fetchImpl: async () => { const b = streamed(1000, 1024); boxes.push(b); return b.res; }, sleepImpl: noSleep, retries: 1, maxBytes: 4096 });
  await assert.rejects(big.get("https://letterboxd.com/film/y/"), /did not answer after 2 tries/);
  assert.ok(boxes.every((b) => b.pulled <= 6), `pulled ${boxes.map((b) => b.pulled)}`);
  // a body that never ends is cut by the deadline
  const stuck = F.makeHttp({ log: quiet, fetchImpl: async () => ({ status: 200, ok: true, headers: { get: () => null }, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(5)); } }) }), sleepImpl: noSleep, retries: 1, timeoutMs: 25 });
  await assert.rejects(stuck.get("https://letterboxd.com/film/z/"), /did not answer after 2 tries/);
  // a normal page and a private one ("Forbidden") are read as before, under the cap
  const fine = F.makeHttp({ log: quiet, fetchImpl: async () => ({ status: 200, ok: true, url: "u", headers: { get: () => null }, text: async () => "<html>ok</html>" }), sleepImpl: noSleep, maxBytes: 4096 });
  const t1 = timers();
  assert.equal((await fine.get("https://letterboxd.com/film/w/")).text, "<html>ok</html>");
  assert.equal(timers(), t1, "the deadline's timer is cleared once the page is read");
  const priv = F.makeHttp({ log: quiet, fetchImpl: async () => ({ status: 403, ok: false, url: "u", headers: { get: () => null }, text: async () => "<title>Letterboxd - Forbidden</title>" }), sleepImpl: noSleep });
  assert.equal((await priv.get("https://letterboxd.com/mubi/watchlist/")).forbidden, true);
  // the 403 body is read under the same cap and deadline: one that runs on past the cap, or never ends, is unreadable, so the 403 counts as a
  // challenge (BlockedError on the second), not as a private list
  const bigForbidden = F.makeHttp({ log: quiet, fetchImpl: async () => forbiddenBody({ n: 1000 }), sleepImpl: noSleep, maxBytes: 4096 });
  await assert.rejects(bigForbidden.get("https://letterboxd.com/mubi/watchlist/"), (e) => e instanceof F.BlockedError);
  const stuckForbidden = F.makeHttp({ log: quiet, fetchImpl: async () => forbiddenBody({ endless: true }), sleepImpl: noSleep, timeoutMs: 25 });
  await assert.rejects(stuckForbidden.get("https://letterboxd.com/mubi/watchlist/"), (e) => e instanceof F.BlockedError);
  const smallForbidden = F.makeHttp({ log: quiet, fetchImpl: async () => forbiddenBody({ n: 2 }), sleepImpl: noSleep, maxBytes: 4096 });
  assert.equal((await smallForbidden.get("https://letterboxd.com/mubi/watchlist/")).forbidden, true);
});

test("Chrome: a page past the byte cap is a failed read, not an endless string in memory", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const p = dumpDom("chrome", [], { timeoutMs: 5000, maxBytes: 1000, spawnImpl: () => child });
  child.stdout.emit("data", Buffer.alloc(600, 32));
  child.stdout.emit("data", Buffer.alloc(600, 32));
  await assert.rejects(p, /more than 1000 bytes/);
  // under the cap, a page still comes back whole
  const c2 = new EventEmitter(); c2.stdout = new EventEmitter(); c2.stderr = new EventEmitter();
  const q = dumpDom("chrome", [], { timeoutMs: 5000, maxBytes: 1000, spawnImpl: () => c2 });
  c2.stdout.emit("data", "<html><body>ok</body></html>");
  assert.equal(await q, "<html><body>ok</body></html>");
});

test("the deadline's timer is cleared on every way out of a try: after a failed try, after a 403 (private or a challenge), after a TMDB failure", async () => {
  let n = 0;
  const page = { status: 200, ok: true, url: "u", headers: { get: () => null }, text: async () => "<html>ok</html>" };
  const flaky = F.makeHttp({ log: quiet, fetchImpl: async () => { if (n++ === 0) throw new Error("socket hang up"); return page; }, sleepImpl: noSleep, maxBytes: 4096 });
  const t0 = timers();
  assert.equal((await flaky.get("https://letterboxd.com/film/f/")).text, "<html>ok</html>");
  assert.equal(n, 2);
  assert.equal(timers(), t0, "a failed try left its deadline timer running");
  const t1 = timers();
  const priv = F.makeHttp({ log: quiet, fetchImpl: async () => forbiddenBody({ n: 2 }), sleepImpl: noSleep, maxBytes: 4096 });
  assert.equal((await priv.get("https://letterboxd.com/mubi/watchlist/")).forbidden, true);
  assert.equal(timers(), t1, "a private 403 left its deadline timer running");
  const t2 = timers();
  const challenge = F.makeHttp({ log: quiet, fetchImpl: async () => ({ status: 403, ok: false, url: "u", headers: { get: () => null }, text: async () => "<title>Just a moment...</title>" }), sleepImpl: noSleep });
  await assert.rejects(challenge.get("https://letterboxd.com/film/c/"), (e) => e instanceof F.BlockedError);
  assert.equal(timers(), t2, "a challenge 403 left its deadline timer running");
  let m = 0;
  const t = tmdbWith(async () => { if (m++ === 0) throw new Error("reset"); return json({ id: 9 }); });
  const t3 = timers();
  assert.deepEqual(await withOnline(() => t.get("/movie/9")), { id: 9 });
  assert.equal(timers(), t3, "a failed TMDB try left its deadline timer running");
});

test("the byte cap is exact: a body of exactly the cap passes and one byte more fails, for a stream, a declared length, text() and Chrome", async () => {
  const U = require("../lib/util");
  const stream = (n, chunk) => new ReadableStream({ start(c) { for (let i = 0; i < n; i += chunk) c.enqueue(new Uint8Array(Math.min(chunk, n - i)).fill(97)); c.close(); } });
  const res = (n, length = null) => ({ headers: { get: (h) => (h === "content-length" ? length : null) }, body: stream(n, 4) });
  assert.equal((await U.readCapped(res(10), 10)).length, 10);
  await assert.rejects(U.readCapped(res(11), 10), (e) => e instanceof U.LimitError && e.code === "too-large");
  assert.equal((await U.readCapped(res(10, "10"), 10)).length, 10);
  await assert.rejects(U.readCapped(res(10, "11"), 10), /larger than 10 bytes \(11\)/);
  const texty = (str) => ({ headers: { get: () => null }, text: async () => str });
  assert.equal((await U.readCapped(texty("a".repeat(10)), 10)).length, 10);
  await assert.rejects(U.readCapped(texty("a".repeat(11)), 10), (e) => e instanceof U.LimitError);
  const page = (n) => "<html>" + "a".repeat(n - 13) + "</html>"; // exactly n bytes
  for (const [n, ok] of [[1000, true], [1001, false]]) {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    const p = dumpDom("chrome", [], { timeoutMs: 5000, maxBytes: 1000, spawnImpl: () => child });
    child.stdout.emit("data", Buffer.from(page(n)));
    if (ok) assert.equal((await p).length, n); else await assert.rejects(p, /more than 1000 bytes/);
  }
});

test("a UTF-8 BOM before the JSON is dropped, as res.text() and res.json() did", async () => {
  const U = require("../lib/util");
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(JSON.stringify({ id: 11 }))]);
  const body = () => new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 2)); c.enqueue(bytes.slice(2)); c.close(); } }); // the BOM split across two chunks
  assert.equal(await U.readCapped({ headers: { get: () => null }, body: body() }, 1000), '{"id":11}');
  const t = tmdbWith(async () => ({ status: 200, ok: true, headers: { get: () => null }, body: body() }));
  assert.deepEqual(await withOnline(() => t.get("/movie/11")), { id: 11 });
});

test("the final error names the limit that failed the tries (deadline or size cap); a plain network error names none and is not counted as a limit", async () => {
  const slow = tmdbWith(() => never(), { timeoutMs: 20 });
  await withOnline(() => assert.rejects(slow.get("/movie/20"), /^Error: TMDB kept failing on \/movie\/20 \(last limit hit: no complete answer in 20 ms\)$/));
  const big = tmdbWith(async () => streamed(1000, 1024).res, { maxBytes: 4096 });
  await withOnline(() => assert.rejects(big.get("/movie/21"), /^Error: TMDB kept failing on \/movie\/21 \(last limit hit: answer larger than 4096 bytes\)$/));
  const net = tmdbWith(async () => { throw new Error("ECONNRESET"); });
  await withOnline(() => assert.rejects(net.get("/movie/22"), (e) => e.message === "TMDB kept failing on /movie/22"));
  assert.equal(net.limited, 0, "a network error is not a limit");
  assert.equal(slow.limited, 5);
  const lslow = F.makeHttp({ log: quiet, fetchImpl: () => never(), sleepImpl: noSleep, retries: 1, timeoutMs: 20 });
  await assert.rejects(lslow.get("https://letterboxd.com/film/a/"), (e) => e.message === "Letterboxd did not answer after 2 tries: https://letterboxd.com/film/a/ (last limit hit: no complete answer in 20 ms)");
  const lbig = F.makeHttp({ log: quiet, fetchImpl: async () => streamed(1000, 1024).res, sleepImpl: noSleep, retries: 1, maxBytes: 4096 });
  await assert.rejects(lbig.get("https://letterboxd.com/film/b/"), (e) => e.message === "Letterboxd did not answer after 2 tries: https://letterboxd.com/film/b/ (last limit hit: answer larger than 4096 bytes)");
  const lnet = F.makeHttp({ log: quiet, fetchImpl: async () => { throw new Error("ECONNRESET"); }, sleepImpl: noSleep, retries: 1 });
  await assert.rejects(lnet.get("https://letterboxd.com/film/c/"), (e) => e.message === "Letterboxd did not answer after 2 tries: https://letterboxd.com/film/c/");
});

// ── slugs ─────────────────────────────────────────────────────────────────────

const poster = (slug) => `<li class="griditem"><div data-item-name="X (2000)" data-item-slug="${slug}"><img alt="X"/></div></li>`;
const grid = (...slugs) => `<ul class="grid">${slugs.map(poster).join("")}</ul>`;

test("slugs: a grid's slug that is not a Letterboxd slug is dropped and counted; the real forms (words, film:<n>, an underscore) are kept", () => {
  F.resetRefusedSlugs();
  const items = F.parsePosters(grid("the-godfather", "../..", "a/b", "Up-Case", "x%2f", "q?x=1", "film:761014", "post-angel-img_5466-2021", "2001-a-space-odyssey", "a--b", "-a", "a-", "film:abc", "film:"));
  assert.deepEqual(items.map((i) => i.slug), ["the-godfather", "film:761014", "post-angel-img_5466-2021", "2001-a-space-odyssey"]);
  assert.equal(F.slugsRefused.n, 10);
  assert.deepEqual(F.slugsRefused.examples, ["../..", "a/b", "Up-Case", "x%2f", "q?x=1"]);
  const rss = `<item><letterboxd:filmTitle>A</letterboxd:filmTitle><link>https://letterboxd.com/u/film/../</link></item><item><letterboxd:filmTitle>B</letterboxd:filmTitle><link>https://letterboxd.com/u/film/b-film/</link></item>`;
  F.resetRefusedSlugs();
  assert.deepEqual(F.parseFriendRss(rss).map((i) => i.slug), ["b-film"]);
  assert.equal(F.slugsRefused.n, 1);
});

test("slugs: a name every object already has (__proto__, constructor) or a stray underscore is refused and counted, and never read from the cache's prototype", async () => {
  F.resetRefusedSlugs();
  const items = F.parsePosters(grid("__proto__", "constructor", "_", "__", "a_", "_a", "a__b", "a-_b", "toString", "ok-film", "a_b"));
  assert.deepEqual(items.map((i) => i.slug), ["ok-film", "a_b"]);
  assert.equal(F.slugsRefused.n, 9);
  assert.deepEqual(F.slugsRefused.examples, ["__proto__", "constructor", "_", "__", "a_"]);
  F.resetRefusedSlugs();
  const asked = [];
  const http = { get: async (url) => { asked.push(url); return { status: 404, text: "", url }; } };
  const cache = { films: {} };
  await F.resolveFilms({ slugs: ["__proto__", "constructor", "ok-film"], enrich: ["__proto__", "constructor"], cache, http, sleepImpl: noSleep, gapMs: 0 });
  assert.deepEqual(asked, ["https://letterboxd.com/film/ok-film/"]);
  assert.equal(F.slugsRefused.n, 2, "each refused name is counted once");
  assert.ok(Object.hasOwn(cache.films, "ok-film"));
  assert.equal(Object.getPrototypeOf(cache.films), Object.prototype, "the cache object's prototype is untouched");
});

test("slugs: resolveFilms never asks Letterboxd for a slug that is not one (an old cache entry, a correction), and counts it", async () => {
  F.resetRefusedSlugs();
  const asked = [];
  const http = { get: async (url) => { asked.push(url); return { status: 404, text: "", url }; } };
  const cache = { films: { "old-one": { title: "Old", v: 1, imdbId: "tt1", t: 0 }, "../x": { title: "Bad", v: 1, imdbId: "tt2", t: 0 } } }; // both would be read again for rating/runtime/country
  await F.resolveFilms({ slugs: ["good-film", "../../settings", "film:42"], enrich: ["old-one", "../x"], cache, http, sleepImpl: noSleep, gapMs: 0 });
  assert.deepEqual(asked, ["https://letterboxd.com/film/good-film/", "https://letterboxd.com/film/film:42/", "https://letterboxd.com/film/old-one/"]);
  assert.equal(F.slugsRefused.n, 2);
  assert.ok(!("../../settings" in cache.films));
});

test("slugs: every slug in the committed caches passes the pattern (measured 13/10/2026: 20,569, none refused; the strict BACKLOG pattern would refuse 18) — a drift here would drop films", { skip: !fs.existsSync(path.join(ROOT, "cache", "friends.json")) }, () => {
  const f = JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "friends.json"), "utf8"));
  const l = JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "lists.json"), "utf8"));
  const all = new Set(Object.keys(f.films || {}));
  for (const u of Object.values(f.users || {})) for (const k of ["films", "watchlist", "rss"]) for (const r of u[k] || []) all.add(r[0]);
  for (const v of Object.values(f.lists || {})) for (const r of v.items || []) all.add(r[0]);
  for (const s of (f.me && f.me.slugs) || []) all.add(s);
  for (const v of Object.values(l.lists || {})) for (const r of v.items || []) all.add(r[0]);
  for (const fn of fs.readdirSync(path.join(ROOT, "data", "lists"))) for (const it of JSON.parse(fs.readFileSync(path.join(ROOT, "data", "lists", fn), "utf8")).items) all.add(it.slug);
  assert.ok(all.size > 10000, `${all.size} slugs: the caches must be the real ones`);
  const refused = [...all].filter((s) => !F.validSlug(s));
  assert.deepEqual(refused, []);
  assert.ok([...all].some((s) => s.startsWith("film:")), "the film:<n> form exists in the caches (the reason the pattern keeps it)");
  // the pattern the BACKLOG first asked for drops real films: this is why SLUG_RE is looser than it (13/10/2026: 17 film:<n> and one underscore slug)
  assert.ok([...all].some((s) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)), "the strict pattern would refuse a real slug in the caches");
});
