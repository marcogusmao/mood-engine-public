// node --test
// Marco, 22/10/2026 ~06:40 UTC (batch 2 of his answers): a GENERAL RULE besides the list of test/ratings-ignored.test.js. config.json `ratingsIgnored.rule` { share: 0.95, minRatings: 50 }: a person
// you follow (or a configured friend) who gives ONE value in 95% or more of their ratings, having at least 50 ratings, has their ratings ignored, wherever the list of names would ignore them.
// Measured the same day on cache/friends.json: itscharlibb 189 of 189 at 5★ and dylan gelula (nalyd) 134 of 134 at 5★ are caught, kmf (81.4%) stays, the next one is at 43.4%.
//
// Decisions of the session, not asked: the rule is judged on the ratings as the view reads them (the /films/ page with the diary laid over it) every build; it applies to configured friends too
// (the 3.5 floor reads them); a name in the list is "list" even when it also trips the rule; the profiles (lib/people.js deriveConfig) get neither the list nor the rule.
//
// A small world, every person with a precise count, and every test has its CONTROL (the same world without the rule, where the person counts):
//   fifty    50 ratings, 48 at 5★ and 2 at 3★ (96%)                       → caught (the case of the request: 50 with 48 equal)
//   short    49 ratings, all 5★                                          → not (under the 50 minimum)
//   edge94   100 ratings, 94 at 5★ and 6 at 4★                           → not (under 95%)
//   edge95   100 ratings, 95 at 5★ and 5 at 2★                           → caught (exactly 95%: the bar is "95% or more")
//   lowvalue 60 ratings, 58 at 3★ and 2 at 4★                            → caught (the value does not have to be 5★)
//   unrated  49 ratings at 5★ and 20 films without a rating              → not (the 50 counts RATINGS, not films seen)
//   varied   60 ratings cycling 1 to 5★                                  → not
//   reRated  50 ratings at 5★ on the /films/ page, three re-rated at 2★ in the diary → not (47 of 50 = 94% after the diary is laid over the page)
//   ana      configured friend, 51 ratings all at 4★                     → caught (a configured friend is judged like anyone)
//   cora     configured friend, 3.5★ on Golf, a few ratings              → not
//   ben      on the list, 3 ratings at 5★                                 → "list"
//   both     on the list AND 60 ratings at 5★                             → "list" (the list wins)
//   a worst case written 22/10/2026: the control for the bar itself is `rule: { share: 0.95, minRatings: 50 }` against `{ share: 0.95, minRatings: 49 }` (short is caught at 49).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const F = require("../lib/friends");
const L = require("../lib/lists");
const Q = require("../lib/recommendation-quality");
const { crowdIndex } = require("../lib/crowd");
const { buildFriendRows } = require("../lib/rows");

const ROOT = path.join(__dirname, "..");
const TODAY = "2026-10-22";
const tt = (n) => `tt${String(9000000 + n)}`;
const film = (n, title, r) => [`f${n}`, { title, year: 2000 + (n % 20), imdbId: tt(n), r }];
const RULE = { share: 0.95, minRatings: 50 };

/** `count` films f1..f<count>, the first `values.length` groups in order: ratings([[48, 5], [2, 3]]) → 48 films at 5★ then 2 at 3★. */
function ratings(groups, start = 1) {
  const out = [];
  for (const [count, value] of groups) for (let i = 0; i < count; i++) out.push([`f${start + out.length}`, `Film ${start + out.length}`, 2000, value]);
  return out;
}

function world() {
  const c = F.loadCache("/nonexistent");
  const people = {
    fifty: { name: "Fifty", films: ratings([[48, 5], [2, 3]]) },
    short: { name: "Short", films: ratings([[49, 5]]) },
    edge94: { name: "Edge 94", films: ratings([[94, 5], [6, 4]]) },
    edge95: { name: "Edge 95", films: ratings([[95, 5], [5, 2]]) },
    lowvalue: { name: "Low Value", films: ratings([[58, 3], [2, 4]]) },
    unrated: { name: "Unrated", films: [...ratings([[49, 5]]), ...ratings([[20, null]], 500)] },
    varied: { name: "Varied", films: Array.from({ length: 60 }, (_, i) => [`f${i + 1}`, `Film ${i + 1}`, 2000, (i % 5) + 1]) },
    reRated: { name: "Re Rated", films: ratings([[50, 5]]), rss: [["f1", "Film 1", 2000, 2, "2026-10-20"], ["f2", "Film 2", 2000, 2, "2026-10-19"], ["f3", "Film 3", 2000, 2, "2026-10-18"]] },
    ana: { name: "Ana", films: [...ratings([[50, 4]]), ["f101", "Film 101", 2001, 4]], watchlist: [["f103", "Film 103", 2003]], rss: [["f104", "Film 104", 2004, 4, "2026-10-21"]] },
    cora: { name: "Cora", films: [["f1", "Film 1", 2000, 3], ["f102", "Film 102", 2002, 3.5], ["f2", "Film 2", 2000, 4.5]] },
    ben: { name: "Ben", films: [["f201", "F201", 2000, 5], ["f202", "F202", 2000, 5], ["f203", "F203", 2000, 5]] },
    both: { name: "Both", films: ratings([[60, 5]]) },
  };
  c.users = people;
  c.following = { user: "me", users: Object.entries(people).map(([user, p]) => [user, p.name]) };
  c.films = Object.fromEntries([...Array.from({ length: 100 }, (_, i) => film(i + 1, `Film ${i + 1}`, 4.0)), film(101, "Film 101", 3.0), film(102, "Film 102", 3.0), film(103, "Film 103", 4.0), film(104, "Film 104", 4.0)]);
  return c;
}
const BASE = { letterboxd: "me", friends: [{ user: "ana", name: "Ana" }, { user: "cora", name: "Cora" }], friendRows: { love: { minFriends: 2, minStars: 4, soloStars: 4.5 }, top: {}, session: {} } };
const LIST = { users: ["ben", "BOTH"] };
const WITH = { ...BASE, ratingsIgnored: { users: LIST.users, rule: RULE } };
const LISTONLY = { ...BASE, ratingsIgnored: { users: LIST.users } };
const by = (view) => Object.fromEntries(view.crowd.map((p) => [p.user, p.ratingsIgnoredBy || null]));
const find = (view, n) => crowdIndex({ crowd: view.crowd, films: view.films }).find({ id: tt(n), slug: `f${n}` });

test("ratingsRuleOf: no rule is null, a good rule is read, and anything else stops the build (95 typed for 0.95 included)", () => {
  assert.equal(F.ratingsRuleOf({}), null);
  assert.equal(F.ratingsRuleOf({ ratingsIgnored: {} }), null);
  assert.equal(F.ratingsRuleOf({ ratingsIgnored: { users: [] } }), null);
  assert.deepEqual(F.ratingsRuleOf({ ratingsIgnored: { rule: { share: 0.95, minRatings: 50 } } }), RULE);
  assert.deepEqual(F.ratingsRuleOf({ ratingsIgnored: { rule: { share: 1, minRatings: 1 } } }), { share: 1, minRatings: 1 }, "the extremes that are allowed");
  for (const bad of [95, 0.5, 0.2, 0, -1, "0.95", NaN]) {
    assert.throws(() => F.ratingsRuleOf({ ratingsIgnored: { rule: { share: bad, minRatings: 50 } } }), /ratingsIgnored\.rule/, `share ${String(bad)}`);
  }
  for (const bad of [0, -5, 1.5, "50", NaN, undefined]) assert.throws(() => F.ratingsRuleOf({ ratingsIgnored: { rule: { share: 0.95, minRatings: bad } } }), /ratingsIgnored\.rule/, `minRatings ${String(bad)}`);
  for (const bad of [true, 0.95, "rule", [0.95, 50], {}]) assert.throws(() => F.ratingsRuleOf({ ratingsIgnored: { rule: bad } }), /ratingsIgnored\.rule/, JSON.stringify(bad));
  const typo = { ...BASE, ratingsIgnored: { rule: { share: 95, minRatings: 50 } } };
  assert.throws(() => F.viewFriends(world(), typo), /ratingsIgnored\.rule/, "the view refuses it: a typo must not quietly put them all back");
  assert.throws(() => F.userReader(world(), typo), /ratingsIgnored\.rule/);
  assert.throws(() => L.choosePeople({ cfg: typo, cache: world() }), /ratingsIgnored\.rule/);
  assert.throws(() => L.watchedThisWeek({ cache: world(), people: [], today: TODAY, cfg: typo }), /ratingsIgnored\.rule/);
});

test("the bar: 48 of 50 is caught, 49 of 49 is not (under 50), 94 of 100 is not (under 95%), 95 of 100 is; any value counts; 'rated' is ratings and not films; the diary is laid over the page first", () => {
  const view = F.viewFriends(world(), WITH);
  assert.deepEqual(by(view), { fifty: "rule", short: null, edge94: null, edge95: "rule", lowvalue: "rule", unrated: null, varied: null, reRated: null, ana: "rule", cora: null, ben: "list", both: "list" });
  // the numbers that tripped it are kept for the log and the tools
  const spread = (u) => view.crowd.find((p) => p.user === u).ratingSpread;
  assert.deepEqual(spread("fifty"), { n: 50, value: 5, count: 48, share: 0.96 });
  assert.deepEqual(spread("edge95"), { n: 100, value: 5, count: 95, share: 0.95 });
  assert.deepEqual(spread("lowvalue"), { n: 60, value: 3, count: 58, share: 58 / 60 });
  assert.equal(spread("ben"), undefined, "a person caught by the list has no spread: the list did not look at it");
  // CONTROL: the same world without the rule: everybody counts, nobody is marked
  const control = F.viewFriends(world(), BASE);
  assert.deepEqual(Object.values(by(control)), Array(12).fill(null));
  assert.equal(control.crowd.find((p) => p.user === "fifty").films.get("f1").rating, 5);
  assert.equal(control.crowd.find((p) => p.user === "lowvalue").films.get("f1").rating, 3);
  assert.equal(control.crowd.find((p) => p.user === "fifty").ratingsIgnored, false);
  // the bar itself: 49 ratings trip a rule of 49 and not one of 50; 94 of 100 trips a rule of 0.94 and not one of 0.95
  const at = (rule) => by(F.viewFriends(world(), { ...BASE, ratingsIgnored: { rule } }));
  assert.equal(at({ share: 0.95, minRatings: 49 }).short, "rule");
  assert.equal(at({ share: 0.95, minRatings: 50 }).short, null);
  assert.equal(at({ share: 0.94, minRatings: 50 }).edge94, "rule");
  assert.equal(at({ share: 0.95, minRatings: 50 }).edge94, null);
  assert.equal(at({ share: 0.96, minRatings: 50 }).edge95, null, "95 of 100 is under a bar of 96%");
  assert.equal(at({ share: 0.96, minRatings: 50 }).fifty, "rule", "and 48 of 50 is exactly 96%");
  // the 49 ratings of `unrated` become 69 films: counting films would reach 50 and the share would not change; counting RATINGS keeps it at 49
  assert.equal(at({ share: 0.95, minRatings: 50 }).unrated, null);
  assert.equal(at({ share: 0.95, minRatings: 49 }).unrated, "rule");
});

test("what a caught person keeps: what they saw, the diary date and the watchlist; the cache keeps the real ratings; a person who is not caught is read as before", () => {
  const cache = world();
  const ana = F.viewFriends(cache, WITH).crowd.find((p) => p.user === "ana");
  assert.equal(ana.ratingsIgnored, true);
  assert.equal(ana.ratingsIgnoredBy, "rule");
  assert.deepEqual([...ana.films.values()].filter((f) => f.rating != null), [], "no rating is left");
  assert.equal(ana.films.size, 52, "the 51 films of her page and the one only in her diary are all still there");
  assert.equal(ana.films.get("f104").watched, "2026-10-21", "the diary date stays: Friends watched this week still sees her");
  assert.deepEqual([...ana.watchlist.keys()], ["f103"]);
  assert.equal(cache.users.ana.films[0][3], 4, "cache/friends.json is not touched: the stars come back the day she is no longer caught");
  const control = F.viewFriends(world(), BASE).crowd.find((p) => p.user === "ana");
  assert.equal(control.films.get("f1").rating, 4);
  assert.equal(control.films.get("f104").rating, 4, "the diary rating, control");
  const varied = F.viewFriends(world(), WITH).crowd.find((p) => p.user === "varied");
  assert.equal(varied.ratingsIgnored, false);
  assert.equal(varied.films.get("f1").rating, 1);
  assert.equal("ratingsIgnoredBy" in varied, false, "nothing is added to a person who counts");
  assert.equal("ratingSpread" in varied, false);
  // the cache reader (the rows that name one person) judges the same
  assert.equal(F.userReader(cache, WITH)("fifty").films.get("f1").rating, null);
  assert.equal(F.userReader(cache, WITH)("fifty").ratingsIgnoredBy, "rule");
  assert.equal(F.userReader(cache, BASE)("fifty").films.get("f1").rating, 5, "control");
});

test("the average on covers and cards leaves out the caught people; the number of people who saw it does not change", () => {
  // f1: fifty 5, short 5, edge94 5, edge95 5, lowvalue 3, unrated 5, varied 1, reRated 2 (diary), ana 4, cora 3, both 5 = 43 / 11; with the rule out go fifty, edge95, lowvalue, ana and both (list): short 5, edge94 5, unrated 5, varied 1, reRated 2, cora 3 = 21 / 6
  const control = find(F.viewFriends(world(), BASE), 1), ruled = find(F.viewFriends(world(), WITH), 1), listOnly = find(F.viewFriends(world(), LISTONLY), 1);
  assert.deepEqual(control, { seenBy: 11, friendsAvg: 43 / 11, wantBy: 0 });
  assert.deepEqual(listOnly, { seenBy: 11, friendsAvg: 38 / 10, wantBy: 0 }, "control of the list alone: only `both` goes out");
  assert.deepEqual(ruled, { seenBy: 11, friendsAvg: 21 / 6, wantBy: 0 });
  // Ana's watchlist still counts (f103)
  assert.equal(find(F.viewFriends(world(), WITH), 103).wantBy, 1);
});

test("Friends loved: a film that only caught people rated 4★+ is not 'loved', and they are not named on the line", () => {
  const w = () => { const c = world(); c.films.f300 = { title: "Triple", year: 2000, imdbId: tt(300), r: 4.0 }; for (const u of ["fifty", "edge95"]) c.users[u].films.push(["f300", "Triple", 2000, 5]); c.users.varied.films.push(["f300", "Triple", 2000, 4]); return c; };
  const out = (cfg) => buildFriendRows({ view: F.viewFriends(w(), cfg), cfg: { ...cfg, sizes: { discover: 1000 } }, isSeen: () => false, onMyWatchlist: () => false }).rows["friends-love"];
  const control = out(BASE).find((i) => i.slug === "f300");
  assert.ok(control, "control: three people at 4★+ make it loved");
  assert.match(control.why[0], /loved by/);
  // with the rule the two caught people are not ratings any more: one person at 4★ is not enough
  assert.equal(out(WITH).find((i) => i.slug === "f300"), undefined);
});

test("the 3.5 floor: a configured friend who is caught opens nothing; another configured friend still does", () => {
  const index = (cfg) => Q.index(F.viewFriends(world(), cfg));
  const control = index(BASE), ruled = index(WITH);
  // Film 101 (community 3.0) is rated 4★ by Ana alone; Film 102 (community 3.0) is rated 3.5★ by Cora alone
  assert.equal(control.get(tt(101)).fr, 4);
  assert.ok(Q.qualifies(control.get(tt(101))), "control: Ana's 4★ opens the floor for Film 101");
  assert.equal(ruled.get(tt(101)).fr, null);
  assert.ok(!Q.qualifies(ruled.get(tt(101))), "caught: it does not");
  assert.equal(ruled.get(tt(102)).fr, 3.5);
  assert.ok(Q.qualifies(ruled.get(tt(102))), "Cora is not caught: Film 102 still passes on her 3.5★");
  assert.equal(ruled.get(tt(102)).friend, "Cora");
});

test("the reason: 'list' when the name is on the list (even if it also trips the rule), 'rule' when only the rule catches, and the list alone catches only the list", () => {
  const view = F.viewFriends(world(), WITH);
  const both = view.crowd.find((p) => p.user === "both");
  assert.equal(both.ratingsIgnoredBy, "list", "60 ratings at 5★ trip the rule too, the list is the reason given");
  assert.equal(F.viewFriends(world(), LISTONLY).crowd.find((p) => p.user === "both").ratingsIgnoredBy, "list");
  assert.equal(by(F.viewFriends(world(), LISTONLY)).fifty, null, "control: without the rule `fifty` counts");
  assert.equal(view.crowd.find((p) => p.user === "ben").films.size, 3, "ben is out by the list with 3 ratings: far under the 50 of the rule");
  // the rule alone (no names)
  assert.equal(by(F.viewFriends(world(), { ...BASE, ratingsIgnored: { rule: RULE } })).ben, null);
  assert.equal(by(F.viewFriends(world(), { ...BASE, ratingsIgnored: { rule: RULE } })).both, "rule");
});

test("choosePeople marks the people the rule catches (with the reason); watchedThisWeek reads no star of them, judged on the cache as it is when the week is read", () => {
  const cache = world();
  const marked = Object.fromEntries(L.choosePeople({ cfg: WITH, cache }).people.map((p) => [p.user, p.ratingsIgnoredBy || null]));
  assert.deepEqual(marked, by(F.viewFriends(world(), WITH)), "the same judgement as the view");
  assert.ok(!L.choosePeople({ cfg: BASE, cache }).people.some((p) => "ratingsIgnored" in p), "no rule, no list: the people are exactly what they were");
  assert.ok(!L.choosePeople({ cfg: LISTONLY, cache }).people.some((p) => p.user === "fifty" && p.ratingsIgnored), "control: the list alone leaves `fifty` as he was");
  // the week: Ana (caught, configured, diary f104 at 4★) is named without stars
  const week = (cfg, extra = {}) => L.watchedThisWeek({ cache, people: L.choosePeople({ cfg, cache }).people, today: TODAY, days: 7, ...extra }).get("f104")[0];
  assert.equal(week(BASE).rating, 4, "control");
  assert.equal(week(WITH).rating, null);
  assert.equal(week(WITH).watched, "2026-10-21", "the date stays");
  // the people are chosen BEFORE the night's histories are read (build.js: readFollowing, then readCrowd): a person whose history arrives afterwards has no mark yet
  const early = L.choosePeople({ cfg: WITH, cache: { ...world(), users: { ana: { name: "Ana", rss: world().users.ana.rss } } } }).people;
  assert.ok(!early.find((p) => p.user === "ana")?.ratingsIgnored, "no history in the cache yet: not caught yet");
  const people = early.map((p) => ({ ...p })); // marks as they were when the people were chosen
  const later = L.watchedThisWeek({ cache, people, today: TODAY, days: 7, cfg: WITH }).get("f104")[0];
  assert.equal(later.rating, null, "with cfg the week is judged again on today's cache");
  const stale = L.watchedThisWeek({ cache, people, today: TODAY, days: 7 }).get("f104")[0];
  assert.equal(stale.rating, 4, "without cfg the mark on the person is used as it is (the readers of the older tests)");
  // and a person marked while not caught any more (the history changed) is read again with cfg
  const wrongMark = L.watchedThisWeek({ cache, people: [{ user: "cora", name: "Cora", configured: true, ratingsIgnored: true }], today: TODAY, days: 7, cfg: WITH });
  assert.equal(wrongMark.size, 0, "cora has no diary entry this week: nothing to read");
  cache.users.cora.rss = [["f9", "Film 9", 2009, 5, "2026-10-21"]];
  assert.equal(L.watchedThisWeek({ cache, people: [{ user: "cora", name: "Cora", configured: true, ratingsIgnored: true }], today: TODAY, days: 7, cfg: WITH }).get("f9")[0].rating, 5, "cfg wins over a mark that no longer holds");
});

test("the build log counts the ratings the rows use: a caught person has 0 rated, the reason and the numbers", () => {
  const cache = world();
  const stats = (cfg) => F.crowdStats(F.viewFriends(cache, cfg), cache);
  const fifty = stats(WITH).find((s) => s.user === "fifty");
  assert.equal(fifty.rated, 0);
  assert.equal(fifty.ratingsIgnored, true);
  assert.equal(fifty.ratingsIgnoredBy, "rule");
  assert.deepEqual(fifty.ratingSpread, { n: 50, value: 5, count: 48, share: 0.96 });
  assert.equal(fifty.read, 50);
  assert.equal(stats(BASE).find((s) => s.user === "fifty").rated, 50, "control");
  assert.equal("ratingsIgnoredBy" in stats(BASE).find((s) => s.user === "fifty"), false);
  assert.equal(stats(WITH).find((s) => s.user === "ben").ratingsIgnoredBy, "list");
  assert.equal(stats(WITH).find((s) => s.user === "varied").rated, 60);
  // build.js writes the lines from these fields; the part no unit test can run is checked in its text
  const src = fs.readFileSync(path.join(ROOT, "build.js"), "utf8");
  assert.match(src, /Ratings ignored: \$\{byList\.length\} by the list/);
  assert.match(src, /c\.ratingsIgnoredBy === "rule"/);
  assert.equal((src.match(/L\.watchedThisWeek\(\{[^}]*\bcfg \}\)/g) || []).length, 3, "the three weeks build.js reads are judged with the config");
});

// A rating view reads both the full history and the more recent diary. Preserve the
// 22/10 measurement only while BOTH source snapshots match (24/10/2026 repair).
const MEASURED_RATING_SOURCES = {
  filmsAt: "2026-10-18T14:20:00.032Z",
  rssAt: "2026-10-22T04:46:03.730Z",
  sizes: { itscharlibb: [1479, 21], nalyd: [136, 0], kmf: [308, 1] },
};
function sameRatingSources(cache, measured) {
  return Object.entries(measured.sizes).every(([u, [films, rss]]) => {
    const source = cache.users[u];
    return source?.filmsAt === measured.filmsAt && source.rssAt === measured.rssAt &&
      (source.films || []).length === films && (source.rss || []).length === rss;
  });
}

test("a diary refresh invalidates the historical rating measurement even when the full history is unchanged", () => {
  const measured = { filmsAt: "2026-10-18T14:20:00.032Z", rssAt: "2026-10-22T04:46:03.730Z", sizes: { ana: [1, 1] } };
  const original = { users: { ana: { filmsAt: measured.filmsAt, rssAt: measured.rssAt, films: [["a", "A", 2000, 5]], rss: [["a", "A", 2000, 5, "2026-10-21"]] } } };
  assert.equal(sameRatingSources(original, measured), true, "control: the measured sources match");
  const refreshed = structuredClone(original);
  refreshed.users.ana.rssAt = "2026-10-23T15:04:03.305Z";
  refreshed.users.ana.rss[0][3] = 2;
  assert.equal(sameRatingSources(refreshed, measured), false, "a new diary snapshot must not inherit historical counts");
  assert.equal(F.ratingSpread(F.userView(original, "ana", null).films).value, 5);
  assert.equal(F.ratingSpread(F.userView(refreshed, "ana", null).films).value, 2, "the live view reads the changed diary rating");
  const appended = structuredClone(original);
  appended.users.ana.rss.push(["b", "B", 2001, 5, "2026-10-22"]);
  assert.equal(sameRatingSources(appended, measured), false, "different diary contents cannot reuse the old count");
  const missing = structuredClone(original);
  delete missing.users.ana;
  assert.equal(sameRatingSources(missing, measured), false, "a missing source is not the historical snapshot");
});

test("config.json: the rule is 95% and 50 and is documented with the date; on the committed cache the view marks exactly who the bar says", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  assert.deepEqual(cfg.ratingsIgnored.rule, { share: 0.95, minRatings: 50 });
  assert.deepEqual(cfg.ratingsIgnored.users, ["benreiss"], "the list stays");
  assert.match(cfg.ratingsIgnored._doc, /22\/10\/2026 ~06:40 UTC/);
  assert.match(cfg.ratingsIgnored._doc, /itscharlibb 189 of 189/);
  const file = path.join(ROOT, "cache", "friends.json");
  if (!fs.existsSync(file)) return;
  const cache = F.loadCache(file);
  const view = F.viewFriends(cache, cfg);
  // Holds on any night, whatever the caches say: everyone the view marks "rule" has 50 or more ratings and one value in 95% of them; everyone who has, and is not on the list, is marked.
  const listed = new Set(cfg.ratingsIgnored.users.map((x) => x.toLowerCase()));
  for (const p of view.crowd) {
    const s = F.ratingSpread(F.userView(cache, p.user, null).films);
    const trips = s.n >= 50 && s.count / s.n >= 0.95;
    assert.equal(p.ratingsIgnoredBy ?? null, listed.has(p.user.toLowerCase()) ? "list" : trips ? "rule" : null, `${p.user}: ${s.count} of ${s.n} at ${s.value}`);
  }
  assert.equal(view.crowd.find((p) => p.user === "benreiss").ratingsIgnoredBy, "list");
  // The measurement of 22/10/2026 (PRODUCT.md and BACKLOG.md, with the sha256 of cache/friends.json): itscharlibb 189 of 189 and nalyd 134 of 134 at 5★ are caught by the rule, kmf 96 of 118
  // (81.4%) is not. The full histories AND RSS overlays must be those read on 22/10.
  // A diary refresh can change the counts without changing filmsAt; on later snapshots
  // the general rule above remains checked for every followed person.
  const same = sameRatingSources(cache, MEASURED_RATING_SOURCES);
  if (!same) return;
  const spread = (u) => F.ratingSpread(F.userView(cache, u, null).films);
  assert.deepEqual([spread("itscharlibb").count, spread("itscharlibb").n, spread("nalyd").count, spread("nalyd").n, spread("kmf").count, spread("kmf").n], [189, 189, 134, 134, 96, 118], "the cache is the one measured");
  const by = (u) => view.crowd.find((x) => x.user === u)?.ratingsIgnoredBy ?? null;
  assert.equal(by("itscharlibb"), "rule");
  assert.equal(by("nalyd"), "rule");
  assert.equal(by("kmf"), null, "kmf is at 81.4%: under the bar");
});
