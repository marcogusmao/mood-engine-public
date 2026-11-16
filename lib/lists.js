// Sources for the v2 rows, all from public Letterboxd pages (no login):
//   - the curated lists in config.json → lists[] (cache/lists.json, 7 days; "Popular this week": every night)
//   - your own live watchlist, /<you>/watchlist/page/N/ (replaces watchlist.csv when the read is complete)
//   - the people you follow, /<you>/following/page/N/, and each one's diary RSS (cache/friends.json)
// Film identity (the tt id) is looked up afterwards by lib/friends.js resolveFilms, the same cache for all of it.

const fs = require("fs");
const path = require("path");
const F = require("./friends");
const { sleep, mapLimit, limitedFetch } = require("./util");
const SL = require("./static-lists");

const DAY = 864e5;
// A TTL is "about this old", with a margin: a nightly build that starts a few seconds earlier than last night's must not
// find yesterday's read "still fresh" and skip a whole day (or, for the lists, a whole week).
const MARGIN = 4 * 3600e3;
const LIST_TTL = 7 * DAY;
const POPULAR_TTL = 1 * DAY;
const FOLLOWING_TTL = 1 * DAY;
const RSS_FRESH = 30 * 60 * 1000; // a diary read less than half an hour ago is not read again
const DEFAULT_WEEK = { days: 7, max: 200 };
const CROWD_TTL = 7 * DAY; // each followed person's /films/ history (the recent news, or the whole of it on the account's turn: lib/friends.js readUserFilms) and watchlist are read again after a week

// ── parsers (pure) ───────────────────────────────────────────────────────────

/** /<user>/following/ → [{ slug: user, user, name }] (slug is the key crawl() de-duplicates on). */
function parseFollowingPage(html) {
  const out = [], seen = new Set();
  for (const m of html.matchAll(/<h3 class="title-3">\s*<a href="\/([^/"]+)\/"\s+class="name">\s*([^<]*?)\s*<\/a>/g)) {
    const user = m[1];
    if (seen.has(user)) continue;
    seen.add(user);
    out.push({ slug: user, user, name: F.decode(m[2]) || user });
  }
  return out;
}

/** /films/popular/this/week/ → [{ slug, title, year }]: the same poster grid as every other Letterboxd film list. */
const parsePopularPage = (html) => F.parsePosters(html).map(({ slug, title, year }) => ({ slug, title, year }));

/** The watchlist header says how many films there are: `js-watchlist-count">564&nbsp;films<`. */
function parseWatchlistTotal(html) {
  const m = html.match(/js-watchlist-count">\s*([\d,]+)(?:&nbsp;|\s)*films?\b/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

/** A list page's own title and size: og:title, and "A list of 250 films compiled on Letterboxd…" from the description. */
function parseListMeta(html) {
  const title = F.decode((html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1]);
  const total = (html.match(/<meta name="description" content="A list of ([\d,]+) films?\b/) || [])[1];
  return { title: title || null, total: total ? Number(total.replace(/,/g, "")) : null };
}

/** https://letterboxd.com/official/list/top-250/ → /official/list/top-250/ (null if it is not a list address). */
function listPath(url) {
  const m = String(url || "").match(/^https?:\/\/(?:www\.)?letterboxd\.com(\/[^/?#]+\/list\/[^/?#]+\/)/);
  return m ? m[1] : null;
}

/**
 * https://boxd.it/<id> → the list's address, by reading the redirect (one request, no page body).
 * Anything that is not a Letterboxd list address is refused: a typo in an id must not publish somebody else's page.
 */
async function resolveBoxd(id, { fetchImpl = globalThis.fetch, ua = "Mozilla/5.0 (compatible; mood-engine/1.0; personal Stremio addon)", log } = {}) {
  if (!/^[0-9A-Za-z]{2,12}$/.test(id)) throw new Error(`"${id}" is not a boxd.it id`);
  // under LIMITS.boxd: a deadline for the answer; the body is never read (cancelled), so there is no byte cap. A deadline is thrown, and refreshLists puts it in `problems`.
  const { res } = await limitedFetch("boxd", fetchImpl, `https://boxd.it/${id}`, { headers: { "User-Agent": ua }, redirect: "manual" }, { as: "none", log });
  const loc = res.headers && res.headers.get && res.headers.get("location");
  const target = loc ? new URL(loc, `https://boxd.it/${id}`).href : res.url;
  const p = listPath(target);
  if (!p) throw new Error(`boxd.it/${id} did not lead to a Letterboxd list (${res.status} → ${loc ? target : "no redirect location"})`);
  return `https://letterboxd.com${p}`;
}

// ── lists cache ──────────────────────────────────────────────────────────────

const emptyListsCache = () => ({ version: 1, urls: {}, lists: {}, menus: {} });

function loadListsCache(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return emptyListsCache(); // first run
    throw e;
  }
  try {
    const c = JSON.parse(text);
    return { ...emptyListsCache(), ...c, urls: c.urls || {}, lists: c.lists || {}, menus: c.menus || {} };
  } catch (e) {
    // An unreadable cache is NOT an empty one: starting from nothing would re-read thousands of pages and then overwrite it.
    throw new Error(`${file} is not valid JSON (${e.message}). Fix it (a merge conflict marker?) or delete it on purpose.`);
  }
}

function saveListsCache(file, cache) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`; // one name per process: two builds saving at once must not rename each other's file away
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, file);
}

/**
 * config.json → lists[].corrections: [{ from, to, why }]. A curator's copy that points at the wrong film page (the BBC list's
 * "The Discreet" 1990 for The Discreet Charm of the Bourgeoisie) is corrected here, in the order the curator gave, never in the
 * cache: the cache stays what Letterboxd says. A correction whose `from` is no longer in the list does nothing, and says so.
 */
function correct(l, items, problems = []) {
  if (!(l.corrections || []).length || !items.length) return items;
  let out = items;
  for (const c of l.corrections) {
    const i = out.findIndex((it) => it.slug === c.from);
    if (i < 0) { problems.push(`list ${l.id} (${l.name}): the correction ${c.from} → ${c.to} no longer applies (${c.from} is not in the list)`); continue; }
    out = out.slice();
    out[i] = { slug: c.to, title: null, year: null, corrected: c.from };
  }
  return out;
}

/**
 * Which list films to look up tonight: every slug that already has a record (nothing to ask), and the first `cap` that have none,
 * in the order given (build.js: position by position across the lists). → { now: [slug], later: Set(slug) }
 */
function capLookups(slugs, films, cap = Infinity) {
  const unknown = slugs.filter((s) => !films[s]);
  const later = new Set(unknown.slice(cap));
  return { now: slugs.filter((s) => !later.has(s)), later, unknown: unknown.length };
}

/**
 * config.json → lists[].top: N. Only the first N films of the curator's order enter (Marco, 22/10/2026 ~06:45 UTC: "pega os top 250 das listas" of the
 * TSPDT). The page is read up to the page that holds the Nth film (100 a page on Letterboxd: N = 250 reads three pages, not the ten of a list of 1,000),
 * the rest is dropped and the cache keeps only the N. null when the list has no cut.
 */
const topOf = (l) => (l && Number.isInteger(l.top) && l.top > 0 ? l.top : null);
const cutTop = (rows, top) => (top ? rows.slice(0, top) : rows);

const isOld = (at, now, ttl, partial = false) => !at || now - Date.parse(at) > (partial ? Math.min(ttl, DAY) : ttl) - MARGIN;

/**
 * Reads every list in cfg.lists that is older than its TTL (7 days; Popular this week: 1 day).
 * A list that cannot be read keeps its previous cache and is named in `problems`.
 * cacheOnly: ask nobody and write nothing; return what the cache holds.
 * → { lists: [{ ...configEntry, url, items: [{slug,title,year}], fetchedAt, partial, total, title, read }], problems }
 */
async function refreshLists({ cfg, file, http = F.makeHttp(), force = false, cacheOnly = false, now = Date.now(), log = () => {}, sleepImpl = sleep, resolve = resolveBoxd, gapMs = 500, root = path.join(__dirname, "..") }) {
  const cache = loadListsCache(file);
  const problems = [];
  const out = [];
  for (const l of cfg.lists || []) {
    if (SL.isStatic(l)) { // an article kept in the repository (data/lists/<id>.json): no page to read, no TTL, nothing in the cache
      const data = SL.load(root, l);
      out.push({ ...l, url: data.source.url, items: SL.itemsOf(data), fetchedAt: `${data.source.readOn}T00:00:00.000Z`, partial: false, total: data.items.length, title: data.source.title, read: SL.describe(data) });
      continue;
    }
    const ttl = l.popular ? POPULAR_TTL : LIST_TTL;
    let url = l.url || cache.urls[l.id];
    if (!url && !cacheOnly) {
      try {
        url = await resolve(l.id);
        cache.urls[l.id] = url;
        log(`     boxd.it/${l.id} → ${url}`);
      } catch (e) {
        problems.push(`list ${l.id} (${l.name}): ${e.message}`);
      }
    }
    const c = cache.lists[l.id];
    const top = topOf(l);
    if (!cacheOnly && url && (force || !c || c.url !== url || (c.top ?? null) !== top || isOld(c.fetchedAt, now, ttl, c.partial))) { // a cut that changed (250 → 500, or none) reads the list again at once
      const p = l.popular ? new URL(url).pathname : listPath(url);
      let meta = { title: null, total: null };
      try {
        const parse = l.popular ? parsePopularPage : F.parseListPage;
        const got = new Set(); // the slugs met so far: the cut stops the reading at the page that holds the Nth film
        const stopWhen = top ? (found) => { for (const it of found) got.add(it.slug); return got.size >= top; } : null;
        const r = await F.crawl(http, p, parse, { gapMs, sleepImpl, maxPages: l.popular ? 1 : 60, stopWhen, onPage: (html, i) => { if (i === 0) meta = parseListMeta(html); } });
        if (r.missing) problems.push(`list ${l.id} (${l.name}): gone or private`);
        else {
          if (r.partial) problems.push(`list ${l.id} (${l.name}): read ${r.pages} page(s), the rest is unreachable (${r.error})`);
          const want = top && meta.total ? Math.min(top, meta.total) : meta.total; // with a cut, the films asked for are the first N, not the whole list
          if (!l.popular && want && r.items.length < want) problems.push(`list ${l.id} (${l.name}): read ${r.items.length} of ${want} films`);
          const rows = cutTop(r.items.map((i) => [i.slug, i.title, i.year]), top);
          if (rows.length || !c) cache.lists[l.id] = { url, fetchedAt: F.iso(now), partial: r.partial, total: meta.total, title: meta.title, ...(top ? { top } : {}), items: cutTop(r.partial ? F.mergeRows(rows, c && c.items) : rows, top) };
        }
      } catch (e) {
        problems.push(`list ${l.id} (${l.name}): ${e.message}`);
      }
    }
    const k = cache.lists[l.id];
    const items = correct(l, cutTop((k && k.items) || [], top).map(([slug, title, year]) => ({ slug, title, year })), problems);
    // A copy checked against the original article (decision 6, Marco 11/10/2026) keeps the count it had then: say so when it changes.
    if (l.checked && k && items.length !== l.checked.films) problems.push(`list ${l.id} (${l.name}): ${items.length} films, but ${l.checked.films} when it was checked against the original on ${l.checked.on} — check it again`);
    out.push({ ...l, url: url || null, items, fetchedAt: (k && k.fetchedAt) || null, partial: !!(k && k.partial), total: (k && k.total && top ? Math.min(k.total, top) : k && k.total) || null, title: (k && k.title) || null }); // total = the films the list holds for us: with a cut, at most N (build.js reads `items < total` as a partial read)
  }
  if (!cacheOnly) saveListsCache(file, cache);
  return { lists: out, problems };
}

// ── your live watchlist ──────────────────────────────────────────────────────

/**
 * Reads /<user>/watchlist/page/N/ to the last page. `ok` only when the read is complete: the header's total
 * (564 films) is matched, give or take a few films the grid hides (2%, at least 3), and no page was refused. With no total
 * on the page there is nothing to check against, so that is not ok either. Otherwise `ok: false` with the reason,
 * and the caller falls back to watchlist.csv.
 * → { ok, items: [{slug,title,year}], pages, total, reason }
 */
async function readLiveWatchlist({ user, http = F.makeHttp(), sleepImpl = sleep, gapMs = 500 }) {
  let total = null;
  let r;
  try {
    r = await F.crawl(http, `/${user}/watchlist/`, F.parseWatchlistPage, { gapMs, sleepImpl, onPage: (html, i) => { if (i === 0) total = parseWatchlistTotal(html); } });
  } catch (e) {
    return { ok: false, items: [], pages: 0, total, reason: e.message };
  }
  const base = { items: r.items, pages: r.pages, total };
  if (r.missing) return { ok: false, ...base, reason: "watchlist page not found (private?)" };
  if (r.partial) return { ok: false, ...base, reason: `read ${r.pages} page(s), then ${r.error}` };
  if (!r.items.length) return { ok: false, ...base, reason: "no films found on the page (layout change?)" };
  if (total == null) return { ok: false, ...base, reason: "the page shows no total to check the read against (layout change?)" };
  // The page counts every film on the list; a film the grid hides can leave a handful short. A whole missed page (28) is never within this.
  const slack = Math.max(3, Math.round(total * 0.02));
  if (r.items.length < total - slack) return { ok: false, ...base, reason: `read ${r.items.length} films but the page says ${total}` };
  return { ok: true, ...base, reason: null };
}

// ── the people you follow, and what they logged this week ───────────────────

/**
 * Who the week row reads: the first `max` people you follow (all of them, with the default 200) plus the configured friends,
 * who are read anyway. → { people: [{ user, name, configured }], followed, limited }
 */
function choosePeople({ cfg, cache }) {
  const wk = { ...DEFAULT_WEEK, ...(cfg.weekRow || {}) };
  const followed = ((cache.following && cache.following.users) || []).map(([user, name]) => ({ user, name }));
  const configured = new Map((cfg.friends || []).map((x) => [x.user.toLowerCase(), x]));
  const policy = F.ratingsPolicy(cfg); // config.json ratingsIgnored (the list and the general rule): the person is marked, and watchedThisWeek reads no rating of a marked person (Marco, 22/10/2026)
  const mark = (user) => { const w = F.ratingsIgnoredBy(cache, user, policy); return w ? { ratingsIgnored: true, ratingsIgnoredBy: w.by } : {}; };
  const people = [], seen = new Set();
  for (const p of followed.slice(0, wk.max)) {
    const k = p.user.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const c = configured.get(k);
    people.push({ user: p.user, name: c ? c.name || c.user : p.name, configured: !!c, ...mark(p.user) });
  }
  for (const c of configured.values()) if (!seen.has(c.user.toLowerCase())) { seen.add(c.user.toLowerCase()); people.push({ user: c.user, name: c.name || c.user, configured: true, ...mark(c.user) }); }
  return { people, followed: followed.length, limited: followed.length > wk.max };
}

/**
 * Reads who you follow (daily) and the diary RSS of the first `max` of them plus the configured friends,
 * into the same cache/friends.json the friends module uses. An RSS read less than 30 minutes ago is reused.
 * Followed people who are not configured friends keep only the last 14 days of their diary, or the week row's window plus a week if that is longer (that is all a
 * week row needs), or the Board's "friends-month" window plus a week (37 days) when the config has that row (lib/special-rows.js retentionDays). → { people, followed, used, limited, rssRead, rssFailed }
 */
async function readFollowing({ cfg, cache, http, guarded, problems, log, now, force, pageGap }) {
  const wk = { ...DEFAULT_WEEK, ...(cfg.weekRow || {}) };
  const me = cfg.letterboxd;
  if (!me) return { people: [], followed: 0, used: 0, limited: false, rssRead: 0, rssFailed: [] };

  const f = cache.following;
  if (force || !f || f.user !== me || isOld(f.fetchedAt, now, FOLLOWING_TTL, f.partial)) {
    const r = await guarded(`${me}/following`, () => F.crawl(http, `/${me}/following/`, parseFollowingPage, { ...pageGap, maxPages: 40 }));
    if (r && r.items.length) {
      if (r.partial) problems.push(`${me}/following: read ${r.pages} page(s) (${r.items.length} people), the rest is unreachable (${r.error})`);
      cache.following = { user: me, fetchedAt: F.iso(now), partial: r.partial, users: r.items.map((i) => [i.user, i.name]) };
    } else if (r && !r.items.length) problems.push(`${me}/following: read 0 people; kept the cache`);
  }

  const { people, followed, limited } = choosePeople({ cfg, cache });
  if (limited) log(`     Following: ${followed} people, using the first ${wk.max}`);
  const stats = { people, followed, used: people.length, limited, rssRead: 0, rssFailed: [] };

  const keepFrom = new Date(now - Math.max(14, wk.days + 7, require("./special-rows").retentionDays(cfg)) * DAY).toISOString().slice(0, 10);
  for (const p of people) {
    const u = (cache.users[p.user] ||= {});
    if (!p.configured) u.name = p.name;
    if (!force && u.rssAt && now - Date.parse(u.rssAt) < RSS_FRESH) continue;
    const rss = await guarded(`${p.user}/rss`, async () => {
      const r = await http.get(`${F.BASE}/${p.user}/rss/`);
      return r.status === 404 ? null : F.parseFriendRss(r.text);
    });
    if (!rss) { stats.rssFailed.push(p.user); continue; }
    const rows = (p.configured ? rss : rss.filter((i) => i.watched && i.watched >= keepFrom)).map((i) => [i.slug, i.title, i.year, i.rating, i.watched]);
    u.rss = rows;
    u.rssAt = F.iso(now);
    u.fetchedAt = F.iso(now);
    stats.rssRead++;
    await pageGap.sleepImpl(Math.min(pageGap.gapMs, 300));
  }
  return stats;
}

/**
 * The crowd's histories: for everyone in `people` who is not a configured friend (those are read with the friends, same cache),
 * the /films/ history (through Chrome) and the /watchlist/ (HTTP, 28 per page), each at most once a week (a partial read: the next
 * day). The history is read incrementally when it can be (a few pages of what is new or re-rated) and whole otherwise: ~1 page per 72
 * films, every 28 days per person, and whenever the page's count and the cache disagree (readUserFilms). Two people at a time. Saved to cache.users[user] after each one, so an interrupted
 * first read keeps what it got (`limit`: at most this many people, for development). A person whose pages fail is named in `problems` and keeps yesterday's cache.
 * → { people, filmsRead, filmsPagesRead, filmsFull, filmsIncremental, watchlistsRead, fresh, failed: [user], privateWatchlists: [user] }
 *   (filmsPagesRead: Chrome pages fetched for histories; filmsFull / filmsIncremental: how many histories were read each way) (a watchlist Letterboxd answers "Forbidden" on is private: not a failure)
 */
async function readCrowd({ cfg, cache, people, http, problems, log = () => {}, now, force, pageGap, save = () => {}, concurrency = 2, ttl = CROWD_TTL, limit = Infinity }) {
  const todo = people.filter((p) => !p.configured).slice(0, limit);
  const stats = { people: todo.length, filmsRead: 0, filmsPagesRead: 0, filmsFull: 0, filmsIncremental: 0, watchlistsRead: 0, fresh: 0, failed: [], privateWatchlists: [] };
  const guarded = async (what, fn) => {
    try { return await fn(); } catch (e) { problems.push(`${what}: ${e.message}`); log(`  ! ${what}: ${e.message} — keeping the previous cache`); return null; }
  };
  let done = 0;
  const t0 = Date.now();
  await mapLimit(todo, concurrency, async (p) => {
    const u = (cache.users[p.user] ||= {});
    u.name = p.name;
    const filmsDue = force || isOld(u.filmsAt, now, ttl, u.filmsPartial), listDue = force || isOld(u.watchlistAt, now, ttl, u.watchlistPartial);
    if (!filmsDue && !listDue) stats.fresh++;
    let bad = false;
    if (filmsDue) {
      const r = await F.readUserFilms({ u, user: p.user, http, pageGap, now, problems, guarded, force });
      if (r) { stats.filmsRead++; stats.filmsPagesRead += r.pagesRead; if (r.mode === "full") stats.filmsFull++; else stats.filmsIncremental++; } else bad = true;
    }
    if (listDue) { const r = await F.readUserWatchlist({ u, user: p.user, http, pageGap, now, problems, guarded }); if (r) { stats.watchlistsRead++; if (r.missing) stats.privateWatchlists.push(p.user); } else bad = true; }
    if (bad) stats.failed.push(p.user);
    u.fetchedAt = F.iso(now);
    save();
    done++;
    if ((filmsDue || listDue) && (done % 5 === 0 || done === todo.length)) log(`     … crowd ${done}/${todo.length} people (${Math.round((Date.now() - t0) / 60000)} min so far; histories: ${stats.filmsFull} whole, ${stats.filmsIncremental} incremental, ${stats.filmsPagesRead} pages)`);
  });
  return { ...stats, people: todo.length };
}

/**
 * Who logged what in the last `days` days (the date the film was WATCHED, not the day it was logged), from the RSS in
 * the cache. A day from today−days to today counts; tomorrow and last month do not.
 * → Map(slug → [{ user, name, rating, watched }]) — one entry per person, their newest entry for that film.
 * A person marked `ratingsIgnored` (choosePeople, config.json ratingsIgnored) is still in the week, "watched this week by Ben", but with rating null: the diary is read
 * from the cache here and not through lib/friends.js userView, so the rule is applied at this second place too.
 * With `cfg` the mark is judged again here, on the cache as it is NOW (lib/friends.js ratingsIgnoredBy, which asks userView): the people were chosen before the night's
 * histories were read (build.js: readFollowing, then readCrowd), and the general rule looks at those histories; the mark on the person is then not consulted. Without `cfg`
 * the mark choosePeople put on the person is used as it is.
 */
function watchedThisWeek({ cache, people, today, days = DEFAULT_WEEK.days, cfg }) {
  const policy = cfg ? F.ratingsPolicy(cfg) : null;
  const from = new Date(Date.parse(today + "T12:00:00Z") - days * DAY).toISOString().slice(0, 10);
  const bySlug = new Map();
  for (const p of people) {
    const ignored = policy ? !!F.ratingsIgnoredBy(cache, p.user, policy) : !!p.ratingsIgnored;
    const rss = (cache.users[p.user] && cache.users[p.user].rss) || [];
    const mine = new Map();
    for (const [slug, , , given, watched] of rss) {
      if (!watched || watched < from || watched > today) continue;
      const prev = mine.get(slug);
      const rating = ignored ? null : given;
      if (!prev || watched > prev.watched) mine.set(slug, { user: p.user, name: p.name, rating: rating != null ? rating : prev && prev.rating != null ? prev.rating : null, watched });
      else if (prev.rating == null && rating != null) prev.rating = rating;
    }
    for (const [slug, e] of mine) (bySlug.get(slug) || bySlug.set(slug, []).get(slug)).push(e);
  }
  return bySlug;
}

module.exports = {
  parseFollowingPage, parsePopularPage, parseWatchlistTotal, parseListMeta, listPath, resolveBoxd, correct, capLookups, topOf,
  loadListsCache, saveListsCache, refreshLists, readLiveWatchlist, choosePeople, readFollowing, readCrowd, watchedThisWeek,
  LIST_TTL, POPULAR_TTL, RSS_FRESH, CROWD_TTL,
};
