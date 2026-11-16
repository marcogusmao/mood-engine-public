// How well a film fits a mood. Pure function of TMDB metadata + the mood recipe in config.json.
// `where` (Marco, 13/10/2026, the v2 Board): a hard gate in front of the ranking, for a mood and for a filter row. A film that fails it is out, whatever its fit; see passes().

const { mainCountry, inRegion, REGIONS, languageCode } = require("./countries");

const ANGLO = new Set(["US", "GB", "CA", "AU", "NZ", "IE"]);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Compile mood recipes once. A keyword is compared after `kwNorm` (ends trimmed, inner spaces joined, lower case: TMDB stores "simulated reality " with a trailing space on The Matrix).
 * The FIT of a mood (fit() below), since 14/11/2026 (the session's choice, measured by the audit of the Stremio project, section 1e; not asked of Marco):
 *   a POSITIVE term matches a keyword that IS the term, or a keyword that the recipe itself names (a term of the recipe, or one of its `compoundKeywords`) and that holds the term as a whole
 *   word: "travel" no longer fits "time travel", "party" no longer "nsdap (nazi party)", "night" no longer "one-night stand", while "noir" still fits "film noir" because Noir names "film noir".
 *   So a film scores what it scored before on every compound the recipe names (the root term matches it, the dedup below keeps one), and loses only the compounds nobody named.
 *   A NEGATIVE term matches as before, a whole word inside any keyword: "holocaust" -3 still pushes away "holocaust (shoah)", "suicide" still "suicide attempt" (pushing a film away is the
 *   safe side; the review of 14/11/2026 measured holocaust 35 -> 0 and suicide 316 -> 204 keywords matched when negatives were whole too).
 *   `insideKeywords: { <term>: "<why>" }` marks a positive term that matches inside ANY keyword, as every term did before 14/11/2026. Marco, 15/11/2026 (questionnaire, Noir: "Everything with
 *   "noir" in the tag, as before"): Noir's "noir" is the one term so marked; the reason is written beside it in config.json. The family still scores once (the dedup below).
 * `re` (a whole word inside a keyword, as before) is also what lib/index-export.js reads for the index's `keywords` column, the card's mood words and the search text; `compoundKeywords` are
 * not `_terms`, so they never enter that column (lib/index-export.js allowlist) and the column stays as it was.
 * lists: config.json lists; a list that declares
 * `moods: { <mood id>: weight }` is a signal of that mood (Marco, 11/10/2026: the slow-cinema canons as the signal of "slow").
 */
const kwNorm = (k) => String(k == null ? "" : k).trim().replace(/\s+/g, " ").toLowerCase();
function compile(moods, lists = []) {
  return moods.map((m) => ({
    ...m,
    _terms: Object.entries(m.keywords || {}).map(([term, w]) => ({ term, w, norm: kwNorm(term), re: new RegExp(`(^|[^a-z])${esc(term)}([^a-z]|$)`) })),
    // the keywords this recipe names, normalised: its positive terms and its compoundKeywords (a list of TMDB keywords, no weight: Noir's "film noir", "neo-noir" …)
    _named: new Set([...Object.entries(m.keywords || {}).filter(([, w]) => w > 0).map(([term]) => kwNorm(term)), ...(m.compoundKeywords || []).map(kwNorm)]),
    _lists: {
      ...Object.fromEntries((lists || []).filter((l) => l && l.moods && typeof l.moods[m.id] === "number").map((l) => [l.id, { w: l.moods[m.id], label: String(l.name).replace(/ \([^)]*\)$/, "") }])),
      // a v2 mood may name lists itself, { <list id>: weight }: the lists of a recipe that config.json does not read yet carry no film, so they weigh nothing until it does
      ...Object.fromEntries(Object.entries(m.lists || {}).map(([id, w]) => [id, { w, label: String(((lists || []).find((l) => l && l.id === id) || {}).name || id).replace(/ \([^)]*\)$/, "") }])),
    },
  }));
}

/** config.json lists[].moods: { <mood id>: weight > 0 } naming moods that exist. → problems (strings). */
function validateListMoods(lists, moods) {
  const ids = new Set((moods || []).map((m) => m.id)), problems = [];
  for (const l of lists || []) {
    if (l.moods === undefined) continue;
    if (!l.moods || typeof l.moods !== "object" || Array.isArray(l.moods)) { problems.push(`${l.id}: moods must be { <mood id>: weight }`); continue; }
    for (const [id, w] of Object.entries(l.moods)) {
      if (!ids.has(id)) problems.push(`${l.id}: moods names ${JSON.stringify(id)}, which is not a mood`);
      if (typeof w !== "number" || !Number.isFinite(w) || w <= 0 || w > 5) problems.push(`${l.id}: moods.${id} must be a number in (0, 5]`);
    }
  }
  return problems;
}

/**
 * film: TMDB record. mood: compiled. ctx.lists: the ids of the config.json lists the film is in (by IMDb id; build.js, the learning
 * replay). A film in a list that names the mood gets that list's weight (the strongest list, not the sum) and the list as a hit.
 */
function fit(film, mood, ctx = {}) {
  let s = 0;
  const hits = [];
  const genres = film.genres || [];
  for (const [g, w] of Object.entries(mood.genres || {})) if (genres.includes(g)) s += w;

  let kw = 0;
  const kws = (film.keywords || []).map(kwNorm);
  const named = mood._named || new Set();
  for (const t of mood._terms) {
    const tn = t.norm ?? kwNorm(t.term);
    const inside = t.w <= 0 || !!(mood.insideKeywords && Object.hasOwn(mood.insideKeywords, t.term)); // a negative term, or a positive one the recipe marks: the word inside any keyword
    const matches = inside ? (k) => t.re.test(k) : (k) => k === tn || (named.has(k) && t.re.test(k));
    if (kws.some(matches)) {
      // "noir" inside "film noir" is the same signal — count it once.
      if (hits.some((h) => h.includes(t.term) || t.term.includes(h))) continue;
      kw += t.w;
      // hitMin: the weight a keyword needs to count as evidence for needHit (default: above 0.5). Slow sets 1: "loneliness" alone,
      // in a foreign drama, is not slow cinema (review S3-3, 11/10/2026: that is how Ikiru reached the top of the row).
      if (mood.hitMin != null ? t.w >= mood.hitMin : t.w > 0.5) hits.push(t.term);
    }
  }
  s += Math.max(-5, Math.min(kw, mood.keywordCap ?? 3.5));

  if (mood._lists && ctx.lists && ctx.lists.length) {
    const best = ctx.lists.map((id) => mood._lists[id]).filter(Boolean).sort((a, b) => b.w - a.w)[0];
    if (best) { s += best.w; hits.unshift(best.label); }
  }

  // Slow cinema is defined by its authors far more than by TMDB tags (measured 11/10/2026: 27 of the 140 films of the two
  // slow-cinema canons that are in the cache carry no keyword at all, and "long take" appears on none), so a mood may name
  // directors. The strongest one counts, not the sum: an omnibus film of twelve directors is not twelve times as slow.
  if (mood.directors) {
    const named = (film.directors || []).filter((d) => mood.directors[d.id]).sort((a, b) => mood.directors[b.id] - mood.directors[a.id])[0];
    if (named) { s += mood.directors[named.id]; hits.unshift(named.name); }
  }

  if (mood.nonEnglish && film.lang && film.lang !== "en") s += mood.nonEnglish;
  if (mood.nonAnglo && film.countries?.length && !film.countries.some((c) => ANGLO.has(c))) s += mood.nonAnglo;
  if (mood.runtime?.max && film.runtime > mood.runtime.max) s -= (film.runtime - mood.runtime.max) / 25;
  if (mood.requireGenre && !mood.requireGenre.some((g) => genres.includes(g))) s -= 6;
  // Gentle moods need real evidence, not just "it's a comedy-drama".
  if (mood.needHit && !hits.length) s -= mood.needHit;

  // minFit 0 (a v2 mood that is only a `where` gate, "Hidden gems"): every film that passes the gate fits, all alike (norm 1); s / 0 would be Infinity or NaN.
  // The normalisation keeps its own text: tools/films/films.test.js pins `s / ((mood.minFit ?? 2) * 1.75)` as the formula the CLI explains.
  return { fit: s, ok: s >= (mood.minFit ?? 2), norm: mood.minFit === 0 ? (s >= 0 ? 1 : 0) : Math.max(0, s / ((mood.minFit ?? 2) * 1.75)), hits: hits.slice(0, 3) };
}

const WHERE_KEYS = ["countries", "region", "years", "language", "genresAny", "genresAll", "keywordsAny", "listsAny", "lb", "lbCount", "directorsAny", "anyOf"];
const isRange = (r) => !!r && typeof r === "object" && !Array.isArray(r) && Object.keys(r).length > 0 && Object.keys(r).every((k) => (k === "min" || k === "max") && typeof r[k] === "number" && Number.isFinite(r[k]));
const textList = (x) => Array.isArray(x) && x.length > 0 && x.every((g) => typeof g === "string" && g.length > 0);

/** A `where` as the problems it has (strings); [] when it is sound. `at` says whose it is ("moods.hidden.where", "rows.europe.where"). */
function validateWhere(where, at) {
  if (!where || typeof where !== "object" || Array.isArray(where) || !Object.keys(where).length) return [`${at} must be an object with at least one condition (${WHERE_KEYS.join(", ")})`];
  const out = [];
  for (const [k, v] of Object.entries(where)) {
    if (!WHERE_KEYS.includes(k)) out.push(`${at}: unknown condition "${k}" (allowed: ${WHERE_KEYS.join(", ")})`);
    else if (k === "countries" && !(Array.isArray(v) && v.length && v.every((c) => /^[A-Z]{2}$/.test(c)))) out.push(`${at}.countries must be a list of ISO 3166-1 alpha-2 codes in capitals, the way TMDB writes the production countries ("XG", not a flag)`);
    else if (k === "region" && !Object.hasOwn(REGIONS, v)) out.push(`${at}.region "${v}" is not a region (${Object.keys(REGIONS).join(", ")})`);
    else if (["years", "lb", "lbCount"].includes(k) && !isRange(v)) out.push(`${at}.${k} must be { min?, max? } with numbers`);
    else if (k === "language" && !(typeof v === "string" || textList(v))) out.push(`${at}.language must be a language code or a list of them ("ja")`);
    else if ((k === "genresAny" || k === "genresAll") && !textList(v)) out.push(`${at}.${k} must be a list of TMDB genre names`);
    else if (k === "keywordsAny" && !textList(v)) out.push(`${at}.keywordsAny must be a list of TMDB keywords, whole`);
    else if (k === "listsAny" && !textList(v)) out.push(`${at}.listsAny must be a list of list ids (config.json lists[].id)`);
    else if (k === "directorsAny" && !(Array.isArray(v) && v.length && v.every((d) => d && typeof d === "object" && Number.isInteger(d.id) && d.id > 0 && typeof d.name === "string" && d.name))) out.push(`${at}.directorsAny must be a list of { id, name } with TMDB person ids`);
    else if (k === "anyOf") { if (!Array.isArray(v) || v.length < 2) out.push(`${at}.anyOf must be a list of two or more conditions, one of which has to hold`); else v.forEach((w, i) => out.push(...validateWhere(w, `${at}.anyOf[${i}]`))); }
  }
  return out;
}

const within = (n, r) => n != null && Number.isFinite(n) && (r.min == null || n >= r.min) && (r.max == null || n <= r.max);

/**
 * Does the candidate pass the gate? c: { film (TMDB record), lbYear?, lb?, lbCount? } (build.js decorates the candidates with the Letterboxd year, average and rating count by IMDb id).
 * Every condition must hold; a fact the candidate lacks (no Letterboxd average, no year) fails the condition that asks for it.
 *   countries   the film's MAIN country (lib/countries.js mainCountry: for a film in English TMDB's origin_country when it names one (14/11/2026), else the director's country, else TMDB's origin_country when it names one, else mainIso, the language and the producers) is one of these ISO codes, as TMDB writes them, not the flag the cover draws
 *   region      the main country is in the region of lib/countries.js REGIONS
 *   years       the year the index shows: Letterboxd's, else the TMDB record's
 *   language    the original language (a code or a list of codes)      genresAny / genresAll   the TMDB genres
 *   keywordsAny one of these TMDB keywords, whole      listsAny   the film is in one of these lists (config.json lists[].id; c.lists)
 *   lb          the Letterboxd average     lbCount   how many ratings it rests on
 *   directorsAny  one of the film's directors is one of these TMDB person ids ([{ id, name }]; the name is for the reader of the file, the id decides: Marco, 22/10/2026, the eras of Decades & eras that are a movement)
 *   anyOf       a list of conditions of the kinds above, one of which has to hold (the other conditions of the same `where` still have to hold too)
 */
function passes(c, where) {
  if (!where) return true;
  const film = c.film || {};
  if (where.countries || where.region) {
    const iso = mainCountry(film); // the director's country (film.directors, cache/directors.json), else film.origin (TMDB's origin_country), else the language-and-producers rule: the same country as the card and the flag (Marco, 22/10 and 23/10/2026)
    if (!iso) return false;
    if (where.countries && !where.countries.includes(iso)) return false;
    if (where.region && !inRegion(iso, where.region)) return false;
  }
  if (where.years && !within(c.lbYear || film.year || null, where.years)) return false;
  if (where.language) {
    const have = languageCode(film.lang), want = [].concat(where.language).map(languageCode);
    if (!have || !want.includes(have)) return false;
  }
  const genres = film.genres || [];
  if (where.genresAny && !where.genresAny.some((g) => genres.includes(g))) return false;
  if (where.genresAll && !where.genresAll.every((g) => genres.includes(g))) return false;
  if (where.keywordsAny && !where.keywordsAny.some((k) => (film.keywords || []).includes(String(k).toLowerCase()))) return false;
  if (where.listsAny && !where.listsAny.some((id) => (c.lists || []).includes(id))) return false;
  if (where.directorsAny && !(film.directors || []).some((d) => where.directorsAny.some((x) => x.id === d.id))) return false;
  if (where.anyOf && !where.anyOf.some((w) => passes(c, w))) return false;
  if (where.lb && !within(c.lb, where.lb)) return false;
  if (where.lbCount && !within(c.lbCount, where.lbCount)) return false;
  return true;
}

module.exports = { kwNorm, compile, fit, validateListMoods, passes, validateWhere, WHERE_KEYS };
