#!/usr/bin/env node
// One-off bulk fill of the `trailer` field of cache/tmdb.json (Marco, 20/10/2026; docs/2026-10-20-meta-pagina-de-detalhe-spec.md, Fatia 2, 2.1).
//
//   TMDB_TOKEN=… node scripts/backfill-trailers.js --budget 12000     # asks TMDB about every film cached without a `trailer`, up to 12,000 of them
//   node scripts/backfill-trailers.js --dry-run                        # only counts; asks nothing and needs no key
//   node scripts/backfill-trailers.js --budget 20                      # a pilot: look at the `null`s before the big run
//   TMDB_TOKEN=… node scripts/backfill-trailers.js --retry-null        # also asks again the films cached with `trailer: null` (after the 20/10/2026 change to the languages asked)
//   TMDB_TOKEN=… node scripts/backfill-trailers.js --repick            # asks again EVERY film that has the `trailer` key (a trailer or null) and redoes the pick (Marco, 21/10/2026: English before official)
//
// Options: --budget N (default: every film that needs it), --dry-run, --retry-null, --repick, --cache file (default cache/tmdb.json), --concurrency N (default 8), --save-every N (default 1000).
// The films are the cached records that have no `trailer` key at all (lib/tmdb.js needsTrailer): oldest cache entry first (the ones nearest their 45-day
// expiry), then lowest TMDB id. With --retry-null the ones cached with `trailer: null` come too, AFTER the never-asked ones (same order inside each group);
// a film that has a trailer is never asked again by this script, except with --repick.
// --repick (Marco, 21/10/2026): pickTrailer now puts English before official, but the cache keeps only the chosen key, so a film that has an official trailer
// in another language where an unofficial English one exists was chosen with the old order. --repick asks again every film that HAS the key (a trailer or null),
// oldest cache entry first, then lowest id, within --budget; the films never asked (no key) are not in it. Only the `trailer` of each record is replaced: the rest of
// the record and its date stay, so the index does not move. Ends with "repicked N · changed M" (N asked and answered, M of them whose key is now another or none).
// It cannot be combined with --retry-null (--repick already asks the nulls).
// Exit code: 0 when the run ended (even with some errors, which are counted), 1 when it gave up (20 asks failed in a row, or TMDB rejected the key; what was done is saved), 2 for a bad call. Each one goes through Tmdb.movie(id), the build's own client: same request, same retries and 429 back-off (Retry-After),
// same trim(), same save() (written whole, then renamed: the file has the format the build writes). A film asked and without a trailer is saved as
// `trailer: null` and is not asked again before its expiry; one whose ask failed stays without the key, for the next run (or the nightly build).
// TMDB_TOKEN (or TMDB_API_KEY) is read from the environment and never printed; no message here carries it. Offline (OFFLINE set) is refused: it would ask nothing.
// Run it at low priority: `taskpolicy -b nice -n 19 node scripts/backfill-trailers.js …`.

const fs = require("fs");
const path = require("path");
const { Tmdb, needsTrailer } = require("../lib/tmdb");
const { mapLimit } = require("../lib/util");

const DEFAULT_CACHE = path.join(__dirname, "..", "cache", "tmdb.json");

function parseArgs(argv) {
  const out = { budget: null, dryRun: false, retryNull: false, repick: false, cache: DEFAULT_CACHE, concurrency: 8, saveEvery: 1000 };
  const whole = (name, v, min) => { const n = Number(v); if (!/^\d+$/.test(String(v)) || n < min) throw new Error(`${name} needs a whole number of ${min} or more, got ${JSON.stringify(v)}`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--retry-null") out.retryNull = true;
    else if (a === "--repick") out.repick = true;
    else if (a === "--budget") out.budget = whole(a, argv[++i], 1);
    else if (a === "--concurrency") out.concurrency = whole(a, argv[++i], 1);
    else if (a === "--save-every") out.saveEvery = whole(a, argv[++i], 1);
    else if (a === "--cache") { if (!argv[i + 1]) throw new Error("--cache needs a file"); out.cache = path.resolve(argv[++i]); }
    else throw new Error(`unknown option ${a}`);
  }
  if (out.repick && out.retryNull) throw new Error("--repick and --retry-null cannot be used together: --repick already asks the films cached with null");
  return out;
}

/** The ids to ask, in order: cached records with no `trailer` key (with `retryNull`, then those with `trailer: null`), oldest cache entry first, then lowest id. With `repick`: only the records that HAVE the key (a trailer or null), in the same order. `cache` is the parsed cache/tmdb.json. */
function pending(cache, { retryNull = false, repick = false } = {}) {
  const never = (e) => !Object.hasOwn(e.v, "trailer");
  return Object.entries(cache.movie || {})
    .filter(([, e]) => needsTrailer(e, { retryNull, repick })) // with repick, needsTrailer itself leaves the never-asked out (review of 21/10/2026)
    .sort((a, b) => (never(b[1]) - never(a[1])) || (a[1].t - b[1].t) || (Number(a[0]) - Number(b[0])))
    .map(([id]) => id);
}

function tally(cache) {
  const t = { records: 0, withTrailer: 0, nullTrailer: 0, noKey: 0, noRecord: 0 };
  for (const e of Object.values(cache.movie || {})) {
    t.records++;
    if (!e || !e.v) t.noRecord++;
    else if (typeof e.v.trailer === "string") t.withTrailer++;
    else if (e.v.trailer === null) t.nullTrailer++;
    else t.noKey++;
  }
  return t;
}

/** Runs the backfill. `deps`: { fetchImpl, sleepImpl, log, env, handleSignals }. Returns { code, … counts }; it does not call process.exit. */
async function main(argv, deps = {}) {
  const { fetchImpl, sleepImpl, log = console.log, env = process.env, handleSignals = false, exit = (c) => process.exit(c) } = deps;
  let opt;
  try { opt = parseArgs(argv); } catch (e) { log(`✖ ${e.message}`); return { code: 2 }; }
  if (!fs.existsSync(opt.cache)) { log(`✖ no cache at ${opt.cache}`); return { code: 2 }; }
  const cache = JSON.parse(fs.readFileSync(opt.cache, "utf8"));
  const ids = pending(cache, { retryNull: opt.retryNull, repick: opt.repick });
  const todo = opt.budget ? ids.slice(0, opt.budget) : ids;
  const before = tally(cache);
  log(`cache ${path.relative(process.cwd(), opt.cache) || opt.cache}: ${before.records} film records, ${before.withTrailer} with a trailer, ${before.nullTrailer} asked and without, ${before.noKey} never asked${opt.retryNull ? " (--retry-null: the asked-and-without ones are asked again too)" : ""}${opt.repick ? " (--repick: the ones with a trailer and the asked-and-without ones are asked again; the never asked are not)" : ""}, ${before.noRecord} with no record (TMDB said 404)`);

  if (opt.dryRun) {
    log(`dry run: would ask ${todo.length} of ${ids.length} films ${opt.repick ? "that have the trailer key" : `without ${opt.retryNull ? "a trailer" : "the trailer key"}`} (budget ${opt.budget ?? "all"}); nothing was asked, nothing was written`);
    return { code: 0, dryRun: true, wouldAsk: todo.length, never: ids.length, ...before };
  }
  if (env.OFFLINE) { log("✖ OFFLINE is set: a backfill asks TMDB and offline asks nothing. Unset OFFLINE."); return { code: 2 }; }
  const token = env.TMDB_TOKEN || env.TMDB_API_KEY;
  if (!token) { log("✖ TMDB_TOKEN is not set (see README → 'TMDB key'). Use --dry-run to count without a key."); return { code: 2 }; }
  if (!todo.length) { log(opt.repick ? "nothing to ask: no film record has the trailer key (--repick asks only those)" : "nothing to ask: every film record already has the trailer key"); return { code: 0, asked: 0, withTrailer: 0, nullTrailer: 0, errors: 0 }; }

  const tmdb = new Tmdb(token, opt.cache, { concurrency: opt.concurrency, trailerBudget: todo.length, trailerRetryNull: opt.retryNull, trailerRepick: opt.repick, ...(fetchImpl ? { fetchImpl } : {}), ...(sleepImpl ? { sleepImpl } : {}), log });
  const sigint = () => { tmdb.save(); log("interrupted: cache saved with what was done"); exit(130); };
  if (handleSignals) process.once("SIGINT", sigint);
  const pickBefore = new Map(todo.map((id) => [id, { t: cache.movie[id].t, trailer: cache.movie[id].v.trailer }])); // --repick: the key each one had, and its date (a repicked record keeps its date; one renewed by the client's normal path, because it had expired, gets a new one and is counted in neither N nor M)
  const wasNull = new Set(todo.filter((id) => cache.movie[id].v.trailer === null)); // asked again by --retry-null
  let thrown = 0, done = 0, authFailed = null;
  try {
    await mapLimit(todo, opt.concurrency * 2, async (id) => {
      if (authFailed) return;
      try { await tmdb.movie(id); } catch (e) {
        if (e.auth) { authFailed = e; return; }
        thrown++; log(`  ! movie ${id}: ${e.message}`);
      }
      if (++done % opt.saveEvery === 0) { tmdb.save(); log(`  … ${done} of ${todo.length} asked, cache saved`); }
    });
  } finally {
    if (handleSignals) process.removeListener("SIGINT", sigint);
    tmdb.save();
  }

  let withTrailer = 0, nullTrailer = 0, unresolved = 0, recovered = 0;
  for (const id of todo) {
    const t = tmdb.cache.movie[id]?.v?.trailer;
    if (typeof t === "string") { withTrailer++; if (wasNull.has(id)) recovered++; } else if (t === null) nullTrailer++; else unresolved++;
  }
  if (opt.repick) unresolved = tmdb.trailerFailed; // --repick: every record has the key, so "no key" is always 0; what is left is the films whose ask failed and kept the old pick
  const errors = tmdb.trailerFailed + thrown;
  const after = tally(tmdb.cache);
  let changed = 0; // --repick: asked, answered, and the key is now another one or none
  if (opt.repick) for (const [id, b] of pickBefore) { const e = tmdb.cache.movie[id]; if (e && e.t === b.t && e.v && e.v.trailer !== b.trailer) changed++; }
  const repicked = Math.max(0, tmdb.trailerAsked - tmdb.trailerFailed); // asks that got an answer
  log(`asked ${tmdb.trailerAsked} (${tmdb.calls} HTTP tries) · with a trailer ${withTrailer} · null (none on TMDB) ${nullTrailer} · errors ${errors} · ${opt.repick ? "kept the old pick (ask failed)" : "left without an answer"} ${unresolved}`);
  if (opt.retryNull) log(`asked again: ${wasNull.size} films that had null · now with a trailer: ${recovered}`);
  if (opt.repick) log(`repicked ${repicked} · changed ${changed}`);
  log(`cache now: ${after.withTrailer} with a trailer, ${after.nullTrailer} asked and without, ${after.noKey} never asked`);
  if (authFailed) { log(`✖ ${authFailed.message} The run stopped; what was done is saved.`); return { code: 1, asked: tmdb.trailerAsked, withTrailer, nullTrailer, errors, unresolved }; }
  if (tmdb.trailerStopped) { log("✖ gave up: 20 asks failed in a row (TMDB or the network is down). What was done is saved; run it again later."); return { code: 1, stopped: true, asked: tmdb.trailerAsked, withTrailer, nullTrailer, errors, unresolved, recovered }; }
  return { code: 0, asked: tmdb.trailerAsked, withTrailer, nullTrailer, errors, unresolved, recovered, tries: tmdb.calls, ...(opt.repick ? { repicked, changed } : {}) };
}

module.exports = { main, parseArgs, pending, tally };

if (require.main === module) {
  main(process.argv.slice(2), { handleSignals: true }).then((r) => { process.exitCode = r.code; }, (e) => { console.error(`✖ ${e.message}`); process.exitCode = 1; });
}
