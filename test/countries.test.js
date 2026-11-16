// node --test            (no dependencies)
// The flag on the cover: which country a film has (TMDB first, then its Letterboxd page), which flag code that is, and the flag pictures
// in cache/flags (lib/countries.js, tools/selo/countries.json, tools/selo/fetch-flags.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const C = require("../lib/countries");

const ROOT = path.join(__dirname, "..");
const tmp = (p = "mood-flags-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const noSleep = async () => {};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]);
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, arrayBuffer: async () => body });

test("country names: Letterboxd's spellings and the Discover menu's land on the right flag; case, accents and & do not matter", () => {
  const want = {
    USA: "us", "United States": "us", UK: "gb", "United Kingdom": "gb", Japan: "jp", Brazil: "br", France: "fr", Germany: "de", Italy: "it", Canada: "ca", Spain: "es",
    "South Korea": "kr", "Hong Kong": "hk", "Hong Kong SAR China": "hk", Taiwan: "tw", Macau: "mo", Poland: "pl", Czechia: "cz", "Czech Republic": "cz",
    "Côte d’Ivoire": "ci", "cote d'ivoire": "ci", "State of Palestine": "ps", "Democratic Republic of Congo": "cd", Congo: "cg", "Cabo Verde": "cv", "Bosnia and Herzegovina": "ba", "Bosnia & Herzegovina": "ba",
    TÜRKIYE: "tr", Turkey: "tr", "  japan  ": "jp",
  };
  for (const [name, cc] of Object.entries(want)) assert.equal(C.flagOfName(name), cc, name);
  assert.equal(C.flagOfName("Atlantis"), null);
  assert.equal(C.flagOfName(""), null);
  assert.equal(C.flagOfName(null), null);
});

test("countries that no longer exist show their successor's flag (flagcdn has no 'su' and no 'yu'): Soviet Union and USSR → ru, Czechoslovakia → cz, Yugoslavia → rs, both Germanys → de", () => {
  const want = { "Soviet Union": "ru", USSR: "ru", Czechoslovakia: "cz", Yugoslavia: "rs", "Serbia and Montenegro": "rs", "West Germany": "de", "East Germany": "de", "Netherlands Antilles": "nl" };
  for (const [name, cc] of Object.entries(want)) assert.equal(C.flagOfName(name), cc, name);
  const codes = { SU: "ru", XC: "cz", YU: "rs", CS: "rs", XG: "de", DD: "de", AN: "nl", XI: "gb" };
  for (const [iso, cc] of Object.entries(codes)) assert.equal(C.flagOfCode(iso), cc, iso);
});

test("TMDB codes: a code the table knows is its own flag in lower case; one it does not know, or not two letters, gives nothing", () => {
  assert.equal(C.flagOfCode("US"), "us");
  assert.equal(C.flagOfCode("jp"), "jp");
  assert.equal(C.flagOfCode(" BR "), "br");
  assert.equal(C.flagOfCode("XK"), "xk");
  for (const bad of ["ZZ", "", null, undefined, "USA", "U", "1A"]) assert.equal(C.flagOfCode(bad), null, String(bad));
});

// ── which country: the four steps of the rule (v2.3) ─────────────────────────

const pick = (o) => C.pickCountry(o);

test("step 1+2, the language is spoken in several countries: the first production country (in TMDB's order) that speaks it wins", () => {
  assert.deepEqual(pick({ lang: "pt", tmdb: ["BR", "FR"] }), { cc: "br", from: "language" });
  assert.deepEqual(pick({ lang: "pt", tmdb: ["FR", "BR"] }), { cc: "br", from: "language" }); // not the first country: the first that speaks Portuguese
  assert.deepEqual(pick({ lang: "pt", tmdb: ["PT"] }), { cc: "pt", from: "language" });
  assert.deepEqual(pick({ lang: "en", tmdb: ["GB", "US"] }), { cc: "gb", from: "language" });
  assert.deepEqual(pick({ lang: "en", tmdb: ["US", "GB"] }), { cc: "us", from: "language" });
  assert.deepEqual(pick({ lang: "zh", tmdb: ["HK"] }), { cc: "hk", from: "language" });
  assert.deepEqual(pick({ lang: "zh", tmdb: ["TW"] }), { cc: "tw", from: "language" });
  assert.deepEqual(pick({ lang: "zh", tmdb: ["CN", "HK"] }), { cc: "cn", from: "language" });
  assert.deepEqual(pick({ lang: "en", tmdb: ["FR", "DE", "PL", "GB"] }), { cc: "gb", from: "language" }); // The Pianist
  assert.deepEqual(pick({ lang: "fr", tmdb: ["BE", "FR"] }), { cc: "be", from: "language" });
  assert.deepEqual(pick({ lang: "es", tmdb: ["US", "MX"] }), { cc: "mx", from: "language" });
  assert.deepEqual(pick({ lang: "de", tmdb: ["CH", "DE"] }), { cc: "ch", from: "language" });
  assert.deepEqual(pick({ lang: "cn", tmdb: ["HK", "CN"] }), { cc: "hk", from: "language" }); // TMDB writes cn for Cantonese
  // a country that no longer exists is compared as its successor: the Soviet film in Russian, the Czechoslovak one in Czech
  assert.deepEqual(pick({ lang: "ru", tmdb: ["SU"] }), { cc: "ru", from: "language" });
  assert.deepEqual(pick({ lang: "cs", tmdb: ["XC"] }), { cc: "cz", from: "language" });
  assert.deepEqual(pick({ lang: "sr", tmdb: ["YU"] }), { cc: "rs", from: "language" });
  assert.deepEqual(pick({ lang: "PT-br", tmdb: ["fr", "br"] }), { cc: "br", from: "language" }); // the language and the codes are read loosely
});

test("step 3, no production country speaks the language (or TMDB lists none): the language's default country", () => {
  assert.deepEqual(pick({ lang: "en", tmdb: ["FR"] }), { cc: "us", from: "language-default" });
  assert.deepEqual(pick({ lang: "pt", tmdb: ["FR", "DE"] }), { cc: "br", from: "language-default" });
  assert.deepEqual(pick({ lang: "ja", tmdb: ["US"] }), { cc: "jp", from: "language-default" });
  assert.deepEqual(pick({ lang: "zh", tmdb: ["US"] }), { cc: "cn", from: "language-default" });
  assert.deepEqual(pick({ lang: "pt", tmdb: [] }), { cc: "br", from: "language-default" });
  assert.deepEqual(pick({ lang: "ar", tmdb: ["FR"] }), { cc: "eg", from: "language-default" });
  assert.deepEqual(pick({ lang: "en", tmdb: ["ZZ"], lb: ["France"] }), { cc: "us", from: "language-default" }); // a language settles it: the Letterboxd page is not asked
  assert.deepEqual(pick({ lang: "cn", tmdb: ["FR"] }), { cc: "hk", from: "language-default" });
});

test("step 4, no usable language: the first TMDB production country, else the first on the Letterboxd page (what v2.2 did for every film), else nothing", () => {
  assert.deepEqual(pick({ tmdb: ["FR", "DE", "PL", "GB"], lb: ["Poland"] }), { cc: "fr", from: "production" });
  assert.deepEqual(pick({ tmdb: ["SU"], lb: ["USA"] }), { cc: "ru", from: "production" });
  assert.deepEqual(pick({ tmdb: [], lb: ["USSR", "Poland"] }), { cc: "ru", from: "letterboxd" });
  assert.deepEqual(pick({ lb: ["Japan"] }), { cc: "jp", from: "letterboxd" });
  assert.deepEqual(pick({ tmdb: ["ZZ", "BR"], lb: ["Japan"] }), { cc: "br", from: "production" }); // a code nobody knows is skipped, the next one is used
  assert.deepEqual(pick({ tmdb: ["ZZ"], lb: ["Atlantis", "Brazil"] }), { cc: "br", from: "letterboxd" });
  assert.equal(pick({ tmdb: ["ZZ"], lb: ["Atlantis"] }), null);
  assert.equal(pick({}), null);
  assert.equal(C.pickCountry(), null);
  // what is not a usable language: none, TMDB's "xx" (no spoken language), a language the table has no entry for, a language with no country (Esperanto)
  for (const lang of [null, undefined, "", "xx", "XX", "zxx", "qq", "eo", "x", "english"]) assert.deepEqual(pick({ lang, tmdb: ["FR", "GB"] }), { cc: "fr", from: "production" }, String(lang));
});

test("the language of a film is read loosely: case, a region suffix, TMDB's 'xx'", () => {
  assert.equal(C.languageCode("EN"), "en");
  assert.equal(C.languageCode("pt-BR"), "pt");
  assert.equal(C.languageCode(" cn "), "cn");
  for (const bad of ["xx", "", null, undefined, "e", "e1"]) assert.equal(C.languageCode(bad), null, String(bad));
  assert.deepEqual(C.countriesOfLanguage("PT-br").slice(0, 2), ["br", "pt"]);
  assert.equal(C.countriesOfLanguage("qq"), null);
  assert.equal(C.countriesOfLanguage(null), null);
});

test("language-countries.json: the default country of every language Marco listed; every code is a flag the table has; no list repeats a country", () => {
  const defaults = { en: "us", es: "es", pt: "br", fr: "fr", de: "de", zh: "cn", ar: "eg", ja: "jp", ko: "kr", it: "it", ru: "ru", hi: "in", sv: "se", da: "dk", no: "no", fi: "fi", pl: "pl", cs: "cz", hu: "hu", el: "gr", tr: "tr", fa: "ir", he: "il", th: "th", vi: "vn", id: "id", nl: "nl", ro: "ro", uk: "ua", sr: "rs", hr: "hr" };
  for (const [lang, cc] of Object.entries(defaults)) assert.equal(C.countriesOfLanguage(lang)[0], cc, lang);
  const known = new Set(C.allFlagCodes());
  const langs = C.loadLanguages();
  assert.ok(langs.size >= 100, `${langs.size} languages`);
  for (const [lang, list] of langs) {
    assert.match(lang, /^[a-z]{2,3}$/, lang);
    assert.deepEqual(list.filter((cc) => !known.has(cc)), [], `${lang}: a code with no flag`);
    assert.equal(new Set(list).size, list.length, `${lang}: a country twice`);
  }
  assert.ok(!langs.has("xx"), "'xx' is not a language");
  // the ones that matter to the rule: several countries
  assert.deepEqual(["en", "es", "pt", "fr", "de", "zh", "ar", "nl", "it", "ru", "sv"].filter((l) => langs.get(l).length < 2), []);
});

test("tmdbFacts: a film known under two TMDB ids gives the first record's countries and the first language; a record with a language and no countries still gives the language; 'xx' is no language", () => {
  assert.deepEqual(C.tmdbFacts([{ countries: [], lang: "pt" }]), { countries: [], language: "pt" });
  assert.deepEqual(C.tmdbFacts([{ countries: [], lang: "xx" }, { countries: ["BE", "FR"], lang: "fr" }]), { countries: ["BE", "FR"], language: "fr" });
  assert.deepEqual(C.tmdbFacts([{ countries: ["JP"], lang: "ja" }, { countries: ["US"], lang: "en" }]), { countries: ["JP"], language: "ja" });
  assert.deepEqual(C.tmdbFacts([{ countries: ["US"] }]), { countries: ["US"], language: null });
  assert.deepEqual(C.tmdbFacts([]), { countries: [], language: null });
  assert.deepEqual(C.tmdbFacts(undefined), { countries: [], language: null });
  assert.deepEqual(C.tmdbFacts([null, { countries: ["IT"], lang: "it" }]), { countries: ["IT"], language: "it" });
});

test("attachCountries: every target gets its flag code, the step that decided and the v2.2 flag; the counts say how many came from which step and how many changed", () => {
  const targets = new Map([["tt1", { tt: "tt1" }], ["tt2", { tt: "tt2" }], ["tt3", { tt: "tt3" }], ["tt4", { tt: "tt4" }], ["tt5", { tt: "tt5" }], ["tt6", { tt: "tt6" }]]);
  const tmdb = { tt1: ["FR", "DE", "PL", "GB"], tt4: ["JP"], tt5: ["FR"], tt6: ["FR"] }, lb = { tt1: ["Poland"], tt2: ["USSR"] }, lang = { tt1: "en", tt4: "ja", tt5: "en", tt6: "qq" };
  const n = C.attachCountries(targets, { tmdbCountries: (t) => tmdb[t.tt] || [], lbCountries: (t) => lb[t.tt] || [], language: (t) => lang[t.tt] || null });
  // 23/10/2026 (Marco: "Bandeira passa a seguir o país do cartão já"): the flag is the flag of the film's MAIN country (lib/countries.js mainCountry). tt5, an English-language film produced in
  // France alone, was the default country of English (us, "language-default") and is now France's, the card's country: ccFrom "main" because the flag is not the one the v2.3 rule gave.
  // Every other target keeps the v2.3 flag AND its ccFrom (lib/posters.js puts `rule` in the hash of a cover, so a cover whose flag does not change is not drawn again).
  assert.deepEqual(n, { language: 2, languageDefault: 0, production: 1, letterboxd: 1, none: 1, main: 1, changed: 1, unknownLanguages: { qq: 1 } });
  assert.deepEqual([...targets.values()].map((t) => [t.cc, t.ccFrom, t.ccV22]), [["gb", "language", "fr"], ["ru", "letterboxd", "ru"], [null, null, null], ["jp", "language", "jp"], ["fr", "main", "fr"], ["fr", "production", "fr"]]);
});

// ── the pictures ─────────────────────────────────────────────────────────────

test("fetchFlag: a PNG is returned from flagcdn's w80 address; a 404 or something that is not a PNG is refused at once; a 5xx is retried", async () => {
  const urls = [];
  assert.equal((await C.fetchFlag("jp", { fetchImpl: async (u) => (urls.push(u), reply(PNG)), sleepImpl: noSleep })).length, PNG.length);
  assert.deepEqual(urls, ["https://flagcdn.com/w80/jp.png"]);
  let n = 0;
  await assert.rejects(C.fetchFlag("zz", { fetchImpl: async () => (n++, reply(Buffer.alloc(0), 404)), sleepImpl: noSleep }), /404/);
  assert.equal(n, 1);
  await assert.rejects(C.fetchFlag("jp", { fetchImpl: async () => reply(Buffer.from("<html>" + "x".repeat(500))), sleepImpl: noSleep }), /not a PNG/);
  await assert.rejects(C.fetchFlag("jp", { fetchImpl: async () => reply(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1])), sleepImpl: noSleep }), /not a PNG/); // a tiny body
  let k = 0;
  assert.ok((await C.fetchFlag("jp", { fetchImpl: async () => (++k < 3 ? reply(Buffer.alloc(0), 503) : reply(PNG)), sleepImpl: noSleep })).length > 0);
  assert.equal(k, 3);
});

test("ensureFlags: only the flags that are not in the folder are downloaded; one that fails is reported and leaves nothing behind; no temp file stays", async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "us.png"), PNG);
    const asked = [];
    const fetchImpl = async (u) => { asked.push(u.split("/").pop()); return /zz\.png/.test(u) ? reply(Buffer.alloc(0), 404) : reply(PNG); };
    const r = await C.ensureFlags(["us", "jp", "br", "zz", "jp"], { dir, fetchImpl, sleepImpl: noSleep });
    assert.deepEqual([r.present, r.downloaded, r.failed.map((f) => f.cc)], [1, 2, ["zz"]]);
    assert.deepEqual(asked.sort(), ["br.png", "jp.png", "zz.png"]);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["br.png", "jp.png", "us.png"]);
    const again = await C.ensureFlags(["us", "jp", "br"], { dir, fetchImpl: async () => assert.fail("nothing to download"), sleepImpl: noSleep });
    assert.deepEqual([again.present, again.downloaded], [3, 0]);
  } finally { rm(dir); }
});

test("ensureFlags: with everything already there it creates nothing (a folder that does not exist stays absent)", async () => {
  const dir = path.join(tmp(), "never");
  try {
    const r = await C.ensureFlags([], { dir, fetchImpl: async () => assert.fail("no") });
    assert.deepEqual([r.present, r.downloaded, r.failed], [0, 0, []]);
    assert.ok(!fs.existsSync(dir));
  } finally { rm(path.dirname(dir)); }
});

// ── the committed data ───────────────────────────────────────────────────────

test("cache/flags has a real PNG for every flag the table can produce", { skip: !fs.existsSync(path.join(ROOT, "cache", "flags")) && "no cache/flags" }, () => {
  const codes = C.allFlagCodes();
  assert.ok(codes.length >= 200, `${codes.length} flag codes`);
  const missing = codes.filter((cc) => !fs.existsSync(C.flagFile(path.join(ROOT, "cache", "flags"), cc)));
  assert.deepEqual(missing, []);
  const broken = codes.filter((cc) => !C.isPng(fs.readFileSync(C.flagFile(path.join(ROOT, "cache", "flags"), cc))));
  assert.deepEqual(broken, []);
  for (const cc of ["us", "gb", "fr", "jp", "br", "ru", "hk", "tw", "cz", "rs", "de", "pl"]) assert.ok(codes.includes(cc), cc); // the ones the menu and the pool use most
});

test("every country spelled in the committed caches has a flag: Letterboxd's names in cache/friends.json and TMDB's codes in cache/tmdb.json", { skip: !fs.existsSync(path.join(ROOT, "cache", "friends.json")) && "no caches" }, () => {
  const lbNames = new Set(), codes = new Set();
  for (const r of Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "friends.json"), "utf8")).films || {})) for (const n of r.c || []) lbNames.add(n);
  for (const e of Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "tmdb.json"), "utf8")).movie || {})) for (const c of (e.v && e.v.countries) || []) codes.add(c);
  assert.ok(lbNames.size > 100 && codes.size > 50, `${lbNames.size} names, ${codes.size} codes`);
  assert.deepEqual([...lbNames].filter((n) => !C.flagOfName(n)), []);
  assert.deepEqual([...codes].filter((c) => !C.flagOfCode(c)), []);
});

test("original languages use the frozen v2.3 table or one of nine documented production-country fallbacks", { skip: !fs.existsSync(path.join(ROOT, "cache", "tmdb.json")) && "no caches" }, () => {
  const seen = {};
  for (const e of Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "tmdb.json"), "utf8")).movie || {})) { const l = C.languageCode(e.v && e.v.lang); if (l) seen[l] = (seen[l] || 0) + 1; }
  assert.ok(Object.keys(seen).length >= 20, `${Object.keys(seen).length} languages in the cache`);
  // Main d503ae0 has these nine gaps. Preserve its table and test the existing fallback;
  // a new unsupported language still fails and must be reviewed explicitly.
  const known = new Set(["tn", "se", "iu", "ff", "ks", "ay", "lg", "rw", "om"]);
  const missing = Object.keys(seen).filter((l) => C.countriesOfLanguage(l) === null);
  assert.deepEqual(missing.filter((l) => !known.has(l)), []);
  for (const lang of missing) assert.deepEqual(C.pickCountry({ lang, tmdb: ["FR"] }), { cc: "fr", from: "production" });
});

test("The Pianist, from the real TMDB cache: original language English, production FR, DE, PL, GB -> the United Kingdom's flag, not France's (v2.2) and not Poland's", { skip: !fs.existsSync(path.join(ROOT, "cache", "tmdb.json")) && "no caches" }, () => {
  const film = Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "tmdb.json"), "utf8")).movie).map((e) => e.v).find((v) => v && v.imdb === "tt0253474");
  assert.ok(film, "The Pianist is in the cache");
  assert.equal(film.lang, "en");
  assert.deepEqual(film.countries, ["FR", "DE", "PL", "GB"]);
  assert.deepEqual(C.pickCountry({ tmdb: film.countries, lang: film.lang }), { cc: "gb", from: "language" });
  assert.deepEqual(C.pickCountry({ tmdb: film.countries }), { cc: "fr", from: "production" }); // the v2.2 answer
  // the other four sample covers keep their country: Japanese, Brazilian and Soviet films in their own languages
  const by = Object.fromEntries(Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "tmdb.json"), "utf8")).movie).map((e) => e.v).filter(Boolean).map((v) => [v.imdb, v]));
  const flag = (tt) => C.pickCountry({ tmdb: by[tt].countries, lang: by[tt].lang }).cc;
  assert.deepEqual([flag("tt0047478"), flag("tt0317248"), flag("tt0079944")], ["jp", "br", "ru"]); // Seven Samurai (ja), City of God (pt), Stalker (ru, produced in the SU)
});
