// The index as the Worker holds it: each film is a Film around its row of the file (lib/index-rows.js has the format and why).
//
// A Film does nothing until it is asked. Plain columns come straight from the row; the composite ones (countries, lists, moods,
// friends) are short delimited strings that are only taken apart for the films a request actually looks at, so a cold start pays
// for JSON.parse and one cheap wrapper per film, nothing more.

export const COLS = ["tt", "name", "year", "runtime", "countries", "lbRating", "rank", "taste", "quality", "desc", "find", "flags", "imdbRating", "seenBy", "wantBy", "friendsAvg", "lists", "friends", "moods", "language", "tmdbRating", "tmdbVotes", "genres", "director", "keywords", "poster", "country", "seenMask", "wantMask"];
/** Column numbers. Hot loops (the scan of every film in a search or a filter) read `film.r[C.find]` directly: a getter call per column per film is what a cold isolate, still interpreting, cannot afford. */
export const C = Object.fromEntries(COLS.map((c, i) => [c, i]));
const [TT, NAME, YEAR, RUNTIME, COUNTRIES, LB, RANK, TASTE, QUALITY, DESC, FIND, FLAGS, IMDB, SEEN_BY, WANT_BY, FRIENDS_AVG, LISTS, FRIENDS, MOODS, LANGUAGE, TMDB, VOTES, GENRES, DIRECTOR, KEYWORDS, POSTER, COUNTRY, SEEN_MASK, WANT_MASK] = COLS.map((_, i) => i);
const val = (v) => (v === null || v === "" ? undefined : v);

/** "crit:5,cannes:1" + "crit" → "5". A start-of-string or a comma must come before the id, so "crit" never matches "secrit". */
function after(s, id) {
  if (!s) return undefined;
  const key = `${id}:`;
  let at = 0;
  if (!s.startsWith(key)) {
    const k = s.indexOf(`,${key}`);
    if (k < 0) return undefined;
    at = k + 1;
  }
  at += key.length;
  const end = s.indexOf(",", at);
  return s.slice(at, end < 0 ? undefined : end);
}

function makeFilm(people) {
  class Film {
    constructor(row) { this.r = row; this._f = undefined; this._g = undefined; }
    get tt() { return this.r[TT]; }
    get name() { return this.r[NAME]; }
    get year() { return val(this.r[YEAR]); }
    get decade() { const y = this.r[YEAR]; return y ? `${Math.floor(y / 10) * 10}s` : undefined; }
    get runtime() { return val(this.r[RUNTIME]); }
    get lbRating() { return val(this.r[LB]); }
    get tmdbRating() { return val(this.r[TMDB]); }
    get tmdbVotes() { return val(this.r[VOTES]); }
    get imdbRating() { return val(this.r[IMDB]); }
    /** The crowd (everyone you follow): how many saw it, how many want to see it, the average of those who rated it. */
    get seenBy() { return val(this.r[SEEN_BY]); }
    get wantBy() { return val(this.r[WANT_BY]); }
    get friendsAvg() { return val(this.r[FRIENDS_AVG]); }
    get taste() { return val(this.r[TASTE]); }
    get quality() { return val(this.r[QUALITY]); }
    get rank() { return val(this.r[RANK]); }
    get language() { return val(this.r[LANGUAGE]); }
    get poster() { return val(this.r[POSTER]); }
    /** The main country of the facts line, when it is not the first of `countries` (the build writes the column only then; 136 films have no `countries` at all and a country here). */
    get mainCountry() { return val(this.r[COUNTRY]) ?? (this.countries && this.countries[0]); }
    get desc() { return val(this.r[DESC]); }
    get director() { return val(this.r[DIRECTOR]); }
    get find() { return val(this.r[FIND]); }
    get seen() { return (this.r[FLAGS] & 1) === 1; }
    /** Which of the configured friends saw the film / have it on the watchlist, bit i = friends.people[i] (lib/index-rows.js; 29/10/2026). 0 when none, and for an index from before the columns: the friends' routes refuse such an index (`masks` of hydrate()). */
    get seenMask() { return this.r[SEEN_MASK] || 0; }
    get wantMask() { return this.r[WANT_MASK] || 0; }
    get watchlist() { return (this.r[FLAGS] & 2) === 2; }
    /** The build's verdict on the recommendation rule (lib/recommendation-quality.js): Letterboxd average ≥ 3.5 or a configured friend's
     *  rating ≥ 3.5; a vouched film (critic or director list, critics' subset, a favourite director's love) needs only 2.5, or no average. */
    get eligible() { return (this.r[FLAGS] & 4) === 4; }
    /** Held back by the music rule (bit 8 of the flags; lib/pool.js musicGate, Marco, 22/10/2026 ~06:40 UTC): a music film he has not seen and has no evidence for. An index built before has no such bit: false. */
    get musicOut() { return (this.r[FLAGS] & 8) === 8; }
    /** A short, by the build's verdict (bit 16 of the flags): a film whose KNOWN runtime is under config.json shortRow.minMinutes (40). Marco's sentence, 15/11/2026, on where shorts may still appear, is
     *  "Only where you or a source put them (recommended)"; that the Worker's own catalogs that recommend follow it is the consequence the session drew (catalogs.js, the header). The build decides
     *  (lib/pool.js isShort, on the index's own `runtime` and `meta.minFeatureMinutes`) and the Worker only reads the bit: one definition. A film with no known runtime has no bit. An index built before has no such bit: false. */
    get shortOut() { return (this.r[FLAGS] & 16) === 16; }
    /** What RECOMMENDS may show it: eligible (bit 4), not held back by the music rule (bit 8) and not a short (bit 16). Search and the collections (Lists, Friends, the watchlist) read `eligible` alone.
     *  One test of the three bits (4 + 8 + 16 = 28): this getter runs once per film in Explore and in a mood. An index without bits 8 or 16 behaves as before. */
    get recommendable() { return (this.r[FLAGS] & 28) === 4; }
    /** The same without the short bit: eligible and not held back by the music rule. For an option of the Discover that says `shorts: true` (an era: its file names the shorts in its ids, and "a source put them there"; catalogs.js). */
    get recommendableOrShort() { return (this.r[FLAGS] & 12) === 4; }
    get countries() { const s = val(this.r[COUNTRIES]); return s ? s.split("|") : undefined; }
    get genres() { if (this._g === undefined) { const s = val(this.r[GENRES]); this._g = s ? s.split("|") : null; } return this._g || undefined; } // split once: a card reads it four or five times (28/10/2026)
    get keywords() { const s = val(this.r[KEYWORDS]); return s ? s.split("|") : undefined; }
    /** Is `label` one of the film's countries? (exact label, as the menu gives it) */
    hasCountry(label) { const s = this.r[COUNTRIES]; return !!s && (s === label || s.startsWith(`${label}|`) || s.endsWith(`|${label}`) || s.includes(`|${label}|`)); }
    /** The position the film is SHOWN in, in a list (the curator's; the rank by Letterboxd average for a list with `order: "rating"`, decided by the build, lib/pool.js listSequence), or undefined when it is not in it. */
    listPos(id) { const p = after(this.r[LISTS], id); return p === undefined ? undefined : Number(p); }
    /** [fit, rank] of the film in a mood, or undefined when it does not fit. */
    mood(id) { const p = after(this.r[MOODS], id); if (p === undefined) return undefined; const [fit, rank] = p.split(":"); return [Number(fit), Number(rank)]; }
    /** Every mood the film fits, [[id, fit]] in the column's order (the card chips, meta.js); [] when none. */
    get moodFits() { const s = this.r[MOODS]; return s ? s.split(",").map((p) => { const [id, fit] = p.split(":"); return [id, Number(fit)]; }) : []; }
    /** The ids of every list the film is in, in the column's order (the card chips, meta.js); [] when none. */
    get listIds() { const s = this.r[LISTS]; return s ? s.split(",").map((p) => p.slice(0, p.indexOf(":"))) : []; }
    /** { seenBy: [[name, rating|null]], wantBy: [name], friendsAvg? } or undefined; decoded once. */
    get friends() {
      if (this._f !== undefined) return this._f || undefined;
      const s = this.r[FRIENDS];
      if (!s) { this._f = null; return undefined; }
      const [seen, want, avg] = s.split(";");
      const f = {
        seenBy: seen ? seen.split(",").map((x) => { const [i, r] = x.split("="); return [people[Number(i)], r === "" ? null : Number(r)]; }) : [],
        wantBy: want ? want.split(",").map((i) => people[Number(i)]) : [],
      };
      if (avg) f.friendsAvg = Number(avg);
      return (this._f = f);
    }
  }
  return Film;
}

/** The columns of the index before `country` (13/10/2026): still readable, a film then shows the first of its `countries` in the facts line. */
export const LEGACY_COLS = COLS.slice(0, COLS.indexOf("country"));
/** The columns before the friends' masks (29/10/2026): what every file published until then has, and what an index built for a person still has. Readable; it just cannot serve /u/<friend>/ (hydrate's `masks` is false). */
export const NO_MASK_COLS = COLS.slice(0, COLS.indexOf("seenMask"));

/** The parsed file → the index the rest of the Worker reads: `films` are Film objects, everything else as written; `masks` requires both declared columns and valid mask cells in every row. */
export function hydrate(file) {
  const have = JSON.stringify(file.cols);
  if (have !== JSON.stringify(COLS) && have !== JSON.stringify(NO_MASK_COLS) && have !== JSON.stringify(LEGACY_COLS)) throw new Error(`the columns are ${JSON.stringify(file.cols)}, this Worker reads ${JSON.stringify(COLS)}`);
  const Film = makeFilm((file.friends && file.friends.people) || []);
  const { cols, ...rest } = file;
  let masks = have === JSON.stringify(COLS);
  const validMask = (n, populated) => n == null ? !populated : Number.isInteger(n) && n >= 0 && n <= 0x7fffffff && (n !== 0) === populated;
  const films = file.films.map((r) => {
    // Zero masks are encoded as null and trailing nulls are omitted. Missing is
    // valid only if the corresponding section of the friends cell is empty.
    // Check while wrapping, without decoding every friend's rating or names.
    if (masks) {
      const f = r[FRIENDS] || "", sep = f.indexOf(";"), end = f.indexOf(";", sep + 1);
      const hasSeen = sep > 0, hasWant = sep >= 0 && (end < 0 ? f.length : end) > sep + 1;
      if (!validMask(r[SEEN_MASK], hasSeen) || !validMask(r[WANT_MASK], hasWant)) masks = false;
    }
    return new Film(r);
  });
  return { ...rest, masks, films };
}
