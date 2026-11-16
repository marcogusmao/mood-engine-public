// The "My series" row (Marco, 11/10/2026): the manifest entry (type series, no extra, right after the Board row "watchlist"), and the fixed catalog the handler serves
// without reading the index. Written 11/10/2026 for Worker 3.1.0.
// 21/10/2026 (Marco, 20/10/2026: a bigger fixed list with a weekly rotation of the front): 85 titles (series-list.js), rotate() in series.js, the catalog serves this week's order.
// 21/10/2026 ~16:10 UTC (Marco, questionnaire; the option he chose was not the recommended one): the fourth type is split, so there are FIVE types (sitcom, drama, arthouse, animation, documentary), the front is 2 per type = 10 titles,
// and the rings are 19, 28, 20, 11 and 7. Every number below that moved with this (8 -> 10 in the front, 4 -> 5 in a block, 18 -> 11 and 7 in the last two rings) says so where it is asserted.
// The week turns on Monday 00:00 in Brasília = 03:00 UTC. The clock of the handler is injected (`now`), so no test depends on today's date.

import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../src/handler.js";
import { createStore } from "../src/store.js";
import { buildManifest } from "../src/manifest.js";
import { SERIES_LIST, SERIES_TYPES, TYPE_LABELS, FRONT_PER_TYPE, rotate, weekOf, toSeriesMeta } from "../src/series.js";
import { makeFiles } from "./fixture.js";
import fs from "node:fs";

const DIR = "https://pages.test/mood-engine/data/";
const ENV = { INDEX_URL: `${DIR}index.json` };
const FILES = makeFiles();
const BASE = "https://mood-engine.example.workers.dev";
const MONDAY_43 = "2026-10-19T12:00:00Z"; // a Monday, ISO week 43 of 2026 (it began at 2026-10-19T03:00:00Z)

/** A handler over the fixture (up) or over an index that is not available at all (down: every store lookup answers null and counts). */
function rig({ up = true, at = MONDAY_43 } = {}) {
  const r = { asked: 0 };
  const store = up
    ? createStore({ fetchImpl: async (url) => (FILES[url.slice(DIR.length)] ? new Response(FILES[url.slice(DIR.length)]) : new Response("nope", { status: 404 })), caches: undefined, log: () => {} })
    : { get: async () => { r.asked++; return null; } };
  const handle = createHandler({ store, now: () => Date.parse(at) });
  r.get = async (path) => {
    const res = await handle(new Request(BASE + path), ENV, undefined);
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null };
  };
  return r;
}

/** The 25 old titles, in the order of the old row, copied literally from Marco's approved list (2026-10-11-my-series-row.json, 11/10/2026): id, name, first-air year. A change here is a change of the row. */
const PINNED = [
  ["tt5687612", "Fleabag", 2016],
  ["tt2297757", "Nathan for You", 2013],
  ["tt0141842", "The Sopranos", 1999],
  ["tt0248654", "Six Feet Under", 2001],
  ["tt10155688", "Mare of Easttown", 2021],
  ["tt6586318", "Patrick Melrose", 2018],
  ["tt1336685", "Capitu", 2008],
  ["tt0213338", "Cowboy Bebop", 1998],
  ["tt12590266", "Cyberpunk: Edgerunners", 2022],
  ["tt5753856", "Dark", 2017],
  ["tt0092337", "Dekalog", 1989],
  ["tt30252752", "Dying for Sex", 2025],
  ["tt21097264", "East of Eden", 2026],
  ["tt6866266", "Escape at Dannemora", 2018],
  ["tt1984119", "FEUD", 2017],
  ["tt11815682", "Hacks", 2021],
  ["tt11337908", "Maid", 2021],
  ["tt4158110", "Mr. Robot", 2015],
  ["tt3718778", "Over the Garden Wall", 2014],
  ["tt13623608", "The Curse", 2023],
  ["tt13527546", "The Night Logan Woke Up", 2022],
  ["tt0061287", "The Prisoner", 1967],
  ["tt0200276", "The West Wing", 1999],
  ["tt8681148", "This Is Going to Hurt", 2022],
  ["tt3910804", "War and Peace", 2016],
];

const board = (...ids) => ({ meta: {}, moods: [], lists: [], friends: { options: [] }, board: ids.map((id) => ({ id, name: id })) });
const seriesCatalogs = (m) => m.catalogs.filter((c) => c.type === "series");

test("manifest: types are movie and series, the series catalog exists exactly once with its id and name, and has no extra (so the Board asks for it)", () => {
  const m = buildManifest(board("tonight", "oldfriends"));
  assert.deepEqual(m.types, ["movie", "series"]);
  assert.deepEqual(seriesCatalogs(m), [{ type: "series", id: "my-series", name: "📺 My series to watch" }]);
  assert.equal(m.catalogs.filter((c) => c.id === "my-series").length, 1);
  assert.ok(!("extra" in seriesCatalogs(m)[0]), "no extra at all: a required one would keep it off the Board");
});

test("manifest: My series sits right after the Board row 'watchlist' when there is one", () => {
  const ids = buildManifest(board("tonight", "watchlist", "fromlists", "friends-love")).catalogs.map((c) => c.id);
  assert.deepEqual(ids.slice(0, 5), ["tonight", "watchlist", "my-series", "fromlists", "friends-love"]);
  assert.deepEqual(ids.slice(5), ["moods", "lists", "lists-unseen", "friends", "explore", "search"].filter((id) => ids.includes(id)), "the Discover catalogs follow the Board unchanged");
});

test("manifest: with no 'watchlist' row, My series comes right after the last Board row and before the Discover catalogs", () => {
  const ids = buildManifest(board("tonight", "oldfriends")).catalogs.map((c) => c.id);
  assert.deepEqual(ids.slice(0, 3), ["tonight", "oldfriends", "my-series"]);
  assert.ok(ids.indexOf("my-series") < ids.indexOf("explore") && ids.indexOf("my-series") < ids.indexOf("search"));
  assert.equal(buildManifest(board()).catalogs[0].id, "my-series", "a build with an empty Board still has the row, first");
});

test("manifest: the movie catalogs and the resources are as before; only the series catalog and the type were added", () => {
  const m = buildManifest(board("tonight", "watchlist"));
  assert.deepEqual(m.resources, ["catalog", { name: "subtitles", types: ["movie", "series"], idPrefixes: ["tt"] }]);
  assert.deepEqual(m.catalogs.filter((c) => c.id === "tonight" || c.id === "watchlist"), [{ type: "movie", id: "tonight", name: "tonight" }, { type: "movie", id: "watchlist", name: "watchlist" }]);
  assert.equal(m.catalogs.filter((c) => c.type === "movie").every((c) => c.id !== "my-series"), true);
  assert.equal(m.version, "3.1.0");
  assert.deepEqual(buildManifest(board("tonight")).catalogs.find((c) => c.id === "explore").extra[0], { name: "genre", isRequired: true, options: ["All"] }, "called with no options, Explore still stays off the Board");
});

/** The type each old title was given on 21/10/2026 (a judgement by name and year; Cinemeta's genre and country were looked at for seven of them: Capitu, Escape at Dannemora, The Night Logan Woke Up, Dying for Sex, East of Eden, The Curse and This Is Going to Hurt). A change here moves a title to another ring. */
const LEGACY_TYPE = {
  tt5687612: "sitcom", tt2297757: "sitcom", tt11815682: "sitcom", tt13623608: "sitcom",
  tt0141842: "drama", tt0248654: "drama", tt10155688: "drama", tt6586318: "drama", tt6866266: "drama", tt1984119: "drama", tt11337908: "drama", tt4158110: "drama", tt0200276: "drama", tt30252752: "drama", tt21097264: "drama", tt8681148: "drama", tt3910804: "drama",
  tt1336685: "arthouse", tt5753856: "arthouse", tt0092337: "arthouse", tt0061287: "arthouse", tt13527546: "arthouse",
  tt0213338: "animation", tt12590266: "animation", tt3718778: "animation",
};
const typeOf = (id) => SERIES_LIST.find((s) => s.id === id).type;
const WEEK = 7 * 86400e3;
const ids = (list) => list.map((s) => s.id);
const monday = (n) => new Date(Date.parse("2026-10-19T03:00:00Z") + n * WEEK); // the start of the n-th week after week 43, in Brasília
const MAX_RING = Math.max(...SERIES_TYPES.map((t) => SERIES_LIST.filter((s) => s.type === t).length));
const T = SERIES_TYPES.length; // 5 types since 21/10/2026 (4 before): a block of the front, and the front is FRONT = 2 blocks = 10 titles (8 before)
const FRONT = T * FRONT_PER_TYPE;
const NEW_PER_TYPE = [15, 15, 15, 8, 7]; // sitcom, drama, arthouse, animation, documentary: the approved 15 of the fourth type split 8 + 7 by Marco on 21/10/2026
const DOCUMENTARIES = ["tt0795176", "tt10801534", "tt4299972", "tt9805674", "tt11170862", "tt2044056", "tt1877514"]; // Planet Earth, How to with John Wilson, The Jinx, Planet Earth III, Cosmos: Possible Worlds, The Story of Film, The Vietnam War

// ── the list ─────────────────────────────────────────────────────────────────

test("the list: 85 titles with unique IMDb ids; the 25 old ones are all there, with their names and years; the new ones per type are 15, 15, 15, 8 and 7", () => {
  assert.equal(SERIES_LIST.length, 85);
  assert.equal(new Set(ids(SERIES_LIST)).size, 85, "ids are unique");
  assert.ok(SERIES_LIST.every((s) => /^tt\d+$/.test(s.id)), "every id is an IMDb id");
  assert.ok(SERIES_LIST.every((s) => typeof s.name === "string" && s.name.length > 0 && Number.isInteger(s.year) && s.year >= 1900 && s.year <= 2030));
  const legacy = SERIES_LIST.filter((s) => s.legacy);
  assert.deepEqual(legacy.map((s) => [s.id, s.name, s.year]).sort(), [...PINNED].sort(), "the 25 old titles, by id, name and year");
  assert.ok(SERIES_LIST.filter((s) => !s.legacy).every((s) => !("legacy" in s)), "legacy is set only on the old ones");
  SERIES_TYPES.forEach((t, i) => assert.equal(SERIES_LIST.filter((s) => s.type === t && !s.legacy).length, NEW_PER_TYPE[i], `${t}: ${NEW_PER_TYPE[i]} new`));
  assert.deepEqual(SERIES_TYPES, ["sitcom", "drama", "arthouse", "animation", "documentary"], "five types, in this order (the order of the front)");
  assert.ok(SERIES_LIST.every((s) => SERIES_TYPES.includes(s.type)), "every title has one of the five types");
});

// 21/10/2026, clean-context review of 056dc80: a changed id (The Shield), a changed name or year (Deadwood), a changed type (Frasier, The Corner) and swapped `order` (Peep Show / The Thick of It, Garth Marenghi / Mr. Show)
// in series-list.js all passed, because nothing guarded the 60 new titles but their count. This fixture is the approved list of 20/10/2026 (id, name, year, type, order), copied BY SCRIPT from the stremio repository's
// docs/series/2026-10-20-series-final-v3.json, not typed by hand; a change to one of the 60 is a change of the list Marco approved and must be made here on purpose, with his word.
// Regenerated by script on 21/10/2026 (stremio commit 12d255e; sha256 of the source JSON d5ecf4a63e0f…) after Marco split the fourth type: the only difference from the first copy is the `type` of seven titles, animation -> documentary.
test("the list: the 60 new titles are the approved list of 20/10/2026, field by field (id, name, year, type, order); a changed id, name, year, type or place in the ring is red", () => {
  const approved = JSON.parse(fs.readFileSync(new URL("./fixtures/series-approved-2026-10-20.json", import.meta.url), "utf8"));
  assert.equal(approved.length, 60);
  assert.equal(new Set(approved.map((s) => s.id)).size, 60);
  SERIES_TYPES.forEach((t, i) => assert.equal(approved.filter((s) => s.type === t).length, NEW_PER_TYPE[i], `the approved list has ${NEW_PER_TYPE[i]} ${t}`));
  assert.deepEqual(approved.filter((s) => s.type === "documentary").map((s) => s.id).sort(), [...DOCUMENTARIES].sort(), "the seven Marco moved to documentary on 21/10/2026, by id");
  const key = (s) => `${s.type}/${String(s.order).padStart(3, "0")}`;
  const fields = ({ id, name, year, type, order }) => ({ id, name, year, type, order });
  const ours = SERIES_LIST.filter((s) => !s.legacy).map(fields).sort((a, b) => key(a).localeCompare(key(b)));
  assert.deepEqual(ours, approved.map(fields).sort((a, b) => key(a).localeCompare(key(b))));
  assert.ok(SERIES_LIST.filter((s) => !s.legacy).every((s) => !s.description), "the new ones have no reason of their own: the row says 'Type · year'");
});

test("the list: `order` is unique inside each type and the new ones come first (1 to 15), the old ones after (16 and up, in the old row's order); animation and documentary share the ranks 1 to 15 between them, with no repeat", () => {
  for (const t of SERIES_TYPES) {
    const ring = SERIES_LIST.filter((s) => s.type === t);
    const orders = ring.map((s) => s.order);
    assert.equal(new Set(orders).size, ring.length, `${t}: no repeated place`);
    assert.ok(orders.every((o) => Number.isInteger(o) && o >= 1), t);
    assert.ok(ring.filter((s) => !s.legacy).every((s) => s.order <= 15), `${t}: the new ones are 1 to 15`);
    // 21/10/2026, review: the old ones of EACH type take exactly 16 .. 15+k, with no hole (">15" alone let The Curse go from 19 to 30 and stay green; on the base it was red)
    const oldOrders = ring.filter((s) => s.legacy).map((s) => s.order).sort((a, b) => a - b);
    assert.deepEqual(oldOrders, Array.from({ length: oldOrders.length }, (_, i) => 16 + i), `${t}: the old ones are 16 up with no hole`);
    const old = ring.filter((s) => s.legacy).sort((a, b) => a.order - b.order);
    assert.deepEqual(ids(old), PINNED.map(([id]) => id).filter((id) => LEGACY_TYPE[id] === t), `${t}: the old ones keep their old relative order`);
  }
  // 21/10/2026: sitcom, drama and arthouse still have 1..15 with no gap; the old fourth type's 15 ranks are now split between two types, so each of those two has gaps and together they have exactly 1..15
  for (const t of ["sitcom", "drama", "arthouse"]) assert.deepEqual(SERIES_LIST.filter((s) => s.type === t && !s.legacy).map((s) => s.order).sort((a, b) => a - b), Array.from({ length: 15 }, (_, i) => i + 1), t);
  const split = SERIES_LIST.filter((s) => (s.type === "animation" || s.type === "documentary") && !s.legacy).map((s) => s.order).sort((a, b) => a - b);
  assert.deepEqual(split, Array.from({ length: 15 }, (_, i) => i + 1), "animation + documentary: the 15 ranks of the old fourth type, once each");
  assert.deepEqual(SERIES_LIST.filter((s) => s.type === "animation" && s.legacy).map((s) => s.order), [16, 17, 18], "the three old animations follow the 8 new ones in the ring, from 16");
  assert.deepEqual(SERIES_LIST.filter((s) => s.type === "documentary").every((s) => !s.legacy), true, "no old title is a documentary: the ring of documentary is the 7 new ones");
});

test("the list: the type of each old title is the one pinned on 21/10/2026 (Marco accepted it as it was), and the sizes are 19 sitcom, 28 drama, 20 arthouse, 11 animation, 7 documentary", () => {
  for (const s of SERIES_LIST.filter((x) => x.legacy)) assert.equal(s.type, LEGACY_TYPE[s.id], s.name);
  assert.deepEqual(SERIES_TYPES.map((t) => SERIES_LIST.filter((s) => s.type === t).length), [19, 28, 20, 11, 7]);
  assert.deepEqual(SERIES_LIST.filter((s) => s.legacy).map((s) => s.type).reduce((n, t) => ({ ...n, [t]: (n[t] || 0) + 1 }), {}), { sitcom: 4, drama: 13, arthouse: 5, animation: 3 }, "the 25 old titles by type: 4, 13, 5, 3 and no documentary");
  // the three old animations were re-read in Cinemeta's genres on 21/10/2026 (meta.genres: Cowboy Bebop Animation/Action/Adventure; Cyberpunk: Edgerunners Animation/Action/Adventure; Over the Garden Wall Animation/Short/Adventure):
  // "Documentary" is in none of them, so they stay animation
  for (const id of ["tt0213338", "tt12590266", "tt3718778"]) assert.equal(typeOf(id), "animation", id);
});

test("the list: the titles Marco cut (Larry Sanders, Schitt's Creek, South Park) are not in it; Face to Face (1976) is, the one title older than 1990 among the new ones", () => {
  for (const id of ["tt0103466", "tt2575988", "tt0121955"]) assert.ok(!SERIES_LIST.some((s) => s.id === id), id);
  const face = SERIES_LIST.find((s) => s.id === "tt26593263");
  assert.deepEqual([face.name, face.year, face.type], ["Face to Face", 1976, "arthouse"]);
  assert.deepEqual(SERIES_LIST.filter((s) => !s.legacy && s.year < 1990).map((s) => s.name), ["Face to Face"]);
});

test("the list: no description carries a personal rating (stars as a symbol or as words); the six old reasons are word for word as on 11/10/2026", () => {
  for (const s of SERIES_LIST) assert.doesNotMatch(s.description || "", /★|\d(\.\d)?\s*stars?/i, s.name);
  const described = SERIES_LIST.filter((s) => s.description);
  assert.deepEqual(described.map((s) => s.name).sort(), ["Fleabag", "Nathan for You", "Mare of Easttown", "Patrick Melrose", "Six Feet Under", "The Sopranos"].sort(), "only the six picks carry a reason of their own");
  assert.equal(SERIES_LIST.find((s) => s.id === "tt0141842").description, "The long one to follow: family, power and inner life. From your love of Mad Men, The Wire and Better Call Saul.");
  assert.match(SERIES_LIST.find((s) => s.id === "tt5687612").description, /^Start here/);
});

// ── the week ─────────────────────────────────────────────────────────────────

test("weekOf: the week turns on Monday at 00:00 in Brasília, which is 03:00 UTC (Brazil is UTC-3 all year): one second before is the old week, the second itself is the new one", () => {
  assert.deepEqual(weekOf(new Date("2026-10-19T02:59:59Z")), { index: 2963 - 1, year: 2026, week: 42 });
  assert.deepEqual(weekOf(new Date("2026-10-19T03:00:00Z")), { index: 2963, year: 2026, week: 43 });
  assert.equal(weekOf(new Date("2026-10-26T02:59:59.999Z")).index, 2963, "the last millisecond of Sunday night in Brasília");
  assert.equal(weekOf(new Date("2026-10-26T03:00:00Z")).index, 2964);
  assert.equal(weekOf(Date.parse("2026-10-26T03:00:00Z")).index, 2964, "milliseconds are read as well as a Date");
  // Sunday 23:00 in Brasília is Monday 02:00 UTC: still the old week (a UTC-only reading would already be in the new one)
  assert.equal(weekOf(new Date("2026-10-26T02:00:00Z")).week, 43);
  // Monday 00:30 in Brasília is Monday 03:30 UTC: the new week
  assert.equal(weekOf(new Date("2026-10-26T03:30:00Z")).week, 44);
});

test("weekOf: the ISO name of the week (the year of its Thursday) is right at the turn of the year, and the index does not jump there", () => {
  const w = (s) => { const x = weekOf(new Date(s)); return `${x.year}-W${x.week}`; };
  assert.equal(w("2026-01-01T12:00:00Z"), "2026-W1");
  assert.equal(w("2026-12-31T12:00:00Z"), "2026-W53");
  assert.equal(w("2027-01-03T12:00:00Z"), "2026-W53", "Sunday 3 January 2027 still belongs to the week of Thursday 31 December");
  assert.equal(w("2027-01-04T12:00:00Z"), "2027-W1");
  assert.equal(w("2021-01-03T12:00:00Z"), "2020-W53");
  assert.equal(w("2024-12-30T12:00:00Z"), "2025-W1", "a Monday in December that opens the next ISO year");
  assert.equal(weekOf(new Date("2027-01-04T12:00:00Z")).index - weekOf(new Date("2026-12-31T12:00:00Z")).index, 1, "53 -> 1 is one step");
});

// ── rotate ───────────────────────────────────────────────────────────────────

test("rotate: the same list and the same moment give the same answer, every time, without touching the list", () => {
  const copy = JSON.stringify(SERIES_LIST);
  const a = rotate(SERIES_LIST, new Date("2026-10-21T15:00:00Z"));
  const b = rotate(SERIES_LIST, new Date("2026-10-21T15:00:00Z"));
  assert.deepEqual(ids(a), ids(b));
  assert.equal(JSON.stringify(SERIES_LIST), copy, "the list is not reordered in place");
  assert.equal(a.length, 85);
  assert.deepEqual(ids(a).sort(), ids(SERIES_LIST).sort(), "the same 85 titles, once each: nothing added, nothing lost");
});

test("rotate: it does not depend on where a title sits in the array (reversed or shuffled input, same answer): the fixed place is `order`, and the hash is of the id", () => {
  const at = new Date("2026-11-03T15:00:00Z");
  const want = ids(rotate(SERIES_LIST, at));
  assert.deepEqual(ids(rotate([...SERIES_LIST].reverse(), at)), want);
  const shuffled = [...SERIES_LIST].sort((a, b) => ((a.id.charCodeAt(5) * 31 + a.year) % 17) - ((b.id.charCodeAt(5) * 31 + b.year) % 17) || a.id.localeCompare(b.id));
  assert.notDeepEqual(ids(shuffled), ids(SERIES_LIST), "the shuffle did move things");
  assert.deepEqual(ids(rotate(shuffled, at)), want);
});

test("rotate: the answer is the same all week, from Monday 03:00 UTC to the next Monday 02:59:59 UTC, and different the week after", () => {
  const start = Date.parse("2026-10-19T03:00:00Z");
  const first = ids(rotate(SERIES_LIST, new Date(start)));
  for (const off of [1, 3600e3, 86400e3, 3 * 86400e3 + 12345, 6 * 86400e3, WEEK - 1]) assert.deepEqual(ids(rotate(SERIES_LIST, new Date(start + off))), first, `+${off} ms`);
  assert.notDeepEqual(ids(rotate(SERIES_LIST, new Date(start + WEEK))), first, "the next Monday 03:00 UTC");
  assert.notDeepEqual(ids(rotate(SERIES_LIST, new Date(start - 1))), first, "one millisecond before: the week before");
});

test("rotate: every Monday changes the front (the 10 first titles are never the same set as the week before) and the order of the rest, for 80 weeks", () => {
  let prev = rotate(SERIES_LIST, monday(0));
  for (let n = 1; n <= 80; n++) {
    const cur = rotate(SERIES_LIST, monday(n));
    const front = (l) => ids(l.slice(0, FRONT)).sort().join();
    assert.notEqual(front(cur), front(prev), `week +${n}: front`);
    const common = ids(cur.slice(FRONT)).filter((id) => ids(prev.slice(FRONT)).includes(id));
    assert.notDeepEqual(common, ids(prev.slice(FRONT)).filter((id) => common.includes(id)), `week +${n}: the rest slides too`);
    prev = cur;
  }
});

test("rotate: positions 1 to 5 are one title of each type, in the order sitcom, drama, arthouse, animation, documentary; 6 to 10 again one of each — for 200 consecutive weeks, across a New Year", () => {
  for (let n = -60; n < 140; n++) {
    const l = rotate(SERIES_LIST, monday(n));
    assert.deepEqual(l.slice(0, 5).map((s) => s.type), SERIES_TYPES, `week ${n}: 1-5`);
    assert.deepEqual(l.slice(5, 10).map((s) => s.type), SERIES_TYPES, `week ${n}: 6-10`);
    assert.equal(new Set(ids(l.slice(0, 10))).size, 10);
  }
});

test("rotate: `perType` sets how many of each type are in the front (default 2): 1 gives a front of 5, 3 a front of 15, always 5-by-5 in the order of the types", () => {
  assert.equal(FRONT_PER_TYPE, 2);
  for (const perType of [1, 2, 3, 5]) for (let n = 0; n < 30; n++) {
    const l = rotate(SERIES_LIST, monday(n), { perType });
    for (let j = 0; j < perType; j++) assert.deepEqual(l.slice(5 * j, 5 * j + 5).map((s) => s.type), SERIES_TYPES, `perType ${perType}, week ${n}, block ${j}`);
    assert.equal(l.length, 85);
  }
  assert.deepEqual(ids(rotate(SERIES_LIST, monday(3))), ids(rotate(SERIES_LIST, monday(3), {})), "an empty option is the default");
});

test("rotate: the window of each type wraps around the end of its ring: the front always has exactly 2 of each type, in the ring's order, even at the week the window straddles the last and the first title", () => {
  const ring = (t) => SERIES_LIST.filter((s) => s.type === t).sort((a, b) => a.order - b.order);
  let straddled = 0;
  for (let n = 0; n < 60; n++) { // (the odd rings, sitcom 19, animation 11 and documentary 7, move by 2 and so straddle the end, every 19, 11 and 7 weeks; the even rings, drama 28 and arthouse 20, tile exactly)
    const l = rotate(SERIES_LIST, monday(n));
    for (const [i, t] of SERIES_TYPES.entries()) {
      const got = [l[i], l[T + i]];
      assert.ok(got.every((s) => s && s.type === t), `week ${n}: two ${t}`);
      const r = ring(t), start = r.findIndex((s) => s.id === got[0].id);
      assert.equal(got[1].id, r[(start + 1) % r.length].id, `week ${n}: ${t} is the next place of the ring`);
      if (start === r.length - 1) { straddled++; assert.equal(got[1].id, r[0].id, "the last title is followed by the first"); }
    }
  }
  assert.ok(straddled >= 3, `the test did meet the wrap-around (${straddled} times)`);
});

test("rotate: coverage — in the weeks it takes to go round the biggest ring (14), every one of the 85 titles has been in the front; in 85/5, rounded up (17), too; in 13 weeks two are still missing", () => {
  for (const weeks of [Math.ceil(MAX_RING / FRONT_PER_TYPE), Math.ceil(85 / T)]) {
    const seen = new Set();
    for (let n = 0; n < weeks; n++) for (const s of rotate(SERIES_LIST, monday(n)).slice(0, FRONT)) seen.add(s.id);
    assert.equal(MAX_RING, 28);
    assert.equal(seen.size, 85, `${weeks} weeks`);
  }
  const seenFromAnyStart = (from, weeks = 14) => { const seen = new Set(); for (let n = from; n < from + weeks; n++) for (const s of rotate(SERIES_LIST, monday(n)).slice(0, FRONT)) seen.add(s.id); return seen.size; };
  for (const from of [-300, -1, 0, 7, 51, 52, 53, 400]) {
    assert.equal(seenFromAnyStart(from), 85, `starting at week ${from}`);
    assert.equal(seenFromAnyStart(from, 13), 83, `13 weeks from week ${from}: the drama ring (28, two a week) needs all 14`);
  }
});

// Measured on 21/10/2026 by script over 600 weeks (Node 22.23.3); this test repeats that measure from five starting weeks (0, 7, 51, 400 and -300), 600 weeks each: with 5 rings the whole list still goes through the front in 14 weeks,
// because the drama ring (28, two a week) decides it, as it did with 4; what changed is the two small rings. A ring of `size` places moved by 2 shows every title after ceil(size / 2) weeks, and shows the very same window again
// after `size` weeks when it is odd, `size / 2` when even. Review of 21/10/2026: the first version of this test read 60 weeks from one start, smaller than the claim in the README and the BACKLOG.
test("rotate: how long each ring takes — every title of the ring has been in the front after ceil(size/2) weeks (10, 14, 10, 6, 4), the same window is back after 19, 14, 10, 11 and 7 weeks; the two small rings repeat titles sooner; the same from five starting weeks, 600 weeks each", () => {
  for (const from of [0, 7, 51, 400, -300]) {
    const FRONTS = Array.from({ length: 600 }, (_, n) => rotate(SERIES_LIST, monday(from + n)).slice(0, FRONT));
    const sizes = [], covers = [], laps = [], timesIn14 = [];
    for (const t of SERIES_TYPES) {
      const ring = SERIES_LIST.filter((s) => s.type === t);
      sizes.push(ring.length);
      const seen = new Set(); let n = 0;
      while (seen.size < ring.length) FRONTS[n++].filter((s) => s.type === t).forEach((s) => seen.add(s.id));
      covers.push(n);
      const window = (k) => FRONTS[k].filter((s) => s.type === t).map((s) => s.id).join();
      laps.push(1 + FRONTS.slice(1).findIndex((_, k) => window(k + 1) === window(0)));
      const count = new Map(); for (let k = 0; k < 14; k++) FRONTS[k].filter((s) => s.type === t).forEach((s) => count.set(s.id, (count.get(s.id) || 0) + 1));
      timesIn14.push([Math.min(...count.values()), Math.max(...count.values())]);
    }
    assert.deepEqual(sizes, [19, 28, 20, 11, 7]);
    assert.deepEqual(covers, [10, 14, 10, 6, 4], `from week ${from}: weeks until every title of the ring has led once`);
    assert.deepEqual(laps, [19, 14, 10, 11, 7], `from week ${from}: weeks until the ring shows the same two titles again`);
    assert.deepEqual(timesIn14, [[1, 2], [1, 1], [1, 2], [2, 3], [4, 4]], `from week ${from}: in 14 weeks a title shows min..max times: a documentary 4 times, an animation 2 or 3, the others once or twice`);
    // all 85 in 14 weeks from this start (13 weeks leave two out); the coverage test above has more starting weeks
    const seen85 = (weeks) => new Set(FRONTS.slice(0, weeks).flat().map((s) => s.id)).size;
    assert.equal(seen85(14), 85, `from week ${from}: all 85 in 14 weeks`);
    assert.equal(seen85(13), 83, `from week ${from}: 83 in 13 weeks`);
  }
});

test("rotate: the old 25 are in the rotation like the others — not stuck at the top — and each of them reaches the front", () => {
  const frontOf = new Map();
  for (let n = 0; n < 14; n++) for (const s of rotate(SERIES_LIST, monday(n)).slice(0, FRONT)) frontOf.set(s.id, (frontOf.get(s.id) || 0) + 1);
  for (const [id] of PINNED) assert.ok(frontOf.has(id), id);
  const oldInFront = [0, 1, 2, 3, 4, 5, 6].map((n) => rotate(SERIES_LIST, monday(n)).slice(0, FRONT).filter((s) => s.legacy).length);
  assert.ok(oldInFront.some((k) => k < FRONT), "some weeks have new titles in the front");
  assert.ok(new Set(oldInFront).size > 1, "the number of old titles in the front changes from week to week");
});

test("rotate: a title of an unknown type is kept (in the rest), a type with no title is skipped, and an empty list gives an empty list", () => {
  const odd = { id: "tt9999999", name: "Odd", year: 2000, type: "webcast", order: 1 };
  const l = rotate([...SERIES_LIST, odd], monday(2));
  assert.equal(l.length, 86);
  assert.ok(l.slice(FRONT).some((s) => s.id === odd.id), "in the rest, not in the front");
  const noArthouse = rotate(SERIES_LIST.filter((s) => s.type !== "arthouse"), monday(2));
  assert.deepEqual(noArthouse.slice(0, 4).map((s) => s.type), ["sitcom", "drama", "animation", "documentary"]);
  assert.deepEqual(rotate([], monday(0)), []);
  const tiny = SERIES_LIST.filter((s) => s.type === "sitcom").slice(0, 1);
  assert.deepEqual(ids(rotate(tiny, monday(0), { perType: 3 })), ids(tiny), "a ring smaller than perType gives each title once");
});

// ── the catalog ──────────────────────────────────────────────────────────────

test("GET /catalog/series/my-series.json: 85 series, all type series, IMDb ids, unique, in this week's order (the answer is rotate() of the list, as metas)", async () => {
  const got = await rig().get("/catalog/series/my-series.json");
  assert.equal(got.status, 200);
  const metas = got.json.metas;
  assert.equal(metas.length, 85);
  assert.equal(got.json.cacheMaxAge, 300);
  assert.equal(got.headers.get("x-total"), "85");
  assert.ok(metas.every((m) => m.type === "series"));
  assert.ok(metas.every((m) => /^tt\d+$/.test(m.id)));
  assert.equal(new Set(metas.map((m) => m.id)).size, 85);
  assert.deepEqual(metas, rotate(SERIES_LIST, new Date(MONDAY_43)).map(toSeriesMeta));
  assert.deepEqual(metas.slice(0, 5).map((m) => typeOf(m.id)), SERIES_TYPES, "the first five are one of each type");
  assert.deepEqual(metas.slice(5, 10).map((m) => typeOf(m.id)), SERIES_TYPES, "and the next five again");
  assert.ok(JSON.stringify(got.json).length < 40000, `the answer is ${JSON.stringify(got.json).length} bytes`);
});

test("GET my-series: the order changes at Monday 00:00 in Brasília (03:00 UTC) and not before, through the handler's clock", async () => {
  const at = async (iso) => (await rig({ at: iso }).get("/catalog/series/my-series.json")).json.metas.map((m) => m.id);
  const sunday = await at("2026-10-26T02:59:59Z"), monday0 = await at("2026-10-26T03:00:00Z");
  assert.deepEqual(sunday, await at("2026-10-19T03:00:00Z"), "the whole week is one order");
  assert.notDeepEqual(monday0, sunday);
  assert.deepEqual(monday0, await at("2026-11-01T20:00:00Z"));
});

test("a series meta has the cover of the poster service, the poster shape, the year as text, and a description on every one: the six old reasons, the rest 'Type · year'", async () => {
  const metas = (await rig().get("/catalog/series/my-series.json")).json.metas;
  assert.ok(metas.every((m) => m.posterShape === "poster" && m.poster === `https://images.metahub.space/poster/medium/${m.id}/img` && typeof m.releaseInfo === "string" && /^\d{4}$/.test(m.releaseInfo)));
  assert.ok(metas.every((m) => typeof m.description === "string" && m.description.length > 0));
  const own = metas.filter((m) => SERIES_LIST.find((s) => s.id === m.id).description);
  assert.equal(own.length, 6, "six carry the reason in words");
  for (const m of metas) if (!own.includes(m)) assert.equal(m.description, `${TYPE_LABELS[typeOf(m.id)]} · ${m.releaseInfo}`, m.name);
  assert.equal(metas.find((m) => m.id === "tt0387764").description, "Sitcom · 2003", "Peep Show");
  assert.equal(metas.find((m) => m.id === "tt1856010").description, "Drama · 2013", "House of Cards");
  assert.equal(metas.find((m) => m.id === "tt0795176").description, "Documentary · 2006", "Planet Earth (was \"Animation & documentary\" until 21/10/2026)");
  assert.equal(metas.find((m) => m.id === "tt4299972").description, "Documentary · 2015", "The Jinx");
  assert.equal(metas.find((m) => m.id === "tt11126994").description, "Animation · 2021", "Arcane");
  assert.equal(metas.find((m) => m.id === "tt0213338").description, "Animation · 1998", "Cowboy Bebop, one of the old ones, typed animation");
  assert.ok(metas.every((m) => !/&/.test(m.description)), "the old label \"Animation & documentary\" is gone from every description");
  assert.equal(metas.find((m) => m.id === "tt26593263").description, "Arthouse · 1976", "Face to Face");
  assert.deepEqual(toSeriesMeta({ id: "tt1", name: "X", year: 2000, type: "nope" }), { id: "tt1", type: "series", name: "X", poster: "https://images.metahub.space/poster/medium/tt1/img", posterShape: "poster", releaseInfo: "2000" }, "no type and no reason: no description key at all");
});

test("the series catalog answers when the index is not available, without asking the store for anything", async () => {
  const r = rig({ up: false });
  const got = await r.get("/catalog/series/my-series.json");
  assert.equal(got.status, 200);
  assert.equal(got.json.metas.length, 85);
  assert.equal(got.json.cacheMaxAge, 300, "a full answer is cached as a full answer, not as an outage (30 s)");
  assert.equal(got.headers.get("cache-control"), "public, max-age=300");
  assert.equal(r.asked, 0, "it never reads the index");
  assert.equal((await r.get("/manifest.json")).status, 503, "the manifest still needs the index: that is unchanged");
});

test("skip: 0 gives the whole list (85 fit in one page of 100), 85 or more gives an empty page, 10 gives the rest from the 11th; extras in any form are read", async () => {
  const r = rig();
  const all = (await r.get("/catalog/series/my-series/skip=0.json")).json.metas;
  assert.equal(all.length, 85);
  assert.deepEqual((await r.get("/catalog/series/my-series/skip=85.json")).json.metas, []);
  assert.deepEqual((await r.get("/catalog/series/my-series/skip=100.json")).json.metas, []);
  const rest = (await r.get("/catalog/series/my-series/skip=10.json")).json.metas;
  assert.equal(rest.length, 75);
  assert.equal(rest[0].id, all[10].id);
  assert.equal((await r.get("/catalog/series/my-series/skip=-3.json")).json.metas.length, 85, "a negative skip is read as 0, like everywhere else");
  assert.equal((await r.get("/catalog/series/my-series/skip=84.json")).json.metas.length, 1);
});

test("another series catalog id is an empty page (200, 5 minutes), as any non-movie type was before", async () => {
  const r = rig();
  for (const path of ["/catalog/series/nope.json", "/catalog/series/tonight.json", "/catalog/series/my-series-2.json", "/catalog/series/My-Series.json"]) {
    const got = await r.get(path);
    assert.deepEqual([got.status, got.json.metas, got.json.cacheMaxAge], [200, [], 300], path);
  }
  assert.deepEqual((await r.get("/catalog/tv/my-series.json")).json.metas, [], "the id under another type is empty too");
  assert.deepEqual((await r.get("/catalog/movie/my-series.json")).status, 404, "and as a film catalog it is an unknown id, like any other");
});

test("a film catalog answers as before: the fixture's Tonight row, type movie, no series header", async () => {
  const r = rig();
  const got = await r.get("/catalog/movie/tonight.json");
  assert.equal(got.status, 200);
  assert.deepEqual(got.json.metas.map((m) => m.name), ["The Killing", "Amélie", "Just Below The Floor"]);
  assert.ok(got.json.metas.every((m) => m.type === "movie" && !m.id.startsWith("tt5687612")));
  assert.equal(got.headers.get("x-page-size"), "100");
  assert.ok(got.headers.get("x-index-source"), "a film answer still says where its index came from");
});

test("the 25 old titles are still in what the Worker answers, by id, name and year (pinned 11/10/2026; a wrong id such as Dekalog's tt0092338 is red)", async () => {
  const metas = (await rig().get("/catalog/series/my-series.json")).json.metas;
  const byId = new Map(metas.map((m) => [m.id, m]));
  for (const [id, name, year] of PINNED) assert.deepEqual([byId.get(id)?.name, Number(byId.get(id)?.releaseInfo)], [name, year], id);
});

test("privacy: no description carries a personal rating (stars as a symbol or as words); the reason is in words (Marco, 11/10/2026)", async () => {
  const metas = (await rig().get("/catalog/series/my-series.json")).json.metas;
  for (const m of metas) assert.doesNotMatch(m.description, /★|\d(\.\d)?\s*stars?/i, m.name);
  assert.match(metas.find((m) => m.id === "tt0141842").description, /^The long one to follow: family, power and inner life\. From your love of Mad Men, The Wire and Better Call Saul\.$/);
});
