'use strict';
// films — counts over the records a command SHOWED (Fase A, 12/10/2026). Pure: records in, numbers out.
// Every count is a number of FILMS: a film with two countries counts once in each, a director listed twice on one film counts once.
// A fact the record does not carry is counted in `unknown`, never as a zero-valued bucket ("unknown" means the source does not say).
// Order: count descending, then name ascending (plain code-unit order, so the answer is the same on every machine).
// Covered by tools/films/aggregate.test.js.

const byCountThenName = (key) => (a, b) => b.films - a.films || (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);

function tally(records, valuesOf, key) {
  const counts = new Map();
  let unknown = 0;
  for (const r of records) {
    const values = [...new Set(valuesOf(r).filter((v) => v != null && v !== ''))];
    if (!values.length) { unknown++; continue; }
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  }
  return { list: [...counts].map(([k, films]) => ({ [key]: k, films })).sort(byCountThenName(key)), unknown };
}

/** records: projection records (tools/films/project.js). → { n, countries, directors, decades, languages, genres, unknown } */
function aggregate(records = []) {
  const countries = tally(records, (f) => f.countries || [], 'code');
  const directors = tally(records, (f) => (f.directors || []).map((d) => d.name), 'name');
  const decades = tally(records, (f) => (Number.isFinite(f.year) ? [`${Math.floor(f.year / 10) * 10}s`] : []), 'decade');
  const languages = tally(records, (f) => (f.lang ? [f.lang] : []), 'language');
  const genres = tally(records, (f) => f.genres || [], 'genre');
  return {
    n: records.length,
    countries: countries.list, directors: directors.list, decades: decades.list, languages: languages.list, genres: genres.list,
    unknown: { countries: countries.unknown, directors: directors.unknown, decade: decades.unknown, language: languages.unknown, genres: genres.unknown },
  };
}

module.exports = { aggregate };
