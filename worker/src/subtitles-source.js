// Where the subtitles come from: the official OpenSubtitles addon for the list, and (when there is an API key) OpenSubtitles' REST API for
// the one thing the official addon does not do: tell which subtitles were made for the file with a given hash. Measured with a real key on
// 10/10/2026 (Paterson, hash 1cddc37a1943f1ae): HTTP 200, 29 results, 3 with moviehash_match true and listed first, ids in `legacy_subtitle_id`;
// 5 requests a second (x-ratelimit-limit-second). Only some of the hash-matched subtitles are in the official list (one of three was, by id).
//
//   list    GET <SUBTITLES_SOURCE>/subtitles/{type}/{id}.json            cached 1 hour per id (memory, then the Cache API), the last good copy
//                                                                         is served for up to a day when the source fails. The fetch has a 10 s limit over
//                                                                         the whole of it and a 2 MB limit on the body, and is made only to the host the
//                                                                         setting names (13/10/2026; before that it had neither limit)
//   exact   GET https://api.opensubtitles.com/api/v1/subtitles?...        cached 24 hours per hash and id; needs the secret OPENSUBTITLES_API_KEY
//                                                                         (the same call also collects the hash-matched subtitles the official list lacks: `extras`, see subfile.js)
//
// Neither can break the other: with no key, or a REST call that fails, times out or is refused, the answer simply has no "exact" tier.
// A failed REST call is not cached for a day (that would hide the exact tier for a day); it is remembered for 5 minutes so that a refusing
// API is not asked on every request.

import { ADDON_VERSION } from "./manifest.js";
import { VALID_HASH, languageOf } from "./subtitles.js";

export const DEFAULT_SOURCE = "https://opensubtitles-v3.strem.io";
export const DEFAULT_REST = "https://api.opensubtitles.com/api/v1";
/** The body of an answer was bigger than the limit. */
export class TooBig extends Error {
  constructor() { super("body too big"); }
}
/**
 * The text of a response body (UTF-8), read in chunks and refused as soon as it is over `maxBytes`: a declared length over the limit is refused unread, an undeclared one is
 * cancelled at the limit. Throws TooBig.
 */
export async function readBoundedText(res, maxBytes) {
  const cancel = async (target) => { try { await target.cancel(); } catch { /* nothing to read */ } };
  if (Number(res.headers.get("content-length")) > maxBytes) { if (res.body) await cancel(res.body); throw new TooBig(); }
  const chunks = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await cancel(reader); throw new TooBig(); }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return new TextDecoder("utf-8").decode(bytes);
}

/** The time given to a fetch ran out. */
export class TimedOut extends Error {
  constructor() { super("timed out"); }
}
/**
 * `run(signal)` with a time limit over the whole of it (the body read inside `run` included). When the time is up the signal is aborted AND the answer is a TimedOut, even when
 * `run` never looks at the signal (a fetch that ignores it, or never answers): the limit does not depend on the callee's good manners. The timer is always cleared.
 */
export async function withDeadline(ms, run) {
  const ctl = new AbortController();
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(new TimedOut()); }, ms); });
  try {
    return await Promise.race([run(ctl.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The only hosts that ever receive the API key, the user name, the password or a token: OpenSubtitles' own API (and its VIP twin, which login can name). */
export const API_HOST = /^(?:vip-)?api\.opensubtitles\.com$/;
/**
 * The REST API address the credentials go to: OPENSUBTITLES_REST when it is https on an API_HOST (any path is replaced by /api/v1), else the default. A setting that points
 * anywhere else (a mistake, or a stolen deploy setting) is ignored and logged, so the key is never sent to a host that is not OpenSubtitles'.
 */
export function restBaseOf(env, log = () => {}) {
  const raw = env && env.OPENSUBTITLES_REST;
  if (!raw) return DEFAULT_REST;
  try {
    const u = new URL(String(raw));
    if (u.protocol === "https:" && API_HOST.test(u.hostname) && !u.username && !u.password && !u.port) return `https://${u.hostname}/api/v1`;
  } catch { /* not an address */ }
  log({ event: "opensubtitles-rest-setting-ignored" });
  return DEFAULT_REST;
}
export const LIST_TTL_MS = 60 * 60e3;
export const LIST_STALE_MS = 24 * 60 * 60e3;
export const EXACT_TTL_MS = 24 * 60 * 60e3;
export const EXACT_RETRY_MS = 5 * 60e3;
export const REST_TIMEOUT_MS = 3000;
export const MAX_SEARCH_BYTES = 1.5e6; // a page of 50 results is a few hundred KB
export const LIST_TIMEOUT_MS = 10e3; // the official list, over the whole of the request (13/10/2026: the fetch had no time limit and no size limit)
export const MAX_LIST_BYTES = 2e6; // the list for Paterson (100 subtitles) is 37,388 bytes (the fixture); a title with every language is some hundred KB
const MAX_ENTRIES = 300; // per isolate, per kind: the memory of an isolate is not for a library

/**
 * What a log may say about a failure (13/10/2026): the name of the error, and its message only when it is one this code throws itself (`HTTP 429`, `not a search answer`,
 * `body too big`, `timed out`, `unexpected source host`). Any other message may carry a piece of a body (JSON.parse quotes it) or the address that was asked for (a network error), and that address holds the file's
 * hash and the title's id.
 */
export function whyOf(e) {
  const message = String(e && e.message);
  return `${(e && e.name) || "Error"}: ${/^(?:HTTP \d{3}|not a search answer|not a subtitles answer|body too big|timed out|unexpected source host)$/.test(message) ? message : "details withheld"}`;
}

/** A small memory + Cache API cache of JSON values with a freshness time, a stale-if-error time and a bound on its size. */
export function createJsonCache({ caches = globalThis.caches, now = Date.now, log = () => {}, max = MAX_ENTRIES, failEvent = "subtitles-source-failed", maxBodyBytes = Infinity, validate = null, lru = false, maxBytes = Infinity, cacheTimeoutMs = null } = {}) {
  const memory = new Map(); // key → { at, value }
  const keyUrl = (key) => `https://cache.mood-engine.invalid/${encodeURIComponent(key)}`;
  const valid = (value, key) => { if (validate && validate(value, key) === false) throw new Error("invalid cached value"); return value; };
  const bounded = (run) => cacheTimeoutMs == null ? run() : withDeadline(cacheTimeoutMs, run);
  const remember = (key, entry) => {
    if (maxBytes !== Infinity) entry.bytes = new TextEncoder().encode(JSON.stringify(entry.value)).byteLength;
    memory.delete(key);
    memory.set(key, entry);
    while (memory.size > max || (maxBytes !== Infinity && [...memory.values()].reduce((n, e) => n + e.bytes, 0) > maxBytes)) memory.delete(memory.keys().next().value);
  };
  async function readEdge(key, logKey) {
    try {
      const res = await bounded(() => caches?.default?.match(keyUrl(key)));
      if (!res) return null;
      const at = Number(res.headers.get("x-fetched-at")) || 0;
      if (!Number.isFinite(at) || at < 0 || at > now()) return null;
      const raw = await bounded(() => maxBodyBytes === Infinity ? res.text() : readBoundedText(res, maxBodyBytes));
      return { at, value: valid(JSON.parse(raw), key) };
    } catch (e) {
      log({ event: "cache-read-failed", key: logKey, error: whyOf(e) });
      return null;
    }
  }
  async function writeEdge(key, entry, logKey) {
    try {
      await bounded(() => caches?.default?.put(keyUrl(key), new Response(JSON.stringify(entry.value), { headers: { "content-type": "application/json", "cache-control": "public, max-age=86400", "x-fetched-at": String(entry.at) } })));
    } catch (e) {
      log({ event: "cache-write-failed", key: logKey, error: whyOf(e) });
    }
  }
  /**
   * The value for `key`: fresh in memory, else fresh in the Cache API, else `load()`. When load() throws, a copy up to `staleMs` old is served
   * and the failure is logged; with none, the error goes up. `logKey` is what the logs say instead of `key` (a key made from a file's hash must not be logged whole). → { value, from }
   */
  async function through(key, { ttlMs, staleMs = 0, load, logKey = key }) {
    const t = now();
    let mem = memory.get(key);
    if (mem) { try { valid(mem.value, key); } catch { memory.delete(key); mem = null; } }
    if (mem && t - mem.at < ttlMs) { if (lru) remember(key, mem); return { value: mem.value, from: "memory" }; }
    const edge = await readEdge(key, logKey);
    if (edge && t - edge.at < ttlMs) { remember(key, edge); return { value: edge.value, from: "cache" }; }
    try {
      const entry = { at: now(), value: valid(await load(), key) };
      remember(key, entry);
      await writeEdge(key, entry, logKey);
      return { value: entry.value, from: "source" };
    } catch (e) {
      const best = [mem, edge].filter(Boolean).sort((a, b) => b.at - a.at)[0];
      log({ event: failEvent, key: logKey, error: whyOf(e), haveStale: !!best });
      if (best && now() - best.at < staleMs) return { value: best.value, from: "stale" };
      throw e;
    }
  }
  return { through, _memory: memory };
}

/** The only hosts the official list is ever asked on. The `SUBTITLES_SOURCE` setting can name another path or the same host with :443, not another host (13/10/2026, review of W2). */
export const SOURCE_HOSTS = ["opensubtitles-v3.strem.io"];
/**
 * The authority (host and port) a configured source names, as written: what stands between `//` and the next `/`, `?` or `#`, lower case. `new URL()` reads
 * `https://opensubtitles-v3.strem.io@evil.example` as host `evil.example` and `https://evil.example?@opensubtitles-v3.strem.io` the same way; it also undoes `%2E`, full-width dots
 * and tabs. Comparing the text with what the parser made of it catches all of those.
 */
const authorityOf = (base) => { const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(String(base)); return m ? m[1].toLowerCase() : ""; };
/** May the official list be asked at `url`, built on the configured `base`? https, no credentials, port 443 or none, a host of SOURCE_HOSTS exactly, and the text of the setting says that same host. */
function sourceHostOk(base, url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && SOURCE_HOSTS.includes(u.hostname) && authorityOf(base).replace(/:443$/, "") === u.hostname;
  } catch { return false; }
}

/** The official addon's list for a title: [{ id, url, lang, movieReleaseName, releaseGroup, releaseFormat, … }]. Throws when it cannot be had, is over `maxBytes`, is not on an allowed host, or takes more than `timeoutMs`. */
async function officialList({ fetchImpl, base, type, id, timeoutMs = LIST_TIMEOUT_MS, maxBytes = MAX_LIST_BYTES }) {
  const url = `${base}/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  // Before anything is sent, the address must be on an allowed host (the default: opensubtitles-v3.strem.io).
  if (!sourceHostOk(base, url)) throw new Error("unexpected source host");
  return withDeadline(timeoutMs, async (signal) => {
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, cf: { cacheTtl: LIST_TTL_MS / 1000, cacheEverything: true }, signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = JSON.parse(await readBoundedText(res, maxBytes));
    if (!body || !Array.isArray(body.subtitles)) throw new Error("not a subtitles answer");
    return body.subtitles;
  });
}

/**
 * A hash-matched result that could be offered although the official list may lack it (Marco, 12/10/2026; downloaded with his OpenSubtitles account by subfile.js):
 * { legacy (the official list's `id`, to leave out the ones it already has), fileId, lang (eng, pob, por), release }, or null. Left out: a language that is not English or
 * Portuguese; a machine-translated or AI-translated subtitle (true, not merely absent); one with no legacy id (it cannot be compared with the official list); one that is
 * not exactly one file (a subtitle in parts, CD1/CD2, would need all of them); a file id that is not a plain number.
 */
export function extraOf(a) {
  const language = languageOf(a.language);
  if (!language || a.ai_translated === true || a.machine_translated === true || a.legacy_subtitle_id == null) return null;
  const files = Array.isArray(a.files) ? a.files : [];
  const fileId = files.length === 1 && files[0] ? String(files[0].file_id) : "";
  if (!/^\d{1,12}$/.test(fileId)) return null;
  const release = String(a.release || files[0].file_name || "").slice(0, 200);
  return { legacy: String(a.legacy_subtitle_id), fileId, lang: language.key, release };
}

/** What the cache may hold for `extras`, whatever an older version or a damaged entry left there: only well-formed ones. */
function cleanExtras(list) {
  return (Array.isArray(list) ? list : []).filter((e) => e && typeof e === "object" && /^\d{1,12}$/.test(String(e.fileId)) && ["eng", "pob", "por"].includes(e.lang) && e.legacy != null)
    .map((e) => ({ legacy: String(e.legacy), fileId: String(e.fileId), lang: e.lang, release: String(e.release || "").slice(0, 200) }));
}

/**
 * The ids OpenSubtitles says belong to a file with this hash: Set of strings (attributes.legacy_subtitle_id of each result whose
 * attributes.moviehash_match is true; the official list's `id` is the same number), and the `extras` of those results (extraOf). Empty when there is no valid hash. Throws when the REST call fails.
 * A movie is searched by imdb_id; an episode (tt0944947:1:1) by parent_imdb_id, season_number and episode_number. The parameters are sorted
 * and lower case, which the API asks for. `languages` is only a filter of what the API sends back: the matching is by id.
 */
async function restExactIds({ fetchImpl, base, key, type, id, hash, timeoutMs }) {
  const [tt, season, episode] = String(id).split(":");
  const p = type === "series" && season ? { parent_imdb_id: tt.replace(/^tt/, ""), season_number: season, episode_number: episode, moviehash: hash.toLowerCase(), languages: "en,pt-br,pt-pt" } : { moviehash: hash.toLowerCase(), languages: "en,pt-br,pt-pt", imdb_id: tt.replace(/^tt/, "") }; // (written in the natural order on purpose: the sort below is what makes them alphabetical)
  const qs = Object.keys(p).sort().map((k) => `${k}=${encodeURIComponent(p[k])}`).join("&");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // redirect "manual": the key travels in this request's headers, and a redirect (a 3xx is a failure here) would carry it to whatever host the answer names
    const res = await fetchImpl(`${base}/subtitles?${qs}`, { headers: { "Api-Key": key, "User-Agent": `MoodEngine v${ADDON_VERSION}`, accept: "application/json" }, redirect: "manual", signal: ctl.signal });
    if (!res.ok) { try { await res.body?.cancel(); } catch { /* nothing to read */ } throw new Error(`HTTP ${res.status}`); }
    const body = JSON.parse(await readBoundedText(res, MAX_SEARCH_BYTES));
    if (!body || !Array.isArray(body.data)) throw new Error("not a search answer");
    const ids = new Set();
    const extras = [];
    for (const d of body.data) {
      const a = d && d.attributes;
      if (!a || a.moviehash_match !== true) continue;
      if (a.legacy_subtitle_id != null) ids.add(String(a.legacy_subtitle_id));
      const extra = extraOf(a);
      if (extra && !extras.some((x) => x.fileId === extra.fileId)) extras.push(extra);
    }
    return { ids, extras };
  } finally {
    clearTimeout(timer);
  }
}

export function createSubtitleSource({ fetchImpl = (...a) => fetch(...a), caches = globalThis.caches, now = Date.now, log = (o) => console.warn(JSON.stringify(o)), restTimeoutMs = REST_TIMEOUT_MS, listTimeoutMs = LIST_TIMEOUT_MS, maxListBytes = MAX_LIST_BYTES } = {}) {
  const cache = createJsonCache({ caches, now, log });
  const failedAt = new Map(); // key → when a REST call for it failed

  /** → { subs, from } — the official list, or throws when there is none to be had. */
  async function list(env, type, id) {
    const base = (env.SUBTITLES_SOURCE || DEFAULT_SOURCE).replace(/\/+$/, "");
    const r = await cache.through(`list:${base}:${type}:${id}`, { ttlMs: LIST_TTL_MS, staleMs: LIST_STALE_MS, logKey: `list:${type}`, load: () => officialList({ fetchImpl, base, type, id, timeoutMs: listTimeoutMs, maxBytes: maxListBytes }) });
    return { subs: r.value, from: r.from };
  }

  /** → { ids: Set, extras: [extraOf…], status } — status: "no-key" | "no-hash" | "ok" | "failed" | "paused". Never throws. */
  async function exact(env, type, id, hash) {
    if (!env.OPENSUBTITLES_API_KEY) return { ids: new Set(), extras: [], status: "no-key" };
    if (!hash || !VALID_HASH.test(hash)) return { ids: new Set(), extras: [], status: "no-hash" };
    const key = `exact2:${hash.toLowerCase()}:${id}`; // exact2: entries of the version before extras (a plain array, kept 24 h) would hide the extras; a new key skips them (12/10/2026)
    const t = now();
    if (failedAt.has(key) && t - failedAt.get(key) < EXACT_RETRY_MS) return { ids: new Set(), extras: [], status: "paused" };
    try {
      const base = restBaseOf(env, log);
      const r = await cache.through(key, { ttlMs: EXACT_TTL_MS, logKey: `exact2:${hash.slice(0, 6).toLowerCase()}`, load: async () => { const found = await restExactIds({ fetchImpl, base, key: env.OPENSUBTITLES_API_KEY, type, id, hash, timeoutMs: restTimeoutMs }); return { ids: [...found.ids], extras: found.extras }; } });
      failedAt.delete(key);
      const v = r.value; // (an entry written before extras existed is a plain array of ids)
      return { ids: new Set(Array.isArray(v) ? v : (v && v.ids) || []), extras: Array.isArray(v) ? [] : cleanExtras(v && v.extras), status: "ok" };
    } catch (e) {
      failedAt.set(key, now());
      if (failedAt.size > MAX_ENTRIES) failedAt.delete(failedAt.keys().next().value);
      log({ event: "opensubtitles-rest-failed", hashPrefix: hash.slice(0, 6).toLowerCase(), error: whyOf(e) }); // never the key, the whole hash or the title (13/10/2026: the hash names the file being watched)
      return { ids: new Set(), extras: [], status: "failed" };
    }
  }
  return { list, exact, _cache: cache };
}
