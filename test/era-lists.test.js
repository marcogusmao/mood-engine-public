// node --test            (no dependencies)
// The files of the eras of the Discover, data/eras/<era id>.json, and the rule that makes a film belong to an era (Marco, 14/11/2026, "A sourced film list, or a listed director's film made in
// the movement's country"; research/2026-11-14-eras-v2.md sections 1.1, 5.1 and 5.2). The lists are DATA (the curation of 15/11/2026 replaces them): nothing here names a film of a list, so a new
// list that passes lib/era-lists.js validate() keeps every test of the RULE green; what these tests pin about the data is its SHAPE and the decisions that are Marco's (which era is a school, a
// cycle, a period; the years; the country of each school, a definition the specification measured with and not an answer of Marco). The written exclusions are not pinned: the list starts empty and is the curation's.
// No test here reads cache/ or the network: the index of reference is test/fixtures/era-filmographies-index-imdb-2026-11-14.json (the IMDb ids of the public index-v2.json of 14/11/2026 09:49 UTC).
//
// Mutations these tests are meant to turn red (15/11/2026, with the ones that survive in BACKLOG.md): the country taken out of the second door (a Polanski in English enters the Polish School); the years taken
// out of the first door (a listed film of another decade enters); the written exclusions ignored; a cycle treated as a school (a director brings films to Film noir); the consensus ignored; the candidates put
// in the era; a file with a film outside the years, a source that is not there, an IMDb id twice, an exclusion with no reason, a school with no country, a cycle with a school, a film the index does not
// have and no TMDB id or slug; an option with `era` and no file, a file with no option.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ERA = require("../lib/era-lists");
const DC = require("../lib/discover-catalogs");

const ROOT = path.join(__dirname, "..");
const REFERENCE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "era-filmographies-index-imdb-2026-11-14.json"), "utf8"));
const IN_REFERENCE = new Set(REFERENCE.imdb);
const CATALOGS = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "discover-catalogs.json"), "utf8"));
const OPTIONS = CATALOGS.catalogs.find((c) => c.id === "eras").options;
const SCHOOLS = ["e-neorealism", "e-nouvelle-vague", "e-new-german", "e-poetic-realism", "e-cinema-novo", "e-china-fifth-gen", "e-china-sixth-gen", "e-taiwan-new-cinema", "e-hk-new-wave", "e-korean-new-wave",
  "e-moral-anxiety", "e-polish-school", "e-iran-new-wave", "e-iran-art-cinema", "e-czech-new-wave", "e-japan-new-wave", "e-parallel-cinema"];
// 15/11/2026: New Hollywood and Giallo became lists (cycles); Screwball, Commedia all'italiana, British New Wave and German Expressionism are new eras, all lists
const CYCLES = ["e-new-hollywood", "e-noir", "e-precode", "e-giallo", "e-screwball", "e-commedia-italiana", "e-british-new-wave", "e-german-expressionism"];
const plain = (s) => s.replace(/[łŁ]/g, "l").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// ── the shape of a file: validate() ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A small sound school: the Polish School of a toy. */
const sound = () => ({
  id: "e-x", type: "school", years: { min: 1955, max: 1965 },
  school: { directors: [{ id: 11, name: "A Polish Director" }, { id: 12, name: "Another Polish Director" }], countries: ["PL"] },
  sources: [{ id: "wp", publication: "Wikipedia", title: "List of films", url: "https://en.wikipedia.org/w/index.php?oldid=1", revision: 1, readOn: "2026-11-14" }, { id: "cc", publication: "Criterion", title: "Channel", url: "https://x.example/", revision: null, readOn: "2026-11-14" }],
  consensus: null,
  films: [{ imdb: "tt0000001", tmdb: 1, slug: "first-film", title: "First Film", year: 1957, sources: ["wp"], refs: 2 }, { imdb: "tt0000002", title: "Second Film", year: 1960, sources: ["wp", "cc"], refs: 0 }],
  exclude: [{ imdb: "tt0000009", title: "Foreign Film", why: "made in Britain, not Poland, by a Polish director", source: "a toy source" }],
});
const problems = (mutate, o) => { const d = sound(); mutate(d); return ERA.validate(d, o); };
const refuses = (mutate, pattern, o) => { const p = problems(mutate, o); assert.ok(p.some((m) => pattern.test(m)), `${pattern}: got ${JSON.stringify(p)}`); };

test("validate: a sound file has no problem, and the eras of the Discover read it", () => {
  assert.deepEqual(ERA.validate(sound(), { id: "e-x" }), []);
  assert.deepEqual(ERA.validate({ ...sound(), type: "cycle", school: null }), []);
  assert.deepEqual(ERA.validate({ ...sound(), years: { min: 1996 } , films: [{ imdb: "tt0000001", title: "x", year: 2020, sources: ["wp"], refs: 0 }] }), [], "an era with no last year (Korean New Wave 1996–)");
});

test("validate: a film outside the years of the era is refused (mutation 1: both ends, and a year that is not a number)", () => {
  refuses((d) => { d.films[0].year = 1954; }, /year 1954 is outside the years of the era/);
  refuses((d) => { d.films[0].year = 1966; }, /year 1966 is outside the years of the era/);
  refuses((d) => { d.films[0].year = "1960"; }, /outside the years/);
});

test("validate: a source that is not in `sources` is refused; so is a film with no source; a source id twice; a source with no date or a revision that is text (mutation 2)", () => {
  refuses((d) => { d.films[0].sources = ["nowhere"]; }, /source "nowhere" is not in sources/);
  refuses((d) => { d.films[0].sources = []; }, /sources must name at least one source/);
  refuses((d) => { d.sources.push({ ...d.sources[0] }); }, /the id appears twice/);
  refuses((d) => { d.sources[0].readOn = "14/11/2026"; }, /readOn must be a date/);
  refuses((d) => { d.sources[0].revision = 1.5; }, /revision must be a number, a text or null/);
  refuses((d) => { d.sources = []; }, /sources must be a list of at least one/);
});

test("validate: an IMDb id twice is refused, and an id that is not tt and digits (mutation 3)", () => {
  refuses((d) => { d.films[1].imdb = "tt0000001"; }, /the IMDb id appears twice/);
  refuses((d) => { d.films[1].imdb = "0000002"; }, /imdb must be tt and digits/);
});

test("validate: an exclusion needs a reason of five words or more, and a film that is excluded cannot be in `films` (mutation 4)", () => {
  refuses((d) => { d.exclude[0].why = "foreign"; }, /why must say the reason in at least five words/);
  refuses((d) => { d.exclude[0].why = "not Polish at all"; }, /at least five words/);
  refuses((d) => { d.exclude[0].imdb = "tt0000001"; }, /excluded cannot be in films/);
  refuses((d) => { d.exclude.push({ ...d.exclude[0] }); }, /excluded twice/);
  refuses((d) => { d.exclude = null; }, /exclude must be a list/);
});

test("validate: a school needs its countries (without them the director's films made anywhere would enter) and its directors; a cycle has no school (mutations 5 and 6)", () => {
  refuses((d) => { delete d.school.countries; }, /school.countries must be a list of country codes/);
  refuses((d) => { d.school.countries = []; }, /school.countries must be a list/);
  refuses((d) => { d.school.countries = ["Poland"]; }, /school.countries must be a list of country codes/);
  refuses((d) => { d.school = null; }, /a school needs `school`/);
  refuses((d) => { d.school.directors = []; }, /school.directors must be a list of at least one/);
  refuses((d) => { d.school.directors.push({ id: 11, name: "Same Again" }); }, /twice/);
  refuses((d) => { d.school.directors[0].id = "11"; }, /must be \{ id: TMDB person id, name \}/);
  refuses((d) => { d.type = "cycle"; }, /a cycle has no `school`/);
  refuses((d) => { d.type = "movement"; }, /type must be one of school, cycle/);
});

test("validate: a school's countries must be codes that lib/countries.js knows (CZ, SK, XC and SU yes; UK and ZZ no, two letters or not)", () => {
  for (const ok of [["PL"], ["CZ", "SK", "XC"], ["SU", "RU"], ["GB"], ["TW", "HK", "CN"]]) assert.deepEqual(problems((d) => { d.school.countries = ok; }), [], ok.join());
  for (const bad of [["UK"], ["ZZ"], ["PL", "ZZ"], ["Pl"], ["PLN"], ["XX"]]) refuses((d) => { d.school.countries = bad; }, /school.countries must be a list of country codes that lib\/countries.js knows/);
});

test("read: a file of an era that is not JSON says which file it is (data/eras/<id>.json), not the Discover file", () => {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "eras-"));
  try {
    fs.writeFileSync(path.join(dir, "e-broken.json"), '{ "id": "e-broken", ');
    assert.throws(() => ERA.read("e-broken", dir), /^Error: data\/eras\/e-broken.json is not valid JSON: /);
    assert.throws(() => ERA.load("e-broken", { dir }), /data\/eras\/e-broken.json is not valid JSON/);
    assert.throws(() => ERA.read("e-missing", dir), /data\/eras\/e-missing.json does not exist/);
    const spec = GOOD([{ id: "e-broken", label: "Era", era: "e-broken" }]);
    assert.throws(() => DC.parse(spec, { lists: [], today: "2026-11-14", eras: (id) => ERA.read(id, dir) }), /data\/eras\/e-broken.json is not valid JSON/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("validate: a film the index does not have needs its TMDB id and its Letterboxd slug; a film the index has does not (mutation 7)", () => {
  const index = (tt) => tt === "tt0000001";
  assert.deepEqual(ERA.validate(sound(), { inIndex: (tt) => true }), [], "both are in the index: nothing needed");
  const p = ERA.validate(sound(), { inIndex: index });
  assert.ok(p.some((m) => /Second Film.*needs tmdb and slug/.test(m)) && !p.some((m) => /First Film/.test(m)), JSON.stringify(p));
  refuses((d) => { d.films[1].tmdb = 2; }, /needs tmdb and slug/, { inIndex: index });
  assert.deepEqual(problems((d) => { d.films[1].tmdb = 2; d.films[1].slug = "film:123"; }, { inIndex: index }), [], "a slug can be film:<number>, as the ones lib/friends.js reads");
  refuses((d) => { d.films[0].slug = "Not A Slug"; }, /slug must be a Letterboxd slug/);
});

test("validate: the consensus names a source of the file and a number of notes; unknown keys are refused; the id is the name of the file", () => {
  assert.deepEqual(problems((d) => { d.consensus = { source: "wp", minRefs: 3 }; }), []);
  refuses((d) => { d.consensus = { source: "nowhere", minRefs: 3 }; }, /consensus must be null or/);
  refuses((d) => { d.consensus = { source: "wp", minRefs: 0 }; }, /consensus must be null or/);
  refuses((d) => { d.extra = 1; }, /unknown key "extra"/);
  refuses((d) => { d.films[0].score = 5; }, /unknown key "score"/);
  refuses((d) => { d.years = { min: 1965, max: 1955 }; }, /years must be/);
  refuses((d) => { d.id = "e-y"; }, /id is "e-y" and the file is the era "e-x"/, { id: "e-x" });
});

test("validate: the candidates (films of the directors that the index does not have) need TMDB id, slug, a feature's length and the years; none twice, none in `films`, none excluded", () => {
  const cand = (o = {}) => ({ imdb: "tt0000100", tmdb: 100, slug: "a-candidate", title: "A Candidate", year: 1958, directors: ["A Polish Director"], minutes: 95, ...o });
  assert.deepEqual(problems((d) => { d.school.candidates = [cand()]; }), []);
  refuses((d) => { d.school.candidates = [cand({ tmdb: undefined })]; }, /needs its TMDB id/);
  refuses((d) => { d.school.candidates = [cand({ slug: undefined })]; }, /needs its Letterboxd slug/);
  refuses((d) => { d.school.candidates = [cand({ minutes: 39 })]; }, /a feature is 40 minutes or more/);
  refuses((d) => { d.school.candidates = [cand({ year: 1970 })]; }, /outside the years of the era/);
  refuses((d) => { d.school.candidates = [cand(), cand()]; }, /twice/);
  refuses((d) => { d.school.candidates = [cand({ imdb: "tt0000001" })]; }, /is also in films/);
  refuses((d) => { d.school.candidates = [cand({ imdb: "tt0000009" })]; }, /is excluded/);
});

// ── the rule: who belongs, by type and by door (DC.parse + DC.build over a toy index) ────────────────────────────────────────────────────────────

const LISTS = [];
const TODAY = "2026-11-14";
const GOOD = (options) => ({
  version: 1, floor: { countries: 1, eras: 1 }, order: ["moods", "eras", "director-picks", "friends", "explore", "search"], retire: ["lists", "lists-unseen"], seen: { name: "seen", option: "Include seen" }, spread: { per: 2, window: 20 },
  catalogs: [{ id: "eras", name: "Mood Engine · Decades & eras", options }],
});
let n = 0;
/** A film of the toy index (entry) and its TMDB record. `tt` decides: a film in the list of an era has its imdb id. */
function film({ tt = `tt9${String(++n).padStart(6, "0")}`, year = 1960, iso = "PL", directors = [], eligible = true, seen = false, rec = true, runtime } = {}) {
  const entry = { tt, name: `Film ${tt}`, year, decade: `${Math.floor(year / 10) * 10}s`, countries: [iso], director: directors[0] ? directors[0].name : "Nobody", lbRating: 4, rank: 100 - n, find: ` film ${tt}`, ...(runtime !== undefined ? { runtime } : {}), ...(eligible ? { eligible: true } : {}), ...(seen ? { seen: true } : {}) };
  return { entry, rec: rec ? { imdb: tt, countries: [iso], lang: "en", year, directors, genres: [], keywords: [] } : null };
}
function members(eraData, films, { option, minFeatureMinutes } = {}) {
  const spec = DC.parse(GOOD([{ id: eraData.id, label: "Era", era: eraData.id, ...option }]), { lists: LISTS, today: TODAY, eras: new Map([[eraData.id, eraData]]) });
  const records = new Map(films.map((f) => [f.entry.tt, f.rec]));
  const out = DC.build({ spec, index: { films: films.map((f) => f.entry), lists: [] }, recordOf: (tt) => records.get(tt) || null, ...(minFeatureMinutes !== undefined ? { minFeatureMinutes } : {}) });
  return out.catalogs[0].options[0].ids;
}
const POLE = { id: 11, name: "A Polish Director" }, STRANGER = { id: 999, name: "A Stranger" };

test("rule, the first door: a film of the list inside the years enters even when its director is not in the list and its country is another; outside the years it does not", () => {
  const listed = film({ tt: "tt0000001", year: 1957, iso: "GB", directors: [STRANGER] }), early = film({ tt: "tt0000002", year: 1954, directors: [STRANGER] });
  assert.deepEqual(members(sound(), [listed, early]), ["tt0000001"]);
});

test("rule, the second door: a director of the list, in the country of the school, in the years, enters (both ends of the years count)", () => {
  const a = film({ year: 1955, directors: [POLE] }), b = film({ year: 1965, directors: [POLE] });
  assert.deepEqual(members(sound(), [a, b]).sort(), [a.entry.tt, b.entry.tt].sort());
});

test("rule, the second door: a director of the list whose film was made in ANOTHER country does not enter (Repulsion of a toy: a Polish director, a British film)", () => {
  const repulsion = film({ year: 1965, iso: "GB", directors: [POLE] }), own = film({ year: 1965, directors: [POLE] });
  assert.deepEqual(members(sound(), [repulsion, own]), [own.entry.tt]);
});

test("rule, the second door: a director of the list outside the years does not enter; a director outside the list, in the country and the years, does not enter either", () => {
  const before = film({ year: 1954, directors: [POLE] }), after = film({ year: 1966, directors: [POLE] }), stranger = film({ year: 1960, directors: [STRANGER] }), noDirectors = film({ year: 1960, directors: [] }), noRecord = film({ year: 1960, directors: [POLE], rec: false });
  assert.deepEqual(members(sound(), [before, after, stranger, noDirectors, noRecord]), [], "a film with no TMDB record passes no second door either");
});

// Marco, 15/11/2026 ("Only where you or a source put them"): 22 shorts came into eras by the director's door with no source (12 in the Nouvelle Vague); signed by that defect, 15/11/2026.
// The rule is the one the Discover cuts have (P.isShort, shortRow.minMinutes = 40): below the minimum a short is not brought by a director; a film with no known runtime stays; the list door keeps the short a source names.
test("rule, the second door: a SHORT of a director of the list does not enter (under 40 minutes); the feature does, the limit film (40) does, and a film with no known runtime does", () => {
  const short = film({ year: 1960, directors: [POLE], runtime: 21 }), feature = film({ year: 1960, directors: [POLE], runtime: 95 }), limit = film({ year: 1960, directors: [POLE], runtime: 40 }), unknown = film({ year: 1960, directors: [POLE] });
  assert.deepEqual(members(sound(), [short, feature, limit, unknown]).sort(), [feature.entry.tt, limit.entry.tt, unknown.entry.tt].sort());
});

test("rule, the first door: a short that the LIST names stays (a source put it there), even by a director who is not in the list", () => {
  const d = sound();
  d.films.push({ imdb: "tt0000077", title: "A Named Short", year: 1958, sources: ["wp"], refs: 0 });
  const named = film({ tt: "tt0000077", year: 1958, directors: [STRANGER], runtime: 28 }), byDirector = film({ year: 1960, directors: [POLE], runtime: 28 });
  assert.deepEqual(members(d, [named, byDirector]), ["tt0000077"]);
});

// Marco, 15/11/2026 ("Only where you or a source put them"), the Worker's side: the build marks every short (bit 16 of the flags, `shortOut`) and the Worker shows none in a calculated option of the Discover.
// An era is the exception: the short its file names stays. The option says `shorts: true`, the Worker and the totals (lib/index-export.js optionCut) do not ask the short bit there, and the spread counts the short as shown.
test("the era option says `shorts: true` and keeps the short its list names, marked as the build marks it (`shortOut`); it is counted among the films the option shows; an option that is not an era carries no such key", () => {
  const d = sound();
  d.films.push({ imdb: "tt0000077", title: "A Named Short", year: 1958, sources: ["wp"], refs: 0 });
  const named = film({ tt: "tt0000077", year: 1958, directors: [STRANGER], runtime: 28 }), feature = film({ year: 1960, directors: [POLE], runtime: 95 }), seen = film({ year: 1961, directors: [POLE], runtime: 95, seen: true });
  named.entry.shortOut = true; // what lib/index-export.js buildIndex writes for a known runtime under shortRow.minMinutes
  const films = [named, feature, seen];
  const logged = [];
  const spec = DC.parse(GOOD([{ id: d.id, label: "Era", era: d.id }, { id: "p-sixties", label: "1960s", decade: "1960s" }]), { lists: LISTS, today: TODAY, eras: new Map([[d.id, d]]) });
  const records = new Map(films.map((f) => [f.entry.tt, f.rec]));
  const out = DC.build({ spec, index: { films: films.map((f) => f.entry), lists: [] }, recordOf: (tt) => records.get(tt) || null, log: (line) => logged.push(line) });
  const [era, decade] = out.catalogs[0].options;
  assert.equal(era.shorts, true, "the era says it keeps its shorts");
  assert.deepEqual([...era.ids].sort(), ["tt0000077", feature.entry.tt, seen.entry.tt].sort(), "the named short is in the ids");
  assert.equal(Object.hasOwn(decade, "shorts"), false, "a decade is not an era: no key");
  assert.equal(Object.hasOwn(era, "curated"), false, "and an era is not a curated option: the recommendation rule and the music rule hold in it");
  assert.ok(logged.includes("    Era 2"), `the log counts the named short among the films shown (the feature and the short; the seen one is not shown): ${logged.join(" | ")}`);
});

// The two-of-a-director rule of the first screen (Marco, 23/10/2026) is judged on what the screen shows, and in an era the screen shows the named short: it takes one of its director's two places.
test("the spread of an era counts the short its list names as a film on the screen (it takes one of its director's two places); the same six films in a decade, where the short is not shown, come out in another order", () => {
  const d = sound();
  d.films.push({ imdb: "tt0000077", title: "A Named Short", year: 1958, sources: ["wp"], refs: 0 });
  const OTHER = { id: 12, name: "Another Polish Director" };
  // the order of the index: the short and a feature of one director, three features of another, and a third film of the first
  const short = film({ tt: "tt0000077", year: 1958, directors: [POLE], runtime: 28 }), a1 = film({ year: 1958, directors: [POLE], runtime: 95 }), b1 = film({ year: 1958, directors: [OTHER], runtime: 95 }), b2 = film({ year: 1958, directors: [OTHER], runtime: 95 }), b3 = film({ year: 1958, directors: [OTHER], runtime: 95 }), a2 = film({ year: 1958, directors: [POLE], runtime: 95 });
  short.entry.shortOut = true;
  const films = [short, a1, b1, b2, b3, a2], tt = (f) => f.entry.tt;
  const spec = DC.parse(GOOD([{ id: d.id, label: "Era", era: d.id }, { id: "p-fifties", label: "1950s", decade: "1950s" }]), { lists: LISTS, today: TODAY, eras: new Map([[d.id, d]]) });
  const records = new Map(films.map((f) => [tt(f), f.rec]));
  const [era, decade] = DC.build({ spec, index: { films: films.map((f) => f.entry), lists: [] }, recordOf: (id) => records.get(id) || null }).catalogs[0].options;
  // in the era the short is on the screen: after it and a1 the first director is full on the screen, as the second is after b1 and b2; neither has room, the fewest-in-the-window tie goes to the earliest in the index, b3
  assert.deepEqual(era.ids, [short, a1, b1, b2, b3, a2].map(tt), "the era: the short took a place on the screen");
  // (control) in the decade the short is not shown: the first director still has a place on the screen, so a2 goes before b3
  assert.deepEqual(decade.ids, [short, a1, b1, b2, a2, b3].map(tt), "the decade: the short takes no place on the screen");
});

test("rule, the second door: the minimum is the one the build gives (config shortRow.minMinutes), not a number of this file", () => {
  const f = film({ year: 1960, directors: [POLE], runtime: 50 });
  assert.deepEqual(members(sound(), [f]), [f.entry.tt], "50 minutes is a feature under the default of 40");
  assert.deepEqual(members(sound(), [f], { minFeatureMinutes: 60 }), [], "under a minimum of 60 it is a short");
});

// The exclusion of a film that the LIST names cannot be exercised here: the validator refuses a file that lists and excludes the same film (see the test of validate), so the list door never meets an excluded film; what this test proves is the director door.
test("rule: a written exclusion beats both doors (the film of the list and the film of the director are out when written)", () => {
  const d = sound();
  d.films = d.films.filter((f) => f.imdb !== "tt0000002");
  d.exclude = [{ imdb: "tt0000003", title: "Excluded director's film", source: "a toy source", why: "made in the country but not of the movement" }, { imdb: "tt0000004", title: "Excluded listed film", source: "a toy source", why: "on the list by a mistake of the source" }];
  d.films.push({ imdb: "tt0000005", title: "Listed", year: 1958, sources: ["wp"], refs: 0 });
  const byDirector = film({ tt: "tt0000003", year: 1960, directors: [POLE] }), alsoByDirector = film({ tt: "tt0000004", year: 1960, directors: [POLE] }), listed = film({ tt: "tt0000005", year: 1958, directors: [STRANGER] }), plainOne = film({ year: 1960, directors: [POLE] });
  assert.deepEqual(members(d, [byDirector, alsoByDirector, listed, plainOne]).sort(), ["tt0000005", plainOne.entry.tt].sort());
  // the exclusion of a film that the list ALSO names: the validator makes the file choose (a film in `films` and in `exclude` is refused), so the door of the list can never contradict it
  const both = sound(); both.exclude = [{ imdb: "tt0000001", title: "First Film", source: "a toy source", why: "named by the list and excluded by hand" }];
  assert.throws(() => members(both, []), /excluded cannot be in films/);
});

test("rule, a CYCLE: only the list brings a film; the director of a list brings none (and there is no country: a cycle has no school)", () => {
  const cycle = { ...sound(), id: "e-c", type: "cycle", school: null, exclude: [] };
  const listed = film({ tt: "tt0000001", year: 1957, iso: "US", directors: [STRANGER] }), byDirector = film({ year: 1960, directors: [POLE] }), early = film({ tt: "tt0000002", year: 1950 });
  assert.deepEqual(members(cycle, [listed, byDirector, early]), ["tt0000001"]);
});

test("rule, the consensus: a film that only the consensus source names counts with enough notes; a film another source names too is not touched; the other films of the list count as ever", () => {
  const d = sound();
  d.consensus = { source: "wp", minRefs: 3 };
  d.films = [{ imdb: "tt0000001", title: "Two notes", year: 1957, sources: ["wp"], refs: 2 }, { imdb: "tt0000002", title: "Three notes", year: 1958, sources: ["wp"], refs: 3 }, { imdb: "tt0000003", title: "Other source", year: 1959, sources: ["wp", "cc"], refs: 0 }, { imdb: "tt0000004", title: "Only the other", year: 1960, sources: ["cc"], refs: 0 }];
  d.exclude = [];
  const fs_ = [1, 2, 3, 4].map((k) => film({ tt: `tt000000${k}`, year: 1956 + k, directors: [STRANGER] }));
  assert.deepEqual(members(d, fs_), ["tt0000002", "tt0000003", "tt0000004"]);
});

test("rule: a film that is not eligible is never in; a seen film is in the ids (the Worker keeps it out unless `Include seen`); the era is a school, so the floor of the file counts it", () => {
  const refused = film({ tt: "tt0000001", year: 1957, eligible: false }), seen = film({ tt: "tt0000002", year: 1960, seen: true });
  assert.deepEqual(members(sound(), [refused, seen]), ["tt0000002"]);
});

test("rule: the candidates of a school never put a film in the era (they bring a film to the index; the second door, with the country, decides)", () => {
  const d = sound();
  d.school.candidates = [{ imdb: "tt0000100", tmdb: 100, slug: "a-candidate", title: "A Candidate", year: 1958, directors: ["A Polish Director"], minutes: 95 }];
  const asIfIn = film({ tt: "tt0000100", year: 1958, iso: "GB", directors: [POLE] }); // the same film, made in Britain: not a member (and it is not in `films`)
  assert.deepEqual(members(d, [asIfIn]), []);
  const home = film({ tt: "tt0000100", year: 1958, directors: [POLE] });
  assert.deepEqual(members(d, [home]), ["tt0000100"], "made in Poland by a director of the list: it enters by the second door, not by being a candidate");
});

test("floor: the build warns with ! for an era (a school or a cycle) that shows fewer unseen films than the floor of the file, as it does for a period, and keeps it", () => {
  const spec = DC.parse({ ...GOOD([{ id: "e-x", label: "Era", era: "e-x" }]), floor: { countries: 1, eras: 3 } }, { lists: LISTS, today: TODAY, eras: new Map([["e-x", sound()]]) });
  const fs_ = [film({ tt: "tt0000001", year: 1957 }), film({ tt: "tt0000002", year: 1960 })];
  const records = new Map(fs_.map((f) => [f.entry.tt, f.rec])), logged = [];
  const out = DC.build({ spec, index: { films: fs_.map((f) => f.entry), lists: [] }, recordOf: (tt) => records.get(tt), log: (l) => logged.push(l) });
  assert.equal(out.catalogs[0].options[0].ids.length, 2, "kept");
  assert.ok(logged.some((l) => /Era 2 !$/.test(l)), JSON.stringify(logged));
  const enough = DC.build({ spec: { ...spec, floor: { countries: 1, eras: 2 } }, index: { films: fs_.map((f) => f.entry), lists: [] }, recordOf: (tt) => records.get(tt), log: (l) => logged.push(l) });
  assert.ok(logged.at(-1) === "    Era 2" && enough.catalogs[0].options[0].ids.length === 2, "at the floor there is no warning");
});

test("parse: an option with `era` needs its file, its id must be the name of the file, and a file that is not sound stops the build with the problem", () => {
  const options = (o) => GOOD([{ id: "e-x", label: "Era", ...o }]);
  assert.throws(() => DC.parse(options({ era: "e-x" }), { lists: LISTS, today: TODAY, eras: new Map() }), /no era file "e-x"/);
  assert.throws(() => DC.parse(options({ era: "e-other" }), { lists: LISTS, today: TODAY, eras: new Map() }), /era must name the era file of this option/);
  assert.throws(() => DC.parse(options({ era: "e-x" }), { lists: LISTS, today: TODAY, eras: new Map([["e-x", { ...sound(), years: { min: 0 } }]]) }), /era file e-x: years must be/);
  assert.throws(() => DC.parse(options({ era: "e-x", where: { years: { min: 1950 } } }), { lists: LISTS, today: TODAY, eras: new Map([["e-x", sound()]]) }), /needs exactly one of where, country, decade, lists, any, runtime, rating or era, has where and era/);
  assert.throws(() => DC.parse(options({ era: "e-never-written" }), { lists: LISTS, today: TODAY }), /era must name the era file of this option/);
  assert.throws(() => DC.parse(GOOD([{ id: "e-never-written", label: "Era", era: "e-never-written" }]), { lists: LISTS, today: TODAY }), /data\/eras\/e-never-written.json does not exist/, "the default is the folder data/eras");
});

// ── the real files ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("data/eras: one file for each option of Discover with `era`, and no file without an option (mutation 8); 17 schools and 8 lists; every file is sound and every film the index of reference lacks has its TMDB id and slug", () => {
  const withEra = OPTIONS.filter((o) => o.era !== undefined);
  assert.deepEqual(withEra.map((o) => o.era).sort(), [...SCHOOLS, ...CYCLES].sort());
  assert.ok(withEra.every((o) => o.era === o.id && o.where === undefined), "era replaces where, and names its own file");
  assert.deepEqual(ERA.ids(), withEra.map((o) => o.id).sort(), "no file without its option");
  for (const id of ERA.ids()) {
    const data = ERA.read(id);
    assert.deepEqual(ERA.validate(data, { id, inIndex: (tt) => IN_REFERENCE.has(tt) }), [], id);
    assert.equal(data.type, SCHOOLS.includes(id) ? "school" : "cycle", id);
    assert.ok(data.films.length > 0, `${id} has films`);
  }
});

// The country of each school is CHOSEN BY THE SESSION, not decided by Marco (as `decided` of data/discover-catalogs.json says): it is the definition the specification measured with (the movement's country, with the neighbours that make its films), and the specification did not source it. Changing one changes who belongs — the Polish School
// with the Czech Republic instead of Poland loses 3 films, the Japanese New Wave with Korea instead of Japan loses 21 (measured 15/11/2026, index of 14/11) — so the table is pinned here and a change has to change this test.
const COUNTRIES = {
  "e-china-fifth-gen": ["CN", "HK", "TW"], "e-china-sixth-gen": ["CN", "HK", "TW"], "e-cinema-novo": ["BR"], "e-czech-new-wave": ["CZ", "SK", "XC"], "e-hk-new-wave": ["HK", "CN"], "e-iran-new-wave": ["IR"], "e-iran-art-cinema": ["IR"],
  "e-japan-new-wave": ["JP"], "e-korean-new-wave": ["KR"], "e-moral-anxiety": ["PL"], "e-neorealism": ["IT"], "e-new-german": ["DE"], "e-nouvelle-vague": ["FR", "CH"],
  "e-parallel-cinema": ["IN"], "e-poetic-realism": ["FR"], "e-polish-school": ["PL"], "e-taiwan-new-cinema": ["TW"],
};
test("data/eras: the country of each of the 17 schools is the decided one (a table: to change a country, change this test), and a cycle has none", () => {
  assert.deepEqual(SCHOOLS.slice().sort(), Object.keys(COUNTRIES).sort());
  for (const id of SCHOOLS) assert.deepEqual(ERA.read(id).school.countries, COUNTRIES[id], id);
  for (const id of CYCLES) assert.equal(ERA.read(id).school, null, `${id}: a cycle has no school and so no country`);
});

test("data/eras: a film is in the list of an era once, and the exclusions of a real file (the list starts empty on 15/11/2026; the curation writes them) are sound: a reason of five words, none also in `films`", () => {
  for (const id of ERA.ids()) {
    const d = ERA.read(id);
    assert.equal(new Set(d.films.map((f) => f.imdb)).size, d.films.length, id);
    for (const x of d.exclude) assert.ok(x.why.trim().split(/\s+/).length >= 5 && !d.films.some((f) => f.imdb === x.imdb), `${id}: ${x.title}`);
  }
});

test("data/eras, by type and by door on each REAL file: the list door brings a film of the list whatever its director and country; the director door needs the country and the years; the exclusions and the cycles hold", () => {
  const real = (id) => { const eras = new Map([[id, ERA.read(id)]]); return { data: ERA.read(id), eras }; };
  const run = (id, films) => { const { eras } = real(id); const spec = DC.parse(GOOD([{ id, label: "Era", era: id }]), { lists: LISTS, today: TODAY, eras }); const records = new Map(films.map((f) => [f.entry.tt, f.rec])); return DC.build({ spec, index: { films: films.map((f) => f.entry), lists: [] }, recordOf: (tt) => records.get(tt) || null }).catalogs[0].options[0].ids; };
  for (const id of [...SCHOOLS, ...CYCLES]) {
    const d = ERA.read(id), mid = Math.floor((d.years.min + (d.years.max ?? d.years.min + 20)) / 2);
    const admitted = (f) => !d.admit || f.class === undefined || d.admit.includes(f.class);
    const listed = d.films.find((f) => !f.outside && !f.included && admitted(f) && f.year >= d.years.min && (d.years.max === undefined || f.year <= d.years.max) && !d.exclude.some((x) => x.imdb === f.imdb));
    const inList = film({ tt: listed.imdb, year: listed.year, iso: "BR", directors: [STRANGER] });
    assert.ok(run(id, [inList]).includes(listed.imdb), `${id}: a film of the list enters whatever its director and country`);
    assert.ok(!run(id, [film({ tt: listed.imdb, year: d.years.min - 1, iso: "BR", directors: [STRANGER] })]).includes(listed.imdb), `${id}: the list does not bring a film of another time (the year of the index decides)`);
    if (d.type === "cycle") {
      const byDirector = film({ year: mid, iso: "US", directors: [STRANGER] });
      assert.ok(!run(id, [byDirector]).includes(byDirector.entry.tt), `${id}: a cycle ignores directors`);
      continue;
    }
    const who = d.school.directors[0], country = d.school.countries[0];
    const abroad = ["BR", "NZ"].find((c) => !d.school.countries.includes(c));
    const home = film({ year: mid, iso: country, directors: [who] }), away = film({ year: mid, iso: abroad, directors: [who] }), early = film({ year: d.years.min - 1, iso: country, directors: [who] }), stranger = film({ year: mid, iso: country, directors: [STRANGER] });
    const got = run(id, [home, away, early, stranger]);
    assert.deepEqual(got, [home.entry.tt], `${id}: a director of the list, in the country and the years, enters — and no more: the same director's film made in ${abroad}, a year before, or a stranger's, does not`);
    if (d.school.countries.length) {
      const later = d.years.max !== undefined ? film({ year: d.years.max + 1, iso: country, directors: [who] }) : null;
      if (later) assert.ok(!run(id, [later]).includes(later.entry.tt), `${id}: the last year of the era is ${d.years.max}`);
    }
    for (const x of d.exclude) {
      const excluded = film({ tt: x.imdb, year: mid, iso: country, directors: [who] });
      assert.ok(!run(id, [excluded]).includes(x.imdb), `${id}: ${x.title} is written out and stays out, even as a director's film in the country and the years`);
    }
  }
});

test("data/eras: the candidates of the four split eras are features of 40 minutes or more of a name of THEIR list, outside the index of reference, none twice between eras; the Decalogue episodes are not there", () => {
  const split = ["e-china-fifth-gen", "e-china-sixth-gen", "e-polish-school", "e-moral-anxiety"], all = [];
  for (const id of split) {
    const d = ERA.read(id), names = new Set(d.school.directors.map((x) => plain(x.name)));
    assert.ok(d.school.candidates.length > 0 && d.school.candidatesFrom.includes("TMDB"), id);
    for (const f of d.school.candidates) {
      assert.ok(f.directors.length > 0 && f.directors.every((x) => names.has(plain(x))), `${id}: ${f.title}: a director that is not in the list of the era`);
      assert.ok(!IN_REFERENCE.has(f.imdb), `${id}: ${f.title} is already in the index of reference`);
      assert.ok(!/^Decalogue/.test(f.title), `${id}: ${f.title}: an episode of a TV series`);
      all.push(f);
    }
  }
  assert.equal(new Set(all.map((f) => f.tmdb)).size, all.length, "TMDB ids");
  assert.equal(new Set(all.map((f) => f.imdb)).size, all.length, "IMDb ids");
  assert.deepEqual(ERA.read("e-moral-anxiety").school.notAdded.map((x) => x.name), ["Antoni Krauze"]);
  assert.deepEqual(ERA.read("e-china-sixth-gen").school.notAdded.map((x) => x.name), ["Wang Chao"]);
});

// ── the new rules of 15/11/2026 (Marco's answers, the sheet docs/2026-11-15-eras-decisoes.md of the stremio repository) ─────────────────────────────────────────────────────────────────────────

const CLASSES_ERA = () => ({ ...sound(), id: "e-c", type: "cycle", school: null, exclude: [], admit: ["core"],
  films: [{ imdb: "tt0000001", title: "Core", year: 1957, sources: ["wp"], class: "core" }, { imdb: "tt0000002", title: "Periphery", year: 1958, sources: ["wp"], class: "periphery" }, { imdb: "tt0000003", title: "Disputed", year: 1959, sources: ["wp"], class: "disputed" }] });

test("rule, the list door does not look at the country: a film a source names enters whatever its country (Fahrenheit 451 in the Nouvelle Vague: a British film by Truffaut)", () => {
  const fahrenheit = film({ tt: "tt0000001", year: 1957, iso: "GB", directors: [STRANGER] }), another = film({ tt: "tt0000002", year: 1960, iso: "BR", directors: [] });
  assert.deepEqual(members(sound(), [fahrenheit, another]).sort(), ["tt0000001", "tt0000002"]);
  // the country counts only for the directors: the same film, NOT on the list, by a director of the list, made in Britain, stays out
  const unlisted = film({ year: 1960, iso: "GB", directors: [POLE] });
  assert.deepEqual(members(sound(), [unlisted]), []);
  // the real case: Fahrenheit 451 (tt0060390) is a film of the file of the Nouvelle Vague, whose countries are FR and CH, and it is not excluded
  const nv = ERA.read("e-nouvelle-vague");
  assert.ok(nv.films.some((f) => f.imdb === "tt0060390") && !nv.exclude.some((x) => x.imdb === "tt0060390") && !nv.school.countries.includes("GB"));
  const eras = new Map([["e-nouvelle-vague", nv]]);
  const spec = DC.parse(GOOD([{ id: "e-nouvelle-vague", label: "Era", era: "e-nouvelle-vague" }]), { lists: LISTS, today: TODAY, eras });
  const f = film({ tt: "tt0060390", year: 1966, iso: "GB", directors: [STRANGER] });
  assert.deepEqual(DC.build({ spec, index: { films: [f.entry], lists: [] }, recordOf: () => f.rec }).catalogs[0].options[0].ids, ["tt0060390"]);
});

test("rule, a film outside the years enters only by a WRITTEN exception (`outside`: a source names it); the label and the years of the era do not change; without the exception it is out", () => {
  const d = sound();
  d.films = [{ imdb: "tt0000001", title: "Early", year: 1950, sources: ["wp"], outside: { source: "wp", why: "a source names it and Marco let it in" } }, { imdb: "tt0000002", title: "Late", year: 1980, sources: ["wp"] }];
  assert.deepEqual(ERA.validate({ ...d, films: d.films.slice(0, 1) }), [], "the exception is a sound file");
  assert.ok(ERA.validate(d).some((m) => /Late.*outside the years/.test(m)), "a film outside the years with no exception is refused by the validator");
  const sane = { ...d, films: d.films.slice(0, 1) };
  const early = film({ tt: "tt0000001", year: 1950, directors: [STRANGER] });
  assert.deepEqual(members(sane, [early]), ["tt0000001"], "named by a source, written as an exception: in");
  assert.ok(ERA.validate({ ...sane, films: [{ ...sane.films[0], outside: undefined }] }).some((m) => /outside the years/.test(m)));
  assert.ok(ERA.validate({ ...sane, films: [{ ...sane.films[0], year: 1960 }] }).some((m) => /outside is written for a film that is inside the years/.test(m)));
  assert.ok(ERA.validate({ ...sane, films: [{ ...sane.films[0], outside: { source: "nowhere", why: "a source names it and Marco let it in" } }] }).some((m) => /outside must be/.test(m)));
  assert.ok(ERA.validate({ ...sane, films: [{ ...sane.films[0], outside: { source: "wp", why: "too short" } }] }).some((m) => /outside must be/.test(m)));
});

test("rule, the classes: the era admits some classes of the curation only (core 2+ sources, periphery 1, disputed one names it and another contradicts); a film put in by a written decision (`included`) enters whatever its class", () => {
  const d = CLASSES_ERA();
  const fs_ = [1, 2, 3].map((k) => film({ tt: `tt000000${k}`, year: 1956 + k, directors: [STRANGER] }));
  assert.deepEqual(members(d, fs_), ["tt0000001"], "admit core: only the core film");
  assert.deepEqual(members({ ...d, admit: ["core", "periphery"] }, fs_), ["tt0000001", "tt0000002"]);
  assert.deepEqual(members({ ...d, admit: undefined }, fs_), ["tt0000001", "tt0000002", "tt0000003"], "no admit: every class");
  const kept = { ...d, films: d.films.map((f) => (f.imdb === "tt0000003" ? { ...f, included: { source: "wp", why: "Marco kept this one by name" } } : f)) };
  assert.deepEqual(members(kept, fs_), ["tt0000001", "tt0000003"], "included beats the class");
  assert.ok(ERA.validate({ ...d, admit: [] }).some((m) => /admit must be/.test(m)) && ERA.validate({ ...d, admit: ["core", "core"] }).some((m) => /admit must be/.test(m)) && ERA.validate({ ...d, admit: ["best"] }).some((m) => /admit must be/.test(m)));
  assert.ok(ERA.validate({ ...d, films: [{ ...d.films[0], class: "best" }] }).some((m) => /class must be one of/.test(m)));
});

test("rule, an exclusion needs its source (who says the film is out, and where), and `refs`, `revision` and `pending` take the forms of the curation", () => {
  refuses((d) => { delete d.exclude[0].source; }, /an exclusion needs its source/);
  refuses((d) => { d.exclude[0].source = "  "; }, /an exclusion needs its source/);
  assert.deepEqual(problems((d) => { d.films[0].refs = undefined; delete d.films[0].refs; d.sources[0].revision = "01/04-16/05/2025"; d.sources[1].mark = "reported"; }), [], "no refs, a revision that is text, a mark");
  refuses((d) => { d.sources[0].mark = "hearsay"; }, /mark must be one of read, reported/);
  refuses((d) => { d.sources[0].revision = "  "; }, /revision must be a number, a text or null/);
  assert.deepEqual(problems((d) => { d.pending = [{ title: "A Film", year: 1960, why: "no IMDb id found yet" }]; }), []);
  refuses((d) => { d.pending = [{ title: "A Film", year: 1960, why: "none" }]; }, /a title and a reason of three words or more/);
  refuses((d) => { d.pending = {}; }, /pending must be a list/);
});

test("rule, a director who is not a director of the movement enters only by the films a source names: out of the list of directors his other films do not come (toy: a listed film and an unlisted one by the same man)", () => {
  const d = sound(); // Woo is not in school.directors; his one listed film is in `films`
  const listed = film({ tt: "tt0000001", year: 1957, directors: [STRANGER] }), unlisted = film({ year: 1960, directors: [STRANGER] });
  assert.deepEqual(members(d, [listed, unlisted]), ["tt0000001"]);
});

test("data/eras, the era files after the conversion: every file is sound, the sources carry a mark and a read date, the pending ones have a reason, and every film not in the index has its TMDB id and slug", () => {
  for (const id of ERA.ids()) {
    const d = ERA.read(id);
    assert.deepEqual(ERA.validate(d, { id, inIndex: (tt) => IN_REFERENCE.has(tt) }), [], id);
    for (const src of d.sources) { assert.ok(["read", "reported"].includes(src.mark), `${id}/${src.id}: mark`); assert.match(src.readOn, /^\d{4}-\d{2}-\d{2}$/); }
    for (const f of d.films) assert.ok(f.sources.length >= (d.id === "e-noir" ? 2 : 1), `${id}: ${f.title}`);
    assert.ok(d.admit && d.admit.length, `${id}: the classes the era admits are written`);
    for (const f of d.films) if (f.class) assert.ok(d.admit.includes(f.class) || f.included, `${id}: ${f.title} has a class the era does not admit and no written decision`);
    const outside = d.films.filter((f) => f.outside);
    for (const f of outside) assert.ok(f.year < d.years.min || (d.years.max !== undefined && f.year > d.years.max), `${id}: ${f.title}`);
  }
});

test("data/eras: the exceptions `outside` of ALL the eras are exactly 6 + 9: the six films of New Hollywood that MARCO let in (Seconds, Blow Out, Cutter's Way, Reds, They All Laughed, One from the Heart) and the nine precursors of Satyajit Ray and Ritwik Ghatak in the Indian Parallel Cinema, which MARCO confirmed (15/11/2026, second round: \"Keep them as precursors\"; the session wrote them, the sheet: the films of Ray and Ghatak that the sources name); any other needs this test changed", () => {
  const all = [];
  for (const id of ERA.ids()) for (const f of ERA.read(id).films) if (f.outside) all.push(`${id}:${f.imdb}:${f.title}`);
  const marco = ["e-new-hollywood:tt0060955:Seconds", "e-new-hollywood:tt0082085:Blow Out", "e-new-hollywood:tt0082220:Cutter's Way", "e-new-hollywood:tt0082979:Reds", "e-new-hollywood:tt0083189:They All Laughed", "e-new-hollywood:tt0084445:One from the Heart"];
  const precursors = ["e-parallel-cinema:tt0048473:Pather Panchali", "e-parallel-cinema:tt0048956:Aparajito", "e-parallel-cinema:tt0051343:Ajantrik", "e-parallel-cinema:tt0051792:Jalsaghar", "e-parallel-cinema:tt0052572:Apur Sansar",
    "e-parallel-cinema:tt0054073:Meghe Dhaka Tara", "e-parallel-cinema:tt0055724:Abhijan", "e-parallel-cinema:tt0057935:Charulata", "e-parallel-cinema:tt0056537:Subarnarekha"];
  assert.deepEqual(all.sort(), [...marco, ...precursors].sort(), "an exception outside the years would bring a film of 1929 back to the Pre-Code or Everything for Sale to the Polish School: only these are written");
  assert.equal(all.filter((x) => x.startsWith("e-new-hollywood")).length, 6, "six, no more, for New Hollywood");
});

test("data/eras, Cinema Novo: a film named only by Abraccine is not in the era (the sheet: the 22 that only Abraccine cites stay out); Abraccine reinforces, never suffices", () => {
  const d = ERA.read("e-cinema-novo");
  for (const f of d.films) assert.ok(f.sources.some((s) => !s.startsWith("abraccine")), `Cinema Novo: ${f.title} (${f.year}) is named only by Abraccine`);
  assert.ok(d.films.length >= 25, "the era keeps the films the movement sources name");
  assert.ok(!d.films.some((f) => ["O pagador de promessas", "Compasso de espera", "São Paulo S.A."].includes(f.title)), "O Pagador de Promessas, Compasso de Espera and São Paulo S.A. stay out");
});

test("validate: an era that admits classes needs a class on every film (or a written `included`); a pending film is one that is NOT in the list: it cannot repeat a film of `films`, and an id in pending needs its reason", () => {
  const d = () => ({ ...sound(), admit: ["core"], films: [{ imdb: "tt0000001", title: "Core", year: 1957, sources: ["wp"], class: "core" }] });
  assert.deepEqual(ERA.validate(d()), []);
  assert.ok(ERA.validate({ ...d(), films: [{ ...d().films[0], class: undefined }] }).some((m) => /every film needs its class/.test(m)));
  assert.deepEqual(ERA.validate({ ...d(), films: [{ ...d().films[0], class: undefined, included: { source: "wp", why: "Marco kept this one by name" } }] }), []);
  assert.deepEqual(ERA.validate({ ...sound(), films: sound().films }), [], "no admit: no class needed");
  const withPending = (p) => ({ ...d(), pending: p });
  assert.deepEqual(ERA.validate(withPending([{ imdb: "tt0000050", title: "Elsewhere", year: 1958, class: "core", why: "no Letterboxd page is known yet" }])), []);
  assert.ok(ERA.validate(withPending([{ imdb: "tt0000001", title: "Other title", year: 1958, why: "no Letterboxd page is known yet" }])).some((m) => /already in films/.test(m)), "the same id");
  assert.ok(ERA.validate(withPending([{ title: "Core", year: 1957, why: "no id found by the curation" }])).some((m) => /title and year is already in films/.test(m)), "the same title and year");
  assert.ok(ERA.validate(withPending([{ imdb: "12", title: "Bad id", year: 1958, why: "no Letterboxd page is known yet" }])).some((m) => /imdb must be tt and digits/.test(m)));
  assert.ok(ERA.validate(withPending([{ imdb: "tt0000050", title: "No reason", year: 1958, why: "none" }])).some((m) => /a reason of three words or more/.test(m)));
  assert.ok(ERA.validate(withPending([{ title: "Twice", year: 1958, why: "no id found by the curation" }, { title: "Twice", year: 1958, why: "no id found by the curation" }])).some((m) => /pending twice/.test(m)));
});

// X2 of the reviewer (15/11/2026, fourth pass): Young Husbands (periphery) went into the `pending` of the Commedia all'italiana, which admits the core only, and the battery stayed green. The slice that brings films to the catalogue reads
// `pending`, so a film the era does not admit cannot wait there, unless a written decision (included) puts it in (the four of Ray and Ghatak). Signed 15/11/2026.
test("validate: a pending film must be of a class the era ADMITS (or carry a written `included`): Young Husbands, periphery, in the Commedia that takes the core only, is refused", () => {
  const d = (pending) => ({ ...sound(), admit: ["core"], films: [{ imdb: "tt0000001", title: "Core", year: 1957, sources: ["wp"], class: "core" }], pending });
  const young = { imdb: "tt0000060", title: "Young Husbands", year: 1958, class: "periphery", why: "no Letterboxd page is known yet" };
  assert.ok(ERA.validate(d([young])).some((m) => /class "periphery" is not admitted by the era/.test(m)), "a class the era does not admit");
  assert.deepEqual(ERA.validate(d([{ ...young, class: "core" }])), [], "the core is admitted");
  assert.ok(ERA.validate(d([{ imdb: "tt0000060", title: "Young Husbands", year: 1958, why: "no Letterboxd page is known yet" }])).some((m) => /needs its class/.test(m)), "no class at all");
  assert.deepEqual(ERA.validate(d([{ ...young, class: "disputed", included: { source: "wp", why: "a written decision of Marco puts it in" } }])), [], "a written decision puts it in whatever its class");
  assert.ok(ERA.validate(d([{ ...young, included: { source: "nowhere", why: "a written decision of Marco puts it in" } }])).some((m) => /included must be/.test(m)), "the decision names a source of the file");
  assert.ok(ERA.validate(d([{ ...young, class: "great" }])).some((m) => /class must be one of/.test(m)), "an unknown class");
  assert.deepEqual(ERA.validate({ ...sound(), pending: [{ imdb: "tt0000060", title: "Young Husbands", year: 1958, why: "no Letterboxd page is known yet" }] }), [], "an era with no `admit` needs no class");
});

test("data/eras: every film in `pending` of a real file carries its class and the era admits it, or a written decision puts it in (the four of Ray and Ghatak)", () => {
  let withDecision = 0;
  for (const id of ERA.ids()) {
    const d = ERA.read(id);
    for (const p of d.pending || []) {
      assert.ok(p.class !== undefined, `${id}: ${p.title} has no class`);
      assert.ok(p.included !== undefined || d.admit.includes(p.class), `${id}: ${p.title} (${p.class}) is not admitted and has no written decision`);
      if (p.included !== undefined) { withDecision++; assert.equal(id, "e-parallel-cinema", `${id}: only Ray and Ghatak are put in by a decision`); }
    }
  }
  assert.equal(withDecision, 4, "Komal Gandhar, Kanchanjangha, Pratidwandi, Nagarik");
});

// ── what Marco decided (his answers of 15/11/2026, quoted from the BACKLOG of the stremio repository) and what the session chose (authorized: "Apply the research's recommendation in each, and show me the result") ──
// MARCO (the words are his): New Hollywood "only films an institution names" ("A real institution besides Wikipedia"), "Six enter; E.T. and Raiders stay out", documentaries "No, keep them out"; Giallo "By the film list",
// "Keep 3.5 on Letterboxd, like everything else", Suspiria "Out of Giallo"; Pre-Code "Films a source calls Pre-Code, 1930–34"; Film noir "Two or more" sources, 1940–59; Screwball "Yes, 1930–1950"; Commedia all'italiana
// "Yes, 1958–1980, core films first"; British New Wave "Yes, 1956–1972 as the BFI frames it, with Loach back"; Hong Kong "Both waves, 1979–2000, minus the action films", "7 leave, the 4 on Wikipedia stay", John Woo and Johnnie To
// "No: only their films that a source names"; Chinese Fifth Generation "Keep 1984–2006, take the three blockbusters out by name" and the four films of other generations "No, keep them out"; Polish School "1955–1965";
// Moral Anxiety "1975–1989, named as movement and aftermath"; Fahrenheit 451 "In: a film a source names enters, whatever its country". The test is red when a data file moves one of them.
test("data/eras, MARCO's decisions of 15/11/2026: New Hollywood only by institution (the six outside the years, not E.T. nor Raiders); Giallo a list without Suspiria; Pre-Code 1930–34; noir two sources; the new eras; Hong Kong; the Fifth Generation; the Polish eras", () => {
  const read = ERA.read, ids = (era) => read(era).films.map((f) => f.imdb), excl = (era) => read(era).exclude.map((x) => x.imdb);
  const nh = read("e-new-hollywood");
  assert.equal(nh.type, "cycle", "New Hollywood is a list: the 45 directors no longer decide");
  assert.equal(nh.school, null);
  assert.deepEqual(nh.years, { min: 1967, max: 1980 }, "the label and the years stay 1967–80");
  const sixOutside = { "Seconds": "tt0060955", "Blow Out": "tt0082085", "Cutter's Way": "tt0082220", "Reds": "tt0082979", "They All Laughed": "tt0083189", "One from the Heart": "tt0084445" };
  for (const [title, tt] of Object.entries(sixOutside)) { const f = nh.films.find((x) => x.imdb === tt); assert.ok(f && f.outside, `New Hollywood: ${title} enters, outside the years, by a written exception`); }
  assert.deepEqual(nh.films.filter((f) => f.outside).length, 6, "six, no more");
  for (const tt of ["tt0083866", "tt0082971"]) assert.ok(!ids("e-new-hollywood").includes(tt), `E.T. and Raiders of the Lost Ark (${tt}) stay out`);
  for (const [title, tt] of [["Jaws", "tt0073195"], ["Chinatown", "tt0071315"], ["Star Wars", "tt0076759"]]) assert.ok(ids("e-new-hollywood").includes(tt), `${title} is named by an institution and comes back`);
  assert.ok(nh.films.every((f) => f.sources.some((s) => !s.startsWith("wp-") && !s.startsWith("wikipedia"))), "every film is named by a source that is not Wikipedia");
  // documentaries: Marco, "No, keep them out". The TMDB genre Documentary decides; the ones the curation names are written out with their source
  const docs = { "Titicut Follies": "tt0062374", "Gimme Shelter": "tt0065780", "Woodstock": "tt0066580", "Harlan County, USA": "tt0074605", "The Last Waltz": "tt0077838" };
  for (const [title, tt] of Object.entries(docs)) assert.ok(excl("e-new-hollywood").includes(tt) && !ids("e-new-hollywood").includes(tt), `New Hollywood: ${title} is a documentary and stays out (written, with its source)`);
  const snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, "research", "2026-11-15-curadoria", "e-new-hollywood.json"), "utf8"));
  const flagged = new Set(snapshot.films.filter((f) => f.doc).map((f) => f.imdb));
  assert.ok(flagged.size >= 10, "the snapshot flags the documentaries by the TMDB genre");
  for (const f of nh.films) assert.ok(!flagged.has(f.imdb), `New Hollywood: ${f.title} is a documentary (TMDB genre) and is in the file`);
  for (const x of nh.exclude) assert.ok(x.source && x.source.includes("Marco, 15/11/2026"), `${x.title}: an exclusion with its source`);
  const giallo = read("e-giallo");
  assert.equal(giallo.type, "cycle");
  assert.deepEqual(giallo.years, { min: 1963, max: 1983 });
  assert.ok(OPTIONS.find((o) => o.id === "e-giallo").era === "e-giallo", "Giallo is a list now (a `where` by director before)");
  for (const [title, tt] of [["Suspiria", "tt0076786"], ["Zombie Flesh Eaters", "tt0080057"], ["The Beyond", "tt0082307"], ["Danger: Diabolik", "tt0062861"], ["Kill, Baby... Kill!", "tt0060794"]]) assert.ok(excl("e-giallo").includes(tt) && !ids("e-giallo").includes(tt), `Giallo: ${title} is out`);
  assert.deepEqual(read("e-precode").years, { min: 1930, max: 1934 });
  assert.equal(OPTIONS.find((o) => o.id === "e-precode").label, "Pre-Code Hollywood 1930–34");
  assert.deepEqual(read("e-noir").admit, ["core"], "film noir: two or more sources (the core)");
  assert.deepEqual(read("e-noir").years, { min: 1940, max: 1959 });
  assert.deepEqual([read("e-screwball").years, read("e-commedia-italiana").years, read("e-british-new-wave").years], [{ min: 1930, max: 1950 }, { min: 1958, max: 1980 }, { min: 1956, max: 1972 }]);
  assert.deepEqual([read("e-commedia-italiana").admit, read("e-british-new-wave").admit], [["core"], ["core"]], "Marco: \"Yes, 1958–1980, core films first\" (Commedia all'italiana) and \"Yes, 1956–1972 as the BFI frames it, with Loach back\" (British New Wave): the sheet of decisions reads both as core films only, the session's reading of his words");
  const hk = read("e-hk-new-wave");
  assert.deepEqual(hk.years, { min: 1979, max: 2000 }, "both waves");
  for (const id of [11401, 25236]) assert.ok(!hk.school.directors.some((d) => d.id === id), `Hong Kong: John Woo (11401) and Johnnie To (25236) are not directors of the era (${id})`);
  for (const tt of ["tt0104684", "tt0097202", "tt0098691", "tt0108592", "tt0107162", "tt0110073", "tt0250638"]) assert.ok(excl("e-hk-new-wave").includes(tt), `Hong Kong: ${tt} (one of the seven action films) is written out`);
  for (const tt of ["tt0094357", "tt0103285", "tt0105839", "tt0220644"]) assert.ok(hk.films.some((f) => f.imdb === tt && f.included), `Hong Kong: ${tt} (one of the four on Wikipedia) stays`);
  const fifth = read("e-china-fifth-gen");
  assert.deepEqual(fifth.years, { min: 1984, max: 2006 });
  for (const tt of ["tt0299977", "tt0385004", "tt0473444"]) assert.ok(excl("e-china-fifth-gen").includes(tt), `Fifth Generation: ${tt} (Hero, House of Flying Daggers, Curse of the Golden Flower) is taken out by name`);
  for (const tt of ["tt0091377", "tt0087301", "tt0116511", "tt0111424"]) assert.ok(excl("e-china-fifth-gen").includes(tt) && !ids("e-china-fifth-gen").includes(tt), `Fifth Generation: ${tt} (a film of another generation) stays out`);
  assert.deepEqual(read("e-polish-school").years, { min: 1955, max: 1965 });
  assert.deepEqual(read("e-moral-anxiety").years, { min: 1975, max: 1989 });
  for (const tt of ["tt0075902", "tt0074220", "tt0075730"]) assert.ok(ids("e-moral-anxiety").includes(tt), `Moral Anxiety: ${tt} (Man of Marble, The Scar, Camouflage) is added`);
  assert.ok(ids("e-nouvelle-vague").includes("tt0060390"), "Fahrenheit 451 is in the Nouvelle Vague, whatever its country");
});

// MARCO, 15/11/2026, second round of questions (what the session had chosen and he CONFIRMED, and the two it did not): Taiwan "Keep 1982–2000, both waves"; Sixth Generation "1990–2018"; Ray and Ghatak "Keep them as precursors";
// Nouvelle Vague "1955–1974"; German Expressionism "Yes, create it"; the 13 noir films outside the three sections "Keep them"; Iranian "Two eras: New Wave 1962–79 and Iranian art cinema 1980–" (he knocked down the session's one era);
// the disputed "Let the British ones in" (and not "Let all 20 in"). Signed 15/11/2026; the session's test no longer carries these.
test("data/eras, MARCO's second round of 15/11/2026: the five confirmed choices, the 13 noir films, and the Iranian eras in two", () => {
  const read = ERA.read, years = (e) => read(e).years, dirs = (e) => read(e).school.directors.map((d) => d.id), ids = (e) => read(e).films.map((f) => f.imdb);
  assert.deepEqual(years("e-taiwan-new-cinema"), { min: 1982, max: 2000 }, "Marco: \"Keep 1982–2000, both waves\"");
  assert.ok(dirs("e-taiwan-new-cinema").includes(71174), "Tsai Ming-liang stays");
  assert.deepEqual(years("e-china-sixth-gen"), { min: 1990, max: 2018 }, "Marco: \"1990–2018\"");
  assert.deepEqual(years("e-parallel-cinema"), { min: 1969, max: 1990 });
  assert.ok(read("e-parallel-cinema").films.some((f) => f.imdb === "tt0048473" && f.outside), "Marco: \"Keep them as precursors\" (Pather Panchali, 1955, a film of Ray that the sources name, by a written exception)");
  assert.deepEqual(years("e-nouvelle-vague"), { min: 1955, max: 1974 }, "Marco: \"1955–1974\"");
  for (const tt of ["tt0048499", "tt0071381"]) assert.ok(ids("e-nouvelle-vague").includes(tt), `Nouvelle Vague: ${tt} (La Pointe Courte, Céline and Julie Go Boating) enters`);
  assert.deepEqual(years("e-german-expressionism"), { min: 1920, max: 1927 }, "Marco: \"Yes, create it\"");
  assert.deepEqual(read("e-german-expressionism").admit, ["core"]);
  // the 13 noir films outside the three sections of the Wikipedia list stay ("Keep them")
  for (const [title, tt] of [["Vertigo", "tt0052357"], ["Rope", "tt0040746"], ["Leave Her to Heaven", "tt0037865"], ["Niagara", "tt0046126"], ["Slightly Scarlet", "tt0049769"], ["Party Girl", "tt0052050"], ["Desert Fury", "tt0039311"], ["The Face Behind the Mask", "tt0033582"], ["Green for Danger", "tt0038577"], ["Angels Over Broadway", "tt0032209"], ["City for Conquest", "tt0032342"], ["A Kiss Before Dying", "tt0049414"], ["The Trap", "tt0053374"]]) assert.ok(ids("e-noir").includes(tt), `noir: ${title} stays`);
  // Iran in two: one era to 1979 and one from 1980 with no last year; each film belongs to ONE of them by its year; a director who crosses 1979 is in both lists
  assert.deepEqual(years("e-iran-new-wave"), { min: 1962, max: 1979 }, "Marco: \"Two eras: New Wave 1962–79 and Iranian art cinema 1980–\"");
  assert.deepEqual(years("e-iran-art-cinema"), { min: 1980 }, "no last year, like Korean cinema 1996–");
  assert.equal(OPTIONS.find((o) => o.id === "e-iran-new-wave").label, "Iranian New Wave 1962–79");
  assert.equal(OPTIONS.find((o) => o.id === "e-iran-art-cinema").label, "Iranian art cinema 1980–");
  assert.ok("Iranian art cinema 1980–".length <= 28);
  for (const id of [119294, 120227, 1098592]) assert.ok(dirs("e-iran-new-wave").includes(id) && dirs("e-iran-art-cinema").includes(id), `director ${id} (Kiarostami, Mehrjui, Beyzaie) crosses 1979: in both lists`);
  assert.ok(dirs("e-iran-art-cinema").includes(229931) && !dirs("e-iran-new-wave").includes(229931), "Farhadi only in the second");
  for (const id of [120226, 120229]) assert.ok(dirs("e-iran-art-cinema").includes(id) && !dirs("e-iran-new-wave").includes(id), `director ${id} (Makhmalbaf, Panahi) only in the second`);
  assert.deepEqual(read("e-iran-new-wave").school.countries, ["IR"]);
  assert.deepEqual(read("e-iran-art-cinema").school.countries, ["IR"]);
  assert.deepEqual(ids("e-iran-new-wave").filter((t) => ids("e-iran-art-cinema").includes(t)), [], "no film in both");
  for (const f of read("e-iran-new-wave").films) assert.ok(f.year <= 1979, `${f.title}: after 1979 it belongs to the second era`);
  for (const f of read("e-iran-art-cinema").films) assert.ok(f.year >= 1980, `${f.title}: before 1980 it belongs to the first era`);
});

test("rule, the Iranian eras: a film of a director who crosses 1979 is in the era of its YEAR (Kiarostami 1975 in the first, 1990 in the second; Farhadi 2011 in the second, the country Iran)", () => {
  const K = { id: 119294, name: "Abbas Kiarostami" }, F = { id: 229931, name: "Asghar Farhadi" };
  const early = film({ year: 1975, iso: "IR", directors: [K] }), late = film({ year: 1990, iso: "IR", directors: [K] }), separation = film({ year: 2011, iso: "IR", directors: [F] }), abroad = film({ year: 2011, iso: "FR", directors: [F] });
  const first = members(ERA.read("e-iran-new-wave"), [early, late, separation, abroad]), second = members(ERA.read("e-iran-art-cinema"), [early, late, separation, abroad]);
  assert.deepEqual(first, [early.entry.tt], "the first era: only the film of 1975");
  assert.deepEqual(second.sort(), [late.entry.tt, separation.entry.tt].sort(), "the second: 1990 and A Separation (2011, no last year); a film of Farhadi made in France is not Iranian cinema");
});

// MARCO, 15/11/2026, "Let the British ones in" (and not "Let all 20 in"): the sources disagree on these four, he decided; the other 16 disputed films stay out. Signed 15/11/2026.
test("data/eras, \"Let the British ones in\": Billy Liar, A Hard Day's Night, Alfie and On the Bowery are in the British New Wave by a written inclusion; the other disputed films stay out (Blowup, Black Sabbath, The Naked Island, Sunrise, Tom Jones)", () => {
  const read = ERA.read, ids = (e) => read(e).films.map((f) => f.imdb);
  for (const [title, tt] of [["Billy Liar", "tt0056868"], ["A Hard Day's Night", "tt0058182"], ["Alfie", "tt0060086"], ["On the Bowery", "tt0050800"]]) {
    const f = read("e-british-new-wave").films.find((x) => x.imdb === tt);
    assert.ok(f && f.included && /Let the British ones in/.test(f.included.why), `${title}: in, by a written decision of Marco`);
  }
  const out = { "e-giallo": [["Blowup", "tt0060176"], ["Black Sabbath", "tt0057603"], ["Le Cercle rouge", "tt0065531"], ["Investigation of a Citizen Above Suspicion", "tt0065889"]], "e-japan-new-wave": [["The Naked Island", "tt0056049"]], "e-german-expressionism": [["Sunrise", "tt0018455"], ["The Phantom of the Opera", "tt0016220"]], "e-british-new-wave": [["Tom Jones", "tt0057590"], ["Three", "tt0065094"], ["The Ragman's Daughter", "tt0069160"]] };
  for (const [era, list] of Object.entries(out)) for (const [title, tt] of list) assert.ok(!ids(era).includes(tt), `${era}: ${title} is disputed and stays out (he did not choose "Let all 20 in")`);
});

// SESSION (authorized by Marco on 15/11/2026: "Apply the research's recommendation in each, and show me the result"): each of these is the session's choice, following the research or (marked) differing from it, and Marco can
// knock it down when he sees the table. The curation may move them with its reason and source, and the test says so here.
test("data/eras, CHOSEN BY THE SESSION (authorized by Marco on 15/11/2026): the years, the lists of directors and the films of the rest of the sheet", () => {
  const read = ERA.read, years = (e) => read(e).years, dirs = (e) => read(e).school.directors.map((d) => d.id), ids = (e) => read(e).films.map((f) => f.imdb);
  assert.equal(OPTIONS.find((o) => o.id === "e-korean-new-wave").label, "Korean cinema 1996–");
  assert.deepEqual(years("e-japan-new-wave"), { min: 1956, max: 1974 });
  assert.ok(!dirs("e-japan-new-wave").includes(81273), "Masumura is not a director of the era: he enters only by the films a source names");
  for (const [title, tt] of [["Harakiri", "tt0056058"], ["Kwaidan", "tt0058279"], ["The Sword of Doom", "tt0060277"], ["Kill!", "tt0063186"], ["Sword of the Beast", "tt0200768"]]) assert.ok(ids("e-japan-new-wave").includes(tt), `Japanese New Wave: ${title}`);
  assert.ok(dirs("e-parallel-cinema").includes(12160) && !dirs("e-parallel-cinema").includes(125354), "Satyajit Ray in (Marco, 14/11), Guru Dutt out");
  for (const tt of ["tt0046521", "tt0047528", "tt0042355"]) assert.ok(read("e-neorealism").films.some((f) => f.imdb === tt && f.included), `Neorealism: ${tt} (I Vitelloni, La Strada, Story of a Love Affair) enters by the film`);
  assert.deepEqual(years("e-neorealism"), { min: 1943, max: 1955 });
  assert.ok(!dirs("e-polish-school").includes(3556) && !dirs("e-polish-school").includes(43553), "Polanski and Skolimowski are not directors of the Polish School");
  assert.ok(ids("e-polish-school").includes("tt0056291"), "Knife in the Water, the one Polanski film of the era");
  assert.deepEqual(years("e-cinema-novo"), { min: 1955, max: 1975 });
  for (const id of ["e-poetic-realism", "e-new-german", "e-czech-new-wave"]) assert.ok(read(id).type === "school", `${id}: no change, still a school`);
  // not created: Soviet montage, the Korean New Wave 1980–95 (it needs 20 films after the rating floor), the three eras with one source each
  const optionIds = OPTIONS.map((o) => o.id);
  for (const id of ["e-soviet-montage", "e-korean-new-wave-1980s", "e-direct-cinema", "e-new-queer", "e-third-cinema"]) assert.ok(!optionIds.includes(id), `${id} is not created`);
  assert.ok(optionIds.includes("e-late-soviet") && OPTIONS.find((o) => o.id === "e-late-soviet").label === "Late Soviet 1968–91", "Late Soviet keeps its label");
  assert.ok(OPTIONS.find((o) => o.id === "e-hk-kung-fu").label === "HK kung fu 1970–85" && OPTIONS.find((o) => o.id === "e-hk-kung-fu").where.years.min === 1970);
});

// What Marco decided on 14/11/2026 and still stands after 15/11: Satyajit Ray in the Indian Parallel Cinema with Guru Dutt out; China and Poland in two eras each (the four ids and not the two old ones);
// Kieślowski once in Moral Anxiety; Neorealism to 1955. SUPERSEDED on 15/11: the six names out of New Hollywood and the 45 authors (New Hollywood is a list of what institutions name); Giallo by director with Petri and
// Avati out (Giallo is a list); "without Loach and Furie" (Loach is back in the British New Wave).
test("data/eras, Marco's decisions of 14/11/2026 that still stand: Ray in and Guru Dutt out; China and Poland in two eras each; Kieślowski once; Żuławski in neither Polish era", () => {
  const ids = (era) => ERA.read(era).school.directors.map((d) => d.id);
  assert.ok(ids("e-parallel-cinema").includes(12160) && !ids("e-parallel-cinema").includes(125354));
  const optionIds = OPTIONS.map((o) => o.id);
  for (const id of ["e-china-fifth-gen", "e-china-sixth-gen", "e-polish-school", "e-moral-anxiety"]) assert.ok(optionIds.includes(id), id);
  for (const id of ["e-china-new-waves", "e-polish-cinema"]) assert.ok(!optionIds.includes(id), `${id} was split in two on 14/11/2026`);
  assert.deepEqual(ids("e-china-sixth-gen").filter((id) => ids("e-china-fifth-gen").includes(id)), [], "no director in both Chinese generations");
  assert.ok(ids("e-moral-anxiety").includes(2801) && ids("e-polish-school").includes(2801), "Wajda in both Polish eras");
  for (const era of ["e-polish-school", "e-moral-anxiety"]) assert.ok(!ids(era).includes(32082), `${era}: Żuławski in neither`);
  assert.equal(ids("e-moral-anxiety").filter((id) => id === 1126).length, 1, "Kieślowski once");
});
