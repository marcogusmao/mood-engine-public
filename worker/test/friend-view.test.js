// The friends' view (Marco, 29/10/2026, questionnaire): /u/<friend>/ serves Marco's index with the FRIEND's "seen" and the FRIEND's Watchlist row (worker/src/friends.js).
// Two synthetic friends, Gustavo and William, on the small index of fixture.js (friend-view-fixture.js says who saw and wants what). What is asserted, in the order of the file:
//   (a) a film the friend has seen leaves the rows and comes back with "Include seen"           (b) a film Marco has seen and the friend has not APPEARS
//   (c) the Watchlist row is the friend's, in the index's order, and nothing falls back to Marco's    (d) the manifest: id, name, description, the public catalogs
//   (e) an address the index does not list is a 404, and so is everything under /u/<friend>/ that is not the manifest, the catalogs, the subtitles and the install page
//   (f) the public addresses answer byte for byte as they did before (24 routes, a golden made by the code of origin/main 415bd4e)   (g) an index with no masks is refused, never read as "nothing seen"
// Completion checks and reproduced regressions are recorded in research/2026-10-29-friends-completion.md.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createHandler } from "../src/handler.js";
import { createStore } from "../src/store.js";
import { friendOf, isFriendSlug, slugOf, pieceId, SLUG, FRIEND_SLUGS } from "../src/friends.js";
import { resolvePerson } from "../src/people.js";
import { hydrate } from "../src/film.js";
import { search } from "../src/search.js";
import { select } from "../src/catalogs.js";
import { filesOf, withoutMasks, rigOf, objects, PUBLIC_ROUTES, PICKS, MARCO_WATCHLIST } from "./friend-view-fixture.js";
import { withoutCardBackground } from "./sweep.js";

const require = createRequire(import.meta.url);
const FV = require("../../lib/friend-view.js");
const FILES = filesOf();
const rig = (files = FILES) => rigOf(files, createHandler, createStore);
const names = (r) => r.json.metas.map((m) => m.name);
const total = (r) => Number(r.headers.get("x-total"));
const enc = encodeURIComponent;
const without = (a, b) => a.filter((n) => !b.includes(n));

const EXPLORE_50S = "/catalog/movie/explore/decade=1950s.json";
const EXPLORE_80S = "/catalog/movie/explore/decade=1980s.json";
const PICKS_PATH = "/catalog/movie/places/genre=Picks.json";
const PICKS_SEEN = `/catalog/movie/places/genre=Picks&seen=${enc("Include seen")}.json`;
const WATCHLIST = "/catalog/movie/watchlist.json";

// ── (a) the friend's "seen" ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(a) a film the friend has seen is out of the rows, and Include seen brings it back; the other friend and the public address are unaffected", async () => {
  const r = rig();
  const pub = names(await r.get(PICKS_PATH));
  assert.deepEqual(pub, ["Pierrot le Fou", "Amélie", "Breathless", "A Very Short Film"], "Marco has seen two of the six");
  const gustavo = await r.get(`/u/gustavo${PICKS_PATH}`);
  const william = await r.get(`/u/william${PICKS_PATH}`);
  assert.equal(gustavo.status, 200);
  assert.deepEqual(names(gustavo), ["Pierrot le Fou", "Breathless", "A Very Short Film"], "Gustavo saw Palme Winner, Amélie and Old Friend");
  assert.deepEqual(names(william), ["Amélie", "Breathless", "Old Friend You Saw", "A Very Short Film"], "William saw Palme Winner and Pierrot le Fou");
  assert.equal(total(william), 4);
  const all = (await r.get(`/u/william${PICKS_SEEN}`)).json.metas.map((m) => m.name);
  assert.deepEqual(all, PICKS.map((tt) => objects().v2.films.find((f) => f.tt === tt).name), "Include seen: every id of the option, in its order");
  assert.deepEqual(names(await r.get(`/u/gustavo${PICKS_SEEN}`)), all);
  assert.deepEqual(names(await r.get(PICKS_PATH)), pub, "the public address after the friends' requests: the same");
});

test("(a) Explore and Search read the friend's seen too: the film William saw is not found by him, Gustavo finds it", async () => {
  const r = rig();
  const pub50 = names(await r.get(EXPLORE_50S));
  assert.ok(pub50.includes("Paths of Glory") && pub50.includes("The Killing"));
  assert.deepEqual(without(pub50, names(await r.get(`/u/william${EXPLORE_50S}`))), ["Paths of Glory"], "William saw Paths of Glory, and only that one of the 1950s");
  assert.deepEqual(without(pub50, names(await r.get(`/u/gustavo${EXPLORE_50S}`))), ["The Killing"], "Gustavo saw The Killing");
  const q = (who, text) => r.get(`${who}/catalog/movie/search/search=${enc(text)}.json`).then(names);
  assert.deepEqual(await q("", "paths"), ["Paths of Glory"]);
  assert.deepEqual(await q("/u/william", "paths"), []);
  assert.deepEqual(await q("/u/gustavo", "paths"), ["Paths of Glory"]);
  // a Search that names a list by its label takes the other road in search(): the same rule
  assert.ok((await q("/u/gustavo", "Cannes Winners")).length > 0);
  const wilsList = await q("/u/william", "Closet Picks");
  assert.ok(!wilsList.includes("Pierrot le Fou") && (await q("", "Closet Picks")).includes("Pierrot le Fou"), "…and in the exact-list road William's Pierrot le Fou is out");
});

test("(a) search() and select() on their own: without a viewer's `seen` they use the film's flag, which is Marco's; with one, only that", () => {
  const index = hydrate(JSON.parse(FILES["index.json"]));
  const gustavoSaw = (e) => e.tt === "tt0000002";
  assert.deepEqual(search(index, "old friend").map((e) => e.name), [], "no opts: Marco's flag");
  assert.deepEqual(search(index, "old friend", { seen: () => false }).map((e) => e.name), ["Old Friend You Saw"]);
  assert.ok(search(index, "paths").length === 1 && search(index, "paths", { seen: gustavoSaw }).length === 0);
  const explore = (opts) => select(index, "explore", { decade: "1950s" }, opts).entries.map((e) => e.name);
  assert.ok(explore({}).includes("Paths of Glory") && !explore({ seen: gustavoSaw }).includes("Paths of Glory"));
  assert.deepEqual(select(index, "explore", { decade: "1980s" }, {}).entries, [], "Old Friend You Saw is Marco's");
  assert.deepEqual(select(index, "explore", { decade: "1980s" }, { seen: () => false }).entries.map((e) => e.name), ["Old Friend You Saw"]);
});

// ── (b) a film Marco has seen and the friend has not ─────────────────────────────────────────────────────────────────────────────────────

test("(b) a film Marco has seen and the friend has not APPEARS in the friend's view — in a Discover option, in Explore, in Search — and not in Marco's", async () => {
  const r = rig();
  assert.ok(!names(await r.get(PICKS_PATH)).includes("Old Friend You Saw"), "Marco has seen it");
  assert.ok(names(await r.get(`/u/william${PICKS_PATH}`)).includes("Old Friend You Saw"));
  assert.ok(!names(await r.get(`/u/gustavo${PICKS_PATH}`)).includes("Old Friend You Saw"), "Gustavo has seen it too");
  assert.deepEqual(names(await r.get(EXPLORE_80S)), []);
  assert.deepEqual(names(await r.get(`/u/william${EXPLORE_80S}`)), ["Old Friend You Saw"]);
  assert.deepEqual(names(await r.get(`/u/gustavo${EXPLORE_80S}`)), []);
  const search = (who) => r.get(`${who}/catalog/movie/search/search=${enc("old friend")}.json`).then(names);
  assert.deepEqual(await search(""), []);
  assert.deepEqual(await search("/u/william"), ["Old Friend You Saw"]);
});

test("(a)(b) the legacy pieces carry the masks too: the Friends catalog (index-friends.json) hides what the friend saw, not what Marco saw", async () => {
  const r = rig();
  const top = `/catalog/movie/friends/genre=${enc("Top · Gustavo")}.json`;
  assert.deepEqual(names(await r.get(top)), ["Pulp Fiction", "The Killing", "Rashomon", "Just Below The Floor"]);
  assert.deepEqual(names(await r.get(`/u/gustavo${top}`)), ["Pulp Fiction", "Rashomon", "Just Below The Floor"], "Gustavo saw The Killing");
  assert.deepEqual(names(await r.get(`/u/william${top}`)), ["Pulp Fiction", "The Killing", "Rashomon", "Just Below The Floor"], "William saw none of the four");
});

// ── (c) the Watchlist row ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(c) the Watchlist row is the friend's: what they want and have not seen, best rank first — Marco's own list is not in it, and a film Marco has seen is", async () => {
  const r = rig();
  assert.deepEqual(names(await r.get(WATCHLIST)), ["Amélie", "Pulp Fiction"], "the public row is Marco's");
  const william = await r.get(`/u/william${WATCHLIST}`);
  assert.equal(william.status, 200);
  assert.deepEqual(names(william), ["The Killing", "Nights of Cabiria", "Reservoir Dogs", "Old Friend You Saw"], "wanted by William, none seen by William (Wild at Heart is on his list and he saw it: out); Old Friend You Saw is a film Marco has seen; the order of the index");
  assert.deepEqual(names(await r.get(`/u/gustavo${WATCHLIST}`)), ["8½", "Reservoir Dogs"], "Just Below The Floor is wanted by Gustavo and is not eligible: out");
  assert.equal(total(william), 4);
  assert.ok(william.json.metas.every((m) => !MARCO_WATCHLIST.includes(m.id)), "none of Marco's");
  assert.match(william.json.metas[0].description, /A synopsis of The Killing\./, "the card has the film's text (the piece's rowDesc is the film's general text), not Marco's row text");
  assert.ok(william.json.metas.every((m) => !/Marco's own text/.test(m.description)));
  assert.equal(william.headers.get("x-mood-friend"), "william");
  const fresh = rig();
  await fresh.get(`/u/william${WATCHLIST}`);
  assert.deepEqual(fresh.calls, ["index-v2-menus.json", "index-v2-row-watchlist-william.json"], "the menus say who William is; his piece is the one file read — not Marco's index-v2-row-watchlist.json");
});

test("(c) a friend's piece that is missing is an empty page — never Marco's Watchlist, from the whole v2 index or from the legacy Board either", async () => {
  const files = { ...FILES };
  delete files["index-v2-row-watchlist-william.json"];
  const r = rig(files);
  const william = await r.get(`/u/william${WATCHLIST}`);
  assert.equal(william.status, 200);
  assert.deepEqual(william.json.metas, []);
  assert.ok(!r.calls.includes("index-v2.json"), "the whole v2 index, which holds Marco's `watchlist` row, is not the stand-in");
  assert.deepEqual(names(await r.get(`/u/gustavo${WATCHLIST}`)), ["8½", "Reservoir Dogs"], "the other friend is untouched");
  // the same when the piece is another friend's file under William's name: the part it declares is checked
  files["index-v2-row-watchlist-william.json"] = FILES["index-v2-row-watchlist-gustavo.json"];
  assert.deepEqual((await rig(files).get(`/u/william${WATCHLIST}`)).json.metas, []);
});

test("(c) the build writes one piece per friend, in the order of friends.people, each holding exactly its row — wanted, not seen by that friend, eligible, in the index's order", () => {
  const { v2 } = objects();
  const want = { gustavo: ["tt0000013", "tt0000011"], william: ["tt0000001", "tt0000012", "tt0000011", "tt0000020"] };
  for (const [i, who] of v2.friends.people.entries()) {
    const slug = slugOf(who), j = JSON.parse(FILES[`index-v2-row-watchlist-${slug}.json`]);
    assert.equal(j.meta.part, `v2-row:${pieceId(slug)}`);
    assert.deepEqual(j.rows.watchlist, want[slug], slug);
    assert.deepEqual(j.rows.watchlist, FV.watchlistFilms(v2, i).map((e) => e.tt));
    assert.equal(j.films.length, j.rows.watchlist.length);
    assert.equal(j.meta.count, j.films.length);
  }
});

test("(c) a Board with no Watchlist row of its own gives the friend no Watchlist at all — a 404, never the legacy Board's row, which is Marco's", async () => {
  const menus = JSON.parse(FILES["index-v2-menus.json"]);
  menus.board = menus.board.filter((r) => r.id !== "watchlist"); delete menus.rows.watchlist; delete menus.rowDesc.watchlist;
  const r = rig({ ...FILES, "index-v2-menus.json": JSON.stringify(menus) });
  assert.equal((await r.get(`/u/william${WATCHLIST}`)).status, 404);
  assert.deepEqual(names(await r.get(WATCHLIST)), ["Amélie", "Pulp Fiction"], "the public address falls back to the legacy Board, as it always did");
});

// ── (d) the manifest ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(d) the manifest: its own id and name, a description that says whose is what, and the catalogs, version and resources of the public manifest", async () => {
  const r = rig();
  const pub = (await r.get("/manifest.json")).json;
  for (const [slug, name] of [["william", "William"], ["gustavo", "Gustavo"]]) {
    const res = await r.get(`/u/${slug}/manifest.json`);
    assert.equal(res.status, 200);
    const m = res.json;
    assert.equal(m.id, `com.mgusmao.moodengine.live.u.${slug}`);
    assert.equal(m.name, `Mood Engine · ${name}`);
    assert.match(m.description, new RegExp(`Marco's Mood Engine seen through ${name}`));
    assert.match(m.description, new RegExp(`${name}'s own`));
    assert.match(m.description, /taste behind the rows, the lists, the Board and the friends are Marco's/);
    assert.deepEqual(m.catalogs, pub.catalogs.map((c) => c.id === "watchlist" ? { ...c, name: "Your watchlist" } : c), "the same catalogs and order; the friend's watchlist promises no addition-date ordering");
    assert.deepEqual([m.version, m.types, m.resources, m.idPrefixes, m.logo, m.behaviorHints], [pub.version, pub.types, pub.resources, pub.idPrefixes, pub.logo, pub.behaviorHints]);
    assert.ok(m.catalogs.some((c) => c.id === "watchlist"), "the Watchlist row is a catalog");
    assert.equal(res.headers.get("x-mood-friend"), slug);
  }
  assert.equal(pub.id, "com.mgusmao.moodengine.live", "the public one keeps its id");
  assert.deepEqual(r.calls.filter((c) => c !== "index-v2-menus.json"), [], "only the menus are read");
});

test("(d) the install page of a friend", async () => {
  const page = await rig().get("/u/william/");
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>Mood Engine · William<\/title>/);
  assert.match(page.text, /stremio:\/\/mood-engine\.example\.workers\.dev\/u\/william\/manifest\.json/);
  assert.equal((await rig().get("/u/william")).status, 200, "no trailing slash");
});

// ── (e) 404 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(e) an address that is not a friend of the index is a 404 — a name not in the list, upper case, an encoded spelling, Will's segment, a friend of the list that this index does not have — and the answer names no friend", async () => {
  const r = rig();
  for (const slug of ["nobody", "William", "wil%6Ciam", "friend-a2", "", "william.json", "x".repeat(40), "a-b", "friend-b", "friend-g"]) {
    for (const path of ["/manifest.json", WATCHLIST, EXPLORE_50S, "/"]) {
      const res = await r.get(`/u/${slug}${path}`);
      assert.equal(res.status, 404, `/u/${slug}${path}`);
      assert.equal(res.headers.get("x-mood-friend"), null);
    }
  }
  assert.equal((await r.get("/u/nobody/catalog/movie/explore/genre=All.json")).json.err, "not found");
  assert.deepEqual(r.calls.filter((c) => c !== "index-v2-menus.json"), [], "no file but the menus is ever read for an address that is not a friend");
  const fresh = rig();
  for (const slug of ["nobody", "William", "marco", "wil%6Ciam"]) await fresh.get(`/u/${slug}/manifest.json`);
  assert.deepEqual(fresh.calls, [], "…and for an address that is not in the list of seven, not even the menus");
});

test("(e) under /u/<friend>/ only the manifest, the catalogs, the subtitles and the install page exist: the profiles, the private address, the film page and the downloads are 404", async () => {
  const r = rig();
  for (const path of ["/p/night/manifest.json", "/p/marco/catalog/movie/tonight.json", "/k/abcdefghijklmnopqrstuvwxyz/manifest.json", "/page/manifest.json", "/page/tt0000001.json", "/subfile/1/2/3.srt", "/meta/movie/tt0000001.json", "/data/index.json", "/anything"]) {
    assert.equal((await r.get(`/u/william${path}`)).status, 404, path);
  }
  assert.equal((await r.get("/k/abcdefghijklmnopqrstuvwxyz/u/william/manifest.json")).status, 404, "the friend's address behind the private one");
  assert.equal((await r.get("/u/william/u/william/manifest.json")).status, 404);
  assert.equal((await r.get("/u/friend-a/manifest.json")).headers.get("x-mood-friend"), null, "Will's own segment is not a friend");
  const post = await r.get("/u/william/manifest.json", { method: "POST" });
  assert.equal(post.status, 405);
  const head = await r.get("/u/william/manifest.json", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.text, "");
});

test("(e) the subtitles under /u/<friend>/ are the public ones: the private address's extra tier is never asked", async () => {
  const exact = [];
  const subtitles = { list: async () => ({ subs: [] }), exact: async (...a) => { exact.push(a); return { ids: new Set(), extras: [], status: "ran" }; } };
  const r = rigOf(FILES, createHandler, createStore, { handler: { subtitles, languages: { lookup: async () => ({ language: null, status: "none" }) } } });
  const res = await r.get("/u/william/subtitles/movie/tt0000001.json");
  assert.equal(res.status, 200);
  assert.deepEqual(exact, [], "no exact search: only /k/ does that");
  assert.equal(res.headers.get("x-subtitles-exact"), "public");
  assert.equal(res.headers.get("x-mood-friend"), "william");
});

test("(e) the address shape: friends.js and people.js agree on what a friend segment is, and Will's segment is never one", () => {
  assert.ok(isFriendSlug("william") && isFriendSlug("friend-g") && !isFriendSlug("a1") && !isFriendSlug("marco") && !isFriendSlug("friend-a") && !isFriendSlug("William") && !isFriendSlug("") && !isFriendSlug("a-b") && !isFriendSlug(undefined) && !isFriendSlug("__proto__"));
  assert.deepEqual(resolvePerson("/u/william/manifest.json", "https://x.test/data/index.json"), { person: null, friend: "william", path: "/manifest.json", base: "/u/william", full: "https://x.test/data/index.json" });
  assert.equal(resolvePerson("/u/friend-a/manifest.json", "https://x.test/data/index.json").person.id, "friend-a");
  assert.equal(resolvePerson("/u/wil%6Ciam/manifest.json", "https://x.test/data/index.json"), null);
  assert.equal(resolvePerson("/u/william/k/x/manifest.json", "https://x.test/data/index.json"), null);
  const index = hydrate(JSON.parse(FILES["index-v2-menus.json"]));
  assert.equal(friendOf(index, "william").bit, 1);
  assert.equal(friendOf(index, "gustavo").bit, 0);
  assert.equal(friendOf(index, "nobody"), null);
  assert.equal(friendOf(index, "friend-a"), null);
});

test("the worker and the build make the same address from a name, and the 7 friends of config.json are 7 valid, different addresses that are not Will's", () => {
  for (const n of ["William", "friend-d", "friend-e", "friend-g", "Gustavo"]) assert.equal(slugOf(n), FV.slugOf(n));
  assert.equal(SLUG.source, FV.SLUG.source);
  const cfg = JSON.parse(fs.readFileSync(new URL("../../config.json", import.meta.url), "utf8"));
  const people = cfg.friends.map((f) => f.name || f.user);
  assert.deepEqual(FV.slugsOf(people), ["william", "friend-b", "gustavo", "friend-d", "friend-e", "francesca", "friend-g"]);
  assert.deepEqual([...FRIEND_SLUGS], FV.slugsOf(people), "the Worker's closed list of addresses is the config's friends, in its order: a friend added to config.json without a line in worker/src/friends.js has no address");
  assert.throws(() => FV.slugsOf(["Ana", "ANA"]), /same address/);
  assert.throws(() => FV.slugsOf(["Ana Maria"]), /not lower case letters and digits/);
  assert.throws(() => FV.slugsOf(["Will" + "cloak"]), /Will's/);
  assert.throws(() => FV.slugsOf(Array.from({ length: 32 }, (_, i) => `p${i}`)), /a mask holds 31/);
});

// ── (f) the public addresses do not change ───────────────────────────────────────────────────────────────────────────────────────────────

const GOLDEN = JSON.parse(fs.readFileSync(new URL("./fixtures/friend-view-public-routes.json", import.meta.url), "utf8"));

// 14/11/2026: every film card carries `background` (the film page's own address for the id; Marco, the Samsung TV). The golden is still the one origin/main 415bd4e gave: the key is taken out of a card only when
// it is exactly that address for the card's id (sweep.js withoutCardBackground), and every other byte of the body is compared as before. That the key IS on every card: test/card-background.test.js.
test("(f) 24 public routes answer byte for byte as the code of origin/main (415bd4e) answered them: status, content type, cache, X-Total and the whole body (the film cards' `background` of 14/11/2026 apart)", async () => {
  const r = rig();
  assert.deepEqual(Object.keys(GOLDEN.routes), PUBLIC_ROUTES.map(([n]) => n));
  assert.equal(PUBLIC_ROUTES.length, 24);
  for (const [name, path] of PUBLIC_ROUTES) {
    const res = await r.get(path);
    const want = GOLDEN.routes[name];
    assert.deepEqual({ status: res.status, type: res.headers.get("content-type"), cache: res.headers.get("cache-control"), total: res.headers.get("x-total"), text: withoutCardBackground(res.text) }, want, `${name}: ${path}`);
  }
  // and after the friends have been asked everything: the same again (nothing a friend asked is kept for the public address)
  for (const slug of ["william", "gustavo"]) for (const [, path] of PUBLIC_ROUTES.slice(0, 8)) await r.get(`/u/${slug}${path}`);
  for (const [name, path] of PUBLIC_ROUTES) assert.equal(withoutCardBackground((await r.get(path)).text), GOLDEN.routes[name].text, `${name}, after the friends`);
});

// ── (g) an index with no masks ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(g) an index from before the masks cannot serve a friend: 503, no-store, never the films with nothing seen — and the public address reads it as before", async () => {
  const old = Object.fromEntries(Object.entries(FILES).map(([n, t]) => [n, n.startsWith("index") ? withoutMasks(t) : t]));
  const r = rig(old);
  for (const path of ["/manifest.json", PICKS_PATH, EXPLORE_50S, WATCHLIST]) {
    const res = await r.get(`/u/william${path}`);
    assert.equal(res.status, 503, path);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.match(res.json.err, /next build/);
  }
  assert.equal((await r.get(PICKS_PATH)).status, 200);
  assert.deepEqual(names(await r.get(PICKS_PATH)), ["Pierrot le Fou", "Amélie", "Breathless", "A Very Short Film"]);
});

test("(g) a piece without masks next to menus with them (a piece cached from before the build) is refused too, not read with nothing seen", async () => {
  const mixed = { ...FILES, "index-v2.json": withoutMasks(FILES["index-v2.json"]) };
  const r = rig(mixed);
  assert.equal((await r.get(`/u/william${EXPLORE_50S}`)).status, 503);
  assert.equal((await r.get(`/u/william${PICKS_PATH}`)).status, 503);
  assert.equal((await r.get(`/u/william/manifest.json`)).status, 200, "the menus have them");
  assert.equal((await r.get(EXPLORE_50S)).status, 200, "the public address does not care");
});

test("(g) no v2 menus (a site with no board) cannot serve a friend either: there is no Watchlist row to replace", async () => {
  const legacyOnly = Object.fromEntries(Object.entries(FILES).filter(([n]) => !n.startsWith("index-v2")));
  const res = await rig(legacyOnly).get("/u/william/manifest.json");
  assert.equal(res.status, 503);
});

test("(g) cached pieces use their own friend order when the menus come from a reordered build", async () => {
  const next = objects();
  next.v2.friends = { ...next.v2.friends, people: [...next.v2.friends.people].reverse() };
  const newer = filesOf(next);
  const mixed = rig({ ...FILES, "index-v2-menus.json": newer["index-v2-menus.json"] });
  const baseline = rig();
  for (const slug of ["william", "gustavo"]) {
    for (const path of [EXPLORE_50S, PICKS_PATH, WATCHLIST, "/catalog/movie/search/search=paths.json", "/catalog/movie/friends/genre=Top%20%C2%B7%20Gustavo.json"]) {
      const url = `/u/${slug}${path}`;
      const expected = await baseline.get(url);
      const actual = await mixed.get(url);
      assert.equal(actual.status, expected.status, url);
      assert.deepEqual(actual.json, expected.json, url);
      assert.equal(total(actual), total(expected), url);
    }
  }
});

test("(g) a friend absent from a cached piece gets 503, never another person's mask", async () => {
  const old = JSON.parse(FILES["index-v2.json"]);
  old.friends.people = ["Gustavo"];
  const res = await rig({ ...FILES, "index-v2.json": JSON.stringify(old) }).get(`/u/william${EXPLORE_50S}`);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("(g) declared mask columns with missing or invalid cells cannot serve a friend; public routes still work", async () => {
  for (const invalid of [undefined, null, "0", -1, 0.5, 2 ** 31]) {
    for (const column of [27, 28]) {
      const broken = JSON.parse(FILES["index-v2.json"]);
      broken.films.find(row => row[column] > 0)[column] = invalid;
      const r = rig({ ...FILES, "index-v2.json": JSON.stringify(broken) });
      const res = await r.get(`/u/william${EXPLORE_50S}`);
      assert.equal(res.status, 503, `column ${column}: ${invalid}`);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal((await r.get(EXPLORE_50S)).status, 200);
    }
  }
  const short = JSON.parse(FILES["index-v2.json"]);
  short.films.forEach(row => row.splice(27));
  const r = rig({ ...FILES, "index-v2.json": JSON.stringify(short) });
  assert.equal((await r.get(`/u/william${EXPLORE_50S}`)).status, 503);
});


test("complete Discover pieces: missing masks or viewer fall back to full data; full's masks guard remains a 503", async () => {
  const name = "index-v2-opt-places-p-picks.json";
  const mutations = {
    "missing piece": (files) => { delete files[name]; },
    "old columns": (files) => { files[name] = withoutMasks(files[name]); },
    "missing viewer": (files) => { const j = JSON.parse(files[name]); j.friends.people = ["Gustavo"]; files[name] = JSON.stringify(j); },
    "invalid masks": (files) => { const j = JSON.parse(files[name]); j.films[0][27] = -1; files[name] = JSON.stringify(j); },
    "partial candidates": (files) => { const j = JSON.parse(files[name]); j.films.pop(); j.discover.catalogs[0].options[0].ids.pop(); files[name] = JSON.stringify(j); },
  };
  for (const [what, mutate] of Object.entries(mutations)) {
    const files = { ...FILES };
    mutate(files);
    for (const suffix of ["", "&seen=Include%20seen", "&country=France"]) {
      const url = `/u/william/catalog/movie/places/genre=Picks${suffix}.json`;
      const baseline = { ...FILES }; delete baseline[name];
      const want = await rig(baseline).get(url), r = rig(files), got = await r.get(url);
      assert.equal(got.status, 200, what);
      assert.equal(got.text, want.text, what);
      assert.equal(total(got), total(want), what);
      assert.ok(r.calls.includes("index-v2.json"), what);
      const brokenFull = { ...files, "index-v2.json": withoutMasks(files["index-v2.json"]) };
      const refused = await rig(brokenFull).get(url);
      assert.equal(refused.status, 503, `${what}: full guard`);
      assert.equal(refused.headers.get("cache-control"), "no-store", what);
    }
  }
});


test("William complete option uses its own masks and total without requesting the full index", async () => {
  const candidateFiles = { ...FILES }; delete candidateFiles["index-v2.json"];
  const referenceFiles = { ...FILES }; delete referenceFiles["index-v2-opt-places-p-picks.json"];
  const candidate = rig(candidateFiles), reference = rig(referenceFiles);
  for (const suffix of ["", "&seen=Include%20seen", "&country=France", "&runtime=Under%2090%20min", "&rating=4.2%2B", "&decade=1950s", "&skip=2", "&skip=100"]) {
    const url = `/u/william/catalog/movie/places/genre=Picks${suffix}.json`;
    const got = await candidate.get(url), want = await reference.get(url);
    assert.equal(got.status, 200, url);
    assert.equal(got.text, want.text, url);
    assert.equal(total(got), total(want), url);
    assert.ok(!candidate.calls.includes("index-v2.json"), url);
  }
});


test("a friend's filtered complete option prefers a fresh full index without fetching its piece", async () => {
  const r = rig();
  assert.equal((await r.get(`/u/william${EXPLORE_50S}`)).status, 200);
  const before = r.calls.length;
  assert.equal((await r.get("/u/william/catalog/movie/places/genre=Picks&country=France.json")).status, 200);
  assert.deepEqual(r.calls.slice(before), [], "the full index and menus are fresh");
});
