'use strict';
// film_research_evidence (src/research.js) over an INVENTED package (test/research-fixture.js) written into a copy of the fixture root:
// found / not found / package absent or broken, the allowlist at every level, the cuts, `applied` always false, refusals, and the package
// reloading when its files change. Zero write and zero network under the guard: test/zero-write.test.js. Hostile text: test/injection.test.js.
// Run only these: node --test test/research.test.js
if (!require('./gate').run(__filename)) return;
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build, createState } = require('../src/state');
const { createAdapter, InputError } = require('../src/adapter');
const R = require('../src/research');
const S = require('../src/schemas');
const F = require('./research-fixture');
const H = require('./helpers');

after(H.cleanup);

const SNAP = path.join(H.FIXTURE, '.context', 'learning-private', 'snapshots');
function adapterOf(root) {
  const b = build(root);
  return createAdapter({ ...b, root, snapshots: SNAP });
}
const withPackage = (parts) => { const root = H.copyFixture(); F.writePackage(root, parts); return root; };
// The tool takes at most S.MAX_RESEARCH_IDS ids per call: longer lists are asked in calls of that size and the results joined.
const ask = (adapter, ids) => {
  const parts = [];
  for (let i = 0; i < ids.length; i += S.MAX_RESEARCH_IDS) parts.push(adapter.call('film_research_evidence', { ids: ids.slice(i, i + S.MAX_RESEARCH_IDS) }));
  if (parts.length === 1 || parts[0].available === false) return parts[0];
  return { ...parts[0], count: parts.reduce((n, p) => n + p.count, 0), results: parts.flatMap((p) => p.results) };
};

test('found: the record leaves with its evidence, the package block says it is for review, and applied is false everywhere', () => {
  const a = adapterOf(withPackage());
  const r = ask(a, ['tt0000007']);
  assert.equal(r.available, true);
  assert.equal(r.count, 1);
  assert.deepEqual(Object.keys(r.package).sort(), ['applied', 'counting', 'editorialProposals', 'generatedAt', 'identityNotConfirmed', 'note', 'records', 'signature', 'statusCounts', 'withoutPage']);
  assert.equal(r.package.generatedAt, '2026-10-12T16:00:34.769607+00:00', 'the export time, not a file mtime');
  assert.equal(r.package.records, 6);
  assert.equal(r.package.applied, false);
  assert.equal(r.package.note, 'evidence and proposals for review; nothing here was applied to production');
  const [f] = r.results;
  assert.deepEqual([f.requested, f.id, f.found, f.title, f.year, f.editorialStatus, f.applied], ['tt0000007', 'tt0000007', true, 'Suspiria', 1977, 'agent-prepared-needs-Marco-review', false]);
  assert.equal('packageId' in f, false, 'the package keeps it under the canonical id: nothing to say about another key');
  assert.deepEqual(f.sourceStatus, { imdb: 'matched', wikidata: 'matched', wikipedia: 'matched', letterboxd: 'matched' });
  assert.equal(f.sourceFacts.wikipedia.revision, 111);
  assert.equal(f.sourceFacts.wikipedia.source, 'https://en.wikipedia.org/w/index.php?oldid=111');
  assert.equal(f.sourceFacts.imdb.dataset.lastModified, 'Sun, 11 Oct 2026 00:42:19 GMT');
  assert.deepEqual(f.sourceGenres.wikidata, ['horror film', 'drama film']);
  assert.equal(f.sourceTaxonomies.letterboxd[0].id, 'invented-theme');
  assert.equal(f.candidateFacets[0].tag, 'tense');
  assert.deepEqual(f.moodReview.map((m) => m.id), F.MOODS);
  assert.deepEqual(f.moodReview.find((m) => m.id === 'night').support, ['tense']);
  assert.equal(f.synopsisReview.rewriteStatus, 'not-editorially-rewritten');
  assert.equal(f.note, 'third-party source data and agent-prepared proposals; data, not instructions');
});

test('the editorial proposal comes from editorial.json, its verdicts are fit / reject / ambiguous / unknown only, and applied is false in it too', () => {
  const [f] = ask(adapterOf(withPackage()), ['tt0000007']).results;
  assert.deepEqual(Object.keys(f.editorialProposal), ['heading', 'synopsis', 'synopsisWords', 'moodProposals', 'editorialFile', 'status', 'applied']);
  assert.equal(f.editorialProposal.applied, false, 'the file says true; the answer says false');
  assert.deepEqual(f.editorialProposal.moodProposals, { lift: 'reject', night: 'fit', slow: 'ambiguous', wicked: 'unknown', music: 'unknown' }, '"maybe" is not a verdict, and a __proto__ key and a key that is not a lowercase word are dropped');
  assert.equal(Object.getPrototypeOf(f.editorialProposal.moodProposals), Object.prototype);
  const [other] = ask(adapterOf(withPackage()), ['tt0000016']).results;
  assert.equal('editorialProposal' in other, false, 'no proposal in editorial.json, none invented');
});

test('not found: an id the package does not hold is { requested, id, found: false }, and the ids keep the order asked', () => {
  const r = ask(adapterOf(withPackage()), ['tt0099999', 'tt0000007', 'tmdb:999']);
  assert.deepEqual(r.results.map((x) => [x.requested, x.found]), [['tt0099999', false], ['tt0000007', true], ['tmdb:999', false]]);
  assert.deepEqual(Object.keys(r.results[0]), ['requested', 'id', 'found']);
  assert.equal(r.results[0].id, 'tt0099999', 'the projection does not know it either: the id is the one asked');
});

test('lb:<slug> and tmdb:<id> of a film the projection does not know reach the records the package keeps as letterboxd:<slug> and tmdb:<id>', () => {
  const r = ask(adapterOf(withPackage()), ['lb:some-slug', 'tmdb:12345']);
  assert.deepEqual(r.results.map((x) => [x.requested, x.id, x.found, x.title]), [['lb:some-slug', 'lb:some-slug', true, 'Slug Only'], ['tmdb:12345', 'tmdb:12345', true, 'Tmdb Only']]);
  assert.deepEqual(r.results.map((x) => x.packageId), ['letterboxd:some-slug', undefined], 'lb: is written letterboxd: in the package; tmdb: is the same key');
  assert.equal(r.results[0].year, 'unknown', 'a null year is the word unknown, as in the other tools');
});

// 12/10/2026 (review finding 2): tmdb:603 and lb:the-matrix gave found:false while the package keeps The Matrix as tt0133093 and film_check resolves the same ids.
// The asked id now goes through the projection's own resolution (Qy.resolve) first, then the package is searched by the canonical id and by its alternative keys.
const idPackage = () => withPackage({ films: [
  F.record('tt0000007', 'Suspiria', 1977),
  F.record('letterboxd:seen-one', 'Stored by slug', 2008),
  F.record('tmdb:9', 'Stored by tmdb id', 2009),
  F.record('letterboxd:whole-affair', 'Twin under the slug', 2011),
  F.record('tmdb:11', 'Twin under the tmdb id', 2011),
] });

test('tmdb:<id> and lb:<slug> reach the film the package keeps under its canonical tt id; the answer names what was asked and the canonical id', () => {
  const r = ask(adapterOf(idPackage()), ['tmdb:7', 'lb:community-only', 'tt0000007']);
  assert.deepEqual(r.results.map((x) => [x.requested, x.id, x.found, x.title]), [['tmdb:7', 'tt0000007', true, 'Suspiria'], ['lb:community-only', 'tt0000007', true, 'Suspiria'], ['tt0000007', 'tt0000007', true, 'Suspiria']]);
  for (const x of r.results) assert.equal('packageId' in x, false);
  assert.equal(r.results[0].editorialProposal.status, 'prepared-for-Marco-review', 'the proposal follows the record, not the way it was asked');
});

test('a film the package keeps under letterboxd:<slug> or tmdb:<id> is found by its canonical id, tmdb and slug, and packageId says which key held it', () => {
  const r = ask(adapterOf(idPackage()), ['tt0000008', 'tmdb:8', 'lb:seen-one', 'tt0000009', 'lb:no-average', 'tmdb:9']);
  assert.deepEqual(r.results.map((x) => [x.requested, x.id, x.found, x.title, x.packageId]), [
    ['tt0000008', 'tt0000008', true, 'Stored by slug', 'letterboxd:seen-one'],
    ['tmdb:8', 'tt0000008', true, 'Stored by slug', 'letterboxd:seen-one'],
    ['lb:seen-one', 'tt0000008', true, 'Stored by slug', 'letterboxd:seen-one'],
    ['tt0000009', 'tt0000009', true, 'Stored by tmdb id', 'tmdb:9'],
    ['lb:no-average', 'tt0000009', true, 'Stored by tmdb id', 'tmdb:9'],
    ['tmdb:9', 'tt0000009', true, 'Stored by tmdb id', 'tmdb:9'],
  ]);
});

test('a film the projection knows but the package lacks is { requested, id: canonical, found: false }; one the package holds under two alternative keys is candidates, never a pick', () => {
  const r = ask(adapterOf(idPackage()), ['tmdb:2', 'tt0000011', 'lb:whole-affair']);
  assert.deepEqual(r.results[0], { requested: 'tmdb:2', id: 'tt0000002', found: false });
  for (const x of r.results.slice(1)) {
    assert.deepEqual(Object.keys(x), ['requested', 'found', 'candidates'], 'no id, no evidence: the caller asks again with one of the candidates');
    assert.equal(x.found, false);
    assert.deepEqual(x.candidates.map((c) => c.id).sort(), ['letterboxd:whole-affair', 'tmdb:11']);
  }
});

test('an id the projection resolves to several films (a tmdb id shared by two records) is candidates and no evidence, whichever record the package holds', () => {
  const loaded = R.loadResearch(idPackage());
  const twins = [{ id: 'tt0000008', title: 'First', year: 2008 }, { id: 'tt0000009', title: 'Second', year: 2009 }];
  assert.deepEqual(R.lookup(loaded, 'tmdb:99', () => ({ candidates: twins })), { requested: 'tmdb:99', found: false, candidates: [
    { id: 'tt0000008', title: 'First', year: 2008 }, { id: 'tt0000009', title: 'Second', year: 2009 }] });
  assert.equal(R.lookup(loaded, 'tt0000007', () => ({ film: { id: 'tt0000007', slugs: [] } })).found, true, 'the resolver decides first; one film is evidence');
});

test('candidates are a short list of short text: at most 10, each id and title cut at 200 characters, a year that is not a number is "unknown"', () => {
  const loaded = R.loadResearch(idPackage());
  const crowd = Array.from({ length: 25 }, (_, i) => ({ id: i === 1 ? `tt${'9'.repeat(500)}` : `tt${7000000 + i}`, title: i === 0 ? 'x'.repeat(5000) : `Twin ${i}`, year: i === 0 ? 'not a year' : 2000 }));
  const r = R.lookup(loaded, 'tmdb:99', () => ({ candidates: crowd }));
  assert.equal(r.candidates.length, 10);
  assert.equal(r.candidates[0].title.length, R.MAX_TITLE + 1);
  assert.equal(r.candidates[0].year, 'unknown');
  assert.equal(r.candidates[1].id.length, R.MAX_TITLE + 1, 'the id is cut too');
});

// 12/10/2026 (review finding 1): withoutPage applied Letterboxd's list (pending, invalid-slug, not-added) to the four sources and read 0 / 0 / 0 on the
// real package, where statusCounts showed 1,702 without a Wikipedia article read, 874 without Wikidata and 65 without IMDb. Numbers below counted by hand.
const rec = (id, imdb, wikidata, wikipedia, letterboxd) => F.record(id, `Film ${id}`, 2000, { sourceStatus: { imdb, wikidata, wikipedia, letterboxd } });
const COUNT_RECORDS = [
  rec('tt0000201', 'matched', 'matched', 'matched', 'matched'),
  rec('tt0000202', 'matched', 'matched', 'matched', 'identity-not-confirmed'),
  rec('tt0000203', 'not-in-dataset', 'not-found', 'wikidata-not-found', 'pending'),
  rec('tt0000204', 'no-source-identity', 'no-source-identity', 'no-source-identity', 'invalid-slug'),
  rec('tt0000205', 'matched', 'ambiguous', 'wikidata-ambiguous', 'not-added'),
  rec('tt0000206', 'matched', 'matched', 'no-en-or-pt-article', 'matched'),
  rec('tt0000207', 'matched', 'matched', 'identity-not-confirmed', 'matched'),
  F.record('tt0000208', 'No status', 2000, { sourceStatus: {} }),
];

test('withoutPage and identityNotConfirmed are counted per source from its own statuses: not matched and not refused = no page read; refused = identity not confirmed', () => {
  const r = ask(adapterOf(withPackage({ films: COUNT_RECORDS })), ['tt0000201']);
  assert.equal(r.package.records, 8);
  // imdb: 5 matched; not-in-dataset, no-source-identity and no status = 3
  // wikidata: 4 matched; not-found, no-source-identity, ambiguous and no status = 4
  // wikipedia: 2 matched, 1 refused; wikidata-not-found, no-source-identity, wikidata-ambiguous, no-en-or-pt-article and no status = 5
  // letterboxd: 3 matched, 1 refused; pending, invalid-slug, not-added and no status = 4
  assert.deepEqual(r.package.withoutPage, { imdb: 3, wikidata: 4, wikipedia: 5, letterboxd: 4 });
  assert.deepEqual(r.package.identityNotConfirmed, { imdb: 0, wikidata: 0, wikipedia: 1, letterboxd: 1 });
  for (const s of ['imdb', 'wikidata', 'wikipedia', 'letterboxd']) {
    assert.equal(r.package.statusCounts[s].matched + r.package.withoutPage[s] + r.package.identityNotConfirmed[s], 8, `${s}: every record is matched, refused or without a page`);
  }
  assert.equal(r.package.statusCounts.wikipedia['identity-not-confirmed'], 1);
  assert.equal(r.package.pending, undefined, 'never named pending: the collector ledger defines that, not the package');
  assert.match(r.package.counting, /withoutPage = records whose status is neither matched nor identity-not-confirmed/);
  assert.match(r.package.counting, /identityNotConfirmed = records whose status is identity-not-confirmed/);
});

test('the package block of the default fixture: the Letterboxd states (pending, invalid-slug, not-added) and the no-identity records of the other sources', () => {
  const r = ask(adapterOf(withPackage()), ['tt0000007']);
  assert.deepEqual(r.package.withoutPage, { imdb: 2, wikidata: 2, wikipedia: 2, letterboxd: 3 }, 'two records have no source identity; three have no Letterboxd page');
  assert.deepEqual(r.package.identityNotConfirmed, { imdb: 0, wikidata: 0, wikipedia: 0, letterboxd: 0 });
  assert.deepEqual(r.package.statusCounts.letterboxd, { matched: 3, pending: 1, 'invalid-slug': 1, 'not-added': 1 });
  assert.equal(r.package.editorialProposals, 1);
});

test('"matched" and "identity-not-confirmed" are counted even when 30 other statuses came first and the table spilled into "other"', () => {
  const many = Array.from({ length: 35 }, (_, i) => F.record(`tt${6000000 + i}`, `Film ${i}`, 2000, { sourceStatus: { letterboxd: `status-${i}` } }));
  const last = [rec('tt0000301', 'matched', 'matched', 'matched', 'matched'), rec('tt0000302', 'matched', 'matched', 'matched', 'identity-not-confirmed')];
  const r = ask(adapterOf(withPackage({ films: [...many, ...last] })), ['tt0000301']);
  assert.equal(r.package.statusCounts.letterboxd.other, 7, 'the table itself spilled: 30 distinct statuses, then the bucket');
  assert.equal(r.package.statusCounts.letterboxd.matched, undefined, 'matched came after the table was full and went to "other"');
  assert.equal(r.package.withoutPage.letterboxd, 35);
  assert.equal(r.package.identityNotConfirmed.letterboxd, 1);
});

test('package absent: { available: false, reason } with no path, and the other tools still answer', () => {
  const a = adapterOf(H.copyFixture());
  const r = ask(a, ['tt0000007']);
  assert.deepEqual(Object.keys(r).sort(), ['available', 'reason', 'source']);
  assert.equal(r.available, false);
  assert.match(r.reason, /^research package not found \(research\/2026-10-12-film-research\/films\.jsonl\.gz\)$/);
  assert.equal(a.call('film_health', {}).films, 11);
});

test('package broken (not gzip, or no readable record): available false with a reason that carries no path; the other tools still answer', () => {
  for (const [films, reason] of [[Buffer.from('this is not gzip'), /could not be read \(Z_DATA_ERROR\)/], [[], /no readable records/]]) {
    const root = withPackage({ films });
    const a = adapterOf(root);
    const r = ask(a, ['tt0000007']);
    assert.equal(r.available, false);
    assert.match(r.reason, reason);
    assert.ok(!r.reason.includes(root));
    assert.equal(a.call('film_health', {}).films, 11);
  }
});

// 12/10/2026 (review finding 4): the ceilings documented in the README (64 MB of gzip, 256 MB inflated) had no test; they are parameters of loadResearch now.
test('the documented ceilings are the defaults: 64 MB of gzip, 256 MB inflated, 8 MB for each JSON file', () => {
  assert.deepEqual(R.DEFAULT_LIMITS, { maxGzBytes: 64 * 1024 * 1024, maxUnzippedBytes: 256 * 1024 * 1024, maxJsonBytes: 8 * 1024 * 1024 });
  assert.equal(R.loadResearch(withPackage()).available, true, 'and the invented package is far below them');
});

test('a package over a ceiling is refused as { available: false, reason } with no path: a gzip over maxGzBytes, a package that inflates past maxUnzippedBytes', () => {
  const root = withPackage();
  const gzBytes = fs.statSync(path.join(root, F.DIR, 'films.jsonl.gz')).size;
  const inflated = require('node:zlib').gunzipSync(fs.readFileSync(path.join(root, F.DIR, 'films.jsonl.gz'))).length;
  assert.ok(gzBytes > 100 && inflated > 1000, 'the fixture is bigger than the tiny ceilings below');
  const tooBig = R.loadResearch(root, { maxGzBytes: gzBytes - 1 });
  assert.equal(tooBig.available, false);
  assert.match(tooBig.reason, /^research package could not be read \(ETOOBIG\)$/);
  const inflates = R.loadResearch(root, { maxUnzippedBytes: inflated - 1 });
  assert.equal(inflates.available, false);
  assert.match(inflates.reason, /^research package could not be read \(ERR_BUFFER_TOO_LARGE\)$/);
  for (const r of [tooBig, inflates]) assert.ok(!r.reason.includes(root));
  assert.equal(R.loadResearch(root, { maxGzBytes: gzBytes, maxUnzippedBytes: inflated }).available, true, 'exactly at the ceiling is allowed');
});

test('editorial.json and coverage.json over maxJsonBytes are not read: the evidence is served, proposals and the export time are "unknown"', () => {
  const root = withPackage();
  const r = R.loadResearch(root, { maxJsonBytes: 10 });
  assert.equal(r.available, true);
  assert.equal(r.meta.editorialProposals, 'unknown');
  assert.equal(r.meta.generatedAt, 'unknown');
  assert.equal(r.proposals.size, 0);
});

test('editorial.json missing or unreadable: the evidence is still served, proposals are reported as unknown rather than as none', () => {
  const root = withPackage();
  fs.writeFileSync(path.join(root, F.DIR, 'editorial.json'), '{ not json');
  const r = ask(adapterOf(root), ['tt0000007']);
  assert.equal(r.available, true);
  assert.equal(r.package.editorialProposals, 'unknown');
  assert.equal('editorialProposal' in r.results[0], false);
});

test('a line that does not parse, or has no id, is skipped; the rest of the package stays readable', () => {
  const root = withPackage({ films: Buffer.from(require('node:zlib').gzipSync(`not json\n{"title":"no id"}\n\n${JSON.stringify(F.record('tt0000007', 'Suspiria', 1977))}\n`)) });
  const r = ask(adapterOf(root), ['tt0000007']);
  assert.equal(r.available, true);
  assert.equal(r.package.records, 1);
  assert.equal(r.results[0].found, true);
});

// --- the allowlist ---
const keysOf = (o) => Object.keys(o).sort();

test('allowlist: nothing outside the lists leaves — no hash, etag, private note, unknown source, extra key, full text; at every level', () => {
  const r = ask(adapterOf(withPackage()), ['tt0000007', 'tt0000016', 'lb:some-slug', 'tmdb:12345', 'tt0000100', 'tt0000101']);
  const text = JSON.stringify(r);
  for (const marker of F.NEVER) assert.ok(!text.includes(marker), `${marker} came out`);
  assert.ok(!/sha256|etag|"foo"|privateNote|fullText|filmSource|"quote"|internalNote|"fr"/.test(text), 'a key outside the allowlist came out');
  const [f] = r.results;
  assert.deepEqual(keysOf(f), ['applied', 'candidateFacets', 'editorialProposal', 'editorialStatus', 'found', 'id', 'issues', 'moodReview', 'note', 'requested', 'sourceFacts', 'sourceGenres', 'sourceStatus', 'sourceTaxonomies', 'synopsisReview', 'title', 'year']);
  assert.deepEqual(keysOf(f.sourceStatus), ['imdb', 'letterboxd', 'wikidata', 'wikipedia']);
  assert.deepEqual(keysOf(f.sourceFacts), ['imdb', 'letterboxd', 'tmdb', 'wikidata', 'wikipedia']);
  assert.deepEqual(keysOf(f.sourceFacts.tmdb), ['cachedAt', 'timestampStatus', 'url', 'year']);
  assert.deepEqual(keysOf(f.sourceFacts.imdb), ['dataset', 'type', 'url', 'year']);
  assert.deepEqual(keysOf(f.sourceFacts.imdb.dataset), ['lastModified', 'retrievedAt', 'url']);
  assert.deepEqual(keysOf(f.sourceFacts.wikidata), ['articles', 'qid', 'retrievedAt']);
  assert.deepEqual(keysOf(f.sourceFacts.wikidata.articles), ['en', 'pt'], 'the invented fr article is dropped');
  assert.deepEqual(keysOf(f.sourceFacts.wikipedia), ['lang', 'retrievedAt', 'revision', 'source', 'title']);
  assert.deepEqual(keysOf(f.sourceFacts.letterboxd), ['retrievedAt', 'source']);
  assert.deepEqual(keysOf(f.sourceGenres), ['imdb', 'letterboxd', 'tmdb', 'wikidata']);
  assert.deepEqual(keysOf(f.sourceTaxonomies.letterboxd[0]), ['id', 'kind', 'url']);
  assert.deepEqual(keysOf(f.candidateFacets[0]), ['dimension', 'evidence', 'status', 'tag']);
  assert.deepEqual(keysOf(f.candidateFacets[0].evidence[0]), ['source', 'url']);
  assert.deepEqual(keysOf(f.moodReview[0]), ['counterEvidence', 'id', 'status', 'support']);
  assert.deepEqual(keysOf(f.synopsisReview), ['alternativePreview', 'alternativeSource', 'currentExists', 'currentPreview', 'currentSource', 'previewsAreExcerptsNotRewrites', 'requiresSpoilerReview', 'rewriteStatus', 'sourceAlternativeExists', 'wikipediaIsPremise']);
});

test('allowlist at the top: the exported key lists are the whole truth, and a value of the wrong type is dropped rather than passed through', () => {
  const root = withPackage({ films: [F.record('tt0000007', 'Suspiria', 1977, {
    sourceFacts: { imdb: { year: '1977', url: { nested: 'object' }, type: 7, dataset: 'not an object' }, wikipedia: { revision: Infinity, title: ['array'] } },
    sourceGenres: { wikidata: ['ok', 5, null, { a: 1 }] }, issues: 'not an array', moodReview: [{ id: 'night', support: 'tense' }],
  })] });
  const [f] = ask(adapterOf(root), ['tt0000007']).results;
  assert.deepEqual(f.sourceFacts, { imdb: {}, wikipedia: {} });
  assert.deepEqual(f.sourceGenres, { wikidata: ['ok'] });
  assert.equal('issues' in f, false);
  assert.deepEqual(f.moodReview, [{ id: 'night' }], 'a string where a list belongs is dropped');
});

// --- the cuts ---
test('cuts: a preview is at most 18 words, a title and every text field have a ceiling cut between code points, lists have a ceiling', () => {
  const [long] = ask(adapterOf(withPackage()), ['tt0000100']).results;
  assert.equal(R.MAX_PREVIEW_WORDS, 18);
  assert.equal(long.synopsisReview.currentPreview, `${F.WORDS_30.split(' ').slice(0, 18).join(' ')}…`);
  assert.equal(long.synopsisReview.currentPreview.replace('…', '').split(' ').length, 18);
  assert.equal(long.title.length, R.MAX_TITLE + 1, 'the title is cut at 200 and ends in an ellipsis');
  assert.ok(long.title.endsWith('…'));
  const alt = long.synopsisReview.alternativePreview;
  assert.ok(alt.endsWith('…'));
  assert.equal(alt, `${'é'.repeat(199)}…`, 'the emoji that would straddle the 200 ceiling goes whole or not at all: here, not at all');
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(alt), 'no lone surrogate');
  assert.equal(long.sourceGenres.wikidata.length, 30);
  assert.equal(long.issues.length, 30);
});

test('a short preview and a short title are not touched (the cut is a ceiling, not a rewrite)', () => {
  const [f] = ask(adapterOf(withPackage()), ['tt0000007']).results;
  assert.equal(f.synopsisReview.currentPreview, 'An American newcomer to a prestigious German ballet academy comes to realize that the school is a front');
  assert.equal(f.title, 'Suspiria');
});

// --- applied is never read from a file ---
test('applied is false in the answer, in the package block and in the proposal, whatever the files say', () => {
  const root = withPackage({ films: F.records().map((r) => ({ ...r, applied: true })), coverage: { generatedAt: '2026-10-12T16:00:34Z', applied: true } });
  const r = ask(adapterOf(root), ['tt0000007', 'tt0000016']);
  assert.equal(r.package.applied, false);
  for (const f of r.results) assert.equal(f.applied, false);
  assert.equal(r.results[0].editorialProposal.applied, false);
});

// --- refusals ---
test('refusals: an id outside the pattern, an empty list, more than 5 ids and an extra key are refused with a message that names the tool and not the value', () => {
  const a = adapterOf(withPackage());
  const long = Array.from({ length: 6 }, (_, i) => `tt${1000000 + i}`);
  for (const input of [{ ids: Array.from({ length: 50 }, (_, i) => `tt${1000000 + i}`) }, { ids: ['../etc/passwd'] }, { ids: ['TT0000007'] }, { ids: ['tt1', 'letterboxd:slug'] }, { ids: [] }, { ids: long }, { ids: ['tt0000007'], limit: 5 }, {}, { ids: 'tt0000007' }]) {
    assert.throws(() => a.call('film_research_evidence', input), (e) => e instanceof InputError && /^film_research_evidence:/.test(e.message) && !e.message.includes('passwd'), JSON.stringify(input).slice(0, 60));
  }
  assert.equal(a.call('film_research_evidence', { ids: long.slice(0, 5) }).count, 5, 'exactly 5 is allowed');
  assert.equal(S.MAX_RESEARCH_IDS, 5);
  assert.equal(S.MAX_BATCH, 50, 'the other batch tools keep 50');
});

// --- the package follows its files ---
test('a change in the package files is seen on the next call, without re-projecting the films; nothing on disk moves', () => {
  const root = H.copyFixture();
  const state = createState(root);
  const first = state.current;
  assert.equal(first.adapter.call('film_research_evidence', { ids: ['tt0000007'] }).available, false);

  F.writePackage(root);
  const second = state.refresh();
  assert.notEqual(second.signature, first.signature, 'the package is part of the signature every answer reports');
  assert.equal(second.index, first.index, 'only the package moved: the same projection of the films');
  assert.equal(second.adapter.call('film_research_evidence', { ids: ['tt0000007'] }).results[0].title, 'Suspiria');
  assert.equal(state.refresh(), second, 'and it settles');

  const edited = F.records();
  edited[0].title = 'Suspiria (edited)';
  F.writePackage(root, { films: edited });
  const third = state.refresh();
  assert.equal(third.adapter.call('film_research_evidence', { ids: ['tt0000007'] }).results[0].title, 'Suspiria (edited)');
  assert.equal(third.index, first.index);
  fs.rmSync(path.join(root, F.DIR), { recursive: true });
  assert.equal(state.refresh().adapter.call('film_research_evidence', { ids: ['tt0000007'] }).available, false, 'the package is gone: it says so');
  assert.equal(fs.existsSync(path.join(root, '.context')), false);
});

test('a broken package never refuses the other tools: film_search keeps answering through the state', () => {
  const root = withPackage();
  const state = createState(root);
  fs.writeFileSync(path.join(root, F.DIR, 'films.jsonl.gz'), 'garbage');
  const now = state.refresh();
  assert.equal(now.adapter.call('film_research_evidence', { ids: ['tt0000007'] }).available, false);
  assert.equal(now.adapter.call('film_search', { limit: 3 }).shown, 3);
});

test('the loader on its own: researchSignature moves with each of the three files, and the real files are only read', () => {
  const root = withPackage();
  const s0 = R.researchSignature(root);
  assert.match(s0, /^[0-9a-f]{16}$/);
  for (const file of Object.values(R.FILES)) {
    const p = path.join(root, R.PACKAGE_DIR, file);
    const keep = fs.readFileSync(p);
    fs.writeFileSync(p, Buffer.concat([keep, Buffer.from(' ')]));
    assert.notEqual(R.researchSignature(root), s0, file);
    fs.writeFileSync(p, keep);
  }
  const loaded = R.loadResearch(root);
  assert.equal(loaded.available, true);
  assert.equal(loaded.byId.size, 6);
});

test('ceilings on the lists a hostile file could grow: taxonomies 40, candidate facets 40, evidence per facet 10, distinct statuses 30 per source; a generatedAt that is not a timestamp is "unknown"', () => {
  const tax = Array.from({ length: 100 }, (_, i) => ({ kind: 'theme', id: `t${i}`, url: `https://letterboxd.com/films/theme/t${i}/` }));
  const facets = Array.from({ length: 100 }, (_, i) => ({ dimension: 'tone', tag: `tag${i}`, status: 'literal-rule-candidate', evidence: Array.from({ length: 30 }, (_, j) => ({ source: 'tmdb', url: `https://x/${j}` })) }));
  const many = Array.from({ length: 40 }, (_, i) => F.record(`tt${5000000 + i}`, `Film ${i}`, 2000, { sourceStatus: { letterboxd: `status-${i}` } }));
  const root = withPackage({ films: [F.record('tt0000007', 'Suspiria', 1977, { sourceTaxonomies: { letterboxd: tax }, candidateFacets: facets }), ...many], coverage: { generatedAt: 'yesterday <b>evening</b>' } });
  const r = ask(adapterOf(root), ['tt0000007']);
  const [f] = r.results;
  assert.equal(f.sourceTaxonomies.letterboxd.length, 40);
  assert.equal(f.candidateFacets.length, 40);
  assert.equal(f.candidateFacets[0].evidence.length, 10);
  assert.equal(r.package.generatedAt, 'unknown', 'a file time is not used instead: it is the checkout time');
  const counts = r.package.statusCounts.letterboxd;
  assert.equal(Object.keys(counts).length, 31, '30 distinct statuses plus the "other" bucket');
  assert.equal(counts.other, 11);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 41, 'every record is still counted once');
});
