// The pieces of the calculated options of the Discover (Marco, 29/10/2026, questionnaire "peças por opção do Discover"; lib/index-export.js optionPieces, worker/src/catalogs.js optionPage).
// A calculated option's first three pages are answered from its own piece (the films of the first ids, the option's ids, the two totals of the whole option) and not from the 9.4 MB index-v2.json,
// which costs 400 to 970 ms of CPU on a cold isolate. THE RULE THIS FILE GUARDS: the answer is the same, byte for byte, whichever file it is read from — the body and every header but where the
// bytes came from — for pages 1 to 3, with and without "Include seen", with a menu on top, and in a page the piece cannot give (the whole index answers, never a partial page).
// Two rigs serve the same index: `full` (the build's pieces and the whole index) and `piecesOnly` (the pieces and NO index-v2.json): an answer that the piece can give is a 200 with films there, an answer that
// needs the whole index is the degraded empty page (X-Index-Source none). That is how this file tells WHICH FILE answered, with no wish on the header's text.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHandler } from "../src/handler.js";
import { createStore } from "../src/store.js";
import { optionPage } from "../src/catalogs.js";
import { FRIEND_SLUGS } from "../src/friends.js";
import { parseExtras } from "../src/extras.js";
import { hydrate } from "../src/film.js";
import { makeV2Object, textOf, v2FilesOf, v2ObjectFrom } from "./fixture.js";

const require = createRequire(import.meta.url);
const exporter = require("../../lib/index-export.js");

const DIR = "https://pages.test/mood-engine/data/";
const ENV = { INDEX_URL: `${DIR}index.json` };
const enc = encodeURIComponent;
const T = (i) => `tt${8000000 + i}`;

// ── the index: 400 Brazilian films and the options made of them ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const MOOD = makeV2Object().moods[0].id; // every film fits a mood, so that its card has the Mood chips the envelope's `moods` and `moodMenu` give
const film = (i, o = {}) => {
  const year = 1950 + (i % 5) * 10 + (i % 3);
  const e = {
    tt: T(i), name: `Film ${String(i).padStart(3, "0")}`, year, decade: `${Math.floor(year / 10) * 10}s`, runtime: 80 + (i % 4) * 20, countries: i % 2 ? ["Brazil"] : ["Brazil", "France"],
    director: `Director ${i}`, moods: { [MOOD]: [1 + (i % 5) / 10, 2 + (i % 7) / 10] }, lbRating: Math.round((3.6 + (i % 7) * 0.1) * 10) / 10, rank: 10 - i / 1000, eligible: true,
    desc: `Film ${i} cast\nMood: \u{1F3A5} Documentaries · Film ${i} genres.\n\nSynopsis of film ${i}.`, find: ` film ${i}`, ...o.extra,
  };
  if (o.eligible === false) delete e.eligible;
  return e;
};
// every 6th film seen, every 50th (from 7) held back by the music rule, and four that fail the recommendation rule (they sit in the options' ids so that the Worker's rule has something to do)
const FAIL = new Set([20, 21, 150, 151]);
const BRAZIL = Array.from({ length: 400 }, (_, k) => {
  const i = k + 1;
  return film(i, i % 6 === 0 ? { extra: { seen: true } } : i % 50 === 7 ? { extra: { musicOut: true } } : FAIL.has(i) ? { eligible: false } : {});
});
const byTt = new Map(BRAZIL.map((f) => [f.tt, f]));
// the order of the ids is the build's (a spread over the directors), not the file's: the ids run backwards by blocks of 7
const BIG = BRAZIL.map((f) => f.tt).reduce((acc, tt, k, all) => { if (k % 7 === 0) acc.push(...all.slice(k, k + 7).reverse()); return acc; }, []);
const SMALL = BRAZIL.slice(40, 80).map((f) => f.tt);
const UNION = BRAZIL.slice(0, 340).map((f) => f.tt).reverse(); // a curated option: no rule, only the seen films held back
const CARD = [...BRAZIL.slice(100, 140).map((f) => f.tt)];
const DISCOVER = {
  order: ["moods", "places", "eras", "explore", "search"], retire: ["lists", "lists-unseen"], seen: { name: "seen", option: "Include seen" },
  catalogs: [
    { id: "places", name: "Mood Engine · Countries & regions", options: [{ id: "c-brazil", label: "Brazil", ids: BIG }, { id: "c-small", label: "Small", ids: SMALL }, { id: "u-union", label: "Union", ids: UNION, curated: true }] },
    { id: "filmmaker-picks", name: "Mood Engine · Directors", options: [{ id: "d-lynch", label: "Lynch card", ids: CARD, curated: true, director: "Lynch loves" }] },
  ],
};
const DIRECTORS = { options: [{ label: "Lynch loves", ids: [T(101), T(103)], descs: ["Film 101 cast\nLoved by Lynch · interview (2020)", "Film 103 cast\nLoved by Lynch and Scorsese · poll"] }] };
const BASE = makeV2Object();
function indexV2() {
  const legacy = { ...BASE, board: [{ id: "tonight", name: "Tonight" }], rows: { tonight: [] }, rowDesc: { tonight: [] }, lists: [], films: [...BRAZIL].sort((a, b) => b.rank - a.rank || a.tt.localeCompare(b.tt)), directors: DIRECTORS, meta: { ...BASE.meta, count: BRAZIL.length, countries: ["Brazil", "France"] } };
  delete legacy.moodMenu;
  return { ...v2ObjectFrom({ ...legacy, moods: BASE.moods }, {}), discover: DISCOVER, directors: DIRECTORS };
}
const V2 = indexV2();
const WHOLE = v2FilesOf(V2);
const PIECES = Object.fromEntries(exporter.optionPieces(V2).map((p) => [p.rel.split("/").pop(), textOf(p.obj)]));
const FULL = { ...WHOLE, ...PIECES };
const { "index-v2.json": _whole, ...NO_WHOLE } = FULL;
const PIECES_ONLY = NO_WHOLE;

function rig(files, { hang = null, store = {} } = {}) {
  const r = { calls: [], logs: [] };
  const fetchImpl = async (url) => {
    const name = url.slice(DIR.length);
    r.calls.push(name);
    if (hang && hang.test(name)) return new Promise(() => {}); // Pages does not answer for this file, and never will (the signal is not heeded, as a stuck connection does not)
    return files[name] ? new Response(files[name]) : new Response("not found", { status: 404 });
  };
  r.store = createStore({ fetchImpl, caches: undefined, log: (o) => r.logs.push(o), ...store });
  const handle = createHandler({ store: r.store });
  r.get = async (path) => {
    const res = await handle(new Request("https://mood-engine.example.workers.dev" + path), ENV, undefined);
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: JSON.parse(text) };
  };
  return r;
}
const names = (r) => r.json.metas.map((m) => m.name);
const total = (r) => Number(r.headers.get("x-total"));
/** What the screen shows of an option, worked out here from the index object and not by the Worker: the ids in order, the films he has not seen (all of them with `seen`), recommendable ones only unless the option is curated. */
const expected = (ids, { seen = false, curated = false } = {}) => ids.map((tt) => byTt.get(tt)).filter((e) => (curated ? true : e.eligible && !e.musicOut) && (seen || !e.seen));
const headersOf = (r) => Object.fromEntries([...r.headers].filter(([k]) => !["x-index-age-seconds", "x-index-source"].includes(k)));
const OPTIONS = [["places", "Brazil", BIG, false], ["places", "Small", SMALL, false], ["places", "Union", UNION, true], ["filmmaker-picks", "Lynch card", CARD, true]];
const path = (cat, label, extra = "") => `/catalog/movie/${cat}/genre=${enc(label)}${extra}.json`;
const SEEN = `&seen=${enc("Include seen")}`;

test("the build's pieces are in the rig: one per calculated option, cut where the default view shows 300 films", () => {
  assert.deepEqual(Object.keys(PIECES).sort(), ["index-v2-opt-filmmaker-picks-d-lynch.json", "index-v2-opt-places-c-brazil.json", "index-v2-opt-places-c-small.json", "index-v2-opt-places-u-union.json"]);
  const ix = hydrate(JSON.parse(PIECES["index-v2-opt-places-c-brazil.json"]));
  const opt = ix.discover.catalogs[0].options[0];
  const shown = expected(BIG);
  assert.ok(shown.length > 300 && opt.ids.length < BIG.length, "Brazil shows more than 300 films, so its piece holds a part of the ids");
  assert.equal(expected(opt.ids).length, 300, "the piece shows exactly 300 films by default");
  assert.deepEqual([opt.total, opt.totalAll], [shown.length, expected(BIG, { seen: true }).length], "the totals are the whole option's");
});

test("pages 1 to 3 from the piece and the rest from the whole index: for every option, with and without Include seen, with a menu on top, the answer is the same bytes as the whole index gives alone", async () => {
  const whole = rig(WHOLE);
  let compared = 0, fromPiece = 0;
  for (const [cat, label] of OPTIONS) {
    const paths = [path(cat, label), path(cat, label, "&skip=100"), path(cat, label, "&skip=200"), path(cat, label, "&skip=300"), path(cat, label, "&skip=500"), path(cat, label, SEEN), path(cat, label, `${SEEN}&skip=100`), path(cat, label, `${SEEN}&skip=200`), path(cat, label, `${SEEN}&skip=300`),
      path(cat, label, "&decade=1960s"), path(cat, label, "&country=France"), path(cat, label, `&runtime=90%E2%80%93120%20min`), path(cat, label, "&rating=4.2%2B"), path(cat, label, `&decade=1960s${SEEN}&skip=100`), path(cat, label, "&decade=1900s"), path(cat, label, "&skip=12"), path(cat, label, SEEN + "&skip=250")];
    for (const p of paths) {
      const withPieces = rig(FULL); // a rig of its own for each request: once the whole index is fresh in memory the Worker no longer fetches a piece, and the piece must be what answers here
      const [a, b] = [await withPieces.get(p), await whole.get(p)];
      assert.equal(a.status, 200, p);
      assert.equal(a.text, b.text, `${p}: the body`);
      assert.deepEqual(headersOf(a), headersOf(b), `${p}: every header but the source and the age`);
      compared++;
      if (withPieces.calls.some((c) => c.startsWith("index-v2-opt-")) && !withPieces.calls.includes("index-v2.json")) fromPiece++;
    }
  }
  assert.ok(compared >= 60, `${compared} comparisons`);
  assert.ok(fromPiece >= 4 * 7, `${fromPiece} of the requests were answered by a piece alone (pages 1 to 3, with and without Include seen, of each option)`);
});

test("which file answers: pages 1 to 3 (and Include seen) are the piece's alone — the rig has no whole index and they still answer; page 4 and a menu on top need the whole index and the rig degrades them", async () => {
  const r = rig(PIECES_ONLY);
  const all = expected(BIG), withSeen = expected(BIG, { seen: true });
  const p1 = await r.get(path("places", "Brazil"));
  assert.equal(p1.status, 200);
  assert.deepEqual(names(p1), all.slice(0, 100).map((e) => e.name), "the build's order, not the file's");
  assert.equal(total(p1), all.length, "X-Total is the whole option's, not what the piece holds");
  assert.equal(p1.headers.get("x-index-source"), "network", "the piece was read from the network the first time");
  assert.deepEqual(names(await r.get(path("places", "Brazil", "&skip=100"))), all.slice(100, 200).map((e) => e.name));
  const p3 = await r.get(path("places", "Brazil", "&skip=200"));
  assert.deepEqual(names(p3), all.slice(200, 300).map((e) => e.name), "page 3 is full: the piece holds 300 films the default view shows");
  assert.equal(p3.headers.get("x-index-source"), "memory", "the second request reads the piece from memory");
  assert.equal(total(p3), all.length);
  const s1 = await r.get(path("places", "Brazil", SEEN));
  assert.deepEqual(names(s1), withSeen.slice(0, 100).map((e) => e.name), "with Include seen the seen films are in their places");
  assert.equal(total(s1), withSeen.length, "and the total counts them");
  assert.deepEqual(names(await r.get(path("places", "Brazil", `${SEEN}&skip=200`))), withSeen.slice(200, 300).map((e) => e.name));
  assert.deepEqual(r.calls, ["index-v2-menus.json", "index-v2-opt-places-c-brazil.json"], "the menus and the one piece; nothing else");
  for (const p of [path("places", "Brazil", "&skip=300"), path("places", "Brazil", "&decade=1960s"), path("places", "Brazil", `${SEEN}&skip=300`)]) {
    const d = await r.get(p);
    assert.equal(d.headers.get("x-index-source"), "none", `${p}: the piece cannot give it, the whole index is not there`);
    assert.deepEqual(d.json.metas, [], p);
  }
});

test("X-Total is exact whatever the piece holds: every option, default and Include seen, against the totals worked out from the index object (a seen film, a film under the rule and one the music rule holds back all sit in the ids)", async () => {
  const r = rig(PIECES_ONLY);
  for (const [cat, label, ids, curated] of OPTIONS) {
    const a = await r.get(path(cat, label)), b = await r.get(path(cat, label, SEEN));
    assert.equal(a.headers.get("x-index-source") === "none", false, `${label}: answered by its piece`);
    assert.equal(total(a), expected(ids, { curated }).length, `${label}: default`);
    assert.equal(total(b), expected(ids, { curated, seen: true }).length, `${label}: Include seen`);
    assert.deepEqual(names(a), expected(ids, { curated }).slice(0, 100).map((e) => e.name), label);
  }
  assert.notEqual(expected(BIG).length, expected(BIG, { seen: true }).length, "the two views differ in this index");
});

test("an option the piece holds whole (fewer than 300 films on the screen) answers every page from it, the empty ones past the end included, with the exact total", async () => {
  const r = rig(PIECES_ONLY);
  const small = expected(SMALL);
  const p1 = await r.get(path("places", "Small"));
  assert.deepEqual(names(p1), small.map((e) => e.name));
  assert.equal(total(p1), small.length);
  const past = await r.get(path("places", "Small", "&skip=500"));
  assert.equal(past.headers.get("x-index-source"), "memory", "past the end is still the piece's answer (from memory: page 1 read it): it holds the whole option");
  assert.deepEqual(past.json.metas, []);
  assert.equal(total(past), small.length);
  const union = await r.get(path("places", "Union", "&skip=200"));
  assert.deepEqual(names(union), expected(UNION, { curated: true }).slice(200, 300).map((e) => e.name), "a curated option: no recommendation rule, so the page runs on into the 200s");
  assert.equal(total(union), expected(UNION, { curated: true }).length);
});

test("a director's card from its piece keeps the build's \"Loved by …\" texts for the films of that director's option, and the film's own text for the others", async () => {
  const r = rig(PIECES_ONLY);
  const card = await r.get(path("filmmaker-picks", "Lynch card"));
  assert.equal(card.status, 200);
  const by = Object.fromEntries(card.json.metas.map((m) => [m.name, m]));
  assert.match(by["Film 101"].description, /Loved by Lynch · interview \(2020\)/);
  assert.match(by["Film 103"].description, /Loved by Lynch and Scorsese · poll/);
  assert.doesNotMatch(by["Film 104"].description, /Loved by/);
  const whole = rig(WHOLE);
  assert.equal(card.text, (await whole.get(path("filmmaker-picks", "Lynch card"))).text, "the same bytes as the whole index gives");
});

test("never a partial page: a missing piece, a piece cut short, a piece from a build before the totals and a piece that is not JSON are each answered by the whole index with the same bytes", async () => {
  const want = (await rig(WHOLE).get(path("places", "Brazil", "&skip=200"))).text;
  const piece = JSON.parse(PIECES["index-v2-opt-places-c-brazil.json"]);
  const damaged = {
    "a missing piece": (files) => { delete files["index-v2-opt-places-c-brazil.json"]; },
    "a piece cut to 100 films": (files) => { const j = JSON.parse(files["index-v2-opt-places-c-brazil.json"]); j.films = j.films.slice(0, 100); j.meta.count = 100; files["index-v2-opt-places-c-brazil.json"] = JSON.stringify(j); },
    "a piece with no totals": (files) => { const j = JSON.parse(files["index-v2-opt-places-c-brazil.json"]); delete j.discover.catalogs[0].options[0].total; delete j.discover.catalogs[0].options[0].totalAll; files["index-v2-opt-places-c-brazil.json"] = JSON.stringify(j); },
    "a piece with a total that is too small": (files) => { const j = JSON.parse(files["index-v2-opt-places-c-brazil.json"]); j.discover.catalogs[0].options[0].total = 10; files["index-v2-opt-places-c-brazil.json"] = JSON.stringify(j); },
    "a piece that is not JSON": (files) => { files["index-v2-opt-places-c-brazil.json"] = "<html>not found</html>"; },
    "a piece of another option": (files) => { files["index-v2-opt-places-c-brazil.json"] = files["index-v2-opt-places-c-small.json"]; },
  };
  assert.ok(piece.films.length > 300);
  for (const [what, damage] of Object.entries(damaged)) {
    const files = { ...FULL };
    damage(files);
    const r = rig(files);
    const got = await r.get(path("places", "Brazil", "&skip=200"));
    assert.equal(got.status, 200, what);
    assert.equal(got.text, want, `${what}: the whole index's page, not a partial one`);
    assert.ok(r.calls.includes("index-v2.json"), `${what}: the whole index was read`);
  }
});

test("a piece that is not published is asked once and remembered for the TTL, said once as `option-piece-absent`; it never says `v2-absent` nor `index-unavailable`", async () => {
  const r = rig(WHOLE);
  for (const extra of ["", "&skip=100", "&skip=200", SEEN]) assert.equal((await r.get(path("places", "Brazil", extra))).status, 200);
  await r.get(path("places", "Small"));
  assert.equal(r.calls.filter((c) => c === "index-v2-opt-places-c-brazil.json").length, 1, "one request for the missing piece, not one per page");
  assert.deepEqual(r.logs.map((o) => o.event), ["option-piece-absent"], "one line for all the missing pieces of the isolate");
});

test("optionPage: the piece's own rules — a menu on top, a page it cannot fill, a piece that shows more than its option, a request for another option: null, and the whole index answers", () => {
  const ix = hydrate(JSON.parse(PIECES["index-v2-opt-places-c-brazil.json"]));
  const ask = (query) => optionPage(ix, "places", "c-brazil", parseExtras(query));
  assert.equal(ask("genre=Brazil").total, expected(BIG).length);
  assert.equal(ask("genre=Brazil&skip=200").entries.length, 100);
  assert.equal(ask("genre=Brazil&skip=300"), null, "past the 300 films it holds");
  assert.equal(ask("genre=Brazil&decade=1960s"), null, "a menu on top");
  assert.equal(ask("genre=Small"), null, "another option of the catalog");
  assert.equal(ask("genre=no%20such%20option"), null);
  assert.equal(optionPage(ix, "places", "c-small", parseExtras("genre=Small")), null, "this piece is not that option's: its ids are empty and it has no totals");
  assert.equal(optionPage(ix, "elsewhere", "c-brazil", parseExtras("genre=Brazil")), null);
  const lying = hydrate(JSON.parse(PIECES["index-v2-opt-places-c-brazil.json"]));
  lying.discover.catalogs[0].options[0].total = 5;
  assert.equal(optionPage(lying, "places", "c-brazil", parseExtras("genre=Brazil")), null, "it shows more films than the option is said to have");
});

// ── review of 29/10/2026 (408d3cc) ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("a total LARGER than the piece's truth is NOT detected by the Worker (the limit, pinned): the page is the right films and X-Total is the piece's number; verify.js is the only barrier, and it refuses that piece", async () => {
  // Defect found 29/10/2026 by the adversarial review: the prose said a piece "lying about the totals" falls back to the whole index; only a total SMALLER than what the piece shows does (above). A piece cannot be checked against
  // a count it does not hold, so a build that writes 50 too many reaches Stremio as an X-Total 50 too high until the next night. Pinned here so the prose cannot claim more again.
  const files = { ...PIECES_ONLY };
  const j = JSON.parse(files["index-v2-opt-places-c-brazil.json"]);
  const real = j.discover.catalogs[0].options[0].total;
  j.discover.catalogs[0].options[0].total = real + 50;
  files["index-v2-opt-places-c-brazil.json"] = JSON.stringify(j);
  const r = rig(files);
  const got = await r.get(path("places", "Brazil"));
  assert.notEqual(got.headers.get("x-index-source"), "none", "answered by the piece");
  assert.deepEqual(names(got), expected(BIG).slice(0, 100).map((e) => e.name), "the films are right");
  assert.equal(total(got), real + 50, "and X-Total is what the piece says, 50 too high");
});

test("a filtered partial option tries its piece, then uses the whole index", async () => {
  for (const extra of ["&decade=1960s", "&country=France", `&runtime=90%E2%80%93120%20min`, "&rating=4.2%2B", `&decade=1960s${SEEN}`]) {
    const r = rig(FULL);
    const got = await r.get(path("places", "Brazil", extra));
    assert.equal(got.status, 200, extra);
    assert.deepEqual(r.calls.filter((c) => c.startsWith("index-v2-opt-")), ["index-v2-opt-places-c-brazil.json"], `${extra}: completeness was checked`);
    assert.ok(r.calls.includes("index-v2.json"), `${extra}: the whole index answered`);
  }
});

test("Pages not answering for a piece does not cost the request its wait: with the whole v2 index already fresh in memory the piece is not fetched at all (reviewed: 20,044 ms for Drama page 1 against 37 ms with a quick 404)", async () => {
  const r = rig(FULL, { hang: /^index-v2-opt-/ });
  assert.equal((await r.get("/catalog/movie/explore.json")).status, 200, "warms the whole v2 index (Explore reads it)");
  const t0 = Date.now();
  const got = await r.get(path("places", "Brazil"));
  const ms = Date.now() - t0;
  assert.equal(got.status, 200);
  assert.deepEqual(names(got), expected(BIG).slice(0, 100).map((e) => e.name));
  assert.deepEqual(r.calls.filter((c) => c.startsWith("index-v2-opt-")), [], "the piece was not asked for");
  assert.ok(ms < 1000, `${ms} ms`);
  assert.equal(r.store.fresh(`${DIR}index-v2.json`), true);
  assert.equal(r.store.fresh(`${DIR}index-v2-opt-places-c-brazil.json`), false);
});

test("and with the whole index NOT in memory, a piece that Pages never answers has its own short deadline, not the 20 s of the index: the whole index answers after it", async () => {
  const r = rig(FULL, { hang: /^index-v2-opt-/, store: { fetchTimeoutMs: 1000, optionPieceTimeoutMs: 40 } });
  const t0 = Date.now();
  const got = await r.get(path("places", "Brazil", "&skip=100"));
  const ms = Date.now() - t0;
  assert.equal(got.status, 200);
  assert.equal(got.text, (await rig(WHOLE).get(path("places", "Brazil", "&skip=100"))).text, "the whole index's page");
  assert.ok(ms < 400, `${ms} ms: the piece's deadline (40 ms), not the index's (1000 ms)`);
  assert.ok(r.logs.some((o) => o.event === "index-fetch-limit" && /index-v2-opt-/.test(o.url) && o.reason === "timeout"), "said once as a timeout");
});


test("complete options: seven friends and Marco, every filter and page have whole-index bodies and totals without reading it", async () => {
  const people = [...FRIEND_SLUGS];
  const ix = { ...V2, friends: { ...V2.friends, people }, films: V2.films.map((f, i) => ({ ...f,
    ...(i % 19 === 0 ? { runtime: null, countries: [], lbRating: null, tmdbRating: null } : {}),
    friends: { seenBy: people.filter((_, bit) => (i + bit) % (bit + 2) === 0).map((n) => [n, 4]), wantBy: [] },
  })) };
  const wholeFiles = v2FilesOf(ix);
  const pieces = Object.fromEntries(exporter.optionPieces(ix).map((p) => [p.rel.split("/").pop(), textOf(p.obj)]));
  const { "index-v2.json": unused, ...menus } = wholeFiles;
  // Menus deliberately have the opposite people order; only the piece's own order identifies the viewer's mask.
  const menu = JSON.parse(menus["index-v2-menus.json"]);
  menu.friends.people.reverse();
  menus["index-v2-menus.json"] = JSON.stringify(menu);
  const reference = rig(wholeFiles), candidate = rig({ ...menus, ...pieces });
  const filters = ["", "&decade=1960s", "&country=France", "&runtime=90%E2%80%93120%20min", "&rating=4.2%2B",
    "&decade=1960s&country=France&runtime=90%E2%80%93120%20min&rating=4.2%2B", "&country=Atlantis", "&decade=invalid"];
  for (const who of [null, ...people]) for (const [cat, label] of OPTIONS.slice(1)) {
    const prefix = who ? `/u/${who}` : "";
    for (const filter of filters) for (const seen of ["", SEEN]) {
      const count = total(await reference.get(prefix + path(cat, label, `${filter}${seen}`)));
      for (const skip of new Set([0, 100, 200, 300, 13, Math.max(0, count - 1), count + 1, 500])) {
        const url = prefix + path(cat, label, `${filter}${seen}&skip=${skip}`);
        const a = await candidate.get(url), b = await reference.get(url);
        assert.equal(a.status, 200, url);
        assert.equal(a.text, b.text, `${url}: full cards and order`);
        assert.deepEqual(headersOf(a), headersOf(b), `${url}: total and contractual headers`);
        assert.ok(!candidate.calls.includes("index-v2.json"), `${url}: complete piece alone`);
      }
    }
  }
});


test("complete-piece identity, totals and exact unique ID coverage are required before any optimized answer", async () => {
  const name = "index-v2-opt-places-c-small.json";
  const changes = {
    "wrong part": (j) => { j.meta.part = "v2-opt:places:c-brazil"; },
    "wrong option": (j) => { j.discover.catalogs[0].options[1].id = "wrong"; },
    "negative total": (j) => { j.discover.catalogs[0].options[1].total = -1; },
    "fractional totalAll": (j) => { j.discover.catalogs[0].options[1].totalAll = 1.5; },
    "inverted totals": (j) => { j.discover.catalogs[0].options[1].totalAll = 0; },
    "missing film": (j) => { j.films.pop(); },
    "extra film": (j) => { j.films.push(JSON.parse(WHOLE["index-v2.json"]).films[0]); },
    "duplicate film": (j) => { j.films[0] = j.films[1]; },
    "duplicate ID": (j) => { j.discover.catalogs[0].options[1].ids[0] = j.discover.catalogs[0].options[1].ids[1]; },
    "unresolved ID": (j) => { j.discover.catalogs[0].options[1].ids[0] = "tt99999999"; },
    "invalid ID": (j) => { j.discover.catalogs[0].options[1].ids[0] = 42; },
  };
  for (const [what, change] of Object.entries(changes)) for (const filter of ["", "&country=France"]) {
    const j = JSON.parse(PIECES[name]); change(j);
    const r = rig({ ...FULL, [name]: JSON.stringify(j) }), url = path("places", "Small", filter);
    const got = await r.get(url), want = await rig(WHOLE).get(url);
    assert.equal(got.text, want.text, what);
    assert.deepEqual(headersOf(got), headersOf(want), what);
    assert.ok(r.calls.includes("index-v2.json"), `${what}: full fallback`);
  }
});

function animationIndex() {
  const people = [...FRIEND_SLUGS];
  const ix = { ...V2,
    meta: { ...V2.meta, countries: ["Brazil", "Japan"] },
    friends: { ...V2.friends, people },
    discover: { ...DISCOVER, order: [...DISCOVER.order, "genres"], catalogs: [...DISCOVER.catalogs, {
      id: "genres", name: "Genres", options: [{ id: "g-animation", label: "Animation", ids: BIG }],
    }] },
    films: V2.films.map((f, i) => ({ ...f, countries: i % 2 ? ["Japan"] : ["Brazil"],
      friends: { seenBy: people.filter((_, bit) => (i + bit) % (bit + 2) === 0).map((n) => [n, 4]), wantBy: [] },
    })),
  };
  return ix;
}

test("Animation above the old prefix: 640 HTTP comparisons, every friend/filter/page without the full index", async () => {
  const ix = animationIndex();
  const people = [...FRIEND_SLUGS];
  const opt = ix.discover.catalogs.at(-1).options[0];
  assert.ok(exporter.optionCut(new Map(ix.films.map((f) => [f.tt, f])), opt).n < BIG.length,
    "this option actually exceeds the previous prefix");
  const wholeFiles = v2FilesOf(ix);
  const { "index-v2.json": unused, ...menus } = wholeFiles;
  const pieces = Object.fromEntries(exporter.optionPieces(ix).map((p) => [p.rel.split("/").pop(), textOf(p.obj)]));
  const reference = rig(wholeFiles);
  // Menu order differs from the piece, so masks must use the piece's people table.
  const menu = JSON.parse(menus["index-v2-menus.json"]);
  menu.friends.people.reverse();
  menus["index-v2-menus.json"] = JSON.stringify(menu);
  const extras = ["", "&country=Japan", "&decade=1990s", "&runtime=Under%2090%20min", "&rating=4.2%2B",
    "&country=Japan&decade=1990s&runtime=Under%2090%20min&rating=4.2%2B", SEEN, `&country=Japan${SEEN}`, "&runtime=invalid", "&country=Atlantis"];
  let comparisons = 0;
  for (const who of [null, ...people]) for (const extra of extras) {
    const prefix = who ? `/u/${who}` : "";
    const count = total(await reference.get(prefix + path("genres", "Animation", extra)));
    for (const skip of [0, 100, 200, 300, 400, 17, Math.max(0, count - 1), count + 100]) {
      const candidate = rig({ ...menus, ...pieces });
      const url = prefix + path("genres", "Animation", `${extra}&skip=${skip}`);
      const a = await candidate.get(url), b = await reference.get(url);
      assert.equal(a.status, 200, url);
      assert.equal(a.text, b.text, `${url}: identical cards and ordering`);
      assert.deepEqual(headersOf(a), headersOf(b), `${url}: identical totals and contractual headers`);
      assert.ok(candidate.calls.includes("index-v2-opt-genres-g-animation.json"), `${url}: own piece read`);
      assert.ok(!candidate.calls.includes("index-v2.json"), `${url}: no whole-index fallback`);
      comparisons++;
    }
  }
  assert.equal(comparisons, 640);
});

test("Animation over the byte cap retains prefix and full fallback; old, absent, invalid or wrong pieces retain full answers", async () => {
  const small = animationIndex();
  const over = { ...small, films: small.films.map((f) => ({ ...f, desc: "字".repeat(700) })) };
  const part = "index-v2-opt-genres-g-animation.json";
  const original = exporter.optionPieces({ ...small, meta: { ...small.meta, personId: "friend-a" } }).find((p) => p.part === "v2-opt:genres:g-animation").obj;
  delete original.meta.personId; // old prefix, served by the same Worker
  for (const [name, ix, change] of [
    ["over cap", over, (files) => files],
    ["old prefix", small, (files) => ({ ...files, [part]: textOf(original) })],
    ["missing", small, (files) => ({ ...files, [part]: undefined })],
    ["invalid JSON", small, (files) => ({ ...files, [part]: "{" })],
    ["wrong part", small, (files) => {
      const j = JSON.parse(files[part]); j.meta.part = "v2-opt:genres:g-drama";
      return { ...files, [part]: JSON.stringify(j) };
    }],
  ]) {
    const whole = v2FilesOf(ix);
    const pieces = Object.fromEntries(exporter.optionPieces(ix).map((p) => [p.rel.split("/").pop(), textOf(p.obj)]));
    if (name === "over cap") assert.ok(JSON.parse(pieces[part]).films.length < BIG.length, "oversize stays partial");
    for (const who of [null, ...FRIEND_SLUGS]) {
      const candidate = rig(change({ ...whole, ...pieces }));
      const url = (who ? `/u/${who}` : "") + path("genres", "Animation", "&country=Japan&skip=100");
      const a = await candidate.get(url), b = await rig(whole).get(url);
      assert.equal(a.status, 200, `${name}: ${url}`);
      assert.equal(a.text, b.text, `${name}: ${url}`);
      assert.deepEqual(headersOf(a), headersOf(b), `${name}: ${url}`);
      assert.ok(candidate.calls.includes("index-v2.json"), `${name}: whole-index fallback`);
    }
  }
});
