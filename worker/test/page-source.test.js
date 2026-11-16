import test from 'node:test';
import assert from 'node:assert/strict';
import { createPageSource, validatePageShard } from '../src/page-source.js';
import { createJsonCache } from '../src/subtitles-source.js';
const URL65 = 'https://pages.test/data/page-65.json', TT = 'tt0057565', DAY = 86400e3;
const shard = (nn = '65', tt = TT) => ({ v: 1, builtAt: '2026-10-24T12:00:00Z', shard: nn, people: ['Ana'], films: [{ t: tt, n: 'Synthetic film', fr: { s: [[0, null]], w: [] } }] });
function harness(options = {}) {
  let time = 100, calls = 0, fail = null; const logs = [], edge = new Map();
  const caches = { default: { match: async key => edge.get(key)?.clone(), put: async (key, res) => { edge.set(key, res.clone()); } } };
  const source = createPageSource({ now: () => time, log: e => logs.push(e), caches, fetchImpl: async (url, init) => { calls++; assert.equal(init.redirect, 'manual'); assert.equal(init.cache, 'no-store'); if (fail) throw fail; const nn = /page-(\d\d)/.exec(url)[1]; return Response.json(shard(nn, nn === '65' ? TT : 'tt' + nn)); }, ...options });
  return { source, edge, logs, caches, advance: ms => { time += ms; }, down: () => { fail = Error('SECRET_TOKEN at /k/CANARY'); }, up: () => { fail = null; }, calls: () => calls };
}
test('FP source: network, memory, edge, valid absent and coalesced shard requests', async () => {
  const h = harness(); const [a, b] = await Promise.all([h.source.lookup(URL65, TT), h.source.lookup(URL65, 'tt65')]); assert.equal(a.status, 'ok'); assert.equal(b.status, 'absent'); assert.equal(h.calls(), 1);
  assert.equal((await h.source.lookup(URL65, TT)).status, 'ok'); assert.equal(h.calls(), 1);
  h.source._cache._memory.clear(); assert.equal((await h.source.lookup(URL65, TT)).status, 'ok'); assert.equal(h.calls(), 1); assert.equal(h.source._inflight.size, 0);
});
test('FP source: stale time is not renewed, pause and resume, seven-day expiry', async () => {
  const h = harness(); await h.source.lookup(URL65, TT); const at = [...h.source._cache._memory.values()][0].at; h.advance(31 * 60e3); h.down(); assert.equal((await h.source.lookup(URL65, TT)).status, 'stale'); const calls = h.calls(); assert.equal((await h.source.lookup(URL65, TT)).status, 'stale'); assert.equal(h.calls(), calls); assert.equal([...h.source._cache._memory.values()][0].at, at);
  h.advance(61e3); h.up(); assert.equal((await h.source.lookup(URL65, TT)).status, 'ok'); assert.equal(h.calls(), calls + 1);
  h.advance(7 * DAY + 1); h.down(); assert.equal((await h.source.lookup(URL65, TT)).status, 'failed'); assert.equal((await h.source.lookup(URL65, TT)).status, 'paused');
  for (const l of h.logs) { assert.deepEqual(Object.keys(l).sort(), ['event', 'reason', 'shard']); assert.equal(l.event, 'page-shard-unavailable'); assert.equal(l.shard, '65'); assert.doesNotMatch(JSON.stringify(l), /SECRET|CANARY|https|tt005|Synthetic/); }
});
test('FP source: edge corruption is skipped, invalid source preserves good stale memory', async () => {
  const h = harness(); await h.source.lookup(URL65, TT); h.advance(31 * 60e3); const key = [...h.edge.keys()][0]; h.edge.set(key, Response.json({ ...shard(), films: [{ t: TT, n: 'bad', rating: 5 }] }, { headers: { 'x-fetched-at': String(100 + 31 * 60e3) } })); h.down(); assert.equal((await h.source.lookup(URL65, TT)).record.n, 'Synthetic film');
  h.source._cache._memory.clear(); h.advance(61e3); h.up(); assert.equal((await h.source.lookup(URL65, TT)).status, 'ok'); assert.equal(h.calls(), 3);
});
test('FP source: every layer validates ids, duplicates, people, numbers and allowlists', async () => {
  for (const change of [s => s.v = 2, s => s.shard = '64', s => s.films.push(s.films[0]), s => s.films[0].fr.s[0][0] = 9, s => s.films[0].lb = null, s => s.films[0].mo = [['noir', Infinity]], s => s.films[0].why = 'private', s => s.people = [5], s => s.films[0].c = ['A', 'B', 'C', 'D', 'E', 'F']]) {
    const value = shard(); change(value); assert.throws(() => validatePageShard(value, '65'), /invalid page shard/);
    const h = harness({ fetchImpl: async () => Response.json(value) }); assert.equal((await h.source.lookup(URL65, TT)).status, 'failed');
  }
  const h = harness(); await h.source.lookup(URL65, TT); [...h.source._cache._memory.values()][0].value.films[0].rating = 5; h.edge.clear(); h.down(); assert.equal((await h.source.lookup(URL65, TT)).status, 'failed');
});
test('FP source: 25th shard evicts LRU, hits refresh order, JSON byte ceiling holds', async () => {
  const h = harness();
  const get = i => h.source.lookup(`https://pages.test/data/page-${String(i).padStart(2, '0')}.json`, 'tt' + String(i).padStart(2, '0'));
  for (let i = 0; i < 24; i++) assert.equal((await get(i)).status, 'ok');
  await get(0); await get(24); const keys = [...h.source._cache._memory.keys()]; assert.equal(keys.length, 24); assert.ok(keys.some(k => k.endsWith('page-00.json'))); assert.ok(!keys.some(k => k.endsWith('page-01.json')));
  const small = harness({ maxBytes: 1 }); await small.source.lookup(URL65, TT); assert.equal(small.source._cache._memory.size, 0);
});
test('FP source: body bytes and complete-operation deadlines bound uncooperative source and cache', async () => {
  const over = () => { const value = shard(); value.films[0].n = 'x'.repeat(600 * 1024); const bytes = new TextEncoder().encode(JSON.stringify(value)); return new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 300 * 1024)); c.enqueue(bytes.slice(300 * 1024)); c.close(); } }), { headers: { 'content-length': '1' } }); };
  const bodies = [() => new Response('bad json'), () => new Response('', { status: 404 }), () => new Response('', { status: 302 }), over, () => new Promise(() => {}), () => new Response(new ReadableStream({ start() {} }))];
  for (const body of bodies) { const h = harness({ timeoutMs: 15, lookupTimeoutMs: 80, fetchImpl: async () => body() }); const start = Date.now(); assert.equal((await h.source.lookup(URL65, TT)).status, 'failed'); assert.ok(Date.now() - start < 300, 'whole request bounded'); }
  const h = harness({ timeoutMs: 15, cacheTimeoutMs: 10, lookupTimeoutMs: 100, caches: { default: { match: () => new Promise(() => {}), put: () => new Promise(() => {}) } } }); assert.equal((await h.source.lookup(URL65, TT)).status, 'ok');
});
test('FP source: optional JSON cache validation applies to edge and bounded memory without changing defaults', async () => {
  const cache = createJsonCache({ caches: undefined }); let n = 0;
  assert.equal((await cache.through('old', { ttlMs: 1000, load: async () => ++n })).value, 1); assert.equal((await cache.through('old', { ttlMs: 1000, load: async () => ++n })).from, 'memory'); assert.equal(n, 1);
});
test('FP source: source deadline aborts signal even when fetch ignores abort', async () => {
  let aborted = false;
  const source = createPageSource({ caches: undefined, timeoutMs: 10, lookupTimeoutMs: 80, fetchImpl: async (_u, { signal }) => { signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); } });
  assert.equal((await source.lookup(URL65, TT)).status, 'failed'); assert.equal(aborted, true);
});
