// node --test            (no dependencies)
// lib/friends-option.js: the "All friends loved" option put into a built index (Marco, 28/10/2026, Discover proposal 5; plan §5.4).
// Written against: an option appended at the END of the menu (after the lists of the friends instead of after the Top options), one that added films the index did not hold, one that kept the films you have seen,
// one ordered by the friends' loving order instead of the index's rank, an option in the index of a person's build, which has no friends, and (29/10/2026) a spread that counted the music film as hidden when the Worker serves it.
const test = require("node:test");
const assert = require("node:assert/strict");
const { addFriendsOption, positionAfterTops, DEFAULT_SPREAD } = require("../lib/friends-option");

const film = (tt, o = {}) => ({ tt, seen: false, musicOut: false, director: null, ...o });
// the films of an index come best rank first; the option takes that order
const INDEX = () => ({
  films: [film("tt1", { director: "D1" }), film("tt2", { director: "D1" }), film("tt3", { seen: true }), film("tt4", { director: "D2" }), film("tt5", { musicOut: true }), film("tt6")],
  friends: { people: ["A", "B"], options: [{ label: "Top · A", ids: ["tt1"] }, { label: "Top · B", ids: [] }, { label: "Watch together · A", ids: ["tt2"] }, { label: "Best (A)", ids: [] }] },
});
const TOPS = ["Top · A", "Top · B"];

test("the option sits after the last Top option and before Watch together; the others keep their order and their films", () => {
  const ix = INDEX();
  const at = positionAfterTops(ix.friends.options, TOPS);
  assert.equal(at, 2);
  const r = addFriendsOption(ix, { label: "All friends loved", tts: ["tt1"], at });
  assert.equal(r.at, 2);
  assert.deepEqual(ix.friends.options.map((o) => o.label), ["Top · A", "Top · B", "All friends loved", "Watch together · A", "Best (A)"]);
  assert.deepEqual(ix.friends.options[3].ids, ["tt2"], "Watch together is untouched");
  assert.deepEqual(ix.friends.options[0].ids, ["tt1"]);
});

test("the position is clamped, and the Top options are found wherever they are", () => {
  assert.equal(positionAfterTops([{ label: "x" }, { label: "Top · A" }, { label: "Top · B" }, { label: "y" }], TOPS), 3);
  assert.equal(positionAfterTops([{ label: "x" }], TOPS), 0, "no Top option: the front");
  const ix = INDEX();
  addFriendsOption(ix, { label: "All", tts: [], at: 99 });
  assert.equal(ix.friends.options.at(-1).label, "All", "beyond the end: the end");
  const iy = INDEX();
  addFriendsOption(iy, { label: "All", tts: [], at: -3 });
  assert.equal(iy.friends.options[0].label, "All");
});

test("only the films of the index, only the unseen, in the order of the index and not of the list that named them", () => {
  const ix = INDEX();
  const r = addFriendsOption(ix, { label: "All friends loved", tts: ["tt6", "tt999", "tt3", "tt5", "tt4", "tt1"], at: 2 });
  const ids = ix.friends.options[2].ids;
  assert.ok(!ids.includes("tt999"), "a film the index does not hold is not added (the index would have no entry for it)");
  assert.ok(!ids.includes("tt3"), "seen: out");
  assert.deepEqual([...ids].sort(), ["tt1", "tt4", "tt5", "tt6"]);
  assert.deepEqual(ids, ["tt1", "tt4", "tt5", "tt6"], "the index's order (tt1 before tt4 before tt5 before tt6), whatever the order the list came in");
  assert.deepEqual(r, { label: "All friends loved", total: 4, at: 2 }, "the log counts the films of the option; there is no 'shown by default' count, because the Worker serves them all (next test)");
});

// 29/10/2026, review of front C of Discover proposal 5: the first version took the film the music rule holds back (`musicOut`) out of the spread's window as "hidden by the Worker" (`!e.seen && !e.musicOut`), and the log said the Worker shows
// 1,627 of 1,632 by default. Measured by running the Worker's handler page by page: it serves all 1,632, because the catalog `friends` is exempt from the recommendation rule (worker/src/catalogs.js:43 exemptCatalogs, :54 eligibleTest → null,
// select() :152-156 filters `seen` only). The music film is ON the screen, so it takes room in the window like any other film.
test("the music film STAYS in the option and the Worker shows it (worker/src/catalogs.js exempts the catalog `friends`): it takes room in the spread's window like any film on the screen", async () => {
  const { eligibleTest, DEFAULT_RULES } = await import("../worker/src/catalogs.js");
  assert.equal(eligibleTest({}, "friends"), null, "the Worker's rule for the catalog friends: none (the film held back by the music rule is served)");
  assert.ok(DEFAULT_RULES.exemptCatalogs.includes("friends"));
  const held = { eligible: true, recommendable: false };
  assert.equal(eligibleTest({}, "explore")(held), false, "control: a catalog that recommends does hide the same film (the instrument sees a hidden film)");
  // director A: tt1 tt2 tt3, B: tt4 tt5, C: tt6; one of each per window of 3. tt2 is the music film. With the mutation (tt2 taken as not on the screen) the order is tt1 tt4 tt6 tt2 tt3 tt5 and tt2 is the same film.
  const dirs = { tt1: "A", tt2: "A", tt3: "A", tt4: "B", tt5: "B", tt6: "C" };
  const films = Object.keys(dirs).map((tt) => film(tt, { director: dirs[tt], musicOut: tt === "tt2" }));
  const ix = { films, friends: { people: [], options: [{ label: "Top · A", ids: [] }] } };
  addFriendsOption(ix, { label: "All", tts: Object.keys(dirs), at: 1, spreadSpec: { per: 1, perAfterFirstPage: 1, window: 3 } });
  const ids = ix.friends.options[1].ids;
  assert.ok(ids.includes("tt2"), "the music film is in the option");
  assert.deepEqual(ids, ["tt1", "tt4", "tt6", "tt2", "tt5", "tt3"], "spread as if every unseen film were on the screen");
});

test("the films are spread over the directors with the Discover's spread: a director does not fill the window while another has a film waiting", () => {
  const films = Array.from({ length: 6 }, (_, i) => film(`tt${i + 1}`, { director: "Same" })).concat([film("tt7", { director: "Other" })]);
  const ix = { films, friends: { people: [], options: [{ label: "Top · A", ids: [] }] } };
  addFriendsOption(ix, { label: "All", tts: films.map((f) => f.tt), at: 1, spreadSpec: { per: 1, perAfterFirstPage: 1, window: 2 } });
  assert.deepEqual(ix.friends.options[1].ids.slice(0, 3), ["tt1", "tt7", "tt2"], "Other's only film jumps ahead of Same's second one");
  const plain = { films, friends: { people: [], options: [{ label: "Top · A", ids: [] }] } };
  addFriendsOption(plain, { label: "All", tts: films.map((f) => f.tt), at: 1 });
  assert.deepEqual(plain.friends.options[1].ids.slice(0, 4), ["tt1", "tt2", "tt7", "tt3"], "control: with the default spread (2 per window of 20) the third place goes to the other director");
  assert.deepEqual(DEFAULT_SPREAD, { per: 2, perAfterFirstPage: 5, window: 20 });
});

test("an index with no friends options (a person's build: config.friends is empty) gets no option, and a repeated label is refused", () => {
  const person = { films: [film("tt1")], friends: { people: [], options: [] } };
  assert.equal(addFriendsOption(person, { label: "All", tts: ["tt1"], at: 0 }), null);
  assert.deepEqual(person.friends.options, [], "Will's index: the menu stays empty");
  const ix = INDEX();
  addFriendsOption(ix, { label: "All", tts: [], at: 2 });
  assert.throws(() => addFriendsOption(ix, { label: "All", tts: [], at: 2 }), /already in the index/);
});
