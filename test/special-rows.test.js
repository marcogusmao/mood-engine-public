// node --test            (no dependencies)
// The special rows of the v2 Board (Marco, 13/10/2026, PR3 of the 54-row Board): lib/special-rows.js with small fakes, then one real offline build of the caches
// (the fixture is test/fixtures/board-v2-pr3.json: the ten special rows, Tonight, and Friends this week as a Moods-menu row).
// Mutations this file is written to kill (PR3 of the spec, 13/10/2026; each was run against it, the receipt is in the commit message):
//   the friend of the day read from the wrong day · the row not completed with the 4★ · the standard deviation replaced by the mean · the ISO week replaced by the day
//   a prize outside the list accepted · a film Marco has seen let through · the quality floor ignored · a film twice · a row over 100

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SR = require("../lib/special-rows");
const BD = require("../lib/board");
const { learn } = require("../lib/taste");
const { parseCsv, norm } = require("../lib/util");
const { decode } = require("../lib/index-rows");
const { verifyIndex } = require("../verify");

const ROOT = path.join(__dirname, "..");
const CONFIG = require("../lib/board-shared").legacyConfig(require("../config.json")); // PR5 (14/10/2026): config.json carries the Board now; these tests lay their own fixture board on the config WITHOUT it and with the nine legacy moods
const FIXTURE = require("./fixtures/board-v2-pr3.json");

// ── the small world ──────────────────────────────────────────────────────────

const tt = (n) => `tt${String(1000000 + n)}`;
const slug = (n) => `film-${n}`;
/** One Letterboxd film record: film n has the IMDb id tt(1000000+n), average 4.2 unless said. */
const rec = (n, o = {}) => ({ imdbId: tt(n), title: `Film ${n}`, year: 2000, r: 4.2, ...o });
/** A person: ratings { n: stars }, watchlist [n], from the film numbers. */
const person = (user, ratings = {}, watchlist = []) => ({
  user, name: user,
  films: new Map(Object.entries(ratings).map(([n, rating], i) => [slug(n), { slug: slug(n), title: `Film ${n}`, year: 2000, rating, order: i, watched: null }])),
  watchlist: new Map(watchlist.map((n) => [slug(n), { slug: slug(n), title: `Film ${n}`, year: 2000 }])),
});
const FRIENDS = SR.TOP_FRIENDS;

/** ctx for SR.build; `n` films exist (1..n), `seen` are tt's Marco has seen, `low` are tt's under the floor. */
function ctxOf({ today = "2026-10-13", crowd = [], n = 400, seen = [], low = [], films = {}, recs = [], cands = [], rated = [], seenDirectors = [], lb = () => 4.2, awards = {}, favourites = null, watched = () => new Map(), tmdb = {}, userOf = null, users = [] } = {}) {
  const all = {};
  for (let i = 1; i <= n; i++) all[slug(i)] = rec(i);
  Object.assign(all, films);
  const seenSet = new Set(seen.map((x) => (typeof x === "number" ? tt(x) : x))), lowSet = new Set(low.map((x) => (typeof x === "number" ? tt(x) : x)));
  return {
    today, sizes: { row: 50, discover: 100 }, view: { users, crowd, films: all, me: new Set() }, recs, cands, rated, seenDirectors: new Set(seenDirectors), lb, awards,
    isSeen: (r) => seenSet.has(r.imdbId), detail: () => null, allowed: (id) => !lowSet.has(id), model: learn([]), favourites, userOf, watched, tmdbOfImdb: (id) => tmdb[id] || null,
  };
}
// Marco, 29/10/2026: the rows of the tests below that follow ONE person (friend-e) name him in `people`, so they do not depend on whose day the default date is (it was his, 13/10/2026, while the rotation was six; it is friend-c's under seven).
const ONLY_friend-e = { people: ["friend-e"] };
const spec = (id, over = {}) => ({ ...SR.DEFAULT_ROWS.find((r) => r.id === id), ...over });
const run = (ctx, ...specs) => SR.build(ctx, specs);
const ids = (items) => items.map((i) => i.id);
const numbers = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const ratings = (list, stars) => Object.fromEntries(list.map((n) => [n, stars]));

// ── dates ────────────────────────────────────────────────────────────────────

test("dates: the day number counts from 1970-01-01, the ISO week is the week of the Thursday", () => {
  assert.equal(SR.dayNumber("1970-01-01"), 0);
  assert.equal(SR.dayNumber("2026-10-13"), 20739);
  assert.equal(20739 % 7, 5, "since 29/10/2026 the rotation is day mod 7 (seven friends); it was mod 6, 3");
  assert.equal(SR.weekKey("2026-01-01"), "2026-W01", "2026-01-01 is a Thursday");
  assert.equal(SR.weekKey("2027-01-01"), "2026-W53", "a Friday: the week of the Thursday 2026-12-31");
  assert.equal(SR.weekKey("2024-12-30"), "2025-W01", "a Monday whose Thursday is in 2025");
  assert.equal(SR.weekKey("2026-10-12"), "2026-W42");
  assert.equal(SR.weekKey("2026-10-18"), "2026-W42", "Sunday is still the week of Monday");
  assert.equal(SR.weekKey("2026-10-19"), "2026-W43");
});

// ── ⭐ top-picks ─────────────────────────────────────────────────────────────

test("top-picks: explicit empty people stays empty even with Marco's crowd cached", () => {
  const crowd = FRIENDS.map(user => person(user, { 1: 5 }));
  const result = run(ctxOf({ crowd }), spec("top-picks", { people: [] }));
  assert.deepEqual(result.rows["top-picks"], []);
  assert.match(result.notes["top-picks"], /no people configured/);
});

// Marco, 29/10/2026 (questionnaire): "a friend-b ENTRA no rodízio diário da Top picks": seven friends, `day mod 7`, she the seventh. Written against: the rotation left at six (she never leads), and her placed anywhere but where the config says.
test("top-picks: the friend of the day is people[days since 1970 mod 7], in the fixed order, and the reason names them", () => {
  const crowd = FRIENDS.map((u, i) => person(u, { [10 + i]: 4.5 }));
  const day = (today) => run(ctxOf({ crowd, today }), spec("top-picks")).rows["top-picks"];
  // 13/10/2026 is day 20739: 20739 mod 7 = 5
  assert.deepEqual(day("2026-10-13").map((i) => i.why[0]), ["friend-c 4.5★"]);
  // seven consecutive days walk the seven friends in order, each day with its own friend's film; friend-b is the seventh of the list
  const week = ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"].map((d) => day(d)[0].why[0].split(" ")[0]);
  assert.deepEqual(week, ["friend-c", "friend-b", "friend-f", "friend-g", "friend-a", "friend-e", "friend-d"]);
  assert.equal(FRIENDS.at(-1), "friend-b");
  assert.equal(day("1970-01-01")[0].why[0].split(" ")[0], "friend-f", "day 0");
  assert.equal(day("2026-10-20")[0].why[0].split(" ")[0], "friend-c", "the eighth day is the first again");
  // the friend is not in the cache: an empty row and a warning, never another friend's films
  const none = run(ctxOf({ crowd: crowd.filter((p) => p.user !== "friend-c") }), spec("top-picks"));
  assert.deepEqual(none.rows["top-picks"], []);
  assert.match(none.warnings.join(), /friend-c, has no entry in cache\/friends\.json users/);
});

test("top-picks: the friend is found in cache.users when the partial /following/ list lacks them (friend-f and friend-g on 10/10 and 12/10/2026 …)", () => {
  const crowd = FRIENDS.filter((u) => u !== "friend-f" && u !== "friend-g").map((u, i) => person(u, { [10 + i]: 4.5 }));
  const cache = { friend-f: { ...person("friend-f", { 1: 4.5, 2: 4 }), name: "Francesca" }, friend-g: person("friend-g", { 3: 5 }) };
  const userOf = (u) => cache[u] || null;
  const day = (today, over = {}) => run(ctxOf({ crowd, today, userOf, ...over }), spec("top-picks")).rows["top-picks"];
  // 2026-10-15 is day 20741 (mod 7 = 0, friend-f), 2026-10-16 friend-g
  assert.deepEqual(day("2026-10-15").map((i) => i.why[0]), ["Francesca 4.5★", "Francesca 4★"], "the display name of the person, as Friends loved shows it");
  assert.deepEqual(day("2026-10-16").map((i) => i.why[0]), ["friend-g 5★"]);
  const without = run(ctxOf({ crowd, today: "2026-10-15" }), spec("top-picks"));
  assert.deepEqual(without.rows["top-picks"], [], "no userOf and not in the crowd: an empty row");
  assert.match(without.warnings.join(), /friend-f, has no entry in cache\/friends\.json users/);
});

test("friends-watchlist names everybody he follows by default; onlyConfiguredFriends narrows it to the friends of config.json (Marco, 14/10/2026)", () => {
  const mine = (n, rank) => ({ ...rec(n), id: tt(n), slug: slug(n), rank, tags: { watchlist: true, lists: new Map() }, title: `Film ${n}` });
  const recs = [mine(1, 2), mine(2, 1)];
  const ann = person("ann", {}, [1, 2]), ben = person("ben", {}, [1]), cy = person("cy", {}, [2]); // ann is a configured friend; ben and cy are only people he follows
  const run2 = (over) => run(ctxOf({ crowd: [ann, ben, cy], users: [ann], recs }), spec("friends-watchlist", over)).rows["friends-watchlist"];
  assert.equal(SR.DEFAULT_ROWS.find((r) => r.id === "friends-watchlist").onlyConfiguredFriends, false);
  assert.deepEqual(run2({}).map((i) => i.why[0]), ["on the watchlist of ann and ben", "on the watchlist of ann and cy"]);
  assert.deepEqual(run2({ onlyConfiguredFriends: true }).map((i) => i.why[0]), ["on the watchlist of ann", "on the watchlist of ann"], "ben and cy are not named");
  const withOnly = (v) => ({ ...CONFIG, board: { ...FIXTURE, rows: [{ id: "friends-watchlist", kind: "friends-watchlist", onlyConfiguredFriends: v }] } });
  assert.deepEqual(BD.problems(withOnly(true)), []);
  assert.match(BD.problems(withOnly("yes")).join("\n"), /onlyConfiguredFriends must be true or false/);
});

test("the quality net does not name a friend a row already names: one friend once, in the format of the friends rows (5★, 4.5★), by friend and not by text", () => {
  const Q = require("../lib/recommendation-quality");
  const plan = (why) => ({ board: [{ id: "x", items: [{ id: "tt1", why }] }], discover: [] });
  const ratings = (friend, fr) => new Map([["tt1", { lb: 3.2, fr, friend }]]);
  const after = (why, friend, fr) => Q.applyPlan(plan(why), ratings(friend, fr)).board[0].items[0].why;
  assert.deepEqual(after(["friend-e 5★"], "friend-e", 5), ["friend-e 5★"], "the same friend in the format of the row: not again");
  assert.deepEqual(after(["Gustavo 4★ · William 2★"], "Gustavo", 4), ["Gustavo 4★ · William 2★"], "…wherever the row names him");
  assert.deepEqual(after(["friend-e 4.5★"], "friend-e", 5), ["friend-e 4.5★"], "the same friend with another rating (the row's source and the net's differ): by friend, not by text, so not twice");
  assert.deepEqual(after(["a", "b"], "William", 4), ["a", "b · William 4★"], "a friend the row does not name is added, as 4★ and not 4.0★");
  assert.deepEqual(after(["loved by Williamson 4★"], "William", 4.5), ["loved by Williamson 4★", "William 4.5★"], "a longer name is not the friend");
  assert.deepEqual(after(["Gus (x) 4★"], "Gus (x)", 4), ["Gus (x) 4★"], "a name with regexp characters");
});

test("friends rows say the display name of a person and a rating the way Friends loved does: William 4.5★, Gustavo 4★ (never friend-a, never 4.0★)", () => {
  const named = (user, name, r, w) => ({ ...person(user, r, w), name });
  const crowd = [named("friend-a", "William", { 1: 5, 2: 4, 3: 4 }, [9]), named("friend-c", "Gustavo", { 1: 1, 2: 4, 3: 4.5 }, [9]), named("friend-e", "Line", { 1: 3, 2: 4, 3: 1.5, 4: 4.5 }, [9])];
  const split = run(ctxOf({ crowd }), spec("friends-split")).rows["friends-split"];
  assert.deepEqual(split.map((i) => i.why[0]), ["William 5★ · Gustavo 1★", "Gustavo 4.5★ · Line 1.5★"]);
  const mine = { ...rec(9), id: tt(9), slug: slug(9), rank: 1, tags: { watchlist: true, lists: new Map() }, title: "Film 9" };
  assert.equal(run(ctxOf({ crowd, recs: [mine] }), spec("friends-watchlist")).rows["friends-watchlist"][0].why[0], "on the watchlist of Gustavo, Line and William");
  const tp = run(ctxOf({ crowd: [named("friend-e", "Line", { 1: 4.5, 2: 4 })] }), spec("top-picks", ONLY_friend-e)).rows["top-picks"];
  assert.deepEqual(tp.map((i) => i.why[0]), ["Line 4.5★", "Line 4★"]);
});

test("top-picks: the 4.5★+ come first, then the 4★ complete the row up to 100 (60 until 14/11/2026), best rating first; a full row of 4.5★ takes no 4★", () => {
  const few = person("friend-e", { ...ratings(numbers(1, 10), 4.5), ...ratings(numbers(11, 120), 4), ...ratings(numbers(121, 130), 3.5) });
  const r = run(ctxOf({ crowd: [few] }), spec("top-picks", ONLY_friend-e)).rows["top-picks"];
  assert.equal(r.length, 100, "10 at 4.5 + 90 of the 110 at 4, nothing under 4");
  assert.deepEqual(r.slice(0, 10).map((i) => i.why[0]), Array(10).fill("friend-e 4.5★"));
  assert.deepEqual([...new Set(r.slice(10).map((i) => i.why[0]))], ["friend-e 4★"]);
  assert.equal(r.filter((i) => i.why[0].endsWith("3.5★")).length, 0);
  const many = person("friend-e", { ...ratings(numbers(1, 110), 4.5), ...ratings(numbers(111, 180), 4) });
  const full = run(ctxOf({ crowd: [many] }), spec("top-picks", ONLY_friend-e)).rows["top-picks"];
  assert.equal(full.length, 100);
  assert.ok(full.every((i) => i.why[0] === "friend-e 4.5★"), "110 films at 4.5★: the 4★ are not needed");
  // 5★ before 4.5★
  const mixed = person("friend-e", { 1: 4.5, 2: 5, 3: 4.5 });
  assert.deepEqual(run(ctxOf({ crowd: [mixed] }), spec("top-picks", ONLY_friend-e)).rows["top-picks"].map((i) => i.id), [tt(2), tt(1), tt(3)]);
});

test("top-picks: inside one rating the newest log comes first, then the order of the friend's /films/ page", () => {
  const p = person("friend-e", { 1: 4.5, 2: 4.5, 3: 4.5, 4: 4.5, 5: 4.5 });
  const set = (n, watched) => { p.films.get(slug(n)).watched = watched; };
  set(1, "2026-08-01"); set(2, null); set(3, "2026-09-15"); set(4, null); set(5, "2026-09-15");
  // films 2 and 4 have no log date: they follow the dated ones, in the order of the /films/ page (film 2 before film 4); films 3 and 5 share a date and the page order settles it
  assert.deepEqual(ids(run(ctxOf({ crowd: [p] }), spec("top-picks", ONLY_friend-e)).rows["top-picks"]), [3, 5, 1, 2, 4].map(tt));
});

test("top-picks: a film Marco has seen, a film under the quality floor and a film with no IMDb id are left out and the row is filled from the next ones", () => {
  const p = person("friend-e", { ...ratings(numbers(1, 120), 4.5), 999: 4.5 });
  const films = { [slug(999)]: { title: "No IMDb", year: 2000 } }; // a record with no IMDb id
  const r = run(ctxOf({ crowd: [p], films, seen: [1, 2, 3], low: [4, 5] }), spec("top-picks", ONLY_friend-e)).rows["top-picks"];
  assert.equal(r.length, 100);
  assert.ok(!ids(r).some((id) => [1, 2, 3, 4, 5].map(tt).includes(id)), "seen and under-the-floor films are not on the row");
  assert.ok(!ids(r).includes(undefined));
  assert.equal(r[0].id, tt(6), "the next ones take their place");
});

test("top-picks: the friend's profile favourites come first when the cache has them, and are ignored when it does not (the collector is PR7)", () => {
  const p = person("friend-e", { 1: 5, 2: 4.5, 3: 4.5, 77: 3 });
  const base = run(ctxOf({ crowd: [p] }), spec("top-picks", ONLY_friend-e)).rows["top-picks"];
  assert.deepEqual(ids(base), [tt(1), tt(2), tt(3)]);
  const withFav = run(ctxOf({ crowd: [p], favourites: (u) => (u === "friend-e" ? [slug(3), slug(77), "__proto__", "Not A Slug", slug(99999)] : null) }), spec("top-picks", ONLY_friend-e)).rows["top-picks"];
  assert.deepEqual(ids(withFav), [tt(3), tt(77), tt(1), tt(2)], "favourites first, in the profile's order, whatever their rating; a bad slug and an unknown film are skipped");
  assert.equal(withFav[0].why[0], "friend-e 4.5★ · profile favourite");
  assert.equal(withFav[1].why[0], "friend-e 3★ · profile favourite");
  assert.deepEqual(ids(run(ctxOf({ crowd: [p], favourites: () => null }), spec("top-picks", ONLY_friend-e)).rows["top-picks"]), ids(base), "no favourites field: nothing changes");
});

// ── 🆚 friends-split ─────────────────────────────────────────────────────────

test("friends-split: 3+ ratings and a population standard deviation of 1★ or more, widest first, the two extremes named", () => {
  assert.equal(SR.MIN_SD, 1);
  // film 1: 4.5 / 3 / 2 (σ 1.03) · film 2: 5 / 3 / 3 (σ 0.94, out) · film 3: 3 / 3 / 3 (σ 0) but the same mean as film 4 · film 4: 5 / 3 / 1 (σ 1.63) · film 5: two raters
  const crowd = [
    person("friend-g", { 1: 4.5, 2: 5, 3: 3, 4: 5, 5: 5 }), person("friend-a", { 1: 2, 2: 3, 3: 3, 4: 3, 5: 1 }), person("friend-c", { 1: 3, 2: 3, 3: 3, 4: 1 }), person("friend-e", {}),
  ];
  const r = run(ctxOf({ crowd }), spec("friends-split")).rows["friends-split"];
  assert.deepEqual(ids(r), [tt(4), tt(1)], "widest first; 5/3/3 is under 1★; 3/3/3 has the mean of film 4 and no spread; two raters are not enough");
  assert.equal(r[0].why[0], "friend-g 5★ · friend-c 1★");
  assert.equal(r[1].why[0], "friend-g 4.5★ · friend-a 2★");
  assert.equal(r[1].why.length, 1);
  assert.ok(Math.abs(SR.sd([4.5, 3, 2]) - 1.0274) < 1e-3 && SR.sd([5, 3, 3]) < 1 && SR.sd([3, 3, 3]) === 0, "population σ");
});

test("friends-split: a film Marco has seen or under the floor is out; two pages of one film are one film, each person once; a tie in the rating is settled by name", () => {
  const films = { "film-1-b": rec(1) }; // a second Letterboxd page of film 1
  const crowd = [
    person("a", { 1: 5, 2: 5, 3: 5 }), person("b", { 1: 1, 2: 1, 3: 1 }), person("c", { 1: 3, 2: 3, 3: 3 }),
  ];
  crowd[0].films.set("film-1-b", { slug: "film-1-b", title: "Film 1", year: 2000, rating: 5, order: 9, watched: null }); // the same person, the same film, twice
  const all = run(ctxOf({ crowd, films, seen: [2], low: [3] }), spec("friends-split")).rows["friends-split"];
  assert.deepEqual(ids(all), [tt(1)], "film 2 seen, film 3 under the floor");
  assert.equal(all[0].why[0], "a 5★ · b 1★");
  const tie = run(ctxOf({ crowd: [person("zoe", { 1: 5, 2: 5, 3: 5 }), person("amy", { 1: 5, 2: 5, 3: 5 }), person("bob", { 1: 1, 2: 1, 3: 1 }), person("cat", { 1: 1, 2: 1, 3: 1 })] }), spec("friends-split")).rows["friends-split"];
  assert.equal(tie[0].why[0], "amy 5★ · bob 1★");
});

// ── 🤝 friends-watchlist ─────────────────────────────────────────────────────

test("friends-watchlist: Marco's watchlist ∩ the watchlists of the people he follows, the most wanted first; who has seen it does not want it", () => {
  const mine = (n, rank) => ({ ...rec(n), id: tt(n), slug: slug(n), rank, tags: { watchlist: true, lists: new Map() }, title: `Film ${n}` });
  const recs = [mine(1, 1), mine(2, 5), mine(3, 2), mine(4, 3), { ...mine(5, 9), tags: { watchlist: false, lists: new Map() } }];
  const crowd = [person("ann", {}, [1, 2, 5, 9]), person("ben", { 2: 4 }, [1, 2, 3]), person("cy", {}, [1, 3]), person("di", {}, [1])];
  const r = run(ctxOf({ crowd, recs, low: [4] }), spec("friends-watchlist")).rows["friends-watchlist"];
  // film 1: ann, ben, cy, di (4) · film 3: ben, cy (2) · film 2: ann (ben has seen it) · film 4: nobody · film 5: not on Marco's watchlist · film 9: not on his
  assert.deepEqual(ids(r), [tt(1), tt(3), tt(2)]);
  assert.equal(r[0].why[0], "on the watchlist of ann, ben, cy and 1 more");
  assert.equal(r[1].why[0], "on the watchlist of ben and cy");
  assert.equal(r[2].why[0], "on the watchlist of ann");
  // the same number of people: the pool's rank (taste + quality) settles it
  const tied = run(ctxOf({ crowd: [person("ann", {}, [6, 7])], recs: [mine(6, 7), mine(7, 8)] }), spec("friends-watchlist")).rows["friends-watchlist"];
  assert.deepEqual(ids(tied), [tt(7), tt(6)]);
  const two = run(ctxOf({ crowd, recs }), spec("friends-watchlist", { minPeople: 2 })).rows["friends-watchlist"];
  assert.deepEqual(ids(two), [tt(1), tt(3)], "minPeople 2");
});

// ── 📈 friends-month ─────────────────────────────────────────────────────────

test("friends-month: the people he follows logged it in the last 30 days, most people × rating first, the reason says so; not what Marco has seen", () => {
  const asked = [];
  const week = new Map([
    [slug(1), [{ user: "ann", name: "ann", rating: 4, watched: "2026-10-01" }, { user: "ben", name: "ben", rating: 5, watched: "2026-10-05" }]],
    [slug(2), [{ user: "ann", name: "ann", rating: 5, watched: "2026-09-20" }]],
    [slug(3), [{ user: "ann", name: "ann", rating: 5, watched: "2026-09-21" }, { user: "cy", name: "cy", rating: 5, watched: "2026-09-22" }, { user: "di", name: "di", rating: 5, watched: "2026-09-22" }]],
  ]);
  const r = run(ctxOf({ seen: [3], watched: (d) => { asked.push(d); return week; } }), spec("friends-month")).rows["friends-month"];
  assert.deepEqual(asked, [30]);
  assert.deepEqual(ids(r), [tt(1), tt(2)], "film 3 is seen; film 1 has two people");
  assert.equal(r[0].why[0], "watched in the last 30 days by ben 5★ · ann 4★");
  assert.deepEqual(run(ctxOf({ watched: (d) => { asked.push(d); return new Map(); } }), spec("friends-month", { days: 14 })).rows["friends-month"], []);
  assert.equal(asked.at(-1), 14);
});

// ── the TMDB record a row shows ──────────────────────────────────────────────

// Regression, 20/10/2026 (item 19 of the Stremio BACKLOG): "Friends watched this month" (weekRow) and the rows made through recOf (Friends can't agree, a friend's top picks)
// took the cached TMDB record under Letterboxd's tmdbId whatever its IMDb id, so tt0204394 and tt8101850 showed the synopsis of "Leontyne Price: …" and of a documentary. Film 1 here
// has a record with `imdb: null` (the shape of those two), film 2 the record of another IMDb id, film 3 its own; the taste still reads the raw record.
test("rows show a TMDB record only when it names the film's own IMDb id: Friends watched this month and Friends can't agree (20/10/2026)", () => {
  const cache = {
    9001: { id: 9001, imdb: null, title: "Another Film With No IMDb Id", overview: "OTHER SYNOPSIS one", genres: ["Documentary"], runtime: 59 },
    9002: { id: 9002, imdb: tt(77), title: "Another Film With Another Id", overview: "OTHER SYNOPSIS two", genres: ["Documentary"], runtime: 59 },
    9003: { id: 9003, imdb: tt(3), title: "Film 3, own record", overview: "Its own synopsis.", genres: ["Drama"], runtime: 100 },
  };
  const films = { [slug(1)]: rec(1, { tmdbId: 9001 }), [slug(2)]: rec(2, { tmdbId: 9002 }), [slug(3)]: rec(3, { tmdbId: 9003 }) };
  const tasted = [];
  const detail = (r) => { tasted.push(r.tmdbId); return r.tmdbId ? cache[r.tmdbId] || null : null; };
  const week = new Map([1, 2, 3].map((n) => [slug(n), [{ user: "ann", name: "ann", rating: 5, watched: "2026-10-05" }, { user: "ben", name: "ben", rating: 5, watched: "2026-10-06" }]]));
  const crowd = [person("a", { 1: 5, 2: 5, 3: 5 }), person("b", { 1: 1, 2: 1, 3: 1 }), person("c", { 1: 3, 2: 3, 3: 3 })];
  const out = run({ ...ctxOf({ films, crowd, watched: () => week }), detail }, spec("friends-month"), spec("friends-split"));
  for (const id of ["friends-month", "friends-split"]) {
    const by = Object.fromEntries(out.rows[id].map((it) => [it.id, it]));
    for (const n of [1, 2]) {
      assert.equal(by[tt(n)].title, `Film ${n}`, `${id}: film ${n} keeps Letterboxd's title`);
      assert.equal(by[tt(n)].overview, "", `${id}: film ${n} shows no synopsis of another film`);
      assert.deepEqual(by[tt(n)].genres, [], `${id}: film ${n} shows no genre of another film`);
    }
    assert.equal(by[tt(3)].title, "Film 3, own record", `${id}: the control film keeps its own record`);
    assert.equal(by[tt(3)].overview, "Its own synopsis.", `${id}: the control film keeps its own synopsis`);
    assert.deepEqual(by[tt(3)].genres, ["Drama"], `${id}: the control film keeps its own genres`);
  }
  assert.ok(tasted.includes(9001), "the taste still reads the raw record (the ranking is not changed by this rule)");
});

// Review of friends-cards, 22/10/2026: the number Letterboxd names is another film's, /find found the right movie: the row shows that record (lib/pool.js ownDetail(peek, findOf), handed `tmdbOfImdb`).
// Film 1: Letterboxd's number holds another film, /find -> 9101 whose record is film 1's own. Film 2: /find -> 9102 whose record names ANOTHER IMDb id (never shown). Film 3: nothing found.
test("friends-month shows the record that /find found when Letterboxd's number is another film's, and never one that names another IMDb id (22/10/2026)", () => {
  const cache = {
    9001: { id: 9001, imdb: tt(77), title: "Another Film", overview: "OTHER SYNOPSIS", genres: ["Documentary"], runtime: 59, directors: [{ id: 1, name: "Other Director" }] },
    9101: { id: 9101, imdb: tt(1), title: "Film 1, found by find", overview: "Found synopsis.", genres: ["Drama"], runtime: 100, directors: [{ id: 2, name: "Found Director" }] },
    9102: { id: 9102, imdb: tt(88), title: "Film of another IMDb id", overview: "OTHER SYNOPSIS two", genres: ["Comedy"], runtime: 70, directors: [{ id: 3, name: "Wrong Director" }] },
  };
  const films = { [slug(1)]: rec(1, { tmdbId: 9001 }), [slug(2)]: rec(2, { tmdbId: 9001 }), [slug(3)]: rec(3, { tmdbId: 9001 }) };
  const found = { [tt(1)]: 9101, [tt(2)]: 9102 };
  const week = new Map([1, 2, 3].map((n) => [slug(n), [{ user: "ann", name: "ann", rating: 5, watched: "2026-10-05" }, { user: "ben", name: "ben", rating: 5, watched: "2026-10-06" }]]));
  const ctx = { ...ctxOf({ films, watched: () => week }), detail: (r) => (r.tmdbId ? cache[r.tmdbId] || null : null), tmdbOfImdb: (id) => found[id] || null };
  const by = Object.fromEntries(run(ctx, spec("friends-month")).rows["friends-month"].map((it) => [it.id, it]));
  assert.equal(by[tt(1)].title, "Film 1, found by find", "film 1 shows the record /find found");
  assert.deepEqual(by[tt(1)].directors, ["Found Director"]);
  assert.equal(by[tt(2)].title, "Film 2", "film 2: the record /find found names another film: Letterboxd's title stays");
  assert.deepEqual(by[tt(2)].directors, []);
  assert.equal(by[tt(3)].overview, "", "film 3: nothing found, nothing shown");
  const without = Object.fromEntries(run({ ...ctx, tmdbOfImdb: undefined }, spec("friends-month")).rows["friends-month"].map((it) => [it.id, it]));
  assert.equal(without[tt(1)].title, "Film 1", "without tmdbOfImdb the reader is what it was");
});

// ── 🏆 awards ────────────────────────────────────────────────────────────────

const file = (data) => (name) => { if (!(name in data)) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; } return JSON.stringify(data[name]); };
const cannes = (films, critic = ["Direção", "Prêmio do Júri", "Grand Prix (1967+, inclui Grand Prix Spécial du Jury)", "Palme d'Or (1955-63 e 1975-2026)", "Grand Prix du Festival (nome da Palme em 1946-54 e 1964-74)"]) => ({ premios_criticos: critic, filmes: films });
const awardsCtx = (data, over = {}) => {
  const loaded = SR.loadAwards("/root", spec("awards"), (p) => file(Object.fromEntries(Object.entries(data).map(([k, v]) => ["/root/" + k, v])))(p));
  return { ctx: ctxOf({ ...over, awards: { awards: loaded } }), loaded };
};
const PALME = "Palme d'Or (1955-63 e 1975-2026)", GRAND = "Grand Prix (1967+, inclui Grand Prix Spécial du Jury)", GPF = "Grand Prix du Festival (nome da Palme em 1946-54 e 1964-74)", JURY = "Prêmio do Júri", DIR = "Direção", GENRE = "Golden Bear (1951, por gênero)";

test("awards: Cannes counts the Palme, the Grand Prix and the Jury Prize only (Direção is in premios_criticos and does not count); Venice and Berlin by their file's premios_criticos", () => {
  const data = {
    "data/cannes-critic-prizes.json": cannes([
      { slug: slug(1), title: "Film 1", year: 1990, prizes: { [PALME]: [1990] } }, { slug: slug(2), title: "Film 2", year: 1991, prizes: { [DIR]: [1991] } },
      { slug: slug(3), title: "Film 3", year: 1992, prizes: { [GRAND]: [1992] } }, { slug: slug(4), title: "Film 4", year: 1993, prizes: { [JURY]: [1993], [DIR]: [1993] } },
      { slug: slug(5), title: "Film 5", year: 1994, prizes: { "Atriz": [1994] } },
    ]),
    "data/venice-golden-lion.json": { premios_criticos: ["Golden Lion (1949-2026)"], filmes: [{ slug: slug(6), imdb: tt(6), title: "Film 6", year: 1995, prizes: { "Golden Lion (1949-2026)": [1995] } }] },
    "data/berlin-golden-bear.json": { premios_criticos: ["Golden Bear (1952-2026)"], filmes: [{ slug: slug(7), imdb: tt(7), title: "Film 7", year: 1996, prizes: { "Golden Bear (1952-2026)": [1996] } }] },
  };
  const { ctx } = awardsCtx(data);
  const r = SR.build(ctx, [spec("awards")]).rows.awards;
  assert.deepEqual(ids(r).sort(), [1, 3, 4, 6, 7].map(tt).sort(), "film 2 holds Direção only and film 5 an acting prize: neither is a top prize");
  const why = Object.fromEntries(r.map((i) => [i.id, i.why[0]]));
  assert.equal(why[tt(1)], "Cannes Palme d'Or 1990");
  assert.equal(why[tt(3)], "Cannes Grand Prix 1992");
  assert.equal(why[tt(4)], "Cannes Jury Prize 1993", "its Direção is not mentioned; the festival leads: \"Jury Prize\" alone could be any festival's");
  assert.equal(why[tt(6)], "Venice Golden Lion 1995");
  assert.equal(why[tt(7)], "Berlin Golden Bear 1996");
});

test("awards: the winners run from the best for Marco down (the rank of the pool: taste and Letterboxd average), not by title or by file", () => {
  const data = {
    "data/cannes-critic-prizes.json": cannes([{ slug: slug(1), title: "A Film 1", year: 1990, prizes: { [PALME]: [1990] } }, { slug: slug(2), title: "B Film 2", year: 1991, prizes: { [PALME]: [1991] } }]),
    "data/venice-golden-lion.json": { premios_criticos: ["Golden Lion (1949-2026)"], filmes: [{ slug: slug(3), imdb: tt(3), title: "C Film 3", year: 1995, prizes: { "Golden Lion (1949-2026)": [1995] } }] },
  };
  const films = { [slug(1)]: rec(1, { r: 3.8, title: "A Film 1" }), [slug(2)]: rec(2, { r: 4.6, title: "B Film 2" }), [slug(3)]: rec(3, { r: 4.1, title: "C Film 3" }) };
  const r = SR.build(awardsCtx(data, { films }).ctx, [spec("awards")]).rows.awards;
  assert.deepEqual(ids(r), [tt(2), tt(3), tt(1)], "4.6, 4.1, 3.8");
});

test("awards: one film once, however many files and prizes name it; the 1951 genre bears do not count; a prize outside the list is not a reason", () => {
  const data = {
    "data/cannes-critic-prizes.json": cannes([
      { slug: slug(1), title: "Film 1", year: 1953, prizes: { [GPF]: [1953], [GRAND]: [1953], [JURY]: [1953] } }, // like The Wages of Fear: three Cannes prizes
      { slug: slug(2), title: "Film 2", year: 1950, prizes: { [DIR]: [1950] } },
    ]),
    "data/venice-golden-lion.json": { premios_criticos: ["Golden Lion (1949-2026)"], filmes: [{ slug: slug(2), imdb: tt(2), title: "Film 2", year: 1950, prizes: { "Golden Lion (1949-2026)": [1950] } }] }, // like Justice Is Done
    "data/berlin-golden-bear.json": { premios_criticos: ["Golden Bear (1952-2026)"], filmes: [
      { slug: slug(1), imdb: tt(1), title: "Film 1", year: 1953, prizes: { "Golden Bear (1952-2026)": [1953] } },
      { slug: slug(2), imdb: tt(2), title: "Film 2", year: 1951, prizes: { [GENRE]: [1951] } }, // in the file, not in premios_criticos
      { slug: slug(3), imdb: tt(3), title: "Film 3", year: 1951, prizes: { [GENRE]: [1951] } },
    ] },
  };
  const { ctx } = awardsCtx(data);
  const r = SR.build(ctx, [spec("awards")]).rows.awards;
  assert.deepEqual(ids(r).sort(), [tt(1), tt(2)], "film 3 holds only a genre bear");
  assert.equal(r.find((i) => i.id === tt(1)).why[0], "Cannes Palme d'Or 1953, Berlin Golden Bear 1953", "the Palme first (the Grand Prix du Festival was its name), the Grand Prix and the Jury Prize of the same festival not repeated");
  assert.equal(r.find((i) => i.id === tt(2)).why[0], "Venice Golden Lion 1950");
  // with the five 1951 bears put back into premios_criticos they count, and a film in two files is still one film
  data["data/berlin-golden-bear.json"].premios_criticos = ["Golden Bear (1952-2026)", GENRE];
  const back = SR.build(awardsCtx(data).ctx, [spec("awards")]).rows.awards;
  assert.deepEqual(ids(back).sort(), [tt(1), tt(2), tt(3)]);
  assert.equal(back.filter((i) => i.id === tt(2)).length, 1);
  assert.equal(back.find((i) => i.id === tt(2)).why[0], "Venice Golden Lion 1950, Berlin Golden Bear 1951");
});

test("awards: a Cannes film is found through its Letterboxd record (no IMDb in the file); a record that names another IMDb id than the file is left out with a warning; seen films and films under the floor are out", () => {
  const data = {
    "data/cannes-critic-prizes.json": cannes([{ slug: slug(1), title: "Film 1", year: 1990, prizes: { [PALME]: [1990] } }, { slug: slug(2), title: "Film 2", year: 1991, prizes: { [PALME]: [1991] } }, { slug: slug(3), title: "Film 3", year: 1992, prizes: { [PALME]: [1992] } }, { slug: "ghost", title: "Ghost", year: 1993, prizes: { [PALME]: [1993] } }]),
    "data/venice-golden-lion.json": { premios_criticos: ["Golden Lion (1949-2026)"], filmes: [{ slug: slug(8), imdb: tt(80), title: "Film 8", year: 1995, prizes: { "Golden Lion (1949-2026)": [1995] } }] },
  };
  const { ctx, loaded } = awardsCtx(data, { seen: [2], low: [3] });
  const out = SR.build(ctx, [spec("awards")]);
  assert.deepEqual(ids(out.rows.awards), [tt(1)], "film 2 seen, film 3 under the floor, the ghost has no IMDb id; film 8 is tt1000080 in the file and tt1000008 on Letterboxd");
  assert.ok(out.warnings.some((w) => /film-8 is tt1000080 in data\/venice-golden-lion\.json and tt1000008 on Letterboxd: left out/.test(w)), out.warnings.join("\n"));
  assert.match(out.notes.awards, /1 without an IMDb id/);
  assert.equal(loaded.sources[1].films.length, 1);
});

test("awards: a Cannes film that Letterboxd's cache does not know is found through the IMDb id another file gives its slug", () => {
  const data = {
    "data/cannes-critic-prizes.json": cannes([{ slug: "wages", title: "Wages", year: 1953, prizes: { [GPF]: [1953] } }]),
    "data/berlin-golden-bear.json": { premios_criticos: ["Golden Bear (1952-2026)"], filmes: [{ slug: "wages", imdb: "tt0046268", title: "Wages", year: 1953, prizes: { "Golden Bear (1952-2026)": [1953] } }] },
  };
  const r = SR.build(awardsCtx(data).ctx, [spec("awards")]).rows.awards;
  assert.deepEqual(r.map((i) => [i.id, i.why[0]]), [["tt0046268", "Cannes Palme d'Or 1953, Berlin Golden Bear 1953"]], "one film with both prizes; the Cannes entry has no IMDb id and no Letterboxd record of its own");
});

test("awards: a file that is not there is a warning and the row is built without it; a file that is there and not sound stops the build, naming it", () => {
  const data = { "data/cannes-critic-prizes.json": cannes([{ slug: slug(1), title: "Film 1", year: 1990, prizes: { [PALME]: [1990] } }]) };
  const { ctx, loaded } = awardsCtx(data);
  assert.deepEqual(loaded.warnings.filter((w) => /is not there/.test(w)).map((w) => w.replace(/^awards: /, "")), ["data/venice-golden-lion.json is not there: the row is built without Venice", "data/berlin-golden-bear.json is not there: the row is built without Berlin"]);
  assert.deepEqual(ids(SR.build(ctx, [spec("awards")]).rows.awards), [tt(1)]);
  const broken = { "data/cannes-critic-prizes.json": { premios_criticos: [], filmes: [] }, "data/venice-golden-lion.json": null };
  assert.throws(() => SR.loadAwards("/root", spec("awards"), (p) => JSON.stringify(broken[p.slice(6)] ?? "")), /awards: data\/cannes-critic-prizes\.json: premios_criticos must be a non-empty list/);
  assert.throws(() => SR.loadAwards("/root", spec("awards"), () => "{not json"), /awards: data\/cannes-critic-prizes\.json: /);
  const typo = SR.loadAwards("/root", spec("awards", { sources: [{ file: "data/cannes-critic-prizes.json", label: "Cannes", prizes: ["Palme d'Or", "Palma de Ouro"] }] }), () => JSON.stringify(data["data/cannes-critic-prizes.json"]));
  assert.ok(typo.warnings.some((w) => /the prize "Palma de Ouro" is on the list and no film of the file holds it/.test(w)));
});

test("awards: the real data files are sound and say what the row needs (Cannes premios_criticos keeps Direção; the Berlin file leaves the genre bears out)", () => {
  const real = SR.loadAwards(ROOT, spec("awards"));
  assert.deepEqual(real.warnings, [], "the three files are there and every prize of the list is held by a film");
  const [c, v, b] = real.sources;
  assert.deepEqual([c.label, v.label, b.label], ["Cannes", "Venice", "Berlin"]);
  assert.ok(c.films.length > 150 && v.films.length >= 60 && b.films.length >= 80, `${c.films.length} / ${v.films.length} / ${b.films.length}`);
  assert.ok(c.films.every((f) => /^Cannes (Palme d'Or|Special Palme d'Or|Palme d'Or \(retroactive\)|Grand Prix|Jury Prize) \d{4}/.test(f.prize)), "no Direção, no Roteiro, no acting prize");
  const wages = [c, b].map((s) => s.films.find((f) => f.slug === "the-wages-of-fear"));
  assert.deepEqual(wages.map((f) => f && f.prize), ["Cannes Palme d'Or 1953", "Berlin Golden Bear 1953"]);
  assert.ok(!b.films.some((f) => f.slug === "justice-is-done") && v.films.some((f) => f.slug === "justice-is-done"), "Justice Is Done is a Golden Lion; its 1951 genre bear is not counted");
});

// ── 🧭 untried-directors ─────────────────────────────────────────────────────

const cand = (n, directorIds, o = {}) => ({ film: { id: n, imdb: tt(n), title: `Film ${n}`, year: 2000, directors: directorIds.map((id) => ({ id, name: `Director ${id}` })), cast: [], genres: [] }, tasteZ: 0, qualityZ: 0, ...o });

test("untried-directors: 3+ films at 3.8★+ and none seen; three each, the best first; a seen director, a director with two good films and a film under 3.8★ do not count", () => {
  const cands = [
    cand(1, [10], { qualityZ: 3 }), cand(2, [10], { qualityZ: 2 }), cand(3, [10], { qualityZ: 1 }), // director 10: three
    cand(4, [20]), cand(5, [20]), cand(6, [20]), // director 20 is seen
    cand(7, [30]), cand(8, [30]), cand(9, [30]), // director 30: film 9 is 3.7
    cand(11, [40], { qualityZ: 5 }), cand(12, [40], { qualityZ: 4 }), cand(13, [40], { qualityZ: 0 }), cand(14, [40], { qualityZ: -1 }),
  ];
  const lb = (id) => (id === tt(9) ? 3.7 : 4.2);
  const r = run(ctxOf({ cands, lb, seenDirectors: [20] }), spec("untried-directors", { rotate: "none" })).rows["untried-directors"];
  assert.equal(SR.DEFAULT_ROWS.find((x) => x.id === "untried-directors").perDirector, 3, "Marco, 13/10/2026 (night): three films a director");
  assert.deepEqual(ids(r), [tt(11), tt(1), tt(12), tt(2), tt(3), tt(13)], "directors 10 and 40, their three best films each: the best of each director first, then the others by rank");
  assert.deepEqual(r.map((i) => i.why[0]).slice(0, 2), ["Director 40 · nothing seen yet", "Director 10 · nothing seen yet"]);
  assert.ok(!ids(r).includes(tt(14)), "a fourth film of a director is not on the row");
  assert.deepEqual(ids(run(ctxOf({ cands, lb, seenDirectors: [20] }), spec("untried-directors", { rotate: "none", perDirector: 2 })).rows["untried-directors"]), [tt(11), tt(1), tt(12), tt(2)], "perDirector 2 still works as a config value");
  // a film under the quality floor does not count towards the three
  const floored = run(ctxOf({ cands, lb, seenDirectors: [20], low: [1] }), spec("untried-directors", { rotate: "none" })).rows["untried-directors"];
  assert.deepEqual(ids(floored), [tt(11), tt(12), tt(13)], "film 1 is under the floor, so director 10 has two films left: not enough, and only director 40 stays");
});

test("untried-directors: the directors of the row turn with the ISO week and not with the day; rotate none ranks them by their best film", () => {
  const cands = [];
  for (let d = 1; d <= 30; d++) for (let k = 0; k < 3; k++) cands.push(cand(d * 10 + k, [d], { qualityZ: d / 10 }));
  const at = (today, over = {}) => run(ctxOf({ cands, today }), spec("untried-directors", over)).rows["untried-directors"];
  const key = (r) => ids(r).join();
  const monday = at("2026-10-12"), sunday = at("2026-10-18"), next = at("2026-10-19");
  assert.equal(monday.length, 90, "30 directors, three films each");
  assert.equal(key(monday), key(sunday), "Monday to Sunday: the same row");
  assert.equal(key(at("2026-10-14")), key(monday));
  assert.equal(key(monday), key(next), "when every director fits in the row, the week changes nothing");
  const small = (today) => key(at(today, { size: 21 }));
  assert.equal(small("2026-10-12"), small("2026-10-18"));
  const weeks = new Set(["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09", "2026-11-16"].map(small));
  assert.ok(weeks.size >= 5, `six weeks draw ${weeks.size} different rows of 7 directors out of 30`);
  const none = at("2026-10-12", { rotate: "none", size: 21 });
  assert.deepEqual(none.slice(0, 3).map((i) => i.why[0]), ["Director 30 · nothing seen yet", "Director 29 · nothing seen yet", "Director 28 · nothing seen yet"]);
  assert.equal(key(at("2026-10-12", { rotate: "none", size: 21 })), key(at("2026-10-19", { rotate: "none", size: 21 })));
});

// ── 🧑‍🎤 actor-week ───────────────────────────────────────────────────────────

const actor = (id) => ({ id, name: `Actor ${id}` });
const ratedFilm = (n, cast, rating) => ({ film: { id: 5000 + n, imdb: tt(5000 + n), title: `Rated ${n}`, cast: cast.map(actor) }, rating });

test("actor-week: an actor with 3+ ratings averaging 4+ and 5+ eligible unseen films, the first five of the cast; the reason says what Marco rates them", () => {
  const rated = [
    ratedFilm(1, [1, 2], 4.5), ratedFilm(2, [1, 3], 4), ratedFilm(3, [1], 4.5), ratedFilm(4, [1], 4), // actor 1: 4 ratings, 4.25
    ratedFilm(5, [2], 3), ratedFilm(6, [2], 3), // actor 2: two ratings
    ratedFilm(7, [3, 3], 2), // actor 3: 4 and 2... average under 4
    ratedFilm(8, [11, 12, 13, 14, 15, 4], 5), // actor 4 is sixth in the cast: not counted
  ];
  const cands = numbers(1, 6).map((n) => ({ ...cand(n, [1]), film: { ...cand(n, [1]).film, cast: [actor(1)] }, qualityZ: n }));
  const solo = run(ctxOf({ rated, cands }), spec("actor-week"));
  assert.deepEqual(ids(solo.rows["actor-week"]), numbers(1, 6).reverse().map(tt), "Actor 1: all six, best first");
  assert.equal(solo.rows["actor-week"][0].why[0], "Actor 1 · you rate them 4.3★ over 4 films");
  assert.match(solo.notes["actor-week"], /Actor 1 \(4\.25★ over 4 films, 6 eligible unseen\)/);
  // only four eligible films: not enough
  assert.deepEqual(run(ctxOf({ rated, cands: cands.slice(0, 4) }), spec("actor-week")).rows["actor-week"], []);
  // one film under the floor, one seen (not a candidate): 4 left
  assert.deepEqual(run(ctxOf({ rated, cands, low: [1, 2] }), spec("actor-week")).rows["actor-week"], [], "the floor takes the films that do not stay");
  // an actor beyond the fifth place of the cast of a candidate does not make that film theirs
  const sixth = cands.map((c) => ({ ...c, film: { ...c.film, cast: [11, 12, 13, 14, 15, 1].map(actor) } }));
  assert.deepEqual(run(ctxOf({ rated, cands: sixth }), spec("actor-week")).rows["actor-week"], []);
});

test("actor-week: an average under 4★, the sixth place of a cast and a cast that names an actor twice do not make an actor", () => {
  const pool = (actorId) => numbers(1, 6).map((n) => ({ ...cand(n, [1]), film: { ...cand(n, [1]).film, cast: [actor(actorId)] }, qualityZ: n }));
  const wanted = (rated, cands) => run(ctxOf({ rated, cands }), spec("actor-week")).rows["actor-week"];
  // three ratings of 3.5★ on average, six eligible films: not liked enough
  assert.deepEqual(wanted([ratedFilm(1, [7], 3.5), ratedFilm(2, [7], 3.5), ratedFilm(3, [7], 3.5)], pool(7)), []);
  assert.equal(wanted([ratedFilm(1, [7], 4), ratedFilm(2, [7], 4), ratedFilm(3, [7], 4)], pool(7)).length, 6, "the same with 4★: in");
  // three 5★ films in which the actor is SIXTH in the cast: no rating counts
  const sixth = [1, 2, 3].map((n) => ratedFilm(n, [11, 12, 13, 14, 15, 7], 5));
  assert.deepEqual(wanted(sixth, pool(7)), []);
  assert.equal(wanted([1, 2, 3].map((n) => ratedFilm(n, [11, 12, 13, 14, 7], 5)), pool(7)).length, 6, "fifth place counts");
  // a cast that lists one actor twice counts the film once: two films are two ratings, not four
  assert.deepEqual(wanted([ratedFilm(1, [7, 7], 5), ratedFilm(2, [7, 7], 5)], pool(7)), []);
});

test("actor-week: the actor is the same all ISO week and changes with the week, not the day", () => {
  const rated = [], cands = [];
  for (let a = 1; a <= 30; a++) for (let k = 0; k < 3; k++) rated.push(ratedFilm(a * 10 + k, [a], 4.5));
  for (let a = 1; a <= 30; a++) for (let k = 0; k < 5; k++) cands.push({ ...cand(a * 100 + k, [900]), film: { ...cand(a * 100 + k, [900]).film, cast: [actor(a)] } });
  const who = (today) => run(ctxOf({ rated, cands, today }), spec("actor-week")).rows["actor-week"][0].why[0].split(" · ")[0];
  const days = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"].map(who);
  assert.equal(new Set(days).size, 1, `Monday to Sunday: ${days.join()}`);
  const weeks = new Set(["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"].map(who));
  assert.ok(weeks.size >= 6, `eight weeks give ${weeks.size} different actors out of 30`);
  // the pick does not move when another actor joins the list, unless that actor draws the lowest number: here an actor who does not qualify (2 ratings) joins
  const extra = [...rated, ratedFilm(9001, [99], 5), ratedFilm(9002, [99], 5)];
  assert.equal(run(ctxOf({ rated: extra, cands, today: "2026-10-13" }), spec("actor-week")).rows["actor-week"][0].why[0].split(" · ")[0], who("2026-10-13"));
});

// ── lists ────────────────────────────────────────────────────────────────────

test("list rows: the unseen films of one or more lists in the pool's rank, with their place in the list; the Criterion, Sight & Sound and Top 250 rows are lists of config.json", () => {
  const pool = (n, rank, lists) => ({ ...rec(n), id: tt(n), slug: slug(n), rank, title: `Film ${n}`, tags: { watchlist: false, lists: new Map(lists) } });
  const recs = [pool(1, 1, [["snFyM", { name: "Closet", pos: 7 }]]), pool(2, 3, [["tp03m", { name: "Top closet", pos: 2 }], ["snFyM", { name: "Closet", pos: 1 }]]), pool(3, 2, [["jlyNq", { name: "S&S", pos: 1 }]]), pool(4, 9, [["snFyM", { name: "Closet", pos: 3 }]])];
  const r = run(ctxOf({ recs, low: [4] }), spec("criterion")).rows.criterion;
  assert.deepEqual(ids(r), [tt(2), tt(1)], "best rank first; film 3 is in another list; film 4 is under the floor");
  assert.equal(r[0].why[0], "“Closet” · #1", "the place in the list where the film is nearest the top; not \"#1 in …\", the form lib/index-export.js text() drops");
  assert.ok(!/^#\d+ (in|on) /.test(r[0].why[0]));
  assert.deepEqual(ids(run(ctxOf({ recs: [...recs, recs[1]] }), spec("criterion")).rows.criterion), [tt(4), tt(2), tt(1)], "a pool that held a film twice would not put it twice on the row");
  assert.deepEqual(SR.DEFAULT_ROWS.filter((s) => s.kind === "list").map((s) => [s.id, s.listIds]), [["criterion", ["snFyM", "tp03m"]], ["sight-sound", ["jlyNq", "jrR92"]], ["lb250", ["nVqt6"]]]);
  for (const s of SR.DEFAULT_ROWS.filter((x) => x.kind === "list")) for (const l of s.listIds) assert.ok(CONFIG.lists.some((x) => x.id === l), `${l} is a list of config.json`);
  assert.deepEqual(BD.problems({ ...CONFIG, board: FIXTURE }), [], "the fixture is a sound board: criterion, sight-sound and lb250 are rows the build can make");
});

// ── the prize files in the four lists of fixed paths ─────────────────────────

test("the Venice and Berlin files are in the four lists of fixed source paths (frozen sources, replay, snapshot, Fase A store), as the Cannes file is", () => {
  const AW = ["data/cannes-critic-prizes.json", "data/venice-golden-lion.json", "data/berlin-golden-bear.json"];
  const Paths = require("../lib/learning/paths");
  for (const f of AW) assert.equal(Paths.sourcePath(f), f);
  assert.throws(() => Paths.sourcePath("data/some-other-prizes.json"), /Unexpected frozen source path/, "the list is still a list");
  const snap = require("../lib/learning/snapshot").sourceFiles(ROOT);
  for (const f of AW) assert.ok(snap.includes(f), `snapshot sourceFiles lacks ${f}`);
  const store = require("../tools/films/store").sourceFiles(ROOT);
  for (const f of AW) assert.ok(store.includes(f), `the Fase A store lacks ${f}`);
  // replay.js keeps its list inline (the files it writes into the replay folder): read it as text
  const replay = fs.readFileSync(path.join(ROOT, "lib", "learning", "replay.js"), "utf8");
  for (const f of AW) assert.ok(replay.includes(`'${f}'`), `replay.js lacks ${f}`);
});

// ── every row: the guard, the floor, the ceiling, each film once ─────────────

test("every special row: never a film Marco has seen, never one under the floor, never over 100, each film once", () => {
  const n = 400, all = numbers(1, n);
  const crowd = [
    person("friend-f", ratings(all, 4.5)), person("friend-g", ratings(all, 4.5)), person("friend-a", ratings(all, 4.5)), person("friend-e", ratings(all, 4.5)), person("friend-d", ratings(all, 4.5)), person("friend-c", ratings(all, 4.5)), person("friend-b", ratings(all, 4.5)),
  ];
  // splits: every even film gets a 1★ from one more person
  const splitter = person("splitter", Object.fromEntries(all.filter((i) => i % 2 === 0).map((i) => [i, 1])), all.filter((i) => i % 3 === 0));
  const third = person("third", Object.fromEntries(all.filter((i) => i % 2 === 0).map((i) => [i, 4])));
  crowd.push(splitter, third);
  const recs = all.map((i) => ({ ...rec(i), id: tt(i), slug: slug(i), rank: i, title: `Film ${i}`, tags: { watchlist: i % 3 === 0, lists: new Map(["snFyM", "tp03m", "jlyNq", "jrR92", "nVqt6"].map((l) => [l, { name: l, pos: i }])) } }));
  const seen = all.filter((i) => i % 7 === 0), low = all.filter((i) => i % 11 === 0);
  const week = new Map(all.map((i) => [slug(i), [{ user: "splitter", name: "splitter", rating: 4, watched: "2026-10-05" }]]));
  const cands = all.map((i) => cand(i, [i % 50 + 1], { qualityZ: i / 100 }));
  const rated = [];
  for (let i = 0; i < 6; i++) rated.push(ratedFilm(i, [1], 4.5));
  const withCast = cands.map((c) => ({ ...c, film: { ...c.film, cast: [actor(1)] } }));
  const awardsFiles = { "data/cannes-critic-prizes.json": cannes(all.map((i) => ({ slug: slug(i), title: `Film ${i}`, year: 1990, prizes: { [PALME]: [1990] } }))) };
  const { loaded } = awardsCtx(awardsFiles);
  const ctx = ctxOf({ crowd, seen, low, recs, cands: withCast, rated, awards: { awards: loaded }, watched: () => week, n });
  const specs = SR.DEFAULT_ROWS.map((s) => ({ ...s }));
  const out = SR.build(ctx, specs);
  const forbidden = new Set([...seen, ...low].map(tt));
  for (const s of specs) {
    const r = out.rows[s.id];
    assert.ok(r.length > 0 && r.length <= 100, `${s.id}: ${r.length}`);
    assert.equal(new Set(ids(r)).size, r.length, `${s.id}: a film twice`);
    assert.ok(r.every((i) => /^tt\d+$/.test(i.id) && !forbidden.has(i.id)), `${s.id}: a seen film or a film under the floor: ${ids(r).filter((id) => forbidden.has(id)).slice(0, 3)}`);
  }
  assert.equal(out.rows["top-picks"].length, 100, "top-picks stops at 100 (60 until 14/11/2026)");
  assert.equal(out.rows["criterion"].length, 100);
  assert.equal(out.rows["awards"].length, 100);
  // a seen film in the cast of the candidates, in the director rows and in the actor's row alike
  assert.ok(out.rows["untried-directors"].every((i) => !forbidden.has(i.id)));
});

// ── the config ───────────────────────────────────────────────────────────────

test("config: the defaults are rows the build can make; board.rows overrides a default by id or adds a list row; a bad recipe is named; an id of a legacy row, a mood or the series row is refused", () => {
  const withRows = (rows, order = FIXTURE.order) => ({ ...CONFIG, board: { ...FIXTURE, order, names: Object.fromEntries(order.map((id) => [id, FIXTURE.names[id] || `Name of ${id}`])), ...(rows ? { rows } : {}) } });
  assert.deepEqual(BD.problems(withRows(undefined)), []);
  assert.ok(SR.DEFAULT_ROWS.some((r) => r.id === "awards") && SR.DEFAULT_ROWS.some((r) => r.id === "lb250"));
  // a new list row
  const added = withRows([{ id: "closet-only", kind: "list", listIds: ["snFyM"] }], [...FIXTURE.order, "closet-only"]);
  assert.deepEqual(BD.problems(added), []);
  assert.deepEqual(SR.rowsFor(added, ["closet-only", "criterion"]).map((s) => [s.id, s.listIds]), [["closet-only", ["snFyM"]], ["criterion", ["snFyM", "tp03m"]]], "in the order of the Board");
  assert.deepEqual(BD.parse(added).rows["closet-only"], { id: "closet-only", kind: "list", listIds: ["snFyM"] }, "the recipe is in parse().rows beside the filters and the combined rows");
  // an override
  const over = withRows([{ id: "friends-split", kind: "friends-split", minSd: 1.25 }]);
  assert.deepEqual(BD.problems(over), []);
  assert.equal(SR.specs(over).get("friends-split").minRatings, 3, "the rest of the default stays");
  assert.equal(SR.specs(over).get("friends-split").minSd, 1.25);
  const bad = (rows, re, order) => assert.match(BD.problems(withRows(rows, order)).join("\n"), re);
  bad([{ id: "criterion", kind: "list", listIds: ["nope"] }], /\(criterion\): list "nope" is not a list of config\.json/);
  bad([{ id: "friends-split", kind: "friends-split", minSd: -1 }], /\(friends-split\): minSd must be a positive number/);
  bad([{ id: "friends-split", kind: "friends-split", bogus: 1 }], /\(friends-split\): a friends-split row has no "bogus"/);
  bad([{ id: "lb250", kind: "awards", sources: [{ file: "data/x.json", label: "X" }] }], /"lb250" is a "list" row; its kind cannot become "awards"/);
  bad([{ id: "top-picks", kind: "top-picks", size: 101 }], /\(top-picks\): size must be a whole number up to 100/);
  bad([{ id: "top-picks", kind: "top-picks", fillStars: 4.5 }], /fillStars \(4\.5\) must be below minStars \(4\.5\)/);
  bad([{ id: "untried-directors", kind: "untried-directors", rotate: "day" }], /rotate must be "week" or "none"/);
  bad([{ id: "x", kind: "list", listIds: ["snFyM"] }, { id: "x", kind: "list", listIds: ["snFyM"] }], /"x" is defined twice/, [...FIXTURE.order, "x"]);
  bad([{ id: "Bad Id", kind: "list", listIds: ["snFyM"] }], /id must be lower case letters, digits and hyphens/);
  bad([{ id: "awards", kind: "awards", sources: [{ file: "../x.json", label: "X" }] }], /a source needs file \(data\/<name>\.json\) and label/);
  bad([{ id: "closet-only", kind: "list", listIds: ["snFyM"] }], /"closet-only" is not in order/);
  // the default of a row named in order is checked too: a config without the Criterion lists cannot run the default `criterion`
  assert.match(BD.problems({ ...withRows(undefined), lists: [] }).join("\n"), /rows: "criterion" \(default\): list "snFyM" is not a list of config\.json/);
  // an id the build already makes (a legacy row, a mood, the series row) cannot be taken by a special recipe: it would win over that row in plan.board2 in silence
  for (const id of ["short", "newforyou", "escape", "my-series", "tonight"]) {
    const order = FIXTURE.order.includes(id) ? FIXTURE.order : [...FIXTURE.order, id];
    bad([{ id, kind: "list", listIds: ["snFyM"] }], new RegExp(`"${id}" is already (a row|a mood) of the build, and a recipe of the same id would replace it in silence`), order);
  }
  assert.throws(() => BD.parse(withRows([{ id: "short", kind: "friends-split" }], [...FIXTURE.order, "short"])), /"short" is already a row of the build/);
  // the ids of the special rows are reserved: a filter or a combined recipe may not take one (it would be built twice, and the build used to stop only after the work)
  for (const id of ["awards", "top-picks", "criterion"]) {
    bad([{ id, kind: "combine", parts: ["lift", "escape"] }], new RegExp(`"${id}" is a special row \\(lib/special-rows\\.js\\): its id is reserved, a combine recipe may not take it`));
    bad([{ id, kind: "filter", where: { years: { min: 1970 } } }], new RegExp(`"${id}" is a special row .*a filter recipe may not take it`));
  }
  assert.deepEqual(BD.problems(withRows([{ id: "somebody-elses", kind: "combine", parts: ["a"] }])).some((p) => /somebody-elses/.test(p)), true, "a kind that is not ours is validated by lib/board.js as before (it is not in order)");
});

// ── the plan: rows2, never extra; exclude.films leaves its gap ────────────────

test("plan: the special rows reach plan.board2 through rows2 and the legacy Board never has them; exclude.films takes a film out of a special row and nothing moves up", () => {
  const { buildPlan } = require("../lib/plan"), EX = require("../lib/exclude");
  const it = (n) => ({ id: tt(n), tmdb: null, slug: null, title: `Film ${n}`, year: 2000, why: ["r"], overview: "", genres: [], directors: [] });
  const spec = BD.parse({ ...CONFIG, board: FIXTURE });
  const moods = require("../lib/moods").compile(CONFIG.moods);
  const special = { "top-picks": [it(1), it(2), it(3)], criterion: [it(4), it(5)] };
  const plan = buildPlan({ moods, rows: { tonight: [it(9)] }, extra: { fromlists: [], short: [], newforyou: [], "friends-week": [] }, sizes: { row: 50, friends: 50, discover: 100 }, board: spec, rows2: special });
  assert.ok(!plan.board.some((r) => r.id in special), "the legacy Board has no special row");
  assert.deepEqual(plan.board2.find((r) => r.id === "top-picks").items.map((i) => i.id), [tt(1), tt(2), tt(3)]);
  assert.equal(plan.board2.find((r) => r.id === "top-picks").items[0].mood, "⭐ Friend's top picks", "the item leads with the name of its row (line 2 of the description)");
  EX.applyToPlan(plan, new Set([tt(2), tt(4)]));
  assert.deepEqual(plan.board2.find((r) => r.id === "top-picks").items.map((i) => i.id), [tt(1), tt(3)], "one film shorter, the third did not move into the gap");
  assert.deepEqual(plan.board2.find((r) => r.id === "criterion").items.map((i) => i.id), [tt(5)]);
  // a special row put through `extra` would win over a legacy row of the same id in silence: that is what rows2 and the refusal of the id prevent
  const viaExtra = buildPlan({ moods, rows: {}, extra: { short: [it(7)] }, sizes: { row: 50, friends: 50, discover: 100 }, board: BD.parse({ ...CONFIG, board: FIXTURE }) });
  assert.ok(viaExtra.board.find((r) => r.id === "short").items.length === 1, "extra feeds the legacy row of that id: the reason special rows do not use it");
});

// ── the real build ───────────────────────────────────────────────────────────

let built = null;
/** One offline build of the repository's caches (copied, so the build touches nothing) with the PR3 fixture; removed by cleanup(). */
const BUILD_ARGS = (date, out, work, extra = []) => [path.join(ROOT, "build.js"), "--offline", "--cache-only", "--skip-posters", "--date", date, "--captured-at", `${date}T12:00:00.000Z`, "--board", path.join(__dirname, "fixtures", "board-v2-pr3.json"), "--cache-dir", path.join(work, "cache"), "--out", out, ...extra];
const BUILD_OPTS = { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" } };
function build() {
  if (built) return built;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mood-special-"));
  fs.mkdirSync(path.join(work, "cache"));
  for (const n of fs.readdirSync(path.join(ROOT, "cache"))) if (n.endsWith(".json")) fs.copyFileSync(path.join(ROOT, "cache", n), path.join(work, "cache", n));
  const out = path.join(work, "out");
  const r = spawnSync(process.execPath, [path.join(ROOT, "build.js"), "--offline", "--cache-only", "--skip-posters", "--date", "2026-10-13", "--captured-at", "2026-10-13T12:00:00.000Z", "--board", path.join(__dirname, "fixtures", "board-v2-pr3.json"), "--cache-dir", path.join(work, "cache"), "--out", out], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" },
  });
  assert.equal(r.status, 0, `the build failed\n${(r.stderr || "").slice(-2000)}\n${(r.stdout || "").slice(-1500)}`);
  return (built = { work, out, log: r.stdout });
}
test.after(() => { if (built) fs.rmSync(built.work, { recursive: true, force: true }); built = null; });
const rowFile = (id) => decode(JSON.parse(fs.readFileSync(path.join(build().out, "data", `index-v2-row-${id}.json`), "utf8")));
const SPECIAL_ROWS = SR.DEFAULT_ROWS.map((r) => r.id);
/**
 * Line 2 of the card of one row film (lib/describe.js). Description v3, Marco 20/10/2026: "<genres> · <mood words>." with no reason. Marco, 21/10/2026 (~15:00 UTC, D1): in SEVEN of these rows the reason opens line 2:
 * Friend's top picks "Loved by William 4.5★", Friends can't agree "Gustavo 5★, Line 2★", Friends want to see this too "On the watchlist of …", Friends watched this month "Watched in the last 30 days by …", the prize row
 * "Cannes Palme d'Or 1953" and Actor of the week "With Tilda Swinton" (LEAD below); the other rows (the lists, untried directors) are no reason rows. → the line, "" when the film has none.
 */
const STAR = "\\d(?:\\.5)?★";
const END = "(?: · |\\.$)"; // the lead is followed by the genres, or ends the line when the film has neither genres nor words
const LEAD = {
  "top-picks": new RegExp(`^Loved by [^·]+${END}`),
  "friends-split": new RegExp(`^[^·]+? ${STAR}, [^·]+? ${STAR}${END}`),
  "friends-watchlist": new RegExp(`^On the watchlist of [^·]+${END}`),
  "friends-month": new RegExp(`^Watched in the last 30 days by [^·]+${END}`),
  awards: new RegExp(`^[^·]*\\d{4}[^·]*${END}`),
  "actor-week": new RegExp(`^With [^·]+${END}`),
};
const lineOf = (id) => (desc) => {
  const line = desc.split("\n\n")[0].split("\n")[1] || "";
  if (LEAD[id]) assert.ok(LEAD[id].test(line), `${id}: line 2 of the description does not open with its reason: ${JSON.stringify(line.slice(0, 120))}`);
  else assert.ok(!/★|you rate|Loved by/.test(line), `${id}: line 2 of a row that is no reason row carries a reason: ${JSON.stringify(line.slice(0, 100))}`);
  assert.ok(line === "" || /[.!?…]$/.test(line), `${id}: line 2 does not end with a full stop: ${JSON.stringify(line)}`);
  return line;
};

test("real build (caches of 13/10/2026, --board fixture): every special row is made, over the floor, unseen, at most 100; verify.js accepts the output", { timeout: 300000 }, (t) => {
  const { out, log } = build();
  const watched = parseCsv(fs.readFileSync(path.join(ROOT, "data", "letterboxd", "watched.csv"), "utf8"));
  const seenTitle = new Map();
  for (const w of watched) (seenTitle.get(norm(w.Name)) || seenTitle.set(norm(w.Name), []).get(norm(w.Name))).push(Number(w.Year));
  const counts = {};
  for (const id of SPECIAL_ROWS) {
    const j = rowFile(id), tts = j.rows[id];
    counts[id] = tts.length;
    assert.ok(tts.length > 0 && tts.length <= 100, `${id}: ${tts.length}`);
    assert.equal(new Set(tts).size, tts.length, `${id}: a film twice`);
    const byTt = new Map(j.films.map((f) => [f.tt, f]));
    for (const x of tts) {
      const f = byTt.get(x);
      assert.ok(f, `${id}: ${x} has no film record`);
      assert.equal(f.eligible, true, `${id}: ${f.name} is under the quality floor`);
      // independent of the build's own guard: a title Marco has watched in the same year (±1)
      const years = seenTitle.get(norm(f.name)) || [];
      assert.ok(!years.some((y) => Math.abs(y - f.year) <= 1), `${id}: ${f.name} (${f.year}) is a film Marco has watched`);
    }
  }
  t.diagnostic(`rows: ${JSON.stringify(counts)}`);
  const v = verifyIndex(out);
  assert.equal(v.ok, true, v.problems.join("\n"));
  assert.match(log, /Board v2: 12 rows/);
});

test("real build: the friend of the day on 13/10/2026 is friend-c (the build log; friend-e while the rotation was six, until 29/10/2026), the rows are made, and the description of each opens with its reason (D1, Marco 21/10/2026; until then none carried a reason, a star or the row's name)", { timeout: 300000 }, (t) => {
  const { log } = build();
  assert.match(log, /friend of the day friend-c \(day 20739 mod 7 = 5\)/);
  // COVERAGE MOVED, THEN BROUGHT BACK: until 20/10/2026 this test read the reasons from the descriptions (friend-e's stars, 4.5★ before 4★, one actor in every reason of the week's row, the prize and year); the v3 of 20/10/2026
  // took them out of the card and 21/10/2026 (~15:00 UTC, D1) put them back as the lead of line 2: the friend of the day, the two extremes of the split, the prize with its year, the actor.
  const top = rowFile("top-picks");
  assert.ok(top.rows["top-picks"].length > 20 && top.rows["top-picks"].length <= 100, `${top.rows["top-picks"].length} picks`);
  for (const id of ["top-picks", "actor-week", "friends-split", "awards"]) {
    const d = rowFile(id).rowDesc[id];
    assert.ok(d.length >= 5, id);
    d.forEach(lineOf(id));
  }
  const day = rowFile("top-picks").rowDesc["top-picks"].map(lineOf("top-picks"));
  const names = new Set(day.map((l) => l.split(" · ")[0].replace(/ \d(?:\.5)?★.*$/, "")));
  assert.equal(names.size, 1, `one friend of the day on the whole row: ${[...names].join(" | ")}`);
  const awardLeads = rowFile("awards").rowDesc.awards.map(lineOf("awards"));
  assert.ok(awardLeads.some((l) => /Palme d'Or|Golden Lion|Golden Bear|Jury Prize|Grand Prix/.test(l)), "the prize row names a prize");
  assert.ok(rowFile("actor-week").rowDesc["actor-week"].map(lineOf("actor-week")).every((l) => /^With /.test(l)));
  t.diagnostic(`top-picks: ${top.rows["top-picks"].length} picks`);
});

test("real build: the descriptions of the friends rows name the people and write the stars (D1, Marco 21/10/2026; the friends' stars were the reason line until 20/10/2026: \"friend-e 5★ · friend-e 5.0★\" was a defect of it)", { timeout: 300000 }, () => {
  for (const id of ["top-picks", "friends-split", "friends-watchlist", "friends-month"]) {
    const texts = rowFile(id).rowDesc[id];
    assert.ok(texts.length > 0, id);
    for (const t of texts) lineOf(id)(t);
  }
  const top = rowFile("top-picks").rowDesc["top-picks"];
  assert.ok(top.some((t) => /★/.test(t.split("\n")[1])), "the friend of the day's stars are on the lead");
  for (const t of top) assert.equal((t.split("\n")[1].split(" · ")[0].match(/★/g) || []).length, 1, `one friend, one rating on the lead: ${t.split("\n")[1]}`);
  const split = rowFile("friends-split").rowDesc["friends-split"].map((t) => t.split("\n")[1]);
  assert.ok(split.every((l) => (l.match(/★/g) || []).length >= 2), "the two extremes with their stars");
});

test("real build: line 2 of every film of every special row ends with a full stop, opens with its reason when the row is a reason row, and the rows made from TMDB candidates have the actors on line 1 (the `desc` of a row)", { timeout: 300000 }, () => {
  for (const id of SPECIAL_ROWS) {
    const d = rowFile(id).rowDesc[id];
    assert.ok(d.length > 0, id);
    d.forEach(lineOf(id));
  }
  const withCast = (id) => rowFile(id).rowDesc[id].filter((x) => x.split("\n")[0].length > 0).length;
  for (const id of ["untried-directors", "actor-week"]) assert.ok(withCast(id) >= rowFile(id).rows[id].length * 0.9, `${id}: the cast line is empty for too many films`);
  // Marco, 21/10/2026 (~15:00 UTC, D3): the rows that are no mood and no reason (the lists, untried directors) open line 2 with the mood the film fits best, one of the 30 names of config.json
  const names30 = new Set(require("../config.json").moods.map((m) => m.name));
  for (const id of ["criterion", "sight-sound", "lb250", "untried-directors"]) {
    const lines = rowFile(id).rowDesc[id].map((t) => t.split("\n\n")[0].split("\n")[1] || "");
    const labelled = lines.filter((l) => l.startsWith("Mood: "));
    for (const l of labelled) assert.ok(names30.has(l.slice(6).split(" · ")[0].replace(/\.$/, "")), `${id}: "${l}" names no mood of config.json`);
    assert.ok(labelled.length >= lines.length * 0.4, `${id}: ${labelled.length} of ${lines.length} films open with the mood they fit best`);
  }
});

test("real build: with the special rows on the Board every legacy file (manifest, catalog/**, index*.json) is the file of a build with no board, builtAt, the word group of line 2 of the card and the best-fit label of a line that is not in a mood row aside", { timeout: 300000 }, () => {
  const { work, out } = build();
  const plain = path.join(work, "plain");
  const plainConfig = path.join(work, "plain.config.json"); // PR5 (14/10/2026): config.json carries the board, so "a build with no board" is the config without it and with the nine legacy moods
  fs.writeFileSync(plainConfig, JSON.stringify(require("../lib/board-shared").legacyConfig(require("../config.json"))));
  const r = spawnSync(process.execPath, [path.join(ROOT, "build.js"), "--offline", "--cache-only", "--skip-posters", "--date", "2026-10-13", "--captured-at", "2026-10-13T12:00:00.000Z", "--config", plainConfig, "--cache-dir", path.join(work, "cache"), "--out", plain], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" },
  });
  assert.equal(r.status, 0, (r.stderr || "") + (r.stdout || "").slice(-1500));
  const walk = (dir, rel = "") => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(dir, path.join(rel, e.name)) : [path.join(rel, e.name)]));
  const V2 = /^data\/index-v2(?:-[a-z0-9-]+)?\.json$/;
  const slash = (f) => f.split(path.sep).join("/");
  const a = walk(plain).map(slash).sort(), b = walk(out).map(slash).filter((f) => !V2.test(f) && !/^data\/page-\d{2}\.json$/.test(f)).sort(); // 24/10/2026: the film-page shards belong to the v2 family
  assert.deepEqual(b, a, "the same set of legacy files");
  assert.ok(a.includes("manifest.json") && a.some((f) => f.startsWith("catalog/movie/")) && a.includes("data/index.json"));
  // 21/10/2026 (description v3, Marco 01:35 UTC): the words of line 2 of the card come from the 30 moods in both families, so the legacy files of this build may differ from the nine-mood build in that last group and in
  // nothing else (test-support/card-words.js; the same function as test/legacy-parity.test.js). Until then this test compared them byte for byte, builtAt aside, and was red from the day of the decision.
  const moved = require("../test-support/card-words").movedBeyondWords(a, plain, out);
  assert.deepEqual(moved, [], "a legacy file moved");
});

test("real build: the legacy family has none of the new rows (no catalog, no row in index-board.json), and the v2 Board lists them under the names of the fixture", { timeout: 300000 }, () => {
  const { out } = build();
  const board = JSON.parse(fs.readFileSync(path.join(out, "data", "index-board.json"), "utf8"));
  const legacy = Object.keys(decode(board).rows);
  for (const id of SPECIAL_ROWS) {
    assert.ok(!legacy.includes(id), `${id} is in the legacy Board`);
    assert.ok(!fs.existsSync(path.join(out, "catalog", "movie", `${id}.json`)), `catalog/movie/${id}.json exists`);
  }
  const menus = JSON.parse(fs.readFileSync(path.join(out, "data", "index-v2-menus.json"), "utf8"));
  assert.deepEqual(menus.board.map((r) => [r.id, r.name]), FIXTURE.order.map((id) => [id, FIXTURE.names[id]]));
});

// Marco, 29/10/2026: seven days now (the rotation is day mod 7, which is the weekday: Thursday friend-f ... Wednesday friend-b), friend-b the seventh. It was six days, 13/10 to 18/10/2026, with friend-e on the 13th.
test("real build: top-picks has films on every one of seven consecutive days (13/10 to 19/10/2026), the friend of the day each time, friend-f, friend-g and friend-b included", { timeout: 900000 }, () => {
  const { work } = build();
  const expected = ["friend-c", "friend-b", "friend-f", "friend-g", "friend-a", "friend-e", "friend-d"];
  const days = ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"];
  const sizes = [], short = [];
  days.forEach((date, i) => {
    const out = path.join(work, `day-${date}`);
    const r = spawnSync(process.execPath, BUILD_ARGS(date, out, work), BUILD_OPTS);
    assert.equal(r.status, 0, (r.stderr || "") + (r.stdout || "").slice(-1500));
    if (!new RegExp(`friend of the day ${expected[i]} \\(`).test(r.stdout)) short.push(`${date}: the friend of the day is not ${expected[i]} with films (${(/friend of the day [^\n]*/.exec(r.stdout) || ["none"])[0]})`);
    const j = decode(JSON.parse(fs.readFileSync(path.join(out, "data", "index-v2-row-top-picks.json"), "utf8")));
    sizes.push(j.rows["top-picks"].length);
    // 13/10 caches: 55, 60, 60, 41, 49, 60. The spec counted 42 for friend-f before the quality floor; one of them is under it. An empty row (the defect: 0 on his and friend-g's days) is far below 35.
    if (j.rows["top-picks"].length < 35) short.push(`${date} (${expected[i]}): ${j.rows["top-picks"].length} picks`);
    fs.rmSync(out, { recursive: true, force: true });
  });
  assert.deepEqual(short, [], "days with a short or empty top-picks");
  assert.equal(sizes.length, 7);
});

test("real build: a list row's films say neither the list nor the place in it any more (the slice index-v2-row-criterion.json; description v3, 20/10/2026)", { timeout: 300000 }, () => {
  const j = rowFile("criterion");
  assert.equal(j.rowDesc.criterion.length, j.rows.criterion.length);
  j.rowDesc.criterion.forEach((t) => { lineOf("criterion")(t); assert.ok(!/“|#\d/.test(t.split("\n\n")[0]), t.slice(0, 120)); });
  assert.ok(j.rows.criterion.length >= 90);
  const ss = rowFile("sight-sound").rowDesc["sight-sound"];
  ss.forEach((t) => { lineOf("sight-sound")(t); assert.ok(!/“|#\d/.test(t.split("\n\n")[0]), t.slice(0, 120)); });
});

test("real build: a film Marco marked 'Not for me' leaves a special row BEFORE the row is cut, so the row refills to its ceiling (criterion 100; friends-split, under its ceiling of 100 since 14/11/2026, loses the film and keeps the rest in order)", { timeout: 600000 }, () => {
  const { work } = build();
  const SN = require("../lib/learning/snapshot"), crypto = require("node:crypto");
  fs.mkdirSync(path.join(ROOT, ".context"), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(ROOT, ".context", "special-feedback-"));
  try {
    const criterion = rowFile("criterion").rows.criterion, split = rowFile("friends-split").rows["friends-split"];
    assert.equal(criterion.length, 100);
    assert.ok(split.length > 20 && split.length < 100, `friends-split has fewer films than its ceiling of 100 (sizes.row since 14/11/2026; 65 on the caches of 14/11/2026): ${split.length}`);
    const at = "2026-10-13T12:00:00.000Z", dir = SN.privateDir(path.join(tmp, "private"), ROOT);
    const event = (filmId) => ({ schemaVersion: 1, eventId: crypto.randomUUID(), type: "not_for_me", filmId, occurredAt: at, sessionId: crypto.randomUUID(), origin: "explicit-import", snapshotId: null, policyId: "baseline-v2", modelId: null, context: { moodId: null, timeLimit: null, kind: "new", safe: 0.3 }, placement: { rowId: null, position: null, candidateSetId: null }, scope: { kind: "film", expiresAt: null }, payload: {}, supersedes: null });
    const input = path.join(tmp, "batch.json");
    fs.writeFileSync(input, JSON.stringify(SN.batch([event(criterion[0]), event(split[0])], [], at)));
    SN.importFeedback(input, dir);
    const out = path.join(tmp, "out");
    const r = spawnSync(process.execPath, BUILD_ARGS("2026-10-13", out, work, ["--private-dir", dir]), BUILD_OPTS);
    assert.equal(r.status, 0, (r.stderr || "") + (r.stdout || "").slice(-1500));
    const read = (id) => decode(JSON.parse(fs.readFileSync(path.join(out, "data", `index-v2-row-${id}.json`), "utf8"))).rows[id];
    const c = read("criterion"), f = read("friends-split");
    assert.ok(!c.includes(criterion[0]) && !f.includes(split[0]), "the marked films are gone");
    assert.equal(c.length, 100, "criterion refilled with the next film");
    assert.deepEqual(f, split.slice(1), "friends-split: the marked film is gone and nothing is missing (with 50 it refilled with the 51st; at 100 every film that qualifies is already there)");
    assert.deepEqual(c.slice(0, 99), criterion.slice(1, 100), "the rest keeps its order");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    try { fs.rmdirSync(path.join(ROOT, ".context")); } catch {}
  }
});

// Found 14/10/2026 (PR5, when config.json took the Board): with the sources off (--skip-friends; a config with no friends and no lists) build.js hands the special rows the stub `none`, whose isSeen
// answers false, so the awards row listed films Marco has watched (12 Angry Men, Belle de Jour, Love Streams, Magnolia, Nomadland) and the guard stopped the build ("Seen films leaked into
// rows: … in awards/v2"). specialStep now uses his own history when there are no sources (seenByYou in build.js). Mutation: `got ? src.isSeen : seenByYou` back to `src.isSeen` → this test is red.
test("real build with the sources off (--skip-friends): the awards row leaves out the films Marco has watched, and the guard has nothing to stop", { timeout: 300000 }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mood-special-off-"));
  try {
    fs.mkdirSync(path.join(work, "cache"));
    for (const n of fs.readdirSync(path.join(ROOT, "cache"))) if (n.endsWith(".json")) fs.copyFileSync(path.join(ROOT, "cache", n), path.join(work, "cache", n));
    const out = path.join(work, "out");
    const r = spawnSync(process.execPath, [path.join(ROOT, "build.js"), "--offline", "--skip-friends", "--skip-posters", "--date", "2026-10-13", "--captured-at", "2026-10-13T12:00:00.000Z", "--board", path.join(__dirname, "fixtures", "board-v2-pr3.json"), "--cache-dir", path.join(work, "cache"), "--out", out], BUILD_OPTS);
    assert.equal(r.status, 0, `the build failed\n${(r.stderr || "").slice(-1500)}\n${(r.stdout || "").slice(-1500)}`);
    const j = decode(JSON.parse(fs.readFileSync(path.join(out, "data", "index-v2-row-awards.json"), "utf8")));
    assert.ok(j.rows.awards.length > 0, "the prize files still give a row");
    const watched = parseCsv(fs.readFileSync(path.join(ROOT, "data", "letterboxd", "watched.csv"), "utf8"));
    const seenTitle = new Map();
    for (const w of watched) (seenTitle.get(norm(w.Name)) || seenTitle.set(norm(w.Name), []).get(norm(w.Name))).push(Number(w.Year));
    const byTt = new Map(j.films.map((f) => [f.tt, f]));
    for (const tt of j.rows.awards) {
      const f = byTt.get(tt);
      assert.ok(!(seenTitle.get(norm(f.name)) || []).some((y) => Math.abs(y - f.year) <= 1), `awards: ${f.name} (${f.year}) is a film Marco has watched`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
