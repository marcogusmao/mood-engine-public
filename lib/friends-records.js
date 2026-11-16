// The TMDB record of the films the friends' rows show (Marco, 22/10/2026 ~21:40 UTC, "friends-cards"). Written against: 25 of the 243 cards of the friends' rows of the live Board had no credits
// line (director, duration, actors): Intermissions, Inside Out 2, Happy Feet, Demolition, The Amazing Spider-Man 2, Entourage, Marighella, Good Night Oppy, The Night House ... They are films of the people he
// follows that are not in the pool (friends-split, friends-month, friends-week and the top picks below 4.5 reach films nobody put on a list or a watchlist), so nothing asked TMDB about them: the TMDB
// record is read from cache/tmdb.json only, the build fetched a record only for the pool and for the rows' own items under the TMDB id Letterboxd names, and the nightly adds no other. Three of the 25 were
// series with the type "movie" (Ripley, The Queen's Gambit, Scenes from a Marriage 2021): `find` was never asked about two of them, so lib/tmdb.js noRecord could not say that TMDB has no movie of them.
//
// fillRecords() asks, for every film given, what the build needs to know and does not know yet, and nothing else:
//   1  the movie under the TMDB id Letterboxd names (`tmdb.movie`), when the cache never held it or holds it empty;
//   2  when that record is not the film's OWN (it names another IMDb id, or none, or the movie is empty): `find` by IMDb id (`tmdb.fromImdb`, cached a year), and the movie it finds.
// Both go through lib/tmdb.js with its cache and its TTL, so a film already known costs nothing and a film TMDB lacks costs two small asks once (then 45 days / a year).
// The card reads the record `find` found through lib/pool.js ownDetail(peek, findOf), lib/special-rows.js and lib/index-export.js detailOfImdb (22/10/2026, review: until then it was fetched and no card read it).
// What `find` finds a series not to have is exactly what lib/tmdb.js noRecord reads, so the recommendation rule and the friends' collections (lib/rows.js `unrecorded`) leave the series out of the rows without a second definition.
//
// Offline nothing is asked and nothing is stored: Tmdb#movie / #fromImdb keep `{ v: null }` IN MEMORY for an id nobody asked when OFFLINE (the latent risk of the BACKLOG of 22/10/2026), and noRecord
// would read that as an empty answer and hide the film. `pending()` still says how many films would be asked, so an offline build can report what the nightly has left to do.

const TT = /^tt\d+$/;

/** The unique films of `films` ([{ imdb, tmdbId }] or items { id, tmdb }) that carry a valid IMDb id, first spelling kept. */
function unique(films) {
  const seen = new Map();
  for (const f of films || []) {
    const imdb = f && (f.imdb ?? f.id);
    if (typeof imdb !== "string" || !TT.test(imdb) || seen.has(imdb)) continue;
    seen.set(imdb, { imdb, tmdbId: (f.tmdbId ?? f.tmdb) || null });
  }
  return [...seen.values()];
}

/**
 * What the cache of `tmdb` knows about one film: "own" (a record that carries its IMDb id, under the TMDB id Letterboxd names or under the one `find` gave), "empty" (everything that could be asked was
 * asked and TMDB has no movie of it: the series and the episodes) or "pending" (something was never asked). Reads the cache; asks nothing.
 */
function stateOf(tmdb, { imdb, tmdbId }) {
  const movie = tmdb.cache.movie, find = tmdb.cache.find;
  const m = tmdbId ? movie[tmdbId] : undefined;
  if (tmdbId && !m) return "pending"; // the TMDB id Letterboxd names was never asked
  if (m && m.v && m.v.imdb === imdb) return "own";
  const f = find[imdb];
  if (!f) return "pending"; // not its own record, and `find` was never asked
  if (f.v && f.v !== tmdbId) {
    const e = movie[f.v];
    if (!e) return "pending"; // find has an id and its movie was never fetched
    if (e.v && e.v.imdb === imdb) return "own";
  }
  return "empty";
}

/** The films of `films` whose state is "pending": what fillRecords() would ask. */
function pending(tmdb, films) {
  return unique(films).filter((f) => stateOf(tmdb, f) === "pending");
}

/**
 * The films that `noRecord` already hides from the rows and that nothing else would ever ask about again (review of friends-cards, 22/10/2026): the movie under the number Letterboxd names came back empty
 * (so lib/tmdb.js noRecord is true, the film never reaches a row, and `settle` never sees it as pending) while `find` was never asked (17 films of the cache of 22/10/2026, all series), or everything asked came back empty
 * and an answer may have expired (45 days a movie, a year a `find`). fillRecords() over these asks what is missing or expired and nothing else: a `find` that finds a movie un-hides the film. Not the films whose
 * Letterboxd number was never asked (thousands: only the rows' own films are asked about).
 */
// Only films the rule really hides: a record that some cached movie holds under another number names the IMDb id (George Harrison: Living in the Material World, tt1113829, record 1676821) and `noRecord` is false for it.
function hidden(tmdb, films) {
  return unique(films).filter((f) => tmdb.noRecord(f.imdb, f.tmdbId) && ((f.tmdbId && tmdb.cache.movie[f.tmdbId]?.v === null) || stateOf(tmdb, f) === "empty"));
}

/**
 * Ask TMDB for the records the films still lack. → { films, calls } (films looked at, TMDB tries spent). Not offline (see the top of this file). The caller saves the cache (`tmdb.save()`).
 * A film that is already "own" is not touched (no `movie()` call, so no trailer backfill is spent on it); an "empty" one given here is looked at again only through the TTLs of lib/tmdb.js (45 days / a year).
 * settle() gives it only the PENDING films, so a series that left the rows is not asked again by this step (it is no longer in the rows): it comes back when the pool or the lists ask again, as for PR #73 ("coming back").
 */
async function fillRecords(tmdb, films) {
  if (process.env.OFFLINE) return { films: 0, calls: 0 };
  const todo = unique(films).filter((f) => stateOf(tmdb, f) !== "own");
  const before = tmdb.calls;
  const asked = (id) => tmdb.cache.movie[id];
  await Promise.all(todo.map(async ({ imdb, tmdbId }) => {
    if (tmdbId) {
      const e = asked(tmdbId);
      const d = !e || e.v === null ? await tmdb.movie(tmdbId) : e.v;
      if (d && d.imdb === imdb) return; // the record Letterboxd names is the film's own
    }
    const id = await tmdb.fromImdb(imdb); // a series, an episode or a film TMDB has not listed: null, cached a year
    if (id && id !== tmdbId) {
      const e = asked(id);
      if (!e || e.v === null) await tmdb.movie(id);
    }
  }));
  return { films: todo.length, calls: tmdb.calls - before };
}

/**
 * Build rows, ask TMDB for the films they show that still lack a record, build again, until nothing is pending (a film whose `find` came back empty leaves the rows and the next films take its
 * place, and those need their record too). build() → rows; filmsOf(rows) → films (items { id, tmdb } or { imdb, tmdbId }). Offline: one build, and `pending` says what the nightly will ask.
 * → { out, rounds, films (asked), pending (left in the final rows), capped (true when `max` rounds were not enough) }
 */
async function settle(tmdb, build, filmsOf, { max = 4 } = {}) {
  let out = build(), rounds = 0, films = 0;
  for (;;) {
    const todo = pending(tmdb, filmsOf(out));
    if (!todo.length || process.env.OFFLINE) return { out, rounds, films, pending: todo.length, capped: false };
    if (rounds >= max) return { out, rounds, films, pending: todo.length, capped: true };
    await fillRecords(tmdb, todo);
    films += todo.length;
    rounds++;
    out = build();
  }
}

module.exports = { fillRecords, pending, hidden, stateOf, settle, unique };
