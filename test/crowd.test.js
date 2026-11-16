// node --test            (no dependencies)
// The crowd: everyone you follow (51 people on 10/10/2026). Their history is read through Chrome (whole, or only the recent news: test/films-incremental.test.js), and for every film in a row
// three counters are made over them: seenBy, friendsAvg, wantBy (lib/crowd.js). Also: how the histories are read and kept
// (lib/friends.js readUserFilms, lib/lists.js readCrowd) and how "Friends loved" uses them.

const test = require("node:test");
const assert = require("node:assert/strict");

const F = require("../lib/friends");
const L = require("../lib/lists");
const { crowdIndex, attachRatings, letterboxdAverages, planItems } = require("../lib/crowd");
const { buildFriendRows } = require("../lib/rows");

const noSleep = async () => {};
const person = (user, films = [], watch = [], name = user) => ({
  user, name,
  films: new Map(films.map(([slug, rating, title, year]) => [slug, { slug, rating, title, year }])),
  watchlist: new Map(watch.map((slug) => [slug, { slug, title: slug, year: null }])),
});

// ── the three counters ───────────────────────────────────────────────────────

test("counters: seenBy counts who saw it, friendsAvg averages only those who rated, wantBy counts who saved it and has not seen it", () => {
  const crowd = [
    person("a", [["x", 4]]),
    person("b", [["x", null]]), // saw it, gave no stars: counts as a viewer, never in the average
    person("c", [], ["x"]), // only saved it
    person("d", [["x", 3]], ["x"]), // saw it AND still has it saved: a viewer, once, and not a person who wants it
    person("e", [["y", 5]]),
  ];
  const { find } = crowdIndex({ crowd });
  assert.deepEqual(find({ slug: "x" }), { seenBy: 3, friendsAvg: 3.5, wantBy: 1 });
  assert.deepEqual(find({ slug: "y" }), { seenBy: 1, friendsAvg: 5, wantBy: 0 });
  assert.deepEqual(find({ slug: "nobody" }), { seenBy: 0, friendsAvg: null, wantBy: 0 });
});

test("counters: half a star is a rating (not a missing one), and a film seen by people who all left it unrated has no average", () => {
  const { find } = crowdIndex({ crowd: [person("a", [["x", 0.5]]), person("b", [["x", 1.5]]), person("c", [["z", null]]), person("d", [["z", null]])] });
  assert.deepEqual(find({ slug: "x" }), { seenBy: 2, friendsAvg: 1, wantBy: 0 });
  assert.deepEqual(find({ slug: "z" }), { seenBy: 2, friendsAvg: null, wantBy: 0 });
});

test("counters: a film is found by slug, by the address it redirects to, by IMDb id (any page that was looked up) and by title and exact year — and nobody counts twice", () => {
  const films = { "perfect-days": { imdbId: "tt2", canon: "perfect-days-2023", title: "Perfect Days", year: 2023 }, "perfect-days-2023": { imdbId: "tt2", title: "Perfect Days", year: 2023 } };
  const crowd = [
    person("by-slug", [["perfect-days", 4]]),
    person("by-canon", [["perfect-days-2023", 5]]),
    person("both-pages", [["perfect-days", 3], ["perfect-days-2023", 3]]), // the same person met under both addresses: one person
    person("never-looked-up", [["perfect-days-wim", 2, "Perfect Days", 2023]]), // no film record at all: found by title and year
    person("other-year", [["perfect-days-old", 1, "Perfect Days", 2011]]), // same title, another film
  ];
  const { find } = crowdIndex({ crowd, films });
  assert.deepEqual(find({ id: "tt2", slug: "perfect-days", canon: "perfect-days-2023", title: "Perfect Days", year: 2023 }), { seenBy: 4, friendsAvg: 3.5, wantBy: 0 });
  assert.equal(find({ id: "tt2" }).seenBy, 3); // by IMDb id alone: the three who have a looked-up page
  assert.equal(find({ slug: "perfect-days-2023" }).seenBy, 3); // by the redirect target alone: the one who has the film under its old address counts too
  assert.equal(find({ title: "Perfect Days", year: 2023 }).seenBy, 4); // by title and year alone: all four who saw the 2023 film, including the one never looked up
  assert.equal(find({ title: "Perfect Days", year: 2011 }).seenBy, 1);
  assert.equal(find({ title: "Perfect Days", originalTitle: "Perfect Days", year: 2023 }).seenBy, find({ title: "Perfect Days", year: 2023 }).seenBy);
});

test("counters: a film nobody has a title for is found by its original title; a title without a year is never matched on the title alone", () => {
  const crowd = [person("a", [["x", 4, "Perfect Days", 2023]]), person("b", [["y", 3, "Sin título", null]])];
  const { find } = crowdIndex({ crowd });
  assert.equal(find({ title: "Dias Perfeitos", originalTitle: "Perfect Days", year: 2023 }).seenBy, 1);
  assert.equal(find({ title: "Sin título", year: 2020 }).seenBy, 0);
  assert.equal(find({ title: "Sin título", year: null }).seenBy, 0);
});

test("counters: wantBy by slug, by IMDb id and by title; a person who has the film saved under one page and seen under another counts as a viewer", () => {
  const films = { a1: { imdbId: "tt9", title: "Nine", year: 2009 }, a2: { imdbId: "tt9", title: "Nine", year: 2009 } };
  const crowd = [person("w1", [], ["a1"]), person("w2", [], ["a2"]), person("both", [["a2", 4]], ["a1"])];
  const { find } = crowdIndex({ crowd, films });
  assert.deepEqual(find({ id: "tt9", slug: "a1" }), { seenBy: 1, friendsAvg: 4, wantBy: 2 });
});

// ── the numbers on the plan's items ──────────────────────────────────────────

const plan = () => ({
  board: [{ id: "watchlist", name: "w", items: [{ id: "tt1", slug: "one", title: "One", year: 2000 }, { id: "tt2", slug: "two", title: "Two", year: 2001 }] }],
  discover: [
    { id: "mood-engine-rating", name: "By rating", options: [{ label: "4.0–4.2", items: [{ id: "tt1", slug: "one", title: "One", year: 2000 }] }] },
    { id: "mood-engine", name: "Moods", options: [{ label: "x", items: [{ id: "tt1", title: "One", year: 2000 }] }] },
  ],
});

test("attachRatings: every item gets lb/imdb/friends numbers; the same film has the very same numbers everywhere; 'By rating' shows two decimals", () => {
  const p = plan();
  const { find } = crowdIndex({ crowd: [person("a", [["one", 4]]), person("b", [], ["one", "two"])] });
  const r = attachRatings(p, { find, lb: new Map([["tt1", 4.19]]) });
  assert.deepEqual(r, { films: 2, withCrowd: 2, withLb: 1, byTt: r.byTt });
  const [one, two] = p.board[0].items;
  assert.deepEqual(one.ratings, { lb: 4.19, imdb: null, friendsAvg: 4, seenBy: 1, wantBy: 1 });
  assert.deepEqual(two.ratings, { lb: null, imdb: null, friendsAvg: null, seenBy: 0, wantBy: 1 });
  const rating = p.discover[0].options[0].items[0], mood = p.discover[1].options[0].items[0];
  assert.equal(rating.ratings, one.ratings); // one object per film: setting the IMDb rating once sets it everywhere
  assert.equal(mood.ratings, one.ratings); // even an item with no slug (a TMDB-only row) is found through its IMDb id
  assert.equal(rating.lbDigits, 2);
  assert.equal(one.lbDigits, undefined);
  assert.equal(planItems(p).length, 4);
});

test("letterboxdAverages: tt → the average of a page that was looked up and has one", () => {
  const m = letterboxdAverages({ a: { imdbId: "tt1", r: 4.2 }, b: { imdbId: "tt1", r: 3 }, c: { imdbId: "tt2" }, d: { imdbId: null, r: 4 }, e: null });
  assert.deepEqual([...m], [["tt1", 4.2]]);
});

// ── the crowd in the cache and in the view ───────────────────────────────────

const CFG = { letterboxd: "me", friends: [{ user: "ana", name: "Ana" }, { user: "Bia", name: "Bia" }], friendRows: { love: { minFriends: 2, minStars: 4, soloStars: 4.5 }, top: {}, session: {} } };
function cacheWith(follow, users) {
  const c = F.loadCache("/nonexistent");
  c.following = { user: "me", users: follow };
  c.users = users;
  return c;
}

test("view: the crowd is everyone you follow plus the configured friends, never yourself; a configured friend keeps the configured name; users stays the configured friends", () => {
  const c = cacheWith([["ana", "Ana Display"], ["zed", "Zed"], ["me", "Me"], ["bia", "Bia lower"]], {
    ana: { films: [["x", "X", 2000, 4]], watchlist: [["w", "W", 2001]] },
    zed: { films: [["y", "Y", 2001, 5]], rss: [["y", "Y", 2001, 4.5, "2026-10-09"], ["n", "N", 2020, null, "2026-10-08"]] },
  });
  const v = F.viewFriends(c, CFG);
  assert.deepEqual(v.crowd.map((p) => [p.user, p.name]), [["ana", "Ana"], ["zed", "Zed"], ["Bia", "Bia"]]); // "bia" and "Bia" are one person; "me" is out
  assert.deepEqual(v.users.map((u) => u.user), ["ana", "Bia"]);
  const zed = v.crowd.find((p) => p.user === "zed");
  assert.equal(zed.films.get("y").rating, 4.5); // the newer diary entry wins
  assert.ok(zed.films.has("n")); // a film known only from the diary still counts as seen
  assert.deepEqual([...v.crowd[0].watchlist.keys()], ["w"]);
});

test("prioritize: 'Friends loved' candidates come from the whole crowd, never the ones you have seen, and only the best few hundred are looked up", () => {
  const users = {};
  for (let i = 0; i < 6; i++) users["p" + i] = { films: [["both", "B", 2000, 4.5], [`solo${i}`, "S", 2000, 5], ["seen", "Seen", 2000, 5]] };
  const c = cacheWith(Object.keys(users).map((u) => [u, u]), users);
  c.me = { slugs: ["seen"] };
  const v = F.viewFriends(c, { ...CFG, friends: [] });
  const order = F.prioritize(v, CFG.friendRows, () => false);
  assert.equal(order[0], "both"); // 6 people × 4.5
  assert.ok(!order.includes("seen"), "a film you have seen is not looked up");
  assert.ok(order.includes("solo0")); // 1 person at 5★ (≥ 4.5)
  const capped = F.prioritize(v, { love: { ...CFG.friendRows.love, resolveMax: 3 } }, () => false);
  assert.equal(capped.length, 3);
  assert.equal(capped[0], "both");
});

test("Friends loved reads the whole crowd (2 of 51 at 4★, or 1 at 4.5★); a long list of names is cut after three with '+N more'; the per-friend rows still read only the configured friends", () => {
  const films = { a: { title: "Alpha", year: 2001, imdbId: "tt1" }, b: { title: "Bravo", year: 2002, imdbId: "tt2" }, c: { title: "Charlie", year: 2003, imdbId: "tt3" } };
  const users = { ana: { films: [["c", "Charlie", 2003, 5]] } };
  for (const [i, name] of ["p0", "p1", "p2", "p3", "p4"].entries()) users[name] = { films: [["a", "Alpha", 2001, 4 + (i % 2) * 0.5], ["b", "Bravo", 2002, 3.5]] };
  const c = cacheWith(Object.keys(users).map((u) => [u, u.toUpperCase()]), users);
  c.films = films;
  const view = F.viewFriends(c, CFG);
  const out = buildFriendRows({ view, cfg: CFG, isSeen: () => false, onMyWatchlist: () => false });
  assert.deepEqual(out.rows["friends-love"].map((i) => i.slug), ["a", "c"]); // b: five people but none at 4★; a: five at 4★+; c: one at 5★
  assert.equal(out.rows["friends-love"][0].why[0], "loved by P1 4.5★ · P3 4.5★ · P0 4★ · +2 more");
  assert.equal(out.rows["friends-love"][1].why[0], "loved by Ana 5★");
  assert.deepEqual(out.meta.filter((m) => m.kind === "top").map((m) => m.id), ["friends-top-ana"]); // p1 and p3 have 4.5★ films too, but only the configured friends have a row of their own
});

// ── reading a history ────────────────────────────────────────────────────────

const poster = (slug, rating) => `<li class="griditem"><div data-item-name="${slug} (2000)" data-item-slug="${slug}"><img alt="${slug}"/><span class="rating rated-${rating ? rating * 2 : ""}"></span></div></li>`;
const filmsPage = (rows, { next = null, total = null } = {}) =>
  `<html><body>${total != null ? `<h1 class="section-heading"><span class="tooltip" title="${total}&nbsp;films">Watched</span></h1>` : ""}<ul class="grid">${rows.map(([s, r]) => poster(s, r)).join("")}</ul>${next ? `<a class="next" href="${next}">Older</a>` : ""}</body></html>`;
const serve = (routes) => ({ calls: [], async get(url) { const p = new URL(url).pathname; this.calls.push(p); const r = routes[p]; if (r instanceof Error) throw r; return r == null ? { status: 404, text: "", url } : { status: 200, text: r, url }; } });
const ctx = (extra = {}) => { const problems = []; const guarded = async (what, fn) => { try { return await fn(); } catch (e) { problems.push(`${what}: ${e.message}`); return null; } }; return { problems, guarded, pageGap: { gapMs: 0, sleepImpl: noSleep }, now: Date.parse("2026-10-10T12:00:00Z"), ...extra }; };

test("readUserFilms: every page, with the page's own count; rows are [slug, title, year, rating]; pages and total are kept", async () => {
  const http = serve({ "/u/films/": filmsPage([["a", 4], ["b", null]], { next: "/u/films/page/2/", total: 3 }), "/u/films/page/2/": filmsPage([["c", 5]]) });
  const c = ctx(), u = {};
  const r = await F.readUserFilms({ u, user: "u", http, ...c });
  assert.deepEqual(r, { read: 3, pages: 2, total: 3, partial: false, mode: "full", pagesRead: 2 });
  assert.deepEqual(u.films.map((x) => [x[0], x[3]]), [["a", 4], ["b", null], ["c", 5]]);
  assert.equal(u.filmsPages, 2);
  assert.equal(u.filmsTotal, 3);
  assert.equal(u.filmsPartial, false);
  assert.deepEqual(c.problems, []);
});

test("readUserFilms: a page that fails midway keeps what was read, merged into the cache, marked partial (retried tomorrow); a short read against the page's count is reported", async () => {
  const http = serve({ "/u/films/": filmsPage([["new", 4]], { next: "/u/films/page/2/", total: 100 }), "/u/films/page/2/": new Error("boom") });
  const c = ctx(), u = { films: [["new", "new", 2000, 3], ["old", "old", 2000, 5]] };
  const r = await F.readUserFilms({ u, user: "u", http, ...c });
  assert.equal(r.partial, true);
  assert.deepEqual(u.films.map((x) => x[0]), ["new", "old"]); // fresh first, then the older rows the new read did not reach
  assert.equal(u.films[0][3], 4);
  assert.equal(u.filmsPartial, true);
  assert.ok(F.stale(u.filmsAt, c.now + 25 * 3600e3, true)); // a partial read is not trusted for a day
  assert.ok(!F.stale(u.filmsAt, c.now + 10 * 3600e3, true));
  const short = ctx(), v = {};
  await F.readUserFilms({ u: v, user: "u", http: serve({ "/u/films/": filmsPage([["a", 4]], { total: 100 }) }), ...short });
  assert.match(short.problems[0], /read 1 films but the page says 100/);
});

test("readUserFilms: a page that shows a count but none of its films is a layout change — nothing is stored over the cache; an empty profile is remembered, not asked again tonight", async () => {
  const c = ctx(), u = { films: [["a", "a", 2000, 4]], filmsAt: "2026-01-01T00:00:00.000Z" };
  await F.readUserFilms({ u, user: "u", http: serve({ "/u/films/": filmsPage([], { total: 40 }) }), ...c });
  assert.deepEqual(u.films.map((x) => x[0]), ["a"]);
  assert.equal(u.filmsAt, "2026-01-01T00:00:00.000Z");
  assert.match(c.problems[0], /says 40 films but none could be read/);
  const e = {}, c2 = ctx();
  await F.readUserFilms({ u: e, user: "empty", http: serve({ "/empty/films/": filmsPage([]) }), ...c2 });
  assert.deepEqual(e.films, []);
  assert.ok(e.filmsAt);
  assert.deepEqual(c2.problems, []);
});

test("readUserFilms: a failure on the first page is reported and changes nothing", async () => {
  const c = ctx(), u = { films: [["a", "a", 2000, 4]] };
  const r = await F.readUserFilms({ u, user: "u", http: serve({ "/u/films/": new Error("blocked") }), ...c });
  assert.equal(r, null);
  assert.equal(u.films.length, 1);
  assert.match(c.problems[0], /u\/films: blocked/);
});

// ── reading the crowd ────────────────────────────────────────────────────────

const NOW = Date.parse("2026-10-10T12:00:00Z");
const people = [{ user: "ana", name: "Ana", configured: true }, { user: "p1", name: "P1", configured: false }, { user: "p2", name: "P2", configured: false }, { user: "p3", name: "P3", configured: false }];
const wl = (rows, next) => `<html><body><ul class="grid">${rows.map((s) => poster(s)).join("")}</ul>${next ? `<a class="next" href="${next}">Older</a>` : ""}</body></html>`;
const siteFor = (users) => {
  const routes = {};
  for (const u of users) { routes[`/${u}/films/`] = filmsPage([[`${u}-f`, 4]], { total: 1 }); routes[`/${u}/watchlist/`] = wl([`${u}-w`]); }
  return routes;
};

test("readCrowd: reads the history and the watchlist of each person who is not a configured friend, saving after each one; 2 at a time", async () => {
  const http = serve(siteFor(["p1", "p2", "p3", "ana"]));
  const cache = F.loadCache("/nonexistent"), saves = [];
  const c = ctx();
  const r = await L.readCrowd({ cfg: CFG, cache, people, http, ...c, force: false, save: () => saves.push(Object.keys(cache.users).length) });
  assert.deepEqual(r, { people: 3, filmsRead: 3, filmsPagesRead: 3, filmsFull: 3, filmsIncremental: 0, watchlistsRead: 3, fresh: 0, failed: [], privateWatchlists: [] });
  assert.ok(!http.calls.some((p) => p.startsWith("/ana/")), "a configured friend is read with the friends, not here");
  assert.deepEqual(cache.users.p2.films.map((x) => x[0]), ["p2-f"]);
  assert.deepEqual(cache.users.p2.watchlist.map((x) => x[0]), ["p2-w"]);
  assert.equal(cache.users.p2.name, "P2");
  assert.equal(saves.length, 3);
});

test("readCrowd: a person read this week is not read again; a stale or partial one is; --friends-refresh reads everyone; a failure on one person does not stop the others", async () => {
  const http = serve({ ...siteFor(["p1", "p2", "p3"]), "/p2/films/": new Error("down") });
  const cache = F.loadCache("/nonexistent");
  const iso = (ms) => new Date(NOW - ms).toISOString();
  cache.users.p1 = { films: [["old", "old", 2000, 4]], filmsAt: iso(2 * 864e5), watchlist: [], watchlistAt: iso(2 * 864e5) }; // 2 days old: fresh
  cache.users.p3 = { films: [["old", "old", 2000, 4]], filmsAt: iso(2 * 864e5), filmsPartial: true, watchlist: [], watchlistAt: iso(8 * 864e5) }; // a partial read, and a watchlist over a week old
  const c = ctx({ now: NOW });
  const r = await L.readCrowd({ cfg: CFG, cache, people, http, ...c, force: false });
  assert.equal(r.fresh, 1); // p1
  assert.deepEqual(r.failed, ["p2"]);
  assert.ok(!http.calls.includes("/p1/films/") && !http.calls.includes("/p1/watchlist/"));
  assert.ok(http.calls.includes("/p3/films/") && http.calls.includes("/p3/watchlist/"));
  assert.ok(c.problems.some((p) => /p2\/films: down/.test(p)));
  const again = serve(siteFor(["p1", "p2", "p3"]));
  await L.readCrowd({ cfg: CFG, cache, people, http: again, ...ctx({ now: NOW }), force: true });
  assert.ok(again.calls.includes("/p1/films/"));
});

test("readCrowd: the 7-day TTL has a margin, so last week's read does not skip a day; --crowd-limit reads only the first few", async () => {
  const http = serve(siteFor(["p1", "p2", "p3"]));
  const cache = F.loadCache("/nonexistent");
  const justUnder = new Date(NOW - 7 * 864e5 + 10 * 60e3).toISOString(); // 6 days 23 h 50 min ago
  cache.users.p1 = { films: [], filmsAt: justUnder, watchlist: [], watchlistAt: justUnder };
  const r = await L.readCrowd({ cfg: CFG, cache, people, http, ...ctx({ now: NOW }), force: false, limit: 2 });
  assert.equal(r.people, 2);
  assert.equal(r.fresh, 0); // p1 is "about 7 days old": read again
  assert.ok(http.calls.includes("/p1/films/") && http.calls.includes("/p2/films/") && !http.calls.includes("/p3/films/"));
});

test("the configured friends' pages use the same margin: a read 6 days 23 h 50 min ago is stale, one from 6 days ago is not", () => {
  const now = NOW;
  assert.equal(F.stale(new Date(now - 7 * 864e5 + 10 * 60e3).toISOString(), now), true);
  assert.equal(F.stale(new Date(now - 6 * 864e5).toISOString(), now), false);
  assert.equal(F.stale(null, now), true);
});

test("crowdStats: per person — pages, films, rated, with an IMDb id, dropped, not looked up, watchlist", () => {
  const c = cacheWith([["p1", "P1"]], { p1: { films: [["a", "a", 2000, 4], ["b", "b", 2000, null], ["c", "c", 2000, 3], ["d", "d", 2000, 5]], filmsPages: 2, filmsTotal: 4, filmsAt: "2026-10-10T00:00:00.000Z", watchlist: [["w", "w", 2000]] } });
  c.films = { a: { imdbId: "tt1" }, b: { imdbId: null }, c: { gone: true, imdbId: null } };
  const [s] = F.crowdStats(F.viewFriends(c, { letterboxd: "me", friends: [] }), c);
  assert.deepEqual(s, { user: "p1", name: "P1", pages: 2, read: 4, total: 4, rated: 3, withTt: 1, dropped: 2, pending: 1, watchlist: 1, fetchedAt: "2026-10-10T00:00:00.000Z", partial: false });
});

// ── a private watchlist, and a real challenge on a list ──────────────────────

const forbidden = (url) => ({ status: 403, url, text: async () => "<html><head><title>Letterboxd - Forbidden</title></head><body>You do not have permission</body></html>" });
const challenge = (url) => ({ status: 403, url, text: async () => "<html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>" });

test("a private watchlist (Letterboxd's own 'Forbidden' page) is an answer: absent, no retry, no problem, and it does not count toward the three refusals that stop the run", async () => {
  let asks = 0;
  const http = F.makeHttp({ fetchImpl: async (url) => { asks++; return /private/.test(url) ? forbidden(url) : { status: 200, ok: true, url, text: async () => "<html>ok</html>" }; }, sleepImpl: noSleep });
  for (const u of ["private", "private", "private", "private"]) { const r = await http.get(`https://letterboxd.com/${u}/watchlist/`); assert.equal(r.status, 404); assert.equal(r.forbidden, true); }
  assert.equal(asks, 4, "each was asked once: a Forbidden page is not retried");
  assert.equal((await http.get("https://letterboxd.com/film/x/")).status, 200); // the breaker is not open
  const c = ctx(), u = {};
  const read = await F.readUserWatchlist({ u, user: "private", http, ...c });
  assert.equal(read.missing, true);
  assert.deepEqual(u.watchlist, []);
  assert.equal(u.watchlistPrivate, true);
  assert.deepEqual(c.problems, []);
});

test("a Cloudflare challenge on a watchlist is still a block (retried once, then BlockedError); through the router, Chrome gets one go at a watchlist or list HTTP was refused on", async () => {
  const http = F.makeHttp({ fetchImpl: async (url) => challenge(url), sleepImpl: noSleep });
  await assert.rejects(http.get("https://letterboxd.com/a/watchlist/"), (e) => e instanceof F.BlockedError);
  const { routed } = require("../lib/fetch-chrome");
  const seen = [];
  const blocked = { get: async (u) => { seen.push(["http", u]); throw new F.BlockedError(u); } };
  const chrome = { get: async (u) => { seen.push(["chrome", u]); return { status: 200, text: "<html></html>", url: u }; } };
  const r = routed({ http: blocked, chrome });
  assert.equal((await r.get("https://letterboxd.com/a/watchlist/page/2/")).status, 200);
  assert.equal((await r.get("https://letterboxd.com/a/list/best/")).status, 200);
  await assert.rejects(r.get("https://letterboxd.com/film/x/"), (e) => e instanceof F.BlockedError); // a film page is not retried through Chrome
  await assert.rejects(r.get("https://letterboxd.com/a/rss/"), (e) => e instanceof F.BlockedError);
  assert.deepEqual(seen.map((s) => s[0]), ["http", "chrome", "http", "chrome", "http", "http"]);
});

test("readCrowd: a person whose watchlist is private is named, not counted as a failure", async () => {
  const routes = siteFor(["p1", "p2"]);
  const http = { calls: [], async get(url) { const p = new URL(url).pathname; this.calls.push(p); if (p === "/p2/watchlist/") return { status: 404, text: "", url, forbidden: true }; const r = routes[p]; return r == null ? { status: 404, text: "", url } : { status: 200, text: r, url }; } };
  const r = await L.readCrowd({ cfg: CFG, cache: F.loadCache("/nonexistent"), people: people.slice(1, 3), http, ...ctx(), force: false });
  assert.deepEqual(r.privateWatchlists, ["p2"]);
  assert.deepEqual(r.failed, []);
});

test("attachRatings: a film that only a v2 Board row carries gets its shared ratings object (covers, the v2 family) but is NOT in byTt, what the legacy index consults; a film in both is (legacy parity, 14/10/2026)", () => {
  const p = plan();
  p.board2 = [{ id: "friends-split", items: [{ id: "tt1172049", slug: "demolition", title: "Demolition", year: 2015 }, { id: "tt1", slug: "one", title: "One", year: 2000 }] }];
  const { find } = crowdIndex({ crowd: [person("a", [["one", 4], ["demolition", 3]])] });
  const r = attachRatings(p, { find, lb: new Map([["tt1", 4.19], ["tt1172049", 3.2]]) });
  const [demolition, oneInV2] = p.board2[0].items;
  assert.deepEqual(demolition.ratings, { lb: 3.2, imdb: null, friendsAvg: 3, seenBy: 1, wantBy: 0 }, "the v2-only film has its real numbers: the crowd found it and the Letterboxd average is there (build.js imdbStep fills imdb later)");
  assert.equal(r.byTt.has("tt1172049"), false, "but the legacy export never sees it through the Board");
  assert.equal(r.byTt.get("tt1"), p.board[0].items[0].ratings, "a film the legacy plan holds too is in byTt");
  assert.equal(oneInV2.ratings, p.board[0].items[0].ratings, "and shares the one object with its legacy items");
  assert.deepEqual({ films: r.films, withLb: r.withLb, withCrowd: r.withCrowd }, { films: 2, withLb: 1, withCrowd: 1 }, "films and the two counters are on the legacy basis: Demolition is not counted");
});
