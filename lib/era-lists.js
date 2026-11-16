// The files of the eras of the Discover: data/eras/<era id>.json (Marco, 14/11/2026; the rule is research/2026-11-14-eras-v2.md, sections 1 and 5).
//
// An era of a MOVEMENT (type "school": Nouvelle Vague, New German Cinema, Japanese New Wave...) holds a film if it is eligible and
//     the film is in the sourced list of films of the era (`films`, counting the `consensus`) and the year of the index is inside `years`,
//  OR the film is by a director of `school.directors`, inside `years`, and its MAIN country (lib/countries.js mainCountry: the same as the flag) is one of `school.countries`,
//  and is not in `exclude` (the written exclusions win over both doors).
// An era of a CYCLE (type "cycle": film noir, Pre-Code) has the first door only: a director brings no film.
// The eras that are only a period (country + years) keep their `where` in data/discover-catalogs.json and have no file.
//
// This module does not know a film: the lists are DATA that the curation of 15/11/2026 replaces file by file without touching the code or the tests of the rule.
// tools/eras/converter.py writes the files today (from research/2026-11-15-curadoria/); a file written by hand or by the curation only has to pass validate().
//
// The shape (research/2026-11-14-eras-v2.md, 5.1):
//   { id, type, years: { min, max? }, school: null | { directors: [{ id, name }], countries: ["PL"], candidates?: [film], candidatesFrom?, notAdded? },
//     sources: [{ id, publication, title, url, revision: number|null, readOn }], consensus: null | { source, minRefs },
//     films: [{ imdb, tmdb?, slug?, title, year, sources: [id], refs }], exclude: [{ imdb, title, why }], counted? }
//   Since 15/11/2026: `films[].class` (core | periphery | disputed) the era's `admit` (which classes enter; none = all) and `films[].included` = { source, why }, a WRITTEN DECISION that puts in a film whose class the era does not admit (Marco kept 4 action films of the Hong Kong New Wave); `refs` optional; `revision` a number, a text or null; `sources[].mark` (read | reported); every
//   exclusion carries its `source`; `films[].outside` = { source, why } is a WRITTEN EXCEPTION for one film listed outside the years of the era (the label and the years stay, the film enters because a source names it);
//   `pending` = films a source names and the era would admit that are not in the list yet: no IMDb id, or an id with no Letterboxd page known (`imdb` optional), with the reason; never a film that is already in `films`; since 15/11/2026 (the slice that brings films to the catalogue reads `pending`) each one carries its `class` and the era must ADMIT it, or `included` = { source, why } (a written decision, the same as in `films`) puts it in. A film of the list enters WHATEVER ITS COUNTRY (the country counts only for the directors, Marco 15/11/2026).
//   `tmdb` and `slug` (the Letterboxd slug) are required for a film that the index does not have (the night finds the film by them); `candidates` are the films of the directors of
//   the list that the index does not have, kept to bring them to the index and NEVER to put them in the era (a director's film belongs by the second door, with its country checked).

const fs = require("fs");
const path = require("path");
const CO = require("./countries");

const DIR = path.join(__dirname, "..", "data", "eras");
const ID = /^[a-z0-9-]+$/;
const TT = /^tt\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^(?:film:\d+|[a-z0-9]+(?:[-_][a-z0-9]+)*)$/; // the Letterboxd slugs lib/friends.js reads (SLUG_RE): a film with no readable name has `film:<number>`
const TYPES = ["school", "cycle"];
const TOP = ["id", "type", "years", "school", "sources", "consensus", "films", "exclude", "counted", "admit", "pending"];
const CLASSES = ["core", "periphery", "disputed"]; // how many independent sources name a film, as the curation of 15/11/2026 classed them: core 2 or more, periphery 1, disputed one names it and another contradicts
const MARKS = ["read", "reported"]; // a source the researcher read, or one that somebody else read and reported
const SCHOOL_KEYS = ["directors", "countries", "candidates", "candidatesFrom", "notAdded"];
// A country code of a school is one lib/countries.js knows: a flag code of its table, or a code TMDB writes that has no flag of its own (SU, XC, YU...: the codes of REGIONS). "UK" and "ZZ" are not.
const REGION_CODES = new Set(Object.values(CO.REGIONS).flat());
const FLAG_CODES = new Set(CO.allFlagCodes());
const knownCountry = (c) => typeof c === "string" && /^[A-Z]{2}$/.test(c) && (REGION_CODES.has(c) || FLAG_CODES.has(c.toLowerCase()));
const posInt = (n) => Number.isInteger(n) && n > 0;
const plain = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const within = (y, years) => Number.isInteger(y) && y >= years.min && (years.max === undefined || y <= years.max);

/** The file of an era, parsed (not checked: see validate). Throws if it is not there. */
function read(id, dir = DIR) {
  const file = path.join(dir, `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`data/eras/${id}.json does not exist (an option with \`era\` needs its file)`);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new Error(`data/eras/${id}.json is not valid JSON: ${e.message}`); }
}

/** The ids of the eras that have a file in the folder. */
function ids(dir = DIR) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort() : [];
}

/** read() + validate(): the data of an era or ONE error that names every problem. */
function load(id, { dir = DIR } = {}) {
  const data = read(id, dir);
  const problems = validate(data, { id });
  if (problems.length) throw new Error(`data/eras/${id}.json: ${problems.join("; ")}`);
  return data;
}

/**
 * The problems of an era file, as a list of sentences (empty: sound).
 *   id        the id the file must carry (its name)
 *   inIndex   (imdb) => boolean, optional: the index of reference. A film that is NOT in it needs `tmdb` and `slug` (the night cannot find it otherwise). The tests give it; the build does not need it.
 */
function validate(data, { id, inIndex = null } = {}) {
  const out = [];
  const bad = (m) => out.push(m);
  if (!plain(data)) return ["the file is not an object"];
  for (const k of Object.keys(data)) if (!TOP.includes(k)) bad(`unknown key "${k}"`);
  if (typeof data.id !== "string" || !ID.test(data.id)) bad("id must be lower case letters, digits and hyphens");
  else if (id !== undefined && data.id !== id) bad(`id is "${data.id}" and the file is the era "${id}"`);
  if (!TYPES.includes(data.type)) bad(`type must be one of ${TYPES.join(", ")}`);
  const y = data.years;
  const yearsOk = plain(y) && posInt(y.min) && (y.max === undefined || (posInt(y.max) && y.max >= y.min)) && Object.keys(y).every((k) => k === "min" || k === "max");
  if (!yearsOk) bad("years must be { min, max? } with whole years, max not before min");
  // the school: the directors and the countries of the movement; a cycle has none
  if (data.type === "cycle" && data.school !== null && data.school !== undefined) bad("a cycle has no `school`: a director brings no film to a cycle (school must be null)");
  const directors = new Set();
  if (data.type === "school") {
    const s = data.school;
    if (!plain(s)) bad("a school needs `school`: { directors, countries }");
    else {
      for (const k of Object.keys(s)) if (!SCHOOL_KEYS.includes(k)) bad(`school: unknown key "${k}"`);
      if (!Array.isArray(s.directors) || !s.directors.length) bad("school.directors must be a list of at least one { id, name }");
      else for (const d of s.directors) {
        if (!plain(d) || !posInt(d.id) || typeof d.name !== "string" || !d.name) bad(`school.directors: ${JSON.stringify(d)} must be { id: TMDB person id, name }`);
        else if (directors.has(d.id)) bad(`school.directors: ${d.name} (${d.id}) twice`);
        else directors.add(d.id);
      }
      if (!Array.isArray(s.countries) || !s.countries.length || s.countries.some((c) => !knownCountry(c)) || new Set(s.countries).size !== s.countries.length) bad("school.countries must be a list of country codes that lib/countries.js knows (CZ, SU, XC...; not UK or ZZ), none twice: a school without a country would let in the director's films made anywhere");
      if (s.candidates !== undefined) {
        if (!Array.isArray(s.candidates)) bad("school.candidates must be a list");
        else for (const f of s.candidates) {
          const at = `school.candidates ${JSON.stringify(f && f.title)}`;
          if (!plain(f) || !TT.test(f.imdb || "")) { bad(`${at}: imdb must be tt and digits`); continue; }
          if (!posInt(f.tmdb)) bad(`${at}: a candidate is a film the index does not have: it needs its TMDB id`);
          if (typeof f.slug !== "string" || !SLUG.test(f.slug)) bad(`${at}: a candidate needs its Letterboxd slug`);
          if (typeof f.title !== "string" || !f.title) bad(`${at}: no title`);
          if (yearsOk && !within(f.year, y)) bad(`${at}: year ${f.year} is outside the years of the era`);
          if (!Number.isInteger(f.minutes) || f.minutes < 40) bad(`${at}: a feature is 40 minutes or more, not ${f.minutes}`);
        }
      }
    }
  }
  // the sources
  const sourceIds = new Set();
  if (!Array.isArray(data.sources) || !data.sources.length) bad("sources must be a list of at least one source");
  else for (const s of data.sources) {
    const at = `source ${JSON.stringify(s && s.id)}`;
    if (!plain(s) || typeof s.id !== "string" || !ID.test(s.id)) { bad(`${at}: id must be lower case letters, digits and hyphens`); continue; }
    if (sourceIds.has(s.id)) bad(`${at}: the id appears twice`);
    sourceIds.add(s.id);
    for (const k of ["publication", "title", "url"]) if (typeof s[k] !== "string" || !s[k]) bad(`${at}: ${k} is empty`);
    if (!(s.revision === null || posInt(s.revision) || (typeof s.revision === "string" && s.revision.trim()))) bad(`${at}: revision must be a number, a text or null`);
    if (s.mark !== undefined && !MARKS.includes(s.mark)) bad(`${at}: mark must be one of ${MARKS.join(", ")}`);
    if (typeof s.readOn !== "string" || !DATE.test(s.readOn)) bad(`${at}: readOn must be a date YYYY-MM-DD`);
  }
  const c = data.consensus;
  if (c !== null && c !== undefined && !(plain(c) && sourceIds.has(c.source) && posInt(c.minRefs) && Object.keys(c).length === 2)) bad("consensus must be null or { source: id of a source, minRefs: whole number above zero }");
  // the films
  const seen = new Set();
  if (!Array.isArray(data.films)) bad("films must be a list");
  else for (const f of data.films) {
    const at = `film ${JSON.stringify(f && f.title)} (${f && f.imdb})`;
    if (!plain(f) || !TT.test(f.imdb || "")) { bad(`${at}: imdb must be tt and digits`); continue; }
    if (seen.has(f.imdb)) bad(`${at}: the IMDb id appears twice`);
    seen.add(f.imdb);
    for (const k of Object.keys(f)) if (!["imdb", "tmdb", "slug", "title", "year", "sources", "refs", "class", "outside", "included"].includes(k)) bad(`${at}: unknown key "${k}"`);
    if (f.class !== undefined && !CLASSES.includes(f.class)) bad(`${at}: class must be one of ${CLASSES.join(", ")}`);
    if (Array.isArray(data.admit) && f.class === undefined && f.included === undefined) bad(`${at}: the era admits some classes (admit), so every film needs its class, or a written decision (included)`);
    if (typeof f.title !== "string" || !f.title) bad(`${at}: no title`);
    if (f.included !== undefined && (!plain(f.included) || !sourceIds.has(f.included.source) || typeof f.included.why !== "string" || f.included.why.trim().split(/\s+/).length < 5 || Object.keys(f.included).length !== 2)) bad(`${at}: included must be { source: id of a source of the file, why: five words or more }`);
    if (f.outside !== undefined) { // a written exception: the film is outside the years and a source names it
      if (!plain(f.outside) || !sourceIds.has(f.outside.source) || typeof f.outside.why !== "string" || f.outside.why.trim().split(/\s+/).length < 5 || Object.keys(f.outside).length !== 2) bad(`${at}: outside must be { source: id of a source of the file, why: five words or more }`);
      else if (yearsOk && within(f.year, y)) bad(`${at}: outside is written for a film that is inside the years`);
      else if (!Number.isInteger(f.year)) bad(`${at}: year must be a whole year`);
    } else if (yearsOk && !within(f.year, y)) bad(`${at}: year ${f.year} is outside the years of the era (${y.min}-${y.max ?? ""})`);
    if (!Array.isArray(f.sources) || !f.sources.length) bad(`${at}: sources must name at least one source`);
    else for (const s of f.sources) if (!sourceIds.has(s)) bad(`${at}: source "${s}" is not in sources`);
    if (f.refs !== undefined && (!Number.isInteger(f.refs) || f.refs < 0)) bad(`${at}: refs must be a whole number, 0 or more`);
    if (f.tmdb !== undefined && !posInt(f.tmdb)) bad(`${at}: tmdb must be a TMDB id`);
    if (f.slug !== undefined && !(typeof f.slug === "string" && SLUG.test(f.slug))) bad(`${at}: slug must be a Letterboxd slug`);
    if (inIndex && !inIndex(f.imdb) && !(posInt(f.tmdb) && f.slug)) bad(`${at}: a film that the index does not have needs tmdb and slug (the night finds it by them)`);
  }
  if (data.admit !== undefined && !(Array.isArray(data.admit) && data.admit.length && data.admit.every((c) => CLASSES.includes(c)) && new Set(data.admit).size === data.admit.length)) bad(`admit must be a list of one or more of ${CLASSES.join(", ")}, none twice`);
  if (data.pending !== undefined) {
    if (!Array.isArray(data.pending)) bad("pending must be a list");
    else {
      const keys = new Set(), titles = new Set(Array.isArray(data.films) ? data.films.map((f) => `${f && f.title}|${f && f.year}`) : []), ids = new Set(Array.isArray(data.films) ? data.films.map((f) => f && f.imdb) : []);
      for (const p of data.pending) {
        const at = `pending ${JSON.stringify(p && p.title)}`;
        if (!plain(p) || typeof p.title !== "string" || !p.title || typeof p.why !== "string" || p.why.trim().split(/\s+/).length < 3) { bad(`${at}: a title and a reason of three words or more`); continue; }
        if (p.imdb !== undefined && !TT.test(p.imdb)) bad(`${at}: imdb must be tt and digits`);
        if (p.imdb !== undefined && ids.has(p.imdb)) bad(`${at}: the film is already in films (a pending film is one that is NOT in the list yet)`);
        if (titles.has(`${p.title}|${p.year}`)) bad(`${at}: a film with this title and year is already in films`);
        const key = `${p.title}|${p.year}`;
        if (keys.has(key)) bad(`${at}: pending twice`);
        keys.add(key);
        if (p.class !== undefined && !CLASSES.includes(p.class)) bad(`${at}: class must be one of ${CLASSES.join(", ")}`);
        if (p.included !== undefined && (!plain(p.included) || !sourceIds.has(p.included.source) || typeof p.included.why !== "string" || p.included.why.trim().split(/\s+/).length < 5 || Object.keys(p.included).length !== 2)) bad(`${at}: included must be { source: id of a source of the file, why: five words or more }`);
        // the slice that brings films to the catalogue reads `pending`: a film the era does not admit cannot wait there (Commedia all'italiana takes the core only), unless a written decision puts it in
        if (Array.isArray(data.admit) && p.included === undefined) {
          if (p.class === undefined) bad(`${at}: the era admits some classes (admit), so a pending film needs its class, or a written decision (included)`);
          else if (CLASSES.includes(p.class) && !data.admit.includes(p.class)) bad(`${at}: the class "${p.class}" is not admitted by the era (admit: ${data.admit.join(", ")}), and no written decision (included) puts the film in`);
        }
      }
    }
  }
  // the written exclusions
  const excluded = new Set();
  if (!Array.isArray(data.exclude)) bad("exclude must be a list (empty is fine)");
  else for (const x of data.exclude) {
    const at = `exclude ${JSON.stringify(x && x.title)} (${x && x.imdb})`;
    if (!plain(x) || !TT.test(x.imdb || "")) { bad(`${at}: imdb must be tt and digits`); continue; }
    if (typeof x.title !== "string" || !x.title) bad(`${at}: no title`);
    if (typeof x.why !== "string" || x.why.trim().split(/\s+/).length < 5) bad(`${at}: why must say the reason in at least five words`);
    if (typeof x.source !== "string" || !x.source.trim()) bad(`${at}: an exclusion needs its source (who says the film is out, and where)`);
    if (excluded.has(x.imdb)) bad(`${at}: excluded twice`);
    excluded.add(x.imdb);
    if (seen.has(x.imdb)) bad(`${at}: a film that is excluded cannot be in films (the exclusion is written to override the lists: take it out of one or the other)`);
  }
  if (data.type === "school" && plain(data.school) && Array.isArray(data.school.candidates)) {
    const cand = new Set();
    for (const f of data.school.candidates) {
      if (!plain(f) || !f.imdb) continue;
      if (cand.has(f.imdb)) bad(`school.candidates: ${f.imdb} twice`);
      cand.add(f.imdb);
      if (seen.has(f.imdb)) bad(`school.candidates: ${f.imdb} is also in films`);
      if (excluded.has(f.imdb)) bad(`school.candidates: ${f.imdb} is excluded`);
    }
  }
  return out;
}

/** What the build reads: the lists as sets, the years, the school. `listed(imdb)` is the first door (the consensus counted); `excluded(imdb)` beats both doors. */
function prepare(data) {
  const films = new Map(data.films.map((f) => [f.imdb, f]));
  const consensus = data.consensus || null;
  const admit = data.admit ? new Set(data.admit) : null;
  const exclude = new Set(data.exclude.map((x) => x.imdb));
  const listed = (imdb) => {
    const f = films.get(imdb);
    if (!f) return false;
    if (admit && f.class !== undefined && !admit.has(f.class) && !f.included) return false; // the era admits some classes only (Commedia all'italiana: the core)
    // a film that only the consensus source names counts with `minRefs` notes or more; a film another source names too is not touched by the consensus
    return !consensus || f.sources.some((s) => s !== consensus.source) || (f.refs || 0) >= consensus.minRefs;
  };
  /** The first door for a film of the index: listed, and inside the years of the index OR written as an exception (`outside`: a source names it, Marco 15/11/2026). The country is not looked at. */
  const listedIn = (imdb, year) => listed(imdb) && (within(year, data.years) || !!films.get(imdb).outside);
  return {
    id: data.id, type: data.type, years: data.years, exclude, listed, listedIn,
    directors: data.school ? data.school.directors : [], countries: data.school ? data.school.countries : [],
    size: { films: data.films.length, exclude: exclude.size },
  };
}

module.exports = { DIR, read, load, ids, validate, prepare, within };
