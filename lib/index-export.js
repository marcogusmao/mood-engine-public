// The index the live Worker reads: docs/data/index.json, written in the publication staging transaction.
//
// The static addon answers one question per file. The Worker answers any combination (mood × decade × runtime × country ×
// rating) and a text search, so it needs the FACTS behind the rows, not just the rows. This module turns what the build
// already decided into one compact file: one entry per film, plus the compositions the build approved (the Board rows, the
// friends' options, the curators' order of each list). The Worker only re-orders and filters it; it never invents a film.
//
// buildIndex() returns the object form described here; writeIndex() writes it as arrays (lib/index-rows.js), which parse twice as fast.
// An entry is only as rich as what the build knows. A key that is absent means "not known" (null/false/empty), never a
// guess: no runtime key, no runtime filter match. Keys, all optional except tt and name:
//   tt name year decade runtime countries language lbRating tmdbRating tmdbVotes imdbRating seenBy wantBy friendsAvg taste quality rank
//   poster desc genres director keywords moods lists friends watchlist seen find
// `year` is Letterboxd's, else the TMDB record's of the film itself (lib/pool.js yearOf; Marco, 13/10/2026), the same function the cover reads; `decade` follows it.
// A TMDB record whose `imdb` is not the film's is not the film's own: it lends no year, title, runtime, country, language, genre or synopsis (nor does a plan item built from one).
// `imdbRating`, `seenBy`, `wantBy`, `friendsAvg` and `poster` are the v2.1 numbers: IMDb's rating, how many of the 51 people you follow saw the
// film / want to see it, the average of their stars, and the cover with the ratings drawn on it (every ready cover of the full index may have one;
// missing raw or failed rendering keeps the prior poster reference). `friends` is the other thing: the 7 configured friends of config.json, by name (4 until 28/10/2026).
// `desc` is the description WITHOUT its first line (lib/describe.js liveDescription(), description v3, Marco 20/10/2026): "<the first three actors>\n<line 2>", then meta.separator
// and the synopsis, where line 2 is "[Mood: <the mood the film fits best> · ]<up to three genres, without the one that is that mood's name, singular or plural: Marco 21/10/2026 ~19:40 UTC, A> · <up to four mood words, with an initial capital>." (a film's general text has no row, so its lead is the best fit, `bestMood`, Marco 21/10/2026 D3/D5; the words are `descWords`, cleaned of a word inside another, and are not the `keywords` column, which is the family's own list for the search; the Worker shows three).  The Worker builds line 1
// ("Akira Kurosawa · 2h22 · Toshirō Mifune, Tatsuya Nakadai, Kyōko Kagawa.") from the columns above (director, runtime) and the actors of `desc`, with creditsLine() (the third actor goes past 80 characters; two stay);
// in the Moods menu it puts the mood's name (the name of its Board row in the v2 family when it has one: "Mood: <that name> · ") in the best fit's place at the start of line 2. A Board row's text (`rowDesc`) has its own line 2, finished ("Mood: <the row's mood>" when the row is a mood, the reason in a reason row, the best fit in the others).
// There is no reasons line and no numbers line. `countries` has the film's main country first (lib/countries.js mainCountry through lib/pool.js mainFirst: the director's country, else TMDB's origin_country when it names one, else the producer that speaks its language; since 22/10/2026 the same country the Board's regions read, and since 23/10/2026 the one whose flag the cover draws).
// `find` is the text a search looks in, already normalised (see words()). The films are written best rank first, so the Worker
// can stop reading as soon as it has a page.
//
// The whole file costs ~6 ms of CPU to parse on a cold start, and the free Cloudflare plan allows a request 10 ms. So the same
// data is also written in pieces, each in the same format and each with the menus: index-board.json (the Board's films: one
// request per row every time Stremio opens), index-moods.json (every film that fits a mood), index-friends.json (every film in a friends
// option), index-directors.json (every film of the "Loved by directors" menu) and index-list-<id>.json (every film of one list, seen or not). The Worker reads the piece a request needs and falls back
// to the whole file when a piece is missing. verify.js checks that each piece holds EXACTLY the films it should.
//
// One more file sits next to them, data/film-languages.json (Marco, 12/10/2026): the original language of each film, as two strings of ids,
// so the Worker's /subtitles can decide "English only, or Portuguese first" without parsing the index (40 to 50 ms of CPU on a fresh isolate
// against the 10 ms the free plan gives a request). See languagesFile() below.
//
// The v2 family (Marco, 13/10/2026; only with config.json "board", lib/board.js): the same function builds a SECOND index, `v2`, from plan.board2: the
// Board of config.json under its own order and names (entries `{ id, name, place: "board" | "menu", series? }`), the Moods menu as the config
// has it (`moodMenu`: [{ id, label }]) and the frozen country menu (`meta.countriesAll`). It is written next to the legacy files, never instead of
// them (the 3.1.0 Worker reads those): index-v2.json (whole), index-v2-menus.json (menus, board and moodMenu, no films), index-v2-row-<id>.json (one row: at most
// V2_ROW_MAX films and its rowDesc) and index-v2-mood-<id>.json (every film that fits the mood). A row of the v2 Board with place "menu" has its file too:
// the Moods menu serves it. verify.js checks that each slice holds EXACTLY its films.
// The friends' view (Marco, 29/10/2026): next to the rows, one file per configured friend, index-v2-row-watchlist-<friend>.json (lib/friend-view.js), the watchlist row as that friend has it; and in every file of both families the two
// columns seenMask and wantMask (lib/index-rows.js), which tell the Worker's /u/<friend>/ routes what that friend has seen. Marco's own index only: an index built for a person (meta.personId) has neither.
//
// `discover` (v2 only, 22/10/2026; lib/discover-catalogs.js): the Discover catalogs the build groups and calculates (Countries & regions, Decades & eras, and the lists by subject):
// { order, retire, seen, explore?, catalogs: [{ id, name, options: [{ id, label, ids } | { id, label, ids, shorts: true } | { id, label, ids, curated: true } | { id, label, ids, curated: true, director } | { id, label, list }] }] }. `shorts: true` (15/11/2026): an era, whose file names the shorts in its ids, or the Silent era (Marco: "Keep shorts in the Silent era only (recommended)"): the recommendation and music rules hold, the short bit is not asked; lib/index-validation.js accepts the key on those options alone, by id. A calculated option carries its films' ids in the whole index and `ids: []` in every
// other file (the menus, the slices of rows and moods), as the directors' menu does, except its own piece index-v2-opt-<catalog>-<option>.json (optionPieces, 29/10/2026: the first ids, the films of the first three pages and the totals); a list option points at the list and its own piece holds the films.
// Marco, 28/10/2026 (proposal 5): `curated: true` marks an editorial collection (a union of lists, the card of a director): its ids are not filtered by the recommendation rule, the Worker serves them with no rule, and the validation lets a
// film that is not `eligible` sit in it; `director` (curated only) is the label of the option of `directors.options` the card grew from, so the Worker can read the "Loved by" texts there; `explore: { genre: <catalog id> }` makes that catalog's options
// the Genre filter of Explore. The grammar of the file and the five kinds of option are in lib/discover-catalogs.js; keywordTerms() below is the list of words that file may name.
// What is NOT in it: your ratings, your diary, your e-mail, your Letterboxd user name, a friend's full history. `taste` and
// `quality` are z-scores over the pool, `seen` and `watchlist` are booleans, `friends` carries only the configured friends'
// public ratings. verify.js (verifyIndex) checks that nothing else is there.
//
// Pure function (buildIndex) + one writer (writeIndex). test/index-export.test.js feeds buildIndex small fakes.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const P = require("./pool");
const D = require("./describe");
const { DISCOVER, uniqueOptions } = require("./plan");
const { compile } = require("./moods");
const { encode } = require("./index-rows");
const { languageCode } = require("./countries");
const { V2_ROW_MAX, ROW_ID_SOURCE, legacyConfig } = require("./board-shared");
const FV = require("./friend-view");

const SCHEMA = 1;
const FILE = path.join("data", "index.json");
const BOARD_FILE = path.join("data", "index-board.json");
const MOODS_FILE = path.join("data", "index-moods.json");
const FRIENDS_FILE = path.join("data", "index-friends.json");
const DIRECTORS_FILE = path.join("data", "index-directors.json");
const LANGUAGES_FILE = path.join("data", "film-languages.json");
const LANGUAGES_VERSION = 1;
const listFile = (id) => path.join("data", `index-list-${id}.json`);
const V2_NAME = "index-v2"; // how a problem in the v2 whole index is labelled
const V2_FILE = path.join("data", "index-v2.json");
const V2_MENUS_FILE = path.join("data", "index-v2-menus.json");
const v2RowFile = (id) => path.join("data", `index-v2-row-${id}.json`);
const v2MoodFile = (id) => path.join("data", `index-v2-mood-${id}.json`);
const v2OptFile = (catalogId, optionId) => path.join("data", `index-v2-opt-${encodeURIComponent(catalogId)}-${encodeURIComponent(optionId)}.json`); // the same encodeURIComponent as the Worker's urls.opt and the Board's row pieces
const OPT_FILMS = 300; // the first three pages of an option (the Worker's PAGE is 100): the part of a calculated option of the Discover that its own piece holds
// The complete Animation piece measured 358,264 UTF-8 bytes on 30/10/2026. Bound its expansion;
// growth beyond this limit keeps the original prefix and whole-index fallback. This is a file limit, not a CPU guarantee.
const ANIMATION_PIECE_MAX_BYTES = 384 * 1024;
const MAX_KEYWORDS = 8;
const MAX_COUNTRIES = 2;
const DESC_MAX = 800; // cast (about 70) + line 2 (about 130) + the separator + the synopsis (280)
/**
 * tt → the year the index carries, for the entries that have one. Marco, 13/10/2026: a film shows ONE year in every surface of a build: the index's
 * (P.yearOf), which is also the cover's. The plan's items (the static addon's releaseInfo) and the picker's rows were each given their year by the code that
 * made them, TMDB first, and without this step 466 films would have shown a different year in the static addon than in the Worker (53 of them two years inside the static addon). `showYear` is the one lookup they all use.
 */
const yearsByTt = (index) => new Map(index.films.filter((e) => e.year).map((e) => [e.tt, e.year]));
const showYear = (years, tt, own) => years.get(tt) || own;

/**
 * The facts a description's first line shows, from the index's entries: tt → { directors, runtime, country }. A plan item built from the TMDB record of ANOTHER film carries that
 * film's director and runtime (the index takes none of them: see buildIndex); build.js gives the items these, as it gives them the year, so that the static files and the live
 * addon, which builds the line from the entries, read the same line 1 (Marco, 13/10/2026; 7 films of the lists were wrong in the static files, "Eight Deadly Shots" 5h20 for 2h25).
 */
function factsByTt(index) {
  return new Map(index.films.map((e) => [e.tt, { directors: e.director ? e.director.split(", ") : null, runtime: e.runtime || null,  country: e.country || (e.countries && e.countries[0]) || null }]));
}

/** The keys an entry may have. verifyIndex refuses any other, so a personal field cannot slip in by accident. */
const ENTRY_KEYS = ["tt", "name", "year", "decade", "runtime", "countries", "language", "lbRating", "tmdbRating", "tmdbVotes", "imdbRating", "seenBy", "wantBy", "friendsAvg", "taste", "quality", "rank", "poster", "desc", "genres", "director", "keywords", "moods", "lists", "friends", "watchlist", "seen", "eligible", "musicOut", "shortOut", "find", "country"];

const r1 = (n) => (typeof n === "number" && Number.isFinite(n) ? Number(n.toFixed(1)) : null); // the way it will be shown (toFixed): Math.round would round 4.05 up where toFixed shows 4.0
const r2 = (n) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
/** The one normaliser for search text: accents off, lower case, apostrophes dropped ("Killer's" = "killers"), "&" as "and", anything else that is not a letter or digit as a space. worker/src/text.js has the same function (a test compares them). */
const words = (s) => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/['\u2019\u2018`\u00b4]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const isUrl = (u) => /^https?:\/\/\S+$/i.test(String(u || ""));
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…");

/** The terms of config.json's moods that pull a film IN (weight > 0): the words a search may use. Negative terms are warnings, not search words. */
function allowlist(mood) {
  const terms = new Map();
  for (const m of compile(mood))
    for (const t of m._terms) if (t.w > 0 && (!terms.has(t.term) || terms.get(t.term).w < t.w)) terms.set(t.term, t);
  return [...terms.values()].sort((a, b) => b.w - a.w || a.term.localeCompare(b.term));
}

/**
 * The terms the `keywords` column of the index can hold: the positive terms of `moods` (config.json moods, plus the v2 Board's), as allowlist() lists them. lib/discover-catalogs.js parse() takes
 * its `keywordTerms` from here (Marco, 28/10/2026, proposal 5): an option of the Discover that asks for a word the column can never hold would be an empty option for good.
 */
const keywordTerms = (moods) => allowlist(moods).map((t) => t.term);

/**
 * cfg        config.json                       today   YYYY-MM-DD            builtAt  ISO string
 * plan       lib/plan.js buildPlan()           moods   compiled moods        ranked   build.js: mood id → [{ film, fitInfo, rank }]
 * cands      build.js: the TMDB candidates ({ film, tasteZ, qualityZ, watchlist })
 * recs       lib/pool.js rankPool(): the pool, with tasteZ, qualityZ, rank, tags, detail
 * view       lib/friends.js viewFriends()      lists   lib/lists.js refreshLists().lists
 * friendsFull  buildFriendRows() with the Discover cap lifted: every film of every friends option, in the build's order
 * isSeen(rec)  the build's "seen" test for a Letterboxd record { slug, ...record }      detail(rec) → TMDB record or null
 * detailOfImdb(tt) → the TMDB record that /find found for an IMDb id, or null (read last, and only when it carries that IMDb id)
 * seenTts    Set of IMDb ids of everything you have seen (a second net: such a film is flagged seen whatever else says)
 * crowd      lib/crowd.js find(item) → { seenBy, friendsAvg, wantBy }, or null when the crowd was not read     imdb: Map(tt → IMDb rating)
 * numbers    lib/crowd.js attachRatings().byTt: tt → the { lb, imdb, friendsAvg, seenBy, wantBy } object the plan's items share; the films of the
 *            legacy plan only (14/10/2026): a film that only a v2 Board row holds is not in it, so the legacy index does not learn its numbers
 * quality    { eligible(tt) → bool, minStars }  the build's recommendation rule (lib/recommendation-quality.js qualifies()), on the film's IMDb
 *            identity: the unrounded Letterboxd average ≥ 3.5, OR a configured friend's own rating ≥ 3.5; a vouched film (a critic or
 *            director list, a fan list's critics' subset, a favourite director's love) needs a Letterboxd average ≥ 2.5, and passes
 *            with no average at all. Exported per film as `eligible`; the Worker uses the flag and never recomputes the rule. null (tests):
 *            every film is eligible and no `rules` are written.
 * musicOut  musicOut(tt) → bool, the music rule (lib/pool.js musicGate; Marco, 22/10/2026 ~06:40 UTC): true for a music film he has not seen and has no evidence for. Exported per film as `musicOut` (bit 8 of the
 *            file's `flags`, lib/index-rows.js), true or absent; the film STAYS `eligible` (Search and the collections still find it). The Worker serves what RECOMMENDS (Moods, Explore, the menus on them, the profiles'
 *            Tonight, Under 100 min and themes) from `recommendable` = eligible and not musicOut; an index without the bit behaves as before. Default: nothing is held back.
 * (shortOut)  not a parameter: every film's `shortOut` (bit 16 of the flags; Marco, 15/11/2026, questionnaire: shorts stay "Only where you or a source put them") is lib/pool.js isShort() of the film's
 *            own `runtime` in this index under config.json shortRow.minMinutes, the number meta.minFeatureMinutes carries: a KNOWN runtime under 40. A film with no runtime is no short. The Worker reads it
 *            with the music bit in `recommendable` (Moods, Explore, the calculated options of the Discover, the profiles' Tonight, Under 100 min and themes); Search and the collections keep the shorts.
 *            Seen or not, eligible or not: it is a fact about the film, so a seen short stays out of a calculated option asked with "Include seen" too.
 * musicExemptMoods  [mood ids] (config.json music.exemptMoods, lib/pool.js musicOptions; Marco, 22/10/2026 ~15:15 UTC, "Music 1 of 4"): the moods whose own option of the Moods menu the Worker serves from `eligible` instead of `recommendable`, so a
 *            music film with no evidence (`musicOut`) is in it. Written as `rules.musicExemptMoods`, only the ids this index lists as moods (a rehearsal board's menu may not list the mood; asking for an option it does not have is impossible), and only when the list is then not empty, so an index built without the exemption is byte for byte the index of before. Default: none.
 * permits    permits(tt, moodId) → bool, the private feedback of this build (lib/learning/feedback.js eligible()): a film the person marked
 *            "not tonight" / "not for me" is not eligible, one marked "wrong mood" for a mood does not fit that mood. Nothing of the
 *            feedback itself is written: to the index it looks like a film that does not pass the rule, or does not fit the mood.
 * bestMood  Map(tt → the NAME of the mood the film fits best), lib/best-mood.js: the lead of line 2 of a film's general text and of a Board row that is no mood ("Mood: 🌃 Night drive · …"; Marco, 21/10/2026, D3). build.js gives both
 *            families the SAME ranking, over every mood of config.json, as it does `descMoods` (the `moods` column of the legacy index holds nine moods and would say another one); only the NAME differs, by one rule (Marco, 21/10/2026 ~22:15 UTC): the legacy
 *            family writes the mood's `name`, the v2 family the name of the mood's Board row when it has one (lib/best-mood.js `rowNames`). The `name` of a mood in `moods` below is that same name, so the Moods menu says what the Board's row says. Empty (tests): the line starts with the genres.
 * separator  config.json → descriptionSeparator, between the lines of a description
 * pageFacts  null, or the separate public film-page facts Map, captured only for Marco v2 (24/10/2026); no new index column.
 * records    null, or a Map the call fills with tt → the film's OWN TMDB record (the `d` below, or null) that the entry was made from: lib/discover-catalogs.js works out the regions and eras of the Discover from it (22/10/2026). Nothing is written to a file from it.
 * v2         null, or { menu: [{ id, label }] (the Moods menu, lib/board.js menuFor), countries: the frozen country menu | null }: this call builds the v2 index.
 *            Its `plan` is { board: plan.board2, discover }, its `moods` the menu's moods. Nothing else changes: the same films, the same facts.
 */
function buildIndex({ cfg, today, builtAt = new Date().toISOString(), plan, moods = [], ranked = {}, cands = [], recs = [], view = { users: [], films: {} }, lists = [], friendsFull = { rows: {}, meta: [] }, isSeen = () => false, detail = () => null, detailOfImdb = () => null, descMoods = null, bestMood = new Map(), seenTts = new Set(), crowd = null, imdb = new Map(), numbers = new Map(), quality = null, musicOut = () => false, musicExemptMoods = [], permits = () => true, separator = "\n\n", coverFacts = null, v2 = null, records = null, pageFacts = null }) {
  const minFeature = P.minFeatureMinutes(cfg); // config.json shortRow.minMinutes (40): the one number of a short, written to meta.minFeatureMinutes and read for every film's `shortOut` below
  const terms = allowlist((v2 ? cfg : legacyConfig(cfg)).moods || []); // the legacy family searches only with the words of its own moods
  // The words of the DESCRIPTION come from one list for both families (Marco, 20/10/2026, review finding 1): `descMoods` = every mood of config.json (build.js; Marco, 21/10/2026: 30 moods, 6,630 of the 10,034 TMDB records with keywords have a word against 5,143 with the nine legacy ones; test/legacy-parity.test.js allows the legacy files to differ in the word group of line 2 of the card (one group) and in the best-fit `Mood:` label of a line that is not in a mood row (D3, 21/10/2026), and in nothing else), so the static files
  // (which copy them from here) and the Worker (which reads either index) say the same words; the `keywords` column above stays the family's own, for the search.
  const descTerms = descMoods ? allowlist(descMoods) : terms;
  const descWords = new Map(); // tt → the words of the description, deduplicated, up to D.WORDS_KEPT
  const films = view.films || {};
  const S = new Map(); // tt → everything the build knows about the film, before it is flattened to an entry
  const st = (tt) => S.get(tt) || S.set(tt, { tt, rec: null, cand: null, board: null, discover: null, listItem: null, seen: false, lists: {}, moods: {}, friends: null }).get(tt);

  // Letterboxd's own record of each film (rating, runtime, countries), by IMDb id
  const lbByTt = new Map();
  for (const [slug, r] of Object.entries(films)) {
    if (!r || r.gone || !r.imdbId) continue;
    const prev = lbByTt.get(r.imdbId);
    if (!prev || (prev.r == null && r.r != null)) lbByTt.set(r.imdbId, { slug, ...r });
  }

  // 1 ── the pool (unseen films from the watchlist, the lists and the friends) and the TMDB candidates
  for (const r of recs) st(r.id).rec = r;
  for (const c of cands) if (c.film && c.film.imdb) st(c.film.imdb).cand = c;

  // 2 ── every item the plan publishes: the first Board appearance, else the first Discover one; Old friends is seen by definition
  const rows = {}, boardRows = [], rowDesc = {};
  for (const r of plan.board) {
    boardRows.push(v2 ? { id: r.id, name: r.name, place: r.place, ...(r.series ? { series: true } : {}) } : { id: r.id, name: r.name });
    rows[r.id] = r.items.map((it) => it.id);
    rowDesc[r.id] = []; // filled after the films are known (step 7b): the row's OWN text (its line 2 starts "Mood: <the row's mood>" in a mood row), which a film's general text does not have
    for (const it of r.items) {
      const s = st(it.id);
      s.board ||= it;
      if (r.id === "oldfriends") s.seen = true;
    }
  }
  for (const c of plan.discover) for (const o of c.options) for (const it of o.items) st(it.id).discover ||= it;

  // 3 ── the curated lists, whole: the position each film is shown in (the curator's, or the rating's for `order: "rating"`), and which ones you have seen
  // Marco, 22/10/2026 ~04:05 UTC: the Discover menu of the lists shows each list's `short` (the Worker also answers to `label`, the full name, for the installs made before); the same dedupe as the static plan (lib/plan.js).
  const listMenu = uniqueOptions(lists.map((l) => ({ label: l.short ?? l.name })));
  const lc = P.listCatalogs({ lists, view: { films }, isSeen, detail, size: Infinity });
  for (const l of lc) {
    const unseen = new Set(l.unseen.map((x) => x.id));
    for (const it of l.all) { const s = st(it.id); s.listItem ||= it; if (!unseen.has(it.id)) s.seen = true; }
  }
  // The position written is the one the list is SHOWN in (lib/pool.js listSequence): the curator's for a list with no `order`, the rating's for `order: "rating"`. The Worker sorts a list by it.
  for (const l of lists)
    P.listSequence(l, films).forEach((i, rank) => {
      const r = films[l.items[i].slug];
      if (!r || r.gone || !r.imdbId) return;
      const s = S.get(r.imdbId);
      if (s && !(l.id in s.lists)) s.lists[l.id] = rank + 1;
    });

  // 4 ── the friends: their options as the build ordered them (uncapped), and what each friend rated or saved
  const friendMeta = friendsFull.meta.filter((m) => m.kind !== "love");
  const friendOptions = uniqueOptions(friendMeta.map((m) => ({ label: m.word, id: m.id }))).map((o) => ({ label: o.label, ids: (friendsFull.rows[o.id] || []).map((x) => x.id) }));
  for (const m of friendMeta) for (const it of friendsFull.rows[m.id] || []) st(it.id).discover ||= it;
  const loveMin = cfg.friendRows?.love?.minStars ?? 4;
  const people = view.users.map((u) => u.name);
  const friendBits = new Map(); // tt → { seenBy: Map(name → rating|null), wantBy: Set(name) }
  const bit = (tt) => friendBits.get(tt) || friendBits.set(tt, { seenBy: new Map(), wantBy: new Set() }).get(tt);
  for (const u of view.users) {
    for (const f of u.films.values()) {
      const r = films[f.slug];
      if (!r || r.gone || !r.imdbId) continue;
      if (f.rating != null && f.rating >= loveMin && !S.has(r.imdbId) && !isSeen({ slug: f.slug, ...r })) st(r.imdbId); // a film a friend loved enters the index, unseen
      bit(r.imdbId).seenBy.set(u.name, f.rating ?? null);
    }
    for (const w of u.watchlist.values()) {
      const r = films[w.slug];
      if (r && !r.gone && r.imdbId) bit(r.imdbId).wantBy.add(u.name);
    }
  }
  for (const [tt, b] of friendBits) {
    const s = S.get(tt);
    if (!s) continue; // friends' history is attached to films already in the index, it never adds one
    const rated = [...b.seenBy.values()].filter((v) => v != null);
    s.friends = { seenBy: [...b.seenBy].map(([n, v]) => [n, v]), wantBy: [...b.wantBy] };
    if (rated.length) s.friends.friendsAvg = r2(rated.reduce((a, v) => a + v, 0) / rated.length);
  }

  // 4b ── Loved by your directors (Marco, 11/10/2026): the Discover options as the build made them, each film with its own text
  // ("Loved by Lynch and Scorsese · …", the director on screen first), the way a Board row keeps its own reasons
  const dl = plan.discover.find((c) => c.id === DISCOVER.directorsLoved.id);
  const directors = { options: dl ? dl.options.map((o) => ({ label: o.label, ids: o.items.map((it) => it.id), descs: [] })) : [] }; // `descs` are filled after the films are known (step 7b)

  // 5 ── the moods: every candidate that fits one, with how well and how it ranks there
  for (const m of moods)
    for (const c of ranked[m.id] || []) if (c.film && c.film.imdb && permits(c.film.imdb, m.id)) st(c.film.imdb).moods[m.id] = [r2(c.fitInfo.norm), r2(c.rank)];

  // 6 ── the country menu: the most frequent ones in the pool, like By country
  // (the static menu when the plan has one: the build counts the countries of the pool AFTER its filter, and the two addons should offer the same menu)
  const planCountry = plan.discover.find((c) => c.id === DISCOVER.country.id);
  const byCountry = new Map();
  for (const r of recs) for (const c of P.countriesOf(r)) byCountry.set(c, (byCountry.get(c) || 0) + 1);
  const countryMenu = planCountry ? planCountry.options.map((o) => o.label) : [...byCountry].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, cfg.cuts?.countries ?? 12).map(([c]) => c);
  const inMenu = new Set(v2 && v2.countries ? v2.countries : countryMenu); // the v2 family keeps the countries of its own (frozen) menu

  // 7 ── flatten
  const entries = [];
  for (const s of S.values()) {
    const lb = lbByTt.get(s.tt);
    const item0 = s.board || s.discover || s.listItem || null;
    // A plan item built from a TMDB record of ANOTHER film (its `tmdb` names a record whose `imdb` is not this film's, or none) carries that film's title, year, runtime,
    // genres, directors and synopsis: the index takes none of them (Marco, 13/10/2026: the TMDB record of the index must carry the film's IMDb id).
    const ofItem = item0 && item0.tmdb ? detail({ tmdbId: item0.tmdb }) : null;
    const item = ofItem && ofItem.imdb !== s.tt ? { ...item0, title: undefined, originalTitle: undefined, year: undefined, runtime: undefined, genres: [], directors: [], countries: [], cast: [], keywords: [], overview: "" } : item0;
    // The TMDB record of the film: the first one that carries the film's OWN IMDb id (the cover has always asked this, lib/cover-facts.js ownRecords; the index
    // did not until 13/10/2026: tt5580146, Maniac, a 2018 miniseries, took the record of "Titan FC 18" (2011), which has no IMDb id, and with it its year, runtime and countries)
    const own = (x) => (x && x.imdb === s.tt ? x : null);
    const d = own(s.rec && s.rec.detail) || own(s.cand && s.cand.film) || own(lb ? detail(lb) : null) || own(detailOfImdb(s.tt)) || null; // the last: the record /find found for the IMDb id when the number Letterboxd names is another film's (22/10/2026, friends-cards review)
    if (records) records.set(s.tt, d);
    const facts = {
      id: s.tt, detail: d,
      title: (d && d.title) || (s.rec && s.rec.title) || (item && item.title) || (lb && lb.title) || null,
      year: (s.rec && s.rec.year) || (lb && lb.year) || (item && item.year) || null,
      lb: s.rec && s.rec.lb != null ? s.rec.lb : lb && lb.r != null ? lb.r : null,
      lbRuntime: (s.rec && s.rec.lbRuntime) || (lb && lb.rt) || null,
      lbCountries: s.rec && s.rec.lbCountries && s.rec.lbCountries.length ? s.rec.lbCountries : (lb && lb.c) || [],
    };
    // the year: ONE function for the index and the cover (P.yearOf: Letterboxd's first, the film's own TMDB record as the reserve; Marco, 13/10/2026)
    const year = P.yearOf(facts);
    if (coverFacts) coverFacts.set(s.tt, { imdb: s.tt, year,
      countries: d ? [...(d.countries || [])] : [], language: d ? d.lang || null : null, tmdbOrigin: d && Array.isArray(d.origin) ? [...d.origin] : undefined, directors: d ? (d.directors || []).map((x) => ({ id: x.id })) : [],
      poster: d ? d.poster || null : null, lbCountries: [...facts.lbCountries], origin: "linked" });
    const found = P.countriesOf(facts);
    // The film's main country, the one the facts line of a description shows: the plan item's own (what the static files show: lib/pool.js cardFacts, lib/rows.js), else the
    // one worked out here the same way. The `countries` column (the By country filter) gets it first when it is among the film's countries; when it is not (136 films, 13/10/2026:
    // countriesOf finds none, the plan item's record has one) the filter is left as it was and the `country` column carries it.
    const main = [s.board, s.discover, s.listItem].map((x) => x && x.countries && x.countries[0]).find(Boolean) || P.cardFacts(d, facts.lbCountries).countries[0];
    // The column: the main country first when it is a producer, then the first two producers in TMDB's order, then any other that is a menu entry, so By country keeps its meaning. The two
    // are counted on the PRODUCTION order, not after the main one has moved to the front (review of 22/10/2026: with the main country moved first and the cut made after, a producer that
    // was in the first two before the main country changed fell out of the column and out of the search `find` text); a main country that was the third producer makes the column three long.
    const countries = [...new Set([...(main && found.includes(main) ? [main] : []), ...found.slice(0, MAX_COUNTRIES), ...found.filter((c) => inMenu.has(c))])];
    const dirs = d && d.directors && d.directors.length ? d.directors.map((x) => x.name) : (item && item.directors) || [];
    const matching = (list) => (d && d.keywords && d.keywords.length ? list.filter((t) => d.keywords.some((k) => t.re.test(k))).map((t) => t.term).slice(0, MAX_KEYWORDS) : []);
    const kw = matching(terms);
    const dw = D.wordsForDesc(descMoods ? matching(descTerms) : kw, D.WORDS_KEPT, ((d && d.genres) || (item && item.genres) || []).slice(0, 3)); // a word that repeats a genre of the line goes (lib/describe.js pickWords)
    // the numbers: the object the plan's items share, else asked of the crowd now (a film of the pool that no file shows)
    const planned = [s.board, s.discover, s.listItem].map((x) => x && x.ratings).find(Boolean) || numbers.get(s.tt);
    const num = planned || { lb: null, ...(crowd ? crowd({ id: s.tt, slug: lb && lb.slug, canon: lb && lb.canon, title: facts.title, originalTitle: d && d.originalTitle, year }) : { seenBy: 0, friendsAvg: null, wantBy: 0 }), imdb: imdb.has(s.tt) ? imdb.get(s.tt) : null };
    if (num.imdb == null && imdb.has(s.tt)) num.imdb = imdb.get(s.tt);
    const rank = s.rec ? s.rec.rank : s.cand ? s.cand.tasteZ + 0.7 * s.cand.qualityZ : null;
    const runtime = P.runtimeOf(facts) || (item && item.runtime) || null;
    const descItem = descriptionItem(s, d, item, dw, bestMood.get(s.tt));
    const canonicalSynopsis = D.synopsis(D.synopsisText(descItem));
    const e = {
      tt: s.tt,
      name: facts.title || "?",
      year,
      decade: year ? `${Math.floor(year / 10) * 10}s` : null,
      runtime,
      countries: countries.length ? countries : null,
      country: main && main !== countries[0] ? main : null, // written only when the facts line cannot read it from `countries`
      language: (d && d.lang) || null,
      lbRating: r2(facts.lb),
      tmdbRating: d && d.va > 0 && d.vc > 0 ? r2(d.va) : null,
      tmdbVotes: d && d.vc > 0 ? d.vc : null,
      imdbRating: r2(num.imdb),
      seenBy: num.seenBy || null,
      wantBy: num.wantBy || null,
      friendsAvg: r1(num.friendsAvg), // shown with one decimal: rounding it to two first could round it the other way
      taste: r2(s.rec ? s.rec.tasteZ : s.cand ? s.cand.tasteZ : null),
      quality: r2(s.rec ? s.rec.qualityZ : s.cand ? s.cand.qualityZ : null),
      rank: r2(rank),
      poster: [s.board, s.discover, s.listItem].map((x) => x && x.poster).find(isUrl) || null, // the cover with the ratings drawn on it; null: the Worker uses the same poster service as the static addon
      desc: clip(D.liveDescription(descItem, separator, { words: D.WORDS_KEPT, keepOwnWord: true, synopsis: canonicalSynopsis }), DESC_MAX),
      genres: ((d && d.genres) || (item && item.genres) || []).slice(0, 3),
      director: dirs.slice(0, 2).join(", ") || null,
      keywords: kw,
      moods: s.moods,
      lists: s.lists,
      friends: s.friends,
      watchlist: !!(s.rec ? s.rec.tags.watchlist : s.cand && s.cand.watchlist),
      seen: s.seen || seenTts.has(s.tt),
      eligible: (!quality || quality.eligible(s.tt)) && permits(s.tt, null),
      musicOut: !!musicOut(s.tt),
      shortOut: P.isShort(runtime, minFeature), // on the index's OWN runtime and the number meta.minFeatureMinutes says: lib/index-validation.js holds the two together
    };
    e.find = " " + [e.name, e.director, kw.join(" "), (e.genres || []).join(" "), countries.join(" ")].map(words).join(" | ");
    if (pageFacts) pageFacts.set(s.tt, {
      cast: d ? (d.cast || []).map(x => x.name).slice(0, 5) : [],
      directors: dirs.slice(0, 2), keywords: [...dw], synopsis: canonicalSynopsis,
      synopsisSource: require("./synopsis-source").ourTake(descItem.id) ? "mubi" : canonicalSynopsis ? "other" : "none",
      ...(d && Object.hasOwn(d, "trailer") ? { trailer: d.trailer } : {}),
      listIds: lists.filter(l => ["critic", "director"].includes((cfg.lists || []).find(c => c.id === l.id)?.trust) && Object.hasOwn(e.lists, l.id)).map(l => l.id),
    });
    entries.push(compact(e));
    descWords.set(s.tt, dw);
  }
  // 7b ── the texts that belong to a row, now that the films' keywords are known: the same three words as the film's general text (Marco, 20/10/2026)
  const withWords = (it) => ({ ...it, keywords: descWords.get(it.id) || [], fitMood: bestMood.get(it.id) }); // fitMood: the mood the film fits best, the lead of line 2 in a row that is no mood (lib/best-mood.js; Marco, 21/10/2026, D3)
  for (const r of plan.board) rowDesc[r.id] = r.items.map((it) => text(withWords(it), separator));
  if (dl) dl.options.forEach((o, i) => { directors.options[i].descs = o.items.map((it) => text(withWords(it), separator)); });
  // best rank first (films with no rank last), then by IMDb id: a stable file, and a page of Explore is the first matches in file order
  entries.sort((a, b) => (b.rank ?? -Infinity) - (a.rank ?? -Infinity) || a.tt.localeCompare(b.tt, "en", { numeric: true }));

  const out = {
    meta: {
      ...cfg.personContext, builtAt, version: cfg.addon.version, schema: SCHEMA, part: "full", separator, today, count: entries.length,
      loveStars: cfg.friendRows?.love?.minStars ?? 4, minFeatureMinutes: minFeature, shortMaxMinutes: cfg.shortRow?.maxMinutes ?? 95,
      decades: P.decadeLabels(today), countries: countryMenu, ...(v2 ? { countriesAll: cfg.personContext ? (v2.countries || countryMenu).filter(c => entries.some(f => (f.countries || []).includes(c))) : v2.countries || countryMenu } : {}),
    },
    moods: uniqueOptions(moods.map((m) => ({ label: m.word, id: m.id, name: m.name, alias: m.alias }))).map(({ label, id, name, alias }) => ({ id, label, name, ...(alias ? { alias } : {}) })), // alias: the mood's own name when the v2 Board names its row otherwise (lib/board.js menuFor); the search matches both
    ...(v2 ? { moodMenu: v2.menu } : {}),
    lists: uniqueOptions(lists.map((l) => ({ label: l.name, id: l.id }))).map((o, i) => ({ id: o.id, label: o.label, ...(lists[i].short !== undefined ? { short: listMenu[i].label } : {}), popular: !!lists[i].popular, films: lc[i] ? lc[i].all.length : 0 })),
    friends: { people, options: friendOptions },
    directors,
    board: boardRows,
    rows,
    rowDesc,
    ...(quality ? { rules: workerRules(quality, musicExemptMoods.filter((id) => moods.some((m) => m.id === id))) } : {}),
    films: entries,
  };
  Object.defineProperty(out, "descWords", { value: descWords, enumerable: false }); // tt → the description's words, for build.js to give the plan items (never written to a file)
  return out;
}

/** The Discover catalogs without the films of their calculated options (`ids: []`): every file of the v2 family but the whole index carries the menus alone. A list option has no `ids` and stays as it is. */
const discoverLabels = (discover) => (discover ? { ...discover, catalogs: discover.catalogs.map((c) => ({ ...c, options: c.options.map((o) => (o.ids ? { ...o, ids: [] } : o)) })) } : discover);

/** The directors' menu without its films: every piece but index-directors.json carries the labels only (the manifest needs them). */
const directorLabels = (index) => ({ options: ((index.directors && index.directors.options) || []).map((o) => ({ label: o.label, ids: [], descs: [] })) });

/** The small companion: only the films on the Board rows, the menus, and the friends' and directors' options without their films. */
function boardIndex(index) {
  const keep = new Set(Object.values(index.rows).flat());
  const films = index.films.filter((f) => keep.has(f.tt));
  return { ...index, meta: { ...index.meta, part: "board", count: films.length }, friends: { people: index.friends.people, options: index.friends.options.map((o) => ({ label: o.label, ids: [] })) }, directors: directorLabels(index), ...(index.discover ? { discover: discoverLabels(index.discover) } : {}), films };
}

/**
 * One piece for a catalog family: same menus, no Board rows, just the films that family can show.
 * keepIds: the friends' options keep their film ids (only the friends piece needs them). keepDirectors: the same for the directors' piece.
 */
function piece(index, part, films, keepIds = false, keepDirectors = false) {
  return {
    ...index, meta: { ...index.meta, part, count: films.length }, board: [], rows: {}, rowDesc: {},
    friends: { people: index.friends.people, options: index.friends.options.map((o) => ({ label: o.label, ids: keepIds ? o.ids : [] })) },
    directors: keepDirectors ? index.directors : directorLabels(index), ...(index.discover ? { discover: discoverLabels(index.discover) } : {}), films,
  };
}

/** Every piece of the index: [{ rel (path under the output folder), part, obj }]. */
function pieces(index) {
  const out = [{ rel: BOARD_FILE, part: "board", obj: boardIndex(index) }];
  out.push({ rel: MOODS_FILE, part: "moods", obj: piece(index, "moods", index.films.filter((f) => f.moods && Object.keys(f.moods).length)) });
  const inFriends = new Set(index.friends.options.flatMap((o) => o.ids));
  out.push({ rel: FRIENDS_FILE, part: "friends", obj: piece(index, "friends", index.films.filter((f) => inFriends.has(f.tt)), true) });
  const inDirectors = new Set(((index.directors && index.directors.options) || []).flatMap((o) => o.ids));
  out.push({ rel: DIRECTORS_FILE, part: "directors", obj: piece(index, "directors", index.films.filter((f) => inDirectors.has(f.tt)), false, true) });
  for (const l of index.lists) out.push({ rel: listFile(l.id), part: `list:${l.id}`, obj: piece(index, `list:${l.id}`, index.films.filter((f) => f.lists && l.id in f.lists)) });
  return out;
}

/**
 * The index the cover step walks: the legacy index plus the films only the v2 index has (a v2 row may hold a film no legacy surface shows). The legacy entry wins for a film in both.
 */
function withV2Films(index, index2) {
  if (!index2) return index;
  const have = new Set(index.films.map((e) => e.tt));
  return { ...index, films: [...index.films, ...index2.films.filter((e) => !have.has(e.tt))] };
}

/** The v2 rows' own films, in the index's order. */
const filmsOf = (index, ids) => { const keep = new Set(ids); return index.films.filter((f) => keep.has(f.tt)); };

/**
 * Every file of the v2 family but the whole index: [{ rel, part, obj }], in the order they are written.
 *   v2-menus      the menus, the whole `board` and `moodMenu`; `rows` and `rowDesc` name every row with an empty list; no films
 *   v2-row:<id>   one row (a series row has no file: the Worker builds it): its board entry, its `rows` and `rowDesc`, and exactly its films
 *   v2-mood:<id>  every film that fits the mood, with the menus, no Board rows
 *   v2-row:watchlist-<friend>  (Marco, 29/10/2026) the Board's watchlist row as that configured friend would have it, one file per friend: lib/friend-view.js
 */
function pieces2(index) {
  const labels = (o) => ({ ...o, friends: { people: o.friends.people, options: o.friends.options.map((x) => ({ label: x.label, ids: [] })) }, directors: directorLabels(o), ...(o.discover ? { discover: discoverLabels(o.discover) } : {}) });
  const empty = (obj) => Object.fromEntries(Object.keys(obj).map((id) => [id, []]));
  const out = [{ rel: V2_MENUS_FILE, part: "v2-menus", obj: { ...labels(index), meta: { ...index.meta, part: "v2-menus", count: 0 }, rows: empty(index.rows), rowDesc: empty(index.rowDesc), films: [] } }];
  for (const entry of index.board) {
    if (entry.series) continue;
    const films = filmsOf(index, index.rows[entry.id]);
    out.push({ rel: v2RowFile(entry.id), part: `v2-row:${entry.id}`, obj: { ...labels(index), meta: { ...index.meta, part: `v2-row:${entry.id}`, count: films.length }, board: [entry], rows: { [entry.id]: index.rows[entry.id] }, rowDesc: { [entry.id]: index.rowDesc[entry.id] }, films } });
  }
  const menuMoods = new Set(index.moods.map((m) => m.id));
  for (const { id } of index.moodMenu) {
    if (!menuMoods.has(id)) continue; // a menu row (friends-week) is served from its row's file
    out.push({ rel: v2MoodFile(id), part: `v2-mood:${id}`, obj: piece(index, `v2-mood:${id}`, index.films.filter((f) => f.moods && id in f.moods)) });
  }
  // The friends' view (Marco, 29/10/2026; lib/friend-view.js): one watchlist row per configured friend, for the Worker's /u/<friend>/ routes. Marco's own index only: an index built for a person (Will's) has none.
  if (!(index.meta && index.meta.personId)) {
    const people = (index.friends && index.friends.people) || [];
    FV.slugsOf(people); // an address that cannot be one stops the build here
    for (let i = 0; i < people.length; i++) {
      const p = FV.watchlistPiece(index, i, labels);
      if (p) out.push(p);
    }
  }
  return out;
}

/**
 * Where the first pages of a calculated option of the Discover end in its `ids` (Marco, 29/10/2026, questionnaire "peças por opção do Discover"). The Worker shows an option as catalogs.js select() reads it:
 * the ids in this order, the films the index holds, minus the ones he has seen (unless "Include seen"), and for a recommending option only the recommendable ones (eligible, not held back by the music rule and, since 15/11/2026, not a short);
 * a `curated` option has no rule. → { n, total, totalAll }: `n` the number of ids to keep so that the default view (no menu on top, no "Include seen") shows OPT_FILMS films, or every id when the option
 * shows fewer; `total` and `totalAll` how many films the default view and the "Include seen" view show in the WHOLE option, which the Worker sends as X-Total and cannot count from the part.
 * The cut is on what the default view shows, not on the first OPT_FILMS ids: a film he has seen takes a place in `ids` and none on the screen, so cutting at the 300th id would give a short page 3.
 */
function optionCut(byTt, option) {
  // the Worker's `recommendable` (worker/src/film.js): the two counts below are what it shows, so the three bits are read here as there; an option that says `shorts: true` (an era: its file names its shorts) is not asked the short bit
  const shows = (e, all) => (option.curated ? all || !e.seen : e.eligible === true && e.musicOut !== true && (option.shorts === true || e.shortOut !== true) && (all || !e.seen));
  let n = option.ids.length, total = 0, totalAll = 0, cut = null;
  option.ids.forEach((tt, i) => {
    const e = byTt.get(tt);
    if (!e) return;
    if (shows(e, true)) totalAll++;
    if (shows(e, false) && ++total === OPT_FILMS) cut = i + 1;
  });
  if (cut !== null) n = cut;
  return { n, total, totalAll };
}

/**
 * The pieces of the calculated options of the Discover, one file each: [{ rel, part, obj }] (empty without `discover`). Each holds the films of the first `n` ids of its option (optionCut), the menus of every other file
 * (`ids: []` everywhere else) and, in its own option, those ids plus `total` and `totalAll`. A card of a director also keeps the "X loves" option it grew from, with its texts, because the Worker reads them there.
 * Marco's Animation option keeps every candidate when its complete encoded piece fits ANIMATION_PIECE_MAX_BYTES. Every other option and every independent person's index retains the existing cut.
 * When the piece covers totalAll, the Worker can answer every viewer, filter and page from it (catalogs.js completeOptionPage). Partial pieces retain the unfiltered Marco prefix shortcut; other requests use the whole v2 index.
 */
function optionPieces(index) {
  if (!index.discover) return [];
  const byTt = new Map(index.films.map((e) => [e.tt, e]));
  const labels = discoverLabels(index.discover);
  const out = [], seenRel = new Set();
  for (const [ci, c] of index.discover.catalogs.entries()) {
    for (const [oi, o] of c.options.entries()) {
      if (!o.ids) continue; // a list option reads its own piece
      const rel = v2OptFile(c.id, o.id), part = `v2-opt:${c.id}:${o.id}`;
      // the public allowlist (lib/learning/public.js) takes lower case words joined by hyphens after `index-v2-`; a name outside it would make verify-public refuse the whole night's publication
      if (!new RegExp(`^data/index-v2-opt-${ROW_ID_SOURCE}\\.json$`).test(rel.split(path.sep).join("/"))) throw new Error(`Discover option ${c.id} / ${o.id}: the piece ${rel} is not a name the public files allow (lower case letters, digits and hyphens)`);
      if (seenRel.has(rel)) throw new Error(`Discover option ${c.id} / ${o.id}: two options write the piece ${rel}`);
      seenRel.add(rel);
      const { n, total, totalAll } = optionCut(byTt, o);
      const loves = o.director !== undefined ? ((index.directors && index.directors.options) || []).find((d) => d.label === o.director) : null;
      const make = (ids) => {
        const keep = new Set(ids), films = index.films.filter((f) => keep.has(f.tt));
        const discover = { ...labels, catalogs: labels.catalogs.map((cat, k) => (k !== ci ? cat : { ...cat, options: cat.options.map((x, j) => (j !== oi ? x : { ...x, ids, total, totalAll })) })) };
        const base = piece(index, part, films);
        return { ...base, discover, ...(loves ? { directors: { options: base.directors.options.map((d) => (d.label === loves.label ? loves : d)) } } : {}) };
      };
      let obj = make(o.ids.slice(0, n)), expansion;
      if (!index.meta.personId && c.id === "genres" && o.id === "g-animation" && n < o.ids.length) {
        const complete = make(o.ids.slice());
        // Same encoding as writeIndex: include menus, metadata and multibyte text, not just film rows or JS string length.
        const bytes = Buffer.byteLength(JSON.stringify(encode(complete)));
        const accepted = bytes <= ANIMATION_PIECE_MAX_BYTES;
        if (accepted) obj = complete;
        expansion = { part, bytes, maxBytes: ANIMATION_PIECE_MAX_BYTES, accepted, reason: accepted ? "within-byte-limit" : "over-byte-limit" };
      }
      out.push({ rel, part, obj, ...(expansion ? { expansion } : {}) });
    }
  }
  return out;
}

/**
 * A film's general text: the cast, the genres and keywords and the synopsis (lib/describe.js liveDescription), joined by the build's separator. Generic for a film of the
 * pool, the row's own for a film only the plan knows. Line 1 (the director, the duration) is not here: the live addon builds it from the entry's columns.
 */
function descriptionItem(s, d, item, keywords, fitMood) {
  // `d` is the film's own TMDB record or nothing; the pool's `contributions` were computed from the pool's record, whichever film it was
  const base = s.rec ? P.toItem({ ...s.rec, detail: d }, []) : item || {};
  // The cast and the genres are the film's own TMDB record's (the plan item's, for a film that has none). `keywords` are the film's mood words (`descWords`, up to four: lib/describe.js
  // never reads TMDB's raw keywords). The row's mood (`mood`) is left out: a film's general text does not know which catalog is on screen; the live addon puts the mood of the catalog's row there
  // (worker/src/meta.js). A Board row keeps its own (rowDesc).
  const genres = (d && d.genres) || (item && item.genres) || [];
  // four words, not three: the Worker drops the one that is the name of the mood of the Moods menu and shows three (worker/src/meta.js)
  return { ...base, mood: undefined, moodIsRow: undefined, leadsWithReason: undefined, fitMood, genres, keywords, cast: d && d.cast && d.cast.length ? d.cast.map((x) => x.name) : base.cast, overview: base.overview || (d && d.overview) || "" };
}
/** The description of an item without its first line: cast, line 2, synopsis (lib/describe.js). */
const text = (it, separator, words) => clip(D.liveDescription(it, separator, words ? { words, keepOwnWord: true } : undefined), DESC_MAX); // a film's general text (four words) keeps the lead mood's own word: the Moods menu may put another mood in the lead's place

/**
 * The recommendation rule as the Worker reads it. The rule itself is the per-film `eligible` flag; these are the facts around it.
 * exemptCatalogs: the Worker's catalogs that are direct curator or friend collections and are never filtered: the same three that
 * recommendation-quality.js applyPlan() leaves alone ("mood-engine-lists", "-lists-unseen", "-friends"; a test checks that they agree).
 * The Board rows are served as the build made them, and are exempt too.
 */
const WORKER_EXEMPT = ["lists", "lists-unseen", "friends"];
function workerRules(quality, musicExemptMoods = []) {
  // Marco, 11/10/2026: the label names the one floor exception too (a critic/director list or a favourite director's love; the flag `eligible` decides)
  // musicExemptMoods (Marco, 22/10/2026 ~15:15 UTC): the mood ids whose Moods-menu option ignores the music rule's bit; absent when none, so the key never appears in an index that has no exemption
  return { rule: "letterboxd-average-or-configured-friend-or-vouched", minStars: quality.minStars, exemptCatalogs: WORKER_EXEMPT, ...(musicExemptMoods.length ? { musicExemptMoods: [...musicExemptMoods] } : {}) };
}

/** Drop what is null, empty or false: an absent key means "not known", and the file stays small. */
function compact(e) {
  const out = {};
  for (const k of ENTRY_KEYS) {
    const v = e[k];
    if (v == null || v === false || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * The original language of each film of the index, small enough to be read with one String.includes (Marco, 12/10/2026; worker/src/film-languages.js reads it):
 *   { v: 1, builtAt, pt: "|0111161|0068646|", known: "|0050083|…|" }
 * `pt`: the films whose language is Portuguese ("pt"). `known`: the films with any other language that is a language (languageCode() of lib/countries.js decides: "xx" and "zxx", "no spoken language", are not).
 * A film in neither is "not known". Each string is the numbers of the IMDb ids (tt0111161 → 0111161) sorted, each with a bar on both sides, so `includes("|0111161|")`
 * never matches part of another id; an empty list is a single bar. Nothing here is not already in index.json: it is the `language` column, cut out.
 */
function languagesFile(index) {
  const pt = new Set(), known = new Set();
  for (const f of index.films) {
    const m = /^tt(\d+)$/.exec(String(f.tt));
    const language = languageCode(f.language); // lib/countries.js: "pt-BR" is "pt"; blank, "xx" and "zxx" (no spoken language) and anything that is not a 2 or 3 letter code are not a language
    if (!m || !language) continue;
    (language === "pt" ? pt : known).add(m[1]);
  }
  const list = (ids) => (ids.size ? `|${[...ids].sort().join("|")}|` : "|");
  return { v: LANGUAGES_VERSION, builtAt: index.meta.builtAt, pt: list(pt), known: list(known) };
}

/**
 * The BUILD's conference of the short mark (15/11/2026, review of the shorts in the Worker). lib/index-validation.js accepts an index in which no film carries `shortOut`, by design: every index built before the bit is one,
 * and the snapshots replay them. So a build that stopped writing the bit would pass the validator, and the Worker would show every short again with no error anywhere. This is asked of the index the build has just made,
 * never of one that is read: a film with a known runtime under meta.minFeatureMinutes and not ONE film with the mark stops the build. (One mark or more: the validator already holds every bit to its runtime.)
 */
function assertShortsMarked(index, name = "index") {
  const min = Number.isFinite(index.meta.minFeatureMinutes) ? index.meta.minFeatureMinutes : P.MIN_FEATURE_MINUTES;
  const shorts = index.films.filter((e) => P.isShort(e.runtime, min));
  if (shorts.length && !index.films.some((e) => e.shortOut === true)) throw new Error(`${name}: ${shorts.length} film(s) have a known runtime under ${min} minutes and not one carries the short mark (shortOut, bit 16 of the flags): the build did not write it (the first: ${shorts[0].tt} ${shorts[0].name}, ${shorts[0].runtime} min)`);
}

/**
 * Writes validated <outDir>/data/index.json and its pieces inside publication staging. → { file, bytes, gzip, films, board: { bytes, gzip, films }, pieces: { files, bytes, gzip } }
 * index2: the v2 index (buildIndex with `v2`), or null. Its files are written after the legacy ones and reported under `v2: { bytes, gzip, films, files, piecesBytes, piecesGzip, largest, options: { files, bytes, gzip, largest } }` (`options`: the pieces of the Discover's calculated options, optionPieces).
 */
function writeIndex(outDir, index, index2 = null) {
  require("./index-validation").validateIndex(index);
  if (index2) require("./index-validation").validateIndex(index2, V2_NAME);
  assertShortsMarked(index);
  if (index2) assertShortsMarked(index2, V2_NAME);
  const planned = pieces(index);
  const planned2 = index2 ? pieces2(index2) : [];
  const plannedOpt = index2 ? optionPieces(index2) : [];
  const Paths = require("./learning/paths");
  for (const rel of [FILE, ...planned.map(p => p.rel), ...(index2 ? [V2_FILE, ...planned2.map(p => p.rel), ...plannedOpt.map(p => p.rel)] : [])]) {
    if (!/^data\/index(?:-[A-Za-z0-9_-]+)?\.json$/.test(rel)) throw new Error("Unsafe index path");
    Paths.noAliases(path.join(outDir,rel), path.resolve(outDir));
  }
  const put = (rel, obj) => {
    const file = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = JSON.stringify(encode(obj)); // the file form: one array per film (lib/index-rows.js)
    fs.writeFileSync(file, text);
    return { file, bytes: Buffer.byteLength(text), gzip: zlib.gzipSync(text, { level: 9 }).length, films: obj.films.length };
  };
  const full = put(FILE, index);
  const languages = languagesFile(index);
  const languagesText = JSON.stringify(languages);
  fs.writeFileSync(path.join(outDir, LANGUAGES_FILE), languagesText);
  const written = planned.map((p) => ({ part: p.part, ...put(p.rel, p.obj) }));
  const board = written.find((w) => w.part === "board");
  const rest = written.filter((w) => w.part !== "board");
  const countOf = (s) => (s === "|" ? 0 : s.split("|").length - 2);
  let v2 = null;
  if (index2) {
    const whole = put(V2_FILE, index2);
    const parts = planned2.map((p) => put(p.rel, p.obj));
    const opt = plannedOpt.map((p) => put(p.rel, p.obj)); // after the others, so the files of the v2 family that were already there are written in the order they always were
    v2 = { bytes: whole.bytes, gzip: whole.gzip, films: whole.films, files: parts.length, piecesBytes: parts.reduce((a, w) => a + w.bytes, 0), piecesGzip: parts.reduce((a, w) => a + w.gzip, 0), largest: Math.max(0, ...parts.map((w) => w.films)),
      options: { files: opt.length, bytes: opt.reduce((a, w) => a + w.bytes, 0), gzip: opt.reduce((a, w) => a + w.gzip, 0), largest: Math.max(0, ...opt.map((w) => w.films)), expansions: plannedOpt.flatMap((p) => p.expansion ? [p.expansion] : []) } };
  }
  return { ...(v2 ? { v2 } : {}), ...full, languages: { bytes: Buffer.byteLength(languagesText), gzip: zlib.gzipSync(languagesText, { level: 9 }).length, pt: countOf(languages.pt), known: countOf(languages.known) }, board, pieces: { files: rest.length, bytes: rest.reduce((a, w) => a + w.bytes, 0), gzip: rest.reduce((a, w) => a + w.gzip, 0), largest: Math.max(0, ...rest.map((w) => w.films)) } };
}

module.exports = { assertShortsMarked, discoverLabels, optionCut, optionPieces, v2OptFile, OPT_FILMS, ANIMATION_PIECE_MAX_BYTES, buildIndex, yearsByTt, showYear, factsByTt, boardIndex, pieces, pieces2, withV2Films, writeIndex, V2_FILE, V2_MENUS_FILE, V2_ROW_MAX, v2RowFile, v2MoodFile, allowlist, keywordTerms, workerRules, WORKER_EXEMPT, words, SCHEMA, FILE, BOARD_FILE, MOODS_FILE, FRIENDS_FILE, DIRECTORS_FILE, LANGUAGES_FILE, languagesFile, LANGUAGES_VERSION, listFile, ENTRY_KEYS };
