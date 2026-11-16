// The Worker 3.4.0 (22/10/2026; Marco, 22/10/2026), 3.4.1 since 24/10/2026, 3.5.0 since the proposal 5 of 28/10/2026 (curated options, directors' cards, the Genre filter of Explore: the last section of this file): the Discover grouped by subject — Countries & regions, Decades & eras and the lists in six catalogs — end to end through the handler.
// What is asserted, in the order of the file: a calculated option (the page, the four menus on top, "Include seen", the recommendation rule and the music rule), a list option (the same answer
// as Lists (unseen) and Lists), how an option is found (the label, the words, the short name and the old full name, no genre at all, an unknown one), the catalogs that retire and still answer,
// the profiles, the manifest (3.5.0, only with `discover`; the goldens of 3.4.1 and 3.5.0), and the real labels of data/discover-catalogs.json sent the way a phone sends them.
// The index here is built by this file (a hundred and thirty Brazilian films and two lists), so that nothing disputes worker/test/fixture.js.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createHandler } from "../src/handler.js";
import { createStore } from "../src/store.js";
import { buildManifest, buildProfileManifest, ADDON_VERSION, DISCOVER_VERSION } from "../src/manifest.js";
import { PROFILES } from "../src/profiles.js";
import { discoverCatalog, discoverOption, includeSeen } from "../src/catalogs.js";
import { parseExtras } from "../src/extras.js";
import { hydrate } from "../src/film.js";
import { makeV2Files, makeV2Object, textOf, v2FilesOf, v2ObjectFrom } from "./fixture.js";

const require = createRequire(import.meta.url);
const exporter = require("../../lib/index-export.js");

const DIR = "https://pages.test/mood-engine/data/";
const ENV = { INDEX_URL: `${DIR}index.json` };
const DASH = "–";

// ── the index of this file ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

const film = (i, o = {}) => {
  const name = o.name || `Film ${String(i).padStart(3, "0")}`;
  const year = o.year ?? 1950 + (i % 5) * 10 + (i % 3);
  const e = {
    tt: `tt${9000000 + i}`, name, year, decade: `${Math.floor(year / 10) * 10}s`, runtime: o.runtime ?? 80 + (i % 4) * 20, countries: o.countries ?? (i % 2 ? ["Brazil"] : ["Brazil", "France"]),
    director: `Director ${i}`, lbRating: o.lbRating ?? Math.round((3.6 + (i % 7) * 0.1) * 10) / 10, rank: 10 - i / 100, eligible: true,
    desc: `${name} cast\nMood: \u{1F3A5} Documentaries \u00b7 ${name} genres.\n\nSynopsis of ${name}.`, find: ` ${name.toLowerCase()}`, ...o.extra,
  };
  if (o.eligible === false) delete e.eligible;
  return e;
};
const BRAZIL = Array.from({ length: 130 }, (_, i) => film(i + 1));
const SEEN = film(3, { extra: { seen: true } }), BELOW = film(4, { lbRating: 3.2, eligible: false }), MUSIC = film(5, { extra: { musicOut: true } });
BRAZIL.splice(2, 3, SEEN, BELOW, MUSIC); // the third, the fourth and the fifth of the option: a film he has seen, one the rule keeps out, one the music rule holds back
const LISTED = [film(201, { extra: { lists: { tspdt: 1 } } }), film(202, { extra: { lists: { tspdt: 2 } } }), film(203, { extra: { seen: true, lists: { tspdt: 3, "ss-2022": 1 } } }), film(204, { lbRating: 3.1, eligible: false, extra: { lists: { tspdt: 4 } } }), film(205, { extra: { lists: { "ss-2022": 2 } } })];
const FILMS = [...BRAZIL, ...LISTED, film(301, { name: "New Wave Film", year: 1962, countries: ["France"] })].sort((a, b) => b.rank - a.rank || a.tt.localeCompare(b.tt));
const byTt = new Map(FILMS.map((f) => [f.tt, f]));
const LISTS = [
  { id: "tspdt", label: "TSPDT 1,000 greatest films 2026 (tspdtfanaccount)", short: "TSPDT 1,000 greatest 2026", popular: false, films: 4 },
  { id: "ss-2022", label: "Sight and Sound greatest films 2022 (sightsoundmag)", short: "S&S greatest films 2022", popular: false, films: 2 },
];
const NV = `Nouvelle Vague 1958${DASH}73`;
const DISCOVER = {
  order: ["moods", "places", "eras", "critics", "explore", "search"],
  retire: ["lists", "lists-unseen"],
  seen: { name: "seen", option: "Include seen" },
  catalogs: [
    { id: "places", name: "Mood Engine · Countries & regions", options: [{ id: "c-brazil", label: "Brazil", ids: BRAZIL.map((f) => f.tt) }, { id: "l-tspdt", label: LISTS[0].short, list: "tspdt" }] },
    { id: "eras", name: "Mood Engine · Decades & eras", options: [{ id: "d-1960s", label: "1960s", ids: FILMS.filter((f) => f.decade === "1960s").map((f) => f.tt) }, { id: "e-nv", label: NV, ids: ["tt9000301"] }] },
    { id: "critics", name: "Mood Engine · Critics & awards", options: [{ id: "l-ss-2022", label: LISTS[1].short, list: "ss-2022" }, { id: "l-tspdt", label: LISTS[0].short, list: "tspdt" }] },
  ],
};
const BASE = makeV2Object();
function indexObject({ discover = DISCOVER, rules = null, directors = null } = {}) {
  const legacy = {
    ...BASE, board: [{ id: "tonight", name: "Tonight" }], rows: { tonight: [] }, rowDesc: { tonight: [] }, lists: LISTS, films: FILMS, ...(directors ? { directors } : {}),
    meta: { ...BASE.meta, count: FILMS.length, countries: ["Brazil", "France"], decades: BASE.meta.decades },
  };
  delete legacy.moodMenu;
  const v2 = v2ObjectFrom({ ...legacy, moods: BASE.moods }, {});
  const withRules = (o) => (rules ? { ...o, rules } : o);
  return { legacy: withRules(legacy), v2: withRules({ ...(discover ? { ...v2, discover } : v2), ...(directors ? { directors } : {}) }) };
}
function filesOf(opts) {
  const { legacy, v2 } = indexObject(opts);
  const files = { "index.json": textOf(legacy), ...v2FilesOf(v2) };
  for (const p of exporter.pieces(legacy)) files[p.rel.split("/").pop()] = textOf(p.obj);
  return files;
}
const FILES = filesOf();

function rig({ files = FILES, env = ENV } = {}) {
  const r = { calls: [] };
  const fetchImpl = async (url) => {
    const name = url.slice(DIR.length);
    r.calls.push(name);
    return files[name] ? new Response(files[name]) : new Response("not found", { status: 404 });
  };
  const handle = createHandler({ store: createStore({ fetchImpl, caches: undefined, log: () => {} }) });
  r.get = async (path, e = env) => {
    const res = await handle(new Request("https://mood-engine.example.workers.dev" + path), e, undefined);
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null };
  };
  return r;
}
const enc = encodeURIComponent;
const names = (r) => r.json.metas.map((m) => m.name);
const total = (r) => Number(r.headers.get("x-total"));
/** What the first page of a calculated option is, worked out here from the index object and not by the Worker: the ids in order, a film he has seen only when asked, only the recommendable. */
const expected = (ids, { seen = false } = {}) => ids.map((tt) => byTt.get(tt)).filter((e) => e.eligible && !e.musicOut && (seen || !e.seen));

// ── a calculated option ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("a calculated option: the first 100 of its ids that he has not seen and that recommend, in the build's order; skip=100 gives the rest; the whole v2 index is read, and nothing else", async () => {
  const r = rig();
  const all = expected(DISCOVER.catalogs[0].options[0].ids);
  assert.equal(all.length, 127, "130 films, less the seen one, the one under the rule and the one the music rule holds back");
  const first = await r.get("/catalog/movie/places/genre=Brazil.json");
  assert.equal(first.status, 200);
  assert.deepEqual(names(first), all.slice(0, 100).map((e) => e.name));
  assert.equal(total(first), 127);
  assert.equal(first.headers.get("x-page-size"), "100");
  assert.deepEqual(names(await r.get("/catalog/movie/places/genre=Brazil&skip=100.json")), all.slice(100).map((e) => e.name));
  // 29/10/2026 (Marco, "peças por opção do Discover"): the Worker asks first for the option's own piece (worker/test/discover-pieces.test.js); this rig publishes none, so the 404 is asked once (remembered for the TTL, not asked again by skip=100) and the whole index answers
  assert.deepEqual(r.calls, ["index-v2-menus.json", "index-v2-opt-places-c-brazil.json", "index-v2.json"], "the menus say which option it is; its piece is not there; the ids are in the whole index, which Explore reads too");
});

test("a calculated option with the four menus on top: decade, runtime, country (by name, any producer) and rating cut the option and keep its order", async () => {
  const r = rig();
  const base = expected(DISCOVER.catalogs[0].options[0].ids);
  const cut = (f) => base.filter(f).map((e) => e.name);
  const q = (x) => r.get(`/catalog/movie/places/genre=Brazil&${x}.json`).then(names);
  assert.deepEqual(await q("decade=1960s"), cut((e) => e.decade === "1960s"));
  assert.deepEqual(await q(`runtime=90${DASH}120%20min`), cut((e) => e.runtime >= 90 && e.runtime <= 120));
  assert.deepEqual(await q("country=France"), cut((e) => e.countries.includes("France")));
  assert.deepEqual(await q("rating=4.2%2B"), cut((e) => e.lbRating >= 4.2));
  const mixed = cut((e) => e.decade === "1960s" && e.countries.includes("France") && e.runtime >= 90 && e.runtime <= 120 && e.lbRating >= 4.0 && e.lbRating < 4.2);
  assert.ok(mixed.length > 0, "the fixture has films that pass all four");
  assert.deepEqual(await q(`decade=1960s&country=France&runtime=90${DASH}120%20min&rating=4.0${DASH}4.2`), mixed);
  assert.deepEqual(await q("decade=2020s"), [], "a decade with no film of the option is an empty page, never the option unfiltered");
});

test("\"Include seen\": the film he has seen comes back, in its place; without it, or with a value that is not the option, it stays out", async () => {
  const r = rig();
  const ids = DISCOVER.catalogs[0].options[0].ids;
  const withSeen = await r.get(`/catalog/movie/places/genre=Brazil&seen=${enc("Include seen")}.json`);
  assert.deepEqual(names(withSeen), expected(ids, { seen: true }).map((e) => e.name).slice(0, 100));
  assert.ok(names(withSeen).includes(SEEN.name));
  assert.equal(total(withSeen), 128);
  assert.ok(!names(await r.get("/catalog/movie/places/genre=Brazil.json")).includes(SEEN.name));
  assert.ok(!names(await r.get("/catalog/movie/places/genre=Brazil&seen=Nothing.json")).includes(SEEN.name));
  assert.ok(names(await r.get("/catalog/movie/places/genre=Brazil&seen=include+seen.json")).includes(SEEN.name), "the words alone, as every menu");
});

test("a film that is not eligible, or that the music rule holds back, never appears — not with \"Include seen\" either; the recommendation rule and the music rule hold in the new catalogs as in Explore", async () => {
  const r = rig();
  for (const path of ["/catalog/movie/places/genre=Brazil.json", `/catalog/movie/places/genre=Brazil&seen=${enc("Include seen")}.json`, "/catalog/movie/places/genre=Brazil&skip=100.json"]) {
    const got = names(await r.get(path));
    assert.ok(!got.includes(BELOW.name) && !got.includes(MUSIC.name), path);
  }
  assert.ok(DISCOVER.catalogs[0].options[0].ids.includes(BELOW.tt) && DISCOVER.catalogs[0].options[0].ids.includes(MUSIC.tt), "both are in the build's ids: the Worker is what keeps them out");
});

test("the exemption of the mood Music (rules.musicExemptMoods, PR #76) is the Moods menu's alone: with every mood exempt, no option of the Discover shows a film the music rule holds back", async () => {
  const rules = { rule: "letterboxd-average-or-configured-friend-or-vouched", minStars: 3.5, exemptCatalogs: ["lists", "lists-unseen", "friends"], musicExemptMoods: BASE.moods.map((m) => m.id) };
  const r = rig({ files: filesOf({ rules }) });
  assert.ok(JSON.parse(JSON.stringify(indexObject({ rules }).v2.rules)).musicExemptMoods.length >= 2, "the index does name exempt moods");
  for (const path of ["/catalog/movie/places/genre=Brazil.json", `/catalog/movie/places/genre=Brazil&seen=${enc("Include seen")}.json`, "/catalog/movie/places/genre=Brazil&skip=100.json", "/catalog/movie/places.json"]) assert.ok(!names(await r.get(path)).includes(MUSIC.name), path);
  assert.equal(total(await r.get("/catalog/movie/places/genre=Brazil.json")), 127, "the same 127 as without the exemption");
});

test("a card of a calculated option is a cut's card: the credits line from the columns, then the film's own general text — line 2 opens with the mood the film fits best (\"Mood: \u{1F3A5} Documentaries \u00b7 …\", D3, 21/10/2026, as in Explore), because a cut is a line that is no mood — and no name of a row or of the option", async () => {
  const r = rig();
  const m = (await r.get("/catalog/movie/places/genre=Brazil.json")).json.metas[0];
  // Marco, 28/10/2026: "Mood: …" is not written in a card any more (the build's `desc` still carries it, line 2 of the film's general text); the credits, the separator and the synopsis stay
  assert.equal(m.description, "Director 1 \u00b7 1h40 \u00b7 Film 001 cast.\n\nSynopsis of Film 001.");
  const explore = (await r.get("/catalog/movie/explore.json")).json.metas.find((x) => x.id === m.id);
  assert.equal(explore.description, m.description, "the same card as Explore gives the film");
  assert.ok(!/Brazil/.test(m.description), "the option's name is not in the card");
});

// ── a list option ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("a list option answers exactly as Lists (unseen) did — the curator's order, the seen film out, the rule NOT applied — and with \"Include seen\" exactly as Lists did", async () => {
  const r = rig();
  const unseen = await r.get(`/catalog/movie/places/genre=${enc(LISTS[0].short)}.json`);
  const old = await r.get(`/catalog/movie/lists-unseen/genre=${enc(LISTS[0].short)}.json`);
  assert.equal(unseen.status, 200);
  assert.deepEqual(unseen.json, old.json);
  assert.deepEqual(names(unseen), ["Film 201", "Film 202", "Film 204"], "the list's order; Film 203 is seen; Film 204 is under the rule and a list is exempt from it");
  const whole = await r.get(`/catalog/movie/places/genre=${enc(LISTS[0].short)}&seen=${enc("Include seen")}.json`);
  assert.deepEqual(whole.json, (await r.get(`/catalog/movie/lists/genre=${enc(LISTS[0].short)}.json`)).json);
  assert.deepEqual(names(whole), ["Film 201", "Film 202", "Film 203", "Film 204"]);
  assert.equal(total(whole), 4);
  assert.ok(r.calls.includes("index-list-tspdt.json") && !r.calls.includes("index-v2.json"), "a list reads its own piece, as before; not the whole index");
});

test("a list option takes the four menus on top as Lists did (the 12 countries of the legacy pieces)", async () => {
  const r = rig();
  const got = await r.get(`/catalog/movie/places/genre=${enc(LISTS[0].short)}&decade=1960s.json`);
  const old = await r.get(`/catalog/movie/lists-unseen/genre=${enc(LISTS[0].short)}&decade=1960s.json`);
  assert.deepEqual(got.json, old.json);
  assert.ok(got.json.metas.length > 0);
});

test("a list is found by its short name and by its old full name (the installs from before); in either catalog that holds it, with the same answer", async () => {
  const r = rig();
  const bySh = await r.get(`/catalog/movie/places/genre=${enc(LISTS[0].short)}.json`);
  const byFull = await r.get(`/catalog/movie/places/genre=${enc(LISTS[0].label)}.json`);
  assert.deepEqual(byFull.json, bySh.json);
  assert.deepEqual((await r.get(`/catalog/movie/critics/genre=${enc(LISTS[0].short)}.json`)).json, bySh.json, "the same list under another catalog");
  assert.equal((await r.get(`/catalog/movie/critics/genre=${enc(LISTS[1].label)}.json`)).json.metas.length, 1, "the other list's full name, in its catalog");
  assert.deepEqual(await r.get(`/catalog/movie/eras/genre=${enc(LISTS[0].label)}.json`).then((x) => x.json.metas), [], "a list that is not in this catalog is not an option of it");
});

// ── how an option is found ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("no genre at all (NuvioTV's Discover opens on Default): the first option answers — a calculated one in Countries & regions, a list in Critics & awards; the same as asking for it by name", async () => {
  const r = rig();
  const none = await r.get("/catalog/movie/places.json");
  assert.deepEqual(none.json, (await r.get("/catalog/movie/places/genre=Brazil.json")).json);
  assert.ok(none.json.metas.length > 0);
  const list = await r.get("/catalog/movie/critics.json");
  assert.deepEqual(list.json, (await r.get(`/catalog/movie/critics/genre=${enc(LISTS[1].short)}.json`)).json);
  assert.ok(list.json.metas.length > 0);
  assert.deepEqual(names(await r.get("/catalog/movie/places/decade=1960s.json")), names(await r.get("/catalog/movie/places/genre=Brazil&decade=1960s.json")), "the menus still cut it");
});

test("an option that is not in the menu is an empty page with X-Total 0, never the first option and never an error", async () => {
  const r = rig();
  for (const p of ["/catalog/movie/places/genre=Atlantis.json", "/catalog/movie/places/genre=.json", "/catalog/movie/eras/genre=Brazil.json", "/catalog/movie/places/genre=Cannes.json"]) {
    const got = await r.get(p);
    assert.equal(got.status, 200, p);
    assert.deepEqual(got.json.metas, [], p);
    assert.equal(got.headers.get("x-total"), "0", p);
  }
});

test("the words alone find an option: another case, a plus for a space, a typed hyphen for the en dash of an era", async () => {
  const r = rig();
  const canonical = await r.get(`/catalog/movie/eras/genre=${enc(NV)}.json`);
  assert.deepEqual(names(canonical), ["New Wave Film"]);
  for (const sent of ["Nouvelle Vague 1958-73", "nouvelle+vague+1958-73", enc("NOUVELLE VAGUE 1958–73")]) assert.deepEqual((await r.get(`/catalog/movie/eras/genre=${sent}.json`)).json, canonical.json, sent);
  assert.deepEqual(names(await r.get("/catalog/movie/places/genre=brazil.json")), names(await r.get("/catalog/movie/places/genre=Brazil.json")));
});

test("a label with an ampersand opens its list: sent encoded (%26, the way Stremio sends it), with a plus for each space, or in words (\"and\"); raw, the ampersand splits the extras and the page is empty — never another list", async () => {
  const r = rig();
  const want = (await r.get(`/catalog/movie/critics/genre=${enc("S&S greatest films 2022")}.json`)).json;
  assert.deepEqual(want.metas.map((m) => m.name), ["Film 205"], "Film 203 is seen");
  assert.equal(enc("S&S greatest films 2022"), "S%26S%20greatest%20films%202022");
  assert.deepEqual((await r.get("/catalog/movie/critics/genre=S%26S+greatest+films+2022.json")).json, want);
  assert.deepEqual((await r.get("/catalog/movie/critics/genre=S+and+S+greatest+films+2022.json")).json, want);
  const raw = await r.get("/catalog/movie/critics/genre=S&S greatest films 2022.json");
  assert.deepEqual(raw.json.metas, [], "genre arrives as \"S\"");
  assert.deepEqual(parseExtras("genre=S&S greatest films 2022"), { genre: "S", "S greatest films 2022": "" });
  assert.deepEqual(parseExtras("decade=1960s&genre=S%26S%20greatest%20films%202022"), { decade: "1960s", genre: "S&S greatest films 2022" });
});

// ── the catalogs that retire ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("Lists and Lists (unseen) are out of the manifest and still answer, by the short name and by the old full name, with films", async () => {
  const r = rig();
  assert.ok(!(await r.get("/manifest.json")).json.catalogs.some((c) => c.id === "lists" || c.id === "lists-unseen"));
  for (const id of ["lists", "lists-unseen"]) for (const name of [LISTS[0].short, LISTS[0].label]) {
    const got = await r.get(`/catalog/movie/${id}/genre=${enc(name)}.json`);
    assert.equal(got.status, 200, `${id} ${name}`);
    assert.ok(got.json.metas.length >= 3, `${id} ${name}`);
  }
  const k = "k".repeat(24), env = { ...ENV, SUBTITLES_PRIVATE_TOKEN: k };
  const priv = rig({ env });
  // 24/10/2026 (film page, rebased on 3.4.1): under /k/ each card also carries behaviorHints.defaultVideoId = its IMDb id; the public address sends none. Same cards otherwise.
  const [pubLists, privLists] = [(await r.get(`/catalog/movie/lists-unseen/genre=${enc(LISTS[0].label)}.json`)).json, (await priv.get(`/k/${k}/catalog/movie/lists-unseen/genre=${enc(LISTS[0].label)}.json`, env)).json];
  assert.ok(pubLists.metas.length >= 3);
  for (const m of pubLists.metas) assert.equal(m.behaviorHints, undefined, `public ${m.id}`);
  for (const m of privLists.metas) assert.deepEqual(m.behaviorHints, { defaultVideoId: m.id }, `private ${m.id}`);
  assert.deepEqual({ ...privLists, metas: privLists.metas.map(({ behaviorHints, ...m }) => m) }, pubLists);
});

test("the Marco profile: its manifest has the grouped catalogs (not shown on the Home) and its old Lists catalogs still answer though no manifest declares them; the other profiles do not have them", async () => {
  const r = rig();
  const marco = (await r.get("/p/marco/manifest.json")).json;
  assert.equal(marco.version, "3.2.1", "the profile has its own version, not the main manifest's");
  const ids = marco.catalogs.map((c) => c.id);
  for (const id of ["places", "eras", "critics"]) assert.equal(marco.catalogs.find((c) => c.id === id).showInHome, false, id);
  assert.ok(!ids.includes("lists") && !ids.includes("lists-unseen"));
  const lists = await r.get(`/p/marco/catalog/movie/lists/genre=${enc(LISTS[0].short)}.json`);
  assert.equal(lists.status, 200);
  assert.ok(lists.json.metas.length >= 3);
  assert.deepEqual(lists.json.metas, (await r.get(`/catalog/movie/lists/genre=${enc(LISTS[0].short)}.json`)).json.metas);
  assert.deepEqual((await r.get("/p/marco/catalog/movie/places/genre=Brazil.json")).json.metas, (await r.get("/catalog/movie/places/genre=Brazil.json")).json.metas);
  assert.equal((await r.get("/p/night/catalog/movie/places/genre=Brazil.json")).status, 404, "a mood profile is handed the legacy index and never sees the family");
  assert.equal((await r.get("/p/night/catalog/movie/lists/genre=Anything.json")).status, 404, "and the retired catalogs are Marco's alone");
});

test("a v2 index with no `discover` answers the grouped catalogs with 404 unknown catalog, and its manifest is the 3.3.0 one", async () => {
  const r = rig({ files: filesOf({ discover: null }) });
  const got = await r.get("/catalog/movie/places/genre=Brazil.json");
  assert.equal(got.status, 404);
  assert.deepEqual(got.json, { err: "unknown catalog" });
  const m = (await r.get("/manifest.json")).json;
  assert.equal(m.version, "3.3.0");
  assert.ok(m.catalogs.some((c) => c.id === "lists") && !m.catalogs.some((c) => c.id === "places"));
});

test("with the legacy files alone (no v2 menus) a grouped catalog is a 404 too, and the lists answer as before", async () => {
  const { legacy } = indexObject();
  const files = { "index.json": textOf(legacy) };
  for (const p of exporter.pieces(legacy)) files[p.rel.split("/").pop()] = textOf(p.obj);
  const r = rig({ files });
  assert.equal((await r.get("/catalog/movie/places/genre=Brazil.json")).status, 404);
  assert.equal((await r.get(`/catalog/movie/lists/genre=${enc(LISTS[0].short)}.json`)).status, 200);
});

// ── the manifest ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("manifest 3.5.0: the catalogs in the order of discover.order, the retired ones left out, the Board's rows after them; the version is 3.5.0", async () => {
  const m = (await rig().get("/manifest.json")).json;
  assert.equal(m.version, "3.5.0");
  assert.equal(DISCOVER_VERSION, "3.5.0");
  assert.equal(ADDON_VERSION, "3.3.0", "the version of an index with no discover does not move");
  assert.deepEqual(m.catalogs.map((c) => c.id), ["moods", "places", "eras", "critics", "explore", "search", "tonight", "my-series"]);
  assert.deepEqual(m.catalogs.filter((c) => (c.extra || []).length).map((c) => c.id), DISCOVER.order.filter((id) => !DISCOVER.retire.includes(id)));
  assert.deepEqual(m.catalogs.slice(1, 4).map((c) => c.name), DISCOVER.catalogs.map((c) => c.name));
});

test("manifest 3.4.1: a catalog the index retires is not declared even if the index's order still lists it (defence: the manifest does not trust `order` alone)", () => {
  const { v2 } = indexObject();
  const ix = hydrate(JSON.parse(textOf({ ...v2, discover: { ...DISCOVER, order: ["moods", "lists", "places", "lists-unseen", "eras", "critics", "explore", "search"] } })));
  const ids = buildManifest(ix).catalogs.map((c) => c.id);
  assert.ok(!ids.includes("lists") && !ids.includes("lists-unseen"), ids.join());
  assert.deepEqual(ids.slice(0, 4), ["moods", "places", "eras", "critics"]);
});

test("manifest 3.4.1: each grouped catalog has a required genre menu with its labels in order, the four optional menus, the optional Include seen, and skip — the country menu is the legacy 12", async () => {
  const m = (await rig().get("/manifest.json")).json;
  for (const c of DISCOVER.catalogs) {
    const got = m.catalogs.find((x) => x.id === c.id);
    assert.equal(got.type, "movie");
    assert.deepEqual(got.extra.map((e) => e.name), ["genre", "decade", "runtime", "country", "rating", "seen", "skip"], c.id);
    assert.deepEqual(got.extra[0], { name: "genre", isRequired: true, options: c.options.map((o) => o.label) }, c.id);
    assert.deepEqual(got.extra[5], { name: "seen", isRequired: false, options: ["Include seen"] }, c.id);
    assert.deepEqual(got.extra.find((e) => e.name === "country").options, ["Brazil", "France"], `${c.id}: the legacy menu (the lists are read from legacy pieces)`);
  }
  assert.ok(m.catalogs.find((c) => c.id === "moods").extra.every((e) => e.name !== "seen"), "the filter belongs to the grouped catalogs alone");
});

test("manifest 3.4.1: the Marco profile mirrors it with showInHome false; a person's manifest has the grouped catalogs only when the index of that person has `discover`", () => {
  const { v2 } = indexObject();
  const ix = hydrate(JSON.parse(textOf(v2)));
  const marco = buildProfileManifest(ix, { key: "marco", ...PROFILES.get("marco") });
  assert.ok(marco.catalogs.filter((c) => ["places", "eras", "critics"].includes(c.id)).every((c) => c.showInHome === false));
  const person = { id: "friend-a", name: "Will" };
  assert.deepEqual(buildManifest(ix, { person }).catalogs.map((c) => c.id).slice(0, 4), ["moods", "places", "eras", "critics"]);
  const plain = hydrate(JSON.parse(textOf(indexObject({ discover: null }).v2)));
  assert.ok(!buildManifest(plain, { person }).catalogs.some((c) => c.id === "places"));
  assert.equal(buildManifest(plain, { person }).version, "3.3.0");
});

test("the description of the 3.4.1 manifest and of the Marco profile no longer speaks of \"the full Lists\" (there is no Lists catalog) and says what Include seen does; the 3.3.0 description stays (golden)", async () => {
  const r = rig();
  const [main, marco] = [(await r.get("/manifest.json")).json, (await r.get("/p/marco/manifest.json")).json];
  for (const m of [main, marco]) {
    assert.ok(!/full Lists/.test(m.description), m.description);
    assert.match(m.description, /Never shows what you've already seen \(except Old friends, and in the lists and cuts of the Discover when you ask with Include seen\)\./);
  }
  const old = rig({ files: makeV2Files() });
  for (const p of ["/manifest.json", "/p/marco/manifest.json"]) assert.match((await old.get(p)).json.description, /\(except Old friends and the full Lists\)/, p);
});

test("an index with no `discover` makes, byte for byte, the 3.3.0 manifest of fixtures/manifest-3.3.0.json", async () => {
  const r = rig({ files: makeV2Files() });
  assert.equal((await r.get("/manifest.json")).text, fs.readFileSync(new URL("./fixtures/manifest-3.3.0.json", import.meta.url), "utf8"));
});

test("an index with `discover` and none of the 3.5.0 keys makes, byte for byte, the manifest of fixtures/manifest-3.4.1.json, the version apart (Marco, 28/10/2026, proposal 5: the Worker 3.5.0 is compatible with the index of 3.4.1; Explore keeps its single \"All\")", async () => {
  const golden = fs.readFileSync(new URL("./fixtures/manifest-3.4.1.json", import.meta.url), "utf8");
  const got = (await rig().get("/manifest.json")).text;
  assert.equal(JSON.parse(got).version, "3.5.0");
  assert.equal(got.replace('"version":"3.5.0"', '"version":"3.4.1"'), golden, "nothing but the version differs");
  assert.equal(got.split('"version":"3.5.0"').length, 2, "and it stands once");
});

// ── proposal 5 (Marco, 28/10/2026): curated options, directors' cards, the Genre filter of Explore — the Worker 3.5.0 ────────────────────────────────────────────────
// The index of this section is made by hand following the contract between the build and the Worker (docs/2026-10-28-discover-plano-implementacao.md §5.2): `discover.explore = { genre: <catalog id> }`, an option
// `{ id, label, ids, curated: true }` (a collection: no recommendation rule) and `{ …, curated: true, director: "<X loves>" }` (a card: the "Loved by …" text of index.directors.options). The build's side is another change.

const T = (i) => `tt${9000000 + i}`;
const GENRES19 = ["Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary", "Drama", "Family", "Fantasy", "History", "Horror", "Music", "Mystery", "Noir", "Romance", "Sci-fi", "Thriller", "War", "Western"];
const DRAMA = Array.from({ length: 40 }, (_, k) => T(40 - k)); // films 40 … 1: against the order of the file, to prove that the build's order is kept. Holds the seen film (3), the one under the rule (4) and the one the music rule holds back (5)
const WESTERN = [T(52), T(50), T(301), T(51)];
const genreOption = (label) => ({ id: `g-${label.toLowerCase().replace(/[^a-z]/g, "")}`, label, ids: label === "Drama" ? DRAMA : label === "Western" ? WESTERN : label === "Comedy" ? [T(10), T(11)] : [] });
const UNION = [T(201), T(203), T(204), T(5), T(4), T(202)]; // listed 201, seen 203, under the rule 204, held back by the music rule 5, under the rule 4, listed 202
const DISCOVER5 = {
  order: ["moods", "places", "eras", "genres", "craft", "filmmaker-picks", "critics", "explore", "search"],
  retire: ["lists", "lists-unseen", "director-picks"],
  seen: DISCOVER.seen,
  explore: { genre: "genres" },
  catalogs: [
    DISCOVER.catalogs[0], DISCOVER.catalogs[1],
    { id: "genres", name: "Mood Engine · Genres", options: GENRES19.map(genreOption) },
    { id: "craft", name: "Mood Engine · Craft & form", options: [{ id: "u-two", label: "Two lists", ids: UNION, curated: true }, { id: "k-long", label: "Long films", ids: UNION }] },
    { id: "filmmaker-picks", name: "Mood Engine · Directors", options: [{ id: "d-seven", label: "Director 7 card", ids: [T(7), T(8), T(4), T(201), T(203)], curated: true, director: "Director 7 loves" }] },
    DISCOVER.catalogs[2],
  ],
};
const DIRECTORS5 = { options: [{ label: "Director 7 loves", ids: [T(7), T(8)], descs: ["Director 7 cast\nLoved by Director 7 · interview (2020)", "Director 8 cast\nLoved by Director 7 and Director 9 · poll"] }] };
const FILES5 = filesOf({ discover: DISCOVER5, directors: DIRECTORS5 });

test("proposal 5, a curated option (a union of lists): every film of its ids in the build's order WITHOUT the recommendation rule and without the music rule; the seen one only with Include seen; the same ids as a calculated option are cut by both rules", async () => {
  const r = rig({ files: FILES5 });
  const union = await r.get(`/catalog/movie/craft/genre=${enc("Two lists")}.json`);
  assert.deepEqual(names(union), ["Film 201", "Film 204", "Film 005", "Film 004", "Film 202"], "Film 204 and Film 004 fail the rule, Film 005 is held back by the music rule: a collection shows them; Film 203 is seen");
  assert.equal(total(union), 5);
  assert.deepEqual(names(await r.get(`/catalog/movie/craft/genre=${enc("Two lists")}&seen=${enc("Include seen")}.json`)), ["Film 201", "Film 203", "Film 204", "Film 005", "Film 004", "Film 202"], "with Include seen, in its place");
  assert.deepEqual(names(await r.get(`/catalog/movie/craft/genre=${enc("Long films")}.json`)), ["Film 201", "Film 202"], "the SAME ids as a calculated option: the rule and the music rule apply");
  assert.deepEqual(names(await r.get(`/catalog/movie/craft/genre=${enc("Two lists")}&decade=1960s.json`)), UNION.map((tt) => byTt.get(tt)).filter((e) => !e.seen && e.decade === "1960s").map((e) => e.name), "the four menus are on top of a curated option too");
  assert.ok(r.calls.every((c) => ["index-v2-menus.json", "index-v2.json"].includes(c) || /^index-v2-opt-craft-u-two\.json$|^index-v2-opt-craft-k-long\.json$/.test(c)), "the ids are in the whole v2 index: only the option's own piece is asked for first (29/10/2026), and this rig has none");
});

test("proposal 5, a director's card: the films of its ids with no recommendation rule, and the build's \"Loved by …\" text on the films of that director's \"loves\" option; the others keep the film's own text", async () => {
  const r = rig({ files: FILES5 });
  const card = await r.get(`/catalog/movie/filmmaker-picks/genre=${enc("Director 7 card")}.json`);
  assert.deepEqual(names(card), ["Film 007", "Film 008", "Film 004", "Film 201"], "Film 004 fails the rule and stays (a card is editorial); Film 203 is seen");
  const by = Object.fromEntries(card.json.metas.map((m) => [m.name, m]));
  assert.match(by["Film 007"].description, /Loved by Director 7 · interview \(2020\)/);
  assert.match(by["Film 008"].description, /Loved by Director 7 and Director 9 · poll/);
  assert.doesNotMatch(by["Film 201"].description, /Loved by/, "a film added from a list has no \"Loved by\" text");
  assert.doesNotMatch(by["Film 004"].description, /Loved by/);
  const explore = (await r.get("/catalog/movie/explore.json")).json.metas.find((m) => m.name === "Film 007");
  assert.doesNotMatch(explore.description, /Loved by/, "the text belongs to the card, not to the film everywhere");
  assert.equal(by["Film 201"].description, (await r.get(`/catalog/movie/craft/genre=${enc("Two lists")}.json`)).json.metas.find((m) => m.name === "Film 201").description, "the film's own text, as a collection that is no card gives it");
});

test("proposal 5, Explore with a genre: the ids of the same-named option of the Genres catalog, unseen and recommendable, in the build's order; skip pages; the four menus combine on top", async () => {
  const r = rig({ files: FILES5 });
  const all = expected(DRAMA);
  assert.equal(all.length, 37, "40 films, less the seen one, the one under the rule and the one the music rule holds back");
  const drama = await r.get(`/catalog/movie/explore/genre=Drama.json`);
  assert.equal(drama.status, 200);
  assert.deepEqual(names(drama), all.map((e) => e.name), "film 40 first: the order of the ids, not the file's");
  assert.equal(total(drama), 37);
  assert.deepEqual(names(await r.get("/catalog/movie/explore/genre=Drama&skip=30.json")), all.slice(30).map((e) => e.name));
  assert.deepEqual(names(await r.get("/catalog/movie/explore/genre=Western.json")), ["Film 052", "Film 050", "New Wave Film", "Film 051"]);
  assert.deepEqual(names(await r.get("/catalog/movie/explore/genre=drama.json")), names(drama), "the words alone find the genre");
  const cut = (f) => all.filter(f).map((e) => e.name);
  const q = (x) => r.get(`/catalog/movie/explore/genre=Drama&${x}.json`).then(names);
  assert.deepEqual(await q("decade=1960s"), cut((e) => e.decade === "1960s"));
  assert.deepEqual(await q("country=France"), cut((e) => e.countries.includes("France")));
  assert.deepEqual(await q(`runtime=90${DASH}120%20min`), cut((e) => e.runtime >= 90 && e.runtime <= 120));
  assert.deepEqual(await q("rating=4.2%2B"), cut((e) => e.lbRating >= 4.2));
  const mixed = cut((e) => e.decade === "1960s" && e.countries.includes("France") && e.runtime >= 90 && e.runtime <= 120);
  assert.ok(mixed.length > 0, "the fixture has films that pass the three");
  assert.deepEqual(await q(`decade=1960s&country=France&runtime=90${DASH}120%20min`), mixed);
  assert.deepEqual(names(await r.get("/catalog/movie/explore/genre=Western&country=France.json")), expected(WESTERN).filter((e) => e.countries.includes("France")).map((e) => e.name), "Western, cut to France");
  assert.ok(expected(WESTERN).filter((e) => e.countries.includes("France")).length > 0 && expected(WESTERN).filter((e) => e.countries.includes("France")).length < expected(WESTERN).length, "and the cut is a real one");
  for (const p of ["/catalog/movie/explore/genre=Drama.json", "/catalog/movie/explore/genre=Drama&skip=30.json"]) assert.ok(!names(await r.get(p)).some((n) => ["Film 003", "Film 004", "Film 005"].includes(n)), `${p}: never the seen film, the one under the rule or the one the music rule holds back`);
  assert.deepEqual(r.calls.filter((c) => !["index-v2-menus.json", "index-v2.json"].includes(c)), [], "Explore with a genre reads the whole v2 index, as Explore does: nothing else");
});

test("proposal 5, Explore: \"All\", or no genre at all (NuvioTV), is Explore as always; a value that is no genre, or an empty one, is an empty page with X-Total 0 — never the whole index", async () => {
  const r = rig({ files: FILES5 });
  const none = await r.get("/catalog/movie/explore.json");
  assert.ok(total(none) > 100, "Explore as always: every unseen recommendable film");
  for (const p of ["/catalog/movie/explore/genre=All.json", "/catalog/movie/explore/genre=all.json"]) assert.deepEqual((await r.get(p)).json, none.json, p);
  assert.deepEqual((await r.get("/catalog/movie/explore/decade=1960s.json")).json.metas, (await r.get("/catalog/movie/explore/genre=All&decade=1960s.json")).json.metas, "no genre and \"All\" give the same cut");
  const old = rig();
  assert.deepEqual(none.json, (await old.get("/catalog/movie/explore.json")).json, "the same films as the index of 3.4.1 gives");
  for (const p of ["/catalog/movie/explore/genre=Atlantis.json", "/catalog/movie/explore/genre=.json", "/catalog/movie/explore/genre=Drama%20and%20more.json", "/catalog/movie/explore/genre=Drama%20loves.json", "/catalog/movie/explore/genre=Comedy&decade=2020s.json"]) {
    const got = await r.get(p);
    assert.equal(got.status, 200, p);
    assert.deepEqual(got.json.metas, [], p);
    assert.equal(got.headers.get("x-total"), "0", p);
  }
  assert.deepEqual(names(await r.get("/catalog/movie/explore/genre=Action.json")), [], "a genre whose option has no film is an empty page too");
});

test("proposal 5, compatibility: an index with `discover` but no `explore` key keeps Explore as it was — a genre is ignored, as 3.4.1 did, and the single entry \"All\" is the menu", async () => {
  const r = rig();
  const plain = await r.get("/catalog/movie/explore.json");
  assert.deepEqual((await r.get("/catalog/movie/explore/genre=Drama.json")).json, plain.json);
  assert.deepEqual((await r.get("/manifest.json")).json.catalogs.find((c) => c.id === "explore").extra[0], { name: "genre", isRequired: true, options: ["All"] });
});

test("proposal 5, the manifest 3.5.0: Explore has the REQUIRED Genre menu with \"All\" first and the 19 genres (it stays off the Board); Craft & form comes in and Loved by directors is out; the Board's rows are the same", async () => {
  const r = rig({ files: FILES5 });
  const m = (await r.get("/manifest.json")).json;
  assert.equal(m.version, "3.5.0");
  const ex = m.catalogs.find((c) => c.id === "explore");
  assert.deepEqual(ex.extra[0], { name: "genre", isRequired: true, options: ["All", ...GENRES19] });
  assert.equal(ex.extra[0].options.length, 20);
  assert.equal(ex.extra[0].options[0], "All", "\"All\" first: it is what the Nuvio and the Board's request without a menu stand for");
  assert.deepEqual(ex.extra.slice(1).map((e) => e.name), ["decade", "runtime", "country", "rating", "skip"], "the four menus stay optional");
  assert.ok(ex.extra.slice(1).every((e) => e.isRequired !== true));
  assert.deepEqual(m.catalogs.filter((c) => !(c.extra || []).some((e) => e.isRequired)).map((c) => c.id), ["tonight", "my-series"], "only the Board's rows have no required menu: Explore is not one of them");
  assert.deepEqual(m.catalogs.map((c) => c.id), [...DISCOVER5.order, "tonight", "my-series"]);
  assert.ok(m.catalogs.some((c) => c.id === "craft") && !m.catalogs.some((c) => c.id === "director-picks"));
  assert.deepEqual(m.catalogs.find((c) => c.id === "craft").extra[0].options, ["Two lists", "Long films"]);
  assert.deepEqual(m.catalogs.find((c) => c.id === "filmmaker-picks").extra[0].options, ["Director 7 card"], "the card's label is the build's, apart from the \"loves\" option it reads (director: \"Director 7 loves\")");
  const before = (await rig().get("/manifest.json")).json.catalogs.filter((c) => !DISCOVER.order.includes(c.id));
  assert.deepEqual(m.catalogs.filter((c) => !DISCOVER5.order.includes(c.id)), before, "the Board's rows are the same, byte for byte");
  const ix = hydrate(JSON.parse(textOf(indexObject({ discover: DISCOVER5, directors: DIRECTORS5 }).v2)));
  assert.ok(!buildManifest(ix, { exploreOnBoard: true }).catalogs.find((c) => c.id === "explore").extra.some((e) => e.name === "genre"), "EXPLORE_ON_BOARD still takes the menu away");
  const marco = buildProfileManifest(ix, { key: "marco", ...PROFILES.get("marco") });
  assert.equal(marco.catalogs.find((c) => c.id === "explore").extra[0].options.length, 20, "the Marco profile mirrors the main address");
  assert.ok(["craft", "filmmaker-picks", "genres"].every((id) => marco.catalogs.find((c) => c.id === id).showInHome === false));
});

test("the 3.5.0 manifest of the small index of this section is, byte for byte, fixtures/manifest-3.5.0.json (UPDATE_GOLDEN=1 rewrites the file; read the diff before committing it)", async () => {
  const file = new URL("./fixtures/manifest-3.5.0.json", import.meta.url);
  const got = (await rig({ files: FILES5 }).get("/manifest.json")).text;
  if (process.env.UPDATE_GOLDEN) fs.writeFileSync(file, got);
  assert.equal(got, fs.readFileSync(file, "utf8"));
  assert.equal(JSON.parse(got).version, "3.5.0");
});

test("proposal 5, Loved by directors is out of the manifests (the index retires it) and still answers — on the main address and on the Marco profile, with the same films; a mood profile does not have it (review of 29/10/2026: the profile answered 404)", async () => {
  const r = rig({ files: FILES5 });
  const path = `/catalog/movie/director-picks/genre=${enc("Director 7 loves")}.json`;
  const main = await r.get(path);
  assert.equal(main.status, 200);
  assert.deepEqual(names(main), ["Film 007", "Film 008"]);
  const marco = await r.get(`/p/marco${path}`);
  assert.equal(marco.status, 200, "the Marco profile keeps answering what its manifest no longer declares, as Lists");
  assert.deepEqual(marco.json.metas, main.json.metas);
  assert.equal((await r.get(`/p/night${path}`)).status, 404, "a mood profile never had it");
  for (const m of [(await r.get("/manifest.json")).json, (await r.get("/p/marco/manifest.json")).json]) assert.ok(!m.catalogs.some((c) => c.id === "director-picks"), "not declared");
});

test("proposal 5, the Genre filter of Explore reads the catalog that `discover.explore.genre` NAMES, whatever its id (review of 29/10/2026): the options, the ids and the manifest's menu come from it, not from a catalog called \"genres\"", async () => {
  const renamed = { ...DISCOVER5, order: DISCOVER5.order.map((id) => (id === "genres" ? "kinds" : id)), explore: { genre: "kinds" }, catalogs: DISCOVER5.catalogs.map((c) => (c.id === "genres" ? { ...c, id: "kinds" } : c)) };
  const r = rig({ files: filesOf({ discover: renamed, directors: DIRECTORS5 }) });
  assert.deepEqual(names(await r.get("/catalog/movie/explore/genre=Drama.json")), expected(DRAMA).map((e) => e.name), "Drama, from the catalog called kinds");
  assert.deepEqual((await r.get("/manifest.json")).json.catalogs.find((c) => c.id === "explore").extra[0].options, ["All", ...GENRES19]);
  const other = { ...DISCOVER5, explore: { genre: "craft" } };
  const o = rig({ files: filesOf({ discover: other, directors: DIRECTORS5 }) });
  assert.deepEqual((await o.get("/manifest.json")).json.catalogs.find((c) => c.id === "explore").extra[0].options, ["All", "Two lists", "Long films"], "pointed at another catalog, the menu is that catalog's");
  assert.deepEqual(names(await o.get(`/catalog/movie/explore/genre=${enc("Long films")}.json`)), ["Film 201", "Film 202"], "and so are the ids (with the rule of Explore: the option is not curated)");
  assert.deepEqual(names(await o.get("/catalog/movie/explore/genre=Drama.json")), [], "Drama is no option of that catalog: an empty page");
  const gone = rig({ files: filesOf({ discover: { ...DISCOVER5, explore: { genre: "nowhere" } }, directors: DIRECTORS5 }) });
  assert.deepEqual((await gone.get("/manifest.json")).json.catalogs.find((c) => c.id === "explore").extra[0].options, ["All"], "a catalog that does not exist: the single \"All\"");
});

// ── the pure functions ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("discoverCatalog, discoverOption, includeSeen", () => {
  const ix = hydrate(JSON.parse(textOf(indexObject().v2)));
  assert.equal(discoverCatalog(ix, "places").id, "places");
  assert.equal(discoverCatalog(ix, "lists"), undefined);
  assert.equal(discoverCatalog({ ...ix, discover: undefined }, "places"), undefined);
  const places = discoverCatalog(ix, "places");
  assert.equal(discoverOption(places, undefined, ix.lists).label, "Brazil");
  assert.equal(discoverOption(places, "brazil", ix.lists).id, "c-brazil");
  assert.equal(discoverOption(places, LISTS[0].label, ix.lists).id, "l-tspdt");
  assert.equal(discoverOption(places, "Atlantis", ix.lists), null);
  assert.equal(includeSeen({ seen: "Include seen" }, ix), true);
  assert.equal(includeSeen({ seen: "include+seen".replace("+", " ") }, ix), true);
  assert.equal(includeSeen({}, ix), false);
  assert.equal(includeSeen({ seen: "Include seen" }, { ...ix, discover: undefined }), false);
});

// ── the real data file, sent the way a phone sends it ──────────────────────────────────────────────────────────────────────────────────────

test("every option of data/discover-catalogs.json, sent as Stremio sends it (encodeURIComponent, or a plus for a space) and typed with a hyphen for the dash, opens its own option; a label with an ampersand does too", () => {
  const data = JSON.parse(fs.readFileSync(new URL("../../data/discover-catalogs.json", import.meta.url), "utf8"));
  const config = JSON.parse(fs.readFileSync(new URL("../../config.json", import.meta.url), "utf8"));
  const DC = require("../../lib/discover-catalogs.js");
  // front D (29/10/2026): the file names keywords of the Board's moods too (parse() refuses a term the index column cannot hold), so the terms come from the moods of config.json plus the Board's, as build.js gives them
  const { keywordTerms } = require("../../lib/index-export.js");
  const board = require("../../lib/board.js").parse(config, "config.json board");
  const spec = DC.parse(data, { lists: config.lists, today: "2026-10-22", existingIds: [], keywordTerms: keywordTerms([...(config.moods || []), ...board.moods]) });
  let ampersands = 0, dashes = 0, checked = 0;
  for (const c of spec.catalogs) {
    const cat = { id: c.id, options: c.options.filter((o) => o.kind !== "directors").map((o) => ({ id: o.id, label: o.label, ...(o.kind === "list" ? { list: o.list } : { ids: [] }) })) }; // the directors' item holds the cards, whose labels the build makes (front D)
    const lists = config.lists.map((l) => ({ id: l.id, label: l.name, short: l.short }));
    for (const o of cat.options) {
      const variants = [enc(o.label), enc(o.label).replace(/%20/g, "+"), o.label.replace(/–/g, "-")];
      for (const sent of variants) {
        const got = parseExtras(`decade=1990s&genre=${sent.includes("%") || sent.includes("+") ? sent : enc(sent)}`).genre;
        assert.equal(discoverOption(cat, got, lists)?.id, o.id, `${c.id}: ${o.label} sent as ${sent}`);
        checked++;
      }
      if (o.label.includes("&")) ampersands++;
      if (o.label.includes("–")) dashes++;
    }
  }
  assert.ok(ampersands >= 3, `${ampersands} labels with an ampersand (S&S x2 and the TSPDT Beyond S&S list)`);
  assert.ok(dashes >= 10, `${dashes} labels with the en dash (the eras)`);
  assert.ok(checked > 300);
});
