// node --test            (no dependencies)
// test-support/card-words.js: what the legacy-parity guards let differ between the nine-mood build and the 30-mood build, as a function of the text of line 2 (no build needed).
// Marco, 21/10/2026 ~15:00 UTC (D3, D5) widened it by the best-fit label of a line that is not in a mood row; the review of 21/10/2026 (item (b)) narrowed it to AT MOST ONE group after the genres.

const test = require("node:test");
const assert = require("node:assert/strict");
const { withoutWords, marked, relaxed, staticMoodRow, MOOD_NAMES, SEP } = require("../test-support/card-words");

const G = ["Drama", "Crime", "Thriller", "War"]; // the film's genres: three are on the line
const NAME = [...MOOD_NAMES][0];

test("card-words: the word group is cut — one group after the genres, or none", () => {
  assert.equal(withoutWords("Drama, Crime, Thriller · Neon, Noir.", G), "Drama, Crime, Thriller");
  assert.equal(withoutWords("Drama, Crime, Thriller.", G), "Drama, Crime, Thriller");
  assert.equal(withoutWords(`Mood: ${NAME} · Drama, Crime, Thriller · Neon, Noir.`, G), `Mood: ${NAME} · Drama, Crime, Thriller`, "a mood row keeps its label and its genres");
  assert.equal(withoutWords("Loved by Ana 5★ and Bo 4★ · Drama, Crime, Thriller · Neon.", G), "Loved by Ana 5★ and Bo 4★ · Drama, Crime, Thriller", "a reason keeps its place");
});

// Regression guard of the review of 21/10/2026, item (b): withoutWords() cut EVERY group after the genres, so a planted extra group was forgiven with the words.
test("card-words: TWO groups after the genres are not a word group — the line is compared whole", () => {
  const two = "Drama, Crime, Thriller · Neon, Noir · A planted group.";
  assert.equal(withoutWords(two, G), two);
  const labelled = `Mood: ${NAME} · Drama, Crime, Thriller · Neon · A planted group.`;
  assert.equal(withoutWords(labelled, G), labelled);
  assert.equal(withoutWords(labelled, G, true), labelled, "in a row that forgives the label too");
  assert.equal(withoutWords("Loved by Ana 5★ · Drama, Crime, Thriller · Neon · Two.", G), "Loved by Ana 5★ · Drama, Crime, Thriller · Neon · Two.");
});

test("card-words: the genres must be the film's — other genres, or genres out of place, leave the line whole", () => {
  assert.equal(withoutWords("Planted, Genres · Neon.", G), "Planted, Genres · Neon.");
  assert.equal(withoutWords(`Mood: ${NAME} · Planted, Genres · Neon.`, G), `Mood: ${NAME} · Planted, Genres · Neon.`);
  assert.equal(withoutWords(`Mood: ${NAME} · Planted, Genres · Neon.`, G, true), `Mood: ${NAME} · Planted, Genres · Neon.`);
  assert.equal(withoutWords("Neon · Drama, Crime, Thriller.", G), "Neon · Drama, Crime, Thriller", "a group before the genres is a lead (a reason): it is compared, not cut");
  assert.equal(withoutWords("A · B · Drama, Crime, Thriller.", G), "A · B · Drama, Crime, Thriller.", "two groups before the genres: not the shape, whole");
  assert.equal(withoutWords("", G), "");
  assert.equal(withoutWords(undefined, G), undefined);
});

test("card-words (D3): the best-fit label of a line that is not in a mood row may differ — present, absent, another mood of config.json — and the genre that is its name goes with it (D5)", () => {
  const comedy = [...MOOD_NAMES].find((n) => /Slasher/.test(n)); // the one mood of config.json whose name can be a TMDB genre in this test: "🔪 Slasher", with a film whose first genre is "Slasher"
  assert.ok(comedy, "config.json has the Slasher mood");
  const g = ["Slasher", "Drama", "Romance"];
  const base = withoutWords("Slasher, Drama, Romance · Neon.", g, true);
  assert.equal(withoutWords(`Mood: ${comedy} · Drama, Romance · Neon.`, g, true), base, "label + the genre that is its name left out: the same comparable form as the line with no label");
  assert.equal(withoutWords(`Mood: ${NAME} · Slasher, Drama, Romance.`, g, true), base, "another mood of config.json, no word group");
  assert.equal(withoutWords("Slasher, Drama, Romance.", g, true), base, "no label");
  // the label is still the NAME OF A MOOD, and the genres must be what that name leaves
  assert.equal(withoutWords("Mood: 🌃 Planted · Slasher, Drama, Romance · Neon.", g, true), "Mood: 🌃 Planted · Slasher, Drama, Romance · Neon.", "a label that names no mood: whole");
  assert.equal(withoutWords(`Mood: ${comedy} · Slasher, Drama, Romance · Neon.`, g, true), `Mood: ${comedy} · Slasher, Drama, Romance · Neon.`, "the genre that is the label's name was not left out: whole");
  assert.equal(withoutWords(`Mood: ${NAME} · Planted, Genres · Neon.`, g, true), `Mood: ${NAME} · Planted, Genres · Neon.`, "other genres under a label: whole");
  // in a MOOD ROW the label is the row's own and nothing may differ
  assert.notEqual(withoutWords(`Mood: ${comedy} · Drama, Romance · Neon.`, g, false), withoutWords(`Mood: ${NAME} · Slasher, Drama, Romance · Neon.`, g, false), "two mood rows with other labels are not the same line");
  assert.equal(withoutWords(`Mood: ${comedy} · Drama, Romance · Neon.`, g, false), `Mood: ${comedy} · Drama, Romance`);
  assert.equal(withoutWords("Slasher, Drama, Romance · Neon.", g, false), "Slasher, Drama, Romance", "a line with no label in a mood row is a word-group difference only; the label's absence is caught by the other build's label");
  // a film with no genres: the label alone, or the words alone
  assert.equal(withoutWords(`Mood: ${NAME} · Neon.`, [], true), "");
  assert.equal(withoutWords("Neon.", [], true), "");
  assert.equal(withoutWords(`Mood: ${NAME}.`, [], false), `Mood: ${NAME}`);
});

// Marco, 21/10/2026 ~19:40 UTC (A): the genre that is the label's name goes with it in singular or plural too. test-support/card-words.js writes the rule on its own; without it the legacy-parity guards would call the new line "other genres under a label".
test("card-words (A): the label 'Documentaries' takes the genre 'Documentary' with it, in the line of a film that is not in a mood row", () => {
  const docs = "🎥 Documentaries", g = ["Documentary", "History", "War"];
  const base = withoutWords("Documentary, History, War · Archive.", g, true);
  assert.equal(withoutWords(`Mood: ${docs} · History, War · Archive.`, g, true), base, "label + the singular genre left out: the same comparable form as the line with no label");
  assert.equal(withoutWords(`Mood: ${docs} · Documentary, History, War · Archive.`, g, true), `Mood: ${docs} · Documentary, History, War · Archive.`, "the singular genre kept under the plural label (the rule of before A) is now a line that is whole");
  assert.equal(withoutWords(`Mood: ${docs}.`, ["Documentary"], true), withoutWords("Documentary.", ["Documentary"], true), "a film whose only genre was the label's name: the label alone is the same comparable form as the genre alone");
});

test("card-words: marked() cuts line 2 of a card and nothing else — the credits, a third line and the synopsis are kept, a static card with no line 2 left loses its break", () => {
  const card = (l2) => `Akira Kurosawa · 2h22 · A, B.\n${l2}${SEP}Synopsis.`;
  assert.equal(marked(card("Drama, Crime, Thriller · Neon."), G), card("Drama, Crime, Thriller"));
  assert.equal(marked(`${card("Drama, Crime, Thriller · Neon.").replace(SEP, "\nA third line.")}`, G).includes("A third line."), true);
  assert.equal(marked(`Akira Kurosawa · 2h22 · A, B.\nNeon.${SEP}Synopsis.`, []), `Akira Kurosawa · 2h22 · A, B.${SEP}Synopsis.`, "a film with no genres: its line 2 was the words alone");
  assert.equal(marked(`A; B\nMood: ${NAME} · Drama, Crime, Thriller · Neon.${SEP}Syn.`, G, true, true), `A; B\nDrama, Crime, Thriller${SEP}Syn.`, "the index's `desc`, positional");
  assert.equal(marked(`\n\n\nSyn.`, G, true), `\n\n\nSyn.`, "an empty card");
});

test("card-words: a catalog of a mood row (Tonight, a legacy mood's row, an option of the Moods menu) keeps its label; every other catalog forgives it", () => {
  for (const f of ["catalog/movie/tonight.json", "catalog/movie/lift.json", "catalog/movie/mood-engine/genre=Uplift.json"]) assert.equal(staticMoodRow(f), true, f);
  for (const f of ["catalog/movie/watchlist.json", "catalog/movie/mood-engine-lists/genre=X.json", "catalog/movie/mood-engine-decade/genre=1970s.json", "catalog/movie/directors-loved.json", "data/index.json"]) assert.equal(staticMoodRow(f), false, f);
  const body = (description, genres) => Buffer.from(JSON.stringify({ metas: [{ id: "tt1", name: "X", genres, description }] }));
  const a = body(`C\nMood: ${NAME} · Comedy, Drama · Neon.${SEP}S.`, ["Comedy", "Drama"]), b = body(`C\nComedy, Drama · Noir.${SEP}S.`, ["Comedy", "Drama"]);
  assert.equal(relaxed(a, "catalog/movie/watchlist.json"), relaxed(b, "catalog/movie/watchlist.json"), "a row that is no mood: label and words forgiven");
  assert.notEqual(relaxed(a, "catalog/movie/lift.json"), relaxed(b, "catalog/movie/lift.json"), "a mood row: the label is the row's, and its absence is caught");
});
