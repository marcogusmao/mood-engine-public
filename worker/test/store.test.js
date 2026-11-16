// Where the index comes from and what happens when the published file is not there: memory, the edge cache, the network, stale copies, nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { createStore, parseIndex, TTL_MS, REVALIDATE_MS, MAX_STALE_MS, RETRY_MS, RETRY_EMPTY_MS, INDEX_FETCH_TIMEOUT_MS, MAX_INDEX_BYTES, PIECE_CACHE_MAX, PIECE_CACHE_BYTES, AGGREGATE_INDEX_BYTES, isPermanent, isOptional, isOptionPiece, OPTION_PIECE_TIMEOUT_MS } from "../src/store.js";
import { makeIndexText, tweak } from "./fixture.js";

const URL_ = "https://example.test/data/index.json";
// The store keys its own Cache API entries apart from the edge cache (e90e232): a 404 stored at the bare URL must never be read back as the index.
const CK = URL_ + "?store=index";
const TEXT = makeIndexText();

/** A network that can be switched off, a Cache API in a Map, a clock, and a log that remembers. */
function rig({ up = true, text = TEXT, status = 200, withCache = true } = {}) {
  const r = { up, text, status, now: 1_000_000, fetches: 0, logs: [], cacheMap: new Map(), puts: 0 };
  r.fetchImpl = async (url, init) => {
    r.fetches++;
    r.lastInit = init;
    if (!r.up) throw new Error("network down");
    return new Response(r.text, { status: r.status });
  };
  r.caches = withCache ? {
    default: {
      match: async (url) => { const v = r.cacheMap.get(url); return v ? new Response(v.text, { headers: { "x-fetched-at": String(v.at) } }) : undefined; },
      put: async (url, res) => { r.puts++; r.cacheMap.set(url, { text: await res.text(), at: Number(res.headers.get("x-fetched-at")) }); },
    },
  } : undefined;
  r.store = () => createStore({ fetchImpl: r.fetchImpl, caches: r.caches, now: () => r.now, log: (o) => r.logs.push(o) });
  return r;
}
const waits = () => { const list = []; return { list, waitUntil: (p) => list.push(p) }; };

test("first request: read from the network with no edge cache (no-store) and written to the Cache API under its own key; the second is answered from memory with no fetch", async () => {
  const r = rig(), s = r.store();
  const a = await s.get(URL_);
  assert.equal(a.source, "network");
  assert.equal(a.index.films.length, JSON.parse(TEXT).films.length);
  assert.deepEqual([r.fetches, r.puts], [1, 1]);
  assert.equal(r.lastInit.cache, "no-store", "the index fetch never uses the edge cache (2a77675/e90e232)");
  assert.equal(r.lastInit.cf, undefined, "no cacheEverything: it stored a 404 for 30 min before the first publication");
  assert.deepEqual([...r.cacheMap.keys()], [CK], "written under the store's own key, not the bare URL");
  r.now += 5 * 60e3;
  const b = await s.get(URL_);
  assert.equal(b.source, "memory");
  assert.equal(b.ageMs, 5 * 60e3);
  assert.equal(r.fetches, 1);
});

test("past the TTL: the old copy is served AT ONCE and refreshed in the background (stale-while-revalidate); the next request has the new one", async () => {
  const r = rig(), s = r.store();
  await s.get(URL_);
  r.now += TTL_MS + 1;
  r.text = tweak(TEXT, (j) => { j.meta.builtAt = "2026-10-11T12:00:00.000Z"; });
  const w = waits();
  const stale = await s.get(URL_, w);
  assert.equal(stale.source, "memory-stale");
  assert.equal(stale.index.meta.builtAt, "2026-10-10T12:00:00.000Z", "the answer did not wait for the refresh");
  assert.equal(w.list.length, 1, "the refresh was handed to waitUntil");
  await Promise.all(w.list);
  const fresh = await s.get(URL_);
  assert.equal(fresh.source, "memory");
  assert.equal(fresh.index.meta.builtAt, "2026-10-11T12:00:00.000Z");
  assert.equal(r.fetches, 2);
});

test("a cold isolate whose edge cache is fresh reads that, not the network; one whose edge cache is older than the TTL goes to the network and updates it", async () => {
  const r = rig();
  r.cacheMap.set(CK, { text: TEXT, at: r.now - 10 * 60e3 });
  const a = await r.store().get(URL_);
  assert.equal(a.source, "cache");
  assert.equal(r.fetches, 0);
  r.cacheMap.set(CK, { text: TEXT, at: r.now - TTL_MS - 1 });
  const b = await r.store().get(URL_);
  assert.equal(b.source, "network");
  assert.equal(r.fetches, 1);
  assert.equal(r.cacheMap.get(CK).at, r.now, "the Cache API holds the new copy");
});

test("the published file is down: the newest copy anywhere is served (memory, then the edge cache) and the failure is logged", async () => {
  const r = rig(), s = r.store();
  await s.get(URL_);
  r.up = false;
  r.now += 5 * 24 * 3600e3; // five days: past the day in which a stale copy is served while refreshing, inside the week in which it is served when the source is down
  const a = await s.get(URL_);
  assert.equal(a.source, "memory-stale");
  assert.ok(r.logs.some((l) => l.event === "index-unavailable"), JSON.stringify(r.logs));
  // a new isolate with nothing in memory but an old copy in the edge cache
  const b = await r.store().get(URL_);
  assert.equal(b.source, "cache-stale");
  assert.ok(b.ageMs > TTL_MS);
});

test("while the source is down it is not asked again on every request (one try a minute), and it is asked again when the minute is over", async () => {
  const r = rig(), s = r.store();
  await s.get(URL_);
  r.up = false;
  r.now += REVALIDATE_MS + 1; // too old for a background refresh: the next request must try, and fail
  await s.get(URL_);
  const after = r.fetches;
  for (let i = 0; i < 5; i++) { r.now += 1000; await s.get(URL_); }
  assert.equal(r.fetches, after, "no fetch during the minute");
  r.now += RETRY_MS;
  await s.get(URL_);
  assert.equal(r.fetches, after + 1);
});

test("past the TTL with the source down: the old copy is served at once, and the dead source is tried once a minute, not once a request", async () => {
  const r = rig(), s = r.store();
  await s.get(URL_);
  r.up = false;
  r.now += TTL_MS + 1;
  const w = waits();
  assert.equal((await s.get(URL_, w)).source, "memory-stale");
  await Promise.all(w.list);
  const tried = r.fetches;
  assert.equal(tried, 2, "the background refresh tried once and failed");
  for (let i = 0; i < 5; i++) { r.now += 1000; const w2 = waits(); await s.get(URL_, w2); await Promise.all(w2.list); }
  assert.equal(r.fetches, tried, "not again within the minute");
  assert.equal(w.list.length, 1);
  r.now += RETRY_MS;
  const w3 = waits();
  await s.get(URL_, w3);
  await Promise.all(w3.list);
  assert.equal(r.fetches, tried + 1, "and again when the minute is over");
});

test("a copy in memory older than 7 days is not served either, whatever the source says: an index that old would show films you have seen since", async () => {
  const r = rig(), s = r.store();
  await s.get(URL_);
  r.up = false;
  r.now += MAX_STALE_MS + 1;
  assert.equal(await s.get(URL_), null);
  r.up = true;
  assert.equal(await s.get(URL_), null, "with nothing servable the source is not asked on every request either");
  r.now += RETRY_EMPTY_MS;
  assert.equal((await s.get(URL_)).source, "network", "and when the source is back it is read again, after ten seconds");
});

test("nothing anywhere: get() is null (the caller answers with an empty page), and it is logged; a copy older than 7 days is not served even if it is all there is", async () => {
  const r = rig({ up: false });
  assert.equal(await r.store().get(URL_), null);
  assert.ok(r.logs.some((l) => l.event === "index-unavailable" && l.haveMemory === false && l.haveCache === false));
  r.cacheMap.set(CK, { text: TEXT, at: r.now - MAX_STALE_MS - 1 });
  assert.equal(await r.store().get(URL_), null, "eight days old");
  r.cacheMap.set(CK, { text: TEXT, at: r.now - MAX_STALE_MS + 60e3 });
  assert.equal((await r.store().get(URL_)).source, "cache-stale", "six days and 23 hours");
});

test("a bad answer never replaces a good copy: an HTTP error, text that is not JSON, JSON of another schema, an index with no films", async () => {
  for (const [label, patch] of [
    ["HTTP 500", { status: 500 }], ["not JSON", { text: "<html>Pages is down</html>" }], ["another schema", { text: tweak(TEXT, (j) => { j.meta.schema = 2; }) }], ["objects instead of rows", { text: tweak(TEXT, (j) => { j.meta.format = "objects"; }) }], ["other columns", { text: tweak(TEXT, (j) => { j.cols = ["tt", "name"]; }) }],
    ["no films", { text: JSON.stringify({ meta: { schema: 1 }, rows: {} }) }], ["empty file", { text: "" }],
  ]) {
    const r = rig(), s = r.store();
    const good = await s.get(URL_);
    r.now += TTL_MS + 1;
    Object.assign(r, patch);
    const w = waits();
    const got = await s.get(URL_, w);
    await Promise.all(w.list);
    assert.equal(got.index, good.index, label);
    assert.equal((await s.get(URL_)).index, good.index, `${label}: still the good copy afterwards`);
    assert.ok(r.logs.some((l) => l.event === "index-unavailable"), label);
    assert.equal(r.cacheMap.get(CK).at, 1_000_000, `${label}: the Cache API still holds the good copy`);
  }
});

test("many requests at once on a cold isolate share one fetch (the Board asks 18 times together)", async () => {
  const r = rig(), s = r.store();
  const all = await Promise.all(Array.from({ length: 18 }, () => s.get(URL_)));
  assert.equal(r.fetches, 1);
  assert.ok(all.every((g) => g.index === all[0].index));
});

// Owner review of 8e37c23, item 2, 20/10/2026: the Will branch loaded ONE file at a time per isolate, the Cache API read included, for Marco's files too (a fast piece asked
// together with a 3 s piece waited 3058 ms on the branch against 62 ms on main; 10 pieces of 50 ms together took 3590 ms against 65 ms). Marco's files are back to main's rule: one load
// per URL (shared by every caller), different URLs in parallel. A fake fetch with a delay per URL stands in for GitHub Pages; the slow piece is held open by a gate (it stays unanswered far
// beyond the 300 ms bound, like the 3 s of the review) and released at the end so the test does not wait for it.
const DATA = "https://example.test/data/";
function delayedRig(delays) {
  const r = { fetches: [], gates: new Map(), logs: [] };
  r.fetchImpl = async (url) => {
    r.fetches.push(url);
    const d = delays[url.slice(DATA.length)] ?? 50;
    if (d === "gate") await new Promise((resolve) => r.gates.set(url, resolve));
    else await new Promise((resolve) => setTimeout(resolve, d));
    return new Response(TEXT);
  };
  r.store = (extra = {}) => createStore({ fetchImpl: r.fetchImpl, caches: undefined, log: (o) => r.logs.push(o), ...extra });
  return r;
}
test("a fast piece asked together with a slow one is answered in under 300 ms: Marco's files are not queued behind each other", async () => {
  const r = delayedRig({ "index-list-slow.json": "gate", "index-list-fast.json": 50 }), s = r.store();
  const slow = s.get(DATA + "index-list-slow.json");
  const t0 = performance.now();
  const fast = await s.get(DATA + "index-list-fast.json");
  const took = performance.now() - t0;
  assert.ok(fast && fast.index.films.length, "the fast piece was served");
  assert.ok(took < 300, `the fast piece waited ${Math.round(took)} ms behind the slow one`);
  assert.equal(r.fetches.length, 2, "both started at once");
  r.gates.get(DATA + "index-list-slow.json")();
  assert.ok((await slow).index);
});
test("10 pieces of 50 ms asked together finish in under 500 ms in all (parallel, not 10 x 50 ms in a row behind the other work)", async () => {
  const r = delayedRig({}), s = r.store({ pieceMax: 20 });
  const t0 = performance.now();
  const got = await Promise.all(Array.from({ length: 10 }, (_, n) => s.get(`${DATA}index-list-${n}.json`)));
  const took = performance.now() - t0;
  assert.ok(got.every((g) => g && g.index));
  assert.ok(took < 500, `10 pieces took ${Math.round(took)} ms`);
  assert.equal(r.fetches.length, 10);
  // And with one of them stuck, the other nine are still answered at once.
  const stuck = delayedRig({ "index-list-0.json": "gate" }), s2 = stuck.store({ pieceMax: 20 });
  const first = s2.get(`${DATA}index-list-0.json`);
  const t1 = performance.now();
  await Promise.all(Array.from({ length: 9 }, (_, n) => s2.get(`${DATA}index-list-${n + 1}.json`)));
  assert.ok(performance.now() - t1 < 500, "nine pieces waited for the stuck tenth");
  stuck.gates.get(`${DATA}index-list-0.json`)();
  await first;
});
test("the same URL asked twice at the same time makes one fetch and both callers get the same index", async () => {
  const r = delayedRig({}), s = r.store();
  const [a, b] = await Promise.all([s.get(DATA + "index-list-x.json"), s.get(DATA + "index-list-x.json")]);
  assert.equal(r.fetches.length, 1);
  assert.equal(a.index, b.index);
});
test("Will's files (the /u/ paths) still load one at a time per isolate; Marco's loads are not behind them", async () => {
  const WILL = "https://example.test/u/friend-a/r/";
  let running = 0, max = 0;
  const fetchImpl = async (url) => {
    running++; max = Math.max(max, running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    running--;
    return new Response(TEXT);
  };
  // Will's parse is refused (identity), but the load still goes through the queue: only the fetches matter here.
  const s = createStore({ fetchImpl, caches: undefined, log: () => {} });
  await Promise.all(Array.from({ length: 4 }, (_, n) => s.get(`${WILL}r-${String(n).repeat(32)}/data/index.json`)));
  assert.equal(max, 1, "Will's four loads overlapped");
  max = 0;
  await Promise.all(Array.from({ length: 4 }, (_, n) => s.get(`${DATA}index-list-${n}.json`)));
  assert.equal(max, 4, "Marco's four loads did not run together");
});

// Owner review of 8e37c23, items 3 and 7, 20/10/2026: the 24 MiB aggregate ceiling (and the 128 slots) were put over Marco's resident files too. Measured with curl on Pages that day,
// Marco's resident files in the measured scenario are 24,537,733 bytes (97.5% of 25,165,824; the whole family with the 54th row slice friends-week is 58 files, 24,586,962 bytes, 97.7%): an isolate that opened the Board, Explore, a profile and 8 pieces and then asked its 57 resident files again
// refetched 57 of them and logged 64 `aggregate-evicted` (main: 0; the sum is 57 files, 4 + 53 row slices; first written 58 and 65, re-measured 20/10/2026). The ceiling is for the files under /u/ (Will); Marco's stay for the life of the isolate and are not even measured
// (the TextEncoder pass cost 13.4 ms on index-v2 against 28.1 ms for its JSON parse). No byte is downloaded here: a fake fetch hands out a 1 MB body per URL.
test("Marco's resident files add up to more than the 24 MiB ceiling and none is let go: asked all again, 0 new fetch and 0 aggregate-evicted", async () => {
  const padded = tweak(TEXT, (j) => { j.meta.pad = "x".repeat(1024 * 1024); });
  const logs = [], fetched = [];
  const s = createStore({ fetchImpl: async (url) => { fetched.push(url); return new Response(padded); }, caches: undefined, log: (o) => logs.push(o) });
  const urls = ["index.json", "index-board.json", "index-v2.json", "index-v2-menus.json", ...Array.from({ length: 30 }, (_, n) => `index-v2-row-${n}.json`)].map((f) => "https://example.test/data/" + f);
  for (const u of urls) await s.get(u);
  assert.ok(urls.length * padded.length > AGGREGATE_INDEX_BYTES, "planted: more text than the ceiling");
  assert.equal(fetched.length, urls.length);
  for (const u of urls) { const got = await s.get(u); assert.equal(got.source, "memory", u); }
  assert.equal(fetched.length, urls.length, "no new fetch");
  assert.deepEqual(logs.filter((l) => l.event === "aggregate-evicted"), []);
  assert.ok(urls.every((u) => s._slots.get(u).index), "every one still in memory");
});
test("Marco's pieces (lists, moods) are bounded by the piece queue only, not by the aggregate ceiling; more than 128 distinct URLs keep their slots", async () => {
  const logs = [];
  const s = createStore({ fetchImpl: async () => new Response(TEXT), caches: undefined, log: (o) => logs.push(o), pieceMax: 500, pieceBytes: 1e12 });
  for (let n = 0; n < 140; n++) await s.get(`https://example.test/data/index-list-${n}.json`);
  assert.equal(s._slots.size, 140, "no limit of 128 slots on Marco's URLs (main has none)");
  assert.deepEqual(logs.filter((l) => l.event === "aggregate-evicted"), []);
  const tiny = createStore({ fetchImpl: async () => new Response(TEXT), caches: undefined, log: (o) => logs.push(o), aggregateBytes: 10, aggregateSlots: 2 });
  for (const f of ["index.json", "index-v2.json", "index-v2-menus.json", "index-board.json"]) await tiny.get("https://example.test/data/" + f);
  assert.equal(tiny._slots.size, 4, "a ceiling of 10 bytes and 2 slots does not touch Marco's files");
  assert.deepEqual(logs.filter((l) => l.event === "aggregate-evicted"), []);
});
test("Marco's files are not measured: no TextEncoder pass on a load (Will's, whose size the ceiling needs, are)", async () => {
  const real = TextEncoder.prototype.encode;
  const body = real.call(new TextEncoder(), TEXT); // the fake network answers with bytes, so that building the Response (undici encodes a string body) is not counted
  let encoded = 0;
  TextEncoder.prototype.encode = function (...a) { encoded++; return real.apply(this, a); };
  try {
    const s = createStore({ fetchImpl: async () => new Response(body), caches: undefined, log: () => {} });
    await s.get("https://example.test/data/index-v2.json");
    await s.get("https://example.test/data/index-list-a.json");
    assert.equal(encoded, 0, "Marco's loads called TextEncoder.encode");
    assert.equal(s._slots.get("https://example.test/data/index-v2.json").bytes, 0);
    const willText = tweak(TEXT, (j) => { j.meta.personId = "friend-a"; j.meta.revision = "r-" + "1".repeat(32); });
    const willBody = real.call(new TextEncoder(), willText);
    const will = createStore({ fetchImpl: async () => new Response(willBody), caches: undefined, log: () => {} });
    const got = await will.get("https://example.test/u/friend-a/r/r-" + "1".repeat(32) + "/data/index.json");
    assert.ok(got && got.index, "Will's index loaded");
    assert.equal(encoded, 1, "Will's load is measured once");
    assert.equal(will._slots.get("https://example.test/u/friend-a/r/r-" + "1".repeat(32) + "/data/index.json").bytes, willBody.length, "UTF-8 bytes");
  } finally { TextEncoder.prototype.encode = real; }
});

test("no Cache API at all (a runtime without caches.default) still works; one that throws is logged and skipped", async () => {
  const a = rig({ withCache: false });
  assert.equal((await a.store().get(URL_)).source, "network");
  const b = rig();
  b.caches = { default: { match: async () => { throw new Error("boom"); }, put: async () => { throw new Error("boom"); } } };
  assert.equal((await b.store().get(URL_)).source, "network");
  assert.deepEqual(b.logs.map((l) => l.event).sort(), ["cache-read-failed", "cache-write-failed"]);
});

test("parseIndex: the schema this Worker reads is 1, with films and rows", () => {
  assert.equal(parseIndex(TEXT).meta.schema, 1);
  assert.equal(parseIndex(TEXT).films[0].constructor.name, "Film");
  for (const bad of ["null", "[]", "{}", '{"meta":{"schema":1},"films":[]}', '{"meta":{"schema":3,"format":"rows"},"films":[],"rows":{}}', '{"meta":{"schema":1},"films":[],"rows":{}}']) assert.throws(() => parseIndex(bad), bad);
});

test("an edge-cache entry at the bare URL (the 404 stored before the first publication) is never read back as the index", async () => {
  const r = rig();
  r.cacheMap.set(URL_, { text: "<html>404</html>", at: r.now - 60e3 });
  const a = await r.store().get(URL_);
  assert.equal(a.source, "network");
  assert.equal(r.fetches, 1);
  assert.equal(r.cacheMap.get(CK).at, r.now);
});

// ── a time limit and a size limit on the fetch of the index (W2, 13/10/2026: `fetchImpl(url)` + `res.text()` had neither; the real index.json is 6.579.269 bytes) ──

/** A store whose limits are the test's, over the rig's clock, cache and log. */
const limited = (r, o = {}) => createStore({ fetchImpl: r.fetchImpl, caches: r.caches, now: () => r.now, log: (x) => r.logs.push(x), ...o });
/** A body that streams `total` bytes in chunks of `chunk` (a stream pulls one chunk ahead of its reader), and remembers whether it was cancelled and how many chunks were pulled. */
function streamOf(total, chunk, state) {
  let sent = 0;
  return new ReadableStream({ pull(c) { const n = Math.min(chunk, total - sent); if (!n) return c.close(); sent += n; state.pulled = (state.pulled || 0) + 1; c.enqueue(new Uint8Array(n).fill(32)); }, cancel() { state.cancelled = true; } });
}

test("the limits are 20 seconds and 16 MB: the index is 6.579.269 bytes today (13/10/2026, 21:05 GMT), so the limit is 2,4 times that, and the build refuses a gzip over 4 MB (about 12 MB decompressed)", () => {
  assert.equal(INDEX_FETCH_TIMEOUT_MS, 20e3);
  assert.equal(MAX_INDEX_BYTES, 16e6);
  assert.ok(MAX_INDEX_BYTES > 2 * 6_579_269 && MAX_INDEX_BYTES < 3 * 6_579_269);
  assert.ok(MAX_INDEX_BYTES > 4e6 * 3.07, "above what the build lets out (4 MB gzipped, ratio 3,07 measured on 13/10/2026)");
});

test("a fetch that never answers is given up inside the time limit, with or without the signal being heeded: the old copy is kept, the failure is logged as a timeout, and the source is not asked again for a minute", { timeout: 5000 }, async () => {
  for (const heeds of [false, true]) {
    const r = rig();
    const good = await limited(r).get(URL_); // a good copy in memory and in the Cache API
    r.now += REVALIDATE_MS + 1; // too old to be served while refreshing: the next request waits for the fetch
    let signal = null;
    r.fetchImpl = (url, init) => { r.fetches++; signal = init.signal; return new Promise((_, reject) => { if (heeds) init.signal.addEventListener("abort", () => reject(new Error("aborted"))); }); }; // (never resolves)
    const s = limited(r, { fetchTimeoutMs: 30 });
    const t0 = Date.now(); // (a new isolate: it reads the Cache API, which is older than the TTL, then goes to the network)
    const got = await s.get(URL_);
    assert.ok(Date.now() - t0 < 1000, `${heeds}: gave up in time`);
    assert.equal(got.source, "cache-stale", `${heeds}: the copy in the Cache API is served`);
    assert.equal(got.index.meta.builtAt, good.index.meta.builtAt);
    assert.ok(signal instanceof AbortSignal && signal.aborted, `${heeds}: the fetch got a signal, and it was aborted when the time ran out`);
    const limit = r.logs.filter((l) => l.event === "index-fetch-limit");
    assert.deepEqual(limit.map((l) => l.reason), ["timeout"], `${heeds}: logged once, as a timeout`);
    assert.ok(r.logs.some((l) => l.event === "index-unavailable" && l.haveCache === true), `${heeds}: and as an ordinary failure of the network`);
    assert.equal(r.cacheMap.get(CK).at, 1_000_000, `${heeds}: the Cache API still holds the good copy`);
    const tried = r.fetches;
    assert.equal(tried, 2, `${heeds}: one fetch for the good copy, one for the one that hung`);
    await s.get(URL_);
    assert.equal(r.fetches, tried, `${heeds}: not asked again within the minute (failedAt was set)`);
  }
});

test("a fetch that never answers with nothing in hand: null, in time", { timeout: 5000 }, async () => {
  const r = rig();
  r.fetchImpl = () => new Promise(() => {});
  assert.equal(await limited(r, { fetchTimeoutMs: 30 }).get(URL_), null);
  assert.deepEqual(r.logs.filter((l) => l.event === "index-fetch-limit").map((l) => l.reason), ["timeout"]);
});

test("the time limit covers the body too: headers at once, then a body that stalls", { timeout: 5000 }, async () => {
  const r = rig();
  r.fetchImpl = async (url, init) => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10).fill(32)); /* and then nothing */ init.signal.addEventListener("abort", () => { try { c.error(new Error("aborted")); } catch { /* closed */ } }); } }), { status: 200 });
  assert.equal(await limited(r, { fetchTimeoutMs: 30 }).get(URL_), null);
  assert.deepEqual(r.logs.filter((l) => l.event === "index-fetch-limit").map((l) => l.reason), ["timeout"]);
});

test("a body one byte over the limit (streamed, no length declared) is refused and cancelled; exactly at the limit it is read; the copy in hand stays", async () => {
  const bytes = new TextEncoder().encode(TEXT).byteLength;
  // exactly at the limit: read
  const ok = rig();
  assert.equal((await limited(ok, { maxIndexBytes: bytes }).get(URL_)).source, "network", "a file of exactly the limit is read");
  // one over: refused
  const r = rig();
  const good = await limited(r).get(URL_);
  r.now += REVALIDATE_MS + 1;
  const state = {};
  r.fetchImpl = async () => { r.fetches++; return new Response(streamOf(5010, 501, state), { status: 200 }); }; // (a body of 5010 bytes: over the limit of 1000 at the second chunk; it ends, so that a Worker without the limit would read it all and the test would see it)
  const s = limited(r, { maxIndexBytes: 1000 });
  const got = await s.get(URL_);
  assert.equal(got.source, "cache-stale");
  assert.equal(got.index.meta.builtAt, good.index.meta.builtAt);
  assert.equal(state.cancelled, true, "the stream was cancelled at the limit");
  assert.ok(state.pulled <= 4, `and not read to the end (${state.pulled} chunks pulled)`);
  assert.deepEqual(r.logs.filter((l) => l.event === "index-fetch-limit").map((l) => l.reason), ["too-large"]);
  assert.ok(r.logs.some((l) => l.event === "index-unavailable"));
  assert.equal(r.cacheMap.get(CK).at, 1_000_000, "the Cache API still holds the good copy");
  // one byte under the real index's size minus one: the exact limit above passes, this fails
  const under = rig();
  assert.equal(await limited(under, { maxIndexBytes: bytes - 1 }).get(URL_), null);
  assert.deepEqual(under.logs.filter((l) => l.event === "index-fetch-limit").map((l) => l.reason), ["too-large"]);
});

test("a declared length over the default 16 MB is refused unread", async () => {
  const r = rig();
  const state = {};
  r.fetchImpl = async () => new Response(streamOf(10, 10, state), { status: 200, headers: { "content-length": String(MAX_INDEX_BYTES + 1) } });
  assert.equal(await limited(r).get(URL_), null);
  assert.deepEqual(r.logs.filter((l) => l.event === "index-fetch-limit").map((l) => l.reason), ["too-large"]);
  assert.ok(state.pulled <= 1, "not read: at most the one chunk a stream pulls ahead by itself");
  assert.equal(state.cancelled, true);
});

test("an HTTP error is not a limit: it is not logged as index-fetch-limit", async () => {
  const r = rig({ status: 500 });
  assert.equal(await r.store().get(URL_), null);
  assert.equal(r.logs.filter((l) => l.event === "index-fetch-limit").length, 0);
});

// ── a ceiling on the pieces held in memory (14/10/2026) ──────────────────────

const PIECE = (n) => `https://example.test/data/index-list-${n}.json`;
const BIG = (mb) => tweak(TEXT, (j) => { j.meta.pad = "x".repeat(mb * 1e6); }); // a valid index whose text is about `mb` MB
const counting = (r) => { r.matches = []; const m = r.caches.default.match; r.caches.default.match = async (url) => { r.matches.push(url); return m(url); }; };

test("the defaults: 12 pieces and 48 MB; the whole index, the Board's small part and the v2 whole index, menus and ROW slices are permanent, every other file (a list, the moods, the friends, the directors, a v2 mood slice) is a piece", () => {
  assert.deepEqual([PIECE_CACHE_MAX, PIECE_CACHE_BYTES], [12, 48e6]);
  for (const f of ["index.json", "index-board.json", "index-v2.json", "index-v2-menus.json", "index-v2-row-tonight.json", "index-v2-row-after-midnight.json", "index-v2-row-1970s.json"]) assert.equal(isPermanent(`https://example.test/data/${f}`), true, f);
  for (const f of ["index-list-poxvK.json", "index-moods.json", "index-friends.json", "index-directors.json", "index-v2-mood-slow.json", "index-v2-mood-wander.json", "index-board.json.bak", "index-v2-menus.json.bak", "index-v2-row-tonight.json.bak"]) assert.equal(isPermanent(`https://example.test/data/${f}`), false, f);
  assert.equal(isPermanent("https://example.test/data/index.json?x=1"), true);
  assert.equal(isOptional("https://example.test/data/index-v2-menus.json"), true);
  assert.equal(isOptional("https://example.test/data/index-v2.json"), true);
  for (const f of ["index.json", "index-board.json", "index-v2-row-tonight.json", "index-v2-mood-slow.json", "index-list-poxvK.json"]) assert.equal(isOptional(`https://example.test/data/${f}`), false, f);
});

// ── a site with no board (14/10/2026): index-v2-menus.json and index-v2.json answer 404, and that is not an error ─────────────────────────────

const MENUS = "https://example.test/data/index-v2-menus.json", V2WHOLE = "https://example.test/data/index-v2.json";

test("a 404 on index-v2-menus.json or index-v2.json is remembered as absent for one TTL: no fetch, no cache read, no error log in between; said once per isolate as `v2-absent`; asked again when the TTL is over", async () => {
  const r = rig({ status: 404 }), s = r.store();
  const reads = [];
  const match = r.caches.default.match;
  r.caches.default.match = async (url) => { reads.push(url); return match(url); };
  assert.equal(await s.get(MENUS), null);
  assert.equal(await s.get(V2WHOLE), null);
  assert.deepEqual(r.logs, [{ event: "v2-absent", url: MENUS }], "one line for the isolate, not an index-unavailable for each file");
  assert.equal(r.fetches, 2);
  for (const t of [RETRY_EMPTY_MS + 1, 60e3, 10 * 60e3, 15 * 60e3]) { r.now += t; assert.equal(await s.get(MENUS), null); assert.equal(await s.get(V2WHOLE), null); }
  assert.equal(r.fetches, 2, "26 minutes later still nothing asked: the 10 seconds of any other failure do not apply");
  assert.equal(reads.length, 2, "and the Cache API was read once for each file, not on each request");
  r.now += 5 * 60e3; // 30 minutes and 11 seconds since the first 404
  r.status = 200; r.text = TEXT;
  const got = await s.get(MENUS);
  assert.ok(got && got.source === "network", "once the TTL is over the file is asked for again, and a site that published its board has it");
  assert.equal(r.fetches, 3);
  assert.deepEqual(r.logs.map((l) => l.event), ["v2-absent"], "and nothing else was logged");
});

test("any other file, or any other failure, keeps its behaviour: a 404 on a list piece is an index-unavailable, retried after 10 seconds; a 500 or a network error on the v2 menus too", async () => {
  const r = rig({ status: 404 }), s = r.store();
  assert.equal(await s.get(URL_), null);
  assert.deepEqual(r.logs.map((l) => l.event), ["index-unavailable"]);
  r.now += RETRY_EMPTY_MS;
  assert.equal(await s.get(URL_), null);
  assert.equal(r.fetches, 2);
  const e = rig({ status: 500 }), t = e.store();
  assert.equal(await t.get(MENUS), null);
  assert.deepEqual(e.logs.map((l) => l.event), ["index-unavailable"], "a 500 is an outage, not an absence");
  e.now += RETRY_EMPTY_MS;
  await t.get(MENUS);
  assert.equal(e.fetches, 2);
  const d = rig({ up: false }), u = d.store();
  await u.get(MENUS);
  assert.deepEqual(d.logs.map((l) => l.event), ["index-unavailable"]);
});

test("13 pieces of 1 MB with a limit of 12: the first one is let go of memory, the Cache API is asked for it again (not the network), the other 12 stay", async () => {
  const r = rig({ text: BIG(1) }), s = r.store();
  counting(r);
  for (let n = 1; n <= 13; n++) await s.get(PIECE(n));
  assert.equal(r.fetches, 13);
  assert.equal(s._lru.size, 12);
  assert.equal(s._slots.get(PIECE(1)).index, null, "the first is gone from memory");
  assert.ok([...s._lru.keys()].every((u) => u !== PIECE(1)) && s._slots.get(PIECE(13)).index, "the last is in");
  assert.deepEqual(r.logs.filter((l) => l.event === "piece-evicted").map((l) => l.url), [PIECE(1)]);
  r.matches.length = 0;
  const again = await s.get(PIECE(1));
  assert.equal(again.source, "cache", "read back from the Cache API (fresh by the TTL)");
  assert.deepEqual(r.matches, [PIECE(1) + "?store=index"], "the Cache API was asked for exactly that piece");
  assert.equal(r.fetches, 13, "no new fetch of the network");
  assert.equal(s._slots.get(PIECE(2)).index, null, "and it took the place of the next oldest");
  r.matches.length = 0;
  await s.get(PIECE(13));
  assert.deepEqual(r.matches, [], "a piece still in memory does not ask the Cache API");
});

test("a get moves a piece to the end of the queue: the one used longest ago is the one let go", async () => {
  const r = rig({ text: BIG(1) }), s = r.store();
  for (let n = 1; n <= 12; n++) await s.get(PIECE(n));
  await s.get(PIECE(1)); // used again: now the newest
  await s.get(PIECE(13));
  assert.ok(s._slots.get(PIECE(1)).index, "piece 1 was used last-but-one: it stays");
  assert.equal(s._slots.get(PIECE(2)).index, null, "piece 2 was not used since the start: it goes");
  assert.deepEqual([...s._lru.keys()].slice(-2), [PIECE(1), PIECE(13)], "piece 1 is second from the end, piece 13 the last");
  assert.equal([...s._lru.keys()].pop(), PIECE(13));
});

// Found in the re-review of 1fa2b15, 20/10/2026 (store.js `refresh`, the `finally`): `touch(url)` ran after EVERY load, so a Marco piece whose fetch failed (HTTP 500) or came back empty
// (0 bytes: not JSON) entered the 12-piece queue with size 0 and pushed out a good piece. The suite stayed green (62/62) with the unconditional touch; `if (queued) touch(url)` kept
// the failed Marco piece out (20/10/2026, S8: the touch in that `finally` is gone for every URL, so a failed Will load enters no queue either: test/will-queue.test.js). Here: 12 good pieces, then one that answers 500 and one that answers 0 bytes, then the 12 again: 0 new fetch, 0 read of the Cache API, 0 `piece-evicted`.
test("a Marco piece that fails (500) or arrives empty (0 bytes) does not enter the 12-piece queue and does not push a good piece out", async () => {
  const r = rig({ text: BIG(1) }), s = r.store();
  counting(r);
  for (let n = 1; n <= 12; n++) await s.get(PIECE(n));
  assert.equal(s._lru.size, 12);
  r.status = 500;
  assert.equal(await s.get(PIECE(13)), null);
  r.status = 200; r.text = "";
  assert.equal(await s.get(PIECE(14)), null);
  assert.deepEqual(r.logs.filter((l) => l.event === "index-unavailable").map((l) => l.url), [PIECE(13), PIECE(14)], "both failures were seen");
  assert.deepEqual([...s._lru.keys()], Array.from({ length: 12 }, (_, n) => PIECE(n + 1)), "the queue is the 12 good pieces, in order, and nothing else");
  const fetches = r.fetches;
  r.matches.length = 0;
  for (let n = 1; n <= 12; n++) assert.equal((await s.get(PIECE(n))).source, "memory", PIECE(n));
  assert.equal(r.fetches, fetches, "no new fetch");
  assert.deepEqual(r.matches, [], "no read of the Cache API");
  assert.deepEqual(r.logs.filter((l) => l.event === "piece-evicted"), [], "no good piece was let go");
});

test("the limit by text: 4 pieces of 1 MB under a limit of 3 MB leave 3; one piece larger than the limit is kept, alone", async () => {
  const r = rig({ text: BIG(1) });
  const s = createStore({ fetchImpl: r.fetchImpl, caches: r.caches, now: () => r.now, log: (o) => r.logs.push(o), pieceBytes: 3.5e6 });
  for (let n = 1; n <= 4; n++) await s.get(PIECE(n));
  assert.equal(s._lru.size, 3);
  assert.equal(s._slots.get(PIECE(1)).index, null);
  const tiny = createStore({ fetchImpl: r.fetchImpl, caches: r.caches, now: () => r.now, log: () => {}, pieceBytes: 1000 });
  await tiny.get(PIECE(1));
  assert.ok(tiny._slots.get(PIECE(1)).index, "the piece being served is never the one let go");
  assert.equal((await tiny.get(PIECE(1))).source, "memory", "and used again from memory (a hit touches it: still not the one let go)");
  assert.ok(tiny._slots.get(PIECE(1)).index);
  await tiny.get(PIECE(2));
  assert.deepEqual([...tiny._lru.keys()], [PIECE(2)], "the next one pushes it out, and stays alone in its turn");
});

test("the whole index and the Board's piece are never let go, however many pieces come after them, and they are not counted in the queue", async () => {
  const r = rig({ text: BIG(1) }), s = r.store();
  const board = "https://example.test/data/index-board.json";
  await s.get(URL_);
  await s.get(board);
  for (let n = 1; n <= 30; n++) await s.get(PIECE(n));
  assert.ok(s._slots.get(URL_).index && s._slots.get(board).index);
  assert.equal(s._lru.size, 12);
  assert.ok(!s._lru.has(URL_) && !s._lru.has(board));
  const before = r.fetches;
  assert.equal((await s.get(URL_)).source, "memory");
  assert.equal(r.fetches, before);
});

test("a piece let go of memory is still in the Cache API: asked again with the network dead, it is read from there", async () => {
  const r = rig({ text: BIG(1) }), s = r.store();
  for (let n = 1; n <= 13; n++) await s.get(PIECE(n));
  r.up = false;
  const back = await s.get(PIECE(1));
  assert.equal(back.source, "cache", "the evicted piece is still there for the Cache API (layer 2), the network is not needed");
  assert.ok(back.index.films.length > 0);
});

// ── the pieces of the Discover's options (29/10/2026; review of 408d3cc) ──────────────────────────────────────────────────────────────────────────────────────

const OPT = "https://example.test/data/index-v2-opt-genres-g-drama.json";

test("an option's piece is optional and is told apart (isOptionPiece); its fetch has a 2 s deadline of its own, the other files keep the 20 s", async () => {
  assert.equal(isOptionPiece(OPT), true);
  assert.equal(isOptional(OPT), true);
  for (const f of ["index-v2.json", "index-v2-mood-slow.json", "index-v2-opt.json", "index-v2-OPT-x.json", "index-list-poxvK.json"]) assert.equal(isOptionPiece(`https://example.test/data/${f}`), false, f);
  assert.equal(OPTION_PIECE_TIMEOUT_MS, 2000);
  const stuck = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const logs = [];
  const s = createStore({ fetchImpl: stuck, caches: undefined, fetchTimeoutMs: 300, optionPieceTimeoutMs: 20, log: (o) => logs.push(o) });
  const t0 = Date.now();
  assert.equal(await s.get(OPT), null);
  assert.ok(Date.now() - t0 < 200, `${Date.now() - t0} ms: the piece's 20 ms, not the file's 300 ms`);
  assert.deepEqual(logs.map((o) => o.event), ["index-fetch-limit", "index-unavailable"]);
  const t1 = Date.now();
  assert.equal(await s.get(V2WHOLE.replace("index-v2.json", "index-v2-mood-slow.json")), null);
  assert.ok(Date.now() - t1 >= 250, "any other file waits for the general deadline");
});

test("fresh(url): true for a file in memory under the TTL, false when it is not there, when it failed and when the TTL is over", async () => {
  const r = rig(), s = r.store();
  assert.equal(s.fresh(V2WHOLE), false, "never fetched");
  assert.ok(await s.get(V2WHOLE));
  assert.equal(s.fresh(V2WHOLE), true);
  r.now += TTL_MS - 1;
  assert.equal(s.fresh(V2WHOLE), true, "one millisecond before the TTL");
  r.now += 1;
  assert.equal(s.fresh(V2WHOLE), false, "at the TTL: the handler goes back to the piece");
  const down = rig({ status: 404 }), d = down.store();
  await d.get(V2WHOLE);
  assert.equal(d.fresh(V2WHOLE), false, "a 404 is not a fresh copy");
});
