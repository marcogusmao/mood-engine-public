// node --test
// The ninth mood, "Slow and still" (Marco, 11/10/2026): slow cinema, which used to fall into "Somewhere else" for want of a shelf of its own.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { compile, fit } = require("../lib/moods");
const { buildPlan } = require("../lib/plan");
const LF = require("../lib/learning/feedback");
const { legacyConfig } = require("../lib/board-shared");
const cfg = legacyConfig(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"))); // Marco, 14/10/2026 (PR5): the nine moods of board.legacyMoods; the 21 others of config.json exist in the v2 family alone
const moods = compile(cfg.moods);
const slow = moods.find((m) => m.id === "slow");
const cache = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cache", "tmdb.json"), "utf8")).movie;
const inCache = (imdb) => Object.values(cache).map((x) => x.v).find((f) => f && f.imdb === imdb);

test("config.json declares nine moods and the ninth, slow, sits next to wander with a word, a blurb and pins", () => {
  assert.deepEqual(cfg.moods.map((m) => m.id), ["lift", "escape", "reinvent", "letin", "night", "wicked", "wander", "slow", "music"]);
  assert.ok(slow && slow.name && slow.word === "Slow" && slow.blurb && slow.pins.length >= 1 && slow.pins.length <= 5);
  assert.ok(Object.keys(slow.directors).length >= 10, "slow cinema is named by its authors");
  for (const pin of slow.pins) assert.ok(inCache(pin), `pin ${pin} is a film in the TMDB cache`);
});

test("the plan puts slow on the Board between the other moods and in the Discover mood menu", () => {
  const rows = Object.fromEntries(moods.map((m) => [m.id, []]));
  const plan = buildPlan({ moods, rows: { ...rows, tonight: [], because: [], directors: [], watchlist: [], oldfriends: [] }, extra: { fromlists: [], short: [], newforyou: [], "friends-week": [] }, sizes: { row: 30, friends: 30 } });
  const ids = plan.board.map((r) => r.id);
  assert.ok(ids.includes("slow"));
  assert.equal(ids.indexOf("slow"), ids.indexOf("wander") + 1);
  assert.equal(plan.board.find((r) => r.id === "slow").name, "🕯️ Slow and still");
  assert.ok(plan.discover.find((c) => c.id === "mood-engine").options.some((o) => o.label === "Slow"));
});

test("a mood feedback event for slow is valid (the learning layer knows nine moods)", () => {
  assert.ok(LF.MOODS.includes("slow"));
  assert.equal(LF.MOODS.length, 9);
});

test("anchors from the cache: Tsai, Apichatpong and Hamaguchi (no named author, found by the 'slow cinema' keyword) clear the limiter; an action blockbuster and a franchise adventure do not", () => {
  const anchors = ["tt0377556", "tt1588895"].map(inCache);
  const hamaguchi = Object.values(cache).map((x) => x.v).find((f) => f && f.title === "Drive My Car" && f.year === 2021);
  assert.ok(hamaguchi && hamaguchi.keywords.includes("slow cinema"));
  for (const f of [...anchors, hamaguchi]) {
    assert.ok(f, "anchor present in cache");
    const r = fit(f, slow);
    assert.ok(r.ok && r.fit >= slow.minFit, `${f.title} fits slow (${r.fit})`);
  }
  for (const imdb of ["tt0468569", "tt0133093", "tt0120737"]) {
    const f = inCache(imdb);
    assert.ok(f, "blockbuster present in cache");
    assert.equal(fit(f, slow).ok, false, `${f.title} does not fit slow`);
  }
});

test("director weight: the strongest named director counts once (an omnibus is not twelve times as slow) and satisfies needHit by itself", () => {
  const base = { genres: ["Drama"], keywords: [], lang: "en", countries: ["US"], runtime: 100 };
  const one = fit({ ...base, directors: [{ id: 71174, name: "Tsai Ming-liang" }] }, slow);
  const many = fit({ ...base, directors: [71174, 69759, 85637, 130030].map((id) => ({ id, name: "x" + id })) }, slow);
  assert.equal(one.fit, many.fit);
  assert.ok(one.ok && one.hits[0] === "Tsai Ming-liang", "the author is the shown reason, and needHit does not punish a film with no keyword at all");
  const nobody = fit({ ...base, directors: [{ id: 1, name: "Nobody" }] }, slow);
  assert.equal(nobody.ok, false, "an English drama by an unnamed director with no slow signal is not slow");
});

test("no keyword and no author, only a foreign drama: not enough (that is Somewhere else, not Slow)", () => {
  const f = { genres: ["Drama"], keywords: ["village"], lang: "fr", countries: ["FR"], runtime: 100, directors: [{ id: 2, name: "Z" }] };
  assert.equal(fit(f, slow).ok, false);
  assert.equal(fit(f, moods.find((m) => m.id === "wander")).ok, true);
});

// Review S3-3 (11/10/2026): the slow-cinema canons are the mood's signal, and a generic word alone no longer makes a foreign drama slow.
const canons = cfg.lists.filter((l) => l.moods && l.moods.slow);
const withLists = compile(cfg.moods, cfg.lists).find((m) => m.id === "slow");

test("the two approved slow-cinema canons (fr_qr, lightwisdom) declare moods.slow in config.json, and only they do", () => {
  assert.deepEqual(canons.map((l) => l.id).sort(), ["5R3nu", "8UNg"]);
  assert.ok(canons.every((l) => /fr_qr|lightwisdom/.test(l.url) && l.moods.slow > 0));
  assert.deepEqual(require("../lib/moods").validateListMoods(cfg.lists, cfg.moods), []);
});

test("a list's mood weight is checked: an unknown mood or a weight outside (0, 5] is a problem", () => {
  const { validateListMoods } = require("../lib/moods");
  assert.equal(validateListMoods([{ id: "x", moods: { slowest: 1 } }], cfg.moods).length, 1);
  assert.equal(validateListMoods([{ id: "x", moods: { slow: 0 } }], cfg.moods).length, 1);
  assert.equal(validateListMoods([{ id: "x", moods: { slow: "2" } }], cfg.moods).length, 1);
  assert.equal(validateListMoods([{ id: "x", moods: ["slow"] }], cfg.moods).length, 1);
  assert.equal(validateListMoods([{ id: "x" }, { id: "y", moods: { slow: 2 } }], cfg.moods).length, 0);
});

test("a film in a slow-cinema canon fits slow with no keyword and no named author: the list is the hit (needHit) and the weight", () => {
  const f = { genres: ["Drama"], keywords: [], lang: "it", countries: ["IT"], runtime: 88, directors: [{ id: 3, name: "Michelangelo Frammartino" }] };
  assert.equal(fit(f, withLists).ok, false, "outside the lists: no evidence");
  const inside = fit(f, withLists, { lists: ["5R3nu"] });
  assert.ok(inside.ok, `in A Canon of Slow Cinema: ${inside.fit}`);
  assert.equal(inside.hits[0], "A Canon of Slow Cinema");
  // an English canon drama too (Drama 0.5 + the list) — and the strongest list counts once, not both
  const en = { ...f, lang: "en", countries: ["US"] };
  const one = fit(en, withLists, { lists: ["8UNg"] }), both = fit(en, withLists, { lists: ["8UNg", "5R3nu"] });
  assert.ok(one.ok, `English canon drama: ${one.fit}`);
  assert.equal(one.fit, both.fit);
  // a list that names no mood adds nothing, and the lists only count for the mood they name
  assert.equal(fit(f, withLists, { lists: ["some-other-list"] }).ok, false);
  const wander = compile(cfg.moods, cfg.lists).find((m) => m.id === "wander");
  assert.equal(fit(f, wander, { lists: ["5R3nu"] }).fit, fit(f, wander).fit);
});

test("Ikiru (the real TMDB record) is no longer slow: Drama + 'loneliness' + non-English is not slow cinema; a strong keyword still is", () => {
  const ikiru = inCache("tt0044741");
  assert.ok(ikiru && ikiru.keywords.includes("loneliness"));
  assert.equal(fit(ikiru, withLists).ok, false, `Ikiru: ${fit(ikiru, withLists).fit}`);
  const generic = { genres: ["Drama"], keywords: ["loneliness"], lang: "ja", countries: ["JP"], runtime: 100, directors: [{ id: 4, name: "Y" }] };
  assert.equal(fit(generic, withLists).ok, false);
  assert.equal(fit({ ...generic, keywords: ["meditative"] }, withLists).ok, true, "a keyword of weight ≥ hitMin is evidence");
});

test("the real build: a generic word alone makes no film slow, Ikiru included; a film with no shown reason needs two of the mood's words", async () => {
  const R = require("../test-support/integration-reference");
  const now = await R.capture(path.join(__dirname, ".."), { date: "2026-10-11", capturedAt: "2026-10-11T12:00:00.000Z" });
  const slowFilms = now.webData.films.filter((x) => x.f.slow !== undefined && !(x.pins || []).includes("slow"));
  assert.ok(slowFilms.length > 30, `${slowFilms.length} slow films in the picker`);
  const strong = new Set(Object.entries(withLists.keywords).filter(([, w]) => w >= withLists.hitMin).map(([t]) => t));
  const lists = new Set(canons.map((l) => l.name.replace(/ \([^)]*\)$/, "")));
  let unnamed = 0;
  for (const x of slowFilms) {
    const hits = x.h.slow || [];
    // a shown reason is a strong keyword, a canon, or an author's name (names are not lower-case keyword terms) …
    if (hits.length) { assert.ok(hits.every((h) => strong.has(h) || lists.has(h) || !/^[a-z -]+$/.test(h)), `${x.n}: ${hits.join(", ")}`); continue; }
    // … and a film with none needs at least two of the mood's words: one generic word (Ikiru's "loneliness") is not slow cinema
    unnamed++;
    const rec = inCache(x.i);
    const words = withLists._terms.filter((t) => t.w > 0 && rec.keywords.some((k) => t.re.test(k)));
    assert.ok(words.length >= 2, `${x.n}: only ${words.map((t) => t.term).join(", ") || "nothing"}`);
  }
  assert.ok(unnamed < slowFilms.length / 2, `${unnamed} of ${slowFilms.length} slow films have no shown reason`);
  assert.ok(!slowFilms.some((x) => x.i === "tt0044741"), "Ikiru is not slow");
});

test("the real build reads a list's mood weight film by film (by IMDb id): with a list the cache holds marked slow, its films enter slow with it as the reason", async () => {
  // the two canons are not in the committed cache/lists.json yet (the nightly build reads them), so the wiring is proven with one that is
  const R = require("../test-support/integration-reference");
  const held = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cache", "lists.json"), "utf8")).lists;
  const pick = cfg.lists.find((l) => held[l.id] && held[l.id].items.length >= 100 && !l.moods);
  const label = pick.name.replace(/ \([^)]*\)$/, "");
  const now = await R.capture(path.join(__dirname, ".."), { date: "2026-10-11", capturedAt: "2026-10-11T12:00:00.000Z", mapConfig: (c) => { c.lists.find((l) => l.id === pick.id).moods = { slow: 2 }; return c; } });
  const byList = now.webData.films.filter((x) => x.f.slow !== undefined && (x.h.slow || []).includes(label));
  assert.ok(byList.length >= 10, `${byList.length} films slow through “${label}”`);
  const plain = await R.capture(path.join(__dirname, ".."), { date: "2026-10-11", capturedAt: "2026-10-11T12:00:00.000Z" });
  const before = new Set(plain.webData.films.filter((x) => x.f.slow !== undefined).map((x) => x.i));
  assert.ok(byList.filter((x) => !before.has(x.i)).length >= 5, "the weight lets films in that were not slow without it");
});

test("the private learning replay (row-candidates) reads the same list weight: a canon film with no keyword is a slow candidate there too", () => {
  const RC = require("../lib/learning/row-candidates");
  const film = { id: 1, imdb: "tt1", title: "X", year: 2010, genres: ["Drama"], keywords: [], lang: "it", countries: ["IT"], runtime: 88, directors: [{ id: 3, name: "F" }], va: 7, vc: 100, cast: [] };
  const rows = (sourceId) => RC.freezeRows([{ filmId: "tt1", film, sources: [{ kind: "list", sourceId }] }], [], cfg, "2026-10-11", [], [{ id: "slow", items: [] }]);
  assert.equal(rows("5R3nu")[0].items.length, 1);
  assert.equal(rows("not-a-slow-list")[0].items.length, 0);
});

test("the real build stops on a list whose moods names a mood that does not exist", async () => {
  const R = require("../test-support/integration-reference");
  await assert.rejects(R.capture(path.join(__dirname, ".."), { date: "2026-10-11", capturedAt: "2026-10-11T12:00:00.000Z", mapConfig: (c) => { c.lists[0].moods = { slowest: 1 }; return c; } }), (e) => /moods names "slowest", which is not a mood/.test(String(e && e.message || e)));
});
