// lib/friends-records.js and the `unrecorded` option of lib/rows.js buildFriendRows (Marco, 22/10/2026 ~21:40 UTC, frente friends-cards). No network: every ask goes to a fake fetchImpl.
// Written against: 25 of the 243 cards of the friends' rows of the live Board (22/10/2026 ~21:30 UTC) with no credits line (Intermissions tt0430059, Inside Out 2 tt22022452, Happy Feet, Demolition ...):
// the films were in no cache/tmdb.json record because only the pool and the rows' own items were ever fetched; and three SERIES typed as films in those rows (Ripley tt11016042, The Queen's Gambit
// tt10048342, Scenes from a Marriage 2021 tt12682218), two of which `find` was never asked about, so lib/tmdb.js noRecord could not tell. Decision of Marco, 22/10/2026 (questionnaire): "Esconder séries
// das fileiras de filmes dos amigos". The build-level test is test/friends-cards-build.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Tmdb } = require("../lib/tmdb");
const FR = require("../lib/friends-records");
const F = require("../lib/friends");
const { buildFriendRows } = require("../lib/rows");

const noSleep = async () => {};
const quiet = () => {};
function online(fn) { // the tests never run with OFFLINE set unless they say so
  const prev = process.env.OFFLINE; delete process.env.OFFLINE;
  const restore = () => { if (prev !== undefined) process.env.OFFLINE = prev; };
  let r;
  try { r = fn(); } catch (e) { restore(); throw e; }
  return r && typeof r.then === "function" ? r.finally(restore) : (restore(), r);
}
const tmp = (cache) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "me-friends-records-"));
  const file = path.join(dir, "tmdb.json");
  fs.writeFileSync(file, JSON.stringify({ movie: {}, recs: {}, person: {}, find: {}, search: {}, ...cache }));
  return file;
};
const json = (o) => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(o) });
const gone = { status: 404, ok: false, headers: { get: () => null } };
/**
 * A fake TMDB. `movies`: tmdb id → imdb id of the film under that number (absent = 404, TMDB has no movie of that number); `finds`: imdb id → the movie number /find answers (absent = no movie result).
 * A movie answers with a director and three actors, so a card made from it has a credits line.
 */
function fakeTmdb({ movies = {}, finds = {} } = {}) {
  const calls = [];
  const impl = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname);
    const parts = u.pathname.split("/");
    if (parts[2] === "find") {
      const id = finds[parts[3]];
      return json({ movie_results: id ? [{ id }] : [], tv_results: [{ id: 1 }] });
    }
    if (parts[2] === "movie") {
      const id = Number(parts[3]);
      if (!movies[id]) return gone;
      return json({ id, title: `Film ${id}`, release_date: "2001-02-03", runtime: 116, external_ids: { imdb_id: movies[id] }, credits: { crew: [{ job: "Director", id: 9, name: `Director ${id}` }], cast: [1, 2, 3].map((n) => ({ id: n, name: `Actor ${id}-${n}` })) }, videos: { results: [] } });
    }
    return gone;
  };
  impl.calls = calls;
  return impl;
}
const client = (cache, impl) => online(() => new Tmdb("v3key", tmp(cache), { fetchImpl: impl, sleepImpl: noSleep, log: quiet }));
const record = (id, imdb) => ({ id, imdb, title: `Film ${id}`, year: 2001, date: "2001-02-03", runtime: 100, genres: [], keywords: [], directors: [{ id: 9, name: "D" }], cast: [{ id: 1, name: "A" }], countries: [], lang: "en", va: 7, vc: 1, pop: 1, overview: "", poster: null, backdrop: null, status: "Released", trailer: null });
const t = Date.now();

test("stateOf: own / empty / pending, read from the cache and asking nothing", () => {
  const tm = client({
    movie: { 11: { t, v: record(11, "tt0000011") }, 22: { t, v: null }, 33: { t, v: record(33, "tt0000099") }, 44: { t, v: record(44, "tt0000033") } },
    find: { tt0000022: { t, v: null }, tt0000033: { t, v: 44 }, tt0000055: { t, v: 66 } },
  }, fakeTmdb());
  const s = (imdb, tmdbId) => FR.stateOf(tm, { imdb, tmdbId });
  assert.equal(s("tt0000011", 11), "own", "the record Letterboxd names is the film's own");
  assert.equal(s("tt0000022", 22), "empty", "the movie under Letterboxd's id is empty and find was asked and is empty: a series, an episode");
  assert.equal(s("tt0000033", 33), "own", "Letterboxd's id names another film (33 is tt0000099); find gave 44, whose record is the film's own");
  assert.equal(s("tt0000077", 77), "pending", "the TMDB id Letterboxd names was never asked");
  assert.equal(s("tt0000077", null), "pending", "no id at all and find never asked");
  assert.equal(s("tt0000022", null), "empty", "no Letterboxd id, find asked and empty");
  assert.equal(s("tt0000055", null), "pending", "find has an id (66) and its movie was never fetched");
  assert.equal(s("tt0000088", 22), "pending", "an empty movie under Letterboxd's id does not close it: find was never asked (the film may sit under another number)");
  assert.deepEqual(FR.pending(tm, [{ imdb: "tt0000011", tmdbId: 11 }, { imdb: "tt0000077", tmdbId: 77 }, { imdb: "nope", tmdbId: 5 }, { id: "tt0000077", tmdb: 77 }]).map((f) => f.imdb), ["tt0000077"], "pending(): valid ids only, each film once, items { id, tmdb } accepted");
});

test("fillRecords: a film missing from the cache gets its TMDB record (the credits line), a series is found to have none, a wrong Letterboxd id is corrected by find, a known film costs nothing", async () => {
  const fetch = fakeTmdb({
    movies: { 101: "tt0000101", 303: "tt0000999", 404: "tt0000303" }, // 101: Intermissions-like; 303: the number Letterboxd names for tt0000303 is ANOTHER film; 404: tt0000303's real movie
    finds: { tt0000303: 404 },                                          // tt0000202 (a series) and tt0000404 (an episode): find has no movie
  });
  const tm = client({ movie: { 505: { t, v: record(505, "tt0000505") } } }, fetch);
  const films = [{ imdb: "tt0000101", tmdbId: 101 }, { imdb: "tt0000202", tmdbId: 202 }, { imdb: "tt0000303", tmdbId: 303 }, { imdb: "tt0000505", tmdbId: 505 }, { imdb: "tt0000404", tmdbId: null }];
  const r = await online(() => FR.fillRecords(tm, films));
  assert.equal(r.films, 4, "the film that already has its record is not touched");
  assert.equal(tm.peek(101).imdb, "tt0000101", "the missing record was fetched");
  assert.ok(tm.peek(101).directors.length && tm.peek(101).cast.length, "with the director and the cast the credits line is made of");
  assert.equal(tm.noRecord("tt0000202", 202), true, "the series: the number is empty and find came back empty");
  assert.equal(tm.noRecord("tt0000404", null), true, "a film with no Letterboxd number: find asked, empty");
  assert.equal(tm.peek(404).imdb, "tt0000303", "the wrong number (303 names tt0000999): find found 404 and the record was fetched");
  assert.equal(tm.noRecord("tt0000303", 303), false);
  for (const f of films) assert.notEqual(FR.stateOf(tm, f), "pending", `${f.imdb} is settled`);
  assert.equal(fetch.calls.filter((p) => p === "/3/movie/505").length, 0, "the known film was not asked");
  // a second pass asks nothing: every answer is cached (45 days for a movie, a year for find)
  const before = fetch.calls.length;
  const again = await online(() => FR.fillRecords(tm, films));
  assert.equal(fetch.calls.length, before, "nothing is asked twice");
  assert.equal(again.calls, 0);
});

test("fillRecords: an empty answer past its TTL is asked again and the record that TMDB has since listed comes back; a fresh empty one costs nothing", async () => {
  const day = 864e5;
  const fetch = fakeTmdb({ movies: { 22: "tt0000022", 23: "tt0000023" } }); // TMDB lists both numbers now
  const tm = client({
    movie: { 22: { t: t - 60 * day, v: null }, 23: { t, v: null } }, // 22: empty for 60 days (movies are asked again after 45); 23: empty since today
    find: { tt0000022: { t: t - 400 * day, v: null }, tt0000023: { t, v: null } }, // find: a year
  }, fetch);
  await online(() => FR.fillRecords(tm, [{ imdb: "tt0000022", tmdbId: 22 }, { imdb: "tt0000023", tmdbId: 23 }]));
  assert.equal(tm.peek(22)?.imdb, "tt0000022", "the stale empty movie was asked again and now has its record");
  assert.equal(tm.peek(23), null, "the fresh empty one was not asked");
  assert.deepEqual(fetch.calls, ["/3/movie/22"], "one ask in all: no find for the film that came back, nothing for the fresh empty one (its find is fresh too)");
});

test("fillRecords: offline asks nothing and stores nothing (Tmdb#movie keeps { v: null } in memory for an id nobody asked, and noRecord would hide the film)", async () => {
  const fetch = fakeTmdb({ movies: { 101: "tt0000101" } });
  const tm = client({}, fetch);
  const prev = process.env.OFFLINE;
  process.env.OFFLINE = "1";
  try {
    const r = await FR.fillRecords(tm, [{ imdb: "tt0000101", tmdbId: 101 }]);
    assert.deepEqual(r, { films: 0, calls: 0 });
    assert.equal(tm.cache.movie[101], undefined, "no { v: null } planted in memory for an id nobody asked");
    assert.equal(tm.cache.find.tt0000101, undefined);
    assert.equal(tm.noRecord("tt0000101", 101), false, "so the film is not read as 'TMDB has none'");
    assert.equal(fetch.calls.length, 0);
    const s = await FR.settle(tm, () => [{ id: "tt0000101", tmdb: 101 }], (rows) => rows);
    assert.equal(s.pending, 1, "settle() reports what the nightly will ask");
    assert.equal(s.rounds, 0);
    assert.equal(fetch.calls.length, 0);
  } finally { if (prev === undefined) delete process.env.OFFLINE; else process.env.OFFLINE = prev; }
});

test("settle: a series that find lacks leaves the rows, the next film takes its place and is asked in the next round; capped when the rounds are not enough", async () => {
  // candidates in order: S (series), A, B, C. A row of two: [S, A] -> S leaves -> [A, B] -> B is asked -> done. noRecord is the rule, as in the build.
  const order = [{ tt: "tt0000001", id: 1, series: true }, { tt: "tt0000002", id: 2 }, { tt: "tt0000003", id: 3 }, { tt: "tt0000004", id: 4 }];
  const movies = Object.fromEntries(order.filter((o) => !o.series).map((o) => [o.id, o.tt]));
  const fetch = fakeTmdb({ movies });
  const tm = client({}, fetch);
  const build = () => order.filter((o) => !tm.noRecord(o.tt, o.id)).slice(0, 2).map((o) => ({ id: o.tt, tmdb: o.id }));
  const s = await online(() => FR.settle(tm, build, (rows) => rows));
  assert.deepEqual(s.out.map((i) => i.id), ["tt0000002", "tt0000003"], "the series is out and the row is refilled");
  assert.equal(s.rounds, 2);
  assert.equal(s.films, 3, "S and A in the first round, B in the second");
  assert.equal(s.pending, 0);
  assert.equal(s.capped, false);
  assert.ok(s.out.every((i) => tm.peek(i.tmdb)?.directors.length), "every card of the final row has its record");
  assert.equal(tm.cache.movie[4], undefined, "the film beyond the row (C) was never asked");
  // with one round only, the refill is not asked: capped says so
  const tm2 = client({}, fakeTmdb({ movies }));
  const s2 = await online(() => FR.settle(tm2, () => order.filter((o) => !tm2.noRecord(o.tt, o.id)).slice(0, 2).map((o) => ({ id: o.tt, tmdb: o.id })), (rows) => rows, { max: 1 }));
  assert.equal(s2.capped, true);
  assert.equal(s2.pending, 1, "B still lacks its record");
});

test("ownDetail with findOf: the number Letterboxd names is another film's, /find found the right movie -> the card reads that record; a record that names another IMDb id is never taken", () => {
  const P = require("../lib/pool");
  const tm = client({
    movie: { 11: { t, v: record(11, "tt0000099") }, 88: { t, v: record(88, "tt0000011") }, 12: { t, v: record(12, "tt0000012") }, 77: { t, v: record(77, "tt0000098") } },
    find: { tt0000011: { t, v: 88 }, tt0000013: { t, v: 77 }, tt0000012: { t, v: 12 } },
  }, fakeTmdb());
  const peek = (id) => tm.peek(id), findOf = (tt) => tm.cache.find[tt]?.v || null;
  assert.equal(P.ownDetail(peek)({ tmdbId: 11, imdbId: "tt0000011" }), null, "without findOf the reader is what it was: the record under 11 is tt0000099's");
  assert.equal(P.ownDetail(peek, findOf)({ tmdbId: 11, imdbId: "tt0000011" })?.id, 88, "with findOf: the record /find found, and it names the film's IMDb id");
  assert.equal(P.ownDetail(peek, findOf)({ tmdbId: null, imdbId: "tt0000011" })?.id, 88, "also with no Letterboxd number");
  assert.equal(P.ownDetail(peek, findOf)({ tmdbId: 12, imdbId: "tt0000012" })?.id, 12, "the Letterboxd number that is the film's own wins");
  assert.equal(P.ownDetail(peek, findOf)({ tmdbId: 11, imdbId: "tt0000013" }), null, "find -> 77 names tt0000098: another film, never taken");
});

test("hidden(): the films noRecord hides and nothing asks again are found and asked: a Letterboxd number that came back empty with /find never asked; one that /find finds a movie for comes back; an unasked film is left alone", async () => {
  const day = 864e5;
  const fetch = fakeTmdb({ movies: { 501: "tt0000501", 903: "tt0000903" }, finds: { tt0000401: 501 } });
  const tm = client({
    movie: { 401: { t, v: null }, 402: { t, v: null }, 403: { t: t - 60 * day, v: null }, 405: { t, v: null }, 600: { t, v: record(600, "tt0000405") } }, // 401: empty, find never asked (a movie exists under 501); 402: empty, find never asked, TMDB has none; 403: empty for 60 days, find asked and empty
    find: { tt0000403: { t, v: null } },
  }, fetch);
  const films = [{ imdb: "tt0000401", tmdbId: 401 }, { imdb: "tt0000402", tmdbId: 402 }, { imdb: "tt0000403", tmdbId: 403 }, { imdb: "tt0000404", tmdbId: 404 }, { imdb: "tt0000903", tmdbId: 903 }, { imdb: "tt0000405", tmdbId: 405 }]; // the last: Letterboxd's number is empty but a cached record under another number names the film (George Harrison: Living in the Material World): the rule does not hide it
  assert.deepEqual(FR.hidden(tm, films).map((f) => f.imdb), ["tt0000401", "tt0000402", "tt0000403"], "the three hidden ones; 404 and 903 were never asked, and tt0000405 is named by a cached record: not here");
  assert.equal(tm.noRecord("tt0000401", 401), true, "hidden today, and no row would ever ask");
  assert.equal(FR.pending(tm, FR.hidden(tm, films)).map((f) => f.imdb).join(), "tt0000401,tt0000402", "two never asked in /find");
  await online(() => FR.fillRecords(tm, FR.hidden(tm, films)));
  assert.equal(tm.noRecord("tt0000401", 401), false, "/find has a movie: the film is back");
  assert.ok(tm.peek(501), "and the movie /find found was fetched");
  assert.equal(tm.noRecord("tt0000402", 402), true, "TMDB has no movie: still out, now with the answer");
  assert.ok(fetch.calls.includes("/3/find/tt0000401") && fetch.calls.includes("/3/find/tt0000402"), "/find asked for both");
  assert.ok(fetch.calls.includes("/3/movie/403"), "the movie answer past its 45 days was asked again");
  assert.ok(!fetch.calls.some((c) => /404|903/.test(c)), "films nobody asked about were not touched");
});

// ── lib/rows.js buildFriendRows: `unrecorded` ────────────────────────────────

const CFG = {
  letterboxd: "me", friends: [{ user: "ana", name: "Ana" }, { user: "bia", name: "Bia" }], friendLists: [{ owner: "ana", slug: "best", name: "Best of Ana" }],
  friendRows: { love: { minFriends: 2, minStars: 4, soloStars: 4.5 }, top: { minStars: 4.5 }, session: { minShared: 1 }, list: {} }, sizes: { friendsDiscover: 60 },
};
const FILMS = {
  film: { title: "A Film", year: 2001, tmdbId: 1, imdbId: "tt0000001", t: 1 },
  show: { title: "A Series", year: 2020, tmdbId: 2, imdbId: "tt0000002", t: 1 },
  other: { title: "Another Film", year: 2003, tmdbId: 3, imdbId: "tt0000003", t: 1 },
};
function view() {
  const cache = F.loadCache("/nonexistent");
  const row = (arr) => arr.map(([slug, rating]) => [slug, FILMS[slug].title, FILMS[slug].year, rating]);
  cache.users.ana = { films: row([["film", 5], ["show", 5], ["other", 4]]), watchlist: [["film", "A Film", 2001], ["show", "A Series", 2020]] };
  cache.users.bia = { films: row([["film", 4.5], ["show", 4.5]]), watchlist: [] };
  cache.lists["ana/best"] = { items: [["show", "A Series", 2020], ["film", "A Film", 2001], ["other", "Another Film", 2003]] };
  cache.films = FILMS;
  cache.me = { slugs: [] };
  return F.viewFriends(cache, CFG);
}
const slugs = (out) => Object.fromEntries(Object.entries(out.rows).map(([id, items]) => [id, items.map((i) => i.slug)]));
const make = (extra = {}) => buildFriendRows({ view: view(), cfg: CFG, isSeen: () => false, onMyWatchlist: () => true, keepEmpty: true, ...extra });

test("buildFriendRows unrecorded: a film TMDB has no movie of is in NO friends row, the Discover collections included, and the others stay; without the option nothing changes", () => {
  const plain = slugs(make());
  const withShow = Object.entries(plain).filter(([, s]) => s.includes("show")).map(([id]) => id);
  assert.ok(withShow.length >= 4, `the series is in the loved, top, watch-together and list rows without the option: ${withShow}`);
  const out = make({ unrecorded: ({ imdbId }) => imdbId === "tt0000002" });
  const rows = slugs(out);
  for (const [id, s] of Object.entries(rows)) assert.ok(!s.includes("show"), `${id} must not hold the series`);
  for (const id of ["friends-love", "friends-top-ana", "friends-list-ana-best"]) assert.ok(rows[id].includes("film"), `${id} keeps the film`);
  assert.deepEqual(rows["friends-list-ana-best"], ["film", "other"], "the list keeps the owner's order without the series");
  assert.equal(out.noRecord, 1, "one film left out, counted once whatever the rows");
  assert.equal(out.stats["friends-top-ana"].droppedNoRecord, 1);
  assert.equal(out.stats["friends-love"].droppedNoRecord, 1);
  // the option is the only thing that hides it: the quality floor (eligible) still does not govern the collections
  const floor = slugs(make({ eligible: (tt) => tt !== "tt0000001" }));
  assert.ok(floor["friends-top-ana"].includes("film"), "eligible() leaves the Discover collections alone (11/10/2026), unrecorded() does not");
});

// Review of friends-cards, 22/10/2026: the week row did not log "(round limit reached)" while the README said every step does. The cap needs a world that never settles, so this reads the wiring of build.js
// (as test/music-all-rows.test.js does): each of the steps that call settle() says when its rounds ran out. Four since 23/10/2026: the pass over the whole lists of the friends' options (the Worker's index) was added.
test("build.js: the four steps that settle() the friends' cards log '(round limit reached)' when the rounds ran out", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "build.js"), "utf8");
  for (const [name, re] of [["friends loved + Discover", /friendRecords\.capped \? " \(round limit reached\)"/], ["the week", /weekRecords\.capped \? " \(round limit reached\)"/], ["the Board's friends rows", /settled\.capped \? " \(round limit reached\)"/], ["the whole lists of the Worker's options", /wholeRecords\.capped \? " \(round limit reached\)"/]])
    assert.match(src, re, name);
  assert.equal((src.match(/FR\.settle\(/g) || []).length, 4, "four callers of settle(): if a fifth appears, it logs its cap too");
});

// Re-verification of a1a4112, 22/10/2026: `findOf` had been given to the `shown` that also feeds P.buildPool and P.listCatalogs; against a build of e2719d5, 249 of 977 files changed (226 of them taste and quality scores, positions and
// Discover cuts), where 23 are expected. Only the friends' rows and the week row read the record /find found. The artefact comparison is in the BACKLOG; this reads the wiring.
test("build.js: the pool and the list catalogs keep the reader of the Letterboxd number; only the friends' rows and the week row follow /find", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "build.js"), "utf8");
  assert.match(src, /const shown = P\.ownDetail\(\(id\) => tmdb\.peek\(id\)\);/, "shown has no findOf");
  assert.match(src, /P\.buildPool\(\{ entries, extra: extraFilms, view, isSeen: seenRec, detail: shown \}\)/, "the pool reads shown");
  assert.match(src, /P\.listCatalogs\(\{ lists: listsRead\.lists, view, isSeen: seenRec, detail: shown,/, "the list catalogs read shown");
  assert.match(src, /const shownFriends = P\.ownDetail\(\(id\) => tmdb\.peek\(id\), \(tt\) => tmdb\.cache\.find\[tt\]\?\.v \|\| null\);/);
  assert.equal((src.match(/detail: shownFriends/g) || []).length, 2, "buildFriendRows and weekRow, no one else");
});
