// The catalog expansion of 11/10/2026 (Marco): every list says who made it (critic, director, fan); the unseen films of the lists are
// candidates of the moods and the picker, weighed by how much Marco agrees with each list; a film in a critic or director list needs no
// 3.5 floor and gets the same light push at every position of the Safe bet ↔ Wildcard dial; a fan list grants neither.
const test = require("node:test");
const a = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const LW = require("../lib/list-signal");
const Q = require("../lib/recommendation-quality");
const L = require("../lib/lists");
const S = require("../web/selector");
const { buildRows, W } = require("../lib/rows");

const ROOT = path.resolve(__dirname, "..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const legacyMoods = require("../lib/board-shared").legacyConfig(cfg).moods; // Marco, 14/10/2026 (PR5): the moods of the legacy Board, not the 21 of the v2 family

// two lists, one critic and one fan, each holding one film whose Letterboxd average is 3.2
const films = { "critic-film": { imdbId: "tt101", tmdbId: 101, r: 3.2 }, "fan-film": { imdbId: "tt102", tmdbId: 102, r: 3.2 }, "both": { imdbId: "tt103", tmdbId: 103, r: 3.2 } };
const lists = [
  { id: "c1", name: "A critics' list (x)", trust: "critic", items: [{ slug: "critic-film" }, { slug: "both" }] },
  { id: "d1", name: "A director's list (x)", trust: "director", items: [] },
  { id: "f1", name: "A fan list (x)", trust: "fan", items: [{ slug: "fan-film" }, { slug: "both" }] },
];
const sigOf = (ls = lists) => LW.signals({ lists: ls, films, overall: 3.67 });
const ratingsOf = (ls) => Q.index({ films, users: [] }, { vouched: LW.vouched(sigOf(ls)) });

test("(d) every list in config.json has a trust spelled out; a list without one stops the build", () => {
  a.doesNotThrow(() => LW.validateLists(cfg.lists));
  for (const l of cfg.lists) a.ok(LW.TRUST.includes(l.trust), `${l.id} has trust ${l.trust}`);
  // the classification of the 27 lists that were there before (Marco, 11/10/2026)
  const of = (t) => cfg.lists.filter((l) => l.trust === t).map((l) => l.id);
  for (const id of ["snFyM", "tp03m", "uJUjE", "jzj52", "eEESu", "oA1xE", "hS3rc", "xQY6K", "3JTHC", "g6Xms", "4XUmW", "tIqsq", "1aHbm", "vec98", "TsQtG"]) a.ok(of("critic").includes(id), id);
  a.ok(of("director").includes("xzt0W"));
  for (const id of ["nVqt6", "top500-narrative", "popular-week", "2Qq4Q", "GRJ4", "pDmkw", "1qX2M", "jq61y", "nZrSk", "4XYnu", "f6ZGq"]) a.ok(of("fan").includes(id), id); // f6ZGq: Marco, 11/10/2026, fan + a critics' subset (test/critic-subset.test.js)
  a.equal(cfg.lists.length, 147); // + the Beyond the Sight & Sound Canon A-List (22/10/2026 ~15:05 UTC, test/tspdt-lists.test.js); 146 with the four TSPDT top 250 lists (22/10/2026, test/list-top.test.js); 142 before: + the 46 Criterion Channel lists (Marco, 11/10/2026, seasonal ones included); + 3 for "Visually striking" (GAsK, 2mL0U, 100b4: 14/10/2026, PR5)
  const without = cfg.lists.map((l) => ({ ...l }));
  delete without[3].trust;
  a.throws(() => LW.validateLists(without), /trust must be critic, director, fan/);
  a.throws(() => LW.validateLists([{ id: "x", name: "X", trust: "critics" }]), /trust/);
  a.throws(() => LW.validateLists([{ id: "x", name: "X", trust: "Critic" }]), /trust/);
});

// Marco, 22/10/2026 ~04:05 UTC: the menu entry of a list is its `short`, one line on the phone. Defects guarded: a build that publishes a 40-character entry, one with the author's handle in
// parentheses, one with a path character (the static addon names a file after it), or two lists with the same entry (the second would silently become "… 2").
test("(e) a list's `short`: up to 28 characters, no parenthesis or path character, one list each; a list may have none (then the full name is its entry)", () => {
  const ok = (short) => ({ id: "x", name: "X", trust: "fan", ...(short === undefined ? {} : { short }) });
  a.doesNotThrow(() => LW.validateLists([ok(undefined), ok("a".repeat(LW.SHORT_MAX))].map((l, i) => ({ ...l, id: `x${i}`, name: `X${i}` }))));
  a.equal(LW.SHORT_MAX, 28);
  a.throws(() => LW.validateLists([ok("a".repeat(29))]), /29 characters, the menu line holds 28/);
  a.throws(() => LW.validateLists([ok("Cannes Winners (moviewithus)")]), /parenthesis/);
  for (const bad of ["a/b", "a\\b", "a?b", "a#b", "100%"]) a.throws(() => LW.validateLists([ok(bad)]), /path character/, bad);
  a.throws(() => LW.validateLists([ok("")]), /non-empty string/);
  a.throws(() => LW.validateLists([ok("   ")]), /non-empty string/);
  a.throws(() => LW.validateLists([{ ...ok(7) }]), /non-empty string/);
  a.throws(() => LW.validateLists([{ ...ok("Same"), id: "x1", name: "N1" }, { ...ok("Same"), id: "x2", name: "N2" }]), /used twice/);
});

test("the two corrections are explicit in config.json and replace the film at its own position", () => {
  const bbc = cfg.lists.find((l) => l.id === "29d0g"), wcp = cfg.lists.find((l) => l.id === "fwxFQ");
  a.deepEqual(bbc.corrections.map((c) => [c.from, c.to]), [["the-discreet", "the-discreet-charm-of-the-bourgeoisie"]]);
  a.deepEqual(wcp.corrections.map((c) => [c.from, c.to]), [["pedro-paramo-2024", "pedro-paramo"]]);
  const problems = [];
  const items = [{ slug: "la-strada" }, { slug: "the-discreet" }, { slug: "umberto-d" }];
  const out = L.correct(bbc, items, problems);
  a.deepEqual(out.map((i) => i.slug), ["la-strada", "the-discreet-charm-of-the-bourgeoisie", "umberto-d"]);
  a.equal(items[1].slug, "the-discreet", "the cache's own items are never changed");
  a.deepEqual(problems, []);
  L.correct(bbc, [{ slug: "la-strada" }], problems);
  a.match(problems[0], /no longer applies/);
});

test("a night looks up at most build.listLookups list films never looked up, in the order given; the rest waits", () => {
  const films = { b: { imdbId: "tt2" }, d: { imdbId: "tt4" } };
  const r = L.capLookups(["a", "b", "c", "d", "e", "f"], films, 2);
  a.deepEqual(r.now, ["a", "b", "c", "d"]);
  a.deepEqual([...r.later], ["e", "f"]);
  a.equal(r.unknown, 4);
  a.deepEqual(L.capLookups(["a", "b"], films).now, ["a", "b"]);
  a.equal(cfg.build.listLookups, 4000);
  a.equal(cfg.build.listPool, 8000); // Marco, 11/10/2026: 6,000 → 8,000 (PRODUCT.md)
});

test("a checked copy whose count changes is named in the build's problems", async () => {
  const os = require("node:os"), dir = fs.mkdtempSync(path.join(os.tmpdir(), "lists-checked-")), file = path.join(dir, "lists.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, urls: {}, menus: {}, lists: { x: { url: "https://letterboxd.com/a/list/b/", fetchedAt: "2026-10-11T00:00:00.000Z", items: [["s1", "S1", 2000], ["s2", "S2", 2001], ["s3", "S3", 2002]] } } }));
    const list = (films) => ({ id: "x", name: "X (a)", url: "https://letterboxd.com/a/list/b/", trust: "critic", checked: { on: "2026-10-11", films } });
    const same = await L.refreshLists({ cfg: { lists: [list(3)] }, file, cacheOnly: true });
    a.deepEqual(same.problems, []);
    const changed = await L.refreshLists({ cfg: { lists: [list(4)] }, file, cacheOnly: true });
    a.match(changed.problems.join(), /3 films, but 4 when it was checked against the original on 2026-10-11/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("(a) a film only in a fan list with a 3.2 average never reaches a generated recommendation nor passes the picker", () => {
  const ratings = ratingsOf();
  a.ok(!Q.qualifies(ratings.get("tt102")));
  const plan = { board: [{ id: "tonight", items: [{ id: "tt102", why: [] }, { id: "tt101", why: [] }] }], discover: [{ id: "mood-engine-runtime", options: [{ items: [{ id: "tt102", why: [] }] }] }] };
  Q.applyPlan(plan, ratings);
  a.deepEqual(plan.board[0].items.map((i) => i.id), ["tt101"]);
  a.deepEqual(plan.discover[0].options[0].items, []);
  const data = { today: "2026-10-11", tonight: [], films: [1, 2].map((n) => ({ i: "tt10" + n, t: 100 + n, f: { lift: 1 }, vc: 100, ts: 0, q: 0, r: 90, why: [] })), rewatch: [] };
  Q.applyWeb(data, ratings);
  a.deepEqual(data.films.map((x) => x.i), ["tt101"]);
  // the selector refuses it on its own too (a stale engine.json, a hand-edited one)
  data.films.push({ i: "tt102", t: 102, f: { lift: 1 }, vc: 100, ts: 0, q: 0, r: 90, lb: 3.2, why: [] });
  for (const safe of [0, 0.5, 1]) a.deepEqual(S.rank(data, { mood: "lift", kind: "new", safe, roll: 0 }).map((p) => p.x.i), ["tt101"]);
});

test("(b) a film in a critic or director list with a 3.2 average is recommended and passes the picker; the reason names the list", () => {
  const ratings = ratingsOf();
  a.ok(Q.qualifies(ratings.get("tt101")));
  a.ok(Q.qualifies(ratings.get("tt103")), "in a fan list too: the critic list is enough");
  a.match(Q.reason(ratings.get("tt101")), /in “A critics' list \(x\)”, a critics' list/);
  const director = [{ ...lists[1], items: [{ slug: "fan-film" }] }];
  a.ok(Q.qualifies(ratingsOf(director).get("tt102")));
  a.match(Q.reason(ratingsOf(director).get("tt102")), /a director's list/);
  // only the number 1 counts
  for (const cv of [true, "1", 2, "A list"]) a.ok(!Q.qualifies({ lb: 3.2, cv }));
  const data = { today: "2026-10-11", tonight: [101], films: [{ i: "tt101", t: 101, f: { lift: 1 }, vc: 100, ts: 0, q: 0, r: 90, why: [] }], rewatch: [] };
  Q.applyWeb(data, ratings);
  a.equal(data.films[0].cv, 1);
  a.deepEqual(data.tonight, [101]);
  for (const safe of [0, 0.5, 1]) a.equal(S.rank(data, { mood: "lift", kind: "new", safe, roll: 3 }).length, 1);
  a.equal(S.rank({ ...data, films: [{ ...data.films[0], cv: true }] }, { mood: "lift", kind: "new", safe: 1, roll: 0 }).length, 0);
});

test("(c) the critic/director push and the list agreement are the same at every position of the dial", () => {
  const base = { i: "tt1", t: 1, f: { lift: 1 }, vc: 900, va: 7, ts: 0.4, q: 0.2, r: 90, lb: 3.8, l: "fr", why: [] };
  const score = (x, safe, roll) => S.rank({ today: "2026-10-11", tonight: [], films: [x], rewatch: [] }, { mood: "lift", kind: "new", safe, roll })[0].s;
  const pushes = [];
  for (const safe of [0, 0.25, 0.5, 0.75, 1]) for (const roll of [0, 7]) {
    pushes.push(+(score({ ...base, cv: 1 }, safe, roll) - score(base, safe, roll)).toFixed(12));
    a.equal(+(score({ ...base, lw: 0.5 }, safe, roll) - score(base, safe, roll)).toFixed(12), +(S.LISTS * 0.5).toFixed(12));
  }
  a.ok(S.VOUCH > 0 && S.LISTS > 0 && W.lists > 0 && W.vouch > 0);
  a.deepEqual([...new Set(pushes)], [+S.VOUCH.toFixed(12)]);
  // and in the build's mood rows: the same light constant
  const film = (id) => ({ id, imdb: "tt" + id, title: "F" + id, year: 2000, genres: ["Comedy"], keywords: [], directors: [], cast: [], countries: [], va: 7, vc: 500, overview: "" });
  const mood = { id: "lift", name: "Lift", word: "Lift", genres: { Comedy: 1 }, keywords: {}, minFit: 0 };
  const cands = [1, 2].map((id) => ({ id, film: film(id), tasteZ: 0, qualityZ: 0, recCount: 0, seeds: [], pins: [], contributions: [] }));
  cands[1].cv = 1;
  const { ranked } = buildRows({ pool: cands, rewatch: [], moods: require("../lib/moods").compile([mood]), cfg: { sizes: { discover: 10, row: 10, tonight: 1, because: 1, directors: 1, oldFriends: 1, watchlist: 1 }, build: { directors: 1 } }, model: { stats: new Map() }, recentSeeds: [], today: "2026-10-11" });
  a.equal(ranked.lift[0].film.id, 2);
  a.equal(+(ranked.lift[0].rank - ranked.lift[1].rank).toFixed(12), W.vouch);
});

test("(e) a list's weight is pulled to no difference when Marco rated few of its films", () => {
  const five = (n) => Array.from({ length: n }, (_, i) => ({ pos: i + 1, rating: 5 }));
  const two = LW.agreement(five(2), { overall: 3.67, size: 50 });
  a.equal(two.raw, 5);
  a.ok(Math.abs(two.mean - (2 * 5 + LW.PRIOR * 3.67) / (2 + LW.PRIOR)) < 1e-12);
  a.ok(two.weight < 0.25, `2 films at 5★ weigh ${two.weight}`);
  const forty = LW.agreement(five(40), { overall: 3.67, size: 50 });
  a.ok(forty.weight > 0.9, `40 films at 5★ weigh ${forty.weight}`);
  a.equal(LW.agreement([], { overall: 3.67, size: 50 }).weight, 0);
  a.equal(LW.agreement(five(30).map((r) => ({ ...r, rating: 2 })), { overall: 3.67, size: 50 }).weight, 0, "below his mean: nothing, never a penalty");
  // two lists: 1 − (1 − w1)(1 − w2)
  a.ok(Math.abs(LW.combine([0.5, 0.5]) - 0.75) < 1e-12);
  a.equal(LW.combine([]), 0);
});

test("(f) in a long list the weight falls with the position only when his ratings show it", () => {
  const rated = (f) => Array.from({ length: 100 }, (_, i) => ({ pos: 1 + i * 10, rating: f(1 + i * 10) }));
  const flat = LW.agreement(rated(() => 4.5), { overall: 3.67, size: 1000 });
  a.deepEqual(new Set([1, 260, 520, 990].map(flat.at)).size, 1);
  a.ok(!flat.bands.some((b) => b.fall));
  const falling = LW.agreement(rated((p) => (p <= 500 ? 4.8 : 3.6)), { overall: 3.67, size: 1000 });
  a.ok(falling.at(900) < falling.at(10), `${falling.at(900)} < ${falling.at(10)}`);
  a.equal(falling.at(10), falling.weight, "the head keeps the list's weight: it never rises above it");
  // the same fall in a list of 500 or fewer is not measured by position
  const short = LW.agreement(Array.from({ length: 50 }, (_, i) => ({ pos: i + 1, rating: i < 25 ? 4.8 : 3.6 })), { overall: 3.67, size: 500 });
  a.equal(short.bands, null);
  a.equal(short.at(500), short.at(1));
  // a band with no rated film keeps the band before it
  const gap = LW.agreement(rated((p) => (p <= 500 ? 4.8 : 3.6)).filter((r) => r.pos < 751), { overall: 3.67, size: 1000 });
  a.equal(gap.at(900), gap.at(700));
});

test("the exception's own floor (Marco, 11/10/2026): a vouched film with a Letterboxd 2.4 is refused, 2.5 and 2.6 pass, one with no average passes; Board/Discover, the picker and the Worker agree", () => {
  a.equal(Q.VOUCHED_MIN_STARS, 2.5);
  a.equal(S.VOUCHED_MIN, Q.VOUCHED_MIN_STARS, "web/selector.js and lib/recommendation-quality.js hold the same number");
  const cases = [[{ lb: 2.4, cv: 1 }, false], [{ lb: 2.5, cv: 1 }, true], [{ lb: 2.6, cv: 1 }, true], [{ lb: null, cv: 1 }, true], [{ lb: 2.4, fr: 3.5, cv: 1 }, true], [{ lb: 2.6 }, false], [{ lb: 3.4, cv: 1 }, true], [{ lb: 3.4 }, false], [{ lb: 2.6, cv: true }, false]];
  for (const [e, want] of cases) a.equal(Q.qualifies(e), want, JSON.stringify(e));
  // "only through the exception" (the build's log): vouched and qualifying, with neither the average nor a configured friend at 3.5
  for (const [e, want] of [[{ lb: 3.0, cv: 1 }, true], [{ lb: null, cv: 1 }, true], [{ lb: 3.0, fr: 3.6, cv: 1 }, false], [{ lb: 3.6, cv: 1 }, false], [{ lb: 2.4, cv: 1 }, false], [{ lb: 3.0 }, false]]) a.equal(Q.onlyByException(e), want, `only by the exception: ${JSON.stringify(e)}`);
  // the browser picker, from the same fields of the web data
  const DATA = { today: "2026-10-11", tonight: [], rewatch: [], films: cases.map(([e], i) => ({ t: i + 1, i: `tt${i + 1}`, r: 100, f: { wander: 1 }, ts: 0, q: 0, vc: 5000, ...e })) };
  const shown = new Set(S.rank(DATA, { mood: "wander", time: null, kind: "new", safe: 0.5, roll: 0 }).map((r) => r.x.t));
  a.deepEqual(cases.map(([, want], i) => shown.has(i + 1)), cases.map(([, want]) => want));
  // the plan (Board/Discover) through Q.index, a critics' list film at 2.4 and one at 2.6
  const fl = { low: { imdbId: "tt201", r: 2.4 }, mid: { imdbId: "tt202", r: 2.6 } };
  const ls = [{ id: "c1", name: "A critics' list (x)", trust: "critic", items: [{ slug: "low" }, { slug: "mid" }] }];
  const ratings = Q.index({ films: fl, users: [] }, { vouched: LW.vouched(LW.signals({ lists: ls, films: fl, overall: 3.67 })) });
  const plan = { board: [{ id: "wander", items: [{ id: "tt201", why: [] }, { id: "tt202", why: [] }] }], discover: [] };
  Q.applyPlan(plan, ratings);
  a.deepEqual(plan.board[0].items.map((x) => x.id), ["tt202"]);
});

test("the learning layer's Board recommendations are every Board row but the four direct ones (watchlist, the two friends rows, Old friends): directors-loved and slow included (review S4-7)", () => {
  const P = require("../lib/plan"), D = require("../lib/learning/diversity");
  const direct = new Set(["watchlist", "friends-love", "friends-week", "oldfriends"]);
  const rows = [...P.BOARD_BEFORE_MOODS, ...legacyMoods.map((m) => m.id), ...P.BOARD_AFTER_MOODS].filter((id) => !direct.has(id));
  a.deepEqual([...D.BOARD_RECOMMENDATIONS].sort(), rows.sort());
});

test("Fear on Film (MUBI) is a fan list (Marco, 11/10/2026): its films need the 3.5 floor", () => {
  a.equal(cfg.lists.find((l) => l.url === "https://letterboxd.com/mubi/list/fear-on-film/").trust, "fan");
});

test("signals: a film in several lists combines their weights; vouched only through critic or director lists", () => {
  const ratingOf = (r) => ({ 101: 5, 102: 2 })[r.tmdbId] ?? null;
  const sig = LW.signals({ lists, films, ratingOf, overall: 3.67 });
  a.equal(sig.byTt.get("tt101").cv, 1);
  a.equal(sig.byTt.get("tt102").cv, undefined);
  a.equal(sig.byTt.get("tt103").cvList, "A critics' list (x)");
  const c1 = sig.lists.find((l) => l.id === "c1"), f1 = sig.lists.find((l) => l.id === "f1");
  a.ok(c1.weight > 0 && f1.weight === 0);
  a.ok(Math.abs(sig.byTt.get("tt103").lw - LW.combine([c1.weight, f1.weight])) < 1e-12);
  a.deepEqual([...LW.vouched(sig).keys()].sort(), ["tt101", "tt103"]);
});

test("a list film joins TMDB by IMDb id: histoires-du-cinema names TMDB 206647, which is Spectre, so /find decides (review S4-4)", async () => {
  // the real records of 11/10/2026: Letterboxd's page of Godard's series names TMDB 206647 (a TV id); TMDB's movie 206647 is Spectre
  const lb = { "histoires-du-cinema": { imdbId: "tt6677224", tmdbId: 206647, title: "Histoire(s) du cinéma", year: 1988, r: 4.16 }, "critic-film": films["critic-film"], "ghost": { imdbId: "tt999", tmdbId: 999, r: 3 } };
  const movies = { 206647: { id: 206647, imdb: "tt2379713", title: "Spectre" }, 101: { id: 101, imdb: "tt101", title: "Critic film" }, 999: { id: 999, imdb: "tt5", title: "Another" } };
  const finds = { tt6677224: 1206647 };
  const ls = [{ id: "c1", name: "A critics' list (x)", trust: "critic", items: [{ slug: "histoires-du-cinema" }, { slug: "critic-film" }, { slug: "ghost" }] }];
  const sig = LW.signals({ lists: ls, films: lb, overall: 3.67 });
  a.deepEqual(sig.byTt.get("tt6677224").tmdbClaims, [206647]);
  a.equal(sig.byTt.get("tt6677224").tmdb, undefined, "a claim is not a TMDB id before the join");
  a.equal(sig.byTmdb, undefined, "no index by the claimed TMDB id");
  const asked = [];
  const n = await LW.joinTmdb(sig, { movie: async (id) => movies[id] || null, fromImdb: async (tt) => { asked.push(tt); return finds[tt] || null; } });
  a.equal(sig.byTt.get("tt6677224").tmdb, 1206647, "Spectre's id is refused; /find answers for the IMDb id");
  a.equal(sig.byTt.get("tt101").tmdb, 101, "a claim whose record agrees is kept, with no /find");
  a.equal(sig.byTt.get("tt999").tmdb, undefined, "no agreeing record and nothing from /find: out");
  a.deepEqual(asked.sort(), ["tt6677224", "tt999"]);
  a.deepEqual(n, { confirmed: 1, viaFind: 1, refused: 2, missing: 1, refusedFound: 1 }, "both refused went to /find: histoires found, ghost left out");
  // seen films are not joined at all
  const sig2 = LW.signals({ lists: ls, films: lb, overall: 3.67 });
  await LW.joinTmdb(sig2, { movie: async (id) => movies[id] || null, fromImdb: async () => null, skip: (tt) => tt === "tt101" });
  a.equal(sig2.byTt.get("tt101").tmdb, undefined);
});

test("the real build: every generated recommendation passes the rule, and the ones below 3.5 are vouched (a critic or director list, or a favourite director's love)", async () => {
  const R = require("../test-support/integration-reference");
  const now = await R.capture(ROOT, { date: "2026-10-11", capturedAt: "2026-10-11T12:00:00.000Z" });
  const trust = new Map(cfg.lists.map((l) => [l.name, l.trust]));
  const editorial = new Set(["mood-engine-lists", "mood-engine-lists-unseen", "mood-engine-friends"]);
  const generated = [...now.plan.board.filter((r) => r.id !== "oldfriends").flatMap((r) => r.items), ...now.plan.discover.filter((c) => !editorial.has(c.id)).flatMap((c) => c.options.flatMap((o) => o.items))];
  const lovedFile = require("../test-support/loved-favourites").lovedByFavourites(now.log, ROOT); // a FAVOURITE's love, not any film of the file (review S4-6)
  let byException = 0, byLove = 0;
  for (const it of generated) {
    const e = now.ratings.get(it.id);
    a.ok(Q.qualifies(e), `${it.title} (${it.id})`);
    if (!(Q.valid(e.lb) && e.lb >= 3.5) && !(Q.valid(e.fr) && e.fr >= 3.5)) {
      byException++;
      a.equal(e.cv, 1);
      // Marco, 11/10/2026: ONE exception, two halves: a critic/director list, or a film of data/directors-loved.json a favourite loves
      if (e.cvWhy && !/^Loved by /.test(e.cvWhy)) a.ok(trust.get(e.cvList) === "fan" && /^Cannes · /.test(e.cvWhy), `${it.title}: ${e.cvList} / ${e.cvWhy}`); // a critics' subset of a fan list (test/critic-subset.test.js)
      else if (e.cvWhy) { byLove++; a.ok(e.cvTrust === "director" && lovedFile.has(it.id) && /^Loved by /.test(e.cvWhy), `${it.title}: ${e.cvWhy}`); }
      else a.ok(["critic", "director"].includes(trust.get(e.cvList)), `${it.title}: ${e.cvList}`);
    }
  }
  a.ok(byException > 0 && byLove > 0 && byLove < byException, `the exception is in use (${byException}, ${byLove} by a director's love)`);
  for (const x of now.webData.films) a.ok(Q.qualifies(x) || x.cv === 1);
  a.ok(now.webData.films.some((x) => x.cv === 1 && !(x.lb >= 3.5) && !(x.fr >= 3.5)));
  // the list films are candidates, with their weight and their vouch attached (the build log counts both)
  const m = now.log.match(/From the lists: (\d+) films with a TMDB id .* → (\d+) kept .* candidates in a list: (\d+), vouched \(a critic or director list, or a favourite director's love\): (\d+), of them only by a director's love (\d+)/);
  a.ok(m, "the log line of the list candidates");
  const [, withTmdb, kept, inList, vouchedN, lovedOnly] = m.map(Number);
  a.ok(withTmdb > 1000 && kept > 1000 && inList > kept && vouchedN > 500 && lovedOnly > 0 && lovedOnly < vouchedN, m[0]);
  a.ok(now.webData.films.filter((x) => x.lw > 0 && x.lw <= 1).length > 100, "the picker gets the agreement weight");
  // the build says how many films are there ONLY through the exception, surface by surface (acceptance of Fatia A, review S4-7)
  const ex = now.log.match(/Only through the floor exception \(vouched, Letterboxd ≥ 2\.5 or no average, no 3\.5\): Board (\d+) of (\d+) · Discover (\d+) of (\d+) · picker (\d+) of (\d+) distinct films/);
  a.ok(ex, "the log line of the exception");
  const only = (ids) => { const u = new Set(ids); return [[...u].filter((tt) => Q.onlyByException(now.ratings.get(tt))).length, u.size]; };
  a.deepEqual(ex.slice(1).map(Number), [
    ...only(now.plan.board.flatMap((r) => r.items.map((i) => i.id))),
    ...only(now.plan.discover.filter((c) => !editorial.has(c.id)).flatMap((c) => c.options.flatMap((o) => o.items.map((i) => i.id)))),
    ...only(now.webData.films.map((x) => x.i)),
  ]);
  a.ok(Number(ex[1]) > 0 && Number(ex[5]) > 0, ex[0]);
  // the TMDB id a Letterboxd page names is refused when its record is another film (review S4-4): counted, and no such film carries a list's weight
  // the counts add up (review S4-I: "0 by TMDB's /find (48 of them because…)" said 48 of 0)
  const j = now.log.match(/List films joined to TMDB by IMDb id: (\d+) by the TMDB id Letterboxd names, (\d+) by TMDB's \/find, (\d+) left out \(no TMDB movie for the IMDb id\) · (\d+) named a TMDB id that is another film, so \/find was asked: (\d+) found, (\d+) among the left out/);
  a.ok(j, "the log line of the TMDB join");
  const [, , viaFind, missing, refused, refusedFound, refusedLeft] = j.map(Number);
  a.ok(refused > 0, j[0]);
  a.equal(refusedFound + refusedLeft, refused, j[0]);
  a.ok(refusedFound <= viaFind && refusedLeft <= missing, j[0]);
  const fc = JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "friends.json"), "utf8")), lc = JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "lists.json"), "utf8"));
  // the members of EVERY list of config.json: the Letterboxd copies from cache/lists.json and the static lists from their files (review S4-E:
  // without the static ones, a static-only film with a weight would read as a weight outside the lists)
  const SL = require("../lib/static-lists");
  const staticMembers = cfg.lists.filter(SL.isStatic).flatMap((l) => SL.itemsOf(SL.load(ROOT, l)).filter((it) => !it.tv).map((it) => it.imdb));
  a.ok(staticMembers.length > 90, `${staticMembers.length} films of the static lists`);
  const members = new Set([...cfg.lists.filter((l) => !SL.isStatic(l)).flatMap((l) => ((lc.lists[l.id] || {}).items || []).map(([slug]) => fc.films[slug]?.imdbId).filter(Boolean)), ...staticMembers]);
  const weighed = now.webData.films.filter((x) => x.lw > 0);
  a.deepEqual(weighed.filter((x) => !members.has(x.i)).map((x) => `${x.n} ${x.i}`), [], "a list's weight only on films of the lists, by IMDb id");
  a.ok(now.webData.films.length > 577, `${now.webData.films.length} films in the picker`);
});

test("the listPool cut takes only the films the rule lets through: a fan-list film at 3.2 is out, a critic-list film at 2.6 is in, one with no record yet follows 'no average' (Marco, 11/10/2026)", () => {
  const ent = { fan32: { lb: 3.2, fr: null, cv: null }, critic26: { lb: 2.6, fr: null, cv: 1 }, critic24: { lb: 2.4, fr: null, cv: 1 }, fan40: { lb: 4, fr: null, cv: null }, friend: { lb: 3, fr: 4, cv: null }, pendingCritic: { lb: null, fr: null, cv: 1 }, pendingFan: { lb: null, fr: null, cv: null } };
  const films = Object.keys(ent).map((k, i) => ({ id: i + 1, k }));
  const run = (cap) => LW.cutList(films, { entryOf: (f) => ent[f.k], qualifies: Q.qualifies, prelim: (f) => (f.k === "fan32" ? 99 : 1), cap });
  const all = run(100);
  a.deepEqual(all.kept.map((f) => f.k).sort(), ["critic26", "fan40", "friend", "pendingCritic"], "fan 3.2 out even with the best prelim; critic 2.6 in; critic 2.4 out");
  a.equal(all.refused, 3); a.equal(all.eligible, 4);
  a.deepEqual(run(2).kept.length, 2, "the cap still applies to the eligible ones");
  a.equal(run(0).kept.length, 0);
});

test("the real build's listPool cut: the films the rule refuses never take a slot, whatever the cap (Marco, 11/10/2026; review S4-5)", async () => {
  const R = require("../test-support/integration-reference");
  const line = (log) => { const m = log.match(/→ (\d+) released and unseen → (\d+) refused by the recommendation rule left out → (\d+) eligible → (\d+) kept \(cfg\.build\.listPool (\d+); the cut left out (\d+) eligible\)/); a.ok(m, "the log line of the cut"); return m.slice(1).map(Number); };
  const small = await R.capture(ROOT, { date: "2026-10-11", capturedAt: "2026-10-11T12:00:00.000Z", mapConfig: (c) => { c.build.listPool = 1000; return c; } });
  const [ok, refused, eligible, kept, pool, left] = line(small.log);
  a.equal(pool, 1000); a.equal(kept, 1000);
  a.equal(ok, refused + eligible, "every released film is refused or eligible");
  a.equal(left, eligible - kept);
  a.ok(left > 0 && refused > 0, small.log.match(/From the lists:.*/)[0].slice(0, 400));
  // with every slot open (8000 > the list films of the committed caches) nothing eligible is cut, and the refused ones are still out
  const all = await R.capture(ROOT, { date: "2026-10-11", capturedAt: "2026-10-11T12:00:00.000Z" });
  const [ok2, refused2, eligible2, kept2, , left2] = line(all.log);
  a.equal(left2, 0); a.equal(kept2, eligible2); a.ok(refused2 > 0);
  a.equal(ok2, refused2 + eligible2);
});

test("the real build stops on a list without a trust", async () => {
  const R = require("../test-support/integration-reference");
  await a.rejects(R.capture(ROOT, { date: "2026-10-11", capturedAt: "2026-10-11T12:00:00.000Z", mapConfig: (c) => { delete c.lists[5].trust; return c; } }), (e) => /trust must be critic, director, fan/.test(String(e && e.message || e)));
});

test("an agreement weight that rounds to 0 is not published: lw 0.004 leaves the film without lw and the publication passes (review S3-A)", async () => {
  // the rounding comes first: (0, 0.005) → nothing; 0.005 and up → two decimals; never above 1
  for (const [lw, want] of [[0.004, undefined], [0.0049, undefined], [0, undefined], [-0.2, undefined], [NaN, undefined], [undefined, undefined], [0.005, 0.01], [0.006, 0.01], [0.123, 0.12], [1, 1], [1.2, 1]]) a.equal(LW.publicWeight(lw), want, String(lw));
  const P = require("../lib/learning/public");
  a.throws(() => P.projection({ films: [{ t: 1, i: "tt1", lw: 0 }] }), /Invalid lw/, "a published 0 still stops the build");
  // the real build with every list film's weight at 0.004 (what a list whose agreement lands at +0.004 star gives)
  const R = require("../test-support/integration-reference");
  let set = 0;
  const now = await R.capture(ROOT, { date: "2026-10-11", capturedAt: "2026-10-11T12:00:00.000Z", mapSignals: (sig) => { for (const s of sig.byTt.values()) { s.lw = 0.004; set++; } return sig; } });
  a.ok(set > 1000, `${set} list films given lw 0.004`);
  const inLists = now.webData.films.filter((x) => now.ratings.get(x.i)?.cv === 1);
  a.ok(inLists.length > 100, `${inLists.length} published films of the lists`);
  a.deepEqual(now.webData.films.filter((x) => x.lw !== undefined).map((x) => `${x.n} lw ${x.lw}`), [], "no film carries a weight that rounds to 0");
  a.doesNotThrow(() => P.validatePublication(now.plan, now.webData), "the publication passes");
});

test("Marco's rating of a list film is matched by IMDb id on both sides: paranoia-agent (TMDB TV id 9343) does not inherit Fitzcarraldo's 4.5 (review S4-C)", async () => {
  // his history: Fitzcarraldo matched to TMDB movie 9343 (tt0083946); Three Colours: White never matched by TMDB, his own Letterboxd page is tt0111507
  const all = [
    { title: "Fitzcarraldo", year: 1982, rating: 4.5, tmdbId: 9343, film: { id: 9343, imdb: "tt0083946" } },
    { title: "Three Colours: White", year: 1994, rating: 4, tmdbId: null, film: null },
    { title: "Twin", year: 2001, rating: 3, tmdbId: null, film: null },
    { title: "Bare", year: 1990, rating: 5, tmdbId: null, film: null },
  ];
  const films = { "three-colours-white": { title: "Three Colours: White", year: 1994, imdbId: "tt0111507" }, "twin-a": { title: "Twin", year: 2001, imdbId: "tt71" }, "twin-b": { title: "Twin", year: 2001, imdbId: "tt72" } };
  const of = LW.ratingByImdb(all, { films, me: new Set(["three-colours-white", "twin-a", "twin-b"]) });
  a.equal(of({ imdbId: "tt0433722", tmdbId: 9343, title: "Paranoia Agent", year: 2004 }), null, "the same TMDB number names another film");
  a.equal(of({ imdbId: "tt0083946", tmdbId: 9343 }), 4.5);
  a.equal(of({ imdbId: "tt0111507", tmdbId: 109, title: "Three Colours: White", year: 1994 }), 4, "an unmatched film rates through his own Letterboxd page's IMDb id");
  a.equal(of({ imdbId: "tt71", title: "Twin", year: 2001 }), null, "two of his pages answer the title and year: nothing");
  a.equal(of({ imdbId: "tt90", title: "Bare", year: 1990 }), null, "a bare title and year is no identity");
  a.equal(LW.ratingByImdb(all)({ imdbId: "tt0111507", title: "Three Colours: White", year: 1994 }), null, "no Letterboxd pages of his: nothing");
  // the real build hands signals() exactly this rule (committed caches: Marco rated Fitzcarraldo and Three Colours: White)
  const R = require("../test-support/integration-reference");
  let ratingOf = null;
  await R.capture(ROOT, { date: "2026-10-11", capturedAt: "2026-10-11T12:00:00.000Z", mapSignals: (sig, o) => { ratingOf = o.ratingOf; return sig; } });
  const fc = JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "friends.json"), "utf8"));
  a.equal(fc.films["paranoia-agent"].tmdbId, 9343, "the committed record still names the TV id");
  a.equal(ratingOf(fc.films["paranoia-agent"]), null, "paranoia-agent rates nothing");
  a.equal(ratingOf(fc.films["three-colours-white"]), 4.5);
  a.equal(ratingOf({ ...fc.films["paranoia-agent"], imdbId: "tt0083946" }), 4.5, "Fitzcarraldo's own IMDb id does");
});

test("the director half of the exception keeps the 2.5 floor: a film a favourite director loves with a Letterboxd 2.4 does not pass Q.index, 2.6 does, none passes (review S4-F)", () => {
  const films = { low: { imdbId: "tt301", r: 2.4 }, mid: { imdbId: "tt302", r: 2.6 }, edge: { imdbId: "tt303", r: 2.5 } };
  const love = { list: "Loved by your directors", trust: "director", why: "Loved by Wenders · Criterion Closet" };
  const loved = new Map([["tt301", love], ["tt302", love], ["tt303", love], ["tt304", love]]); // tt304: not on Letterboxd, no average
  const ratings = Q.index({ films, users: [] }, { loved });
  a.equal(ratings.get("tt301").cv, 1, "loved: vouched");
  a.equal(Q.qualifies(ratings.get("tt301")), false, "2.4: under the exception's own floor");
  a.equal(Q.qualifies(ratings.get("tt302")), true, "2.6");
  a.equal(Q.qualifies(ratings.get("tt303")), true, "2.5: the floor itself");
  a.equal(Q.qualifies(ratings.get("tt304")), true, "no average: passes with the vouch");
  a.equal(Q.reason(ratings.get("tt302")), love.why);
  a.equal(Q.qualifies(Q.index({ films, users: [] }).get("tt302")), false, "the same 2.6 without the love: refused");
});

test("the comments that state the recommendation rule say the current one: fan 3.5, a vouch 2.5, no average passes with a vouch, a configured friend (review S4-D)", () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
  const between = (text, from, to) => { const i = text.indexOf(from); a.ok(i >= 0, from); const j = text.indexOf(to, i + from.length); return text.slice(i, j < 0 ? undefined : j); };
  const sites = [
    ["worker/src/catalogs.js", between(read("worker/src/catalogs.js"), "// The recommendation rule", "// Filtering keeps")],
    ["worker/src/catalogs.js director-picks", between(read("worker/src/catalogs.js"), "//   director-picks", "//   explore")],
    ["worker/src/film.js", between(read("worker/src/film.js"), "The build's verdict on the recommendation rule", "get eligible()")],
    ["lib/index-export.js", between(read("lib/index-export.js"), " * quality    ", " * permits")],
  ];
  for (const [at, text] of sites) {
    a.match(text, /2\.5/, `${at}: the vouched floor`);
    a.doesNotMatch(text, /skips the 3\.5 floor/, `${at}: the exception no longer skips every floor`);
    if (at !== "worker/src/catalogs.js director-picks") { a.match(text, /3\.5/, `${at}: the general floor`); a.match(text, /configured friend/, `${at}: the friend`); }
  }
  for (const [at, text] of [sites[0], sites[1], sites[3]]) a.match(text, /no (Letterboxd )?average|NO average/, `${at}: a vouched film with no average`);
});

test("the nine older copies that follow a critic carry the count checked against the original on 11/10/2026, and the committed cache still has it (review S4-G)", async () => {
  // conferência das cópias antigas, 11/10/2026: Boscov 40, IndieWire 80s 100, 90s 100, 2000s 102, 2010s 100, French 35, animated 30, sci-fi 65, docs 25
  const want = { eEESu: 40, oA1xE: 100, hS3rc: 100, xQY6K: 102, "3JTHC": 100, g6Xms: 35, "4XUmW": 30, tIqsq: 65, "1aHbm": 25 };
  for (const [id, n] of Object.entries(want)) {
    const l = cfg.lists.find((x) => x.id === id);
    a.equal(l.trust, "critic", id);
    a.deepEqual(l.checked, { on: "2026-10-11", films: n }, id);
  }
  const r = await L.refreshLists({ cfg: { lists: cfg.lists.filter((l) => want[l.id]) }, file: path.join(ROOT, "cache", "lists.json"), cacheOnly: true });
  a.deepEqual(r.problems, [], "the committed copies have the checked counts");
  a.deepEqual(Object.fromEntries(r.lists.map((l) => [l.id, l.items.length])), want);
});
