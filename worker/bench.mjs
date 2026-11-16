// node bench.mjs [path/to/docs/data]      (default ../docs/data)       RUNS=15 node bench.mjs
//
// What a COLD request costs in CPU. The free Cloudflare plan allows 10 ms of CPU per request, and a request that lands on a fresh
// isolate must parse the index first. Each scenario below is one real request through the real handler, run in a FRESH node process
// (empty heap, nothing compiled yet: the closest thing to a fresh isolate that node offers), RUNS times; the figure is the CPU time of
// the main thread (process.threadCpuUsage) around the whole request: reading the file, parsing, answering, building the response.
// Script start-up is not counted (Cloudflare counts it apart). This machine's V8 is not Cloudflare's: read the numbers against each
// other and against the same scenario on the day the index grows, not as a promise about the 10 ms.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createPageSource } from "./src/page-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS = {
  "manifest": "/manifest.json",
  "Board row (Tonight)": "/catalog/movie/tonight.json",
  "Moods: Nocturnal × 1990s": "/catalog/movie/moods/genre=Nocturnal&decade=1990s.json",
  "Friends: Watch together (William)": "/catalog/movie/friends/genre=Watch%20together%20%C2%B7%20William.json", // was World is Hell (William), 876 films, until Marco cut it on 23/10/2026; the longest option now
  "Lists: Cannes × France × 4.2+": "/catalog/movie/lists/genre=Cannes%20Winners%20(moviewithus)&country=France&rating=4.2%2B.json",
  "Lists: Criterion closet (1,506)": "/catalog/movie/lists/genre=All-time%20Criterion%20Closet%20Picks%20(closetpicks).json",
  "Lists: Good films 90 min (2,430)": "/catalog/movie/lists/genre=Good%20films%2C%2090%20min%20or%20less%20(stautis).json",
  "Explore: 1970s × Japan × 90–120": "/catalog/movie/explore/decade=1970s&country=Japan&runtime=90%E2%80%93120%20min.json",
  "Explore: no menu": "/catalog/movie/explore.json",
  "Search: japanese 1990s": "/catalog/movie/search/search=japanese+1990s.json",
  "Search: night": "/catalog/movie/search/search=night.json",
  "Search: gustavo loved": "/catalog/movie/search/search=gustavo+loved.json",
  // the profiles (src/profiles.js, 11/10/2026)
  "Profile manifest (night)": "/p/night/manifest.json",
  "Profile Tonight (night)": "/p/night/catalog/movie/tonight.json",
  "Profile Watchlist (world)": "/p/world/catalog/movie/watchlist.json",
  "Profile theme: All-time canon (9 lists)": "/p/critics/catalog/movie/theme-all-time-canon.json",
  "Profile theme: 21st century (15 lists)": "/p/critics/catalog/movie/theme-21st-century.json",
  "Profile theme: Heavy drama (lists)": "/p/heavy/catalog/movie/theme-heavy-drama.json",
  "Profile Criterion Closet · All picks": "/p/critics/catalog/movie/closet-all-picks.json",
  "What it is: Horror × 1970s": "/p/night/catalog/movie/what-it-is/genre=Horror&decade=1970s.json",
};
// the v2 family (Worker 3.3.0, 14/10/2026): run only when the folder has it (a build with a board). The four scenarios above that exist in both families (manifest, Tonight, Moods, Explore) are the ones to compare
// with the Worker of origin/main on the same folder; these four are new: a Board row from its slice, the largest mood slice (Wanderlust, 1.64 MB of text on 14/10/2026), the Friends this week option, a mood with menus.
const SCENARIOS_V2 = {
  "v2 Board row (Europe)": "/catalog/movie/europe.json",
  "v2 Moods: Wanderlust (largest slice)": "/catalog/movie/moods/genre=Wanderlust.json",
  "v2 Moods: Friends this week": "/catalog/movie/moods/genre=Friends%20this%20week.json",
  "v2 Moods: Noir × 1990s": "/catalog/movie/moods/genre=Noir&decade=1990s.json",
};
// the Discover grouped by subject (Worker 3.4.0, 22/10/2026): run only when the folder's menus carry `discover`. A calculated option reads the whole v2 index, so it is compared with "Explore: no menu";
// a list option reads the list's own piece, so TSPDT is compared with the largest of the "Lists: ..." scenarios above. Spec step 8: Brazil within 1.15 x Explore, TSPDT within 1.15 x the largest list.
const SCENARIOS_DISCOVER = {
  "Discover: Countries \u00b7 Brazil": "/catalog/movie/places/genre=Brazil.json",
  "Discover: Eras \u00b7 Nouvelle Vague + seen": "/catalog/movie/eras/genre=Nouvelle%20Vague%201958%E2%80%9373&seen=Include%20seen.json",
  "Discover: Critics \u00b7 TSPDT": "/catalog/movie/critics/genre=TSPDT%201%2C000%20greatest%202026.json",
};
// Proposal 5 (Worker 3.5.0, 28/10/2026): run only when the menus carry `discover.explore` (an index built by the change of the same date). Each is compared with its kind: the genre of Genres and of Explore, the director's card and the
// theme with "Explore: no menu" (a calculated option reads the whole v2 index), "All friends loved" with "Lists: Good films 90 min (2,430)" (the friends' piece is a big one). Acceptance of the plan: at most 1.15 x.
const SCENARIOS_P5 = {
  "Discover: Genres \u00b7 Drama": "/catalog/movie/genres/genre=Drama.json",
  "Discover: Explore \u00b7 Drama": "/catalog/movie/explore/genre=Drama.json",
  "Discover: Directors \u00b7 Scorsese loves": "/catalog/movie/filmmaker-picks/genre=Scorsese%20loves.json",
  "Discover: Themes \u00b7 Feel something": "/catalog/movie/themes/genre=Feel%20something.json",
  "Discover: Friends \u00b7 All friends loved": "/catalog/movie/friends/genre=All%20friends%20loved.json",
};
// The pieces of the Discover's calculated options (Worker 3.5.x, 29/10/2026; lib/index-export.js optionPieces): run only when the folder has index-v2-opt-*.json. The same Genres · Drama request three ways: through its own piece (pages 1 to 3), with the pieces
// withheld (the "nopiece:" prefix makes every index-v2-opt-* a 404, which is what the Worker did before the pieces and what it does for a page past them: the whole 9 MB v2 index), and page 4, which the piece cannot give, so the cost is the
// piece asked for, found too short, and then the whole index.
const SCENARIOS_PIECES = {
  "Discover genre (Drama) via piece": "/catalog/movie/genres/genre=Drama.json",
  "Discover genre (Drama) page 3 via piece": "/catalog/movie/genres/genre=Drama&skip=200.json",
  "Discover genre (Drama) with no piece (v2)": "nopiece:/catalog/movie/genres/genre=Drama.json",
  "Discover genre (Drama) page 4 (v2 after piece)": "/catalog/movie/genres/genre=Drama&skip=300.json",
};
const cpuNow = () => { const c = process.threadCpuUsage ? process.threadCpuUsage() : process.cpuUsage(); return (c.user + c.system) / 1000; };

if (process.argv[2] === "--twice") {
  // The whole Board opened twice in one fresh process (v2): the manifest, then every movie row of it in the order of the manifest, twice. The first opening pays for the 24 KB of menus and one slice a row; the second must
  // be all memory (the row slices are permanent in the store). Prints the CPU of each opening and the sources of the answers of the second.
  const [, , , dir] = process.argv;
  const { createHandler } = await import("./src/handler.js");
  const { createStore } = await import("./src/store.js");
  const base = "https://pages.test/data/";
  const fetched = [], evicted = [];
  const fetchImpl = async (u) => { fetched.push(u.slice(base.length)); const f = path.join(dir, u.slice(base.length)); return fs.existsSync(f) ? new Response(fs.readFileSync(f, "utf8")) : new Response("nope", { status: 404 }); };
  const handle = createHandler({ store: createStore({ fetchImpl, caches: undefined, log: (o) => { if (o.event === "piece-evicted") evicted.push(o.url); } }) });
  await new Response("x").text(); new Request("https://w.test/");
  const get = async (p) => { const res = await handle(new Request("https://w.test" + p), { INDEX_URL: `${base}index.json` }); const t = await res.text(); return { res, body: JSON.parse(t) }; };
  const t0 = cpuNow();
  const ids = (await get("/manifest.json")).body.catalogs.filter((c) => c.type === "movie" && !c.extra).map((c) => c.id);
  const open = async () => { const sources = []; for (const id of ids) sources.push((await get(`/catalog/movie/${id}.json`)).res.headers.get("x-index-source")); return sources; };
  const t1 = cpuNow();
  const first = await open();
  const t2 = cpuNow();
  const before = fetched.length;
  const second = await open();
  const t3 = cpuNow();
  console.log(JSON.stringify({ rows: ids.length, manifestMs: t1 - t0, firstMs: t2 - t1, secondMs: t3 - t2, secondSources: [...new Set(second)], refetched: fetched.length - before, evicted: evicted.length, firstSources: [...new Set(first)] }));
} else if (process.argv[2] === "--mixed") {
  const dir = process.argv[3], willDir = process.argv[4] ? path.resolve(process.argv[4]) : null, base = "https://pages.test/data/", fetched = [], evicted = [];
  const { createHandler } = await import("./src/handler.js"), { createStore } = await import("./src/store.js"), { createSubtitleSource } = await import("./src/subtitles-source.js");
  const willReceipt = willDir ? JSON.parse(fs.readFileSync(path.join(willDir, "publication.json"))) : null;
  if (willReceipt) { assert.equal(willReceipt.personId, "friend-a"); assert.match(willReceipt.revision, /^r-[a-f0-9]{32}$/); }
  const fetchImpl = async u => {
    const parsed = new URL(u); assert.equal(parsed.origin, "https://pages.test");
    let file, name;
    if (u.startsWith(base)) { name = u.slice(base.length); assert.ok(!name.includes("..") && !name.includes("/")); file = path.join(dir, name); }
    else { assert.ok(willDir && willReceipt); const prefix = `/u/friend-a/r/${willReceipt.revision}/data/`; assert.ok(parsed.pathname.startsWith(prefix)); name = parsed.pathname.slice(prefix.length); assert.match(name, /^index(?:-[A-Za-z0-9_-]+)?\.json$/); file = path.join(willDir, "data", name); }
    fetched.push(parsed.pathname); return fs.existsSync(file) ? new Response(fs.readFileSync(file)) : new Response("", { status: 404 });
  };
  const pages = createPageSource({ fetchImpl, caches: undefined });
  const subsFixture = JSON.parse(fs.readFileSync(path.join(here, "test/fixtures/opensubtitles-v3-paterson-tt5247022.json")));
  const subtitles = createSubtitleSource({ fetchImpl: async () => Response.json(subsFixture), caches: undefined });
  const handle = createHandler({ store: createStore({ fetchImpl, caches: undefined, log: e => { if (e.event === "piece-evicted") evicted.push(e); } }), pages, subtitles, ...(willReceipt ? { publication: async () => ({ revision: willReceipt.revision }) } : {}), languages: { lookup: async () => ({ language: "en", status: "ok" }) } });
  const get = async p => { const r = await handle(new Request("https://w.test" + p), { INDEX_URL: base + "index.json" }); assert.equal(r.status, 200, p); return r.json(); };
  globalThis.gc?.(); const before = process.memoryUsage();
  const manifest = await get("/manifest.json");
  for (const c of manifest.catalogs.filter(c => c.type === "movie" && !c.extra)) await get(`/catalog/movie/${c.id}.json`);
  for (const p of ["/catalog/movie/explore.json", "/p/night/catalog/movie/tonight.json", "/p/world/catalog/movie/watchlist.json", "/subtitles/movie/tt5247022.json"]) await get(p);
  const names = fs.readdirSync(dir).filter(n => /^page-\d{2}\.json$/.test(n)).map(n => ({ n, bytes: fs.statSync(path.join(dir, n)).size })).sort((a, b) => b.bytes - a.bytes).slice(0, 24);
  for (const { n } of names) { const s = JSON.parse(fs.readFileSync(path.join(dir, n))); if (s.films[0]) await get(`/page/meta/movie/${s.films[0].t}.json`); }
  if (willReceipt) {
    const will = await get("/u/friend-a/manifest.json");
    for (const c of will.catalogs.filter(c => c.type === "movie" && !c.extra)) await get(`/u/friend-a/catalog/movie/${c.id}.json`);
    await get("/u/friend-a/catalog/movie/explore.json");
  }
  const previous = fetched.length;
  for (const { n } of names) { const s = JSON.parse(fs.readFileSync(path.join(dir, n))); if (s.films[0]) await get(`/page/meta/movie/${s.films[0].t}.json`); }
  globalThis.gc?.(); const after = process.memoryUsage();
  console.log(JSON.stringify({ before, after, pageShardsResident: pages._cache._memory.size, pageJsonBytes: [...pages._cache._memory.values()].reduce((n, e) => n + e.bytes, 0), pieceEvictions: evicted.length, pageRereads: fetched.length - previous, will: willReceipt ? { publicRelease: willReceipt.revision, exercised: true } : "not exercised: pass an existing public Will release directory as argument 4", runtime: process.version }));
} else if (process.argv[2] === "--child") {
  const [, , , dir, url] = process.argv;
  const { createHandler } = await import("./src/handler.js");
  const { createStore } = await import("./src/store.js");
  const base = "https://pages.test/data/";
  const calls = []; let edgeMatches = 0, edgePuts = 0;
  const edge = { default: { match: async () => { edgeMatches++; return undefined; }, put: async () => { edgePuts++; } } };
  const noPiece = url.startsWith("nopiece:");
  const fetchImpl = async (u) => {
    calls.push(u.slice(base.length));
    if (noPiece && /index-v2-opt-/.test(u)) return new Response("nope", { status: 404 });
    const f = path.join(dir, u.slice(base.length));
    return fs.existsSync(f) ? new Response(fs.readFileSync(f, "utf8")) : new Response("nope", { status: 404 });
  };
  const handle = createHandler({ store: createStore({ fetchImpl, caches: edge, log: () => {} }), pages: createPageSource({ fetchImpl, caches: edge }) });
  await new Response("x").text(); new Request("https://w.test/"); // node loads its fetch implementation on first use; workerd has it built in, so that cost is not the Worker's
  const actualUrl = url.replace(/^(?:repeat|nopiece):/, "");
  if (url.startsWith("repeat:")) { const warm = await handle(new Request("https://w.test" + actualUrl), { INDEX_URL: `${base}index.json` }); await warm.text(); calls.length = 0; edgeMatches = 0; edgePuts = 0; }
  const t0 = cpuNow();
  const res = await handle(new Request("https://w.test" + actualUrl), { INDEX_URL: `${base}index.json` });
  const text = await res.text();
  const ms = cpuNow() - t0;
  const body = JSON.parse(text);
  if (actualUrl.startsWith("/page/")) {
    assert.ok(!calls.some(n => !/^(?:page-\d{2}|index-v2-menus)\.json$/.test(n)), "no full index for pages"); assert.ok(calls.length <= 2, "at most two origin reads"); assert.ok(calls.length + edgeMatches + edgePuts <= 6, "at most six origin/cache operations");
    if (actualUrl === "/page/manifest.json") { assert.equal(body.resources[0].name, "meta"); assert.equal(calls.length, 0); }
    else { assert.ok(res.headers.get("X-Page")); if (res.status === 200) { assert.equal(body.meta.id, actualUrl.split("/").at(-1).replace(/\.json$/, "")); assert.deepEqual(body.meta.videos, []); } else assert.equal(res.status, 404); }
  }
  console.log(JSON.stringify({ ms, status: res.status, n: body.meta ? 1 : (body.metas || body.catalogs || []).length, source: res.headers.get("x-index-source"), read: calls.filter((n) => n !== "index-v2-menus.json").join("+"), page: res.headers.get("X-Page"), originReads: calls.length, edgeMatches, edgePuts }));
} else {
  const dir = path.resolve(process.argv[2] || path.join(here, "..", "docs", "data"));
  const runs = Number(process.env.RUNS) || 15;
  const mb = (f) => (fs.statSync(path.join(dir, f)).size / 1e6).toFixed(2);
  const v2 = fs.existsSync(path.join(dir, "index-v2-menus.json"));
  console.log(`cold CPU per request (main thread), ${runs} fresh processes each, node ${process.version}; whole index ${mb("index.json")} MB, Board part ${mb("index-board.json")} MB${v2 ? `; v2: whole ${mb("index-v2.json")} MB, menus ${mb("index-v2-menus.json")} MB, largest mood slice ${mb("index-v2-mood-wander.json")} MB` : ""}\n`);
  console.log("scenario".padEnd(36), "median".padStart(8), "max".padStart(8), "  items");
  const menus = v2 ? JSON.parse(fs.readFileSync(path.join(dir, "index-v2-menus.json"), "utf8")) : {};
  const discover = v2 && !!menus.discover;
  const p5 = discover && !!menus.discover.explore;
  const pieces = p5 && fs.readdirSync(dir).some((n) => /^index-v2-opt-/.test(n));
  let pageScenarios = {};
  if (v2 && fs.existsSync(path.join(dir, "page-00.json"))) {
    const names = fs.readdirSync(dir).filter(n => /^page-\d{2}\.json$/.test(n));
    const largest = names.sort((a, b) => fs.statSync(path.join(dir, b)).size - fs.statSync(path.join(dir, a)).size)[0];
    const shard = JSON.parse(fs.readFileSync(path.join(dir, largest))); const tt = shard.films[0]?.t; assert.ok(tt, "largest shard must contain a film");
    let candidate = 1; const have = new Set(shard.films.map(r => r.t)); while (have.has("tt" + candidate + shard.shard)) candidate++;
    const p = `/page/meta/movie/${tt}.json`;
    pageScenarios = { "page manifest": "/page/manifest.json", "page cold shard": p, "page absent": `/page/meta/movie/tt${candidate}${shard.shard}.json`, "page repeated": "repeat:" + p };
  }
  for (const [name, url] of Object.entries(v2 ? { ...SCENARIOS, ...SCENARIOS_V2, ...(discover ? SCENARIOS_DISCOVER : {}), ...(p5 ? SCENARIOS_P5 : {}), ...(pieces ? SCENARIOS_PIECES : {}), ...pageScenarios } : SCENARIOS)) {
    const t = [];
    let n = 0, read = "";
    for (let i = 0; i < runs; i++) {
      const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child", dir, url], { encoding: "utf8" });
      if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
      const o = JSON.parse(r.stdout);
      if (o.status !== (name === "page absent" ? 404 : 200)) { console.error(`${name}: HTTP ${o.status}`); process.exit(1); }
      t.push(o.ms); n = o.n; read = o.read;
    }
    t.sort((x, y) => x - y);
    // 24/10/2026 (Marco, literal answer "pode deixar com mais gordura"): the 10 ms gate measured here, in Node on the Mac, no longer stands. The film page's criterion is its CPU on Cloudflare (wrangler tail), cold request, applied by the main session after the publication; "up to 30 ms" is the session's reading of Marco's answer, not a number he gave (to confirm). 10 ms is the Free plan's per-request CPU limit; the live catalogs measured 8-23 ms on 24/10 and answered ok; risk: error 1102 if Cloudflare cuts above 10 ms. This figure is relative information only.
    console.log(name.padEnd(36), `${t[Math.floor(t.length / 2)].toFixed(1)} ms`.padStart(8), `${t[t.length - 1].toFixed(1)} ms`.padStart(8), `  ${n}${name in SCENARIOS_PIECES ? `  (asked: ${read})` : ""}`);
  }
  if (Object.keys(pageScenarios).length) {
    const mixed = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--mixed", dir], { encoding: "utf8" });
    if (mixed.status !== 0) { console.error(mixed.stderr); process.exit(1); }
    console.log("Mixed Node memory (not workerd or Will acceptance): " + mixed.stdout.trim());
  }
  if (v2) {
    const med = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const all = [];
    for (let i = 0; i < runs; i++) { const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--twice", dir], { encoding: "utf8" }); if (r.status !== 0) { console.error(r.stderr); process.exit(1); } all.push(JSON.parse(r.stdout)); }
    const o = all[0];
    console.log(`\nthe whole Board twice in one process (manifest, then ${o.rows} rows, then the ${o.rows} rows again; ${runs} fresh processes): manifest ${med(all.map((x) => x.manifestMs)).toFixed(1)} ms, first opening ${med(all.map((x) => x.firstMs)).toFixed(1)} ms (${o.rows} requests), second opening ${med(all.map((x) => x.secondMs)).toFixed(1)} ms; second opening sources ${JSON.stringify(o.secondSources)}, files fetched again ${o.refetched}, pieces evicted ${o.evicted}`);
  }
}
