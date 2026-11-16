// S1/S1b follow-up (20/10/2026, found while closing the final review): scripts/ack-will-publication.js, right after the deploy role's acknowledgement, reads GET /api/v1/friend-a/publication and
// the live addon's manifest and throws ACKED_PUBLIC_STATUS_MISMATCH / ACKED_LIVE_ADDON_MISMATCH unless both name the revision just acknowledged. With a 60 s copy of the pointer in the isolate that
// check would read the OLD revision whenever the isolate that answers had read the pointer in the last minute. So: the addon and the public route share ONE copy (index.js), and an accepted
// acknowledgement drops it in that isolate. Other isolates keep their 60 s (the script was not changed on 20/10/2026, when this was written; since 21/10/2026 it waits 60 s and needs 3 agreeing readings, test/will-ack-propagation.test.js). Fake object, fake fetch; nothing reads the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUploadApi, createActivePublication } from '../src/upload/api.js';
import { createHandler } from '../src/handler.js';
import { createStore } from '../src/store.js';
import { textOf, makeObject } from './fixture.js';

const rev = n => 'r-' + String(n).repeat(32);
const raw = r => { const o = makeObject(); o.meta.personId = 'friend-a'; o.meta.revision = r; return textOf(o); };
const ENABLED = { WILL_UPLOAD_ENABLED: 'true', WILL_BROWSER_ORIGIN: 'https://marcogusmao.github.io', WILL_PAGES_BASE: 'https://marcogusmao.github.io/mood-engine', WILL_REPOSITORY_ID: '1413569629', WILL_REPOSITORY_OWNER_ID: '50679408', INDEX_URL: 'https://pages.test/mood-engine/data/index.json' };
const json = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

function rig({ ackStatus = 200 } = {}) {
  const r = { reads: 0, acks: 0, clock: 1e9, active: rev(1), ackStatus };
  r.env = { ...ENABLED, WILL_STATE: { idFromName: () => 'id', get: () => ({ fetch: async request => {
    const op = JSON.parse(request.headers.get('X-Mood-Operation'));
    if (op.name === 'ack' || op.name === 'reconcile') { r.acks++; if (r.ackStatus === 200) r.active = op.p.revision; return json(r.ackStatus, r.ackStatus === 200 ? { schemaVersion: 1, personId: 'friend-a' } : { error: { code: 'STALE_PUBLICATION' } }); }
    r.reads++;
    return json(200, { schemaVersion: 1, personId: 'friend-a', state: 'ready', activePublication: { revision: r.active } });
  } }) } };
  r.cache = createActivePublication({ now: () => r.clock, log() {} });
  r.api = createUploadApi({ now: () => r.clock, publicationCache: r.cache, verifyOidc: async (_token, role) => ({ role }) });
  const store = createStore({ fetchImpl: async url => new Response(raw(url.includes(rev(2)) ? rev(2) : rev(1))), log() {} });
  r.handle = createHandler({ store, now: () => r.clock, publicationCache: r.cache });
  r.publicRoute = async () => (await r.api(new Request('https://worker.test/api/v1/friend-a/publication'), r.env)).json();
  r.manifest = () => r.handle(new Request('https://worker.test/u/friend-a/manifest.json'), r.env);
  r.ack = (revision, verb = 'ack') => r.api(new Request(`https://worker.test/api/internal/v1/friend-a/publications/${revision}/${verb}`, { method: 'POST', headers: { Authorization: 'Bearer aaa.bbb.ccc', 'Content-Type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, personId: 'friend-a', receiptSha256: 'a'.repeat(64) }) }), r.env);
  return r;
}

test('S1: the addon and GET /publication share one copy of the pointer: a manifest and a status call are one read of the object', async () => {
  const r = rig();
  assert.equal((await r.manifest()).headers.get('X-Mood-Revision'), rev(1));
  assert.equal((await r.publicRoute()).activePublication.revision, rev(1));
  assert.equal(r.reads, 1);
});

for (const verb of ['ack', 'reconcile']) { // the nightly's script reconciles (`acknowledge({ reconcile: true })`), the first activation acknowledges
  test(`S1: an accepted ${verb} drops the copy in this isolate: the status route and the addon name the new revision at once`, async () => {
    const r = rig();
    assert.equal((await r.manifest()).headers.get('X-Mood-Revision'), rev(1));
    assert.equal((await r.publicRoute()).activePublication.revision, rev(1));
    const ack = await r.ack(rev(2), verb);
    assert.equal(ack.status, 200);
    assert.equal(r.acks, 1);
    assert.equal((await r.publicRoute()).activePublication.revision, rev(2), 'the check scripts/ack-will-publication.js makes right after the acknowledgement');
    assert.equal((await r.manifest()).headers.get('X-Mood-Revision'), rev(2), 'and the live addon check');
    assert.equal(r.reads, 2);
  });
}

test('S1: a refused acknowledgement leaves the copy alone', async () => {
  const r = rig({ ackStatus: 409 });
  await r.publicRoute();
  const ack = await r.ack(rev(2));
  assert.equal(ack.status, 409);
  await r.publicRoute(); await r.manifest();
  assert.equal(r.reads, 1);
});

test('S1: a read that was in flight when the acknowledgement came is not kept (it may carry the old pointer)', async () => {
  let release, reads = 0, current = rev(1);
  const gate = new Promise(done => { release = done; });
  const cache = createActivePublication({ read: async () => { reads++; const seen = current; if (reads === 1) await gate; return { revision: seen }; }, enabled: () => true, log() {} });
  const first = cache({});
  current = rev(2);
  cache.invalidate();
  release();
  assert.equal((await first).revision, rev(1), 'the caller that was already waiting gets what it asked for');
  assert.equal((await cache({})).revision, rev(2), 'the next one asks again');
  assert.equal(reads, 2);
  assert.equal((await cache({})).revision, rev(2));
  assert.equal(reads, 2, 'and that read is kept');
});

test('S1: index.js builds ONE copy for the addon and the public route (a manifest and a status call through the entry point are one read of the object)', async () => {
  const entry = await import('../src/index.js');
  let reads = 0;
  const env = { ...ENABLED, WILL_STATE: { idFromName: () => 'id', get: () => ({ fetch: async () => { reads++; return json(200, { schemaVersion: 1, personId: 'friend-a', state: 'ready', activePublication: { revision: rev(1) } }); } }) } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => (String(url).includes('/u/friend-a/r/') ? new Response(raw(rev(1))) : new Response('missing', { status: 404 }));
  try {
    const manifest = await entry.default.fetch(new Request('https://worker.test/u/friend-a/manifest.json'), env, {});
    assert.equal(manifest.status, 200);
    const status = await entry.default.fetch(new Request('https://worker.test/api/v1/friend-a/publication'), env, {});
    assert.equal(status.status, 200);
    assert.equal((await status.json()).activePublication.revision, rev(1));
    assert.equal(reads, 1);
  } finally { globalThis.fetch = realFetch; }
});

// Review of ed9e3a0, 20/10/2026 (low 4): four mutations of the cache survived the four test files. These tests drive createActivePublication with reads that wait for a gate.
function gated() {
  const g = { reads: 0, logs: [], waiting: [], answers: [] };
  g.read = () => new Promise((resolve, reject) => { const n = ++g.reads; g.waiting.push({ n, resolve, reject }); });
  g.cache = createActivePublication({ read: g.read, enabled: () => true, log: o => g.logs.push(o), now: () => g.clock ?? 1e9 });
  g.settle = (n, how, value) => { const w = g.waiting.find(x => x.n === n); how === 'ok' ? w.resolve(value) : w.reject(value); };
  return g;
}
const flush = () => new Promise(done => setImmediate(done));

test('S1: a GET that comes after the acknowledgement while the OLD read is still in flight asks again and gets the NEW pointer (the case of scripts/ack-will-publication.js)', async () => {
  const g = gated();
  const old = g.cache({});
  await flush();
  g.cache.invalidate();
  const next = g.cache({});
  await flush();
  assert.equal(g.reads, 2, 'a second read started: the one in flight was not joined');
  g.settle(2, 'ok', { revision: rev(2) });
  g.settle(1, 'ok', { revision: rev(1) });
  assert.equal((await next).revision, rev(2));
  assert.equal((await old).revision, rev(1), 'whoever was already waiting gets what they asked for');
  assert.equal((await g.cache({})).revision, rev(2), 'and the kept copy is the new one, not the late old read');
  assert.equal(g.reads, 2);
});

test('S1: the old read that finishes after the new one started does not clear the new one: a third caller joins the new read (one read, not two)', async () => {
  const g = gated();
  const a = g.cache({});
  await flush();
  g.cache.invalidate();
  const b = g.cache({});
  await flush();
  g.settle(1, 'ok', { revision: rev(1) });
  await a; await flush();
  const c = g.cache({});
  await flush();
  assert.equal(g.reads, 2, 'C joined B\'s read in flight');
  g.settle(2, 'ok', { revision: rev(2) });
  assert.equal((await b).revision, rev(2));
  assert.equal((await c).revision, rev(2));
});

test('S1: a read that FAILS after the acknowledgement started a new one is logged, starts no 5 s wait and is not served from the old copy; the next call reads again', async () => {
  const g = gated();
  const first = g.cache({});
  await flush();
  g.settle(1, 'ok', { revision: rev(1) });
  await first;
  g.clock = 1e9 + 60e3;
  const doomed = g.cache({}); // the copy is a minute old: a read goes out
  await flush();
  g.cache.invalidate();
  g.settle(2, 'fail', new Error('object down'));
  await assert.rejects(doomed, /object down/);
  assert.equal(g.logs.length, 1, 'the failure is logged although it exits early');
  assert.equal(g.logs[0].message, 'will publication read failed, no previous pointer to serve');
  const next = g.cache({});
  await flush();
  assert.equal(g.reads, 3, 'no 5 s wait was started by the failed read');
  g.settle(3, 'ok', { revision: rev(2) });
  assert.equal((await next).revision, rev(2));
});

test('S1: an acknowledgement clears an earlier failure: the next call reads at once instead of throwing the old error for 5 s', async () => {
  const g = gated();
  const failing = g.cache({});
  await flush();
  g.settle(1, 'fail', new Error('first failure'));
  await assert.rejects(failing, /first failure/);
  const held = g.cache({});
  await assert.rejects(held, /first failure/); // inside the 5 s: the stored failure is thrown, no read
  assert.equal(g.reads, 1);
  g.cache.invalidate();
  const next = g.cache({});
  await flush();
  assert.equal(g.reads, 2, 'read again at once');
  g.settle(2, 'ok', { revision: rev(2) });
  assert.equal((await next).revision, rev(2));
});
