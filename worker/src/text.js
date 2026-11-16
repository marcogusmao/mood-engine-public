// Text helpers shared by the extras parser, the filters and the search.

/**
 * The one normaliser for search text: accents off, lower case, apostrophes dropped ("Killer's" and "killers" are one word),
 * "&" as "and", anything that is not a letter or a digit becomes a space. lib/index-export.js has the same function and writes every film's `find` text with it; test/worker.test.js
 * compares the two on a set of awkward strings, because a drift would make a title unfindable without any error.
 */
export const words = (s) =>
  String(s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['\u2019\u2018`\u00b4]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Plain code-unit order, for sorting. Not localeCompare: its first call starts the Intl collator, which costs a cold isolate ~10 ms of the 10 it is given. */
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const round2 = (n) => Math.round(n * 100) / 100;

/** "4.5★", "4★". */
export const stars = (r) => `${Number.isInteger(r) ? r : r.toFixed(1)}★`;

// The Lists chips and the search by a list's short name (Marco, 28/10/2026 ~22:25 UTC, questionnaire, the recommended option): when a list's `short` is the
// name or the word of a mood ("Catharsis", the word of the mood "Let it in"), or a genre, the search for it stays the mood's (the genre's), as it was before the short names;
// the chip still SAYS the short name but searches the FULL name of the list ("Catharsis (latifah)"). Today that is one list (sPMW × the mood letin).
const GENRE_KEYS = new Set(["action", "adventure", "animation", "comedy", "crime", "documentary", "drama", "family", "fantasy", "history", "horror", "music", "mystery", "romance", "science fiction", "sci fi", "tv movie", "thriller", "war", "western"]);
/** The words() of every name a mood is searched by (label, name, alias) in each of the given lists of moods, plus the genres: a short name in this set is not a list's. */
export function takenWords(...moodLists) {
  const keys = new Set(GENRE_KEYS);
  for (const moods of moodLists) for (const m of Array.isArray(moods) ? moods : []) for (const f of m ? [m.label, m.name, m.alias] : []) if (typeof f === "string") { const k = words(f); if (k) keys.add(k); }
  return keys;
}
/** The words() of a list's short name, "" when it has none (not a string, empty, or nothing but punctuation: then the label is the name). */
export const shortKey = (l) => (l && typeof l.short === "string" ? words(l.short) : "");
/** What a Lists chip says and what it searches for: { text, term }. `taken` is takenWords(index.moods, index.moodMenu). */
export function listChip(l, taken) {
  const k = shortKey(l);
  return k ? { text: l.short, term: taken.has(k) ? l.label : l.short } : { text: l.label, term: l.label };
}
