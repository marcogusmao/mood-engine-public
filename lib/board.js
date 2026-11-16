// config.json "board": the Board of the v2 index family (Marco, 13/10/2026: 54 fixed rows, none rotating, under their own names).
//
//   "board": {
//     "order":       ["tonight", "watchlist", "my-series", …]    the Board, top to bottom; every id a row the build can make (below)
//     "names":       { "tonight": "🎯 Tonight: 10 picks", … }    the name Stremio shows, one for EVERY id of `order`, and no other
//     "place":       { "friends-week": "menu" }                  "fixed" (default: the row is a catalog of the manifest) or "menu" (served as an option of the Moods menu only)
//     "legacyMoods": ["lift", "escape", …]                       the moods of the legacy family: all nine the profiles read (lib/learning/schema.js MOODS), each a mood of config.json.
//                                                                The moods of config.json outside this list exist only in the v2 family (legacyConfig() in lib/board-shared.js)
//     "moodMenu":    ["lift", …, "friends-week"]                 the options of the Moods menu: a mood id, or a row with place "menu"
//     "menuLabels":  { "friends-week": "Friends this week" }     the label of each moodMenu entry that is not a mood (a mood's label is its `word`)
//     "countries":   ["United States", …]                       optional: the frozen country menu of the v2 family (meta.countriesAll)
//     "tonightMoods", "webMoods": optional lists, each inside legacyMoods (validated; nothing reads them yet: the legacy Tonight and picker see exactly legacyMoods)
//     "moods":       [{ id, name, word, genres, keywords, minFit, where, lists, … }]   moods that exist in the v2 family alone (PR2): a recipe like those of config.json "moods",
//                                                                with an optional `where` gate and `lists` ({ <list id>: weight }). They are not in config.json "moods" on purpose: a mood there
//                                                                reaches the legacy family unless a board names the legacy ones (lib/board-shared.js), and PR5 moves them when the board goes to production
//     "rows":        [{ id: "1970s", kind: "filter", where: {…} }, { id: "small-kind", kind: "combine", parts: […], boost: […], tune: "taste" }]   recipes of the rows that are not a mood or a builtin
//   }
//     "shuffle":     optional: the front shuffle of the v2 Board (lib/front-shuffle.js, Marco 14/10/2026). Absent = the rows keep their strict order. Keys (all optional; defaults in FS.DEFAULTS):
//                    front (whole number 1-20: the films that count as the front of a row), tau (> 0, <= 100: places that cost a film 1/e of its chance), penalty (>= 0: places a front of yesterday pushes
//                    a film down), maxFronts / maxLeads (whole numbers >= 1: rows one film may stand in the front of / open in a day), memory ("file" = cache/front-memory.json, "none"),
//                    memoryDays (whole number 0-30), halfLifeDays (> 0, <= 100), keep (ids of `order` that are not reordered: Tonight and the Watchlist)
//   kind "filter"    every candidate that passes `where` (lib/moods.js passes), ranked with no mood, 2 films per director, at most 100 (V2_ROW_MAX). `part: true` makes it
//                    a list that is not a Board row (not in `order`) but a part of a combined one: "Latin America" is Brazil from 2001, Brazil to 2000 and the Spanish-speaking Americas
//   kind "combine"   2 to 4 moods (`parts`) with equal shares, interleaved A1 B1 C1 A2 …, no film twice; boost: [{ part, x, months?: [1-12], weekdays?: [0 = Sunday] }] multiplies the share of
//                    a part on the build's day; tune "taste" weighs the shares by what Marco rates (lib/board-rows.js)
//   the special kinds (top-picks, friends-split, friends-watchlist, friends-month, awards, untried-directors, actor-week, list; lib/special-rows.js, PR3): each has defaults in
//                    SR.DEFAULT_ROWS, so a Board may name "top-picks" in `order` with no recipe; a recipe in `rows` with the same id and kind overrides the defaults. They reach plan.board2
//                    through plan.rows2, never through `extra` (an id of a legacy row, of a mood or of the series row is refused for every recipe: see REPLACEABLE)
//
// Without "board" parse() gives null and the build is the one of every night so far, identical apart from meta.builtAt. With it the build writes the v2 family next to
// the legacy files (lib/index-export.js buildIndex with `v2`), which the 3.1.0 Worker and the five profiles never read.
//
// The ids a row may have are the ones the build already makes: the legacy Board's (lib/plan.js) and the moods of config.json, plus the series row
// the Worker builds itself. A new kind of row (PR2, PR3) widens KNOWN here, so a typo in `order` stops the build at its first step instead of
// publishing an empty row under a name Stremio has already installed.
//
// A row id becomes part of a file name (data/index-v2-row-<id>.json) that lib/learning/public.js allows by its pattern: lower case, digits, hyphens.

const { BOARD_BEFORE_MOODS, BOARD_AFTER_MOODS, uniqueOptions } = require("./plan");
const { ROW_ID: ID, SERIES_ROWS, legacyConfig } = require("./board-shared");
const PROFILE_MOODS = require("./learning/schema").MOODS; // the nine moods the Worker's profiles and the picker read
const { validateWhere } = require("./moods");
const SR = require("./special-rows"); // the rows of a special kind (top-picks, friends-split, awards, list …): their recipes live in board.rows beside the filters and the combined rows
const FS = require("./front-shuffle"); // the knobs of the front shuffle and their defaults
const KEYS = ["order", "names", "place", "legacyMoods", "tonightMoods", "webMoods", "moodMenu", "menuLabels", "countries", "moods", "rows", "shuffle"];
// what a mood recipe may say: the keys lib/moods.js fit() reads, the labels, and the two the v2 moods add
const MOOD_KEYS = ["id", "name", "word", "blurb", "genres", "keywords", "directors", "nonEnglish", "nonAnglo", "runtime", "requireGenre", "needHit", "hitMin", "keywordCap", "minFit", "where", "lists"];
const ROW_KINDS = { filter: ["id", "kind", "where", "part"], combine: ["id", "kind", "parts", "boost", "tune"], ...SR.ROW_KEYS };
const BOOST_KEYS = ["part", "x", "months", "weekdays"];
const COMBINE_PARTS = { min: 2, max: 4 };
// The one Board row a recipe may take over from the legacy family: "Horror" of the v2 Board mixes wicked, slasher and horror-comedy, and the legacy "wicked" does not change (lib/plan.js rows2).
// Any other id of a legacy row, of the series row or of a mood in `board.rows` would win over it in silence in plan.board2: refused.
const REPLACEABLE = ["wicked"];

const isObject = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const isText = (x) => typeof x === "string" && x.trim() === x && x.length > 0 && !/[\r\n]/.test(x);

/** The ids a Board row may have: the legacy Board's, the moods', the rows the board defines itself, and the series row. */
function knownRows(moodIds, rowIds = []) {
  return new Set([...BOARD_BEFORE_MOODS, ...moodIds, ...BOARD_AFTER_MOODS, ...SERIES_ROWS, ...rowIds, ...SR.DEFAULT_ROWS.map((r) => r.id)]);
}

const numbers = (o) => !!o && typeof o === "object" && !Array.isArray(o) && Object.values(o).every((n) => typeof n === "number" && Number.isFinite(n));

/** The problems of the moods a board defines (`board.moods`); `taken`: the ids config.json "moods" already has. */
function moodProblems(defs, taken, bad) {
  if (!Array.isArray(defs)) { bad("moods must be a list of mood recipes"); return; }
  const seen = new Set();
  defs.forEach((m, i) => {
    const at = `moods[${i}]${m && m.id ? ` (${m.id})` : ""}`;
    if (!isObject(m)) return bad(`${at} must be an object`);
    if (typeof m.id !== "string" || !ID.test(m.id)) return bad(`${at}: id must be lower case letters, digits and hyphens (its slice is index-v2-mood-<id>.json)`);
    if (taken.has(m.id) || seen.has(m.id)) bad(`${at}: "${m.id}" is already a mood`);
    seen.add(m.id);
    for (const k of Object.keys(m)) if (!MOOD_KEYS.includes(k)) bad(`${at}: unexpected key "${k}"${k === "pins" ? " (a pin would add a film to the pool of the legacy family)" : ""} (allowed: ${MOOD_KEYS.join(", ")})`);
    for (const k of ["name", "word"]) if (!isText(m[k])) bad(`${at}: ${k} must be a single line of text`);
    for (const k of ["genres", "keywords", "directors", "lists"]) if (m[k] !== undefined && !numbers(m[k])) bad(`${at}: ${k} must be { name: weight } with numbers`);
    if (m.minFit !== undefined && (typeof m.minFit !== "number" || !Number.isFinite(m.minFit))) bad(`${at}: minFit must be a number`);
    if (m.where !== undefined) for (const p of validateWhere(m.where, `${at}.where`)) bad(p);
  });
}

/** The problems of the rows a board defines (`board.rows`). order: the ids of the Board; moodIds: every mood the v2 family has. → the ids defined */
function rowProblems(defs, order, moodIds, bad, listIds = []) {
  if (!Array.isArray(defs)) { bad("rows must be a list of row recipes"); return []; }
  const ids = [];
  const taken = new Set([...BOARD_BEFORE_MOODS, ...BOARD_AFTER_MOODS, ...SERIES_ROWS, ...moodIds]); // ids the build already makes
  const partIds = defs.filter((r) => r && r.kind === "filter" && r.part === true && typeof r.id === "string").map((r) => r.id); // filters that are parts of a combined row
  defs.forEach((r, i) => {
    const at = `rows[${i}]${r && r.id ? ` (${r.id})` : ""}`;
    if (!isObject(r)) return bad(`${at} must be an object`);
    if (typeof r.id !== "string" || !ID.test(r.id)) return bad(`${at}: id must be lower case letters, digits and hyphens`);
    if (ids.includes(r.id)) bad(`${at}: "${r.id}" is defined twice`);
    ids.push(r.id);
    if (taken.has(r.id) && !(REPLACEABLE.includes(r.id) && r.kind === "combine")) bad(`${at}: "${r.id}" is already ${moodIds.includes(r.id) ? "a mood" : "a row"} of the build, and a recipe of the same id would replace it in silence${REPLACEABLE.length ? ` (only a combined ${REPLACEABLE.map((x) => `"${x}"`).join(", ")} may)` : ""}`);
    if (r.part === true) {
      if (r.kind !== "filter") bad(`${at}: only a filter row can be a part`);
      if (order.includes(r.id)) bad(`${at}: "${r.id}" is a part of a combined row and is also in order: a part is not a Board row`);
      if (moodIds.includes(r.id)) bad(`${at}: "${r.id}" is already a mood`);
    } else if (r.part !== undefined) bad(`${at}: part must be true or absent`);
    else if (!order.includes(r.id)) bad(`${at}: "${r.id}" is not in order (a recipe without a place on the Board would never run)`);
    const allowed = ROW_KINDS[r.kind];
    if (!allowed) return bad(`${at}: kind must be one of ${Object.keys(ROW_KINDS).join(", ")}`);
    for (const k of Object.keys(r)) if (!allowed.includes(k)) bad(`${at}: a ${r.kind} row has no "${k}" (allowed: ${allowed.join(", ")})`);
    if (r.kind === "filter") for (const p of validateWhere(r.where, `${at}.where`)) bad(p);
    const dflt = SR.DEFAULT_ROWS.find((d) => d.id === r.id);
    if (dflt && !SR.KINDS.includes(r.kind)) bad(`${at}: "${r.id}" is a special row (lib/special-rows.js): its id is reserved, a ${r.kind} recipe may not take it`);
    if (dflt && SR.KINDS.includes(r.kind) && dflt.kind !== r.kind) bad(`${at}: "${r.id}" is a "${dflt.kind}" row; its kind cannot become "${r.kind}"`);
    if (SR.KINDS.includes(r.kind)) for (const p of SR.recipeProblems({ ...(SR.DEFAULT_ROWS.find((d) => d.id === r.id && d.kind === r.kind) || {}), ...r }, listIds)) bad(`${at}: ${p}`);
    if (r.kind === "combine") {
      const parts = r.parts;
      if (!Array.isArray(parts) || parts.length < COMBINE_PARTS.min || parts.length > COMBINE_PARTS.max || parts.some((p) => typeof p !== "string")) return bad(`${at}: parts must be ${COMBINE_PARTS.min} to ${COMBINE_PARTS.max} mood ids or part filters`);
      for (const p of parts) if (!moodIds.includes(p) && !partIds.includes(p)) bad(`${at}: part "${p}" is neither a mood nor a filter with part: true`);
      if (new Set(parts).size !== parts.length) bad(`${at}: parts lists a mood twice`);
      if (r.tune !== undefined && r.tune !== "taste") bad(`${at}: tune must be "taste"`);
      if (r.boost !== undefined && !Array.isArray(r.boost)) bad(`${at}: boost must be a list`);
      for (const [j, b] of (Array.isArray(r.boost) ? r.boost : []).entries()) {
        const bt = `${at}.boost[${j}]`;
        if (!isObject(b)) { bad(`${bt} must be an object`); continue; }
        for (const k of Object.keys(b)) if (!BOOST_KEYS.includes(k)) bad(`${bt}: unexpected key "${k}" (allowed: ${BOOST_KEYS.join(", ")})`);
        if (!parts.includes(b.part)) bad(`${bt}: part "${b.part}" is not one of the parts`);
        if (typeof b.x !== "number" || !(b.x > 0) || !Number.isFinite(b.x)) bad(`${bt}: x must be a number above 0`);
        if (b.months === undefined && b.weekdays === undefined) bad(`${bt}: a boost needs months (1-12) or weekdays (0 = Sunday), or it would always apply`);
        if (b.months !== undefined && !(Array.isArray(b.months) && b.months.length && b.months.every((m) => Number.isInteger(m) && m >= 1 && m <= 12))) bad(`${bt}: months must be 1 to 12`);
        if (b.weekdays !== undefined && !(Array.isArray(b.weekdays) && b.weekdays.length && b.weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))) bad(`${bt}: weekdays must be 0 (Sunday) to 6`);
      }
    }
  });
  return ids;
}

/** The problems of board.shuffle; inOrder: the ids of `order`. Each message names the key. */
function shuffleProblems(sh, inOrder, bad) {
  if (!isObject(sh)) return bad("shuffle must be an object (or absent, for no shuffle)");
  for (const k of Object.keys(sh)) if (!(k in FS.DEFAULTS)) bad(`shuffle: unexpected key "${k}" (allowed: ${Object.keys(FS.DEFAULTS).join(", ")})`);
  const whole = (k, min, max) => {
    if (sh[k] === undefined) return;
    if (!Number.isInteger(sh[k]) || sh[k] < min || sh[k] > max) bad(`shuffle.${k} must be a whole number from ${min} to ${max}, got ${JSON.stringify(sh[k])}`);
  };
  const above0 = (k) => {
    if (sh[k] === undefined) return;
    if (typeof sh[k] !== "number" || !Number.isFinite(sh[k]) || !(sh[k] > 0) || sh[k] > 100) bad(`shuffle.${k} must be a number above 0 and at most 100, got ${JSON.stringify(sh[k])}`);
  };
  whole("front", 1, 20); whole("maxFronts", 1, 54); whole("maxLeads", 1, 54); whole("memoryDays", 0, 30);
  above0("tau"); above0("halfLifeDays");
  if (sh.penalty !== undefined && (typeof sh.penalty !== "number" || !Number.isFinite(sh.penalty) || sh.penalty < 0)) bad(`shuffle.penalty must be a number, 0 or more, got ${JSON.stringify(sh.penalty)}`);
  if (sh.memory !== undefined && !["file", "none"].includes(sh.memory)) bad(`shuffle.memory must be "file" or "none", got ${JSON.stringify(sh.memory)}`);
  if (sh.keep !== undefined) {
    if (!Array.isArray(sh.keep) || sh.keep.some((x) => typeof x !== "string")) bad("shuffle.keep must be a list of row ids");
    else for (const id of sh.keep) if (!inOrder.has(id)) bad(`shuffle.keep: "${id}" is not in order`);
  }
}

/** Every problem of cfg.board as a sentence; [] when there is no board or it is sound. `source` says where the board came from ("config.json board" or "--board <file>"). */
function problems(cfg, source = "config.json board") {
  const board = cfg.board;
  if (board === undefined) return [];
  if (!isObject(board)) return [`${source} must be an object`];
  const out = [];
  const bad = (m) => out.push(`${source}: ${m}`);
  const cfgMoodIds = (cfg.moods || []).map((m) => m.id);
  if (board.moods !== undefined) moodProblems(board.moods, new Set(cfgMoodIds), bad);
  const moodIds = [...cfgMoodIds, ...(Array.isArray(board.moods) ? board.moods.filter((m) => m && typeof m.id === "string").map((m) => m.id) : [])]; // every mood of the v2 family
  const rowDefs = board.rows === undefined ? [] : board.rows;
  const known = knownRows(moodIds, Array.isArray(rowDefs) ? rowDefs.filter((r) => r && typeof r.id === "string").map((r) => r.id) : []);
  for (const k of Object.keys(board)) if (!KEYS.includes(k)) bad(`unexpected key "${k}" (allowed: ${KEYS.join(", ")})`);

  const list = (key, what) => {
    const v = board[key];
    if (!Array.isArray(v) || !v.length) { bad(`${key} must be a non-empty list of ${what}`); return null; }
    if (v.some((x) => typeof x !== "string")) { bad(`${key} must hold only text`); return null; }
    const dup = v.find((x, i) => v.indexOf(x) !== i);
    if (dup !== undefined) bad(`${key} lists "${dup}" twice`);
    return v;
  };

  const order = list("order", "row ids");
  if (order) {
    for (const id of order) {
      if (!ID.test(id)) bad(`order: "${id}" is not a row id (lower case letters, digits and hyphens; it becomes part of a file name)`);
      else if (!known.has(id)) bad(`order: "${id}" is not a row the build can make`);
    }
  }
  const inOrder = new Set(order || []);
  const configListIds = (cfg.lists || []).map((l) => l.id);
  if (board.rows !== undefined) rowProblems(rowDefs, order || [], moodIds, bad, configListIds);
  // a special row named in `order` with no recipe of its own runs on the defaults: they must be sound for this config too (a default `list` row needs its lists)
  const recipes = new Set((Array.isArray(rowDefs) ? rowDefs : []).filter((r) => r && typeof r.id === "string").map((r) => r.id));
  for (const id of order || []) {
    const d = SR.DEFAULT_ROWS.find((x) => x.id === id);
    if (d && !recipes.has(id)) for (const p of SR.recipeProblems(d, configListIds)) bad(`rows: "${id}" (default): ${p}`);
  }

  if (!isObject(board.names)) bad("names must be an object: one name per id of order");
  else {
    for (const id of order || []) if (!isText(board.names[id])) bad(`names: "${id}" has no name (a single line of text, no spaces around it)`);
    for (const id of Object.keys(board.names)) if (!inOrder.has(id)) bad(`names: "${id}" is not in order`);
    const first = new Map();
    for (const id of order || []) {
      const n = board.names[id];
      if (!isText(n)) continue;
      if (first.has(n)) bad(`names: "${id}" and "${first.get(n)}" are both called "${n}" (Stremio would show two rows with one name)`);
      else first.set(n, id);
    }
  }

  const place = board.place === undefined ? {} : board.place;
  if (!isObject(place)) bad("place must be an object: row id → fixed | menu");
  else
    for (const [id, p] of Object.entries(place)) {
      if (!inOrder.has(id)) bad(`place: "${id}" is not in order`);
      else if (p !== "fixed" && p !== "menu") bad(`place: "${id}" is ${JSON.stringify(p)}, expected "fixed" or "menu"`);
      else if (p === "menu" && SERIES_ROWS.includes(id)) bad(`place: the series row "${id}" cannot be a menu option`);
      else if (p === "menu" && moodIds.includes(id)) bad(`place: "${id}" is a mood of config.json: it cannot also be a menu row (its Moods option is the mood itself)`);
    }
  const isMenu = (id) => isObject(place) && place[id] === "menu";

  const legacy = list("legacyMoods", "mood ids");
  for (const id of legacy || []) if (!cfgMoodIds.includes(id)) bad(`legacyMoods: "${id}" is not a mood of config.json`);
  if (legacy) for (const id of PROFILE_MOODS) if (!legacy.includes(id)) bad(`legacyMoods: "${id}" is missing, and the profiles and the picker read it from the legacy family`);
  for (const key of ["tonightMoods", "webMoods"])
    if (board[key] !== undefined) {
      const v = list(key, "mood ids");
      for (const id of v || []) if (legacy && !legacy.includes(id)) bad(`${key}: "${id}" is not in legacyMoods`);
    }

  const menu = list("moodMenu", "mood ids and menu rows");
  for (const id of menu || []) if (!ID.test(id)) bad(`moodMenu: "${id}" is not an id (lower case letters, digits and hyphens; a mood's slice is index-v2-mood-<id>.json)`);
  const labels = board.menuLabels === undefined ? {} : board.menuLabels;
  if (!isObject(labels)) bad("menuLabels must be an object: moodMenu id → label");
  for (const id of menu || []) {
    if (moodIds.includes(id)) continue;
    if (!inOrder.has(id) || !isMenu(id)) bad(`moodMenu: "${id}" is neither a mood of config.json nor a row of order with place "menu"`);
    else if (isObject(labels) && !isText(labels[id])) bad(`menuLabels: "${id}" is in moodMenu and is not a mood, so it needs a label`);
  }
  if (isObject(labels)) for (const id of Object.keys(labels)) if (!(menu || []).includes(id) || moodIds.includes(id)) bad(`menuLabels: "${id}" is not a non-mood entry of moodMenu`);
  if (menu) for (const id of order || []) if (isMenu(id) && !menu.includes(id)) bad(`place: "${id}" is a menu row and is not in moodMenu, so nothing would serve it`);

  if (board.shuffle !== undefined) shuffleProblems(board.shuffle, inOrder, bad);

  if (board.countries !== undefined) {
    const c = board.countries;
    if (!Array.isArray(c) || !c.length || c.some((x) => !isText(x))) bad("countries must be a non-empty list of country names");
    else if (c.some((x, i) => c.indexOf(x) !== i)) bad("countries lists a country twice");
  }
  return out;
}

/**
 * cfg → null (no board), or what the build needs, after validating it. Throws one error naming every problem.
 *   entries   [{ id, name, place: "board" | "menu", series?: true }] in the Board's order: the shape of an index `board` entry
 *   menu      [{ id, label?, mood }]  the Moods menu, in order; label is filled by menuFor() from the moods' words
 *   legacyMoods, countries (null when the config freezes none)
 *   moods     the recipes of board.moods ([] without any)      rows   { id → recipe } of board.rows ({} without any)
 *   shuffle   null without board.shuffle (the rows keep their strict order), else the knobs with the defaults of lib/front-shuffle.js filled in
 */
function parse(cfg, source = "config.json board") {
  const p = problems(cfg, source);
  if (p.length) throw new Error(p.join("; "));
  const b = cfg.board;
  if (b === undefined) return null;
  const defs = b.moods || [];
  const moodIds = new Set([...cfg.moods.map((m) => m.id), ...defs.map((m) => m.id)]);
  return {
    entries: b.order.map((id) => ({ id, name: b.names[id], place: b.place && b.place[id] === "menu" ? "menu" : "board", ...(SERIES_ROWS.includes(id) ? { series: true } : {}) })),
    menu: b.moodMenu.map((id) => ({ id, mood: moodIds.has(id), ...(moodIds.has(id) ? {} : { label: b.menuLabels[id] }) })),
    legacyMoods: [...b.legacyMoods],
    countries: b.countries ? [...b.countries] : null,
    moods: defs.map((m) => JSON.parse(JSON.stringify(m))), // the recipes of the moods the v2 family alone has (not in cfg.moods)
    rows: Object.fromEntries((b.rows || []).map((r) => [r.id, JSON.parse(JSON.stringify(r))])), // id → recipe of a filter or combine row
    shuffle: b.shuffle === undefined ? null : { ...FS.DEFAULTS, ...JSON.parse(JSON.stringify(b.shuffle)) }, // the front shuffle of the v2 Board; the legacy family never reads it (legacyConfig drops the whole board)
  };
}

/**
 * The Moods menu of the v2 index. moods: the compiled moods of the build. → { moods: the compiled moods that are menu options, in menu order,
 * menu: [{ id, label }] every option in order }. A mood's label is its `word`; labels are made safe and unique the way Discover's are (lib/plan.js).
 * The `name` of a mood that has a row in this Board is the row's name (Marco, 21/10/2026 ~22:15 UTC): it is the name the Worker writes after "Mood:" in the Moods menu, and the description's best-fit label (lib/best-mood.js `rowNames`) and
 * the mood's own row say the same one. The menu itself shows the WORD ("Escape"), never the name. The mood's own name is kept as `alias` (only when it differs), because a person may still type "full escape": the search matches both.
 */
function menuFor(board, moods) {
  const byId = new Map(moods.map((m) => [m.id, m]));
  const rowName = new Map((board.entries || []).map((e) => [e.id, e.name]));
  const options = uniqueOptions(board.menu.map((o) => ({ id: o.id, label: o.mood ? byId.get(o.id).word : o.label })));
  const named = (m) => (rowName.has(m.id) && rowName.get(m.id) !== m.name ? { ...m, name: rowName.get(m.id), alias: m.name } : m); // `alias`: the mood's own name, which the Worker's search still matches (worker/src/search.js)
  return { moods: board.menu.filter((o) => o.mood).map((o) => named(byId.get(o.id))), menu: options.map(({ id, label }) => ({ id, label })) };
}

module.exports = { parse, problems, menuFor, knownRows, legacyConfig, SERIES_ROWS, ID };
