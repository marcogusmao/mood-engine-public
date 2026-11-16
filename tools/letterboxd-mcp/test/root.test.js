'use strict';
// The data root: required, resolved at start, must hold config.json. A bad start is an exit code and a line on stderr, not a hang.
// Run only these: node --test test/root.test.js
if (!require('./gate').run(__filename)) return;
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveRoot } = require('../src/server');
const H = require('./helpers');
const M = require('./mubi-fixture');

after(H.cleanup);

const run = (args, env = {}) => spawnSync(process.execPath, [H.SERVER, ...args], { input: '', encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, ...env } });

test('no --root and no MOOD_ENGINE_ROOT: exit 2, a message on stderr, nothing on stdout', () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /a data root is required: --root <dir> or MOOD_ENGINE_ROOT/);
  assert.equal(r.stdout, '');
});

test('a root without config.json: exit 2, and the message names the directory, not the path', () => {
  const dir = H.mkdtemp('mcp-noconfig-');
  const r = run(['--root', dir]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /has no config\.json/);
  assert.ok(!r.stderr.includes(dir), 'no absolute path on stderr');
  assert.equal(r.stdout, '');
});

test('a root that does not exist, or is a file: exit 2', () => {
  assert.equal(run(['--root', path.join(H.mkdtemp('mcp-none-'), 'missing')]).status, 2);
  assert.equal(run(['--root', path.join(H.FIXTURE, 'config.json')]).status, 2);
});

test('a root with a config.json starts, and ends cleanly when the client closes stdin', () => {
  assert.equal(run(['--root', H.FIXTURE]).status, 0);
  assert.equal(run(['--root=' + H.FIXTURE]).status, 0, '--root=<dir> form');
  const env = run([], { MOOD_ENGINE_ROOT: H.FIXTURE });
  assert.equal(env.status, 0, env.stderr);
});

test('resolveRoot: the flag wins over the variable, and the result is absolute', () => {
  assert.equal(resolveRoot(['--root', H.FIXTURE], { MOOD_ENGINE_ROOT: '/nowhere' }), fs.realpathSync(H.FIXTURE));
  const rel = path.relative(process.cwd(), H.FIXTURE);
  assert.ok(path.isAbsolute(resolveRoot(['--root', rel], {})));
});

// 12/10/2026 (MUBI): where the MUBI cache lives is part of the start, and a cache that is missing or broken is not a bad start.
test('MUBI a root with no cache, a broken one, or MOOD_MUBI pointing at nothing starts and ends cleanly, and the stderr names no path', () => {
  const root = H.copyFixture();
  const none = run(['--root', root]);
  assert.equal(none.status, 0, none.stderr);
  M.writeCache(root, null, { text: '{ half a file' });
  const broken = run(['--root', root]);
  assert.equal(broken.status, 0, broken.stderr);
  const missing = path.join(H.mkdtemp('mcp-mubi-none-'), 'mubi.json');
  const moved = run(['--root', root], { MOOD_MUBI: missing });
  assert.equal(moved.status, 0, moved.stderr);
  for (const r of [none, broken, moved]) { assert.equal(r.stdout, ''); assert.ok(!r.stderr.includes(root) && !r.stderr.includes(missing)); }
});

test('MUBI --root X reads X/cache/mubi.json (through the server), and a root without that file does not borrow the one of another root', async () => {
  const withCache = H.copyFixture(), without = H.copyFixture();
  M.writeCache(withCache, { tt0000007: M.confirmed('community-only') });
  const a = await H.connect({ root: withCache }), b = await H.connect({ root: without });
  const ask = async (s) => (await s.client.callTool({ name: 'film_dossier', arguments: { queries: ['tt0000007'] } })).structuredContent.results[0].ourTake;
  assert.equal((await ask(a)).state, 'available');
  assert.deepEqual(await ask(b), { state: 'unknown', reason: 'no-cache' });
  await a.close(); await b.close();
});
