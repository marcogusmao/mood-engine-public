// node --test            (no dependencies)
// The mood each film fits best (lib/best-mood.js; Marco, 21/10/2026 ~15:00 UTC, D3): the lead of line 2 of the description in a row that is no mood.

const test = require("node:test");
const assert = require("node:assert/strict");
const { bestMoods } = require("../lib/best-mood");
const { fit, compile } = require("../lib/moods");

const entry = (tt, norm) => ({ film: { imdb: tt }, fitInfo: { norm } });

test("best mood: the highest norm wins; the norm is the score over what the mood asks for, so moods of different weight compare", () => {
  const moods = [{ id: "night", name: "🌃 Night drive" }, { id: "lol", name: "😂 Comedy" }, { id: "swoon", name: "💘 Swoon" }];
  const ranked = { night: [entry("tt1", 0.9), entry("tt2", 1.4)], lol: [entry("tt1", 1.2), entry("tt3", 0.7)], swoon: [entry("tt1", 1.1), entry("tt2", 1.4), entry("tt4", 1)] };
  const best = bestMoods({ moods, ranked });
  assert.deepEqual([...best], [["tt1", "😂 Comedy"], ["tt2", "🌃 Night drive"], ["tt3", "😂 Comedy"], ["tt4", "💘 Swoon"]]);
  assert.equal(best.get("tt2"), "🌃 Night drive", "a tie goes to the mood that comes first in config.json (the order of `moods`)");
});

test("best mood: only a mood the film fits counts — a film in no ranked list is not in the map, a norm of zero is no fit, and the person's 'wrong mood' for that mood takes it out", () => {
  const moods = [{ id: "night", name: "🌃 Night drive" }, { id: "lol", name: "😂 Comedy" }];
  const ranked = { night: [entry("tt1", 2), entry("tt2", 0), entry("tt3", NaN), { film: null, fitInfo: { norm: 1 } }, { film: { imdb: "tt5" } }], lol: [entry("tt1", 1)] };
  assert.deepEqual([...bestMoods({ moods, ranked })], [["tt1", "🌃 Night drive"]]);
  const refused = bestMoods({ moods, ranked, permits: (tt, id) => !(tt === "tt1" && id === "night") });
  assert.deepEqual([...refused], [["tt1", "😂 Comedy"]], "wrong mood for Night drive: the next best");
  assert.equal(bestMoods({ moods, ranked, permits: () => false }).size, 0);
  assert.equal(bestMoods().size, 0);
  assert.equal(bestMoods({ moods: [{ id: "x", name: "X" }], ranked: {} }).size, 0, "a mood with no list");
});

test("best mood: over the real fit() of lib/moods.js — a film that fits two moods says the one it fits better, and the weight of minFit does not decide it", () => {
  const moods = compile([
    { id: "heist", name: "🧰 Heist", word: "Heist", minFit: 1, genres: { Crime: 2 }, keywords: { heist: 1.5 } },
    { id: "gentle", name: "🫂 Gentle", word: "Gentle", minFit: 3, genres: { Drama: 1 }, keywords: { friendship: 2, kindness: 2 } },
  ]);
  const film = { id: 1, imdb: "tt1", genres: ["Crime", "Drama"], keywords: ["heist", "friendship", "kindness"], year: 1990, countries: ["US"], lang: "en" };
  const ranked = Object.fromEntries(moods.map((m) => [m.id, [{ film, fitInfo: fit(film, m) }].filter((c) => c.fitInfo.ok)]));
  const a = fit(film, moods[0]).norm, b = fit(film, moods[1]).norm;
  assert.ok(a > 0 && b > 0, `the film fits both: ${a} ${b}`);
  assert.equal(bestMoods({ moods, ranked }).get("tt1"), a >= b ? "🧰 Heist" : "🫂 Gentle");
});

// Review of the description v3, 21/10/2026 (cartao-x-decisoes): lib/best-mood.js claimed the name it writes is "the one the mood rows show"; five rows of the v2 Board show another name (board.names) than config.json's `moods`, and the label of a
// row that is no mood used config's, so the same film read "Mood: 🕯️ Slow and still" in Sight & Sound and "Mood: 🕯️ Slow and quiet" in the Slow row (91 films read two names for one mood on the build of 21/10/2026).
// Marco, 21/10/2026 ~19:40 UTC (B) renamed the five Board rows to the mood's name, on the premise that the Moods menu shows that name. The menu shows the mood's WORD (Escape, Catharsis, Wicked, Slow, Adrenaline), so at ~22:15 UTC he reverted the
// rename and asked for the rule these tests hold: the label takes the name of the mood's ROW in the Board when the Board has one (`rowNames`), else the mood's `name`. Nothing is passed for the legacy family, whose Board rows are named by the mood.
test("best mood: rowNames — a mood that has a Board row is written by the row's name, a mood without a row by its own name, and with no rowNames every mood by its own name (the legacy family; B, 21/10/2026 ~22:15 UTC)", () => {
  const moods = [{ id: "escape", name: "🎳 Full escape" }, { id: "night", name: "🌃 Night drive" }, { id: "slow", name: "🕯️ Slow and still" }];
  const ranked = { escape: [entry("tt1", 2)], night: [entry("tt2", 2)], slow: [entry("tt3", 2), entry("tt4", 2)], };
  const rowNames = { escape: "🎳 Fun and adventure", slow: "", constructor: "inherited from Object.prototype is not a row" }; // an empty name is no name; `constructor` is nobody's id
  assert.deepEqual([...bestMoods({ moods, ranked, rowNames })], [["tt1", "🎳 Fun and adventure"], ["tt2", "🌃 Night drive"], ["tt3", "🕯️ Slow and still"], ["tt4", "🕯️ Slow and still"]]);
  assert.deepEqual([...bestMoods({ moods, ranked })], [["tt1", "🎳 Full escape"], ["tt2", "🌃 Night drive"], ["tt3", "🕯️ Slow and still"], ["tt4", "🕯️ Slow and still"]], "no rowNames: the mood's own name");
  assert.equal(bestMoods({ moods: [{ id: "constructor", name: "C" }], ranked: { constructor: [entry("tt9", 1)] } }).get("tt9"), "C", "a mood whose id is a property of Object.prototype is not a row of an empty rowNames");
});

// The real names: for every mood of config.json that has a row in the Board (15 today) the label is the Board's name, and the five that have a Board name of their own are exactly the ones that differ from the mood's name. A new mood row with another
// name, or one of the five renamed again, changes this list on purpose (and the README table, BACKLOG 21/10/2026 and lib/best-mood.js with it).
test("best mood: over config.json — the names written for the moods that have a Board row are board.names, and exactly escape, letin, wicked, slow and adrenaline differ from the mood's name (B, 21/10/2026 ~22:15 UTC)", () => {
  const cfg = require("../config.json");
  const shared = cfg.moods.filter((m) => cfg.board.names[m.id]);
  assert.ok(shared.length >= 15, `${shared.length} ids are both a mood and a row`);
  const differ = shared.filter((m) => cfg.board.names[m.id] !== m.name).map((m) => m.id).sort();
  assert.deepEqual(differ, ["adrenaline", "escape", "letin", "slow", "wicked"]);
  const ranked = Object.fromEntries(cfg.moods.map((m, i) => [m.id, [entry("tt" + i, 1)]]));
  const v2 = bestMoods({ moods: cfg.moods, ranked, rowNames: cfg.board.names }), legacy = bestMoods({ moods: cfg.moods, ranked });
  cfg.moods.forEach((m, i) => {
    assert.equal(v2.get("tt" + i), cfg.board.names[m.id] || m.name, `${m.id}: the v2 family`);
    assert.equal(legacy.get("tt" + i), m.name, `${m.id}: the legacy family`);
  });
  for (const id of differ) assert.notEqual(v2.get("tt" + cfg.moods.findIndex((m) => m.id === id)), cfg.moods.find((m) => m.id === id).name, `${id}: the Board's name, not the mood's`);
});
