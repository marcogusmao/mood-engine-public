// Subtitles the official list lacks, downloaded with Marco's OpenSubtitles account (Marco, 12/10/2026): the private address, the extra rows in /subtitles, the signed address,
// GET /subfile, and the state kept in KV. Everything is driven with fetch stubs shaped like the answers the research of 12/10/2026 documents
// (.context/2026-10-12-opensubtitles-download.md in the stremio repository): POST /login → { token, base_url }; POST /download → { link, remaining, reset_time_utc },
// 406 { remaining: -1 } when the quota is spent; GET link → the SRT. Nothing here has touched the real API: the shapes are documented, not measured with Marco's account.
// Not checked on a device.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHandler } from "../src/handler.js";
import { createStore } from "../src/store.js";
import { createSubtitleSource, extraOf, restBaseOf } from "../src/subtitles-source.js";
import * as subfileModule from "../src/subfile.js";
import { createSubfileSource, signFileUntil, verifyUntil, linkIsGood, expiryFor, FILE_TTL_MS, sameSecret, subfileConfigured, SUBFILE_PATH, LOGIN_BACKOFF_MS, QUOTA_PAUSE_MS, KEYS } from "../src/subfile.js";
import { makeFiles } from "./fixture.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "opensubtitles-v3-paterson-tt5247022.json"), "utf8"));
const FILE = "Paterson.2016.1080p.BluRay.X264-AMIABLE.mkv";
const HASH = "1cddc37a1943f1ae";
const USER = "marco-os-user", PASS = "pa55-secret-xyz", APIKEY = "api-key-123";
const TOK = "0123456789abcdef0123456789abcdef0123456789abcdef"; // 48 hex, like the real SUBTITLES_PRIVATE_TOKEN
const ENV = { OPENSUBTITLES_API_KEY: APIKEY, OPENSUBTITLES_USERNAME: USER, OPENSUBTITLES_PASSWORD: PASS, SUBTITLES_PRIVATE_TOKEN: TOK };
const SRT = "1\n00:00:01,000 --> 00:00:02,000\nOlá — café, naïve\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond line\n";
const NOW0 = Date.parse("2026-10-13T12:00:00Z"); // the clock of the harness: the address of a row carries an expiry in epoch seconds (10 digits), so the clock has to be in this century
const TOKEN1 = "TOKEN-ONE-abc.def.ghi", TOKEN2 = "TOKEN-TWO-jkl.mno.pqr";
const LINK = (id) => `https://www.opensubtitles.com/download/LINKPART${id}/subfile/Paterson-${id}.srt`;

/** REST search result (data[]) for the hash search. */
const hit = (legacy, fileId, o = {}) => ({ id: String(legacy), type: "subtitle", attributes: { subtitle_id: String(legacy), language: "en", moviehash_match: true, legacy_subtitle_id: legacy, release: "Paterson.2016.1080p.BluRay.x264-AMIABLE", files: [{ file_id: fileId, cd_number: 1, file_name: "Paterson.2016.1080p.BluRay.x264-AMIABLE" }], ...o } });
/** The two hash matches the official list already has (legacy ids 6926336 eng and 6926794 pob), then what it lacks, and what must be left out. */
const SEARCH = [
  hit(6926336, 111), hit(6926794, 112, { language: "pt-BR" }),
  hit(9999001, 7001), // English, not in the official list → offered
  hit(9999002, 7002, { language: "pt-BR", release: "" }), // Brazilian Portuguese, no release name: the file name stands in
  hit(9999010, 7010, { language: "pt-PT", ai_translated: false, machine_translated: false }), // Portuguese (PT), explicitly not machine-made → offered
  hit(9999003, 7003, { ai_translated: true }), // AI-translated → left out
  hit(9999004, 7004, { machine_translated: true }), // machine-translated → left out
  hit(9999005, 7005, { language: "fr" }), // another language → left out
  hit(9999006, 7006, { files: [{ file_id: 7006 }, { file_id: 7007 }] }), // two parts → left out
  hit(9999007, 7008, { moviehash_match: false }), // not a hash match → left out
  hit(9999008, 7009, { legacy_subtitle_id: undefined }), // no id to compare with the official list → left out
];

/** A Workers KV namespace in a Map, with the clock of the test and the rules of the real one (a time to live of at least 60 seconds). */
function fakeKv(r) {
  const m = new Map();
  return {
    _m: m,
    ops: [],
    async get(key, type) {
      if (r.kvSlow) await new Promise((resolve) => setTimeout(resolve, r.kvSlow));
      if (r.kvDown) throw new Error("KV is down");
      const e = m.get(key);
      if (!e || (e.expires && e.expires <= r.now)) { m.delete(key); return null; }
      return type === "json" ? JSON.parse(e.value) : e.value;
    },
    async put(key, value, opts = {}) {
      if (r.kvDown) throw new Error("KV is down");
      this.ops.push(["put", key]);
      assert.ok(typeof value === "string", "KV values are written as text");
      if (opts.expirationTtl !== undefined) assert.ok(opts.expirationTtl >= 60, `KV refuses a time to live under 60 seconds (${key}: ${opts.expirationTtl})`);
      m.set(key, { value, expires: opts.expirationTtl ? r.now + opts.expirationTtl * 1000 : 0, ttl: opts.expirationTtl });
    },
    async delete(key) { this.ops.push(["delete", key]); m.delete(key); },
  };
}

function harness({ search = SEARCH, login = "ok", download = "ok", link = "ok", baseUrl = "api.opensubtitles.com", languageOf = null, kv = true, offeringMs } = {}) {
  const r = { now: NOW0, calls: [], logs: [], edge: new Map(), login, download, link, baseUrl, search, downloadCount: 0, loginCount: 0, kvDown: false };
  const res = (status, body, headers) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  const core = async (url, init = {}) => {
    const u = String(url);
    r.calls.push({ url: u, method: init.method || "GET", headers: init.headers || {}, body: init.body, redirect: init.redirect });
    if (u.startsWith("https://opensubtitles-v3.strem.io/")) return res(200, REAL);
    const at = (what) => r.redirectAt === what;
    if ((at("login") && u.endsWith("/login")) || (at("download") && u.endsWith("/download")) || (at("search") && u.includes("/subtitles?"))) return res(307, "", { location: "https://evil.example/steal" });
    if (u.startsWith("https://evil.example/")) return res(200, { token: "STOLEN-BY-REDIRECT", data: [], link: "https://evil.example/x.srt" });
    if (/^https:\/\/(?:vip-)?api\.opensubtitles\.com\/api\/v1\/subtitles\?/.test(u)) {
      if (r.searchMode === "429") return res(429, { message: "Throttle limit reached" });
      if (r.searchMode === "bigheader") return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-length": "3000000" } });
      if (r.searchMode === "bigstream") {
        let sent = 0;
        r.searchCancelled = false;
        return new Response(new ReadableStream({ pull(c) { sent++; r.searchChunks = sent; c.enqueue(new Uint8Array(100000).fill(32)); if (sent > 60) c.close(); }, cancel() { r.searchCancelled = true; } }), { status: 200 });
      }
      return res(200, { total_pages: 1, data: r.search });
    }
    if (r.slow && /\/api\/v1\/(login|download)$/.test(u)) await new Promise((resolve) => setTimeout(resolve, 20)); // (a network that takes a moment: requests overlap)
    if (u.endsWith("/api/v1/login")) {
      r.loginCount++;
      if (r.login === "throw") throw new Error("network down");
      if (r.login === "401") return res(401, { message: "wrong credentials" });
      if (r.login === "html") return res(200, "<html>");
      return res(200, { user: { allowed_downloads: 20 }, base_url: r.baseUrl, token: r.loginCount === 1 ? TOKEN1 : TOKEN2, status: 200 });
    }
    if (u.endsWith("/api/v1/download")) {
      r.downloadCount++;
      const id = JSON.parse(init.body).file_id;
      const mode = typeof r.download === "function" ? r.download(r.downloadCount, id, init) : r.download;
      if (mode === "quota") return res(406, { requests: 21, remaining: -1, message: "You have downloaded your allowed 20 subtitles for 24h.", reset_time: "x", reset_time_utc: new Date(r.now + (r.resetIn ?? 3 * 3600e3)).toISOString() });
      if (mode === "invalid") return res(406, { message: "Invalid file_id" });
      if (mode === "401") return res(401, { message: "invalid token" });
      if (mode === "429") return res(429, { message: "Throttle limit reached. Retry later." });
      if (mode === "last") return res(200, { link: LINK(id), file_name: `Paterson-${id}.srt`, requests: 20, remaining: 0, message: "ok", reset_time_utc: new Date(r.now + 3 * 3600e3).toISOString() });
      if (mode === "noremaining") return res(200, { link: LINK(id), file_name: `Paterson-${id}.srt`, message: "ok" }); // (no quota field at all)
      if (mode === "last-noreset") return res(200, { link: LINK(id), file_name: `Paterson-${id}.srt`, remaining: 0, message: "ok" }); // (the quota is spent, and the answer does not say when it comes back)
      if (mode === "500") return res(500, "boom");
      if (mode === "nolink") return res(200, { remaining: 5 });
      if (typeof mode === "string" && mode.startsWith("link:")) return res(200, { link: mode.slice(5), remaining: 5 });
      return res(200, { link: LINK(id), file_name: `Paterson-${id}.srt`, requests: 1, remaining: 20 - r.downloadCount, message: "ok", reset_time_utc: new Date(r.now + 3 * 3600e3).toISOString() });
    }
    if (/^https:\/\/[a-z.]*opensubtitles\.(com|org)\//.test(u) || u.includes("evil.example")) {
      r.fileCalls = (r.fileCalls || 0) + 1;
      if (r.link === "500") return res(500, "no");
      if (r.link === "html") return res(200, "<html><body>Just a moment...</body></html>");
      if (r.link === "empty") return res(200, "  \n");
      if (r.link === "redirect") return u.includes("/hop2/") ? new Response(SRT, { status: 200 }) : res(302, "", { location: u.includes("LINKPART") ? "https://dl.opensubtitles.org/hop2/x.srt" : "/hop2/x.srt" });
      if (r.link === "redirect-evil") return res(302, "", { location: "https://evil.example/steal.srt" });
      if (r.link === "loop") return res(302, "", { location: u });
      if (r.link === "bigheader") return new Response("x", { status: 200, headers: { "content-length": "3000000" } });
      if (r.link === "bigstream") {
        let sent = 0;
        r.streamCancelled = false;
        return new Response(new ReadableStream({ pull(c) { sent++; r.streamChunks = sent; c.enqueue(new Uint8Array(100000).fill(97)); if (sent > 60) c.close(); }, cancel() { r.streamCancelled = true; } }), { status: 200 });
      }
      return new Response(SRT, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    throw new Error(`unexpected ${u}`);
  };
  /** What a platform fetch does: it follows a redirect unless it was told `redirect: "manual"`, and sends the same headers to the new address. */
  r.fetchImpl = async (url, init = {}) => {
    const first = await core(url, init);
    if (first.status >= 300 && first.status < 400 && init.redirect !== "manual") return core(first.headers.get("location"), { ...init, followed: true });
    return first;
  };
  r.caches = { default: {
    match: async (u) => { const v = r.edge.get(u); return v ? new Response(v.text, { headers: { "x-fetched-at": String(v.at) } }) : undefined; },
    put: async (u, response) => { r.edge.set(u, { text: await response.text(), at: Number(response.headers.get("x-fetched-at")) }); },
  } };
  r.kv = kv ? fakeKv(r) : null;
  r.env = { ...ENV, ...(r.kv ? { SUBS: r.kv } : {}) };
  const common = { fetchImpl: r.fetchImpl, now: () => r.now, log: (e) => r.logs.push(e) };
  r.subfiles = (o = {}) => createSubfileSource({ ...common, ...(offeringMs ? { offeringTimeoutMs: offeringMs } : {}), ...o });
  r.subtitles = () => createSubtitleSource({ ...common, caches: r.caches, restTimeoutMs: 50 });
  r.languages = { lookup: async () => ({ language: languageOf, status: "ok" }) };
  r.seen = []; // everything that was answered: status, headers, body
  /** A Worker isolate: its own subfile source and subtitle source (its own memory), the same KV, clock and network. */
  r.isolate = (subfiles = r.subfiles()) => {
    const handle = createHandler({ store: createStore({ fetchImpl: async () => new Response("no", { status: 404 }), caches: undefined, log: () => {} }), subtitles: r.subtitles(), languages: r.languages, subfiles, now: common.now, log: common.log });
    return {
      subfiles,
      get: async (p, env = r.env, method = "GET", headers = {}) => { // `headers`: the request's (the User-Agent decides the names of `lang`, 14/11/2026)
        const response = await handle(new Request("https://w.test" + p, { method, headers }), env, undefined);
        const text = await response.text();
        r.seen.push({ status: response.status, headers: [...response.headers].join("\n"), text });
        return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) };
      },
    };
  };
  const main = r.isolate();
  r.get = main.get;
  r.main = main;
  r.callsTo = (re) => r.calls.filter((c) => re.test(c.url));
  r.downloads = () => r.callsTo(/\/api\/v1\/download$/);
  return r;
}
const SUBS = `/subtitles/movie/tt5247022/videoHash=${HASH}&videoSize=8530919858&filename=${encodeURIComponent(FILE)}.json`;
const PRIVATE = `/k/${TOK}`;
/** What the Worker's answer says in `lang` since 14/11/2026, to every app (a language name of its own, not the code: src/subtitles.js OWN_LANGUAGE_NAMES; test/subtitles.test.js "lang (a)…(device)" holds the rule). */
const OWN = { eng: "English · Mood", pob: "Português (Brasil) · Mood", por: "Português (Portugal) · Mood" };
const rows = (x, lang) => x.json().subtitles.filter((s) => s.lang === OWN[lang]);
/** The address of file `id` as it is listed at the harness's start (valid until `exp`); `sig` replaces the signature, `exp` the expiry. */
const sub = async (id, sig, exp = expiryFor(NOW0)) => `/subfile/${id}/${exp}/${sig ?? (await signFileUntil(TOK, id, exp))}.srt`;
/**
 * The signature of the address WITHOUT an expiry, as the Worker issued it until 13/10/2026 and accepted it until 13/11/2026: the file id alone, under the domain label "v2".
 * The Worker has no code for it since 14/11/2026, so it is written here with node:crypto: the 404s below are the 404s of a PROPERLY signed address of that form, not of a wrong one.
 */
const oldSig = (token, id) => crypto.createHmac("sha256", crypto.createHash("sha256").update(`mood-engine/subfile/v2\0${token}`).digest()).update(String(id)).digest("hex").slice(0, 16);
/** The address without an expiry. */
const subOld = (id, sig) => `/subfile/${id}/${sig ?? oldSig(TOK, id)}.srt`;

// ── which hash-matched results are offered ──────────────────────────────────

test("extraOf: English or Portuguese, not AI- or machine-translated, exactly one file, a plain file id and a legacy id to compare with the official list; anything else is null", () => {
  const a = (o = {}) => hit(5, 77, o).attributes;
  assert.deepEqual(extraOf(a()), { legacy: "5", fileId: "77", lang: "eng", release: "Paterson.2016.1080p.BluRay.x264-AMIABLE" });
  assert.deepEqual(extraOf(a({ language: "pt-BR", release: "" })), { legacy: "5", fileId: "77", lang: "pob", release: "Paterson.2016.1080p.BluRay.x264-AMIABLE" }, "no release: the file name");
  assert.equal(extraOf(a({ language: "pt-PT" })).lang, "por");
  assert.equal(extraOf(a({ language: "pt_br" })).lang, "pob");
  assert.equal(extraOf(a({ ai_translated: false, machine_translated: false })).fileId, "77", "false is not a reason");
  assert.equal(extraOf(a({ ai_translated: null, machine_translated: undefined })).fileId, "77", "absent is not a reason");
  for (const bad of [{ ai_translated: true }, { machine_translated: true }, { language: "fr" }, { language: undefined }, { legacy_subtitle_id: null }, { legacy_subtitle_id: undefined },
    { files: [] }, { files: undefined }, { files: [{ file_id: 1 }, { file_id: 2 }] }, { files: [null] }, { files: [{ file_id: "12a" }] }, { files: [{ file_id: 1234567890123 }] }, { files: [{}] }]) assert.equal(extraOf(a(bad)), null, JSON.stringify(bad));
  assert.equal(extraOf(a({ release: "x".repeat(500) })).release.length, 200);
});

test("exact: the extras come with the ids from the same search (one request, cached 24 hours); an entry an older version left (a plain list of ids) and a damaged one are read safely", async () => {
  const r = harness();
  const s = r.subtitles();
  const got = await s.exact(ENV, "movie", "tt5247022", HASH);
  assert.deepEqual([...got.ids].sort(), ["6926336", "6926794", "9999001", "9999002", "9999003", "9999004", "9999005", "9999006", "9999010"], "every hash match with a legacy id (the exact tier of the OFFICIAL list); not the one with moviehash_match false, not the one with no legacy id");
  assert.deepEqual(got.extras.map((e) => [e.fileId, e.lang]), [["111", "eng"], ["112", "pob"], ["7001", "eng"], ["7002", "pob"], ["7010", "por"]], "in the order of the answer; the official ones are removed later, by the handler");
  await s.exact(ENV, "movie", "tt5247022", HASH);
  assert.equal(r.callsTo(/api\.opensubtitles\.com\/api\/v1\/subtitles/).length, 1, "cached");
  assert.deepEqual((await r.subtitles().exact(ENV, "movie", "tt5247022", HASH)).extras.length, 5, "from the Cache API on another isolate, extras included");
  const old = harness();
  const key = `https://cache.mood-engine.invalid/${encodeURIComponent(`exact2:${HASH}:tt5247022`)}`;
  old.edge.set(key, { text: JSON.stringify(["6926336", "6926794"]), at: old.now });
  const fromOld = await old.subtitles().exact(ENV, "movie", "tt5247022", HASH);
  assert.deepEqual([[...fromOld.ids], fromOld.extras], [["6926336", "6926794"], []]);
  assert.equal(old.callsTo(/api\.opensubtitles\.com/).length, 0);
  const damaged = harness();
  damaged.edge.set(key, { text: JSON.stringify({ ids: ["1"], extras: [{ fileId: "abc", lang: "eng", legacy: "1" }, { fileId: "5", lang: "fra", legacy: "1" }, { fileId: "6", lang: "eng" }, null, "x", { fileId: "8", lang: "pob", legacy: 9, release: "ok" }] }), at: damaged.now });
  assert.deepEqual((await damaged.subtitles().exact(ENV, "movie", "tt5247022", HASH)).extras, [{ legacy: "9", fileId: "8", lang: "pob", release: "ok" }]);
});

test("restBaseOf: the key, the user name, the password and the token only ever go to OpenSubtitles' own API host; a setting that points elsewhere is ignored and logged", () => {
  const logs = [];
  const log = (e) => logs.push(e);
  assert.equal(restBaseOf({}, log), "https://api.opensubtitles.com/api/v1");
  assert.equal(restBaseOf({ OPENSUBTITLES_REST: "https://api.opensubtitles.com/api/v1/" }, log), "https://api.opensubtitles.com/api/v1");
  assert.equal(restBaseOf({ OPENSUBTITLES_REST: "https://vip-api.opensubtitles.com/anything" }, log), "https://vip-api.opensubtitles.com/api/v1");
  assert.deepEqual(logs, []);
  for (const bad of ["https://evil.example/api/v1", "http://api.opensubtitles.com/api/v1", "https://api.opensubtitles.com.evil.example/api/v1", "https://user:pw@api.opensubtitles.com/api/v1", "https://api.opensubtitles.com:8443/api/v1", "https://www.opensubtitles.com/api/v1", "not an address", "//api.opensubtitles.com"]) {
    assert.equal(restBaseOf({ OPENSUBTITLES_REST: bad }, log), "https://api.opensubtitles.com/api/v1", bad);
  }
  assert.equal(logs.length, 8);
  assert.ok(logs.every((l) => l.event === "opensubtitles-rest-setting-ignored" && Object.keys(l).length === 1), "logged without the address");
});

test("the hash search and the login go to OpenSubtitles' API even when OPENSUBTITLES_REST points at a host that is not (the key and the credentials are never sent there)", async () => {
  const r = harness();
  const env = { ...r.env, OPENSUBTITLES_REST: "https://evil.example/api/v1" };
  await r.get(SUBS, env);
  await r.get(await sub("7001"), env);
  assert.ok(r.calls.length > 0 && r.calls.every((c) => !c.url.includes("evil.example")), r.calls.map((c) => c.url).join("\n"));
  assert.ok(r.logs.some((l) => l.event === "opensubtitles-rest-setting-ignored"));
});

// ── the private address ──────────────────────────────────────────────────────

/** A handler over the fixture's index, to compare an address with and without the prefix. */
function indexApp(env) {
  const files = makeFiles();
  const DIR = "https://pages.test/data/";
  const r = harness();
  const fetchImpl = async (url, init) => (String(url).startsWith(DIR) ? new Response(files[String(url).slice(DIR.length)] || "no", { status: files[String(url).slice(DIR.length)] ? 200 : 404 }) : r.fetchImpl(url, init));
  const handle = createHandler({ store: createStore({ fetchImpl, caches: undefined, log: () => {} }), subtitles: r.subtitles(), languages: r.languages, subfiles: r.subfiles(), log: () => {} });
  const get = async (p, method = "GET") => { const x = await handle(new Request("https://w.test" + p, { method }), { INDEX_URL: `${DIR}index.json`, ...env }, undefined); return { status: x.status, text: await x.text(), headers: x.headers }; };
  return { get, r };
}

test("/k/<token>/ in front of any path is served exactly like the path without it — the manifest byte for byte, a catalog, a profile, a profile's catalog, subtitles, the series row, a 404", async () => {
  const { get } = indexApp(ENV);
  const plainManifest = await get("/manifest.json");
  assert.equal(plainManifest.status, 200);
  const manifest = JSON.parse(plainManifest.text);
  const cat = manifest.catalogs.find((c) => !(c.extra || []).some((e) => e.isRequired)) || manifest.catalogs[0];
  const paths = ["/manifest.json", `/catalog/${cat.type}/${cat.id}.json`, "/p/marco/manifest.json", "/p/night/manifest.json", `/p/marco/catalog/${cat.type}/${cat.id}.json`, "/catalog/series/my-series.json", "/p/nobody/manifest.json", "/nothing-here", `/subtitles/movie/tt0000001/filename=${encodeURIComponent(FILE)}.json`];
  for (const p of paths) {
    const a = await get(p), b = await get(PRIVATE + p);
    assert.equal(b.status, a.status, p);
    const publicBody = JSON.parse(a.text), privateBody = JSON.parse(b.text);
    if (privateBody.metas?.some(m => m.type === "movie")) {
      for (const m of privateBody.metas) if (m.type === "movie") { assert.equal(m.behaviorHints?.defaultVideoId, m.id); delete m.behaviorHints.defaultVideoId; if (!Object.keys(m.behaviorHints).length) delete m.behaviorHints; }
      assert.deepEqual(privateBody, publicBody, `${p}: only defaultVideoId differs`);
    } else assert.equal(b.text, a.text, `${p}: the same bytes`);
    for (const h of ["content-type", "access-control-allow-origin"]) assert.equal(b.headers.get(h), a.headers.get(h), `${p}: ${h}`);
    const cc = a.headers.get("cache-control");
    assert.equal(b.headers.get("cache-control"), cc ? cc.replace(/^public/, "private") : "private", `${p}: private for every cache`);
    assert.equal(b.headers.get("referrer-policy"), "no-referrer", `${p}: no Referer`);
    assert.equal(a.headers.get("referrer-policy"), null, `${p}: the public address is as it was`);
    assert.ok(!(cc || "").startsWith("private"), p);
  }
  assert.equal((await get(PRIVATE + "/manifest.json")).text, plainManifest.text, "the manifest is byte for byte the public one");
  const home = await get(PRIVATE + "/");
  assert.match(home.text, new RegExp(`stremio://w\\.test/k/${TOK}/manifest\\.json`), "the install page of the private address points at the private manifest");
  assert.match((await get(PRIVATE)).text, /Install in Stremio/, "the bare prefix is the home page too");
  assert.match((await get(`${PRIVATE}/p/night/`)).text, new RegExp(`stremio://w\\.test/k/${TOK}/p/night/manifest\\.json`));
  assert.doesNotMatch((await get("/")).text, /\/k\//, "the public install page does not know the token");
  assert.equal((await get(PRIVATE + "/manifest.json", "HEAD")).text, "", "HEAD still has no body");
});

test("/k/: a wrong, absent, short, long or odd token is a 404 — also when no SUBTITLES_PRIVATE_TOKEN is set — and the 404 says nothing about why", async () => {
  const { get } = indexApp(ENV);
  const last = TOK.slice(0, -1) + (TOK.endsWith("0") ? "1" : "0");
  for (const p of [`/k/${last}/manifest.json`, "/k/manifest.json", "/k/", "/k", `/k/${TOK.slice(0, 20)}/manifest.json`, `/k/${TOK}0/manifest.json`, `/k/${TOK.toUpperCase()}/manifest.json`, `/k/${TOK}%2f..%2fmanifest.json`, "/k/short/manifest.json", `/k//manifest.json`, `/kx/${TOK}/manifest.json`]) {
    const x = await get(p);
    assert.equal(x.status, 404, p);
    assert.deepEqual(JSON.parse(x.text), { err: "not found" }, p);
  }
  const none = indexApp({ ...ENV, SUBTITLES_PRIVATE_TOKEN: undefined });
  for (const p of [`/k/${TOK}/manifest.json`, "/k/undefined/manifest.json", "/k/0000000000000000/manifest.json"]) assert.equal((await none.get(p)).status, 404, `no token set: ${p}`);
  const blank = indexApp({ ...ENV, SUBTITLES_PRIVATE_TOKEN: "" });
  assert.equal((await blank.get("/k//manifest.json")).status, 404);
  assert.equal((await get("/manifest.json")).status, 200, "the public address is untouched");
});

test("sameSecret: equal secrets match; a different one, a different length, a prefix, empty or not text do not", async () => {
  assert.equal(await sameSecret(TOK, TOK), true);
  assert.equal(await sameSecret(TOK, TOK.slice(0, -1) + "x"), false);
  assert.equal(await sameSecret(TOK, TOK + "x"), false);
  assert.equal(await sameSecret(TOK, TOK.slice(0, 10)), false);
  for (const bad of ["", undefined, null, 5]) { assert.equal(await sameSecret(TOK, bad), false); assert.equal(await sameSecret(bad, TOK), false); assert.equal(await sameSecret(bad, bad), false); }
});

// ── the rows in /subtitles ───────────────────────────────────────────────────

test("/subtitles on the PUBLIC address: never an extra row, never a /subfile address, never the header — whatever the secrets and the search found", async () => {
  const none = harness();
  const base = (await none.get(SUBS, { OPENSUBTITLES_API_KEY: APIKEY })).json();
  const r = harness();
  const pub = await r.get(SUBS);
  assert.deepEqual(pub.json(), base, "with every secret set, the public answer is the one without them");
  assert.ok(pub.json().subtitles.every((s) => !s.id.startsWith("moodsubs-os") && !s.url.includes("/subfile/")));
  assert.equal(pub.headers.get("x-subtitles-extras"), null);
  assert.equal(pub.headers.get("cache-control"), "public, max-age=3600");
  assert.equal(r.calls.filter((c) => c.url.includes("/subfile/")).length, 0);
});

test("/subtitles under the private address without the account's secrets (or without any of the four): nothing changes, no header", async () => {
  const none = harness();
  const base = (await none.get(PRIVATE + SUBS, { ...none.env, OPENSUBTITLES_USERNAME: "" })).json(); // (private: the public address makes no hash search since W4, so it has no exact tier to compare with)
  for (const drop of ["OPENSUBTITLES_USERNAME", "OPENSUBTITLES_PASSWORD", "OPENSUBTITLES_API_KEY"]) {
    const x = harness();
    const got = await x.get(PRIVATE + SUBS, { ...x.env, [drop]: "" });
    assert.ok(got.json().subtitles.every((s) => !s.id.startsWith("moodsubs-os")), drop);
    assert.equal(got.headers.get("x-subtitles-extras"), null, drop);
    if (drop !== "OPENSUBTITLES_API_KEY") assert.deepEqual(got.json(), base, drop);
  }
  assert.equal(subfileConfigured(ENV), true);
  for (const drop of ["OPENSUBTITLES_USERNAME", "OPENSUBTITLES_PASSWORD", "OPENSUBTITLES_API_KEY", "SUBTITLES_PRIVATE_TOKEN"]) assert.equal(subfileConfigured({ ...ENV, [drop]: "" }), false, drop);
});

test("/subtitles under the private address: the hash-matched subtitles the official list lacks join the exact tier after the official exact ones and BEFORE the same-release ones, labelled with language, position, match mark and release details, with a signed address and the stable id moodsubs-os<file_id>", async () => {
  const r = harness();
  const x = await r.get(PRIVATE + SUBS);
  assert.equal(x.status, 200);
  assert.equal(x.headers.get("x-subtitles-extras"), "3");
  assert.equal(x.headers.get("cache-control"), "private, max-age=3600");
  const eng = rows(x, "eng"), pob = rows(x, "pob"), por = rows(x, "por");
  assert.deepEqual(eng.slice(0, 3).map((s) => s.id), ["moodsubs-6926336", "moodsubs-os7001", "moodsubs-6926279"], "official exact, then the extra, then the same-release ones: an app that takes the first row of its language still gets an official exact one (since the code of 14/11/2026 every row is under a language name instead of the code, for every app: the test below, \"extras: every app gets them under the names\"; that an app then picks none of them by itself is expected, not verified)");
  assert.deepEqual(eng.slice(0, 3).map((s) => s.label), ["English 1 ✓ · BluRay · AMIABLE", "English 2 ✓ · BluRay · AMIABLE", "English 3 ≈ · BluRay · AMIABLE"]);
  assert.deepEqual(pob.slice(0, 2).map((s) => s.id), ["moodsubs-6926794", "moodsubs-os7002"]);
  assert.equal(por[0].id, "moodsubs-os7010", "no official exact Portuguese (PT) subtitle: the extra leads its language");
  assert.deepEqual(eng[1], { id: "moodsubs-os7001", lang: OWN.eng, label: "English 2 ✓ · BluRay · AMIABLE", url: `https://w.test${await sub("7001")}` });
  assert.equal(pob[1].label, "PT-BR 2 ✓ · BluRay · AMIABLE", "the extra with no release name is labelled like any exact one");
  assert.equal(por[0].label, "PT-PT 1 ✓ · BluRay · AMIABLE");
  assert.ok(!eng[1].url.includes("/k/"), "the address of a row does not carry the private token");
  const ids = x.json().subtitles.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "no subtitle twice");
  for (const left of ["7003", "7004", "7005", "7006", "7007", "7008", "7009", "111", "112"]) assert.ok(!ids.includes(`moodsubs-os${left}`), `${left} is left out`);
  const everything = JSON.stringify(x.json());
  for (const secret of [PASS, USER, APIKEY, TOK]) assert.ok(!everything.includes(secret), "a secret is in the rows");
  const again = await r.get(PRIVATE + SUBS);
  assert.deepEqual(again.json(), x.json(), "the same file asked again gets the same rows and ids (stremio-web keeps the first entry per id)");
  assert.equal(r.callsTo(/api\.opensubtitles\.com\/api\/v1\/subtitles/).length, 1, "one search for both requests");
});

test("the signature comes from SUBTITLES_PRIVATE_TOKEN and from nothing else: the OpenSubtitles password changes nothing, another token changes every address, and a row signed with the password is refused", async () => {
  const r = harness();
  const url = (x) => rows(x, "eng")[1].url;
  assert.match(url(await r.get(PRIVATE + SUBS)), /^https:\/\/w\.test\/subfile\/7001\/\d{10}\/[0-9a-f]{16}\.srt$/, "the address a row carries has an expiry");
  const a = await r.get(PRIVATE + SUBS);
  const b = await r.get(PRIVATE + SUBS, { ...r.env, OPENSUBTITLES_PASSWORD: "a different password", OPENSUBTITLES_USERNAME: "someone else" });
  assert.equal(url(b), url(a), "the account's password is not part of the signature");
  const other = "fedcba9876543210fedcba9876543210fedcba9876543210";
  const bad = await r.get(subOld("7001", oldSig(PASS, "7001")));
  assert.equal(bad.status, 404, "signed with the password (the address without an expiry)");
  const exp = expiryFor(r.now);
  assert.equal((await r.get(await sub("7001", await signFileUntil(PASS, "7001", exp)))).status, 404, "signed with the password (the form with an expiry)");
  const independent3 = (token, id, until) => crypto.createHmac("sha256", crypto.createHash("sha256").update(`mood-engine/subfile/v3\0${token}`).digest()).update(`${id}\n${until}`).digest("hex").slice(0, 16);
  assert.equal(await signFileUntil(TOK, "7001", exp), independent3(TOK, "7001", exp), "HMAC-SHA256 of `file id, a line break, expiry`, keyed by SHA-256 of the v3 domain label and the private token: written down here with node:crypto");
  assert.match(await signFileUntil(TOK, "7001", exp), /^[0-9a-f]{16}$/);
  assert.equal(await signFileUntil(TOK, 7001, exp), await signFileUntil(TOK, "7001", String(exp)), "a number or a string");
  assert.notEqual(await signFileUntil(TOK, "7001", exp), oldSig(TOK, "7001"), "not the signature of the address without an expiry: another domain, another message");
  assert.notEqual(await signFileUntil(TOK, "7001", exp), await signFileUntil(TOK, "7001", exp + 86400), "the expiry is part of what is signed");
  assert.notEqual(await signFileUntil(TOK, "7001", exp), await signFileUntil(TOK, "7002", exp));
  assert.notEqual(await signFileUntil(other, "7001", exp), await signFileUntil(TOK, "7001", exp), "another token, another address");
  assert.equal(r.callsTo(/\/api\/v1\/(login|download)$/).length, 0);
});

// 14/11/2026 (Marco, "All devices, as first approved"; test/subtitles.test.js "lang (a)…(device)" holds the rule): `lang` is a language name of the addon's own for every app.
// The rows this file is about (the subtitles the official list lacks, with an address of this Worker) follow the same rule as the official ones: they are in the same groups, and nothing else of them moves.
test("/subtitles extras: every app gets them under the names — asked as the Samsung TV, as Android TV or with no User-Agent, in any order, the extra rows say the language's own name like the official ones beside them, the answers are byte for byte the same, and the address opens for all", async () => {
  const APPS = { tv: { "User-Agent": "Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) 69.0.3497.106/5.0 TV Safari/537.36" }, android: { "User-Agent": "Mozilla/5.0 (Linux; Android 12; 55C6K) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36" }, none: {} };
  for (const order of [["tv", "android", "none"], ["none", "android", "tv"]]) {
    const r = harness();
    const got = {};
    for (const who of order) got[who] = await r.get(PRIVATE + SUBS, r.env, "GET", APPS[who]);
    const extras = (x) => x.json().subtitles.filter((s) => s.id.startsWith("moodsubs-os"));
    for (const who of order) {
      assert.deepEqual(extras(got[who]).map((s) => [s.id, s.lang]), [["moodsubs-os7001", OWN.eng], ["moodsubs-os7002", OWN.pob], ["moodsubs-os7010", OWN.por]], `${order}, ${who}: the three extras under the names`);
      assert.deepEqual([...new Set(got[who].json().subtitles.map((s) => s.lang))], [OWN.eng, OWN.pob, OWN.por], `${who}: the official rows and the extras are in the same three groups`);
      assert.equal(got[who].text, got[order[0]].text, `${who}: byte for byte the answer the first app got`);
      assert.equal(got[who].headers.get("vary"), null, `${who}: the answer does not depend on the app`);
      assert.equal(got[who].headers.get("cache-control"), "private, max-age=3600");
      assert.equal(got[who].headers.get("x-subtitles-extras"), "3");
    }
    // the rows with the names turned back into codes are what the Worker answered before 14/11/2026: ids, signed addresses, labels and order untouched
    const coded = got.tv.json().subtitles.map((s) => ({ ...s, lang: Object.keys(OWN).find((k) => OWN[k] === s.lang) }));
    assert.deepEqual(coded.filter((s) => s.id.startsWith("moodsubs-os")).map((s) => [s.id, s.lang, s.label]), [["moodsubs-os7001", "eng", "English 2 ✓ · BluRay · AMIABLE"], ["moodsubs-os7002", "pob", "PT-BR 2 ✓ · BluRay · AMIABLE"], ["moodsubs-os7010", "por", coded.find((s) => s.id === "moodsubs-os7010").label]]);
    const link = pathOf(extras(got.tv)[0].url);
    for (const who of order) assert.equal((await r.get(link, r.env, "GET", APPS[who])).status, 200, `${who}: the address of an extra row opens`);
  }
});

test("/subtitles extras: the 15 a language cap holds, the film's language decides which languages they join", async () => {
  const many = Array.from({ length: 20 }, (_, i) => hit(9100000 + i, 8000 + i));
  const r = harness({ search: [hit(6926336, 111), ...many] });
  const eng = rows(await r.get(PRIVATE + SUBS), "eng");
  assert.equal(eng.length, 15);
  assert.equal(eng[0].id, "moodsubs-6926336");
  assert.ok(eng.slice(1).every((s, i) => s.id.startsWith("moodsubs-os80") && s.label === `English ${i + 2} ✓ · BluRay · AMIABLE`), "14 extras behind the official exact one");
  const sv = harness({ languageOf: "other" });
  const svRows = (await sv.get(PRIVATE + SUBS)).json().subtitles;
  assert.deepEqual([...new Set(svRows.map((s) => s.lang))], [OWN.eng], "a film in another language: English only, the Portuguese extras are not offered");
  assert.deepEqual(svRows.slice(0, 2).map((s) => s.id), ["moodsubs-6926336", "moodsubs-os7001"]);
  const pt = harness({ languageOf: "pt" });
  const ptRows = (await pt.get(PRIVATE + SUBS)).json().subtitles;
  assert.deepEqual(ptRows.slice(0, 2).map((s) => s.id), ["moodsubs-6926794", "moodsubs-os7002"], "a Portuguese film: Português (BR) first, its extra right after the official exact one");
  assert.deepEqual([...new Set(ptRows.map((s) => s.lang))], [OWN.pob, OWN.por, OWN.eng]);
  const nonsense = harness();
  nonsense.search = "not an array";
  const plain = await nonsense.get(PRIVATE + SUBS);
  assert.equal(plain.status, 200, "a search that is nonsense gives the official list alone");
  assert.ok(plain.json().subtitles.length > 20);
});

test("/subtitles extras are not listed while the quota is out, the login is being waited out, or the last 3 downloads failed — the answer then is the official list, marked, and remembered 5 minutes, not an hour", async () => {
  const ok = harness();
  const listed = await ok.get(PRIVATE + SUBS);
  assert.equal(listed.headers.get("x-subtitles-extras"), "3");

  const q = harness({ download: "quota" });
  assert.equal((await q.get(await sub("7001"))).headers.get("x-subfile"), "quota");
  const noRows = await q.get(PRIVATE + SUBS);
  assert.equal(noRows.headers.get("x-subtitles-extras"), "off-quota");
  assert.equal(noRows.headers.get("cache-control"), "private, max-age=300");
  assert.equal(noRows.json().cacheMaxAge, 300);
  assert.ok(noRows.json().subtitles.every((s) => !s.id.startsWith("moodsubs-os")));
  assert.deepEqual(noRows.json().subtitles.map((s) => s.id), listed.json().subtitles.filter((s) => !s.id.startsWith("moodsubs-os")).map((s) => s.id), "the official rows, in the same order as the listing that had the extras");
  q.now += 3 * 3600e3 + 1;
  assert.equal((await q.get(PRIVATE + SUBS)).headers.get("x-subtitles-extras"), "3", "the quota is back: the rows are back");

  const l = harness({ login: "401" });
  await l.get(await sub("7001"));
  const paused = await l.get(PRIVATE + SUBS);
  assert.equal(paused.headers.get("x-subtitles-extras"), "off-login-paused");
  assert.equal(paused.headers.get("cache-control"), "private, max-age=300");
  l.now += LOGIN_BACKOFF_MS + 1;
  assert.equal((await l.get(PRIVATE + SUBS)).headers.get("x-subtitles-extras"), "3");

  const f = harness({ download: "500" });
  for (const id of ["7001", "7002"]) await f.get(await sub(id));
  assert.equal((await f.get(PRIVATE + SUBS)).headers.get("x-subtitles-extras"), "3", "two failures are not three");
  await f.get(await sub("7010"));
  const failing = await f.get(PRIVATE + SUBS);
  assert.equal(failing.headers.get("x-subtitles-extras"), "off-failing");
  assert.equal((await f.isolate().get(PRIVATE + SUBS)).headers.get("x-subtitles-extras"), "off-failing", "a cold isolate reads the count from KV");
  assert.equal(failing.headers.get("cache-control"), "private, max-age=300");
  f.download = "ok";
  const asked = f.calls.length;
  const held = await f.get(await sub("7011"));
  assert.deepEqual([held.status, held.headers.get("x-subfile")], [502, "busy"], "since 19/10/2026 a row opened while the run of failures stands is refused too (before: it was tried, and a success cleared the run)");
  assert.equal(f.calls.length, asked, "and OpenSubtitles is not asked (the security review: a hammered address cost a call and a KV write each)");
  f.now += 61 * 60e3; // the run is forgotten after an hour without news: it is tried again
  assert.equal((await f.get(await sub("7011"))).status, 200, "after the hour the row opens");
  assert.equal((await f.get(PRIVATE + SUBS)).headers.get("x-subtitles-extras"), "3", "a success clears the run of failures");
  const g = harness({ download: "500" });
  for (const id of ["7001", "7002", "7010"]) await g.get(await sub(id));
  g.now += 61 * 60e3;
  assert.equal((await g.get(PRIVATE + SUBS)).headers.get("x-subtitles-extras"), "3", "a run of failures is forgotten after an hour");

  const nothing = harness({ download: "quota", search: [hit(6926336, 111)] });
  await nothing.get(await sub("7001"));
  const same = await nothing.get(PRIVATE + SUBS);
  assert.equal(same.headers.get("x-subtitles-extras"), "0", "no extra row to hide: nothing is degraded");
  assert.equal(same.headers.get("cache-control"), "private, max-age=3600");
});

test("the state is shared through KV: another isolate sees the quota out, the paused login and the failures; without the KV binding each isolate knows only its own", async () => {
  const r = harness({ download: "quota" });
  await r.get(await sub("7001"));
  const other = r.isolate();
  assert.equal((await other.get(PRIVATE + SUBS)).headers.get("x-subtitles-extras"), "off-quota", "a cold isolate learns it from KV");
  const calls = r.downloads().length;
  assert.equal((await other.get(await sub("7002"))).headers.get("x-subfile"), "quota");
  assert.equal(r.downloads().length, calls, "and does not ask OpenSubtitles");
  assert.ok(r.kv._m.has(KEYS.quota));

  const bare = harness({ download: "quota", kv: false });
  await bare.get(await sub("7001"));
  assert.equal((await bare.get(PRIVATE + SUBS)).headers.get("x-subtitles-extras"), "off-quota", "the same isolate remembers");
  assert.equal((await bare.isolate().get(PRIVATE + SUBS)).headers.get("x-subtitles-extras"), "3", "a cold isolate without KV does not");

  const down = harness();
  down.kvDown = true;
  const x = await down.get(await sub("7001"));
  assert.equal(x.status, 200, "KV failing never fails a download: memory carries on");
  assert.equal(x.text, SRT);
  assert.ok(down.logs.some((l) => l.event === "subs-kv-failed"));
  assert.ok(down.logs.filter((l) => l.event === "subs-kv-failed").every((l) => Object.keys(l).sort().join() === "event,op,what"), "the log names the operation, never the key or the value");
});

test("an error while the rows are being added is logged and leaves the official list, marked and short-lived — never a failed answer", async () => {
  const r = harness();
  const broken = { offering: async () => { throw new Error("boom"); }, fetchSubtitle: async () => ({ ok: false, reason: "failed" }) };
  const iso = r.isolate(broken);
  const x = await iso.get(PRIVATE + SUBS);
  assert.equal(x.status, 200);
  assert.equal(x.headers.get("x-subtitles-extras"), "off-error");
  assert.equal(x.headers.get("cache-control"), "private, max-age=300");
  assert.ok(x.json().subtitles.length > 20 && x.json().subtitles.every((s) => !s.id.startsWith("moodsubs-os")));
  assert.deepEqual(r.logs.filter((l) => l.event === "subtitles-extras-failed"), [{ event: "subtitles-extras-failed", error: "Error: boom" }]);
});

// ── GET /subfile ─────────────────────────────────────────────────────────────

test("the shape of the address: /subfile/<file id>/<10-digit expiry>/<16 hex digits>.srt and nothing else; without the expiry it is not a subtitle address", async () => {
  const sig = await signFileUntil(TOK, "7001", 1795000000);
  assert.deepEqual(SUBFILE_PATH.exec(`/subfile/7001/1795000000/${sig}.srt`).slice(1), ["7001", "1795000000", sig], "file id, expiry, signature");
  assert.equal(SUBFILE_PATH.exec(`/subfile/7001/1795000000/${sig}.srt`).length, 4, "three groups, all of them always there");
  assert.equal(SUBFILE_PATH.exec(`/subfile/7001/${sig}.srt`), null, "the address without an expiry (accepted until 13/11/2026) does not match");
  assert.equal(SUBFILE_PATH.exec(subOld("7001")), null, "nor does one properly signed as that form was");
  for (const id of ["70x1", "7001%2F", "7001%2F1795000000", "-7001", "7001.5", "0x7001", "", " 7001", "1234567890123"]) assert.equal(SUBFILE_PATH.test(`/subfile/${id}/1795000000/${sig}.srt`), false, `a file id that is not 1 to 12 digits: ${JSON.stringify(id)}`);
  for (const bad of ["/subfile/7001/179500000/" + sig + ".srt", "/subfile/7001/17950000000/" + sig + ".srt", "/subfile/7001/179500000x/" + sig + ".srt", `/subfile/7001/1795000000/${sig}.srt/x`, `/subfile/7001/1795000000/1795000000/${sig}.srt`]) assert.ok(!SUBFILE_PATH.test(bad), bad);
  for (const bad of ["/subfile/7001/ZZZZZZZZZZZZZZZZ.srt", "/subfile/70x1/0123456789abcdef.srt", "/subfile/7001/0123456789abcde.srt", "/subfile/7001/0123456789abcdef.srt/x", "/subfile//0123456789abcdef.srt", "/subfile/1234567890123/0123456789abcdef.srt"]) assert.ok(!SUBFILE_PATH.test(bad), bad);
});

// ── the address expires (W6, 13/10/2026: /subfile/<file_id>/<sig>.srt signed the file id alone and was valid for ever on the public host) ──

const DAY = 24 * 3600e3;
const pathOf = (u) => new URL(u).pathname;

test("expiryFor: 30 days from the moment, rounded up to the day, in epoch seconds with 10 digits; the same all day, the next day's one day later", () => {
  assert.equal(FILE_TTL_MS, 30 * DAY, "the days the subtitle is kept in KV");
  const midnight = Date.UTC(2026, 9, 13);
  for (const at of [midnight, midnight + 1, midnight + 12 * 3600e3, midnight + DAY - 1]) {
    const exp = expiryFor(at);
    assert.match(String(exp), /^\d{10}$/);
    assert.equal(exp % 86400, 0, "a whole day");
    assert.ok(exp * 1000 >= at + FILE_TTL_MS, "at least 30 days");
    assert.ok(exp * 1000 < at + FILE_TTL_MS + DAY, "less than 31");
  }
  assert.equal(expiryFor(midnight + 1), expiryFor(midnight + DAY - 1), "stable within the day (a cache can keep the address)");
  assert.equal(expiryFor(midnight + DAY + 1), expiryFor(midnight + 1) + 86400, "and one day later the next day");
  assert.equal(expiryFor(midnight), (midnight + FILE_TTL_MS) / 1000, "exactly on the day boundary it is not pushed a day further");
});

test("the row's address carries the expiry: /subfile/<file_id>/<exp>/<sig>.srt, the same for every row and all day long, a day later the next day's; the earlier form is never issued", async () => {
  const r = harness();
  const a = await r.get(PRIVATE + SUBS);
  const urls = a.json().subtitles.filter((s) => s.url.includes("/subfile/"));
  assert.deepEqual(urls.map((s) => s.id), ["moodsubs-os7001", "moodsubs-os7002", "moodsubs-os7010"], "the three extras of the search");
  const exp = expiryFor(r.now);
  for (const x of urls) {
    const id = /^moodsubs-os(\d+)$/.exec(x.id)[1];
    assert.equal(x.url, `https://w.test/subfile/${id}/${exp}/${await signFileUntil(TOK, id, exp)}.srt`, x.id);
    assert.ok(SUBFILE_PATH.test(pathOf(x.url)));
  }
  r.now += 3 * 3600e3; // later the same UTC day (12:00 + 3 h)
  const later = await r.isolate().get(PRIVATE + SUBS);
  assert.deepEqual(rows(later, "eng").map((s) => s.url), rows(a, "eng").map((s) => s.url), "the same addresses all day (the listing is cached for an hour: a different address would be a different row)");
  r.now += DAY;
  const next = await r.isolate().get(PRIVATE + SUBS);
  assert.equal(rows(next, "eng")[1].url, `https://w.test/subfile/7001/${exp + 86400}/${await signFileUntil(TOK, "7001", exp + 86400)}.srt`, "a day later: one day further");
});

test("GET /subfile: the address listed today answers 200, the same address 31 days later is a 404 that asks OpenSubtitles nothing; it is good up to the last second of its expiry and not after", async () => {
  const r = harness();
  const link = pathOf(rows(await r.get(PRIVATE + SUBS), "eng")[1].url);
  const exp = Number(/\/subfile\/7001\/(\d{10})\//.exec(link)[1]);
  const ok = await r.get(link);
  assert.equal(ok.status, 200);
  assert.equal(ok.text, SRT);
  r.now = exp * 1000 - 1;
  assert.equal((await r.get(link)).status, 200, "one millisecond before the expiry");
  r.now = exp * 1000;
  const calls = r.calls.length;
  const at = await r.get(link);
  assert.equal(at.status, 404, "at the expiry");
  assert.deepEqual(at.json(), { err: "not found" });
  assert.equal((await r.get(link, r.env, "HEAD")).status, 404, "HEAD too");
  r.now = NOW0 + 31 * DAY;
  assert.equal((await r.get(link)).status, 404, "31 days after it was listed");
  assert.equal(r.calls.length, calls, "not one call to OpenSubtitles, and the subtitle still kept is not served either");
  assert.ok(r.kv._m.has(KEYS.srt("7001")), "(control: the subtitle IS kept; an expired address does not reach it)");
});

test("the signing key follows the token: two tokens used in turn each give HMAC-SHA256 under the v3 domain label, computed here with node:crypto (the key is kept between calls, per token)", async () => {
  const hmac = (token, message) => crypto.createHmac("sha256", crypto.createHash("sha256").update(`mood-engine/subfile/v3\0${token}`).digest()).update(message).digest("hex").slice(0, 16);
  const exp = expiryFor(NOW0);
  // tokens this process has not used yet, so that the kept key starts cold for them
  const t1 = crypto.randomBytes(24).toString("hex"), t2 = crypto.randomBytes(24).toString("hex");
  assert.equal(await signFileUntil(t1, "7001", exp), hmac(t1, `7001\n${exp}`));
  assert.equal(await signFileUntil(t2, "7002", exp), hmac(t2, `7002\n${exp}`), "another token right after: its own key, not the kept one");
  assert.equal(await signFileUntil(t1, "7001", exp), hmac(t1, `7001\n${exp}`), "and the first one again");
  assert.equal(await verifyUntil(t1, "7001", exp, hmac(t1, `7001\n${exp}`), NOW0), true);
  assert.equal(await verifyUntil(t2, "7001", exp, hmac(t1, `7001\n${exp}`), NOW0), false);
});

test("GET /subfile: the expiry is signed (a later one with the old signature is a 404), an expired address with its own valid signature is a 404, the signature of the address without an expiry put under an expiry is a 404, and so is the reverse", async () => {
  const r = harness();
  const exp = expiryFor(r.now);
  const sig = await signFileUntil(TOK, "7001", exp);
  assert.equal((await r.get(await sub("7001"))).status, 200, "control: the good address");
  assert.equal((await r.get(await sub("7001", sig, exp + 86400))).status, 404, "a later expiry, the old signature");
  assert.equal((await r.get(await sub("7001", sig, exp - 86400))).status, 404, "an earlier expiry, the old signature");
  const past = Math.floor(r.now / 1000) - 3600;
  assert.equal((await r.get(await sub("7001", await signFileUntil(TOK, "7001", past), past))).status, 404, "an expiry in the past, signed properly");
  assert.equal((await r.get(await sub("7001", oldSig(TOK, "7001")))).status, 404, "the signature of the address without an expiry, reused under an expiry");
  assert.equal((await r.get(`/subfile/7001/${sig}.srt`)).status, 404, "this address's signature with the expiry left out of the path");
  assert.equal((await r.get(await sub("7002", sig))).status, 404, "another file with that signature");
  for (const p of [`/subfile/7001/${exp}0/${sig}.srt`, `/subfile/7001/${String(exp).slice(1)}/${sig}.srt`, `/subfile/7001/${exp}/${sig}/x.srt`, `/subfile/7001/-${String(exp).slice(1)}/${sig}.srt`, `/subfile/7001/${exp}.5/${sig}.srt`]) assert.equal((await r.get(p)).status, 404, p);
  assert.equal(r.downloads().length, 1, "only the good address downloaded anything");
});

test("GET /subfile: the address without an expiry (/subfile/<file_id>/<sig>.srt, accepted until 13/11/2026) is a 404 at any moment, properly signed and with the subtitle kept, and asks OpenSubtitles nothing; the address with an expiry opens at those same moments; the code of the old form is gone", async () => {
  const LIMIT = Date.parse("2026-11-13T00:00:00Z"); // until this moment the Worker accepted the address without an expiry (V2_ACCEPT_UNTIL, removed on 14/11/2026)
  const moments = [["the day after the address with an expiry was written", NOW0 + DAY], ["one millisecond before the old limit", LIMIT - 1], ["at the old limit", LIMIT], ["14/11/2026, when the code was taken out", Date.parse("2026-11-14T12:00:00Z")], ["400 days later", LIMIT + 400 * DAY]];
  for (const [when, at] of moments) {
    const r = harness();
    r.now = at;
    assert.equal((await r.get(await sub("7001", undefined, expiryFor(at)))).status, 200, `${when}: control, the address with an expiry opens (and now the subtitle is kept)`);
    assert.ok(r.kv._m.has(KEYS.srt("7001")), `${when}: (control: the subtitle IS kept)`);
    const calls = r.calls.length;
    for (const [what, old] of [["properly signed", subOld("7001")], ["a wrong signature", subOld("7001", "0".repeat(16))], ["signed as an address with an expiry is", subOld("7001", await signFileUntil(TOK, "7001", expiryFor(at)))]]) {
      const got = await r.get(old);
      assert.equal(got.status, 404, `${when}, ${what}: GET`);
      assert.deepEqual(got.json(), { err: "not found" }, `${when}, ${what}`);
      assert.equal((await r.get(old, r.env, "HEAD")).status, 404, `${when}, ${what}: HEAD (a kept subtitle is not served either)`);
    }
    assert.equal(r.calls.length, calls, `${when}: not one call to OpenSubtitles`);
  }
  // nothing left to sign or check that form with, and no date to wait for
  for (const gone of ["signFile", "verifySig", "V2_ACCEPT_UNTIL"]) assert.ok(!(gone in subfileModule), `${gone} is not exported any more`);
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "subfile.js"), "utf8");
  assert.doesNotMatch(source, /subfile\/v2\\0|V2_ACCEPT_UNTIL|verifySig|signFile\b/, "src/subfile.js has no key label, date or function of the old form");
});

test("verifyUntil and linkIsGood: only the exact signature of this file and this expiry passes, and only while the expiry is in the future", async () => {
  const exp = expiryFor(NOW0);
  const sig = await signFileUntil(TOK, "7001", exp);
  assert.equal(await verifyUntil(TOK, "7001", exp, sig, NOW0), true);
  assert.equal(await verifyUntil(TOK, "7001", String(exp), sig, NOW0), true, "the expiry as the text of the address");
  assert.equal(await verifyUntil(TOK, "7001", exp, sig, exp * 1000), false, "at the expiry");
  assert.equal(await verifyUntil(TOK, "7001", exp, sig, exp * 1000 - 1), true);
  assert.equal(await verifyUntil(TOK, "7002", exp, sig, NOW0), false);
  assert.equal(await verifyUntil(TOK, "7001", exp + 1, sig, NOW0), false);
  assert.equal(await verifyUntil("not-the-token-0123456789", "7001", exp, sig, NOW0), false);
  for (const bad of [sig.slice(0, 15), sig + "0", sig.toUpperCase(), "0".repeat(16), "", undefined, null, 12345678901234567]) assert.equal(await verifyUntil(TOK, "7001", exp, bad, NOW0), false, String(bad));
  for (const badExp of ["", "123", "12345678901", "abcdefghij", undefined, null]) assert.equal(await verifyUntil(TOK, "7001", badExp, await signFileUntil(TOK, "7001", badExp), NOW0), false, `an expiry that is not 10 digits: ${badExp}`);
  const m = (path) => SUBFILE_PATH.exec(path);
  assert.equal(await linkIsGood(TOK, m(`/subfile/7001/${exp}/${sig}.srt`), NOW0), true);
  assert.equal(await linkIsGood(TOK, m(`/subfile/7001/${exp}/${sig}.srt`), (exp + 1) * 1000), false);
  assert.equal(await linkIsGood(TOK, m(`/subfile/7002/${exp}/${sig}.srt`), NOW0), false, "another file");
  assert.equal(await linkIsGood(TOK, m(`/subfile/7001/${exp + 86400}/${sig}.srt`), NOW0), false, "another expiry");
  assert.equal(m(subOld("7001")), null, "the address without an expiry never reaches linkIsGood: the path does not match (the handler answers 404)");
});

test("GET /subfile: a bad signature, a bad shape or missing secrets is a 404 before OpenSubtitles is asked anything", async () => {
  const r = harness();
  const good = await sub("7001");
  const sig = oldSig(TOK, "7001"); // 16 hex digits that sign nothing the Worker accepts
  for (const p of [await sub("7001", "0".repeat(16)), await sub("7002", sig), await sub("7001", sig.toUpperCase()), `/subfile/7001/${sig.slice(0, 15)}.srt`, `/subfile/7001/${sig}.txt`, `/subfile/abc/${sig}.srt`, `/subfile/7001/${sig}.srt/extra`, "/subfile/", "/subfile/7001"]) {
    const x = await r.get(p);
    assert.equal(x.status, 404, p);
    assert.deepEqual(x.json(), { err: "not found" }, p);
  }
  for (const drop of ["OPENSUBTITLES_USERNAME", "OPENSUBTITLES_PASSWORD", "OPENSUBTITLES_API_KEY", "SUBTITLES_PRIVATE_TOKEN"]) assert.equal((await r.get(good, { ...r.env, [drop]: "" })).status, 404, drop);
  assert.equal((await r.get(good, {})).status, 404);
  assert.equal((await r.get(await sub("7001", await signFileUntil("not-the-token", "7001", expiryFor(NOW0))))).status, 404, "signed with another token");
  // 14/11/2026 (security review): the pieces of a GOOD address (this file, this expiry, its true signature) with an encoded slash or an encoded line break glued to them. The path is matched
  // as it arrives, never decoded, so each is a 404 and nothing is asked: neither the file id nor what follows ".srt" can carry more than the address shape allows.
  const exp = expiryFor(NOW0), true16 = await signFileUntil(TOK, "7001", exp);
  assert.equal(good, `/subfile/7001/${exp}/${true16}.srt`, "(control: these are the pieces of the good address)");
  for (const p of [`/subfile/7001%2F${exp}/${true16}.srt`, `/subfile/7001/${exp}/${true16}.srt%2Fx`, `/subfile/7001/${exp}/${true16}.srt%2Fx%0A`, `/subfile/7001/${exp}/${true16}.srt%0A`, `/subfile/7001/${exp}%2F${true16}.srt`, `/subfile%2F7001/${exp}/${true16}.srt`, `/subfile/7001/${exp}/${true16}%2Esrt`]) {
    for (const method of ["GET", "HEAD"]) {
      const x = await r.get(p, r.env, method);
      assert.equal(x.status, 404, `${method} ${p}`);
      if (method === "GET") assert.deepEqual(x.json(), { err: "not found" }, p);
    }
    assert.equal(SUBFILE_PATH.test(new URL(`https://w.test${p}`).pathname), false, `${p}: the path the Worker sees does not match`);
  }
  for (const raw of [`${good}\n`, `${good}\r\n`, `${good}/x\n`, `\n${good}`, `${good} `]) assert.equal(SUBFILE_PATH.test(raw), false, `${JSON.stringify(raw)}: the shape ends at ".srt" (a line break after it is not the end)`);
  assert.equal(r.calls.length, 0, "not one call to OpenSubtitles");
  assert.equal((await r.get(good)).status, 200, "(control: the good address itself opens, so the 404s above are about the shape)");
});

test("GET /subfile with a good signature: login, download, fetch the link, answer the SRT as text/plain; charset=utf-8 with CORS and a day of cache; the right headers go to the right places", async () => {
  const r = harness();
  const x = await r.get(await sub("7001"));
  assert.equal(x.status, 200);
  assert.equal(x.text, SRT, "the bytes, accents and dashes intact");
  assert.equal(x.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(x.headers.get("access-control-allow-origin"), "*");
  assert.equal(x.headers.get("cache-control"), "public, max-age=86400");
  assert.equal(x.headers.get("x-subfile"), "source");
  const [login, download, file] = r.calls;
  assert.deepEqual([login.method, login.url], ["POST", "https://api.opensubtitles.com/api/v1/login"]);
  assert.deepEqual(JSON.parse(login.body), { username: USER, password: PASS });
  assert.equal(login.headers["Api-Key"], APIKEY);
  assert.equal(login.headers["User-Agent"], "MoodEngine v3.3.0");
  assert.equal(login.headers.Authorization, undefined, "no token to log in with");
  assert.deepEqual([download.method, download.url], ["POST", "https://api.opensubtitles.com/api/v1/download"]);
  assert.deepEqual(JSON.parse(download.body), { file_id: 7001 }, "a number, as the API documents");
  assert.deepEqual(download.headers, { "Api-Key": APIKEY, "User-Agent": "MoodEngine v3.3.0", Accept: "*/*", "Content-Type": "application/json", Authorization: `Bearer ${TOKEN1}` });
  assert.equal(file.url, LINK("7001"));
  assert.equal(file.redirect, "manual", "redirects are followed by hand, each hop checked");
  assert.equal(file.headers.Authorization, undefined, "the link needs no authorization, and gets none");
  assert.equal(file.headers["Api-Key"], undefined, "nor the key");
  assert.equal(file.headers["User-Agent"], "MoodEngine v3.3.0");
  assert.deepEqual(r.logs.filter((l) => l.event === "opensubtitles-download"), [{ event: "opensubtitles-download", remaining: 19 }], "the quota left is logged, as a number");
});

test("HEAD /subfile never spends the quota: a subtitle that is kept answers 200 with no body; one that is not kept is a 405 and OpenSubtitles is not asked anything", async () => {
  const r = harness();
  const cold = await r.get(await sub("7001"), r.env, "HEAD");
  assert.deepEqual([cold.status, cold.headers.get("allow"), cold.headers.get("cache-control")], [405, "GET", "no-store"]);
  assert.equal(r.calls.length, 0, "no login, no download, no link");
  assert.equal((await r.get(await sub("7001"))).status, 200);
  const calls = r.calls.length;
  const warm = await r.get(await sub("7001"), r.env, "HEAD");
  assert.deepEqual([warm.status, warm.text, warm.headers.get("content-type")], [200, "", "text/plain; charset=utf-8"]);
  assert.equal(r.calls.length, calls);
  const other = r.isolate();
  assert.equal((await other.get(await sub("7001"), r.env, "HEAD")).status, 200, "kept in KV: another isolate answers too");
  const bare = harness({ kv: false });
  assert.equal((await bare.get(await sub("7001"), bare.env, "HEAD")).status, 405);
  assert.equal(bare.calls.length, 0);
});

test("GET /subfile: the subtitle is kept 30 days per file in KV (and in memory): asking again, or from another isolate, makes no call to OpenSubtitles; the link is never kept", async () => {
  const r = harness();
  const first = await r.get(await sub("7001"));
  assert.equal(first.headers.get("x-subfile"), "source");
  const apiCalls = r.calls.length;
  assert.deepEqual([(await r.get(await sub("7001"))).headers.get("x-subfile")], ["memory"]);
  const stored = r.kv._m.get(KEYS.srt("7001"));
  assert.ok(stored, "written to KV under srt:<file id>");
  assert.equal(stored.value, SRT);
  assert.equal(stored.ttl, 30 * 24 * 3600, "for 30 days");
  const third = await r.isolate().get(await sub("7001"));
  assert.deepEqual([third.status, third.text, third.headers.get("x-subfile")], [200, SRT, "kv"]);
  assert.equal(r.calls.length, apiCalls, "no login, no download, no link");
  // (from here on the address is the one listed on the day: the first one has expired by day 31, see the expiry tests)
  r.now += 29 * 24 * 3600e3;
  assert.equal((await r.get(await sub("7001", undefined, expiryFor(r.now)))).headers.get("x-subfile"), "memory", "still kept after 29 days");
  r.now += 2 * 24 * 3600e3;
  assert.equal((await r.isolate().get(await sub("7001", undefined, expiryFor(r.now)))).headers.get("x-subfile"), "source", "after 30 days it is downloaded again");
  assert.equal(r.downloadCount, 2);
  r.now += 31 * 24 * 3600e3;
  assert.equal((await r.get(await sub("7001", undefined, expiryFor(r.now)))).headers.get("x-subfile"), "source", "this isolate's own memory does not keep it longer than 30 days either");
  assert.equal(r.downloadCount, 3);
  assert.equal([...r.kv._m.values()].some((v) => v.value.includes("LINKPART")), false, "the link is never kept");
  const keys = [...r.kv._m.keys()];
  assert.ok(keys.every((k) => /^(token:v1|quota:v1|loginfail:v1|health:v1|srt:\d+|os:remaining:\d{4}-\d{2}-\d{2})$/.test(k)), `only fixed keys, never one made from the credentials: ${keys.join(" ")}`);
  const bare = harness({ kv: false });
  await bare.get(await sub("7001"));
  assert.equal((await bare.get(await sub("7001"))).headers.get("x-subfile"), "memory");
  assert.equal((await bare.isolate().get(await sub("7001"))).headers.get("x-subfile"), "source", "without KV a cold isolate downloads again");
});

test("GET /subfile: the token is kept in KV under one fixed key for about 20 hours and used by every isolate; one login at a time; a failed login is stamped in KV for 10 minutes so a cold isolate does not repeat it", async () => {
  const r = harness();
  r.slow = true;
  const [a, b] = await Promise.all([r.get(await sub("7001")), r.get(await sub("7002"))]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(r.loginCount, 1, "two cold requests at once: one login");
  const stored = r.kv._m.get(KEYS.token);
  assert.equal(stored.ttl, 20 * 3600, "about 20 hours");
  assert.equal(JSON.parse(stored.value).token, TOKEN1);
  assert.equal(JSON.parse(stored.value).baseUrl, "https://api.opensubtitles.com/api/v1");
  await r.get(await sub("7010"));
  assert.equal(r.loginCount, 1, "the token is reused");
  const downloads = r.downloadCount;
  await Promise.all([r.get(await sub("7011")), r.get(await sub("7011"))]);
  assert.equal(r.downloadCount, downloads + 1, "the same subtitle asked twice at once is downloaded once");
  assert.ok(r.downloads().every((c) => c.headers.Authorization === `Bearer ${TOKEN1}`), "the same token every time");
  const cold = r.isolate();
  assert.equal((await cold.get(await sub("7003"))).status, 200);
  assert.equal(r.loginCount, 1, "another isolate finds the token in KV, and logs in no more");
  r.now += 21 * 3600e3;
  assert.equal((await r.isolate().get(await sub("7004"))).status, 200);
  assert.equal(r.loginCount, 2, "after about 20 hours the token is renewed");
  assert.equal(r.downloads().at(-1).headers.Authorization, `Bearer ${TOKEN2}`);
  assert.equal(JSON.parse(r.kv._m.get(KEYS.token).value).token, TOKEN2);
  const sameAfterPasswordChange = r.isolate();
  assert.equal((await sameAfterPasswordChange.get(await sub("7005"), { ...r.env, OPENSUBTITLES_PASSWORD: "a new password" })).status, 200);
  assert.equal(r.loginCount, 2, "the token is not tied to the credentials: a changed password logs in only when the token is refused");

  const bad = harness({ login: "401" });
  const first = await bad.get(await sub("7001"));
  assert.deepEqual([first.status, first.headers.get("x-subfile"), first.headers.get("cache-control")], [502, "login-failed", "no-store"]);
  assert.equal(first.text, "subtitle unavailable\n");
  assert.equal(bad.kv._m.get(KEYS.loginFailed).ttl, 600, "a stamp for 10 minutes");
  const second = await bad.get(await sub("7002"));
  assert.deepEqual([second.status, second.headers.get("x-subfile")], [502, "login-paused"]);
  assert.equal((await bad.isolate().get(await sub("7003"))).headers.get("x-subfile"), "login-paused", "a cold isolate reads the stamp");
  assert.equal(bad.loginCount, 1, "not asked again, by anyone");
  assert.equal(bad.downloadCount, 0);
  bad.now += LOGIN_BACKOFF_MS - 1;
  assert.equal((await bad.get(await sub("7003"))).headers.get("x-subfile"), "login-paused");
  bad.now += 2;
  bad.login = "ok";
  assert.equal((await bad.isolate().get(await sub("7004"))).status, 200, "after 10 minutes it logs in again");
  assert.equal((await bad.kv.get(KEYS.loginFailed)), null, "and the stamp has expired with the pause");
  const noKv = harness({ login: "401", kv: false });
  await noKv.get(await sub("7001"));
  assert.equal((await noKv.get(await sub("7002"))).headers.get("x-subfile"), "login-paused", "without KV the same isolate still waits");
  assert.equal(noKv.loginCount, 1);
});

test("login failures are logged under their own names — rejected (with the status), error, bad answer — and never with the answer or the credentials", async () => {
  const events = async (login) => { const x = harness({ login }); await x.get(await sub("7001")); return x.logs.filter((l) => l.event.startsWith("opensubtitles-login")); };
  assert.deepEqual(await events("401"), [{ event: "opensubtitles-login-rejected", status: 401 }]);
  assert.deepEqual(await events("throw"), [{ event: "opensubtitles-login-error" }]);
  assert.deepEqual(await events("html"), [{ event: "opensubtitles-login-bad-answer" }]);
});

test("GET /subfile: a refused token (401) is renewed once — a newer token another isolate stored is used before logging in again — and the download retried; the host for later calls is OpenSubtitles' own API (vip-api too), never anything else", async () => {
  const r = harness({ download: (n) => (n === 1 ? "401" : "ok") });
  const x = await r.get(await sub("7001"));
  assert.equal(x.status, 200);
  assert.equal(r.loginCount, 2);
  assert.deepEqual(r.downloads().map((c) => c.headers.Authorization), [`Bearer ${TOKEN1}`, `Bearer ${TOKEN2}`]);
  await r.get(await sub("7002"));
  assert.equal(r.downloads().at(-1).headers.Authorization, `Bearer ${TOKEN2}`, "the renewed token is the one kept");
  assert.equal(r.loginCount, 2);
  const always = harness({ download: "401" });
  const y = await always.get(await sub("7001"));
  assert.deepEqual([y.status, y.headers.get("x-subfile")], [502, "download-failed"]);
  assert.equal(always.loginCount, 2, "one renewal, not a loop");

  const shared = harness({ download: (n, id, init) => (init.headers.Authorization === `Bearer ${TOKEN1}` ? "401" : "ok") });
  await shared.get(await sub("7001")); // this isolate now holds TOKEN1 and has logged in once... then TOKEN2 after the refusal
  const stale = shared.isolate();
  await stale.get(await sub("7002")); // reads TOKEN2 from KV
  assert.equal(shared.loginCount, 2);
  const fresh = harness({ download: (n, id, init) => (init.headers.Authorization === `Bearer ${TOKEN1}` ? "401" : "ok") });
  const holder = fresh.isolate();
  await holder.get(await sub("7001"));
  fresh.kv._m.set(KEYS.token, { value: JSON.stringify({ token: "TOKEN-NEWER", baseUrl: "https://api.opensubtitles.com/api/v1", until: fresh.now + 3600e3 }), expires: 0, ttl: 3600 });
  const logins = fresh.loginCount;
  fresh.download = (n, id, init) => (init.headers.Authorization === `Bearer ${TOKEN2}` ? "401" : "ok");
  await holder.get(await sub("7005"));
  assert.equal(fresh.loginCount, logins, "the newer token in KV is used instead of a new login");
  assert.equal(fresh.downloads().at(-1).headers.Authorization, "Bearer TOKEN-NEWER");

  const vip = harness({ baseUrl: "vip-api.opensubtitles.com" });
  await vip.get(await sub("7001"));
  assert.equal(vip.downloads()[0].url, "https://vip-api.opensubtitles.com/api/v1/download");
  for (const evil of ["evil.example", "api.opensubtitles.com.evil.example", "https://evil.example/", "attacker.example/api.opensubtitles.com", "", undefined, 5]) {
    const e = harness({ baseUrl: evil });
    assert.equal((await e.get(await sub("7001"))).status, 200);
    assert.equal(e.downloads()[0].url, "https://api.opensubtitles.com/api/v1/download", `${evil}: the token never leaves OpenSubtitles' API`);
    assert.ok(e.calls.every((c) => !c.url.includes("evil")), String(evil));
  }
  const poisoned = harness();
  poisoned.kv._m.set(KEYS.token, { value: JSON.stringify({ token: "STOLEN", baseUrl: "https://evil.example/api/v1", until: poisoned.now + 3600e3 }), expires: 0, ttl: 3600 });
  assert.equal((await poisoned.get(await sub("7001"))).status, 200);
  assert.ok(poisoned.calls.every((c) => !c.url.includes("evil") && c.headers.Authorization !== "Bearer STOLEN"), "a token in KV that names another host is not used");
});

test("GET /subfile: the quota (406 with remaining ≤ 0) is a 502 'quota', logged as a number, kept in KV until it comes back; a subtitle already kept is still served; an invalid file (406 without remaining) does not pause anything", async () => {
  const r = harness({ download: (n) => (n === 1 ? "ok" : "quota") });
  assert.equal((await r.get(await sub("7001"))).status, 200);
  const spent = await r.get(await sub("7002"));
  assert.deepEqual([spent.status, spent.headers.get("x-subfile"), spent.headers.get("cache-control")], [502, "quota", "no-store"]);
  assert.deepEqual(r.logs.filter((l) => l.event === "opensubtitles-quota-out"), [{ event: "opensubtitles-quota-out", remaining: -1 }]);
  assert.equal(Number(r.kv._m.get(KEYS.quota).value), r.now + 3 * 3600e3, "until the reset time the answer gave");
  assert.equal(r.kv._m.has(KEYS.health), false, "a spent quota is not a failure of OpenSubtitles");
  const far = harness({ download: "quota" });
  far.resetIn = 3 * 24 * 3600e3;
  await far.get(await sub("7001"));
  assert.equal(Number(far.kv._m.get(KEYS.quota).value), far.now + 24 * 3600e3, "never more than 24 hours");
  const calls = r.downloadCount;
  assert.equal((await r.get(await sub("7003"))).headers.get("x-subfile"), "quota");
  assert.equal((await r.isolate().get(await sub("7003"))).headers.get("x-subfile"), "quota", "another isolate too");
  assert.equal(r.downloadCount, calls, "paused: not asked again");
  assert.equal((await r.isolate().get(await sub("7001"))).status, 200, "a subtitle already kept needs no quota");
  r.now += 3 * 3600e3 + 1; // the reset time the answer gave
  r.download = "ok";
  assert.equal((await r.isolate().get(await sub("7003"))).status, 200, "after the reset time it asks again");
  const noReset = harness({ download: () => "quota" });
  noReset.download = () => "quota";
  await noReset.get(await sub("7001"));
  noReset.now += QUOTA_PAUSE_MS - 1;
  const c = noReset.downloadCount;
  await noReset.get(await sub("7002"));
  assert.equal(noReset.downloadCount, c);

  const bad = harness({ download: "invalid" });
  const x = await bad.get(await sub("7001"));
  assert.deepEqual([x.status, x.headers.get("x-subfile")], [502, "rejected"]);
  await bad.get(await sub("7002"));
  assert.equal(bad.downloadCount, 2, "an invalid file id is not a quota problem: the next one is tried");
  assert.equal(bad.kv._m.has(KEYS.health), false, "and it is not a failure of OpenSubtitles");
});

test("GET /subfile: busy (429, 5xx), no link, a link that is not on OpenSubtitles, a file that cannot be had, an empty file or a page instead of a subtitle are each a 502 with a short reason, and nothing bad is kept", async () => {
  const cases = [[{ download: "429" }, "busy"], [{ download: "500" }, "busy"], [{ download: "nolink" }, "no-link"], [{ download: "link:http://www.opensubtitles.com/x.srt" }, "no-link"], [{ link: "500" }, "file-failed"], [{ link: "html" }, "bad-file"], [{ link: "empty" }, "bad-file"]];
  for (const [options, reason] of cases) {
    const r = harness(options);
    const x = await r.get(await sub("7001"));
    assert.deepEqual([x.status, x.headers.get("x-subfile"), x.text], [502, reason, "subtitle unavailable\n"], reason);
    assert.equal(r.kv._m.has(KEYS.srt("7001")), false, `${reason}: nothing kept`);
    assert.equal(JSON.parse(r.kv._m.get(KEYS.health).value).fails, 1, `${reason}: counted as a failure`);
    r.download = "ok"; r.link = "ok";
    assert.equal((await r.get(await sub("7001"))).status, 200, `${reason}: the next try is a fresh one`);
    assert.equal(r.kv._m.has(KEYS.health), false, `${reason}: a success clears the count`);
  }
});

test("GET /subfile: the link is fetched only on https://*.opensubtitles.com or .org, without credentials or a port; a redirect is followed by hand, each hop checked; the body is cut at 2 MB while it streams", async () => {
  for (const link of ["https://evil.example/x.srt", "https://opensubtitles.com.evil.example/x.srt", "https://evilopensubtitles.com/x.srt", "https://user:pw@www.opensubtitles.com/x.srt", "https://www.opensubtitles.com:8443/x.srt", "http://www.opensubtitles.com/x.srt", "ftp://www.opensubtitles.com/x.srt", "//www.opensubtitles.com/x.srt", "not an address"]) {
    const r = harness({ download: `link:${link}` });
    const x = await r.get(await sub("7001"));
    assert.deepEqual([x.status, x.headers.get("x-subfile")], [502, "no-link"], link);
    assert.equal(r.fileCalls || 0, 0, `${link}: never fetched`);
  }
  for (const link of ["https://www.opensubtitles.com/a.srt", "https://dl.opensubtitles.org/a.srt", "https://opensubtitles.com/a.srt", "https://a.b.opensubtitles.org/a.srt"]) {
    const r = harness({ download: `link:${link}` });
    assert.equal((await r.get(await sub("7001"))).status, 200, link);
  }
  const hop = harness({ link: "redirect" });
  const followed = await hop.get(await sub("7001"));
  assert.equal(followed.status, 200, "a redirect inside OpenSubtitles' hosts, absolute and relative, is followed");
  assert.equal(followed.text, SRT);
  assert.ok(hop.calls.filter((c) => c.redirect !== undefined).every((c) => c.redirect === "manual"));
  const evil = harness({ link: "redirect-evil" });
  const refused = await evil.get(await sub("7001"));
  assert.deepEqual([refused.status, refused.headers.get("x-subfile")], [502, "no-link"]);
  assert.ok(evil.calls.every((c) => !c.url.includes("evil.example")), "a redirect to another host is not followed");
  const loop = harness({ link: "loop" });
  assert.equal((await loop.get(await sub("7001"))).headers.get("x-subfile"), "no-link");
  assert.ok(loop.fileCalls <= 4, "a loop is cut");
  const big = harness({ link: "bigheader" });
  assert.equal((await big.get(await sub("7001"))).headers.get("x-subfile"), "bad-file", "declared too big");
  const stream = harness({ link: "bigstream" });
  const cut = await stream.get(await sub("7001"));
  assert.equal(cut.headers.get("x-subfile"), "bad-file", "no length declared, too big while streaming");
  assert.equal(stream.streamCancelled, true, "the stream is cancelled, not read to the end");
  assert.ok(stream.streamChunks < 40, `stopped early (${stream.streamChunks} of 61 chunks)`);
  assert.equal(stream.kv._m.has(KEYS.srt("7001")), false);
});

test("a token, a password, a user name, a key or the private token is never in an answer or a log — through success, quota, a refused login, a refused token and a failing download — and KV holds the token and the subtitles, nothing else", async () => {
  const scenarios = [{}, { download: () => "quota" }, { login: "401" }, { login: "throw" }, { download: (n) => (n === 1 ? "401" : "ok") }, { download: "500" }, { link: "html" }, { link: "redirect-evil" }];
  for (const options of scenarios) {
    const r = harness(options);
    for (const id of ["7001", "7002"]) await r.get(await sub(id));
    await r.get(PRIVATE + SUBS);
    await r.get(SUBS);
    await r.get(await sub("7001", "0".repeat(16)));
    await r.get(await sub("7001"), r.env, "HEAD");
    const everything = JSON.stringify({ seen: r.seen, logs: r.logs });
    for (const secret of [TOKEN1, TOKEN2, PASS, USER, APIKEY, TOK, "Bearer"]) assert.ok(!everything.includes(secret), `${JSON.stringify(Object.keys(options))}: ${secret} leaked`);
    const kvText = JSON.stringify([...r.kv._m.entries()]);
    for (const secret of [PASS, USER, APIKEY, TOK]) assert.ok(!kvText.includes(secret), `KV holds ${secret}`);
    assert.ok(r.logs.every((l) => Object.values(l).every((v) => typeof v === "number" || typeof v === "string" || v === null || typeof v === "boolean")));
  }
});

// ── the second review and security re-check (Marco, 12/10/2026) ──────────────

test("redirects are never followed by the three requests that carry credentials — the hash search (key), the login (key, user name, password) and the download (key, token): `redirect: \"manual\"`, and a 307 to another host is a failure that sends nothing there", async () => {
  const r = harness();
  await r.get(PRIVATE + SUBS);
  await r.get(await sub("7001"));
  const api = r.calls.filter((c) => /^https:\/\/(?:vip-)?api\.opensubtitles\.com\//.test(c.url) && !c.url.includes("/subtitles/movie/"));
  assert.ok(api.length >= 3, "the search, the login and the download were all made");
  assert.deepEqual(api.map((c) => c.redirect), api.map(() => "manual"), "every call to the API says redirect: manual");
  assert.ok(r.calls.filter((c) => c.url.includes("opensubtitles.com/download/")).every((c) => c.redirect === "manual"), "and so does the link, which follows its own redirects by hand");

  for (const at of ["login", "download", "search"]) {
    const x = harness();
    x.redirectAt = at;
    const out = at === "search" ? (await x.subtitles().exact(ENV, "movie", "tt5247022", HASH)).status : (await x.get(await sub("7001"))).headers.get("x-subfile");
    assert.equal(out, at === "search" ? "failed" : at === "login" ? "login-failed" : "download-failed", `a 307 from the ${at} is a failure`);
    assert.ok(x.calls.every((c) => !c.url.includes("evil.example") && !c.followed), `${at}: nothing was sent to the host the 307 named`);
    const leaked = JSON.stringify(x.seen) + JSON.stringify(x.logs);
    assert.ok(!leaked.includes("STOLEN-BY-REDIRECT"));
  }
});

test("a download that leaves remaining ≤ 0 is the day's last: the subtitle is served, and the quota is marked out at once (KV and log), so the rows go before the next 406", async () => {
  const r = harness({ download: (n) => (n === 1 ? "last" : "ok") });
  assert.equal((await r.get(PRIVATE + SUBS)).headers.get("x-subtitles-extras"), "3");
  const last = await r.get(await sub("7001"));
  assert.deepEqual([last.status, last.text], [200, SRT], "the subtitle itself is served");
  assert.equal(Number(r.kv._m.get(KEYS.quota).value), r.now + 3 * 3600e3);
  assert.deepEqual(r.logs.filter((l) => l.event === "opensubtitles-quota-out"), [{ event: "opensubtitles-quota-out", remaining: 0 }]);
  const after = await r.isolate().get(PRIVATE + SUBS);
  assert.equal(after.headers.get("x-subtitles-extras"), "off-quota");
  assert.equal(after.headers.get("cache-control"), "private, max-age=300");
  const calls = r.downloadCount;
  assert.equal((await r.get(await sub("7002"))).headers.get("x-subfile"), "quota");
  assert.equal(r.downloadCount, calls, "and the next one is not even tried");
  assert.equal((await r.get(await sub("7001"))).status, 200, "the subtitle just downloaded is kept");
});

test("a KV that does not answer in time never slows the subtitles: no extra rows this time, the answer is degraded (300 s), and the slow read is logged", async () => {
  const r = harness({ offeringMs: 30 });
  r.kvSlow = 400;
  const t0 = Date.now();
  const x = await r.get(PRIVATE + SUBS);
  assert.ok(Date.now() - t0 < 350, `answered in ${Date.now() - t0} ms, not after the KV`);
  assert.equal(x.status, 200);
  assert.equal(x.headers.get("x-subtitles-extras"), "off-kv-timeout");
  assert.equal(x.headers.get("cache-control"), "private, max-age=300");
  assert.equal(x.json().cacheMaxAge, 300);
  assert.ok(x.json().subtitles.length > 20 && x.json().subtitles.every((s) => !s.id.startsWith("moodsubs-os")));
  assert.deepEqual(r.logs.filter((l) => l.event === "subs-kv-slow"), [{ event: "subs-kv-slow", what: "offering" }]);
  r.kvSlow = 0;
  assert.equal((await r.get(PRIVATE + SUBS)).headers.get("x-subtitles-extras"), "3", "a KV that answers: the rows are back");
});

// ── the hash search only under the private address (W4, 19/10/2026) ─────────

const REST_SEARCH = /^https:\/\/(?:vip-)?api\.opensubtitles\.com\/api\/v1\/subtitles\?/;

test("W4: a public request with a valid hash makes NO call to the REST search (the official list is asked, once) and logs nothing with the hash; the answer says 'public' and has no exact tier; the same request under /k/<token>/ makes the search, as before", async () => {
  const r = harness();
  const pub = await r.get(SUBS);
  assert.equal(pub.status, 200);
  assert.equal(r.callsTo(REST_SEARCH).length, 0, "no REST search: the quota is not touched");
  assert.equal(r.callsTo(/^https:\/\/opensubtitles-v3\.strem\.io\//).length, 1, "the official list is asked");
  assert.equal(pub.headers.get("x-subtitles-exact"), "public");
  assert.ok(pub.json().subtitles.length > 20, "the official list is what is answered");
  assert.ok(!pub.json().subtitles.some((s) => s.label.includes("✓")), "no exact tier without the search");
  assert.ok(!JSON.stringify(r.logs).includes(HASH), "no log event carries the hash");
  assert.ok(!JSON.stringify(r.calls.map((c) => c.url)).includes("moviehash"), "and no address asked carries it");

  const priv = await r.get(PRIVATE + SUBS);
  assert.equal(r.callsTo(REST_SEARCH).length, 1, "under the private address the search is made, once");
  assert.ok(r.callsTo(REST_SEARCH)[0].url.includes(`moviehash=${HASH}`));
  assert.match(priv.headers.get("x-subtitles-exact"), /^ok \(\d+ ids\)$/);
  assert.ok(priv.json().subtitles.some((s) => s.label.includes("✓")), "the exact tier is back");
  assert.equal(priv.headers.get("x-subtitles-extras"), "3", "and so are the rows the official list lacks");
});

test("W4: the six public profile addresses /p/<profile>/ make no REST search either; under /k/<token>/p/<profile>/ the request is private and the search is made; a wrong token is a 404 and asks nothing", async () => {
  for (const profile of ["marco", "light", "heavy", "night", "world", "critics"]) {
    const r = harness();
    const pub = await r.get(`/p/${profile}${SUBS}`);
    assert.equal(pub.status, 200, profile);
    assert.equal(pub.headers.get("x-profile") ?? "", "", "(the subtitles answer carries no profile tag)");
    assert.equal(pub.headers.get("x-subtitles-exact"), "public", profile);
    assert.equal(r.callsTo(REST_SEARCH).length, 0, `${profile}: no REST search`);
    assert.ok(!JSON.stringify(r.logs).includes(HASH), `${profile}: no hash in the log`);
    const priv = await r.get(`${PRIVATE}/p/${profile}${SUBS}`);
    assert.equal(priv.status, 200, profile);
    assert.equal(r.callsTo(REST_SEARCH).length, 1, `${profile}: under the private address the search is made`);
    assert.match(priv.headers.get("x-subtitles-exact"), /^ok \(\d+ ids\)$/, profile);
  }
  const r = harness();
  for (const p of [`/k/${"f".repeat(48)}${SUBS}`, `/k/short${SUBS}`, `/k${SUBS}`]) assert.equal((await r.get(p)).status, 404, p);
  assert.equal(r.calls.length, 0, "a wrong token asks nothing of anyone");
});

test("W4: what makes a request private is the token that was checked, not text that looks like it: '/k/' in the query, in another path, or a /k/ prefix without the right token never lets the search through", async () => {
  const r = harness();
  for (const p of [`${SUBS}?next=/k/${TOK}/x`, `/p/night${SUBS}?from=${PRIVATE}/`, `${SUBS}?k=/k/`]) {
    const x = await r.get(p);
    assert.equal(x.status, 200, p);
    assert.equal(x.headers.get("x-subtitles-exact"), "public", p);
  }
  assert.equal(r.callsTo(REST_SEARCH).length, 0);
  const other = harness();
  const wrong = await other.get(`/k/${TOK.replace(/.$/, "0")}${SUBS}`);
  assert.equal(wrong.status, 404);
  assert.equal(other.callsTo(REST_SEARCH).length, 0);
  const noToken = harness();
  const bare = await noToken.get(PRIVATE + SUBS, { OPENSUBTITLES_API_KEY: APIKEY }); // the private token is not in this environment: /k/ is a 404 whatever follows
  assert.equal(bare.status, 404);
  assert.equal(noToken.callsTo(REST_SEARCH).length, 0);
});

// ── the security review of 19/10/2026 ────────────────────────────────────────

test("wrangler.toml: Workers Logs is on only with the invocation log OFF — that log records `<Method> <URL>` of every request, and the URL holds the private token (/k/<token>/…), the signed /subfile links and the videoHash and file name of the searches (security review, 19/10/2026) — and no environment, no traces section and no second config file can turn something like it on", () => {
  const dir = path.join(here, "..");
  const text = fs.readFileSync(path.join(dir, "wrangler.toml"), "utf8");
  const flat = {}; // "section.key" → the raw value, for `[a.b]` headers and dotted keys alike
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const head = /^\[+([^\]]+)\]+$/.exec(line);
    if (head) { section = head[1].replace(/\s+/g, ""); flat[section] = "[table]"; continue; }
    const kv = /^([A-Za-z_][A-Za-z0-9_.\-"]*)\s*=\s*(.+)$/.exec(line);
    if (kv) flat[(section ? `${section}.` : "") + kv[1]] = kv[2].trim();
  }
  assert.equal(flat["observability.enabled"], "true", "control: Workers Logs is on, so the checks below are about something");
  assert.equal(flat["observability.logs.invocation_logs"], "false", "enabled = true without invocation_logs = false would keep every URL, token included, in Cloudflare's logs");
  assert.ok(!Object.keys(flat).some((k) => k === "observability" && flat[k] !== "[table]"), "no inline `observability = { … }`: it would hide the keys from this check");
  assert.ok(!("limits" in flat) && !Object.keys(flat).some((k) => k.startsWith("limits.")), "no [limits] section");
  // an environment's own observability replaces the top-level one, so each needs the same line
  const envs = new Set(Object.keys(flat).map((k) => /^env\.("[^"]+"|[^.]+)\.observability/.exec(k)).filter(Boolean).map((m) => m[1]));
  for (const name of envs) assert.equal(flat[`env.${name}.observability.logs.invocation_logs`], "false", `env.${name}.observability needs invocation_logs = false`);
  // traces record the request's URL in their spans; the invocation_logs switch does not cover them
  assert.ok(!Object.keys(flat).filter((k) => /(^|\.)observability\.traces/.test(k)).some((k) => /enabled$/.test(k) && flat[k] !== "false"), "no traces switched on");
  assert.deepEqual(["wrangler.json", "wrangler.jsonc"].filter((f) => fs.existsSync(path.join(dir, f))), [], "a wrangler.json or wrangler.jsonc beside the .toml is read first and would replace it");
});

test("OpenSubtitles down (5xx): a signed address opened again and again costs at most 3 calls and 3 KV writes, then nothing until the run of failures is forgotten (an hour) — 5xx carries no `remaining`, so the day's counter cannot stop it (security review, 19/10/2026: 50 requests were 51 calls and 51 writes)", async () => {
  const r = harness({ download: "500" });
  const address = await sub("7001");
  for (let i = 0; i < 50; i++) {
    const x = await r.get(address);
    assert.deepEqual([x.status, x.headers.get("x-subfile")], [502, "busy"], `request ${i + 1}`);
  }
  assert.equal(r.downloadCount, 3, "3 calls to /download, not 50");
  assert.equal(r.kv.ops.filter(([op, key]) => op === "put" && key === KEYS.health).length, 3, "3 writes of the failure count, not 50");
  assert.equal(r.kv.ops.filter(([op]) => op === "put").length, 4, "and the login token once");
  assert.equal(r.loginCount, 1);
  r.now += 61 * 60e3;
  await r.get(address);
  assert.equal(r.downloadCount, 4, "an hour later it is tried again");
  const quiet = harness({ download: "500" });
  for (let i = 0; i < 3; i++) await quiet.get(await sub("7001"));
  quiet.kv.ops.length = 0;
  const writes = quiet.kv.ops.length, calls = quiet.calls.length;
  await quiet.get(await sub("7002"));
  assert.deepEqual([quiet.kv.ops.length, quiet.calls.length], [writes, calls], "a refused request writes nothing and calls nobody");
  const head = await quiet.get(await sub("7001"), quiet.env, "HEAD");
  assert.equal(head.status, 405, "(HEAD, as before)");
});

test("a bad FILE does not stop the others: 3 times `bad-file` on one id (the link answers a page, and Stremio retries a bad subtitle by itself) hide the rows, but another id still opens with one call, also from another isolate; only 429, 5xx and network failures stop the calls (re-review, 19/10/2026: after 02659c2 one bad file made every file `busy` for an hour)", async () => {
  const r = harness({ link: "html" });
  for (let i = 0; i < 3; i++) assert.equal((await r.get(await sub("7001"))).headers.get("x-subfile"), "bad-file", `try ${i + 1}`);
  assert.equal(r.downloadCount, 3, "each try went to OpenSubtitles: a bad file is not the service failing");
  assert.equal((await r.get(PRIVATE + SUBS)).headers.get("x-subtitles-extras"), "off-failing", "the rows are still hidden after 3 failures of any kind");
  r.link = "ok";
  const calls = r.downloadCount;
  const good = await r.isolate().get(await sub("7002"));
  assert.deepEqual([good.status, good.text, good.headers.get("x-subfile")], [200, SRT, "source"]);
  assert.equal(r.downloadCount, calls + 1, "one call for the good file");
  assert.equal((await r.isolate().get(PRIVATE + SUBS)).headers.get("x-subtitles-extras"), "3", "and the success clears the run in KV (a third isolate sees it)");
  for (const reason of ["no-link", "file-failed"]) {
    const x = harness(reason === "no-link" ? { download: "nolink" } : { link: "500" });
    for (let i = 0; i < 3; i++) assert.equal((await x.get(await sub("7001"))).headers.get("x-subfile"), reason);
    const n = x.downloadCount;
    x.download = "ok"; x.link = "ok";
    assert.equal((await x.get(await sub("7002"))).status, 200, `${reason} x3 does not stop another file`);
    assert.equal(x.downloadCount, n + 1);
  }
  const mixed = harness({ download: "500" }); // two service failures and one bad file are three failures to hide the rows, but only two for the stop
  await mixed.get(await sub("7001")); await mixed.get(await sub("7002"));
  mixed.download = "ok"; mixed.link = "html";
  assert.equal((await mixed.get(await sub("7003"))).headers.get("x-subfile"), "bad-file");
  const kv = JSON.parse(mixed.kv._m.get(KEYS.health).value);
  assert.deepEqual([kv.fails, kv.service], [3, 2]);
  mixed.link = "ok";
  assert.equal((await mixed.get(await sub("7010"))).status, 200, "2 service failures: still asked");
});

test("a damaged day's counter in KV ({ remaining: 0, until: 1e300 }) pauses for at most a day and logs opensubtitles-paused with a real time; it does not make the download fail with no log (security review, 19/10/2026: new Date(1e300).toISOString() throws)", async () => {
  const r = harness();
  r.kv._m.set(COUNTER("2026-10-13"), { value: JSON.stringify({ remaining: 0, until: 1e300 }), expires: 0, ttl: 60 });
  const x = await r.get(await sub("7001"));
  assert.deepEqual([x.status, x.headers.get("x-subfile")], [502, "quota"]);
  assert.equal(r.downloadCount, 0, "OpenSubtitles was not asked");
  assert.deepEqual(paused(r), [{ event: "opensubtitles-paused", until: new Date(r.now + 24 * 3600e3).toISOString() }], "capped at a day from now");
  assert.equal((await r.get(PRIVATE + SUBS)).headers.get("x-subtitles-extras"), "off-quota", "the listing agrees");
  for (const bad of [{ remaining: 0, until: "x" }, { remaining: 0, until: -5 }, { remaining: 0 }, { remaining: "0", until: 1e300 }, null, "text"]) {
    const y = harness();
    y.kv._m.set(COUNTER("2026-10-13"), { value: JSON.stringify(bad), expires: 0, ttl: 60 });
    assert.equal((await y.get(await sub("7001"))).status, 200, `${JSON.stringify(bad)} pauses nothing`);
  }
});

test("the rows are not listed while the day's counter is at 0, even when quota:v1 has run out: remaining 0 with no reset moment is 10 minutes in quota:v1 but until midnight UTC in the counter, so 11 minutes later offering() hides the rows (security review, 19/10/2026: they were listed and every one of them was a 502)", async () => {
  const r = harness({ download: (n) => (n === 1 ? "last-noreset" : "ok") });
  assert.equal((await r.get(PRIVATE + SUBS)).headers.get("x-subtitles-extras"), "3");
  assert.equal((await r.get(await sub("7001"))).status, 200, "the day's last download is served");
  r.now += 11 * 60e3;
  assert.equal(r.now > Number(r.kv._m.get(KEYS.quota)?.value ?? 0), true, "control: quota:v1 has run out by now");
  const hidden = await r.isolate().get(PRIVATE + SUBS);
  assert.equal(hidden.headers.get("x-subtitles-extras"), "off-quota");
  assert.equal(hidden.headers.get("cache-control"), "private, max-age=300");
  assert.ok(hidden.json().subtitles.every((s) => !s.id.startsWith("moodsubs-os")));
  assert.equal((await r.get(await sub("7002"))).headers.get("x-subfile"), "quota", "and opening one would have been refused");
  r.now = Date.parse("2026-10-13T23:59:59Z");
  assert.equal((await r.isolate().get(PRIVATE + SUBS)).headers.get("x-subtitles-extras"), "off-quota", "still hidden just before midnight UTC");
  r.now = Date.parse("2026-10-14T00:00:00Z");
  assert.equal((await r.isolate().get(PRIVATE + SUBS)).headers.get("x-subtitles-extras"), "3", "the new day: listed again");
});

test("an answer is degraded (300 s, not 3600) when the hash search failed or is paused — on the private address, the only one that searches since W4 (19/10/2026) — and a public answer is never degraded by it, because it makes no search", async () => {
  const r = harness();
  r.searchMode = "429";
  const failed = await r.get(PRIVATE + SUBS);
  assert.equal(failed.headers.get("x-subtitles-exact"), "failed");
  assert.equal(failed.headers.get("cache-control"), "private, max-age=300");
  assert.equal(failed.json().cacheMaxAge, 300);
  const paused = await r.get(PRIVATE + SUBS);
  assert.equal(paused.headers.get("x-subtitles-exact"), "paused");
  assert.equal(paused.headers.get("cache-control"), "private, max-age=300");
  const pub = await r.get(SUBS);
  assert.equal(pub.headers.get("x-subtitles-exact"), "public", "the public address does not search, so a failing search cannot degrade it");
  assert.equal(pub.headers.get("cache-control"), "public, max-age=3600");
  const fine = harness();
  assert.equal((await fine.get(PRIVATE + SUBS)).headers.get("cache-control"), "private, max-age=3600");
  assert.equal((await fine.get(SUBS)).headers.get("cache-control"), "public, max-age=3600");
  const noKey = harness();
  assert.equal((await noKey.get(PRIVATE + SUBS, { ...noKey.env, OPENSUBTITLES_API_KEY: "" })).headers.get("cache-control"), "private, max-age=3600", "no key: no search to fail, nothing degraded");
});

test("the hash search body is read through the bounded reader: a declared size over the limit is refused unread, an undeclared one is cancelled at the limit", async () => {
  const big = harness();
  big.searchMode = "bigheader";
  assert.equal((await big.subtitles().exact(ENV, "movie", "tt5247022", HASH)).status, "failed");
  const stream = harness();
  stream.searchMode = "bigstream";
  assert.equal((await stream.subtitles().exact(ENV, "movie", "tt5247022", HASH)).status, "failed");
  assert.equal(stream.searchCancelled, true, "cancelled, not read to the end");
  assert.ok(stream.searchChunks < 25, `stopped early (${stream.searchChunks} of 61 chunks)`);
});

test("a stored login is used only before its `until` — in this isolate's memory as in KV — and only on https at OpenSubtitles' API host, with no credentials and no port", async () => {
  const mem = harness({ kv: false });
  assert.equal((await mem.get(await sub("7001"))).status, 200);
  mem.now += 19 * 3600e3;
  assert.equal((await mem.get(await sub("7002"))).status, 200);
  assert.equal(mem.loginCount, 1, "still valid after 19 hours");
  mem.now += 2 * 3600e3;
  assert.equal((await mem.get(await sub("7003"))).status, 200);
  assert.equal(mem.loginCount, 2, "21 hours: this isolate's own copy has expired and is not used");
  assert.equal(mem.downloads().at(-1).headers.Authorization, `Bearer ${TOKEN2}`);

  const stale = harness();
  stale.kv._m.set(KEYS.token, { value: JSON.stringify({ token: "EXPIRED", baseUrl: "https://api.opensubtitles.com/api/v1", until: stale.now - 1 }), expires: 0, ttl: 3600 });
  await stale.get(await sub("7001"));
  assert.equal(stale.loginCount, 1, "a token in KV past its until is not used");
  assert.ok(stale.downloads().every((c) => c.headers.Authorization !== "Bearer EXPIRED"));

  for (const baseUrl of ["http://api.opensubtitles.com/api/v1", "https://user:pw@api.opensubtitles.com/api/v1", "https://api.opensubtitles.com:8443/api/v1", "https://www.opensubtitles.com/api/v1", "https://api.opensubtitles.com.evil.example/api/v1", "api.opensubtitles.com/api/v1", "", 5]) {
    const x = harness();
    x.kv._m.set(KEYS.token, { value: JSON.stringify({ token: "STORED", baseUrl, until: x.now + 3600e3 }), expires: 0, ttl: 3600 });
    assert.equal((await x.get(await sub("7001"))).status, 200, String(baseUrl));
    assert.equal(x.loginCount, 1, `${baseUrl}: the stored login is not used`);
    assert.ok(x.calls.every((c) => c.headers.Authorization !== "Bearer STORED" && !c.url.startsWith("http://")), String(baseUrl));
  }
  const good = harness();
  good.kv._m.set(KEYS.token, { value: JSON.stringify({ token: "STORED", baseUrl: "https://vip-api.opensubtitles.com/api/v1", until: good.now + 3600e3 }), expires: 0, ttl: 3600 });
  await good.get(await sub("7001"));
  assert.equal(good.loginCount, 0, "control: a good stored login is used");
  assert.equal(good.downloads()[0].headers.Authorization, "Bearer STORED");
});

// ── the day's counter in KV (W5 of the 13/10/2026 plan, 19/10/2026) ──────────

const COUNTER = (day) => KEYS.remaining(day);
const paused = (r) => r.logs.filter((l) => l.event === "opensubtitles-paused");

test("W5: a download answer with remaining 0 is written to KV as os:remaining:<UTC date of the window> ({ remaining, until }, kept until the reset moment), and the next download — from any isolate, and with quota:v1 removed so that only the counter can stop it — is a 502 'quota' that never reaches OpenSubtitles and logs one opensubtitles-paused with `until` and nothing else", async () => {
  const r = harness({ download: (n) => (n === 1 ? "last" : "ok") });
  assert.equal((await r.get(await sub("7001"))).status, 200, "the last download of the day is still served");
  const stored = r.kv._m.get(COUNTER("2026-10-13"));
  assert.ok(stored, `written under the date of the window: ${[...r.kv._m.keys()].join(" ")}`);
  assert.deepEqual(JSON.parse(stored.value), { remaining: 0, until: r.now + 3 * 3600e3 });
  assert.equal(stored.ttl, 3 * 3600, "kept until the reset moment");
  assert.deepEqual(paused(r), [], "nothing is paused yet: this one was served");
  r.kv._m.delete(KEYS.quota); // the older stamp is not what is under test
  const calls = r.calls.length, downloads = r.downloadCount;
  const next = await r.isolate().get(await sub("7002"));
  assert.deepEqual([next.status, next.text, next.headers.get("x-subfile"), next.headers.get("cache-control")], [502, "subtitle unavailable\n", "quota", "no-store"], "the same answer as any refused download");
  assert.equal(r.calls.length, calls, "OpenSubtitles was not called at all: no login, no download, no link");
  assert.equal(r.downloadCount, downloads);
  assert.deepEqual(paused(r), [{ event: "opensubtitles-paused", until: new Date(r.now + 3 * 3600e3).toISOString() }], "one event, with the moment it ends");
  const everything = JSON.stringify(r.logs) + JSON.stringify(r.seen);
  for (const secret of [APIKEY, HASH, TOKEN1, TOK, PASS, USER]) assert.ok(!everything.includes(secret), `${secret} leaked`);
  r.now += 3 * 3600e3 - 1;
  assert.equal((await r.isolate().get(await sub("7003"))).headers.get("x-subfile"), "quota", "one millisecond before the reset moment: still paused");
  assert.equal(r.downloadCount, downloads);
  r.now += 1;
  assert.equal((await r.isolate().get(await sub("7003"))).status, 200, "at the reset moment it asks again");
  assert.equal(r.downloadCount, downloads + 1);
});

test("W5: a counter of an earlier day, or one whose reset moment has passed, pauses nothing; a counter above 0 pauses nothing; a new day asks OpenSubtitles again", async () => {
  const seed = (r, day, value) => r.kv._m.set(COUNTER(day), { value: JSON.stringify(value), expires: 0, ttl: 60 });
  const yesterday = harness();
  seed(yesterday, "2026-10-12", { remaining: 0, until: Date.parse("2026-10-13T00:00:00Z") });
  assert.equal((await yesterday.get(await sub("7001"))).status, 200, "yesterday's window is over");
  assert.equal(yesterday.downloadCount, 1);
  const passed = harness();
  seed(passed, "2026-10-13", { remaining: 0, until: passed.now - 1 });
  assert.equal((await passed.get(await sub("7001"))).status, 200, "today's key, but its reset moment is behind us");
  const plenty = harness();
  seed(plenty, "2026-10-13", { remaining: 3, until: plenty.now + 3600e3 });
  assert.equal((await plenty.get(await sub("7001"))).status, 200, "3 left is not a pause");
  assert.deepEqual(paused(plenty).concat(paused(passed), paused(yesterday)), []);
  const today = harness();
  seed(today, "2026-10-13", { remaining: 0, until: today.now + 3600e3 });
  assert.equal((await today.get(await sub("7001"))).headers.get("x-subfile"), "quota", "control: the same seed with the reset moment ahead does pause");
  assert.equal(today.downloadCount, 0);
  assert.equal(paused(today).length, 1);
  const ends = harness({ download: "last-noreset" }); // no reset moment in the answer: the next midnight UTC
  ends.now = Date.parse("2026-10-13T23:00:00Z");
  await ends.get(await sub("7001", undefined, expiryFor(ends.now)));
  assert.deepEqual(JSON.parse(ends.kv._m.get(COUNTER("2026-10-13")).value), { remaining: 0, until: Date.parse("2026-10-14T00:00:00Z") }, "today's date, ending at the next midnight UTC");
  ends.kv._m.delete(KEYS.quota);
  ends.now = Date.parse("2026-10-13T23:59:59Z");
  const n = ends.downloadCount;
  assert.equal((await ends.isolate().get(await sub("7002", undefined, expiryFor(ends.now)))).headers.get("x-subfile"), "quota");
  assert.equal(ends.downloadCount, n);
  ends.now = Date.parse("2026-10-14T00:00:00Z");
  ends.download = "ok";
  assert.equal((await ends.isolate().get(await sub("7002", undefined, expiryFor(ends.now)))).status, 200, "the new day: asked again");
});

test("W5: a window that ends after midnight is kept under the date it ends on, and is still found before midnight (today's key and tomorrow's are read)", async () => {
  const r = harness({ download: "last" });
  r.now = Date.parse("2026-10-13T22:30:00Z"); // the answer says the reset is 3 hours on: 01:30 on the 14th
  await r.get(await sub("7001", undefined, expiryFor(r.now)));
  assert.deepEqual([...r.kv._m.keys()].filter((k) => k.startsWith("os:")), [COUNTER("2026-10-14")]);
  r.kv._m.delete(KEYS.quota);
  const n = r.downloadCount;
  assert.equal((await r.isolate().get(await sub("7002", undefined, expiryFor(r.now)))).headers.get("x-subfile"), "quota", "at 22:30 on the 13th, the key of the 14th is read");
  r.now = Date.parse("2026-10-14T00:30:00Z");
  assert.equal((await r.isolate().get(await sub("7002", undefined, expiryFor(r.now)))).headers.get("x-subfile"), "quota", "after midnight, today's key");
  assert.equal(r.downloadCount, n);
  r.now = Date.parse("2026-10-14T01:30:01Z");
  r.download = "ok";
  assert.equal((await r.isolate().get(await sub("7002", undefined, expiryFor(r.now)))).status, 200);
});

test("W5: an answer with no `remaining` (and a 406 for an invalid file) writes no counter and pauses nothing; a positive remaining is recorded and pauses nothing; without the KV binding the isolate's own memory pauses the same way", async () => {
  const r = harness({ download: "noremaining" });
  assert.equal((await r.get(await sub("7001"))).status, 200);
  assert.deepEqual([...r.kv._m.keys()].filter((k) => k.startsWith("os:")), [], "no quota field, nothing written");
  assert.equal((await r.isolate().get(await sub("7002"))).status, 200, "and the next download is made");
  assert.deepEqual([r.downloadCount, paused(r)], [2, []]);
  const bad = harness({ download: "invalid" });
  await bad.get(await sub("7001"));
  assert.deepEqual([...bad.kv._m.keys()].filter((k) => k.startsWith("os:")), []);
  const ok = harness();
  await ok.get(await sub("7001"));
  assert.deepEqual(JSON.parse(ok.kv._m.get(COUNTER("2026-10-13")).value), { remaining: 19, until: ok.now + 3 * 3600e3 }, "the counter is kept at every download, not only at 0");
  assert.equal((await ok.get(await sub("7002"))).status, 200);
  assert.deepEqual(paused(ok), []);
  const bare = harness({ download: "last", kv: false });
  assert.equal((await bare.get(await sub("7001"))).status, 200);
  bare.main.subfiles._mem.quotaUntil = 0; // (the older stamp is not what is under test)
  const n = bare.downloadCount;
  assert.equal((await bare.get(await sub("7002"))).headers.get("x-subfile"), "quota");
  assert.equal(bare.downloadCount, n);
  assert.equal(paused(bare).length, 1, "from memory, with no KV at all");
});

test("a KV time to live under 60 seconds (a quota that comes back in 30) is written as 60, which is the least KV accepts; a write it refuses is logged and does not fail the download", async () => {
  const r = harness({ download: (n) => (n === 1 ? "ok" : "quota") });
  r.resetIn = 30e3;
  await r.get(await sub("7001"));
  const spent = await r.get(await sub("7002"));
  assert.equal(spent.headers.get("x-subfile"), "quota");
  assert.equal(r.kv._m.get(KEYS.quota).ttl, 60, "the stamp is kept 60 seconds, not 30");
  assert.equal(r.logs.filter((l) => l.event === "subs-kv-failed").length, 0, "KV accepted the write");
  assert.equal(Number(r.kv._m.get(KEYS.quota).value), r.now + 30e3, "the stamp itself still says 30 seconds");
  r.now += 31e3;
  assert.equal((await r.get(PRIVATE + SUBS)).headers.get("x-subtitles-extras"), "3", "so the rows are back after 30 seconds, although the key lives 60");
});

test("what a download costs in KV, measured: 2 writes and 1 delete (the day's counter, the subtitle, and the failure count cleared; the counter is 19/10/2026); a failed download 1 write; a login 1 write more; HEAD and a kept subtitle none", async () => {
  const r = harness();
  await r.get(await sub("7001"));
  assert.deepEqual(r.kv.ops, [["put", KEYS.token], ["put", KEYS.remaining("2026-10-13")], ["put", KEYS.srt("7001")], ["delete", KEYS.health]], "the first download also logs in: the token is one more write");
  r.kv.ops.length = 0;
  await r.get(await sub("7002"));
  assert.deepEqual(r.kv.ops, [["put", KEYS.remaining("2026-10-13")], ["put", KEYS.srt("7002")], ["delete", KEYS.health]], "the next ones: the counter, the subtitle and 1 delete");
  r.kv.ops.length = 0;
  await r.get(await sub("7002"));
  await r.get(await sub("7001"), r.env, "HEAD");
  await r.get(PRIVATE + SUBS);
  assert.deepEqual(r.kv.ops, [], "a kept subtitle, HEAD and a listing write nothing");
  r.download = "500";
  await r.get(await sub("7003"));
  assert.deepEqual(r.kv.ops, [["put", KEYS.health]], "a failed download: 1 write");
  const pub = harness();
  await pub.get(SUBS);
  assert.deepEqual(pub.kv.ops, [], "the public address writes nothing");
});

test("under the private address every answer is `private` and sends Referrer-Policy: no-referrer — also the OPTIONS answer, an error, HEAD and a subtitles answer; the public address is as it was", async () => {
  const { get } = indexApp(ENV);
  for (const p of ["/manifest.json", "/p/night/manifest.json", "/nothing-here", "/", "/catalog/series/my-series.json", `/subtitles/movie/tt0000001/filename=${encodeURIComponent(FILE)}.json`]) {
    for (const method of ["GET", "HEAD"]) {
      const x = await get(PRIVATE + p, method);
      assert.match(x.headers.get("cache-control"), /^private/, `${method} ${p}`);
      assert.doesNotMatch(x.headers.get("cache-control"), /public/, `${method} ${p}`);
      assert.equal(x.headers.get("referrer-policy"), "no-referrer", `${method} ${p}`);
    }
    const open = await get(p);
    assert.equal(open.headers.get("referrer-policy"), null, `public ${p}`);
    assert.doesNotMatch(open.headers.get("cache-control") || "", /private/, `public ${p}`);
  }
  const files = makeFiles();
  const r = harness();
  const handle = createHandler({ store: createStore({ fetchImpl: async () => new Response(files["index.json"]), caches: undefined, log: () => {} }), subtitles: r.subtitles(), languages: r.languages, subfiles: r.subfiles(), log: () => {} });
  const options = await handle(new Request(`https://w.test${PRIVATE}/manifest.json`, { method: "OPTIONS" }), ENV, undefined);
  assert.deepEqual([options.status, options.headers.get("cache-control"), options.headers.get("referrer-policy")], [204, "private", "no-referrer"]);
  const plainOptions = await handle(new Request("https://w.test/manifest.json", { method: "OPTIONS" }), ENV, undefined);
  assert.equal(plainOptions.headers.get("cache-control"), null);
  const post = await handle(new Request(`https://w.test${PRIVATE}/manifest.json`, { method: "POST" }), ENV, undefined);
  assert.deepEqual([post.status, post.headers.get("cache-control"), post.headers.get("referrer-policy")], [405, "private", "no-referrer"]);
});

// Owner review of 8e37c23, item 6 (the OPTIONS half), 20/10/2026: with the intake off, OPTIONS on a path with an invalid owner segment was a 404 where main answers the preflight 204 for any path
// (resolvePerson ran before the OPTIONS check; 52 differences in 3076 requests, all on paths with a `u` segment). The other half, the 404 of `/k/<valid token>/u/friend-a/...` without
// `Cache-Control: private`, is NOT fixed: people.test.js "aliases, unknown and mixed private/owner routes return 404 before secrets or sources" requires that route to read no secret, and marking it private
// needs the token compared (BACKLOG, 20/10/2026, item 6).
test("OPTIONS is a 204 for any path, owner path invalid or not, as on main; under the private address it is private", async () => {
  const files = makeFiles();
  const r = harness();
  const handle = createHandler({ store: createStore({ fetchImpl: async () => new Response(files["index.json"]), caches: undefined, log: () => {} }), subtitles: r.subtitles(), languages: r.languages, subfiles: r.subfiles(), log: () => {} });
  for (const p of ["/u/nobody/manifest.json", "/%75/friend-a/manifest.json", "/u/friend-a/../x.json", "/u/u/friend-a/manifest.json", "/u/friend-a/manifest.json", "/u", "/u/"]) {
    const pre = await handle(new Request(`https://w.test${p}`, { method: "OPTIONS" }), ENV, undefined);
    assert.deepEqual([p, pre.status, pre.headers.get("cache-control"), pre.headers.get("access-control-allow-origin")], [p, 204, null, "*"], p);
    const priv = await handle(new Request(`https://w.test${PRIVATE}${p}`, { method: "OPTIONS" }), ENV, undefined);
    assert.deepEqual([p, priv.status, priv.headers.get("cache-control"), priv.headers.get("referrer-policy")], [p, 204, "private", "no-referrer"], `private ${p}`);
  }
});


test("FP video: private Board, Moods, Search and profile have IMDb hint; public and series keep all other fields", async () => {
  const { get } = indexApp(ENV);
  for (const p of ["/catalog/movie/tonight.json", "/catalog/movie/moods/genre=Nocturnal.json", "/catalog/movie/search/search=killing.json", "/p/marco/catalog/movie/tonight.json", "/catalog/series/my-series.json"]) {
    const pub = JSON.parse((await get(p)).text), priv = JSON.parse((await get(PRIVATE + p)).text);
    assert.ok(pub.metas.length > 0, p);
    for (const m of pub.metas) assert.equal(m.behaviorHints, undefined);
    for (const m of priv.metas) {
      if (m.type === "series") assert.equal(m.behaviorHints, undefined);
      else { assert.equal(m.behaviorHints?.defaultVideoId, m.id); delete m.behaviorHints.defaultVideoId; if (!Object.keys(m.behaviorHints).length) delete m.behaviorHints; }
    }
    assert.deepEqual(priv, pub, p);
  }
});
