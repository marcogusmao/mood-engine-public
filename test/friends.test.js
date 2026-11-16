// node --test            (no dependencies)
// Fixtures in test/fixtures are real Letterboxd pages, trimmed to a handful of posters/items and otherwise untouched.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const F = require("../lib/friends");
const { buildFriendRows } = require("../lib/rows");
const { findLeaks } = require("../lib/guard");
const { norm } = require("../lib/util");

const fx = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const ROOT = path.join(__dirname, "..");

// ── parsers ──────────────────────────────────────────────────────────────────

test("/films/by/date/ and /films/by/rated-date/ (real pages, Chrome, 11/10/2026, friend-c page 1 of 4): 72 films, the member's count 276, the next page of the same ordering", () => {
  const byDate = fx("films-by-date-chrome.html"), byRated = fx("films-by-rated-date-chrome.html");
  for (const html of [byDate, byRated]) {
    const items = F.parseFilmsPage(html);
    assert.equal(items.length, 72);
    assert.equal(new Set(items.map((i) => i.slug)).size, 72);
    assert.ok(items.every((i) => i.title && i.year));
    assert.equal(F.parseFilmsTotal(html), 276);
  }
  assert.equal(F.parseNext(byDate), "/friend-c/films/by/date/page/2/");
  assert.equal(F.parseNext(byRated), "/friend-c/films/by/rated-date/page/2/");
  assert.equal(F.parseFilmsPage(byDate).filter((i) => i.rating == null).length, 4, "by/date lists rated and unrated films alike");
  assert.equal(F.parseFilmsPage(byRated).filter((i) => i.rating == null).length, 0, "by/rated-date puts the unrated at the end: none on page 1");
  assert.deepEqual(F.parseFilmsPage(byDate).slice(0, 2).map((i) => [i.slug, i.rating]), [["resident-evil-2026", 4], ["carlitos-way", 4]]);
});

test("/films/ page: slugs, titles, years and the owner's rating from the rated-N class", () => {
  const items = F.parseFilmsPage(fx("films-page.html"));
  assert.deepEqual(items.map((i) => [i.slug, i.title, i.year, i.rating]), [
    ["resident-evil-2026", "Resident Evil", 2026, 4],
    ["my-best-friend-2026", "My Best Friend", 2026, 0.5], // rated-1 = half a star
    ["puella-magi-madoka-magica-the-movie-walpurgisnacht", "Puella Magi Madoka Magica the Movie -Walpurgisnacht: Rising-", 2026, 5],
    ["avatar-aang-the-last-airbender", "Avatar Aang: The Last Airbender", 2026, null], // no rated-N: watched, not rated
    ["mononoke-the-movie-chapter-iii-the-curse", "Mononoke the Movie: Chapter III - The Curse of the Serpent", 2026, null],
  ]);
});

test("/films/ page: the 'Older' link is found, and a last page has none", () => {
  assert.equal(F.parseNext(fx("films-page.html")), "/friend-c/films/page/2/");
  assert.equal(F.parseNext(fx("list-page-last.html")), null);
});

test("/watchlist/ page: slugs and titles with entities decoded (Son&#039;s Room), no rating field", () => {
  const items = F.parseWatchlistPage(fx("watchlist-page.html"));
  assert.deepEqual(items, [
    { slug: "marama", title: "Mārama", year: 2025 },
    { slug: "the-sons-room", title: "The Son's Room", year: 2001 },
    { slug: "boys-dont-cry", title: "Boys Don't Cry", year: 1999 },
  ]);
  assert.equal(F.parseNext(fx("watchlist-page.html")), "/friend-c/watchlist/page/2/");
});

test("list page: films in the owner's order, and the 'Cloned from…' widget is not read", () => {
  const items = F.parseListPage(fx("list-page.html"));
  assert.deepEqual(items.map((i) => i.slug), ["satantango", "antichrist", "mother-2017"]);
  assert.equal(items[2].title, "mother!");
  assert.ok(!items.some((i) => i.slug === "werckmeister-harmonies" || i.slug === "salo-or-the-120-days-of-sodom"));
  assert.equal(F.parseNext(fx("list-page.html")), "/friend-a/list/the-world-is-hell-hopeless-cinema/page/2/");
});

test("/film/<slug>/ page: IMDb tt, TMDB id and year (and the runtime, when the page has it)", () => {
  assert.deepEqual(F.parseFilmPage(fx("film-with-imdb.html")), {
    title: "Stranger Things 5: The Finale", year: 2025, tmdbId: 1567451, tmdbType: "movie", imdbId: "tt21914684",
    rating: null, ratings: null, runtime: 125, countries: [],
  });
  assert.deepEqual(F.parseFilmPage(fx("film-perfect-days-2011.html")), {
    title: "Perfect Days", year: 2011, tmdbId: 101140, tmdbType: "movie", imdbId: "tt2130161",
    rating: null, ratings: null, runtime: 108, countries: [],
  });
});

test("/film/<slug>/ page without an IMDb link: imdbId is null (such a film is dropped from every row)", () => {
  const f = F.parseFilmPage(fx("film-without-imdb.html"));
  assert.equal(f.imdbId, null);
  assert.equal(f.tmdbId, 1695374);
});

test("/film/<slug>/ page whose TMDB entry is a TV show: the TV id is never used as a movie id", () => {
  const html = '<html><body data-tmdb-type="tv" data-tmdb-id="4242"><h1 class="headline-1 primaryname"><span class="name">X</span></h1><a href="http://www.imdb.com/title/tt1234567/maindetails">IMDb</a></body></html>';
  const f = F.parseFilmPage(html);
  assert.equal(f.tmdbId, null);
  assert.equal(f.tmdbType, "tv");
  assert.equal(f.imdbId, "tt1234567");
});

test("RSS: slug from the link, rating (or null), rewatch, watched date, TMDB id; list items are skipped", () => {
  const items = F.parseFriendRss(fx("rss.xml"));
  assert.deepEqual(items.map((i) => [i.slug, i.title, i.rating, i.watched, i.rewatch, i.tmdbId]), [
    ["resident-evil-2026", "Resident Evil", 4, "2026-10-03", false, 1423191],
    ["carlitos-way", "Carlito's Way", 4.5, "2026-09-20", false, 6075],
    ["open-water", "Open Water", null, "2006-09-10", false, 83],
    ["carandiru", "Carandiru", 4.5, "2026-01-29", true, 8440],
  ]);
});

// ── crawl / resolve with a fake Letterboxd ───────────────────────────────────

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
const noSleep = async () => {};
const filmHtml = (title, year, tmdb, imdb) =>
  `<html><head><meta property="og:title" content="${title} (${year})"></head><body data-tmdb-type="movie" data-tmdb-id="${tmdb}"><h1 class="headline-1 primaryname"><span class="name">${title}</span></h1><span class="releasedate"><a href="/films/year/${year}/">${year}</a></span>${imdb ? `<a href="http://www.imdb.com/title/${imdb}/maindetails">IMDb</a>` : ""}</body></html>`;

test("crawl follows 'Older' links to the last page", async () => {
  const http = fakeHttp({ "/u/films/": fx("films-page.html").replace("/friend-c/films/page/2/", "/u/films/page/2/"), "/u/films/page/2/": fx("list-page-last.html") });
  const r = await F.crawl(http, "/u/films/", F.parseFilmsPage, { sleepImpl: noSleep });
  assert.equal(r.pages, 2);
  assert.equal(r.partial, false);
  assert.equal(r.items.length, 5 + 2);
});

test("crawl keeps page 1 when page 2 is refused (Cloudflare challenge), and says so", async () => {
  const http = fakeHttp({ "/u/films/": fx("films-page.html").replace("/friend-c/films/page/2/", "/u/films/page/2/"), "/u/films/page/2/": new F.BlockedError("x") });
  const r = await F.crawl(http, "/u/films/", F.parseFilmsPage, { sleepImpl: noSleep });
  assert.equal(r.partial, true);
  assert.equal(r.items.length, 5);
  assert.match(r.error, /403/);
});

test("crawl: a refusal on the very first page throws instead of returning an empty list", async () => {
  const http = fakeHttp({ "/u/films/": new F.BlockedError("x") });
  await assert.rejects(F.crawl(http, "/u/films/", F.parseFilmsPage, { sleepImpl: noSleep }), /403/);
});

test("http: 429 and 5xx are retried with backoff; a repeated 403 is a block", async () => {
  const seq = [429, 503, 200];
  const waits = [];
  const http = F.makeHttp({
    fetchImpl: async () => { const s = seq.shift(); return { status: s, ok: s === 200, headers: { get: () => null }, text: async () => "ok", url: "u" }; },
    sleepImpl: async (ms) => waits.push(ms),
  });
  assert.equal((await http.get("https://letterboxd.com/x")).text, "ok");
  assert.deepEqual(waits, [1000, 2000]);
  const blocked = F.makeHttp({ fetchImpl: async () => ({ status: 403, ok: false, headers: { get: () => null } }), sleepImpl: noSleep });
  await assert.rejects(blocked.get("https://letterboxd.com/x"), F.BlockedError);
});

test("resolveFilms: stores tt/tmdb/year per slug, skips what is cached, honours the limit", async () => {
  const cache = F.loadCache("/nonexistent");
  cache.films.cached = { title: "Cached", year: 2000, tmdbId: 1, imdbId: "tt0000001", t: Date.now() };
  const http = fakeHttp({
    "/film/a/": filmHtml("A", 2001, 11, "tt0000011"),
    "/film/b/": filmHtml("B", 2002, 12, null), // no IMDb link
    "/film/c/": filmHtml("C", 2003, 13, "tt0000013"),
  });
  const r = await F.resolveFilms({ slugs: ["cached", "a", "b", "c"], cache, http, limit: 2, sleepImpl: noSleep });
  assert.deepEqual(http.calls, ["https://letterboxd.com/film/a/", "https://letterboxd.com/film/b/"]);
  assert.equal(cache.films.a.imdbId, "tt0000011");
  assert.equal(cache.films.b.imdbId, null);
  assert.equal(r.withImdb, 1);
  assert.equal(r.withoutImdb, 1);
  assert.equal(r.left, 1); // c is still to do
});

test("resolveFilms: a film without IMDb is looked at again only after 30 days; a film with one never", async () => {
  const now = Date.now();
  const cache = F.loadCache("/nonexistent");
  cache.films.fresh_miss = { title: "m", imdbId: null, t: now - 5 * 864e5 };
  cache.films.old_miss = { title: "o", imdbId: null, t: now - 31 * 864e5 };
  cache.films.old_hit = { title: "h", imdbId: "tt0000009", t: now - 900 * 864e5 };
  const http = fakeHttp({ "/film/old_miss/": filmHtml("O", 1999, 5, "tt0000005") });
  await F.resolveFilms({ slugs: ["fresh_miss", "old_miss", "old_hit"], cache, http, now, sleepImpl: noSleep });
  assert.deepEqual(http.calls, ["https://letterboxd.com/film/old_miss/"]);
  assert.equal(cache.films.old_miss.imdbId, "tt0000005");
});

test("resolveFilms: a block stops the run but keeps what was gathered; a page that is not a film page is not cached", async () => {
  const cache = F.loadCache("/nonexistent");
  const http = fakeHttp({ "/film/a/": filmHtml("A", 2001, 11, "tt0000011"), "/film/b/": new F.BlockedError("b"), "/film/c/": filmHtml("C", 2003, 13, "tt0000013") });
  const r = await F.resolveFilms({ slugs: ["a", "b", "c"], cache, http, parallel: 1, sleepImpl: noSleep });
  assert.match(r.aborted, /403/);
  assert.ok(cache.films.a);
  assert.ok(!cache.films.b && !cache.films.c);

  const c2 = F.loadCache("/nonexistent");
  const junk = fakeHttp({ "/film/x/": "<html><title>Just a moment...</title></html>" });
  await F.resolveFilms({ slugs: ["x"], cache: c2, http: junk, sleepImpl: noSleep });
  assert.ok(!c2.films.x);
});

// ── view, priority ───────────────────────────────────────────────────────────

const CFG = {
  letterboxd: "me",
  friends: [{ user: "ana", name: "Ana" }, { user: "bia", name: "Bia" }, { user: "caio", name: "Caio" }],
  friendLists: [{ owner: "ana", slug: "best", name: "Best of Ana" }],
  friendRows: { love: { minFriends: 2, minStars: 4, soloStars: 4.5 }, top: { minStars: 4.5 }, session: { minShared: 5 }, list: {} },
  sizes: { friendsDiscover: 60 },
};

test("view: the newest RSS entry wins over the cached page; an entry without a rating keeps the page's rating", () => {
  const cache = F.loadCache("/nonexistent");
  cache.users.ana = {
    films: [["x", "X", 2000, 3], ["y", "Y", 2001, 5], ["z", "Z", 2002, 4]],
    rss: [["x", "X", 2000, 4.5, "2026-10-01"], ["y", "Y", 2001, null, "2026-09-01"], ["x", "X", 2000, 1, "2020-01-01"], ["w", "W", 2003, 4, "2026-08-01"]],
  };
  const v = F.viewFriends(cache, { friends: [{ user: "ana", name: "Ana" }] });
  const f = v.users[0].films;
  assert.equal(f.get("x").rating, 4.5); // RSS newer
  assert.equal(f.get("x").watched, "2026-10-01"); // not overwritten by the older entry
  assert.equal(f.get("y").rating, 5); // RSS entry has no rating → page rating stays
  assert.equal(f.get("z").rating, 4);
  assert.equal(f.get("w").rating, 4); // only known from the RSS
});

test("prioritize: films several friends loved first, then list items, shared watchlist, top picks; the rest last", () => {
  const cache = F.loadCache("/nonexistent");
  cache.users.ana = { films: [["both", "Both", 2000, 4.5], ["solo-low", "Solo", 2000, 3], ["ana-top", "AnaTop", 2000, 5]], watchlist: [["wish", "Wish", 2001], ["other", "Other", 2002]] };
  cache.users.bia = { films: [["both", "Both", 2000, 4]], watchlist: [] };
  cache.lists["ana/best"] = { items: [["listed", "Listed", 1999]] };
  const v = F.viewFriends(cache, CFG);
  const order = F.prioritize(v, CFG.friendRows, (w) => w.title === "Wish");
  assert.deepEqual(order.slice(0, 4), ["both", "listed", "wish", "ana-top"]);
  assert.equal(order.at(-1), "other"); // an unshared watchlist film is last
  assert.equal(new Set(order).size, order.length);
});

// ── rows ─────────────────────────────────────────────────────────────────────

const rec = (slug, title, year, tt, tmdb = null) => ({ title, year, tmdbId: tmdb, imdbId: tt, t: 1 });
function makeView({ ana = [], bia = [], caio = [], watch = {}, lists = [], films = {}, me = [] }) {
  const cache = F.loadCache("/nonexistent");
  const row = (arr) => arr.map(([slug, rating]) => [slug, films[slug]?.title || slug, films[slug]?.year || 2000, rating]);
  cache.users.ana = { films: row(ana), watchlist: (watch.ana || []).map((s) => [s, films[s]?.title || s, films[s]?.year || 2000]) };
  cache.users.bia = { films: row(bia), watchlist: (watch.bia || []).map((s) => [s, films[s]?.title || s, films[s]?.year || 2000]) };
  cache.users.caio = { films: row(caio), watchlist: (watch.caio || []).map((s) => [s, films[s]?.title || s, films[s]?.year || 2000]) };
  cache.lists["ana/best"] = { items: lists.map((s) => [s, films[s]?.title || s, films[s]?.year || 2000]) };
  cache.films = films;
  cache.me = { slugs: me };
  return F.viewFriends(cache, CFG);
}
const build = (view, extra = {}) =>
  buildFriendRows({ view, cfg: CFG, isSeen: () => false, onMyWatchlist: () => false, ...extra });
const slugsOf = (out, id) => (out.rows[id] || []).map((i) => i.slug);

const FILMS = {
  a: rec("a", "Alpha", 2001, "tt0000001"),
  b: rec("b", "Bravo", 2002, "tt0000002"),
  c: rec("c", "Charlie", 2003, "tt0000003"),
  d: rec("d", "Delta", 2004, "tt0000004"),
  e: rec("e", "Echo", 2005, "tt0000005"),
  noimdb: rec("noimdb", "No IMDb", 2006, null),
};

test("Friends loved: two friends at 4★ or more, or one friend at 4.5★ — nothing else", () => {
  const view = makeView({
    films: FILMS,
    ana: [["a", 4], ["b", 4], ["c", 4.5], ["d", 4], ["e", 3.5]],
    bia: [["a", 4.5], ["b", 3.5], ["d", 2], ["e", 3.5]],
  });
  const out = build(view);
  // a: 4 + 4.5 (two friends) ✔  · b: 4 + 3.5 (only one ≥ 4, not 4.5) ✘ · c: one friend at 4.5 ✔ · d: 4 + 2 ✘ · e ✘
  assert.deepEqual(slugsOf(out, "friends-love").sort(), ["a", "c"]);
});

test("Friends loved: a film the recommendation rule refuses leaves its place to the next one (Marco, 13/10/2026: every row refills what the rule opens)", () => {
  const view = makeView({ films: FILMS, ana: [["a", 5], ["b", 5], ["c", 5]], bia: [] });
  assert.deepEqual(slugsOf(build(view), "friends-love").sort(), ["a", "b", "c"]);
  const out = build(view, { eligible: (tt) => tt !== "tt0000001" });
  assert.deepEqual(slugsOf(out, "friends-love").sort(), ["b", "c"], "Alpha is refused by the rule and is not in the row");
  const small = { ...CFG, sizes: { ...CFG.sizes, friendsDiscover: 2 } };
  assert.equal(buildFriendRows({ view, cfg: small, isSeen: () => false, onMyWatchlist: () => false, eligible: (tt) => tt !== "tt0000001" }).rows["friends-love"].length, 2, "and a cap of two is still filled with two");
});

test("Friends loved: ordered by number of friends × their average; why line lists each friend's stars", () => {
  const view = makeView({
    films: FILMS,
    ana: [["a", 4], ["b", 5], ["c", 4], ["d", 4.5]],
    bia: [["a", 4.5], ["c", 4]],
    caio: [["a", 4], ["c", 4.5]],
  });
  const out = build(view);
  // a: 3 friends × 4.17 = 12.5 · c: 3 × 4.17 = 12.5 · b: 1 × 5 = 5 · d: 1 × 4.5 = 4.5
  assert.deepEqual(slugsOf(out, "friends-love"), ["a", "c", "b", "d"]);
  assert.equal(out.rows["friends-love"][0].why[0], "loved by Bia 4.5★ · Ana 4★ · Caio 4★");
  assert.equal(out.rows["friends-love"][2].why[0], "loved by Ana 5★");
  assert.ok(out.rows["friends-love"].every((i) => /^tt\d+$/.test(i.id)));
});

test("Friends loved: ties broken by your taste (z-score), when the film is in the TMDB cache", () => {
  const view = makeView({ films: FILMS, ana: [["a", 4.5], ["b", 4.5], ["c", 4.5]] });
  const taste = { a: 0.1, b: 2.0, c: null }; // raw model scores; c has no TMDB data → neutral (z = 0)
  const out = build(view, { tasteScore: (r) => taste[r.slug] });
  // z over {a, b}: a = -1, b = +1; c counts as 0, so it lands between them
  assert.deepEqual(slugsOf(out, "friends-love"), ["b", "c", "a"]);
});

test("with no friendRows in config.json the same rules apply (2 friends at 4★ · 1 at 4.5★ · top at 4.5★ · 5 in common)", () => {
  const bare = { ...CFG, friendRows: {} };
  const many = {};
  for (let i = 1; i <= 5; i++) many["m" + i] = rec("m" + i, "Many " + i, 2000 + i, "tt00001" + i);
  const films = { ...FILMS, ...many };
  const view = makeView({
    films,
    ana: [["a", 4], ["b", 4], ["c", 4.5], ["d", 4]],
    bia: [["a", 4.5], ["b", 3.5]],
    watch: { ana: ["m1", "m2", "m3", "m4", "m5"], bia: ["m1", "m2", "m3", "m4"] },
  });
  const out = buildFriendRows({ view, cfg: bare, isSeen: () => false, onMyWatchlist: (r) => r.slug.startsWith("m") });
  assert.deepEqual(slugsOf(out, "friends-love").sort(), ["a", "c"]);
  assert.deepEqual(slugsOf(out, "friends-top-ana"), ["c"]);
  assert.equal(slugsOf(out, "friends-session-ana").length, 5); // exactly 5 in common → own row
  assert.deepEqual(slugsOf(out, "friends-session").sort(), ["m1", "m2", "m3", "m4"]); // Bia has 4 → folded in
  assert.equal(out.meta.find((m) => m.id === "friends-love").name, "👥 Friends loved, you haven't seen");
});

test("a film you have seen never reaches any friends row — matched by TMDB id, by Letterboxd slug and by title ±1 year", () => {
  const films = { ...FILMS, a: { ...FILMS.a, tmdbId: 100 }, b: { ...FILMS.b }, c: { ...FILMS.c }, d: { ...FILMS.d, title: "Delta", year: 2004 } };
  const view = makeView({
    films,
    ana: [["a", 5], ["b", 5], ["c", 5], ["d", 5], ["e", 5]],
    bia: [["a", 5], ["b", 5], ["c", 5], ["d", 5], ["e", 5]],
    watch: { ana: ["a", "b", "c", "d", "e"] }, lists: ["a", "b", "c", "d", "e"],
  });
  const seenIds = new Set([100]);
  const seenSlugs = new Set(["b"]);
  const titleSeen = (t, y) => norm(t) === "delta" && Math.abs(y - 2003) <= 1;
  const isSeen = (r) => seenIds.has(r.tmdbId) || seenSlugs.has(r.slug) || titleSeen(r.title, r.year);
  const out = build(view, { isSeen, onMyWatchlist: () => true });
  for (const id of Object.keys(out.rows)) assert.deepEqual(slugsOf(out, id).filter((s) => ["a", "b", "d"].includes(s)), [], id);
  assert.deepEqual(slugsOf(out, "friends-love").sort(), ["c", "e"]);
  assert.ok(out.stats["friends-love"].droppedSeen >= 3);
});

test("a film without an IMDb id is dropped from every row and counted", () => {
  const view = makeView({
    films: FILMS,
    ana: [["noimdb", 5], ["a", 5]], bia: [["noimdb", 5]],
    watch: { ana: ["noimdb"] }, lists: ["noimdb", "a"],
  });
  const out = build(view, { onMyWatchlist: () => true });
  for (const [id, items] of Object.entries(out.rows)) assert.ok(items.every((i) => i.slug !== "noimdb" && /^tt\d+$/.test(i.id)), id);
  assert.equal(out.noImdb, 1);
});

test("Top picks of a friend: only ≥ 4.5★ from that friend, best rating first, then the most recent (RSS date), then page order", () => {
  const cache = F.loadCache("/nonexistent");
  cache.films = FILMS;
  cache.users.ana = {
    films: [["a", "Alpha", 2001, 4.5], ["b", "Bravo", 2002, 5], ["c", "Charlie", 2003, 4.5], ["d", "Delta", 2004, 4], ["e", "Echo", 2005, 4.5]],
    rss: [["c", "Charlie", 2003, 4.5, "2026-09-01"], ["e", "Echo", 2005, 4.5, "2026-10-01"]],
  };
  cache.users.bia = { films: [] }; cache.users.caio = { films: [] };
  const out = build(F.viewFriends(cache, CFG));
  assert.deepEqual(slugsOf(out, "friends-top-ana"), ["b", "e", "c", "a"]); // 5★ · then 4.5★ by RSS date · then the one without a date
  assert.match(out.rows["friends-top-ana"][1].why[0], /^Ana gave it 4\.5★ \(watched Oct 2026\)$/);
  assert.equal(out.meta.find((m) => m.id === "friends-top-ana").name, "⭐ Ana's top picks");
  assert.equal(out.meta.find((m) => m.id === "friends-top-ana").word, "Top · Ana");
});

test("Watch together: a friend with 5 or more films in common gets a row; fewer are merged into one row with the friend's name", () => {
  const many = {};
  for (let i = 1; i <= 6; i++) many["m" + i] = rec("m" + i, "Many " + i, 2000 + i, "tt00001" + i);
  const films = { ...FILMS, ...many };
  const view = makeView({
    films,
    watch: { ana: ["m1", "m2", "m3", "m4", "m5", "m6", "a"], bia: ["a", "b"], caio: ["b", "c", "noimdb"] },
  });
  const mine = new Set(["m1", "m2", "m3", "m4", "m5", "m6", "a", "b", "c", "noimdb"]);
  const out = build(view, { onMyWatchlist: (r) => mine.has(r.slug) });
  assert.equal(slugsOf(out, "friends-session-ana").length, 7);
  assert.equal(out.meta.find((m) => m.id === "friends-session-ana").name, "🎟️ Watch together with Ana");
  assert.equal(out.meta.find((m) => m.id === "friends-session-ana").word, "Watch together · Ana");
  assert.ok(!out.rows["friends-session-bia"] && !out.rows["friends-session-caio"]);
  const merged = out.rows["friends-session"];
  assert.deepEqual(merged.map((i) => i.slug).sort(), ["a", "b", "c"]);
  assert.equal(merged.find((i) => i.slug === "b").why[0], "on your watchlist and Bia's, Caio's");
  assert.equal(merged.find((i) => i.slug === "a").why[0], "on your watchlist and Bia's"); // Ana has her own row; the merged row names only the others
  assert.equal(merged[0].slug, "b"); // two friends first
  assert.equal(out.meta.find((m) => m.id === "friends-session").name, "🎟️ Watch together");
});

test("Watch together: films that are only on the friend's watchlist (not yours) stay out", () => {
  const view = makeView({ films: FILMS, watch: { ana: ["a", "b"] } });
  const out = build(view, { onMyWatchlist: (r) => r.slug === "a" });
  assert.deepEqual(slugsOf(out, "friends-session"), ["a"]);
});

test("Friend list: the owner's order is kept, the seen films leave, '#N' still shows the original position", () => {
  const view = makeView({ films: FILMS, lists: ["e", "d", "c", "b", "a"] });
  const out = build(view, { isSeen: (r) => r.slug === "d" });
  assert.deepEqual(slugsOf(out, "friends-list-ana-best"), ["e", "c", "b", "a"]);
  assert.equal(out.rows["friends-list-ana-best"][1].why[0], "#3 in “Best of Ana” by Ana");
  assert.equal(out.meta.find((m) => m.id === "friends-list-ana-best").word, "Best of Ana (Ana)");
  assert.equal(out.meta.find((m) => m.id === "friends-list-ana-best").name, "📂 Best of Ana (Ana)");
});

test("two Letterboxd pages that point to one IMDb id show up once", () => {
  const films = { a: rec("a", "Alpha", 2001, "tt0000001"), a2: rec("a2", "Alpha (cut)", 2001, "tt0000001") };
  const out = build(makeView({ films, lists: ["a", "a2"] }));
  assert.deepEqual(slugsOf(out, "friends-list-ana-best"), ["a"]);
});

test("rows are capped at the configured size and empty rows are not published", () => {
  const films = {};
  const list = [];
  for (let i = 0; i < 70; i++) { films["f" + i] = rec("f" + i, "Film " + i, 2000, "tt" + String(2000000 + i)); list.push("f" + i); }
  const out = build(makeView({ films, lists: list }));
  assert.equal(out.rows["friends-list-ana-best"].length, 60);
  assert.ok(!out.rows["friends-love"]);
  assert.ok(!out.meta.some((m) => m.id === "friends-love"));
});

// ── the guard ────────────────────────────────────────────────────────────────

const GUARD = { seenIds: new Set([555]), titleSeen: (t, y) => norm(t) === "parasite" && Math.abs(y - 2019) <= 1, seenSlugs: new Set(["seen-slug"]) };

test("guard: a seen film planted in a friends row is refused (by TMDB id, by title, by slug)", () => {
  const item = (o) => ({ id: "tt0000001", tmdb: null, slug: null, title: "Unseen", year: 2000, ...o });
  assert.deepEqual(findLeaks({ "friends-love": [item({})] }, GUARD), []);
  assert.equal(findLeaks({ "friends-love": [item({ tmdb: 555 })] }, GUARD).length, 1);
  assert.equal(findLeaks({ "friends-top-ana": [item({ title: "Parasite", year: 2019 })] }, GUARD).length, 1);
  assert.equal(findLeaks({ "friends-list-x": [item({ slug: "seen-slug" })] }, GUARD).length, 1);
  assert.match(findLeaks({ "friends-love": [item({ tmdb: 555, title: "Planted" })] }, GUARD)[0], /Planted .* in friends-love/);
});

test("guard: 'Old friends' may hold seen films; any row holding an item without a tt id is refused", () => {
  const seen = { id: "tt0000002", tmdb: 555, title: "Whatever", year: 1999 };
  assert.deepEqual(findLeaks({ oldfriends: [seen] }, GUARD), []);
  assert.equal(findLeaks({ lift: [seen] }, GUARD).length, 1);
  assert.match(findLeaks({ "friends-love": [{ id: null, tmdb: 1, title: "No tt", year: 2000 }] }, GUARD)[0], /no IMDb id/);
  assert.match(findLeaks({ "friends-love": [{ id: "tmdb:12", tmdb: 12, title: "Wrong id", year: 2000 }] }, GUARD)[0], /no IMDb id/);
});

// ── publishing ───────────────────────────────────────────────────────────────

test("publish: every Board row and every Discover option gets a file; Discover is not capped, the Board is", () => {
  const { publish } = require("../lib/publish");
  const { buildPlan } = require("../lib/plan");
  const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "mood-pub-"));
  try {
    const items = (n) => Array.from({ length: n }, (_, i) => ({ id: "tt" + (1000000 + i), tmdb: null, title: "T" + i, year: 2000, why: ["Ana 5★"], genres: [] }));
    const friendOut = {
      rows: { "friends-love": items(60), "friends-session-ana": items(3) },
      meta: [{ id: "friends-love", name: "👥 Friends loved, you haven't seen", word: "Loved", kind: "love" }, { id: "friends-session-ana", name: "🎟️ Watch together with Ana", word: "Watch together · Ana", kind: "session" }],
    };
    const rows = { tonight: [], because: [], lift: items(5), directors: [], watchlist: [], oldfriends: [] };
    const plan = buildPlan({ moods: [{ id: "lift", name: "Lift", word: "Uplift" }], rows, extra: { fromlists: [], short: [], newforyou: [], "friends-week": [] }, friendOut, sizes: { row: 30, friends: 30 } });
    publish({ outDir: out, webDir: path.join(ROOT, "web"), cfg: { addon: { id: "x", version: "1", name: "n", description: "d" } }, plan, webData: {} });
    const man = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    const read = (rel) => JSON.parse(fs.readFileSync(path.join(out, rel), "utf8")).metas;
    assert.equal(read("catalog/movie/friends-love.json").length, 30); // Board
    assert.equal(read("catalog/movie/friends-love.json")[0].id, "tt1000000");
    assert.match(read("catalog/movie/friends-love.json")[0].poster, /metahub\.space\/poster\/medium\/tt1000000\//); // poster by IMDb id, no token needed
    const friends = man.catalogs.find((c) => c.id === "mood-engine-friends");
    assert.deepEqual(friends.extra[0].options, ["Watch together · Ana"]); // Friends loved is a Board row; Discover Friends holds the rest
    assert.equal(read(`catalog/movie/mood-engine-friends/genre=${encodeURIComponent("Watch together · Ana")}.json`).length, 3);
    assert.equal(read("catalog/movie/mood-engine/genre=Uplift.json").length, 5);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// ── the build itself ─────────────────────────────────────────────────────────

const run = (...args) => spawnSync(process.execPath, ["build.js", ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" } });

test("build --self-test-guard: the build plants films you watched in the plan and the guard refuses them (Board, Discover) but not in the exempt Lists", () => {
  const r = run("--offline", "--skip-friends", "--skip-posters", "--self-test-guard");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /self-test: the guard refused the planted film → .* in friends-love/);
  assert.match(r.stdout, /and in a Discover file, by tmdb · by title · by tt → 3 of 3 refused \(e\.g\. Self-test by TMDB id \(1900\) in mood-engine-lists-unseen\/genre=__self-test__\)/); // --skip-friends has no Letterboxd slugs to plant; the cache-only test in v2.test.js plants by slug too
  assert.match(r.stdout, /let it through in the exempt catalog \(oldfriends, mood-engine-lists\)/);
});

test("build refuses a bad --friends-limit (and its new name --lookup-limit)", () => {
  const r = run("--offline", "--friends-limit", "lots");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--friends-limit needs a number/);
  assert.match(run("--offline", "--lookup-limit", "x").stderr, /--lookup-limit needs a number/);
});

test("build works offline without any TMDB token, and the manifest lists the Board rows in the agreed order, then Discover", () => {
  const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "mood-"));
  try {
    const r = run("--offline", "--skip-friends", "--skip-posters", "--out", out);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Done in \d+s · 0 TMDB calls/);
    const man = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    const ids = man.catalogs.map((c) => c.id);
    assert.deepEqual(ids.slice(0, 3), ["tonight", "watchlist", "fromlists"]);
    assert.deepEqual(ids.slice(-2), ["mood-engine", "mood-engine-directors-loved"], "Loved by directors needs only your ratings and data/directors-loved.json");
    assert.ok(!ids.some((id) => id.startsWith("friends-")), "--skip-friends publishes no friends rows");
    assert.equal(man.version, "2.4.0");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// Marco, 23/10/2026: "world is hell pode cortar". William's list "The World is Hell: Hopeless Cinema"
// (friend-a/the-world-is-hell-hopeless-cinema, 876 films in the Worker's option after PR #79) left `friendLists`.
// Written against: the entry back in config.json (a 15th Friends option, 876 films, and 240 TMDB records asked on the first night).
test("config.json: William's list 'The World is Hell' is no friend list any more; his two other lists stay", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  assert.ok(!cfg.friendLists.some((l) => l.owner === "friend-a" && l.slug === "the-world-is-hell-hopeless-cinema"), "Marco cut this exact list on 23/10/2026");
  assert.ok(cfg.friendLists.length > 0, "other friends' lists remain configured");
  for (const slug of ["hypnotic-movies-shot-in-an-eerie-minor-key", "love-is-a-secret-society"]) {
    assert.ok(cfg.friendLists.some((l) => l.owner === "friend-a" && l.slug === slug), `William keeps ${slug}`);
  }
});

// ── "All friends loved" (Marco, 28/10/2026, Discover proposal 5) ─────────────────────────────────────────────────────────────────────────────────────────
// lib/friends.js allFriendsLoved: who of the WHOLE crowd (the people you follow plus the configured friends) rated a film at the bar or more, among the films you have not seen.
// Written against: the first reading of the proposal that took the 7 people of the menu only (the option would have lost annamendesc, jusodre and luizasodre, who the menu does not list) and the one
// that counted ratings the build ignores (benreiss rates 5 whatever he thinks: 2,741 of his 2,803 films).
function crowdView({ cfgFriends = [{ user: "ana", name: "Ana" }], following = [], users = {}, films = FILMS, ignored = [] }) {
  const cache = F.loadCache("/nonexistent");
  cache.following = { users: following.map((u) => [u, u]) };
  for (const [u, rows] of Object.entries(users)) cache.users[u] = { films: rows.map(([slug, rating]) => [slug, films[slug]?.title || slug, films[slug]?.year || 2000, rating]), watchlist: [] };
  cache.films = films;
  cache.me = { slugs: [] };
  return F.viewFriends(cache, { friends: cfgFriends, ratingsIgnored: { users: ignored } });
}
const loved = (view, extra = {}) => F.allFriendsLoved({ crowd: view.crowd, films: view.films, ...extra });

test("All friends loved: a rating AT the bar counts, 3.5 does not; a film watched without a rating does not; one person is enough", () => {
  const view = crowdView({ users: { ana: [["a", 4], ["b", 3.5], ["c", null], ["d", 5]] } });
  assert.deepEqual(loved(view).sort(), ["tt0000001", "tt0000004"], ">= 4: Alpha (4★ exactly) and Delta (5★), alone, with no second person");
  assert.deepEqual(loved(view, { minStars: 3.5 }).sort(), ["tt0000001", "tt0000002", "tt0000004"], "the bar is the parameter (friendRows.love.minStars)");
  assert.deepEqual(loved(view, { minStars: 4.5 }), ["tt0000004"]);
});

test("All friends loved: the crowd is everyone you follow, not only the configured friends (annamendesc, jusodre and luizasodre are not in the menu)", () => {
  const view = crowdView({ following: ["dora"], users: { ana: [["a", 2]], dora: [["b", 4.5]] } });
  assert.deepEqual(view.users.map((u) => u.user), ["ana"], "control: the menu knows Ana only");
  assert.deepEqual(loved(view), ["tt0000002"], "Dora, who the menu does not list, loved Bravo");
});

test("All friends loved: a person whose ratings are ignored (benreiss) loves nothing, and a film is counted once however many love it", () => {
  const view = crowdView({ following: ["benreiss", "dora"], users: { ana: [["a", 4]], benreiss: [["b", 5], ["c", 5]], dora: [["a", 5], ["c", 4]] }, ignored: ["benreiss"] });
  assert.deepEqual(loved(view).sort(), ["tt0000001", "tt0000003"], "Bravo (only Ben's 5★) is out; Charlie stays through Dora; Alpha, loved by two, is once");
  assert.equal(loved(view).length, 2);
  assert.deepEqual(loved(crowdView({ following: ["benreiss", "dora"], users: { ana: [["a", 4]], benreiss: [["b", 5], ["c", 5]], dora: [["a", 5], ["c", 4]] } })).sort(), ["tt0000001", "tt0000002", "tt0000003"], "control: without the list Bravo is in");
});

test("All friends loved: a film you have seen, one gone, one without an IMDb id and one TMDB knows only as a series stay out", () => {
  const films = { ...FILMS, gone: { ...rec("gone", "Gone", 2000, "tt0000009"), gone: true }, tv: rec("tv", "Series", 2000, "tt0000008", 77) };
  const view = crowdView({ films, users: { ana: [["a", 5], ["b", 5], ["c", 5], ["gone", 5], ["noimdb", 5], ["tv", 5]] } });
  assert.deepEqual(loved(view).sort(), ["tt0000001", "tt0000002", "tt0000003", "tt0000008"], "control: nothing is held back without the guards");
  const seen = (r) => r.slug === "b" || r.imdbId === "tt0000003";
  const unrecorded = ({ imdbId, tmdbId }) => imdbId === "tt0000008" && tmdbId === 77;
  assert.deepEqual(loved(view, { isSeen: seen, unrecorded }), ["tt0000001"], "seen by slug (Bravo) and by IMDb id (Charlie), the series: out");
});

test("config.json (Marco, 28/10/2026): the seven friends in his order, and the option 'All friends loved' with the word and the bar of Friends loved", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  assert.deepEqual(cfg.friends.map((f) => [f.user, f.name]), [
    ["friend-a", "William"], ["friend-b", "friend-b"], ["friend-c", "Gustavo"], ["friend-d", "friend-d"], ["friend-e", "friend-e"], ["friend-f", "Francesca"], ["friend-g", "friend-g"],
  ], "answer (b) of question 4: the three new friends are whole friends (rule, pool, Board), in this order");
  assert.equal(cfg.friendRows.all.word, "All friends loved");
  assert.equal(cfg.friendRows.all.minStars, undefined, "no bar of its own: it is friendRows.love.minStars, 4★");
  assert.equal(cfg.friendRows.love.minStars, 4);
  assert.equal(cfg.friendsMenu, undefined, "the menu is config.friends (the plan's separate friendsMenu was the answer (a), not taken)");
});
