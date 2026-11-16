// node --test
// The private learning experiment's list films are joined to TMDB the way production joins them (review of catalog-expansion, security
// finding 3; written 11/10/2026, landed 13/10/2026 in branch v24-hardening). build.js runSources' shadowSources took `tmdb.peek(record.tmdbId)` for every `kind: "list"` item: an
// old Letterboxd record of a series names a TV id, and the TMDB movie with that number is another film (paranoia-agent → 9343,
// Fitzcarraldo). lib/learning/candidates.js union() then either dropped the film as a conflict (the two IMDb ids differ) or, when the
// wrong record had no IMDb id, paired the series' IMDb id with it (maniac-2018 → 73411, a Titan FC event). The v2-pool items of the same
// snapshot had the same fault through the pool's `detail`. Measured on origin/main with the 13/10/2026 caches: lib/tmdb-identity.js already
// drops the wrong id for the list items whose movie the cache holds, and the pool's `detail` still paired 3 films with another film's record
// (tt0204394 → 318693, tt5580146 → 73411, tt8101850 → 86340): the real-build test below is red there and green here.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const LW = require("../lib/list-signal");

const ROOT = path.join(__dirname, "..");
const have = ["friends.json", "lists.json", "tmdb.json"].every((f) => fs.existsSync(path.join(ROOT, "cache", f)));

test("joinListFilms: a claimed TMDB id counts only when its record carries the page's IMDb id; otherwise /find, otherwise nothing", async () => {
  const films = {
    "paranoia-agent": { imdbId: "tt0433722", tmdbId: 9343 }, // a series' TV id: movie 9343 is Fitzcarraldo
    "maniac-2018": { imdbId: "tt5580146", tmdbId: 73411 }, // movie 73411 has no IMDb id at all
    "the-godfather": { imdbId: "tt0068646", tmdbId: 238 },
    "by-find": { imdbId: "tt0000009", tmdbId: 5 },
    gone: { imdbId: null, gone: true },
    "gone-with-imdb": { imdbId: "tt0000011", tmdbId: 238, gone: true }, // a page that is gone is not joined, whatever it names
    "no-imdb": { imdbId: null, tmdbId: 238 }, // no IMDb id on the page: nothing to confirm a claim against
  };
  const movies = { 9343: { imdb: "tt0083946" }, 73411: { imdb: null }, 238: { imdb: "tt0068646" }, 5: { imdb: "tt9999999" } };
  const j = await LW.joinListFilms([{ items: Object.keys(films).map((slug) => ({ slug })) }], films, { movie: async (id) => movies[id] || null, fromImdb: async (tt) => (tt === "tt0000009" ? 77 : null) });
  assert.equal(j.tmdbOf("tt0433722"), null);
  assert.equal(j.tmdbOf("tt5580146"), null);
  assert.equal(j.tmdbOf("tt0068646"), 238);
  assert.equal(j.tmdbOf("tt0000009"), 77);
  assert.equal(j.tmdbOf(undefined), null);
  assert.deepEqual(j.counts, { confirmed: 1, viaFind: 1, refused: 3, missing: 2, refusedFound: 1 });
});

// 13/10/2026: build.js now catches a capture that throws (snapshot failed, publish goes on), so the fake can no longer stop the build by throwing from capture; it returns a dummy path and the build is stopped by readSources, the first call after the shadow block that is outside any try.
/** Runs the real build.js (offline, cache only, learning shadow) in a sandbox and returns the snapshot's candidates and union()'s counts. */
async function shadowCapture() {
  const SN = require("../lib/learning/snapshot"), C = require("../lib/learning/candidates");
  const source = fs.readFileSync(path.join(ROOT, "build.js"), "utf8");
  const readonlyFS = new Proxy(fs, { get(t, n) { if (["writeFileSync", "mkdirSync", "renameSync", "rmSync", "unlinkSync", "appendFileSync", "copyFileSync", "cpSync"].includes(n)) return () => { throw new Error("Unexpected write"); }; return t[n]; } });
  let result, stats, sources, failure, finish;
  const done = new Promise((r) => (finish = r));
  const ctx = {
    require: (id) => id === "fs" ? readonlyFS
      : id === "./lib/learning/snapshot" ? { ...SN, privateDir: (x) => x, readFeedback: () => SN.batch([]), capture: (o) => { result = o; return "/never/written"; }, writePrivate: () => {}, readSources: () => { throw new Error("CAPTURED_IN_MEMORY"); } }
      : id === "./lib/learning/candidates" ? { ...C, union: (...a) => { sources = a[0]; const u = C.union(...a); stats = u.stats; return u; } }
      : require(id.startsWith("./") ? path.join(ROOT, id) : id),
    __dirname: ROOT, Date, URL, URLSearchParams, Buffer, AbortController, AbortSignal, setTimeout, clearTimeout,
    fetch: () => { throw new Error("Unexpected network"); },
    console: { log() {}, warn() {}, error: (x) => (failure = x) },
    process: { env: { ...process.env, OFFLINE: "1", MOOD_DATE: "2026-10-11" }, argv: [process.execPath, path.join(ROOT, "build.js"), "--offline", "--cache-only", "--learning", "shadow", "--out", path.join(require("os").tmpdir(), "shadow-join-out-never-written"), "--private-dir", path.join(ROOT, ".context", "shadow-join-test")], version: process.version, memoryUsage: () => process.memoryUsage(), exit: () => finish() },
  };
  const prev = process.env.OFFLINE; process.env.OFFLINE = "1";
  try { vm.runInNewContext(source, ctx); await done; } finally { if (prev === undefined) delete process.env.OFFLINE; else process.env.OFFLINE = prev; }
  assert.ok(result, `build did not reach the snapshot: ${failure}`);
  return { candidates: result.candidates, stats, sources };
}

test("the real build's private snapshot pairs no IMDb id with another film's TMDB record, and drops no list film as a conflict", { skip: !have, timeout: 300000 }, async () => {
  const { candidates, stats, sources } = await shadowCapture();
  const tmdb = JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "tmdb.json"), "utf8"));
  // a candidate's TMDB record, as the cache holds it, must name the candidate's own IMDb id (union() fills a missing one: read the cache)
  const paired = candidates.filter((c) => c.film && c.film.id && tmdb.movie[c.film.id]?.v && tmdb.movie[c.film.id].v.imdb !== c.filmId);
  assert.deepEqual(paired.map((c) => `${c.filmId} → ${c.film.id} ${c.film.title}`), []);
  // before the fix the list items whose record named a TV id (42 on the 11/10 caches) reached union() with another film and were dropped
  assert.equal(stats.conflicts, 0, "a list film dropped because its TMDB record names another IMDb id");
  // the control: the caches still hold such records, so the two checks above measure something
  const friends = JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "friends.json"), "utf8"));
  const lists = JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "lists.json"), "utf8"));
  let wrong = 0;
  for (const l of Object.values(lists.lists)) for (const [slug] of l.items) { const r = friends.films[slug]; const p = r && r.imdbId && r.tmdbId && tmdb.movie[r.tmdbId]?.v; if (p && p.imdb !== r.imdbId) wrong++; }
  assert.ok(wrong > 0, "the caches have no list record naming another film's TMDB id: this test would prove nothing");

  // The part main's lib/tmdb-identity.js (12/10/2026) does not do: it only drops the wrong id, leaving the film with no record. Here the join
  // goes on to /find, so a list film whose page named another film's id, and whose own movie the cache holds under /find, gets that record
  // (13/10/2026: 4 such films — broken-saints, the-deliberate-stranger, france-tour-detour-two-children, penance-2012). Mutations of this
  // wiring (the claim used unchecked, /find not consulted) are caught only here.
  const recoverable = new Map();
  for (const l of Object.values(lists.lists)) for (const [slug] of l.items) {
    const r = friends.films[slug];
    if (!r || !r.imdbId || !r.tmdbId || recoverable.has(r.imdbId)) continue;
    const named = tmdb.movie[r.tmdbId]?.v, found = tmdb.find[r.imdbId]?.v;
    if (named && named.imdb !== r.imdbId && found && tmdb.movie[found]?.v?.imdb === r.imdbId) recoverable.set(r.imdbId, found);
  }
  // read on the list sources themselves, before union() merges them with the pool's own record of the same film (which would hide a wrong join)
  const listItems = new Map();
  for (const src of sources.filter((x) => x.kind === "list")) for (const it of src.items) if (it.filmId && !listItems.has(it.filmId)) listItems.set(it.filmId, it.film);
  const wrongItems = [...listItems].filter(([tt, film]) => film && film.imdb && film.imdb !== tt).map(([tt, film]) => `${tt} → ${film.id}`);
  assert.deepEqual(wrongItems, [], "a list source item carries another film's TMDB record");
  const present = [...recoverable].filter(([tt]) => listItems.has(tt));
  for (const [tt, id] of present) assert.equal(listItems.get(tt) && listItems.get(tt).id, id, `${tt} must carry the record /find names (${id}), not nothing and not the page's wrong id`);
  assert.ok(recoverable.size === 0 || present.length > 0, `the ${recoverable.size} recoverable list films are none of them in a list source: this part would prove nothing`);
});
