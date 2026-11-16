// lib/tmdb.js `trailer` (20/10/2026, Fatia 2.1 of docs/2026-10-20-meta-pagina-de-detalhe-spec.md in the Stremio repo) and scripts/backfill-trailers.js.
// No network: every ask goes to a fake fetchImpl. Written against: a record cached without `trailer` never gets one (the build asked for
// keywords,credits,external_ids only), the trailer picked from the wrong site or type, a budget that overspends, a `trailer: null` asked again every night.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Tmdb, pickTrailer, trim, needsTrailer, videoLanguages, trailerBudgetFrom, TRAILER_BACKFILL_PER_RUN } = require("../lib/tmdb");
const B = require("../scripts/backfill-trailers");

const DAY = 864e5;
const noSleep = async () => {};
const quiet = () => {};
const yt = (key, extra = {}) => ({ site: "YouTube", type: "Trailer", key, official: false, iso_639_1: "fr", published_at: "2020-01-01T00:00:00.000Z", ...extra });

function online(fn) { // the tests never run with OFFLINE set unless they say so
  const prev = process.env.OFFLINE; delete process.env.OFFLINE;
  const restore = () => { if (prev !== undefined) process.env.OFFLINE = prev; };
  let r;
  try { r = fn(); } catch (e) { restore(); throw e; }
  return r && typeof r.then === "function" ? r.finally(restore) : (restore(), r);
}
function tmp(cache) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "me-trailer-"));
  const file = path.join(dir, "tmdb.json");
  if (cache) fs.writeFileSync(file, JSON.stringify(cache));
  return file;
}
const rec = (id, extra = {}) => ({ id, imdb: `tt${id}`, title: `Film ${id}`, year: 2000, date: "2000-01-01", runtime: 100, genres: [], keywords: [], directors: [], cast: [], countries: [], lang: "en", va: 7, vc: 100, pop: 1, overview: "", poster: null, backdrop: null, status: "Released", ...extra });
const cacheOf = (entries) => ({ movie: Object.fromEntries(entries), recs: {}, person: {}, find: {}, search: {} });
const json = (o) => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(o) });
/** A fake TMDB: /movie/<id> answers with `answer(id)` (default: a film with one official English YouTube trailer "TR<id>"). */
function fakeFetch(answer = (id) => ({ id, title: `Film ${id}`, release_date: "2001-02-03", videos: { results: [yt(`TR${id}`, { official: true, iso_639_1: "en" })] } })) {
  const calls = [];
  const impl = async (url) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams) });
    const id = Number(u.pathname.split("/").pop());
    const a = answer(id);
    if (a === 404) return { status: 404, ok: false, headers: { get: () => null } };
    if (a === 500) return { status: 500, ok: false, headers: { get: () => null } };
    if (a === 401) return { status: 401, ok: false, headers: { get: () => null } };
    return json(a);
  };
  impl.calls = calls;
  return impl;
}
const client = (file, fetchImpl, opts = {}) => online(() => new Tmdb("v3key", file, { fetchImpl, sleepImpl: noSleep, log: quiet, ...opts }));

test("pickTrailer: English first, then official, then the most recently published (each criterion alone decides; order changed by Marco, 21/10/2026)", () => {
  // English beats official and recent: an unofficial English trailer is taken over an official French one (before 21/10/2026 it was the other way round)
  assert.equal(pickTrailer({ results: [yt("official-fr", { official: true, published_at: "2024-01-01T00:00:00Z" }), yt("old-en", { iso_639_1: "en", published_at: "2010-01-01T00:00:00Z" })] }), "old-en");
  // among the English, the official one comes first, even if the other is more recent
  assert.equal(pickTrailer({ results: [yt("recent-en", { iso_639_1: "en", published_at: "2024-01-01T00:00:00Z" }), yt("official-en", { iso_639_1: "en", official: true, published_at: "2010-01-01T00:00:00Z" })] }), "official-en");
  // among the others (no English), official beats a more recent unofficial one in the same language
  assert.equal(pickTrailer({ results: [yt("fr-new", { published_at: "2024-01-01T00:00:00Z" }), yt("fr-official-old", { official: true, published_at: "2010-01-01T00:00:00Z" })] }), "fr-official-old");
  // among equals in both, the most recent one
  assert.equal(pickTrailer({ results: [yt("old", { iso_639_1: "en", published_at: "2010-05-01T00:00:00Z" }), yt("new", { iso_639_1: "en", published_at: "2012-05-01T00:00:00Z" }), yt("mid", { iso_639_1: "en", published_at: "2011-05-01T00:00:00Z" })] }), "new");
  // everything equal: the first one TMDB listed; a missing date is the oldest
  assert.equal(pickTrailer({ results: [yt("a", { published_at: undefined }), yt("b", { published_at: undefined })] }), "a");
  assert.equal(pickTrailer({ results: [yt("nodate", { published_at: undefined }), yt("dated")] }), "dated");
});

test("pickTrailer: only YouTube trailers count; nothing to pick is null, never undefined", () => {
  assert.equal(pickTrailer({ results: [{ ...yt("vimeo"), site: "Vimeo" }, { ...yt("teaser"), type: "Teaser" }, { ...yt("clip"), type: "Clip" }, yt("good")] }), "good");
  assert.equal(pickTrailer({ results: [{ ...yt("vimeo", { official: true }), site: "Vimeo" }, { ...yt("teaser", { official: true }), type: "Teaser" }] }), null);
  assert.equal(pickTrailer({ results: [{ ...yt(""), key: "" }, { ...yt(undefined), key: undefined }] }), null, "a video with no key is not a trailer");
  assert.equal(pickTrailer({ results: [] }), null);
  assert.equal(pickTrailer({}), null);
  assert.equal(pickTrailer(undefined), null);
});

test("trim: a record with no `videos` is what it was, plus trailer: null; with videos, the key", () => {
  const d = { id: 7, title: "T", original_title: "T", release_date: "1999-09-09", runtime: 90, genres: [{ name: "Drama" }], keywords: { keywords: [{ name: "Noir" }] },
    credits: { crew: [{ job: "Director", id: 1, name: "D" }], cast: [{ id: 2, name: "A" }] }, production_countries: [{ iso_3166_1: "FR" }], original_language: "fr", vote_average: 7.5, vote_count: 10, popularity: 3,
    overview: "o", poster_path: "/p.jpg", backdrop_path: "/b.jpg", status: "Released", external_ids: { imdb_id: "tt0000007" } };
  const before = { id: 7, imdb: "tt0000007", title: "T", originalTitle: undefined, year: 1999, date: "1999-09-09", runtime: 90, genres: ["Drama"], keywords: ["noir"], directors: [{ id: 1, name: "D" }], cast: [{ id: 2, name: "A" }],
    countries: ["FR"], origin: [], lang: "fr", va: 7.5, vc: 10, pop: 3, overview: "o", poster: "/p.jpg", backdrop: "/b.jpg", status: "Released" };
  // origin: [] after countries since 22/10/2026 (trim() keeps TMDB's origin_country, here absent from the answer; test/origin-country.test.js); this test pinned the key list without it
  const out = trim(d);
  const { trailer, ...rest } = out;
  assert.equal(trailer, null);
  assert.deepEqual(rest, before, "every other field of the published index is unchanged");
  assert.deepEqual(Object.keys(rest), Object.keys(before), "and in the same order (the cache is committed)");
  assert.ok(Object.hasOwn(out, "trailer"), "the key exists: JSON.stringify keeps null and drops undefined");
  assert.equal(trim({ ...d, videos: { results: [yt("ZZ")] } }).trailer, "ZZ");
});

test("movie(): asks for videos in the same request, and saves the key (or null) with the record", async () => {
  const f = fakeFetch((id) => (id === 2 ? { id, title: "No trailer", videos: { results: [] } } : { id, title: "With", videos: { results: [yt("KEY1")] } }));
  const t = client(tmp(), f);
  assert.equal((await t.movie(1)).trailer, "KEY1");
  assert.equal((await t.movie(2)).trailer, null);
  assert.equal(f.calls[0].params.append_to_response, "keywords,credits,external_ids,videos");
  assert.equal(f.calls[0].params.language, "en-US");
  t.save();
  const saved = JSON.parse(fs.readFileSync(t.cacheFile, "utf8"));
  assert.equal(saved.movie[1].v.trailer, "KEY1");
  assert.equal(saved.movie[2].v.trailer, null, "null survives the file; an absent key would not");
});

test("movie(): a fresh record without the trailer key is renewed while the budget lasts; the one after is served from the cache as it is", async () => {
  const now = Date.now();
  const file = tmp(cacheOf([1, 2, 3, 4, 5].map((i) => [i, { t: now - DAY, v: rec(i) }])));
  const f = fakeFetch();
  const t = client(file, f, { trailerBudget: 3 });
  const got = [];
  for (const i of [1, 2, 3, 4, 5]) got.push(await t.movie(i));
  assert.equal(f.calls.length, 3, "asked exactly 3 times");
  assert.deepEqual(got.map((v) => v.trailer), ["TR1", "TR2", "TR3", undefined, undefined]);
  assert.equal(got[3].title, "Film 4", "the 4th is the cached record, untouched");
  assert.equal(Object.hasOwn(t.cache.movie[4].v, "trailer"), false);
  assert.equal(t.trailerBudget, 0);
  assert.equal(t.trailerAsked, 3);
  assert.ok(t.cache.movie[1].t > now - 1000, "a renewed record is dated now");
});

test("movie(): the default budget is 2000, and the 2001st record without a trailer is not asked", async () => {
  assert.equal(TRAILER_BACKFILL_PER_RUN, 2000);
  const now = Date.now();
  const entries = Array.from({ length: 2001 }, (_, i) => [i + 1, { t: now - DAY, v: rec(i + 1) }]);
  const f = fakeFetch();
  const t = client(tmp(cacheOf(entries)), f);
  assert.equal(t.trailerBudget, 2000);
  await Promise.all(entries.map(([id]) => t.movie(id))); // all in flight together: the budget is spent before the first await
  assert.equal(f.calls.length, 2000);
  assert.equal(entries.filter(([id]) => needsTrailer(t.cache.movie[id])).length, 1);
});

test("movie(): trailer: null is not renewed before its expiry; an expired record is renewed whatever the budget", async () => {
  const now = Date.now();
  const f = fakeFetch();
  const file = tmp(cacheOf([[1, { t: now - DAY, v: rec(1, { trailer: null }) }], [2, { t: now - DAY, v: rec(2, { trailer: "OLD" }) }], [3, { t: now - 46 * DAY, v: rec(3, { trailer: null }) }]]));
  const t = client(file, f, { trailerBudget: 0 });
  assert.equal((await t.movie(1)).trailer, null);
  assert.equal((await t.movie(2)).trailer, "OLD");
  assert.equal(f.calls.length, 0);
  assert.equal((await t.movie(3)).trailer, "TR3", "past 45 days it is asked again like any record");
  assert.equal(f.calls.length, 1);
});

test("movie(): offline asks nothing, spends no budget and keeps the record", async () => {
  const prev = process.env.OFFLINE; process.env.OFFLINE = "1";
  try {
    const f = fakeFetch();
    const file = tmp(cacheOf([[1, { t: Date.now() - DAY, v: rec(1) }]]));
    const t = new Tmdb("", file, { fetchImpl: f, sleepImpl: noSleep, log: quiet });
    assert.equal((await t.movie(1)).title, "Film 1");
    assert.equal(f.calls.length, 0);
    assert.equal(t.trailerBudget, 2000);
    assert.equal(Object.hasOwn(t.cache.movie[1].v, "trailer"), false);
  } finally { if (prev === undefined) delete process.env.OFFLINE; else process.env.OFFLINE = prev; }
});

test("movie(): the 429 back-off of the client is the one used for a backfill ask (Retry-After, in seconds)", async () => {
  const sleeps = [];
  let n = 0;
  const f = async () => (n++ === 0 ? { status: 429, ok: false, headers: { get: (h) => (h === "retry-after" ? "3" : null) } } : json({ id: 1, title: "x", videos: { results: [yt("K")] } }));
  const t = client(tmp(cacheOf([[1, { t: Date.now(), v: rec(1) }]])), f, { sleepImpl: async (ms) => { sleeps.push(ms); } });
  assert.equal((await t.movie(1)).trailer, "K");
  assert.deepEqual(sleeps, [3000]);
});

test("movie(): a backfill ask that fails keeps the cached record; a rejected key still stops the run; 20 failures in a row stop the asking", async () => {
  const now = Date.now();
  const entries = Array.from({ length: 30 }, (_, i) => [i + 1, { t: now - DAY, v: rec(i + 1) }]);
  const lines = [];
  const f = fakeFetch(() => 500);
  const t = client(tmp(cacheOf(entries)), f, { log: (l) => lines.push(l) });
  for (const [id] of entries) assert.equal((await t.movie(id)).title, `Film ${id}`, "no throw: the night goes on with the cached record");
  assert.equal(t.trailerFailed, 20);
  assert.equal(t.trailerBudget, 0, "the 20th failure in a row ended the backfill");
  assert.equal(f.calls.length, 20 * 5, "20 films x 5 tries, and then none");
  assert.ok(lines.filter((l) => /not renewed/.test(l)).length <= 10, "the log keeps its first 10");
  assert.ok(lines.some((l) => /stopped: 20 asks failed/.test(l)));
  const bad = client(tmp(cacheOf([[1, { t: now, v: rec(1) }]])), fakeFetch(() => 401));
  await assert.rejects(bad.movie(1), /401/);
});

test("movie(): TMDB answering 404 for a cached film keeps the record, marks it asked (trailer null) and keeps its date", async () => {
  const t0 = Date.now() - 5 * DAY;
  const t = client(tmp(cacheOf([[1, { t: t0, v: rec(1) }]])), fakeFetch(() => 404));
  const v = await t.movie(1);
  assert.equal(v.title, "Film 1");
  assert.equal(v.trailer, null);
  assert.equal(t.cache.movie[1].t, t0);
});

test("trailerBudgetFrom: config.json tmdb.trailerBackfillPerRun; a typo or a wrong value stops the build", () => {
  assert.equal(trailerBudgetFrom(undefined), 2000);
  assert.equal(trailerBudgetFrom({ trailerBackfillPerRun: 500 }), 500);
  assert.equal(trailerBudgetFrom({ trailerBackfillPerRun: 0 }), 0);
  assert.equal(trailerBudgetFrom({ _doc: "x" }), 2000);
  for (const bad of [{ trailerBackfillPerRun: -1 }, { trailerBackfillPerRun: 1.5 }, { trailerBackfillPerRun: "9" }, { trailerBackfill: 5 }, [], "x"]) assert.throws(() => trailerBudgetFrom(bad), /config\.json "tmdb/, JSON.stringify(bad));
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));
  assert.equal(trailerBudgetFrom(cfg.tmdb), 2000, "the committed config carries the key");
});

// ── scripts/backfill-trailers.js ──
function plant() {
  const now = Date.now();
  return cacheOf([
    [10, { t: now - 3 * DAY, v: rec(10) }],                          // never asked
    [11, { t: now - 9 * DAY, v: rec(11) }],                          // never asked, older entry: goes first
    [12, { t: now - 1 * DAY, v: rec(12, { trailer: "HAVE" }) }],     // has one
    [13, { t: now - 1 * DAY, v: rec(13, { trailer: null }) }],       // asked, none
    [14, { t: now - 2 * DAY, v: null }],                             // TMDB said 404 once
    [15, { t: now - 5 * DAY, v: rec(15) }],                          // never asked
  ]);
}

test("backfill-trailers --dry-run: counts the films without the key, asks nothing, writes nothing, needs no key", async () => {
  const file = tmp(plant());
  const before = fs.readFileSync(file, "utf8");
  const lines = [];
  const r = await B.main(["--dry-run", "--cache", file], { env: {}, log: (l) => lines.push(l), fetchImpl: () => { throw new Error("asked"); } });
  assert.equal(r.code, 0);
  assert.equal(r.never, 3);
  assert.equal(r.wouldAsk, 3);
  assert.equal(r.withTrailer, 1); assert.equal(r.nullTrailer, 1); assert.equal(r.noRecord, 1); assert.equal(r.records, 6);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  const capped = await B.main(["--dry-run", "--budget", "2", "--cache", file], { env: {}, log: quiet });
  assert.equal(capped.wouldAsk, 2);
  assert.equal(capped.never, 3);
  assert.deepEqual(B.pending(JSON.parse(before)), ["11", "15", "10"], "oldest cache entry first");
});

test("backfill-trailers: asks the budgeted films through Tmdb.movie, counts, and writes the cache in the build's format", async () => {
  const file = tmp(plant());
  const fakeKey = `fake-${"x".repeat(12)}`;
  const f = fakeFetch((id) => (id === 15 ? { id, title: "none", videos: { results: [] } } : { id, title: `Film ${id}`, videos: { results: [yt(`TR${id}`)] } }));
  const lines = [];
  const r = online(() => B.main(["--budget", "2", "--cache", file], { env: { TMDB_TOKEN: fakeKey }, log: (l) => lines.push(l), fetchImpl: f, sleepImpl: noSleep }));
  const res = await r;
  assert.equal(res.code, 0);
  assert.deepEqual(f.calls.map((c) => c.path), ["/3/movie/11", "/3/movie/15"]);
  assert.equal(res.asked, 2); assert.equal(res.withTrailer, 1); assert.equal(res.nullTrailer, 1); assert.equal(res.errors, 0);
  assert.match(lines.join("\n"), /asked 2 .* with a trailer 1 .* null .* 1 .* errors 0/);
  const text = fs.readFileSync(file, "utf8");
  const saved = JSON.parse(text);
  assert.equal(text, JSON.stringify(saved), "the file is what the build writes: one JSON.stringify, no indentation");
  assert.equal(saved.movie[11].v.trailer, "TR11");
  assert.equal(saved.movie[15].v.trailer, null);
  assert.equal(Object.hasOwn(saved.movie[10].v, "trailer"), false, "beyond the budget: untouched");
  assert.equal(saved.movie[12].v.trailer, "HAVE");
  assert.equal(saved.movie[14].v, null);
  assert.deepEqual(Object.keys(saved), ["movie", "recs", "person", "find", "search"]);
  assert.equal(lines.join("\n").includes(fakeKey), false, "the key is never printed");
});

test("backfill-trailers: errors are counted and left without the key; a missing key, OFFLINE and a bad option are refused", async () => {
  const file = tmp(plant());
  const lines = [];
  const res = await online(() => B.main(["--cache", file], { env: { TMDB_TOKEN: "k" }, log: (l) => lines.push(l), fetchImpl: fakeFetch((id) => (id === 10 ? 500 : { id, title: "x", videos: { results: [yt("K")] } })), sleepImpl: noSleep }));
  assert.equal(res.code, 0);
  assert.equal(res.errors, 1); assert.equal(res.withTrailer, 2); assert.equal(res.unresolved, 1);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file, "utf8")).movie[10].v, "trailer"), false);
  assert.equal((await B.main(["--cache", file], { env: {}, log: quiet })).code, 2);
  const prev = process.env.OFFLINE; process.env.OFFLINE = "1";
  try { assert.equal((await B.main(["--cache", file], { env: { TMDB_TOKEN: "k", OFFLINE: "1" }, log: quiet })).code, 2); } finally { if (prev === undefined) delete process.env.OFFLINE; else process.env.OFFLINE = prev; }
  for (const bad of [["--budget", "0"], ["--budget", "x"], ["--nope"], ["--budget"]]) assert.equal((await B.main(bad, { env: {}, log: quiet })).code, 2, bad.join(" "));
});

test("build.js hands config.json tmdb.trailerBackfillPerRun to the client it makes (a text guard: running the build needs Letterboxd data)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "build.js"), "utf8");
  const made = src.split("\n").filter((l) => l.includes("new Tmdb("));
  assert.equal(made.length, 1, "one TMDB client in the build");
  assert.match(made[0], /\{ trailerBudget: trailerBudgetFrom\(cfg\.tmdb\) \}/);
});

// ── 20/10/2026, after the review of b29a7b5: the languages asked, --retry-null, exit codes, Ctrl-C, --save-every, --concurrency ──
// Written against: `language=en-US` alone lets TMDB leave out a trailer filed under the film's own language (28% null in the first run; 44% of the cache is not English).
const many = (n, extra = () => ({})) => cacheOf(Array.from({ length: n }, (_, i) => [i + 1, { t: Date.now() - (n - i) * DAY / 100, v: rec(i + 1, extra(i + 1)) }]));

test("videoLanguages: English, no language, and the film's original language when the cache knows it", () => {
  assert.equal(videoLanguages(undefined), "en,null");
  assert.equal(videoLanguages("en"), "en,null");
  assert.equal(videoLanguages("fr"), "en,null,fr");
  assert.equal(videoLanguages(" JA "), "en,null,ja");
  assert.equal(videoLanguages("xx"), "en,null", "xx says the film has no language");
  assert.equal(videoLanguages("cn"), "en,null,cn,zh", "Cantonese videos are filed under zh");
  for (const junk of ["", "xyz", "f", "f r", null, 7, "en,fr"]) assert.equal(videoLanguages(junk), "en,null", JSON.stringify(junk));
});

test("movie(): the request carries include_video_language from the cached record's language (backfill and expiry alike), en,null for an unknown film", async () => {
  const now = Date.now();
  const f = fakeFetch();
  const t = client(tmp(cacheOf([[1, { t: now - DAY, v: rec(1, { lang: "fr" }) }], [2, { t: now - 50 * DAY, v: rec(2, { lang: "ja", trailer: null }) }]])), f);
  await t.movie(1); await t.movie(2); await t.movie(3);
  const byId = Object.fromEntries(f.calls.map((c) => [c.path.split("/").pop(), c.params.include_video_language]));
  assert.deepEqual(byId, { 1: "en,null,fr", 2: "en,null,ja", 3: "en,null" });
  assert.equal(f.calls[0].params.language, "en-US", "the texts stay English");
});

test("pickTrailer: a trailer in the film's own language is taken when there is none in English; English first, official first among the English (Marco, 21/10/2026: the four cases)", () => {
  assert.equal(pickTrailer({ results: [yt("fr-only", { iso_639_1: "fr" })] }), "fr-only");
  assert.equal(pickTrailer({ results: [yt("null-lang", { iso_639_1: null })] }), "null-lang");
  // 1. English official + French official: the English one
  assert.equal(pickTrailer({ results: [yt("fr-official", { iso_639_1: "fr", official: true }), yt("en-official", { iso_639_1: "en", official: true })] }), "en-official");
  // 2. English unofficial + French official: the English one (was the French one before 21/10/2026)
  assert.equal(pickTrailer({ results: [yt("fr-official", { iso_639_1: "fr", official: true }), yt("en-unofficial", { iso_639_1: "en" })] }), "en-unofficial");
  // 3. no English: French official + Japanese unofficial: the official one, in another language
  assert.equal(pickTrailer({ results: [yt("ja-unofficial", { iso_639_1: "ja", published_at: "2024-01-01T00:00:00Z" }), yt("fr-official", { iso_639_1: "fr", official: true })] }), "fr-official");
  // 4. nothing that counts: null
  assert.equal(pickTrailer({ results: [{ ...yt("clip", { iso_639_1: "en", official: true }), type: "Clip" }, { ...yt("vimeo", { iso_639_1: "en" }), site: "Vimeo" }] }), null);
});

test("movie() with trailerRetryNull asks again the records cached with null, never the ones with a trailer, and the budget still applies", async () => {
  const now = Date.now();
  const entries = [[1, { t: now - DAY, v: rec(1, { trailer: null }) }], [2, { t: now - DAY, v: rec(2, { trailer: "HAVE" }) }], [3, { t: now - DAY, v: rec(3, { trailer: null }) }], [4, { t: now - DAY, v: rec(4, { trailer: null }) }]];
  assert.equal(needsTrailer({ v: rec(1, { trailer: null }) }), false);
  assert.equal(needsTrailer({ v: rec(1, { trailer: null }) }, { retryNull: true }), true);
  assert.equal(needsTrailer({ v: rec(1, { trailer: "K" }) }, { retryNull: true }), false);
  assert.equal(needsTrailer({ v: rec(1) }, { repick: true }), false, "--repick: a never-asked record is not in it, by the function itself and not only by the script's filter (review of 21/10/2026)");
  assert.equal(needsTrailer({ v: rec(1, { trailer: "K" }) }, { repick: true }), true);
  assert.equal(needsTrailer({ v: rec(1, { trailer: null }) }, { repick: true }), true);
  const f = fakeFetch();
  const t = client(tmp(cacheOf(entries)), f, { trailerRetryNull: true, trailerBudget: 2 });
  for (const [id] of entries) await t.movie(id);
  assert.deepEqual(f.calls.map((c) => c.path.split("/").pop()), ["1", "3"], "the one with a trailer is skipped, the third null is over the budget");
  assert.equal(t.cache.movie[1].v.trailer, "TR1");
  assert.equal(t.cache.movie[2].v.trailer, "HAVE");
  assert.equal(t.cache.movie[4].v.trailer, null);
  const plain = fakeFetch();
  const p = client(tmp(cacheOf(entries)), plain);
  for (const [id] of entries) await p.movie(id);
  assert.equal(plain.calls.length, 0, "without the option the build never asks a null again before its expiry");
});

test("backfill-trailers --retry-null: never-asked films first, then the nulls; a film with a trailer is not asked; it says how many nulls came back with one", async () => {
  const file = tmp(plant());
  const dry = await B.main(["--dry-run", "--retry-null", "--cache", file], { env: {}, log: quiet });
  assert.equal(dry.wouldAsk, 4); assert.equal(dry.never, 4);
  assert.deepEqual(B.pending(JSON.parse(fs.readFileSync(file, "utf8")), { retryNull: true }), ["11", "15", "10", "13"]);
  const f = fakeFetch((id) => ({ id, title: "x", videos: { results: id === 13 ? [yt("FOUND")] : [] } }));
  const lines = [];
  const res = await online(() => B.main(["--retry-null", "--cache", file], { env: { TMDB_TOKEN: "k" }, log: (l) => lines.push(l), fetchImpl: f, sleepImpl: noSleep }));
  assert.deepEqual(f.calls.map((c) => c.path.split("/").pop()).sort(), ["10", "11", "13", "15"]);
  assert.equal(res.code, 0); assert.equal(res.recovered, 1); assert.equal(res.withTrailer, 1); assert.equal(res.nullTrailer, 3);
  assert.match(lines.join("\n"), /asked again: 1 films that had null · now with a trailer: 1/);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.movie[13].v.trailer, "FOUND");
  assert.equal(saved.movie[12].v.trailer, "HAVE");
  const g = fakeFetch();
  await online(() => B.main(["--cache", tmp(plant())], { env: { TMDB_TOKEN: "k" }, log: quiet, fetchImpl: g, sleepImpl: noSleep }));
  assert.equal(g.calls.some((c) => c.path.endsWith("/13")), false, "without --retry-null the null stays");
});

test("backfill-trailers: gives up with exit code 1 after 20 failures in a row, and with 1 when the key is rejected; the cache is saved either way", async () => {
  const file = tmp(many(30));
  const before = fs.readFileSync(file, "utf8");
  const lines = [];
  const f = fakeFetch(() => 500);
  const down = await online(() => B.main(["--cache", file, "--concurrency", "1"], { env: { TMDB_TOKEN: "k" }, log: (l) => lines.push(l), fetchImpl: f, sleepImpl: noSleep }));
  assert.equal(down.code, 1); assert.equal(down.stopped, true);
  assert.ok(down.errors >= 20 && down.errors <= 22, `20 in a row, plus the asks already in flight (2 workers): ${down.errors}`);
  assert.ok(down.errors < 30, "the other films were not asked");
  assert.match(lines.join("\n"), /gave up: 20 asks failed in a row/);
  assert.equal(fs.readFileSync(file, "utf8"), before, "nothing was learned, nothing changed");
  const file2 = tmp(many(40));
  const g = fakeFetch((id) => (id <= 5 ? { id, title: "x", videos: { results: [yt("OK")] } } : 401));
  const bad = await online(() => B.main(["--cache", file2, "--concurrency", "2"], { env: { TMDB_TOKEN: "k" }, log: quiet, fetchImpl: g, sleepImpl: noSleep }));
  assert.equal(bad.code, 1);
  assert.ok(g.calls.length < 40, `the run stopped at the first 401, asked ${g.calls.length} of 40`);
  const saved = JSON.parse(fs.readFileSync(file2, "utf8"));
  assert.equal(Object.values(saved.movie).filter((e) => typeof e.v.trailer === "string").length, 5, "what was done before the 401 is saved");
});

test("backfill-trailers: Ctrl-C saves what was done and exits 130; --save-every writes in the middle of the run", async () => {
  const base = many(8);
  const file = tmp(base);
  const before = process.listenerCount("SIGINT");
  const exits = []; let snap = null;
  let n = 0;
  const f = fakeFetch();
  const fetchImpl = async (url) => { if (++n === 4) process.emit("SIGINT"); return f(url); };
  await online(() => B.main(["--cache", file, "--concurrency", "1"], { env: { TMDB_TOKEN: "k" }, log: quiet, fetchImpl, sleepImpl: noSleep, handleSignals: true, exit: (c) => { exits.push(c); snap = JSON.parse(fs.readFileSync(file, "utf8")); } }));
  assert.deepEqual(exits, [130]);
  assert.equal(Object.values(snap.movie).filter((e) => typeof e.v.trailer === "string").length, 3, "the 3 films answered before the 4th ask are on disk at Ctrl-C");
  assert.equal(process.listenerCount("SIGINT"), before, "the handler is taken off afterwards");

  const file2 = tmp(many(8));
  let k = 0, mid = null;
  const h = fakeFetch();
  const fetch2 = async (url) => { if (++k === 7) mid = Object.values(JSON.parse(fs.readFileSync(file2, "utf8")).movie).filter((e) => typeof e.v.trailer === "string").length; return h(url); };
  const lines = [];
  await online(() => B.main(["--cache", file2, "--concurrency", "1", "--save-every", "2"], { env: { TMDB_TOKEN: "k" }, log: (l) => lines.push(l), fetchImpl: fetch2, sleepImpl: noSleep }));
  assert.ok(mid >= 4, `the file already held ${mid} answers when the 7th ask went out`);
  assert.ok(lines.some((l) => /2 of 8 asked, cache saved/.test(l)));
});

test("backfill-trailers: --concurrency is the number of asks in flight at most, and it is reached", async () => {
  let inflight = 0, peak = 0;
  const f = fakeFetch();
  const fetchImpl = async (url) => { inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, 5)); inflight--; return f(url); };
  const res = await online(() => B.main(["--cache", tmp(many(12)), "--concurrency", "3"], { env: { TMDB_TOKEN: "k" }, log: quiet, fetchImpl, sleepImpl: noSleep }));
  assert.equal(res.code, 0);
  assert.equal(peak, 3);
});

test("backfill-trailers: a run that is not interrupted leaves no Ctrl-C handler behind", async () => {
  const before = process.listenerCount("SIGINT");
  await online(() => B.main(["--cache", tmp(many(3))], { env: { TMDB_TOKEN: "k" }, log: quiet, fetchImpl: fakeFetch(), sleepImpl: noSleep, handleSignals: true, exit: () => assert.fail("no Ctrl-C was sent") }));
  assert.equal(process.listenerCount("SIGINT"), before);
});

// ── --repick (Marco, 21/10/2026: English before official; the cache keeps only the chosen key, so the films already chosen are asked again) ──
// Written against: --repick skipping the films that have a trailer (only the nulls asked), asking the never-asked too, renewing the whole record and its date
// (the index would move), a 404 erasing the trailer a film had, and the summary line missing or counting the unanswered.
function plantRepick() {
  const now = Date.now();
  return cacheOf([
    [20, { t: now - 9 * DAY, v: rec(20, { trailer: "OLD-FR", va: 7.1 }) }],   // picked with the old order: the official French one
    [21, { t: now - 8 * DAY, v: rec(21, { trailer: "SAME" }) }],              // the new pick is the same key
    [22, { t: now - 7 * DAY, v: rec(22, { trailer: null }) }],                // asked, none; a trailer shows up
    [23, { t: now - 6 * DAY, v: rec(23) }],                                   // NEVER asked: no key
    [24, { t: now - 5 * DAY, v: rec(24, { trailer: "KEEP" }) }],              // TMDB answers 404 now
    [25, { t: now - 4 * DAY, v: rec(25, { trailer: null }) }],                // asked, none; still none
    [26, { t: now - 3 * DAY, v: rec(26, { trailer: "GONE" }) }],              // the video was removed: now null
    [27, { t: now - 2 * DAY, v: null }],                                      // TMDB said 404 once: no record
  ]);
}
const answerRepick = (id) => {
  if (id === 24) return 404;
  const videos = {
    20: [yt("OLD-FR", { official: true, iso_639_1: "fr" }), yt("NEW-EN", { iso_639_1: "en" })],
    21: [yt("SAME", { official: true, iso_639_1: "en" })],
    22: [yt("FOUND")],
    25: [],
    26: [],
  }[id] || [];
  return { id, title: `Film ${id}`, vote_average: 1, videos: { results: videos } };
};

test("backfill-trailers --repick: asks again every film that has the key (a trailer or null), never the never-asked ones, oldest entry first; --budget applies", async () => {
  const file = tmp(plantRepick());
  const cache = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(B.pending(cache, { repick: true }), ["20", "21", "22", "24", "25", "26"], "23 was never asked and 27 has no record");
  assert.deepEqual(B.pending(cache), ["23"], "without --repick only the never-asked one");
  const dry = await B.main(["--dry-run", "--repick", "--cache", file], { env: {}, log: quiet });
  assert.equal(dry.code, 0); assert.equal(dry.wouldAsk, 6);
  assert.equal((await B.main(["--dry-run", "--repick", "--budget", "2", "--cache", file], { env: {}, log: quiet })).wouldAsk, 2);
  const f = fakeFetch(answerRepick);
  await online(() => B.main(["--repick", "--budget", "2", "--cache", file], { env: { TMDB_TOKEN: "k" }, log: quiet, fetchImpl: f, sleepImpl: noSleep }));
  assert.deepEqual(f.calls.map((c) => c.path.split("/").pop()).sort(), ["20", "21"], "the two oldest");
  assert.equal((await B.main(["--repick", "--retry-null", "--cache", file], { env: { TMDB_TOKEN: "k" }, log: quiet })).code, 2, "--repick already asks the nulls: the two options together are refused");
});

test("backfill-trailers --repick: redoes the pick of the films with a trailer and with null, keeps the rest of the record and its date, and says 'repicked N · changed M'", async () => {
  const file = tmp(plantRepick());
  const before = JSON.parse(fs.readFileSync(file, "utf8"));
  const f = fakeFetch(answerRepick);
  const lines = [];
  const res = await online(() => B.main(["--repick", "--cache", file], { env: { TMDB_TOKEN: "k" }, log: (l) => lines.push(l), fetchImpl: f, sleepImpl: noSleep }));
  assert.equal(res.code, 0);
  assert.deepEqual(f.calls.map((c) => c.path.split("/").pop()).sort(), ["20", "21", "22", "24", "25", "26"], "the one with no key (23) and the one with no record (27) are not asked");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.movie[20].v.trailer, "NEW-EN", "the unofficial English one now beats the official French one");
  assert.equal(saved.movie[21].v.trailer, "SAME");
  assert.equal(saved.movie[22].v.trailer, "FOUND", "a null can gain a trailer");
  assert.equal(saved.movie[24].v.trailer, "KEEP", "a 404 does not erase the trailer a film had");
  assert.equal(saved.movie[25].v.trailer, null);
  assert.equal(saved.movie[26].v.trailer, null, "a removed video leaves null");
  assert.equal(Object.hasOwn(saved.movie[23].v, "trailer"), false, "the never-asked one stays without the key");
  assert.equal(saved.movie[27].v, null);
  for (const id of [20, 21, 22, 24, 25, 26]) {
    assert.equal(saved.movie[id].t, before.movie[id].t, `${id}: the date stays`);
    assert.deepEqual({ ...saved.movie[id].v, trailer: 0 }, { ...before.movie[id].v, trailer: 0 }, `${id}: only the trailer changes (the answer's vote_average and title do not enter)`);
  }
  assert.equal(res.repicked, 6); assert.equal(res.changed, 3);
  assert.match(lines.join("\n"), /repicked 6 · changed 3/);
});

test("backfill-trailers --repick: an ask that fails is not counted as repicked and keeps the trailer; the summary says so", async () => {
  const file = tmp(plantRepick());
  const lines = [];
  const res = await online(() => B.main(["--repick", "--cache", file], { env: { TMDB_TOKEN: "k" }, log: (l) => lines.push(l), fetchImpl: fakeFetch((id) => (id === 20 ? 500 : answerRepick(id))), sleepImpl: noSleep }));
  assert.equal(res.errors, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).movie[20].v.trailer, "OLD-FR");
  assert.equal(res.repicked, 5); assert.equal(res.changed, 2);
  assert.match(lines.join("\n"), /repicked 5 · changed 2/);
});

test("Tmdb with trailerRepick: the build's client never sets it, so a record with a trailer is served from the cache as it is", async () => {
  const entries = [[20, { t: Date.now() - DAY, v: rec(20, { trailer: "OLD-FR" }) }]];
  const f = fakeFetch(answerRepick);
  const plain = client(tmp(cacheOf(entries)), f);
  assert.equal((await plain.movie(20)).trailer, "OLD-FR");
  assert.equal(f.calls.length, 0);
  const t = client(tmp(cacheOf(entries)), f, { trailerRepick: true });
  assert.equal((await t.movie(20)).trailer, "NEW-EN");
  assert.equal(f.calls.length, 1);
});

test("backfill-trailers --repick: a record past its 45 days is renewed by the client's normal path (new answer, new date) and is counted in neither 'repicked' nor 'changed'", async () => {
  const now = Date.now();
  const file = tmp(cacheOf([[30, { t: now - 50 * DAY, v: rec(30, { trailer: "OLD-FR" }) }], [31, { t: now - 2 * DAY, v: rec(31, { trailer: "OLD-FR" }) }]]));
  const lines = [];
  const res = await online(() => B.main(["--repick", "--cache", file], { env: { TMDB_TOKEN: "k" }, log: (l) => lines.push(l), fetchImpl: fakeFetch(answerRepick), sleepImpl: noSleep }));
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(res.repicked, 1); assert.equal(res.changed, 1, "both are answered with no video and both end null, but only 31 (the one repicked, date kept) is counted");
  assert.equal(saved.movie[30].v.trailer, null); assert.equal(saved.movie[31].v.trailer, null);
  assert.ok(saved.movie[30].t > now - DAY, "the expired record got a new date");
  assert.equal(saved.movie[31].t, now - 2 * DAY, "the repicked one kept its date");
  assert.match(lines.join("\n"), /repicked 1 · changed 1/);
});
