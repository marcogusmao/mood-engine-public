// The Worker end to end: the handler with a fake network that serves the fixture, the headers, the status codes, the outage behaviour.

import test from "node:test";
import assert from "node:assert/strict";
import { createHandler, urlsOf, DEFAULT_INDEX_URL } from "../src/handler.js";
import { createStore } from "../src/store.js";
import { buildManifest, ADDON_ID, ADDON_VERSION } from "../src/manifest.js";
import { makeIndex, makeFiles, tweak } from "./fixture.js";

const DIR = "https://pages.test/mood-engine/data/";
const FULL = `${DIR}index.json`;
const ENV = { INDEX_URL: FULL };
const FILES = makeFiles();

/** `missing`: file names the "published site" does not have. calls: the file names asked for, in order. */
function rig({ missing = [], up = true } = {}) {
  const r = { calls: [], up };
  const fetchImpl = async (url) => {
    const name = url.slice(DIR.length);
    r.calls.push(name);
    if (!r.up) throw new Error("down");
    if (!missing.includes(name) && FILES[name]) return new Response(FILES[name]);
    return new Response("not found", { status: 404 });
  };
  const logs = [];
  r.logs = logs;
  r.handle = createHandler({ store: createStore({ fetchImpl, caches: undefined, log: (o) => logs.push(o) }) });
  r.get = async (path, init = {}, env = ENV) => {
    const res = await r.handle(new Request("https://mood-engine.example.workers.dev" + path, init), env, undefined);
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null };
  };
  return r;
}

test("manifest, no v2 family published (the fallback): this addon's id and name, version 3.1.0, one catalog per Board row, then My series, then Moods, Lists, Lists (unseen), Friends, Explore, Search; read from the small Board file after the v2 menus turned out to be missing", async () => {
  const r = rig();
  const m = await r.get("/manifest.json");
  assert.equal(m.status, 200);
  assert.equal(m.json.id, "com.mgusmao.moodengine.live");
  assert.equal(m.json.name, "Mood Engine");
  assert.equal(m.json.version, "3.1.0");
  assert.deepEqual(m.json.resources, ["catalog", { name: "subtitles", types: ["movie", "series"], idPrefixes: ["tt"] }]);
  assert.deepEqual(m.json.types, ["movie", "series"]);
  assert.deepEqual(m.json.catalogs.map((c) => c.id), ["tonight", "oldfriends", "my-series", "moods", "lists", "lists-unseen", "friends", "explore", "search"]);
  assert.deepEqual(r.calls, ["index-v2-menus.json", "index-board.json"], "the v2 menus first (3.3.0), missing here, then the small file: the manifest needs the menus only");
  assert.equal(ADDON_ID, m.json.id);
  assert.equal(ADDON_VERSION, "3.3.0", "the Worker is 3.3.0; the manifest says 3.1.0 only while the v2 family is missing (manifest.js LEGACY_MANIFEST_VERSION)");
});

test("manifest: Discover catalogs have a required genre with options, then the four optional menus with options, then skip; Explore has the four and no genre; Search needs `search`", async () => {
  const m = (await rig().get("/manifest.json")).json;
  const by = Object.fromEntries(m.catalogs.map((c) => [c.id, c]));
  const shape = (c) => c.extra.map((e) => `${e.name}${e.isRequired ? "*" : ""}${e.options ? `:${e.options.length}` : ""}`).join(" ");
  assert.equal(shape(by.moods), "genre*:2 decade:11 runtime:4 country:5 rating:4 skip");
  assert.equal(shape(by.lists), "genre*:2 decade:11 runtime:4 country:5 rating:4 skip");
  assert.equal(shape(by["lists-unseen"]), "genre*:2 decade:11 runtime:4 country:5 rating:4 skip");
  assert.equal(shape(by.friends), "genre*:2 decade:11 runtime:4 country:5 rating:4 skip");
  assert.equal(shape(by.explore), "genre*:1 decade:11 runtime:4 country:5 rating:4 skip", "Explore: a required 'Genre: All' keeps it off the Board; then the four menus");
  assert.equal(shape(by.search), "search* skip");
  assert.deepEqual(by.moods.extra[0].options, ["Nocturnal", "Uplift"]);
  assert.deepEqual(by.moods.extra[2].options, ["Under 90 min", "90–120 min", "120–150 min", "Over 150 min"]);
  assert.deepEqual(by.moods.extra[4].options, ["4.2+", "4.0–4.2", "3.8–4.0", "Under 3.8"]);
  assert.equal(by.moods.extra[1].options[0], "1920s");
  assert.deepEqual(by.tonight, { type: "movie", id: "tonight", name: "🎯 Tonight" }, "Board rows have no extras");
  for (const c of m.catalogs.filter((x) => x.extra)) for (const e of c.extra.filter((x) => x.options)) assert.equal(new Set(e.options).size, e.options.length, `${c.id}/${e.name}: options are unique`);
});

test("manifest: Explore stays out of the Board (Marco, 10/10/2026): by default it has a required genre 'All'; EXPLORE_ON_BOARD=true gives it only its four optional menus and Stremio then lists it on the Board as one more row, after My series", async () => {
  const onBoard = (c) => !(c.extra || []).some((e) => e.isRequired); // what the Board asks for: stremio-core AggrRequest::AllCatalogs, is_extra_supported(&[])
  const byDefault = (await rig().get("/manifest.json")).json.catalogs;
  assert.deepEqual(byDefault.filter(onBoard).map((c) => c.id), ["tonight", "oldfriends", "my-series"], "the Board is its rows and My series, and nothing else");
  assert.deepEqual(byDefault.find((c) => c.id === "explore").extra[0], { name: "genre", isRequired: true, options: ["All"] });
  assert.deepEqual(byDefault.find((c) => c.id === "explore").extra.slice(1).map((e) => e.name), ["decade", "runtime", "country", "rating", "skip"]);
  const asked = (await rig().get("/manifest.json", {}, { ...ENV, EXPLORE_ON_BOARD: "true" })).json.catalogs;
  assert.deepEqual(asked.filter(onBoard).map((c) => c.id), ["tonight", "oldfriends", "my-series", "explore"]);
  assert.deepEqual(asked.find((c) => c.id === "explore").extra.map((e) => e.name), ["decade", "runtime", "country", "rating", "skip"]);
  assert.deepEqual((await rig().get("/manifest.json", {}, { ...ENV, EXPLORE_ON_BOARD: "false" })).json.catalogs, byDefault);
  // and the Explore catalog with that genre answers like Explore without it
  const r = rig();
  const plain = (await r.get("/catalog/movie/explore/decade=1950s.json")).json.metas;
  const withAll = (await r.get("/catalog/movie/explore/decade=1950s&genre=All.json")).json.metas;
  assert.deepEqual(withAll, plain);
  assert.ok(plain.length > 0);
});

test("the rule in force is said in every answer: X-Floor reads 'from index' when the index has rules, 'from default' when it has none; the index's exempt names are the ones obeyed", async () => {
  const r = rig();
  assert.equal((await r.get("/catalog/movie/explore.json")).headers.get("x-floor"), "3.5 from default");
  assert.equal((await r.get("/manifest.json")).headers.get("x-floor"), "3.5 from default");
  const rules = { rule: "letterboxd-average-or-configured-friend", minStars: 3.5, exemptCatalogs: ["lists", "lists-unseen", "friends", "explore"] };
  const files = Object.fromEntries(Object.entries(FILES).map(([k, t]) => [k, tweak(t, (j) => { j.rules = rules; })]));
  const h = createHandler({ store: createStore({ fetchImpl: async (u) => (files[u.slice(DIR.length)] ? new Response(files[u.slice(DIR.length)]) : new Response("no", { status: 404 })), caches: undefined, log: () => {} }) });
  const get = (p) => h(new Request("https://w.test" + p), ENV);
  assert.equal((await get("/catalog/movie/explore.json")).headers.get("x-floor"), "3.5 from index");
  assert.equal((await get("/catalog/movie/moods/genre=Nocturnal.json")).headers.get("x-floor"), "3.5 from index");
  assert.equal((await get("/catalog/movie/tonight.json")).headers.get("x-floor"), "3.5 from index");
  const open = (await (await get("/catalog/movie/explore.json")).json()).metas.map((m) => m.name);
  assert.ok(open.includes("Just Below The Floor"), "this index exempts Explore, so the film that fails the rule is there");
  const moods = (await (await get("/catalog/movie/moods/genre=Nocturnal&decade=1970s.json")).json()).metas.map((m) => m.name);
  assert.ok(!moods.includes("Just Below The Floor"), "and Moods, which it does not exempt, still applies it");
});

test("manifest: a menu with no options is left out (a build with no lists or friends), because Stremio cannot show it", () => {
  const ix = makeIndex();
  const bare = { ...ix, lists: [], friends: { ...ix.friends, options: [] } };
  const ids = buildManifest(bare).catalogs.map((c) => c.id);
  assert.ok(!ids.includes("lists") && !ids.includes("lists-unseen") && !ids.includes("friends"));
  assert.ok(ids.includes("moods") && ids.includes("explore") && ids.includes("search"));
});

test("a catalog request: Stremio's headers (CORS *), Cache-Control 5 minutes, a metas list with the fields Stremio reads; the same films whichever order the menus arrive in", async () => {
  const r = rig();
  const a = await r.get("/catalog/movie/moods/decade=1990s&genre=Nocturnal.json");
  const b = await r.get("/catalog/movie/moods/genre=Nocturnal&decade=1990s.json");
  assert.equal(a.status, 200);
  assert.equal(a.headers.get("access-control-allow-origin"), "*");
  assert.equal(a.headers.get("cache-control"), "public, max-age=300");
  assert.match(a.headers.get("content-type"), /^application\/json/);
  assert.deepEqual(a.json.metas.map((m) => m.name), ["Wild at Heart", "Pulp Fiction", "Night on Earth"]);
  assert.equal(a.text, b.text, "byte for byte the same answer");
  const m = a.json.metas[1];
  assert.deepEqual(Object.keys(m).sort(), ["background", "description", "genres", "id", "links", "name", "poster", "posterShape", "releaseInfo", "runtime", "type"].filter((k) => k in m).sort());
  // Marco, 28/10/2026 (cards with chips, "T2"): the item carries `links`; this film has no IMDb rating and no trusted list, so its one chip is the mood
  assert.deepEqual(m.links, [{ category: "Mood", name: "Night drive", url: "stremio:///search?search=Nocturnal" }]);
  assert.deepEqual([m.id, m.type, m.name, m.releaseInfo, m.runtime, m.posterShape], ["tt0000010", "movie", "Pulp Fiction", "1994", "154 min", "poster"]);
  assert.equal(m.poster, "https://images.metahub.space/poster/medium/tt0000010/img");
  assert.equal(m.background, "https://images.metahub.space/background/medium/tt0000010/img", "the image behind the title (Marco, 14/11/2026): the film page's address for the same id, not the poster");
  assert.equal(a.json.cacheMaxAge, 300);
});

test("a film's description: the credits from the columns and the build's actors, then the film's own line 2 when it is no \"Mood:\" line (the mood is a chip since 28/10/2026); no reasons, no list place, no friends' words, no numbers line (Marco, 20/10/2026)", async () => {
  const r = rig();
  const crit = "genre=All-time%20Criterion%20Closet%20Picks%20(closetpicks)";
  const list = (await r.get(`/catalog/movie/lists/${crit}.json`)).json.metas.find((m) => m.name === "The Killing");
  assert.equal(list.description, "Stanley Kubrick · 1h25 · The Killing cast.\nThe Killing genres · The Killing keywords.\n\nA synopsis of The Killing.", "Lists: no mood and no place in the list (the old '#5'), the film's own genres and keywords");
  assert.equal(list.imdbRating, "8.4");
  assert.equal(list.genres.join(), "Crime,Thriller");
  const friends = (await r.get("/catalog/movie/friends/genre=Top%20%C2%B7%20Gustavo.json")).json.metas.find((m) => m.name === "The Killing");
  assert.equal(friends.description, list.description, "Friends: what the configured friends said is not in the description any more");
  const moods = (await r.get("/catalog/movie/moods/genre=Nocturnal.json")).json.metas.find((m) => m.name === "The Killing");
  // Marco, 28/10/2026: the phrase "Mood: …" is not written any more (the mood, the genres and the words are chips): the card is the credits, the separator and the synopsis
  assert.equal(moods.description, "Stanley Kubrick · 1h25 · The Killing cast.\n\nA synopsis of The Killing.", "Moods: no line 2 and no empty line twice");
  assert.deepEqual(moods.links.filter((l) => l.category === "Mood").map((l) => l.name).slice(0, 1), ["Night drive"], "Moods: the mood's name from index.moods, not its short label (the chip's search is made with the label)");
  const explore = (await r.get("/catalog/movie/explore.json")).json.metas.find((m) => m.name === "Rashomon");
  assert.equal(explore.description, "Akira Kurosawa · 1h28 · Rashomon cast.\nRashomon genres · Rashomon keywords.\n\nA synopsis of Rashomon.", "Explore is no row: the build's general text under the credits line, no country, year or ★");
  assert.equal(explore.poster, "https://pages.test/posters/tt0000006.jpg", "the cover with the ratings drawn on it, when the build made one");
  assert.equal((await r.get("/catalog/movie/explore.json")).json.metas.find((m) => m.name === "Pierrot le Fou").poster, "https://images.metahub.space/poster/medium/tt0000005/img", "else the poster service of the static addon");
  const amelie = (await r.get("/catalog/movie/explore.json")).json.metas.find((m) => m.name === "Amélie");
  assert.ok(!/Letterboxd|IMDb|want to see|★/.test(amelie.description), "no numbers and no stars");
  const none = (await r.get("/catalog/movie/explore.json")).json.metas.find((m) => m.name === "Reservoir Dogs");
  assert.equal(none.description.split("\n")[0], "Quentin Tarantino · 1h39 · Reservoir Dogs cast.");
  for (const m of [list, friends, moods, explore, amelie, none]) assert.ok(m.description.split("\n\n")[0].split("\n").every((l) => l.endsWith(".")), `every line of the card ends with a full stop: ${m.name}`);
});

test("Board rows keep their own text (the build's rowDesc: the actors, then line 2 finished; a 'Mood: …' line is not written since 28/10/2026, the credits stay), under the credits line", async () => {
  const r = rig();
  const tonight = (await r.get("/catalog/movie/tonight.json")).json.metas;
  // Marco, 28/10/2026: the row's own "Mood: …" line is not written any more; the credits stay, the mood is a chip
  assert.equal(tonight[0].description, "Stanley Kubrick · 1h25 · The Killing cast.");
  assert.equal(tonight[1].description, "Jean-Pierre Jeunet · 2h02 · Amélie cast.");
  const old = (await r.get("/catalog/movie/oldfriends.json")).json.metas;
  assert.ok(old.every((m) => !m.description.includes("Mood:")), "Old friends is no mood");
});

// Review of 21/10/2026 (guard-worker-prosa): the title said "Mood: … nowhere else", the rule of 20/10/2026. Since D3 (21/10/2026) Lists, Friends, Explore and Search keep the film's own best-fit label (the next-but-one test); what is still true is that the
// MOODS MENU's own mood is put only in the Moods menu. This fixture's general texts carry no best-fit label, so the loop below asserts the menu's mood does not leak, and the labelled texts are the next-but-one test.
test("The Moods menu's mood is a chip of its films (the phrase is gone since 28/10/2026) and the chip does not appear on a film that does not fit it in Lists, Friends, Explore or Search; compose() still puts the phrase only when the catalog is a mood", async () => {
  const r = rig();
  const fits = new Map(makeIndex().films.map((e) => [e.tt, e.mood("night")])); // tt -> [fit, rank] of the fixture's film in the mood, or undefined
  // Marco, 28/10/2026: the mood of the menu is not a phrase in the card any more; it is the first chip of every film of the menu that fits it best, and no card says "Mood:"
  for (const m of (await r.get("/catalog/movie/moods/genre=Nocturnal.json")).json.metas) {
    assert.ok(!m.description.includes("Mood:"), `${m.name}: ${m.description}`);
    assert.equal(m.links.find((l) => l.category === "Mood").name, "Night drive", m.name);
  }
  for (const url of ["/catalog/movie/lists/genre=Cannes%20Winners%20(moviewithus).json", "/catalog/movie/lists-unseen/genre=Cannes%20Winners%20(moviewithus).json", "/catalog/movie/lists/genre=Cannes%20Winners.json", "/catalog/movie/lists-unseen/genre=Closet%20Picks%20%C2%B7%20all-time.json", "/catalog/movie/friends/genre=Top%20%C2%B7%20Gustavo.json", "/catalog/movie/explore.json", "/catalog/movie/search/search=the.json"]) {
    const metas = (await r.get(url)).json.metas;
    // Marco, 28/10/2026: the card has no phrase to leak; what can leak is the CHIP. Told by its search URL (the label "Nocturnal"), the Moods menu's mood is on a card of another catalog only for a film that fits it itself
    for (const m of metas) {
      assert.ok(!m.description.includes("Mood:"), `${url}: ${m.name}: ${m.description}`);
      const chip = (m.links || []).some((l) => l.category === "Mood" && l.url === "stremio:///search?search=Nocturnal");
      assert.equal(chip, fits.get(m.id) !== undefined, `${url}: ${m.name}: the Night drive chip is ${chip ? "there" : "missing"} and the film ${fits.get(m.id) ? "fits" : "does not fit"} the mood`);
    }
  }
  const { compose } = await import("../src/meta.js");
  const film = { tt: "tt0000006", director: "Akira Kurosawa", runtime: 88 };
  const mood = { kind: "moods", name: "🌃 Night drive" };
  assert.equal(compose(film, mood, "A One\nCrime · heist.\n\nSyn."), "Akira Kurosawa · 1h28 · A One.\nMood: 🌃 Night drive · Crime · heist.\n\nSyn.");
  assert.equal(compose(film, mood, "A One\n\nSyn."), "Akira Kurosawa · 1h28 · A One.\nMood: 🌃 Night drive.\n\nSyn.", "a film with no genre and no keyword: the mood alone");
  assert.equal(compose(film, mood, "A One\nMood: ☀️ Lift me out · Crime.\n\nSyn."), "Akira Kurosawa · 1h28 · A One.\nMood: 🌃 Night drive · Crime.\n\nSyn.", "a text that already says its best-fit mood: the Moods menu's mood takes its place, once (D3, 21/10/2026; until then a text that said its mood kept it)");
  assert.equal(compose(film, { kind: "list", list: { id: "c", label: "Cannes" } }, "A One\nCrime · heist.\n\nSyn."), "Akira Kurosawa · 1h28 · A One.\nCrime · heist.\n\nSyn.", "a list is no mood");
  assert.equal(compose(film, { kind: "friends", name: "Top · Gustavo" }, "A One\nCrime · heist.\n\nSyn."), "Akira Kurosawa · 1h28 · A One.\nCrime · heist.\n\nSyn.", "a friends' option is no mood");
  assert.equal(compose(film, {}, ""), "Akira Kurosawa · 1h28.", "an entry with no text of its own: its credits");
});

// Marco, 21/10/2026 ~15:00 UTC (D3): a film's general text carries "Mood: <the mood the film fits best>" and every catalog that is no mood shows it; the Moods menu puts its own mood in its place. D5: the genre that IS the name of the leading mood is left out.
test("the mood a film fits best leads line 2 in every catalog that is no mood (Lists, Friends, Explore, Search); the Moods menu puts its own mood in its place; a genre that is the leading mood's name is left out", async () => {
  const { compose } = await import("../src/meta.js");
  const film = { tt: "tt0000008", director: "Akira Kurosawa", runtime: 88, genres: ["Comedy", "Drama"] };
  const text = "A One\nMood: 😂 Comedy · Drama · Dark comedy, Satire, Grief, Loss.\n\nSyn.";
  const credits = "Akira Kurosawa · 1h28 · A One.";
  for (const context of [{ kind: "list", list: { id: "c", label: "Cannes" } }, { kind: "friends", name: "Top · Gustavo" }, { kind: "explore" }, { kind: "search" }, {}])
    assert.equal(compose(film, context, text), `${credits}\nMood: 😂 Comedy · Drama · Dark comedy, Satire, Grief.\n\nSyn.`, `${context.kind}: the best fit, three words`);
  assert.equal(compose(film, { kind: "moods", name: "🌃 Night drive" }, text), `${credits}\nMood: 🌃 Night drive · Comedy, Drama · Dark comedy, Satire, Grief.\n\nSyn.`, "another menu: its mood in place of the best fit; the genre the best fit had hidden is back");
  assert.equal(compose(film, { kind: "moods", name: "😂 Comedy" }, text), `${credits}\nMood: 😂 Comedy · Drama · Dark comedy, Satire, Grief.\n\nSyn.`, "the Comedy menu: the same line, said once");
  assert.equal(compose(film, { kind: "moods", name: "🎃 Horror" }, "A One\nMood: 😂 Comedy · Drama · Horror, Satire, Grief, Loss.\n\nSyn."), `${credits}\nMood: 🎃 Horror · Comedy, Drama · Satire, Grief, Loss.\n\nSyn.`, "the word that is the menu's mood goes, the spare fourth takes its place");
  assert.equal(compose({ ...film, genres: ["Comedy"] }, {}, "A One\nMood: 😂 Comedy · Satire.\n\nSyn."), `${credits}\nMood: 😂 Comedy · Satire.\n\nSyn.`, "the only genre is the mood's name: it is not said twice");
  assert.equal(compose(film, {}, "A One\nMood: 😂 Comedy · Planted genres · Satire.\n\nSyn."), `${credits}\nMood: 😂 Comedy · Planted genres · Satire.\n\nSyn.`, "a line whose genres are not the entry's is left as it is");
  assert.equal(compose(film, {}, "A One\nCrime, Drama · Satire.\n\nSyn."), `${credits}\nCrime, Drama · Satire.\n\nSyn.`, "a film that fits no mood has no label");
  assert.equal(compose(film, { kind: "moods", name: "🌃 Night drive" }, "A One\nComedy, Drama · Satire.\n\nSyn."), `${credits}\nMood: 🌃 Night drive · Comedy, Drama · Satire.\n\nSyn.`, "and the Moods menu gives it one");
});

// Regression guard of the review's finding 2 (Marco, 20/10/2026): in the Noir menu the word "noir" repeats the mood; the live `desc` keeps four words so that the Worker can drop it and still show three.
test("the Moods menu drops the word that IS its mood and shows three; every other catalog shows the first three of the four the build kept", async () => {
  const { compose, rewords } = await import("../src/meta.js");
  const film = { tt: "tt0000006", director: "Akira Kurosawa", runtime: 88, genres: ["Crime", "Drama"] };
  const text = "A One\nCrime, Drama · Noir, Anxious, Tense, Dark.\n\nSyn.";
  assert.equal(compose(film, { kind: "moods", name: "🌃 Noir" }, text), "Akira Kurosawa · 1h28 · A One.\nMood: 🌃 Noir · Crime, Drama · Anxious, Tense, Dark.\n\nSyn.", "the Noir menu: no Noir among the words, the fourth word fills the place");
  assert.equal(compose(film, { kind: "moods", name: "🌃 Night drive" }, text), "Akira Kurosawa · 1h28 · A One.\nMood: 🌃 Night drive · Crime, Drama · Noir, Anxious, Tense.\n\nSyn.", "another menu keeps it");
  assert.equal(compose(film, { kind: "list", list: { id: "c", label: "Cannes" } }, text), "Akira Kurosawa · 1h28 · A One.\nCrime, Drama · Noir, Anxious, Tense.\n\nSyn.", "no mood: the first three");
  assert.equal(compose({ ...film, genres: undefined }, { kind: "moods", name: "🌃 Noir" }, "A One\nNoir, Anxious, Tense, Dark.\n\nSyn."), "Akira Kurosawa · 1h28 · A One.\nMood: 🌃 Noir · Anxious, Tense, Dark.\n\nSyn.", "a film with no genre: the line is the words");
  assert.equal(rewords("Mood: 🌃 Noir · Crime · Noir.", film, "🌃 Noir"), "Mood: 🌃 Noir · Crime · Noir.", "a Board row's finished line is left as it is");
  assert.equal(rewords("Loved by Lynch · Crime, Drama · Noir, Anxious.", film, ""), "Loved by Lynch · Crime, Drama · Noir, Anxious.", "so is a reason row's");
  assert.equal(rewords("genres of the row.", { genres: [] }, ""), "genres of the row.");
});

// Regression guard of the review of the description v3, 21/10/2026: a stored line 2 may repeat a genre among its words ("Drama, Romance · Romance, …": the mood Swoon has the word "romance"); the Worker leaves it out, whichever index it reads.
test("a word that is one of the genres shown on the line is not shown, and the next word takes its place; a genre beyond the third is not on the line", async () => {
  const { compose, rewords } = await import("../src/meta.js");
  const film = { tt: "tt0000007", director: "Kelly Reichardt", runtime: 100, genres: ["Drama", "Romance"] };
  assert.equal(compose(film, {}, "A One\nDrama, Romance · Romance, Mother daughter relationship, Tender, Sad.\n\nSyn."), "Kelly Reichardt · 1h40 · A One.\nDrama, Romance · Mother daughter relationship, Tender, Sad.\n\nSyn.");
  assert.equal(compose(film, { kind: "moods", name: "💘 Swoon" }, "A One\nDrama, Romance · Romance, Tender.\n\nSyn."), "Kelly Reichardt · 1h40 · A One.\nMood: 💘 Swoon · Drama, Romance · Tender.\n\nSyn.");
  assert.equal(rewords("Drama, Romance · Romance.", film, ""), "Drama, Romance.", "nothing left: the genres alone");
  assert.equal(rewords("Drama, Comedy, War · Romance, Tender.", { genres: ["Drama", "Comedy", "War", "Romance"] }, ""), "Drama, Comedy, War · Romance, Tender.", "the fourth genre is not on the line");
});

// Regression guard of the 80-character cut in the Worker (Marco, 20/10/2026): the cut is made on the finished line, the full stop counted. 21/10/2026 ~15:00 UTC (D4): only the THIRD actor goes, two stay.
test("the credits line is cut to 80 characters AFTER it is built, in the Worker as in the build: three actors, then two; two stay whatever the length", async () => {
  const { compose, creditsLine } = await import("../src/meta.js");
  const film = { tt: "tt0000006", director: "Apichatpong Weerasethakul", runtime: 114 };
  assert.equal(compose(film, {}, "Thanapat Saisaymar; Jenjira Pongpas; Sakda Kaewbuadee\nDrama.\n\nSyn."), "Apichatpong Weerasethakul · 1h54 · Thanapat Saisaymar, Jenjira Pongpas.\nDrama.\n\nSyn.");
  const two = { ...film, director: "Rainer Werner Fassbinder, Alexander Kluge", runtime: 187 };
  assert.equal(compose(two, {}, "Hanna Schygulla Eleonore; Irm Hermann Maria Louise; Margit Carstensen Leopoldine\n\nSyn."), "Rainer Werner Fassbinder, Alexander Kluge · 3h07 · Hanna Schygulla Eleonore, Irm Hermann Maria Louise.\n\nSyn.", "two actors stay whatever the length (D4)");
  assert.equal(compose(two, {}, "Hanna Schygulla Eleonore\n\nSyn."), "Rainer Werner Fassbinder, Alexander Kluge · 3h07 · Hanna Schygulla Eleonore.\n\nSyn.", "a cast of one is one actor");
  assert.equal(creditsLine({ directors: ["Akira Kurosawa"], runtime: 142, cast: ["A".repeat(10), "B".repeat(10), "C".repeat(31)] }).length, 80, "exactly 80 is kept");
  assert.equal(creditsLine({ directors: ["Akira Kurosawa"], runtime: 142, cast: ["A".repeat(10), "B".repeat(10), "C".repeat(32)] }).split(", ").length, 2, "81 loses the third");
});

test("every credits line of every catalog page the index serves is at most 80 characters unless it holds two actors or fewer", async () => {
  const r = rig();
  for (const url of ["/catalog/movie/explore.json", "/catalog/movie/explore/rating=4.0%E2%80%934.2.json", "/catalog/movie/explore/rating=4.3%2B.json", "/catalog/movie/moods/genre=Nocturnal.json"]) {
    for (const m of (await r.get(url)).json.metas) {
      const first = m.description.split("\n")[0];
      assert.ok(first.length <= 80 || first.split(" · ").pop().split(", ").length <= 2, `${url}: ${m.name}: ${first.length}`);
    }
  }
});

test("each request reads the smallest file that has its films: Board and manifest the Board part, Moods and Friends their pieces, a list its own piece; only Explore and Search read the whole index (and only they pay for parsing it)", async () => {
  const r = rig();
  await r.get("/catalog/movie/tonight.json");
  await r.get("/manifest.json");
  assert.deepEqual(r.calls, ["index-v2-menus.json", "index-board.json"], "the v2 menus are asked once, found missing, and not asked again for a while (store.js RETRY_EMPTY_MS)");
  await r.get("/catalog/movie/moods/genre=Nocturnal.json");
  await r.get("/catalog/movie/moods/genre=Uplift&decade=2000s.json");
  assert.deepEqual(r.calls, ["index-v2-menus.json", "index-board.json", "index-moods.json"], "each file once");
  await r.get("/catalog/movie/friends/genre=Top%20%C2%B7%20Gustavo.json");
  await r.get("/catalog/movie/lists/genre=Cannes%20Winners%20(moviewithus).json");
  await r.get("/catalog/movie/lists-unseen/genre=All-time%20Criterion%20Closet%20Picks%20(closetpicks).json");
  assert.deepEqual(r.calls, ["index-v2-menus.json", "index-board.json", "index-moods.json", "index-friends.json", "index-list-cannes.json", "index-list-crit.json"]);
  await r.get("/catalog/movie/explore.json");
  await r.get("/catalog/movie/search/search=kubrick.json");
  assert.deepEqual(r.calls.slice(6), ["index-v2.json", "index.json"], "the whole v2 index is tried (missing here), then the whole legacy index, once");
});

// Marco, 22/10/2026 ~04:05 UTC. Defect guarded: the manifest listing the full names (two to three lines on the phone, overlapping), or only the short ones when the index has none yet (a menu of undefined).
test("manifest: the Lists and Lists (unseen) menus offer each list's short name; an index published before the short names offers the full names; nothing else in the manifest moves", () => {
  const ix = makeIndex();
  const old = { ...ix, lists: ix.lists.map(({ short, ...l }) => l) };
  const [now, before] = [buildManifest(ix), buildManifest(old)];
  const menu = (m, id) => m.catalogs.find((c) => c.id === id).extra.find((e) => e.name === "genre").options;
  for (const id of ["lists", "lists-unseen"]) {
    assert.deepEqual(menu(now, id), ["Cannes Winners", "Closet Picks · all-time"], id);
    assert.deepEqual(menu(before, id), ["Cannes Winners (moviewithus)", "All-time Criterion Closet Picks (closetpicks)"], `${id}: the index of before`);
  }
  const strip = (m) => JSON.stringify({ ...m, catalogs: m.catalogs.filter((c) => c.id !== "lists" && c.id !== "lists-unseen") });
  assert.equal(strip(now), strip(before), "every other catalog, and the rest of the manifest, is the same bytes");
});

// Marco, 22/10/2026 ~04:05 UTC. Defects guarded: indexFor() (handler.js) matching the full name only, so a short-name request reads the menus (no films) and answers an empty page; the answer
// to a short name differing from the answer to the full name by a byte; the unknown value changing from the empty page it has always been.
test("Lists by the short name of the menu or by the full name of the older installs: the same list piece is read, the same bytes come back, in Lists and in Lists (unseen); an unknown name is the empty page it was", async () => {
  for (const id of ["lists", "lists-unseen"]) for (const [short, full, piece] of [["Cannes%20Winners", "Cannes%20Winners%20(moviewithus)", "index-list-cannes.json"], ["Closet%20Picks%20%C2%B7%20all-time", "All-time%20Criterion%20Closet%20Picks%20(closetpicks)", "index-list-crit.json"]]) {
    const a = rig(), b = rig();
    const [byShort, byFull] = [await a.get(`/catalog/movie/${id}/genre=${short}.json`), await b.get(`/catalog/movie/${id}/genre=${full}.json`)];
    assert.ok(byShort.json.metas.length > 0, `${id} ${short}`);
    assert.equal(byShort.text, byFull.text, `${id} ${short}: the same bytes as the full name`);
    assert.ok(a.calls.includes(piece), `${id} ${short}: reads ${piece}, not only the menus (${a.calls.join(", ")})`);
    assert.deepEqual(a.calls, b.calls, `${id} ${short}: the same files are read`);
  }
  const r = rig();
  const nobody = await r.get("/catalog/movie/lists/genre=Nobody%20Made%20This.json");
  assert.deepEqual([nobody.status, nobody.json.metas], [200, []]);
  assert.equal((await r.get("/catalog/movie/lists/genre=Cannes.json")).json.metas.length, 0, "a prefix of the name is no list");
});

test("the pieces answer exactly as the whole index would: every Discover catalog, with and without menus, through the pieces and through the whole index alone", async () => {
  const pieces = rig(), whole = rig({ missing: ["index-board.json", "index-moods.json", "index-friends.json", "index-list-cannes.json", "index-list-crit.json"] });
  const urls = [
    "/catalog/movie/moods/genre=Nocturnal.json", "/catalog/movie/moods/decade=1990s&genre=Nocturnal.json", "/catalog/movie/moods/genre=Uplift.json",
    "/catalog/movie/lists/genre=Cannes%20Winners%20(moviewithus).json", "/catalog/movie/lists-unseen/genre=Cannes%20Winners%20(moviewithus).json", "/catalog/movie/lists/genre=All-time%20Criterion%20Closet%20Picks%20(closetpicks)&country=Japan.json",
    "/catalog/movie/friends/genre=Top%20%C2%B7%20Gustavo.json", "/catalog/movie/friends/genre=Watch%20together%20%C2%B7%20William.json", "/catalog/movie/friends/genre=Watch%20together%20%C2%B7%20William&decade=1960s.json",
    "/catalog/movie/tonight.json", "/catalog/movie/oldfriends.json", "/catalog/movie/explore.json", "/catalog/movie/search/search=kubrick.json",
  ];
  for (const u of urls) {
    const [a, b] = [await pieces.get(u), await whole.get(u)];
    assert.ok(a.json.metas.length > 0, u);
    assert.equal(a.text, b.text, u);
  }
  assert.ok(!pieces.calls.slice(0, 1).includes("index.json"));
  assert.ok(whole.calls.includes("index.json"));
});

test("Board rows: a seen film in a row is not served, and Old friends serves its seen films", async () => {
  const r = rig();
  assert.deepEqual((await r.get("/catalog/movie/tonight.json")).json.metas.map((m) => m.name), ["The Killing", "Amélie", "Just Below The Floor"]);
  assert.deepEqual((await r.get("/catalog/movie/oldfriends.json")).json.metas.map((m) => m.name), ["Old Friend You Saw"]);
});

test("if a piece is missing, the whole index stands in for it, and the missing piece is not asked for on every request", async () => {
  const r = rig({ missing: ["index-board.json", "index-moods.json"] });
  assert.equal((await r.get("/manifest.json")).json.catalogs.length, 9);
  assert.deepEqual((await r.get("/catalog/movie/tonight.json")).json.metas.map((m) => m.name), ["The Killing", "Amélie", "Just Below The Floor"]);
  assert.deepEqual((await r.get("/catalog/movie/moods/genre=Uplift.json")).json.metas.map((m) => m.name), ["Amélie"]);
  assert.deepEqual(r.calls, ["index-v2-menus.json", "index-board.json", "index.json", "index-moods.json"], "one try each, then the whole index from memory");
});

test("a list that does not exist is an empty page without reading any list piece", async () => {
  const r = rig();
  const got = await r.get("/catalog/movie/lists/genre=No%20Such%20List.json");
  assert.deepEqual([got.status, got.json.metas], [200, []]);
  assert.deepEqual(r.calls, ["index-board.json"], "(a list is never a v2 catalog: the v2 menus are not even asked)");
});

test("search and skip through the handler: `search=` is a menu like any other, with the plus sign as a space", async () => {
  const r = rig();
  assert.deepEqual((await r.get("/catalog/movie/search/search=the+killing.json")).json.metas.map((m) => m.name), ["The Killing", "The Killing of a Sacred Deer"]);
  assert.deepEqual((await r.get("/catalog/movie/search/search=the%20killing&skip=1.json")).json.metas.map((m) => m.name), ["The Killing of a Sacred Deer"]);
  assert.deepEqual((await r.get("/catalog/movie/search/skip=0&search=am%C3%A9lie.json")).json.metas.map((m) => m.name), ["Amélie"]);
});

test("unknown things: another type answers an empty list, an unknown catalog is a 404, an unknown path is a 404, POST is refused, OPTIONS answers the CORS preflight, HEAD has no body", async () => {
  const r = rig();
  const series = await r.get("/catalog/series/tonight.json");
  assert.deepEqual([series.status, series.json.metas], [200, []]);
  const ghost = await r.get("/catalog/movie/ghost.json");
  assert.equal(ghost.status, 404);
  assert.equal((await r.get("/nothing")).status, 404);
  assert.equal((await r.get("/catalog/movie/tonight.json", { method: "POST" })).status, 405);
  const pre = await r.get("/catalog/movie/tonight.json", { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  const head = await r.get("/manifest.json", { method: "HEAD" });
  assert.deepEqual([head.status, head.text], [200, ""]);
});

test("the index is down and nothing is cached: catalogs answer 200 with an empty list and a short cache time (and the failure is logged); the manifest answers 503", async () => {
  const r = rig({ up: false });
  const c = await r.get("/catalog/movie/explore.json");
  assert.equal(c.status, 200);
  assert.deepEqual(c.json.metas, []);
  assert.equal(c.headers.get("cache-control"), "public, max-age=30", "an empty page caused by an outage must not be remembered");
  assert.equal(c.headers.get("x-index-source"), "none");
  assert.ok(r.logs.some((l) => l.event === "index-unavailable"));
  const t = await r.get("/catalog/movie/tonight.json");
  assert.deepEqual(t.json.metas, []);
  const m = await r.get("/manifest.json");
  assert.equal(m.status, 503);
  assert.match(m.json.err, /not available/);
});

test("debug headers say where the answer came from and how old it is; they carry nothing but what the public index carries", async () => {
  const r = rig();
  const a = await r.get("/catalog/movie/explore.json");
  assert.deepEqual([a.headers.get("x-index-source"), a.headers.get("x-index-built-at"), a.headers.get("x-total")], ["network", "2026-10-10T12:00:00.000Z", String(makeIndex().films.filter((f) => !f.seen && f.eligible).length)]);
  const b = await r.get("/catalog/movie/explore.json");
  assert.equal(b.headers.get("x-index-source"), "memory");
});

test("the home page names the install link; settings: the default index URL and the small file's address", async () => {
  const r = rig();
  const home = await r.get("/");
  assert.equal(home.status, 200);
  assert.match(home.text, /stremio:\/\/mood-engine\.example\.workers\.dev\/manifest\.json/);
  const u = urlsOf({});
  assert.deepEqual([u.full, u.board, u.moods, u.friends, u.list("f6ZGq")], [DEFAULT_INDEX_URL, "https://marcogusmao.github.io/mood-engine/data/index-board.json", "https://marcogusmao.github.io/mood-engine/data/index-moods.json", "https://marcogusmao.github.io/mood-engine/data/index-friends.json", "https://marcogusmao.github.io/mood-engine/data/index-list-f6ZGq.json"]);
  assert.equal(urlsOf({ INDEX_URL: "http://127.0.0.1:7000/data/index.json" }).board, "http://127.0.0.1:7000/data/index-board.json");
});

test("the entry point exports the fetch handler and the bound Durable Object class, no ordinary values", async () => {
  const entry = await import("../src/index.js");
  assert.deepEqual(Object.keys(entry), ["WillState", "default"]);
  assert.equal(typeof entry.WillState, "function");
  assert.equal(typeof entry.default.fetch, "function");
});

// ── security headers and hostile input (W1, 13/10/2026) ──────────────────────

test("every answer that goes out through send() says X-Content-Type-Options: nosniff — a catalog (JSON), the home page (HTML), a profile's page and the private address's (W1a, 13/10/2026: removing the header from respond() left every other test green)", async () => {
  const TOK = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const env = { ...ENV, SUBTITLES_PRIVATE_TOKEN: TOK };
  for (const [what, path, type] of [["a catalog", "/catalog/movie/tonight.json", /json/], ["the home page", "/", /html/], ["a profile's page", "/p/night/", /html/], ["the private address's home page", `/k/${TOK}/`, /html/], ["a 404", "/nothing", /json/]]) {
    const res = await rig().get(path, {}, env);
    assert.match(res.headers.get("content-type"), type, what);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", what);
  }
});

test("X-Build (W8, 19/10/2026): every answer that goes out through send() carries X-Build with the GIT_SHA variable when it is set — a catalog, the home page, a 404, a 405, the private address's — and none carries the header when it is not set or is empty; text with a line break or non-ASCII is cut to printable ASCII and never makes the answer a 500", async () => {
  const TOK = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const withSha = { ...ENV, SUBTITLES_PRIVATE_TOKEN: TOK, GIT_SHA: "abc1234" };
  const without = { ...ENV, SUBTITLES_PRIVATE_TOKEN: TOK };
  for (const [what, path, init] of [["a catalog", "/catalog/movie/tonight.json", {}], ["the home page", "/", {}], ["a 404", "/nothing", {}], ["a 405", "/manifest.json", { method: "POST" }], ["the private address's home page", `/k/${TOK}/`, {}], ["a 404 on the private address", "/k/not-the-token-0000/manifest.json", {}]]) {
    const on = await rig().get(path, init, withSha);
    assert.equal(on.headers.get("x-build"), "abc1234", `${what}: the build is told`);
    for (const env of [without, { ...without, GIT_SHA: "" }, { ...without, GIT_SHA: undefined }]) {
      const off = await rig().get(path, init, env);
      assert.equal(off.headers.get("x-build"), null, `${what}: no GIT_SHA, no header`);
      assert.equal(off.status, on.status, `${what}: the status does not depend on it`);
    }
  }
  const odd = await rig().get("/catalog/movie/tonight.json", {}, { ...ENV, GIT_SHA: "abçd\n12" });
  assert.deepEqual([odd.status, odd.headers.get("x-build")], [200, "abd12"], "printable ASCII only");
});

test("the home page escapes the host it repeats, as a profile's page does (W1b, 13/10/2026: it interpolated url.host raw; a host with a quote broke out of the href). The URL parser refuses < and > in a host, so the quote, the ampersand and the apostrophe stand for them", async () => {
  const handle = createHandler({ store: createStore({ fetchImpl: async () => new Response("nf", { status: 404 }), caches: undefined, log: () => {} }) });
  const res = await handle(new Request(`https://a"b&c'd.test/`), ENV);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!/a"b|b&c|c'd/.test(html), "none of the host's raw characters reaches the page");
  assert.equal(html.split("a&#34;b&#38;c&#39;d.test").length - 1, 3, "the host, escaped, in the link twice and in the pasted address once");
  assert.ok(!html.includes('href="stremio://a"'), "the quote did not close the href");
  const plain = (await rig().get("/")).text;
  assert.match(plain, /href="stremio:\/\/mood-engine\.example\.workers\.dev\/manifest\.json"/, "an ordinary host is unchanged");
});

test("an unknown catalog is a 404 with a fixed body: it does not repeat the id that was asked for (W1c, 13/10/2026: the body said `unknown catalog <id>`)", async () => {
  const res = await rig().get("/catalog/movie/zz-probe-9f3.json");
  assert.equal(res.status, 404);
  assert.deepEqual(res.json, { err: "unknown catalog" });
  assert.ok(!res.text.includes("zz-probe-9f3"));
  assert.equal(res.headers.get("access-control-allow-origin"), "*", "the headers are the ones it had");
  assert.equal(res.headers.get("x-index-source"), "network");
});

test("the card of a description is always two lines before the separator, so a film with no actors and no line 2 is not read as a card of its synopsis: compose() builds the credits from the columns and the synopsis comes after the separator", async () => {
  const { compose } = await import("../src/meta.js");
  const film = { tt: "tt0000006", director: "Akira Kurosawa", countries: ["Japan"], year: 1950, runtime: 88, lbRating: 4.3 };
  const credits = "Akira Kurosawa · 1h28.";
  assert.equal(compose(film, {}, "\n\n\nSyn."), `${credits}\n\nSyn.`, "no actors, no line 2: the card is one break, then the separator");
  assert.equal(compose(film, { separator: " — " }, "\n — Syn."), `${credits} — Syn.`);
  assert.equal(compose(film, {}, "Cast\n\n\nSyn."), "Akira Kurosawa · 1h28 · Cast.\n\nSyn.", "an actor and no line 2");
  assert.equal(compose(film, {}, "\nCrime.\n\nSyn."), `${credits}\nCrime.\n\nSyn.`, "a line 2 and no actor");
  assert.equal(compose(film, {}, ""), credits);
  // the line breaks of the separator itself never end the card early
  const noCard = compose({ ...film, director: undefined, countries: undefined, year: undefined, runtime: undefined, lbRating: undefined }, {}, "\n\n\nSyn.");
  assert.equal(noCard, "Syn.", "a film with no credits and no line 2: nothing to put on a card, so the synopsis alone (the Worker has read the card as empty, not the synopsis as a card)");
});
