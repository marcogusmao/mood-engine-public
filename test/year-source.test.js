// node --test            (no dependencies)
// The year of a film (lib/pool.js yearOf): ONE rule for the cover, the index (`year`, `decade`) and the catalogs by decade.
// Marco, 13/10/2026: Letterboxd's year first, TMDB's only as the reserve and only from the film's OWN record (its `imdb` is the film's id).
// Measured that day against the IMDb dataset (title.basics startYear): of the 802 films where the two differed, Letterboxd gave the IMDb year for 781 and
// TMDB for 10; over the whole index 97.8% against 90.9%. Defect that was fixed: the index read TMDB's `release_date` first (Elvis: The '68 Comeback Special,
// 1968 on the cover, 2018 in the index) and took the TMDB record of another title for a film that had none of its own (tt5580146, Maniac 2018, got "Titan FC 18", 2011).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const P = require("../lib/pool");
const { buildIndex, yearsByTt, showYear } = require("../lib/index-export");
const { buildPlan } = require("../lib/plan");
const { decode } = require("../lib/index-rows");

const ROOT = path.join(__dirname, "..");
const film = (tt, title, year, o = {}) => ({ title, year, tmdbId: null, imdbId: tt, t: 1, v: 2, ...o });

test("yearOf: Letterboxd first; TMDB only as the reserve and only from the film's own record", () => {
  const own = (year) => ({ imdb: "tt1", year });
  assert.equal(P.yearOf({ id: "tt1", year: 1968, detail: own(2018) }), 1968, "both know it: Letterboxd's (Elvis: 1968, TMDB 2018)");
  assert.equal(P.yearOf({ id: "tt1", year: null, detail: own(1975) }), 1975, "Letterboxd has none: the film's own TMDB record");
  assert.equal(P.yearOf({ id: "tt1", year: undefined, detail: own(1975) }), 1975);
  assert.equal(P.yearOf({ id: "tt1", year: null, detail: { imdb: "tt2", year: 2011 } }), null, "the record names another film: no year is lent");
  assert.equal(P.yearOf({ id: "tt1", year: null, detail: { imdb: null, year: 2011 } }), null, "a record with no IMDb id is not the film's own");
  assert.equal(P.yearOf({ id: "tt1", year: null, detail: { year: 2011 } }), null);
  assert.equal(P.yearOf({ id: "tt1", year: null, detail: null }), null);
  assert.equal(P.yearOf({ id: "tt1", year: null }), null);
  assert.equal(P.decadeOf({ id: "tt1", year: 1968, detail: own(2018) }), "1960s", "the decade follows the year");
});

// ── buildIndex on a small world: the index entry and the cover facts get the same year ─────────────────────────────────────────

const TMDB = {
  101: { id: 101, imdb: "tt0000101", title: "Elvis Special", year: 2018, runtime: 70, countries: ["US"], lang: "en", va: 7, vc: 100, genres: [], keywords: [], directors: [], overview: "" },
  102: { id: 102, imdb: "tt0000102", title: "No Letterboxd Year", year: 1975, runtime: 95, countries: ["US"], lang: "en", va: 7, vc: 100, genres: [], keywords: [], directors: [], overview: "" },
  103: { id: 103, imdb: null, title: "Titan FC 18", year: 2011, runtime: 59, countries: ["US"], lang: "en", va: 6, vc: 50, genres: ["Documentary"], keywords: [], directors: [], overview: "Pulver and Davidson fight for the title at the arena." }, // Maniac's old record: another title, no IMDb id
  104: { id: 104, imdb: "tt0000999", title: "Another Film", year: 1944, runtime: 80, countries: ["FR"], lang: "fr", va: 6, vc: 50, genres: [], keywords: [], directors: [], overview: "" }, // names another film
};
const FILMS = {
  elvis: film("tt0000101", "Elvis Special", 1968, { tmdbId: 101, r: 4, rt: 70, c: ["USA"] }),
  noyear: film("tt0000102", "No Letterboxd Year", null, { tmdbId: 102, r: 4, rt: 95, c: ["USA"] }),
  maniac: film("tt0000103", "Maniac", 2018, { tmdbId: 103, r: 4, rt: 383, c: ["USA"] }),
  stranger: film("tt0000104", "Stranger", null, { tmdbId: 104, r: 4, rt: 80, c: ["France"] }),
};
const detail = (r) => (r.tmdbId ? TMDB[r.tmdbId] || null : null);

function world() {
  const entries = Object.keys(FILMS).map((slug) => ({ slug, tag: { type: "watchlist" } }));
  const { pool } = P.buildPool({ entries, view: { films: FILMS }, isSeen: () => false, detail });
  const recs = P.rankPool(pool, { stats: new Map() });
  // Maniac sits in a Board row the way the build puts it there: P.toItem of the pool record, which reads the record it holds (the foreign one)
  const maniac = recs.find((r) => r.id === "tt0000103");
  const plan = buildPlan({ moods: [], rows: { tonight: [P.toItem(maniac, [P.sourceWhy(maniac)])] }, extra: { fromlists: [], short: [], newforyou: [], "friends-week": [] }, sizes: { row: 30, friends: 30, discover: 60 }, withFriends: false });
  return {
    cfg: { addon: { version: "2.0.0" }, shortRow: { maxMinutes: 95, minMinutes: 40 }, cuts: { countries: 2 }, friendRows: { love: { minStars: 4 } }, moods: [] },
    today: "2026-10-13", builtAt: "2026-10-13T12:00:00.000Z", plan, moods: [], recs, view: { films: FILMS, users: [] }, detail, separator: "\n\n",
  };
}

test("index: the year is Letterboxd's, then the film's own TMDB record's; the decade follows; the cover facts carry the same year", () => {
  const coverFacts = new Map();
  const ix = buildIndex({ ...world(), coverFacts });
  const by = Object.fromEntries(ix.films.map((f) => [f.tt, f]));
  assert.equal(by.tt0000101.year, 1968, "Letterboxd 1968, TMDB 2018");
  assert.equal(by.tt0000101.decade, "1960s");
  assert.equal(by.tt0000102.year, 1975, "Letterboxd has no year: the film's own TMDB record gives it");
  assert.equal(by.tt0000102.decade, "1970s");
  assert.equal(by.tt0000104.year, undefined, "the TMDB record names another film: the film has no year (never a guess)");
  assert.equal(by.tt0000104.decade, undefined);
  for (const e of ix.films) assert.equal(coverFacts.get(e.tt).year ?? undefined, e.year, `${e.tt}: the cover's year is the index's`);
});

test("index: a TMDB record that is not the film's own lends it nothing - year, title, runtime, language, genres, synopsis (Maniac 2018 is not 'Titan FC 18', 2011)", () => {
  const ix = buildIndex({ ...world(), coverFacts: new Map() });
  const m = ix.films.find((f) => f.tt === "tt0000103");
  assert.equal(m.name, "Maniac", "the title of the Letterboxd page, not the other record's");
  assert.equal(m.year, 2018);
  assert.equal(m.runtime, 383, "Letterboxd's runtime, not the other record's 59");
  assert.equal(m.language, undefined, "the other record's language is not the film's");
  assert.equal(m.tmdbRating, undefined, "nor its votes");
  assert.equal(m.genres, undefined, "nor its genres (the plan item of the Board row was built from that record: P.toItem)");
  assert.ok(!/Pulver|arena/.test(m.desc || ""), "nor its synopsis (Marco, 13/10/2026: the TMDB record of the index must carry the film's IMDb id)");
  assert.ok(!/Documentary|Pulver|Titan/.test(JSON.stringify(m)), "nothing of that record is anywhere in the entry");
  const s = ix.films.find((f) => f.tt === "tt0000104");
  assert.deepEqual(s.countries, ["France"], "countries from the Letterboxd page: the other film's FR/fr is not borrowed");
  assert.equal(s.language, undefined);
  const e = ix.films.find((f) => f.tt === "tt0000101");
  assert.equal(e.runtime, 70, "the film's own record is still used");
  assert.equal(e.language, "en");
});

test("yearsByTt / showYear: the index's year when it has one, else what the item carried", () => {
  const years = yearsByTt({ films: [{ tt: "tt1", year: 1968 }, { tt: "tt2" }, { tt: "tt3", year: null }] });
  assert.equal(showYear(years, "tt1", 2018), 1968);
  assert.equal(showYear(years, "tt2", 1999), 1999, "the index has no year: the item keeps its own");
  assert.equal(showYear(years, "tt3", undefined), undefined);
  assert.equal(showYear(years, "tt9", 2001), 2001);
});

test("two Letterboxd slugs for one IMDb: the selected pool record supplies the year before the other cached slug or TMDB", () => {
  const w = world();
  w.view = { users: [], films: {
    older: film("tt0000101", "Same film", 1968, { r: 4, tmdbId: 101 }),
    newer: film("tt0000101", "Same film", 1965, { r: 4, tmdbId: 101 }),
  } };
  for (const cacheOrder of [["older", "newer"], ["newer", "older"]]) for (const [slug, expected] of [["newer", 1965], ["older", 1968]]) {
    const view = { ...w.view, films: Object.fromEntries(cacheOrder.map((k) => [k, w.view.films[k]])) };
    const other = slug === "newer" ? "older" : "newer";
    const sameAsOther = () => ({ ...TMDB[101], year: w.view.films[other].year });
    const entries = [
      { slug, tag: { type: "watchlist" } },
      { slug: other, tag: { type: "list", id: "fixture", name: "Fixture", pos: 1 } },
    ];
    const { pool } = P.buildPool({ entries, view, isSeen: () => false, detail: sameAsOther });
    assert.equal(pool.size, 1, "the two source entries merge by IMDb");
    assert.equal(pool.get("tt0000101").slug, slug, "source order supplies the selected record");
    assert.equal(pool.get("tt0000101").tags.lists.size, 1, "the other source still contributes its tag");
    const coverFacts = new Map();
    const ix = buildIndex({ ...w, view, detail: sameAsOther, recs: [...pool.values()], coverFacts });
    assert.equal(ix.films.find((f) => f.tt === "tt0000101").year, expected);
    assert.equal(coverFacts.get("tt0000101").year, expected);
  }
});

// ── the real caches, the whole offline build ────────────────────────────────────────────────────────────────────────────────────
// Every surface of a build shows the year the index carries: the cover (read from the local cover receipt), the static addon's catalogs (releaseInfo) and the
// picker's rows. The number of films is not pinned (the caches change every night); the equality is.

test("offline build on the real caches: cover year == index year == static addon year == picker year, for every film", { skip: !fs.existsSync(path.join(ROOT, "cache", "lists.json")) }, () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "year-source-"))); // the cover receipt refuses a path that goes through a symlink
  try {
    const cache = path.join(tmp, "cache"), out = path.join(tmp, "out"), receiptFile = path.join(tmp, "receipt.json");
    const sourceFile = path.join(tmp, "selected-years.json"), probe = path.join(tmp, "selected-years.cjs");
    // Observe the inputs of the real index call, before its implementation runs. This receipt stores the
    // selected pool record (including its slug), not the computed year; the assertion remains independent.
    fs.writeFileSync(probe, `
      const Module = require('node:module'), fs = require('node:fs');
      const load = Module._load;
      Module._load = function(id, parent, ...rest) {
        const value = load.call(this, id, parent, ...rest);
        if (id !== './lib/index-export' || parent?.filename !== ${JSON.stringify(path.join(ROOT, "build.js"))}) return value;
        return { ...value, buildIndex(options) {
          if (!fs.existsSync(${JSON.stringify(sourceFile)})) fs.writeFileSync(${JSON.stringify(sourceFile)}, JSON.stringify({
            recs: options.recs.map(r => ({ tt: r.id, slug: r.slug, year: r.year })),
            films: Object.entries(options.view.films).filter(([, f]) => f && !f.gone && f.imdbId).map(([slug, f]) => ({ tt: f.imdbId, slug, year: f.year, rated: f.r != null }))
          }));
          return value.buildIndex(options);
        }};
      };
    `);
    fs.cpSync(path.join(ROOT, "cache"), cache, { recursive: true });
    const env = { ...process.env, MOOD_DATE: "2026-10-13", SKIP_RSS: "1" };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ["--require", probe, "build.js", "--offline", "--cache-only", "--no-chrome", "--cache-dir", cache, "--out", out, "--cover-receipt", receiptFile], { cwd: ROOT, env, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
    assert.equal(r.status, 0, r.stderr);
    const index = decode(JSON.parse(fs.readFileSync(path.join(out, "data", "index.json"), "utf8")));
    const yearOf = new Map(index.films.map((e) => [e.tt, e.year ?? null]));
    assert.ok(yearOf.size > 1000, "the index must not be empty");

    const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
    // PR5 (14/10/2026): config.json carries the Board, so the build also writes the v2 index, which has films the legacy one does not (prize winners, a list film no legacy row holds): the covers are
    // made for the union (build.js hands the cover step the legacy index plus the films only v2 has), and the year those films show follows the same rule.
    const v2File = path.join(out, "data", "index-v2.json");
    const v2Only = fs.existsSync(v2File) ? decode(JSON.parse(fs.readFileSync(v2File, "utf8"))).films.filter((e) => !yearOf.has(e.tt)) : [];
    for (const e of v2Only) yearOf.set(e.tt, e.year ?? null);
    assert.equal(receipt.length, index.films.length + v2Only.length, "one cover per film of the index (and of the films only the v2 index has)");
    const cover = receipt.filter((c) => (c.year ?? null) !== yearOf.get(c.tt)).map((c) => `${c.tt}: cover ${c.year}, index ${yearOf.get(c.tt)}`);
    assert.deepEqual(cover.slice(0, 5), [], `${cover.length} covers show another year than the index`);

    for (const e of index.films) if (e.year != null) assert.equal(e.decade, `${Math.floor(e.year / 10) * 10}s`, `${e.tt}: the decade follows the year`);

    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]));
    const catalog = [];
    for (const f of walk(path.join(out, "catalog")).filter((x) => x.endsWith(".json")))
      for (const m of JSON.parse(fs.readFileSync(f, "utf8")).metas || []) if (yearOf.has(m.id) && (m.releaseInfo ?? null) !== (yearOf.get(m.id) == null ? null : String(yearOf.get(m.id)))) catalog.push(`${m.id} in ${path.relative(out, f)}: ${m.releaseInfo}, index ${yearOf.get(m.id)}`);
    assert.deepEqual(catalog.slice(0, 5), [], `${catalog.length} static catalog entries show another year than the index`);

    const engine = JSON.parse(fs.readFileSync(path.join(out, "data", "engine.json"), "utf8"));
    const rows = [...(engine.films || []), ...(engine.rewatch || [])].map((x) => [x.i, x.y]);
    for (const row of (engine.friends && engine.friends.rows) || []) for (const x of row.items) rows.push([x.i, x.y]);
    for (const l of engine.lists || []) for (const x of l.items) rows.push([x.i, x.y]);
    const picker = rows.filter(([tt, y]) => yearOf.has(tt) && (y ?? null) !== yearOf.get(tt)).map(([tt, y]) => `${tt}: picker ${y}, index ${yearOf.get(tt)}`);
    assert.deepEqual(picker.slice(0, 5), [], `${picker.length} picker rows show another year than the index`);

    // Letterboxd before TMDB. A cache may contain several slugs for one IMDb with different years
    // (30/10/2026: War and Peace, 1968 and 1965). Raw cache insertion order is not the pool's source order.
    // Compare with the exact selected source captured before buildIndex, not any year in the cache.
    const friends = JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "friends.json"), "utf8")).films || {};
    const movie = JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "tmdb.json"), "utf8")).movie || {};
    const selected = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
    assert.ok(selected.recs.length > 1000, "the source probe must observe the real pool");
    const firstPage = new Map(), selectedYear = new Map(), strangers = [];
    // The first rated page replaces an unrated page for films absent from the pool (existing index contract).
    for (const f of selected.films) if (!firstPage.has(f.tt) || (!firstPage.get(f.tt).rated && f.rated)) firstPage.set(f.tt, f);
    for (const [tt, f] of firstPage) if (f.year) selectedYear.set(tt, f);
    for (const f of selected.recs) if (f.year) selectedYear.set(f.tt, f);
    for (const f of Object.values(friends)) {
      if (!f || f.gone || !f.imdbId) continue;
      const t = f.tmdbId && movie[f.tmdbId] && movie[f.tmdbId].v;
      if (t && t.imdb !== f.imdbId && t.title !== f.title) strangers.push([f.imdbId, t.title]);
    }
    const wrongYear = index.films.filter((e) => selectedYear.has(e.tt) && selectedYear.get(e.tt).year !== e.year).map((e) => `${e.tt}: index ${e.year}, selected ${selectedYear.get(e.tt).slug} ${selectedYear.get(e.tt).year}`);
    assert.deepEqual(wrongYear.slice(0, 5), [], `${wrongYear.length} films show another year than their Letterboxd page`);
    // The identity: a film whose Letterboxd page links a TMDB record of another title (an old TV id, a record with no IMDb id: tt5580146, Maniac 2018, had "Titan FC 18: Pulver vs. Davidson", 2011) takes nothing from it.
    const byTt = new Map(index.films.map((e) => [e.tt, e]));
    const borrowed = strangers.filter(([tt, title]) => byTt.has(tt) && byTt.get(tt).name === title).map(([tt, title]) => `${tt} is named "${title}"`);
    assert.deepEqual(borrowed, [], "the index takes no TMDB record that is not the film's own");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
