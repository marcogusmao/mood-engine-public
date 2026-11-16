// The friends' view (Marco, 29/10/2026, questionnaire): the Worker serves, at /u/<friend>/, the same index as Marco's with two swaps: "seen" is what the FRIEND has seen, and the Watchlist row is the
// FRIEND's watchlist. This module is what the build needs for that; worker/src/friends.js is the Worker's half (the two are compared by test/friend-view.test.js).
//
//   slug      the friend's address segment: the name in config.json "friends" (`friends.people[i]` of the index), lower case. It becomes part of a file name and of a URL, so it is [a-z0-9]{1,32}, it is unique, and
//             it is not "friend-a" (the segment that belongs to Will's own entry, worker/src/people.js). A name that does not fit stops the build, here, not at the first request.
//   masks     seenMask / wantMask, two columns of the index file derived from `friends` (lib/index-rows.js): bit i of seenMask is people[i] saw the film, bit i of wantMask is people[i] has it on the watchlist.
//   piece     data/index-v2-row-watchlist-<slug>.json, one per friend: the Board row "watchlist" as that friend would have it. The films the friend has on the watchlist and has NOT seen, the ones the build's
//             recommendation rule (`eligible`) lets through, in the order of the index (best rank first), at most V2_ROW_MAX, with the film's general text as the row's text. Written for every friend, empty
//             or not: a missing file is an outage, an empty one is an answer. It sits next to Marco's own index-v2-row-watchlist.json and never replaces it.
//   limits    only the films of the index. A film a friend saved that Marco's pool never held is not in any file and cannot be shown; the Board rows were chosen from Marco's unseen films, so a film Marco
//             has seen and the friend has not shows only where the Worker re-reads the whole index (Explore, Search, the calculated options of the Discover, a mood's slice) and never in a Board row the build cut.

const path = require("path");
const { V2_ROW_MAX } = require("./board-shared");
const { MAX_PEOPLE } = require("./index-rows");

const SLUG = /^[a-z0-9]{1,32}$/;
const RESERVED = new Set(["friend-a"]); // Will's own entry, /u/friend-a/ (worker/src/people.js)
/** The row of the Board that a friend's piece replaces, and the part name of the piece's file. */
const WATCHLIST_ROW = "watchlist";

/** A friend's name → the address segment. */
const slugOf = (name) => String(name).toLowerCase();

/** friends.people → their slugs, in the same order. Throws for a name that cannot be a segment, two names that give one, or a reserved one. */
function slugsOf(people) {
  if (people.length > MAX_PEOPLE) throw new Error(`friend view: ${people.length} friends, a mask holds ${MAX_PEOPLE}`);
  const out = people.map(slugOf);
  out.forEach((s, i) => {
    if (!SLUG.test(s)) throw new Error(`friend view: "${people[i]}" gives the address "${s}", which is not lower case letters and digits (1 to 32)`);
    if (RESERVED.has(s)) throw new Error(`friend view: "${people[i]}" gives the address "${s}", which is Will's`);
    if (out.indexOf(s) !== i) throw new Error(`friend view: "${people[i]}" and "${people[out.indexOf(s)]}" give the same address "${s}"`);
  });
  return out;
}

const pieceName = (slug) => `${WATCHLIST_ROW}-${slug}`;
const pieceFile = (slug) => path.join("data", `index-v2-row-${pieceName(slug)}.json`);
/** The `part` a friend's piece declares: "v2-row:watchlist-william". */
const piecePart = (slug) => `v2-row:${pieceName(slug)}`;

/**
 * The entries (object form) of the watchlist of `people[i]`, in the order of the index: wanted by that friend, not seen by that friend, `eligible`, at most V2_ROW_MAX.
 * `index.films` is in the build's order (best rank first), which is the order the Board's own watchlist row is not (that one is the newest first of Marco's list): a friend's list has no dates here.
 */
function watchlistFilms(index, i) {
  const name = index.friends.people[i];
  const out = [];
  for (const e of index.films) {
    if (out.length >= V2_ROW_MAX) break;
    const f = e.friends;
    if (!f || !f.wantBy.includes(name) || f.seenBy.some(([n]) => n === name) || !e.eligible) continue;
    out.push(e);
  }
  return out;
}

/** The piece of friend `i`: the object form of a v2 row file, or null when the Board has no `watchlist` row to replace. `labels` is index-export's menu-only copy of the index. */
function watchlistPiece(index, i, labels) {
  const entry = (index.board || []).find((r) => r.id === WATCHLIST_ROW && r.place === "board" && !r.series);
  if (!entry) return null;
  const films = watchlistFilms(index, i);
  const slug = slugsOf(index.friends.people)[i];
  return { rel: pieceFile(slug), part: piecePart(slug), obj: { ...labels(index), meta: { ...index.meta, part: piecePart(slug), count: films.length }, board: [entry], rows: { [WATCHLIST_ROW]: films.map((e) => e.tt) }, rowDesc: { [WATCHLIST_ROW]: films.map((e) => e.desc || "") }, films } };
}

module.exports = { SLUG, WATCHLIST_ROW, slugOf, slugsOf, pieceName, pieceFile, piecePart, watchlistFilms, watchlistPiece };
