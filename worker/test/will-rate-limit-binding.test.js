// Decision of Marco, 21/10/2026 (lote 1, item 4): before Will's intake is turned on, a limit that holds across isolates. Until now the limit of the intake was a table in the memory of each isolate
// (src/upload/limiter.js), so two isolates were two limits: the table said so in its own README ("a limit that holds for all of them needs a Rate Limiting binding"). Now api.js asks the binding
// WILL_RATE_LIMIT (wrangler.toml, `[[ratelimits]]`) with the sha256 of the caller's token as the key (Marco, 28/10/2026: it was the /64 from 21/10/2026 to then; see the tests 'binding: it is asked with the key of the token' and 'binding: the key is the token, not the address'), for the requests whose token the isolate has not seen accepted, before the Durable Object; the table stays as the first
// layer and as the only one where the binding does not exist (the node tests and the generated config of test/upload-fixtures/runtime.mjs; `wrangler dev --local` with wrangler.toml gets a simulated binding, measured 21/10/2026). Signature: before this change `env.WILL_RATE_LIMIT` was never read, so every test here that
// has a binding refuse or count something fails, and the one with two isolates lets 40 requests reach the object instead of 20. Fake object, fake binding, clock; nothing reads the network. The real binding
// is NOT measured here (BACKLOG.md, 21/10/2026: it needs the Cloudflare account).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createUploadApi } from '../src/upload/api.js';
import { digest } from '../src/upload/protocol.js';
import { RATE_LIMIT_CHARGES, BINDING_NAME, BINDING_PERIOD_S, LAYER_LOG_FLOOR_MS, GLOBAL_BINDING_NAME, GLOBAL_BINDING_KEY } from '../src/upload/limiter.js';

const ORIGIN = 'https://marcogusmao.github.io';
const BASE = { WILL_UPLOAD_ENABLED: 'true', WILL_BROWSER_ORIGIN: ORIGIN, WILL_PAGES_BASE: 'https://marcogusmao.github.io/mood-engine', WILL_REPOSITORY_ID: '1413569629', WILL_REPOSITORY_OWNER_ID: '50679408' };
const token = () => randomBytes(32).toString('base64url');
const body = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
const refusal = (status, code) => body(status, { schemaVersion: 1, personId: 'friend-a', error: { code, message: 'The request could not be completed.', retryable: false } });

/** A fake Rate Limiting binding: records every key it is asked about and answers `decide(key, nth)`. */
function fakeBinding(decide = () => true) {
  const b = { keys: [], limit: async ({ key }) => { b.keys.push(key); return { success: await decide(key, b.keys.length) }; } };
  return b;
}
/** A fake binding that behaves like Cloudflare's: `limit` calls per key per `period` seconds, ONE counter for every isolate that holds it (the clock is the rig's). */
function countingBinding(clock, limit = 20, period = 60) {
  const seen = new Map();
  const b = { keys: [], limit: async ({ key }) => {
    b.keys.push(key);
    const t = clock(), row = seen.get(key);
    if (!row || t - row.start >= period * 1000) { seen.set(key, { start: t, n: 1 }); return { success: true }; }
    row.n++;
    return { success: row.n <= limit };
  } };
  return b;
}

/** A rig whose object knows `valid` (a Set of sha256) and counts every call. `isolate()` makes another API (its own table in memory) over the same object and the same env. */
function rig(binding) {
  const r = { calls: 0, clock: 1e9, valid: new Set(), logs: [] };
  r.env = { ...BASE, ...(binding ? { WILL_RATE_LIMIT: binding } : {}), WILL_STATE: { idFromName: () => 'id', get: () => ({ fetch: async request => {
    r.calls++;
    if (r.slow) await new Promise(done => setTimeout(done, 20)); // the answers come back after every request of a burst was admitted
    if (r.mode === 'throw') throw new Error('object down');
    const op = JSON.parse(request.headers.get('X-Mood-Operation'));
    if (op.actor.role === 'public') return body(200, { schemaVersion: 1, personId: 'friend-a', activePublication: null });
    return r.valid.has(op.actor.hash) ? body(200, { schemaVersion: 1, personId: 'friend-a', state: 'ok' }) : refusal(401, 'CREDENTIAL_INVALID');
  } }) } };
  r.isolate = () => { const api = createUploadApi({ now: () => r.clock, log: o => r.logs.push(o) }); api.status = (tok, ip = '203.0.113.7') => api(new Request('https://worker.test/api/v1/friend-a/status', { headers: { Authorization: 'Bearer ' + tok, Origin: ORIGIN, ...(ip ? { 'cf-connecting-ip': ip } : {}) } }), r.env); return api; };
  r.api = r.isolate();
  r.status = (tok, ip) => r.api.status(tok, ip);
  r.good = async () => { const t = token(); r.valid.add(await digest(t)); return t; };
  return r;
}

test('binding: it is the first layer: a binding that refuses everything stops the request with 429 RATE_LIMITED and Retry-After = its period, and the object is never asked', async () => {
  const b = fakeBinding(() => false), r = rig(b);
  const a = await r.status(await r.good());
  assert.equal(a.status, 429);
  assert.equal((await a.json()).error.code, 'RATE_LIMITED');
  assert.equal(a.headers.get('Retry-After'), String(BINDING_PERIOD_S));
  assert.equal(a.headers.get('Access-Control-Expose-Headers'), 'Retry-After', 'the browser origin can read how long to wait');
  assert.equal(r.calls, 0);
  assert.equal(b.keys.length, 1);
  assert.deepEqual(r.api.refusals, { memory: 0, binding: 1, 'binding-error': 0, 'binding-global': 0, 'binding-global-error': 0 });
});

test('binding: a refusal by the binding does not take a charge of the table, and is not remembered as a refused token', async () => {
  let open = false;
  const b = fakeBinding(() => open), r = rig(b);
  const mine = await r.good();
  for (let n = 0; n < 3 * RATE_LIMIT_CHARGES; n++) assert.equal((await r.status(token())).status, 429); // 60 requests refused by the binding: the table would have stopped at 20 if it had been charged
  assert.equal((await r.status(mine)).status, 429);
  assert.equal(r.calls, 0);
  open = true;
  const answers = [];
  for (let n = 0; n < RATE_LIMIT_CHARGES + 5; n++) answers.push((await r.status(n === 0 ? mine : token())).status);
  assert.equal(answers[0], 200, 'the valid token that the binding refused works as soon as the binding lets it through (no 60 s refusal memory; and its charge was not kept: the table would have said 429)');
  assert.equal(r.calls, 1 + RATE_LIMIT_CHARGES, 'the valid token (its charge is given back once the object knew it) and then the table\'s own 20: the 61 binding refusals did not spend any charge');
  assert.equal(answers.filter(s => s === 429).length, 4);
});

// Decision of Marco, 28/10/2026 (questionnaire; not the recommended option, the risk written beside it): the key of the binding is the token's sha256, not the /64. Signature: before this change api.js passed the /64 prefix
// (`bindingAllows(env.WILL_RATE_LIMIT, prefix64)`), so every key below was '6:2001:db8:1:2' or an IPv4 address and the assertions on `digest(token)` failed; with the token in clear the `includes(tok)` assertions fail.
test('binding: it is asked with the key of the token: the sha256 of the bearer, never the token in clear and never any part of the address', async () => {
  const b = fakeBinding(), r = rig(b);
  const a = token(), c = token();
  await r.status(a, '2001:db8:1:2:aaaa::1');
  await r.status(c, '203.0.113.7');
  assert.deepEqual(b.keys, [await digest(a), await digest(c)]);
  assert.ok(b.keys.every(k => /^[0-9a-f]{64}$/.test(k)), 'a sha256 in lower-case hex');
  // a hex digest cannot hold ':' or '.', which every spelling of an address does (a substring such as 'db8' could appear in a hash by chance, 1 in 70, so it is not asserted)
  for (const k of b.keys) { assert.ok(!k.includes(a) && !k.includes(c), 'not the token in clear'); assert.ok(!/[:.]/.test(k), 'no part of an IPv6 or IPv4 address'); }
});

test('binding: the key is the token, not the address: two addresses with one token share one key, two tokens behind one address have two', async () => {
  const b = fakeBinding(), r = rig(b);
  const one = await r.good(), two = await r.good();
  // one token seen from two addresses (two isolates, so that each has to ask): the same key, whatever the prefix
  await r.isolate().status(one, '2001:db8:1:2::1');
  await r.isolate().status(one, '2001:db8:9:9::1');
  await r.isolate().status(one, '198.51.100.9');
  assert.equal(new Set(b.keys).size, 1, 'three addresses, one token: one key');
  assert.equal(b.keys[0], await digest(one));
  // two tokens from one address: two keys
  const before = b.keys.length;
  await r.status(two, '203.0.113.50');
  await r.status(token(), '203.0.113.50');
  assert.equal(new Set(b.keys.slice(before)).size, 2, 'one address, two tokens: two keys');
  assert.equal(b.keys[before], await digest(two));
});

test('binding: keyed by the token, the count of ONE token is shared by the isolates (a ceiling on that token across them), whatever the address', async () => {
  const r = rig();
  r.env.WILL_RATE_LIMIT = countingBinding(() => r.clock, 1); // 1 per period per key, to see it
  const mine = await r.good();
  const first = await r.isolate().status(mine, '2001:db8:1:2::1');
  assert.equal(first.status, 200);
  const second = await r.isolate().status(mine, '198.51.100.9'); // another isolate, another address, the same token: the second ask of the key in the period
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, 'RATE_LIMITED');
  assert.equal(second.headers.get('Retry-After'), String(BINDING_PERIOD_S));
  r.clock += BINDING_PERIOD_S * 1000;
  assert.equal((await r.isolate().status(mine, '198.51.100.9')).status, 200, 'a period later the token is let through again');
});

// The risk Marco accepted on 28/10/2026, pinned so that nobody reads more into the binding than it does: a caller that changes token on every request is NEVER refused by the binding (each key is new, here
// even with a binding that allows ONE call per key); the per-/64 table of each isolate is what holds it. Signature: with the /64 as the key, the same 60 requests were refused by the binding from the 2nd on.
test('binding: accepted risk, pinned: 60 different tokens from one /64 over two isolates are never refused by the binding; each isolate\'s table stops its own at 20', async () => {
  const r = rig();
  const b = countingBinding(() => r.clock, 1);
  r.env.WILL_RATE_LIMIT = b;
  const two = [r.api, r.isolate()];
  const codes = [];
  for (let n = 0; n < 60; n++) codes.push((await two[n % 2].status(token(), '2001:db8:1:2::1')).status);
  assert.equal(two[0].refusals.binding + two[1].refusals.binding, 0, 'the binding refused nobody: every key was new');
  assert.equal(new Set(b.keys).size, 40, 'it was asked 40 times, with 40 different keys (the tables charged 20 per isolate)');
  assert.equal(r.calls, 40, 'the object saw 40: 20 per isolate, the tables\' own limit; the address alone does not bind across isolates any more');
  assert.equal(codes.filter(c => c === 429).length, 20);
  assert.equal(two[0].refusals.memory + two[1].refusals.memory, 20);
});

// Review of 28/10/2026 (independent, measured with a fake object and a fake binding): WHEN a token is asked of the binding once the key is the token. The first reading of the author, "once per token per isolate per 5
// minutes", held only for a token the object ACCEPTED (and the 5 minutes renew at every request). The five cases below fix what the code does; the first version of the README and of the BACKLOG entry of 28/10/2026 said otherwise.
// Signature: with the key still the /64, B, C and D have each /64 or each isolate counting alone and the refusals below are 0; with the key the token they are the numbers asserted.
test('binding, when it is asked A: a token the object REFUSED is asked once per 60 s (the memory of refusals): one request every 10 s for 300 s (31 requests) is 6 asks, at 0, 60, 120, 180, 240 and 300 s', async () => {
  const b = fakeBinding(), r = rig(b);
  const bad = token();
  for (let n = 0; n <= 30; n++) { await r.status(bad); r.clock += 10e3; } // t = 0, 10, ..., 300 s
  assert.equal(b.keys.length, 6);
  assert.equal(new Set(b.keys).size, 1);
});

test('binding, when it is asked B: requests of a valid token that arrive at once are ALL asked (nothing is remembered before the first answer): 25 at once from 2 /64 are 25 asks and 5 refusals at 20 per period', async () => {
  const r = rig();
  r.slow = true;
  r.env.WILL_RATE_LIMIT = countingBinding(() => r.clock, 20);
  const mine = await r.good();
  const answers = await Promise.all(Array.from({ length: 25 }, (_, n) => r.status(mine, n < 13 ? `2001:db8:1:1:${n + 1}::1` : `2001:db8:2:2:${n}::1`)));
  assert.equal(r.env.WILL_RATE_LIMIT.keys.length, 25);
  assert.equal(new Set(r.env.WILL_RATE_LIMIT.keys).size, 1);
  assert.equal(answers.filter(a => a.status === 429).length, 5);
  assert.equal(r.api.refusals.binding, 5, 'refused by the binding, not by the tables (each /64 table had at most 13)');
  assert.equal(r.api.refusals.memory, 0);
});

test('binding, when it is asked C: while the object FAILS nothing is remembered, so the token is asked on every request: 60 requests over 30 s from 3 /64 are 60 asks, 20 reach the object and 40 are refused', async () => {
  const r = rig();
  r.env.WILL_RATE_LIMIT = countingBinding(() => r.clock, 20);
  r.mode = 'throw';
  const mine = token(), codes = [];
  for (let n = 0; n < 60; n++) { codes.push((await r.status(mine, `2001:db8:${(n % 3) + 1}:1::1`)).status); r.clock += 500; }
  assert.equal(r.env.WILL_RATE_LIMIT.keys.length, 60);
  assert.equal(r.calls, 20);
  assert.equal(codes.filter(c => c === 429).length, 40);
  assert.equal(codes.filter(c => c === 503).length, 20);
  assert.equal(r.api.refusals.binding, 40);
});

test('binding, when it is asked D: a valid token that is new to 25 isolates is asked 25 times: 20 pass and 5 are refused', async () => {
  const r = rig();
  r.env.WILL_RATE_LIMIT = countingBinding(() => r.clock, 20);
  const mine = await r.good(), codes = [];
  for (let n = 0; n < 25; n++) codes.push((await r.isolate().status(mine, `198.51.100.${n + 1}`)).status);
  assert.equal(r.env.WILL_RATE_LIMIT.keys.length, 25);
  assert.equal(codes.filter(c => c === 429).length, 5);
});

test('binding, when it is asked E: a valid token in use is asked ONCE, because the 5 minutes of the object\'s acceptance renew at every request: one request every 30 s for 600 s is 1 ask', async () => {
  const b = fakeBinding(), r = rig(b);
  const mine = await r.good();
  for (let n = 0; n <= 20; n++) { assert.equal((await r.status(mine)).status, 200); r.clock += 30e3; } // t = 0, 30, ..., 600 s
  assert.equal(b.keys.length, 1);
});

test('binding: it is asked only where the table charges: a token this isolate has seen the object accept never reaches it again, even when the binding refuses everyone', async () => {
  let open = true;
  const b = fakeBinding(() => open), r = rig(b);
  const mine = await r.good();
  assert.equal((await r.status(mine)).status, 200);
  assert.equal(b.keys.length, 1);
  open = false;
  for (let n = 0; n < 50; n++) assert.equal((await r.status(mine)).status, 200, 'a person at work (an upload is dozens of requests) is not counted by the binding on every request');
  assert.equal(b.keys.length, 1);
  assert.equal((await r.status(token())).status, 429, 'a token the isolate has not seen is asked, and the binding says no');
  assert.equal(b.keys.length, 2);
});

test('binding: it is asked after the table, so what the table refuses never costs a binding call: 1,000 random tokens are 20 object calls and at most 20 binding calls', async () => {
  const b = fakeBinding(), r = rig(b);
  const codes = [];
  for (let n = 0; n < 1000; n++) codes.push((await r.status(token())).status);
  assert.equal(r.calls, RATE_LIMIT_CHARGES);
  assert.equal(b.keys.length, RATE_LIMIT_CHARGES);
  assert.equal(codes.filter(c => c === 429).length, 1000 - RATE_LIMIT_CHARGES);
  assert.deepEqual(r.api.refusals, { memory: 1000 - RATE_LIMIT_CHARGES, binding: 0, 'binding-error': 0, 'binding-global': 0, 'binding-global-error': 0 });
});

test('binding: the binding is for the tokens of the browser routes: /publication (no token) and the routes of the build, deploy and admin roles never ask it', async () => {
  const b = fakeBinding(() => false), r = rig(b);
  const pub = await r.api(new Request('https://worker.test/api/v1/friend-a/publication', { headers: { Origin: ORIGIN } }), r.env);
  assert.equal(pub.status, 200);
  const internal = await r.api(new Request('https://worker.test/api/internal/v1/friend-a/prepared'), r.env);
  assert.equal(internal.status, 401, 'refused for want of a bearer, not by the limit');
  assert.equal(b.keys.length, 0);
});

test('binding: a binding that throws, answers nothing or answers something else lets the request go to the table alone, is counted as binding-error and logged once a minute', async () => {
  for (const broken of [{ limit: async () => { throw new Error('binding down'); } }, { limit: async () => undefined }, { limit: async () => ({}) }, { limit: async () => ({ success: 'no' }) }, { limit: () => { throw new Error('sync'); } }]) {
    const alone = rig(broken);
    assert.equal((await alone.status(await alone.good())).status, 200, 'a failing binding does not take the intake down with it');
    assert.equal(alone.api.refusals['binding-error'], 1);
    const r = rig(broken);
    const codes = [];
    for (let n = 0; n < 30; n++) codes.push((await r.status(token())).status);
    assert.equal(r.calls, RATE_LIMIT_CHARGES, 'the table still limits: 20 object calls');
    assert.deepEqual([codes.filter(c => c === 401).length, codes.filter(c => c === 429).length], [20, 10]);
    assert.deepEqual(r.api.refusals, { memory: 10, binding: 0, 'binding-error': RATE_LIMIT_CHARGES, 'binding-global': 0, 'binding-global-error': 0 }, 'one binding-error per request the table charged');
    const lines = r.logs.filter(l => l.event === 'will-rate-limit-binding-error');
    assert.equal(lines.length, 1, 'one line, not one per request');
    assert.equal(lines[0].total, 1);
  }
});

test('binding: a value that is not a binding (no limit function) is the same as no binding: the table alone, and not even a binding-error', async () => {
  for (const odd of [{}, 'yes', 1, { limit: 5 }]) {
    const r = rig(odd);
    for (let n = 0; n < 40; n++) await r.status(token());
    assert.equal(r.calls, RATE_LIMIT_CHARGES);
    assert.deepEqual(r.api.refusals, { memory: 20, binding: 0, 'binding-error': 0, 'binding-global': 0, 'binding-global-error': 0 });
  }
});

test('binding: without the binding the table is the only layer and its refusals are counted as memory', async () => {
  const r = rig();
  const codes = [];
  for (let n = 0; n < 25; n++) codes.push((await r.status(token())).status);
  assert.equal(r.calls, RATE_LIMIT_CHARGES);
  assert.deepEqual(r.api.refusals, { memory: 5, binding: 0, 'binding-error': 0, 'binding-global': 0, 'binding-global-error': 0 });
  assert.equal(r.logs.filter(l => l.event === 'will-rate-limited' && l.layer === 'memory').length, 1);
});

test('binding: which layer refused is logged once a minute per layer, with the running total, and says nothing of the caller (no address, no token, no key)', async () => {
  const b = fakeBinding(() => false), r = rig(b);
  const ips = [];
  for (let n = 0; n < 200; n++) { const ip = `2001:db8:${n.toString(16)}::1`; ips.push(ip); await r.status(token(), ip); } // 200 different /64: the table never stops them, the binding does
  assert.equal(r.api.refusals.binding, 200);
  let lines = r.logs.filter(l => l.event === 'will-rate-limited');
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], { event: 'will-rate-limited', layer: 'binding', total: 1 });
  r.clock += LAYER_LOG_FLOOR_MS;
  await r.status(token(), '2001:db8:ffff::1');
  lines = r.logs.filter(l => l.event === 'will-rate-limited');
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[1], { event: 'will-rate-limited', layer: 'binding', total: 201 });
  const text = JSON.stringify(r.logs);
  assert.ok(!text.includes('2001') && !text.includes('203.0.113') && !/[A-Za-z0-9_-]{43}/.test(text), 'nothing of the caller in the log');
});

test('binding: the object being down is not a binding refusal: the answer is the object\'s, and the refusal counters stay at zero', async () => {
  const b = fakeBinding(), r = rig(b);
  r.mode = 'throw';
  const a = await r.status(await r.good());
  assert.equal(a.status, 503);
  assert.deepEqual(r.api.refusals, { memory: 0, binding: 0, 'binding-error': 0, 'binding-global': 0, 'binding-global-error': 0 });
});

// ---- the ceiling of the whole intake (Marco, 29/10/2026, questionnaire): a SECOND binding, WILL_RATE_LIMIT_GLOBAL, 60 per 60 s, ONE CONSTANT key, asked after the per-token one for the same requests ----
// Signature: before this change api.js never read env.WILL_RATE_LIMIT_GLOBAL, so (a) lets the request through and the global fake is asked 0 times, the rotating-token test below lets 100 of 100 reach the object (the per-token binding
// sees 100 new keys), and (f) has no keys to compare. The fake global binding is `fakeBinding`/`countingBinding` again; nothing reads the network.
const withGlobal = (global, perToken = fakeBinding()) => { const r = rig(perToken); r.env.WILL_RATE_LIMIT_GLOBAL = global; return r; };

test('global (a): when the ceiling refuses, the answer is 429 RATE_LIMITED with Retry-After 60 even though the per-token binding allows, the object is never asked and the layer is counted as binding-global', async () => {
  const per = fakeBinding(), g = fakeBinding(() => false), r = withGlobal(g, per);
  const a = await r.status(await r.good());
  assert.equal(a.status, 429);
  assert.equal((await a.json()).error.code, 'RATE_LIMITED');
  assert.equal(a.headers.get('Retry-After'), String(BINDING_PERIOD_S));
  assert.equal(a.headers.get('Access-Control-Expose-Headers'), 'Retry-After');
  assert.equal(per.keys.length, 1, 'the per-token binding was asked, and allowed');
  assert.equal(r.calls, 0);
  assert.deepEqual(r.api.refusals, { memory: 0, binding: 0, 'binding-error': 0, 'binding-global': 1, 'binding-global-error': 0 });
});

test('global (a), the charge: a refusal by the ceiling gives the table\'s charge back and is not remembered as a refused token: when it opens, 20 new tokens still reach the object', async () => {
  let open = false;
  const g = fakeBinding(() => open), r = withGlobal(g);
  const mine = await r.good();
  for (let n = 0; n < 3 * RATE_LIMIT_CHARGES; n++) assert.equal((await r.status(token())).status, 429); // 60 refusals: the table would have stopped at 20 had they kept their charge
  assert.equal((await r.status(mine)).status, 429);
  assert.equal(r.calls, 0);
  open = true;
  assert.equal((await r.status(mine)).status, 200, 'the valid token works as soon as the ceiling lets it through');
  const codes = [];
  for (let n = 0; n < RATE_LIMIT_CHARGES; n++) codes.push((await r.status(token())).status);
  assert.equal(r.calls, 1 + RATE_LIMIT_CHARGES);
});

test('global (b): when the ceiling allows and the per-token binding refuses, the answer is 429 from the per-token layer (counted as binding) and the ceiling is NOT asked: a token the first binding refuses never spends the shared count', async () => {
  const per = fakeBinding(() => false), g = fakeBinding(), r = withGlobal(g, per);
  const a = await r.status(await r.good());
  assert.equal(a.status, 429);
  assert.equal(a.headers.get('Retry-After'), String(BINDING_PERIOD_S));
  assert.equal(per.keys.length, 1);
  assert.equal(g.keys.length, 0, 'the order: per-token first, ceiling second');
  assert.equal(r.calls, 0);
  assert.deepEqual(r.api.refusals, { memory: 0, binding: 1, 'binding-error': 0, 'binding-global': 0, 'binding-global-error': 0 });
});

test('global (c): without the binding, or with a value that is not one (no limit function), the request goes on: the per-token binding and the table alone, and not even a binding-global-error', async () => {
  const noGlobal = rig(fakeBinding());
  assert.equal((await noGlobal.status(await noGlobal.good())).status, 200);
  assert.deepEqual(noGlobal.api.refusals, { memory: 0, binding: 0, 'binding-error': 0, 'binding-global': 0, 'binding-global-error': 0 });
  for (const odd of [undefined, null, {}, 'yes', 1, { limit: 5 }]) {
    const r = withGlobal(odd);
    assert.equal((await r.status(await r.good())).status, 200);
    for (let n = 0; n < 40; n++) await r.status(token());
    assert.equal(r.calls, 1 + RATE_LIMIT_CHARGES, 'the valid token (its charge is given back) and the table\'s own 20');
    assert.deepEqual(r.api.refusals, { memory: 20, binding: 0, 'binding-error': 0, 'binding-global': 0, 'binding-global-error': 0 });
  }
});

test('global (d): a ceiling that throws, answers nothing or answers something else lets the request through (fail open), is counted as binding-global-error and logged once a minute under its own event; the table still limits', async () => {
  for (const broken of [{ limit: async () => { throw new Error('binding down'); } }, { limit: async () => undefined }, { limit: async () => ({}) }, { limit: async () => ({ success: 'no' }) }, { limit: () => { throw new Error('sync'); } }]) {
    const one = withGlobal(broken);
    assert.equal((await one.status(await one.good())).status, 200, 'a failing ceiling does not take the intake down');
    assert.equal(one.api.refusals['binding-global-error'], 1);
    const r = withGlobal(broken), codes = [];
    for (let n = 0; n < 30; n++) codes.push((await r.status(token())).status);
    assert.equal(r.calls, RATE_LIMIT_CHARGES, 'the table still limits: 20 object calls');
    assert.deepEqual([codes.filter(c => c === 401).length, codes.filter(c => c === 429).length], [20, 10]);
    assert.deepEqual(r.api.refusals, { memory: 10, binding: 0, 'binding-error': 0, 'binding-global': 0, 'binding-global-error': RATE_LIMIT_CHARGES }, 'one binding-global-error per request the table charged');
    const lines = r.logs.filter(l => l.event === 'will-rate-limit-global-error');
    assert.equal(lines.length, 1, 'one line, not one per request');
    assert.equal(lines[0].total, 1);
    assert.equal(r.logs.filter(l => l.event === 'will-rate-limit-binding-error').length, 0, 'not confused with the per-token binding\'s error');
  }
});

test('global (d), the layers are independent: the per-token binding failing does not skip the ceiling, and the ceiling refusing still refuses', async () => {
  const g = fakeBinding(() => false), r = withGlobal(g, { limit: async () => { throw new Error('down'); } });
  const a = await r.status(await r.good());
  assert.equal(a.status, 429);
  assert.equal(g.keys.length, 1);
  assert.deepEqual(r.api.refusals, { memory: 0, binding: 0, 'binding-error': 1, 'binding-global': 1, 'binding-global-error': 0 });
});

test('global (e): it is asked only for the requests the table charged: a token this isolate has seen the object accept, /publication and the build/deploy/admin routes never ask it', async () => {
  let open = true;
  const g = fakeBinding(() => open), r = withGlobal(g);
  const mine = await r.good();
  assert.equal((await r.status(mine)).status, 200);
  assert.equal(g.keys.length, 1);
  open = false;
  for (let n = 0; n < 50; n++) assert.equal((await r.status(mine)).status, 200, 'a person at work is not counted by the ceiling on every request');
  assert.equal(g.keys.length, 1, 'not asked again for the known token');
  const pub = await r.api(new Request('https://worker.test/api/v1/friend-a/publication', { headers: { Origin: ORIGIN } }), r.env);
  assert.equal(pub.status, 200);
  const internal = await r.api(new Request('https://worker.test/api/internal/v1/friend-a/prepared'), r.env);
  assert.equal(internal.status, 401, 'refused for want of a bearer, not by the ceiling');
  assert.equal(g.keys.length, 1);
  // what the table refuses costs no call of the ceiling either: 1,000 tokens in a row are at most 20 asks
  const closed = withGlobal(fakeBinding());
  for (let n = 0; n < 1000; n++) await closed.status(token());
  assert.equal(closed.env.WILL_RATE_LIMIT_GLOBAL.keys.length, RATE_LIMIT_CHARGES);
  const none = withGlobal(fakeBinding());
  await none.api(new Request('https://worker.test/api/v1/friend-a/publication', { headers: { Origin: ORIGIN } }), none.env);
  assert.equal(none.env.WILL_RATE_LIMIT_GLOBAL.keys.length, 0);
});

test('global (f): the key is ONE CONSTANT for every caller: two tokens, two addresses, two isolates, the same string; never the token, its hash or any part of an address', async () => {
  const g = fakeBinding(), r = withGlobal(g, fakeBinding());
  const a = token(), c = token();
  await r.status(a, '2001:db8:1:2:aaaa::1');
  await r.isolate().status(c, '203.0.113.7');
  await r.status(token(), null);
  assert.equal(g.keys.length, 3);
  assert.deepEqual([...new Set(g.keys)], [GLOBAL_BINDING_KEY], 'one key');
  assert.equal(GLOBAL_BINDING_KEY, 'will-intake');
  assert.ok(!/[0-9a-f]{64}/.test(g.keys[0]) && !g.keys[0].includes(a) && !/[:.]/.test(g.keys[0]));
  assert.notEqual(g.keys[0], await digest(a));
  assert.equal(GLOBAL_BINDING_NAME, 'WILL_RATE_LIMIT_GLOBAL');
});

test('global: the case it closes: 100 different tokens from 100 different /64, over two isolates, with a per-token binding that allows ONE call per key, are 60 calls of the object and 40 refusals by the ceiling; a minute later it lets the next one through', async () => {
  const r = rig();
  r.env.WILL_RATE_LIMIT = countingBinding(() => r.clock, 1); // every token is a new key: the per-token binding never refuses
  r.env.WILL_RATE_LIMIT_GLOBAL = countingBinding(() => r.clock, 60);
  const two = [r.api, r.isolate()], codes = [];
  for (let n = 0; n < 100; n++) codes.push((await two[n % 2].status(token(), `2001:db8:${(n + 1).toString(16)}:1::1`)).status);
  assert.equal(r.env.WILL_RATE_LIMIT.keys.length, 100);
  assert.equal(new Set(r.env.WILL_RATE_LIMIT.keys).size, 100);
  assert.equal(r.calls, 60, 'the ceiling is shared by the isolates: 60 reached the object');
  assert.equal(codes.filter(c => c === 429).length, 40);
  assert.equal(two[0].refusals['binding-global'] + two[1].refusals['binding-global'], 40);
  assert.equal(two[0].refusals.binding + two[1].refusals.binding, 0);
  assert.equal(two[0].refusals.memory + two[1].refusals.memory, 0, 'each /64 was new: the tables stopped nobody');
  r.clock += BINDING_PERIOD_S * 1000;
  assert.equal((await two[0].status(token(), '2001:db8:fff:1::1')).status, 401, 'a period later the ceiling has room again (the object answers; the token is not a valid one)');
});

test('global: which layer refused is logged once a minute, as will-rate-limited with layer binding-global and the running total, and says nothing of the caller (no address, no token, no key)', async () => {
  const g = fakeBinding(() => false), r = withGlobal(g);
  for (let n = 0; n < 50; n++) await r.status(token(), `2001:db8:${(n + 1).toString(16)}::1`);
  assert.equal(r.api.refusals['binding-global'], 50);
  let lines = r.logs.filter(l => l.event === 'will-rate-limited');
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], { event: 'will-rate-limited', layer: 'binding-global', total: 1 });
  r.clock += LAYER_LOG_FLOOR_MS;
  await r.status(token(), '2001:db8:ffff::1');
  lines = r.logs.filter(l => l.event === 'will-rate-limited');
  assert.deepEqual(lines[1], { event: 'will-rate-limited', layer: 'binding-global', total: 51 });
  const text = JSON.stringify(r.logs);
  assert.ok(!text.includes('2001') && !text.includes(GLOBAL_BINDING_KEY) && !/[A-Za-z0-9_-]{43}/.test(text), 'nothing of the caller in the log');
});

// ---- the configuration, pinned: a wrong period is a deploy that fails, a wrong name is a binding the code never finds ----
const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const block = (toml.match(/^\[\[ratelimits\]\]\n((?:(?!\[).*\n?)*)/m) || [])[1] || '';

test('binding: wrangler.toml declares exactly two [[ratelimits]] blocks, the per-token one first (named like the code reads it, 20 per 60 s) and, since 29/10/2026, the ceiling of the whole intake (60 per 60 s), each with its own namespace id of digits', () => {
  assert.equal((toml.match(/^\[\[ratelimits\]\]/gm) || []).length, 2);
  assert.equal(BINDING_NAME, 'WILL_RATE_LIMIT');
  assert.match(block, new RegExp(`^name = "${BINDING_NAME}"$`, 'm'));
  assert.match(block, /^namespace_id = "[0-9]{1,20}"$/m);
  assert.match(block, /^simple = \{ limit = 20, period = 60 \}$/m);
  assert.equal(BINDING_PERIOD_S, 60, 'Retry-After of a refusal by the binding is its period');
  assert.ok([10, 60].includes(BINDING_PERIOD_S), 'Cloudflare accepts only 10 or 60 seconds');
  assert.ok(!/^\[\[unsafe\.bindings\]\]/m.test(toml), 'one syntax, the current one (the old form is only named in a comment)');
  assert.equal(toml.match(/^WILL_UPLOAD_ENABLED = "(\w+)"/m)[1], 'false', 'adding the binding turns nothing on');
});

test('global: the second [[ratelimits]] block is the ceiling: WILL_RATE_LIMIT_GLOBAL, 60 per 60 s (the period the code gives as Retry-After), a namespace id of digits that is not the first one\'s, and a dated comment with the accepted risk', () => {
  const blocks = [...toml.matchAll(/^\[\[ratelimits\]\]\n((?:(?!\[\[).*\n?)*)/gm)].map(m => m[1]);
  assert.equal(blocks.length, 2);
  const second = blocks[1];
  assert.match(second, new RegExp(`^name = "${GLOBAL_BINDING_NAME}"$`, 'm'));
  assert.match(second, /^namespace_id = "[0-9]{1,20}"$/m);
  assert.match(second, /^simple = \{ limit = 60, period = 60 \}$/m);
  const ids = blocks.map(b => b.match(/^namespace_id = "(\d+)"$/m)[1]);
  assert.equal(new Set(ids).size, 2, 'two bindings, two namespace ids');
  assert.equal(ids[1], '20261029');
  const names = blocks.map(b => b.match(/^name = "(\w+)"$/m)[1]);
  assert.equal(new Set(names).size, 2);
  assert.equal(BINDING_PERIOD_S, Number(second.match(/period = (\d+)/)[1]), 'the Retry-After of both refusals is the period of both blocks');
  const before = toml.slice(0, toml.lastIndexOf('[[ratelimits]]'));
  const comment = before.slice(before.lastIndexOf('# The ceiling of the WHOLE intake'));
  assert.match(comment, /Marco, 29\/10\/2026/);
  assert.match(comment, /ACCEPTED RISK, his: a persistent attacker can keep the ceiling used up, and then Will, whose token is valid, waits a minute at a time/);
  assert.match(comment, /per Cloudflare location and approximate/);
  assert.match(comment, /NOT created and NOT tried against the account/);
  assert.equal(toml.match(/^WILL_UPLOAD_ENABLED = "(\w+)"/m)[1], 'false', 'the second binding turns nothing on either');
});
