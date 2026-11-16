'use strict';
// The live projection (src/state.js): built in memory, rebuilt in memory when a source changes, never written.
// Run only these: node --test test/state.test.js
if (!require('./gate').run(__filename)) return;
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createState, snapshotsFor } = require('../src/state');
const H = require('./helpers');
const M = require('./mubi-fixture');

after(H.cleanup);

test('a change in a source is seen on the next call, in memory; nothing else on disk moves', () => {
  const root = H.copyFixture();
  const state = createState(root);
  const first = state.current;
  assert.equal(first.adapter.call('film_health', {}).films, 11);
  assert.equal(state.refresh(), first, 'nothing changed: the same projection, no rebuild');

  const tmdbFile = path.join(root, 'cache', 'tmdb.json');
  const tmdb = JSON.parse(fs.readFileSync(tmdbFile, 'utf8'));
  tmdb.movie['20'] = { t: 1760000000000, v: { id: 20, imdb: 'tt0000020', title: 'Late Arrival', year: 2020, runtime: 80, lang: 'en', genres: ['Drama'], keywords: [], directors: [], cast: [], countries: ['US'] } };
  fs.writeFileSync(tmdbFile, JSON.stringify(tmdb));
  const before = H.listing(root);

  const second = state.refresh();
  assert.notEqual(second.signature, first.signature);
  assert.equal(second.adapter.call('film_health', {}).films, 12);
  assert.equal(second.adapter.call('film_dossier', { queries: ['tt0000020'] }).results[0].film.title, 'Late Arrival');
  assert.equal(state.refresh(), second, 'and it settles again');
  assert.deepEqual(H.listing(root), before, 'refreshing wrote nothing');
  assert.equal(fs.existsSync(path.join(root, '.context')), false, 'no index file, no private folder');
});

// M2 (review 12/10/2026): the comment said a failed rebuild "keeps the old answer", the message said "restart the server"; the code does neither —
// it refuses the call, and a restart while the source is still broken would fail at start. The truth, exercised through the tool path.
const BROKEN = /^sources changed and could not be re-read \(SyntaxError\); answers resume when the sources read again — do not restart while they are broken$/;

test('M2 a source that stops parsing refuses the call (no old answer), says not to restart, and answers again by itself once it reads', () => {
  const root = H.copyFixture();
  const state = createState(root);
  const friends = path.join(root, 'cache', 'friends.json');
  const good = fs.readFileSync(friends);
  fs.writeFileSync(friends, '{ not json');
  assert.throws(() => state.refresh(), (e) => BROKEN.test(e.message) && !e.message.includes(root));
  assert.throws(() => state.refresh(), (e) => BROKEN.test(e.message), 'still refused on the next call, not served from the last good projection');
  fs.writeFileSync(friends, good); // fixed under the running state: no restart
  const back = state.refresh();
  assert.equal(back.adapter.call('film_health', {}).films, 11);
  assert.equal(state.refresh(), back, 'and it settles');
});

test('M2 through the server: broken → the tool answers isError with that message, call after call; fixed → the same server answers, never restarted', async () => {
  const root = H.copyFixture();
  const s = await H.connect({ root });
  const friends = path.join(root, 'cache', 'friends.json');
  const good = fs.readFileSync(friends);
  const ok = await s.client.callTool({ name: 'film_health', arguments: {} });
  assert.ok(!ok.isError);
  fs.writeFileSync(friends, '{ not json');
  for (let i = 0; i < 2; i++) {
    const bad = await s.client.callTool({ name: 'film_search', arguments: { limit: 5 } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /sources changed and could not be re-read \(SyntaxError\); answers resume when the sources read again — do not restart while they are broken/);
    assert.ok(!bad.content[0].text.includes(root), 'no path in the refusal');
    assert.equal(bad.structuredContent, undefined, 'no answer built from the old sources');
  }
  fs.writeFileSync(friends, good);
  const back = await s.client.callTool({ name: 'film_health', arguments: {} });
  assert.ok(!back.isError, back.content?.[0]?.text);
  assert.equal(back.structuredContent.films, 11);
  assert.ok(!s.stderr().includes('GUARD-VIOLATION'), s.stderr());
  const lines = s.stderr().trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.ok), [true, false, false, true], 'the log says which calls were refused');
  await s.close();
});

test('the snapshots folder comes from the environment or the root at start, never from a call', () => {
  assert.equal(snapshotsFor('/r', {}), path.join('/r', '.context', 'learning-private', 'snapshots'));
  assert.equal(snapshotsFor('/r', { MOOD_SNAPSHOTS: '/elsewhere/snaps' }), '/elsewhere/snaps');
});

// 12/10/2026 (MUBI): the cache is the third part of the signature. A change only in it reloads it in memory; the films are not re-projected; nothing is written.
test('MUBI a change only in the MUBI cache is seen on the next call, the films are not re-projected, and nothing on disk moves', () => {
  const root = H.copyFixture();
  const file = M.writeCache(root, { tt0000007: M.confirmed('community-only') });
  const state = createState(root, {});
  const first = state.current;
  assert.equal(first.adapter.call('film_dossier', { queries: ['tt0000007'] }).results[0].mubiRating.outOfTen, 7.4);
  assert.equal(state.refresh(), first, 'nothing changed: the same projection, no reload');

  fs.writeFileSync(file, JSON.stringify(M.cacheOf({ tt0000007: M.confirmed('community-only', { rating: { state: 'available', outOfTen: 6.1, average: 3.1, votes: 77 } }) })));
  M.bump(file);
  const before = H.listing(root);
  const second = state.refresh();
  assert.notEqual(second.signature, first.signature, 'the cache is part of the signature every answer reports');
  assert.equal(second.index, first.index);
  assert.equal(second.storeStamp, first.storeStamp);
  assert.equal(second.adapter.call('film_dossier', { queries: ['tt0000007'] }).results[0].mubiRating.outOfTen, 6.1);
  assert.deepEqual(H.listing(root), before, 'reloading wrote nothing');
});

test('MUBI the cache path is fixed when the state is made: an environment that changes later does not move it, not even when the film sources change and everything is rebuilt', () => {
  const root = H.copyFixture();
  const env = {};
  const state = createState(root, env);
  M.writeCache(root, { tt0000007: M.confirmed('community-only') });
  const elsewhere = M.writeCache(H.mkdtemp('mcp-mubi-env-'), { tt0000007: M.confirmed('elsewhere-slug') });
  env.MOOD_MUBI = elsewhere;
  assert.equal(state.refresh().adapter.call('film_dossier', { queries: ['tt0000007'] }).results[0].ourTake.url, 'https://mubi.com/films/community-only');

  // a film source changes too: build() runs again, and it must take the file chosen at start, not read the variable again
  const tmdbFile = path.join(root, 'cache', 'tmdb.json');
  const tmdb = JSON.parse(fs.readFileSync(tmdbFile, 'utf8'));
  tmdb.movie['21'] = { t: 1760000000000, v: { id: 21, imdb: 'tt0000021', title: 'Later Arrival', year: 2021, runtime: 80, lang: 'en', genres: ['Drama'], keywords: [], directors: [], cast: [], countries: ['US'] } };
  fs.writeFileSync(tmdbFile, JSON.stringify(tmdb));
  const rebuilt = state.refresh();
  assert.equal(rebuilt.adapter.call('film_health', {}).films, 12, 'the films were re-projected');
  assert.equal(rebuilt.adapter.call('film_dossier', { queries: ['tt0000007'] }).results[0].ourTake.url, 'https://mubi.com/films/community-only');
  assert.equal(rebuilt.adapter.call('film_health', {}).mubi.where, 'cache/mubi.json');
});
