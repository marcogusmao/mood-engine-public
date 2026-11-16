// The chips of a catalog card (Marco, 28/10/2026, "T2"): the side preview of the Discover shows the CATALOG ITEM, and draws its `links`.
// An item carries: imdb (the core ignores `imdbRating` and `genres` of an item that has links), the Mood group (moods, genres, terms: the film page's rules, mood-group.js) and the Lists group (up to three);
// no Ratings group and no Letterboxd average; the phrase "Mood: …" is not in the description. Written 28/10/2026 together with src/mood-group.js and the `menus` of toMeta.

import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../src/handler.js";
import { createStore } from "../src/store.js";
import { toMeta, cardTerms, cardLinks } from "../src/meta.js";
import { moodGroup, genreLink, searchLink } from "../src/mood-group.js";
import { readyOf, makeObject } from "./fixture.js";
import { search } from "../src/search.js";
import { files as profileFiles } from "./profile-fixture.js";

// An index with the moods of the fixture and real list ids: nVqt6 is a fan list (no chip), the others are critic lists (poxvK, eEESu, snFyM, tp03m); the index's order is the order of the chips.
const LISTS = [["nVqt6", "A fan list"], ["poxvK", "Horror list"], ["eEESu", "Canon list"], ["snFyM", "Closet list"], ["tp03m", "Closet most picked"]].map(([id, label]) => ({ id, label, popular: false, films: 1 }));
function make(film = {}, { moodMenu = true } = {}) {
  const o = makeObject();
  o.lists = LISTS;
  if (moodMenu) o.moodMenu = [{ id: "night", label: "Nocturnal" }, { id: "lift", label: "Uplift" }];
  o.films = o.films.map((f) => (f.tt === "tt0000001" ? {
    ...f, imdbRating: 8.4, genres: ["Crime", "Thriller"], moods: { lift: [0.9, 9], night: [1.2, 3] }, // the order of the chips is the FIT (1.2, 0.9), not the rank (3, 9): the two orders differ here on purpose
    lists: { nVqt6: 1, tp03m: 2, snFyM: 3, eEESu: 4, poxvK: 5 },
    desc: "Sterling Hayden; Coleen Gray\nMood: 🌃 Night drive · Crime, Thriller · Heist, Caper, Noir, Extra.\n\nA synopsis of The Killing.", ...film } : f));
  const ix = readyOf(o);
  return { ix, e: ix.films.find((f) => f.tt === "tt0000001") };
}
const names = (m, category) => m.links.filter((l) => l.category === category).map((l) => l.name);

test("a card with chips: imdb, then the Mood group, then Lists, in that order; no Ratings; imdbRating and genres stay on the item", () => {
  const { ix, e } = make();
  const m = toMeta(e, { menus: ix, separator: "\n\n" });
  assert.deepEqual([...new Set(m.links.map((l) => l.category))], ["imdb", "Mood", "Lists"]);
  assert.deepEqual(m.links[0], { category: "imdb", name: "8.4", url: "https://imdb.com/title/tt0000001" }, "without it the core ignores imdbRating and the \"8.4 IMDb\" of the preview goes");
  assert.equal(m.imdbRating, "8.4", "Nuvio and Fusion read this field");
  assert.deepEqual(m.genres, ["Crime", "Thriller"], "and this one");
  assert.ok(!m.links.some((l) => l.category === "Ratings") && !JSON.stringify(m.links).includes("Letterboxd"), "T2, no grade: no Ratings group and no Letterboxd average");
  // moods by fit (night 1.2, lift 0.9), then the genres, then the first three terms of line 2 of the film's text
  assert.deepEqual(names(m, "Mood"), ["Night drive", "Lift me out", "Crime", "Thriller", "Heist", "Caper", "Noir"]);
  assert.equal(m.links.find((l) => l.name === "Night drive").url, searchLink("Nocturnal"), "a mood is searched by its menu label");
  assert.equal(m.links.find((l) => l.name === "Crime").url, genreLink("Crime"));
  assert.equal(m.links.find((l) => l.name === "Heist").url, searchLink("Heist"));
  // the critic lists in the index's order, three at most; the fan list has no chip
  assert.deepEqual(names(m, "Lists"), ["Horror list", "Canon list", "Closet list"]);
  assert.equal(m.links.find((l) => l.name === "Horror list").url, searchLink("Horror list"));
});

test("the description of a card with chips has no \"Mood: …\" line and no empty line twice; a reason line stays; without chips (no menus) the card is as it was", () => {
  const { ix, e } = make();
  const sep = { separator: "\n\n" };
  assert.equal(toMeta(e, { menus: ix, ...sep }).description, "Stanley Kubrick · 1h25 · Sterling Hayden, Coleen Gray.\n\nA synopsis of The Killing.");
  const dash = new Map([[e.tt, "Sterling Hayden; Coleen Gray\nMood: 🌃 Night drive · Crime, Thriller · Heist. — A synopsis of The Killing."]]);
  assert.equal(toMeta(e, { menus: ix, descs: dash, separator: " — " }).description, "Stanley Kubrick · 1h25 · Sterling Hayden, Coleen Gray. — A synopsis of The Killing.", "the separator is the one of the index, once");
  assert.ok(!/\n\n\n/.test(toMeta(e, { menus: ix, ...sep }).description));
  // a reason row (Loved by …, Cannes Palme d'Or …): the reason is the row's own text, not the mood phrase
  const reason = new Map([[e.tt, "Sterling Hayden; Coleen Gray\nLoved by Lynch and Scorsese · Crime, Thriller · Heist.\n\nA synopsis of The Killing."]]);
  assert.equal(toMeta(e, { menus: ix, descs: reason, ...sep }).description, "Stanley Kubrick · 1h25 · Sterling Hayden, Coleen Gray.\nLoved by Lynch and Scorsese · Crime, Thriller · Heist.\n\nA synopsis of The Killing.");
  // a Moods menu and a profile's Tonight put THEIR mood in the phrase of the old card: with chips it is not written either
  assert.ok(!toMeta(e, { menus: ix, kind: "moods", name: "🌃 Night drive", ...sep }).description.includes("Mood:"));
  assert.ok(!toMeta(e, { menus: ix, drawn: new Map([[e.tt, "Neon and tension"]]), ...sep }).description.includes("Mood:"));
  // no menus: the old card, byte for byte (compose() is shared with the static-addon parity tests)
  const old = toMeta(e, sep);
  assert.equal(old.links, undefined);
  assert.equal(old.description.split("\n")[1], "Mood: 🌃 Night drive · Crime, Thriller · Heist, Caper, Noir.");
});

test("a card without a mood, a genre, a word, a grade or a list has no `links` at all; a film with only an IMDb grade has the imdb link alone", () => {
  const { ix, e } = make({ moods: undefined, lists: undefined, genres: undefined, imdbRating: undefined, desc: "A; B\n\nSyn." });
  const m = toMeta(e, { menus: ix, separator: "\n\n" });
  assert.ok(!("links" in m), JSON.stringify(m.links));
  assert.equal(m.description, "Stanley Kubrick · 1h25 · A, B.\n\nSyn.");
  const one = make({ moods: undefined, lists: undefined, genres: undefined, desc: "A; B\n\nSyn." });
  assert.deepEqual(toMeta(one.e, { menus: one.ix, separator: "\n\n" }).links.map((l) => l.category), ["imdb"]);
});

test("the terms are the words of line 2 of the film's text, after the mood and the genres; a line that does not read that way gives none", () => {
  const { e } = make();
  const sep = "\n\n";
  assert.deepEqual(cardTerms(e, "A\nMood: 🌃 Night drive · Crime, Thriller · Heist, Caper, Noir, Extra.\n\nS", sep), ["Heist", "Caper", "Noir", "Extra"]);
  assert.deepEqual(cardTerms(e, "A\nCrime, Thriller · Heist.\n\nS", sep), ["Heist"], "a film that fits no mood: no label");
  assert.deepEqual(cardTerms(e, "A\nMood: 🌃 Night drive · Crime, Thriller.\n\nS", sep), [], "genres and no words");
  assert.deepEqual(cardTerms(e, "A\nMood: 🌃 Night drive · Something else · Heist.\n\nS", sep), [], "not the film's genres: not a line this function can read");
  assert.deepEqual(cardTerms(e, "A\nLoved by Lynch · Crime, Thriller · Heist.\n\nS", sep), [], "a reason leads: not the film's general text");
  assert.deepEqual(cardTerms(e, "A\n\nS", sep), []);
  assert.deepEqual(cardTerms(e, "", sep), []);
  assert.deepEqual(cardTerms({ genres: undefined }, "A\nNoir, Anxious.\n\nS", sep), ["Noir", "Anxious"], "no genres: the line is the words");
});

test("an index with no moodMenu (the legacy files) uses its moods; a mood the menus do not know, or a list without a label, is left out and the card is still served", () => {
  const { ix, e } = make({}, { moodMenu: false });
  assert.deepEqual(names(toMeta(e, { menus: ix, separator: "\n\n" }), "Mood").slice(0, 2), ["Night drive", "Lift me out"]);
  const odd = { ...ix, moods: ix.moods.filter((m) => m.id !== "lift"), lists: ix.lists.map((l) => (l.id === "poxvK" ? { ...l, label: "" } : l)) };
  const m = toMeta(e, { menus: odd, separator: "\n\n" });
  assert.deepEqual(names(m, "Mood").slice(0, 2), ["Night drive", "Crime"], "lift is not in the index's moods: no chip, no failure");
  assert.deepEqual(names(m, "Lists"), ["Canon list", "Closet list", "Closet most picked"], "a list with no label is skipped and the next one takes the place");
});

// Lists short names on the chips, 28/10/2026 (the chips said the full name with the handle of the author, though the menu already said the short one).
test("a card's Lists chip says the list's short name and searches it, the full name where the list has no short name; either one opens the list", () => {
  const { ix, e } = make();
  const withShort = { ...ix, lists: ix.lists.map((l) => (l.id === "poxvK" ? { ...l, label: "Horror list (somehandle)", short: "Scary" } : l.id === "eEESu" ? { ...l, short: "" } : l)) };
  const m = toMeta(e, { menus: withShort, separator: "\n\n" });
  assert.deepEqual(names(m, "Lists"), ["Scary", "Canon list", "Closet list"], "poxvK: the short name; eEESu: an empty short is no short, the label");
  assert.equal(m.links.find((l) => l.category === "Lists").url, searchLink("Scary"));
  const chip = m.links.find((l) => l.name === "Scary");
  const byShort = search(withShort, new URL(chip.url).searchParams.get("search")).map((f) => f.tt);
  assert.ok(byShort.length > 0, "the chip opens a list that has films");
  assert.deepEqual(byShort, search(withShort, "Horror list (somehandle)").map((f) => f.tt), "the short name and the full name reach the same films");
});

// Review of 28/10/2026 (a255f80): the same collision on the cards (Marco, 28/10/2026 ~22:25 UTC): a short that is a mood's word is said by the chip but searched by the full name.
test("a card's Lists chip whose short name is a mood's word says the short and searches the full name; the search for the word stays the mood's", () => {
  const { ix, e } = make();
  const clash = { ...ix, lists: ix.lists.map((l) => (l.id === "poxvK" ? { ...l, label: "Nocturnal (somehandle)", short: "Nocturnal" } : l)) };
  const m = toMeta(e, { menus: clash, separator: "\n\n" });
  const chip = m.links.find((l) => l.category === "Lists");
  assert.equal(chip.name, "Nocturnal"); assert.equal(chip.url, searchLink("Nocturnal (somehandle)"));
  const plainIx = { ...ix, lists: ix.lists.map((l) => (l.id === "poxvK" ? { ...l, label: "Nocturnal (somehandle)" } : l)) };
  assert.deepEqual(search(clash, "Nocturnal").map((f) => f.tt), search(plainIx, "Nocturnal").map((f) => f.tt), "the word is searched as before the short names");
  assert.ok(search(clash, "Nocturnal (somehandle)").length > 0, "the full name opens the list");
  const drama = { ...ix, lists: ix.lists.map((l) => (l.id === "poxvK" ? { ...l, label: "Drama picks (somehandle)", short: "Drama" } : l)) };
  assert.equal(toMeta(e, { menus: drama, separator: "\n\n" }).links.find((l) => l.category === "Lists").url, searchLink("Drama picks (somehandle)"), "a genre's name is not a list's search either");
  const menuOnly = { ...ix, moodMenu: [...ix.moodMenu, { id: "zenith", label: "Zenith" }], lists: ix.lists.map((l) => (l.id === "poxvK" ? { ...l, label: "Zenith (somehandle)", short: "Zenith" } : l)) };
  assert.equal(toMeta(e, { menus: menuOnly, separator: "\n\n" }).links.find((l) => l.category === "Lists").url, searchLink("Zenith (somehandle)"), "a mood of the Moods menu that the index's own moods do not list (the legacy files hold nine) counts too");
});

test("a profile says its own name for a mood on the chip, and the search still goes by the menu's label; which moods show is judged on the build's name", () => {
  const { ix, e } = make();
  const relabel = new Map([["🌃 Night drive", "Neon and tension"]]);
  const m = toMeta(e, { menus: ix, relabel, separator: "\n\n" });
  assert.deepEqual(names(m, "Mood").slice(0, 2), ["Neon and tension", "Lift me out"], "lift is not a mood of the profile: the build's name, without the emoji");
  assert.equal(m.links.find((l) => l.name === "Neon and tension").url, searchLink("Nocturnal"));
  // a mood the build names like a genre yields to the genre chip, in the profile too (the profile's name does not change who yields)
  const horror = { ...ix, moods: [...ix.moods, { id: "wicked", label: "Wicked", name: "🎃 Horror" }], moodMenu: [...ix.moodMenu, { id: "wicked", label: "Wicked" }] };
  const g = make({ genres: ["Horror", "Drama"], moods: { wicked: [2, 1], night: [1, 1] } }).e;
  assert.deepEqual(names(toMeta(g, { menus: horror, relabel: new Map([["🎃 Horror", "Art-house horror"]]), separator: "\n\n" }), "Mood").slice(0, 3), ["Night drive", "Horror", "Drama"]);
});

test("a profile's Tonight: the mood the pick was drawn for is the FIRST chip, once; if the film fits it as well it is not repeated; a draw that yields to a genre of the same name leaves the genre chip", () => {
  const { ix, e } = make();
  const first = (drawnMood, relabel) => names(toMeta(e, { menus: ix, relabel, drawnMood: new Map([[e.tt, drawnMood]]), separator: "\n\n" }), "Mood");
  assert.deepEqual(first("lift").slice(0, 3), ["Lift me out", "Night drive", "Crime"], "lift fits less than night, and goes first because it was drawn");
  assert.deepEqual(first("night").slice(0, 2), ["Night drive", "Lift me out"], "night was first already: not repeated");
  assert.equal(new Set(first("lift")).size, first("lift").length);
  assert.equal(first("lift", new Map([["☀️ Lift me out", "Warm and funny"]]))[0], "Warm and funny", "in the profile's name for it");
  // another film's draw does not touch this one; an id the menus do not know is ignored
  assert.deepEqual(names(toMeta(e, { menus: ix, drawnMood: new Map([["tt9", "lift"]]), separator: "\n\n" }), "Mood").slice(0, 2), ["Night drive", "Lift me out"]);
  assert.deepEqual(first("nobody").slice(0, 2), ["Night drive", "Lift me out"]);
  // the drawn mood fits the film at all? Not needed: the draw takes it from the film's mood ranking, but a fit missing from the column still shows
  const none = make({ moods: { night: [1.2, 3] } });
  assert.deepEqual(names(toMeta(none.e, { menus: none.ix, drawnMood: new Map([[none.e.tt, "lift"]]), separator: "\n\n" }), "Mood").slice(0, 2), ["Lift me out", "Night drive"]);
});

test("moodGroup(): the lead mood takes one of the four places; the film page's own call (no lead) is unchanged", () => {
  const byId = new Map(["a", "b", "c", "d", "e"].map((id) => [id, { id, name: `😀 Mood ${id}` }]));
  const menu = new Map(["a", "b", "c", "d", "e"].map((id, order) => [id, { label: id, order }]));
  const film = { mo: [["a", 5], ["b", 4], ["c", 3], ["d", 2], ["e", 1]] };
  assert.deepEqual(moodGroup(film, byId, menu).map((l) => l.name), ["Mood a", "Mood b", "Mood c", "Mood d"]);
  assert.deepEqual(moodGroup(film, byId, menu, undefined, "e").map((l) => l.name), ["Mood e", "Mood a", "Mood b", "Mood c"], "the fifth fit comes first and pushes the fourth out: four moods in all");
  assert.deepEqual(moodGroup(film, byId, menu, undefined, "c").map((l) => l.name), ["Mood c", "Mood a", "Mood b", "Mood d"], "a lead that was among the fits is not repeated");
});

// ── through the handler ──────────────────────────────────────────────────────────────────────────────

const DIR = "https://pages.test/mood-engine/data/";
function rig(f = profileFiles()) {
  const fetchImpl = async (url) => { const name = url.slice(DIR.length); return f[name] ? new Response(f[name]) : new Response("not found", { status: 404 }); };
  const subtitles = { list: async () => ({ subs: [] }), exact: async () => ({ status: "none", ids: new Set() }) };
  const handle = createHandler({ store: createStore({ fetchImpl, caches: undefined, log: () => {} }), subtitles, now: () => Date.parse("2026-10-11T23:00:00Z") });
  return async (path) => { const res = await handle(new Request("https://mood-engine.example.workers.dev" + path), { INDEX_URL: `${DIR}index.json` }, undefined); return res.json(); };
}

test("through the handler, in a profile: the Lists group is the critic lists of the film in the index's order, at most three, searched by their label; the cards of a profile row carry no Mood phrase", async () => {
  const get = rig();
  const metas = (await get("/p/night/catalog/movie/theme-horror.json")).metas;
  const both = metas.find((m) => m.name === "Horror Both Lists");
  assert.ok(both, "the film in two Horror lists");
  // poxvK, dCcac and snFyM are critic lists of the fixture's index (in that order there); the labels are the index's own
  assert.deepEqual(names(both, "Lists"), ["Old label of poxvK", "Old label of dCcac", "Old label of snFyM"]);
  assert.equal(both.links.find((l) => l.category === "Lists").url, searchLink("Old label of poxvK"));
  for (const m of metas) assert.ok(!m.description.includes("Mood:"), m.name);
  // a film in a fan list only (Noir Film is in jMnm) carries no Lists chip
  const noir = (await get("/p/night/catalog/movie/theme-noir-night.json")).metas.find((m) => m.name === "Noir Film");
  assert.ok(noir && !(noir.links || []).some((l) => l.category === "Lists"), "jMnm is a fan list");
});

test("through the handler, the Marco profile's Board row: cards with links have only the three groups and no phrase; the ones with nothing to show have no `links` key", async () => {
  const get = rig();
  const metas = (await get("/p/marco/catalog/movie/tonight.json")).metas;
  assert.ok(metas.length > 0 && metas.some((m) => m.links));
  for (const m of metas) {
    assert.ok(!m.links || m.links.every((l) => ["imdb", "Mood", "Lists"].includes(l.category)), m.name);
    assert.ok(!m.description.includes("Mood:"), m.name);
  }
});

// ── "MUBI:" synopses (Marco, 28/10/2026, 20:26 UTC, questionnaire) ───────────────────────────────────────────────
// Many synopses of the index start "MUBI: …". The blank line that separates the credits from the synopsis turns into one space on the Mac and the web ("Watanabe. MUBI: Meaty action…"), so the card puts a long dash in front:
// "Watanabe. — MUBI: Meaty action…" there, a paragraph that starts "— MUBI:" on Nuvio and the TV. Regression guard, 28/10/2026: without the dash the credits and "MUBI:" ran together on the Mac.

test("a synopsis that starts \"MUBI:\" gets a long dash after the separator, once; any other synopsis (also one that mentions MUBI later, or already starts with the dash) is left as it is", () => {
  const sep = { separator: "\n\n" };
  const credits = "Stanley Kubrick · 1h25 · Sterling Hayden, Coleen Gray.";
  const cards = (synopsis) => ({ desc: `Sterling Hayden; Coleen Gray\nMood: 🌃 Night drive · Crime, Thriller · Heist.\n\n${synopsis}` });
  for (const withMenus of [false, true]) { // the old card (no menus: the static addon's twin) and the card with chips
    const run = (synopsis) => { const { ix, e } = make(cards(synopsis)); return toMeta(e, withMenus ? { menus: ix, ...sep } : sep).description; };
    const tail = (d) => d.slice(d.indexOf("\n\n"));
    assert.equal(tail(run("MUBI: Meaty action.")), "\n\n\u2014 MUBI: Meaty action.", "dash in front of the synopsis");
    assert.equal(tail(run("A synopsis.")), "\n\nA synopsis.", "no MUBI: nothing changes");
    assert.equal(tail(run("A synopsis. MUBI: later.")), "\n\nA synopsis. MUBI: later.", "MUBI: inside the text is no reason for a dash");
    assert.equal(tail(run("mubi: lower case.")), "\n\nmubi: lower case.");
    assert.equal(tail(run("\u2014 MUBI: already there.")), "\n\n\u2014 MUBI: already there.", "a desc that already starts with the dash gets no second one");
    assert.equal(tail(run("MUBI Our Take.")), "\n\nMUBI Our Take.", "only the \"MUBI:\" prefix with the colon");
  }
  const { ix, e } = make(cards("MUBI: Meaty action."));
  assert.equal(toMeta(e, { menus: ix, ...sep }).description, `${credits}\n\n\u2014 MUBI: Meaty action.`, "the card with chips: credits, separator, dash, synopsis");
  // the card of a Board row (a descs entry, the row's own text) goes through the same place
  const row = new Map([[e.tt, "Sterling Hayden; Coleen Gray\nLoved by Lynch and Scorsese · Crime, Thriller · Heist.\n\nMUBI: Meaty action."]]);
  assert.equal(toMeta(e, { menus: ix, descs: row, ...sep }).description, `${credits}\nLoved by Lynch and Scorsese · Crime, Thriller · Heist.\n\n\u2014 MUBI: Meaty action.`);
});

test("with nothing before the synopsis (no director, no runtime, no actors, no line 2) the dash has nothing to separate and is not written", () => {
  const bare = (desc) => toMeta({ tt: "tt0000001", name: "Bare", director: "", desc }, { separator: "\n\n" }).description;
  assert.equal(bare("\n\nMUBI: Alone."), "MUBI: Alone.");
  assert.equal(bare("\nA line two.\n\nMUBI: Alone."), "A line two.\n\n\u2014 MUBI: Alone.", "a line before it, the dash comes back");
});

test("through the handler: a synopsis that starts \"MUBI:\" has the dash in a profile row and in the Discover, and a synopsis that does not is unchanged", async () => {
  const f = profileFiles((o) => {
    for (const x of o.films) {
      if (x.name === "Noir Film") x.desc = `${x.name} cast\n${x.name} genres.\n\nMUBI: Meaty action of ${x.name}.`;
      if (x.name === "Horror Both Lists") x.desc = `${x.name} cast\n${x.name} genres.\n\n\u2014 MUBI: dashed already.`;
    }
  });
  const get = rig(f);
  const noir = (await get("/p/night/catalog/movie/theme-noir-night.json")).metas.find((m) => m.name === "Noir Film");
  assert.ok(noir.description.endsWith("\n\n\u2014 MUBI: Meaty action of Noir Film."), noir.description);
  assert.ok(!noir.description.includes("\u2014 \u2014"));
  // the Discover (the Lists menu and the Explore catalog of the main address; a profile has no Discover, so none under /p/): the same dash, through the same compose()
  for (const url of ["/catalog/movie/lists/genre=Old%20label%20of%20jMnm.json", "/catalog/movie/explore.json"]) {
    const found = (await get(url)).metas.find((m) => m.name === "Noir Film");
    assert.ok(found, `${url}: Noir Film is served`);
    assert.ok(found.description.endsWith("\n\n\u2014 MUBI: Meaty action of Noir Film."), `${url}: ${found.description}`);
  }
  const horror = (await get("/p/night/catalog/movie/theme-horror.json")).metas;
  assert.ok(horror.find((m) => m.name === "Horror Both Lists").description.endsWith("\n\n\u2014 MUBI: dashed already."));
  for (const m of horror.filter((x) => x.name !== "Horror Both Lists")) assert.ok(m.description.endsWith(`\n\nSynopsis of ${m.name}.`), `${m.name} is unchanged: ${m.description}`);
});
