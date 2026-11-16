'use strict';
// When a TMDB search hit counts as the film Marco logged (Marco, 11/10/2026: "Preparar o conserto num PR separado, sem publicar").
//
// lib/tmdb.js search() takes the best-scoring result for a title + year, and a homonym with the same title and year can win:
// on the 11/10/2026 caches Marco's 4.5 for Under the Skin (2013) went to a 19-minute short, his 5 for The Conformist (1970) to a
// record with no IMDb id, his 5 for Scenes from a Marriage (1973, 283 min) to the 169-minute 1974 cut. A hit is a link only when
// something else confirms it:
//   1. the cache entry is exact (lib/tmdb.js remember(), written from an RSS item that carried the TMDB id); or
//   2. Letterboxd's own records name that same film, and only it, for that title and year (by IMDb id, or — when the TMDB movie
//      cache does not know the hit yet — by the record's TMDB id); or
//   3. neither Letterboxd nor the TMDB movie cache knows anything else with that title and year, unless the hit has no IMDb id
//      and runs under 40 minutes: that is a short of the same name ("One Day" 2024 → a 3-minute film), whose rival is simply in
//      no cache (same rule as tools/films/project.js, 66222f1).
// Same year first; only when nothing has the same year, ±1 (festival vs release year), as the search itself tolerates.
//
// A refused hit is relinked when Marco's own Letterboxd pages name the film (Marco, 11/10/2026: "Religar quando a minha página
// do Letterboxd confirmar o filme"): exactly one record with that title and year among his /films/ slugs (a watched row) or his
// live watchlist slugs (a watchlist row). The caller still has to find that film in TMDB by its IMDb id; otherwise it is pending.
//
// Ids are the CLI's identity (tools/films/project.js): the IMDb id when TMDB knows it, else `tmdb:<id>`; a Letterboxd record
// is its IMDb id, else the TMDB film it names, else `lb:<slug>`. Covered by test/search-link.test.js.

const { norm } = require('./util');

const TT = /^tt\d+$/;
const SHORT_MINUTES = 40;

/** Items of `list` ([[id, year, …]]) with the same year, or — only when none — a year one away. No year: every item. */
function nearItems(list, year) {
  const all = list || [];
  if (!year) return all;
  const exact = all.filter(([, y]) => y === year);
  return exact.length ? exact : all.filter(([, y]) => y != null && Math.abs(y - year) === 1);
}
const near = (list, year) => new Set(nearItems(list, year).map(([id]) => id));

/**
 * movies: the TMDB movie cache ({ tmdbId: { v: { title, originalTitle, year, imdb, runtime } } }).
 * lbFilms: Letterboxd records ({ slug: { title, year, tmdbId, imdbId, gone } }), e.g. cache/friends.json → films.
 * mine: Marco's own pages, as slugs: { films: /films/ (cache/friends.json → me.slugs), watchlist: live watchlist slugs }.
 * → { idOfTmdb(tmdbId), tmdbOfImdb(imdb), check({ title, year, entry, pick, watched, watchlist }) }
 *   check → { ok: true } | { ok: false, reason: 'ambiguous' | 'short-without-imdb', searchPick, candidates, relink: { slug, imdb, tmdbId } | null }
 */
function makeSearchLinker({ movies = {}, lbFilms = {}, mine = {} } = {}) {
  const tmdbToId = new Map();
  const imdbToTmdb = new Map();
  const movieByTitle = new Map();
  const lbByTitle = new Map();
  const push = (m, k, item) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(item); };
  for (const [tid, entry] of Object.entries(movies)) {
    const v = entry?.v;
    if (!v) continue;
    const id = TT.test(v.imdb || '') ? v.imdb : `tmdb:${Number(tid)}`;
    tmdbToId.set(Number(tid), id);
    if (TT.test(v.imdb || '') && !imdbToTmdb.has(v.imdb)) imdbToTmdb.set(v.imdb, Number(tid));
    for (const t of new Set([v.title, v.originalTitle].filter(Boolean).map(norm))) push(movieByTitle, t, [id, v.year ?? null]);
  }
  for (const [slug, f] of Object.entries(lbFilms || {})) {
    if (!f || f.gone) continue;
    const id = TT.test(f.imdbId || '') ? f.imdbId : (f.tmdbId != null && tmdbToId.get(Number(f.tmdbId))) || `lb:${slug}`;
    push(lbByTitle, norm(f.title), [id, f.year ?? null, f.tmdbId != null ? Number(f.tmdbId) : null, slug]);
  }
  const mineFilms = new Set(mine.films || []);
  const mineWatch = new Set(mine.watchlist || []);
  const idOfTmdb = (tid) => tmdbToId.get(Number(tid)) || `tmdb:${Number(tid)}`;
  const tmdbOfImdb = (imdb) => imdbToTmdb.get(imdb) ?? null;

  /** Marco's own record for this title and year, when exactly one of his pages' records carries them. */
  function relinkOf({ title, year, watched, watchlist }) {
    const slugs = new Set([...(watched ? mineFilms : []), ...(watchlist ? mineWatch : [])]);
    if (!year || !slugs.size) return null;
    const own = (lbByTitle.get(norm(title)) || []).filter(([, y, , slug]) => y === year && slugs.has(slug));
    if (own.length !== 1) return null;
    const slug = own[0][3], f = lbFilms[slug];
    return { slug, imdb: TT.test(f.imdbId || '') ? f.imdbId : null, tmdbId: f.tmdbId != null ? Number(f.tmdbId) : null };
  }

  function check({ title, year, entry, pick, watched = false, watchlist = false }) {
    if (pick == null) return { ok: false, reason: 'no-hit', searchPick: null, candidates: [], relink: null };
    if (entry?.exact) return { ok: true };
    const known = tmdbToId.has(Number(pick));
    const id = idOfTmdb(pick);
    const Litems = nearItems(lbByTitle.get(norm(title)), year);
    const L = new Set(Litems.map(([lid]) => lid));
    const M = near(movieByTitle.get(norm(title)), year);
    M.add(id);
    const refuse = (reason) => ({ ok: false, reason, searchPick: id, candidates: [...new Set([...L, ...M])].sort(), relink: relinkOf({ title, year, watched, watchlist }) });
    if (L.size === 1 && L.has(id)) return { ok: true }; // Letterboxd names this same film for that title and year, and only it
    // The movie cache has not met the hit yet, so its IMDb id is unknown: the one Letterboxd record naming that TMDB id confirms it.
    if (L.size === 1 && !known && Litems.every(([, , tid]) => tid === Number(pick))) return { ok: true };
    if (!L.size && M.size === 1) {
      const v = movies[pick]?.v;
      if (!TT.test(v?.imdb || '') && Number.isFinite(v?.runtime) && v.runtime > 0 && v.runtime < SHORT_MINUTES) return refuse('short-without-imdb');
      return { ok: true }; // nothing else carries that title and year
    }
    return refuse('ambiguous');
  }

  return { idOfTmdb, tmdbOfImdb, check, lbRecords: Object.keys(lbFilms || {}).length };
}

/**
 * The TMDB film for a record Marco's page names ({ imdb, tmdbId }): the movie cache by IMDb id, else the record's TMDB id, else
 * TMDB's /find; used only when its IMDb id matches (a record's TMDB id can be a TV id that names another film). Offline: cache only.
 */
async function relinkTo(tmdb, linker, { imdb, tmdbId }) {
  const ids = [linker.tmdbOfImdb(imdb), tmdbId].filter((x, i, a) => x != null && a.indexOf(x) === i);
  for (const id of ids) { const m = await tmdb.movie(id); if (m?.imdb === imdb) return m; }
  const id = await tmdb.fromImdb(imdb);
  const m = id && !ids.includes(id) ? await tmdb.movie(id) : null;
  return m?.imdb === imdb ? m : null;
}

// ── the list Marco approved (lib/search-links-approved.json) and what tonight's build does differently ──
// An entry: [title, year, reason, search hit (TMDB id), IMDb id Marco's page names or null, relinked TMDB id or null (pending)].
const APPROVED = require('./search-links-approved.json');
const entryKey = (e) => `${e[0]} (${e[1]})`;
const say = (e, imdbOf) => `${entryKey(e)} ${e[5] != null ? `relinked to ${imdbOf(e[5]) || `tmdb:${e[5]} (no IMDb id in the cache)`}` : e[4] ? `pending (page names ${e[4]})` : `pending (${e[2]})`}`;

/**
 * { entered, left, changed } of tonight's entries against the approved ones, by title and year; each a list of phrases.
 * imdbOf(tmdbId): the IMDb id of the film actually linked (the build passes its TMDB cache), never the one the page names.
 */
function againstApproved(entries, approved = APPROVED.links, imdbOf = () => null) {
  const now = new Map(entries.map((e) => [entryKey(e), e]));
  const then = new Map(approved.map((e) => [entryKey(e), e]));
  const entered = [...now.keys()].filter((k) => !then.has(k)).map((k) => say(now.get(k), imdbOf));
  const left = [...then.keys()].filter((k) => !now.has(k)).map((k) => say(then.get(k), imdbOf));
  const changed = [...now.keys()].filter((k) => then.has(k) && JSON.stringify(now.get(k)) !== JSON.stringify(then.get(k))).map((k) => `${say(then.get(k), imdbOf)} → ${say(now.get(k), imdbOf).slice(k.length + 1)}`);
  return { entered, left, changed };
}

module.exports = { makeSearchLinker, near, SHORT_MINUTES, relinkTo, APPROVED, againstApproved };
