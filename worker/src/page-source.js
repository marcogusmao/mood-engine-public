// Public page facts only. Every cache layer is validated; no full-index fallback.
import { createJsonCache, readBoundedText, withDeadline, TimedOut, TooBig } from './subtitles-source.js';
export const PAGE_ID = /^tt\d{1,10}$/;
export const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
export const shardOf = tt => tt.slice(2).slice(-2).padStart(2, '0');
const FILM_KEYS = new Set('t n y rt g d c im lb mo kw li fr sb fa wb syn yt'.split(' '));
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const assert = ok => { if (!ok) throw Error('invalid page shard'); };
const string = s => typeof s === 'string' && !!s.trim() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s);
const fields = (x, allowed) => { assert(object(x)); for (const k of Object.keys(x)) assert(allowed.has(k)); };
export const privatePageText = text => (text.includes('@') && /[\w.+-]{1,64}@[\w-]{1,63}\.[a-z]{2,63}/i.test(text)) || /\/k\/|you rate\b/i.test(text);
export function validatePageShard(s, expected) {
  fields(s, new Set(['v', 'builtAt', 'shard', 'people', 'films']));
  assert(s.v === 1 && s.shard === expected && /^\d{2}$/.test(expected));
  assert(typeof s.builtAt === 'string' && /^\d{4}-\d\d-\d\dT/.test(s.builtAt) && Number.isFinite(Date.parse(s.builtAt)));
  assert(Array.isArray(s.people) && s.people.every(string) && new Set(s.people).size === s.people.length && Array.isArray(s.films));
  const ids = new Set();
  for (const r of s.films) {
    fields(r, FILM_KEYS); assert(typeof r.t === 'string' && PAGE_ID.test(r.t) && shardOf(r.t) === expected && !ids.has(r.t) && string(r.n)); ids.add(r.t);
    for (const [k, lo, hi] of [['y', 1850, 2100], ['rt', 1, 6000], ['im', 1, 10], ['lb', 0, 5], ['fa', 0.5, 5], ['sb', 0, Number.MAX_SAFE_INTEGER], ['wb', 0, Number.MAX_SAFE_INTEGER]]) if (Object.hasOwn(r, k)) assert(typeof r[k] === 'number' && Number.isFinite(r[k]) && r[k] >= lo && r[k] <= hi && (!['y', 'sb', 'wb'].includes(k) || Number.isInteger(r[k])));
    for (const [k, max] of [['g', 3], ['d', 2], ['c', 5], ['kw', 4]]) if (Object.hasOwn(r, k)) assert(Array.isArray(r[k]) && r[k].length > 0 && r[k].length <= max && r[k].every(string));
    for (const k of ['mo', 'li']) if (Object.hasOwn(r, k)) { assert(Array.isArray(r[k]) && r[k].length > 0); const refs = new Set(); for (const p of r[k]) { assert(Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && /^[A-Za-z0-9_-]+$/.test(p[0]) && Number.isFinite(p[1]) && (k !== 'li' || Number.isInteger(p[1]) && p[1] >= 1) && !refs.has(p[0])); refs.add(p[0]); } }
    if (r.fr !== undefined) { fields(r.fr, new Set(['s', 'w'])); const person = i => Number.isInteger(i) && i >= 0 && i < s.people.length; assert(Array.isArray(r.fr.s) && Array.isArray(r.fr.w) && r.fr.s.every(p => Array.isArray(p) && p.length === 2 && person(p[0]) && (p[1] === null || Number.isFinite(p[1]) && p[1] >= 0.5 && p[1] <= 5)) && r.fr.w.every(person)); assert(new Set(r.fr.s.map(p => p[0])).size === r.fr.s.length && new Set(r.fr.w).size === r.fr.w.length); }
    if (r.syn !== undefined) assert(string(r.syn) && r.syn.length <= 280 && !/^MUBI:/.test(r.syn));
    if (r.yt !== undefined) assert(typeof r.yt === 'string' && YOUTUBE_ID.test(r.yt));
  }
  assert(!privatePageText(JSON.stringify(s)));
  return s;
}
export function createPageSource({ fetchImpl = (...a) => fetch(...a), caches = globalThis.caches, now = Date.now, log = () => {}, timeoutMs = 1500, cacheTimeoutMs = 50, lookupTimeoutMs = 1750, maxBytes = 2 * 1024 * 1024 } = {}) {
  const failed = new Map(), inflight = new Map(), maps = new WeakMap();
  const reason = e => e instanceof TimedOut ? 'timeout' : e instanceof TooBig ? 'too-big' : /^HTTP \d{3}$/.test(e?.message) ? 'http' : 'invalid-or-unavailable';
  const note = (shard, why) => log({ event: 'page-shard-unavailable', shard, reason: why });
  const cache = createJsonCache({ caches, now, max: 24, maxBytes, lru: true, cacheTimeoutMs, maxBodyBytes: 512 * 1024, failEvent: 'page-shard-unavailable',
    validate: (value, key) => validatePageShard(value, /page-(\d{2})\.json$/.exec(key)?.[1]),
    log: e => note(e.key, e.event === 'page-shard-unavailable' ? 'source' : 'cache'),
  });
  async function read(url, shard) {
    const key = `page:v1:${url}`;
    return withDeadline(lookupTimeoutMs, async () => cache.through(key, { ttlMs: 30 * 60e3, staleMs: 7 * 86400e3, logKey: shard, load: async () => {
      if (failed.has(url) && now() - failed.get(url) < 60e3) throw Error('paused');
      try {
        const s = await withDeadline(timeoutMs, async signal => {
          const res = await fetchImpl(url, { cache: 'no-store', redirect: 'manual', headers: { accept: 'application/json' }, signal });
          if (!res.ok || res.status >= 300) throw Error(`HTTP ${res.status}`);
          return validatePageShard(JSON.parse(await readBoundedText(res, 512 * 1024)), shard);
        });
        failed.delete(url); return s;
      } catch (e) { failed.delete(url); failed.set(url, now()); while (failed.size > 100) failed.delete(failed.keys().next().value); note(shard, reason(e)); throw e; }
    } }));
  }
  async function lookup(url, tt) {
    if (typeof tt !== "string" || !PAGE_ID.test(tt)) return { status: "failed" };
    const shard = shardOf(tt);
    if (!PAGE_ID.test(tt) || !url.endsWith(`/page-${shard}.json`)) return { status: 'failed' };
    const paused = failed.has(url) && now() - failed.get(url) < 60e3;
    try {
      if (!inflight.has(url)) {
        if (inflight.size >= 100) return { status: 'failed' };
        const p = read(url, shard); inflight.set(url, p); p.finally(() => { if (inflight.get(url) === p) inflight.delete(url); }).catch(() => {});
      }
      const got = await inflight.get(url), s = got.value;
      let map = maps.get(s); if (!map) { map = new Map(s.films.map(r => [r.t, r])); maps.set(s, map); }
      const record = map.get(tt);
      return { record, people: s.people, builtAt: s.builtAt, status: !record ? 'absent' : got.from === 'stale' ? 'stale' : 'ok' };
    } catch { return { status: paused ? 'paused' : 'failed' }; }
  }
  return { lookup, _cache: cache, _failed: failed, _inflight: inflight };
}
