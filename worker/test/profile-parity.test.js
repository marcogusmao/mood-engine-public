// The five profiles, the Marco profile with no v2 files and the old address with no v2 files answer EXACTLY as the Worker of the reference commit 6331bd6 (the origin/main of 14/10/2026, 3.1.0 with the profiles of 3.2.0) did, over the
// same published files (Marco, 14/10/2026: "os 5 perfis NÃO mudam"). Three ways, from the strongest to the one that always runs:
//   REFERENCE_WORKER_SRC=<a copy of the reference's worker/src (commit 6331bd6, NOT today's origin/main: measured by the clean-context review of 21/10/2026: with today's origin/main 7 manifests differ, in both branches); src/list-names.js imports ../../data/list-names.{source,final}.json, so the copy needs those two files at <copy>/data/, and the copy also needs `contracts/`:
//                              git archive 6331bd6 worker contracts data/list-names.source.json data/list-names.final.json | tar -x -C <copy>>  runs the two Workers side by side over the fixture (and, in real-index.test.js, over the real build): the manifest of every address and
//                              every catalog it declares, with its menus, a decade, a second page. This is how fixtures/origin-main-answers.json was made.
//   fixtures/origin-main-answers.json  the digests of those answers (status, headers a client acts on, sha256 of the body) as the reference Worker gave them: this file is what CI compares with,
//                              because CI has no second copy of the code.
//   UPDATE_GOLDEN=1 with REFERENCE_WORKER_SRC rewrites that file (from the reference code, never from this one).
// A profile that reads a file of the v2 family, or a manifest that moves, makes a path of the golden differ.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as handlerMod from "../src/handler.js";
import * as storeMod from "../src/store.js";
import { files as legacyFiles, makeObject } from "./profile-fixture.js";
import { v2FilesOf, v2ObjectFrom } from "./fixture.js";
import { handlerOver, pathsOf, sweep, asReference, isProfileTonight, withoutTonight, isMySeries, withoutMySeries } from "./sweep.js";

const GOLDEN = new URL("./fixtures/origin-main-answers.json", import.meta.url);
const REF = process.env.REFERENCE_WORKER_SRC;
const DIR = "https://pages.test/mood-engine/data/";
const OCT = () => Date.parse("2026-10-11T23:00:00Z");
const OTHERS = ["light", "heavy", "night", "world", "critics"]; // the profiles that never change (but their version: 3.2.1 since 24/10/2026, put back to 3.2.0 by asReference)
const PREFIXES = ["", "/p/marco", ...OTHERS.map((k) => `/p/${k}`)];

const legacy = legacyFiles();
const withV2 = { ...legacy, ...v2FilesOf(v2ObjectFrom(makeObject())) };
const ours = (files, calls) => asReference(handlerOver(handlerMod, storeMod, files, { now: OCT, dir: DIR, calls })); // (asReference: the subtitles sentence of the profile manifests, and since 24/10/2026 their version, are the deliberate differences, 19/10/2026)
const reference = async (files) => {
  const dir = path.resolve(REF);
  return handlerOver(await import(pathToFileURL(path.join(dir, "handler.js")).href), await import(pathToFileURL(path.join(dir, "store.js")).href), files, { now: OCT, dir: DIR });
};
const isOther = (p) => OTHERS.some((k) => p.startsWith(`/p/${k}/`) || p === `/p/${k}`);

/** Every path to visit, found by reading the manifests of `get`: the old address, then each profile (and the pages and refusals around them). */
async function pathsFrom(get) {
  const out = [];
  for (const prefix of PREFIXES) out.push(...pathsOf(prefix, JSON.parse((await get(`${prefix}/manifest.json`)).text)), ...(prefix ? [`${prefix}/`] : ["/"]));
  out.push("/p/nobody/manifest.json", "/p/__proto__/manifest.json", "/p", "/catalog/movie/ghost.json", "/p/light/catalog/movie/tonight.json/x");
  return out;
}

const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));

test("the golden file is of the reference Worker, not of this one: it names the commit it came from and holds answers for the old address and for all six profiles", () => {
  assert.equal(golden.source, "origin/main 6331bd6 worker/src (3.1.0; profiles 3.2.0)");
  const answers = Object.keys(golden.answers);
  assert.ok(answers.length > 250, `${answers.length} answers`);
  for (const prefix of PREFIXES) assert.ok(answers.some((p) => p.startsWith(`${prefix}/catalog/movie/`)), prefix || "the old address");
  assert.ok(golden.answers["/manifest.json"].startsWith("200|application/json"));
  assert.match(golden.answers["/manifest.json"], /\|[0-9a-f]{24}$/);
});

test("no v2 file published: the old address, the Marco profile and the five others answer exactly as origin/main's Worker did — the manifests byte for byte (3.1.0 included), every declared catalog, with its menus", async () => {
  const get = ours(legacy), want = golden.answers;
  const paths = withoutMySeries(withoutTonight(Object.keys(want))); // the profiles' Tonight draws evenly since 19/10/2026 and My series has 85 titles in a weekly order since 21/10/2026: both pinned by the tests below
  const got = await sweep(get, paths);
  const wrong = paths.filter((p) => got[p] !== want[p]);
  assert.deepEqual(wrong, [], `${wrong.length} of ${paths.length} answers differ from origin/main's`);
  assert.equal(JSON.parse((await get("/manifest.json")).text).version, "3.1.0");
});

test("the v2 family published beside the legacy files: the five other profiles answer exactly the same, and not one of their requests reads a file of the v2 family", async () => {
  const calls = [];
  const get = ours(withV2, calls);
  const want = Object.fromEntries(Object.entries(golden.answers).filter(([p]) => isOther(p) && !isProfileTonight(p)));
  assert.ok(Object.keys(want).length > 100);
  const got = await sweep(get, Object.keys(want));
  const wrong = Object.keys(want).filter((p) => got[p] !== want[p]);
  assert.deepEqual(wrong, [], `${wrong.length} of ${Object.keys(want).length} answers of the five profiles moved`);
  assert.deepEqual(calls.filter((n) => /^index-v2/.test(n)), [], "a profile reads the legacy files and nothing of the v2 family");
});

// Tonight of the profiles, 19/10/2026 (Marco's questionnaire; PR #47): the draw is uniform, so the two Tonight answers that carry films (light, night) are no longer the golden's. Pinned: only these two, same status and headers, a different body.
test("the profiles' own Tonight is the one exception to the golden: exactly Light and fun and Night and horror differ (the draw is even now), with the same status, headers and count; Marco's (the Board's own), Heavy and World (empty in the fixture) still agree", async () => {
  const get = ours(legacy);
  const tonightPaths = Object.keys(golden.answers).filter(isProfileTonight);
  assert.equal(tonightPaths.length, 5, "the golden holds a bare Tonight for Marco, Light, Heavy, Night and World"); // Marco's is the Board's own Tonight (lib/rows.js, not this draw)
  const got = await sweep(get, tonightPaths);
  const moved = tonightPaths.filter((p) => got[p] !== golden.answers[p]).sort();
  assert.deepEqual(moved, ["/p/light/catalog/movie/tonight.json", "/p/night/catalog/movie/tonight.json"]);
  for (const p of moved) assert.equal(got[p].split("|").slice(0, -1).join("|"), golden.answers[p].split("|").slice(0, -1).join("|"), `${p}: only the body moved`);
});

// My series, 21/10/2026 (Marco, 20/10/2026: a bigger list with a weekly rotation; PR series-rotation): the only four golden answers that move are the row's, and they move only in the total and in the body of the full page.
test("My series is the third exception to the golden: exactly its four addresses differ (the old address and /p/marco, the row and its skip=100 page); status, content type, cache and page size are the golden's, the total is 85 where the reference said 25, and the empty page's body is the same", async () => {
  const get = ours(legacy);
  const seriesPaths = Object.keys(golden.answers).filter(isMySeries);
  assert.deepEqual(seriesPaths.sort(), ["/catalog/series/my-series.json", "/catalog/series/my-series/skip=100.json", "/p/marco/catalog/series/my-series.json", "/p/marco/catalog/series/my-series/skip=100.json"]);
  const got = await sweep(get, seriesPaths);
  for (const p of seriesPaths) {
    const [status, type, cache, total, size, profile, body] = golden.answers[p].split("|");
    const [gStatus, gType, gCache, gTotal, gSize, gProfile, gBody] = got[p].split("|");
    assert.deepEqual([gStatus, gType, gCache, gSize, gProfile], [status, type, cache, size, profile], p);
    assert.deepEqual([total, gTotal], ["25", "85"], p);
    if (p.endsWith("skip=100.json")) assert.equal(gBody, body, `${p}: an empty page is the same empty page`);
    else assert.notEqual(gBody, body, `${p}: the full page is the new list`);
  }
});

test("the v2 family published: the old address and the Marco profile DO move (the manifests, the new rows), and the version says 3.3.0", async () => {
  const get = ours(withV2);
  const got = await sweep(get, ["/manifest.json", "/p/marco/manifest.json"]);
  assert.notEqual(got["/manifest.json"], golden.answers["/manifest.json"]);
  assert.notEqual(got["/p/marco/manifest.json"], golden.answers["/p/marco/manifest.json"]);
  assert.equal(JSON.parse((await get("/manifest.json")).text).version, "3.3.0");
  const raw = handlerOver(handlerMod, storeMod, withV2, { now: OCT, dir: DIR }); // not through asReference, which puts the reference's 3.2.0 back
  assert.equal(JSON.parse((await raw("/p/marco/manifest.json")).text).version, "3.2.1");
});

test("(with REFERENCE_WORKER_SRC) side by side with origin/main's code over the fixture: the same answers, with and without the v2 family beside the legacy files", { skip: !REF }, async () => {
  const [oldLegacy, newLegacy] = [await reference(legacy), ours(legacy)];
  const paths = await pathsFrom(oldLegacy);
  assert.ok(paths.length > 250);
  const compared = withoutMySeries(withoutTonight(paths)); // the profiles' Tonight draws evenly since 19/10/2026; My series has 85 titles in a weekly order since 21/10/2026
  assert.deepEqual(await sweep(newLegacy, compared), await sweep(oldLegacy, compared));
  const [oldWith, newWith] = [await reference(withV2), ours(withV2)];
  const others = compared.filter(isOther);
  assert.deepEqual(await sweep(newWith, others), await sweep(oldWith, others));
});

test("(with REFERENCE_WORKER_SRC and UPDATE_GOLDEN=1) rewrite fixtures/origin-main-answers.json from the reference code", { skip: !(REF && process.env.UPDATE_GOLDEN) }, async () => {
  const old = await reference(legacy);
  const paths = await pathsFrom(old);
  fs.writeFileSync(GOLDEN, JSON.stringify({ source: "origin/main 6331bd6 worker/src (3.1.0; profiles 3.2.0)", made: "14/10/2026 by test/profile-parity.test.js with REFERENCE_WORKER_SRC and UPDATE_GOLDEN=1; fixture: test/profile-fixture.js, clock 2026-10-11T23:00:00Z; rewritten 20/10/2026 (description v3) from the same reference code with the digest of test/sweep.js withoutFilmDescriptions: 184 of 371 digests changed, none of status, headers or count, no manifest", answers: await sweep(old, paths) }, null, 1) + "\n");
});
