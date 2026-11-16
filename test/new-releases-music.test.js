// node --test test/new-releases-music.test.js
// The music rule (Marco, 22/10/2026): what a music film is, what counts as evidence, and New for you (the row it began in, ~03:50 UTC; since ~06:40 UTC it is only one of the rows that
// ask the same gate: test/music-all-rows.test.js has the other rows, the configuration and the wiring).
// The defect: on 21/10/2026 19 of the 50 films of New releases were concert films or music documentaries (14 + 5): ATEEZ, BTS, Stray Kids, Taylor Swift, Harry
// Styles, Lady Gaga... They came in by the Letterboxd average of the fans (quality z 1.4 to 2.7), and the taste model could not stop them (it adds features: ATEEZ got
// +1.29 from "concert", Music, Documentary and Korean cinema). Marco: "dont recommend that many concert documentaries, im not into kpop, taylor swift" and "i like
// things that are like are in my letterboxd like stop making sense".
// The rule: a music film is recommended only with evidence from his Letterboxd (a director or artist he rates, his watchlist, or a critics'/directors' list).
// The world below is small and invented (no cache): the real numbers are in README.md and PRODUCT.md.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const P = require("../lib/pool");
const { learn, personEvidence, reasons, REASON_MIN_N, REASON_MIN_W } = require("../lib/taste");
const PEOPLE = require("../lib/people");

const ROOT = path.join(__dirname, "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));

// ── the world ────────────────────────────────────────────────────────────────

const tag = (type, x = {}) => ({ type, ...x });
const lbFilm = (tt, title, year, tmdbId) => ({ title, year, tmdbId, imdbId: tt, r: 4.4, rt: 100, c: ["USA"], t: 1, v: 2 }); // 4.4 on Letterboxd: the fans' inflated average

const DEMME = { id: 101, name: "Jonathan Demme" }, ONCE = { id: 202, name: "A Director Rated Once" }, ARENA = { id: 900, name: "Arena Director" };
const detail = (id, title, year, o) => ({ id, imdb: "tt" + String(id).padStart(7, "0"), title, year, runtime: 110, countries: ["US"], lang: "en", va: 7.5, vc: 2000, genres: ["Documentary", "Music"], keywords: [], directors: [], cast: [], overview: "O", ...o });
const D = {
  1: detail(1, "Arena Tour Film", 2026, { directors: [ARENA], keywords: ["k-pop", "boy band", "concert film"] }), // no evidence of any kind
  2: detail(2, "Stop Making Sense Again", 2026, { directors: [DEMME], keywords: ["concert film", "post-punk"] }), // a director he rated in 2 films
  3: detail(3, "Watchlisted Gig", 2026, { genres: ["Music"], directors: [ARENA], keywords: ["live performance"] }), // on his watchlist
  4: detail(4, "Critics' Concert", 2026, { genres: ["Music"], directors: [ARENA], keywords: ["concert"] }), // in a list of trust critic
  5: detail(5, "Fan List Concert", 2026, { genres: ["Music"], directors: [ARENA], keywords: ["concert"] }), // only in a list of trust fan
  6: detail(6, "A Plain Drama", 2026, { genres: ["Drama"], keywords: ["family"], directors: [ARENA] }), // not music
  7: detail(7, "Musical Fiction", 2026, { genres: ["Music", "Drama"], keywords: ["jazz"], directors: [ARENA] }), // Music genre but a fiction film
  8: detail(8, "Rated Once Concert", 2026, { directors: [ONCE], keywords: ["concert film"] }), // its director has ONE film rated
  9: detail(9, "Old Popular Concert", 1984, { directors: [ARENA], keywords: ["concert"] }), // old, in Popular this week
  10: detail(10, "Eras Tour Night", 2026, { genres: ["Music"], directors: [ARENA], keywords: [] }), // Music genre and no live keyword: only its title says Tour
};
const SLUGS = { arena: 1, demme: 2, wl: 3, crit: 4, fan: 5, drama: 6, fiction: 7, once: 8, oldpop: 9, tour: 10 };
const view = { films: Object.fromEntries(Object.entries(SLUGS).map(([slug, id]) => [slug, lbFilm(D[id].imdb, D[id].title, D[id].year, id)])) };

// Marco's history: two Demme films and one of ONCE at 5★, six fillers at 3★ (mean 3.67): Demme's weight is 2.67/(2+1.5) = 0.76 over n = 2; ONCE's is n = 1
const rated = (n, title, dirs, rating, genres = ["Drama"]) => ({ film: { id: 5000 + n, title, year: 1990, directors: dirs, cast: [], genres, keywords: [], countries: ["FR"], lang: "fr" }, rating, liked: false });
const MODEL = learn([
  rated(1, "Stop Making Sense", [DEMME], 5, ["Documentary", "Music"]), rated(2, "Philadelphia", [DEMME], 5), rated(3, "Once Rated", [ONCE], 5),
  ...[4, 5, 6, 7, 8, 9].map((n) => rated(n, "Filler " + n, [{ id: 300 + n, name: "Filler Director " + n }], 3)),
]);

const ENTRIES = [
  { slug: "arena", tag: tag("list", { id: "FANLIST", name: "Concert list", pos: 1 }) },
  { slug: "demme", tag: tag("list", { id: "FANLIST", name: "Concert list", pos: 2 }) },
  { slug: "wl", tag: tag("watchlist") },
  { slug: "crit", tag: tag("list", { id: "CRITIC", name: "Critics' list", pos: 1 }) },
  { slug: "fan", tag: tag("list", { id: "FANLIST", name: "Concert list", pos: 3 }) },
  { slug: "drama", tag: tag("list", { id: "FANLIST", name: "Concert list", pos: 4 }) },
  { slug: "fiction", tag: tag("list", { id: "FANLIST", name: "Concert list", pos: 5 }) },
  { slug: "once", tag: tag("list", { id: "FANLIST", name: "Concert list", pos: 6 }) },
  { slug: "oldpop", tag: tag("list", { id: "POP", name: "Popular this week", pos: 1, popular: true }) },
  { slug: "tour", tag: tag("list", { id: "FANLIST", name: "Concert list", pos: 7 }) },
];
const recsOf = (films = view.films, entries = ENTRIES, details = D) => {
  const { pool } = P.buildPool({ entries, view: { films }, isSeen: () => false, detail: (r) => details[r.tmdbId] || null });
  return P.rankPool(pool, MODEL);
};
const recs = recsOf();
const OPTS = { fromYear: 2025, size: 50, vouchLists: new Set(["CRITIC"]) };
const titles = (row) => row.map((i) => i.title).sort();
const ALL = ["A Plain Drama", "Arena Tour Film", "Critics' Concert", "Eras Tour Night", "Fan List Concert", "Musical Fiction", "Old Popular Concert", "Rated Once Concert", "Stop Making Sense Again", "Watchlisted Gig"];

// ── the control: the world has the defect ────────────────────────────────────

/** New for you the way build.js makes it: from the films that pass the gate (`passing`), which is what every other row is made from. */
const gateOf = (needsEvidence, recList = recs, vouchLists = OPTS.vouchLists) => P.musicGate({ options: { needsEvidence, vouchLists }, recOf: (tt) => recList.find((r) => r.id === tt) || null });
const rowOf = (needsEvidence, o = OPTS, recList = recs) => { const g = gateOf(needsEvidence, recList, o.vouchLists); return P.newRow(recList.filter((r) => g.ok(r.id)), o); };

test("New for you music rule, positive control: with the rule off, the arena concert with no evidence IS in the row (the world shows the defect)", () => {
  const row = rowOf(false);
  assert.deepEqual(titles(row), ALL);
  assert.deepEqual(titles(P.newRow(recs, OPTS)), ALL, "and so is it with no gate at all");
  // and it is there on the strength of genre features alone: the taste model scores it above zero (it rated one music documentary 5★) with no person behind it
  const arena = recs.find((r) => r.title === "Arena Tour Film");
  assert.ok(arena.tasteRaw > 0);
  assert.equal(P.musicEvidence(arena, OPTS.vouchLists), null);
});

test("New for you music rule, flag absent or not exactly true: nothing changes (the other profiles keep the row)", () => {
  const off = titles(rowOf(false));
  for (const v of [undefined, false, "true", 1, null]) {
    const g = P.musicGate({ options: P.musicOptions({ music: { needsEvidence: v }, lists: [] }), recOf: (tt) => recs.find((r) => r.id === tt) || null });
    assert.deepEqual(titles(P.newRow(recs.filter((r) => g.ok(r.id)), OPTS)), off, JSON.stringify(v));
  }
  const none = P.musicGate({ options: P.musicOptions({ lists: [] }), recOf: (tt) => recs.find((r) => r.id === tt) || null });
  assert.deepEqual(titles(P.newRow(recs.filter((r) => none.ok(r.id)), OPTS)), off, "no key at all");
});

// ── the rule ─────────────────────────────────────────────────────────────────

test("New for you music rule on: no-evidence concerts go out; a director rated in 2 films, the watchlist and a critics' list stay; a non-musical film and a fiction film with a Music genre are not touched", () => {
  const row = rowOf(true);
  assert.deepEqual(titles(row), ["A Plain Drama", "Critics' Concert", "Musical Fiction", "Stop Making Sense Again", "Watchlisted Gig"]);
  const g = gateOf(true);
  recs.forEach((r) => g.ok(r.id));
  assert.deepEqual([...g.refused.values()].map((r) => r.title).sort(), ["Arena Tour Film", "Eras Tour Night", "Fan List Concert", "Old Popular Concert", "Rated Once Concert"]);
  // the three ways in, each by its own door
  const by = Object.fromEntries(recs.map((r) => [r.title, r]));
  assert.equal(P.musicEvidence(by["Stop Making Sense Again"], OPTS.vouchLists), "person");
  assert.equal(P.musicEvidence(by["Watchlisted Gig"], OPTS.vouchLists), "watchlist");
  assert.equal(P.musicEvidence(by["Critics' Concert"], OPTS.vouchLists), "list");
  // a film with several doors is labelled by the first (person, then watchlist, then list): Cameron Winter at Carnegie Hall is PTA's AND on his watchlist
  const both = { contributions: [{ type: "director", n: 11, w: 0.745 }], tags: { watchlist: true, lists: new Map([["CRITIC", {}]]) } };
  assert.equal(P.musicEvidence(both, OPTS.vouchLists), "person");
  assert.equal(P.musicEvidence({ ...both, contributions: [] }, OPTS.vouchLists), "watchlist");
  assert.equal(P.musicEvidence({ ...both, contributions: [], tags: { ...both.tags, watchlist: false } }, OPTS.vouchLists), "list");
  // the kept film says why, in the card's own words
  assert.match(row.find((i) => i.title === "Stop Making Sense Again").why.join(" "), /you rate Jonathan Demme 5\.0★ over 2 films/);
});

test("New for you music rule: a fan list grants nothing, ONE film of a director is not evidence, and Popular this week does not exempt an old concert", () => {
  const by = Object.fromEntries(recs.map((r) => [r.title, r]));
  assert.equal(P.musicEvidence(by["Fan List Concert"], OPTS.vouchLists), null); // in FANLIST, which is not a vouch list
  assert.equal(P.musicEvidence(by["Fan List Concert"], new Set(["FANLIST"])), "list"); // control: the same film passes when its list does vouch
  assert.equal(P.musicEvidence(by["Rated Once Concert"], OPTS.vouchLists), null); // director rated once: n = 1 < 2
  assert.equal(by["Rated Once Concert"].contributions.find((s) => s.type === "director").n, 1); // control: the model does know him, with a positive weight
  assert.ok(by["Rated Once Concert"].contributions.find((s) => s.type === "director").w > REASON_MIN_W);
  const row = rowOf(true);
  assert.ok(!row.some((i) => i.title === "Old Popular Concert")); // old and on Popular this week: the year let it in, the rule keeps it out
  assert.ok(rowOf(false).some((i) => i.title === "Old Popular Concert")); // control
});

test("New for you music rule: the places the rule opens are refilled up to the size (the next candidates come in, as in every Board row)", () => {
  // three more plain dramas, ranked below everything (Letterboxd 3.6)
  const extraFilms = { ...view.films }, extraDetails = { ...D }, extraEntries = [...ENTRIES];
  for (const n of [11, 12, 13]) {
    extraDetails[n] = detail(n, "Extra Drama " + n, 2026, { genres: ["Drama"], directors: [ARENA] });
    extraFilms["x" + n] = { ...lbFilm(extraDetails[n].imdb, extraDetails[n].title, 2026, n), r: 3.6 };
    extraEntries.push({ slug: "x" + n, tag: tag("list", { id: "FANLIST", name: "Concert list", pos: n }) });
  }
  const big = recsOf(extraFilms, extraEntries, extraDetails);
  const off = rowOf(false, { ...OPTS, size: 8 }, big), on = rowOf(true, { ...OPTS, size: 8 }, big);
  assert.equal(off.length, 8);
  assert.equal(on.length, 8); // 5 survivors + the 3 extra dramas: the row is as long as before
  assert.ok(on.filter((i) => i.title.startsWith("Extra Drama")).length > off.filter((i) => i.title.startsWith("Extra Drama")).length);
  assert.ok(!on.some((i) => ["Arena Tour Film", "Eras Tour Night", "Fan List Concert", "Rated Once Concert", "Old Popular Concert"].includes(i.title)));
});

// ── what a music film is ─────────────────────────────────────────────────────

// The REAL records of cache/tmdb.json (sha256 0d59804fefee…, 21/10/2026): the decision of isMusicFilm on each, as it is today. [imdb, title, genres, keywords, is a music film, why]
const REAL = [
  ["tt40341984", "Harry Styles. One Night in Manchester.", ["Music"], ["concert", "music"], true, "the keyword concert alone"],
  ["tt31013163", "Lady Gaga: MAYHEM on the Beach", ["Music", "TV Movie"], ["mayhem", "inspirational", "grand", "live concert", "admiring", "adoring", "amused", "celebratory", "cheerful"], true, "the keyword live concert alone"],
  ["tt38673135", "Taylor Swift | The Eras Tour | The Final Show", ["Music"], ["pop music", "concert film", "vancouver", "music documentary", "music", "commanding"], true, "concert film, and Tour in the title"],
  ["tt42615436", "Apple Music Live: Lady Gaga MAYHEM Requiem", ["Music"], ["nostalgic"], true, "no keyword says it: the word Live in the title"],
  ["tt36963991", "Wicked: One Wonderful Night", ["Music"], ["tv special", "joyous", "musical performance"], true, "a performance special: the keyword musical performance (22/10/2026)"],
  ["tt37172278", "Noah Kahan: Out of Body", ["Documentary", "Music"], ["family", "candid", "touring", "music documentary", "intimate", "sincere", "vulnerable"], true, "Music and Documentary (the border: a tour documentary)"],
  ["tt26931594", "Man on the Run", ["Documentary", "Music"], ["musician", "archive footage", "music recording", "cult music band", "portrait of an artist", "music documentary", "quest for identity", "life and career", "behind the music", "famous song", "music band", "former musician"], true, "Music and Documentary"],
  ["tt0088178", "Stop Making Sense", ["Documentary", "Music"], ["concert", "rock 'n' roll", "rock band", "concert film", "post-punk", "energetic", "exuberant", "new wave music"], true, "Music and Documentary, and concert film"],
  ["tt0077838", "The Last Waltz", ["Documentary", "Music"], ["rock 'n' roll", "1970s"], true, "Music and Documentary alone"],
  ["tt1754109", "Les Misérables: 25th Anniversary in Concert", ["History", "Music"], ["based on novel or book", "musical", "live performance"], true, "a real concert film whose genres are History and Music: why the rule does not narrow by the other genres"],
  // the known false positives: FICTION films with the Music genre and a live keyword are marked (the rule reads genres and keywords, not the nature of the film)
  ["tt26753003", "Trap", ["Crime", "Thriller", "Horror", "Music"], ["concert", "philadelphia, pennsylvania", "double life", "escape", "s.w.a.t.", "pop star", "father", "limousine", "celebrity", "trap", "serial killer", "obsessive compulsive disorder (ocd)", "trapped", "mental illness", "sting operation", "mayhem", "father daughter relationship", "plot twist"], true, "KNOWN FALSE POSITIVE: a thriller, marked by the keyword concert"],
  ["tt1517451", "A Star Is Born", ["Music", "Drama", "Romance"], ["concert", "country music", "waitress", "pop star", "singer", "fame"], true, "KNOWN FALSE POSITIVE: fiction, marked by the keyword concert"],
  ["tt0358273", "Walk the Line", ["Drama", "Music", "Romance"], ["prison", "adultery", "concert", "rock 'n' roll", "country music"], true, "KNOWN FALSE POSITIVE: a biopic, marked by the keyword concert"],
  // not marked
  ["tt2582802", "Whiplash", ["Drama", "Music", "Thriller"], ["new york city", "jazz", "musician", "obsession", "music teacher", "conservatory", "drums", "jazz band", "music school"], false, "Music genre, no Documentary, no live keyword, no title word"],
  ["tt3783958", "La La Land", ["Comedy", "Drama", "Romance"], ["dancing", "dance", "jazz", "musical", "one-woman show", "jazz club"], false, "no Music genre"],
  ["tt44766123", "NAZA", ["Documentary"], ["palestinian-israeli conflict", "interview", "rooftop", "whistleblower"], false, "a documentary with no Music genre"],
  ["tt30252752", "Dying for Sex", [], [], false, "a record with no genre"],
];

test("isMusicFilm on the REAL records of the cache (21/10/2026): the decision on each, the known false positives written down", () => {
  for (const [tt, title, genres, keywords, expected, why] of REAL) assert.equal(P.isMusicFilm({ title, detail: { genres, keywords } }), expected, `${title}: ${why}`);
  assert.equal(P.isMusicFilm({ title: "Eras Tour", detail: null }), false); // no TMDB record at all: a missing fact is never guessed
  assert.equal(P.isMusicFilm({ title: "Eras Tour" }), false);
});

// every word of the rule must DECIDE something (a mutation that drops one word has to turn a test red): a synthetic film with the Music genre and nothing else
const LIVE_WORDS = ["concert", "concert film", "live performance", "live concert", "live musical performance", "musical performance", "live show", "live music", "music live", "concert footage", "rock concert", "music concert", "live", "touring", "stage performance"];
test("isMusicFilm: each of the 15 live keywords alone makes a Music film a music film, a keyword that is not on the list does not, and the comparison ignores case", () => {
  for (const kw of LIVE_WORDS) {
    assert.equal(P.isMusicFilm({ title: "Night", detail: { genres: ["Music"], keywords: ["tv special", kw] } }), true, kw);
    assert.equal(P.isMusicFilm({ title: "Night", detail: { genres: ["Music"], keywords: [kw.toUpperCase()] } }), true, kw + " in capitals");
    assert.equal(P.isMusicFilm({ title: "Night", detail: { genres: ["Drama"], keywords: [kw] } }), false, kw + " without the Music genre");
  }
  assert.equal(LIVE_WORDS.length, 15);
  for (const kw of ["tv special", "music", "pop music", "musician", "singer", "music documentary", "concert hall", "livestream", "nostalgic"]) assert.equal(P.isMusicFilm({ title: "Night", detail: { genres: ["Music"], keywords: [kw] } }), false, kw);
});

test("isMusicFilm: each of the 5 title words alone makes a Music film a music film, as a whole word and in any case; Tourist, Alive and Delivery do not", () => {
  const music = (title) => P.isMusicFilm({ title, detail: { genres: ["Music"], keywords: [] } });
  for (const [title, word] of [["Night on Tour", "tour"], ["Live at the Garden", "live"], ["A Concert for Peace", "concert"], ["Nirvana Unplugged in New York", "unplugged"], ["Band Reunion In Cinemas", "in cinemas"], ["night on TOUR", "tour"]]) assert.equal(music(title), true, word + ": " + title);
  for (const title of ["Tourist Trap", "Delivery Alive", "Outlive", "Concerto for Two", "In Cinema", "Unplug"]) assert.equal(music(title), false, title);
  assert.equal(P.isMusicFilm({ title: "Night on Tour", detail: { genres: ["Drama"], keywords: [] } }), false); // the Music genre is always required
  assert.equal(P.isMusicFilm({ title: "Plain", detail: { genres: ["Music", "Documentary"], keywords: [] } }), true); // and the Documentary genre needs nothing else
});

// ── the thresholds are the card's ────────────────────────────────────────────

test("personEvidence: the thresholds are the ones of reasons() (director ≥ 2 films, cast ≥ 3, weight above 0.12) and it names persons only", () => {
  const c = (type, n, w) => ({ type, n, w, label: type + n });
  assert.equal(personEvidence([c("director", 1, 0.9)]).length, 0); // one film
  assert.equal(personEvidence([c("director", 2, 0.9)]).length, 1);
  assert.equal(personEvidence([c("cast", 2, 0.9)]).length, 0);
  assert.equal(personEvidence([c("cast", 3, 0.9)]).length, 1);
  assert.equal(personEvidence([c("director", 2, 0.12)]).length, 0); // the weight must be ABOVE 0.12
  assert.equal(personEvidence([c("director", 2, 0.121)]).length, 1);
  assert.equal(personEvidence([c("director", 2, -0.5)]).length, 0); // a director he rates badly is no evidence
  for (const type of ["keyword", "genre", "country", "lang", "decade"]) assert.equal(personEvidence([c(type, 99, 0.9)]).length, 0, type); // not a person
  assert.equal(personEvidence(undefined).length, 0);
  // the card says "you rate X" exactly where the rule says "person": same thresholds
  assert.deepEqual({ director: REASON_MIN_N.director, cast: REASON_MIN_N.cast }, { director: 2, cast: 3 });
  assert.equal(reasons([{ type: "director", n: 2, w: 0.5, label: "D", avg: 4.5 }], 1).length, 1);
  assert.equal(reasons([{ type: "director", n: 1, w: 0.5, label: "D", avg: 4.5 }], 1).length, 0);
});

// ── wiring: the config, the people, the build ────────────────────────────────

test("config.json: the rule is on for Marco's build; Top 100 Concert Films is a fan list (grants nothing) and a critics' list is a door; New for you keeps the window of the last two years", () => {
  const o = P.musicOptions(CONFIG);
  assert.equal(o.needsEvidence, true);
  assert.equal(o.vouchLists.has("asnPI"), false); // Top 100 Concert Films (Letterboxd): trust fan
  assert.equal(CONFIG.lists.find((l) => l.id === "asnPI").trust, "fan");
  assert.equal(o.vouchLists.has("WaoLy"), true); // Tuning In: Sonic Journeys (MUBI): trust critic
  assert.equal(o.vouchLists.size, CONFIG.lists.filter((l) => l.trust === "critic" || l.trust === "director").length);
  const n = P.newRowOptions(CONFIG, { today: "2026-10-22", size: CONFIG.sizes.row });
  assert.deepEqual(n, { fromYear: 2025, size: 100 }, "the window is the last two years, and the row asks nothing about music itself any more"); // size: sizes.row, 100 since 14/11/2026 ("Up to 100 in every row"; it was 50)
});

test("the rule is Marco's build only: a person's derived config (Will) does not carry it, so his rows are built as before", () => {
  const will = PEOPLE.deriveConfig(CONFIG, { id: "friend-a" });
  assert.equal(will.music, undefined);
  assert.equal(will.newReleases, undefined);
  const g = P.musicGate({ options: P.musicOptions(will), recOf: (tt) => recs.find((r) => r.id === tt) || null });
  assert.deepEqual(titles(P.newRow(recs.filter((r) => g.ok(r.id)), { ...P.newRowOptions(will, { today: "2026-10-22", size: will.sizes.row }), size: 50, fromYear: 2025 })), ALL); // the same world: every film stays
});

test("build.js makes New for you from the films that pass the gate", () => {
  const src = fs.readFileSync(path.join(ROOT, "build.js"), "utf8");
  assert.match(src, /const newRowOpts = P\.newRowOptions\(cfg, \{ today, size: sizes\.row \}\);/);
  assert.match(src, /newforyou: P\.newRow\(features, newRowOpts\),/); // `features`: `passing` without the shorts (14/11/2026, test/shorts-floor.test.js)
  assert.match(src, /const features = passing\.filter\(/);
});
