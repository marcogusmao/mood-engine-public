// Marco, 22/10/2026 ~06:40 UTC (lot 2): a film with NO record in TMDB stays out of the rows until it has one. Written against: East of Eden 2026 (tt21097264, 4.08 on Letterboxd and
// nothing else; TMDB answered `null` for movie 258165 and for `find`) published as the one empty card of the Board, so test/describe.test.js:629 was red on origin/main 281cd27;
// a rule that hid every film the cache lacks (it would never be asked: the friends' rows fetch what they already hold); a getter turned into a snapshot (the film whose record arrives at
// step 5 stays out for the night); the exempt collections losing the film. lib/tmdb.js noRecord, lib/recommendation-quality.js index() `unrecorded` / qualifies `noRecord`.
// The real build (the wiring in build.js, the index keeping the film, the log line) is test/tmdb-no-record-build.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Tmdb } = require("../lib/tmdb");
const Q = require("../lib/recommendation-quality");

const DAY = 864e5;
const tmp = (cache) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "me-norecord-"));
  const file = path.join(dir, "tmdb.json");
  fs.writeFileSync(file, JSON.stringify({ movie: {}, recs: {}, person: {}, find: {}, search: {}, ...cache }));
  return file;
};
const rec = (id, imdb) => ({ id, imdb, title: `Film ${id}`, year: 2000, date: "2000-01-01", runtime: 100, genres: [], keywords: [], directors: [], cast: [], countries: [], lang: "en", va: 7, vc: 100, pop: 1, overview: "o", poster: null, backdrop: null, status: "Released", trailer: null });
const t = Date.now();
/** A cache shaped like the real one on 22/10/2026: the film Letterboxd names under movie 258165 was asked and is empty, and so was `find`. */
const world = () => new Tmdb("v3key", tmp({
  movie: {
    258165: { t, v: null },                       // East of Eden 2026, tt21097264: asked by the TMDB id Letterboxd names, nothing
    894: { t, v: rec(894, "tt0000894") },        // the id Letterboxd names for a SERIES, and the movie under that number is ANOTHER film (The Prisoner, tt0061287 → movie 894)
    777: { t, v: { ...rec(777, null) } },        // a record with no IMDb id under the id Letterboxd names (Undone, tt8101850 → 86340)
    5: { t, v: rec(5, "tt0092337") },            // Dekalog: the record is cached under an id that is not the one Letterboxd names (343824)
    6: { t, v: rec(6, "tt0099997") },            // a film named by a cached record while the id Letterboxd names (258165) is empty and find was never asked
  },
  find: {
    tt21097264: { t, v: null },                  // asked by IMDb id: nothing
    tt0061287: { t, v: null },                   // The Prisoner: find asked on 22/10/2026, nothing (as for Undone, Maniac and The Iceman Cometh in the real cache)
    tt8101850: { t, v: null },                   // Undone
    tt0070000: { t, v: null },                   // a series: find asked, nothing, and no Letterboxd TMDB id at all
    tt0092337: { t, v: 5 },                      // find has an id
    tt0099996: { t, v: 99996 },                  // find has an id and no movie of it is cached (TMDB knows the film; the build fetches the record)
  },
}));

test("noRecord: no record OF ITS OWN — find asked and empty, or the movie under the Letterboxd TMDB id empty (another film's record under that id does not save a film whose find came back empty)", () => {
  const tm = world();
  assert.equal(tm.noRecord("tt21097264", 258165), true, "East of Eden: movie 258165 and find are both empty");
  assert.equal(tm.noRecord("tt21097264", null), true, "find alone is enough");
  assert.equal(tm.noRecord("tt0070000", null), true, "a series: find asked, empty, no TMDB id");
  assert.equal(tm.noRecord("tt0099999", 258165), true, "the TMDB id Letterboxd names was asked and is empty, find not asked");
  // 22/10/2026, review: the cache's `find` came back empty for The Prisoner, Undone, Maniac and The Iceman Cometh, and the movie under the id Letterboxd names is another film's (or has no IMDb id): they are
  // films with no record of their own and they LEAVE the rows (44 of the 109 films that lost `eligible` took this path). A rule that let any record under that id save the film is a different rule.
  assert.equal(tm.noRecord("tt0061287", 894), true, "The Prisoner: find empty, and the movie under 894 is another film's");
  assert.equal(tm.noRecord("tt8101850", 777), true, "Undone: find empty, and the record under 777 names no IMDb id");
});

test("noRecord: a film nobody asked about, a record that exists and a film find knows are NOT 'no record'", () => {
  const tm = world();
  assert.equal(tm.noRecord("tt0099998", null), false, "never asked: the build asks for it tonight; hiding it would keep it from ever being asked");
  assert.equal(tm.noRecord("tt0099998", 424242), false, "a TMDB id the cache never fetched is not an empty answer");
  assert.equal(tm.noRecord("tt0092337", 343824), false, "Dekalog: a cached movie names the IMDb id under another TMDB id, and find has an id");
  assert.equal(tm.noRecord("tt0092337", 258165), false, "the record named by the IMDb id wins over an empty movie of the Letterboxd id");
  assert.equal(tm.noRecord("tt0099996", 258165), false, "find has an id: TMDB knows the film even if its movie is not cached yet");
  assert.equal(tm.noRecord("tt0099997", 258165), false, "the same with find never asked: the cached record that names the film decides");
  // The same state as The Prisoner and Undone above, but `find` was never asked: the rule cannot tell, so the film stays. WHICH series stays out therefore depends on whether `find` was asked about it
  // (it is asked for the films of the lists, the pins and the search link, not for the rest): 10 films of the pool on 22/10/2026 (BACKLOG, "STILL OPEN").
  assert.equal(tm.noRecord("tt0061288", 894), false, "another film's record under the id Letterboxd names, find never asked: unknown, it stays");
  assert.equal(tm.noRecord("tt8101851", 777), false, "a record with no IMDb id under that id, find never asked: unknown, it stays");
  for (const bad of [null, undefined, "", "21097264", "nm0000001"]) assert.equal(tm.noRecord(bad, 258165), false, `not an IMDb title id: ${String(bad)}`);
});

test("noRecord follows the cache while a run writes it: the night that renews an empty movie and finds a record brings the film back", async () => {
  // 22/10/2026: the answer is cached for 45 days (movie) and 365 (find); a renewal that finds the film must be seen at once, in the same run (the index of named IMDb ids is rebuilt after a write).
  const old = Date.now() - 46 * DAY, oldFind = Date.now() - 400 * DAY;
  const file = tmp({ movie: { 258165: { t: old, v: null } }, find: {} });
  const prev = process.env.OFFLINE; delete process.env.OFFLINE;
  try {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ id: 258165, title: "East of Eden", release_date: "2026-01-01", external_ids: { imdb_id: "tt21097264" } }) }; };
    const tm = new Tmdb("v3key", file, { fetchImpl, sleepImpl: async () => {}, log: () => {} });
    assert.equal(tm.noRecord("tt21097264", 258165), true, "before: the cached answer is empty (this also builds the index of named ids)");
    await tm.movie(258165);
    assert.equal(calls.length, 1, "the stale empty answer was asked again");
    assert.equal(tm.noRecord("tt21097264", 258165), false, "after: the record names the film");
    // and find, which is read from the cache directly
    const tm2 = new Tmdb("v3key", tmp({ find: { tt0070000: { t: oldFind, v: null } } }), { fetchImpl: async () => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ movie_results: [{ id: 70000 }] }) }), sleepImpl: async () => {}, log: () => {} });
    assert.equal(tm2.noRecord("tt0070000", null), true);
    await tm2.fromImdb("tt0070000");
    assert.equal(tm2.noRecord("tt0070000", null), false, "find returned an id");
    // a record stored under ANOTHER TMDB id than the one Letterboxd names (the pool reaches it through find): the index of named ids has to notice it
    const fetchOther = async () => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ id: 777000, title: "East of Eden", release_date: "2026-01-01", external_ids: { imdb_id: "tt21097264" } }) });
    const tm3 = new Tmdb("v3key", tmp({ movie: { 258165: { t: Date.now(), v: null } } }), { fetchImpl: fetchOther, sleepImpl: async () => {}, log: () => {} });
    assert.equal(tm3.noRecord("tt21097264", 258165), true, "the id Letterboxd names is empty and nothing else names the film");
    await tm3.movie(777000);
    assert.equal(tm3.noRecord("tt21097264", 258165), false, "another movie, fetched in this run, names it: the film has a record");
  } finally { if (prev !== undefined) process.env.OFFLINE = prev; }
});

// ── the rule ────────────────────────────────────────────────────────────────

const view = (films, extra = {}) => ({ films, users: [], ...extra });
const NONE = ({ imdbId }) => imdbId === "tt1" || imdbId === "tt5"; // the tts TMDB has no record of

test("the rule refuses a film with no TMDB record whatever its average, its friends or its vouching; the same film with a record passes (control)", () => {
  const films = { a: { imdbId: "tt1", tmdbId: 11, r: 4.08 }, b: { imdbId: "tt2", tmdbId: 12, r: 4.08 }, c: { imdbId: "tt3", tmdbId: 13, r: 3.0 }, d: { imdbId: "tt4", tmdbId: 14, r: 3.0 } };
  const v = view(films, { users: [{ user: "friend", name: "Friend", films: new Map([["a", { rating: 5 }], ["b", { rating: 5 }]]) }] });
  const vouched = new Map([["tt1", { list: "Critics", trust: "critic" }], ["tt2", { list: "Critics", trust: "critic" }], ["tt3", { list: "Critics", trust: "critic" }]]);
  const without = Q.index(v, { vouched, unrecorded: NONE });
  const control = Q.index(v, { vouched });
  assert.equal(Q.qualifies(without.get("tt1")), false, "East of Eden: 4.08, a friend's 5★ and a critics' list, no record");
  assert.equal(Q.qualifies(control.get("tt1")), true, "control: the same film, rule undone (no `unrecorded`), passes");
  assert.equal(Q.qualifies(without.get("tt2")), true, "tt2 has a record: passes on the same numbers");
  assert.equal(Q.qualifies(without.get("tt3")), true, "a vouched film with a record still passes by the exception");
  assert.equal(Q.qualifies(without.get("tt4")), false, "and a film with a record under the floor is still refused for the floor");
  assert.equal(Q.reason(without.get("tt1")), null, "no reason is given for a film the rule refuses");
  assert.equal(Q.planReason(without.get("tt1")), null);
});

test("the answer is read when the rule is asked, not when the index is made (a record that arrives at step 5 of the night counts at once)", () => {
  let missing = true;
  const ratings = Q.index(view({ a: { imdbId: "tt1", tmdbId: 11, r: 4.08 } }), { unrecorded: () => missing });
  assert.equal(Q.qualifies(ratings.get("tt1")), false);
  missing = false;
  assert.equal(Q.qualifies(ratings.get("tt1")), true, "same index, the cache changed");
  assert.equal(Q.qualifies({ ...ratings.get("tt1"), cv: 1 }), true, "a copy of the entry (build.js listEntry spreads it) carries the answer it had");
  missing = true;
  assert.equal(Q.qualifies({ ...ratings.get("tt1") }), false);
});

test("a film with several Letterboxd pages is without a record only if every page's TMDB id says so; a loved film Letterboxd never showed is asked by its IMDb id alone", () => {
  const unrecorded = ({ tmdbId }) => tmdbId !== 22;
  const ratings = Q.index(view({ one: { imdbId: "tt1", tmdbId: 11, r: 4 }, two: { imdbId: "tt1", tmdbId: 22, r: 4.2 } }), { unrecorded });
  assert.equal(Q.qualifies(ratings.get("tt1")), true, "one page's TMDB id has a record");
  const loved = Q.index(view({}), { loved: new Map([["tt9", { list: "Loved", trust: "director", why: "Loved by X" }]]), unrecorded: ({ imdbId }) => imdbId === "tt9" });
  assert.equal(Q.qualifies(loved.get("tt9")), false, "vouched by a director's love, and TMDB has no record");
  // a loved film that Letterboxd DID show is asked with its page's TMDB id only: asked also with null, "every" would meet a record-less null and the film would pass
  const again = Q.index(view({ a: { imdbId: "tt9", tmdbId: 90, r: 4 } }), { loved: new Map([["tt9", { list: "Loved", trust: "director" }]]), unrecorded: ({ tmdbId }) => tmdbId === 90 });
  assert.equal(Q.qualifies(again.get("tt9")), false, "its page's TMDB id (90) has no record, and that is the only id it is asked with");
});

test("refusedForRecord lists the films the record condition alone keeps out (they would pass the rule), not the ones the floor refuses anyway nor the ones with a record", () => {
  const films = { a: { imdbId: "tt1", tmdbId: 11, r: 4.08 }, b: { imdbId: "tt5", tmdbId: 15, r: 3.0 }, c: { imdbId: "tt2", tmdbId: 12, r: 4.5 }, d: { imdbId: "tt6", tmdbId: 16, r: 3.0 } };
  const ratings = Q.index(view(films), { vouched: new Map([["tt6", { list: "Critics", trust: "critic" }]]), unrecorded: NONE });
  assert.deepEqual(Q.refusedForRecord(ratings), ["tt1"], "tt1: 4.08 and no record; tt5: no record but 3.0 and no exception (refused for the floor anyway); tt2 has a record; tt6 has a record");
  assert.deepEqual(Q.refusedForRecord(Q.index(view(films))), [], "the rule undone");
});

test("without `unrecorded` the index is what it was: no `noRecord` key, every film counts as recorded", () => {
  const ratings = Q.index(view({ a: { imdbId: "tt1", tmdbId: 11, r: 4.08 } }));
  assert.deepEqual(ratings.get("tt1"), { lb: 4.08, fr: null, friend: null });
  assert.equal(Q.qualifies({ lb: 4.08, noRecord: false }), true);
  assert.equal(Q.qualifies({ lb: 4.08, noRecord: true }), false);
  assert.equal(Q.qualifies({ lb: 4.08, noRecord: "yes" }), true, "only the boolean true refuses (a stray value is not a statement that TMDB lacks the film)");
});

test("the net and the picker: a film with no record leaves the Board rows, the generated cuts and the picker's data; the three exempt collections keep it", () => {
  const ratings = Q.index(view({ a: { imdbId: "tt1", tmdbId: 11, r: 4.08 }, b: { imdbId: "tt2", tmdbId: 12, r: 4.08 } }), { unrecorded: NONE });
  const items = () => ["tt1", "tt2"].map((id) => ({ id, why: [] }));
  const plan = { board: ["tonight", "watchlist", "newforyou"].map((id) => ({ id, items: items() })), discover: [
    { id: "mood-engine-runtime", options: [{ items: items() }] },
    ...["mood-engine-lists", "mood-engine-lists-unseen", "mood-engine-friends"].map((id) => ({ id, options: [{ items: items() }] })),
  ] };
  Q.applyPlan(plan, ratings);
  for (const row of plan.board) assert.deepEqual(row.items.map((x) => x.id), ["tt2"], row.id);
  assert.deepEqual(plan.discover[0].options[0].items.map((x) => x.id), ["tt2"]);
  for (const c of plan.discover.slice(1)) assert.deepEqual(c.options[0].items.map((x) => x.id), ["tt1", "tt2"], `${c.id}: a list or a friend's collection shows what it holds`);
  const make = (n) => ({ i: `tt${n}`, t: n, n: "Synthetic", f: { lift: 1 }, vc: 100, va: 10, ts: 0, q: 0, r: 90, rating: 4, last: "2024-01-01", why: [] });
  const data = { today: "2026-10-22", tonight: [1, 2], films: [1, 2].map(make), rewatch: [1, 2].map(make) };
  Q.applyWeb(data, ratings);
  assert.deepEqual(data.films.map((x) => x.i), ["tt2"]);
  assert.deepEqual(data.tonight, [2]);
});

// 22/10/2026 (root suite on cf2359d, tests 453 and 468: "Frozen row candidate replay mismatch", fromlists 7,304 against 7,212): PR #73 gave the build the record condition (`unrecorded`) and left the learning
// replay (lib/learning/evaluate.js shadowRows, which makes its own Q.index from the snapshot's frozen files) without it, so every film the build kept out came back as a candidate in the replay and
// any shadow run with the private folder would report `not_evaluated`; the nightly runs with learning off and no `--private-dir`, so no night was affected: the red was in the suite and in manual shadow runs. The replay now asks the same rule of the frozen `cache/tmdb.json` (lib/tmdb.js unrecordedFrom). Neither PR ran the learning tests.
test("unrecordedFrom(cache) answers exactly like Tmdb#noRecord over the same cache (one rule for the build and for the replay of a frozen snapshot)", () => {
  const tm = world();
  const asked = [["tt21097264", 258165], ["tt21097264", null], ["tt0070000", null], ["tt0099999", 258165], ["tt0061287", 894], ["tt8101850", 777], ["tt0092337", 343824], ["tt0099997", 258165], ["tt0099996", 99996], ["tt0000001", null], ["not-an-imdb-id", 5], [null, null]];
  const replay = require("../lib/tmdb").unrecordedFrom(JSON.parse(JSON.stringify(tm.cache)));
  for (const [imdbId, tmdbId] of asked) assert.equal(replay({ imdbId, tmdbId }), tm.noRecord(imdbId, tmdbId), `${imdbId} / ${tmdbId}`);
  assert.equal(replay({ imdbId: "tt21097264", tmdbId: 258165 }), true, "control: the table is not all false (East of Eden has no record)");
  assert.equal(require("../lib/tmdb").unrecordedFrom({})({ imdbId: "tt1", tmdbId: 1 }), false, "a frozen cache with no movie/find tables asked about nothing: nobody lacks a record");
});

test("the learning replay of the row candidates asks the record condition of the frozen TMDB cache: a film the build kept out is not a candidate again (and a film with a record is)", () => {
  const RC = require("../lib/learning/row-candidates"), EV = require("../lib/learning/evaluate");
  const film = { imdb: "tt1", id: 1, title: "Synthetic", genres: ["A"], countries: ["BR"], directors: [], year: 2000, runtime: 90, va: 8, vc: 100 };
  const run = (tmdbCache) => {
    const cfg = { moods: [], build: { directors: 0 }, sizes: { row: 3 }, shortRow: { minMinutes: 40, maxMinutes: 95 }, friends: [], lists: [] };
    const friends = { users: {}, lists: {}, films: { a: { imdbId: "tt1", tmdbId: 11, r: 4.2 } } }; // 4.2 on Letterboxd: passes the 3.5 floor by itself
    const candidates = [{ filmId: "tt1", film, sources: [] }], plan = { board: [{ id: "short", items: [] }], discover: [] };
    // the build side, as build.js hands it: the rule with the record condition from the cache the build held
    const ratings = Q.index({ users: [], films: friends.films }, { unrecorded: ({ imdbId, tmdbId }) => new Tmdb("unused: nothing is asked", tmp(tmdbCache)).noRecord(imdbId, tmdbId) });
    const rows = RC.freezeRows(candidates, [], cfg, "2026-10-10", [], plan.board, ratings, "2026-10-10T21:00:00.000Z");
    const snap = { manifest: { effectiveDate: "2026-10-10", capturedAt: "2026-10-10T21:00:00.000Z" }, bodies: { "baseline.json": { data: { plan, rowCandidates: rows } }, "candidates.json": { records: candidates },
      "inputs.json": { sources: { "config.json": cfg, "cache/friends.json": friends, "cache/lists.json": {}, "cache/tmdb.json": { movie: {}, recs: {}, person: {}, find: {}, search: {}, ...tmdbCache } }, normalized: { history: [] } }, "feedback.json": { events: [] } } };
    return { rows, snap };
  };
  const out = run({ find: { tt1: { t: Date.now(), v: null } } });
  assert.equal(out.rows[0].items.length, 0, "the build kept the film out of the row (find asked, nothing)");
  assert.equal(EV.shadowRows(out.snap).status, "evaluated", "the replay agrees: with the rule missing it freezes 1 candidate against 0 and throws 'Frozen row candidate replay mismatch'");
  const control = run({ movie: { 11: { t: Date.now(), v: rec(11, "tt1") } } });
  assert.equal(control.rows[0].items.length, 1, "control: the same film with a record is a candidate");
  assert.equal(EV.shadowRows(control.snap).status, "evaluated");
});

// Review of friends-cards, 22/10/2026: Dekalog (tt0092337, a series: 572 min on Letterboxd) stayed in "Friends watched this month" against Marco's answer "Esconder séries das fileiras de filmes dos amigos".
// `find` had an id (37452) and the movie under it had been asked and answered 404; noRecord read "find has an id" as "TMDB has the film". Written against that line (lib/tmdb.js noRecordIn: `if (f) return f.v == null`).
test("noRecord: find has an id but the movie under that id was asked and is empty -> no record (Dekalog); an id whose movie is cached or not yet fetched is still a record", () => {
  const tm = new Tmdb("v3key", tmp({
    movie: { 37452: { t, v: null }, 5: { t, v: rec(5, "tt0000005") } },
    find: { tt0092337: { t, v: 37452 }, tt0000005: { t, v: 5 }, tt0099996: { t, v: 99996 } },
  }));
  assert.equal(tm.noRecord("tt0092337", 343824), true, "Dekalog: find -> 37452 and movie 37452 is empty");
  assert.equal(tm.noRecord("tt0092337", null), true, "also with no Letterboxd number");
  assert.equal(tm.noRecord("tt0000005", null), false, "find -> a movie with a record");
  assert.equal(tm.noRecord("tt0099996", null), false, "find -> a movie nobody fetched yet: the build fetches it");
  const U = require("../lib/tmdb").unrecordedFrom(JSON.parse(JSON.stringify(tm.cache)));
  assert.equal(U({ imdbId: "tt0092337", tmdbId: 343824 }), true, "the learning replay's reader (unrecordedFrom) agrees");
});
