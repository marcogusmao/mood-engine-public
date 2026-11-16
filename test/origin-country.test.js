// node --test            (no dependencies)
// The main country of a film (Marco, 22/10/2026, questionnaire 3b: "eh o 1 mas topsy turvy eh british"; the rule is PENDING a layer for the director's country, his later
// answer on Roma: "Roma é do México, foca no diretor de onde ele é", being measured): TMDB's `origin_country` decides when it names ONE country; with several, the rule of
// 13/10 and 14/10/2026 (mainIso: the language and the producers) when its answer is among them, else the first of them; with none, or a record fetched before the field was kept, the old rule.
// ONE function (lib/countries.js mainCountry) answers for the card (line 1 of the description, the first name of the index's `countries` column, lib/pool.js cardFacts) and for the Board's
// regions (lib/moods.js passes), so they cannot disagree. The film facts below are FROZEN as the TMDB answers of 22/10/2026 gave them (the cache is rewritten every night).
//
// Mutations this file is meant to turn red (recorded in the commit of 22/10/2026):
//   mainCountry ignores `origin` (always the old rule)                         → "one origin", "named films", "card and region", "passes"
//   with several origins the first of them always wins (never the old rule)    → "several origins: the old rule's answer when it is among them"
//   with several origins none the old rule's answer: the old rule anyway       → "several origins: ... otherwise the first"
//   an empty or missing origin read as "no country"                            → "no usable origin"
//   the card back on the cover flag's rule (pickCountry)                        → "card and region", "named films"
//   passes() back on mainIso                                                    → "passes: the Board's regions"
//   trim() without `origin`, or with the key elsewhere                          → "trim keeps origin"
//   scripts/backfill-origin.js writing a non-array, or at the end of the record → "backfill-origin: ..."

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const C = require("../lib/countries");
const P = require("../lib/pool");
const { passes } = require("../lib/moods");
const { trim } = require("../lib/tmdb");
const B = require("../scripts/backfill-origin");
const DR = require("../lib/directors");
const BD = require("../scripts/backfill-directors");

const REG = () => Object.keys(C.REGIONS).filter((r) => r !== "latam-hisp");
const regionsOfIso = (iso) => (iso ? REG().filter((r) => C.inRegion(iso, r)) : []);

test("one origin: it is the main country, whatever the language and the producers say (Topsy-Turvy, GB + US producers, in English: GB, where the old rule said US)", () => {
  assert.equal(C.mainIso({ countries: ["GB", "US"], lang: "en" }), "US", "the old rule, still there");
  assert.equal(C.mainCountry({ countries: ["GB", "US"], lang: "en", origin: ["GB"] }), "GB");
  assert.equal(C.mainCountry({ countries: ["GB", "US"], lang: "en", origin: ["US"] }), "US");
  assert.equal(C.mainCountry({ countries: ["GB", "US"], lang: "es", origin: ["US"] }), "US", "Spanish with no Spanish-speaking producer was Mexico by the old rule: the origin wins (Roma)");
  assert.equal(C.mainCountry({ countries: ["MK"], lang: "tr", origin: ["MK"] }), "MK", "the language's home is no longer where the film is when TMDB names its origin (Honeyland)");
  assert.equal(C.mainCountry({ countries: [], lang: "en", origin: ["GB"] }), "GB", "no producer at all: the origin is still the film's country");
  assert.equal(C.mainCountry({ countries: ["DE"], lang: "de", origin: ["fr"] }), "FR", "upper case; the origin need not be a producer");
  assert.equal(C.mainCountry({ countries: ["SU"], lang: "ru", origin: ["SU"] }), "SU", "a country that no longer exists keeps its TMDB code");
  assert.equal(C.mainCountry({ countries: ["XC"], lang: "sk", origin: ["XC"] }), "XC", "The Shop on Main Street: Czechoslovakia, and not Slovakia, the language's home");
  assert.equal(C.mainCountry({ countries: ["HK", "TW"], lang: "zh", origin: ["TW"] }), "TW", "A City of Sadness: Taiwan, and not Hong Kong, the first producer that speaks Chinese");
});

test("several origins: the old rule's answer when it is among them", () => {
  assert.equal(C.mainCountry({ countries: ["IT", "GB", "US"], lang: "en", origin: ["GB", "US"] }), "US", "Doctor Zhivago: the old rule says US and US is one of the two");
  assert.equal(C.mainCountry({ countries: ["GB", "US"], lang: "en", origin: ["US", "GB"] }), "US", "Macbeth 1971, whatever order TMDB lists the origins in");
  assert.equal(C.mainCountry({ countries: ["DK", "FI", "ID", "NO", "GB", "US"], lang: "en", origin: ["DK", "GB"] }), "DK", "The Look of Silence: the old rule says US, which is not among DK and GB: the first of them");
  assert.equal(C.mainCountry({ countries: ["BR", "FR", "DE", "PT"], lang: "pt", origin: ["BR", "DE", "FR", "PT", "ES"] }), "BR", "Tabu: the old rule says BR and it heads the list");
  assert.equal(C.mainCountry({ countries: ["MX", "ES", "US"], lang: "es", origin: ["ES", "MX"] }), "MX", "the old rule's MX, though ES is listed first");
});

test("several origins: otherwise the first of them", () => {
  assert.equal(C.mainCountry({ countries: ["GB", "US"], lang: "en", origin: ["FR", "DE"] }), "FR", "the old rule says US, in neither");
  assert.equal(C.mainCountry({ countries: ["DE", "FR"], lang: "en", origin: ["JP", "TW"] }), "JP");
  assert.equal(C.mainCountry({ countries: [], lang: "en", origin: ["DK", "SE"] }), "DK", "no producer: the old rule has no answer, so the first origin");
});

test("no usable origin: the old rule, exactly (an empty list, a key never fetched, junk)", () => {
  const f = { countries: ["GB", "US"], lang: "en" };
  assert.equal(C.mainIso(f), "US");
  for (const origin of [[], undefined, null, "GB", {}, [null], [""], ["GBR"], ["g"], [7]]) assert.equal(C.mainCountry({ ...f, origin }), "US", JSON.stringify(origin));
  assert.equal(C.mainCountry(f), "US", "a record cached before 22/10/2026 has no `origin` key");
  assert.equal(C.mainCountry({ countries: ["GB", "US"], lang: "es" }), "MX", "and the language's home still works without it (Roma before the origin was known)");
  assert.equal(C.mainCountry({ countries: [], lang: "en" }), null);
  assert.equal(C.mainCountry({}), null);
  assert.equal(C.mainCountry(), null);
  assert.equal(C.mainCountry({ countries: ["GB", "US"], lang: "en", origin: ["XX9", "GB"] }), "GB", "junk entries are dropped, the rest counts");
});

// The TMDB facts of 22/10/2026, by id: producers, language, origin_country (what the cache holds after scripts/backfill-origin.js).
const FILMS = {
  46435: { title: "Topsy-Turvy", countries: ["GB", "US"], lang: "en", origin: ["GB"], main: "GB", label: "United Kingdom", regions: ["british"] },
  245700: { title: "Mr. Turner", countries: ["FR", "DE", "GB", "US"], lang: "en", origin: ["GB"], main: "GB", label: "United Kingdom", regions: ["british"] },
  4347: { title: "Atonement", countries: ["FR", "GB", "US"], lang: "en", origin: ["GB"], main: "GB", label: "United Kingdom", regions: ["british"] },
  11778: { title: "The Deer Hunter", countries: ["GB", "US"], lang: "en", origin: ["US"], main: "US", label: "United States", regions: [] },
  907: { title: "Doctor Zhivago", countries: ["IT", "GB", "US"], lang: "en", origin: ["GB", "US"], main: "US", label: "United States", regions: [] },
  11316: { title: "Macbeth", countries: ["GB", "US"], lang: "en", origin: ["US", "GB"], main: "US", label: "United States", regions: [] },
  267480: { title: "The Look of Silence", countries: ["DK", "FI", "ID", "NO", "GB", "US"], lang: "en", origin: ["DK", "GB"], main: "DK", label: "Denmark", regions: ["nordic"] },
  49982: { title: "A City of Sadness", countries: ["HK", "TW"], lang: "zh", origin: ["TW"], main: "TW", label: "Taiwan", regions: ["asia"] },
  25905: { title: "The Shop on Main Street", countries: ["XC"], lang: "sk", origin: ["XC"], main: "XC", label: "Czechoslovakia", regions: ["eastern-bloc"] },
  // the films Marco named on 13/10 and 14/10/2026 whose region the origin changes (listed in BACKLOG.md for his answer; the rule was applied as he decided it, with no exception)
  426426: { title: "Roma", countries: ["GB", "US"], lang: "es", origin: ["US"], main: "US", label: "United States", regions: [], was: "MX" },
  566213: { title: "Honeyland", countries: ["MK"], lang: "tr", origin: ["MK"], main: "MK", label: "North Macedonia", regions: ["eastern-bloc"], was: "TR" },
  889699: { title: "Holy Spider", countries: ["DK", "JO", "FR", "DE", "SE"], lang: "fa", origin: ["DK"], main: "DK", label: "Denmark", regions: ["nordic"], was: "IR" },
  600583: { title: "The Power of the Dog", countries: ["AU", "CA", "NZ", "GB"], lang: "en", origin: ["AU"], main: "AU", label: "Australia", regions: [], was: "GB" },
  42241: { title: "Sebastiane", countries: ["IT", "GB"], lang: "la", origin: ["GB"], main: "GB", label: "United Kingdom", regions: ["british"], was: "IT" },
};

test("named films (TMDB of 22/10/2026): the main country and the region", () => {
  for (const [id, f] of Object.entries(FILMS)) {
    assert.equal(C.mainCountry(f), f.main, `${f.title} (${id})`);
    assert.deepEqual(regionsOfIso(C.mainCountry(f)), f.regions, `${f.title}: region`);
    if (f.was) assert.equal(C.mainIso(f), f.was, `${f.title}: what the rule of 14/10/2026 said`);
  }
  assert.equal(C.mainIso(FILMS[46435]), "US", "Topsy-Turvy was American for the region and British on the card");
});

test("card and region: the first name on the card IS the main country, and the region is that country's (they never disagree)", () => {
  for (const [id, f] of Object.entries(FILMS)) {
    const card = P.cardFacts(f).countries;
    assert.equal(card[0], f.label, `${f.title} (${id}): line 1 of the card`);
    assert.equal(card[0], P.countryLabel(C.mainCountry(f)), `${f.title}: the label of the main country`);
    for (const region of REG()) assert.equal(passes({ film: f }, { region }), f.regions.includes(region), `${f.title} in ${region}`);
    assert.equal(passes({ film: f }, { countries: [f.main] }), true, `${f.title}: where.countries reads the same country`);
  }
});

test("card and region over a grid of films: same country whatever the language, the producers and the origin", () => {
  const producers = [[], ["GB"], ["US", "GB"], ["GB", "US"], ["FR", "IT"], ["MK"], ["SU", "US"], ["DK", "JO", "FR"], ["XG"], ["HK", "TW"]];
  const origins = [undefined, [], ["GB"], ["US"], ["FR"], ["US", "GB"], ["GB", "US", "FR"], ["TW"], ["SU"], ["XC", "SK"]];
  let n = 0;
  for (const countries of producers) for (const lang of ["en", "es", "fr", "zh", "tr", "la", "xx", undefined]) for (const origin of origins) {
    const f = { countries, lang, origin };
    const main = C.mainCountry(f);
    const first = P.cardFacts(f, ["Japan"]).countries[0];
    assert.equal(first, main ? P.countryLabel(main) : "Japan", JSON.stringify(f)); // no country at all: the Letterboxd page's, as before
    if (main) for (const region of REG()) assert.equal(passes({ film: f }, { region }), C.inRegion(main, region), `${JSON.stringify(f)} in ${region}`);
    else assert.equal(passes({ film: f }, { region: "british" }), false);
    n++;
  }
  assert.equal(n, 10 * 8 * 10);
});

test("the card: a main country that is not a producer goes in front (Roma before the origin was known: Mexico), and the producers follow, two names at most", () => {
  assert.deepEqual(P.cardFacts({ countries: ["GB", "US"], lang: "es" }).countries, ["Mexico", "United Kingdom"]);
  assert.deepEqual(P.cardFacts({ countries: ["GB", "US"], lang: "en", origin: ["GB"] }).countries, ["United Kingdom", "United States"]);
  assert.deepEqual(P.cardFacts({ countries: ["US", "GB"], lang: "en", origin: ["GB"] }).countries, ["United Kingdom", "United States"], "the main one is moved, not repeated");
  assert.deepEqual(P.cardFacts({ countries: ["DE", "FR", "IT"], lang: "de", origin: ["IT"] }).countries, ["Italy", "Germany"]);
  assert.deepEqual(P.cardFacts({ countries: [], origin: ["GB"] }, ["USA"]).countries, ["United Kingdom"], "no producer, an origin: the origin, and not the Letterboxd page");
  assert.deepEqual(P.cardFacts({ countries: [], origin: [] }, ["USA", "Japan"]).countries, ["United States", "Japan"], "neither: the Letterboxd page, as before");
  assert.deepEqual(P.cardFacts(null, ["USA"]).countries, ["United States"]);
});

test("passes: the Board's regions and `countries` read the main country, origin first", () => {
  const topsy = FILMS[46435];
  assert.equal(passes({ film: topsy }, { region: "british" }), true);
  assert.equal(passes({ film: { ...topsy, origin: undefined } }, { region: "british" }), false, "without the origin the old rule puts it in no region (American)");
  assert.equal(passes({ film: topsy }, { countries: ["GB", "IE"] }), true);
  assert.equal(passes({ film: topsy }, { countries: ["US"] }), false);
  assert.equal(passes({ film: topsy }, { region: "british", countries: ["IE"] }), false);
  assert.equal(passes({ film: { countries: [], lang: "en", origin: [] } }, { region: "british" }), false, "no country at all fails the condition that asks for one");
});

test("trim keeps origin: TMDB's origin_country, right after countries; [] when the answer has none", () => {
  const d = { id: 7, title: "T", original_title: "T", release_date: "1999-09-09", production_countries: [{ iso_3166_1: "GB" }, { iso_3166_1: "US" }], origin_country: ["GB"], original_language: "en" };
  const out = trim(d);
  assert.deepEqual(out.origin, ["GB"]);
  assert.deepEqual(out.countries, ["GB", "US"]);
  const keys = Object.keys(out);
  assert.equal(keys.indexOf("origin"), keys.indexOf("countries") + 1, "the same place scripts/backfill-origin.js writes it");
  assert.deepEqual(trim({ ...d, origin_country: undefined }).origin, []);
  assert.deepEqual(trim({ ...d, origin_country: [] }).origin, []);
  assert.equal(C.mainCountry(out), "GB", "and the record trim() made is what mainCountry reads");
});

// ── scripts/backfill-origin.js ───────────────────────────────────────────────

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mood-origin-"));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const rec = (id, extra = {}) => ({ t: 1700000000000 + id, v: { id, imdb: `tt${id}`, title: `F${id}`, countries: ["GB", "US"], lang: "en", va: 7, ...extra } });
const quiet = () => { const lines = []; return { lines, log: (s) => lines.push(s) }; };

test("backfill-origin: writes only arrays of codes, right after `countries`, keeps everything else of the record and counts what it ignored", () => {
  const dir = tmp();
  try {
    const cacheFile = path.join(dir, "tmdb.json"), from = path.join(dir, "origin.json");
    const cache = { movie: { 1: rec(1), 2: rec(2), 3: { t: 5, v: null }, 4: rec(4, { origin: ["XX"] }), 5: rec(5) }, find: { tt1: { t: 1, v: 1 } }, recs: {}, person: {}, search: {} };
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
    fs.writeFileSync(from, JSON.stringify({ 1: ["GB"], 2: [], 3: ["US"], 4: ["US", "GB"], 5: { http: 404 }, 6: ["FR"], 7: { err: "timeout" }, 8: "GB", 9: ["gb"], 10: [1] }));
    const q = quiet();
    const r = B.main(["--from", from, "--cache", cacheFile], q);
    assert.equal(r.code, 0);
    assert.deepEqual([r.received, r.changed, r.unchanged], [3, 3, 0], "ids 1, 2 and 4");
    assert.deepEqual(r.ignored, { notAnArray: 5, notInCache: 1, emptyRecord: 1 }, "not arrays of codes: 5 {http}, 7 {err}, 8 a string, 9 lower case, 10 a number; 6 is not in the cache; 3 is an empty record");
    assert.match(q.lines[0], /received 3 .*ignored 7/);
    const out = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    assert.deepEqual(out.movie[1].v.origin, ["GB"]);
    assert.deepEqual(out.movie[2].v.origin, [], "an empty answer is an answer: asked, no origin");
    assert.deepEqual(out.movie[4].v.origin, ["US", "GB"], "an old value is replaced");
    assert.equal("origin" in out.movie[5].v, false, "a failed ask writes nothing");
    assert.equal(out.movie[3].v, null);
    for (const id of [1, 2, 4]) { const k = Object.keys(out.movie[id].v); assert.equal(k[k.indexOf("countries") + 1], "origin", `${id}: right after countries`); assert.equal(k.filter((x) => x === "origin").length, 1); }
    assert.deepEqual({ ...out.movie[1].v, origin: undefined }, { ...cache.movie[1].v, origin: undefined }, "the rest of the record is the same");
    assert.equal(out.movie[1].t, cache.movie[1].t, "its date stays: the cache does not look newer than it is");
    assert.deepEqual(Object.keys(out.movie), Object.keys(cache.movie), "same records, same order");
    assert.deepEqual(out.find, cache.find);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["origin.json", "tmdb.json"], "no temporary file left");
  } finally { rm(dir); }
});

test("backfill-origin: running it again changes nothing (not even the bytes); --dry-run writes nothing", () => {
  const dir = tmp();
  try {
    const cacheFile = path.join(dir, "tmdb.json"), from = path.join(dir, "origin.json");
    fs.writeFileSync(cacheFile, JSON.stringify({ movie: { 1: rec(1), 2: rec(2) } }));
    fs.writeFileSync(from, JSON.stringify({ 1: ["GB"], 2: ["US", "GB"] }));
    const before = fs.readFileSync(cacheFile, "utf8");
    const dry = B.main(["--from", from, "--cache", cacheFile, "--dry-run"], quiet());
    assert.deepEqual([dry.code, dry.received, dry.changed], [0, 2, 2]);
    assert.equal(fs.readFileSync(cacheFile, "utf8"), before, "dry run: untouched");
    B.main(["--from", from, "--cache", cacheFile], quiet());
    const once = fs.readFileSync(cacheFile, "utf8");
    assert.notEqual(once, before);
    const again = B.main(["--from", from, "--cache", cacheFile], quiet());
    assert.deepEqual([again.received, again.changed, again.unchanged], [2, 0, 2]);
    assert.equal(fs.readFileSync(cacheFile, "utf8"), once, "the second run leaves the bytes as they were");
  } finally { rm(dir); }
});

test("backfill-origin: a bad call is exit 2 and writes nothing; no network is ever used", () => {
  const dir = tmp();
  try {
    const cacheFile = path.join(dir, "tmdb.json"), from = path.join(dir, "origin.json");
    fs.writeFileSync(cacheFile, JSON.stringify({ movie: { 1: rec(1) } }));
    for (const argv of [[], ["--from"], ["--from", path.join(dir, "missing.json"), "--cache", cacheFile], ["--from", from, "--nope"], ["--from", from, "--cache", path.join(dir, "missing.json")]]) {
      const q = quiet();
      fs.writeFileSync(from, JSON.stringify({ 1: ["GB"] }));
      assert.equal(B.main(argv, q).code, 2, JSON.stringify(argv));
      assert.match(q.lines[0], /^✖ /);
    }
    fs.writeFileSync(from, "[1,2]");
    assert.equal(B.main(["--from", from, "--cache", cacheFile], quiet()).code, 2, "an array is no answer file");
    fs.writeFileSync(from, "{nope");
    assert.equal(B.main(["--from", from, "--cache", cacheFile], quiet()).code, 2);
    assert.equal(JSON.parse(fs.readFileSync(cacheFile, "utf8")).movie[1].v.origin, undefined);
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "backfill-origin.js"), "utf8");
    assert.ok(!/fetch|http|require\("\.\.\/lib\//.test(src.replace(/^\/\/.*$/gm, "")), "the script asks nobody: no fetch, no URL, no client of lib/");
  } finally { rm(dir); }
});

// ── review of 22/10/2026 ─────────────────────────────────────────────────────

test("review B8: XI (Northern Ireland, the code TMDB keeps for it) has a name on the card and is British, as GB and IE are", () => {
  assert.deepEqual(P.cardFacts({ countries: ["US", "XI"], lang: "en", origin: ["XI"] }).countries, ["Northern Ireland", "United States"], "The Lost City of Z listed 'XI' on the card");
  assert.equal(C.mainCountry({ countries: ["XI"], lang: "en" }), "XI");
  assert.deepEqual(regionsOfIso("XI"), ["british"]);
  assert.equal(passes({ film: { countries: ["US", "XI"], lang: "en", origin: ["XI"] } }, { region: "british" }), true);
  assert.deepEqual(regionsOfIso("GB"), ["british"]);
  assert.equal(P.countryLabel("XI"), "Northern Ireland");
});

test("review B6: trim keeps EVERY origin TMDB lists, in its order (Doctor Zhivago: GB then US), and mainCountry accepts null and a bare list", () => {
  const d = { id: 907, title: "Doctor Zhivago", release_date: "1965-12-22", production_countries: [{ iso_3166_1: "IT" }, { iso_3166_1: "GB" }, { iso_3166_1: "US" }], origin_country: ["GB", "US"], original_language: "en" };
  assert.deepEqual(trim(d).origin, ["GB", "US"], "a mutation cutting it to the first one (slice(0, 1)) is red here");
  assert.equal(C.mainCountry(trim(d)), "US");
  assert.equal(C.mainCountry(null), null);
  assert.equal(C.mainCountry(undefined), null);
});

test("review B6: backfill-origin replaces a value of the SAME length (the comparison is by content, not by size) and writes a record that has no `countries` at the end", () => {
  const dir = tmp();
  try {
    const cacheFile = path.join(dir, "tmdb.json"), from = path.join(dir, "origin.json");
    const bare = { t: 9, v: { id: 3, imdb: "tt3", title: "No countries", lang: "en" } };
    fs.writeFileSync(cacheFile, JSON.stringify({ movie: { 1: rec(1, { origin: ["GB", "US"] }), 3: bare } }));
    fs.writeFileSync(from, JSON.stringify({ 1: ["US", "GB"], 3: ["FR"] }));
    const r = B.main(["--from", from, "--cache", cacheFile], quiet());
    assert.deepEqual([r.received, r.changed, r.unchanged], [2, 2, 0], "[GB, US] → [US, GB] is a change: same size, other content");
    const out = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    assert.deepEqual(out.movie[1].v.origin, ["US", "GB"]);
    assert.deepEqual(out.movie[3].v.origin, ["FR"], "a record without `countries` still gets its origin");
    assert.deepEqual(Object.keys(out.movie[3].v), [...Object.keys(bare.v), "origin"], "at the end, nothing else moves");
  } finally { rm(dir); }
});

// Review of 22/10/2026 (M4): cache/tmdb.json is ONE line and the nightly on the Mac commits it to the main, so a merge that "keeps the main's cache" would erase the 11,740 `origin` keys of
// commit 818e200 and nothing else would turn red. The procedure to restore them is the header of scripts/backfill-origin.js (drop that commit, run the script over the main's cache).
test("the committed cache carries origin: Topsy-Turvy (46435) has [GB] and at least 11,000 records have the key (a merge that kept the main's cache without it is red here: see the header of scripts/backfill-origin.js)", () => {
  const cache = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cache", "tmdb.json"), "utf8"));
  assert.deepEqual(cache.movie[46435].v.origin, ["GB"], "46435 Topsy-Turvy: TMDB's origin_country, written by scripts/backfill-origin.js");
  const n = Object.values(cache.movie).filter((e) => e && e.v && Array.isArray(e.v.origin)).length;
  assert.ok(n >= 11000, `${n} records carry origin; the backfill of 22/10/2026 wrote 11,740: run scripts/backfill-origin.js again over this cache (header of the script)`);
});

// ── 23/10/2026: the director's country, the first layer (Marco, questionnaire, the recommended option) ─────────────────────────────────────────────────
// "Cidadania do diretor quando o filme é produzido no país dela ou falado na língua dela (fora inglês); senão origem do TMDB". And: "Bandeira passa a seguir o país do cartão já".
// Mutations this part is meant to turn red: the director's layer ignored; the dual citizenship in the wrong order; the guard for Hong Kong and Taiwan removed; the flag back on pickCountry;
// the director taken from the last director and not the first with data; an English film taken by a director whose country is not a producer.

const dirs = (o) => new Map(Object.entries(o));
const D = (ids) => ids.map((id) => ({ id }));
const nat = (film, map) => C.mainCountry(film, undefined, undefined, dirs(map));

test("director: produced in her country, or spoken in her language (not English); otherwise TMDB's origin", () => {
  // Roma: GB + US producers, Spanish, by the Mexican Cuarón: the language is spoken in Mexico
  assert.equal(nat({ countries: ["GB", "US"], lang: "es", origin: ["US"], directors: D([11218]) }, { 11218: ["MX"] }), "MX");
  // Holy Spider: Persian, by the Iranian-Danish Abbasi (IR first): Iran speaks Persian; Denmark is a producer but the language rule comes first
  assert.equal(nat({ countries: ["DK", "JO", "FR", "DE", "SE"], lang: "fa", origin: ["DK"], directors: D([1574550]) }, { 1574550: ["IR", "DK"] }), "IR");
  // Jeanne Dielman: BE and FR producers, French: Belgium (a producer and, of the two, the first that speaks French AND produces)
  assert.equal(nat({ countries: ["BE", "FR"], lang: "fr", origin: ["FR"], directors: D([130030]) }, { 130030: ["BE", "FR"] }), "BE");
  // Brokeback Mountain: English, a Taiwanese citizen, CA + US producers: his country is no producer and English is no reason: the origin
  assert.equal(nat({ countries: ["CA", "US"], lang: "en", origin: ["US"], directors: D([1614]) }, { 1614: ["TW"] }), "US");
  // English, the director's country IS a producer: the director decides only when TMDB's origin names several countries or none (Marco, 14/11/2026, "Database country wins when it lists only one").
  // The Power of the Dog (origin AU alone, by the New Zealander Campion, NZ a producer) was NZ until then and is AU now; with an origin of two it is still the director's
  assert.equal(nat({ countries: ["AU", "CA", "NZ", "GB"], lang: "en", origin: ["AU"], directors: D([10757]) }, { 10757: ["NZ"] }), "AU");
  assert.equal(nat({ countries: ["AU", "CA", "NZ", "GB"], lang: "en", origin: ["AU", "NZ"], directors: D([10757]) }, { 10757: ["NZ"] }), "NZ");
  assert.equal(nat({ countries: ["AU", "CA", "NZ", "GB"], lang: "en", origin: [], directors: D([10757]) }, { 10757: ["NZ"] }), "NZ", "no origin: the director, as before");
  // no language known ("xx", null): only a producer counts
  assert.equal(nat({ countries: ["FR"], lang: "xx", origin: ["FR"], directors: D([1]) }, { 1: ["JP"] }), "FR");
  assert.equal(nat({ countries: ["FR", "JP"], lang: null, origin: ["FR"], directors: D([1]) }, { 1: ["JP"] }), "JP");
  // Georgian, produced by the Soviet Union (SU): Georgia, where it is spoken (a Georgian director of a Soviet film: the swap SU → GE is the risk Marco accepted)
  assert.equal(nat({ countries: ["SU"], lang: "ka", origin: ["SU"], directors: D([934994]) }, { 934994: ["GE", "SU"] }), "GE");
  assert.equal(nat({ countries: ["SU"], lang: "ru", origin: ["SU"], directors: D([5]) }, { 5: ["RU"] }), "RU");
  // the old states count as the language of their successor (the flag table: SU speaks Russian, XC Czech)
  assert.equal(nat({ countries: [], lang: "ru", origin: [], directors: D([5]) }, { 5: ["SU"] }), "SU");
  assert.equal(nat({ countries: ["FR"], lang: "cs", origin: ["FR"], directors: D([5]) }, { 5: ["XC"] }), "XC");
  assert.equal(nat({ countries: ["FR"], lang: "en", origin: ["FR"], directors: D([5]) }, { 5: ["SU"] }), "FR", "and not in English");
});

test("mainCountryWhy names who decided: the director (Wikidata), TMDB's origin, or the rule of 14/10/2026", () => {
  const m = dirs({ 11218: ["MX"] });
  const why = (film) => C.mainCountryWhy(film, undefined, undefined, m);
  assert.deepEqual(why({ countries: ["GB", "US"], lang: "es", origin: ["US"], directors: D([11218]) }), { iso: "MX", from: "director" });
  assert.deepEqual(why({ countries: ["GB", "US"], lang: "en", origin: ["GB"], directors: D([9]) }), { iso: "GB", from: "origin" });
  assert.deepEqual(why({ countries: ["GB", "US"], lang: "en", origin: ["GB", "US"] }), { iso: "US", from: "rule" }, "two origins and the rule's answer among them");
  assert.deepEqual(why({ countries: ["GB", "US"], lang: "en", origin: ["FR", "DE"] }), { iso: "FR", from: "origin" });
  assert.deepEqual(why({ countries: ["GB", "US"], lang: "en" }), { iso: "US", from: "rule" });
  assert.deepEqual(why({}), { iso: null, from: "rule" });
});

test("director: no citizenship on file, an unknown director or no director passes to the origin rule", () => {
  const film = { countries: ["GB", "US"], lang: "es", origin: ["US"] };
  assert.equal(nat({ ...film, directors: D([9]) }, { 11218: ["MX"] }), "US", "the director is not in the map");
  assert.equal(nat({ ...film, directors: [] }, { 11218: ["MX"] }), "US");
  assert.equal(nat({ ...film }, { 11218: ["MX"] }), "US", "a record with no `directors` key");
  assert.equal(nat({ ...film, directors: D([11218]) }, { 11218: [] }), "US", "an empty citizenship");
  assert.equal(C.mainCountry({ ...film, directors: D([11218]) }), "US", "with no registry loaded (a test, a tool) the ids of a fixture never meet a real person's");
  // the FIRST director that has a citizenship decides (the first director may have none)
  assert.equal(nat({ ...film, directors: D([9, 11218, 12]) }, { 11218: ["MX"], 12: ["ES"] }), "MX");
  assert.equal(nat({ ...film, directors: D([11218, 12]) }, { 11218: ["MX"], 12: ["ES"] }), "MX", "and not the last");
});

test("director with two citizenships: those whose country speaks the film's language (not English), the producer among them first; else the producer; else the first", () => {
  const f = (lang, countries, extra = {}) => ({ countries, lang, origin: [], directors: D([1]), ...extra });
  assert.equal(nat(f("fr", ["FR", "US"]), { 1: ["US", "FR"] }), "FR", "French: FR speaks it and is a producer");
  assert.equal(nat(f("fr", ["US", "CA"]), { 1: ["US", "FR"] }), "FR", "French: FR speaks it, no producer does: FR, because her country speaks the language");
  assert.equal(nat(f("fr", ["US"]), { 1: ["BE", "FR"] }), "BE", "two that speak it and no producer: the first");
  assert.equal(nat(f("fr", ["FR", "BE"]), { 1: ["BE", "FR"] }), "BE", "both are producers: the first of them");
  assert.equal(nat(f("fr", ["FR", "BE"]), { 1: ["CA", "FR", "BE"] }), "FR", "the first that speaks it and produces (CA speaks French too, but does not produce)");
  assert.equal(nat(f("en", ["GB"]), { 1: ["US", "GB"] }), "GB", "English: the producer, even when it is second");
  assert.equal(nat(f("en", ["FR"]), { 1: ["US", "GB"] }), "FR", "English, neither a producer: the origin rule (the old rule: the first producer)");
  assert.equal(nat(f("ja", ["GB"]), { 1: ["US", "GB"] }), "GB", "Japanese, neither speaks it: the producer");
  assert.equal(nat(f("ja", ["GB", "JP"]), { 1: ["GB", "JP"] }), "JP", "Japanese: the one that speaks it, though GB produces and is first");
});

test("guard: a Chinese director of a film made by Hong Kong or Taiwan alone does not take it (Hong Kong stays Hong Kong)", () => {
  const base = { lang: "zh", origin: ["HK"], directors: D([1]) };
  assert.equal(nat({ ...base, countries: ["HK"] }, { 1: ["CN"] }), "HK", "Chinese is spoken in CN, but the film is HK's");
  assert.equal(nat({ ...base, countries: ["TW"], origin: ["TW"] }, { 1: ["CN"] }), "TW");
  assert.equal(nat({ ...base, countries: ["HK", "CN"] }, { 1: ["CN"] }), "CN", "CN among the producers: the guard does not apply");
  assert.equal(nat({ ...base, countries: ["FR"], origin: ["FR"] }, { 1: ["CN"] }), "CN", "no HK or TW: a Chinese director of a film in Chinese is Chinese");
  assert.equal(nat({ ...base, countries: ["HK"] }, { 1: ["HK"] }), "HK", "Hard Boiled: a Hong Kong citizen");
});

test("the card, the region and the flag are the same country for named films (facts frozen as TMDB and Wikidata answered on 22/10/2026)", () => {
  const FILMS = [
    ["Roma", { countries: ["GB", "US"], lang: "es", origin: ["US"], directors: D([11218]) }, { 11218: ["MX"] }, "MX", "Mexico", ["latin-america"]],
    ["Holy Spider", { countries: ["DK", "JO", "FR", "DE", "SE"], lang: "fa", origin: ["DK"], directors: D([1574550]) }, { 1574550: ["IR", "DK"] }, "IR", "Iran", ["middle-east"]],
    ["Jeanne Dielman", { countries: ["BE", "FR"], lang: "fr", origin: ["FR"], directors: D([130030]) }, { 130030: ["BE", "FR"] }, "BE", "Belgium", ["europe"]],
    ["A City of Sadness", { countries: ["HK", "TW"], lang: "zh", origin: ["TW"], directors: D([64992]) }, { 64992: ["TW"] }, "TW", "Taiwan", ["asia"]],
    ["Topsy-Turvy", { countries: ["GB", "US"], lang: "en", origin: ["GB"], directors: D([65452]) }, { 65452: ["GB"] }, "GB", "United Kingdom", ["british"]],
    ["Brokeback Mountain", { countries: ["CA", "US"], lang: "en", origin: ["US"], directors: D([1614]) }, { 1614: ["TW"] }, "US", "United States", []],
    ["Amour", { countries: ["FR", "DE", "AT"], lang: "fr", origin: ["FR"], directors: D([6011]) }, { 6011: ["AT"] }, "AT", "Austria", ["europe"]],
    ["The Pianist", { countries: ["FR", "DE", "PL", "GB"], lang: "en", origin: ["GB", "FR", "DE"], directors: D([3556]) }, { 3556: ["PL", "FR"] }, "PL", "Poland", ["eastern-bloc"]],
    ["Memories of Underdevelopment", { countries: ["CU"], lang: "es", origin: ["ES"], directors: D([72646]) }, { 72646: ["CU"] }, "CU", "Cuba", ["latin-america"]],
    ["The Power of the Dog", { countries: ["AU", "CA", "NZ", "GB"], lang: "en", origin: ["AU"], directors: D([10757]) }, { 10757: ["NZ"] }, "AU", "Australia", []], // NZ until 14/11/2026: in English a single origin wins
    ["Manakamana", { countries: ["NP", "US"], lang: "ne", origin: ["NE"], directors: D([1, 2]) }, {}, "NE", "Niger", ["africa"]], // no citizenship on file: the origin, which is not a producer (BACKLOG, 109 films)
  ];
  const prev = C.setDirectors(new Map(FILMS.flatMap(([, , m]) => Object.entries(m))));
  try {
    const targets = new Map(FILMS.map(([name], i) => [name, { tt: name, i }]));
    C.attachCountries(targets, {
      tmdbCountries: (t) => FILMS[t.i][1].countries, lbCountries: () => [], language: (t) => FILMS[t.i][1].lang, tmdbOrigin: (t) => FILMS[t.i][1].origin, directors: (t) => FILMS[t.i][1].directors,
    });
    for (const [name, film, , iso, label, regions] of FILMS) {
      assert.equal(C.mainCountry(film), iso, `${name}: the main country`);
      assert.equal(P.cardFacts(film).countries[0], label, `${name}: the card`);
      assert.deepEqual(regionsOfIso(C.mainCountry(film)), regions, `${name}: the region`);
      for (const region of REG()) assert.equal(passes({ film }, { region }), regions.includes(region), `${name} in ${region}`);
      assert.equal(targets.get(name).cc, C.flagOfCode(iso), `${name}: the flag is the main country's (${iso})`);
    }
  } finally { C.setDirectors(prev); }
});

test("the flag keeps the v2.3 step name when its flag does not change (a cover whose flag is the same is not drawn again), and says `main` when the main country changed it", () => {
  const prev = C.setDirectors(new Map([["1", ["MX"]]]));
  try {
    const t = new Map([["same", { tt: "same", f: { countries: ["FR", "IT"], lang: "it" } }], ["moved", { tt: "moved", f: { countries: ["GB", "US"], lang: "es", origin: ["US"], directors: D([1]) } }], ["lb", { tt: "lb", f: { countries: [], lang: null } }]]);
    const n = C.attachCountries(t, { tmdbCountries: (x) => x.f.countries, lbCountries: (x) => (x.tt === "lb" ? ["Japan"] : []), language: (x) => x.f.lang, tmdbOrigin: (x) => x.f.origin, directors: (x) => x.f.directors || [] });
    assert.deepEqual([t.get("same").cc, t.get("same").ccFrom], ["it", "language"], "I Vitelloni: Italy by the v2.3 rule and by the main country: the step name is the old one");
    assert.deepEqual([t.get("moved").cc, t.get("moved").ccFrom], ["mx", "main"], "Roma: the v2.3 rule said us (Spanish with no Spanish-speaking producer), the director says Mexico");
    assert.deepEqual([t.get("lb").cc, t.get("lb").ccFrom], ["jp", "letterboxd"], "a film TMDB does not know: the Letterboxd page, as before");
    assert.deepEqual([n.main, n.language, n.letterboxd], [1, 1, 1]);
  } finally { C.setDirectors(prev); }
});

// ── cache/directors.json and lib/directors.js ────────────────────────────────

test("directors: the labels of historic countries and Wikidata's codes become TMDB's codes; junk is dropped; the order is kept without repeats", () => {
  assert.deepEqual(DR.citizenshipOf([{ label: "Mexico", iso: "MX" }, { label: "Spain", iso: "es" }, { label: "Mexico", iso: "MX" }]), ["MX", "ES"]);
  assert.deepEqual(DR.citizenshipOf([{ label: "East Germany", iso: "DD" }]), ["XG"], "TMDB writes XG for East Germany, Wikidata DD");
  assert.deepEqual(DR.citizenshipOf([{ label: "Soviet Union", iso: null }, { label: "Czechoslovakia" }, { label: "Kingdom of Serbs, Croats and Slovenes" }, { label: "Austria–Hungary" }]), ["SU", "XC", "YU", "AT"]);
  assert.deepEqual(DR.citizenshipOf([{ label: "Miguel" }, { label: "statelessness" }, { label: "Arabic", iso: "" }, { label: "X", iso: "ABC" }, null]), []);
  assert.deepEqual(DR.citizenshipOf(undefined), []);
  assert.deepEqual([...DR.citizenshipMap({ 1: { cit: ["MX"], t: 1 }, 2: { cit: [], t: 1 }, 3: { t: 1 }, 4: null, 5: { cit: ["us", "FR"], t: 1 } })], [["1", ["MX"]], ["5", ["FR"]]], "only the people that have one; a lower-case code is not one");
});

test("directors: who is asked — the ones never asked, and a person with no citizenship again after 30 days; a person with one never again", () => {
  const day = 24 * 3600 * 1000, now = Date.parse("2026-10-23T12:00:00Z");
  const cache = { 1: { cit: ["MX"], t: now - 400 * day }, 2: { cit: [], t: now - 29 * day }, 3: { cit: [], t: now - 31 * day }, 4: { t: now } };
  assert.deepEqual(DR.toAsk(cache, ["1", "2", "3", "4", "5"], now), ["3", "4", "5"]);
  const tm = { movie: { 1: { v: { directors: [{ id: 20, name: "a" }, { id: 10, name: "b" }] } }, 2: { v: null }, 3: { v: { directors: [{ id: 10 }, { id: "x" }, { id: -1 }, null] } }, 4: null } };
  assert.deepEqual(DR.directorIds(tm), ["10", "20"], "the directors of the TMDB records, once each, in numeric order");
});

const sparql = (rows) => ({ ok: true, status: 200, text: async () => JSON.stringify({ results: { bindings: rows } }), body: null });
const row = (id, label, iso) => ({ tmdb: { value: String(id) }, ...(label ? { country: { value: "http://www.wikidata.org/entity/Q1" }, countryLabel: { value: label } } : {}), ...(iso ? { iso: { value: iso } } : {}) });

test("directors: refresh asks only what is missing, in batches of 120 with the pause between them and our own User-Agent; the answers are written; a person Wikidata does not know is written with no citizenship", async () => {
  const calls = [], pauses = [];
  const ids = Array.from({ length: 250 }, (_, i) => String(i + 1));
  const fetchImpl = async (url, init) => {
    calls.push({ url, ua: init.headers["User-Agent"] });
    const asked = [...decodeURIComponent(url).matchAll(/"(\d+)"/g)].map((m) => m[1]);
    return sparql(asked.filter((id) => id !== "7").map((id) => row(id, "Mexico", "MX")).concat([row(2, "Spain", "ES")]));
  };
  const cache = { 1: { cit: ["FR"], t: 5 } };
  const r = await DR.refresh(cache, ids, { fetchImpl, sleepImpl: async (ms) => pauses.push(ms), now: 1000 });
  assert.equal(calls.length, 3, "249 people in batches of 120, 120 and 9");
  assert.deepEqual(pauses, [400, 400], "400 ms between the batches, none after the last");
  assert.ok(calls.every((c) => /^mood-engine\//.test(c.ua) && /Stremio/.test(c.ua) && c.url.startsWith("https://query.wikidata.org/sparql?")), "an identified client, the public endpoint");
  assert.deepEqual([r.wanted, r.asked, r.answered, r.failedBatches], [249, 249, 249, 0]);
  assert.deepEqual(cache[1], { cit: ["FR"], t: 5 }, "a person with a citizenship is not asked, not touched");
  assert.deepEqual(cache[2], { cit: ["MX", "ES"], t: 1000 });
  assert.deepEqual(cache[7], { cit: [], t: 1000 }, "Wikidata does not know the person: written empty, asked again in 30 days");
  const day = 24 * 3600 * 1000;
  const again = await DR.refresh(cache, ids, { fetchImpl: async () => assert.fail("nothing is asked again before the 30 days"), sleepImpl: async () => {}, now: 1000 + day });
  assert.equal(again.wanted, 0);
  const later = [];
  const third = await DR.refresh(cache, ids, { fetchImpl: async (u) => (later.push(u), sparql([row(7, "Japan", "JP")])), sleepImpl: async () => {}, now: 1000 + 31 * day });
  assert.deepEqual([third.wanted, later.length, cache[7].cit], [1, 1, ["JP"]], "30 days later the one with none is asked again, and now it has one");
});

test("directors: a query that fails writes nothing and does not throw; three in a row stop the asking; offline asks nothing", async () => {
  const ids = Array.from({ length: 1000 }, (_, i) => String(i + 1));
  const lines = [];
  let n = 0;
  const cache = {};
  const r = await DR.refresh(cache, ids, { fetchImpl: async () => { n++; throw new Error("fetch failed"); }, sleepImpl: async () => {}, log: (l) => lines.push(l) });
  assert.deepEqual([r.failedBatches, r.stopped, r.answered, n], [3, true, 0, 3], "three failed batches and no fourth");
  assert.deepEqual(cache, {}, "the directors stay unknown: nothing was written");
  assert.ok(lines.some((l) => /stay unknown tonight/.test(l)) && lines.some((l) => /3 batches failed in a row/.test(l)));
  // a bad status and a bad body are failures too; one good batch between two bad ones resets the streak
  const byId = {
    1: () => ({ ok: false, status: 503, text: async () => "" }),
    250: () => sparql([row(250, "Peru", "PE")]),
    300: () => ({ ok: true, status: 200, text: async () => "<html>" }),
    999: () => sparql([row(999, "Chile", "CL")]),
  };
  const c2 = {};
  const r2 = await DR.refresh(c2, ["1", "250", "300", "999"], { batch: 1, fetchImpl: async (u) => byId[/"(\d+)"/.exec(decodeURIComponent(u))[1]](), sleepImpl: async () => {} });
  assert.deepEqual([r2.failedBatches, r2.stopped, r2.answered, Object.keys(c2)], [2, false, 2, ["250", "999"]], "two failures with a good one between them do not reach three in a row");
  let asked = 0;
  const off = await DR.refresh({}, ["1", "2"], { offline: true, fetchImpl: async () => { asked++; return sparql([]); }, sleepImpl: async () => {} });
  assert.deepEqual([off.wanted, off.asked, asked], [2, 0, 0], "offline: the request is never made");
});

test("directors: the request goes through the limits of lib/util.js (site `wikidata`): a body past the cap is refused", async () => {
  const { LIMITS } = require("../lib/util");
  assert.ok(LIMITS.wikidata.timeoutMs > 0 && LIMITS.wikidata.maxBytes > 0);
  const was = LIMITS.wikidata.maxBytes;
  LIMITS.wikidata.maxBytes = 50;
  try {
    const big = { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x".repeat(500))); c.close(); } }) };
    await assert.rejects(DR.askBatch(["1"], { fetchImpl: async () => big, log: () => {} }), /limit hit wikidata/);
  } finally { LIMITS.wikidata.maxBytes = was; }
});

test("directors: backfill from the answers of 22/10/2026 — arrays of {label, iso} become codes, `error` entries and junk keys are ignored, the second run changes nothing", () => {
  const cache = {};
  const answers = { 1: { found: true, cit: [{ label: "Mexico", iso: "MX" }] }, 2: { found: false, cit: [] }, 3: { error: "HTTP 500" }, x: { cit: [] }, 4: { found: true, cit: [{ label: "East Germany", iso: "DD" }] }, 5: null };
  const n = DR.backfill(cache, answers, 777);
  assert.deepEqual(n, { received: 3, changed: 3, unchanged: 0, withCitizenship: 2, ignored: 3 });
  assert.deepEqual(cache, { 1: { cit: ["MX"], t: 777 }, 2: { cit: [], t: 777 }, 4: { cit: ["XG"], t: 777 } });
  const again = DR.backfill(cache, answers, 999);
  assert.deepEqual([again.changed, again.unchanged], [0, 3]);
  assert.equal(cache[1].t, 777, "an entry the file confirms keeps its date");
  DR.backfill(cache, { 1: { cit: [{ label: "Spain", iso: "ES" }] } }, 999);
  assert.deepEqual(cache[1], { cit: ["MX"], t: 777 }, "a saved nonempty citizenship is frozen");
});

test("scripts/backfill-directors.js: writes the cache once, a second run leaves the bytes alone, --dry-run and a bad call write nothing", () => {
  const dir = tmp();
  try {
    const from = path.join(dir, "answers.json"), cacheFile = path.join(dir, "directors.json");
    fs.writeFileSync(from, JSON.stringify({ 11218: { found: true, cit: [{ label: "Mexico", iso: "MX" }] }, 1: { found: false, cit: [] }, 2: { error: "x" } }));
    const q = quiet();
    assert.equal(BD.main(["--from", from, "--cache", cacheFile, "--at", "2026-10-22", "--dry-run"], q).code, 0);
    assert.equal(fs.existsSync(cacheFile), false, "dry run: nothing written");
    const r = BD.main(["--from", from, "--cache", cacheFile, "--at", "2026-10-22"], q);
    assert.deepEqual([r.code, r.received, r.changed, r.ignored], [0, 2, 2, 1]);
    const once = fs.readFileSync(cacheFile, "utf8");
    assert.deepEqual(JSON.parse(once), { 1: { cit: [], t: 1792627200000 }, 11218: { cit: ["MX"], t: 1792627200000 } });
    BD.main(["--from", from, "--cache", cacheFile, "--at", "2026-10-22"], q);
    assert.equal(fs.readFileSync(cacheFile, "utf8"), once, "the second run: the same bytes");
    BD.main(["--from", from, "--cache", cacheFile, "--at", "2030-01-01"], q);
    assert.equal(fs.readFileSync(cacheFile, "utf8"), once, "even with another date: a confirmed entry keeps its own");
    for (const argv of [[], ["--from"], ["--from", path.join(dir, "nope.json")], ["--from", from, "--at", "yesterday"], ["--from", from, "--nope"]]) assert.equal(BD.main(argv, quiet()).code, 2, JSON.stringify(argv));
    fs.writeFileSync(from, "[1]");
    assert.equal(BD.main(["--from", from, "--cache", cacheFile], quiet()).code, 2);
    fs.writeFileSync(cacheFile, "[]");
    fs.writeFileSync(from, "{}");
    assert.equal(BD.main(["--from", from, "--cache", cacheFile], quiet()).code, 2, "a cache that is not an object is never overwritten blind");
  } finally { rm(dir); }
});

test("the committed caches carry origin and the directors' citizenship: Cuarón is Mexican, Roma reads Mexico (a merge that kept the main's cache without them is red here: see the headers of scripts/backfill-origin.js and scripts/backfill-directors.js)", () => {
  const cache = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cache", "directors.json"), "utf8"));
  const n = Object.values(cache).filter((e) => e && Array.isArray(e.cit) && e.cit.length).length;
  assert.ok(n >= 4500, `${n} directors with a citizenship; the backfill of 23/10/2026 wrote 4,980: run scripts/backfill-directors.js again (header of the script)`);
  assert.deepEqual(cache[11218].cit, ["MX"], "TMDB person 11218, Alfonso Cuarón");
  const tm = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cache", "tmdb.json"), "utf8"));
  const roma = tm.movie[426426].v;
  assert.equal(C.mainCountry(roma, undefined, undefined, DR.citizenshipMap(cache)), "MX");
  assert.equal(C.mainCountry(roma, undefined, undefined, new Map()), "US", "and without the director's layer it is what the origin says");
});

// Marco, 23/10/2026: "Fica como está hoje: Biutiful = México, The Pianist = Polônia, Jeanne Dielman = Bélgica". The order in which Wikidata answered is part of the data and nothing reorders it.
// This pins the order of three directors of the REAL committed file and what each order gives: reversing every list changes the country of 73 of 7,857 films (BACKLOG.md, 23/10/2026).
// Mutations: the map or the answers read in reverse order, `cit` sorted, `citizenshipOf` reversing → red.
test("the order of the citizenships in the committed cache is frozen: Polanski [PL, FR] makes The Pianist Poland, Akerman [BE, FR] Jeanne Dielman Belgium, and the reversed lists would not", () => {
  const cache = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cache", "directors.json"), "utf8"));
  const tm = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cache", "tmdb.json"), "utf8")).movie;
  assert.deepEqual(cache[3556].cit, ["PL", "FR"], "Roman Polanski");
  assert.deepEqual(cache[130030].cit, ["BE", "FR"], "Chantal Akerman");
  assert.deepEqual(cache[223].cit, ["ES", "MX"], "Alejandro G. Iñárritu: Wikidata's order of 22/10/2026, kept as it came (Biutiful reads Spain by it, and Marco said on 23/10/2026 that it stays Spain)");
  const map = DR.citizenshipMap(cache);
  assert.deepEqual(map.get("3556"), ["PL", "FR"], "the map keeps the order of the file");
  const reversed = new Map([...map].map(([id, list]) => [id, [...list].reverse()]));
  const at = (id, m) => C.mainCountry(tm[id].v, undefined, undefined, m);
  assert.equal(at(423, map), "PL", "The Pianist");
  assert.equal(at(44012, map), "BE", "Jeanne Dielman");
  assert.equal(at(423, reversed), "FR", "and with the lists reversed it would be France");
  assert.equal(at(44012, reversed), "FR");
  // a list received in some order is stored in that order, and asking for the same person again does not sort it
  const c = {};
  DR.backfill(c, { 1: { cit: [{ label: "Spain", iso: "ES" }, { label: "Mexico", iso: "MX" }] }, 2: { cit: [{ label: "Mexico", iso: "MX" }, { label: "Spain", iso: "ES" }] } }, 5);
  assert.deepEqual([c[1].cit, c[2].cit], [["ES", "MX"], ["MX", "ES"]], "no sorting, either way");
});

// Review of 23/10/2026 (seguranca): the house rule for Wikidata is to stop at 403 or 429 at once.
test("directors: HTTP 429 or 403 stops the asking at once — exactly one call, `stopped`, nothing written, the rest waits for the next night; other statuses are ordinary failures", async () => {
  for (const status of [429, 403]) {
    let calls = 0;
    const lines = [];
    const cache = {};
    const ids = Array.from({ length: 500 }, (_, i) => String(i + 1));
    const r = await DR.refresh(cache, ids, { fetchImpl: async () => { calls++; return { ok: false, status, text: async () => "", headers: { get: () => "30" } }; }, sleepImpl: async () => assert.fail("no pause, no second call"), log: (l) => lines.push(l) });
    assert.equal(calls, 1, `HTTP ${status}: one call and no more`);
    assert.deepEqual([r.stopped, r.asked, r.answered, r.failedBatches, cache], [true, 0, 0, 1, {}], `HTTP ${status}: stopped, nothing written`);
    assert.ok(lines.some((l) => new RegExp(`HTTP ${status}`).test(l) && /no more queries tonight/.test(l)), "and the log says so");
  }
  // a 500 is an ordinary failure: the next batch is still tried
  let calls = 0;
  const r = await DR.refresh({}, Array.from({ length: 300 }, (_, i) => String(i + 1)), { fetchImpl: async () => { calls++; return { ok: false, status: 500, text: async () => "" }; }, sleepImpl: async () => {} });
  assert.deepEqual([calls, r.stopped], [3, true], "500: three batches tried, stopped only by the streak of three");
  // after good batches a 429 stops the rest but keeps what was answered
  const cache = {};
  let n = 0;
  const r2 = await DR.refresh(cache, Array.from({ length: 360 }, (_, i) => String(i + 1)), { fetchImpl: async (u) => (++n < 3 ? sparql([row(1, "Mexico", "MX")]) : { ok: false, status: 429, text: async () => "" }), sleepImpl: async () => {} });
  assert.deepEqual([n, r2.stopped, r2.asked, Object.keys(cache).length], [3, true, 240, 240], "two batches answered and kept, the third answered 429: stop");
});

test("directors: queryFor refuses an id that is not only digits (it goes inside a quoted SPARQL literal)", () => {
  assert.throws(() => DR.queryFor(['1" } #']), /not a TMDB person id/);
  assert.throws(() => DR.queryFor(["1", "2 3"]), /not a TMDB person id/);
  assert.throws(() => DR.queryFor([""]), /not a TMDB person id/);
  assert.throws(() => DR.queryFor(["-1"]), /not a TMDB person id/);
  assert.throws(() => DR.queryFor([1.5]), /not a TMDB person id/);
  assert.match(DR.queryFor(["1", 223, "1574550"]), /VALUES \?tmdb \{ "1" "223" "1574550" \}/);
});

const originFixes = require("./origin-fix-assertions");
test("directors: historical identity wins over ambiguous ISO and inherited labels are never countries", () => originFixes.historical(DR));
test("directors: simulated inherited labels stay empty after JSON round trip and are eligible after 30 days", () => originFixes.emptyAnswers(DR));
test("directors: backfill freezes every nonempty entry including Polanski order, date and bytes; Pianist stays Poland", () => originFixes.frozenBackfill(DR, C));

test("scripts/backfill-directors.js: reversed Polanski answer, another country or no citizenship leave the saved file bytes and date intact", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "directors.json"), from = path.join(dir, "answers.json");
    const saved = '{\n  "3556": { "cit": ["PL", "FR"], "t": 5 }\n}\n';
    fs.writeFileSync(file, saved);
    for (const cit of [[{ iso: "FR" }, { iso: "PL" }], [{ iso: "ES" }], []]) {
      fs.writeFileSync(from, JSON.stringify({ 3556: { cit } }));
      const n = BD.main(["--from", from, "--cache", file, "--at", "2030-01-01"], quiet());
      assert.equal(n.code, 0);
      assert.equal(n.changed, 0);
      assert.equal(fs.readFileSync(file, "utf8"), saved);
      const map = DR.citizenshipMap(DR.load(file));
      assert.equal(C.mainCountry({ countries: ["FR", "DE", "PL", "GB"], lang: "en", origin: ["GB", "FR", "DE"], directors: D([3556]) }, undefined, undefined, map), "PL"); // the record's own origin, three countries (cache/tmdb.json, 14/11/2026): with one, the origin would decide (14/11/2026)
    }
  } finally { rm(dir); }
});
