// Public identity routing: synthetic owners share IMDb ids but disagree on personal state.
// All sources below are injected; no real HTTP or account source is used.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHandler, urlsOf } from "../src/handler.js";
import { PEOPLE, resolvePerson } from "../src/people.js";
import { createStore, isPermanent, parseIndex, REVALIDATE_MS } from "../src/store.js";
import { buildManifest, buildProfileManifest } from "../src/manifest.js";
import { LIST_NAMES } from "../src/list-names.js";
import { PROFILES, profileOf } from "../src/profiles.js";
import { makeObject, tt } from "./profile-fixture.js";
import { textOf, v2ObjectFrom, v2FilesOf, tweak } from "./fixture.js";
const require = createRequire(import.meta.url);
const exporter = require("../../lib/index-export.js");
const ROOT = "https://pages.test/mood-engine/";
const MARCO = `${ROOT}data/`;
const REVISION = "r-" + "1".repeat(32);
const WILL = `${ROOT}u/friend-a/r/${REVISION}/data/`;
const ENV = { INDEX_URL: `${MARCO}index.json` };
const PREFIX = "/u/friend-a";

function filesFor(will, v2 = true, manyLists = false) {
  const o = structuredClone(makeObject());
  o.meta.countries = [will ? "France" : "Japan"];
  if (will) { o.meta.personId = "friend-a"; o.meta.revision = REVISION; }
  for (const f of o.films) {
    if (will) {
      f.seen = !f.seen;
      f.watchlist = !f.watchlist;
      f.lbRating = 5 - f.lbRating;
      f.taste = -f.taste;
      f.desc = `Will's rating and reasons\nWill's pick\n\nWill's synopsis.`;
      // Eligibility is a build verdict, independent of the routing under test.
      f.eligible = true;
    }
    f.countries = o.meta.countries;
  }
  if (manyLists) {
    const ids = LIST_NAMES.filter((l) => l.themes.includes("21st century")).slice(0, 9).map((l) => l.id);
    assert.equal(ids.length, 9);
    o.lists = ids.map((id) => ({ id, label: id }));
    for (const f of o.films) f.lists = Object.fromEntries(ids.map((id) => [id, 1]));
  }
  // Both owners' rows refer to the same ids; the Worker must use each owner's flags.
  o.rows.tonight = [tt("Night 1"), tt("Seen Night Top")];
  o.rowDesc.tonight = o.rows.tonight.map(() => will ? "Will cast\nWill pick." : "Marco cast\nMarco pick.");
  const files = { "index.json": textOf(o) };
  for (const p of exporter.pieces(o)) files[p.rel.split("/").pop()] = textOf(p.obj);
  return v2 ? { ...files, ...v2FilesOf(v2ObjectFrom(o)) } : files;
}
function rig({ v2 = true, missing = [], edit, pieceMax = 12, pieceBytes, cache = false, manyLists = false } = {}) {
  const files = new Map();
  for (const [dir, own] of [[MARCO, false], [WILL, true]])
    for (const [name, raw] of Object.entries(filesFor(own, v2, manyLists)))
      if (!missing.includes(dir + name)) files.set(dir + name, edit ? edit(raw, dir, name) : raw);
  const r = { files, calls: [], logs: [], clock: 1e9, down: false };
  const edge = new Map();
  const caches = cache ? { default: {
    match: async (u) => edge.get(u)?.clone(),
    put: async (u, res) => { edge.set(u, res.clone()); },
  } } : undefined;
  r.store = createStore({ fetchImpl: async (u) => {
    r.calls.push(u);
    if (r.down) throw Error("down");
    return files.has(u) ? new Response(files.get(u)) : new Response("missing", { status: 404 });
  }, caches, now: () => r.clock, pieceMax, willPieceMax: pieceMax, ...(pieceBytes ? { pieceBytes, willPieceBytes: pieceBytes } : {}), log: (e) => r.logs.push(e) });
  const forbidden = () => { assert.fail("a personal source was invoked"); };
  r.handle = createHandler({ publication: async () => ({ revision: REVISION }), store: r.store, subtitles: { list: forbidden, exact: forbidden }, languages: { lookup: forbidden }, subfiles: { offering: forbidden, fetchSubtitle: forbidden }, now: () => r.clock });
  r.get = async (path, init, env = ENV) => {
    const res = await r.handle(new Request(`https://worker.test${path}`, init), env);
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: text && res.headers.get("content-type").includes("json") ? JSON.parse(text) : null };
  };
  return r;
}
const ids = (r) => r.json.metas.map((m) => m.id);

test("closed owner registry: exact id and sibling data URL, independent profile suffix", () => {
  assert.deepEqual(Object.keys(PEOPLE), ["friend-a"]);
  const r = resolvePerson(`${PREFIX}/p/marco/manifest.json`, ENV.INDEX_URL);
  assert.equal(r.full, `${ROOT}u/friend-a/data/index.json`);
  assert.equal(r.path, "/p/marco/manifest.json");
  assert.equal(r.base, PREFIX);
  assert.equal(urlsOf({ INDEX_URL: r.full }).languages, `${ROOT}u/friend-a/data/film-languages.json`);
  assert.equal(resolvePerson("/manifest.json", ENV.INDEX_URL).person, null);
  assert.equal(resolvePerson(`${PREFIX}/`, "https://host.test/other/data/index.json").full, "https://host.test/other/u/friend-a/data/index.json");
});

// 20/10/2026: resolvePerson decoded the WHOLE path before splitting, so an encoded slash inside a value ("search=x%2Fu%2Fy.json") made a "u" segment and Marco's own search answered 404 on this branch (200 on main).
test("an encoded /u/ or /k/ inside one segment of Marco's address is a value, not an owner marker; an encoded marker segment is still refused", async () => {
  for (const p of ["/catalog/movie/search/search=x%2Fu%2Fy.json", "/catalog/movie/search/search=a%2Fk%2Fb.json"]) {
    assert.deepEqual(resolvePerson(p, ENV.INDEX_URL), { person: null, path: p, base: "", full: ENV.INDEX_URL }, p);
  }
  const r = rig();
  assert.equal((await r.get("/catalog/movie/search/search=x%2Fu%2Fy.json")).status, 200);
  assert.equal(resolvePerson("/%75/friend-a/manifest.json", ENV.INDEX_URL), null);
  assert.equal(resolvePerson("/catalog/%75/x.json", ENV.INDEX_URL), null);
});

for (const v2 of [false, true]) {
  test(`Will ${v2 ? "v2" : "legacy"}: personalized manifest and home links, six unchanged profile shapes, no series`, async () => {
    const r = rig({ v2 });
    const manifest = await r.get(`${PREFIX}/manifest.json`);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.json.id, "com.mgusmao.moodengine.live.friend-a");
    assert.equal(manifest.json.name, "Mood Engine · Will");
    assert.ok(!manifest.json.catalogs.some((c) => c.type === "series" || c.id === "my-series"));
    assert.match((await r.get(`${PREFIX}/`)).text, /Mood Engine · Will/);
    assert.match((await r.get(`${PREFIX}/`)).text, /stremio:\/\/worker.test\/u\/friend-a\/manifest.json/);
    for (const key of PROFILES.keys()) {
      const m = await r.get(`${PREFIX}/p/${key}/manifest.json`);
      assert.equal(m.status, 200, key);
      assert.equal(m.json.id, `com.mgusmao.moodengine.live.friend-a.${key}`);
      assert.equal(m.json.name, "Mood Engine · Will");
      assert.ok(!m.json.catalogs.some((c) => c.id === "my-series"));
      const home = await r.get(`${PREFIX}/p/${key}/`);
      assert.ok(home.text.includes(`stremio://worker.test${PREFIX}/p/${key}/manifest.json`));
      assert.match(home.text, /Mood Engine · Will/);
    }
    assert.ok(r.calls.every((u) => u.startsWith(WILL)), r.calls.join("\n"));
  });

  test(`Will ${v2 ? "v2" : "legacy"}: rows, moods, search, lists, filters and marco/night profile use own state`, async () => {
    const r = rig({ v2 });
    const paths = [
      "/catalog/movie/tonight.json", "/catalog/movie/explore.json", "/catalog/movie/search/search=night.json",
      "/catalog/movie/moods/genre=Nocturnal.json", "/catalog/movie/moods/genre=Nocturnal&country=France.json",
      "/catalog/movie/lists/genre=Old%20label%20of%20poxvK.json", "/catalog/movie/lists-unseen/genre=Old%20label%20of%20poxvK.json",
      "/p/marco/catalog/movie/tonight.json", "/p/marco/catalog/movie/search/search=night.json",
      "/p/night/catalog/movie/tonight.json", "/p/night/catalog/movie/watchlist.json", "/p/night/catalog/movie/theme-horror.json",
    ];
    for (const path of paths) {
      const w = await r.get(PREFIX + path);
      assert.equal(w.status, 200, path);
      if (!path.endsWith("/watchlist.json")) assert.ok(w.json.metas.length, path);
      else assert.deepEqual(w.json.metas, [], "opposite watchlist membership leaves Will no unseen watchlist film");
      const m = await r.get(path);
      assert.notEqual(w.text, m.text, path);
      if (!path.includes("/lists/") && !path.endsWith("/watchlist.json")) assert.ok(ids(w).includes(tt("Seen Night Top")), path);
    }
    const seen = await r.get(`${PREFIX}/catalog/movie/moods/genre=Nocturnal.json`);
    assert.ok(!ids(seen).includes(tt("Night 1")));
    assert.ok(ids(await r.get("/catalog/movie/moods/genre=Nocturnal.json")).includes(tt("Night 1")));
    assert.deepEqual(ids(await r.get(`${PREFIX}/catalog/movie/moods/genre=Nocturnal&country=Japan.json`)), []);
  });

  test(`Will ${v2 ? "v2" : "legacy"}: missing pieces fall back only within owner folder`, async () => {
    const complete = rig({ v2 });
    const all = filesFor(true, v2);
    const missing = Object.keys(all).filter((n) => !["index.json", "index-v2.json", "index-v2-menus.json"].includes(n)).map((n) => WILL + n);
    const fallback = rig({ v2, missing });
    for (const path of ["/manifest.json", "/catalog/movie/tonight.json", "/catalog/movie/moods/genre=Nocturnal.json", "/catalog/movie/lists-unseen/genre=Old%20label%20of%20poxvK.json", "/p/night/catalog/movie/theme-horror.json", "/p/marco/catalog/movie/tonight.json"]) {
      assert.equal((await fallback.get(PREFIX + path)).text, (await complete.get(PREFIX + path)).text, path);
    }
    assert.ok(fallback.calls.includes(`${WILL}index.json`));
    if (v2) assert.ok(fallback.calls.includes(`${WILL}index-v2.json`));
    assert.ok(fallback.calls.every((u) => u.startsWith(WILL)));
  });
}

test("missing or mismatched owner is refused on all index pieces and full fallbacks, even with warm Marco data", async () => {
  for (const owner of [undefined, "marco", "friend-a", null]) {
    const r = rig({ edit: (raw, dir) => dir === WILL ? tweak(raw, (j) => { j.meta.personId = owner; }) : raw });
    await r.get("/manifest.json");
    await r.get("/catalog/movie/explore.json");
    assert.equal((await r.get(`${PREFIX}/manifest.json`)).status, 503);
    assert.equal((await r.get(`${PREFIX}/p/marco/manifest.json`)).status, 503);
    for (const path of ["/catalog/movie/tonight.json", "/catalog/movie/explore.json", "/catalog/movie/moods/genre=Nocturnal.json", "/catalog/movie/lists/genre=Old%20label%20of%20poxvK.json", "/p/night/catalog/movie/watchlist.json"]) {
      const res = await r.get(PREFIX + path);
      assert.deepEqual(res.json.metas, [], `${owner}: ${path}`);
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("cache-control"), "public, max-age=30");
    }
  }
});

test("a mislabeled individual row/list/mood/full is refused and a valid owner fallback still works", async () => {
  for (const [bad, path, fallback] of [
    ["index-v2-row-tonight.json", "/catalog/movie/tonight.json", "index-v2.json"],
    ["index-v2-mood-night.json", "/catalog/movie/moods/genre=Nocturnal.json", "index-v2.json"],
    ["index-list-poxvK.json", "/catalog/movie/lists-unseen/genre=Old%20label%20of%20poxvK.json", "index.json"],
  ]) {
    const r = rig({ edit: (raw, dir, name) => dir === WILL && name === bad ? tweak(raw, (j) => { delete j.meta.personId; }) : raw });
    const good = rig();
    assert.equal((await r.get(PREFIX + path)).text, (await good.get(PREFIX + path)).text);
    assert.ok(r.calls.includes(WILL + fallback));
  }
  const r = rig({ edit: (raw, dir, name) => dir === WILL && ["index-v2.json", "index.json"].includes(name) ? tweak(raw, (j) => { j.meta.personId = "marco"; }) : raw });
  assert.deepEqual((await r.get(`${PREFIX}/catalog/movie/explore.json`)).json.metas, []);
});

test("aliases, unknown and mixed private/owner routes return 404 before secrets or sources", async () => {
  const r = rig();
  const env = new Proxy(ENV, { get(target, key) {
    if (/TOKEN|OPENSUBTITLES|SUBS/.test(String(key))) assert.fail(`secret read: ${key}`);
    return target[key];
  } });
  for (const path of ["/u", "/u/", "/u/marco/manifest.json", "/u/friend-a/manifest.json", "/u/__proto__/manifest.json", "/u/%77illcloak/manifest.json", "/%75/friend-a/manifest.json", "/u/friend-a%2f/manifest.json", "/u/friend-a%00/manifest.json", "/u/friend-a /manifest.json", "/k/0123456789abcdef/u/friend-a/manifest.json", "/u/friend-a/k/0123456789abcdef/manifest.json", "/k/0123456789abcdef/%75/friend-a/manifest.json", "/p/night/u/friend-a/manifest.json", "/u/friend-a/u/friend-a/manifest.json"]) {
    assert.equal((await r.get(path, undefined, env)).status, 404, path);
  }
  assert.deepEqual(r.calls, []);
  assert.equal((await r.get(`${PREFIX}/catalog/series/my-series.json`, undefined, env)).status, 404);
  assert.equal((await r.get(`${PREFIX}/p/marco/catalog/series/my-series.json`, undefined, env)).status, 404);
  assert.equal((await r.get(`${PREFIX}/subtitles/movie/tt0000001.json`, undefined, env)).status, 404);
  assert.equal((await r.get(`${PREFIX}/p/night/subtitles/movie/tt0000001.json`, undefined, env)).status, 404);
  assert.equal((await r.get(`${PREFIX}/subfile/123/123/abc.srt`, undefined, env)).status, 404);
});

test("pure manifests keep Marco output exactly with an absent person; optional person removes legacy and v2 series", () => {
  for (const v2 of [false, true]) {
    const ix = parseIndex(filesFor(false, v2)[v2 ? "index-v2.json" : "index.json"]);
    assert.equal(JSON.stringify(buildManifest(ix)), JSON.stringify(buildManifest(ix, { person: null })));
    for (const key of PROFILES.keys()) {
      const p = profileOf(key);
      assert.equal(JSON.stringify(buildProfileManifest(ix, p)), JSON.stringify(buildProfileManifest(ix, p, { person: null })));
      assert.ok(!buildProfileManifest(ix, p, { person: PEOPLE.friend-a }).catalogs.some((c) => c.type === "series"));
    }
  }
});

for (const order of [[MARCO, WILL], [WILL, MARCO]]) {
  test(`one shared URL-keyed store: ${order[0] === MARCO ? "Marco first" : "Will first"}, eviction and stale outage never substitute another owner`, async (t) => {
    const r = rig({ pieceMax: 2, cache: true });
    const names = ["index.json", "index-v2-row-tonight.json", "index-board.json", "index-v2-menus.json"];
    for (const dir of order) for (const name of names) {
      const got = await r.store.get(dir + name);
      assert.equal(got.index.meta.personId, dir === WILL ? "friend-a" : undefined);
      assert.equal(isPermanent(dir + name), dir === MARCO);
    }
    assert.ok(r.store._willLru.size <= 2);
    assert.ok(r.logs.some((l) => l.event === "piece-evicted" && l.url.startsWith(WILL)));
    for (const name of names) assert.ok(r.store._slots.get(MARCO + name).index, "Marco permanent files stay warm");
    const got = await r.store.get(`${WILL}index.json`);
    assert.equal(got.index.meta.personId, "friend-a");
    assert.equal(got.source, "cache", "evicted owner data is read from its own edge key");
    const marco = await r.get("/catalog/movie/tonight.json");
    const will = await r.get(`${PREFIX}/catalog/movie/tonight.json`);
    assert.notDeepEqual(ids(marco), ids(will));
    r.clock += REVALIDATE_MS + 1;
    r.down = true;
    assert.equal((await r.get(`${PREFIX}/catalog/movie/tonight.json`)).text, will.text);
    assert.equal((await r.get("/catalog/movie/tonight.json")).text, marco.text);
    const raw = r.files.get(`${WILL}index.json`);
    t.diagnostic(`Will synthetic full text: ${Buffer.byteLength(raw, "utf8")} UTF-8 bytes; ${raw.length} UTF-16 code units (store LRU accounting).`);
  });
}

test("Will byte-budget accounting evicts full and row pieces while Marco stays permanent", async () => {
  const r = rig({ pieceMax: 20, pieceBytes: 1 });
  await r.store.get(`${MARCO}index.json`);
  await r.store.get(`${WILL}index.json`);
  await r.store.get(`${WILL}index-v2-row-tonight.json`);
  assert.equal(r.store._slots.get(`${WILL}index.json`), undefined);
  assert.ok(r.store._slots.get(`${WILL}index-v2-row-tonight.json`).index);
  assert.ok(r.store._slots.get(`${MARCO}index.json`).index);
  assert.equal(r.store._willLru.size, 1, "existing LRU retains the current piece even when it alone exceeds the budget");
});


test("profile with more than eight lists reads only owner's full legacy index and validates its identity", async () => {
  const path = `${PREFIX}/p/critics/catalog/movie/theme-21st-century.json`;
  const r = rig({ manyLists: true });
  const res = await r.get(path);
  assert.equal(res.status, 200);
  assert.deepEqual(ids(res), [tt("Seen Night Top")]);
  assert.deepEqual(r.calls, [`${WILL}index-board.json`, `${WILL}index.json`]);
  const bad = rig({ manyLists: true, edit: (raw, dir, name) => dir === WILL && name === "index.json" ? tweak(raw, (j) => { delete j.meta.personId; }) : raw });
  assert.deepEqual((await bad.get(path)).json.metas, []);
});
