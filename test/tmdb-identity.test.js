// lib/tmdb-identity.js: a Letterboxd record never borrows another film's TMDB facts (old tv ids in friends.json).
const test = require("node:test");
const assert = require("node:assert/strict");
const { consistentFilms } = require("../lib/tmdb-identity");

const movies = { 890: { imdb: "tt0118541", title: "Brother of Sleep", runtime: 132 }, 7: { imdb: "tt0000007", title: "Same Film" } };
const peek = (id) => movies[id] || null;

test("a record whose tmdbId names another IMDb id loses the tmdbId, in a copy", () => {
  const films = {
    "neon-genesis-evangelion": { title: "Neon Genesis Evangelion", imdbId: "tt0112159", tmdbId: 890, rt: 615 },
    "same-film": { title: "Same Film", imdbId: "tt0000007", tmdbId: 7 },
    "not-cached": { title: "Unknown", imdbId: "tt0000008", tmdbId: 999 },
    "no-imdb": { title: "No IMDb", tmdbId: 890 },
  };
  const { films: out, conflicts } = consistentFilms(films, peek);
  assert.deepEqual(conflicts, [{ slug: "neon-genesis-evangelion", imdbId: "tt0112159", tmdbId: 890, tmdbImdb: "tt0118541" }]);
  assert.equal(out["neon-genesis-evangelion"].tmdbId, null);
  assert.equal(out["neon-genesis-evangelion"].rt, 615, "Letterboxd facts kept");
  assert.equal(out["same-film"].tmdbId, 7);
  assert.equal(out["not-cached"].tmdbId, 999, "nothing to compare: unchanged");
  assert.equal(out["no-imdb"].tmdbId, 890, "no IMDb id to disagree with: unchanged");
  assert.equal(films["neon-genesis-evangelion"].tmdbId, 890, "the cache object is not mutated (it is saved back to git)");
});

test("nothing conflicting: the same object comes back", () => {
  const films = { a: { imdbId: "tt0000007", tmdbId: 7 } };
  assert.equal(consistentFilms(films, peek).films, films);
});

test("friend collections keep Letterboxd runtime after rejecting a conflicting TMDB identity", () => {
  const { buildFriendRows } = require("../lib/rows");
  const films = {
    series: { title: "Neon Genesis Evangelion", imdbId: "tt0112159", tmdbId: 890, rt: 615 },
    unknown: { title: "Unknown runtime", imdbId: "tt0000008", tmdbId: null },
    matching: { title: "Brother of Sleep", imdbId: "tt0118541", tmdbId: 890, rt: 130 },
  };
  const original = JSON.stringify(films);
  const view = { films: consistentFilms(films, peek).films, users: [], lists: [
    { owner: "fixture", slug: "picks", name: "Picks", items: Object.keys(films).map(slug => ({ slug })) },
  ] };
  const { rows } = buildFriendRows({ view, cfg: {}, isSeen: () => false, onMyWatchlist: () => false,
    detail: r => r.tmdbId ? peek(r.tmdbId) : null });
  const items = rows["friends-list-fixture-picks"];
  assert.deepEqual(items.map(({ title, runtime }) => ({ title, runtime })), [
    { title: "Neon Genesis Evangelion", runtime: 615 },
    { title: "Unknown runtime", runtime: null },
    { title: "Brother of Sleep", runtime: 132 },
  ]);
  assert.equal(JSON.stringify(films), original, "source facts stay unchanged");
});

// Real cache, offline build path: the published Cowboy Bebop entry must not carry "The Curse of the Living Corpse".
test("offline build: no catalog shows a series under the borrowed title", (t) => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { spawnSync } = require("node:child_process");
  const root = path.join(__dirname, "..");
  const friends = JSON.parse(fs.readFileSync(path.join(root, "cache/friends.json"), "utf8"));
  if (friends.films?.["cowboy-bebop"]?.imdbId !== "tt0213338") return t.skip("cache no longer holds the 11/10/2026 Cowboy Bebop record");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "tv-ids-"));
  const env = { ...process.env, MOOD_DATE: "2026-10-11", SKIP_RSS: "1" };
  delete env.NODE_TEST_CONTEXT;
  try {
  const r = spawnSync(process.execPath, ["build.js", "--offline", "--cache-only", "--skip-posters", "--out", out], { cwd: root, env, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const hits = walk(path.join(out, "catalog")).filter((f) => f.endsWith(".json")).flatMap((f) => (JSON.parse(fs.readFileSync(f, "utf8")).metas || []).filter((m) => m.id === "tt0213338"));
  assert.ok(hits.length > 0, "the regression must inspect Cowboy Bebop, not an empty catalog selection");
  for (const m of hits) {
    assert.equal(m.name, "Cowboy Bebop");
    assert.equal(m.runtime, `${friends.films["cowboy-bebop"].rt} min`, "must use Letterboxd runtime in every catalog");
  }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// Regression, 20/10/2026 (item 19 of the Stremio BACKLOG): the static rows (build.js `detail`) took the TMDB record under a Letterboxd film's tmdbId whatever its IMDb id, and
// lib/tmdb-identity.js leaves a cached movie with NO IMDb id alone, so tt0204394 (The Iceman Cometh, 1960 → TMDB 318693, "Leontyne Price: The Art of Verdi: Aida: Act III"),
// tt8101850 (Undone → 86340, "Unnatural Selection") and tt5580146 (Maniac → 73411, "Titan FC 18") were published under the other film's name and synopsis.
test("ownDetail: the cached TMDB record counts only when it names the film's own IMDb id (tt0204394 → TMDB 318693, 20/10/2026)", () => {
  const { ownDetail } = require("../lib/pool");
  const cached = {
    318693: { id: 318693, imdb: null, title: "Leontyne Price: The Art of Verdi: Aida: Act III" },
    86340: { id: 86340, title: "Unnatural Selection" }, // no `imdb` key at all
    890: { id: 890, imdb: "tt0118541", title: "Brother of Sleep" }, // another film's IMDb id
    7: { id: 7, imdb: "tt0000007", title: "Same Film" },
  };
  const detail = ownDetail((id) => cached[id] || null);
  assert.equal(detail({ imdbId: "tt0204394", tmdbId: 318693 }), null, "a record with imdb null");
  assert.equal(detail({ imdbId: "tt8101850", tmdbId: 86340 }), null, "a record with no imdb key");
  assert.equal(detail({ imdbId: "tt0112159", tmdbId: 890 }), null, "a record of another IMDb id");
  assert.equal(detail({ imdbId: "tt0000007", tmdbId: 7 }), cached[7], "the film's own record");
  assert.equal(detail({ imdbId: "tt0000008", tmdbId: 999 }), null, "not in the cache");
  assert.equal(detail({ imdbId: "tt0000009" }), null, "no tmdbId");
  assert.equal(detail({ tmdbId: 7 }), null, "no IMDb id to compare: not proved to be the film");
  assert.equal(detail({ tmdbId: 86340 }), null, "neither side has an IMDb id: two absences are not an agreement");
  assert.equal(detail(null), null);
});

// The build, on a copy of the real caches with planted cases: Letterboxd films whose tmdbId names a cached movie with NO IMDb id (the Iceman Cometh shape), one set per surface
// that builds a static row from the TMDB record: a curated list (lib/pool.js listCatalogs), a friend's list (lib/rows.js buildFriendRows) and "Friends watched this week"
// (lib/pool.js weekRow). Planted, not read from the live cache, so the nightly rewrite of cache/ cannot make it pass by removing the case.
test("offline build: a film whose tmdbId names a record with no IMDb id keeps its own name and synopsis in the Lists, friends' list and week catalogs (20/10/2026)", () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { spawnSync } = require("node:child_process");
  const root = path.join(__dirname, "..");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "no-imdb-record-"));
  try {
    const cache = path.join(tmp, "cache");
    fs.cpSync(path.join(root, "cache"), cache, { recursive: true });
    fs.rmSync(path.join(cache, "mubi.json"), { force: true }); // no MUBI "Our Take": it comes before TMDB's overview in the synopsis, and the control compares the TMDB one
    const tmdbFile = path.join(cache, "tmdb.json"), friendsFile = path.join(cache, "friends.json");
    const tmdb = JSON.parse(fs.readFileSync(tmdbFile, "utf8")), friends = JSON.parse(fs.readFileSync(friendsFile, "utf8"));
    const lists = JSON.parse(fs.readFileSync(path.join(cache, "lists.json"), "utf8")).lists;
    const mine = new Set(friends.me.slugs);
    const used = new Set();
    // films Letterboxd and the TMDB cache agree on (so the plant is the only thing wrong), well rated (the week row filters by the recommendation rule), not watched by Marco
    const usable = (slug, minRating) => {
      const f = friends.films[slug];
      return !used.has(slug) && !mine.has(slug) && f && !f.gone && /^tt\d+$/.test(f.imdbId || "") && f.tmdbId && f.title && (f.r || 0) >= minRating && tmdb.movie[f.tmdbId]?.v?.imdb === f.imdbId;
    };
    const pick = (slugs, n, minRating) => {
      const out = [];
      for (const slug of slugs) if (out.length < n && usable(slug, minRating)) { used.add(slug); out.push(slug); }
      return out;
    };
    const everySlug = Object.keys(friends.films);
    const surfaces = {
      lists: pick(Object.values(lists).flatMap((l) => l.items.map(([slug]) => slug)), 8, 0),
      friendList: pick(everySlug, 4, 3.5),
      week: pick(everySlug, 4, 4),
    };
    for (const [k, v] of Object.entries(surfaces)) assert.ok(v.length >= 4, `need films that agree with the TMDB cache for ${k}`);
    // Positive control (the instrument must see the opposite defect too): one film per surface that is NOT planted and keeps its own record with a synopsis and genres. If the rows
    // showed no TMDB record at all (build.js `shown = () => null`), the planted films would still pass and these would not.
    const withFacts = (slug) => { const v = tmdb.movie[friends.films[slug].tmdbId].v; return String(v.overview || "").length > 60 && (v.genres || []).length > 0; };
    const pickControl = (slugs, minRating) => { const out = pick(slugs.filter((slug) => usable(slug, minRating) && withFacts(slug)), 1, minRating); assert.equal(out.length, 1, "need a control film with its own synopsis and genres"); return out[0]; };
    const controls = {
      lists: pickControl(Object.values(lists).flatMap((l) => l.items.map(([slug]) => slug)), 0),
      friendList: pickControl(everySlug, 3.5),
      week: pickControl(everySlug, 4),
    };
    const controlOf = new Map(Object.entries(controls).map(([surface, slug]) => [friends.films[slug].imdbId, { surface, slug, real: tmdb.movie[friends.films[slug].tmdbId].v }]));
    const planted = new Map();
    let n = 0;
    for (const [surface, slugs] of Object.entries(surfaces)) for (const slug of slugs) {
      const id = 990000101 + n, f = friends.films[slug], real = tmdb.movie[f.tmdbId].v;
      tmdb.movie[id] = { t: Date.now(), v: { ...real, id, imdb: null, title: `Planted Other Title ${n}`, overview: `PLANTED SYNOPSIS ${n} of another film`, genres: ["Documentary"] } };
      friends.films[slug] = { ...f, tmdbId: id };
      planted.set(f.imdbId, { slug, title: f.title, surface });
      n++;
    }
    // a friend's list (friend-e/favorites) with the planted films first, so the cap of the row does not cut them
    const flist = friends.lists["friend-e/favorites"];
    assert.ok(flist && flist.items.length, "the cache holds the friend list this test plants into");
    flist.items = [...[controls.friendList, ...surfaces.friendList].map((slug) => [slug, friends.films[slug].title, friends.films[slug].year]), ...flist.items];
    // the week row: a recent diary entry of a configured friend, dated inside the 7 days before the build's date
    // (the same entries feed "Friends watched this month" of the v2 Board, 30 days, lib/special-rows.js friendsMonth). Several friends log each film with 5 stars so the films rank first
    // in both rows whatever else the live cache holds.
    const diarists = Object.values(friends.users).filter((u) => Array.isArray(u.rss)).slice(0, 6);
    assert.ok(diarists.length >= 3, "the cache holds the diaries this test plants into");
    for (const u of diarists) u.rss = [...[controls.week, ...surfaces.week].map((slug) => [slug, friends.films[slug].title, friends.films[slug].year, 5, "2026-10-19"]), ...u.rss];
    fs.writeFileSync(tmdbFile, JSON.stringify(tmdb));
    fs.writeFileSync(friendsFile, JSON.stringify(friends));
    const out = path.join(tmp, "out");
    const env = { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "", MUBI_CACHE: "", MOOD_DATE: "2026-10-20" };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ["build.js", "--offline", "--cache-only", "--skip-posters", "--cache-dir", cache, "--out", out], { cwd: root, env, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    assert.equal(r.status, 0, r.stderr);
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const surfaceOf = (f) => {
      const p = f.split(path.sep).join("/");
      if (/\/catalog\/movie\/mood-engine-lists(-unseen)?\//.test(p)) return "lists";
      if (/\/catalog\/movie\/mood-engine-friends\//.test(p)) return "friendList";
      if (/\/catalog\/movie\/friends-week\.json$/.test(p)) return "week";
      return null;
    };
    const inspected = { lists: 0, friendList: 0, week: 0 }, controlSeen = { lists: 0, friendList: 0, week: 0 };
    const head = (v) => String(v).replace(/\s+/g, " ").trim().slice(0, 25);
    // Since 21/10/2026 the pool reads the film's own record. The block at the end of this test asserts its taste and rank (taste 0, rank = 0.7 × quality); quality -1 is asserted only for a planted film with no
    // Letterboxd average, and none of the current 8 lacks one (BACKLOG 21/10 review, item 2). Not asserted here: the catalogs and the description (rowDesc) of the rows made from the pool (By decade, By country, …).
    // Still reading the raw record: the taste and seen test of the friends' and week rows, `ctx.detail` in lib/special-rows.js, and the pool's own seen test (`seenRec`, also `isSeen`) (BACKLOG 21/10/2026).
    for (const file of walk(path.join(out, "catalog")).filter((f) => f.endsWith(".json"))) {
      const surface = surfaceOf(file);
      if (!surface) continue;
      for (const m of JSON.parse(fs.readFileSync(file, "utf8")).metas || []) {
        const c = controlOf.get(m.id);
        if (c && c.surface === surface) {
          controlSeen[surface]++;
          assert.ok(String(m.description || "").replace(/\s+/g, " ").includes(head(c.real.overview)), `${m.id} in ${path.relative(out, file)} lost its own synopsis`);
          assert.ok((m.genres || []).includes(c.real.genres[0]), `${m.id} in ${path.relative(out, file)} lost its own genres`);
        }
        const p = planted.get(m.id);
        if (!p || p.surface !== surface) continue;
        inspected[surface]++;
        assert.equal(m.name, p.title, `${m.id} in ${path.relative(out, file)} carries another film's name`);
        assert.ok(!/PLANTED SYNOPSIS/.test(m.description || ""), `${m.id} in ${path.relative(out, file)} carries another film's synopsis`);
        assert.ok(!(m.genres || []).includes("Documentary"), `${m.id} in ${path.relative(out, file)} carries another film's genre`);
      }
    }
    for (const [surface, count] of Object.entries(inspected)) assert.ok(count > 0, `the planted films must show in the ${surface} catalogs, or the regression inspects nothing there`);
    for (const [surface, count] of Object.entries(controlSeen)) assert.ok(count > 0, `the control film must show in the ${surface} catalogs, or the control inspects nothing there`);
    // The v2 Board's "Friends watched this month" (lib/special-rows.js friendsMonth, weekRow with the 30-day diary) and the row texts of the index (rowDesc, built from the plan's items).
    const month = JSON.parse(fs.readFileSync(path.join(out, "data", "index-v2-row-friends-month.json"), "utf8"));
    const monthCol = month.cols, monthRows = month.rows["friends-month"], monthDesc = month.rowDesc["friends-month"];
    assert.equal(monthRows.length, monthDesc.length, "rowDesc runs parallel to the row");
    let monthPlanted = 0, monthControl = 0;
    monthRows.forEach((tt, i) => {
      const p = planted.get(tt), c = controlOf.get(tt);
      if (p && p.surface === "week") {
        monthPlanted++;
        assert.ok(!/PLANTED SYNOPSIS/.test(monthDesc[i]), `${tt}: the text of "Friends watched this month" carries another film's synopsis`);
        assert.ok(!/Planted Other Title/.test(monthDesc[i]), `${tt}: the text of "Friends watched this month" carries another film's title`);
        const f = month.films.find((x) => x[0] === tt);
        assert.equal(f[monthCol.indexOf("name")], p.title, `${tt}: the month file names the film itself`);
        assert.ok(!/PLANTED SYNOPSIS/.test(String(f[monthCol.indexOf("desc")] || "")), `${tt}: the month file's film text carries another film's synopsis`);
      }
      if (c && c.surface === "week") {
        monthControl++;
        assert.ok(monthDesc[i].replace(/\s+/g, " ").includes(head(c.real.overview)), `${tt}: "Friends watched this month" lost the film's own synopsis`);
      }
    });
    assert.ok(monthPlanted > 0 && monthControl > 0, "the planted and the control films must show in the month row, or the check inspects nothing");
    const idx = JSON.parse(fs.readFileSync(path.join(out, "data", "index.json"), "utf8"));
    const col = idx.cols.indexOf("name");
    for (const row of idx.films) if (planted.has(row[0])) assert.equal(row[col], planted.get(row[0]).title, `${row[0]}: the Worker index keeps the film's own name`);
    // The pool's ranking (Marco, 21/10/2026: "the ranking also uses only the film's own record"; BACKLOG 21/10/2026): the planted films of the lists are in the pool, and their taste and
    // quality in the Board v2 index (data/index-v2.json: `taste`, `quality`, `rank` = taste + 0.7 × quality) must be those of a film WITHOUT a record: taste neutral (0), and a film with no
    // Letterboxd average at the bottom of the quality scale (-1), not the z-scores of the other title's genres, keywords and vote.
    const v2 = JSON.parse(fs.readFileSync(path.join(out, "data", "index-v2.json"), "utf8")), vc = v2.cols, at = (row, name) => row[vc.indexOf(name)];
    const lbOf = (tt) => { const f = Object.values(friends.films).find((x) => x.imdbId === tt); return f ? f.r ?? null : null; };
    let inPool = 0, unrated = 0;
    for (const row of v2.films) {
      const p = planted.get(row[0]);
      if (!p || p.surface !== "lists") continue;
      inPool++;
      assert.equal(at(row, "taste"), 0, `${row[0]}: the pool ranked it by another film's taste (genres, keywords, cast of a record that is not its own)`);
      assert.ok(Math.abs(at(row, "rank") - 0.7 * at(row, "quality")) <= 0.011, `${row[0]}: rank is not 0.7 × quality (taste ${at(row, "taste")})`);
      if (lbOf(row[0]) == null) { unrated++; assert.equal(at(row, "quality"), -1, `${row[0]}: no Letterboxd average and no record of its own, yet it was given another film's vote as its quality`); }
    }
    assert.ok(inPool >= 4, `the planted list films must be in the pool, or the pool check inspects nothing (${inPool})`);
    // The same index, the control (the instrument must see the opposite defect too): the films that were NOT planted keep a taste of their own, so a pool that read no record at all is also red.
    // Measured on the caches of 20/10/2026: 11,077 of 11,246 films have a taste other than 0; with the pool given no record at all (build.js `detail: () => null`) 1,464 do (the ones the
    // candidates rank outside the pool). A share, not a count, so the nightly caches do not move it.
    const withTaste = v2.films.filter((row) => !planted.has(row[0]) && at(row, "taste") !== 0).length;
    assert.ok(withTaste > 0.9 * v2.films.length, `the unplanted films keep their taste (${withTaste} of ${v2.films.length})`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Regression, 21/10/2026 (BACKLOG item 19, open point 1, decided by Marco 21/10/2026): the POOL read the record under Letterboxd's tmdbId whatever its IMDb id, so tt8101850 (Undone, 181 min,
// TMDB 86340 "Unnatural Selection", a 59-minute documentary with no IMDb id) was ranked by that documentary's genres and could enter "Short and good" (40 to 95 min); tt0204394 and tt5580146
// (TMDB 318693 "Leontyne Price: …", 73411 "Titan FC 18") were ranked by the taste of those records. On the real caches (read 21/10/2026) only the 59 minutes and the Documentary genre of 86340 are true of the foreign records;
// 318693 and 73411 hold no runtime, genre, country or vote (imdb null, va 0, vc 0), so for the Iceman Cometh and Maniac the effect measured was the taste (-0.85 and -0.94, now 0) and the rank, never the
// runtime, vote or country. The fixture below is SYNTHETIC: it gives the foreign records a runtime, genres, countries and votes, and leaves Letterboxd's average, runtime and country out of the Iceman Cometh
// (the real film has 3.61, 240 min and USA), and Maniac's average and runtime (the real film has 3.94 and 383 min); on the cache all three foreign records carry `imdb: null`, and the missing `imdb` key of 86340 is an extra case. So that each fact the decision names is seen by the instrument. build.js now hands the pool lib/pool.js ownDetail:
// the pool holds the film's own record or none, and a film without one is read from its Letterboxd page, as the 1,232 films the cache does not hold already were.
test("pool: a record with no IMDb id of the film's own lends the pool no runtime, genre, country, vote or taste (tt8101850, tt0204394, tt5580146; 21/10/2026)", () => {
  const P = require("../lib/pool"), T = require("../lib/taste");
  const lbFilm = (tt, title, year, o = {}) => ({ title, year, imdbId: tt, t: 1, v: 2, ...o });
  const view = { films: {
    undone: lbFilm("tt8101850", "Undone", 2019, { tmdbId: 86340, r: 4.18, rt: 181, c: ["Netherlands", "USA"] }),
    iceman: lbFilm("tt0204394", "The Iceman Cometh", 1960, { tmdbId: 318693 }), // synthetic: the real film has an average (3.61), a runtime (240) and a country (USA); left out here so the fallbacks show
    maniac: lbFilm("tt5580146", "Maniac", 2018, { tmdbId: 73411, c: ["USA"] }),
    own: lbFilm("tt0000007", "Own Record", 2000, { tmdbId: 7, r: 3.5, rt: 120 }),
  } };
  const cached = {
    86340: { id: 86340, title: "Unnatural Selection", year: 2018, runtime: 59, genres: ["Documentary"], countries: ["GB"], va: 9, vc: 5000, directors: [], overview: "A documentary." }, // no `imdb` key
    318693: { id: 318693, imdb: null, title: "Leontyne Price: The Art of Verdi: Aida: Act III", year: 1985, runtime: 88, genres: ["Documentary", "Music"], countries: ["IT"], va: 8.4, vc: 300, directors: [], overview: "Opera." },
    73411: { id: 73411, imdb: null, title: "Titan FC 18: Pulver vs. Davidson", year: 2011, runtime: 150, genres: ["Documentary"], countries: ["BR"], va: 7.2, vc: 40, directors: [], overview: "A fight card." },
    7: { id: 7, imdb: "tt0000007", title: "Own Record", year: 2000, runtime: 100, genres: ["Documentary"], countries: ["FR"], va: 7, vc: 900, directors: [], overview: "Its own." },
  };
  const peek = (id) => cached[id] || null;
  // a taste that loves documentaries: the foreign records (all "Documentary") score above zero, a film with no record scores nothing
  const model = T.learn([{ film: { genres: ["Documentary"], year: 2000 }, rating: 5 }, { film: { genres: ["Drama"], year: 2000 }, rating: 1 }, { film: { genres: ["Drama"], year: 2001 }, rating: 1 }]);
  const poolWith = (reader) => {
    const { pool } = P.buildPool({ entries: Object.keys(view.films).map((slug) => ({ slug, tag: { type: "watchlist" } })), view, isSeen: () => false, detail: reader });
    const recs = P.rankPool(pool, model);
    return { recs, by: Object.fromEntries(recs.map((r) => [r.id, r])) };
  };

  // Positive control: with the raw reader (what build.js did until 20/10/2026) the instrument sees the defect, in every fact the decision names.
  const raw = poolWith((r) => (r.tmdbId ? peek(r.tmdbId) : null));
  assert.equal(P.runtimeOf(raw.by.tt8101850), 59, "control: Undone read the 59 minutes of the documentary");
  assert.deepEqual(P.toItem(raw.by.tt8101850, []).genres, ["Documentary"], "control");
  assert.equal(P.toItem(raw.by.tt8101850, []).title, "Unnatural Selection", "control");
  assert.deepEqual(P.shortRow(raw.recs, { size: 10 }).map((i) => i.id).includes("tt8101850"), true, "control: with the raw record Undone enters 'Short and good'");
  assert.ok(raw.by.tt8101850.tasteRaw > 0 && raw.by.tt0204394.tasteRaw > 0 && raw.by.tt5580146.tasteRaw > 0, "control: the three were ranked by a documentary's taste");
  assert.equal(P.ratingOf(raw.by.tt0204394).origin, "TMDB", "control: the Iceman Cometh took the vote of the opera");
  assert.deepEqual(P.countriesOf(raw.by.tt0204394), ["Italy"], "control");

  // The pool built with ownDetail
  const own = poolWith(P.ownDetail(peek));
  for (const tt of ["tt8101850", "tt0204394", "tt5580146"]) {
    const r = own.by[tt], item = P.toItem(r, []);
    assert.equal(r.detail, null, `${tt}: the pool holds no record of another title`);
    assert.equal(r.tasteRaw, null, `${tt}: no record, so no taste`);
    assert.equal(r.tasteZ, 0, `${tt}: neutral, neither gains nor loses`);
    assert.deepEqual(item.genres, [], `${tt}: no genre borrowed`);
    assert.equal(item.overview, "", `${tt}: no synopsis borrowed`);
    assert.equal(item.title, view.films[Object.keys(view.films).find((k) => view.films[k].imdbId === tt)].title, `${tt}: Letterboxd's title`);
    assert.equal(item.va, 0); assert.equal(item.vc, 0);
  }
  assert.equal(P.runtimeOf(own.by.tt8101850), 181, "Undone: Letterboxd's 181 minutes, not the documentary's 59");
  assert.equal(P.runtimeOf(own.by.tt0204394), null, "no Letterboxd runtime and no record of its own: the runtime is missing, not the opera's 88");
  assert.equal(P.runtimeOf(own.by.tt5580146), null);
  assert.deepEqual(P.countriesOf(own.by.tt8101850), ["Netherlands", "United States"], "Letterboxd's countries, not GB");
  assert.deepEqual(P.countriesOf(own.by.tt0204394), [], "no country borrowed");
  assert.deepEqual(P.countriesOf(own.by.tt5580146), ["United States"]);
  assert.equal(P.ratingOf(own.by.tt8101850).origin, "Letterboxd");
  assert.equal(P.ratingOf(own.by.tt0204394), null, "no Letterboxd average and no record of its own: no rating, not the opera's TMDB vote");
  assert.equal(own.by.tt0204394.qualityZ, -1, "a film with no quality sorts below the average");
  assert.equal(P.shortRow(own.recs, { size: 10 }).map((i) => i.id).includes("tt8101850"), false, "Undone (181 min) is not in 'Short and good'");
  // the film's own record still counts in full
  const mine = own.by.tt0000007;
  assert.equal(mine.detail, cached[7]);
  assert.equal(P.runtimeOf(mine), 100);
  assert.ok(mine.tasteRaw > 0, "the control keeps its taste");
  assert.deepEqual(P.toItem(mine, []).genres, ["Documentary"]);
});
