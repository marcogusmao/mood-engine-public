// node --test            (no dependencies)
// v2: the curated lists, the live watchlist, the people you follow, the pool and its cross cuts, the plan, the guard, the files.
// Fixtures in test/fixtures are real Letterboxd pages trimmed to a few items — except popular-page.html, see its test.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const F = require("../lib/friends");
const L = require("../lib/lists");
const P = require("../lib/pool");
const { buildPlan, guardRows, safeLabel, uniqueOptions, menusOf, menuChanges, GUARD_EXEMPT } = require("../lib/plan");
const { findLeaks, seenImdbIds } = require("../lib/guard");
const { buildFriendRows } = require("../lib/rows");
const { publish, manifestFor } = require("../lib/publish");
const { applyLiveWatchlist } = require("../lib/letterboxd");
const { verifyDir } = require("../verify");

const fx = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const ROOT = path.join(__dirname, "..");
const noSleep = async () => {};
const tmp = (p = "mood-v2-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

const fakeHttp = (routes) => ({
  calls: [],
  async get(url) {
    this.calls.push(url);
    const r = routes[url.replace("https://letterboxd.com", "")];
    if (r instanceof Error) throw r;
    if (!r) return { status: 404, text: "", url };
    return { status: 200, text: r, url };
  },
});

// ── parsers ──────────────────────────────────────────────────────────────────

test("/following/ page: user name and display name of each person, and the 'Older' link", () => {
  const html = fx("following-page.html");
  assert.deepEqual(L.parseFollowingPage(html).map(({ user, name }) => [user, name]), [
    ["matheushector", "Matheus Hector"], ["wimwenders", "Wim Wenders"], ["friend-e", "friend-e"],
  ]);
  assert.equal(F.parseNext(html), "/mgusmao/following/page/2/");
  assert.deepEqual(L.parseFollowingPage("<html>nothing</html>"), []);
});

test("Popular this week: the poster grid gives slug, title and year (fixture is the real /watchlist/ grid under another header: the live page answered 403 on 10/10/2026)", () => {
  assert.deepEqual(L.parsePopularPage(fx("popular-page.html")), [
    { slug: "local-hero", title: "Local Hero", year: 1983 },
    { slug: "resident-evil-2026", title: "Resident Evil", year: 2026 },
    { slug: "dawn-of-the-dead", title: "Dawn of the Dead", year: 1978 },
  ]);
});

test("watchlist page: the header total (564 films) and the posters", () => {
  const html = fx("watchlist-live-page.html");
  assert.equal(L.parseWatchlistTotal(html), 564);
  assert.equal(L.parseWatchlistTotal("<span class=\"js-watchlist-count\">1,204&nbsp;films</span>"), 1204);
  assert.equal(L.parseWatchlistTotal("<html></html>"), null);
  assert.deepEqual(F.parseWatchlistPage(html).map((i) => i.slug), ["local-hero", "resident-evil-2026", "dawn-of-the-dead"]);
});

test("list page header: the title and 'A list of 250 films'", () => {
  assert.deepEqual(L.parseListMeta(fx("list-meta.html")), { title: "Top 250 Films with the Most Fans", total: 250 });
});

test("list address: only /<owner>/list/<slug>/ counts, with or without the trailing page or query", () => {
  assert.equal(L.listPath("https://letterboxd.com/official/list/top-250-films-with-the-most-fans/"), "/official/list/top-250-films-with-the-most-fans/");
  assert.equal(L.listPath("https://letterboxd.com/etolkin/list/filmlist:28697007/?x=1"), "/etolkin/list/filmlist:28697007/");
  assert.equal(L.listPath("https://letterboxd.com/film/hereditary/"), null);
  assert.equal(L.listPath("https://example.com/a/list/b/"), null);
});

test("boxd.it/<id>: the redirect names the list", async () => {
  const redirect = (loc, status = 301) => async () => ({ status, url: "https://boxd.it/x", headers: { get: (h) => (h.toLowerCase() === "location" ? loc : null) } });
  assert.equal(await L.resolveBoxd("nVqt6", { fetchImpl: redirect("https://letterboxd.com/official/list/top-250-films-with-the-most-fans/") }), "https://letterboxd.com/official/list/top-250-films-with-the-most-fans/");
  assert.equal(await L.resolveBoxd("jq61y", { fetchImpl: redirect("https://letterboxd.com/etolkin/list/filmlist:28697007/?utm=1", 302) }), "https://letterboxd.com/etolkin/list/filmlist:28697007/");
});

test("boxd.it/<id>: a relative or foreign location, a film page, no location at all, or a typo'd id are refused", async () => {
  const redirect = (loc) => async () => ({ status: 301, url: "https://boxd.it/x", headers: { get: () => loc } });
  await assert.rejects(L.resolveBoxd("abc", { fetchImpl: redirect("https://letterboxd.com/film/hereditary/") }), /did not lead to a Letterboxd list/);
  await assert.rejects(L.resolveBoxd("abc", { fetchImpl: redirect("https://example.com/u/list/s/") }), /did not lead to a Letterboxd list/);
  await assert.rejects(L.resolveBoxd("abc", { fetchImpl: redirect("/closetpicks/list/all-time/") }), /did not lead to a Letterboxd list/); // relative to boxd.it, which is not Letterboxd
  await assert.rejects(L.resolveBoxd("abc", { fetchImpl: redirect(null) }), /no redirect location/);
  await assert.rejects(L.resolveBoxd("../etc", { fetchImpl: redirect("https://letterboxd.com/a/list/b/") }), /not a boxd\.it id/);
});

test("film page: Letterboxd's average rating, rating count, runtime and countries (real page: Hereditary)", () => {
  assert.deepEqual(F.parseFilmPage(fx("film-rated.html")), {
    title: "Hereditary", year: 2018, tmdbId: 493922, tmdbType: "movie", imdbId: "tt7784604",
    rating: 3.92, ratings: 2908207, runtime: 128, countries: ["USA", "UK"],
  });
});

test("film page: without the twitter tag the JSON-LD ratingValue is used; with neither, rating is null (never guessed)", () => {
  const noTag = fx("film-rated.html").replace(/<meta name="twitter:data2"[^>]*>/, "");
  assert.equal(F.parseFilmPage(noTag).rating, 3.92);
  const none = noTag.replace(/"aggregateRating":\{[^}]*\},?/, "");
  assert.equal(F.parseFilmPage(none).rating, null);
  assert.equal(F.parseFilmPage(none).ratings, null);
});

// ── live watchlist ───────────────────────────────────────────────────────────

const wlRoutes = (total, page2) => ({
  "/me/watchlist/": fx("watchlist-live-page.html").replace("564&nbsp;films", `${total}&nbsp;films`).replace("/mgusmao/watchlist/page/2/", "/me/watchlist/page/2/"),
  "/me/watchlist/page/2/": page2,
});

test("live watchlist: complete when the pages add up to the header total; every page is read", async () => {
  const http = fakeHttp(wlRoutes(5, fx("list-page-last.html")));
  const r = await L.readLiveWatchlist({ user: "me", http, csvCount: 5, sleepImpl: noSleep });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.items.length, 5);
  assert.equal(r.pages, 2);
  assert.equal(r.total, 5);
  assert.deepEqual(http.calls, ["https://letterboxd.com/me/watchlist/", "https://letterboxd.com/me/watchlist/page/2/"]);
});

test("live watchlist: not ok (so the CSV is used) when the page says more films than were read, when a page is refused, when it is empty", async () => {
  const short = await L.readLiveWatchlist({ user: "me", http: fakeHttp(wlRoutes(564, fx("list-page-last.html"))), sleepImpl: noSleep });
  assert.equal(short.ok, false);
  assert.match(short.reason, /read 5 films but the page says 564/);

  const blocked = await L.readLiveWatchlist({ user: "me", http: fakeHttp(wlRoutes(5, new F.BlockedError("x"))), sleepImpl: noSleep });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /read 1 page\(s\), then .*403/);

  const first = await L.readLiveWatchlist({ user: "me", http: fakeHttp({ "/me/watchlist/": new F.BlockedError("x") }), sleepImpl: noSleep });
  assert.equal(first.ok, false);
  assert.match(first.reason, /403/);

  const empty = await L.readLiveWatchlist({ user: "me", http: fakeHttp({ "/me/watchlist/": "<html><body>layout changed</body></html>" }), sleepImpl: noSleep });
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /no films found/);
});

test("live watchlist: with no total on the page there is nothing to check the read against, so it is not trusted (the CSV is used)", async () => {
  const noTotal = { "/me/watchlist/": fx("watchlist-page.html").replace("/friend-c/watchlist/page/2/", "/me/watchlist/page/2/"), "/me/watchlist/page/2/": fx("list-page-last.html") };
  const r = await L.readLiveWatchlist({ user: "me", http: fakeHttp(noTotal), sleepImpl: noSleep });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no total to check/);
  assert.equal(r.items.length, 5); // it read everything; it just cannot prove it
});

test("live watchlist: a read a hair short of the total (the page counts a film that is hidden from the grid) is accepted; a real gap is not", async () => {
  const within = await L.readLiveWatchlist({ user: "me", http: fakeHttp(wlRoutes(8, fx("list-page-last.html"))), sleepImpl: noSleep }); // 5 read, page says 8: 3 short
  assert.equal(within.ok, true, within.reason);
  const gap = await L.readLiveWatchlist({ user: "me", http: fakeHttp(wlRoutes(9, fx("list-page-last.html"))), sleepImpl: noSleep }); // 4 short
  assert.equal(gap.ok, false);
});

test("applyLiveWatchlist: the live list replaces the CSV's; dates survive; watched films stay off; counts say what changed", () => {
  const mk = (title, year, o = {}) => ({ key: `${title}|${year}`, title, year, liked: false, watched: false, watchlist: false, rewatches: 0, ...o });
  const films = new Map([
    ["stays|2000", mk("stays", 2000, { watchlist: true, watchlistedOn: "2024-01-05" })],
    ["gone|2001", mk("gone", 2001, { watchlist: true, watchlistedOn: "2023-02-02" })],
    ["seen|2002", mk("seen", 2002, { watched: true })],
  ]);
  const r = applyLiveWatchlist(films, [{ slug: "stays", title: "stays", year: 2000 }, { slug: "new", title: "new", year: 2020 }, { slug: "seen", title: "seen", year: 2002 }]);
  assert.deepEqual(r, { kept: 1, added: 1, removed: 1 });
  assert.equal(films.get("stays|2000").watchlist, true);
  assert.equal(films.get("stays|2000").watchlistedOn, "2024-01-05");
  assert.equal(films.get("gone|2001").watchlist, false);
  assert.equal(films.get("seen|2002").watchlist, false);
  assert.equal(films.get("new|2020").watchlist, true);
  assert.equal(films.get("new|2020").slug, "new");
});

// ── the people you follow, and the week ──────────────────────────────────────

const CFGF = { letterboxd: "me", friends: [{ user: "ana", name: "Ana" }, { user: "bia", name: "Bia" }, { user: "caio", name: "Caio" }], friendLists: [{ owner: "ana", slug: "best", name: "Best of Ana" }] };
const WCFG = { letterboxd: "me", friends: [{ user: "will", name: "William" }, { user: "gus", name: "Gustavo" }], weekRow: { days: 7, max: 3 } };

test("who the week row reads: the first `max` followed + the configured friends, a friend's configured name wins, nobody twice", () => {
  const cache = { following: { users: [["ana", "Ana A."], ["will", "Will Kim"], ["bia", "Bia"], ["caio", "Caio"], ["duda", "Duda"]] } };
  const r = L.choosePeople({ cfg: WCFG, cache });
  assert.deepEqual(r.people.map((p) => [p.user, p.name, p.configured]), [["ana", "Ana A.", false], ["will", "William", true], ["bia", "Bia", false], ["gus", "Gustavo", true]]);
  assert.equal(r.followed, 5);
  assert.equal(r.limited, true);
  assert.equal(L.choosePeople({ cfg: { ...WCFG, weekRow: { max: 60 } }, cache }).limited, false);
});

test("the 7-day rule: a film counts if its WATCHED date is from today−7 through today; the day before, tomorrow and undated entries do not", () => {
  const cache = { users: {
    ana: { rss: [["in-today", "t", 2000, 4, "2026-10-10"], ["in-edge", "t", 2000, 3, "2026-10-03"], ["out-old", "t", 2000, 5, "2026-10-02"], ["out-future", "t", 2000, 5, "2026-10-11"], ["out-undated", "t", 2000, 5, null]] },
  } };
  const wk = L.watchedThisWeek({ cache, people: [{ user: "ana", name: "Ana" }], today: "2026-10-10", days: 7 });
  assert.deepEqual([...wk.keys()].sort(), ["in-edge", "in-today"]);
  assert.equal(wk.get("in-today")[0].rating, 4);
  // a different window moves the edge
  assert.deepEqual([...L.watchedThisWeek({ cache, people: [{ user: "ana", name: "Ana" }], today: "2026-10-10", days: 8 }).keys()].sort(), ["in-edge", "in-today", "out-old"]);
});

test("the week: one entry per person per film (the newest), a rating from an older log fills a newest log that has none", () => {
  const cache = { users: {
    ana: { rss: [["x", "X", 2000, null, "2026-10-09"], ["x", "X", 2000, 4.5, "2026-10-05"], ["y", "Y", 2000, 2, "2026-10-04"], ["y", "Y", 2000, 5, "2026-10-08"]] },
    bia: { rss: [["x", "X", 2000, 3, "2026-10-08"]] },
  } };
  const wk = L.watchedThisWeek({ cache, people: [{ user: "ana", name: "Ana" }, { user: "bia", name: "Bia" }], today: "2026-10-10" });
  assert.deepEqual(wk.get("x").map((e) => [e.name, e.rating, e.watched]), [["Ana", 4.5, "2026-10-09"], ["Bia", 3, "2026-10-08"]]);
  assert.deepEqual(wk.get("y").map((e) => [e.name, e.rating, e.watched]), [["Ana", 5, "2026-10-08"]]);
});

test("readFollowing: page 1 of /following/ is read, page 2 refused is reported, each person's diary is read once and reused within 30 minutes; strangers keep 14 days", async () => {
  const cache = F.loadCache("/nonexistent");
  const NOW = Date.parse("2026-10-10T12:00:00Z");
  const rssFor = (user, d) => `<rss><channel><item><link>https://letterboxd.com/${user}/film/f-${d}/</link><letterboxd:watchedDate>${d}</letterboxd:watchedDate><letterboxd:filmTitle>F ${d}</letterboxd:filmTitle><letterboxd:filmYear>2000</letterboxd:filmYear><letterboxd:memberRating>4.0</letterboxd:memberRating></item></channel></rss>`;
  const http = fakeHttp({
    "/me/following/": fx("following-page.html").replace("/mgusmao/following/page/2/", "/me/following/page/2/"),
    "/me/following/page/2/": new F.BlockedError("x"),
    "/matheushector/rss/": rssFor("matheushector", "2026-10-09"),
    "/wimwenders/rss/": rssFor("wimwenders", "2026-09-01"), // older than 14 days: not kept
    "/friend-e/rss/": rssFor("friend-e", "2026-10-08"),
    "/will/rss/": rssFor("will", "2026-10-07"),
    "/gus/rss/": rssFor("gus", "2026-08-01"), // a configured friend keeps everything
  });
  const problems = [];
  const guarded = async (what, fn) => { try { return await fn(); } catch (e) { problems.push(`${what}: ${e.message}`); return null; } };
  const ctx = { cfg: { ...WCFG, weekRow: { days: 7, max: 60 } }, cache, http, guarded, problems, log: () => {}, now: NOW, force: false, pageGap: { gapMs: 0, sleepImpl: noSleep } };
  const r = await L.readFollowing(ctx);
  assert.equal(r.followed, 3);
  assert.equal(r.used, 5); // three followed + William and Gustavo
  assert.equal(r.rssRead, 5);
  assert.ok(problems.some((p) => /following: read 1 page\(s\) \(3 people\), the rest is unreachable/.test(p)), problems.join("|"));
  assert.deepEqual(cache.users.matheushector.rss.map((x) => x[0]), ["f-2026-10-09"]);
  assert.deepEqual(cache.users.wimwenders.rss, []); // stranger: 14-day trim
  assert.deepEqual(cache.users.gus.rss.map((x) => x[0]), ["f-2026-08-01"]); // configured: kept whole
  assert.equal(cache.users.matheushector.name, "Matheus Hector");
  assert.equal(cache.users.will.name, undefined); // configured names come from config, not overwritten

  http.calls.length = 0;
  const again = await L.readFollowing({ ...ctx, now: NOW + 10 * 60 * 1000 });
  assert.equal(again.rssRead, 0); // read 10 minutes ago
  assert.ok(!http.calls.some((u) => u.endsWith("/rss/")));
  const later = await L.readFollowing({ ...ctx, now: NOW + 40 * 60 * 1000 });
  assert.equal(later.rssRead, 5); // 40 minutes: read again
});

test("readFollowing: with a friends-month row on the Board the diary of a person he follows is kept 37 days (30 + a week); without one, 14; the row's own days decide", async () => {
  const NOW = Date.parse("2026-10-10T12:00:00Z");
  const item = (user, d) => `<item><link>https://letterboxd.com/${user}/film/f-${d}/</link><letterboxd:watchedDate>${d}</letterboxd:watchedDate><letterboxd:filmTitle>F ${d}</letterboxd:filmTitle><letterboxd:filmYear>2000</letterboxd:filmYear><letterboxd:memberRating>4.0</letterboxd:memberRating></item>`;
  // 2026-09-20 is 20 days before NOW, 2026-09-01 is 39 days before
  const feed = (user) => `<rss><channel>${item(user, "2026-10-09")}${item(user, "2026-09-20")}${item(user, "2026-09-01")}</channel></rss>`;
  const kept = async (extra) => {
    const cache = F.loadCache("/nonexistent");
    const http = fakeHttp({
      "/me/following/": fx("following-page.html").replace("/mgusmao/following/page/2/", "/me/following/page/2/"), "/me/following/page/2/": new F.BlockedError("x"),
      "/matheushector/rss/": feed("matheushector"), "/wimwenders/rss/": feed("wimwenders"), "/friend-e/rss/": feed("friend-e"), "/will/rss/": feed("will"), "/gus/rss/": feed("gus"),
    });
    const guarded = async (what, fn) => { try { return await fn(); } catch { return null; } };
    await L.readFollowing({ cfg: { ...WCFG, weekRow: { days: 7, max: 60 }, ...extra }, cache, http, guarded, problems: [], log: () => {}, now: NOW, force: false, pageGap: { gapMs: 0, sleepImpl: noSleep } });
    return cache.users.matheushector.rss.map((x) => x[4]);
  };
  const month = { board: { order: ["tonight", "friends-month"] } };
  assert.deepEqual(await kept({}), ["2026-10-09"], "no board: 14 days, as before");
  assert.deepEqual(await kept({ board: { order: ["tonight"] } }), ["2026-10-09"], "a board with no friends-month row: 14 days");
  assert.deepEqual(await kept(month), ["2026-10-09", "2026-09-20"], "a 30-day row keeps 37 days: 20 days old is kept, 39 is not");
  assert.deepEqual(await kept({ board: { order: ["tonight", "friends-month"], rows: [{ id: "friends-month", kind: "friends-month", days: 45 }] } }), ["2026-10-09", "2026-09-20", "2026-09-01"], "the row's own days decide: 45 + 7");
  assert.equal(require("../lib/special-rows").retentionDays(month), 37);
  assert.equal(require("../lib/special-rows").retentionDays({}), 0);
});

test("a 403 three times in a row stops all asking for the rest of the run (a challenge is not hammered); a success in between resets it", async () => {
  let n = 0;
  const statuses = { "/a": 403, "/b": 403, "/c": 403, "/d": 200 };
  const http = F.makeHttp({
    fetchImpl: async (url) => { n++; const s = statuses[new URL(url).pathname]; return { status: s, ok: s === 200, headers: { get: () => null }, text: async () => "ok", url }; },
    sleepImpl: noSleep,
  });
  for (const p of ["/a", "/b", "/c"]) await assert.rejects(http.get("https://letterboxd.com" + p), F.BlockedError);
  const before = n;
  await assert.rejects(http.get("https://letterboxd.com/d"), F.BlockedError); // would have been 200, but nobody asks any more
  assert.equal(n, before);

  const ok = F.makeHttp({
    fetchImpl: async (url) => { const s = new URL(url).pathname === "/ok" ? 200 : 403; return { status: s, ok: s === 200, headers: { get: () => null }, text: async () => "ok", url }; },
    sleepImpl: noSleep,
  });
  await assert.rejects(ok.get("https://letterboxd.com/x"), F.BlockedError);
  await assert.rejects(ok.get("https://letterboxd.com/y"), F.BlockedError);
  assert.equal((await ok.get("https://letterboxd.com/ok")).text, "ok"); // resets the streak
  await assert.rejects(ok.get("https://letterboxd.com/z"), F.BlockedError);
  assert.equal((await ok.get("https://letterboxd.com/ok")).text, "ok"); // still asking
});

// ── the curated lists: reading and caching ───────────────────────────────────

const LCFG = { lists: [
  { id: "aaa", name: "A list", url: "https://letterboxd.com/u/list/a/" },
  { id: "bbb", name: "B list" }, // no url: resolved from boxd.it
  { id: "pop", name: "Popular", url: "https://letterboxd.com/films/popular/this/week/", popular: true },
] };
const listRoutes = () => ({
  "/u/list/a/": fx("list-page-last.html"),
  "/v/list/b/": fx("list-page-last.html"),
  "/films/popular/this/week/": fx("popular-page.html").replace("/films/popular/this/week/page/2/", "/nowhere/"),
});

test("lists: read once, resolved from boxd.it only when the config has no url, and the cache is reused until it is 7 days old (Popular: 1 day)", async () => {
  const file = path.join(tmp(), "lists.json");
  const NOW = Date.parse("2026-10-10T12:00:00Z");
  const resolved = [];
  const resolve = async (id) => { resolved.push(id); return "https://letterboxd.com/v/list/b/"; };
  const http = fakeHttp(listRoutes());
  const r1 = await L.refreshLists({ cfg: LCFG, file, http, now: NOW, sleepImpl: noSleep, resolve });
  assert.deepEqual(resolved, ["bbb"]);
  assert.deepEqual(r1.lists.map((l) => [l.id, l.items.length]), [["aaa", 2], ["bbb", 2], ["pop", 3]]);
  assert.equal(r1.problems.length, 0, r1.problems.join("|"));

  http.calls.length = 0;
  await L.refreshLists({ cfg: LCFG, file, http, now: NOW + 3 * 864e5, sleepImpl: noSleep, resolve });
  assert.deepEqual(http.calls.map((u) => new URL(u).pathname), ["/films/popular/this/week/"]); // 3 days: only Popular is old
  assert.deepEqual(resolved, ["bbb"]); // the resolved address was cached

  http.calls.length = 0;
  await L.refreshLists({ cfg: LCFG, file, http, now: NOW + 8 * 864e5, sleepImpl: noSleep, resolve });
  assert.equal(http.calls.length, 3); // 8 days: all three
  rm(path.dirname(file));
});

test("lists: a list that cannot be read keeps yesterday's cache and is named; a missing list is 'gone or private'; --cache-only asks nobody and writes nothing", async () => {
  const dir = tmp(), file = path.join(dir, "lists.json");
  const NOW = Date.parse("2026-10-10T12:00:00Z");
  const cfg = { lists: [{ id: "aaa", name: "A list", url: "https://letterboxd.com/u/list/a/" }, { id: "zzz", name: "Z list", url: "https://letterboxd.com/u/list/z/" }] };
  await L.refreshLists({ cfg, file, http: fakeHttp({ "/u/list/a/": fx("list-page-last.html") }), now: NOW, sleepImpl: noSleep });
  const r = await L.refreshLists({ cfg, file, http: fakeHttp({ "/u/list/a/": new F.BlockedError("x") }), now: NOW + 9 * 864e5, sleepImpl: noSleep });
  assert.equal(r.lists[0].items.length, 2, "kept the old items");
  assert.ok(r.problems.some((p) => /list aaa .*403/.test(p)));
  assert.ok(r.problems.some((p) => /list zzz .*gone or private/.test(p)));
  assert.equal(r.lists[1].items.length, 0);

  const before = fs.readFileSync(file, "utf8");
  const http = fakeHttp({});
  const c = await L.refreshLists({ cfg, file, http, cacheOnly: true, now: NOW + 99 * 864e5, sleepImpl: noSleep });
  assert.equal(http.calls.length, 0);
  assert.equal(c.lists[0].items.length, 2);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  rm(dir);
});

// ── film lookups: the second reading of old records ──────────────────────────

const filmHtml = (title, year, tmdb, imdb, extra = "") =>
  `<html><head><meta property="og:title" content="${title} (${year})">${extra}</head><body data-tmdb-type="movie" data-tmdb-id="${tmdb}"><h1 class="headline-1 primaryname"><span class="name">${title}</span></h1><span class="releasedate"><a href="/films/year/${year}/">${year}</a></span><p class="text-link text-footer"> 91&nbsp;mins &nbsp; More at ${imdb ? `<a href="http://www.imdb.com/title/${imdb}/maindetails">IMDb</a>` : ""}</p><a href="/films/country/france/" class="text-slug"> France </a></body></html>`;
const RATED = '<meta name="twitter:data2" content="4.10 out of 5">';

test("resolveFilms: new films first, then old records are read again for rating/runtime/countries, at most enrichMax of them; a v2 record is never read again", async () => {
  const cache = F.loadCache("/nonexistent");
  cache.films.old1 = { title: "Old1", year: 1990, tmdbId: 1, imdbId: "tt0000001", t: 1 }; // before v2
  cache.films.old2 = { title: "Old2", year: 1991, tmdbId: 2, imdbId: "tt0000002", t: 1 };
  cache.films.old3 = { title: "Old3", year: 1992, tmdbId: 3, imdbId: "tt0000003", t: 1 };
  cache.films.fresh = { title: "Fresh", year: 1993, tmdbId: 4, imdbId: "tt0000004", t: 1, v: 2, r: 3.3 };
  cache.films.dead = { title: null, year: null, tmdbId: null, imdbId: null, gone: true, t: 1 };
  const http = fakeHttp({
    "/film/new/": filmHtml("New", 2020, 9, "tt0000009", RATED),
    "/film/old1/": filmHtml("Old1", 1990, 1, "tt0000001", RATED),
    "/film/old2/": filmHtml("Old2", 1991, 2, "tt0000002"),
    "/film/old3/": filmHtml("Old3", 1992, 3, "tt0000003"),
  });
  const r = await F.resolveFilms({ slugs: ["new", "fresh"], enrich: ["fresh", "dead", "old1", "old2", "old3", "old1"], enrichMax: 2, cache, http, sleepImpl: noSleep });
  assert.deepEqual(http.calls.map((u) => u.split("/film/")[1]), ["new/", "old1/", "old2/"]);
  assert.equal(r.enriched, 2);
  assert.equal(r.enrichWanted, 3); // old1, old2, old3 qualify; fresh and dead do not
  assert.equal(r.withImdb, 1);
  assert.deepEqual(cache.films.new, { title: "New", year: 2020, tmdbId: 9, imdbId: "tt0000009", r: 4.1, rt: 91, c: ["France"], t: cache.films.new.t, v: 2 });
  assert.equal(cache.films.old1.r, 4.1);
  assert.equal(cache.films.old1.rt, 91);
  assert.deepEqual(cache.films.old1.c, ["France"]);
  assert.equal(cache.films.old2.r, undefined); // the page has no rating: none is invented...
  assert.equal(cache.films.old2.v, 2); // ...and the record is not asked again tomorrow
  assert.equal(cache.films.old3.v, undefined);
  assert.equal(F.needsEnrich(cache.films.fresh), false);
  assert.equal(F.needsEnrich(cache.films.dead), false);
  assert.equal(F.needsEnrich(cache.films.old3), true);
});

test("resolveFilms: --lookup-limit counts every page, new or read again; a read-again that loses the IMDb link keeps the id it had", async () => {
  const cache = F.loadCache("/nonexistent");
  cache.films.old = { title: "Old", year: 1990, tmdbId: 1, imdbId: "tt0000001", t: 1 };
  const http = fakeHttp({ "/film/new1/": filmHtml("N1", 2020, 5, "tt0000005"), "/film/new2/": filmHtml("N2", 2021, 6, "tt0000006"), "/film/old/": filmHtml("Old", 1990, 1, null) });
  const r = await F.resolveFilms({ slugs: ["new1", "new2"], enrich: ["old"], limit: 2, cache, http, sleepImpl: noSleep });
  assert.equal(http.calls.length, 2);
  assert.equal(r.enriched, 0);
  const r2 = await F.resolveFilms({ slugs: [], enrich: ["old"], cache, http, sleepImpl: noSleep });
  assert.equal(r2.enriched, 1);
  assert.equal(cache.films.old.imdbId, "tt0000001");
  assert.equal(cache.films.old.v, 2);
});

test("refreshFriends: the `extra` hook can put films first and last, and say which old records to read again", async () => {
  const dir = tmp(), file = path.join(dir, "friends.json");
  const http = fakeHttp({ "/film/z/": filmHtml("Z", 2000, 1, "tt0000001"), "/film/y/": filmHtml("Y", 2001, 2, "tt0000002"), "/film/mid/": filmHtml("Mid", 2002, 3, "tt0000003") });
  let seen;
  const r = await F.refreshFriends({
    cfg: { friends: [], friendLists: [] }, file, http, sleepImpl: noSleep, log: () => {},
    extra: async (ctx) => { seen = Object.keys(ctx).sort(); return { first: ["z"], last: ["y"], enrich: [] }; },
  });
  assert.deepEqual(http.calls.map((u) => u.split("/film/")[1]), ["z/", "y/"]);
  assert.equal(r.resolved.withImdb, 2);
  assert.ok(["cache", "http", "guarded", "problems", "log", "now", "force", "old", "pageGap", "save"].every((k) => seen.includes(k)));
  rm(dir);
});

// ── the pool and the rows cut from it ────────────────────────────────────────

const film = (tt, title, year, o = {}) => ({ title, year, tmdbId: null, imdbId: tt, t: 1, v: 2, ...o });
const POOLVIEW = { films: {
  a: film("tt0000001", "Alpha", 1999, { r: 4.3, rt: 88, c: ["USA"] }),
  b: film("tt0000002", "Bravo", 2025, { r: 3.9, rt: 120, c: ["France"] }),
  c: film("tt0000003", "Charlie", 1975, { tmdbId: 33 }), // nothing from Letterboxd; TMDB knows it
  d: film("tt0000004", "Delta", 1962, { r: 4.0, rt: 95, c: ["Japan"] }),
  e: film("tt0000005", "Echo", 2026, { r: 3.5, rt: 30, c: ["UK"] }), // a short
  f: film("tt0000006", "Foxtrot", 1930, { r: 4.5 }), // no runtime, no country
  g: film("tt0000007", "Golf", 2010, {}), // nothing at all
  seen: film("tt0000008", "Seen", 2000, { r: 5 }),
  noimdb: film(null, "No IMDb", 2001, {}),
  gone: { gone: true, imdbId: null },
  dup: film("tt0000001", "Alpha (alt)", 1999, { r: 4.3, rt: 88, c: ["USA"] }), // same IMDb id as a
} };
const TMDB = {
  33: { id: 33, title: "Charlie", year: 1975, runtime: 150, countries: ["JP", "HK"], va: 8.0, vc: 5000, genres: ["Drama"], directors: [{ id: 1, name: "D" }], overview: "O" },
  34: { id: 34, title: "tmdbonly", year: 2000, runtime: 100, countries: ["FR"], va: 8.0, vc: 900, genres: [], directors: [], overview: "" },
};
const tag = (type, x = {}) => ({ type, ...x });
const poolOf = (entries, extra = []) => P.buildPool({ entries, extra, view: POOLVIEW, isSeen: (r) => r.slug === "seen", detail: (r) => (r.tmdbId ? TMDB[r.tmdbId] || null : null) });

test("pool: one film per IMDb id with every tag it earned; seen, no-IMDb, gone and not-yet-looked-up films are counted and left out", () => {
  const { pool, stats } = poolOf([
    { slug: "a", tag: tag("watchlist") }, { slug: "a", tag: tag("list", { id: "L1", name: "First", pos: 3 }) }, { slug: "dup", tag: tag("list", { id: "L2", name: "Second", pos: 7 }) },
    { slug: "b", tag: tag("fwatch", { name: "Ana" }) }, { slug: "b", tag: tag("ftop", { name: "Bia", rating: 5 }) },
    { slug: "seen", tag: tag("watchlist") }, { slug: "noimdb", tag: tag("watchlist") }, { slug: "gone", tag: tag("watchlist") }, { slug: "never-looked-up", tag: tag("watchlist") },
  ]);
  assert.deepEqual([...pool.keys()], ["tt0000001", "tt0000002"]);
  const a = pool.get("tt0000001");
  assert.equal(a.tags.watchlist, true);
  assert.deepEqual([...a.tags.lists.keys()], ["L1", "L2"]); // the alternate slug with the same tt is the same film
  assert.deepEqual(pool.get("tt0000002").tags.friendsWatch.get("Ana"), true);
  assert.equal(pool.get("tt0000002").tags.friendsTop.get("Bia"), 5);
  assert.deepEqual(stats, { entries: 9, pending: 1, gone: 1, noImdb: 1, seen: 1 });
});

test("pool: films known only to TMDB (the CSV fallback has no Letterboxd slug) join the same pool by IMDb id", () => {
  const { pool } = poolOf([{ slug: "a", tag: tag("watchlist") }], [{ tt: "tt0000001", tmdb: 1, detail: TMDB[33], title: "Alpha", year: 1999, tag: tag("list", { id: "L", name: "L", pos: 1 }) }, { tt: "tt0000099", tmdb: 99, detail: null, title: "Only TMDB", year: 2000, tag: tag("watchlist") }]);
  assert.deepEqual([...pool.keys()].sort(), ["tt0000001", "tt0000099"]);
  assert.equal(pool.get("tt0000001").tags.watchlist && pool.get("tt0000001").tags.lists.size, 1);
});

test("rank: taste unknown is neutral (0), quality unknown sorts below the average film; a film with a known rating goes before a film nobody has rated", () => {
  const view = { films: { good: film("tt0000081", "Good", 2000, { r: 4.5, rt: 90 }), mid: film("tt0000082", "Mid", 2000, { r: 4.0, rt: 90 }), low: film("tt0000084", "Low", 2000, { r: 3.5, rt: 90 }), blank: film("tt0000083", "Blank", 2000, { rt: 90 }) } };
  const { pool } = P.buildPool({ entries: ["good", "mid", "low", "blank"].map((slug) => ({ slug, tag: tag("watchlist") })), view, isSeen: () => false });
  const recs = P.rankPool(pool, { stats: new Map() });
  const by = Object.fromEntries(recs.map((r) => [r.title, r]));
  assert.equal(by.Blank.tasteZ, 0);
  assert.equal(by.Blank.qualityZ, -1);
  assert.ok(Math.abs(by.Mid.qualityZ) < 1e-9); // the average film
  assert.ok(by.Good.rank > by.Mid.rank && by.Mid.rank > by.Blank.rank);
  assert.deepEqual(P.shortRow(recs, { size: 4 }).map((i) => i.title), ["Good", "Mid", "Blank", "Low"]); // Blank (−1) is still above a film rated far below average (−1.22)
});

test("facts of a pool film: TMDB first, the Letterboxd page when TMDB has nothing, nothing when neither knows (never a guess)", () => {
  const { pool } = poolOf([{ slug: "a", tag: tag("watchlist") }, { slug: "c", tag: tag("watchlist") }, { slug: "g", tag: tag("watchlist") }]);
  const [a, c, g] = ["tt0000001", "tt0000003", "tt0000007"].map((k) => pool.get(k));
  assert.equal(P.runtimeOf(a), 88);
  assert.equal(P.runtimeOf(c), 150); // TMDB
  assert.equal(P.runtimeOf(g), null);
  assert.deepEqual(P.countriesOf(a), ["United States"]);
  assert.deepEqual(P.countriesOf(c), ["Japan", "Hong Kong"]);
  assert.deepEqual(P.countriesOf(g), []);
  assert.deepEqual(P.ratingOf(a), { value: 4.3, origin: "Letterboxd" });
  assert.deepEqual(P.ratingOf(c), { value: 4, origin: "TMDB", raw: 8 }); // 8.0 ÷ 2
  assert.equal(P.ratingOf(g), null);
  assert.equal(P.decadeOf(c), "1970s");
});

test("country names: codes and Letterboxd's spellings land on one name each", () => {
  assert.equal(P.countryLabel("US"), "United States");
  assert.equal(P.countryLabel("GB"), "United Kingdom");
  assert.equal(P.countryLabel("HK"), "Hong Kong");
  assert.equal(P.countryLabel("TW"), "Taiwan");
  assert.equal(P.countryLabel("FR"), "France");
  assert.equal(P.countryLabel("USA"), "United States");
  assert.equal(P.countryLabel("UK"), "United Kingdom");
  assert.equal(P.countryLabel("South Korea"), "South Korea");
  assert.equal(P.countryLabel(""), null);
});

// rank = taste + 0.7 × quality, with taste unknown = 0 and quality unknown = −1
function rankedPool(entries) {
  const { pool } = poolOf(entries);
  const model = { stats: new Map(), mean: 3.5, count: 0 };
  return P.rankPool(pool, model);
}

test("From your lists: only films in a list; a film in more lists outranks an equal one in fewer; why = the list's name, or 'in N of your lists'", () => {
  const recs = rankedPool([
    { slug: "a", tag: tag("list", { id: "L1", name: "Cannes", pos: 1 }) }, { slug: "a", tag: tag("list", { id: "L2", name: "Criterion", pos: 5 }) }, { slug: "a", tag: tag("list", { id: "L3", name: "Third", pos: 9 }) },
    { slug: "d", tag: tag("list", { id: "L1", name: "Cannes", pos: 2 }) },
    { slug: "b", tag: tag("watchlist") }, // not in any list
  ]);
  const row = P.fromListsRow(recs, 30);
  assert.deepEqual(row.map((i) => i.title), ["Alpha", "Delta"]);
  assert.equal(row[0].why[0], "in 3 of your lists");
  assert.equal(row[1].why[0], "in “Cannes”");
  assert.ok(row.every((i) => /^tt\d+$/.test(i.id)));
  assert.equal(P.fromListsRow(recs, 1).length, 1); // the size is respected

  // same quality, same taste (none): only the number of lists tells them apart
  const twin = (tt, title) => film(tt, title, 2000, { r: 4, rt: 100 });
  const view = { films: { one: twin("tt0000071", "In one list"), two: twin("tt0000072", "In two lists"), four: twin("tt0000073", "In four lists") } };
  const entries = [["one", "L1"], ["two", "L1"], ["two", "L2"], ["four", "L1"], ["four", "L2"], ["four", "L3"], ["four", "L4"]].map(([slug, id]) => ({ slug, tag: tag("list", { id, name: id, pos: 1 }) }));
  const { pool } = P.buildPool({ entries, view, isSeen: () => false });
  assert.deepEqual(P.fromListsRow(P.rankPool(pool, { stats: new Map() }), 30).map((i) => i.title), ["In four lists", "In two lists", "In one list"]);
});

test("Short and good: 95 minutes or less, never a short under 40, never a film whose runtime nobody knows; best first", () => {
  const recs = rankedPool(["a", "b", "c", "d", "e", "f", "g"].map((slug) => ({ slug, tag: tag("watchlist") })));
  const row = P.shortRow(recs, { max: 95, min: 40, size: 30 });
  assert.deepEqual(row.map((i) => i.title), ["Alpha", "Delta"]); // 88 and 95 (the edge counts); Bravo 120, Charlie 150, Echo 30 (a short), Foxtrot/Golf unknown
  assert.equal(row[0].why[0], "on your watchlist"); // the runtime and the Letterboxd average are in the numbers line and Stremio's own fields, not in the reasons
  assert.equal(P.shortRow(recs, { max: 94, min: 40, size: 30 }).length, 1);
  assert.equal(P.shortRow(recs, { max: 95, min: 40, size: 1 }).length, 1);
});

test("New for you: films from the last two years, plus everything on Popular this week whatever its year", () => {
  const recs = rankedPool([
    { slug: "b", tag: tag("watchlist") }, // 2025
    { slug: "e", tag: tag("watchlist") }, // 2026
    { slug: "a", tag: tag("watchlist") }, // 1999: not new
    { slug: "d", tag: tag("list", { id: "pop", name: "Popular", pos: 4, popular: true }) }, // 1962 but popular this week
  ]);
  const row = P.newRow(recs, { fromYear: 2025, size: 30 });
  assert.deepEqual(row.map((i) => i.title).sort(), ["Bravo", "Delta", "Echo"]);
  assert.equal(row.find((i) => i.title === "Delta").why[0], "popular on Letterboxd this week");
});

test("cuts by runtime: Under 90 · 90–120 · 120–150 · Over 150, the edges go where the labels say, shorts and unknowns are counted out", () => {
  const films = {};
  const rts = { m89: 89, m90: 90, m120: 120, m121: 121, m150: 150, m151: 151, m39: 39, m40: 40, none: null };
  let i = 1;
  for (const [k, rt] of Object.entries(rts)) films[k] = film("tt01" + String(i++).padStart(5, "0"), k, 2000, rt ? { rt, r: 4 } : { r: 4 });
  const view = { films };
  const { pool } = P.buildPool({ entries: Object.keys(films).map((slug) => ({ slug, tag: tag("watchlist") })), view, isSeen: () => false });
  const cut = P.cuts(P.rankPool(pool, { stats: new Map() }), { size: 60, today: "2026-10-10" });
  const by = Object.fromEntries(cut.runtime.map((b) => [b.label, b.items.map((x) => x.title).sort()]));
  assert.deepEqual(by["Under 90 min"], ["m40", "m89"]);
  assert.deepEqual(by["90–120 min"], ["m120", "m90"]);
  assert.deepEqual(by["120–150 min"], ["m121", "m150"]);
  assert.deepEqual(by["Over 150 min"], ["m151"]);
  assert.equal(cut.missing.shortFilms, 1); // m39
  assert.equal(cut.missing.runtime, 1); // none
});

test("cuts by rating: 4.2+ · 4.0–4.2 · 3.8–4.0 · Under 3.8 on the Letterboxd average; TMDB's vote ÷ 2 only when Letterboxd has none, and the why says so", () => {
  const films = {};
  const rs = { r43: 4.3, r42: 4.2, r419: 4.19, r40: 4.0, r39: 3.99, r38: 3.8, r379: 3.79 };
  let i = 1;
  for (const [k, r] of Object.entries(rs)) films[k] = film("tt02" + String(i++).padStart(5, "0"), k, 2000, { r, rt: 100 });
  films.tmdbonly = film("tt0299999", "tmdbonly", 2000, { tmdbId: 34 }); // TMDB 8.0 → 4.0★
  films.none = film("tt0299998", "none", 2000, {});
  const { pool } = P.buildPool({ entries: Object.keys(films).map((slug) => ({ slug, tag: tag("watchlist") })), view: { films }, isSeen: () => false, detail: (r) => (r.tmdbId ? TMDB[r.tmdbId] : null) });
  const cut = P.cuts(P.rankPool(pool, { stats: new Map(), mean: 3.5 }), { size: 60, today: "2026-10-10" });
  const by = Object.fromEntries(cut.rating.map((b) => [b.label, b.items.map((x) => x.title).sort()]));
  assert.deepEqual(by["4.2+"], ["r42", "r43"]);
  assert.deepEqual(by["4.0–4.2"], ["r40", "r419", "tmdbonly"]);
  assert.deepEqual(by["3.8–4.0"], ["r38", "r39"]);
  assert.deepEqual(by["Under 3.8"], ["r379"]);
  assert.equal(cut.missing.rating, 1);
  const t = cut.rating.find((b) => b.label === "4.0–4.2").items.find((x) => x.title === "tmdbonly");
  assert.match(t.why[0], /^TMDB 8\.0\/10 \(≈ 4\.00★\), no Letterboxd average/);
  // a Letterboxd average needs no note in the reasons: the numbers line shows it (test/describe.test.js: two decimals in "By rating", so 4.19 never reads 4.2)
  assert.ok(cut.rating.find((b) => b.label === "4.2+").items.every((x) => !/Letterboxd|TMDB/.test(x.why.join(" "))));
});

test("cuts by decade and country: decades 1920s to the current one; the 12 most frequent countries, a co-production counted in each", () => {
  const films = {};
  const mk = (slug, year, c) => (films[slug] = film("tt03" + String(Object.keys(films).length + 1).padStart(5, "0"), slug, year, { r: 4, rt: 100, c }));
  mk("y1919", 1919, ["USA"]); mk("y1920", 1920, ["USA"]); mk("y1999", 1999, ["USA", "France"]); mk("y2029", 2029, ["USA"]); mk("y2026", 2026, ["USA"]); mk("noyear", null, ["USA"]);
  for (let i = 0; i < 14; i++) mk("x" + i, 2000, ["Country " + String.fromCharCode(65 + i)]); // 14 one-film countries
  const { pool } = P.buildPool({ entries: Object.keys(films).map((slug) => ({ slug, tag: tag("watchlist") })), view: { films }, isSeen: () => false });
  const cut = P.cuts(P.rankPool(pool, { stats: new Map() }), { size: 60, countries: 12, today: "2026-10-10" });
  const labels = cut.decade.map((d) => d.label);
  assert.equal(labels[0], "1920s");
  assert.equal(labels.at(-1), "2020s");
  assert.ok(!labels.includes("1910s") && !labels.includes("2030s"));
  assert.equal(cut.missing.decade, 1); // noyear
  assert.equal(cut.country.length, 12);
  assert.equal(cut.country[0].label, "United States");
  assert.equal(cut.country[0].count, 6); // all six, even the one with no year: the year does not matter to the country cut
  assert.equal(cut.country[1].label, "Country A"); // ties: alphabetical, and France (1) is among the ones that fit or not by name
  assert.equal(P.decadeLabels("2026-10-10").join(","), "1920s,1930s,1940s,1950s,1960s,1970s,1980s,1990s,2000s,2010s,2020s");
});

test("cuts: each option holds at most `size` films, best first by taste + quality", () => {
  const films = {};
  for (let i = 0; i < 10; i++) films["f" + i] = film("tt04" + String(i).padStart(5, "0"), "F" + i, 1990, { r: 3 + i / 10, rt: 100, c: ["Italy"] });
  const { pool } = P.buildPool({ entries: Object.keys(films).map((slug) => ({ slug, tag: tag("watchlist") })), view: { films }, isSeen: () => false });
  const cut = P.cuts(P.rankPool(pool, { stats: new Map() }), { size: 4, today: "2026-10-10" });
  const it = cut.decade.find((d) => d.label === "1990s");
  assert.equal(it.count, 10);
  assert.deepEqual(it.items.map((x) => x.title), ["F9", "F8", "F7", "F6"]);
});

// ── 👥 Friends watched this week ─────────────────────────────────────────────

test("Friends watched this week: ordered by people × rating, 'William 4★ · Gustavo 4.5★' with the best rating first, seen films out, unrated logs counted but never shown a rating", () => {
  const view = { films: {
    one: film("tt0000011", "One", 2026, {}), two: film("tt0000012", "Two", 2026, {}), three: film("tt0000013", "Three", 2026, {}),
    seen: film("tt0000014", "Seen", 2026, {}), noimdb: film(null, "NoImdb", 2026, {}), later: film("tt0000015", "Later", 2026, {}),
  } };
  const wk = new Map([
    ["one", [{ name: "William", rating: 4, watched: "2026-10-09" }, { name: "Gustavo", rating: 4.5, watched: "2026-10-08" }]], // 2 × 4.25 = 8.5
    ["two", [{ name: "Ana", rating: 5, watched: "2026-10-09" }]], // 1 × 5
    ["three", [{ name: "Bia", rating: null, watched: "2026-10-09" }, { name: "Caio", rating: null, watched: "2026-10-09" }]], // 2 × 3 (neutral for the ordering) = 6
    ["seen", [{ name: "Ana", rating: 5, watched: "2026-10-09" }]],
    ["noimdb", [{ name: "Ana", rating: 5, watched: "2026-10-09" }]],
    ["later", [{ name: "Ana", rating: 5, watched: "2026-10-01" }]], // ties with "two": the newer log wins
    ["never-looked-up", [{ name: "Ana", rating: 5, watched: "2026-10-09" }]],
  ]);
  const { items, stats } = P.weekRow({ week: wk, view, isSeen: (r) => r.slug === "seen", size: 30 });
  assert.deepEqual(items.map((i) => i.title), ["One", "Three", "Two", "Later"]);
  assert.equal(items[0].why[0], "watched this week by Gustavo 4.5★ · William 4★");
  assert.equal(items[1].why[0], "watched this week by Bia · Caio"); // nobody rated it: no stars shown
  assert.deepEqual(stats, { films: 7, pending: 1, gone: 0, noImdb: 1, seen: 1 });
  assert.equal(P.weekRow({ week: wk, view, isSeen: () => false, size: 2 }).items.length, 2);
});

// ── curated list catalogs ────────────────────────────────────────────────────

test("Lists: the whole list in the curator's order (seen films included); Lists (unseen) the same minus what you have seen, with the curator's own '#N'", () => {
  const films = {};
  const items = [];
  films.nottt = film(null, "No tt", 2000, {}); items.push({ slug: "nottt", title: "No tt", year: 2000 }); // place 1: no IMDb id, but it still counts as a place
  for (let i = 1; i <= 6; i++) { films["s" + i] = film("tt05" + String(i).padStart(5, "0"), "S" + i, 2000, {}); items.push({ slug: "s" + i, title: "S" + i, year: 2000 }); }
  films.dupe = film("tt0500001", "S1 again", 2000, {}); items.push({ slug: "dupe", title: "S1", year: 2000 }); // place 8: same IMDb id as s1
  items.push({ slug: "pending", title: "P", year: 2000 }); // place 9: not looked up yet
  const cats = P.listCatalogs({ lists: [{ id: "L", name: "My list", items }, { id: "pop", name: "Popular", popular: true, items: items.slice(1, 3) }], view: { films }, isSeen: (r) => ["s2", "s4"].includes(r.slug), size: 5 });
  const [l, pop] = cats;
  assert.deepEqual(l.all.map((x) => x.title), ["S1", "S2", "S3", "S4", "S5"]); // order kept, capped at size
  assert.deepEqual(l.unseen.map((x) => x.title), ["S1", "S3", "S5", "S6"]); // S2 and S4 are seen
  assert.equal(l.unseen.find((x) => x.title === "S3").why[0], "#4 in “My list”"); // the curator's place (the no-IMDb film held place 1), not its place in this file
  assert.equal(l.all[0].why[0], "#2 in “My list”");
  assert.deepEqual(l.stats, { read: 9, withTt: 6, noImdb: 1, pending: 1, gone: 0, seen: 2, dup: 1 });
  assert.equal(pop.all[0].why[0], "#1 on Letterboxd this week");
});

test("Lists: up to 300 films by default, as many as the list has below that", () => {
  const films = {}, items = [];
  for (let i = 0; i < 320; i++) { films["q" + i] = film("tt06" + String(i).padStart(5, "0"), "Q" + i, 2000, {}); items.push({ slug: "q" + i, title: "Q" + i, year: 2000 }); }
  const [c] = P.listCatalogs({ lists: [{ id: "L", name: "Big", items }], view: { films }, isSeen: () => false });
  assert.equal(c.all.length, 300);
  assert.equal(c.unseen.length, 300);
  assert.equal(c.all[299].title, "Q299");
});

// ── the plan: Board order, Discover catalogs, guard, files ───────────────────

const MOODS = [{ id: "lift", name: "☀️ Lift me out", word: "Uplift" }, { id: "escape", name: "🎳 Full escape", word: "Escape" }];
const items = (n, p = "tt07") => Array.from({ length: n }, (_, i) => ({ id: p + String(i).padStart(5, "0"), tmdb: null, slug: null, title: "T" + i, year: 2000, why: ["x"], genres: [] }));
const basePlan = (o = {}) => buildPlan({
  moods: MOODS,
  rows: { tonight: items(2), because: items(2), lift: items(3), escape: items(4), directors: items(1), oldfriends: items(1), watchlist: items(2) },
  extra: { fromlists: items(2), short: items(2), newforyou: items(2), "friends-week": items(1) },
  friendOut: { rows: { "friends-love": items(40), "friends-top-ana": items(3), "friends-session-ana": items(2), "friends-list-ana-best": items(4) }, meta: [
    { id: "friends-love", name: "👥 Friends loved, you haven't seen", word: "Loved", kind: "love" },
    { id: "friends-top-ana", name: "⭐ Ana's top picks", word: "Top · Ana", kind: "top" },
    { id: "friends-session-ana", name: "🎟️ Watch together with Ana", word: "Watch together · Ana", kind: "session" },
    { id: "friends-list-ana-best", name: "📂 Best (Ana)", word: "Best (Ana)", kind: "list" },
  ] },
  lists: [{ id: "L1", name: "Cannes Winners (moviewithus)", all: items(5), unseen: items(3) }, { id: "L2", name: "Empty one", all: [], unseen: [] }],
  cuts: { decade: [{ label: "1990s", items: items(2) }], runtime: [{ label: "Under 90 min", items: items(2) }], country: [{ label: "France", items: items(2) }], rating: [{ label: "4.2+", items: items(2) }], missing: {} },
  today: "2026-10-10", sizes: { row: 30, friends: 30 }, ...o,
});

test("plan: the Board is exactly the agreed order — 19 rows, the 8 moods between 'Because you loved…' and 'New for you', Loved by your directors after Directors you trust", () => {
  const eight = ["a", "b", "c", "d", "e", "f", "g", "h"].map((k) => ({ id: "m" + k, name: "Mood " + k, word: "W" + k }));
  const plan = basePlan({ moods: eight, rows: { tonight: [], because: [], directors: [], oldfriends: [], watchlist: [] } });
  assert.deepEqual(plan.board.map((r) => r.id), ["tonight", "watchlist", "fromlists", "friends-love", "friends-week", "short", "because", "ma", "mb", "mc", "md", "me", "mf", "mg", "mh", "newforyou", "directors", "directors-loved", "oldfriends"]);
  const names = Object.fromEntries(plan.board.map((r) => [r.id, r.name]));
  assert.equal(names.tonight, "🎯 Tonight");
  assert.equal(names.watchlist, "📋 Your watchlist, best first");
  assert.equal(names.fromlists, "🎞️ From your lists");
  assert.equal(names["friends-love"], "👥 Friends loved, you haven't seen");
  assert.equal(names["friends-week"], "👥 Friends watched this week");
  assert.equal(names.short, "⏱️ Short and good");
  assert.equal(names.because, "💛 Because you loved…");
  assert.equal(names.ma, "Mood a");
  assert.equal(names.newforyou, "🆕 New for you");
  assert.equal(names.directors, "🎬 Directors you trust");
  assert.equal(names.oldfriends, "📼 Old friends");
});

test("plan: Discover has the eight catalogs in order, each with ONE required `genre` extra and no skip; Friends holds everything but 'Friends loved'", () => {
  const plan = basePlan();
  assert.deepEqual(plan.discover.map((c) => c.id), ["mood-engine", "mood-engine-lists", "mood-engine-lists-unseen", "mood-engine-decade", "mood-engine-runtime", "mood-engine-country", "mood-engine-rating", "mood-engine-friends"]);
  assert.deepEqual(plan.discover.map((c) => c.name), ["Mood Engine · Moods", "Mood Engine · Lists", "Mood Engine · Lists (unseen)", "Mood Engine · By decade", "Mood Engine · By runtime", "Mood Engine · By country", "Mood Engine · By rating", "Mood Engine · Friends"]);
  const man = manifestFor({ addon: { id: "x", version: "2.0.0", name: "n", description: "d" } }, plan);
  for (const c of man.catalogs.filter((c) => c.id.startsWith("mood-engine"))) {
    assert.equal(c.extra.length, 1, c.id);
    assert.equal(c.extra[0].name, "genre");
    assert.equal(c.extra[0].isRequired, true);
    assert.ok(c.extra[0].options.length > 0);
  }
  assert.ok(!JSON.stringify(man).includes('"skip"'));
  assert.deepEqual(man.catalogs.find((c) => c.id === "mood-engine-friends").extra[0].options, ["Top · Ana", "Watch together · Ana", "Best (Ana)"]);
  assert.deepEqual(man.catalogs.find((c) => c.id === "mood-engine-lists").extra[0].options, ["Cannes Winners (moviewithus)", "Empty one"]); // a list that is empty tonight is still declared
  assert.deepEqual(man.catalogs.find((c) => c.id === "mood-engine-decade").extra[0].options.slice(0, 2), ["1920s", "1930s"]);
  assert.deepEqual(man.catalogs.find((c) => c.id === "mood-engine-runtime").extra[0].options, ["Under 90 min", "90–120 min", "120–150 min", "Over 150 min"]);
  assert.deepEqual(man.catalogs.find((c) => c.id === "mood-engine-rating").extra[0].options, ["4.2+", "4.0–4.2", "3.8–4.0", "Under 3.8"]);
  assert.equal(man.catalogs.filter((c) => !c.extra).length, 13); // 11 fixed rows + the 2 moods of this fixture
});

test("plan: Friends loved is capped at the Board size, Discover options are not; --skip-friends drops both friends rows and the Friends catalog", () => {
  const plan = basePlan();
  assert.equal(plan.board.find((r) => r.id === "friends-love").items.length, 30);
  const noFriends = basePlan({ withFriends: false });
  assert.ok(!noFriends.board.some((r) => r.id.startsWith("friends-")));
  assert.ok(!noFriends.discover.some((c) => c.id === "mood-engine-friends"));
  const noSources = basePlan({ withFriends: false, cuts: null, lists: [] });
  assert.deepEqual(noSources.discover.map((c) => c.id), ["mood-engine"]);
});

test("option labels are safe file names and unique within a catalog", () => {
  assert.equal(safeLabel("A/B\\C?D#E%F"), "A-B-C-D-E-F");
  assert.deepEqual(uniqueOptions([{ label: "Top · Ana" }, { label: "Top · Ana" }, { label: "Top · Ana" }]).map((o) => o.label), ["Top · Ana", "Top · Ana 2", "Top · Ana 3"]);
});

test("menus: what changed since the last recorded build is named (a country entering the top 12), a first build has nothing to compare", () => {
  const plan = basePlan();
  const now = menusOf(plan);
  assert.equal(now["mood-engine-country"].join(), "France");
  assert.deepEqual(menuChanges(null, now), []);
  assert.deepEqual(menuChanges(now, now), []);
  assert.deepEqual(menuChanges({ ...now, "mood-engine-country": ["France", "Norway"], "mood-engine-gone": ["x"] }, now), [
    { id: "mood-engine-country", added: [], dropped: ["Norway"] }, { id: "mood-engine-gone", added: [], dropped: ["x"] },
  ]);
  assert.deepEqual(menuChanges({ ...now, "mood-engine-country": ["Spain"] }, now), [{ id: "mood-engine-country", added: ["France"], dropped: ["Spain"] }]);
});

test("guard: exempt by NAME — Old friends and the full Lists may hold seen films; Lists (unseen), the cuts and every other file may not; a tt id is always required", () => {
  assert.deepEqual(GUARD_EXEMPT, ["oldfriends", "mood-engine-lists"]);
  const seen = { id: "tt0000009", tmdb: 555, title: "Whatever", year: 1999 };
  const g = { seenIds: new Set([555]), titleSeen: () => false, seenSlugs: new Set() };
  const ok = (key) => findLeaks({ [key]: [seen] }, g).length === 0;
  assert.ok(ok("oldfriends"));
  assert.ok(ok("mood-engine-lists/genre=Cannes Winners (moviewithus)"));
  assert.ok(!ok("mood-engine-lists-unseen/genre=Cannes Winners (moviewithus)")); // the name is the whole catalog id, not a prefix
  assert.ok(!ok("mood-engine-lists-extra/genre=x"));
  for (const k of ["mood-engine/genre=Uplift", "mood-engine-decade/genre=1990s", "mood-engine-runtime/genre=Under 90 min", "mood-engine-country/genre=France", "mood-engine-rating/genre=4.2+", "mood-engine-friends/genre=Top · Ana", "friends-week", "fromlists", "short", "newforyou", "tonight"]) assert.ok(!ok(k), k);
  assert.match(findLeaks({ "mood-engine-lists/genre=x": [{ id: null, tmdb: null, title: "No tt", year: 2000 }] }, g)[0], /no IMDb id/);
  // the Letterboxd slug (and its redirect target) counts as seen as well
  const bySlug = { id: "tt0000010", tmdb: null, slug: "old-name", canon: "new-name", title: "X", year: 2000 };
  assert.equal(findLeaks({ short: [bySlug] }, { ...g, seenSlugs: new Set(["new-name"]) }).length, 1);
});

test("guard reads the plan flat: every Board row and every Discover option file is checked, so a seen film in a cut is found", () => {
  const plan = basePlan();
  const flat = guardRows(plan);
  assert.ok(flat["friends-week"] && flat["mood-engine-decade/genre=1990s"] && flat["mood-engine-lists-unseen/genre=Cannes Winners (moviewithus)"]);
  const planted = { id: "tt0000009", tmdb: 555, title: "Planted", year: 1999 };
  const g = { seenIds: new Set([555]), titleSeen: () => false };
  assert.deepEqual(findLeaks(flat, g), []);
  plan.discover.find((c) => c.id === "mood-engine-country").options[0].items.push(planted);
  assert.deepEqual(findLeaks(guardRows(plan), g), ["Planted (1999) in mood-engine-country/genre=France"]);
});

test("publish + verify: every declared option has its genre= file (and the percent-encoded twin), and verify.js says so; remove one and it says which", () => {
  const out = tmp();
  try {
    const plan = basePlan();
    plan.discover.find((c) => c.id === "mood-engine-runtime").options[0].label = "Under 90 min";
    const cfg = { addon: { id: "x", version: "2.0.0", name: "n", description: "d" } };
    const r = publish({ outDir: out, webDir: path.join(ROOT, "web"), cfg, plan, webData: {} });
    assert.ok(r.files > r.catalogs);
    assert.ok(fs.existsSync(path.join(out, "catalog/movie/mood-engine-runtime/genre=Under 90 min.json")));
    assert.ok(fs.existsSync(path.join(out, "catalog/movie/mood-engine-runtime/genre=Under%2090%20min.json")));
    assert.ok(fs.existsSync(path.join(out, "catalog/movie/mood-engine-rating/genre=4.2%2B.json")));
    const v = verifyDir(out);
    assert.deepEqual(v.problems, []);
    assert.equal(v.ok, true);
    assert.equal(v.rows.filter((x) => x.kind === "board").length, 13);

    fs.rmSync(path.join(out, "catalog/movie/mood-engine-country/genre=France.json"));
    fs.writeFileSync(path.join(out, "catalog/movie/mood-engine-country/genre=Spain.json"), JSON.stringify({ metas: [] }));
    fs.writeFileSync(path.join(out, "catalog/movie/lost.json"), "{}");
    const bad = verifyDir(out);
    assert.equal(bad.ok, false);
    assert.ok(bad.problems.some((p) => /mood-engine-country\/France: .*genre=France\.json is missing/.test(p)), bad.problems.join("|"));
    assert.ok(bad.problems.some((p) => /orphan file catalog\/movie\/mood-engine-country\/genre=Spain\.json/.test(p)));
    assert.ok(bad.problems.some((p) => /orphan file catalog\/movie\/lost\.json/.test(p)));
  } finally { rm(out); }
});

// Marco, 22/10/2026 ~04:05 UTC: the static addon's Lists menus offer the short names too (one line on the phone). Defects guarded: the manifest or the files still named by the full name; an "&"
// or a "·" in a short name making a file the host cannot find (the percent-encoded twin is the file Stremio asks for); verify.js taking the new names for orphans.
test("static publish with short list names: the manifest options, the genre= files (and their encoded twins) and verify.js all use the short name, and no file is left under the full name", () => {
  const out = tmp();
  try {
    const lists = [{ id: "L1", name: "Sight and Sound greatest films 2022 (sightsoundmag)", short: "S&S greatest films 2022", all: items(5), unseen: items(3) }, { id: "L2", name: "All-time Criterion Closet Picks (closetpicks)", short: "Closet Picks · all-time", all: items(2), unseen: items(1) }, { id: "L3", name: "A list with no short name", all: items(1), unseen: items(1) }];
    const plan = basePlan({ lists });
    const cfg = { addon: { id: "x", version: "2.0.0", name: "n", description: "d" } };
    const r = publish({ outDir: out, webDir: path.join(ROOT, "web"), cfg, plan, webData: {} });
    const options = (id) => r.manifest.catalogs.find((c) => c.id === id).extra[0].options;
    for (const id of ["mood-engine-lists", "mood-engine-lists-unseen"]) {
      assert.deepEqual(options(id), ["S&S greatest films 2022", "Closet Picks · all-time", "A list with no short name"], id);
      for (const name of options(id)) for (const f of new Set([`genre=${name}.json`, `genre=${encodeURIComponent(name)}.json`])) assert.ok(fs.existsSync(path.join(out, "catalog/movie", id, f)), `${id}/${f}`);
      assert.deepEqual(fs.readdirSync(path.join(out, "catalog/movie", id)).filter((f) => /sightsoundmag|closetpicks/.test(f)), [], `${id}: no file under a full name`);
    }
    const v = verifyDir(out);
    assert.deepEqual(v.problems, []);
  } finally { rm(out); }
});

test("verify: a catalog that is not required, one with skip, a meta without a tt id, a repeated id and more than 300 items are all reported", () => {
  const out = tmp();
  try {
    const write = (rel, o) => { fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true }); fs.writeFileSync(path.join(out, rel), JSON.stringify(o)); };
    const meta = (id) => ({ id, name: "n" });
    write("manifest.json", { version: "2.0.0", catalogs: [
      { type: "movie", id: "optional", name: "x", extra: [{ name: "genre", isRequired: false, options: ["A"] }] },
      { type: "movie", id: "paged", name: "x", extra: [{ name: "genre", isRequired: true, options: ["A"] }, { name: "skip" }] },
      { type: "movie", id: "board", name: "x" },
    ] });
    write("catalog/movie/optional/genre=A.json", { metas: [meta("tt1")] });
    write("catalog/movie/paged/genre=A.json", { metas: [meta("tt1")] });
    write("catalog/movie/board.json", { metas: [meta("tt1"), meta("tt1"), meta("tmdb:5"), ...Array.from({ length: 300 }, (_, i) => meta("tt9" + i))] });
    const p = verifyDir(out).problems.join("\n");
    assert.match(p, /optional: the genre extra is not required/);
    assert.match(p, /paged: declares skip/);
    assert.match(p, /paged: must have exactly one extra/);
    assert.match(p, /board: tt1 \(n\) appears twice/);
    assert.match(p, /board: "n" has id tmdb:5, not an IMDb id/);
    assert.match(p, /board: .* items, more than 300/);
  } finally { rm(out); }
});


// ── the review's findings: what "seen" means, and what survives a bad night ──

test("seen by IMDb id: a film your export dates 2004 and TMDB dates 2011 is one film, found through the Letterboxd record (the Kill Bill case)", () => {
  const norm = require("../lib/util").norm;
  const watched = new Map([[norm("Kill Bill: The Whole Bloody Affair"), [2004]]]); // your export
  const titleSeen = (t, y) => (watched.get(norm(t)) || []).some((sy) => Math.abs(sy - y) <= 1);
  const films = {
    "kill-bill-the-whole-bloody-affair": { title: "Kill Bill: The Whole Bloody Affair", year: 2004, tmdbId: 414419, imdbId: "tt6019206" }, // Letterboxd: 2004
    other: { title: "Other", year: 1999, tmdbId: 5, imdbId: "tt0000050" },
    "alt-page": { title: "Seen under another page", year: 1980, tmdbId: null, imdbId: "tt0000060" }, // only this page is on your /films/
    "alt-page-2": { title: "Same film, other page", year: 1980, tmdbId: null, imdbId: "tt0000060" },
    redirected: { title: "R", year: 1970, tmdbId: null, imdbId: "tt0000070", canon: "r-final" },
  };
  const tts = seenImdbIds({ films, me: new Set(["alt-page", "r-final"]), seenIds: new Set([777]), titleSeen, imdbOfTmdb: (id) => (id === 777 ? "tt0000777" : null) });
  assert.deepEqual([...tts].sort(), ["tt0000070", "tt0000060", "tt0000777", "tt6019206"].sort());
  // and the published item (TMDB year 2011, TMDB id 99999 that is not in your export) is refused by its IMDb id alone
  const published = { id: "tt6019206", tmdb: 99999, slug: null, title: "Kill Bill: The Whole Bloody Affair", year: 2011 };
  const g = { seenIds: new Set(), titleSeen, seenSlugs: new Set() };
  assert.deepEqual(findLeaks({ "mood-engine/genre=Nocturnal": [published] }, g), [], "without the IMDb ids the guard is blind to it (that was the leak)");
  assert.equal(findLeaks({ "mood-engine/genre=Nocturnal": [published] }, { ...g, seenTts: tts }).length, 1);
});

test("guard: the original title and the redirect address count as identities too", () => {
  const g = { seenIds: new Set(), titleSeen: (t) => t === "Les 400 coups", seenSlugs: new Set(["final-slug"]) };
  const base = { id: "tt0000001", tmdb: null, slug: null, title: "The 400 Blows", year: 1959 };
  assert.equal(findLeaks({ short: [base] }, g).length, 0);
  assert.equal(findLeaks({ short: [{ ...base, originalTitle: "Les 400 coups" }] }, g).length, 1);
  assert.equal(findLeaks({ short: [{ ...base, slug: "old-slug", canon: "final-slug" }] }, g).length, 1);
});

test("pool: if ANY page of an IMDb id is seen the film leaves, whichever page came first", () => {
  const films = { a: film("tt0000091", "A", 2000, { r: 4 }), b: film("tt0000091", "A (page 2)", 2000, { r: 4 }) };
  for (const order of [["a", "b"], ["b", "a"]]) {
    const { pool, stats } = P.buildPool({ entries: order.map((slug) => ({ slug, tag: tag("watchlist") })), view: { films }, isSeen: (r) => r.slug === "b" });
    assert.equal(pool.size, 0, order.join());
    assert.ok(stats.seen >= 1);
  }
});

test("week row: two Letterboxd pages of one film are one film with everybody's name, each person once", () => {
  const view = { films: { p1: film("tt0000092", "One film", 2026, {}), p2: film("tt0000092", "One film (alt page)", 2026, {}) } };
  const week = new Map([
    ["p1", [{ name: "Ana", rating: 4, watched: "2026-10-09" }, { name: "Bia", rating: null, watched: "2026-10-08" }]],
    ["p2", [{ name: "Caio", rating: 3, watched: "2026-10-07" }, { name: "Bia", rating: 5, watched: "2026-10-09" }]],
  ]);
  const { items } = P.weekRow({ week, view, isSeen: () => false });
  assert.equal(items.length, 1);
  assert.equal(items[0].why[0], "watched this week by Bia 5★ · Ana 4★ · Caio 3★"); // Bia once, with the rating that exists
});

test("a cache that cannot be read stops the build; only a missing file is an empty cache; saving leaves no temp file and never uses a shared temp name", () => {
  const dir = tmp();
  try {
    assert.deepEqual(Object.keys(F.loadCache(path.join(dir, "none.json")).films), []);
    assert.deepEqual(L.loadListsCache(path.join(dir, "none.json")).lists, {});
    fs.writeFileSync(path.join(dir, "bad.json"), "<<<<<<< HEAD\n{}\n=======\n");
    assert.throws(() => F.loadCache(path.join(dir, "bad.json")), /bad\.json is not valid JSON/);
    assert.throws(() => L.loadListsCache(path.join(dir, "bad.json")), /bad\.json is not valid JSON/);
    F.saveCache(path.join(dir, "ok.json"), { films: {} });
    L.saveListsCache(path.join(dir, "ok2.json"), { lists: {} });
    assert.deepEqual(fs.readdirSync(dir).sort(), ["bad.json", "ok.json", "ok2.json"]);
    const src = fs.readFileSync(path.join(ROOT, "lib", "friends.js"), "utf8") + fs.readFileSync(path.join(ROOT, "lib", "lists.js"), "utf8") + fs.readFileSync(path.join(ROOT, "lib", "tmdb.js"), "utf8");
    assert.equal((src.match(/process\.pid/g) || []).length, 3, "all three caches write to a temp name of their own process");
  } finally { rm(dir); }
});

test("read again: what the page does not say this time is not forgotten (title, TMDB id, redirect target)", async () => {
  const cache = F.loadCache("/nonexistent");
  cache.films.x = { title: "Known", year: 1990, tmdbId: 55, imdbId: "tt0000055", canon: "x-final", t: 1 };
  const http = fakeHttp({ "/film/x/": "<html><body><h1 class=\"headline-1 primaryname\"><span class=\"name\"></span></h1><a href=\"http://www.imdb.com/title/tt0000055/maindetails\">IMDb</a></body></html>" });
  await F.resolveFilms({ slugs: [], enrich: ["x"], cache, http, sleepImpl: noSleep });
  assert.deepEqual([cache.films.x.title, cache.films.x.tmdbId, cache.films.x.canon, cache.films.x.imdbId, cache.films.x.v], ["Known", 55, "x-final", "tt0000055", 2]);
});

test("TTLs carry a margin: a nightly build a few seconds earlier than last night's still re-reads Popular this week; lists wait their week", async () => {
  const file = path.join(tmp(), "lists.json");
  const NOW = Date.parse("2026-10-10T12:00:00Z");
  const http = fakeHttp(listRoutes());
  const resolve = async () => "https://letterboxd.com/v/list/b/";
  await L.refreshLists({ cfg: LCFG, file, http, now: NOW, sleepImpl: noSleep, resolve });
  http.calls.length = 0;
  await L.refreshLists({ cfg: LCFG, file, http, now: NOW + 864e5 - 30000, sleepImpl: noSleep, resolve }); // 23h59m30s later
  assert.deepEqual(http.calls.map((u) => new URL(u).pathname), ["/films/popular/this/week/"]);
  http.calls.length = 0;
  await L.refreshLists({ cfg: LCFG, file, http, now: NOW + 7 * 864e5 - 30000, sleepImpl: noSleep, resolve }); // 6d23h59m30s
  assert.equal(http.calls.length, 3);
  http.calls.length = 0;
  await L.refreshLists({ cfg: LCFG, file, http, now: NOW + 7 * 864e5 - 30000 + 3600e3, sleepImpl: noSleep, resolve }); // one hour after that: fresh again
  assert.equal(http.calls.length, 0);
  rm(path.dirname(file));
});

test("friends rows with keepEmpty: every friend and every friend list keeps its Discover entry on a night it is empty; without it an empty row is not made", () => {
  const cache = F.loadCache("/nonexistent");
  cache.films = { a: { title: "Alpha", year: 2001, imdbId: "tt0000001", tmdbId: null, t: 1 } };
  cache.users.ana = { films: [["a", "Alpha", 2001, 5]], watchlist: [] };
  cache.users.bia = { films: [], watchlist: [] };
  cache.users.caio = { films: [], watchlist: [] };
  cache.lists["ana/best"] = { items: [] };
  const cfg = { ...CFGF, friendRows: { top: { word: "Top · {name}" }, session: { word: "Watch together · {name}", minShared: 1 }, list: { word: "{list} ({owner})" } } };
  const view = F.viewFriends(cache, cfg);
  const args = { view, cfg, isSeen: () => false, onMyWatchlist: () => false };
  assert.deepEqual(buildFriendRows(args).meta.filter((m) => m.kind !== "love").map((m) => m.word), ["Top · Ana"]); // only the one that has films
  const kept = buildFriendRows({ ...args, keepEmpty: true }).meta.filter((m) => m.kind !== "love").map((m) => m.word);
  assert.deepEqual(kept, ["Top · Ana", "Top · Bia", "Top · Caio", "Watch together · Ana", "Watch together · Bia", "Watch together · Caio", "Best of Ana (Ana)"]);
});

// Marco, 13/10/2026: the year of a film is Letterboxd's first, TMDB's only as the reserve and only from the film's own record (P.yearOf). Until then this test
// pinned the opposite on purpose (TMDB's year shown, Letterboxd 1959 vs TMDB 1960 put "Shadows" in the 1960s); measured against the IMDb dataset, Letterboxd gave
// the IMDb year for 781 of the 802 films where the two differed. The test now asserts the new rule, and keeps its other half: before 1920 and after this decade are counted.
test("cuts: a film is in the decade of the year shown on it (Letterboxd's, else its own TMDB record's); years before the 1920s or after this decade are counted, not dropped silently", () => {
  const films = {
    tmdbyear: film("tt0000093", "Shadows", 1959, { tmdbId: 90, r: 4, rt: 100 }), // Letterboxd says 1959, TMDB says 1960: 1959 is shown
    reserve: film("tt0000097", "Reserve", null, { tmdbId: 91, r: 4, rt: 100 }), // Letterboxd has no year: the film's own TMDB record gives 1972
    stranger: film("tt0000098", "Stranger", null, { tmdbId: 92, r: 4, rt: 100 }), // Letterboxd has no year and the TMDB id names another film (tt0000001): no year, no decade
    old: film("tt0000094", "Too old", 1915, { r: 4, rt: 100 }), future: film("tt0000095", "Future", 2031, { r: 4, rt: 100 }), fine: film("tt0000096", "Fine", 1985, { r: 4, rt: 100 }),
  };
  const tm = { 90: { id: 90, imdb: "tt0000093", year: 1960 }, 91: { id: 91, imdb: "tt0000097", year: 1972 }, 92: { id: 92, imdb: "tt0000001", year: 1944 } };
  const { pool } = P.buildPool({ entries: Object.keys(films).map((slug) => ({ slug, tag: tag("watchlist") })), view: { films }, isSeen: () => false, detail: (r) => (tm[r.tmdbId] ? { title: "x", runtime: 100, countries: [], va: 7, vc: 100, genres: [], directors: [], overview: "", ...tm[r.tmdbId] } : null) });
  const cut = P.cuts(P.rankPool(pool, { stats: new Map() }), { size: 60, today: "2026-10-10" });
  assert.deepEqual(cut.decade.map((d) => d.label), ["1950s", "1970s", "1980s"]);
  assert.equal(cut.decade[0].items[0].year, 1959);
  assert.equal(cut.decade[1].items[0].year, 1972);
  assert.equal(cut.missing.decade, 1, "the stranger's 1944 is not lent to the film");
  assert.equal(cut.missing.outOfRange, 2);
});

test("country names: the spellings Letterboxd and TMDB both use for the same place land on one", () => {
  for (const [a, b] of [["USSR", "SU"], ["USA", "US"], ["UK", "GB"], ["Palestinian Territories", "State of Palestine"], ["Bosnia & Herzegovina", "Bosnia and Herzegovina"], ["Macao", "Macao SAR China"]]) assert.equal(P.countryLabel(a), P.countryLabel(b), `${a} / ${b}`);
});

test("build --cache-only --self-test-guard: films planted by TMDB id, title, Letterboxd slug and IMDb id are all refused in a Discover file (reads the real caches, plants into the plan)", { skip: !fs.existsSync(path.join(ROOT, "cache", "lists.json")) }, () => {
  const cache = tmp("mood-cache-");
  for (const f of ["friends.json", "lists.json", "tmdb.json", "directors.json"]) fs.copyFileSync(path.join(ROOT, "cache", f), path.join(cache, f));
  try {
    const r = spawnSync(process.execPath, ["build.js", "--offline", "--cache-only", "--cache-dir", cache, "--self-test-guard"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /and in a Discover file, by tmdb · by title · by slug · by tt → 4 of 4 refused/);
    assert.match(r.stdout, /let it through in the exempt catalog/);
  } finally { rm(cache); }
});

// ── the build, from the caches, with nobody asked ────────────────────────────

test("build --cache-only draws a cover from a raw cover that is on disk, publishes it at the Pages address, and verify.js finds the file (needs Pillow)", { skip: (!fs.existsSync(path.join(ROOT, "cache", "lists.json")) && "no caches") || (spawnSync("python3", ["-c", "import PIL"]).status !== 0 && "python3 with Pillow is not installed") }, () => {
  const out = tmp(), out2 = tmp(), cache = tmp("mood-cache-");
  for (const f of ["friends.json", "lists.json", "tmdb.json", "directors.json"]) fs.copyFileSync(path.join(ROOT, "cache", f), path.join(cache, f));
  fs.cpSync(path.join(ROOT, "cache", "flags"), path.join(cache, "flags"), { recursive: true }); // the committed flag pictures (--cache-only downloads none)
  const go = (o) => spawnSync(process.execPath, ["build.js", "--offline", "--cache-only", "--cache-dir", cache, "--out", o], { cwd: ROOT, encoding: "utf8", env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" } });
  try {
    assert.equal(go(out).status, 0);
    const first = JSON.parse(fs.readFileSync(path.join(out, "catalog", "movie", "watchlist.json"), "utf8")).metas.slice(0, 3).map((m) => m.id);
    fs.mkdirSync(path.join(cache, "posters-raw"), { recursive: true });
    for (const tt of first.slice(0, 2)) assert.equal(spawnSync("python3", ["-c", `from PIL import Image; Image.new("RGB", (342, 513), (80, 90, 100)).save(${JSON.stringify(path.join(cache, "posters-raw", tt + ".jpg"))})`]).status, 0);
    const r = go(out2);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Covers: .* 2 drawn · FAILED: 0 download, 0 drawing.* \(those keep the original address\) · 0 skipped \(backoff\) · \d+ covers published/); // B3, 19/10/2026: the log quotes the covers left on backoff
    // the country of every film follows its original language (TMDB's cache) and, for a film TMDB does not know, the Letterboxd page; nearly every film has one;
    // the flag pictures are found in the cache folder; and the log says how many flags changed from the v2.2 rule
    // since 24/10/2026 (Marco, 23/10/2026: the country of the card is the director's citizenship or TMDB's origin, and the flag follows it) the main country comes first and the language rule is the fallback
    const c = r.stdout.match(/Countries \(cover country choice: main country by director\/origin, with the old language\/production fallback\), of \d+ distinct films: (\d+) by main country · (\d+) by language \+ a production country that speaks it · (\d+) by the language's default country \(no production country speaks it\) · (\d+) with no language: first TMDB production country · (\d+) with no language: first country on the Letterboxd page · (\d+) unknown/);
    assert.ok(c, "the Countries line is in the log");
    const [byMain, byLang, byDefault, byProd, byLb, none] = c.slice(1).map(Number);
    assert.ok(byMain > 0 && none < 0.05 * (byMain + byLang + byDefault + byProd + byLb + none), `countries: ${c[0]}`);
    const changed = r.stdout.match(/Flag: (\d+) films change flag from the first production country to the main-country\/fallback choice/);
    assert.ok(changed && Number(changed[1]) > 0, "the log counts the flags that changed");
    const flagLine = (r.stdout.match(/Flag: .*/) || [""])[0];
    const knownFallbacks = new Set(["tn", "se", "iu", "ff", "ks", "ay", "lg", "rw", "om"]);
    assert.deepEqual([...flagLine.matchAll(/([a-z]{2}) ×\d+/g)].map(m => m[1]).filter(l => !knownFallbacks.has(l)), [], "new language missing from the frozen v2.3 table: " + flagLine);
    const t = r.stdout.match(/Top-left facts of targets: (\d+) year \+ flag · (\d+) year alone \(no country known\) · 0 year alone \(flag missing, --cache-only downloads nothing\) · flags: 0 downloaded now/);
    assert.ok(t && Number(t[1]) > 0.9 * (byMain + byLang + byDefault + byProd + byLb), `top left: ${t && t[0]}`);
    const metas = JSON.parse(fs.readFileSync(path.join(out2, "catalog", "movie", "watchlist.json"), "utf8")).metas;
    const poster = (tt) => metas.find((m) => m.id === tt).poster;
    // 19/10/2026: the address carries ?v=<8 characters of the sha256 of the published file>
    for (const tt of first.slice(0, 2)) assert.equal(poster(tt), `https://marcogusmao.github.io/mood-engine/posters/${tt}.jpg?v=${require("crypto").createHash("sha256").update(fs.readFileSync(path.join(out2, "posters", `${tt}.jpg`))).digest("hex").slice(0, 8)}`);
    assert.match(poster(first[2]), /metahub\.space/); // no raw cover on disk: the original address
    assert.deepEqual(fs.readdirSync(path.join(out2, "posters")).sort(), first.slice(0, 2).map((t) => t + ".jpg").sort());
    assert.deepEqual(verifyDir(out2).problems, []);
    assert.equal(verifyDir(out2).covers, 2);
    // v2.2: the year (and the flag) are really on the drawn cover. The raw cover is a flat (80, 90, 100); the top-left pill is dark, and not on a cover that was not drawn
    const dark = (file) => spawnSync("python3", ["-c", `from PIL import Image; print(sum(Image.open(${JSON.stringify(file)}).convert("RGB").getpixel((13, 25))) < 150)`], { encoding: "utf8" }).stdout.trim();
    for (const tt of first.slice(0, 2)) assert.equal(dark(path.join(out2, "posters", tt + ".jpg")), "True", `${tt}: no year pill in the top-left corner`);
  } finally { rm(out); rm(out2); rm(cache); }
});

test("build --cache-only: every Board row and every Discover option is written, and verify.js agrees (reads cache/friends.json and cache/lists.json; asks nobody; writes no cache)", { skip: !fs.existsSync(path.join(ROOT, "cache", "lists.json")) }, () => {
  const out = tmp(), cache = tmp("mood-cache-");
  for (const f of ["friends.json", "lists.json", "tmdb.json", "directors.json"]) fs.copyFileSync(path.join(ROOT, "cache", f), path.join(cache, f)); // a copy: a build running elsewhere may be rewriting the real ones
  const bytes = () => ["friends.json", "lists.json", "tmdb.json", "directors.json"].map((f) => fs.readFileSync(path.join(cache, f), "utf8"));
  const before = bytes();
  try {
    const r = spawnSync(process.execPath, ["build.js", "--offline", "--cache-only", "--cache-dir", cache, "--out", out], { cwd: ROOT, encoding: "utf8", env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const man = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    assert.equal(man.version, "2.4.0");
    assert.deepEqual(man.catalogs.slice(0, 7).map((c) => c.id), ["tonight", "watchlist", "fromlists", "friends-love", "friends-week", "short", "because"]);
    assert.deepEqual(man.catalogs.filter((c) => c.extra).map((c) => c.id), ["mood-engine", "mood-engine-lists", "mood-engine-lists-unseen", "mood-engine-decade", "mood-engine-runtime", "mood-engine-country", "mood-engine-rating", "mood-engine-friends", "mood-engine-directors-loved"]);
    assert.equal(man.catalogs.find((c) => c.id === "mood-engine-lists").extra[0].options.length, 147); // + the Beyond the Sight & Sound Canon A-List (22/10/2026 ~15:05 UTC); 146 with the four TSPDT top 250 lists (22/10/2026); 27 + the 63 lists of 11/10/2026 (Marco) + 3 IndieWire editions (2 static, 1 Letterboxd copy) + 46 Criterion Channel lists (Marco, 11/10/2026) + 3 lists of cinematography for "Visually striking" (14/10/2026, PR5)
    const v = verifyDir(out);
    assert.deepEqual(v.problems, []);
    assert.deepEqual(bytes(), before, "--cache-only must not write the caches");
    // v2.1: every film carries its numbers and its three-line description, and the covers it could not draw keep the metahub address
    const metas = JSON.parse(fs.readFileSync(path.join(out, "catalog", "movie", "watchlist.json"), "utf8")).metas;
    assert.ok(metas.length > 5);
    assert.ok(metas.every((m) => /^https:\/\/images\.metahub\.space\/poster\/medium\/tt\d+\/img$/.test(m.poster)), "--cache-only draws nothing that is not on disk");
    assert.ok(metas.some((m) => /^[^\n]+ · \d+h\d\d(?: · [^\n]+)?\.$/.test(m.description.split("\n")[0])), "line 1 is the credits: director · duration · actors, ended by a full stop (description v3, 20/10/2026: no ★ any more)");
    assert.ok(metas.every((m) => !m.description.includes("★")), "and no star in any description");
    assert.ok(metas.every((m) => !/IMDb \d|want to see/.test(m.description)), "and the numbers line is gone (13/10/2026)");
    // 13/10/2026 (sizes.watchlist 40 → 100, Marco): the row now reaches films with no watchlist date, which the first 40 never did. 6 films of the live watchlist
    // have none today: they are not in watchlist.csv of 10/10 (Killers of the Flower Moon, for one), so the build knows they are on the list but not since when and
    // writes "on your watchlist" alone. The rule: a film with a known date says since; one without says the line without it; every film has the why line on its own line.
    // 20/10/2026 (description v3): the watchlist row's reason ("on your watchlist since Aug 2022", dated exactly when watchlist.csv has the date, at most 6 films without one) is no longer in the
    // description; it is `why` on the plan item (test/describe.test.js plants a dated watchlist film and reads it there). NOT OBSERVED ANY MORE: the undated films and the bound of 6 on real data (BACKLOG 20/10/2026). What the build must still do here: no reason in the card.
    assert.ok(metas.every((m) => !/on your watchlist|Your watchlist, best first/.test(m.description)), "the card carries no reason line");
  } finally { rm(out); rm(cache); }
});
