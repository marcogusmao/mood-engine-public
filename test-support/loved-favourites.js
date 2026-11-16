'use strict';
// The director half of the floor exception, read back from a build's own log (review S4-6, 11/10/2026): the films of
// data/directors-loved.json that a FAVOURITE director loves through a high or medium source. The tests compared against every film
// of the file, so a vouched() that forgot to keep only the favourites' films passed them; the favourites need the taste model, which
// the build prints ("Loved by your directors: 24 favourite directors with films on file (Francis Ford Coppola 0.90, Martel 0.90, …)").
const fs = require('fs'), path = require('path');
function lovedByFavourites(log, root) {
  const DL = require(path.join(root, 'lib', 'directors-loved.js'));
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const lc = { ...DL.DEFAULTS, ...(cfg.directorsLoved || {}) };
  const data = JSON.parse(fs.readFileSync(path.join(root, lc.file), 'utf8'));
  const m = String(log).match(/Loved by your directors: (\d+) favourite directors with films on file \((.*?)\) · \d+ unseen films/);
  if (!m) throw new Error('no "Loved by your directors" line in the build log');
  const shown = m[2].split(', ').map((x) => x.match(/^(.*) (\d+\.\d\d)(?: \[[^\]]+\])?$/)).map((x) => x && x[1]);
  if (shown.length !== Number(m[1]) || shown.some((x) => !x)) throw new Error(`could not read ${m[1]} favourites from: ${m[2]}`);
  const withFilms = data.directors.filter((d) => (d.films || []).length);
  const byLabel = new Map([...DL.shortNames(withFilms.map((d) => d.name), lc.labels)].map(([name, label]) => [label, name]));
  const favorites = shown.map((label) => { const name = byLabel.get(label); if (!name) throw new Error(`favourite ${label} is not a director of the file`); return { name, label, weight: 1 }; });
  return new Set(DL.lovedFilms({ data, favorites }).map((c) => c.imdb));
}
module.exports = { lovedByFavourites };
