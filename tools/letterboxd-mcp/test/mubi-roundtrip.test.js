'use strict';
// Collector → MCP, end to end and automatic: the REAL collector (scripts/collect-mubi.py) writes a cache from a scripted fake network (test/mubi-roundtrip.py,
// invented texts, no socket), and the REAL adapter reads it. The edge states each come out as documented in skills/mubi-research/references/cache-contract.md,
// and nothing is discarded. The Python runs in this test process's child, never in the guarded server; the server and the adapter still never run it.
// Run only these: node --test test/mubi-roundtrip.test.js
if (!require('./gate').run(__filename)) return;
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { build } = require('../src/state');
const { createAdapter } = require('../src/adapter');
const M = require('./mubi-fixture');
const H = require('./helpers');

after(H.cleanup);

const DRIVER = path.join(__dirname, 'mubi-roundtrip.py');
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const SKIP = python.error || python.status !== 0 ? 'python3 is not available' : false;

test('the cache the real collector writes is read whole by the MCP, and each edge state comes out as documented', { skip: SKIP }, () => {
  const root = H.copyFixture();
  const out = path.join(root, 'cache');
  const run = spawnSync('python3', ['-B', DRIVER, out], { encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).length, 11);

  const written = JSON.parse(fs.readFileSync(path.join(out, 'mubi.json'), 'utf8')).films;
  assert.equal(written.tt0000004.status, 'ambiguous');
  assert.deepEqual(written.tt0000004.lastError, { at: '2026-10-13T01:00:00.000Z', reason: 'network-error' });
  assert.ok(!('stale' in written.tt0000004), 'an ambiguity with a last error is not a stale confirmation');
  assert.equal(written.tt0000005.rating.average, null, 'the collector wrote average: null');

  const a = createAdapter({ ...build(root, {}), root, snapshots: path.join(H.FIXTURE, 'none') });
  const health = a.call('film_health', {}).mubi;
  assert.deepEqual([health.available, health.records, health.discarded], [true, 11, 0], 'every record the collector wrote validates: none discarded');

  const ask = (id) => a.call('film_dossier', { queries: [id] }).results[0];
  const unknown = (reason) => ({ state: 'unknown', reason });

  const full = ask('tt0000007');
  assert.equal(full.ourTake.state, 'available');
  assert.equal(full.ourTake.text, 'Invented editorial text 1.');
  assert.equal(full.ourTake.language, 'en-US');
  assert.equal(full.ourTake.url, 'https://mubi.com/films/invented-1');
  assert.equal(full.mubiSynopsis.kind, 'short');
  assert.equal(full.mubiSynopsis.text, 'Invented short synopsis 1.');
  assert.deepEqual([full.mubiRating.state, full.mubiRating.outOfTen, full.mubiRating.average, full.mubiRating.votes], ['available', 7.4, 3.7, 1234]);
  assert.deepEqual(full.mubiRating.scales, { outOfTen: 10, average: 5 });

  const absent = ask('tt0000001');
  assert.deepEqual([absent.ourTake.state, absent.mubiSynopsis.state, absent.mubiRating.state], ['absent', 'absent', 'available'], 'null answers are absent; the rating stays');

  assert.deepEqual(ask('tt0000002').mubiSynopsis, unknown('missing'), 'a key that did not come is unknown, with the collector’s reason');
  assert.equal(ask('tt0000002').ourTake.state, 'available');

  const noVotes = ask('tt0000003').mubiRating;
  assert.deepEqual([noVotes.state, noVotes.reason, noVotes.votes, 'outOfTen' in noVotes], ['absent', 'no-votes', 0, false], 'zero votes is absent, not a rating of zero');

  const nullAverage = ask('tt0000005').mubiRating;
  assert.deepEqual([nullAverage.state, nullAverage.outOfTen, nullAverage.average], ['available', 7.4, 'unknown'], 'average: null inside an available rating');

  const badVotes = ask('tt0000006');
  assert.deepEqual(badVotes.mubiRating, unknown('invalid'), 'votes that are not a count make the rating unknown, invalid');
  assert.equal(badVotes.ourTake.state, 'available', 'and nothing else is lost');

  assert.equal(ask('tt0000008').ourTake.text, 'Bold take done.', 'the collector keeps the text as MUBI sent it; the MCP takes the tags and the script out');

  for (const id of ['tt0000004', 'tt0000009', 'tt0000016']) { // ambiguous (with lastError, no stale), not found in search, error
    const r = ask(id);
    for (const f of [r.ourTake, r.mubiSynopsis, r.mubiRating]) assert.deepEqual(f, unknown('identity-unconfirmed'), id);
    assert.ok(!/invented-|Echo|Invented/.test(JSON.stringify([r.ourTake, r.mubiSynopsis, r.mubiRating])), `${id}: no candidate or content leaked`);
  }

  const stale = ask('tt0000011');
  for (const f of [stale.ourTake, stale.mubiSynopsis, stale.mubiRating]) {
    assert.equal(f.stale, true);
    assert.deepEqual(f.lastError, { at: '2026-10-13T01:00:00.000Z', reason: 'network-error' });
    assert.equal(f.state, 'available', 'the kept record is still served');
  }
  assert.ok(M.NEVER.every((m) => !JSON.stringify(a.call('film_dossier', { queries: ['tt0000007', 'tt0000011'] })).includes(m)));
});
