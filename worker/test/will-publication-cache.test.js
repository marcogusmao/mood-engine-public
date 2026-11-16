// S1 of the review of 8e37c23 (20/10/2026): every request to Will's addon asked the Durable Object for the active publication (handler.js `publication(env)` -> upload/api.js
// activePublication -> stateStub(env).fetch, nothing kept): opening the Board is 54+ of them, unauthenticated callers included. Now the answer lives 60 s in the isolate.
// Signature: before 20/10/2026 N requests to /u/friend-a/... were N reads of the Durable Object. The tests plant a fake WILL_STATE and a fake fetch; nothing reads the network or a live cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createHandler } from '../src/handler.js';
import { createActivePublication, activePublication, PUBLICATION_TTL_MS, PUBLICATION_STALE_MS, PUBLICATION_RETRY_MS } from '../src/upload/api.js';
import { textOf, makeObject } from './fixture.js';

const rev = n => 'r-' + String(n).repeat(32);
const raw = r => { const o = makeObject(); o.meta.personId = 'friend-a'; o.meta.revision = r; return textOf(o); };
const ENABLED = { WILL_UPLOAD_ENABLED: 'true', WILL_BROWSER_ORIGIN: 'https://marcogusmao.github.io', WILL_PAGES_BASE: 'https://marcogusmao.github.io/mood-engine', WILL_REPOSITORY_ID: '1413569629', WILL_REPOSITORY_OWNER_ID: '50679408' };

/** An env whose Durable Object counts the reads of the publication pointer; `script` decides each answer. */
function rig(script) {
  const r = { reads: 0, clock: 1e9, script, logs: [] };
  r.env = { ...ENABLED, INDEX_URL: 'https://pages.test/mood-engine/data/index.json', WILL_STATE: { idFromName: () => 'id', get: () => ({ fetch: async () => { r.reads++; return r.script(r.reads); } }) } };
  const store = createStore({ fetchImpl: async u => new Response(raw(rev(1))), log() {} });
  r.handle = createHandler({ store, now: () => r.clock, log: o => r.logs.push(o) });
  r.ask = (path, init) => r.handle(new Request('https://worker.test' + path, init), r.env);
  return r;
}
const pointer = (revision = rev(1)) => () => Response.json({ personId: 'friend-a', activePublication: { revision } });

test('S1: N requests in a row to the manifest and the catalogs are one read of the Durable Object; 60 s later, another', async () => {
  const r = rig(pointer());
  for (let n = 0; n < 10; n++) assert.equal((await r.ask('/u/friend-a/manifest.json')).status, 200);
  for (const id of ['tonight', 'explore', 'moods']) assert.equal((await r.ask(`/u/friend-a/catalog/movie/${id}.json`)).status, 200, id);
  assert.equal(r.reads, 1, 'one read for 13 requests');
  r.clock += PUBLICATION_TTL_MS - 1;
  await r.ask('/u/friend-a/manifest.json');
  assert.equal(r.reads, 1, 'still the same minute');
  r.clock += 1;
  await r.ask('/u/friend-a/manifest.json');
  assert.equal(r.reads, 2, 'after 60 s simulated, a new read');
});

test('S1: the 54+ requests of one Board opening, asked together on a cold isolate, are one read', async () => {
  const r = rig(pointer());
  const answers = await Promise.all(Array.from({ length: 60 }, (_, n) => r.ask(n % 2 ? '/u/friend-a/manifest.json' : '/u/friend-a/catalog/movie/tonight.json')));
  assert.ok(answers.every(a => a.status === 200));
  assert.equal(r.reads, 1);
});

test('S1: a new publication reaches the isolate within 60 s, and an old one is not served after that', async () => {
  let active = rev(1);
  const r = rig(() => Response.json({ personId: 'friend-a', activePublication: { revision: active } }));
  assert.equal((await r.ask('/u/friend-a/manifest.json')).headers.get('X-Mood-Revision'), rev(1));
  active = rev(2);
  assert.equal((await r.ask('/u/friend-a/manifest.json')).headers.get('X-Mood-Revision'), rev(1), 'inside the minute the earlier pointer stands (the price of the cache)');
  r.clock += PUBLICATION_TTL_MS;
  assert.equal((await r.ask('/u/friend-a/manifest.json')).headers.get('X-Mood-Revision'), rev(2));
});

test('S1: "no publication yet" is kept 60 s too (503 not ready), and the next minute sees the first publication', async () => {
  let ready = false;
  const r = rig(() => Response.json({ personId: 'friend-a', activePublication: ready ? { revision: rev(1) } : null }));
  assert.equal((await r.ask('/u/friend-a/manifest.json')).status, 503);
  ready = true;
  assert.equal((await r.ask('/u/friend-a/manifest.json')).status, 503);
  assert.equal(r.reads, 1);
  r.clock += PUBLICATION_TTL_MS;
  assert.equal((await r.ask('/u/friend-a/manifest.json')).status, 200);
});

test('S1: a failed read is not kept as "no publication": with an earlier one it keeps serving it, asks again after 5 s, and recovers', async () => {
  let fail = false;
  const r = rig(() => fail ? new Response('boom', { status: 500 }) : Response.json({ personId: 'friend-a', activePublication: { revision: rev(1) } }));
  assert.equal((await r.ask('/u/friend-a/manifest.json')).status, 200);
  fail = true;
  r.clock += PUBLICATION_TTL_MS;
  for (let n = 0; n < 5; n++) { const a = await r.ask('/u/friend-a/manifest.json'); assert.equal(a.status, 200, 'the earlier publication keeps serving'); assert.equal(a.headers.get('X-Mood-Revision'), rev(1)); }
  assert.equal(r.reads, 2, 'one failed read, not one per request');
  r.clock += PUBLICATION_RETRY_MS;
  await r.ask('/u/friend-a/manifest.json');
  assert.equal(r.reads, 3, 'asked again after 5 s');
  fail = false;
  r.clock += PUBLICATION_RETRY_MS;
  assert.equal((await r.ask('/u/friend-a/manifest.json')).status, 200);
  assert.equal(r.reads, 4);
  fail = true;
  r.clock += PUBLICATION_TTL_MS; await r.ask('/u/friend-a/manifest.json'); // fails, serves the old one
  r.clock += PUBLICATION_STALE_MS;
  assert.equal((await r.ask('/u/friend-a/manifest.json')).status, 503, 'an earlier publication older than 10 minutes is no longer served');
});

test('S1: a failed read with nothing earlier is a 503, retried after 5 s (not hammered, not stuck for 60 s)', async () => {
  let fail = true;
  const r = rig(() => fail ? new Response('boom', { status: 500 }) : Response.json({ personId: 'friend-a', activePublication: { revision: rev(1) } }));
  for (let n = 0; n < 5; n++) assert.equal((await r.ask('/u/friend-a/manifest.json')).status, 503);
  assert.equal(r.reads, 1);
  fail = false;
  r.clock += PUBLICATION_RETRY_MS;
  assert.equal((await r.ask('/u/friend-a/manifest.json')).status, 200, 'recovers 5 s after the failure, not 60 s');
  assert.equal(r.reads, 2);
  // a thrown error from the stub is a failure too
  const t = rig(() => { throw new Error('stub down'); });
  assert.equal((await t.ask('/u/friend-a/manifest.json')).status, 503);
});

test('S1: with the flag off nothing is cached or read: the same 503 as before, the Durable Object never touched, even with a warm cache', async () => {
  const r = rig(pointer());
  const off = { ...r.env, WILL_UPLOAD_ENABLED: 'false' };
  for (let n = 0; n < 3; n++) assert.equal((await r.handle(new Request('https://worker.test/u/friend-a/manifest.json'), off)).status, 503);
  assert.equal(r.reads, 0);
  assert.equal((await r.ask('/u/friend-a/manifest.json')).status, 200);
  assert.equal(r.reads, 1);
  assert.equal((await r.handle(new Request('https://worker.test/u/friend-a/manifest.json'), off)).status, 503, 'a warm cache does not answer for a disabled intake');
  assert.equal(r.reads, 1);
});

test('S1: the cache is per createActivePublication (per isolate): the raw read is still one DO call per call', async () => {
  const r = rig(pointer());
  assert.deepEqual(await activePublication(r.env), { revision: rev(1) });
  assert.deepEqual(await activePublication(r.env), { revision: rev(1) });
  assert.equal(r.reads, 2);
  const cached = createActivePublication({ now: () => r.clock });
  await cached(r.env); await cached(r.env);
  assert.equal(r.reads, 3);
});

// 20/10/2026 (final review, low item 1): serving the earlier pointer when the object fails was silent. One log line per failed read, with the error code and nothing of the request.
test('S1: a failed read is logged once per attempt: the code of the error and whether an earlier pointer is served, nothing of the caller', async () => {
  let fail = false;
  const r = rig(() => fail ? new Response('boom', { status: 500 }) : Response.json({ personId: 'friend-a', activePublication: { revision: rev(1) } }));
  await r.ask('/u/friend-a/manifest.json');
  assert.deepEqual(r.logs, []);
  fail = true;
  r.clock += PUBLICATION_TTL_MS;
  for (let n = 0; n < 5; n++) await r.ask('/u/friend-a/manifest.json', { headers: { Authorization: 'Bearer secret-token-value', 'cf-connecting-ip': '203.0.113.9' } });
  assert.equal(r.logs.length, 1, 'one failed read, one line (the other four requests did not read)');
  assert.deepEqual(r.logs[0], { event: 'will-publication-read-failed', message: 'will publication read failed, serving previous pointer', code: 'PUBLICATION_UNAVAILABLE' });
  r.clock += PUBLICATION_STALE_MS;
  assert.equal((await r.ask('/u/friend-a/manifest.json')).status, 503);
  assert.equal(r.logs.length, 2);
  assert.equal(r.logs[1].message, 'will publication read failed, no previous pointer to serve');
  const text = JSON.stringify(r.logs);
  assert.ok(!/secret-token-value|203\.0\.113\.9|Bearer|requestId/.test(text));
  const t = rig(() => { throw new Error('stub says token abc'); });
  await t.ask('/u/friend-a/manifest.json');
  assert.deepEqual(t.logs, [{ event: 'will-publication-read-failed', message: 'will publication read failed, no previous pointer to serve', code: 'READ_ERROR' }], 'a thrown error is a code, never its text');
});
