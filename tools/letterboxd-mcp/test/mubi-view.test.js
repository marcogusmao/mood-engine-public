'use strict';
if (!require('./gate').run(__filename)) return;
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const M = require('./mubi-fixture');
const { createState } = require('../src/state');
const { createAdapter, InputError } = require('../src/adapter');
after(H.cleanup);
const ID = 'tt0000007';
const fields = ['ourTake', 'mubiSynopsis', 'mubiRating'];
function setup(over = {}) {
  const root = H.copyFixture();
  M.writeCache(root, { [ID]: M.confirmed('invented', over) });
  const state = createState(root, {});
  state.current.root = root; // explicit state for independent adapter reconstruction
  return { root, state };
}
const args = (queries = [ID], maxChars = 2000) => ({ queries, view: 'mubi', maxChars });
function collect(adapter, input) {
  let cursor, offset = 0;
  const all = [];
  do {
    const out = adapter.call('film_dossier', { ...input, ...(cursor ? { cursor } : {}) });
    assert.ok(JSON.stringify(out).length <= input.maxChars);
    assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
    assert.equal(out.page.offset, offset);
    assert.equal(out.page.total, input.queries.length);
    assert.equal(out.page.shown, out.results.length);
    assert.equal(out.page.remaining, input.queries.length - offset - out.results.length);
    assert.ok(out.page.shown > 0);
    all.push(...out.results); offset += out.page.shown; cursor = out.page.nextCursor;
  } while (cursor);
  return all;
}
test('mubi view preserves the legacy default and full response exactly', () => {
  const { state } = setup();
  const a = state.current.adapter;
  assert.deepEqual(a.call('film_dossier', { queries: [ID, 'Suspiria', 'missing'] }), a.call('film_dossier', { queries: [ID, 'Suspiria', 'missing'], view: 'full' }));
  const compact = a.call('film_dossier', args());
  assert.equal(compact.view, 'mubi');
  assert.deepEqual(Object.keys(compact.results[0].film), ['id', 'title', 'year']);
  assert.deepEqual(Object.keys(compact), ['source', 'view', 'mubiNotes', 'results', 'page']);
  assert.equal(compact.page.maxChars, 2000);
  assert.equal(a.call('film_dossier', { queries: [ID], view: 'mubi' }).page.maxChars, 20000);
  assert.ok(!('synopsis' in compact.results[0]));
});
test('mubi view reconstruction preserves available absent unknown stale zero and zero-vote fields', async () => {
  for (const over of [{}, { ourTake: { state: 'absent' }, synopsis: { state: 'absent' }, rating: { state: 'absent' } },
    { ourTake: { state: 'unknown', reason: 'not-captured' }, rating: { state: 'unknown', reason: 'invalid' } },
    { stale: true, lastError: { at: M.CAPTURED, reason: 'http-429' } },
    { rating: { state: 'available', outOfTen: 0, average: 0, votes: 12 } },
    { rating: { state: 'available', outOfTen: 8, average: 4, votes: 0 } },
    { ourTake: { state: 'unknown', reason: 'not-captured' }, synopsis: { state: 'unknown', reason: 'invalid' }, rating: { state: 'unknown', reason: 'inconsistent' }, stale: true, lastError: { at: M.CAPTURED, reason: 'http-429' } }]) {
    const { state, root } = setup(over);
    const legacy = state.current.adapter.call('film_dossier', { queries: [ID] }).results[0];
    const compact = state.current.adapter.call('film_dossier', args()).results[0];
    for (const key of fields) assert.deepEqual({ ...compact.mubi.provenance, ...compact.mubi[key] }, legacy[key], key);
    const server = await H.connect({ root });
    const onWire = await server.client.callTool({ name: 'film_dossier', arguments: args() });
    assert.ok(!onWire.isError, onWire.content[0].text);
    assert.deepEqual(JSON.parse(onWire.content[0].text), onWire.structuredContent);
    for (const key of fields) assert.deepEqual({ ...onWire.structuredContent.results[0].mubi.provenance, ...onWire.structuredContent.results[0].mubi[key] }, legacy[key], key);
    assert.deepEqual(onWire.structuredContent.results[0].synopsis, compact.synopsis);
    await server.close();
    for (const key of ['source', 'url', 'capturedAt']) {
      const common = fields.every((f) => Object.hasOwn(legacy[f], key) && legacy[f][key] === legacy.ourTake[key]);
      assert.equal(Object.hasOwn(compact.mubi.provenance, key), common);
    }
    assert.equal('synopsis' in compact, legacy.ourTake.state !== 'available' && legacy.mubiSynopsis.state !== 'available');
    if ('synopsis' in compact) assert.deepEqual(compact.synopsis, legacy.synopsis);
  }
});
test('mubi view missing and ambiguous queries preserve candidates and query order', () => {
  const { state } = setup();
  const queries = ['no such film 1900', 'Suspiria', ID, ID];
  const compact = collect(state.current.adapter, args(queries, 4000));
  const legacy = state.current.adapter.call('film_dossier', { queries }).results;
  assert.deepEqual(compact[0], { query: queries[0], found: false });
  assert.deepEqual(compact[1], legacy[1]);
  assert.deepEqual(compact.map((x) => x.query), queries);
});
test('mubi view 50 queries paginate maximal whole prefixes without losses and use final scrubbed UTF-16 JSON length', () => {
  const { state, root } = setup({ ourTake: { state: 'available', text: `😀 "quote" ${'x'.repeat(350)}` } });
  const input = args(Array.from({ length: 50 }, (_, i) => i % 5 ? ID : 'no such film'), 3000);
  const a = state.current.adapter;
  const all = collect(a, input);
  assert.deepEqual(all.map((x) => x.query), input.queries);
  const first = a.call('film_dossier', input);
  const next = a.call('film_dossier', { ...input, cursor: first.page.nextCursor });
  // The next whole item cannot be appended, even allowing a final-page null cursor.
  const extended = { ...first, results: [...first.results, next.results[0]], page: { ...first.page, shown: first.page.shown + 1, remaining: first.page.remaining - 1 } };
  assert.ok(JSON.stringify(extended).length > input.maxChars);
  const changed = { ...state.current, builtAt: 'another-process', index: structuredClone(state.current.index) };
  const f = changed.index.films.find((f) => f.id === ID);
  f.title = `${root} 😀 "title"`;
  const scrubbed = createAdapter(changed).call('film_dossier', args([ID], 3000));
  assert.ok(scrubbed.results[0].film.title.includes('<root>'));
  assert.ok(JSON.stringify(scrubbed).length <= 3000);
});
test('mubi cursor binds source ordered queries view and budget, validates exact canonical structure, resumes across adapters', () => {
  const { state } = setup();
  const a = state.current.adapter;
  const input = args(Array(50).fill(ID));
  const first = a.call('film_dossier', input), cursor = first.page.nextCursor;
  assert.ok(cursor);
  const payload = JSON.parse(Buffer.from(cursor, 'base64url'));
  assert.ok(!JSON.stringify(payload).includes(ID));
  const resumed = createAdapter({ ...state.current, builtAt: 'new-process' }).call('film_dossier', { ...input, cursor });
  assert.equal(resumed.page.offset, first.page.shown);
  const reject = (adapter, call) => assert.throws(() => adapter.call('film_dossier', call), (e) => e instanceof InputError && /restart|reiniciar/.test(e.message) && !e.message.includes(cursor));
  reject(createAdapter({ ...state.current, signature: 'different-source' }), { ...input, cursor });
  reject(a, { ...input, maxChars: 3000, cursor });
  reject(a, { ...input, queries: [...input.queries.slice(1), 'missing'], cursor });
  const orderInput = args([ID, 'missing', ...Array(48).fill(ID)]);
  const orderCursor = a.call('film_dossier', orderInput).page.nextCursor;
  reject(a, { ...orderInput, queries: ['missing', ID, ...Array(48).fill(ID)], cursor: orderCursor });
  reject(a, { ...input, view: 'full', cursor });
  for (const p of [{ ...payload, version: 2 }, { ...payload, offset: 0 }, { ...payload, offset: -1 }, { ...payload, offset: 50 }, { ...payload, offset: 1.5 }, { ...payload, extra: 1 }, { ...payload, hash: 'bad' }, { ...payload, hash: '0'.repeat(64) }, { ...payload, signature: 42 }]) {
    reject(a, { ...input, cursor: Buffer.from(JSON.stringify(p)).toString('base64url') });
  }
  for (const bad of [cursor + '=', '*', Buffer.from('null').toString('base64url'), '',
    Buffer.from(' ' + JSON.stringify(payload)).toString('base64url'),
    Buffer.from(JSON.stringify(payload).replace('{', '{\"version\":1,')).toString('base64url')]) reject(a, { ...input, cursor: bad });
});
test('mubi view refuses pagination options on full, invalid limits and a single oversized whole result explicitly', () => {
  const { state } = setup();
  const a = state.current.adapter;
  for (const call of [{ queries: [ID], maxChars: 2000 }, { queries: [ID], cursor: 'abc' }, { ...args(), maxChars: 1999 }, { ...args(), maxChars: 30001 }, { ...args(), maxChars: 2000.5 }, { ...args(), cursor: 'x'.repeat(1025) }]) assert.throws(() => a.call('film_dossier', call), InputError);
  // A large homonym result must remain whole rather than choosing or clipping candidates.
  const index = structuredClone(state.current.index);
  const base = index.films.find((f) => f.id === ID);
  index.films.push(...Array.from({ length: 100 }, (_, i) => ({ ...base, id: `tt9000${i}`, title: 'Huge homonym' })));
  index.films.find((f) => f.id === ID).title = 'Huge homonym';
  assert.throws(() => createAdapter({ ...state.current, index }).call('film_dossier', args(['Huge homonym'])), (e) => e instanceof InputError && /position 0/.test(e.message) && /2000/.test(e.message) && /minimum/.test(e.message) && /30000/.test(e.message) && /exact ID/.test(e.message));
});
test('mubi view bypasses publicFilm and relatedSeen computation', () => {
  const { state } = setup();
  const index = structuredClone(state.current.index);
  const film = index.films.find((f) => f.id === ID);
  Object.defineProperty(film, 'keywords', { get() { throw new Error('publicFilm accessed'); } });
  const Qy = require('../../films/query'), previous = Qy.relatedSeen;
  Qy.relatedSeen = () => { throw new Error('relatedSeen accessed'); };
  try { assert.equal(createAdapter({ ...state.current, index }).call('film_dossier', args()).results[0].film.id, ID); }
  finally { Qy.relatedSeen = previous; }
});
test('mubi view official MCP client has equivalent text and structuredContent, paginates and refuses altered source', async () => {
  const { root } = setup();
  const input = args(Array(50).fill(ID), 3000);
  const s = await H.connect({ root });
  let cursor, all = [];
  do {
    const r = await s.client.callTool({ name: 'film_dossier', arguments: { ...input, ...(cursor ? { cursor } : {}) } });
    assert.ok(!r.isError, r.content[0].text);
    assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
    assert.ok(r.content[0].text.length <= input.maxChars);
    all.push(...r.structuredContent.results); cursor = r.structuredContent.page.nextCursor;
  } while (cursor);
  assert.equal(all.length, 50);
  const first = await s.client.callTool({ name: 'film_dossier', arguments: input });
  const c = first.structuredContent.page.nextCursor;
  const t = await H.connect({ root });
  const resumed = await t.client.callTool({ name: 'film_dossier', arguments: { ...input, cursor: c } });
  assert.equal(resumed.structuredContent.page.offset, first.structuredContent.page.shown);
  M.bump(M.fileIn(root));
  const refused = await s.client.callTool({ name: 'film_dossier', arguments: { ...input, cursor: c } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /restart/);
  await t.close(); await s.close();
});

test('mubi pagination measures after scrub even when replacement expands strings and selects the greatest fitting prefix', () => {
  const { state } = setup({ ourTake: { state: 'available', text: `${'/tmp '.repeat(95)}😀 "quote"` } });
  const a = createAdapter({ ...state.current, root: '/tmp' });
  const queries = Array(50).fill(ID), input = args(queries, 2500);
  const all = collect(a, input);
  let cursor, offset = 0;
  do {
    const out = a.call('film_dossier', { ...input, ...(cursor ? { cursor } : {}) });
    assert.ok(out.results[0].mubi.ourTake.text.includes('<root>'));
    assert.ok(!out.results[0].mubi.ourTake.text.includes('/tmp'));
    const payload = JSON.parse(Buffer.from(out.page.nextCursor || cursor, 'base64url'));
    let greatest = 0;
    for (let n = 1; n <= queries.length - offset; n++) {
      const next = offset + n === queries.length ? null : Buffer.from(JSON.stringify({ ...payload, offset: offset + n })).toString('base64url');
      const hypothetical = { ...out, results: all.slice(offset, offset + n), page: { ...out.page, shown: n, remaining: queries.length - offset - n, nextCursor: next } };
      if (JSON.stringify(hypothetical).length <= 2500) greatest = n;
    }
    assert.equal(out.page.shown, greatest);
    offset += out.page.shown; cursor = out.page.nextCursor;
    // Last-page null does not carry a payload; the independent prefix check above runs for all prior pages.
    if (cursor === null) break;
  } while (offset < queries.length);
});
