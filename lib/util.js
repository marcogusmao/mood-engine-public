// Small shared helpers. No dependencies.

/** Parse CSV text (RFC 4180: quotes, escaped quotes, newlines in fields) into objects keyed by header. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}

/** Title normaliser for matching ("Shall We Dance?" == "shall we dance"). */
function norm(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
}

const filmKey = (title, year) => `${norm(title)}|${year || ""}`;

/** Deterministic PRNG (mulberry32) seeded from a string, e.g. today's date. */
function seeded(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353), (h = (h << 13) | (h >>> 19));
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** z-score normalise a numeric property across a list (in place, writes to `out`). */
function zscore(list, get, set) {
  const vals = list.map(get);
  const n = vals.length || 1;
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
  list.forEach((x, i) => set(x, (vals[i] - mean) / sd));
}

/** IMDb-style weighted rating so a 9.0 with 12 votes doesn't beat an 8.1 with 20k. */
const bayes = (va, vc, m = 400, C = 6.6) => ((vc || 0) * (va || 0) + m * C) / ((vc || 0) + m);

const stars = (r) => {
  const full = Math.floor(r), half = r - full >= 0.5;
  return "★".repeat(full) + (half ? "½" : "");
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs fn over items, `n` at a time. Results keep the items' order. */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ── one request under a deadline and a size cap (review of catalog-expansion, security finding 1; written 11/10/2026, landed 13/10/2026 in branch v24-hardening) ──
// Before, lib/tmdb.js and lib/friends.js called fetch with no time limit and read the whole body whatever its size: a server that never
// ends its answer hung the nightly build until the workflow's 5 hours, and a huge body was read whole into memory. Now each try has
// one deadline that covers the answer AND the body (its abort signal goes to fetch), and the body is read chunk by chunk and given up
// past a byte cap. Either one is a LimitError, which the callers treat like a network failure: one failed try, then their own retries.
// The deadline is an AbortController with a plain timer, not AbortSignal.timeout(): that one's timer does not hold the event loop, so a
// request that nothing else keeps alive (a stalled body) could end the process with the promise still pending instead of failing.

class LimitError extends Error {
  constructor(message, code) { super(message); this.name = "LimitError"; this.code = code; }
}

/**
 * A deadline of `ms` for one try: { signal, race(promise), clear() }. race() rejects with a LimitError when the deadline passes, also for
 * an impl that ignores the signal; clear() stops the timer (call it when the try is over).
 */
function deadline(ms) {
  const ctl = new AbortController();
  const err = new LimitError(`no complete answer in ${ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`}`, "timeout");
  let timer;
  const passed = new Promise((_, reject) => { timer = setTimeout(() => { ctl.abort(err); reject(err); }, ms); });
  passed.catch(() => {}); // a deadline nobody raced against is not an unhandled rejection
  return { signal: ctl.signal, race: (p) => Promise.race([p, passed]), clear: () => clearTimeout(timer) };
}

/** The bytes of `res.body` read chunk by chunk under `maxBytes`, after refusing a declared Content-Length past it; null when the response has no stream. */
async function streamCapped(res, maxBytes, tooLarge) {
  const declared = Number(res.headers && typeof res.headers.get === "function" ? res.headers.get("content-length") : NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel?.(); } catch { /* nothing to free */ }
    throw tooLarge(declared);
  }
  if (!(res.body && typeof res.body.getReader === "function")) return null;
  const reader = res.body.getReader(), chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { try { await reader.cancel(); } catch { /* already closed */ } throw tooLarge(); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
}

const tooLargeFor = (maxBytes) => (n) => new LimitError(`answer larger than ${maxBytes} bytes${n ? ` (${n})` : ""}`, "too-large");

/**
 * The body of `res` as text, refusing it past `maxBytes` (LimitError "too-large"): the Content-Length when the server sends one, then
 * the bytes actually read, chunk by chunk (res.body), so a lying or missing header changes nothing. A response with no stream (the
 * tests' fakes) is read with res.text() and measured after.
 */
async function readCapped(res, maxBytes) {
  const tooLarge = tooLargeFor(maxBytes);
  const bytes = await streamCapped(res, maxBytes, tooLarge);
  if (bytes) return new TextDecoder().decode(bytes); // drops a UTF-8 BOM, as res.text() did
  const text = typeof res.text === "function" ? String(await res.text()) : "";
  if (Buffer.byteLength(text) > maxBytes) throw tooLarge(Buffer.byteLength(text));
  return text;
}

/**
 * Same cap, same rules, for a binary body (an image, a gzip file): a Buffer. A response with no stream is read with res.arrayBuffer()
 * (or res.text()) and measured after.
 */
async function readCappedBytes(res, maxBytes) {
  const tooLarge = tooLargeFor(maxBytes);
  const bytes = await streamCapped(res, maxBytes, tooLarge);
  if (bytes) return bytes;
  const buf = typeof res.arrayBuffer === "function" ? Buffer.from(await res.arrayBuffer()) : typeof res.text === "function" ? Buffer.from(String(await res.text())) : Buffer.alloc(0);
  if (buf.length > maxBytes) throw tooLarge(buf.length);
  return buf;
}

// ── the limits of every outside request of the build (13/10/2026) ──
// TMDB and Letterboxd got theirs in v24-hardening; the other five calls (the diary RSS, boxd.it, the IMDb ratings dump, the cover images,
// the flags) had none, so a server that never answered them could hold the nightly build until the workflow's 5 hours (a risk found in
// review, not a night on record). One table, so the numbers are read in one place. `boxd` has no byte cap: its answer is a redirect and the body is never read (it is cancelled).
// Override: config.json "limits": { "imdbDump": { "timeoutMs": 90000, "maxBytes": 314572800 } } → applyLimits(cfg.limits), called by
// build.js right after config.json is read, before anything is requested. Tests change LIMITS directly and put it back.
const MB = 1024 * 1024;
const LIMITS = {
  tmdb: { timeoutMs: 30000, maxBytes: 10 * MB },
  letterboxd: { timeoutMs: 45000, maxBytes: 20 * MB },
  letterboxdRss: { timeoutMs: 30000, maxBytes: 5 * MB },
  boxd: { timeoutMs: 30000 },
  imdbDump: { timeoutMs: 120000, maxBytes: 200 * MB, maxInflatedBytes: 1024 * MB }, // the file is ~7 MB gzipped; maxInflatedBytes caps what gunzip may produce (gzip goes 1029:1 on zeros)
  coverImage: { timeoutMs: 30000, maxBytes: 5 * MB },
  flag: { timeoutMs: 20000, maxBytes: 1 * MB },
  wikidata: { timeoutMs: 60000, maxBytes: 20 * MB }, // lib/directors.js: the director's citizenship (23/10/2026); one query of 120 people answers in about 100 KB
};

const MAX_TIMER_MS = 2147483647; // a larger setTimeout delay is replaced by Node with 1 ms: a deadline that fires at once
const MAX_BYTES_LIMIT = 2 ** 31; // 2 GiB: a byte cap above Buffer's reach (2 ** 53 made gunzipSync throw ERR_OUT_OF_RANGE every night, found by the security review of 13/10/2026)

/** Merges config.json "limits" over LIMITS. A site or a key that does not exist, or a value that is not a positive integer (a timeoutMs also not above 2147483647), is an error (a typo must not pass silently). */
function applyLimits(over) {
  if (over == null) return LIMITS;
  if (typeof over !== "object" || Array.isArray(over)) throw new Error('config.json "limits" must be an object like { "imdbDump": { "timeoutMs": 90000 } }');
  for (const [site, o] of Object.entries(over)) {
    if (!Object.hasOwn(LIMITS, site)) throw new Error(`config.json "limits": "${site}" is not a request site (${Object.keys(LIMITS).join(", ")})`);
    if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error(`config.json "limits.${site}" must be an object`);
    for (const [k, v] of Object.entries(o)) {
      if (!Object.hasOwn(LIMITS[site], k)) throw new Error(`config.json "limits.${site}": "${k}" is not one of ${Object.keys(LIMITS[site]).join(", ")}`);
      if (!Number.isInteger(v) || v <= 0) throw new Error(`config.json "limits.${site}.${k}" must be a positive whole number, got ${JSON.stringify(v)}`);
      if (k === "timeoutMs" && v > MAX_TIMER_MS) throw new Error(`config.json "limits.${site}.${k}" must be at most ${MAX_TIMER_MS} (Node turns a longer timer into 1 ms), got ${v}`);
      if (k !== "timeoutMs" && v > MAX_BYTES_LIMIT) throw new Error(`config.json "limits.${site}.${k}" must be at most ${MAX_BYTES_LIMIT} bytes (2 GiB), got ${v}`);
    }
  }
  for (const [site, o] of Object.entries(over)) Object.assign(LIMITS[site], o);
  return LIMITS;
}

// A limit hit is logged as `  ! limit hit <site>: <what>` so that whoever reads the night's log can search it for "limit hit" (a human step; no
// script does it); only the first LOG_FIRST per site are written, so a CDN that stalls for 11,000 covers does not write 11,000 lines.
// limitHits counts all of them and build.js prints limitSummary() at the end of the build.
const LOG_FIRST = 10;
const limitHits = {};
const resetLimitHits = () => { for (const k of Object.keys(limitHits)) delete limitHits[k]; };
/** Counts one hit at `site` and writes `  ! limit hit <site>: <message>` through `log` (the first LOG_FIRST of that site). */
function recordLimitHit(site, message, log = console.warn) {
  limitHits[site] = (limitHits[site] || 0) + 1;
  if (limitHits[site] <= LOG_FIRST) log(`  ! limit hit ${site}: ${message}`);
}
/** "limit hits: tmdb 0, letterboxd 0, letterboxdRss 1, …, covers 0": every request site of LIMITS, then `covers` (a host given up on, lib/posters.js). */
function limitSummary() {
  return `limit hits: ${[...Object.keys(LIMITS), "covers"].map((k) => `${k} ${limitHits[k] || 0}`).join(", ")}`;
}

/**
 * One try of a request to `site` (a key of LIMITS), under LIMITS[site]: a deadline that covers the answer and its body, and for the body a
 * byte cap. as: "bytes" (Buffer), "text" (string) or "none" (headers only; the body is cancelled unread). → { res, body }. A response that
 * is not ok has no body read (the caller decides by res.status, as before). A deadline or a cap is thrown as a LimitError whose message starts
 * `limit hit <site>:`, with .site, and .final = true for "too-large" (the same body again would be as large: callers must not retry it);
 * the first LOG_FIRST of each site are also sent to `log`.
 */
async function limitedFetch(site, fetchImpl, url, init = {}, { as = "bytes", log = console.warn } = {}) {
  const lim = LIMITS[site];
  // a body read with no cap is what these limits exist to prevent: a site with no maxBytes (boxd) may only be asked with as: "none"
  if (as !== "none" && !(Number.isFinite(lim.maxBytes) && lim.maxBytes > 0)) throw new Error(`limits: "${site}" has no maxBytes, so its body cannot be read (as: "${as}"); ask with as: "none" or give it a maxBytes`);
  const d = deadline(lim.timeoutMs);
  try {
    const res = await d.race(fetchImpl(url, { ...init, signal: d.signal }));
    let body = null;
    if (as === "none" || !res.ok) { try { await res.body?.cancel?.(); } catch { /* nothing to free */ } }
    else body = await d.race(as === "text" ? readCapped(res, lim.maxBytes) : readCappedBytes(res, lim.maxBytes));
    return { res, body };
  } catch (e) {
    if (!(e instanceof LimitError)) throw e;
    const hit = new LimitError(`limit hit ${site}: ${e.message}`, e.code);
    hit.site = site; hit.final = e.code === "too-large";
    recordLimitHit(site, `${e.message}`, log);
    throw hit;
  } finally {
    d.clear();
  }
}

const monthYear = (iso) => {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00Z");
  return d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
};

module.exports = { parseCsv, norm, filmKey, seeded, zscore, bayes, stars, sleep, mapLimit, monthYear, LimitError, deadline, readCapped, readCappedBytes, LIMITS, applyLimits, limitedFetch, limitHits, resetLimitHits, recordLimitHit, limitSummary };
