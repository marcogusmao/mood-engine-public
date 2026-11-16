// Friends module: reads what your friends rate, watchlist and list on Letterboxd (public pages only,
// no login) and turns every film into an IMDb id, because Stremio only asks Torrentio/Comet for
// streams when the id starts with "tt". A film without an IMDb link is dropped: it could never play.
//
// Everything slow is cached in cache/friends.json:
//   films   slug → { title, year, tmdbId, imdbId, t, v, r, rn, rt, c }  forever (a slug never changes identity).
//           v:2 records also hold what the same page says about the film: r = Letterboxd average (0–5),
//           rn = number of ratings, rt = runtime in minutes, c = countries. Older records are read again, up to
//           2,000 a night, to fill these in.
//   users   per friend: /films/ ratings, /watchlist/, last RSS snapshot, fetchedAt  (pages: 7 days, RSS: every build).
//           A /films/ page that is due is not read whole every time: most weeks only the recent news is (/films/by/date/ and
//           /films/by/rated-date/, a few pages), and the whole history once every 28 days at most 35 (readUserFilms). Per user:
//           filmsAt (last successful read), filmsFullAt (last whole read), filmsMode, filmsReadPages, filmsHidden (the page's count minus the films read).
//   lists   per configured friend list, in the owner's order
//   me      slugs on YOUR public /films/ page, so "already seen" is exact even if your CSV export is old
//   watchlist  your live /watchlist/ (only a complete read is kept; --cache-only builds from it)
//   following  who you follow (all pages, read through Chrome: lib/fetch-chrome.js); lib/lists.js reads it, each one's /films/
//           history (Chrome; whole or incremental, see `users`), watchlist (HTTP) and diary RSS into `users`. Those people are "the crowd":
//           every film's seenBy / friendsAvg / wantBy (lib/crowd.js) is counted over them. Per user: filmsPages and filmsTotal describe the
//           whole history (pages, the page's own count).
//
// Pure parsers are exported for the tests (test/friends.test.js).

const fs = require("fs");
const path = require("path");
const { norm, sleep, deadline, readCapped, LIMITS, recordLimitHit } = require("./util");

const BASE = "https://letterboxd.com";
const UA = "Mozilla/5.0 (compatible; mood-engine/1.0; personal Stremio addon)";
const DAY = 864e5;
const PAGE_TTL = 7 * DAY; // /films/ and /watchlist/ and lists are redone after a week
const MISS_TTL = 30 * DAY; // a slug without an IMDb link is looked at again after a month
// One Letterboxd page is 100–500 KB and comes in 1–3 s. A try that takes more than 45 s (the answer and its whole body), or a body past
// 20 MB, is a failed try (lib/util.js deadline / readCapped), retried like a network error; both generous on purpose.
// The numbers live in lib/util.js LIMITS.letterboxd (config.json "limits" can override them); these two are their values when the module loads.
const TIMEOUT_MS = LIMITS.letterboxd.timeoutMs;
const MAX_BYTES = LIMITS.letterboxd.maxBytes;
const LOVE_RESOLVE_MAX = 400; // how many "Friends loved" candidates are looked up (friendRows.love.resolveMax)

// ── parsers (pure) ───────────────────────────────────────────────────────────

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lrm: "" };
function decode(s) {
  return String(s ?? "").replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, d, h, n) =>
    d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : NAMED[n.toLowerCase()] ?? m
  );
}

// A film slug as Letterboxd writes it (review of catalog-expansion, security finding 2; written 11/10/2026, landed 13/10/2026 in branch v24-hardening). The slug read from a page becomes a
// cache key and the path of https://letterboxd.com/film/<slug>/, so `..`, `/`, `?`, `%`, capitals or spaces are refused: a slug of
// `../..` would point the lookup at another letterboxd.com path. The BACKLOG asked for `^[a-z0-9]+(?:-[a-z0-9]+)*$`; this pattern is that
// plus two real forms, because the strict one drops films. Measured on the committed caches (13/10/2026, cache/friends.json sha256
// 2e3bf2f6…, cache/lists.json fb6d7901…, plus data/lists/*.json: 20,569 distinct slugs): the strict pattern refuses 18, the one below 0.
// The 18 are `film:<number>` (Letterboxd's slug for some films, 17 in the caches: Squish!, Désiré, Hide and Seek, Ushpizin, Gather, The
// Box…, 7 with a resolved record such as film:761014 → tt14962190) and an underscore joining two words (`post-angel-img_5466-2021`, one,
// on a watchlist). On the cache commits of 11/10/2026 the same count was 18,749 to 18,750 slugs (caches only) and 15 `film:` ones.
// A hyphen or an underscore always sits between two letters or digits: `_`, `__proto__` and `a_` are refused. A name that is already on
// every object (`constructor`) is refused too, so a slug can never be read from a plain object's prototype; none of the 20,569 is one.
const SLUG_RE = /^(?:film:\d+|[a-z0-9]+(?:[-_][a-z0-9]+)*)$/;
const validSlug = (s) => typeof s === "string" && SLUG_RE.test(s) && !(s in Object.prototype);
/** Slugs refused since the process started (or the last reset): { n, examples (the first 5) }. build.js logs it after the night's reads. */
const slugsRefused = { n: 0, examples: [] };
function refuseSlug(s) { slugsRefused.n++; if (slugsRefused.examples.length < 5) slugsRefused.examples.push(String(s).slice(0, 60)); }
function resetRefusedSlugs() { slugsRefused.n = 0; slugsRefused.examples.length = 0; }

/** The <ul> that holds the page's own posters (not the "Cloned from…" or "Popular" widgets). */
function mainGrid(html) {
  const open = html.match(/<ul class="(?:grid|poster-list)[ "][^>]*>/);
  if (!open) return html;
  const from = open.index + open[0].length;
  const to = html.indexOf("</ul>", from);
  return html.slice(from, to < 0 ? undefined : to);
}

/**
 * Posters on /films/, /watchlist/ and /list/<slug>/ pages → [{ slug, title, year, rating }].
 * Slug: data-item-slug on the poster (data-film-slug on older markup). Title: the <img alt>.
 * Year: the "(1999)" suffix of data-item-name. Rating: the "rated-N" class (N = stars × 2), only
 * present on the owner's own /films/ page.
 */
function parsePosters(html) {
  const items = [];
  const seen = new Set();
  for (const m of mainGrid(html).matchAll(/<li\b[^>]*class="(?:griditem|posteritem)[^"]*"[^>]*>([\s\S]*?)<\/li>/g)) {
    const chunk = m[1];
    const slug = (chunk.match(/data-(?:item|film)-slug="([^"]+)"/) || chunk.match(/data-target-link="\/film\/([^/"]+)\//) || [])[1];
    if (!slug || seen.has(slug)) continue;
    if (!validSlug(slug)) { refuseSlug(slug); continue; }
    seen.add(slug);
    const name = decode((chunk.match(/data-item-name="([^"]*)"/) || [])[1]);
    const ym = name.match(/^(.*?)\s*\((\d{4})\)\s*$/);
    const alt = decode((chunk.match(/<img\b[^>]*\balt="([^"]*)"/) || [])[1]);
    const r = chunk.match(/\brated-(\d{1,2})\b/);
    const n = r ? Number(r[1]) : 0;
    items.push({ slug, title: alt || (ym ? ym[1] : name), year: ym ? Number(ym[2]) : null, rating: n >= 1 && n <= 10 ? n / 2 : null });
  }
  return items;
}

const parseFilmsPage = (html) => parsePosters(html);
const parseWatchlistPage = (html) => parsePosters(html).map(({ slug, title, year }) => ({ slug, title, year }));
const parseListPage = (html) => parsePosters(html).map(({ slug, title, year }) => ({ slug, title, year }));

/** Path of the "Older" link, or null on the last page. */
function parseNext(html) {
  const tag = html.match(/<a\b[^>]*\bclass="next"[^>]*>/);
  const href = tag && tag[0].match(/href="([^"]+)"/);
  return href ? decode(href[1]) : null;
}

/** The member's own count on /<user>/films/: `<span class="tooltip" title="1,696&nbsp;films">Watched</span>`. null when the page has none. */
function parseFilmsTotal(html) {
  const m = html.match(/title="([\d,]+)(?:&nbsp;|\s)+films?"[^>]*>\s*Watched\b/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

/**
 * /film/<slug>/ → { title, year, tmdbId, tmdbType, imdbId, rating, ratings, runtime, countries }.
 * imdbId is null when the page has no IMDb link. rating is Letterboxd's weighted average on its 0–5 scale
 * (`twitter:data2`, "3.92 out of 5"; the JSON-LD `ratingValue` if that tag is missing), null when nobody rated it.
 * runtime is the "128 mins" footer, countries the /films/country/ links of the details panel.
 */
function parseFilmPage(html) {
  const body = html.match(/<body\b[^>]*>/);
  const tmdbType = (body && body[0].match(/data-tmdb-type="(\w+)"/) || [])[1] || (html.match(/themoviedb\.org\/(movie|tv)\/\d+/) || [])[1] || null;
  const tmdbRaw = (body && body[0].match(/data-tmdb-id="(\d+)"/) || [])[1] || (html.match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/) || [])[1];
  const og = decode((html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1]);
  const ogm = og.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  const h1 = decode((html.match(/<h1\b[^>]*primaryname[^>]*>\s*<span class="name[^"]*">([^<]*)<\/span>/) || [])[1]);
  const yr = (html.match(/class="releasedate"><a href="\/films\/year\/(\d{4})\//) || [])[1] || (ogm && ogm[2]);
  const avg = (html.match(/<meta name="twitter:data2" content="(\d(?:\.\d+)?) out of 5"/) || html.match(/"aggregateRating":\{[^}]*"ratingValue":(\d(?:\.\d+)?)/) || [])[1];
  const nRatings = (html.match(/"aggregateRating":\{[^}]*"ratingCount":(\d+)/) || [])[1];
  const mins = (html.match(/class="text-link text-footer">\s*([\d,]+)(?:&nbsp;|\s)*mins?\b/) || [])[1];
  const countries = [...new Set([...html.matchAll(/href="\/films\/country\/[^"]+"[^>]*>\s*([^<]+?)\s*<\/a>/g)].map((m) => decode(m[1])))];
  return {
    title: h1 || (ogm ? ogm[1] : og) || null,
    year: yr ? Number(yr) : null,
    // A TMDB *tv* id lives in another number space: never let it pass for a movie id.
    tmdbId: tmdbRaw && tmdbType !== "tv" ? Number(tmdbRaw) : null,
    tmdbType,
    imdbId: (html.match(/imdb\.com\/title\/(tt\d+)/) || [])[1] || null,
    rating: avg ? Number(avg) : null,
    ratings: nRatings ? Number(nRatings) : null,
    runtime: mins ? Number(mins.replace(/,/g, "")) || null : null,
    countries,
  };
}

/** A friend's diary RSS → [{ slug, title, year, rating, watched, rewatch, tmdbId }], newest first. */
function parseFriendRss(xml) {
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
    return m ? decode(m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim()) : "";
  };
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const title = tag(b, "letterboxd:filmTitle");
    const slug = (tag(b, "link").match(/\/film\/([^/]+)\//) || [])[1];
    if (!title || !slug) continue; // list or review items
    if (!validSlug(slug)) { refuseSlug(slug); continue; }
    const rating = tag(b, "letterboxd:memberRating");
    out.push({
      slug,
      title,
      year: Number(tag(b, "letterboxd:filmYear")) || null,
      rating: rating ? Number(rating) : null,
      watched: tag(b, "letterboxd:watchedDate") || null,
      rewatch: /yes/i.test(tag(b, "letterboxd:rewatch")),
      tmdbId: Number(tag(b, "tmdb:movieId")) || null,
    });
  }
  return out;
}

// ── HTTP: polite, with backoff ────────────────────────────────────────────────

class BlockedError extends Error {
  constructor(url) { super(`Letterboxd refused the request (403): ${url}`); this.name = "BlockedError"; }
}

/** A page that says it is Forbidden (a private watchlist, say) is not Cloudflare's challenge: Letterboxd's own "Letterboxd - Forbidden" title. */
const isForbiddenPage = (body) => /<title>[^<]*\bForbidden\b/i.test(body) && !/just a moment/i.test(body);

function makeHttp({ fetchImpl = globalThis.fetch, sleepImpl = sleep, ua = UA, retries = 5, circuit = 3, timeoutMs = LIMITS.letterboxd.timeoutMs, maxBytes = LIMITS.letterboxd.maxBytes, log = console.warn } = {}) {
  const wait = (a, res) => Math.min(60000, Number(res?.headers?.get?.("retry-after")) * 1000 || 1000 * 2 ** a);
  let blocked = 0; // refusals in a row. After `circuit` of them nothing more is asked this run: a challenge is not a thing to hammer.
  async function once(url) {
    let forbidden = 0, lastLimit = null; // lastLimit: the deadline or size cap that failed a try, named in the final error
    for (let a = 0; a <= retries; a++) {
      let res, text = "";
      const d = deadline(timeoutMs); // one deadline for the answer and its body
      try {
        res = await d.race(fetchImpl(url, { signal: d.signal, headers: { "User-Agent": ua, "Accept-Language": "en-US,en;q=0.9" }, redirect: "follow" }));
        if (res.ok) text = await d.race(readCapped(res, maxBytes));
      } catch (e) {
        d.clear();
        if (e && e.name === "LimitError") { lastLimit = e; recordLimitHit("letterboxd", e.message, log); } // `limit hit letterboxd: …`, as the five other sites
        await sleepImpl(wait(a)); // no answer, a deadline passed or a body past the cap: a failed try
        continue;
      }
      if (res.status !== 403) d.clear(); // a 403's body is still to be read, under the same deadline
      if (res.status === 404 || res.status === 410) return { status: 404, text: "", url: res.url || url };
      if (res.status === 403) {
        // Letterboxd's own "Forbidden" (MUBI's and Criterion's watchlists are private) is an answer, not a challenge: it counts as absent,
        // is not retried, and does not count toward the three refusals that stop the run.
        let body = "";
        try { body = await d.race(readCapped(res, maxBytes)); } catch (e) { if (e && e.name === "LimitError") recordLimitHit("letterboxd", e.message, log); /* unreadable, late or too large: treated as a challenge */ } finally { d.clear(); }
        if (isForbiddenPage(body)) return { status: 404, text: "", url: res.url || url, forbidden: true };
        if (++forbidden > 1) throw new BlockedError(url);
        await sleepImpl(5000);
        continue;
      }
      if (res.status === 429 || res.status >= 500) { await sleepImpl(wait(a, res)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
      return { status: res.status, text, url: res.url || url };
    }
    throw new Error(`Letterboxd did not answer after ${retries + 1} tries: ${url}${lastLimit ? ` (last limit hit: ${lastLimit.message})` : ""}`);
  }
  return {
    /** → { status, text, url }. 404/410 return status 404; 429/5xx are retried; a repeated 403 throws BlockedError. */
    async get(url) {
      if (blocked >= circuit) throw new BlockedError(url);
      try {
        const r = await once(url);
        blocked = 0;
        return r;
      } catch (e) {
        if (e instanceof BlockedError) blocked++;
        throw e;
      }
    },
  };
}

/**
 * Follows the "Older" links from `firstPath`, collecting posters until the last page.
 * If a later page fails (Cloudflare sometimes challenges /films/page/N/), what was read so far is returned
 * with `partial: true` instead of being thrown away. A failure on the first page throws.
 * `onPage(html, index)` sees each page's raw text (the watchlist header carries the total, for instance).
 * `stopWhen(pageItems, html, index)` is asked after each page is taken in; true ends the walk there (`stopped: true`).
 * `missingLaterIsPartial` treats a linked page that disappears as an unfinished read, for incremental orderings.
 * A walk that reaches `maxPages` with an "Older" link still on the page says so (`capped: true`).
 */
async function crawl(http, firstPath, parse, { gapMs = 500, maxPages = 300, sleepImpl = sleep, onPage = () => {}, stopWhen = null, missingLaterIsPartial = false } = {}) {
  const items = [], slugs = new Set(), visited = new Set();
  let p = firstPath, pages = 0;
  while (p && pages < maxPages && !visited.has(p)) {
    visited.add(p);
    let r;
    try {
      r = await http.get(BASE + p);
    } catch (e) {
      if (!pages) throw e;
      return { items, pages, missing: false, partial: true, error: e.message };
    }
    if (r.status === 404) {
      if (!pages) return { items: [], pages: 0, missing: true, partial: false };
      if (missingLaterIsPartial) return { items, pages, missing: false, partial: true, error: `HTTP 404 on page ${pages + 1}` };
      break;
    }
    const found = parse(r.text);
    for (const it of found) if (!slugs.has(it.slug)) { slugs.add(it.slug); items.push(it); }
    onPage(r.text, pages); // pages = how many were read before this one (0 on the first)
    pages++;
    if (stopWhen && stopWhen(found, r.text, pages - 1)) return { items, pages, missing: false, partial: false, stopped: true };
    p = parseNext(r.text);
    if (p) await sleepImpl(gapMs);
  }
  return { items, pages, missing: false, partial: false, capped: !!p && pages >= maxPages };
}

/** New rows first, then older cached rows (same slug in column 0) that the new read did not reach. */
function mergeRows(fresh, old = []) {
  const have = new Set(fresh.map((r) => r[0]));
  return [...fresh, ...old.filter((r) => !have.has(r[0]))];
}

// ── cache ────────────────────────────────────────────────────────────────────

const emptyCache = () => ({ version: 1, users: {}, lists: {}, me: null, films: {} });

function loadCache(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return emptyCache(); // first run
    throw e;
  }
  try {
    const c = JSON.parse(text);
    return { ...emptyCache(), ...c, users: c.users || {}, lists: c.lists || {}, films: c.films || {} };
  } catch (e) {
    // An unreadable cache is NOT an empty one: starting from nothing would re-read thousands of pages, weaken the
    // "already seen" check (your own /films/ slugs live here) and then overwrite the file.
    throw new Error(`${file} is not valid JSON (${e.message}). Fix it (a merge conflict marker?) or delete it on purpose.`);
  }
}

function saveCache(file, cache) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`; // one name per process: two builds saving at once must not rename each other's file away
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, file);
}

// A TTL is "about this old", with a margin: a nightly build that starts a few minutes earlier than last week's must not find the
// pages "still fresh" and wait one more day. A partial read is retried daily.
const MARGIN = 4 * 3600e3;
const stale = (iso, now, partial = false) => !iso || now - Date.parse(iso) > (partial ? DAY : PAGE_TTL) - MARGIN;
const iso = (now) => new Date(now).toISOString();

// ── view: the cache as the rows want to read it ───────────────────────────────

/**
 * The people whose RATINGS are not used (config.json `ratingsIgnored.users`, Marco, 22/10/2026 ~04:55 UTC) → Set of lower-case Letterboxd user names.
 * A value that is not a list of non-empty strings stops the build: a typo must not quietly put a 5★-for-everything account back in every average.
 */
function ratingsIgnoredSet(cfg) {
  const users = cfg && cfg.ratingsIgnored && cfg.ratingsIgnored.users;
  if (users == null) return new Set();
  if (!Array.isArray(users) || users.some((x) => typeof x !== "string" || !x.trim())) throw new Error("config.json ratingsIgnored.users must be a list of Letterboxd user names (non-empty strings).");
  return new Set(users.map((x) => x.trim().toLowerCase()));
}

/**
 * The general rule (config.json `ratingsIgnored.rule`, Marco, 22/10/2026 ~06:40 UTC): a person who gives ONE value in `share` or more of their ratings, having at least
 * `minRatings` ratings, has their ratings ignored, without being named. → null (no rule) or { share, minRatings }.
 * `share` must be more than half and at most 1 (so the most common value is one, and 95 typed for 0.95 stops the build); `minRatings` a whole number from 1.
 */
function ratingsRuleOf(cfg) {
  const rule = cfg && cfg.ratingsIgnored && cfg.ratingsIgnored.rule;
  if (rule == null) return null;
  const ok = typeof rule === "object" && !Array.isArray(rule) && typeof rule.share === "number" && rule.share > 0.5 && rule.share <= 1 && Number.isInteger(rule.minRatings) && rule.minRatings >= 1;
  if (!ok) throw new Error("config.json ratingsIgnored.rule must be { share, minRatings }: share a number above 0.5 and at most 1 (0.95, not 95), minRatings a whole number from 1.");
  return { share: rule.share, minRatings: rule.minRatings };
}

/** What both parts of `ratingsIgnored` say, read (and validated) once → { list: Set, rule: null | { share, minRatings } }. */
function ratingsPolicy(cfg) {
  return { list: ratingsIgnoredSet(cfg), rule: ratingsRuleOf(cfg) };
}

/** How a person rates: the films (Map of { rating }) → { n: rated films, value: the most common rating, count: how many gave it, share: count / n }. n 0: value null. */
function ratingSpread(films) {
  const counts = new Map();
  let n = 0;
  for (const f of films.values()) if (f.rating != null) { n++; counts.set(f.rating, (counts.get(f.rating) || 0) + 1); }
  let value = null, count = 0;
  for (const [v, c] of counts) if (c > count || (c === count && v < value)) { value = v; count = c; }
  return { n, value, count, share: n ? count / n : 0 };
}

/** Does this spread trip the rule? At least `minRatings` ratings and the most common value in `share` or more of them (count / n is one correctly rounded division: 48 / 50 is 0.96, 19 / 20 is exactly the 0.95 typed). */
const tripsRule = (spread, rule) => !!rule && spread.n >= rule.minRatings && spread.count / spread.n >= rule.share;

/**
 * One person as the rows read them: films (RSS over the cached /films/ page), watchlist, when the page was read.
 * `ratingsIgnored` (Marco, 22/10/2026 ~04:55 UTC, "take a friend out of the ratings, he only either doesnt vote or gives 5 if he likes it with no discrimination"):
 * every rating of this person reads as null, from the /films/ page AND from the diary. The rule is read at THREE places, each with its own test (review of 22/10/2026, LOW 3):
 * here, which the rows, counters and rules reach through viewFriends and userReader (build.js userOf), so none of them has an `if` of its own; lib/lists.js
 * watchedThisWeek, which reads the diary straight from the cache (choosePeople marks the person); and crowdStats below, which counts the log's "rated" from the cache's
 * own rows. tools/films/project.js reads this view and keeps what the account saw in `seen`. What they SAW (films, with their diary dates) and WANT (watchlist)
 * is untouched: the activity rows and the seenBy / wantBy counters still count them. cache/friends.json keeps the real ratings, so taking the name off
 * the list gives them back on the next build.
 * The general rule (`rule`, Marco, 22/10/2026 ~06:40 UTC) is judged here too, on the ratings of the person as this function reads them, before it nulls them: `ratingsIgnoredBy` is
 * "list" or "rule", and for "rule" `ratingSpread` says why ({ n, value, count, share }). A person who is in the list is "list" whatever their ratings.
 * The two readers above that go to the cache without a view do not carry a copy of the judgement: lib/lists.js choosePeople and watchedThisWeek ask `ratingsIgnoredBy` below,
 * which asks this function, so the list and the rule are decided here and nowhere else; crowdStats reads the flags this function sets.
 */
function userView(cache, user, name, ratingsIgnored = false, rule = null) {
  const u = cache.users[user] || {};
  const films = new Map();
  (u.films || []).forEach(([slug, title, year, rating], order) => films.set(slug, { slug, title, year, rating, order, watched: null }));
  const newest = new Set(); // only the newest diary entry of a film counts; the RSS lists newest first
  for (const [slug, title, year, rating, watched] of u.rss || []) {
    if (newest.has(slug)) continue;
    newest.add(slug);
    const f = films.get(slug) || { slug, title, year, rating: null, order: -1, watched: null };
    if (rating != null) f.rating = rating; // an entry without a rating keeps the rating from the /films/ page
    f.watched = watched;
    films.set(slug, f);
  }
  // `ratingsIgnored` (the list) or `rule` (the general rule, judged on the ratings as read here: the /films/ page with the diary laid over it) → the ratings read as null
  let by = ratingsIgnored ? "list" : null, spread = null;
  if (!by && rule) { spread = ratingSpread(films); if (tripsRule(spread, rule)) by = "rule"; }
  if (by) for (const f of films.values()) f.rating = null;
  const watchlist = new Map((u.watchlist || []).map(([slug, title, year]) => [slug, { slug, title, year }]));
  return { user, name: name || user, films, watchlist, fetchedAt: u.fetchedAt || null, ratingsIgnored: !!by, ...(by ? { ratingsIgnoredBy: by } : {}), ...(by === "rule" ? { ratingSpread: spread } : {}) };
}

/**
 * A reader of one person of cache.users by user name, for the rows that name a person (lib/special-rows.js ctx.userOf: the friend of the day of top-picks, who may be
 * in cache.users without being in the partial /following/ list) → userView(...) or null. It applies the same ratingsIgnored rule as viewFriends.
 */
function userReader(cache, cfg) {
  const { list, rule } = ratingsPolicy(cfg);
  return (user) => (cache?.users && Object.hasOwn(cache.users, user) ? userView(cache, user, cache.users[user].name, list.has(String(user).toLowerCase()), rule) : null);
}

/**
 * Are the ratings of this person ignored, and why? For the readers that go to the cache without a view (lib/lists.js choosePeople and watchedThisWeek):
 * → null, { by: "list" } or { by: "rule", spread }. The same judgement as userView, because it asks userView.
 */
function ratingsIgnoredBy(cache, user, policy) {
  if (policy.list.has(String(user).toLowerCase())) return { by: "list" };
  if (!policy.rule || !cache || !cache.users) return null;
  const v = userView(cache, user, null, false, policy.rule);
  return v.ratingsIgnoredBy ? { by: v.ratingsIgnoredBy, spread: v.ratingSpread } : null;
}

/** Everyone the counters read: the people you follow (all pages of /following/) plus the configured friends, never yourself. → [{ user, name }] */
function crowdPeople(cache, cfg) {
  const people = new Map();
  for (const [user, name] of (cache.following && cache.following.users) || []) people.set(String(user).toLowerCase(), { user, name: name || user });
  for (const f of cfg.friends || []) people.set(f.user.toLowerCase(), { user: f.user, name: f.name || f.user });
  people.delete(String(cfg.letterboxd || "").toLowerCase());
  return [...people.values()];
}

/**
 * users: the configured friends [{ user, name, films: Map(slug → { slug, title, year, rating, order, watched }),
 *           watchlist: Map(slug → { slug, title, year }), fetchedAt }]
 * crowd: the same shape for everyone you follow plus the configured friends (51 people on 10/10/2026): "Friends loved" and the
 *        seenBy / friendsAvg / wantBy counters read them. The per-friend rows of Discover still read only `users`.
 * RSS wins over the cached /films/ page when both know a film: it is fresher, and its date is the "recency".
 */
function viewFriends(cache, cfg) {
  const { list, rule } = ratingsPolicy(cfg);
  const read = ({ user, name }) => userView(cache, user, name, list.has(String(user).toLowerCase()), rule);
  const users = (cfg.friends || []).map(read);
  const crowd = crowdPeople(cache, cfg).map(read);
  const lists = (cfg.friendLists || []).map((l) => {
    const c = cache.lists[`${l.owner}/${l.slug}`] || {};
    return { ...l, items: (c.items || []).map(([slug, title, year]) => ({ slug, title, year })), fetchedAt: c.fetchedAt || null };
  });
  return { users, crowd, lists, me: new Set((cache.me && cache.me.slugs) || []), films: cache.films };
}

/**
 * "All friends loved" (Marco, 28/10/2026, Discover proposal 5): every film that ANYONE of the crowd (the people you follow plus the configured friends, 51 on 28/10/2026, annamendesc, jusodre and luizasodre
 * included) rated `minStars` or more and that you have not seen. The same reading of a rating as every other friends row: `crowd` is viewFriends().crowd, so a person whose ratings are ignored (config.json
 * ratingsIgnored: the list and the general rule) has null ratings here and loves nothing; what they SAW does not count either, only a rating at or above the bar does.
 *   crowd       viewFriends().crowd: [{ user, name, films: Map(slug → { rating }) }]
 *   films       viewFriends().films: slug → { imdbId, tmdbId, gone, ... } (Letterboxd's record of the film)
 *   isSeen      isSeen({ slug, ...record }) → bool: the build's guard (TMDB id, IMDb id, Letterboxd slug, title ±1 year)
 *   minStars    the bar, ≥ (config.json friendRows.love.minStars, 4; friendRows.all.minStars when it names its own)
 *   unrecorded  unrecorded({ imdbId, tmdbId }) → bool: TMDB has no MOVIE of it (a series, an episode), which no friends row shows (optional)
 * → the IMDb ids, each once, in the order the crowd met them. It decides WHO loved a film, not which films the index holds nor in which order: build.js (lib/friends-option.js addFriendsOption) takes the ones
 * the index already knows, in the index's order.
 */
function allFriendsLoved({ crowd, films, isSeen = () => false, minStars = 4, unrecorded = () => false }) {
  const out = new Set();
  for (const u of crowd || [])
    for (const f of u.films.values()) {
      if (f.rating == null || !(f.rating >= minStars)) continue;
      const r = films[f.slug];
      if (!r || r.gone || !r.imdbId || out.has(r.imdbId)) continue;
      if (isSeen({ slug: f.slug, ...r }) || unrecorded({ imdbId: r.imdbId, tmdbId: r.tmdbId || null })) continue;
      out.add(r.imdbId);
    }
  return [...out];
}

// ── what to resolve first ────────────────────────────────────────────────────

/** Round-robin over several queues, skipping repeats. */
function roundRobin(queues) {
  const out = [], seen = new Set();
  for (let i = 0; queues.some((q) => i < q.length); i++)
    for (const q of queues) if (i < q.length && !seen.has(q[i])) { seen.add(q[i]); out.push(q[i]); }
  return out;
}

/**
 * Orders every slug by how soon a row needs it, so a short run (--friends-limit) or an interrupted first
 * build still fills the rows that matter: films several friends loved, list items, shared watchlist
 * films, each friend's top picks. Everything else (lower ratings, other watchlist films) comes last.
 * `onMyWatchlist({title, year})` tells which friend watchlist films are also on yours.
 */
function prioritize(view, rowsCfg, onMyWatchlist = () => false) {
  const love = rowsCfg?.love || {}, top = rowsCfg?.top || {};
  const minLove = love.minStars ?? 4, solo = love.soloStars ?? 4.5, minFriends = love.minFriends ?? 2, minTop = top.minStars ?? 4.5;

  const agg = new Map();
  for (const u of view.crowd || view.users)
    for (const f of u.films.values())
      if (!view.me || !view.me.has(f.slug))
      if (f.rating != null && f.rating >= minLove) {
        const a = agg.get(f.slug) || { n: 0, sum: 0, max: 0 };
        a.n++; a.sum += f.rating; a.max = Math.max(a.max, f.rating);
        agg.set(f.slug, a);
      }
  const loveQ = [...agg]
    .filter(([, a]) => a.n >= minFriends || a.max >= solo)
    .sort((a, b) => b[1].n * (b[1].sum / b[1].n) - a[1].n * (a[1].sum / a[1].n))
    .slice(0, love.resolveMax ?? LOVE_RESOLVE_MAX) // the row shows 50 (sizes.friends): its best few hundred are looked up, not every film someone rated 4.5★
    .map(([slug]) => slug);

  const listQ = roundRobin(view.lists.map((l) => l.items.map((i) => i.slug)));
  const sessionQ = roundRobin(view.users.map((u) => [...u.watchlist.values()].filter(onMyWatchlist).map((i) => i.slug)));
  const topQ = roundRobin(
    view.users.map((u) =>
      [...u.films.values()].filter((f) => f.rating != null && f.rating >= minTop).sort((a, b) => b.rating - a.rating || a.order - b.order).map((f) => f.slug)
    )
  );
  const head = roundRobin([loveQ, listQ, sessionQ, topQ]);

  const rest = [];
  for (const u of view.users) {
    rest.push(...[...u.films.values()].filter((f) => f.rating != null).sort((a, b) => b.rating - a.rating).map((f) => f.slug));
    rest.push(...u.watchlist.keys());
    rest.push(...[...u.films.values()].filter((f) => f.rating == null).map((f) => f.slug));
  }
  const seen = new Set(head);
  return [...head, ...rest.filter((s) => !seen.has(s) && seen.add(s))];
}

// ── refresh: the network part ────────────────────────────────────────────────

const needsResolve = (rec, now) => !rec || (!rec.imdbId && now - rec.t > MISS_TTL);
/** A record from before v2 knows no average rating, runtime or countries. Read its page again to fill them in. */
const needsEnrich = (rec) => !!rec && !rec.gone && (rec.v || 1) < 2;
const ENRICH_PER_RUN = 2000;

/**
 * Looks up /film/<slug>/ for each slug that still needs it. Two at a time, ~700 ms between batches,
 * progress saved every 100. A block (403) stops the run but keeps everything gathered so far.
 *   slugs    in the order the rows need them; the ones with no record (or an old miss) are looked up
 *   enrich   slugs that have a record from before v2 (no average rating / runtime / countries), most useful first;
 *            read again after the new ones, at most `enrichMax` per run
 *   limit    at most this many pages in all this run (new first, then enrich)
 */
async function resolveFilms({ slugs, enrich = [], enrichMax = ENRICH_PER_RUN, cache, http, limit = Infinity, parallel = 2, gapMs = 700, saveEvery = 100, save = () => {}, log = () => {}, now = Date.now(), sleepImpl = sleep }) {
  // the URL is built from the slug: one that is not a Letterboxd slug (from an old cache, a list correction) is never asked for
  const bad = new Set([...slugs, ...enrich].filter((s) => !validSlug(s)));
  for (const s of bad) refuseSlug(s);
  const own = (s) => (Object.hasOwn(cache.films, s) ? cache.films[s] : undefined); // never an inherited property
  const todo = slugs.filter((s) => !bad.has(s) && needsResolve(own(s), now));
  const isNew = new Set(todo);
  const stale2 = [...new Set(enrich)].filter((s) => !bad.has(s) && !isNew.has(s) && needsEnrich(own(s)));
  const refresh = stale2.slice(0, enrichMax);
  const batch = [...todo, ...refresh].slice(0, limit);
  const res = { wanted: todo.length, attempted: 0, withImdb: 0, withoutImdb: 0, notFound: 0, aborted: null, left: 0, enrichWanted: stale2.length, enriched: 0 };
  const t0 = Date.now();
  let sinceSave = 0, badStreak = 0;
  for (let i = 0; i < batch.length; i += parallel) {
    const group = batch.slice(i, i + parallel);
    try {
      await Promise.all(
        group.map(async (slug) => {
          const r = await http.get(`${BASE}/film/${slug}/`);
          res.attempted++;
          if (r.status === 404) { cache.films[slug] = { title: null, year: null, tmdbId: null, imdbId: null, gone: true, t: now }; res.notFound++; return; }
          const f = parseFilmPage(r.text);
          if (!f.title && !f.tmdbId && !f.imdbId) { badStreak++; return; } // not a film page (layout change or a challenge page): do not cache
          badStreak = 0;
          const old = own(slug);
          const canon = (r.url.match(/\/film\/([^/]+)\//) || [])[1];
          const imdbId = f.imdbId || (old && old.imdbId) || null; // a read-again that loses the IMDb link keeps the one it had
          // A read-again keeps what it already knew when the page, this time, does not say it (a title, a TMDB id, the redirect target).
          const keepCanon = canon && canon !== slug ? canon : old && old.canon;
          cache.films[slug] = {
            title: f.title || (old && old.title) || null, year: f.year ?? (old && old.year) ?? null, tmdbId: f.tmdbType === "tv" ? null : f.tmdbId ?? (old && old.tmdbId) ?? null, ...(f.tmdbType === "tv" ? { tmdbType: "tv" } : {}), imdbId,
            ...(keepCanon ? { canon: keepCanon } : {}),
            ...(f.rating != null ? { r: f.rating } : {}), ...(f.ratings != null ? { rn: f.ratings } : {}),
            ...(f.runtime ? { rt: f.runtime } : {}), ...(f.countries.length ? { c: f.countries } : {}),
            t: now, v: 2,
          };
          if (isNew.has(slug)) imdbId ? res.withImdb++ : res.withoutImdb++;
          else res.enriched++;
        })
      );
    } catch (e) {
      if (e instanceof BlockedError) { res.aborted = e.message; break; }
      throw e;
    }
    if (badStreak >= 6) { res.aborted = "6 pages in a row did not look like Letterboxd film pages (blocked, or the layout changed)"; break; }
    sinceSave += group.length;
    if (sinceSave >= saveEvery) {
      save();
      sinceSave = 0;
      const done = res.attempted, per = (Date.now() - t0) / done;
      log(`     … ${done}/${batch.length} films looked up (about ${Math.round((per * (batch.length - done)) / 60000)} min to go)`);
    }
    if (i + parallel < batch.length) await sleepImpl(gapMs);
  }
  save();
  res.left = todo.length - (res.withImdb + res.withoutImdb + res.notFound);
  return res;
}

/** Every account's whole history is read again at most this often (days) on its own turn; see `filmsPlan`. */
const FULL_EVERY = 28; // an account's turn comes round every 28 days and lasts TURN_DAYS (see onTurn)
const TURN_DAYS = 7; // as long as the weekly read interval, so exactly one weekly read of each account falls inside its turn
const FULL_MAX_AGE = 35 * DAY; // whatever the turns say, a whole read older than this is redone
const FULL_MIN_AGE = PAGE_TTL - MARGIN; // on its turn, an account read whole less than a week ago waits for the next one (same margin as `stale`)
const INCREMENTAL_MAX_PAGES = 5; // per ordering: a walk of five pages that still finds news gives up and reads the whole history
const FILMS_BY_DATE = (user) => `/${user}/films/by/date/`; // "added, newest first": every film, rated or not; catches new films
const FILMS_BY_RATED = (user) => `/${user}/films/by/rated-date/`; // "rating, newest first": rated films first, unrated last; catches new or changed ratings

/** FNV-1a of the lower-cased name, mod FULL_EVERY: the first day of this account's turn (onTurn) in each 28-day cycle. Stable, so the 51 accounts spread over the cycle. */
function slot(user) {
  let h = 0x811c9dc5;
  for (const ch of Buffer.from(String(user).toLowerCase(), "utf8")) { h ^= ch; h = Math.imul(h, 0x01000193) >>> 0; }
  return h % FULL_EVERY;
}

/** Whether `now` falls in the account's turn: the TURN_DAYS days starting on day slot(user) of each FULL_EVERY-day cycle. A single
 *  day would only meet 1 weekly read in 7 (the read repeats every 7 days, not every day); a 7-day window meets exactly one. */
function onTurn(user, now) {
  return (((Math.floor(now / DAY) - slot(user)) % FULL_EVERY) + FULL_EVERY) % FULL_EVERY < TURN_DAYS;
}

/**
 * How `readUserFilms` reads this account now → { mode: "full" | "incremental", why, fullAt, hidden }.
 *   full when: `force`; no films cached; an incremental read stopped before its end (`filmsNeedsFull`: the cache holds half of its news, and
 *   a later incremental read would stop on the page that looks known); the last read was partial; no whole read on record (an old record with films, a complete read and
 *   no `filmsFullAt` counts `filmsAt` as one); the last whole read is FULL_MAX_AGE old; it is the account's turn (`slot`) and the last whole
 *   read is a week old; or the cache cannot say how many films the page hides (`hidden`, see below; a whole read that came up short has none).
 *   incremental otherwise.
 * `hidden` = the page's own count minus the films read: the few a grid does not show. It is the yardstick of the incremental read: if
 * count − films-in-cache moves, something was deleted or added out of sight and only a whole read can tell what. It sees the NET sum only:
 * a film deleted and a film the grid hides added in the same week leave it where it was, and the deleted film stays in the cache until the
 * next whole read (at most 28 days).
 */
function filmsPlan(u, user, now, force = false) {
  const cached = (u.films || []).length;
  const at = u.filmsFullAt || (!u.filmsPartial && cached ? u.filmsAt : null);
  const fullAt = at && Number.isFinite(Date.parse(at)) ? at : null;
  // filmsHidden: a number is the yardstick of the last whole read; null says that read could not give one (a short read); undefined is a
  // record from before it existed, whose yardstick is worked out from the count and the films it held
  const hidden = u.filmsHidden === undefined ? (Number.isFinite(u.filmsTotal) ? u.filmsTotal - cached : null) : Number.isFinite(u.filmsHidden) ? u.filmsHidden : null;
  const full = (why) => ({ mode: "full", why, fullAt, hidden });
  if (force) return full("forced");
  if (!cached) return full("nothing cached");
  if (u.filmsNeedsFull) return full("an incremental read did not finish");
  if (u.filmsPartial) return full("last read was partial");
  if (!fullAt) return full("no whole read on record");
  if (hidden == null) return full("hidden count unknown");
  const age = now - Date.parse(fullAt);
  if (age >= FULL_MAX_AGE) return full("last whole read too old");
  if (onTurn(user, now) && age >= FULL_MIN_AGE) return full("its turn");
  return { mode: "incremental", why: "recent news only", fullAt, hidden };
}

/**
 * Reads one member's /films/ history into cache.users[user] (`u`): rows [slug, title, year, rating], when (filmsAt), how many
 * pages (filmsPages) and the page's own count (filmsTotal) for the whole history. Two ways, chosen by `filmsPlan`:
 *   full         every page of /films/ (Chrome: ~1 page per 72 films). By plain HTTP only page 1 comes back and the read is partial; with no
 *                Chrome at all (`http.viaChrome === false`) this is the only way. Sets filmsFullAt and filmsHidden when complete and not
 *                short against the page's count (a short read has filmsHidden null: the next due read is whole again); clears filmsNeedsFull.
 *   incremental  /films/by/date/ (added, newest first) until a page where every film is already cached, then /films/by/rated-date/
 *                (rating, newest first) until a page where every film is cached with the same rating; at most INCREMENTAL_MAX_PAGES each.
 *                New rows are merged over the cache. It is trusted only if the page's count minus the merged films equals `filmsHidden` of
 *                the last read; otherwise (a film deleted, one hidden, no count on the page, five pages without reaching the known) the
 *                whole history is read in the same call. A removed rating is not seen by either ordering: the next whole read fixes it.
 *                A page with no film on it after the first, or a page that fails, ends the read early: what came is merged, filmsAt is
 *                left alone and filmsNeedsFull is set, so the next due read is whole (an incremental read would stop at the first page
 *                that looks known, and the half of the news that never came would stay out).
 * `filmsMode` says which one ran, `filmsReadPages` how many pages this call fetched. A partial read is merged into what was cached and
 * retried the next day; an incremental read that fails after its first page merges what it got and leaves filmsAt alone (so it is retried
 * the next night). A page that shows a total but none of its films is a layout change: nothing is stored. A member with no films at all
 * is remembered as empty for the week. `force` (--friends-refresh) always reads the whole history.
 * → { read, pages, total, partial, mode, pagesRead } or null when the read failed (the problem is in `problems`).
 */
async function readUserFilms({ u, user, http, pageGap, now, problems, guarded, force = false }) {
  // Without Chrome (routed() with no browser) Cloudflare closes by/date and by/rated-date to HTTP, page 1 included: only the whole read has
  // something to try (page 1 of /films/, merged into the cache and retried daily, as before the incremental read existed).
  const plan = http.viaChrome === false ? { mode: "full", why: "no Chrome" } : filmsPlan(u, user, now, force);
  let spent = 0;
  if (plan.mode === "incremental") {
    const r = await readFilmsIncremental({ u, user, http, pageGap, now, problems, guarded, plan });
    if (!r || !r.fallback) return r;
    spent = r.pagesRead;
  }
  return readFilmsFull({ u, user, http, pageGap, now, problems, guarded, spent });
}

async function readFilmsFull({ u, user, http, pageGap, now, problems, guarded, spent = 0 }) {
  let total = null;
  const r = await guarded(`${user}/films`, () => crawl(http, `/${user}/films/`, parseFilmsPage, { ...pageGap, onPage: (html, i) => { if (i === 0) total = parseFilmsTotal(html); } }));
  if (!r) return null;
  const pagesRead = spent + r.pages;
  const rows = r.items.map((i) => [i.slug, i.title, i.year, i.rating]);
  const hiddenOf = (n) => (total == null ? null : total - n);
  if (r.partial) problems.push(`${user}/films: read ${r.pages} page(s) of /films/, the rest is unreachable (${r.error})`);
  if (rows.length) {
    u.films = r.partial ? mergeRows(rows, u.films) : rows;
    u.filmsAt = iso(now); u.filmsPartial = r.partial; u.filmsPages = r.pages; u.filmsTotal = total; u.filmsMode = "full"; u.filmsReadPages = pagesRead;
    // the page's own count is a check on the read: a few films the grid hides are normal (2%, at least 3), a missed page is not
    const short = !r.partial && total != null && rows.length < total - Math.max(3, Math.round(total * 0.02));
    if (short) problems.push(`${user}/films: read ${rows.length} films but the page says ${total}`);
    if (!r.partial) delete u.filmsNeedsFull;
    if (!r.partial && !short) { u.filmsFullAt = iso(now); u.filmsHidden = hiddenOf(rows.length); }
    else if (short) u.filmsHidden = null; // the gap is not "hidden films": it must not become the yardstick an incremental read trusts
  } else if (total) problems.push(`${user}/films: the page says ${total} films but none could be read (layout change?); kept the cache`);
  else if ((u.films || []).length) problems.push(`${user}/films: read 0 films but the cache had ${u.films.length}; kept the cache`);
  else { u.films = []; u.filmsAt = iso(now); u.filmsPartial = false; u.filmsPages = r.pages; u.filmsTotal = total; u.filmsMode = "full"; u.filmsReadPages = pagesRead; u.filmsFullAt = iso(now); u.filmsHidden = hiddenOf(0); delete u.filmsNeedsFull; } // an empty or private profile: not asked again tonight
  return { read: rows.length, pages: r.pages, total, partial: r.partial, mode: "full", pagesRead };
}

/** → the result of readUserFilms, null (failed), or { fallback: true, pagesRead } when only a whole read can settle it. */
async function readFilmsIncremental({ u, user, http, pageGap, now, problems, guarded, plan }) {
  const rowOf = (i) => [i.slug, i.title, i.year, i.rating];
  const known = new Map((u.films || []).map(([slug, , , rating]) => [slug, rating]));
  let total = null, pagesRead = 0, emptyA = 0, emptyB = 0; // emptyX: the page number of a page with no film on it, after the first
  const fallback = () => ({ fallback: true, pagesRead });
  const first = (items, html) => { total = parseFilmsTotal(html); return total == null || !items.length; }; // no count, or a count with no film on the page: nothing to go on

  // a. what was added: newest first, until a page where nothing is new
  const a = await guarded(`${user}/films/by/date`, () => crawl(http, FILMS_BY_DATE(user), parseFilmsPage, {
    ...pageGap, maxPages: INCREMENTAL_MAX_PAGES, missingLaterIsPartial: true,
    stopWhen: (items, html, i) => {
      if (i === 0 && first(items, html)) return true;
      if (!items.length) { emptyA = i + 1; return true; } // never "every film is known": an empty page proves nothing
      return items.every((it) => known.has(it.slug));
    },
  }));
  if (!a) return null; // the first page failed: nothing read, nothing changed, as in a whole read
  pagesRead += a.pages;
  if (a.missing || a.capped || total == null) return fallback();
  if (!a.items.length) { // the first page has no film
    if (!total) return fallback(); // ...and a count of 0: the whole read decides what that means
    problems.push(`${user}/films/by/date: the page says ${total} films but none could be read (layout change?); kept the cache`);
    return null; // a count with none of its films: nothing is stored
  }
  const byDate = a.items.map(rowOf);
  let merged = mergeRows(byDate, u.films);
  const partial = (error) => { // a later page failed: keep what came, leave filmsAt alone and ask for a whole read next time (`error` is empty when `guarded` has already told)
    if (!Number.isFinite(u.filmsHidden)) u.filmsHidden = plan.hidden; // pinned before the cache grows: a record from before filmsHidden worked it out from the cache as it was
    u.films = merged;
    u.filmsNeedsFull = true;
    if (error) problems.push(`${user}/films: incremental read stopped after ${pagesRead} page(s) (${error}); kept what came, will be retried`);
    return { read: byDate.length, pages: u.filmsPages ?? null, total, partial: true, mode: "incremental", pagesRead };
  };
  if (a.partial) return partial(a.error);
  if (emptyA) return partial(`page ${emptyA} of /films/by/date/ showed no film`);

  // b. what was rated or re-rated. Against the cache as it was BEFORE this call (`known`), not against what a. just brought: a film new this
  // week is on rated-date too, and a page made only of films a. already brought would end the walk before an older film re-rated this week.
  const current = new Map(merged.map(([slug, , , rating]) => [slug, rating]));
  const b = await guarded(`${user}/films/by/rated-date`, () => crawl(http, FILMS_BY_RATED(user), parseFilmsPage, {
    ...pageGap, maxPages: INCREMENTAL_MAX_PAGES, missingLaterIsPartial: true,
    stopWhen: (items, html, i) => {
      if (!items.length) { if (i > 0) emptyB = i + 1; return true; }
      return items.every((it) => known.has(it.slug) && known.get(it.slug) === it.rating);
    },
  }));
  if (!b) return partial(null); // the first page of this ordering failed; `guarded` has put the reason in `problems`
  pagesRead += b.pages;
  if (b.missing || b.capped) return fallback();
  if (!b.items.length) { // the same layout check as above
    if (!total) return fallback();
    problems.push(`${user}/films/by/rated-date: the page says ${total} films but none could be read (layout change?); kept the cache`);
    return null;
  }
  // changed rows are overwritten where they stand (the order is the one a whole read gives); unknown ones go first
  const at = new Map(merged.map((r, i) => [r[0], i]));
  const extra = [];
  for (const i of b.items) {
    const row = rowOf(i);
    if (at.has(row[0])) { if (current.get(row[0]) !== row[3]) merged[at.get(row[0])] = row; } else extra.push(row);
  }
  merged = mergeRows(extra, merged);
  if (b.partial) return partial(b.error);
  if (emptyB) return partial(`page ${emptyB} of /films/by/rated-date/ showed no film`);

  // e. the page's count minus the films we hold must still be what it was
  if (total - merged.length !== plan.hidden) return fallback();
  u.films = merged;
  u.filmsAt = iso(now); u.filmsPartial = false; u.filmsMode = "incremental"; u.filmsReadPages = pagesRead;
  u.filmsTotal = total; u.filmsHidden = plan.hidden; u.filmsFullAt = plan.fullAt;
  return { read: new Set([...byDate, ...b.items.map(rowOf)].map((r) => r[0])).size, pages: u.filmsPages ?? null, total, partial: false, mode: "incremental", pagesRead };
}

/** Same for a /watchlist/: rows [slug, title, year], watchlistAt, watchlistPages. */
async function readUserWatchlist({ u, user, http, pageGap, now, problems, guarded }) {
  const r = await guarded(`${user}/watchlist`, () => crawl(http, `/${user}/watchlist/`, parseWatchlistPage, pageGap));
  if (!r) return null;
  const rows = r.items.map((i) => [i.slug, i.title, i.year]);
  if (r.partial) problems.push(`${user}/watchlist: read ${r.pages} page(s), the rest is unreachable (${r.error})`);
  if (rows.length || !(u.watchlist || []).length) { u.watchlist = r.partial ? mergeRows(rows, u.watchlist) : rows; u.watchlistAt = iso(now); u.watchlistPartial = r.partial; u.watchlistPages = r.pages; }
  if (r.missing) u.watchlistPrivate = true; else delete u.watchlistPrivate; // Letterboxd says "Forbidden" (a private watchlist) or "Not Found": nothing to read, not a failure
  return { read: rows.length, pages: r.pages, partial: r.partial, missing: r.missing };
}

/**
 * Brings cache/friends.json up to date and returns the view.
 *   cfg:    config.json (friends, friendLists, friendRows, letterboxd)
 *   limit:  at most this many film pages looked up this run, new ones first (--lookup-limit, --friends-limit)
 *   force:  read every page again, whatever the cache age (--friends-refresh)
 *   cache:  an already loaded cache (build.js shares one with the live-watchlist read); default: read `file`
 *   extra:  async ({ cache, http, guarded, problems, log, now, force, old, pageGap, save }) → { first, last, enrich }
 *           lets another module (lib/lists.js) read its own pages with the same http/cache and say which film
 *           slugs to look up: `first` before the friends' own priorities, `last` after, `enrich` to read again
 *   onMyWatchlist / log / now / http: injected for tests
 * Network trouble never kills the build: a friend whose pages fail keeps yesterday's cache and is reported.
 */
async function refreshFriends({ cfg, file, http = makeHttp(), limit = Infinity, force = false, cache: shared, extra, enrichMax, onMyWatchlist, log = console.log, now = Date.now(), sleepImpl = sleep, gapMs = 700 }) {
  const cache = shared || loadCache(file);
  const save = () => saveCache(file, cache);
  const problems = [];
  const guarded = async (what, fn) => {
    try { return await fn(); } catch (e) { problems.push(`${what}: ${e.message}`); log(`  ! ${what}: ${e.message} — keeping the previous cache`); return null; }
  };
  const pageGap = { gapMs: Math.min(500, gapMs), sleepImpl };
  const old = (at, partial) => force || stale(at, now, partial);

  for (const { user, name } of cfg.friends || []) {
    const u = (cache.users[user] ||= {});
    u.name = name || user;
    if (old(u.filmsAt, u.filmsPartial)) await readUserFilms({ u, user, http, pageGap, now, problems, guarded, force });
    if (old(u.watchlistAt, u.watchlistPartial)) await readUserWatchlist({ u, user, http, pageGap, now, problems, guarded });
    const rss = await guarded(`${user}/rss`, async () => {
      const r = await http.get(`${BASE}/${user}/rss/`);
      return r.status === 404 ? null : parseFriendRss(r.text);
    });
    if (rss) { u.rss = rss.map((i) => [i.slug, i.title, i.year, i.rating, i.watched]); u.rssAt = iso(now); }
    u.fetchedAt = iso(now);
    save();
  }

  for (const l of cfg.friendLists || []) {
    const key = `${l.owner}/${l.slug}`;
    const c = cache.lists[key];
    if (c && !old(c.fetchedAt, c.partial)) continue;
    const r = await guarded(`list ${key}`, () => crawl(http, `/${l.owner}/list/${l.slug}/`, parseListPage, pageGap));
    if (!r) continue;
    if (r.missing) { problems.push(`list ${key}: gone or private`); continue; }
    const rows = r.items.map((i) => [i.slug, i.title, i.year]);
    if (r.partial) problems.push(`list ${key}: read ${r.pages} page(s), the rest is unreachable (${r.error})`);
    if (rows.length || !c) cache.lists[key] = { fetchedAt: iso(now), partial: r.partial, items: r.partial ? mergeRows(rows, c && c.items) : rows };
  }

  // Your own public /films/: exact slugs for the "already seen" guard.
  if (cfg.letterboxd && (!cache.me || old(cache.me.fetchedAt, cache.me.partial) || cache.me.user !== cfg.letterboxd)) {
    const r = await guarded(`${cfg.letterboxd}/films (you)`, () => crawl(http, `/${cfg.letterboxd}/films/`, parseFilmsPage, pageGap));
    if (r && r.items.length) {
      const slugs = r.items.map((i) => i.slug);
      if (r.partial) problems.push(`${cfg.letterboxd}/films (you): read ${r.pages} page(s) of /films/ (${r.error})`);
      cache.me = { user: cfg.letterboxd, fetchedAt: iso(now), partial: r.partial, pages: r.pages, slugs: r.partial ? [...new Set([...slugs, ...((cache.me && cache.me.slugs) || [])])] : slugs };
    }
  }
  save();

  const more = extra ? (await extra({ cache, http, guarded, problems, log, now, force, old, pageGap, save })) || {} : {};
  save();

  const view = viewFriends(cache, cfg);
  const order = [...new Set([...(more.first || []), ...prioritize(view, cfg.friendRows, onMyWatchlist), ...(more.last || [])])];
  const resolved = await resolveFilms({ slugs: order, enrich: more.enrich || [], enrichMax, cache, http, limit, save, log, now, sleepImpl, gapMs });
  if (resolved.aborted) problems.push(`lookup stopped early: ${resolved.aborted}`);
  save();
  return { view: viewFriends(cache, cfg), cache, resolved, problems };
}

/** Per-friend numbers for the build log: read, rated, resolved with an IMDb id, dropped for lacking one, still pending. */
function friendStats(view) {
  const rows = view.users.map((u) => {
    const s = { user: u.user, name: u.name, read: u.films.size, rated: 0, withTt: 0, noImdb: 0, pending: 0, watchlist: u.watchlist.size, fetchedAt: u.fetchedAt };
    for (const f of u.films.values()) {
      if (f.rating != null) s.rated++;
      const rec = view.films[f.slug];
      if (!rec) s.pending++;
      else if (rec.imdbId) s.withTt++;
      else s.noImdb++;
    }
    return s;
  });
  return rows;
}

/**
 * Per person of the crowd, for the build log: pages and films read from /films/, how many are rated, how many are known to have an
 * IMDb id (the lookup is lazy: only what a row needs is resolved), how many were dropped (no IMDb id, or gone), how many are not looked up yet.
 * `rated` counts the ratings the rows USE: a person whose ratings are ignored (userView) has 0, and `ratingsIgnored: true` says it, `ratingsIgnoredBy` ("list" or "rule") why, and for the rule `ratingSpread` the numbers.
 */
function crowdStats(view, cache) {
  return view.crowd.map((p) => {
    const u = cache.users[p.user] || {};
    const s = { user: p.user, name: p.name, pages: u.filmsPages ?? null, read: (u.films || []).length, total: u.filmsTotal ?? null, rated: 0, withTt: 0, dropped: 0, pending: 0, watchlist: (u.watchlist || []).length, fetchedAt: u.filmsAt || null, partial: !!u.filmsPartial, ...(p.ratingsIgnored ? { ratingsIgnored: true, ratingsIgnoredBy: p.ratingsIgnoredBy, ...(p.ratingSpread ? { ratingSpread: p.ratingSpread } : {}) } : {}) };
    for (const [slug, , , rating] of u.films || []) {
      if (rating != null && !p.ratingsIgnored) s.rated++;
      const rec = view.films[slug];
      if (!rec) s.pending++;
      else if (rec.gone || !rec.imdbId) s.dropped++;
      else s.withTt++;
    }
    return s;
  });
}

module.exports = {
  parsePosters, parseFilmsPage, parseWatchlistPage, parseListPage, parseNext, parseFilmsTotal, parseFilmPage, parseFriendRss, decode,
  validSlug, slugsRefused, resetRefusedSlugs, SLUG_RE, TIMEOUT_MS, MAX_BYTES,
  allFriendsLoved, makeHttp, isForbiddenPage, BlockedError, crawl, mergeRows, resolveFilms, refreshFriends, readUserFilms, readUserWatchlist, loadCache, saveCache, viewFriends, userView, userReader, ratingsIgnoredSet, ratingsRuleOf, ratingsPolicy, ratingSpread, tripsRule, ratingsIgnoredBy, crowdPeople, prioritize, friendStats, crowdStats, needsResolve, needsEnrich,
  roundRobin, stale, iso, BASE, PAGE_TTL, MISS_TTL, MARGIN, ENRICH_PER_RUN, LOVE_RESOLVE_MAX,
  slot, filmsPlan, FULL_EVERY, TURN_DAYS, onTurn, FULL_MAX_AGE, FULL_MIN_AGE, INCREMENTAL_MAX_PAGES,
};
