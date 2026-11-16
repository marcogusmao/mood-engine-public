// node --test            (no dependencies)
// The gate in front of the ranking and the rows made of it (Marco, 13/10/2026, PR2 of the 54-row Board): `where` with ISO countries, regions, years, language and the Letterboxd
// average and count; the six decades; the nine regions; "Documentaries" (Documentary required) and "Hidden gems" (under 10,000 ratings, 3.8 or more); the watchlist by the date added.
// The first half is synthetic films. The second builds the whole Board offline from the caches of the repository (test/fixtures/board-v2-pr2.json) and reads what was published.
//
// Mutations this file is meant to turn red (recorded in the commit of 13/10/2026):
//   the `where` gate ignored (an American film falls in "Europe")                      → "a filter row: only films that pass", the real "Europe"
//   the ISO replaced by the cover's flag (a film of East Germany falls in "Europe")     → "main country", "regions", "the real caches: East Germany"
//   the watchlist ordered by taste instead of by the page's position                   → "watchlist: the page's order", the real "watchlist"
//   without the page, the watchlist ordered by position instead of by date added       → "watchlist: without the page"
//   Documentary no longer required for "Documentaries"                                  → "docs"
//   the Letterboxd count no longer bounds "Hidden gems"                                 → "hidden"
//   mood and combined rows ignoring the ceiling of two rows                             → "the real caches: a film is in at most two"

const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const C = require("../lib/countries");
const BR = require("../lib/board-rows");
const { compile, passes, validateWhere, fit } = require("../lib/moods");
const { decode } = require("../lib/index-rows");
const CONFIG = require("../lib/board-shared").legacyConfig(require("../config.json")); // PR5 (14/10/2026): config.json carries the Board now; these tests lay their own fixture board on the config WITHOUT it and with the nine legacy moods
const FV = require("../lib/friend-view");
const FRIEND_PIECES = new Set(FV.slugsOf(CONFIG.friends.map((f) => f.name || f.user)).map(FV.pieceName)); // the friends' watchlist pieces (29/10/2026): files next to the rows that are not Board rows
const FIXTURE = require("./fixtures/board-v2-pr2.json");

const ROOT = path.join(__dirname, "..");
let n = 0;
function cand(o = {}) {
  const id = ++n;
  const film = { id, imdb: `tt${String(id).padStart(7, "0")}`, title: `Film ${id}`, year: 1990, runtime: 100, genres: ["Drama"], keywords: [], directors: [{ id: 5000 + id, name: `Director ${id}` }], countries: ["US"], lang: "en", va: 7, vc: 100, overview: "", poster: null, ...o.film };
  return { id, film, tasteZ: 0, qualityZ: 0, contributions: [], seeds: [], pins: [], recCount: 0, ...o.cand };
}
const spec = (ids, rows = {}) => ({ entries: ids.map((id) => ({ id, name: id, place: "board" })), rows, legacyMoods: [] });
const SIZES = { discover: 100, moodRepeatWindow: 30, watchlist: 100, row: 50 };
const run = (cands, spec_, moods = [], extra = {}) => BR.buildBoardRows({ cands, moods, legacy: new Set(), ranked: {}, spec: spec_, cfg: { sizes: SIZES }, today: "2026-10-13", ...extra });
const ids = (items) => items.map((i) => i.id);
const moodOf = (id) => compile(FIXTURE.moods.filter((m) => m.id === id))[0];

// ── the main country ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("main country: the first production country that speaks the film's language, as TMDB's ISO code and not as the flag the cover draws", () => {
  assert.equal(C.mainIso({ countries: ["XG"], lang: "de" }), "XG", "East Germany: its flag is Germany's, its code is not");
  assert.equal(C.mainIso({ countries: ["SU"], lang: "ru" }), "SU");
  assert.equal(C.mainIso({ countries: ["XC"], lang: "cs" }), "XC");
  assert.equal(C.mainIso({ countries: ["YU"], lang: "sr" }), "YU");
  assert.equal(C.mainIso({ countries: ["US", "FR"], lang: "fr" }), "FR", "a French-language film with an American co-producer first");
  assert.equal(C.mainIso({ countries: ["FR", "BR"], lang: "pt" }), "BR");
  assert.equal(C.mainIso({ countries: ["FR", "DE", "PL", "GB"], lang: "en" }), "GB");
  assert.equal(C.mainIso({ countries: ["JP"], lang: "xx" }), "JP", "no spoken language: the first production country");
  assert.equal(C.mainIso({ countries: ["XG"], lang: "xx" }), "XG", "East Germany without a language: still its own code");
  assert.equal(C.mainIso({ countries: ["SU", "US"], lang: "ja" }), "JP", "none of them speaks Japanese: Japan, the language's home, and not the first producer");
  assert.equal(C.mainIso({ countries: ["GB", "US"], lang: "en" }), "US", "a tie between anglophone producers: the US wins, so Fargo is American");
  assert.equal(C.mainIso({ countries: ["US", "GB"], lang: "en" }), "US", "whatever the order TMDB lists them in");
  assert.equal(C.mainIso({ countries: ["GB", "IE"], lang: "en" }), "GB", "British only when the US is not among the producers");
  assert.equal(C.mainIso({ countries: ["IE", "GB"], lang: "en" }), "IE", "and the first of them otherwise");
  assert.equal(C.mainIso({ countries: ["GB", "US"], lang: "es" }), "MX", "Spanish with no Spanish-speaking producer: Latin America (Roma, Cuarón)");
  assert.equal(C.mainIso({ countries: ["FR", "MA", "DE", "NL", "PS"], lang: "ar" }), "PS", "Arabic: of the Arabic-speaking producers, the one in the region of the language's centre (Egypt's: the Middle East), so Palestine and not Morocco");
  assert.equal(C.mainIso({ countries: ["MA", "FR"], lang: "ar" }), "MA", "and Morocco when no producer is in that region");
  assert.equal(C.mainIso({ countries: ["BR", "PT"], lang: "pt" }), "BR", "outside English and Arabic the first producer that speaks the language, in TMDB's order, wins");
  assert.equal(C.mainIso({ countries: ["PT", "BR"], lang: "pt" }), "PT", "whichever of them TMDB lists first (Marco, 14/10/2026: no table of centres for the other languages)");
  assert.equal(C.mainIso({ countries: ["CA", "IE", "GB"], lang: "en" }), "IE", "GB or IE without the US is british whatever comes first: IE here, ahead of GB");
  assert.equal(C.mainIso({ countries: ["AU", "CA", "NZ", "GB"], lang: "en" }), "GB", "GB over a CA/AU/NZ listed first");
  assert.equal(C.mainIso({ countries: ["AU", "NZ"], lang: "en" }), "AU", "CA, AU and NZ alone: the first of them, which is in no region");
  assert.equal(C.mainIso({ countries: ["IT", "GB"], lang: "la" }), "IT", "Latin has no home (the table says the Vatican): the first producer");
  assert.equal(C.mainIso({ countries: ["HK"], lang: "en" }), "HK", "in English with no producer that speaks it: the first producer, English has no home (Marco, 14/10/2026)");
  assert.equal(C.mainIso({ countries: ["DK", "SE"], lang: "en" }), "DK", "a Danish production in English: Denmark");
  assert.equal(C.mainIso({ countries: ["DE", "FR"], lang: "en" }), "DE", "a German one: Germany");
  assert.equal(C.mainIso({ countries: ["DK", "US"], lang: "en" }), "US", "but with the US among the producers: American");
  assert.equal(C.mainIso({ countries: ["DK", "IE"], lang: "en" }), "IE", "and with Ireland and no US: Ireland, hence british");
  // a Soviet or Czechoslovak film whose language is one of the republics' stays in the Eastern bloc, by the language's home when no producer speaks it
  for (const [countries, lang, iso] of [[["SU"], "ka", "GE"], [["SU"], "uk", "UA"], [["SU"], "lv", "LV"], [["SU"], "et", "EE"], [["XC"], "sk", "SK"], [["XC"], "cs", "XC"], [["YU"], "hr", "HR"]]) {
    assert.equal(C.mainIso({ countries, lang }), iso, `${countries} in ${lang}`);
    assert.ok(C.inRegion(iso, "eastern-bloc"), `${iso} is in the Eastern bloc`);
  }
  assert.equal(C.mainIso({ countries: [], lang: "en" }), null);
  assert.equal(C.mainIso({ countries: ["us"], lang: "en" }), "US", "upper case");
  // the flag of the same film is the other thing, and for East Germany it is Germany
  assert.equal(C.pickCountry({ tmdb: ["XG"], lang: "de" }).cc, "de");
});

// Films the review and Marco named (13/10/2026, 14/10/2026), by TMDB id, with the two facts mainIso reads FROZEN as the TMDB cache of 13/10/2026 had them (the cache is rewritten every night:
// 14 of these entries were fetched again on 24/11): the region each belongs to, by the rule "the language rules; ties by TMDB's order, except the US in English and the Middle East in Arabic".
const FILMS = {
  275: { title: "Fargo", countries: ["GB","US"], lang: "en" },
  11778: { title: "The Deer Hunter", countries: ["GB","US"], lang: "en" },
  581: { title: "Dances with Wolves", countries: ["GB","US"], lang: "en" },
  4347: { title: "Atonement", countries: ["FR","GB","US"], lang: "en" },
  627: { title: "Trainspotting", countries: ["GB"], lang: "en" },
  426426: { title: "Roma", countries: ["GB","US"], lang: "es" },
  89708: { title: "Samsara", countries: ["BR","CN","DK","EG","ET","GH","ID","IT","JP","JO","NA","SA","KR","TH","AE","US"], lang: "en" },
  47324: { title: "Cairo Station", countries: ["EG"], lang: "ar" },
  27744: { title: "Divine Intervention", countries: ["FR","MA","DE","NL","PS"], lang: "ar" },
  5801: { title: "Pather Panchali", countries: ["IN"], lang: "bn" },
  11423: { title: "Memories of Murder", countries: ["KR"], lang: "ko" },
  16: { title: "Dancer in the Dark", countries: ["DK","FI","FR","DE","IS","NL","NO","SE"], lang: "en" },
  390: { title: "Lisbon Story", countries: ["DE","PT","FR","ES"], lang: "en" },
  265228: { title: "Timbuktu", countries: ["FR"], lang: "fr" },
  167073: { title: "Brooklyn", countries: ["CA","IE","GB"], lang: "en" },
  600583: { title: "The Power of the Dog", countries: ["AU","CA","NZ","GB"], lang: "en" },
  9659: { title: "Mad Max", countries: ["AU"], lang: "en" },
  566213: { title: "Honeyland", countries: ["MK"], lang: "tr" },
  889699: { title: "Holy Spider", countries: ["DK","JO","FR","DE","SE"], lang: "fa" },
  42241: { title: "Sebastiane", countries: ["IT","GB"], lang: "la" },
  93858: { title: "Tabu", countries: ["BR","FR","DE","PT"], lang: "pt" },
  1417: { title: "Pan's Labyrinth", countries: ["MX","ES","US"], lang: "es" },
};
const regionOfFilm = (id) => { const f = FILMS[id], iso = C.mainIso(f); return { title: f.title, iso, regions: Object.keys(C.REGIONS).filter((r) => r !== "latam-hisp" && iso && C.inRegion(iso, r)) }; };

// 22/10/2026: this test pins mainIso, the rule of 13/10 and 14/10/2026 WITHOUT TMDB's origin_country, which mainCountry (lib/countries.js) now tries first and falls back to when the record has none.
// The facts below are frozen without `origin` on purpose, so the title describes the fallback rule. With the origins of 22/10/2026 six of these 22 films changed region (Atonement, Roma, Honeyland,
// Holy Spider, The Power of the Dog, Sebastiane): test/origin-country.test.js pinned that; on 23/10/2026 Marco added the director's country on top, and the same 22 films under the rule that
// decides now are pinned by "the films Marco named, under the rule of 23/10/2026" below.
test("main country, the films Marco named: the American co-productions are American, the language decides the rest", () => {
  const want = [
    [275, "Fargo", "US", []], // GB + US, English: the US wins the tie, so it is outside british and outside europe
    [11778, "The Deer Hunter", "US", []],
    [581, "Dances with Wolves", "US", []],
    [4347, "Atonement", "US", []], // GB + FR + US: American because the US is among the producers (the consequence Marco accepted)
    [627, "Trainspotting", "GB", ["british"]], // GB alone
    [426426, "Roma", "MX", ["latin-america"]], // GB + US producers, in Spanish
    [89708, "Samsara", "US", []], // sixteen producers, Ghana first among the English-speaking ones: the US, and not Africa
    [47324, "Cairo Station", "EG", ["middle-east"]],
    [27744, "Divine Intervention", "PS", ["middle-east"]], // FR, MA, DE, NL, PS in Arabic: Palestine, not the Maghreb
    [5801, "Pather Panchali", "IN", ["india"]],
    [11423, "Memories of Murder", "KR", ["asia"]],
    [16, "Dancer in the Dark", "DK", ["nordic"]], // English, DK + FI + FR + DE + IS + NL + NO + SE, no producer that speaks English: the first producer
    [390, "Lisbon Story", "DE", ["europe"]], // English, DE + PT + FR + ES: Germany
    [167073, "Brooklyn", "IE", ["british"]], // CA + IE + GB: IE, GB or IE without the US is british whatever comes first
    [600583, "The Power of the Dog", "GB", ["british"]], // AU + CA + NZ + GB
    [9659, "Mad Max", "AU", []], // AU alone: in no region (CA, AU or NZ alone have none)
    [566213, "Honeyland", "TR", ["middle-east"]], // Turkish, produced by MK: the language's home
    [889699, "Holy Spider", "IR", ["middle-east"]], // Persian, DK + JO + FR + DE + SE: the language's home
    [42241, "Sebastiane", "IT", ["europe"]], // Latin has no home: IT + GB, the first producer
    [93858, "Tabu", "BR", ["latin-america"]], // BR + FR + DE + PT in Portuguese: the first producer that speaks it, in TMDB's order
    [1417, "Pan's Labyrinth", "MX", ["latin-america"]], // MX + ES + US in Spanish: MX first
    [265228, "Timbuktu", "FR", ["europe"]], // the cache says original language French and one producer, France: it is in Europe by the rule
  ];
  for (const [id, title, iso, regions] of want) assert.deepEqual(regionOfFilm(id), { title, iso, regions }, title);
});

// 23/10/2026 (Marco, the recommended option of the questionnaire: "Cidadania do diretor quando o filme é produzido no país dela ou falado na língua dela (fora inglês); senão origem do
// TMDB"): the same 22 films under the rule that decides now (lib/countries.js mainCountry), with the facts FROZEN as TMDB (producers, language, origin_country, directors) and Wikidata (the
// directors' citizenship) answered on 22/10/2026 and as cache/tmdb.json and cache/directors.json hold them. Each film's region, and what the rule of 14/10/2026 (the test above) said.
// What Marco had ruled film by film on 13/10 and 14/10 and the final rule changes: Atonement (US → GB, the case that started it), Power of the Dog (GB → NZ: Campion; no region), Honeyland (TR →
// MK: the Macedonian director; Eastern bloc), Sebastiane (IT → GB: Jarman), Tabu (BR → PT: the Portuguese Gomes; Europe). Roma (MX) and Holy Spider (IR) are back where he put them.
const DIRECTORS_CIT = { 1223: ["US"], 12114: ["US"], 1269: ["US"], 36588: ["GB"], 2034: ["GB"], 11218: ["MX"], 68994: ["US"], 20023: ["EG"], 131685: ["IL"], 12160: ["IN"], 21684: ["KR"], 42: ["DK"], 2303: ["DE"],
  118772: ["FR", "ML", "MR"], 77269: ["IE"], 10757: ["NZ"], 20629: ["AU"], 2187555: ["MK"], 1574550: ["IR", "DK"], 86290: ["GB"], 150512: ["PT"], 10828: ["MX"] };
const FILMS2 = {
  275: ["Fargo", ["GB", "US"], "en", ["US"], [1223], "US", []],
  11778: ["The Deer Hunter", ["GB", "US"], "en", ["US"], [12114], "US", []],
  581: ["Dances with Wolves", ["GB", "US"], "en", ["US"], [1269], "US", []],
  4347: ["Atonement", ["FR", "GB", "US"], "en", ["GB"], [36588], "GB", ["british"]],
  627: ["Trainspotting", ["GB"], "en", ["GB"], [2034], "GB", ["british"]],
  426426: ["Roma", ["GB", "US"], "es", ["US"], [11218], "MX", ["latin-america"]],
  89708: ["Samsara", ["BR", "CN", "DK", "EG", "ET", "GH", "ID", "IT", "JP", "JO", "NA", "SA", "KR", "TH", "AE", "US"], "en", ["US"], [68994], "US", []],
  47324: ["Cairo Station", ["EG"], "ar", ["EG"], [20023], "EG", ["middle-east"]],
  27744: ["Divine Intervention", ["FR", "MA", "DE", "NL", "PS"], "ar", ["PS"], [131685], "PS", ["middle-east"]], // the Israeli-citizen Suleiman: Israel does not produce it and Arabic is not spoken there; the origin says PS
  5801: ["Pather Panchali", ["IN"], "bn", ["IN"], [12160], "IN", ["india"]],
  11423: ["Memories of Murder", ["KR"], "ko", ["KR"], [21684], "KR", ["asia"]],
  16: ["Dancer in the Dark", ["DK", "FI", "FR", "DE", "IS", "NL", "NO", "SE"], "en", ["DK"], [42], "DK", ["nordic"]],
  390: ["Lisbon Story", ["DE", "PT", "FR", "ES"], "en", ["DE", "PT"], [2303], "DE", ["europe"]],
  265228: ["Timbuktu", ["FR"], "fr", ["FR"], [118772], "FR", ["europe"]],
  167073: ["Brooklyn", ["CA", "IE", "GB"], "en", ["GB"], [77269], "GB", ["british"]], // IE (the Irish John Crowley) until 14/11/2026: in English TMDB's single origin wins (Marco, "Database country wins when it lists only one"); still british
  600583: ["The Power of the Dog", ["AU", "CA", "NZ", "GB"], "en", ["AU"], [10757], "AU", []], // NZ (Campion) until 14/11/2026: the single origin AU wins in English; no region either way
  9659: ["Mad Max", ["AU"], "en", ["AU"], [20629], "AU", []],
  566213: ["Honeyland", ["MK"], "tr", ["MK"], [2187554, 2187555], "MK", ["eastern-bloc"]],
  889699: ["Holy Spider", ["DK", "JO", "FR", "DE", "SE"], "fa", ["DK"], [1574550], "IR", ["middle-east"]],
  42241: ["Sebastiane", ["IT", "GB"], "la", ["GB"], [86290, 1144622], "GB", ["british"]],
  93858: ["Tabu", ["BR", "FR", "DE", "PT"], "pt", ["BR", "DE", "FR", "PT", "ES"], [150512], "PT", ["europe"]],
  1417: ["Pan's Labyrinth", ["MX", "ES", "US"], "es", ["MX", "ES"], [10828], "MX", ["latin-america"]],
};
test("main country, the films Marco named, under the rule of 23/10/2026: the director's country when it produces the film or speaks its language (not English), else TMDB's origin", () => {
  const dirs = new Map(Object.entries(DIRECTORS_CIT));
  for (const [id, [title, countries, lang, origin, directors, iso, regions]] of Object.entries(FILMS2)) {
    const film = { countries, lang, origin, directors: directors.map((d) => ({ id: d })) };
    const main = C.mainCountry(film, undefined, undefined, dirs);
    assert.equal(main, iso, `${title} (${id})`);
    assert.deepEqual(Object.keys(C.REGIONS).filter((r) => r !== "latam-hisp" && main && C.inRegion(main, r)), regions, `${title}: region`);
  }
});

test("regions: each decision of Marco, and no country in two regions", () => {
  const R = (iso) => Object.keys(C.REGIONS).filter((r) => r !== "latam-hisp" && C.inRegion(iso, r));
  assert.deepEqual(R("BR"), ["latin-america"]);
  assert.deepEqual(R("MX"), ["latin-america"]);
  assert.deepEqual(R("FR"), ["europe"]);
  assert.deepEqual(R("GB"), ["british"], "Europe has no UK");
  assert.deepEqual(R("IE"), ["british"], "nor Ireland");
  assert.deepEqual(R("SE"), ["nordic"]);
  assert.deepEqual(R("IS"), ["nordic"]);
  assert.deepEqual(R("PL"), ["eastern-bloc"]);
  assert.deepEqual(R("SU"), ["eastern-bloc"]);
  assert.deepEqual(R("XG"), ["eastern-bloc"], "East Germany is the Eastern bloc, not Europe");
  assert.deepEqual(R("DE"), ["europe"]);
  assert.deepEqual(R("XC"), ["eastern-bloc"]);
  assert.deepEqual(R("YU"), ["eastern-bloc"]);
  assert.deepEqual(R("EG"), ["middle-east"], "Egypt is the Middle East");
  assert.deepEqual(R("TR"), ["middle-east"]);
  assert.deepEqual(R("MA"), ["africa"], "the Maghreb is Africa");
  assert.deepEqual(R("ZA"), ["africa"]);
  assert.deepEqual(R("IN"), ["india"], "India has a row of its own");
  assert.deepEqual(R("KR"), ["asia"]);
  assert.deepEqual(R("HK"), ["asia"]);
  assert.deepEqual(R("US"), []);
  const all = Object.entries(C.REGIONS).filter(([r]) => r !== "latam-hisp").flatMap(([, codes]) => codes);
  assert.deepEqual(all.filter((c, i) => all.indexOf(c) !== i), [], "no code in two regions");
  assert.ok(C.REGIONS["latam-hisp"].every((c) => C.REGIONS["latin-america"].includes(c)) && !C.REGIONS["latam-hisp"].includes("BR"), "the Spanish-speaking Americas are Latin America without Brazil (the one region inside another: a part of the combined row)");
  assert.equal(C.REGIONS.africa.filter((c) => c !== "ZR").length, 53, "the 54 African states of the UN but Egypt");
  assert.throws(() => C.inRegion("FR", "atlantis"), /unknown region "atlantis"/);
});

// ── the gate ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("where: every condition must hold, and a fact the film lacks fails the condition that asks for it", () => {
  const f = cand({ film: { countries: ["FR"], lang: "fr", year: 1975, genres: ["Drama", "Documentary"] }, cand: { lb: 3.9, lbCount: 5000, lbYear: 1976 } });
  assert.ok(passes(f, null) && passes(f, undefined), "no gate: everything passes");
  assert.ok(passes(f, { countries: ["FR", "IT"] }) && !passes(f, { countries: ["IT"] }));
  assert.ok(passes(f, { region: "europe" }) && !passes(f, { region: "asia" }));
  assert.ok(passes(f, { countries: ["FR"], region: "europe" }) && !passes(f, { countries: ["FR"], region: "asia" }), "both");
  assert.ok(passes(f, { years: { min: 1976, max: 1976 } }), "the year of the index is Letterboxd's (1976), not TMDB's (1975)");
  assert.ok(!passes(f, { years: { min: 1970, max: 1975 } }));
  assert.ok(passes(f, { language: "fr" }) && passes(f, { language: ["it", "fr"] }) && !passes(f, { language: "en" }));
  assert.ok(passes(f, { genresAny: ["Documentary", "Horror"] }) && !passes(f, { genresAny: ["Horror"] }));
  assert.ok(passes(f, { genresAll: ["Drama", "Documentary"] }) && !passes(f, { genresAll: ["Drama", "Horror"] }));
  assert.ok(passes(f, { lb: { min: 3.8 } }) && !passes(f, { lb: { min: 3.95 } }));
  assert.ok(passes(f, { lbCount: { max: 5000 } }) && !passes(f, { lbCount: { max: 4999 } }));
  const k = cand({ film: { keywords: ["film noir", "heist"] }, cand: { lists: ["A305G"] } });
  assert.ok(passes(k, { keywordsAny: ["heist", "western"] }) && passes(k, { keywordsAny: ["HEIST"] }) && !passes(k, { keywordsAny: ["noir"] }), "keywords whole, not a part of one");
  assert.ok(passes(k, { listsAny: ["x", "A305G"] }) && !passes(k, { listsAny: ["x"] }) && !passes(cand(), { listsAny: ["A305G"] }), "lists the film is in");
  assert.ok(passes(k, { anyOf: [{ listsAny: ["x"] }, { keywordsAny: ["heist"] }] }) && !passes(k, { anyOf: [{ listsAny: ["x"] }, { keywordsAny: ["western"] }] }), "anyOf: one of them");
  assert.ok(!passes(k, { keywordsAny: ["heist"], anyOf: [{ listsAny: ["x"] }, { listsAny: ["y"] }] }), "and the other conditions still hold");
  const bare = cand({ film: { year: null, countries: [], lang: null } });
  for (const w of [{ countries: ["US"] }, { region: "europe" }, { years: { min: 1900 } }, { language: "en" }, { lb: { min: 0 } }, { lbCount: { max: 1e9 } }]) assert.ok(!passes(bare, w), JSON.stringify(w));
});

test("where: a recipe with a condition nobody reads, a flag instead of an ISO code or a region that does not exist is refused", () => {
  assert.deepEqual(validateWhere({ countries: ["XG"], years: { min: 1950 } }, "w"), []);
  assert.match(validateWhere({ colour: "red" }, "w")[0], /unknown condition "colour"/);
  assert.match(validateWhere({ countries: ["de"] }, "w")[0], /ISO 3166-1 alpha-2 codes in capitals/);
  assert.match(validateWhere({ countries: [] }, "w")[0], /ISO 3166-1 alpha-2 codes in capitals/);
  assert.match(validateWhere({ region: "atlantis" }, "w")[0], /"atlantis" is not a region/);
  assert.match(validateWhere({ years: { from: 1970 } }, "w")[0], /\{ min\?, max\? \}/);
  assert.match(validateWhere({ lb: { min: "3.8" } }, "w")[0], /\{ min\?, max\? \}/);
  assert.match(validateWhere({ anyOf: [{ region: "europe" }] }, "w")[0], /anyOf must be a list of two or more conditions/);
  assert.match(validateWhere({ anyOf: [{ region: "europe" }, { colour: 1 }] }, "w")[0], /anyOf\[1\]: unknown condition "colour"/);
  assert.match(validateWhere({ keywordsAny: "noir" }, "w")[0], /keywordsAny must be a list/);
  assert.match(validateWhere({ listsAny: [] }, "w")[0], /listsAny must be a list/);
  assert.match(validateWhere({}, "w")[0], /at least one condition/);
  assert.match(validateWhere(null, "w")[0], /at least one condition/);
});

test("a filter row: only films that pass, ranked with no mood, two per director, at most 100", () => {
  const french = Array.from({ length: 5 }, (_, i) => cand({ film: { countries: ["FR"], lang: "fr" }, cand: { tasteZ: 5 - i } }));
  const american = cand({ film: { countries: ["US"], lang: "en" }, cand: { tasteZ: 9 } }); // the best taste of all, and not European
  const gdr = cand({ film: { countries: ["XG"], lang: "de" }, cand: { tasteZ: 8 } });
  const british = cand({ film: { countries: ["GB"], lang: "en" }, cand: { tasteZ: 7 } });
  const out = run([american, gdr, british, ...french], spec(["europe"], { europe: { id: "europe", kind: "filter", where: { region: "europe" } } }));
  assert.deepEqual(ids(out.rows.europe), french.map((c) => c.film.imdb), "the French films in the order of their taste; not the American, not East Germany, not British");
  const dirs = cand({ film: { countries: ["IT"], lang: "it", directors: [{ id: 1, name: "Same" }] } });
  const out2 = run([dirs, cand({ film: { countries: ["IT"], lang: "it", directors: [{ id: 1, name: "Same" }] } }), cand({ film: { countries: ["IT"], lang: "it", directors: [{ id: 1, name: "Same" }] } })], spec(["europe"], { europe: { id: "europe", kind: "filter", where: { region: "europe" } } }));
  assert.equal(out2.rows.europe.length, 2, "two films by one director at most");
});

test("a filter row: the cap is 100 and the recommendation rule is applied before it, so a refused film does not take a place", () => {
  const many = Array.from({ length: 130 }, (_, i) => cand({ film: { countries: ["JP"], lang: "ja" }, cand: { tasteZ: 200 - i } }));
  const refused = new Set(many.slice(0, 10).map((c) => c.film.imdb));
  const out = run(many, spec(["asia"], { asia: { id: "asia", kind: "filter", where: { region: "asia" } } }), [], { eligible: (tt) => !refused.has(tt) });
  assert.equal(out.rows.asia.length, 100);
  assert.ok(ids(out.rows.asia).every((tt) => !refused.has(tt)));
  assert.equal(out.rows.asia[0].id, many[10].film.imdb, "the best film the rule lets through leads");
});

test("decades: a decade row has the films of its ten years, any country, any genre; the year is the one the index shows", () => {
  const dec = (d) => ({ id: `${d}s`, kind: "filter", where: { years: { min: d, max: d + 9 } } });
  const mk = (year, o = {}) => cand({ film: { year, countries: ["JP"], lang: "ja", genres: ["Horror"] }, cand: o });
  const edge = [mk(1979), mk(1980), mk(1989), mk(1990), mk(1979, { lbYear: 1980 }), mk(1981, { lbYear: 1979 })];
  const out = run(edge, spec(["1970s", "1980s"], { "1970s": dec(1970), "1980s": dec(1980) }));
  assert.deepEqual(ids(out.rows["1970s"]).sort(), [edge[0], edge[5]].map((c) => c.film.imdb).sort(), "1979 by TMDB, and 1981 that Letterboxd dates 1979; not the 1979 that Letterboxd dates 1980");
  assert.deepEqual(ids(out.rows["1980s"]).sort(), [edge[1], edge[2], edge[4]].map((c) => c.film.imdb).sort());
  assert.equal(out.rows["1980s"].length + out.rows["1970s"].length, 5, "1990 is in neither");
  const fx = FIXTURE.rows.filter((r) => /^\d{4}s$/.test(r.id));
  assert.deepEqual(fx.map((r) => r.id), ["1970s", "1980s", "1990s", "2000s", "2010s", "2020s"]);
  assert.ok(fx.every((r) => r.where.years.max === r.where.years.min + 9 && r.where.years.min === Number(r.id.slice(0, 4))));
});

// ── the moods that have a gate ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test("docs: a film is a documentary or it is not in the row, and a music documentary weighs more than another", () => {
  const docs = moodOf("docs");
  const concert = cand({ film: { genres: ["Music"], keywords: ["concert film", "musician"] } }); // a fiction film about music
  const plain = cand({ film: { genres: ["Documentary"] } });
  const music = cand({ film: { genres: ["Documentary", "Music"], keywords: ["music documentary", "concert film"] } });
  const rank = BR.rankMood([concert, plain, music], docs);
  assert.deepEqual(rank.map((c) => c.film.imdb), [music, plain].map((c) => c.film.imdb), "Documentary is required; the music documentary leads");
  assert.ok(fit(concert.film, docs).ok, "by its recipe alone the fiction film would fit (Music 0.8 + concert 1 + musician 0.8): the gate is what keeps it out");
});

test("hidden: a Letterboxd average of 3.8 or more on fewer than 10,000 ratings, and nothing else decides who is in", () => {
  const hidden = moodOf("hidden");
  const at = (lb, lbCount) => cand({ cand: { lb, lbCount } });
  const edge = { in1: at(3.8, 9999), in2: at(4.6, 12), out1: at(3.79, 100), out2: at(3.9, 10000), out3: at(3.9, 250000), out4: at(null, null), out5: cand() };
  const rank = BR.rankMood(Object.values(edge), hidden);
  assert.deepEqual(rank.map((c) => c.film.imdb).sort(), [edge.in1, edge.in2].map((c) => c.film.imdb).sort());
  assert.equal(rank[0].fitInfo.norm, 1, "a gate-only mood fits every film that passes it, all alike (no division by a minFit of 0)");
  assert.ok(rank.every((c) => Number.isFinite(c.rank)));
});

// ── the watchlist, newest first ────────────────────────────────────────────────────────────────────────────────────────────────────────

const wl = (title, o) => cand({ film: { title, genres: ["Drama"] }, cand: { watchlist: true, ...o } });

test("watchlist: the page's order, whatever the taste or the date of the CSV says", () => {
  const films = [wl("Zed", { watchlistPos: 2, tasteZ: 9, watchlistedOn: "2020-01-01" }), wl("Amy", { watchlistPos: 0, tasteZ: -9, watchlistedOn: "2019-01-01" }), wl("Bob", { watchlistPos: 1, tasteZ: 0, watchlistedOn: "2024-01-01" })];
  const out = run([], spec(["watchlist"]), [], { watchlistCands: films, liveWatchlist: true });
  assert.deepEqual(out.rows.watchlist.map((i) => i.title), ["Amy", "Bob", "Zed"], "position 0 is the film added last");
  assert.equal(out.report[0].note, "the order of Letterboxd's page");
});

test("watchlist: without the page, the date added decides, the newest first; a film with no date leads; a tie goes to the title", () => {
  // every film still carries a position, as if from an earlier read: tonight's page was not read, so none of them may count
  const films = [wl("Old", { watchlistedOn: "2020-01-01", watchlistPos: 0, tasteZ: 9 }), wl("New", { watchlistedOn: "2025-06-01", watchlistPos: 9, tasteZ: -9 }), wl("Undated", { watchlistPos: 5 }), wl("Mid B", { watchlistedOn: "2022-03-03", watchlistPos: 2 }), wl("Mid A", { watchlistedOn: "2022-03-03", watchlistPos: 3 })];
  const out = run([], spec(["watchlist"]), [], { watchlistCands: films, liveWatchlist: false });
  assert.deepEqual(out.rows.watchlist.map((i) => i.title), ["Undated", "New", "Mid A", "Mid B", "Old"], "positions kept from an earlier read mean nothing when the page was not read tonight");
  const partial = [wl("A", { watchlistPos: 1, watchlistedOn: "2021-01-01" }), wl("B", { watchlistedOn: "2023-01-01" })];
  const out2 = run([], spec(["watchlist"]), [], { watchlistCands: partial, liveWatchlist: true });
  assert.deepEqual(out2.rows.watchlist.map((i) => i.title), ["B", "A"], "a film the page did not place sends the whole row back to the dates");
});

test("watchlist: the 100 added last that pass the recommendation rule (a refused film leaves its place to the next one)", () => {
  const films = Array.from({ length: 140 }, (_, i) => wl(`F${String(i).padStart(3, "0")}`, { watchlistPos: i }));
  const refused = new Set(films.slice(0, 10).map((c) => c.film.imdb));
  const out = run([], spec(["watchlist"]), [], { watchlistCands: films, liveWatchlist: true, eligible: (tt) => !refused.has(tt) });
  assert.equal(out.rows.watchlist.length, 100, "the ten newest films fail the rule, and the row still has its 100");
  assert.equal(out.rows.watchlist[0].title, "F010");
  assert.equal(out.rows.watchlist[99].title, "F109");
  assert.equal(out.rows.watchlist[0].why[0], "on your watchlist");
  const dated = run([], spec(["watchlist"]), [], { watchlistCands: [wl("D", { watchlistedOn: "2022-03-03" })], liveWatchlist: false });
  assert.match(dated.rows.watchlist[0].why[0], /^on your watchlist since Mar 2022$/);
});

// ── the real caches ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

let built = null;
/**
 * One offline build of the whole Board from the caches of the repository (copied: the build must not touch them), shared by the tests below; removed at the end.
 * `exclude`: IMDb ids for config.json exclude.films, in a build of its own (a second one, named by `name`).
 */
let registryBefore = null;
function build(name = "main", exclude = null) {
  built ||= {};
  // 23/10/2026: the build below reads cache/directors.json (copied with the other caches) and the regions are decided with the director's country; the checks of this process must decide the same way
  if (registryBefore === null) registryBefore = C.setDirectors(require("../lib/directors").citizenshipMap(require("../lib/directors").load(path.join(ROOT, "cache", "directors.json"))));
  if (built[name]) return built[name];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mood-rows-"));
  fs.mkdirSync(path.join(work, "cache"));
  for (const f of fs.readdirSync(path.join(ROOT, "cache"))) if (f.endsWith(".json")) fs.copyFileSync(path.join(ROOT, "cache", f), path.join(work, "cache", f));
  const out = path.join(work, "out");
  const config = exclude ? ["--config", (() => { const file = path.join(work, "config.json"); fs.writeFileSync(file, JSON.stringify({ ...CONFIG, exclude: { films: exclude } })); return file; })()] : [];
  const r = spawnSync(process.execPath, [path.join(ROOT, "build.js"), "--offline", "--cache-only", "--skip-posters", "--date", "2026-10-13", "--captured-at", "2026-10-13T12:00:00.000Z", "--board", path.join(__dirname, "fixtures", "board-v2-pr2.json"), ...config, "--cache-dir", path.join(work, "cache"), "--out", out], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" },
  });
  assert.equal(r.status, 0, `the build failed\n${(r.stderr || "").slice(-2000)}\n${(r.stdout || "").slice(-1500)}`);
  const read = (f) => JSON.parse(fs.readFileSync(path.join(out, "data", f), "utf8"));
  const rows = {}, friendPieces = [];
  for (const f of fs.readdirSync(path.join(out, "data"))) {
    const m = /^index-v2-row-(.+)\.json$/.exec(f);
    if (m && FRIEND_PIECES.has(m[1])) { friendPieces.push(m[1]); continue; } // the friends' watchlists (29/10/2026, lib/friend-view.js) are not Board rows: one per configured friend, next to the rows
    if (m) { const j = decode(read(f)); rows[m[1]] = { ids: j.rows[m[1]], films: new Map(j.films.map((x) => [x.tt, x])) }; }
  }
  const tmdb = JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "tmdb.json"), "utf8")).movie;
  const records = new Map(); // IMDb id → every TMDB record that carries it (a film can be known under two TMDB ids)
  for (const e of Object.values(tmdb)) if (e && e.v && e.v.imdb) (records.get(e.v.imdb) || records.set(e.v.imdb, []).get(e.v.imdb)).push(e.v);
  return (built[name] = { work, out, log: r.stdout, rows, friendPieces: friendPieces.sort(), records, full: decode(read("index-v2.json")), legacy: decode(read("index.json")), menus: decode(read("index-v2-menus.json")) });
}
after(() => { for (const b of Object.values(built || {})) if (b && b.work) fs.rmSync(b.work, { recursive: true, force: true }); built = null; if (registryBefore !== null) { C.setDirectors(registryBefore); registryBefore = null; } });

// 22/10/2026: the region of a film is its mainCountry (TMDB's origin_country first, test/origin-country.test.js); until then these real-cache tests read mainIso, the rule it falls back to.
const mainOf = (b, tt) => (b.records.get(tt) || []).map((r) => C.mainCountry(r));

test("the real caches: the Board is the one of the fixture, every row has at most 100 films and a file of its own, and the rows the build warns about are the short ones", { timeout: 300000 }, () => {
  const b = build();
  assert.deepEqual(b.menus.board.map((r) => r.id), FIXTURE.order);
  assert.deepEqual(b.menus.board.map((r) => r.name), FIXTURE.order.map((id) => FIXTURE.names[id]));
  assert.match(b.log, /Board v2: 45 rows/);
  assert.match(b.log, /Quality net on the Board rows: 0 film\(s\) removed \(0 expected/, "no row of the legacy Board or of the v2 Board needed the net");
  for (const [id, row] of Object.entries(b.rows)) assert.ok(row.ids.length <= 100, `${id} has ${row.ids.length}`);
  assert.deepEqual(Object.keys(b.rows).sort(), FIXTURE.order.filter((id) => id !== "my-series").sort());
  assert.deepEqual(b.friendPieces, [...FRIEND_PIECES].sort(), "and one watchlist piece per configured friend, none of them a Board row");
  // the rows the v2 builder made are marked with "!" in the log exactly when they have fewer than 20 films
  const made = FIXTURE.order.filter((id) => FIXTURE.rows.some((r) => r.id === id) || FIXTURE.moods.some((m) => m.id === id) || id === "watchlist");
  for (const id of made) {
    const line = b.log.split("\n").find((l) => new RegExp(`^[! ] ${id}\\s+\\d+`).test(l));
    assert.ok(line, `${id} is in the log`);
    assert.equal(line[0] === "!", b.rows[id].ids.length < 20, `${id}: ${b.rows[id].ids.length} films`);
  }
  // and the Moods menu line marks a mood "!" exactly when fewer than 20 of the films that fit it pass the recommendation rule
  const moodsLine = b.log.split("\n").find((l) => l.includes("Moods menu of the v2 family"));
  const tokens = [...moodsLine.matchAll(/(\S+) (\d+)\/(\d+)(!?)(?:,|\s\(!)/g)];
  assert.equal(tokens.length, FIXTURE.moodMenu.filter((id) => id !== "friends-week").length, "every mood of the menu is in the line");
  for (const [, id, , ok, mark] of tokens) assert.equal(mark === "!", Number(ok) < 20, `${id}: ${ok}`);
});

test("the real caches: every film of a region row has its main country in the region, and East Germany, the Soviet Union and Czechoslovakia are in the Eastern bloc and not in Europe", { timeout: 300000 }, () => {
  const b = build();
  for (const region of Object.keys(C.REGIONS).filter((r) => r !== "latam-hisp")) { // latam-hisp is a part of the combined Latin America row, not a row
    const row = b.rows[region];
    assert.ok(row.ids.length >= 20, `${region} has ${row.ids.length} films`);
    for (const tt of row.ids) assert.ok(mainOf(b, tt).some((iso) => iso && C.inRegion(iso, region)), `${region}: ${tt} has ${mainOf(b, tt)}`);
  }
  // the whole cache: the old states are in the Eastern bloc by their own code. Their flag (Germany, Russia, the Czech Republic, Serbia) would put them elsewhere.
  const old = [];
  for (const rs of b.records.values()) for (const r of rs) if (["XG", "SU", "XC", "YU"].includes(C.mainCountry(r))) old.push(r);
  assert.ok(old.length >= 100, `the caches hold ${old.length} films of the old states`);
  assert.ok(old.every((r) => C.inRegion(C.mainCountry(r), "eastern-bloc") && !C.inRegion(C.mainCountry(r), "europe") && !passes({ film: r }, { region: "europe" })), "none of them in Europe");
  const east = old.filter((r) => C.mainCountry(r) === "XG");
  assert.ok(east.length >= 5 && east.every((r) => passes({ film: r }, { region: "eastern-bloc" }) && !passes({ film: r }, { region: "europe" })), `${east.length} films of East Germany`);
  assert.ok(b.rows["eastern-bloc"].ids.some((tt) => mainOf(b, tt).some((iso) => ["SU", "XC", "XG", "YU"].includes(iso))), "and the row has films of the old states");
});

test("the real caches: a decade row holds films of its own ten years, by the year the index shows", { timeout: 300000 }, () => {
  const b = build();
  for (const dec of [1970, 1980, 1990, 2000, 2010, 2020]) {
    const row = b.rows[`${dec}s`];
    assert.equal(row.ids.length, 100, `${dec}s`);
    for (const tt of row.ids) { const y = row.films.get(tt).year; assert.ok(y >= dec && y <= dec + 9, `${dec}s: ${tt} is ${y}`); }
  }
  assert.ok(new Set(b.rows["1990s"].ids.map((tt) => (b.records.get(tt)?.[0] || {}).lang)).size > 3, "any language: a decade is not a country");
});

test("the real caches: Documentaries are all documentaries, Hidden gems all have 3.8 or more and under 10,000 ratings", { timeout: 300000 }, () => {
  const b = build();
  for (const tt of b.rows.docs.ids) assert.ok(b.records.get(tt).some((r) => r.genres.includes("Documentary")), tt);
  assert.ok(b.rows.docs.ids.length >= 90);
  const lb = new Map();
  for (const r of Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "friends.json"), "utf8")).films)) if (r.imdbId && r.rn != null && !lb.has(r.imdbId)) lb.set(r.imdbId, r);
  assert.ok(b.rows.hidden.ids.length >= 90);
  for (const tt of b.rows.hidden.ids) { const r = lb.get(tt); assert.ok(r && r.r >= 3.8 && r.rn < 10000, `${tt}: ${r && r.r} on ${r && r.rn}`); }
});

test("the real caches: the watchlist row follows the order of the page Letterboxd showed, the film added last first", { timeout: 300000 }, () => {
  const b = build();
  const friends = JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "friends.json"), "utf8"));
  const pos = new Map();
  friends.watchlist.items.forEach(([slug], i) => { const r = friends.films[slug]; if (r && r.imdbId && !pos.has(r.imdbId)) pos.set(r.imdbId, i); });
  const row = b.rows.watchlist.ids.map((tt) => pos.get(tt));
  assert.ok(row.length >= 90 && row.every((p) => p != null));
  assert.deepEqual(row, row.slice().sort((a, c) => a - c), "strictly the page's order");
  assert.ok(row[0] <= 25, `the first film is the ${row[0]}th of the page: the newest few are the top of the row, less those the rule refuses`);
  assert.match(b.log, /watchlist\s+\d+\s+.*\n\s+the order of Letterboxd's page/);
});

test("the real caches: the card is the main country by the director's rule (23/10/2026): Roma reads Mexico, Holy Spider Iran, Amour Austria, Topsy-Turvy the United Kingdom; the columns agree with mainCountry for every film that has a record", { timeout: 300000 }, () => {
  const b = build();
  const first = (f) => f.country || (f.countries && f.countries[0]) || null;
  const tmdb = JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "tmdb.json"), "utf8"));
  const byImdb = (tmdbId) => b.full.films.find((f) => f.tt === tmdb.movie[tmdbId].v.imdb);
  assert.equal(first(byImdb(426426)), "Mexico", "Roma: GB + US producers, Spanish, the Mexican Cuarón (the origin says the US)");
  assert.equal(first(byImdb(889699)), "Iran", "Holy Spider: Persian, the Iranian Abbasi");
  assert.equal(first(byImdb(86837)), "Austria", "Amour: French, the Austrian Haneke, Austria a producer");
  assert.equal(first(byImdb(46435)), "United Kingdom", "Topsy-Turvy");
  assert.equal(first(byImdb(11778)), "United States", "The Deer Hunter");
  const P = require("../lib/pool");
  let checked = 0;
  const off = [];
  for (const f of b.full.films) {
    const recs = b.records.get(f.tt);
    if (!recs || !recs.length || !first(f)) continue;
    const own = recs.find((r) => r.countries && r.countries.length) || recs[0];
    const iso = C.mainCountry(own);
    if (iso) { checked++; if (first(f) !== P.countryLabel(iso)) off.push(`${f.tt} ${first(f)} / ${iso}`); }
  }
  // a handful of films have a TMDB record by IMDb id that the pool does not link (the record Letterboxd names is a series' or has no IMDb id: tt2125012, Agnès Varda: From Here to There, 745698, no producers,
  // reads France from the Letterboxd page while the record's director says Belgium): the index shows what the pool's own record says. Measured 23/10/2026: 2 of 11,227 (tt2125012 and tt0451002, Broken Saints, card Canada, main US).
  assert.ok(checked > 9000, `${checked} films checked`);
  assert.ok(off.length <= 5, `${off.length} of ${checked} cards differ from mainCountry: ${off.slice(0, 8).join("; ")}`);
});

test("the real caches: the combined rows interleave their parts, the share of each is in the log, and 'wicked' is not the legacy 'wicked'", { timeout: 300000 }, () => {
  const b = build();
  const fitsIn = (tt, mood) => !!(b.full.films.find((f) => f.tt === tt)?.moods || {})[mood];
  const comedy = b.rows.comedy.ids;
  for (let i = 0; i < 10; i++) assert.ok(fitsIn(comedy[i], i % 2 === 0 ? "lol" : "deadpan"), `comedy #${i + 1} must fit ${i % 2 === 0 ? "lol" : "deadpan"}`);
  assert.match(b.log, /after-midnight[^\n]*\n\s+night \d+ \(taste \d+\/\d+\) · noir \d+ \(taste \d+\/\d+\) · whodunit \d+ \(taste \d+\/\d+\) · mindbender \d+ \(taste \d+\/\d+\)/);
  assert.match(b.log, /small-kind[^\n]*\n\s+gentle \d+ .*· lift \d+ .*· rainy \d+/);
  // Latin America is a combined row of three filters (spec §A): Brazil from 2001, Brazil to 2000, the Spanish-speaking Americas
  assert.match(b.log, /latin-america[^\n]*\n\s+brazil-now \d+ .*· brazil-classic \d+ .*· latam-hisp \d+/);
  const la = b.rows["latin-america"], iso = (tt) => mainOf(b, tt)[0], year = (tt) => la.films.get(tt).year;
  for (let i = 0; i < 9; i += 3) {
    assert.ok(iso(la.ids[i]) === "BR" && year(la.ids[i]) >= 2001, `Latin America #${i + 1}: Brazil from 2001`);
    assert.ok(iso(la.ids[i + 1]) === "BR" && year(la.ids[i + 1]) <= 2000, `Latin America #${i + 2}: Brazil to 2000`);
    assert.ok(C.inRegion(iso(la.ids[i + 2]), "latam-hisp"), `Latin America #${i + 3}: the Spanish-speaking Americas`);
  }
  const wicked = b.rows.wicked.ids;
  const legacy = b.legacy.rows.wicked;
  assert.notDeepEqual(wicked, legacy, "the v2 row mixes slasher and horror-comedy in");
  assert.ok(wicked.some((tt) => fitsIn(tt, "slasher") || fitsIn(tt, "horror-comedy")));
  assert.ok(legacy.every((tt) => !b.legacy.moods.some((m) => m.id === "slasher")), "and the legacy family has no slasher mood");
});

test("the real caches: the nine moods of today are the same on the v2 Board as in the legacy one, and a film is in at most two of the new mood and combined rows", { timeout: 300000 }, () => {
  const b = build();
  for (const id of ["escape", "reinvent", "letin", "slow"]) assert.deepEqual(b.rows[id].ids, b.legacy.rows[id], id);
  assert.deepEqual(b.rows.tonight.ids, b.legacy.rows.tonight);
  const counted = FIXTURE.order.filter((id) => FIXTURE.rows.some((r) => r.id === id && r.kind === "combine") || (FIXTURE.moods.some((m) => m.id === id)));
  assert.ok(counted.length >= 14, counted.join());
  const uses = new Map();
  for (const id of counted) for (const tt of b.rows[id].ids.slice(0, 30)) uses.set(tt, [...(uses.get(tt) || []), id]);
  const over = [...uses].filter(([, rows]) => rows.length > 2);
  assert.deepEqual(over, [], "films in a third mood or combined row");
  assert.ok([...uses.values()].some((rows) => rows.length === 2), "and the ceiling is reached by some films (the caches are not so wide that it never matters)");
});

test("the real caches: exclude.films takes a film out of the v2 watchlist and the film after the 100th does not move up to its place", { timeout: 300000 }, () => {
  const base = build();
  const gone = base.rows.watchlist.ids[2];
  const cut = build("exclude", [gone]);
  assert.equal(cut.rows.watchlist.ids.includes(gone), false);
  assert.deepEqual(cut.rows.watchlist.ids, base.rows.watchlist.ids.filter((tt) => tt !== gone), "the row is one film shorter and all the others keep their places (exclude.films keeps the rule of 10/10: no refill)");
  assert.ok(cut.rows.hidden.ids.length === 100 && !cut.rows.hidden.ids.includes(gone), "the rows made from the candidates refill, as they always did");
});
