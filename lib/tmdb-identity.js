// A Letterboxd record and the TMDB record its tmdbId points at must be the same film.
// Old friends.json records (before the 10/10/2026 tv-id fix in lib/friends.js parseFilmPage) can carry a TMDB *tv* id, and that
// number names an unrelated film in the movie cache: Neon Genesis Evangelion (tt0112159) -> "Brother of Sleep", 132 min.
// When the cached movie's IMDb id differs from the record's, the record loses its tmdbId in a copy (cache bytes untouched), so
// every later join (detail, pool, rows, seen) falls back to the Letterboxd facts. Covered by test/tmdb-identity.test.js.
// A cached movie with NO IMDb id is not dropped here (lib/list-signal.js counts those as refused, test/catalog-expansion.test.js reads that count): what the static rows show,
// and since 21/10/2026 the pool's ranking and facts, ask lib/pool.js ownDetail instead (tt0204394, tt8101850, tt5580146).

/** films: { slug -> record }, peek(tmdbId) -> cached TMDB movie or null → { films (same object when nothing conflicts), conflicts } */
function consistentFilms(films = {}, peek = () => null) {
  const conflicts = [];
  for (const [slug, r] of Object.entries(films)) {
    if (!r || !r.tmdbId || !/^tt\d+$/.test(r.imdbId || "")) continue;
    const other = peek(r.tmdbId)?.imdb;
    if (other && other !== r.imdbId) conflicts.push({ slug, imdbId: r.imdbId, tmdbId: r.tmdbId, tmdbImdb: other });
  }
  if (!conflicts.length) return { films, conflicts };
  const out = { ...films };
  for (const c of conflicts) out[c.slug] = { ...films[c.slug], tmdbId: null };
  return { films: out, conflicts };
}

module.exports = { consistentFilms };
