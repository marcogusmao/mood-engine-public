// "Loved by directors" (Marco, 11/10/2026): the Discover menu with one option per favourite director, as the build ordered it.
// The fixture's films get a directors' menu here; the build's own pieces() cuts the files, so index-directors.json is the real shape.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { select, page } from "../src/catalogs.js";
import { parseExtras } from "../src/extras.js";
import { buildManifest } from "../src/manifest.js";
import { toMeta } from "../src/meta.js";
import { createHandler } from "../src/handler.js";
import { createStore } from "../src/store.js";
import { makeObject, readyOf, textOf, names } from "./fixture.js";

const require = createRequire(import.meta.url);
const exporter = require("../../lib/index-export.js");

const DIRECTORS = {
  options: [
    // Ikiru, a seen film, Stalker, a film that fails the rule (not eligible: the build marks the loved films it lets in), Wild Strawberries
    { label: "Lynch loves", ids: ["tt0000007", "tt0000019", "tt0000023", "tt0000015", "tt0000022"], descs: ["Loved by Lynch · interview (2020)", "seen", "Loved by Lynch and Scorsese · Sight & Sound 2022 ballot", "x", "Loved by Lynch · interview (2020)"] },
    { label: "Francis Ford Coppola loves", ids: ["tt0000012"], descs: ["Loved by Francis Ford Coppola · own Letterboxd list"] },
  ],
};
const obj = () => makeObject({ directors: DIRECTORS });
const ix = readyOf(obj());
const run = (q) => names(select(ix, "director-picks", parseExtras(q)).entries);

test("director-picks: the option in the build's order, never a seen film, never a film the build did not mark eligible", () => {
  assert.deepEqual(run("genre=Lynch%20loves"), ["Ikiru", "Stalker", "Wild Strawberries"]);
  assert.deepEqual(run("genre=Francis%20Ford%20Coppola%20loves"), ["Nights of Cabiria"]);
});

test("director-picks: an option that is not on the menu is an empty page; the four optional menus filter it", () => {
  assert.deepEqual(run("genre=Malick%20loves"), []);
  assert.deepEqual(run("genre=Lynch%20loves&decade=1950s"), ["Ikiru", "Wild Strawberries"]);
  assert.deepEqual(run("genre=Lynch%20loves&country=Sweden"), ["Wild Strawberries"]);
});

test("director-picks: each film says who loves it, with the build's own text for that option", () => {
  const p = page(ix, "director-picks", parseExtras("genre=Lynch%20loves"));
  const stalker = p.entries.find((e) => e.name === "Stalker");
  assert.match(toMeta(stalker, p.context).description, /Loved by Lynch and Scorsese · Sight & Sound 2022 ballot/);
  const elsewhere = page(ix, "explore", {}).entries.find((e) => e.name === "Stalker");
  assert.doesNotMatch(toMeta(elsewhere, page(ix, "explore", {}).context).description, /Loved by/, "the text belongs to the option, not to the film everywhere");
});

test("director-picks: the manifest offers the menu with the build's labels; an index from before the menu has no such catalog", () => {
  const m = buildManifest(ix);
  const c = m.catalogs.find((x) => x.id === "director-picks");
  assert.equal(c.name, "Mood Engine · Loved by directors");
  assert.deepEqual(c.extra[0], { name: "genre", isRequired: true, options: ["Lynch loves", "Francis Ford Coppola loves"] });
  assert.deepEqual(c.extra.slice(1).map((e) => e.name), ["decade", "runtime", "country", "rating", "skip"]);
  assert.equal(buildManifest(readyOf(makeObject())).catalogs.some((x) => x.id === "director-picks"), false);
});

test("director-picks: the Worker reads index-directors.json, which carries the films and texts; the other pieces carry the labels only", async () => {
  const o = obj();
  const files = { "index.json": textOf(o) };
  for (const p of exporter.pieces(o)) files[p.rel.split("/").pop()] = textOf(p.obj);
  assert.ok(files["index-directors.json"], "the build writes the piece");
  const board = JSON.parse(files["index-board.json"]);
  assert.deepEqual(board.directors.options, DIRECTORS.options.map((x) => ({ label: x.label, ids: [], descs: [] })));
  const asked = [];
  const fetchImpl = async (url) => { const name = url.split("/").pop(); asked.push(name); return files[name] ? new Response(files[name]) : new Response("", { status: 404 }); };
  const h = createHandler({ store: createStore({ fetchImpl, caches: undefined, log: () => {} }) });
  const res = await h(new Request("https://w.test/catalog/movie/director-picks/genre=Lynch%20loves.json"), { INDEX_URL: "https://pages.test/data/index.json" }, undefined);
  const json = await res.json();
  assert.deepEqual(json.metas.map((m) => m.name), ["Ikiru", "Stalker", "Wild Strawberries"]);
  assert.deepEqual(asked, ["index-directors.json"]);
});
