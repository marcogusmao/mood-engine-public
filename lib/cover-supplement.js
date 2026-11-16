'use strict';
// Reviewed public facts for cover art only, keyed by a source-confirmed IMDb identity.
// Keep this JSON in the frozen source set; selection and index metadata never read it.
function read(data = require('./cover-facts.json')) {
  if (!data || data.version !== 1 || !data.items || Array.isArray(data.items)) throw Error('Invalid cover facts');
  const out = new Map();
  for (const [tt, entry] of Object.entries(data.items)) {
    if (!/^tt\d+$/.test(tt) || !entry || !Array.isArray(entry.countries) ||
        !entry.countries.every(c => /^[A-Z]{2}$/.test(c)) ||
        (entry.language != null && !/^[a-z]{2,3}$/.test(entry.language)) ||
        typeof entry.identity !== 'string' || !entry.identity.trim() ||
        typeof entry.source !== 'string' || !/^https:\/\//.test(entry.source) ||
        !Number.isFinite(Date.parse(entry.retrievedAt))) throw Error('Invalid cover fact: ' + tt);
    out.set(tt, { imdb: tt, countries: [...entry.countries], language: entry.language || null, origin: 'supplemental' });
  }
  return out;
}
module.exports = { read };
