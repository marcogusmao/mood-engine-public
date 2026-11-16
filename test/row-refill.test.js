// node --test            (no dependencies)
// Marco, 13/10/2026: "toda fileira repõe a vaga aberta pelo piso até o teto" — every Board row refills the place the recommendation rule opens, up to its cap, and
// this supersedes the rule of 10/10 ("quality filters the selected items without refill"). It changes the LEGACY rows on purpose: Starting over, Sad and beautiful, New for you,
// Directors you trust, Old friends, the watchlist, Tonight, Because you loved, Friends watched this week, Friends loved, Loved by your directors, From your lists, Short and good.
// The builders take `eligible(imdb id)` and make each row from the films that pass it; Q.applyPlan stays as the net (test/v21-quality-integration.test.js: it still removes without refilling).
// The v2.1 pin (test-support/integration-reference.js floorFirst) holds that the result is the v2.3 selection run over the films that pass the rule.
//
// Mutations this file is meant to turn red (recorded in the commit): a mood row not filtered before its cap; Tonight picking a refused film; the rewatch list not filtered; the pool rows
// (From your lists, Short, New) fed with every film; the week row not asking the rule; the watchlist not asking it.

const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { buildRows } = require("../lib/rows");
const P = require("../lib/pool");
const { compile } = require("../lib/moods");
const { decode } = require("../lib/index-rows");
const CONFIG = require("../config.json");

const ROOT = path.join(__dirname, "..");
let n = 0;
function cand(o = {}) {
  const id = ++n;
  const film = { id, imdb: `tt${String(id).padStart(7, "0")}`, title: `Film ${id}`, year: 1990, runtime: 100, genres: ["Comedy"], keywords: [], directors: [{ id: 9000 + id, name: `Director ${id}` }], countries: ["US"], lang: "en", va: 7, vc: 100, overview: "", poster: null, ...o.film };
  return { id, film, tasteZ: 0, qualityZ: 0, contributions: [], seeds: [], seedIds: new Set(), pins: [], recCount: 0, ...o.cand };
}
const SIZES = { tonight: 10, row: 50, discover: 100, moodRepeatWindow: 30, because: 20, directors: 24, oldFriends: 24, watchlist: 100 };
const CFG = { sizes: SIZES, build: { directors: 15 } };
const MODEL = { stats: new Map() };
const run = (pool, o = {}) => buildRows({ pool, rewatch: [], moods: compile([{ id: "fun", genres: { Comedy: 3 }, minFit: 2 }]), cfg: CFG, model: MODEL, recentSeeds: [], today: "2026-10-13", ...o });
const imdb = (xs) => xs.map((c) => c.film.imdb);

test("a mood row is made from the films that pass the rule: the ten best fail it and the row still has its 100", () => {
  const pool = Array.from({ length: 130 }, (_, i) => cand({ cand: { tasteZ: 300 - i } }));
  const refused = new Set(imdb(pool.slice(0, 10)));
  const eligible = (tt) => !refused.has(tt);
  const { rows, ranked } = run(pool, { eligible });
  assert.equal(rows.fun.length, 100);
  assert.ok(rows.fun.every((it) => eligible(it.id)));
  assert.equal(rows.fun[0].id, pool[10].film.imdb, "the best film that passes leads");
  assert.equal(ranked.fun.length, 130, "the ranked list keeps every film that fits: the picker and the Moods slices apply the rule themselves");
  assert.equal(run(pool).rows.fun.length, 100, "and without a rule (the default) nothing is filtered");
  assert.ok(run(pool).rows.fun.some((it) => refused.has(it.id)));
});

test("Tonight picks only films that pass the rule", () => {
  const pool = Array.from({ length: 40 }, (_, i) => cand({ cand: { tasteZ: 100 - i } }));
  const refused = new Set(imdb(pool.slice(0, 12))); // the twelve best films of the only mood. Until 14/11/2026 Tonight drew from a mood's top twelve, so this was the whole pool of the draw; it draws from the top forty of the films that pass the rule now (config.json tonight.depth), here the 28 that are left
  const { rows } = run(pool, { eligible: (tt) => !refused.has(tt) });
  assert.ok(rows.tonight.length >= 1 && rows.tonight.every((it) => !refused.has(it.id)), "no refused film on Tonight");
});

test("Tonight draws as if a mood none of whose films passes the rule did not exist (the random stream is the same)", () => {
  const A = Array.from({ length: 20 }, (_, i) => cand({ cand: { tasteZ: 40 - i } }));
  const B = Array.from({ length: 20 }, (_, i) => cand({ film: { genres: ["Horror"] }, cand: { tasteZ: 40 - i } }));
  const refusedB = new Set(imdb(B));
  const both = compile([{ id: "fun", genres: { Comedy: 3 }, minFit: 2 }, { id: "scary", genres: { Horror: 3 }, minFit: 2 }, { id: "calm", genres: { Comedy: 3, Drama: 1 }, minFit: 2 }]);
  const one = compile([{ id: "fun", genres: { Comedy: 3 }, minFit: 2 }, { id: "calm", genres: { Comedy: 3, Drama: 1 }, minFit: 2 }]);
  for (const today of ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]) {
    const withB = run([...A, ...B], { moods: both, today, eligible: (tt) => !refusedB.has(tt) }).rows.tonight.map((it) => it.id);
    const without = run([...A], { moods: one, today }).rows.tonight.map((it) => it.id);
    assert.deepEqual(withB, without, today);
  }
});

test("Starting over's neighbours: Because you loved, Directors you trust, the watchlist and Old friends refill too", () => {
  const seed = { tmdbId: 4242, title: "Seed", rating: 5 };
  const pool = Array.from({ length: 30 }, (_, i) => cand({ cand: { tasteZ: 50 - i, seedIds: new Set([seed.tmdbId]), watchlist: true } }));
  const refused = new Set(imdb(pool.slice(0, 5)));
  const eligible = (tt) => !refused.has(tt);
  const rewatch = Array.from({ length: 30 }, (_, i) => ({ film: cand().film, rating: 5, liked: false, lastSeen: "2020-01-01" }));
  const refusedRewatch = new Set(rewatch.slice(0, 10).map((r) => r.film.imdb));
  const trusted = { stats: new Map([["d:1", { type: "director", key: "d:1", n: 3, w: 0.5, avg: 4.5, label: "Dir One" }]]) };
  const dirFilms = Array.from({ length: 6 }, (_, i) => cand({ film: { directors: [{ id: 1, name: "Dir One" }] }, cand: { qualityZ: 10 - i } }));
  const refusedDir = new Set(imdb(dirFilms.slice(0, 2)));
  const out = run([...pool, ...dirFilms], { eligible: (tt) => eligible(tt) && !refusedDir.has(tt) && !refusedRewatch.has(tt), recentSeeds: [seed], rewatch, model: trusted });
  assert.equal(out.rows.because.length, 6, "six per seed: the five refused are replaced by deeper films");
  assert.ok(out.rows.because.every((it) => eligible(it.id)));
  assert.equal(out.rows.watchlist.length, 30 - 5, "the watchlist: the refused five are not in it (it has no more films to fill with)");
  assert.equal(out.rows.directors.length, 3, "the trusted director's three films come from the four that pass the rule (cap of three per director)");
  assert.ok(out.rows.directors.every((it) => !refusedDir.has(it.id)));
  assert.equal(out.rows.oldfriends.length, 20, "of thirty films to see again ten fail the rule; the other twenty fill the row (24 places)");
  assert.ok(out.rows.oldfriends.every((it) => !refusedRewatch.has(it.id)));
});

test("the week row asks the rule itself: a refused film is not in it and the next ones take its place", () => {
  const rec = (i) => ({ id: `tt${String(5000 + i).padStart(7, "0")}`, title: `Pool ${i}`, slug: `p${i}` });
  const recs = Array.from({ length: 12 }, (_, i) => rec(i));
  const refused = new Set(recs.slice(0, 4).map((r) => r.id));
  const view = { films: Object.fromEntries(recs.map((r) => [r.slug, { title: r.title, year: 2026, imdbId: r.id, tmdbId: null }])) };
  const week = new Map(recs.map((r) => [r.slug, [{ name: "Ana", rating: 4, watched: "2026-10-09" }]]));
  const out = P.weekRow({ week, view, isSeen: () => false, size: 6, eligible: (tt) => !refused.has(tt) });
  assert.equal(out.items.length, 6);
  assert.ok(out.items.every((it) => !refused.has(it.id)));
  assert.equal(out.stats.refused, 4);
  assert.equal(P.weekRow({ week, view, isSeen: () => false, size: 6 }).stats.refused, undefined, "without a rule the stats are the ones they were");
});

// ── the real caches ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

let work = null;
after(() => { if (work) for (const w of Object.values(work)) fs.rmSync(w.dir, { recursive: true, force: true }); });
/** A build of the caches of the repository (copied), after `doctor(dir/cache)` has changed the copy; named builds are kept for the whole file. */
function build(name = "main", doctor = null) {
  work ||= {};
  if (work[name]) return work[name].result;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mood-refill-"));
  fs.mkdirSync(path.join(dir, "cache"));
  for (const f of fs.readdirSync(path.join(ROOT, "cache"))) if (f.endsWith(".json")) fs.copyFileSync(path.join(ROOT, "cache", f), path.join(dir, "cache", f));
  if (doctor) doctor(path.join(dir, "cache"));
  const out = path.join(dir, "out");
  const r = spawnSync(process.execPath, [path.join(ROOT, "build.js"), "--offline", "--cache-only", "--skip-posters", "--date", "2026-10-13", "--captured-at", "2026-10-13T12:00:00.000Z", "--cache-dir", path.join(dir, "cache"), "--out", out], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" },
  });
  assert.equal(r.status, 0, `the build failed\n${(r.stderr || "").slice(-1500)}`);
  const ix = decode(JSON.parse(fs.readFileSync(path.join(out, "data", "index.json"), "utf8")));
  work[name] = { dir, result: { ix, log: r.stdout } };
  return work[name].result;
}

test("the real caches, the legacy Board: every row film passes the rule, and the rows the rule used to leave short are full (13/10/2026: Starting over 97 → 100, Sad and beautiful 91 → 100, New for you 49 → 50, Old friends 22 → 24, Because you loved 8 → 20)", { timeout: 300000 }, () => {
  const { ix, log } = build();
  const eligible = new Map(ix.films.map((f) => [f.tt, f.eligible === true]));
  for (const [id, ids] of Object.entries(ix.rows)) for (const tt of ids) assert.ok(eligible.get(tt), `${id}: ${tt} does not pass the rule`);
  // the index is written after the quality net, so the line above cannot tell a builder that asks for the rule from one the net corrects: the build counts what the net removed, and it is nothing
  assert.match(log, /Quality net on the Board rows: 0 film\(s\) removed \(0 expected/, "a builder let a film through that the net had to remove");
  const len = (id) => ix.rows[id].length;
  // Starting over: 100 again since the moods name their compounds (15/11/2026); it was 91, then 83, while the whole-keyword fit had no compounds (14/11/2026)
  assert.equal(len("reinvent"), CONFIG.sizes.discover);
  assert.equal(len("letin"), CONFIG.sizes.discover);
  assert.equal(len("newforyou"), CONFIG.sizes.row);
  assert.equal(len("watchlist"), CONFIG.sizes.watchlist);
  assert.equal(len("oldfriends"), CONFIG.sizes.oldFriends);
  assert.equal(len("tonight"), CONFIG.sizes.tonight);
});

test("the real caches, with the rule refusing the best films of From your lists, Short, Friends this week and Loved by your directors: the rows hold none of them, the net removes nothing", { timeout: 300000 }, () => {
  const base = build();
  const friends = JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "friends.json"), "utf8"));
  // a film a configured friend rated 3.5 or more passes the rule by that rating whatever the average says: those are not the films to refuse
  const liked = new Set();
  for (const u of Object.values(friends.users)) for (const f of u.films) if (f[3] >= 3.5) liked.add(f[0]);
  const imdbOf = new Map(Object.entries(friends.films).map(([slug, r]) => [r.imdbId, slug]));
  const rows = ["fromlists", "short", "friends-week", "directors-loved"];
  const refused = new Set(rows.flatMap((id) => base.ix.rows[id].filter((tt) => !liked.has(imdbOf.get(tt))).slice(0, 3)));
  assert.ok(refused.size >= 9, `${refused.size} films to refuse`);
  const doctored = build("refused", (cache) => {
    const file = path.join(cache, "friends.json"), j = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const r of Object.values(j.films)) if (refused.has(r.imdbId)) r.r = 1; // a Letterboxd average of 1.0: under 3.5, under the vouched 2.5 too
    fs.writeFileSync(file, JSON.stringify(j));
  });
  for (const id of rows) for (const tt of refused) assert.ok(!doctored.ix.rows[id].includes(tt), `${id} still holds ${tt}, which the rule refuses`);
  for (const id of ["fromlists", "short"]) assert.equal(doctored.ix.rows[id].length, base.ix.rows[id].length, `${id} refilled to its length`);
  assert.match(doctored.log, /Quality net on the Board rows: 0 film\(s\) removed \(0 expected/, "and no builder left it to the net");
});
