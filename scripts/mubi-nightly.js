#!/usr/bin/env node
// The nightly MUBI step (Marco, 13/10/2026): the Our Take text enters the public descriptions with the credit "MUBI: ", and the cache grows in daily batches of
// at most 100 requests, Tonight first, then the watchlist, then the other Board rows. Runs before `node build.js` in scripts/noturna-mac.sh --agendada since 21/10/2026 (the nightly runs on Marco's Mac; before that, in .github/workflows/mood-engine.yml).
//
//   node scripts/mubi-nightly.js [--root dir] [--index file] [--collector file.py] [--max-requests 100] [--interval 2.0] [--now ISO]
//
// The ceiling is 100 requests per DAY, not per run (review of 14/10/2026: the workflow also runs on every push to main, up to 18 in one day (13/10), and on dispatch). Two locks:
// the workflow step runs only on the schedule (`if: github.event_name == 'schedule'`), and this script refuses to run when cache/mubi-report.json already carries
// today's date (UTC): whatever happened that day, success or not, nothing is asked twice. `--now` is for the tests (the clock of the run).
// 21/10/2026: on the Mac the same two locks are scripts/noturna-mac.sh (only --agendada calls this script, once per UTC date by the local mark `mubi-dia`, killed with its process group at 10 minutes) and the report above.
//
// What it does, in this order:
//  1. Reads cache/mubi.json (none yet is fine; one that does not parse stops the step, the file is never overwritten).
//  2. Takes the Board's films from an index of the build: the file given with --index (the night on the Mac, since 15/11/2026: the Board of the last published site, see
//     scripts/noturna-mac.sh coletar_mubi), else docs/data/index-board.json when it exists (a local build) or, where docs/ is not there (CI; a clone that has published nothing yet),
//     from an offline build that reads only the caches and config.json (`node build.js --offline --cache-only --skip-posters`, no network).
//     Order: Tonight, then the watchlist, then the other rows in the Board's own order; a film in two rows counts once, in the first.
//  3. Leaves out the films that need no request: confirmed ones (unless stale), the ones MUBI did not know or could not tell apart within the last 30
//     days (COOLDOWN_DAYS: without this the same unfindable films would take the first requests of every night and the batch would never move on) and
//     the errors of today. Errors and stale films are asked again, but LAST and OLDEST ATTEMPT FIRST: three failures in a row stop the collector, errors at
//     the front of the queue would stop it before a new film was reached, and, in Board order, three films that fail for good (search-5xx-slug-404,
//     slug-fallback-mismatch, detail-id-mismatch) at the top would be asked first every day and shut out the other failed films for ever. A film that
//     failed gets a new attempt time every time, so the permanent failures rotate to the back.
//  4. Runs scripts/collect-mubi.py on a COPY of the cache in a temporary folder, with --max-requests 100 and --interval 2.0, the first 100 films of that list.
//     No --resume: the collector's own plain run already skips what is confirmed, and --resume means "continue a --refresh that stopped" (it refuses
//     to run without one and would ask again for films already confirmed).
//  5. Merges the result into cache/mubi.json (lib/mubi-cache.js mergeCaches: no record of the old file is ever lost; a new record with a field off the allowlist is
//     refused) and writes cache/mubi-report.json (the date, requests made, films delivered and films really asked, found, without Our Take, why it stopped).
//
// It NEVER fails the night: a collector that stops (403, 429, challenge, three failures), crashes or hangs leaves the cache as it was, or with the films it
// finished, and the process exits 0, so the build runs on whatever cache exists. An error of the step itself (the merge, say) is NOT swallowed in silence: the
// report is written with status "merge-failed" (or "failed") and the message, and the log carries a warning. The collector itself stops at the first
// 403/429/challenge and never works around it. No secret is read or sent: api.mubi.com is public. What goes on the wire is fixed in scripts/collect-mubi.py:
// the film's title as the query (`/v3/search/films?query=<title>&per_page=10`, or `/v3/films/<id or slug>`), the headers Client: web, Client-Country: US,
// Accept-Language: en, Accept, Accept-Encoding and a User-Agent that names the project and its repository address; no cookie, e-mail, token or login.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const MC = require("../lib/mubi-cache");
const { decode } = require("../lib/index-rows");

const MAX_REQUESTS = 100;
const INTERVAL = 2.0;
const COOLDOWN_DAYS = 30;
const COLLECTOR_TIMEOUT_MS = 6 * 60 * 1000; // 100 requests at 2 s is about 4 minutes; 6 + the prep build's 2 fit the workflow step's 10, with room for the merge
// The offline build took about 25 s on a laptop when this was written (13/10/2026). It no longer does: measured 15/11/2026, 13:58 UTC, on Marco's Mac, the same build (--offline --cache-only
// --skip-posters on a copy of the day's caches, run by test/tmdb-no-record-build.test.js at the lowest priority, load average 4.5) took 92 s, and inside the night it did not end in these 2 minutes on
// 22/10 nor on any scheduled night from 30/10 to 15/11/2026: 17 nights in a row of "board-build-failed: 0 films delivered to the collector". The limit was NOT raised: with the collector's 6 minutes
// it has to fit the step's 10 (the test below). Since 15/11/2026 the night on the Mac does not come here: scripts/noturna-mac.sh hands this script the Board of the last published site with
// --index, read from Git. This build is what is left for a clone that has published nothing yet, and for the workflow.
const PREP_TIMEOUT_MS = 2 * 60 * 1000; // a build that needs more ends the step quietly (board-build-failed)
const FIRST_ROWS = ["tonight", "watchlist"];

const emptyCache = (at) => ({ schema: 1, source: "api.mubi.com/v3", updatedAt: at, films: {} });
const isoNow = () => new Date().toISOString();

/** The index file → its object form, whether it is the rows format the build writes or the object form. */
function readIndex(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return raw && raw.cols ? decode(raw) : raw;
}

/** Row ids in the order films are taken: Tonight, the watchlist, then the rest as the Board lists them (rows the Board does not list come last). */
function rowOrder(index) {
  const rows = index.rows || {};
  const board = (index.board || []).map((r) => r.id);
  const rest = [...board, ...Object.keys(rows)].filter((id, i, a) => a.indexOf(id) === i && !FIRST_ROWS.includes(id));
  return [...FIRST_ROWS, ...rest].filter((id) => Array.isArray(rows[id]));
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Does this cache record mean "do not ask again yet"? Confirmed and not stale: always. Not found / ambiguous: for COOLDOWN_DAYS after it was captured.
 * An error (or a stale film whose refresh failed): for the rest of the day it happened (the UTC date), so a run on the same day does not ask it again.
 */
function settled(record, today) {
  if (!record || typeof record !== "object") return false;
  if (record.status === "confirmed" && !record.stale) return true;
  if (record.status === "not_found_in_search" || record.status === "ambiguous") {
    const at = Date.parse(record.capturedAt);
    return Number.isFinite(at) && today - at < COOLDOWN_DAYS * 86400000;
  }
  const failedAt = Date.parse(record.status === "error" ? record.capturedAt : record.lastError && record.lastError.at);
  return Number.isFinite(failedAt) && dayOf(failedAt) === dayOf(today);
}

/** A film asked before that failed (an error, or a confirmed film whose refresh failed): asked again, but after every film never asked. */
const isRetry = (record) => !!record && (record.status === "error" || (record.status === "confirmed" && record.stale));

/** When a retry was last tried (ms): an error's capture time, a stale film's last failed refresh; a record that says neither counts as the oldest (0). */
const attemptAt = (record) => {
  const t = Date.parse(record.status === "error" ? record.capturedAt : record.lastError && record.lastError.at);
  return Number.isFinite(t) ? t : 0;
};

/**
 * The films to ask MUBI about, in order, as the collector's --input wants them: [{ imdb, title, year, directors, runtime }].
 * Board order (Tonight, watchlist, the other rows), except that films to be retried come last, the one tried longest ago first. A film the collector could never confirm is left out
 * (no director: its identity check needs one director in common; no usable year or title).
 */
function selectFilms({ index, cache, today = Date.now(), limit = MAX_REQUESTS }) {
  const byTt = new Map((index.films || []).map((f) => [f.tt, f]));
  const fresh = [], retries = [], seen = new Set();
  for (const id of rowOrder(index)) {
    for (const tt of index.rows[id]) {
      if (seen.has(tt)) continue;
      seen.add(tt);
      const f = byTt.get(tt);
      if (!f || !MC.TT.test(tt) || typeof f.name !== "string" || !f.name.trim() || !Number.isInteger(f.year)) continue;
      const directors = typeof f.director === "string" ? f.director.split(",").map((s) => s.trim()).filter(Boolean) : [];
      if (!directors.length) continue;
      if (settled(cache.films[tt], today)) continue;
      const film = { imdb: tt, title: f.name, year: f.year, directors, runtime: Number.isInteger(f.runtime) ? f.runtime : null };
      if (isRetry(cache.films[tt])) retries.push({ film, at: attemptAt(cache.films[tt]) }); else fresh.push(film);
    }
  }
  retries.sort((a, b) => a.at - b.at); // oldest attempt first; the sort is stable, so equal times keep the Board's order
  return [...fresh, ...retries.map((r) => r.film)].slice(0, limit);
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

/** The index of the Board: the given file, else docs/data/index-board.json, else an offline build of the caches into `work`. → { index } or { reason }. */
function boardIndex({ root, indexFile, work, log }) {
  let file = indexFile || path.join(root, "docs", "data", "index-board.json");
  if (!indexFile && !fs.existsSync(file)) {
    const out = path.join(work, "prep");
    log("no docs/data/index-board.json: building the Board from the caches (offline, no network)");
    const env = { ...process.env }; delete env.MUBI_CACHE; // the Our Take must not depend on itself
    const r = spawnSync(process.execPath, [path.join(root, "build.js"), "--offline", "--cache-only", "--skip-posters", "--out", out], { cwd: root, env, encoding: "utf8", timeout: PREP_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    if (r.error || r.status !== 0) {
      log(`the offline build of the Board failed (${r.error ? r.error.code || r.error.message : "exit " + r.status}): ${String(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
      return { reason: "board-build-failed" };
    }
    file = path.join(out, "data", "index-board.json");
  }
  try { return { index: readIndex(file) }; } catch (e) { log(`the Board index cannot be read (${e.message.slice(0, 120)})`); return { reason: "board-index-unreadable" }; }
}

/** The date (UTC, YYYY-MM-DD) of the report already in cache/mubi-report.json, or null when there is none or it is not a report. */
function reportDate(file) {
  const r = readJson(file);
  return r && typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null;
}

/**
 * One nightly step. Never throws for a collector or network problem, and an error of its own (the merge, say) goes into the report, not into silence.
 * → the report that was written, or null when nothing was done (the step already ran today, or cache/mubi.json is not a MUBI cache) or nothing could be written.
 * `merge` is the merge function (the tests replace it to prove that a failing merge is reported).
 */
function run({ root = path.join(__dirname, ".."), indexFile = null, collector = path.join(__dirname, "collect-mubi.py"), maxRequests = MAX_REQUESTS, interval = INTERVAL, now = isoNow, merge = MC.mergeCaches, log = (m) => console.log("MUBI nightly: " + m), warn = (m) => log(m) } = {}) {
  maxRequests = Math.min(Math.max(Math.trunc(maxRequests) || 0, 1), MAX_REQUESTS); // the ceiling is 100: a larger number is not honoured
  const cacheFile = path.join(root, "cache", "mubi.json");
  const reportFile = path.join(root, "cache", "mubi-report.json");
  const at = now();
  const today = Date.parse(at);
  // 100 requests a DAY: a report with today's date (UTC) means the step already ran, whatever came of it (a push, a manual run, a second schedule).
  if (reportDate(reportFile) === at.slice(0, 10)) {
    log(`already ran today (cache/mubi-report.json is of ${at.slice(0, 10)}): nothing is asked again before tomorrow`);
    return null;
  }
  let old;
  if (fs.existsSync(cacheFile)) {
    old = readJson(cacheFile);
    if (!old || old.schema !== 1 || !old.films || typeof old.films !== "object" || Array.isArray(old.films)) {
      warn("cache/mubi.json is not a schema 1 MUBI cache: left untouched, nothing collected tonight");
      return null;
    }
  } else old = emptyCache(at);

  const report = { schema: 1, date: at.slice(0, 10), generatedAt: at, status: "ok", requestsMade: null, requestsMax: maxRequests, filmsDelivered: 0, filmsAsked: 0, found: 0, withoutOurTake: 0, notFound: 0, ambiguous: 0, errors: 0, stopReason: "not-run", collectorExit: null, cache: null };
  const summarize = (cache) => ({ records: Object.keys(cache.films).length, confirmed: Object.values(cache.films).filter((r) => r && r.status === "confirmed").length, withOurTake: Object.values(cache.films).filter((r) => MC.ourTakeOf(r)).length });
  const finish = (cache) => {
    report.cache = summarize(cache);
    const problems = MC.reportProblems(report);
    if (problems.length) { warn("the report is off the allowlist and was not written: " + problems.join("; ")); return null; }
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    writeAtomic(reportFile, JSON.stringify(report, null, 1) + "\n");
    log(`${report.status === "ok" ? report.stopReason : `${report.status} (collector: ${report.stopReason})`}: ${report.filmsDelivered} films delivered to the collector, ${report.filmsAsked} asked with ${report.requestsMade ?? "?"} requests (ceiling ${maxRequests}); found ${report.found}, without Our Take ${report.withoutOurTake}, not found ${report.notFound}, ambiguous ${report.ambiguous}, errors ${report.errors}; cache now ${report.cache.records} records, ${report.cache.withOurTake} with Our Take`);
    return report;
  };

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mubi-nightly-"));
  let stage = "select";
  try {
    const got = boardIndex({ root, indexFile, work, log });
    if (!got.index) { report.stopReason = got.reason; return finish(old); }
    const films = selectFilms({ index: got.index, cache: old, today, limit: maxRequests });
    report.filmsDelivered = films.length;
    if (!films.length) { report.stopReason = "nothing-to-collect"; return finish(old); }

    stage = "collect";
    const out = path.join(work, "out");
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(work, "input.json"), JSON.stringify({ films }));
    if (fs.existsSync(cacheFile)) fs.copyFileSync(cacheFile, path.join(out, "mubi.json")); // the collector keeps what is confirmed and protects it from a failed refresh
    const r = spawnSync("python3", ["-B", collector, "--input", path.join(work, "input.json"), "--out", out, "--max-requests", String(maxRequests), "--interval", Number(interval).toFixed(1)], { cwd: root, encoding: "utf8", timeout: COLLECTOR_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    if (r.stdout) log("collector says:\n" + r.stdout.trimEnd().split("\n").map((l) => "  " + l).join("\n"));
    if (r.stderr) log("collector errors:\n" + r.stderr.trimEnd().split("\n").slice(-8).map((l) => "  " + l).join("\n"));
    report.collectorExit = Number.isInteger(r.status) ? r.status : null;

    const collected = readJson(path.join(out, "report.json"));
    const run0 = collected && collected.thisRun && typeof collected.thisRun === "object" ? collected.thisRun : null;
    if (run0 && run0.requests && Number.isInteger(run0.requests.made)) report.requestsMade = run0.requests.made;
    // The films the collector really asked about (a request made, so a new record came out of it); the others it was handed were never reached.
    if (run0 && run0.outcomes && typeof run0.outcomes === "object") report.filmsAsked = Object.values(run0.outcomes).filter(Number.isInteger).reduce((a, b) => a + b, 0);
    // stopReason is the COLLECTOR's reason; what the merge did is `status` (a failure of the step never overwrites it)
    report.stopReason = "finished";
    if (r.error) report.stopReason = r.error.code === "ETIMEDOUT" ? "collector-timeout" : "collector-not-started";
    else if (run0 && run0.stopped && typeof run0.stopped.reason === "string") report.stopReason = run0.stopped.reason.slice(0, 80);
    else if (r.status !== 0) report.stopReason = `collector-exit-${r.status}`;
    if (report.stopReason !== "finished") warn(`the collector stopped: ${report.stopReason} (exit ${report.collectorExit}); what it finished is kept, the rest waits for another night`);

    const fresh = readJson(path.join(out, "mubi.json"));
    if (!fresh || fresh.schema !== 1 || !fresh.films || typeof fresh.films !== "object") {
      if (report.stopReason === "finished") report.stopReason = "collector-no-output";
      return finish(old);
    }
    stage = "merge";
    const merged = merge(old, fresh);
    for (const x of merged.rejected) warn(`a record of ${x.id} was refused (${x.problems.slice(0, 3).join("; ")}); the old one stays`);
    const touched = [...merged.added, ...merged.replaced].map((id) => merged.cache.films[id]);
    report.found = touched.filter((x) => x.status === "confirmed").length;
    report.withoutOurTake = touched.filter((x) => x.status === "confirmed" && !MC.ourTakeOf(x)).length;
    report.notFound = touched.filter((x) => x.status === "not_found_in_search").length;
    report.ambiguous = touched.filter((x) => x.status === "ambiguous").length;
    report.errors = touched.filter((x) => x.status === "error").length;
    if (touched.length) {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      // The collector's own bytes when it lost and changed nothing of the old file (keeps its number formatting, so the diff is the new films only).
      const same = !merged.rejected.length && !merged.kept.length && JSON.stringify(merged.cache.films) === JSON.stringify(fresh.films) && MC.cacheProblems({ ...fresh, films: {} }).length === 0;
      writeAtomic(cacheFile, same ? fs.readFileSync(path.join(out, "mubi.json")) : JSON.stringify(merged.cache, null, 1) + "\n");
    }
    return finish(merged.cache);
  } catch (e) {
    // Not swallowed in silence: the night goes on (the cache is as it was), but the report says what failed, and the next day's run is not blocked by a lie.
    report.status = stage === "merge" ? "merge-failed" : "failed"; // stopReason keeps what the collector said (or "not-run")
    report.message = `${e && e.name || "Error"} at ${stage}: ${String(e && e.message || e).split("\n")[0]}`.slice(0, 300);
    report.found = report.withoutOurTake = report.notFound = report.ambiguous = report.errors = 0;
    warn(`the step failed at ${stage} (${report.message}); cache/mubi.json is as it was and the build goes on with it`);
    return finish(old);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function main(argv) {
  const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const known = new Set(["--root", "--index", "--collector", "--max-requests", "--interval", "--now"]);
  const bad = argv.filter((a, i) => a.startsWith("--") && !known.has(a));
  const clock = opt("--now");
  if (bad.length || argv.some((a, i) => known.has(a) && (argv[i + 1] === undefined || argv[i + 1].startsWith("--"))) || (clock !== undefined && !Number.isFinite(Date.parse(clock)))) {
    console.error("usage: node scripts/mubi-nightly.js [--root dir] [--index file] [--collector file.py] [--max-requests N] [--interval S] [--now ISO]");
    return 2;
  }
  const gha = process.env.GITHUB_ACTIONS === "true";
  const warn = (m) => console.log(gha ? `::warning title=MUBI nightly::${m}` : "MUBI nightly: " + m);
  try {
    run({
      ...(opt("--root") ? { root: path.resolve(opt("--root")) } : {}), indexFile: opt("--index") ? path.resolve(opt("--index")) : null,
      ...(opt("--collector") ? { collector: path.resolve(opt("--collector")) } : {}),
      ...(opt("--max-requests") ? { maxRequests: Number(opt("--max-requests")) } : {}), ...(opt("--interval") ? { interval: Number(opt("--interval")) } : {}),
      ...(clock ? { now: () => new Date(clock).toISOString() } : {}), warn,
    });
  } catch (e) {
    warn(`the step failed outside its own handling (${String(e && e.stack || e).split("\n").slice(0, 3).join(" | ").slice(0, 300)}); the build goes on with the cache it has`);
  }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { run, selectFilms, rowOrder, settled, isRetry, attemptAt, reportDate, MAX_REQUESTS, INTERVAL, COOLDOWN_DAYS, COLLECTOR_TIMEOUT_MS, PREP_TIMEOUT_MS };
