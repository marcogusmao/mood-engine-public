// The safety net of the build: nothing you have seen may be published in a row (except the catalogs listed in
// GUARD_EXEMPT, by name), and nothing without an IMDb id (tt…) may be published at all, because Stremio would show a
// poster that opens no streams. It reads the plan flat (lib/plan.js guardRows): every Board row and every
// Discover option file, so a Discover-only file cannot slip past a check made on the Board.
//
// "Seen" is decided by five identities, any one of which is enough: the TMDB id, the IMDb id (seenTts, below), the
// Letterboxd slug (or the address it redirects to), and the title (the English one and the original one) within a year.

const { GUARD_EXEMPT } = require("./plan");

/** "mood-engine-lists/genre=Cannes Winners" → "mood-engine-lists"; "oldfriends" → "oldfriends". */
const catalogOf = (key) => String(key).split("/")[0];

/**
 * Every IMDb id that belongs to a film you have seen, found through whatever else is known about it:
 *   - the IMDb id of each TMDB id in seenIds (imdbOfTmdb)
 *   - every Letterboxd film record (slug → { imdbId, tmdbId, title, year, canon }) that is seen by TMDB id, by title and
 *     year, or because its slug is on your own /films/ page (`me`). One seen slug is enough for its IMDb id: two
 *     Letterboxd pages can point at one IMDb id, and the film is seen whichever page led to it.
 * This is what catches a film your export knows by one year (Letterboxd: 2004) and TMDB by another (2011).
 */
function seenImdbIds({ films = {}, me = new Set(), seenIds = new Set(), titleSeen = () => false, imdbOfTmdb = () => null }) {
  const out = new Set();
  for (const id of seenIds) { const tt = imdbOfTmdb(id); if (tt) out.add(tt); }
  for (const [slug, r] of Object.entries(films)) {
    if (!r || !r.imdbId) continue;
    if ((r.tmdbId && seenIds.has(r.tmdbId)) || me.has(slug) || (r.canon && me.has(r.canon)) || titleSeen(r.title, r.year)) out.add(r.imdbId);
  }
  return out;
}

/**
 * rows: { key → [{ id, tmdb, slug, canon, title, originalTitle, year }] }, key = row id or "<catalog id>/genre=<option>"
 * seen: { seenIds: Set<tmdbId>, seenTts: Set<imdbId>, titleSeen(title, year) → bool, seenSlugs: Set<letterboxd slug> }
 * allow: catalog ids that may hold films you have seen (default: GUARD_EXEMPT). An exempt catalog still needs a tt id.
 * → list of human-readable problems; empty means safe to publish.
 */
function findLeaks(rows, { seenIds, seenTts = new Set(), titleSeen, seenSlugs = new Set(), allow = GUARD_EXEMPT }) {
  const problems = [];
  for (const [rowId, list] of Object.entries(rows)) {
    for (const it of list) {
      if (!/^tt\d+$/.test(String(it.id))) problems.push(`${it.title} (${it.year}) in ${rowId} has no IMDb id`);
      if (allow.includes(catalogOf(rowId))) continue;
      if (
        (it.tmdb && seenIds.has(it.tmdb)) || seenTts.has(it.id) || titleSeen(it.title, it.year) || (it.originalTitle && titleSeen(it.originalTitle, it.year)) ||
        (it.slug && seenSlugs.has(it.slug)) || (it.canon && seenSlugs.has(it.canon))
      )
        problems.push(`${it.title} (${it.year}) in ${rowId}`);
    }
  }
  return problems;
}

module.exports = { findLeaks, seenImdbIds, catalogOf };
