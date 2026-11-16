// The Worker 3.3.0 (14/10/2026; Marco, 13 and 14/10/2026): the v2 family of the index (lib/index-export.js pieces2) end to end through the handler, on the small index of fixture.js
// (makeV2Files: the legacy files plus index-v2.json, index-v2-menus.json, one file per Board row and per mood). What is asserted, in the order of the file:
//   the manifest (Discover first, the Board's own names and order, the Moods menu, the 46 countries, the version), what each request READS (the menus and one slice, never the whole index),
//   what it answers (a Board row, a mood, the Friends this week option, Explore, Search), what stays on the legacy files (Lists, Lists (unseen), Friends, Loved by directors, the old
//   ids), the fallbacks (a slice missing, the menus missing) and the Marco profile and the private address under the new family.
// The five other profiles and the fallback manifest against the code of origin/main: test/profile-parity.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHandler, urlsOf } from "../src/handler.js";
import { createStore } from "../src/store.js";
import { buildManifest, buildProfileManifest, ADDON_VERSION, MIXED_IN_V2 } from "../src/manifest.js";
import { PROFILES, MOOD_NAMES } from "../src/profiles.js";
import { makeFiles, makeV2Files, makeV2Object, v2ObjectFrom, textOf, tweak } from "./fixture.js";
import { makeObject as profileObject } from "./profile-fixture.js";
import { hydrate } from "../src/film.js";

const DIR = "https://pages.test/mood-engine/data/";
const ENV = { INDEX_URL: `${DIR}index.json` };
const V2 = makeV2Files();
const LEGACY = makeFiles();

/** `missing`: file names the "published site" does not have. calls: the file names asked for, in order. */
function rig({ files = V2, missing = [], env = ENV } = {}) {
  const r = { calls: [] };
  const fetchImpl = async (url) => {
    const name = url.slice(DIR.length);
    r.calls.push(name);
    if (!missing.includes(name) && files[name]) return new Response(files[name]);
    return new Response("not found", { status: 404 });
  };
  const handle = createHandler({ store: createStore({ fetchImpl, caches: undefined, log: () => {} }) });
  r.get = async (path, init = {}, e = env) => {
    const res = await handle(new Request("https://mood-engine.example.workers.dev" + path, init), e, undefined);
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null };
  };
  return r;
}
const names = (r) => r.json.metas.map((m) => m.name);
const second = (m) => m.description.split("\n\n")[0].split("\n")[1]; // line 2 of the card: the mood, the genres, the keywords

test("urlsOf: the v2 family sits in the folder of the index: the whole, the menus, a row by id, a mood by id", () => {
  const u = urlsOf({ INDEX_URL: `${DIR}index.json` });
  assert.equal(u.v2, `${DIR}index-v2.json`);
  assert.equal(u.menus, `${DIR}index-v2-menus.json`);
  assert.equal(u.row("after-midnight"), `${DIR}index-v2-row-after-midnight.json`);
  assert.equal(u.mood("horror-comedy"), `${DIR}index-v2-mood-horror-comedy.json`);
  assert.equal(u.row("a/b"), `${DIR}index-v2-row-a%2Fb.json`, "an id is one file name, whatever it holds");
});

// ── the manifest ─────────────────────────────────────────────────────────────

test("manifest, v2: the Discover catalogs FIRST (Discover opens on Moods), then the Board's rows in the index's order under its names, My series a series catalog where the index puts it, Friends this week not a catalog; 3.3.0; only the menus are read", async () => {
  const r = rig();
  const m = await r.get("/manifest.json");
  assert.equal(m.status, 200);
  assert.equal(m.json.version, "3.3.0");
  assert.equal(ADDON_VERSION, "3.3.0");
  assert.deepEqual(m.json.catalogs.map((c) => c.id), ["moods", "lists", "lists-unseen", "friends", "explore", "search", "tonight", "oldfriends", "my-series", "europe"]);
  assert.deepEqual(m.json.catalogs.slice(6).map((c) => [c.type, c.id, c.name, c.extra]), [
    ["movie", "tonight", "🎯 Tonight: 10 picks", undefined], ["movie", "oldfriends", "📼 Worth watching again", undefined], ["series", "my-series", "📺 Series to watch", undefined], ["movie", "europe", "🇪🇺 Europe", undefined],
  ], "the names are the index's, My series is the third entry and has no menu");
  assert.equal(m.json.catalogs.findIndex((c) => !c.extra), 6, "the first catalog without a menu (what the Board shows first) is the seventh: Discover is in front of it");
  assert.deepEqual(r.calls, ["index-v2-menus.json"], "the manifest reads the menus alone: 24 KB, no films, not even the legacy Board part");
  assert.equal(m.headers.get("x-index-source"), "network");
});

test("manifest, v2: the Moods menu is the index's moodMenu (every mood and the Friends this week option, under their labels); the country menu is the frozen one (meta.countriesAll) in Moods and Explore, the legacy 12 in the four catalogs that read legacy pieces", async () => {
  const m = (await rig().get("/manifest.json")).json;
  const by = Object.fromEntries(m.catalogs.map((c) => [c.id, c]));
  const opts = (c, name) => c.extra.find((e) => e.name === name).options;
  assert.deepEqual(opts(by.moods, "genre"), ["Nocturnal", "Uplift", "Noir", "Friends this week"]);
  const countries = makeV2Object().meta.countriesAll;
  assert.equal(countries.length, 7);
  for (const id of ["moods", "explore"]) assert.deepEqual(opts(by[id], "country"), countries, `${id}: v2 files, the frozen menu`);
  for (const id of ["lists", "lists-unseen", "friends"]) assert.deepEqual(opts(by[id], "country"), makeV2Object().meta.countries, `${id}: legacy pieces keep two countries per film and the legacy 12, so they keep the 12 menu until the build writes v2 pieces of them`);
  assert.equal(makeV2Object().meta.countries.length, 5);
  assert.ok(!by.search.extra.some((e) => e.name === "country"), "Search has no country menu");
  assert.deepEqual(opts(by.friends, "genre"), makeV2Object().friends.options.map((o) => o.label), "the other menus are the index's, as before");
  // 22/10/2026 (Marco, ~04:05 UTC): the two Lists menus show the short name of each list, one line on the phone; the full name stays in the index (`label`) for the installs made before
  assert.deepEqual(opts(by.lists, "genre"), ["Cannes Winners", "Closet Picks · all-time"]);
  assert.deepEqual(opts(by["lists-unseen"], "genre"), opts(by.lists, "genre"));
  assert.deepEqual(opts(by.lists, "genre"), makeV2Object().lists.map((l) => l.short));
});

test("manifest, no v2 menus (the build published no board): the manifest of origin/main, 3.1.0 included — the Board's rows, My series after Watchlist, then Discover, 5 countries — and the version rises only with the family", async () => {
  const withFamily = (await rig().get("/manifest.json")).json;
  const r = rig({ files: LEGACY });
  const legacy = await r.get("/manifest.json");
  assert.equal(legacy.json.version, "3.1.0");
  assert.equal(withFamily.version, "3.3.0");
  assert.deepEqual(legacy.json.catalogs.map((c) => c.id), ["tonight", "oldfriends", "my-series", "moods", "lists", "lists-unseen", "friends", "explore", "search"]);
  assert.deepEqual(legacy.json.catalogs.find((c) => c.id === "moods").extra.find((e) => e.name === "country").options.length, 5);
  assert.deepEqual(legacy.json.catalogs.find((c) => c.id === "my-series"), { type: "series", id: "my-series", name: "📺 My series to watch" });
  assert.deepEqual(r.calls, ["index-v2-menus.json", "index-board.json"], "the menus are asked for once and found missing; the legacy Board part answers");
  // the same through buildManifest, the function: an index with no moodMenu is the legacy shape whatever its other keys
  const ix = makeV2Object();
  const { moodMenu, ...noMenu } = ix;
  assert.equal(buildManifest(noMenu).version, "3.1.0");
  assert.equal(buildManifest(ix).version, "3.3.0");
});

test("manifest, v2: a Board entry of place \"menu\" is not a catalog and an index without the series entry has no series catalog (the v2 Board is the index's; the legacy one always had My series)", () => {
  const ix = makeV2Object();
  const noSeries = { ...ix, board: ix.board.filter((b) => !b.series) };
  const ids = buildManifest(noSeries).catalogs.map((c) => c.id);
  assert.ok(!ids.includes("my-series") && !ids.includes("friends-week"));
  assert.deepEqual(ids.slice(-3), ["tonight", "oldfriends", "europe"]);
});

// ── what each request reads, and what it says ────────────────────────────────

test("a Board row reads the menus and its own row slice: the build's films in the build's order, none seen, no rule applied; not the whole index", async () => {
  const r = rig();
  const got = await r.get("/catalog/movie/tonight.json");
  assert.equal(got.status, 200);
  assert.deepEqual(names(got), ["The Killing", "Amélie", "Just Below The Floor"], "the seen film is out; the film under the floor stays: Board rows are what the build made them");
  assert.deepEqual(r.calls, ["index-v2-menus.json", "index-v2-row-tonight.json"], "menus + ONE slice (an index-v2.json read here would be the 8 MB file of a cold request)");
  assert.equal(got.headers.get("x-total"), "3");
  const europe = await r.get("/catalog/movie/europe.json");
  assert.deepEqual(names(europe), ["Breathless", "Pierrot le Fou", "Amélie", "Nights of Cabiria", "Wild Strawberries", "A Very Short Film"], "the row's order, not the rank's");
  assert.deepEqual(r.calls, ["index-v2-menus.json", "index-v2-row-tonight.json", "index-v2-row-europe.json"]);
  assert.deepEqual((await r.get("/catalog/movie/oldfriends.json")).json.metas.map((m) => m.name), ["Old Friend You Saw"], "Old friends is the one row that shows what you have seen");
  assert.equal((await r.get("/catalog/movie/europe/decade=2020s.json")).text, europe.text, "a Board row ignores the four menus, as it always did: only Friends this week, as an option of Moods, takes them");
});

test("a Board row's description: the credits from the columns and the actors, and the row slice's own line 2 (a row that is not a mood has no ROW mood; this fixture's rowDesc has no best-fit label, which a real build adds, D3, 21/10/2026)", async () => {
  const r = rig();
  const m = (await r.get("/catalog/movie/europe.json")).json.metas[0];
  assert.equal(m.description, "Jean-Luc Godard · 1h30 · Breathless cast.\ngenres of the row.", "(the fixture's rowDesc carries the card and no synopsis)");
});

test("a Board row whose slice is missing is read from the whole v2 index, with the same films, and the missing slice is not asked for on every request", async () => {
  const slice = rig();
  const whole = rig({ missing: ["index-v2-row-europe.json"] });
  const [a, b] = [await slice.get("/catalog/movie/europe.json"), await whole.get("/catalog/movie/europe.json")];
  assert.equal(a.text, b.text);
  assert.deepEqual(whole.calls, ["index-v2-menus.json", "index-v2-row-europe.json", "index-v2.json"]);
  await whole.get("/catalog/movie/europe/skip=1.json");
  assert.equal(whole.calls.filter((c) => c === "index-v2-row-europe.json").length, 1);
});

test("a Board row of the old Board that the new one dropped (an install from before 3.3.0 may still ask for \"because\") is answered from the legacy Board part; a menu row is not a catalog", async () => {
  const files = { ...V2, "index-board.json": tweak(V2["index-board.json"], (j) => { j.board.push({ id: "because", name: "💭 Because you loved" }); j.rows.because = ["tt0000009"]; j.rowDesc.because = ["Amélie cast\n💭 Because you loved · why"]; }) };
  const r = rig({ files });
  assert.deepEqual(names(await r.get("/catalog/movie/because.json")), ["Amélie"]);
  assert.deepEqual(r.calls, ["index-v2-menus.json", "index-board.json"]);
  assert.equal((await r.get("/catalog/movie/friends-week.json")).status, 404, "Friends this week is an option of the Moods menu, not a catalog of the manifest");
  assert.equal((await r.get("/catalog/movie/ghost.json")).status, 404);
  assert.equal((await r.get("/catalog/movie/my-series.json")).status, 404, "My series is a series catalog; as a movie catalog it is nothing, as it always was");
  assert.equal((await r.get("/catalog/series/my-series.json")).json.metas.length, 85, "and the series row is the Worker's own list, read from no file");
});

test("Moods: an option is read from its mood's slice — every film that fits it, best rank first, none seen, the rule applied, two a director — with the menus on top and the mood's name on line 2", async () => {
  const r = rig();
  const noir = await r.get("/catalog/movie/moods/genre=Noir.json");
  assert.equal(noir.status, 200);
  assert.deepEqual(names(noir), ["The Killing", "Paths of Glory", "Breathless"], "…25 is seen, …29 is under the floor and …15 has no average: not served, though they fit the mood");
  assert.deepEqual(r.calls, ["index-v2-menus.json", "index-v2-mood-noir.json"]);
  assert.equal(noir.headers.get("x-total"), "3");
  // Marco, 28/10/2026: the mood is a chip (the best fit's name), the phrase "Mood: …" is not in the card
  assert.equal(second(noir.json.metas[0]), undefined);
  assert.ok(noir.json.metas[0].links.some((l) => l.category === "Mood" && l.name === "Noir"));
  assert.deepEqual(names(await r.get("/catalog/movie/moods/decade=1960s&genre=Noir.json")), ["Breathless"]);
  assert.deepEqual(r.calls.slice(2), [], "the slice is in memory now");
  const night = await r.get("/catalog/movie/moods/genre=Nocturnal.json");
  assert.deepEqual(r.calls.slice(2), ["index-v2-mood-night.json"]);
  assert.ok(night.json.metas.length > 5 && !names(night).includes("Seen But Nocturnal"));
  // the same words in another case or with the plus of a form, the way every menu is matched
  assert.deepEqual(names(await r.get("/catalog/movie/moods/genre=noir.json")), names(noir));
  assert.deepEqual(await r.get("/catalog/movie/moods/genre=Nothing.json").then((x) => [x.status, x.json.metas]), [200, []], "an option that is not in the menu is an empty page");
  assert.deepEqual(await r.get("/catalog/movie/moods.json").then((x) => [x.status, x.json.metas]), [200, []], "and so is no option at all");
});

test("Moods: a mood slice that is missing is read from the whole v2 index, with the same films", async () => {
  const slice = rig(), whole = rig({ missing: ["index-v2-mood-noir.json"] });
  const [a, b] = [await slice.get("/catalog/movie/moods/genre=Noir&decade=1950s.json"), await whole.get("/catalog/movie/moods/genre=Noir&decade=1950s.json")];
  assert.equal(a.text, b.text);
  assert.equal((await slice.get("/catalog/movie/moods/genre=Noir.json")).text, (await whole.get("/catalog/movie/moods/genre=Noir.json")).text);
  assert.deepEqual(whole.calls, ["index-v2-menus.json", "index-v2-mood-noir.json", "index-v2.json"]);
});

test("Moods, Friends this week: the Board's row served as an option of the menu — the build's order, its reasons, the seen film out, the film under the floor IN (no eligibility rule) — with the four menus on top; the row's slice is read", async () => {
  const r = rig();
  const got = await r.get("/catalog/movie/moods/genre=Friends%20this%20week.json");
  assert.equal(got.status, 200);
  assert.deepEqual(names(got), ["Pulp Fiction", "Just Below The Floor"], "Palme Winner You Saw is seen; Just Below The Floor fails the rule, which a Board row does not apply");
  assert.deepEqual(r.calls, ["index-v2-menus.json", "index-v2-row-friends-week.json"]);
  assert.equal(second(got.json.metas[0]), "genres of the row.", "the line the build wrote: Friends this week is no mood, so no mood is said");
  assert.deepEqual(names(await r.get("/catalog/movie/moods/decade=1990s&genre=Friends%20this%20week.json")), ["Pulp Fiction"]);
  assert.deepEqual(names(await r.get("/catalog/movie/moods/genre=Friends%20this%20week&country=Sweden.json")), ["Just Below The Floor"], "a country the menu does not list still filters, by its name");
  assert.deepEqual(names(await r.get("/catalog/movie/moods/genre=Friends%20this%20week&country=Iran.json")), [], "a country of the menu that no film of the row has");
  assert.deepEqual(names(await r.get("/catalog/movie/moods/genre=Friends%20this%20week&rating=Under%203.8.json")), ["Just Below The Floor"]);
  assert.deepEqual(names(await r.get("/catalog/movie/moods/genre=Friends%20this%20week&decade=2020s.json")), [], "a menu that matches nothing is an empty page, never the row unfiltered");
});

test("Explore and Search read the whole v2 index and nothing else; Explore at the 46-country menu's country filters by name", async () => {
  const r = rig();
  const explore = await r.get("/catalog/movie/explore/decade=1950s.json");
  assert.ok(explore.json.metas.length > 3);
  const search = await r.get("/catalog/movie/search/search=kubrick.json");
  assert.ok(names(search).includes("Paths of Glory"));
  assert.deepEqual(r.calls, ["index-v2.json"]);
  const legacy = rig({ files: LEGACY });
  assert.deepEqual(names(await legacy.get("/catalog/movie/explore/decade=1950s.json")), names(explore), "the same films as the legacy index (the fixture's v2 index only adds a mood)");
  const swedish = names(await r.get("/catalog/movie/explore/country=Sweden.json"));
  assert.deepEqual(swedish, ["Wild Strawberries", "Rescued By A Friend"], "Just Below The Floor is Swedish and under the floor: Explore applies the rule, a friend's 4 stars let the other in");
});

test("Lists, Lists (unseen), Friends and Loved by directors stay on the legacy files, whatever the build publishes; Search and Explore of a profile that is not Marco too", async () => {
  const r = rig();
  await r.get("/catalog/movie/lists/genre=Cannes%20Winners%20(moviewithus).json");
  await r.get("/catalog/movie/lists-unseen/genre=All-time%20Criterion%20Closet%20Picks%20(closetpicks).json");
  await r.get("/catalog/movie/friends/genre=Top%20%C2%B7%20Gustavo.json");
  await r.get("/catalog/movie/director-picks/genre=Nobody.json");
  assert.deepEqual(r.calls, ["index-board.json", "index-list-cannes.json", "index-list-crit.json", "index-friends.json", "index-directors.json"], "no v2 file is read, the menus included");
});

test("the store keeps the v2 whole index, the menus and the ROW slices for the life of the isolate (a queue of one piece lets go of a mood slice, never of those)", async () => {
  const store = createStore({ fetchImpl: async (url) => new Response(V2[url.slice(DIR.length)] || "no", { status: V2[url.slice(DIR.length)] ? 200 : 404 }), caches: undefined, log: () => {}, pieceMax: 1 });
  for (const f of ["index-v2-menus.json", "index-v2.json", "index-v2-row-tonight.json", "index-v2-row-europe.json", "index-v2-mood-noir.json", "index-v2-mood-night.json"]) await store.get(DIR + f);
  assert.deepEqual([...store._lru.keys()].map((u) => u.slice(DIR.length)), ["index-v2-mood-night.json"], "one piece in the queue: the second mood slice; the first was let go");
  for (const f of ["index-v2.json", "index-v2-menus.json", "index-v2-row-tonight.json", "index-v2-row-europe.json"]) assert.ok(store._slots.get(DIR + f).index, f);
  assert.equal(store._slots.get(DIR + "index-v2-mood-noir.json").index, null);
});

test("the Board opened twice in one isolate: the second opening is all `memory` — not one row slice read again, not one piece-evicted for a row — even with a queue of one piece", async () => {
  const logs = [];
  const fetched = [];
  const store = createStore({ fetchImpl: async (url) => { fetched.push(url.slice(DIR.length)); return new Response(V2[url.slice(DIR.length)] || "no", { status: V2[url.slice(DIR.length)] ? 200 : 404 }); }, caches: undefined, log: (o) => logs.push(o), pieceMax: 1 });
  const handle = createHandler({ store });
  const open = async () => {
    const sources = [];
    for (const p of ["/manifest.json", "/catalog/movie/tonight.json", "/catalog/movie/oldfriends.json", "/catalog/movie/europe.json", "/catalog/movie/moods/genre=Friends%20this%20week.json", "/catalog/movie/tonight.json"]) {
      const res = await handle(new Request("https://w.test" + p), ENV, undefined);
      assert.equal(res.status, 200, p);
      sources.push(res.headers.get("x-index-source"));
      await res.text();
    }
    return sources;
  };
  const first = await open();
  assert.ok(first.slice(0, 4).every((x) => x === "network"), `${first}`);
  const before = fetched.length;
  const second = await open();
  assert.deepEqual(second, second.map(() => "memory"), "every answer of the second opening came from memory");
  assert.equal(fetched.length, before, "nothing was fetched again");
  assert.deepEqual(logs.filter((l) => l.event === "piece-evicted" && /index-v2-row-/.test(l.url)), [], "and no row slice was ever let go");
});

// ── the Marco profile mirrors the old address; the private address too ───────

test("the Marco profile under the v2 family: the main manifest's catalogs (Discover first) under dry names, its menus on the 46 countries, and its old catalogs answer from the v2 files as the old address does", async () => {
  const r = rig();
  const main = (await r.get("/manifest.json")).json;
  const marco = (await r.get("/p/marco/manifest.json")).json;
  const mainIds = main.catalogs.map((c) => c.id);
  assert.deepEqual(marco.catalogs.map((c) => c.id).filter((id) => !id.startsWith("vouch-") && id !== "what-it-is"), mainIds);
  assert.deepEqual(marco.catalogs.filter((c) => !(c.extra || []).length).map((c) => c.name), ["Tonight", "Old friends", "My series", "Europe"], "dry names: BOARD_NAMES, else the index's name without its emoji");
  assert.equal(marco.catalogs[0].id, "moods", "Discover first, as the old address");
  assert.equal(marco.version, "3.2.1", "the profile has its own version, not the main manifest's");
  const cuts = (c) => c.extra.find((e) => e.name === "country").options;
  assert.equal(cuts(marco.catalogs.find((c) => c.id === "explore")).length, 7);
  assert.equal(cuts(marco.catalogs.find((c) => c.id === "lists")).length, 5, "Lists read legacy pieces: the legacy 12 (5 in this fixture)");
  for (const p of ["catalog/movie/europe.json", "catalog/movie/tonight.json", "catalog/movie/moods/genre=Noir.json", "catalog/movie/moods/genre=Friends%20this%20week.json", "catalog/movie/explore/decade=1950s.json", "catalog/movie/search/search=kubrick.json", "catalog/movie/lists/genre=Cannes%20Winners%20(moviewithus).json"])
    assert.equal((await r.get(`/p/marco/${p}`)).text.replace(/"X-Profile[^,]*,?/, ""), (await r.get(`/${p}`)).text, p);
  assert.equal((await r.get("/p/marco/catalog/movie/friends-week.json")).status, 404, "a menu row is declared by no manifest");
  assert.equal((await r.get("/p/marco/catalog/series/my-series.json")).json.metas.length, 85);
  assert.equal((await r.get("/p/marco/catalog/movie/europe.json")).headers.get("x-profile"), "marco");
});

test("the Marco profile with no v2 menus is exactly what it was: the legacy Board, 12 countries' menus, no v2 file read after the menus turned out missing", async () => {
  const r = rig({ files: LEGACY });
  const marco = (await r.get("/p/marco/manifest.json")).json;
  assert.deepEqual(marco.catalogs.map((c) => c.id).slice(0, 3), ["tonight", "oldfriends", "my-series"]);
  assert.equal(marco.catalogs.find((c) => c.id === "explore").extra.find((e) => e.name === "country").options.length, 5);
  assert.equal((await r.get("/p/marco/catalog/movie/tonight.json")).status, 200);
  assert.deepEqual(r.calls, ["index-v2-menus.json", "index-board.json"]);
});

test("the dry name of a legacy mood's id is not given to a v2 row that mixes moods: Horror (wicked + slasher + horror-comedy) stays Horror, not \"Art-house horror\"; a row that is the mood itself keeps decision 10's name", () => {
  const ix = makeV2Object();
  const board = [...ix.board, { id: "wicked", name: "🎃 Horror", place: "board" }, { id: "letin", name: "🌧️ Sad and beautiful", place: "board" }];
  const moods = [...ix.moods, { id: "wicked", label: "Wicked", name: "🎃 Something wicked" }, { id: "letin", label: "Catharsis", name: "🌧️ Let it in" }];
  const names = Object.fromEntries(buildProfileManifest({ ...ix, board, moods }, { key: "marco", ...PROFILES.get("marco") }).catalogs.map((c) => [c.id, c.name]));
  assert.equal(names.wicked, "Horror");
  assert.equal(names.letin, "Cathartic drama");
  // Who vouches and What it is, which only Marco has of the main address's mirror, keep the legacy country menu (the profile fixture has real list ids)
  const po = profileObject();
  const px = v2ObjectFrom({ ...po, meta: { ...po.meta, countries: ["France", "Japan"] } });
  const marco = buildProfileManifest(hydrate(JSON.parse(textOf(px))), { key: "marco", ...PROFILES.get("marco") });
  const cuts = (id) => marco.catalogs.find((c) => c.id === id).extra.find((e) => e.name === "country").options;
  assert.deepEqual([cuts("what-it-is"), cuts("vouch-critics")], [["France", "Japan"], ["France", "Japan"]], "Who vouches and What it is read list pieces: the legacy menu");
  assert.deepEqual(cuts("moods"), ["France", "Japan", "Poland", "Iran"], "Moods reads the v2 slices: the frozen menu");
});

test("the private address /k/<token>/ serves the v2 family exactly as the public one: the manifest byte for byte, a Board row, a mood, with `private` and no Referer", async () => {
  const token = "k".repeat(24);
  const env = { ...ENV, SUBTITLES_PRIVATE_TOKEN: token };
  const r = rig({ env });
  for (const p of ["/manifest.json", "/catalog/movie/europe.json", "/catalog/movie/moods/genre=Noir.json", "/catalog/movie/moods/genre=Friends%20this%20week.json", "/catalog/movie/explore/decade=1950s.json"]) {
    const [pub, priv] = [await r.get(p), await r.get(`/k/${token}${p}`)];
    assert.equal(pub.status, 200, p);
    if (!pub.json.metas) assert.equal(priv.text, pub.text, p);
    else {
      // 24/10/2026 (film page, rebased on 3.4.1): under /k/ a catalog card also carries the direct-stream hint behaviorHints.defaultVideoId = its IMDb id (the public address sends none); everything else is the same bytes.
      assert.ok(pub.json.metas.length > 0, p);
      for (const m of pub.json.metas) assert.equal(m.behaviorHints, undefined, `${p}: public card ${m.id} has no hint`);
      for (const m of priv.json.metas) assert.deepEqual(m.behaviorHints, { defaultVideoId: m.id }, `${p}: private card ${m.id} has the hint`);
      assert.deepEqual({ ...priv.json, metas: priv.json.metas.map(({ behaviorHints, ...m }) => m) }, pub.json, p);
    }
    assert.match(priv.headers.get("cache-control"), /^private/, p);
    assert.equal(priv.headers.get("referrer-policy"), "no-referrer", p);
  }
  assert.equal((await r.get("/k/" + "x".repeat(24) + "/manifest.json")).status, 404);
});

test("MIXED_IN_V2 is exactly the set of Board rows that are COMBINED rows under the id of a legacy mood: a new combined row that takes such an id fails here until it is listed, and a listed id that is no longer combined fails too (board-54.json is the Board of the tests)", () => {
  const board = JSON.parse(fs.readFileSync(new URL("./fixtures/board-54.json", import.meta.url), "utf8"));
  const combined = board.rows.filter((r) => r.kind === "combine").map((r) => r.id);
  const takesALegacyName = combined.filter((id) => board.order.includes(id) && id in MOOD_NAMES); // MOOD_NAMES: the dry names of the nine legacy moods (decision 10)
  assert.ok(takesALegacyName.length >= 1, "the fixture has such a row (Horror: wicked + slasher + horror-comedy)");
  assert.deepEqual([...MIXED_IN_V2].sort(), takesALegacyName.sort());
  for (const id of takesALegacyName) assert.ok(MIXED_IN_V2.has(id), `${id} is a combined row with the id of a legacy mood: add it to MIXED_IN_V2 (manifest.js) or the Marco profile calls it "${MOOD_NAMES[id]}"`);
});

// ── the manifest as 3.3.0 writes it, frozen (UPDATE_GOLDEN=1 writes it again, from THIS code) ──────────────────────────────────────────────────

test("the 3.3.0 manifest of the small v2 index is, byte for byte, fixtures/manifest-3.3.0.json (UPDATE_GOLDEN=1 rewrites the file; read the diff before committing it)", async () => {
  const file = new URL("./fixtures/manifest-3.3.0.json", import.meta.url);
  const got = (await rig().get("/manifest.json")).text;
  if (process.env.UPDATE_GOLDEN) fs.writeFileSync(file, got);
  assert.equal(got, fs.readFileSync(file, "utf8"));
  assert.equal(JSON.parse(got).version, "3.3.0");
});
