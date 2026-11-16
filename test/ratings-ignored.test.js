// node --test
// Marco, 22/10/2026 ~04:55 UTC: "take a friend out of the ratings, he only either doesnt vote or gives 5 if he likes it with no discrimination".
// config.json `ratingsIgnored.users` names Letterboxd accounts whose RATINGS are not used anywhere a rating of someone you follow is used (average, Friends loved,
// Friends can't agree, a person's top picks, the floor, the order of the lookups, the stars on the week's rows). What they SAW and WANT still counts.
// The rule lives in lib/friends.js userView (read through viewFriends and userReader) and, for the diary read straight from the cache, lib/lists.js watchedThisWeek.
//
// A small world: `ben` (followed, ignored; 5★ on everything he rates, or no rating), `ana` (a configured friend) and `bia` (followed). Every test has its
// CONTROL: the same world without the list, where Ben counts (a test that passes without the rule proves nothing).
//   written 22/10/2026 for the first version of the rule. Measured on the committed caches of 22/10/2026 (cache/friends.json sha256 cc57c36b79ba…): benreiss has 2,803
//   films, 2,741 at 5★, 7 at 4★, 55 without a rating; he is followed and not in config.json friends.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const F = require("../lib/friends");
const L = require("../lib/lists");
const Q = require("../lib/recommendation-quality");
const P = require("../lib/pool");
const SR = require("../lib/special-rows");
const { crowdIndex } = require("../lib/crowd");
const { buildFriendRows } = require("../lib/rows");
const { learn } = require("../lib/taste");

const ROOT = path.join(__dirname, "..");
const TODAY = "2026-10-22";
const tt = (n) => `tt${String(9000000 + n)}`;
const film = (n, title, r) => [`f${n}`, { title, year: 2000 + n, imdbId: tt(n), r }];

/** The small world. Films: f1 (a), f2 (b), f3 (c), f4 (d), f5 (s: split), f6 (low: Letterboxd 3.0), f7 (g: 3.0), f8 (only Ben), f9 / f10 (diary this week), f11 (watchlist), f12 (in Ben's diary only, an old log: not on his /films/ page). */
function world() {
  const c = F.loadCache("/nonexistent");
  c.following = { user: "me", users: [["ben", "a friend"], ["ana", "Ana"], ["bia", "Bia"]] };
  c.films = Object.fromEntries([film(1, "Alpha", 4.2), film(2, "Bravo", 4.1), film(3, "Charlie", 4.0), film(4, "Delta", 4.0), film(5, "Echo", 3.9), film(6, "Foxtrot", 3.0), film(7, "Golf", 3.0), film(8, "Hotel", 4.0), film(9, "India", 4.0), film(10, "Juliet", 4.0), film(11, "Kilo", 4.0), film(12, "Lima", 4.0)]);
  const row = (n, rating) => [`f${n}`, c.films[`f${n}`].title, c.films[`f${n}`].year, rating];
  c.users = {
    ben: {
      name: "a friend",
      films: [row(1, 5), row(2, 5), row(3, 5), row(4, 5), row(5, 5), row(6, 5), row(8, 5), row(9, null)],
      watchlist: [["f11", "Kilo", 2011]],
      rss: [["f9", "India", 2009, 5, "2026-10-20"], ["f12", "Lima", 2012, 5, "2026-09-01"]],
    },
    ana: { name: "Ana", films: [row(1, 4), row(2, 2), row(3, 4.5), row(5, 1), row(7, 3.5)], watchlist: [["f11", "Kilo", 2011]], rss: [["f10", "Juliet", 2010, 4, "2026-10-21"]] },
    bia: { name: "Bia", films: [row(1, 3), row(4, 4), row(5, 1)], watchlist: [] },
  };
  return c;
}
const BASE = { letterboxd: "me", friends: [{ user: "ana", name: "Ana" }], friendRows: { love: { minFriends: 2, minStars: 4, soloStars: 4.5 }, top: {}, session: {} } };
const WITH = { ...BASE, ratingsIgnored: { users: ["BEN"] } }; // written in capitals: the match ignores case
/** The same world with his account written with a capital in the cache and in /following/ (the list says "ben"). */
function shoutingWorld() { const c = world(); c.users.Ben = c.users.ben; delete c.users.ben; c.following.users[0][0] = "Ben"; return c; }
const find = (view, n) => crowdIndex({ crowd: view.crowd, films: view.films }).find({ id: tt(n), slug: `f${n}` });

test("ratingsIgnoredSet: no key is nobody, names are matched without case, anything else than a list of names stops the build", () => {
  assert.equal(F.ratingsIgnoredSet({}).size, 0);
  assert.equal(F.ratingsIgnoredSet({ ratingsIgnored: {} }).size, 0);
  assert.deepEqual([...F.ratingsIgnoredSet({ ratingsIgnored: { users: ["BenReiss", " ANA "] } })], ["benreiss", "ana"]);
  for (const bad of ["benreiss", { benreiss: true }, [""], [5], [null], ["ok", "  "]]) assert.throws(() => F.ratingsIgnoredSet({ ratingsIgnored: { users: bad } }), /ratingsIgnored\.users/);
  assert.throws(() => F.viewFriends(world(), { ...BASE, ratingsIgnored: { users: "ben" } }), /ratingsIgnored\.users/, "viewFriends refuses it too: a typo must not put his 5★ back quietly");
});

test("userView: every rating of an ignored person reads null (the /films/ page and the diary); what he saw, the diary date and the watchlist stay; the cache keeps the real ratings", () => {
  const c = world();
  const v = F.viewFriends(c, WITH).crowd.find((p) => p.user === "ben");
  assert.equal(v.ratingsIgnored, true);
  assert.deepEqual([...v.films.values()].map((f) => f.rating), Array(v.films.size).fill(null));
  assert.equal(v.films.size, 9, "the 9 films he saw are all still there (8 on his /films/ page, f12 only in his diary)");
  assert.equal(v.films.get("f9").watched, "2026-10-20", "the diary date stays: Friends watched this week still sees him");
  assert.deepEqual([...v.watchlist.keys()], ["f11"]);
  assert.equal(c.users.ben.films[0][3], 5, "cache/friends.json is not touched: taking the name off the list gives the stars back");
  // control: without the list his 5★ are read as before
  const control = F.viewFriends(world(), BASE).crowd.find((p) => p.user === "ben");
  assert.equal(control.ratingsIgnored, false);
  assert.equal(control.films.get("f1").rating, 5);
  assert.equal(control.films.get("f9").rating, 5, "the diary rating, control");
  assert.equal(control.films.get("f12").rating, 5, "a film known only from the diary, control");
  assert.equal(v.films.get("f12").rating, null, "a film known only from the diary has no stars either");
  // the others are read as before
  const ana = F.viewFriends(c, WITH).crowd.find((p) => p.user === "ana");
  assert.equal(ana.ratingsIgnored, false);
  assert.equal(ana.films.get("f1").rating, 4);
});

test("average of the people you follow: his 5★ is not in friendsAvg, he still counts in seenBy and his watchlist in wantBy", () => {
  const view = F.viewFriends(world(), WITH), control = F.viewFriends(world(), BASE);
  assert.deepEqual(find(view, 1), { seenBy: 3, friendsAvg: 3.5, wantBy: 0 }, "Alpha: Ana 4 and Bia 3; Ben saw it");
  assert.deepEqual(find(control, 1), { seenBy: 3, friendsAvg: 4, wantBy: 0 }, "control: (5 + 4 + 3) / 3");
  assert.deepEqual(find(view, 8), { seenBy: 1, friendsAvg: null, wantBy: 0 }, "Hotel: only Ben rated it: no average at all, but one person saw it");
  assert.equal(find(control, 8).friendsAvg, 5);
  assert.deepEqual(find(view, 11), { seenBy: 0, friendsAvg: null, wantBy: 2 }, "Kilo: Ben's and Ana's watchlists still count");
  assert.equal(find(view, 9).seenBy, 1, "seen without a rating still counts as seen");
});

test("Friends loved: his 5★ neither makes a film 'loved' nor is named on the line", () => {
  const out = (cfg) => buildFriendRows({ view: F.viewFriends(world(), cfg), cfg, isSeen: () => false, onMyWatchlist: () => false });
  const control = out(BASE), ignored = out(WITH);
  assert.deepEqual(control.rows["friends-love"].map((i) => i.slug).sort(), ["f1", "f12", "f2", "f3", "f4", "f5", "f6", "f8", "f9"], "control: every film he rated (5★ alone is enough; f9 and f12 from his diary), whatever the others thought");
  assert.match(control.rows["friends-love"].find((i) => i.slug === "f3").why[0], /a friend 5★/);
  assert.deepEqual(ignored.rows["friends-love"].map((i) => i.slug), ["f3"], "only Ana's 4.5★ (one person at 4.5★ or more) is left");
  assert.equal(ignored.rows["friends-love"][0].why[0], "loved by Ana 4.5★");
});

test("the order in which films are looked up on Letterboxd does not rush a film only he rated", () => {
  const order = (cfg) => F.prioritize(F.viewFriends(world(), cfg), cfg.friendRows, () => false);
  assert.ok(order(BASE).includes("f8"), "control: a solo 5★ is a 'Friends loved' candidate");
  assert.ok(!order(WITH).includes("f8"), "ignored: nobody else rated it, so it is not in the head, and he is not a configured friend, so not in the rest either");
});

test("the 3.5 floor: a configured friend whose ratings are ignored opens nothing; another configured friend still does", () => {
  // his account is written with a capital in config.json friends and in the cache, the list in lower case: the match is without case
  const shouting = shoutingWorld;
  const cfg = (extra) => ({ ...BASE, friends: [{ user: "ana", name: "Ana" }, { user: "Ben", name: "a friend" }], ...extra });
  const open = (view) => Q.index(view);
  const control = open(F.viewFriends(shouting(), cfg({}))), ignored = open(F.viewFriends(shouting(), cfg({ ratingsIgnored: { users: ["ben"] } })));
  assert.equal(control.get(tt(6)).fr, 5);
  assert.ok(Q.qualifies(control.get(tt(6))), "control: Foxtrot (Letterboxd 3.0) passes on his 5★");
  assert.equal(ignored.get(tt(6)).fr, null);
  assert.ok(!Q.qualifies(ignored.get(tt(6))), "ignored: it does not");
  assert.equal(ignored.get(tt(7)).fr, 3.5);
  assert.ok(Q.qualifies(ignored.get(tt(7))), "Golf (3.0) still passes on Ana's 3.5");
  assert.equal(ignored.get(tt(7)).friend, "Ana");
  // today's config: he is not a configured friend, so the floor never read his ratings (measured 22/10/2026: 0 entries named him)
  const today = open(F.viewFriends(world(), BASE));
  assert.ok(![...today.values()].some((e) => e.friend === "a friend"));
});

test("🆚 Friends can't agree: three ratings are needed, and his 5★ is not one of them", () => {
  const ctxFor = (cfg, cache = world()) => {
    const view = F.viewFriends(cache, cfg);
    return { today: TODAY, sizes: { row: 50, discover: 100 }, view, recs: [], cands: [], rated: [], seenDirectors: new Set(), lb: () => 4, awards: {}, isSeen: () => false, detail: () => null, allowed: () => true, model: learn([]), favourites: null, userOf: F.userReader(cache, cfg), watched: () => new Map(), tmdbOfImdb: () => null };
  };
  const spec = SR.DEFAULT_ROWS.find((r) => r.id === "friends-split");
  const control = SR.build(ctxFor(BASE), [spec]).rows["friends-split"], ignored = SR.build(ctxFor(WITH), [spec]).rows["friends-split"];
  assert.deepEqual(control.map((i) => i.id), [tt(5)], "control: Echo, Ben 5★ against Ana 1★ and Bia 1★ (σ 1.89)");
  assert.deepEqual(ignored, [], "ignored: two ratings of 1★ are left, under the three needed");
});

test("⭐ top picks of a person: an ignored person has none (his 5★ is the whole list), by the crowd and by the cache reader", () => {
  const spec = { ...SR.DEFAULT_ROWS.find((r) => r.id === "top-picks"), people: ["ben"] };
  const ctxFor = (cfg, crowdWithBen) => {
    const cache = world(), view = F.viewFriends(cache, cfg);
    if (!crowdWithBen) view.crowd = view.crowd.filter((p) => p.user !== "ben"); // the partial /following/ list lacks him: the row reads cache.users through userOf
    return { today: TODAY, sizes: { row: 50, discover: 100 }, view, recs: [], cands: [], rated: [], seenDirectors: new Set(), lb: () => 4, awards: {}, isSeen: () => false, detail: () => null, allowed: () => true, model: learn([]), favourites: null, userOf: F.userReader(cache, cfg), watched: () => new Map(), tmdbOfImdb: () => null };
  };
  for (const crowdWithBen of [true, false]) {
    const control = SR.build(ctxFor(BASE, crowdWithBen), [spec]).rows["top-picks"], ignored = SR.build(ctxFor(WITH, crowdWithBen), [spec]).rows["top-picks"];
    assert.ok(control.length >= 5, `control (${crowdWithBen ? "in the crowd" : "through userOf"}): his 5★ films are the row`);
    assert.match(control[0].why[0], /a friend 5★/);
    assert.deepEqual(ignored, [], `ignored (${crowdWithBen ? "in the crowd" : "through userOf"})`);
  }
  assert.equal(F.userReader(world(), WITH)("nobody"), null);
  assert.equal(F.userReader(null, WITH)("ben"), null);
});

test("what he SAW and WANTS still counts in the activity rows: Friends watched this week/month and Friends want to see this too", () => {
  const cache = world();
  const weekFor = (cfg) => {
    const { people } = L.choosePeople({ cfg, cache });
    const week = L.watchedThisWeek({ cache, people, today: TODAY, days: 7 });
    return P.weekRow({ week, view: F.viewFriends(cache, cfg), isSeen: () => false, size: 10 });
  };
  const control = weekFor(BASE), ignored = weekFor(WITH);
  assert.deepEqual(control.items.map((i) => i.slug), ["f9", "f10"], "control: his 5★ puts India first");
  assert.equal(control.items[0].why[0], "watched this week by a friend 5★");
  assert.deepEqual(ignored.items.map((i) => i.slug), ["f10", "f9"], "ignored: unrated people count as 3.0 for the order, so Juliet (Ana 4★) leads");
  assert.equal(ignored.items[1].why[0], "watched this week by a friend", "he is still named, with no stars");
  assert.equal(ignored.stats.films, 2);
  // 🤝 on Marco's watchlist and on theirs
  const ctxFor = (cfg) => {
    const view = F.viewFriends(cache, cfg);
    return { today: TODAY, sizes: { row: 50, discover: 100 }, view, recs: [{ id: tt(11), imdbId: tt(11), slug: "f11", title: "Kilo", year: 2011, rank: 1, tags: { watchlist: true, lists: new Map() } }], cands: [], rated: [], seenDirectors: new Set(), lb: () => 4, awards: {}, isSeen: () => false, detail: () => null, allowed: () => true, model: learn([]), favourites: null, userOf: F.userReader(cache, cfg), watched: () => new Map(), tmdbOfImdb: () => null };
  };
  const want = SR.build(ctxFor(WITH), [{ ...SR.DEFAULT_ROWS.find((r) => r.id === "friends-watchlist"), minPeople: 2 }]).rows["friends-watchlist"];
  assert.equal(want.length, 1);
  assert.equal(want[0].why[0], "on the watchlist of Ana and a friend", "his watchlist counts with the rule on");
});

test("choosePeople marks an ignored person, and watchedThisWeek reads no star of a marked person (the diary is read from the cache, not through userView)", () => {
  const cache = world();
  const marked = L.choosePeople({ cfg: WITH, cache }).people.map((p) => [p.user, !!p.ratingsIgnored]);
  assert.deepEqual(marked, [["ben", true], ["ana", false], ["bia", false]]);
  assert.ok(!L.choosePeople({ cfg: BASE, cache }).people.some((p) => "ratingsIgnored" in p), "no list: the people are exactly what they were");
  // a configured friend who is not in the /following/ page is marked too
  const alone = L.choosePeople({ cfg: { ...WITH, friends: [{ user: "Ben", name: "Ben" }] }, cache: { following: { users: [] } } }).people;
  assert.equal(alone[0].ratingsIgnored, true);
  const week = (cfg) => L.watchedThisWeek({ cache, people: L.choosePeople({ cfg, cache }).people, today: TODAY, days: 7 });
  assert.equal(week(BASE).get("f9")[0].rating, 5);
  assert.equal(week(WITH).get("f9")[0].rating, null);
  assert.equal(week(WITH).get("f9")[0].watched, "2026-10-20");
});

test("the build log counts the ratings the rows use: an ignored person has 0 rated and says why", () => {
  const cache = world();
  const stats = (cfg) => F.crowdStats(F.viewFriends(cache, cfg), cache);
  assert.equal(stats(BASE).find((s) => s.user === "ben").rated, 7);
  const ben = stats(WITH).find((s) => s.user === "ben");
  assert.equal(ben.rated, 0);
  assert.equal(ben.ratingsIgnored, true);
  assert.equal(ben.read, 8);
  assert.equal(stats(WITH).find((s) => s.user === "ana").rated, 5);
});

test("config.json: benreiss is on the list, is followed, and is not a configured friend; the rows read him with no ratings", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  assert.deepEqual(cfg.ratingsIgnored.users, ["benreiss"]);
  assert.match(cfg.ratingsIgnored._doc, /22\/10\/2026/);
  assert.ok(!cfg.friends.some((f) => f.user.toLowerCase() === "benreiss"), "not a configured friend: the floor never read him, and the per-friend rows do not exist for him");
  const file = path.join(ROOT, "cache", "friends.json");
  if (!fs.existsSync(file)) return;
  const cache = F.loadCache(file);
  const ben = F.viewFriends(cache, cfg).crowd.find((p) => p.user === "benreiss");
  if (!ben) return; // no longer followed: nothing to read
  assert.ok(ben.films.size > 0, "his films are still read");
  assert.equal([...ben.films.values()].filter((f) => f.rating != null).length, 0, "and none of them has a rating");
  const without = F.viewFriends(cache, { ...cfg, ratingsIgnored: undefined }).crowd.find((p) => p.user === "benreiss");
  assert.ok([...without.films.values()].some((f) => f.rating != null), "control: without the list the cache does hold his ratings");
});

test("the view build.js reads after the night's reads (refreshFriends) has the rule applied, and build.js hands the cache reader the same config", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "me-ignored-"));
  try {
    const http = { get: async () => { throw new Error("no page is read in this test"); } };
    const run = (cfg) => F.refreshFriends({ cfg: { ...cfg, friends: [], friendLists: [], letterboxd: undefined }, file: path.join(dir, "friends.json"), http, cache: world(), limit: 0, enrichMax: 0, log: () => {}, sleepImpl: async () => {} });
    const ben = (r) => r.view.crowd.find((p) => p.user === "ben");
    assert.equal(ben(await run(WITH)).films.get("f1").rating, null);
    assert.equal(ben(await run(BASE)).films.get("f1").rating, 5, "control");
    // and the order of the lookups it makes: a film only he rated 5★ and nobody else has never been looked up; with him ignored the night does not spend a page on it
    const asked = async (cfg) => {
      const calls = [], c = world();
      c.users.ben.films.push(["f13", "Mike", 2013, 5]);
      await F.refreshFriends({ cfg: { ...cfg, friends: [], friendLists: [], letterboxd: undefined }, file: path.join(dir, "friends.json"), http: { get: async (url) => { calls.push(url); return { status: 404, url, text: "" }; } }, cache: c, limit: 50, enrichMax: 0, log: () => {}, sleepImpl: async () => {}, gapMs: 0 });
      return calls;
    };
    assert.ok((await asked(BASE)).some((u) => u.endsWith("/film/f13/")), "control: a solo 5★ of his is looked up first");
    assert.deepEqual(await asked(WITH), [], "ignored: nothing to look up");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // the rows that name one person read cache.users through userOf: build.js must give it the config (the part of build.js no unit test can run)
  const src = fs.readFileSync(path.join(ROOT, "build.js"), "utf8");
  assert.match(src, /userOf: F\.userReader\(fcache, cfg\),/);
  assert.equal((src.match(/F\.viewFriends\(\w+(?:\.cache)?, cfg\)/g) || []).length, 2, "the two views build.js makes outside refreshFriends are made with the config");
  assert.match(src, /L\.watchedThisWeek\(\{ cache: fcache, people: follow\.people,/);
  assert.match(src, /L\.choosePeople\(\{ cfg, cache: fcache \}\)/, "the people the week rows read come from choosePeople(cfg), which marks the ignored ones");
});

// Review of 22/10/2026 (LOW 6): two mutations survived the first 19 — an OLDER diary entry with stars filling a newer one without, and the name written with a capital at the two
// readers that match it themselves (userReader, choosePeople).
test("watchedThisWeek: an older diary entry of his with stars does not give stars to the newer one without (either order of the entries)", () => {
  for (const rss of [
    [["f9", "India", 2009, null, "2026-10-20"], ["f9", "India", 2009, 5, "2026-10-19"]], // newest first, as the RSS lists them
    [["f9", "India", 2009, 5, "2026-10-19"], ["f9", "India", 2009, null, "2026-10-20"]],
  ]) {
    const cache = world();
    cache.users.ben.rss = rss;
    const week = (cfg) => L.watchedThisWeek({ cache, people: L.choosePeople({ cfg, cache }).people, today: TODAY, days: 7 }).get("f9").find((e) => e.user === "ben");
    assert.equal(week(BASE).rating, 5, "control: the older entry's stars fill the newer one");
    assert.equal(week(WITH).rating, null);
    assert.equal(week(WITH).watched, "2026-10-20", "the newest date stays");
  }
});

test("his account written with a capital (cache.users, /following/, config friends) is matched by the list in lower case: userReader and choosePeople", () => {
  const cache = shoutingWorld();
  assert.equal(F.userReader(cache, WITH)("Ben").films.get("f1").rating, null);
  assert.equal(F.userReader(cache, BASE)("Ben").films.get("f1").rating, 5, "control");
  assert.deepEqual(L.choosePeople({ cfg: WITH, cache }).people.filter((p) => p.ratingsIgnored).map((p) => p.user), ["Ben"], "from the /following/ page");
  const lacking = L.choosePeople({ cfg: { ...WITH, friends: [{ user: "Ben", name: "Ben" }] }, cache: { following: { users: [] } } }).people;
  assert.equal(lacking[0].ratingsIgnored, true, "a configured friend the page lacks");
  assert.equal(F.viewFriends(cache, WITH).crowd.find((p) => p.user === "Ben").films.get("f1").rating, null);
});
