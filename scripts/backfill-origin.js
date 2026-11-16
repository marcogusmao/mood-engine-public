#!/usr/bin/env node
// One-off, OFFLINE fill of the `origin` field (TMDB's `origin_country`) of cache/tmdb.json (Marco, 22/10/2026, questionnaire 3b: the main country of a film is the
// one TMDB names as its origin; lib/countries.js mainCountry). It asks nobody: the answers come from a file.
//
//   node scripts/backfill-origin.js --from some.json                  # writes `origin` into the cached records the file has an answer for
//   node scripts/backfill-origin.js --from some.json --dry-run        # only counts
//   node scripts/backfill-origin.js --from some.json --cache other.json
//
// The file is an object `{ "<tmdbId>": ["GB"] | ["US","GB"] | [] | {"http":404} | {"err":"…"} }` (the answers of /3/movie/{id}`.origin_country`, fetched by the session of 22/10/2026;
// the file itself is not versioned: `.context/` is ignored). ONLY arrays whose items are two capital letters count; a failure ({"http":…}, {"err":…}), anything else, an id the cache does
// not hold and a cached record that is empty (`v: null`: TMDB has no film there) are ignored and counted. An empty array is an answer ("asked, no origin") and is written as `origin: []`.
// The key goes right after `countries`, where lib/tmdb.js trim() puts it for a record fetched from now on; the rest of every record, its date `t` and the order of the records stay
// (the index does not move for this alone: a record with `origin: []` or no `origin` reads like the rule of 14/10/2026).
// The file is written whole, then renamed, in the format the build writes (JSON.stringify without spaces). Exit code: 0 when it ended, 2 for a bad call.
// Prints: received (a record that now has `origin`; `changed` of them had another value or none), unchanged, ignored by reason.
// Run it at low priority: `taskpolicy -b nice -n 19 node scripts/backfill-origin.js …`.
//
// MERGING THIS BRANCH WHEN THE MAIN HAS A NEWER cache/tmdb.json (the nightly commits the cache; the file is ONE line, so git always reports a conflict, and "keep the main's cache"
// silently erases the 11,740 `origin` keys: nothing would turn red but test/origin-country.test.js "the committed cache carries origin"). The procedure (review of 22/10/2026):
//   1. drop the commit "Update TMDB cache: origin_country for 11,740 films" (the commit that has no code, only cache/tmdb.json: 4449e12 after the rebase of 23/10/2026, 818e200 before it; whatever its hash on the day) and keep the main's cache/tmdb.json as it is;
//   2. run `taskpolicy -b nice -n 19 node scripts/backfill-origin.js --from <the answers file>` over it (it is deterministic: same file + same cache = same bytes) and commit the cache again.
//   The answers file (not versioned; TMDB's public answers, no secret) is kept at Google Drive, My Drive/Backup Mood Engine/2026-10-22-tmdb-origin-country.json (sha256 69737270fb71…),
//   and in `.context/tmdb-origin-country-2026-10-22.json` of the area that made it. Until this branch is merged, a record the nightly fetches or renews has NO `origin` (the main's trim() does not keep it; 298 records on 23/10/2026 were in that case); after the merge trim() writes
//   it, and the file rewrites a record's `origin` only if the file has its id.

const fs = require("fs");
const path = require("path");

const DEFAULT_CACHE = path.join(__dirname, "..", "cache", "tmdb.json");

function parseArgs(argv) {
  const out = { from: null, cache: DEFAULT_CACHE, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--from") { if (!argv[i + 1]) throw new Error("--from needs a file"); out.from = path.resolve(argv[++i]); }
    else if (a === "--cache") { if (!argv[i + 1]) throw new Error("--cache needs a file"); out.cache = path.resolve(argv[++i]); }
    else throw new Error(`unknown option ${a}`);
  }
  if (!out.from) throw new Error("--from <file> is required (the answers: { \"<tmdbId>\": [\"GB\"], … })");
  return out;
}

const isOrigin = (v) => Array.isArray(v) && v.every((c) => typeof c === "string" && /^[A-Z]{2}$/.test(c));

/** A copy of `v` with `origin` right after `countries` (the key order trim() writes); at the end when the record has no `countries`. */
function withOrigin(v, origin) {
  const out = {};
  let placed = false;
  for (const [k, x] of Object.entries(v)) {
    if (k === "origin") continue;
    out[k] = x;
    if (k === "countries") { out.origin = origin; placed = true; }
  }
  if (!placed) out.origin = origin;
  return out;
}

/**
 * Writes the answers into `cache.movie[id].v.origin` (in place). `answers`: the parsed file.
 * → { received, changed, unchanged, ignored: { notAnArray, notInCache, emptyRecord } }
 */
function backfill(cache, answers) {
  const n = { received: 0, changed: 0, unchanged: 0, ignored: { notAnArray: 0, notInCache: 0, emptyRecord: 0 } };
  const movie = (cache && cache.movie) || {};
  for (const [id, origin] of Object.entries(answers || {})) {
    if (!isOrigin(origin)) { n.ignored.notAnArray++; continue; }
    const e = Object.hasOwn(movie, id) ? movie[id] : undefined;
    if (e === undefined) { n.ignored.notInCache++; continue; }
    if (!e || !e.v || typeof e.v !== "object") { n.ignored.emptyRecord++; continue; }
    n.received++;
    if (Array.isArray(e.v.origin) && e.v.origin.length === origin.length && e.v.origin.every((c, i) => c === origin[i])) { n.unchanged++; continue; }
    n.changed++;
    e.v = withOrigin(e.v, [...origin]);
  }
  return n;
}

function main(argv, { log = console.log } = {}) {
  let opt;
  try { opt = parseArgs(argv); } catch (e) { log(`✖ ${e.message}`); return { code: 2 }; }
  for (const [what, file] of [["answers", opt.from], ["cache", opt.cache]]) if (!fs.existsSync(file)) { log(`✖ no ${what} file at ${file}`); return { code: 2 }; }
  let answers, cache;
  try { answers = JSON.parse(fs.readFileSync(opt.from, "utf8")); cache = JSON.parse(fs.readFileSync(opt.cache, "utf8")); } catch (e) { log(`✖ not JSON: ${e.message}`); return { code: 2 }; }
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) { log("✖ the answers file must be an object { \"<tmdbId>\": [...] }"); return { code: 2 }; }
  const n = backfill(cache, answers);
  if (!opt.dryRun && n.changed) {
    const tmp = `${opt.cache}.${process.pid}.tmp`; // written whole, then renamed: a reader never meets half a file
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, opt.cache);
  }
  const i = n.ignored;
  log(`origin: received ${n.received} (changed ${n.changed}, already there ${n.unchanged}) · ignored ${i.notAnArray + i.notInCache + i.emptyRecord} (not an array of codes ${i.notAnArray}, id not in the cache ${i.notInCache}, empty record ${i.emptyRecord})${opt.dryRun ? " · dry run, nothing written" : ""}`);
  return { code: 0, ...n };
}

if (require.main === module) process.exit(main(process.argv.slice(2)).code);

module.exports = { main, backfill, withOrigin, parseArgs, isOrigin };
