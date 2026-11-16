// node --test            (no dependencies)
// The index the live Worker reads (lib/index-export.js) and verify.js's check of it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { spawnSync } = require("child_process");

const P = require("../lib/pool");
const { buildIndex, boardIndex, pieces, writeIndex, allowlist, words, ENTRY_KEYS, WORKER_EXEMPT, languagesFile, LANGUAGES_FILE, assertShortsMarked } = require("../lib/index-export");
const { buildPlan } = require("../lib/plan");
const { encode, decode, COLS, encodeFilm } = require("../lib/index-rows");
const Q = require("../lib/recommendation-quality");
const { compile } = require("../lib/moods");
const { verifyIndex, MAX_INDEX_GZIP, MAX_LANGUAGES_BYTES } = require("../verify");

const ROOT = path.join(__dirname, "..");
const tmp = (p = "mood-ix-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const film = (tt, title, year, o = {}) => ({ title, year, tmdbId: null, imdbId: tt, t: 1, v: 2, ...o });

// ── a small world: three lists, two friends, one film you have seen ──────────────────────────────

const CFG = {
  addon: { version: "2.0.0" }, shortRow: { maxMinutes: 95, minMinutes: 40 }, cuts: { countries: 2 }, friendRows: { love: { minStars: 4 } },
  moods: [{ id: "night", word: "Nocturnal", name: "Night drive", genres: {}, keywords: { neon: 1, noir: 0.8, "film noir": 0.9, rape: -3 } }],
};
const TMDB = {
  35: { id: 35, imdb: "tt0000008", title: "No Votes", year: 2005, runtime: 90, countries: ["US"], va: 9, vc: 0, genres: [], keywords: [], directors: [], overview: "" },
  33: { id: 33, imdb: "tt0000001", title: "Alpha", year: 1999, runtime: 88, countries: ["US"], lang: "en", va: 7.8, vc: 3000, genres: ["Drama", "Crime", "Thriller", "Comedy"], keywords: ["neon", "film noir", "rape", "tuwaderalit"], directors: [{ id: 1, name: "Ana Dir" }, { id: 2, name: "Bo Dir" }, { id: 3, name: "Cy Dir" }], overview: "A long night in the city." },
};
const FILMS = {
  a: film("tt0000001", "Alpha", 1999, { tmdbId: 33, r: 4.3, rn: 900, rt: 88, c: ["USA"] }),
  b: film("tt0000002", "Beta", 1960, { r: 3.9, rt: 100, c: ["Japan", "Spain", "France", "Italy"] }), // four countries; the menu (the two most frequent in the pool) is United States and France
  seenlist: film("tt0000003", "Already Seen", 1995, { r: 4.0, rt: 120, c: ["USA"] }),
  loved: film("tt0000004", "Loved By Ana", 2010, { r: 3.5, rt: 95, c: ["UK"] }), // not in the pool; a friend rated it 4.5
  nothing: film("tt0000005", "Nothing Known", 2001, {}),
  novotes: film("tt0000008", "No Votes", 2005, { tmdbId: 35, r: 3.9, rt: 90, c: ["USA"] }), // TMDB has a vote average for it and no votes: not a rating
  lowfriend: film("tt0000006", "Meh By Ana", 2012, { r: 3.0, rt: 90, c: ["UK"] }), // a friend rated it 2: not loved, not added
  oldfriend: film("tt0000007", "An Old Friend", 1980, { r: 4.5, rt: 101, c: ["USA"] }), // only in the Old friends row
};
const VIEW = {
  films: FILMS,
  users: [
    { user: "ana", name: "Ana", films: new Map([["loved", { slug: "loved", rating: 4.5 }], ["lowfriend", { slug: "lowfriend", rating: 2 }], ["a", { slug: "a", rating: null }], ["seenlist", { slug: "seenlist", rating: 5 }]]), watchlist: new Map([["b", { slug: "b" }]]) },
    { user: "bo", name: "Bo", films: new Map([["a", { slug: "a", rating: 4 }]]), watchlist: new Map() },
  ],
};
const LISTS = [
  { id: "L1", name: "First (curator)", popular: false, items: [{ slug: "seenlist" }, { slug: "not-looked-up" }, { slug: "a" }, { slug: "b" }] },
  { id: "L2", name: "Second", popular: false, items: [{ slug: "a" }] },
];
const isSeen = (r) => r.slug === "seenlist";
const detail = (r) => (r.tmdbId ? TMDB[r.tmdbId] || null : null);

function world(o = {}) {
  const entries = [
    { slug: "a", tag: { type: "watchlist" } }, { slug: "a", tag: { type: "list", id: "L1", name: "First (curator)", pos: 3 } }, { slug: "a", tag: { type: "list", id: "L2", name: "Second", pos: 1 } },
    { slug: "b", tag: { type: "list", id: "L1", name: "First (curator)", pos: 4 } }, { slug: "b", tag: { type: "fwatch", name: "Ana" } },
    { slug: "nothing", tag: { type: "watchlist" } }, { slug: "novotes", tag: { type: "watchlist" } },
  ];
  const { pool } = P.buildPool({ entries, view: VIEW, isSeen, detail });
  const recs = P.rankPool(pool, { stats: new Map() });
  const shared = { lb: 4.3, imdb: 7.3, friendsAvg: 4.25, seenBy: 3, wantBy: 5 }; // the object the plan's items of tt0000001 share (lib/crowd.js attachRatings)
  const item = (tt, title, o2 = {}) => ({ id: tt, tmdb: null, slug: null, title, year: 2000, why: ["row text"], overview: "", genres: [], directors: [], ...o2 });
  const plan = buildPlan({
    moods: [{ id: "night", name: "Night drive", word: "Nocturnal" }], rows: { tonight: [item("tt0000001", "Alpha", { ratings: shared, poster: "https://example.test/posters/tt0000001.jpg" }), item("tt0000009", "Only On The Board", { runtime: 77, genres: ["Drama"], directors: ["Dee Rector"], year: 2003, poster: "/tmdbpath.jpg", mood: "Tonight · Night drive", overview: "A synopsis. Two sentences." })], night: [], because: [], directors: [], watchlist: [], oldfriends: [item("tt0000007", "An Old Friend", { year: 1980, runtime: 101 })] },
    extra: { fromlists: [], short: [], newforyou: [], "friends-week": [] }, sizes: { row: 30, friends: 30, discover: 60 }, withFriends: false,
  });
  const cand = { film: { ...TMDB[33], imdb: "tt0000001", keywords: TMDB[33].keywords }, tasteZ: 1, qualityZ: 0.5, watchlist: true };
  const friendsFull = { meta: [{ id: "friends-top-ana", word: "Top · Ana", kind: "top" }, { id: "friends-love", word: "Loved", kind: "love" }], rows: { "friends-top-ana": [item("tt0000004", "Loved By Ana")], "friends-love": [item("tt0000004", "Loved By Ana")] } };
  return {
    cfg: CFG, today: "2026-10-10", builtAt: "2026-10-10T12:00:00.000Z", plan, moods: compile(CFG.moods), ranked: { night: [{ film: cand.film, fitInfo: { norm: 0.8123 }, rank: 2.345 }] }, cands: [cand], recs,
    view: VIEW, lists: LISTS, friendsFull, isSeen, detail, seenTts: new Set(),
    crowd: (it) => (it.id === "tt0000002" ? { seenBy: 7, friendsAvg: null, wantBy: 0 } : { seenBy: 0, friendsAvg: null, wantBy: 2 }), imdb: new Map([["tt0000001", 7.3], ["tt0000002", 6.1]]), numbers: new Map(),
    quality: { eligible: (tt) => tt !== "tt0000005", minStars: 3.5 }, // Nothing Known has no Letterboxd average and no friend's rating
    separator: "\n\n", ...o,
  };
}

test("index: one entry per film, from the pool, the candidates, the plan, the lists (seen ones too) and the films a friend loved; each fact from where the static cuts read it", () => {
  const ix = buildIndex(world());
  const by = Object.fromEntries(ix.films.map((f) => [f.tt, f]));
  assert.deepEqual(Object.keys(by).sort(), ["tt0000001", "tt0000002", "tt0000003", "tt0000004", "tt0000005", "tt0000007", "tt0000008", "tt0000009"]);
  const a = by.tt0000001;
  assert.equal(a.name, "Alpha");
  assert.equal(a.year, 1999);
  assert.equal(a.decade, "1990s");
  assert.equal(a.runtime, 88);
  assert.deepEqual(a.countries, ["United States"]);
  assert.equal(a.language, "en");
  assert.equal(a.lbRating, 4.3);
  assert.equal(a.tmdbRating, 7.8);
  assert.equal(a.tmdbVotes, 3000);
  assert.equal(a.watchlist, true);
  assert.equal(a.director, "Ana Dir, Bo Dir", "two directors at most");
  assert.deepEqual(a.genres, ["Drama", "Crime", "Thriller"], "three genres at most");
  assert.deepEqual(a.lists, { L1: 3, L2: 1 }, "the curator's position, counting films the build could not use (#3 is the third line of the list)");
  assert.deepEqual(a.moods, { night: [0.81, 2.35] });
  assert.equal(typeof a.taste, "number");
  assert.equal(typeof a.rank, "number");
  assert.equal(a.desc, "\nDrama, Crime, Thriller · Neon, Film noir.\n\nA long night in the city.", "the generic text of a pool film: \"<actors>\\n<genres · mood words>.\" (no cast in this world: the first line is empty), the separator, the synopsis; no credits line (the live addon builds it from the columns), no reasons, no numbers line, not the text of one row. TMDB\'s raw keywords of Alpha (\"rape\", \"tuwaderalit\") are not in it: only the moods\' words");
  assert.deepEqual([a.imdbRating, a.seenBy, a.wantBy, a.friendsAvg], [7.3, 3, 5, 4.3], "the numbers the plan's items of that film share (the average shown with one decimal)");
  assert.equal(a.poster, "https://example.test/posters/tt0000001.jpg", "the cover with the ratings drawn on it");
  assert.deepEqual([by.tt0000002.imdbRating, by.tt0000002.seenBy, by.tt0000002.wantBy, by.tt0000002.friendsAvg], [6.1, 7, undefined, undefined], "a film of the pool that no file shows: the crowd is asked now, the IMDb rating comes from the dataset");
  assert.equal(by.tt0000009.poster, undefined, "a TMDB poster path is not a cover");
  assert.equal(by.tt0000009.seenBy, undefined);
  assert.equal(by.tt0000009.wantBy, 2);
  assert.equal(a.seen, undefined);
  // Beta: four countries; the menu is United States and France (cuts.countries: 2 → the two most frequent in the pool)
  assert.deepEqual(by.tt0000002.countries, ["Japan", "Spain", "France"], "the first two, plus France because it is a menu entry; Italy is neither");
  assert.equal(by.tt0000008.tmdbRating, undefined, "a TMDB average with no votes behind it is not kept");
  assert.equal(by.tt0000008.tmdbVotes, undefined);
  assert.equal(by.tt0000001.tmdbRating, 7.8);
  assert.deepEqual(by.tt0000002.friends, { seenBy: [], wantBy: ["Ana"] }, "a friend's watchlist");
});

// Regression guard of Marco's decision of 20/10/2026 (description v3): the third group of line 2 is the film's MOOD WORDS, never TMDB's raw keywords ("rape, christianity, monk" showed for Andrei Rublev).
test("index: the keywords in a description are the film's mood words (the words of the moods, cleaned of a word inside another, four kept in the live `desc`); TMDB's raw keywords never appear, and a film with no mood word has genres only", () => {
  const raw = ["rape", "tuwaderalit", "christianity", "monk"];
  const original = TMDB[33].keywords;
  const plant = (keywords) => { TMDB[33].keywords = keywords; }; // the candidate's film (world()) and the detail share this record
  try {
  // 1. a TMDB record with raw keywords and none of the moods' words: NONE of them appears, in the film's text or in its row's text
  plant(raw);
  const none = buildIndex(world());
  const a0 = none.films.find((f) => f.tt === "tt0000001");
  assert.equal(a0.keywords, undefined);
  assert.equal(a0.desc, "\nDrama, Crime, Thriller.\n\nA long night in the city.", "genres only: no third group");
  for (const t of [a0.desc, ...none.rowDesc.tonight]) for (const w of raw) assert.ok(!t.includes(w), `${w} in ${JSON.stringify(t)}`);
  // 2. raw keywords mixed with the moods' words: only the moods' words, heaviest first, three at most (the column keeps up to eight)
  plant(["rape", "noir", "monk", "neon", "film noir"]);
  const mixed = buildIndex(world());
  const a1 = mixed.films.find((f) => f.tt === "tt0000001");
  assert.deepEqual(a1.keywords, ["neon", "film noir", "noir"]);
  assert.equal(a1.desc, "\nDrama, Crime, Thriller · Neon, Film noir.\n\nA long night in the city.", "'noir' is inside 'film noir': the more specific word stays (Marco's review, 20/10/2026)");
  assert.equal(mixed.rowDesc.tonight[0], "\nNeon, Film noir.", "the Board row's text has the same words");
  assert.ok(![a1.desc, ...mixed.rowDesc.tonight].some((t) => /rape|monk/.test(t)));
  // 3. four of the moods' words match: the column keeps all four (search reads them), the description drops the word inside another
  plant(["neon", "film noir", "rape", "tuwaderalit", "zzz", "yyy"]);
  const cfg4 = { ...CFG, moods: [{ ...CFG.moods[0], keywords: { ...CFG.moods[0].keywords, tuwaderalit: 0.5, zzz: 0.4, yyy: 0.3 } }] };
  const wide = buildIndex(world({ cfg: cfg4, moods: compile(cfg4.moods) }));
  const a2 = wide.films.find((f) => f.tt === "tt0000001");
  assert.deepEqual(a2.keywords, ["neon", "film noir", "noir", "tuwaderalit", "zzz", "yyy"]);
  assert.equal(a2.desc, "\nDrama, Crime, Thriller · Neon, Film noir, Tuwaderalit, Zzz.\n\nA long night in the city.", "noir is inside film noir and goes; FOUR words are kept in the live desc (the Moods menu of the Worker may drop one), the fifth is not");
  } finally { TMDB[33].keywords = original; }
});

// Regression guard of the review of the description v3, 21/10/2026: a mood word that is also one of the film's genres ("romance") is not a word of line 2, and the spare fourth word of the live `desc` takes its place.
test("index: a mood word that repeats one of the genres of the line is left out of the film's text and of its row's text, and the fourth word of the live desc is still kept", () => {
  const original = TMDB[33].keywords;
  try {
    TMDB[33].keywords = ["neon", "film noir", "crime", "tuwaderalit", "zzz", "yyy"]; // "Crime" is the second genre of the film (Drama, Crime, Thriller)
    const cfgC = { ...CFG, moods: [{ ...CFG.moods[0], keywords: { ...CFG.moods[0].keywords, crime: 0.9, tuwaderalit: 0.5, zzz: 0.4, yyy: 0.3 } }] };
    const ix = buildIndex(world({ cfg: cfgC, moods: compile(cfgC.moods) }));
    const a = ix.films.find((f) => f.tt === "tt0000001");
    assert.ok(a.keywords.includes("crime"), "the keywords column (the search) keeps it");
    assert.equal(a.desc, "\nDrama, Crime, Thriller · Neon, Film noir, Tuwaderalit, Zzz.\n\nA long night in the city.", "no 'Crime' among the words, and FOUR words kept: the genre's word went before the cut");
    assert.ok(![...ix.descWords.get("tt0000001")].includes("crime"));
    assert.equal(ix.rowDesc.tonight[0], "\nNeon, Film noir, Tuwaderalit.", "the Board row's text has the same words, no Crime among them");
  } finally { TMDB[33].keywords = original; }
});

// Marco, 21/10/2026 ~15:00 UTC (D3, D5): the film's general text opens line 2 with the mood the film fits best (build.js hands both families the same map, lib/best-mood.js); a Board row that is no mood does the same;
// the genre that IS the name of the leading mood is left out of the line; the word that is its name stays in the live `desc` (the Moods menu of the Worker may put another mood in its place).
test("index: the film's general text and the text of a Board row that is no mood open line 2 with the mood the film fits best; the genre and (in the live desc) not the word of that mood's name", () => {
  const original = TMDB[33].keywords;
  try {
    TMDB[33].keywords = ["neon", "film noir", "crime", "tuwaderalit"];
    const cfgD = { ...CFG, moods: [{ ...CFG.moods[0], keywords: { ...CFG.moods[0].keywords, crime: 0.9, tuwaderalit: 0.5 } }] };
    const without = buildIndex(world({ cfg: cfgD, moods: compile(cfgD.moods) }));
    assert.equal(without.films.find((f) => f.tt === "tt0000001").desc, "\nDrama, Crime, Thriller · Neon, Film noir, Tuwaderalit.\n\nA long night in the city.", "no map: the line starts with the genres, as before");
    const best = new Map([["tt0000001", "🔪 Crime"], ["tt0000002", "🌃 Night drive"]]);
    const ix = buildIndex(world({ cfg: cfgD, moods: compile(cfgD.moods), bestMood: best }));
    const a = ix.films.find((f) => f.tt === "tt0000001"), b = ix.films.find((f) => f.tt === "tt0000002");
    assert.equal(a.desc, "\nMood: 🔪 Crime · Drama, Thriller · Neon, Film noir, Tuwaderalit.\n\nA long night in the city.", "the best fit leads and the genre Crime is out (D5)");
    assert.deepEqual(a.genres, ["Drama", "Crime", "Thriller"], "the genres column is untouched");
    assert.equal(ix.rowDesc.tonight[0], "\nMood: 🔪 Crime · Neon, Film noir, Tuwaderalit.", "the Tonight row of this fixture is no mood: its item takes the best fit too (the fixture's item has no genres)");
    assert.ok(b.desc.split("\n")[1] === "" || b.desc.split("\n")[1].startsWith("Mood: 🌃 Night drive"), `${JSON.stringify(b.desc)}`);
    // the word that is the leading mood's name: kept in the live desc (the Moods menu may put another mood in its place), dropped from the Board row's text (the static addon's rule)
    const neon = buildIndex(world({ cfg: cfgD, moods: compile(cfgD.moods), bestMood: new Map([["tt0000001", "💡 Neon"]]) }));
    assert.equal(neon.films.find((f) => f.tt === "tt0000001").desc, "\nMood: 💡 Neon · Drama, Crime, Thriller · Neon, Film noir, Tuwaderalit.\n\nA long night in the city.", "the live desc keeps the word 'neon'");
    assert.equal(neon.rowDesc.tonight[0], "\nMood: 💡 Neon · Film noir, Tuwaderalit.", "the row's text drops it, as the static addon does");
    // Marco, 21/10/2026 ~19:40 UTC (A): a best fit that is the PLURAL of a genre leaves the genre out too (the real pair is Documentaries / Documentary: 984 films on the build of 21/10/2026)
    const plural = buildIndex(world({ cfg: cfgD, moods: compile(cfgD.moods), bestMood: new Map([["tt0000001", "🔪 Crimes"]]) }));
    assert.equal(plural.films.find((f) => f.tt === "tt0000001").desc, "\nMood: 🔪 Crimes · Drama, Thriller · Neon, Film noir, Tuwaderalit.\n\nA long night in the city.", "'Crimes' takes 'Crime' out of the line, the genres column keeps it");
  } finally { TMDB[33].keywords = original; }
});

// Regression guard of the review's finding 1 (Marco, 20/10/2026): the static files copied the words of the LEGACY index (9 moods) and the Worker 3.3.0 read the NEW one (every mood): 4,107 of 11,237 films
// had other first three words ("film noir, noir, anxious" against "noir, film noir, investigation"). One list now: `descMoods`, for both families, EVERY mood of config.json (Marco, 21/10/2026, 01:35 UTC: 6,630
// films have a word against 5,143 with the nine legacy moods); the `keywords` column stays the family's own.
test("index: the description's words are the same in the legacy family and in the v2 family, from every mood, for a film planted in both; a word that only a v2 mood has shows in both; the keywords column differs", () => {
  const extra = { id: "extra", word: "Extra", name: "Extra mood", genres: {}, keywords: { tuwaderalit: 2, neon: 0.1 } };
  const cfgB = { ...CFG, board: { legacyMoods: ["night"] }, moods: [CFG.moods[0], extra] };
  const v2opts = { v2: { menu: [{ id: "night", label: "Nocturnal" }, { id: "extra", label: "Extra" }], countries: ["United States"] } };
  const legacy = buildIndex(world({ cfg: cfgB, moods: compile(cfgB.moods), descMoods: cfgB.moods }));
  const v2 = buildIndex(world({ cfg: cfgB, moods: compile(cfgB.moods), descMoods: cfgB.moods, ...v2opts }));
  const L = legacy.films.find((f) => f.tt === "tt0000001"), V = v2.films.find((f) => f.tt === "tt0000001");
  assert.deepEqual(L.keywords, ["neon", "film noir", "noir"], "the legacy column: the legacy moods' words only (the search's own list)");
  assert.deepEqual(V.keywords, ["tuwaderalit", "neon", "film noir", "noir"], "the v2 column: every mood's words");
  assert.deepEqual([...legacy.descWords.get("tt0000001")], ["tuwaderalit", "neon", "film noir"], "the description's words in the legacy family: every mood's, with the word only the v2 mood 'extra' has");
  assert.deepEqual([...v2.descWords.get("tt0000001")], [...legacy.descWords.get("tt0000001")]);
  assert.equal(L.desc, V.desc, "and so the film's text, which the Worker reads from either index");
  assert.equal(L.desc, "\nDrama, Crime, Thriller · Tuwaderalit, Neon, Film noir.\n\nA long night in the city.");
  assert.deepEqual(legacy.rowDesc.tonight, v2.rowDesc.tonight);
  // the controls: the list of the nine alone (what build.js gave until 21/10/2026 01:35 UTC) loses the v2 mood's word; with no descMoods each family keeps its own list
  const nine = buildIndex(world({ cfg: cfgB, moods: compile(cfgB.moods), descMoods: [CFG.moods[0]] }));
  assert.deepEqual([...nine.descWords.get("tt0000001")], ["neon", "film noir"], "descMoods = the legacy moods: no 'tuwaderalit'");
  const own = buildIndex(world({ cfg: cfgB, moods: compile(cfgB.moods), ...v2opts }));
  assert.deepEqual([...own.descWords.get("tt0000001")], ["tuwaderalit", "neon", "film noir"], "with no descMoods the v2 family's own list");
});

test("index: a key that is absent means unknown, never a guess (no runtime, no country, no rating stays absent)", () => {
  const ix = buildIndex(world());
  const n = ix.films.find((f) => f.tt === "tt0000005");
  assert.deepEqual(Object.keys(n).sort(), ["decade", "find", "name", "quality", "rank", "taste", "tt", "wantBy", "watchlist", "year"], "(wantBy: the crowd of the test wants every film it does not otherwise know; no `desc`: since 20/10/2026 a film with no actors, no genre, no mood word and no synopsis has no text, the reason \"on your watchlist\" is not shown any more)");
  assert.equal(n.runtime, undefined);
  assert.equal(n.countries, undefined);
  assert.equal(n.lbRating, undefined);
  assert.equal(n.moods, undefined);
  for (const f of ix.films) for (const k of Object.keys(f)) assert.ok(ENTRY_KEYS.includes(k), `${k} is not an allowed key`);
});

test("index: seen films are flagged (a list film you have seen, an Old friends film, and any film whose IMDb id is in seenTts), and only those", () => {
  const ix = buildIndex(world({ seenTts: new Set(["tt0000002"]) }));
  const seen = ix.films.filter((f) => f.seen).map((f) => f.tt).sort();
  assert.deepEqual(seen, ["tt0000002", "tt0000003", "tt0000007"]);
  assert.deepEqual(ix.films.find((f) => f.tt === "tt0000003").lists, { L1: 1 });
  assert.equal(ix.films.find((f) => f.tt === "tt0000001").seen, undefined);
});

test("index: a film a friend loved (≥ 4★) enters the index unseen; one they rated 2★ does not; friends' ratings attach only to films already in", () => {
  const ix = buildIndex(world());
  const by = Object.fromEntries(ix.films.map((f) => [f.tt, f]));
  assert.deepEqual(by.tt0000004.friends, { seenBy: [["Ana", 4.5]], wantBy: [], friendsAvg: 4.5 });
  assert.equal(by.tt0000006, undefined, "rated 2★: not loved, not in any row");
  assert.deepEqual(by.tt0000001.friends, { seenBy: [["Ana", null], ["Bo", 4]], wantBy: [], friendsAvg: 4 }, "a log with no stars counts as seen but not in the average");
  assert.deepEqual(ix.friends, { people: ["Ana", "Bo"], options: [{ label: "Top · Ana", ids: ["tt0000004"] }] }, "the friends options, the loved row (a Board row) is not one");
});

test("index: the rows are the Board's, in its order, and a film only on the Board still has an entry with what the item says", () => {
  const ix = buildIndex(world());
  assert.deepEqual(ix.board.map((r) => r.id), Object.keys(ix.rows));
  assert.deepEqual(ix.rows.tonight, ["tt0000001", "tt0000009"]);
  assert.deepEqual(ix.rows.oldfriends, ["tt0000007"]);
  const b = ix.films.find((f) => f.tt === "tt0000009");
  assert.deepEqual([b.name, b.year, b.runtime, b.director, b.genres], ["Only On The Board", 2003, 77, "Dee Rector", ["Drama"]]);
  assert.equal(b.desc, "\nDrama.\n\nA synopsis. Two sentences.", "the plan's own genres and the synopsis (the reason \"row text\" is not shown since 20/10/2026); the row's mood ('Tonight · Night drive') belongs to the row, a film's general text does not know which catalog is on screen");
  assert.deepEqual(ix.rowDesc.tonight, ["\nNeon, Film noir.", "\nMood: Night drive · Drama.\n\nA synopsis. Two sentences."], "each row keeps its own text, one per film of the row (description v3, 20/10/2026): Tonight says the mood a pick was drawn for ('Tonight · Night drive' → 'Mood: Night drive'), an item with no mood says none; the mood words are the film's, after the films are known");
  assert.deepEqual(Object.keys(ix.rowDesc), Object.keys(ix.rows));
  assert.deepEqual(ix.rules, { rule: "letterboxd-average-or-configured-friend-or-vouched", minStars: 3.5, exemptCatalogs: ["lists", "lists-unseen", "friends"] }, "how the rule reached the index: the three direct collections are exempt (the Board rows are served as built)");
  assert.equal(ix.meta.separator, "\n\n");
  assert.equal(buildIndex(world({ quality: null })).rules, undefined, "no rule given (the unit tests): no rules, and every film is eligible");
  assert.ok(buildIndex(world({ quality: null })).films.every((f) => f.eligible));
  assert.equal(buildIndex(world({ separator: " — " })).films.find((f) => f.tt === "tt0000009").desc, "\nDrama. — A synopsis. Two sentences.");
});

test("index: keywords are the moods' search words only (weight > 0), whole words, at most 8; menus carry the labels the static addon uses", () => {
  const words8 = allowlist([{ keywords: { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1, h: 1, i: 1, neg: -2 } }]);
  assert.equal(words8.length, 9, "nine positive terms; the negative one is not a search word");
  assert.ok(!words8.some((t) => t.term === "neg"));
  const ix = buildIndex(world());
  const a = ix.films.find((f) => f.tt === "tt0000001");
  assert.deepEqual(a.keywords, ["neon", "film noir", "noir"], "heaviest word first; 'rape' is a warning, not a word; 'tuwaderalit' is not in the allowlist; the keyword 'film noir' holds both the terms 'film noir' and 'noir'");
  assert.deepEqual(ix.moods, [{ id: "night", label: "Nocturnal", name: "Night drive" }]);
  assert.deepEqual(ix.lists.map((l) => [l.id, l.label, l.films]), [["L1", "First (curator)", 3], ["L2", "Second", 1]]);
  assert.deepEqual(ix.meta.countries, ["United States", "France"]);
  assert.equal(ix.meta.decades.at(-1), "2020s");
  assert.ok(ix.lists.every((l) => !("short" in l)), "lists with no short name in the config publish none (nothing is invented)");
});

// Marco, 22/10/2026 ~04:05 UTC: the Discover menu of the lists is one line on the phone. Defects guarded: the index losing `short` (the Worker then lists the full names); `label` replaced by the short
// (the older installs ask for the full name); the static plan keeping the full name as the menu entry (its files and its manifest are named by it).
test("lists with a short name: the index keeps the full name as `label` and adds `short` (deduplicated like every menu entry); the static plan's Discover options are the short names, while the index keeps the full name as `label` (no card prints it since description v3)", () => {
  const withShort = LISTS.map((l, i) => ({ ...l, short: ["Curator first", "Second"][i] }));
  const ix = buildIndex(world({ lists: withShort }));
  assert.deepEqual(ix.lists.map((l) => [l.id, l.label, l.short, l.films]), [["L1", "First (curator)", "Curator first", 3], ["L2", "Second", "Second", 1]]);
  const twin = buildIndex(world({ lists: withShort.map((l) => ({ ...l, short: "Same" })) }));
  assert.deepEqual(twin.lists.map((l) => l.short), ["Same", "Same 2"], "two lists cannot share a menu entry: the second gets the suffix the static menus have always used");
  const mixed = buildIndex(world({ lists: [withShort[0], LISTS[1]] }));
  assert.deepEqual(mixed.lists.map((l) => "short" in l), [true, false]);
  const cats = P.listCatalogs({ lists: withShort, view: { films: FILMS }, isSeen, detail, size: 10 });
  assert.deepEqual(cats.map((c) => [c.name, c.short]), [["First (curator)", "Curator first"], ["Second", "Second"]]);
  const plan = buildPlan({ moods: [], rows: {}, extra: {}, lists: cats, sizes: { row: 30, friends: 30, discover: 60 }, withFriends: false });
  for (const id of ["mood-engine-lists", "mood-engine-lists-unseen"]) assert.deepEqual(plan.discover.find((c) => c.id === id).options.map((o) => o.label), ["Curator first", "Second"], id);
  const old = buildPlan({ moods: [], rows: {}, extra: {}, lists: P.listCatalogs({ lists: LISTS, view: { films: FILMS }, isSeen, detail, size: 10 }), sizes: { row: 30, friends: 30, discover: 60 }, withFriends: false });
  assert.deepEqual(old.discover.find((c) => c.id === "mood-engine-lists").options.map((o) => o.label), ["First (curator)", "Second"], "a list with no short is still the full name");
  // the build's own check of the index (publish.js and writeIndex call it) accepts the new field and refuses one that is not text
  const { validateIndex } = require("../lib/index-validation");
  assert.doesNotThrow(() => validateIndex(ix));
  assert.doesNotThrow(() => validateIndex(mixed));
  assert.throws(() => validateIndex({ ...ix, lists: ix.lists.map((l, i) => (i ? l : { ...l, short: 7 })) }), /Invalid index menu short/);
  assert.throws(() => validateIndex({ ...ix, lists: ix.lists.map((l, i) => (i ? l : { ...l, shorter: "x" })) }), /Unexpected index field lists\.shorter/);
});

test("index: `find` is the text a search reads: title | director | keywords | genres | countries, accents off and lower case, the same function the Worker uses on the query", () => {
  assert.equal(words("Amélie & Co. — 8½"), "amelie and co 81 2", "NFKD turns ½ into 1⁄2: the title is findable by what words() makes of it, on both sides");
  assert.equal(words("Cinéma Vérité: «Žižek!»"), "cinema verite zizek");
  const ix = buildIndex(world());
  assert.equal(ix.films.find((f) => f.tt === "tt0000001").find, " alpha | ana dir bo dir | neon film noir noir | drama crime thriller | united states");
  assert.equal(ix.films.find((f) => f.tt === "tt0000005").find, " nothing known |  |  |  | ");
});

test("index: `eligible` is the build's verdict on the recommendation rule, per film, and the private feedback of the build leaves no trace but the same flag or the mood's absence; an IMDb rating found for a film whose shared numbers lack it is used", () => {
  const by = (ix) => Object.fromEntries(ix.films.map((f) => [f.tt, f]));
  const base = by(buildIndex(world()));
  assert.equal(base.tt0000001.eligible, true);
  assert.equal(base.tt0000005.eligible, undefined, "the build said no (no average, no friend's rating): the flag is absent");
  assert.deepEqual(Object.keys(base.tt0000001.moods || {}), ["night"]);
  // feedback, as lib/learning/feedback.js eligible() answers it: "not for me" / "not tonight" refuse the film everywhere; "wrong mood: night" refuses it that mood only
  const nope = by(buildIndex(world({ permits: (tt) => tt !== "tt0000001" })));
  assert.equal(nope.tt0000001.eligible, undefined, "feedback keeps it out of the generated catalogs, as the build's own rows do");
  assert.equal(nope.tt0000001.moods, undefined, "and out of its moods");
  assert.equal(nope.tt0000002.eligible, true, "other films are not touched");
  const wrong = by(buildIndex(world({ permits: (tt, mood) => !(tt === "tt0000001" && mood === "night") })));
  assert.equal(wrong.tt0000001.eligible, true, "a wrong-mood mark for one mood does not make the film ineligible");
  assert.equal(wrong.tt0000001.moods, undefined, "it only leaves that mood");
  assert.ok(!JSON.stringify(buildIndex(world({ permits: () => false }))).match(/not_tonight|not_for_me|wrong_mood|feedback/i), "no feedback word is written");
  const w = world({ imdb: new Map([["tt0000009", 6.6]]) });
  w.plan.board.find((r) => r.id === "tonight").items.find((i) => i.id === "tt0000009").ratings = { lb: null, imdb: null, friendsAvg: null, seenBy: 0, wantBy: 0 };
  assert.equal(buildIndex(w).films.find((f) => f.tt === "tt0000009").imdbRating, 6.6);
});

test("WORKER_EXEMPT names exactly the collections that lib/recommendation-quality.js applyPlan() leaves alone (a Discover catalog it filters is not exempt in the Worker; one it spares is)", () => {
  const STATIC_TO_WORKER = { "mood-engine": "moods", "mood-engine-lists": "lists", "mood-engine-lists-unseen": "lists-unseen", "mood-engine-friends": "friends", "mood-engine-decade": "explore", "mood-engine-runtime": "explore", "mood-engine-country": "explore", "mood-engine-rating": "explore" };
  const item = { id: "tt0000042", title: "x", year: 2000, why: [] };
  const plan = { board: [{ id: "tonight", items: [{ ...item }] }], discover: Object.keys(STATIC_TO_WORKER).map((id) => ({ id, options: [{ label: "o", items: [{ ...item }] }] })) };
  Q.applyPlan(plan, new Map()); // nobody has a rating: everything the rule filters is gone, whatever it spares stays
  const spared = plan.discover.filter((c) => c.options[0].items.length).map((c) => STATIC_TO_WORKER[c.id]).sort();
  assert.deepEqual(spared, [...WORKER_EXEMPT].sort());
  assert.equal(plan.board[0].items.length, 0, "Board rows are filtered by the build, and served as built");
});

test("index: the text of a film that only the plan knows loses its '#12 in “List”' line (it belongs to one list; the Worker writes it for the list on screen)", () => {
  const w = world();
  const onlyOnBoard = w.plan.board.find((r) => r.id === "tonight").items.find((i) => i.id === "tt0000009");
  onlyOnBoard.why = ["#12 in “First (curator)”", "row text"];
  const ix = buildIndex(w);
  assert.equal(ix.films.find((f) => f.tt === "tt0000009").desc, "\nDrama.\n\nA synopsis. Two sentences.");
  assert.equal(ix.films.find((f) => f.tt === "tt0000003").desc, undefined, "a seen film of a list has nothing but its place in the list to say (the facts line is the Worker's, from the columns)");
});

test("index: films come best rank first (the Worker stops reading at a page), films with no rank last, ties by IMDb id", () => {
  const ix = buildIndex(world());
  const ranks = ix.films.map((f) => f.rank ?? -Infinity);
  assert.deepEqual(ranks, [...ranks].sort((x, y) => y - x));
  assert.ok(ix.films.at(-1).rank === undefined);
});

test("index: the Board part holds only the Board's films, the menus, and the friends' options without their films", () => {
  const ix = buildIndex(world());
  const b = boardIndex(ix);
  assert.equal(b.meta.part, "board");
  assert.deepEqual(b.films.map((f) => f.tt).sort(), ["tt0000001", "tt0000007", "tt0000009"]);
  assert.equal(b.meta.count, 3);
  assert.deepEqual(b.friends.options, [{ label: "Top · Ana", ids: [] }]);
  assert.deepEqual(b.rows, ix.rows);
  assert.deepEqual(b.moods, ix.moods);
  assert.equal(ix.meta.part, "full");
});

test("writeIndex: index and pieces are written inside staging, and the sizes it reports are the files'", () => {
  const out = tmp();
  try {
    const ix = buildIndex(world());
    const w = writeIndex(out, ix);
    localImages(out, ix);
    const full = fs.readFileSync(path.join(out, "data", "index.json"));
    assert.equal(w.bytes, full.length);
    assert.equal(w.gzip, zlib.gzipSync(full, { level: 9 }).length);
    assert.equal(w.films, ix.films.length);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, "data", "index-board.json"), "utf8")).meta.part, "board");
    assert.deepEqual(decode(JSON.parse(full.toString("utf8"))), ix, "what is on disk decodes to what buildIndex returned");
    assert.equal(verifyIndex(out, { forbid: ["mgusmao"] }).ok, true, verifyIndex(out).problems.join("\n"));
    const langText = fs.readFileSync(path.join(out, LANGUAGES_FILE), "utf8");
    assert.deepEqual(JSON.parse(langText), languagesFile(ix), "data/film-languages.json is written next to the index");
    assert.equal(w.languages.bytes, Buffer.byteLength(langText));
    assert.equal(w.languages.gzip, zlib.gzipSync(langText, { level: 9 }).length);
    assert.deepEqual([w.languages.pt, w.languages.known], [0, 1], "the fixture has one film with a language, English");
  } finally { rm(out); }
});

// ── data/film-languages.json (Marco, 12/10/2026) ─────────────────────────────────────────────────
// Signed 12/10/2026: the Worker's /subtitles cannot parse the whole index (40 to 50 ms of CPU on a fresh isolate, 10 ms allowed), so the language column is cut out.
test("languagesFile: Portuguese films in `pt`, films in any other real language in `known`, 'xx' (no spoken language), blank and missing in neither; numbers sorted, a bar on both sides, a single bar when empty", () => {
  const films = [["tt0000010", "pt"], ["tt0000002", "en"], ["tt0000001", "PT "], ["tt0000003", "xx"], ["tt0000030", "pt-BR"], ["tt0000031", "pt_br"], ["tt0000032", "ZXX"], ["tt0000033", "english"], ["tt0000034", "en-US"], ["tt0000004", undefined], ["tt0000005", ""], ["tt0000006", "sv"], ["tt0000007", "cn"], ["tt0111161", "en"], ["tt0000002", "en"], ["tmdb:5", "en"], ["tt12", "pt"]].map(([tt, language]) => ({ tt, language }));
  const f = languagesFile({ meta: { builtAt: "2026-10-12T00:00:00.000Z" }, films });
  assert.deepEqual(f, { v: 1, builtAt: "2026-10-12T00:00:00.000Z", pt: "|0000001|0000010|0000030|0000031|12|", known: "|0000002|0000006|0000007|0000034|0111161|" });
  assert.deepEqual(languagesFile({ meta: { builtAt: "x" }, films: [] }), { v: 1, builtAt: "x", pt: "|", known: "|" });
  assert.ok(f.pt.includes("|0000010|") && !f.pt.includes("|000001|"), "an id is never matched as part of another");
});

test("verifyIndex: film-languages.json must exist, parse, have the shape the Worker reads and say what the index's language column says", () => {
  const edit = (fn) => { const out = written(); try { const file = path.join(out, "data", "film-languages.json"); fn(file, JSON.parse(fs.readFileSync(file, "utf8"))); return verifyIndex(out).problems.join("\n"); } finally { rm(out); } };
  const rewrite = (fn) => edit((file, j) => { fn(j); fs.writeFileSync(file, JSON.stringify(j)); });
  assert.equal(edit(() => {}), "", "the file as the build writes it passes");
  assert.match(edit((file) => fs.rmSync(file)), /data\/film-languages\.json is missing/);
  assert.match(edit((file) => fs.writeFileSync(file, "{not json")), /data\/film-languages\.json does not parse/);
  assert.match(edit((file) => fs.writeFileSync(file, "[]")), /film-languages\.json is not an object/);
  assert.match(rewrite((j) => { j.v = 2; }), /film-languages\.json: v is 2, the Worker reads 1/);
  assert.match(rewrite((j) => { j.extra = "x"; }), /film-languages\.json: unexpected key "extra"/);
  assert.match(rewrite((j) => { j.pt = "0000001"; }), /film-languages\.json: pt must be "\|number\|number\|"/);
  assert.match(rewrite((j) => { delete j.known; }), /film-languages\.json: known must be/);
  assert.match(rewrite((j) => { j.known = "||"; }), /film-languages\.json: known must be/);
  assert.match(rewrite((j) => { j.pt = "|0000001|"; }), /film-languages\.json: pt is not what the index's language column says \(1 ids, expected 0\)/);
  assert.match(rewrite((j) => { j.known = "|"; }), /film-languages\.json: known is not what the index's language column says \(0 ids, expected 1\)/);
  assert.match(rewrite((j) => { j.builtAt = "2020-01-01T00:00:00.000Z"; }), /film-languages\.json: builtAt 2020-01-01T00:00:00\.000Z is not the index's/);
  assert.match(rewrite((j) => { j.known = "|0000001|" + "1|".repeat(MAX_LANGUAGES_BYTES / 2); }), /more than \d+/);
  assert.match(rewrite((j) => { j.builtAt = "marco@example.com"; }), /film-languages\.json contains something that looks like an e-mail/);
  // a film whose language changes in the index but not in the file: the file is stale
  const stale = (() => { const out = written((ix) => { ix.films.find((f) => f.tt === "tt0000001").language = "pt"; }, undefined); try { fs.writeFileSync(path.join(out, "data", "film-languages.json"), JSON.stringify({ v: 1, builtAt: JSON.parse(fs.readFileSync(path.join(out, "data", "index.json"), "utf8")).meta.builtAt, pt: "|", known: "|0000001|" })); return verifyIndex(out).problems.join("\n"); } finally { rm(out); } })();
  assert.match(stale, /film-languages\.json: pt is not what the index's language column says/);
});

// ── verify.js: the index ─────────────────────────────────────────────────────────────────────────

function localImages(out,index){fs.mkdirSync(path.join(out,'posters'),{recursive:true});for(const tt of new Set(index.films.map(e=>e.poster?.match(/\/posters\/(tt\d+)\.jpg$/)?.[1]).filter(Boolean)))fs.copyFileSync(path.join(__dirname,'fixtures/learning/cover.jpg'),path.join(out,'posters',tt+'.jpg'));}
function written(mutate, pre) {
  const out = tmp();
  const ix = buildIndex(world());
  if (pre) pre(ix); // before the pieces are cut from it
  const parts = {}; // every piece, as a copy: a test can change the index, or one piece, without the other
  for (const p of pieces(ix)) parts[p.part] = { rel: p.rel, obj: JSON.parse(JSON.stringify(p.obj)) };
  if (mutate) mutate(ix, parts.board.obj, parts);
  fs.mkdirSync(path.join(out, "data"), { recursive: true });
  fs.writeFileSync(path.join(out, "data", "index.json"), JSON.stringify(encode(ix)));
  fs.writeFileSync(path.join(out, LANGUAGES_FILE), JSON.stringify(languagesFile(ix)));
  for (const p of Object.values(parts)) fs.writeFileSync(path.join(out, p.rel), JSON.stringify(encode(p.obj)));
  localImages(out, ix);
  return out;
}
/** Change one film wherever it is: in the index and in every piece that holds it. */
const everywhere = (ix, parts, tt, fn) => { for (const o of [ix, ...Object.values(parts).map((p) => p.obj)]) { const f = o.films.find((x) => x.tt === tt); if (f) fn(f); } };
const problems = (mutate, opts, pre) => { const out = written(mutate, pre); try { return verifyIndex(out, opts).problems.join("\n"); } finally { rm(out); } };

test("verifyIndex: a good index passes; a row that names a film the index does not have, a seen film in a row, a repeated or malformed IMDb id are each named", () => {
  assert.equal(problems(), "");
  assert.match(problems((ix) => { ix.rows.tonight.push("tt0000999"); }), /tt0000999 in row tonight is not among the films/);
  assert.match(problems((ix, b, parts) => everywhere(ix, parts, "tt0000001", (f) => { f.seen = true; })), /tt0000001 \(Alpha\) is marked seen and sits in row tonight/);
  assert.equal(problems((ix, b, parts) => everywhere(ix, parts, "tt0000007", (f) => { f.seen = true; })), "", "Old friends is a rewatch row: seen films belong there");
  assert.match(problems((ix, b, parts) => { ix.friends.options[0].ids.push("tt0000003"); parts.friends.obj.friends.options[0].ids.push("tt0000003"); parts.friends.obj.films.push(ix.films.find((f) => f.tt === "tt0000003")); }), /tt0000003 \(Already Seen\) is marked seen and sits in friends option Top · Ana/);
  assert.match(problems((ix) => { ix.films.push({ ...ix.films[0] }); }), /appears twice/);
  assert.match(problems((ix) => { ix.films[0].tt = "tmdb:5"; }), /not an IMDb id/);
});

test("verifyIndex, Loved by directors (Marco, 11/10/2026): a good menu passes; a seen film in an option, an option with a text missing, a piece that loses the menu or carries its films are each named", () => {
  const menu = (ids) => (ix) => { ix.directors = { options: [{ label: "Lynch loves", ids, descs: ids.map((tt) => `Loved by Lynch · ${tt}`) }] }; };
  assert.equal(problems(undefined, undefined, menu(["tt0000001", "tt0000002"])), "");
  assert.match(problems(undefined, undefined, menu(["tt0000001", "tt0000003"])), /tt0000003 \(Already Seen\) is marked seen and sits in directors option Lynch loves/);
  assert.match(problems(undefined, undefined, (ix) => { menu(["tt0000001"])(ix); ix.directors.options[0].descs = []; }), /directors option Lynch loves must have one text per film/);
  assert.match(problems((ix, b, parts) => { parts.moods.obj.directors = { options: [] }; }, undefined, menu(["tt0000001"])), /index-moods: the directors menu differs from index/);
  assert.match(problems((ix, b) => { b.directors = ix.directors; }, undefined, menu(["tt0000001"])), /index-board: only the directors piece carries the films of the directors options/);
  assert.match(problems((ix, b, parts) => { parts.directors.obj.films = []; parts.directors.obj.meta.count = 0; }, undefined, menu(["tt0000001"])), /index-directors: 1 film\(s\) it should hold are missing/);
});

test("verifyIndex: no personal field gets through. The row format has no place for one (an extra key on a film is dropped by encode), so what is checked is the FILE: a column that is not on the list, a row with a cell too many, a key at the top or in meta, an e-mail in any text, your Letterboxd user name, a friend who is not declared", () => {
  const raw = (mutate, opts) => { const out = written(); try { const f = path.join(out, "data", "index.json"); const j = JSON.parse(fs.readFileSync(f, "utf8")); mutate(j); fs.writeFileSync(f, JSON.stringify(j)); return verifyIndex(out, opts).problems.join("\n"); } finally { rm(out); } };
  assert.equal(encode({ ...buildIndex(world()), films: [{ tt: "tt1", name: "x", email: "marco@example.com", myRating: 5 }] }).films[0].join("|"), "tt1|x", "a key that is not a column never reaches the file");
  assert.match(raw((j) => { j.cols = [...j.cols, "email"]; }), /the rows cannot be read: index: columns are/);
  assert.match(raw((j) => { j.films[0].push(...new Array(30).fill(null), "marco"); }), new RegExp(`has \\d+ cells, the file has ${COLS.length} columns`));
  assert.match(raw((j) => { j.meta.owner = "x"; }), /unexpected meta key "owner"/);
  assert.match(raw((j) => { j.extra = {}; }), /unexpected top-level key "extra"/);
  assert.match(raw((j) => { j.meta.format = "objects"; }), /meta\.format is objects/);
  assert.match(raw((j) => { j.films[0][COLS.indexOf("desc")] = "write to marco@example.com"; }), /looks like an e-mail address: marco@example\.com/);
  assert.match(raw((j) => { j.films[0][COLS.indexOf("desc")] = "logged by MGusmao"; }, { forbid: ["mgusmao"] }), /contains "mgusmao"/);
  assert.match(raw((j) => { j.films[0][COLS.indexOf("friends")] = "9=4;;"; }), /names person 9, who is not in friends\.people/);
});

test("verifyIndex: numbers out of range, a mood or list that is not declared, a wrong schema or a count that is not the number of films", () => {
  assert.match(problems((ix) => { ix.films[0].lbRating = 9; }), /lbRating 9/);
  assert.match(problems((ix) => { ix.films[0].year = 12; }), /year 12/);
  assert.match(problems((ix) => { ix.films[0].runtime = 90000; }), /runtime 90000/);
  assert.match(problems((ix) => { ix.films[0].moods = { ghost: [1, 2] }; }), /mood "ghost" is not declared/);
  assert.match(problems((ix) => { ix.films[0].lists = { ghost: 1 }; }), /list "ghost" is not declared/);
  assert.match(problems((ix) => { ix.films[0].lists = { L1: 0 }; }), /list "L1" position 0/);
  assert.match(problems((ix) => { ix.meta.schema = 2; }), /meta\.schema is 2/);
  assert.match(problems((ix) => { ix.meta.count = 99; }), /meta\.count 99 but \d+ films/);
  assert.match(problems((ix) => { ix.meta.builtAt = "yesterday"; }), /meta\.builtAt "yesterday" is not a date/);
});

test("verifyIndex: each piece must hold exactly the films of its family, identical to the whole index (a stale or short piece would serve yesterday's Board or drop results without a word)", () => {
  assert.match(problems((ix, b) => { b.films[0].name = "Changed"; }), /index-board: tt\d+ differs from the same film in index/);
  assert.match(problems((ix, b) => { b.rows.tonight.reverse(); }), /index-board: rows differs from index/);
  assert.match(problems((ix, b) => { b.meta.countries = ["Peru"]; }), /country or decade menu differs/);
  assert.match(problems((ix, b) => { b.friends.options[0].label = "Other"; }), /friends menu differs/);
  assert.match(problems((ix, b) => { b.films.pop(); }), /index-board: 1 film\(s\) it should hold are missing/);
  assert.match(problems((ix, b, parts) => { parts.moods.obj.films.pop(); parts.moods.obj.meta.count--; }), /index-moods: 1 film\(s\) it should hold are missing/);
  assert.match(problems((ix, b, parts) => { parts.moods.obj.films.push(ix.films.find((f) => f.tt === "tt0000005")); parts.moods.obj.meta.count++; }), /index-moods: 1 film\(s\) it should not hold \(Nothing Known\)/);
  assert.match(problems((ix, b, parts) => { const o = parts["list:L1"].obj; o.films = o.films.filter((f) => f.tt !== "tt0000003"); o.meta.count--; }), /index-list-L1: 1 film\(s\) it should hold are missing \(Already Seen\)/, "a seen film of the list belongs to its piece: Lists (whole) shows it");
  assert.match(problems((ix, b, parts) => { parts.friends.obj.friends.options[0].ids = []; }), /index-friends: the friends options differ from index/);
  assert.match(problems((ix, b, parts) => { parts["list:L2"].obj.friends.options[0].ids = ["tt0000004"]; }), /index-list-L2: only the friends piece carries the films of the friends options/);
  assert.match(problems((ix, b, parts) => { parts.moods.obj.rows = { tonight: [] }; }), /index-moods: only the Board part carries Board rows/);
  assert.match(problems((ix, b, parts) => { parts["list:L2"].obj.lists[0].label = "Other"; }), /index-list-L2: lists differs from index/);
});

test("verifyIndex: a missing piece is named", () => {
  const out = written();
  try {
    fs.rmSync(path.join(out, "data", "index-list-L2.json"));
    fs.rmSync(path.join(out, "data", "index-board.json"));
    assert.match(verifyIndex(out).problems.join("\n"), /data\/index-list-L2\.json is missing[\s\S]*|data\/index-board\.json is missing/);
    assert.match(verifyIndex(out).problems.join("\n"), /data\/index-board\.json is missing/);
  } finally { rm(out); }
});

test("rows: decode(encode(x)) is x for awkward values (a rating of 0, a log with no stars, a name with quotes, a description with a pipe or a newline); a value the format cannot carry is refused at build time, not corrupted", () => {
  const people = ["Ana", "Bo"];
  const e = {
    tt: "tt0000001", name: 'He said "go" — 8½\n', year: 1999, decade: "1990s", runtime: 88, countries: ["United States", "Hong Kong"], language: "en", lbRating: 4.3, tmdbRating: 7.8, tmdbVotes: 3000, imdbRating: 7.3, seenBy: 3, wantBy: 0, friendsAvg: 4.5,
    taste: 0, quality: -1.5, rank: 0, poster: "https://example.test/p.jpg", desc: "a | b\n\nc, d: e; f", genres: ["Drama"], director: "A, B", keywords: ["neon", "film noir"], find: " he said go | | | | ",
    moods: { night: [0.81, 2.35], lift: [1, 0] }, lists: { L1: 3, "top250-narrative": 12 }, friends: { seenBy: [["Ana", 4.5], ["Bo", null]], wantBy: ["Bo"], friendsAvg: 4.5 }, watchlist: true, seen: true,
  };
  const sparse = { tt: "tt0000002", name: "Sparse", find: " sparse | | | | " };
  const ix = { meta: { schema: 1 }, friends: { people, options: [] }, films: [e, sparse] };
  assert.deepEqual(decode(JSON.parse(JSON.stringify(encode(ix)))), { meta: { schema: 1 }, friends: { people, options: [] }, films: [e, sparse] });
  assert.deepEqual(encode(ix).films[1], ["tt0000002", "Sparse", null, null, null, null, null, null, null, null, " sparse | | | | "], "a sparse row stops at its last value");
  assert.throws(() => encodeFilm({ ...sparse, countries: ["A|B"] }, people), /cannot carry/);
  assert.throws(() => encodeFilm({ ...sparse, lists: { "a:b": 1 } }, people), /a list id "a:b"/);
  assert.throws(() => encodeFilm({ ...sparse, moods: { "a,b": [1, 2] } }, people), /a mood id/);
  assert.throws(() => encodeFilm({ ...sparse, friends: { seenBy: [["Stranger", 4]], wantBy: [] } }, people), /"Stranger", who is not in friends\.people/);
  assert.equal(COLS.length, 29); // + country, 13/10/2026; + seenMask and wantMask, 29/10/2026 (test/friend-view.test.js)
});

test("verifyIndex: the build's rules (the Letterboxd floor) are optional; when present they must be well formed and the same in every piece", () => {
  const rules = (ix) => { ix.rules = { rule: "letterboxd-average-or-configured-friend", minStars: 3.5, exemptCatalogs: ["lists", "lists-unseen", "friends"] }; };
  assert.equal(problems(undefined, undefined, rules), "");
  for (const bad of [{ minStars: 3.5, exemptCatalogs: [] }, { rule: "x", minStars: "3.5", exemptCatalogs: [] }, { rule: "x", minStars: 6, exemptCatalogs: [] }, { rule: "x", minStars: -1, exemptCatalogs: [] }, { rule: "x", exemptCatalogs: [] }, { rule: "x", minStars: 3.5 }, { rule: "x", minStars: 3.5, exemptCatalogs: "lists" }, { rule: "x", minStars: 3.5, exemptCatalogs: [1] }, null])
    assert.match(problems(undefined, undefined, (ix) => { ix.rules = bad; }), /rules must be \{ rule: text, minStars: 0 to 5, exemptCatalogs: \[ids\] \}/, JSON.stringify(bad));
  assert.match(problems((ix, b, parts) => { parts.moods.obj.rules = { rule: "x", minStars: 3, exemptCatalogs: [] }; }, undefined, rules), /index-moods: rules differs from index/);
  assert.match(problems((ix, b, parts) => everywhere(ix, parts, "tt0000001", (f) => { delete f.eligible; })), /tt0000001 \(Alpha\) sits in row tonight but is not eligible as a recommendation/, "a Board row holds a film the rule does not let in: the flag and the row disagree");
  assert.equal(problems((ix, b, parts) => everywhere(ix, parts, "tt0000007", (f) => { delete f.eligible; })), "", "Old friends is a rewatch row: the rule is not checked there");
});

test("verifyIndex: each Board row keeps one text per film (rowDesc), and the Board part must have the same ones; the crowd's numbers must be numbers in range", () => {
  assert.match(problems((ix) => { ix.rowDesc.tonight.pop(); }), /rowDesc of row tonight must be one text per film of the row/);
  assert.match(problems((ix) => { ix.rowDesc.tonight[0] = 5; }), /rowDesc of row tonight must be one text per film/);
  assert.match(problems((ix) => { ix.rowDesc.ghost = []; }), /rowDesc names a row \(ghost\) that is not in rows/);
  assert.match(problems((ix, b) => { b.rowDesc.tonight[0] = "other"; }), /index-board: rowDesc differs from index/);
  assert.match(problems((ix) => { ix.films[0].seenBy = -1; }), /seenBy -1/);
  assert.match(problems((ix) => { ix.films[0].wantBy = 1.5; }), /wantBy 1\.5/);
  assert.match(problems((ix) => { ix.films[0].friendsAvg = 7; }), /friendsAvg 7/);
  assert.match(problems((ix) => { ix.films[0].imdbRating = 11; }), /imdbRating 11/);
  assert.match(problems((ix) => { ix.films[0].poster = "javascript:alert(1)"; }), /poster "javascript:alert\(1\)" is not an http\(s\) address/);
});

test("verifyIndex: over 4 MB gzipped is refused (a cold start downloads it), a missing file is named, a file that does not parse is named", () => {
  assert.match(problems((ix) => { ix.films[0].desc = crypto.randomBytes(5e6).toString("base64"); }), /MB gzipped, more than 4 MB/);
  assert.ok(MAX_INDEX_GZIP === 4e6);
  const out = tmp();
  try {
    assert.match(verifyIndex(out).problems.join("\n"), /data\/index\.json is missing/);
    fs.mkdirSync(path.join(out, "data"));
    fs.writeFileSync(path.join(out, "data", "index.json"), "{nope");
    assert.match(verifyIndex(out).problems.join("\n"), /data\/index\.json does not parse/);
  } finally { rm(out); }
});

// ── the real build, from the caches ──────────────────────────────────────────────────────────────

test("build --cache-only: the index agrees with the static addon file by file (rows, menus, countries), has no seen film in a Board row, is under 4 MB gzipped, and verify.js passes", { skip: !fs.existsSync(path.join(ROOT, "cache", "lists.json")) }, () => {
  const out = tmp(), cache = tmp("mood-cache-");
  for (const f of ["friends.json", "lists.json", "tmdb.json", "directors.json", "imdb-ratings.json"]) fs.copyFileSync(path.join(ROOT, "cache", f), path.join(cache, f));
  try {
    const r = spawnSync(process.execPath, ["build.js", "--offline", "--cache-only", "--cache-dir", cache, "--out", out], { cwd: ROOT, encoding: "utf8", env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /index for the Worker: \d+ films · [\d.]+ MB · [\d.]+ MB gzipped \(Board part: \d+ films/);
    const ix = decode(JSON.parse(fs.readFileSync(path.join(out, "data", "index.json"), "utf8")));
    const man = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    const staticIds = (rel) => JSON.parse(fs.readFileSync(path.join(out, "catalog", "movie", rel), "utf8")).metas.map((m) => m.id);
    const byTt = new Map(ix.films.map((f) => [f.tt, f]));

    // every Board row: the same films in the same order as the static file
    assert.equal(ix.board.length, 20); // Marco, 11/10/2026: + "Slow and still" and "Loved by your directors"
    for (const c of man.catalogs.filter((x) => !x.extra)) assert.deepEqual(ix.rows[c.id], staticIds(`${c.id}.json`), `row ${c.id}`);
    assert.deepEqual(ix.board.map((r) => r.id), man.catalogs.filter((x) => !x.extra).map((x) => x.id));
    assert.deepEqual(ix.board.map((r) => r.name), man.catalogs.filter((x) => !x.extra).map((x) => x.name));
    // the menus are the static menus
    const opts = (id) => man.catalogs.find((c) => c.id === id).extra[0].options;
    assert.deepEqual(ix.moods.map((m) => m.label), opts("mood-engine"));
    assert.deepEqual(ix.lists.map((l) => l.short), opts("mood-engine-lists"), "22/10/2026: the static menu is the short names, the index's `short`"); // `label` is the full name, which the older installs of the Worker still ask for
    assert.deepEqual(ix.lists.map((l) => l.short), opts("mood-engine-lists-unseen"));
    assert.ok(ix.lists.every((l) => typeof l.short === "string" && l.short.length <= 28), "every list of the real config has a short name of one line");
    // Marco, 28/10/2026 (Discover proposal 5, answer (b)): the Worker's Friends menu has ONE option more than the static addon's, "All friends loved" (~1,600 films, the Worker's alone: lib/friends-option.js), right after the last "Top ·"
    // option. This difference is intentional and the only one: the seven friends' own options (Top, Watch together, lists) are the static ones, label by label and in the same order.
    const ALL = "All friends loved", friendLabels = ix.friends.options.map((o) => o.label);
    assert.deepEqual(friendLabels.filter((l) => l !== ALL), opts("mood-engine-friends"), "the static addon's friends menu, with the one option of the Worker taken out");
    assert.equal(friendLabels.indexOf(ALL), opts("mood-engine-friends").filter((l) => l.startsWith("Top · ")).length, "and the option sits right after the last Top option");
    assert.equal(friendLabels.filter((l) => l === ALL).length, 1);
    assert.deepEqual(ix.directors.options.map((o) => o.label), opts("mood-engine-directors-loved"));
    assert.deepEqual(ix.meta.countries, opts("mood-engine-country"));
    // every film of every Discover file of the static addon is in the index, with the fact its cut reads
    const filmsOf = (cat, label) => staticIds(`${cat}/genre=${label}.json`);
    for (const label of opts("mood-engine-decade")) for (const tt of filmsOf("mood-engine-decade", label)) assert.equal(byTt.get(tt).decade, label, `${tt} in decade ${label}`);
    for (const label of opts("mood-engine-country")) for (const tt of filmsOf("mood-engine-country", label)) assert.ok(byTt.get(tt).countries.includes(label), `${tt} in country ${label}`);
    for (const l of ix.lists) for (const tt of filmsOf("mood-engine-lists", l.short)) assert.ok(l.id in byTt.get(tt).lists, `${tt} in list ${l.label}`);
    for (const o of ix.friends.options.filter((o) => o.label !== ALL)) assert.deepEqual(o.ids.slice(0, filmsOf("mood-engine-friends", o.label).length), filmsOf("mood-engine-friends", o.label), `friends option ${o.label}: the capped static file is the head of the full one`);
    for (const o of ix.directors.options) assert.deepEqual(o.ids, filmsOf("mood-engine-directors-loved", o.label), `directors option ${o.label}: the same films in the same order as the static file`);
    // the v2.1 numbers are the static addon's, film by film: the Letterboxd average of every description in every file, the IMDb rating beside it, the cover
    assert.deepEqual([ix.rules.minStars, ix.rules.exemptCatalogs, ix.meta.separator], [Q.MIN_STARS, WORKER_EXEMPT, "\n\n"], "the rule's stars, the exempt collections and the separator are the build's");
    // `eligible` is the build's own verdict, recomputed here from the caches by lib/recommendation-quality.js
    const F = require("../lib/friends"), cfgReal = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
    // Marco, 11/10/2026 (decision 5), ONE exception: a film in a critic or director list, or loved by a favourite director through a high or
    // medium source, needs no floor. The list half is recomputed here from the same caches; the director half needs the taste model, so a
    // film the rule and the lists keep out may be eligible only if a favourite director (the build's log names them) loves it in data/directors-loved.json.
    const fc = F.loadCache(path.join(cache, "friends.json"));
    // Marco, 22/10/2026 ~06:40 UTC: the rule has one more condition, a film TMDB was asked about and has no record of (tmdb.json of the same cache directory); a film in that state is not eligible whatever its average (Monster, tt0434706, was the first red)
    const tmdbOfCache = new (require("../lib/tmdb").Tmdb)("unused: nothing is asked", path.join(cache, "tmdb.json"));
    const ratings = Q.index({ ...F.viewFriends(fc, cfgReal), films: require("../lib/static-lists").filmsFor(cfgReal, ROOT, fc.films) }, { vouched: require("../lib/list-signal").vouchedFromCaches({ cfg: cfgReal, listsCache: JSON.parse(fs.readFileSync(path.join(cache, "lists.json"), "utf8")), films: fc.films }), unrecorded: ({ imdbId, tmdbId }) => tmdbOfCache.noRecord(imdbId, tmdbId) });
    // only the films a FAVOURITE director loves (the favourites the build printed), not every film of the file (review S4-6)
    const lovedFile = require("../test-support/loved-favourites").lovedByFavourites(r.stdout, ROOT);
    let eligibleN = 0, byException = 0;
    for (const f of ix.films) {
      const rule = Q.qualifies(ratings.get(f.tt));
      if (rule || !lovedFile.has(f.tt)) assert.equal(!!f.eligible, rule, `${f.tt} ${f.name}`);
      else if (f.eligible) byException++;
      if (f.eligible) eligibleN++;
    }
    assert.ok(byException > 20, `${byException} films pass only by a favourite director's love`);
    const menuIds = new Set(ix.directors.options.flatMap((o) => o.ids));
    assert.ok(ix.films.every((f) => !menuIds.has(f.tt) || f.eligible), "every film of the directors' menu is eligible (the exception)");
    assert.ok(eligibleN > 3000 && eligibleN < ix.films.length, `${eligibleN} eligible of ${ix.films.length}`);
    let checkedNumbers = 0;
    // The crowd's columns (seenBy, wantBy, friendsAvg) are not in any description since 13/10/2026 (the numbers line is gone) but they stay in the index, for the Worker's
    // filters and for the covers: they are still checked against the build's own crowd, asked here by IMDb id, title and year for every film of the static files.
    // (13/10/2026: 10 of 6,617 films differ, the ones the build finds through a Letterboxd slug this test does not know.)
    const view = F.viewFriends(fc, cfgReal), crowd = require("../lib/crowd").crowdIndex({ crowd: view.crowd, films: view.films });
    let crowdFilms = 0, crowdDiffer = 0;
    const counted = new Set();
    const allFiles = [...man.catalogs.filter((c) => !c.extra).map((c) => [`${c.id}.json`, 1]), ...man.catalogs.filter((c) => c.extra).flatMap((c) => c.extra[0].options.map((o) => [`${c.id}/genre=${o}.json`, c.id === "mood-engine-rating" ? 2 : 1]))];
    for (const [file, digits] of allFiles) {
      for (const m of JSON.parse(fs.readFileSync(path.join(out, "catalog", "movie", file), "utf8")).metas) {
        const e = byTt.get(m.id);
        // 13/10/2026: the numbers line is gone; 20/10/2026 (description v3): the ★ is gone from the description too (Stremio shows the rating beside it), and line 1 holds the credits only
        const first = String(m.description || "").split("\n")[0];
        assert.ok(!first.includes("★") && !/IMDb \d|want to see|Friends \d/.test(String(m.description || "")), `${file}: ${m.name} has a star or a numbers line`);
        assert.ok(first === "" || /[.!?…]$/.test(first), `${file}: ${m.name}: "${first}" should end with a full stop (or be empty: a film with no credits, no genre and no synopsis has no text)`);
        assert.equal(m.imdbRating, e.imdbRating != null ? e.imdbRating.toFixed(1) : undefined, `${file}: ${m.name} IMDb`);
        if (!/images\.metahub\.space/.test(m.poster)) assert.equal(e.poster, m.poster, `${file}: ${m.name} cover`);
        checkedNumbers++;
        if (!counted.has(m.id)) {
          counted.add(m.id);
          const c = crowd.find({ id: m.id, title: m.name, year: Number(m.releaseInfo) });
          const same = (e.seenBy || 0) === c.seenBy && (e.wantBy || 0) === c.wantBy && (e.friendsAvg == null ? c.friendsAvg == null : c.friendsAvg != null && Math.abs(e.friendsAvg - c.friendsAvg) < 0.051);
          crowdFilms++;
          if (!same) crowdDiffer++;
        }
      }
    }
    assert.ok(crowdFilms > 2000 && crowdDiffer <= crowdFilms * 0.005, `${crowdDiffer} of ${crowdFilms} films have crowd columns that differ from the build's crowd`);
    assert.ok(checkedNumbers > 2000, `${checkedNumbers} films compared with the static files`);
    assert.ok(ix.films.filter((f) => f.seenBy > 0).length > 1000 && ix.films.filter((f) => f.imdbRating != null).length > 1000 && ix.films.filter((f) => f.friendsAvg != null).length > 500, "the crowd's and IMDb's numbers are there");
    // the guard's promise, restated on the index: nothing seen in a Board row but Old friends
    for (const [id, list] of Object.entries(ix.rows)) if (id !== "oldfriends") for (const tt of list) assert.ok(!byTt.get(tt).seen, `${tt} in ${id} is seen`);
    const v = verifyIndex(out, { forbid: [JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")).letterboxd] });
    assert.deepEqual(v.problems, []);
    assert.ok(v.stats.gzip < 4e6, `${v.stats.gzip} bytes gzipped`);
    assert.ok(v.stats.films > 5000, `${v.stats.films} films`);
    assert.ok(v.stats.board.bytes < v.stats.bytes / 4, "the Board part is a small fraction of the index");
  } finally { rm(out); rm(cache); }
});

test("build --cache-only with two raw covers on disk: the index carries the covers with the ratings drawn on them (same address as the static files), only for those films, in the whole index and in the Board part (needs Pillow)", { skip: (!fs.existsSync(path.join(ROOT, "cache", "lists.json")) && "no caches") || (spawnSync("python3", ["-c", "import PIL"]).status !== 0 && "no Pillow") }, () => {
  const out = tmp(), cache = tmp("mood-cache-");
  for (const f of ["friends.json", "lists.json", "tmdb.json", "directors.json", "imdb-ratings.json"]) fs.copyFileSync(path.join(ROOT, "cache", f), path.join(cache, f));
  const go = (o) => spawnSync(process.execPath, ["build.js", "--offline", "--cache-only", "--cache-dir", cache, "--out", o], { cwd: ROOT, encoding: "utf8", env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" } });
  try {
    assert.equal(go(out).status, 0);
    const first = JSON.parse(fs.readFileSync(path.join(out, "catalog", "movie", "watchlist.json"), "utf8")).metas.slice(0, 3).map((m) => m.id);
    fs.mkdirSync(path.join(cache, "posters-raw"), { recursive: true });
    fs.mkdirSync(path.join(cache, "posters-out"), { recursive: true });
    for (const tt of first.slice(0, 2)) assert.equal(spawnSync("python3", ["-c", `from PIL import Image; Image.new("RGB", (342, 513), (80, 90, 100)).save(${JSON.stringify(path.join(cache, "posters-raw", tt + ".jpg"))})`]).status, 0);
    const out2 = tmp();
    try {
      const r = go(out2);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const ix = decode(JSON.parse(fs.readFileSync(path.join(out2, "data", "index.json"), "utf8")));
      const board = decode(JSON.parse(fs.readFileSync(path.join(out2, "data", "index-board.json"), "utf8")));
      const covered = ix.films.filter((f) => f.poster).map((f) => f.tt).sort();
      assert.deepEqual(covered, first.slice(0, 2).sort(), "exactly the films whose cover was drawn");
      // 19/10/2026: the address carries ?v=<8 first characters of the sha256 of the JPEG that is published at it, the same in the index, in its Board part and in the static catalog
      const sha8 = (tt) => require("crypto").createHash("sha256").update(fs.readFileSync(path.join(out2, "posters", `${tt}.jpg`))).digest("hex").slice(0, 8);
      const metas = JSON.parse(fs.readFileSync(path.join(out2, "catalog", "movie", "watchlist.json"), "utf8")).metas;
      for (const tt of first.slice(0, 2)) {
        assert.equal(ix.films.find((f) => f.tt === tt).poster, `https://marcogusmao.github.io/mood-engine/posters/${tt}.jpg?v=${sha8(tt)}`);
        assert.equal(board.films.find((f) => f.tt === tt).poster, ix.films.find((f) => f.tt === tt).poster);
        assert.equal(metas.find((m) => m.id === tt).poster, ix.films.find((f) => f.tt === tt).poster, "the static addon and the index say the same address");
      }
      assert.equal(ix.films.find((f) => f.tt === first[2]).poster, undefined, "no cover drawn: the Worker uses the poster service");
      assert.deepEqual(board.films.filter((f) => f.poster).map((f) => f.tt).sort(), covered);
      assert.deepEqual(verifyIndex(out2).problems, []);
    } finally { rm(out2); }
  } finally { rm(out); rm(cache); }
});

test("index: the `country` column carries the main country when the `countries` column cannot (the plan item has one, countriesOf finds none): the By country filter is left alone, and the column is absent when it would only repeat countries[0]", () => {
  const w = world();
  const onlyOnBoard = w.plan.board.find((r) => r.id === "tonight").items.find((i) => i.id === "tt0000009");
  onlyOnBoard.countries = ["Finland"];
  const ix = buildIndex(w);
  const b = ix.films.find((f) => f.tt === "tt0000009");
  assert.equal(b.countries, undefined, "no country for the filter: the film is in no By country menu");
  assert.equal(b.country, "Finland", "and the facts line still has one");
  const alpha = ix.films.find((f) => f.tt === "tt0000001");
  assert.ok(alpha.countries.length > 0 && alpha.country === undefined, "a film whose first country is its main one has no column");
  // a main country that is among the film's countries goes first in `countries`, and then needs no column
  const w2 = world();
  w2.plan.board.find((r) => r.id === "tonight").items.find((i) => i.id === "tt0000001").countries = [alpha.countries[alpha.countries.length - 1]];
  const a2 = buildIndex(w2).films.find((f) => f.tt === "tt0000001");
  assert.equal(a2.countries[0], alpha.countries[alpha.countries.length - 1]);
  assert.equal(a2.country, undefined);
  // through the file format and back
  const back = decode(encode(ix)).films.find((f) => f.tt === "tt0000009");
  assert.equal(back.country, "Finland");
  assert.equal(ENTRY_KEYS.includes("country"), true);
});

// Marco, 22/10/2026 (questionnaire 3b, "Topsy-Turvy é british"): the first name of the `countries` column is the film's main country, TMDB's origin_country first (lib/countries.js mainCountry),
// the same country the Board's regions read. The format of the column does not change: names, the main one first, then the others in TMDB's order.
test("index: `countries` starts with the main country, TMDB's origin_country first (Topsy-Turvy: GB + US producers in English, origin GB → United Kingdom, and not United States)", () => {
  const was = { countries: TMDB[33].countries, origin: TMDB[33].origin };
  try {
    TMDB[33].countries = ["US", "GB"];
    delete TMDB[33].origin;
    assert.deepEqual(buildIndex(world()).films.find((f) => f.tt === "tt0000001").countries, ["United States", "United Kingdom"], "an English-language film with an American producer: the rule of 14/10/2026, as before");
    TMDB[33].origin = ["GB"];
    const a = buildIndex(world()).films.find((f) => f.tt === "tt0000001");
    assert.deepEqual(a.countries, ["United Kingdom", "United States"], "the origin decides; the other producer follows");
    assert.equal(a.country, undefined, "the main country heads the column, so the `country` column stays absent");
    TMDB[33].origin = ["US", "GB"];
    assert.deepEqual(buildIndex(world()).films.find((f) => f.tt === "tt0000001").countries, ["United States", "United Kingdom"], "two origins: the old rule's answer (US) because it is one of them");
    TMDB[33].origin = ["FR"];
    const fr = buildIndex(world()).films.find((f) => f.tt === "tt0000001");
    assert.deepEqual([fr.countries, fr.country], [["United States", "United Kingdom"], "France"], "an origin that is no producer cannot head the filter's column: the `country` column carries it");
    assert.deepEqual(decode(encode(buildIndex(world()))).films.find((f) => f.tt === "tt0000001").countries, ["United States", "United Kingdom"], "and the file format carries it unchanged");
    // review of 22/10/2026 (M2): a producer that was in the first two does not leave the column because the main country moved to the front (the cut is made on the production order)
    TMDB[33].countries = ["US", "SE", "GB"]; // Sweden is in no menu: the menu is the two most frequent countries of the pool (United States and France)
    TMDB[33].origin = ["GB"];
    const three = buildIndex(world()).films.find((f) => f.tt === "tt0000001");
    assert.deepEqual(three.countries, ["United Kingdom", "United States", "Sweden"], "the main country (the third producer) first, the first two producers kept: Sweden stays, so By country > Sweden still finds the film");
    assert.equal(three.country, undefined);
  } finally { Object.assign(TMDB[33], was); if (was.origin === undefined) delete TMDB[33].origin; }
});

test("factsByTt: director, runtime and main country of an index entry, for build.js to give the plan items (a static first line = the live one)", () => {
  const { factsByTt } = require("../lib/index-export");
  const m = factsByTt({ films: [{ tt: "tt1", director: "A B, C D", runtime: 90, countries: ["France", "Italy"] }, { tt: "tt2", countries: ["Italy"], country: "Finland" }, { tt: "tt3" }] });
  assert.deepEqual(m.get("tt1"), { directors: ["A B", "C D"], runtime: 90, country: "France" });
  assert.deepEqual(m.get("tt2"), { directors: null, runtime: null, country: "Finland" });
  assert.deepEqual(m.get("tt3"), { directors: null, runtime: null, country: null });
});

// ── the music rule reaches the index (Marco, 22/10/2026 ~06:40 UTC; bit 8 of the flags) ──────────

test("index: a film the music rule holds back carries `musicOut` (bit 8 of the flags), stays eligible, survives the file format, and a build with no gate writes the index it wrote before", () => {
  const plain = buildIndex(world());
  assert.ok(plain.films.every((f) => f.musicOut === undefined), "no gate (the default): no film carries the bit, the index is the one of every night so far");
  const held = buildIndex(world({ musicOut: (tt) => tt === "tt0000002" }));
  const by = Object.fromEntries(held.films.map((f) => [f.tt, f]));
  assert.equal(by.tt0000002.musicOut, true);
  assert.equal(by.tt0000002.eligible, true, "the film STAYS eligible: Search and the collections still show it");
  assert.deepEqual(held.films.filter((f) => f.musicOut).map((f) => f.tt), ["tt0000002"]);
  // the same index but for that bit
  const strip = (ix) => JSON.stringify(ix.films.map(({ musicOut, ...f }) => f));
  assert.equal(strip(held), strip(plain));
  // the file: bit 8 is in `flags`, bits 1, 2 and 4 are where they were, and decode gives the object back
  const row = encode(held).films.find((r) => r[0] === "tt0000002");
  const flags = row[COLS.indexOf("flags")];
  assert.equal(flags & 8, 8);
  assert.equal(flags & 4, 4);
  const noBit = encode(plain).films.find((r) => r[0] === "tt0000002")[COLS.indexOf("flags")];
  assert.equal(flags - 8, noBit, "the other bits are the ones of the index without the gate: an older reader sees the same eligible, seen and watchlist");
  assert.deepEqual(decode(JSON.parse(JSON.stringify(encode(held)))), held);
  // verify: the flag must be true or absent, and never on a film he has seen
  const out = tmp();
  try {
    writeIndex(out, held);
    localImages(out, held);
    assert.equal(verifyIndex(out, { forbid: ["mgusmao"] }).ok, true, verifyIndex(out).problems.join("\n"));
  } finally { rm(out); }
  // a film he has seen is never held back: the check says so (a seen film is tt0000003 in this world)
  const seen = (() => { const out3 = written((ix) => { const e = ix.films.find((f) => f.seen); e.musicOut = true; }); try { return verifyIndex(out3).problems; } finally { rm(out3); } })();
  assert.ok(seen.some((p) => /musicOut on a film marked seen/.test(p)), seen.join("\n"));
});

// ── the shorts reach the index (Marco, 15/11/2026; bit 16 of the flags) ──────────

test("index: a short carries `shortOut` (bit 16 of the flags) — a KNOWN runtime under config.json shortRow.minMinutes, the number meta.minFeatureMinutes says; it stays eligible, survives the file format, and the validator holds the bit and the runtime together", () => {
  // this world has no film under 40 minutes: the index is the one of every night so far
  const plain = buildIndex(world());
  assert.equal(plain.meta.minFeatureMinutes, 40);
  assert.ok(plain.films.every((f) => f.shortOut === undefined), "no short: no film carries the bit");
  const lengths = Object.fromEntries(plain.films.map((f) => [f.tt, f.runtime]));
  assert.deepEqual([lengths.tt0000001, lengths.tt0000009, lengths.tt0000008], [88, 77, 90], "(control: the runtimes of the world)");
  assert.ok(plain.films.some((f) => f.runtime === undefined), "(control: a film with no known runtime is in the world)");
  // the same world with the floor of a feature at 89 minutes: Alpha (88) and Only On The Board (77) are shorts, No Votes (90) and the films with no runtime are not
  const cfg89 = { ...CFG, shortRow: { ...(CFG.shortRow || {}), minMinutes: 89 } };
  const held = buildIndex(world({ cfg: cfg89, moods: compile(cfg89.moods) }));
  assert.equal(held.meta.minFeatureMinutes, 89, "the index says the number its bits were written with");
  assert.deepEqual(held.films.filter((f) => f.shortOut).map((f) => f.tt).sort(), held.films.filter((f) => typeof f.runtime === "number" && f.runtime < 89).map((f) => f.tt).sort());
  assert.deepEqual(held.films.filter((f) => f.shortOut).map((f) => f.tt).sort(), ["tt0000001", "tt0000009"]);
  for (const f of held.films) assert.equal(f.shortOut === true, P.isShort(f.runtime, 89), `${f.tt}: the bit is lib/pool.js isShort of its own runtime`);
  // "under": a film of exactly the floor is a feature. With the floor at 88, Alpha (88 minutes) is no short and Only On The Board (77) is
  const cfg88 = { ...CFG, shortRow: { ...(CFG.shortRow || {}), minMinutes: 88 } };
  assert.deepEqual(buildIndex(world({ cfg: cfg88, moods: compile(cfg88.moods) })).films.filter((f) => f.shortOut).map((f) => f.tt), ["tt0000009"]);
  const by = Object.fromEntries(held.films.map((f) => [f.tt, f]));
  assert.equal(by.tt0000001.eligible, true, "the film STAYS eligible: Search and the collections still show it");
  // the same index but for the bit and the number
  const strip = (ix) => JSON.stringify(ix.films.map(({ shortOut, ...f }) => f));
  assert.equal(strip(held), strip(plain));
  // the file: bit 16 is in `flags`, the bits an older Worker reads are where they were, and decode gives the object back
  const at = COLS.indexOf("flags");
  const flags = encode(held).films.find((r) => r[0] === "tt0000001")[at], noBit = encode(plain).films.find((r) => r[0] === "tt0000001")[at];
  assert.equal(flags & 16, 16);
  assert.equal(flags - 16, noBit, "the other bits are the ones of the index without the bit");
  assert.deepEqual(decode(JSON.parse(JSON.stringify(encode(held)))), held);
  // verify: an index whose bits and runtimes agree passes
  const write = (ix) => { const out = tmp(); writeIndex(out, ix); localImages(out, ix); try { return verifyIndex(out, { forbid: ["mgusmao"] }); } finally { rm(out); } };
  assert.equal(write(held).ok, true, write(held).problems.join("\n"));
  assert.equal(write(plain).ok, true);
  // the BUILD's own conference (15/11/2026, review): the validator accepts an index with no bit at all, by design (an index of before the bit), so a build that stopped writing the bit would pass it.
  // writeIndex refuses the index it is about to write when a film is under the floor the index says and not one film carries the mark
  const unmarked = { ...held, films: held.films.map(({ shortOut, ...f }) => f) };
  assert.doesNotThrow(() => require("../lib/index-validation").validateIndex(unmarked), "(control: the validator of what is READ accepts it)");
  assert.throws(() => write(unmarked), /^Error: index: 2 film\(s\) have a known runtime under 89 minutes and not one carries the short mark \(shortOut, bit 16 of the flags\): the build did not write it \(the first: tt0000001 Alpha, 88 min\)$/);
  assert.throws(() => assertShortsMarked(unmarked), /not one carries the short mark/);
  assert.doesNotThrow(() => assertShortsMarked(held));
  assert.doesNotThrow(() => assertShortsMarked(plain), "an index with no film under the floor has nothing to mark");
  assert.doesNotThrow(() => assertShortsMarked({ ...unmarked, meta: { ...unmarked.meta, minFeatureMinutes: 40 } }), "the floor is the index's own number: at 40 these two films are features");
  // the validator (lib/index-validation.js checkIndex, through verify.js as the build runs it): the bit on a feature, a short without the bit beside a short with it, and the bit on a film with no known runtime are refused;
  // no bit at all (an index from before 15/11/2026, shorts and all) is accepted
  const told = (change) => problems((ix) => { ix.films.find((f) => f.tt === "tt0000001").runtime = 20; ix.films.find((f) => f.tt === "tt0000001").shortOut = true; change(ix); }).split("\n").filter((p) => /shortOut/.test(p));
  assert.deepEqual(told(() => {}), [], "a short of 20 minutes with the bit: nothing to say");
  assert.ok(told((ix) => { ix.films.find((f) => f.tt === "tt0000008").shortOut = true; }).some((p) => /tt0000008.*shortOut is true but the runtime is 90/.test(p)), "the bit on a film of 90 minutes");
  assert.ok(told((ix) => { ix.films.find((f) => f.tt === "tt0000008").runtime = 12; }).some((p) => /tt0000008.*shortOut is false but the runtime is 12/.test(p)), "a short with no bit, in an index that marks its shorts");
  assert.ok(told((ix) => { ix.films.find((f) => f.runtime === undefined).shortOut = true; }).some((p) => /shortOut is true but the runtime is unknown/.test(p)), "the bit on a film with no known runtime");
  assert.deepEqual(problems((ix) => { ix.films.find((f) => f.tt === "tt0000001").runtime = 20; }).split("\n").filter((p) => /shortOut/.test(p)), [], "a short and not one bit in the whole index: an index from before, accepted as it was");
});

// ── the mood exempt from the music rule reaches the index (Marco, 22/10/2026 ~15:15 UTC, "Music 1 of 4"; rules.musicExemptMoods) ──────────

test("index: `rules.musicExemptMoods` names the moods whose Moods-menu option ignores the music rule's bit; it is written only when a mood is exempt, survives the file format, and leaves every film as it was", () => {
  const plain = buildIndex(world());
  assert.equal(Object.hasOwn(plain.rules, "musicExemptMoods"), false, "no exemption (the default): the rules are the ones of every night so far");
  assert.equal(Object.hasOwn(buildIndex(world({ musicExemptMoods: [] })).rules, "musicExemptMoods"), false, "an empty list writes no key either");
  const exempt = buildIndex(world({ musicExemptMoods: ["night"], musicOut: (tt) => tt === "tt0000002" }));
  assert.deepEqual(exempt.rules.musicExemptMoods, ["night"]);
  // regression 22/10/2026: test/special-rows.test.js built with a rehearsal board whose menu has no `music`, and the build stopped with "names \"music\", which is no mood of this index"; the index names only the exempt moods it lists
  assert.deepEqual(buildIndex(world({ musicExemptMoods: ["night", "music"] })).rules.musicExemptMoods, ["night"]);
  assert.equal(Object.hasOwn(buildIndex(world({ musicExemptMoods: ["music"] })).rules, "musicExemptMoods"), false, "none of them listed: no key");
  assert.deepEqual({ ...exempt.rules, musicExemptMoods: undefined }, { ...plain.rules, musicExemptMoods: undefined }, "the rest of the rules is untouched");
  assert.equal(exempt.films.find((f) => f.tt === "tt0000002").musicOut, true, "the bit is still written: the exemption is the Worker's reading of the mood, not a film that stops being held back");
  assert.deepEqual(decode(JSON.parse(JSON.stringify(encode(exempt)))).rules, exempt.rules);
  assert.equal(problems(undefined, undefined, (ix) => { ix.rules.musicExemptMoods = ["night"]; }), "", "and the checker accepts it in the index and in every piece");
});

test("verifyIndex: rules.musicExemptMoods must be a non-empty list of different mood ids that the file lists, the same in every piece", () => {
  const set = (v) => (ix) => { ix.rules.musicExemptMoods = v; };
  for (const bad of [[], "night", [1], ["a b"], ["night", "night"], null]) assert.match(problems(undefined, undefined, set(bad)), /rules\.musicExemptMoods must be a non-empty list of different mood ids/, JSON.stringify(bad));
  assert.match(problems(undefined, undefined, set(["nope"])), /rules\.musicExemptMoods names "nope", which is no mood of this index/);
  assert.match(problems((ix, b, parts) => { parts.moods.obj.rules = { ...parts.moods.obj.rules, musicExemptMoods: ["night"] }; }, undefined, set(undefined)), /index-moods: rules differs from index/, "a piece that disagrees with the index is named");
});

// Marco, 22/10/2026 ~19:30 UTC: the Beyond the Sight & Sound A-List is shown by Letterboxd average, highest first (config.json lists[].order "rating"); the other lists keep the source's order.
// Defects guarded: the static files ordered and the Worker not (or the other way round: the index keeps the position the list is SHOWN in, lib/pool.js listSequence), a film with no average on top,
// another list reordered by accident. The static files and the Worker (worker/src/catalogs.js, through the index that writeIndex puts on disk) must give the same films in the same order.
test("list order: the static Lists files and the Worker show a list with `order: \"rating\"` by Letterboxd average, highest first, no average last; a list with no `order` is untouched in both", async () => {
  const lbf = (n, r) => film(`tt000010${n}`, `Rated ${n}`, 1950 + Number(n), { ...(r === undefined ? {} : { r }), rt: 90, c: ["USA"] });
  const films = { ...FILMS, g1: lbf("1", 3.2), g2: lbf("2"), g3: lbf("3", 4.6), g4: lbf("4", 4.0), g5: lbf("5"), g6: lbf("6", 4.6), g7: lbf("7", 3.9) };
  const items = ["g1", "g2", "g3", "not-looked-up", "g4", "g5", "g6", "g7"].map((slug) => ({ slug }));
  const rated = { id: "RT", name: "Rated list (someone)", short: "Rated list", order: "rating", popular: false, items };
  const plain = { id: "SRC", name: "Source order (someone)", short: "Source order", popular: false, items };
  const mine = (r) => r.slug === "g4";
  const ix = buildIndex(world({ view: { ...VIEW, films }, lists: [...LISTS, rated, plain], isSeen: (r) => r.slug === "seenlist" || mine(r) }));
  const out = tmp();
  try {
    writeIndex(out, ix);
    const { parseIndex } = await import("../worker/src/store.js");
    const { select } = await import("../worker/src/catalogs.js");
    const { parseExtras } = await import("../worker/src/extras.js");
    const live = parseIndex(fs.readFileSync(path.join(out, "data", "index.json"), "utf8"));
    const worker = (id, short) => select(live, id, parseExtras(`genre=${encodeURIComponent(short)}`)).entries.map((e) => e.tt);
    const lc = Object.fromEntries(P.listCatalogs({ lists: [...LISTS, rated, plain], view: { films }, isSeen: (r) => r.slug === "seenlist" || mine(r), size: Infinity }).map((l) => [l.id, l]));
    const ratedAll = ["tt0000103", "tt0000106", "tt0000104", "tt0000107", "tt0000101", "tt0000102", "tt0000105"];
    assert.deepEqual(lc.RT.all.map((x) => x.id), ratedAll, "static, All: 4.6, 4.6 (source order), 4.0, 3.9, 3.2, then no average in the source's order");
    assert.deepEqual(worker("lists", "Rated list"), ratedAll, "the Worker, Lists: the same films in the same order");
    assert.deepEqual(lc.RT.unseen.map((x) => x.id), ratedAll.filter((t) => t !== "tt0000104"), "static, Unseen");
    assert.deepEqual(worker("lists-unseen", "Rated list"), ratedAll.filter((t) => t !== "tt0000104"), "the Worker, Lists (unseen)");
    const srcAll = ["tt0000101", "tt0000102", "tt0000103", "tt0000104", "tt0000105", "tt0000106", "tt0000107"];
    assert.deepEqual(lc.SRC.all.map((x) => x.id), srcAll, "a list with no `order`: the source's order, static");
    assert.deepEqual(worker("lists", "Source order"), srcAll, "a list with no `order`: the source's order, Worker");
    assert.deepEqual(lc.L1.all.map((x) => x.id), ["tt0000003", "tt0000001", "tt0000002"], "the other lists of the fixture keep the curator's order, static");
    assert.deepEqual(worker("lists", "First (curator)"), ["tt0000003", "tt0000001", "tt0000002"], "and the Worker");
  } finally { rm(out); }
});

// Review of 22/10/2026 (second round): a film twice in a list (two slugs, one IMDb id) had no test; 0 repetitions in the 140 lists read today, the gap was already there before `order`. The rule is "the first
// place wins" and, in a list with `order`, the first place IN THE ORDER SHOWN: the static files (lib/pool.js listCatalogs, `tts`) and the index (lib/index-export.js, `!(l.id in s.lists)`) must keep the same one,
// so the Worker and the files agree. Defect guarded: either side keeping the other occurrence (here the 4.8 one of the ordered list, the first of the source in the plain one).
test("list order: a film twice in the source keeps its first place in the order shown, in the static files and in the Worker alike", async () => {
  const lbf = (n, r) => film(`tt000011${n}`, `Twice ${n}`, 1960 + Number(n), { ...(r === undefined ? {} : { r }), rt: 90, c: ["USA"] });
  // h1 and h1b are the SAME film (one IMDb id) under two slugs, with different averages
  const films = { ...FILMS, h1: lbf("1", 3.0), h2: lbf("2", 4.0), h1b: { ...lbf("1", 4.8) }, h3: lbf("3") };
  const rated = { id: "DR", name: "Twice rated (someone)", short: "Twice rated", order: "rating", popular: false, items: ["h1", "h2", "h1b", "h3"].map((slug) => ({ slug })) };
  const plain = { id: "DP", name: "Twice plain (someone)", short: "Twice plain", popular: false, items: ["h2", "h1", "h1b", "h3"].map((slug) => ({ slug })) };
  const ix = buildIndex(world({ view: { ...VIEW, films }, lists: [...LISTS, rated, plain] }));
  const out = tmp();
  try {
    writeIndex(out, ix);
    const { parseIndex } = await import("../worker/src/store.js");
    const { select } = await import("../worker/src/catalogs.js");
    const { parseExtras } = await import("../worker/src/extras.js");
    const live = parseIndex(fs.readFileSync(path.join(out, "data", "index.json"), "utf8"));
    const worker = (short) => select(live, "lists", parseExtras(`genre=${encodeURIComponent(short)}`)).entries.map((e) => e.tt);
    const lc = Object.fromEntries(P.listCatalogs({ lists: [rated, plain], view: { films }, isSeen: () => false, size: Infinity }).map((l) => [l.id, l]));
    // ordered: h1b (4.8) is first in the order shown, so the film is at the top; h1 (3.0) is the repetition and is dropped
    assert.deepEqual(lc.DR.all.map((x) => x.id), ["tt0000111", "tt0000112", "tt0000113"]);
    assert.deepEqual(worker("Twice rated"), ["tt0000111", "tt0000112", "tt0000113"]);
    assert.equal(lc.DR.stats.dup, 1);
    // plain: h2 first, then h1 (the first occurrence of the film), h1b dropped
    assert.deepEqual(lc.DP.all.map((x) => x.id), ["tt0000112", "tt0000111", "tt0000113"]);
    assert.deepEqual(worker("Twice plain"), ["tt0000112", "tt0000111", "tt0000113"]);
    assert.equal(lc.DP.stats.dup, 1);
  } finally { rm(out); }
});
