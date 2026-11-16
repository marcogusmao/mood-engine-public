// S2 of the review of 8e37c23 (20/10/2026): an invalid credential reached the Durable Object without limit. api.js checked only the 43-character shape; the real check and the quotas run inside the
// object and count only authorized requests, so 1,000 random tokens on /api/v1/friend-a/status were 1,000 calls of the object that also serves Will's uploads.
// Signature: before src/upload/limiter.js, `calls` below was 1,000 in the first two tests. The tests plant a fake WILL_STATE and a clock; nothing reads the network or a live cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createUploadApi } from '../src/upload/api.js';
import { digest } from '../src/upload/protocol.js';
import { createLimiter, addressKey, RATE_LIMIT_CHARGES, RATE_WINDOW_MS, REFUSED_TTL_MS, KNOWN_GOOD_TTL_MS } from '../src/upload/limiter.js';

const ORIGIN = 'https://marcogusmao.github.io';
const BASE = { WILL_UPLOAD_ENABLED: 'true', WILL_BROWSER_ORIGIN: ORIGIN, WILL_PAGES_BASE: 'https://marcogusmao.github.io/mood-engine', WILL_REPOSITORY_ID: '1413569629', WILL_REPOSITORY_OWNER_ID: '50679408' };
const token = () => randomBytes(32).toString('base64url'); // 43 characters
const body = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
const refusal = (status, code) => body(status, { schemaVersion: 1, personId: 'friend-a', error: { code, message: 'The request could not be completed.', retryable: false } });

/** A rig whose object knows `valid` (a Set of sha256) and counts every call; `mode` can make it fail instead. */
function rig() {
  const r = { calls: 0, clock: 1e9, valid: new Set(), mode: 'normal', registered: [] };
  r.env = { ...BASE, WILL_STATE: { idFromName: () => 'id', get: () => ({ fetch: async request => {
    r.calls++;
    if (r.slow) await new Promise(done => setTimeout(done, 20)); // the answers come back after every request of a burst was admitted
    if (r.mode === 'throw') throw new Error('object down');
    if (r.mode === 'busy') return body(503, { error: { code: 'STORAGE_UNAVAILABLE' } });
    const op = JSON.parse(request.headers.get('X-Mood-Operation'));
    if (r.mode === 'forbidden') return refusal(403, 'BLOB_FORBIDDEN');
    if (op.name === 'session') { r.valid.add(op.actor.credentialHash); r.registered.push(op.actor.credentialHash); return body(201, { schemaVersion: 1, personId: 'friend-a', expiresAt: 'x' }); }
    if (op.actor.role === 'public') return body(200, { schemaVersion: 1, personId: 'friend-a', activePublication: r.publication ?? null });
    return r.valid.has(op.actor.hash) ? body(200, { schemaVersion: 1, personId: 'friend-a', state: 'ok' }) : refusal(401, 'CREDENTIAL_INVALID');
  } }) } };
  r.logs = [];
  r.api = createUploadApi({ now: () => r.clock, log: o => r.logs.push(o) });
  r.status = (tok, ip = '203.0.113.7') => r.api(new Request('https://worker.test/api/v1/friend-a/status', { headers: { Authorization: 'Bearer ' + tok, Origin: ORIGIN, ...(ip ? { 'cf-connecting-ip': ip } : {}) } }), r.env);
  r.session = (invite, credential, ip = '203.0.113.7', raw) => r.api(new Request('https://worker.test/api/v1/friend-a/session', { method: 'POST', headers: { Authorization: 'Bearer ' + invite, Origin: ORIGIN, 'Content-Type': 'application/json', 'cf-connecting-ip': ip }, body: raw ?? JSON.stringify({ schemaVersion: 1, personId: 'friend-a', inviteId: '11111111-1111-4111-8111-111111111111', credential }) }), r.env);
  r.good = async () => { const t = token(); r.valid.add(await digest(t)); return t; };
  return r;
}

test('S2: 1,000 random tokens from one address are at most RATE_LIMIT_CHARGES (20) calls of the object; the rest are 429 with Retry-After', async () => {
  const r = rig();
  const codes = [];
  for (let n = 0; n < 1000; n++) { const a = await r.status(token()); codes.push(a.status); if (a.status === 429) { assert.match(a.headers.get('Retry-After'), /^[1-9][0-9]*$/); assert.ok(+a.headers.get('Retry-After') <= RATE_WINDOW_MS / 1000); } }
  // 20: a person has one browser credential and at most a few wrong tries; a window of 10 minutes is long enough for a scan to be useless and short enough that a mistake heals.
  assert.equal(RATE_LIMIT_CHARGES, 20);
  assert.ok(r.calls <= 20, `${r.calls} calls of the object for 1,000 requests`);
  assert.equal(codes.filter(c => c === 401).length, r.calls, 'the ones that got through were refused by the object');
  assert.equal(codes.filter(c => c === 429).length, 1000 - r.calls);
});

test('S2: 1,000 random tokens asked all at once (the charge is taken at admission, not after the answer) are the same 20 calls', async () => {
  const r = rig();
  r.slow = true;
  const answers = await Promise.all(Array.from({ length: 1000 }, () => r.status(token())));
  assert.ok(r.calls <= 20, `${r.calls} calls`);
  assert.equal(answers.filter(a => a.status === 429).length, 1000 - r.calls);
});

test('S2: the limit lifts at Retry-After: a valid token is refused with 429 before it and works after it; the window is not extended by the refused requests', async () => {
  const r = rig();
  for (let n = 0; n < 50; n++) await r.status(token());
  const valid = await r.good();
  const early = await r.status(valid);
  assert.equal(early.status, 429);
  const wait = +early.headers.get('Retry-After');
  assert.ok(wait > 0 && wait <= RATE_WINDOW_MS / 1000);
  r.clock += (wait - 1) * 1000;
  assert.equal((await r.status(valid)).status, 429, 'one second before Retry-After');
  r.clock += 1000;
  const after = await r.status(valid);
  assert.equal(after.status, 200);
  const calls = r.calls;
  assert.equal((await r.status(valid)).status, 200);
  assert.equal(r.calls, calls + 1);
});

test('S2: a token the object accepted before the limit keeps working while the address is locked (a neighbour of an attacker is not cut off)', async () => {
  const r = rig();
  const valid = await r.good();
  assert.equal((await r.status(valid)).status, 200);
  for (let n = 0; n < 200; n++) await r.status(token());
  assert.equal((await r.status(token())).status, 429);
  assert.equal((await r.status(valid)).status, 200);
  r.clock += KNOWN_GOOD_TTL_MS;
  assert.equal((await r.status(valid)).status, 429, 'after 5 minutes it is a token the isolate no longer knows, and the address is still locked');
});

test('S2: different addresses do not block each other', async () => {
  const r = rig();
  for (let n = 0; n < 100; n++) await r.status(token(), '198.51.100.1');
  assert.equal((await r.status(token(), '198.51.100.1')).status, 429);
  const calls = r.calls;
  assert.equal((await r.status(token(), '198.51.100.2')).status, 401, 'another address reaches the object');
  assert.equal(r.calls, calls + 1);
  assert.equal((await r.status(await r.good(), '198.51.100.2')).status, 200);
  for (let n = 0; n < 100; n++) await r.status(token(), '198.51.100.3');
  assert.ok(r.calls <= 20 * 3 + 1 + 1, 'each address has its own 20');
});

test('S2: the same refused token again and again is one call of the object (negative cache), the same answer, for a minute', async () => {
  const r = rig();
  const bad = token();
  const first = await r.status(bad);
  assert.equal(first.status, 401);
  for (let n = 0; n < 500; n++) { const a = await r.status(bad); assert.equal(a.status, 401); assert.equal((await a.json()).error.code, 'CREDENTIAL_INVALID'); }
  assert.equal(r.calls, 1);
  assert.equal((await r.status(token())).status, 401, 'one repeated token did not use up the address');
  r.clock += REFUSED_TTL_MS;
  await r.status(bad);
  assert.equal(r.calls, 3, 'a minute later the object is asked again');
});

test('S2: valid traffic is not charged: 300 requests with one token and with 100 different tokens never meet the limit', async () => {
  const r = rig();
  const one = await r.good();
  for (let n = 0; n < 300; n++) assert.equal((await r.status(one)).status, 200);
  for (let n = 0; n < 100; n++) assert.equal((await r.status(await r.good())).status, 200);
  assert.equal(r.calls, 400);
});

test('S2: a failing object keeps the charge (5xx and thrown errors are not "recognized"): 500 requests, at most 20 calls', async () => {
  for (const mode of ['busy', 'throw']) {
    const r = rig();
    r.mode = mode;
    const codes = new Set();
    for (let n = 0; n < 500; n++) codes.add((await r.status(token())).status);
    assert.ok(r.calls <= 20, `${mode}: ${r.calls}`);
    assert.deepEqual([...codes].sort(), [429, 503]);
  }
});

test('S2: a 403 that is not about the token (the object knew it) is not cached as a refusal and gives the charge back', async () => {
  const r = rig();
  r.mode = 'forbidden';
  const t = token();
  for (let n = 0; n < 40; n++) assert.equal((await r.status(t)).status, 403);
  assert.equal(r.calls, 40, 'every call reached the object: no negative cache for this answer');
  for (let n = 0; n < 40; n++) assert.equal((await r.status(token())).status, 403);
  assert.equal(r.calls, 80, 'and none of them used up the address');
});

test('S2: a request that ends before the object is asked (a body that is not JSON) is not charged', async () => {
  const r = rig();
  for (let n = 0; n < 100; n++) assert.equal((await r.session(token(), token(), '203.0.113.9', '{not json')).status, 400);
  assert.equal(r.calls, 0);
  assert.equal((await r.status(token(), '203.0.113.9')).status, 401, 'the address still has its 20');
});

test('S2: a successful /session forgets the refusal of the credential it registers (the same token on /status inside the minute works)', async () => {
  const r = rig();
  const credential = token();
  assert.equal((await r.status(credential)).status, 401);
  assert.equal((await r.status(credential)).status, 401);
  assert.equal(r.calls, 1);
  assert.equal((await r.session(token(), credential)).status, 201);
  assert.equal(r.registered.length, 1);
  assert.equal((await r.status(credential)).status, 200, 'not the cached refusal');
});

test('S2: the 429 is an ordinary JSON answer of the API: no-store, nosniff, the browser origin may read Retry-After', async () => {
  const r = rig();
  for (let n = 0; n < 25; n++) await r.status(token());
  const a = await r.status(token());
  assert.equal(a.status, 429);
  assert.equal(a.headers.get('Cache-Control'), 'no-store');
  assert.equal(a.headers.get('Access-Control-Expose-Headers'), 'Retry-After');
  assert.equal(a.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const j = await a.json();
  assert.equal(j.error.code, 'RATE_LIMITED');
  assert.equal(j.error.retryable, true);
});

test('S2: a missing address header shares one key; the routes without a token do not use the limit (and /publication is S1b, below)', async () => {
  const r = rig();
  for (let n = 0; n < 100; n++) await r.status(token(), null);
  assert.equal(r.calls, 20, 'with no cf-connecting-ip every request shares the key "no-ip"');
  const p = await r.api(new Request('https://worker.test/api/v1/friend-a/publication', { headers: { 'cf-connecting-ip': '203.0.113.50' } }), r.env);
  assert.equal(p.status, 200, 'a locked key does not touch the routes without a token');
});

test('S2: limiter memory is bounded (addresses, refused tokens, known tokens)', () => {
  let t = 0;
  const l = createLimiter({ now: () => t });
  for (let n = 0; n < 5000; n++) l.admit('ip-' + n, 'h' + n).done(n % 2 ? 401 : 200, 'CREDENTIAL_INVALID');
  assert.ok(l._state.buckets.size <= 2048 && l._state.refused.size <= 512 && l._state.good.size <= 256, JSON.stringify([l._state.buckets.size, l._state.refused.size, l._state.good.size]));
});

// Final review, 20/10/2026 (medium 1): the key was the whole IPv6 address, so 1,000 addresses of one /64 were 1,000 buckets and 1,000 calls of the object.
test('S2: 1,000 tokens from 1,000 addresses of the same /64 are at most 20 calls of the object; another /64 and an IPv4 address are other keys', async () => {
  const r = rig();
  for (let n = 0; n < 1000; n++) await r.status(token(), `2001:db8:1:2:${(n + 1).toString(16)}:${(n * 7).toString(16)}::${n.toString(16) || '0'}`);
  assert.ok(r.calls <= 20, `${r.calls} calls`);
  const calls = r.calls;
  assert.equal((await r.status(token(), '2001:db8:1:3::1')).status, 401, 'the next /64 reaches the object');
  assert.equal((await r.status(token(), '203.0.113.7')).status, 401, 'an IPv4 address is another key');
  assert.equal(r.calls, calls + 2);
  const burst = rig();
  burst.slow = true;
  const answers = await Promise.all(Array.from({ length: 1000 }, (_, n) => burst.status(token(), `2001:db8:9:9:${(n + 1).toString(16)}::1`)));
  assert.ok(burst.calls <= 20 && answers.filter(a => a.status === 429).length === 1000 - burst.calls, `${burst.calls} calls at once`);
});

// Marco, 28/10/2026: the Rate Limiting binding is keyed by the token's sha256 (test/will-rate-limit-binding.test.js); the TABLE of this file does NOT change and stays keyed by the /64. Signature: if the table followed the
// binding's key (the token), every random token would be a new bucket and 1,000 requests would be 1,000 calls of the object; if the binding followed the table's (the /64), its keys would be 20 or fewer distinct strings.
test('S2: with the binding present (keyed by the token since 28/10/2026) the table is still keyed by the /64: 1,000 tokens from 1,000 addresses of one /64 are 20 calls of the object, and the binding was asked 20 times with 20 different keys', async () => {
  const r = rig(), asked = [];
  r.env.WILL_RATE_LIMIT = { limit: async ({ key }) => { asked.push(key); return { success: true }; } };
  for (let n = 0; n < 1000; n++) await r.status(token(), `2001:db8:1:2:${(n + 1).toString(16)}:${(n * 7).toString(16)}::${n.toString(16) || '0'}`);
  assert.equal(r.calls, RATE_LIMIT_CHARGES);
  assert.equal(asked.length, RATE_LIMIT_CHARGES, 'only the requests the table charged');
  assert.equal(new Set(asked).size, RATE_LIMIT_CHARGES, 'a key per token, not one key for the /64');
  assert.ok(asked.every(k => /^[0-9a-f]{64}$/.test(k)));
});

test('S2: addressKey: every spelling of one /64 is one key, IPv4 (also mapped into IPv6) stays per address, junk and a missing header still have a key', () => {
  const same = ['2001:DB8:0:0:5::1', '2001:db8::1', '2001:0db8:0000:0000:ffff:ffff:ffff:ffff', '2001:db8:0:0::', '2001:db8:0:0:1:2:3:4%eth0'];
  assert.equal(new Set(same.map(addressKey)).size, 1);
  assert.equal(addressKey('2001:db8:0:1::1') === addressKey('2001:db8::1'), false);
  assert.equal(addressKey('203.0.113.7'), '203.0.113.7');
  assert.equal(addressKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(addressKey('::FFFF:cb00:7107'), '203.0.113.7');
  assert.notEqual(addressKey('203.0.113.7'), addressKey('203.0.113.8'));
  assert.equal(addressKey(null), 'no-ip');
  assert.equal(addressKey('  '), 'no-ip');
  assert.equal(addressKey('not an address'), 'not an address');
  assert.equal(addressKey('x'.repeat(200)).length, 64);
});

test('S2: a flood of 2,100 other /64 prefixes does not reopen the 20 of a used-up bucket inside the window; after the window it reopens', async () => {
  const r = rig();
  const victim = '2001:db8:aaaa:1::1';
  for (let n = 0; n < 30; n++) await r.status(token(), victim);
  assert.equal(r.calls, 20);
  assert.equal((await r.status(token(), victim)).status, 429);
  for (let n = 0; n < 2100; n++) await r.status(token(), `2001:db8:bbbb:${n.toString(16)}::1`);
  assert.equal(r.calls, 20 + 2100, 'each flood prefix paid its own single call');
  const before = r.calls;
  assert.equal((await r.status(token(), victim)).status, 429, 'the used-up bucket was not the one let go');
  assert.equal(r.calls, before);
  r.clock += RATE_WINDOW_MS;
  assert.equal((await r.status(token(), victim)).status, 401, 'and after the window it reaches the object again');
});

test('S2: when the table of addresses is full, expired buckets go first, then the ones with the fewest charges', () => {
  let t = 0;
  const l = createLimiter({ now: () => t });
  for (let n = 0; n < RATE_LIMIT_CHARGES; n++) l.admit('used-up', 'h' + n);
  for (let n = 0; n < 2100; n++) l.admit('other-' + n, 'g' + n);
  assert.ok(l._state.buckets.has('used-up'));
  assert.ok(l._state.buckets.size <= 2048);
  t += RATE_WINDOW_MS;
  for (let n = 0; n < 2100; n++) l.admit('late-' + n, 'k' + n);
  assert.equal(l._state.buckets.has('used-up'), false, 'expired buckets are the first to go');
});

// Final review, 20/10/2026 (medium 2, S1b): GET /publication (no token) went to the object on every call, and the Will page calls it on every visit.
test('S1b: 1,000 GET /publication from one address are one read of the object; the answer is what the object would send; 60 s later another read', async () => {
  const r = rig();
  const first = await r.api(new Request('https://worker.test/api/v1/friend-a/publication'), r.env);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { schemaVersion: 1, personId: 'friend-a', state: 'not_ready', activePublication: null });
  assert.equal(first.headers.get('Cache-Control'), 'no-store');
  assert.match(first.headers.get('Content-Type'), /application\/json/);
  for (let n = 0; n < 999; n++) assert.equal((await r.api(new Request('https://worker.test/api/v1/friend-a/publication', { headers: { 'cf-connecting-ip': '203.0.113.' + (n % 200) } }), r.env)).status, 200);
  assert.equal(r.calls, 1);
  r.publication = { revision: 'r-' + '1'.repeat(32) };
  r.clock += 60e3;
  const next = await (await r.api(new Request('https://worker.test/api/v1/friend-a/publication'), r.env)).json();
  assert.equal(r.calls, 2);
  assert.equal(next.state, 'ready');
  assert.equal(next.activePublication.revision, 'r-' + '1'.repeat(32));
});

test('S1b: /publication fails like the addon: the earlier pointer while the object is down (logged), a 503 JSON with none, asked again after 5 s', async () => {
  const r = rig();
  r.publication = { revision: 'r-' + '2'.repeat(32) };
  const ask = () => r.api(new Request('https://worker.test/api/v1/friend-a/publication'), r.env);
  assert.equal((await ask()).status, 200);
  r.mode = 'busy';
  r.clock += 60e3;
  for (let n = 0; n < 5; n++) { const a = await ask(); assert.equal(a.status, 200); assert.equal((await a.json()).activePublication.revision, 'r-' + '2'.repeat(32)); }
  assert.equal(r.calls, 2, 'one failed read, not five');
  assert.equal(r.logs.length, 1);
  assert.equal(r.logs[0].message, 'will publication read failed, serving previous pointer');
  const down = rig();
  down.mode = 'busy';
  for (let n = 0; n < 5; n++) { const a = await down.api(new Request('https://worker.test/api/v1/friend-a/publication'), down.env); assert.equal(a.status, 503); assert.equal((await a.json()).error.code, 'PUBLICATION_UNAVAILABLE'); }
  assert.equal(down.calls, 1);
  const off = await down.api(new Request('https://worker.test/api/v1/friend-a/publication'), { ...down.env, WILL_UPLOAD_ENABLED: 'false' });
  assert.equal(off.status, 503);
  assert.equal((await off.json()).error.code, 'CONFIG_MISSING');
});

// Review of ed9e3a0, 20/10/2026 (medium 1): `if (b === keep) continue;` in makeRoom had no test. Without it, on a full table the bucket just made (0 charges, the fewest) is the one let go at once:
// a single /64 passed 500 of 500 (with the line: 20 of 500). A new address arriving on a full table must keep its bucket.
test('S2: on a full table a NEW /64 keeps its bucket: 500 tokens from one /64 are at most 20 calls, and a further flood does not reopen it', async () => {
  const r = rig();
  for (let n = 0; n < 2100; n++) await r.status(token(), `2001:db8:cccc:${n.toString(16)}::1`); // the table (2,048) is full of buckets with one charge each
  assert.equal(r.calls, 2100);
  const before = r.calls, attacker = '2001:db8:dddd:1::1';
  const codes = [];
  for (let n = 0; n < 500; n++) codes.push((await r.status(token(), attacker)).status);
  assert.equal(r.calls - before, 20, `${r.calls - before} calls of the object for 500 requests from one new /64 on a full table`);
  assert.equal(codes.filter(c => c === 429).length, 480);
  for (let n = 0; n < 100; n++) await r.status(token(), `2001:db8:eeee:${n.toString(16)}::1`); // more new prefixes arrive
  const mid = r.calls;
  assert.equal((await r.status(token(), attacker)).status, 429, 'the used-up bucket is still there');
  assert.equal(r.calls, mid);
});

test('S2: the limiter alone: a new key on a full table is admitted at most RATE_LIMIT_CHARGES times, and the bucket just made is not in the table-trimming loop\'s reach', () => {
  const l = createLimiter({ now: () => 0 });
  for (let n = 0; n < 2100; n++) l.admit('busy-' + n, 'b' + n);
  let admitted = 0;
  for (let n = 0; n < 500; n++) { try { l.admit('newcomer', 'n' + n); admitted++; } catch { /* 429 */ } }
  assert.equal(admitted, RATE_LIMIT_CHARGES);
  assert.ok(l._state.buckets.has('newcomer'));
});
