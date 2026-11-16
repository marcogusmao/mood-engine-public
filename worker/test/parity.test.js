// The Worker is a separate package (ESM) that must agree with the build (CommonJS) on a few things. These tests read both.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { words } from "../src/text.js";
import { RUNTIME_BUCKETS, RATING_BUCKETS, RUNTIME_LABELS, RATING_LABELS } from "../src/filters.js";
import { ADDON_VERSION } from "../src/manifest.js";
import { DEFAULT_INDEX_URL } from "../src/handler.js";
import { COLS } from "../src/film.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
const require = createRequire(import.meta.url);
const exporter = require(path.join(root, "lib", "index-export.js"));
const pool = require(path.join(root, "lib", "pool.js"));

test("words(): the Worker normalises a query exactly as the build normalised every film's search text (a drift would make titles unfindable with no error)", () => {
  const samples = [
    "Amélie", "Killer's Kiss", "Killer’s Kiss", "8½", "Cinéma Vérité: «Žižek!»", "AT&T", "Rock & Roll", "ÆON FLUX", "Straße", "São Paulo", "Nuit et brouillard (1956)", "  spaced   out  ", "",
    "東京物語", "100% — really?", "Don't Look Now", "L'Avventura", "Fahrenheit 451", "Mulholland Dr.", "Dr. Strangelove or: How I Learned…", "Pokémon", "Ça", "naïve", "Ørnen",
  ];
  for (const s of samples) assert.equal(words(s), exporter.words(s), JSON.stringify(s));
  assert.equal(words(null), exporter.words(null));
  assert.equal(words(undefined), exporter.words(undefined));
});

test("buckets: every minute from 0 to 400 and every hundredth of a star from 0 to 5 lands in the same menu entry as in the static cuts (lib/pool.js)", () => {
  assert.deepEqual(RUNTIME_LABELS, pool.RUNTIME_BUCKETS.map(([l]) => l));
  assert.deepEqual(RATING_LABELS, pool.RATING_BUCKETS.map(([l]) => l));
  const pick = (buckets, v) => buckets.filter(([, f]) => f(v)).map(([l]) => l);
  for (let m = 0; m <= 400; m++) assert.deepEqual(pick(RUNTIME_BUCKETS, m), pick(pool.RUNTIME_BUCKETS, m), `${m} min`);
  for (let i = 0; i <= 500; i++) { const v = i / 100; assert.deepEqual(pick(RATING_BUCKETS, v), pick(pool.RATING_BUCKETS, v), `${v}★`); }
});

test("the Worker's version is the package's version, 3.3.0; wrangler.toml points at the same index as the code's default", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
  assert.equal(ADDON_VERSION, pkg.version);
  assert.equal(ADDON_VERSION, "3.3.0");
  const toml = fs.readFileSync(path.join(here, "..", "wrangler.toml"), "utf8");
  assert.equal(toml.match(/^INDEX_URL = "([^"]+)"/m)[1], DEFAULT_INDEX_URL);
  assert.match(toml, /^main = "src\/index\.js"/m);
});

test("pickWords(): the Worker's pick of the description's words is lib/describe.js's, for every combination of lists and moods (the mood's own word and a word that is a genre of the line skipped, three at most)", async () => {
  const { pickWords } = await import("../src/meta.js");
  const describe = require(path.join(root, "lib", "describe.js"));
  const lists = [[], ["Noir"], ["Noir", "Anxious", "Tense", "Dark"], ["Love stories", "Anxious"], ["Film noir", "Noir", "Neo-noir", "Tense"], ["a", "b", "c", "d", "e"], [null, "", "Anxious"]];
  const moods = ["", undefined, "🌃 Noir", "Tonight · 🌃 Noir", "💘 Love stories", "🌃 Night drive", "noir"];
  let n = 0;
  const genreSets = [[], ["Drama"], ["Noir"], ["Drama", "Romance", "Noir"], ["Drama", "Comedy", "War", "Noir"], [null, "anxious"]]; // review of 21/10/2026: a word that is a genre of the line goes (the fourth genre is not on the line)
  for (const list of lists) for (const mood of moods) for (const genres of genreSets) { assert.deepEqual(pickWords(list, mood, 3, genres), describe.pickWords(list, mood, 3, genres), JSON.stringify({ list, mood, genres })); n++; }
  assert.ok(n >= 240);
});

// Marco, 21/10/2026 ~15:00 UTC (D3, D5): line 2 of a film's general text carries the mood the film fits best, the Moods menu puts its own mood in its place, and the genre that IS the name of the leading mood is left out.
// The static addon writes the line from the plan item (lib/describe.js moodLine); the Worker reads the build's `desc` (liveDescription, four words) and the entry's `genres` column (the first three). They must agree.
test("moodLine() and compose(): line 2 as the Worker serves it (best-fit mood baked into `desc`, the Moods menu's mood in its place) is the static addon's, over every combination of genres, words, best-fit mood and menu", async () => {
  const { compose, genresShown, rewords } = await import("../src/meta.js");
  const describe = require(path.join(root, "lib", "describe.js"));
  const genreSets = [[], ["Drama"], ["Comedy"], ["Comedy", "Drama"], ["Drama", "Comedy", "Romance"], ["Drama", "Comedy", "Romance", "War"], ["Horror", "Comedy"], ["Documentary"], ["Documentary", "History"], ["History", "War", "Documentary", "Drama"]];
  const wordSets = [[], ["comedy"], ["dark comedy", "satire"], ["comedy", "satire", "grief", "loss"], ["romance", "tender", "sad", "lonely"], ["satire", "grief", "loss", "tender", "noir"], ["horror", "gore", "dread", "noir"]];
  const fits = [undefined, "😂 Comedy", "💘 Swoon", "🌃 Night drive", "🎃 Horror", "🎥 Documentaries"];
  const menus = ["", "😂 Comedy", "💘 Swoon", "🌃 Noir", "🎃 Horror", "🎥 Documentaries"];
  let n = 0, genreLeftOut = 0;
  for (const genres of genreSets) for (const list of wordSets) for (const fitMood of fits) for (const menu of menus) {
    const shown = genres.slice(0, 3);
    const keywords = describe.wordsForDesc(list, 4, shown);
    const item = { id: "tt0000001", cast: ["A One", "B Two"], overview: "Syn.", genres, keywords };
    // the build: the film's general text carries the best fit and four words; the entry holds the first three genres
    const desc = describe.liveDescription({ ...item, fitMood }, "\n\n", { words: 4, keepOwnWord: true });
    const live = compose({ tt: item.id, genres: shown }, menu ? { kind: "moods", name: menu } : {}, desc).split("\n\n")[0].split("\n")[1] || "";
    // the static addon: a Moods catalog item carries the menu's mood; every other catalog's item carries the best fit
    const stat = describe.moodLine(menu ? { ...item, mood: menu, moodIsRow: false } : { ...item, fitMood });
    assert.equal(live, stat, JSON.stringify({ genres, list, fitMood, menu }));
    // a Board row's finished line goes through the Worker unchanged
    const rowMood = menu || fitMood;
    if (rowMood) {
      const row = describe.moodLine({ ...item, keywords: describe.wordsForDesc(list, 4, shown), mood: rowMood });
      assert.equal(rewords(row, { genres: shown }, ""), row, `a finished row line is left as it is: ${row}`);
    }
    if (menu && shown.length && genresShown(shown, menu).length < shown.length) genreLeftOut++;
    n++;
  }
  assert.ok(n >= 1000 && genreLeftOut > 20, `${n} combinations, ${genreLeftOut} with a genre left out`);
  assert.deepEqual(genresShown(["Comedy", "Drama", "Romance", "War"], "😂 Comedy"), ["Drama", "Romance"], "the first three, then the mood's name out: no fourth genre comes in");
  assert.deepEqual(genresShown(["Comedy", "Drama"], "Tonight · 😂 Comedy"), ["Drama"], "Tonight's own prefix is not part of the name");
  assert.deepEqual(genresShown(["Comedy", "Drama"], ""), ["Comedy", "Drama"]);
  // Marco, 21/10/2026 ~19:40 UTC (A): singular and plural are one genre, on both sides
  assert.deepEqual(genresShown(["Documentary", "History"], "🎥 Documentaries"), ["History"], "the Worker: Documentaries is Documentary");
  assert.deepEqual(describe.genresShown(["Documentary", "History"], "🎥 Documentaries"), ["History"], "the build: the same");
  for (const genres of genreSets) for (const mood of ["", "😂 Comedy", "🎃 Horror", "Tonight · 💘 Swoon", "🎥 Documentaries", "Tonight · 🎥 Documentaries", undefined]) assert.deepEqual(genresShown(genres, mood), describe.genresShown(genres, mood), JSON.stringify({ genres, mood }));
});

// The two functions of the rule A (lib/describe.js sameName, worker/src/meta.js sameName) over every name config.json gives a mood or a Board row, the names the profiles give the moods, endings made up on purpose
// (plurals of every kind, 'ss', a name that only starts alike) and every genre of TMDB: they must say the same for each pair, and the pairs they say yes to are the ones the build removes.
test("sameName(): the build's and the Worker's say the same over every mood and Board name against every TMDB genre, and over made-up plural endings", async () => {
  const { sameName } = await import("../src/meta.js");
  const describe = require(path.join(root, "lib", "describe.js"));
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  const GENRES = ["Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary", "Drama", "Family", "Fantasy", "History", "Horror", "Music", "Mystery", "Romance", "Science Fiction", "TV Movie", "Thriller", "War", "Western"];
  const made = ["Documentaries", "Comedies", "Westerns", "Dramas", "Wars", "Horrors", "Mysteries", "Histories", "Movies", "TV Movies", "Families", "Science Fictions", "Chess", "Class", "Classes", "Horses", "Warm and gentle", "Horror-comedy", "Night, crime and mystery", "", "🎥", "Tonight · Comedy"];
  const names = [...cfg.moods.map((m) => m.name), ...Object.values(cfg.board.names), ...made];
  let yes = 0;
  for (const a of names) for (const b of [...GENRES, ...names.slice(0, 8)]) { const w = sameName(a, b); assert.equal(w, describe.sameName(a, b), JSON.stringify({ a, b })); if (w) yes++; }
  assert.ok(yes >= 20, `${yes} pairs said yes: the endings are exercised`);
  for (const [plural, one] of [["Documentaries", "Documentary"], ["Comedies", "Comedy"], ["Westerns", "Western"], ["Dramas", "Drama"], ["Wars", "War"], ["Horrors", "Horror"], ["Mysteries", "Mystery"], ["Histories", "History"], ["Families", "Family"], ["Science Fictions", "Science Fiction"], ["TV Movies", "TV Movie"], ["Classes", "Class"], ["Horses", "Horse"]]) { assert.equal(sameName(plural, one), true, `${plural} / ${one}`); assert.equal(describe.sameName(plural, one), true, `the build: ${plural} / ${one}`); }
  assert.equal(sameName("Documentaries", "Documentary"), true);
  assert.equal(sameName("Chess", "Ches"), false);
  assert.equal(sameName("Warm and gentle", "War"), false);
});

test("the index schema and the columns the build writes are the ones the Worker reads", () => {
  const store = fs.readFileSync(path.join(here, "..", "src", "store.js"), "utf8");
  assert.equal(Number(store.match(/export const SCHEMA = (\d+)/)[1]), exporter.SCHEMA);
  assert.deepEqual(COLS, require(path.join(root, "lib", "index-rows.js")).COLS);
  assert.equal(require(path.join(root, "lib", "index-rows.js")).FORMAT, "rows");
});

test("creditsLine(): the Worker's credits line (built from the columns and the actors of `desc`) is lib/describe.js's, over every combination of long and short names, actors and durations, with and without each field", async () => {
  const { creditsLine } = await import("../src/meta.js");
  const describe = require(path.join(root, "lib", "describe.js"));
  const directors = [null, "Federico Fellini", "Apichatpong Weerasethakul", "Brian De Palma", "Joel Coen, Ethan Coen", "Apichatpong Weerasethakul, Alejandro González Iñárritu", "Pablo Rodríguez-Hernández de la Torre y Montalbán", "A, B, C"];
  const casts = [[], ["Toshirō Mifune"], ["Toshirō Mifune", "Tatsuya Nakadai"], ["Toshirō Mifune", "Tatsuya Nakadai", "Kyōko Kagawa"], ["Toshirō Mifune", "Tatsuya Nakadai", "Kyōko Kagawa", "Tsutomu Yamazaki"], ["Thanapat Saisaymar", "Jenjira Pongpas", "Sakda Kaewbuadee"], ["Hanna Schygulla Eleonore", "Irm Hermann Maria Louise", "Margit Carstensen Leopoldine"], ["Elisha Cook Jr."], ["Henry Louis Gates, Jr.", "Tyler, The Creator", "Diana, Princess of Wales"]];
  let n = 0, cut = 0;
  for (const director of directors) for (const cast of casts) for (const runtime of [undefined, 52, 107, 120, 187]) {
    const want = describe.creditsLine({ directors: director ? director.split(", ") : [], runtime, cast });
    // the Worker splits `desc` line 1 on CAST_SEP (the build joins the first three names with it)
    const got = creditsLine({ directors: director ? director.split(", ") : [], runtime, cast: describe.castLine(cast).split(describe.CAST_SEP) });
    assert.equal(got, want, JSON.stringify({ director, cast, runtime }));
    assert.equal(creditsLine({ directors: director ? director.split(", ") : [], runtime, cast }), want, "given the whole cast, the Worker shows three at most, as the build does: " + JSON.stringify({ director, cast, runtime }));
    if (cast.length >= 3 && !want.includes(cast[2])) cut++; // the third actor did not show
    if (cast.length >= 2) assert.ok(want.includes(cast[1]), `the second actor always shows (D4, 21/10/2026): ${JSON.stringify({ director, cast, runtime })}`);
    n++;
  }
  assert.ok(n >= 300 && cut > 10, `${n} combinations, ${cut} of them cut`);
});

// Regression, 22/10/2026: East of Eden (2026, tt21097264) is in the New releases row with no TMDB record, so no credits, no genres and no synopsis: the static addon writes `description: ""` (lib/describe.js describe() of a bare item)
// and the Worker, which wrote `description || undefined`, left the key out (`undefined !== ""` in test/real-index.test.js, "reads the same in both addons"). It was the only empty card of the 1,331 on the 20 published rows; PR #66 (rule D of the
// New releases) brought the film into the row and PR #67 (card v3) made the comparison strict, and the two were never run together. The contract is "the same string in both addons", "" included.
test("toMeta(): a film with no credits, no genres and no synopsis (East of Eden 2026, no TMDB record) has description \"\" in the Worker as in the static addon, key present on the wire; a film with a card and a synopsis stays equal", async () => {
  const { toMeta } = await import("../src/meta.js");
  const publish = require(path.join(root, "lib", "publish.js"));
  const describe = require(path.join(root, "lib", "describe.js"));
  const sep = "\n\n";
  const wire = (m) => JSON.parse(JSON.stringify(m)); // what Stremio receives: an `undefined` value is no key
  // the film as the static plan holds it (a plan item) and as the index holds it (an entry whose `desc` is liveDescription(), the card WITHOUT its first line)
  const bare = { id: "tt21097264", title: "East of Eden", year: 2026, ratings: {}, genres: [], cast: [], directors: [], keywords: [], overview: "" };
  const live = (item, words) => describe.liveDescription(item, sep, words ? { words, keepOwnWord: true } : undefined);
  const staticBare = publish.toMeta(bare, { separator: sep });
  assert.equal(staticBare.description, "", "the static addon writes an empty string for a film with nothing to say");
  const workerBare = toMeta({ tt: bare.id, name: bare.title, year: 2026, desc: live(bare, describe.WORDS_KEPT) }, { separator: sep });
  assert.equal(workerBare.description, staticBare.description);
  assert.equal(wire(workerBare).description, "", "the key is on the wire, as in the static file");
  // the same film with no `desc` column at all (the entry of a film the build had nothing for: compact() drops an empty string)
  const noDesc = toMeta({ tt: bare.id, name: bare.title, year: 2026 }, { separator: sep });
  assert.equal(noDesc.description, "");
  assert.equal(wire(noDesc).description, "");
  // a synopsis and nothing else (no director, no runtime, no cast, no genres, no words): the card is empty and the synopsis stands alone, in both
  const lone = { ...bare, id: "tt0000001", title: "Lone synopsis", overview: "A man waits for a train." };
  assert.equal(toMeta({ tt: lone.id, name: lone.title, year: 2026, desc: live(lone, describe.WORDS_KEPT) }, { separator: sep }).description, publish.toMeta(lone, { separator: sep }).description);
  assert.equal(publish.toMeta(lone, { separator: sep }).description, "A man waits for a train.");
  // a normal film: the credits from the columns, line 2 and the synopsis are the same in both addons
  const full = { id: "tt0000002", title: "Rashomon", year: 1950, runtime: 88, ratings: {}, directors: ["Akira Kurosawa"], cast: ["Toshirō Mifune", "Machiko Kyō", "Masayuki Mori"], genres: ["Crime", "Drama", "Mystery"], keywords: ["Samurai", "Trial"], overview: "A crime told four ways." };
  const wf = toMeta({ tt: full.id, name: full.title, year: 1950, runtime: 88, director: "Akira Kurosawa", genres: full.genres, desc: live(full, describe.WORDS_KEPT) }, { separator: sep });
  assert.equal(wf.description, publish.toMeta(full, { separator: sep }).description);
  assert.match(wf.description, /^Akira Kurosawa · 1h28 · Toshirō Mifune, Machiko Kyō, Masayuki Mori\.\nCrime, Drama, Mystery · Samurai, Trial\.\n\nA crime told four ways\.$/);
});
