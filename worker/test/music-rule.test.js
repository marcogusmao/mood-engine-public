// The music rule in the Worker (Marco, 22/10/2026 ~06:40 UTC: "extend rule D to all the rows and to the cuts by country and decade"). The build writes bit 8 of a film's flags (`musicOut`, lib/pool.js
// musicGate: a music film he has not seen and has no evidence for); the film stays `eligible`. The Worker serves what RECOMMENDS from `recommendable` = eligible and not held back:
// Moods and Explore with every menu on top (decade, runtime, country, rating), and the profiles' Tonight, Under 100 min and themes. It does NOT apply to Search (asking for a film by its name is not a
// recommendation), to Lists, Lists (unseen), Friends, to the Board rows (the build filtered them) or to the profiles' watchlist and curators' rows. An index without the bit behaves exactly as before.
// The world is small and invented (fixture.js, profile-fixture.js); test/real-index.test.js has the real index.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHandler } from "../src/handler.js";
import { createStore } from "../src/store.js";
import { select, page, eligibleTest, RECOMMENDING } from "../src/catalogs.js";
import { parseExtras } from "../src/extras.js";
import { LIVE_WORDS } from "../src/search.js";
import { words } from "../src/text.js";
import { makeObject, readyOf, names } from "./fixture.js";
import * as PF from "./profile-fixture.js";

const require = createRequire(import.meta.url);
const rows = require("../../lib/index-rows.js");
const pool = require("../../lib/pool.js");
const exporter = require("../../lib/index-export.js");

// ── catalogs: a small index with a show the build holds back ─────────────────

const film = (tt, name, x = {}) => {
  const e = {
    tt, name, year: 2024, decade: "2020s", runtime: 100, countries: ["South Korea"], director: `Director of ${name}`, lbRating: 4.6, rank: 9, eligible: true, moods: { night: [1.9, 9] }, lists: { crit: 11 }, genres: ["Documentary", "Music"],
    keywords: ["concert", "k-pop"], desc: `${name} cast\n${name} genres.\n\nA synopsis of ${name}.`, ...x,
  };
  e.find = " " + [e.name, e.director, e.keywords.join(" "), e.genres.join(" "), e.countries.join(" ")].map(words).join(" | "); // the build's `find`: title | director | keywords | genres | countries
  return e;
};
function worldObject({ held = true } = {}) {
  const o = makeObject();
  const show = film("tt0000101", "Arena Tour Film", held ? { musicOut: true } : {});
  const gig = film("tt0000102", "Evidence Gig", { rank: 8.9, moods: { night: [1.9, 8.9] }, director: "Another Director" });
  o.films.push(show, gig);
  o.films.sort((a, b) => (b.rank ?? -Infinity) - (a.rank ?? -Infinity) || a.tt.localeCompare(b.tt));
  o.meta.count = o.films.length;
  o.friends.options[0].ids.push(show.tt); // a friend's option holds the show
  o.rows.tonight = [...o.rows.tonight, show.tt]; // and so does a Board row (the build filtered it: here it is hand-made)
  return o;
}
const ix = readyOf(worldObject());
const answer = (index, id, q) => names(select(index, id, parseExtras(q)).entries);
const SHOW = "Arena Tour Film", GIG = "Evidence Gig";

test("the Film getters: the bit is read from the flags; held back is not ineligible; an index without the bit reads false (the fallback)", () => {
  const show = ix.films.find((f) => f.name === SHOW), gig = ix.films.find((f) => f.name === GIG);
  assert.deepEqual([show.eligible, show.musicOut, show.recommendable], [true, true, false]);
  assert.deepEqual([gig.eligible, gig.musicOut, gig.recommendable], [true, false, true]);
  const old = readyOf(worldObject({ held: false })).films.find((f) => f.name === SHOW);
  assert.deepEqual([old.eligible, old.musicOut, old.recommendable], [true, false, true]);
  // a film that is not eligible is not recommendable whatever its bits say
  const low = ix.films.find((f) => f.name === "Just Below The Floor");
  assert.deepEqual([low.eligible, low.recommendable], [false, false]);
});

test("Moods and Explore do not recommend a held-back film, with every menu on top; the control: the same film is there without the bit", () => {
  const old = readyOf(worldObject({ held: false }));
  const cases = [["moods", "genre=Nocturnal"], ["explore", ""], ["explore", "decade=2020s"], ["explore", "country=South%20Korea"], ["explore", "runtime=90%E2%80%93120%20min"], ["explore", "rating=4.2%2B"],
    ["moods", "genre=Nocturnal&decade=2020s&country=South%20Korea&runtime=90%E2%80%93120%20min&rating=4.2%2B"], ["explore", "decade=2020s&country=South%20Korea"]];
  for (const [id, q] of cases) {
    assert.ok(!answer(ix, id, q).includes(SHOW), `${id} ${q}: the held-back show is recommended`);
    assert.ok(answer(ix, id, q).includes(GIG), `${id} ${q}: the film with evidence is there`);
    assert.ok(answer(old, id, q).includes(SHOW), `control, ${id} ${q}: without the bit the show is there`);
  }
  assert.equal(eligibleTest(ix, "moods")(ix.films.find((f) => f.name === SHOW)), false);
  assert.equal(eligibleTest(ix, "search")(ix.films.find((f) => f.name === SHOW)), true, "Search reads `eligible` alone");
  assert.deepEqual([...RECOMMENDING].sort(), ["explore", "moods"]);
});

test("a page is the first hundred RECOMMENDABLE films in the catalog's order: the held-back ones fill no gap and count in no skip", () => {
  const o = worldObject();
  const extra = Array.from({ length: 150 }, (_, i) => film(`tt${String(2000 + i).padStart(7, "0")}`, `Plain ${i}`, { rank: 5 - i / 100, moods: undefined, lists: undefined, musicOut: i % 2 === 0 ? true : undefined }));
  o.films.push(...extra);
  o.films.sort((a, b) => (b.rank ?? -Infinity) - (a.rank ?? -Infinity) || a.tt.localeCompare(b.tt));
  o.meta.count = o.films.length;
  const big = readyOf(o);
  const keep = o.films.filter((f) => f.eligible && !f.seen && !f.musicOut).map((f) => f.name);
  const p1 = page(big, "explore", {}), p2 = page(big, "explore", { skip: "100" });
  assert.deepEqual(p1.entries.map((e) => e.name), keep.slice(0, 100));
  assert.deepEqual(p2.entries.map((e) => e.name), keep.slice(100, 200));
});

test("Search, Lists, Lists (unseen), Friends and a Board row keep the held-back film: asking for it by name, a curator's list, a friend's option and the build's own row are not recommendations", () => {
  assert.ok(answer(ix, "search", "search=arena").includes(SHOW), "Search finds it by name");
  assert.ok(answer(ix, "search", "search=arena&decade=2020s").includes(SHOW), "with a menu on top");
  const crit = "genre=All-time%20Criterion%20Closet%20Picks%20(closetpicks)";
  assert.ok(answer(ix, "lists", crit).includes(SHOW));
  assert.ok(answer(ix, "lists-unseen", crit).includes(SHOW));
  assert.ok(answer(ix, "lists-unseen", crit + "&decade=2020s&country=South%20Korea").includes(SHOW), "and with the menus on top: Lists apply none of the rules");
  assert.ok(answer(ix, "friends", "genre=Top%20%C2%B7%20Gustavo").includes(SHOW));
  assert.ok(answer(ix, "tonight", "").includes(SHOW), "a Board row is served as the build made it");
  assert.equal(eligibleTest(ix, "lists"), null);
  assert.equal(eligibleTest(ix, "friends"), null);
  assert.equal(eligibleTest(ix, "tonight"), null);
  // a held-back film that is NOT eligible is still out of Search (the quality rule is unchanged)
  const o = worldObject();
  o.films.find((f) => f.name === SHOW).eligible = false;
  delete o.films.find((f) => f.name === SHOW).eligible;
  assert.ok(!answer(readyOf(o), "search", "search=arena").includes(SHOW));
});

test("Search is a cut too: a search by country, decade, genre or keyword does not bring a held-back film (the four of the review: korean, south korea 2020s, concert, music documentary), a search by its TITLE does; the control: without the bit all of them bring it", () => {
  const old = readyOf(worldObject({ held: false }));
  const top10 = (index, q) => answer(index, "search", `search=${q}`).slice(0, 10);
  for (const q of ["korean", "south+korea+2020s", "concert", "music+documentary", "k-pop", "documentary", "2020s", "under+120+min", "south+korea", "night"]) {
    assert.ok(!answer(ix, "search", `search=${q}`).includes(SHOW), `${q}: the held-back show is in the answer`);
    assert.ok(top10(old, q).includes(SHOW) || q === "night" || q === "2020s" || q === "under+120+min", `control, ${q}: without the bit the show is among the first ten`);
  }
  for (const q of ["korean", "south+korea+2020s", "concert", "music+documentary"]) {
    assert.ok(top10(ix, q).includes(GIG), `${q}: the film with evidence is there`);
    assert.ok(answer(old, "search", `search=${q}`).includes(SHOW), `control, ${q}`);
  }
  // by the title: any order, a part of it, with a menu on top; a word that is not in the title brings it back out
  for (const q of ["arena", "arena+tour", "tour+arena", "arena+tour+film", "ARENA"]) assert.ok(answer(ix, "search", `search=${q}`).includes(SHOW), `${q}: found by its title`);
  assert.ok(answer(ix, "search", "search=arena&decade=2020s").includes(SHOW), "with a menu on top");
  assert.ok(answer(ix, "search", "search=arena+2020s").includes(SHOW), "a decade next to the title: the title still brings it");
  for (const q of ["arena+korean", "arena+concert"]) assert.ok(!answer(ix, "search", `search=${q}`).includes(SHOW), `${q}: one word is not in the title`);
  // a film that is not held back is found by anything, as before
  assert.ok(answer(ix, "search", "search=korean").includes(GIG) && answer(ix, "search", "search=evidence").includes(GIG));
});

test("Search: a live-show word alone is a term and not a name, so it does not bring a held-back film (concert, live, tour, music, documentary ...), and the Worker's list of them is a superset of the words the build classifies a music film by", () => {
  for (const q of ["concert", "live", "tour", "tour+film", "music+documentary", "conc", "tou", "concerts"]) assert.ok(!answer(ix, "search", `search=${q}`).includes(SHOW), `${q}: a live-show word alone brings the held-back film`);
  assert.ok(answer(ix, "search", "search=arena+tour").includes(SHOW), "next to a word that is a name, a live-show word is fine");
  // the vocabulary: every word of LIVE_KEYWORDS and of the title words of lib/pool.js isMusicFilm is in LIVE_WORDS (a word added to the classification must be added here, or "searching for it" names a whole genre)
  const wordsOf = [...pool.LIVE_KEYWORDS].flatMap((k) => words(k).split(" ")).concat(String(pool.LIVE_TITLE.source).replace(/\\b|[()]/g, "").split("|").flatMap((w) => words(w).split(" ")));
  const missing = [...new Set(wordsOf)].filter((w) => w && !["in", "a", "of"].includes(w) && !LIVE_WORDS.has(w));
  assert.deepEqual(missing, []);
});

test("the file: bit 8 survives the format, and the bits an older Worker reads (1, 2, 4) are where they were", () => {
  const o = worldObject();
  const withBit = rows.encode(o), without = rows.encode(worldObject({ held: false }));
  const at = withBit.cols.indexOf("flags");
  const a = withBit.films.find((r) => r[0] === "tt0000101")[at], b = without.films.find((r) => r[0] === "tt0000101")[at];
  assert.equal(a & 8, 8);
  assert.equal(a & ~8, b, "the other bits are the ones of the index without the music rule");
  assert.deepEqual(rows.decode(JSON.parse(JSON.stringify(withBit))).films.filter((f) => f.musicOut).map((f) => f.tt), ["tt0000101"]);
  assert.ok(withBit.films.filter((r) => r[0] !== "tt0000101").every((r, i) => r[at] === without.films.find((x) => x[0] === r[0])[at]), "no other film changes");
});

// ── the profiles (end to end through the handler) ────────────────────────────

const DIR = "https://pages.test/mood-engine/data/";
const ENV = { INDEX_URL: `${DIR}index.json` };
function profileFiles(heldNames) {
  const o = PF.makeObject();
  o.films = o.films.map((f) => ({ ...f })); // the fixture's films are shared by every caller: never mark them in place
  for (const f of o.films) if (heldNames.includes(f.name)) f.musicOut = true;
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

test("the profiles: Tonight, Under 100 min and a theme do not recommend a held-back film (over forty days of Tonight; the control: without the bit it is drawn); the watchlist, a curator's list and a Board row keep it", async () => {
  const held = rig(profileFiles(HELD), () => DAY0), free = rig(profileFiles([]), () => DAY0);
  const tt = PF.tt;
  // Under 100 min: Night Watchlist Short (90 min, fits Night) is in it, until the build holds it back
  assert.ok((await free("/p/night/catalog/movie/short.json")).ids.includes(tt("Night Watchlist Short")), "control");
  assert.ok(!(await held("/p/night/catalog/movie/short.json")).ids.includes(tt("Night Watchlist Short")));
  // a theme: Horror lists
  assert.ok((await free("/p/night/catalog/movie/theme-horror.json")).ids.includes(tt("Horror Both Lists")), "control");
  assert.ok(!(await held("/p/night/catalog/movie/theme-horror.json")).ids.includes(tt("Horror Both Lists")));
  // Tonight: the best of the Night mood (Night 1, rank 20) is in the top twelve the pick is drawn from
  let drawn = 0, drawnHeld = 0;
  for (let d = 0; d < 40; d++) {
    const at = DAY0 + d * 86400e3;
    const a = await rig(profileFiles([]), () => at)("/p/night/catalog/movie/tonight.json"), b = await rig(profileFiles(HELD), () => at)("/p/night/catalog/movie/tonight.json");
    if (a.ids.includes(tt("Night 1"))) drawn++;
    if (b.ids.some((id) => HELD.map(tt).includes(id))) drawnHeld++;
    assert.ok(!b.ids.includes(tt("Seen Night Top")) && !a.ids.includes(tt("Seen Night Top")), "and a film he has seen is never drawn");
  }
  assert.ok(drawn >= 1, `control: without the bit Night 1 is drawn on ${drawn} of 40 days`);
  assert.equal(drawnHeld, 0, "with the bit no held-back film is ever drawn");
  // what he chose or a curator listed stays
  assert.ok((await held("/p/night/catalog/movie/watchlist.json")).ids.includes(tt("Night Watchlist Short")), "the watchlist row: a film on it is its own evidence");
  assert.ok((await held("/p/critics/catalog/movie/closet-most-picked.json")).ids.includes(tt("Closet Most Picked")), "a curator's list");
  assert.ok((await held("/p/night/catalog/movie/night.json")).ids.includes(tt("Night 1")), "a Board row is served as the build made it");
});
