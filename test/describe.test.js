// node --test            (no dependencies)
// The description Stremio shows under a film (lib/describe.js). Marco, 20/10/2026 ("description v3"): a card of two lines (credits, mood), each ended by a full stop,
// ONE blank line, the synopsis. It replaces the card of 13/10/2026 (facts, cast, reason): on the TV only the first line and a half of the description appear.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const D = require("../lib/describe");
const SRC = require("../lib/synopsis-source");
const MC = require("../lib/mubi-cache");
const P = require("../lib/pool");
const Q = require("../lib/recommendation-quality");
const { toMeta, publish } = require("../lib/publish");
const { buildRows } = require("../lib/rows");
const { compile } = require("../lib/moods");
const { reasons } = require("../lib/taste");
const { buildPlan } = require("../lib/plan");

const R = (o = {}) => ({ lb: null, imdb: null, friendsAvg: null, seenBy: 0, wantBy: 0, ...o });


// ── line 1: the credits ──────────────────────────────────────────────────────

const KUROSAWA = { directors: ["Akira Kurosawa"], runtime: 142, cast: ["Toshirō Mifune", "Tatsuya Nakadai", "Kyōko Kagawa", "Tsutomu Yamazaki"] };

test("credits line: director · duration · three actors, ended by a full stop — no country, no year, no ★ (Marco's example, High and Low)", () => {
  assert.equal(D.creditsLine(KUROSAWA), "Akira Kurosawa · 2h22 · Toshirō Mifune, Tatsuya Nakadai, Kyōko Kagawa.");
  assert.equal(D.creditsLine({ directors: ["Joel Coen", "Ethan Coen", "A Third One"], runtime: 98, cast: ["Frances McDormand"] }), "Joel Coen, Ethan Coen · 1h38 · Frances McDormand.", "two directors at most, whole names");
  assert.equal(D.creditsLine({ ...KUROSAWA, runtime: 93 }), "Akira Kurosawa · 1h33 · Toshirō Mifune, Tatsuya Nakadai, Kyōko Kagawa.");
});

test("credits line: only what exists, in the same order; nothing at all is an empty line", () => {
  assert.equal(D.creditsLine({ directors: ["Akira Kurosawa"], runtime: 142 }), "Akira Kurosawa · 2h22.");
  assert.equal(D.creditsLine({ directors: ["Akira Kurosawa"], cast: ["Toshirō Mifune"] }), "Akira Kurosawa · Toshirō Mifune.");
  assert.equal(D.creditsLine({ runtime: 142, cast: ["Toshirō Mifune", "Tatsuya Nakadai"] }), "2h22 · Toshirō Mifune, Tatsuya Nakadai.");
  assert.equal(D.creditsLine({ cast: ["Toshirō Mifune"] }), "Toshirō Mifune.");
  assert.equal(D.creditsLine({ directors: ["", "  "], runtime: 0, cast: [null, ""] }), "");
  assert.equal(D.creditsLine({}), "");
  assert.equal(D.creditsLine(), "");
  assert.equal(D.creditsLine({ cast: ["Elisha Cook Jr."] }), "Elisha Cook Jr.", "a name that already ends in a full stop gets no second one");
});

// Regression guard of the 80-character cut (Marco, 20/10/2026) and of its limit (Marco, 21/10/2026 ~15:00 UTC, D4): without the cut a long line stays at three actors and runs past the first line and a half of the TV;
// without the floor of two the cut went on to ONE actor (39 films of the index of 21/10/2026 had two or three actors in the cast and showed one; the 38 of the questionnaire was the count of the review of 3a1d497, not rechecked then; 39 measured on 21/10/2026).
test("credits line: more than 80 characters (the full stop counted) loses the third actor and only the third; two stay whatever the length; the director and the duration are never cut", () => {
  const long = { directors: ["Apichatpong Weerasethakul"], runtime: 114, cast: ["Thanapat Saisaymar", "Jenjira Pongpas", "Sakda Kaewbuadee"] };
  const three = "Apichatpong Weerasethakul · 1h54 · Thanapat Saisaymar, Jenjira Pongpas, Sakda Kaewbuadee.";
  assert.ok(three.length > 80, String(three.length));
  assert.equal(D.creditsLine(long), "Apichatpong Weerasethakul · 1h54 · Thanapat Saisaymar, Jenjira Pongpas.", "two actors");
  const exact = { directors: ["Akira Kurosawa"], runtime: 142, cast: ["A".repeat(10), "B".repeat(10), "C".repeat(31)] };
  const full = "Akira Kurosawa · 2h22 · " + ["A".repeat(10), "B".repeat(10), "C".repeat(31)].join(", ") + ".";
  assert.equal(full.length, 80);
  assert.equal(D.creditsLine(exact), full, "exactly 80 is kept");
  assert.equal(D.creditsLine({ ...exact, cast: [exact.cast[0], exact.cast[1], "C".repeat(32)] }), "Akira Kurosawa · 2h22 · " + exact.cast.slice(0, 2).join(", ") + ".", "81 loses the third");
  const wide = { directors: ["Rainer Werner Fassbinder", "Alexander Kluge"], runtime: 187, cast: ["Hanna Schygulla Eleonore", "Irm Hermann Maria Louise", "Margit Carstensen Leopoldine"] };
  const wideLine = D.creditsLine(wide);
  assert.equal(wideLine, "Rainer Werner Fassbinder, Alexander Kluge · 3h07 · Hanna Schygulla Eleonore, Irm Hermann Maria Louise.", "two actors, even though the line is longer than 80");
  assert.ok(wideLine.length > 80, String(wideLine.length));
  const huge = D.creditsLine({ directors: ["D".repeat(60), "E".repeat(30)], runtime: 100, cast: ["X Y", "Z W", "Q R"] });
  assert.equal(huge, "D".repeat(60) + ", " + "E".repeat(30) + " · 1h40 · X Y, Z W.", "a director that fills the line: the director and the duration are not cut, the two actors stay, the third goes");
  assert.equal(D.creditsLine({ directors: ["D".repeat(100)], cast: ["X Y"] }), "D".repeat(100) + " · X Y.", "one actor in the cast: one actor");
  assert.equal(D.creditsLine({ directors: ["D".repeat(100)], cast: ["X Y", "Z W"] }), "D".repeat(100) + " · X Y, Z W.", "two actors in the cast: both, however long the director");
  assert.equal(D.CREDITS_CHARS, 80);
  assert.equal(D.CAST_MIN, 2);
});

// Review of 21/10/2026 (cartao-x-decisoes and guard-worker-prosa): the docs said 38 films "showed one actor" and 39 lines passed 80 characters, two numbers for ONE set. By construction they are the same films: the old rule
// (cut to one actor) shows one actor for a film with two or three in the cast exactly when the line with TWO actors is longer than 80, and the new rule (CAST_MIN = 2) keeps those two. The sweep below counts both sides over
// directors, durations and casts of every length and demands the same films; with CAST_MIN = 1 the new rule shows one actor again and the second count is 0.
test("credits line (D4): the films that showed ONE actor under the old cut are exactly the films whose two-actor line is longer than 80 characters now", () => {
  const OLD_CHARS = 80;
  const oldActors = (f) => { // the rule until 21/10/2026: the finished line, longer than 80, loses actors one by one down to ONE
    const names = f.cast.slice(0, 3);
    for (let n = names.length; n > 1; n--) if (D.creditsLine({ ...f, cast: names.slice(0, n) }).length <= OLD_CHARS) return n;
    return 1;
  };
  let showedOne = 0, nowOver80 = 0, films = 0;
  for (const dir of [0, 10, 24, 40, 60]) for (const run of [0, 107, 187]) for (const a of [5, 11, 17, 25]) for (const c of [5, 17, 30]) for (const cast of [[], ["A".repeat(a)], ["A".repeat(a), "B".repeat(a)], ["A".repeat(a), "B".repeat(a), "C".repeat(c)]]) {
    const f = { directors: dir ? ["D".repeat(dir)] : [], runtime: run, cast };
    const line = D.creditsLine(f);
    if (cast.length < 2) { assert.equal(oldActors(f), cast.length || 1, "a cast of 0 or 1 is not a film that lost an actor"); continue; }
    films++;
    const was = oldActors(f);
    if (was === 1) showedOne++;
    if (line.length > OLD_CHARS) { nowOver80++; assert.equal(was, 1, JSON.stringify(f) + ": over 80 with two actors means the old rule showed one"); }
    else assert.ok(was >= 2, JSON.stringify(f) + ": within 80 the old rule kept two or three");
    assert.ok(cast.slice(0, 2).every((x) => line.includes(x)), JSON.stringify(f) + ": both of the first two stay");
  }
  assert.ok(films > 100 && showedOne > 0, `${films} films with two or more actors, ${showedOne} lost an actor under the old rule`);
  assert.equal(nowOver80, showedOne, "the same films");
});

test("duration: 1h47, 2h00, 52m; nothing for zero, negative or unknown", () => {
  assert.equal(D.duration(107), "1h47");
  assert.equal(D.duration(120), "2h00");
  assert.equal(D.duration(60), "1h00");
  assert.equal(D.duration(61), "1h01");
  assert.equal(D.duration(52), "52m");
  assert.equal(D.duration(1), "1m");
  assert.equal(D.duration(59.6), "1h00", "rounded to the minute first");
  for (const v of [0, -5, null, undefined, "", "x", NaN]) assert.equal(D.duration(v), "", String(v));
});

test("the main country is the one that speaks the film's language, in English (I Vitelloni is Italian, not French); else TMDB's first; the Letterboxd page when TMDB has none", () => {
  assert.deepEqual(P.cardFacts({ countries: ["FR", "IT"], lang: "it", cast: [] }).countries, ["Italy", "France"]);
  assert.deepEqual(P.cardFacts({ countries: ["FR", "DE", "PL", "GB"], lang: "en" }).countries, ["United Kingdom", "France", "Germany", "Poland"].slice(0, 2));
  assert.deepEqual(P.cardFacts({ countries: ["US", "JP"], lang: "xx" }).countries, ["United States", "Japan"], "no usable language: TMDB's order");
  assert.deepEqual(P.cardFacts({ countries: ["US", "JP"] }).countries, ["United States", "Japan"]);
  assert.deepEqual(P.cardFacts({ countries: ["SU"], lang: "ru" }).countries, ["Soviet Union"], "a country that no longer exists keeps its name");
  assert.deepEqual(P.cardFacts({ countries: [] }, ["USA", "Japan"]).countries, ["United States", "Japan"], "Letterboxd's names");
  assert.deepEqual(P.cardFacts(null).countries, []);
  assert.deepEqual(P.cardFacts({ countries: ["US", "FR", "DE"] }).countries.length, 2, "two at most");
});

// ── the cast ────────────────────────────────────────────────────

const CAST6 = ["Sterling Hayden", "Coleen Gray", "Vince Edwards", "Jay C. Flippen", "Marie Windsor", "Elisha Cook Jr."];

test("cast line (the live `desc`): the first three names, joined by CAST_SEP ('; ', because a name can hold ', '); fewer when there are fewer; nothing when there are none", () => {
  assert.equal(D.castLine(CAST6), "Sterling Hayden; Coleen Gray; Vince Edwards");
  assert.equal(D.castLine(["Henry Louis Gates, Jr.", "Tyler, The Creator"]), "Henry Louis Gates, Jr.; Tyler, The Creator", "a name with a comma stays whole");
  assert.equal(D.CAST_SEP, "; ");
  assert.equal(D.castLine(CAST6.slice(0, 2)), "Sterling Hayden; Coleen Gray");
  assert.equal(D.castLine(["Only One"]), "Only One");
  assert.equal(D.castLine([]), "");
  assert.equal(D.castLine(undefined), "");
  assert.equal(D.castLine([null, "", "  ", "Real Name"]), "Real Name");
  assert.equal(D.castLine(["", "", "", "", "", "Sixth"]), "Sixth", "blank names do not take a place among the three");
});

test("the items of a TMDB record carry its first five cast names (not ids; the description shows three) and its countries", () => {
  const d = { countries: ["US"], lang: "en", cast: CAST6.map((name, id) => ({ id, name })) };
  assert.deepEqual(P.cardFacts(d).cast, CAST6.slice(0, 5));
  assert.deepEqual(P.cardFacts({ countries: ["US"] }).cast, []);
});

// ── line 2: the mood, the genres, the keywords ───────────────────────────────

const NIGHT = { mood: "🌃 Night drive", genres: ["Crime", "Thriller", "Mystery", "Drama"], keywords: ["investigation", "anxious", "film noir", "tense"] };

test("mood line: 'Mood: <mood> · three genres · three keywords', ended by a full stop; the groups are separated by ' · ', the items by ', ' (Marco's example)", () => {
  assert.equal(D.moodLine(NIGHT), "Mood: 🌃 Night drive · Crime, Thriller, Mystery · Investigation, Anxious, Film noir.");
  assert.equal(D.moodLine({ ...NIGHT, keywords: [] }), "Mood: 🌃 Night drive · Crime, Thriller, Mystery.", "no keywords: the mood and the genres");
  assert.equal(D.moodLine({ ...NIGHT, keywords: undefined }), "Mood: 🌃 Night drive · Crime, Thriller, Mystery.");
  assert.equal(D.moodLine({ ...NIGHT, genres: [] }), "Mood: 🌃 Night drive · Investigation, Anxious, Film noir.");
  assert.equal(D.moodLine(NIGHT, 4), "Mood: 🌃 Night drive · Crime, Thriller, Mystery · Investigation, Anxious, Film noir, Tense.", "the live `desc` keeps four words (the Moods menu may drop one)");
  assert.equal(D.moodLine({ mood: "🌃 Night drive" }), "Mood: 🌃 Night drive.", "a mood and nothing else");
});

test("mood line: Tonight shows the mood it was drawn for; a row that is not a mood (or an item with no mood) and an item with no `fitMood` start with the genres, no label", () => {
  assert.equal(D.moodLine({ ...NIGHT, mood: "Tonight · ☀️ Lift me out" }), "Mood: ☀️ Lift me out · Crime, Thriller, Mystery · Investigation, Anxious, Film noir.");
  assert.equal(D.moodLine({ ...NIGHT, mood: "👥 Friends loved, you haven't seen", moodIsRow: true }), "Crime, Thriller, Mystery · Investigation, Anxious, Film noir.", "a row's name is not a mood");
  assert.equal(D.moodLine({ ...NIGHT, mood: undefined }), "Crime, Thriller, Mystery · Investigation, Anxious, Film noir.");
  assert.equal(D.moodLine({ ...NIGHT, mood: "  " }), "Crime, Thriller, Mystery · Investigation, Anxious, Film noir.");
  assert.equal(D.moodLine({ genres: ["Drama"] }), "Drama.");
  assert.equal(D.moodLine({}), "");
  assert.equal(D.moodOf({ mood: "Tonight · 🌃 Night drive" }), "🌃 Night drive");
  assert.equal(D.moodOf({ mood: "Night drive", moodIsRow: true }), "");
});

// Regression guard of the dedupe (Marco's review of 20/10/2026, finding 2): without it "noir" sits beside "film noir" and "neo-noir" (191 + 141 films of 4,735), "concert" beside "concert film" (62),
// and the Noir row says "Noir" twice (the mood and a word: 282 of 11,229 film-mood pairs).
test("mood words: a word inside a longer one goes (the more specific stays), whole words only; the word that IS the row's mood is skipped; the next words fill the three places", () => {
  assert.deepEqual(D.wordsForDesc(["noir", "film noir", "anxious", "tense", "dark"]), ["film noir", "anxious", "tense", "dark"], "noir is inside film noir; four are kept");
  assert.deepEqual(D.wordsForDesc(["film noir", "noir", "anxious"]), ["film noir", "anxious"], "the shorter word after the longer one goes too");
  assert.deepEqual(D.wordsForDesc(["noir", "neo-noir", "concert", "concert film", "anxious"]), ["neo-noir", "concert film", "anxious"]);
  assert.deepEqual(D.wordsForDesc(["art", "party", "love", "glove", "love"]), ["art", "party", "love", "glove"], "'art' is not inside 'party': whole words only; a word twice is once");
  assert.deepEqual(D.wordsForDesc(["a", "b", "c", "d", "e", "f"]), ["a", "b", "c", "d"], "four are kept");
  assert.deepEqual(D.wordsForDesc(undefined), []);
  assert.deepEqual(D.pickWords(["noir", "anxious", "tense", "dark"], "🌃 Noir"), ["anxious", "tense", "dark"], "the Noir row does not say noir; the fourth word fills the place");
  assert.deepEqual(D.pickWords(["Love stories", "anxious"], "💘 Love stories"), ["anxious"], "no capitals, no emoji in the comparison");
  assert.deepEqual(D.pickWords(["noir", "anxious", "tense", "dark"], "Tonight · 🌃 Noir"), ["anxious", "tense", "dark"], "Tonight's own prefix is not part of the name");
  assert.deepEqual(D.pickWords(["noir", "anxious", "tense", "dark"], ""), ["noir", "anxious", "tense"], "a row with no mood: the first three");
  assert.equal(D.moodLine({ mood: "🌃 Noir", genres: ["Crime"], keywords: ["noir", "anxious", "tense", "dark"] }), "Mood: 🌃 Noir · Crime · Anxious, Tense, Dark.");
  assert.equal(D.moodLine({ genres: ["Crime"], keywords: ["film noir", "tense"] }), "Crime · Film noir, Tense.", "an initial capital, the rest as it is");
});

// Regression guard of the review of the description v3, 21/10/2026 (finding "pickWords repeats a genre"): with the 30 moods the vocabulary has "romance" (the mood Swoon), which is also the TMDB genre, so
// 97 films of the legacy index and 77 distinct cards of the static catalogs said "Drama, Romance · Romance, Mother daughter relationship." Nothing caught it: the nine legacy moods have no such word.
test("mood words: a word that is one of the genres shown on the same line goes (before the cut to three, and before the cut to four of the live `desc`), whole and with no capitals; a genre beyond the third is not shown, so its word stays", () => {
  assert.deepEqual(D.pickWords(["romance", "mother daughter relationship", "tender"], "", 3, ["Drama", "Romance"]), ["mother daughter relationship", "tender"]);
  assert.deepEqual(D.pickWords(["Romance", "Tender", "Sad", "Lonely"], "💘 Swoon", 3, ["Romance"]), ["Tender", "Sad", "Lonely"], "the spare word fills the place");
  assert.deepEqual(D.pickWords(["romance", "tender"], "", 3, ["Drama", "Comedy", "War", "Romance"]), ["romance", "tender"], "the fourth genre is not on the line");
  assert.deepEqual(D.pickWords(["science fiction", "tender"], "", 3, ["Science Fiction"]), ["tender"], "letters and digits compared, as for the mood's own name");
  assert.deepEqual(D.pickWords(["romance", "tender"], ""), ["romance", "tender"], "no genres given: as before");
  assert.deepEqual(D.wordsForDesc(["romance", "a", "b", "c", "d"], 4, ["Drama", "Romance"]), ["a", "b", "c", "d"], "the live desc keeps four AFTER the genre's word went");
  assert.deepEqual(D.wordsForDesc(["romance", "a"]), ["romance", "a"], "no genres given: as before");
  assert.equal(D.moodLine({ mood: "🌧️ Let it in", genres: ["Drama", "Romance"], keywords: ["romance", "mother daughter relationship"] }), "Mood: 🌧️ Let it in · Drama, Romance · Mother daughter relationship.");
  assert.equal(D.moodLine({ genres: ["Romance"], keywords: ["romance"] }), "Romance.", "nothing left of the third group: no empty group, no dangling separator");
});

// Marco, 20/10/2026 20:40 UTC: in the rows whose meaning is the reason, line 2 starts with it instead of "Mood:".
test("reason rows: 'Loved by your directors' and 'Friends loved' start line 2 with the reason (the director's love up to its first ' · '), in place of 'Mood:'", () => {
  const loved = { moodIsRow: true, leadsWithReason: true, loved: "Loved by Lynch and Scorsese · interview (2022), Sight & Sound 2022 ballot", why: ["you rate black and white films 4.6★"], genres: ["Drama", "Crime"], keywords: ["investigation", "anxious"] };
  assert.equal(D.moodLine(loved), "Loved by Lynch and Scorsese · Drama, Crime · Investigation, Anxious.");
  assert.equal(D.reasonLead(loved), "Loved by Lynch and Scorsese");
  const friends = { moodIsRow: true, leadsWithReason: "loved", mood: "👥 Friends loved", why: ["loved by Ana 5★ · Bo 4.5★", "you rate X"], genres: ["Drama"], keywords: [] };
  assert.equal(D.moodLine(friends), "Loved by Ana 5★ and Bo 4.5★ · Drama.", "two friends and nobody left over: 'A and B', the capital of the directors' line (D2, 21/10/2026)");
  assert.equal(D.moodLine({ ...friends, leadsWithReason: true }), "Loved by Ana 5★ and Bo 4.5★ · Drama.", "`true` is the old value of the flag: the same reading");
  assert.equal(D.moodLine({ ...friends, why: ["loved by a friend 5★ · Cacau 5★ · dylan gelula 5★"] }), "Loved by a friend 5★, Cacau 5★ +1 more · Drama.", "three friends: the first two and '+1 more' (Marco's example)");
  assert.equal(D.moodLine({ ...friends, why: ["loved by a friend 5★ · Cacau 5★ · dylan gelula 5★ · +14 more"] }), "Loved by a friend 5★, Cacau 5★ +15 more · Drama.", "a long list of friends: the people the line does not name are counted, the 14 of the row's text and the third");
  assert.equal(D.moodLine({ ...friends, why: ["loved by Ana 5★"] }), "Loved by Ana 5★ · Drama.", "one friend");
  assert.equal(D.moodLine({ ...friends, leadsWithReason: undefined }), "Drama.", "any other row keeps its reasons out");
  assert.equal(D.moodLine({ ...friends, why: [] }), "Drama.", "a reason row whose item has no reason: the genres");
  assert.equal(D.moodLine({ ...loved, loved: undefined, why: [] }), "Drama, Crime · Investigation, Anxious.");
});

// Marco, 21/10/2026 ~15:00 UTC (D2): "Loved by" with a capital and "+N more" in BOTH families, from ONE function.
test("loved by: one function writes the directors' line and the friends' lead — capital 'Loved by', 'A and B' when nobody is left out, 'A, B +N more' when somebody is", () => {
  const { lovedBy, peopleLine } = require("../lib/loved-by");
  assert.equal(lovedBy(["Lynch"]), "Loved by Lynch");
  assert.equal(lovedBy(["Lynch", "Scorsese"]), "Loved by Lynch and Scorsese");
  assert.equal(lovedBy(["Lynch", "Scorsese", "Almodóvar"]), "Loved by Lynch, Scorsese and Almodóvar");
  assert.equal(lovedBy(["Lynch", "Scorsese", "Almodóvar"], 4), "Loved by Lynch, Scorsese, Almodóvar +4 more");
  assert.equal(lovedBy(["a friend 5★", "Cacau 5★"], 1), "Loved by a friend 5★, Cacau 5★ +1 more", "the shape of Marco's example");
  assert.equal(lovedBy([]), "");
  assert.equal(peopleLine("Watched this week by", ["Bia 4.5★"], 3), "Watched this week by Bia 4.5★ +3 more");
  // the directors' own line (lib/directors-loved.js) goes through the same function: its text did not change
  const DL = require("../lib/directors-loved");
  const lover = (label, kind = "interview") => ({ name: label, label, sources: [{ kind, confidence: "high" }] });
  const three = DL.lovedLine({ lovers: [lover("Lynch"), lover("Scorsese"), lover("Almodóvar")] });
  assert.equal(three.split(" · ")[0], "Loved by Lynch, Scorsese and Almodóvar");
  const many = DL.lovedLine({ lovers: ["A", "B", "C", "D", "E"].map((n) => lover(n)) });
  assert.equal(many.split(" · ")[0], "Loved by A, B, C +2 more");
  // the friends' lead and the directors' line agree on the words for the same people
  const friendsLead = D.reasonLead({ leadsWithReason: "loved", why: ["loved by A · B · C · D · E"] });
  assert.equal(friendsLead, "Loved by A, B +3 more");
  assert.ok(/^Loved by /.test(many.split(" · ")[0]) && /^Loved by /.test(friendsLead), "the same capital");
});

// Marco, 21/10/2026 ~15:00 UTC (D1): the reason opens line 2 in seven more rows. The wording of each is the session's.
test("reason rows (D1): Friend's top picks, Friends can't agree, Friends want to see this too, Friends watched this month and this week, the prize row and Actor of the week open line 2 with their reason", () => {
  const base = { moodIsRow: true, genres: ["Drama", "Crime"], keywords: ["investigation", "anxious"] };
  const line = (kind, why) => D.moodLine({ ...base, leadsWithReason: kind, why });
  assert.equal(line("pick", ["William 4.5★"]), "Loved by William 4.5★ · Drama, Crime · Investigation, Anxious.");
  assert.equal(line("pick", ["Gustavo 5★ · profile favourite", "x"]), "Loved by Gustavo 5★ · Drama, Crime · Investigation, Anxious.", "what follows the first part is left out");
  assert.equal(line("pick", ["Gustavo · profile favourite"]), "Loved by Gustavo · Drama, Crime · Investigation, Anxious.", "a favourite with no rating");
  assert.equal(line("pair", ["Gustavo 5★ · Line 2★"]), "Gustavo 5★, Line 2★ · Drama, Crime · Investigation, Anxious.", "the two extremes and their stars; the comma because ' · ' separates the groups of the line");
  assert.equal(line("want", ["on the watchlist of Gustavo, Line and William", "you rate X"]), "On the watchlist of Gustavo, Line and William · Drama, Crime · Investigation, Anxious.");
  assert.equal(line("watched", ["watched in the last 30 days by Bia 4.5★ · Ana 4★ · Caio · +3 more"]), "Watched in the last 30 days by Bia 4.5★, Ana 4★ +4 more · Drama, Crime · Investigation, Anxious.", "two named, four not: Caio and the 3 of the row's text");
  assert.equal(line("watched", ["watched this week by Bia 4.5★ · Ana"]), "Watched this week by Bia 4.5★ and Ana · Drama, Crime · Investigation, Anxious.");
  assert.equal(line("watched", ["watched this week by Bia 4.5★"]), "Watched this week by Bia 4.5★ · Drama, Crime · Investigation, Anxious.");
  assert.equal(line("prize", ["Cannes Palme d'Or 1953, Venice Golden Lion 2019", "x"]), "Cannes Palme d'Or 1953, Venice Golden Lion 2019 · Drama, Crime · Investigation, Anxious.");
  assert.equal(line("actor", ["Tilda Swinton · you rate them 4.3★ over 7 films"]), "With Tilda Swinton · Drama, Crime · Investigation, Anxious.");
  for (const kind of ["pick", "pair", "want", "watched", "prize", "actor"]) assert.equal(line(kind, []), "Drama, Crime · Investigation, Anxious.", `${kind}: no reason, no lead`);
  assert.equal(D.moodLine({ ...base, leadsWithReason: "unknown", why: ["x"] }), "Drama, Crime · Investigation, Anxious.", "a kind nobody knows leads with nothing");
  // plan.js decides which rows lead: the nine ids
  const { REASON_ROWS } = require("../lib/plan");
  assert.deepEqual({ ...REASON_ROWS }, { "directors-loved": "loved", "friends-love": "loved", "top-picks": "pick", "friends-split": "pair", "friends-watchlist": "want", "friends-month": "watched", "friends-week": "watched", awards: "prize", "actor-week": "actor" }, "the nine rows and the reading each gets");
});

// Marco, 21/10/2026 ~15:00 UTC (D3): in a row that is no mood and has no reason, line 2 opens with "Mood: <the mood the film fits best>" (`item.fitMood`, lib/best-mood.js).
test("mood line (D3): a row that is no mood opens with the mood the film fits best; a mood row keeps its own mood; a reason row keeps its reason; a film that fits no mood starts with the genres", () => {
  const FIT = { genres: ["Crime", "Thriller", "Mystery"], keywords: ["investigation", "anxious"], fitMood: "🌃 Night drive" };
  assert.equal(D.moodLine({ ...FIT, mood: "🆕 New releases for you", moodIsRow: true }), "Mood: 🌃 Night drive · Crime, Thriller, Mystery · Investigation, Anxious.", "a row that is no mood");
  assert.equal(D.moodLine(FIT), "Mood: 🌃 Night drive · Crime, Thriller, Mystery · Investigation, Anxious.", "an item with no row at all (a Discover cut, a list)");
  assert.equal(D.moodLine({ ...FIT, mood: "☀️ Lift me out" }), "Mood: ☀️ Lift me out · Crime, Thriller, Mystery · Investigation, Anxious.", "a mood row: the row's mood, not the best fit");
  assert.equal(D.moodLine({ ...FIT, mood: "Tonight · ☀️ Lift me out" }), "Mood: ☀️ Lift me out · Crime, Thriller, Mystery · Investigation, Anxious.", "Tonight: the mood the pick was drawn for");
  assert.equal(D.moodLine({ ...FIT, moodIsRow: true, leadsWithReason: "pick", why: ["William 5★"] }), "Loved by William 5★ · Crime, Thriller, Mystery · Investigation, Anxious.", "a reason row: the reason, and the best fit does NOT follow it (the session's choice)");
  assert.ok(!D.moodLine({ ...FIT, moodIsRow: true, leadsWithReason: "pick", why: ["William 5★"] }).includes("Night drive"));
  assert.equal(D.moodLine({ ...FIT, moodIsRow: true, leadsWithReason: "pick", why: [] }), "Mood: 🌃 Night drive · Crime, Thriller, Mystery · Investigation, Anxious.", "a reason row whose item has no reason: the best fit");
  assert.equal(D.moodLine({ ...FIT, fitMood: undefined }), "Crime, Thriller, Mystery · Investigation, Anxious.", "a film that fits no mood");
  assert.equal(D.moodLine({ ...FIT, fitMood: "  " }), "Crime, Thriller, Mystery · Investigation, Anxious.");
  assert.equal(D.moodLine({ fitMood: "🌃 Night drive" }), "Mood: 🌃 Night drive.", "a mood and nothing else");
  assert.equal(D.moodLine({ ...FIT, keywords: ["night drive", "anxious", "tense", "dark"] }), "Mood: 🌃 Night drive · Crime, Thriller, Mystery · Anxious, Tense, Dark.", "the word that is the best fit's name is skipped, like the row mood's");
  assert.equal(D.fitOf({ fitMood: "Tonight · 🌃 Night drive" }), "🌃 Night drive");
  // the live general text: four words, the best fit leads, and the word that is its name stays (the Moods menu of the Worker may put another mood in its place)
  assert.equal(D.liveDescription({ id: "tt1", cast: CAST6, ...FIT, keywords: ["night drive", "anxious", "tense", "dark"], overview: "Syn." }, "\n\n", { words: 4, keepOwnWord: true }), "Sterling Hayden; Coleen Gray; Vince Edwards\nMood: 🌃 Night drive · Crime, Thriller, Mystery · Night drive, Anxious, Tense, Dark.\n\nSyn.");
});

// Marco, 21/10/2026 ~15:00 UTC (D5): "Mood: 😂 Comedy · Comedy, Drama" says Drama only. Measured on the build of 878b347 (caches of 21/10/2026): 93 cards of the Comedy row and 98 of the Horror row (rowDesc of index-v2.json) said the mood's name twice.
test("mood line (D5): the genre that is the name of the mood leading the line is left out, with no capitals and no emoji in the comparison; the third genre does not make way for a fourth; a reason lead leaves the genres alone", () => {
  assert.equal(D.moodLine({ mood: "😂 Comedy", genres: ["Comedy", "Drama"], keywords: ["satire"] }), "Mood: 😂 Comedy · Drama · Satire.", "Marco's example");
  assert.equal(D.moodLine({ mood: "🎃 Horror", genres: ["Drama", "Horror", "Thriller"], keywords: [] }), "Mood: 🎃 Horror · Drama, Thriller.", "any place among the three");
  assert.equal(D.moodLine({ mood: "😂 Comedy", genres: ["Comedy", "Drama", "Romance", "War"], keywords: [] }), "Mood: 😂 Comedy · Drama, Romance.", "the fourth genre does not come in (the Worker has three)");
  assert.equal(D.moodLine({ mood: "😂 Comedy", genres: ["Comedy"], keywords: [] }), "Mood: 😂 Comedy.", "the only genre was the mood's name");
  assert.equal(D.moodLine({ mood: "Tonight · 😂 Comedy", genres: ["Comedy", "Drama"], keywords: [] }), "Mood: 😂 Comedy · Drama.", "Tonight's prefix is not part of the name");
  assert.equal(D.moodLine({ fitMood: "😂 Comedy", genres: ["Comedy", "Drama"], keywords: [] }), "Mood: 😂 Comedy · Drama.", "the best fit's name too");
  assert.equal(D.moodLine({ mood: "🎥 Documentaries", genres: ["Documentary", "History"], keywords: [] }), "Mood: 🎥 Documentaries · History.", "singular and plural are the same genre (Marco, 21/10/2026 ~19:40 UTC, A; until then the session's narrow reading kept 'Documentary' for 984 films)");
  assert.equal(D.moodLine({ moodIsRow: true, leadsWithReason: "prize", why: ["Cannes Palme d'Or 1953"], fitMood: "😂 Comedy", genres: ["Comedy", "Drama"], keywords: [] }), "Cannes Palme d'Or 1953 · Comedy, Drama.", "a reason leads: the genres are all there");
  assert.equal(D.moodLine({ genres: ["Comedy", "Drama"], keywords: [] }), "Comedy, Drama.", "no lead mood, no genre out");
  assert.deepEqual(D.genresShown(["Comedy", "Drama"], "😂 Comedy"), ["Drama"]);
  assert.deepEqual(D.genresShown(["Comedy", "Drama"], ""), ["Comedy", "Drama"]);
  assert.deepEqual(D.genresShown(undefined, "😂 Comedy"), []);
});

// Marco, 21/10/2026 ~19:40 UTC (A): singular and plural count as the SAME genre in the rule that takes out the genre equal to the name of the mood leading the line. Written after the clean-context review found the narrow
// reading ("Mood: 🎥 Documentaries · Documentary, History", 984 films of the build of 21/10/2026 carried the pair). Undo it (sameName() back to equal letters) and the first three assertions go red.
test("genre rule (A): 'Documentaries' is 'Documentary', 'Comedies' is 'Comedy'; only the last word's plural ending counts, and a name that merely starts alike is not the genre", () => {
  assert.deepEqual(D.genresShown(["Documentary", "History"], "🎥 Documentaries"), ["History"], "the real pair of config.json");
  assert.deepEqual(D.genresShown(["Documentary"], "🎥 Documentaries"), [], "a film with that genre alone");
  assert.deepEqual(D.genresShown(["Comedy", "Drama"], "🎭 Comedies"), ["Drama"], "ies and y");
  assert.deepEqual(D.genresShown(["Western", "Drama"], "🤠 Westerns"), ["Drama"], "s");
  assert.deepEqual(D.genresShown(["Drama", "Comedy"], "Tonight · 😂 Comedy"), ["Drama"], "the same letters still count, Tonight's prefix aside");
  assert.deepEqual(D.genresShown(["Documentaries"], "Documentary"), [], "and the other way round");
  assert.deepEqual(D.genresShown(["Horror", "Drama"], "🧟 Horror-comedy"), ["Horror", "Drama"], "'Horror-comedy' is not 'Horror': a word before the last one is not a plural");
  assert.deepEqual(D.genresShown(["War", "Drama"], "🌍 Warm and gentle"), ["War", "Drama"], "a name that only starts alike");
  assert.deepEqual(D.genresShown(["Crime", "Drama"], "🌃 Night, crime and mystery"), ["Crime", "Drama"], "a genre inside a longer name is not the name");
  assert.deepEqual(D.genresShown(["Mystery", "Drama"], "🔍 Whodunit"), ["Mystery", "Drama"]);
  assert.deepEqual(D.genresShown(["Mystery", "Drama"], "🌃 Night, crime and mystery"), ["Mystery", "Drama"], "the row 'Night, crime and mystery' ends in a genre's name and is not that genre: the words before the last one must match too");
  assert.equal(D.sameName("Chess", "Ches"), false, "'ss' is no plural");
  assert.equal(D.sameName("Classes", "Class"), true, "'es'");
  assert.equal(D.sameName("TV Movies", "TV Movie"), true, "'ies' also tries the plain 's': Movies is Movie, not only Movy");
  assert.deepEqual(D.genresShown(["Documentary", "History"], ""), ["Documentary", "History"], "no lead mood, no genre out");
  assert.equal(D.moodLine({ fitMood: "🎥 Documentaries", genres: ["Documentary", "History", "War"], keywords: ["archive"] }), "Mood: 🎥 Documentaries · History, War · Archive.", "the best fit's name too");
  assert.equal(D.moodLine({ mood: "Tonight · 🎥 Documentaries", genres: ["Documentary"], keywords: [] }), "Mood: 🎥 Documentaries.", "a film whose only genre was the name of the mood");
});

// The names that exist today (A): every name config.json gives a mood or a Board row, and the names of the profiles' moods, against the 19 genres of TMDB (cache/tmdb.json, 21/10/2026). The pairs that count are written here,
// so a mood renamed into a genre's plural (or a genre that TMDB adds) changes the list on purpose and not by accident.
test("genre rule (A): over every name of config.json and every TMDB genre the pairs removed are exactly the ones listed", () => {
  const cfg = require("../config.json");
  const GENRES = ["Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary", "Drama", "Family", "Fantasy", "History", "Horror", "Music", "Mystery", "Romance", "Science Fiction", "TV Movie", "Thriller", "War", "Western"];
  const profileNames = ["Warm and funny", "Pure entertainment", "Identity and reinvention", "Cathartic drama", "Neon and tension", "Art-house horror", "World cinema", "Music films", "Slow cinema"];
  const all = [...new Set([...cfg.moods.map((m) => m.name), ...Object.values(cfg.board.names), ...profileNames])];
  const pairs = [];
  for (const name of all) for (const g of GENRES) if (D.genresShown([g], name).length === 0) pairs.push(`${name} | ${g}`);
  assert.deepEqual(pairs.sort(), ["🎃 Horror | Horror", "😂 Comedy | Comedy", "🎥 Documentaries | Documentary"].sort(), "Comedy and Horror (the same letters, D5) and Documentaries (singular and plural, A); the wicked row is called \"Horror\" again since 21/10/2026 ~22:15 UTC (the rename of ~19:40 UTC, B, was reverted), so Horror pairs again");
});

// Regression guard of the removal of the personal reasons (Marco, 20/10/2026): the old card put "you rate…", "on your watchlist since…" and the friends' stars in its third line.
test("description: no personal reason, no friends' word, no 'loved by' and no numbers — only the credits, the mood, the genres and the keywords", () => {
  const it = { ...NIGHT, why: ["on your watchlist since Aug 2022", "you rate Stanley Kubrick 4.6★ over 9 films", "friend-g 4.5★"], loved: "Loved by Lynch and Scorsese · Sight & Sound 2022 ballot", ratings: R({ lb: 4.3, imdb: 7.3, friendsAvg: 4.5, seenBy: 3, wantBy: 5 }) };
  const text = D.describe({ ...it, directors: ["Stanley Kubrick"], runtime: 85, cast: CAST6, overview: "Syn." });
  assert.ok(!/you rate|watchlist|friend-g|Loved by|Letterboxd|IMDb|Friends|want to see|★/.test(text), text);
});

test("the Letterboxd average is not a reason (the first line has it as ★): a Board or Discover item gets no 'Letterboxd 3.97★'; a friend is 'friend-g 4.5★'", () => {
  assert.equal(Q.planReason({ lb: 3.97, fr: null, friend: null }), null);
  assert.equal(Q.planReason({ lb: 3.97, fr: 4.5, friend: "friend-g" }), null, "the average already qualifies it");
  assert.equal(Q.planReason({ lb: 3.2, fr: 4.5, friend: "friend-g" }), "friend-g 4.5★");
  assert.equal(Q.planReason({ lb: 3.2, fr: 3.5, friend: "friend-g" }), "friend-g 3.5★");
  assert.equal(Q.planReason({ lb: 3.2, fr: 2, friend: "friend-g" }), null, "not qualified at all");
  assert.equal(Q.planReason({ lb: 2.8, cv: 1, cvList: "Cannes Winners", cvTrust: "critic" }), "in “Cannes Winners”, a critics' list", "a vouched film still says who vouched");
  const plan = { board: [{ id: "x", items: [{ id: "tt1", why: ["on your watchlist since Aug 2022"] }, { id: "tt2", why: [] }, { id: "tt3", why: ["a"] }] }], discover: [] };
  Q.applyPlan(plan, new Map([["tt1", { lb: 3.97, fr: null, friend: null }], ["tt2", { lb: 3.2, fr: 4.5, friend: "friend-g" }], ["tt3", { lb: 4.23, fr: null, friend: null }]]));
  assert.deepEqual(plan.board[0].items.map((i) => i.why), [["on your watchlist since Aug 2022"], ["friend-g 4.5★"], ["a"]]);
  assert.match(Q.reason({ lb: 3.97 }), /^Letterboxd 3\.97★$/, "the browser picker's wording is untouched");
});

test("reasons are phrased to say what Marco does — 'you rate Edward Yang 4.7★ over 3 films', never 'You average …'", () => {
  const out = reasons([
    { type: "director", label: "Edward Yang", n: 3, avg: 4.7, w: 0.6 },
    { type: "cast", label: "Chang Chen", n: 4, avg: 4.5, w: 0.4 },
    { type: "keyword", label: "coming of age", n: 8, avg: 4.2, w: 0.3 },
    { type: "lang", label: "Japanese", n: 9, avg: 4.1, w: 0.3 },
    { type: "country", label: "TW", n: 7, avg: 4.4, w: 0.5 },
  ], 5);
  assert.ok(out.includes("you rate Edward Yang 4.7★ over 3 films"));
  assert.ok(out.includes("you rate Chang Chen 4.5★ over 4 films"));
  assert.ok(out.includes("you rate coming of age films 4.2★ (8 rated)"));
  assert.ok(out.includes("you rate Japanese-language films 4.1★"));
  assert.ok(out.includes("you rate films from Taiwan 4.4★"));
  assert.ok(out.every((r) => /^you rate /.test(r)));
});

const MOODS = () => compile([{ id: "noir", name: "Night drive", word: "Noir", genres: { Crime: 2 }, keywords: { "film noir": 2, heist: 1.5 }, minFit: 1 }]);
const KILLING_FILM = () => ({ id: 1, imdb: "tt0049406", title: "The Killing", year: 1956, runtime: 85, genres: ["Crime"], keywords: ["film noir", "heist"], directors: [{ id: 7, name: "Stanley Kubrick" }], cast: CAST6.map((name, id) => ({ id, name })), countries: ["US"], lang: "en", va: 7.9, vc: 5000, overview: "x", poster: "/k.jpg" });
const KILLING_ROWS = () => {
  const cand = { id: 1, film: KILLING_FILM(), tasteZ: 1, qualityZ: 1, recCount: 2, watchlist: true, watchlistedOn: "2022-08-14", pins: [], seeds: [{ title: "Barry Lyndon", rating: 5 }], seedIds: new Set([99]), contributions: [{ type: "director", label: "Stanley Kubrick", n: 9, avg: 4.6, w: 0.5 }] };
  return buildRows({ pool: [cand], rewatch: [], moods: MOODS(), cfg: { sizes: { tonight: 6, row: 30, discover: 60, because: 20, directors: 24, oldFriends: 24, watchlist: 40 }, build: { directors: 15 } }, model: { stats: new Map() }, recentSeeds: [], today: "2026-10-13" }).rows;
};


test("a mood row item: the mood's name is the item's `mood`, and its description says 'Mood: …' (the spec example, The Killing)", () => {
  const rows = KILLING_ROWS();
  const it = rows.noir[0];
  assert.equal(it.mood, "Night drive", "the mood's NAME, not its signals ('film noir, heist')");
  assert.deepEqual(it.why, ["on your watchlist since Aug 2022", "you rate Stanley Kubrick 4.6★ over 9 films", "because you gave Barry Lyndon 5★"], "the plan keeps the reasons; the description does not show them");
  assert.equal(D.moodLine(it), "Mood: Night drive · Crime.", "the genre; the keywords are put on the item by build.js from the index, never read from TMDB's record (the record here has 'film noir' and 'heist')");
  assert.ok(!JSON.stringify(it).includes("Themes"));
  assert.deepEqual(it.countries, ["United States"]);
  assert.deepEqual(it.cast, CAST6.slice(0, 5));
  assert.equal(it.keywords, undefined, "no raw TMDB keywords on the item");
  assert.equal(rows.watchlist[0].why[0], "on your watchlist since Aug 2022");
  assert.equal(rows.watchlist[0].mood, undefined); // only the mood rows and Tonight carry a mood
});

test("Tonight: 'Mood: <the mood it was drawn for>', without the 'Tonight · ' of the plan's `mood`", () => {
  const t = KILLING_ROWS().tonight[0];
  assert.equal(t.mood, "Tonight · Night drive");
  assert.equal(D.moodLine(t), "Mood: Night drive · Crime.");
  assert.ok(!/Tonight/.test(D.describe(t)));
});

// ── the synopsis ─────────────────────────────────────────────────────────────

const KILLING = "Career criminal Johnny Clay recruits a group of specialists to pull off a heist at a racetrack. Things go wrong when a jealous wife tips off the mob. A third sentence never shows up.";

test("synopsis: two sentences at most, whole, ending in a full stop", () => {
  assert.equal(D.synopsis(KILLING), "Career criminal Johnny Clay recruits a group of specialists to pull off a heist at a racetrack. Things go wrong when a jealous wife tips off the mob.");
  assert.equal(D.synopsis("One short sentence."), "One short sentence.");
  assert.equal(D.synopsis("A sentence with no full stop"), "A sentence with no full stop.");
  assert.equal(D.synopsis("Is it? It is!"), "Is it? It is!");
  assert.equal(D.synopsis("One. Two. Three. Four."), "One. Two.", "never three");
  assert.equal(D.synopsis("  "), "");
  assert.equal(D.synopsis(undefined), "");
});

test("synopsis: at most 280 characters — the second sentence is left out when it would not fit, and a first sentence that is too long is cut at a word and closed", () => {
  assert.equal(D.SYNOPSIS_CHARS, 280);
  const first = "A".repeat(10) + " " + "word ".repeat(30).trim() + "."; // 10 + 1 + 149 + 1 = 161
  const second = "Then " + "more ".repeat(30).trim() + "."; // 5 + 149 + 1 = 155: together 317 > 280
  const s = D.synopsis(`${first} ${second}`);
  assert.equal(s, first);
  const fits = "Then " + "more ".repeat(20).trim() + "."; // 105: together 267 <= 280, and the old 220 would have left it out
  assert.equal(D.synopsis(`${first} ${fits}`), `${first} ${fits}`);
  const long = "Lorem ipsum ".repeat(40).trim() + "."; // one sentence of ~480 characters
  const cut = D.synopsis(long);
  assert.ok(cut.length <= 280 && cut.length > 200, String(cut.length));
  assert.match(cut, /[a-z]\.$/);
  assert.ok(!/\s\.$/.test(cut) && !/,\.$/.test(cut));
  assert.ok(D.synopsis("Word ".repeat(100).trim()).endsWith("."));
});

test("synopsis: a full stop after an abbreviation, an initial or a lower-case word is not the end of a sentence", () => {
  assert.equal(D.synopsis("Dr. J. Edgar Hoover meets St. Louis at 5 p.m. in the U.S. Army. He has a plan. Another one."), "Dr. J. Edgar Hoover meets St. Louis at 5 p.m. in the U.S. Army. He has a plan.");
  assert.equal(D.sentences("Mr. Smith goes. Then he stops").length, 2);
});

const TAKE = "Jarmusch turns a bus driver's week into a poem. Every morning the same route, and every morning something new. A third sentence about the dog never shows up.";
const LB_SYN = "A letterboxd synopsis. With a second sentence. And a third.";

test("synopsis source: MUBI's Our Take first (with the credit \"MUBI: \"), then Letterboxd's synopsis, then TMDB's overview; each cut to two sentences and 280 characters", () => {
  try {
    const item = { id: "tt5247022", overview: "The TMDB overview. It has two sentences.", lbSynopsis: LB_SYN };
    assert.equal(D.synopsisText(item), item.lbSynopsis, "no Our Take: Letterboxd over TMDB");
    SRC.setTakes({ tt5247022: TAKE });
    assert.equal(D.synopsisText(item), `MUBI: ${TAKE}`, "Our Take over Letterboxd and TMDB, credited");
    assert.equal(D.describe(item, "|"), "MUBI: Jarmusch turns a bus driver's week into a poem. Every morning the same route, and every morning something new.", "the credit opens the first sentence; two sentences of the Our Take");
    assert.ok(!D.describe({ ...item, id: "tt0000001" }, "|").includes("MUBI"), "the credit belongs to an Our Take only: Letterboxd and TMDB texts carry none");
    assert.ok(!D.describe({ id: "tt0000001", overview: "TMDB." }, "|").includes("MUBI"));
    assert.equal(D.synopsisText({ ...item, id: "tt0000001" }), LB_SYN, "an Our Take belongs to its own film only");
    assert.equal(D.describe({ id: "tt0000001", overview: "The TMDB overview. It has two sentences.", lbSynopsis: LB_SYN }, "|"), "A letterboxd synopsis. With a second sentence.");
    SRC.clear();
    assert.equal(D.describe({ id: "tt0000001", overview: "The TMDB overview. It has two sentences. Three." }, "|"), "The TMDB overview. It has two sentences.");
    assert.equal(D.describe({ id: "tt0000001", overview: "The TMDB overview.", lbSynopsis: "   " }, "|"), "The TMDB overview.", "a blank Letterboxd text is nothing");
    assert.equal(D.describe({ id: "tt0000001", overview: "", lbSynopsis: "" }, "|"), "", "no source at all: no synopsis, no empty line");
    SRC.setTakes({ tt1: "Opening words " + "word ".repeat(80).trim() });
    const long = D.synopsis(D.synopsisText({ id: "tt1" }));
    assert.ok(long.length <= 280 && long.startsWith("MUBI: Opening words word ") && long.endsWith("."), "an Our Take longer than 280 is cut, the credit counted in the 280");
  } finally { SRC.clear(); }
});

test("the MUBI cache is read only from the path it is given, and only a confirmed film with an available Our Take counts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mood-mubi-"));
  try {
    const rec = (status, ourTake) => ({ status, capturedAt: "2026-10-12T22:59:17.741Z", locale: "en-US", mubi: { url: "https://mubi.com/en/films/x" }, ourTake });
    const file = path.join(dir, "mubi.json");
    fs.writeFileSync(file, JSON.stringify({ schema: 1, source: "test", updatedAt: "2026-10-12T23:00:02.966Z", films: {
      tt1: rec("confirmed", { state: "available", text: "  Take one. Take two.  " }),
      tt2: rec("confirmed", { state: "absent" }),
      tt3: rec("ambiguous", { state: "available", text: "never read" }),
      tt4: rec("confirmed", { state: "available", text: "   " }),
      nope: rec("confirmed", { state: "available", text: "not an imdb id" }),
    } }));
    assert.equal(SRC.ourTake("tt1"), undefined, "nothing is read until a path is given");
    const got = SRC.useMubi(file);
    assert.deepEqual([got.available, got.takes], [true, 1]);
    assert.equal(SRC.ourTake("tt1"), "Take one. Take two.");
    for (const tt of ["tt2", "tt3", "tt4", "nope", undefined, null]) assert.equal(SRC.ourTake(tt), undefined, String(tt));
    assert.deepEqual(SRC.useMubi(path.join(dir, "missing.json")), { available: false, reason: "no-cache" });
    assert.equal(SRC.ourTake("tt1"), undefined, "a cache that cannot be read leaves nothing loaded");
    fs.writeFileSync(file, "{ half a file");
    assert.deepEqual(SRC.useMubi(file), { available: false, reason: "cache-invalid" });
  } finally { SRC.clear(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── the card and the whole ───────────────────────────────────────────────────

const ITEM = {
  id: "tt0049406", title: "The Killing", year: 1956, runtime: 85, directors: ["Stanley Kubrick"], countries: ["United States"], cast: CAST6,
  genres: ["Crime", "Thriller", "Drama", "Mystery"], keywords: ["heist", "racetrack", "double cross"],
  why: ["on your watchlist since Aug 2022", "you rate Stanley Kubrick 4.6★ over 9 films"], mood: "Night drive", overview: KILLING,
  ratings: R({ lb: 4.3, imdb: 7.3, friendsAvg: 4.5, seenBy: 3, wantBy: 5 }),
};
const CARD = [
  "Stanley Kubrick · 1h25 · Sterling Hayden, Coleen Gray, Vince Edwards.",
  "Mood: Night drive · Crime, Thriller, Drama · Heist, Racetrack, Double cross.",
].join("\n");
const SYNOPSIS = "Career criminal Johnny Clay recruits a group of specialists to pull off a heist at a racetrack. Things go wrong when a jealous wife tips off the mob.";

test("description: credits and mood on two lines, each ended by a full stop, ONE blank line, then the synopsis; no reasons, no numbers", () => {
  assert.equal(D.describe(ITEM), `${CARD}\n\n${SYNOPSIS}`);
  const text = D.describe(ITEM);
  assert.equal(text.split("\n\n").length, 2, "one blank line, and only one");
  assert.equal(text.split("\n\n")[0], CARD, "above it the card");
  assert.equal(text.split("\n\n")[0].split("\n").length, 2);
  assert.ok(text.split("\n\n")[0].split("\n").every((l) => l.endsWith(".")), "every line of the card ends with a full stop");
  assert.ok(!/IMDb|Friends|want to see|Letterboxd|★|you rate|watchlist/.test(text));
  assert.ok(!text.includes("United States") && !text.includes("1956"), "no country and no year: Stremio shows the year beside the description");
});

test("description: a line with nothing to say is left out with its break — no actors, no mood line, no director, no synopsis", () => {
  const [credits, mood] = CARD.split("\n");
  assert.equal(D.describe({ ...ITEM, cast: [] }), `Stanley Kubrick · 1h25.\n${mood}\n\n${SYNOPSIS}`, "no actors: the line keeps the director and the duration");
  assert.equal(D.describe({ ...ITEM, genres: [], keywords: [], mood: undefined }), `${credits}\n\n${SYNOPSIS}`, "no mood, no genre, no keyword: the line and its break are gone");
  assert.equal(D.describe({ ...ITEM, directors: [], runtime: undefined, cast: [] }), `${mood}\n\n${SYNOPSIS}`, "no credits at all");
  assert.equal(D.describe({ ...ITEM, overview: "" }), CARD, "no synopsis: no blank line at the end");
  assert.equal(D.describe({ id: "tt1", why: [], overview: "" }), "");
  assert.equal(D.describe({ ...ITEM, genres: [], keywords: [], mood: undefined, overview: "" }), credits);
});

test("description: 6 cast names in the cache are 3 in the card", () => {
  const line = D.describe({ ...ITEM, cast: CAST6 }).split("\n")[0];
  assert.equal(line.split(" · ")[2], "Sterling Hayden, Coleen Gray, Vince Edwards.");
  assert.ok(!line.includes("Jay C. Flippen"));
});

test("description: the separator of the config is the break between the card and the synopsis — a blank line by default, ' — ' for a screen that shows it all on one line; the card keeps its single line break", () => {
  const dash = D.describe(ITEM, " — ");
  assert.equal(dash, `${CARD} — ${SYNOPSIS}`);
  assert.equal(dash.split(" — ").length, 2);
  assert.equal(dash.split("\n").length, 2, "the two lines of the card stay two lines");
  assert.equal(D.describe(ITEM).split("\n\n").length, 2);
  assert.equal(D.describe(ITEM, "\n"), `${CARD}\n${SYNOPSIS}`);
  assert.deepEqual(D.SEPARATORS, ["\n\n", " — "]);
});

test("description: the MUBI credit and the three-source synopsis are what they were (Our Take 'MUBI: ', then Letterboxd, then TMDB)", () => {
  try {
    SRC.setTakes({ tt0049406: "A masterclass in tension. Second sentence. Third." });
    assert.equal(D.describe(ITEM).split("\n\n")[1], "MUBI: A masterclass in tension. Second sentence.");
    SRC.clear();
    assert.equal(D.describe({ ...ITEM, lbSynopsis: "Letterboxd says so." }).split("\n\n")[1], "Letterboxd says so.");
    assert.equal(D.describe(ITEM).split("\n\n")[1], SYNOPSIS);
  } finally { SRC.clear(); }
});

test("description: three real-shaped descriptions, whole", () => {
  const highAndLow = {
    id: "tt0057565", runtime: 143, directors: ["Akira Kurosawa"], cast: ["Toshirō Mifune", "Tatsuya Nakadai", "Kyōko Kagawa", "Tsutomu Yamazaki"],
    mood: "🌃 Night drive", genres: ["Crime", "Thriller", "Mystery"], keywords: ["investigation", "anxious", "film noir"],
    overview: "A wealthy executive is about to make a deal when his son's friend is kidnapped by mistake. He must decide what to do. A third.",
  };
  assert.equal(D.describe(highAndLow), [
    "Akira Kurosawa · 2h23 · Toshirō Mifune, Tatsuya Nakadai, Kyōko Kagawa.",
    "Mood: 🌃 Night drive · Crime, Thriller, Mystery · Investigation, Anxious, Film noir.",
    "",
    "A wealthy executive is about to make a deal when his son's friend is kidnapped by mistake. He must decide what to do.",
  ].join("\n"));
  const friends = {
    id: "tt0375210", runtime: 141, directors: ["Hirokazu Kore-eda"], cast: ["Yuya Yagira", "Ayu Kitaura", "Hiei Kimura"], mood: "👥 Friends loved", moodIsRow: true,
    genres: ["Drama"], keywords: ["abandonment"], why: ["loved by friend-g 4.5★ · Ana 4★"], overview: "A mother leaves her four children alone in a Tokyo apartment.",
  };
  assert.equal(D.describe(friends, " — "), [
    "Hirokazu Kore-eda · 2h21 · Yuya Yagira, Ayu Kitaura, Hiei Kimura.\nDrama · Abandonment.",
    "A mother leaves her four children alone in a Tokyo apartment.",
  ].join(" — "));
  const bare = { id: "tt0053779", runtime: 174, directors: ["Federico Fellini"], loved: "Loved by Lynch", why: [], overview: "" };
  assert.equal(D.describe(bare), "Federico Fellini · 2h54.");
});

// ── the meta Stremio gets ────────────────────────────────────────────────────

test("meta: description from the item, imdbRating as a string with one decimal, genres, runtime; no imdbRating when IMDb has none", () => {
  const m = toMeta({ ...ITEM, runtime: 85, genres: ["Crime", "Thriller"], poster: "/k.jpg" });
  assert.equal(m.imdbRating, "7.3");
  assert.deepEqual(m.genres, ["Crime", "Thriller"]);
  assert.equal(m.runtime, "85 min");
  assert.equal(m.description, D.describe({ ...ITEM, genres: ["Crime", "Thriller"] }));
  assert.equal(m.poster, "https://images.metahub.space/poster/medium/tt0049406/img"); // a TMDB path is not a cover address: metahub, as before
  assert.equal(toMeta({ ...ITEM, ratings: R({ lb: 4 }) }).imdbRating, undefined);
  assert.equal(toMeta({ ...ITEM, ratings: undefined }).imdbRating, undefined);
  assert.equal(toMeta({ ...ITEM, ratings: R({ imdb: 8 }) }).imdbRating, "8.0");
  assert.equal(toMeta({ ...ITEM, genres: [] }).genres, undefined);
});

test("meta: an item whose cover was drawn points at it; one whose cover could not be drawn keeps the metahub address", () => {
  assert.equal(toMeta({ ...ITEM, poster: "https://marcogusmao.github.io/mood-engine/posters/tt0049406.jpg" }).poster, "https://marcogusmao.github.io/mood-engine/posters/tt0049406.jpg");
  assert.equal(toMeta({ ...ITEM, poster: null }).poster, "https://images.metahub.space/poster/medium/tt0049406/img");
  assert.equal(toMeta({ ...ITEM, poster: "javascript:alert(1)" }).poster, "https://images.metahub.space/poster/medium/tt0049406/img");
});

test("publish: descriptionSeparator in the config reaches every file (the break before the synopsis); posters are copied next to the catalogs", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "mood-desc-")), covers = fs.mkdtempSync(path.join(os.tmpdir(), "mood-covers-"));
  try {
    fs.writeFileSync(path.join(covers, "tt0049406.jpg"), fs.readFileSync(path.join(__dirname, 'fixtures/learning/cover.jpg')));
    const plan = buildPlan({ moods: [{ id: "noir", name: "Noir", word: "Noir" }], rows: { noir: [{...ITEM, poster: "https://marcogusmao.github.io/mood-engine/posters/tt0049406.jpg"}], tonight: [], because: [], directors: [], watchlist: [], oldfriends: [] }, extra: { fromlists: [], short: [], newforyou: [], "friends-week": [] }, sizes: { row: 30, friends: 30 } });
    const cfgOf = (sep) => ({ addon: { id: "x", version: "1", name: "n", description: "d" }, descriptionSeparator: sep });
    const read = () => JSON.parse(fs.readFileSync(path.join(out, "catalog/movie/noir.json"), "utf8")).metas[0].description;
    publish({ outDir: out, webDir: path.join(__dirname, "..", "web"), cfg: cfgOf("\n\n"), plan, webData: {}, posters: { dir: covers, tts: new Set(["tt0049406"]) } });
    assert.equal(read(), D.describe(ITEM, "\n\n"));
    assert.equal(read().split("\n\n").length, 2);
    assert.deepEqual(fs.readdirSync(path.join(out, "posters")), ["tt0049406.jpg"]); // only the covers that exist
    plan.board.find(r=>r.id==="noir").items[0] = ITEM;
    plan.discover.find(c=>c.id==="mood-engine").options[0].items[0] = ITEM;
    const r = publish({ outDir: out, webDir: path.join(__dirname, "..", "web"), cfg: cfgOf(" — "), plan, webData: {} });
    assert.equal(read(), D.describe(ITEM, " — "));
    assert.equal(read().split(" — ").length, 2);
    assert.equal(read().split("\n").length, 2);
    assert.equal(r.covers, 0);
    assert.ok(!fs.existsSync(path.join(out, "posters")));
    publish({ outDir: out, webDir: path.join(__dirname, "..", "web"), cfg: { addon: { id: "x", version: "1", name: "n", description: "d" } }, plan, webData: {} });
    assert.equal(read().split("\n\n").length, 2); // no option in the config: the blank line
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(covers, { recursive: true, force: true });
  }
});

// ── the real build: cache/mubi.json is read by default ───────────────────────

const { spawnSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
/** An offline build on a copy of the committed caches; `mubi`: the text of a mubi.json to put in the copy's cache dir (the default file), `args`/`env`: overrides. */
const buildWith = ({ mubi = null, args = [], env = {} } = {}) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "mood-mubi-out-")), cache = fs.mkdtempSync(path.join(os.tmpdir(), "mood-mubi-cache-"));
  for (const f of ["friends.json", "lists.json", "tmdb.json", "directors.json", "imdb-ratings.json"]) fs.copyFileSync(path.join(ROOT, "cache", f), path.join(cache, f));
  if (mubi != null) fs.writeFileSync(path.join(cache, "mubi.json"), mubi);
  const r = spawnSync(process.execPath, ["build.js", "--offline", "--cache-only", "--skip-posters", "--cache-dir", cache, "--out", out, ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "", MUBI_CACHE: "", ...env } });
  return { r, out, cache, done: () => { fs.rmSync(out, { recursive: true, force: true }); fs.rmSync(cache, { recursive: true, force: true }); } };
};
const mubiFile = (films) => JSON.stringify({ schema: 1, source: "test", updatedAt: "2026-10-12T23:00:02.966Z", films });
const TAKE_TEXT = "SENTINEL Our Take sentence one. Sentence two. Sentence three.";
const allTakes = (text = TAKE_TEXT) => {
  const tmdb = JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "tmdb.json"), "utf8")).movie;
  const films = {};
  for (const e of Object.values(tmdb)) if (e && e.v && e.v.imdb && /^tt\d+$/.test(e.v.imdb)) films[e.v.imdb] = { status: "confirmed", capturedAt: "2026-10-12T22:59:17.741Z", locale: "en-US", mubi: { url: "https://mubi.com/en/films/x" }, ourTake: { state: "available", text } };
  return films;
};
const synopses = (out, name) => JSON.parse(fs.readFileSync(path.join(out, "catalog", "movie", name), "utf8")).metas.map((m) => m.description.split("\n\n").slice(1).join("\n\n"));
const CREDITED = "MUBI: SENTINEL Our Take sentence one. Sentence two.";
const NO_CACHE = !fs.existsSync(path.join(ROOT, "cache", "tmdb.json"));

test("build: cache/mubi.json is read by default — Our Take, credited \"MUBI: \", two sentences — in the static files and the index of the live addon; with no file, TMDB's overview", { skip: NO_CACHE }, () => {
  const without = buildWith();
  try {
    assert.equal(without.r.status, 0, without.r.stderr + without.r.stdout);
    const s = synopses(without.out, "watchlist.json");
    assert.ok(s.length > 5 && s.every((x) => x.length > 0 && !x.includes("MUBI")), "no file in the cache dir: TMDB's overview, no credit");
    assert.match(without.r.stdout, /MUBI Our Take: no cache\/mubi\.json/);
    // Marco, 20/10/2026: in EVERY Board row of the real build the card is credits + mood line, each ended by a full stop; a mood row and Tonight say "Mood: …" and no other row does
    const man = JSON.parse(fs.readFileSync(path.join(without.out, "manifest.json"), "utf8"));
    const moodRows = new Map(JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")).moods.map((m) => [m.id, m.name]));
    let checked = 0, withMood = 0, bestFit = 0;
    const REASON_ROWS_OF_PLAN = require("../lib/plan").REASON_ROWS;
    for (const c of man.catalogs.filter((x) => !x.extra)) {
      const metas = JSON.parse(fs.readFileSync(path.join(without.out, "catalog", "movie", `${c.id}.json`), "utf8")).metas;
      for (const m of metas) {
        const lines = m.description.split("\n\n")[0].split("\n");
        assert.ok(lines.length <= 2 && lines.every((l) => l.endsWith(".")), `${c.id}: ${m.name}: ${JSON.stringify(lines)}`);
        assert.ok(!/you rate|on your watchlist|Letterboxd|IMDb|Tonight/.test(lines.join("\n")), `${c.id}: ${m.name}: ${lines.join(" / ")}`);
        if (c.id === "directors-loved") assert.ok(/^Loved by [^·]+( · |\.$)/.test(lines[1] || ""), `${c.id}: ${m.name}: line 2 starts with the director's love: ${lines.join(" / ")}`);
        else if (c.id === "friends-love") assert.ok(/^Loved by [^·]+( · |\.$)/.test(lines[1] || ""), `${c.id}: ${m.name}: line 2 starts with the friends' love (D2, 21/10/2026: capital and +N more): ${lines.join(" / ")}`);
        else assert.ok(!/^Loved by /.test(lines[1] || ""), `${c.id}: ${m.name}: only the directors' and the friends' rows lead with the love`);
        const line2 = lines.find((l) => l.startsWith("Mood: "));
        if (moodRows.has(c.id)) { assert.ok(line2 && line2.startsWith(`Mood: ${moodRows.get(c.id)}`), `${c.id}: ${m.name}: ${lines.join(" / ")}`); withMood++; }
        else if (c.id === "tonight") { assert.ok(line2 && [...moodRows.values()].some((n) => line2.startsWith(`Mood: ${n}`)), `tonight: ${m.name}: ${line2}`); withMood++; }
        else if (REASON_ROWS_OF_PLAN[c.id]) assert.equal(line2, undefined, `${c.id} opens with its reason, not with a mood: ${m.name}: ${lines.join(" / ")}`); // D1, 21/10/2026
        else if (line2 !== undefined) { assert.ok([...moodRows.values()].includes(line2.slice(6).split(" · ")[0].replace(/\.$/, "")), `${c.id} is not a mood: ${m.name}: "${line2}" should name the mood the film fits best, one of config.json's`); bestFit++; } // D3, 21/10/2026
        checked++;
      }
    }
    assert.ok(checked > 1000 && withMood > 100 && bestFit > 100, `${checked} Board films checked, ${withMood} in a mood, ${bestFit} in rows that are no mood with the mood they fit best`);
    // Marco, 20/10/2026: the third group of line 2 is the film's MOOD WORDS, never TMDB's raw keywords ("rape, christianity, monk" for Andrei Rublev), with an initial capital, from the SAME list as the
    // `desc` of the index (review finding 1): the static words are the index's four (lib/index-export.js), minus the word that is the row's mood, the first three.
    const ix = require("../lib/index-rows").decode(JSON.parse(fs.readFileSync(path.join(without.out, "data", "index.json"), "utf8")));
    const ix2 = require("../lib/index-rows").decode(JSON.parse(fs.readFileSync(path.join(without.out, "data", "index-v2.json"), "utf8")));
    const wordsOfDesc = (e) => { // the words group of an entry's `desc` (line 2: "[Mood: <best fit> · ]<genres> · <words>.", the genres being the entry's column without the one that is the best fit's name: D5, 21/10/2026)
      const line = String(e.desc || "").split("\n\n")[0].split("\n")[1] || "", groups = line.replace(/\.$/, "").split(" · ");
      const lead = groups[0].startsWith("Mood: ") ? groups.shift().slice(6) : "";
      const g = D.genresShown(e.genres, lead).join(", ");
      const rest = g ? (groups[0] === g ? groups.slice(1) : null) : groups.filter(Boolean);
      assert.ok(rest !== null && rest.length <= 1, `${e.name}: desc line 2 "${line}" does not start with the genres ${g}`);
      return rest.length ? rest[0].split(", ") : [];
    };
    const words = new Map(ix.films.map((f) => [f.tt, wordsOfDesc(f)])), words2 = new Map(ix2.films.map((f) => [f.tt, wordsOfDesc(f)]));
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "tmdb.json"), "utf8")).movie;
    let withWords = 0, rawSeen = 0, differ = 0, planted = 0, plantedCaught = 0;
    // The check that no TMDB keyword in its raw form is on line 2. Until 21/10/2026 (~22:15 UTC) it skipped every line that showed a genre (`!(own.genres || []).some((g) => line2.includes(g))`), so it looked at the lines with NO genre only: with a raw keyword
    // planted at the end of every line it caught 7 of 7 lines without a genre and 0 of 1,262 with one (measured on the offline build of 21/10/2026, 22:15 UTC, over the lines that can take a planted keyword; the review counted 1,263), and a substring test (` ${k}` inside the line) would have flagged " war" in "Warm". Now: the LAST group of the line
    // (the words group, or the genre group when the film has no word, or nothing when the line is the lead alone) is read word by word, and a word that is one of the film's genres is not a keyword hit; a raw keyword that is not one of the film's mood words is. The planted control below
    // appends a raw keyword to every line that can take one and requires the check to catch ALL of them, with and without a genre.
    const lastGroupWords = (line2) => {
      const groups = String(line2 || "").replace(/\.$/, "").split(" · ").filter(Boolean);
      const lead = groups[0] && groups[0].startsWith("Mood: ") ? 1 : 0;
      return groups.length > lead ? groups[groups.length - 1].split(", ").map((x) => x.trim().toLowerCase()) : [];
    };
    const rawHit = (line2, own, wordsOfFilm) => own && own.keywords && lastGroupWords(line2).some((w) => own.keywords.includes(w) && !wordsOfFilm.includes(w) && !(own.genres || []).map((g) => g.toLowerCase()).includes(w));
    for (const [tt, w] of words) if (words2.has(tt) && words2.get(tt).join() !== w.join()) differ++;
    assert.equal(differ, 0, "the two indexes say the same words for every film they share");
    for (const c of man.catalogs.filter((x) => !x.extra)) {
      for (const m of JSON.parse(fs.readFileSync(path.join(without.out, "catalog", "movie", `${c.id}.json`), "utf8")).metas) {
        const line2 = (m.description.split("\n\n")[0].split("\n")[1] || "");
        const mood = (/^Mood: ([^·]+?)(?: · |\.$)/.exec(line2) || [])[1] || "";
        const want = D.pickWords(words.get(m.id) || [], mood).map(D.capital);
        if (want.length) { assert.ok(line2.endsWith(` · ${want.join(", ")}.`), `${c.id}: ${m.name}: "${line2}" should end with ${want.join(", ")}`); withWords++; }
        const own = Object.values(raw).map((e) => e && e.v).find((v) => v && v.imdb === m.id);
        // the words of `desc` have an initial capital and TMDB's keywords do not: compared as lower case (until 21/10/2026 ~19:40 UTC, A, this passed by the second clause alone: a film whose only genre was Documentary had "Documentary" on the line; now
        // the line "Mood: 🎥 Documentaries · Artist." has no genre on it, and "artist" is a mood word of the film that TMDB also lists as a keyword)
        const wordsOfFilm = (words.get(m.id) || []).map((w) => w.toLowerCase());
        if (rawHit(line2, own, wordsOfFilm)) rawSeen++;
        // the positive control: the same line with one raw keyword of the film (not a mood word, not a genre, one word) added as the last group must be caught
        const k = own && own.keywords && own.keywords.find((x) => !wordsOfFilm.includes(x) && !(own.genres || []).map((g) => g.toLowerCase()).includes(x) && !/[,·]/.test(x));
        if (k && line2) { planted++; if (rawHit(line2.replace(/\.$/, ` · ${D.capital(k)}.`), own, wordsOfFilm)) plantedCaught++; }
      }
    }
    assert.ok(withWords > 300, `${withWords} Board films with mood words`);
    // Marco, 21/10/2026 (01:35 UTC): the words come from EVERY mood of config.json (30), in both families. Receipt: plant nothing, read the caches: for every film of the legacy index the words of its
    // `desc` are words of the 30 moods, and many films have a word that only a v2 mood has (building with `descMoods: LEGACY_CFG.moods` makes this red: no such word is left).
    {
      const { allowlist } = require("../lib/index-export");
      const cfgAll = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
      const t30 = allowlist(cfgAll.moods), t9 = allowlist(require("../lib/board-shared").legacyConfig(cfgAll).moods);
      assert.ok(t30.length > t9.length && cfgAll.moods.length >= 30, "the 30 moods have more words than the 9");
      const vocab30 = new Set(t30.map((t) => t.term)), vocab9 = new Set(t9.map((t) => t.term));
      let checked = 0, onlyIn30 = 0;
      for (const f of ix.films) {
        const w = (words.get(f.tt) || []).map((x) => x.toLowerCase());
        for (const x of w) assert.ok(vocab30.has(x), `${f.name}: "${x}" is not a word of the 30 moods`);
        if (w.some((x) => !vocab9.has(x))) onlyIn30++; // a word that only a v2 mood has
        if (w.length) checked++;
      }
      assert.ok(checked > 3000 && onlyIn30 > 300, `${checked} films with words, ${onlyIn30} with a word that only the 30 moods give`);
    }
    // review of 21/10/2026: no film of either index says a genre twice on line 2 ("Drama, Romance · Romance, …": 97 films with the 30 moods before the genre-aware pick)
    for (const [label, films] of [["legacy", ix.films], ["v2", ix2.films]]) {
      const twice = films.filter((f) => { const g = new Set((f.genres || []).slice(0, 3).map(D.plain)); return (words.get(f.tt) || words2.get(f.tt) || []).some((x) => g.has(D.plain(x))); });
      assert.deepEqual(twice.map((f) => f.name).slice(0, 5), [], `${label} index: ${twice.length} films repeat a genre among the words of line 2`);
    }
    assert.equal(rawSeen, 0, "no raw TMDB keyword in line 2");
    assert.ok(planted > 500 && plantedCaught === planted, `the check sees a raw keyword planted at the end of the line in ${plantedCaught} of ${planted} lines (with and without a genre)`);
  } finally { without.done(); }
  const withTake = buildWith({ mubi: mubiFile(allTakes()) });
  try {
    assert.equal(withTake.r.status, 0, withTake.r.stderr + withTake.r.stdout);
    assert.match(withTake.r.stdout, /MUBI Our Take: \d+ films of \d+ records .*credit "MUBI: "/);
    const s = synopses(withTake.out, "watchlist.json");
    assert.ok(s.length > 5 && s.every((x) => x === CREDITED), `the default file is read for the whole watchlist row: ${s[0]}`);
    assert.ok(JSON.stringify(JSON.parse(fs.readFileSync(path.join(withTake.out, "data", "index.json"), "utf8"))).includes(CREDITED), "and the index of the live addon carries it too");
  } finally { withTake.done(); }
});

test("build: --mubi-cache and MUBI_CACHE override the default file; a named file that is missing, and a default file that cannot be read, stop the build", { skip: NO_CACHE }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mood-mubi-file-"));
  const other = path.join(dir, "other.json");
  fs.writeFileSync(other, mubiFile(allTakes("OTHER file take.")));
  try {
    for (const how of [{ args: ["--mubi-cache", other] }, { env: { MUBI_CACHE: other } }]) {
      const b = buildWith({ mubi: mubiFile(allTakes()), ...how });
      try {
        assert.equal(b.r.status, 0, b.r.stderr + b.r.stdout);
        const s = synopses(b.out, "watchlist.json");
        assert.ok(s.length > 5 && s.every((x) => x === "MUBI: OTHER file take."), `the named file wins over cache/mubi.json: ${s[0]}`);
      } finally { b.done(); }
    }
    const missing = buildWith({ args: ["--mubi-cache", path.join(dir, "missing.json")] });
    try {
      assert.notEqual(missing.r.status, 0);
      assert.match(missing.r.stderr, /the MUBI cache missing\.json cannot be used \(no-cache\)/);
      assert.ok(!fs.existsSync(path.join(missing.out, "manifest.json")), "nothing was written");
    } finally { missing.done(); }
    const broken = buildWith({ mubi: "{ half a file" });
    try {
      assert.notEqual(broken.r.status, 0);
      assert.match(broken.r.stderr, /the MUBI cache mubi\.json cannot be used \(cache-invalid\); fix the file or remove it/);
    } finally { broken.done(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); SRC.clear(); }
});

test("the committed cache/mubi.json is a schema-1 MUBI cache of film facts only: ids, titles, Our Take, short synopsis, community rating, dates and the source", () => {
  const file = path.join(ROOT, "cache", "mubi.json");
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual([j.schema, j.source, Object.keys(j).sort()], [1, "api.mubi.com/v3", ["films", "schema", "source", "updatedAt"]]);
  const films = Object.entries(j.films);
  // 14/10/2026: the nightly (scripts/mubi-nightly.js) adds films MUBI did not find, could not tell apart or failed on, so a record is no longer always "confirmed".
  assert.ok(films.length >= 20 && films.every(([tt, r]) => /^tt\d+$/.test(tt) && MC.STATUSES.includes(r.status)));
  // The one list of allowed fields is lib/mubi-cache.js (it was a set of paths here until 14/10/2026; the nightly writes with the same list): every path of every
  // record, to the leaves, is on it, and a field of Marco's, nested however deep, would not be (test/mubi-nightly.test.js plants some and sees them refused).
  assert.deepEqual(MC.cacheProblems(j), []);
  // and no key anywhere in the file is named like a credential (the TEXT of an Our Take may say "token"; a key may not), and no TEXT has the shape of one either:
  // a credential name followed by ":" or "=" (the bare word is not a finding: "a token gesture" is an Our Take, "Authorization: x" or "api_key=x" is not)
  const keys = [], strings = [];
  JSON.parse(fs.readFileSync(file, "utf8"), (k, v) => { if (k && !/^tt\d+$/.test(k)) keys.push(k); if (typeof v === "string") strings.push(v); return v; });
  assert.ok(keys.length > 20 && !keys.some((k) => /^(token|cookie|authorization|password|bearer|api[_-]?key|session[_-]?id)$/i.test(k)), "no key that looks like a credential");
  const CREDENTIAL_TEXT = MC.CREDENTIAL_TEXT; // the one pattern: the merge of the nightly refuses a record whose text has it
  assert.ok(strings.length > 20 && !strings.some((t) => CREDENTIAL_TEXT.test(t)), "no text that looks like a credential");
  assert.ok(CREDENTIAL_TEXT.test("Authorization: Bearer x") && CREDENTIAL_TEXT.test("api_key=abc") && CREDENTIAL_TEXT.test("Cookie : a=b") && !CREDENTIAL_TEXT.test("a token gesture; he is bearer of bad news"), "the pattern sees the shape, not the word");
  assert.equal(SRC.useMubi(file).available, true, "and the build can read it");
  SRC.clear();
});

test("replay: a build that read Our Take is replayed to the same files (the frozen cache/mubi.json is read by the replay too)", { skip: NO_CACHE }, () => {
  const { replaySelection } = require("../lib/learning/replay");
  const SN = require("../lib/learning/snapshot");
  const S = require("../lib/learning/schema");
  const parent = path.join(ROOT, ".context");
  fs.mkdirSync(parent, { recursive: true });
  const temp = fs.mkdtempSync(path.join(parent, "describe-replay-"));
  try {
    for (const rel of ["tools", "lib", "web", "scripts", "cache", "data", "build.js", "verify.js", "config.json", "learning.config.json"]) fs.cpSync(path.join(ROOT, rel), path.join(temp, rel), { recursive: true });
    fs.mkdirSync(path.join(temp, ".context"));
    fs.writeFileSync(path.join(temp, "cache", "mubi.json"), mubiFile(allTakes()));
    const env = { ...process.env, MOOD_DATE: "2026-10-10", MUBI_CACHE: "" };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ["build.js", "--offline", "--cache-only", "--out", path.join(temp, ".context", "shadow"), "--learning", "shadow", "--private-dir", path.join(temp, ".context/private"), "--captured-at", "2026-10-10T12:00:00.000Z", "--skip-posters"], { cwd: temp, env, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    assert.equal(r.status, 0, r.stderr);
    const priv = path.join(temp, ".context/private/snapshots");
    const snap = SN.verifySnapshot(path.join(priv, fs.readdirSync(priv)[0]));
    assert.ok("cache/mubi.json" in snap.bodies["inputs.json"].sourceBytes, "the snapshot froze the MUBI cache with the other caches");
    const made = Object.fromEntries(SN.filesUnder(path.join(temp, ".context/shadow/catalog")).map((p) => [path.relative(path.join(temp, ".context/shadow"), p), JSON.parse(fs.readFileSync(p, "utf8"))]));
    assert.ok(Object.values(made).some((c) => c.metas.some((m) => m.description.includes(CREDITED))), "the build wrote the credited Our Take");
    const one = replaySelection(snap, temp);
    assert.equal(one.hash, S.hash(made), "replay = what the build wrote");
    assert.deepEqual(replaySelection(snap, temp), one);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); SRC.clear(); }
});

// ── the row's mood leads line 2 only in a row that is a mood (Marco, 20/10/2026); in a row that is no mood the film's best fit leads it (Marco, 21/10/2026, D3) ───

const { buildPlan: planOf, BOARD_NAMES } = require("../lib/plan");

test("a Board row that is a mood says 'Mood: <its name>', Tonight says the mood it was drawn for; every other row marks its items `moodIsRow` (no ROW mood): the reason when it has one, else the film's best fit (D3, 21/10/2026), else the genres", () => {
  const item = (id, extra = {}) => ({ id, title: id, why: ["on your watchlist since Aug 2022"], genres: ["Drama"], keywords: ["x"], overview: "Syn.", ...extra });
  const rows = { tonight: [item("tt1", { mood: "Tonight · Night drive" })], noir: [item("tt2", { mood: "Night drive" })], because: [item("tt3")], directors: [item("tt4")], watchlist: [item("tt5")], oldfriends: [item("tt6")] };
  const extra = { fromlists: [item("tt7")], short: [item("tt8")], newforyou: [item("tt9")], "friends-week": [item("tt10", { why: ["watched this week by Ana 5★ · Bo"] })], "friends-love": [item("tt11", { why: ["loved by Ana 5★ · Bo 4.5★ · Cy 4★"] })], "directors-loved": [item("tt12", { loved: "Loved by Lynch" })] };
  const plan = planOf({ moods: [{ id: "noir", name: "Night drive", word: "Noir" }], rows, extra, sizes: { row: 30, friends: 30 } });
  assert.deepEqual(plan.board.map((r) => r.id), ["tonight", "watchlist", "fromlists", "friends-love", "friends-week", "short", "because", "noir", "newforyou", "directors", "directors-loved", "oldfriends"]);
  for (const r of plan.board) {
    assert.equal(r.items.length, 1, r.id);
    const line = D.moodLine(r.items[0]);
    // D3 (21/10/2026): the same item with a best fit. A mood row keeps its own mood and a reason row its reason; every other row opens with the best fit. With the D3 undone (a `moodIsRow` item drops the label) the last branch is red.
    const fitted = D.moodLine({ ...r.items[0], fitMood: "🎬 Best fit" });
    if (["tonight", "noir", "friends-love", "friends-week", "directors-loved"].includes(r.id)) assert.equal(fitted, line, `${r.id}: a mood row keeps its mood, a reason row its reason, whatever the best fit`);
    else assert.equal(fitted, "Mood: 🎬 Best fit · Drama · X.", `${r.id}: a row that is no mood and has no reason opens with the best fit`);
    if (r.id === "tonight" || r.id === "noir") assert.equal(line, "Mood: Night drive · Drama · X.", r.id);
    else {
      if (r.id === "friends-love") assert.equal(line, "Loved by Ana 5★, Bo 4.5★ +1 more · Drama · X.", r.id + ": the reason leads (Marco, 20/10/2026; the capital and the '+N more', 21/10/2026)");
      else if (r.id === "friends-week") assert.equal(line, "Watched this week by Ana 5★ and Bo · Drama · X.", r.id + ": the reason leads (Marco, 21/10/2026, D1)");
      else if (r.id === "directors-loved") assert.equal(line, "Loved by Lynch · Drama · X.", r.id + ": the director's love leads");
      else assert.equal(line, "Drama · X.", r.id);
      assert.equal(r.items[0].mood, r.name, `${r.id}: the plan still holds the row's name in \`mood\` (the learning files read it)`);
      assert.equal(r.items[0].moodIsRow, true, r.id);
    }
  }
  assert.equal(plan.board.find((r) => r.id === "noir").items[0].moodIsRow, undefined);
  assert.equal(extra.short[0].mood, undefined, "the item the row was given is left as it was: an item can be in more than one row");
  assert.equal(extra.short[0].moodIsRow, undefined);
  const names = new Set(plan.board.map((r) => r.items[0].mood));
  assert.equal(names.size, plan.board.length, "each row its own name");
  assert.ok(BOARD_NAMES.watchlist);
});

test("the v2 Board: a mood row and a row that combines moods say 'Mood: <the row's name>'; a filter row, a friends row and a Tonight item with no mood do not", () => {
  const item = (id) => ({ id, title: id, genres: ["Drama"], keywords: [], overview: "Syn." });
  // Review of the description v3, 21/10/2026 (lib/plan.js): the production board has NO `board.moods`; the 21 moods that only the v2 family has (comingofage, twotalk, visual, … — "growing" below is this fixture's stand-in id, not a production mood)
  // are moods of config.json that board.legacyMoods leaves out. build.js hands buildPlan the legacy moods in `moods` and every mood id in `allMoodIds`, and so does this test: with the legacy ids alone ELEVEN rows of the v2 Board lost their
  // "Mood:" — ten rows of v2-only moods (comingofage, visual, winter, adrenaline, swoon, twotalk, midnight, hidden, anthology, docs) and the combined Comedy row; 884 films on the caches of 20/10/2026.
  const board = { legacyMoods: ["noir"], moods: [{ id: "cosy" }], rows: { warm: { id: "warm", kind: "combine", parts: ["noir", "d70"] }, kin: { id: "kin", kind: "combine", parts: ["growing", "d70"] }, latam: { id: "latam", kind: "combine", parts: ["d70"] }, d70: { id: "d70", kind: "filter" } },
    entries: [{ id: "tonight", name: "Tonight" }, { id: "noir", name: "Noir!" }, { id: "cosy", name: "Cosy!" }, { id: "growing", name: "Growing up!" }, { id: "warm", name: "Warm!" }, { id: "kin", name: "Kin!" }, { id: "latam", name: "Latin America" }, { id: "d70", name: "1970s" }, { id: "friends-love", name: "Friends loved" }] };
  const rows2 = Object.fromEntries(board.entries.map((e) => [e.id, [item("tt" + e.id)]]));
  const plan = planOf({ moods: [{ id: "noir", name: "Night drive", word: "Noir" }], allMoodIds: ["noir", "growing"], rows: {}, extra: {}, sizes: { row: 30, friends: 30 }, board, rows2 });
  const line = (id) => D.moodLine(plan.board2.find((r) => r.id === id).items[0]);
  assert.equal(line("noir"), "Mood: Noir! · Drama.");
  assert.equal(line("cosy"), "Mood: Cosy! · Drama.");
  assert.equal(line("growing"), "Mood: Growing up! · Drama.", "a mood of config.json that is not a legacy mood and not in board.moods (the production shape)");
  assert.equal(line("warm"), "Mood: Warm! · Drama.");
  assert.equal(line("kin"), "Mood: Kin! · Drama.", "a combined row whose mood part is a v2-only mood of config.json");
  assert.equal(line("d70"), "Drama.");
  assert.equal(line("latam"), "Drama.", "a combined row of filters only is no mood");
  assert.equal(line("friends-love"), "Drama.");
  assert.equal(line("tonight"), "Drama.", "a Tonight item that carries no mood has none to show");
  // the legacy Board and the static Moods menu still see the legacy moods alone
  assert.ok(!plan.board.some((r) => r.id === "growing"));
});

test("liveDescription: '<actors>\\n<line 2>', the separator, the synopsis — no credits line; the actors alone when there is no line 2, line 2 after an empty first line when there are no actors", () => {
  const A3 = "Sterling Hayden; Coleen Gray; Vince Edwards";
  const base = { id: "tt1", cast: CAST6, genres: ["Crime"], keywords: ["heist"], overview: "Syn one. Syn two. Syn three." };
  assert.equal(D.liveDescription(base), `${A3}\nCrime · Heist.\n\nSyn one. Syn two.`, "a film's general text has no mood");
  assert.equal(D.liveDescription({ ...base, mood: "🌃 Night drive" }), `${A3}\nMood: 🌃 Night drive · Crime · Heist.\n\nSyn one. Syn two.`, "a Board row's own text has it");
  assert.equal(D.liveDescription({ ...base, cast: [] }), "\nCrime · Heist.\n\nSyn one. Syn two.", "no actors: an empty first line, so that line 2 is always the second");
  assert.equal(D.liveDescription({ ...base, genres: [], keywords: [] }), `${A3}\n\n\nSyn one. Syn two.`, "no line 2: the card is still two lines (the second empty), then the separator");
  assert.equal(D.liveDescription({ ...base, cast: [], genres: [], keywords: [] }), "\n\n\nSyn one. Syn two.", "no actors and no line 2: a card of one empty break, then the separator, then the synopsis — never the synopsis alone, which the live addon would read as a card");
  assert.equal(D.liveDescription({ ...base, cast: [], genres: [], keywords: [] }, " — "), "\n — Syn one. Syn two.");
  assert.equal(D.liveDescription({ ...base, cast: [], genres: [], keywords: [], overview: "" }), "", "nothing at all: nothing");
  assert.equal(D.liveDescription({ ...base, genres: [], keywords: [], overview: "" }), A3, "actors and no synopsis: the actors alone");
  assert.equal(D.liveDescription({ ...base, overview: "" }, " — "), `${A3}\nCrime · Heist.`);
  assert.equal(D.liveDescription({ id: "tt1" }), "");
  assert.ok(!D.liveDescription(base).includes("★") && !D.liveDescription(base).includes("1h"), "no credits line, no ★");
});

test("replay: the replayed build does not inherit MUBI_CACHE from the environment of the process that replays (a snapshot is what the build read, not what the replayer has set)", () => {
  const cp = require("node:child_process");
  const real = cp.spawnSync;
  const file = require.resolve("../lib/learning/replay");
  const had = process.env.MUBI_CACHE;
  let seen = null;
  delete require.cache[file];
  cp.spawnSync = (cmd, args, opts) => {
    if (opts && opts.env && String(args[0]) === "-e") { seen = opts.env; return { status: 1, stdout: "", stderr: "stopped by the spy" }; }
    return real(cmd, args, opts);
  };
  process.env.MUBI_CACHE = "/nonexistent/mubi.json";
  try {
    const { replaySelection } = require("../lib/learning/replay"); // loaded while the spy is in place: replay.js takes spawnSync at load
    const snap = { dir: "/nonexistent", manifest: { capturedAt: "2026-10-10T12:00:00.000Z", effectiveDate: "2026-10-10" }, bodies: { "feedback.json": {}, "inputs.json": { sourceBytes: {}, rss: [], effectiveOptions: null, effectivePosterState: null }, "baseline.json": { data: { plan: { board: [], discover: [] } } } } };
    assert.throws(() => replaySelection(snap, ROOT), /stopped by the spy/);
    assert.ok(seen, "the replay build was started");
    assert.ok(!("MUBI_CACHE" in seen), "and its environment has no MUBI_CACHE");
    assert.equal(seen.MOOD_DATE, "2026-10-10", "while it has the rest of what the replay sets");
  } finally {
    cp.spawnSync = real;
    delete require.cache[file];
    if (had === undefined) delete process.env.MUBI_CACHE; else process.env.MUBI_CACHE = had;
  }
});

