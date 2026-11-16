'use strict';
// films CLI (Fatia 1) — fixed fixtures; no test is pinned to the hash of a real cache (the nightly build moves them), and none skips for that reason.
// Run only these: node --test tools/films/films.test.js
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { project } = require('./project');
const Qy = require('./query');
const { run } = require('./films');
const { load, defaultIndex } = require('./store');


// Every temp dir/file a test makes is removed when the file finishes (they hold copies of fixture data, and 1,800 piled up in $TMPDIR).
const made = [];
const mk = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
const mkfile = (name) => { const f = path.join(os.tmpdir(), name); made.push(f); return f; };
after(() => { for (const p of made) fs.rmSync(p, { recursive: true, force: true }); });

const ROOT = path.resolve(__dirname, '..', '..');
const movie = (id, imdb, title, year, extra = {}) => [String(id), { t: 1760000000000, v: { id, imdb, title, year, runtime: 100, lang: 'en', genres: ['Drama'], keywords: ['friendship'], directors: [{ id: id * 10, name: `Director ${id}` }], cast: [], countries: ['US'], ...extra } }];

function fixture() {
  const tmdb = {
    movie: Object.fromEntries([
      movie(1, 'tt0000001', 'Just Below', 2001),          // community 3.49, nobody else
      movie(2, 'tt0000002', 'Friend Saves', 2002),        // community 3.0, configured friend 3.5
      movie(3, 'tt0000003', 'Crowd Only', 2003),          // community 3.0, a followed (not configured) account 5.0
      movie(4, 'tt0000004', 'Suspiria', 1977),            // homonym pair
      movie(5, 'tt0000005', 'Suspiria', 2018),
      movie(6, 'tt0000006', 'No Runtime', 2006, { runtime: null }),
      movie(7, 'tt0000007', 'Community Only', 2007, { overview: 'A night-shift cleaner keeps a diary nobody reads.' }), // community 3.9, no friend: must stay eligible (catches OR → AND)
      movie(8, 'tt0000008', 'Seen One', 2008),
      movie(9, 'tt0000009', 'No Average', 2009),          // no community average anywhere
      movie(10, 'tt0000010', 'Brother of Sleep', 1995, { overview: 'Another film\'s synopsis: the series must not inherit it.' }), // what an old Letterboxd record's TV id points at in the movie cache
      movie(11, 'tt0000011', 'Whole Affair', 2011),       // export says 2004; Letterboxd record says 2004
      movie(12, 'tt0000012', 'The Hand of God', 2021, { originalTitle: 'È stata la mano di Dio' }),
      movie(13, 'tt0000013', 'Scarface', 1932),
      movie(14, 'tt0000014', 'Scarface', 1983),
    ]),
    search: { 'seenone|2008': { v: 8 }, 'justbelow|2001': { v: 1 }, 'friendsaves|2002': { v: 2 }, 'crowdonly|2003': { v: 3 } },
  };
  const lb = (tmdbId, imdbId, title, year, r) => ({ title, year, tmdbId, imdbId, ...(r != null ? { r, rn: 100 } : {}), t: 1760000000000 });
  const friends = {
    films: {
      'just-below': lb(1, 'tt0000001', 'Just Below', 2001, 3.49),
      'friend-saves': lb(2, 'tt0000002', 'Friend Saves', 2002, 3.0),
      'crowd-only': lb(3, 'tt0000003', 'Crowd Only', 2003, 3.0),
      'suspiria': lb(4, 'tt0000004', 'Suspiria', 1977, 3.9),
      'suspiria-2018': lb(5, 'tt0000005', 'Suspiria', 2018, 3.6),
      'no-runtime': lb(6, 'tt0000006', 'No Runtime', 2006, 3.8),
      'community-only': lb(7, 'tt0000007', 'Community Only', 2007, 3.9),
      'seen-one': lb(8, 'tt0000008', 'Seen One', 2008, 4.0),
      'no-average': lb(9, 'tt0000009', 'No Average', 2009, null),
      'some-series': { ...lb(10, 'tt0000099', 'Some Series', 1995, 4.5), rt: 615, c: ['Japan'] }, // imdb says another title than TMDB 10
      'whole-affair': lb(11, 'tt0000011', 'Whole Affair', 2004, 4.2),
      'hand-of-god': lb(12, 'tt0000012', 'The Hand of God', 2021, 3.7),
      'scarface': lb(13, 'tt0000013', 'Scarface', 1932, 3.9),
      'scarface-1983': lb(14, 'tt0000014', 'Scarface', 1983, 4.0),
      'lb-only': { title: 'Letterboxd Only', year: 1999, imdbId: 'tt0000015', r: 3.8, rt: 95, c: ['USA', 'Japan'], t: 1760000000000 },
    },
    users: {
      ana: { films: [['friend-saves', 'Friend Saves', 2002, 3.5], ['suspiria', 'Suspiria', 1977, 4.5], ['community-only', 'Community Only', 2007, 4]], watchlist: [] },
      bia: { films: [['suspiria', 'Suspiria', 1977, 4], ['just-below', 'Just Below', 2001, 3]], watchlist: [['no-runtime', 'No Runtime', 2006]] },
      stranger: { films: [['crowd-only', 'Crowd Only', 2003, 5], ['just-below', 'Just Below', 2001, 5]], watchlist: [] },
    },
    following: { users: [['stranger', 'Stranger']] },
    me: { slugs: ['scarface-1983'] },
    watchlist: { items: [['suspiria', 'Suspiria', 1977], ['community-only', 'Community Only', 2007]] },
    lists: {},
  };
  const cfg = { letterboxd: 'marco', friends: [{ user: 'ana', name: 'Ana' }, { user: 'bia', name: 'Bia' }] };
  const history = new Map([
    ['seenone|2008', { title: 'Seen One', year: 2008, watched: true, rating: 4, liked: false, watchlist: false }],
    ['justbelow|2001', { title: 'Just Below', year: 2001, watched: true, rating: 2, liked: false, watchlist: false }],
    ['friendsaves|2002', { title: 'Friend Saves', year: 2002, watched: true, rating: 4.5, liked: false, watchlist: false }],
    ['crowdonly|2003', { title: 'Crowd Only', year: 2003, watched: true, rating: 3, liked: false, watchlist: false }],
    ['wholeaffair|2004', { title: 'Whole Affair', year: 2004, watched: true, rating: 4.5, liked: false, watchlist: false }],
    ['estatalamanodidio|2021', { title: 'È stata la mano di Dio', year: 2021, watched: true, rating: null, liked: false, watchlist: false }],
  ]);
  return { tmdb, friends, cfg, history };
}
const idx = () => project(fixture());
const film = (index, id) => index.films.find((f) => f.id === id);

test('eligibility: 3.49 unrounded is out; a configured friend ≥3.5 lets it in; a followed account does not', () => {
  const i = idx();
  assert.equal(film(i, 'tt0000001').lb, 3.49);
  assert.equal(film(i, 'tt0000001').elig, false, '3.49 must not round up to 3.5');
  assert.equal(film(i, 'tt0000002').elig, true, 'configured friend Ana 3.5 grants the exception');
  assert.match(film(i, 'tt0000002').eligWhy, /Ana rated it 3\.5/);
  assert.equal(film(i, 'tt0000003').elig, false, 'a followed, unconfigured account at 5★ grants nothing');
  assert.equal(film(i, 'tt0000007').elig, true, 'community 3.9 alone qualifies (OR, not AND)');
  assert.equal(film(i, 'tt0000009').elig, false, 'no average and no friend: not eligible');
  assert.equal(film(i, 'tt0000009').lb, null);
});

test('identity: a homonym returns candidates, title + year picks one, never a merged record', () => {
  const i = idx();
  const r = Qy.resolve(i, 'Suspiria');
  assert.equal(r.film, undefined);
  assert.deepEqual(r.candidates.map((f) => f.id).sort(), ['tt0000004', 'tt0000005']);
  assert.equal(Qy.resolve(i, 'Suspiria 2018').film.id, 'tt0000005');
  assert.equal(Qy.resolve(i, 'Suspiria (1977)').film.id, 'tt0000004');
  assert.equal(Qy.resolve(i, 'suspiria-2018').film.id, 'tt0000005');
  assert.equal(film(i, 'tt0000004').lb, 3.9, 'the 2018 average must not leak into 1977');
});

test('gaps: a film without runtime fails --max-min, is counted as unknown, and check says unknown', () => {
  const i = idx();
  const s = Qy.search(i, { maxMin: 120 });
  assert.ok(!s.films.some((f) => f.id === 'tt0000006'));
  assert.equal(s.excludedAsUnknown['runtime≤120'], 1);
  const [c] = Qy.check(i, ['tt0000006'], { maxMin: 120 });
  assert.equal(c.pass, false);
  assert.deepEqual(c.unknown, ['runtime≤120']);
});

test('seen and unseen: export rating through the TMDB search cache marks seen; seen without rating is not a rating', () => {
  const i = idx();
  assert.deepEqual(film(i, 'tt0000008').me.seen, ['export']);
  assert.equal(film(i, 'tt0000008').me.r, 4);
  assert.ok(!Qy.search(i, { unseen: true }).films.some((f) => f.id === 'tt0000008'));
  assert.equal(film(i, 'tt0000004').me.r, null, 'watchlist is interest, not a rating');
  assert.equal(film(i, 'tt0000004').me.wl, true);
});

test('overlap: watchlist ∩ configured friends ≥4 is countable by hand, one film counted once', () => {
  const i = idx();
  // watchlist = {Suspiria 1977, Community Only}; friends ≥4 = Ana {Suspiria 4.5, Community Only 4} ∪ Bia {Suspiria 4} → both = 2, Suspiria once
  const o = Qy.overlap(i, 'watchlist', 'friends:rated>=4');
  assert.equal(o.both, 2);
  assert.deepEqual(o.ids.both.sort(), ['tt0000004', 'tt0000007']);
  assert.equal(o.onlyA, 0);
  const c = Qy.overlap(i, 'watchlist', 'crowd:rated>=4');
  assert.equal(c.sizeB, 4, 'crowd adds the stranger’s two 5★ films');
  assert.equal(Qy.overlap(i, 'friend:bia:watchlist', 'watchlist').both, 0);
});

test('why: a revision without a record answers unknown, never an invented explanation', () => {
  const i = idx();
  const w = Qy.why(i, 'tt0000007', { revision: 'abc123', row: 'mood-engine-tonight' });
  assert.equal(w.recorded.status, 'snapshots-not-found', 'never a bare "unknown": the answer names what is missing');
  assert.match(w.recorded.message, /registro histórico não encontrado em .*; passe --snapshots/);
  const dir = mk('films-why-');
  fs.mkdirSync(path.join(dir, 's1'));
  fs.writeFileSync(path.join(dir, 's1', 'manifest.json'), JSON.stringify({ id: 'snap1', sourceRevision: 'abc123def', capturedAt: '2026-10-11T06:00:00.000Z' }));
  fs.writeFileSync(path.join(dir, 's1', 'baseline.json'), JSON.stringify({ data: { plan: { board: [{ id: 'mood-engine-tonight', items: [{ id: 'tt0000007', why: ['you rate X 4.5★ over 3 films'] }] }] } } }));
  const r = Qy.why(i, 'tt0000007', { revision: 'abc123', row: 'mood-engine-tonight', snapshots: dir });
  assert.deepEqual(r.recorded.why, ['you rate X 4.5★ over 3 films']);
  assert.equal(Qy.why(i, 'tt0000001', { revision: 'abc123', snapshots: dir }).recorded.absent.includes('no such item'), true);
  const zzz = Qy.why(i, 'tt0000007', { revision: 'zzz', snapshots: dir }).recorded;
  assert.equal(zzz.status, 'revision-not-found');
  assert.match(zzz.message, /zzz/);
});

test('friends: denominators visible, configured flag, unknown when overlap is too small', () => {
  const i = idx();
  const f = Qy.friends(i);
  assert.equal(f.accounts, 3);
  assert.equal(f.configured, 2);
  const s = f.rows.find((r) => r.user === 'stranger');
  assert.equal(s.configured, false);
  assert.equal(s.overlap, 2);
  assert.equal(s.marcoRated, 4);
  const ana = f.rows.find((r) => r.user === 'ana');
  assert.equal(ana.overlap, 1);
  assert.equal(ana.corr, 'unknown');
});

// Review of 22/10/2026 (MEDIUM 1), config.json ratingsIgnored: an account whose ratings are ignored read as "no ratings" erased what the account SAW from this projection, because a
// person's record lists the films by their rating. Written for that: the record keeps the films seen (`seen`, the unrated ones too), says `ratingsIgnored`, and the queries say so.
test('ratingsIgnored: the account keeps what it saw (seen), loses its stars, and says so in the record, the sets and friends(); the others are read as before', () => {
  const withUnrated = (cfgExtra) => {
    const f = fixture();
    f.friends.users.stranger.films.push(['no-average', 'No Average', 2009, null]); // seen, no stars
    f.cfg = { ...f.cfg, ...cfgExtra };
    return project(f);
  };
  const control = withUnrated({}), ignored = withUnrated({ ratingsIgnored: { users: ['STRANGER'] } }); // written in capitals: matched without case
  const idOf = (i, title) => i.films.find((x) => x.title === title).id;
  const three = ['Crowd Only', 'Just Below', 'No Average'].map((t) => idOf(ignored, t)).sort();
  // control: with the stars he has two rated films and no `seen`
  assert.equal(control.people.stranger.rated.length, 2);
  assert.equal('ratingsIgnored' in control.people.stranger, false);
  assert.equal('ratingsIgnored' in control.meta, false);
  assert.equal('ratingsIgnored' in Qy.friends(control), false);
  assert.equal(Qy.overlap(control, 'friend:stranger', 'watchlist').sizeA, 2);
  assert.equal(Qy.overlap(control, 'crowd:rated>=4', 'watchlist').sizeA, 4, 'control: Suspiria and Community Only (Ana, Bia), Crowd Only and Just Below (his 5 stars)');
  // ignored
  const p = ignored.people.stranger;
  assert.deepEqual(p.rated, []);
  assert.equal(p.ratingsIgnored, true);
  assert.deepEqual(p.seen.slice().sort(), three, 'every film he saw, the one without stars too');
  assert.equal(p.unresolved, 0);
  assert.deepEqual(ignored.meta.ratingsIgnored, ['stranger']);
  assert.equal(ignored.people.ana.ratingsIgnored, undefined);
  assert.deepEqual(ignored.people.ana.rated, control.people.ana.rated, 'another account is read as before');
  assert.equal(Qy.overlap(ignored, 'friend:stranger', 'watchlist').sizeA, 3, 'the set of the account is what he SAW');
  assert.equal(Qy.overlap(ignored, 'friend:stranger:rated>=4', 'watchlist').sizeA, 0, 'a threshold on his stars matches nothing');
  assert.equal(Qy.overlap(ignored, 'crowd:rated>=4', 'watchlist').sizeA, 2, 'his 5 stars are out of the crowd at 4+: only Suspiria and Community Only are left');
  const f = Qy.friends(ignored);
  const row = f.rows.find((r) => r.user === 'stranger');
  assert.equal(row.theirRated, 0);
  assert.equal(row.ratingsIgnored, true);
  assert.equal(row.theirSeen, 3);
  assert.deepEqual(f.ratingsIgnored, [{ user: 'stranger', name: 'Stranger', by: 'list', seen: 3 }], 'named at the top too, for a minOverlap that hides the row, with the reason');
  assert.equal(row.ratingsIgnoredBy, 'list');
  assert.equal(p.ratingsIgnoredBy, 'list');
  assert.deepEqual(ignored.meta.ratingsIgnoredBy, { stranger: 'list' });
  assert.deepEqual(Qy.friends(ignored, { minOverlap: 5 }).ratingsIgnored, f.ratingsIgnored);
});

// Marco, 22/10/2026 ~06:40 UTC: the general rule (config.json ratingsIgnored.rule) puts an account out with the reason "rule" and the numbers; the list says "list".
// The fixture's `stranger` rates two films, both 5 stars: a rule of 95% over 2 ratings catches him and nobody else (ana 3.5, 4.5, 4; bia 4, 3); with 3 ratings as the minimum it catches nobody.
test("ratingsIgnored by the rule: the record, the sets and friends() say 'rule' with the numbers; the list wins for a name on both; a rule that catches nobody changes nothing", () => {
  const run = (ratingsIgnored) => { const f = fixture(); f.cfg = { ...f.cfg, ...(ratingsIgnored ? { ratingsIgnored } : {}) }; return project(f); };
  const control = run(null), ruled = run({ rule: { share: 0.95, minRatings: 2 } }), nobody = run({ rule: { share: 0.95, minRatings: 3 } }), both = run({ users: ['stranger'], rule: { share: 0.95, minRatings: 2 } });
  const p = ruled.people.stranger;
  assert.equal(p.ratingsIgnored, true);
  assert.equal(p.ratingsIgnoredBy, 'rule');
  assert.deepEqual(p.ratingSpread, { n: 2, value: 5, count: 2, share: 1 });
  assert.deepEqual(p.rated, []);
  assert.equal(p.seen.length, 2, 'what he saw stays');
  assert.deepEqual(ruled.meta.ratingsIgnored, ['stranger']);
  assert.deepEqual(ruled.meta.ratingsIgnoredBy, { stranger: 'rule' });
  for (const other of ['ana', 'bia']) assert.equal('ratingsIgnored' in ruled.people[other], false, `${other} is read as before`);
  const f = Qy.friends(ruled);
  assert.equal(f.rows.find((r) => r.user === 'stranger').ratingsIgnoredBy, 'rule');
  assert.deepEqual(f.ratingsIgnored, [{ user: 'stranger', name: 'Stranger', by: 'rule', seen: 2 }]);
  assert.equal(Qy.overlap(ruled, 'friend:stranger:rated>=4', 'watchlist').sizeA, 0);
  assert.equal(Qy.overlap(ruled, 'friend:stranger', 'watchlist').sizeA, 2, 'the set of the account is what he SAW');
  // controls
  assert.equal('ratingsIgnored' in control.people.stranger, false);
  assert.equal(control.people.stranger.rated.length, 2);
  assert.equal('ratingsIgnored' in nobody.people.stranger, false, 'a minimum of 3 ratings: he has 2');
  assert.equal('ratingsIgnored' in nobody.meta, false);
  assert.equal(both.people.stranger.ratingsIgnoredBy, 'list', 'on the list and under the rule: the list is the reason');
  assert.equal('ratingSpread' in both.people.stranger, false);
});

// ── end to end through the files, the index and the CLI ──
function writeRoot() {
  const { tmdb, friends, cfg } = fixture();
  const root = mk('films-root-');
  fs.mkdirSync(path.join(root, 'cache'));
  fs.mkdirSync(path.join(root, 'data', 'letterboxd'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cache', 'tmdb.json'), JSON.stringify(tmdb));
  fs.writeFileSync(path.join(root, 'cache', 'friends.json'), JSON.stringify(friends));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg));
  fs.writeFileSync(path.join(root, 'data', 'letterboxd', 'ratings.csv'), 'Date,Name,Year,Letterboxd URI,Rating\n2026-10-01,Seen One,2008,https://boxd.it/x,4\n');
  return root;
}

test('CLI: unknown is spelled out, never 0 or false; batch dossier; index rebuilt only when a source changes', () => {
  const root = writeRoot();
  const indexFile = path.join(root, '.context', 'films', 'index.json');
  const a = run(['search', '--fields', 'id,lb,rt', '--limit', '0', '--sort', 'id', '--index', indexFile, '--timing'], { root });
  assert.equal(a.total, 16); // 14 TMDB films + the conflicting series + one Letterboxd-only film
  assert.deepEqual(a.rows.find((r) => r[0] === 'tt0000009'), ['tt0000009', 'unknown', 100]);
  assert.deepEqual(a.rows.find((r) => r[0] === 'tt0000006'), ['tt0000006', 3.8, 'unknown']);
  assert.equal(a.timing.rebuilt, true);
  assert.equal(run(['health', '--index', indexFile, '--timing'], { root }).timing.rebuilt, false);
  const d = run(['dossier', 'tt0000009', 'Suspiria', 'nope 1900', '--index', indexFile], { root });
  assert.equal(d.asked, 3);
  assert.equal(d.found, 1);
  assert.equal(d.results[0].communityAverage.value, 'unknown');
  assert.equal(d.results[1].candidates.length, 2);
  assert.equal(d.results[2].found, false);
  fs.appendFileSync(path.join(root, 'data', 'letterboxd', 'ratings.csv'), '2026-10-02,Community Only,2007,https://boxd.it/y,5\n');
  assert.equal(run(['health', '--index', indexFile, '--timing'], { root }).timing.rebuilt, true, 'a changed export rebuilds');
  // the new row has no TMDB search-cache entry: it is reported pending, not attached to a guessed film
  assert.equal(run(['health', '--index', indexFile], { root }).marcoRatedPendingTmdbMatch, 1);
  assert.equal(run(['dossier', 'tt0000007', '--index', indexFile], { root }).results[0].marco.rating.value, 'unknown');
});

test('identity: a Letterboxd record whose TMDB id names another film keeps only Letterboxd facts', () => {
  const i = idx();
  const f = film(i, 'tt0000099');
  assert.equal(f.title, 'Some Series');
  assert.equal(f.rt, 615, 'runtime from Letterboxd, not the 100 min of Brother of Sleep');
  assert.equal(f.tmdb, null);
  assert.equal(f.tmdbConflict, 10);
  assert.deepEqual(f.directors, []);
  assert.equal(film(i, 'tt0000010').title, 'Brother of Sleep', 'the other film keeps its own record');
  assert.equal(i.meta.identityConflicts.length, 1);
  assert.ok(!Qy.search(i, { maxMin: 120 }).films.some((x) => x.id === 'tt0000099'));
});

// 12/10/2026: the projection kept no synopsis, so neither the CLI nor the MCP could show the one TMDB holds (cache/tmdb.json movie[id].v.overview).
test('synopsis: the film\'s own TMDB overview, with its source; null when there is none; never the one a conflicting TMDB id names', () => {
  const i = idx();
  assert.equal(film(i, 'tt0000007').overview, 'A night-shift cleaner keeps a diary nobody reads.');
  assert.equal(film(i, 'tt0000007').overviewSrc, 'tmdb');
  assert.equal(film(i, 'tt0000007').tTmdb, '2025-10-09T08:53:20.000Z', 'the date is the TMDB record\'s own');
  for (const id of ['tt0000009', 'tt0000015']) { assert.equal(film(i, id).overview, null, id); assert.equal(film(i, id).overviewSrc, null, id); }
  assert.equal(film(i, 'tt0000010').overview, 'Another film\'s synopsis: the series must not inherit it.', 'the other film keeps its own');
  const series = film(i, 'tt0000099');
  assert.equal(series.tmdbConflict, 10);
  assert.equal(series.overview, null, 'Some Series points at TMDB 10: it inherits nothing from Brother of Sleep');
  assert.equal(series.overviewSrc, null);
  // A record that has its OWN TMDB entry (same IMDb id) and is also named by a Letterboxd slug with another film's TMDB id: the entry is confirmed by IMDb,
  // so its synopsis comes (12/10/2026: 4 of the 62 real conflicts); the conflict stays on the record and in the CLI's warning.
  const f = fixture();
  f.friends.films['community-only-old'] = { title: 'Community Only', year: 2007, tmdbId: 10, imdbId: 'tt0000007', r: 3.9, rn: 100, t: 1760000000000 };
  const j = project(f);
  assert.equal(film(j, 'tt0000007').tmdbConflict, 10);
  assert.equal(film(j, 'tt0000007').tmdbOwn, true, 'TMDB 7 carries tt0000007: the film\'s own record');
  assert.equal(film(j, 'tt0000007').overview, 'A night-shift cleaner keeps a diary nobody reads.');
  assert.equal(film(j, 'tt0000007').overviewSrc, 'tmdb');
  assert.equal(film(j, 'tt0000007').tmdb, 7);
  // and it never lends Brother of Sleep\'s text to the other record, nor takes it
  assert.equal(film(j, 'tt0000010').overview, 'Another film\'s synopsis: the series must not inherit it.');
  assert.equal(film(j, 'tt0000010').tmdbOwn, undefined, 'no conflict on it');
  // the series stays blocked: its TMDB id names Brother of Sleep (tt0000010 ≠ tt0000099) and it has no TMDB record of its own
  assert.equal(film(j, 'tt0000099').tmdbOwn, undefined);
  assert.equal(film(j, 'tt0000099').overview, null);
  // end to end: when the TMDB entry the slugs point at carries ANOTHER film's IMDb id, the record has no TMDB record of its own and gets no synopsis
  // (the identity pass already leaves `tmdb` null here, so this does not exercise the IMDb comparison in project.js on its own: see the mutation notes of the commit)
  const g = fixture();
  g.tmdb.movie['7'].v.imdb = 'tt0000777';           // the entry now names another film
  g.friends.films['community-only-old'] = { title: 'Community Only', year: 2007, tmdbId: 10, imdbId: 'tt0000007', r: 3.9, rn: 100, t: 1760000000000 };
  const k = project(g);
  assert.equal(film(k, 'tt0000007').tmdbOwn, undefined);
  assert.equal(film(k, 'tt0000007').overview, null);
});

test('synopsis: cut at 600 characters with an ellipsis, 600 exactly stays whole, a lone surrogate is not left, blank text is none', () => {
  const f = fixture();
  const set = (id, text) => { f.tmdb.movie[id].v.overview = text; };
  set(1, 'a'.repeat(600)); set(2, 'b'.repeat(601)); set(3, 'c'.repeat(1000)); set(4, `${'d'.repeat(599)}😀tail`); set(5, '   \n '); set(6, 12345);
  const i = project(f);
  assert.equal(film(i, 'tt0000001').overview, 'a'.repeat(600), '600 exactly is not cut');
  assert.equal(film(i, 'tt0000002').overview, `${'b'.repeat(600)}…`);
  assert.equal(film(i, 'tt0000003').overview.length, 601);
  assert.ok(film(i, 'tt0000003').overview.endsWith('…'));
  assert.equal(film(i, 'tt0000004').overview, `${'d'.repeat(599)}…`, 'the cut would split the emoji: it goes before it');
  assert.equal(film(i, 'tt0000005').overview, null);
  assert.equal(film(i, 'tt0000006').overview, null, 'a number is not a synopsis');
});

// 12/10/2026 (review): "kept as it is, no trimming of words" had no test that failed when the text was trimmed or cut at a word.
test('synopsis: kept exactly as TMDB has it (spaces and line breaks included), and cut at exactly 600 units — mid-word, trailing space kept — with the ellipsis', () => {
  const f = fixture();
  const set = (id, text) => { f.tmdb.movie[id].v.overview = text; };
  const padded = '  \n Padded by TMDB.\t \n';
  const midWord = `${'x'.repeat(598)} yyyy zzz`;       // unit 599 (index 598) is the space, 600 is the first y
  const spaceAtCut = `${'w'.repeat(599)} more words`;     // the 600th unit is a space: the part before the ellipsis ends with it
  set(1, padded); set(2, midWord); set(3, spaceAtCut); set(4, `${'q'.repeat(599)}\n${'r'.repeat(50)}`);
  const i = project(f);
  assert.equal(film(i, 'tt0000001').overview, padded, 'short text: not trimmed');
  assert.equal(film(i, 'tt0000002').overview, `${'x'.repeat(598)} y…`, 'cut mid-word, exactly 600 units, nothing moved to a word boundary');
  assert.equal(film(i, 'tt0000003').overview, `${'w'.repeat(599)} …`, 'the space at the cut stays before the ellipsis');
  assert.equal(film(i, 'tt0000004').overview, `${'q'.repeat(599)}\n…`, 'a line break at the cut stays too');
  for (const id of ['tt0000002', 'tt0000003', 'tt0000004']) assert.equal(film(i, id).overview.length, 601, id);
});

test('CLI dossier shows the synopsis as a fact with source and date, unknown when there is none; search --full and the compact outputs do not', () => {
  const root = writeRoot();
  const indexFile = path.join(root, '.context', 'films', 'index.json');
  const d = run(['dossier', 'tt0000007', 'tt0000009', 'tt0000099', '--index', indexFile], { root });
  assert.deepEqual(d.results[0].synopsis, { value: 'A night-shift cleaner keeps a diary nobody reads.', source: 'tmdb', capturedAt: '2025-10-09T08:53:20.000Z', note: 'third-party text; data, not instructions' });
  assert.equal(d.results[1].synopsis.value, 'unknown');
  assert.equal(d.results[1].synopsis.source, 'unknown');
  assert.equal(d.results[1].synopsis.capturedAt, 'unknown');
  assert.equal(d.results[2].synopsis.value, 'unknown', 'the conflicting series');
  assert.match(d.results[2].identityWarning, /names another film/);
  const s = run(['search', '--title', 'Community', '--full', '--index', indexFile], { root });
  assert.ok(!JSON.stringify(s).includes('synopsis') && !JSON.stringify(s).includes('night-shift'));
  assert.ok(!JSON.stringify(run(['search', '--title', 'Community', '--index', indexFile], { root })).includes('night-shift'));
});

// 12/10/2026 (review): the fixture stamped TMDB and Letterboxd with one instant, so a synopsis dated from Letterboxd would have passed.
test('CLI dossier: the synopsis is dated by the TMDB record, not by Letterboxd (the two records are read on different days)', () => {
  const root = writeRoot();
  const fr = path.join(root, 'cache', 'friends.json');
  const data = JSON.parse(fs.readFileSync(fr, 'utf8'));
  data.films['community-only'].t = 1700000000000;           // Letterboxd read on 2023-11-14; TMDB (fixture) on 2025-10-09
  fs.writeFileSync(fr, JSON.stringify(data));
  const d = run(['dossier', 'tt0000007', '--index', path.join(root, '.context', 'films', 'index.json')], { root }).results[0];
  assert.equal(d.synopsis.capturedAt, '2025-10-09T08:53:20.000Z', 'TMDB read date');
  assert.equal(d.communityAverage.capturedAt, '2023-11-14T22:13:20.000Z', 'control: the Letterboxd facts carry the Letterboxd date, so the two dates do differ here');
  assert.equal(d.synopsis.source, 'tmdb');
});

test('CLI dossier: a conflicting record with its own TMDB record shows the synopsis and says which record is used; one without says the TMDB facts are withheld (12/10/2026)', () => {
  const root = writeRoot();
  const fr = path.join(root, 'cache', 'friends.json');
  const data = JSON.parse(fs.readFileSync(fr, 'utf8'));
  data.films['community-only-old'] = { title: 'Community Only', year: 2007, tmdbId: 10, imdbId: 'tt0000007', r: 3.9, rn: 100, t: 1760000000000 };
  fs.writeFileSync(fr, JSON.stringify(data));
  const [own, series] = run(['dossier', 'tt0000007', 'tt0000099', '--index', path.join(root, '.context', 'films', 'index.json')], { root }).results;
  assert.equal(own.synopsis.value, 'A night-shift cleaner keeps a diary nobody reads.');
  assert.match(own.identityWarning, /TMDB id 10 names another film; the film's own TMDB record \(same IMDb id, 7\) is used/);
  assert.equal(series.synopsis.value, 'unknown');
  assert.match(series.identityWarning, /TMDB id 10 names another film; TMDB facts withheld/);
});

test('seen follows every path the build uses: export id, /films/ slug, title ±1y, original title, Letterboxd title', () => {
  const i = idx();
  assert.deepEqual(film(i, 'tt0000014').me.seen, ['letterboxd'], '/films/ slug');
  assert.deepEqual(film(i, 'tt0000013').me.seen, [], 'the other Scarface is not seen');
  assert.deepEqual(film(i, 'tt0000011').me.seen, ['title±1y'], 'export 2004 vs TMDB 2011 matches through the Letterboxd record');
  assert.deepEqual(film(i, 'tt0000012').me.seen, ['title±1y'], 'original title');
  const unseen = Qy.search(i, { unseen: true, eligible: true }).films.map((f) => f.id);
  for (const id of ['tt0000011', 'tt0000012', 'tt0000014', 'tt0000008']) assert.ok(!unseen.includes(id), id);
});

test('resolve: a bare word that is also a slug stays ambiguous; titles ending in digits resolve; ±1 year', () => {
  const i = idx();
  assert.equal(Qy.resolve(i, 'scarface').candidates.length, 2, '"scarface" is a slug too, and still two films');
  assert.equal(Qy.resolve(i, 'lb:scarface').film.id, 'tt0000013');
  assert.equal(Qy.resolve(i, 'Whole Affair 2010').matchedBy, 'title + year ±1');
  assert.equal(Qy.resolve(i, 'Whole Affair 2008').none, 'Whole Affair 2008');
  const p = project({ ...fixture(), tmdb: { ...fixture().tmdb, movie: { ...fixture().tmdb.movie, ...Object.fromEntries([movie(20, 'tt0000020', 'THX 1138', 1971)]) } } });
  assert.equal(Qy.resolve(p, 'THX 1138').film.id, 'tt0000020');
  assert.equal(Qy.resolve(p, 'THX 1138 1971').film.id, 'tt0000020');
});

// 12/10/2026 (review): "Split 2016" returned Kampmeier's film while Marco rated Shyamalan's — TMDB dates it 2017, Letterboxd 2016 — and with a synopsis
// attached the wrong premise would leave "with a source". Measured on the real caches: Split 2016, Under the Skin 2013, Manas 2024, The Hand 2020, The Conformist.
function twoSplits() {
  const f = fixture();
  const add = (id, imdb, title, year, extra) => { const [k, v] = movie(id, imdb, title, year, extra); f.tmdb.movie[k] = v; };
  add(301, 'tt0000301', 'Split', 2016, { runtime: 150, directors: [{ id: 3010, name: 'Deborah Kampmeier' }] });   // Letterboxd has no record of it
  add(302, 'tt0000302', 'Split', 2017, { runtime: 117, directors: [{ id: 3020, name: 'M. Night Shyamalan' }], overview: 'Three girls are abducted.' });
  f.friends.films['split-2016'] = { title: 'Split', year: 2016, tmdbId: 302, imdbId: 'tt0000302', r: 3.7, rn: 100, t: 1760000000000 };   // Letterboxd dates it 2016
  f.friends.me.slugs.push('split-2016');
  return f;
}
test('resolve: "Title Year" is one film only when no other film with that title lies within a year; otherwise candidates, exact year first, each with what tells it apart', () => {
  const i = project(twoSplits());
  const r = Qy.resolve(i, 'Split 2016');
  assert.equal(r.film, undefined, 'an exact-year hit with a same-title film one year off is not a pick');
  assert.deepEqual(r.candidates.map((c) => c.id), ['tt0000301', 'tt0000302'], 'the exact year first, then ±1');
  assert.deepEqual(Qy.resolve(i, 'Split (2017)').candidates.map((c) => c.id), ['tt0000302', 'tt0000301'], 'asked 2017: the 2017 film is first');
  assert.deepEqual(Qy.resolve(i, 'Split 2016').candidates.map((c) => c.year), [2016, 2017]);
  // what tells them apart: director, runtime, and Marco's own relation to each (the Letterboxd slug marks Shyamalan's as seen, Kampmeier's has no mark)
  const [kampmeier, shyamalan] = Qy.dossier(i, 'Split 2016').candidates;
  assert.equal(kampmeier.directors, 'Deborah Kampmeier');
  assert.equal(kampmeier.rt, 150);
  assert.deepEqual(kampmeier.me, { r: null, liked: false, wl: false, seen: [] });
  assert.equal(shyamalan.directors, 'M. Night Shyamalan');
  assert.equal(shyamalan.rt, 117);
  assert.deepEqual(shyamalan.me.seen, ['letterboxd']);
  // check and why name the same candidates, never a verdict on a pick
  assert.deepEqual(Qy.check(i, ['Split 2016'], {})[0].candidates.map((c) => c.id), ['tt0000301', 'tt0000302']);
  assert.deepEqual(Qy.why(i, 'Split 2016').candidates.map((c) => c.id), ['tt0000301', 'tt0000302']);
  // one year apart on either side of the ask: a single film in reach is a film (±1), none is not found
  assert.equal(Qy.resolve(i, 'Split 2015').film.id, 'tt0000301');
  assert.equal(Qy.resolve(i, 'Split 2015').matchedBy, 'title + year ±1');
  assert.equal(Qy.resolve(i, 'Split 2018').film.id, 'tt0000302');
  assert.equal(Qy.resolve(i, 'Split 2019').none, 'Split 2019');
  // controls: a title with one film still resolves at its exact year, and a film two years off a homonym is not made ambiguous by it
  assert.equal(Qy.resolve(i, 'Whole Affair 2011').matchedBy, 'title + year');
  assert.equal(Qy.resolve(i, 'Whole Affair 2011').film.id, 'tt0000011');
  assert.equal(Qy.resolve(i, 'Suspiria 2018').film.id, 'tt0000005', 'Suspiria 1977 is 41 years away');
  assert.equal(Qy.resolve(i, 'tt0000302').film.id, 'tt0000302', 'by id nothing changes');
  assert.equal(Qy.resolve(i, 'lb:split-2016').film.id, 'tt0000302');
});

test('resolve: three films one year apart — every one in reach is a candidate, the exact year leads, the one two years away is left out', () => {
  const f = fixture();
  for (const [id, y] of [[311, 2009], [312, 2010], [313, 2011], [314, 2012]]) { const [k, v] = movie(id, `tt0000${id}`, 'Chain', y); f.tmdb.movie[k] = v; }
  const i = project(f);
  assert.deepEqual(Qy.resolve(i, 'Chain 2010').candidates.map((c) => c.year), [2010, 2009, 2011]);
  assert.deepEqual(Qy.resolve(i, 'Chain 2012').candidates.map((c) => c.year), [2012, 2011]);
});

test('sets: rated>4 is strict, rated<3 works, a bad operator is refused', () => {
  const i = idx();
  // Seen One 4 and Friend Saves 4.5; Whole Affair's 4.5 has no TMDB search-cache entry, so it stays pending, not guessed
  assert.equal(Qy.setOf(i, 'rated>=4').size, 2);
  assert.equal(Qy.setOf(i, 'rated>4').size, 1);
  assert.equal(Qy.setOf(i, 'rated<3').size, 1);
  assert.equal(Qy.setOf(i, 'friends:rated>4').size, 1);
  assert.throws(() => Qy.setOf(i, 'rated=>4'), /bad threshold/);
});

test('unknown counts only films the unknown fact alone kept out; countries from Letterboxd names become codes', () => {
  const i = idx();
  const s = Qy.search(i, { maxMin: 120, eligible: true });
  assert.deepEqual(s.excludedAsUnknown, { 'runtime≤120': 1 }); // No Runtime is eligible; nothing else is unknown here
  assert.equal(Qy.search(i, { maxMin: 120, lang: 'xx' }).excludedAsUnknown['runtime≤120'], undefined, 'fails lang anyway');
  assert.deepEqual(film(i, 'tt0000015').countries, ['US', 'JP']);
  assert.ok(Qy.search(i, { country: 'JP' }).films.some((f) => f.id === 'tt0000015'));
});

// 12/10/2026 (review): a film unknown on two filters is counted under each, so the bands overlap and their sum is not a number of films.
test('excludedAsUnknownFilms: distinct films left out only because a fact is unknown; the bands overlap, so a film unknown on two filters is 1 in each band and 1 in the total', () => {
  const f = fixture();
  const [k, v] = movie(30, 'tt0000030', 'Unknown Twice', 2010, { runtime: null, lang: null }); f.tmdb.movie[k] = v;
  const i = project(f);
  const one = Qy.search(i, { title: 'Unknown Twice', maxMin: 120, lang: 'en' });
  assert.equal(one.total, 0);
  assert.deepEqual(one.excludedAsUnknown, { 'runtime≤120': 1, 'lang=en': 1 }, 'one film, one count in each band');
  assert.equal(one.excludedAsUnknownFilms, 1, 'and one film in the total');
  // with the whole index: No Runtime is unknown on runtime only, Letterboxd Only on language only (its runtime, 95, passes), Unknown Twice on both:
  // the bands add up to 4 for 3 distinct films
  const both = Qy.search(i, { maxMin: 120, lang: 'en' });
  assert.deepEqual(both.excludedAsUnknown, { 'runtime≤120': 2, 'lang=en': 2 });
  assert.equal(both.excludedAsUnknownFilms, 3);
  assert.ok(Object.values(both.excludedAsUnknown).reduce((a, b) => a + b, 0) > both.excludedAsUnknownFilms);
  // a film unknown on one filter that FAILS another is not "left out only because unknown": in neither band, not in the total
  const fails = Qy.search(i, { title: 'Unknown Twice', maxMin: 120, yearFrom: 2020 });
  assert.deepEqual(fails.excludedAsUnknown, {});
  assert.equal(fails.excludedAsUnknownFilms, 0);
  // nothing unknown: zero (the key is always there), and no filter at all
  assert.equal(Qy.search(i, { title: 'Suspiria', maxMin: 120 }).excludedAsUnknownFilms, 0);
  assert.equal(Qy.search(i, {}).excludedAsUnknownFilms, 0);
  assert.equal(Qy.search(i, { unseen: true }).excludedAsUnknownFilms, 0, 'a filter that is never unknown');
  // through the CLI the field is in the answer
  const root = writeRoot();
  const out = run(['search', '--max-min', '120', '--eligible', '--index', path.join(root, '.context', 'films', 'index.json')], { root });
  assert.equal(out.excludedAsUnknownFilms, 1);
});

test('options: a typo is an error, never a wider answer', () => {
  assert.throws(() => run(['search', '--eligble']), /unknown option --eligble/);
  assert.throws(() => run(['search', '--sort', 'nope', '--index', mkfile(`films-x-${process.pid}.json`)], { root: writeRoot() }), /unknown sort/);
});

test('why lists today\'s fit for every mood, labelled as recomputed', () => {
  const i = idx();
  i.moods = [{ id: 'letin', name: 'Let it in', genres: { Drama: 1.2 }, keywords: { friendship: 1 }, minFit: 2.2 }];
  const w = Qy.why(i, 'tt0000007');
  assert.equal(w.recorded.status, 'no-revision');
  assert.match(w.recorded.message, /--revision/);
  assert.deepEqual(w.moodFitNow, [{ mood: 'letin', name: 'Let it in', fit: 2.2, minFit: 2.2, ok: true, hits: ['friendship'] }]);
  assert.equal(Qy.search(i, { mood: 'letin' }).total > 0, true);
});

test('--root reads another checkout and writes nothing there; the index is 0600', () => {
  const other = writeRoot();
  const home = mk('films-home-');
  run(['health', '--root', other], { root: home });
  assert.equal(fs.existsSync(path.join(other, '.context')), false, 'nothing written in the other checkout');
  const files = fs.readdirSync(path.join(home, '.context', 'films'));
  assert.equal(files.length, 1);
  assert.equal(fs.statSync(path.join(home, '.context', 'films', files[0])).mode & 0o777, 0o600);
});

test('privacy: the default index path is gitignored and nothing under tools/films is published', () => {
  const r = spawnSync('git', ['check-ignore', '-q', defaultIndex(ROOT)], { cwd: ROOT });
  if (r.error) return; // no git on this machine: nothing to prove here
  assert.equal(r.status, 0, '.context/films/index.json must be ignored by git');
  const publish = fs.readFileSync(path.join(ROOT, 'lib', 'publish.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'build.js'), 'utf8');
  assert.ok(!publish.includes('tools/films'), 'build/publish must not reference tools/films');
});

// What the v1 experiment's count guarded (11/10/2026, 4,742 → 4,707 on the real caches): "eligible, 40–120 min" is the build's rule with the
// runtime bounds inclusive, and 35 TV series whose old Letterboxd record carries a TMDB TV id that names another film (Evangelion → "Brother of Sleep",
// 132 min) must not borrow that film's runtime to land inside the window. Rewritten 12/10/2026 on a fixture of its own: the real caches change every night,
// so the count of 4,707 could only ever skip.
function windowFixture() {
  const m = (id, title, rt) => movie(id, `tt${String(id).padStart(7, '0')}`, title, 2000 + (id % 20), { runtime: rt });
  const tmdb = { movie: Object.fromEntries([
    m(101, 'Floor Edge', 40), m(102, 'One Under', 39), m(103, 'Ceiling Edge', 120), m(104, 'One Over', 121), m(105, 'Middle', 95),
    m(106, 'Just Below Floor', 90), m(107, 'No Runtime', null), m(108, 'Friend Saves It', 100), m(109, 'Crowd Only', 100),
    m(110, 'Brother of Sleep', 100), // inside the window; the series below must not borrow it
  ]), search: {} };
  const lb = (tmdbId, imdbId, title, year, r, extra = {}) => ({ title, year, tmdbId, imdbId, r, rn: 100, t: 1760000000000, ...extra });
  const friends = {
    films: {
      'floor-edge': lb(101, 'tt0000101', 'Floor Edge', 2001, 3.5), 'one-under': lb(102, 'tt0000102', 'One Under', 2002, 3.8),
      'ceiling-edge': lb(103, 'tt0000103', 'Ceiling Edge', 2003, 3.6), 'one-over': lb(104, 'tt0000104', 'One Over', 2004, 3.9),
      'middle': lb(105, 'tt0000105', 'Middle', 2005, 3.5), 'just-below-floor': lb(106, 'tt0000106', 'Just Below Floor', 2006, 3.49),
      'no-runtime': lb(107, 'tt0000107', 'No Runtime', 2007, 4.0), 'friend-saves-it': lb(108, 'tt0000108', 'Friend Saves It', 2008, 3.0),
      'crowd-only': lb(109, 'tt0000109', 'Crowd Only', 2009, 3.0),
      // a series: Letterboxd's own IMDb id, a TMDB id of the movie cache that names "Brother of Sleep", 615 minutes
      'long-series': lb(110, 'tt0000199', 'Long Series', 1995, 4.5, { rt: 615 }),
    },
    users: {
      ana: { films: [['friend-saves-it', 'Friend Saves It', 2008, 3.5]], watchlist: [] },
      stranger: { films: [['crowd-only', 'Crowd Only', 2009, 5]], watchlist: [] },
    },
    following: { users: [['stranger', 'Stranger']] }, me: { slugs: [] }, watchlist: { items: [] }, lists: {},
  };
  return { tmdb, friends, cfg: { letterboxd: 'marco', friends: [{ user: 'ana', name: 'Ana' }] }, history: new Map() };
}

test('consistency with the v1 filter: eligible, 40–120 min is inclusive at both ends, takes a configured friend, leaves a borrowed-runtime series out (12/10/2026, was pinned to the 11/10 caches)', () => {
  const i = project(windowFixture());
  const ids = Qy.search(i, { eligible: true, minMin: 40, maxMin: 120 }).films.map((f) => f.id).sort();
  // Floor Edge (40, 3.5), Middle (95, 3.5), Ceiling Edge (120, 3.6), Friend Saves It (community 3.0, Ana 3.5).
  assert.deepEqual(ids, ['tt0000101', 'tt0000103', 'tt0000105', 'tt0000108']);
  // the fixture really has the cases it is meant to leave out
  assert.equal(film(i, 'tt0000102').elig, true); assert.equal(film(i, 'tt0000104').elig, true);   // 39 and 121 min: eligible, outside the window
  assert.equal(film(i, 'tt0000106').elig, false, '3.49 stays out'); assert.equal(film(i, 'tt0000109').elig, false, 'a followed account grants nothing');
  assert.equal(film(i, 'tt0000107').rt, null, 'no runtime: not in the window, counted as unknown');
  assert.equal(Qy.search(i, { eligible: true, maxMin: 120 }).excludedAsUnknown['runtime≤120'], 1, 'the unknown runtime is counted, not guessed');
  assert.deepEqual(Qy.search(i, { eligible: true, minMin: 40, maxMin: 120 }).excludedAsUnknown, { 'runtime≥40': 1, 'runtime≤120': 1 }, 'both bounds unknown: counted under each, not lost');
  // the series is eligible on its own average, and only its Letterboxd runtime (615) keeps it out; Brother of Sleep (100 min) is not borrowed
  const series = film(i, 'tt0000199');
  assert.equal(series.elig, true);
  assert.equal(series.rt, 615); assert.equal(series.rtSrc, 'letterboxd'); assert.equal(series.tmdbConflict, 110);
  assert.equal(film(i, 'tt0000110').elig, false, 'the film the series pointed at has no Letterboxd record of its own: not eligible');
});

// ── CLI-1 (audit 11/10/2026): a title+year search hit is a guess, not a link ──
// "The Hand 2020" (Wong Kar-wai) had been attached to a 21-minute short with the same title and year; Under the Skin 4.5★ to a 19-minute short.
function homonymFixture() {
  const f = fixture();
  for (const [id, imdb, title, year, extra] of [
    [30, 'tt0000030', 'The Hand', 2020, { runtime: 21 }], [31, 'tt0000031', 'The Hand', 2020, {}],   // search lands on the short; Letterboxd knows Wong's
    [40, 'tt0000040', 'Split', 2016, {}], [41, 'tt0000041', 'Split', 2016, {}],                       // Letterboxd record 40, search lands on 41
    [50, 'tt0000050', 'Lonely Film', 2010, {}],                                                       // one candidate, no Letterboxd record: stays linked
    [60, 'tt0000060', 'Twin', 2012, {}], [61, 'tt0000061', 'Twin', 2012, {}],                         // two candidates in the TMDB cache, no Letterboxd record
    [70, 'tt0000070', 'Remembered', 2015, {}], [71, 'tt0000071', 'Remembered', 2015, {}],             // search entry written by lib/tmdb.js remember() (exact)
    [80, 'tt0000080', 'Year Off', 2013, {}],                                                          // TMDB 2013, export says 2014: ±1 is still one candidate
  ]) { const [k, v] = movie(id, imdb, title, year, extra); f.tmdb.movie[k] = v; }
  Object.assign(f.tmdb.search, { 'thehand|2020': { v: 30 }, 'split|2016': { v: 41 }, 'lonelyfilm|2010': { v: 50 }, 'twin|2012': { v: 60 },
    'remembered|2015': { v: 70, exact: true }, 'yearoff|2014': { v: 80 } });
  const lb = (tmdbId, imdbId, title, year, r) => ({ title, year, tmdbId, imdbId, r, rn: 100, t: 1760000000000 });
  f.friends.films['the-hand-2020-1'] = lb(31, 'tt0000031', 'The Hand', 2020, 3.8);
  f.friends.films['split-2016'] = lb(40, 'tt0000040', 'Split', 2016, 3.6);
  f.friends.films['remembered-2015'] = lb(71, 'tt0000071', 'Remembered', 2015, 3.6);
  f.friends.watchlist.items.push(['the-hand-2020-1', 'The Hand', 2020]);
  const h = (title, year, o) => [`${title.toLowerCase().replace(/ /g, '')}|${year}`, { title, year, watched: false, rating: null, liked: false, watchlist: false, ...o }];
  for (const [k, v] of [h('The Hand', 2020, { watchlist: true }), h('Split', 2016, { watched: true, rating: 3.5 }), h('Lonely Film', 2010, { watched: true, rating: 4 }),
    h('Twin', 2012, { watched: true, rating: 3 }), h('Remembered', 2015, { watched: true, rating: 5 }), h('Year Off', 2014, { watched: true, rating: 4.5 })]) f.history.set(k, v);
  return f;
}

test('CLI-1: a watchlist row whose title+year search lands on a homonym does not count the homonym', () => {
  const i = project(homonymFixture());
  const wl = Qy.setOf(i, 'watchlist');
  assert.ok(!wl.has('tt0000030'), 'the 21-minute short must not be on Marco\'s watchlist');
  assert.ok(wl.has('tt0000031'), 'the live watchlist slug the-hand-2020-1 still names the right film');
  assert.equal(film(i, 'tt0000030').me.wl, false);
});

test('CLI-1: ratings — a disagreement or two plausible candidates is pending with candidates; confirmed and lone matches stay linked', () => {
  const i = project(homonymFixture());
  assert.equal(film(i, 'tt0000041').me.r, null, 'Split: search says 41, Letterboxd says 40: not 41');
  assert.equal(film(i, 'tt0000040').me.r, null, 'and not silently 40 either');
  assert.equal(film(i, 'tt0000060').me.r, null, 'Twin: two films with that title and year in the cache');
  assert.equal(film(i, 'tt0000061').me.r, null);
  assert.equal(film(i, 'tt0000050').me.r, 4, 'one candidate, nothing contradicts: linked');
  assert.equal(film(i, 'tt0000070').me.r, 5, 'a remembered (exact) search entry is a confirmation, even over a Letterboxd homonym');
  assert.equal(film(i, 'tt0000080').me.r, 4.5, 'title + year ±1 with a single candidate: linked');
  assert.equal(film(i, 'tt0000008').me.r, 4, 'Letterboxd record confirms the search hit: linked');
  const split = i.meta.ratedPending.find((p) => p.title === 'Split');
  assert.deepEqual(split.candidates.map((c) => c.id).sort(), ['tt0000040', 'tt0000041']);
  assert.equal(split.searchPick, 'tt0000041');
  assert.deepEqual(i.meta.ratedPending.map((p) => p.title).sort(), ['Split', 'Twin', 'Whole Affair'], 'Whole Affair has no search entry at all (pending before this change too)');
  const h = Qy.health(i);
  assert.equal(h.marcoRatedPendingTmdbMatch, 3);
  assert.equal(h.ambiguousTmdbMatch, 3, 'The Hand (watchlist), Split and Twin');
  assert.ok(h.ambiguousExamples.some((s) => /Split \(2016\).*tt0000040.*tt0000041/.test(s)));
});

test('CLI-1: every export row is linked or pending, never lost; ratings linked + pending = ratings rows', () => {
  const f = homonymFixture();
  const i = project(f);
  const rated = [...f.history.values()].filter((x) => x.rating != null).length;
  assert.equal(i.films.filter((x) => x.me.r != null).length + i.meta.ratedPending.length, rated);
});

// The audit's six cases (11/10/2026, commit d5f963e: "The Hand 2020, The Curse 2023, Manas 2024 left the watchlist set; Split 2016, Under the Skin 2013, The
// Conformist 1970 went from a wrong film to pending"), rebuilt 12/10/2026 on a fixture of the SAME SHAPES, not the same data (the test used to read the real
// caches and skip as soon as the nightly build moved their hash). What the fixture reproduces: a search hit that names a homonym, and the contradiction (or the
// missing confirmation) that stops the CLI from linking it. What it does NOT reproduce, case by case, as the real caches stood on 12/10/2026:
//   The Hand 2020    wrong hit tmdb:869169, a 21-minute short with no IMDb id; right film tt15165236 (Wong Kar-Wai, TMDB year 2021, slug the-hand-2020-1). Same shape.
//   The Curse 2023   wrong hit tmdb:1262809, a 20-minute short with no IMDb id; the right film is the series tt13623608 (591 min, slug the-curse-2023), which has
//                    NO movie record in the TMDB cache. The fixture's right film (95 min, tt0000204) does have one: it does not reproduce that gap.
//   Manas 2024       wrong hit tmdb:1388901 (97 min, no IMDb id); the right film tt27911420 (TMDB 1256408, year 2025) WAS already in the TMDB cache. The fixture's
//                    right film is named only by its Letterboxd record: it reproduces "no TMDB record", which is not what the real cache held.
//   Split 2016       two films, both WITH an IMDb id: tt3315656 (Kampmeier, 150 min, year 2016) is the wrong hit, tt4972582 (Shyamalan, 117 min, TMDB year 2017,
//                    Letterboxd 2016) is the right one. The fixture has both in 2016 and 117 min; the year disagreement is tested in the resolve tests instead.
//   Under the Skin   wrong hit tt4698852, a 19-minute short WITH an IMDb id (TMDB 698232); right film tt1441395 (Glazer, 108 min, TMDB year 2014). The fixture's
//                    wrong hit has NO IMDb id (tmdb:212), so it reproduces the under-40-minutes rule, not the real case.
//   The Conformist   wrong hit tmdb:1780713 (no IMDb id, 108 min); the right film tt0065571 (TMDB 8416, year 1971) had the Letterboxd slug the-conformist. The fixture
//                    has two films WITH IMDb ids and no Letterboxd record at all.
function auditFixture() {
  const m = (id, imdb, title, year, runtime) => movie(id, imdb, title, year, { runtime });
  const tmdb = { movie: Object.fromEntries([
    m(201, null, 'The Hand', 2020, 21), m(202, 'tt0000202', 'The Hand', 2020, 100),              // watchlist: search lands on the 21-minute short
    m(203, null, 'The Curse', 2023, 45), m(204, 'tt0000204', 'The Curse', 2023, 95),             // watchlist: search lands on the short (45 min here, 20 in the real cache)
    m(205, null, 'Manas', 2024, 60),                                                           // watchlist: search lands on a no-IMDb homonym; the real film is only named by its Letterboxd record here (in the real cache it had a TMDB record too)
    m(210, 'tt0000210', 'Split', 2016, 117), m(211, 'tt0000211', 'Split', 2016, 117),            // rated 3.5: Letterboxd names 210, the search says 211
    m(212, null, 'Under the Skin', 2013, 19), m(213, 'tt0000213', 'Under the Skin', 2013, 108),  // rated 4.5: search lands on the 19-minute short (no IMDb id here, one in the real cache)
    m(214, 'tt0000214', 'The Conformist', 1970, 113), m(215, 'tt0000215', 'The Conformist', 1970, 113), // rated 5: two films, no Letterboxd record (the real right film had one)
    m(216, 'tt0000216', 'Lone Film', 2000, 100),                                                 // rated 4: nothing contradicts, stays linked
  ]), search: { 'thehand|2020': { v: 201 }, 'thecurse|2023': { v: 203 }, 'manas|2024': { v: 205 }, 'split|2016': { v: 211 }, 'undertheskin|2013': { v: 212 },
    'theconformist|1970': { v: 214 }, 'lonefilm|2000': { v: 216 } } };
  const lb = (tmdbId, title, year) => ({ title, year, tmdbId, imdbId: `tt${String(tmdbId).padStart(7, '0')}`, r: 3.8, rn: 100, t: 1760000000000 });
  const friends = {
    films: { 'the-hand-2020': lb(202, 'The Hand', 2020), 'the-curse-2023': lb(204, 'The Curse', 2023), 'manas-2024': lb(206, 'Manas', 2024),
      'split-2016': lb(210, 'Split', 2016), 'under-the-skin-2013': lb(213, 'Under the Skin', 2013) },
    users: {}, following: { users: [] }, me: { slugs: [] }, lists: {},
    watchlist: { items: [['the-hand-2020', 'The Hand', 2020], ['the-curse-2023', 'The Curse', 2023], ['manas-2024', 'Manas', 2024]] },
  };
  const h = (title, year, o) => [`${title.toLowerCase().replace(/ /g, '')}|${year}`, { title, year, watched: false, rating: null, liked: false, watchlist: false, ...o }];
  const history = new Map([h('The Hand', 2020, { watchlist: true }), h('The Curse', 2023, { watchlist: true }), h('Manas', 2024, { watchlist: true }),
    h('Split', 2016, { watched: true, rating: 3.5 }), h('Under the Skin', 2013, { watched: true, rating: 4.5 }), h('The Conformist', 1970, { watched: true, rating: 5 }),
    h('Lone Film', 2000, { watched: true, rating: 4 })]);
  return { tmdb, friends, cfg: { letterboxd: 'marco', friends: [] }, history };
}

test('CLI-1: the six homonym cases from the audit are not attached to the wrong film (synthetic fixture of the same shapes)', () => {
  const i = project(auditFixture());
  // the three watchlist rows: the wrong hit (no IMDb id) is not on the watchlist, the film the live watchlist names is
  const wl = Qy.setOf(i, 'watchlist');
  assert.deepEqual([...wl].sort(), ['tt0000202', 'tt0000204', 'tt0000206']);
  for (const id of ['tmdb:201', 'tmdb:203', 'tmdb:205']) assert.equal(film(i, id).me.wl, false, id);
  // the three rated rows: pending with both candidates, never the wrong film and never silently the other one
  const pend = i.meta.ratedPending.map((p) => `${p.title} ${p.year}`).sort();
  assert.deepEqual(pend, ['Split 2016', 'The Conformist 1970', 'Under the Skin 2013']);
  for (const id of ['tt0000210', 'tt0000211', 'tmdb:212', 'tt0000213', 'tt0000214', 'tt0000215']) assert.equal(film(i, id).me.r, null, id);
  const under = i.meta.ratedPending.find((p) => p.title === 'Under the Skin');
  assert.equal(under.searchPick, 'tmdb:212');
  assert.deepEqual(under.candidates.map((c) => c.id).sort(), ['tmdb:212', 'tt0000213']);
  // the control: a lone, uncontradicted hit stays linked, and every rated row is linked or pending (4 rows = 1 + 3)
  assert.equal(film(i, 'tt0000216').me.r, 4);
  assert.equal(Qy.setOf(i, 'rated').size + pend.length, 4);
});

// ── CLI-2 (audit 11/10/2026): why finds the historical record by default and shows what weighed ──
function writeSnapshot(dir, { revision = 'b0ecaa658c3217aa3e99939541f26d1f86293160+runtime-1ac5', films = [], board = null, name = 's1', capturedAt = '2026-10-10T12:00:00.000Z' } = {}) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'manifest.json'), JSON.stringify({ id: `snap-${name}`, sourceRevision: revision, capturedAt }));
  const items = (ids) => ids.map((id) => ({ id, why: id === 'tt0000007' ? ['Themes: nostalgic, memory', 'You average 5.0★ on Andrei Tarkovsky (2 films)'] : [] }));
  fs.writeFileSync(path.join(dir, name, 'baseline.json'), JSON.stringify({ data: {
    plan: { board: board || [{ id: 'letin', items: items(['tt0000001', 'tt0000002', 'tt0000007', 'tt0000008', 'tt0000009']) }, { id: 'lift', items: items(['tt0000001']) }] },
    webData: { films: films.length ? films : [{ i: 'tt0000007', f: { letin: 0.62, wander: 0.66 }, ts: 2.36, q: 1.55, w: 0 }] } } }));
}

test('CLI-2: why decomposes the recorded moodRank into fit, taste and quality with weight × value, and names the heaviest', () => {
  const i = idx();
  const dir = mk('films-why2-');
  writeSnapshot(dir);
  const r = Qy.why(i, 'tt0000007', { revision: 'b0ecaa6', row: 'letin', snapshots: dir }).recorded;
  assert.equal(r.position, 3);
  assert.equal(r.of, 5);
  assert.deepEqual(r.why, ['Themes: nostalgic, memory', 'You average 5.0★ on Andrei Tarkovsky (2 films)']);
  assert.deepEqual(r.rank.components, [
    { name: 'fitNorm', value: 0.62, weight: 1.1, product: 0.68 },
    { name: 'taste', value: 2.36, weight: 1, product: 2.36 },
    { name: 'quality', value: 1.55, weight: 0.55, product: 0.85 }]);
  assert.equal(r.rank.heaviest, 'taste');
  assert.match(r.rank.note, /rounded/);
  assert.match(r.rank.note, /fitNorm = fit \/ \(minFit × 1\.75\)/);
});

test('CLI-2: the moodRank weights in the CLI are the ones in lib/rows.js', () => {
  // Fase A, 12/10/2026: lib/rows.js W gained lists (0.3 × lw) and vouch (0.15); the old pattern matched three keys and failed ("W not found").
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'rows.js'), 'utf8');
  const m = src.match(/const W = \{ fit: ([\d.]+), taste: ([\d.]+), quality: ([\d.]+), lists: ([\d.]+), vouch: ([\d.]+) \}/);
  assert.ok(m, 'lib/rows.js W not found');
  assert.deepEqual(Qy.RANK_WEIGHTS, { fit: Number(m[1]), taste: Number(m[2]), quality: Number(m[3]), lists: Number(m[4]), vouch: Number(m[5]) });
  assert.ok(src.includes('if (c.lw) s += W.lists * c.lw;'), 'lists term: 0.3 × lw');
  assert.ok(src.includes('if (c.cv) s += W.vouch;'), 'vouch term: +0.15 when vouched');
});

test('CLI-2 (Fase A): the recorded lists (0.3 × lw) and vouch (+0.15) terms enter the decomposition; a record without them says so, never invents them', () => {
  const i = idx();
  const dir = mk('films-why7-');
  writeSnapshot(dir, { films: [{ i: 'tt0000007', f: { letin: 0.62 }, ts: 1, q: 1, w: 0, lw: 0.4, cv: 1 }] });
  const rank = Qy.why(i, 'tt0000007', { revision: 'b0ecaa6', row: 'letin', snapshots: dir }).recorded.rank;
  assert.deepEqual(rank.extras, [{ name: 'lists', value: 0.4, weight: 0.3, product: 0.12 }, { name: 'vouch', product: 0.15 }]);
  assert.equal(rank.sumOfRecordedParts, +(0.68 + 1 + 0.55 + 0.12 + 0.15).toFixed(2));
  assert.doesNotMatch(rank.note, /Not recorded in this record/);
  assert.match(rank.formula, /0\.3×lists, \+ 0\.15 vouch/);
  // a record that carries neither: the note names both terms as not recorded, and no extra is made up
  const bare = mk('films-why8-');
  writeSnapshot(bare);
  const none = Qy.why(i, 'tt0000007', { revision: 'b0ecaa6', row: 'letin', snapshots: bare }).recorded.rank;
  assert.deepEqual(none.extras, []);
  assert.match(none.note, /Not recorded in this record: lists \(0\.3×lw\), vouch \(\+0\.15\)/);
  // only the vouch recorded: the lists term alone is reported as missing
  const half = mk('films-why9-');
  writeSnapshot(half, { films: [{ i: 'tt0000007', f: { letin: 0.62 }, ts: 1, q: 1, w: 0, cv: 1 }] });
  const h = Qy.why(i, 'tt0000007', { revision: 'b0ecaa6', row: 'letin', snapshots: half }).recorded.rank;
  assert.deepEqual(h.extras, [{ name: 'vouch', product: 0.15 }]);
  assert.match(h.note, /Not recorded in this record: lists \(0\.3×lw\);/);
});

test('CLI-2: a row that is not in the snapshot is "linha desconhecida" with the valid rows; a mood row without a fit says why', () => {
  const i = idx();
  const dir = mk('films-why2-');
  writeSnapshot(dir);
  const r = Qy.why(i, 'tt0000007', { revision: 'b0ecaa6', row: 'nope', snapshots: dir }).recorded;
  assert.equal(r.status, 'unknown-row');
  assert.equal(r.message, 'linha desconhecida: nope; linhas válidas: letin, lift');
  const lift = Qy.why(i, 'tt0000001', { revision: 'b0ecaa6', row: 'lift', snapshots: dir }).recorded;
  assert.equal(lift.position, 1);
  assert.equal(lift.rank, undefined, 'no recorded fit for this film in this row: no decomposition is invented');
});

test('CLI-2: the historical record is found by default under <root>/.context/learning-private/snapshots, or MOOD_SNAPSHOTS, and a miss names the path', () => {
  const root = writeRoot();
  const indexFile = path.join(root, '.context', 'films', 'index.json');
  const miss = run(['why', 'tt0000007', '--revision', 'b0ecaa6', '--index', indexFile], { root }).recorded;
  assert.equal(miss.status, 'snapshots-not-found');
  assert.equal(miss.message, `registro histórico não encontrado em ${path.join(root, '.context', 'learning-private', 'snapshots')}; passe --snapshots`);
  writeSnapshot(path.join(root, '.context', 'learning-private', 'snapshots'));
  const hit = run(['why', 'tt0000007', '--revision', 'b0ecaa6', '--row', 'letin', '--index', indexFile], { root }).recorded;
  assert.equal(hit.position, 3);
  const other = mk('films-envsnap-');
  writeSnapshot(other, { board: [{ id: 'letin', items: [{ id: 'tt0000007', why: ['from env'] }] }] });
  const saved = process.env.MOOD_SNAPSHOTS;
  process.env.MOOD_SNAPSHOTS = other;
  try {
    assert.deepEqual(run(['why', 'tt0000007', '--revision', 'b0ecaa6', '--row', 'letin', '--index', indexFile], { root }).recorded.why, ['from env']);
    assert.equal(run(['why', 'tt0000007', '--revision', 'b0ecaa6', '--row', 'letin', '--snapshots', path.join(root, '.context', 'learning-private', 'snapshots'), '--index', indexFile], { root }).recorded.position, 3, '--snapshots beats the variable');
  } finally { if (saved === undefined) delete process.env.MOOD_SNAPSHOTS; else process.env.MOOD_SNAPSHOTS = saved; }
});

test('CLI-2: --now is labelled as today\'s calculation that does not prove the past decision, and says what it cannot recompute', () => {
  const i = idx();
  i.moods = [{ id: 'letin', name: 'Let it in', genres: { Drama: 1.2 }, keywords: { friendship: 1 }, minFit: 2.2 }];
  const w = Qy.why(i, 'tt0000007', { now: true });
  assert.match(w.moodRankNow.note, /today/i);
  assert.match(w.moodRankNow.note, /does not prove/);
  assert.match(w.moodRankNow.note, /taste and quality z-scores/);
  assert.equal(w.moodRankNow.rows[0].mood, 'letin');
  assert.equal(w.moodRankNow.rows[0].fitTerm, +(1.1 * Math.min(2.2 / (2.2 * 1.75), 1.6)).toFixed(2));
});

// ── Fanny and Alexander (Marco, 11/10/2026): he saw the 312-minute TV version (5★); the 188-minute cinema cut is another IMDb/Letterboxd record ──
test('check --unseen still passes the cinema cut (the build does too), but carries a caution naming the seen version; remakes decades apart get none', () => {
  const f = fixture();
  const [k, v] = movie(90, 'tt0083922', 'Fanny and Alexander', 1982, { runtime: 188 });
  f.tmdb.movie[k] = v;
  f.friends.films['fanny-and-alexander'] = { title: 'Fanny and Alexander', year: 1982, tmdbId: 90, imdbId: 'tt0083922', r: 4.4, rn: 79000, rt: 188, t: 1760000000000 };
  f.friends.films['fanny-and-alexander-1984'] = { title: 'Fanny and Alexander', year: 1984, tmdbId: 33153, imdbId: 'tt6725158', r: 4.5, rn: 22000, rt: 312, t: 1760000000000 };
  f.friends.me.slugs.push('fanny-and-alexander-1984');
  const i = project(f);
  const [c] = Qy.check(i, ['tt0083922'], { unseen: true, eligible: true });
  assert.equal(c.pass, true, 'seen stays what the build says it is: the CLI does not diverge from lib/guard.js');
  assert.equal(c.caution.length, 1);
  assert.match(c.caution[0], /tt6725158.*1984.*312 min/);
  assert.match(c.caution[0], /different cut or version/);
  const [s] = Qy.check(i, ['tt0000013'], { unseen: true }); // Scarface 1932; Marco saw Scarface 1983, fifty years apart
  assert.equal(s.caution, undefined);
  assert.equal(Qy.relatedSeen(i, film(i, 'tt0083922')).length, 1);
});

test('CLI-2: the fit term is capped at 1.6 like lib/rows.js, and the watchlist and pin extras are listed when the snapshot recorded them', () => {
  const i = idx();
  const dir = mk('films-why3-');
  writeSnapshot(dir, { films: [{ i: 'tt0000007', f: { letin: 2.0 }, ts: 1, q: 1, w: 1, pins: ['letin'] }] });
  const rank = Qy.why(i, 'tt0000007', { revision: 'b0ecaa6', row: 'letin', snapshots: dir }).recorded.rank;
  assert.deepEqual(rank.components[0], { name: 'fitNorm', value: 1.6, weight: 1.1, product: 1.76 });
  assert.deepEqual(rank.extras, [{ name: 'watchlist', product: 0.35 }, { name: 'pin', product: 10 }]);
  assert.equal(rank.sumOfRecordedParts, +(1.76 + 1 + 0.55 + 0.35 + 10).toFixed(2));
  assert.equal(rank.heaviest, 'pin', 'a pin (+10) outweighs every component; the field must say so');
});

test('CLI-1: year handling — exact year beats ±1; ±1 candidates count as homonyms; two Letterboxd records for one title and year are ambiguous; a stale-year search pick next to a real homonym is not linked', () => {
  const f = fixture();
  const add = (id, title, year) => { const [k, v] = movie(id, `tt00001${id}`, title, year); f.tmdb.movie[k] = v; };
  add(100, 'Drift', 2013); add(101, 'Drift', 2014);             // exact year wins: 101 is not a rival for an export year of 2013
  add(110, 'Echo', 2014); add(111, 'Echo', 2014);               // export says 2013: both are ±1, so both are rivals
  add(120, 'Pair', 2019); add(121, 'Pair', 2019);               // two Letterboxd records, one title and year
  add(130, 'Odd Year', 2015); add(131, 'Odd Year', 2010);       // search pick says 2015, export says 2010 and a real 2010 film exists
  const lbrec = (tmdbId, title, year) => ({ title, year, tmdbId, imdbId: `tt00001${tmdbId}`, r: 3.6, rn: 100, t: 1760000000000 });
  f.friends.films['pair-a'] = lbrec(120, 'Pair', 2019);
  f.friends.films['pair-b'] = lbrec(121, 'Pair', 2019);
  Object.assign(f.tmdb.search, { 'drift|2013': { v: 100 }, 'echo|2013': { v: 110 }, 'pair|2019': { v: 120 }, 'oddyear|2010': { v: 130 } });
  for (const [t, y, r] of [['Drift', 2013, 4], ['Echo', 2013, 3], ['Pair', 2019, 5], ['Odd Year', 2010, 2]]) f.history.set(`${t.toLowerCase().replace(/ /g, '')}|${y}`, { title: t, year: y, watched: true, rating: r, liked: false, watchlist: false });
  const i = project(f);
  assert.equal(film(i, 'tt00001100').me.r, 4, 'Drift 2013 links to the 2013 film; the 2014 one is not a rival');
  assert.deepEqual(i.meta.ratedPending.map((p) => p.title).sort(), ['Echo', 'Odd Year', 'Pair', 'Whole Affair']);
  const cands = (t) => i.meta.ratedPending.find((p) => p.title === t).candidates.map((c) => c.id).sort();
  assert.deepEqual(cands('Echo'), ['tt00001110', 'tt00001111']);
  assert.deepEqual(cands('Pair'), ['tt00001120', 'tt00001121']);
  assert.deepEqual(cands('Odd Year'), ['tt00001130', 'tt00001131']);
});

// ── why without --revision: the newest snapshot that has the film (Marco asks "why did Mirror enter Let it in?", never with a sha) ──
test('why without --revision: the newest record by capturedAt is `recorded`, labelled, with every row of that snapshot; the older ones are in otherRecords', () => {
  const i = idx();
  const dir = mk('films-why4-');
  const item = (id) => ({ id, why: [`why ${id}`] });
  const web = (letin) => [{ i: 'tt0000007', f: { letin, lift: 0.9 }, ts: 2, q: 1, w: 0 }];
  writeSnapshot(dir, { name: 'zz-old', revision: 'aaa111aaa111aaa', capturedAt: '2026-10-09T12:00:00.000Z', films: web(0.5),
    board: [{ id: 'letin', items: [item('tt0000001'), item('tt0000002'), item('tt0000007')] }] });
  writeSnapshot(dir, { name: 'aa-new', revision: 'bbb222bbb222bbb', capturedAt: '2026-10-10T12:00:00.000Z', films: web(0.7),
    board: [{ id: 'tonight', items: [item('tt0000001'), item('tt0000007')] }, { id: 'letin', items: [item('tt0000007'), item('tt0000001')] }, { id: 'lift', items: [item('tt0000001'), item('tt0000002'), item('tt0000007')] }] });
  const w = Qy.why(i, 'tt0000007', { snapshots: dir });
  assert.equal(w.recorded.position, 1, 'the newest snapshot wins even though its folder name sorts first/last');
  assert.equal(w.recorded.label, 'registro mais recente encontrado (2026-10-10, revisão bbb222bbb222)');
  assert.equal(w.recorded.rank.components[0].value, 0.7);
  assert.equal(w.revision, 'bbb222bbb222', 'the top-level revision is the one found, not "unknown"');
  assert.equal(w.recorded.row, 'letin', 'the row with a recorded moodRank leads even though tonight comes first in the board');
  assert.equal(w.recorded.rows[2].rank.components[0].value, 0.9, 'each row carries its own decomposition');
  assert.deepEqual(w.recorded.rows.map((r) => [r.row, r.position, r.of]), [['tonight', 2, 2], ['letin', 1, 2], ['lift', 3, 3]]);
  assert.deepEqual(w.otherRecords, [{ revision: 'aaa111aaa111', capturedAt: '2026-10-09T12:00:00.000Z', rows: [{ row: 'letin', position: 3, of: 3 }] }]);
  const only = Qy.why(i, 'tt0000007', { snapshots: dir, row: 'lift' });
  assert.deepEqual(only.recorded.rows.map((r) => r.row), ['lift']);
  assert.equal(only.otherRecords, undefined, 'the older snapshot never had the film in lift');
  assert.equal(Qy.why(i, 'tt0000007', { snapshots: dir, row: 'nope' }).recorded.message, 'linha desconhecida: nope; linhas válidas: tonight, letin, lift');
});

test('why without --revision: no snapshot has the film → says so with the folder; through the CLI the default folder is searched', () => {
  const i = idx();
  const dir = mk('films-why5-');
  writeSnapshot(dir);
  const none = Qy.why(i, 'tt0000003', { snapshots: dir }).recorded;
  assert.equal(none.status, 'no-record');
  assert.equal(none.message, `nenhum registro histórico com este filme em ${dir}`);
  const root = writeRoot();
  const indexFile = path.join(root, '.context', 'films', 'index.json');
  const miss = run(['why', 'tt0000007', '--index', indexFile], { root }).recorded;
  assert.equal(miss.status, 'snapshots-not-found');
  writeSnapshot(path.join(root, '.context', 'learning-private', 'snapshots'));
  const hit = run(['why', 'tt0000007', '--index', indexFile], { root }).recorded;
  assert.equal(hit.position, 3);
  assert.match(hit.label, /^registro mais recente encontrado \(2026-10-10, revisão b0ecaa658c32\)$/);
});

// ── independent review of d5f963e + ba81865 ──
test('P1-1: heaviest counts the extras — Local Hero (watchlist 0.35 > fitNorm 0.29 × 1.1 = 0.32) is "watchlist"; a pin is "pin"', () => {
  const i = idx();
  const dir = mk('films-heavy-');
  writeSnapshot(dir, { films: [{ i: 'tt0000007', f: { lift: 0.29 }, ts: 0.1, q: 0.1, w: 1 }], board: [{ id: 'lift', items: [{ id: 'tt0000007', why: [] }] }] });
  const rank = Qy.why(i, 'tt0000007', { revision: 'b0ecaa6', row: 'lift', snapshots: dir }).recorded.rank;
  assert.equal(rank.components[0].product, 0.32);
  assert.equal(rank.heaviest, 'watchlist');
});

test('P2-6/P2-7: the extras and the cap in the CLI are the ones in lib/rows.js', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'rows.js'), 'utf8');
  assert.ok(src.includes(`Math.min(f.norm, ${Qy.FIT_CAP})`), 'fit cap');
  assert.ok(src.includes(`if (c.watchlist) s += ${Qy.EXTRAS.watchlist};`), 'watchlist bonus');
  assert.ok(src.includes(`if (c.pins?.includes(mood.id)) s += ${Qy.EXTRAS.pin};`), 'pin bonus');
  assert.ok(src.includes(`s += ${Qy.EXTRAS.recCount} * Math.log2(1 + c.recCount)`), 'recCount coefficient');
  const moods = fs.readFileSync(path.join(ROOT, 'lib', 'moods.js'), 'utf8');
  assert.ok(moods.includes(`s / ((mood.minFit ?? 2) * ${Qy.FIT_NORM_DIVISOR})`), 'fitNorm = fit / (minFit × 1.75)');
});

test('P2-1: a search pick with no IMDb id that runs under 40 minutes is pending; a feature-length one without IMDb stays linked', () => {
  const f = fixture();
  for (const [id, title, rt, imdb] of [[144, 'Real Short', 20, 'tt0000144'], [140, 'One Day', 3], [141, 'Quiet Feature', 100], [142, 'Short Edge', 39], [143, 'Long Edge', 40]]) { const [k, v] = movie(id, imdb || null, title, 2024, { runtime: rt }); f.tmdb.movie[k] = v; }
  Object.assign(f.tmdb.search, { 'oneday|2024': { v: 140 }, 'quietfeature|2024': { v: 141 }, 'shortedge|2024': { v: 142 }, 'longedge|2024': { v: 143 }, 'realshort|2024': { v: 144 } });
  f.history.set('realshort|2024', { title: 'Real Short', year: 2024, watched: true, rating: 3.5, liked: false, watchlist: false });
  for (const [t, r] of [['Short Edge', 2], ['Long Edge', 2.5]]) f.history.set(`${t.toLowerCase().replace(/ /g, '')}|2024`, { title: t, year: 2024, watched: true, rating: r, liked: false, watchlist: false });
  f.history.set('oneday|2024', { title: 'One Day', year: 2024, watched: true, rating: 4, liked: false, watchlist: false });
  f.history.set('quietfeature|2024', { title: 'Quiet Feature', year: 2024, watched: true, rating: 3, liked: false, watchlist: false });
  const i = project(f);
  assert.equal(film(i, 'tmdb:140').me.r, null, 'a 3-minute short with no IMDb id is not "One Day (2024)" 4★');
  assert.equal(film(i, 'tmdb:141').me.r, 3);
  assert.equal(film(i, 'tt0000144').me.r, 3.5, 'a short WITH an IMDb id is a real film Marco may have rated');
  assert.equal(film(i, 'tmdb:142').me.r, null, '39 minutes is under the limit');
  assert.equal(film(i, 'tmdb:143').me.r, 2.5, '40 minutes is not');
  const p = i.meta.ratedPending.find((x) => x.title === 'One Day');
  assert.equal(p.reason, 'short-without-imdb');
  assert.deepEqual(p.candidates.map((c) => c.id), ['tmdb:140']);
});

test('P2-2: titles that normalise to nothing group nothing; two films with known, different directors are not one film', () => {
  const f = fixture();
  const add = (id, imdb, title, year, extra = {}) => { const [k, v] = movie(id, imdb, title, year, extra); f.tmdb.movie[k] = v; };
  add(150, 'tt0000150', 'ウシュピズィン', 2004); add(151, 'tt0000151', 'となりのトトロ', 2005);   // both normalise to ""
  add(152, 'tt0000152', 'The Girl Next Door', 2004); add(153, 'tt0000153', 'The Girl Next Door', 2007);   // different directors (movie() makes them unique)
  const dir = [{ id: 7, name: 'Same Director' }];
  add(154, 'tt0000154', 'Remade', 2010, { directors: dir }); add(155, 'tt0000155', 'Remade', 2012, { directors: dir });
  for (const [slug, tt, t, y, tm] of [['a', 'tt0000151', 'となりのトトロ', 2005, 151], ['b', 'tt0000153', 'The Girl Next Door', 2007, 153], ['c', 'tt0000155', 'Remade', 2012, 155]])
    f.friends.films[`seen-${slug}`] = { title: t, year: y, tmdbId: tm, imdbId: tt, r: 3.6, rn: 100, t: 1760000000000 };
  f.friends.me.slugs.push('seen-a', 'seen-b', 'seen-c');
  const i = project(f);
  assert.deepEqual(Qy.relatedSeen(i, film(i, 'tt0000150')), [], 'empty normalised title relates nothing');
  assert.deepEqual(Qy.relatedSeen(i, film(i, 'tt0000152')), [], 'known different directors: not a version of the same film');
  assert.deepEqual(Qy.relatedSeen(i, film(i, 'tt0000154')).map((o) => o.id), ['tt0000155'], 'a shared director keeps the caution');
  // with no directors on either side only the 3-year window separates a version from a remake
  f.friends.films['old-nodir'] = { title: 'Lonely Remake', year: 1950, imdbId: 'tt0000160', r: 3.6, rn: 100, t: 1760000000000 };
  f.friends.films['new-nodir'] = { title: 'Lonely Remake', year: 2005, imdbId: 'tt0000161', r: 3.6, rn: 100, t: 1760000000000 };
  f.friends.me.slugs.push('new-nodir');
  const j = project(f);
  assert.deepEqual(Qy.relatedSeen(j, film(j, 'tt0000160')), [], 'fifty-five years apart: a remake, not a cut');
  assert.equal(Qy.resolve(i, '!!!').none, '!!!', 'a query that normalises to nothing matches nothing, not 1,000 films');
});

test('P2-3: why keeps the reasons of every row it lists', () => {
  const i = idx();
  const dir = mk('films-why6-');
  writeSnapshot(dir, { films: [{ i: 'tt0000007', f: { letin: 0.6 }, ts: 1, q: 1, w: 0 }],
    board: [{ id: 'tonight', items: [{ id: 'tt0000007', why: ['because tonight'] }] }, { id: 'letin', items: [{ id: 'tt0000007', why: ['because letin'] }] }] });
  const r = Qy.why(i, 'tt0000007', { snapshots: dir }).recorded;
  assert.deepEqual(r.rows.map((x) => [x.row, x.why]), [['tonight', ['because tonight']], ['letin', ['because letin']]]);
});

test('P2-4: two captures at the same instant — the one with a real revision beats "local", and the tie is reported', () => {
  const i = idx();
  const dir = mk('films-tie-');
  const at = '2026-10-10T12:00:00.000Z';
  writeSnapshot(dir, { name: 'aa-real', revision: 'b0ecaa658c3217aa+runtime-x', capturedAt: at });
  writeSnapshot(dir, { name: 'zz-local', revision: 'local', capturedAt: at });
  const w = Qy.why(i, 'tt0000007', { snapshots: dir });
  assert.equal(w.recorded.label, 'registro mais recente encontrado (2026-10-10, revisão b0ecaa658c32)');
  assert.equal(w.recorded.empate, true);
  assert.deepEqual(w.recorded.revisoesEmpatadas, ['b0ecaa658c32', 'local']);
  const dir2 = mk('films-tie2-');
  writeSnapshot(dir2, { name: 'zz-real', revision: 'b0ecaa658c3217aa+runtime-x', capturedAt: at });
  writeSnapshot(dir2, { name: 'aa-local', revision: 'local', capturedAt: at });
  assert.equal(Qy.why(i, 'tt0000007', { snapshots: dir2 }).recorded.label.includes('b0ecaa658c32'), true, 'independent of the folder names');
  const dir3 = mk('films-tie4-');
  writeSnapshot(dir3, { name: 'zz', revision: 'bbbbbbbbbbbbbbbb', capturedAt: at });
  writeSnapshot(dir3, { name: 'aa', revision: 'aaaaaaaaaaaaaaaa', capturedAt: at });
  const both = Qy.why(i, 'tt0000007', { snapshots: dir3 }).recorded;
  assert.deepEqual(both.revisoesEmpatadas, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'], 'two real revisions: folder name order, always the same one');
  const alone = Qy.why(i, 'tt0000007', { snapshots: mkSingle() }).recorded;
  assert.equal(alone.empate, undefined);
  function mkSingle() { const d = mk('films-tie3-'); writeSnapshot(d); return d; }
});

test('P2-8: changing tools/films/query.js invalidates the index signature', () => {
  const { signature } = require('./store');
  const root = mk('films-sig-');
  fs.mkdirSync(path.join(root, 'tools', 'films'), { recursive: true });
  const q = path.join(root, 'tools', 'films', 'query.js');
  fs.writeFileSync(q, '// v1\n');
  const a = signature(root);
  fs.writeFileSync(q, '// v2 longer\n');
  assert.notEqual(signature(root), a);
});

// ── Fase A (12/10/2026): the current rule — a vouched film needs 2.5 (or no average); fan lists grant nothing; a director's own film is no love ──
// Files on disk, so the whole path is exercised: store.readSources → lib/list-signal vouchedFromCaches, lib/static-lists filmsFor, lib/directors-loved.
function writeRulesRoot() {
  const f = fixture();
  const add = (id, imdb, title, year, extra) => { const [k, v] = movie(id, imdb, title, year, extra); f.tmdb.movie[k] = v; };
  const lbrec = (tmdbId, imdb, title, year, r) => ({ title, year, tmdbId, imdbId: imdb, ...(r != null ? { r, rn: 100 } : {}), t: 1760000000000 });
  const rows = [[201, 'Vouched Low', 2.6], [202, 'Vouched Too Low', 2.4], [203, 'Vouched Floor', 2.5], [204, 'Vouched No Average', null], [205, 'Fan Only', 3.0], [206, 'Director List', 3.0],
    [207, 'Loved Film', 3.0], [208, 'Own Film', 3.0], [211, 'Vouched And Good', 3.9]];
  for (const [id, title, r] of rows) { add(id, `tt0000${id}`, title, 2010); f.friends.films[`s${id}`] = lbrec(id, `tt0000${id}`, title, 2010, r); }
  add(208, 'tt0000208', 'Own Film', 2010, { directors: [{ id: 99, name: 'Jane Auteur' }] }); // she directed it
  add(209, 'tt0000209', 'Static Only', 2011); // in the TMDB cache, no Letterboxd record: only the static list names it
  const root = mk('films-rules-');
  const w = (rel, data) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), typeof data === 'string' ? data : JSON.stringify(data)); };
  const list = (id, name, trust, extra = {}) => ({ id, name, trust, ...extra });
  f.cfg.lists = [list('crit', 'Critics Pick', 'critic'), list('dirl', 'Directors Pick', 'director'), list('fan', 'Fans Pick', 'fan'), list('stat', 'Static Pick', 'critic', { source: 'static', file: 'data/lists/stat.json' })];
  f.cfg.directorsLoved = { include: ['Jane Auteur'] };
  f.cfg.moods = [{ id: 'slow', name: 'Slow', genres: { Drama: 1 }, minFit: 1 }, { id: 'lift', name: 'Lift', genres: { Drama: 1 }, minFit: 1 }];
  const items = (...ids) => ids.map((id) => [`s${id}`, `t${id}`, 2010]);
  w('cache/tmdb.json', f.tmdb); w('cache/friends.json', f.friends); w('config.json', f.cfg);
  w('cache/lists.json', { lists: { crit: { items: items(201, 202, 203, 204, 211) }, dirl: { items: items(206) }, fan: { items: items(205) } } });
  w('data/lists/stat.json', { id: 'stat', source: { publication: 'Test', title: 'Static Pick', url: 'https://example.org/stat', edition: '2025-01-01', readOn: '2026-10-12' },
    items: [{ slug: 'static-only', title: 'Static Only', year: 2011, imdb: 'tt0000209', tmdb: 209, tmdbType: 'movie' }] });
  const src = (id) => ({ id, confidence: 'high', kind: 'interview', url: 'https://example.org/i', title: 'Interview', date: '2020-01-01' });
  const lf = (title, id, year) => ({ title, imdb: `tt0000${id}`, tmdb: id, tmdbType: 'movie', year, sources: ['jane1'] });
  w('data/directors-loved.json', { directors: [{ name: 'Jane Auteur', sources: [src('jane1')], films: [lf('Loved Film', 207, 2010), lf('Own Film', 208, 2010), lf('Ghost Film', 210, 2012)] }] });
  w('data/letterboxd/ratings.csv', 'Date,Name,Year,Letterboxd URI,Rating\n');
  return root;
}
const rulesIndex = () => load(writeRulesRoot(), { indexFile: mkfile(`films-rules-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`) }).index;

test('Fase A eligibility: a vouched film passes at 2.5 and with no average, fails at 2.4; a fan list grants nothing; vouch never rescues below its floor', () => {
  const i = rulesIndex();
  const e = (n) => film(i, `tt0000${n}`);
  assert.equal(e(201).elig, true, 'critic list, 2.6 ≥ 2.5');
  assert.equal(e(201).onlyByException, true);
  assert.equal(e(201).cv, true);
  assert.equal(e(201).cvList, 'Critics Pick');
  assert.equal(e(201).cvTrust, 'critic');
  assert.match(e(201).eligWhy, /Critics Pick/);
  assert.equal(e(202).elig, false, 'critic list but 2.4 < the 2.5 floor of a vouched film');
  assert.match(e(202).eligWhy, /vouched.*2\.4 < 2\.5/);
  assert.equal(e(203).elig, true, '2.5 exactly is the floor, inclusive');
  assert.equal(e(204).elig, true, 'a vouched film with no average at all still passes');
  assert.equal(e(204).lb, null);
  assert.equal(e(205).elig, false, 'a fan list grants nothing: 3.0 is below 3.5');
  assert.equal(e(205).cv, false);
  assert.match(e(205).eligWhy, /not vouched/);
  assert.equal(e(206).elig, true, 'a director list vouches too');
  assert.equal(e(206).cvTrust, 'director');
  assert.equal(e(211).elig, true);
  assert.equal(e(211).onlyByException, false, '3.9 passes on the average; the vouch is not what lets it in');
  assert.match(e(211).eligWhy, /Letterboxd 3\.90/);
  assert.equal(film(i, 'tt0000007').elig, true, 'unvouched community 3.9 still qualifies (OR kept)');
  assert.equal(film(i, 'tt0000007').cv, false);
  assert.equal(film(i, 'tt0000001').elig, false, '3.49 unvouched stays out');
});

test('Fase A eligibility: a favourite director\'s love lets a 3.0 film in, but a director\'s love of their OWN film is no vouch', () => {
  const i = rulesIndex();
  const loved = film(i, 'tt0000207');
  assert.equal(loved.elig, true);
  assert.equal(loved.onlyByException, true);
  assert.equal(loved.cvTrust, 'director');
  assert.match(loved.eligWhy, /Loved by Auteur/);
  const own = film(i, 'tt0000208');
  assert.equal(own.cv, false, 'Jane Auteur directed Own Film (TMDB record joined by IMDb id): her love of it is left out');
  assert.equal(own.elig, false);
});

test('Fase A eligibility: a static-list film with no Letterboxd record is vouched through the overlay; a director\'s film no cache knows is counted, not invented', () => {
  const i = rulesIndex();
  const s = film(i, 'tt0000209');
  assert.equal(s.lb, null);
  assert.equal(s.elig, true, 'the static critic list names it: vouched, no average');
  assert.equal(s.cvList, 'Static Pick');
  assert.equal(film(i, 'tt0000210'), undefined, 'Ghost Film is in no cache: no record is made up for it');
  assert.equal(i.meta.lovedWithoutRecord, 1);
  assert.equal(Qy.health(i).lovedWithoutRecord, 1);
  const h = Qy.health(i);
  assert.equal(h.eligibleOnlyByException, [201, 203, 204, 206, 207, 209].length);
  assert.equal(h.vouched, [201, 202, 203, 204, 206, 207, 209, 211].length);
});

test('Fase A eligibility: project() takes the vouched sets from outside and hands the loved function records with Marco\'s ratings already resolved', () => {
  const f = fixture();
  let sawRated = null;
  const i = project({ ...f, vouched: new Map([['tt0000001', { list: 'A critic list', trust: 'critic' }]]),
    loved: (records) => { sawRated = records.filter((r) => r.me.r != null).length; return new Map([['tt0000003', { list: 'Loved by your directors', trust: 'director', why: 'Loved by Someone · interview (2020)' }]]); } });
  assert.equal(film(i, 'tt0000001').elig, true, 'community 3.49 < 3.5 but vouched and above the 2.5 floor');
  assert.equal(film(i, 'tt0000001').eligWhy, 'in “A critic list”, a critics\' list');
  assert.equal(film(i, 'tt0000003').elig, true, 'community 3.0, loved by a favourite director');
  assert.equal(film(i, 'tt0000003').eligWhy, 'Loved by Someone · interview (2020)');
  assert.equal(film(i, 'tt0000009').elig, false, 'no average, not vouched: waits');
  assert.ok(sawRated >= 3, `the loved function ran after the export ratings were linked (saw ${sawRated} rated records)`);
  const none = project(fixture());
  assert.equal(film(none, 'tt0000001').elig, false, 'without any vouched set the rule is the plain 3.5 / friend one');
  assert.equal(film(none, 'tt0000001').cv, false);
});

test('Fase A store: the signature follows data/directors-loved.json, every data/lists/*.json and the lib files the vouched sets come from', () => {
  const { signature, sourceFiles } = require('./store');
  const root = writeRulesRoot();
  assert.ok(sourceFiles(root).includes('data/lists/stat.json'));
  assert.ok(sourceFiles(root).includes('data/directors-loved.json'));
  const a = signature(root);
  fs.writeFileSync(path.join(root, 'data', 'lists', 'stat.json'), fs.readFileSync(path.join(root, 'data', 'lists', 'stat.json'), 'utf8') + '\n\n');
  const b = signature(root);
  assert.notEqual(b, a, 'a changed static list changes who is vouched');
  fs.writeFileSync(path.join(root, 'data', 'directors-loved.json'), fs.readFileSync(path.join(root, 'data', 'directors-loved.json'), 'utf8') + '\n\n');
  assert.notEqual(signature(root), b, 'a changed directors file changes who is loved');
  const store = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf8');
  for (const rel of ['lib/list-signal.js', 'lib/directors-loved.js', 'lib/static-lists.js', 'lib/critic-subset.js', 'lib/taste.js']) assert.ok(store.includes(`'${rel}'`), `${rel} shapes the projection and must be in CODE`);
});

// ── Fase A: moods from config.json, taste --limit 0, check --fields ──
test('Fase A: the help lists the moods of the checkout\'s config.json (not a hand-kept list) and search --mood slow is accepted', () => {
  const root = writeRulesRoot();
  const usage = run(['--help'], { root }).usage;
  assert.match(usage, /moods in config\.json: slow lift\n?$/);
  assert.ok(!usage.includes('wander music'), 'the old hand-written eight are gone');
  const indexFile = path.join(root, '.context', 'films', 'index.json');
  const r = run(['search', '--mood', 'slow', '--index', indexFile], { root });
  assert.ok(r.constraints.includes('mood=slow'));
  assert.throws(() => run(['search', '--mood', 'nope', '--index', indexFile], { root }), /unknown mood nope; known: slow, lift/);
});

test('Fase A: the real config.json has the nine legacy moods first (and the 21 of the v2 Board after), and `slow` is one of the nine', () => {
  // PR5 (14/10/2026): config.json "moods" holds the nine of the legacy family first and then the 21 of the v2 Board (board.legacyMoods names the nine); the CLI lists every mood of config.json
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const ids = config.moods.map((m) => m.id);
  assert.equal(config.board.legacyMoods.length, 9);
  assert.deepEqual(ids.slice(0, 9), config.board.legacyMoods);
  assert.ok(config.board.legacyMoods.includes('slow'));
  assert.deepEqual([...ids].sort(), config.board.moodMenu.filter((id) => id !== 'friends-week').sort(), 'every mood of config.json is an option of the Moods menu, and the menu has no other mood');
  assert.match(run(['--help'], { root: ROOT }).usage, new RegExp(`moods in config\\.json: ${ids.join(' ')}$`));
});

test('Fase A: taste --limit 0 returns every row, like the other commands; the default stays 20', () => {
  const { norm } = require('../../lib/util');
  const f = fixture();
  const root = mk('films-taste-');
  const lines = ['Date,Name,Year,Letterboxd URI,Rating'];
  for (let n = 1; n <= 25; n++) {
    const [k, v] = movie(300 + n, `tt00003${String(n).padStart(2, '0')}`, `Taste Film ${n}`, 2000 + n);
    f.tmdb.movie[k] = v;
    f.tmdb.search[`${norm(`Taste Film ${n}`)}|${2000 + n}`] = { v: 300 + n };
    lines.push(`2026-10-01,Taste Film ${n},${2000 + n},https://boxd.it/t${n},4`);
  }
  fs.mkdirSync(path.join(root, 'cache')); fs.mkdirSync(path.join(root, 'data', 'letterboxd'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cache', 'tmdb.json'), JSON.stringify(f.tmdb));
  fs.writeFileSync(path.join(root, 'cache', 'friends.json'), JSON.stringify(f.friends));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(f.cfg));
  fs.writeFileSync(path.join(root, 'data', 'letterboxd', 'ratings.csv'), lines.join('\n') + '\n');
  const indexFile = path.join(root, '.context', 'films', 'index.json');
  const all = run(['taste', 'director', '--min', '1', '--limit', '0', '--index', indexFile], { root });
  assert.ok(all.totalFeatures > 20, `fixture must have more than 20 directors (has ${all.totalFeatures})`);
  assert.equal(all.rows.length, all.totalFeatures, '--limit 0 = all rows');
  assert.equal(run(['taste', 'director', '--min', '1', '--index', indexFile], { root }).rows.length, 20);
  assert.equal(run(['taste', 'director', '--min', '1', '--limit', '3', '--index', indexFile], { root }).rows.length, 3);
});

test('Fase A: check refuses --fields with a clear error instead of accepting it silently, and before reading anything', () => {
  const root = writeRoot();
  const indexFile = path.join(root, '.context', 'films', 'index.json');
  assert.throws(() => run(['check', '--fields', 'id,title', 'tt0000007', '--index', indexFile], { root }), /--fields não se aplica a check/);
  assert.equal(fs.existsSync(path.join(root, '.context')), false, 'refused before the index was built');
  assert.equal(run(['check', 'tt0000007', '--index', indexFile], { root }).asked, 1, 'without --fields it still works');
  assert.doesNotThrow(() => run(['search', '--fields', 'id,why,cv', '--limit', '2', '--index', indexFile], { root }), '--fields stays valid on search');
});

// ── Fase A: reading without writing ──
function listing(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(p); if (e.isDirectory()) walk(p); } };
  walk(dir);
  return out.sort();
}
function spyOnWrites(fn) {
  const calls = [];
  const names = ['writeFileSync', 'mkdirSync', 'renameSync', 'appendFileSync', 'copyFileSync', 'rmSync', 'unlinkSync'];
  const saved = Object.fromEntries(names.map((n) => [n, fs[n]]));
  for (const n of names) fs[n] = (...a) => { calls.push(`${n} ${String(a[0])}`); return saved[n](...a); };
  try { fn(); } finally { Object.assign(fs, saved); }
  return calls;
}

test('Fase A: load(root, { write: false }) writes nothing — no file, no directory, no fs write call — and still answers', () => {
  const { load: L, snapshot, signature } = require('./store');
  const root = writeRoot();
  const indexFile = path.join(root, '.context', 'films', 'index.json');
  const before = listing(root);
  let got;
  const calls = spyOnWrites(() => { got = L(root, { indexFile, write: false }); });
  assert.deepEqual(calls, [], 'no write-type fs call at all');
  assert.deepEqual(listing(root), before, 'the tree under the root is exactly as it was (no .context created)');
  assert.equal(got.rebuilt, true);
  assert.ok(got.index.films.length > 10);
  // a stale prepared index is not overwritten either
  L(root, { indexFile });
  fs.appendFileSync(path.join(root, 'data', 'letterboxd', 'ratings.csv'), '2026-10-02,Community Only,2007,https://boxd.it/y,5\n');
  const bytes = fs.readFileSync(indexFile);
  const afterStale = listing(root);
  const calls2 = spyOnWrites(() => { got = L(root, { indexFile, write: false }); });
  assert.deepEqual(calls2, []);
  assert.equal(got.rebuilt, true, 'stale signature: projected in memory');
  assert.ok(fs.readFileSync(indexFile).equals(bytes), 'the stale file is left as it was');
  assert.deepEqual(listing(root), afterStale);
  // a prepared index with the same signature is read, not rebuilt
  L(root, { indexFile });
  assert.equal(L(root, { indexFile, write: false }).rebuilt, false);
  // snapshot() is the pure form: { index, signature } with no write
  let snap;
  const calls3 = spyOnWrites(() => { snap = snapshot(root); });
  assert.deepEqual(calls3, []);
  assert.equal(snap.signature, signature(root));
  assert.equal(snap.index.meta.signature, snap.signature);
  assert.equal(snap.index.films.length, got.index.films.length);
});

test('Fase A: the default is still to write (the CLI keeps its private cache under .context/films/)', () => {
  const root = writeRoot();
  const indexFile = path.join(root, '.context', 'films', 'index.json');
  const { rebuilt } = load(root, { indexFile });
  assert.equal(rebuilt, true);
  assert.ok(fs.existsSync(indexFile));
  assert.equal(fs.statSync(indexFile).mode & 0o777, 0o600);
});

// ── Fase A (12/10/2026, coordinator): --mood and why() mirror build.js — recipes compiled with cfg.lists, fit() given the ids of the lists holding the film ──
// Found by the Fase A measurement: `slow` fit 253 films without the list signal and 345 with it (two slow-cinema canons, weight 2); the CLI did not pass the lists.
test('mood fit uses the list signal: a film whose ONLY slow signal is the slow-cinema canon fits `slow` (search, check, why), and one outside the canon does not', () => {
  const f = fixture();
  const slow = { id: 'slow', name: 'Slow and still', genres: { Drama: 0.5 }, minFit: 2 }; // Drama alone is worth 0.5 < 2: only the canon can carry it
  f.cfg.moods = [slow];
  f.cfg.lists = [{ id: 'canon', name: 'A Canon of Slow Cinema (someone)', trust: 'critic', moods: { slow: 2 } }, { id: 'plain', name: 'Plain list', trust: 'fan' }];
  const lists = { lists: { canon: { title: 'canon', items: [['community-only', 'Community Only', 2007]] }, plain: { title: 'plain', items: [['seen-one', 'Seen One', 2008]] } } };
  const i = project({ ...f, lists });
  assert.deepEqual(i.moodLists, [{ id: 'canon', name: 'A Canon of Slow Cinema (someone)', moods: { slow: 2 } }], 'the projection carries the lists that signal a mood, and only those');
  assert.deepEqual(i.lists.canon.ids, ['tt0000007']);
  const ids = (o) => Qy.search(i, { sort: 'id', ...o }).films.map((x) => x.id);
  assert.deepEqual(ids({ mood: 'slow' }), ['tt0000007'], 'only the film in the canon; Seen One is in a list that signals nothing');
  const [c7, c8] = Qy.check(i, ['tt0000007', 'tt0000008'], { mood: 'slow' });
  assert.equal(c7.pass, true);
  assert.equal(c8.pass, false);
  assert.deepEqual(c8.fails, ['mood=slow']);
  const now = Qy.why(i, 'tt0000007', { now: true });
  assert.deepEqual(now.moodFitNow[0], { mood: 'slow', name: 'Slow and still', fit: 2.5, minFit: 2, ok: true, hits: ['A Canon of Slow Cinema'] });
  assert.equal(now.moodRankNow.rows[0].fitTerm, +(1.1 * Math.min(2.5 / (2 * 1.75), 1.6)).toFixed(2));
  const out = Qy.why(i, 'tt0000008', { now: true });
  assert.equal(out.moodFitNow[0].ok, false);
  assert.equal(out.moodFitNow[0].fit, 0.5);
  // the signal is configuration: a canon that names no mood changes nothing
  f.cfg.lists = [{ id: 'canon', name: 'A Canon of Slow Cinema (someone)', trust: 'critic' }];
  assert.deepEqual(Qy.search(project({ ...f, lists }), { mood: 'slow' }).films.map((x) => x.id), []);
});

// ── Review of 12/10/2026 (M1): the lists of the index are the build's lists — corrections applied, static lists from their files, the curator's positions ──
// Found by the adversarial review against the published index: list fwxFQ held Pedro Páramo 2024 instead of the 1967 film, 29d0g lacked The
// Discreet Charm of the Bourgeoisie, and the two static lists (IndieWire) were missing: 104 memberships only in the published index, 1 only here.
// Entry: tools/films/project.js built `index.lists` from cache/lists.json alone, without lib/lists.js correct() and without lib/static-lists.js apply().
function writeListsRoot() {
  const root = writeRulesRoot();
  const rd = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  const wr = (rel, data) => fs.writeFileSync(path.join(root, rel), JSON.stringify(data));
  const cfg = rd('config.json');
  // Critics Pick: the curator's copy points s202 (Vouched Too Low), the correction says it is s205 (Fan Only); s201 is written twice
  cfg.lists[0].corrections = [{ from: 's202', to: 's205', why: 'the copy points the wrong film page' }];
  wr('config.json', cfg);
  const lc = rd('cache/lists.json');
  lc.lists.crit.title = 'Critics (Letterboxd title)';
  lc.lists.crit.items = [['s201', 't201', 2010], ['s202', 't202', 2010], ['s203', 't203', 2010], ['s201', 't201', 2010], ['s204', 't204', 2010]];
  wr('cache/lists.json', lc);
  // Static Pick: a series first (its IMDb id names a film the index knows: it must NOT join), a film Letterboxd's record contradicts
  // (s202 is tt0000202 there, the file says tt0000208: refused), then the one real member at position 3
  const st = rd('data/lists/stat.json');
  st.items = [
    { slug: 'a-series', title: 'A Series', year: 2010, imdb: 'tt0000205', tmdb: 205, tmdbType: 'tv' },
    { slug: 's202', title: 'Vouched Too Low', year: 2010, imdb: 'tt0000208', tmdb: 208, tmdbType: 'movie' },
    ...st.items,
  ];
  wr('data/lists/stat.json', st);
  return root;
}
const listsIndex = () => load(writeListsRoot(), { indexFile: mkfile(`films-lists-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`) }).index;

test('M1: a list carries the curator\'s correction (the film the config says, at the curator\'s position), each film once at its first position, and its unresolved items counted', () => {
  const i = listsIndex();
  const crit = i.lists.crit;
  // s202 became s205 in place (position 2); the second s201 (position 4) is the same film and keeps position 1; s204 stays at position 5
  assert.deepEqual(crit.ids, ['tt0000201', 'tt0000205', 'tt0000203', 'tt0000204']);
  assert.deepEqual(crit.positions, [1, 2, 3, 5]);
  assert.equal(crit.unresolved, 0);
  assert.equal(crit.name, 'Critics (Letterboxd title)', 'a list read from Letterboxd keeps the title of its page');
  assert.ok(!crit.ids.includes('tt0000202'), 'the uncorrected film is not in the list the build publishes');
  assert.equal(Qy.setOf(i, 'list:crit').has('tt0000205'), true);
});

test('M1: a static list is read from its file — a series and a refused item keep their place but join no film; the real member is at its file position', () => {
  const i = listsIndex();
  const stat = i.lists.stat;
  assert.deepEqual(stat.ids, ['tt0000209']);
  assert.deepEqual(stat.positions, [3]);
  assert.equal(stat.unresolved, 2, 'the series and the refused item');
  assert.ok(!stat.ids.includes('tt0000205') && !stat.ids.includes('tt0000208'), 'a dead slug must not fall back to the IMDb id the file wrote for it');
  assert.equal(stat.fetchedAt, '2026-10-12T00:00:00.000Z');
  assert.equal(stat.name, 'Static Pick', 'a static list has no page title: the config\'s name');
  assert.deepEqual(Object.keys(i.lists), ['crit', 'dirl', 'fan', 'stat'], 'the config\'s lists, in the config\'s order');
});

test('M1: with a config that names lists, a list of the cache the config does not name is not a list (the build only reads cfg.lists)', () => {
  const f = fixture();
  f.cfg.lists = [{ id: 'kept', name: 'Kept', trust: 'fan' }];
  const i = project({ ...f, lists: { lists: { kept: { items: [['community-only', 'Community Only', 2007]] }, stale: { items: [['seen-one', 'Seen One', 2008]] } } } });
  assert.deepEqual(Object.keys(i.lists), ['kept']);
  delete f.cfg.lists;
  assert.deepEqual(Object.keys(project({ ...f, lists: { lists: { stale: { items: [] } } } }).lists), ['stale'], 'a bare fixture keeps the cache\'s lists');
});

// ── compare-published: list membership ──
const cmp = require('./compare-published');
const pubRow = (tt, o = {}) => ({ tt, name: o.name ?? tt, lb: o.lb ?? null, flags: o.flags ?? 0, lists: o.lists ?? null });
const published = (rows, lists = [{ id: 'a', label: 'List A' }, { id: 'b', label: 'List B' }]) => ({ cols: ['tt', 'name', 'lbRating', 'flags', 'lists'], meta: {}, lists,
  films: rows.map((r) => [r.tt, r.name, r.lb, r.flags, r.lists]) });
const cliIndex = (films, lists) => ({ meta: {}, films, lists });
const cliFilm = (id, o = {}) => ({ id, title: id, lb: null, elig: false, cv: false, fr: [], ...o });

test('M1 compare-published: list memberships are compared per list — only in the published index, only in the CLI, same list at another position', () => {
  const index = cliIndex([cliFilm('tt1'), cliFilm('tt2'), cliFilm('tt3'), cliFilm('tt4')], {
    a: { name: 'A', ids: ['tt1', 'tt2', 'tt4'], positions: [1, 2, 7] }, b: { name: 'B', ids: ['tt3'], positions: [5] } });
  const pub = published([pubRow('tt1', { lists: 'a:1' }), pubRow('tt2', { lists: 'a:3,b:9' }), pubRow('tt3', { lists: 'b:5' }), pubRow('tt4') ]);
  const l = cmp.compare(pub, index).lists;
  assert.equal(l.filmsCompared, 4);
  assert.equal(l.positionsCompared, true);
  assert.deepEqual(l.memberships, { published: 4, cli: 4, agree: 2 });
  assert.deepEqual(l.divergences, { 'published only': 1, 'CLI only': 1, 'position differs': 1 });
  assert.deepEqual(l.byList.a, { name: 'List A', 'published only': 0, 'CLI only': 1, 'position differs': 1 });
  assert.deepEqual(l.byList.b, { name: 'List B', 'published only': 1, 'CLI only': 0, 'position differs': 0 });
  assert.deepEqual(l.examples.map((e) => [e.id, e.list, e.kind]).sort(), [['tt2', 'a', 'position differs'], ['tt2', 'b', 'published only'], ['tt4', 'a', 'CLI only']]);
});

test('M1 compare-published: an index without positions is compared on membership only, and says so; a film the published index lacks is not a divergence', () => {
  const index = cliIndex([cliFilm('tt1'), cliFilm('tt9')], { a: { name: 'A', ids: ['tt1', 'tt9'] } });
  const l = cmp.compare(published([pubRow('tt1', { lists: 'a:4' })]), index).lists;
  assert.equal(l.positionsCompared, false);
  assert.deepEqual(l.divergences, { 'published only': 0, 'CLI only': 0, 'position differs': 0 });
  assert.deepEqual(l.memberships, { published: 1, cli: 1, agree: 1 }, 'tt9 is not in the published index: not counted');
});

// B6 (12/10/2026): the label "floor 2.5" went on every refusal of a vouched film, including ones that are not about the floor.
test('B6 compare-published: a refusal of a vouched film is labelled "floor" only when the CLI\'s average is under the vouched floor', () => {
  const under = cliFilm('tt1', { cv: true, lb: 2.4, elig: false }), other = cliFilm('tt2', { cv: true, lb: 3.1, elig: false }), plain = cliFilm('tt3', { lb: 3.0 });
  const pub = published([pubRow('tt1', { lb: 2.4, flags: 4 }), pubRow('tt2', { lb: 3.1, flags: 4 }), pubRow('tt3', { lb: 3.0, flags: 4 })]);
  const causes = Object.keys(cmp.compare(pub, cliIndex([under, other, plain], {})).causes);
  assert.equal(causes.length, 3);
  assert.ok(causes.some((c) => /average 2\.4 is under the vouched floor of 2\.5/.test(c)));
  assert.ok(causes.some((c) => /vouched film for a reason other than the vouched floor/.test(c)));
  assert.ok(causes.some((c) => /^published true \/ CLI false: CLI refuses, average unchanged: investigate$/.test(c)));
  assert.equal(causes.filter((c) => /floor/.test(c)).length, 2, 'the plain refusal does not mention the floor');
});

// ── M1 on the real files: the CLI's lists agree with the build's (membership and position), measured against the repository's own code path ──
test('M1: on the real repository the lists of the index equal what lib/index-export.js records — same members, same first position (skips when there are no caches)', (t) => {
  if (!fs.existsSync(path.join(ROOT, 'cache', 'lists.json')) || !fs.existsSync(path.join(ROOT, 'cache', 'friends.json'))) return t.skip('no caches');
  const LW = require('../../lib/list-signal'); // vouchedFromCaches lays the same corrections and static lists over the same caches
  const SLm = require('../../lib/static-lists');
  const { correct } = require('../../lib/lists');
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const cache = JSON.parse(fs.readFileSync(path.join(ROOT, 'cache', 'lists.json'), 'utf8'));
  const friends = JSON.parse(fs.readFileSync(path.join(ROOT, 'cache', 'friends.json'), 'utf8'));
  assert.equal(typeof LW.vouchedFromCaches, 'function');
  const tmp = mkfile(`films-lists-real-${process.pid}.json`);
  const { index } = load(ROOT, { indexFile: tmp });
  fs.rmSync(tmp, { force: true });
  assert.deepEqual(Object.keys(index.lists), cfg.lists.map((l) => l.id), 'every config list, in order, the static ones included');
  // the build's rule for a member (lib/index-export.js): the record's IMDb id, the first position, gone or id-less records out
  const filmsV = SLm.filmsFor(cfg, ROOT, friends.films || {});
  let checked = 0;
  for (const l of cfg.lists.filter((x) => !SLm.isStatic(x))) {
    const items = correct(l, ((cache.lists[l.id] || {}).items || []).map(([slug, title, year]) => ({ slug, title, year })));
    const expect = new Map();
    items.forEach((it, n) => { const r = filmsV[it.slug]; if (r && !r.gone && /^tt\d+$/.test(r.imdbId || '') && !expect.has(r.imdbId)) expect.set(r.imdbId, n + 1); });
    const got = new Map(index.lists[l.id].ids.map((id, n) => [id, index.lists[l.id].positions[n]]));
    for (const [tt, pos] of expect) { assert.equal(got.get(tt), pos, `${l.id} ${tt}`); checked++; }
  }
  assert.ok(checked > 1000, `checked ${checked} memberships`);
});

// ── B8 (review 12/10/2026): two mutations of the first review that no test caught ──
// F10: the taste model learns only from rated films that have TMDB details (build.js:175; query.js tasteModel filters on `tTmdb`).
// F11: the favourite directors come from MARCO'S ratings (store.readSources hands DL.vouched the taste model's stats); with `stats: []` only
// the manual include list would remain and a director he loves by his own ratings would stop vouching for the films he loves.
function ratedFixture() {
  const { norm } = require('../../lib/util');
  const f = fixture();
  const rate = (id, imdb, title, year, rating, directorName, extra = {}) => {
    const [k, v] = movie(id, imdb, title, year, { directors: [{ id: 9000 + id, name: directorName }], ...extra });
    f.tmdb.movie[k] = v;
    f.tmdb.search[`${norm(title)}|${year}`] = { v: id };
    f.history.set(`${norm(title)}|${year}`, { title, year, watched: true, rating, liked: false, watchlist: false });
    return k;
  };
  return { f, rate };
}

test('B8 F10: a rated film with no TMDB details teaches the taste model nothing — it is not counted and its director has no row', () => {
  const { f, rate } = ratedFixture();
  rate(401, 'tt0000401', 'With Details', 2001, 5, 'Detailed Director');
  const k = rate(402, 'tt0000402', 'No Details', 2002, 5, 'Blind Director');
  delete f.tmdb.movie[k].t; // the record exists but was never fetched with details: no `tTmdb`
  const i = project(f);
  assert.equal(film(i, 'tt0000402').me.r, 5, 'the rating itself is linked');
  assert.equal(film(i, 'tt0000402').tTmdb, null);
  const base = Qy.taste(project(fixture()), 'director', { min: 1, limit: 1000 }).rows.map((r) => r.label);
  const rows = Qy.taste(i, 'director', { min: 1, limit: 1000 }).rows.map((r) => r.label);
  assert.ok(rows.includes('Detailed Director'));
  assert.ok(!rows.includes('Blind Director'), 'no TMDB details: not learned from');
  assert.equal(Qy.taste(i, 'director', { min: 1 }).ratedFilms, Qy.taste(project(fixture()), 'director', { min: 1 }).ratedFilms + 1, 'one more film learned, not two');
  assert.ok(base.length < rows.length);
});

test('B8 F11: a director Marco rates highly (3 films, 4★ average) is a favourite, so a film that director loves is vouched; without his ratings it is not', () => {
  const root = writeRulesRoot();
  const rd = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  const wr = (rel, data) => fs.writeFileSync(path.join(root, rel), typeof data === 'string' ? data : JSON.stringify(data));
  const { norm } = require('../../lib/util');
  const tmdb = rd('cache/tmdb.json'), friends = rd('cache/friends.json');
  const rows = ['Date,Name,Year,Letterboxd URI,Rating'];
  // three films by Marta Fav at 4.5★, and three by others at 2★ so that her films sit ABOVE his mean (a director at his mean weighs nothing)
  for (const [id, title, dir, stars] of [[231, 'Fav One', 777, 4.5], [232, 'Fav Two', 777, 4.5], [233, 'Fav Three', 777, 4.5], [251, 'Meh One', 778, 2], [252, 'Meh Two', 779, 2], [253, 'Meh Three', 780, 2]]) {
    const [k, v] = movie(id, `tt0000${id}`, title, 2005, { directors: [{ id: dir, name: dir === 777 ? 'Marta Fav' : `Meh ${dir}` }] });
    tmdb.movie[k] = v;
    tmdb.search[`${norm(title)}|2005`] = { v: id };
    rows.push(`2026-10-01,${title},2005,https://boxd.it/f${id},${stars}`);
  }
  const [k, v] = movie(240, 'tt0000240', 'Loved By Marta', 2010, { directors: [{ id: 888, name: 'Someone Else' }] }); // she did not direct it
  tmdb.movie[k] = v;
  friends.films.s240 = { title: 'Loved By Marta', year: 2010, tmdbId: 240, imdbId: 'tt0000240', r: 3.0, rn: 100, t: 1760000000000 }; // 3.0: only a vouch lets it in
  wr('cache/tmdb.json', tmdb); wr('cache/friends.json', friends);
  wr('data/letterboxd/ratings.csv', rows.join('\n') + '\n');
  const dl = rd('data/directors-loved.json');
  dl.directors.push({ name: 'Marta Fav', sources: [{ id: 'marta1', confidence: 'high', kind: 'interview', url: 'https://example.org/m', title: 'Interview', date: '2020-01-01' }],
    films: [{ title: 'Loved By Marta', imdb: 'tt0000240', tmdb: 240, tmdbType: 'movie', year: 2010, sources: ['marta1'] }] });
  wr('data/directors-loved.json', dl);
  const cfg = rd('config.json'); // Marta is NOT in the include list: only Marco's ratings can make her a favourite
  assert.deepEqual(cfg.directorsLoved.include, ['Jane Auteur']);
  const i = load(root, { indexFile: mkfile(`films-f11-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`) }).index;
  const loved = film(i, 'tt0000240');
  assert.equal(loved.lb, 3);
  assert.equal(loved.cv, true, 'Marco rates Marta Fav 4.5★ over 3 films: she is a favourite, and she loves this film');
  assert.equal(loved.elig, true);
  assert.match(loved.eligWhy, /Loved by Fav/);
  // the control: take away his ratings of her films and the same file vouches for nothing
  wr('data/letterboxd/ratings.csv', 'Date,Name,Year,Letterboxd URI,Rating\n');
  const j = load(root, { indexFile: mkfile(`films-f11b-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`) }).index;
  assert.equal(film(j, 'tt0000240').cv, false);
  assert.equal(film(j, 'tt0000240').elig, false);
});

// Found 14/10/2026 (review of PR5): moodFit() only ran fit(), the build also runs passes() on the mood's `where` first (lib/board-rows.js rankMood), so `search --unseen --mood hidden` said
// 10,358 films and the build 1,006, and `why` called a film with 50,000 ratings a Hidden gem. The expected ids come from the BUILD's own function (rankMood) over the same films.
// Mutation: moodFit() back to the bare fit() → this test is red (hidden and docs both).
test('a mood with a `where` gate (hidden, docs) selects the films the build selects: the gate is applied before the fit', () => {
  const { rankMood } = require('../../lib/board-rows');
  const { compile } = require('../../lib/moods');
  const i = idx();
  film(i, 'tt0000007').lbN = 50000;                       // 3.9 on 50,000 ratings: fits "hidden" by its genres (none), fails the gate lbCount ≤ 9,999
  film(i, 'tt0000013').genres = ['Documentary', 'Drama']; // passes the docs gate
  film(i, 'tt0000014').genres = ['Drama'];                // Drama alone fits docs by its weight and fails the gate
  const hidden = { id: 'hidden', name: 'Hidden', word: 'Hidden gem', genres: {}, keywords: {}, minFit: 0, where: { lb: { min: 3.8 }, lbCount: { max: 9999 } } };
  const docs = { id: 'docs', name: 'Docs', word: 'Documentary', genres: { Documentary: 3, Drama: 2.2 }, keywords: {}, minFit: 2, where: { genresAny: ['Documentary'] } };
  i.moods = [hidden, docs];
  const ctx = new Map(compile(i.moods, []).map((m) => [m.id, m]));
  for (const id of ['hidden', 'docs']) {
    const cands = i.films.filter((f) => f.genres.length || f.keywords.length).map((f) => ({ film: { ...f, runtime: f.rt }, lbYear: f.year ?? null, lb: f.lb ?? null, lbCount: f.lbN ?? null, lists: [] }));
    const build = rankMood(cands, ctx.get(id)).map((c) => c.film.id).sort();
    const tool = Qy.search(i, { mood: id }).films.map((f) => f.id).sort();
    assert.ok(build.length > 0, `${id}: the build selects something`);
    assert.deepEqual(tool, build, `${id}: the tool and the build select the same films`);
  }
  const bare = Qy.search({ ...i, moods: [{ ...hidden, where: undefined }] }, { mood: 'hidden' }).total;
  assert.ok(bare > Qy.search(i, { mood: 'hidden' }).total, 'without the gate the mood would hold more films: the fixture exercises it');
  assert.ok(!Qy.search(i, { mood: 'hidden' }).films.some((f) => f.id === 'tt0000007'));
  assert.ok(!Qy.search(i, { mood: 'docs' }).films.some((f) => f.id === 'tt0000014'));
  assert.equal(Qy.why(i, 'tt0000007').moodFitNow.find((m) => m.mood === 'hidden').ok, false, 'why: 50,000 ratings is not a hidden gem');
});

test("origin and main country (22/10/2026): the record carries TMDB's origin_country and the film's main country; `countries` stays the producers; no origin key = null and the old rule", () => {
  const fx = fixture();
  Object.assign(fx.tmdb.movie['1'].v, { countries: ['NP', 'US'], origin: ['NE'] }); // Manakamana: TMDB's origin is not a producer
  Object.assign(fx.tmdb.movie['2'].v, { countries: ['GB', 'US'] });                   // a record cached before 22/10/2026: no `origin` key
  Object.assign(fx.tmdb.movie['3'].v, { countries: ['GB', 'US'], origin: ['GB'] });   // Topsy-Turvy: the origin decides
  const index = project(fx);
  const a = film(index, 'tt0000001'), b = film(index, 'tt0000002'), c = film(index, 'tt0000003');
  assert.deepEqual([a.countries, a.origin, a.mainCountry], [['NP', 'US'], ['NE'], 'NE'], 'the producers are not rewritten; the main country can be outside them');
  assert.deepEqual([b.origin, b.mainCountry], [null, 'US'], 'never asked: null, and the rule of 14/10/2026 (English with an American producer)');
  assert.deepEqual([c.origin, c.mainCountry], [['GB'], 'GB']);
});

test("the director's layer in the projection (23/10/2026): cache/directors.json arrives as `directors`; without it the origin rule decides, and the process's registry is never read", () => {
  const fx = fixture();
  Object.assign(fx.tmdb.movie['1'].v, { countries: ['GB', 'US'], lang: 'es', origin: ['US'], directors: [{ id: 11218, name: 'Alfonso Cuarón' }] });
  const without = film(project(fx), 'tt0000001');
  assert.deepEqual([without.origin, without.mainCountry, without.mainCountrySrc], [['US'], 'US', 'origin']);
  const CO = require('../../lib/countries');
  const prev = CO.setDirectors(new Map([['11218', ['MX']]])); // the registry of the process must not leak into the CLI
  try {
    assert.equal(film(project(fx), 'tt0000001').mainCountry, 'US', 'the CLI reads the cache it is given, not the registry');
  } finally { CO.setDirectors(prev); }
  const withDir = film(project({ ...fx, directors: new Map([['11218', ['MX']]]) }), 'tt0000001');
  assert.equal(withDir.mainCountry, 'MX', 'Roma: GB + US, Spanish, the Mexican director');
  assert.equal(withDir.mainCountrySrc, 'director', 'and the record says who decided (the dossier names Wikidata as the source)');
  assert.deepEqual(withDir.countries, ['GB', 'US'], 'the producers are not rewritten');
});
