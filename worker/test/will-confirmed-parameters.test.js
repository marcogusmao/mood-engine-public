// Decision of Marco, 21/10/2026 (lote 1, item 4): the numbers the session of 20/10/2026 had chosen for Will's intake are CONFIRMED: 20 tokens per 10 minutes per /64 (or IPv4 address) in the limiter in front of
// the Durable Object, and a queue of 12 pieces / 20,000,000 bytes of text for Will's files. They stay as named constants (RATE_LIMIT_CHARGES, RATE_WINDOW_MS in src/upload/limiter.js; WILL_PIECE_CACHE_MAX,
// WILL_PIECE_CACHE_BYTES in src/store.js), each is written in worker/README.md with the sentence "confirmed by Marco, 21/10/2026", and this file fixes them: changing a number is a red test here, and so is
// a code path that stops using the constant (the tests below run the DEFAULTS of the limiter and of the store with literal numbers, not the constants). Changing one is a decision of Marco's, not of a session:
// edit the number, the README sentence and this file together, with his answer dated (03:17 UTC, as told by the main session). Fake clock, fake fetch; nothing reads the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLimiter, RATE_LIMIT_CHARGES, RATE_WINDOW_MS } from '../src/upload/limiter.js';
import { createStore, WILL_PIECE_CACHE_MAX, WILL_PIECE_CACHE_BYTES } from '../src/store.js';
import { textOf, makeObject } from './fixture.js';

test('confirmed 21/10/2026: the limiter\'s constants are 20 tokens and 10 minutes', () => {
  assert.equal(RATE_LIMIT_CHARGES, 20);
  assert.equal(RATE_WINDOW_MS, 600000);
});

test('confirmed 21/10/2026: the limiter in its default form lets 20 unseen tokens of one /64 through, refuses the 21st with Retry-After 600, and opens at exactly 10 minutes', () => {
  let t = 5e9;
  const l = createLimiter({ now: () => t });
  for (let n = 0; n < 20; n++) l.admit('6:2001:db8:1:2', 'h' + n);
  const refused = at => { t = at; try { l.admit('6:2001:db8:1:2', 'late-' + at); return null; } catch (e) { return e; } };
  const first = refused(5e9);
  assert.equal(first?.status, 429);
  assert.equal(first.retryAfter, 600);
  assert.ok(refused(5e9 + 599999), 'still refused 1 ms before the 10 minutes');
  assert.equal(refused(5e9 + 600000), null, 'open at 10 minutes');
});

test('confirmed 21/10/2026: Will\'s queue constants are 12 pieces and 20,000,000 bytes', () => {
  assert.equal(WILL_PIECE_CACHE_MAX, 12);
  assert.equal(WILL_PIECE_CACHE_BYTES, 20000000);
});

const REV = 'r-' + '2'.repeat(32);
const willPiece = n => `https://pages.test/mood-engine/u/friend-a/r/${REV}/data/index-v2-row-${n}.json`;
function willStore(padBytes) {
  const o = makeObject(); o.meta.personId = 'friend-a'; o.meta.revision = REV; o.meta.pad = 'x'.repeat(padBytes);
  const text = textOf(o);
  return { text, store: createStore({ fetchImpl: async () => new Response(text), caches: { default: { match: async () => undefined, put: async () => {} } }, log() {} }) };
}

test('confirmed 21/10/2026: Will\'s queue in its default form keeps 12 pieces (the 13th lets the oldest go)', async () => {
  const { store } = willStore(0);
  for (let n = 1; n <= 12; n++) await store.get(willPiece(n));
  assert.equal(store._willLru.size, 12);
  await store.get(willPiece(13));
  assert.equal(store._willLru.size, 12);
  assert.ok(!store._willLru.has(willPiece(1)) && store._willLru.has(willPiece(13)));
});

test('confirmed 21/10/2026: Will\'s queue in its default form is bounded at 20,000,000 bytes of text: pieces of 4.0 MB keep 4 (a fifth passes 20,000,000), pieces of 3.6 MB keep 5 (a sixth passes it)', async () => {
  for (const [pad, kept] of [[4e6, 4], [3.6e6, 5]]) {
    const { text, store } = willStore(pad);
    const size = Buffer.byteLength(text);
    // the fixture itself: `kept` pieces fit under the ceiling and one more does not
    assert.ok(kept * size <= 20000000 && (kept + 1) * size > 20000000, `${kept} x ${size} fits and ${kept + 1} x ${size} does not`);
    for (let n = 1; n <= 8; n++) await store.get(willPiece(n));
    assert.equal(store._willLru.size, kept, `${kept} pieces of ${size} bytes`);
  }
});

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
test('confirmed 21/10/2026: worker/README.md writes the numbers with the sentence "confirmed by Marco, 21/10/2026" beside them', () => {
  assert.match(readme, /\*\*20 tokens per 10 minutes per \/64\*\* \(`RATE_LIMIT_CHARGES` = 20, `RATE_WINDOW_MS` = 600,000\): confirmed by Marco, 21\/10\/2026/);
  assert.match(readme, /\*\*12 pieces and 20,000,000 bytes of text\*\* \(`WILL_PIECE_CACHE_MAX` = 12, `WILL_PIECE_CACHE_BYTES` = 20,000,000\): confirmed by Marco, 21\/10\/2026/);
  assert.ok(!/20 tokens, 10 minutes, 60 s and 5 minutes are \*\*a choice of the session of 20\/10\/2026, pending/.test(readme), 'the two confirmed numbers are no longer listed as pending');
});

// Marco, 28/10/2026 (questionnaire): the three choices of the session of 21/10/2026 for the Rate Limiting binding are decided: 20 per 60 s stays, it fails open when it errs, and its key is the sha256 of the token (NOT the
// recommended /64; the accepted risk is in worker/README.md). Changing one is his decision: edit the number, the prose and this test together, with his answer dated. Signature (numbered as the assertions of the test below, from the top: 1 the toml's 20 per 60 s, 2 BINDING_PERIOD_S,
// 3 fail open, 4 the key): with the key back to the /64 (or the whole address, or the token in clear) the 4th is red; with a binding that fails closed the 3rd is (receipts: the RL: mutations of mutation.mjs). Fake object and fake binding; nothing reads the network.
const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
test('confirmed 28/10/2026: the binding is 20 per 60 s, fails open when it errs, and is keyed by the sha256 of the token', async () => {
  const { createUploadApi } = await import('../src/upload/api.js');
  const { digest } = await import('../src/upload/protocol.js');
  const { BINDING_PERIOD_S } = await import('../src/upload/limiter.js');
  assert.match(toml, /^simple = \{ limit = 20, period = 60 \}$/m);
  assert.equal(BINDING_PERIOD_S, 60);
  const ORIGIN = 'https://marcogusmao.github.io';
  const state = { idFromName: () => 'id', get: () => ({ fetch: async () => new Response(JSON.stringify({ schemaVersion: 1, personId: 'friend-a', error: { code: 'CREDENTIAL_INVALID', message: 'x', retryable: false } }), { status: 401, headers: { 'Content-Type': 'application/json' } }) }) };
  const env = binding => ({ WILL_UPLOAD_ENABLED: 'true', WILL_BROWSER_ORIGIN: ORIGIN, WILL_PAGES_BASE: 'https://marcogusmao.github.io/mood-engine', WILL_REPOSITORY_ID: '1413569629', WILL_REPOSITORY_OWNER_ID: '50679408', WILL_STATE: state, WILL_RATE_LIMIT: binding });
  const ask = (e, tok, ip) => createUploadApi({ now: () => 1e9, log() {} })(new Request('https://worker.test/api/v1/friend-a/status', { headers: { Authorization: 'Bearer ' + tok, Origin: ORIGIN, 'cf-connecting-ip': ip } }), e);
  const tok = 'A'.repeat(43);
  assert.equal((await ask(env({ limit: async () => { throw new Error('binding down'); } }), tok, '2001:db8:1:2::1')).status, 401, 'fails open: the object answers, not a 5xx or a 429');
  const keys = [];
  await ask(env({ limit: async ({ key }) => { keys.push(key); return { success: true }; } }), tok, '2001:db8:1:2::1');
  assert.deepEqual(keys, [await digest(tok)], 'the key is the sha256 of the token');
});
