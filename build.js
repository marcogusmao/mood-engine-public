#!/usr/bin/env node
// Mood Engine — builds your personal Stremio addon + mood-picker page into ./docs
//
//   TMDB_TOKEN=xxxx node build.js
//   node build.js --offline                 no TMDB calls at all: only cache/tmdb.json + Letterboxd pages
//   node build.js --skip-friends            no Letterboxd beyond your own RSS: no live watchlist, lists, friends, week row, cuts; config.json's own "board" (the v2 family) is left out of such a build (14/10/2026)
//   node build.js --cache-only              build from cache/friends.json + cache/lists.json, ask nobody, write no cache
//   node build.js --friends-refresh         read the friends' pages again even if the cache is under a week old (histories whole, not just the recent news)
//   node build.js --lists-refresh           read the curated lists again even if the cache is fresh
//   node build.js --lookup-limit 60         look up at most 60 film pages this run (development; --friends-limit is the old name)
//   node build.js --crowd-limit 2           read the history of at most 2 of the people you follow this run (development)
//   node build.js --enrich-max 500          read again at most 500 cached film pages for rating/runtime/country (default 2000)
//   node build.js --offline --cache-only --self-test-guard   prove the "seen film" guard refuses planted leaks, then exit
//   node build.js --no-chrome               do not use Chrome for the pages plain HTTP cannot reach (history beyond page 1, /following/, Popular this week); each history is then read as in v2 (page 1 of /films/ by HTTP, merged into the cache, retried daily): the incremental read needs Chrome
//   node build.js --skip-posters            no covers with ratings drawn on them and nothing downloaded for them (IMDb ratings: from cache/imdb-ratings.json only)
//   node build.js --description-separator " — "   join the description's lines with this instead of config.json → descriptionSeparator ("\n" is a line break)
//   node build.js --mubi-cache f.json  (or MUBI_CACHE=f.json) read MUBI's Our Take from this file instead of <cache dir>/mubi.json (the default); the text is published with the credit "MUBI: "
//   node build.js --out some/dir            publish somewhere other than ./docs (the tests use this)
//   node build.js --board some.json         read config.json "board" (lib/board.js) from this file instead: the build then writes the v2 index family next to the legacy files (tests, rehearsals; without a board the output is the one of every night, and with one every legacy file is identical apart from meta.builtAt). test/fixtures/board-v2.json is a small board of rows that exist today; test/fixtures/board-v2-pr2.json carries the 21 moods, the decades, the regions and the combined rows of PR2 too
//   node build.js --config some.json        read this file instead of ./config.json (the legacy-parity test builds the same caches from a full config and from the one reduced to board.legacyMoods)
//   node build.js --cache-dir some/dir      read and write the caches (tmdb.json, friends.json, lists.json, imdb-ratings.json, posters.json, posters-raw/, posters-out/) there instead of ./cache
//   FRONT_MEMORY_WRITE=1 node build.js      write today's front into <cache dir>/front-memory.json (the memory of the front shuffle, config.json board.shuffle): only the scheduled run sets it (scripts/noturna-mac.sh --agendada since 21/10/2026; the workflow's schedule before), and a --cache-only build never writes it; every build READS the file
//   TONIGHT_MEMORY_WRITE=1 node build.js    write today's Tonight into <cache dir>/tonight-memory.json (lib/tonight-memory.js; Marco, 14/11/2026: a film of Tonight stays out of it for config.json tonight.noRepeatDays days): set by every run that PUBLISHES (scripts/noturna-mac.sh --agendada and --manual), never by a rehearsal, and a --cache-only build never writes it; every build READS the file
//   node build.js --cover-receipt some.json  where the local receipt of what each cover was drawn from is written (default <root>/.context/<date>-cover-receipt.json, only when --out is not given)
//
// Reads data/letterboxd/*.csv (from import-letterboxd.js) + your public Letterboxd RSS,
// learns your taste, finds films you haven't seen, scores them per mood, publishes.

const fs = require("fs");
const path = require("path");
const PEOPLE = require("./lib/people");
// Identity flags are checked before loading configuration, caches or private inputs.
let personOptions;
try {
  personOptions = PEOPLE.buildPersonOptions(__dirname, process.argv.slice(2));

} catch (e) { console.error("✖ " + e.message); process.exit(1); }
const { Tmdb, trailerBudgetFrom } = require("./lib/tmdb");
const { loadHistory, fetchRss, applyLiveWatchlist } = require("./lib/letterboxd");
const { learn, score, reasons, fingerprint } = require("./lib/taste");
const { compile, fit, validateListMoods } = require("./lib/moods");
const { buildRows, buildFriendRows, tonightSpec } = require("./lib/rows");
const { publish } = require("./lib/publish");
const { buildIndex, yearsByTt, showYear, factsByTt, withV2Films, keywordTerms } = require("./lib/index-export");
const { bestMoods } = require("./lib/best-mood");
const { norm, zscore, bayes, filmKey } = require("./lib/util");
const { makeSearchLinker, relinkTo, againstApproved, APPROVED } = require("./lib/search-link");
const F = require("./lib/friends");
const FR = require("./lib/friends-records");
const { refreshFriends, friendStats } = F;
const L = require("./lib/lists");
const SL = require("./lib/static-lists");
const P = require("./lib/pool");
const { buildPlan, guardRows, boardRows, menusOf, menuChanges, GUARD_EXEMPT, BOARD_BEFORE_MOODS, BOARD_AFTER_MOODS, DISCOVER } = require("./lib/plan");
const Q = require("./lib/recommendation-quality");
const LW = require("./lib/list-signal");
const { findLeaks, seenImdbIds } = require("./lib/guard");
const { makeChrome, routed, findChrome } = require("./lib/fetch-chrome");
const { crowdIndex, letterboxdAverages, attachRatings, planItems } = require("./lib/crowd");
const PO = require("./lib/posters");
const CO = require("./lib/countries");
const DL = require("./lib/directors-loved");
const BD = require("./lib/board");
const BR = require("./lib/board-rows");
const THIN_ROW = 20; // the v2 Board warns (!) for a row of fewer films than this
const SR = require("./lib/special-rows");
/**
 * config.json build.rewatchMinStars: the lowest rating of a film in Worth watching again (Old friends). Marco, 14/11/2026 ("Include 4 stars"): 4; it was 4.5 written in the code. A config without the
 * key gets 4 (the decision, not the number of before); a value that is not a number from 0.5 to 5 stops the build.
 */
function rewatchMinStars(cfg) {
  const v = cfg.build && cfg.build.rewatchMinStars;
  if (v === undefined) return 4;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0.5 || v > 5) throw new Error(`config.json build.rewatchMinStars must be a number from 0.5 to 5 (the lowest rating of Worth watching again; 4 when absent), got ${JSON.stringify(v)}`);
  return v;
}

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
if (flag("--offline")) process.env.OFFLINE = "1";
const OUT_DIR = personOptions ? personOptions.outDir : path.resolve(opt("--out") || path.join(__dirname, "docs"));
if (OUT_DIR === __dirname || __dirname.startsWith(OUT_DIR + path.sep)) {
  console.error("✖ --out would wipe the project folder. Pick an empty or throw-away folder.");
  process.exit(1);
}
const COVER_RECEIPT = opt("--cover-receipt") ? path.resolve(opt("--cover-receipt")) : null;
const SKIP_FRIENDS = flag("--skip-friends");
const CACHE_ONLY = flag("--cache-only");
const SELF_TEST = flag("--self-test-guard");
const NO_CHROME = flag("--no-chrome");
const DESCRIPTION_SEPARATOR = opt("--description-separator") == null ? null : opt("--description-separator").replace(/\\n/g, "\n");
const SKIP_POSTERS = flag("--skip-posters");
const numberFlag = (names, fallback) => {
  const name = names.find((n) => argv.includes(n));
  if (!name) return fallback;
  const v = Number(opt(name));
  if (!(v >= 0)) {
    console.error(`✖ ${name} needs a number, e.g. ${name} 60`);
    process.exit(1);
  }
  return v;
};
const LOOKUP_LIMIT = numberFlag(["--lookup-limit", "--friends-limit"], Infinity);
const ENRICH_MAX = numberFlag(["--enrich-max"], F.ENRICH_PER_RUN);
const CROWD_LIMIT = numberFlag(["--crowd-limit"], Infinity);

const ROOT = __dirname;
const CACHE_DIR = personOptions ? personOptions.cacheDir : path.resolve(opt("--cache-dir") || path.join(ROOT, "cache"));
const baseConfig = JSON.parse(fs.readFileSync(opt("--config") ? path.resolve(opt("--config")) : path.join(ROOT, "config.json"), "utf8"));
const cfg = personOptions ? PEOPLE.deriveConfig(baseConfig, personOptions.person) : baseConfig;
if(personOptions){
 const revision=opt('--revision');if(!/^r-[a-f0-9]{32}$/.test(revision||''))throw Error('Will requires a reserved --revision');
 cfg.personContext={personId:'friend-a',revision};
 cfg.posters.base=`https://marcogusmao.github.io/mood-engine/u/friend-a/r/${revision}/posters/`;
}
if (opt("--board")) Object.assign(cfg, require("./lib/board-shared").withRehearsalBoard(cfg, JSON.parse(fs.readFileSync(path.resolve(opt("--board")), "utf8")))); // a rehearsal board (test/fixtures/board-v2.json) in place of config.json's own "board", which is what runs at night; the moods the rehearsal board defines replace the config's of the same id (lib/board-shared.js)
// --skip-friends reads no friends, no lists and no crowd: the v2 Board (friends' rows, prizes, the frozen country menu) has nothing to stand on, so the board of config.json is left out of such a
// build and it publishes the legacy family alone (found 14/10/2026 when config.json took the board: index-v2 stopped it at "meta.countriesAll names Chile, and no film of the index has that country").
// A board named with --board is a rehearsal the caller asked for, and stays.
const BOARD_SKIPPED = flag("--skip-friends") && !opt("--board") && !!cfg.board;
if (BOARD_SKIPPED) { Object.assign(cfg, BD.legacyConfig(cfg)); delete cfg.board; }
const BOARD = (() => { try { return BD.parse(cfg, opt("--board") ? `--board ${opt("--board")}` : "config.json board"); } catch (e) { console.error("\n✖ " + e.message); process.exit(1); } })(); // null without a board: then nothing below changes. A board that names a row the build cannot make stops the build here, before any work
const SPECIAL = BOARD ? SR.rowsFor(cfg, BOARD.entries.map((e) => e.id)) : []; // the special rows of the v2 Board (top-picks, friends-split, awards, list …), in the Board's order: lib/special-rows.js
const FRIEND_KINDS = new Set(["top-picks", "friends-split", "friends-watchlist", "friends-month"]); // the special rows made of what the people he follows rated, watched or want: build.js asks TMDB for the records of their films (lib/friends-records.js)
const AWARDS = {}; // the prize files of each `awards` row: a file that is not there is a warning, one that is not sound stops the build here
for (const s of SPECIAL) if (s.kind === "awards") { try { AWARDS[s.id] = SR.loadAwards(ROOT, s); } catch (e) { console.error("\n✖ " + e.message); process.exit(1); } }
const TONIGHT = (() => { try { return tonightSpec(cfg); } catch (e) { console.error("\n✖ " + e.message); process.exit(1); } })(); // config.json "tonight" (bias, depth, noRepeatDays; lib/rows.js): a value that is not sound stops the build here, before any work
try { const EX0 = require("./lib/exclude"); EX0.assertNotPinned(EX0.parse(cfg.exclude), cfg.moods); } catch (e) { console.error("\n✖ " + e.message); process.exit(1); } // config.json: a film in exclude.films and in a mood's pins stops the build here (Marco, 15/11/2026; lib/exclude.js); so does a bad exclude.films
const LEGACY_CFG = BD.legacyConfig(cfg); // what the legacy family is made from: no board, only the moods of board.legacyMoods (the others exist in the v2 family alone)
require("./lib/util").applyLimits(cfg.limits); // config.json "limits" (deadline and byte cap per outside request) over the defaults in lib/util.js LIMITS
LW.validateLists(cfg.lists || []); // every list says who made it (critic, director, fan): Marco, 11/10/2026
const listSubsets = require("./lib/critic-subset").loadAll(ROOT, cfg.lists); // fan lists with a critics' subset (Cannes): invalid file stops the build
for (const l of cfg.lists || []) if (SL.isStatic(l)) SL.load(ROOT, l); // a malformed static list stops the build here, sources on or off
{ const p = validateListMoods(cfg.lists, cfg.moods); if (p.length) throw new Error(`config.json lists: ${p.join("; ")}`); } // a list may be a mood's signal
// One observation instant governs selection, feedback expiry and immutable replay.
const capturedAt = opt("--captured-at") || new Date().toISOString();
const explicitDate = opt("--date");
if (explicitDate && process.env.MOOD_DATE && explicitDate !== process.env.MOOD_DATE) throw new Error("--date conflicts with MOOD_DATE");
if (!Number.isFinite(Date.parse(capturedAt))) throw new Error("Invalid --captured-at");
const today = explicitDate || process.env.MOOD_DATE || new Date(capturedAt).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
const daysAgo = (n) => new Date(Date.parse(today + "T12:00:00Z") - n * 864e5).toISOString().slice(0, 10);
const log = (...a) => {
  if (!personOptions) return console.log(...a);
  if (typeof a[0] === "string" && /^[1-6]\/6\s/.test(a[0])) console.log(a[0]);
};
// The Discover catalogs of the v2 family (Marco, 22/10/2026; lib/discover-catalogs.js, data/discover-catalogs.json): read and checked HERE, before any work, so that a list without a
// catalog or a label of 29 characters stops the build now and not after the pool. No file, or a build with no v2 Board: no `discover` in the index, and the Worker answers as before.
const DC = require("./lib/discover-catalogs");
// --discover-file <path> (Marco, 28/10/2026): another catalogs file in place of data/discover-catalogs.json, for the builds of the tests that use a `--config` with fewer moods than production (the production file names keywords
// that those moods do not have, and parse() refuses it). A path that is not there stops the build: a typing mistake must not turn into "no discover".
// The checks run for EVERY build, with or without a Board (review of 29/10/2026: the missing-file check sat after `if (!BOARD) return null`, so a `--skip-friends` build with a typo went on without the
// file); a flag with no value after it (last argument, or followed by another flag) stops with a message and does not fall back to the default file.
const DISCOVER_FILE = (() => {
  if (!flag("--discover-file")) return undefined;
  const given = opt("--discover-file");
  if (given === undefined || given.startsWith("--")) { console.error("\n✖ --discover-file needs a path: the catalogs file to read in place of data/discover-catalogs.json"); process.exit(1); }
  if (!fs.existsSync(path.resolve(given))) { console.error(`\n✖ --discover-file ${given}: no such file`); process.exit(1); }
  return path.resolve(given);
})();
const DISCOVER_SPEC = (() => {
  if (!BOARD) return null;
  try { const json = DC.load(DISCOVER_FILE); return json ? DC.parse(json, { lists: cfg.lists || [], today, existingIds: [...BOARD.entries.map((e) => e.id), ...(cfg.moods || []).map((m) => m.id)], keywordTerms: keywordTerms([...(cfg.moods || []), ...BOARD.moods]) }) : null; }
  catch (e) { console.error("\n✖ " + e.message); process.exit(1); }
})();
if (BOARD_SKIPPED) log("  Board: config.json's board is left out of a --skip-friends build (no friends, lists or crowd to make its rows from): the legacy family alone");

main().catch((e) => {
  console.error("\n✖ " + (personOptions ? "PERSON_BUILD_FAILED" : e.message));
  process.exit(1);
});

async function main() {
  require("./lib/learning/paths").validateDestination(OUT_DIR,ROOT,null,false);
  const t0 = Date.now();
  // Marco, 13/10/2026: MUBI's Our Take is the first source of a synopsis, published with the credit "MUBI: ". Its cache is cache/mubi.json (in the repository):
  // read by default from the cache dir; a missing default file is no Our Take, a file that cannot be read stops the build. --mubi-cache / MUBI_CACHE override the path
  // (and a file named there must exist). lib/synopsis-source.js
  const mubiNamed = opt("--mubi-cache") || process.env.MUBI_CACHE;
  const mubiFile = mubiNamed ? path.resolve(mubiNamed) : path.join(CACHE_DIR, "mubi.json");
  if (mubiNamed || fs.existsSync(mubiFile)) {
    const mubi = require("./lib/synopsis-source").useMubi(mubiFile);
    if (!mubi.available) throw new Error(`the MUBI cache ${path.basename(mubiFile)} cannot be used (${mubi.reason}); fix the file${mubiNamed ? "" : " or remove it"}`);
    log(`MUBI Our Take: ${mubi.takes} films of ${mubi.records} records (cache of ${mubi.updatedAt}); published with the credit "MUBI: "`);
  } else log("MUBI Our Take: no cache/mubi.json, TMDB overviews only");
  const EX = require("./lib/exclude"), excluded = EX.parse(cfg.exclude); // config.json exclude.films (Marco, 13/10/2026): a bad id stops the build here
  const learningConfig = JSON.parse(fs.readFileSync(path.join(ROOT, "learning.config.json"), "utf8"));
  if (learningConfig.schemaVersion !== 1 || learningConfig.productionPolicy !== "baseline-v2" || learningConfig.diversity.enabledInProduction || learningConfig.remoteFeedback.enabled) throw new Error("Unsupported learning production policy");
  const learningMode = opt("--learning") || learningConfig.mode;
  if (personOptions && learningMode !== "off") throw Error("Personal builds require learning off until owner-aware source capture is available");
  if (!["off", "shadow"].includes(learningMode)) throw new Error("Learning mode must be off or shadow");
  const LS = require("./lib/learning/snapshot"), LF = require("./lib/learning/feedback");
  const privatePath = opt("--private-dir") ? LS.privateDir(personOptions ? path.join(personOptions.privateDir,"learning") : opt("--private-dir"), ROOT, OUT_DIR) : null;
  if (learningMode === "shadow" && !privatePath) throw new Error("Shadow requires --private-dir");
  const feedbackBatch = LS.readFeedback(privatePath, capturedAt, personOptions ? personOptions.person.id : "marco");
  const feedbackState = LF.project(feedbackBatch.events, capturedAt);
  const exportDir = personOptions ? personOptions.exportDir : path.join(ROOT, "data", "letterboxd");
  if (!personOptions && !fs.existsSync(path.join(exportDir, "watched.csv")))
    throw new Error("No Letterboxd data yet. Run: node import-letterboxd.js path/to/letterboxd-export.zip");
  const tmdb = new Tmdb(process.env.TMDB_TOKEN || process.env.TMDB_API_KEY, path.join(CACHE_DIR, "tmdb.json"), { trailerBudget: trailerBudgetFrom(cfg.tmdb) }); // config.json tmdb.trailerBackfillPerRun (20/10/2026): films cached without a trailer asked again, at most this many a night

  // 0 ── the directors' citizenship (lib/directors.js, cache/directors.json; Marco, 23/10/2026): the first layer of the main country of every film (lib/countries.js mainCountry), loaded BEFORE
  // anything decides a country (the rows, the index and the covers all ask it). The directors of the films already in cache/tmdb.json that Wikidata was never asked about are asked here, at
  // the start (about 120 per query, 400 ms between queries, no key, no login); a film first fetched later in this same build has its director asked tomorrow night, and until then it reads the
  // origin rule. Offline, with --cache-only and in a person's build nothing is asked. A query that fails changes nothing and does not stop the build. A person's build (Will) reads the person's own cache folder, which
  // scripts/prepare-person.js seeds with five files and not this one: with no directors.json there the main country of that site reads TMDB's origin only (documented, not changed: that script validates and neutralises
  // every file it copies, and a sixth file is a change to the private-data code to be made on purpose).
  {
    const DR = require("./lib/directors");
    const directorsFile = path.join(CACHE_DIR, "directors.json");
    const dcache = DR.load(directorsFile);
    if (!process.env.OFFLINE && !CACHE_ONLY && !personOptions) {
      try {
        const r = await DR.refresh(dcache, DR.directorIds(tmdb.cache), { log });
        if (r.wanted) log(`     Directors' citizenship: ${r.wanted} director(s) to ask Wikidata · ${r.answered} answered (${r.withCitizenship} with a citizenship) · ${r.failedBatches} query(ies) failed${r.stopped ? " (stopped: the rest waits for tomorrow)" : ""}`);
        if (r.answered) DR.save(dcache, directorsFile);
      } catch (e) { log(`  ! Directors' citizenship not refreshed: ${e.message} — the directors known so far are used`); }
    }
    const known = DR.citizenshipMap(dcache);
    CO.setDirectors(known);
    log(`     Directors' citizenship: ${known.size} director(s) with a citizenship on file (${Object.keys(dcache).length} asked)${known.size ? "" : " — the main country reads TMDB's origin only"}`);
  }

  // 1 ── history ────────────────────────────────────────────────────────────
  log("1/6  Reading your Letterboxd…");
  const rss = (personOptions || process.env.SKIP_RSS || process.argv.includes("--offline")) ? [] : await fetchRss(cfg.letterboxd);
  const { films, diary } = personOptions ? require("./lib/person-input").loadHistory(JSON.parse(fs.readFileSync(personOptions.input,"utf8"))) : loadHistory(exportDir, rss);

  // Your live watchlist replaces watchlist.csv when the read is complete; otherwise the CSV stays (and the log says so).
  const friendsFile = path.join(CACHE_DIR, "friends.json");
  const fcache = SKIP_FRIENDS ? null : F.loadCache(friendsFile);
  // Chrome reads the pages a script cannot (Cloudflare answers 403 to HTTP there); everything else stays on HTTP.
  let chrome = null;
  if (!personOptions && !SKIP_FRIENDS && !CACHE_ONLY && !NO_CHROME) {
    const exe = findChrome();
    if (exe) { chrome = makeChrome({ chrome: exe }); process.on("exit", () => chrome.close()); log(`     Chrome: ${exe.includes("/") ? path.basename(exe) : exe} reads /films/ history, /following/ and Popular this week`); }
    else log("  ! Chrome not found (set CHROME_PATH): only page 1 of each history and of /following/ can be read, as in v2 (histories are read whole every time they are due, never incrementally), and Popular this week stays closed");
  }
  const http = routed({ http: F.makeHttp(), chrome });
  let live = { ok: false, items: [], reason: SKIP_FRIENDS ? "--skip-friends" : null };
  if (!SKIP_FRIENDS && !personOptions) {
    const csvCount = [...films.values()].filter((f) => f.watchlist).length;
    if (CACHE_ONLY) {
      const w = fcache.watchlist;
      live = w && w.items && w.items.length ? { ok: true, items: w.items.map(([slug, title, year]) => ({ slug, title, year })), pages: w.pages, total: w.total, cached: w.fetchedAt } : { ok: false, items: [], reason: "--cache-only and nothing cached" };
    } else {
      live = await L.readLiveWatchlist({ user: cfg.letterboxd, http });
      if (live.ok) { fcache.watchlist = { fetchedAt: F.iso(Date.now()), pages: live.pages, total: live.total, items: live.items.map((i) => [i.slug, i.title, i.year]) }; F.saveCache(friendsFile, fcache); }
    }
    if (live.ok) {
      const r = applyLiveWatchlist(films, live.items);
      log(`     watchlist: live — ${live.pages ? `${live.pages} pages, ` : ""}${live.items.length} films${live.total ? ` (the page says ${live.total})` : ""}${live.cached ? `, read ${live.cached.slice(0, 10)}` : ""}; ${r.added} not in the export, ${r.removed} in the export but off the list now`);
    } else log(`     watchlist: csv fallback (${live.reason}); ${csvCount} films from the export`);
  } else log("     watchlist: csv (--skip-friends)");
  // where each film stands on Letterboxd's own watchlist page (0 = the top = added last): the v2 Board's watchlist is ordered by it (lib/board-rows.js newestFirst); null when the page was not read
  const livePos = live.ok ? new Map() : null;
  if (livePos) live.items.forEach((it, i) => { const k = filmKey(it.title, it.year); if (!livePos.has(k)) livePos.set(k, i); });
  const all = [...films.values()];
  log(`     ${all.filter((f) => f.watched).length} watched · ${all.filter((f) => f.rating != null).length} rated · ${all.filter((f) => f.watchlist).length} on watchlist · ${rss.length} recent from RSS`);

  // 1b ── the public pages: lists, friends, the people you follow, and the IMDb id of every film in them. Done before
  // anything is chosen, so that "seen" can use everything Letterboxd says about a film (below).
  const sourcesOn = !SKIP_FRIENDS && !!(cfg.friends?.length || cfg.lists?.length);
  const got = sourcesOn ? await gatherSources({ all, live }) : null;

  // 2 ── match to TMDB ─────────────────────────────────────────────────────
  log("2/6  Matching your films to TMDB…");
  // Exact ids from the RSS are remembered forever, so a night when the feed is down changes nothing.
  for (const f of all) if (f.tmdbId) tmdb.remember(f.title, f.year, f.tmdbId);
  await Promise.all(all.map(async (f) => { if (!f.tmdbId && !f.pendingIdentity) { f.tmdbId = await tmdb.search(f.title, f.year); f.searched = true; } }));
  const need = all.filter((f) => f.tmdbId && (f.rating != null || f.watchlist || f.liked));
  await Promise.all(need.map(async (f) => { f.film = await tmdb.movie(f.tmdbId); }));
  tmdb.save();
  // A search hit can be a homonym with the same title and year (Under the Skin 2013 → a 19-minute short): it links only when
  // confirmed (lib/search-link.js). A refused hit is relinked to the film Marco's own Letterboxd page names, found in TMDB by its
  // IMDb id; otherwise the film stays out of your taste, watchlist and seeds. Refusals are counted below and the rated, liked or watchlist ones named.
  const lbCache = got ? null : F.loadCache(friendsFile);
  const lbFilms = got ? got.view.films : lbCache.films;
  const mine = { films: got ? [...got.view.me] : lbCache.me?.slugs || [], watchlist: live.ok ? live.items.map((i) => i.slug) : ((fcache || lbCache).watchlist?.items || []).map(([slug]) => slug) };
  const linker = makeSearchLinker({ movies: tmdb.cache.movie, lbFilms, mine });
  if (!linker.lbRecords) log(`  ! NO LETTERBOXD FILM RECORDS (${path.relative(ROOT, friendsFile)} missing or empty): a TMDB search hit can only be confirmed by the TMDB cache alone, and no refused hit can be relinked`);
  const doubts = [];
  for (const f of all) {
    if (!f.searched || !f.tmdbId) continue;
    const l = linker.check({ title: f.title, year: f.year, entry: tmdb.searchEntry(f.title, f.year), pick: f.tmdbId, watched: f.watched, watchlist: f.watchlist });
    if (l.ok) continue;
    f.searchPick = f.tmdbId; // still counts as seen when watched: hiding a homonym costs nothing
    f.tmdbId = null;
    f.film = null;
    const d = { f, ...l, to: null };
    if (l.relink?.imdb) d.to = await relinkTo(tmdb, linker, l.relink);
    if (d.to) { f.tmdbId = d.to.id; if (f.rating != null || f.watchlist || f.liked) f.film = d.to; }
    doubts.push(d);
  }
  tmdb.save();
  const unmatched = all.filter((f) => !f.tmdbId && !f.searchPick);
  const pendingN = doubts.filter((d) => !d.to).length;
  log(`     matched ${all.length - unmatched.length - pendingN}/${all.length}${unmatched.length ? ` (unmatched are mostly TV/shorts: ${unmatched.slice(0, 4).map((f) => f.title).join(", ")}…)` : ""}`);
  const said = (d) => `${d.f.title} (${d.f.year}${d.f.rating != null ? `, ${d.f.rating}★` : ""}${d.f.watchlist ? ", watchlist" : ""}): search ${d.searchPick}${d.reason === "short-without-imdb" ? " (a short with no IMDb id)" : `, candidates ${d.candidates.join(" ")}`} → ${d.to ? `relinked to ${d.to.imdb} (letterboxd.com/film/${d.relink.slug})` : d.relink?.imdb ? `PENDING: your page names ${d.relink.imdb} (${d.relink.slug}) but TMDB has not given that film${process.env.OFFLINE ? " (offline: nothing asked)" : ""}` : "pending"}`;
  const counted = doubts.filter(({ f }) => f.rating != null || f.watchlist || f.liked);
  if (doubts.length) log(`     ${doubts.length} search hits refused (another film has that title and year, or a short with no IMDb id): ${doubts.filter((d) => d.to).length} relinked to the film your Letterboxd page names, ${pendingN} pending; ${counted.length} of them rated, liked or on the watchlist${counted.map((d) => `\n       ${said(d)}`).join("")}`);

  // What changed against the list Marco approved (lib/search-links-approved.json): said loudly, never a stop.
  const homonyms = doubts.map((d) => [d.f.title, d.f.year, d.reason, d.f.searchPick, d.relink?.imdb || null, d.to ? d.to.id : null]);
  const vs = againstApproved(homonyms, undefined, (id) => tmdb.peek(id)?.imdb || null);
  if (vs.entered.length + vs.left.length + vs.changed.length) log(`  ! HOMONYM CORRECTION differs from the list approved ${APPROVED.approvedOn}: ${[vs.entered.length ? `in: ${vs.entered.join("; ")}` : "", vs.left.length ? `out: ${vs.left.join("; ")}` : "", vs.changed.length ? `changed: ${vs.changed.join("; ")}` : ""].filter(Boolean).join(" · ")}`);
  else log(`     homonym correction: the ${homonyms.length} refused search hits approved ${APPROVED.approvedOn}, unchanged`);

  const seenIds = new Set(all.filter((f) => f.watched).flatMap((f) => [f.tmdbId, f.searchPick]).filter(Boolean));
  // Safety net beyond TMDB ids: same title within ±1 year counts as seen (Letterboxd and TMDB
  // sometimes disagree on a release year, e.g. festival vs theatrical).
  const seenTitles = new Map();
  for (const f of all.filter((x) => x.watched)) {
    const k = norm(f.title);
    if (!seenTitles.has(k)) seenTitles.set(k, []);
    seenTitles.get(k).push(f.year);
  }
  const titleSeen = (t, y) => (seenTitles.get(norm(t)) || []).some((sy) => !sy || !y || Math.abs(sy - y) <= 1);
  // IMDb ids of everything you have seen, through the Letterboxd records too: a film your export dates 2004 and TMDB 2011 is one film (lib/guard.js).
  const seenTts = seenImdbIds({ films: got ? got.view.films : {}, me: got ? got.view.me : new Set(), seenIds, titleSeen, imdbOfTmdb: (id) => tmdb.peek(id)?.imdb || null });
  for (const id of feedbackState.seen) seenTts.add(id);
  const isSeen = (m) => seenIds.has(m.id) || (m.imdb && seenTts.has(m.imdb)) || titleSeen(m.title, m.year) || (m.originalTitle && titleSeen(m.originalTitle, m.year));

  // 3 ── taste ─────────────────────────────────────────────────────────────
  log("3/6  Learning your taste…");
  const model = learn(all.filter((f) => f.film && f.rating != null).map((f) => ({ film: f.film, rating: f.rating, liked: f.liked })));
  const fp = fingerprint(model);
  log(`     ${model.count} ratings · your average ${fp.mean}★ · top directors: ${fp.directors.slice(0, 4).map((d) => `${d.label} ${d.avg}★`).join(", ")}`);

  // 4 ── candidates ────────────────────────────────────────────────────────
  log("4/6  Gathering films you haven't seen…");
  const pool = new Map();
  const add = (id, patch) => {
    if (!id || seenIds.has(id)) return;
    const c = pool.get(id) || { id, recCount: 0, seeds: [], seedIds: new Set(), pins: [], sources: new Set() };
    patch(c);
    pool.set(id, c);
  };

  for (const f of all) if (f.watchlist && f.tmdbId) add(f.tmdbId, (c) => { c.watchlist = true; c.watchlistedOn = f.watchlistedOn; if (livePos && livePos.has(f.key)) c.watchlistPos = livePos.get(f.key); c.film = f.film; c.sources.add("watchlist"); });

  // Recently loved films → the "Because you loved…" row
  const recentSeeds = [];
  const pushSeed = (f, rating, watchedDate) => {
    if (!f?.tmdbId || recentSeeds.some((s) => s.tmdbId === f.tmdbId) || recentSeeds.length >= 5) return;
    recentSeeds.push({ tmdbId: f.tmdbId, title: f.title, rating, watchedDate });
  };
  for (const d of diary) if (d.watchedDate >= daysAgo(cfg.build.recentLoveDays) && d.rating >= 4.5) pushSeed(films.get(d.key), d.rating, d.watchedDate);
  if (recentSeeds.length < 3)
    all.filter((f) => f.rating >= 5).sort((a, b) => (b.lastWatched || b.ratedOn || "").localeCompare(a.lastWatched || a.ratedOn || "")).forEach((f) => pushSeed(f, f.rating, f.lastWatched));

  // Everything you rated highly → TMDB recommendations
  const loved = all
    .filter((f) => f.tmdbId && f.rating != null && (f.rating >= 4.5 || (f.liked && f.rating >= 4)))
    .sort((a, b) => (b.lastWatched || b.ratedOn || "").localeCompare(a.lastWatched || a.ratedOn || ""));
  const seedFilms = [...recentSeeds.map((s) => all.find((f) => f.tmdbId === s.tmdbId)), ...loved]
    .filter(Boolean)
    .filter((f, i, arr) => arr.findIndex((x) => x.tmdbId === f.tmdbId) === i)
    .slice(0, cfg.build.seeds);
  await Promise.all(
    seedFilms.map(async (s) => {
      for (const r of (await tmdb.recommendations(s.tmdbId)) || [])
        add(r.id, (c) => {
          c.recCount++;
          c.va ??= r.va; c.vc ??= r.vc; c.date ??= r.date;
          c.seedIds.add(s.tmdbId);
          if (c.seeds.length < 3) c.seeds.push({ title: s.title, rating: s.rating });
          c.sources.add("rec");
        });
    })
  );

  // Pinned picks
  for (const m of LEGACY_CFG.moods) for (const imdb of m.pins || []) add(await tmdb.fromImdb(imdb), (c) => { c.pins.push(m.id); c.sources.add("pin"); });

  // Directors you trust → their filmographies
  const trusted = [...model.stats.values()].filter((s) => s.type === "director" && s.n >= 2 && s.w > 0.15).sort((a, b) => b.w - a.w).slice(0, cfg.build.directors);
  await Promise.all(
    trusted.map(async (s) => {
      for (const r of (await tmdb.directed(Number(s.key.slice(2)))) || [])
        add(r.id, (c) => { c.va ??= r.va; c.vc ??= r.vc; c.date ??= r.date; c.sources.add("director"); });
    })
  );

  // Unseen films of the curated lists (Marco, 11/10/2026): they join the candidates of the moods and the picker (source "list"), each
  // weighed by how much Marco agrees with its lists (lib/list-signal.js), and a film in a critic or director list is "vouched for".
  const overall = (() => { const r = all.filter((f) => f.rating != null); return r.length ? r.reduce((a, f) => a + f.rating, 0) / r.length : null; })();
  const ratingOf = LW.ratingByImdb(all, { films: got ? got.view.films : {}, me: got ? got.view.me : new Set() }); // by IMDb id on both sides, never a TMDB id nor a bare title (review S4-C)
  const sig = got && overall != null ? LW.signals({ lists: got.listsRead.lists, films: got.view.films, ratingOf, overall, subsets: listSubsets }) : LW.NONE;
  for (const w of sig.subsetWarnings || []) log(`  ! ${w}`);
  // The one floor exception (Marco, 11/10/2026, decision 5): a film in a critic or director list (above) OR loved by a favourite director
  // through a high or medium source (data/directors-loved.json) is vouched for, cv: 1, in this one index that every surface reads.
  const lovedCfg = { ...DL.DEFAULTS, ...(cfg.directorsLoved || {}) }, lovedData = DL.load(ROOT, lovedCfg);
  if (lovedData) { const problems = DL.validate(lovedData); if (problems.length) throw new Error(`${lovedCfg.file}: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ""}`); }
  const following = ((fcache || lbCache)?.following?.users || []).map(([user]) => user);
  if (lovedData && !process.env.OFFLINE) { // the TMDB record of every film on file that the cache lacks (runtime, poster, synopsis, who directed it); joined only when its IMDb id agrees
    const favNames = DL.favorites({ data: lovedData, stats: [...model.stats.values()], cfg: lovedCfg, following }).list.map((f) => f.name);
    const want = new Set(favNames.flatMap((n) => (lovedData.directors.find((d) => d.name === n)?.films || []).filter((x) => x.tmdbType === "movie" && !tmdb.peek(x.tmdb)).map((x) => x.tmdb)));
    await Promise.all([...want].map((id) => tmdb.movie(id)));
    tmdb.save();
  }
  // a favourite's love of their own film is not a vouch (Marco, 11/10/2026): who directed it is read from the TMDB record joined by IMDb id
  const lovedVouch = DL.vouched({ data: lovedData, stats: [...model.stats.values()], cfg: lovedCfg, following, peek: (id) => tmdb.peek(id) });
  // Marco, 22/10/2026 ~06:40 UTC: a film TMDB was asked about and has NO record of stays out of the rows until it has one (lib/tmdb.js noRecord; East of Eden 2026 was the one empty card of the Board). It is a
  // condition of the same rule, answered from the live cache, so every surface that asks the rule agrees; the lists and the friends' collections that the rule never governed keep the film (README, "Quality rule").
  const qualityRatings = Q.index(got?.view, { vouched: LW.vouched(sig), loved: lovedVouch, unrecorded: ({ imdbId, tmdbId }) => tmdb.noRecord(imdbId, tmdbId) });
  // the recommendation rule, by IMDb id. Marco, 13/10/2026: every Board row refills the place it opens, up to its cap, so the builders below take it and fill their rows from the films that pass it
  // (it used to be applied afterwards by Q.applyPlan, which shortened a row and left it short; Q.applyPlan still runs, as the net that finds nothing to remove)
  const eligibleTt = (tt) => Q.qualifies(qualityRatings.get(tt));
  // The TMDB movie of each unseen list film, joined by IMDb id (LW.joinTmdb): the TMDB id a Letterboxd page names counts only when that
  // movie's IMDb id is the page's (a series' TV id names another film: histoires-du-cinema → 206647 is Spectre); otherwise TMDB's /find,
  // cached a year (offline: the cache only); otherwise the film stays out.
  const listJoin = await LW.joinTmdb(sig, { movie: (id) => tmdb.movie(id), fromImdb: (tt) => tmdb.fromImdb(tt), skip: (tt) => seenTts.has(tt) });
  const sigByTmdb = new Map();
  for (const [tt, s] of sig.byTt) if (s.tmdb && !seenTts.has(tt) && !sigByTmdb.has(s.tmdb)) sigByTmdb.set(s.tmdb, s);
  for (const id of sigByTmdb.keys()) add(id, (c) => { c.sources.add("list"); });
  if (sig.lists.length) {
    const lw = sig.lists.slice().sort((a, b) => b.weight - a.weight);
    const fell = sig.lists.filter((l) => l.bands && l.bands.some((b) => b.fall));
    log(`     List agreement (your mean ${overall.toFixed(2)}★, ${LW.PRIOR} rated films of prior): ${sig.lists.filter((l) => l.weight > 0).length} of ${sig.lists.length} lists weigh something · strongest ${lw.slice(0, 4).map((l) => `${l.name.replace(/ \(.*\)$/, "")} ${l.weight.toFixed(2)} (${l.raw == null ? "-" : l.raw.toFixed(2)}★ ×${l.n})`).join(", ")}`);
    log(`     Position: ${sig.lists.filter((l) => l.bands).length} lists over ${LW.LONG} films measured by bands of ${LW.BAND}; weight falls with the position in ${fell.length ? fell.map((l) => `${l.name.replace(/ \(.*\)$/, "")} (${l.bands.filter((b) => b.fall).map((b) => `#${b.from}+ ${b.weight.toFixed(2)}`).join(", ")})`).join("; ") : "none"}`);
  }

  const recentIds = new Set(recentSeeds.map((s) => s.tmdbId));
  const prelim = (c) =>
    bayes(c.va ?? c.film?.va, c.vc ?? c.film?.vc) +
    0.5 * Math.log2(1 + c.recCount) +
    (c.watchlist ? 3 : 0) +
    (c.pins.length ? 20 : 0) +
    (c.sources.has("director") ? 0.6 : 0) +
    ([...c.seedIds].some((id) => recentIds.has(id)) ? 4 : 0); // keep "Because you loved…" well stocked
  // The TMDB-discovered candidates (watchlist, recommendations, pins, directors) are cut as before: the best cfg.build.pool.
  const discovered = [...pool.values()].filter((c) => c.watchlist || c.pins.length || c.recCount || c.sources.has("director"));
  let cands = discovered
    .filter((c) => c.watchlist || c.pins.length || (c.date && c.date <= today && (c.vc || 0) >= 40))
    .sort((a, b) => prelim(b) - prelim(a))
    .slice(0, cfg.build.pool);
  // The list films not already among them have their own cut, cfg.build.listPool, best agreement first: the curator chose them, so
  // no TMDB vote count is asked of them, only a release date that has come.
  const chosen = new Set(cands);
  const fromLists = [...pool.values()].filter((c) => c.sources.has("list") && !chosen.has(c));
  await Promise.all(fromLists.map(async (c) => { c.film ||= await tmdb.movie(c.id); }));
  // a list candidate whose TMDB record names another IMDb id than the list's film is not that film: out, and counted
  const listOther = fromLists.filter((c) => c.film?.imdb && !sig.byTt.has(c.film.imdb));
  const listOk = fromLists.filter((c) => c.film?.imdb && sig.byTt.has(c.film.imdb) && c.film.date && c.film.date <= today && !isSeen(c.film));
  const listPrelim = (c) => 2 * (sig.byTt.get(c.film.imdb)?.lw || 0) + 0.5 * (sig.byTt.get(c.film.imdb)?.cv ? 1 : 0) + bayes(c.film.va, c.film.vc);
  // Only the films the recommendation rule lets through (Q.qualifies, the rule every surface applies) compete for the listPool slots
  // (Marco, 11/10/2026). A list film the rule refuses can never be published by a generated surface, yet it ranks in the mood
  // selections before the rule removes it (one selection, no replacement: PRODUCT.md), taking the place of a film that can be
  // (measured: listPool 8,000 let in 1,779 refused films and the picker fell 1,020 → 994). So they are cut before the cap, not ordered
  // last (review S4-5, aba9247, did that). A film whose Letterboxd record is not read yet has no average: it follows the rule for "no
  // average", the entry it will get (vouched by a critic or director list, or by a favourite director's love, passes; any other waits).
  // That rule lives in Q.index (it marks cv on every vouched entry and makes one for a loved film) and is guarded by
  // test/vouched-no-average.test.js; the `cv: 1` below is a second guard that changes nothing today (11/10/2026: removing it survives
  // that test and every other, because every list film here has a Letterboxd record and so a Q.index entry — an equivalent mutation; re-measured 13/10/2026: the 792-test suite stays green without it).
  const listEntry = (c) => {
    const e = qualityRatings.get(c.film.imdb) || { lb: null, fr: null };
    return e.cv === 1 || !(sig.byTt.get(c.film.imdb)?.cv === 1 || lovedVouch.has(c.film.imdb)) ? e : { ...e, cv: 1 };
  };
  const cut = LW.cutList(listOk, { entryOf: listEntry, qualifies: Q.qualifies, prelim: listPrelim, cap: cfg.build.listPool });
  const listCut = cut.kept, listCutEligible = cut.eligible - cut.kept.length;
  cands = [...cands, ...listCut];
  await Promise.all(cands.map(async (c) => { c.film ||= await tmdb.movie(c.id); }));
  tmdb.save();
  cands = cands.filter((c) => c.film?.imdb && !isSeen(c.film) && c.film.date && c.film.date <= today && (c.watchlist || c.pins.length || c.sources.has("list") || c.film.vc >= 25));
  // Letterboxd's own facts about each candidate, by IMDb id: the year the index shows, the average and how many ratings it rests on. The v2 Board's `where` reads them (decades, "Hidden gems");
  // the legacy rows never do. A film Letterboxd has not shown has none of the three.
  const lbOf = new Map();
  for (const r of Object.values(lbFilms || {})) {
    if (!r || r.gone || !r.imdbId) continue;
    const prev = lbOf.get(r.imdbId);
    if (!prev || (prev.r == null && r.r != null)) lbOf.set(r.imdbId, r);
  }
  for (const c of cands) {
    const l = lbOf.get(c.film.imdb);
    if (l) { c.lbYear = l.year || null; if (l.r != null) { c.lb = l.r; if (l.rn != null) c.lbCount = l.rn; } }
  }
  for (const c of cands) {
    const s = sig.byTt.get(c.film.imdb); // by IMDb id only: a TMDB id is a claim until its record agrees
    if (s?.lw) c.lw = s.lw;
    if (s) c.lists = s.lists.map((x) => x.id); // the lists it is in, by IMDb id: a list may be a mood's signal (lib/moods.js)
    if (s?.cv === 1 || lovedVouch.has(c.film.imdb)) c.cv = 1; // the same light push for both halves of the exception
  }
  log(`     ${pool.size} discovered → ${cands.length} unseen candidates (${cands.filter((c) => c.watchlist).length} from your watchlist)`);
  if (sig.lists.length) log(`     From the lists: ${sigByTmdb.size} films with a TMDB id (unseen) · ${fromLists.length} not already a candidate → ${listOk.length} released and unseen → ${cut.refused} refused by the recommendation rule left out → ${cut.eligible} eligible → ${listCut.length} kept (cfg.build.listPool ${cfg.build.listPool ?? 0}; the cut left out ${listCutEligible} eligible) · candidates in a list: ${cands.filter((c) => c.sources.has("list")).length}, vouched (a critic or director list, or a favourite director's love): ${cands.filter((c) => c.cv).length}, of them only by a director's love ${cands.filter((c) => c.cv && !sig.byTt.get(c.film.imdb)?.cv).length}`);
  if (sig.lists.length) log(`     List films joined to TMDB by IMDb id: ${listJoin.confirmed} by the TMDB id Letterboxd names, ${listJoin.viaFind} by TMDB's /find, ${listJoin.missing} left out (no TMDB movie for the IMDb id)${listJoin.refused ? ` · ${listJoin.refused} named a TMDB id that is another film, so /find was asked: ${listJoin.refusedFound} found, ${listJoin.refused - listJoin.refusedFound} among the left out` : ""}${listOther.length ? ` · ${listOther.length} TMDB records naming another IMDb id left out` : ""}`);

  // 5 ── score ─────────────────────────────────────────────────────────────
  log("5/6  Scoring every candidate against every mood…");
  for (const c of cands) {
    const t = score(c.film, model);
    c.taste = t.score;
    c.contributions = t.contributions;
    c.quality = bayes(c.film.va, c.film.vc);
  }
  zscore(cands, (c) => c.taste, (c, v) => (c.tasteZ = v));
  zscore(cands, (c) => c.quality, (c, v) => (c.qualityZ = v));
  // config.json exclude.films (Marco, 13/10/2026): the film leaves the pool here, before any ranking, so every row refills with the next film. After the
  // z-scores, not before: they are measured on the whole pool, and taking a film out earlier would move every other film's score by a hair.
  const candsWithExcluded = cands; // the v2 watchlist takes its 100 from these: a film exclude.films removes leaves a gap (the rule of 10/10), the next one does not move up
  cands = cands.filter((c) => !excluded.has(c.film.imdb));

  // Worth watching again (Old friends): the films he rated at least build.rewatchMinStars (Marco, 14/11/2026, "Include 4 stars": 4; it was 4.5) and has not logged in build.rewatchAfterDays
  const REWATCH_MIN = rewatchMinStars(cfg);
  const rewatch = all
    .filter((f) => f.film?.imdb && !excluded.has(f.film.imdb) && f.rating >= REWATCH_MIN)
    .map((f) => ({ film: f.film, rating: f.rating, liked: f.liked, lastSeen: f.lastWatched || f.ratedOn }))
    .filter((r) => !r.lastSeen || r.lastSeen < daysAgo(cfg.build.rewatchAfterDays));

  const allMoods = compile([...cfg.moods, ...(BOARD ? BOARD.moods : [])], cfg.lists); // every mood of config.json and of the board: the v2 Moods menu
  // a mood of the board may weigh lists (`lists`: { <list id>: weight }); one that config.json "lists" does not read carries no film, so it weighs nothing: say so, once, naming them
  for (const m of BOARD ? BOARD.moods : []) {
    const unread = Object.keys(m.lists || {}).filter((id) => !(cfg.lists || []).some((l) => l.id === id));
    if (unread.length) log(`  ! mood ${m.id} weighs ${unread.length} list(s) config.json does not read yet (${unread.join(", ")}): they add nothing until they are in "lists"`);
  }
  const moods = BOARD ? allMoods.filter((m) => BOARD.legacyMoods.includes(m.id)) : allMoods; // the legacy family: ranking, repetition ceiling, Tonight and the picker see these alone
  // The music rule for EVERY row that recommends (Marco, 22/10/2026 ~03:50 UTC for New for you, ~06:40 UTC for all of them: "extend rule D to all the rows of the Board and to the cuts by country and decade"): a music film
  // (lib/pool.js isMusicFilm) he has not seen enters a recommendation row only with evidence from his own Letterboxd (a director or artist he rates, his watchlist, a critics' or directors' list). ONE gate, asked by
  // IMDb id, handed to the builders as `recommendable` (the recommendation rule above, plus this): the rows refill the places it opens, like every other rule. The rows that show what a source HOLDS do not ask it: your watchlist,
  // Friends want to see this too, the prize row, the single-list rows (Criterion, Sight & Sound, Letterboxd 250), Loved by your directors, Lists, Lists (unseen) and Friends in Discover. Friends watched this week and this month DO ask it (review, 22/10/2026).
  // The Worker reads the same verdict from the index: `musicOut` below (bit 8 of the flags) for its Moods, Explore and the profiles' Tonight, Under 100 min and themes (README, "The music rule"). One exception (Marco, 22/10/2026 ~15:15 UTC): the Moods option of the mood Music, below. Off in a person's build (lib/people.js deriveConfig does not copy `music`).
  const music = P.musicGate({
    options: P.musicOptions(cfg), seen: (tt) => seenTts.has(tt),
    recOf: P.musicRecords({ films: lbFilms || {}, lists: got ? got.listsRead.lists : [], watchlistSlugs: mine.watchlist, cands: candsWithExcluded, peek: (id) => tmdb.peek(id), model }), // the film's own TMDB record, its lists, its watchlist: lib/pool.js musicRecords
  });
  const recommendable = (tt) => eligibleTt(tt) && music.ok(tt);
  // Marco, 22/10/2026 ~15:15 UTC ("Music 1 of 4", config.json music.exemptMoods): the mood named Music is exempt from the music rule in its OWN option of the Moods menu ("the only place where I ask for music when I open the app"): `menu` holds that list,
  // asked the quality rule alone. The Board's row of the same mood, Tonight, the v2 Board and everything else keep `recommendable`. The Worker gets the same exemption from the index (`rules.musicExemptMoods`, below).
  const musicExempt = [...P.musicOptions(cfg).exemptMoods];
  // Tonight's memory (lib/tonight-memory.js; Marco, 14/11/2026, "Bigger pool + 30 days without repeating"): the films that were in Tonight in the last tonight.noRepeatDays days are read HERE, before the row is drawn,
  // and handed to buildRows, which does not draw them. The file is written after the publication (tonightStep.remember, below, next to the front memory's), by a build that publishes (TONIGHT_MEMORY_WRITE=1).
  // A person's build (cfg.personContext) files its row under its revision and counts only the rows of revisions it is told were published (TONIGHT_PUBLISHED_REVISIONS); Marco's has no such state.
  const tonightPerson = cfg.personContext ? { revision: cfg.personContext.revision, published: require("./lib/tonight-memory").revisionsOf(process.env.TONIGHT_PUBLISHED_REVISIONS) } : null;
  const tonightStep = require("./lib/tonight-memory").runInBuild({ noRepeatDays: TONIGHT.noRepeatDays, today, cacheDir: CACHE_DIR, log, person: tonightPerson });
  const { rows, ranked, menu: moodMenuRows, tonightRelief } = buildRows({ pool: cands, rewatch, moods, cfg, model, recentSeeds, today, eligible: recommendable, tonightShown: tonightStep.shown, exempt: music.on && musicExempt.length ? { moods: new Set(musicExempt), eligible: eligibleTt } : null });
  {
    const deeper = tonightRelief.filter((r) => r.kind === "deeper"), moved = tonightRelief.filter((r) => r.kind === "moved"), repeat = tonightRelief.filter((r) => r.kind === "repeat"), say = (list) => list.map((r) => `${r.id} (${r.mood})`).join(", ");
    log(`     Tonight: ${rows.tonight.length} of ${cfg.sizes.tonight} films, drawn from the top ${TONIGHT.depth} of each mood, ${tonightStep.shown.size} held back by the memory${deeper.length ? ` · ${deeper.length} taken from below the top ${TONIGHT.depth} because every film above was shown in the last ${TONIGHT.noRepeatDays} days: ${say(deeper)}` : ""}`);
    if (moved.length) log(`  ! Tonight: ${moved.length} mood${moved.length === 1 ? " has" : "s have"} no film tonight, because every film of the mood that passes the rule was in Tonight in the last ${TONIGHT.noRepeatDays} days; the place went to a free film of another mood: ${moved.map((r) => `${r.from} -> ${r.id} (${r.mood})`).join(", ")}`);
    if (repeat.length) log(`  ! Tonight: ${repeat.length} film${repeat.length === 1 ? "" : "s"} shown again inside ${TONIGHT.noRepeatDays} days, because no mood has a film left that was not in Tonight in that time (the one shown longest ago comes back): ${say(repeat)}`);
  }
  // the rows only the v2 Board has (lib/board-rows.js): the moods outside board.legacyMoods ranked over the candidates, filters, combined rows, the watchlist by date added. The legacy rows above are untouched by it.
  const ratedByMarco = all.filter((f) => f.film && f.rating != null).map((f) => ({ film: f.film, rating: f.rating }));
  const v2 = BOARD ? BR.buildBoardRows({
    cands, watchlistCands: candsWithExcluded.filter((c) => c.watchlist), moods: allMoods, legacy: new Set(BOARD.legacyMoods), ranked, spec: BOARD, cfg, today,
    eligible: recommendable, rated: ratedByMarco, listsOf: (tt) => (sig.byTt.get(tt)?.lists || []).map((x) => x.id), liveWatchlist: live.ok,
  }) : null;

  // 5b ── sources: lists, friends, the people you follow, the pool and everything cut from it ──────
  const none = {
    friends: { rows: {}, meta: [], stats: {}, perFriend: [], seenSlugs: new Set() }, extra: { fromlists: [], short: [], newforyou: [], "friends-week": [] }, listCats: [], cuts: null, week: null,
    recs: [], view: { users: [], films: {} }, lists: [], friendsFull: { rows: {}, meta: [] }, friendsAllLoved: [], isSeen: () => false, detail: () => null,
  };
  const src = got ? await runSources({ tmdb, all, seenIds, seenTts, titleSeen, model, cands, live, got }) : none;
  if (src === none) log("     Sources: skipped");
  const byDirectors = await lovedStep({ data: lovedData, lc: lovedCfg, model, seenIds, seenTts, titleSeen, seenSlugs: src.friends.seenSlugs, following });

  // 5c ── the plan, and the guarantee: nothing you've seen appears outside the exempt catalogs, and nothing without an
  // IMDb id appears at all. It reads EVERY Board row and EVERY Discover file in the plan. If it ever trips, the build
  // fails loudly instead of publishing — yesterday's rows stay up until it's fixed.
  const withFriends = !SKIP_FRIENDS && !!cfg.friends?.length;
  const special = SPECIAL.length ? await specialStep({ src, cands, all, model, qualityRatings, got, fcache, tmdb }) : null;
  if (music.on) { // config.json music.needsEvidence: how many music films the rule refused when a row asked (a film asked by several rows counts once; not all of them would have been in a published row), and a few of them
    const out = [...music.refused.values()].map((r) => r.title).sort();
    if (!got) log("  ! Music rule: the sources are off (--skip-friends), so no list is read: a film that only a critics' or directors' list vouches for has no evidence tonight and is refused");
    log(`     Music rule: ${out.length} music film(s) refused when a row asked (not seen by you, and no evidence from your Letterboxd: a director or artist you rate, your watchlist, or a critics'/directors' list)${out.length ? `, e.g. ${out.slice(0, 4).join(" · ")}` : ""}`);
  }
  // the rows only the v2 Board has: lib/board-rows.js's (moods, filters, combined rows) and lib/special-rows.js's, side by side. Their ids cannot meet (lib/board.js refuses a recipe with the id of a legacy row, a mood, the series row or a special row), and if they did the build stops.
  const rows2 = { ...(v2 ? v2.rows : {}) };
  for (const [id, items] of Object.entries(special ? special.rows : {})) { if (id in rows2) throw new Error(`special row "${id}" is also a row of lib/board-rows.js`); rows2[id] = items; }
  const plan = buildPlan({
    moods, rows, extra: { ...src.extra, "directors-loved": byDirectors.row }, friendOut: src.friends, lists: src.listCats, cuts: src.cuts, today, sizes: cfg.sizes,
    rowNames: { "friends-love": cfg.friendRows?.love?.name }, withFriends, directorMenu: byDirectors.menu, board: BOARD, rows2, menuRows: moodMenuRows, allMoodIds: allMoods.map((m) => m.id), // every mood of config.json: the v2 rows that are moods say "Mood:" (lib/plan.js)
  });
  const beforeNet = new Map(boardRows(plan).map((r) => [r, r.items.length]));
  const beforeCuts = plan.discover.map((c) => [c.id, c.options.reduce((a, o) => a + o.items.length, 0)]);
  Q.applyPlan(plan, qualityRatings);
  // The net found nothing to remove from the Board rows: since 13/10/2026 every builder fills its row from the films that pass the rule. A row listed here has a builder that does not ask for it.
  const netRemoved = [...beforeNet].filter(([r, n]) => r.items.length < n).map(([r, n]) => ({ id: plan.board2 && plan.board2.includes(r) ? `${r.id}/v2` : r.id, n: n - r.items.length }));
  log(`     Quality net on the Board rows: ${netRemoved.reduce((a, x) => a + x.n, 0)} film(s) removed${netRemoved.length ? ` (!) from ${netRemoved.map((x) => `${x.id} ${x.n}`).join(", ")}` : ""} (0 expected: the builders ask for the rule themselves)`);
  // The Discover cuts are not refilled by their builders: the net shortens them, by the 3.5 floor and (22/10/2026) by the TMDB record condition. The line says by how many cards, catalog by catalog (the exempt collections stay at 0).
  const cutsRemoved = plan.discover.map((c, i) => [c.id, beforeCuts[i][1] - c.options.reduce((a, o) => a + o.items.length, 0)]).filter(([, n]) => n > 0);
  log(`     Quality net on the Discover cuts: ${cutsRemoved.reduce((a, [, n]) => a + n, 0)} film(s) removed${cutsRemoved.length ? ` (${cutsRemoved.map(([id, n]) => `${id} ${n}`).join(", ")})` : ""} (they shorten without refill)`);
  // the films the record condition alone keeps out: they pass the 3.5 rule (or the exception) and TMDB was asked and has nothing; counted at the end of the night, when the cache holds what this run fetched
  const keptOut = Q.refusedForRecord(qualityRatings);
  const titleOf = new Map(Object.values(got?.view?.films || {}).filter((f) => f.imdbId && f.title).map((f) => [f.imdbId, f.title]));
  const keptNames = keptOut.map((tt) => titleOf.get(tt) || tt).sort((a, b) => a.localeCompare(b));
  log(`     ${keptOut.length} films without a TMDB record kept out of the rows (${keptNames.slice(0, 3).join(", ")}${keptNames.length > 3 ? ` and ${keptNames.length - 3} more` : ""}); they stay in the lists, the friends' collections and the index, and come back when TMDB has a record`);
  EX.applyToPlan(plan, excluded); // the Board rows that do not come from the pool (short, newforyou, directors-loved, friends-week …) and the two recommending Discover catalogs lose it here: that row is one film shorter
  const permitted = (it, moodId, kind = "new") => LF.eligible(feedbackState, it.id, { moodId, kind });
  if (feedbackState.active.some(e=>LF.EFFECTS.includes(e.type))) for (const row of plan.board2 ? [...plan.board, ...plan.board2] : plan.board) row.items = row.items.filter(it => row.id === "tonight" ?
    permitted(it, null) && moods.some(m => permitted(it,m.id) && ranked[m.id]?.some(c=>c.film.imdb===it.id)) : permitted(it, moods.some(m=>m.id===row.id)?row.id:null, row.id === "oldfriends" ? "rewatch" : "new"));
  for (const catalog of plan.discover) if (!["mood-engine-lists", "mood-engine-lists-unseen", "mood-engine-friends"].includes(catalog.id)) for (const option of catalog.options) {
    const moodId = catalog.id === "mood-engine" ? moods.find(m=>m.word===option.label)?.id || null : null;
    option.items = option.items.filter(it => permitted(it,moodId));
  }
  const planted = SELF_TEST ? plantSeenFilm(plan, all, { seenSlugs: src.friends.seenSlugs, seenTts }) : null; // self-test: same guard, same call, films you watched slipped into the plan
  const flat = guardRows(plan);
  const leaks = findLeaks(flat, { seenIds, seenTts, titleSeen, seenSlugs: src.friends.seenSlugs });
  if (planted) finishSelfTest(leaks, planted);
  if (leaks.length) throw new Error(`Seen films leaked into rows: ${leaks.slice(0, 5).join(", ")}`);

  // The Discover menus are fixed when the addon is installed: say so when tonight's differ from the last build's, and remember them.
  if (!CACHE_ONLY && !SKIP_FRIENDS) {
    const lf = path.join(CACHE_DIR, "lists.json"), lc = L.loadListsCache(lf), menus = menusOf(plan);
    for (const c of menuChanges(lc.menus, menus)) log(`  ! menu ${c.id} changed (added: ${c.added.join(", ") || "none"}; dropped: ${c.dropped.join(", ") || "none"}) — an installed addon keeps the old menu until it is reinstalled`);
    lc.menus = menus;
    L.saveListsCache(lf, lc);
  }

  // 5d ── the numbers every film carries (Letterboxd average, your people's average and counts, IMDb), then the covers that show them
  const crowdFind = got ? crowdIndex({ crowd: got.view.crowd, films: got.view.films }) : null;
  const rated = attachRatings(plan, { find: crowdFind ? crowdFind.find : () => ({ seenBy: 0, friendsAvg: null, wantBy: 0 }), lb: got ? letterboxdAverages(got.view.films) : new Map() });
  log(`     Numbers: ${rated.films} distinct films in the files · ${rated.withLb} with a Letterboxd average · ${rated.withCrowd} seen or wanted by someone you follow${crowdFind ? ` (of ${crowdFind.people} people)` : ""}`);
  const imdbAll = new Map(); // IMDb rating of every film the index will carry, not only those of the files (filled by imdbStep)
  // the facts of the country of every film, for the flag on its cover (lib/countries.js attachCountries): the flag is the flag of the film's MAIN country, the same as the card and the region (Marco,
  // 23/10/2026), so it needs what mainCountry reads (production countries, language, TMDB's origin, the directors); the rule of v2.3 (the original language first, then which production country speaks
  // it) answers for a film TMDB does not know, which gets its first production or Letterboxd country
  const lbByTt = new Map();
  for (const r of Object.values(got ? got.view.films : {})) if (r && r.imdbId && (!lbByTt.has(r.imdbId) || (!lbByTt.get(r.imdbId).c?.length && r.c?.length))) lbByTt.set(r.imdbId, r);
  const tmdbRecords = (t) => CF.ownRecords([...t.items.map((i) => i.tmdb), lbByTt.get(t.tt)?.tmdbId], (id) => tmdb.peek(id), t.tt);
  const countries = {
    tmdbCountries: (t) => CO.tmdbFacts(tmdbRecords(t)).countries,
    lbCountries: (t) => lbByTt.get(t.tt)?.c || [],
    language: (t) => CO.tmdbFacts(tmdbRecords(t)).language,
    tmdbOrigin: (t) => CO.tmdbMain(tmdbRecords(t)).origin, // the main country of the cover's flag (Marco, 23/10/2026): TMDB's origin and the directors of the same record
    directors: (t) => CO.tmdbMain(tmdbRecords(t)).directors,
  };
  await imdbStep({ plan, imdbAll, extraTts: [...(src.recs || []).map(r => r.id), ...cands.map(c => c.film.imdb)] });
  const linkedCoverFacts = new Map();
  // The mood each film fits best, over EVERY mood of config.json (30 today): the lead of line 2 of the description in a row that is no mood (Marco, 21/10/2026 ~15:00 UTC, D3; lib/best-mood.js). ONE calculation, two maps that differ in the NAME only
  // (Marco, 21/10/2026 ~22:15 UTC): the legacy family and the static files write the mood's `name` (the legacy Board names its mood rows so); the v2 family writes the name of the mood's row in its Board (config.json board.names) when the Board has one.
  // Over `cfg.moods` only, like the words (`descMoods: cfg.moods`): a mood that only board.moods defines (a rehearsal board, test/fixtures/board-v2-pr2.json) is no mood of config.json and must not move a legacy file (test/legacy-parity.test.js, PR2).
  // The three direct Discover collections are exempt from the private feedback (Marco, 11/10/2026, PRODUCT.md: "every direct Lists/Lists unseen/Friends collection is exempt from recommendation feedback"; test/review-fixes.test.js
  // "full build VM preserves direct catalogs"), and the label is part of their cards: they take the label of the film WITHOUT the private feedback (`open`), so a film marked "Not for me" or "wrong mood" (private feedback, which acts through `permits`)
  // keeps the "Mood:" lead it has without the feedback, in these three collections only. A SEEN film still has no label there: it leaves `ranked` by another mechanism, not by `permits` (test/learning-integration.test.js, commit f93f5a9;
  // PRODUCT.md D3, 21/10: a film that fits no mood, one he has already seen, has no label). Every other row and the index keep asking the feedback (D3, 21/10/2026). Root suite of 22/10/2026: the cards of these collections lost `fitMood` (e.g. "Growing up", "Adrenaline") once a film was marked.
  // 22/10/2026, effect measured by the reviewer in two offline builds (code 27bea78 against 874bda1, with one private "wrong mood" and one private "Not for me"): "Daughters of Darkness", marked `wrong mood: wicked`, now
  // shows "Mood: Something wicked" in 12 files of the direct collections; before it had no label. The choice follows the rule written on 11/10 (direct collections exempt from the feedback) and is DECIDED: Marco, 22/10/2026 ~15:35 UTC (questionnaire): "coleção isenta é isenta, rótulo incluso" (
  // risk he accepted: in a build with the private folder, a film marked "wrong mood" shows the mood he said did not fit, in the three collections; the Board and the index follow the feedback). The nightly build passes no --private-dir, so it reads no feedback whatever the learning mode (the mode alone decides nothing here); the effect only appears in a build with a private folder (the person's build / Will).
  const bestOf = (rowNames, { open = false } = {}) => bestMoods({ moods: allMoods.filter((m) => cfg.moods.some((c) => c.id === m.id)), ranked: { ...ranked, ...(v2 ? v2.ranked : {}) }, permits: open ? () => true : (tt, moodId) => LF.eligible(feedbackState, tt, { moodId, kind: "new" }), rowNames });
  const bestMood = bestOf({});
  const bestMoodDirect = bestOf({}, { open: true }), DIRECT_COLLECTIONS = new Set(["mood-engine-lists", "mood-engine-lists-unseen", "mood-engine-friends"]);
  const bestMood2 = BOARD ? bestOf(Object.fromEntries(BOARD.entries.map((e) => [e.id, e.name]))) : bestMood;
  const indexArgs = {
    ...(personOptions ? { builtAt: capturedAt } : {}),
    cfg, today, coverFacts: linkedCoverFacts, plan, moods, ranked, cands, recs: src.recs, view: src.view, lists: src.lists, friendsFull: src.friendsFull, isSeen: src.isSeen, detail: src.detail, detailOfImdb: (tt) => { const id = tmdb.cache.find[tt]?.v; return id ? tmdb.peek(id) : null; }, seenTts, descMoods: cfg.moods, bestMood, // the words of the descriptions of BOTH families come from EVERY mood of config.json (Marco, 21/10/2026, 01:35 UTC: 6,630 of the 10,034 TMDB records with keywords have a word against 5,143 with the nine legacy moods: records, not cards); test/legacy-parity.test.js allows the legacy files to differ from the reduced build in the word group of line 2 of the card (the last group, one group) and in the best-fit `Mood:` label of a line that is not in a mood row (D3, 21/10/2026; a mood of config.json, with its genre group), and in nothing else
    crowd: crowdFind ? crowdFind.find : null, imdb: imdbAll, numbers: rated.byTt, quality: { eligible: (tt) => Q.qualifies(qualityRatings.get(tt)), minStars: Q.MIN_STARS }, musicOut: (tt) => !music.ok(tt), musicExemptMoods: music.on ? musicExempt : [], permits: (tt, moodId) => LF.eligible(feedbackState, tt, { moodId, kind: "new" }), separator: DESCRIPTION_SEPARATOR ?? cfg.descriptionSeparator ?? "\n\n",
  };
  const index = buildIndex(indexArgs); // the legacy family: exactly the call of every night so far
  if (music.on) log(`     Music rule in the index: ${index.films.filter((f) => f.musicOut).length} film(s) carry the held-back bit (flag 8): the Worker's Moods, Explore, their menus and the profiles' Tonight, Under 100 min and themes do not recommend them; Search and the collections still show them`);
  // The v2 family (config.json "board"): the same facts, from plan.board2, with the Moods menu and the country menu of the board. The cover facts were collected by the call above.
  const menu2 = BOARD && BD.menuFor(BOARD, allMoods);
  const linkedCoverFacts2 = new Map();
  // The front shuffle of the v2 Board (lib/front-shuffle.js; Marco, 14/10/2026). It sits HERE on purpose: the quality net, exclude.films, the seen-film guard, the numbers, the IMDb step and the legacy index above
  // have all been calculated on the strict order, and nothing that is not a row's own order reads plan.board2 after this line except the v2 index that follows: its `rows[id]` and `rowDesc[id]` are made
  // from row.items, so the reason lines follow the films, not the positions. Only plan.board2 is reordered; plan.board (the legacy family, the profiles, the 3.1.0 Worker) is never touched. Without board.shuffle
  // the log still measures the strict fronts: the positive control of the measurement. The memory file is read here and written after the publication (rememberFront, below).
  const frontStep = BOARD ? require("./lib/front-shuffle").runInBuild({ plan, today, shuffle: BOARD.shuffle, cacheDir: CACHE_DIR, log }) : null;
  const discoverRecords = DISCOVER_SPEC ? new Map() : null; // tt → the film's own TMDB record, as the index used it: the regions and eras of the Discover are worked out from it
  const pageFacts = cfg.personContext ? null : new Map();
  const index2 = BOARD ? buildIndex({ ...indexArgs, bestMood: bestMood2, cfg: { ...cfg, moods: [...cfg.moods, ...BOARD.moods] }, ranked: { ...ranked, ...v2.ranked }, coverFacts: linkedCoverFacts2, plan: { board: plan.board2, discover: plan.discover }, moods: menu2.moods, v2: { menu: menu2.menu, countries: BOARD.countries }, records: discoverRecords, pageFacts }) : null;
  // A build that read no lists at all (--skip-friends: no friends, no lists, no crowd) has no list to point the Discover's list options at: it writes no `discover`, as it writes no Board. A build that read SOME of them
  // and not all stops in the validation of the index, naming the list ("names the list …, which the index does not declare"): the nightly then does not publish, which is what a missing list deserves.
  if (index2 && DISCOVER_SPEC && !index2.lists.length) log("     Discover: left out of this build, which read no lists (--skip-friends); the v2 index carries no discover");
  else if (index2 && DISCOVER_SPEC) index2.discover = DC.build({ spec: DISCOVER_SPEC, index: index2, recordOf: (tt) => discoverRecords.get(tt) || null, log: (line) => log(line), minFeatureMinutes: P.minFeatureMinutes(cfg) });
  else if (index2) log("     Discover: no data/discover-catalogs.json — the v2 index carries no discover");
  // "All friends loved" goes into the Friends menu of BOTH indices, after the "Top" options and before the "Watch together" ones (Marco, 28/10/2026): the films of the index that someone of the crowd rated at the bar, unseen, in the
  // index's order and then spread over the directors (the Discover's own spread, or its default without data/discover-catalogs.json). An index with no friends options (a person's build, --skip-friends) gets none.
  if (cfg.friendRows?.all?.word) {
    const FO = require("./lib/friends-option"), tops = src.friendsFull.meta.filter((m) => m.kind === "top").map((m) => m.word);
    for (const [name, ix] of [["index", index], ["index v2", index2]]) {
      if (!ix) continue;
      const added = FO.addFriendsOption(ix, { label: cfg.friendRows.all.word, tts: src.friendsAllLoved, at: FO.positionAfterTops(ix.friends.options, tops), spreadSpec: DISCOVER_SPEC ? DISCOVER_SPEC.spread : FO.DEFAULT_SPREAD });
      if (added) log(`     Friends option "${added.label}" (${name}): ${added.total} unseen films of the index loved by someone of the crowd, at position ${added.at + 1} of ${ix.friends.options.length}`);
    }
  }
  // one year per film in every surface (Marco, 13/10/2026): the index's, which is the cover's. The plan's items carry the year their own builder gave them (TMDB first).
  const years = yearsByTt(index);
  for (const { item } of planItems(plan)) if (years.has(item.id)) item.year = years.get(item.id);
  // and one first line: director, country and duration too (the live addon builds it from the index's entries; an item of another film's TMDB record had that film's)
  const facts1 = factsByTt(index);
  // The description's mood words: ONE list for both families (buildIndex's `descMoods` = every mood of config.json, 30 today; the legacy `keywords` column keeps the nine legacy moods' words, for the search), so the static
  // files and the `desc` of either index, which the Worker reads, say the same words (Marco, 20/10/2026, review finding 1: 36.5% of the films had other words in the two families).
  // The row's pick of three happens when the line is written (lib/describe.js moodLine).
  const wordsOf = (tt) => index.descWords.get(tt) || (index2 && index2.descWords.get(tt)) || [];
  for (const { item, v2: inBoard2, where } of planItems(plan)) {
    item.fitMood = (inBoard2 ? bestMood2 : DIRECT_COLLECTIONS.has(where) ? bestMoodDirect : bestMood).get(item.id); // the mood the film fits best (undefined for a film that fits no mood): the lead of line 2 where the row is no mood (lib/describe.js moodLine); no effect on a v2 item: lib/index-export.js writes fitMood again on its own copy (withWords) from the index's map, which is bestMood2; kept so the plan items of both families carry the same field
    const f = facts1.get(item.id);
    if (!f) continue;
    if (f.directors) item.directors = f.directors;
    if (f.runtime) item.runtime = f.runtime;
    item.keywords = wordsOf(item.id);
    if (f.country) item.countries = [f.country, ...(item.countries || []).filter((c) => c !== f.country)];
  }
  const CF = require("./lib/cover-facts");
  // the covers are drawn for the legacy index and for the films only the v2 index has; where both know a film, the legacy facts win
  const coverIndex = withV2Films(index, index2);
  const coverFacts = CF.fallback(coverIndex, new Map([...linkedCoverFacts2, ...linkedCoverFacts]), tmdb.cache.movie, require('./lib/cover-supplement').read());
  const covers = await coverStep({ plan, index: coverIndex, coverFacts, countries: CF.countries(coverFacts, countries), watchlistIds: PO.watchlistIds(cands, src.recs || []) });
  // 20/10/2026 (Stremio BACKLOG item 13): the HTTP answer behind "FAILED: n download", by code with the ids, in the log and (a real night only) in the run's summary page.
  // Called here and not inside coverStep: test/will-recovery-blockers.test.js runs coverStep alone in a context that has only the names it hands over.
  if (covers) PO.reportFailures({ failures: covers.failures, today, log, cacheOnly: CACHE_ONLY });
  if (covers) for (const e of index.films) if (covers.tts.has(e.tt)) e.poster = PO.posterUrl(cfg.posters?.base, e.tt, covers.versions?.get(e.tt));
  if (covers && index2) for (const e of index2.films) if (covers.tts.has(e.tt)) e.poster = PO.posterUrl(cfg.posters?.base, e.tt, covers.versions?.get(e.tt));


  // 6 ── publish ───────────────────────────────────────────────────────────
  log("6/6  Publishing addon + mood picker…");
  const webData = buildWebData({ cands, ranked, rows, rewatch, moods, model, fp, all, today, listsOf: (tt) => (sig.byTt.get(tt)?.lists || []).map((x) => x.id) });
  const friendMeta = [...src.friends.meta, ...(src.extra["friends-week"]?.length ? [{ id: "friends-week", name: "👥 Friends watched this week", kind: "week" }] : [])];
  const friendItems = { ...src.friends.rows, "friends-week": src.extra["friends-week"] };
  webData.friends = {
    rows: friendMeta.map((m) => ({ ...m, items: friendItems[m.id].slice(0, cfg.sizes.friends ?? cfg.sizes.row).map((x) => ({ i: x.id, n: x.title, y: showYear(years, x.id, x.year), w: x.why[0] || "" })) })),
    people: src.friends.perFriend.map(({ name, read, rated, withTt, watchlist }) => ({ name, read, rated, withTt, watchlist })),
  };
  webData.lists = src.listCats.map((l) => ({ id: l.id, name: l.name, total: l.all.length, unseen: l.unseen.length, items: l.unseen.slice(0, 24).map((x) => ({ i: x.id, n: x.title, y: showYear(years, x.id, x.year), w: x.why[0] || "" })) }));
  for (const x of [...webData.films, ...webData.rewatch]) x.y = showYear(years, x.i, x.y); // the picker's own rows too (candidates carry TMDB's year)
  Q.applyWeb(webData, qualityRatings);
  if (music.on) { // the mood picker of the web page recommends: the music rule holds there too (README, "The music rule")
    const before = webData.films.length;
    webData.films = webData.films.filter((x) => music.ok(x.i));
    const kept = new Set(webData.films.map((x) => x.t));
    webData.tonight = webData.tonight.filter((id) => kept.has(id));
    log(`     Music rule in the web picker: ${before - webData.films.length} film(s) of the ${before} left out`);
  }
  { // Marco, 15/11/2026 (questionnaire, shorts: "Only where you or a source put them"): the mood picker of the web page recommends, so no short is in it (its rewatch films are his own and keep theirs)
    const before = webData.films.length;
    webData.films = P.dropShortPicks(webData.films, P.minFeatureMinutes(cfg));
    const kept = new Set(webData.films.map((x) => x.t));
    webData.tonight = webData.tonight.filter((id) => kept.has(id));
    log(`     Shorts in the web picker: ${before - webData.films.length} film(s) under ${P.minFeatureMinutes(cfg)} min of the ${before} left out`);
  }
  { // the acceptance of Fatia A: how many films are there only through the floor exception, surface by surface (distinct films)
    const editorial = new Set(["mood-engine-lists", "mood-engine-lists-unseen", "mood-engine-friends"]);
    const count = (ids) => { const u = new Set(ids); return `${[...u].filter((tt) => Q.onlyByException(qualityRatings.get(tt))).length} of ${u.size}`; };
    log(`     Only through the floor exception (vouched, Letterboxd ≥ ${Q.VOUCHED_MIN_STARS} or no average, no 3.5): Board ${count(plan.board.flatMap((r) => r.items.map((i) => i.id)))} · Discover ${count(plan.discover.filter((c) => !editorial.has(c.id)).flatMap((c) => c.options.flatMap((o) => o.items.map((i) => i.id))))} · picker ${count(webData.films.map((x) => x.i))} distinct films`);
  }
  // New additions use only policy/build metadata in public JSON; events and candidate sets remain private.
  webData.schemaVersion = 1; webData.policyId = "baseline-v2";
  if (feedbackBatch.events.length) webData.feedbackIncludedAt = today;
  webData.buildId = require("./lib/learning/schema").hash({ today, policy: "baseline-v2", config: LEGACY_CFG }); // the legacy config: "board" and the moods outside board.legacyMoods feed the v2 files alone and must not move a legacy byte (test/legacy-parity.test.js)
  webData.films = webData.films.filter(x => LF.eligible(feedbackState,x.i,{kind:"new"}));
  webData.rewatch = webData.rewatch.filter(x => LF.eligible(feedbackState,x.i,{kind:"rewatch"}));
  for (const x of [...webData.films,...webData.rewatch]) for (const moodId of Object.keys(x.f)) if (!LF.eligible(feedbackState,x.i,{moodId,kind:webData.rewatch.includes(x)?"rewatch":"new"})) { delete x.f[moodId]; delete x.h[moodId]; }
  const seen = { seenIds, seenTts, titleSeen, seenSlugs: src.friends.seenSlugs };
  if (learningMode === "shadow") {
    const { union } = require("./lib/learning/candidates"), LE = require("./lib/learning/evaluate");
    const expanded = union([
      { kind:"preliminary-tmdb", items:[...pool.values()].map(c=>({film:tmdb.peek(c.id)})) },
      { kind:"baseline", items:cands },
      ...(src.shadowSources || []),
      ...Object.entries(tmdb.cache.recs).map(([seedId,v])=>({kind:"recommendations",seedId,observedAt:new Date(v.t).toISOString(),items:(v.v||[]).map(r=>({film:tmdb.peek(r.id)}))})),
      ...Object.entries(tmdb.cache.person).map(([sourceId,v])=>({kind:"filmography",sourceId,observedAt:new Date(v.t).toISOString(),items:(v.v||[]).map(r=>({film:tmdb.peek(r.id)}))})),
    ], {baselineCandidates:cands.map(c=>c.film.imdb), seen:seenTts});
    // 13/10/2026: the snapshot is a private by-product of shadow mode; if it cannot be written (any reason: the 1 GiB cap of the binaries, disk, a cover that is not a JPEG),
    // the public output must still be published, so capture sits inside this try and the failure is logged, not thrown.
    let snapshot = null;
    try {
      snapshot = LS.capture({root:ROOT,dir:privatePath,date:today,capturedAt,seed:learningConfig.experiment.seed,inputs:{history:all.map(r=>({...r,availableAt:capturedAt,...(r.rating!=null?{firstObservedAt:capturedAt,ratingObservedAt:capturedAt}: {})})),diary,live,coverage:got?{social:"partial",rss:rss.length}:null},candidates:expanded.expandedCandidates,effectivePosterState:covers?.effectiveState || {version:1,items:{}},effectiveOptions:{descriptionSeparator:DESCRIPTION_SEPARATOR ?? cfg.descriptionSeparator ?? "\n\n",skipPosters:SKIP_POSTERS,skipFriends:SKIP_FRIENDS},baseline:{plan,webData,index,rowCandidates:require("./lib/learning/row-candidates").freezeRows(expanded.expandedCandidates,all,cfg,today,feedbackBatch.events,plan.board,qualityRatings,capturedAt)},rss,log:m=>log("     "+m)});
      LS.writePrivate(path.join(snapshot,"run.json"),{schemaVersion:1,wallMs:Date.now()-t0,rssBytes:process.memoryUsage().rss,nodeVersion:process.version});
    } catch (e) {
      snapshot = null;
      log(`     snapshot failed: ${e.message}; baseline-v2 preserved`);
      try { LS.writePrivate(path.join(privatePath,"reports","unavailable.json"),{schemaVersion:1,status:"not_evaluated",reason:"snapshot failed: "+e.message,productionPolicy:"baseline-v2"}); } catch (e2) { log(`     snapshot report not written: ${e2.name}`); }
    }
    if (snapshot) {
      try { const runner=require("./scripts/learning"); const report=runner.evaluateSnapshot(snapshot,privatePath,"legacy-2024"); LS.writePrivate(path.join(privatePath,"reports",report.reportId+".json"),report); log(`     Shadow: ${expanded.stats.final} candidates · ${report.embeddingVariants.status} embeddings · baseline-v2 preserved`); }
      catch(e){LS.writePrivate(path.join(privatePath,"reports","unavailable.json"),{schemaVersion:1,status:"not_evaluated",reason:e.message,productionPolicy:"baseline-v2"});log("     Shadow unavailable; baseline-v2 preserved");}
    }
  }
  const { catalogs, files, covers: coverFiles, index: indexStats, pages: pageStats } = publish({ outDir: OUT_DIR, webDir: path.join(ROOT, "web"), cfg: DESCRIPTION_SEPARATOR == null ? cfg : { ...cfg, descriptionSeparator: DESCRIPTION_SEPARATOR }, plan, webData, index, seen, privacy:require("./lib/learning/public").privacyContext(privatePath,LS.readSources(ROOT),capturedAt), posters: covers ? { dir: path.join(CACHE_DIR, "posters-out"), tts: covers.tts } : null, index2, pageFacts });
  if (pageStats) log(`  Film pages: ${JSON.stringify(pageStats)}`);
  if (pageStats && pageStats.synOmitted) log(`     Film pages: ${pageStats.synOmitted} public synopsis(es) left out of the page (the text trips the private-text rule: "/k/", an e-mail or "you rate"); the rest of the film is published`);
  tmdb.save();
  tonightStep.remember(plan, process.env, CACHE_ONLY); // the memory of Tonight (14/11/2026): the row as it was published, written by a build that publishes (TONIGHT_MEMORY_WRITE=1), after the files, like the front's on the next line
  if (frontStep) frontStep.remember(process.env, CACHE_ONLY); // the memory of the front: written once a night (the scheduled build), after the files were published, so a night that stopped before this line does not record a front nobody saw

  // The full index and its chunks were written in the validated staging transaction.
  // The recommendation rule reaches the Worker as one flag per film (`eligible`: the same Q.qualifies() the plan went through), and the private feedback of
  // this build as the same flag / the same mood fit: the Worker never recomputes either, and the index carries no feedback event.
  const ix = indexStats;
  log(`     index for the Worker: ${ix.films} films · ${(ix.bytes / 1e6).toFixed(2)} MB · ${(ix.gzip / 1e6).toFixed(2)} MB gzipped (Board part: ${ix.board.films} films, ${(ix.board.bytes / 1e3).toFixed(0)} KB; ${ix.pieces.files} more pieces for moods, friends, directors and lists: ${(ix.pieces.bytes / 1e6).toFixed(2)} MB, ${(ix.pieces.gzip / 1e6).toFixed(2)} MB gzipped, the largest ${ix.pieces.largest} films)`);
  if (ix.v2) log(`     index v2 (Board of ${BOARD.entries.length} rows, ${BOARD.entries.filter((e) => e.place === "board").length} in the manifest, ${menu2.menu.length} Moods options): ${ix.v2.films} films · ${(ix.v2.bytes / 1e6).toFixed(2)} MB · ${(ix.v2.gzip / 1e6).toFixed(2)} MB gzipped · ${ix.v2.files} slices (menus, rows, moods): ${(ix.v2.piecesBytes / 1e6).toFixed(2)} MB, ${(ix.v2.piecesGzip / 1e6).toFixed(2)} MB gzipped, the largest ${ix.v2.largest} films`);
  if (ix.v2 && ix.v2.options && ix.v2.options.files) {
    log(`     Discover option pieces: ${ix.v2.options.files} files, ${(ix.v2.options.bytes / 1e6).toFixed(1)} MB (${(ix.v2.options.gzip / 1e6).toFixed(1)} MB gzipped, the largest ${ix.v2.options.largest} films): prefixes or complete options, read by the Worker instead of index-v2.json`);
    for (const e of ix.v2.options.expansions || []) log(`     ${e.part}: ${e.accepted ? "complete" : "original prefix"}, complete candidate ${e.bytes}/${e.maxBytes} bytes (${e.reason})`);
  }
  log(`     film languages for the Worker: ${ix.languages.pt} in Portuguese, ${ix.languages.known} in another language · ${ix.languages.bytes} bytes, ${ix.languages.gzip} gzipped`);

  log("     " + require("./lib/util").limitSummary());
  log(`\n✔ Done in ${((Date.now() - t0) / 1000).toFixed(0)}s · ${tmdb.calls} TMDB calls · ${catalogs} catalogs · ${files} files · ${coverFiles} covers`);
  log("  Board");
  for (const r of plan.board) log(`  ${r.id.slice(0, 22).padEnd(22)} ${String(r.items.length).padStart(3)}  ${r.items.slice(0, 4).map((x) => `${x.title} (${x.year})`).join(" · ")}`);
  if (plan.board2) {
    log(`  Board v2: ${plan.board2.length} rows`);
    const notes = new Map(v2.report.filter((x) => x.note).map((x) => [x.id, x.note])), made = new Set([...v2.report.map((x) => x.id), ...SPECIAL.map((s) => s.id)]); // the rows lib/board-rows.js and lib/special-rows.js made: a legacy row is as long as it has always been (Tonight is 10)
    const declared = BOARD.entries.filter((e) => e.place === "board").length, thinRows = plan.board2.filter((r) => made.has(r.id) && r.place !== "menu" && !r.series && r.items.length < THIN_ROW);
    log(`  Board: ${declared} rows declared in the manifest (${plan.board2.length - declared} more only in the Moods menu) · ${thinRows.length} under ${THIN_ROW} films${thinRows.length ? ` (!: ${thinRows.map((r) => `${r.id} ${r.items.length}`).join(", ")})` : ""}`);
    for (const r of plan.board2) {
      const thin = made.has(r.id) && r.items.length < THIN_ROW; // a row this short is on the Board all the same (Marco, 13/10/2026: fixed, never hidden); the build says so
      log(`${thin ? "!" : " "} ${r.id.slice(0, 22).padEnd(22)} ${String(r.items.length).padStart(3)}  ${r.series ? "(series: the Worker builds it)" : r.place === "menu" ? "(Moods menu only)" : r.items.slice(0, 3).map((x) => `${x.title} (${x.year})`).join(" · ")}`);
      if (notes.has(r.id)) log(`      ${notes.get(r.id)}`);
    }
    log(`  Moods menu of the v2 family (films that fit / of them passing the recommendation rule, which the Worker applies when it serves a mood): ${menu2.moods.map((m) => { const fits = index2.films.filter((f) => f.moods && m.id in f.moods); const ok = fits.filter((f) => f.eligible).length; return `${m.id} ${fits.length}/${ok}${ok < THIN_ROW ? "!" : ""}`; }).join(", ")} (! under ${THIN_ROW})`);
  }
  for (const c of plan.discover) {
    log(`  Discover · ${c.name}`);
    for (const o of c.options) log(`    ${o.label.slice(0, 44).padEnd(44)} ${String(o.items.length).padStart(3)}  ${o.items.slice(0, 3).map((x) => `${x.title} (${x.year})`).join(" · ")}`);
  }

  // ── the special rows of the v2 Board (lib/special-rows.js; Marco, 13/10/2026): friends' picks, splits and watchlists, prizes, untried directors, the actor of the week, single lists ──
  // They exist in plan.board2 only; "allowed" is the floor every surface applies (Q.qualifies) plus the private feedback, so a row of 60 is 60 films that stay; exclude.films is applied to the plan afterwards (EX.applyToPlan) and leaves its gap, except in untried-directors and actor-week, whose candidates it has already filtered.
  async function specialStep({ src, cands, all, model, qualityRatings, got, fcache, tmdb }) {
    // With the sources off (--skip-friends, or no friends and no lists configured) `src` is the stub `none`, whose isSeen says nothing is seen: the prize files hold films Marco has watched, so the awards row
    // needs the real test, from his own history alone (found 14/10/2026 when config.json took the board: friends.test.js built offline with --skip-friends and the guard stopped the build)
    const seenByYou = (r) => (!!r.tmdbId && seenIds.has(r.tmdbId)) || (!!r.imdbId && seenTts.has(r.imdbId)) || titleSeen(r.title, r.year);
    const seenDirectors = new Set(); // every director of every film watched (rated or not), through the TMDB cache
    for (const f of all) if (f.watched) for (const id of [f.tmdbId, f.searchPick]) for (const d of (id && tmdb.peek(id)?.directors) || []) seenDirectors.add(d.id);
    const ctx = {
      today, sizes: cfg.sizes, view: src.view, recs: src.recs, isSeen: got ? src.isSeen : seenByYou, detail: src.detail, model, cands, seenDirectors, awards: AWARDS, minFeatureMinutes: P.minFeatureMinutes(cfg), // no short in the rows that recommend (Marco, 14/11/2026)
      recommended: (tt) => music.ok(tt) && Q.qualifies(qualityRatings.get(tt)) && LF.eligible(feedbackState, tt, { moodId: null, kind: "new" }), // `allowed` and the music rule: the rows that RECOMMEND (top-picks, friends-split, untried-directors, actor-week) ask this one
      allowed: (tt) => Q.qualifies(qualityRatings.get(tt)) && LF.eligible(feedbackState, tt, { moodId: null, kind: "new" }), // the rule and the private feedback (Not for me, seen …) BEFORE the cut: the row refills to its ceiling. exclude.films is applied to the plan afterwards (EX.applyToPlan) and leaves its gap, like every Board row
      rated: all.filter((f) => f.film && f.rating != null).map((f) => ({ film: f.film, rating: f.rating })),
      lb: (tt) => qualityRatings.get(tt)?.lb ?? null,
      userOf: F.userReader(fcache, cfg), // friend-f and friend-g are in cache.users and not always in the partial /following/ list
      favourites: (user) => fcache?.users?.[user]?.favourites ?? null, // "4 favourites" of a friend's profile; absent until the collector exists (PR7)
      watched: (days) => (got ? L.watchedThisWeek({ cache: fcache, people: got.follow.people, today, days, cfg }) : new Map()),
      tmdbOfImdb: (tt) => tmdb.cache.find[tt]?.v || null,
    };
    // Marco, 22/10/2026 ~21:40 UTC: the friends' rows of the Board (top-picks, friends-split, friends-watchlist, friends-month) show films nobody put in the pool, so nothing had asked TMDB for their record: 25 of 243 cards of the live
    // Board had no credits line. lib/friends-records.js asks for the films the friends' rows hold (and, for a film `find` has no movie for, lets the recommendation rule's noRecord take it out: the series), builds the rows again and
    // asks for the films that took their place, until nothing is pending. The other kinds (prizes, lists, directors, actor) read the candidates the pool already joined. Offline nothing is asked.
    const friendSpecs = SPECIAL.filter((s) => FRIEND_KINDS.has(s.kind));
    const settled = friendSpecs.length ? await FR.settle(tmdb, () => SR.build(ctx, friendSpecs), (o) => Object.values(o.rows).flat()) : null;
    if (settled) {
      tmdb.save();
      log(`     Friends' rows of the v2 Board: ${process.env.OFFLINE ? `${settled.pending} film(s) lack a TMDB record (offline: the nightly asks)` : `${settled.films} film(s) asked of TMDB for their record in ${settled.rounds} round(s)${settled.pending ? `, ${settled.pending} still without${settled.capped ? " (round limit reached)" : ""}` : ""}`}`);
    }
    const out = SR.build(ctx, SPECIAL);
    log("     Special rows of the v2 Board:");
    for (const s of SPECIAL) log(`       ${s.id.padEnd(18)} ${String(out.rows[s.id].length).padStart(3)}  ${out.notes[s.id]}`);
    for (const w of out.warnings) log(`  ! ${w}`);
    return out;
  }

  // ── Loved by your directors (lib/directors-loved.js; Marco, 11/10/2026) ──
  // → { row: Board items, menu: [{ label, items }] for Discover }. The floor exception is not here: DL.vouched() above, in qualityRatings.
  // data: the file, already validated above (or null); lc: config.json directorsLoved over DL.DEFAULTS
  async function lovedStep({ data, lc, model, seenIds, seenTts, titleSeen, seenSlugs, following }) {
    if (!data) { log(`     Loved by your directors: no ${lc.file}`); return { row: [], menu: [] }; }
    const fav = DL.favorites({ data, stats: [...model.stats.values()], cfg: lc, following }); // their films' TMDB records were fetched before DL.vouched() (step 4)
    let refused = 0;
    const isSeen = (r) => (r.tmdb && seenIds.has(r.tmdb)) || seenTts.has(r.imdb) || (r.slug && seenSlugs.has(r.slug)) || titleSeen(r.title, r.year) || (!!r.originalTitle && titleSeen(r.originalTitle, r.year));
    const films = DL.lovedFilms({ data, favorites: fav.list, isSeen, peek: (id) => tmdb.peek(id), aliases: lc.aliases || {} }); // a favourite's own film is left out (Marco, 11/10/2026)
    for (const d of data.directors) for (const f of d.films || []) { const p = tmdb.peek(f.tmdb); if (p && p.imdb !== f.imdb) refused++; }
    const why = (c) => (c.detail ? reasons(score(c.detail, model).contributions, 1) : []);
    const row = DL.row(films.filter((c) => eligibleTt(c.imdb)), { size: lc.size ?? cfg.sizes.row, perDirector: lc.perDirector }).map((c) => DL.toItem(c, { why: why(c) }));
    const options = DL.menu(films, fav.list, { min: lc.menuMin });
    const menu = options.map((m) => ({ label: m.label, items: m.films.slice(0, cfg.sizes.cuts ?? cfg.sizes.discover).map((c) => DL.toItem(c, { first: m.name, why: why(c) })) }));
    log(`     Loved by your directors: ${fav.list.length} favourite directors with films on file (${fav.list.map((f) => `${f.label} ${f.weight.toFixed(2)}${f.via.includes("ratings") ? "" : ` [${f.via.join("+")}]`}`).join(", ")}) · ${films.length} unseen films · row ${row.length} · menu ${options.map((m) => `${m.label} ${m.films.length}`).join(", ") || "empty"}${refused ? ` · ${refused} TMDB ids on file name another film in the TMDB cache: published by IMDb id alone` : ""}`);
    const off = fav.auto.filter((n) => !fav.list.some((f) => DL.norm(f.name) === DL.norm(n)));
    if (off.length) log(`     (favourites by your ratings with no film on file: ${off.join(", ")})`);
    return { row, menu };
  }

  // ── the public pages (needs only your history) ──
  async function gatherSources({ all, live }) {
    log(`     Sources: ${personOptions ? "frozen personal acquisition (update-person)" : CACHE_ONLY ? "from cache/friends.json + cache/lists.json only (--cache-only)" : "reading public Letterboxd pages (cached in cache/friends.json and cache/lists.json)"}…`);
    // Personal acquisition belongs exclusively to update-person; online TMDB/covers remain enabled.
    const frozenSources = CACHE_ONLY || !!personOptions;
    const onWatch = makeOnWatch(all);
    const listsRead = await L.refreshLists({ cfg, file: path.join(CACHE_DIR, "lists.json"), http, force: flag("--lists-refresh"), cacheOnly: frozenSources, log });
    let follow = { people: [], followed: 0, used: 0, limited: false, rssRead: 0, rssFailed: [] };
    let crowdRead = null;
    const liveSlugs = live.ok ? live.items.map((i) => i.slug) : [];

    // Which film pages to look up, and in which order: this week's logs and your watchlist first, the lists last.
    const extra = async (ctx) => {
      follow = await L.readFollowing({ cfg, ...ctx });
      crowdRead = await L.readCrowd({ cfg, ...ctx, people: follow.people, limit: CROWD_LIMIT });
      const week = L.watchedThisWeek({ cache: ctx.cache, people: follow.people, today, days: cfg.weekRow?.days, cfg });
      const listSlugs = F.roundRobin(listsRead.lists.map((l) => l.items.filter((i) => !i.tv).map((i) => i.slug)));
      // At most cfg.build.listLookups film pages a night for list films never looked up (position by position across the lists):
      // a night that adds big lists stays inside the workflow's 5 hours, and the rest comes the next nights.
      const cap = cfg.build.listLookups ?? Infinity, { now: tonight, later, unknown } = L.capLookups(listSlugs, ctx.cache.films, cap);
      if (later.size) log(`     lists: ${unknown} films never looked up; ${cap} tonight (cfg.build.listLookups), ${later.size} the next nights`);
      const v = F.viewFriends(ctx.cache, cfg);
      const theirs = F.roundRobin(v.users.map((u) => [...u.watchlist.keys(), ...[...u.films.values()].filter((f) => f.rating >= (cfg.friendRows?.top?.minStars ?? 4.5)).map((f) => f.slug)]));
      const mine = new Set(v.me);
      return { first: [...week.keys(), ...liveSlugs], last: tonight, enrich: [...liveSlugs, ...listSlugs, ...theirs].filter((s) => !mine.has(s)) };
    };
    let view, resolved, problems;
    if (frozenSources) {
      view = F.viewFriends(fcache, cfg);
      const c = L.choosePeople({ cfg, cache: fcache });
      follow = { ...c, used: c.people.length, rssRead: 0, rssFailed: [] };
      resolved = { attempted: 0, withImdb: 0, withoutImdb: 0, notFound: 0, left: 0, enriched: 0, enrichWanted: 0 };
      problems = [];
    } else {
      ({ view, resolved, problems } = await refreshFriends({ cfg, file: friendsFile, http, limit: LOOKUP_LIMIT, force: flag("--friends-refresh"), cache: fcache, extra, enrichMax: ENRICH_MAX, onMyWatchlist: onWatch, log }));
    }
    // the static lists (data/lists/*.json) are laid over Letterboxd's film records: the file names the IMDb id, a record that names another refuses the item
    const stat = SL.apply({ lists: listsRead.lists, films: view.films });
    view = { ...view, films: stat.films };
    for (const s of stat.stats) log(`     static list ${s.id.padEnd(16)} ${s.items} films · ${s.agreed} agree with Letterboxd's record · ${s.supplied} identified by the file (page not looked up yet) · ${s.tv} series left out of the film catalogs · ${s.refused} refused (another IMDb id) · ${s.gone} gone`);
    problems = [...listsRead.problems, ...stat.problems, ...problems];
    const idCheck = require("./lib/tmdb-identity").consistentFilms(view.films, (id) => tmdb.peek(id));
    if (idCheck.conflicts.length) {
      view = { ...view, films: idCheck.films };
      log(`     ${idCheck.conflicts.length} Letterboxd records point at another film's TMDB id (old tv ids): their TMDB facts are ignored`);
    }
    log(`     ${resolved.attempted} film pages looked up this run (${resolved.withImdb} new with IMDb id, ${resolved.withoutImdb} new without, ${resolved.notFound} gone, ${resolved.enriched} read again for rating/runtime/country)${resolved.left ? ` · ${resolved.left} new ones still to look up` : ""}${resolved.enrichWanted - resolved.enriched > 0 ? ` · ${resolved.enrichWanted - resolved.enriched} old records still without rating/runtime/country` : ""}`);
    // every slug read from a page passed lib/friends.js SLUG_RE or was dropped here (security finding 2, 11/10/2026): the count, and the first few
    if (!CACHE_ONLY) log(`  ${F.slugsRefused.n ? "!" : " "}   Letterboxd slugs refused by the slug pattern this run: ${F.slugsRefused.n}${F.slugsRefused.n ? ` (${F.slugsRefused.examples.map((x) => JSON.stringify(x)).join(", ")})` : ""}`);
    return { listsRead, follow, crowdRead, view, resolved, problems };
  }

  /** "On your watchlist": same TMDB id, or same title within a year, as a film you have saved and not seen. Built when asked: the TMDB ids arrive in step 2. */
  function makeOnWatch(all) {
    const watch = all.filter((f) => f.watchlist);
    const watchIds = new Set(watch.map((f) => f.tmdbId).filter(Boolean));
    const watchYears = new Map();
    for (const f of watch) (watchYears.get(norm(f.title)) || watchYears.set(norm(f.title), []).get(norm(f.title))).push(f.year);
    return (r) => (r.tmdbId && watchIds.has(r.tmdbId)) || (!!r.year && (watchYears.get(norm(r.title)) || []).some((y) => y && Math.abs(y - r.year) <= 1));
  }

  // ── the rows (needs your taste and the TMDB cache too) ──
  async function runSources({ tmdb, all, seenIds, seenTts, titleSeen, model, cands, live, got }) {
    const { listsRead, follow, crowdRead, view, problems } = got;
    const onWatch = makeOnWatch(all);

    const seenSlugs = new Set([...view.me]);
    const detail = (r) => (r.tmdbId ? tmdb.peek(r.tmdbId) : null);
    // What the static rows SHOW (name, synopsis, genres, directors, year, runtime) comes only from a record that carries the film's own IMDb id (lib/pool.js ownDetail, 20/10/2026;
    // the Board v2 rows of lib/special-rows.js build the same reader from the `detail` handed to them below):
    // tt0204394 and tt8101850 were published under another film's name. The POOL reads the same reader (Marco, 21/10/2026: "the ranking also uses only the film's own record"):
    // its taste, its quality, and the runtime, country, rating and genres of the rows made from it come from the own record or are missing, never from another title's
    // (tt8101850, Undone, read 59 min and Documentary from "Unnatural Selection"). The taste of the friends' and the week's rows, and `seenRec` below (also the pool's `isSeen`: foreign `tmdbId` and `originalTitle`), keep the raw `detail` (BACKLOG 21/10/2026).
    const shown = P.ownDetail((id) => tmdb.peek(id));
    // Only the friends' rows and the week row (the cards of lib/friends-records.js) read the record /find found when the number Letterboxd names is another film's (22/10/2026, friends-cards). The pool and the list catalogs keep `shown`:
    // adopting it there moves the taste and quality scores of 226 files of the Discover cuts and the Criterion row (measured by the re-verification of the same night), which is a decision for Marco (BACKLOG).
    const shownFriends = P.ownDetail((id) => tmdb.peek(id), (tt) => tmdb.cache.find[tt]?.v || null);
    const seenRec = (r) =>
      (r.tmdbId && seenIds.has(r.tmdbId)) || (r.imdbId && seenTts.has(r.imdbId)) || seenSlugs.has(r.slug) || (r.canon && seenSlugs.has(r.canon)) || titleSeen(r.title, r.year) ||
      !!(detail(r)?.originalTitle && titleSeen(detail(r).originalTitle, r.year));
    const tasteScore = (r) => (detail(r) ? score(detail(r), model).score : null);
    // Marco, 22/10/2026 ~21:40 UTC ("Esconder séries das fileiras de filmes dos amigos"): a film TMDB has no MOVIE record of (a series, an episode) is in no friends row, the Discover collections of the friends included
    // (`unrecorded`, lib/rows.js; the session's reading for the collections, reversible by dropping this argument). The quality floor still does not govern those collections.
    // The films noRecord already hides (the movie under Letterboxd's number came back empty) never reach a row, so no row would ever ask about them: ask `find` for the ones it was never asked about and let the
    // answers that expired ask again (lib/friends-records.js hidden; review of friends-cards, 22/10/2026). Offline it only counts.
    const hiddenFilms = FR.hidden(tmdb, Object.values(view.films).map((f) => ({ imdb: f.imdbId, tmdbId: f.tmdbId })));
    const hiddenNever = FR.pending(tmdb, hiddenFilms).length;
    await FR.fillRecords(tmdb, hiddenFilms);
    tmdb.save();
    log(`     Films TMDB has no movie of (kept out of the rows): ${hiddenFilms.length} ${process.env.OFFLINE ? `looked at, ${hiddenNever} never asked in /find (offline: the nightly asks)` : `looked at, ${hiddenNever} asked in /find now`}`);
    const unrecorded = ({ imdbId, tmdbId }) => tmdb.noRecord(imdbId, tmdbId);
    const wholeCfg = { ...cfg, sizes: { ...cfg.sizes, friendsDiscover: Number.MAX_SAFE_INTEGER } }; // the Discover cap lifted: for the Worker's index only (friendsFull)
    // `make(c)` takes the config the rows are built with: the Board's and the static collections' (`cfg`, Discover cap sizes.friendsDiscover) or the Worker's index (friendsFull below, the cap lifted).
    // Until 23/10/2026 it took no parameter and ignored the one friendsFull passed (defect of the merge 4a40105, 11/10/2026: its first parent had `make = (c = cfg)`, its second `make = ()`, and the merge kept the second): the Worker's options stopped at 60 films each, like the static ones.
    const make = (c = cfg) => buildFriendRows({ view, cfg: c, isSeen: seenRec, onMyWatchlist: onWatch, tasteScore, detail: shownFriends, keepEmpty: true, eligible: recommendable, unrecorded });

    // ── friends rows (Friends loved on the Board; Top / Watch together / their lists in Discover)
    // With a TMDB token, fill in runtime / genres / overview / credits for what made the rows, then rank once more with your taste. lib/friends-records.js asks the movie under the TMDB id Letterboxd names and,
    // when that is not the film's own record, `find` by IMDb id; a film `find` finds nothing for leaves the rows, the next ones take its place and are asked in the next round (Offline: nothing is asked, `pending` says what the nightly will).
    // The Worker's index carries the WHOLE of every friends option (Marco, 23/10/2026: "cada opção mostra a lista inteira do amigo"), so the films beyond the Discover cap need their record too, and this is asked FIRST,
    // as a precaution: the taste z-score of the Watch together rows reads every film of the option, so the capped collections below would be ordered by the cache that already holds these records. No measured effect today and
    // no test guards the order (moving this pass after the next `settle` leaves the suite green; BACKLOG 23/10/2026). The "Friends loved" row is no Worker option and is left out. Cost: once per film (lib/tmdb.js caches 45 days / a year); offline nothing is asked.
    const wholeLists = (o) => o.meta.filter((m) => m.kind !== "love").flatMap((m) => o.rows[m.id]);
    const wholeRecords = await FR.settle(tmdb, () => make(wholeCfg), wholeLists);
    tmdb.save();
    log(`     Friends' options for the Worker (whole lists, ${wholeLists(wholeRecords.out).length} films): ${process.env.OFFLINE ? `${wholeRecords.pending} film(s) lack a TMDB record (offline: the nightly asks)` : `${wholeRecords.films} film(s) asked of TMDB for their record in ${wholeRecords.rounds} round(s)${wholeRecords.pending ? `, ${wholeRecords.pending} still without${wholeRecords.capped ? " (round limit reached)" : ""}` : ""}`}`);
    const friendRecords = await FR.settle(tmdb, make, (o) => Object.values(o.rows).flat());
    let out = friendRecords.out;
    tmdb.save();
    log(`     Friends' cards (Friends loved and the Discover collections): ${process.env.OFFLINE ? `${friendRecords.pending} film(s) lack a TMDB record (offline: the nightly asks)` : `${friendRecords.films} film(s) asked of TMDB for their record in ${friendRecords.rounds} round(s)${friendRecords.pending ? `, ${friendRecords.pending} still without${friendRecords.capped ? " (round limit reached)" : ""}` : ""}`} · ${out.noRecord} film(s) with no TMDB movie (series, episodes) left out of every friends row`);
    // The same options with the Discover cap lifted, for the Worker's index: every film of every friends option, in the build's order.
    const friendsFull = make(wholeCfg);
    // "All friends loved" (config.json friendRows.all; Marco, 28/10/2026, Discover proposal 5): who among the whole crowd (the people you follow plus the configured friends) rated a film at the bar of "Friends loved" or more, the films you
    // have not seen and TMDB knows as a movie. Which of them the index holds, and in which order, is worked out below, once the index is built (lib/friends-option.js).
    const allCfg = cfg.friendRows?.all, allLoved = allCfg?.word ? F.allFriendsLoved({ crowd: view.crowd, films: view.films, isSeen: seenRec, minStars: allCfg.minStars ?? cfg.friendRows?.love?.minStars ?? 4, unrecorded }) : [];
    // Do Letterboxd's IMDb ids agree with TMDB's wherever both are known?
    let both = 0, agree = 0;
    for (const r of Object.values(view.films)) {
      const d = r.tmdbId && r.imdbId ? tmdb.peek(r.tmdbId) : null;
      if (d?.imdb) { both++; if (d.imdb === r.imdbId) agree++; }
    }
    const perFriend = friendStats(view);
    for (const s of perFriend)
      log(`     ${s.name.padEnd(15)} ${String(s.read).padStart(5)} films read · ${String(s.rated).padStart(5)} rated · ${String(s.withTt).padStart(5)} with tt · ${String(s.noImdb).padStart(4)} dropped (no IMDb) · ${String(s.pending).padStart(5)} not looked up yet · ${s.watchlist} on watchlist · fetched ${s.fetchedAt || "never"}`);
    log(`     IMDb id check against the TMDB cache: ${agree}/${both} agree${both - agree ? ` (${both - agree} differ; Letterboxd's id is the one published)` : ""}`);

    // ── the crowd: everyone you follow (+ the configured friends). Per person: pages and films read, rated, with an IMDb id (looked up lazily: only what a row needs), dropped, not looked up
    const crowd = F.crowdStats(view, fcache);
    const num = (n) => String(n).padStart(5);
    for (const c of crowd)
      log(`     crowd ${c.name.slice(0, 15).padEnd(15)} ${String(c.pages ?? "-").padStart(3)} pages · ${num(c.read)} films${c.total != null ? ` (page says ${c.total})` : ""} · ${num(c.rated)} rated${c.ratingsIgnored ? (c.ratingsIgnoredBy === "rule" ? ` (ratings ignored by the rule: ${c.ratingSpread.count} of ${c.ratingSpread.n} at ${c.ratingSpread.value}★)` : " (ratings ignored: config.json ratingsIgnored)") : ""} · ${num(c.withTt)} with tt · ${String(c.dropped).padStart(4)} dropped (no IMDb / gone) · ${num(c.pending)} not looked up · ${String(c.watchlist).padStart(4)} on watchlist · read ${c.fetchedAt ? c.fetchedAt.slice(0, 10) : "never"}${c.partial ? " (PARTIAL: retried tomorrow)" : ""}`);
    // config.json ratingsIgnored: who is out of the ratings, by the list and by the general rule (Marco, 22/10/2026 ~06:40 UTC), the rule's with the numbers that tripped it
    const ruleCfg = F.ratingsRuleOf(cfg), byRule = crowd.filter((c) => c.ratingsIgnoredBy === "rule"), byList = crowd.filter((c) => c.ratingsIgnoredBy === "list");
    log(`     Ratings ignored: ${byList.length} by the list (${byList.map((c) => c.name).join(", ") || "none"}) · ${ruleCfg ? `${byRule.length} by the rule (one value in ${Math.round(ruleCfg.share * 100)}% or more of at least ${ruleCfg.minRatings} ratings)` : "no general rule in the config"}`);
    for (const c of byRule) log(`       rule: ${c.name} (${c.user}) · ${c.ratingSpread.n} ratings · ${(100 * c.ratingSpread.share).toFixed(1)}% at ${c.ratingSpread.value}★ (${c.ratingSpread.count})`);
    const sum = (k) => crowd.reduce((a, c) => a + (c[k] || 0), 0);
    log(`     Crowd: ${crowd.length} people · ${sum("pages")} pages · ${sum("read")} films · ${sum("rated")} rated · ${sum("withTt")} with tt · ${sum("dropped")} dropped · ${sum("pending")} not looked up · ${sum("watchlist")} watchlist entries${crowdRead ? ` · this run: ${crowdRead.filmsRead} histories (${crowdRead.filmsFull} whole, ${crowdRead.filmsIncremental} incremental, ${crowdRead.filmsPagesRead} Chrome pages) and ${crowdRead.watchlistsRead} watchlists read, ${crowdRead.fresh} people still fresh${crowdRead.failed.length ? `, FAILED for ${crowdRead.failed.join(", ")}` : ""}${crowdRead.privateWatchlists.length ? `, private watchlist: ${crowdRead.privateWatchlists.join(", ")}` : ""}` : ""}`);
    for (const m of out.meta) log(`     friends row ${m.id.padEnd(36)} ${String(out.rows[m.id].length).padStart(3)} films (${out.stats[m.id].droppedSeen} dropped as seen)`);

    // ── the people you follow and what they watched this week
    const wkDays = cfg.weekRow?.days ?? 7;
    log(`     Following: ${follow.followed} people read from /following/, ${follow.used} used (first ${cfg.weekRow?.max ?? 60} + configured friends); diary read for ${follow.rssRead} this run${follow.rssFailed.length ? `, FAILED for ${follow.rssFailed.join(", ")}` : ""}`);
    const week = L.watchedThisWeek({ cache: fcache, people: follow.people, today, days: wkDays, cfg });
    const weekRecords = await FR.settle(tmdb, () => P.weekRow({ week, view, isSeen: seenRec, tasteScore, detail: shownFriends, size: cfg.sizes.row, eligible: recommendable, minRuntime: P.minFeatureMinutes(cfg) }), (w) => w.items); // the films of the week lack a record just as the friends' rows' did (22/10/2026)
    const wk = weekRecords.out;
    tmdb.save();
    log(`     Friends watched this week: ${process.env.OFFLINE ? `${weekRecords.pending} film(s) lack a TMDB record (offline: the nightly asks)` : `${weekRecords.films} film(s) asked of TMDB for their record in ${weekRecords.rounds} round(s)${weekRecords.pending ? `, ${weekRecords.pending} still without${weekRecords.capped ? " (round limit reached)" : ""}` : ""}`}`);
    log(`     Friends watched this week: ${wk.stats.films} films logged in the last ${wkDays} days → ${wk.items.length} on the row (${wk.stats.seen} seen by you, ${wk.stats.pending} not looked up yet, ${wk.stats.noImdb} without IMDb, ${wk.stats.gone} gone${wk.stats.refused ? `, ${wk.stats.refused} refused by the recommendation rule or the music rule` : ""})`);

    // ── curated lists: per-list counts, then the two Discover catalogs per list
    const listCats = P.listCatalogs({ lists: listsRead.lists, view, isSeen: seenRec, detail: shown, size: cfg.sizes.lists });
    for (const c of listCats) {
      const l = listsRead.lists.find((x) => x.id === c.id), s = c.stats;
      log(`     list ${c.id.padEnd(16)} ${c.name.slice(0, 46).padEnd(46)} read ${String(s.read).padStart(3)}${l.total ? `/${l.total}` : ""} · with tt ${String(s.withTt).padStart(3)} · no IMDb ${s.noImdb} · not looked up ${s.pending} · gone ${s.gone} · seen ${s.seen} · fetched ${l.fetchedAt ? l.fetchedAt.slice(0, 10) : "never"}`);
    }

    // ── the pool: unseen films from the watchlist, the lists, and the friends' watchlists and top picks
    const entries = [], extraFilms = [];
    if (live.ok) for (const i of live.items) entries.push({ slug: i.slug, tag: { type: "watchlist" } });
    else for (const c of cands) if (c.watchlist && c.film?.imdb) extraFilms.push({ tt: c.film.imdb, tmdb: c.film.id, detail: c.film, title: c.film.title, year: c.film.year, tag: { type: "watchlist" } });
    for (const l of listsRead.lists) l.items.forEach((it, i) => entries.push({ slug: it.slug, tag: { type: "list", id: l.id, name: l.name, pos: i + 1, popular: !!l.popular } }));
    const topMin = cfg.friendRows?.top?.minStars ?? 4.5;
    for (const u of view.users) {
      for (const w of u.watchlist.values()) entries.push({ slug: w.slug, tag: { type: "fwatch", name: u.name } });
      for (const f of u.films.values()) if (f.rating != null && f.rating >= topMin) entries.push({ slug: f.slug, tag: { type: "ftop", name: u.name, rating: f.rating } });
    }
    const { pool, stats: ps } = P.buildPool({ entries, extra: extraFilms, view, isSeen: seenRec, detail: shown });
    if (!process.env.OFFLINE) {
      await Promise.all([...pool.values()].filter((r) => r.tmdbId && !r.detail).map(async (r) => { const d = await tmdb.movie(r.tmdbId); r.detail = d && d.imdb === r.imdbId ? d : null; })); // the fetched record joins the pool only when it is the film's own (as `shown`)
      tmdb.save();
    }
    const recs = P.rankPool(pool, model);
    const withDetail = recs.filter((r) => r.detail).length;
    log(`     Pool: ${ps.entries} entries (watchlist ${live.ok ? "live" : "csv"}, ${listsRead.lists.length} lists, friends' watchlists and top picks) → ${recs.length} distinct unseen films with a tt; left out: ${ps.seen} seen, ${ps.noImdb} without IMDb, ${ps.gone} gone, ${ps.pending} not looked up yet`);
    log(`     Pool facts: TMDB record for ${withDetail}/${recs.length}; Letterboxd rating for ${recs.filter((r) => r.lb != null).length}; runtime for ${recs.filter((r) => P.runtimeOf(r) != null).length}; country for ${recs.filter((r) => P.countriesOf(r).length).length}`);

    const sizes = cfg.sizes;
    const sr = cfg.shortRow || {};
    const passing = recs.filter((r) => recommendable(r.id));
    const features = passing.filter((r) => !P.isShort(P.runtimeOf(r), P.minFeatureMinutes(cfg))); // and no short (Marco, 14/11/2026: "Keep shorts only in the Short row"; shortRow.minMinutes, the one number) // the Board rows below are made from the films that pass the recommendation rule and the music rule; the cuts of Discover keep every film that is not a music film without evidence (the quality rule still shortens them)
    const newRowOpts = P.newRowOptions(cfg, { today, size: sizes.row });
    const extraRows = {
      fromlists: P.fromListsRow(features, sizes.row),
      short: P.shortRow(features, { max: sr.maxMinutes ?? 95, min: P.minFeatureMinutes(cfg), size: sizes.row }),
      newforyou: P.newRow(features, newRowOpts),
      "friends-week": wk.items,
    };
    const cutOut = P.cuts(recs.filter((r) => music.ok(r.id)), { size: sizes.cuts ?? sizes.discover, countries: cfg.cuts?.countries ?? 12, minRuntime: P.minFeatureMinutes(cfg), today });
    const m = cutOut.missing;
    log(`     Left out of a cut for lacking its fact: ${m.decade} without a year · ${m.runtime} without a runtime (+ ${m.shortFilms} under ${P.minFeatureMinutes(cfg)} min, shorts, left out of every cut) · ${m.country} without a country · ${m.rating} without any rating`);
    for (const p of problems) log(`  ! ${p}`);
    // the private experiment's list items take a TMDB record only when its IMDb id is the page's (LW.joinTmdb, production's join), from the cache;
    // its v2-pool items likewise drop a `detail` whose IMDb id is not the pool film's (since 21/10/2026 the pool itself no longer holds one: a pool film with no own record whose tmdbId is cached names a record of another title, and loses the id), in both cases the code meets: the record names ANOTHER
    // IMDb id, or NONE (an old record's TV id: maniac-2018 → 73411, a Titan FC event with imdb null — the 3 cases measured on 13/10/2026
    // all have imdb null); on those caches that pool fix is what turns test/shadow-list-join.test.js green (3 films paired with another film's record on main)
    const shadowJoin = await LW.joinListFilms(listsRead.lists, view.films, { movie: async (id) => tmdb.peek(id), fromImdb: async (tt) => tmdb.cache.find[tt]?.v || null });
    return { friends: { ...out, perFriend, seenSlugs }, friendsAllLoved: allLoved, extra: extraRows, listCats, cuts: cutOut, week: wk, shadowSources: [{kind:"v2-pool",items:recs.map(r=>({filmId:r.imdbId || r.id, film:require("./lib/learning/candidates").poolFilm((r.detail ? r.detail.imdb !== (r.imdbId || r.id) : !!(r.tmdbId && tmdb.peek(r.tmdbId))) ? { ...r, detail: null, tmdbId: null } : r),sources:[...r.tags.lists].map(([sourceId,x])=>({kind:"list",sourceId,position:x.pos,seedId:null,observedAt:null,partial:true}))}))}, ...listsRead.lists.map(l=>({kind:"list",sourceId:l.id,observedAt:l.fetchedAt||null,partial:l.items.length < (l.total||l.items.length),items:l.items.map(it=>{const r=view.films[it.slug],id=shadowJoin.tmdbOf(r?.imdbId);return {filmId:r?.imdbId,film:id?tmdb.peek(id):null};})}))], recs, view, lists: listsRead.lists, friendsFull, isSeen: seenRec, detail };
  }
}

/**
 * The IMDb ratings (from IMDb's dataset, cache/imdb-ratings.json) and the covers with the badges (lib/posters.js). Nothing in it can stop the
 * build: a step that fails is logged and the films keep the cover address they had (this includes a plan or index that cannot be turned into targets:
 * collectTargets() throws on a planned film missing from the index and on an invalid id, and it is inside the try; --skip-posters never calls it).
 * → { tts, stats, receipt, effectiveState } or null when covers are skipped or fail.
 */
async function imdbStep({ plan, imdbAll = new Map(), extraTts = [] }) {
  const targets = PO.collectTargets(plan);
  // Legacy parity (14/10/2026, first night with the Board of 54 rows in config.json): the ratings are ASKED for every target, the v2 rows' films
  // included (their covers and the v2 family keep the IMDb number), but the legacy index may carry only the ratings of the request set it had
  // before any Board existed: the plan's non-v2 items plus extraTts. Without this filter a film that only a v2 row holds (Demolition, in
  // friends-split) got its rating into cache/imdb-ratings.json one night and into data/index.json the next, and the legacy family moved with the Board.
  const legacyWanted = new Set(extraTts.filter(Boolean));
  for (const { item, v2 } of planItems(plan)) if (!v2) legacyWanted.add(item.id);
  let imdb = { map: new Map(), source: "none", bytes: 0 };
  try {
    // Preserve the historical IMDb rating request set; full-index cover targets do not add rating requests.
    imdb = await PO.loadImdbRatings({ file: path.join(CACHE_DIR, "imdb-ratings.json"), wanted: new Set([...targets.keys(), ...extraTts.filter(Boolean)]), today, offline: CACHE_ONLY || SKIP_POSTERS, log });
    for (const [tt, v] of imdb.map) if (legacyWanted.has(tt)) imdbAll.set(tt, v);
    for (const t of targets.values()) if (imdb.map.has(t.tt)) t.ratings.imdb = imdb.map.get(t.tt);
  } catch (e) { log(`  ! IMDb ratings: ${e.message} — films carry no IMDb number tonight`); }
  log(`     IMDb ratings: ${[...imdb.map.keys()].filter((tt) => targets.has(tt)).length} of ${targets.size} films of the files (${imdb.source}${imdb.bytes ? `, ${(imdb.bytes / 1048576).toFixed(1)} MB` : ""}), ${imdb.map.size} with the films only the index for the Worker carries`);
  return imdb;
}
async function coverStep({ plan, index, coverFacts, countries, watchlistIds = new Set() }) {
  if (SKIP_POSTERS) { log("     Covers: skipped (--skip-posters)"); return null; }
  let originalPosters = new Map();
  try {
    // a film only the v2 Board holds and the index lacks keeps the cover it had, with a warning of its own; it never abandons the covers of the night
    const targets = PO.collectTargets(plan, { index, coverFacts, watchlistIds, onSkip: (item, row) => log(`  ! Cover skipped for ${item.id} (${item.title}) in the v2 row ${row}: the index has no record of it — it keeps the cover it had`) });
    originalPosters = new Map([...targets.values()].flatMap(t=>t.items.map(item=>[item,item.poster])));
    const t0 = Date.now();
    const cn = CO.attachCountries(targets, countries);
    log(`     Countries (cover country choice: main country by director/origin, with the old language/production fallback), of ${targets.size} distinct films: ${cn.main} by main country · ${cn.language} by language + a production country that speaks it · ${cn.languageDefault} by the language's default country (no production country speaks it) · ${cn.production} with no language: first TMDB production country · ${cn.letterboxd} with no language: first country on the Letterboxd page · ${cn.none} unknown (their cover shows the year alone)`);
    log(`     Flag: ${cn.changed} films change flag from the first production country to the main-country/fallback choice${Object.keys(cn.unknownLanguages).length ? ` · ${Object.values(cn.unknownLanguages).reduce((a, b) => a + b, 0)} films have a language that tools/selo/language-countries.json lacks (${Object.entries(cn.unknownLanguages).map(([k, v]) => `${k} ×${v}`).join(", ")}): they use the first production country` : ""}`);
    const dir = { raw: path.join(CACHE_DIR, "posters-raw"), out: path.join(CACHE_DIR, "posters-out"), state: path.join(CACHE_DIR, "posters.json"), flags: path.join(CACHE_DIR, "flags") };
    const r = await PO.drawCovers({ targets, dir, base: cfg.posters?.base, today, cacheOnly: CACHE_ONLY, log });
    const s = r.stats;
    // Personal receipts stay alongside the personal site, separate from Marco.
    // The receipt of what each cover was drawn from stays local: --cover-receipt <file>, else <root>/.context/<date>-cover-receipt.json for a build that publishes
    // to the default ./docs, and no file at all for a build with --out (the tests, the CI checks, the replays: a test that wants the receipt passes --cover-receipt).
    const receiptFile = COVER_RECEIPT || (opt("--out") ? null : path.join(personOptions ? path.dirname(personOptions.outDir) : path.join(ROOT,".context"),today+"-cover-receipt.json"));
    if (receiptFile) try {
      require("./lib/learning/snapshot").writePrivate(receiptFile,r.receipt);
      log("     Cover receipt (local only): " + receiptFile);
    } catch (e) { log(`  ! Cover receipt not saved: ${e.message} — keeping the rendered covers`); }
    log(`     Covers: ${s.unique} distinct films · ${s.noNumbers} with nothing to show (original kept) · ${s.unchanged} unchanged · ${s.downloaded} downloaded${s.usedFallback ? ` (${s.usedFallback} through the other source)` : ""} · ${s.drawn} drawn · FAILED: ${s.downloadFailed} download${s.hostTripped ? ` (${s.hostTripped} of them host-tripped: the image host stopped answering)` : ""}, ${s.drawFailed} drawing${s.noRaw ? `, ${s.noRaw} not on disk (--cache-only)` : ""} (those keep the original address) · ${s.skippedBackoff} skipped (backoff)${s.switched ? ` · ${s.switched} switched source` : ""} · ${r.tts.size} covers published, ${s.mb.toFixed(1)} MB${s.pruned ? ` · ${s.pruned} old ones deleted` : ""} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    const flagOnly = r.receipt.filter(x=>!x.year&&x.flag).length;
    log(`     Top-left facts of targets: ${s.withFlag-flagOnly} year + flag · ${s.noCountry} year alone (no country known) · ${s.flagMissing} year alone (flag missing${CACHE_ONLY ? ", --cache-only downloads nothing" : ""}) · flags: ${s.flagsDownloaded} downloaded now${s.flagsFailed ? `, ${s.flagsFailed} FAILED` : ""}${s.flagUnreadable ? `, ${s.flagUnreadable} unreadable by the drawing` : ""} · ${flagOnly} flag alone (year unknown)`);
    return r;
  } catch (e) {
    for (const [item,poster] of originalPosters) if (item.poster !== poster) {
      if (poster === undefined) delete item.poster; else item.poster=poster;
    }
    log(`  ! Covers: ${e.message} — every film keeps the cover address it had`);
    return null;
  }
}

/**
 * --self-test-guard, part 1: slip films you have watched into the PLAN (in memory only; nothing is published), before
 * the guard flattens it, so the test goes through the same path as the real thing:
 *   - Board row Friends loved: by TMDB id                       → refused
 *   - a Discover file of Lists (unseen): by TMDB id, by Letterboxd slug, by IMDb id, by title only → each refused
 *   - a Discover file of the exempt Lists                        → let through
 *   - with config.json "board": the same film in the first row of the v2 Board (plan.board2) → refused, under the key "<row id>/v2"
 */
function plantSeenFilm(plan, all, { seenSlugs, seenTts }) {
  const f = all.find((x) => x.watched && x.tmdbId);
  if (!f) throw new Error("self-test needs at least one watched film matched to TMDB");
  const it = (id, o) => ({ id, tmdb: null, slug: null, title: "Self-test", year: 1900, why: ["self-test"], ...o });
  const planted = {
    board: it("tt0000001", { tmdb: f.tmdbId, title: f.title, year: f.year }),
    tmdb: it("tt0000001", { tmdb: f.tmdbId, title: "Self-test by TMDB id" }),
    title: it("tt0000003", { title: f.title, year: f.year }),
    ...(seenSlugs.size ? { slug: it("tt0000002", { slug: [...seenSlugs][0], title: "Self-test by slug" }) } : {}),
    ...(seenTts.size ? { tt: it([...seenTts][0], { title: "Self-test by IMDb id" }) } : {}),
  };
  const catalog = (id) => plan.discover.find((c) => c.id === id) || plan.discover[plan.discover.push({ id, name: id, options: [] }) - 1];
  const board = plan.board.find((r) => r.id === "friends-love") || plan.board[plan.board.push({ id: "friends-love", name: "friends-love", items: [] }) - 1];
  board.items.unshift(planted.board);
  const v2Row = (plan.board2 || []).find((r) => !r.series && !GUARD_EXEMPT.includes(r.id)); // not Old friends, which may hold seen films
  if (v2Row) v2Row.items.unshift(planted.board);
  catalog("mood-engine-lists-unseen").options.push({ label: "__self-test__", items: Object.entries(planted).filter(([k]) => k !== "board").map(([, v]) => v) });
  catalog("mood-engine-lists").options.push({ label: "__self-test__", items: [planted.tmdb] });
  return { film: f, planted, v2Row: v2Row ? v2Row.id : null };
}

/** --self-test-guard, part 2: the guard must have named every planted film in the first two places and none in the exempt one. Exit 0 if so, 2 if not. */
function finishSelfTest(leaks, { film: f, planted, v2Row }) {
  const at = (item, where) => leaks.find((l) => l === `${item.title} (${item.year}) in ${where}`);
  const U = "mood-engine-lists-unseen/genre=__self-test__", E = "mood-engine-lists/genre=__self-test__";
  const checks = [["Board row", planted.board, "friends-love"], ...Object.entries(planted).filter(([k]) => k !== "board").map(([k, v]) => [`Discover file, by ${k}`, v, U])];
  const missed = checks.filter(([, item, where]) => !at(item, where));
  const exempt = at(planted.tmdb, E);
  if (v2Row && !at(planted.board, `${v2Row}/v2`)) missed.push(["Board v2 row", planted.board, `${v2Row}/v2`]);
  if (missed.length || exempt) {
    console.error(`✖ self-test FAILED for ${f.title}: LET THROUGH → ${missed.map((m) => m[0]).join("; ") || "nothing"}${exempt ? " · REFUSED in the exempt Lists (it should be exempt)" : ""}`);
    process.exit(2);
  }
  console.log(`✔ self-test: the guard refused the planted film → ${at(planted.board, "friends-love")}`);
  if (v2Row) console.log(`✔ self-test: and in a row of the v2 Board → ${at(planted.board, `${v2Row}/v2`)}`);
  console.log(`✔ self-test: and in a Discover file, ${checks.slice(1).map((c) => c[0].replace("Discover file, ", "")).join(" · ")} → ${checks.length - 1} of ${checks.length - 1} refused (e.g. ${at(planted.tmdb, U)})`);
  console.log(`✔ self-test: and let it through in the exempt catalog (${GUARD_EXEMPT.join(", ")}) as designed`);
  process.exit(0);
}

function buildWebData({ cands, ranked, rows, rewatch, moods, model, fp, all, today, listsOf = () => [] }) {
  const keep = new Set();
  for (const m of moods) (ranked[m.id] || []).slice(0, 90).forEach((c) => keep.add(c.film.id));
  for (const list of Object.values(rows)) list.forEach((x) => keep.add(x.tmdb));
  cands.filter((c) => c.watchlist).forEach((c) => keep.add(c.film.id));

  const pack = (f, extra, lists = listsOf(f.imdb)) => {
    const fits = {}, hits = {};
    for (const m of moods) {
      const r = fit(f, m, { lists });
      if (r.ok || extra.pins?.includes(m.id)) { fits[m.id] = +r.norm.toFixed(2); if (r.hits.length) hits[m.id] = r.hits; }
    }
    return {
      t: f.id, i: f.imdb, n: f.title, y: f.year, r: f.runtime, p: f.poster, b: f.backdrop,
      o: f.overview.length > 300 ? f.overview.slice(0, 297).replace(/\s+\S*$/, "") + "…" : f.overview,
      d: (f.directors || []).map((d) => d.name).slice(0, 2), g: f.genres.slice(0, 3), l: f.lang,
      va: +f.va.toFixed(1), vc: f.vc, lb: null, f: fits, h: hits, ...extra, // Q supplies unrounded community and configured-friend evidence.
    };
  };

  // Pack the selected candidates once; Q filters the resulting projection.
  const filmsOut = cands.filter((c) => keep.has(c.film.id))
    .map((c) =>
      pack(c.film, {
        ts: +c.tasteZ.toFixed(2), q: +c.qualityZ.toFixed(2), w: c.watchlist ? 1 : 0, pins: c.pins.length ? c.pins : undefined,
        why: reasons(c.contributions, 2), seed: c.seeds[0] ? `${c.seeds[0].title}|${c.seeds[0].rating}` : undefined, ...(LW.publicWeight(c.lw) !== undefined ? { lw: LW.publicWeight(c.lw) } : {}), // rounded first: a weight that rounds to 0 is not published (review S3-A)
      })
    );
  const rewatchOut = rewatch.map((r) => pack(r.film, { rating: r.rating, last: r.lastSeen || null }));

  return {
    generated: capturedAt,
    today,
    moods: moods.map((m) => ({ id: m.id, name: m.name, word: m.word, blurb: m.blurb, season: m.season, minRuntime: undefined })),
    stats: { watched: all.filter((f) => f.watched).length, rated: model.count, watchlist: all.filter((f) => f.watchlist).length, candidates: cands.length },
    fingerprint: fp,
    tonight: rows.tonight.map((x) => x.tmdb),
    films: filmsOut,
    rewatch: rewatchOut,
  };
}
