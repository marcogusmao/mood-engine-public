// node --test            (no dependencies)
// The Discover catalogs of the v2 family (Marco, 22/10/2026; spec research/2026-10-22-catalogos-paises-regioes-decadas-eras.md): the condition `directorsAny` of a `where`, the data file
// data/discover-catalogs.json and its validator, the membership the build writes into index-v2.json, and the shape the index validation accepts. No test here reads cache/: the films are planted.
//
// Mutations this file is meant to turn red (recorded in the commit of 22/10/2026, with the ones that survive; the receipt is worker/mutation.mjs "discover:"):
//   directorsAny ignored (the Nouvelle Vague takes every French film of its years)       → "directorsAny: ..."
//   directorsAny compared by name and not by id (a homonym, or a spelling, decides)       → "directorsAny: the id decides"
//   a list in no catalog / in two catalogs accepted                                       → "parse: every list ..."
//   a label of 29 characters accepted                                                     → "parse: a label ..."
//   the region read from the card's country and not from the main country                 → "build: a region follows the main country"
//   the seen films left out of the ids / the not eligible ones kept                       → "build: seen films stay / not eligible films never"
//   spread off, or spread that drops films                                                → "spread: ..." (23/10/2026: 28 mutation cases for the spread in worker/mutation.mjs "discover: spread"; executed receipts are in BACKLOG.md)
//   the slices keep the ids                                                               → "slices: ..."

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { passes, validateWhere } = require("../lib/moods");
const DC = require("../lib/discover-catalogs");
const { pieces2, discoverLabels, buildIndex, factsByTt } = require("../lib/index-export");
const { checkIndex, validateIndex } = require("../lib/index-validation");
const { writeIndex } = require("../lib/index-export");
const { verifyIndex } = require("../verify");
const os = require("os");
const { encode } = require("../lib/index-rows");
const CONFIG = require("../config.json");

const ROOT = path.join(__dirname, "..");
const TODAY = "2026-10-22";

// ── directorsAny ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const GODARD = { id: 3776, name: "Jean-Luc Godard" };
const film = (o = {}) => ({ countries: ["FR"], lang: "fr", year: 1960, directors: [GODARD], genres: [], keywords: [], ...o });

test("directorsAny: a film of one of the directors, inside the years, passes; another director's film does not; a film with no directors does not", () => {
  const where = { years: { min: 1958, max: 1973 }, directorsAny: [GODARD, { id: 1650, name: "François Truffaut" }] };
  assert.equal(passes({ film: film(), lbYear: 1960 }, where), true, "Godard, 1960");
  assert.equal(passes({ film: film({ directors: [{ id: 9999, name: "Someone Else" }] }), lbYear: 1960 }, where), false, "another director, the same country and years");
  assert.equal(passes({ film: film({ directors: [] }), lbYear: 1960 }, where), false, "no directors");
  assert.equal(passes({ film: { countries: ["FR"], lang: "fr" }, lbYear: 1960 }, where), false, "no `directors` key at all");
  assert.equal(passes({ film: film(), lbYear: 1990 }, where), false, "the director is right and the year is not: every condition has to hold");
});

test("directorsAny: the id decides, not the name (TMDB spells 'Wong Kar-Wai' and a homonym is another person)", () => {
  const where = { directorsAny: [{ id: 12453, name: "Wong Kar-Wai" }] };
  assert.equal(passes({ film: film({ directors: [{ id: 12453, name: "Wong Kar Wai" }] }) }, where), true, "the same id under another spelling");
  assert.equal(passes({ film: film({ directors: [{ id: 777, name: "Wong Kar-Wai" }] }) }, where), false, "the same name under another id");
});

test("directorsAny: the anyOf of a rule can carry it, and the other conditions of the rule still hold", () => {
  const where = { years: { max: 1990 }, anyOf: [{ directorsAny: [GODARD] }, { keywordsAny: ["french new wave"] }] };
  assert.equal(passes({ film: film(), lbYear: 1965 }, where), true);
  assert.equal(passes({ film: film({ directors: [], keywords: ["french new wave"] }), lbYear: 1965 }, where), true);
  assert.equal(passes({ film: film(), lbYear: 2001 }, where), false);
});

test("validateWhere: directorsAny must be a non-empty list of { id: whole number above zero, name: text }; each refusal names the condition", () => {
  assert.deepEqual(validateWhere({ directorsAny: [GODARD] }, "w"), []);
  for (const bad of [[], ["Godard"], [{ id: 1.5, name: "x" }], [{ id: -1, name: "x" }], [{ id: 0, name: "x" }], [{ id: 5 }], [{ id: 5, name: "" }], [null], "Godard", { id: 1, name: "x" }]) {
    const out = validateWhere({ directorsAny: bad }, "w");
    assert.equal(out.length, 1, JSON.stringify(bad));
    assert.match(out[0], /directorsAny must be a list of \{ id, name \} with TMDB person ids/, JSON.stringify(bad));
  }
});

// ── the file and its validator ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const LISTS = [
  { id: "aaa", name: "Alpha list of the French (someone)", short: "Alpha French" },
  { id: "bbb", name: "Beta list (someone)", short: "Beta" },
  { id: "ccc", name: "Gamma list, no short name" },
];
/** A small valid file over LISTS: a region, a country, a decade, an era by movement, and the three lists. */
const good = () => ({
  version: 1, floor: { countries: 20, eras: 20 }, order: ["moods", "places", "eras", "director-picks", "friends", "explore", "search"], retire: ["lists", "lists-unseen"], seen: { name: "seen", option: "Include seen" }, spread: { per: 2, window: 20 },
  catalogs: [
    { id: "places", name: "Mood Engine · Countries & regions", options: [{ id: "r-europe", label: "Europe", where: { region: "europe" } }, { id: "c-france", label: "France", country: "France" }, { list: "aaa" }] },
    { id: "eras", name: "Mood Engine · Decades & eras", options: [{ id: "d-1960s", label: "1960s", decade: "1960s" }, { id: "e-nv", label: "Nouvelle Vague 1958–73", where: { years: { min: 1958, max: 1973 }, directorsAny: [GODARD] } }, { list: "bbb" }, { list: "ccc" }] },
  ],
});
const parse = (j, o = {}) => DC.parse(j, { lists: LISTS, today: TODAY, existingIds: ["tonight", "watchlist"], ...o });
const refuses = (mutate, pattern, o) => {
  const j = good();
  mutate(j);
  assert.throws(() => parse(j, o), (e) => { assert.match(e.message, pattern); return true; });
};

test("parse: a sound file gives the spec — the options in the file's order, a list option with the id l-<list> and the list's short name (else its name) as the label", () => {
  const spec = parse(good());
  assert.deepEqual(spec.catalogs.map((c) => [c.id, c.options.map((o) => `${o.id}|${o.label}|${o.kind}`)]), [
    ["places", ["r-europe|Europe|where", "c-france|France|country", "l-aaa|Alpha French|list"]],
    ["eras", ["d-1960s|1960s|decade", "e-nv|Nouvelle Vague 1958–73|where", "l-bbb|Beta|list", "l-ccc|Gamma list, no short name|list"]],
  ]);
  assert.deepEqual([spec.floor, spec.spread, spec.seen, spec.retire], [{ countries: 20, eras: 20 }, { per: 2, window: 20 }, { name: "seen", option: "Include seen" }, ["lists", "lists-unseen"]]);
});

test("parse: every list of config.json is in exactly one catalog — one with none is named, one in two catalogs names both; a list that config.json does not have is refused", () => {
  refuses((j) => j.catalogs[1].options.pop(), /list ccc \(Gamma list, no short name\) has no Discover catalog/);
  refuses((j) => j.catalogs[1].options.push({ list: "aaa" }), /list aaa is in places and eras/);
  refuses((j) => j.catalogs[0].options.push({ list: "aaa" }), /list aaa is in places and places/);
  refuses((j) => j.catalogs[0].options.push({ list: "zzz" }), /list "zzz" is not a list of config.json/);
});

test("parse: a calculated option has exactly one of where, country or decade; the where is judged by validateWhere, the decade by the decades of the menu, the country must be a name", () => {
  refuses((j) => { j.catalogs[0].options[1].where = { region: "europe" }; }, /option "c-france": needs exactly one of where, country, decade, lists, any, runtime, rating or era, has where and country/);
  refuses((j) => { delete j.catalogs[0].options[1].country; }, /option "c-france": needs exactly one of where, country, decade, lists, any, runtime, rating or era, has none/);
  refuses((j) => { j.catalogs[0].options[0].where = { region: "atlantis" }; }, /option "r-europe".where.region "atlantis" is not a region/);
  refuses((j) => { j.catalogs[0].options[0].where = { directorsAny: [] }; }, /directorsAny must be a list of \{ id, name \}/);
  refuses((j) => { j.catalogs[1].options[0].decade = "1910s"; }, /decade "1910s" is not one of 1920s/);
  refuses((j) => { j.catalogs[1].options[0].decade = "2030s"; }, /decade "2030s" is not one of/, { today: TODAY });
  refuses((j) => { j.catalogs[0].options[1].country = " "; }, /country must be a name/);
  refuses((j) => { j.catalogs[0].options[1].contry = "France"; }, /unknown key "contry"/);
  assert.equal(parse((() => { const j = good(); j.catalogs[1].options[0].decade = "2030s"; return j; })(), { today: "2030-01-01" }).catalogs[1].options[0].decade, "2030s", "the decades follow the day of the build: 2030s exists in 2030");
});

test("parse: option ids repeat nowhere in a catalog and are lower case letters, digits and hyphens", () => {
  refuses((j) => { j.catalogs[0].options[1].id = "r-europe"; }, /the option id "r-europe" appears twice/);
  refuses((j) => { j.catalogs[0].options[1].id = "C_France"; }, /option "C_France": the id must be lower case letters, digits and hyphens/);
});

test("parse: a label has at most 28 characters (a list's short name counts, a country's name too) and two labels that the Worker cannot tell apart — the same words — are one option", () => {
  refuses((j) => { j.catalogs[0].options[0].label = "Eastern Europe and Russia and more"; }, /the label "Eastern Europe and Russia and more" has 34 characters, the menu line holds 28/);
  refuses((j) => { j.catalogs[0].options[0].label = "x".repeat(29); }, /has 29 characters/);
  assert.doesNotThrow(() => parse((() => { const j = good(); j.catalogs[0].options[0].label = "x".repeat(28); return j; })()));
  refuses((j) => { j.catalogs[0].options[1].label = "europe"; }, /"europe" and "Europe" are the same option to the Worker/);
  refuses((j) => { j.catalogs[0].options[1].label = "Europe!"; }, /"Europe!" and "Europe" are the same option/);
  assert.doesNotThrow(() => parse((() => { const j = good(); j.catalogs[1].options[0].label = "Europe"; return j; })()), "the same label in ANOTHER catalog is allowed");
  const long = [{ ...LISTS[0], short: "y".repeat(29) }, LISTS[1], LISTS[2]];
  assert.throws(() => parse(good(), { lists: long }), /the label "y{29}" has 29 characters/);
});

test("parse: the id of a catalog is not one that exists — the Worker's catalogs, the profiles', a row of the Board, a mood — nor repeated, and has the shape of an id", () => {
  for (const taken of ["moods", "lists", "lists-unseen", "friends", "director-picks", "explore", "search", "my-series", "what-it-is", "vouch-critics", "tonight", "watchlist"])
    refuses((j) => { j.catalogs[0].id = taken; j.order[1] = taken; }, /the id is already used by another catalog or a Board row/);
  refuses((j) => { j.catalogs[1].id = "places"; j.order[2] = "places"; }, /the id appears twice/);
  refuses((j) => { j.catalogs[0].id = "Places"; j.order[1] = "Places"; }, /the id must be lower case letters, digits and hyphens/);
});

test("parse: the name of a catalog starts with \"Mood Engine · \" and has at most 34 characters", () => {
  refuses((j) => { j.catalogs[0].name = "Countries & regions"; }, /the name must start with "Mood Engine · "/);
  refuses((j) => { j.catalogs[0].name = "Mood Engine · " + "x".repeat(21); }, /has 35 characters, the limit is 34/);
  assert.doesNotThrow(() => parse((() => { const j = good(); j.catalogs[0].name = "Mood Engine · " + "x".repeat(20); return j; })()));
});

test("parse: `order` has every catalog of the file and moods, director-picks, friends, explore and search, once each; `retire` holds only lists, lists-unseen and director-picks", () => {
  refuses((j) => j.order.splice(1, 1), /missing: places/);
  refuses((j) => j.order.push("places"), /not allowed or twice: places/);
  refuses((j) => j.order.push("tonight"), /not allowed or twice: tonight/);
  refuses((j) => { j.order = j.order.filter((x) => x !== "search"); }, /missing: search/);
  refuses((j) => { j.retire = ["lists", "moods"]; }, /retire must be a list with only lists, lists-unseen and director-picks/);
  assert.deepEqual(parse((() => { const j = good(); j.retire = []; return j; })()).retire, []);
  assert.deepEqual(parse((() => { const j = good(); j.retire = ["lists", "lists-unseen", "director-picks"]; return j; })()).retire, ["lists", "lists-unseen", "director-picks"], "28/10/2026: director-picks may be retired (its cards moved into Directors)");
});

test("parse: floor and spread are whole numbers above zero; the extra of the seen filter has a name of its own", () => {
  refuses((j) => { j.floor.countries = 0; }, /floor must be \{ countries, eras \}/);
  refuses((j) => { j.floor.eras = 1.5; }, /floor must be/);
  refuses((j) => { delete j.floor; }, /floor must be/);
  refuses((j) => { j.spread.per = -1; }, /spread must be \{ per, window \}/);
  refuses((j) => { j.spread.window = "20"; }, /spread must be/);
  refuses((j) => { j.spread.perAfterFirstPage = 0; }, /spread must be/);
  refuses((j) => { j.spread.perAfterFirstPage = "5"; }, /spread must be/);
  refuses((j) => { j.spread.cap = 5; }, /spread must be/);
  const withAfter = good(); withAfter.spread = { per: 2, perAfterFirstPage: 5, window: 20 };
  assert.deepEqual(parse(withAfter).spread, { per: 2, perAfterFirstPage: 5, window: 20 }, "the second cap is read (Marco, 23/10/2026 ~18:30 UTC)");
  for (const name of ["genre", "decade", "runtime", "country", "rating", "search", "skip"]) refuses((j) => { j.seen.name = name; }, new RegExp(`seen.name "${name}" is an extra that already exists`));
  refuses((j) => { j.seen.option = ""; }, /seen must be \{ name, option \}/);
  refuses((j) => { j.version = 2; }, /version must be 1/);
  refuses((j) => { j.colour = "red"; }, /unknown key "colour"/);
});

test("parse: every problem at once, in a single error that counts them", () => {
  const j = good();
  j.catalogs[0].options.pop(); j.floor.countries = 0; j.catalogs[1].options[1].where = { region: "atlantis" };
  assert.throws(() => parse(j), (e) => { assert.match(e.message, /^data\/discover-catalogs.json has 3 problems:/); assert.match(e.message, /list aaa .* has no Discover catalog/); assert.match(e.message, /floor must be/); assert.match(e.message, /atlantis/); return true; });
  assert.throws(() => parse(null), /must be an object/);
});

test("load: no data/discover-catalogs.json is null — the build then writes an index without `discover` and says so", () => {
  assert.equal(DC.load(path.join(ROOT, "no", "such", "file.json")), null);
  const tmp = path.join(require("os").tmpdir(), `dc-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(good()));
  try { assert.deepEqual(DC.load(tmp), good()); } finally { fs.rmSync(tmp, { force: true }); }
});

// ── the real file, against the real config.json ────────────────────────────────────────────────────────────────────────────────────────────

const { keywordTerms } = require("../lib/index-export");
const BOARD = require("../lib/board").parse(CONFIG, "config.json board");
// the same call as build.js DISCOVER_SPEC: the keywords an `any` may name are the terms of the moods of the v2 index (the config's and the Board's)
const real = () => DC.parse(DC.load(), { lists: CONFIG.lists, today: TODAY, existingIds: [...CONFIG.board.order, ...CONFIG.moods.map((m) => m.id)], keywordTerms: keywordTerms([...CONFIG.moods, ...BOARD.moods]) });
/** Every list id the spec cites, wherever: an option, a union, an `any`, a card, or menuless. */
const citedLists = (spec) => [
  ...spec.catalogs.flatMap((c) => c.options).flatMap((o) => o.kind === "list" ? [o.list] : o.kind === "union" || o.kind === "any" ? o.lists : o.kind === "directors" ? o.cards.flatMap((k) => k.lists.map((l) => l.id)) : []),
  ...spec.menuless];

// Marco, 28/10/2026 (proposal 5): the test of 22/10/2026 that said "every list is a list option of exactly one catalog" is replaced — a list is now cited ONCE, in an option, a union, an `any`, a card, or `menuless`.
test("data/discover-catalogs.json: sound against config.json — every list cited exactly once (option, union, any, card or menuless; no number written here: a list added to config.json without a place is red), labels within 28 characters (Marco, 28/10/2026)", () => {
  const spec = real();
  const cited = citedLists(spec);
  assert.equal(new Set(cited).size, cited.length, "no list twice");
  assert.deepEqual([...cited].sort(), CONFIG.lists.map((l) => l.id).sort());
  for (const c of spec.catalogs) for (const o of c.options) if (o.kind !== "directors") assert.ok(o.label.length <= 28, `${c.id}: ${o.label}`);
  for (const c of spec.catalogs) for (const o of c.options) if (o.kind === "directors") for (const k of o.cards) assert.ok(k.label.length <= 28, `${c.id}: ${k.label}`);
  assert.deepEqual(spec.order.filter((id) => !DC.FIXED.includes(id)), spec.catalogs.map((c) => c.id), "the catalogs are in the menu's order");
  assert.ok(spec.order.indexOf("moods") === 0 && spec.order.at(-1) === "search" && spec.order.at(-2) === "explore");
});

// Marco, 28/10/2026 (proposal 5, plan section 5.5): the drawers of the new map, in order, with the number of options each has — the counts are the decision, written in the plan as "47/38/19/20/9/21/34-35/21/12/6" (Decades & eras is 40 since 14/11/2026: Chinese new waves became two eras and Polish cinema became two; 44 since 15/11/2026: Screwball comedy, Commedia all'italiana, British New Wave and German Expressionism are new); Directors is 32 (10 lists + the 22 cards of the night): the option Marco chose in question 2 had 34 with Megalopolis and the road movies loose, and on 29/10/2026 (between 06:02 and 07:50 UTC (the session did not run date -u at the answer), questionnaire) he decided the two lists enter the cards: see the test of the cards.
test("data/discover-catalogs.json: Marco, 28/10/2026 — the drawers in the order of the map (Moods ... Search, Craft new, Directors under the id filmmaker-picks), with the options of each; director-picks and the two lists catalogs retired; Explore filters by the Genres drawer", () => {
  const spec = real();
  assert.deepEqual(spec.order, ["moods", "places", "eras", "genres", "themes", "craft", "critics", "filmmaker-picks", "director-picks", "friends", "letterboxd", "seasons", "explore", "search"]);
  assert.deepEqual(spec.retire, ["lists", "lists-unseen", "director-picks"]);
  assert.deepEqual(spec.explore, { genre: "genres" });
  const names = Object.fromEntries(spec.catalogs.map((c) => [c.id, c.name]));
  assert.deepEqual(names, { places: "Mood Engine · Countries & regions", eras: "Mood Engine · Decades & eras", genres: "Mood Engine · Genres", themes: "Mood Engine · Themes", craft: "Mood Engine · Craft & form",
    critics: "Mood Engine · Critics & awards", "filmmaker-picks": "Mood Engine · Directors", letterboxd: "Mood Engine · Letterboxd & IMDb", seasons: "Mood Engine · Seasons & holidays" });
  const size = (c) => c.options.flatMap((o) => o.kind === "directors" ? o.cards : [o]).length;
  assert.deepEqual(Object.fromEntries(spec.catalogs.map((c) => [c.id, c.id === "filmmaker-picks" ? c.options.filter((o) => o.kind !== "directors").length : size(c)])),
    { places: 47, eras: 45, genres: 19, themes: 20, craft: 9, critics: 21, "filmmaker-picks": 10, letterboxd: 12, seasons: 6 }, "Directors: 10 outside the cards (2 Closet Picks + 8 loose); with the 22 cards of the night that come from the build it is 32 (Marco, 29/10/2026: Megalopolis and the road movies in the cards)");
});

// Marco, 28/10/2026 ("20 listas da gaveta `removidas`"): out of the menus, still in config.json (search and the chips of the film page).
test("data/discover-catalogs.json: Marco, 28/10/2026 — 20 lists leave the menus (`menuless`), by id, and each is still a list of config.json", () => {
  const spec = real();
  assert.deepEqual([...spec.menuless].sort(), ["1aHbm", "4XUmW", "GRJ4", "Rewi", "SWwe8", "TsQtG", "Vw3z2", "aRqxi", "g6Xms", "l8rqc", "l9opC", "qGQ6O", "qGRDE", "RGQuY", "FAbFG", "s2YE", "tspdt-poll21-250", "v42Ha", "v43F0", "xHj8"].sort());
  assert.equal(spec.menuless.length, 20);
});

test("data/discover-catalogs.json: what Marco answered on 22/10/2026, as changed on 28/10/2026 — Moods first and Explore, Search last; TSPDT: the 1,000, the 2026 poll, Beyond S&S and the 50 of 2025 are options, the 21st Century top 250 is inside Best of 21st c. and the 2021 poll left the menus; 11 regions with East Asia and Southeast Asia and no Asia; India a country and no region; the 8 added countries; the 7 optional eras; the floor 20", () => {
  const spec = real();
  const by = Object.fromEntries(spec.catalogs.map((c) => [c.id, c]));
  const ids = (c) => c.options.map((o) => o.id);
  assert.deepEqual(spec.seen, { name: "seen", option: "Include seen" });
  assert.deepEqual(spec.floor, { countries: 20, eras: 20 });
  for (const l of ["R7jhM", "tspdt-poll26-250", "tspdt-2025-50", "tspdt-beyond-ss-alist"]) assert.ok(by.critics.options.some((o) => o.list === l), `${l} in Critics & awards`);
  assert.ok(by.critics.options.some((o) => o.kind === "union" && o.lists.includes("tspdt-21c-250")), "the 21st Century top 250 is in the union Best of 21st c.");
  assert.ok(spec.menuless.includes("tspdt-poll21-250") && !spec.catalogs.some((c) => c.options.some((o) => o.list === "tspdt-poll21-250")), "the 2021 poll is out of the menus (its edition is older)");
  const tspdt = by.critics.options.map((o) => o.list).filter((l) => l && (l === "R7jhM" || l.startsWith("tspdt-")));
  const at = by.critics.options.findIndex((o) => o.list === "R7jhM");
  assert.deepEqual(by.critics.options.slice(at, at + tspdt.length).map((o) => o.list), tspdt, "the TSPDT lists sit together, in the block of the rankings");
  const regions = by.places.options.filter((o) => o.where);
  assert.equal(regions.length, 11);
  assert.ok(ids(by.places).slice(0, 11).every((id) => id.startsWith("r-")), "the regions come first");
  for (const r of ["East Asia", "Southeast Asia", "Oceania", "Iberia"]) assert.ok(regions.some((o) => o.label === r), r);
  assert.ok(!regions.some((o) => o.id === "r-asia" || o.where.region === "asia"), "the Board's Asia is split in two");
  assert.ok(!regions.some((o) => o.label === "India"), "India is a country only");
  const countries = by.places.options.filter((o) => o.kind === "country").map((o) => o.label);
  for (const c of ["India", "Philippines", "Yugoslavia", "Finland", "Ireland", "Romania", "Chile", "Turkey", "Greece"]) assert.ok(countries.includes(c), c);
  assert.equal(new Set(countries).size, countries.length);
  const eras = by.eras.options.filter((o) => o.id.startsWith("e-")).map((o) => o.id);
  for (const e of ["late-soviet", "postwar-britain", "giallo", "hk-kung-fu", "parallel-cinema"]) assert.ok(eras.includes(`e-${e}`), e);
  // Marco, 14/11/2026: "Chinese new waves" is two eras (Fifth and Sixth Generation) and "Polish cinema" is two (Polish School and Cinema of Moral Anxiety); the two old ids are gone
  for (const e of ["china-fifth-gen", "china-sixth-gen", "polish-school", "moral-anxiety"]) assert.ok(eras.includes(`e-${e}`), e);
  for (const e of ["china-new-waves", "polish-cinema"]) assert.ok(!eras.includes(`e-${e}`), `e-${e} was split in two on 14/11/2026`);
  // Marco, 28/10/2026 ("eras do mais recente para o mais antigo"): the decades come newest first (they were oldest first on 22/10/2026), and so do the eras between them
  assert.equal(by.eras.options.filter((o) => o.kind === "decade").map((o) => o.decade).join(), "2020s,2010s,2000s,1990s,1980s,1970s,1960s,1950s,1940s,1930s,1920s");
});

// Marco's answers 4(c), 5(b) and 6(b) are LISTS, and the lists are the decision: 36 countries, 11 regions with their countries, 27 eras (29 since 14/11/2026: two of them became four). They are pinned here by name (the review of 22/10/2026 turned four of them
// red without a test noticing: East Asia without MO, KP, MN and with TH; Austria out; Weimar out; a country under the floor). A country or an era added later is a decision, and this test is the place that says so.
test("data/discover-catalogs.json: the 11 regions have exactly the countries of Marco's answer 5(b), and East Asia + Southeast Asia are the Board's Asia of lib/countries.js REGIONS, with no country in both", () => {
  const REGIONS = require("../lib/countries").REGIONS;
  const places = real().catalogs.find((c) => c.id === "places").options.filter((o) => o.kind === "where");
  const by = Object.fromEntries(places.map((o) => [o.label, o.where]));
  // Marco, 28/10/2026: the regions in HIS order (on 22/10/2026 they were in the spec's: Latin America, Europe, British and Irish cinema, Nordic countries, Eastern Europe and Russia, Middle East, East Asia, Southeast Asia, Africa, Oceania, Iberia)
  assert.deepEqual(places.map((o) => o.label), ["Latin America", "Europe", "Southeast Asia", "East Asia", "Nordic countries", "British and Irish cinema", "Eastern Europe and Russia", "Middle East", "Africa", "Oceania", "Iberia"]);
  assert.deepEqual([by["Latin America"], by.Europe, by["British and Irish cinema"], by["Nordic countries"], by["Eastern Europe and Russia"], by["Middle East"], by.Africa],
    [{ region: "latin-america" }, { region: "europe" }, { region: "british" }, { region: "nordic" }, { region: "eastern-bloc" }, { region: "middle-east" }, { region: "africa" }], "the six regions of the Board keep their rule, and Africa");
  assert.deepEqual(by["East Asia"], { countries: ["JP", "CN", "HK", "MO", "TW", "KR", "KP", "MN"] });
  assert.deepEqual(by["Southeast Asia"], { countries: ["TH", "PH", "VN", "ID", "MY", "SG", "KH", "LA", "MM", "BN", "TL"] });
  assert.deepEqual(by.Oceania, { countries: ["AU", "NZ", "FJ", "PG", "WS", "TO"] });
  assert.deepEqual(by.Iberia, { countries: ["ES", "PT"] });
  const ea = by["East Asia"].countries, sea = by["Southeast Asia"].countries;
  assert.deepEqual([...ea, ...sea].sort(), [...REGIONS.asia].sort(), "together they are the Board's Asia");
  assert.equal(new Set([...ea, ...sea]).size, ea.length + sea.length, "no country in both");
  assert.ok(!REGIONS.asia.includes("IN"), "India is not in Asia of the Board, and is a country only here");
});

/** The 45 options of Decades & eras, newest first (Marco, 28/10/2026; 14/11/2026: the two Chinese eras and the two Polish ones, each placed by the year it starts; 15/11/2026: the four new eras and the years that moved: each option stands where its first year puts it, the eras before the decade that starts the same year). */
const ERAS_ORDER = [
    "d-2020s", "d-2010s", "d-2000s", "e-korean-new-wave", "e-china-sixth-gen", "d-1990s", "e-american-indie", "e-china-fifth-gen", "e-taiwan-new-cinema", "e-iran-art-cinema", "d-1980s", "e-hk-new-wave",
    "e-moral-anxiety", "e-hk-kung-fu", "d-1970s", "e-parallel-cinema", "e-late-soviet", "e-new-hollywood", "e-giallo", "e-iran-new-wave", "e-new-german", "e-czech-new-wave", "d-1960s",
    "e-commedia-italiana", "e-soviet-thaw", "e-japan-new-wave", "e-british-new-wave", "e-cinema-novo", "e-nouvelle-vague", "e-polish-school", "e-japan-golden", "d-1950s", "e-postwar-britain",
    "e-neorealism", "e-noir", "d-1940s", "e-classic-hollywood", "e-poetic-realism", "e-precode", "e-screwball", "d-1930s", "e-german-expressionism", "e-weimar", "e-silent", "d-1920s"];

test("data/discover-catalogs.json: the 36 countries of Marco's answer 4(c) (20 films), the 34 eras (the 27 of 6(b), two of them split on 14/11/2026, four new on 15/11/2026, and the Iranian one split in two by Marco on 15/11/2026) and the 11 decades, by name", () => {
  const spec = real();
  const by = Object.fromEntries(spec.catalogs.map((c) => [c.id, c]));
  const countries = by.places.options.filter((o) => o.kind === "country");
  assert.deepEqual(countries.map((o) => o.country), countries.map((o) => o.label), "the option's name is the country it selects");
  assert.deepEqual(countries.map((o) => o.label).sort(), [
    "Argentina", "Australia", "Austria", "Belgium", "Brazil", "Canada", "Chile", "China", "Czechoslovakia", "Denmark", "Finland", "France", "Germany", "Greece", "Hong Kong", "Hungary", "India", "Iran", "Ireland", "Italy", "Japan", "Mexico",
    "Philippines", "Poland", "Portugal", "Romania", "Russia", "South Korea", "Soviet Union", "Spain", "Sweden", "Taiwan", "Turkey", "United Kingdom", "United States", "Yugoslavia"].sort());
  assert.equal(countries.length, 36);
  const eras = by.eras.options.filter((o) => o.kind === "where" || o.kind === "era"); // since 14/11/2026 the eras of a movement or a cycle are `era` (data/eras/<id>.json), the periods and Giallo stay `where`
  assert.deepEqual(eras.map((o) => o.id).sort(), ["e-american-indie", "e-british-new-wave", "e-china-fifth-gen", "e-china-sixth-gen", "e-cinema-novo", "e-classic-hollywood", "e-commedia-italiana", "e-czech-new-wave", "e-german-expressionism", "e-giallo", "e-hk-kung-fu", "e-hk-new-wave", "e-iran-art-cinema", "e-iran-new-wave", "e-japan-golden", "e-japan-new-wave", "e-korean-new-wave", "e-late-soviet", "e-moral-anxiety", "e-neorealism", "e-new-german", "e-new-hollywood", "e-noir", "e-nouvelle-vague", "e-parallel-cinema", "e-poetic-realism", "e-polish-school", "e-postwar-britain", "e-precode", "e-screwball", "e-silent", "e-soviet-thaw", "e-taiwan-new-cinema", "e-weimar"].sort());
  assert.equal(eras.length, 34);
  assert.deepEqual(by.eras.options.filter((o) => o.kind === "decade").map((o) => o.decade), ["2020s", "2010s", "2000s", "1990s", "1980s", "1970s", "1960s", "1950s", "1940s", "1930s", "1920s"], "Marco, 28/10/2026: newest first");
  assert.deepEqual(by.eras.options.filter((o) => o.kind === "decade").map((o) => o.label), by.eras.options.filter((o) => o.kind === "decade").map((o) => o.decade));
  // Marco, 28/10/2026 ("eras do mais recente para o mais antigo", "países A–Z"): the countries come A-Z (on 22/10/2026 by size) and the 38 eras and decades in the order of the map, the newest first; the eras that are only a list left the drawer (their lists are in `menuless`)
  assert.deepEqual(countries.map((o) => o.label), countries.map((o) => o.label).sort((x, y) => x.localeCompare(y, "en")), "A-Z");
  assert.ok(by.eras.options.every((o) => o.kind !== "list"), "no list is a menu option of Decades & eras any more");
  assert.deepEqual(by.eras.options.map((o) => o.id), ERAS_ORDER);
});
test("data/discover-catalogs.json: each era carries the years and the countries or directors of its source (the Marco decisions that are numbers: Weimar 1919–33, Poetic realism to 1945, Neorealism to 1955, Nouvelle Vague to 1973, Iranian to 2009, Taiwan to 2000, Korean from 1996)", () => {
  const ERA = require("../lib/era-lists");
  const options = real().catalogs.find((c) => c.id === "eras").options.filter((o) => o.kind === "where" || o.kind === "era");
  // the periods keep their `where`; an era of a movement or a cycle has its years in data/eras/<id>.json (lib/era-lists.js)
  const eras = Object.fromEntries(options.map((o) => [o.id, o.kind === "era" ? { years: ERA.read(o.id).years } : o.where]));
  assert.deepEqual(eras["e-weimar"], { countries: ["DE"], years: { min: 1919, max: 1933 } });
  assert.deepEqual(eras["e-neorealism"].years, { min: 1943, max: 1955 }, "14/11/2026 21:32 UTC Marco kept 1943–52; at ~22:15 UTC he chose \"Extend to 1955\" (Journey to Italy, Senso, The Gold of Naples, Abandoned)");
  assert.equal(eras["e-neorealism"].countries, undefined, "the country of a school is in its file (`school.countries`), not here");
  assert.deepEqual(eras["e-classic-hollywood"], { countries: ["US"], years: { min: 1935, max: 1966 } });
  assert.deepEqual(eras["e-poetic-realism"].years, { min: 1930, max: 1945 });
  assert.deepEqual(eras["e-nouvelle-vague"].years, { min: 1955, max: 1974 }, "15/11/2026: the years of the BFI and the Criterion Channel (the session, differing from the research)");
  assert.deepEqual(eras["e-iran-new-wave"].years, { min: 1962, max: 1979 }, "Marco, 15/11/2026: \"Two eras: New Wave 1962–79 and Iranian art cinema 1980–\"");
  assert.deepEqual(eras["e-iran-art-cinema"].years, { min: 1980 }, "the second Iranian era has no last year");
  assert.deepEqual(eras["e-taiwan-new-cinema"].years, { min: 1982, max: 2000 });
  assert.deepEqual(eras["e-korean-new-wave"].years, { min: 1996 });
  assert.deepEqual(eras["e-noir"].years, { min: 1940, max: 1959 });
  assert.deepEqual(eras["e-precode"].years, { min: 1930, max: 1934 }, "Marco, 15/11/2026: \"No, start in 1930\"");
  const nv = ERA.read("e-nouvelle-vague").school.directors;
  assert.ok(nv.some((d) => d.id === 3776 && /Godard/.test(d.name)) && nv.some((d) => d.id === 1650), "Godard and Truffaut");
});

test("data/discover-catalogs.json: 17 eras are schools and 8 are lists (cycles) in data/eras/, and the 9 periods are country + years (where); no era has a music film's evidence rule of its own (the Worker holds it for every cut)", () => {
  const ERA = require("../lib/era-lists");
  const options = real().catalogs.find((c) => c.id === "eras").options.filter((o) => o.kind === "where" || o.kind === "era");
  const kind = (o) => ERA.read(o.id).type;
  assert.deepEqual(options.filter((o) => o.kind === "era" && kind(o) === "school").map((o) => o.id).sort(), ["e-china-fifth-gen", "e-china-sixth-gen", "e-cinema-novo", "e-czech-new-wave", "e-hk-new-wave", "e-iran-art-cinema", "e-iran-new-wave", "e-japan-new-wave", "e-korean-new-wave",
    "e-moral-anxiety", "e-neorealism", "e-new-german", "e-nouvelle-vague", "e-parallel-cinema", "e-poetic-realism", "e-polish-school", "e-taiwan-new-cinema"], "a movement: a sourced list of films OR a listed director's film made in the country of the movement");
  assert.deepEqual(options.filter((o) => o.kind === "era" && kind(o) === "cycle").map((o) => o.id).sort(), ["e-british-new-wave", "e-commedia-italiana", "e-german-expressionism", "e-giallo", "e-new-hollywood", "e-noir", "e-precode", "e-screwball"],
    "a list of films alone (Marco, 15/11/2026: New Hollywood by institutions, Giallo by the film list, noir and Pre-Code by lists; Screwball, Commedia and British New Wave new)");
  assert.deepEqual(options.filter((o) => o.kind === "where").map((o) => o.id).sort(), ["e-american-indie", "e-classic-hollywood", "e-hk-kung-fu", "e-japan-golden", "e-late-soviet", "e-postwar-britain", "e-silent", "e-soviet-thaw", "e-weimar"], "the periods keep their rule");
  assert.ok(!Object.keys(DC.load()).includes("musicNeedsEvidence"));
});

// ── the drawers of proposal 5 (Marco, 28/10/2026) ──────────────────────────────────────────────────────────────────────────────────────────
// Mutations these tests are meant to turn red (front D, 29/10/2026): a card key one letter off ("Martel love"), a list moved out of its card, Erotic Thrillers out of Thriller, `musical` back in Dance,
// the IMDb top rated rule changed to the 8.2 of the text of the map, Genres out of alphabetical order, the Explore filter pointing at another drawer, Long films at 179 minutes.

/** The 22 "X loves" options of `index.directors.options` in the offline build of 28/10/2026 (cache frozen at 5c5cc6c; labels read from data/index-v2-menus.json of that build). A snapshot: the labels of a night depend on the ratings. */
const DIRECTOR_LABELS_28_10 = ["Francis Ford Coppola loves", "Martel loves", "Kubrick loves", "Bergman loves", "Wenders loves", "Lanthimos loves", "Paul Thomas Anderson loves", "Fellini loves", "Leigh loves", "Hitchcock loves", "Villeneuve loves",
  "Iñárritu loves", "Salles loves", "Linklater loves", "Baker loves", "Sofia Coppola loves", "Tarantino loves", "Almodóvar loves", "Scorsese loves", "Chazelle loves", "Wes Anderson loves", "Fincher loves"];

const drawer = (id) => real().catalogs.find((c) => c.id === id);
const cardsOf = () => real().catalogs.find((c) => c.id === "filmmaker-picks").options.find((o) => o.kind === "directors").cards;

test("data/discover-catalogs.json: Marco, 28/10/2026 — Genres are 19 `any` options in alphabetical order, each the TMDB genre + its keyword family + its curated lists (lists first); Noir has no TMDB genre and Sci-fi is Science Fiction; CC · Erotic Thrillers is in Thriller (answer 1)", () => {
  const g = drawer("genres").options;
  assert.deepEqual(g.map((o) => o.label), ["Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary", "Drama", "Family", "Fantasy", "History", "Horror", "Music", "Mystery", "Noir", "Romance", "Sci-fi", "Thriller", "War", "Western"]);
  assert.deepEqual(g.map((o) => o.label), [...g.map((o) => o.label)].sort((x, y) => x.localeCompare(y, "en")), "alphabetical");
  assert.ok(g.every((o) => o.kind === "any" && o.id.startsWith("g-")));
  const lists = Object.fromEntries(g.map((o) => [o.label, o.lists]));
  assert.deepEqual(lists, { Action: ["hKj3Y", "P9eui"], Adventure: [], Animation: ["indiewire-animated-2025"], Comedy: ["vec98"], Crime: [], Documentary: ["1R3EO", "8RGgu", "iw-docs-2024"], Drama: [], Family: [], Fantasy: [], History: [],
    Horror: ["dCcac", "poxvK", "oUG3A", "pqL8a"], Music: ["asnPI", "WaoLy", "X5VrU"], Mystery: [], Noir: ["A305G", "dUtkE", "jMnm"], Romance: ["l9cYK", "cyImC", "hGHCU", "sCCek"], "Sci-fi": ["tIqsq", "nxwmC"], Thriller: ["m8t7U"], War: [], Western: [] });
  assert.equal(CONFIG.lists.find((l) => l.id === "m8t7U").short, "CC · Erotic Thrillers", "answer 1 is about this list: in Thriller, not loose and not in Themes");
  const by = Object.fromEntries(g.map((o) => [o.label, o]));
  assert.equal(by.Noir.genre, null, "Noir is no TMDB genre: lists and keywords only");
  assert.equal(by["Sci-fi"].genre, "Science Fiction");
  for (const o of g) if (o.label !== "Noir") assert.equal(o.genre, o.label === "Sci-fi" ? "Science Fiction" : o.label, `${o.label}: the TMDB genre`);
  for (const l of ["Animation", "History", "Sci-fi", "War", "Western"]) assert.deepEqual(by[l].keywords, [], `${l} has no keyword family (the index column holds none of its terms)`);
  assert.deepEqual(by.Noir.keywords, ["femme fatale", "film noir", "neo-noir", "noir", "private detective"]);
  assert.deepEqual(by.Thriller.keywords, ["anxious", "conspiracy", "hostage", "paranoia", "psychological thriller", "stalker", "suspenseful", "tense"]);
  assert.equal(by.Drama.keywords.length, 5);
});

test("data/discover-catalogs.json: Marco, 28/10/2026 — Themes are 20 options, Craft & form 9 (the term `musical` is out of Dance, Long films is 180 minutes or more), Seasons 6 with their lists and words", () => {
  const themes = drawer("themes").options;
  assert.deepEqual(themes.map((o) => o.label), ["Artists & writers", "Comfort & gentle", "Coming of age", "Family", "Feel something", "Friendship", "Grief & loneliness", "Heists & gangsters", "Hotels & apartments", "Late night", "LGBTQ+",
    "Love & marriage", "Politics & conspiracy", "Psychosexual dramas", "Revenge", "Road trips & journeys", "Satire & absurd", "Small towns & countryside", "Survival", "War"]);
  const t = Object.fromEntries(themes.map((o) => [o.label, o]));
  assert.deepEqual(t["Feel something"].lists, ["1qX2M", "sPMW", "nZrSk", "2cApa"]);
  assert.equal(t["LGBTQ+"].list, "cg9sY", "a list alone keeps a label of its own");
  assert.equal(t.War.list, "FAcf0");
  const craft = drawer("craft").options;
  assert.deepEqual(craft.map((o) => o.label), ["Acting", "Anthology films", "Cinematography & colour", "Dance & musicals", "Experimental & avant-garde", "Exploitation & camp", "Long films, 3h+", "Slow cinema", "Under 100 min"]);
  const c = Object.fromEntries(craft.map((o) => [o.label, o]));
  assert.deepEqual(c["Dance & musicals"].keywords, ["dance", "dancing"], "`musical` has 0 films in the column of the index (measured 28/10/2026): out of the family");
  assert.deepEqual([c["Long films, 3h+"].kind, c["Long films, 3h+"].min], ["runtime", 180]);
  assert.deepEqual(c["Slow cinema"].lists, ["5R3nu", "8UNg"]);
  assert.deepEqual(c["Under 100 min"].lists, ["TsT1A", "CzHG"]);
  const seasons = drawer("seasons").options;
  assert.deepEqual(seasons.map((o) => o.label), ["Christmas & holidays", "New Year's Eve", "Halloween", "Winter & snow", "Summer & beach", "Rainy days"]);
  const s = Object.fromEntries(seasons.map((o) => [o.label, o]));
  assert.deepEqual([s["Christmas & holidays"].lists, s["Christmas & holidays"].keywords], [["r2kLE", "qJwme", "qzvQW", "qzuGc", "ek1Zm", "jtzhQ"], ["christmas", "christmas eve", "santa claus"]]);
  assert.deepEqual([s.Halloween.kind, s.Halloween.lists], ["union", ["pQWeK", "pTamC"]]);
  assert.deepEqual([s["Summer & beach"].lists, s["Summer & beach"].keywords], [["cVG0q", "nzQyi", "hGHRq", "Ig3Kg"], ["summer", "beach", "summer vacation", "vacation", "seaside"]]);
  assert.deepEqual(s["New Year's Eve"].keywords, ["new year's eve"]);
});

test("data/discover-catalogs.json: Marco, 28/10/2026 (answer 5) — Letterboxd & IMDb in the order of the map; IMDb top rated is the 250 best IMDb ratings with the ties and at least 1,000 TMDB votes, NOT the 8.2 of the text of the map", () => {
  const l = drawer("letterboxd").options;
  assert.deepEqual(l.map((o) => o.label), ["Loved on both", "LB Top 250 Most Fans", "LB Top 500 Narrative", "IMDb top rated", "Top 250 International", "Everyone should watch once", "LB Top 100 Underseen", "Secret gems", "LB Top 100 Taiwanese", "IMDb 8.0+", "Letterboxd 4.0+", "LB Popular this week"]);
  const by = Object.fromEntries(l.map((o) => [o.label, o]));
  assert.deepEqual(by["IMDb top rated"], { id: "n-imdb-top-rated", label: "IMDb top rated", kind: "rating", imdbTop: 250, tmdbVotesMin: 1000 });
  assert.deepEqual(by["Loved on both"], { id: "n-loved-on-both", label: "Loved on both", kind: "rating", imdbMin: 8, lbMin: 4 });
  assert.deepEqual([by["IMDb 8.0+"].imdbMin, by["Letterboxd 4.0+"].lbMin], [8, 4]);
  assert.ok(!l.some((o) => o.imdbMin === 8.2));
});

test("data/discover-catalogs.json: Marco, 28/10/2026 (answers 2 and 3) — a card of a director is ALL the lists of the director himself plus his \"X loves\", and is called \"X loves\"; Francis Ford Coppola's Closet Picks are his and not Sofia's; Sofia Coppola has her \"loves\" alone", () => {
  const cards = cardsOf();
  assert.deepEqual(cards.map((k) => k.key), ["Francis Ford Coppola loves", "Martel loves", "Wenders loves", "Leigh loves", "Villeneuve loves", "Salles loves", "Baker loves", "Scorsese loves"]);
  assert.deepEqual(Object.fromEntries(cards.map((k) => [k.key, k.lists.map((l) => l.id)])), {
    "Francis Ford Coppola loves": ["xzt0W", "BHK3g", "yPRy0"], "Martel loves": ["snCbg"], "Wenders loves": ["sofqa", "wWAxK", "BiIyG"], "Leigh loves": ["snpM4"], "Villeneuve loves": ["DnJog"], "Salles loves": ["D0GkE"], "Baker loves": ["snwqE"], "Scorsese loves": ["maWk"] });
  for (const k of cards) assert.equal(k.label, k.key, "answer 3: the name of the card is \"X loves\", no \"+ Closet Picks\"");
  assert.match(CONFIG.lists.find((l) => l.id === "BHK3g").url, /francis-ford-coppolas-criterion-closet-picks/, "the evidence of answer 2: the address of 'Closet Picks · Coppola' is Francis's");
  assert.ok(!cards.some((k) => /Sofia/.test(k.key)), "Sofia Coppola has no card with lists");
  // the lists that stay outside the cards: the first two Closet Picks, then the loose ones in the place proposal 5 has them (after the cards): Megalopolis and the Wenders road movies (the option Marco chose, question 2 of the plan: "Megalopolis, road movies e Voyage to Italy continuam soltas"; review of 29/10/2026 reverted the session's addition of both to the cards), Von Trier, Wright x2, Aster, del Toro, Gudegast, Herzog and Voyage to Italy
  const rest = drawer("filmmaker-picks").options.filter((o) => o.kind === "list").map((o) => o.list);
  assert.deepEqual(rest, ["snFyM", "tp03m", "SE1Ga", "snq4i", "sEogA", "sptoY", "53tAO", "CBSLW", "PQMVe", "q00BQ"]);
  const inCards = new Set(cards.flatMap((k) => k.lists.map((l) => l.id)));
  assert.ok(inCards.has("yPRy0") && inCards.has("BiIyG") && !inCards.has("q00BQ"), "Megalopolis and the road movies are in the cards (Marco, 29/10/2026 between 06:02 and 07:50 UTC (the session did not run date -u at the answer), questionnaire); Voyage to Italy stays loose");
  assert.equal(drawer("filmmaker-picks").options[2].kind, "directors", "the cards sit after the two Closet Picks lists, at the place of the first card of the map");
});

test("data/discover-catalogs.json: every card key is the exact label the build gives a director — \"<short name> loves\", lib/directors-loved.js shortNames over data/directors-loved.json, and one of the 22 options of the build of 28/10/2026; a key one letter off turns the card into loose lists (review of front A, 28/10/2026)", () => {
  const DL = require("../lib/directors-loved");
  const lc = { ...DL.DEFAULTS, ...(CONFIG.directorsLoved || {}) };
  const data = DL.load(ROOT, lc);
  const names = data.directors.filter((d) => (d.films || []).length).map((d) => d.name);
  const possible = new Set([...DL.shortNames(names, lc.labels).values()].map((s) => `${s} loves`));
  const keys = cardsOf().map((k) => k.key);
  for (const k of keys) { assert.ok(possible.has(k), `"${k}" is no "<short name> loves" of data/directors-loved.json`); assert.ok(DIRECTOR_LABELS_28_10.includes(k), `"${k}" was no option of the build of 28/10/2026`); }
  // the build, over the 22 options of that night: every card is made, no list of a card becomes a loose option, and the control: a key one letter off makes the lists loose and the card is lost
  const spec = real();
  const options = DIRECTOR_LABELS_28_10.map((label) => ({ label, ids: [] }));
  const out = DC.build({ spec, index: { films: [], lists: [], directors: { options } }, recordOf: () => null });
  const made = out.catalogs.find((c) => c.id === "filmmaker-picks").options;
  assert.deepEqual(made.filter((o) => o.director).map((o) => o.director), DIRECTOR_LABELS_28_10, "the 22 cards, in the order of the build");
  assert.deepEqual(made.filter((o) => o.list && o.id.startsWith("l-")).map((o) => o.list), ["snFyM", "tp03m", "SE1Ga", "snq4i", "sEogA", "sptoY", "53tAO", "CBSLW", "PQMVe", "q00BQ"], "only the 10 lists of the drawer are loose: none fell back from a card");
  assert.equal(made.length, 32, "10 lists + 22 cards: Directors has 32 options (Marco, 28/10/2026 question 2 + 29/10/2026 the two lists in the cards)");
  const spoiled = JSON.parse(JSON.stringify(DC.load()));
  const dirs = spoiled.catalogs.find((c) => c.id === "filmmaker-picks").options.find((o) => o.directors).directors;
  dirs["Martel love"] = dirs["Martel loves"]; delete dirs["Martel loves"];
  const broken = DC.parse(spoiled, { lists: CONFIG.lists, today: TODAY, existingIds: [...CONFIG.board.order, ...CONFIG.moods.map((m) => m.id)], keywordTerms: keywordTerms([...CONFIG.moods, ...BOARD.moods]) });
  const lost = DC.build({ spec: broken, index: { films: [], lists: [], directors: { options } }, recordOf: () => null }).catalogs.find((c) => c.id === "filmmaker-picks").options;
  assert.ok(lost.some((o) => o.list === "snCbg"), "control: with a wrong key the Martel list falls out of its card as a loose option");
});

test("data/discover-catalogs.json: no `any` or union names a keyword that is not a term of the moods (the parse refuses it) and no Genres option is a curated one (Explore needs only `any`): the real file passes with the terms of the real moods and fails with none", () => {
  assert.doesNotThrow(real);
  assert.throws(() => DC.parse(DC.load(), { lists: CONFIG.lists, today: TODAY, existingIds: [...CONFIG.board.order, ...CONFIG.moods.map((m) => m.id)] }), /is not a positive term of the moods/);
  assert.ok(drawer("genres").options.every((o) => o.kind === "any"));
});

// Marco, 28/10/2026 (front D): `build.js --discover-file <path>` reads another catalogs file in place of data/discover-catalogs.json (the legacy-parity test builds with the file of 22/10/2026 because its reduced moods lack
// the keywords of the production file). Mutation this test turns red: the flag ignored (the production file is read, it is sound, and the build does not stop here).
test("build.js --discover-file: a file that is not there stops the build with a message that names it, and a file that parse() refuses stops it with the problems; the default file is sound, so only a flag that is read can do either", () => {
  const { spawnSync } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mood-discover-flag-"));
  try {
    const bad = path.join(tmp, "bad.json");
    fs.writeFileSync(bad, JSON.stringify({ version: 2 }));
    const run = (file) => spawnSync(process.execPath, [path.join(ROOT, "build.js"), "--offline", "--cache-only", "--skip-posters", "--date", "2026-10-13", "--cache-dir", path.join(tmp, "cache"), "--out", path.join(tmp, "out"), "--discover-file", file],
      { cwd: ROOT, encoding: "utf8", timeout: 120000, env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" } });
    const missing = run(path.join(tmp, "nowhere.json"));
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /--discover-file .*nowhere\.json: no such file/);
    const refused = run(bad);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /has \d+ problems:\n\s+- version must be 1, got 2/);
    // review of 29/10/2026 (item 8): the missing-file check sat after `if (!BOARD) return null`, so a build with no Board (`--skip-friends`) took a typo in the path without stopping; and `--discover-file` as the last argument,
    // or followed by another flag, fell back to the default file in silence. Mutation this turns red: the existence check moved back after the Board test.
    const base = ["--offline", "--cache-only", "--skip-posters", "--date", "2026-10-13", "--cache-dir", path.join(tmp, "cache"), "--out", path.join(tmp, "out")];
    const runArgs = (args) => spawnSync(process.execPath, [path.join(ROOT, "build.js"), ...args], { cwd: ROOT, encoding: "utf8", timeout: 120000, env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" } });
    const noBoard = runArgs([...base, "--skip-friends", "--discover-file", path.join(tmp, "nowhere.json")]);
    assert.equal(noBoard.status, 1, "a build with no Board stops on a path that is not there too");
    assert.match(noBoard.stderr, /--discover-file .*nowhere\.json: no such file/);
    const last = runArgs([...base, "--discover-file"]);
    assert.equal(last.status, 1, "the flag as the last argument has no path: stops, does not read the default file");
    assert.match(last.stderr, /--discover-file needs a path/);
    const beforeFlag = runArgs([...base, "--discover-file", "--skip-friends"]);
    assert.equal(beforeFlag.status, 1, "the flag followed by another flag has no path either");
    assert.match(beforeFlag.stderr, /--discover-file needs a path/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ── the membership the build works out ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** An entry of the index (object form) and the TMDB record behind it. */
let n = 0;
function planted(o = {}) {
  const tt = `tt${String(++n).padStart(7, "0")}`;
  const entry = { tt, name: o.name || `Film ${n}`, year: o.year ?? 1962, decade: `${Math.floor((o.year ?? 1962) / 10) * 10}s`, countries: o.countries ?? ["France"], director: o.director ?? `Director ${n}`, lbRating: 4, rank: 100 - n, eligible: true, find: ` film ${n}`, ...o.entry };
  if (o.eligible === false) delete entry.eligible;
  const rec = o.rec === null ? null : { imdb: tt, countries: ["FR"], lang: "fr", year: entry.year, directors: [], genres: [], keywords: [], ...o.rec };
  return { entry, rec };
}
function world(films, spec, spreadSpec) {
  const records = new Map(films.map(({ entry, rec }) => [entry.tt, rec]));
  const index = { films: films.map((f) => f.entry), lists: [] };
  const logged = [];
  const out = DC.build({ spec: DC.parse({ ...good(), ...(spreadSpec ? { spread: spreadSpec } : {}), floor: { countries: 1, eras: 1 }, order: orderOf(spec), catalogs: spec }, { lists: [], today: TODAY }), index, recordOf: (tt) => records.get(tt) || null, log: (l) => logged.push(l) });
  return { out, logged, ids: (cat, option) => out.catalogs.find((c) => c.id === cat).options.find((o) => o.id === option).ids };
}
const catalog = (id, options) => [{ id, name: `Mood Engine · ${id}`, options }];
const orderOf = (spec) => ["moods", ...spec.map((c) => c.id), "director-picks", "friends", "explore", "search"];

test("build: a region follows the film's MAIN country (the language rule of 14/10/2026), not the card's: an English film of GB and US is American, so it is in no 'British and Irish cinema' and its card still says United Kingdom", () => {
  const topsy = planted({ name: "Topsy-Turvy", countries: ["United Kingdom", "United States"], rec: { countries: ["GB", "US"], lang: "en" } });
  const brit = planted({ countries: ["United Kingdom"], rec: { countries: ["GB"], lang: "en" } });
  const french = planted({ countries: ["France"], rec: { countries: ["FR"], lang: "fr" } });
  const w = world([topsy, brit, french], catalog("places", [{ id: "r-british", label: "British and Irish cinema", where: { region: "british" } }, { id: "r-europe", label: "Europe", where: { region: "europe" } }, { id: "c-uk", label: "United Kingdom", country: "United Kingdom" }]));
  assert.deepEqual(w.ids("places", "r-british"), [brit.entry.tt]);
  assert.deepEqual(w.ids("places", "r-europe"), [french.entry.tt]);
  assert.deepEqual(w.ids("places", "c-uk"), [topsy.entry.tt, brit.entry.tt], "by the card the English film with an American producer is British");
});

test("build: a region made of a list of countries reads the main country too — Japanese-language JP + FR is East Asia, French-language FR + JP is not — and each film counts in one region", () => {
  const jp = planted({ rec: { countries: ["JP", "FR"], lang: "ja" } }), fr = planted({ rec: { countries: ["FR", "JP"], lang: "fr" } }), th = planted({ rec: { countries: ["TH"], lang: "th" } });
  const w = world([jp, fr, th], catalog("places", [{ id: "r-ea", label: "East Asia", where: { countries: ["JP", "CN", "KR"] } }, { id: "r-sea", label: "Southeast Asia", where: { countries: ["TH", "VN"] } }, { id: "r-europe", label: "Europe", where: { region: "europe" } }]));
  assert.deepEqual(w.ids("places", "r-ea"), [jp.entry.tt]);
  assert.deepEqual(w.ids("places", "r-sea"), [th.entry.tt]);
  assert.deepEqual(w.ids("places", "r-europe"), [fr.entry.tt]);
});

test("build: the option of a country is the country of the card — the column `country` when the film has it (written only when the facts line cannot read it from `countries`), else the first of `countries`; a film with neither is in no country", () => {
  const a = planted({ countries: ["Japan", "France"] }), b = planted({ countries: ["Japan", "France"], entry: { country: "France" } }), c = planted({ countries: undefined, entry: { countries: undefined, country: "Japan" } }), d = planted({ entry: { countries: undefined } });
  delete d.entry.countries; delete a.entry.country;
  const w = world([a, b, c, d], catalog("places", [{ id: "c-japan", label: "Japan", country: "Japan" }, { id: "c-france", label: "France", country: "France" }]));
  assert.deepEqual(w.ids("places", "c-japan"), [a.entry.tt, c.entry.tt]);
  assert.deepEqual(w.ids("places", "c-france"), [b.entry.tt]);
  assert.equal(DC.countryOf({ countries: ["A", "B"] }), "A");
  assert.equal(DC.countryOf({ country: "B", countries: ["A", "B"] }), "B");
  assert.equal(DC.countryOf({}), null);
});

test("countryOf is the `country` of factsByTt (lib/index-export.js), the country that the index column `countries` shows first (the cover's flag follows pickCountry, another rule, pending the decision on the country): the same answer for a film with the column, one with countries only and one with neither", () => {
  const withColumn = planted({ countries: ["Japan", "France"], entry: { country: "France" } }).entry;
  const countriesOnly = planted({ countries: ["Japan", "France"] }).entry;
  const neither = planted({ countries: undefined, entry: { countries: undefined } }).entry;
  delete neither.countries;
  const facts = factsByTt({ films: [withColumn, countriesOnly, neither] });
  for (const e of [withColumn, countriesOnly, neither]) assert.equal(DC.countryOf(e), facts.get(e.tt).country, e.name);
  assert.deepEqual([withColumn, countriesOnly, neither].map(DC.countryOf), ["France", "Japan", null]);
});

test("build: a decade is the index's decade; every film is in one decade only", () => {
  const f = [planted({ year: 1959 }), planted({ year: 1960 }), planted({ year: 1969 }), planted({ year: 1970 })];
  const w = world(f, catalog("eras", [{ id: "d-1950s", label: "1950s", decade: "1950s" }, { id: "d-1960s", label: "1960s", decade: "1960s" }, { id: "d-1970s", label: "1970s", decade: "1970s" }]));
  assert.deepEqual([w.ids("eras", "d-1950s"), w.ids("eras", "d-1960s"), w.ids("eras", "d-1970s")].map((x) => x.length), [1, 2, 1]);
  const all = [...w.ids("eras", "d-1950s"), ...w.ids("eras", "d-1960s"), ...w.ids("eras", "d-1970s")];
  assert.equal(new Set(all).size, all.length);
});

test("build: an era by period takes every film of the country in the years; an era by movement takes the films of ITS directors in the years, and not a Kurosawa for the Japanese New Wave", () => {
  const OSHIMA = { id: 46230, name: "Nagisa Ōshima" };
  const oshima = planted({ year: 1968, rec: { countries: ["JP"], lang: "ja", directors: [OSHIMA] } });
  const kurosawa = planted({ year: 1963, rec: { countries: ["JP"], lang: "ja", directors: [{ id: 5026, name: "Akira Kurosawa" }] } });
  const late = planted({ year: 1990, rec: { countries: ["JP"], lang: "ja", directors: [OSHIMA] } });
  const us = planted({ year: 1950, rec: { countries: ["US"], lang: "en" } });
  const w = world([oshima, kurosawa, late, us], catalog("eras", [
    { id: "e-wave", label: "Japanese New Wave 1956–78", where: { years: { min: 1956, max: 1978 }, directorsAny: [OSHIMA] } },
    { id: "e-golden", label: "Japan 1956–78", where: { countries: ["JP"], years: { min: 1956, max: 1978 } } },
    { id: "e-hollywood", label: "Classic Hollywood", where: { countries: ["US"], years: { min: 1935, max: 1966 } } },
  ]));
  assert.deepEqual(w.ids("eras", "e-wave"), [oshima.entry.tt]);
  assert.deepEqual(w.ids("eras", "e-golden").sort(), [oshima.entry.tt, kurosawa.entry.tt].sort());
  assert.deepEqual(w.ids("eras", "e-hollywood"), [us.entry.tt]);
});

test("build: a film with no TMDB record of its own passes no `where` — no region and no era — and is still in a country and a decade; the list ids of the index feed `listsAny`", () => {
  const norec = planted({ rec: null, year: 1970 });
  const inList = planted({ year: 1970, entry: { lists: { TsQtG: 4 } }, rec: { countries: ["FR"] } });
  const w = world([norec, inList], [{ id: "mix", name: "Mood Engine · Mix", options: [
    { id: "r-europe", label: "Europe", where: { region: "europe" } }, { id: "c-france", label: "France", country: "France" }, { id: "d-1970s", label: "1970s", decade: "1970s" },
    { id: "e-list", label: "In the list", where: { listsAny: ["TsQtG"] } }] }]);
  assert.deepEqual(w.ids("mix", "r-europe"), [inList.entry.tt]);
  assert.deepEqual(w.ids("mix", "c-france").sort(), [norec.entry.tt, inList.entry.tt].sort());
  assert.deepEqual(w.ids("mix", "d-1970s").sort(), [norec.entry.tt, inList.entry.tt].sort());
  assert.deepEqual(w.ids("mix", "e-list"), [inList.entry.tt]);
});

test("build: seen films that are eligible stay in the ids (\"Include seen\" shows them); a film the recommendation rule refuses never enters", () => {
  const unseen = planted(), seen = planted({ entry: { seen: true } }), refused = planted({ eligible: false });
  const w = world([unseen, seen, refused], catalog("places", [{ id: "c-france", label: "France", country: "France" }]));
  assert.deepEqual(w.ids("places", "c-france"), [unseen.entry.tt, seen.entry.tt]);
});

test("build: a film the music rule holds back stays in the ids (the Worker keeps it out, as it does in Explore) and is not counted in the log among the films the option shows; a seen film is not counted either", () => {
  const shown = planted(), music = planted({ entry: { musicOut: true } }), seen = planted({ entry: { seen: true } });
  const w = world([shown, music, seen], catalog("places", [{ id: "c-france", label: "France", country: "France" }]));
  assert.deepEqual(w.ids("places", "c-france").sort(), [shown.entry.tt, music.entry.tt, seen.entry.tt].sort());
  assert.ok(w.logged.includes("    France 1"), w.logged.join(" | "));
});

test("build: a short (`shortOut`, 15/11/2026) stays in the ids of a calculated option, like a film the music rule holds back, and is not counted in the log among the films the option shows", () => {
  const shown = planted(), short = planted({ entry: { runtime: 20, shortOut: true } }), seen = planted({ entry: { seen: true } });
  const w = world([shown, short, seen], catalog("places", [{ id: "c-france", label: "France", country: "France" }]));
  assert.deepEqual(w.ids("places", "c-france").sort(), [shown.entry.tt, short.entry.tt, seen.entry.tt].sort());
  assert.ok(w.logged.includes("    France 1"), w.logged.join(" | "));
});

// Marco, 15/11/2026 (questionnaire, on the shorts in the eras that are only a period): "Keep shorts in the Silent era only (recommended)". The periods have no file and no source: their shorts leave as those of every
// calculated option; the Silent era alone says `shorts: true`, the mark of an era file (lib/discover-catalogs.js SHORTS_PERIODS).
test("build: the Silent era (`e-silent`, a period) says `shorts: true` and counts its short among the films it shows; Classic Hollywood, a period too, carries no mark, keeps its short in the ids and does not count it", () => {
  const us = { countries: ["United States"], rec: { countries: ["US"], lang: "en" } };
  const silentShort = planted({ year: 1924, entry: { runtime: 21, shortOut: true } }), silentFeature = planted({ year: 1927 }), silentSeenShort = planted({ year: 1902, entry: { runtime: 14, shortOut: true, seen: true } });
  const hollywoodShort = planted({ year: 1941, ...us, entry: { runtime: 8, shortOut: true } }), hollywoodFeature = planted({ year: 1941, ...us });
  const w = world([silentShort, silentFeature, silentSeenShort, hollywoodShort, hollywoodFeature], catalog("eras", [
    { id: "e-silent", label: "Silent era (to 1929)", where: { years: { max: 1929 } } },
    { id: "e-classic-hollywood", label: "Classic Hollywood 1935–66", where: { countries: ["US"], years: { min: 1935, max: 1966 } } },
  ]));
  const [silent, hollywood] = w.out.catalogs[0].options;
  assert.equal(silent.shorts, true, "the Silent era keeps its shorts");
  assert.equal(Object.hasOwn(silent, "curated"), false, "and is not a curated option: the recommendation rule and the music rule hold in it");
  assert.equal(Object.hasOwn(hollywood, "shorts"), false, "Classic Hollywood does not");
  assert.deepEqual([...silent.ids].sort(), [silentShort, silentFeature, silentSeenShort].map((f) => f.entry.tt).sort());
  assert.deepEqual([...hollywood.ids].sort(), [hollywoodShort, hollywoodFeature].map((f) => f.entry.tt).sort(), "the short stays in the ids of the period that does not show it");
  assert.ok(w.logged.includes("    Silent era (to 1929) 2"), `the short and the feature are shown, the seen short is not: ${w.logged.join(" | ")}`);
  assert.ok(w.logged.includes("    Classic Hollywood 1935–66 1"), `the feature alone: ${w.logged.join(" | ")}`);
});

test("data/discover-catalogs.json: the eras that are only a period (a `where`, no file) are nine and SHORTS_PERIODS names one, the Silent era; the options that may say `shorts: true` are the eras with a file and that one", () => {
  const eras = real().catalogs.find((c) => c.id === "eras");
  const periods = eras.options.filter((o) => o.kind === "where").map((o) => o.id).sort();
  assert.deepEqual(periods, ["e-american-indie", "e-classic-hollywood", "e-hk-kung-fu", "e-japan-golden", "e-late-soviet", "e-postwar-britain", "e-silent", "e-soviet-thaw", "e-weimar"]);
  assert.deepEqual(DC.SHORTS_PERIODS, ["e-silent"], 'Marco, 15/11/2026: "Keep shorts in the Silent era only (recommended)"');
  const files = eras.options.filter((o) => o.kind === "era").map((o) => o.id);
  assert.equal(files.length, 25);
  assert.deepEqual([...DC.shortsOptionIds()].sort(), [...files, "e-silent"].sort());
  for (const id of periods.filter((p) => p !== "e-silent")) assert.equal(DC.shortsOptionIds().has(id), false, `${id} is not among them`);
});

test("parse: the id of the period that keeps its shorts must be a `where` (a decade or an era file under that id would get, or lose, the mark by accident)", () => {
  assert.throws(() => world([planted()], catalog("eras", [{ id: "e-silent", label: "1960s", decade: "1960s" }])), /option "e-silent": this id is a period that keeps its shorts \(SHORTS_PERIODS of lib\/discover-catalogs\.js; Marco, 15\/11\/2026\): it must be a where, not a decade/);
  assert.doesNotThrow(() => world([planted()], catalog("eras", [{ id: "e-silent", label: "Silent era (to 1929)", where: { years: { max: 1929 } } }])));
});

test("build: the ids keep the order of the index (best rank first) when the directors differ; the log says '  Discover <catalog>: <n> options' and one line a calculated option, with ' !' when it falls under the floor", () => {
  const f = [planted(), planted(), planted(), planted(), planted()];
  const w = world(f, catalog("places", [{ id: "c-france", label: "France", country: "France" }, { id: "c-japan", label: "Japan", country: "Japan" }]));
  assert.deepEqual(w.ids("places", "c-france"), f.map((x) => x.entry.tt));
  assert.deepEqual(w.logged, ["  Discover places: 2 options", "    France 5", "    Japan 0 !"], "the floor of this file is 1 country film: Japan, with none, is flagged");
});

test("build: the ids are spread by director (at most 2 of one director in each 20) and none is taken out — a director with five films in a row in the index does not fill the first screen of the option", () => {
  const films = [...Array.from({ length: 5 }, () => planted({ director: "Ozu" })), ...Array.from({ length: 25 }, () => planted())];
  const w = world(films, catalog("places", [{ id: "c-france", label: "France", country: "France" }]));
  const ids = w.ids("places", "c-france");
  const indexOrder = films.map((f) => f.entry.tt);
  assert.equal(ids.length, indexOrder.length);
  assert.deepEqual([...ids].sort(), [...indexOrder].sort(), "the same films");
  assert.notDeepEqual(ids, indexOrder, "and not in the order of the index");
  const ozu = new Set(films.slice(0, 5).map((f) => f.entry.tt));
  assert.equal(ids.slice(0, 20).filter((tt) => ozu.has(tt)).length, 2, "the first screen has two of the five");
  assert.deepEqual(ids.slice(0, 2), indexOrder.slice(0, 2), "the first two keep their place");
});

// 23/10/2026 (the reading of Marco's "nao tem outros diretores, eu sei q nao coreia tem mtos"): South Korea has many directors and one prolific (Hong Sang-soo, 20 and more films, the best-ranked
// of them first in the index): at most 2 of him in the first 20 of the option; Sweden has almost no one but Bergman: he completes the page when the others run out. Planted, not the real cache.
test("build: South Korea — a prolific director first in the index and 40 others: no 20 in a row have more than 2 of his, and when the others have run out he completes the option; Sweden — 19 films of one and 3 of others: the others come in the first five, he fills the rest", () => {
  const hong = Array.from({ length: 18 }, () => planted({ countries: ["South Korea"], director: "Hong Sang-soo" }));
  const others = Array.from({ length: 40 }, () => planted({ countries: ["South Korea"] }));
  const bergman = Array.from({ length: 19 }, () => planted({ countries: ["Sweden"], director: "Ingmar Bergman" }));
  const swedes = Array.from({ length: 3 }, () => planted({ countries: ["Sweden"] }));
  const w = world([...hong, ...others, ...bergman, ...swedes], catalog("places", [{ id: "c-korea", label: "South Korea", country: "South Korea" }, { id: "c-sweden", label: "Sweden", country: "Sweden" }]));
  const hongs = new Set(hong.map((f) => f.entry.tt));
  const korea = w.ids("places", "c-korea");
  assert.equal(korea.length, 58);
  assert.equal(korea.slice(0, 20).filter((tt) => hongs.has(tt)).length, 2, "the first 20 hold 2 of Hong Sang-soo");
  for (let i = 0; i + 20 <= 42; i++) assert.ok(korea.slice(i, i + 20).filter((tt) => hongs.has(tt)).length <= 2, `the 20 films from ${i}`);
  assert.deepEqual(korea.slice(-8).map((tt) => hongs.has(tt)), Array(8).fill(true), "the others have run out: he completes the option");
  assert.deepEqual(korea.filter((tt) => hongs.has(tt)), hong.map((f) => f.entry.tt), "his films keep the order of the index");
  const sweden = w.ids("places", "c-sweden"), ber = new Set(bergman.map((f) => f.entry.tt));
  assert.deepEqual(sweden, [bergman[0], bergman[1], ...swedes, ...bergman.slice(2)].map((f) => f.entry.tt));
  assert.equal(sweden.slice(0, 5).filter((tt) => !ber.has(tt)).length, 3);
});

// 23/10/2026: the first version counted the seen films the Worker hides; measured on the offline build, on the films the Worker shows, 13 of 85 options had more than 2 of one director in the first 20
// (South Korea 3 of Lee Chang-dong behind the seen ones) and 28 had a position over the cap with another film waiting.
test("data/discover-catalogs.json: the spread is Marco's — 2 in the first page of 20, 5 in each 20 after it (23/10/2026 ~18:30 UTC, \"Teto 2 só na primeira página; depois uns 5 por bloco de 20\")", () => {
  const spec = real(); // 28/10/2026: the file names keywords now, so it is read with the terms of the moods, as build.js does
  assert.deepEqual(spec.spread, { per: 2, perAfterFirstPage: 5, window: 20 });
});

test("build: with the file's spread (2 then 5) a director with 24 films of 100 has 2 in the first 20 and at most 5 in every 20 after, and the build keeps the cap on the films the Worker shows", () => {
  const hong = Array.from({ length: 24 }, () => planted({ countries: ["South Korea"], director: "Hong Sang-soo" }));
  const others = Array.from({ length: 76 }, () => planted({ countries: ["South Korea"] }));
  const w = world([...hong, ...others], catalog("places", [{ id: "c-korea", label: "South Korea", country: "South Korea" }]), { per: 2, perAfterFirstPage: 5, window: 20 });
  const ids = w.ids("places", "c-korea"), hongs = new Set(hong.map((f) => f.entry.tt));
  const director = (tt) => (hongs.has(tt) ? "Hong" : tt);
  assert.equal(ids.length, 100);
  assert.equal(ids.slice(0, 20).filter((tt) => hongs.has(tt)).length, 2);
  assert.deepEqual(overCap(ids, director, 2, 20, 5), []);
  for (let i = 20; i <= 100; i++) assert.ok(ids.slice(i - 20, i).filter((tt) => hongs.has(tt)).length <= 5 || i > 92, `the 20 films ending at ${i}`);
});

test("build: the seen films and the ones the music rule holds back take no room on the screen — the Worker hides them, so the promise is made on the films it shows — and they stay in the ids", () => {
  const hong = Array.from({ length: 6 }, () => planted({ countries: ["South Korea"], director: "Hong Sang-soo" }));
  const seenOthers = Array.from({ length: 8 }, (_, i) => planted({ countries: ["South Korea"], entry: i % 2 ? { seen: true } : { musicOut: true } }));
  const others = Array.from({ length: 50 }, () => planted({ countries: ["South Korea"] }));
  const w = world([...hong, ...seenOthers, ...others], catalog("places", [{ id: "c-korea", label: "South Korea", country: "South Korea" }]));
  const ids = w.ids("places", "c-korea");
  assert.equal(ids.length, 64, "none leaves");
  const hidden = new Set(seenOthers.map((f) => f.entry.tt)), hongs = new Set(hong.map((f) => f.entry.tt));
  const shown = ids.filter((tt) => !hidden.has(tt)), screen = shown.slice(0, shown.map((tt) => hongs.has(tt)).lastIndexOf(false) + 1); // up to the last film of another director: after that he completes
  for (let i = 0; i + 20 <= screen.length; i++) assert.ok(screen.slice(i, i + 20).filter((tt) => hongs.has(tt)).length <= 2, `the 20 films the Worker shows from ${i}`);
});

test("build: a film with two directors counts for the first one named (the Worker's diversify() reads the same name): three of 'Ozu, Naruse' and three of 'Ozu, Shimizu' leave two of Ozu on the first screen, and 'Naruse, Ozu' is Naruse's", () => {
  const co = [...Array.from({ length: 3 }, () => planted({ director: "Ozu, Naruse" })), ...Array.from({ length: 3 }, () => planted({ director: "Ozu, Shimizu" }))];
  const reverse = planted({ director: "Naruse, Ozu" });
  const others = Array.from({ length: 25 }, () => planted());
  const w = world([...co, reverse, ...others], catalog("places", [{ id: "c-france", label: "France", country: "France" }]));
  const ids = w.ids("places", "c-france"), ozu = new Set(co.map((f) => f.entry.tt));
  assert.equal(ids.slice(0, 20).filter((tt) => ozu.has(tt)).length, 2);
  assert.equal(ids[2], reverse.entry.tt, "the reverse pair is Naruse's film: it takes the third place, ahead of the third of Ozu");
});

test("build: a country under the floor of the file is flagged with ' !' and kept; an era under its floor too; a region has no floor", () => {
  const spec = (floor) => [{ id: "places", name: "Mood Engine · P", options: [{ id: "r-europe", label: "Europe", where: { region: "europe" } }, { id: "c-france", label: "France", country: "France" }] }, { id: "eras", name: "Mood Engine · E", options: [{ id: "d-1960s", label: "1960s", decade: "1960s" }, { id: "e-fr", label: "French 60s", where: { countries: ["FR"] } }] }];
  const films = Array.from({ length: 3 }, () => planted());
  const records = new Map(films.map(({ entry, rec }) => [entry.tt, rec]));
  const logged = [];
  const parsed = DC.parse({ ...good(), floor: { countries: 4, eras: 4 }, catalogs: spec() }, { lists: [], today: TODAY });
  DC.build({ spec: parsed, index: { films: films.map((f) => f.entry), lists: [] }, recordOf: (tt) => records.get(tt), log: (l) => logged.push(l) });
  assert.deepEqual(logged.filter((l) => l.startsWith("    ")), ["    Europe 3", "    France 3 !", "    1960s 3", "    French 60s 3 !"], "a decade has no floor; a region has none");
});

// ── spread ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const byName = (names) => { const m = new Map(names.map((d, i) => [`f${i}`, d])); return { ids: [...m.keys()], directorOf: (tt) => m.get(tt) }; };
const windows = (out, directorOf, size) => { let worst = 0; for (let i = 0; i < out.length; i++) { const c = new Map(); for (const tt of out.slice(i, i + size)) { const d = directorOf(tt); if (d) c.set(d, (c.get(d) || 0) + 1); } worst = Math.max(worst, ...c.values(), 0); } return worst; };

test("spread: the output has exactly the same ids, each once — nothing is dropped, nothing is added", () => {
  const { ids, directorOf } = byName(Array.from({ length: 300 }, (_, i) => (i % 7 === 0 ? "Ozu" : i % 5 === 0 ? "Kurosawa" : `Director ${i}`)));
  const out = DC.spread(ids, directorOf, { per: 2, window: 20 });
  assert.equal(out.length, ids.length);
  assert.deepEqual([...out].sort(), [...ids].sort());
  assert.equal(new Set(out).size, out.length);
  assert.deepEqual(DC.spread([], directorOf), []);
});

test("spread: in a list of varied directors no stretch of 20 films has more than 2 of the same director, though the input has 5 of one in a row", () => {
  const names = ["Ozu", "Ozu", "Ozu", "Ozu", "Ozu", ...Array.from({ length: 60 }, (_, i) => `Director ${i}`), "Ozu", "Ozu"];
  const { ids, directorOf } = byName(names);
  assert.ok(windows(ids, directorOf, 20) >= 5, "the input does have the cluster");
  const out = DC.spread(ids, directorOf, { per: 2, window: 20 });
  assert.ok(windows(out, directorOf, 20) <= 2, `worst window ${windows(out, directorOf, 20)}`);
  assert.deepEqual(out.slice(0, 2), ["f0", "f1"], "the first two Ozu films keep their place");
  assert.ok(!out.slice(0, 20).slice(2).some((tt) => directorOf(tt) === "Ozu"), "the others wait");
});

test("spread: a list of one director comes out whole and in the original order; a film with no known director is never held back", () => {
  const { ids, directorOf } = byName(Array(45).fill("Ozu"));
  assert.deepEqual(DC.spread(ids, directorOf, { per: 2, window: 20 }), ids);
  const anon = byName([null, null, null, null, "Ozu", null]);
  assert.deepEqual(DC.spread(anon.ids, anon.directorOf, { per: 1, window: 3 }), anon.ids);
});

// 23/10/2026 (Marco: "nao tem outros diretores, eu sei q nao coreia tem mtos"; the session's reading: where there are films of other directors, no 20 films in a row have more than 2 of one
// director, the surplus goes down, and when the others run out the director who is left completes the page). The first version (22/10/2026) let a film out as soon as there was room and let
// what still waited out together at the end, counted the window one film too wide, and counted the seen films the Worker hides: measured on the offline build of 23/10/2026, on the films
// the Worker shows, 13 of 85 options had more than 2 of one director in their first 20 and 28 had a position over the cap with another director's film still waiting. The three tests
// below that pin exact small outputs were written for the window one too wide and are rewritten for the exact one (every 20 in a row, the one just placed included).

/** The positions where a director passes the cap (`per` among the first `window` places, `perAfter` after them) among the `window` films that end there although a film of a director with room (fewer than `per` among the `window - 1` before) was still waiting. */
const overCap = (seq, directorOf, per, window, perAfter = per) => {
  const bad = [];
  for (let p = 0; p < seq.length; p++) {
    const d = directorOf(seq[p]);
    if (!d) continue;
    const cap = p < window ? per : perAfter; // the cap of the place: `per` in the first page, `perAfter` after it (Marco, 23/10/2026 ~18:30 UTC)
    const before = new Map();
    for (const tt of seq.slice(Math.max(0, p - window + 1), p)) { const x = directorOf(tt); if (x) before.set(x, (before.get(x) || 0) + 1); }
    if ((before.get(d) || 0) + 1 <= cap) continue;
    if (seq.slice(p + 1).some((tt) => { const e = directorOf(tt); return !e || (before.get(e) || 0) < cap; })) bad.push(p);
  }
  return bad;
};
const lcg = (seed) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

test("spread: a film that waited goes out as soon as there is room, and the order of the others is kept (the window is the last 5, the one just placed included: 3 A's never in 5 in a row)", () => {
  const names = ["A", "A", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U"];
  const { ids, directorOf } = byName(names);
  const out = DC.spread(ids, directorOf, { per: 2, window: 5 });
  // f2 (the third A) waits while A has two among the last 4 placed (f0 f1 f3 f4 f5: its window is f1 f3 f4 f5 f2, two A's); it goes out as soon as f0 has left the last 4
  assert.deepEqual(out.slice(0, 8), ["f0", "f1", "f3", "f4", "f5", "f2", "f6", "f7"]);
  assert.equal(out.length, ids.length);
  assert.deepEqual(overCap(out, directorOf, 2, 5), []);
});

test("spread: two directors with a film that waits each: the one whose room opens first goes first, and a window of 3 with room for 1 never puts the same director twice in a row", () => {
  const { ids, directorOf } = byName(["A", "A", "A", "B", "B", "B", "C", "D", "E", "F", "G", "H"]);
  const out = DC.spread(ids, directorOf, { per: 2, window: 4 });
  assert.equal(out.length, ids.length);
  assert.ok(out.indexOf("f2") < out.indexOf("f5"), `the third A (waited first) before the third B: ${out.join()}`);
  assert.deepEqual(overCap(out, directorOf, 2, 4), []);
  assert.deepEqual(DC.spread(["f0", "f1", "f2", "f3", "f4"], (tt) => ({ f0: "A", f1: "A", f2: "A", f3: "B", f4: "B" })[tt], { per: 2, window: 3 }), ["f0", "f1", "f3", "f2", "f4"], "A's third goes out when f0 is no longer among the last 2 placed");
});

test("spread: one film of a director in 2 positions: the waiting films are judged again after each one that went out, the earliest first", () => {
  const d = { f0: "A", f1: "A", f2: "B", f3: "B", f4: "C", f5: "D", f6: "E" };
  // window 2, one a director: never the same director twice in a row; f1 waits behind f0, goes out after f2; f3 after f1
  assert.deepEqual(DC.spread(Object.keys(d), (tt) => d[tt], { per: 1, window: 2 }), ["f0", "f2", "f1", "f3", "f4", "f5", "f6"]);
});

test("spread: where there are other directors no 20 films in a row have more than 2 of one — 400 planted lists of 1 to 140 films with 1 to 30 directors, a dominant one, films with no director, three sizes of window; each id once, and the order inside a director is the order of the input", () => {
  const rnd = lcg(2310);
  let cases = 0, withOthers = 0;
  for (let c = 0; c < 400; c++) {
    const n = 1 + Math.floor(rnd() * 140), k = [1, 2, 3, 5, 12, 30][c % 6], per = [2, 2, 1, 3][c % 4], window = [20, 20, 5, 8][c % 4];
    const names = Array.from({ length: n }, () => (rnd() < 0.08 ? null : rnd() < 0.5 ? "Dominant" : `Director ${Math.floor(rnd() * k)}`));
    const { ids, directorOf } = byName(names);
    const out = DC.spread(ids, directorOf, { per, window });
    const label = `case ${c} (n ${n}, k ${k}, per ${per}, window ${window})`;
    assert.deepEqual([...out].sort(), [...ids].sort(), label);
    for (const d of new Set(names.filter(Boolean))) assert.deepEqual(out.filter((tt) => directorOf(tt) === d), ids.filter((tt) => directorOf(tt) === d), `${label}: the order inside ${d}`);
    assert.deepEqual(overCap(out, directorOf, per, window), [], label);
    cases++; if (new Set(names.filter(Boolean)).size > 1) withOthers++;
  }
  assert.equal(cases, 400);
  assert.ok(withOthers > 300, `${withOthers} of the cases had more than one director`);
});

test("spread: two directors, 15 films and 5: the five are among the first 12, not at the end; the rest is the one who is left, in the order of the input", () => {
  const { ids, directorOf } = byName([...Array(15).fill("A"), ...Array(5).fill("B")]);
  const out = DC.spread(ids, directorOf, { per: 2, window: 20 });
  const bs = out.map((tt, i) => (directorOf(tt) === "B" ? i : -1)).filter((i) => i >= 0);
  assert.equal(bs.length, 5);
  assert.ok(Math.max(...bs) < 12, `B at ${bs}`);
  assert.deepEqual(out.slice(12).map(directorOf), Array(8).fill("A"));
  assert.deepEqual(out.filter((tt) => directorOf(tt) === "A"), ids.slice(0, 15));
  assert.deepEqual(overCap(out, directorOf, 2, 20), []);
});

test("spread: Sweden — 19 films of one director and 3 of others: two of his, the three others, then he completes the page in the order of the input (there is no one else)", () => {
  const { ids, directorOf } = byName([...Array(19).fill("Bergman"), "X", "Y", "Z"]);
  const out = DC.spread(ids, directorOf, { per: 2, window: 20 });
  assert.deepEqual(out, ["f0", "f1", "f19", "f20", "f21", ...ids.slice(2, 19)]);
});

test("spread: a small option — six directors, 20 films cannot be filled with 2 of each — shares the surplus instead of piling it on the director of the first films", () => {
  const names = ["Carné", ...Array(12).fill("Renoir"), "Vigo", "Vigo", "Vigo", "Vigo", ...Array(7).fill("Duvivier"), ...Array(6).fill("Grémillon"), "Allégret"];
  const { ids, directorOf } = byName(names);
  const out = DC.spread(ids, directorOf, { per: 2, window: 20 });
  const first = new Map();
  for (const tt of out.slice(0, 20)) first.set(directorOf(tt), (first.get(directorOf(tt)) || 0) + 1);
  // 20 places: Carné and Allégret have one film each, the other four directors share the other 18, so 5 of one is the least that is possible (the first version gave Renoir 12)
  assert.ok(Math.max(...first.values()) <= 5, `the first 20: ${[...first].join(" ")}`);
  assert.deepEqual(overCap(out, directorOf, 2, 20), []);
});

test("spread: ten directors with three films each fill the first 20 places with two of each, and the third film of the first is the 21st (no sooner, the cap; no later, nothing else is waiting)", () => {
  const names = Array.from({ length: 30 }, (_, i) => `Director ${Math.floor(i / 3)}`);
  const { ids, directorOf } = byName(names);
  const out = DC.spread(ids, directorOf, { per: 2, window: 20 });
  const first = new Map();
  for (const tt of out.slice(0, 20)) first.set(directorOf(tt), (first.get(directorOf(tt)) || 0) + 1);
  assert.deepEqual([...first.values()], Array(10).fill(2), "two of each of the ten");
  assert.equal(out[20], "f2", "Director 0's third film is the 21st, and not later");
  assert.deepEqual(overCap(out, directorOf, 2, 20), [], "later stretches can hold a third film only where every director left is already at the cap (the order of the input packs the pairs; the promise is kept for as long as another film has room)");
});

test("spread: a film with two directors counts for the FIRST only (the Worker's diversify() reads the same name), and a film with no known director is never held back", () => {
  const first = (tt) => ({ f0: "Ozu", f1: "Ozu", f2: "Ozu", f3: "Naruse" })[tt] || null;
  const out = DC.spread(["f0", "f1", "f2", "f3", "f4"], first, { per: 2, window: 20 });
  assert.deepEqual(out, ["f0", "f1", "f3", "f4", "f2"], "the third Ozu film waits for the others, f4 (no director) is not held");
});

test("spread: `shown` — the films the Worker hides (seen, held back by the music rule) do not take room on the screen: the third A waits for 20 films that are SHOWN, and without `shown` it would not (the control)", () => {
  const names = ["A", "A", "A", ...Array.from({ length: 8 }, (_, i) => `Seen ${i}`), ...Array.from({ length: 30 }, (_, i) => `Director ${i}`)];
  const { ids, directorOf } = byName(names);
  const hidden = new Set(names.map((x, i) => (x.startsWith("Seen") ? `f${i}` : null)).filter(Boolean));
  const shown = (tt) => !hidden.has(tt);
  const blind = DC.spread(ids, directorOf, { per: 2, window: 20 });
  const aware = DC.spread(ids, directorOf, { per: 2, window: 20 }, shown);
  assert.ok(windows(blind.filter(shown), directorOf, 20) >= 3, "control: blind to what is hidden, the third A lands inside the first 20 films the Worker shows");
  assert.equal(windows(aware.filter(shown), directorOf, 20), 2, "aware: on the screen no 20 in a row have a third A");
  assert.deepEqual(overCap(aware.filter(shown), directorOf, 2, 20), []);
  assert.deepEqual(overCap(aware, directorOf, 2, 20), [], "and the order of 'Include seen' (every film) holds too where it can");
  assert.deepEqual([...aware].sort(), [...ids].sort());
});

test("spread: `shown` — the order of \"Include seen\" keeps the promise as well where the screen allows it: two seen films of A and a third that is shown, the third goes out as the 21st (exactly after 20 films in all), not sooner and not later", () => {
  const names = ["A", "A", "A", ...Array.from({ length: 30 }, (_, i) => `Director ${i}`)];
  const { ids, directorOf } = byName(names);
  const shown = (tt) => tt !== "f0" && tt !== "f1";
  const out = DC.spread(ids, directorOf, { per: 2, window: 20 }, shown);
  assert.equal(out.indexOf("f2"), 20, out.slice(15, 25).join());
  assert.deepEqual(overCap(out, directorOf, 2, 20), []);
});

// 23/10/2026, the four that a clean-context review kept alive (each changes real options): the tie at the last level, what the last level counts, a film with no director in the build, a hidden film
// judged on the screen's window.
test("spread: when nobody has room, among directors with the same number in the window the EARLIEST film goes out (one a director in 20: A A B B C C → A B C, then A, B, C again)", () => {
  const d = { f0: "A", f1: "A", f2: "B", f3: "B", f4: "C", f5: "C" };
  assert.deepEqual(DC.spread(Object.keys(d), (tt) => d[tt], { per: 1, window: 20 }), ["f0", "f2", "f4", "f1", "f3", "f5"], "the second round follows the order of the index, not its reverse");
});

test("spread: when nobody has room, the director with the fewest on the SCREEN's window counts too, and not only the window of all — D0 forgotten by the window of all (its first film left it) still has two on the screen", () => {
  // window 6, 'D1' f7 is hidden. After f0..f4 and the hidden f7, the window of all holds D3 D3 D1 D0 D1 (f0 has left it) and the screen's holds D0 D3 D3 D1 D0 (it only slides with shown films):
  // f5 (D3) has 2 in both windows, f6 (D0) has 1 in the window of all and 2 on the screen: both would be a third on the screen, they are equal, and the earliest (f5) goes out.
  const names = ["D0", "D3", "D3", "D1", "D0", "D3", "D0", "D1"];
  const hidden = new Set(["f7"]);
  const out = DC.spread(names.map((_, i) => `f${i}`), (tt) => names[+tt.slice(1)], { per: 2, window: 6 }, (tt) => !hidden.has(tt));
  assert.deepEqual(out, ["f0", "f1", "f2", "f3", "f4", "f7", "f5", "f6"]);
});

test("spread: a film that is HIDDEN is judged on the window of all alone — the director's two shown films, 20 hidden films of others, and his hidden film goes out as the 21st, the first place its window of all has room (the screen's window cannot hold it back: it is not on the screen)", () => {
  const names = ["A", "A", "A", ...Array.from({ length: 30 }, (_, i) => `Director ${i}`)];
  const { ids, directorOf } = byName(names);
  const out = DC.spread(ids, directorOf, { per: 2, window: 20 }, (tt) => tt === "f0" || tt === "f1"); // f2 and the thirty others are hidden
  assert.equal(out.indexOf("f2"), 20, out.slice(15, 25).join());
});

test("spread: among the films that have room on the screen but not in the window of all, the EARLIEST goes out (window 5: after f0 f1 f2 f4 the window of all has D2 twice and D3 twice; f3 is a hidden D2, f5 a shown D3: the screen has room for both)", () => {
  const names = ["D2", "D3", "D2", "D2", "D3", "D3", "D3", "D3"];
  const hidden = new Set(["f1", "f3"]);
  const out = DC.spread(names.map((_, i) => `f${i}`), (tt) => names[+tt.slice(1)], { per: 2, window: 5 }, (tt) => !hidden.has(tt));
  assert.deepEqual(out, ["f0", "f1", "f2", "f4", "f3", "f5", "f6", "f7"], "f3 before f5");
});

test("build: films with no known director are never held back and are not one 'director' of their own — the index order of 5 of them among a named one stays whole", () => {
  const films = [planted({ entry: { director: null } }), planted({ entry: { director: null } }), planted({ entry: { director: null } }), planted({ entry: { director: null } }), planted({ director: "Ozu" }), planted({ entry: { director: null } }), planted({ director: "Naruse" }), planted({ entry: { director: null } })];
  const w = world(films, catalog("places", [{ id: "c-france", label: "France", country: "France" }]));
  assert.deepEqual(w.ids("places", "c-france"), films.map((f) => f.entry.tt), "the index order: no one is held back");
});

// Marco, 23/10/2026 ~18:30 UTC (questionnaire, answer b): "Teto 2 só na primeira página; depois uns 5 por bloco de 20". Before it a director with 24 of South Korea's 100 films ended the option with
// 17 in a row (blocks of 20: 1, 2, 2, 2, 17): the cap of 2 fits at most 10 of 24 in 100 places. Now the cap is `per` in the first `window` places and `perAfterFirstPage` after them.
test("spread: the cap is `per` in the first `window` places and `perAfterFirstPage` in every 20 after (window 4, 1 then 2: A, then three others, and then two A's in four places)", () => {
  const names = [...Array(6).fill("A"), ..."BCDEFGHIJK"];
  const { ids, directorOf } = byName(names);
  const out = DC.spread(ids, directorOf, { per: 1, perAfterFirstPage: 2, window: 4 });
  assert.deepEqual(out, ["f0", "f6", "f7", "f8", "f1", "f2", "f9", "f10", "f3", "f4", "f11", "f12", "f5", "f13", "f14", "f15"]);
  assert.deepEqual(overCap(out, directorOf, 1, 4, 2), []);
  const n2 = byName([...Array(6).fill("A"), ...Array(6).fill("B")]);
  assert.deepEqual(DC.spread(n2.ids, n2.directorOf, { per: 1, perAfterFirstPage: 2, window: 4 }), ["f0", "f6", "f1", "f7", "f2", "f8", "f3", "f9", "f4", "f10", "f5", "f11"], "two directors: nobody has room in the first page, the fewest goes out; after it A and B alternate");
  const same = DC.spread(ids, directorOf, { per: 2, window: 20 });
  assert.deepEqual(DC.spread(ids, directorOf, { per: 2, perAfterFirstPage: 2, window: 20 }), same, "perAfterFirstPage equal to per is the first version");
});

test("spread: the first page's cap of `per` holds for the screen on its own — a hidden film goes before a shown one whose director already has his place on the first page (window 5, 1 then 2)", () => {
  const names = ["D2", "D3", "D3", "D1", "D0", "D0"];
  const hidden = new Set(["f5"]);
  // after f0 f1 f3 f4 the first page has 4 places: f2 (D3, shown) already has one D3 on the screen, the cap of the place is 1, so it has no room there; f5 is hidden (D0) and has room on the screen
  assert.deepEqual(DC.spread(names.map((_, i) => `f${i}`), (tt) => names[+tt.slice(1)], { per: 1, perAfterFirstPage: 2, window: 5 }, (tt) => !hidden.has(tt)), ["f0", "f1", "f3", "f4", "f5", "f2"]);
});

test("spread: the first page's cap of `per` holds for the order of \"Include seen\" too — the window of all counts the places of all the films (window 5, 1 then 2: the shown f1 waits for the hidden f2 because D1 has one in the first page)", () => {
  const names = ["D1", "D1", "D3", "D3", "D1", "D1"];
  const hidden = new Set(["f0", "f2", "f3", "f5"]);
  assert.deepEqual(DC.spread(names.map((_, i) => `f${i}`), (tt) => names[+tt.slice(1)], { per: 1, perAfterFirstPage: 2, window: 5 }, (tt) => !hidden.has(tt)), ["f0", "f2", "f1", "f3", "f4", "f5"]);
});

test("spread: 2 in the first page and 5 in each 20 after it — 400 planted lists of 1 to 200 films, 1 to 30 directors, a dominant one; each id once, the order inside a director kept, and nobody passes the cap of the place while a film with room waits", () => {
  const rnd = lcg(2318);
  let beyond = 0;
  for (let c = 0; c < 400; c++) {
    const n = 1 + Math.floor(rnd() * 200), k = [1, 2, 3, 5, 12, 30][c % 6];
    const [per, after, window] = [[2, 5, 20], [2, 5, 20], [1, 3, 5], [2, 4, 8]][c % 4];
    const names = Array.from({ length: n }, () => (rnd() < 0.08 ? null : rnd() < 0.5 ? "Dominant" : `Director ${Math.floor(rnd() * k)}`));
    const { ids, directorOf } = byName(names);
    const out = DC.spread(ids, directorOf, { per, perAfterFirstPage: after, window });
    const label = `case ${c} (n ${n}, k ${k}, ${per}/${after}/${window})`;
    assert.deepEqual([...out].sort(), [...ids].sort(), label);
    for (const d of new Set(names.filter(Boolean))) assert.deepEqual(out.filter((tt) => directorOf(tt) === d), ids.filter((tt) => directorOf(tt) === d), `${label}: the order inside ${d}`);
    assert.deepEqual(overCap(out, directorOf, per, window, after), [], label);
    if (n > window && new Set(names.filter(Boolean)).size > 1) beyond++;
  }
  assert.ok(beyond > 300, `${beyond} lists went beyond the first page with more than one director`);
});

test("spread: a prolific director with 24 of 100 films — at most 2 in the first 20, at most 5 in any 20 after, the surplus of two at the end and not 14 in a row (the cap of 2 everywhere: blocks 2, 2, 2, 2, 16)", () => {
  const names = [...Array(24).fill("Hong"), ...Array.from({ length: 76 }, (_, i) => `Director ${i}`)];
  const { ids, directorOf } = byName(names);
  const out = DC.spread(ids, directorOf, { per: 2, perAfterFirstPage: 5, window: 20 });
  const hong = (tt) => directorOf(tt) === "Hong";
  assert.equal(out.slice(0, 20).filter(hong).length, 2);
  for (let i = 20; i + 20 <= 92; i++) assert.ok(out.slice(i - 19, i + 1).filter(hong).length <= 5, `the 20 films ending at ${i + 1}`);
  assert.deepEqual(overCap(out, directorOf, 2, 20, 5), []);
  const blocks = (seq) => [0, 20, 40, 60, 80].map((i) => seq.slice(i, i + 20).filter(hong).length), run = (seq) => { let r = 0; while (r < seq.length && hong(seq[seq.length - 1 - r])) r++; return r; };
  assert.deepEqual(blocks(out), [2, 5, 5, 5, 7], "the blocks of 20: 2, then 5 a block, the surplus of 2 at the end");
  assert.equal(run(out), 2);
  assert.deepEqual(out.filter(hong), ids.slice(0, 24), "his films keep the order of the index");
  const only2 = DC.spread(ids, directorOf, { per: 2, window: 20 });
  assert.deepEqual(blocks(only2), [2, 2, 2, 2, 16], "the cap of 2 everywhere: the surplus is all at the end (the answer of 22/10 asked about this)");
  assert.equal(run(only2), 14);
});

test("spread: on the screen the promise holds for 300 planted lists with a random third of the films hidden (the shown ones alone), and the same ids come out once each", () => {
  const rnd = lcg(2311);
  for (let c = 0; c < 300; c++) {
    const n = 1 + Math.floor(rnd() * 140), k = [2, 3, 5, 12, 30][c % 5];
    const names = Array.from({ length: n }, () => (rnd() < 0.5 ? "Dominant" : `Director ${Math.floor(rnd() * k)}`));
    const { ids, directorOf } = byName(names);
    const hidden = new Set(ids.filter(() => rnd() < 0.33));
    const shown = (tt) => !hidden.has(tt);
    const out = DC.spread(ids, directorOf, { per: 2, window: 20 }, shown);
    assert.deepEqual([...out].sort(), [...ids].sort(), `case ${c}`);
    assert.deepEqual(overCap(out.filter(shown), directorOf, 2, 20), [], `case ${c} (n ${n}, k ${k}): the screen`);
  }
});

// ── the slices and the validation ───────────────────────────────────────────────────────────────────────────────────────────────────────

const DISCOVER = (ids) => ({ order: ["moods", "places", "explore", "search"], retire: ["lists", "lists-unseen"], seen: { name: "seen", option: "Include seen" }, catalogs: [{ id: "places", name: "Mood Engine · Countries & regions", options: [{ id: "c-france", label: "France", ids }, { id: "l-aaa", label: "Alpha French", list: "aaa" }] }] });
const mini = (films, extra = {}) => ({
  meta: { builtAt: "2026-10-22T10:00:00.000Z", version: "3.0.0", schema: 1, part: "full", separator: "\n\n", today: TODAY, count: films.length, decades: ["1960s"], countries: ["France"] },
  moodMenu: [{ id: "night", label: "Nocturnal" }], moods: [{ id: "night", label: "Nocturnal", name: "Night" }], lists: [{ id: "aaa", label: "Alpha list", short: "Alpha French", popular: false, films: 1 }],
  friends: { people: [], options: [] }, directors: { options: [] }, board: [{ id: "tonight", name: "Tonight", place: "board" }], rows: { tonight: [] }, rowDesc: { tonight: [] }, films, ...extra,
});
const two = () => [planted().entry, planted({ entry: { seen: true } }).entry];

test("slices: every file of the v2 family but the whole index carries the Discover menus with `ids: []` — the menus, the row slices, the mood slices — and a list option as it is", () => {
  const films = two();
  const films2 = [{ ...films[0], moods: { night: [1, 2] } }, films[1]];
  const ix = mini(films2, { discover: DISCOVER(films2.map((f) => f.tt)) });
  const parts = pieces2(ix);
  assert.ok(parts.length >= 2);
  for (const p of parts) {
    const o = p.obj.discover.catalogs[0].options;
    assert.deepEqual(o[0].ids, [], p.part);
    assert.deepEqual(o[1], { id: "l-aaa", label: "Alpha French", list: "aaa" }, p.part);
    assert.equal(p.obj.discover.order.join(), "moods,places,explore,search", p.part);
  }
  assert.equal(ix.discover.catalogs[0].options[0].ids.length, 2, "the whole index keeps its ids");
  assert.deepEqual(discoverLabels(ix.discover).catalogs[0].options[0].ids, []);
  assert.equal(discoverLabels(undefined), undefined);
});

test("slices: an index without `discover` writes no `discover` key in any file (the legacy family and the v2 files of a build with no data file)", () => {
  const ix = mini(two());
  for (const p of pieces2(ix)) assert.ok(!("discover" in p.obj), p.part);
});

test("validation: an index with a well-formed `discover` passes; the ids may be seen films; the same id twice, an id that is not in the index and a film that is not eligible are refused, each by name", () => {
  const [a, b] = two();
  assert.doesNotThrow(() => validateIndex(mini([a, b], { discover: DISCOVER([a.tt, b.tt]) }), "index-v2"));
  assert.throws(() => validateIndex(mini([a, b], { discover: DISCOVER([a.tt, a.tt]) }), "index-v2"), /discover places \/ France names a film twice/);
  assert.throws(() => validateIndex(mini([a, b], { discover: DISCOVER(["tt9999999"]) }), "index-v2"), /tt9999999 in discover places \/ France is not among the films/);
  const weak = { ...b }; delete weak.eligible;
  assert.throws(() => validateIndex(mini([a, weak], { discover: DISCOVER([a.tt, weak.tt]) }), "index-v2"), new RegExp(`${weak.tt} \\(${weak.name}\\) sits in discover places / France but is not eligible`));
  const noList = DISCOVER([a.tt]);
  noList.catalogs[0].options[1].list = "nope";
  assert.throws(() => validateIndex(mini([a, b], { discover: noList }), "index-v2"), /names the list nope, which the index does not declare/);
});

test("validation: an unknown key of an option, an option with both ids and list or with neither, an unsafe id, a catalog missing from `order` and a bad `seen` are refused", () => {
  const [a, b] = two();
  const with_ = (mutate) => { const d = DISCOVER([a.tt]); mutate(d); return () => validateIndex(mini([a, b], { discover: d }), "index-v2"); };
  assert.throws(with_((d) => { d.catalogs[0].options[0].where = {}; }), /Unexpected index field discover.option.where/);
  assert.throws(with_((d) => { d.catalogs[0].options[0].list = "aaa"; }), /exactly one of ids or list/);
  assert.throws(with_((d) => { delete d.catalogs[0].options[0].ids; }), /exactly one of ids or list/);
  assert.throws(with_((d) => { d.catalogs[0].options[0].id = "a/b"; }), /Invalid index discover option/);
  assert.throws(with_((d) => { d.catalogs[0].options[0].ids = ["France"]; }), /Invalid index discover option ids/);
  assert.throws(with_((d) => { d.order = ["moods"]; }), /Invalid index discover catalog order places/);
  assert.throws(with_((d) => { d.seen = { name: "Seen", option: "x" }; }), /Invalid index discover seen/);
  assert.throws(with_((d) => { d.extra = 1; }), /Unexpected index field discover.extra/);
  assert.throws(with_((d) => { d.catalogs[0].options.push({ ...d.catalogs[0].options[0] }); }), /Duplicate index discover option c-france/);
});

test("validation: a slice (any part but the whole index) refuses ids in a calculated option; and the legacy family refuses a `discover` altogether", () => {
  const [a, b] = two();
  const whole = mini([a, b], { discover: DISCOVER([a.tt]) });
  const slice = { ...encode({ ...whole, meta: { ...whole.meta, part: "v2-menus", count: 0 }, films: [] }) };
  const problems = [];
  checkIndex("v2-menus", slice, problems, "index-v2-menus");
  assert.match(problems.join("\n"), /index-v2-menus: discover places \/ France carries 1 films, and only the whole index carries them/);
  const clean = [];
  checkIndex("v2-menus", encode({ ...whole, meta: { ...whole.meta, part: "v2-menus", count: 0 }, films: [], discover: discoverLabels(whole.discover) }), clean, "index-v2-menus");
  assert.deepEqual(clean, []);
  const legacy = mini([a, b], { discover: DISCOVER([]) });
  delete legacy.moodMenu;
  const issues = [];
  checkIndex("full", encode(legacy), issues, "index");
  assert.match(issues.join("\n"), /index: discover belongs to the v2 family \(it has no moodMenu\)/);
});

test("buildIndex gives `records` the film's OWN TMDB record for every entry it makes — and null for a film that has none — so the regions and the eras are worked out from the record the index used; a call without `records` is unchanged", () => {
  const rec = { id: 1, imdb: "tt0000001", title: "X", year: 1962, runtime: 100, countries: ["FR"], lang: "fr", genres: [], keywords: [], directors: [{ id: 5, name: "D" }], va: 7, vc: 100 };
  const other = { id: 2, imdb: "tt0000099", title: "Not the film's", year: 1962, countries: ["US"], lang: "en", genres: [], keywords: [], directors: [], va: 7, vc: 100 };
  const lb = { slug: "y", title: "Y", year: 1970, imdbId: "tt0000002", r: 4 };
  const base = { cfg: { addon: { version: "1" }, moods: [] }, today: TODAY, plan: { board: [], discover: [] }, cands: [{ film: rec, tasteZ: 0, qualityZ: 0 }], view: { users: [], films: { y: lb } }, lists: [{ id: "L", name: "L", items: [{ slug: "y" }] }] };
  const records = new Map();
  const withRecords = buildIndex({ ...base, records });
  assert.deepEqual([...records.keys()].sort(), ["tt0000001", "tt0000002"]);
  assert.equal(records.get("tt0000001"), rec, "the record the entry was made from");
  assert.equal(records.get("tt0000002"), null, "the film of a list that TMDB has no record for");
  const detail = (r) => (r.slug === "y" ? other : null); // a record whose `imdb` is another film's is not the film's own
  const wrong = new Map();
  buildIndex({ ...base, detail, records: wrong });
  assert.equal(wrong.get("tt0000002"), null, "a record of another film is not handed out as this film's");
  assert.deepEqual(buildIndex(base).films, withRecords.films, "the entries are the same with or without the Map");
});

test("verify.js: a published index with the Discover passes; every file but the whole index must carry the same menus with `ids: []`, and each way it can be wrong is named", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "mood-dc-"));
  try {
    const films = [{ ...planted().entry, moods: { night: [1, 2] } }, planted({ entry: { seen: true } }).entry];
    const legacy = mini(films);
    delete legacy.moodMenu; legacy.board = [{ id: "tonight", name: "Tonight" }];
    const v2 = mini(films, { discover: DISCOVER(films.map((f) => f.tt)) });
    writeIndex(out, legacy, v2);
    require("../test-support/film-page-fixture").writeMinimalPages(out, v2); // 24/10/2026: a v2 index is verified together with its 100 film-page shards
    const ok = verifyIndex(out);
    assert.equal(ok.ok, true, ok.problems.join("\n"));
    const edit = (name, fn) => {
      const file = path.join(out, "data", name), before = fs.readFileSync(file, "utf8"), j = JSON.parse(before);
      fn(j);
      fs.writeFileSync(file, JSON.stringify(j));
      try { return verifyIndex(out).problems.join("\n"); } finally { fs.writeFileSync(file, before); }
    };
    assert.match(edit("index-v2-menus.json", (j) => { j.discover.catalogs[0].options[0].ids = [films[0].tt]; }), /index-v2-menus: discover places \/ France carries 1 films/);
    assert.match(edit("index-v2-mood-night.json", (j) => { j.discover.catalogs[0].options[0].ids = [films[0].tt]; }), /index-v2-mood-night: .*carries 1 films/);
    assert.match(edit("index-v2-row-tonight.json", (j) => { delete j.discover; }), /index-v2-row-tonight: the Discover menus differ from index-v2's/);
    assert.match(edit("index-v2-menus.json", (j) => { j.discover.catalogs[0].options[1].label = "Other name"; }), /index-v2-menus: the Discover menus differ/);
    assert.match(edit("index-v2-menus.json", (j) => { j.discover.order = ["moods", "places", "search", "explore"]; }), /index-v2-menus: the Discover menus differ/);
    assert.match(edit("index-v2.json", (j) => { j.discover.catalogs[0].options[0].ids.push("tt7777777"); }), /tt7777777 in discover places \/ France is not among the films/);
    assert.match(edit("index-v2.json", (j) => { j.discover.catalogs[0].options[0].ids.push(films[0].tt); }), /discover places \/ France names a film twice/);
    assert.match(edit("index-v2.json", (j) => { j.discover.catalogs[0].options[1].list = "gone"; }), /names the list gone, which the index does not declare/);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

// ── proposal 5 (Marco, 28/10/2026): the grammar of the five new kinds of option, `menuless` and `explore` ─────────────────────────────────────────────────────
// Plan docs/2026-10-28-discover-plano-implementacao.md sections 5.1 and 6 (front A). Receipts: worker/mutation.mjs "p5a:".

const L5 = [...LISTS, { id: "ddd", name: "Delta list (someone)", short: "Delta" }, { id: "eee", name: "Echo list (someone)", short: "Echo" }, { id: "fff", name: "Foxtrot list (someone)", short: "Foxtrot" }, { id: "ggg", name: "Golf list (someone)", short: "Golf" }];
const TERMS = ["christmas", "summer", "beach"];
/** A small valid file over L5 that uses every new kind: a union, an any, a runtime, a rating, the cards, a list with its own label, and one list outside the menus. */
const good5 = () => ({
  version: 1, floor: { countries: 20, eras: 20 }, order: ["moods", "genres", "critics", "directors", "director-picks", "friends", "explore", "search"], retire: ["lists", "lists-unseen", "director-picks"], seen: { name: "seen", option: "Include seen" }, spread: { per: 2, window: 20 },
  menuless: ["ggg"],
  explore: { genre: "genres" },
  catalogs: [
    { id: "genres", name: "Mood Engine · Genres", options: [{ id: "g-comedy", label: "Comedy", any: { lists: ["aaa"], keywords: ["christmas"], genre: "Comedy" } }, { id: "g-scifi", label: "Sci-fi", any: { genre: "Science Fiction" } }] },
    { id: "critics", name: "Mood Engine · Critics", options: [{ id: "u-bd", label: "Beta and Delta", lists: ["bbb", "ddd"] }, { list: "ccc", label: "Gamma, said otherwise" }, { id: "k-long", label: "Long films", runtime: { min: 180 } }, { id: "n-top", label: "IMDb top rated", rating: { imdbTop: 250, tmdbVotesMin: 1000 } }] },
    { id: "directors", name: "Mood Engine · Directors", options: [{ directors: { "Scorsese loves": { lists: ["aaa2"] } } }] },
  ],
});
// the file above cites "aaa" in an any and "aaa2" in a card: aaa2 is not a list, so start from the real shape
const sound5 = () => { const j = good5(); j.catalogs[2].options = [{ directors: { "Scorsese loves": { lists: ["eee"] }, "Francis Ford Coppola loves": { lists: ["fff"], label: "Francis loves" } } }]; return j; };
const parse5 = (j, o = {}) => DC.parse(j, { lists: L5, today: TODAY, existingIds: [], keywordTerms: TERMS, ...o });
const refuses5 = (mutate, pattern, o) => { const j = sound5(); mutate(j); assert.throws(() => parse5(j, o), (e) => { assert.match(e.message, pattern); return true; }); };

test("p5 parse: a sound file with every new kind gives the spec — union, any (lists, keywords, genre), runtime, rating, a list with a label of its own, the cards, menuless and explore", () => {
  const spec = parse5(sound5());
  assert.deepEqual(spec.menuless, ["ggg"]);
  assert.deepEqual(spec.explore, { genre: "genres" });
  const g = spec.catalogs[0].options, c = spec.catalogs[1].options, d = spec.catalogs[2].options;
  assert.deepEqual(g[0], { id: "g-comedy", label: "Comedy", kind: "any", lists: ["aaa"], keywords: ["christmas"], genre: "Comedy" });
  assert.deepEqual(g[1], { id: "g-scifi", label: "Sci-fi", kind: "any", lists: [], keywords: [], genre: "Science Fiction" });
  assert.deepEqual(c[0], { id: "u-bd", label: "Beta and Delta", kind: "union", lists: ["bbb", "ddd"] });
  assert.deepEqual(c[1], { id: "l-ccc", label: "Gamma, said otherwise", kind: "list", list: "ccc" }, "a list option may say its own label (the short name is the default)");
  assert.deepEqual(c[2], { id: "k-long", label: "Long films", kind: "runtime", min: 180 });
  assert.deepEqual(c[3], { id: "n-top", label: "IMDb top rated", kind: "rating", imdbTop: 250, tmdbVotesMin: 1000 });
  assert.deepEqual(d, [{ kind: "directors", cards: [{ key: "Scorsese loves", label: "Scorsese loves", lists: [{ id: "eee", label: "Echo" }] }, { key: "Francis Ford Coppola loves", label: "Francis loves", lists: [{ id: "fff", label: "Foxtrot" }] }] }]);
  assert.equal(parse5((() => { const j = sound5(); delete j.explore; return j; })()).explore, undefined, "no `explore` key, none in the spec");
});

test("p5 parse: a list cited twice is refused wherever it is cited — an option and a union, two unions, an `any`, a card, and menuless (the message names both places)", () => {
  refuses5((j) => j.catalogs[1].options.push({ list: "bbb" }), /list bbb is in critics and critics/);
  refuses5((j) => { j.catalogs[1].options[0].lists = ["bbb", "ccc"]; }, /list ccc is in critics and critics/);
  refuses5((j) => { j.catalogs[0].options[0].any.lists = ["bbb"]; }, /list bbb is in genres and critics/);
  refuses5((j) => { j.catalogs[2].options[0].directors["Scorsese loves"].lists = ["aaa"]; }, /list aaa is in genres and directors/);
  refuses5((j) => { j.catalogs[2].options[0].directors["Scorsese loves"].lists = ["eee", "eee"]; }, /list eee appears twice in lists/);
  refuses5((j) => { j.menuless = ["aaa"]; }, /list aaa is in genres and menuless/);
  refuses5((j) => { j.menuless = ["ggg", "ggg"]; }, /menuless: list ggg appears twice/);
});

test("p5 parse: a list in `menuless` and in an option is refused; a list in neither is refused; a list in `menuless` alone is fine; a menuless id that config.json does not have is refused", () => {
  refuses5((j) => j.catalogs[0].options[1].any = { genre: "Science Fiction", lists: ["ggg"] }, /list ggg is in genres and menuless/);
  refuses5((j) => { j.menuless = []; }, /list ggg \(Golf list \(someone\)\) has no Discover catalog/);
  assert.deepEqual(parse5(sound5()).menuless, ["ggg"]);
  refuses5((j) => { j.menuless = ["ggg", "zzz"]; }, /menuless: list "zzz" is not a list of config.json/);
  refuses5((j) => { j.menuless = "ggg"; }, /menuless must be a list of list ids/);
});

test("p5 parse: a keyword that is not a positive term of the moods is refused (the column of the index could never hold it); the ones that are, pass; with no terms given every keyword is refused", () => {
  refuses5((j) => { j.catalogs[0].options[0].any.keywords = ["christmas", "musical"]; }, /keyword "musical" is not a positive term of the moods of config.json/);
  refuses5((j) => { j.catalogs[0].options[0].any.keywords = ["christmas", "christmas"]; }, /keyword "christmas" appears twice/);
  refuses5((j) => { j.catalogs[0].options[0].any.keywords = []; }, /any.keywords must be a list of at least one term/);
  assert.deepEqual(parse5((() => { const j = sound5(); j.catalogs[0].options[0].any.keywords = ["summer", "beach"]; return j; })()).catalogs[0].options[0].keywords, ["summer", "beach"]);
  assert.throws(() => DC.parse(sound5(), { lists: L5, today: TODAY }), /keyword "christmas" is not a positive term/);
});

test("p5 parse: a genre must be one of the 19 TMDB movie genres, spelled as the index column has it — Sci-fi and Noir are refused, Science Fiction is not", () => {
  assert.equal(DC.TMDB_GENRES.length, 19);
  refuses5((j) => { j.catalogs[0].options[1].any.genre = "Sci-fi"; }, /genre "Sci-fi" is not one of the 19 genres of TMDB/);
  refuses5((j) => { j.catalogs[0].options[1].any.genre = "Noir"; }, /genre "Noir" is not one of the 19 genres/);
  refuses5((j) => { j.catalogs[0].options[1].any.genre = "comedy"; }, /genre "comedy" is not one of the 19 genres/);
  assert.equal(parse5(sound5()).catalogs[0].options[1].genre, "Science Fiction");
});

test("p5 parse: an `any` with lists alone is refused (that is a union), with no key at all or an unknown key too; keywords alone and genre alone are fine", () => {
  refuses5((j) => { j.catalogs[0].options[1].any = { lists: ["ggg"] }; j.menuless = []; }, /an any with lists alone is a union of lists; it needs keywords or a genre/);
  refuses5((j) => { j.catalogs[0].options[1].any = {}; }, /an any with lists alone is a union of lists; it needs keywords or a genre/);
  refuses5((j) => { j.catalogs[0].options[1].any = { genre: "Drama", where: {} }; }, /any must be \{ lists\?, keywords\?, genre\? \}/);
  assert.doesNotThrow(() => parse5((() => { const j = sound5(); j.catalogs[0].options[1].any = { keywords: ["beach"] }; return j; })()));
});

test("p5 parse: a union needs two lists or more; runtime needs a whole number of minutes; rating needs imdbMin, lbMin or imdbTop and numbers in range; one kind per option", () => {
  refuses5((j) => { j.catalogs[1].options[0].lists = ["bbb"]; j.menuless = ["ggg", "ddd"]; }, /lists must be a list of at least 2 list ids/);
  refuses5((j) => { j.catalogs[1].options[2].runtime = { min: 0 }; }, /runtime must be \{ min: minutes/);
  refuses5((j) => { j.catalogs[1].options[2].runtime = { min: 90.5 }; }, /runtime must be/);
  refuses5((j) => { j.catalogs[1].options[2].runtime = { max: 90 }; }, /runtime must be/);
  refuses5((j) => { j.catalogs[1].options[3].rating = { tmdbVotesMin: 1000 }; }, /rating needs imdbMin, lbMin or imdbTop/);
  refuses5((j) => { j.catalogs[1].options[3].rating = { imdbMin: 11 }; }, /rating.imdbMin must be a number above 0 and at most 10/);
  refuses5((j) => { j.catalogs[1].options[3].rating = { lbMin: 5.5 }; }, /rating.lbMin must be a number above 0 and at most 5/);
  refuses5((j) => { j.catalogs[1].options[3].rating = { imdbTop: 2.5 }; }, /rating.imdbTop must be a whole number above zero/);
  refuses5((j) => { j.catalogs[1].options[3].rating = { imdbMin: 8, stars: 4 }; }, /rating must be \{ imdbMin\?, lbMin\?, imdbTop\?, tmdbVotesMin\? \}/);
  refuses5((j) => { j.catalogs[1].options[2].country = "France"; }, /option "k-long": needs exactly one of where, country, decade, lists, any, runtime, rating or era, has country and runtime/);
  assert.doesNotThrow(() => parse5((() => { const j = sound5(); j.catalogs[1].options[3].rating = { imdbMin: 8, lbMin: 4 }; return j; })()));
});

test("p5 parse: `explore` points at a catalog whose every option is an `any` — a catalog with a list, a union or the cards is refused, an unknown catalog too, and no option is called All", () => {
  refuses5((j) => { j.explore = { genre: "critics" }; }, /explore.genre "critics": "Beta and Delta" is not a calculated genre filter \(kind any\); a catalog with curated options/);
  refuses5((j) => { j.explore = { genre: "critics" }; j.catalogs[1].options.splice(0, 1); j.menuless = ["ggg", "bbb", "ddd"]; }, /explore.genre "critics": "Gamma, said otherwise" is not a calculated genre filter/);
  refuses5((j) => { j.explore = { genre: "directors" }; }, /explore.genre "directors": the directors cards is not a calculated genre filter/);
  refuses5((j) => { j.explore = { genre: "nowhere" }; }, /explore.genre "nowhere" is not a catalog of this file/);
  refuses5((j) => { j.explore = { genre: "genres", extra: 1 }; }, /explore must be \{ "genre": <id of a catalog of this file> \}/);
  refuses5((j) => { j.catalogs[0].options[1].label = "All"; }, /an option called "All" would be the first value of the menu twice/);
  refuses5((j) => { j.catalogs[0].options[1].label = "all!"; }, /an option called "All"/);
});

test("p5 parse: the cards (`directors`) — once in the whole file, each card's lists exist, the label (his own or \"X loves\") has at most 28 characters and is not the same words as another option", () => {
  refuses5((j) => j.catalogs[1].options.push({ directors: { "Kubrick loves": { lists: ["ggg"] } } }), /the directors entry appears twice in the file/);
  refuses5((j) => { j.catalogs[2].options[0].directors["Scorsese loves"].lists = ["zzz"]; }, /directors card "Scorsese loves": list "zzz" is not a list of config.json/);
  refuses5((j) => { j.catalogs[2].options[0].directors["Scorsese loves"].lists = []; }, /lists must be a list of at least 1 list id/);
  refuses5((j) => { j.catalogs[2].options[0].directors["Scorsese loves"].label = "S".repeat(29); }, /has 29 characters, the menu line holds 28/);
  refuses5((j) => { j.catalogs[2].options[0].directors["Scorsese loves"].colour = 1; }, /directors card "Scorsese loves" must be \{ lists: \[...\], label\? \}/);
  refuses5((j) => { j.catalogs[2].options[0].directors["Scorsese loves"].label = "Francis loves"; }, /"Francis loves" and "Francis loves" are the same option to the Worker/);
  refuses5((j) => { j.catalogs[2].options[0].directors["Scorsese loves"].lists = ["eee", "ggg"]; j.menuless = []; j.catalogs[2].options[0].directors["Francis Ford Coppola loves"].label = "Golf"; }, /"Golf" and "Golf" are the same option/);
  refuses5((j) => { j.catalogs[2].options[0].extra = 1; }, /the directors entry has more than "directors"/);
});

test("p5 parse: a label of a list option of its own is checked like any other (28 characters, the same words)", () => {
  refuses5((j) => { j.catalogs[1].options[1].label = "x".repeat(29); }, /the label "x{29}" has 29 characters/);
  refuses5((j) => { j.catalogs[1].options[1].label = "long films"; }, /"Long films" and "long films" are the same option to the Worker/);
});

test("p5 parse: the real build wiring — build.js hands parse() the keywordTerms of the SAME moods the v2 index is built with (the config's and the Board's), and keywordTerms() lists exactly the positive terms of the moods", () => {
  const { keywordTerms, allowlist } = require("../lib/index-export");
  const moods = [{ id: "m", name: "M", word: "Mm", keywords: { christmas: 1.2, "santa claus": 0.4, gore: -2 } }];
  assert.deepEqual(keywordTerms(moods), ["christmas", "santa claus"], "the negative term is a warning, not a word the column holds");
  assert.deepEqual(keywordTerms(CONFIG.moods), allowlist(CONFIG.moods).map((t) => t.term));
  const src = fs.readFileSync(path.join(ROOT, "build.js"), "utf8");
  assert.ok(src.includes("keywordTerms: keywordTerms([...(cfg.moods || []), ...BOARD.moods])"), "build.js passes the moods of the v2 index to parse()");
  assert.ok(src.includes("cfg: { ...cfg, moods: [...cfg.moods, ...BOARD.moods] }"), "and the v2 index is made with the same moods");
});

// ── the membership the five kinds work out ────────────────────────────────────────────────────────────────────────────────────────────────

/** A world for the new kinds: `lists` and `directors` too, `terms` for the parse. Every film gets its own director unless it says so, so the spread leaves the index order as it is. */
function world5(films, catalogs, { directors = [], extra = {}, terms = TERMS, spreadSpec } = {}) {
  const index = { films: films.map((f) => f.entry), lists: [], directors: { options: directors } };
  const logged = [];
  const cited = new Set();
  const text = JSON.stringify(catalogs);
  for (const l of L5) if (new RegExp(`"${l.id}"`).test(text)) cited.add(l.id); // a list id written anywhere in the catalogs is cited there
  const menuless = [...new Set([...(extra.menuless || []), ...L5.map((l) => l.id).filter((id) => !cited.has(id))])].filter((id) => !cited.has(id));
  const spec = DC.parse({ ...good(), ...(spreadSpec ? { spread: spreadSpec } : {}), floor: { countries: 1, eras: 1 }, order: orderOf(catalogs), retire: ["lists", "lists-unseen"], catalogs, ...extra, menuless }, { lists: L5, today: TODAY, keywordTerms: terms });
  const out = DC.build({ spec, index, recordOf: () => null, log: (l) => logged.push(l) });
  return { out, logged, spec, option: (cat, id) => out.catalogs.find((c) => c.id === cat).options.find((o) => o.id === id), ids: (cat, id) => out.catalogs.find((c) => c.id === cat).options.find((o) => o.id === id).ids };
}
const tts = (...fs_) => fs_.map((f) => f.entry.tt);
const fully = (o = {}) => planted({ ...o, entry: { ...(o.entry || {}) } });

test("p5 build: an `any` brings its films in three blocks — the lists, then the keywords, then the rest (the genre alone) — each in the order of the index, and one spread runs over all three", () => {
  // index order (best rank first): a (genre only), b (keyword), c (list), d (genre only), e (list and keyword), f (keyword and genre)
  const a = fully({ entry: { genres: ["Comedy"] } }), b = fully({ entry: { keywords: ["christmas"] } }), c = fully({ entry: { lists: { aaa: 1 } } }), d = fully({ entry: { genres: ["Comedy", "Drama"] } });
  const e = fully({ entry: { lists: { aaa: 2 }, keywords: ["christmas"] } }), f = fully({ entry: { keywords: ["christmas"], genres: ["Comedy"] } });
  const w = world5([a, b, c, d, e, f], [{ id: "genres", name: "Mood Engine · Genres", options: [{ id: "g-comedy", label: "Comedy", any: { lists: ["aaa"], keywords: ["christmas"], genre: "Comedy" } }] }]);
  assert.deepEqual(w.ids("genres", "g-comedy"), tts(c, e, b, f, a, d), "lists (c, e), keywords (b, f), the rest (a, d)");
  assert.equal(w.option("genres", "g-comedy").curated, undefined, "an any is not curated: it carries the recommendation rule");
});

test("p5 build: an `any` is an OR — a film with only the list, only the keyword or only the genre is in; a film with none is out; and only the eligible ones are kept, the list's own films included", () => {
  const onlyList = fully({ entry: { lists: { aaa: 1 } } }), onlyWord = fully({ entry: { keywords: ["christmas"] } }), onlyGenre = fully({ entry: { genres: ["Comedy"] } });
  const none = fully({ entry: { genres: ["Drama"], keywords: ["beach"], lists: { bbb: 1 } } }), refusedInList = fully({ eligible: false, entry: { lists: { aaa: 3 } } }), seen = fully({ entry: { seen: true, genres: ["Comedy"] } });
  const w = world5([onlyList, onlyWord, onlyGenre, none, refusedInList, seen], [{ id: "genres", name: "Mood Engine · Genres", options: [{ id: "g-comedy", label: "Comedy", any: { lists: ["aaa"], keywords: ["christmas"], genre: "Comedy" } }, { id: "g-two", label: "Two", any: { keywords: ["christmas", "summer"] } }, { id: "g-drama", label: "Drama", any: { genre: "Drama" } }] }, { id: "rest", name: "Mood Engine · Rest", options: [{ list: "bbb" }, { list: "ccc" }, { list: "ddd" }, { list: "eee" }, { list: "fff" }, { list: "ggg" }] }]);
  assert.deepEqual(w.ids("genres", "g-comedy"), tts(onlyList, onlyWord, onlyGenre, seen), "the film the rule refuses is not here, though it sits in the list; the seen one stays for \"Include seen\"");
  assert.deepEqual(w.ids("genres", "g-two"), tts(onlyWord), "keywords alone: the film with only the list is not there");
  assert.deepEqual(w.ids("genres", "g-drama"), tts(none));
});

test("p5 build: a `lists` union takes every film of the index in one of the lists — seen or not, eligible or not (an editorial collection, no rule) — in the order of the index; the option says `curated: true`", () => {
  const inA = fully({ entry: { lists: { bbb: 1 } } }), inB = fully({ entry: { lists: { ddd: 4 } } }), seen = fully({ entry: { seen: true, lists: { bbb: 2 } } }), weak = fully({ eligible: false, entry: { lists: { ddd: 9 } } });
  const outside = fully({ entry: { lists: { ccc: 1 } } }), both = fully({ entry: { lists: { bbb: 3, ddd: 1 } } });
  const w = world5([inA, outside, inB, seen, weak, both], [{ id: "critics", name: "Mood Engine · Critics", options: [{ id: "u-bd", label: "Beta and Delta", lists: ["bbb", "ddd"] }] }]);
  assert.deepEqual(w.ids("critics", "u-bd"), tts(inA, inB, seen, weak, both));
  assert.equal(w.option("critics", "u-bd").curated, true);
  assert.deepEqual(Object.keys(w.option("critics", "u-bd")).sort(), ["curated", "id", "ids", "label"]);
  assert.ok(w.logged.includes("    Beta and Delta 4"), `the log counts the films that are not seen, the weak one too (the seen one is not counted): ${w.logged.join(" | ")}`);
});

test("p5 build: a curated option has no music rule either — a music film held back (`musicOut`) stays in the ids AND counts in the log as shown, where a calculated option does not count it (the Worker keeps the music rule out of a curated option)", () => {
  const plainFilm = fully({ entry: { lists: { bbb: 1 }, genres: ["Comedy"] } }), music = fully({ entry: { musicOut: true, lists: { bbb: 2, eee: 2 }, genres: ["Comedy"] } });
  const w = world5([plainFilm, music], [{ id: "critics", name: "Mood Engine · Critics", options: [{ id: "u-bd", label: "Beta and Delta", lists: ["bbb", "ddd"] }, { id: "g-c", label: "Comedy", any: { genre: "Comedy" } }] }]);
  assert.deepEqual(w.ids("critics", "u-bd"), tts(plainFilm, music));
  assert.ok(w.logged.includes("    Beta and Delta 2"), `a curated option shows the music film: ${w.logged.join(" | ")}`);
  assert.ok(w.logged.includes("    Comedy 1"), `a calculated one does not: ${w.logged.join(" | ")}`);
});

test("p5 build: a union keeps the film the rule refuses and the film he has seen (the control of the `eligible` filter): the same lists in an `any` with a genre drop the refused one", () => {
  const weak = fully({ eligible: false, entry: { lists: { bbb: 1, eee: 1 }, genres: ["Comedy"] } }), seen = fully({ entry: { seen: true, lists: { bbb: 2, eee: 2 }, genres: ["Comedy"] } });
  const w = world5([weak, seen], [{ id: "critics", name: "Mood Engine · Critics", options: [{ id: "u-bd", label: "Beta and Delta", lists: ["bbb", "ddd"] }, { id: "g-c", label: "Comedy", any: { lists: ["eee"], genre: "Comedy" } }] }]);
  assert.deepEqual(w.ids("critics", "u-bd"), tts(weak, seen));
  assert.deepEqual(w.ids("critics", "g-c"), tts(seen));
});

test("p5 build: `runtime` is a minimum — 180 minutes is in, 179 is out, a film with no runtime is out, a film the rule refuses is out", () => {
  const exact = fully({ entry: { runtime: 180 } }), longer = fully({ entry: { runtime: 240 } }), under = fully({ entry: { runtime: 179 } }), none = fully(), weak = fully({ eligible: false, entry: { runtime: 300 } });
  const w = world5([exact, under, none, longer, weak], [{ id: "craft", name: "Mood Engine · Craft", options: [{ id: "k-long", label: "Long films", runtime: { min: 180 } }] }]);
  assert.deepEqual(w.ids("craft", "k-long"), tts(exact, longer));
});

test("p5 build: `rating` holds every condition at once — IMDb 8 AND Letterboxd 4 — and a film that has only one of them is out; votes alone filter, they do not make a rating", () => {
  const both = fully({ entry: { imdbRating: 8.1, lbRating: 4.2, tmdbVotes: 5000 } }), imdbOnly = fully({ entry: { imdbRating: 8.6, lbRating: 3.4, tmdbVotes: 5000 } }), lbOnly = fully({ entry: { imdbRating: 7.2, lbRating: 4.4, tmdbVotes: 5000 } });
  const exact = fully({ entry: { imdbRating: 8, lbRating: 4, tmdbVotes: 5000 } }), noImdb = fully({ entry: { lbRating: 4.5 } }), fewVotes = fully({ entry: { imdbRating: 9, lbRating: 4.5, tmdbVotes: 40 } }), weak = fully({ eligible: false, entry: { imdbRating: 9, lbRating: 4.9, tmdbVotes: 5000 } });
  const w = world5([both, imdbOnly, lbOnly, exact, noImdb, fewVotes, weak], [{ id: "letterboxd", name: "Mood Engine · Letterboxd", options: [{ id: "n-both", label: "Loved on both", rating: { imdbMin: 8, lbMin: 4 } }, { id: "n-imdb", label: "IMDb 8.0+", rating: { imdbMin: 8 } }, { id: "n-voted", label: "IMDb voted", rating: { imdbMin: 8, tmdbVotesMin: 1000 } }] }]);
  assert.deepEqual(w.ids("letterboxd", "n-both"), tts(both, exact, fewVotes), "an AND: 8.0 and 4.0 are in (>=), the film with one of the two is not");
  assert.deepEqual(w.ids("letterboxd", "n-imdb"), tts(both, imdbOnly, exact, fewVotes));
  assert.deepEqual(w.ids("letterboxd", "n-voted"), tts(both, imdbOnly, exact), "the few votes are filtered");
});

test("p5 build: `imdbTop` N takes the N best IMDb ratings among ALL the films with enough votes — the ties at the cut come in (not `slice(0, N)`), a film that the rule refuses still holds its place in the ranking, a film with few votes does not", () => {
  const mk = (r, o = {}) => fully({ eligible: o.eligible, entry: { imdbRating: r, tmdbVotes: o.votes ?? 5000 } });
  const refusedNine = mk(9.5, { eligible: false }), nine = mk(9.0), a = mk(8.5), b = mk(8.5), c = mk(8.5), low = mk(8.0), few = mk(9.9, { votes: 500 });
  const w = world5([few, refusedNine, nine, a, b, c, low], [{ id: "letterboxd", name: "Mood Engine · Letterboxd", options: [{ id: "n-top3", label: "Top 3", rating: { imdbTop: 3, tmdbVotesMin: 1000 } }, { id: "n-top1", label: "Top 1", rating: { imdbTop: 1, tmdbVotesMin: 1000 } }, { id: "n-top99", label: "Top 99", rating: { imdbTop: 99, tmdbVotesMin: 1000 } }, { id: "n-topfew", label: "Top with few", rating: { imdbTop: 1 } }] }]);
  assert.deepEqual(w.ids("letterboxd", "n-top3"), tts(nine, a, b, c), "the ranking is 9.5 (refused), 9.0, 8.5 x3: the top 3 is 9.5, 9.0, 8.5 and its ties; the refused one is not shown");
  assert.deepEqual(w.ids("letterboxd", "n-top1"), tts(), "the best film of all is the one the rule refuses: nobody is shown (the ranking counts every film)");
  assert.deepEqual(w.ids("letterboxd", "n-top99"), tts(nine, a, b, c, low), "fewer films than N: all of those with votes");
  assert.deepEqual(w.ids("letterboxd", "n-topfew"), tts(few), "without a vote minimum the 9.9 film with 500 votes is the best of all");
});

test("p5 build: the cards — each director of index.directors.options in that order is his \"X loves\" plus the films of the lists mapped to him (seen or not, no rule), the others are their \"loves\" alone; `director` names the option it grew from", () => {
  const loved1 = fully(), loved2 = fully(), inList = fully({ entry: { lists: { eee: 1 } } }), seenInList = fully({ entry: { seen: true, lists: { eee: 2 } } }), weakInList = fully({ eligible: false, entry: { lists: { eee: 3 } } }), both = fully({ entry: { lists: { eee: 4 } } }), kubrick = fully(), outside = fully({ entry: { lists: { ccc: 1 } } });
  const directors = [
    { label: "Francis Ford Coppola loves", ids: tts(loved1), descs: [""] },
    { label: "Scorsese loves", ids: [both.entry.tt, loved2.entry.tt], descs: ["", ""] },
    { label: "Kubrick loves", ids: tts(kubrick), descs: [""] },
  ];
  const w = world5([loved1, inList, loved2, seenInList, both, kubrick, weakInList, outside], [{ id: "directors", name: "Mood Engine · Directors", options: [{ directors: { "Scorsese loves": { lists: ["eee"] } } }] }, { id: "rest", name: "Mood Engine · Rest", options: [{ list: "ccc" }] }], { directors, extra: { menuless: ["aaa", "bbb", "ddd", "fff", "ggg"] } });
  const cards = w.out.catalogs[0].options;
  assert.deepEqual(cards.map((o) => [o.label, o.director]), [["Francis Ford Coppola loves", "Francis Ford Coppola loves"], ["Scorsese loves", "Scorsese loves"], ["Kubrick loves", "Kubrick loves"]], "the order of the directors' options");
  assert.deepEqual(cards.map((o) => o.id), ["d-francis-ford-coppola-loves", "d-scorsese-loves", "d-kubrick-loves"]);
  assert.ok(cards.every((o) => o.curated === true && !("list" in o)));
  assert.deepEqual(cards[0].ids, tts(loved1), "no list is mapped to Francis: his loves alone");
  assert.deepEqual(cards[1].ids, tts(inList, loved2, seenInList, both, weakInList), "his loves and the films of the list eee, the seen one and the weak one included, once each, in the order of the index");
  assert.ok(w.logged.includes("    Scorsese loves 4"), `the log counts the films he has not seen: ${w.logged.join(" | ")}`);
});

test("p5 build: a card with a label of its own shows it; the film a card holds only through a list has no \"Loved by\" text of its own (the loves keep `descs`, the cards carry none)", () => {
  const loved = fully(), inList = fully({ entry: { lists: { fff: 1 } } });
  const w = world5([loved, inList], [{ id: "directors", name: "Mood Engine · Directors", options: [{ directors: { "Francis Ford Coppola loves": { lists: ["fff"], label: "Francis loves" } } }] }, { id: "rest", name: "Mood Engine · Rest", options: [{ list: "ccc" }] }], { directors: [{ label: "Francis Ford Coppola loves", ids: tts(loved), descs: ["Loved by Francis"] }], extra: { menuless: ["aaa", "bbb", "ddd", "eee", "ggg"] } });
  const card = w.out.catalogs[0].options[0];
  assert.deepEqual([card.label, card.director, card.ids], ["Francis loves", "Francis Ford Coppola loves", tts(loved, inList)]);
  assert.ok(!("descs" in card));
});

test("p5 build: when the \"X loves\" of a mapped card is not there tonight, the lists mapped to it become list options right after the cards, and the log says ' !' on each", () => {
  const loved = fully();
  const w = world5([loved], [{ id: "directors", name: "Mood Engine · Directors", options: [{ directors: { "Scorsese loves": { lists: ["eee", "fff"] }, "Kubrick loves": { lists: ["ddd"] } } }] }, { id: "rest", name: "Mood Engine · Rest", options: [{ list: "ccc" }] }], { directors: [{ label: "Kubrick loves", ids: tts(loved), descs: [""] }], extra: { menuless: ["aaa", "bbb", "ggg"] } });
  const opts = w.out.catalogs[0].options;
  assert.deepEqual(opts.map((o) => o.label), ["Kubrick loves", "Echo", "Foxtrot"], "the card of the director who is there, then the orphans in the order of the file");
  assert.deepEqual(opts.slice(1), [{ id: "l-eee", label: "Echo", list: "eee" }, { id: "l-fff", label: "Foxtrot", list: "fff" }]);
  assert.deepEqual(w.logged.filter((l) => / !$/.test(l)), ["    Echo 0 !", "    Foxtrot 0 !"]);
  assert.equal(w.logged.filter((l) => /Kubrick loves/.test(l)).length, 1);
  assert.deepEqual(opts[0].ids, tts(loved), "Kubrick's card is only his loves: the list mapped to him ddd has no film in this world");
});

test("p5 build: with no director options at all every mapped list is an orphan; with no `directors` entry in the file the directors' options are not touched", () => {
  const w = world5([fully()], [{ id: "directors", name: "Mood Engine · Directors", options: [{ directors: { "Scorsese loves": { lists: ["eee"] } } }] }, { id: "rest", name: "Mood Engine · Rest", options: [{ list: "ccc" }] }], { directors: [], extra: { menuless: ["aaa", "bbb", "ddd", "fff", "ggg"] } });
  assert.deepEqual(w.out.catalogs[0].options, [{ id: "l-eee", label: "Echo", list: "eee" }]);
  const none = world5([fully()], [{ id: "rest", name: "Mood Engine · Rest", options: [{ list: "ccc" }, { list: "eee" }, { list: "fff" }] }], { directors: [{ label: "Kubrick loves", ids: [], descs: [] }], extra: { menuless: ["aaa", "bbb", "ddd", "ggg"] } });
  assert.deepEqual(none.out.catalogs[0].options.map((o) => o.label), ["Gamma list, no short name", "Echo", "Foxtrot"]);
});

test("p5 build: `explore` goes into the discover object when the file has it (after `seen`, before the catalogs), and the object is the one of before when it does not", () => {
  const w = world5([fully({ entry: { genres: ["Comedy"] } })], [{ id: "genres", name: "Mood Engine · Genres", options: [{ id: "g-comedy", label: "Comedy", any: { genre: "Comedy" } }] }, { id: "rest", name: "Mood Engine · Rest", options: [{ list: "aaa" }, { list: "bbb" }, { list: "ccc" }, { list: "ddd" }, { list: "eee" }, { list: "fff" }, { list: "ggg" }] }], { extra: { explore: { genre: "genres" } } });
  assert.deepEqual(w.out.explore, { genre: "genres" });
  assert.deepEqual(Object.keys(w.out), ["order", "retire", "seen", "explore", "catalogs"]);
  const plain_ = world([planted()], catalog("places", [{ id: "c-france", label: "France", country: "France" }]));
  assert.deepEqual(Object.keys(plain_.out), ["order", "retire", "seen", "catalogs"], "no `explore` key at all");
});

test("p5 build: a list option is logged too (the unseen films of its list in the index), so a night's numbers can be read for every option", () => {
  const a = fully({ entry: { lists: { ccc: 1 } } }), b = fully({ entry: { seen: true, lists: { ccc: 2 } } });
  const w = world5([a, b], [{ id: "rest", name: "Mood Engine · Rest", options: [{ list: "ccc" }, { list: "aaa" }, { list: "bbb" }, { list: "ddd" }, { list: "eee" }, { list: "fff" }, { list: "ggg" }] }]);
  assert.ok(w.logged.includes("    Gamma list, no short name 1"), w.logged.join(" | "));
  assert.ok(w.logged.includes("    Alpha French 0"));
});

test("p5 build: a spread runs over a curated option too, on the films it shows (not seen) — a director with five films in a row does not fill the first screen of a union", () => {
  const lists = { bbb: 1 };
  const films = [0, 1, 2, 3, 4].map(() => fully({ entry: { director: "Same Director", lists } })).concat([0, 1, 2].map((i) => fully({ entry: { director: `Other ${i}`, lists } })));
  const w = world5(films, [{ id: "critics", name: "Mood Engine · Critics", options: [{ id: "u-bd", label: "Beta and Delta", lists: ["bbb", "ddd"] }] }]);
  const first = w.ids("critics", "u-bd").slice(0, 5).map((tt) => films.find((f) => f.entry.tt === tt).entry.director);
  assert.equal(first.filter((d) => d === "Same Director").length, 2, first.join());
});

// ── the spread over the new kinds (review of front A, 29/10/2026: the tests above gave every film its own director, so the spread had nothing to do and seven mutations that turned it off, per kind or per block, stayed green) ──

/** Three films of ONE director first in the index and then films of others: the spread has to put the third film of the director after the others (per 2, window 20, no perAfterFirstPage in this world). */
const crowd = (extra, others) => { const same = [0, 1, 2].map(() => fully({ entry: { director: "Same Director", ...extra } })); const rest = others.map((o) => fully({ entry: { director: `Other ${o.n}`, ...extra, ...o.entry } })); return { same, rest }; };

test("p5 build, spread: an `any` is spread by director over ALL its films — three films of one director in the list block, then the keyword and genre films: his third goes after them (single spread over the three blocks, not one spread per block)", () => {
  const same = [0, 1, 2].map(() => fully({ entry: { director: "Same Director", lists: { aaa: 1 }, genres: ["Comedy"] } }));
  const kw = fully({ entry: { director: "Kw", keywords: ["christmas"] } }), rest = fully({ entry: { director: "Rest", genres: ["Comedy"] } });
  const w = world5([...same, kw, rest], [{ id: "genres", name: "Mood Engine · Genres", options: [{ id: "g-c", label: "Comedy", any: { lists: ["aaa"], keywords: ["christmas"], genre: "Comedy" } }] }]);
  assert.deepEqual(w.ids("genres", "g-c"), tts(same[0], same[1], kw, rest, same[2]), "blocks lists / keywords / rest are 3 / 1 / 1 films; one spread over the 5 puts the third film of the director last. A spread per block would leave [s0 s1 s2 kw rest]; no spread, the same");
});

test("p5 build, spread: `rating` is spread by director — his third film goes after the films of the others", () => {
  const { same, rest } = crowd({ imdbRating: 8.5, tmdbVotes: 5000 }, [{ n: 1 }, { n: 2 }]);
  const w = world5([...same, ...rest], [{ id: "letterboxd", name: "Mood Engine · Letterboxd", options: [{ id: "n-hi", label: "IMDb 8.0+", rating: { imdbMin: 8 } }, { id: "n-top", label: "Top", rating: { imdbTop: 5 } }] }]);
  assert.deepEqual(w.ids("letterboxd", "n-hi"), tts(same[0], same[1], rest[0], rest[1], same[2]));
  assert.deepEqual(w.ids("letterboxd", "n-top"), tts(same[0], same[1], rest[0], rest[1], same[2]), "imdbTop is spread too");
});

test("p5 build, spread: `runtime` is spread by director — his third film goes after the films of the others", () => {
  const { same, rest } = crowd({ runtime: 200 }, [{ n: 1 }, { n: 2 }]);
  const w = world5([...same, ...rest], [{ id: "craft", name: "Mood Engine · Craft", options: [{ id: "k-long", label: "Long films", runtime: { min: 180 } }] }]);
  assert.deepEqual(w.ids("craft", "k-long"), tts(same[0], same[1], rest[0], rest[1], same[2]));
});

test("p5 build, spread: a card of a director is spread too — a director with three films in the loves of another director does not fill the top of the card", () => {
  const { same, rest } = crowd({}, [{ n: 1 }, { n: 2 }]);
  const all = [...same, ...rest];
  const w = world5(all, [{ id: "directors", name: "Mood Engine · Directors", options: [{ directors: { "Kubrick loves": { lists: ["eee"] } } }] }, { id: "rest", name: "Mood Engine · Rest", options: [{ list: "ccc" }] }], { directors: [{ label: "Kubrick loves", ids: tts(...all), descs: all.map(() => "") }] });
  assert.deepEqual(w.out.catalogs[0].options[0].ids, tts(same[0], same[1], rest[0], rest[1], same[2]));
});

// ── the validation of the new shapes ────────────────────────────────────────────────────────────────────────────────────────────────────

const CARDS = () => ({ order: ["moods", "places", "director-picks", "explore", "search"], retire: ["lists", "lists-unseen", "director-picks"], seen: { name: "seen", option: "Include seen" }, explore: { genre: "places" }, catalogs: [{ id: "places", name: "Mood Engine · Directors", options: [{ id: "c-france", label: "France", ids: [] }, { id: "d-kubrick-loves", label: "Kubrick loves", ids: [], curated: true, director: "Kubrick loves" }, { id: "u-aa", label: "Union", ids: [], curated: true }] }] });
const withCards = (films, mutate = () => {}) => { const d = CARDS(); d.catalogs[0].options[0].ids = [films[0].tt]; d.catalogs[0].options[1].ids = [films[1].tt]; d.catalogs[0].options[2].ids = [films[1].tt]; mutate(d); return mini(films, { discover: d, directors: { options: [{ label: "Kubrick loves", ids: [], descs: [] }] } }); };

test("p5 validation: a curated option may hold a film the rule refuses (a union, a card), a calculated one may not; the control — the same film in a calculated option is refused by name", () => {
  const [a, b] = two();
  const weak = { ...b }; delete weak.eligible;
  assert.doesNotThrow(() => validateIndex(withCards([a, weak]), "index-v2"), "the weak film is in the card and the union, which are curated");
  assert.throws(() => validateIndex(withCards([a, weak], (d) => { d.catalogs[0].options[0].ids = [weak.tt]; }), "index-v2"), new RegExp(`${weak.tt} \\(${weak.name}\\) sits in discover places / France but is not eligible`));
  assert.throws(() => validateIndex(withCards([a, weak], (d) => { delete d.catalogs[0].options[2].curated; }), "index-v2"), /sits in discover places \/ Union but is not eligible/);
});

test("p5 validation: `director` must be the label of a directors' option; `curated` is only true and only on an option with ids; `director` only on a curated one; `explore` names a catalog of the discover", () => {
  const [a, b] = two();
  assert.doesNotThrow(() => validateIndex(withCards([a, b]), "index-v2"));
  assert.throws(() => validateIndex(withCards([a, b], (d) => { d.catalogs[0].options[1].director = "Nobody loves"; }), "index-v2"), /discover places \/ Kubrick loves names the director option "Nobody loves", which is not among the directors' options/);
  assert.throws(() => validateIndex(withCards([a, b], (d) => { d.catalogs[0].options[1].curated = false; }), "index-v2"), /curated is true on an option with ids, or absent/);
  assert.throws(() => validateIndex(withCards([a, b], (d) => { d.catalogs[0].options[0].curated = "yes"; }), "index-v2"), /curated is true/);
  assert.throws(() => validateIndex(withCards([a, b], (d) => { delete d.catalogs[0].options[1].curated; }), "index-v2"), /director is the text of a directors option, on a curated option/);
  assert.throws(() => validateIndex(withCards([a, b], (d) => { d.catalogs[0].options[1].director = 5; }), "index-v2"), /director is the text of a directors option/);
  assert.throws(() => validateIndex(withCards([a, b], (d) => { d.catalogs[0].options.push({ id: "l-aaa", label: "Alpha French", list: "aaa", curated: true }); }), "index-v2"), /curated is true on an option with ids/);
  assert.throws(() => validateIndex(withCards([a, b], (d) => { d.explore = { genre: "nowhere" }; }), "index-v2"), /discover.explore.genre names the catalog "nowhere", which the discover does not have/);
  assert.throws(() => validateIndex(withCards([a, b], (d) => { d.explore = { genre: "places", extra: 1 }; }), "index-v2"), /Unexpected index field discover.explore.extra/);
  assert.throws(() => validateIndex(withCards([a, b], (d) => { d.explore = { genre: 5 }; }), "index-v2"), /Invalid index discover explore/);
});

test("p5 validation: the slices carry the menus of the cards and the union with `curated` and `director` kept and `ids: []`; a slice with ids in a card is refused; the director of a card is checked in the slices too", () => {
  const [a, b] = two();
  const whole = withCards([a, b]);
  const labels = discoverLabels(whole.discover);
  assert.deepEqual(labels.catalogs[0].options[1], { id: "d-kubrick-loves", label: "Kubrick loves", ids: [], curated: true, director: "Kubrick loves" });
  assert.deepEqual(labels.explore, { genre: "places" });
  const clean = [];
  checkIndex("v2-menus", encode({ ...whole, meta: { ...whole.meta, part: "v2-menus", count: 0 }, films: [], discover: labels }), clean, "index-v2-menus");
  assert.deepEqual(clean, []);
  const withIds = [];
  checkIndex("v2-menus", encode({ ...whole, meta: { ...whole.meta, part: "v2-menus", count: 0 }, films: [] }), withIds, "index-v2-menus");
  assert.match(withIds.join("\n"), /discover places \/ Kubrick loves carries 1 films, and only the whole index carries them/);
  const orphan = [];
  checkIndex("v2-menus", encode({ ...whole, meta: { ...whole.meta, part: "v2-menus", count: 0 }, films: [], directors: { options: [] }, discover: labels }), orphan, "index-v2-menus");
  assert.match(orphan.join("\n"), /names the director option "Kubrick loves"/);
});
