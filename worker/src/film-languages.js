// The original language of a film, for /subtitles (Marco, 10/10/2026: original audio + English subtitle; Portuguese only for a film in Portuguese).
//
// The build publishes data/film-languages.json next to the index (lib/index-export.js languagesFile, Marco 12/10/2026):
//   { "v": 1, "builtAt": "…", "pt": "|0111161|0068646|", "known": "|0050083|…|" }
// `pt`: the films in Portuguese. `known`: the films in any other real language. A film in neither is not known. Ids are the numbers of the IMDb ids with a bar on
// both sides, so one String.includes is the whole lookup (87 KB for 11,148 films; JSON.parse 0.03 ms, a lookup 0.002 ms, measured 12/10/2026), where the index itself
// costs 40 to 50 ms of CPU to parse on a fresh isolate against the 10 ms the free plan gives a request.
//
// It is fetched the way the index is (memory of the isolate, then the Cache API, then the network; fresh for the same 30 minutes; the last good copy served for up
// to 7 days when the network fails) and with a short timeout. Nothing here can fail a subtitles request: a file that is missing (the Worker is published before the
// build's first night with it), slow, malformed or of another version gives `null`, which is "not known": the answer the subtitles always had. A failure is
// remembered for a minute, so a file that is down is not waited for on every request; while it lasts, the last good copy this isolate holds (up to a week old) still answers.

import { createJsonCache } from "./subtitles-source.js";

export const LANGUAGES_VERSION = 1;
export const LANGUAGES_TTL_MS = 30 * 60e3; // like the index (store.js TTL_MS)
export const LANGUAGES_STALE_MS = 7 * 24 * 60 * 60e3; // like the index (store.js MAX_STALE_MS)
export const LANGUAGES_TIMEOUT_MS = 1500;
export const LANGUAGES_RETRY_MS = 60e3;

const IDS = (s) => typeof s === "string" && s.startsWith("|") && s.endsWith("|");

/** The file's text → the file, or throws: not JSON, another version, or lists that are not "|number|number|". */
export function parseLanguages(text) {
  const file = JSON.parse(text);
  if (!file || typeof file !== "object" || file.v !== LANGUAGES_VERSION || !IDS(file.pt) || !IDS(file.known)) throw new Error("not a film-languages file this Worker can read");
  return { v: file.v, pt: file.pt, known: file.known };
}

/** "pt" | "other" | null for an IMDb id (tt0111161), from the parsed file. "other" is any real language but Portuguese. null: not in the file, or not an id, or no file. */
export function languageFromFile(file, tt) {
  const m = /^tt(\d+)$/.exec(String(tt));
  if (!m || !file || !IDS(file.pt) || !IDS(file.known)) return null;
  const key = `|${m[1]}|`;
  if (file.pt.includes(key)) return "pt";
  return file.known.includes(key) ? "other" : null;
}

export function createLanguageSource({ fetchImpl = (...a) => fetch(...a), caches = globalThis.caches, now = Date.now, log = (o) => console.warn(JSON.stringify(o)), timeoutMs = LANGUAGES_TIMEOUT_MS } = {}) {
  const cache = createJsonCache({ caches, now, log, max: 2 });
  const failedAt = new Map(); // url → when a read of it last failed

  async function load(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      // no edge cache on this fetch, for the reason store.js gives: a 404 stored before the first publication must not be read back as the file
      const res = await fetchImpl(url, { headers: { accept: "application/json" }, cache: "no-store", signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseLanguages(await res.text());
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * → { language: "pt" | "other" | null, status } — status: "ok" | "stale" (the file could not be read now, an older copy this isolate holds answered) | "failed" | "paused"
   * (a failure within the last minute, no copy held) | "not-a-film". Never throws; never waits longer than the timeout (and a quarter of a second more for the Cache API).
   */
  async function lookup(url, tt) {
    if (!/^tt\d+$/.test(String(tt))) return { language: null, status: "not-a-film" };
    const key = `languages:${url}`;
    const held = () => { const m = cache._memory.get(key); return m && now() - m.at < LANGUAGES_STALE_MS ? m.value : null; }; // the last good copy, however old (up to a week)
    const fromHeld = () => { const h = held(); return h ? { language: languageFromFile(h, tt), status: "stale" } : null; };
    if (failedAt.has(url) && now() - failedAt.get(url) < LANGUAGES_RETRY_MS) return fromHeld() || { language: null, status: "paused" };
    let timer;
    try {
      const got = await Promise.race([
        cache.through(key, { ttlMs: LANGUAGES_TTL_MS, staleMs: LANGUAGES_STALE_MS, load: () => load(url) }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs + 250); }),
      ]);
      if (got.from === "stale") { failedAt.set(url, now()); return { language: languageFromFile(got.value, tt), status: "stale" }; } // (the failure was logged by the cache)
      return { language: languageFromFile(got.value, tt), status: "ok" };
    } catch (e) {
      failedAt.set(url, now());
      if (failedAt.size > 8) failedAt.delete(failedAt.keys().next().value);
      log({ event: "film-languages-unavailable", url, error: String(e) });
      return fromHeld() || { language: null, status: "failed" };
    } finally {
      clearTimeout(timer);
    }
  }
  return { lookup, _cache: cache };
}
