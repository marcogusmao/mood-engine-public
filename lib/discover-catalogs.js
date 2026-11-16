// The Discover catalogs of the v2 family that the build calculates and groups (Marco, 22/10/2026: "one for countries and regions, one for decades and eras of
// cinema", and the 147 lists "categorized in a more convenient, easy and intuitive way"). The spec is research/2026-10-22-catalogos-paises-regioes-decadas-eras.md.
//
// data/discover-catalogs.json says WHICH catalogs there are, in which order, with which options; this module checks it (parse), and works out for each calculated
// option the films that belong to it (build). The Worker never calculates membership: it reads the ids written into index-v2.json, or into the option's own piece index-v2-opt-<catalog>-<option>.json for its first pages (lib/index-export.js optionPieces; worker/src/catalogs.js).
//
//   a calculated option has exactly one of
//     where     a rule of lib/moods.js passes() on the film's OWN TMDB record: a region, an era (a period, or a movement by its directors: `directorsAny`)
//     country   the country of the film's facts: the index column `country` (written only when it is not the first of `countries`), else the first name of the column `countries`; the country that the
//               index column `countries` shows first, the same expression as factsByTt() of lib/index-export.js (a test compares the two). Since 23/10/2026 the flag of the cover, the region (`where`) and this
//               country are the film's MAIN country (lib/countries.js mainCountry), one function for the four (test/cover-flag-build.test.js compares the flag with the card in a real build). The v3 card no longer prints a country line
//     decade    the decade of the index (the year the cover shows)
//     era       an era of a movement (type "school") or of a cycle (type "cycle"), whose sourced list of films, directors and country live in data/eras/<id>.json (lib/era-lists.js; Marco, 14/11/2026): a film belongs by the list
//               OR (a school) by a director of the list made in the country of the movement, in the years, minus the written exclusions; a cycle by the list alone. `where` stays for the eras that are only a period
//   a list option is { list: <config.json lists[].id> }: it reads the list's own piece, as Lists and Lists (unseen) did; its label is the list's `short` (or a `label` of its own)
//
// Marco, 28/10/2026 (the Discover reorganized, proposal 5; plan docs/2026-10-28-discover-plano-implementacao.md section 5.1): five more kinds of option, all worked out from the COLUMNS of the index, so the
// numbers of the map are reproducible (genres: the 3 TMDB genres the index keeps; keywords: only the terms of the moods, at most 8; lists):
//     lists    { id, label, lists: [2 or more] }   every film of the index that is in one of the lists, seen or not, with NO recommendation rule: it is an editorial collection (Marco, 10/10/2026). Curated.
//     any      { id, label, any: { lists?, keywords?, genre? } }   in one of the lists OR has one of the keywords OR has the genre (at least keywords or genre); `eligible`. The films come in three blocks, lists, then keywords, then the
//              rest, each in the order of the index, and ONE spread runs over the three together (measured on 28/10/2026 over the 19 genres: 0 cases of a film of a later block before the end of an earlier one; NOT guaranteed by the spread, which can move the third film of a director behind a later block)
//     runtime  { id, label, runtime: { min } }      runtime >= min; `eligible`
//     rating   { id, label, rating: { imdbMin?, lbMin?, imdbTop?, tmdbVotesMin? } }   all the conditions at once; `imdbTop N` = the N best IMDb ratings among ALL the films of the index with at least tmdbVotesMin votes, the ties at the cut included; `eligible`
//     directors { directors: { "<X loves>": { lists: [...], label? } } }   once in the file: one card per director of `index.directors.options`, in that order = the films of "X loves" and of the lists mapped to him, no rule. Curated.
//              If the "X loves" of a mapped card does not exist that night, the mapped lists become list options right after the cards, and the log says " !"
// `menuless` (list ids) are lists outside the menus (still found by search and on the film page); `explore: { genre: <catalog> }` makes that catalog (all options `any`) the Genre filter of Explore.
//
// Who belongs: the films of the index that are `eligible` (the recommendation rule), seen ones included (the Worker hides them unless "Include seen" is asked). Curated options (lists, cards) have no rule.
// A film the music rule holds back (`musicOut`, lib/pool.js musicGate) stays in the ids and is not shown: the Worker serves these options as it serves Explore, from `recommendable`.
// The same for a short (`shortOut`, a known runtime under config.json shortRow.minMinutes; Marco, 15/11/2026): it stays in the ids of a calculated option and is not shown; a curated option (a union of lists, a director's card) shows it.
// And an ERA option (data/eras/<id>.json) shows it too: the director's door takes no short (eraMember below, the same isShort and the same number), so a short in an era's ids is one its file NAMES, and "a source put it there"
// (Marco, 15/11/2026: "Only where you or a source put them"). The option says so with `shorts: true`, which the Worker (catalogs.js) and optionCut (lib/index-export.js) read: the recommendation rule and the music rule still hold in an era, the short bit is not asked.
// The eras that are only a PERIOD (a `where`) have no source: their shorts are not shown, except in the Silent era, which carries the same mark (Marco, 15/11/2026: "Keep shorts in the Silent era only (recommended)"; SHORTS_PERIODS below).
//
// The country of the card is read here from the index; the rule "which country is a film's" is lib/countries.js mainCountry (Marco, 22/10/2026 and 23/10/2026: the director's country, then TMDB's
// origin_country, then the rule of 14/10/2026), and the index columns `country` and `countries` carry its answer.

const fs = require("fs");
const path = require("path");
const { passes, validateWhere } = require("./moods");
const { decadeLabels, isShort, MIN_FEATURE_MINUTES } = require("./pool");
const { words } = require("./index-export");
const { SHORT_MAX } = require("./list-signal");
const ERA = require("./era-lists");

const FILE = path.join(__dirname, "..", "data", "discover-catalogs.json");
const ID = /^[a-z0-9-]+$/;
const NAME_PREFIX = "Mood Engine · ";
const NAME_MAX = 34; // the longest catalog name the phone and the TV show whole (the longest of 22/10/2026, "Mood Engine · Countries & regions", has 33)
const RETIRABLE = ["lists", "lists-unseen", "director-picks"]; // the catalogs of the older manifests that the new one drops (director-picks since 28/10/2026: its cards moved into Directors)
/** The 19 genres of TMDB's movie list, as the index column `genres` spells them (Sci-fi is "Science Fiction"; Noir is no genre). */
const TMDB_GENRES = ["Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary", "Drama", "Family", "Fantasy", "History", "Horror", "Music", "Mystery", "Romance", "Science Fiction", "TV Movie", "Thriller", "War", "Western"];
/** The key of an option → its kind. An option has exactly one of these (or `list`, or `directors`). */
const KIND_OF = { where: "where", country: "country", decade: "decade", lists: "union", any: "any", runtime: "runtime", rating: "rating", era: "era" };
const RATING_KEYS = ["imdbMin", "lbMin", "imdbTop", "tmdbVotesMin"];
// The eras that are only a PERIOD (a `where` of years and countries: Classic Hollywood, Silent era, Late Soviet, Postwar Britain, Weimar and the others) have no file and no source to name a short,
// so their shorts leave as those of any calculated option. Marco, 15/11/2026 (questionnaire, on the shorts in those eras): "Keep shorts in the Silent era only (recommended)".
// The Silent era keeps them (A Trip to the Moon, Cops, Un Chien Andalou, À propos de Nice, Entr'acte: the shorts are that era's cinema); its option says `shorts: true`, the mark of an era file, and no other period does.
// The list is by option id and is the only way a `where` option gets the mark; parse() refuses a spec in which one of these ids is not a `where`.
const SHORTS_PERIODS = ["e-silent"];
/** The ids of the options that may say `shorts: true`: the eras that have a file in data/eras, and the periods of SHORTS_PERIODS. lib/index-validation.js refuses the mark on any other option. */
const shortsOptionIds = (dir) => new Set([...ERA.ids(dir), ...SHORTS_PERIODS]);
/** The Discover catalogs that exist and are not in the data file: it orders them, it does not define them. */
const FIXED = ["moods", "director-picks", "friends", "explore", "search"];
/** Catalog ids that something else already uses (the Worker's catalogs, the profiles' two and the Board's rows come from `existingIds`). */
const TAKEN = ["moods", "lists", "lists-unseen", "friends", "director-picks", "explore", "search", "my-series", "what-it-is"];
const EXTRAS = ["genre", "decade", "runtime", "country", "rating", "search", "skip"];

/** The file, or null when it is not there: the build then writes an index with no `discover` and the Worker answers as before. */
function load(file = FILE) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const posInt = (n) => Number.isInteger(n) && n > 0;
const plain = (x) => !!x && typeof x === "object" && !Array.isArray(x);

/**
 * Checks the file against config.json and returns the specification the build and the tests read:
 *   { floor, order, retire, seen, spread, menuless, explore?, catalogs: [{ id, name, options: [option] }] }
 * where an option is { id, label, kind, ... } with kind "where" | "country" | "decade" | "list" | "union" | "any" | "runtime" | "rating" (the key of the kind carries its value; `any` has
 * lists, keywords, genre; `rating` its numbers), or { kind: "directors", cards: [{ key, label, lists: [{ id, label }] }] }, which the build expands into one option per director.
 * lists: config.json lists (id, name, short). today: YYYY-MM-DD (the decades of the menu). existingIds: ids of the Board rows and of anything else a catalog may not be called.
 * keywordTerms: the positive terms of the moods the index is made with (lib/index-export.js keywordTerms): the only words the column `keywords` holds, so the only ones an `any` may name.
 * Throws ONE error that names every problem (lib/board.js does the same), the culprit first.
 */
function parse(json, { lists = [], today, existingIds = [], keywordTerms = [], eras = null } = {}) {
  const problems = [];
  const bad = (m) => problems.push(m);
  if (!plain(json)) throw new Error("data/discover-catalogs.json must be an object");
  const byId = new Map(lists.map((l) => [l.id, l]));
  const decades = new Set(decadeLabels(today));
  const taken = new Set([...TAKEN, ...existingIds]);
  const takenId = (id) => taken.has(id) || /^vouch-/.test(id);

  for (const k of Object.keys(json)) if (!["version", "_doc", "decided", "floor", "order", "retire", "seen", "spread", "menuless", "explore", "catalogs"].includes(k)) bad(`unknown key "${k}"`);
  if (json.version !== 1) bad(`version must be 1, got ${JSON.stringify(json.version)}`);
  const floor = json.floor, spread = json.spread, seen = json.seen;
  if (!plain(floor) || !posInt(floor.countries) || !posInt(floor.eras)) bad("floor must be { countries, eras } with whole numbers above zero");
  if (!plain(spread) || !posInt(spread.per) || !posInt(spread.window) || (spread.perAfterFirstPage !== undefined && !posInt(spread.perAfterFirstPage)) || (plain(spread) && Object.keys(spread).some((k) => !["per", "perAfterFirstPage", "window"].includes(k)))) bad("spread must be { per, window } or { per, perAfterFirstPage, window } with whole numbers above zero");
  if (!plain(seen) || typeof seen.name !== "string" || !/^[a-z]+$/.test(seen.name) || typeof seen.option !== "string" || !seen.option) bad('seen must be { name, option }, e.g. { "name": "seen", "option": "Include seen" }');
  else if (EXTRAS.includes(seen.name)) bad(`seen.name "${seen.name}" is an extra that already exists (${EXTRAS.join(", ")})`);

  const terms = new Set(keywordTerms);
  const catalogs = [];
  const inCatalog = new Map(); // list id → where it is cited (a catalog id, or "menuless"): a list is cited exactly once, in an option, a union, an `any`, a card, or in `menuless`
  const cite = (id, where) => { if (inCatalog.has(id)) bad(`list ${id} is in ${inCatalog.get(id)} and ${where}`); else inCatalog.set(id, where); };
  const catalogIds = new Set();
  let directorsSeen = false; // the `directors` entry is allowed once in the whole file
  if (!Array.isArray(json.catalogs) || !json.catalogs.length) bad("catalogs must be a list of at least one catalog");
  for (const c of Array.isArray(json.catalogs) ? json.catalogs : []) {
    const at = `catalog ${JSON.stringify(c && c.id)}`;
    if (!plain(c)) { bad(`${at} is not an object`); continue; }
    if (typeof c.id !== "string" || !ID.test(c.id)) bad(`${at}: the id must be lower case letters, digits and hyphens`);
    else if (catalogIds.has(c.id)) bad(`${at}: the id appears twice`);
    else if (takenId(c.id)) bad(`${at}: the id is already used by another catalog or a Board row`);
    catalogIds.add(c.id);
    if (typeof c.name !== "string" || !c.name.startsWith(NAME_PREFIX)) bad(`${at}: the name must start with "${NAME_PREFIX}"`);
    else if (c.name.length > NAME_MAX) bad(`${at}: the name "${c.name}" has ${c.name.length} characters, the limit is ${NAME_MAX}`);
    const options = [], optionIds = new Set(), keys = new Map(); // keys: words(label) → label, for the match the Worker makes
    const claim = (label) => { const key = words(label); if (keys.has(key)) bad(`${at}: "${label}" and "${keys.get(key)}" are the same option to the Worker (it matches on the words alone)`); else keys.set(key, label); };
    const listIn = (id, where) => { const l = typeof id === "string" ? byId.get(id) : null; if (!l) bad(`${where}: list ${JSON.stringify(id)} is not a list of config.json`); return l || null; };
    const listsOf = (arr, named, what, min = 1) => { // a list of config.json ids, each once; the lists are cited here
      if (!Array.isArray(arr) || arr.length < min) { bad(`${named}: ${what} must be a list of at least ${min} list id${min === 1 ? "" : "s"} of config.json`); return []; }
      const out = [];
      for (const id of arr) { if (!listIn(id, named)) continue; if (out.includes(id)) bad(`${named}: list ${id} appears twice in ${what}`); else { out.push(id); cite(id, c.id); } }
      return out;
    };
    if (!Array.isArray(c.options) || !c.options.length) bad(`${at}: options must be a list of at least one option`);
    for (const o of Array.isArray(c.options) ? c.options : []) {
      if (!plain(o)) { bad(`${at}: an option is not an object`); continue; }
      let id, label, norm;
      if (o.directors !== undefined) { // the cards of the directors: one entry in the whole file, expanded by the build
        if (Object.keys(o).some((k) => k !== "directors")) bad(`${at}: the directors entry has more than "directors"`);
        if (directorsSeen) bad(`${at}: the directors entry appears twice in the file (once only)`);
        directorsSeen = true;
        if (!plain(o.directors) || !Object.keys(o.directors).length) { bad(`${at}: directors must be { "<X loves>": { lists: [...], label? } }`); continue; }
        const cards = [];
        for (const [key, card] of Object.entries(o.directors)) {
          const named = `${at}: directors card ${JSON.stringify(key)}`;
          if (!plain(card) || Object.keys(card).some((k) => !["lists", "label"].includes(k))) { bad(`${named} must be { lists: [...], label? }`); continue; }
          const ids = listsOf(card.lists, named, "lists");
          const cardLabel = card.label === undefined ? key : card.label;
          if (typeof cardLabel !== "string" || !cardLabel.trim()) { bad(`${named} has no label`); continue; }
          if (cardLabel.length > SHORT_MAX) bad(`${at}: the label "${cardLabel}" has ${cardLabel.length} characters, the menu line holds ${SHORT_MAX}`);
          claim(cardLabel);
          const resolved = ids.map((i) => ({ id: i, label: byId.get(i).short ?? byId.get(i).name }));
          for (const l of resolved) claim(l.label); // the lists become options of their own on a night when the card is missing: their names must not collide either
          cards.push({ key, label: cardLabel, lists: resolved });
        }
        options.push({ kind: "directors", cards });
        continue;
      }
      if (o.list !== undefined) {
        const list = listIn(o.list, at);
        if (!list) continue;
        if (Object.keys(o).some((k) => !["list", "label"].includes(k))) bad(`${at}: the list option ${o.list} has more than "list" and "label" (its label is the list's own short name unless it says another)`);
        cite(o.list, c.id);
        id = `l-${o.list}`;
        label = o.label === undefined ? list.short ?? list.name : o.label;
        norm = { id, label, kind: "list", list: o.list };
      } else {
        id = o.id; label = o.label;
        const what = Object.keys(KIND_OF).filter((k) => o[k] !== undefined);
        const named = `${at}: option ${JSON.stringify(id)}`;
        if (typeof id !== "string" || !ID.test(id)) bad(`${named}: the id must be lower case letters, digits and hyphens`);
        for (const k of Object.keys(o)) if (!["id", "label", "source", ...what].includes(k)) bad(`${named}: unknown key "${k}"`);
        if (what.length !== 1) { bad(`${named}: needs exactly one of ${Object.keys(KIND_OF).slice(0, -1).join(", ")} or ${Object.keys(KIND_OF).at(-1)}, has ${what.length ? what.join(" and ") : "none"}`); continue; }
        const key = what[0], kind = KIND_OF[key], v = o[key];
        norm = { id, label, kind };
        if (SHORTS_PERIODS.includes(id) && kind !== "where") bad(`${named}: this id is a period that keeps its shorts (SHORTS_PERIODS of lib/discover-catalogs.js; Marco, 15/11/2026): it must be a where, not ${key === "era" ? "an era file" : `a ${key}`}`);
        if (kind === "where") { for (const p of validateWhere(v, `${named}.where`)) bad(p); norm.where = v; }
        else if (kind === "era") { // an era of a movement or a cycle: the sourced list of films and the directors live in data/eras/<id>.json (lib/era-lists.js; Marco, 14/11/2026)
          if (v !== id) bad(`${named}: era must name the era file of this option (data/eras/${id}.json), not ${JSON.stringify(v)}`);
          else {
            let data, failed = false;
            try { data = eras instanceof Map ? eras.get(v) : typeof eras === "function" ? eras(v) : ERA.read(v); } catch (e) { bad(`${named}: ${e.message}`); failed = true; }
            if (!failed && !data) bad(`${named}: no era file "${v}"`);
            else if (!failed) { const own = ERA.validate(data, { id: v }); for (const p of own) bad(`${named}: era file ${v}: ${p}`); if (!own.length) norm.era = ERA.prepare(data); }
          }
        }
        else if (kind === "decade") { if (!decades.has(v)) bad(`${named}: decade ${JSON.stringify(v)} is not one of ${[...decades].join(", ")}`); norm.decade = v; }
        else if (kind === "country") { if (typeof v !== "string" || !v.trim()) bad(`${named}: country must be a name`); norm.country = v; }
        else if (kind === "union") norm.lists = listsOf(v, named, "lists", 2);
        else if (kind === "any") {
          if (!plain(v) || Object.keys(v).some((k) => !["lists", "keywords", "genre"].includes(k))) bad(`${named}: any must be { lists?, keywords?, genre? }`);
          else {
            norm.lists = v.lists === undefined ? [] : listsOf(v.lists, named, "any.lists");
            norm.keywords = [];
            if (v.keywords !== undefined) {
              if (!Array.isArray(v.keywords) || !v.keywords.length || v.keywords.some((t) => typeof t !== "string")) bad(`${named}: any.keywords must be a list of at least one term`);
              else for (const t of v.keywords) {
                if (!terms.has(t)) bad(`${named}: keyword ${JSON.stringify(t)} is not a positive term of the moods of config.json (the index column holds those and no other)`);
                else if (norm.keywords.includes(t)) bad(`${named}: keyword ${JSON.stringify(t)} appears twice`);
                else norm.keywords.push(t);
              }
            }
            norm.genre = null;
            if (v.genre !== undefined) { if (!TMDB_GENRES.includes(v.genre)) bad(`${named}: genre ${JSON.stringify(v.genre)} is not one of the ${TMDB_GENRES.length} genres of TMDB (${TMDB_GENRES.join(", ")})`); else norm.genre = v.genre; }
            if (v.keywords === undefined && v.genre === undefined) bad(`${named}: an any with lists alone is a union of lists; it needs keywords or a genre`);
          }
        } else if (kind === "runtime") {
          if (!plain(v) || Object.keys(v).some((k) => k !== "min") || !posInt(v.min)) bad(`${named}: runtime must be { min: minutes, a whole number above zero }`);
          else norm.min = v.min;
        } else if (kind === "rating") {
          const num = (x, hi) => typeof x === "number" && Number.isFinite(x) && x > 0 && x <= hi;
          if (!plain(v) || Object.keys(v).some((k) => !RATING_KEYS.includes(k))) bad(`${named}: rating must be { ${RATING_KEYS.join("?, ")}? }`);
          else {
            if (v.imdbMin !== undefined && !num(v.imdbMin, 10)) bad(`${named}: rating.imdbMin must be a number above 0 and at most 10`);
            if (v.lbMin !== undefined && !num(v.lbMin, 5)) bad(`${named}: rating.lbMin must be a number above 0 and at most 5`);
            if (v.imdbTop !== undefined && !posInt(v.imdbTop)) bad(`${named}: rating.imdbTop must be a whole number above zero`);
            if (v.tmdbVotesMin !== undefined && !posInt(v.tmdbVotesMin)) bad(`${named}: rating.tmdbVotesMin must be a whole number above zero`);
            if (v.imdbMin === undefined && v.lbMin === undefined && v.imdbTop === undefined) bad(`${named}: rating needs imdbMin, lbMin or imdbTop (votes alone are no rating)`);
            for (const k of RATING_KEYS) if (v[k] !== undefined) norm[k] = v[k];
          }
        }
      }
      if (typeof label !== "string" || !label.trim()) { bad(`${at}: option ${JSON.stringify(id)} has no label`); continue; }
      if (label.length > SHORT_MAX) bad(`${at}: the label "${label}" has ${label.length} characters, the menu line holds ${SHORT_MAX}`);
      norm.label = label;
      if (optionIds.has(id)) bad(`${at}: the option id ${JSON.stringify(id)} appears twice`);
      optionIds.add(id);
      claim(label);
      options.push(norm);
    }
    catalogs.push({ id: c.id, name: c.name, options });
  }
  // menuless: lists outside the menus (Marco, 28/10/2026), cited here and nowhere else
  const menuless = [];
  if (json.menuless !== undefined) {
    if (!Array.isArray(json.menuless)) bad('menuless must be a list of list ids of config.json');
    else for (const id of json.menuless) {
      if (typeof id !== "string" || !byId.has(id)) bad(`menuless: list ${JSON.stringify(id)} is not a list of config.json`);
      else if (menuless.includes(id)) bad(`menuless: list ${id} appears twice`);
      else { menuless.push(id); cite(id, "menuless"); }
    }
  }
  for (const l of lists) if (!inCatalog.has(l.id)) bad(`list ${l.id} (${l.name}) has no Discover catalog (put it in an option, or in "menuless")`);
  // explore: the catalog whose options are the Genre filter of Explore (Marco, 28/10/2026): every option a calculated genre filter (`any`), none called "All" (the menu's first value is "All")
  let explore = null;
  if (json.explore !== undefined) {
    const x = json.explore;
    if (!plain(x) || Object.keys(x).some((k) => k !== "genre") || typeof x.genre !== "string") bad('explore must be { "genre": <id of a catalog of this file> }');
    else {
      const target = catalogs.find((c) => c.id === x.genre);
      if (!target) bad(`explore.genre ${JSON.stringify(x.genre)} is not a catalog of this file`);
      else {
        for (const o of target.options) if (o.kind !== "any") bad(`explore.genre ${JSON.stringify(x.genre)}: ${o.kind === "directors" ? "the directors cards" : JSON.stringify(o.label)} is not a calculated genre filter (kind any); a catalog with curated options (a list, a union of lists, a card) cannot be the filter of Explore`);
        for (const o of target.options) if (o.label && words(o.label) === "all") bad(`explore.genre ${JSON.stringify(x.genre)}: an option called "All" would be the first value of the menu twice`);
        explore = { genre: x.genre };
      }
    }
  }

  const order = json.order, retire = json.retire;
  if (!Array.isArray(order) || order.some((x) => typeof x !== "string")) bad("order must be a list of catalog ids");
  else {
    const want = [...catalogIds, ...FIXED].sort();
    const have = [...order].sort();
    if (JSON.stringify(want) !== JSON.stringify(have)) {
      const missing = want.filter((x) => !order.includes(x)), extra = order.filter((x, i) => !want.includes(x) || order.indexOf(x) !== i);
      bad(`order must hold every catalog of the file and ${FIXED.join(", ")} once each${missing.length ? `; missing: ${missing.join(", ")}` : ""}${extra.length ? `; not allowed or twice: ${extra.join(", ")}` : ""}`);
    }
  }
  if (!Array.isArray(retire) || retire.some((x) => !RETIRABLE.includes(x))) bad(`retire must be a list with only ${RETIRABLE.slice(0, -1).join(", ")} and ${RETIRABLE.at(-1)}`);

  if (problems.length) throw new Error(`data/discover-catalogs.json has ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n  - ${problems.join("\n  - ")}`);
  return { floor, order: [...order], retire: [...retire], seen: { name: seen.name, option: seen.option }, spread: { per: spread.per, ...(spread.perAfterFirstPage !== undefined ? { perAfterFirstPage: spread.perAfterFirstPage } : {}), window: spread.window }, menuless, ...(explore ? { explore } : {}), catalogs };
}

/**
 * THE one place where a film's country is chosen for the option of a country: the same expression as factsByTt() of lib/index-export.js (its `country`): the column `country` of the entry,
 * which the build writes only when the main country the facts use is not the first of `countries`, else the first name of the column `countries`. Marco, 22/10/2026 (questionnaire 3, answer a,
 * "the country of the card"; the v3 card has no country line any more, the facts are the same). The rule for a film's MAIN country was decided on 23/10/2026 (lib/countries.js
 * mainCountry: the director's country, then TMDB's origin_country, then the rule of 14/10/2026) and the columns carry its answer; `where.countries` / `where.region` call the same function.
 */
const countryOf = (entry) => entry.country || (entry.countries && entry.countries[0]) || null;

/**
 * The ids of `ids` in an order that does not put the same director on the screen again and again, without taking any film out (Marco's catalogs are walked to the end, and the
 * Board's cut of two a director would hide 357 of France's 827 films). Marco, 23/10/2026 ("nao tem outros diretores, eu sei q nao coreia tem mtos"), read by the session: where there are
 * films of other directors, no stretch of `window` consecutive films has more than `per` of one director; the surplus goes down; when the other directors have run out, the
 * director who is left fills the rest (Sweden is Bergman almost to the end: there is no one else).
 *
 * Marco, 23/10/2026 (the surplus of a prolific director, questionnaire, answer b: "Teto 2 só na primeira página; depois uns 5 por bloco de 20"): the cap is `per` (2) in the first
 * `window` places and `perAfterFirstPage` (5) in every stretch of `window` places after them (the places of the screen, for a shown film; a place counts for the cap that is current when it is
 * filled). Without `perAfterFirstPage` the cap is `per` everywhere, as the first version of 23/10/2026 was. Before that answer a director with 24 of 100 films still ended the option with 17 in a row.
 *
 * One film at a time, from the start: the candidates are the first film still waiting of each director (so the order WITHIN a director is always the order of `ids`), and the one that
 * goes out is the earliest in `ids` among those whose director has fewer than `per` films among the last `window - 1` already placed (with the one placed, `window` consecutive
 * films hold at most `per`). When every director who is left is already at `per` (a small option: Poetic realism has six directors, and 20 films cannot be filled with two of each)
 * the film that goes out is the one whose director has the fewest in the window, the earliest in `ids` among those: the load is shared, not dumped on the director of the first films.
 *
 * `shown(tt)` (optional): the films the Worker shows by default (not seen, not held back by the music rule). The Worker hides the others, and the promise must hold on the screen. A film
 * that is shown is judged against two windows, the one of all the films placed (the order of "Include seen", in which the films the music rule holds back are still hidden) and the one of the shown ones alone, and the screen's comes first: three
 * tiers, room in both windows, room on the screen's alone, room in neither (a film that is not shown takes no room on the screen). Within a tier, the rule above; in the last, the fewest in the window first. directorOf(tt) is the
 * first director of the entry, or null (a film with no known director is never held back; a film with two directors counts for the first only, as diversify() of the Worker does).
 */
function spread(ids, directorOf, { per = 2, perAfterFirstPage = per, window = 20 } = {}, shown = () => true) {
  const queues = new Map(), free = []; // director → the films of that director still waiting, in the order of ids; free: the films with no known director
  ids.forEach((tt, i) => {
    const d = directorOf(tt), item = { tt, i, d, vis: shown(tt) };
    if (!d) free.push(item);
    else if (queues.has(d)) queues.get(d).items.push(item);
    else queues.set(d, { items: [item], at: 0 });
  });
  let freeAt = 0;
  const out = [], onScreen = [], inAll = new Map(), inShown = new Map(); // onScreen: the placed films that are shown
  const bump = (m, d, by) => m.set(d, (m.get(d) || 0) + by);
  // the tiers of a film that could go out now: 0, its director has room in both windows; 1, in the screen's window alone (a film that is not shown never takes room on the screen); 2, in neither
  // the cap of the place that comes next: `per` in the first `window` places (the first page), `perAfterFirstPage` from then on; the screen's places are counted among the shown films, those of "Include seen" among all
  let capAll = per, capScreen = per;
  const rank = (x) => {
    if (!x.d) return [0, 0, x.i];
    const all = inAll.get(x.d) || 0, screen = x.vis ? inShown.get(x.d) || 0 : 0;
    return all < capAll && screen < capScreen ? [0, 0, x.i] : screen < capScreen ? [1, 0, x.i] : [2, Math.max(all, screen), x.i];
  };
  while (out.length < ids.length) {
    capAll = out.length < window ? per : perAfterFirstPage;
    capScreen = onScreen.length < window ? per : perAfterFirstPage;
    let best = null, bestRank = null;
    const look = (x) => {
      const r = rank(x);
      if (!best || r[0] < bestRank[0] || (r[0] === bestRank[0] && (r[1] < bestRank[1] || (r[1] === bestRank[1] && r[2] < bestRank[2])))) { best = x; bestRank = r; }
    };
    for (const q of queues.values()) look(q.items[q.at]);
    if (freeAt < free.length) look(free[freeAt]);
    const pick = best;
    if (!pick.d) freeAt++;
    else { const q = queues.get(pick.d); q.at++; if (q.at === q.items.length) queues.delete(pick.d); }
    out.push(pick);
    if (pick.d) bump(inAll, pick.d, 1);
    if (pick.d && pick.vis) bump(inShown, pick.d, 1);
    if (pick.vis) onScreen.push(pick);
    // the window for the next film is the last `window - 1` placed
    if (out.length >= window) { const gone = out[out.length - window]; if (gone.d) bump(inAll, gone.d, -1); }
    if (onScreen.length >= window && pick.vis) { const gone = onScreen[onScreen.length - window]; if (gone.d) bump(inShown, gone.d, -1); }
  }
  return out.map((x) => x.tt);
}

/**
 * The `discover` object of the v2 index: { order, retire, seen, explore?, catalogs: [{ id, name, options: [option] }] } where an option is
 *   { id, label, ids }                                       a calculated option: the films, in the order the Worker serves them (the rule of recommendation applies)
 *   { id, label, ids, curated: true }                        an editorial union of lists: the films of the lists, no rule
 *   { id, label, ids, curated: true, director: "<X loves>" } a card of a director: his "X loves" and his lists, no rule; `director` names the option of index.directors.options it grew from
 *   { id, label, list }                                      a list option: the Worker reads the list's own piece
 * spec: parse(). index: the v2 index in object form (films with `eligible`, `seen`, `year`, `decade`, `lists`, `lbRating`, `imdbRating`, `tmdbVotes`, `runtime`, `genres`, `keywords`, `director`, `country`/`countries`; `directors.options`).
 * recordOf(tt): the film's OWN TMDB record, or null: a film with none passes no `where`, so it is in no region and no era (it can still be in a country and a decade).
 * minFeatureMinutes: the shortRow.minMinutes of config.json (build.js passes P.minFeatureMinutes(cfg); 40 when it is not given): the director door of an era takes no film under it (Marco, 15/11/2026, "Only where you or a source put them"); P.isShort is the one function that decides, and a film with no known runtime stays.
 * log: one line per catalog, one per option with its unseen films that the Worker shows (a curated option shows every unseen film, the music rule does not apply to it), " !" when it falls under the floor of the spec
 * or when it is a list option that a card fell back to because its "X loves" is not there tonight.
 */
function build({ spec, index, recordOf, log = () => {}, minFeatureMinutes = MIN_FEATURE_MINUTES }) {
  const eligible = index.films.filter((e) => e.eligible);
  const directorOf = (() => { const by = new Map(index.films.map((e) => [e.tt, e.director ? e.director.split(", ")[0] : null])); return (tt) => by.get(tt) || null; })();
  const byTt = new Map(index.films.map((e) => [e.tt, e]));
  // what the Worker shows by default (catalogs.js select(): not seen, and `recommendable` = eligible and not held back by the music rule); the spread keeps its promise on that screen
  const showsByDefault = (tt) => { const e = byTt.get(tt); return !e.seen && !e.musicOut && !e.shortOut; }; // (a short is not shown either, 15/11/2026: bit 16, lib/index-export.js)
  // an era option (`shorts: true`): the same, but a short of its ids is shown (its file names it)
  const eraShows = (tt) => { const e = byTt.get(tt); return !e.seen && !e.musicOut; };
  // a curated option has no recommendation rule at all (the Worker keeps the music rule out of it too): it shows every film that is not seen
  const curatedShows = (tt) => !byTt.get(tt).seen;
  const hasList = (e, id) => !!e.lists && Object.hasOwn(e.lists, id);
  const spreadOf = (tts, shown) => spread(tts, directorOf, spec.spread, shown);
  const inIndexOrder = (set) => index.films.filter((e) => set.has(e.tt)).map((e) => e.tt);
  const counted = new Map(); // list id → its films that are not seen, for the log of a list option
  for (const e of index.films) if (!e.seen && e.lists) for (const id of Object.keys(e.lists)) counted.set(id, (counted.get(id) || 0) + 1);

  /** The ids of an option that is worked out from the columns of the index (not a `where`, a country or a decade). */
  const fromColumns = (o) => {
    if (o.kind === "union") return spreadOf(index.films.filter((e) => o.lists.some((id) => hasList(e, id))).map((e) => e.tt), curatedShows);
    if (o.kind === "any") {
      const hit = [(e) => o.lists.some((id) => hasList(e, id)), (e) => o.keywords.some((k) => (e.keywords || []).includes(k)), (e) => !!o.genre && (e.genres || []).includes(o.genre)];
      const blocks = [[], [], []]; // the films of the lists, then those with a keyword, then the rest (the genre alone), each in the order of the index
      for (const e of eligible) { const b = hit.findIndex((h) => h(e)); if (b >= 0) blocks[b].push(e.tt); }
      return spreadOf(blocks.flat(), showsByDefault);
    }
    if (o.kind === "runtime") return spreadOf(eligible.filter((e) => e.runtime != null && e.runtime >= o.min).map((e) => e.tt), showsByDefault);
    // rating: every condition at once. imdbTop N = the N best IMDb ratings among ALL the films with enough votes (not only the eligible ones), the ties at the cut included
    const votesOk = (e) => (e.tmdbVotes || 0) >= (o.tmdbVotesMin || 0);
    const conditions = [votesOk];
    if (o.imdbMin !== undefined) conditions.push((e) => e.imdbRating != null && e.imdbRating >= o.imdbMin);
    if (o.lbMin !== undefined) conditions.push((e) => e.lbRating != null && e.lbRating >= o.lbMin);
    if (o.imdbTop !== undefined) {
      const ranked = index.films.filter((e) => e.imdbRating != null && votesOk(e)).sort((x, y) => y.imdbRating - x.imdbRating);
      const cut = ranked.length >= o.imdbTop ? ranked[o.imdbTop - 1].imdbRating : -Infinity;
      const top = new Set(ranked.filter((e) => e.imdbRating >= cut).map((e) => e.tt));
      conditions.push((e) => top.has(e.tt));
    }
    return spreadOf(eligible.filter((e) => conditions.every((test) => test(e))).map((e) => e.tt), showsByDefault);
  };

  /** The options a `directors` entry stands for: one card per option of index.directors.options, in that order; then the lists of a card whose "X loves" is not there tonight. */
  const cards = (o) => {
    const loves = (index.directors && index.directors.options) || [];
    const card = new Map(o.cards.map((c) => [c.key, c]));
    const out = loves.map((L) => {
      const mine = card.get(L.label);
      const set = new Set(L.ids);
      if (mine) for (const e of index.films) if (mine.lists.some((l) => hasList(e, l.id))) set.add(e.tt);
      return { opt: { id: `d-${words(L.label).replace(/ /g, "-")}`, label: mine ? mine.label : L.label, ids: spreadOf(inIndexOrder(set), curatedShows), curated: true, director: L.label } };
    });
    for (const c of o.cards) if (!loves.some((L) => L.label === c.key)) for (const l of c.lists) out.push({ opt: { id: `l-${l.id}`, label: l.label, list: l.id }, orphan: true });
    return out;
  };

  /** The members of an era file (lib/era-lists.js): not written out, AND (in the list of films, inside the years of the index) OR (a school, and `passes` with the directors, the years and the country: lib/moods.js, as ever). */
  const eraMember = (era) => {
    const door2 = era.type === "school" ? { years: era.years, directorsAny: era.directors, countries: era.countries } : null;
    return (e) => {
      if (era.exclude.has(e.tt)) return false;
      if (era.listedIn(e.tt, e.year)) return true;
      if (!door2) return false;
      if (isShort(e.runtime, minFeatureMinutes)) return false; // a short comes in by the list (a source names it), never by the director's door
      const film = recordOf(e.tt);
      return !!film && passes({ film, lbYear: e.year, lb: e.lbRating, lists: Object.keys(e.lists || {}) }, door2);
    };
  };

  const made = spec.catalogs.map((c) => c.options.flatMap((o) => {
    if (o.kind === "directors") return cards(o);
    if (o.kind === "list") return [{ opt: { id: o.id, label: o.label, list: o.list } }];
    if (["union", "any", "runtime", "rating"].includes(o.kind)) return [{ opt: { id: o.id, label: o.label, ids: fromColumns(o), ...(o.kind === "union" ? { curated: true } : {}) } }];
    let member;
    if (o.kind === "country") member = (e) => countryOf(e) === o.country;
    else if (o.kind === "decade") member = (e) => e.decade === o.decade;
    else if (o.kind === "era") member = eraMember(o.era);
    else member = (e) => { const film = recordOf(e.tt); return !!film && passes({ film, lbYear: e.year, lb: e.lbRating, lists: Object.keys(e.lists || {}) }, o.where); };
    // an era file, or the one period Marco keeps the shorts in (SHORTS_PERIODS above: the Silent era): the option says `shorts: true`
    if (o.kind === "era" || (o.kind === "where" && SHORTS_PERIODS.includes(o.id))) return [{ opt: { id: o.id, label: o.label, ids: spreadOf(eligible.filter(member).map((e) => e.tt), eraShows), shorts: true }, kind: o.kind }];
    return [{ opt: { id: o.id, label: o.label, ids: spreadOf(eligible.filter(member).map((e) => e.tt), showsByDefault) }, kind: o.kind }];
  }));
  const catalogs = spec.catalogs.map((c, ci) => ({ id: c.id, name: c.name, options: made[ci].map((m) => m.opt) }));
  for (const [ci, c] of catalogs.entries()) {
    log(`  Discover ${c.id}: ${c.options.length} options`);
    for (const [oi, o] of c.options.entries()) {
      const m = made[ci][oi];
      const shown = o.list !== undefined ? counted.get(o.list) || 0 : o.ids.filter((tt) => (o.curated ? curatedShows : o.shorts ? eraShows : showsByDefault)(tt)).length;
      const floor = m.kind === "country" ? spec.floor.countries : c.id === "eras" && (m.kind === "where" || m.kind === "era") ? spec.floor.eras : 0;
      log(`    ${o.label} ${shown}${shown < floor || m.orphan ? " !" : ""}`);
    }
  }
  return { order: spec.order, retire: spec.retire, seen: spec.seen, ...(spec.explore ? { explore: spec.explore } : {}), catalogs };
}

module.exports = { FILE, FIXED, NAME_PREFIX, NAME_MAX, TMDB_GENRES, SHORTS_PERIODS, shortsOptionIds, load, parse, build, spread, countryOf };
