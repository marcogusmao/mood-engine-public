const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fixture } = require('../test-support/film-page-fixture');
const { pageSynopsis, pageShards, writePages } = require('../lib/page-export');
const { validatePages, verifyPages } = require('../lib/page-validation');
const { publish } = require('../lib/publish');
const { verifyPublic } = require('../lib/learning/public');
const { verifyIndex } = require('../verify');
const { buildIndex } = require('../lib/index-export');
const SOURCES = require('../lib/synopsis-source');
const fresh = () => { const f = fixture(); return { ...f, shards: pageShards(f.index2, f.pageFacts) }; };
function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-publication-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
test('FP export: canonical summaries preserve non-MUBI text and credit MUBI at the end', () => {
  assert.equal(pageSynopsis('MUBI: A quiet arrival. An unexpected meeting.', 'mubi'), 'A quiet arrival. An unexpected meeting. — MUBI');
  assert.equal(pageSynopsis('A quiet arrival.', 'other'), 'A quiet arrival.'); assert.equal(pageSynopsis('', 'mubi'), '');
  const s = pageSynopsis('MUBI: ' + 'Words '.repeat(100), 'mubi'); assert.ok(s.length <= 280); assert.ok(s.endsWith(' — MUBI')); assert.ok(!s.startsWith('MUBI'));
});
test('FP export: facts capture does not change any index column or row description', () => {
  const cfg = { addon: { version: '1' }, moods: [] }, item = { id: 'tt1', title: 'One', cast: ['Wrong cast'], overview: 'Wrong synopsis.', tmdb: 5 }, plan = { board: [{ id: 'tonight', name: 'Tonight', items: [item] }], discover: [] };
  const args = { cfg, today: '2026-10-24', builtAt: '2026-10-24T12:00:00Z', plan, detail: () => ({ imdb: 'tt2', cast: [{ name: 'Wrong cast' }], trailer: 'abcdefghijk' }) };
  const facts = new Map(), a = buildIndex(args), b = buildIndex({ ...args, pageFacts: facts }); assert.deepEqual(b, a); assert.deepEqual(facts.get('tt1').cast, []); assert.equal(facts.get('tt1').trailer, undefined); assert.equal(facts.get('tt1').synopsis, '');
  const own = { imdb: 'tt1', title: 'One', directors: [{ name: 'Director, Jr.' }], cast: [{ name: 'Own actor' }], overview: 'Own synopsis.', trailer: 'abcdefghijk' };
  const ix = buildIndex({ ...args, detailOfImdb: () => own, pageFacts: facts }); assert.equal(ix.films.length, 1); assert.deepEqual(facts.get('tt1').directors, ['Director, Jr.']); assert.deepEqual(facts.get('tt1').cast, ['Own actor']);
});
test('FP export: MUBI synopsis is captured once without changing description bytes', () => {
  const args = { cfg: { addon: { version: '1' }, moods: [] }, today: '2026-10-24', builtAt: '2026-10-24T12:00:00Z', plan: { board: [{ id: 'tonight', name: 'Tonight', items: [{ id: 'tt1', title: 'One' }] }], discover: [] } };
  SOURCES.setTakes({ tt1: 'An arrival. A meeting.' });
  try { const facts = new Map(); assert.deepEqual(buildIndex(args), buildIndex({ ...args, pageFacts: facts })); assert.equal(facts.get('tt1').synopsis, 'MUBI: An arrival. A meeting.'); assert.equal(facts.get('tt1').synopsisSource, 'mubi'); } finally { SOURCES.clear(); }
});
test('FP export: schema, coverage and references reject one defect per copy', () => {
  const cases = [
    [s => s.pop(), /100 shards/], [s => s[65].films.push(structuredClone(s[65].films[0])), /duplicate film/],
    [s => s[65].films[0].t = 'tt1', /membership/], [s => s[65].builtAt = '2026-10-23T12:00:00Z', /builtAt differs/],
    [s => s[65].people.push('Someone'), /people differs/], [s => s[65].films[0].fr = { s: [[9, 5]], w: [] }, /friends index/],
    [s => s[65].films[0].syn = 'Another synopsis.', /synopsis differs/], [s => s[65].films[0].rating = 4, /unexpected key rating/],
    [s => s[65].films[0].why = 'Private reason', /unexpected key why/], [s => s[65].films[0].rt = Infinity, /invalid rt/],
    [s => s[65].films[0].c = Array(6).fill('Actor'), /invalid c/], [s => s[65].films[0].li = [['unknown', 1]], /list reference/],
    [s => s[65].films[0].n = 'x'.repeat(256 * 1024), /256 KiB/], [s => s[65].films[0].n = 'private@example.test', /private content/],
  ];
  for (const [mutate, expected] of cases) { const f = fresh(); mutate(f.shards); assert.throws(() => validatePages(f.index2, f.shards), expected); }
});
test('FP export: public boundaries refuse missing, extra, alias and escaped private page strings', t => {
  const root = temp(t), outDir = path.join(root, 'site'), f = fixture(); publish({ ...f, outDir }); assert.equal(verifyPublic(outDir), true);
  const file = path.join(outDir, 'data/page-65.json'), original = fs.readFileSync(file); fs.unlinkSync(file); assert.match(verifyIndex(outDir).problems.join(';'), /100 named shards/); fs.writeFileSync(file, original);
  const extra = path.join(outDir, 'data/page-100.json'); fs.writeFileSync(extra, '{}'); assert.throws(() => verifyPublic(outDir), /100 named shards/); fs.unlinkSync(extra);
  fs.unlinkSync(file); fs.symlinkSync(path.join(outDir, 'data/page-64.json'), file); assert.throws(() => verifyPublic(outDir), /Symlink/); fs.unlinkSync(file); fs.writeFileSync(file, original);
  // Duplicate JSON keys are inspected too, before JSON.parse's last-value projection can hide the first.
  const raw = original.toString().replace('"n":"Synthetic film"', '"n":"PRIVATE\\u002dCANARY","n":"Synthetic film"'); fs.writeFileSync(file, raw);
  assert.throws(() => verifyPublic(outDir, { terms: ['PRIVATE-CANARY'] }), /private content/);
});
test('FP export: failed page validation preserves previous destination byte for byte', t => {
  const root = temp(t), outDir = path.join(root, 'site'), f = fixture(); publish({ ...f, outDir }); const before = fs.readFileSync(path.join(outDir, 'data/page-65.json'));
  f.pageFacts.get('tt0057565').synopsis = 'Changed.'; assert.throws(() => publish({ ...f, outDir }), /synopsis differs/); assert.deepEqual(fs.readFileSync(path.join(outDir, 'data/page-65.json')), before); assert.deepEqual(fs.readdirSync(root), ['site']);
});
test('FP export: no-v2 and person v2 never publish pages and reject their presence', t => {
  const root = temp(t);
  for (const person of [false, true]) { const f = fixture({ person }); const outDir = path.join(root, String(person)); publish({ ...f, index2: person ? f.index2 : null, outDir }); assert.equal(fs.readdirSync(path.join(outDir, 'data')).filter(n => n.startsWith('page-')).length, 0); fs.writeFileSync(path.join(outDir, 'data/page-00.json'), '{}'); assert.throws(() => verifyPages(outDir, person ? f.index2 : null), person ? /forbidden for person/ : /orphan pages/); assert.equal(verifyIndex(outDir).ok, false); }
});
test('FP export: eligible critic lists only, people indices and nullable stars survive the compact projection', () => {
  const f = fixture(), e = f.index2.films[0], fact = f.pageFacts.get(e.tt); f.index2.lists = [{ id: 'critic', label: 'Critic' }, { id: 'fan', label: 'Fan' }]; e.lists = { critic: 5, fan: 2 }; fact.listIds = ['critic']; f.index2.friends.people = ['Ana', 'Bo']; e.friends = { seenBy: [['Ana', null]], wantBy: ['Bo'] }; e.seenBy = 10; e.friendsAvg = 4.8;
  const r = pageShards(f.index2, f.pageFacts)[65].films[0]; assert.deepEqual(r.li, [['critic', 5]]); assert.deepEqual(r.fr, { s: [[0, null]], w: [1] }); assert.equal(r.fa, 4.8); assert.ok(!Object.hasOwn(r, 'watchlist'));
});
test('FP content: only positive mood vocabulary reaches page styles, never raw TMDB terms', () => {
  const facts = new Map(), cfg = { addon: { version: '1' }, moods: [{ id: 'noir', word: 'Noir', name: 'Noir', keywords: { 'film noir': 2, noir: 1, anxious: 1, rape: -3 } }] };
  const d = { imdb: 'tt1', title: 'One', keywords: ['film noir', 'anxious', 'rape', 'christianity', 'monk'], genres: ['Drama'] };
  const ix = buildIndex({ cfg, pageFacts: facts, today: '2026-10-24', plan: { board: [], discover: [] }, cands: [{ film: d, tasteZ: 1, qualityZ: 1 }] });
  assert.deepEqual(facts.get('tt1').keywords, ['film noir', 'anxious']); assert.doesNotMatch(JSON.stringify(pageShards(ix, facts)), /rape|christianity|monk/);
});
test('FP export: family byte ceiling counts actual UTF-8 file bytes, including whitespace', t => {
  const root = temp(t), f = fixture(); writePages(root, f.index2, f.pageFacts);
  for (let i = 0; i < 100; i++) { const file = path.join(root, `data/page-${String(i).padStart(2, '0')}.json`); fs.appendFileSync(file, ' '.repeat(130000)); }
  assert.throws(() => verifyPages(root, f.index2), /family exceeds 12 MB/);
});
test('FP content: candidate-only legacy synopsis is never falsely credited as MUBI', () => {
  SOURCES.setTakes({ tt1: 'The MUBI take.' });
  try {
    const facts = new Map(), cfg = { addon: { version: '1' }, moods: [] };
    const args = { cfg, today: '2026-10-24', builtAt: '2026-10-24T12:00:00Z', plan: { board: [], discover: [] }, cands: [{ film: { imdb: 'tt1', title: 'One', overview: 'The TMDB synopsis.' }, tasteZ: 1, qualityZ: 1 }] };
    const before = buildIndex(args), after = buildIndex({ ...args, pageFacts: facts }); assert.deepEqual(after, before); assert.equal(facts.get('tt1').synopsisSource, 'other'); assert.equal(pageShards(after, facts)[1].films[0].syn, 'The TMDB synopsis.');
  } finally { SOURCES.clear(); }
});
// Review 27/10/2026 (Baixo 6): a public synopsis with "a/k/a" tripped the shard's private-text rule ("/k/"), writePages refused the whole family and the night failed. Now only that film loses `syn`.
test('FP export: a synopsis that trips the private-text rule loses only its own syn; the build goes on', t => {
  const other = { id: 'tt0000001', title: 'Other film', year: 1970, overview: 'A quiet arrival.', genres: ['Drama'], directors: ['Someone'], cast: [], runtime: 90 };
  const f = fixture({ overview: 'a/k/a the hunter. A quiet arrival.', extra: [other] });
  const stats = { synOmitted: 0 }, shards = pageShards(f.index2, f.pageFacts, stats);
  assert.equal(stats.synOmitted, 1); assert.ok(f.pageFacts.get('tt0057565').synopsis.includes('a/k/a'));
  assert.ok(!Object.hasOwn(shards[65].films[0], 'syn')); assert.equal(shards[65].films[0].n, 'Synthetic film'); assert.equal(shards[1].films[0].syn, 'A quiet arrival.');
  assert.doesNotThrow(() => validatePages(f.index2, shards));
  const root = temp(t), outDir = path.join(root, 'site'); const { pages } = publish({ ...f, outDir });
  assert.equal(pages.synOmitted, 1); assert.equal(verifyPublic(outDir), true); assert.equal(verifyIndex(outDir).ok, true);
  assert.doesNotMatch(fs.readFileSync(path.join(outDir, 'data/page-65.json'), 'utf8'), /a\/k\/a|"syn"/);
  // An e-mail address and "you rate" are the same rule: omitted from the film page (the same public text stays in index-v2.json `desc` and the cards; an e-mail there still stops the night in verify.js).
  for (const text of ['Write to someone@example.test for the story.', 'Because you rate slow films highly.']) { const g = fixture({ overview: text }); const s = { synOmitted: 0 }; assert.ok(!Object.hasOwn(pageShards(g.index2, g.pageFacts, s)[65].films[0], 'syn')); assert.equal(s.synOmitted, 1); }
});
test('FP export: a film NAME with the private marker still refuses the family, as before', t => {
  const f = fixture({ title: 'Hunter /k/ Cut' });
  assert.throws(() => writePages(temp(t), f.index2, f.pageFacts), /private content/);
  const shards = pageShards(f.index2, f.pageFacts); assert.throws(() => validatePages(f.index2, shards), /private content/);
});
