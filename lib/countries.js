// The country flag a cover shows next to the year (top left). Marco, 10/10/2026: "year it was released and country flag", and, later that
// night, "the flag follows the film's main language".
//
//   1  which country   in this order (v2.3):
//                        a. the film's original language (TMDB's original_language, cache/tmdb.json). The Letterboxd page has one too
//                           (/films/language/<name>/) but the parser does not read it, so a film TMDB does not know has no language.
//                        b. a language is spoken in more than one country: of the film's TMDB production countries, in TMDB's order, the
//                           first one whose official or majority language it is (tools/selo/language-countries.json, language -> countries).
//                           "pt" + [FR, BR] -> BR; "en" + [FR, DE, PL, GB] -> GB; "zh" + [HK] -> HK.
//                        c. none of the production countries speaks it (or TMDB lists none): the language's default country, the first of
//                           its list in the table (en -> us, pt -> br, zh -> cn, ar -> eg ...).
//                        d. no language (a film TMDB does not know, "xx", or a language the table lacks): the first TMDB production country
//                           (ISO 3166-1 alpha-2), else the first country on its Letterboxd page (an English name: "USA", "Japan", "USSR"),
//                           which is what v2.2 did for every film.
//                      Nothing at all: no flag, the cover shows the year alone.
//   Since 23/10/2026 (Marco: "Bandeira passa a seguir o país do cartão já") the flag is the flag of the film's MAIN country (mainCountry below: the director's country, then TMDB's origin), the same country as
//   the card and the Board's region; the steps a-d above are the fallback (a film TMDB does not know, a country the flag table lacks) and the names `ccFrom` keeps when the flag is the same.
//   2  which flag      tools/selo/countries.json turns either spelling into a flag code (lowercase alpha-2). Countries that no longer
//                      exist take their successor's flag (Soviet Union -> ru, Czechoslovakia -> cz, Yugoslavia -> rs, both Germanys -> de):
//                      flagcdn.com has no "su" and no "yu".
//   3  the picture     https://flagcdn.com/w80/<code>.png, downloaded once into cache/flags/<code>.png (committed: about 250 files of a few
//                      hundred bytes). A flag that cannot be downloaded is not drawn; the cover then shows the year alone and the log counts it.
//                      A flag is an image, never an emoji: the GitHub runner has no emoji font.
//
// Pure functions and the small downloader; the network is injected.

const fs = require("fs");
const path = require("path");
const { mapLimit, sleep, limitedFetch } = require("./util");

const TABLE_FILE = path.join(__dirname, "..", "tools", "selo", "countries.json");
const FLAG_URL = (cc) => `https://flagcdn.com/w80/${cc}.png`;

/** "Côte d’Ivoire" → "cote d ivoire"; "Bosnia & Herzegovina" → "bosnia and herzegovina": case, accents, "&" and punctuation do not matter. */
const key = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

function loadTable(file = TABLE_FILE) {
  const t = JSON.parse(fs.readFileSync(file, "utf8"));
  const byName = new Map(Object.entries(t.names || {}).map(([n, c]) => [key(n), c]));
  const byCode = new Map(Object.entries(t.codes || {}).map(([k, c]) => [k.toLowerCase(), c]));
  const known = new Set([...Object.values(t.names || {}), ...Object.values(t.codes || {})]);
  return { byName, byCode, known };
}
let TABLE = null;
const table = () => TABLE || (TABLE = loadTable());

const LANGUAGES_FILE = path.join(__dirname, "..", "tools", "selo", "language-countries.json");

/** tools/selo/language-countries.json → Map(language → [flag codes, the default country first]). */
function loadLanguages(file = LANGUAGES_FILE) {
  const t = JSON.parse(fs.readFileSync(file, "utf8"));
  return new Map(Object.entries(t.languages || {}).map(([lang, list]) => [lang.toLowerCase(), list.map((c) => String(c).toLowerCase())]));
}
let LANGUAGES = null;
const languages = () => LANGUAGES || (LANGUAGES = loadLanguages());

/** TMDB's original_language ("en", "pt", "cn", "xx", sometimes "pt-BR") → the language to look up, or null for none ("xx" is TMDB's "no spoken language"). */
function languageCode(x) {
  const c = String(x == null ? "" : x).trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(c) && c !== "xx" && c !== "zxx" ? c : null;
}

/** The countries that speak a language, default first, or null when the table has no entry for it (an empty list means a language with no country). */
function countriesOfLanguage(lang, l = languages()) {
  const c = languageCode(lang);
  return c && l.has(c) ? l.get(c) : null;
}

/** A country's name as Letterboxd or the Discover menu spells it → its flag code, or null when the table does not know it. "USA" → "us", "USSR" → "ru". */
function flagOfName(name, t = table()) {
  return t.byName.get(key(name)) || null;
}

/** A TMDB code → its flag code, or null. "US" → "us"; "SU" → "ru" (no flag of its own); a code nobody knows ("ZZ") → null. */
function flagOfCode(iso, t = table()) {
  const c = String(iso || "").trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(c)) return null;
  return t.byCode.get(c) || (t.known.has(c) ? c : null);
}

/**
 * The country of one film: { cc, from } or null. `from` says which step of the rule decided (see the header):
 *   "language"          the first production country that speaks the film's main language
 *   "language-default"  none of them does (or there is none): the language's default country
 *   "production"        no usable language: the first TMDB production country
 *   "letterboxd"        no usable language and no TMDB country: the first country on the Letterboxd page
 * tmdb: its production countries in TMDB's order (codes); lb: its countries on the Letterboxd page in the page's order (names);
 * lang: its original language, or null. A country the table has no flag for is skipped, in every step.
 */
function pickCountry({ tmdb = [], lb = [], lang = null } = {}, t = table(), l = languages()) {
  const spoken = countriesOfLanguage(lang, l);
  if (spoken && spoken.length) {
    for (const iso of tmdb || []) { const cc = flagOfCode(iso, t); if (cc && spoken.includes(cc)) return { cc, from: "language" }; }
    return { cc: spoken[0], from: "language-default" };
  }
  for (const iso of tmdb || []) { const cc = flagOfCode(iso, t); if (cc) return { cc, from: "production" }; }
  for (const name of lb || []) { const cc = flagOfName(name, t); if (cc) return { cc, from: "letterboxd" }; }
  return null;
}

/**
 * Gives every target of collectTargets() its `cc` (flag code or null) and `ccFrom` (the step that decided), and `ccV22`: the flag the v2.2
 * rule (the first production country, whatever the language) would have given, to count how many covers change.
 * tmdbCountries(target) → the TMDB country codes of the film; lbCountries(target) → the Letterboxd country names; language(target) → its original language;
 * tmdbOrigin(target) → TMDB's origin_country; directors(target) → [{ id }]: the facts mainCountry needs (Marco, 23/10/2026: "Bandeira passa a seguir o país do cartão já").
 * The flag is the flag of the film's MAIN country (mainCountry): the same country as the card and the region. When the film has none, or the flag table does not know it, the rule of v2.3
 * above decides as before (and the Letterboxd page when TMDB has nothing). `ccFrom` is the step of the v2.3 rule when its flag is the main country's (so a cover whose flag does not change keeps the
 * hash it was drawn with: lib/posters.js puts `rule` in it), and "main" when the main country gives another flag than the v2.3 rule did.
 * → { language, languageDefault, production, letterboxd, none, main, changed, unknownLanguages: { code: films } } (`main`: the covers whose flag the main country changed)
 */
function attachCountries(targets, { tmdbCountries = () => [], lbCountries = () => [], language = () => null, tmdbOrigin = () => undefined, directors = () => [] } = {}, t = table(), l = languages()) {
  const n = { language: 0, languageDefault: 0, production: 0, letterboxd: 0, none: 0, main: 0, changed: 0, unknownLanguages: {} };
  const key2 = { language: "language", "language-default": "languageDefault", production: "production", letterboxd: "letterboxd", main: "main" };
  for (const target of targets.values()) {
    const tmdb = tmdbCountries(target), lb = lbCountries(target), lang = languageCode(language(target));
    if (lang && !l.has(lang)) n.unknownLanguages[lang] = (n.unknownLanguages[lang] || 0) + 1;
    let p = pickCountry({ tmdb, lb, lang }, t, l);
    const old = pickCountry({ tmdb, lb }, t, l);
    const iso = mainCountry({ countries: tmdb, lang, origin: tmdbOrigin(target), directors: directors(target) }, t, l);
    const cc = iso ? flagOfCode(iso, t) : null;
    if (cc && !(p && p.cc === cc)) p = { cc, from: "main" };
    target.cc = p ? p.cc : null;
    target.ccFrom = p ? p.from : null;
    target.ccV22 = old ? old.cc : null;
    n[p ? key2[p.from] : "none"]++;
    if (target.cc !== target.ccV22) n.changed++;
  }
  return n;
}

/**
 * What a film's TMDB records say (a film can be known under more than one TMDB id): its production countries (the first record that lists any)
 * and its original language (the first record that has one; "xx" is no language). A record with a language and no countries still gives the language.
 */
function tmdbFacts(records) {
  const rs = (records || []).filter(Boolean);
  return { countries: (rs.find((d) => d.countries && d.countries.length) || {}).countries || [], language: (rs.find((d) => languageCode(d.lang)) || {}).lang || null };
}

/** The two other facts of mainCountry from a film's TMDB records, taken from the record tmdbFacts() takes the countries from (the first that lists any, else the first): { origin, directors: [{ id }] }. */
function tmdbMain(records) {
  const rs = (records || []).filter(Boolean);
  const r = rs.find((d) => d.countries && d.countries.length) || rs[0] || {};
  return { origin: Array.isArray(r.origin) ? r.origin : undefined, directors: (r.directors || []).map((d) => ({ id: d.id })) };
}

// ── regions of the v2 Board (Marco, 13/10/2026, board-final.md) ─────────────────────────────────────────────────────────────────────────────
// A region is a set of ISO 3166-1 alpha-2 codes as TMDB writes them in `production_countries` (so "SU", "XC", "XG", "YU" are there and a flag code is not: the flag of
// East Germany is Germany's). A film belongs to a region through its MAIN country, mainCountry() below (the director's country first, then TMDB's origin_country, since 23/10/2026; mainIso() is the rule it falls back to). Decisions of Marco: Europe has no GB/IE, no Nordic and no Eastern
// bloc (each has a row of its own); Asia has no India; Egypt is Middle East, the Maghreb is Africa; Brazil is Latin America with the Spanish-speaking Americas.
const REGIONS = Object.freeze({
  "latin-america": ["BR", "AR", "MX", "CL", "UY", "CO", "PE", "VE", "CU", "BO", "EC", "PY", "CR", "GT", "DO", "PR", "SV", "HN", "NI", "PA"],
  // the Spanish-speaking Americas alone: the third part of the combined "Latin America" row (Brazil is the other two); the only region inside another one
  "latam-hisp": ["AR", "MX", "CL", "UY", "CO", "PE", "VE", "CU", "BO", "EC", "PY", "CR", "GT", "DO", "PR", "SV", "HN", "NI", "PA"],
  europe: ["FR", "IT", "ES", "PT", "DE", "AT", "CH", "BE", "NL", "LU", "GR", "MT", "CY", "MC", "LI", "AD", "SM"],
  british: ["GB", "IE", "XI"], // XI: Northern Ireland, the code TMDB keeps for it (The Lost City of Z lists "XI"); added 22/10/2026 with its label (lib/pool.js PT_NAMES)
  nordic: ["DK", "SE", "NO", "FI", "IS"],
  "eastern-bloc": ["SU", "RU", "PL", "CZ", "XC", "CS", "SK", "HU", "RO", "YU", "RS", "HR", "BA", "SI", "MK", "ME", "XK", "XG", "DD", "BG", "AL", "UA", "BY", "GE", "AM", "AZ", "LT", "LV", "EE", "MD", "KZ"],
  "middle-east": ["IR", "TR", "IL", "LB", "EG", "PS", "SY", "IQ", "JO", "SA", "AE", "KW", "QA", "BH", "OM", "YE"],
  india: ["IN"],
  asia: ["KR", "KP", "JP", "CN", "HK", "MO", "TW", "MN", "TH", "PH", "VN", "ID", "MY", "SG", "KH", "LA", "MM", "BN", "TL"],
  // the 54 African states of the UN less Egypt (53 codes), and ZR, Zaire, the code TMDB keeps for old films
  africa: ["DZ", "AO", "BJ", "BW", "BF", "BI", "CV", "CM", "CF", "TD", "KM", "CG", "CD", "CI", "DJ", "GQ", "ER", "SZ", "ET", "GA", "GM", "GH", "GN", "GW", "KE", "LS", "LR", "LY", "MG", "MW", "ML", "MR", "MU", "MA", "MZ", "NA", "NE", "NG", "RW", "ST", "SN", "SC", "SL", "SO", "ZA", "SS", "SD", "TZ", "TG", "TN", "UG", "ZM", "ZW", "ZR"],
});
const REGION_SETS = new Map(Object.entries(REGIONS).map(([name, codes]) => [name, new Set(codes)]));

// A language whose films without a producer of its own world belong to another country than the table's first one: Spanish is the language of Latin America before it is Spain's
// (Marco, 13/10/2026: Roma, Cuarón, produced by GB and US, is Latin America). Every other language uses the first country of tools/selo/language-countries.json, except the ones in NO_HOME.
const LANGUAGE_HOME = { es: "MX" };
// Languages with no home: a film in one of them with no producer that speaks it is where its first producer is. English (a Danish production in English: Denmark, 14/10/2026) and Latin
// (the table's country is the Vatican; Sebastiane, IT + GB, stays in Europe).
const NO_HOME = new Set(["en", "la"]);
// When several producers speak the film's language, TMDB's order decides (the first producer that speaks it: Pan's Labyrinth, MX + ES, and Tabu, BR + FR + DE + PT, are Latin America),
// except for the two languages Marco ruled on: in English the US wins (Fargo, GB + US, is American and not British), then GB or IE over any other English-speaking country (Brooklyn,
// CA + IE + GB, and The Power of the Dog, AU + CA + NZ + GB, are british; Mad Max, AU alone, and a film of CA/AU/NZ alone are in no region); in Arabic a producer of the Middle East wins
// over the Maghreb's (Divine Intervention, MA + PS: Palestine).
const TIE_BREAK = { en: { country: "US", group: ["GB", "IE"] }, ar: { region: "middle-east" } };

/**
 * The ISO code (TMDB's, upper case) of the film's MAIN country, or null. Marco, 13/10/2026: the language rules. `countries`: the production countries in TMDB's order; `lang`: the
 * original language. It is a production country's TMDB code and never a flag ("XG" is not Germany's "DE"), but only when a producer speaks the language; with none that does, the film is
 * where the language's home is, which may be a country that is not among the producers (a Georgian-language film by SU: GE).
 *   1. The producers that speak the language (tools/selo/language-countries.json). One of them: that one. Several: TIE_BREAK for English and Arabic, else the first in TMDB's order.
 *   2. No producer speaks it: the language's home (Roma, in Spanish, by GB and US: MX; Honeyland, in Turkish, by MK: TR; Holy Spider, in Persian, by DK + JO + FR + DE + SE: IR),
 *      "the language rules" read for every language by the session of 13/10/2026 and recorded in PRODUCT.md. A language in NO_HOME: the first production country.
 *   3. A language the table does not know, "xx" (no spoken language) or a language with no country (Esperanto): the first production country the flag table knows, else the first at all.
 * No production country at all: null (the film has no country to be in).
 */
function mainIso({ countries = [], lang = null } = {}, t = table(), l = languages()) {
  const list = (countries || []).map((c) => String(c || "").trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  if (!list.length) return null;
  const code = languageCode(lang), spoken = countriesOfLanguage(lang, l);
  const firstKnown = list.find((iso) => flagOfCode(iso, t)) || list[0];
  if (!spoken || !spoken.length) return firstKnown;
  const speakers = list.filter((iso) => { const cc = flagOfCode(iso, t); return cc && spoken.includes(cc); });
  if (!speakers.length) return LANGUAGE_HOME[code] || (NO_HOME.has(code) ? firstKnown : spoken[0].toUpperCase());
  const tie = TIE_BREAK[code] || {};
  return (tie.country && speakers.find((iso) => iso === tie.country)) || (tie.group && speakers.find((iso) => tie.group.includes(iso))) || (tie.region && speakers.find((iso) => regionsOf(iso).includes(tie.region))) || speakers[0];
}

// The citizenship of the directors (lib/directors.js, cache/directors.json), loaded ONCE per process by whoever builds the cards: build.js, with setDirectors(). Empty until then, so a test or
// a tool that does not load it gets the rule without the director's layer, and the ids of a test fixture never meet a real person's. `mainCountry` also takes the map as its 4th argument.
let DIRECTORS = new Map();
/** Map "TMDB person id" → [TMDB country codes] (lib/directors.js citizenshipMap) → the registry mainCountry reads. Returns the previous one (tests put it back). */
function setDirectors(map) {
  const prev = DIRECTORS;
  DIRECTORS = map instanceof Map ? map : new Map();
  return prev;
}

/** Does the language of the film (its code, or null) have `iso` among the countries that speak it? Through the flag table, so SU/XC/YU count as the language of their successor. */
function speaksIn(lang, iso, t, l) {
  const spoken = countriesOfLanguage(lang, l);
  const cc = flagOfCode(iso, t);
  return !!(spoken && cc && spoken.includes(cc));
}

/**
 * The country of the film's director (an ISO code) by the rule of 23/10/2026, or null: the citizenship of the FIRST director that has one (`directors`: [{ id }], as TMDB's record lists them;
 * `dirs`: the map of lib/directors.js). A director with several citizenships (the order of the list is the order Wikidata answered and is part of the data: lib/directors.js; a tie between two of them
 * that both produce the film, or both speak its language, goes to the first, as Marco decided on 23/10/2026: "Fica como está hoje", PRODUCT.md): when the film is not in English, those whose country speaks its language (the producer among them first, else the
 * first); else the producer; else the first. Then it counts only in two cases: the director's country is one of the producers, or the film is not in English and its language is spoken there.
 * The guard: a Chinese director (CN) of a film produced by Hong Kong or Taiwan and not by CN does not take the film from them (Hong Kong stays Hong Kong).
 */
function directorCountry({ prod, lang, directors }, dirs, t, l) {
  const code = languageCode(lang);
  let cit = null;
  for (const d of directors || []) { const list = d && dirs.get(String(d.id)); if (list && list.length) { cit = list; break; } }
  if (!cit) return null;
  const spoken = code && code !== "en" ? cit.filter((c) => speaksIn(code, c, t, l)) : [];
  const nat = spoken.find((c) => prod.includes(c)) || spoken[0] || cit.find((c) => prod.includes(c)) || cit[0];
  if (nat === "CN" && !prod.includes("CN") && (prod.includes("HK") || prod.includes("TW"))) return null;
  if (prod.includes(nat)) return nat;
  if (code && code !== "en" && speaksIn(code, nat, t, l)) return nat;
  return null;
}

/**
 * The ISO code of the film's MAIN country, the ONE country a card shows first (line 1 of the description, the first name of the index's `countries` column), the one the Board's regions
 * read (lib/moods.js passes(), `where.region` / `where.countries`) and the one whose flag the cover draws (attachCountries below): they cannot disagree because all three ask this function.
 * THE ONE PLACE THAT DECIDES; a new layer is a new step here and nowhere else. The history, all Marco's: 22/10/2026 (questionnaire 3b, "eh o 1 mas topsy turvy eh british", Stremio
 * BACKLOG): the card said United Kingdom and the British row did not have Topsy-Turvy, so TMDB's origin_country decides; and 23/10/2026 (questionnaire, the recommended option):
 * "Cidadania do diretor quando o filme é produzido no país dela ou falado na língua dela (fora inglês); senão origem do TMDB" ("Roma é do México, foca no diretor de onde ele é"). The steps:
 *   0. (Marco, 14/11/2026 and 15/11/2026) A film whose original language is English and whose `origin` names ONE country that is also one of its producers: that country, whatever the director's
 *      citizenship (Blade Runner: US, not GB). An origin that is not a producer does not take this step (Little Dieter Needs to Fly, DE alone, origin GB: Herzog's DE, by step 1).
 *   1. The director's country (directorCountry above, from cache/directors.json): Roma, produced by GB and US (TMDB 426426), in Spanish, by the Mexican Cuarón: MX; Holy Spider, DK + FR + DE + SE + JO, in
 *      Persian, by the Iranian Abbasi: IR (spoken there). A director with no citizenship on file, or whose country is neither a producer nor a speaker of the language, passes to step 2.
 *   2. TMDB's `origin_country` (`origin`, the record's own field, which `lib/tmdb.js` trim() keeps) with ONE country: that one (Topsy-Turvy, GB + US producers: GB).
 *   3. With SEVERAL: the answer of the rule of 13/10/2026 and 14/10/2026 (mainIso: the language and the producers) when it is among them (this step alone: Doctor Zhivago, origin GB + US, English: US; The Look of Silence, origin DK + GB: DK; the director's layer
 *      above then says GB for the first and US for the second);
 *      otherwise the first of them in TMDB's order.
 *   4. With none, or when the record has no `origin` yet (a cached record from before 22/10/2026): mainIso, as before.
 * An origin that is not among the production countries still counts (a proposal to ignore it was left to Marco, BACKLOG 22/10/2026). `film` is the TMDB record: { countries, lang, origin,
 * directors }. Upper case, two letters, as TMDB writes them (a code the language table does not know, "SU" or "XC", is kept as it is). No country at all: null.
 * mainCountryWhy() answers { iso, from }: from "director" (Wikidata), "origin" (TMDB's origin_country) or "rule" (the rule of 14/10/2026), for the CLI to name its source.
 */
function mainCountryWhy(film, t = table(), l = languages(), dirs = DIRECTORS) {
  const { countries = [], lang = null, origin, directors } = film || {};
  const prod = (countries || []).map((c) => String(c || "").trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  const claimed = (Array.isArray(origin) ? origin : []).map((c) => String(c || "").trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  // Marco, 14/11/2026 ("Database country wins when it lists only one"): a film in ENGLISH whose TMDB origin_country names one country is that country, before the director's citizenship
  // (Blade Runner, origin US, by the British Ridley Scott: US). In English the director decides only when the origin names several countries, or none. Every other language is as on 23/10/2026.
  // Marco, 15/11/2026 (questionnaire, the country: "Only when that country is one of the producers"): and only when that country is a producer (Little Dieter Needs to Fly, produced by DE, origin GB, stays with Herzog: DE)
  if (claimed.length === 1 && languageCode(lang) === "en" && prod.includes(claimed[0])) return { iso: claimed[0], from: "origin" };
  const byDirector = dirs && dirs.size ? directorCountry({ prod, lang, directors }, dirs, t, l) : null;
  if (byDirector) return { iso: byDirector, from: "director" };
  const byRule = mainIso({ countries, lang }, t, l);
  if (claimed.length === 1) return { iso: claimed[0], from: "origin" };
  if (claimed.length > 1) return claimed.includes(byRule) ? { iso: byRule, from: "rule" } : { iso: claimed[0], from: "origin" };
  return { iso: byRule, from: "rule" };
}
/** The main country (see above): the ISO code, or null. */
function mainCountry(film, t, l, dirs) {
  return mainCountryWhy(film, t, l, dirs).iso;
}

/** The region names an ISO code is in (none, for a country no region lists). */
const regionsOf = (iso) => [...REGION_SETS].filter(([, set]) => set.has(iso)).map(([name]) => name);

/** Does this ISO code belong to the region? A name that is not a region is a mistake, not "no": it throws. */
function inRegion(iso, region) {
  const set = REGION_SETS.get(region);
  if (!set) throw new Error(`unknown region "${region}" (known: ${[...REGION_SETS.keys()].join(", ")})`);
  return set.has(String(iso || "").toUpperCase());
}

/** Every flag code the table can produce, sorted: what `node tools/selo/fetch-flags.js` downloads. */
const allFlagCodes = (t = table()) => [...t.known].sort();

// ── the pictures ─────────────────────────────────────────────────────────────

const isPng = (b) => b.length > 60 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const flagFile = (dir, cc) => path.join(dir, `${cc}.png`);

/** One flag, under LIMITS.flag per try. Retries 429/5xx, network errors and a deadline; a body past the cap, a 404 or anything that is not a PNG is refused at once. → Buffer */
async function fetchFlag(cc, { fetchImpl = globalThis.fetch, retries = 3, sleepImpl = sleep, log } = {}) {
  let last;
  for (let a = 0; a <= retries; a++) {
    try {
      const { res, body: buf } = await limitedFetch("flag", fetchImpl, FLAG_URL(cc), { headers: { "User-Agent": "mood-engine/2.2 (personal Stremio addon)" } }, { as: "bytes", log });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { final: true });
      if (!isPng(buf)) throw Object.assign(new Error("not a PNG"), { final: true });
      return buf;
    } catch (e) {
      last = e;
      if (e.final) break;
      await sleepImpl(500 * 2 ** a);
    }
  }
  throw last;
}

/**
 * Downloads the flags in `codes` that are not in `dir` yet (written whole to a temp name, then renamed).
 * → { present, downloaded, failed: [{ cc, error }] } : present = already there before.
 */
async function ensureFlags(codes, { dir, fetchImpl, concurrency = 6, sleepImpl, log } = {}) {
  const out = { present: 0, downloaded: 0, failed: [] };
  const todo = [];
  for (const cc of new Set(codes)) (fs.existsSync(flagFile(dir, cc)) ? out.present++ : todo.push(cc));
  if (!todo.length) return out;
  fs.mkdirSync(dir, { recursive: true });
  await mapLimit(todo, concurrency, async (cc) => {
    try {
      const buf = await fetchFlag(cc, { fetchImpl, sleepImpl, log });
      const tmp = `${flagFile(dir, cc)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, flagFile(dir, cc));
      out.downloaded++;
    } catch (e) { out.failed.push({ cc, error: e.message }); }
  });
  return out;
}

module.exports = { key, loadTable, loadLanguages, languageCode, countriesOfLanguage, tmdbFacts, flagOfName, flagOfCode, pickCountry, attachCountries, REGIONS, mainIso, mainCountry, mainCountryWhy, directorCountry, setDirectors, tmdbMain, inRegion, allFlagCodes, fetchFlag, ensureFlags, flagFile, isPng, FLAG_URL, TABLE_FILE, LANGUAGES_FILE };
