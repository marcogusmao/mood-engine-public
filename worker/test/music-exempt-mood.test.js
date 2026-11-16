// The mood exempt from the music rule, in the Worker (Marco, 22/10/2026 ~15:15 UTC, questionnaire "Music 1 of 4": the mood named Music is the one place where he asks for music when he opens the app).
// The build names the exempt moods in the index (`rules.musicExemptMoods`, lib/index-export.js workerRules); the Worker's Moods option of THAT mood shows `eligible` films, the held-back ones (bit 8,
// `musicOut`) included, with the four menus on top. Every other option of Moods, Explore, the profiles and Search keep the rule, and an index without the key exempts nothing (every index built before).
// The world is small and invented (fixture.js: two moods, night and lift); the real index is in test/real-index.test.js, the build in test/music-all-rows-build.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHandler } from "../src/handler.js";
import { createStore } from "../src/store.js";
import { select, page, eligibleTest } from "../src/catalogs.js";
import { parseExtras } from "../src/extras.js";
import { makeObject, readyOf, names } from "./fixture.js";
import * as PF from "./profile-fixture.js";

const require = createRequire(import.meta.url);
const rows = require("../../lib/index-rows.js");
const exporter = require("../../lib/index-export.js");

const SHOW = "Arena Tour Film", GIG = "Evidence Gig", POOR = "Held And Under The Floor";
const film = (tt, name, x = {}) => {
  const e = {
    tt, name, year: 2024, decade: "2020s", runtime: 100, countries: ["South Korea"], director: `Director of ${name}`, lbRating: 4.6, rank: 9, eligible: true, moods: { night: [1.9, 9], lift: [1.5, 9] }, genres: ["Documentary", "Music"],
    keywords: ["concert", "k-pop"], desc: `${name} cast\n${name} genres.\n\nA synopsis of ${name}.`, ...x,
  };
  e.find = " " + [e.name, e.director, e.keywords.join(" "), e.genres.join(" "), e.countries.join(" ")].join(" | ").toLowerCase();
  return e;
};
/** The fixture index plus a held-back show (fits both moods), a film with evidence, and a held-back film under the quality floor; `exempt` is what the build writes in rules.musicExemptMoods. */
function worldObject(exempt) {
  const o = makeObject();
  o.films.push(film("tt0000101", SHOW, { musicOut: true }), film("tt0000102", GIG, { rank: 8.9, director: "Another Director" }), film("tt0000103", POOR, { musicOut: true, eligible: undefined, lbRating: 3.1, rank: 8.8, director: "Third Director" }));
  for (const f of o.films) if (f.eligible === undefined) delete f.eligible;
  o.films.sort((a, b) => (b.rank ?? -Infinity) - (a.rank ?? -Infinity) || a.tt.localeCompare(b.tt));
  o.meta.count = o.films.length;
  o.rules = { rule: "letterboxd-average-or-configured-friend-or-vouched", minStars: 3.5, exemptCatalogs: ["lists", "lists-unseen", "friends"], ...(exempt ? { musicExemptMoods: exempt } : {}) };
  return o;
}
const answer = (index, id, q) => names(select(index, id, parseExtras(q)).entries);
const NIGHT = "genre=Nocturnal", LIFT = "genre=Uplift";

test("the Moods option of an exempt mood shows the held-back film, with every menu on top; the control: the same index without the key holds it back", () => {
  const ix = readyOf(worldObject(["night"])), old = readyOf(worldObject());
  for (const q of [NIGHT, `${NIGHT}&decade=2020s`, `${NIGHT}&country=South%20Korea`, `${NIGHT}&runtime=90%E2%80%93120%20min`, `${NIGHT}&rating=4.2%2B`, `${NIGHT}&decade=2020s&country=South%20Korea&runtime=90%E2%80%93120%20min&rating=4.2%2B`]) {
    assert.ok(answer(ix, "moods", q).includes(SHOW), `${q}: the exempt mood shows the held-back film`);
    assert.ok(answer(ix, "moods", q).includes(GIG), `${q}: and the film with evidence`);
    assert.ok(!answer(old, "moods", q).includes(SHOW), `control, ${q}: an index without rules.musicExemptMoods holds it back`);
  }
  assert.equal(page(ix, "moods", parseExtras(NIGHT)).entries.length - page(old, "moods", parseExtras(NIGHT)).entries.length, 1, "exactly the one film more: the held-back show that passes the quality rule");
});

// Review of 22/10/2026 (LOW 1): a mutation of worker/src/catalogs.js that made the exempt option filter by `eligible` and ignore the four menus survived, because every film of the first test's world is of the 2020s
// and South Korea. The fixture's own night films are of other decades, countries, runtimes and ratings: with the mutation Music + 2020s answered every film that fits (417 on the real index, 346 of them outside the 2020s; right: 73).
test("the four menus filter the exempt option: decade, country, runtime and rating each give exactly the films that fit the mood AND the menu, in the mood's order, two a director at most", () => {
  const ix = readyOf(worldObject(["night"]));
  const whole = answer(ix, "moods", NIGHT);
  const byHand = (menu) => {
    const fits = ix.films.filter((f) => f.mood("night") && !f.seen && f.eligible && menu(f)).sort((a, b) => b.mood("night")[1] - a.mood("night")[1] || (a.tt < b.tt ? -1 : 1));
    const n = new Map();
    return names(fits.filter((f) => { const d = f.director ? f.director.split(", ")[0] : null; if (!d) return true; const c = n.get(d) || 0; if (c >= 2) return false; n.set(d, c + 1); return true; }));
  };
  const cases = [
    ["decade=2020s", (f) => f.decade === "2020s"],
    ["country=South%20Korea", (f) => (f.countries || []).includes("South Korea")],
    ["runtime=Under%2090%20min", (f) => f.runtime != null && f.runtime >= 40 && f.runtime < 90],
    ["rating=4.2%2B", (f) => f.lbRating != null && f.lbRating >= 4.2],
  ];
  for (const [q, fits] of cases) {
    const got = answer(ix, "moods", `${NIGHT}&${q}`), want = byHand(fits);
    assert.ok(want.length >= 1 && want.length < whole.length, `${q}: the menu cuts something (${want.length} of ${whole.length}) and leaves something`);
    assert.deepEqual(got, want, q);
  }
  assert.ok(answer(ix, "moods", `${NIGHT}&decade=2020s`).includes(SHOW) && !answer(ix, "moods", `${NIGHT}&decade=2020s`).includes("The Killing"), "the held-back show is there, a 1956 film is not");
  assert.deepEqual(answer(ix, "moods", `${NIGHT}&decade=2020s&country=France`), [], "two menus together: the intersection (nothing is of the 2020s and French)");
});

test("the quality rule still applies inside the exempt option: a held-back film under the 3.5 floor is not there", () => {
  const ix = readyOf(worldObject(["night"]));
  assert.ok(!answer(ix, "moods", NIGHT).includes(POOR));
  assert.equal(eligibleTest(ix, "moods", "night")(ix.films.find((f) => f.name === POOR)), false);
  assert.equal(eligibleTest(ix, "moods", "night")(ix.films.find((f) => f.name === SHOW)), true);
});

test("only the exempt mood: another option of Moods, Explore (with and without menus) and Search keep the rule; the exemption is by mood id, not by catalog", () => {
  const ix = readyOf(worldObject(["night"]));
  assert.ok(!answer(ix, "moods", LIFT).includes(SHOW), "the other mood, where the same film fits too");
  assert.ok(answer(ix, "moods", LIFT).includes(GIG));
  for (const q of ["", "decade=2020s", "country=South%20Korea", "decade=2020s&country=South%20Korea", "rating=4.2%2B", "genre=Music"]) assert.ok(!answer(ix, "explore", q).includes(SHOW), `explore ${q}`);
  assert.equal(eligibleTest(ix, "moods", "lift")(ix.films.find((f) => f.name === SHOW)), false);
  assert.equal(eligibleTest(ix, "moods")(ix.films.find((f) => f.name === SHOW)), false, "Moods asked with no mood: the rule");
  assert.equal(eligibleTest(ix, "explore", "night")(ix.films.find((f) => f.name === SHOW)), false, "Explore with a mood id (never asked so): the rule");
  assert.ok(!answer(ix, "search", "search=korean").includes(SHOW), "Search by a cut still does not bring it");
  assert.ok(answer(ix, "search", "search=arena").includes(SHOW), "and by its name it still does");
});

test("a key naming no mood of the index exempts nothing; a list of two exempts both; an empty list is no exemption", () => {
  assert.ok(!answer(readyOf(worldObject(["nope"])), "moods", NIGHT).includes(SHOW));
  assert.ok(!answer(readyOf(worldObject([])), "moods", NIGHT).includes(SHOW));
  const both = readyOf(worldObject(["night", "lift"]));
  assert.ok(answer(both, "moods", NIGHT).includes(SHOW) && answer(both, "moods", LIFT).includes(SHOW));
});

test("the exemption survives the file format: the key is in rules after encode and decode, and the films' bits are the ones of the index without it", () => {
  const withKey = worldObject(["night"]), without = worldObject();
  const a = rows.encode(withKey), b = rows.encode(without);
  assert.deepEqual(a.rules.musicExemptMoods, ["night"]);
  assert.deepEqual(a.films, b.films, "not one film changes: the bit is still on the show, the Worker reads the mood");
  assert.ok(answer(readyOf(JSON.parse(JSON.stringify(withKey))), "moods", NIGHT).includes(SHOW));
});

// ── the profiles keep the rule even for the exempt mood (end to end through the handler) ──────────────────

const DIR = "https://pages.test/mood-engine/data/";
const ENV = { INDEX_URL: `${DIR}index.json` };
function profileFiles(heldNames, exempt) {
  const o = PF.makeObject();
  o.films = o.films.map((f) => ({ ...f })); // the fixture's films are shared by every caller: never mark them in place
  for (const f of o.films) if (heldNames.includes(f.name)) f.musicOut = true;
  if (exempt) o.rules = { ...(o.rules || {}), musicExemptMoods: exempt };
  const out = { "index.json": JSON.stringify(rows.encode(o)) };
  for (const p of exporter.pieces(o)) out[p.rel.split("/").pop()] = JSON.stringify(rows.encode(p.obj));
  return out;
}
function rig(files, now) {
  const fetchImpl = async (url) => { const name = url.slice(DIR.length); return files[name] ? new Response(files[name]) : new Response("not found", { status: 404 }); };
  const subtitles = { list: async () => ({ subs: [] }), exact: async () => ({ status: "none", ids: new Set() }) };
  const handle = createHandler({ store: createStore({ fetchImpl, caches: undefined, log: () => {} }), subtitles, now });
  return async (path) => {
    const res = await handle(new Request("https://mood-engine.example.workers.dev" + path), ENV, undefined);
    const json = res.headers.get("content-type")?.includes("json") ? JSON.parse(await res.text()) : null;
    return { status: res.status, ids: json && json.metas ? json.metas.map((m) => m.id) : [] };
  };
}
const HELD = ["Night 1", "Night Watchlist Short", "Horror Both Lists", "Closet Most Picked"];
const DAY0 = Date.parse("2026-10-11T23:00:00Z");

test("the profiles: with the mood of their rows exempt in the index, Tonight, Under 100 min and a theme still do not recommend a held-back film (the exemption is the Moods menu's alone)", async () => {
  const tt = PF.tt, held = rig(profileFiles(HELD, ["night"]), () => DAY0), free = rig(profileFiles([], ["night"]), () => DAY0);
  assert.ok((await free("/p/night/catalog/movie/short.json")).ids.includes(tt("Night Watchlist Short")), "control: not held back, it is there");
  assert.ok(!(await held("/p/night/catalog/movie/short.json")).ids.includes(tt("Night Watchlist Short")));
  assert.ok((await free("/p/night/catalog/movie/theme-horror.json")).ids.includes(tt("Horror Both Lists")), "control");
  assert.ok(!(await held("/p/night/catalog/movie/theme-horror.json")).ids.includes(tt("Horror Both Lists")));
  let drawn = 0, drawnHeld = 0;
  for (let d = 0; d < 15; d++) {
    const at = DAY0 + d * 86400e3;
    const a = await rig(profileFiles([], ["night"]), () => at)("/p/night/catalog/movie/tonight.json"), b = await rig(profileFiles(HELD, ["night"]), () => at)("/p/night/catalog/movie/tonight.json");
    if (a.ids.includes(tt("Night 1"))) drawn++;
    if (b.ids.some((id) => HELD.map(tt).includes(id))) drawnHeld++;
  }
  assert.ok(drawn >= 1, `control: Night 1 is drawn on ${drawn} of 15 days when it is not held back`);
  assert.equal(drawnHeld, 0, "held back, never drawn, whatever the index says about the mood");
});
