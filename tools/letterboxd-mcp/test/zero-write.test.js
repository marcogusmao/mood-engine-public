'use strict';
// The server writes nothing and opens no connection. Two independent proofs:
//  1. a recursive listing (path, size, mtime, sha256) of a copy of the root, before and after every tool and a refused call;
//  2. test/guard.cjs preloaded in the server process (NODE_OPTIONS), which throws and prints GUARD-VIOLATION on any write,
//     socket, DNS lookup, fetch or child process. test/guard.test.js proves the guard fires.
// Run only these: node --test test/zero-write.test.js
if (!require('./gate').run(__filename)) return;
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');
const M = require('./mubi-fixture');

after(H.cleanup);

async function everything(client) {
  for (const [name, args] of H.VALID_CALLS) await client.callTool({ name, arguments: args });
  for (const [name, args] of [['film_search', { limit: 101 }], ['film_why', { query: 'tt0000007', revision: 'b0ecaa6' }]]) await client.callTool({ name, arguments: args });
  await client.listTools();
}

test('after every tool, a refused call and a source change, the root is byte-identical to what the test left, and the guard saw nothing', async () => {
  const root = H.copyFixture({ research: true }); // with the invented research package: film_research_evidence reads and inflates it for real
  const before = H.listing(root);
  const s = await H.connect({ root });
  await everything(s.client);
  const evidence = await s.client.callTool({ name: 'film_research_evidence', arguments: { ids: ['tt0000007'] } });
  assert.equal(evidence.structuredContent.available, true, 'the package was really read under the guard');
  assert.equal(evidence.structuredContent.results[0].found, true);
  assert.deepEqual(H.listing(root), before, 'the server changed something under the root');
  assert.equal(fs.existsSync(path.join(root, '.context')), false, 'no index file, no private folder');

  // A source changes under a running server: it re-projects in memory and still writes nothing.
  const f = path.join(root, 'cache', 'lists.json');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('Critics Picks', 'Critics Picks 2'));
  const touched = H.listing(root);
  await everything(s.client);
  const health = await s.client.callTool({ name: 'film_health', arguments: {} });
  assert.ok(!health.isError);
  assert.deepEqual(H.listing(root), touched);
  // The research package changes under the running server (a new export): it is inflated again in memory, and nothing is written.
  require('./research-fixture').writePackage(root, { films: [require('./research-fixture').record('tt0000007', 'Suspiria (second export)', 1977)] });
  const afterPackage = H.listing(root);
  const second = await s.client.callTool({ name: 'film_research_evidence', arguments: { ids: ['tt0000007'] } });
  assert.equal(second.structuredContent.results[0].title, 'Suspiria (second export)');
  assert.deepEqual(H.listing(root), afterPackage, 'reloading the package wrote something');
  assert.equal(fs.existsSync(path.join(root, '.context')), false);
  await s.close();
  assert.ok(!s.stderr().includes('GUARD-VIOLATION'), s.stderr());
  assert.ok(s.stderr().includes('"tool":"film_research_evidence"'));
  assert.ok(s.stderr().includes('"tool":"film_search"'), 'the server really ran under the preload and logged its calls');
});

test('the preload is really in the server process: a run with a deliberately broken guard path would not start', async () => {
  // NODE_OPTIONS=--require <missing file> makes node exit before serving; connecting must fail.
  await assert.rejects(() => H.connect({ root: H.FIXTURE, env: { NODE_OPTIONS: `--require ${path.join(H.PKG, 'test', 'no-such-guard.cjs')}` }, guard: false }));
});

// B2 (review 12/10/2026): the fixture had no lists, no directors file and no static list, so the vouched paths (lib/list-signal.js, lib/static-lists.js,
// lib/directors-loved.js) never ran under the guard. They do now: the server reads the three at start, and each films below leaves with cv true.
test('B2 the vouched-by-list, vouched-by-static-list and vouched-by-director paths run in the guarded server, and the guard stays silent', async () => {
  const s = await H.connect({ root: H.FIXTURE });
  const r = await s.client.callTool({ name: 'film_dossier', arguments: { queries: ['tt0000004', 'tt0000005', 'tt0000011'] } });
  assert.ok(!r.isError, r.content?.[0]?.text);
  const [byList, byStatic, byDirector] = r.structuredContent.results.map((x) => x.film);
  assert.deepEqual([byList.cv, byList.cvTrust, byList.cvList], [true, 'critic', 'Critics Picks']);
  assert.deepEqual([byStatic.cv, byStatic.cvTrust, byStatic.cvList], [true, 'critic', 'Static Pick']);
  assert.deepEqual([byDirector.cv, byDirector.cvTrust], [true, 'director']);
  assert.match(byDirector.cvWhy, /^Loved by Auteur/);
  const health = await s.client.callTool({ name: 'film_health', arguments: {} });
  assert.equal(health.structuredContent.vouched, 5, 'Suspiria 1977, Community Only and Seen One (Critics Picks), Suspiria 2018 (Static Pick), Whole Affair (director)');
  await s.close();
  assert.ok(!s.stderr().includes('GUARD-VIOLATION'), s.stderr());
});

// 12/10/2026 (MUBI): the three MUBI fields are read from a private cache; reading it, and reading it again after it changes, writes nothing, opens no connection
// and starts no process. The cache here is inside the root copy, so the recursive listing covers it too.
test('MUBI asking for ourTake, mubiSynopsis and mubiRating writes nothing, and the guard stays silent, also when the cache changes under the running server', async () => {
  const root = H.copyFixture();
  const file = M.writeCache(root, { tt0000007: M.confirmed('community-only'), tt0000016: M.ambiguous() });
  const before = H.listing(root);
  const s = await H.connect({ root });
  const r = await s.client.callTool({ name: 'film_dossier', arguments: { queries: ['tt0000007', 'tt0000016', 'tt0000001'] } });
  assert.ok(!r.isError, r.content?.[0]?.text);
  const [a, b, c] = r.structuredContent.results;
  assert.deepEqual([a.ourTake.state, a.mubiSynopsis.state, a.mubiRating.state], ['available', 'available', 'available'], 'the cache was really read under the guard');
  assert.equal(b.ourTake.reason, 'identity-unconfirmed');
  assert.equal(c.ourTake.reason, 'not-captured');
  await everything(s.client);
  assert.deepEqual(H.listing(root), before, 'reading the cache changed something under the root');

  fs.writeFileSync(file, JSON.stringify(M.cacheOf({ tt0000007: M.confirmed('community-only', { ourTake: { state: 'absent' } }) })));
  M.bump(file);
  const touched = H.listing(root);
  const second = await s.client.callTool({ name: 'film_dossier', arguments: { queries: ['tt0000007'] } });
  assert.equal(second.structuredContent.results[0].ourTake.state, 'absent', 'the cache was read again');
  assert.deepEqual(H.listing(root), touched, 'reloading the cache wrote something');
  await s.close();
  assert.ok(!s.stderr().includes('GUARD-VIOLATION'), s.stderr());
});

test('MUBI compact pages and invalid continuation leave the source bytes unchanged under the write/network guard', async () => {
  const root = H.copyFixture();
  const file = M.writeCache(root, { tt0000007: M.confirmed('compact-invented') });
  const before = H.listing(root);
  const s = await H.connect({ root });
  const input = { queries: Array(50).fill('tt0000007'), view: 'mubi', maxChars: 2000 };
  let cursor, shown = 0, firstCursor;
  do {
    const r = await s.client.callTool({ name: 'film_dossier', arguments: { ...input, ...(cursor ? { cursor } : {}) } });
    assert.ok(!r.isError, r.content[0].text);
    assert.equal(r.structuredContent.results[0].mubi.ourTake.state, 'available');
    assert.ok(r.content[0].text.length <= 2000);
    shown += r.structuredContent.page.shown;
    cursor = r.structuredContent.page.nextCursor;
    firstCursor ||= cursor;
  } while (cursor);
  assert.equal(shown, 50);
  const bad = await s.client.callTool({ name: 'film_dossier', arguments: { ...input, maxChars: 3000, cursor: firstCursor } });
  assert.equal(bad.isError, true);
  assert.deepEqual(H.listing(root), before);
  M.bump(file);
  const changed = H.listing(root);
  const old = await s.client.callTool({ name: 'film_dossier', arguments: { ...input, cursor: firstCursor } });
  assert.equal(old.isError, true);
  const fresh = await s.client.callTool({ name: 'film_dossier', arguments: input });
  assert.ok(!fresh.isError);
  assert.deepEqual(H.listing(root), changed);
  await s.close();
  assert.ok(!s.stderr().includes('GUARD-VIOLATION'), s.stderr());
});
