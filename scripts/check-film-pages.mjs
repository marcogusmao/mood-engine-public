// Read-only: inspect an already-built publication. Never build or fetch network data.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { toPage } from '../worker/src/page.js';
import { createPageSource } from '../worker/src/page-source.js';
import { createHandler } from '../worker/src/handler.js';
import { createStore } from '../worker/src/store.js';
const require = createRequire(import.meta.url);
const { decode } = require('../lib/index-rows');
const { verifyPages } = require('../lib/page-validation');
export const SAMPLE = 'tt0292963 tt5078214 tt0265666 tt2756032 tt0076104 tt0084777 tt15296186 tt0050539 tt21807222 tt0056196 tt0398808 tt7557108 tt0081633 tt2937696 tt0071571 tt1843961 tt0091578 tt0107692 tt0115906 tt30052206 tt0053306 tt3189338 tt0039535 tt0209950 tt0280168 tt0074187 tt0053876 tt0104663 tt0092561 tt0114684'.split(' ');
// The trailer gate (spec step 2.6, 20/10/2026): of a sample of 30 films drawn when the film page was written, at least 22 carry a trailer, which is the same as "at most 8 do not".
// A sample film can leave the index for a reason that has nothing to do with trailers, and then the gate must not turn red: until 14/11/2026 it asked for all 30 to be present, and
// Mira (2022, tt15296186) had left. It was in the index only as ONE TMDB recommendation of ONE seed (Solaris), build.js keeps the best 1,100 of those candidates (config.json build.pool),
// and on 14/11/2026 it was number 1,130 of 3,422 by the build's preliminary score (its TMDB average in the cache: 7.556 on 24/10, 7.535 on 14/11). So the gate now reads only the sample films that are still in the index:
//   · at most SAMPLE_MAX_WITHOUT (8) of them lack a trailer: with all 30 present that is the original "≥22 of 30", and a film that leaves can never make it fail;
//   · at least SAMPLE_MIN_PRESENT (24) of the 30 are still there: under that the sample says too little (8 without a trailer would be a third of it) and has to be drawn again.
// With both, at least 16 sample films carry a trailer; a build whose pages lost the trailer field has 0 and fails, whichever films are in the index.
export const SAMPLE_MAX_WITHOUT = 8, SAMPLE_MIN_PRESENT = 24;
/** `records`: Map of IMDb id → page record (`yt` is the trailer). Counts the sample and, unless `gate` is false, fails as the comment above says. */
export function trailerSample(records, { sample = SAMPLE, gate = true } = {}) {
  const present = sample.filter(tt => records.has(tt)), sampleWithTrailer = present.filter(tt => records.get(tt).yt).length, samplePresent = present.length, without = samplePresent - sampleWithTrailer;
  if (gate) {
    assert.ok(samplePresent >= SAMPLE_MIN_PRESENT, `trailer sample too thin: ${samplePresent} of its ${sample.length} films are in the index, fewer than ${SAMPLE_MIN_PRESENT}; draw a new sample (absent: ${sample.filter(tt => !records.has(tt)).join(' ')})`);
    assert.ok(without <= SAMPLE_MAX_WITHOUT, `trailer gate: ${without} of the ${samplePresent} sample films in the index have no trailer (${sampleWithTrailer} have one), more than ${SAMPLE_MAX_WITHOUT}`);
  }
  return { samplePresent, sampleWithTrailer, sampleSize: sample.length, sampleAbsent: sample.filter(tt => !records.has(tt)) };
}
export function validateMeta(meta) {
  assert.deepEqual(meta.videos, []); assert.equal(meta.behaviorHints.defaultVideoId, meta.id); assert.equal(meta.behaviorHints.hasScheduledVideos, false); assert.ok(meta.description.length <= 280); assert.ok(!meta.description.startsWith('MUBI:'));
  const text = JSON.stringify(meta); assert.ok(Buffer.byteLength(JSON.stringify({ meta, cacheMaxAge: 21600 })) <= 8192, `${meta.id}: page exceeds 8 KiB`); assert.doesNotMatch(text, /\/k\/|"(?:ownRating|rating|why|watchlist|taste|fingerprint)":|you rate\b|[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  for (const name of ['poster', 'logo', 'background']) { const u = new URL(meta[name]); assert.equal(u.protocol, 'https:'); assert.equal(u.host, 'images.metahub.space'); assert.equal(u.pathname.split('/')[3], meta.id); }
  const categories = [], rank = new Map(['imdb', 'share', 'Directors', 'Cast', 'Mood', 'Lists'].map((c, i) => [c, i]));
  for (const l of meta.links) {
    if (categories.at(-1) !== l.category) categories.push(l.category);
    assert.ok(rank.has(l.category)); const u = new URL(l.url); assert.ok(['https:', 'stremio:'].includes(u.protocol)); assert.equal(u.username + u.password, '');
    if (u.protocol === 'https:') { assert.ok(u.hostname); if (l.category === 'imdb') { assert.equal(u.host, 'imdb.com'); assert.equal(u.pathname, `/title/${meta.id}`); } else { assert.equal(u.host, 'letterboxd.com'); assert.equal(u.pathname, `/imdb/${meta.id}/`); } }
    else if (u.pathname === '/search') { assert.ok(l.url.startsWith('stremio:///search?search=')); assert.equal([...u.searchParams.keys()].join(), 'search'); assert.ok(u.searchParams.get('search')); }
    else { const p = u.pathname.split('/'); assert.ok(l.url.startsWith('stremio:///discover/')); assert.equal(decodeURIComponent(p[2]), 'https://v3-cinemeta.strem.io/manifest.json'); assert.deepEqual(p.slice(3), ['movie', 'top']); assert.ok(u.searchParams.get('genre')); }
  }
  assert.deepEqual(categories, [...categories].sort((a, b) => rank.get(a) - rank.get(b))); return Buffer.byteLength(JSON.stringify({ meta, cacheMaxAge: 21600 }));
}
export async function scanFilmPages(outDir, { trailerGate = true } = {}) {
  const dir = path.resolve(outDir), data = path.join(dir, 'data');
  const index = decode(JSON.parse(fs.readFileSync(path.join(data, 'index-v2.json'), 'utf8')));
  const stats = verifyPages(dir, index), records = new Map(); let largestShard = { bytes: 0 }, largestMeta = { bytes: 0 }, totalBytes = 0, trailers = 0;
  for (let i = 0; i < 100; i++) {
    const name = `page-${String(i).padStart(2, '0')}.json`, raw = fs.readFileSync(path.join(data, name)); totalBytes += raw.length; if (raw.length > largestShard.bytes) largestShard = { name, bytes: raw.length };
    const s = JSON.parse(raw);
    for (const r of s.films) { records.set(r.t, r); const meta = toPage(r, { people: s.people, moods: index.moods, moodMenu: index.moodMenu, lists: index.lists }); const bytes = validateMeta(meta); if (bytes > largestMeta.bytes) largestMeta = { tt: r.t, bytes }; if (r.yt) trailers++; }
  }
  const calls = [], base = 'https://pages.test/data/';
  const fetchImpl = async url => {
    assert.ok(url.startsWith(base)); const name = url.slice(base.length); assert.match(name, /^(?:page-\d{2}|index-v2-menus)\.json$/); calls.push(name);
    const file = path.join(data, name); return fs.existsSync(file) ? new Response(fs.readFileSync(file)) : new Response('', { status: 404 });
  };
  const pages = createPageSource({ fetchImpl, caches: undefined });
  const handle = createHandler({ store: createStore({ fetchImpl, caches: undefined, log: () => {} }), pages, publication: async () => { throw Error('No person publication allowed'); } });
  const request = p => handle(new Request('https://worker.test' + p), { INDEX_URL: base + 'index.json' });
  const manifest = await request('/page/manifest.json'); assert.equal(manifest.status, 200); assert.equal(calls.length, 0);
  // Confirm representative IMDb identities in the artifact, rather than guessing Face to Face's id.
  const ids = ['tt0057565', 'tt0104652', 'tt0056196'].filter(tt => records.has(tt));
  const face = index.films.find(e => /^face to face$/i.test(e.name)); if (face) ids.push(face.tt);
  const minimal = [...records.values()].sort((a, b) => Object.keys(a).length - Object.keys(b).length)[0]; if (minimal) ids.push(minimal.t);
  for (const tt of new Set(ids)) { const res = await request(`/page/meta/movie/${tt}.json`); assert.equal(res.status, 200); assert.equal(res.headers.get('X-Page'), 'ok'); validateMeta((await res.json()).meta); }
  let absent = 1; while (records.has('tt' + absent)) absent++; assert.equal((await request(`/page/meta/movie/tt${absent}.json`)).status, 404);
  const before = calls.length; for (const p of ['/page/meta/series/tt1.json', '/u/friend-a/page/manifest.json', '/p/marco/page/manifest.json']) assert.equal((await request(p)).status, 404); assert.equal(calls.length, before);
  const sampled = trailerSample(records, { gate: trailerGate });
  return { films: stats.films, bytes: totalBytes, largestShard, largestMeta, trailers, withoutExportedTrailer: records.size - trailers,
    // Both null and undefined intentionally omit yt. The public artifact cannot distinguish them.
    unknownTrailer: null, noTrailer: null, trailerStateLimit: 'Consult the build Film pages receipt for null versus unqueried; both omit yt in public JSON.', ...sampled, representativeIds: [...new Set(ids)] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) { console.error('Usage: node scripts/check-film-pages.mjs <existing-out-dir>'); process.exitCode = 1; }
  else try { console.log(JSON.stringify(await scanFilmPages(process.argv[2]), null, 2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
