// node --test            (from worker/ or from the repository root)
// The address Stremio asks for: extras in any order, URL-encoded, with accents and the middle dot of "Top · William".

import test from "node:test";
import assert from "node:assert/strict";
import { decode, listMenu, matchList, matchOption, parseCatalogPath, parseExtras, skipOf } from "../src/extras.js";
import { makeIndex } from "./fixture.js";

test("extras: the same two menus in either order give the same request (stremio-core puts the menu just touched in front)", () => {
  const a = parseExtras("decade=1990s&genre=Nocturnal");
  const b = parseExtras("genre=Nocturnal&decade=1990s");
  assert.deepEqual(a, { decade: "1990s", genre: "Nocturnal" });
  assert.deepEqual(a, b);
  const five = parseExtras("rating=4.2%2B&country=France&runtime=Under%2090%20min&decade=1960s&genre=Uplift");
  assert.deepEqual(five, { rating: "4.2+", country: "France", runtime: "Under 90 min", decade: "1960s", genre: "Uplift" });
  assert.deepEqual(parseExtras("genre=Uplift&skip=100&decade=1960s"), { genre: "Uplift", skip: "100", decade: "1960s" });
});

test("extras: percent-encoding, the middle dot, an en dash, accents, parentheses, an apostrophe", () => {
  assert.equal(parseExtras("genre=Top%20%C2%B7%20William").genre, "Top · William");
  assert.equal(parseExtras("runtime=90%E2%80%93120%20min").runtime, "90–120 min");
  assert.equal(parseExtras("search=am%C3%A9lie").search, "amélie");
  assert.equal(parseExtras("genre=Cannes%20Winners%20(moviewithus)").genre, "Cannes Winners (moviewithus)");
  assert.equal(parseExtras("genre=Cannes%20Winners%20%28moviewithus%29").genre, "Cannes Winners (moviewithus)");
  assert.equal(parseExtras("genre=Isabela%20Boscov's%2040%20(orafabarbosa)").genre, "Isabela Boscov's 40 (orafabarbosa)");
  assert.equal(parseExtras("genre=Top%20%C2%B7%20William").genre, parseExtras("genre=Top · William").genre, "an unencoded request reads the same");
});

test("extras: a plus is a space, %2B is a plus; a broken percent sign does not throw; a repeated name keeps the first; an empty or missing string is no extras", () => {
  assert.equal(parseExtras("search=the+killing").search, "the killing");
  assert.equal(parseExtras("search=c%2B%2B").search, "c++");
  assert.doesNotThrow(() => parseExtras("search=100%&genre=%E0%A4%A"));
  assert.equal(parseExtras("search=100%").search, "100%");
  assert.deepEqual(parseExtras("genre=A&genre=B"), { genre: "A" });
  for (const none of ["", undefined, null, "&", "?"]) assert.deepEqual(parseExtras(none), {});
  assert.deepEqual(parseExtras("skip"), { skip: "" });
  assert.equal(decode("a%20b+c"), "a b c");
});

test("path: /catalog/movie/<id>.json and /catalog/movie/<id>/<extras>.json, in whatever order; anything else is not a catalog request", () => {
  assert.deepEqual(parseCatalogPath("/catalog/movie/tonight.json"), { type: "movie", id: "tonight", extras: {} });
  assert.deepEqual(parseCatalogPath("/catalog/movie/moods/decade=1990s&genre=Nocturnal.json"), { type: "movie", id: "moods", extras: { decade: "1990s", genre: "Nocturnal" } });
  assert.deepEqual(parseCatalogPath("/catalog/movie/moods/genre=Nocturnal&decade=1990s.json").extras, { genre: "Nocturnal", decade: "1990s" });
  assert.deepEqual(parseCatalogPath("/catalog/movie/lists/genre=A%2FB.json").extras, { genre: "A/B" }, "an encoded slash stays inside its value");
  assert.deepEqual(parseCatalogPath("/catalog/movie/search/search=the%20killing.json").extras, { search: "the killing" });
  assert.equal(parseCatalogPath("/catalog/movie/tonight"), null, "no .json");
  assert.equal(parseCatalogPath("/manifest.json"), null);
  assert.equal(parseCatalogPath("/catalog/movie.json"), null);
  assert.equal(parseCatalogPath("/catalog/movie/a/b/c.json"), null);
  assert.equal(parseCatalogPath("/stream/movie/tt1.json"), null);
});

test("skip: whole numbers only; anything else is the first page", () => {
  assert.equal(skipOf({ skip: "100" }), 100);
  assert.equal(skipOf({ skip: "0" }), 0);
  for (const bad of ["", "-5", "abc", undefined]) assert.equal(skipOf({ skip: bad }), 0);
  assert.equal(skipOf({}), 0);
});

test("matchOption: the label exactly, else the same words ('+' for a space, '4.2+' read as '4.2 ', a hyphen for the en dash, another case); no option fits → null", () => {
  const rating = ["4.2+", "4.0–4.2", "3.8–4.0", "Under 3.8"];
  const runtime = ["Under 90 min", "90–120 min", "120–150 min", "Over 150 min"];
  assert.equal(matchOption("4.2+", rating), "4.2+");
  assert.equal(matchOption("4.2 ", rating), "4.2+", "a client that left the plus raw, read as a space");
  assert.equal(matchOption("4.0-4.2", rating), "4.0–4.2");
  assert.equal(matchOption("under 3.8", rating), "Under 3.8");
  assert.equal(matchOption("Under+90+min", runtime), "Under 90 min");
  assert.equal(matchOption("90-120 min", runtime), "90–120 min");
  assert.equal(matchOption("Over 150 min", runtime), "Over 150 min");
  assert.equal(matchOption("Top · william", ["Top · William"]), "Top · William");
  assert.equal(matchOption("5 stars", rating), null);
  assert.equal(matchOption("", rating), null);
  assert.equal(matchOption(undefined, rating), null);
});

test("every label of the menus survives the trip a browser would give it: encodeURIComponent, then parse, then match", () => {
  const ix = makeIndex();
  const labels = [...ix.moods.map((m) => m.label), ...ix.lists.map((l) => l.label), ...ix.friends.options.map((o) => o.label), ...ix.meta.countries, ...ix.meta.decades, "4.2+", "4.0–4.2", "Under 90 min", "90–120 min", "Top · Gustavo"];
  for (const label of labels) {
    for (const encoded of [encodeURIComponent(label), encodeURIComponent(label).replace(/%20/g, "+"), label]) {
      const got = parseExtras(`genre=${encoded}`).genre;
      assert.equal(matchOption(got, labels), label, `${label} sent as ${encoded}`);
    }
  }
});

// Marco, 22/10/2026 ~04:05 UTC: the Lists menus show each list's `short` (one line on the phone); the installs made before ask for the full `label`. Defect guarded: matching only one of the two
// (a menu of short names that the older installs, the Nuvio profiles and Fusion cannot open, or an old name that stops working the day the new menu ships).
test("matchList: a list is reached by its short name (the menu since 22/10/2026) and by its full name (every install made before); another case, a '+' for a space or a typed hyphen still find it; anything else is no list", () => {
  const lists = makeIndex().lists;
  const cannes = lists.find((l) => l.id === "cannes"), crit = lists.find((l) => l.id === "crit");
  assert.equal(cannes.short, "Cannes Winners");
  assert.equal(matchList("Cannes Winners", lists), cannes, "the short name");
  assert.equal(matchList("Cannes Winners (moviewithus)", lists), cannes, "the full name, as the older installs send it");
  assert.equal(matchList("Closet Picks · all-time", lists), crit);
  assert.equal(matchList("All-time Criterion Closet Picks (closetpicks)", lists), crit);
  assert.equal(matchList("cannes+winners", lists), cannes, "the words alone, as for every other menu");
  assert.equal(matchList("closet picks all time", lists), crit);
  assert.equal(matchList("Cannes", lists), undefined, "a prefix is not an option");
  assert.equal(matchList("Nowhere", lists), undefined);
  assert.equal(matchList("", lists), undefined);
  assert.equal(matchList(undefined, lists), undefined, "no genre at all: no list");
});

test("matchList and listMenu on an index from before the short names (no `short` anywhere): the menu is the full names and only they open a list; a list with a short and one without sit side by side", () => {
  const old = makeIndex().lists.map(({ short, ...l }) => l);
  assert.deepEqual(listMenu(old), old.map((l) => l.label));
  assert.equal(matchList("Cannes Winners (moviewithus)", old), old[0]);
  assert.equal(matchList("Cannes Winners", old), undefined, "the short name is unknown to an index that never had it");
  const mixed = [{ ...old[0], short: "Cannes Winners" }, old[1]];
  assert.deepEqual(listMenu(mixed), ["Cannes Winners", old[1].label]);
  assert.equal(matchList(old[1].label, mixed), old[1]);
  assert.equal(matchList("Cannes Winners", mixed), mixed[0]);
});
