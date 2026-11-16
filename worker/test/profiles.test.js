// The six profiles (src/profiles.js; Marco, 11/10/2026), end to end through the handler, on a small index made by hand with real list ids
// from the name table. Also: the old address is left exactly as it was, and the name table is the one the stremio repo approved.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { createHandler } from "../src/handler.js";
import { createStore } from "../src/store.js";
import { PROFILES, MOOD_NAMES, VOUCH, WHAT, tonight, tonightPicks, dayOf, relabelOf } from "../src/profiles.js";
import { compose } from "../src/meta.js";
import { LIST_NAMES, GROUPS, THEMES, byName } from "../src/list-names.js";
import { hydrate } from "../src/film.js";
import { makeFiles } from "./fixture.js";
import { MOODS, LISTS, FILMS, tt, fitsAny, makeObject, files } from "./profile-fixture.js"; // the index of these tests: moved to its own file on 14/10/2026 (test/profile-parity.test.js reads it too)

const require = createRequire(import.meta.url);
const rows = require("../../lib/index-rows.js");
const exporter = require("../../lib/index-export.js");

const DIR = "https://pages.test/mood-engine/data/";
const ENV = { INDEX_URL: `${DIR}index.json` };
const OCT = Date.parse("2026-10-11T23:00:00Z");
function rig({ files: f = files(), now = () => OCT } = {}) {
  const calls = [];
  const fetchImpl = async (url) => { const name = url.slice(DIR.length); calls.push(name); return f[name] ? new Response(f[name]) : new Response("not found", { status: 404 }); };
  const subtitles = { list: async () => ({ subs: [] }), exact: async () => ({ status: "none", ids: new Set() }) };
  const handle = createHandler({ store: createStore({ fetchImpl, caches: undefined, log: () => {} }), subtitles, now });
  const get = async (path) => {
    const res = await handle(new Request("https://mood-engine.example.workers.dev" + path), ENV, undefined);
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null, text };
  };
  return { get, calls };
}
const ids = (r) => r.json.metas.map((m) => m.id);

// ── the six manifests ─────────────────────────────────────────────────────────

/** Decision 9 (the profiles' Board), in order. */
const BOARDS = {
  light: ["tonight", "lift", "escape", "music", "theme-comedy-comfort", "theme-action-heist", "short", "watchlist"],
  heavy: ["tonight", "letin", "reinvent", "theme-heavy-drama", "theme-romance", "short", "watchlist"],
  night: ["tonight", "night", "wicked", "theme-noir-night", "theme-horror", "theme-halloween", "short", "watchlist"],
  world: ["tonight", "wander", "slow", "theme-asian-cinema", "theme-brazilian-cinema", "directors", "watchlist"],
  critics: ["directors-loved", "directors", "theme-all-time-canon", "theme-21st-century", "theme-1970s", "theme-1980s-90s", "theme-classic-hollywood", "closet-most-picked", "closet-all-picks"],
};

test("six manifests: 200, each its own id and a name of at most 20 characters, version 3.2.1 (3.2.0 until 24/10/2026), the Board of decision 9 then Who vouches, What it is and Search", async () => {
  const r = rig();
  const seen = new Set();
  for (const key of PROFILES.keys()) {
    const m = await r.get(`/p/${key}/manifest.json`);
    assert.equal(m.status, 200, key);
    assert.equal(m.headers.get("X-Profile"), key);
    assert.equal(m.json.id, `com.mgusmao.moodengine.live.${key}`);
    assert.ok(!seen.has(m.json.id), `${key}: id repeated`);
    seen.add(m.json.id);
    assert.equal(m.json.version, "3.2.1");
    assert.equal(m.json.name, PROFILES.get(key).name);
    assert.ok(m.json.name.length <= 20, `${key}: "${m.json.name}" is over 20 characters`);
    if (key === "marco") continue;
    const cats = m.json.catalogs.map((c) => c.id);
    // the fixture's lists cover Critics, Institutions and Letterboxd & community, and the themes Horror, Halloween, Noir & night, All-time canon
    assert.deepEqual(cats, [...BOARDS[key], "vouch-critics", "vouch-institutions", "vouch-letterboxd-community", "what-it-is", "search"], key);
    for (const c of m.json.catalogs.slice(0, BOARDS[key].length)) assert.ok(!c.extra || !c.extra.some((e) => e.isRequired), `${key}/${c.id}: a Board row has no required menu`);
    for (const c of m.json.catalogs.slice(BOARDS[key].length)) assert.ok(c.extra.some((e) => e.isRequired), `${key}/${c.id}: Discover only`);
  }
  assert.equal(seen.size, 6);
});

test("NuvioTV: every catalog with a required menu says showInHome: false (it would be an empty Home row there), no Board row does; asked with no menu, Who vouches and What it is answer their first option", async () => {
  const r = rig();
  for (const key of PROFILES.keys()) {
    const m = await r.get(`/p/${key}/manifest.json`);
    for (const c of m.json.catalogs) assert.equal(c.showInHome === false, !!(c.extra || []).some((e) => e.isRequired), `${key}/${c.id}`);
  }
  const old = await r.get("/manifest.json");
  assert.ok(old.json.catalogs.every((c) => !("showInHome" in c)), "the old address is unchanged");
  const first = (await r.get("/p/heavy/manifest.json")).json.catalogs.find((c) => c.id === "vouch-institutions").extra[0].options[0];
  assert.deepEqual(ids(await r.get("/p/heavy/catalog/movie/vouch-institutions.json")), ids(await r.get(`/p/heavy/catalog/movie/vouch-institutions/genre=${encodeURIComponent(first)}.json`)));
  assert.deepEqual(ids(await r.get("/p/heavy/catalog/movie/what-it-is.json")), ids(await r.get("/p/heavy/catalog/movie/what-it-is/genre=All-time%20canon.json")));
  assert.ok(ids(await r.get("/p/heavy/catalog/movie/what-it-is.json")).length > 0);
  assert.deepEqual(ids(await r.get("/p/heavy/catalog/movie/what-it-is/genre=.json")), [], "an empty value is not a missing one");
});

test("the mood rows carry the dry names of decision 10 in every profile, Marco included; no Board row name has an emoji", async () => {
  const r = rig();
  for (const key of PROFILES.keys()) {
    const m = await r.get(`/p/${key}/manifest.json`);
    for (const c of m.json.catalogs) if (MOOD_NAMES[c.id]) assert.equal(c.name, MOOD_NAMES[c.id], `${key}/${c.id}`);
    for (const c of m.json.catalogs) assert.doesNotMatch(c.name, /\p{Extended_Pictographic}/u, `${key}/${c.id}`);
  }
});

test("an unknown profile is refused with a 404, never served as Marco", async () => {
  const r = rig();
  for (const p of ["/p/nobody/manifest.json", "/p/Marco/manifest.json", "/p/__proto__/manifest.json", "/p/constructor/catalog/movie/tonight.json", "/p//manifest.json", "/p", "/p/"]) {
    const res = await r.get(p);
    assert.equal(res.status, 404, p);
    assert.equal(res.json.err, "unknown profile", p);
  }
});

test("a profile serves only what its manifest declares: another profile's row, the old catalogs under a mood profile, My series outside Marco are 404", async () => {
  const r = rig();
  for (const p of ["/p/night/catalog/series/tonight.json", "/p/marco/catalog/series/tonight.json", "/p/night/catalog/movie/lift.json", "/p/light/catalog/movie/theme-horror.json", "/p/night/catalog/movie/moods/genre=Nocturnal.json", "/p/night/catalog/movie/explore/genre=All.json", "/p/night/catalog/series/my-series.json", "/p/critics/catalog/movie/tonight.json", "/p/night/catalog/movie/fromlists.json"])
    assert.equal((await r.get(p)).status, 404, p);
  const series = await r.get("/p/marco/catalog/series/my-series.json");
  assert.equal(series.status, 200);
  assert.equal(series.json.metas.length, 85);
});

// ── the old address ──────────────────────────────────────────────────────────

test("the old address: /manifest.json is exactly the manifest of 8226964 (fixtures/legacy-manifest.json, made by that commit's code)", async () => {
  const before = JSON.parse(fs.readFileSync(new URL("./fixtures/legacy-manifest.json", import.meta.url), "utf8"));
  const res = await createHandler({ store: createStore({ fetchImpl: async (u) => { const f = makeFiles()[u.slice(DIR.length)]; return f ? new Response(f) : new Response("nf", { status: 404 }); }, caches: undefined, log: () => {} }) })(new Request("https://x.test/manifest.json"), ENV);
  assert.deepEqual(await res.json(), before);
});

test("the Marco profile: the old Board and Discover with the moods renamed, Who vouches and What it is before Explore; its old catalogs answer as at the old address", async () => {
  const r = rig();
  const old = await r.get("/manifest.json");
  const m = await r.get("/p/marco/manifest.json");
  const board = new Set([...old.json.catalogs.filter((c) => !(c.extra || []).length).map((c) => c.id)]);
  const strip = (cs) => cs.filter((c) => !c.id.startsWith("vouch-") && c.id !== WHAT.id).map(({ showInHome, ...c }) => ({ ...c, name: board.has(c.id) ? "·" : c.name })); // showInHome: NuvioTV, its own test; Board names: below
  assert.deepEqual(strip(m.json.catalogs), strip(old.json.catalogs));
  // every Board row of the Marco profile under a dry name (Marco, 11/10/2026): the moods by decision 10, the rest by BOARD_NAMES; Discover names as they were
  const name = (id) => m.json.catalogs.find((c) => c.id === id).name;
  assert.equal(name("tonight"), "Tonight");
  assert.equal(name("watchlist"), "Watchlist");
  assert.equal(name("my-series"), "My series");
  assert.equal(name("short"), "Short and good");
  assert.equal(name("a-later-row"), "A later row");
  assert.equal(name("night"), "Neon and tension");
  for (const c of m.json.catalogs) if (board.has(c.id)) assert.doesNotMatch(c.name, /\p{Extended_Pictographic}/u, c.id);
  assert.equal(name("moods"), "Mood Engine · Moods");
  const cats = m.json.catalogs.map((c) => c.id);
  assert.ok(cats.indexOf("what-it-is") < cats.indexOf("explore") && cats.indexOf("vouch-critics") > cats.indexOf("director-picks"));
  for (const p of ["catalog/movie/tonight.json", "catalog/movie/night.json", "catalog/movie/moods/genre=Nocturnal.json", "catalog/movie/lists/genre=Old%20label%20of%20poxvK.json", "catalog/movie/explore/genre=All&skip=3.json"])
    assert.deepEqual((await r.get(`/p/marco/${p}`)).json, (await r.get(`/${p}`)).json, p);
});

// ── Tonight, Watchlist, Under 100 min: only the profile's moods ──────────────

test("Tonight in Night and horror: six films, all from Neon and tension or Art-house horror, the two moods taking turns, none seen, none under the floor, none twice", async () => {
  const r = rig();
  const t = await r.get("/p/night/catalog/movie/tonight.json");
  assert.equal(t.status, 200);
  const got = ids(t);
  assert.equal(got.length, 6);
  assert.equal(new Set(got).size, 6);
  for (const id of got) assert.ok(fitsAny(["night", "wicked"])(id), `${id} is not a Night drive or Something wicked film`);
  assert.ok(!got.includes(tt("Seen Night Top")) && !got.includes(tt("Below Floor Night")));
  const moodOf = (id) => (FILMS.find((f) => f.tt === id).moods.night ? "night" : "wicked");
  assert.deepEqual([...new Set(got.map(moodOf))].sort(), ["night", "wicked"]);
  assert.equal(got.filter((id) => moodOf(id) === "night").length, 3, "three turns each");
  // the same day gives the same six; extras, a page or another menu value never bring in another mood
  assert.deepEqual(ids(await r.get("/p/night/catalog/movie/tonight.json")), got);
  assert.deepEqual(ids(await r.get("/p/night/catalog/movie/tonight/genre=Uplift.json")), got);
});

test("Tonight: each pick comes from the top 12 of its mood; it rotates by the day in São Paulo; fewer than six when the moods run out", () => {
  const ix = hydrate(JSON.parse(files()["index.json"]));
  const pool = ix.films.filter((e) => !e.seen && e.eligible);
  // the mood's order (best mood rank first); the window is the top 12 of what is NOT taken yet (this Worker's rule, src/profiles.js TONIGHT_TOP), so pick k (from 0) is in the top 12 + k
  const order = pool.filter((e) => e.mood("night")).sort((a, b) => b.mood("night")[1] - a.mood("night")[1]).map((e) => e.tt);
  const draws = new Set();
  for (let d = 1; d <= 20; d++) {
    const day = `2026-10-${String(d).padStart(2, "0")}`;
    const picks = tonight(pool, ["night"], { day, seedKey: "night" });
    assert.equal(picks.length, 6);
    picks.forEach((p, k) => assert.ok(order.indexOf(p.tt) < 12 + k, `${day}: pick ${k}, ${p.name}, is at ${order.indexOf(p.tt)} in the mood`));
    draws.add(picks.map((p) => p.tt).join());
  }
  assert.ok(draws.size > 10, "the draw changes from day to day");
  // the order of the moods is drawn each day: over 30 days each of the two leads at least 5 times
  const leads = { night: 0, wicked: 0 };
  for (let d = 1; d <= 30; d++) { const first = tonight(pool, ["night", "wicked"], { day: `2026-11-${String(d).padStart(2, "0")}` })[0]; leads[first.mood("night") ? "night" : "wicked"]++; }
  assert.ok(leads.night >= 5 && leads.wicked >= 5, JSON.stringify(leads));
  // the draw is EVEN over the top 12 (Marco, 19/10/2026, questionnaire; PR #47; was rand ** 1.6, a lean to the very top): over 200 days the first pick is one of the mood's best 3 about 3 times in 12 (25%)
  const firstAt = Array(12).fill(0);
  for (let d = 0; d < 200; d++) { const first = tonight(pool, ["night"], { day: `day-${d}` })[0]; firstAt[order.indexOf(first.tt)]++; }
  const top3 = firstAt[0] + firstAt[1] + firstAt[2];
  assert.ok(top3 > 30 && top3 < 70, `${top3} of 200 in the top 3`); // uniform: ~50 (sd ~6); the 1.6 lean: ~84 (79 here)
  assert.ok(firstAt[0] < 33, `${firstAt[0]} of 200 days the best film is the first pick`); // uniform: ~17 (21 in this fixture); the 1.6 lean: 38 here
  assert.ok(firstAt.slice(6).reduce((a, b) => a + b, 0) > 70, `${firstAt.slice(6).reduce((a, b) => a + b, 0)} of 200 in the lower half of the top 12`); // uniform: ~100 (97 here); the 1.6 lean: 68 here
  assert.equal(tonight(pool, ["wicked"], { day: "2026-10-11" }).length, 5, "Something wicked has 5 films you may be shown: five picks, not six");
  assert.equal(dayOf(Date.parse("2026-10-12T02:00:00Z")), "2026-10-11", "11 pm in São Paulo is still the 11th");
  assert.equal(dayOf(Date.parse("2026-10-12T03:30:00Z")), "2026-10-12", "half past midnight in São Paulo is the 12th (UTC−3, no daylight saving)");
});

// Tonight of the profiles, 19/10/2026 (Marco's questionnaire; PR #47): the even draw takes ONE rand() per pick, as the 1.6 draw did. An extra call, or one fewer, moves every later pick and
// the order of the whole profile row; no count of "how many land in the top 3" can see it, so the picks of three days are pinned. Made by this code on 19/10/2026 over the fixture of test/profile-fixture.js.
test("Tonight takes one rand() per pick: the six of three days of Night and horror are the same films in the same order (an extra or a missing call moves them)", () => {
  const ix = hydrate(JSON.parse(files()["index.json"]));
  const pool = ix.films.filter((e) => !e.seen && e.eligible);
  const six = (day) => tonight(pool, ["night", "wicked"], { day, seedKey: "night" }).map((p) => p.tt);
  assert.deepEqual(six("2026-10-11"), ["tt0000008", "tt0000016", "tt0000004", "tt0000030", "tt0000009", "tt0000017"]);
  assert.deepEqual(six("2026-10-12"), ["tt0000006", "tt0000016", "tt0000001", "tt0000017", "tt0000007", "tt0000015"]);
  assert.deepEqual(six("2026-10-13"), ["tt0000015", "tt0000011", "tt0000016", "tt0000008", "tt0000030", "tt0000014"]);
});

test("Tonight through the address rotates with the clock: the 11th and the 12th differ, 11 pm and noon of the 11th agree", async () => {
  const at = (iso) => rig({ now: () => Date.parse(iso) }).get("/p/night/catalog/movie/tonight.json").then(ids);
  const noon11 = await at("2026-10-11T15:00:00Z"), late11 = await at("2026-10-12T02:30:00Z"), noon12 = await at("2026-10-12T15:00:00Z");
  assert.deepEqual(late11, noon11);
  assert.notDeepEqual(noon12, noon11);
});

test("Watchlist and Under 100 min in Night and horror: only films of its two moods, unseen, eligible; the Board's order; never the Lift films that top the old rows", async () => {
  const r = rig();
  const w = ids(await r.get("/p/night/catalog/movie/watchlist.json"));
  assert.deepEqual(w, [tt("Wicked Watchlist Long"), tt("Night Watchlist Short"), tt("Night and Lift")]); // taste + 0.7 × quality: 2, 1.7, 0
  const s = ids(await r.get("/p/night/catalog/movie/short.json"));
  for (const id of [...w, ...s]) assert.ok(fitsAny(["night", "wicked"])(id), id);
  assert.ok(s.includes(tt("Night Watchlist Short")) && s.includes(tt("Night and Lift")));
  assert.ok(!s.includes(tt("Wicked Watchlist Long")), "130 minutes is over 100");
  assert.ok(!s.includes(tt("Too Short")), "30 minutes is a short, not a feature");
  assert.ok(s.includes(tt("Night 100 Minutes")) && !s.includes(tt("Night 101 Minutes")), "100 minutes is in, 101 is out");
  for (const bad of ["Seen Night Top", "Below Floor Night", "Lift 1"]) assert.ok(!w.includes(tt(bad)) && !s.includes(tt(bad)), bad);
  // Light and fun has the Lift films; and they never leak through a page of Night and horror
  assert.ok(ids(await r.get("/p/light/catalog/movie/watchlist.json")).includes(tt("Lift 1")));
  assert.deepEqual(ids(await r.get("/p/night/catalog/movie/short/skip=1.json")), s.slice(1));
});

test("a page is cut after the filter: skip walks the profile's own list, and the total is the filtered count", async () => {
  const r = rig();
  const all = await r.get("/p/night/catalog/movie/short.json");
  const total = Number(all.headers.get("X-Total"));
  assert.equal(total, ids(all).length);
  assert.deepEqual(ids(await r.get(`/p/night/catalog/movie/short/skip=${total}.json`)), []);
});

// ── lists: themes, Who vouches, What it is, the Closet row ───────────────────

test("Horror (lists): every film of the theme's lists once, unseen and eligible, best rank first", async () => {
  const r = rig();
  const got = ids(await r.get("/p/night/catalog/movie/theme-horror.json"));
  assert.deepEqual(got, [tt("Horror Both Lists"), tt("Halloween Only")]); // poxvK + dCcac; the seen and the under-the-floor films are out, and so is the film of list XpoxvK
});

test("Halloween is served in July as in October (Marco, 11/10/2026: the season is ignored)", async () => {
  const oct = ids(await rig().get("/p/night/catalog/movie/theme-halloween.json"));
  const jul = ids(await rig({ now: () => Date.parse("2026-07-15T12:00:00Z") }).get("/p/night/catalog/movie/theme-halloween.json"));
  assert.deepEqual(jul, oct);
  assert.deepEqual(oct, [tt("Horror Both Lists"), tt("Halloween Only")]);
});

test("Criterion Closet, two rows (Marco, 11/10/2026): Most picked and All picks, each in its curator's order, nothing seen, nothing twice", async () => {
  const r = rig();
  assert.deepEqual(ids(await r.get("/p/critics/catalog/movie/closet-most-picked.json")), [tt("Below Floor Night"), tt("Closet Most Picked")]);
  assert.deepEqual(ids(await r.get("/p/critics/catalog/movie/closet-all-picks.json")), [tt("Closet All Only"), tt("Closet Most Picked"), tt("Horror Both Lists")]);
  const m = await r.get("/p/critics/manifest.json");
  assert.deepEqual(m.json.catalogs.filter((c) => c.id.startsWith("closet-")).map((c) => c.name), ["Criterion Closet · Most picked", "Criterion Closet · All picks"]);
});

test("Who vouches: one catalog per group, the group's lists by their new names A to Z; a list answers in the curator's order, unseen; a name from no menu is an empty page", async () => {
  const r = rig();
  const m = await r.get("/p/night/manifest.json");
  const inst = m.json.catalogs.find((c) => c.id === "vouch-institutions");
  const names = inst.extra.find((e) => e.name === "genre").options;
  assert.deepEqual(names, ["All picks · Criterion Closet", "Art-house horror · Criterion", "Most picked · Criterion Closet", "Spooky-season horror · Criterion"]);
  const most = LIST_NAMES.find((l) => l.id === "tp03m").name;
  const res = await r.get(`/p/night/catalog/movie/vouch-institutions/genre=${encodeURIComponent(most)}.json`);
  assert.deepEqual(ids(res), [tt("Below Floor Night"), tt("Closet Most Picked")]); // the curator's order; a list is a curator's, so the floor does not apply; the seen film is out
  assert.equal(res.json.metas[1].description.split("\n")[1], "Closet Most Picked genres.", "line 2 is the film's own genres and keywords: the list and its place are no longer said (Marco, 20/10/2026)");
  assert.deepEqual(ids(await r.get(`/p/night/catalog/movie/vouch-critics/genre=${encodeURIComponent(most)}.json`)), [], "an Institutions list is not in the Critics menu");
  assert.deepEqual(ids(await r.get("/p/night/catalog/movie/vouch-institutions/genre=Old%20label%20of%20tp03m.json")), [], "the old label is not an option here");
  const all = LIST_NAMES.find((l) => l.id === "snFyM").name;
  assert.deepEqual(ids(await r.get(`/p/night/catalog/movie/vouch-institutions/decade=1970s&genre=${encodeURIComponent(all)}.json`)), [], "the four menus apply: no 1970s film in All picks");
  assert.equal(ids(await r.get(`/p/night/catalog/movie/vouch-institutions/decade=1990s&genre=${encodeURIComponent(all)}.json`)).length, 3);
});

test("Who vouches on the real table reads as a person reads: part I before part II, Under 90 before Under 100, the decades as a timeline", () => {
  const order = (group) => LIST_NAMES.filter((l) => l.group === group).map((l) => l.name).sort(byName);
  const before = (list, a, b) => assert.ok(list.indexOf(a) >= 0 && list.indexOf(a) < list.indexOf(b), `${a} before ${b}`);
  const inst = order("Institutions"), crit = order("Critics"), fans = order("Letterboxd & community");
  for (const x of ["1970s sensations", "Essential 1990s", "Holiday marathon", "Questioning love", "Summer films"]) before(inst, `${x} · Criterion`, `${x} II · Criterion`);
  before(inst, "Horror · MUBI", "Horror costume ideas · Criterion");
  before(fans, "Under 90 min · community", "Under 100 min · Letterboxd");
  before(crit, "1980s · IndieWire", "2000s · IndieWire");
  before(crit, "2020s · IndieWire", "21st century · BBC");
});

test("What it is: the themes the index has, eras first; a theme and the decade menu together; a list with no theme is in no theme", async () => {
  const r = rig();
  const m = await r.get("/p/heavy/manifest.json");
  const what = m.json.catalogs.find((c) => c.id === WHAT.id);
  assert.deepEqual(what.extra.find((e) => e.name === "genre").options, ["All-time canon", "Halloween", "Horror", "Noir & night"]);
  assert.deepEqual(ids(await r.get("/p/heavy/catalog/movie/what-it-is/genre=Horror.json")), [tt("Horror Both Lists"), tt("Halloween Only")]);
  assert.deepEqual(ids(await r.get("/p/heavy/catalog/movie/what-it-is/decade=1970s&genre=Horror.json")), [tt("Halloween Only")]);
  assert.deepEqual(ids(await r.get("/p/heavy/catalog/movie/what-it-is/genre=Horror&decade=2050s.json")), [], "a decade the menu does not have: an empty page, not every film");
  assert.deepEqual(THEMES.slice(0, 3), ["1970s", "1980s–90s", "21st century"], "on the real table the eras come first, oldest first");
  assert.deepEqual(THEMES.slice(3), THEMES.slice(3).slice().sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)), "then A to Z");
});

test("a cold request reads at most 9 files: a theme of more than 8 lists reads the whole index once instead of each list's piece", async () => {
  const { THEMES: all } = await import("../src/list-names.js");
  const many = all.filter((t) => LIST_NAMES.filter((l) => l.themes.includes(t)).length > 8);
  assert.ok(many.includes("21st century"), "the real table has themes of more than 8 lists");
  // the fixture index has 6 lists; with the real table's themes, the biggest the fixture can hold is Horror (2 here): read piece by piece
  const r = rig();
  await r.get("/p/night/catalog/movie/theme-horror.json");
  assert.deepEqual(r.calls.filter((c) => c.startsWith("index-list-")).sort(), ["index-list-dCcac.json", "index-list-poxvK.json"]);
  // a theme over the cap: an index whose lists are 9 of All-time canon's
  const canon = LIST_NAMES.filter((l) => l.themes.includes("All-time canon")).map((l) => l.id);
  assert.ok(canon.length > 8);
  const o = makeObject();
  o.lists = canon.map((id) => ({ id, label: id, popular: false, films: 1 }));
  o.films = o.films.map((f, i) => ({ ...f, lists: { [canon[i % canon.length]]: 1 } }));
  o.films.push({ ...o.films.find((f) => !f.seen && f.eligible), tt: "tt9999999", name: "Lookalike", lists: { [`X${canon[0]}`]: 1 }, rank: 99 }); // a list id that ends like a canon list's: in the whole index, not in the theme
  const f = { "index.json": JSON.stringify(rows.encode(o)) };
  for (const p of exporter.pieces(o)) f[p.rel.split("/").pop()] = JSON.stringify(rows.encode(p.obj));
  const big = rig({ files: f });
  const res = await big.get("/p/critics/catalog/movie/theme-all-time-canon.json");
  assert.equal(res.status, 200);
  assert.ok(ids(res).length > 0);
  assert.ok(big.calls.length <= 9, `${big.calls.length} files read: ${big.calls.join(", ")}`);
  assert.ok(!big.calls.some((c) => c.startsWith("index-list-")), "no list piece: the whole index");
  assert.ok(!ids(res).includes("tt9999999"), "a list whose id only ends like a theme list's is not that list");
});

// 14/11/2026 (audit of the Worker, finding 4): inside profileRequest a constant called `ctx` (the profile, the index's meta, the day: what profileRow needs) hid the Worker's execution
// context of the same name, and filmsOfLists handed THAT object to the store when a theme has more than 8 lists. The store hands a refresh of a stale copy to `ctx.waitUntil`
// (store.js get), the object had none, so the refresh of the whole index started and was given to nobody: on Cloudflare a promise nobody waits for may be dropped when the answer goes out.
/** An index whose lists are those of All-time canon (more than 8), as in the test above, and a rig whose clock moves and whose requests carry an execution context that records `waitUntil`. */
function staleRig({ drop = null } = {}) {
  const canon = LIST_NAMES.filter((l) => l.themes.includes("All-time canon")).map((l) => l.id);
  const o = makeObject();
  o.lists = canon.map((id) => ({ id, label: id, popular: false, films: 1 }));
  o.films = o.films.map((f, i) => ({ ...f, lists: { [canon[i % canon.length]]: 1 } }));
  const f = { "index.json": JSON.stringify(rows.encode(o)) };
  for (const p of exporter.pieces(o)) f[p.rel.split("/").pop()] = JSON.stringify(rows.encode(p.obj));
  if (drop) for (const name of Object.keys(f)) if (drop.test(name)) delete f[name]; // a site that lacks those pieces: the whole index stands in for each
  const r = { now: OCT, calls: [], reads: [], lists: canon.length };
  const fetchImpl = async (url) => { const name = url.slice(DIR.length); r.calls.push(name); return f[name] ? new Response(f[name]) : new Response("not found", { status: 404 }); };
  const real = createStore({ fetchImpl, caches: undefined, log: () => {}, now: () => r.now });
  // the handler's store, with every read written down: which file, and which object came as the execution context
  const store = { ...real, get: (url, context) => { r.reads.push({ name: url.slice(DIR.length), context }); return real.get(url, context); } };
  const handle = createHandler({ store, subtitles: { list: async () => ({ subs: [] }), exact: async () => ({ status: "none", ids: new Set() }) }, now: () => r.now });
  r.get = async (path, ctx) => {
    const res = await handle(new Request("https://mood-engine.example.workers.dev" + path), ENV, ctx);
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: JSON.parse(text) };
  };
  r.context = () => { const waits = []; return { waits, waitUntil: (p) => { waits.push(p); } }; };
  return r;
}

test("a profile theme of more than 8 lists: the whole index it reads is refreshed in the background through the Worker's execution context (waitUntil), like every other file", async () => {
  const r = staleRig();
  assert.ok(r.lists > 8, "the theme is over the cap of 8 pieces");
  const THEME = "/p/critics/catalog/movie/theme-all-time-canon.json";
  const cold = r.context();
  const first = await r.get(THEME, cold);
  assert.equal(first.status, 200);
  assert.ok(ids(first).length > 0);
  assert.deepEqual([...r.calls].sort(), ["index-board.json", "index.json"], "cold: the Board part and the whole index, fetched and waited for");
  assert.equal(cold.waits.length, 0, "nothing in the background on a cold request");

  // 31 minutes later both copies are past the 30 minutes and under a day: each is served at once and refreshed in the background
  r.now += 31 * 60e3;
  r.calls.length = 0; r.reads.length = 0;
  const ctx = r.context();
  const second = await r.get(THEME, ctx);
  assert.equal(second.status, 200);
  assert.deepEqual(ids(second), ids(first), "the same films, from the copies in memory");
  assert.equal(second.headers.get("X-Index-Source"), "memory-stale");
  assert.deepEqual(r.reads.map((x) => x.name), ["index-board.json", "index.json"], "the two files this request reads");
  assert.deepEqual([...r.calls].sort(), ["index-board.json", "index.json"], "a refresh of each was started");
  assert.equal(ctx.waits.length, 2, "and each refresh was handed to waitUntil: the Board part's AND the whole index's");
  for (const x of r.reads) assert.equal(x.context, ctx, `${x.name}: the store is given the Worker's execution context, not another object`);
  await Promise.all(ctx.waits);

  // once those refreshes are done the copies are fresh again: the next request starts none
  r.calls.length = 0;
  const after = r.context();
  const third = await r.get(THEME, after);
  assert.equal(third.headers.get("X-Index-Source"), "memory");
  assert.deepEqual(r.calls, []);
  assert.equal(after.waits.length, 0);
});

test("every store read of every profile catalog request is given the Worker's execution context: each declared catalog of the six profiles, each option of its menus, a theme over the cap; and the same on a site with no pieces, where the whole index stands in", async () => {
  for (const [site, r] of [["every piece published", staleRig()], ["no Board part, no list piece, no moods piece", staleRig({ drop: /^index-(board|list-.*|moods)\.json$/ })]]) {
    const ctx = r.context();
    let requests = 0;
    for (const key of PROFILES.keys()) {
      const manifest = await r.get(`/p/${key}/manifest.json`, ctx);
      assert.equal(manifest.status, 200, `${site}: ${key}`);
      for (const c of manifest.json.catalogs) {
        const genre = (c.extra || []).find((e) => e.name === "genre");
        const paths = [`/p/${key}/catalog/${c.type}/${c.id}.json`, ...(genre && genre.options ? genre.options.map((g) => `/p/${key}/catalog/${c.type}/${c.id}/genre=${encodeURIComponent(g)}.json`) : [])];
        for (const p of paths) { const res = await r.get(p, ctx); assert.ok(res.status === 200 || res.status === 404, `${site}: ${p}: ${res.status}`); requests++; }
      }
    }
    assert.ok(requests > 60, `${site}: ${requests} catalog requests made`);
    assert.ok(r.reads.some((x) => x.name === "index.json"), `${site}: (control: some request read the whole index)`);
    assert.ok(r.reads.some((x) => /^index-list-/.test(x.name)) && r.reads.some((x) => x.name === "index-moods.json") && r.reads.some((x) => x.name === "index-board.json"), `${site}: (control: the Board part, a list piece and the moods piece were asked for)`);
    const wrong = r.reads.filter((x) => x.context !== ctx);
    assert.deepEqual(wrong.map((x) => x.name), [], `${site}: files read with something else in the place of the execution context`);
  }
});

test("the profile's install page escapes the host it repeats", async () => {
  const res = await rig().get("/p/night/");
  assert.equal(res.status, 200);
  assert.match(res.text, /stremio:\/\/mood-engine\.example\.workers\.dev\/p\/night\/manifest\.json/);
  const odd = await createHandler({ store: createStore({ fetchImpl: async () => new Response("nf", { status: 404 }), caches: undefined, log: () => {} }) })(new Request('https://a"b&c.test/p/night/'), ENV); // the URL parser lets " and & through in a host (< and > it refuses)
  const html = await odd.text();
  assert.ok(!html.includes('a"b&c') && html.includes("a&#34;b&#38;c"), "the host is escaped");
});

test("subtitles answer under a profile's address as at the old one", async () => {
  const r = rig();
  const a = await r.get("/p/world/subtitles/movie/tt5247022/filename=Paterson.2016.mkv.json");
  const b = await r.get("/subtitles/movie/tt5247022/filename=Paterson.2016.mkv.json");
  assert.equal(a.status, 200);
  assert.deepEqual(a.json, b.json);
});

test("every profile's description tells the truth about the subtitles on both addresses: the official list, and the ones made for the file first only on the private address (W4, 19/10/2026: the hash search that finds them is private; the old sentence promised them everywhere)", async () => {
  const r = rig();
  for (const key of ["marco", "light", "heavy", "night", "world", "critics"]) {
    const m = (await r.get(`/p/${key}/manifest.json`)).json;
    assert.match(m.description, /Also English and Portuguese subtitles: the official list, and the ones made for your file first only on the private address\.$/, key);
    assert.ok(!/subtitles, the ones made for your file first\./.test(m.description), `${key}: the old promise is gone`);
  }
});

// ── the name table ───────────────────────────────────────────────────────────

const ROOT = new URL("../../", import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, ROOT));

test("the name table is the stremio repo's docs/2026-10-11-nomes-listas.json at d95cc7a, byte for byte, plus the five TSPDT rows (23/10/2026 19:51 UTC) and the three of cinematography () after them", () => {
  const text = read("data/list-names.source.json").toString("utf8");
  const rows = JSON.parse(text);
  assert.equal(text, JSON.stringify(rows, null, 1), "the file is written the way the table was (one space, no trailing newline)");
  // the first 139 rows, written back the same way, are the file of d95cc7a: the sha256 is the one this test pinned from 11/10/2026 until 23/10/2026
  assert.equal(crypto.createHash("sha256").update(JSON.stringify(rows.slice(0, 139), null, 1)).digest("hex"), "0312bd967eeec72e8db50b1cb384a286e17204abc154f7daefd07568319df103");
  // Marco, 23/10/2026 19:51 UTC (questionnaire, recommended option): "Entrar na tabela: Critics em 'quem recomenda'; cânone / século 21 em 'do que se trata'." Only these five follow row 139, each in Critics,
  // the theme a session reading (no theme "of the year" exists in the table: the 50 best of 2025 sits with "2020s · IndieWire" in 21st century); a changed group, theme or name here fails this test.
  //: "Sim: entram em 'do que se trata' como ofício/fotografia." The three lists of cinematography of 14/10/2026 follow, in a theme that did not exist (Cinematography; the session's name) and in the group their origin asks
  // for (a session reading: a poll of critics, a professional society's list, a user's list). The final names are pinned apart, below.
  // of 24/10 (questionnaire, not the recommended option): "Tema próprio: 'Beyond the canon'" — the A-List leaves All-time canon for a theme of its own, so All-time canon holds the two polls and nothing of the A-List (a list moved back
  // to All-time canon fails here).
  assert.deepEqual(rows.slice(139).map((r) => [r.id, r.nome_novo, r.quem, r.tema, r.tema2, r.trust]), [
    ["tspdt-21c-250", "21st century top 250 · TSPDT", "Critics", "21st century", null, "critic"],
    ["tspdt-poll26-250", "2026 poll top 250 · TSPDT", "Critics", "All-time canon", null, "fan"],
    ["tspdt-poll21-250", "2021 poll top 250 · TSPDT", "Critics", "All-time canon", null, "fan"],
    ["tspdt-2025-50", "50 best of 2025 · TSPDT", "Critics", "21st century", null, "critic"],
    ["tspdt-beyond-ss-alist", "Beyond S&S A-List · TSPDT", "Critics", "Beyond the canon", null, "critic"],
    ["GAsK", "Cinematography · Fandor poll", "Critics", "Cinematography", null, "fan"],
    ["2mL0U", "100 milestones · ASC", "Institutions", "Cinematography", null, "critic"],
    ["100b4", "Colour grading · clairecao", "Letterboxd & community", "Cinematography", null, "fan"],
  ]);
  for (const r of rows.slice(139)) assert.ok(r.nome_novo.length <= 28, `${r.id}: "${r.nome_novo}" is over 28 characters`);
});

test("the final names of the eight lists Marco put in the table on 23/10/2026 are the ones on screen (a name changed only in list-names.final.json, which the menus read, fails here; the heavy real-index test is the other guard)", () => {
  const final = JSON.parse(read("data/list-names.final.json"));
  const want = {
    "tspdt-21c-250": "21st century top 250 · TSPDT", "tspdt-poll26-250": "2026 poll top 250 · TSPDT", "tspdt-poll21-250": "2021 poll top 250 · TSPDT", "tspdt-2025-50": "50 best of 2025 · TSPDT",
    "tspdt-beyond-ss-alist": "Beyond S&S A-List · TSPDT", GAsK: "Cinematography · Fandor poll", "2mL0U": "100 milestones · ASC", "100b4": "Colour grading · clairecao",
  };
  for (const [id, name] of Object.entries(want)) {
    assert.equal(final[id], name, `${id}: final.json`);
    assert.equal(LIST_NAMES.find((l) => l.id === id).name, name, `${id}: on screen`);
    assert.ok(name.length <= 28, `${id}: ${name}`);
  }
});

test("the final names: one per list of the table, at most 32 characters, no @, parentheses or emoji, `what · who`, none repeated", () => {
  const final = JSON.parse(read("data/list-names.final.json"));
  const source = JSON.parse(read("data/list-names.source.json"));
  assert.deepEqual(Object.keys(final).sort(), source.map((r) => r.id).sort());
  const seen = new Set();
  for (const [id, name] of Object.entries(final)) {
    assert.ok(name.length <= 32, `${id}: "${name}"`);
    assert.doesNotMatch(name, /[@()]|\p{Extended_Pictographic}/u, id);
    assert.match(name, / · /, id);
    const key = name.trim().toLowerCase();
    assert.ok(!seen.has(key), `${id}: "${name}" twice`);
    seen.add(key);
  }
});

test("the menus show the final names (data/list-names.final.json), not the draft of the table: e.g. the 2016 Abraccine edition reads as an edition", () => {
  const final = JSON.parse(read("data/list-names.final.json"));
  for (const l of LIST_NAMES) assert.equal(l.name, final[l.id], l.id);
  assert.equal(LIST_NAMES.find((l) => l.id === "xHj8").name, "Brazilian, 2016 ed. · Abraccine");
});

test("the table and config.json agree on every list: the same ids, addresses and trust; every list has a group and a known theme or none", () => {
  const cfg = JSON.parse(read("config.json"));
  const source = JSON.parse(read("data/list-names.source.json"));
  // 14/10/2026 (PR5 of the Board): three lists of cinematography joined config.json for "Visually striking" (GAsK, 2mL0U, 100b4) with no row in the table of 11/10/2026 (Marco's, its first 139 rows pinned byte for byte), so the
  // profiles' menus did not show them (BACKLOG.md, 14/10/2026). Prose kept as the record of why this test had an exception list; the exception is gone, see the next paragraph.
  // 22/10/2026 (TSPDT top 250, Marco): four lists joined config.json, a fifth at (Beyond the Sight & Sound Canon, A-List). Marco, 23/10/2026 19:51 UTC (questionnaire): "Entrar na tabela:
  // Critics em 'quem recomenda'; cânone / século 21 em 'do que se trata'." The five TSPDT lists are in the table since then (rows 140-144).: "Sim: entram em 'do que se trata' como ofício/fotografia."
  // The three lists of cinematography of 14/10/2026 (GAsK, 2mL0U, 100b4) are rows 145-147. Nothing is left outside the table: until 23/10/2026 this test kept an AFTER_THE_TABLE list of the lists that were in
  // config.json and not in the table (three lists on 14/10, eight on 22/10, three again on 23/10 19:51 UTC, none after); a list added to config.json without a row fails here again.
  assert.deepEqual(source.map((r) => r.id).sort(), cfg.lists.map((l) => l.id).sort());
  for (const r of source) {
    const l = cfg.lists.find((x) => x.id === r.id);
    assert.equal(r.url ?? null, l.url ?? null, `${r.id}: url`);
    assert.equal(r.trust, l.trust ?? "fan", `${r.id}: trust`);
  }
  for (const l of LIST_NAMES) {
    assert.ok(GROUPS.includes(l.group), `${l.id}: group ${l.group}`);
    for (const t of l.themes) assert.ok(THEMES.includes(t), `${l.id}: theme ${t}`);
  }
  assert.deepEqual(GROUPS.map((g) => LIST_NAMES.filter((l) => l.group === g).length), [36, 59, 18, 34]);
  assert.equal(THEMES.length, 28);
  assert.equal(LIST_NAMES.filter((l) => !l.themes.length).length, 25);
});

test("every theme a profile's Board names is a theme of the table, and every mood a profile names is one of the nine", () => {
  for (const [key, p] of PROFILES) {
    for (const r of p.rows || []) if (r.kind === "theme") assert.ok(THEMES.includes(r.theme), `${key}: ${r.theme}`);
    for (const m of p.moods || []) assert.ok(MOOD_NAMES[m], `${key}: ${m}`);
  }
  assert.deepEqual(VOUCH.map((v) => v.group), GROUPS);
});

test("the 404s of the profile routes have fixed bodies: an unknown profile does not list the profile keys, an undeclared catalog does not repeat the id or the profile (W1c, 13/10/2026: the first said `profiles: [marco, light, …]`, the second `unknown catalog <type>/<id> in profile <key>`)", async () => {
  const r = rig();
  const nobody = await r.get("/p/nobody/manifest.json");
  assert.equal(nobody.status, 404);
  assert.deepEqual(nobody.json, { err: "unknown profile" });
  for (const key of PROFILES.keys()) assert.ok(!nobody.text.includes(key), `the body does not name the profile \`${key}\``);
  const ghost = await r.get("/p/night/catalog/movie/zz-probe-9f3.json");
  assert.equal(ghost.status, 404);
  assert.deepEqual(ghost.json, { err: "unknown catalog" });
  assert.ok(!ghost.text.includes("zz-probe-9f3") && !ghost.text.includes("night"));
  assert.equal(ghost.headers.get("x-profile"), "night", "the headers are the ones it had");
  assert.equal(ghost.headers.get("x-index-source"), "network");
});

// ── line 2 of the card says the mood the PROFILE shows (Marco, 13/10/2026; the format of 20/10/2026) ──

const card = (m) => m.description.split("\n\n")[0].split("\n"); // [credits, line 2 when it has one]
// Marco, 28/10/2026 (cards with chips, "T2"): the phrase "Mood: …" is not written in a card any more; the mood is the first chip of the Mood group, in the profile's name for it.
const moodNames = (m) => (m.links || []).filter((l) => l.category === "Mood").map((l) => l.name);
const noPhrase = (m) => assert.ok(!m.description.includes("Mood:"), `${m.name}: ${m.description}`);

test("a mood row of a profile says the profile's name for it (\"Mood: Warm and funny\"), not the Board's (\"☀️ Lift me out\"); the Board's own text gives way and the rest of it stays", async () => {
  const r = rig();
  const lift = (await r.get("/p/light/catalog/movie/lift.json")).json.metas;
  assert.ok(lift.length > 0);
  for (const m of lift) {
    noPhrase(m);
    assert.equal(moodNames(m)[0], "Warm and funny", m.name);
    assert.ok(!moodNames(m).includes("Lift me out"), `${m.name}: the Board's name is not the profile's`);
  }
  const night = (await r.get("/p/night/catalog/movie/night.json")).json.metas;
  assert.ok(night.length > 0 && night.every((m) => moodNames(m).includes("Neon and tension") && !m.description.includes("Mood:")), "the row's mood is among the chips (a film that fits another mood as well, 'Night and Lift', may lead with that one: the row's mood is not promoted, only Tonight's draw is)");
  // a Board row that is not a mood: Directors you trust has no row mood. Since D3 (Marco, 21/10/2026 ~15:00 UTC) its line 2 opens with the mood the film fits best, so "Mood:" may be there; what must not be there is the NAME the profile gives the row
  // (the rule of 20/10/2026, "says no mood", is gone). This fixture's Board text carries no label, so the rows below are made with one (the next test); here the text is the film's own and the profile's name for the row appears nowhere.
  const directors = (await r.get("/p/world/catalog/movie/directors.json")).json.metas;
  assert.ok(directors.length > 0 && directors.every((m) => !m.description.includes("Directors you trust") && !m.description.includes("Old directors")), directors.map((m) => m.description).join(" | "));
});

// Marco, 21/10/2026 ~15:00 UTC (D3): a Board row that is no mood and has no reason opens line 2 with the mood the film FITS BEST, not with the row's name (re-verification of 21/10/2026, item M-a: the comment and the assertion of the test above were still the rule of 20/10).
// "Directors you trust" is such a row; the profile calls it "Directors you trust" and the Board "Old directors". Here the Board's text for the film carries the best fit, as the build writes it, and the Worker serves it as it is: never the profile's name for the row, never the Board's.
test("a Board row that is no mood (Directors you trust) opens with the film's best fit, as the build wrote it — neither the profile's name for the row nor the Board's name appears in line 2", async () => {
  const o = makeObject();
  o.rowDesc.directors = o.rows.directors.map((id) => `${FILMS.find((f) => f.tt === id).name} cast\nMood: 🎥 Fits best · genres of the row.`);
  const f = { "index.json": JSON.stringify(rows.encode(o)) };
  for (const p of exporter.pieces(o)) f[p.rel.split("/").pop()] = JSON.stringify(rows.encode(p.obj));
  const r = rig({ files: f });
  const metas = (await r.get("/p/world/catalog/movie/directors.json")).json.metas;
  assert.ok(metas.length > 0);
  for (const m of metas) {
    // Marco, 28/10/2026: the build's line "Mood: 🎥 Fits best · …" is not written; the credits stay alone
    assert.equal(card(m).length, 1, `${m.name}: ${m.description}`);
    assert.ok(!m.description.includes("Directors you trust") && !m.description.includes("Old directors") && !m.description.includes("Fits best"), `${m.name}: the row's name leaked into the card: ${m.description}`);
  }
});

test("the rows a profile builds itself but Tonight (Under 100 min, Watchlist, a theme, Closet, What it is) say no mood and no reason: with a general text that carries no best-fit label (this fixture's) line 2 is the film's own genres and keywords; the labelled text is the next test (Tonight names the mood it was drawn for: the one after)", async () => {
  const r = rig();
  for (const path of ["night/catalog/movie/short.json", "night/catalog/movie/watchlist.json", "night/catalog/movie/theme-horror.json", "critics/catalog/movie/closet-most-picked.json", "critics/catalog/movie/closet-all-picks.json", "heavy/catalog/movie/what-it-is/genre=Horror.json", "heavy/catalog/movie/what-it-is/genre=All-time%20canon.json"]) {
    const metas = (await r.get(`/p/${path}`)).json.metas;
    assert.ok(metas.length > 0, path);
    for (const m of metas) assert.equal(card(m)[1], `${m.name} genres.`, `${path}: ${m.name}: ${card(m)[1]}`);
  }
});

// Review of the description v3, 21/10/2026 (guard-worker-prosa): README.md and worker/README.md say that the rows a profile builds itself show the film's GENERAL text, so the best-fit label that text carries (D3).
// Marco, 21/10/2026 ~19:40 UTC (questionnaire, C): Tonight is the exception, it names the mood the pick was drawn for (the test after this one); Under 100 min, Watchlist, a theme, Closet and What it is keep the label of the TEXT, which was a
// SESSION choice, never asked (BACKLOG 21/10/2026, review round, M6), and stays one: the question was about Tonight only. This fixture's general text carries a label, "Fits best". With the label dropped for these rows (or a mood put in its place) this test is red.
test("Under 100 min, Watchlist, a theme, Closet and What it is keep the best-fit label that the film's general text carries (a session choice, BACKLOG 21/10/2026); Tonight is the exception, below", async () => {
  const o = makeObject();
  o.films = o.films.map((f) => ({ ...f, desc: f.desc.replace("\n", "\nMood: 🎥 Fits best · ") }));
  const f = { "index.json": JSON.stringify(rows.encode(o)) };
  for (const p of exporter.pieces(o)) f[p.rel.split("/").pop()] = JSON.stringify(rows.encode(p.obj));
  const r = rig({ files: f });
  for (const path of ["night/catalog/movie/short.json", "night/catalog/movie/watchlist.json", "night/catalog/movie/theme-horror.json", "critics/catalog/movie/closet-most-picked.json", "heavy/catalog/movie/what-it-is/genre=Horror.json"]) {
    const metas = (await r.get(`/p/${path}`)).json.metas;
    assert.ok(metas.length > 0, path);
    // Marco, 28/10/2026: the text still carries the build's best-fit label, and the card does not write it (the chips say the film's own moods); a film that fits a mood of the profile shows the profile's name
    for (const m of metas) {
      noPhrase(m);
      assert.ok(!m.description.includes("Fits best") && !moodNames(m).includes("Fits best"), `${path}: ${m.name}: ${m.description}`);
      if (/^Night \d+$/.test(m.name)) assert.equal(moodNames(m)[0], "Neon and tension", `${path}: ${m.name}`);
    }
  }
  // a mood row of the profile still says the profile's name for its mood
  assert.ok((await r.get("/p/light/catalog/movie/lift.json")).json.metas.every((m) => moodNames(m)[0] === "Warm and funny" && !m.description.includes("Mood:")));
});

// Marco, 21/10/2026 ~19:40 UTC (questionnaire, C): in the profiles' Tonight the label of line 2 is the mood the pick was DRAWN for, not the mood the film fits best (until then the film's general text, whose label is the best fit: BACKLOG 21/10/2026,
// review round, M6: 2 to 3 of the 6 films named a mood outside the profile). The name is the profile's own for that mood ("Neon and tension"), the one its mood row shows. The general text here says "Fits best" (a mood the profile does not have) and one film
// ("Night 2") fits BOTH moods of the profile, so a label read from the film (its first mood, its best fit) cannot pass for the draw: over 40 days the same film must be drawn under each of the two moods. With the drawn mood not handed to compose()
// (profiles.js `drawn`, meta.js compose) this test is red on its first line. Since 28/10/2026 the draw's mood is the first chip (profiles.js `drawnMood`, meta.js cardLinks) and the same test holds it.
test("Tonight of a profile names the mood each pick was drawn for (the profile's name for it), not the best fit of the film's general text — a film that fits both moods is labelled by the draw", async () => {
  const o = makeObject();
  o.films = o.films.map((f) => ({ ...f, desc: f.desc.replace("\n", "\nMood: 🎥 Fits best · "), ...(f.name === "Night 2" ? { moods: { ...f.moods, wicked: [1, 15.5] } } : {}) }));
  const f = { "index.json": JSON.stringify(rows.encode(o)) };
  for (const p of exporter.pieces(o)) f[p.rel.split("/").pop()] = JSON.stringify(rows.encode(p.obj));
  const pool = hydrate(JSON.parse(f["index.json"])).films.filter((e) => !e.seen && e.eligible);
  const both = new Set(); // the names the film that fits both moods was drawn under
  let labelled = 0;
  for (let d = 1; d <= 40; d++) {
    const ms = Date.UTC(2026, 10, d, 15), day = dayOf(ms);
    const want = tonightPicks(pool, ["night", "wicked"], { day, seedKey: "night" });
    const metas = (await rig({ files: f, now: () => ms }).get("/p/night/catalog/movie/tonight.json")).json.metas;
    assert.deepEqual(metas.map((m) => m.id), want.map((p) => p.e.tt), `${day}: the same six as the draw`);
    metas.forEach((m, i) => {
      // Marco, 28/10/2026: the draw's mood is the FIRST chip of the Mood group, in the profile's name, once (a film that fits it as well as another mood does not repeat it); no phrase in the card
      assert.equal(moodNames(m)[0], MOOD_NAMES[want[i].mood], `${day}: ${m.name}: ${moodNames(m)}`);
      assert.equal(new Set(moodNames(m)).size, moodNames(m).length, `${day}: ${m.name}: a chip twice: ${moodNames(m)}`);
      noPhrase(m);
      assert.ok(!m.description.includes("Fits best"), `${day}: ${m.name}: the best fit of the general text is gone`);
      assert.ok(!/Night drive|Something wicked/.test(m.description), `${day}: ${m.name}: the Board's name of a mood is not the profile's`);
      labelled++;
      if (m.name === "Night 2") both.add(MOOD_NAMES[want[i].mood]);
    });
  }
  assert.equal(labelled, 240);
  assert.deepEqual([...both].sort(), ["Art-house horror", "Neon and tension"], "the film that fits both moods was drawn under each, and each time the label was the mood it was drawn for");
  // the old address and the Marco profile are not touched: Tonight there is the Board's, with its own text
  const marco = (await rig({ files: f }).get("/p/marco/catalog/movie/tonight.json")).json.metas;
  assert.ok(marco.length > 0 && marco.every((m) => !m.description.includes("Neon and tension") && !m.description.includes("Art-house horror")));
});

// Marco, 21/10/2026 ~22:15 UTC (questionnaire): a profile has ONE name per mood in EVERY row it serves. Until then only its Tonight and its mood rows said the profile's name; Under 100 min and Watchlist kept the build's name (47 of 100 cards of Under 100 min
// and 38 of 62 of Watchlist in Night and horror on the build of 21/10/2026), and so did the themes, Closet, What it is and a Board row that is no mood. The profile's name replaces the name the BUILD wrote after "Mood:" (the index's `moods[].name`: the mood's Board
// name when it has a row) when that name is a mood of the profile; the label of a mood the profile does not have stays as the build wrote it, and a profile with no moods (Marco, Critics & directors) renames nothing.
const labelled = (names) => {
  // an index whose moods carry made-up Board names, and a general text that opens line 2 with the label of the mood the film belongs to: night -> "🌃 Night by the Board", wicked -> "🎃 Horror by the Board", lift -> "☀️ Lift me out" (a mood Night and horror does not have)
  const o = makeObject();
  const NAME = { night: "🌃 Night by the Board", wicked: "🎃 Horror by the Board", lift: "☀️ Lift me out", slow: "🕯️ Slow by the Board" };
  o.moods = o.moods.map((m) => (NAME[m.id] ? { ...m, name: NAME[m.id] } : m));
  const mood = (f) => names[f.name] || (f.name === "Night and Lift" ? "lift" : f.moods && (f.moods.night ? "night" : f.moods.wicked ? "wicked" : f.moods.lift ? "lift" : null));
  o.films = o.films.map((f) => (mood(f) ? { ...f, desc: f.desc.replace("\n", `\nMood: ${NAME[mood(f)]} · `) } : f));
  const f = { "index.json": JSON.stringify(rows.encode(o)) };
  for (const p of exporter.pieces(o)) f[p.rel.split("/").pop()] = JSON.stringify(rows.encode(p.obj));
  return { o, f, NAME, mood };
};

test("every row of a profile says the profile's name for a mood of the profile — Under 100 min, Watchlist, the themes, What it is — and keeps the build's name for a mood it does not have (Night and horror: Neon and tension, Art-house horror; Lift stays)", async () => {
  const { f, NAME, mood } = labelled({ "Horror Both Lists": "wicked", "Noir Film": "night", "Halloween Only": "lift" });
  const r = rig({ files: f });
  const seen = { night: 0, wicked: 0, lift: 0 };
  const films = new Map(FILMS.map((x) => [x.name, x]));
  for (const path of ["short.json", "watchlist.json", "theme-horror.json", "theme-noir-night.json", "theme-halloween.json", "what-it-is/genre=Horror.json"]) {
    const metas = (await r.get(`/p/night/catalog/movie/${path}`)).json.metas;
    assert.ok(metas.length > 0, path);
    for (const m of metas) {
      // Marco, 28/10/2026: the chips come from the moods the FILM fits (its `moods` column), named by the profile when the mood is the profile's, by the build (without its emoji) when it is not
      const fits = Object.keys(films.get(m.name).moods || {});
      noPhrase(m);
      assert.ok(!moodNames(m).some((n) => /by the Board/.test(n)), `${path}: ${m.name}: the build's name of a profile mood is gone: ${moodNames(m)}`);
      if (!fits.length) continue;
      const want = fits.map((id) => (id === "lift" ? "Lift me out" : MOOD_NAMES[id])); // lift is not a mood of Night and horror: the build's name stays
      assert.deepEqual(moodNames(m).slice(0, want.length).sort(), want.sort(), `${path}: ${m.name}: ${moodNames(m)}`);
      for (const id of fits) seen[id]++;
    }
  }
  assert.ok(seen.night > 0 && seen.wicked > 0 && seen.lift > 0, `all three cases were met: ${JSON.stringify(seen)}`);
  // Tonight is the draw's mood, as before (the test above), and the mood rows keep working
  assert.ok((await r.get("/p/night/catalog/movie/night.json")).json.metas.every((m) => moodNames(m).includes("Neon and tension")));
});

test("a Board row of a profile that is no mood (World and slow: Directors you trust) says the profile's name when the best fit is a mood of the profile, and the build's name when it is not; a profile with no moods (Critics & directors) renames nothing", async () => {
  const slowOne = labelled({ "Canon Film": "slow" }), nightOne = labelled({ "Canon Film": "night" });
  const text = (x, label) => x.o.films.find((e) => e.name === "Canon Film") && `Canon Film cast\nMood: ${label} · genres of the row.`;
  // Marco, 28/10/2026: the card's mood is a chip from the film's own moods (Canon Film gets one here), so the same two cases are read from the first chip
  for (const [x, label, id, want, world] of [[slowOne, slowOne.NAME.slow, "slow", "Slow cinema", true], [nightOne, nightOne.NAME.night, "night", "Night by the Board", true]]) {
    x.o.films = x.o.films.map((e) => (e.name === "Canon Film" ? { ...e, moods: { [id]: [1, 5] } } : e));
    x.o.rowDesc.directors = x.o.rows.directors.map(() => text(x, label));
    const f = { "index.json": JSON.stringify(rows.encode(x.o)) };
    for (const p of exporter.pieces(x.o)) f[p.rel.split("/").pop()] = JSON.stringify(rows.encode(p.obj));
    const metas = (await rig({ files: f }).get("/p/world/catalog/movie/directors.json")).json.metas;
    assert.ok(metas.length > 0 && world);
    for (const m of metas) { noPhrase(m); assert.equal(moodNames(m)[0], want, `${m.name}: ${moodNames(m)}`); }
  }
  // Critics & directors has no moods: the chip of Canon Film in its All-time canon theme is the build's name
  const crit = labelled({ "Canon Film": "night" });
  crit.o.films = crit.o.films.map((e) => (e.name === "Canon Film" ? { ...e, moods: { night: [1, 5] } } : e));
  const fc = { "index.json": JSON.stringify(rows.encode(crit.o)) };
  for (const p of exporter.pieces(crit.o)) fc[p.rel.split("/").pop()] = JSON.stringify(rows.encode(p.obj));
  const canon = (await rig({ files: fc }).get("/p/critics/catalog/movie/theme-all-time-canon.json")).json.metas.filter((m) => m.name === "Canon Film");
  assert.ok(canon.length === 1 && moodNames(canon[0])[0] === "Night by the Board" && !canon[0].description.includes("Mood:"), canon.map((m) => moodNames(m)).join());
});

// A made-up profile, so the test does not lean on the real table of names: relabelOf() keys on the name the index gives each of the profile's moods, compose() puts the profile's name in, and the genre that the build had left out for the OLD name comes back
// when it is not the new name's (D5: "Mood: 🎃 Horror · Drama" had no Horror; "Mood: Art-house horror · Horror, Drama" has it).
test("relabelOf and compose with a made-up profile: only the profile's moods are keyed, by the index's own names; the genre group and the words follow the new name; a line it cannot read is left as the build wrote it", () => {
  const index = { moods: [{ id: "night", name: "🌃 Board night" }, { id: "wicked", name: "🎃 Horror" }, { id: "lift", name: "☀️ Lift me out" }] };
  const relabel = relabelOf({ moods: ["wicked", "night"] }, index);
  assert.deepEqual([...relabel], [["🎃 Horror", MOOD_NAMES.wicked], ["🌃 Board night", MOOD_NAMES.night]], "the profile's moods only (not lift), keyed by the index's names, valued by the profile's");
  assert.equal(relabelOf({ moods: null }, index).size, 0);
  assert.equal(relabelOf({ moods: ["wicked"] }, { moods: [] }).size, 0, "an index that does not list the mood: nothing to rename");
  const e = { tt: "tt1", name: "F", genres: ["Horror", "Drama"], director: "D", runtime: 100 };
  const out = (desc, ctx = { relabel }) => compose(e, ctx, desc).split("\n")[1];
  assert.equal(out("A; B\nMood: 🎃 Horror · Drama.\n\nSyn"), "Mood: Art-house horror · Horror, Drama.", "the build left Horror out for 'Horror'; Art-house horror is another name");
  assert.equal(out("A; B\nMood: 🌃 Board night · Horror, Drama · Anxious, Neon.\n\nSyn"), "Mood: Neon and tension · Horror, Drama · Anxious, Neon.");
  assert.equal(out("A; B\nMood: ☀️ Lift me out · Horror, Drama.\n\nSyn"), "Mood: ☀️ Lift me out · Horror, Drama.", "a mood the profile does not have");
  assert.equal(out("A; B\nHorror, Drama.\n\nSyn"), "Horror, Drama.", "no label: nothing to rename");
  assert.equal(out("A; B\nLoved by Lynch · Horror, Drama.\n\nSyn"), "Loved by Lynch · Horror, Drama.", "a reason leads: untouched");
  assert.equal(out("A; B\nMood: 🎃 Horror · Something else · Words.\n\nSyn"), "Mood: 🎃 Horror · Something else · Words.", "a line that does not read as genres + words is left as written");
  assert.equal(out("A; B\nMood: 🎃 Horror · Drama.\n\nSyn", {}), "Mood: 🎃 Horror · Drama.", "no profile, no renaming");
  assert.equal(out("A; B\nMood: 🎃 Horror · Drama.\n\nSyn", { relabel: new Map() }), "Mood: 🎃 Horror · Drama.");
});

// Re-verification of 22/10/2026 (LOW 2): the Search of a profile (served from the legacy files) did not rename the label: 40 of 100 cards of "horror" in Night and horror said "Something wicked" or "Night drive". It goes through the same relabel as the rows.
test("the Search of a profile says the profile's name for a mood of the profile, the build's name for a mood it does not have; the Marco profile renames nothing", async () => {
  const { f, NAME, mood } = labelled({});
  const films = new Map(FILMS.map((x) => [x.name, x]));
  const r = rig({ files: f });
  const metas = (await r.get("/p/night/catalog/movie/search/search=night.json")).json.metas;
  assert.ok(metas.length > 3);
  const seen = new Set();
  for (const m of metas) {
    const k = mood(films.get(m.name));
    if (!k) continue;
    // Marco, 28/10/2026: a chip, not a phrase; "Night and Lift" fits two moods, so the name is among the chips
    assert.ok(moodNames(m).includes(k === "lift" ? "Lift me out" : MOOD_NAMES[k]), `${m.name}: ${moodNames(m)}`);
    noPhrase(m);
    seen.add(k);
  }
  assert.ok(seen.has("night") && seen.has("lift"), `a profile mood and a mood outside it were met: ${[...seen]}`);
  const marco = (await r.get("/p/marco/catalog/movie/search/search=night.json")).json.metas;
  assert.ok(marco.length > 3 && marco.every((m) => !moodNames(m).some((n) => /Neon and tension|Art-house horror/.test(n))), "Marco has no moods: nothing is renamed");
});
