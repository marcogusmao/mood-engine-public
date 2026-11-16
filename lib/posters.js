// Covers with the ratings drawn on them, built every night and published next to the addon (docs/posters/<tt>.jpg).
//
//   1  every film in every file of the plan is one IMDb id (tt…); the numbers it carries are item.ratings (lib/crowd.js):
//      the Letterboxd average, your people's average and how many saw it, plus the IMDb rating below
//   2  the IMDb rating comes from IMDb's own dataset (title.ratings.tsv.gz, ~7 MB, downloaded once a night) and is kept in
//      cache/imdb-ratings.json, only for the films the files use
//   3  the raw cover is downloaded once (TMDB w342 when the TMDB cache has the film's poster path, else metahub) and kept in
//      cache/posters-raw/, which is NOT committed (the workflow keeps it with actions/cache)
//   4  tools/selo/render.py (Python + Pillow) draws the badges, and in the top-left corner the film's release year and the flag of its
//      country (lib/countries.js; the flag pictures are in cache/flags/, committed): cache/posters-out/<tt>.jpg, also not committed
//      Top right shows only a bookmark for Marco's own watchlist (12/10/2026), without a number.
//   5  cache/posters.json (committed) holds a hash of what each cover was drawn from (numbers rounded to 0.1, seen count, personal watchlist membership, source,
//      the year, the flag, the drawing code) and the sha256 of the JPEG it drew; a cover is drawn again only when that hash changes or its file is gone or is
//      not the recorded drawing (a file restored from an older cache)
//   6  every item whose cover is ready gets `poster` = <base>/<tt>.jpg?v=<8 first characters of the sha256 of the drawn JPEG> (19/10/2026: a TV keeps the image by its address, so a cover drawn again has to have a new one); a cover that could not be downloaded or drawn keeps the
//      metahub address it always had, and the log counts it. Nothing here can stop the build.
//   7  a cover whose every source answered 404/410 or sent something that is not an image is a PERMANENT failure (19/10/2026, audit B3: 47 films with no cover anywhere
//      were asked again every night for a week): it is recorded in cache/posters.json under `failures` and asked again only after BACKOFF_NIGHTS nights; a
//      deadline, a 5xx, a 403, a host given up on is TRANSIENT and is asked again the next night, as always. After SWITCH_AFTER permanent tries the build asks once for
//      an alternative source (the `altSource` hook; none is wired in production) and records what it found.
//      20/10/2026 (Stremio BACKLOG item 13): the build log lists the records by code with their ids (failureReport, reportFailures), and a night that went to the network
//      appends the same table to the run's summary page (GITHUB_STEP_SUMMARY).
//
// Pure functions and small ones are exported for test/posters.test.js; the network and Python are injected.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawn } = require("child_process");
const { mapLimit, sleep, limitedFetch, LimitError, LIMITS, recordLimitHit } = require("./util");
const { planItems } = require("./crowd");
const CO = require("./countries");

const IMDB_RATINGS_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz";
const TMDB_IMG = "https://image.tmdb.org/t/p/w342";
const METAHUB_IMG = (tt) => `https://images.metahub.space/poster/medium/${tt}/img`;
const DEFAULT_BASE = "https://marcogusmao.github.io/mood-engine/posters/";
const SELO_DIR = path.join(__dirname, "..", "tools", "selo");
const KEEP_DAYS = 21; // a cover nobody has asked for in this long is deleted
const BACKOFF_NIGHTS = 7; // a cover that failed for good is asked again only after this many nights (audit B3, 19/10/2026)
const SWITCH_AFTER = 3; // after this many failed tries for good, one look for another source

const r1 = (x) => (x == null ? null : Number(Number(x).toFixed(1)));
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}
const daysBetween = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);

// ── the IMDb dataset ─────────────────────────────────────────────────────────

/** title.ratings.tsv ("tconst\taverageRating\tnumVotes") → Map(tt → { rating, votes }) for the tts in `wanted` only. */
function parseImdbRatings(text, wanted) {
  const out = new Map();
  for (const line of String(text).split("\n")) {
    if (!line.startsWith("tt")) continue;
    const [tt, rating, votes] = line.split("\t");
    if (!wanted.has(tt)) continue;
    const r = Number(rating);
    if (r > 0) out.set(tt, { rating: r, votes: Number(votes) || 0 });
  }
  return out;
}

/** The ratings dump, under LIMITS.imdbDump per try (a deadline, a byte cap on the gzip file and one on what it inflates to). A deadline is retried; a file past the cap is not (the same file again would be as large). */
async function downloadImdb({ fetchImpl = globalThis.fetch, url = IMDB_RATINGS_URL, retries = 3, sleepImpl = sleep, log } = {}) {
  let last;
  for (let a = 0; a <= retries; a++) {
    try {
      const { res, body: buf } = await limitedFetch("imdbDump", fetchImpl, url, { headers: { "User-Agent": "mood-engine/2.1 (personal Stremio addon)" } }, { as: "bytes", log });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let text;
      try { text = zlib.gunzipSync(buf, { maxOutputLength: LIMITS.imdbDump.maxInflatedBytes }).toString("utf8"); }
      catch (e) {
        if (e.code !== "ERR_BUFFER_TOO_LARGE") throw e;
        // a gzip file small enough for maxBytes can still inflate to terabytes (1029:1 on zeros): the same file again would do the same, so no new try
        const msg = `inflated file larger than ${LIMITS.imdbDump.maxInflatedBytes} bytes`;
        recordLimitHit("imdbDump", msg, log);
        throw Object.assign(new LimitError(`limit hit imdbDump: ${msg}`, "too-large"), { site: "imdbDump", final: true });
      }
      if (!/^tconst\taverageRating\tnumVotes/.test(text)) throw new Error("not the ratings file (the header is not tconst/averageRating/numVotes)");
      return { text, bytes: buf.length };
    } catch (e) {
      last = e;
      if (e.final) break;
      await sleepImpl(1000 * 2 ** a);
    }
  }
  throw last;
}

/**
 * The IMDb rating of every tt in `wanted`, from cache/imdb-ratings.json, downloaded again when the cache is not from today or
 * lacks a tt it needs. A download that fails leaves yesterday's cache in use (covers and descriptions then just lack IMDb for new films).
 * offline: nothing is downloaded and nothing written (--cache-only). → { map: Map(tt → rating), source, bytes }
 */
async function loadImdbRatings({ file, wanted, today, fetchImpl, offline = false, log = () => {}, sleepImpl }) {
  let cache = readJson(file) || { version: 1, date: null, ratings: {}, none: [] };
  const none = new Set(cache.none || []);
  const known = (tt) => tt in cache.ratings || none.has(tt);
  const need = cache.date !== today || [...wanted].some((tt) => !known(tt));
  let source = "cache", bytes = 0;
  if (need && !offline) {
    try {
      const d = await downloadImdb({ fetchImpl, sleepImpl, log });
      const found = parseImdbRatings(d.text, wanted);
      cache = { version: 1, date: today, ratings: Object.fromEntries([...found].map(([tt, x]) => [tt, [x.rating, x.votes]])), none: [...wanted].filter((tt) => !found.has(tt)) };
      writeJson(file, cache);
      source = "downloaded"; bytes = d.bytes;
    } catch (e) {
      source = "stale cache";
      log(`  ! IMDb ratings: ${e.message} — using the cache from ${cache.date || "never"}`);
    }
  } else if (need) source = "cache (offline)";
  const map = new Map();
  for (const tt of wanted) if (tt in cache.ratings) map.set(tt, cache.ratings[tt][0]);
  return { map, source, bytes };
}

// ── choosing and hashing ─────────────────────────────────────────────────────

/** Where the raw cover comes from: TMDB w342 when the TMDB cache holds the film's poster path, else metahub by IMDb id. */
function posterSource({ tt, tmdbPoster }) {
  return tmdbPoster && String(tmdbPoster).startsWith("/") ? { url: `${TMDB_IMG}${tmdbPoster}`, kind: "tmdb" } : { url: METAHUB_IMG(tt), kind: "metahub" };
}
/** The other source, for a download that failed. */
const fallbackSource = (tt, kind) => (kind === "tmdb" ? { url: METAHUB_IMG(tt), kind: "metahub" } : null);

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** The numbers a cover shows, rounded as they are drawn (0.1); a film with none of them gets no badge. */
function shown(r) {
  return { lb: r1(r.lb), imdb: r1(r.imdb), amigos: r1(r.friendsAvg), viram: r.seenBy || 0 };
}
const hasNumbers = (s) => !!(s.lb || s.imdb || s.viram);

/** Personal membership, using the same resolved IMDb ids and pool precedence as the Worker index. */
function watchlistIds(cands = [], recs = []) {
  const membership = new Map();
  for (const c of cands) if (c.film?.imdb) membership.set(c.film.imdb, !!c.watchlist);
  for (const r of recs) if (r.id) membership.set(r.id, !!r.tags?.watchlist);
  return new Set([...membership].filter(([, onWatchlist]) => onWatchlist).map(([tt]) => tt));
}

/**
 * What a cover was drawn from. A change in any number, in the source, in the drawing code, in the year or in the flag changes the hash.
 * top: { watchlist, year, flag, rule } — own membership in the top-right bookmark, the year in the top-left pill, the flag code that will really be drawn (null when its picture is not on disk:
 * a cover drawn with the year alone is drawn again once the flag is there) and the step of the country rule that chose it (lib/countries.js:
 * language, language-default, production, letterboxd, and `main` since 23/10/2026, only where the film's main country gives another flag than the v2.3 steps), so a change of criterion redraws
 * once, even where it picks the same flag; a cover whose flag does not change keeps its old step name and is not drawn again.
 */
function inputHash(r, kind, version, top = {}) {
  const s = shown(r);
  return crypto.createHash("sha1").update(JSON.stringify([s.lb, s.imdb, s.amigos, s.viram, top.watchlist === true, kind, version, top.year || null, top.flag || null, top.rule || null])).digest("hex").slice(0, 16);
}

/** The drawing code's version: a hash of render.py, selo.py, the marks and the font. Changing any of them redraws every cover. */
function renderVersion(dir = SELO_DIR) {
  const h = crypto.createHash("sha1");
  for (const f of ["render.py", "selo.py", "lb-dots-crop.png", "imdb-48-crop.png", "LiberationSans-Bold.ttf"]) {
    try { h.update(fs.readFileSync(path.join(dir, f))); } catch { h.update(`missing:${f}`); }
  }
  return h.digest("hex").slice(0, 12);
}

/**
 * The address a drawn cover is published at: <base>/<tt>.jpg?v=<version>. `version` is coverVersion() of the drawn JPEG (Marco, 19/10/2026: covers without the year and the flag on the TV,
 * which keeps an image by its address, and the address did not change when the cover was drawn again). Pages answers 200 to a query string. No version, no query: the address of a cover
 * that was never drawn is not built here at all, and the old plain address is what a caller that has no JPEG would get.
 */
const posterUrl = (base, tt, version) => `${String(base || DEFAULT_BASE).replace(/\/*$/, "/")}${tt}.jpg${version ? `?v=${version}` : ""}`;
/** The 8 first characters of the sha256 of the drawn JPEG: its content, not the date, so a cover drawn again with the same bytes keeps its address and a different drawing gets a new one. */
const coverVersion = (sha) => String(sha).slice(0, 8);

/** The release year a cover shows: the item's own `year`, when it is a plausible one. */
const yearOf = (item) => { const y = Math.round(Number(item.year)); return y >= 1870 && y <= 2100 ? y : null; };

/**
 * Every film in the plan and optional full index once: tt → { tt, tmdbPoster, year, cc, ratings, items }. `cc` (the flag code) and `ccFrom` are filled in by CO.attachCountries().
 * With an index, a film of the legacy plan that the index lacks throws (the build has a hole). A film only a row of the v2 Board (plan.board2) holds, and the index lacks, is
 * left out and handed to `onSkip(item, rowId)`: it keeps the cover it had, and the covers of every other film are still drawn (13/10/2026: one such film used to abandon the whole night's covers).
 */
function collectTargets(plan, { index = null, coverFacts = new Map(), watchlistIds = new Set(), onSkip = null } = {}) {
  const out = new Map();
  const inIndex = index ? new Set(index.films.map((e) => e.tt)) : null;
  for (const { item, where, v2 } of planItems(plan)) {
    if (v2 && inIndex && !inIndex.has(item.id)) { if (onSkip) onSkip(item, where); continue; }
    let t = out.get(item.id);
    if (!t) out.set(item.id, (t = { tt: item.id, watchlist: watchlistIds.has(item.id), tmdbPoster: null, year: null, cc: null, ratings: item.ratings || { lb: null, imdb: null, friendsAvg: null, seenBy: 0, wantBy: 0 }, items: [] }));
    if (!t.tmdbPoster && typeof item.poster === "string" && item.poster.startsWith("/")) t.tmdbPoster = item.poster;
    if (!t.year) t.year = yearOf(item);
    t.items.push(item);
  }
  if (index) {
    const ids = new Set(index.films.map(e => e.tt));
    for (const tt of out.keys()) if (!ids.has(tt)) throw new Error("Planned cover missing from full index: " + tt);
    for (const e of index.films) {
      if (!/^tt\d+$/.test(e.tt)) throw new Error("Invalid cover identity");
      if (!out.has(e.tt)) out.set(e.tt, { tt: e.tt, watchlist: e.watchlist === true, tmdbPoster: null, year: yearOf(e), cc: null,
        ratings: { lb: e.lbRating ?? null, imdb: e.imdbRating ?? null, friendsAvg: e.friendsAvg ?? null, seenBy: e.seenBy || 0, wantBy: e.wantBy || 0 }, items: [] });
    }
  }
  for (const t of out.values()) {
    const f = coverFacts.get(t.tt);
    if (f?.imdb !== t.tt) continue;
    t.factsOrigin = f.origin || "linked";
    if (index) t.tmdbPoster = f.poster?.startsWith('/') ? f.poster : null;
    else if (!t.tmdbPoster && f.poster?.startsWith('/')) t.tmdbPoster = f.poster;
    if (index) t.year = yearOf(f);
    else if (!t.year) t.year = yearOf(f);
  }
  return out;
}

// ── the images ───────────────────────────────────────────────────────────────

const isImage = (b) => b.length > 2000 && ((b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50) || (b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP"));

// ── a host that stopped answering ────────────────────────────────────────────

const HOST_TRIP_AFTER = 10;

/**
 * One circuit breaker per image host for the night: after `after` tries in a row that ended in a deadline or a network error (an answer of any
 * kind, even a 404 or a body too large, proves the host alive and starts the count again), the host is given up on and fetchImage refuses it
 * at once. Measured worst case without it (13/10/2026 review): 4 tries of 30 s plus waits is 132 s per source, 264 s with two sources, 6 at
 * a time is 44 s of clock per cover, and if the raw-cover cache is lost, 11,127 covers at 44 s is about 136 hours; the job dies at 300 minutes
 * without publishing. With it a dead host costs `after` tries in all. Logs `limit hit covers: host <h> tripped after 10` once per host.
 */
function makeHostBreaker({ after = HOST_TRIP_AFTER, log } = {}) {
  const hosts = new Map();
  const state = (h) => hosts.get(h) || hosts.set(h, { run: 0, tripped: false }).get(h);
  return {
    tripped: (host) => state(host).tripped,
    answered: (host) => { const s = state(host); if (!s.tripped) s.run = 0; },
    failed: (host) => {
      const s = state(host);
      if (s.tripped) return;
      if (++s.run >= after) { s.tripped = true; recordLimitHit("covers", `host ${host} tripped after ${after}`, log); }
    },
    trippedHosts: () => [...hosts].filter(([, s]) => s.tripped).map(([h]) => h),
  };
}

/**
 * One image, under LIMITS.coverImage per try. Retries 429/5xx, network errors and a deadline; a body past the cap and anything that is not an image (a placeholder page, an error body) are refused at once.
 * An error that no new try will change carries `permanent: true` and `code` ("404", "410", "not-image"): the address answered "no such cover" or sent something that is not one.
 * Every other failure (a deadline, a network error, a 5xx, a 429, a 403, a body past the cap, a host given up on) is not permanent: the next night may find the host well.
 */
async function fetchImage(url, { fetchImpl = globalThis.fetch, retries = 3, sleepImpl = sleep, log, breaker = null } = {}) {
  let last;
  let host = null;
  try { host = new URL(url).host; } catch { /* not an address: no breaker for it */ }
  const watch = breaker && host ? breaker : null;
  for (let a = 0; a <= retries; a++) {
    try {
      if (watch && watch.tripped(host)) throw Object.assign(new Error(`host ${host} given up on tonight (host-tripped)`), { final: true, hostTripped: true });
      let got;
      try { got = await limitedFetch("coverImage", fetchImpl, url, { headers: { "User-Agent": "mood-engine/2.1 (personal Stremio addon)" } }, { as: "bytes", log }); }
      catch (e) { if (watch) (e.code === "too-large" ? watch.answered(host) : watch.failed(host)); throw e; } // a deadline or a network error counts against the host
      watch?.answered(host);
      const { res, body: buf } = got;
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { final: true, ...(res.status === 404 || res.status === 410 ? { permanent: true, code: String(res.status) } : {}) });
      if (!isImage(buf)) throw Object.assign(new Error("not an image"), { final: true, permanent: true, code: "not-image" });
      return buf;
    } catch (e) {
      last = e;
      if (e.final || (watch && watch.tripped(host))) break; // given up on: no wait, no new try
      await sleepImpl(800 * 2 ** a);
    }
  }
  throw last;
}

/** Runs tools/selo/render.py on a list of jobs. → { drawn, failed: [{ tt, error }] }. Progress goes to `log`. */
function renderWithPython(jobs, { python = process.env.PYTHON || "python3", script = path.join(SELO_DIR, "render.py"), workers, log = () => {}, tmpDir = require("os").tmpdir() } = {}) {
  const file = path.join(tmpDir, `mood-selo-jobs-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ jobs, ...(workers ? { workers } : {}) }));
  return new Promise((resolve) => {
    let out = "", err = "";
    const child = spawn(python, [script, file], { stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", (e) => resolve({ drawn: 0, failed: jobs.map((j) => ({ tt: j.tt, error: `cannot run ${python}: ${e.message}` })) }));
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => { err += d; for (const line of String(d).split("\n")) if (/^progress /.test(line)) log(`     … ${line.slice(9)}`); });
    child.on("close", () => {
      try { fs.rmSync(file, { force: true }); } catch { /* temp file */ }
      try { resolve(JSON.parse(out.trim().split("\n").pop())); }
      catch { resolve({ drawn: 0, failed: jobs.map((j) => ({ tt: j.tt, error: `render.py gave no result${err ? `: ${err.trim().split("\n").pop()}` : ""}` })) }); }
    });
  });
}

// ── the whole step ───────────────────────────────────────────────────────────

/**
 * targets: collectTargets(plan)        dir: { raw, out, state, flags }  (cache/posters-raw, cache/posters-out, cache/posters.json, cache/flags; no `flags` = no flags)
 * cacheOnly: no downloads or source-state writes; existing raw covers may be redrawn in the existing output directory
 * → { tts: Set of tts whose cover is ready, stats }. Items of those tts get `poster` set to their published address.
 */
async function drawCovers({ targets, dir, base = DEFAULT_BASE, today, cacheOnly = false, fetchImpl, render = renderWithPython, version = renderVersion(), concurrency = 6, log = () => {}, sleepImpl, workers, altSource = null, backoffNights = BACKOFF_NIGHTS, switchAfter = SWITCH_AFTER }) {
  const state = readJson(dir.state) || { version: 1, items: {} };
  state.items ||= {};
  // failures[tt] = { kind: "permanent", tries, code, last, next, url, alt? }: a cover whose every source said "no such cover"; kept in the state file only while there is one
  const failures = state.failures && typeof state.failures === "object" && !Array.isArray(state.failures) ? state.failures : {};
  const breaker = makeHostBreaker({ log });
  const stats = { unique: targets.size, noNumbers: 0, unchanged: 0, downloaded: 0, downloadFailed: 0, hostTripped: 0, skippedBackoff: 0, switched: 0, drawn: 0, drawFailed: 0, noRaw: 0, usedFallback: 0, mb: 0, pruned: 0, withFlag: 0, noCountry: 0, flagMissing: 0, flagsDownloaded: 0, flagsFailed: 0, flagUnreadable: 0 };
  const ready = new Set(), need = [], receipt = new Map(), shaOf = new Map();
  if (!cacheOnly) { fs.mkdirSync(dir.raw, { recursive: true }); fs.mkdirSync(dir.out, { recursive: true }); } // --cache-only does not create cache directories
  const rawFile = (tt) => path.join(dir.raw, `${tt}.jpg`), outFile = (tt) => path.join(dir.out, `${tt}.jpg`);

  // flags: the ones the covers need and cache/flags does not have yet are downloaded (never in --cache-only)
  const numbered = [...targets.values()].filter((t) => hasNumbers(shown(t.ratings)) || t.watchlist === true || t.year || t.cc);
  if (dir.flags && !cacheOnly) {
    const f = await CO.ensureFlags(numbered.map((t) => t.cc).filter(Boolean), { dir: dir.flags, fetchImpl, sleepImpl, concurrency, log });
    stats.flagsDownloaded = f.downloaded; stats.flagsFailed = f.failed.length;
    for (const x of f.failed.slice(0, 5)) log(`  ! flag ${x.cc}: ${x.error} — the covers of that country show the year alone`);
  }
  /** The year and the flag a cover will really show: a flag counts only when its picture is on disk. */
  const topOf = (t) => ({ watchlist: t.watchlist === true, year: t.year || null, flag: t.cc && dir.flags && fs.existsSync(CO.flagFile(dir.flags, t.cc)) ? t.cc : null, rule: t.cc ? t.ccFrom || null : null });

  for (const t of targets.values()) {
    const s = shown(t.ratings);
    const top = topOf(t);
    receipt.set(t.tt, { tt: t.tt, origin: t.items.length ? "plan" : "index", factsOrigin: t.factsOrigin || "planned", year: top.year, cc: t.cc, ccFrom: t.ccFrom || null, flag: top.flag, version, noYear: !top.year, noCountry: !t.cc, flagMissing: !!t.cc && !top.flag });
    // Year/flag survive even when removing the personal marker leaves no numeric badge.
    if (!hasNumbers(s) && !top.watchlist && !top.year && !top.flag) { stats.noNumbers++; continue; }
    if (top.flag) stats.withFlag++; else if (t.cc) stats.flagMissing++; else stats.noCountry++;
    const src = posterSource(t);
    const h = inputHash(t.ratings, src.kind, version, top);
    Object.assign(receipt.get(t.tt), { plannedSource: src.kind, h });
    const prev = state.items[t.tt];
    // "unchanged" needs the file to be the drawing the state recorded (its sha256), not just a file with that name: until 13/10/2026 the covers' cache
    // of the workflow was restored by week and not saved again once the week's key existed, while this state was committed every run, so old drawings
    // came back as "unchanged" (adversarial review, 13/10/2026; the cache key is now one per run)
    if (prev && prev.h === h && prev.s && fs.existsSync(outFile(t.tt)) && sha256(fs.readFileSync(outFile(t.tt))) === prev.s) { ready.add(t.tt); stats.unchanged++; continue; }
    need.push({ t, s, src, h, top });
  }

  // raw covers: the ones not on disk are downloaded (TMDB first; metahub when TMDB fails)
  const toGet = need.filter((n) => !fs.existsSync(rawFile(n.t.tt)));
  if (cacheOnly) stats.noRaw = toGet.length;
  else {
    // a cover that failed for good (404, 410, not an image) is not asked again until its `next` night, unless the address it would be asked at is not the one that failed
    const attempt = [];
    for (const n of toGet) {
      const f = failures[n.t.tt];
      if (f && f.kind === "permanent" && f.url === n.src.url && f.next > today) { n.skipped = true; stats.skippedBackoff++; } else attempt.push(n);
    }
    await mapLimit(attempt, concurrency, async (n) => {
      const tt = n.t.tt;
      let src = n.src, buf = null;
      const errs = [];
      while (src && !buf) {
        try { buf = await fetchImage(src.url, { fetchImpl, sleepImpl, log, breaker }); }
        catch (e) { errs.push(e); if (e.hostTripped) n.tripped = true; src = fallbackSource(tt, src.kind); if (src) stats.usedFallback++; }
      }
      if (!buf) {
        // permanent only when every source that was tried said so; one deadline, 5xx, 403 or a host given up on makes the night's failure transient, and a transient
        // failure writes nothing: tomorrow the cover is asked again as it always was (an older permanent record stays due, since its `next` has passed)
        if (errs.length && errs.every((e) => e.permanent)) {
          const old = failures[tt];
          const same = old && old.kind === "permanent" && old.url === n.src.url;
          const rec = { kind: "permanent", tries: (same ? old.tries : 0) + 1, code: [...new Set(errs.map((e) => e.code))].join("+"), last: today, next: addDays(today, backoffNights), url: n.src.url };
          if (same && old.alt) rec.alt = old.alt;
          failures[tt] = rec;
          if (rec.tries >= switchAfter && !rec.alt) { // once: the other source, when there is one
            let alt;
            try { alt = altSource ? await altSource({ tt, tmdbPoster: n.t.tmdbPoster, source: n.src, tries: rec.tries, code: rec.code }) : null; }
            catch (e) { alt = undefined; log(`  ! cover ${tt}: the look for another source failed (${e.message}) — it will be repeated`); }
            if (alt === undefined) { /* the look itself broke: not recorded, repeated on the next try */ }
            else if (!alt || !alt.url) rec.alt = { d: today, found: false };
            else {
              try { buf = await fetchImage(alt.url, { fetchImpl, sleepImpl, log, breaker }); n.got = alt.kind; n.switched = { from: n.src.kind, to: alt.kind }; stats.switched++; delete failures[tt]; }
              catch (e) { rec.alt = { d: today, found: true, kind: alt.kind, ok: false, code: e.code || String(e.message).slice(0, 40) }; }
            }
          }
        }
        if (!buf) { stats.downloadFailed++; if (n.tripped) stats.hostTripped++; return; } // a cover whose host was given up on keeps its original address, counted as FAILED with the reason host-tripped
      }
      fs.writeFileSync(rawFile(tt), buf);
      n.got ||= src.kind; // the source that answered (the hash keeps the planned one: a fallback must not redraw the cover every night)
      stats.downloaded++;
    });
  }

  const jobs = need.filter((n) => fs.existsSync(rawFile(n.t.tt))).map((n) => ({ tt: n.t.tt, raw: rawFile(n.t.tt), out: outFile(n.t.tt), lb: n.s.lb, imdb: n.s.imdb, amigos: n.s.amigos, viram: n.s.viram, watchlist: n.top.watchlist, year: n.top.year, flag: n.top.flag ? CO.flagFile(dir.flags, n.top.flag) : null }));
  if (jobs.length) {
    const res = await render(jobs, { log, workers });
    const failed = new Set((res.failed || []).map((f) => f.tt));
    stats.drawFailed = failed.size;
    stats.flagUnreadable = res.flagFailed || 0;
    const unreadable = new Set(res.flagFailedIds || []);
    for (const n of need) if (unreadable.has(n.t.tt)) {
      n.top.flag = null;
      n.h = inputHash(n.t.ratings,n.src.kind,version,n.top);
      Object.assign(receipt.get(n.t.tt), { flag: null, flagUnreadable: true, h: n.h });
    }
    for (const f of (res.failed || []).slice(0, 5)) log(`  ! cover ${f.tt}: ${f.error}`);
    const asked = new Set(jobs.map((j) => j.tt));
    for (const n of need) if (asked.has(n.t.tt) && !failed.has(n.t.tt) && fs.existsSync(outFile(n.t.tt))) { ready.add(n.t.tt); stats.drawn++; state.items[n.t.tt] = { h: n.h, kind: n.got || n.src.kind, s: sha256(fs.readFileSync(outFile(n.t.tt))), ...(n.switched ? { switched: { ...n.switched, d: today } } : {}) }; }
  }

  // the cover is published only when it is ready; anything else keeps the address it had
  for (const tt of ready) {
    delete failures[tt]; // a cover that is ready no longer fails
    const t = targets.get(tt);
    const e = state.items[tt] || (state.items[tt] = { h: inputHash(t.ratings, posterSource(t).kind, version, topOf(t)), kind: posterSource(t).kind });
    // the sha256 of the drawing: the one the state recorded (an "unchanged" cover was checked against it, a drawn one was hashed when drawn), else the file's own
    shaOf.set(tt, e.s || sha256(fs.readFileSync(outFile(tt))));
    for (const it of t.items) it.poster = posterUrl(base, tt, coverVersion(shaOf.get(tt)));
    if (!e.d || daysBetween(e.d, today) >= 7) e.d = today; // refreshed weekly, not nightly: the committed file must not change every day
    try { stats.mb += fs.statSync(outFile(tt)).size / 1048576; } catch { /* gone */ }
  }

  // forget covers nobody asked for in KEEP_DAYS days
  if (!cacheOnly) {
    for (const [tt, e] of Object.entries(state.items)) {
      if (targets.has(tt) || (e.d && daysBetween(e.d, today) <= KEEP_DAYS)) continue;
      for (const f of [rawFile(tt), outFile(tt)]) fs.rmSync(f, { force: true });
      delete state.items[tt];
      stats.pruned++;
    }
    for (const [tt, f] of Object.entries(failures)) if (!targets.has(tt) && !(f && f.last && daysBetween(f.last, today) <= KEEP_DAYS)) delete failures[tt]; // the record of a film nobody asks for goes with it
    if (Object.keys(failures).length) state.failures = failures; else delete state.failures; // no failure, no key: the file stays as it was
    writeJson(dir.state, state);
  }
  const neededByTt = new Map(need.map(n => [n.t.tt,n]));
  for (const t of targets.values()) {
    const r = receipt.get(t.tt), n = neededByTt.get(t.tt);
    r.ready = ready.has(t.tt);
    r.reason = r.ready ? "ready" : n ? (!fs.existsSync(rawFile(t.tt)) ? (cacheOnly ? "noRaw" : n.skipped ? "backoff" : n.tripped ? "host-tripped" : "downloadFailed") : "drawFailed") : "nothingToShow";
    if (r.ready) { r.effectiveSource = state.items[t.tt].kind; r.sha256 = shaOf.get(t.tt); }
  }
  return { tts: ready, failures: { ...failures }, versions: new Map([...shaOf].map(([tt, sha]) => [tt, coverVersion(sha)])), stats, receipt: [...receipt.values()], effectiveState: { version: 1, items: Object.fromEntries([...ready].map(tt => [tt, { h: state.items[tt].h }])) } };
}

// ── what the build prints about covers that fail for good (Stremio BACKLOG item 13, 20/10/2026) ─────────────────────────────────────────────────

const MAX_IDS_IN_SUMMARY = 200; // GITHUB_STEP_SUMMARY is capped at 1 MiB per step; 47 ids are about 500 characters, so this is a ceiling, not a trim of today's list

/**
 * The records of `failures` (cache/posters.json) grouped by the code the sources answered ("404", "410", "not-image", or "404+410" when two sources said different things).
 * → { total, tonight (asked tonight), waiting (in backoff), altFound, altNone, byCode: [{ code, count, tonight, maxTries, ids }] }, the biggest group first, ids in order.
 * Pure: reads nothing, writes nothing.
 */
function failureReport(failures, today) {
  const rec = failures && typeof failures === "object" && !Array.isArray(failures) ? Object.entries(failures) : [];
  const groups = new Map();
  let tonight = 0, altFound = 0, altNone = 0;
  for (const [tt, f] of rec) {
    const e = f && typeof f === "object" ? f : {};
    const code = typeof e.code === "string" && e.code ? e.code : "unknown";
    const g = groups.get(code) || { code, count: 0, tonight: 0, maxTries: 0, ids: [] };
    g.count++;
    g.ids.push(tt);
    if (typeof e.tries === "number" && e.tries > g.maxTries) g.maxTries = e.tries;
    if (e.last === today) { g.tonight++; tonight++; }
    if (e.alt && e.alt.found === true) altFound++; else if (e.alt && e.alt.found === false) altNone++;
    groups.set(code, g);
  }
  const byCode = [...groups.values()].sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1));
  for (const g of byCode) g.ids.sort();
  return { total: rec.length, tonight, waiting: rec.length - tonight, altFound, altNone, byCode };
}

/** The lines the build log gets: one summary line, then one line per code with its ids. */
function failureLines(report) {
  if (!report.total) return ["     Cover failures on record: none"];
  const lines = [`     Cover failures on record: ${report.total} (${report.byCode.map((g) => `${g.code} ×${g.count}`).join(", ")}) · ${report.tonight} asked tonight, ${report.waiting} waiting for their next try (${BACKOFF_NIGHTS} nights apart) · other source: ${report.altFound} found, ${report.altNone} looked for and not found`];
  for (const g of report.byCode) lines.push(`       ${g.code} ×${g.count} (${g.tonight} asked tonight, most tries ${g.maxTries}): ${g.ids.join(" ")}`);
  return lines;
}

/** Markdown for the run's summary page; "" when nothing failed. */
function failureMarkdown(report) {
  if (!report.total) return "";
  const rows = report.byCode.map((g) => {
    const shown = g.ids.slice(0, MAX_IDS_IN_SUMMARY).map((t) => `\`${t}\``).join(" ") + (g.ids.length > MAX_IDS_IN_SUMMARY ? ` … +${g.ids.length - MAX_IDS_IN_SUMMARY} more` : "");
    return `| ${g.code.replace(/\|/g, "/")} | ${g.count} | ${g.tonight} | ${g.maxTries} | ${shown} |`;
  });
  return [
    "### Covers that fail for good",
    "",
    `${report.total} covers have no source that answers (${report.tonight} asked tonight, ${report.waiting} waiting; asked again every ${BACKOFF_NIGHTS} nights). Other source: ${report.altFound} found, ${report.altNone} looked for and not found.`,
    "",
    "| Answer | Covers | Asked tonight | Most tries | Ids |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

/**
 * Prints the report with `log`, and appends the markdown to the file named by env.GITHUB_STEP_SUMMARY when there is one and the build really went to the network
 * (cacheOnly builds, which the tests run, never touch it: on a runner every step has the variable). Never throws: a report must not stop the night.
 */
function reportFailures({ failures, today, log = () => {}, env = process.env, cacheOnly = false, fsImpl = fs }) {
  try {
    const report = failureReport(failures, today);
    for (const l of failureLines(report)) log(l);
    const file = env && env.GITHUB_STEP_SUMMARY;
    if (!cacheOnly && file && report.total) {
      try { fsImpl.appendFileSync(file, failureMarkdown(report) + "\n"); }
      catch (e) { log(`  ! Cover failures not written to the run summary: ${e.message}`); }
    }
    return report;
  } catch (e) {
    try { log(`  ! Cover failure report: ${e.message}`); } catch { /* the log itself is broken: nothing left to tell */ }
    return null;
  }
}

module.exports = {
  failureReport, failureLines, failureMarkdown, reportFailures, MAX_IDS_IN_SUMMARY,
  parseImdbRatings, loadImdbRatings, downloadImdb, posterSource, fallbackSource, shown, hasNumbers, inputHash, renderVersion, posterUrl, coverVersion, collectTargets, watchlistIds, yearOf,
  fetchImage, makeHostBreaker, HOST_TRIP_AFTER, BACKOFF_NIGHTS, SWITCH_AFTER, isImage, renderWithPython, drawCovers, IMDB_RATINGS_URL, DEFAULT_BASE, TMDB_IMG, METAHUB_IMG, KEEP_DAYS,
};
