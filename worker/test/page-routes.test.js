// This suite deliberately imports only modules present before the film page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/handler.js';
const record = { t: 'tt0057565', n: 'Synthetic film', syn: 'A quiet arrival.', mo: [['night', 1]], li: [['critic', 1]] };
const menus = { meta: { schema: 1, part: 'v2-menus' }, moodMenu: [{ id: 'night', label: 'Nocturnal' }], moods: [{ id: 'night', name: '🌃 Night drive', label: 'Nocturnal' }], lists: [{ id: 'critic', label: 'A critic list' }] };
function harness({ absent = false, pages, store } = {}) {
  const calls = [];
  const handle = createHandler({ publication: async () => { calls.push('DO'); throw Error('No DO'); }, store: store || { get: async u => { calls.push(u); assert.match(u, /index-v2-menus.json$/); return { index: menus }; } }, pages: pages || { lookup: async (u, tt) => { calls.push(u); assert.match(u, /page-\d{2}.json$/); return { status: absent ? 'absent' : 'ok', record: { ...record, t: tt }, people: [], builtAt: '2026-10-24T12:00:00Z' }; } } });
  return { calls, request: (p, method = 'GET', env = {}) => handle(new Request('https://fixture.test' + p, { method }), env) };
}
test('FP route: public manifest declares long movie meta without reading data', async () => {
  const h = harness(), r = await h.request('/page/manifest.json'); assert.equal(r.status, 200);
  const m = await r.json(); assert.equal(m.id, 'com.mgusmao.moodengine.page'); assert.deepEqual(m.resources, [{ name: 'meta', types: ['movie'], idPrefixes: ['tt'] }]); assert.deepEqual(m.catalogs, []); assert.equal(h.calls.length, 0);
});
test('FP route: movie page uses only menus and its last-two-digits shard', async () => {
  const h = harness(), r = await h.request('/page/meta/movie/tt0057565.json'); assert.equal(r.status, 200); const b = await r.json(); assert.equal(b.meta.id, record.t); assert.deepEqual(b.meta.videos, []); assert.equal(r.headers.get('X-Page'), 'ok'); assert.equal(h.calls.length, 2); assert.ok(h.calls.some(u => u.endsWith('page-65.json')));
  h.calls.length = 0; assert.equal((await h.request('/page/meta/movie/tt1.json')).status, 200); assert.ok(h.calls.some(u => u.endsWith('page-01.json')));
});
test('FP route: invalid, profile, person and root meta routes read nothing', async () => {
  for (const p of ['/page/meta/series/tt1.json', '/page/meta/movie/tt.json', '/page/meta/movie/tt12a.json', '/page/meta/movie/TT12.json', '/page/meta/movie/tt1:1:1.json', '/page/meta/movie/tt12345678901.json', '/page/meta/movie/%74t1.json', '/page/meta/movie/tt1.json/extra', '/p/marco/page/manifest.json', '/u/friend-a/page/manifest.json', '/u/friend-a/meta/movie/tt1.json', '/u/friend-a/p/marco/page/manifest.json', '/meta/movie/tt1.json', '/k/incorrect/page/manifest.json']) {
    const h = harness(); assert.equal((await h.request(p)).status, 404, p); assert.deepEqual(h.calls, [], p);
  }
});
test('FP route: absent bypasses hung menus; failed shard is no-store', async () => {
  const h = harness({ absent: true, store: { get: () => new Promise(() => {}) } }); const r = await h.request('/page/meta/movie/tt1.json'); assert.equal(r.status, 404); assert.equal(r.headers.get('X-Page'), 'absent');
  const f = harness({ pages: { lookup: async () => ({ status: 'failed' }) } }); const bad = await f.request('/page/meta/movie/tt1.json'); assert.equal(bad.status, 503); assert.equal(bad.headers.get('Cache-Control'), 'no-store');
});
test('FP route: private page hides token and preserves HEAD and CORS', async () => {
  const h = harness(), token = 'SYNTHETIC_TOKEN_123456789'; const r = await h.request(`/k/${token}/page/meta/movie/tt1.json`, 'GET', { SUBTITLES_PRIVATE_TOKEN: token }); assert.equal(r.status, 200); assert.match(r.headers.get('Cache-Control'), /^private/); assert.equal(r.headers.get('Referrer-Policy'), 'no-referrer'); assert.doesNotMatch(await r.text(), /SYNTHETIC_TOKEN|\/k\//);
  const head = await h.request('/page/manifest.json', 'HEAD'); assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.equal((await h.request('/page/manifest.json', 'OPTIONS')).status, 204); assert.equal((await h.request('/page/manifest.json', 'POST')).status, 405);
});
test('FP route: present movie with hung or unresolved menus is bounded 503, never partial 200', async () => {
  const pages = { lookup: async () => ({ record, people: [], builtAt: '2026-10-24T12:00:00Z', status: 'ok' }) };
  for (const store of [{ get: () => new Promise(() => {}) }, { get: async () => ({ index: { ...menus, moods: [] } }) }, { get: async () => { throw Error('unavailable'); } }]) {
    const handle = createHandler({ pages, store, pageTimeoutMs: 15 }); const r = await handle(new Request('https://fixture.test/page/meta/movie/tt0057565.json')); assert.equal(r.status, 503); assert.equal(r.headers.get('Cache-Control'), 'no-store');
  }
});

test('FP review: cached menu labels cannot introduce private strings into public pages', async () => {
  const { createRequire } = await import('node:module'), require=createRequire(import.meta.url);
  const {fixture}=require('../../test-support/film-page-fixture'), {pieces2}=require('../../lib/index-export'), {encode}=require('../../lib/index-rows');
  const {createStore}=await import('../src/store.js'), {createPageSource}=await import('../src/page-source.js');
  for(const text of ['reviewer@example.test', '/k/SYNTHETIC_PRIVATE_TOKEN', 'you rate 5']) {
    for(const field of ['list','mood','query']) {
      const f=fixture(), ix=pieces2(f.index2)[0].obj;
      ix.lists=[{id:'critic',label:field==='list'?text:'A critic list',popular:false,films:1}];
      ix.moods=[{id:'night',name:field==='mood'?text:'Night drive',label:'Nocturnal'}];
      ix.moodMenu=[{id:'night',label:field==='query'?text:'Nocturnal'}];
      const shard={v:1,builtAt:'2026-10-24T12:00:00Z',shard:'65',people:[],films:[record]};
      let fetches=0;
      const caches={default:{match:async key=>new Response(JSON.stringify(String(key).includes('store=index')?encode(ix):shard),{headers:{'x-fetched-at':String(Date.now())}}),put:async()=>{}}};
      const fetchImpl=async()=>{fetches++;throw Error('network forbidden')};
      const handle=createHandler({store:createStore({fetchImpl,caches,log:()=>{}}),pages:createPageSource({fetchImpl,caches})});
      const r=await handle(new Request('https://fixture.test/page/meta/movie/tt0057565.json'));
      assert.equal(r.status,503,field+': '+text); assert.equal(r.headers.get('Cache-Control'),'no-store');
      assert.doesNotMatch(await r.text(),/reviewer@|SYNTHETIC_PRIVATE_TOKEN|you rate/);assert.equal(fetches,0);
    }
  }
});

test('FP route, Fusion trials (29/10/2026): fusion-a says resources as strings, fusion-b adds a search-only catalog that answers empty; same page under each base; unknown variants and bare bases are 404', async () => {
  const h = harness();
  const a = await (await h.request('/page/fusion-a/manifest.json')).json();
  assert.equal(a.id, 'com.mgusmao.moodengine.page.fusion-a'); assert.deepEqual(a.resources, ['meta']); assert.deepEqual(a.catalogs, []); assert.deepEqual(a.types, ['movie']);
  const b = await (await h.request('/page/fusion-b/manifest.json')).json();
  assert.equal(b.id, 'com.mgusmao.moodengine.page.fusion-b'); assert.deepEqual(b.resources, ['meta', 'catalog']);
  assert.deepEqual(b.catalogs, [{ type: 'movie', id: 'page-search', name: 'Mood Engine · Film page', extra: [{ name: 'search', isRequired: true }] }]);
  const plain = await (await h.request('/page/manifest.json')).json(); assert.equal(plain.id, 'com.mgusmao.moodengine.page'); assert.deepEqual(plain.resources, [{ name: 'meta', types: ['movie'], idPrefixes: ['tt'] }]);
  assert.equal(h.calls.length, 0, 'manifests read no data');
  for (const base of ['/page/fusion-a', '/page/fusion-b']) {
    const r = await h.request(`${base}/meta/movie/tt0057565.json`); assert.equal(r.status, 200, base); const body = await r.json(); assert.equal(body.meta.id, record.t); assert.equal(body.meta.name, record.n);
  }
  const c = await h.request('/page/fusion-b/catalog/movie/page-search/search=anna.json'); assert.equal(c.status, 200); assert.deepEqual(await c.json(), { metas: [] });
  assert.equal((await h.request('/page/fusion-b/catalog/movie/page-search.json')).status, 200);
  for (const p of ['/page/fusion-a/catalog/movie/page-search/search=anna.json', '/page/fusion-c/manifest.json', '/page/fusion-a', '/page/fusion-a/', '/page/fusion-a/meta/series/tt1.json', '/page/fusion-ab/manifest.json']) {
    const f = harness(); assert.equal((await f.request(p)).status, 404, p); assert.deepEqual(f.calls, [], p);
  }
});

