// "Loved by your directors" (Marco, 11/10/2026): lib/directors-loved.js with small fakes, and the real data/directors-loved.json validated.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const DL = require("../lib/directors-loved");
const Q = require("../lib/recommendation-quality");
const D = require("../lib/describe");
const { buildPlan, BOARD_AFTER_MOODS, DISCOVER } = require("../lib/plan");

const ROOT = path.join(__dirname, "..");
const src = (id, confidence = "high", kind = "sight-and-sound-2022") => ({ id, kind, confidence, title: id, url: `https://example.test/${id}`, date: "2022" });
const film = (n, sources, extra = {}) => ({ title: `Film ${n}`, year: 1950 + n, imdb: `tt${String(1000000 + n)}`, tmdb: 500 + n, tmdbType: "movie", letterboxd: `film-${n}`, sources, ...extra });
const stat = (label, n, avg, w) => ({ key: `d:${label.length}`, type: "director", label, n, avg, w });

/** Lynch and Scorsese love six films each; film 1 and 2 by both. */
function data() {
  return {
    generated: "2026-10-11",
    directors: [
      { name: "David Lynch", sources: [src("lynch", "medium", "interview")], films: [1, 2, 3, 4, 5, 6].map((n) => film(n, ["lynch"])) },
      { name: "Martin Scorsese", sources: [src("scorsese")], films: [1, 2, 7, 8, 9, 10].map((n) => film(n, ["scorsese"])) },
      { name: "Sean Baker", sources: [src("baker", "high", "criterion-closet")], films: [11, 12, 13, 14, 15].map((n) => film(n, ["baker"])) },
      { name: "Jeff Tremaine", sources: [src("tremaine")], films: [16, 17, 18, 19, 20].map((n) => film(n, ["tremaine"])) },
      { name: "Francis Ford Coppola", sources: [src("ffc")], films: [21].map((n) => film(n, ["ffc"])) },
      { name: "Sofia Coppola", sources: [src("sofia")], films: [22].map((n) => film(n, ["sofia"])) },
    ],
  };
}
const STATS = [stat("David Lynch", 7, 4.71, 0.87), stat("Martin Scorsese", 9, 4.2, 0.37), stat("Jeff Tremaine", 3, 4.5, 0.6), stat("Some Hack", 6, 2.5, -0.6)];
const CFG = { exclude: ["Jeff Tremaine"], accounts: { lilfilm: "Sean Baker" }, defaultWeight: 0.5 };
const favs = (o = {}) => DL.favorites({ data: data(), stats: STATS, cfg: { ...CFG, ...o.cfg }, following: o.following || [] }).list;
const films = (o = {}) => DL.lovedFilms({ data: data(), favorites: o.favs || favs(o), isSeen: o.isSeen || (() => false), peek: o.peek || (() => null) });

test("the real data/directors-loved.json: every id well formed, every source exists for its director, confidence only high or medium", () => {
  const real = DL.load(ROOT, {});
  assert.ok(real, "data/directors-loved.json is there");
  assert.deepEqual(DL.validate(real), []);
  const sources = real.directors.flatMap((d) => d.sources);
  assert.ok(sources.length >= 40 && sources.every((s) => ["high", "medium"].includes(s.confidence)));
  const filmsAll = real.directors.flatMap((d) => d.films);
  assert.ok(filmsAll.length >= 600 && filmsAll.every((f) => /^tt\d{7,}$/.test(f.imdb) && Number.isInteger(f.tmdb)));
  assert.ok(sources.some((s) => s.id === "scorsese-my-voyage-to-italy" && s.kind === "documentary" && s.confidence === "high"), "the My Voyage to Italy supplement is merged (Marco, 11/10/2026)");
});

test("validate() refuses a low-confidence source, a source the director does not have, and a malformed IMDb or TMDB id", () => {
  const d = data();
  d.directors[0].sources.push(src("fan", "low"));
  d.directors[0].films.push(film(30, ["not-there"]), film(31, ["lynch"], { imdb: "nm0000186" }), film(32, ["lynch"], { tmdb: "12" }));
  const p = DL.validate(d).join("\n");
  assert.match(p, /confidence "low"/);
  assert.match(p, /source not-there is not one of this director's sources/);
  assert.match(p, /IMDb id "nm0000186"/);
  assert.match(p, /TMDB id "12"/);
});

test("a film Marco has seen never appears, in the row or in the menu", () => {
  const seen = (r) => r.imdb === "tt1000001" || r.slug === "film-7" || r.title === "Film 8";
  const f = films({ isSeen: seen });
  const all = [...DL.row(f, { size: 30 }), ...DL.menu(f, favs(), { min: 1 }).flatMap((m) => m.films)].map((c) => c.imdb);
  for (const tt of ["tt1000001", "tt1000007", "tt1000008"]) assert.ok(!all.includes(tt), tt);
  assert.ok(all.includes("tt1000002"));
});

test("a director excluded by hand is gone, even when the ratings, the include list or a followed account would bring them in", () => {
  const list = favs({ cfg: { include: ["Jeff Tremaine"], accounts: { jeff: "Jeff Tremaine" } }, following: ["jeff"] });
  assert.ok(!list.some((f) => f.name === "Jeff Tremaine"));
  assert.ok(!films().some((c) => c.lovers.some((l) => l.name === "Jeff Tremaine")));
  // control: without the veto, the ratings alone bring him in (4.5★ over 3 films)
  assert.ok(favs({ cfg: { exclude: [] } }).some((f) => f.name === "Jeff Tremaine"));
});

test("a followed account mapped to a director brings the director in with the default weight; unmapped or not followed, nothing", () => {
  const baker = favs({ following: ["lilfilm"] }).find((f) => f.name === "Sean Baker");
  assert.ok(baker);
  assert.equal(baker.weight, 0.5);
  assert.deepEqual(baker.via, ["following"]);
  assert.ok(!favs({ following: ["seanbaker"] }).some((f) => f.name === "Sean Baker"), "a fan account is not the director");
  assert.ok(!favs().some((f) => f.name === "Sean Baker"));
  // followed AND rated, with an own weight under the default: the default still stands (0.5, not 0.3)
  const both = DL.favorites({ data: data(), stats: [...STATS, stat("Sean Baker", 3, 4.1, 0.3)], cfg: CFG, following: ["lilfilm"] }).list.find((f) => f.name === "Sean Baker");
  assert.deepEqual([both.weight, both.via], [0.5, ["ratings", "following"]]);
});

test("favourites by the ratings: at least 3 films and 4★; the weight is Marco's own taste weight; a low-rated director never enters", () => {
  const list = favs();
  assert.deepEqual(list.map((f) => [f.name, f.weight]), [["David Lynch", 0.87], ["Martin Scorsese", 0.37]]);
  assert.ok(!DL.favorites({ data: data(), stats: [stat("David Lynch", 2, 5, 0.9)], cfg: CFG }).list.length, "two films are not enough");
});

test("the row: at most 2 films per lead director, consensus first", () => {
  const f = films({ following: ["lilfilm"] });
  const row = DL.row(f, { size: 30, perDirector: 2 });
  const lead = new Map();
  for (const c of row) lead.set(c.lovers[0].name, (lead.get(c.lovers[0].name) || 0) + 1);
  assert.ok([...lead.values()].every((n) => n <= 2), JSON.stringify([...lead]));
  assert.equal(row.length, 6, "2 Lynch + 2 Scorsese + 2 Baker");
  assert.deepEqual(row.slice(0, 2).map((c) => c.imdb), ["tt1000001", "tt1000002"], "loved by both: 0.87×0.6 + 0.37×1.0 beats Lynch alone");
  assert.equal(row[0].lovers.length, 2);
  assert.equal(Number(row[0].score.toFixed(3)), Number((0.87 * 0.6 + 0.37).toFixed(3)));
});

test("ONE floor exception: a film a favourite director loves keeps its place with a Letterboxd average of 3.2 in every row; a film nobody vouches for is cut", () => {
  const f = films();
  const items = DL.row(f, { size: 30 }).map((c) => DL.toItem(c));
  const low = items[2].id, other = "tt7777777";
  const view = { films: { ...Object.fromEntries(items.map((it) => [it.id, { imdbId: it.id, r: it.id === low ? 3.2 : 4.1 }])), x: { imdbId: other, r: 3.2 } }, users: [] };
  const loved = DL.vouched({ data: data(), stats: STATS, cfg: CFG });
  assert.ok(loved.has(low) && !loved.has(other));
  assert.equal(loved.get(low).trust, "director");
  // only the FAVOURITES' films (review S4-6): an excluded director (Tremaine) and directors with no stat, no include and no followed
  // account (the two Coppolas, Baker unfollowed) vouch for nothing, though the file holds their films with high sources
  assert.deepEqual([...loved.keys()].sort(), films().map((c) => c.imdb).sort());
  for (const n of [16, 21, 22, 11]) assert.equal(loved.has(film(n, []).imdb), false, `film ${n} is not a favourite's`);
  assert.equal(DL.vouched({ data: data(), stats: STATS, cfg: CFG, following: ["lilfilm"] }).has(film(11, []).imdb), true, "followed: Baker is a favourite");
  const ratings = Q.index(view, { loved });
  const plain = (it) => { const { trust, loved: line, ...rest } = it; return rest; };
  const plan = { board: [{ id: "directors-loved", items: structuredClone(items) }, { id: "fromlists", items: [...structuredClone(items).map(plain), { id: other, why: [] }] }], discover: [] };
  Q.applyPlan(plan, ratings);
  assert.ok(plan.board[0].items.some((it) => it.id === low), "the director's endorsement skips the 3.5 floor (decision 5)");
  assert.ok(plan.board[1].items.some((it) => it.id === low), "the exception is the film's, not the item's: an ordinary row keeps it too");
  assert.ok(!plan.board[1].items.some((it) => it.id === other), "control: a film nobody vouches for still needs 3.5");
  const kept = plan.board[0].items.find((it) => it.id === low);
  assert.ok(!kept.why.some((w) => w.startsWith("Loved by")), "the Loved-by line is not repeated as a reason in its own row");
  assert.ok(plan.board[1].items.find((it) => it.id === low).why.some((w) => w.startsWith("Loved by")), "an ordinary row names why the film is there");
  // a film Letterboxd never showed (not in the view) is still vouched for: its IMDb id comes from the curated file
  const bare = Q.index({ films: {}, users: [] }, { loved });
  assert.ok(Q.qualifies(bare.get(low)));
  assert.equal(Q.qualifies(bare.get(other)), false);
  // without the love the same film is cut
  assert.equal(Q.qualifies(Q.index(view).get(low)), false);
});

test("the TMDB join refuses a TMDB id whose IMDb id is another film's: no detail, no TMDB id, the film stands on its IMDb id", () => {
  const peek = (id) => (id === 501 ? { id: 501, imdb: "tt9999999", title: "Another Film", year: 1990, poster: "/x.jpg", runtime: 50 } : id === 502 ? { id: 502, imdb: "tt1000002", title: "Film 2 (TMDB)", year: 1952, poster: "/y.jpg", runtime: 100 } : null);
  const f = films({ peek });
  const one = f.find((c) => c.imdb === "tt1000001"), two = f.find((c) => c.imdb === "tt1000002");
  assert.equal(one.detail, null);
  assert.equal(one.tmdb, null);
  assert.equal(one.title, "Film 1");
  assert.equal(DL.toItem(one).poster, null);
  assert.equal(two.detail.title, "Film 2 (TMDB)");
  assert.equal(two.tmdb, 502);
  // and a TMDB id that names another film never marks the file's film as seen through that id
  let asked = null;
  DL.lovedFilms({ data: data(), favorites: favs(), peek, isSeen: (r) => { if (r.imdb === "tt1000001") asked = r; return false; } });
  assert.equal(asked.tmdb, null);
});

test("the menu: one option per favourite with at least `min` unseen films, by Marco's weight; the shared surname becomes the full name", () => {
  const m = DL.menu(films({ following: ["lilfilm"] }), favs({ following: ["lilfilm"] }), { min: 5 });
  assert.deepEqual(m.map((o) => [o.label, o.films.length]), [["Lynch loves", 6], ["Baker loves", 5], ["Scorsese loves", 6]], "Baker 0.5 (followed: default weight) before Scorsese 0.37");
  assert.deepEqual(DL.menu(films(), favs(), { min: 7 }), []);
  const names = DL.shortNames(data().directors.map((d) => d.name));
  assert.equal(names.get("Francis Ford Coppola"), "Francis Ford Coppola");
  assert.equal(names.get("Sofia Coppola"), "Sofia Coppola");
  assert.equal(names.get("David Lynch"), "Lynch");
});

test("the plan item says who loves the film and where they said it (`loved`); the Stremio description stopped showing it on 20/10/2026 (lib/describe.js, description v3)", () => {
  const c = films().find((x) => x.imdb === "tt1000001");
  const it = DL.toItem(c, { why: ["you rate black and white films 4.6★ (35 rated)"] });
  assert.equal(it.loved, "Loved by Lynch and Scorsese · interview (2022), Sight & Sound 2022 ballot");
  assert.equal(DL.toItem(c, { first: "Martin Scorsese" }).loved, "Loved by Scorsese and Lynch · Sight & Sound 2022 ballot, interview (2022)");
  assert.ok(!D.describe({ ...it, directors: ["X"], runtime: 90, overview: "Syn." }).includes("Loved by"), "description v3 has no reasons line");
  assert.equal(it.trust, "director");
});

test("a pair's Closet Picks (Marco, 11/10/2026): the director's love names the pair in the description, the vouch and the menu; a film also chosen alone reads without it", () => {
  const pairSrc = { ...src("yl-pair", "high", "criterion-closet"), with: "Ariane Labed" }, solo = src("yl-solo", "high", "criterion-closet");
  const d = { generated: "2026-10-11", directors: [{ name: "Yorgos Lanthimos", sources: [pairSrc, solo], films: [film(31, ["yl-pair"]), film(32, ["yl-pair", "yl-solo"]), film(33, ["yl-solo"])] }] };
  assert.deepEqual(DL.validate(d), []);
  const fav = DL.favorites({ data: d, cfg: { include: ["Yorgos Lanthimos"] } }).list;
  const got = DL.lovedFilms({ data: d, favorites: fav });
  const line = (n) => DL.lovedLine(got.find((c) => c.imdb === `tt${1000000 + n}`));
  assert.equal(line(31), "Loved by Lanthimos (with Ariane Labed) · Criterion Closet");
  assert.equal(line(32), "Loved by Lanthimos · Criterion Closet", "also his own choice: no pair");
  assert.equal(line(33), "Loved by Lanthimos · Criterion Closet");
  const it = DL.toItem(got.find((c) => c.imdb === "tt1000031"), { first: "Yorgos Lanthimos" });
  assert.equal(it.loved, "Loved by Lanthimos (with Ariane Labed) · Criterion Closet", "the plan item carries the pair");
  assert.equal(DL.vouched({ data: d, cfg: { include: ["Yorgos Lanthimos"] } }).get("tt1000031").why, "Loved by Lanthimos (with Ariane Labed) · Criterion Closet", "the floor exception's reason (cvWhy) too");
  // with a second director the pair stays on its own name
  const two = { generated: "2026-10-11", directors: [...d.directors, { name: "David Lynch", sources: [src("lynch2")], films: [film(31, ["lynch2"])] }] };
  const fav2 = DL.favorites({ data: two, cfg: { include: ["Yorgos Lanthimos", "David Lynch"] } }).list;
  assert.match(DL.lovedLine(DL.lovedFilms({ data: two, favorites: fav2 }).find((c) => c.imdb === "tt1000031")), /^Loved by (Lanthimos \(with Ariane Labed\) and Lynch|Lynch and Lanthimos \(with Ariane Labed\)) · /);
  // validate: `with` is a name
  for (const bad of [7, "", "  ", "x".repeat(61)]) assert.match(DL.validate({ directors: [{ name: "Y", sources: [{ ...pairSrc, with: bad }], films: [] }] }).join(), /"with"/, JSON.stringify(bad));
});

test("the real file: the pairs are written (Lanthimos with Ariane Labed, Cuarón with Pawel Pawlikowski) and the Closet Picks of Sofia Coppola with Marc Jacobs and Mike Leigh with Marianne Jean-Baptiste are there", () => {
  const real = DL.load(ROOT, {});
  assert.deepEqual(DL.validate(real), []);
  const source = (id) => real.directors.flatMap((d) => d.sources.map((s) => ({ ...s, director: d.name }))).find((s) => s.id === id);
  assert.equal(source("lanthimos-closet-2018").with, "Ariane Labed");
  assert.equal(source("cuaron-closet").with, "Pawel Pawlikowski");
  assert.equal(source("lanthimos-closet-solo").with, undefined, "the solo visit has no pair");
  const count = (id) => real.directors.flatMap((d) => d.films).filter((f) => f.sources.includes(id)).length;
  assert.deepEqual([source("sofia-closet-marc-jacobs").director, source("sofia-closet-marc-jacobs").with, count("sofia-closet-marc-jacobs")], ["Sofia Coppola", "Marc Jacobs", 25]);
  assert.deepEqual([source("leigh-closet-jean-baptiste").director, source("leigh-closet-jean-baptiste").with, count("leigh-closet-jean-baptiste")], ["Mike Leigh", "Marianne Jean-Baptiste", 28]);
  // Things to Come is on file only through the Lanthimos & Labed visit: its line names the pair
  const fav = DL.favorites({ data: real, cfg: { include: ["Yorgos Lanthimos"] } }).list;
  const c = DL.lovedFilms({ data: real, favorites: fav }).find((x) => x.imdb === "tt0028358");
  assert.equal(DL.lovedLine(c), "Loved by Lanthimos (with Ariane Labed) · Criterion Closet");
});

test("the plan: the row sits right after Directors you trust; the Discover menu is its own catalog", () => {
  assert.deepEqual(BOARD_AFTER_MOODS, ["newforyou", "directors", "directors-loved", "oldfriends"]);
  const item = DL.toItem(films()[0]);
  const plan = buildPlan({ moods: [], rows: {}, extra: { "directors-loved": [item] }, sizes: { row: 30 }, directorMenu: [{ label: "Lynch loves", items: [item] }] });
  const row = plan.board.find((r) => r.id === "directors-loved");
  assert.equal(row.name, "🎥 Loved by your directors");
  assert.deepEqual(row.items, [{ ...item, mood: "🎥 Loved by your directors", moodIsRow: true, leadsWithReason: "loved" }], "the row's name is in `mood` and the item is marked `moodIsRow` (20/10/2026: it is no mood, so the description says no \"Mood:\"; `leadsWithReason`: line 2 starts with the director's love); the item itself is left as it was");
  const cat = plan.discover.find((c) => c.id === DISCOVER.directorsLoved.id);
  assert.deepEqual(cat.options.map((o) => o.label), ["Lynch loves"]);
  assert.equal(cat.options[0].items[0].leadsWithReason, "loved", "the Discover menu leads with the love too (Marco, 20/10/2026)");
});

test("a director's love of their OWN film is left out (Marco, 11/10/2026): not in the row, the menu or the vouch; a film another favourite loves stays through that one", () => {
  // Wenders loves his own Kings of the Road (film 31); Francis Ford Coppola and Sofia Coppola both love Rumble Fish (film 32, directed by him)
  const d = {
    directors: [
      { name: "Wim Wenders", sources: [src("wenders")], films: [film(31, ["wenders"]), film(33, ["wenders"]), film(34, ["wenders"])] },
      { name: "Francis Ford Coppola", sources: [src("ffc")], films: [film(32, ["ffc"])] },
      { name: "Sofia Coppola", sources: [src("sofia", "medium", "criterion-closet")], films: [film(32, ["sofia"])] },
    ],
  };
  const rec = (n, directors, imdb = `tt${1000000 + n}`) => ({ id: 500 + n, imdb, title: `Film ${n}`, year: 1950 + n, directors });
  const tmdb = {
    531: rec(31, [{ id: 2, name: "Wim Wenders" }]),
    532: rec(32, [{ id: 1776, name: "Francis Ford Coppola" }]),
    533: rec(33, [{ id: 2, name: "Wim Wenders" }], "tt0000033"), // a TMDB id naming ANOTHER film: not joined, so it says nothing about who directed film 33
    534: rec(34, [{ id: 99, name: "Somebody Else" }]),
  };
  const peek = (id) => tmdb[id] || null;
  const favs = [
    { name: "Wim Wenders", label: "Wenders", weight: 0.8, stat: { key: "d:2" } },
    { name: "Francis Ford Coppola", label: "Francis Ford Coppola", weight: 0.9, stat: null }, // by name: no stat
    { name: "Sofia Coppola", label: "Sofia Coppola", weight: 0.5, stat: null },
  ];
  const films = DL.lovedFilms({ data: d, favorites: favs, peek });
  const by = new Map(films.map((c) => [c.imdb, c]));
  assert.ok(!by.has(film(31).imdb), "Kings of the Road: only its own director loves it, so it is out");
  assert.deepEqual(by.get(film(32).imdb).lovers.map((l) => l.name), ["Sofia Coppola"], "Rumble Fish stays, by Sofia Coppola only");
  assert.match(DL.lovedLine(by.get(film(32).imdb)), /^Loved by Sofia Coppola · /);
  assert.ok(by.has(film(33).imdb), "a record not joined by IMDb id names nobody as the director");
  assert.ok(by.has(film(34).imdb), "another director's film stays");
  assert.ok(!DL.menu(films, favs, { min: 1 }).some((m) => m.films.some((c) => c.imdb === film(31).imdb)), "not in Wenders' menu either");
  // the vouch reads the same rule (the floor exception follows the catalog)
  const stats = [{ key: "d:2", type: "director", label: "Wim Wenders", n: 6, avg: 4.5, w: 0.8 }, { key: "d:1776", type: "director", label: "Francis Ford Coppola", n: 8, avg: 5, w: 0.9 }, { key: "d:5", type: "director", label: "Sofia Coppola", n: 4, avg: 4.2, w: 0.5 }];
  const v = DL.vouched({ data: d, stats, peek });
  assert.ok(!v.has(film(31).imdb), "Kings of the Road is not vouched by its own director's love");
  assert.match(v.get(film(32).imdb).why, /^Loved by Sofia Coppola · /);
  assert.ok(DL.vouched({ data: d, stats }).has(film(31).imdb), "without the TMDB record nobody is known to have directed it: it stays");
  // directs(): by the stat's TMDB person id, by the name, by an alias; never on an unjoined record
  assert.equal(DL.directs(tmdb[531], favs[0]), true);
  assert.equal(DL.directs(tmdb[532], favs[1]), true);
  assert.equal(DL.directs(tmdb[532], favs[2]), false, "Sofia is not Francis Ford: same surname is not the same person");
  assert.equal(DL.directs(null, favs[0]), false);
  assert.equal(DL.directs(rec(37, [{ id: 2, name: "Wilhelm Ernst Wenders" }]), favs[0]), true, "the stat's TMDB person id, whatever the spelling");
  assert.equal(DL.directs(rec(38, [{ id: 3, name: "Wilhelm Ernst Wenders" }]), favs[0]), false, "another person id and another name: not him");
  assert.equal(DL.directs(rec(35, [{ id: 7, name: "Alejandro González Iñárritu" }]), { name: "Alejandro G. Iñárritu", stat: null }), true, "first and last word");
  assert.equal(DL.directs(rec(36, [{ id: 8, name: "Jean-Luc Godard" }]), { name: "JLG", stat: null }, { JLG: "Jean-Luc Godard" }), true, "alias");
});

test("the real file and the committed TMDB cache: the five films their own director loves are left out for that director only (Kings of the Road, 8½, Rumble Fish, The Virgin Suicides, Secrets & Lies)", () => {
  const data = DL.load(ROOT, DL.DEFAULTS);
  const cache = require("../cache/tmdb.json");
  const peek = (id) => cache.movie[id]?.v || null;
  const favs = data.directors.filter((d) => (d.films || []).length).map((d) => ({ name: d.name, label: d.name, weight: 1, stat: null }));
  const films = new Map(DL.lovedFilms({ data, favorites: favs, peek }).map((c) => [c.imdb, c]));
  const before = new Map(DL.lovedFilms({ data, favorites: favs }).map((c) => [c.imdb, c]));
  const cases = [["tt0073152", "Wim Wenders"], ["tt0056801", "Federico Fellini"], ["tt0086216", "Francis Ford Coppola"], ["tt0159097", "Sofia Coppola"], ["tt0117589", "Mike Leigh"]];
  for (const [tt, self] of cases) {
    assert.ok(before.get(tt)?.lovers.some((l) => l.name === self), `${tt}: ${self} loves it in the file`);
    assert.ok(!(films.get(tt)?.lovers || []).some((l) => l.name === self), `${tt}: ${self}'s love of their own film is left out`);
  }
  assert.ok(films.get("tt0086216").lovers.some((l) => l.name === "Sofia Coppola"), "Rumble Fish stays, by Sofia Coppola");
  // nothing else changes: every other director keeps every film of theirs
  const pairs = (m) => [...m.values()].flatMap((c) => c.lovers.map((l) => `${c.imdb}|${l.name}`)).sort();
  const removed = pairs(before).filter((p) => !pairs(films).includes(p));
  assert.deepEqual(removed, cases.map(([tt, n]) => `${tt}|${n}`).sort());
});

test("the learning replay reads the same rule: the frozen TMDB cache says who directed a film, so a director's own film is not vouched there either", () => {
  const E = require("../lib/learning/evaluate");
  const d = { directors: [{ name: "Wim Wenders", sources: [src("wenders")], films: [film(31, ["wenders"]), film(34, ["wenders"])] }] };
  const snapshot = (tmdb) => ({ bodies: { "inputs.json": { normalized: { history: [] }, sources: { "data/directors-loved.json": d, "config.json": { directorsLoved: { include: ["Wim Wenders"] } }, "cache/friends.json": { following: { users: [] } }, ...(tmdb ? { "cache/tmdb.json": tmdb } : {}) } } } });
  const tmdb = { movie: { 531: { t: 1, v: { id: 531, imdb: film(31).imdb, directors: [{ id: 2, name: "Wim Wenders" }] } }, 534: { t: 1, v: { id: 534, imdb: film(34).imdb, directors: [{ id: 9, name: "Somebody Else" }] } } } };
  assert.deepEqual([...E.lovedFromSnapshot(snapshot(tmdb)).keys()], [film(34).imdb], "Kings of the Road (his own) out, the other film in");
  assert.deepEqual([...E.lovedFromSnapshot(snapshot(null)).keys()].sort(), [film(31).imdb, film(34).imdb].sort(), "no frozen TMDB cache: nobody is known to have directed them");
});

test("the real build hands the TMDB cache to the vouch: none of the five films is vouched by its own director's love (Marco, 11/10/2026)", async () => {
  const R = require("../test-support/integration-reference");
  // the lists switched off (neutralLists: none kept): all five are also in a critics' list, whose vouch would hide the love's
  // PR5 (14/10/2026): config.json carries the Board, whose list rows (criterion, sight-sound, lb250) need the lists this capture switches off: the legacy family is what this test is about
  const now = await R.capture(ROOT, { date: "2026-10-11", capturedAt: "2026-10-11T12:00:00.000Z", neutralLists: [], mapConfig: require("../lib/board-shared").legacyConfig });
  const cases = [["tt0073152", "Wenders"], ["tt0056801", "Fellini"], ["tt0086216", "Francis Ford Coppola"], ["tt0159097", "Sofia Coppola"], ["tt0117589", "Leigh"]];
  const whys = cases.map(([tt]) => now.ratings.get(tt)?.cvWhy || "");
  for (const [i, [tt, self]] of cases.entries()) assert.ok(!whys[i].includes(self), `${tt}: "${whys[i]}" names ${self}, its own director`);
  assert.match(now.ratings.get("tt0086216").cvWhy, /^Loved by Sofia Coppola · /, "Rumble Fish is vouched by Sofia Coppola's love, not Francis Ford Coppola's");
  assert.match(now.ratings.get("tt0073152").cvWhy, /^Loved by Scorsese · /, "Kings of the Road stays vouched by Scorsese");
  assert.equal(now.ratings.get("tt0159097").cv, undefined, "The Virgin Suicides: only Sofia Coppola loves it, so no love vouches for it");
});
