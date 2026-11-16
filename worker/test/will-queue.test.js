// S8 of the re-review of 1fa2b15 (20/10/2026): Will's files shared Marco's 12-piece queue. isPermanent excludes the /u/ paths, so Will's index and row slices were LRU pieces beside Marco's, and a Will
// load that failed was also registered (size 0) by `if (queued) touch(url)` in the `finally` of `refresh`. Measured on the fixture then: 12 Marco pieces and Will's Board (54 rows) -> 12 of 12 Marco
// pieces let go and read again (measured: main 5c0be73 12 and 12, 1fa2b15 without S8 12 and 12, this branch 0 and 0); one Will load answering 503 -> 12 re-reads. Now Will has a queue of his own (`_willLru`, WILL_PIECE_CACHE_MAX / WILL_PIECE_CACHE_BYTES) and a
// failed load enters no queue. Fake fetch and a fake Cache API; nothing reads the network or a live cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, WILL_PIECE_CACHE_MAX, WILL_PIECE_CACHE_BYTES, PIECE_CACHE_MAX, AGGREGATE_INDEX_BYTES } from '../src/store.js';
import { textOf, makeObject } from './fixture.js';

const REV = 'r-' + '1'.repeat(32);
const MARCO = 'https://pages.test/mood-engine/data/';
const WILL = `https://pages.test/mood-engine/u/friend-a/r/${REV}/data/`;
const marcoPiece = n => `${MARCO}index-list-${n}.json`;
const willPiece = n => `${WILL}index-v2-row-${n}.json`;
const marcoText = () => textOf(makeObject());
const willText = (pad = '') => { const o = makeObject(); o.meta.personId = 'friend-a'; o.meta.revision = REV; o.meta.pad = pad; return textOf(o); };

function rig({ willPad = '', ...opts } = {}) {
  const r = { fetches: [], matches: [], logs: [], failWill: false, cacheMap: new Map(), clock: 1e9 };
  r.store = createStore({
    fetchImpl: async url => {
      r.fetches.push(url);
      if (url.includes('/u/')) return r.failWill ? new Response('unavailable', { status: 503 }) : new Response(willText(willPad));
      return new Response(marcoText());
    },
    caches: { default: { match: async key => { r.matches.push(key); const v = r.cacheMap.get(key); return v ? new Response(v.text, { headers: { 'x-fetched-at': String(v.at) } }) : undefined; }, put: async (key, res) => { r.cacheMap.set(key, { text: await res.text(), at: Number(res.headers.get('x-fetched-at')) }); } } },
    now: () => r.clock, log: o => r.logs.push(o), ...opts,
  });
  r.evictedMarco = () => r.logs.filter(l => l.event === 'piece-evicted' && !l.url.includes('/u/')).length;
  return r;
}
/** Marco's pieces asked again: how many went to the network or the Cache API, and from where each was answered. */
async function askMarcoAgain(r, n = 12) {
  const fetches = r.fetches.length, matches = r.matches.length, sources = [];
  for (let i = 1; i <= n; i++) sources.push((await r.store.get(marcoPiece(i))).source);
  return { fetched: r.fetches.length - fetches, cacheReads: r.matches.length - matches, sources };
}

test('S8: the constants (own queue, inside the aggregate ceiling that is Will\'s alone)', () => {
  assert.equal(WILL_PIECE_CACHE_MAX, 12);
  assert.equal(WILL_PIECE_CACHE_BYTES, 20e6);
  assert.ok(WILL_PIECE_CACHE_BYTES < AGGREGATE_INDEX_BYTES);
  assert.equal(PIECE_CACHE_MAX, 12);
});

test('S8: 12 Marco pieces, then Will\'s Board (54 row slices, the index and the menus): 0 Marco pieces let go, 0 re-reads', async () => {
  const r = rig();
  for (let n = 1; n <= 12; n++) await r.store.get(marcoPiece(n));
  assert.equal(r.store._lru.size, 12);
  for (let n = 0; n < 54; n++) assert.ok(await r.store.get(willPiece(n)), 'row ' + n);
  await r.store.get(`${WILL}index.json`); await r.store.get(`${WILL}index-v2-menus.json`);
  assert.equal(r.evictedMarco(), 0);
  assert.deepEqual([...r.store._lru.keys()], Array.from({ length: 12 }, (_, n) => marcoPiece(n + 1)), 'Marco\'s queue is the same 12, in the same order');
  const again = await askMarcoAgain(r);
  assert.deepEqual([again.fetched, again.cacheReads], [0, 0]);
  assert.ok(again.sources.every(s => s === 'memory'));
  assert.ok(r.store._willLru.size <= WILL_PIECE_CACHE_MAX && r.store._willLru.size > 0, 'Will\'s own queue did the letting go: ' + r.store._willLru.size);
  assert.ok(r.logs.some(l => l.event === 'piece-evicted' && l.url.includes('/u/')));
});

test('S8: a Will load that answers 503 changes nothing for Marco: 0 re-reads of his 12 pieces', async () => {
  const r = rig();
  for (let n = 1; n <= 12; n++) await r.store.get(marcoPiece(n));
  r.failWill = true;
  assert.equal(await r.store.get(willPiece(1)), null);
  assert.equal(await r.store.get(`${WILL}index.json`), null);
  assert.ok(r.logs.some(l => l.event === 'index-unavailable' && l.url === willPiece(1)), 'the failure was seen');
  assert.equal(r.evictedMarco(), 0);
  const again = await askMarcoAgain(r);
  assert.deepEqual([again.fetched, again.cacheReads], [0, 0]);
});

test('S8: a Will piece that fails (503) enters no queue and holds no bytes: 12 good Will pieces stay, in order, nothing let go', async () => {
  const r = rig();
  for (let n = 1; n <= 12; n++) await r.store.get(willPiece(n));
  const queue = [...r.store._willLru.keys()];
  assert.equal(queue.length, 12);
  r.failWill = true;
  assert.equal(await r.store.get(willPiece(13)), null);
  assert.equal(r.store._willLru.has(willPiece(13)), false, 'the failed piece is not in the queue');
  assert.equal(r.store._slots.get(willPiece(13))?.bytes ?? 0, 0, 'and holds no bytes');
  assert.equal(r.store._slots.get(willPiece(13))?.index ?? null, null);
  assert.deepEqual([...r.store._willLru.keys()], queue, 'the 12 good ones, in order');
  assert.equal(r.logs.filter(l => l.event === 'piece-evicted').length, 0, 'no good piece was let go for it');
  assert.ok(queue.every(u => r.store._slots.get(u).index), 'every good piece is still in memory');
});

test('S8: Will\'s queue has its own size and byte ceiling: 13 pieces with a limit of 12 let the first go; a small byte ceiling keeps the newest', async () => {
  const r = rig();
  for (let n = 1; n <= 13; n++) await r.store.get(willPiece(n));
  assert.equal(r.store._willLru.size, 12);
  assert.equal(r.store._slots.get(willPiece(1)), undefined, 'Will\'s slot record goes with the piece');
  assert.ok(!r.store._willLru.has(willPiece(1)) && r.store._willLru.has(willPiece(13)));
  const tiny = rig({ willPieceBytes: 1000 });
  await tiny.store.get(willPiece(1)); await tiny.store.get(willPiece(2));
  assert.deepEqual([...tiny.store._willLru.keys()], [willPiece(2)], 'the byte ceiling is Will\'s own; the piece just loaded stays even when it alone is over');
  const bigMarco = rig({ pieceBytes: 1 });
  await bigMarco.store.get(willPiece(1)); await bigMarco.store.get(willPiece(2));
  assert.equal(bigMarco.store._willLru.size, 2, 'Marco\'s byte ceiling does not apply to Will');
});

test('S8: Marco\'s pieces still follow Marco\'s own queue (12, least recently used out) while Will loads in between', async () => {
  const r = rig();
  for (let n = 1; n <= 6; n++) { await r.store.get(marcoPiece(n)); await r.store.get(willPiece(n)); }
  for (let n = 7; n <= 13; n++) { await r.store.get(marcoPiece(n)); await r.store.get(willPiece(n)); }
  assert.equal(r.store._lru.size, 12);
  assert.equal(r.store._slots.get(marcoPiece(1)).index, null, 'Marco\'s first piece went by Marco\'s own count');
  assert.equal(r.store._willLru.size, 12);
  assert.equal(r.evictedMarco(), 1);
});

test('S8: Will\'s count is Will\'s own: a Marco limit of 3 does not shrink it (12 stay), and Will\'s limit of 3 does not shrink Marco\'s', async () => {
  const r = rig({ pieceMax: 3 });
  for (let n = 1; n <= 12; n++) await r.store.get(willPiece(n));
  assert.equal(r.store._willLru.size, 12);
  const w = rig({ willPieceMax: 3 });
  for (let n = 1; n <= 12; n++) await w.store.get(marcoPiece(n));
  for (let n = 1; n <= 12; n++) await w.store.get(willPiece(n));
  assert.equal(w.store._lru.size, 12);
  assert.equal(w.store._willLru.size, 3);
});

test('S8: a Will piece let go by the aggregate ceiling or by the 128 slots leaves no entry behind in Will\'s queue', async () => {
  const big = rig({ willPad: 'x'.repeat(1024 * 1024), willPieceMax: 500, willPieceBytes: 1e12 });
  for (let n = 1; n <= 35; n++) await big.store.get(willPiece(n));
  assert.ok(big.logs.some(l => l.event === 'aggregate-evicted'), 'the ceiling let go of some');
  assert.deepEqual([...big.store._willLru.keys()].filter(u => !big.store._slots.has(u)), [], 'every queue entry has its slot (ceiling)');
  assert.ok(big.store._willLru.size <= 24 && big.store._willLru.size > 0);
  const many = rig({ willPieceMax: 500, willPieceBytes: 1e12 });
  for (let n = 1; n <= 140; n++) await many.store.get(willPiece(n));
  assert.deepEqual([...many.store._willLru.keys()].filter(u => !many.store._slots.has(u)), [], 'every queue entry has its slot (128 slots)');
  assert.ok(many.store._willLru.size <= 128);
});
