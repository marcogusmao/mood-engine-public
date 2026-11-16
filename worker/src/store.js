// Where the index comes from, and what happens when it cannot be had.
//
// Three layers, nearest first:
//   1. memory of this isolate      fresh for `ttlMs` (30 min). Past that but under a day old: served AT ONCE and refreshed in the
//                                  background (stale-while-revalidate), so nobody waits for the refresh.
//   2. the Cache API of the edge   shared by every isolate in the data centre. Written with the time it was fetched.
//   3. the published file          GitHub Pages. `cf.cacheEverything` also lets Cloudflare's own cache answer.
// When the published file cannot be reached, the newest copy anywhere is served for up to 7 days (stale-if-error) and the
// failure is logged; with nothing at all, get() returns null and the caller answers with an empty page.
//
// The memory layer has a ceiling (14/10/2026). The whole index and the Board's pieces (and the v2 family's whole index, menus and row slices) of Marco's site stay for the life of the isolate (Will's files, the /u/ paths, are bounded: 24 MiB and 128 slots, see AGGREGATE_INDEX_BYTES, and have a queue of their own, WILL_PIECE_CACHE_MAX pieces and WILL_PIECE_CACHE_BYTES of text, so they never evict a Marco piece); the other pieces (the piece of a Discover option, a list, the moods, the friends, the
// directors, a v2 mood slice) are kept least-recently-used first out, up to PIECE_CACHE_MAX pieces and PIECE_CACHE_BYTES of text (the length of the piece's text, which is what is measured; parsed it is
// about 2.5 times that). An evicted piece costs one read of the Cache API (layer 2), not a fetch. Measured 14/10/2026 on the real index: the 139 list pieces are 15 MB of text and
// about 40 MB of heap together (about 0.3 MB a piece, 1.5 MB at most), the whole index 7.2 MB of text and about 19 MB: an isolate has 128 MB.
//
// Injectable (fetch, caches, clock, log) so the tests can drive every path without a network.

import { hydrate } from "./film.js";
import { readBoundedText, TimedOut, TooBig, withDeadline } from "./subtitles-source.js";

const MIN = 60e3;
const HOUR = 60 * MIN;
export const TTL_MS = 30 * MIN;
export const REVALIDATE_MS = 24 * HOUR; // under this old, serve and refresh in the background
export const MAX_STALE_MS = 7 * 24 * HOUR; // over this old, the copy is not served even when the source is down
export const RETRY_MS = MIN; // after a failed refresh with an older copy in hand, do not try again for this long: a source that is down must not slow every request
export const RETRY_EMPTY_MS = 10e3; // with nothing in hand (or a file that is simply not there, like a missing index-board.json), try again sooner, but not on every request
export const SCHEMA = 1;
export const PIECE_CACHE_MAX = 12; // pieces (not the whole index, not the Board's) kept in memory
export const PIECE_CACHE_BYTES = 48e6; // and their text, together
// Will's files (the /u/ paths) have a queue of their own (S8 of the re-review of 1fa2b15, 20/10/2026): with the intake on they used to share Marco's 12 pieces, so Will's Board (54 rows) let go of
// 12 of 12 Marco pieces and a Will load that answered 503 did the same (measured: main 5c0be73 12 and 12, 1fa2b15 without S8 12 and 12, this branch 0 and 0). Own size and own byte ceiling, both inside the 24 MiB aggregate ceiling that is Will's alone (UTF-8 bytes
// of text, as the aggregate measures; 20 MB of text is about 44 MB of heap at the ratio 2.2 (54.7 MB of heap for 24.54 MB of text) measured in Node, not in workerd, next to Marco's 54.7 MB resident and his own 12-piece queue: about 122 to 124 of the 128 MB, see worker/README.md; the numbers 12 and 20e6 are a choice of the session of 20/10/2026, pending Marco's confirmation).
export const WILL_PIECE_CACHE_MAX = 12;
export const WILL_PIECE_CACHE_BYTES = 20e6;

/**
 * Public owner paths (/u/) always use the bounded LRU, including their full indexes and row slices.
 * The legacy address's preferred resident files: the whole index and the Board's small part, and the v2 family's whole index, menus and ROW slices. Every other file is a piece in the LRU: a list, the moods, the friends,
 * the directors, a v2 mood slice and, since 29/10/2026, the piece of one calculated option of the Discover (index-v2-opt-*: 168 of them on the offline build of 28/10/2026, 45 to 359 KB each). THEY SHARE THE SAME 12 PLACES with the mood slices and the lists: a reviewer of 29/10/2026 reproduced a mood slice (Uplift) fetched again after 12 options of Genres. The 54 row slices are preferred resident entries (14/10/2026, as bb86552 had them): the Board is opened row by row from one isolate, 54 slices through an LRU of 12 evict each other and every
 * second opening would re-read 40 of them from the Cache API; when retained, they are 5.78 MB of text, about 12.5 MB of heap, and the second opening is all `memory`.
 */
export const isPermanent = (url) => !new URL(url).pathname.includes("/u/") && /\/(index\.json|index-board\.json|index-v2\.json|index-v2-menus\.json|index-v2-row-[a-z0-9-]+\.json)(\?|$)/.test(url);

/** The files whose absence is the normal state of a site with no board (14/10/2026): a 404 on them is remembered for one TTL and is not an error. */
export const isOptional = (url) => /\/(index-v2\.json|index-v2-menus\.json|index-v2-opt-[a-z0-9-]+\.json)(\?|$)/.test(url);
/** The piece of one calculated option of the Discover (Marco, 29/10/2026; lib/index-export.js optionPieces). Its absence is normal on the night the Worker is published before the build that writes them, and the whole v2 index answers meanwhile. */
export const isOptionPiece = (url) => /\/index-v2-opt-[a-z0-9-]+\.json(\?|$)/.test(url);

/**
 * Will's files: anything under the owner path /u/ (the same test isPermanent uses). Marco's files (INDEX_URL and its family) are not. 20/10/2026 (owner review of 8e37c23, items 2, 3, 7):
 * only these are queued one at a time (see refresh), and only these count against the aggregate ceiling; Marco's files keep main's rules: loads of different URLs in parallel,
 * two requests for the same URL sharing one load, no ceiling on the permanent ones.
 */
export const isWillUrl = (url) => new URL(url).pathname.includes("/u/");

// The fetch of the index had no time limit and no size limit (13/10/2026). The limit on the body is 16 MB. The account: the real docs/data/index.json measured 6.579.269 bytes on
// 13/10/2026 at 21:05 GMT (gzip 2.142.713, ratio 3,07), so 16 MB is 2,4 times today's file; the build already refuses an index over 4 MB gzipped (verify.js MAX_INDEX_GZIP),
// which is about 12 MB once decompressed, so 16 MB is above anything the build lets out. What it costs in memory at the limit: the chunks (up to 16 MB), the joined copy (16 MB) and the text
// decoded from it (up to 32 MB, as the film names are not all ASCII and V8 then keeps two bytes a character), about 64 MB before the parse, in an isolate of 128 MB. The earlier 32 MB would have
// been twice that, the whole isolate. The time is generous for a file of that size from GitHub Pages. Going over either is an ordinary failure of the network: the copy in hand is kept and the next try waits.
export const INDEX_FETCH_TIMEOUT_MS = 20e3;
// The piece of a Discover option is an optimisation, never the only way to answer (the whole v2 index has every film): Pages not answering for it must not cost the request the 20 s above (reviewed 29/10/2026: 20,044 ms for Drama page 1 with the whole index already in memory, 37 ms with a fast 404). Its fetch gets this deadline, or the general one if that is shorter.
export const OPTION_PIECE_TIMEOUT_MS = 2e3;
export const MAX_INDEX_BYTES = 16e6;

export const AGGREGATE_INDEX_BYTES = 24 * 1024 * 1024;
export const AGGREGATE_INDEX_SLOTS = 128;
/** The index ready to use (films wrapped, see film.js), or throws: a file that is not JSON, or one this Worker does not understand, must never replace a good copy. */
export function parseIndex(text, url) {
  let file;
  try { file = JSON.parse(text); } catch { throw new Error("invalid public index JSON"); }
  if (!file || typeof file !== "object" || !file.meta || file.meta.schema !== SCHEMA || file.meta.format !== "rows" || !Array.isArray(file.films) || !file.rows || typeof file.rows !== "object")
    throw new Error(`not an index this Worker can read (schema ${file && file.meta ? file.meta.schema : "?"} format ${file && file.meta ? file.meta.format : "?"}, expected ${SCHEMA} rows)`);
  if (url) {
    const path = new URL(url).pathname;
    if (path.includes('/u/')) {
      const match = /\/u\/friend-a\/r\/(r-[0-9a-f]{32})\/data\/index[^/]*\.json$/.exec(path);
      if (!match || file.meta.personId !== 'friend-a' || file.meta.revision !== match[1]) throw new Error('index identity mismatch');
    }
  }
  return hydrate(file);
}

export function createStore({ fetchImpl = (...a) => fetch(...a), caches = globalThis.caches, now = Date.now, ttlMs = TTL_MS, log = (o) => console.warn(JSON.stringify(o)), fetchTimeoutMs = INDEX_FETCH_TIMEOUT_MS, maxIndexBytes = MAX_INDEX_BYTES, pieceMax = PIECE_CACHE_MAX, pieceBytes = PIECE_CACHE_BYTES, permanent = isPermanent, optional = isOptional, aggregateBytes = AGGREGATE_INDEX_BYTES, aggregateSlots = AGGREGATE_INDEX_SLOTS, willUrl = isWillUrl, willPieceMax = WILL_PIECE_CACHE_MAX, willPieceBytes = WILL_PIECE_CACHE_BYTES, optionPieceTimeoutMs = OPTION_PIECE_TIMEOUT_MS } = {}) {
  const slots = new Map(); // url → { index, at (when it was fetched), source, inflight, failedAt, bytes }
  let loadTail = Promise.resolve(); // the queue of WILL's loads only (refresh); Marco's URLs never wait on it
  let absentLogged = false; // `v2-absent` is said once per isolate (this store), not once per request
  let optionAbsentLogged = false; // the same for the pieces of the Discover's options, with an event of their own: their absence must not hide the absence of the v2 index, nor the other way round
  const lru = new Map(); // url → text length, of MARCO's pieces held in memory, the least recently used first (a Map keeps its insertion order: touching is delete + set)
  const willLru = new Map(); // the same for WILL's files, a queue of its own: his loads never evict a Marco piece (S8, 20/10/2026)
  /** A piece in memory was just used or stored: it goes to the end of the queue. Then the oldest go while there are too many or too much text; the piece just touched, or one being read, never. */
  function touch(url, bytes) {
    const current = slots.get(url);
    if (!current) return;
    if (willUrl(url)) {
      // The aggregate ceiling is for WILL's files only (owner review of 8e37c23, item 3, 20/10/2026): Marco's index family measured 24,537,733 bytes on 20/10 (97.5% of 24 MiB), and with the
      // ceiling over everything an isolate that opened the Board, Explore, a profile and 8 pieces refetched its 57 resident files (4 + 53 row slices; first reported as 58) and logged 64 `aggregate-evicted` (first reported as 65). Marco's files are resident for
      // the life of the isolate, as on main, and are not even measured here.
      current.touched = now(); if (bytes !== undefined) current.bytes = bytes;
      const mine = [...slots].filter(([u]) => willUrl(u)).sort((a, b) => (a[1].touched || 0) - (b[1].touched || 0));
      let allBytes = mine.reduce((n, [, s]) => n + (s.bytes || 0), 0), count = mine.length;
      for (const [old, s] of mine) {
        if (allBytes <= aggregateBytes && count <= aggregateSlots) break;
        if (old === url) continue;
        allBytes -= s.bytes || 0; count--; s.index = null; s.bytes = 0; slots.delete(old); willLru.delete(old);
        log({ event: 'aggregate-evicted', url: old });
      }
    }
    if (permanent(url)) return;
    const mine = willUrl(url), queue = mine ? willLru : lru, maxPieces = mine ? willPieceMax : pieceMax, maxBytes = mine ? willPieceBytes : pieceBytes;
    const size = bytes ?? queue.get(url) ?? 0;
    queue.delete(url);
    queue.set(url, size);
    let total = 0;
    for (const n of queue.values()) total += n;
    for (const [old, n] of queue) {
      if (queue.size <= maxPieces && total <= maxBytes) break;
      if (old === url) continue;
      const s = slots.get(old);
      if (s && s.inflight) continue;
      // Will's slot record goes with the piece; Marco's stays and is emptied, as on main.
      if (s) { if (willUrl(old)) slots.delete(old); else Object.assign(s, { index: null, at: 0, source: null, failedAt: 0, bytes: 0 }); }
      queue.delete(old);
      total -= n;
      log({ event: "piece-evicted", url: old });
    }
  }
  /** The slot of a URL. At most `aggregateSlots` slots are kept for Will's URLs (the oldest idle one makes room); Marco's are not limited, as on main. */
  function slot(url) {
    if (slots.has(url)) return slots.get(url);
    const fresh = { index: null, at: 0, source: null, inflight: null, failedAt: 0, bytes: 0 };
    if (!willUrl(url)) { slots.set(url, fresh); return fresh; }
    const mine = () => [...slots].filter(([u]) => willUrl(u));
    if (mine().length >= aggregateSlots) {
      const candidates = mine().filter(([, s]) => !s.inflight).sort((a, b) => (a[1].touched || 0) - (b[1].touched || 0));
      if (candidates.length) { const old = candidates[0][0]; slots.delete(old); willLru.delete(old); }
    }
    if (mine().length < aggregateSlots) slots.set(url, fresh);
    return fresh;
  }

  // What a piece weighs. Will's files: UTF-8 bytes, which is what the aggregate ceiling measures (the encoding costs about 13 ms on a 9.4 MB index-v2). Marco's: text.length, as on main
  // (the LRU's own measure, free); owner review item 7, 20/10/2026: his files are not encoded at all.
  const sizeOf = (url, text) => willUrl(url) ? new TextEncoder().encode(text).byteLength : text.length;

  // The Cache API shares the edge cache with fetch(): a stale 404 stored by an earlier fetch of the same URL must never be read back as "the index", so the store keys its own entries apart.
  const cacheKey = (url) => url + (url.includes("?") ? "&" : "?") + "store=index";
  async function readCache(url) {
    try {
      const res = await caches?.default?.match(cacheKey(url));
      if (!res) return null;
      return { // Cached prior valid copies retain the fixed protocol cap even if a fetch limit is temporarily lowered.
      text: await readBoundedText(res, MAX_INDEX_BYTES), at: Number(res.headers.get("x-fetched-at")) || 0 };
    } catch (e) {
      log({ event: "cache-read-failed", url, error: String(e) });
      return null;
    }
  }
  async function writeCache(url, text, at) {
    try {
      await caches?.default?.put(cacheKey(url), new Response(text, { headers: { "content-type": "application/json", "cache-control": "public, max-age=604800", "x-fetched-at": String(at) } }));
    } catch (e) {
      log({ event: "cache-write-failed", url, error: String(e) });
    }
  }

  /** The file's text: one request with a time limit over the whole of it (the body included) and a limit on the size of the body. Throws on HTTP errors, a timeout or a body that is too big (both logged as index-fetch-limit). */
  async function fetchText(url) {
    try {
      return await withDeadline(isOptionPiece(url) ? Math.min(fetchTimeoutMs, optionPieceTimeoutMs) : fetchTimeoutMs, async (signal) => {
        const res = await fetchImpl(url, { headers: { accept: "application/json" }, cache: "no-store", signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return readBoundedText(res, maxIndexBytes);
      });
    } catch (e) {
      if (e instanceof TimedOut || e instanceof TooBig) log({ event: "index-fetch-limit", url, reason: e instanceof TimedOut ? "timeout" : "too-large" });
      throw e;
    }
  }

  /** Brings the slot up to date from the Cache API or the network. Never throws; leaves the old copy in place when it fails. */
  function refresh(url, providedSlot, { bypassCache = false } = {}) {
    const s = providedSlot || slot(url);
    if (s.inflight) return s.inflight;
    // Will's files (the /u/ paths) load one at a time per isolate: chunk buffers and JSON parse temporaries must not overlap. Marco's files do not queue (owner review 20/10/2026, item 2):
    // a URL already loading is shared by every caller (the `s.inflight` above), different URLs load in parallel, as on main. Measured on the branch before this: a 50 ms piece asked
    // together with a 3 s piece waited 3058 ms (main 62 ms); the 54 Board rows on a cold isolate, median 2768 ms against 157 ms.
    const queued = willUrl(url);
    let before = null, release = null;
    if (queued) { before = loadTail; loadTail = new Promise(resolve => { release = resolve; }); }
    s.inflight = (async () => {
      if (before) await before;
      const cached = bypassCache ? null : await readCache(url);
      if (cached && now() - cached.at < ttlMs) {
        try { Object.assign(s, { index: parseIndex(cached.text, url), at: cached.at, source: "cache" }); touch(url, sizeOf(url, cached.text)); return; } catch (e) { log({ event: "cache-unreadable", url, error: String(e) }); }
      }
      try {
        // No edge cache on this fetch: `cacheEverything` stored a 404 for 30 min when the index was requested before its first publication (11/10/2026). Memory + the Cache API below are the only caches.
        s.networkAt = now();
        const text = await fetchText(url);
        const index = parseIndex(text, url);
        const at = now();
        Object.assign(s, { index, at, source: "network", failedAt: 0, absentAt: 0 });
        touch(url, sizeOf(url, text));
        await writeCache(url, text, at);
      } catch (e) {
        s.failedAt = now();
        if (optional(url) && String(e) === "Error: HTTP 404") {
          // a file a site without a board does not have: not an error. Remembered as absent for one TTL (get() below), said once per isolate
          s.absentAt = now();
          if (isOptionPiece(url)) { if (!optionAbsentLogged) { optionAbsentLogged = true; log({ event: "option-piece-absent", url }); } }
          else if (!absentLogged) { absentLogged = true; log({ event: "v2-absent", url }); }
        } else log({ event: "index-unavailable", url, error: String(e), haveMemory: !!s.index, haveCache: !!cached });
        if (!s.index && cached && now() - cached.at < MAX_STALE_MS) {
          try { Object.assign(s, { index: parseIndex(cached.text, url), at: cached.at, source: "cache-stale" }); touch(url, sizeOf(url, cached.text)); } catch { /* unreadable: nothing to serve */ }
        }
      }
    })().finally(() => { s.inflight = null; if (release) release(); }); // no touch here (S8): a load that failed must not enter any queue with size 0; one that worked was touched with its size above
    return s.inflight;
  }

  /**
   * → { index, source, ageMs } or null. `ctx` is the Worker's execution context: a background refresh is handed to ctx.waitUntil.
   * source: memory | cache | network | memory-stale | cache-stale
   */
  async function get(url, ctx) {
    const s = slot(url);
    const age = () => now() - s.at;
    if (s.index && age() < ttlMs) {
      touch(url);
      return { index: s.index, source: s.source === "network" || s.source === "cache" ? "memory" : s.source, ageMs: age() };
    }
    if (!s.index && s.absentAt && now() - s.absentAt < ttlMs) return null; // a 404 on an optional file: not asked again for one TTL (30 min), where any other failure waits 10 s
    const servable = !!s.index && age() < MAX_STALE_MS; // a copy older than a week is as good as none
    const retryLater = !!s.failedAt && now() - s.failedAt < (servable ? RETRY_MS : RETRY_EMPTY_MS);
    if (!servable && retryLater) return null;
    if (servable && age() < REVALIDATE_MS) {
      if (!retryLater) {
        const p = refresh(url, s);
        if (ctx && ctx.waitUntil) ctx.waitUntil(p);
      }
      touch(url);
      return { index: s.index, source: "memory-stale", ageMs: age() };
    }
    if (!(servable && retryLater)) await refresh(url, s);
    if (s.index && age() < MAX_STALE_MS) {
      const fresh = age() < ttlMs;
      return { index: s.index, source: fresh ? s.source : s.source === "cache-stale" ? "cache-stale" : "memory-stale", ageMs: age() };
    }
    return null;
  }

  /** A caller with a newer data requirement may recover a cached, incompatible copy once from the source.
   * The old copy stays available to ordinary readers on failure. Recovery is shared per URL and bounded by
   * RETRY_MS even when the source returns valid JSON that still lacks the required fields. The caller must
   * validate the returned copy too: this method never declares incompatible data safe to use.
   */
  async function getCompatible(url, ctx, accepts) {
    const got = await get(url, ctx);
    if (!got || accepts(got.index)) return got;
    const s = slot(url);
    if (!s.recovery) {
      s.recovery = (async () => {
        if (s.inflight) await s.inflight;
        if (s.index && accepts(s.index)) return;
        if (s.networkAt != null && now() - s.networkAt < RETRY_MS) return;
        await refresh(url, s, { bypassCache: true });
      })().finally(() => { s.recovery = null; });
    }
    await s.recovery;
    if (!s.index || now() - s.at >= MAX_STALE_MS) return null;
    const ageMs = now() - s.at;
    // A cooldown or failed refresh reuses the copy this request already read. Its origin is
    // `got.source`, not the origin recorded when the slot was first filled.
    const source = s.index === got.index ? got.source : s.source;
    return { index: s.index, source: ageMs < ttlMs ? source : source === "cache-stale" ? "cache-stale" : "memory-stale", ageMs };
  }

  /** Is this file in memory and fresh (under the TTL)? Then a request that could use a smaller piece of it has no reason to fetch one: the handler skips the piece of a Discover option when the whole v2 index is fresh. */
  const fresh = (url) => { const s = slots.get(url); return !!s && !!s.index && now() - s.at < ttlMs; };
  return { get, getCompatible, refresh, fresh, _slots: slots, _lru: lru, _willLru: willLru };
}
