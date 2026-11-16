// The Worker against the REAL index: the build is run from the committed caches (offline, asking nobody) and the Worker answers from what it wrote.
// Skipped when the caches are not there.
//
// 14/10/2026 (Worker 3.3.0): the build is run WITH a board: the 54 rows of Marco's final Board in his order, under his names, 46 frozen countries, 31 menu options. Until PR5 it was the fixture
// worker/test/fixtures/board-54.json, whose rows the build could not make yet were filters; since PR5 (14/10/2026) it is config.json's own board, the one the nightly build publishes, with the real rows.
// It writes the v2 family next to the legacy files, which are identical to a build with no board (test/legacy-parity.test.js). `handler()` serves only the legacy
// files (every v2 file is a 404: the fallback, and every test written before 3.3.0); `handler({ v2: true })` serves all of them. The tests of the v2 family come after the fallback's.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createPageSource } from "../src/page-source.js";
import { createHandler } from "../src/handler.js";
import { createStore, parseIndex } from "../src/store.js";
import { parseExtras } from "../src/extras.js";
import { select } from "../src/catalogs.js";
import { search as searchIndex } from "../src/search.js";
import { words } from "../src/text.js";
import * as handlerMod from "../src/handler.js";
import * as storeMod from "../src/store.js";
import { handlerOver, pathsOf, sweep, asReference, withoutTonight, withoutMySeries } from "./sweep.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const rows = require(path.join(root, "lib", "index-rows.js")); // the build's own decoder: ground truth for what the Worker should have read
const have = fs.existsSync(path.join(root, "cache", "lists.json")) && fs.existsSync(path.join(root, "data", "letterboxd", "watched.csv"));
const opts = { skip: !have };

// Marco, 28/10/2026 (cards with chips, "T2"): the Worker does not write the line "Mood: …" in a card any more (the mood, the genres and the words are chips), while the STATIC addon still does
// (lib/describe.js; the build and the index do not change today). Every comparison with the static addon is therefore made with the static card WITHOUT that line, so a difference anywhere else
// (credits, actors, a reason line, the synopsis, the separator) still fails. A card that is credits + the "Mood: …" line + the separator + the synopsis becomes credits + the separator + the synopsis.
//
// Marco, 28/10/2026, 20:26 UTC (questionnaire): the Worker's card also puts a long dash in front of a synopsis that starts "MUBI:" ("Watanabe. — MUBI: Meaty action…" on the Mac and the web, where the blank line turns into a space),
// while the static addon's card (lib/describe.js, which this change does not touch) keeps the synopsis as the index has it. That is the one more expected difference, and it is limited to a synopsis that starts "MUBI:"
// with a card before it (nothing before it, nothing to separate): the dash is the only character the comparison forgives, so a changed word still fails.
const dropMoodLine = (description, separator = "\n\n") => {
  const at = description.indexOf(separator, description.indexOf("\n") + 1);
  const card = (at < 0 ? description : description.slice(0, at)).split("\n").filter((l, i) => !(i === 1 && l.startsWith("Mood: ")));
  let rest = at < 0 ? "" : description.slice(at);
  if (card.join("").length && rest.startsWith(`${separator}MUBI:`)) rest = `${separator}\u2014 ${rest.slice(separator.length)}`;
  return card.join("\n") + rest;
};

let out = null, cache = null;
function build() {
  if (out) return out;
  cache = fs.mkdtempSync(path.join(os.tmpdir(), "mood-w-cache-"));
  out = fs.mkdtempSync(path.join(os.tmpdir(), "mood-w-out-"));
  for (const f of ["friends.json", "lists.json", "tmdb.json", "directors.json", "imdb-ratings.json"]) fs.copyFileSync(path.join(root, "cache", f), path.join(cache, f));
  if (fs.existsSync(path.join(root, "cache/mubi.json"))) fs.copyFileSync(path.join(root, "cache/mubi.json"), path.join(cache, "mubi.json"));
  const r = spawnSync(process.execPath, ["build.js", "--offline", "--cache-only", "--cache-dir", cache, "--out", out], { cwd: root, encoding: "utf8", env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  stdout = r.stdout;
  return out;
}
let stdout = "";
const buildLog = () => (build(), stdout);
process.on("exit", () => { for (const d of [out, cache]) if (d) fs.rmSync(d, { recursive: true, force: true }); });

const FULL = "https://pages.test/data/index.json", BOARD = "https://pages.test/data/index-board.json";
function handler({ v2 = false, calls = [], logs = null, pieces = true } = {}) {
  const dir = build();
  const fetchImpl = async (url) => {
    const name = path.basename(url);
    calls.push(name);
    if (/^index-v2-opt-/.test(name) && !pieces) return new Response("not found", { status: 404 }); // 29/10/2026: a site whose build wrote no option pieces: the whole v2 index answers the Discover's calculated options, as before
    if (/^index-v2/.test(name) && (!v2 || !fs.existsSync(path.join(dir, "data", name)))) return new Response("not found", { status: 404 }); // the fallback: a site with no v2 family (or a v2 file that is not there)
    // each file is the file the build wrote under that name (a piece is a piece); until 14/10/2026 every piece but the Board's was answered with the WHOLE index, which is what made the
    // 139 lists of the guard test cost 2.3 GB of heap in this process (16 MB a "piece"): the real pieces are 15 MB of text for all of them, about 40 MB of heap
    const named = path.join(dir, "data", name);
    if (/^page-/.test(name) && !fs.existsSync(named)) return new Response("not found", { status: 404 });
    const f = fs.existsSync(named) ? named : path.join(dir, "data", "index.json");
    return new Response(fs.readFileSync(f, "utf8"));
  };
  const h = createHandler({ store: createStore({ fetchImpl, caches: undefined, log: logs ? (o) => logs.push(o) : () => {} }), pages: createPageSource({ fetchImpl, caches: undefined }) });
  return async (p) => {
    const res = await h(new Request("https://w.test" + p), { INDEX_URL: FULL }, undefined);
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text), headers: res.headers };
  };
}
const index = () => rows.decode(JSON.parse(fs.readFileSync(path.join(build(), "data", "index.json"), "utf8"))); // object form, read without the Worker's code

test("real index, manifest with no v2 family published (the fallback): 28 catalogs (20 Board rows, My series, 7 Discover), the menus of the static addon plus the four optional ones, version 3.1.0", opts, async () => {
  const get = handler();
  const m = (await get("/manifest.json")).json;
  assert.equal(m.catalogs.length, 28); // Marco, 11/10/2026: + the Board rows "Slow and still" and "Loved by your directors", the Discover menu "Loved by directors", and the series row My series
  assert.equal(m.catalogs.filter((c) => !c.extra).length, 21, "the 20 film rows and My series (Marco, 11/10/2026)");
  const by = Object.fromEntries(m.catalogs.map((c) => [c.id, c]));
  const n = (c, name) => (c.extra.find((e) => e.name === name) || { options: [] }).options.length;
  const nLists = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).lists.length; // 22/10/2026 (review): counted from config.json, not pinned; the count itself is pinned by test/board-production.test.js, test/catalog-expansion.test.js and test/v2.test.js
  assert.deepEqual([n(by.moods, "genre"), n(by.lists, "genre"), n(by["lists-unseen"], "genre"), n(by.friends, "genre")], [9, nLists, nLists, 21]); // Marco, 23/10/2026: removing World is Hell left 14 Friends options; Marco, 28/10/2026 (answer (b), Discover proposal 5): 21 = 7 Top + "All friends loved" + 7 Watch together + the 6 friends' lists (the static addon has 20: it has no "All friends loved"). Lists are counted from config.json; source-list count assertions live in the tests named above.
  // 22/10/2026 (Marco, ~04:05 UTC): the Lists menus are the short names, one line on the phone (the full name stays in the index as `label`, for the installs made before)
  const shortNames = index().lists.map((l) => l.short);
  assert.ok(shortNames.every((s) => typeof s === "string" && s.length > 0 && s.length <= 28), "every entry is a short name of 28 characters at most");
  assert.deepEqual(by.lists.extra[0].options, shortNames);
  assert.deepEqual(by["lists-unseen"].extra[0].options, shortNames);
  assert.ok(!by.lists.extra[0].options.some((o) => /\(/.test(o)), "no entry carries the author in parentheses");
  assert.deepEqual(by["director-picks"].extra[0].options, index().directors.options.map((o) => o.label), "the directors' menu is the build's");
  assert.ok(by["director-picks"].extra[0].options.length >= 5);
  for (const id of ["moods", "lists", "lists-unseen", "friends", "director-picks", "explore"]) assert.deepEqual([n(by[id], "decade"), n(by[id], "runtime"), n(by[id], "country"), n(by[id], "rating")], [11, 4, 12, 4], id);
  assert.deepEqual(by.explore.extra[0], { name: "genre", isRequired: true, options: ["All"] }, "Explore has a required menu, so it is not on the Board");
  assert.deepEqual(m.catalogs.filter((c) => !(c.extra || []).some((e) => e.isRequired)).map((c) => c.id), m.catalogs.filter((c) => !c.extra).map((c) => c.id), "the catalogs with no required menu — what the Board shows — are the 20 film rows and My series, and nothing else");
  assert.equal(by.search.extra[0].name, "search");
  assert.equal(JSON.parse((await get("/manifest.json")).text).version, "3.1.0");
});

// 22/10/2026 (Marco, ~04:05 UTC). Defect guarded: the older installs (full name in the address) or the new menu (short name) opening an empty page, or the two giving different films.
test("real index: every list answers to its short name and to its full name with the same bytes, in Lists and in Lists (unseen)", opts, async () => {
  const ix = index();
  let get = handler();
  let compared = 0;
  for (const [i, l] of ix.lists.entries()) {
    if (i % 8 === 0) get = handler();
    if (i % 5) continue; // 30 of the 147 lists: the whole 147 x 2 x 2 is a quarter of an hour of 15 MB pieces
    for (const id of ["lists", "lists-unseen"]) {
      const [a, b] = [await get(`/catalog/movie/${id}/genre=${encodeURIComponent(l.short)}.json`), await get(`/catalog/movie/${id}/genre=${encodeURIComponent(l.label)}.json`)];
      assert.equal(a.status, 200, `${id} ${l.short}`);
      assert.equal(a.text, b.text, `${id}: ${l.short} and ${l.label} give different answers`);
      compared++;
    }
  }
  assert.ok(compared >= 56, `${compared} comparisons`);
});

test("real index, v2.1: the Worker writes the SAME description, IMDb rating and cover as the static addon, film by film, for every Board file; Board rows carry their own mood line; the index's rules are the ones in force", opts, async () => {
  const dir = build();
  const get = handler();
  const man = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const ix = index();
  assert.deepEqual([ix.rules.minStars, ix.rules.exemptCatalogs], [3.5, ["lists", "lists-unseen", "friends"]]);
  const first = await get("/catalog/movie/explore.json");
  assert.equal(first.headers.get("x-floor"), "3.5 from index", "the rules came from the index, not from the Worker's defaults");
  assert.equal((await get("/manifest.json")).headers.get("x-floor"), "3.5 from index");
  let compared = 0, ownReasons = 0, dashed = 0;
  for (const c of man.catalogs.filter((x) => !x.extra)) {
    const static_ = JSON.parse(fs.readFileSync(path.join(dir, "catalog", "movie", `${c.id}.json`), "utf8")).metas;
    const live = (await get(`/catalog/movie/${c.id}.json`)).json.metas;
    const byId = new Map(live.map((m) => [m.id, m]));
    for (const m of static_) {
      const w = byId.get(m.id);
      assert.ok(w, `${c.id}: ${m.name} is served by the Worker`);
      assert.equal(w.description, dropMoodLine(m.description), `${c.id}: ${m.name} reads the same in both addons (credits, actors, the row's reason, synopsis; the "Mood: …" line is the static addon's alone, since 28/10/2026)`);
      assert.ok(!w.description.includes("Mood: "), `${c.id}: ${m.name}: the Worker writes no "Mood: …" line`);
      if (w.description.includes("\n\n\u2014 MUBI:")) dashed++;
      assert.equal(w.description.includes("\n\n\u2014 MUBI:"), m.description.includes("\n\nMUBI:"), `${c.id}: ${m.name}: the dash is there exactly when the static synopsis starts "MUBI:"`);
      assert.equal(w.imdbRating, m.imdbRating, `${c.id}: ${m.name} IMDb`);
      if (!/images\.metahub\.space/.test(m.poster)) assert.equal(w.poster, m.poster, `${c.id}: ${m.name} cover`);
      compared++;
      if (m.description.split("\n\n")[0].split("\n").some((l) => l.startsWith("Mood: "))) ownReasons++; // the card says the mood of its row
    }
    assert.deepEqual(live.map((m) => m.id), static_.map((m) => m.id), `${c.id}: same films, same order`);
  }
  assert.ok(compared > 300 && ownReasons > 200, `${compared} Board films compared, ${ownReasons} with a mood line`);
  assert.ok(dashed > 100, `${dashed} Board cards with the dash before a "MUBI:" synopsis (a comparison that never meets one proves nothing)`);
  // Discover: line 1 of every film the Worker serves is the credits line its entry's columns and `desc` make (no ★, no country, no year), and there is no numbers line
  const byTt = new Map(ix.films.map((f) => [f.tt, f]));
  const { creditsLine, CAST_SEP } = await import("../src/meta.js");
  for (const url of ["/catalog/movie/moods/genre=Nocturnal.json", "/catalog/movie/explore/decade=1970s.json", "/catalog/movie/search/search=japanese+1990s.json", "/catalog/movie/explore/rating=4.0%E2%80%934.2.json"]) {
    for (const m of (await get(url)).json.metas) {
      const e = byTt.get(m.id);
      const desc = m.description || "";
      const first = desc.split("\n")[0];
      assert.equal(first, creditsLine({ directors: e.director ? e.director.split(", ") : [], runtime: e.runtime, cast: String(e.desc || "").split("\n")[0].split(CAST_SEP) }), `${url}: ${m.name}`);
      assert.ok(!/★|IMDb \d|want to see|Friends \d/.test(desc), `${url}: ${m.name} has a star or a numbers line`);
      assert.ok(first.length <= 80 || first.split(" · ").pop().split(", ").length <= 2, `${url}: ${m.name}: credits line of ${first.length} characters`); // two actors stay whatever the length (Marco, 21/10/2026, D4)
    }
  }
  // Marco, 28/10/2026 (cards with chips): until then line 2 started "Mood: <the mood's NAME>" in the Moods menu and "Mood: <the mood the film fits best>" in Lists and Friends (D3, 21/10/2026). The phrase is not written any more;
  // the mood is a chip of the Mood group. This legacy index holds nine moods in `moods` (the best fit of the phrase was worked out over the 30 of config.json, which the chips cannot use here), so what is checked is that the card
  // has no phrase and no place in a list (#12), and how many cards carry a chip of one of the index's own moods.
  const dryName = (x) => x.replace(/^[\p{Extended_Pictographic}\u200d\ufe0f\s]+/u, "");
  // a mood chip is told by its SEARCH URL (the menu label of the mood), not by its name: a genre chip or a term can carry the same word ("Horror")
  const moodUrl = (label) => `stremio:///search?search=${encodeURIComponent(label)}`;
  const moodUrls = new Set(ix.moods.map((m) => moodUrl(m.label)));
  const hasMoodChip = (m) => (m.links || []).some((l) => l.category === "Mood" && moodUrls.has(l.url));
  const mood = async (url, name) => {
    const metas = (await get(url)).json.metas;
    assert.ok(metas.length > 0, url);
    for (const m of metas) assert.ok(!m.description.includes("Mood: ") && (m.links || []).some((l) => l.category === "Mood" && l.url === moodUrl(ix.moods[0].label)), `${url}: ${m.name}: no phrase, and the menu's mood "${dryName(name)}" is a chip`);
  };
  const bestFit = async (url, share) => { // share: the part of the cards that must carry a chip of one of the index's moods (a list shows the films Marco has seen too, and a film he has seen fits no mood)
    const metas = (await get(url)).json.metas;
    assert.ok(metas.length > 0, url);
    let labelled = 0;
    for (const m of metas) {
      assert.ok(!m.description.includes("Mood: "), `${url}: ${m.name}: no phrase`);
      assert.ok(!/^[^\n]*#\d/.test(m.description), `${url}: ${m.name}`);
      if (hasMoodChip(m)) labelled++;
    }
    console.log(`# ${url.slice(0, 60)}: ${labelled} of ${metas.length} cards carry a chip of one of the index's moods`);
    assert.ok(labelled > metas.length * share, `${url}: ${labelled} of ${metas.length} carry a chip of one of the index's moods`); // strict: with share 0 at least ONE card must carry the chip
  };
  const enc = (x) => encodeURIComponent(x);
  await bestFit(`/catalog/movie/lists/genre=${enc(ix.lists[0].label)}.json`, 0);
  await bestFit(`/catalog/movie/lists-unseen/genre=${enc(ix.lists[0].label)}.json`, 1 / 3);
  await mood(`/catalog/movie/moods/genre=${enc(ix.moods[0].label)}.json`, ix.moods[0].name);
  await bestFit(`/catalog/movie/friends/genre=${enc(ix.friends.options[0].label)}.json`, 0);
});

test("real index: the same filters in a different order give byte-for-byte the same answer (3 queries, then every order of 4 menus)", opts, async () => {
  const get = handler();
  const pairs = [
    ["/catalog/movie/moods/genre=Nocturnal&decade=1990s.json", "/catalog/movie/moods/decade=1990s&genre=Nocturnal.json"],
    ["/catalog/movie/lists/genre=Cannes%20Winners%20(moviewithus)&country=France&rating=4.2%2B.json", "/catalog/movie/lists/rating=4.2%2B&genre=Cannes%20Winners%20(moviewithus)&country=France.json"],
    ["/catalog/movie/explore/decade=1970s&country=Japan.json", "/catalog/movie/explore/country=Japan&decade=1970s.json"],
  ];
  for (const [a, b] of pairs) {
    const [x, y] = [await get(a), await get(b)];
    assert.equal(x.status, 200);
    assert.ok(x.json.metas.length > 0, `${a} found something`);
    assert.equal(x.text, y.text, a);
  }
  const menus = ["decade=1980s", "runtime=90%E2%80%93120%20min", "country=United%20States", "rating=4.0%E2%80%934.2"];
  const perms = (xs) => (xs.length < 2 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
  const bodies = new Set();
  for (const p of perms(menus)) bodies.add((await get(`/catalog/movie/explore/${p.join("&")}.json`)).text);
  assert.equal(bodies.size, 1, "24 orders, one answer");
  assert.ok(JSON.parse([...bodies][0]).metas.length > 0);
});

test("real index: every filtered answer really has the fact it was filtered by (decade in the title's year, runtime in the bucket, the country, the rating bucket)", opts, async () => {
  const ix = index();
  const byTt = new Map(ix.films.map((f) => [f.tt, f]));
  const get = handler();
  const r = (await get("/catalog/movie/explore/decade=1960s&country=France&runtime=90%E2%80%93120%20min&rating=4.0%E2%80%934.2.json")).json.metas;
  assert.ok(r.length > 0);
  for (const m of r) {
    const e = byTt.get(m.id);
    assert.equal(e.decade, "1960s");
    assert.ok(e.countries.includes("France"));
    assert.ok(e.runtime >= 90 && e.runtime <= 120);
    const v = e.lbRating ?? e.tmdbRating / 2;
    assert.ok(v >= 4.0 && v < 4.2, `${e.name} ${v}`);
    assert.equal(m.releaseInfo, String(e.year));
  }
});

test("real index, the guard restated: no film you have seen in any catalog but Lists and Old friends — every Board row, every mood, list (unseen), friends option, Explore pages and 40 searches; checked against the index's own flag AND against watched.csv", opts, async () => {
  const ix = index();
  const byTt = new Map(ix.films.map((f) => [f.tt, f]));
  // an independent check: your Letterboxd export, title and year (±1, like the build's own title net)
  const csv = fs.readFileSync(path.join(root, "data", "letterboxd", "watched.csv"), "utf8").split(/\r?\n/).slice(1);
  const watched = new Map();
  for (const line of csv) {
    const m = line.match(/^[^,]*,("(?:[^"]|"")*"|[^,]*),(\d{4}),/);
    if (!m) continue;
    const k = words(m[1].replace(/^"|"$/g, "").replace(/""/g, '"'));
    (watched.get(k) || watched.set(k, []).get(k)).push(Number(m[2]));
  }
  assert.ok(watched.size > 1000, `${watched.size} watched titles read`);
  let get = handler();
  let checked = 0;
  const check = async (url, exempt = false) => {
    const res = await get(url);
    assert.equal(res.status, 200, url);
    for (const meta of res.json.metas) {
      checked++;
      assert.ok(/^tt\d+$/.test(meta.id), `${url}: ${meta.id}`);
      if (exempt) continue;
      assert.ok(!byTt.get(meta.id).seen, `${url}: ${meta.name} is flagged seen`);
      const years = watched.get(words(meta.name)) || [];
      assert.ok(!years.some((y) => Math.abs(y - Number(meta.releaseInfo)) <= 1), `${url}: ${meta.name} (${meta.releaseInfo}) is in your watched.csv`);
    }
    return res.json.metas.length;
  };
  for (const r of ix.board) await check(`/catalog/movie/${r.id}.json`, r.id === "oldfriends");
  for (const m of ix.moods) { await check(`/catalog/movie/moods/genre=${encodeURIComponent(m.label)}.json`); await check(`/catalog/movie/moods/genre=${encodeURIComponent(m.label)}&decade=1980s.json`); }
  // 14/10/2026: a new handler every 8 lists keeps the process small (the store now lets go of the least recently used pieces by itself: src/store.js)
  for (const [i, l] of ix.lists.entries()) { if (i % 8 === 0) get = handler(); await check(`/catalog/movie/lists-unseen/genre=${encodeURIComponent(l.label)}.json`); await check(`/catalog/movie/lists-unseen/genre=${encodeURIComponent(l.label)}&skip=100.json`); }
  for (const o of ix.friends.options) await check(`/catalog/movie/friends/genre=${encodeURIComponent(o.label)}.json`);
  for (const skip of [0, 100, 200, 300, 400, 500, 1000, 3000]) await check(`/catalog/movie/explore/skip=${skip}.json`);
  for (const d of ix.meta.decades) await check(`/catalog/movie/explore/decade=${d}.json`);
  const queries = ["kubrick", "godard", "cassavetes", "bergman", "lynch", "tarkovsky", "cannes", "criterion", "indiewire", "closet", "nocturnal", "wicked", "uplift", "wanderlust", "catharsis", "reinvention", "60s", "1970s", "90s", "japan", "french", "brazilian", "soviet", "90 min", "under 80 min", "over 150 min", "short", "long", "gustavo loved", "william wants", "friend-e", "friend-d", "the", "night", "love", "man", "war", "red", "city", "dream"];
  for (const q of queries) await check(`/catalog/movie/search/search=${encodeURIComponent(q)}.json`);
  assert.ok(checked > 3000, `${checked} films checked`);
  // and the exemption is real: Lists (whole) does serve films you have seen, in the curator's order
  const lists = ix.lists[0];
  const whole = (await get(`/catalog/movie/lists/genre=${encodeURIComponent(lists.label)}.json`)).json.metas;
  assert.ok(whole.some((m) => byTt.get(m.id).seen), "the whole list includes films you have seen, on purpose");
  assert.ok(whole.length > (await get(`/catalog/movie/lists-unseen/genre=${encodeURIComponent(lists.label)}.json`)).json.metas.length);
});

test("real index, the recommendation rule: everything Explore, Moods and Search serve passes the build's rule (recomputed here from the caches by lib/recommendation-quality.js), with and without menus; Lists, Lists (unseen), Friends and the Board show films that do not; a film a favourite director loves skips the floor", opts, async () => {
  const ix = index();
  const byTt = new Map(ix.films.map((f) => [f.tt, f]));
  const F = require(path.join(root, "lib", "friends.js")), Q = require(path.join(root, "lib", "recommendation-quality.js"));
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  // Marco, 11/10/2026 (decision 5), ONE exception: a critic or director list, or a favourite director's love (high/medium source), needs no
  // floor. The list half is recomputed from the same caches; the director half needs the taste model, so a film the rule and the lists keep
  // out may be eligible only if a favourite director (the build's log names them) loves it in data/directors-loved.json.
  const fc = F.loadCache(path.join(root, "cache", "friends.json"));
  // Marco, 22/10/2026 ~06:40 UTC: the rule has one more condition, a film TMDB was asked about and has no record of (cache/tmdb.json); such a film is not eligible whatever its average
  const tmdbOfCache = new (require(path.join(root, "lib", "tmdb.js")).Tmdb)("unused: nothing is asked", path.join(root, "cache", "tmdb.json"));
  const ratings = Q.index({ ...F.viewFriends(fc, cfg), films: require(path.join(root, "lib", "static-lists.js")).filmsFor(cfg, root, fc.films) }, { vouched: require(path.join(root, "lib", "list-signal.js")).vouchedFromCaches({ cfg, listsCache: JSON.parse(fs.readFileSync(path.join(root, "cache", "lists.json"), "utf8")), films: fc.films }), unrecorded: ({ imdbId, tmdbId }) => tmdbOfCache.noRecord(imdbId, tmdbId) });
  // only the films a FAVOURITE director loves (the favourites the build printed), not every film of the file (review S4-6)
  const lovedFile = require(path.join(root, "test-support", "loved-favourites.js")).lovedByFavourites(buildLog(), root);
  const inMenu = new Set(ix.directors.options.flatMap((o) => o.ids));
  const qualifies = (tt) => Q.qualifies(ratings.get(tt)) || (lovedFile.has(tt) && !!(byTt.get(tt) || {}).eligible);
  assert.ok(ix.films.every((f) => !!f.eligible === Q.qualifies(ratings.get(f.tt)) || (lovedFile.has(f.tt) && f.eligible)), "the flag in the index is the rule, film by film, or the directors' half of the exception");
  assert.ok(ix.films.every((f) => !inMenu.has(f.tt) || f.eligible), "every film of the directors' menu is eligible (the exception)");
  assert.ok([...inMenu].filter((tt) => !Q.qualifies(ratings.get(tt))).length > 20, "the exception lets in films under the floor");
  const unseen = ix.films.filter((f) => !f.seen);
  assert.ok(unseen.filter((f) => !f.eligible).length > 500, "there are films the rule keeps out, for the test to hide");
  const get = handler();
  const outside = async (url) => (await get(url)).json.metas.filter((m) => !qualifies(m.id)).map((m) => m.name);
  for (const url of [
    "/catalog/movie/explore.json", "/catalog/movie/explore/skip=100.json", "/catalog/movie/explore/skip=3000.json", "/catalog/movie/explore/skip=5000.json", "/catalog/movie/explore/decade=2010s.json",
    "/catalog/movie/explore/country=France&decade=1970s&rating=3.8%E2%80%934.0.json", "/catalog/movie/explore/runtime=Under%2090%20min&country=Japan.json", "/catalog/movie/explore/rating=Under%203.8.json", "/catalog/movie/explore/rating=4.0%E2%80%934.2&skip=1000.json",
    "/catalog/movie/moods/genre=Wicked.json", "/catalog/movie/moods/genre=Uplift&decade=1980s.json", "/catalog/movie/moods/genre=Wanderlust&country=Brazil.json",
    "/catalog/movie/search/search=horror.json", "/catalog/movie/search/search=comedy.json", "/catalog/movie/search/search=80s.json", "/catalog/movie/search/search=90+min.json", "/catalog/movie/search/search=the.json", "/catalog/movie/search/search=gustavo+loved.json",
  ]) assert.deepEqual(await outside(url), [], url);
  // Each exempt collection must independently show films that fail the rule.
  // Review counts after the cut: 9 in these Lists unseen pages, 2 in Watch together,
  // 10 across all Friends options. A combined total could hide either lost exemption.
  let shownLists = 0;
  for (const l of ix.lists.slice(0, 12)) {
    shownLists += (await outside(`/catalog/movie/lists-unseen/genre=${encodeURIComponent(l.label)}.json`)).length;
  }
  assert.ok(shownLists > 0, `${shownLists} films that fail the rule in Lists unseen; Lists must stay exempt`);
  let shownFriends = 0;
  for (const o of ix.friends.options) {
    shownFriends += (await outside(`/catalog/movie/friends/genre=${encodeURIComponent(o.label)}.json`)).length;
  }
  assert.ok(shownFriends > 0, `${shownFriends} films that fail the rule in Friends; Friends must stay exempt`);
  // and a Board row is whatever the build made it: served whole
  for (const r of ix.board) assert.equal((await get(`/catalog/movie/${r.id}.json`)).json.metas.length, ix.rows[r.id].filter((tt) => r.id === "oldfriends" || !byTt.get(tt).seen).length);
});

test("real index, the music rule (Marco, 22/10/2026 ~06:40 UTC): the films the build holds back (bit 8) are in no Moods or Explore answer of the Worker, with or without menus, nor in the static cuts, they are found by Search and shown in Lists; the same index with the bit cleared serves them", opts, async () => {
  const ix = index();
  const held = ix.films.filter((f) => f.musicOut);
  assert.ok(held.length >= 10, `${held.length} films are held back`);
  assert.ok(held.every((f) => !f.seen), "never a film he has seen");
  const text = fs.readFileSync(path.join(build(), "data", "index.json"), "utf8");
  const real = parseIndex(text);
  // the same file with bit 8 cleared in every row: an index from before the rule
  const file = JSON.parse(text), at = file.cols.indexOf("flags");
  for (const r of file.films) if (r[at]) { r[at] &= ~8; if (!r[at]) r[at] = null; }
  const old = parseIndex(JSON.stringify(file));
  const bad = new Set(held.map((f) => f.tt));
  const answers = (index_, id, q) => select(index_, id, parseExtras(q)).entries.map((e) => e.tt);
  // Marco, 22/10/2026 ~15:15 UTC ("Music 1 of 4"): the Moods option of the mood Music is exempt (the index names it in rules.musicExemptMoods); every other option below keeps the rule
  const exemptIds = (real.rules && real.rules.musicExemptMoods) || [];
  assert.deepEqual(exemptIds, ["music"]);
  const urls = [["explore", ""], ["explore", "decade=2020s"], ["explore", "decade=2010s&country=United%20Kingdom"], ["explore", "country=South%20Korea"], ["explore", "runtime=Under%2090%20min"], ["explore", "rating=4.2%2B"],
    ...real.moods.filter((m) => !exemptIds.includes(m.id)).map((m) => ["moods", `genre=${encodeURIComponent(m.label)}`])];
  let controlled = 0;
  for (const [id, q] of urls) {
    const now = answers(real, id, q).filter((tt) => bad.has(tt));
    assert.deepEqual(now, [], `${id} ${q}: held-back films are recommended`);
    controlled += answers(old, id, q).filter((tt) => bad.has(tt)).length;
  }
  assert.ok(controlled >= 20, `control: the index with the bit cleared recommends them ${controlled} times in the same answers`);
  // the one exception: the Music option shows them, with the menus on top, and only the held-back films that pass the quality rule (`eligible`)
  const musicLabel = encodeURIComponent(real.moods.find((m) => m.id === "music").label);
  for (const [menu, atLeast] of [["", 20], ["&decade=2020s", 5], ["&country=South%20Korea", 1]]) {
    const shown = answers(real, "moods", `genre=${musicLabel}${menu}`).filter((tt) => bad.has(tt));
    assert.ok(shown.length >= atLeast, `Moods Music ${menu}: ${shown.length} held-back films, at least ${atLeast} expected`);
    assert.ok(shown.every((tt) => real.films.find((f) => f.tt === tt).eligible), "and every one passes the quality rule");
  }
  // five films, side by side: absent from the static addon's cuts and from the Worker's Moods and Explore, found by Search, in the lists that hold them
  const five = held.filter((f) => f.eligible && f.decade && f.countries && f.countries.length).slice(0, 5);
  assert.equal(five.length, 5);
  for (const f of five) {
    const cut = JSON.parse(fs.readFileSync(path.join(build(), "catalog", "movie", "mood-engine-decade", `genre=${f.decade}.json`), "utf8")).metas.map((m) => m.id);
    assert.ok(!cut.includes(f.tt), `${f.name}: in the static cut of ${f.decade}`);
    assert.ok(!answers(real, "explore", `decade=${f.decade}`).includes(f.tt), `${f.name}: in the Worker's Explore of ${f.decade}`);
    assert.ok(!answers(real, "explore", `country=${encodeURIComponent(f.countries[0])}`).includes(f.tt), `${f.name}: in the Worker's Explore of ${f.countries[0]}`);
    assert.ok(answers(real, "search", `search=${encodeURIComponent(f.name)}`).includes(f.tt), `${f.name}: Search does not find it`);
    for (const id of Object.keys(f.lists || {})) {
      const label = real.lists.find((l) => l.id === id).label;
      assert.ok(answers(real, "lists-unseen", `genre=${encodeURIComponent(label)}`).includes(f.tt), `${f.name}: not in the list ${label}`);
    }
  }
  // Search is a cut too (review of 22/10/2026): by country, decade, genre or keyword a held-back film is not in the first ten; by its title it is found
  let before = 0;
  for (const q of ["korean", "south korea 2020s", "concert", "music documentary"]) {
    const now = answers(real, "search", `search=${encodeURIComponent(q)}`).slice(0, 10).filter((tt) => bad.has(tt));
    assert.deepEqual(now, [], `search ${q}: held-back films among the first ten`);
    before += answers(old, "search", `search=${encodeURIComponent(q)}`).slice(0, 10).filter((tt) => bad.has(tt)).length;
    assert.ok(!answers(real, "search", `search=${encodeURIComponent(q)}`).slice(0, 100).some((tt) => bad.has(tt)), `search ${q}: held-back films among the first hundred`);
  }
  assert.ok(before >= 10, `control: with the bit cleared the same four searches bring ${before} of them in their first ten`);
  const named = held.filter((f) => f.eligible).slice(0, 5);
  for (const f of named) assert.ok(answers(real, "search", `search=${encodeURIComponent(f.name)}`).includes(f.tt), `${f.name}: not found by its title`);
  assert.ok(held.some((f) => f.lists && Object.keys(f.lists).length), "some held-back film is in a list (Lists still show them)");
});

test("real index, search: titles, directors and lists are found; the answers are plausible", opts, async () => {
  const ix = index();
  const byTt = new Map(ix.films.map((f) => [f.tt, f]));
  const get = handler();
  const q = async (text) => (await get(`/catalog/movie/search/search=${encodeURIComponent(text)}.json`)).json.metas.map((m) => byTt.get(m.id));
  const kubrick = await q("kubrick");
  assert.ok(kubrick.length > 0 && kubrick.every((e) => /kubrick/i.test(e.director || e.find)), "directed by Kubrick (or the text says so)");
  const cannes = await q("cannes");
  assert.ok(cannes.length > 20 && cannes.every((e) => "f6ZGq" in (e.lists || {})), "every hit is in the Cannes list");
  const jp90 = await q("japanese 1990s");
  assert.ok(jp90.length > 0 && jp90.every((e) => e.decade === "1990s" && e.find.includes(" japan")));
  const gus = await q("gustavo loved");
  assert.ok(gus.every((e) => e.friends.seenBy.some(([n, r]) => n === "Gustavo" && r >= 4)));
  const short = await q("under 80 min");
  assert.ok(short.length > 0 && short.every((e) => e.runtime >= 40 && e.runtime < 80));
});

test("real index, cost: printed, and loosely bounded (the exact figures are bench.mjs's job: it needs a fresh process per request, and this test shares the CPU with the others)", opts, async () => {
  const dir = build();
  const file = (f) => fs.readFileSync(path.join(dir, "data", f), "utf8");
  const text = file("index.json"), board = file("index-board.json"), moods = file("index-moods.json");
  const cpu = (f) => { const a = process.cpuUsage(); const v = f(); const c = process.cpuUsage(a); return { ms: (c.user + c.system) / 1000, v }; };
  const best = (f, n = 5) => Math.min(...Array.from({ length: n }, () => cpu(f).ms));
  const parse = best(() => parseIndex(text)), parseBoard = best(() => parseIndex(board)), parseMoods = best(() => parseIndex(moods));
  const ix = parseIndex(text);
  const run = (id, q) => best(() => JSON.stringify(select(ix, id, parseExtras(q)).entries.slice(0, 100)), 3);
  const q = { explore: run("explore", "decade=1970s&country=Japan"), moods: run("moods", "genre=Nocturnal&decade=1990s"), lists: run("lists", "genre=Cannes%20Winners%20(moviewithus)&country=France"), "search japanese 1990s": run("search", "search=japanese+1990s"), "search night": run("search", "search=night"), "search gustavo loved": run("search", "search=gustavo+loved") };
  console.log(`# index ${(text.length / 1e6).toFixed(2)} MB parses in ${parse.toFixed(1)} ms (best of 5, warm); Board part ${(board.length / 1e3).toFixed(0)} KB ${parseBoard.toFixed(1)} ms; moods piece ${(moods.length / 1e3).toFixed(0)} KB ${parseMoods.toFixed(1)} ms; on a parsed index: ` + Object.entries(q).map(([k, v]) => `${k} ${v.toFixed(1)} ms`).join(", "));
  assert.ok(parse < 100 && parseBoard < 20 && parseMoods < 30, "parsing is within an order of magnitude of what it was");
  assert.ok(parseBoard * 4 < parse, "the Board part is a small fraction of the whole");
  for (const [k, v] of Object.entries(q)) assert.ok(v < 60, `${k} took ${v.toFixed(1)} ms on a parsed index`);
});

test("real index: line 1 of the live addon is line 1 of the static addon, film by film, in every file of the static addon (Board rows, Lists, Loved by directors, Friends, the cuts): the credits are built from the index's columns and `desc`, the static ones from the plan's items", opts, async () => {
  const dir = build();
  const ix = index();
  const byTt = new Map(ix.films.map((f) => [f.tt, f]));
  const { creditsLine, CAST_SEP } = await import("../src/meta.js");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const root0 = path.join(dir, "catalog", "movie");
  let compared = 0, byColumn = 0, differ = 0;
  const staticNoActors = new Set();
  const noActors = (live, stat) => typeof stat === "string" && stat.endsWith(".") && live.startsWith(`${stat.slice(0, -1)} · `); // the class explained below
  const wrong = []; // the first few differences only: a file is read, compared and dropped before the next one is opened
  for (const file of walk(root0)) {
    const rel = path.relative(root0, file);
    for (const m of JSON.parse(fs.readFileSync(file, "utf8")).metas) {
      const e = byTt.get(m.id);
      if (!e) { wrong.push(`${rel}: ${m.name} is not in the index`); continue; }
      const live = creditsLine({ directors: e.director ? e.director.split(", ") : [], runtime: e.runtime, cast: String(e.desc || "").split("\n")[0].split(CAST_SEP) }), stat = m.description.split("\n")[0];
      compared++;
      if (e.country) byColumn++;
      // 20/10/2026 (BACKLOG, "description v3"): a list film whose pool record has no TMDB detail has no actors in the static item, while the index found its own TMDB record by the IMDb id and has them.
      // The static line is then the live line's director and duration alone. Only that class is let through, and it is counted: three films on 20/10/2026.
      if (live !== stat && noActors(live, stat)) { staticNoActors.add(m.id); continue; }
      if (live !== stat) { differ++; if (wrong.length < 40) wrong.push(`${rel}: ${m.name}: live "${live}" static "${stat}"`); }
    }
  }
  assert.deepEqual(wrong, [], `${differ} of ${compared} first lines differ`);
  assert.ok(staticNoActors.size <= 5, `${staticNoActors.size} films whose static line has no actors but the live line has: ${[...staticNoActors].join(" ")}`);
  assert.ok(compared > 40000, `${compared} metas compared`);
  // every `desc` of the index is a card of two lines, then the separator and the synopsis (a film with no cast and no reason has "\n" and the separator, not the synopsis alone)
  const sep = ix.meta.separator;
  let noCard = 0, bare = 0;
  for (const f of ix.films) {
    if (!f.desc) continue;
    if (!/^[^\n]*\n/.test(f.desc)) noCard++;
    if (f.desc.slice(f.desc.indexOf("\n") + 1).startsWith(sep)) bare++; // the second line (the reason) is empty
  }
  assert.equal(noCard, 0, `${noCard} descriptions with no card`);
  assert.ok(bare > 0, "and some films really have no reason (or no cast and no reason): the empty second line is exercised by the real index");
  assert.ok(byColumn > 0, "some films have a main country that the `countries` column does not start with: they are the reason for the `country` column");
  // and through the Worker itself, on the menus that lost the country before the column existed: Loved by directors and Lists
  // Memory (14/10/2026, CI OOM on Node 22): the lists go through a handler that is renewed every few lists, and only a deterministic sample of them is asked: 8, spread over the menu.
  // REAL_INDEX_FULL=1 asks the first 40.
  let get = handler();
  const first = (m) => m.description.split("\n")[0];
  // line 2 (21/10/2026, D3 and the review's item (d) of 21/10: nobody compared line 2 of the Loved by directors menu, or of the lists, between the two addons): the static item and the Worker's entry must write the same line.
  // The one class let through is the one the first line already has: a static item whose TMDB record is not the index's (no actors there: `noActors`), whose genres and words may then differ; it is counted.
  const second = (m) => m.description.split("\n\n")[0].split("\n")[1] || "";
  let viaWorker = 0, line2Compared = 0;
  const line2Wrong = [];
  const statics = (rel) => new Map(JSON.parse(fs.readFileSync(path.join(root0, rel), "utf8")).metas.map((m) => [m.id, first(m)]));
  const statics2 = (rel) => new Map(JSON.parse(fs.readFileSync(path.join(root0, rel), "utf8")).metas.map((m) => [m.id, second(m).startsWith("Mood: ") ? "" : second(m)])); // the static addon still writes "Mood: …"; the Worker does not (28/10/2026)
  const same2 = (where, m, want, stat) => { if (noActors(first(m), stat)) return; line2Compared++; if (second(m) !== want && line2Wrong.length < 20) line2Wrong.push(`${where}: ${m.name}: live "${second(m)}" static "${want}"`); };
  for (const o of ix.directors.options) {
    const stat = statics(`mood-engine-directors-loved/genre=${o.label}.json`), stat2 = statics2(`mood-engine-directors-loved/genre=${o.label}.json`);
    for (const m of (await get(`/catalog/movie/director-picks/genre=${encodeURIComponent(o.label)}.json`)).json.metas) { if (!noActors(first(m), stat.get(m.id))) assert.equal(first(m), stat.get(m.id), `director-picks ${o.label}: ${m.name}`); same2(`director-picks ${o.label}`, m, stat2.get(m.id), stat.get(m.id)); viaWorker++; }
  }
  const sample = process.env.REAL_INDEX_FULL ? ix.lists.slice(0, 40) : Array.from({ length: 8 }, (_, i) => ix.lists[Math.floor((i * ix.lists.length) / 8)]);
  assert.equal(new Set(sample.map((l) => l.id)).size, sample.length);
  for (const [i, l] of sample.entries()) {
    if (i % 4 === 0) get = handler(); // a new store: the pieces of the lists before it are let go
    // 22/10/2026: the static files are named by the short name of the list; the Worker still answers to the full one
    const file = `mood-engine-lists/genre=${l.short.replace(/[\/\\?#%]/g, "-")}.json`, stat = statics(file), stat2 = statics2(file);
    for (const m of (await get(`/catalog/movie/lists/genre=${encodeURIComponent(l.short)}.json`)).json.metas) if (stat.has(m.id)) { if (!noActors(first(m), stat.get(m.id))) assert.equal(first(m), stat.get(m.id), `lists ${l.label}: ${m.name}`); same2(`lists ${l.label}`, m, stat2.get(m.id), stat.get(m.id)); viaWorker++; }
  }
  assert.deepEqual(line2Wrong, [], "line 2 differs between the static addon and the Worker");
  assert.ok(line2Compared > (process.env.REAL_INDEX_FULL ? 500 : 150), `${line2Compared} line 2 compared through the Worker`);
  assert.ok(viaWorker > (process.env.REAL_INDEX_FULL ? 500 : 150), `${viaWorker} metas compared through the Worker`);
});

// ── the v2 family (Worker 3.3.0, 14/10/2026) ─────────────────────────────────

const board54 = () => JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).board; // the production board (PR5); the name is the old one
const index2 = () => rows.decode(JSON.parse(fs.readFileSync(path.join(build(), "data", "index-v2.json"), "utf8")));

test("real index: director citizenship puts Roma in Mexico and Jeanne Dielman in Belgium, on the card and corresponding country option", opts, async () => {
  const ix = index2();
  const get = handler({ v2: true });
  const tmdb = JSON.parse(fs.readFileSync(path.join(root, "cache", "tmdb.json"), "utf8")).movie;
  for (const [id, country] of [[426426, "Mexico"], [44012, "Belgium"]]) {
    const tt = tmdb[id].v.imdb;
    const film = ix.films.find((f) => f.tt === tt);
    assert.ok(film);
    assert.equal(film.country || film.countries[0], country);
    const catalog = ix.discover.catalogs.find((c) => c.options.some((o) => o.label === country && o.ids));
    assert.ok(catalog, `${country}: calculated country catalog`);
    const option = catalog.options.find((o) => o.label === country && o.ids);
    assert.ok(option.ids.includes(tt), `${film.name}: in ${country}`);
    const metas = [];
    for (let skip = 0; ; skip += 100) {
      const res = await get(`/catalog/movie/${catalog.id}/genre=${encodeURIComponent(option.label)}&seen=${encodeURIComponent("Include seen")}&skip=${skip}.json`);
      assert.equal(res.status, 200);
      metas.push(...res.json.metas);
      if (res.json.metas.length < 100) break;
    }
    const card = metas.find((m) => m.id === tt);
    assert.ok(card, `${film.name}: served in ${country} with seen films included`);
    assert.equal(card.name, film.name, "the corresponding option serves the same card");
  }
});

test("real index, v2 manifest (3.5.0): the Discover first — the catalogs of discover.order, Lists and Lists (unseen) retired — then the 54 rows of the Board in Marco's order under his names, none with a menu — the Moods menu with its 31 options, 46 countries, 3.5.0, and at most 26,000 bytes", opts, async () => {
  const get = handler({ v2: true });
  const res = await get("/manifest.json");
  const m = res.json;
  const cfg = board54();
  const bytes = Buffer.byteLength(res.text);
  console.log(`# v2 manifest: ${m.catalogs.length} catalogs, ${bytes} bytes (the limit of this test is 26000; 3.1.0's was 19,133)`);
  assert.equal(m.version, "3.5.0"); // Marco, 28/10/2026 (proposal 5): the manifest of an index with `discover` is 3.5.0, whatever the index's keys (it was 3.4.1)
  // 22/10/2026: 61 -> 67 with the 8 catalogs of the Discover by subject (spec research/2026-10-22-catalogos-paises-regioes-decadas-eras.md): the 7 old Discover catalogs less Lists and Lists (unseen), plus Countries & regions,
  // Decades & eras, Genres, Themes & craft, Critics & awards, Directors' picks, Letterboxd and Seasons & holidays. The number comes from the manifest's own source, `discover` in the index, not from here.
  const discover = index2().discover;
  const discoverIds = discover.order.filter((id) => !discover.retire.includes(id));
  assert.equal(discoverIds[0], "moods");
  assert.equal(discoverIds.length, 13);
  assert.equal(m.catalogs.length, discoverIds.length + 54);
  assert.deepEqual(m.catalogs.slice(0, discoverIds.length).map((c) => c.id), discoverIds, "Discover first: it opens on Moods");
  assert.equal(m.catalogs.findIndex((c) => c.type === "movie"), 0);
  const rowsOf = m.catalogs.slice(discoverIds.length);
  assert.equal(rowsOf.length, 54);
  assert.deepEqual(rowsOf.map((c) => c.id), cfg.order.filter((id) => cfg.place[id] !== "menu"), "the 54 in the order of the Board");
  assert.deepEqual(rowsOf.map((c) => c.name), rowsOf.map((c) => cfg.names[c.id]), "under the names of the Board");
  assert.equal(rowsOf.filter((c) => !c.extra).length, 54, "no Board row has a menu: Stremio puts all 54 on the Board");
  assert.equal(m.catalogs.filter((c) => !(c.extra || []).some((e) => e.isRequired)).length, 54, "and nothing else is on the Board (every Discover catalog has a required menu)");
  assert.deepEqual(rowsOf.filter((c) => c.type === "series").map((c) => [c.id, c.name]), [["my-series", "📺 Series to watch"]]);
  assert.deepEqual(rowsOf.slice(0, 3).map((c) => c.id), ["tonight", "watchlist", "my-series"]);
  const by = Object.fromEntries(m.catalogs.map((c) => [c.id, c]));
  const opts_ = (c, name) => c.extra.find((e) => e.name === name).options;
  assert.equal(opts_(by.moods, "genre").length, 31);
  assert.ok(opts_(by.moods, "genre").length >= 28);
  const menuOf = Object.fromEntries(index2().moodMenu.map((o) => [o.id, o.label]));
  assert.deepEqual(opts_(by.moods, "genre"), cfg.moodMenu.map((id) => menuOf[id]), "the options are the config's moodMenu, under the labels of the index");
  for (const id of ["moods", "explore"]) assert.equal(opts_(by[id], "country").length, 46, `${id}: 46 countries`);
  // Marco, 28/10/2026 (proposal 5): the index may retire "Loved by directors" (`discover.retire`), and then the manifest has no such catalog (the Worker still answers it); it is checked when the manifest has it
  for (const id of [...["friends", "director-picks"].filter((x) => by[x]), ...discover.catalogs.map((c) => c.id)]) assert.equal(opts_(by[id], "country").length, 12, `${id} reads legacy pieces, which keep two countries per film and the 12 of the legacy menu: the 12`);
  assert.ok(!by.lists && !by["lists-unseen"], "Lists and Lists (unseen) left the manifest (the Worker still answers them)");
  assert.deepEqual(opts_(by.moods, "country"), cfg.countries);
  assert.deepEqual(opts_(by.friends, "country"), index().meta.countries, "the legacy menu, as the legacy index has it");
  assert.ok(bytes <= 26000, `${bytes} bytes`);
});

test("real index, the Discover by subject (3.5.0, proposal 5): every option of every grouped catalog answers 200; a calculated option has the total the object form of the index gives (unseen, recommendable, in the build's order), with Include seen the seen ones too; a list option is Lists (unseen) / Lists", opts, async () => {
  const get = handler({ v2: true });
  const ix = index2();
  const byTt = new Map(ix.films.map((f) => [f.tt, f]));
  const enc = encodeURIComponent;
  let calculated = 0, listed = 0;
  assert.ok(ix.discover.catalogs.length >= 8);
  // what the data file guarantees (proposal 5, review of 29/10/2026): a list is cited exactly once, in an option, a union, an `any` or a card, or it is in `menuless` (outside the menus: Search and the film page only). The citations are read
  // from the file itself (`list` and `lists`; `listsAny` of an era's `where` is membership, not a citation), and an option of one list carries the label the file declares for it (LGBTQ+, War, Best of the 2020s...) or the list's `short`.
  const file = JSON.parse(fs.readFileSync(path.join(root, "data", "discover-catalogs.json"), "utf8"));
  const cited = [], ownLabel = new Map();
  (function walk(x) {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== "object") return;
    for (const [k, v] of Object.entries(x)) {
      if (k === "list" && typeof v === "string") { cited.push(v); if (typeof x.label === "string") ownLabel.set(v, x.label); }
      else if (k === "lists" && Array.isArray(v)) cited.push(...v.filter((id) => typeof id === "string"));
      else walk(v);
    }
  })(file.catalogs);
  for (const c of ix.discover.catalogs) {
    for (const o of c.options) {
      const base = `/catalog/movie/${c.id}/genre=${enc(o.label)}`;
      const a = await get(`${base}.json`);
      assert.equal(a.status, 200, `${c.id}/${o.label}`);
      if (o.ids) {
        // a `curated` option (a union of lists, a director's card; proposal 5, Marco, 28/10/2026) is served with NO recommendation rule and no music rule: only the seen films are held back
        const ok = o.curated === true ? (e, seen) => seen || !e.seen : (e, seen) => e.eligible && !e.musicOut && (o.shorts === true || !e.shortOut) && (seen || !e.seen); // (a short, bit 16, is in no calculated option since 15/11/2026; a curated one keeps it, and so does an era, `shorts: true`, whose file names it)
        const want = o.ids.map((tt) => byTt.get(tt)).filter((e) => ok(e, false));
        assert.equal(Number(a.headers.get("x-total")), want.length, `${c.id}/${o.label}`);
        assert.deepEqual(a.json.metas.map((m) => m.id), want.slice(0, 100).map((e) => e.tt), `${c.id}/${o.label}: the build's order`);
        const b = await get(`${base}&seen=${enc("Include seen")}.json`);
        assert.equal(Number(b.headers.get("x-total")), o.ids.map((tt) => byTt.get(tt)).filter((e) => ok(e, true)).length, `${c.id}/${o.label}: with Include seen`);
        calculated++;
      } else {
        const list = ix.lists.find((l) => l.id === o.list);
        assert.equal(o.label, ownLabel.get(o.list) ?? list.short ?? list.label, `${c.id}/${o.label}: the label the file declares for the list, else its short name`);
        assert.equal(a.text, (await get(`/catalog/movie/lists-unseen/genre=${enc(list.label)}.json`)).text, `${c.id}/${o.label}: Lists (unseen)`);
        assert.equal((await get(`${base}&seen=${enc("Include seen")}.json`)).text, (await get(`/catalog/movie/lists/genre=${enc(list.label)}.json`)).text, `${c.id}/${o.label}: Lists`);
        listed++;
      }
    }
  }
  const menuless = file.menuless;
  assert.equal(menuless.length, 20, "the 20 lists outside the menus");
  assert.equal(new Set([...cited, ...menuless]).size, cited.length + menuless.length, "no list is cited twice (nor in a menu and in menuless)");
  assert.deepEqual([...cited, ...menuless].sort(), ix.lists.map((l) => l.id).sort(), "every list of the index is cited by exactly one option or is in menuless");
  assert.equal(cited.length + menuless.length, ix.lists.length, `${cited.length} cited + ${menuless.length} menuless = every list of the index`);
  const single = file.catalogs.reduce((n, c) => n + (c.options || []).filter((o) => o.list).length, 0);
  assert.equal(listed, single, `${listed} options of a single list served = the ${single} {list} options of the data file (none lost by the build)`);
  assert.ok(calculated > 40, `${calculated} calculated options`);
});

// Marco, 15/11/2026 (questionnaire, on the shorts in the eras that are only a period): "Keep shorts in the Silent era only (recommended)". The Silent era's option says `shorts: true` (lib/discover-catalogs.js SHORTS_PERIODS)
// and the Worker shows its shorts; the other eight periods are calculated options: their shorts stay in the ids and are shown in no view.
test("real index, the periods of the eras: the Silent era shows its shorts (the seen ones with Include seen); the other eight periods hold theirs in the ids and show none, with or without Include seen", opts, async () => {
  const get = handler({ v2: true });
  const ix = index2(), byTt = new Map(ix.films.map((f) => [f.tt, f])), enc = encodeURIComponent;
  const file = JSON.parse(fs.readFileSync(path.join(root, "data", "discover-catalogs.json"), "utf8"));
  const periods = file.catalogs.find((c) => c.id === "eras").options.filter((o) => o.where).map((o) => o.id);
  assert.equal(periods.length, 9, "the nine periods of the data file");
  const eras = ix.discover.catalogs.find((c) => c.id === "eras");
  const all = async (base) => { const ids = []; for (let skip = 0; ; skip += 100) { const r = await get(`${base}${skip ? `&skip=${skip}` : ""}.json`); assert.equal(r.status, 200, base); ids.push(...r.json.metas.map((m) => m.id)); if (r.json.metas.length < 100) return new Set(ids); } };
  const counts = [];
  for (const id of periods) {
    const o = eras.options.find((x) => x.id === id);
    const shorts = o.ids.map((tt) => byTt.get(tt)).filter((e) => e.shortOut && e.eligible && !e.musicOut);
    const base = `/catalog/movie/eras/genre=${enc(o.label)}`;
    const shown = await all(base), shownAll = await all(`${base}&seen=${enc("Include seen")}`);
    counts.push(`${o.label} ${shorts.filter((e) => shown.has(e.tt)).length}/${shorts.filter((e) => shownAll.has(e.tt)).length} of ${shorts.length}`);
    if (id === "e-silent") {
      assert.equal(o.shorts, true, "the Silent era carries the mark");
      assert.ok(shorts.filter((e) => !e.seen).length >= 10, `(control: the Silent era holds ${shorts.length} shorts)`);
      for (const e of shorts) { assert.ok(shownAll.has(e.tt), `${e.name}: shown with Include seen`); assert.equal(shown.has(e.tt), !e.seen, `${e.name}: shown by default unless he has seen it`); }
    } else {
      assert.equal(Object.hasOwn(o, "shorts"), false, `${o.label} carries no mark`);
      for (const e of shorts) assert.ok(!shown.has(e.tt) && !shownAll.has(e.tt), `${o.label}: ${e.name} (${e.runtime} min) is a short and is not shown`);
    }
  }
  const classic = eras.options.find((x) => x.id === "e-classic-hollywood");
  assert.ok(classic.ids.map((tt) => byTt.get(tt)).filter((e) => e.shortOut && e.eligible && !e.musicOut && !e.seen).length >= 10, "(control: Classic Hollywood holds shorts it would show without the rule)");
  console.log(`# shorts shown in the periods of the eras (default/Include seen of those in the ids): ${counts.join(" · ")}`);
});

// Marco, 29/10/2026 ("peças por opção do Discover"): pages 1 to 3 of a calculated option are read from the option's own piece (lib/index-export.js optionPieces), the rest from the whole v2 index. The answer has to be the same bytes either
// way. Here on the REAL index: a sample of the options (every kind: a region, a country, a decade, a genre, a union of lists, a director's card; one that shows more than 300 films and one that shows fewer), pages 1 to 4, with and without
// Include seen, with a menu on top; the handler that has the pieces against the handler that has none. Defect guarded: a piece that cuts the option short, a total that is not the whole option's, a card that loses its texts, a page 3 that comes out short.
test("real index, the Discover's option pieces: the answer from the piece is the answer from the whole v2 index, byte for byte (body and every header but the source and the age), pages 1 to 4, with and without Include seen and with a menu on top", opts, async () => {
  const ix = index2(), byTt = new Map(ix.films.map((f) => [f.tt, f]));
  const all = ix.discover.catalogs.flatMap((c) => c.options.filter((o) => o.ids).map((o) => ({ c, o })));
  assert.ok(all.length > 100, `${all.length} calculated options`);
  const shown = (o) => o.ids.map((tt) => byTt.get(tt)).filter((e) => (o.curated ? true : e.eligible && !e.musicOut && (o.shorts === true || !e.shortOut)) && !e.seen).length;
  const sample = all.filter((_, i) => i % 7 === 0);
  for (const pick of [(x) => x.o.curated && x.o.director === undefined, (x) => x.o.director !== undefined, (x) => !x.o.curated && shown(x.o) > 300, (x) => !x.o.curated && shown(x.o) < 300 && shown(x.o) > 0]) {
    const found = all.find(pick);
    assert.ok(found, "every kind of option is in the index");
    if (!sample.includes(found)) sample.push(found);
  }
  const pieceCalls = [], withPieces = handler({ v2: true, calls: pieceCalls }), whole = handler({ v2: true, pieces: false });
  const seen = `&seen=${encodeURIComponent("Include seen")}`;
  const headers = (r) => Object.fromEntries([...r.headers].filter(([k]) => !["x-index-age-seconds", "x-index-source"].includes(k)));
  let compared = 0, bigOnes = 0;
  // two passes: the requests a piece can answer first, then the ones that need the whole index (page 4, a menu on top). Once the whole v2 index is fresh in memory the Worker does not fetch a piece (29/10/2026), so the order is part of the test
  for (const [pass, extras] of [["pieces", ["", "&skip=100", "&skip=200", seen, `${seen}&skip=100`, `${seen}&skip=200`]], ["whole index", ["&skip=300", `${seen}&skip=300`, "&decade=1970s", "&country=France"]]]) {
  if (pass === "whole index") assert.ok(!pieceCalls.includes("index-v2.json"), `pages 1 to 3 of ${sample.length} options (and Include seen) did not read the whole v2 index`);
  for (const { c, o } of sample) {
    if (pass === "pieces" && shown(o) > 300) bigOnes++;
    const base = `/catalog/movie/${c.id}/genre=${encodeURIComponent(o.label)}`;
    for (const extra of extras) {
      const [a, b] = [await withPieces(`${base}${extra}.json`), await whole(`${base}${extra}.json`)];
      assert.equal(a.status, 200, `${c.id}/${o.label}${extra}`);
      assert.equal(a.text, b.text, `${c.id}/${o.label}${extra}: the body`);
      assert.deepEqual(headers(a), headers(b), `${c.id}/${o.label}${extra}: the headers`);
      compared++;
    }
  }
  }
  assert.ok(bigOnes >= 3 && compared >= 200, `${sample.length} options, ${bigOnes} showing more than 300 films, ${compared} comparisons`);
  // and the pieces are really what answers pages 1 to 3: a handler that asks for them reads no whole index until page 4
  const calls = [];
  const get = handler({ v2: true, calls });
  const big = sample.find(({ o }) => !o.curated && shown(o) > 300);
  for (const extra of ["", "&skip=100", "&skip=200", seen, `${seen}&skip=200`]) await get(`/catalog/movie/${big.c.id}/genre=${encodeURIComponent(big.o.label)}${extra}.json`);
  assert.ok(calls.some((n) => /^index-v2-opt-/.test(n)), "the piece was asked for");
  assert.ok(!calls.includes("index-v2.json"), `pages 1 to 3 (and Include seen) did not read the whole v2 index: ${calls.join(", ")}`);
  await get(`/catalog/movie/${big.c.id}/genre=${encodeURIComponent(big.o.label)}&skip=300.json`);
  assert.ok(calls.includes("index-v2.json"), "page 4 is the whole index's");
});

test("real index, v2 manifests of the profiles: the five others are the manifests of 3.2.0 under version 3.2.1 (12 countries, no v2 row), the Marco profile mirrors the new main address with dry names and 46 countries in Moods and Explore (12 in the catalogs of legacy pieces)", opts, async () => {
  const [v2, legacy] = [handler({ v2: true }), handler()];
  for (const k of ["light", "heavy", "night", "world", "critics"]) {
    const [a, b] = [await v2(`/p/${k}/manifest.json`), await legacy(`/p/${k}/manifest.json`)];
    assert.equal(a.text, b.text, k);
    assert.equal(a.json.version, "3.2.1");
    for (const c of a.json.catalogs) for (const e of c.extra || []) if (e.name === "country") assert.equal(e.options.length, 12, `${k}/${c.id}`);
  }
  const marco = (await v2("/p/marco/manifest.json")).json;
  const main = (await v2("/manifest.json")).json;
  assert.deepEqual(marco.catalogs.map((c) => c.id).filter((id) => !id.startsWith("vouch-") && id !== "what-it-is"), main.catalogs.map((c) => c.id));
  assert.equal(marco.catalogs.length, main.catalogs.length + marco.catalogs.filter((c) => c.id.startsWith("vouch-") || c.id === "what-it-is").length);
  for (const c of marco.catalogs.filter((c) => (c.extra || []).some((e) => e.name === "country"))) assert.equal(c.extra.find((e) => e.name === "country").options.length, ["moods", "explore"].includes(c.id) ? 46 : 12, c.id);
  assert.ok(marco.catalogs.slice(7).every((c) => !/^\p{Extended_Pictographic}/u.test(c.name) || c.type !== "movie" || (c.extra || []).length), "the Marco profile's Board rows have dry names, no emoji");
  assert.equal(marco.catalogs.find((c) => c.id === "wicked").name, "Horror", "the combined Horror row is not called after the legacy mood");
  assert.equal(marco.version, "3.2.1");
});

test("real index, the eight lists Marco put in the table on 23/10/2026 are in the profiles' menus (the five TSPDT lists, then the three of cinematography): the menus have them by their names, and each answers with the films, the total and the order of the Discover's option (every page)", opts, async () => {
  // Marco, 23/10/2026 19:51 UTC: "Entrar na tabela: Critics em 'quem recomenda'; cânone / século 21 em 'do que se trata'." (the five TSPDT lists); "Sim: entram em 'do que se trata' como ofício/fotografia." (GAsK, 2mL0U, 100b4: a new theme,
  // Cinematography, and a group by origin). Measured on the caches of 23/10/2026: Critics 30 -> 36, Institutions 58 -> 59, Letterboxd & community 33 -> 34, What it is 26 -> 28 in all six profiles (Cinematography, and Beyond the canon for the A-List on 24/10: "Tema próprio: 'Beyond the canon'").
  const [legacy, v2] = [handler(), handler({ v2: true })];
  const enc = encodeURIComponent;
  const LISTS = { // id: [name, theme, the group's catalog]
    "tspdt-21c-250": ["21st century top 250 · TSPDT", "21st century", "vouch-critics"], "tspdt-poll26-250": ["2026 poll top 250 · TSPDT", "All-time canon", "vouch-critics"],
    "tspdt-poll21-250": ["2021 poll top 250 · TSPDT", "All-time canon", "vouch-critics"], "tspdt-2025-50": ["50 best of 2025 · TSPDT", "21st century", "vouch-critics"],
    "tspdt-beyond-ss-alist": ["Beyond S&S A-List · TSPDT", "Beyond the canon", "vouch-critics"],
    GAsK: ["Cinematography · Fandor poll", "Cinematography", "vouch-critics"], "2mL0U": ["100 milestones · ASC", "Cinematography", "vouch-institutions"], "100b4": ["Colour grading · clairecao", "Cinematography", "vouch-letterboxd-community"],
  };
  const COUNTS = { "vouch-critics": 36, "vouch-institutions": 59, "vouch-directors": 18, "vouch-letterboxd-community": 34, "what-it-is": 28 };
  const ix = index2();
  const byTt = new Map(ix.films.map((f) => [f.tt, f]));
  const discover = new Map();
  for (const c of ix.discover.catalogs) for (const o of c.options) if (o.list in LISTS) discover.set(o.list, { cat: c.id, label: o.label });
  // Proposal 5 (Marco, 28/10/2026; review of 29/10/2026): only a list that stands alone is an option of its own in the Discover (3 of these eight: the unions of polls hold the others, and `tspdt-poll21-250` is outside the menus). A list without
  // an option of its own is compared with what Lists (unseen) answers for it, which is what a list option of the Discover answers (the test above); the Worker still answers Lists (unseen) although it left the manifest.
  assert.deepEqual([...discover.keys()].sort(), ["tspdt-2025-50", "tspdt-beyond-ss-alist", "tspdt-poll26-250"], "exactly these 3 of the eight have an option of their own in the Discover (the other 4 are inside unions, tspdt-poll21-250 is menuless)");
  for (const id of Object.keys(LISTS)) assert.ok(ix.lists.some((l) => l.id === id), `${id} is a list of the index`);
  for (const k of ["marco", "light", "heavy", "night", "world", "critics"]) {
    const m = (await (k === "marco" ? v2 : legacy)(`/p/${k}/manifest.json`)).json;
    const menu = (id) => m.catalogs.find((c) => c.id === id).extra.find((e) => e.name === "genre").options;
    for (const [id, n] of Object.entries(COUNTS)) assert.equal(menu(id).length, n, `${k}: ${id}`);
    for (const [id, [name, , cat]] of Object.entries(LISTS)) assert.ok(menu(cat).includes(name), `${k}: ${name} in ${cat}`);
    assert.ok(menu("what-it-is").includes("Cinematography") && menu("what-it-is").includes("Beyond the canon"), `${k}: the new themes`);
  }
  const pages = async (get, base) => {
    const ids = [];
    const first = await get(`${base}.json`);
    assert.equal(first.status, 200, base);
    const total = Number(first.headers.get("x-total"));
    assert.ok(Number.isInteger(total) && total >= 0 && total <= ix.films.length, `${base}: a bounded total`);
    for (let skip = 0; skip <= total; skip += 100) {
      const answer = skip ? await get(`${base}&skip=${skip}.json`) : first;
      assert.equal(answer.status, 200, `${base}: skip ${skip}`);
      assert.equal(Number(answer.headers.get("x-total")), total, `${base}: stable total`);
      assert.equal(answer.json.metas.length, Math.min(100, total - skip), `${base}: page size at ${skip}`);
      ids.push(...answer.json.metas.map((x) => x.id));
    }
    assert.equal(ids.length, total, `${base}: every film counted`);
    assert.equal(new Set(ids).size, ids.length, `${base}: no duplicates across pages`);
    return ids;
  };
  for (const [id, [name, , cat]] of Object.entries(LISTS)) {
    const want = discover.get(id);
    const expected = await pages(v2, want ? `/catalog/movie/${want.cat}/genre=${enc(want.label)}` : `/catalog/movie/lists-unseen/genre=${enc(ix.lists.find((l) => l.id === id).label)}`);
    assert.ok(expected.length > 0, `${id}: the list has unseen films`);
    for (const [get, prefix] of [[legacy, "critics"], [v2, "marco"]]) {
      const actual = await pages(get, `/p/${prefix}/catalog/movie/${cat}/genre=${enc(name)}`);
      assert.deepEqual(actual, expected, `${id}: ${prefix} and Discover return every film in the same order`);
    }
  }
  // Every page is read before comparing inclusion and deduplication; source lists can also contain films held back by the recommendation rule.

  for (const t of ["21st century", "All-time canon", "Cinematography", "Beyond the canon"]) {
    const themeIds = await pages(legacy, `/p/critics/catalog/movie/what-it-is/genre=${enc(t)}`);
    const inTheme = new Set(themeIds);
    const expectedNew = new Set();
    assert.ok(inTheme.size > 0, t);
    for (const [id, [name, theme, cat]] of Object.entries(LISTS)) {
      if (theme !== t) continue;
      let recommendable = 0;
      for (const f of await pages(legacy, `/p/critics/catalog/movie/${cat}/genre=${enc(name)}`)) {
        const e = byTt.get(f); // a theme recommends (eligible and not held back by the music rule); the list shows what the curator listed
        if (e.eligible && !e.musicOut && !e.shortOut) { recommendable++; expectedNew.add(f); assert.ok(inTheme.has(f), `${t}: ${f} of ${id}`); } // (a theme recommends: no short since 15/11/2026)
      }
      assert.ok(recommendable > 0, `${id}: some film of the list is recommendable`);
    }
    if (["Cinematography", "Beyond the canon"].includes(t)) {
      assert.deepEqual([...inTheme].sort(), [...expectedNew].sort(), `${t}: exactly its recommendable unseen source films, with no extras`);
    }
  }
});

test("real index, v2 Board: every one of the 54 rows answers 200 with the build's films in the build's order (at most 100, none seen, Old friends aside), each film's line 2 opening with its mood in a mood row, with its reason in a reason row and with the mood it fits best elsewhere; each reads the menus and its own slice, never the whole index", opts, async () => {
  const calls = [];
  const get = handler({ v2: true, calls });
  const ix = index2();
  const byTt = new Map(ix.films.map((f) => [f.tt, f]));
  let checked = 0, films = 0, withMoodLine = 0, reasonLeads = 0, fitLabels = 0, unlabelled = 0;
  const reasonRows = new Set(Object.keys(require(path.join(root, "lib", "plan.js")).REASON_ROWS));
  const v2OnlyMoodRows = new Set();
  const TMDB_GENRES = new Set(["Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary", "Drama", "Family", "Fantasy", "History", "Horror", "Music", "Mystery", "Romance", "Science Fiction", "TV Movie", "Thriller", "War", "Western"]);
  const cfgBoard = board54(), cfgAll = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  // Marco, 21/10/2026 ~22:15 UTC: the name a "Mood:" label carries is the name of the mood's ROW in the Board when it has one, else the mood's `name` (lib/best-mood.js rowNames). `labelNames` are the 30 names a v2 label may carry;
  // `outdated` are the mood names that a Board row replaces ("🎳 Full escape" where the row says "🎳 Fun and adventure"): no label may carry one, or a film would read two names for one mood (91 films did on the build of 21/10/2026).
  const boardName = (id) => (ix.board.find((b) => b.id === id) || {}).name;
  const labelNames = new Set(cfgAll.moods.map((m) => boardName(m.id) || m.name)), outdated = new Set(cfgAll.moods.filter((m) => boardName(m.id) && boardName(m.id) !== m.name).map((m) => m.name));
  assert.equal(outdated.size, 5, `the five moods whose Board row has a name of its own: ${[...outdated]}`);
  for (const entry of ix.board.filter((b) => b.place === "board")) {
    const before = calls.length;
    if (entry.series) { const s = await get("/catalog/series/my-series.json"); assert.equal(s.json.metas.length, 85); continue; }
    const got = await get(`/catalog/movie/${entry.id}.json`);
    assert.equal(got.status, 200, entry.id);
    const want = ix.rows[entry.id].filter((tt) => entry.id === "oldfriends" || !byTt.get(tt).seen).slice(0, 100);
    assert.ok(want.length > 0, `${entry.id}: the build made an empty row`);
    assert.deepEqual(got.json.metas.map((m) => m.id), want, entry.id);
    assert.ok(got.json.metas.length <= 100);
    // line 2 is the build's rowDesc: "Mood: <the row's name>" in a row that is a mood (Tonight: the mood each pick was drawn for), the film's best-fit mood in every other row that is no reason row (Marco, 21/10/2026, D3; until then the genres alone, 20/10/2026), or the genres alone when the film fits no mood
    // a mood row is any mood of config.json (the 30, not only board.legacyMoods: ELEVEN rows of this Board lost the label with the nine alone — ten rows of v2-only moods (comingofage, visual, winter, adrenaline, swoon, twotalk, midnight, hidden, anthology, docs) and the combined Comedy row, 884 films; review of 21/10/2026), a mood of board.moods, or a combined row with one of them among its parts
    const moodIds = new Set([...cfgAll.moods.map((m) => m.id), ...(cfgBoard.moods || []).map((m) => m.id)]);
    for (const r of cfgBoard.rows || []) if (r.kind === "combine" && (r.parts || []).some((p) => moodIds.has(p))) moodIds.add(r.id);
    for (const m of got.json.metas) {
      // a film with no director, no duration and no actors has no credits line: its card is line 2 alone (Don't Worry Darling in Friend's top picks, 21/10/2026)
      // Marco, 28/10/2026 (cards with chips): the Worker's card has no "Mood: …" line, so the rules below are checked on the BUILD's text of the row (`ix.rowDesc`, line 2 of the card is positional there), which is what the Worker used to write;
      // the card the Worker serves is checked to carry no such line, and a film that fits a mood carries a Mood chip.
      const card = String(m.description || "").split("\n\n")[0].split("\n"), e = byTt.get(m.id);
      const own = ix.rowDesc[entry.id][ix.rows[entry.id].indexOf(m.id)];
      const l2 = String(own || "").split("\n\n")[0].split("\n")[1] || "";
      assert.ok(!card.some((l) => l.startsWith("Mood: ")), `${entry.id}: ${m.name}: the Worker writes no "Mood: …" line: ${JSON.stringify(card)}`);
      if (e.moods && Object.keys(e.moods).length) assert.ok((m.links || []).some((l) => l.category === "Mood"), `${entry.id}: ${m.name} fits a mood and carries no Mood chip`);
      if (entry.id === "tonight") { assert.ok(l2.startsWith("Mood: ") && !l2.includes("Tonight"), `tonight: ${m.name}: "${l2}"`); assert.ok(!outdated.has(l2.slice(6).split(" · ")[0].replace(/\.$/, "")), `tonight: ${m.name}: "${l2}" writes the mood's name where the Board's row says another (22/10/2026: 4 of 10 cards did)`); }
      else if (moodIds.has(entry.id)) { assert.ok(l2.startsWith(`Mood: ${entry.name}`), `${entry.id}: ${m.name}: "${l2}" should begin with "Mood: ${entry.name}"`); if (!cfgBoard.legacyMoods.includes(entry.id)) v2OnlyMoodRows.add(entry.id); }
      else if (reasonRows.has(entry.id)) { assert.ok(l2 !== "" && !l2.startsWith("Mood: "), `${entry.id} opens with its reason, not with a mood: ${m.name}: "${l2}"`); reasonLeads++; }
      else {
        // Marco, 21/10/2026 (D3): a row that is no mood and has no reason opens with the mood the film fits best (one of the 30 names of config.json), or with the genres when the film fits none
        if (l2.startsWith("Mood: ")) {
          const label = l2.slice(6).split(" · ")[0].replace(/\.$/, "");
          assert.ok(labelNames.has(label), `${entry.id}: ${m.name}: "${l2}" names no mood of config.json by its Board name`);
          assert.ok(!outdated.has(label), `${entry.id}: ${m.name}: "${l2}" writes the mood's name where the Board's row says another`);
          fitLabels++;
        }
        else unlabelled++;
      }
      withMoodLine += l2.startsWith("Mood: ") ? 1 : 0;
      // Marco, 21/10/2026 ~19:40 UTC (A): singular and plural are the same genre, so no line 2 of the Board says a mood AND a genre of the same stem ("Mood: 🎥 Documentaries · Documentary"; 984 films on the build of 21/10/2026).
      // Written here without the build's sameName(): the last word of the label and of each genre, with the plural ending cut off, must differ.
      if (l2.startsWith("Mood: ")) {
        const g = l2.replace(/\.$/, "").split(" · "), stem = (x) => x.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").trim().replace(/(ies|y|es|s)$/, "");
        for (const genre of (g[1] || "").split(", ").filter((x) => TMDB_GENRES.has(x))) assert.notEqual(stem(genre), stem(g[0].slice(6)), `${entry.id}: ${m.name}: "${l2}" says the mood and a genre that is the same word`);
      }
    }
    assert.deepEqual(calls.slice(before).filter((n) => n !== "index-v2-menus.json"), [`index-v2-row-${entry.id}.json`], `${entry.id}: one slice`);
    checked++; films += got.json.metas.length;
  }
  assert.equal(checked, 53);
  // Marco, 21/10/2026 ~22:15 UTC (replaces B of ~19:40 UTC): the Board keeps its names (five rows have one of their own: escape "Fun and adventure", letin "Sad and beautiful", wicked "Horror", slow "Slow and quiet", adrenaline "Action and thrills") and the
  // label of a film in a row that is no mood takes the name of the mood's Board row (above); 91 films read two names for one mood on the build of 21/10/2026, 0 now. The Moods menu says the same name (`ix.moods[].name`, next test) and the manifest the Worker serves takes its names from `ix.board`.
  const sharedIds = ix.board.filter((b) => cfgAll.moods.some((m) => m.id === b.id));
  assert.ok(sharedIds.length >= 15 && ["escape", "letin", "wicked", "slow", "adrenaline"].every((id) => sharedIds.some((b) => b.id === id)), `${sharedIds.length} Board rows have the id of a mood`);
  for (const b of sharedIds) assert.equal(b.name, cfgAll.board.names[b.id], `${b.id}: the Board keeps config.json's board.names`);
  for (const [id, name] of [["escape", "🎳 Fun and adventure"], ["letin", "🌧️ Sad and beautiful"], ["wicked", "🎃 Horror"], ["slow", "🕯️ Slow and quiet"], ["adrenaline", "🔥 Action and thrills"]]) assert.equal(boardName(id), name, id);
  assert.ok(v2OnlyMoodRows.size >= 11, `${v2OnlyMoodRows.size} mood rows the legacy Board does not have said "Mood:" (at least the 11 that had lost it on 21/10/2026: ten rows of v2-only moods and the combined Comedy row, 884 films on that night's caches; the combined rows with a mood among their parts count too): ${[...v2OnlyMoodRows]}`);
  assert.ok(withMoodLine > 100, `${withMoodLine} films with a mood line`);
  assert.ok(reasonLeads > 200 && fitLabels > 500, `${reasonLeads} films in reason rows, ${fitLabels} films in rows that are no mood with a best-fit mood, ${unlabelled} with none`);
  console.log(`# v2 Board, line 2 of the rows that are no mood: ${fitLabels} films open with the mood they fit best, ${unlabelled} with the genres (fit no mood); ${reasonLeads} films in the nine reason rows open with their reason`);
  assert.ok(!calls.includes("index-v2.json"), "the whole v2 index was never read by a Board row");
  console.log(`# v2 Board: ${checked} rows, ${films} films served`);
});

test("real index, v2 Board opened twice in one isolate, with 14 mood slices read in between: the second opening of the 53 rows is all `memory`, no row slice is fetched again and no piece-evicted names one", opts, async () => {
  const calls = [], logs = [];
  const get = handler({ v2: true, calls, logs });
  const ix = index2();
  const ids = ix.board.filter((b) => b.place === "board" && !b.series).map((b) => b.id);
  assert.equal(ids.length, 53);
  const open = async () => { const sources = []; for (const id of ids) { const r = await get(`/catalog/movie/${id}.json`); assert.equal(r.status, 200, id); sources.push(r.headers.get("x-index-source")); } return sources; };
  const first = await open();
  assert.ok(first.every((x) => x === "network" || x === "memory"));
  for (const o of ix.moodMenu.slice(0, 14)) await get(`/catalog/movie/moods/genre=${encodeURIComponent(o.label)}.json`); // 14 mood slices through a queue of 12: the queue turns over
  assert.ok(logs.some((l) => l.event === "piece-evicted"), "the queue of pieces did let some go (the mood slices)");
  const fetchedBefore = calls.length;
  const second = await open();
  assert.deepEqual(new Set(second), new Set(["memory"]), "the second opening is all memory");
  assert.equal(calls.length, fetchedBefore, "not one file asked for");
  assert.deepEqual(logs.filter((l) => l.event === "piece-evicted" && /index-v2-row-/.test(l.url)), []);
  assert.deepEqual(logs.filter((l) => l.event !== "piece-evicted"), [], "and no other log line");
});

test("real index, v2 Moods: every option of the menu answers; a mood serves EVERY film that fits it (unseen, eligible, best rank first, two a director) — the totals recounted here from the whole index — and Friends this week serves its row", opts, async () => {
  const calls = [];
  let get = handler({ v2: true, calls });
  const ix = index2();
  const menu = ix.moodMenu;
  assert.equal(menu.length, 31);
  const exempt = (ix.rules && ix.rules.musicExemptMoods) || [];
  assert.deepEqual(exempt, ["music"], "the build names the exempt mood in the index");
  console.log(`# shorts in the real index (bit 16, 15/11/2026): ${ix.films.filter((f) => f.shortOut).length} of ${ix.films.length}; unseen, eligible and fitting a mood: ${ix.films.filter((f) => f.shortOut && !f.seen && f.eligible && f.moods).length} (none of them may be in a mood's answer: the recount below leaves them out)`);
  const independent = (id) => {
    const members = ix.films.filter((f) => f.moods && id in f.moods && !f.seen && f.eligible && !f.shortOut && (exempt.includes(id) || !f.musicOut)); // recommendable: eligible and not held back by the music rule (22/10/2026), except the Moods option of an exempt mood (the index's rules.musicExemptMoods, Marco, 22/10/2026 ~15:15 UTC)
    members.sort((a, b) => b.moods[id][1] - a.moods[id][1] || (a.tt < b.tt ? -1 : 1));
    const n = new Map();
    return members.filter((f) => { const d = f.director ? f.director.split(", ")[0] : null; if (!d) return true; const c = n.get(d) || 0; if (c >= 2) return false; n.set(d, c + 1); return true; });
  };
  let moods = 0, largest = { id: "", total: 0 };
  const menuChips = { total: 0, shown: 0 };
  const byTtMoods = new Map(ix.films.map((f) => [f.tt, f]));
  const plainText = (x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(), dryText = (x) => x.replace(/^[\p{Extended_Pictographic}\u200d\ufe0f\s]+/u, "");
  const order = (id) => menu.findIndex((x) => x.id === id);
  for (const [i, o] of menu.entries()) {
    if (i % 6 === 0) get = handler({ v2: true, calls });
    const got = await get(`/catalog/movie/moods/genre=${encodeURIComponent(o.label)}.json`);
    assert.equal(got.status, 200, o.id);
    if (o.id === "friends-week") {
      const seenTt = new Set(ix.films.filter((f) => f.seen).map((f) => f.tt));
      const row = ix.rows["friends-week"].filter((tt) => !seenTt.has(tt));
      assert.deepEqual(got.json.metas.map((m) => m.id), row.slice(0, 100)); // (a week in which no friend logged a film would be an empty row, and the build's to explain)
      continue;
    }
    const want = independent(o.id);
    // Marco, 21/10/2026 ~22:15 UTC: the card of a Moods option names the mood by the name of its Board row when it has one (`ix.moods[].name`), the very name the build writes in the row's own cards and in the best-fit label of the rows that are no mood
    const moodName = ix.moods.find((x) => x.id === o.id).name, row = ix.board.find((b) => b.id === o.id);
    if (row) assert.equal(moodName, row.name, `${o.id}: the Moods menu says the Board row's name`);
    // Marco, 28/10/2026: the card does not write "Mood: …" any more; the mood is a chip. The menu's mood is NOT promoted to the first chip (only a profile's Tonight draw is): it shows when it is among the film's four best fits (by fit, then
    // menu order) once the moods named like one of the film's first three genres have yielded. That is recomputed here from the index for EVERY card, and the chip is told by its search URL, not by its name (a genre chip "Horror" is not the mood "Horror").
    const url = `stremio:///search?search=${encodeURIComponent(o.label)}`;
    for (const m of got.json.metas) {
      assert.ok(!String(m.description).split("\n").slice(0, 2).some((l) => l.startsWith("Mood: ")), `${o.id}: ${m.name}: the card writes no "Mood: …" line`);
      const e = byTtMoods.get(m.id), genreKeys = new Set((e.genres || []).slice(0, 3).map(plainText));
      const shownMoods = Object.entries(e.moods || {}).sort((x, y) => y[1][0] - x[1][0] || order(x[0]) - order(y[0])).filter(([id]) => !genreKeys.has(plainText(dryText(ix.moods.find((mm) => mm.id === id).name)))).slice(0, 4).map(([id]) => id);
      // The mood chips are the FIRST chips of the Mood group, in the order of the four best fits, each opening the search of the menu label: compare that list, not a count of URLs (a genre chip "Music" and a term such as "Coming of age" open the very same search).
      const want4 = shownMoods.map((id) => `stremio:///search?search=${encodeURIComponent(menu.find((x) => x.id === id).label)}`);
      const first = (m.links || []).filter((l) => l.category === "Mood").slice(0, want4.length).map((l) => l.url);
      assert.deepEqual(first, want4, `${o.id}: ${m.name}: the first Mood chips are the four best fits`);
      const has = shownMoods.includes(o.id);
      menuChips.total++;
      if (has) menuChips.shown++;
    }
    assert.equal(got.headers.get("x-total"), String(want.length), `${o.id}: every film that fits`);
    assert.deepEqual(got.json.metas.map((m) => m.id), want.slice(0, 100).map((f) => f.tt), o.id);
    if (want.length > largest.total) largest = { id: o.id, total: want.length };
    moods++;
  }
  assert.equal(moods, 30);
  console.log(`# v2 Moods: ${menuChips.shown} of ${menuChips.total} cards show the menu's own mood as a chip`);
  assert.ok(menuChips.shown / menuChips.total > 0.5, `${menuChips.shown} of ${menuChips.total} cards show the menu's own mood as a chip`); // (every card was already checked one by one in the loop; this is the sanity floor)
  assert.ok(largest.total > 100, `the largest mood (${largest.id}) has ${largest.total} films; the page is 100 and skip walks the rest`);
  const page2 = await get(`/catalog/movie/moods/genre=${encodeURIComponent(menu.find((o) => o.id === largest.id).label)}&skip=100.json`);
  assert.deepEqual(page2.json.metas.map((m) => m.id), independent(largest.id).slice(100, 200).map((f) => f.tt));
  assert.ok(!calls.includes("index-v2.json"), "and no mood needed the whole index");
  // the four menus on top of an option, and a country of the 46 that the legacy menu (12) did not have
  const byTt = new Map(ix.films.map((f) => [f.tt, f]));
  const docs = menu.find((o) => o.id === "docs");
  const polish = await get(`/catalog/movie/moods/country=Poland&genre=${encodeURIComponent(docs.label)}.json`);
  assert.ok(polish.json.metas.length > 0, "Polish documentaries");
  for (const m of polish.json.metas) assert.ok(byTt.get(m.id).countries.includes("Poland") && byTt.get(m.id).moods.docs, `${m.name} is Polish and a documentary`);
  const fw = await get("/catalog/movie/moods/decade=2020s&genre=Friends%20this%20week.json");
  assert.ok(fw.json.metas.every((m) => m.releaseInfo >= 2020));
});

// Re-verification of 22/10/2026 (MEDIUM): when the Moods menu took the name of the Board row (`index.moods[].name`), worker/src/search.js, which matches a typed word against a mood's label AND name, stopped finding "full escape" (255 -> 0 films on the
// build of 21/10/2026), "slow and still" (283 -> 3), "something wicked" (306 -> 1) and "let it in" (414 -> 206), and found "thrills" (0 -> 407), which moves top-10s. The index keeps the mood's own name as `moods[].alias` and the search matches the label, the name AND the alias:
// the results are the union of what the two names find. "origin/main" below is the index with the mood's own name as its name and no alias (what main served); "head" is the same index without the alias (the defect).
test("real index, v2 search: a mood is found by its own name AND by its Board row's name — the results are the union, and the top 10 of the words that already worked do not move (re-verification 22/10/2026)", opts, async () => {
  const text = fs.readFileSync(path.join(build(), "data", "index-v2.json"), "utf8");
  const load = (f) => { const ix = parseIndex(text); if (f) f(ix); return ix; };
  const both = load(), main = load((ix) => ix.moods.forEach((m) => { if (m.alias) { m.name = m.alias; delete m.alias; } })), head = load((ix) => ix.moods.forEach((m) => { delete m.alias; }));
  const aliased = both.moods.filter((m) => m.alias).map((m) => m.id).sort();
  assert.deepEqual(aliased, ["adrenaline", "escape", "letin", "slow", "wicked"], "the five moods whose Board row has a name of its own carry the mood's own name as alias");
  const ids = (ix, q) => searchIndex(ix, q).map((e) => e.tt);
  for (const q of ["full escape", "slow and still", "something wicked", "let it in"]) {
    const m = ids(main, q), b = ids(both, q), h = ids(head, q);
    assert.ok(m.length > 100, `${q}: origin/main finds ${m.length}`);
    assert.ok(m.every((tt) => b.includes(tt)), `${q}: the union holds everything origin/main found (${b.length} against ${m.length})`);
    assert.ok(h.length < m.length * 0.9, `${q}: without the alias the search loses films (${h.length} of ${m.length}): the instrument sees the defect`);
  }
  // the Board's name finds the mood too (it found nothing on origin/main)
  assert.equal(ids(main, "thrills").length, 0);
  assert.ok(ids(both, "thrills").length > 100, "thrills: the Board row's name finds the mood's films");
  // words that already worked keep their top 10
  for (const q of ["quiet", "sad", "fun", "adventure", "horror", "beautiful", "action"]) assert.deepEqual(ids(both, q).slice(0, 10), ids(main, q).slice(0, 10), `${q}: the top 10 did not move`);
});

test("real index, v2 Explore and Search: the whole v2 index (30 moods, 46 countries); a country that only the 46 have filters; a mood word finds its films", opts, async () => {
  const calls = [];
  const get = handler({ v2: true, calls });
  const ix = index2();
  const countryCounts = new Map();
  for (const f of ix.films) for (const c of f.countries || []) countryCounts.set(c, (countryCounts.get(c) || 0) + 1);
  const legacyMenu = new Set(index().meta.countries);
  const extra = ix.meta.countriesAll.find((c) => !legacyMenu.has(c) && countryCounts.get(c) >= 5);
  assert.ok(extra, "a country of the 46 that the legacy menu has not");
  const got = await get(`/catalog/movie/explore/country=${encodeURIComponent(extra)}.json`);
  assert.ok(got.json.metas.length > 0 && got.headers.get("x-total") > "0");
  const byTt = new Map(ix.films.map((f) => [f.tt, f]));
  for (const m of got.json.metas) assert.ok(byTt.get(m.id).countries.includes(extra), `${m.name} has ${extra}`);
  const noir = await get("/catalog/movie/search/search=noir.json");
  assert.ok(noir.json.metas.length > 10 && noir.json.metas.every((m) => !byTt.get(m.id).seen), "Noir is a mood only the v2 index has");
  assert.deepEqual([...new Set(calls)].filter((n) => /^index-/.test(n)), ["index-v2.json"]);
});

test("real index, v2 cost: the manifest and a Board row read the menus and ONE slice — printed against the files they replace — and the largest mood slice and Wanderlust (1.64 MB on 14/10/2026) are parsed and answered within a loose bound (bench.mjs has the cold figures)", opts, async () => {
  const dir = build();
  const file = (f) => fs.readFileSync(path.join(dir, "data", f), "utf8");
  const [menus, row, boardLegacy] = [file("index-v2-menus.json"), file("index-v2-row-europe.json"), file("index-board.json")];
  // the caches change every night: which slice is the largest is measured, not assumed (Wanderlust was on 13 and 14/10/2026), and Wanderlust is measured whatever its rank
  const slices = fs.readdirSync(path.join(dir, "data")).filter((f) => /^index-v2-mood-/.test(f)).map((f) => [f, fs.statSync(path.join(dir, "data", f)).size]).sort((a, b) => b[1] - a[1]);
  const cpu = (f) => { const a = process.cpuUsage(); const v = f(); const c = process.cpuUsage(a); return { ms: (c.user + c.system) / 1000, v }; };
  const best = (f, n = 5) => Math.min(...Array.from({ length: n }, () => cpu(f).ms));
  const [pMenus, pRow, pBoard] = [best(() => parseIndex(menus)), best(() => parseIndex(row)), best(() => parseIndex(boardLegacy))];
  const lines = [];
  for (const name of new Set([slices[0][0], "index-v2-mood-wander.json"])) {
    const text = file(name), id = name.replace(/^index-v2-mood-|\.json$/g, "");
    const ix = parseIndex(text);
    const label = ix.moods.find((m) => m.id === id).label;
    const parse = best(() => parseIndex(text)), answer = best(() => JSON.stringify(select(ix, "moods", parseExtras(`genre=${encodeURIComponent(label)}`)).entries.slice(0, 100)), 3);
    lines.push(`${name} ${(text.length / 1e6).toFixed(2)} MB (${ix.films.length} films) parse ${parse.toFixed(1)} ms, answer on it ${answer.toFixed(1)} ms`);
    assert.ok(text.length < 2.5e6, `${name} is ${(text.length / 1e6).toFixed(2)} MB`);
    assert.ok(parse < 100 && answer < 150, `${name}: parse ${parse.toFixed(1)} ms, answer ${answer.toFixed(1)} ms`);
  }
  console.log(`# v2: menus ${(menus.length / 1e3).toFixed(0)} KB parse ${pMenus.toFixed(1)} ms; a row slice (Europe) ${(row.length / 1e3).toFixed(0)} KB ${pRow.toFixed(1)} ms (menus + slice ${(pMenus + pRow).toFixed(1)} ms against the legacy Board part ${(boardLegacy.length / 1e3).toFixed(0)} KB ${pBoard.toFixed(1)} ms); ${lines.join("; ")}`);
  assert.ok(menus.length < 60e3 && row.length < 250e3, "the menus and a row are small files");
  assert.ok(pMenus + pRow < pBoard, "menus + one slice cost less to parse than the legacy Board part they replace");
});

test("(with REFERENCE_WORKER_SRC) the real build, side by side with origin/main's code: the old address with no v2 file and every profile with the v2 files beside the legacy ones answer the same as the reference Worker — the five other profiles, every catalog they declare", { skip: !have || !process.env.REFERENCE_WORKER_SRC }, async () => {
  const dir = build();
  const all = Object.fromEntries(fs.readdirSync(path.join(dir, "data")).filter((f) => /\.json$/.test(f)).map((f) => [f, null]));
  const files = new Proxy({}, { get: (_, name) => (typeof name === "string" && name in all ? (all[name] ??= fs.readFileSync(path.join(dir, "data", name), "utf8")) : undefined), has: (_, name) => name in all });
  const without = new Proxy({}, { get: (_, name) => (typeof name === "string" && /^index-v2/.test(name) ? undefined : files[name]), has: (_, name) => !/^index-v2/.test(name) && name in files });
  const REF = path.resolve(process.env.REFERENCE_WORKER_SRC);
  const { pathToFileURL } = await import("node:url");
  const ref = await (async () => handlerOver(await import(pathToFileURL(path.join(REF, "handler.js")).href), await import(pathToFileURL(path.join(REF, "store.js")).href), without, { now: () => Date.parse("2026-10-13T23:00:00Z"), dir: "https://pages.test/data/" }))();
  const [oldGet, newLegacy, newV2] = [ref, asReference(handlerOver(handlerMod, storeMod, without, { now: () => Date.parse("2026-10-13T23:00:00Z"), dir: "https://pages.test/data/" })), asReference(handlerOver(handlerMod, storeMod, files, { now: () => Date.parse("2026-10-13T23:00:00Z"), dir: "https://pages.test/data/" }))];
  const prefixes = ["", "/p/marco", "/p/light", "/p/heavy", "/p/night", "/p/world", "/p/critics"];
  const paths = [];
  for (const prefix of prefixes) paths.push(...pathsOf(prefix, JSON.parse((await oldGet(`${prefix}/manifest.json`)).text)));
  paths.splice(0, paths.length, ...withoutMySeries(withoutTonight(paths))); // the profiles' own Tonight draws evenly since 19/10/2026 (Marco): it is not the reference's; My series has 85 titles in a weekly order since 21/10/2026
  console.log(`# ${paths.length} paths compared with the reference Worker`);
  assert.deepEqual(await sweep(newLegacy, paths), await sweep(oldGet, paths), "with no v2 file: everything as origin/main");
  const others = paths.filter((p) => /^\/p\/(light|heavy|night|world|critics)\//.test(p));
  assert.deepEqual(await sweep(newV2, others), await sweep(oldGet, others), "with the v2 files beside: the five profiles as origin/main");
});


test("FP export: one real build covers every indexed movie and serves complete public pages", opts, async () => {
  const { scanFilmPages, SAMPLE_MIN_PRESENT, SAMPLE_MAX_WITHOUT } = await import("../../scripts/check-film-pages.mjs");
  const stats = await scanFilmPages(build());
  const ix = rows.decode(JSON.parse(fs.readFileSync(path.join(build(), "data/index-v2.json"))));
  assert.equal(stats.films, ix.films.length); assert.ok(stats.largestMeta.bytes <= 8192); console.log("Film page scan:", JSON.stringify(stats));
  const get = handler({ v2: true });
  for (const tt of stats.representativeIds) assert.equal((await get(`/page/meta/movie/${tt}.json`)).status, 200);
  // The trailer gate reads only the sample films that are still in the index (14/11/2026; the rule and its numbers are in the script and in film-pages-trailer-sample.test.js), so a sample film that
  // leaves does not fail this test. What must fail it is the trailer field leaving the pages: the same build with `yt` taken out of every page is scanned here, and the gate has to refuse it.
  // (This line shows only that the real build's own numbers are inside the gate's two limits; that the gate RUNS inside scanFilmPages, and refuses, is what the copy with no trailer shows below.)
  assert.ok(stats.samplePresent >= SAMPLE_MIN_PRESENT && stats.samplePresent - stats.sampleWithTrailer <= SAMPLE_MAX_WITHOUT, `the real build's sample is inside the gate's limits: ${stats.samplePresent} of ${stats.sampleSize} present (at least ${SAMPLE_MIN_PRESENT}), ${stats.samplePresent - stats.sampleWithTrailer} without a trailer (at most ${SAMPLE_MAX_WITHOUT})`);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "mood-w-noyt-"));
  try {
    fs.mkdirSync(path.join(bare, "data"));
    for (const f of ["index-v2.json", "index-v2-menus.json"]) fs.copyFileSync(path.join(build(), "data", f), path.join(bare, "data", f));
    for (const f of fs.readdirSync(path.join(build(), "data")).filter((n) => /^page-\d\d\.json$/.test(n))) {
      const shard = JSON.parse(fs.readFileSync(path.join(build(), "data", f), "utf8"));
      for (const r of shard.films) delete r.yt;
      fs.writeFileSync(path.join(bare, "data", f), JSON.stringify(shard));
    }
    await assert.rejects(scanFilmPages(bare), /trailer gate: (\d+) of the \1 sample films in the index have no trailer \(0 have one\), more than 8/, "pages with no trailer at all are refused by the gate");
    assert.equal((await scanFilmPages(bare, { trailerGate: false })).trailers, 0, "(control: the copy is otherwise a valid publication, and it has no trailer)");
  } finally { fs.rmSync(bare, { recursive: true, force: true }); }
});
