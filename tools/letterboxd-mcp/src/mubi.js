'use strict';
// letterboxd-mcp — the MUBI cache (<root>/cache/mubi.json, or MOOD_MUBI; since 13/10/2026 it lives in the repository, which is private; it was <root>/.context/mubi/mubi.json) as read-only data for three fields of film_dossier:
// ourTake, mubiSynopsis and mubiRating. Written by scripts/collect-mubi.py (by hand, and since 14/10/2026 every night by scripts/mubi-nightly.js on the workflow's runner); this server only READS it and never opens a connection.
// The file is read in memory at start and again when its signature (size + mtime) moves; nothing is written, no copy, no temp file.
// The path is fixed at start from the environment or the root (the way src/state.js fixes the snapshots folder); a tool input can never name it.
// A missing, oversized, unreadable or half-written file never refuses a call: it becomes { available: false, reason } and every other tool keeps answering;
// film_dossier then says `unknown` with that reason in each field. A record that does not validate is dropped alone; the others are served.
// Only the allowlisted shape of a record is kept (see `keep`); the adapter validates the values again when it builds an answer (src/adapter.js `mubiOf`).
// Covered by test/mubi.test.js (and the MUBI cases of test/state.test.js, zero-write.test.js, injection.test.js, root.test.js).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 20 * 1024 * 1024; // the cache holds a few thousand short records (about 1.5 KB each); a file far beyond this is not that cache
const DEFAULT_LIMITS = { maxBytes: MAX_BYTES };
const STATUSES = ['confirmed', 'ambiguous', 'not_found_in_search', 'error'];

/** The cache file is fixed at start from the environment or the root; a tool input can never name it. */
const mubiPathFor = (root, env = process.env) => path.resolve(env.MOOD_MUBI || path.join(root, 'cache', 'mubi.json'));
/** Where the file came from, without the path: film_health says this and nothing more. */
const mubiWhere = (env = process.env) => (env.MOOD_MUBI ? 'MOOD_MUBI' : 'cache/mubi.json');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Cheap signature of the cache (size + mtime), the way tools/films/store.js does it for the film sources and src/research.js for the package. */
function mubiSignature(file) {
  let part;
  try { const s = fs.statSync(file); part = `${s.size}:${s.mtimeMs}`; } catch { part = 'missing'; }
  return crypto.createHash('sha256').update(`mubi:${part}`).digest('hex').slice(0, 16);
}

/** The keys of a record that may be served, and nothing else: candidates, request, identity, found titles and the like stay in the file. */
function keep(rec) {
  const out = { status: rec.status };
  for (const k of ['capturedAt', 'locale', 'stale']) if (Object.hasOwn(rec, k)) out[k] = rec[k];
  if (isObject(rec.mubi)) out.mubi = { url: rec.mubi.url };
  if (isObject(rec.lastError)) out.lastError = { at: rec.lastError.at, reason: rec.lastError.reason };
  // a field present with a value that is not an object is kept as a field of no known state: the adapter answers `invalid` (a key that is not there answers not-captured)
  if (rec.status === 'confirmed') for (const k of ['ourTake', 'synopsis', 'rating']) if (Object.hasOwn(rec, k)) out[k] = isObject(rec[k]) ? { ...rec[k] } : { state: 'invalid' };
  return out;
}

/**
 * → { available: true, byId: Map(tt… → record), invalidIds: Set(tt…), updatedAt, records, discarded, stamp } or { available: false, reason, stamp }.
 * reason: no-cache (missing, or not a file), too-large (more than the ceiling), cache-invalid (not JSON, a half-written file, schema other than 1, no films object).
 * Never throws, never writes.
 */
function loadMubi(file, limits = {}) {
  const { maxBytes } = { ...DEFAULT_LIMITS, ...limits };
  const stamp = mubiSignature(file);
  const none = (reason) => ({ available: false, reason, stamp });
  let size;
  try {
    const s = fs.statSync(file);
    if (!s.isFile()) return none('no-cache');
    size = s.size;
  } catch { return none('no-cache'); }
  if (size > maxBytes) return none('too-large');
  let data;
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > maxBytes) return none('too-large'); // it grew between the stat and the read
    data = JSON.parse(buf.toString('utf8'));
  } catch { return none('cache-invalid'); }
  if (!isObject(data) || data.schema !== 1 || !isObject(data.films)) return none('cache-invalid');
  const byId = new Map();
  const invalidIds = new Set(); // IMDb ids the cache named whose record did not validate: the dossier says record-invalid for them, not "never collected"
  let discarded = 0;
  for (const [id, rec] of Object.entries(data.films)) {
    const isId = /^tt\d+$/.test(id);
    if (!isId || !isObject(rec) || !STATUSES.includes(rec.status)) { discarded++; if (isId) invalidIds.add(id); continue; }
    byId.set(id, keep(rec));
  }
  const updatedAt = typeof data.updatedAt === 'string' ? data.updatedAt : 'unknown';
  return { available: true, byId, invalidIds, updatedAt, records: byId.size, discarded, stamp };
}

module.exports = { loadMubi, mubiSignature, mubiPathFor, mubiWhere, MAX_BYTES, DEFAULT_LIMITS, STATUSES };
