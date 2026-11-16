// Static lists (Marco, 11/10/2026): a list that exists only as a magazine article (IndieWire's French 2023 and animation 2025 editions)
// lives in data/lists/<id>.json and enters the build by the door Letterboxd lists use. Every test here fails if the conserto is undone.
const test = require("node:test");
const a = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const SL = require("../lib/static-lists");
const L = require("../lib/lists");
const LW = require("../lib/list-signal");
const P = require("../lib/pool");

const ROOT = path.resolve(__dirname, "..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const tmp = (p = "static-lists-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

const source = { publication: "A Magazine", title: "The best", url: "https://example.com/best", edition: "2023-09-25", readOn: "2026-10-11" };
const item = (n, over = {}) => ({ slug: `film-${n}`, title: `Film ${n}`, year: 2000 + n, imdb: `tt${1000000 + n}`, tmdb: 500 + n, tmdbType: "movie", ...over });
const fileOf = (items, over = {}) => ({ id: "mag", source, items, ...over });
const entry = { id: "mag", name: "A Magazine best (2023)", source: "static", file: "data/lists/mag.json", trust: "critic" };
function repo(data) {
  const root = tmp();
  fs.mkdirSync(path.join(root, "data", "lists"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "lists", "mag.json"), typeof data === "string" ? data : JSON.stringify(data));
  return root;
}
const read = (root, over = {}) => L.refreshLists({ cfg: { lists: [{ ...entry, ...over }] }, file: path.join(root, "lists.json"), root, http: { get() { throw new Error("a static list asks nobody"); } }, gapMs: 0 });

// ── the file is validated: a malformed file stops the build ─────────────────

test("a static list file that is malformed stops the build, naming what is wrong", () => {
  const good = fileOf([item(1), item(2)]);
  a.doesNotThrow(() => SL.load(repo(good), entry));
  const bad = [
    [fileOf([item(1, { imdb: "1234567" })]), /imdb must look like tt1234567/],
    [fileOf([item(1), item(1)]), /slug used twice/],
    [fileOf([item(1), item(2, { imdb: item(1).imdb })]), /imdb tt1000001 used twice/],
    [fileOf([item(1, { tmdbType: "series" })]), /tmdbType must be/],
    [fileOf([item(1, { tmdb: "26191" })]), /tmdb must be a positive integer/],
    [fileOf([item(1, { year: "2001" })]), /year must be an integer/],
    [fileOf([item(1, { title: "" })]), /no title/],
    [fileOf([]), /items must be a non-empty array/],
    [fileOf([item(1)], { source: { ...source, url: "indiewire" } }), /source\.url is not an address/],
    [fileOf([item(1)], { source: { ...source, edition: "25/09/2023" } }), /source\.edition must be YYYY-MM-DD/],
    [fileOf([item(1)], { source: undefined }), /no source/],
    [fileOf([item(1)], { id: "other" }), /config\.json says "mag"/],
    ["{ not json", /cannot be read/],
  ];
  for (const [data, re] of bad) a.throws(() => SL.load(repo(data), entry), re, String(re));
  a.throws(() => SL.load(repo(good), { ...entry, file: "../outside.json" }), /needs file: "data\/lists\/<id>\.json"/);
  a.throws(() => SL.load(repo(good), { ...entry, file: undefined }), /needs file/);
  a.throws(() => SL.load(tmp(), entry), /cannot be read/);
});

test("the three IndieWire editions of config.json: two static (critic), one Letterboxd copy checked 52 of 52; the older editions stay", () => {
  const by = (id) => cfg.lists.find((l) => l.id === id);
  for (const id of ["indiewire-fr-2023", "indiewire-animated-2025"]) {
    const l = by(id);
    a.equal(l.source, "static"); a.equal(l.trust, "critic"); a.equal(l.file, `data/lists/${id}.json`);
    a.match(l.description, /https:\/\/www\.indiewire\.com\/feature\//); a.match(l.description, /edition of \d\d\/\d\d\/20\d\d/);
  }
  const fr = SL.load(ROOT, by("indiewire-fr-2023")), an = SL.load(ROOT, by("indiewire-animated-2025"));
  a.equal(fr.items.length, 39); a.equal(an.items.length, 64);
  a.equal(fr.source.edition, "2023-09-25"); a.equal(an.source.edition, "2025-03-19");
  a.deepEqual(fr.items.filter((i) => i.tmdbType === "tv").map((i) => i.slug), ["lil-quinquin"]);
  a.deepEqual(an.items.slice(0, 3).map((i) => i.slug), ["spirited-away", "spider-man-across-the-spider-verse", "fantastic-mr-fox"], "the article's order");
  const docs = by("iw-docs-2024");
  a.equal(docs.url, "https://letterboxd.com/borgesyrulfo/list/the-52-best-documentaries-of-the-21st-century/"); a.equal(docs.trust, "critic");
  a.deepEqual(docs.checked, { on: "2026-10-11", films: 52 });
  for (const id of ["g6Xms", "4XUmW", "1aHbm"]) a.ok(by(id), `${id}: the older edition stays (Marco, 11/10/2026: add, do not replace)`);
  a.deepEqual([fr, an].map((d) => d.items.filter((i) => i.tmdbType !== "tv").length), [38, 64]);
  a.doesNotThrow(() => LW.validateLists(cfg.lists));
});

// ── the list enters the build through refreshLists: order kept, nothing asked of the network, nothing cached ──

test("refreshLists reads a static list from its file: the editor's order, the series flagged, no network, no cache entry", async () => {
  const items = [item(3), item(1), item(2, { tmdbType: "tv" }), item(4)];
  const root = repo(fileOf(items));
  const r = await read(root);
  a.deepEqual(r.problems, []);
  const l = r.lists[0];
  a.deepEqual(l.items.map((i) => i.slug), ["film-3", "film-1", "film-2", "film-4"], "position = the file's order, not sorted");
  a.deepEqual(l.items.map((i) => i.tv), [false, false, true, false]);
  a.equal(l.url, source.url); a.equal(l.total, 4); a.match(l.fetchedAt, /^2026-10-11/);
  a.match(l.read, /A Magazine, edition 2023-09-25.*https:\/\/example\.com\/best.*4 films/);
  const cache = JSON.parse(fs.readFileSync(path.join(root, "lists.json"), "utf8"));
  a.deepEqual(cache.lists, {}, "the cache holds Letterboxd pages only");
  const cacheOnly = await L.refreshLists({ cfg: { lists: [entry] }, file: path.join(root, "none.json"), root, cacheOnly: true });
  a.deepEqual(cacheOnly.lists[0].items.map((i) => i.slug), ["film-3", "film-1", "film-2", "film-4"], "--cache-only still has the list: it is in the repository");
  await a.rejects(read(repo("[]")), /not an object/);
});

// ── laid over Letterboxd's records: imdb joins, the series stay out, a divergent imdb is refused ──

test("apply: the file supplies the identity of a film Letterboxd has not been asked about, agrees with a record that names the same IMDb id, and refuses one that names another", async () => {
  const items = [item(1), item(2), item(3), item(4, { tmdbType: "tv" }), item(5)];
  const r = (await read(repo(fileOf(items)))).lists;
  const films = {
    "film-1": { imdbId: item(1).imdb, tmdbId: 501, title: "Film 1", year: 2001, r: 4.1 },       // agrees
    "film-3": { imdbId: "tt9999999", tmdbId: 503, title: "Another film", year: 1999 },          // the slug is another film
    "film-4": { imdbId: item(4).imdb, tmdbId: 504, title: "Film 4", year: 2004 },               // a series the page lookup resolved as if it were a film
  };
  const before = JSON.stringify(films);
  const out = SL.apply({ lists: r, films });
  a.equal(JSON.stringify(films), before, "the cache's own records are never changed");
  a.deepEqual(out.stats, [{ id: "mag", items: 5, tv: 1, supplied: 2, agreed: 1, refused: 1, gone: 0 }]);
  a.deepEqual({ imdb: out.films["film-2"].imdbId, tmdb: out.films["film-2"].tmdbId }, { imdb: item(2).imdb, tmdb: 502 }, "file identity where Letterboxd has nothing");
  a.deepEqual({ imdb: out.films["film-5"].imdbId, tmdb: out.films["film-5"].tmdbId }, { imdb: item(5).imdb, tmdb: 505 });
  a.equal(out.films["film-1"].r, 4.1, "an agreeing record keeps everything Letterboxd knows");
  a.equal(out.films["tv:mag:film-4"].gone, true, "the series is no film of this list, even if a lookup resolved it");
  a.deepEqual(out.films["film-4"], films["film-4"], "Letterboxd's record of the slug is untouched: another list naming it keeps it (review S4-B)");
  a.equal(out.films["film-3"].imdbId, "tt9999999", "the other lists keep their record of the slug");
  a.match(out.problems[0], /film-3 is tt1000003 in the file but Letterboxd's record says tt9999999; refused/);
  const l = r[0];
  a.deepEqual(l.items.map((i) => i.slug), ["film-1", "film-2", "refused:mag:film-3", "tv:mag:film-4", "film-5"], "a refused item and a series keep their place: the positions after them do not move");
  a.equal(out.films["refused:mag:film-3"].gone, true);
});

test("a series in a static list leaves the other lists alone: a Letterboxd list naming the same slug keeps the film at its position, in its catalogs, the pool and the signal (review S4-B)", async () => {
  const items = [item(1), item(2, { tmdbType: "tv" })];
  const mag = (await read(repo(fileOf(items)))).lists;
  const other = { id: "slant", name: "Slant 2010s (x)", trust: "critic", items: [{ slug: "film-9" }, { slug: "film-2" }] };
  const films = { "film-2": { imdbId: item(2).imdb, tmdbId: 502, title: "Film 2", year: 2002, r: 3.9 }, "film-9": { imdbId: "tt9", tmdbId: 9, title: "Nine", year: 2009, r: 4 } };
  const lists = [...mag, other];
  const view = { films: SL.apply({ lists, films }).films };
  const cats = P.listCatalogs({ lists, view, isSeen: () => false, detail: () => null, size: 300 });
  a.deepEqual(cats.find((c) => c.id === "mag").all.map((i) => i.id), [item(1).imdb], "not in the static list: a series");
  a.deepEqual(cats.find((c) => c.id === "slant").all.map((i) => [i.id, i.why[0]]), [["tt9", "#1 in “Slant 2010s (x)”"], [item(2).imdb, "#2 in “Slant 2010s (x)”"]], "still in the other list, at its position");
  const sig = LW.signals({ lists, films: view.films, overall: 3.5 });
  a.deepEqual(sig.byTt.get(item(2).imdb).lists.map((x) => x.id), ["slant"], "the signal through the other list only");
  const Q = require("../lib/recommendation-quality");
  a.equal(Q.index(view).get(item(2).imdb).lb, 3.9, "its Letterboxd average still counts");
});

test("the Lists catalogs and the pool take a static list in its order; the series, the refused and the film with no identity stay out", async () => {
  const items = [item(1), item(2), item(3, { tmdbType: "tv" }), item(4), item(5)];
  const lists = (await read(repo(fileOf(items)))).lists;
  const films = { "film-4": { imdbId: "tt8888888", tmdbId: 504, title: "Not film 4", year: 1950 } };
  const view = { films: SL.apply({ lists, films }).films };
  const cats = P.listCatalogs({ lists, view, isSeen: (r) => r.imdbId === item(2).imdb, detail: () => null, size: 300 });
  a.deepEqual(cats[0].all.map((i) => i.id), [item(1).imdb, item(2).imdb, item(5).imdb], "the whole list (Lists): the file's order");
  a.deepEqual(cats[0].unseen.map((i) => i.id), [item(1).imdb, item(5).imdb], "Lists (unseen): the seen one is out");
  a.deepEqual(cats[0].all.map((i) => i.why[0]), ["#1 in “A Magazine best (2023)”", "#2 in “A Magazine best (2023)”", "#5 in “A Magazine best (2023)”"], "positions are the file's, with the series and the refused counted");
  a.equal(cats[0].stats.gone, 2);
  const entries = [];
  lists.forEach((l) => l.items.forEach((it, i) => entries.push({ slug: it.slug, tag: { type: "list", id: l.id, name: l.name, pos: i + 1 } })));
  const { pool } = P.buildPool({ entries, view, isSeen: () => false });
  a.deepEqual([...pool.keys()], [item(1).imdb, item(2).imdb, item(5).imdb]);
  a.equal(pool.get(item(5).imdb).tags.lists.get("mag").pos, 5);
});

test("the list signal: a film in a static critic list is vouched for, at its position; the TMDB id joins only when that movie's IMDb id is the file's", async () => {
  const items = [item(1), item(2), item(3, { tmdbType: "tv" })];
  const lists = (await read(repo(fileOf(items)))).lists;
  const films = SL.apply({ lists, films: {} }).films;
  const sig = LW.signals({ lists, films, overall: 3.5 });
  a.deepEqual([...sig.byTt.keys()], [item(1).imdb, item(2).imdb], "the series has no signal");
  a.equal(sig.byTt.get(item(1).imdb).cv, 1, "trust critic vouches");
  a.deepEqual(sig.byTt.get(item(2).imdb).lists.map((l) => [l.id, l.pos]), [["mag", 2]]);
  a.deepEqual(sig.byTt.get(item(1).imdb).tmdbClaims, [501]);
  // TMDB: 501 is the movie the file names for film 1 and its own IMDb id agrees; 502 names ANOTHER IMDb id, so /find decides
  const movies = { 501: { imdb: item(1).imdb }, 502: { imdb: "tt0000001" } };
  const asked = [];
  const n = await LW.joinTmdb(sig, { movie: async (id) => movies[id] || null, fromImdb: async (tt) => { asked.push(tt); return tt === item(2).imdb ? 9002 : null; } });
  a.equal(sig.byTt.get(item(1).imdb).tmdb, 501);
  a.equal(sig.byTt.get(item(2).imdb).tmdb, 9002, "the divergent TMDB record is refused; TMDB's /find answers by the file's IMDb id");
  a.deepEqual(asked, [item(2).imdb]);
  a.deepEqual(n, { confirmed: 1, viaFind: 1, refused: 1, missing: 0, refusedFound: 1 });
  // the same vouch from the caches alone (the learning replay, the tests of the recommendation rule)
  const root = repo(fileOf(items));
  const v = LW.vouchedFromCaches({ cfg: { lists: [entry] }, listsCache: { lists: {} }, films: {}, root });
  a.deepEqual([...v.keys()], [item(1).imdb, item(2).imdb]);
  a.equal(v.get(item(1).imdb).trust, "critic");
  a.equal(LW.vouchedFromCaches({ cfg: { lists: [entry] }, listsCache: { lists: {} }, films: {}, root: null }).size, 0, "root: null reads no static file");
});

// ── the whole build: --cache-only on the real caches ────────────────────────

test("build --cache-only: the two static lists are in both Lists catalogs in the article's order, the series is not, and the log counts them", { skip: !fs.existsSync(path.join(ROOT, "cache", "lists.json")) }, () => {
  const out = tmp("static-out-"), cache = tmp("static-cache-");
  for (const f of ["friends.json", "lists.json", "tmdb.json", "directors.json"]) fs.copyFileSync(path.join(ROOT, "cache", f), path.join(cache, f));
  try {
    const r = spawnSync(process.execPath, ["build.js", "--offline", "--cache-only", "--cache-dir", cache, "--out", out], { cwd: ROOT, encoding: "utf8", env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" } });
    a.equal(r.status, 0, r.stderr + r.stdout);
    a.match(r.stdout, /static list indiewire-fr-2023\s+39 films · \d+ agree with Letterboxd's record · \d+ identified by the file .* · 1 series left out of the film catalogs · 0 refused/);
    a.match(r.stdout, /static list indiewire-animated-2025\s+64 films/);
    // 22/10/2026 (Marco, ~04:05 UTC): the static Discover files are named after the short name of the list (config.json lists[].short), one line on the phone
    const metas = (dir, name) => JSON.parse(fs.readFileSync(path.join(out, "catalog", "movie", dir, `genre=${name}.json`), "utf8")).metas;
    const an = metas("mood-engine-lists", "IW best animated 2025");
    a.equal(an.length, 64);
    a.deepEqual(an.slice(0, 3).map((m) => m.id), ["tt0245429", "tt9362722", "tt0432283"], "Spirited Away, Across the Spider-Verse, Fantastic Mr. Fox: the article's #1-#3");
    const fr = metas("mood-engine-lists", "IW best French 2023");
    a.equal(fr.length, 38, "39 minus the series");
    a.ok(!fr.some((m) => m.id === "tt3053694"), "Li'L Quinquin is a series");
    // ...of THAT list only: the older IndieWire copy (verosanzb, a Letterboxd list) has it at #21 and keeps it (review S4-B)
    const old = metas("mood-engine-lists", "IW best French, older ed.");
    a.equal(old.length, 35);
    a.equal(old.findIndex((m) => m.id === "tt3053694"), 20, "Li'l Quinquin at #21 of the verosanzb copy");
    a.deepEqual(fr.slice(0, 2).map((m) => m.id), ["tt1100048", "tt1602620"], "35 Shots of Rum, Amour");
    const un = metas("mood-engine-lists-unseen", "IW best animated 2025");
    a.ok(un.length < 64 && un.length > 10 && un.every((m) => an.some((x) => x.id === m.id)));
    // the older editions are still there, untouched
    a.equal(metas("mood-engine-lists", "IW best animated, older ed.").length, 30);
  } finally { fs.rmSync(out, { recursive: true, force: true }); fs.rmSync(cache, { recursive: true, force: true }); }
});

test("build with a malformed static list file stops before anything is read, naming the file", () => {
  const dir = tmp("static-bad-"), root = path.join(dir, "repo");
  // judged on the path inside the repository: a checkout that itself lives under a .context/ folder must still be copied (12/10/2026)
  fs.cpSync(ROOT, root, { recursive: true, filter: (s) => !/^(\.context|node_modules|\.git|docs|cache)(\/|$)/.test(path.relative(ROOT, s)) });
  try {
    const f = path.join(root, "data", "lists", "indiewire-fr-2023.json");
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    d.items[3].imdb = "not-an-id";
    fs.writeFileSync(f, JSON.stringify(d));
    const r = spawnSync(process.execPath, ["build.js", "--offline", "--cache-only", "--skip-friends", "--out", path.join(dir, "out")], { cwd: root, encoding: "utf8", env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" } });
    a.notEqual(r.status, 0);
    a.match(r.stderr, /list indiewire-fr-2023: .*indiewire-fr-2023\.json item 4 .*imdb must look like tt1234567/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
