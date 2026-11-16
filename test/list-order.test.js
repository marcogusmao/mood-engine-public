// node --test            (no dependencies)
// The order a list is SHOWN in (config.json lists[].order; Marco, 22/10/2026 ~19:30 UTC: the Beyond the Sight & Sound A-List "por nota média do Letterboxd, maior primeiro").
// Absent = the source's order. The parity of the static files with the Worker is in test/index-export.test.js ("list order: ...").
// Every test here fails if the named defect is put back (worker/mutation.mjs, block "List order:").

const test = require("node:test");
const assert = require("node:assert/strict");
const LW = require("../lib/list-signal");
const P = require("../lib/pool");
const cfg = require("../config.json");

// slug → the film record the lists read: r = Letterboxd average (absent = none yet), imdbId
const rec = (n, r) => ({ imdbId: `tt00000${n}`, title: `Film ${n}`, year: 2000 + n, ...(r === undefined ? {} : { r }) });
const FILMS = { f1: rec(11, 3.2), f2: rec(12), f3: rec(13, 4.6), f4: rec(14, 4.0), f5: rec(15), f6: rec(16, 4.6), gone: { ...rec(17, 5.0), gone: true }, noid: { title: "No IMDb id", year: 1999, r: 4.9 } };
const ITEMS = ["f1", "f2", "f3", "not-looked-up", "f4", "f5", "f6", "gone", "noid"].map((slug) => ({ slug }));
const RATED = { id: "R", name: "Rated list", order: "rating", popular: false, items: ITEMS };
const PLAIN = { id: "P", name: "Plain list", popular: false, items: ITEMS };
const ids = (items) => items.map((x) => x.id);

test("config.json: only the Beyond the Sight & Sound A-List has `order`, and it is \"rating\"", () => {
  assert.deepEqual(cfg.lists.filter((l) => l.order !== undefined).map((l) => [l.id, l.order]), [["tspdt-beyond-ss-alist", "rating"]], "no other list is reordered");
  assert.doesNotThrow(() => LW.validateLists(cfg.lists));
});

test("validateLists: `order` is absent or \"rating\"; anything else stops the build, naming the list", () => {
  const base = { id: "X", name: "X", trust: "fan", url: "https://letterboxd.com/u/list/x/" };
  assert.doesNotThrow(() => LW.validateLists([base, { ...base, id: "Y", name: "Y", order: "rating" }]));
  for (const bad of ["year", "Rating", "", null, 5, true, ["rating"]]) assert.throws(() => LW.validateLists([{ ...base, order: bad }]), /lists\[0\] \(X\): order must be "rating"/, JSON.stringify(bad));
});

test("listSequence: no `order` is the source's order untouched", () => {
  assert.deepEqual(P.listSequence(PLAIN, FILMS), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test("listSequence: `rating` puts the highest Letterboxd average first; equal averages, films with no average and films that are not usable keep the source's order, after the rated ones", () => {
  const seq = P.listSequence(RATED, FILMS);
  // 4.9 (noid: rated, it is dropped later for having no IMDb id), 4.6 twice (f3 before f6: source order), 4.0, 3.2, then no average in the source's order: f2, not looked up, f5, gone
  assert.deepEqual(seq.map((i) => ITEMS[i].slug), ["noid", "f3", "f6", "f4", "f1", "f2", "not-looked-up", "f5", "gone"]);
  assert.equal(new Set(seq).size, ITEMS.length, "every item once");
});

test("listCatalogs: the static Lists files follow it (All and Unseen), skip what cannot be shown, and leave another list in the source's order", () => {
  const [r, p] = P.listCatalogs({ lists: [RATED, PLAIN], view: { films: FILMS }, isSeen: (x) => x.slug === "f4", size: Infinity });
  assert.deepEqual(ids(r.all), ["tt0000013", "tt0000016", "tt0000014", "tt0000011", "tt0000012", "tt0000015"]);
  assert.deepEqual(ids(r.unseen), ["tt0000013", "tt0000016", "tt0000011", "tt0000012", "tt0000015"], "the seen film (f4) is out of Unseen and the order holds");
  assert.deepEqual(ids(p.all), ["tt0000011", "tt0000012", "tt0000013", "tt0000014", "tt0000015", "tt0000016"], "a list with no `order` keeps the source's order");
  assert.deepEqual([r.stats.pending, r.stats.gone, r.stats.noImdb, r.stats.withTt], [1, 1, 1, 6], "the counts do not depend on the order");
  assert.deepEqual([r.all.length, p.all.length], [6, 6]);
});

// 22/10/2026 (second review): the web picker (engine.json) printed "#377 in “…”" with the SOURCE's index on the cards of the rated list, a chronological place read as a ranking. The "#N" is the
// place in the order the list is shown in (usable or not: the position counts the whole list, as in the index); a list with no `order` is unchanged. Defect guarded: `#${i + 1}` in lib/pool.js listCatalogs.
test("listCatalogs: the \"#N\" of a card is its place in the order shown (the rating's for `order`), and the source's place in a list with no `order`", () => {
  const [r, p] = P.listCatalogs({ lists: [RATED, PLAIN], view: { films: FILMS }, isSeen: () => false, size: Infinity });
  const why = (l) => Object.fromEntries(l.all.map((x) => [x.id, x.why[0]]));
  // sequence: noid (4.9, shown nowhere: no IMDb id), f3, f6, f4, f1, f2, not looked up, f5, gone → the places count all of them
  assert.deepEqual(why(r), { tt0000013: "#2 in “Rated list”", tt0000016: "#3 in “Rated list”", tt0000014: "#4 in “Rated list”", tt0000011: "#5 in “Rated list”", tt0000012: "#6 in “Rated list”", tt0000015: "#8 in “Rated list”" });
  assert.deepEqual(why(p), { tt0000011: "#1 in “Plain list”", tt0000012: "#2 in “Plain list”", tt0000013: "#3 in “Plain list”", tt0000014: "#5 in “Plain list”", tt0000015: "#6 in “Plain list”", tt0000016: "#7 in “Plain list”" });
});
