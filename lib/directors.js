// The citizenship of the film's director, the first layer of the main country of a film (Marco, 23/10/2026, questionnaire, recommended option: "Cidadania do diretor quando o
// filme é produzido no país dela ou falado na língua dela (fora inglês); senão origem do TMDB"; the rule itself is lib/countries.js mainCountry). Source: Wikidata, which links a person by the
// TMDB person id (P4985) to the countries of citizenship (P27) and their ISO code (P297). Public, no key, no login.
// THE AUTOMATIC NIGHTLY QUERY IS AUTHORISED (Marco, 23/10/2026, questionnaire, the recommended option: "Pode, automático toda noite"): the build may ask Wikidata by itself for the directors
// that cache/directors.json lacks, on the Mac's nightly and in GitHub Actions (about 83 directors the first night, a few a day after); if Wikidata is down or blocks (HTTP 403 or 429) the asking stops, the
// film keeps TMDB's origin until the next night, and the nightly is not brought down. (The Stremio project's note of 10/10/2026 only allowed manual use of this service.)
//
// cache/directors.json (committed, like the other caches): { "<TMDB person id>": { "cit": ["MX", "ES"], "t": <ms when asked> } }. `cit` is the list of TMDB country codes in the order Wikidata
// answered. THAT ORDER IS PART OF THE DATA and is NEVER reordered (Marco, 23/10/2026: "Fica como está hoje"): the query has no ORDER BY, the order of a director with two citizenships is whatever Wikidata returned the day she was asked, and lib/countries.js directorCountry breaks a tie between two citizenships that both produce the film (or both speak its language) by it. Nothing here ever sorts, reverses or rewrites `cit` once written (an empty answer asked again is replaced whole, and only then); a director who enters later enters with the order that comes. Reversing every list would change the country of 73 of the 7,857 films of the pool (35 of region); a case on the wrong side is corrected by hand when Marco says so (PRODUCT.md, BACKLOG.md, 23/10/2026). test/origin-country.test.js pins the order of three directors of the committed file. An empty `cit` list means: Wikidata has the person without a citizenship, or does not have the person. A person is asked ONCE, and a person with an empty answer again after 30 days
// (REASK_EMPTY_MS: Wikidata gains data); one with citizenship is never asked again (a citizenship does not change under a film). A batch that fails (network, HTTP error, bad answer) writes
// nothing; HTTP 403 or 429 stops the asking at once for the night (the house rule for a public service, review of 23/10/2026: no second call, no Retry-After wait): its directors stay unknown for the build, which goes on, and are asked again the next night. Nothing is asked offline (OFFLINE) and nothing here reads the Keychain or any secret.
//
// Historic countries come without an ISO code or with one TMDB does not write: HISTORIC maps the label to TMDB's code (Soviet Union SU, Czechoslovakia XC, Yugoslavia YU, the German states DE,
// East Germany XG: TMDB's code for it, Wikidata's is DD), CODES maps a code. A label in neither is dropped (a person with only such labels has no citizenship). Pure functions and the one
// network function, with fetch injected.

const fs = require("fs");
const path = require("path");
const { sleep, limitedFetch } = require("./util");

const FILE = path.join(__dirname, "..", "cache", "directors.json");
const ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT = "mood-engine/2.4 (personal Stremio addon; director citizenship; github.com/marcogusmao/mood-engine)";
const BATCH = 120; // TMDB person ids per query (measured on 22/10/2026: 6,077 directors in 51 queries, 114 s)
const PAUSE_MS = 400; // between two queries
const REASK_EMPTY_MS = 30 * 24 * 3600 * 1000;
const FAIL_STREAK = 3; // batches that fail in a row before the run gives up asking (the rest stays unknown until the next night)

// Wikidata's code → TMDB's code, where they differ.
const CODES = { DD: "XG" };

// label (English, as the Wikidata label service answers) → TMDB code, for the countries that have no P297. Measured on the 6,077 directors of 22/10/2026 (23 labels without a code) and
// completed with the historic states Wikidata uses for people of the first half of the century.
const HISTORIC = {
  "Soviet Union": "SU", "Soviet Russia": "SU", "Russian Soviet Federative Socialist Republic": "SU", "Russian Socialist Federative Soviet Republic": "SU",
  "Ukrainian Soviet Socialist Republic": "SU", "Georgian Soviet Socialist Republic": "SU", "Armenian Soviet Socialist Republic": "SU", "Kazakh Soviet Socialist Republic": "SU",
  "Lithuanian Soviet Socialist Republic": "SU", "Latvian Soviet Socialist Republic": "SU", "Estonian Soviet Socialist Republic": "SU", "Belarusian Soviet Socialist Republic": "SU",
  "Russian Empire": "RU", "Russian Republic": "RU", "Ukrainian People's Republic": "UA", "Ukrainian State": "UA",
  "Czechoslovakia": "XC", "Czech Socialist Republic": "XC", "Slovak Socialist Republic": "XC", "Kingdom of Bohemia": "XC",
  "Yugoslavia": "YU", "Kingdom of Yugoslavia": "YU", "Socialist Federal Republic of Yugoslavia": "YU", "Kingdom of Serbs, Croats and Slovenes": "YU", "Federal Republic of Yugoslavia": "YU",
  "Federal People's Republic of Yugoslavia": "YU", "Serbia and Montenegro": "RS", "Kingdom of Serbia": "RS",
  "West Germany": "DE", "Federal Republic of Germany": "DE", "Weimar Republic": "DE", "German Empire": "DE", "Nazi Germany": "DE", "German Reich": "DE", "Kingdom of Prussia": "DE", "Kingdom of Bavaria": "DE",
  "East Germany": "XG",
  "Kingdom of Italy": "IT", "Austria-Hungary": "AT", "Austria–Hungary": "AT", "Cisleithania": "AT", "Austrian Empire": "AT", "Kingdom of Hungary": "HU", "Hungarian People's Republic": "HU",
  "Qing dynasty": "CN", "Republic of China (1912–1949)": "CN", "People's Republic of China": "CN", "China": "CN", "Republic of China": "TW", "Taiwan": "TW", "Hong Kong": "HK", "British Hong Kong": "HK",
  "British Raj": "IN", "Dominion of India": "IN", "Mandatory Palestine": "IL", "Palestine": "PS", "Kingdom of Romania": "RO", "Socialist Republic of Romania": "RO", "Ottoman Empire": "TR",
  "French Third Republic": "FR", "Vichy France": "FR", "Free France": "FR", "Kingdom of the Netherlands": "NL", "Netherlands": "NL", "Kingdom of Greece": "GR",
  "Second Polish Republic": "PL", "Polish People's Republic": "PL", "Kingdom of Egypt": "EG", "Republic of Egypt": "EG", "United Arab Republic": "EG", "Empire of Japan": "JP",
  "Korea under Japanese rule": "KR", "Korean Empire": "KR", "United Kingdom of Great Britain and Ireland": "GB", "England": "GB", "Kingdom of Scotland": "GB", "Irish Free State": "IE",
  "Francoist Spain": "ES", "Spanish State": "ES", "Kingdom of Spain": "ES", "Second Spanish Republic": "ES", "Portuguese Republic": "PT", "Estado Novo": "PT", "Kingdom of Portugal": "PT",
  "Kingdom of Bulgaria": "BG", "People's Republic of Bulgaria": "BG", "Imperial State of Iran": "IR", "Pahlavi Iran": "IR", "Dominion of Canada": "CA", "Dominion of New Zealand": "NZ",
  "Union of South Africa": "ZA", "Kingdom of Iraq": "IQ", "Kingdom of Afghanistan": "AF", "Democratic Republic of Vietnam": "VN", "South Vietnam": "VN", "Republic of Vietnam": "VN", "North Vietnam": "VN",
  "Kingdom of Thailand": "TH", "Siam": "TH", "Dutch East Indies": "ID", "Philippine Commonwealth": "PH", "Commonwealth of the Philippines": "PH", "Kingdom of Denmark": "DK", "Kingdom of Norway": "NO",
  "Kingdom of Sweden": "SE", "Grand Duchy of Finland": "FI", "Kingdom of Belgium": "BE", "People's Republic of Poland": "PL", "Crown Colony of Malta": "MT", "State of Malta": "MT", "British Cyprus": "CY",
};

/** One Wikidata country { label, iso } → TMDB's code (two capital letters), or null when it has no code and the label is not a known historic one. */
function codeOf(country) {
  const { label, iso } = country || {};
  const raw = String(iso || "").trim().toUpperCase();
  const name = String(label || "").trim();
  if (Object.hasOwn(HISTORIC, name)) return HISTORIC[name];
  if (/^[A-Z]{2}$/.test(raw)) return CODES[raw] || raw;
  return null;
}

/** The countries of one Wikidata answer ([{ label, iso }]) → the unique TMDB codes in the order given. */
function citizenshipOf(countries) {
  return [...new Set((countries || []).map(codeOf).filter(Boolean))];
}

/** cache/directors.json → the cache object ({} when the file is missing; a file that is not an object is an error: the nightly must not overwrite it blind). */
function load(file = FILE) {
  if (!fs.existsSync(file)) return {};
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error(`${file} must be an object { "<TMDB person id>": { "cit": [...], "t": ms } }`);
  return c;
}

/** Written whole, then renamed (a reader never meets half a file). */
function save(cache, file = FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, file);
}

/** The citizenship the layer reads: a Map "id" → [codes], only the people that have one. */
function citizenshipMap(cache) {
  const m = new Map();
  for (const [id, e] of Object.entries(cache || {})) if (e && Array.isArray(e.cit) && e.cit.length) m.set(String(id), e.cit.filter((c) => /^[A-Z]{2}$/.test(c)));
  return m;
}

/** The ids of the directors of the TMDB records (cache.movie[id].v.directors[].id), as strings, in a stable order. */
function directorIds(tmdbCache) {
  const out = new Set();
  for (const e of Object.values((tmdbCache && tmdbCache.movie) || {})) for (const d of (e && e.v && e.v.directors) || []) if (d && Number.isSafeInteger(d.id) && d.id > 0) out.add(String(d.id));
  return [...out].sort((a, b) => Number(a) - Number(b));
}

/** Of `ids`, the ones to ask now: no entry at all, or an entry with no citizenship older than 30 days. */
function toAsk(cache, ids, now = Date.now()) {
  return ids.filter((id) => {
    const e = cache && cache[id];
    if (!e || !Array.isArray(e.cit)) return true;
    return e.cit.length === 0 && !(now - Number(e.t) < REASK_EMPTY_MS);
  });
}

/** The SPARQL query for a batch of TMDB person ids. */
function queryFor(ids) {
  for (const id of ids) if (!/^\d+$/.test(String(id))) throw new Error(`queryFor: ${JSON.stringify(String(id).slice(0, 20))} is not a TMDB person id (digits only)`); // the id goes inside a quoted SPARQL literal: only digits may
  const values = ids.map((id) => `"${id}"`).join(" ");
  return `SELECT ?tmdb ?country ?countryLabel ?iso WHERE { VALUES ?tmdb { ${values} } ?person wdt:P4985 ?tmdb . OPTIONAL { ?person wdt:P27 ?country . OPTIONAL { ?country wdt:P297 ?iso . } } SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`;
}

/** One batch → Map id → [{ label, iso }] for the people Wikidata knows (a person it does not know is not in the map). Throws on HTTP errors, a bad answer or a deadline. */
async function askBatch(ids, { fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(queryFor(ids))}`;
  const { res, body } = await limitedFetch("wikidata", fetchImpl, url, { headers: { "User-Agent": USER_AGENT, Accept: "application/sparql-results+json" } }, { as: "text", log }); // the deadline and the byte cap of lib/util.js LIMITS.wikidata
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  const j = JSON.parse(body);
  if (!j || !j.results || !Array.isArray(j.results.bindings)) throw new Error("not a SPARQL answer");
  const out = new Map();
  for (const b of j.results.bindings) {
    const id = b.tmdb && b.tmdb.value;
    if (!id) continue;
    if (!out.has(id)) out.set(id, []);
    if (b.country) out.get(id).push({ label: b.countryLabel ? b.countryLabel.value : "", iso: b.iso ? b.iso.value : null });
  }
  return out;
}

/**
 * Asks Wikidata for the directors in `ids` that need it and writes the answers into `cache` (in place; the caller saves).
 * → { wanted, asked, answered, withCitizenship, failedBatches, stopped }. A failed batch changes nothing; FAIL_STREAK failures in a row stop the asking.
 * Offline (`offline`): asks nothing. `deps`: { fetchImpl, sleepImpl, log, now, batch, pauseMs }.
 */
async function refresh(cache, ids, { offline = false, fetchImpl, sleepImpl = sleep, log = () => {}, now = Date.now(), batch = BATCH, pauseMs = PAUSE_MS } = {}) {
  const todo = toAsk(cache, ids, now);
  const n = { wanted: todo.length, asked: 0, answered: 0, withCitizenship: 0, failedBatches: 0, stopped: false };
  if (offline || !todo.length) return n;
  let streak = 0;
  for (let i = 0; i < todo.length; i += batch) {
    const part = todo.slice(i, i + batch);
    let got;
    try { got = await askBatch(part, { fetchImpl, log }); } catch (e) {
      n.failedBatches++;
      // The house rule for a public service: 403 or 429 means STOP at once, no more calls tonight (the other batches wait for the next night; nothing is written for this one)
      if (e.status === 403 || e.status === 429) { n.stopped = true; log(`  ! directors: Wikidata answered HTTP ${e.status}; no more queries tonight, the ${todo.length - n.asked} directors left wait for the next night`); break; }
      if (n.failedBatches <= 3) log(`  ! directors: ${part.length} not asked (${e.message}); they stay unknown tonight`);
      if (++streak >= FAIL_STREAK) { n.stopped = true; log(`  ! directors: ${FAIL_STREAK} batches failed in a row; the rest waits for the next night`); break; }
      await sleepImpl(pauseMs);
      continue;
    }
    streak = 0;
    n.asked += part.length;
    for (const id of part) {
      const cit = citizenshipOf(got.get(id));
      cache[id] = { cit, t: now };
      n.answered++;
      if (cit.length) n.withCitizenship++;
    }
    if (i + batch < todo.length) await sleepImpl(pauseMs);
  }
  return n;
}

/**
 * Offline: the answers of a file { "<id>": { found, cit: [{ label, iso }] } } (what the session of 22/10/2026 fetched; the same shape askBatch makes) into `cache`.
 * Only objects with a `cit` array count (an `{ error }` is ignored). Every saved nonempty citizenship is frozen, including order and date `t`.
 * Missing or empty entries may be filled; an identical empty answer keeps its date. → { received, changed, unchanged, withCitizenship, ignored }
 */
function backfill(cache, answers, now = Date.now()) {
  const n = { received: 0, changed: 0, unchanged: 0, withCitizenship: 0, ignored: 0 };
  for (const [id, a] of Object.entries(answers || {})) {
    if (!/^\d+$/.test(id) || !a || typeof a !== "object" || !Array.isArray(a.cit)) { n.ignored++; continue; }
    const cit = citizenshipOf(a.cit);
    n.received++;
    if (cit.length) n.withCitizenship++;
    const was = cache[id];
    if (was && Array.isArray(was.cit) && (was.cit.length > 0 || cit.length === 0)) { n.unchanged++; continue; }
    cache[id] = { cit, t: now };
    n.changed++;
  }
  return n;
}

module.exports = { FILE, ENDPOINT, BATCH, PAUSE_MS, REASK_EMPTY_MS, HISTORIC, CODES, codeOf, citizenshipOf, load, save, citizenshipMap, directorIds, toAsk, queryFor, askBatch, refresh, backfill };
