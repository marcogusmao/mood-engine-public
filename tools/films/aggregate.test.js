'use strict';
// films aggregate (Fase A, 12/10/2026) — a small fixture with numbers countable by hand. Run: node --test tools/films/aggregate.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { aggregate } = require('./aggregate');
const { run } = require('./films');

const f = (id, o = {}) => ({ id, year: null, lang: null, countries: [], genres: [], directors: [], ...o });
const d = (name, id = name) => ({ id, name });

// Six films shown. By hand:
//   countries: FR in A,B,C → 3 · IT in B,E → 2 · JP in D → 1 · F has none → unknown 1   (B has two countries: counted once in each)
//   directors: Rohmer in A,C → 2 · Fellini in B → 1 · Ozu in D → 1 · Bergman in E (two credits with that name) → 1 · F none → unknown 1
//   decades: 1960s A,C · 1950s B,D · 1970s E · F has no year → unknown 1
//   languages: fr A,B,C · ja D · it E · F none → unknown 1
const SHOWN = [
  f('A', { year: 1963, lang: 'fr', countries: ['FR'], genres: ['Drama', 'Romance'], directors: [d('Rohmer')] }),
  f('B', { year: 1959, lang: 'fr', countries: ['FR', 'IT'], genres: ['Drama'], directors: [d('Fellini')] }),
  f('C', { year: 1969, lang: 'fr', countries: ['FR', 'FR'], genres: ['Romance', 'Romance'], directors: [d('Rohmer')] }),
  f('D', { year: 1953, lang: 'ja', countries: ['JP'], genres: ['Drama'], directors: [d('Ozu')] }),
  f('E', { year: 1972, lang: 'it', countries: ['IT'], genres: [], directors: [d('Bergman', 1), d('Bergman', 2)] }),
  f('F', {}),
];

test('aggregate: counts are numbers of films; a film with two countries counts once in each, a repeated value on one film counts once', () => {
  const a = aggregate(SHOWN);
  assert.equal(a.n, 6);
  assert.deepEqual(a.countries, [{ code: 'FR', films: 3 }, { code: 'IT', films: 2 }, { code: 'JP', films: 1 }], 'C lists FR twice: still one film');
  assert.deepEqual(a.directors, [{ name: 'Rohmer', films: 2 }, { name: 'Bergman', films: 1 }, { name: 'Fellini', films: 1 }, { name: 'Ozu', films: 1 }], 'ties by name; Bergman twice on E is one film');
  assert.deepEqual(a.decades, [{ decade: '1950s', films: 2 }, { decade: '1960s', films: 2 }, { decade: '1970s', films: 1 }]);
  assert.deepEqual(a.languages, [{ language: 'fr', films: 3 }, { language: 'it', films: 1 }, { language: 'ja', films: 1 }]);
  assert.deepEqual(a.genres, [{ genre: 'Drama', films: 3 }, { genre: 'Romance', films: 2 }]);
});

test('aggregate: what the record does not say is counted apart in `unknown`, never as a zero bucket or a bucket named unknown', () => {
  const a = aggregate(SHOWN);
  // F carries nothing; E has no genres
  assert.deepEqual(a.unknown, { countries: 1, directors: 1, decade: 1, language: 1, genres: 2 });
  for (const list of [a.countries, a.directors, a.decades, a.languages, a.genres]) {
    assert.ok(list.every((row) => row.films > 0), 'no zero bucket');
    assert.ok(!JSON.stringify(list).match(/unknown|null|undefined/i), 'unknown is not a bucket');
  }
  // every film is in a bucket or in unknown for each facet: the denominators add up to n
  const filmsWithCountry = SHOWN.filter((x) => x.countries.length).length;
  assert.equal(filmsWithCountry + a.unknown.countries, a.n);
  assert.equal(SHOWN.filter((x) => x.year != null).length + a.unknown.decade, a.n);
});

test('aggregate: a missing year or an empty-string language is unknown, never a bucket', () => {
  const a = aggregate([f('X', { year: null, lang: '' }), f('Y', { year: 2001, lang: 'en' })]);
  assert.deepEqual(a.decades, [{ decade: '2000s', films: 1 }]);
  assert.deepEqual(a.languages, [{ language: 'en', films: 1 }]);
  assert.equal(a.unknown.decade, 1);
  assert.equal(a.unknown.language, 1);
});

test('aggregate: nothing in, nothing invented', () => {
  const a = aggregate([]);
  assert.deepEqual(a, { n: 0, countries: [], directors: [], decades: [], languages: [], genres: [], unknown: { countries: 0, directors: 0, decade: 0, language: 0, genres: 0 } });
});

test('search --aggregate counts the films SHOWN (after --limit), says aggregateOver: shown, and is absent without the flag', () => {
  // the fixture of films.test.js is not exported; a tiny root of two films is enough to see that --limit cuts the aggregate too
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'films-agg-'));
  try {
    const mv = (id, imdb, title, year, c, dir) => [String(id), { t: 1760000000000, v: { id, imdb, title, year, runtime: 100, lang: 'en', genres: ['Drama'], keywords: [], directors: [{ id: id * 10, name: dir }], cast: [], countries: [c] } }];
    const tmdb = { movie: Object.fromEntries([mv(1, 'tt0000001', 'One', 2001, 'US', 'Ann'), mv(2, 'tt0000002', 'Two', 2002, 'FR', 'Bo')]), search: {} };
    const rec = (tm, imdb, title, year, r) => ({ title, year, tmdbId: tm, imdbId: imdb, r, rn: 100, t: 1760000000000 });
    fs.mkdirSync(path.join(root, 'cache')); fs.mkdirSync(path.join(root, 'data', 'letterboxd'), { recursive: true });
    fs.writeFileSync(path.join(root, 'cache', 'tmdb.json'), JSON.stringify(tmdb));
    fs.writeFileSync(path.join(root, 'cache', 'friends.json'), JSON.stringify({ films: { one: rec(1, 'tt0000001', 'One', 2001, 4.0), two: rec(2, 'tt0000002', 'Two', 2002, 3.8) }, users: {}, following: { users: [] }, me: { slugs: [] }, watchlist: { items: [] }, lists: {} }));
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ friends: [], moods: [] }));
    fs.writeFileSync(path.join(root, 'data', 'letterboxd', 'ratings.csv'), 'Date,Name,Year,Letterboxd URI,Rating\n');
    const idx = path.join(root, '.context', 'films', 'index.json');
    const all = run(['search', '--aggregate', '--limit', '0', '--sort', 'id', '--index', idx], { root });
    assert.equal(all.aggregateOver, 'shown');
    assert.equal(all.aggregate.n, 2);
    assert.deepEqual(all.aggregate.countries.map((c) => c.code).sort(), ['FR', 'US']);
    const one = run(['search', '--aggregate', '--limit', '1', '--sort', 'id', '--index', idx], { root });
    assert.equal(one.total, 2, 'total is the whole match');
    assert.equal(one.aggregate.n, 1, 'the aggregate is over the one film shown, not the two that matched');
    assert.deepEqual(one.aggregate.countries, [{ code: 'US', films: 1 }]);
    const none = run(['search', '--limit', '1', '--index', idx], { root });
    assert.equal(none.aggregate, undefined);
    assert.equal(none.aggregateOver, undefined);
    const ids = run(['search', '--aggregate', '--ids', '--limit', '1', '--sort', 'id', '--index', idx], { root });
    assert.equal(ids.aggregate.n, 1, 'also with --ids');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
