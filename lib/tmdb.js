// TMDB client with a persistent on-disk cache, a concurrency limit and polite retries.
// The cache is committed to the repo, so after the first run each nightly build only
// asks TMDB about what's new.
//
// This product uses the TMDB API but is not endorsed or certified by TMDB.

const fs = require("fs");
const path = require("path");
const { norm, sleep, deadline, readCapped, LIMITS, recordLimitHit } = require("./util");

const DAY = 864e5;
// One TMDB answer is a few KB to ~1 MB (a prolific person's credits); a try that takes more than 30 s, or a body past 10 MB, is a failed
// try (lib/util.js deadline / readCapped), retried like a network error. Both generous: TMDB answers in well under a second.
// The numbers live in lib/util.js LIMITS.tmdb (config.json "limits" can override them); these two are their values when the module loads.
const TIMEOUT_MS = LIMITS.tmdb.timeoutMs;
const MAX_BYTES = LIMITS.tmdb.maxBytes;
// How many cached films without a `trailer` one run may ask TMDB about again (Marco, 20/10/2026; docs/…meta-pagina-de-detalhe-spec.md, Fatia 2, 2.1). config.json "tmdb": { "trailerBackfillPerRun": N } overrides it.
const TRAILER_BACKFILL_PER_RUN = 2000;
// This many backfill asks failing in a row (network, 5xx, 429 given up) stop the backfill for the rest of the run: an outage must not cost 2,000 × 5 tries of waiting.
const TRAILER_FAIL_STREAK = 20;
const TTL = { movie: 45 * DAY, recs: 14 * DAY, person: 30 * DAY, find: 365 * DAY, search: 365 * DAY, searchMiss: 30 * DAY };

/** The IMDb ids that a movie record of `cache` ({ movie: { id: { v } } }) names. */
function namedIn(cache) {
  const named = new Set();
  for (const e of Object.values(cache?.movie || {})) if (e && e.v && e.v.imdb) named.add(e.v.imdb);
  return named;
}

/**
 * The rule of `Tmdb#noRecord` (read its comment) over a plain cache object, with the set `namedIn(cache)` already made. One body for the live cache of the build and for the cache a learning
 * snapshot froze (lib/learning/evaluate.js), so the replay of the rows asks the rule exactly as the build did (22/10/2026: the replay lacked it and found 92 more candidates in "fromlists").
 */
function noRecordIn(cache, named, imdb, tmdbId = null) {
  if (!/^tt\d+$/.test(imdb || "")) return false;
  if (named.has(imdb)) return false;
  const f = cache?.find?.[imdb];
  if (f) return f.v == null || cache?.movie?.[f.v]?.v === null; // asked: nothing means TMDB has no movie; an id means it has one UNLESS the movie under that id was asked and came back empty (Dekalog tt0092337: find -> 37452, movie 37452 404; a series, 572 min on Letterboxd. 22/10/2026, review of friends-cards)
  return !!tmdbId && cache?.movie?.[tmdbId]?.v === null;
}

/** `unrecorded` for lib/recommendation-quality.js index() from a plain, unchanging cache object (a frozen snapshot's `cache/tmdb.json`). */
function unrecordedFrom(cache) {
  const named = namedIn(cache);
  return ({ imdbId, tmdbId }) => noRecordIn(cache, named, imdbId, tmdbId);
}

class Tmdb {
  constructor(token, cacheFile, { concurrency = 8, timeoutMs = LIMITS.tmdb.timeoutMs, maxBytes = LIMITS.tmdb.maxBytes, trailerBudget = TRAILER_BACKFILL_PER_RUN, trailerRetryNull = false, trailerRepick = false, fetchImpl = (...a) => globalThis.fetch(...a), sleepImpl = sleep, log = console.warn } = {}) {
    if (!token && !process.env.OFFLINE) throw new Error("Missing TMDB_TOKEN. See README → 'TMDB key'.");
    this.token = (token || "").trim(); // empty is fine offline: nothing is ever requested
    this.cacheFile = cacheFile;
    this.cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};
    for (const k of ["movie", "recs", "person", "find", "search"]) this.cache[k] ||= {};
    this.rev = 0; // bumped when movie() stores a record (the only write that can add an IMDb id to cache.movie; the trailer rewrites keep the id and `find` is read directly), so named() follows the cache while a run fills it
    this.active = 0;
    this.queue = [];
    this.limit = concurrency;
    this.calls = 0;
    Object.assign(this, { timeoutMs, maxBytes, fetchImpl, sleepImpl, log });
    this.limited = 0; // tries given up for the deadline or the size cap
    this.trailerBudget = trailerBudget; // asks left for films cached without a `trailer` key; one is spent per ask, and when it is 0 those films are served as they are
    this.trailerAsked = 0; // asks spent this run
    this.trailerFailed = 0; // of them, the ones that failed (the cached record was served instead)
    this.trailerStreak = 0;
    this.trailerStopped = false; // true once TRAILER_FAIL_STREAK asks failed in a row and the backfill gave up for this run
    this.trailerRetryNull = trailerRetryNull; // the backfill also asks again the films cached with `trailer: null` (scripts/backfill-trailers.js --retry-null); the build never sets it
    this.trailerRepick = trailerRepick; // the backfill asks again EVERY film that has the `trailer` key (a key or null) and redoes only the pick (scripts/backfill-trailers.js --repick); the build never sets it
  }

  save() {
    if (process.env.OFFLINE) return; // never write offline misses into the real cache
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    const tmp = `${this.cacheFile}.${process.pid}.tmp`; // written whole, then renamed: a reader never meets half a file
    fs.writeFileSync(tmp, JSON.stringify(this.cache));
    fs.renameSync(tmp, this.cacheFile);
  }

  async slot() {
    if (this.active < this.limit) { this.active++; return; }
    await new Promise((r) => this.queue.push(r));
    this.active++;
  }
  release() { this.active--; const n = this.queue.shift(); if (n) n(); }

  async get(pathname, params = {}) {
    if (process.env.OFFLINE) { this.misses = (this.misses || 0) + 1; return null; } // tune against the cache only
    // v4 "API Read Access Token" (long JWT) goes in a header; a v3 key goes in the query.
    const bearer = this.token.length > 60;
    const qs = new URLSearchParams({ ...params, ...(bearer ? {} : { api_key: this.token }) });
    const url = `https://api.themoviedb.org/3${pathname}?${qs}`;
    await this.slot();
    try {
      let lastLimit = null; // the deadline or size cap that failed a try, named in the final error
      for (let attempt = 0; attempt < 5; attempt++) {
        this.calls++;
        let res, text;
        const d = deadline(this.timeoutMs); // one deadline for the answer and its body
        try {
          res = await d.race(this.fetchImpl(url, { signal: d.signal, headers: bearer ? { Authorization: `Bearer ${this.token}`, accept: "application/json" } : { accept: "application/json" } }));
          if (res.ok) text = await d.race(readCapped(res, this.maxBytes));
        } catch (e) {
          if (e.name === "LimitError") { this.limited++; lastLimit = e; recordLimitHit("tmdb", e.message, this.log); } // `limit hit tmdb: …`, as the five other sites
          await this.sleepImpl(500 * 2 ** attempt);
          continue;
        } finally {
          d.clear();
        }
        if (res.status === 401) throw Object.assign(new Error("TMDB rejected the key (401). Check TMDB_TOKEN."), { auth: true });
        if (res.status === 404) return null;
        if (res.status === 429 || res.status >= 500) { await this.sleepImpl(Number(res.headers.get("retry-after")) * 1000 || 600 * 2 ** attempt); continue; }
        if (!res.ok) throw new Error(`TMDB ${res.status} on ${pathname}`);
        return JSON.parse(text);
      }
      throw new Error(`TMDB kept failing on ${pathname}${lastLimit ? ` (last limit hit: ${lastLimit.message})` : ""}`);
    } finally {
      this.release();
    }
  }

  // Offline there is nobody to ask, so an old cache entry is better than none.
  fresh(entry, ttl) { return entry && (process.env.OFFLINE || Date.now() - entry.t < ttl); }

  /** What the cache already knows about a film, without asking TMDB. */
  peek(id) { return this.cache.movie[id]?.v || null; }

  /**
   * True when TMDB was ASKED about this film and has no MOVIE record of its own (Marco, 22/10/2026 ~06:40 UTC: a film with no record stays out of the rows until it has one;
   * lib/recommendation-quality.js index() `unrecorded`). What TMDB keeps as a series or as an episode has no movie record, so it counts (East of Eden 2026 is a series there). Two answers count, and only these:
   *   - `find/<imdb>` was asked and came back empty (cache.find[imdb].v === null): a series, an episode, a film TMDB has not listed (105 of the 122 `find` answers of cache/tmdb.json on 22/10/2026 are empty, all under the tt of a Letterboxd film).
   *     It does NOT matter what sits under the TMDB id Letterboxd names: for The Prisoner, Undone, Maniac and The Iceman Cometh that number is a series' id, the movie under it is another film's (or names no IMDb id), `find` came back empty, and the four have no record of their own.
   *   - the TMDB id Letterboxd names was asked and came back empty (cache.movie[tmdbId].v === null): East of Eden 2026, tt21097264, movie 258165 (78 of the 11,819 `movie` records of that date are empty).
   * A third answer counts (22/10/2026, review of friends-cards): `find` HAS an id and the movie under that id was asked and is empty (cache.movie[found].v === null). The one film of cache/tmdb.json in that state is Dekalog, tt0092337
   * (find -> 37452, movie 37452 answered 404; a series, 572 min on Letterboxd): "find has an id" had been read as "TMDB has the film", while lib/friends-records.js stateOf already called it empty.
   * It is false when any cached movie names the IMDb id (even under another TMDB id than Letterboxd's: no film of the real cache is in that state today, the tests plant one), when `find` has an id for it and its movie is cached or not yet fetched,
   * and when nothing was asked yet: a film the cache has not looked up is not a film TMDB lacks (a rule that hid the unasked would keep it from ever being asked: the friends' rows re-ask only the films they already hold).
   * That last case is why WHICH series stay out depends on whether `find` was asked about them (it is asked for the films of the lists, the pins and the search link): the same state as The Prisoner, with `find` never asked,
   * stays in (10 films of the pool on 22/10/2026). The answers are cached: a movie 45 days (TTL.movie), a `find` 365 days (TTL.find).
   * Offline, movie() and fromImdb() below store `{ v: null }` IN MEMORY for an id nobody ever asked (`get` answers null); this method would read it as an asked and empty answer for the rest of that offline run (BACKLOG 22/10/2026).
   */
  noRecord(imdb, tmdbId = null) { return noRecordIn(this.cache, this.named(), imdb, tmdbId); }

  /** The IMDb ids that a cached movie record names, rebuilt when the cache has been written since. */
  named() {
    if (this._namedRev !== this.rev) {
      this._named = namedIn(this.cache);
      this._namedRev = this.rev;
    }
    return this._named;
  }

  /**
   * Full film record (trimmed): genres, keywords, directors, cast, IMDb id, trailer…
   * A record cached WITHOUT the `trailer` key was never asked about it (20/10/2026): it is renewed like an expired one while this run has budget
   * (`trailerBudget`, config.json tmdb.trailerBackfillPerRun, 2000 by default). One cached WITH `trailer: null` was asked and has none: it waits for its TTL
   * (unless `trailerRetryNull`). The videos are asked in English, in no language (`null`) and in the film's original language when the cache knows it
   * (`include_video_language`, 20/10/2026): with `language=en-US` alone TMDB may leave out a trailer that exists only in the film's own language.
   * With `trailerRepick` (the script's --repick) a record that has the key is asked again and ONLY its `trailer` is replaced: the rest of the record and its date stay, so the index does not move for it.
   * Offline nothing is asked. A backfill ask that fails keeps the cached record (the night does not fail for it), except a rejected key (401).
   */
  async movie(id) {
    const c = this.cache.movie[id];
    const fresh = this.fresh(c, TTL.movie);
    const backfill = fresh && needsTrailer(c, { retryNull: this.trailerRetryNull, repick: this.trailerRepick }) && !process.env.OFFLINE && this.trailerBudget > 0;
    if (fresh && !backfill) return c.v;
    if (backfill) { this.trailerBudget--; this.trailerAsked++; } // spent before the first await: the 8 asks in flight cannot overspend it
    let d;
    try {
      d = await this.get(`/movie/${id}`, { append_to_response: "keywords,credits,external_ids,videos", language: "en-US", include_video_language: videoLanguages(c?.v?.lang) });
    } catch (e) {
      if (!backfill || e.auth) throw e;
      this.trailerFailed++;
      if (this.trailerFailed <= 10) this.log(`  ! trailer backfill: movie ${id} not renewed (${e.message})`); // the first 10, like the limit hits
      if (++this.trailerStreak >= TRAILER_FAIL_STREAK && this.trailerBudget > 0) { this.trailerBudget = 0; this.trailerStopped = true; this.log(`  ! trailer backfill stopped: ${TRAILER_FAIL_STREAK} asks failed in a row`); }
      return c.v;
    }
    if (backfill) this.trailerStreak = 0;
    if (backfill && !d) { // TMDB no longer knows the film: keep what we have, mark it asked (the expiry date stays), do not ask again; a trailer or null it already had stays
      this.cache.movie[id] = { t: c.t, v: { ...c.v, trailer: Object.hasOwn(c.v, "trailer") ? c.v.trailer : null } };
      return this.cache.movie[id].v;
    }
    if (backfill && this.trailerRepick && Object.hasOwn(c.v, "trailer")) { // --repick: only the pick is redone; the record and its expiry date stay
      this.cache.movie[id] = { t: c.t, v: { ...c.v, trailer: pickTrailer(d.videos) } };
      return this.cache.movie[id].v;
    }
    const v = d ? trim(d) : null;
    this.cache.movie[id] = { t: Date.now(), v };
    this.rev++;
    return v;
  }

  /** Ids TMDB recommends off a film (two pages ≈ 40). */
  async recommendations(id) {
    const c = this.cache.recs[id];
    if (this.fresh(c, TTL.recs)) return c.v;
    const out = [];
    for (const page of [1, 2]) {
      const d = await this.get(`/movie/${id}/recommendations`, { page, language: "en-US" });
      if (!d) break;
      for (const r of d.results || []) out.push({ id: r.id, va: r.vote_average, vc: r.vote_count, date: r.release_date || "" });
      if ((d.total_pages || 1) <= page) break;
    }
    this.cache.recs[id] = { t: Date.now(), v: out };
    return out;
  }

  /** Films a person directed. */
  async directed(personId) {
    const c = this.cache.person[personId];
    if (this.fresh(c, TTL.person)) return c.v;
    const d = await this.get(`/person/${personId}/movie_credits`, { language: "en-US" });
    const v = (d?.crew || []).filter((x) => x.job === "Director").map((x) => ({ id: x.id, va: x.vote_average, vc: x.vote_count, date: x.release_date || "" }));
    this.cache.person[personId] = { t: Date.now(), v };
    return v;
  }

  /** IMDb id → TMDB id */
  async fromImdb(imdb) {
    const c = this.cache.find[imdb];
    if (this.fresh(c, TTL.find)) return c.v;
    const d = await this.get(`/find/${imdb}`, { external_source: "imdb_id" });
    const v = d?.movie_results?.[0]?.id || null;
    this.cache.find[imdb] = { t: Date.now(), v };
    return v;
  }

  /** Record a known-good title → id mapping (from the Letterboxd RSS). */
  remember(title, year, id) {
    this.cache.search[`${norm(title)}|${year || ""}`] = { t: Date.now(), v: id, exact: true };
  }

  /** The search cache entry for a title + year ({ v, exact? }), without asking TMDB. */
  searchEntry(title, year) { return this.cache.search[`${norm(title)}|${year || ""}`] || null; }

  /** Title + year → TMDB id, tolerant of ±1 year and punctuation. The best-scoring result can be a homonym: lib/search-link.js decides whether it is a link. */
  async search(title, year) {
    const key = `${norm(title)}|${year || ""}`;
    const c = this.cache.search[key];
    if (c && (c.exact || this.fresh(c, c.v ? TTL.search : TTL.searchMiss))) return c.v;
    const pick = (results) => {
      const scored = (results || [])
        .map((r) => {
          const y = Number((r.release_date || "").slice(0, 4)) || null;
          const titleHit = norm(r.title) === norm(title) || norm(r.original_title) === norm(title);
          const yearDiff = year && y ? Math.abs(y - year) : 9;
          return { r, ok: titleHit && yearDiff <= 1, score: (titleHit ? 100 : 0) - yearDiff * 10 + Math.log10(1 + (r.vote_count || 0)) };
        })
        .sort((a, b) => b.score - a.score);
      return scored.find((s) => s.ok)?.r.id || null;
    };
    let id = null;
    if (year) id = pick((await this.get("/search/movie", { query: title, year, include_adult: "false" }))?.results);
    if (!id) id = pick((await this.get("/search/movie", { query: title, include_adult: "false" }))?.results);
    this.cache.search[key] = { t: Date.now(), v: id };
    return id;
  }
}

/** A cached movie entry that holds a record but has no `trailer` key (not even null): TMDB was never asked for its videos. With `retryNull`, one cached with `trailer: null` counts too. With `repick` (21/10/2026), ONLY the records that HAVE the key count, a trailer or null: the pick is redone on a fresh answer; a never-asked one does not count (review of 21/10: before, it did, and only the script's own filter kept it out). */
function needsTrailer(entry, { retryNull = false, repick = false } = {}) {
  if (!entry || !entry.v || typeof entry.v !== "object") return false;
  if (repick) return Object.hasOwn(entry.v, "trailer");
  return !Object.hasOwn(entry.v, "trailer") || (retryNull && entry.v.trailer === null);
}

/** The `include_video_language` of a film request: English, no language (`null`, TMDB's own word) and the film's original language when the cache knows it (`lang`, ISO 639-1; "xx" says there is no language; "cn" is Cantonese, whose videos TMDB files under "zh"). */
function videoLanguages(lang) {
  const l = typeof lang === "string" ? lang.trim().toLowerCase() : "";
  const extra = l === "cn" ? ["cn", "zh"] : /^[a-z]{2}$/.test(l) && l !== "en" && l !== "xx" ? [l] : [];
  return ["en", "null", ...extra].join(",");
}

/** The YouTube key of the film's trailer, or null: among `videos.results` of site YouTube and type Trailer, English first (`iso_639_1` "en"; an unofficial English trailer beats an official one in another language: Marco, 21/10/2026), the official ones first among the English, and the same inside the rest (so with no English video an official one in another language wins); then the most recently published. Before 21/10/2026 `official` came first and English second (the spec's order, from when only English videos came back); the cache of that date holds that pick for the films already chosen (8,736 had a trailer) until `scripts/backfill-trailers.js --repick` is run. */
function pickTrailer(videos) {
  const ts = (v) => { const t = Date.parse(v.published_at); return Number.isNaN(t) ? -Infinity : t; };
  const best = (videos?.results || [])
    .filter((v) => v && v.site === "YouTube" && v.type === "Trailer" && typeof v.key === "string" && v.key)
    .map((v, i) => ({ v, i }))
    .sort((a, b) => (b.v.iso_639_1 === "en") - (a.v.iso_639_1 === "en") || (b.v.official === true) - (a.v.official === true) || ts(b.v) - ts(a.v) || a.i - b.i)[0];
  return best ? best.v.key : null;
}

/** config.json "tmdb": { "trailerBackfillPerRun": N } → the budget (2000 when absent). N is a whole number, 0 or more; anything else is an error. */
function trailerBudgetFrom(section) {
  if (section == null) return TRAILER_BACKFILL_PER_RUN;
  if (typeof section !== "object" || Array.isArray(section)) throw new Error('config.json "tmdb" must be an object like { "trailerBackfillPerRun": 2000 }');
  for (const k of Object.keys(section)) if (k !== "trailerBackfillPerRun" && !k.startsWith("_")) throw new Error(`config.json "tmdb": "${k}" is not one of trailerBackfillPerRun`);
  const n = section.trailerBackfillPerRun;
  if (n === undefined) return TRAILER_BACKFILL_PER_RUN;
  if (!Number.isInteger(n) || n < 0) throw new Error(`config.json "tmdb.trailerBackfillPerRun" must be a whole number, 0 or more, got ${JSON.stringify(n)}`);
  return n;
}

function trim(d) {
  const year = Number((d.release_date || "").slice(0, 4)) || null;
  const crew = d.credits?.crew || [];
  return {
    id: d.id,
    imdb: d.external_ids?.imdb_id || d.imdb_id || null,
    title: d.title,
    originalTitle: d.original_title !== d.title ? d.original_title : undefined,
    year,
    date: d.release_date || "",
    runtime: d.runtime || null,
    genres: (d.genres || []).map((g) => g.name),
    keywords: (d.keywords?.keywords || []).map((k) => k.name.toLowerCase()),
    directors: crew.filter((c) => c.job === "Director").map((c) => ({ id: c.id, name: c.name })),
    cast: (d.credits?.cast || []).slice(0, 5).map((c) => ({ id: c.id, name: c.name })),
    countries: (d.production_countries || []).map((c) => c.iso_3166_1),
    origin: d.origin_country || [], // TMDB's own "country of origin" (Marco, 22/10/2026: lib/countries.js mainCountry reads it first); a cached record without the key was never asked: unknown, not empty
    lang: d.original_language,
    va: d.vote_average || 0,
    vc: d.vote_count || 0,
    pop: d.popularity || 0,
    overview: d.overview || "",
    poster: d.poster_path || null,
    backdrop: d.backdrop_path || null,
    status: d.status,
    trailer: pickTrailer(d.videos), // the YouTube key, or null: asked and there is none (a record without this key was never asked)
  };
}

module.exports = { Tmdb, unrecordedFrom, noRecordIn, namedIn, TIMEOUT_MS, MAX_BYTES, TRAILER_BACKFILL_PER_RUN, needsTrailer, videoLanguages, pickTrailer, trailerBudgetFrom, trim };
