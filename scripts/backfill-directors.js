#!/usr/bin/env node
// One-off, OFFLINE fill of cache/directors.json (the citizenship of the film directors, lib/directors.js) from a file of Wikidata answers (Marco, 23/10/2026: the director's country is the first
// layer of the main country of a film, lib/countries.js mainCountry). It asks nobody: the nightly build asks for the directors that are not in the cache yet.
//
//   node scripts/backfill-directors.js --from answers.json --at 2026-10-22            # writes the cache from the file
//   node scripts/backfill-directors.js --from answers.json --at 2026-10-22 --dry-run  # only counts
//   node scripts/backfill-directors.js --from answers.json --cache other.json
//
// The file is the one the session of 22/10/2026 fetched: { "<TMDB person id>": { "found": true, "cit": [{ "label": "Mexico", "iso": "MX" }, …] } } (6,077 directors, 4,981 with a citizenship;
// an `{ "error": … }` entry is ignored). Not versioned (`.context/`); a copy is kept at Google Drive, My Drive/Backup Mood Engine/2026-10-22-directors-wikidata.json.
// `--at` is the date written as `t` in the new entries (a date, or milliseconds): the file's own date, so that running it again over the same cache gives the same bytes (an entry whose
// citizenship is already nonempty keeps its order and `t`, whatever the file answers; an identical empty answer also keeps `t`). Default: now.
// The cache is written whole, then renamed. Exit code: 0 when it ended, 2 for a bad call. Prints: received (changed / already there), with a citizenship, ignored.
// Run it at low priority: `taskpolicy -b nice -n 19 node scripts/backfill-directors.js …`.
//
// MERGING THIS BRANCH when the main has a newer cache/directors.json (the nightly commits it, like cache/tmdb.json): keep the main's file and run this script over it with the same answers file
// (it only fills missing or empty entries; every nonempty entry of the main keeps its order and date); `test/origin-country.test.js` "the committed caches carry origin and the directors' citizenship" is red if the file is lost.

const fs = require("fs");
const path = require("path");
const DR = require("../lib/directors");

function parseArgs(argv) {
  const out = { from: null, cache: DR.FILE, dryRun: false, at: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--from") { if (!argv[i + 1]) throw new Error("--from needs a file"); out.from = path.resolve(argv[++i]); }
    else if (a === "--cache") { if (!argv[i + 1]) throw new Error("--cache needs a file"); out.cache = path.resolve(argv[++i]); }
    else if (a === "--at") {
      const v = argv[++i];
      const ms = /^\d{10,}$/.test(String(v)) ? Number(v) : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? Date.parse(`${v}T00:00:00.000Z`) : NaN;
      if (!Number.isFinite(ms)) throw new Error(`--at needs a date (YYYY-MM-DD) or milliseconds, got ${JSON.stringify(v)}`);
      out.at = ms;
    } else throw new Error(`unknown option ${a}`);
  }
  if (!out.from) throw new Error("--from <file> is required (the answers: { \"<TMDB person id>\": { \"cit\": [{ \"label\", \"iso\" }] } })");
  return out;
}

function main(argv, { log = console.log } = {}) {
  let opt;
  try { opt = parseArgs(argv); } catch (e) { log(`✖ ${e.message}`); return { code: 2 }; }
  if (!fs.existsSync(opt.from)) { log(`✖ no answers file at ${opt.from}`); return { code: 2 }; }
  let answers, cache;
  try {
    answers = JSON.parse(fs.readFileSync(opt.from, "utf8"));
    cache = DR.load(opt.cache);
  } catch (e) { log(`✖ ${e.message}`); return { code: 2 }; }
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) { log("✖ the answers file must be an object { \"<TMDB person id>\": { … } }"); return { code: 2 }; }
  const n = DR.backfill(cache, answers, opt.at ?? Date.now());
  if (!opt.dryRun && n.changed) DR.save(cache, opt.cache);
  log(`directors: received ${n.received} (changed ${n.changed}, already there ${n.unchanged}) · with a citizenship ${n.withCitizenship} · ignored ${n.ignored}${opt.dryRun ? " · dry run, nothing written" : ""}`);
  return { code: 0, ...n };
}

if (require.main === module) process.exit(main(process.argv.slice(2)).code);

module.exports = { main, parseArgs };
