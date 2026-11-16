// Offline, read-only HTTP parity check against a supplied public index. No build or network.
// node scripts/check-cpu-option-snapshot.mjs --index PATH --expect complete-animation
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHandler } from '../worker/src/handler.js';
import { createStore } from '../worker/src/store.js';
import { hydrate } from '../worker/src/film.js';
import { page } from '../worker/src/catalogs.js';
import { friendOf, FRIEND_SLUGS } from '../worker/src/friends.js';
const require = createRequire(import.meta.url);
const { decode, encode } = require('../lib/index-rows.js');
const { optionPieces, optionCut, pieces2, discoverLabels } = require('../lib/index-export.js');
const args = process.argv.slice(2);
assert.equal(args.length, 4, 'usage: --index PATH --expect complete-animation');
assert.equal(args[0], '--index');
assert.equal(args[2], '--expect');
assert.equal(args[3], 'complete-animation');
const bytes = fs.readFileSync(args[1]), raw = JSON.parse(bytes), ix = decode(raw);
const before = JSON.stringify(ix), whole = hydrate(raw), byTt = new Map(ix.films.map((f) => [f.tt, f]));
const text = (obj) => JSON.stringify(encode(obj));
const target = 'v2-opt:genres:g-animation';
const parts = optionPieces(ix), fullParts = pieces2(ix);
const selected = parts.find((p) => p.part === target);
assert.ok(selected, 'snapshot must contain Animation');
const selectedOption = (obj) => obj.discover.catalogs.find((c) => c.id === 'genres').options.find((o) => o.id === 'g-animation');
// Independent reconstruction of the old policy, including exact envelope and contextual director text.
function prefixPiece(cat, option) {
  const cut = optionCut(byTt, option), ids = option.ids.slice(0, cut.n), keep = new Set(ids);
  const films = ix.films.filter((f) => keep.has(f.tt));
  const labels = discoverLabels(ix.discover);
  const loves = option.director === undefined ? null : ix.directors.options.find((d) => d.label === option.director);
  return { ...ix, meta: { ...ix.meta, part: `v2-opt:${cat.id}:${option.id}`, count: films.length }, board: [], rows: {}, rowDesc: {},
    friends: { people: ix.friends.people, options: ix.friends.options.map((o) => ({ label: o.label, ids: [] })) },
    directors: { options: ix.directors.options.map((d) => loves && d.label === loves.label ? loves : { label: d.label, ids: [], descs: [] }) },
    discover: { ...labels, catalogs: labels.catalogs.map((c) => c.id !== cat.id ? c : { ...c, options: c.options.map((o) => o.id !== option.id ? o : { ...o, ids, total: cut.total, totalAll: cut.totalAll }) }) }, films };
}
let unchanged = 0, complete = 0;
for (const cat of ix.discover.catalogs) for (const option of cat.options) {
  if (!option.ids) continue;
  const p = parts.find((p) => p.part === `v2-opt:${cat.id}:${option.id}`);
  const actual = p.obj.discover.catalogs.find((c) => c.id === cat.id).options.find((o) => o.id === option.id);
  if (actual.ids.length === option.ids.length) complete++;
  if (p.part !== target) { assert.equal(text(p.obj), text(prefixPiece(cat, option)), `${p.part}: unchanged bytes`); unchanged++; }
}
const origin = 'https://snapshot.test/data/';
const files = Object.fromEntries([...fullParts, ...parts].map((p) => [path.basename(p.rel), text(p.obj)]));
const menu = files['index-v2-menus.json'];
function rig(available) {
  const calls = [];
  const store = createStore({ caches: undefined, log() {}, fetchImpl: async (url) => {
    const name = url.slice(origin.length); calls.push(name);
    return available[name] ? new Response(available[name]) : new Response('missing', { status: 404 });
  } });
  const handle = createHandler({ store });
  return { calls, async get(route) {
    const res = await handle(new Request('https://snapshot-worker.test' + route), { INDEX_URL: origin + 'index.json' });
    return { status: res.status, body: await res.text(), headers: Object.fromEntries([...res.headers].filter(([k]) => !['x-index-source', 'x-index-age-seconds'].includes(k))) };
  } };
}
const candidate = rig(files), reference = rig({ 'index-v2.json': JSON.stringify(raw), 'index-v2-menus.json': menu });
const filters = [{}, { country: 'Japan' }, { decade: '1990s' }, { runtime: 'Under 90 min' }, { rating: '4.2+' },
  { country: 'Japan', decade: '1990s', runtime: 'Under 90 min', rating: '4.2+' }, { seen: 'Include seen' },
  { seen: 'Include seen', country: 'Japan' }, { runtime: 'invalid' }, { country: 'Atlantis' }];
const route = (who, catalog, extras) => (who ? `/u/${who}` : '') + `/catalog/movie/${catalog}/` + Object.entries(extras).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') + '.json';
const differences = [];
let compared = 0;
for (const who of [null, ...FRIEND_SLUGS]) for (const filter of filters) {
  const extras = { genre: 'Animation', ...filter };
  const viewer = who ? { seen: friendOf(whole, who).seen } : undefined;
  const count = page(whole, 'genres', extras, viewer).total;
  for (const skip of [0, 100, 200, 300, 400, 17, Math.max(0, count - 1), count + 100]) {
    const url = route(who, 'genres', { ...extras, skip });
    const a = await candidate.get(url), b = await reference.get(url);
    try { assert.equal(a.status, 200); assert.deepEqual(a, b); } catch { differences.push(url); }
    compared++;
  }
}
const fullReads = candidate.calls.filter((n) => n === 'index-v2.json').length;
// Controls use all files and allow the existing fallback. They check unrelated catalog/card/search behavior.
const controls = [
  '/u/william/catalog/movie/places/genre=Italy&skip=100.json', '/catalog/movie/wicked.json',
  '/catalog/movie/places/genre=Brazil&runtime=Under%2090%20min.json',
  '/u/friend-g/catalog/movie/places/genre=Germany&seen=Include%20seen.json',
  '/catalog/movie/genres/genre=missing.json', '/catalog/movie/search/search=japan.json', '/catalog/movie/search/search=love.json',
];
const director = ix.discover.catalogs.flatMap((c) => c.options.map((o) => ({ c, o }))).find(({ o }) => /coppola/i.test(o.director || o.label));
if (director) controls.push(route(null, director.c.id, { genre: director.o.label }));
const curated = ix.discover.catalogs.flatMap((c) => c.options.map((o) => ({ c, o }))).find(({ o }) => o.curated && o.ids?.some((id) => !byTt.get(id).eligible));
if (curated) controls.push(route(null, curated.c.id, { genre: curated.o.label, seen: 'Include seen' }));
if (ix.lists[0]) controls.push(route(null, 'search', { search: ix.lists[0].short || ix.lists[0].label }));
const control = rig({ ...files, 'index-v2.json': JSON.stringify(raw) });
for (const url of controls) {
  try { assert.deepEqual(await control.get(url), await reference.get(url)); } catch { differences.push(url); }
}
assert.equal(JSON.stringify(ix), before, 'source unchanged');
const opt = selectedOption(selected.obj), fullOpt = selectedOption(ix);
const result = { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), builtAt: raw.meta.builtAt,
  wholeBytes: bytes.length, pieces: parts.length, complete, partial: parts.length - complete, unchangedOtherPieces: unchanged,
  animation: { films: selected.obj.films.length, bytes: Buffer.byteLength(text(selected.obj)), total: opt.total, totalAll: opt.totalAll,
    fullCoverage: JSON.stringify(opt.ids) === JSON.stringify(fullOpt.ids) }, comparisons: compared, controls: controls.length, fullReads, differences };
console.log(JSON.stringify(result, null, 2));
assert.equal(compared, 640);
assert.equal(result.animation.fullCoverage, true, 'Animation must cover every candidate');
assert.equal(fullReads, 0, 'complete Animation must never attempt the full index');
assert.deepEqual(differences, [], 'HTTP parity');
