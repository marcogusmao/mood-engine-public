// The on-disk shape of the index: one array per film, columns named once in `cols`, composite values as short delimited strings.
//
// Why not one object per film: the Worker parses this file on every cold start, and the free plan gives a request 10 ms of CPU.
// JSON.parse spends its time on objects, keys and nested arrays, not on bytes: the same 8,500 films took ~8 ms as objects with
// nested arrays and ~4 ms as flat arrays of numbers and strings (measured, node 25). The Worker reads the strings on demand
// (worker/src/film.js); nothing here changes what a film IS: decode(encode(index)) is the object form that buildIndex() returns,
// which is what verify.js checks and what the tests read.
//
//   countries  "United States|France"        genres, keywords  "Crime|Thriller"
//   flags      1 = seen, 2 = on your watchlist, 4 = eligible as a recommendation (lib/recommendation-quality.js), 8 = held back by the music rule (lib/pool.js musicGate: a music film he has not seen and has no
//              evidence for; Marco, 22/10/2026 ~06:40 UTC). 8 is OPTIONAL and means nothing to a reader that does not know it (a Worker or an index from before reads bits 1, 2 and 4 only): the Worker's
//              `recommendable` is eligible AND NOT bit 8, so an index without the bit behaves exactly as before. 0 is written as null
//   lists      "crit:5,cannes:1"             list id : the position the list shows the film in (the curator's; lib/pool.js listSequence for a list with `order`)
//   moods      "night:1.2:3,lift:0.9:2.8"    mood id : fit : rank
//   friends    "0=4.5,1=;0;4.5"              the CONFIGURED friends only: seenBy (person=rating, rating empty when they logged it without stars);
//                                            wantBy (persons); friendsAvg.  A person is its place in friends.people.
//   seenBy, wantBy, friendsAvg   (separate columns) the crowd, everyone you follow plus the configured friends (51 people): how many saw the film,
//                                how many have it on their watchlist and have not seen it, and the average of the stars of those who saw and rated it
//   country    the film's main country, only when it is not the first of `countries` (the first of `countries` otherwise): the facts line of a description shows it
//   seenMask, wantMask   (Marco's own index, the last two columns; "visto por amigo", 29/10/2026) which of the configured friends saw the film / have it on their watchlist, one bit per person: bit i is
//                        friends.people[i] (the order of config.json "friends"), 1 << i. They are DERIVED from `friends` above when the file is written (encode), never stored in the object form, so the two cannot disagree;
//                        decode checks that they do not. The Worker reads the friend's bit of seenMask for "seen" in the /u/<friend>/ routes (worker/src/friends.js) instead of the flag bit 1, which is Marco's.
//                        0 is written as null. An index built for a person (meta.personId, Will's) keeps the 27 columns it always had and has neither.
//   decade     not stored: it is the year, rounded down to ten, plus "s"
// Trailing nulls are cut from every row, and the columns most films have come first, so most rows are short.

/** The columns, in file order. worker/src/film.js has the same list (a test compares them). */
const COLS = ["tt", "name", "year", "runtime", "countries", "lbRating", "rank", "taste", "quality", "desc", "find", "flags", "imdbRating", "seenBy", "wantBy", "friendsAvg", "lists", "friends", "moods", "language", "tmdbRating", "tmdbVotes", "genres", "director", "keywords", "poster", "country", "seenMask", "wantMask"];
/** The columns before the two masks (29/10/2026): what an index built for a person keeps writing, and what a file published before the friends' view has. The masks are the last two, so a row of this layout is a row of COLS without them. */
const COLS_NO_MASKS = COLS.slice(0, -2);
const FORMAT = "rows";
const MAX_PEOPLE = 31; // a mask is a 32-bit integer read with &: bit 31 would be the sign

/** The mask of the persons in `names` ([name] or [[name, rating]]), 1 << i for friends.people[i]; null when empty. `who` throws for a name that is not in friends.people. */
const maskOf = (names, who) => names.reduce((m, n) => m | (1 << who(Array.isArray(n) ? n[0] : n)), 0) || null;

const decadeOf = (year) => (year ? `${Math.floor(year / 10) * 10}s` : null);

/**
 * One entry (object form) → one row. `people` is friends.people. `masks: false` writes the layout of COLS_NO_MASKS (an index built for a person).
 * The two masks come from `e.friends`, the one place the build says who saw and who wants the film.
 */
function encodeFilm(e, people, { masks = true } = {}) {
  const who = (name) => {
    const i = people.indexOf(name);
    if (i < 0) throw new Error(`index: ${e.tt} names "${name}", who is not in friends.people`);
    if (i >= MAX_PEOPLE) throw new Error(`index: ${e.tt} names "${name}", who is person ${i}: a mask holds ${MAX_PEOPLE} people`);
    return i;
  };
  const word = (x, bad, what) => { if (bad.test(x)) throw new Error(`index: ${e.tt} has ${what} "${x}", which the file format cannot carry`); return x; };
  const list = (xs) => (xs ? xs.map((x) => word(x, /\|/, "a value")).join("|") : null);
  const v = {
    tt: e.tt, name: e.name, year: e.year ?? null, runtime: e.runtime ?? null, countries: list(e.countries), lbRating: e.lbRating ?? null, rank: e.rank ?? null,
    taste: e.taste ?? null, quality: e.quality ?? null, desc: e.desc ?? null, find: e.find ?? null, flags: (e.seen ? 1 : 0) | (e.watchlist ? 2 : 0) | (e.eligible ? 4 : 0) | (e.musicOut ? 8 : 0) | (e.shortOut ? 16 : 0) || null, // 16: a short (15/11/2026; lib/index-export.js buildIndex)
    imdbRating: e.imdbRating ?? null, seenBy: e.seenBy ?? null, wantBy: e.wantBy ?? null, friendsAvg: e.friendsAvg ?? null,
    lists: e.lists ? Object.entries(e.lists).map(([id, pos]) => `${word(id, /[:,]/, "a list id")}:${pos}`).join(",") : null,
    friends: e.friends ? `${e.friends.seenBy.map(([n, r]) => `${who(n)}=${r ?? ""}`).join(",")};${e.friends.wantBy.map(who).join(",")};${e.friends.friendsAvg ?? ""}` : null,
    moods: e.moods ? Object.entries(e.moods).map(([id, [fit, rank]]) => `${word(id, /[:,]/, "a mood id")}:${fit}:${rank}`).join(",") : null,
    language: e.language ?? null, tmdbRating: e.tmdbRating ?? null, tmdbVotes: e.tmdbVotes ?? null, genres: list(e.genres), director: e.director ?? null,
    keywords: list(e.keywords), poster: e.poster ?? null, country: e.country ?? null,
    seenMask: masks && e.friends ? maskOf(e.friends.seenBy, who) : null, wantMask: masks && e.friends ? maskOf(e.friends.wantBy, who) : null,
  };
  const row = (masks ? COLS : COLS_NO_MASKS).map((c) => v[c]);
  while (row.length && row[row.length - 1] === null) row.pop();
  return row;
}

/** One row → one entry, with the keys absent when the value is (the object form of lib/index-export.js). */
function decodeFilm(row, people, { masks = false } = {}) {
  if (row.length > COLS.length) throw new Error(`index: ${row[0]} has ${row.length} cells, the file has ${COLS.length} columns`);
  const person = (i) => { if (!(Number(i) in people)) throw new Error(`index: ${row[0]} names person ${i}, who is not in friends.people`); return people[Number(i)]; };
  const get = (c) => { const x = row[COLS.indexOf(c)]; return x === undefined || x === null || x === "" ? undefined : x; };
  const e = { tt: row[0], name: row[1] };
  const put = (k, x) => { if (x !== undefined) e[k] = x; };
  put("year", get("year"));
  put("decade", decadeOf(get("year")) || undefined);
  for (const k of ["runtime", "language", "lbRating", "tmdbRating", "tmdbVotes", "imdbRating", "seenBy", "wantBy", "friendsAvg", "taste", "quality", "rank", "poster", "desc", "director", "country"]) put(k, get(k));
  for (const k of ["countries", "genres", "keywords"]) put(k, get(k) ? get(k).split("|") : undefined);
  put("moods", get("moods") ? Object.fromEntries(get("moods").split(",").map((s) => { const [id, fit, rank] = s.split(":"); return [id, [Number(fit), Number(rank)]]; })) : undefined);
  put("lists", get("lists") ? Object.fromEntries(get("lists").split(",").map((s) => { const [id, pos] = s.split(":"); return [id, Number(pos)]; })) : undefined);
  if (get("friends")) {
    const [seen, want, avg] = get("friends").split(";");
    e.friends = {
      seenBy: seen ? seen.split(",").map((s) => { const [i, r] = s.split("="); return [person(i), r === "" ? null : Number(r)]; }) : [],
      wantBy: want ? want.split(",").map(person) : [],
    };
    if (avg) e.friends.friendsAvg = Number(avg);
  }
  // the masks are the friends again, in another shape: a row whose masks disagree with its `friends` is refused (a hand-edited or half-written file)
  for (const [c, names] of [["seenMask", e.friends ? e.friends.seenBy : []], ["wantMask", e.friends ? e.friends.wantBy : []]]) {
    const have = row[COLS.indexOf(c)];
    if (have === undefined && !masks) continue; // only the old declared layout may omit a nonzero mask
    const want = maskOf(names, (n) => people.indexOf(n));
    if ((have ?? null) !== want) throw new Error(`index: ${row[0]} has ${c} ${have} but its friends say ${want}`);
  }
  const flags = get("flags") || 0;
  if (flags & 16) e.shortOut = true;
  if (flags & 8) e.musicOut = true;
  if (flags & 4) e.eligible = true;
  if (flags & 2) e.watchlist = true;
  if (flags & 1) e.seen = true;
  put("find", get("find"));
  return e;
}

/** Object form → file form. */
function encode(index) {
  const people = (index.friends && index.friends.people) || [];
  const masks = !(index.meta && index.meta.personId); // Marco's index has the friends' masks; a person's (Will's) keeps the columns it had, byte for byte
  return { ...index, meta: { ...index.meta, format: FORMAT }, cols: masks ? COLS : COLS_NO_MASKS, films: index.films.map((e) => encodeFilm(e, people, { masks })) };
}

/** File form → object form (what buildIndex() returns, key order aside). */
function decode(file) {
  const have = JSON.stringify(file.cols);
  if (have !== JSON.stringify(COLS) && have !== JSON.stringify(COLS_NO_MASKS)) throw new Error(`index: columns are ${have}, expected ${JSON.stringify(COLS)}`);
  const width = file.cols.length;
  for (const r of file.films) if (r.length > width) throw new Error(`index: ${r[0]} has ${r.length} cells, the file has ${width} columns`);
  const people = (file.friends && file.friends.people) || [];
  const { cols, ...rest } = file;
  const { format, ...meta } = file.meta;
  return { ...rest, meta, films: file.films.map((r) => decodeFilm(r, people, { masks: width === COLS.length })) };
}

module.exports = { COLS, COLS_NO_MASKS, FORMAT, MAX_PEOPLE, encode, decode, encodeFilm, decodeFilm, decadeOf };
