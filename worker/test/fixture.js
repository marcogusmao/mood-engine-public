// A small index made by hand, with known answers. Shaped exactly like lib/index-export.js writes it
// (test/worker.test.js reads the real one too, when the caches are there).

import { createRequire } from "node:module";
import { words } from "../src/text.js";
import { hydrate } from "../src/film.js";

const require = createRequire(import.meta.url);
const rows = require("../../lib/index-rows.js"); // the build's encoder: the fixture goes through the same file format as the real index
const exporter = require("../../lib/index-export.js"); // and is cut into pieces by the build's own function

const MOODS = [
  { id: "night", label: "Nocturnal", name: "🌃 Night drive" },
  { id: "lift", label: "Uplift", name: "☀️ Lift me out" },
];
const LISTS = [
  { id: "cannes", label: "Cannes Winners (moviewithus)", short: "Cannes Winners", popular: false, films: 4 }, // `short`: the Discover menu entry since 22/10/2026 (Marco); `label` stays the full name the older installs ask for
  { id: "crit", label: "All-time Criterion Closet Picks (closetpicks)", short: "Closet Picks · all-time", popular: false, films: 6 },
];
const PEOPLE = ["Gustavo", "William"];

/** [tt, name, year, runtime, countries, director, extras] */
const FILMS = [
  ["tt0000001", "The Killing", 1956, 85, ["United States"], "Stanley Kubrick", { lbRating: 4.2, imdbRating: 8.4, seenBy: 11, friendsAvg: 4.1, wantBy: 2, rank: 2.0, moods: { night: [1.2, 3.0] }, lists: { crit: 5 }, genres: ["Crime", "Thriller"], keywords: ["noir"], friends: { seenBy: [["Gustavo", 4.5]], wantBy: ["William"], friendsAvg: 4.5 } }],
  ["tt0000002", "Paths of Glory", 1957, 88, ["United States"], "Stanley Kubrick", { lbRating: 4.3, rank: 1.5, moods: { night: [1.0, 2.6] }, lists: { crit: 9 }, genres: ["War", "Drama"] }],
  ["tt0000003", "Killer's Kiss", 1955, 67, ["United States"], "Stanley Kubrick", { lbRating: 3.5, rank: 0.5, moods: { night: [0.9, 2.2] }, genres: ["Crime"] }],
  ["tt0000004", "Breathless", 1960, 90, ["France"], "Jean-Luc Godard", { lbRating: 3.9, rank: 1.0, moods: { night: [1.1, 2.0] }, lists: { crit: 2 } }],
  ["tt0000005", "Pierrot le Fou", 1965, 110, ["France", "Italy"], "Jean-Luc Godard", { lbRating: 4.0, rank: 1.2, lists: { crit: 3 }, friends: { seenBy: [["William", 3.5]], wantBy: [] } }],
  ["tt0000006", "Rashomon", 1950, 88, ["Japan"], "Akira Kurosawa", { lbRating: 4.3, seenBy: 3, poster: "https://pages.test/posters/tt0000006.jpg", rank: 1.8, lists: { cannes: 1, crit: 1 } }],
  ["tt0000007", "Ikiru", 1952, 143, ["Japan"], "Akira Kurosawa", { lbRating: 4.4, rank: 1.9, lists: { crit: 4 } }],
  ["tt0000008", "Seven Samurai", 1954, 207, ["Japan"], "Akira Kurosawa", { lbRating: 4.5, rank: 2.2, lists: { crit: 6 } }],
  ["tt0000009", "Amélie", 2001, 122, ["France"], "Jean-Pierre Jeunet", { lbRating: 4.1, imdbRating: 8.3, wantBy: 5, rank: 0.9, moods: { lift: [1.3, 2.8] }, keywords: ["heartwarming"] }],
  ["tt0000010", "Pulp Fiction", 1994, 154, ["United States"], "Quentin Tarantino", { lbRating: 4.2, rank: 1.1, lists: { cannes: 3 }, moods: { night: [1.0, 2.5] } }],
  ["tt0000011", "Reservoir Dogs", 1992, 99, ["United States"], "Quentin Tarantino", { lbRating: 4.0, rank: 0.8 }],
  ["tt0000012", "Nights of Cabiria", 1957, 110, ["Italy"], "Federico Fellini", { lbRating: 4.3, rank: 1.4, moods: { night: [1.2, 2.9] } }],
  ["tt0000013", "8½", 1963, 138, ["Italy"], "Federico Fellini", { lbRating: 4.3, rank: 1.3 }],
  ["tt0000014", "A Very Short Film", 1998, 12, ["France"], null, { lbRating: 4.4, rank: 0.7 }],
  ["tt0000015", "No Facts At All", 2005, null, null, null, { rank: -0.5 }], // no Letterboxd average and no friend's rating: not eligible
  ["tt0000016", "Only TMDB Votes", 2010, 100, ["Spain"], null, { tmdbRating: 7.6, tmdbVotes: 900, rank: 0.1, eligible: true }], // no Letterboxd average, but a configured friend rated it 4★: eligible
  ["tt0000017", "Night on Earth", 1991, 129, ["United States", "France"], "Jim Jarmusch", { lbRating: 3.8, rank: 0.6, moods: { night: [1.0, 2.4] } }],
  ["tt0000018", "Wild at Heart", 1990, 125, ["United States"], "David Lynch", { lbRating: 3.7, rank: 0.4, moods: { night: [1.1, 2.7] } }],
  ["tt0000019", "Palme Winner You Saw", 1994, 130, ["France"], "Someone Else", { lbRating: 4.0, seen: true, lists: { cannes: 2 } }],
  ["tt0000020", "Old Friend You Saw", 1980, 100, ["United States"], "Someone Old", { lbRating: 4.5, seen: true }],
  ["tt0000021", "The Killing of a Sacred Deer", 2017, 121, ["United Kingdom", "Ireland"], "Yorgos Lanthimos", { lbRating: 3.6, rank: 0.3, genres: ["Drama", "Horror"] }],
  ["tt0000022", "Wild Strawberries", 1957, 91, ["Sweden"], "Ingmar Bergman", { lbRating: 4.4, rank: 1.6, lists: { cannes: 4, crit: 7 } }],
  ["tt0000023", "Stalker", 1979, 162, ["Soviet Union"], "Andrei Tarkovsky", { lbRating: 4.3, rank: 1.7, moods: { night: [1.4, 3.2] } }],
  ["tt0000025", "Seen But Nocturnal", 1993, 100, ["United States"], "Someone Nocturnal", { lbRating: 4.4, seen: true, moods: { night: [1.9, 9.9] }, lists: { crit: 8 } }], // a film you have seen that fits a mood: the mood's own top rank, and it must never be served there
  ["tt0000029", "Just Below The Floor", 1972, 100, ["Sweden"], "Floor Tester", { lbRating: 3.49, rank: 0.9, moods: { night: [1.0, 2.3] }, lists: { crit: 10 }, genres: ["Drama"] }], // Letterboxd 3.49: under the 3.5 floor
  ["tt0000030", "Low TMDB Only", 1973, null, null, null, { tmdbRating: 5.0, tmdbVotes: 800, rank: 0.35 }], // no Letterboxd average, a TMDB vote that would be 2.5★: the floor reads Letterboxd only, so it passes
  ["tt0000026", "M", 1931, null, null, null, { rank: 0.03, eligible: true }], // no facts but the year: here for the decade words of a search (30s)
  ["tt0000027", "Casablanca", 1942, null, null, null, { rank: 0.02, eligible: true }],
  ["tt0000028", "Anora", 2024, null, null, null, { rank: 0.01, eligible: true }],
  ["tt0000031", "Rescued By A Friend", 1973, 100, ["Sweden"], "Rescue Tester", { lbRating: 3.2, rank: 0.15, eligible: true, moods: { night: [0.9, 1.5] }, genres: ["Drama"] }], // Letterboxd 3.2 (under 3.5), but a configured friend gave it 4★: eligible
  ["tt0000024", "A Night to Remember", 1958, 123, ["United Kingdom"], "Roy Ward Baker", { lbRating: 3.9, rank: 0.2, moods: { night: [0.95, 1.9] } }],
];

/** The index in object form (what lib/index-export.js buildIndex() returns). */
export function makeObject(extra = {}) {
  const films = FILMS.map(([tt, name, year, runtime, countries, director, x]) => {
    const e = { tt, name, year, decade: `${Math.floor(year / 10) * 10}s` };
    if (runtime != null) e.runtime = runtime;
    if (countries) e.countries = countries;
    if (director) e.director = director;
    const { moods, lists, friends, keywords, genres, ...rest } = x;
    Object.assign(e, rest);
    if (moods) e.moods = moods;
    if (lists) e.lists = lists;
    if (friends) e.friends = friends;
    if (genres) e.genres = genres;
    if (keywords) e.keywords = keywords;
    if (e.eligible === undefined && e.lbRating >= 3.5) e.eligible = true; // the build's rule: an average of 3.5 or more (a friend's rating is the other way in, set by hand above)
    if (!e.eligible) delete e.eligible;
    e.desc = `${name} cast\n${name} genres · ${name} keywords.\n\nA synopsis of ${name}.`; // the build's `desc`: "<actors>\n<line 2>", the separator, the synopsis (lib/describe.js liveDescription; a film's general text has no mood)
    e.find = " " + [name, director || "", (keywords || []).join(" "), (genres || []).join(" "), (countries || []).join(" ")].map(words).join(" | ");
    return e;
  });
  // best rank first, films with no rank last: how lib/index-export.js writes them
  films.sort((a, b) => (b.rank ?? -Infinity) - (a.rank ?? -Infinity) || a.tt.localeCompare(b.tt));
  return {
    meta: {
      builtAt: "2026-10-10T12:00:00.000Z", version: "2.1.0", schema: 1, part: "full", separator: "\n\n", today: "2026-10-10", count: films.length, loveStars: 4, minFeatureMinutes: 40, shortMaxMinutes: 95,
      decades: ["1920s", "1930s", "1940s", "1950s", "1960s", "1970s", "1980s", "1990s", "2000s", "2010s", "2020s"], countries: ["United States", "France", "Japan", "Italy", "United Kingdom"],
    },
    moods: MOODS, lists: LISTS,
    friends: {
      people: PEOPLE,
      options: [
        { label: "Top · Gustavo", ids: ["tt0000010", "tt0000001", "tt0000006", "tt0000029"] }, // the last is under the floor, which Friends does not apply
        { label: "Watch together · William", ids: ["tt0000009", "tt0000019", "tt0000013"] }, // the middle one is seen: it must never be served
      ],
    },
    board: [{ id: "tonight", name: "🎯 Tonight" }, { id: "oldfriends", name: "📼 Old friends" }],
    rowDesc: { tonight: ["The Killing cast\nMood: ☀️ Lift me out · Crime, Thriller · heist.", "Amélie cast\nMood: ☀️ Lift me out · Comedy.", "Old Friend cast\nMood: ☀️ Lift me out · Drama.", "Floor cast\nMood: ☀️ Lift me out."], oldfriends: ["Old Friend cast\nDrama · memory."] }, // each row's own text: "<actors>\n<line 2>", line 2 finished: "Mood: <the row's mood> · …" in a mood row (Tonight), the genres alone in a row that is not (lib/describe.js liveDescription)
    rows: { tonight: ["tt0000001", "tt0000009", "tt0000020", "tt0000029"], oldfriends: ["tt0000020"] }, // a seen film in tonight must never be served; in oldfriends it is the point; the last is under the floor, which Board rows do not apply
    films,
    ...extra,
  };
}

/** The same index with the friends' ids dropped from the options and only the Board's films: the file index-board.json, object form. */
export function makeBoardObject() {
  const ix = makeObject();
  const keep = new Set(Object.values(ix.rows).flat());
  return { ...ix, meta: { ...ix.meta, part: "board", count: ix.films.filter((f) => keep.has(f.tt)).length }, friends: { people: ix.friends.people, options: ix.friends.options.map((o) => ({ label: o.label, ids: [] })) }, films: ix.films.filter((f) => keep.has(f.tt)) };
}

/** Object form → the text of the file → ready to use, exactly the road the real index takes. */
export const textOf = (obj) => JSON.stringify(rows.encode(obj));
export const readyOf = (obj) => hydrate(JSON.parse(textOf(obj)));
export const makeIndex = () => readyOf(makeObject());
export const makeIndexText = () => textOf(makeObject());
export const makeBoardIndex = () => readyOf(makeBoardObject());
export const makeBoardText = () => textOf(makeBoardObject());
/** Every file the build would publish for the fixture, by file name: index.json, index-board.json, index-moods.json, index-friends.json, index-list-<id>.json. */
export function makeFiles() {
  const o = makeObject();
  const files = { "index.json": textOf(o) };
  for (const p of exporter.pieces(o)) files[p.rel.split("/").pop()] = textOf(p.obj);
  return files;
}
/** The file text with one change made to its parsed form: for tests of a bad or a different file. */
export const tweak = (text, fn) => { const j = JSON.parse(text); fn(j); return JSON.stringify(j); };

export const names = (entries) => entries.map((e) => e.name);

// ── the v2 family (lib/index-export.js pieces2; Worker 3.3.0, 14/10/2026) ────────────────────────────────────────────────────────

/**
 * A legacy-shaped index object → the same index as the v2 family has it: every Board entry has a `place` ("board", unless `menu` names it, an object row id → its label in the
 * Moods menu), the series row is an entry (`series: true`, third), the Moods menu `moodMenu` lists the moods' labels then the menu rows, and the country menu is frozen in
 * `meta.countriesAll` (the legacy `countries` plus two, Poland and Iran).
 */
export function v2ObjectFrom(o, { menu = {} } = {}) {
  const board = o.board.map((b) => ({ id: b.id, name: b.name, place: b.id in menu ? "menu" : "board" }));
  board.splice(Math.min(2, board.length), 0, { id: "my-series", name: "📺 Series to watch", place: "board", series: true });
  return {
    ...o,
    meta: { ...o.meta, countriesAll: [...(o.meta.countries || []), "Poland", "Iran"] },
    moodMenu: [...o.moods.map(({ id, label }) => ({ id, label })), ...Object.entries(menu).map(([id, label]) => ({ id, label }))],
    board,
    rows: { ...o.rows, "my-series": [] },
    rowDesc: { ...o.rowDesc, "my-series": [] },
  };
}
/** The files of the v2 family for a v2 object, by file name: index-v2.json, index-v2-menus.json, index-v2-row-<id>.json, index-v2-mood-<id>.json (the build's own cutter). */
export function v2FilesOf(ix) {
  const files = { "index-v2.json": textOf(ix) };
  for (const p of exporter.pieces2(ix)) files[p.rel.split("/").pop()] = textOf(p.obj);
  return files;
}

/**
 * The fixture index as the v2 family has it: a third mood (Noir, in no legacy file), a Board of tonight, Old friends, Europe (a row the legacy Board never had) and the series row,
 * and Friends this week as a menu row. Friends this week holds a film that fails the recommendation rule (Just Below The Floor) and one the Marco has seen (Palme Winner You Saw):
 * as a row it serves the first and not the second, and an eligibility rule applied to it would drop the first.
 */
export function makeV2Object() {
  const o = makeObject();
  const NOIR = { tt0000001: [1.5, 3.1], tt0000002: [1.2, 2.5], tt0000004: [1.1, 2.2], tt0000025: [1.9, 9.9], tt0000029: [1.0, 2.0], tt0000015: [0.9, 1.0] }; // a seen film (…25), and two the rule keeps out (…29, …15)
  const films = o.films.map((f) => (NOIR[f.tt] ? { ...f, moods: { ...(f.moods || {}), noir: NOIR[f.tt] } } : f));
  const board = [{ id: "tonight", name: "🎯 Tonight: 10 picks" }, { id: "oldfriends", name: "📼 Worth watching again" }, { id: "europe", name: "🇪🇺 Europe" }, { id: "friends-week", name: "👥 Friends watched this week" }];
  const rows = { tonight: ["tt0000001", "tt0000009", "tt0000020", "tt0000029"], oldfriends: ["tt0000020"], europe: ["tt0000004", "tt0000005", "tt0000009", "tt0000012", "tt0000022", "tt0000014"], "friends-week": ["tt0000010", "tt0000029", "tt0000019"] };
  const nameOf = Object.fromEntries(board.map((b) => [b.id, b.name]));
  const byTt = new Map(films.map((f) => [f.tt, f]));
  const rowDesc = Object.fromEntries(Object.entries(rows).map(([id, tts]) => [id, tts.map((tt) => `${byTt.get(tt).name} cast\n${id === "tonight" ? `Mood: ${nameOf[id]} · ` : ""}genres of the row.`)]));
  return v2ObjectFrom({ ...o, films, board, rows, rowDesc, moods: [...o.moods, { id: "noir", label: "Noir", name: "🌃 Noir" }] }, { menu: { "friends-week": "Friends this week" } });
}
export const makeV2Files = () => ({ ...makeFiles(), ...v2FilesOf(makeV2Object()) });
