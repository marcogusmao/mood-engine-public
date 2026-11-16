// The catalog plan: what goes on the Board, what goes in Discover, in which order, under which name.
// build.js assembles the plan, runs the "seen film" guard over EVERY list in it, and only then hands it to
// publish.js. One structure, so the guard and the files cannot disagree about what is published.
//
//   board:    [{ id, name, items }]                                    → catalog/movie/<id>.json
//   discover: [{ id, name, options: [{ label, items }] }]              → catalog/movie/<id>/genre=<label>.json
//   board2:   [{ id, name, place, series?, items }]  (only with config.json "board", lib/board.js) → the v2 index family, never a static file
//
// board2 sits NEXT TO board (Marco, 13/10/2026: the 3.1.0 Worker and the five profiles keep reading the legacy family, byte for byte). Every step that
// walks "the Board rows" (the seen-film guard, the quality floor, exclude.films, the covers) walks boardRows(plan), both lists; the static addon and
// the legacy index walk plan.board alone.
//
// The Board declares every row it has ever had, empty or not: Stremio reads the row names when the addon is
// installed, so a row left out of the manifest on a quiet night would stay gone until the next reinstall.

const { RUNTIME_BUCKETS, RATING_BUCKETS, decadeLabels } = require("./pool");

/** Board order (Marco, 10/10/2026). The moods (nine since 11/10/2026, `slow` after `wander`) go between "Because you loved…" and "New for you". */
const BOARD_BEFORE_MOODS = ["tonight", "watchlist", "fromlists", "friends-love", "friends-week", "short", "because"];
const BOARD_AFTER_MOODS = ["newforyou", "directors", "directors-loved", "oldfriends"]; // directors-loved: Marco, 11/10/2026
const BOARD_NAMES = {
  tonight: "🎯 Tonight",
  watchlist: "📋 Your watchlist, best first",
  fromlists: "🎞️ From your lists",
  "friends-love": "👥 Friends loved, you haven't seen",
  "friends-week": "👥 Friends watched this week",
  short: "⏱️ Short and good",
  because: "💛 Because you loved…",
  newforyou: "🆕 New for you",
  directors: "🎬 Directors you trust",
  "directors-loved": "🎥 Loved by your directors",
  oldfriends: "📼 Old friends",
};

/**
 * The Board rows whose line 2 opens with the reason (lib/describe.js reasonLead), and how that reason is read: id → kind. Marco, 20/10/2026 (20:40 UTC): the first two; 21/10/2026 (~15:00 UTC): the other seven.
 * The ids are those of the legacy Board ("friends-love", "directors-loved", "friends-week") and of the v2 Board (the special rows of lib/special-rows.js).
 */
const REASON_ROWS = Object.freeze({
  "directors-loved": "loved", "friends-love": "loved",
  "top-picks": "pick", "friends-split": "pair", "friends-watchlist": "want", "friends-month": "watched", "friends-week": "watched", awards: "prize", "actor-week": "actor",
});

/** The Discover catalogs, in order. Each has ONE extra, `genre`, required (so it stays off the Board). */
const DISCOVER = {
  moods: { id: "mood-engine", name: "Mood Engine · Moods" }, // id unchanged: the files already published keep their address
  lists: { id: "mood-engine-lists", name: "Mood Engine · Lists" },
  listsUnseen: { id: "mood-engine-lists-unseen", name: "Mood Engine · Lists (unseen)" },
  decade: { id: "mood-engine-decade", name: "Mood Engine · By decade" },
  runtime: { id: "mood-engine-runtime", name: "Mood Engine · By runtime" },
  country: { id: "mood-engine-country", name: "Mood Engine · By country" },
  rating: { id: "mood-engine-rating", name: "Mood Engine · By rating" },
  friends: { id: "mood-engine-friends", name: "Mood Engine · Friends" },
  directorsLoved: { id: "mood-engine-directors-loved", name: "Mood Engine · Loved by directors" }, // one option per favourite director (lib/directors-loved.js)
};

/**
 * Catalogs that may hold films you have seen, by id. "Old friends" is a rewatch row by definition; "Lists" is the
 * curators' lists whole, in their order, seen or not. "Lists (unseen)" is NOT here, and neither is anything else.
 */
const GUARD_EXEMPT = ["oldfriends", "mood-engine-lists"];

/** A label is a file name: no path separators, no query characters, no percent sign. */
const safeLabel = (s) => String(s).replace(/[\/\\?#%]/g, "-").replace(/\s+/g, " ").trim();

/** Options with a safe, unique label each. Unique within the catalog: "Top · Ana" twice becomes "Top · Ana 2". */
function uniqueOptions(options) {
  const used = new Set();
  return options.map((o) => {
    let label = safeLabel(o.label), n = 2;
    while (used.has(label)) label = `${safeLabel(o.label)} ${n++}`;
    used.add(label);
    return { ...o, label };
  });
}

/**
 * moods: compiled moods (id, name, word)           rows: { tonight, because, <mood ids>, directors, oldfriends, watchlist }
 * extra: { fromlists, short, newforyou, "friends-week"?, "friends-love"? }   (a friends row is left out when absent)
 * friendOut: lib/rows.js buildFriendRows() output  lists: lib/pool.js listCatalogs()
 * cuts: lib/pool.js cuts(), or null (no sources: no cross cuts)     today: YYYY-MM-DD, the last decade of "By decade"
 * sizes: cfg.sizes   rowNames: { "friends-love": "…" } overrides BOARD_NAMES   withFriends: false drops the two friends rows
 * directorMenu: [{ label, items }] lib/directors-loved.js menu(), one option per favourite director (the row itself is extra["directors-loved"])
 * board: lib/board.js parse(), or null. With it the plan also carries `board2`: the rows of config.json "board", in its order, under its names, each a
 *        copy of the list the legacy Board holds under that id (friends-love is cut the same way). A series row (my-series) has no items: the Worker builds it.
 * allMoodIds: the ids of EVERY mood of config.json and of the board (build.js: `allMoods`), not only the legacy ones `moods` holds: they decide which v2 rows are mood rows (21/10/2026, the review of the description v3: 11 rows of the v2 Board that are moods of
 *        config.json but not of board.legacyMoods lost their "Mood:" because only the legacy ids were counted)
 * menuRows: { mood id → items } (lib/rows.js buildRows() `menu`; Marco, 22/10/2026 ~15:15 UTC, the mood named Music is exempt from the music rule): the list that mood's option of the Moods menu (Discover) shows instead of the
 *        Board's row of the same id. Only the Discover option reads it: the Board row, Tonight and every other surface keep `rows`. Empty (the default): every option shows its row.
 * rows2: { row id → items } the v2 Board's own rows (lib/board-rows.js): they win over the legacy list of the same id ("wicked" of the v2 Board mixes three moods, the legacy "wicked" does not change).
 */
function buildPlan({ moods, rows, extra, friendOut = { rows: {}, meta: [] }, lists = [], cuts = null, today = "2029-01-01", sizes, rowNames = {}, withFriends = true, directorMenu = [], board: boardSpec = null, rows2 = {}, allMoodIds = [], menuRows = {} }) {
  const all = { ...rows, ...extra, ...(withFriends ? friendOut.rows : {}) };
  // the moods outside board.legacyMoods exist only in the v2 family (lib/board.js): the legacy Board and the static Moods menu never list them
  const legacyMoods = boardSpec ? moods.filter((m) => boardSpec.legacyMoods.includes(m.id)) : moods;
  const board = [];
  // Marco, 13/10/2026 (changed 20/10/2026: line 2 said "Mood: <name>" only where the row is a mood; changed again 21/10/2026, D3: in a row that is no mood and has no reason it opens with "Mood: <the mood the film fits best>" from `item.fitMood`, lib/best-mood.js; the row's name stays in `mood` for the learning files): the `mood` of an item is the name of the row it is in. A mood row's items already carry the mood's name and Tonight's
  // "Tonight · <mood>" (lib/rows.js); every other row's items get the row's name here, on a copy (an item can be in several rows).
  // Marco, 20/10/2026 (20:40 UTC): in "Loved by your directors" and "Friends loved" the description's line 2 starts with the reason instead of "Mood:" (lib/describe.js reasonLead): items get `leadsWithReason`.
  // Marco, 21/10/2026 (~15:00 UTC, questionnaire, D1): the reason opens line 2 in the other rows whose meaning is a person, a prize or an actor too: Friend's top picks (the friend of the day), Friends can't agree (the two
  // extremes and their stars), Friends want to see this too (who wants it), Friends watched this month and this week (who watched, with the stars when there are any), the prize row (festival and year) and Actor of the week
  // (the actor). The value says which reading lib/describe.js reasonLead gives the item's first reason (`why[0]`): "loved", "pick", "pair", "want", "watched", "prize", "actor". A row is added by adding its id here.
  // Risk he accepted: a longer line 2 in these rows. In them the mood of best fit does NOT follow the reason (the session's choice, to keep the line from overflowing): lib/describe.js moodLine.
  const leads = (id) => (it) => (Object.hasOwn(REASON_ROWS, id) ? { ...it, leadsWithReason: REASON_ROWS[id] } : it);
  const push = (id, name) => {
    const rowName = name || rowNames[id] || BOARD_NAMES[id];
    const items = (all[id] || []).slice(0, id === "friends-love" ? sizes.friends ?? sizes.row : undefined).map((it) => (it.mood ? it : { ...it, mood: rowName, moodIsRow: true })).map(leads(id));
    board.push({ id, name: rowName, items });
  };
  for (const id of BOARD_BEFORE_MOODS) if (withFriends || !id.startsWith("friends-")) push(id);
  for (const m of legacyMoods) push(m.id, m.name);
  for (const id of BOARD_AFTER_MOODS) push(id);

  // The v2 rows carry THEIR name too (config.json board.names: "Warm and gentle"), a mood row included — its items carry the mood's name from lib/rows.js,
  // which is the legacy Board's; Tonight keeps "Tonight · <mood>" (the mood a Tonight pick was drawn for is the one lib/rows.js knows).
  // rows2 (lib/board-rows.js): the v2 Board's own row wins over the legacy list of the same id.
  // Marco, 20/10/2026: the description's second line says "Mood: <the ROW's name>" only in a row that IS a mood (since 21/10/2026, D3, a row that is no mood says "Mood: <the mood the film fits best>" instead, `item.fitMood`): ANY mood of config.json (the 30, `allMoodIds`, not only the nine of the legacy Board `moods` holds), a mood only board.moods defines, or a combined row with a mood among its parts ("Night, crime and mystery"; "Latin America" combines filters and is no mood).
  // Every other row (Friends loved, a decade, a country…) still puts its name in `mood` (the learning files and the tests read it) and marks it `moodIsRow`: lib/describe.js does not write the ROW's name as a mood there (it writes the film's best fit, `fitMood`, when the film has one; 21/10/2026, D3).
  const moodIds = new Set([...moods.map((m) => m.id), ...allMoodIds, ...(boardSpec ? [...boardSpec.legacyMoods, ...(boardSpec.moods || []).map((m) => m.id)] : [])]);
  const isMoodRow = (e) => moodIds.has(e.id) || (boardSpec.rows && boardSpec.rows[e.id] && boardSpec.rows[e.id].kind === "combine" && (boardSpec.rows[e.id].parts || []).some((id) => moodIds.has(id)));
  // Marco, 21/10/2026 ~22:15 UTC: the mood a v2 Tonight pick was drawn for is written with the name of the mood's row in this Board when it has one ("Tonight · 🎳 Full escape" -> "Tonight · 🎳 Fun and adventure"), the way the best-fit label is (lib/best-mood.js); lib/rows.js
  // wrote the mood's `name`, which is the legacy Board's name for the row. The item is copied: the legacy Tonight keeps its text.
  const rowNameOf = boardSpec ? new Map(boardSpec.entries.map((e) => [e.id, e.name])) : new Map();
  const drawnMood = (it) => {
    const m = moods.find((x) => it.mood === `Tonight · ${x.name}`);
    return m && rowNameOf.has(m.id) && rowNameOf.get(m.id) !== m.name ? { ...it, mood: `Tonight · ${rowNameOf.get(m.id)}` } : it;
  };
  const board2 = boardSpec && boardSpec.entries.map((e) => ({ ...e, items: e.series ? [] : (rows2[e.id] || all[e.id] || []).slice(0, e.id === "friends-love" ? sizes.friends ?? sizes.row : undefined).map((it) => (e.id === "tonight" && it.mood ? drawnMood(it) : { ...it, mood: e.name, ...(isMoodRow(e) ? {} : { moodIsRow: true }) })).map(leads(e.id)) }));

  const discover = [];
  const add = (spec, options) => { if (options.length) discover.push({ ...spec, options: uniqueOptions(options) }); };
  add(DISCOVER.moods, legacyMoods.map((m) => ({ label: m.word, items: menuRows[m.id] || all[m.id] || [] })));
  // The menu entry of a list is its `short` (Marco, 22/10/2026 ~04:05 UTC: one line on the phone), the full name when the config gives none. (Until the rebase of 22/10/2026 this comment added that the cards keep the full name and the author in their description. Not true since description v3, PR #67: no card prints its list's name; the full name is only in config.json `name` and in the index's `label`. Marco accepted it, 22/10/2026 ~19:10 UTC: "Aceitar: só o nome curto no Stremio".)
  add(DISCOVER.lists, lists.map((l) => ({ label: l.short ?? l.name, items: l.all })));
  add(DISCOVER.listsUnseen, lists.map((l) => ({ label: l.short ?? l.name, items: l.unseen })));
  const stat = (found, labels) => labels.map((label) => ({ label, items: (found.find((c) => c.label === label) || { items: [] }).items }));
  if (cuts) {
    add(DISCOVER.decade, stat(cuts.decade, decadeLabels(today)));
    add(DISCOVER.runtime, stat(cuts.runtime, RUNTIME_BUCKETS.map(([l]) => l)));
    add(DISCOVER.country, cuts.country.map((c) => ({ label: c.label, items: c.items })));
    add(DISCOVER.rating, stat(cuts.rating, RATING_BUCKETS.map(([l]) => l)));
  }
  if (withFriends) add(DISCOVER.friends, friendOut.meta.filter((m) => m.kind !== "love").map((m) => ({ label: m.word, items: friendOut.rows[m.id] || [] })));
  add(DISCOVER.directorsLoved, directorMenu.map((o) => ({ ...o, items: o.items.map((it) => ({ ...it, leadsWithReason: REASON_ROWS["directors-loved"] })) })));
  return board2 ? { board, board2, discover } : { board, discover };
}

/** Every Board row of the plan, legacy first and then the v2 Board: what the guard, the quality floor, exclude.films and the covers walk. */
const boardRows = (plan) => (plan.board2 ? [...plan.board, ...plan.board2] : plan.board);

/** The flat view the guard reads: "<row id>" for the Board, "<row id>/v2" for the v2 Board, "<catalog id>/genre=<label>" for every Discover option. */
function guardRows(plan) {
  const out = {};
  for (const r of plan.board) out[r.id] = r.items;
  for (const r of plan.board2 || []) out[`${r.id}/v2`] = r.items; // a v2 row is guarded under its own key ("tonight" exists in both Boards); catalogOf() reads the part before the slash, so v2 "oldfriends" stays exempt like the legacy one
  for (const c of plan.discover) for (const o of c.options) out[`${c.id}/genre=${o.label}`] = o.items;
  return out;
}

/** The Discover menus of a plan: { catalog id → option labels }. */
const menusOf = (plan) => Object.fromEntries(plan.discover.map((c) => [c.id, c.options.map((o) => o.label)]));

/**
 * What changed in the menus since the build that was recorded: [{ id, added, dropped }]. Stremio reads the options when the
 * addon is installed, so a menu that changes (a country entering the top 12) shows up only after a reinstall, and an
 * installed menu that lost an entry asks for a file that is no longer there. The build says so in its log.
 */
function menuChanges(prev, now) {
  const out = [];
  for (const [id, labels] of Object.entries(now)) {
    const was = prev && prev[id];
    if (!was) continue;
    const added = labels.filter((l) => !was.includes(l)), dropped = was.filter((l) => !labels.includes(l));
    if (added.length || dropped.length) out.push({ id, added, dropped });
  }
  for (const id of Object.keys(prev || {})) if (!(id in now)) out.push({ id, added: [], dropped: prev[id] });
  return out;
}

module.exports = { buildPlan, guardRows, boardRows, menusOf, menuChanges, safeLabel, uniqueOptions, BOARD_BEFORE_MOODS, BOARD_AFTER_MOODS, BOARD_NAMES, DISCOVER, GUARD_EXEMPT, REASON_ROWS };
