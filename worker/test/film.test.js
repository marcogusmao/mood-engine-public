// A Film around a row of the file: the plain columns, and the composite ones taken apart only when asked.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { COLS, LEGACY_COLS, NO_MASK_COLS, C, hydrate } from "../src/film.js";
import { parseIndex } from "../src/store.js";
import { makeIndex, makeIndexText, tweak } from "./fixture.js";

const rows = createRequire(import.meta.url)("../../lib/index-rows.js");

/** One film made from the fields given, through the build's encoder. */
function film(fields, people = ["Ana", "Bo"]) {
  const e = { tt: "tt0000001", name: "X", find: " x | | | | ", ...fields };
  return hydrate({ cols: COLS, friends: { people }, films: [rows.encodeFilm(e, people)] }).films[0];
}

test("plain columns come back as the value, or undefined when the file has none; flags and decade are read from their cells", () => {
  const f = film({ year: 1994, runtime: 154, lbRating: 4.2, rank: 0, taste: 0, desc: "d", director: "D", poster: "p", watchlist: true });
  assert.deepEqual([f.tt, f.name, f.year, f.decade, f.runtime, f.lbRating, f.rank, f.taste, f.desc, f.director, f.poster], ["tt0000001", "X", 1994, "1990s", 154, 4.2, 0, 0, "d", "D", "p"]);
  assert.deepEqual([f.seen, f.watchlist], [false, true], "a rank of 0 is a rank, not 'none'");
  const bare = film({});
  assert.deepEqual([bare.year, bare.decade, bare.runtime, bare.lbRating, bare.rank, bare.desc, bare.countries, bare.genres, bare.friends], [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
  assert.deepEqual([film({ seen: true }).seen, film({ seen: true, watchlist: true }).watchlist, film({ seen: true }).watchlist], [true, true, false]);
  assert.equal(film({ year: 2000 }).decade, "2000s");
  assert.equal(film({ year: 1989 }).decade, "1980s");
});

test("the v2.1 numbers: IMDb rating, how many of the crowd saw it and want to see it, their average; a count of 0 is a count, 'not known' is undefined", () => {
  const f = film({ imdbRating: 7.3, seenBy: 11, wantBy: 5, friendsAvg: 4.1 });
  assert.deepEqual([f.imdbRating, f.seenBy, f.wantBy, f.friendsAvg], [7.3, 11, 5, 4.1]);
  const none = film({});
  assert.deepEqual([none.imdbRating, none.seenBy, none.wantBy, none.friendsAvg], [undefined, undefined, undefined, undefined]);
  assert.equal(film({ seenBy: 2, friendsAvg: 0.5 }).friendsAvg, 0.5);
  assert.equal(film({ poster: "https://pages.test/posters/tt0000001.jpg" }).poster, "https://pages.test/posters/tt0000001.jpg");
});

test("countries: a label matches a whole country, not a piece of another (Guinea is not Papua New Guinea or Guinea-Bissau)", () => {
  const f = film({ countries: ["Papua New Guinea", "Guinea-Bissau", "France"] });
  assert.deepEqual(f.countries, ["Papua New Guinea", "Guinea-Bissau", "France"]);
  assert.equal(f.hasCountry("Guinea"), false);
  assert.equal(f.hasCountry("New Guinea"), false);
  assert.equal(f.hasCountry("France"), true, "last");
  assert.equal(f.hasCountry("Papua New Guinea"), true, "first");
  assert.equal(f.hasCountry("Guinea-Bissau"), true, "middle");
  assert.equal(film({ countries: ["Japan"] }).hasCountry("Japan"), true, "only one");
  assert.equal(film({}).hasCountry("Japan"), false);
});

test("lists and moods: the id must be the whole id (\"crit\" is not \"secrit\"), first, middle or last", () => {
  const f = film({ lists: { secrit: 3, crit: 5, "crit-2": 9, cannes: 1 }, moods: { night: [1.2, 3], "night2": [0.5, 1], lift: [0.9, 2.5] } });
  assert.equal(f.listPos("crit"), 5);
  assert.equal(f.listPos("secrit"), 3, "first");
  assert.equal(f.listPos("cannes"), 1, "last");
  assert.equal(f.listPos("crit-2"), 9);
  assert.equal(f.listPos("cri"), undefined);
  assert.equal(f.listPos("rit"), undefined);
  assert.equal(f.listPos("nope"), undefined);
  assert.deepEqual(f.mood("night"), [1.2, 3]);
  assert.deepEqual(f.mood("lift"), [0.9, 2.5]);
  assert.equal(f.mood("nigh"), undefined);
  assert.equal(film({}).listPos("crit"), undefined);
  assert.equal(film({}).mood("night"), undefined);
});

test("friends: names come from friends.people, a log with no stars is null, the average is read, and the answer is decoded once", () => {
  const f = film({ friends: { seenBy: [["Ana", 4.5], ["Bo", null]], wantBy: ["Bo", "Ana"], friendsAvg: 4.5 } });
  assert.deepEqual(f.friends, { seenBy: [["Ana", 4.5], ["Bo", null]], wantBy: ["Bo", "Ana"], friendsAvg: 4.5 });
  assert.equal(f.friends, f.friends, "the same object the second time");
  assert.deepEqual(film({ friends: { seenBy: [], wantBy: ["Ana"] } }).friends, { seenBy: [], wantBy: ["Ana"] });
  assert.deepEqual(film({ friends: { seenBy: [["Bo", 0.5]], wantBy: [] } }).friends, { seenBy: [["Bo", 0.5]], wantBy: [] });
});

test("hydrate: a file whose columns are not the ones this Worker reads is refused, never read with the wrong meaning", () => {
  assert.throws(() => hydrate({ cols: [...COLS].reverse(), films: [] }), /the columns are/);
  assert.throws(() => hydrate({ cols: COLS.slice(0, 5), films: [] }), /the columns are/);
  assert.throws(() => parseIndex(tweak(makeIndexText(), (j) => { j.cols = j.cols.slice().reverse(); })), /the columns are/);
  assert.equal(C.find, COLS.indexOf("find"));
});

test("the whole fixture through the file: every film reads back what was written (names, years, lists, moods, friends)", () => {
  const ix = makeIndex();
  const file = JSON.parse(makeIndexText());
  assert.equal(ix.films.length, file.films.length);
  const back = rows.decode(file);
  for (const [i, f] of ix.films.entries()) {
    const e = back.films[i];
    assert.deepEqual([f.tt, f.name, f.year, f.decade, f.runtime, f.rank, f.lbRating, f.seen, f.watchlist, f.countries, f.director], [e.tt, e.name, e.year, e.decade, e.runtime, e.rank, e.lbRating, !!e.seen, !!e.watchlist, e.countries, e.director], e.tt);
    for (const id of ["cannes", "crit"]) assert.equal(f.listPos(id), e.lists ? e.lists[id] : undefined, `${e.tt} list ${id}`);
    for (const id of ["night", "lift"]) assert.deepEqual(f.mood(id), e.moods ? e.moods[id] : undefined, `${e.tt} mood ${id}`);
    assert.deepEqual(f.friends, e.friends, e.tt);
  }
});

test("the `country` column (13/10/2026): the main country when it is not the first of `countries`, else the first of them; an index from before it is still read", () => {
  assert.equal(COLS[COLS.indexOf("country")], "country");
  assert.deepEqual(COLS.slice(-2), ["seenMask", "wantMask"], "the friends' masks (29/10/2026) are the last two; `country` was the last until then");
  assert.deepEqual(LEGACY_COLS, COLS.slice(0, COLS.indexOf("country")), "the columns before `country`");
  assert.equal(film({ countries: ["Italy", "France"] }).mainCountry, "Italy", "no column: the first of countries");
  assert.equal(film({ countries: ["Italy", "France"], country: "France" }).mainCountry, "France", "the column wins");
  assert.equal(film({ country: "Finland" }).mainCountry, "Finland", "no countries at all, a main country (136 films, 13/10/2026)");
  assert.equal(film({}).mainCountry, undefined);
  // an index written before the column: the old columns, rows without the last cell
  const people = ["Ana", "Bo"];
  const old = hydrate({ cols: LEGACY_COLS, friends: { people }, films: [rows.encodeFilm({ tt: "tt0000001", name: "X", countries: ["Spain"], find: " x " }, people).slice(0, LEGACY_COLS.length)] }).films[0];
  assert.equal(old.mainCountry, "Spain");
  assert.throws(() => hydrate({ cols: [...LEGACY_COLS, "other"], films: [] }), /the columns are/);
  assert.throws(() => hydrate({ cols: LEGACY_COLS.slice(0, -1), films: [] }), /the columns are/);
});

test("the friends' masks (29/10/2026): the file with the two last columns has them, the file from before is still read and says it has none", () => {
  const people = ["Ana", "Bo", "Cy"];
  const row = rows.encodeFilm({ tt: "tt0000001", name: "X", find: " x ", friends: { seenBy: [["Ana", 4], ["Cy", null]], wantBy: ["Bo"] } }, people);
  const now = hydrate({ cols: COLS, friends: { people }, films: [row] });
  assert.equal(now.masks, true);
  assert.deepEqual([now.films[0].seenMask, now.films[0].wantMask], [0b101, 0b010]);
  const none = hydrate({ cols: COLS, friends: { people }, films: [rows.encodeFilm({ tt: "tt0000002", name: "Y", find: " y " }, people)] });
  assert.deepEqual([none.films[0].seenMask, none.films[0].wantMask], [0, 0], "no friend: both are 0, never undefined");
  const before = hydrate({ cols: NO_MASK_COLS, friends: { people }, films: [row.slice(0, NO_MASK_COLS.length)] });
  assert.equal(before.masks, false);
  assert.equal(before.films[0].seenMask, 0, "a file from before has no masks: 0, and masks:false tells the friends' routes to refuse it");
  assert.deepEqual(NO_MASK_COLS, COLS.slice(0, -2));
});
