// node --test            (no dependencies)
// The pieces of the calculated options of the Discover (Marco, 29/10/2026, questionnaire "peças por opção do Discover"; lib/index-export.js optionPieces): one file
// data/index-v2-opt-<catalog>-<option>.json per option that has `ids`, with the films of its first three pages (300 that the default view shows), the option's ids and
// the two totals of the WHOLE option. The Worker reads it for pages 1 to 3 instead of the 9.4 MB index-v2.json (worker/test/discover-pieces.test.js proves the answers are the same).
// What is asserted here: where the cut falls (on what the screen shows, not on the 300th id), the totals, the envelope every other v2 piece has, the card of a director keeping its
// "X loves" texts, the count of files on disk, that verify.js and the validation name each way a piece can be wrong, and that the other files of the v2 family are the ones they always were.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BD = require("../lib/board");
const { buildIndex, writeIndex, pieces, pieces2, optionCut, optionPieces, v2OptFile, OPT_FILMS, ANIMATION_PIECE_MAX_BYTES, discoverLabels } = require("../lib/index-export");
const { buildPlan } = require("../lib/plan");
const { encode, decode, COLS } = require("../lib/index-rows");
const { compile } = require("../lib/moods");
const { verifyIndex } = require("../verify");
const { checkIndex, validateIndex } = require("../lib/index-validation");
const { isPublicFile } = require("../lib/learning/public");

const CONFIG = require("../lib/board-shared").legacyConfig(require("../config.json"));
const FIXTURE = require("./fixtures/board-v2.json");
const MOODS = compile(CONFIG.moods.filter((m) => ["lift", "escape", "slow"].includes(m.id)));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mood-opt-pieces-"));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

// ── the small world of test/board-v2-index.test.js, with a Discover of four calculated options and a list option ──────────────────────────────────────────────────────────────────

const item = (id, title) => ({ id, tmdb: null, slug: null, title, year: 2000, why: ["row text"], overview: "", genres: [], directors: [] });
const A = item("tt0000001", "Alpha"), B = item("tt0000002", "Beta"), C = item("tt0000003", "Gamma"), D = item("tt0000004", "Delta"), E = item("tt0000005", "Epsilon"), F = item("tt0000006", "Zeta");
const fit = (film, norm, rank) => ({ film: { imdb: film.id }, fitInfo: { norm }, rank });
const RANKED = { escape: [fit(A, 0.9, 3), fit(C, 0.8, 2)], slow: [fit(D, 0.7, 1)], lift: [fit(A, 0.6, 0.5)] };
const ROWS = { tonight: [A, B], escape: [A, C], slow: [D], lift: [A], directors: [], oldfriends: [], watchlist: [] };
const EXTRA = { fromlists: [], short: [E], newforyou: [F], "friends-week": [B, F], "directors-loved": [] };
const V2_BOARD = { ...FIXTURE, countries: ["Japan", "Spain", "Brazil"] };
const VIEW = { users: [], films: { alpha: { slug: "alpha", title: "Alpha", year: 1999, imdbId: "tt0000001", c: ["Japan", "Spain", "Brazil"] } } };

function world() {
  const cfg = { ...CONFIG, board: V2_BOARD };
  const spec = BD.parse(cfg);
  const plan = buildPlan({ moods: MOODS, rows: ROWS, extra: EXTRA, sizes: { row: 30, friends: 30, discover: 60 }, board: spec });
  const base = { cfg, view: VIEW, today: "2026-10-10", builtAt: "2026-10-10T12:00:00.000Z", moods: MOODS, ranked: RANKED, quality: { eligible: () => true, minStars: 3.5 } };
  const menu = BD.menuFor(spec, MOODS);
  const ix = buildIndex({ ...base, plan });
  const ix2 = buildIndex({ ...base, plan: { board: plan.board2, discover: plan.discover }, moods: menu.moods, v2: { menu: menu.menu, countries: spec.countries } });
  return { ix, ix2 };
}

const tt = (i) => `tt${String(1000000 + i)}`;
const film = (i, o = {}) => ({ tt: tt(i), name: `Film ${i}`, year: 1990 + (i % 10), decade: `${1990 + (i % 10) - ((1990 + (i % 10)) % 10)}s`, runtime: 100, countries: ["Brazil"], genres: ["Drama"], rank: 9 - i / 1000, eligible: true, find: ` film ${i}`, ...o });
// "Big": 350 films, every 7th seen (50), two held back by the music rule; the screen shows 300 of the first 343 + ... ids, so the cut is past the 300th id
const BIG_FILMS = Array.from({ length: 350 }, (_, i) => film(i + 1, i % 7 === 6 ? { seen: true } : i === 10 || i === 11 ? { musicOut: true } : {}));
const SMALL_FILMS = Array.from({ length: 40 }, (_, i) => film(500 + i, i === 3 ? { seen: true } : {}));
const UNION_FILMS = Array.from({ length: 320 }, (_, i) => film(600 + i, i % 5 === 4 ? { seen: true } : i % 11 === 0 ? { eligible: undefined } : {})); // a curated option: no recommendation rule, so a film that fails it may sit in it
UNION_FILMS.forEach((f) => { if (f.eligible === undefined) delete f.eligible; });
const LOVED = [film(950), film(951)];
const ALL = [...BIG_FILMS, ...SMALL_FILMS, ...UNION_FILMS, ...LOVED];
const idsOf = (fs_) => fs_.map((f) => f.tt);
const DISCOVER = {
  order: ["moods", "places", "explore", "search"], retire: [], seen: { name: "seen", option: "Include seen" },
  catalogs: [{ id: "places", name: "Mood Engine · Countries & regions", options: [
    { id: "c-big", label: "Big", ids: idsOf(BIG_FILMS) }, { id: "c-small", label: "Small", ids: idsOf(SMALL_FILMS) }, { id: "u-union", label: "Union", ids: idsOf(UNION_FILMS), curated: true },
    { id: "d-lynch", label: "Lynch", ids: idsOf(LOVED), curated: true, director: "Lynch loves" }, { id: "l-aaa", label: "Alpha list", list: "aaa" },
  ] }],
};
function discoverWorld() {
  const { ix, ix2 } = world();
  const films = [...ix2.films, ...ALL].sort((a, b) => (b.rank ?? -Infinity) - (a.rank ?? -Infinity) || a.tt.localeCompare(b.tt));
  const directors = { options: [{ label: "Lynch loves", ids: idsOf(LOVED), descs: ["Loved by Lynch · Film 950.", "Loved by Lynch · Film 951."] }] };
  const ix2d = { ...ix2, films, meta: { ...ix2.meta, count: films.length }, lists: [{ id: "aaa", label: "Alpha list", short: "Alpha", popular: false, films: 0 }], directors, discover: DISCOVER };
  return { ix, ix2: ix2d };
}

/** The same count worked out here, not by optionCut: what the Worker's default view and "Include seen" show of an option, in order. */
const screen = (ids, byTt, { curated = false } = {}) => {
  const shown = ids.filter((t) => { const e = byTt.get(t); return curated ? !e.seen : e.eligible && !e.musicOut && !e.seen; });
  const all = ids.filter((t) => { const e = byTt.get(t); return curated ? true : e.eligible && !e.musicOut; });
  return { shown, all };
};

test("option pieces: the cut falls after the 300th film the default view shows (a film he has seen takes a place in the ids and none on the screen), the totals are the whole option's", () => {
  const { ix2 } = discoverWorld();
  const byTt = new Map(ix2.films.map((f) => [f.tt, f]));
  const big = DISCOVER.catalogs[0].options[0];
  const s = screen(big.ids, byTt);
  assert.equal(s.shown.length, 350 - 50 - 2, "350 ids, 50 seen, 2 held back by the music rule: 298 on the screen");
  assert.deepEqual(optionCut(byTt, big), { n: 350, total: 298, totalAll: 348 }, "fewer than 300 shown: the piece holds every id");
  const wide = { ...big, ids: [...big.ids, ...idsOf(SMALL_FILMS)] };
  const w = screen(wide.ids, byTt);
  const cutAt = wide.ids.indexOf(w.shown[OPT_FILMS - 1]) + 1;
  assert.deepEqual(optionCut(byTt, wide), { n: cutAt, total: w.shown.length, totalAll: w.all.length });
  assert.equal(cutAt, 352, "the 298 shown films of Big, then the first two unseen films of Small: the 300th shown film is the 352nd id");
  assert.equal(w.shown.indexOf(wide.ids[cutAt - 1]), OPT_FILMS - 1, "the last id kept is the 300th film shown");
});

test("option pieces: the totals of a calculated option count no short (`shortOut`, bit 16; 15/11/2026), seen or not, exactly as the Worker's `recommendable` shows none; a curated option counts its shorts; the short stays in the ids", () => {
  const { ix2 } = discoverWorld();
  const big = DISCOVER.catalogs[0].options[0], union = DISCOVER.catalogs[0].options[2];
  // five films of Big become shorts: three unseen, one seen, one that the music rule also holds back; and three of the curated union
  const shortOf = new Set([tt(2), tt(3), tt(4), tt(7), tt(11), tt(601), tt(602), tt(604)]);
  const films = ix2.films.map((f) => (shortOf.has(f.tt) ? { ...f, runtime: 20, shortOut: true } : f));
  const byTt = new Map(films.map((f) => [f.tt, f])), before = new Map(ix2.films.map((f) => [f.tt, f]));
  assert.ok(byTt.get(tt(7)).seen && byTt.get(tt(11)).musicOut && byTt.get(tt(604)).seen, "(control: one short is seen, one is held back by the music rule, one of the union's is seen)");
  const was = optionCut(before, big), now = optionCut(byTt, big);
  assert.deepEqual(was, { n: 350, total: 298, totalAll: 348 });
  assert.deepEqual(now, { n: 350, total: 298 - 3, totalAll: 348 - 4 }, "three unseen shorts leave the default view; with Include seen the seen short leaves too; the one the music rule already held back was not counted");
  // the same count, worked out here as the Worker shows it: eligible, not held back, not a short
  const shown = big.ids.filter((t) => { const e = byTt.get(t); return e.eligible && !e.musicOut && !e.shortOut; });
  assert.deepEqual([now.total, now.totalAll], [shown.filter((t) => !byTt.get(t).seen).length, shown.length]);
  // an ERA option (`shorts: true`: its file names its shorts) counts its shorts and still counts no film the music rule holds back: the totals of Big before the bit
  const era = { ...big, id: "e-era", label: "Era", shorts: true };
  assert.deepEqual(optionCut(byTt, era), { n: 350, total: 298, totalAll: 348 }, "an era counts its shorts as shown; the short that the music rule holds back is still not counted");
  assert.deepEqual(optionCut(byTt, { ...era, shorts: false }), now, "`shorts` anything but true is the rule of every calculated option");
  // the validator: the key is `true`, on an option with ids that is not curated, and only where it is allowed BY OPTION ID (15/11/2026, review: "any calculated option" let a decade through):
  // an era with a file in data/eras, or the period Marco keeps the shorts in ("Keep shorts in the Silent era only (recommended)": lib/discover-catalogs.js SHORTS_PERIODS)
  const withOption = (o) => ({ ...ix2, films, discover: { ...DISCOVER, catalogs: [{ ...DISCOVER.catalogs[0], options: [...DISCOVER.catalogs[0].options, o] }] } });
  for (const id of ["e-nouvelle-vague", "e-noir", "e-silent"]) assert.doesNotThrow(() => validateIndex(withOption({ id, label: "Era", ids: big.ids, shorts: true }), "index-v2"), id);
  const REFUSED = /index-v2: Invalid index discover option [a-z0-9-]+: shorts is true on an era with a file \(data\/eras\) or a period that keeps its shorts \(e-silent\), with ids and not curated, or absent/;
  for (const bad of [
    { id: "e-silent", label: "Era", ids: big.ids, shorts: false }, { id: "e-silent", label: "Era", ids: big.ids, shorts: 1 }, { id: "e-silent", label: "Era", ids: big.ids, shorts: true, curated: true }, { id: "e-silent", label: "Era", list: "aaa", shorts: true },
    { id: "e-classic-hollywood", label: "Era", ids: big.ids, shorts: true }, // a period Marco did not keep the shorts in
    { id: "e-weimar", label: "Era", ids: big.ids, shorts: true },
    { id: "p-1960s", label: "Era", ids: big.ids, shorts: true }, // a decade (the reviewer's case)
    { id: "c-france", label: "Era", ids: big.ids, shorts: true }, { id: "g-drama", label: "Era", ids: big.ids, shorts: true },
    { id: "e-era", label: "Era", ids: big.ids, shorts: true }, // an id that looks like an era and has no file
  ]) assert.throws(() => validateIndex(withOption(bad), "index-v2"), REFUSED, JSON.stringify({ ...bad, ids: undefined }));
  // the BUILD's conference with a v2 index (lib/index-export.js assertShortsMarked): the v2 index that is about to be written holds eight films under the floor and not one mark; the validator of what is read accepts it (an index of before), writeIndex does not
  const { ix } = discoverWorld();
  const unmarked = { ...ix2, films: films.map(({ shortOut, ...f }) => f) };
  assert.equal(unmarked.films.filter((f) => f.runtime === 20).length, 8, "(control: the eight shorts are there, with no mark)");
  assert.doesNotThrow(() => validateIndex(unmarked, "index-v2"), "(control: an index with no mark at all is an index of before the bit, and is accepted when read)");
  { const out = tmp(); try { assert.throws(() => writeIndex(out, ix, unmarked), /index-v2: 8 film\(s\) have a known runtime under 40 minutes and not one carries the short mark \(shortOut, bit 16 of the flags\): the build did not write it/); assert.equal(fs.existsSync(path.join(out, "data")), false, "nothing was written"); } finally { rm(out); } }
  { const out = tmp(); try { assert.doesNotThrow(() => writeIndex(out, ix, { ...ix2, films }), "the same index with its marks is written"); } finally { rm(out); } }
  // a curated option has no rule: its totals are the ones of before, shorts and all
  assert.deepEqual(optionCut(byTt, union), optionCut(before, union));
  assert.ok(union.ids.filter((t) => byTt.get(t).shortOut).length === 3);
  // the piece: the short is among its films (the ids keep it), and the option in it says the new totals
  const parts = optionPieces({ ...ix2, films });
  const piece = parts.find((p) => p.part === "v2-opt:places:c-big");
  assert.ok(piece.obj.films.some((f) => f.tt === tt(2) && f.shortOut === true), "the short is in the piece, marked");
  const opt = piece.obj.discover.catalogs[0].options.find((o) => o.id === "c-big");
  assert.deepEqual([opt.total, opt.totalAll], [now.total, now.totalAll]);
});

test("option pieces: one file per calculated option (4 here), none for a list option; each holds the films of its ids, the menus of every other piece, and in its own option the ids and the totals", () => {
  const { ix2 } = discoverWorld();
  const parts = optionPieces(ix2);
  assert.equal(parts.length, 4, "Big, Small, Union and the card of a director; the list option reads the list's own piece");
  assert.deepEqual(parts.map((p) => p.rel), ["places-c-big", "places-c-small", "places-u-union", "places-d-lynch"].map((n) => path.join("data", `index-v2-opt-${n}.json`)));
  assert.deepEqual(parts.map((p) => p.part), ["v2-opt:places:c-big", "v2-opt:places:c-small", "v2-opt:places:u-union", "v2-opt:places:d-lynch"]);
  const byTt = new Map(ix2.films.map((f) => [f.tt, f]));
  for (const p of parts) {
    const [c, o] = p.part.split(":").slice(1);
    const whole = DISCOVER.catalogs[0].options.find((x) => x.id === o);
    const got = p.obj.discover.catalogs[0].options.find((x) => x.id === o);
    const s = screen(whole.ids, byTt, { curated: !!whole.curated });
    const n = s.shown.length >= OPT_FILMS ? whole.ids.indexOf(s.shown[OPT_FILMS - 1]) + 1 : whole.ids.length;
    assert.deepEqual(got.ids, whole.ids.slice(0, n), `${p.part}: the first ids`);
    assert.deepEqual([got.total, got.totalAll], [s.shown.length, s.all.length], `${p.part}: the totals of the WHOLE option`);
    assert.deepEqual(p.obj.films.map((f) => f.tt).sort(), got.ids.slice().sort(), `${p.part}: exactly the films of those ids`);
    assert.equal(p.obj.meta.part, p.part);
    assert.equal(p.obj.meta.count, p.obj.films.length);
    assert.deepEqual(p.obj.board, [], `${p.part}: no Board rows`);
    assert.deepEqual(p.obj.rows, {});
    for (const x of p.obj.discover.catalogs[0].options) if (x.id !== o && x.ids) assert.deepEqual(x.ids, [], `${p.part}: ${x.id} carries no ids in another option's piece`);
    assert.deepEqual(p.obj.discover.catalogs[0].options.find((x) => x.id === "l-aaa"), { id: "l-aaa", label: "Alpha list", list: "aaa" }, "a list option as it is");
    for (const k of ["moods", "moodMenu", "lists"]) assert.deepEqual(p.obj[k], ix2[k], `${p.part}: ${k} is the whole index's`);
    assert.deepEqual(p.obj.friends.people, ix2.friends.people);
    assert.equal(p.obj.meta.builtAt, ix2.meta.builtAt);
  }
  assert.deepEqual(discoverLabels(ix2.discover).catalogs[0].options[0].ids, [], "the labels of the other files are unchanged");
  assert.equal(optionPieces({ ...ix2, discover: undefined }).length, 0, "no `discover`, no piece");
});

test("option pieces: the card of a director keeps its own \"X loves\" option with the texts the Worker reads, and no other director's films", () => {
  const { ix2 } = discoverWorld();
  const parts = Object.fromEntries(optionPieces(ix2).map((p) => [p.part, p.obj]));
  assert.deepEqual(parts["v2-opt:places:d-lynch"].directors.options, [{ label: "Lynch loves", ids: idsOf(LOVED), descs: ["Loved by Lynch · Film 950.", "Loved by Lynch · Film 951."] }]);
  for (const part of ["v2-opt:places:c-big", "v2-opt:places:c-small", "v2-opt:places:u-union"]) assert.deepEqual(parts[part].directors.options, [{ label: "Lynch loves", ids: [], descs: [] }], part);
});

test("option pieces: a curated option has no rule — only the seen films are held back, and the cut falls after the 300th unseen one", () => {
  const { ix2 } = discoverWorld();
  const byTt = new Map(ix2.films.map((f) => [f.tt, f]));
  const union = DISCOVER.catalogs[0].options[2];
  const unseen = union.ids.filter((t) => !byTt.get(t).seen);
  assert.equal(unseen.length, 320 - 64, "every 5th of 320 is seen");
  assert.ok(union.ids.some((t) => !byTt.get(t).eligible && !byTt.get(t).seen), "a film that fails the recommendation rule sits in the option and is shown");
  assert.deepEqual(optionCut(byTt, union), { n: 320, total: 256, totalAll: 320 }, "fewer than 300 on the screen: every id");
  const big = { ...union, ids: [...union.ids, ...idsOf(BIG_FILMS)] };
  const shown = big.ids.filter((t) => !byTt.get(t).seen);
  assert.equal(optionCut(byTt, big).n, big.ids.indexOf(shown[OPT_FILMS - 1]) + 1);
});

test("option pieces: the file name is the Worker's urls.opt (encodeURIComponent of catalog and option), a name the public files do not allow stops the build, two options cannot write one file", () => {
  assert.equal(v2OptFile("places", "c-big"), path.join("data", "index-v2-opt-places-c-big.json"));
  const { ix2 } = discoverWorld();
  for (const p of optionPieces(ix2)) assert.ok(isPublicFile(p.rel.split(path.sep).join("/")), `${p.rel} is a public file`);
  const upper = { ...ix2, discover: { ...DISCOVER, catalogs: [{ ...DISCOVER.catalogs[0], options: [{ id: "C_Big", label: "Big", ids: idsOf(BIG_FILMS) }] }] } };
  assert.throws(() => optionPieces(upper), /Discover option places \/ C_Big: the piece data\/index-v2-opt-places-C_Big\.json is not a name the public files allow/);
  const twice = { ...ix2, discover: { ...DISCOVER, order: [...DISCOVER.order, "places-c"], catalogs: [{ ...DISCOVER.catalogs[0], id: "places-c", options: [{ id: "big", label: "A", ids: idsOf(BIG_FILMS) }] }, { ...DISCOVER.catalogs[0], id: "places", options: [{ id: "c-big", label: "B", ids: idsOf(BIG_FILMS) }] }] } };
  assert.throws(() => optionPieces(twice), /two options write the piece data\/index-v2-opt-places-c-big\.json/);
});

test("option pieces on disk: written next to the v2 files, counted apart (the other files are as they always were), decodable, and verify.js accepts them; each way a piece can be wrong is named", () => {
  const out = tmp();
  try {
    const { ix, ix2 } = discoverWorld();
    const w = writeIndex(out, ix, ix2);
    require("../test-support/film-page-fixture").writeMinimalPages(out, ix2);
    assert.equal(w.v2.options.files, 4, "the count of option pieces, fixed on the synthetic index: 4 calculated options, no piece for the list option");
    assert.equal(w.v2.files, pieces2(ix2).length, "`files` still counts the menus, the rows and the moods alone");
    const dataNames = fs.readdirSync(path.join(out, "data")).sort();
    const optNames = dataNames.filter((n) => n.startsWith("index-v2-opt-"));
    assert.deepEqual(optNames, ["index-v2-opt-places-c-big.json", "index-v2-opt-places-c-small.json", "index-v2-opt-places-d-lynch.json", "index-v2-opt-places-u-union.json"]);
    // every other file is what the unchanged cutters produce, byte for byte: the change adds files and rewrites none
    const text = (obj) => JSON.stringify(encode(obj));
    const expected = { "index.json": text(ix), "index-v2.json": text(ix2) };
    for (const p of pieces(ix)) expected[path.basename(p.rel)] = text(p.obj);
    for (const p of pieces2(ix2)) expected[path.basename(p.rel)] = text(p.obj);
    for (const [name, want] of Object.entries(expected)) assert.equal(fs.readFileSync(path.join(out, "data", name), "utf8"), want, name);
    assert.deepEqual(dataNames.filter((n) => !n.startsWith("index-v2-opt-") && n.startsWith("index")), Object.keys(expected).sort(), "no other index file appeared");
    assert.equal(w.v2.options.bytes, optNames.reduce((n, f) => n + fs.statSync(path.join(out, "data", f)).size, 0), "the bytes reported are the files'");
    const big = decode(JSON.parse(fs.readFileSync(path.join(out, "data", "index-v2-opt-places-c-big.json"), "utf8")));
    assert.equal(big.films.length, 350);
    const ok = verifyIndex(out);
    assert.equal(ok.ok, true, ok.problems.join("\n"));
    assert.equal(ok.stats.v2.options.files, 4);

    const edit = (name, fn, opts) => {
      const file = path.join(out, "data", name), before = fs.readFileSync(file, "utf8"), j = JSON.parse(before);
      fn(j);
      fs.writeFileSync(file, JSON.stringify(j));
      try { return verifyIndex(out, opts).problems.join("\n"); } finally { fs.writeFileSync(file, before); }
    };
    // Security sweep of 29/10/2026: the privacy scan (an e-mail address, the words verify.js is told to forbid) reads the option pieces too, and its problem names the piece. Written into a piece ONLY, so the whole index is not what is caught.
    const say = (text) => (j) => { const row = j.films[0]; while (row.length <= COLS.indexOf("desc")) row.push(null); row[COLS.indexOf("desc")] = text; };
    assert.match(edit("index-v2-opt-places-c-small.json", say("write to x@y.com")), /index-v2-opt-places-c-small\.json contains something that looks like an e-mail address: x@y\.com/);
    assert.match(edit("index-v2-opt-places-d-lynch.json", say("logged by MGusmao"), { forbid: ["mgusmao"] }), /index-v2-opt-places-d-lynch\.json contains "mgusmao"/);
    assert.doesNotMatch(edit("index-v2-opt-places-c-small.json", say("logged by MGusmao"), { forbid: ["mgusmao"] }), /index-v2\.json contains/, "and only the piece is named");
    const opt = (j, id = "c-big") => j.discover.catalogs[0].options.find((x) => x.id === id);
    assert.match(edit("index-v2-opt-places-c-big.json", (j) => { j.films.pop(); j.meta.count--; }), /index-v2-opt-places-c-big: 1 film\(s\) it should hold are missing/);
    const foreign = JSON.parse(fs.readFileSync(path.join(out, "data", "index-v2.json"), "utf8")).films.find((r) => r[0] === "tt0000004");
    assert.match(edit("index-v2-opt-places-c-small.json", (j) => { j.films.push(foreign); j.meta.count++; }), /index-v2-opt-places-c-small: 1 film\(s\) it should not hold/);
    assert.match(edit("index-v2-opt-places-c-big.json", (j) => { opt(j).total++; }), /index-v2-opt-places-c-big: the Discover menus, or the option's ids and totals \(the first 350 ids, 298 films by default, 348 with Include seen\), differ/);
    assert.match(edit("index-v2-opt-places-c-big.json", (j) => { opt(j).totalAll--; }), /the option's ids and totals/);
    // the Worker cannot see a total that is too HIGH (worker/test/discover-pieces.test.js pins that): verify.js is the only barrier, so it must refuse +50 as well as +1
    assert.match(edit("index-v2-opt-places-c-big.json", (j) => { opt(j).total += 50; opt(j).totalAll += 50; }), /the option's ids and totals/);
    assert.match(edit("index-v2-opt-places-c-big.json", (j) => { opt(j).ids.pop(); }), /the option's ids and totals/);
    assert.match(edit("index-v2-opt-places-c-big.json", (j) => { delete opt(j).total; delete opt(j).totalAll; }), /must carry total and totalAll/);
    assert.match(edit("index-v2-opt-places-c-small.json", (j) => { opt(j, "c-big").ids = ["tt1000001"]; }), /carries 1 films, and only the whole index carries them|carries a total|the option's ids and totals/);
    assert.match(edit("index-v2-opt-places-d-lynch.json", (j) => { j.directors.options[0].descs = []; }), /directors option Lynch loves must have one text per film|only the whole index carries the films of the directors options/);
    assert.match(edit("index-v2-opt-places-c-big.json", (j) => { j.directors.options[0].ids = ["tt1000950"]; j.directors.options[0].descs = ["x"]; }), /only the whole index carries the films of the directors options/);
    assert.match(edit("index-v2.json", (j) => { opt(j).total = 1; }), /carries a total, which only the piece of that option does/);
    // a piece for an option the index does not have, and an option whose piece is missing
    fs.writeFileSync(path.join(out, "data", "index-v2-opt-places-ghost.json"), "{}");
    assert.match(verifyIndex(out).problems.join("\n"), /data\/index-v2-opt-places-ghost\.json is a v2 file the index does not account for/);
    fs.rmSync(path.join(out, "data", "index-v2-opt-places-ghost.json"));
    fs.renameSync(path.join(out, "data", "index-v2-opt-places-c-small.json"), path.join(out, "data", "x.tmp"));
    assert.match(verifyIndex(out).problems.join("\n"), /index-v2-opt-places-c-small\.json/);
    fs.renameSync(path.join(out, "data", "x.tmp"), path.join(out, "data", "index-v2-opt-places-c-small.json"));
    assert.equal(verifyIndex(out).ok, true);
  } finally { rm(out); }
});

test("option pieces: the validation takes the totals only in the piece of their option, whole numbers, total no more than totalAll", () => {
  const { ix2 } = discoverWorld();
  const [p] = optionPieces(ix2);
  const enc = (o) => encode(o);
  assert.doesNotThrow(() => { const problems = []; checkIndex(p.part, enc(p.obj), problems); assert.deepEqual(problems, []); });
  const bad = (fn) => { const o = JSON.parse(JSON.stringify(p.obj)); fn(o.discover.catalogs[0].options.find((x) => x.id === "c-big")); const problems = []; checkIndex(p.part, enc(o), problems); return problems.join("\n"); };
  assert.match(bad((x) => { x.total = 400; }), /must carry total and totalAll, whole numbers, total no more than totalAll/);
  assert.match(bad((x) => { x.total = 1.5; }), /must carry total and totalAll/);
  assert.match(bad((x) => { x.totalAll = -1; }), /must carry total and totalAll/);
  assert.match(bad((x) => { x.ids = [x.ids[0], x.ids[0]]; }), /names a film twice/);
  // the mark of the shorts in a FILE of the family (a piece, the menus): only on an era with a file or on the period that keeps its shorts, and only as true (15/11/2026)
  assert.match(bad((x) => { x.shorts = true; }), /Invalid index discover option c-big: shorts is true on an era with a file \(data\/eras\) or a period that keeps its shorts \(e-silent\), with ids and not curated, or absent/);
  assert.doesNotMatch(bad((x) => { x.id = "e-silent"; x.shorts = true; }), /shorts is true on/, "under the id of the Silent era the mark is accepted");
  assert.match(bad((x) => { x.id = "e-silent"; x.shorts = 1; }), /Invalid index discover option e-silent: shorts is true on/);
  assert.match(bad((x) => { x.ids = ["tt9999999"]; }), /tt9999999 in discover places \/ Big is not among the films/);
  assert.throws(() => validateIndex({ ...ix2, discover: { ...DISCOVER, catalogs: [{ ...DISCOVER.catalogs[0], options: [{ id: "c-big", label: "Big", ids: idsOf(BIG_FILMS), total: 1, totalAll: 2 }] }] } }, "index-v2"), /carries a total, which only the piece of that option does/);
});

function animationWorld() {
  const w = discoverWorld();
  const ids = idsOf([...BIG_FILMS, ...SMALL_FILMS]);
  w.ix2.discover = { ...w.ix2.discover, order: [...w.ix2.discover.order, "genres"], catalogs: [...w.ix2.discover.catalogs, {
    id: "genres", name: "Genres", options: [
      { id: "g-animation", label: "Animation", ids },
      { id: "g-drama", label: "Drama", ids },
    ],
  }] };
  return w;
}
const animationPiece = (ix) => optionPieces(ix).find((p) => p.part === "v2-opt:genres:g-animation").obj;
const animationOption = (ix) => ix.discover.catalogs.find((c) => c.id === "genres").options[0];

// Assemble the complete expected file independently of the exporter choosing full vs prefix.
function expectedCompleteAnimation(ix) {
  const p = structuredClone(animationPiece(ix)), ids = animationOption(ix).ids;
  p.films = ix.films.filter((f) => ids.includes(f.tt));
  p.meta.count = p.films.length;
  animationOption(p).ids = ids.slice();
  return p;
}

function animationAtBytes(bytes) {
  const ix = structuredClone(animationWorld().ix2), ids = new Set(animationOption(ix).ids);
  const films = ix.films.filter((f) => ids.has(f.tt));
  for (const f of films) f.desc = "a";
  let remaining = bytes - Buffer.byteLength(JSON.stringify(encode(expectedCompleteAnimation(ix))));
  assert.ok(remaining > 0);
  // At most 600 characters per synopsis: exceed the byte limit with ordinary-length multibyte text.
  for (const f of films) {
    const n = Math.min(remaining, 1800);
    f.desc += "字".repeat(Math.floor(n / 3)) + "a".repeat(n % 3);
    remaining -= n;
  }
  assert.equal(remaining, 0, "the fixture has enough ordinary-length descriptions to reach the boundary");
  assert.equal(Buffer.byteLength(JSON.stringify(encode(expectedCompleteAnimation(ix)))), bytes);
  return ix;
}

test("Animation's small complete piece keeps all candidates and truthful totals; Drama and a person's independent index keep their prefixes", () => {
  const { ix2 } = animationWorld();
  const whole = animationOption(ix2);
  const byTt = new Map(ix2.films.map((f) => [f.tt, f]));
  const cut = optionCut(byTt, whole);
  assert.ok(cut.n < whole.ids.length, "the old prefix actually omits candidates in this fixture");
  const part = animationPiece(ix2);
  assert.deepEqual(animationOption(part).ids, whole.ids, "keep the option's order and every candidate");
  assert.deepEqual([animationOption(part).total, animationOption(part).totalAll], [cut.total, cut.totalAll]);
  assert.deepEqual(part.films, ix2.films.filter((f) => whole.ids.includes(f.tt)), "keep every original field and the full index's film order");
  const drama = optionPieces(ix2).find((p) => p.part === "v2-opt:genres:g-drama").obj;
  assert.deepEqual(drama.discover.catalogs.find((c) => c.id === "genres").options[1].ids, whole.ids.slice(0, cut.n));
  const independent = animationPiece({ ...ix2, meta: { ...ix2.meta, personId: "friend-a" } });
  assert.deepEqual(animationOption(independent).ids, whole.ids.slice(0, cut.n));
});

test("Animation on disk: publication accepts the complete piece and refuses missing candidates, changed order, totals and film text", () => {
  const out = tmp();
  try {
    const { ix, ix2 } = animationWorld();
    writeIndex(out, ix, ix2);
    require("../test-support/film-page-fixture").writeMinimalPages(out, ix2);
    const file = path.join(out, v2OptFile("genres", "g-animation"));
    const original = fs.readFileSync(file, "utf8"), disk = JSON.parse(original);
    assert.deepEqual(animationOption(disk).ids, animationOption(ix2).ids);
    const good = verifyIndex(out);
    assert.equal(good.ok, true, good.problems.join("\n"));
    const refuses = (change, pattern) => {
      const changed = JSON.parse(original);
      change(changed);
      fs.writeFileSync(file, JSON.stringify(changed));
      try {
        const result = verifyIndex(out);
        assert.equal(result.ok, false);
        assert.match(result.problems.join("\n"), pattern);
      } finally { fs.writeFileSync(file, original); }
    };
    refuses((j) => { j.films.pop(); j.meta.count--; }, /film\(s\) it should hold are missing/);
    refuses((j) => { animationOption(j).ids.reverse(); }, /the option's ids and totals/);
    refuses((j) => { animationOption(j).totalAll--; }, /the option's ids and totals/);
    refuses((j) => { animationOption(j).total++; }, /the option's ids and totals/);
    refuses((j) => { j.films[0][COLS.indexOf("name")] = "Different title"; }, /differs from the same film in index-v2/);
    // Dropping both the last ID and its film must not turn a partial file into a claimed complete one.
    refuses((j) => {
      const removed = animationOption(j).ids.pop();
      j.films = j.films.filter((r) => r[COLS.indexOf("tt")] !== removed);
      j.meta.count = j.films.length;
    }, /the option's ids and totals|film\(s\) it should hold are missing/);
  } finally { rm(out); }
});

test("Animation's byte cap includes the encoded envelope and UTF-8: exact limit is complete, one byte over retains the original prefix", () => {
  assert.equal(ANIMATION_PIECE_MAX_BYTES, 393216, "the file-size boundary");
  const at = animationAtBytes(ANIMATION_PIECE_MAX_BYTES);
  assert.deepEqual(animationOption(animationPiece(at)).ids, animationOption(at).ids);
  const over = animationAtBytes(ANIMATION_PIECE_MAX_BYTES + 1);
  const text = JSON.stringify(encode(expectedCompleteAnimation(over)));
  assert.ok(text.length < ANIMATION_PIECE_MAX_BYTES, "JS character count would incorrectly admit this file");
  assert.ok(Buffer.byteLength(JSON.stringify(encode(expectedCompleteAnimation(over)).films)) < ANIMATION_PIECE_MAX_BYTES,
    "measuring only film rows would incorrectly admit this file");
  const cut = optionCut(new Map(over.films.map((f) => [f.tt, f])), animationOption(over));
  const part = animationPiece(over);
  assert.deepEqual(animationOption(part).ids, animationOption(over).ids.slice(0, cut.n));
  assert.deepEqual([animationOption(part).total, animationOption(part).totalAll], [cut.total, cut.totalAll]);
});

test("Animation's publication verifier enforces the size fallback using the whole index", () => {
  const out = tmp();
  try {
    const { ix } = animationWorld();
    const over = animationAtBytes(ANIMATION_PIECE_MAX_BYTES + 1);
    writeIndex(out, ix, over);
    require("../test-support/film-page-fixture").writeMinimalPages(out, over);
    const good = verifyIndex(out);
    assert.equal(good.ok, true, good.problems.join("\n"));
    fs.writeFileSync(path.join(out, v2OptFile("genres", "g-animation")), JSON.stringify(encode(expectedCompleteAnimation(over))));
    const bad = verifyIndex(out);
    assert.equal(bad.ok, false);
    assert.match(bad.problems.join("\n"), /index-v2-opt-genres-g-animation:.*(it should not hold|the option's ids and totals)/);
  } finally { rm(out); }
});
