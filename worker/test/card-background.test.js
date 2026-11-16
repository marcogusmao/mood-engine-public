// The image behind a film's title on the catalog cards (Marco, 14/11/2026: on the Samsung TV, behind the title of a card, the POSTER appeared enlarged; "it shouldnt do that").
// Until then a card (src/meta.js toMeta) had no `background`, while the film page (src/page.js toPage) had one. Now every FILM card of every catalog carries the page's own address for the same id
// (src/mood-group.js backgroundOf: the image service by IMDb id, nothing read from the index). What these tests hold:
//   · the card's address is the page's, for the same film, and it is the address written down in sweep.js (cardBackground), not the poster's;
//   · the poster of the card is what it was (with a cover of its own, and without);
//   · every film card of every catalog has it: the old address (Board rows, Moods, Explore, Search, the Discover's catalogs, Lists, Friends), the six profiles, the friends' view, the private address;
//   · a series card (My series) has none: it was not asked for, and nothing is invented for it.
// The comparisons with the reference Worker (profile-parity.test.js, friend-view.test.js (f)) take the key out only when it is exactly this address: see sweep.js withoutCardBackground.

import test from "node:test";
import assert from "node:assert/strict";
import * as handlerMod from "../src/handler.js";
import * as storeMod from "../src/store.js";
import { toMeta } from "../src/meta.js";
import { toPage } from "../src/page.js";
import { backgroundOf } from "../src/mood-group.js";
import { files as legacyFiles, makeObject } from "./profile-fixture.js";
import { v2FilesOf, v2ObjectFrom } from "./fixture.js";
import { filesOf, rigOf, PUBLIC_ROUTES } from "./friend-view-fixture.js";
import { handlerOver, pathsOf, cardBackground, withoutCardBackground } from "./sweep.js";

const DIR = "https://pages.test/mood-engine/data/";
const OCT = () => Date.parse("2026-10-11T23:00:00Z");

/** Every film card and every series card of the answers to `paths`: { path, catalog, meta }. Only 200 answers that are a catalog page count. */
async function cardsOf(get, paths) {
  const out = [];
  for (const path of paths) {
    const r = await get(path);
    if (r.status !== 200 || !/\/catalog\//.test(path)) continue;
    const j = JSON.parse(r.text);
    for (const meta of j.metas) out.push({ path, catalog: /\/catalog\/[^/]+\/([^/.]+)/.exec(path)[1], meta });
  }
  return out;
}
/** Fails with the first cards that are not as they should be: a film card with exactly the page's address, a series card with none. */
function checkCards(cards, where) {
  const films = cards.filter((c) => c.meta.type === "movie"), series = cards.filter((c) => c.meta.type === "series");
  assert.deepEqual(films.filter((c) => c.meta.background !== cardBackground(c.meta.id)).slice(0, 5).map((c) => `${c.path} ${c.meta.id} ${c.meta.background}`), [], `${where}: film cards without the page's background`);
  assert.deepEqual(films.filter((c) => c.meta.poster === c.meta.background || /\/background\//.test(c.meta.poster)).slice(0, 5).map((c) => `${c.path} ${c.meta.id}`), [], `${where}: the poster is not the background`);
  assert.deepEqual(series.filter((c) => "background" in c.meta).slice(0, 5).map((c) => `${c.path} ${c.meta.id}`), [], `${where}: a series card has no background`);
  return { films: films.length, series: series.length, catalogs: new Set(films.map((c) => c.catalog)) };
}

test("toMeta: the card's `background` is the film page's for the same film (one rule, src/mood-group.js backgroundOf), it comes right after the poster's shape, and the poster is what it was", () => {
  const e = { tt: "tt0043014", name: "Sunset Boulevard", year: 1950, runtime: 110, desc: "" };
  const card = toMeta(e, { separator: "\n\n" });
  const page = toPage({ t: "tt0043014", n: "Sunset Boulevard", y: 1950 });
  assert.equal(card.background, "https://images.metahub.space/background/medium/tt0043014/img");
  assert.equal(card.background, page.background, "the film page's address for the same id");
  assert.equal(card.background, backgroundOf("tt0043014"));
  assert.equal(card.background, cardBackground("tt0043014"), "and the one the reference comparisons expect (sweep.js)");
  assert.deepEqual(Object.keys(card).slice(0, 6), ["id", "type", "name", "poster", "posterShape", "background"]);
  assert.equal(card.poster, "https://images.metahub.space/poster/medium/tt0043014/img", "no cover of its own: the poster service, as before");
  const covered = toMeta({ ...e, poster: "https://marcogusmao.github.io/mood-engine/covers/tt0043014.jpg" }, { separator: "\n\n" });
  assert.equal(covered.poster, "https://marcogusmao.github.io/mood-engine/covers/tt0043014.jpg", "a cover of its own stays the poster");
  assert.equal(covered.background, card.background, "and the background does not follow the cover");
  // each film its own image
  assert.equal(toMeta({ ...e, tt: "tt0000010" }, {}).background, "https://images.metahub.space/background/medium/tt0000010/img");
  // every context a catalog hands: chips, the private address, a profile's row
  for (const context of [{}, { menus: { moods: [], lists: [] } }, { defaultVideo: true }, { kind: "moods", name: "Noir" }]) assert.equal(toMeta(e, context).background, card.background, JSON.stringify(Object.keys(context)));
});

test("an id that is not \"tt\" and up to 10 digits (the shape the film page requires) gets NO background: the card goes out without the field, and nothing of the id is written into an address", () => {
  const bad = ["tt1/../x?y", "tt1/../../poster/medium/tt2", "tt1?x=1", "tt1#f", "tt12345678901", "tt", "tt12a", "TT123", " tt123", "tt123 ", "tt123\n", "123", "", "https://example.com/x", "tt1%2F..%2Fx", "tt１２３"];
  for (const tt of bad) {
    assert.equal(backgroundOf(tt), undefined, JSON.stringify(tt));
    const card = toMeta({ tt, name: "Damaged", year: 1990, desc: "" }, { separator: "\n\n" });
    assert.equal(card.background, undefined, JSON.stringify(tt));
    const wire = JSON.stringify(card);
    assert.ok(!wire.includes('"background"') && !wire.includes("/background/"), `${JSON.stringify(tt)}: no background on the wire: ${wire}`);
    assert.deepEqual(Object.keys(JSON.parse(wire)).slice(0, 5), ["id", "type", "name", "poster", "posterShape"], "the rest of the card is as it was");
  }
  for (const odd of [undefined, null, 123, 0, {}, ["tt123"], { toString: () => "tt123" }]) assert.equal(backgroundOf(odd), undefined, String(odd));
  // the ids the index does carry: every length the page accepts
  for (const tt of ["tt1", "tt0043014", "tt15296186", "tt1234567890"]) {
    assert.equal(backgroundOf(tt), `https://images.metahub.space/background/medium/${tt}/img`, tt);
    assert.equal(JSON.parse(JSON.stringify(toMeta({ tt, name: "Fine", desc: "" }, {}))).background, cardBackground(tt), tt);
    assert.equal(toPage({ t: tt, n: "Fine" }).background, cardBackground(tt), `${tt}: the page's is the same`);
  }
  assert.throws(() => toPage({ t: "tt1/../x?y", n: "Damaged" }), /invalid page id/, "(the film page refuses such an id outright, as before)");
});

test("every film card of every catalog of the old address and of the six profiles carries the page's background (legacy files alone, and with the v2 family beside them); the series cards carry none", async () => {
  const legacy = legacyFiles(), withV2 = { ...legacy, ...v2FilesOf(v2ObjectFrom(makeObject())) };
  const seen = new Set();
  for (const [site, files] of [["legacy files", legacy], ["with the v2 family", withV2]]) {
    const get = handlerOver(handlerMod, storeMod, files, { now: OCT, dir: DIR });
    const paths = [];
    for (const prefix of ["", "/p/marco", "/p/light", "/p/heavy", "/p/night", "/p/world", "/p/critics"]) paths.push(...pathsOf(prefix, JSON.parse((await get(`${prefix}/manifest.json`)).text)));
    paths.push("/catalog/movie/lists.json", "/catalog/movie/lists-unseen.json", "/catalog/movie/director-picks.json", "/catalog/movie/explore.json", "/catalog/movie/search/search=night.json"); // the retired catalogs still answer, and Explore and Search whatever the manifest says
    const got = checkCards(await cardsOf(get, paths), site);
    assert.ok(got.films > 300, `${site}: ${got.films} film cards looked at`);
    assert.ok(got.series > 0, `${site}: (control: the My series row was looked at)`);
    for (const c of got.catalogs) seen.add(c);
  }
  for (const family of ["tonight", "watchlist", "night", "moods", "explore", "search", "lists", "theme-horror", "vouch-critics", "what-it-is", "closet-most-picked"]) assert.ok(seen.has(family), `(control: a film card of "${family}" was looked at; seen: ${[...seen].join(" ")})`);
});

test("the friends' view, the Discover's own catalogs and the private address: every film card carries the page's background there too", async () => {
  const TOKEN = "0123456789abcdef0123456789abcdef";
  const r = rigOf(filesOf(), handlerMod.createHandler, storeMod.createStore, { env: { INDEX_URL: `${DIR}index.json`, SUBTITLES_PRIVATE_TOKEN: TOKEN } });
  const get = (path) => r.get(path);
  const paths = PUBLIC_ROUTES.map(([, p]) => p);
  for (const prefix of ["/u/william", "/u/gustavo", `/k/${TOKEN}`]) {
    const manifest = await get(`${prefix}/manifest.json`);
    assert.equal(manifest.status, 200, prefix);
    paths.push(...pathsOf(prefix, manifest.json), ...PUBLIC_ROUTES.map(([, p]) => prefix + p));
  }
  const cards = await cardsOf(get, paths);
  const got = checkCards(cards, "friends' fixture");
  assert.ok(got.films > 200, `${got.films} film cards looked at`);
  for (const prefix of ["/u/william/", "/u/gustavo/", `/k/${TOKEN}/`]) assert.ok(cards.some((c) => c.path.startsWith(prefix) && c.meta.type === "movie"), `(control: film cards under ${prefix.slice(0, 6)}… were looked at)`);
  for (const family of ["watchlist", "explore", "moods", "search", "places", "friends"]) assert.ok(got.catalogs.has(family), `(control: a film card of "${family}" was looked at; seen: ${[...got.catalogs].join(" ")})`);
  const priv = cards.find((c) => c.path.startsWith(`/k/${TOKEN}/`) && c.meta.type === "movie");
  assert.deepEqual(priv.meta.behaviorHints, { defaultVideoId: priv.meta.id }, "(the private address's own hint is still there)");
});

test("withoutCardBackground (what the comparisons with the reference Worker use): the key leaves a film card only when it is exactly the page's address for that card's id, and nothing else moves", () => {
  const card = (id, extra = {}) => ({ id, type: "movie", name: `Film ${id}`, poster: `https://images.metahub.space/poster/medium/${id}/img`, posterShape: "poster", ...extra, releaseInfo: "1990", description: "" });
  const reference = JSON.stringify({ metas: [card("tt0000001"), card("tt0000002")], cacheMaxAge: 300 });
  const ours = JSON.stringify({ metas: [card("tt0000001", { background: cardBackground("tt0000001") }), card("tt0000002", { background: cardBackground("tt0000002") })], cacheMaxAge: 300 });
  assert.notEqual(ours, reference);
  assert.equal(withoutCardBackground(ours), reference, "byte for byte the reference's answer");
  assert.equal(withoutCardBackground(reference), reference, "an answer with no background is left as it is");
  for (const [what, wrong] of [["the image of another film", cardBackground("tt0000002")], ["the poster", "https://images.metahub.space/poster/medium/tt0000001/img"], ["another size", "https://images.metahub.space/background/small/tt0000001/img"], ["empty", ""], ["another host", "https://example.com/background/medium/tt0000001/img"]]) {
    const text = JSON.stringify({ metas: [card("tt0000001", { background: wrong })], cacheMaxAge: 300 });
    assert.equal(withoutCardBackground(text), text, `${what}: the key stays, so the answer differs from the reference`);
  }
  const series = JSON.stringify({ metas: [{ id: "tt0387764", type: "series", name: "Peep Show", background: cardBackground("tt0387764") }] });
  assert.equal(withoutCardBackground(series), series, "a series card is not touched");
  for (const text of ["not json", "{\"err\":\"not found\"}", "<!doctype html>", ""]) assert.equal(withoutCardBackground(text), text);
});
