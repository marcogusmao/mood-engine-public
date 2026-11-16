import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../src/handler.js";
import { createStore, RETRY_MS } from "../src/store.js";
import { filesOf, withoutMasks, DIR, ENV, NOW } from "./friend-view-fixture.js";

const FILES = filesOf();
const ROW = "index-v2-row-tonight.json";
const MENUS = "index-v2-menus.json";
const PATH = "/u/william/catalog/movie/tonight.json";
function rig(oldFiles = [ROW]) {
  const r = { now: NOW, calls: [], files: { ...FILES }, cache: new Map(), down: false };
  for (const name of oldFiles) r.cache.set(`${DIR}${name}?store=index`, { text: withoutMasks(FILES[name]), at: NOW });
  const caches = { default: {
    match: async key => { const c = r.cache.get(key); return c && new Response(c.text, { headers: { "x-fetched-at": String(c.at) } }); },
    put: async (key, response) => r.cache.set(key, { text: await response.text(), at: Number(response.headers.get("x-fetched-at")) }),
  } };
  r.store = createStore({ caches, now: () => r.now, log: () => {}, fetchImpl: async url => {
    const name = url.slice(DIR.length); r.calls.push(name);
    if (r.down) throw new Error("offline");
    return r.files[name] ? new Response(r.files[name]) : new Response("missing", { status: 404 });
  } });
  const handle = createHandler({ store: r.store, now: () => r.now });
  r.get = path => handle(new Request(`https://worker.test${path}`), ENV);
  return r;
}

test("friend recovers an incompatible fresh edge piece from the published file before replying", async () => {
  const r = rig();
  const res = await r.get(PATH);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-index-source"), "network");
  assert.equal(r.calls.filter(n => n === ROW).length, 1);
  assert.deepEqual(await res.json(), await (await rig([]).get(PATH)).json());
});

test("friend recovers incompatible menus and a piece already loaded into memory", async () => {
  const r = rig([MENUS, ROW]);
  await r.store.get(DIR + MENUS); await r.store.get(DIR + ROW);
  assert.equal(r.calls.length, 0);
  const res = await r.get(PATH);
  assert.equal(res.status, 200);
  assert.deepEqual(r.calls.sort(), [MENUS, ROW].sort());
});

test("fresh menus with masks but missing the requested friend recover before deciding 404", async () => {
  const r = rig([]);
  const menus = JSON.parse(FILES[MENUS]);
  menus.friends.people = ["Gustavo"];
  r.cache.set(`${DIR}${MENUS}?store=index`, { text: JSON.stringify(menus), at: NOW });
  const response = await r.get("/u/william/manifest.json");
  assert.equal(response.status, 200);
  assert.equal(r.calls.filter(n => n === MENUS).length, 1);
  assert.deepEqual(await response.json(), await (await rig([]).get("/u/william/manifest.json")).json());
});

test("a friend still absent at the source stays 404 without repeated downloads", async () => {
  const r = rig([]);
  const menus = JSON.parse(FILES[MENUS]);
  menus.friends.people = ["Gustavo"];
  r.files[MENUS] = JSON.stringify(menus);
  for (let i = 0; i < 3; i++) assert.equal((await r.get("/u/william/manifest.json")).status, 404);
  assert.equal(r.calls.filter(n => n === MENUS).length, 1);
});

test("simultaneous friends share the recovery of the same incompatible cached file", async () => {
  const r = rig();
  await r.store.get(DIR + MENUS); await r.store.get(DIR + ROW);
  const responses = await Promise.all([r.get(PATH), r.get(PATH.replace("william", "gustavo")), r.get(PATH)]);
  assert.deepEqual(responses.map(r => r.status), [200, 200, 200]);
  assert.equal(r.calls.filter(n => n === ROW).length, 1);
});

test("still incompatible publication is refused with provenance and a bounded retry; public row stays usable", async () => {
  const r = rig();
  r.files[ROW] = withoutMasks(FILES[ROW]);
  const res = await r.get(PATH);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.ok(res.headers.get("x-index-built-at"));
  assert.equal(res.headers.get("x-index-source"), "network");
  const repeated = await r.get(PATH);
  assert.equal(repeated.headers.get("x-index-source"), "memory");
  await r.get(PATH.replace("william", "gustavo"));
  assert.equal(r.calls.filter(n => n === ROW).length, 1);
  assert.equal((await r.get("/catalog/movie/tonight.json")).status, 200);
  r.files[ROW] = FILES[ROW]; r.now += RETRY_MS + 1;
  assert.equal((await r.get(PATH)).status, 200);
  assert.equal(r.calls.filter(n => n === ROW).length, 2);
});

test("offline recovery keeps the incompatible cache for public use, never treats it as unseen for a friend", async () => {
  const r = rig();
  await r.store.get(DIR + MENUS); r.down = true;
  for (let i = 0; i < 3; i++) {
    const res = await r.get(PATH);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
  assert.equal(r.calls.filter(n => n === ROW).length, 1);
  assert.equal((await r.get("/catalog/movie/tonight.json")).status, 200);
});

test("a just-fetched incompatible source is not fetched a second time; recovery resumes after the cooldown", async () => {
  const r = rig([]);
  r.files[ROW] = withoutMasks(FILES[ROW]);
  assert.equal((await r.get(PATH)).status, 503);
  r.files[ROW] = FILES[ROW];
  assert.equal((await r.get(PATH)).status, 503);
  assert.equal(r.calls.filter(n => n === ROW).length, 1);
  r.now += RETRY_MS + 1;
  assert.equal((await r.get(PATH)).status, 200);
  assert.equal(r.calls.filter(n => n === ROW).length, 2);
});

test("an expired incompatible memory piece waits for the background refresh already in flight", async () => {
  const r = rig([ROW]);
  await r.store.get(DIR + ROW);
  r.now += 1800_001;
  const res = await r.get(PATH);
  assert.equal(res.status, 200);
  assert.equal(r.calls.filter(n => n === ROW).length, 1);
});
