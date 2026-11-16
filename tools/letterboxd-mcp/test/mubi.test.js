'use strict';
// The three MUBI fields of film_dossier (ourTake, mubiSynopsis, mubiRating; src/mubi.js + src/adapter.js `mubiOf`) over an INVENTED cache
// (test/mubi-fixture.js) written into a copy of the fixture root: the three fields of one film, a field MUBI left empty, a cache that is absent, malformed,
// half-written or too large, an ambiguous film that leaks nothing, one film's record never in another, where the cache is read from, hostile text, the cut at
// 600, the values checked again, and the cache reloading when only it changes. Zero write and zero network under the guard: test/zero-write.test.js.
// Run only these: node --test test/mubi.test.js
if (!require('./gate').run(__filename)) return;
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build, createState } = require('../src/state');
const { createAdapter, DOSSIER_RESULT_KEYS, OUR_TAKE_NOTE, MUBI_SYNOPSIS_NOTE, MUBI_RATING_NOTE } = require('../src/adapter');
const { loadMubi, mubiPathFor, MAX_BYTES } = require('../src/mubi');
const M = require('./mubi-fixture');
const H = require('./helpers');

after(H.cleanup);

const SNAP = path.join(H.FIXTURE, '.context', 'learning-private', 'snapshots');
const FILM = 'tt0000007', OTHER = 'tt0000016', THIRD = 'tt0000001';
function adapterOf(root, env = {}) {
  const b = build(root, env);
  return createAdapter({ ...b, root, snapshots: SNAP });
}
/** A copy of the fixture root with this cache in it; → { root, file, adapter }. */
function rootWith(films, opts) {
  const root = H.copyFixture();
  const file = M.writeCache(root, films, opts);
  return { root, file, adapter: adapterOf(root) };
}
const dossierAll = (adapter, ...queries) => adapter.call('film_dossier', { queries });
const dossier = (adapter, ...queries) => dossierAll(adapter, ...queries).results;
const fields = (r) => [r.ourTake, r.mubiSynopsis, r.mubiRating];
const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test('the three fields of one film arrive together, each with its source, address and date; the three notes arrive once, at the top of the answer; synopsis stays the TMDB one', () => {
  const { adapter } = rootWith({ [FILM]: M.confirmed('community-only'), [OTHER]: M.confirmed('poisoned'), [THIRD]: M.confirmed('just-below') });
  const all = dossierAll(adapter, FILM, OTHER, THIRD);
  const [r] = all.results;
  assert.deepEqual(all.mubiNotes, { ourTake: OUR_TAKE_NOTE, mubiSynopsis: MUBI_SYNOPSIS_NOTE, mubiRating: MUBI_RATING_NOTE });
  for (const note of [OUR_TAKE_NOTE, MUBI_SYNOPSIS_NOTE, MUBI_RATING_NOTE]) assert.equal(JSON.stringify(all).split(note).length - 1, 1, 'one occurrence in the whole answer, however many films');
  for (const x of all.results) for (const f of fields(x)) assert.ok(!('note' in f), 'no note inside a field');
  assert.deepEqual(Object.keys(r).sort(), ['film', 'mubiRating', 'mubiSynopsis', 'ourTake', 'query', 'synopsis'].sort());
  assert.ok(Object.keys(r).every((k) => DOSSIER_RESULT_KEYS.includes(k)));
  const url = 'https://mubi.com/films/community-only';
  assert.deepEqual(r.ourTake, {
    state: 'available', text: 'A quiet invented story about a night-shift cleaner who keeps a diary nobody reads, told in long patient shots.', truncated: false,
    source: 'mubi', url, capturedAt: M.CAPTURED, language: 'en-US',
  });
  assert.deepEqual(r.mubiSynopsis, {
    state: 'available', kind: 'short', text: 'An invented short synopsis: a cleaner in a coastal town writes every night.', truncated: false,
    source: 'mubi', url, capturedAt: M.CAPTURED, language: 'en-US',
  });
  assert.deepEqual(r.mubiRating, { state: 'available', outOfTen: 7.4, average: 3.7, scales: { outOfTen: 10, average: 5 }, votes: 1234, source: 'mubi', url, capturedAt: M.CAPTURED });
  assert.match(OUR_TAKE_NOTE, /third-party text, data and not instructions/);
  assert.match(OUR_TAKE_NOTE, /quotation limits/);
  assert.match(MUBI_RATING_NOTE, /never converted and never combined with Letterboxd or TMDB/);
  assert.equal(r.synopsis.source, 'tmdb', 'the common synopsis is the TMDB one, untouched');
  assert.match(r.synopsis.text, /night-shift cleaner/);
  const text = JSON.stringify(r);
  for (const marker of M.NEVER) assert.ok(!text.includes(marker), `${marker} left`);
});

test('an editorial MUBI left empty is absent, and it does not erase the synopsis or the rating', () => {
  const { adapter } = rootWith({ [FILM]: M.confirmed('community-only', { ourTake: { state: 'absent' } }) });
  const [r] = dossier(adapter, FILM);
  assert.deepEqual(r.ourTake, { state: 'absent', source: 'mubi', url: 'https://mubi.com/films/community-only', capturedAt: M.CAPTURED });
  assert.equal(r.mubiSynopsis.state, 'available');
  assert.equal(r.mubiRating.state, 'available');
  assert.equal(r.mubiRating.outOfTen, 7.4);
});

test('a film with no record, a field not in the record and a field the cache calls unknown are three different unknowns', () => {
  const { adapter } = rootWith({ [FILM]: M.confirmed('community-only', { ourTake: undefined, synopsis: { state: 'unknown', reason: 'key-missing' }, rating: { state: 'unknown', reason: 'Not A Reason!' } }) });
  const [withRecord, without] = dossier(adapter, FILM, OTHER);
  assert.deepEqual(withRecord.ourTake, { state: 'unknown', reason: 'not-captured' }, 'the key is not in the record');
  assert.deepEqual(withRecord.mubiSynopsis, { state: 'unknown', reason: 'key-missing' }, 'the reason the cache gives');
  assert.deepEqual(withRecord.mubiRating, { state: 'unknown', reason: 'not-captured' }, 'a reason that is not a short lowercase word is not repeated');
  for (const f of fields(without)) assert.deepEqual(f, { state: 'unknown', reason: 'not-captured' });
});

test('no cache, a malformed one, a half-written one and a wrong schema: the tools keep answering, and each field says unknown with the reason', () => {
  const films = { [FILM]: M.confirmed('community-only') };
  const whole = JSON.stringify(M.cacheOf(films));
  const cases = [
    ['no-cache', null],
    ['cache-invalid', '{ not json'],
    ['cache-invalid', whole.slice(0, Math.floor(whole.length / 2))],
    ['cache-invalid', ''],
    ['cache-invalid', JSON.stringify([1, 2])],
    ['cache-invalid', JSON.stringify(M.cacheOf(films, { schema: 2 }))],
    ['cache-invalid', JSON.stringify({ schema: 1, films: [] })],
  ];
  for (const [reason, text] of cases) {
    const root = H.copyFixture();
    if (text !== null) M.writeCache(root, null, { text });
    const a = adapterOf(root);
    const [r] = dossier(a, FILM);
    for (const f of fields(r)) assert.deepEqual(f, { state: 'unknown', reason }, `${reason}: ${String(text).slice(0, 20)}`);
    assert.equal(r.film.id, FILM);
    assert.equal(r.synopsis.source, 'tmdb');
    assert.equal(a.call('film_health', {}).films, 11, 'the other tools answer');
    assert.equal(a.call('film_search', { limit: 5 }).total > 0, true);
  }
  const dir = H.copyFixture();
  fs.mkdirSync(path.join(dir, M.DIR, M.FILE), { recursive: true }); // a folder where the file should be
  assert.equal(dossier(adapterOf(dir), FILM)[0].ourTake.reason, 'no-cache');
});

test('a cache over the ceiling is too-large and is not read; the ceiling is a parameter of the loader', () => {
  const root = H.copyFixture();
  const file = M.writeCache(root, { [FILM]: M.confirmed('community-only') });
  const padded = `${JSON.stringify(M.cacheOf({ [FILM]: M.confirmed('community-only') }))}${' '.repeat(MAX_BYTES + 1)}`; // valid JSON, only too big
  fs.writeFileSync(file, padded);
  assert.ok(fs.statSync(file).size > MAX_BYTES);
  const [r] = dossier(adapterOf(root), FILM);
  for (const f of fields(r)) assert.deepEqual(f, { state: 'unknown', reason: 'too-large' });
  assert.deepEqual(loadMubi(file, { maxBytes: MAX_BYTES * 2 }).available, true, 'under a higher ceiling the same file reads');
  M.writeCache(root, { [FILM]: M.confirmed('community-only') });
  assert.deepEqual(loadMubi(file, { maxBytes: 10 }), { available: false, reason: 'too-large', stamp: loadMubi(file).stamp });
  assert.equal(dossier(adapterOf(root), FILM)[0].ourTake.state, 'available', 'and a normal file is read');
});

test('an ambiguous, a not-found-in-search and an errored record say identity-unconfirmed and leak no content, candidate or error detail', () => {
  const { adapter } = rootWith({ [FILM]: M.ambiguous(), [OTHER]: M.notFound(), [THIRD]: M.errored() });
  const results = dossier(adapter, FILM, OTHER, THIRD);
  for (const r of results) {
    for (const f of fields(r)) assert.deepEqual(f, { state: 'unknown', reason: 'identity-unconfirmed' });
    for (const marker of M.NEVER) assert.ok(!JSON.stringify(r).includes(marker), marker);
  }
});

test('a record of one film is never shown for another, and an id the cache keeps for a different film does not follow the title', () => {
  const { adapter } = rootWith({ [FILM]: M.confirmed('community-only', { ourTake: { state: 'available', text: 'ONLY-FOR-COMMUNITY-ONLY' } }), [OTHER]: M.confirmed('poisoned', { rating: { state: 'available', outOfTen: 2.1, average: 1.1, votes: 9 } }) });
  const [a, b, c] = dossier(adapter, FILM, OTHER, THIRD);
  assert.match(a.ourTake.text, /ONLY-FOR-COMMUNITY-ONLY/);
  assert.ok(!JSON.stringify(b).includes('ONLY-FOR-COMMUNITY-ONLY'));
  assert.deepEqual([a.mubiRating.outOfTen, b.mubiRating.outOfTen], [7.4, 2.1]);
  assert.equal(a.mubiRating.url, 'https://mubi.com/films/community-only');
  assert.equal(b.mubiRating.url, 'https://mubi.com/films/poisoned');
  assert.deepEqual(c.ourTake, { state: 'unknown', reason: 'not-captured' });
  // the same film asked by id and by title reaches the same record
  const [byId, byTitle] = dossier(adapter, FILM, 'Community Only 2007');
  assert.deepEqual(byTitle.ourTake, byId.ourTake);
  // candidates (a shared title) carry no MUBI field: nothing was picked
  const [cands] = dossier(adapter, 'Suspiria');
  assert.ok(cands.candidates && !('ourTake' in cands) && !('mubiRating' in cands));
});

test('a record that does not validate is dropped alone: a key that is not an IMDb id, a non-object, an unknown status; the others are served', () => {
  const films = {
    [FILM]: M.confirmed('community-only'),
    'lb:not-an-imdb-id': M.confirmed('x'),
    tt12345x: M.confirmed('x'),
    [OTHER]: 'a string',
    [THIRD]: { status: 'confirmed-ish', ourTake: { state: 'available', text: 'x' } },
    tt0000002: [1],
  };
  const root = H.copyFixture();
  const file = M.writeCache(root, films);
  const m = loadMubi(file);
  assert.equal(m.available, true);
  assert.deepEqual([...m.byId.keys()], [FILM]);
  assert.equal(m.discarded, 5);
  const a = adapterOf(root);
  assert.equal(dossier(a, FILM)[0].ourTake.state, 'available');
  // a record the cache had but that did not validate is not "never collected": the dossier says record-invalid (an id the cache never named is still not-captured)
  for (const id of [OTHER, THIRD, 'tt0000002']) for (const f of fields(dossier(a, id)[0])) assert.deepEqual(f, { state: 'unknown', reason: 'record-invalid' }, id);
  assert.deepEqual(dossier(a, 'tt0000004')[0].ourTake, { state: 'unknown', reason: 'not-captured' });
});

test('where the cache is read from: <root>/cache/mubi.json, or MOOD_MUBI, fixed at start; a cache elsewhere is not read and no tool input redirects it', async () => {
  assert.equal(mubiPathFor('/r', {}), path.join('/r', 'cache', 'mubi.json'));
  assert.equal(mubiPathFor('/r', { MOOD_MUBI: '/elsewhere/m.json' }), '/elsewhere/m.json');
  assert.equal(mubiPathFor('/r', { MOOD_MUBI: 'rel/m.json' }), path.resolve('rel/m.json'), 'absolute from the start');

  const root = H.copyFixture();
  const other = H.mkdtemp('mcp-mubi-other-');
  const elsewhere = M.writeCache(other, { [FILM]: M.confirmed('elsewhere-slug') });
  const inRoot = M.writeCache(root, { [FILM]: M.confirmed('in-root-slug') });

  // through the server: --root X reads X/cache/mubi.json, not the cache next door
  const s = await H.connect({ root });
  const r = await s.client.callTool({ name: 'film_dossier', arguments: { queries: [FILM] } });
  assert.equal(r.structuredContent.results[0].ourTake.url, 'https://mubi.com/films/in-root-slug');
  // no tool input can name the file: strict objects refuse every key, and a path as a query is only a title
  for (const [name, args] of [['film_dossier', { queries: [FILM], mubi: elsewhere }], ['film_dossier', { queries: [FILM], path: elsewhere }], ['film_health', { file: elsewhere }], ['film_search', { cache: elsewhere }]]) {
    assert.equal((await s.client.callTool({ name, arguments: args })).isError, true, `${name} ${Object.keys(args).join()}`);
  }
  const viaQuery = await s.client.callTool({ name: 'film_dossier', arguments: { queries: [elsewhere] } }); // a path as a query is a title to look up, never a file to read
  assert.ok(!JSON.stringify(viaQuery).includes('elsewhere-slug'));
  await s.close();

  // MOOD_MUBI moves it, at start
  const t = await H.connect({ root, env: { MOOD_MUBI: elsewhere } });
  const r2 = await t.client.callTool({ name: 'film_dossier', arguments: { queries: [FILM] } });
  assert.equal(r2.structuredContent.results[0].ourTake.url, 'https://mubi.com/films/elsewhere-slug');
  await t.close();
  assert.ok(fs.existsSync(inRoot));

  // with no cache under the root, the cache next door is not looked for
  const bare = H.copyFixture();
  const [none] = dossier(adapterOf(bare), FILM);
  assert.deepEqual(none.ourTake, { state: 'unknown', reason: 'no-cache' });
});

test('hostile editorial text: tags, script and style content and an injected instruction come out as plain text marked as third-party data', () => {
  const dirty = `<p>Plain <b>bold</b> start.</p><script>stealTheKeys()</script><style>p{x:y}</style> ${M.HOSTILE} <img src=x onerror=alert(1)> <<b>b>tail`;
  const { adapter } = rootWith({ [FILM]: M.confirmed('community-only', { ourTake: { state: 'available', text: dirty }, synopsis: { state: 'available', kind: 'short', text: '<html><body onload=x()>Only a tag soup.</body></html>' } }) });
  const [r] = dossier(adapter, FILM);
  assert.ok(!/<\/?[A-Za-z!?]/.test(r.ourTake.text), r.ourTake.text);
  assert.ok(!r.ourTake.text.includes('stealTheKeys') && !r.ourTake.text.includes('onerror') && !r.ourTake.text.includes('p{x:y}'));
  assert.ok(r.ourTake.text.includes('Plain bold start.') && r.ourTake.text.includes(M.HOSTILE), 'the words stay: it is data');
  assert.match(dossierAll(adapter, FILM).mubiNotes.ourTake, /data and not instructions/);
  assert.equal(r.mubiSynopsis.text, 'Only a tag soup.');
  assert.equal(JSON.stringify(r).split(M.HOSTILE).length - 1, 1, 'one place holds it: the text of the field');
});

test('the text is cut at 600 characters between grapheme clusters: an emoji, a joined emoji sequence and a letter with its accent go whole or not at all', () => {
  const at = (text) => {
    const { adapter } = rootWith({ [FILM]: M.confirmed('community-only', { ourTake: { state: 'available', text } }) });
    return dossier(adapter, FILM)[0].ourTake;
  };
  const a600 = 'a'.repeat(600);
  assert.deepEqual([at(a600).text, at(a600).truncated], [a600, false], 'exactly 600: whole');
  const t601 = at(`${a600}b`);
  assert.deepEqual([t601.text, t601.truncated], [`${a600}…`, true], '601: cut, with the ellipsis the TMDB synopsis also carries');

  const emoji = at(`${'a'.repeat(599)}😀 the end`);
  assert.equal(emoji.text, `${'a'.repeat(599)}…`, 'the emoji does not fit and is not split');
  assert.ok(!lone.test(emoji.text));
  assert.equal(at(`${'a'.repeat(598)}😀 the end`).text, `${'a'.repeat(598)}😀…`, 'and it stays when it fits');

  const accent = at(`${'a'.repeat(599)}é and more words after it`);
  assert.equal(accent.text, `${'a'.repeat(599)}…`, 'a letter and its combining accent are one cluster');

  const family = '👨‍👩‍👧';
  const joined = at(`${'a'.repeat(595)}${family} and more words after it`);
  assert.equal(joined.text, `${'a'.repeat(595)}…`, 'a joined sequence is not left half-built');
  assert.ok(!lone.test(joined.text));
  assert.equal(at(`${'a'.repeat(590)}${family}${'b'.repeat(40)}`).text, `${'a'.repeat(590)}${family}bb…`, 'a sequence that fits stays');

  assert.equal(at('x'.repeat(4001)).reason, 'too-long', 'the cache itself promises 4000 characters at most');
  assert.equal(at('x'.repeat(4000)).truncated, true);
  assert.equal(at('<b></b>').reason, 'invalid', 'nothing left once the tags go');
  assert.equal(at(42).reason, 'invalid', 'not a string');
});

test('the rating is checked again: scale, type, consistency and votes; the original values are kept and never converted', () => {
  const rate = (rating) => {
    const { adapter } = rootWith({ [FILM]: M.confirmed('community-only', { rating }) });
    return dossier(adapter, FILM)[0].mubiRating;
  };
  const ok = rate({ state: 'available', outOfTen: 8.3, average: 4.2, votes: 24103 });
  assert.deepEqual([ok.state, ok.outOfTen, ok.average, ok.scales, ok.votes], ['available', 8.3, 4.2, { outOfTen: 10, average: 5 }, 24103], 'the cache says 4.2 and 8.3: both kept, 4.15 would be a conversion');
  assert.equal(rate({ state: 'available', outOfTen: 10, average: 5, votes: 1 }).state, 'available', 'the top of both scales');
  assert.equal(rate({ state: 'available', outOfTen: 0, average: 0, votes: 3 }).outOfTen, 0, 'zero is a rating');
  assert.equal(rate({ state: 'available', outOfTen: 8.3, average: 4.1, votes: 5 }).state, 'available', '|4.1*2-8.3| = 0.1: inside 0.15');
  assert.equal(rate({ state: 'available', outOfTen: 8.3, votes: 5 }).average, 'unknown', 'one scale only: the other is not computed');
  assert.deepEqual(rate({ state: 'available', outOfTen: 8.3, average: 3.0, votes: 5 }), { state: 'unknown', reason: 'inconsistent' });
  assert.deepEqual(rate({ state: 'available', outOfTen: 8.3, average: 4.0, votes: 5 }), { state: 'unknown', reason: 'inconsistent' }, '|8.0-8.3| = 0.3');
  for (const bad of [
    { state: 'available', outOfTen: 10.1, average: 5, votes: 1 }, { state: 'available', outOfTen: -0.1, votes: 1 }, { state: 'available', outOfTen: 8, average: 5.1, votes: 1 },
    { state: 'available', outOfTen: '8.3', average: 4.2, votes: 1 }, { state: 'available', outOfTen: null, average: 4.2, votes: 1 }, { state: 'available', average: 4.2, votes: 1 },
    { state: 'available', outOfTen: NaN, votes: 1 }, { state: 'available', outOfTen: true, votes: 1 }, { state: 'available', outOfTen: 8.3, average: 4.2, votes: -1 },
    { state: 'available', outOfTen: 8.3, average: 4.2, votes: 2.5 }, { state: 'available', outOfTen: 8.3, average: 4.2, votes: '24103' }, { state: 'maybe' }, 'a string', [],
  ]) assert.deepEqual(rate(bad), { state: 'unknown', reason: 'invalid' }, JSON.stringify(bad));
  assert.equal(rate({ state: 'available', outOfTen: 8.3, average: 4.2 }).votes, 'unknown', 'votes that did not come are unknown, not zero');
  assert.equal(rate({ state: 'available', outOfTen: 8.3, average: 4.2, votes: 'unknown' }).votes, 'unknown');
  // zero, absent and zero votes are three things
  const zero = rate({ state: 'available', outOfTen: 0, average: 0, votes: 12 });
  const absent = rate({ state: 'absent', votes: 0 });
  assert.deepEqual([zero.state, zero.outOfTen], ['available', 0]);
  assert.deepEqual([absent.state, absent.votes, absent.reason, 'outOfTen' in absent], ['absent', 0, 'no-votes', false], 'no rating and no votes is not a rating of zero');
  // zero votes is absent whatever value the cache holds beside it: a rating nobody gave is not a rating (also a zero rating, an out-of-range one, one scale only)
  for (const odd of [{ outOfTen: 8.3, average: 4.2 }, { outOfTen: 0, average: 0 }, { outOfTen: 99, average: 99 }, { outOfTen: 8.3 }, { outOfTen: 8.3, average: 3 }]) {
    const r = rate({ state: 'available', ...odd, votes: 0 });
    assert.deepEqual([r.state, r.votes, r.reason, 'outOfTen' in r, 'average' in r], ['absent', 0, 'no-votes', false, false], JSON.stringify(odd));
  }
  assert.deepEqual(rate({ state: 'unknown', reason: 'key-missing', votes: 0 }), { state: 'unknown', reason: 'key-missing' }, 'the cache’s own unknown is kept');
  assert.equal(rate({ state: 'absent', votes: 5 }).reason, undefined, 'absent with votes is the MUBI answering empty, not "no votes"');
  assert.equal(rate({ state: 'maybe', votes: 0 }).reason, 'invalid');
  assert.equal(rate({ state: 'absent' }).state, 'absent');
  assert.equal('votes' in rate({ state: 'absent' }), false);
  assert.deepEqual(rate({ state: 'absent', votes: -3 }), { state: 'unknown', reason: 'invalid' });
});

test('a stale record (the last refresh failed, the earlier record was kept) says so on each field, with when and why', () => {
  const { adapter } = rootWith({ [FILM]: M.confirmed('community-only', { stale: true, lastError: { at: '2026-10-13T01:00:00.000Z', reason: 'http-429 <b>stop</b>' } }), [OTHER]: M.confirmed('poisoned') });
  const [stale, fresh] = dossier(adapter, FILM, OTHER);
  for (const f of fields(stale)) {
    assert.equal(f.stale, true);
    assert.deepEqual(f.lastError, { at: '2026-10-13T01:00:00.000Z', reason: 'http-429 stop' });
  }
  for (const f of fields(fresh)) assert.ok(!('stale' in f) && !('lastError' in f));
  assert.equal(stale.ourTake.state, 'available', 'the kept content is still served');
});

test('the address is MUBI’s own or unknown: any other URL in the cache is not repeated; a locale that is not a locale is unknown', () => {
  const { adapter } = rootWith({
    [FILM]: M.confirmed('community-only', { mubi: { url: 'https://evil.example/films/x' }, locale: 'en US; DROP' }),
    [OTHER]: M.confirmed('poisoned', { mubi: { url: 'javascript:alert(1)' }, capturedAt: 'yesterday' }),
  });
  const [a, b] = dossier(adapter, FILM, OTHER);
  assert.equal(a.ourTake.url, 'unknown');
  assert.equal(a.ourTake.language, 'unknown');
  assert.equal(a.mubiRating.url, 'unknown');
  assert.deepEqual([b.ourTake.url, b.ourTake.capturedAt], ['unknown', 'unknown']);
  assert.ok(!JSON.stringify([a, b]).includes('evil.example'));
});

test('changing only the cache reloads it on the next call, without re-projecting the films or inflating the research package again', () => {
  const root = H.copyFixture({ research: true });
  const state = createState(root, {});
  const first = state.current;
  assert.equal(first.adapter.call('film_dossier', { queries: [FILM] }).results[0].ourTake.reason, 'no-cache');
  assert.equal(state.refresh(), first, 'nothing changed');

  const file = M.writeCache(root, { [FILM]: M.confirmed('community-only') });
  const second = state.refresh();
  assert.notEqual(second.signature, first.signature);
  assert.equal(second.index, first.index, 'the films were not re-projected');
  assert.equal(second.research, first.research, 'the research package was not read again');
  assert.equal(second.builtAt, first.builtAt);
  assert.equal(second.adapter.call('film_dossier', { queries: [FILM] }).results[0].ourTake.state, 'available');
  assert.equal(state.refresh(), second, 'and it settles');

  fs.writeFileSync(file, JSON.stringify(M.cacheOf({ [FILM]: M.confirmed('community-only', { ourTake: { state: 'available', text: 'A second capture.' } }) })));
  M.bump(file);
  const third = state.refresh();
  assert.equal(third.index, first.index);
  assert.equal(third.adapter.call('film_dossier', { queries: [FILM] }).results[0].ourTake.text, 'A second capture.');

  fs.writeFileSync(file, '{ half a fi'); // half-written under the running state: no refusal, the fields say so
  M.bump(file);
  const broken = state.refresh();
  assert.equal(broken.adapter.call('film_dossier', { queries: [FILM] }).results[0].ourTake.reason, 'cache-invalid');
  assert.equal(broken.adapter.call('film_health', {}).films, 11);

  fs.unlinkSync(file);
  assert.equal(state.refresh().adapter.call('film_dossier', { queries: [FILM] }).results[0].ourTake.reason, 'no-cache');

  // a change in the research package alone keeps the cache as it was read
  M.writeCache(root, { [FILM]: M.confirmed('community-only') });
  const withCache = state.refresh();
  require('./research-fixture').writePackage(root, { films: [require('./research-fixture').record('tt0000007', 'Suspiria (second export)', 1977)] });
  const afterPackage = state.refresh();
  assert.equal(afterPackage.mubi, withCache.mubi, 'the cache was not read again');
  assert.notEqual(afterPackage.research, withCache.research);
});

test('through the server: the description of film_dossier names the three fields and their states, and the optional compact parameters preserve the tools', async () => {
  const s = await H.connect({ root: H.FIXTURE });
  const { tools } = await s.client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['film_health', 'film_dossier', 'film_search', 'film_check', 'film_overlap', 'film_taste', 'film_friends', 'film_why', 'film_research_evidence']);
  const dossierTool = tools.find((t) => t.name === 'film_dossier');
  for (const word of ['ourTake', 'mubiSynopsis', 'mubiRating', 'absent', 'unknown', 'identity-unconfirmed', 'no-cache', 'stale', 'never goes to the network', 'never converted', 'mubiNotes', 'record-invalid', 'no-votes', 'scales', 'at most 15 films']) assert.ok(dossierTool.description.includes(word), word);
  assert.match(tools.find((t) => t.name === 'film_health').description, /`mubi` says how the private MUBI cache was read/);
  assert.deepEqual(Object.keys(dossierTool.inputSchema.properties), ['queries', 'view', 'maxChars', 'cursor']);
  const r = await s.client.callTool({ name: 'film_dossier', arguments: { queries: [FILM] } });
  assert.ok(!r.isError);
  assert.equal(r.structuredContent.results[0].ourTake.reason, 'no-cache', 'the fixture has no cache: unknown, not a refusal');
  await s.close();
});

test('HTML: a "<" before a letter with no ">" after it keeps the text; an unclosed script, style or comment cuts from there on (truncated); upper case does not hide a script', () => {
  const at = (text) => {
    const { adapter } = rootWith({ [FILM]: M.confirmed('community-only', { ourTake: { state: 'available', text } }) });
    return dossier(adapter, FILM)[0].ourTake;
  };
  const kept = at('Love<Hate rules the film');
  assert.deepEqual([kept.text, kept.truncated], ['Love<Hate rules the film', false], 'not a tag: nothing after it is lost');
  assert.equal(at('a < b and c > d').text, 'a < b and c > d');
  for (const [dirty, text] of [
    ['Before <script>evil( and then more words', 'Before…'],
    ['Keep this <STYLE>p{x:y} rest of it', 'Keep this…'],
    ['Open comment <!-- hidden for good', 'Open comment…'],
  ]) { const r = at(dirty); assert.deepEqual([r.text, r.truncated], [text, true], dirty); }
  assert.equal(at('<STYLE>nothing before it').reason, 'invalid', 'nothing left before the cut');
  assert.equal(at('Mixed <SCRIPT type=x>alert(1)</script> and <Style>p{}</STYLE> after').text, 'Mixed and after', 'closed ones go whatever the case');
  assert.equal(at('a <!-- hidden > still hidden --> b').text, 'a b');
  assert.equal(at('<<b>b>tail').text, '< b>tail', 'one pass: a removed tag leaves a space, so what remains cannot join into a new tag');
  assert.ok(!/<\/?[A-Za-z]/.test(at('<scr<b>ipt>x<img src=a onerror=b>y').text));
});

test('the address must be MUBI’s from its first character: a MUBI address after other text is not repeated; a grapheme longer than 600 is cut between code points, not emptied', () => {
  const { adapter } = rootWith({
    [FILM]: M.confirmed('community-only', { mubi: { url: 'javascript:alert(1)//https://mubi.com/films/x' } }),
    [OTHER]: M.confirmed('poisoned', { mubi: { url: 'see https://mubi.com/films/x' }, ourTake: { state: 'available', text: `e${'\u0301'.repeat(700)}` } }),
  });
  const [a, b] = dossier(adapter, FILM, OTHER);
  assert.equal(a.ourTake.url, 'unknown');
  assert.equal(b.ourTake.url, 'unknown');
  assert.equal(b.ourTake.truncated, true);
  assert.equal(b.ourTake.text, `e${'\u0301'.repeat(599)}…`, 'one cluster longer than the limit: cut at the limit, never an empty text');
});

test('film_health says how the MUBI cache was read: available, why not, records, discarded, when, and a masked place', () => {
  const root = H.copyFixture();
  const file = M.writeCache(root, { [FILM]: M.confirmed('community-only'), [OTHER]: 'junk', tt0000002: { status: 'nope' }, 'not-an-id': {} });
  const health = (env) => adapterOf(root, env).call('film_health', {}).mubi;
  assert.deepEqual(health({}), { available: true, records: 1, discarded: 3, updatedAt: M.CAPTURED, where: 'cache/mubi.json' });
  const moved = health({ MOOD_MUBI: file });
  assert.deepEqual(moved, { available: true, records: 1, discarded: 3, updatedAt: M.CAPTURED, where: 'MOOD_MUBI' });
  assert.ok(!JSON.stringify(adapterOf(root, { MOOD_MUBI: file }).call('film_health', {})).includes(file), 'the path never leaves');
  const missing = path.join(H.mkdtemp('mcp-mubi-health-'), 'nope.json');
  assert.deepEqual(health({ MOOD_MUBI: missing }), { available: false, reason: 'no-cache', records: 'unknown', discarded: 'unknown', updatedAt: 'unknown', where: 'MOOD_MUBI' });
  fs.writeFileSync(file, '{ half');
  assert.equal(health({}).reason, 'cache-invalid');
});

test('lastError.reason is cut at 200 characters between code points, text-direction characters are taken out, and lastError.at must look like a date', () => {
  const stale = (lastError, text = 'A plain text.') => {
    const { adapter } = rootWith({ [FILM]: M.confirmed('community-only', { stale: true, lastError, ourTake: { state: 'available', text } }) });
    return dossier(adapter, FILM)[0];
  };
  const at = '2026-10-13T01:00:00.000Z';
  const long = stale({ at, reason: 'r'.repeat(300) }).ourTake.lastError.reason;
  assert.equal(long, 'r'.repeat(200), 'a failure reason is a short reason, not a page');
  const emoji = stale({ at, reason: `${'a'.repeat(199)}😀 and more` }).ourTake.lastError.reason;
  assert.equal(emoji, 'a'.repeat(199), 'the emoji does not fit and is not split');
  assert.ok(!lone.test(emoji));
  assert.equal(stale({ at, reason: 'x'.repeat(200) }).ourTake.lastError.reason, 'x'.repeat(200), 'exactly 200: whole');

  // text-direction and invisible-order characters (right-to-left override, isolates, marks, byte order mark) become spaces; the joiner of an emoji sequence stays
  const bidi = 'x\u202Ey\u2066z\u2069w\u200Fv\u200Eu\uFEFFt';
  assert.equal(stale({ at, reason: bidi }).ourTake.lastError.reason, 'x y z w v u t');
  const r = stale({ at, reason: 'ok' }, `${bidi} 👨‍👩‍👧`);
  assert.equal(r.ourTake.text, 'x y z w v u t 👨‍👩‍👧');
  assert.ok(!/[\u202a-\u202e\u2066-\u2069\u200e\u200f\ufeff]/.test(JSON.stringify(r)));

  for (const badAt of ['yesterday', '2026-10-13', '', 20261013, null, { x: 1 }, '2026-10-13 01:00:00']) {
    assert.equal(stale({ at: badAt, reason: 'network-error' }).ourTake.lastError.at, 'unknown', JSON.stringify(badAt));
  }
  assert.equal(stale({ at: '2026-10-13T01:00:00.000+03:00', reason: 'network-error' }).ourTake.lastError.at, '2026-10-13T01:00:00.000+03:00');
  assert.equal(stale({ at, reason: '<b></b>' }).ourTake.lastError.reason, 'unknown', 'nothing left once the tags go');
  assert.equal(stale({ at, reason: 42 }).ourTake.lastError.reason, 'unknown');
});

test('an available rating whose average is null (the scale-5 answer did not come) stays available with the average unknown, and a null scale-10 does not', () => {
  const rate = (rating) => dossier(rootWith({ [FILM]: M.confirmed('community-only', { rating }) }).adapter, FILM)[0].mubiRating;
  const r = rate({ state: 'available', outOfTen: 7.4, average: null, votes: 12 });
  assert.deepEqual([r.state, r.outOfTen, r.average, r.votes], ['available', 7.4, 'unknown', 12]);
  assert.deepEqual(rate({ state: 'available', outOfTen: null, average: 3.7, votes: 12 }), { state: 'unknown', reason: 'invalid' }, 'the scale-10 value is the one that is required');
});
