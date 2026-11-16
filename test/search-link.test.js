'use strict';
// A TMDB search hit for a logged title + year is a link only when confirmed (lib/search-link.js, Marco 11/10/2026).
const test = require('node:test');
const a = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { makeSearchLinker } = require('../lib/search-link');
const { norm, parseCsv } = require('../lib/util');

const ROOT = path.resolve(__dirname, '..');
const mv = (title, year, imdb, extra = {}) => ({ v: { title, year, imdb, ...extra } });

test('a search hit links only when exact, named alone by Letterboxd, or alone in the caches', () => {
  const movies = {
    1: mv('Under the Skin', 2013, 'tt1441395'),
    2: mv('Under the Skin', 2013, 'tt4698852', { originalTitle: 'Sob a Pele' }), // the 19-minute short
    3: mv('Lonely', 2001, 'tt0000003'),
    4: mv('Festival', 2010, 'tt0000004'),
    5: mv('Twice', 2010, 'tt0000005'),
    6: mv('Twice', 2010, null),
    7: mv('Scenes', 1974, 'tt6725014'),
  };
  const lbFilms = {
    'under-the-skin-2013': { title: 'Under the Skin', year: 2013, imdbId: 'tt1441395', tmdbId: 1 },
    'scenes-1973-1': { title: 'Scenes', year: 1973, imdbId: 'tt0070644', tmdbId: 65170 },
    'scenes': { title: 'Scenes', year: 1974, imdbId: 'tt6725014', tmdbId: 7 },
    'gone': { title: 'Lonely', year: 2001, imdbId: 'tt9', gone: true },
  };
  const { check } = makeSearchLinker({ movies, lbFilms });
  // the homonym loses: Letterboxd names another film for Under the Skin 2013
  const doubt = check({ title: 'Under the Skin', year: 2013, entry: { v: 2 }, pick: 2 });
  a.equal(doubt.ok, false);
  a.equal(doubt.searchPick, 'tt4698852');
  a.deepEqual(doubt.candidates, ['tt1441395', 'tt4698852']);
  // the right film, named alone by Letterboxd, links even with a homonym in the TMDB cache
  a.equal(check({ title: 'Under the Skin', year: 2013, entry: { v: 1 }, pick: 1 }).ok, true);
  // exact entries (remember(), from the RSS) are never questioned
  a.equal(check({ title: 'Under the Skin', year: 2013, entry: { v: 2, exact: true }, pick: 2 }).ok, true);
  // alone everywhere (a gone Letterboxd record does not count)
  a.equal(check({ title: 'Lonely', year: 2001, entry: { v: 3 }, pick: 3 }).ok, true);
  // ±1 year is used only when nothing has the same year: Festival 2011 → the 2010 film, alone
  a.equal(check({ title: 'Festival', year: 2011, entry: { v: 4 }, pick: 4 }).ok, true);
  // two TMDB records with the same title and year and no Letterboxd record: doubt
  a.equal(check({ title: 'Twice', year: 2010, entry: { v: 5 }, pick: 5 }).ok, false);
  // Scenes 1973: Letterboxd has exactly one 1973 record (the 283-min one); the search picked the 1974 cut → doubt
  const scenes = check({ title: 'Scenes', year: 1973, entry: { v: 7 }, pick: 7 });
  a.equal(scenes.ok, false);
  a.deepEqual(scenes.candidates, ['tt0070644', 'tt6725014']);
  // a pick the movie cache has never seen still meets its Letterboxd rival
  a.equal(check({ title: 'Scenes', year: 1973, entry: { v: 99 }, pick: 99 }).ok, false);
  // no hit at all
  a.equal(check({ title: 'Nothing', year: 2000, entry: { v: null }, pick: null }).ok, false);
});

test('Letterboxd must name the film alone; ±1 only without a same-year record; original titles are rivals too', () => {
  const movies = {
    10: mv('Pair', 2005, 'tt0000010'),
    20: mv('Drift', 2012, 'tt0000020'),
    30: mv('Era', 2000, 'tt0000030'),
    40: mv('Kiseki', 2011, 'tt0000040'),
    41: mv('Miracle', 2011, 'tt0000041', { originalTitle: 'Kiseki' }),
  };
  const lbFilms = {
    'pair': { title: 'Pair', year: 2005, imdbId: 'tt0000010' },
    'pair-2005': { title: 'Pair', year: 2005, imdbId: 'tt0000011' },
    'drift-2011': { title: 'Drift', year: 2011, imdbId: 'tt0000021' },
    'era': { title: 'Era', year: 2000, imdbId: 'tt0000030' },
    'era-2001': { title: 'Era', year: 2001, imdbId: 'tt0000031' },
  };
  const { check } = makeSearchLinker({ movies, lbFilms });
  // two Letterboxd records for Pair 2005: naming the pick among others is not naming it alone
  a.equal(check({ title: 'Pair', year: 2005, entry: { v: 10 }, pick: 10 }).ok, false);
  // Letterboxd has only another film a year away: that rival counts
  const drift = check({ title: 'Drift', year: 2012, entry: { v: 20 }, pick: 20 });
  a.equal(drift.ok, false);
  a.deepEqual(drift.candidates, ['tt0000020', 'tt0000021']);
  // a same-year record wins; the film a year away is not a rival then
  a.equal(check({ title: 'Era', year: 2000, entry: { v: 30 }, pick: 30 }).ok, true);
  // a film whose original title is the logged title is a rival
  a.equal(check({ title: 'Kiseki', year: 2011, entry: { v: 40 }, pick: 40 }).ok, false);
});

test('a hit the movie cache has not met is confirmed by the one Letterboxd record naming that TMDB id (review P2-1)', () => {
  const lbFilms = {
    'alone': { title: 'Alone', year: 2001, imdbId: 'tt0000101', tmdbId: 501 },
    'other': { title: 'Other', year: 2002, imdbId: 'tt0000102', tmdbId: 502 },
    'two-a': { title: 'Two', year: 2003, imdbId: 'tt0000103', tmdbId: 503 },
    'two-b': { title: 'Two', year: 2003, imdbId: 'tt0000104', tmdbId: 504 },
  };
  const { check } = makeSearchLinker({ movies: { 600: mv('Known', 2005, 'tt0000600') }, lbFilms: { ...lbFilms, 'known': { title: 'Known', year: 2005, imdbId: 'tt0000601', tmdbId: 600 } } });
  a.equal(check({ title: 'Alone', year: 2001, entry: { v: 501 }, pick: 501 }).ok, true);
  a.equal(check({ title: 'Other', year: 2002, entry: { v: 999 }, pick: 999 }).ok, false); // the record names another TMDB id
  a.equal(check({ title: 'Two', year: 2003, entry: { v: 503 }, pick: 503 }).ok, false); // two records
  // a cached hit is judged by its IMDb id, never by the record's TMDB id (that id can be a TV id naming another film)
  a.equal(check({ title: 'Known', year: 2005, entry: { v: 600 }, pick: 600 }).ok, false);
});

test('a hit with no IMDb id under 40 minutes is a short of the same name, not a link (review P2-2)', () => {
  const movies = { 1: mv('One Day', 2024, null, { runtime: 3 }), 2: mv('Brief', 2020, 'tt0000002', { runtime: 3 }), 3: mv('Long', 2020, null, { runtime: 90 }), 4: mv('Edge', 2020, null, { runtime: 40 }), 5: mv('Unknown', 2020, null, { runtime: null }), 6: mv('Almost', 2020, null, { runtime: 39 }) };
  const { check } = makeSearchLinker({ movies });
  const short = check({ title: 'One Day', year: 2024, entry: { v: 1 }, pick: 1 });
  a.equal(short.ok, false);
  a.equal(short.reason, 'short-without-imdb');
  a.equal(check({ title: 'Brief', year: 2020, entry: { v: 2 }, pick: 2 }).ok, true); // a short WITH an IMDb id stays linked
  a.equal(check({ title: 'Long', year: 2020, entry: { v: 3 }, pick: 3 }).ok, true);
  a.equal(check({ title: 'Edge', year: 2020, entry: { v: 4 }, pick: 4 }).ok, true); // 40 minutes is not under 40
  a.equal(check({ title: 'Almost', year: 2020, entry: { v: 6 }, pick: 6 }).ok, false); // 39 is
  a.equal(check({ title: 'Unknown', year: 2020, entry: { v: 5 }, pick: 5 }).ok, true); // no runtime: not called a short
});

test('a refused hit is relinked only to the one record of that title and year on Marco\'s own page (Marco, 11/10/2026)', () => {
  const movies = { 1: mv('Split', 2016, 'tt3315656'), 2: mv('Hand', 2020, null), 3: mv('Twin', 2010, null), 4: mv('Twin', 2010, null), 5: mv('Wide', 2015, null) };
  const lbFilms = {
    'split-2016': { title: 'Split', year: 2016, imdbId: 'tt4972582', tmdbId: 381288 },
    'split-2016-1': { title: 'Split', year: 2016, imdbId: 'tt0000009', tmdbId: 9 }, // someone else's Split, not on Marco's pages
    'hand-2020-1': { title: 'Hand', year: 2020, imdbId: 'tt15165236', tmdbId: 846716 },
    'twin-a': { title: 'Twin', year: 2010, imdbId: 'tt0000031' },
    'twin-b': { title: 'Twin', year: 2010, imdbId: 'tt0000032' },
    'wide-2014': { title: 'Wide', year: 2014, imdbId: 'tt0000051' },
  };
  const mine = { films: ['split-2016', 'twin-a', 'twin-b', 'wide-2014'], watchlist: ['hand-2020-1'] };
  const { check } = makeSearchLinker({ movies, lbFilms, mine });
  a.deepEqual(check({ title: 'Split', year: 2016, entry: { v: 1 }, pick: 1, watched: true }).relink, { slug: 'split-2016', imdb: 'tt4972582', tmdbId: 381288 });
  // the watchlist row looks at the watchlist page, the watched row at /films/
  a.deepEqual(check({ title: 'Hand', year: 2020, entry: { v: 2 }, pick: 2, watchlist: true }).relink, { slug: 'hand-2020-1', imdb: 'tt15165236', tmdbId: 846716 });
  a.equal(check({ title: 'Hand', year: 2020, entry: { v: 2 }, pick: 2, watched: true }).relink, null);
  a.equal(check({ title: 'Split', year: 2016, entry: { v: 1 }, pick: 1 }).relink, null); // neither watched nor on the watchlist
  // two of Marco's records for that title and year: no relink
  a.equal(check({ title: 'Twin', year: 2010, entry: { v: 3 }, pick: 3, watched: true }).relink, null);
  // a year away is not "that title and year"
  const wide = check({ title: 'Wide', year: 2015, entry: { v: 5 }, pick: 5, watched: true });
  a.equal(wide.ok, false);
  a.equal(wide.relink, null);
});

/** Runs build.js offline in a VM against `cacheDir`; returns the TMDB ids lib/taste learn() receives, the build's seen TMDB ids and its log. Writes nothing outside `outDir`. */
async function runBuild(cacheDir, outDir, extra = []) {
  let finish, fail, learned = null, seen = null, network = 0;
  const lines = [];
  const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const blocked = ['writeFileSync', 'mkdirSync', 'renameSync', 'rmSync', 'unlinkSync', 'appendFileSync', 'copyFileSync', 'cpSync'];
  const readOnly = new Proxy(fs, { get: (t, k) => (blocked.includes(k) ? () => { throw Error('Unexpected write'); } : t[k]) });
  const old = process.env.OFFLINE;
  process.env.OFFLINE = '1';
  try {
    const req = (id) => require(id.startsWith('./') ? path.join(ROOT, id) : id);
    const context = {
      __dirname: ROOT, Buffer, URL, URLSearchParams, setTimeout, clearTimeout, Date,
      console: { log: (...x) => lines.push(x.join(' ')), error: (e) => fail(Error(String(e))) },
      fetch: () => { network++; throw Error('Unexpected fetch'); },
      process: {
        // --out: the index the build writes after publish() lands in the temp dir, never in docs/
        argv: [process.execPath, path.join(ROOT, 'build.js'), '--offline', '--cache-only', '--skip-posters', '--cache-dir', cacheDir, '--out', outDir, '--captured-at', '2026-10-10T12:00:00.000Z', ...extra],
        env: { ...process.env, OFFLINE: '1', SKIP_RSS: '1', MOOD_DATE: '2026-10-10' },
        version: process.version, memoryUsage: () => process.memoryUsage(), exit: () => fail(Error('Build exited')), on() {},
      },
      require: (id) => {
        if (id === 'fs') return readOnly;
        if (id === './lib/guard') { const G = req(id); return { ...G, seenImdbIds: (o) => { seen = new Set(o.seenIds); return G.seenImdbIds(o); } }; }
        if (id === './lib/taste') { const T = req(id); return { ...T, learn: (rows) => { learned = rows.map((r) => r.film.id); return T.learn(rows); } }; }
        if (id === './lib/publish') return { ...req(id), publish: () => { finish(); return { catalogs: 0, files: 0, covers: 0 }; } };
        return req(id);
      },
    };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'build.js'), 'utf8'), context, { filename: path.join(ROOT, 'build.js') });
    await done;
  } finally {
    if (old === undefined) delete process.env.OFFLINE; else process.env.OFFLINE = old;
  }
  a.equal(network, 0);
  return { learned: new Set(learned), seen, log: lines.join('\n') };
}

/**
 * A temp cache dir from the real caches with planted homonyms:
 *  victim   — search hit replaced by a homonym; Marco's /films/ names the real film, which the movie cache has → relinked;
 *  stranded — the same, but the real film is taken out of the movie cache → pending offline, with a warning;
 *  control  — untouched, confirmed; rss — an exact entry pointing at a planted homonym (trusted);
 *  named    — Letterboxd names it alone; a same-title rival lands in the movie cache (stays linked).
 */
function plantedCaches(tmp) {
  const cache = path.join(tmp, 'cache');
  fs.cpSync(path.join(ROOT, 'cache'), cache, { recursive: true });
  const file = path.join(cache, 'tmdb.json');
  const tmdb = JSON.parse(fs.readFileSync(file, 'utf8'));
  const friends = JSON.parse(fs.readFileSync(path.join(cache, 'friends.json'), 'utf8'));
  const { check } = makeSearchLinker({ movies: tmdb.movie, lbFilms: friends.films });
  const mine = new Set(friends.me.slugs);
  const rows = parseCsv(fs.readFileSync(path.join(ROOT, 'data/letterboxd/ratings.csv'), 'utf8'));
  const fine = rows.map((r) => ({ title: r.Name, year: Number(r.Year), key: `${norm(r.Name)}|${Number(r.Year)}` }))
    .filter((r) => { const e = tmdb.search[r.key]; return e && !e.exact && e.v != null && tmdb.movie[e.v]?.v?.imdb && check({ ...r, entry: e, pick: e.v }).ok; });
  const byTitle = new Map();
  for (const [slug, f] of Object.entries(friends.films)) if (f && !f.gone) { const k = `${norm(f.title || '')}|${f.year}`; if (!byTitle.has(k)) byTitle.set(k, []); byTitle.get(k).push([slug, f]); }
  const records = (r, own) => (byTitle.get(r.key) || []).filter(([slug]) => !own || mine.has(slug)).map(([, f]) => f.imdbId);
  const realOf = (r) => tmdb.search[r.key].v;
  const ownAlone = fine.filter((r) => records(r, true).join() === tmdb.movie[realOf(r)].v.imdb && records(r, false).length === 1);
  a(ownAlone.length >= 3 && fine.length >= 6, 'need confirmed ratings in the real caches');
  const [victim, stranded, named] = ownAlone;
  const [control, rss] = fine.filter((r) => ![victim, stranded, named].includes(r));
  const homonym = (real, planted) => { tmdb.movie[planted] = { t: Date.now(), v: { ...tmdb.movie[real].v, id: planted, imdb: null, runtime: 19, directors: [{ id: planted + 1, name: 'Planted Homonym' }] } }; };
  const ids = { real: realOf(victim), planted: 990000001, strandedReal: realOf(stranded), strandedPlanted: 990000031, control: realOf(control), rssPlanted: 990000011, named: realOf(named) };
  homonym(ids.real, ids.planted);
  tmdb.search[victim.key] = { t: Date.now(), v: ids.planted }; // what search() stores when a homonym scores first
  homonym(ids.strandedReal, ids.strandedPlanted);
  tmdb.search[stranded.key] = { t: Date.now(), v: ids.strandedPlanted };
  ids.strandedImdb = tmdb.movie[ids.strandedReal].v.imdb;
  delete tmdb.movie[ids.strandedReal];
  homonym(realOf(rss), ids.rssPlanted);
  tmdb.search[rss.key] = { t: Date.now(), v: ids.rssPlanted, exact: true }; // remember(): trusted even with a same-title rival
  homonym(ids.named, 990000021);
  fs.writeFileSync(file, JSON.stringify(tmdb));
  return { cache, ids, victim, stranded, control, rss, named };
}

test('build: a homonym hit leaves the taste; Marco\'s own page relinks it; offline without the film it is pending and said so', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'search-link-'));
  try {
    const { cache, ids, victim, stranded, control, rss, named } = plantedCaches(tmp);
    const { learned, seen, log } = await runBuild(cache, path.join(tmp, 'out'));
    a(!learned.has(ids.planted), `${victim.title} (${victim.year}) taught the taste through the homonym ${ids.planted}`);
    a(learned.has(ids.real), `${victim.title} (${victim.year}): Marco's /films/ names the real film, the rating must be relinked to it`);
    a.match(log, new RegExp(`${victim.title.replace(/[^\w ]/g, '.')} \\(${victim.year}.*relinked to tt\\d+`));
    a(!learned.has(ids.strandedPlanted) && !learned.has(ids.strandedReal), `${stranded.title} (${stranded.year}) must be pending offline`);
    a(log.includes(`PENDING: your page names ${ids.strandedImdb}`) && log.includes('offline: nothing asked'), 'the pending relink is said in the log');
    a(learned.has(ids.control), `${control.title} (${control.year}) is confirmed and must stay in the taste`);
    a(learned.has(ids.rssPlanted), `${rss.title} (${rss.year}) has an exact entry and must stay linked`);
    a(learned.has(ids.named), `${named.title} (${named.year}) is named alone by Letterboxd and must stay linked`);
    a(seen.has(ids.planted) && seen.has(ids.strandedPlanted), 'a refused hit of a watched film still counts as seen: hiding a homonym costs nothing');
    a(!/NO LETTERBOXD FILM RECORDS/.test(log));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('build --skip-friends: friends.json still confirms and relinks; without it the log says the Letterboxd check is off', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'search-link-'));
  try {
    const { cache, ids, victim } = plantedCaches(tmp);
    const withFile = await runBuild(cache, path.join(tmp, 'out1'), ['--skip-friends']);
    a(withFile.learned.has(ids.real) && !withFile.learned.has(ids.planted), `${victim.title}: relinked from cache/friends.json under --skip-friends`);
    a(!/NO LETTERBOXD FILM RECORDS/.test(withFile.log));
    fs.rmSync(path.join(cache, 'friends.json'));
    const without = await runBuild(cache, path.join(tmp, 'out2'), ['--skip-friends']);
    a.match(without.log, /! NO LETTERBOXD FILM RECORDS/);
    a(!without.learned.has(ids.planted) && !without.learned.has(ids.real), `${victim.title}: two TMDB films with that title and year and no Letterboxd record: pending`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('relinkTo takes a film only when its IMDb id is the one Marco\'s page names (review P2: TV ids name other films)', async () => {
  const { relinkTo, makeSearchLinker } = require('../lib/search-link');
  const films = { 114655: { id: 114655, imdb: 'tt0260292', title: 'Why Not Us?' }, 381288: { id: 381288, imdb: 'tt4972582', title: 'Split' }, 77: { id: 77, imdb: 'tt0000777', title: 'Found' } };
  const asked = [];
  const tmdb = { movie: async (id) => { asked.push(['movie', id]); return films[id] || null; }, fromImdb: async (imdb) => { asked.push(['find', imdb]); return imdb === 'tt0000777' ? 77 : imdb === 'tt0000888' ? 114655 : null; } };
  const linker = makeSearchLinker({});
  // The Curse: the record's TMDB id 114655 is "Why Not Us?" (tt0260292); TMDB has no movie for tt13623608 → nothing
  a.equal(await relinkTo(tmdb, linker, { imdb: 'tt13623608', tmdbId: 114655 }), null);
  a.deepEqual(asked, [['movie', 114655], ['find', 'tt13623608']]);
  // the record's TMDB id is right → that film
  a.equal((await relinkTo(tmdb, linker, { imdb: 'tt4972582', tmdbId: 381288 }))?.id, 381288);
  // a wrong record TMDB id, but /find knows the IMDb id → the film /find names
  a.equal((await relinkTo(tmdb, linker, { imdb: 'tt0000777', tmdbId: 114655 }))?.id, 77);
  // /find answers an id whose film carries another IMDb id → nothing
  a.equal(await relinkTo(tmdb, linker, { imdb: 'tt0000888', tmdbId: null }), null);
});

test('the approved-list log names the IMDb id of the film actually linked, not the one the page names', () => {
  const { againstApproved } = require('../lib/search-link');
  const approved = [['X', 2000, 'ambiguous', 1, 'tt0000001', null]];
  const imdbOf = (id) => ({ 5: 'tt0000005' })[id] || null;
  const vs = againstApproved([['X', 2000, 'ambiguous', 1, 'tt0000001', 5]], approved, imdbOf);
  a.deepEqual(vs.changed, ['X (2000) pending (page names tt0000001) → relinked to tt0000005']);
  a.deepEqual(againstApproved([['Y', 2001, 'ambiguous', 2, 'tt0000002', 6]], [], imdbOf).entered, ['Y (2001) relinked to tmdb:6 (no IMDb id in the cache)']);
});
