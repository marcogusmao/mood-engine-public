// The mood each film fits best (Marco, 21/10/2026, ~15:00 UTC, questionnaire, D3): in the rows that are no mood and have no reason (32 of the 54 rows of the Board by the questionnaire's count; 25 rows with film places on the build of 21/10/2026, 2,083 places, 1,819 of them with a best fit; and the static catalogs of the same kind: the lists, the decades,
// the countries, the runtimes, the ratings, the friends' options) line 2 of the description opens with "Mood: <the mood the film fits best>", then the genres and the mood words (lib/describe.js moodLine).
//
// "Fits best" is the highest `fitInfo.norm` of lib/moods.js fit(): the score of the film in the mood divided by what the mood asks for (minFit x 1.75), so the numbers of different moods are comparable. A tie goes to the mood that comes
// first in config.json (the order of `moods`). Only a mood the film FITS (ok: it is in the mood's ranked list) counts, and only when the person's private feedback allows it (`permits(tt, moodId)`: "wrong mood" for that mood takes it out).
//
// ONE calculation for both addon families, over every mood of config.json (30 today), the way the description's mood words are (Marco, 21/10/2026 01:35 UTC): the static files, the legacy index and the v2 index say the same mood,
// where the `moods` column of each index holds the family's own moods (nine in the legacy one) and would give two answers. What differs between the families is only the NAME written, and only by one rule.
//
// THE NAME (Marco, 21/10/2026 ~22:15 UTC, questionnaire, replacing the ~19:40 UTC decision B): the name of the mood's ROW in the Board the family has, when the Board has a row with the mood's id (v2: config.json `board.names`, 15 of the
// 30 moods today; the legacy Board names its nine mood rows by the mood's `name`), else the mood's `name` in config.json `moods` ("🌃 Night drive"). `rowNames` carries the Board's names: { mood id -> row name }; build.js hands it to the v2 family
// and nothing to the legacy one. The reason: the label of a film in a row that is no mood must read like the row of the same mood that the person sees on the Board, and five rows have a Board name of their own (escape "🎳 Fun and adventure",
// letin "🌧️ Sad and beautiful", wicked "🎃 Horror", slow "🕯️ Slow and quiet", adrenaline "🔥 Action and thrills") while config.json `moods` says "🎳 Full escape", "🌧️ Let it in", "🎃 Something wicked", "🕯️ Slow and still", "🔥 Adrenaline".
//
// How it came to be, in order (all 21/10/2026): until ~19:40 UTC the label wrote the mood's `name` always, so on the same Board a film read "Mood: 🕯️ Slow and still" in a row that is no mood and "Mood: 🕯️ Slow and quiet" in the Slow row. Measured on
// the offline build of that day (the caches of that night; their sha256 is in BACKLOG.md, entry "ROUND 3"): 253 places in rows with no mood and no reason carried one of the five names, 159 distinct films; 97 of them were also in one of the five
// mood rows and 91 in the row of the SAME mood, which is the count of films that read two names for one mood (the "97" had been called the pairs; it counts "in any of the five rows", corrected in the re-verification, M-b). At ~19:40 UTC Marco chose
// to rename the five Board rows to the mood's name, on the premise that the Moods menu shows the mood's name and that Board = Moods menu would then be one name. The premise was wrong: the Moods menu in Stremio shows the mood's short WORD
// (Escape, Catharsis, Wicked, Slow, Adrenaline: config.json `moods[].word`), not any name. At ~22:15 UTC Marco reverted the rename (the five Board names are the old ones again) and asked for the rule above, which is the option the session had
// recommended at 19:40: the label takes the Board's name. After it, films that read two names for one mood: 91 -> 0 (test/board-production.test.js holds the five names, test/best-mood.test.js the rule, worker/test/real-index.test.js the build).
// A film that fits no mood (a film Marco has seen, one outside the candidates, one under every minFit) is not in the map: its line 2 starts with the genres.

/**
 * moods    the compiled moods in config order: [{ id, name }]
 * ranked  { mood id -> [{ film: { imdb }, fitInfo: { norm } }] } (lib/rows.js buildRows() and lib/board-rows.js: the legacy moods' lists and the v2 moods')
 * permits (tt, moodId) -> false when the private feedback says this film does not fit this mood
 * rowNames { mood id -> the name of the mood's row in the Board }: the name written for a mood that has a row (see the top); a mood without one is written by its `name`. Empty: every mood by its `name` (the legacy family, whose Board rows are named so)
 * → Map tt -> the name of the mood with the highest norm
 */
function bestMoods({ moods = [], ranked = {}, permits = () => true, rowNames = {} } = {}) {
  const best = new Map(); // tt -> { norm, name }
  for (const m of moods) {
    for (const c of ranked[m.id] || []) {
      const tt = c && c.film && c.film.imdb;
      const norm = c && c.fitInfo && c.fitInfo.norm;
      if (!tt || !(norm > 0) || !permits(tt, m.id)) continue;
      const have = best.get(tt);
      if (!have || norm > have.norm) best.set(tt, { norm, name: Object.hasOwn(rowNames, m.id) && rowNames[m.id] ? rowNames[m.id] : m.name }); // strictly greater: a tie keeps the mood that came first
    }
  }
  return new Map([...best].map(([tt, v]) => [tt, v.name]));
}

module.exports = { bestMoods };
