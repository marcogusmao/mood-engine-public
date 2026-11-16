// Subtitles: the official OpenSubtitles list, put in the order that suits the file that is playing.
// The list used here is the real one the official addon gave for Paterson (tt5247022) on 10/10/2026, 100 subtitles.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeFile, groupOf, sourceOf, resolutionOf, tierOf, shape, labelOf, languageOf, languagesFor, knownLanguage, TIER, LANGUAGES, PER_LANGUAGE, parseSubtitlesPath, ownLanguageNames, wantsOwnNames, variesByUserAgent, OWN_LANGUAGE_NAMES, OWN_NAMES, OWN_NAMES_USER_AGENT } from "../src/subtitles.js";
import { createSubtitleSource, createJsonCache, LIST_TTL_MS, LIST_STALE_MS, EXACT_TTL_MS, EXACT_RETRY_MS, LIST_TIMEOUT_MS, MAX_LIST_BYTES, whyOf, withDeadline, TimedOut } from "../src/subtitles-source.js";
import { createHandler } from "../src/handler.js";
import { createStore } from "../src/store.js";
import { parseExtras, decode } from "../src/extras.js";
import { makeFiles } from "./fixture.js";
import { createLanguageSource, parseLanguages, languageFromFile } from "../src/film-languages.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "opensubtitles-v3-paterson-tt5247022.json"), "utf8"));
const FILE = "Paterson.2016.1080p.BluRay.X264-AMIABLE.mkv";
const REST_REAL = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "opensubtitles-rest-paterson-1cddc37a1943f1ae.json"), "utf8")); // the REST answer for this hash, 10/10/2026, trimmed to the fields used
const HASH = "1cddc37a1943f1ae", SIZE = "8530919858";

// ── the release group of a file name ─────────────────────────────────────────

test("groupOf: '-GROUP' at the end, '[GROUP]' anywhere, 'x265-RARBG', and nothing when the tail is only a quality tag", () => {
  assert.equal(groupOf("Paterson.2016.1080p.BluRay.X264-AMIABLE.mkv"), "AMIABLE");
  assert.equal(groupOf("Paterson.2016.720p.BluRay.X264-AMIABLE"), "AMIABLE", "no extension");
  assert.equal(groupOf("Movie.2010.1080p.BluRay.x265-RARBG.mkv"), "RARBG");
  assert.equal(groupOf("Movie.2010.720p.BluRay.x264-[EtHD].mkv"), "EtHD");
  assert.equal(groupOf("Movie 2010 [1080p] [EtHD].mkv"), "EtHD", "the last bracket that is not a quality tag");
  assert.equal(groupOf("[EtHD] Movie 2010 [1080p].mkv"), "EtHD", "a quality tag after it does not hide it");
  assert.equal(groupOf("[OldTag] Movie 2010 [NewGroup].mkv"), "NewGroup", "two groups in brackets: the last");
  assert.equal(groupOf("[SubsPlease] Some Show - 01 (1080p) [ABCD1234].mkv"), "SubsPlease", "an anime name ends with the CRC, which is not a group");
  assert.equal(groupOf("Movie.2016.1080p.WEB-DL.DD5.1.H264-FGT.mkv"), "FGT");
  assert.equal(groupOf("Movie.2016.1080p.WEB-DL.mkv"), null, "'DL' is half of 'WEB-DL', not a group");
  assert.equal(groupOf("Movie.2016.1080p.Blu-Ray.mkv"), null);
  assert.equal(groupOf("Movie.2016.1080p.BluRay.x264.mkv"), null);
  assert.equal(groupOf("Movie.2016.[1080p].mkv"), null);
  assert.equal(groupOf("Paterson.2016.1080p.BluRay.REMUX.AVC.DTS-HD.MA5.1-RM.srt"), "RM");
  for (const none of ["", null, undefined, "movie.mkv"]) assert.equal(groupOf(none), null, String(none));
});

test("sourceOf and resolutionOf: the words release names use", () => {
  for (const [text, want] of [["Paterson.2016.1080p.BluRay.X264-AMIABLE", "bluray"], ["Movie.Blu-Ray.mkv", "bluray"], ["Movie.BDRip.x264", "bluray"], ["Movie.BRRip", "bluray"], ["Movie.REMUX.1080p", "bluray"],
    ["Movie.1080p.WEB-DL.DD5.1", "web-dl"], ["Movie.WEBDL", "web-dl"], ["Movie.WEBRip.x264", "webrip"], ["Movie.WEB-Rip", "webrip"], ["Movie.720p.HDTV.x264", "hdtv"], ["Movie.DVDRip", null], ["Movie", null], [null, null], ["BluRay", "bluray"], ["WEB-DL", "web-dl"]])
    assert.equal(sourceOf(text), want, String(text));
  for (const [text, want] of [["Movie.1080p.x", "1080p"], ["Movie.2160p.UHD", "2160p"], ["Movie.4K.HDR", "2160p"], ["Movie.UHD.BluRay", "2160p"], ["Movie.720p", "720p"], ["Movie 480p", "480p"], ["Movie.2016", null], ["Movie.10800p", null], ["Movie.1080px", null], [null, null]])
    assert.equal(resolutionOf(text), want, String(text));
  assert.deepEqual(describeFile(FILE), { filename: FILE, group: "AMIABLE", source: "bluray", resolution: "1080p" });
  assert.deepEqual(describeFile(undefined), { filename: null, group: null, source: null, resolution: null });
});

// ── the tiers ────────────────────────────────────────────────────────────────

const sub = (o) => ({ id: "1", url: "https://subs5.strem.io/en/download/x/src-api/file/555", lang: "eng", movieReleaseName: "Other.Movie.2000.DVDRip.XviD-NOPE", releaseGroup: "NOPE", releaseFormat: "DVD", ...o });

test("tierOf: exact when OpenSubtitles says the hash matches (by the subtitle's id or by the number its address ends with); same release by group; by source and resolution; nothing", () => {
  const file = describeFile(FILE);
  assert.equal(tierOf(sub({ id: "6926279" }), file, new Set(["6926279"])), TIER.EXACT, "REST legacy_subtitle_id = the official id");
  assert.equal(tierOf(sub({ id: "6926279" }), file, new Set([6926279].map(String))), TIER.EXACT);
  assert.equal(tierOf(sub({ id: "42", url: "https://subs5.strem.io/en/download/x/src-api/file/1955506864" }), file, new Set(["1955506864"])), TIER.OTHER, "a number that merely equals the one the address ends with is NOT a match: REST file_id is a different numbering (measured on Paterson, they never agree)");
  assert.equal(tierOf(sub({ id: "42" }), file, new Set(["999"])), TIER.OTHER, "the hash matched other subtitles, not this one");
  assert.equal(tierOf(sub({ id: "642" }), file, new Set(["6926279", "42"])), TIER.OTHER, "whole ids only: '42' is not '642'");
  assert.equal(tierOf(sub({ id: 6926279 }), file, new Set(["6926279"])), TIER.EXACT, "an id that arrives as a number");
  assert.equal(tierOf(sub({ releaseGroup: "AMIABLE" }), file), TIER.RELEASE, "same group");
  assert.equal(tierOf(sub({ releaseGroup: "amiable" }), file), TIER.RELEASE, "whatever the case");
  assert.equal(tierOf(sub({ releaseGroup: undefined, movieReleaseName: "Paterson.2016.720p.BluRay.X264-AMIABLE" }), file), TIER.RELEASE, "no releaseGroup field: the one in the release name");
  assert.equal(tierOf(sub({ releaseGroup: undefined, movieReleaseName: undefined, subtitleFileName: "Paterson.2016.720p.BluRay.X264-AMIABLE.srt" }), file), TIER.RELEASE, "…or in the subtitle's file name");
  assert.equal(tierOf(sub({ releaseGroup: "FGT", releaseFormat: "BluRay", movieReleaseName: "Paterson.2016.1080p.BluRay.x264-FGT" }), file), TIER.RELEASE, "another group, same source and same resolution");
  assert.equal(tierOf(sub({ releaseGroup: "FGT", releaseFormat: "BluRay", movieReleaseName: "Paterson.2016.720p.BluRay.x264-FGT" }), file), TIER.OTHER, "same source, another resolution");
  assert.equal(tierOf(sub({ releaseGroup: "FGT", releaseFormat: "WEB-DL", movieReleaseName: "Paterson.2016.1080p.WEB-DL.H264-FGT" }), file), TIER.OTHER, "same resolution, another source");
  assert.equal(tierOf(sub({ releaseGroup: undefined, releaseFormat: undefined, movieReleaseName: "Paterson.2016.1080p.BluRay" }), file), TIER.RELEASE, "no format field: the source in the release name");
  assert.equal(tierOf(sub({}), file), TIER.OTHER);
  // the file says nothing: nothing can be the same
  const unknown = describeFile(undefined);
  assert.equal(tierOf(sub({ releaseGroup: "AMIABLE", movieReleaseName: "Paterson.2016.1080p.BluRay.X264-AMIABLE" }), unknown), TIER.OTHER);
  assert.equal(tierOf(sub({}), describeFile("Movie.mkv")), TIER.OTHER);
  // a file with a source but no resolution does not match on source alone
  assert.equal(tierOf(sub({ releaseGroup: "X", releaseFormat: "BluRay", movieReleaseName: "Paterson.2016.1080p.BluRay.x264-X" }), describeFile("Paterson.2016.BluRay.mkv")), TIER.OTHER);
});

// ── the list ─────────────────────────────────────────────────────────────────

test("shape on the real list for Paterson: exact first, then same release, then the rest; English then Portuguese (BR) then (PT); the official order inside a tier; labels say the language first and the tier or, for the rest, the release at the end", () => {
  const file = describeFile(FILE);
  const exactIds = new Set(["6926336", "7123797"]); // an English 720p AMIABLE and a bare Portuguese "Paterson.2016", made exact by the hash (their ids)
  const out = shape(REAL.subtitles, file, exactIds);
  assert.ok(out.length <= 3 * PER_LANGUAGE && out.length > 20);
  const by = (lang) => out.filter((o) => o.lang === lang);
  assert.deepEqual([by("eng").length, by("pob").length, by("por").length], [12, 7, 5], "everything the list has in the three languages (none over 15)");
  assert.deepEqual(out.map((o) => o.lang).filter((l, i, a) => a.indexOf(l) === i), ["eng", "pob", "por"], "English, Portuguese (BR), Portuguese (PT)");
  assert.deepEqual(by("eng").slice(0, 3).map((o) => o.id), ["moodsubs-6926336", "moodsubs-6926279", "moodsubs-6926337"], "the exact one first, then the others of the same release in the official order");
  assert.equal(by("eng")[0].label, "English 1 ✓ · BluRay · AMIABLE");
  assert.equal(by("eng")[1].label, "English 2 ≈ · BluRay · AMIABLE");
  assert.equal(by("por")[0].id, "moodsubs-7123797");
  assert.equal(by("por")[0].label, "PT-PT 1 ✓");
  assert.equal(by("por")[1].label, "PT-PT 2 ≈ · BluRay · AMIABLE");
  assert.equal(by("pob")[0].label, "PT-BR 1 ≈ · BluRay · AMIABLE");
  assert.doesNotMatch(by("pob")[1].label, /[✓≈]|exact|same release/, "no mark when it is only a subtitle of the film");
  assert.equal(by("pob")[1].label, "PT-BR 2 · BluRay · LEGENDA AMARELA", "the film title no longer hides the release details");
  const tiers = (lang) => by(lang).map((o) => (o.label.includes("✓") ? 2 : o.label.includes("≈") ? 1 : 0));
  for (const l of ["eng", "pob", "por"]) assert.deepEqual(tiers(l), [...tiers(l)].sort((a, b) => b - a), `${l}: tiers never go back up`);
  for (const o of out) {
    assert.match(o.id, /^moodsubs-\d+$/);
    assert.match(o.url, /^https:\/\/subs\d*\.strem\.io\//);
    assert.deepEqual(Object.keys(o).sort(), ["id", "label", "lang", "url"]);
  }
  assert.equal(new Set(out.map((o) => o.id)).size, out.length, "no subtitle twice");
  // with no hash match at all, the same file: no ✓ anywhere
  assert.ok(!shape(REAL.subtitles, file, new Set()).some((o) => o.label.includes("✓")));
  // the languages other than the three are left out
  const langs = new Set(REAL.subtitles.map((s) => s.lang));
  assert.ok(langs.has("spa") && langs.has("heb"), "the official list has other languages");
  assert.ok(out.every((o) => ["eng", "por", "pob"].includes(o.lang)));
});

test("shape: at most 15 a language; the variants of the language codes are the same language; a subtitle with no address or no id is dropped; a repeated id once", () => {
  const many = Array.from({ length: 40 }, (_, i) => sub({ id: String(100 + i), url: `https://s.test/file/${i}`, lang: "eng", movieReleaseName: `R${i}`, releaseGroup: i === 39 ? "AMIABLE" : "X" }));
  const out = shape(many, describeFile(FILE));
  assert.equal(out.length, PER_LANGUAGE);
  assert.equal(out[0].id, "moodsubs-139", "the last of the 40 is the only one of the file's release, so it comes first and is not cut by the limit");
  assert.deepEqual(out.slice(1).map((o) => o.id), many.slice(0, 14).map((s) => `moodsubs-${s.id}`), "then the official order");
  const variants = [sub({ id: "1", lang: "pt-BR", url: "https://s.test/file/1" }), sub({ id: "2", lang: "pt-pt", url: "https://s.test/file/2" }), sub({ id: "3", lang: "pt", url: "https://s.test/file/3" }), sub({ id: "4", lang: "PT_BR", url: "https://s.test/file/4" }), sub({ id: "5", lang: "en", url: "https://s.test/file/5" }), sub({ id: "6", lang: "fra", url: "https://s.test/file/6" })];
  const v = shape(variants, describeFile(null));
  assert.deepEqual(v.map((o) => [o.id, o.lang]), [["moodsubs-5", "en"], ["moodsubs-1", "pt-BR"], ["moodsubs-4", "PT_BR"], ["moodsubs-2", "pt-pt"], ["moodsubs-3", "pt"]], "the code is the source's own; the grouping is ours");
  assert.deepEqual(shape([sub({ id: "1", url: undefined }), sub({ id: undefined }), null, sub({ id: "7", url: "https://s.test/file/7" }), sub({ id: "7", url: "https://s.test/file/70" })], describeFile(null)).map((o) => o.id), ["moodsubs-7"]);
  assert.deepEqual(shape(undefined, describeFile(null)), []);
  assert.deepEqual(shape([], describeFile(null)), []);
  assert.deepEqual(LANGUAGES.map((l) => l.key), ["eng", "pob", "por"]);
  assert.equal(languageOf("xx"), null);
  assert.equal(languageOf(undefined), null);
  assert.equal(shape(many, describeFile(FILE), new Set(), { perLanguage: 3 }).length, 3);
  assert.equal(labelOf(LANGUAGES[0], TIER.OTHER, sub({ movieReleaseName: "A".repeat(200) })).length < 90, true, "a long release name is cut");
});

// Signed 13/10/2026: the Stremio Desktop picker ("Subtitles Variants") shows `label` INSTEAD of the language, and the 12/10 label ("✓ Exact · <release>", or just
// the release) left a row as "Profondo Rosso - …" or "DVDRip.XviD-LAJ…" with no language. Marco chose language + mark, the release only at the end. What broke
// was labelOf() building the label from [mark, release] without the language name.
const NAMES = ["English", "Português (BR)", "Português (PT)"];
const SHORT = ["English", "PT-BR", "PT-PT"]; // what the label uses (13/10/2026): ~18 characters are visible in the Stremio Desktop selector
test("labelOf: language names stay recognizable in every tier, with the alternative before release details", () => {
  const sample = { movieReleaseName: "Paterson.2016.1080p.BluRay.X264-AMIABLE.srt" };
  LANGUAGES.forEach((language, i) => {
    assert.equal(language.name, NAMES[i]);
    for (const [tier, mark] of [[TIER.EXACT, " ✓"], [TIER.RELEASE, " ≈"], [TIER.OTHER, ""]]) {
      assert.equal(labelOf(language, tier, sample, 15), `${SHORT[i]} 15${mark} · BluRay · AMIABLE`);
      assert.equal(labelOf(language, tier, {}, 15), `${SHORT[i]} 15${mark}`);
      assert.ok(`${SHORT[i]} 15${mark}`.length <= 15, "language, number and mark fit the character budget; device pixels still need validation");
    }
  });
});

test("labels for a series episode (tt0944947:1:1): the same language-first labels, and the language of a row is its own", async () => {
  const r = app({ rest: "ok" });
  const env = { OPENSUBTITLES_API_KEY: "k" };
  const ep = await r.private(`/subtitles/series/tt0944947%3A1%3A1/videoHash=${HASH}&filename=${encodeURIComponent("Game.of.Thrones.S01E01.1080p.BluRay.x264-AMIABLE.mkv")}.json`, env);
  assert.equal(ep.status, 200);
  assert.ok(ep.json.subtitles.length > 0);
  const nameOf = { [OWN.eng]: "English", [OWN.pob]: "PT-BR", [OWN.por]: "PT-PT" }; // (the answer's `lang` is the language's own name since 14/11/2026: OWN, below app())
  for (const o of ep.json.subtitles) assert.match(o.label, new RegExp(`^${nameOf[o.lang]} [1-9][0-9]?(?: [✓≈])?(?: · .+)?$`), `${o.id}: ${o.label}`);
  assert.ok(ep.json.subtitles.some((o) => o.label === "English 1 ✓ · BluRay · AMIABLE"), "the hash match marks an episode's subtitle too");
  assert.ok(ep.json.subtitles.some((o) => o.label.includes(" ≈")), "control: the labels are not all one kind");
  assert.ok(ep.json.subtitles.some((o) => / · /.test(o.label)));
});

test("shape: the tier is in the label and never in the id — the same file with and without the hash match gets the same ids (stremio-web may ask twice and keeps the first entry per id)", () => {
  const file = describeFile(FILE);
  const plain = shape(REAL.subtitles, file, new Set());
  const withHash = shape(REAL.subtitles, file, new Set(["6926336", "7123797"]));
  for (const o of [...plain, ...withHash]) assert.match(o.id, /^moodsubs-\d+$/);
  assert.deepEqual(plain.map((o) => o.id).sort(), withHash.map((o) => o.id).sort(), "the hash changes the order and the marks, not which ids there are or what they are");
  assert.notDeepEqual(plain.map((o) => o.label), withHash.map((o) => o.label), "control: the marks do differ");
});

// ── the source: the official list and the REST call ──────────────────────────

function rig({ rest = "ok", list = "ok" } = {}) {
  const r = { calls: [], now: 5_000_000, logs: [], restBehaviour: rest, listBehaviour: list, edge: new Map(), languageCalls: [], languagesBehaviour: "ok", languages: { v: 1, builtAt: "2026-10-12T22:20:29.536Z", pt: "|0000009|0000022|", known: "|0000001|0000003|0000011|" } };
  r.fetchImpl = async (url, init = {}) => {
    r.calls.push({ url: String(url), init });
    if (/^https:\/\/opensubtitles-v3\.strem\.io(?::443)?\//.test(String(url))) {
      if (r.listBehaviour === "down") throw new Error("down");
      if (r.listBehaviour === "500") return new Response("no", { status: 500 });
      if (r.listBehaviour === "html") return new Response("<html>", { status: 200 });
      if (r.listBehaviour === "empty") return new Response(JSON.stringify({ cacheMaxAge: 1 }), { status: 200 });
      if (r.listBehaviour === "string") return new Response(JSON.stringify({ subtitles: "none" }), { status: 200 });
      if (r.listBehaviour === "hang") return new Promise(() => {}); // never answers and ignores the signal
      if (r.listBehaviour === "hang-body") return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"subtitles":[')); /* and then nothing */ init.signal.addEventListener("abort", () => { try { c.error(new Error("aborted")); } catch { /* closed */ } }); } }), { status: 200 }); // headers at once, a body that never arrives
      if (r.listBehaviour === "hang-body-deaf") return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"subtitles":[')); } }), { status: 200 }); // the same, and nothing heeds the signal
      if (r.listBehaviour === "hang-signal") return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      if (r.listBehaviour === "bigheader") return new Response(JSON.stringify({ subtitles: [] }), { status: 200, headers: { "content-length": String(MAX_LIST_BYTES + 1) } });
      if (r.listBehaviour === "bigstream") { r.listCancelled = false; r.listPulled = 0; return new Response(new ReadableStream({ pull(c) { r.listPulled++; if (r.listPulled > 12) return c.close(); c.enqueue(new Uint8Array(500000).fill(32)); }, cancel() { r.listCancelled = true; } }), { status: 200 }); }
      return new Response(JSON.stringify(REAL));
    }
    if (String(url).startsWith("https://api.opensubtitles.com/api/v1/")) {
      if (r.restBehaviour === "429") return new Response("slow down", { status: 429 });
      if (r.restBehaviour === "401") return new Response("no key", { status: 401 });
      if (r.restBehaviour === "throw") throw new Error("network");
      if (r.restBehaviour === "html") return new Response("<html>", { status: 200 });
      if (r.restBehaviour === "hang") return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      // the shape measured live on 10/10/2026 (Paterson, 29 results, 3 matching, the matching ones first): data[].attributes.{moviehash_match, legacy_subtitle_id, files[].file_id}
      return new Response(JSON.stringify({ total_pages: 1, total_count: 4, per_page: 50, page: 1, data: [
        { id: "9001", type: "subtitle", attributes: { subtitle_id: "9001", language: "en", moviehash_match: true, legacy_subtitle_id: 6926336, release: "Paterson.2016.720p.BluRay.X264-AMIABLE", files: [{ file_id: 1955506864, cd_number: 1, file_name: "x.srt" }] } },
        { id: "9002", type: "subtitle", attributes: { subtitle_id: "9002", language: "pt-BR", moviehash_match: true, legacy_subtitle_id: 6926794, files: [{ file_id: 1955999999 }, { file_id: 1955999998 }] } },
        { id: "9003", type: "subtitle", attributes: { subtitle_id: "9003", language: "en", moviehash_match: false, legacy_subtitle_id: 5555, files: [{ file_id: 7777 }] } },
        { id: "9004", type: "subtitle", attributes: { subtitle_id: "9004", language: "en", legacy_subtitle_id: 4444, files: [{ file_id: 6666 }] } },
      ] }));
    }
    if (String(url).endsWith("/film-languages.json")) { // the build's data/film-languages.json (lib/index-export.js languagesFile)
      r.languageCalls.push({ url: String(url), init });
      const b = r.languagesBehaviour;
      if (b === "throw") throw new Error("network");
      if (b === "missing") return new Response("Not Found", { status: 404 });
      if (b === "html") return new Response("<html>", { status: 200 });
      if (b === "version2") return new Response(JSON.stringify({ ...r.languages, v: 2 }), { status: 200 });
      if (b === "no-bars") return new Response(JSON.stringify({ v: 1, pt: "0000009", known: "0000001" }), { status: 200 });
      if (b === "hang") return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      return new Response(JSON.stringify(r.languages), { status: 200 });
    }
    throw new Error(`unexpected ${url}`);
  };
  r.caches = { default: { match: async (u) => { const v = r.edge.get(u); return v ? new Response(v.text, { headers: { "x-fetched-at": String(v.at) } }) : undefined; }, put: async (u, res) => { r.edge.set(u, { text: await res.text(), at: Number(res.headers.get("x-fetched-at")) }); } } };
  r.source = (o = {}) => createSubtitleSource({ fetchImpl: r.fetchImpl, caches: r.caches, now: () => r.now, log: (e) => r.logs.push(e), restTimeoutMs: 30, ...o });
  r.languageSource = (o = {}) => createLanguageSource({ fetchImpl: r.fetchImpl, caches: r.caches, now: () => r.now, log: (e) => r.logs.push(e), timeoutMs: 30, ...o });
  r.rest = () => r.calls.filter((c) => c.url.startsWith("https://api.opensubtitles.com"));
  r.official = () => r.calls.filter((c) => /^https:\/\/opensubtitles-v3\.strem\.io(?::443)?\//.test(c.url));
  return r;
}
const KEY = { OPENSUBTITLES_API_KEY: "secret-key-123" };

test("exact: with the key and a hash, the REST search is asked (sorted lower-case parameters, Api-Key and User-Agent headers) and the legacy_subtitle_id of each result whose moviehash_match is true is kept; false or missing is not a match, and a file_id is not an id of the official list", async () => {
  const r = rig(), s = r.source();
  const got = await s.exact(KEY, "movie", "tt5247022", HASH);
  assert.equal(got.status, "ok");
  assert.deepEqual([...got.ids].sort(), ["6926336", "6926794"]);
  const [call] = r.rest();
  assert.equal(call.url, "https://api.opensubtitles.com/api/v1/subtitles?imdb_id=5247022&languages=en%2Cpt-br%2Cpt-pt&moviehash=1cddc37a1943f1ae");
  assert.equal(call.init.headers["Api-Key"], "secret-key-123");
  assert.match(call.init.headers["User-Agent"], /^MoodEngine v3\.3\.0$/);
  assert.equal(call.init.headers.accept, "application/json");
});

test("the REAL REST answer for Paterson's hash (29 results, 3 with moviehash_match true, listed first): its ids against the official list — only one of the three is in the list, by id; a file_id never is", async () => {
  const r = rig();
  r.fetchImpl = async (url, init) => (String(url).startsWith("https://api.opensubtitles.com/") ? new Response(JSON.stringify(REST_REAL)) : rig().fetchImpl(url, init));
  const got = await r.source().exact(KEY, "movie", "tt5247022", HASH);
  assert.deepEqual([...got.ids].sort(), ["12765656", "12765658", "6927142"], "the legacy_subtitle_id of the three that matched");
  assert.equal(REST_REAL.data.filter((d) => d.attributes.moviehash_match === true).length, 3);
  assert.ok(REST_REAL.data.slice(0, 3).every((d) => d.attributes.moviehash_match === true), "the matching ones come first");
  const out = shape(REAL.subtitles, describeFile(FILE), got.ids);
  const exact = out.filter((o) => o.label.includes("✓"));
  assert.deepEqual(exact.map((o) => [o.id, o.lang]), [["moodsubs-6927142", "pob"]], "the two English subtitles that match the hash are not in the official list, so nothing in it can be marked for them");
  const fileNumbers = new Set(REAL.subtitles.map((s) => (s.url.match(/\/file\/(\d+)/) || [])[1]));
  for (const d of REST_REAL.data) for (const f of d.attributes.files) assert.ok(!fileNumbers.has(String(f.file_id)), `REST file_id ${f.file_id} is not the number any official address ends with`);
});

test("exact: an episode is searched by parent_imdb_id, season_number and episode_number (still sorted); the hash is lower-cased", async () => {
  const r = rig(), s = r.source();
  await s.exact(KEY, "series", "tt0944947:1:2", "1CDDC37A1943F1AE");
  await s.exact(KEY, "movie", "tt5247022", "1CDDC37A1943F1AE");
  assert.match(r.rest()[1].url, /moviehash=1cddc37a1943f1ae$/, "a film's hash too");
  assert.equal(r.rest()[0].url, "https://api.opensubtitles.com/api/v1/subtitles?episode_number=2&languages=en%2Cpt-br%2Cpt-pt&moviehash=1cddc37a1943f1ae&parent_imdb_id=0944947&season_number=1");
});

test("exact: no key, or no hash, or a hash that is not 16 hex digits: the REST API is not asked and nothing fails", async () => {
  const r = rig(), s = r.source();
  assert.deepEqual(await s.exact({}, "movie", "tt5247022", HASH), { ids: new Set(), extras: [], status: "no-key" });
  assert.deepEqual(await s.exact({ OPENSUBTITLES_API_KEY: "" }, "movie", "tt5247022", HASH), { ids: new Set(), extras: [], status: "no-key" });
  for (const bad of [undefined, "", "abc", "zzzzzzzzzzzzzzzz", "1cddc37a1943f1aeee"]) assert.equal((await s.exact(KEY, "movie", "tt5247022", bad)).status, "no-hash", String(bad));
  assert.equal(r.rest().length, 0);
});

test("exact: cached 24 hours per hash and title; after that it is asked again", async () => {
  const r = rig(), s = r.source();
  await s.exact(KEY, "movie", "tt5247022", HASH);
  r.now += 23 * 60 * 60e3;
  assert.equal((await s.exact(KEY, "movie", "tt5247022", HASH)).status, "ok");
  assert.equal(r.rest().length, 1, "23 hours later: no second call");
  await s.exact(KEY, "movie", "tt5247022", "ffffffffffffffff");
  assert.equal(r.rest().length, 2, "another hash is another file");
  r.now += 2 * 60 * 60e3;
  await s.exact(KEY, "movie", "tt5247022", HASH);
  assert.equal(r.rest().length, 3, "25 hours later: asked again");
  assert.equal(EXACT_TTL_MS, 24 * 60 * 60e3);
  // a new isolate (nothing in memory) finds the answer in the Cache API
  const fresh = r.source();
  r.now -= 0;
  await fresh.exact(KEY, "movie", "tt5247022", HASH);
  assert.equal(r.rest().length, 3, "read from the Cache API, not asked");
});

test("exact: a REST call that fails — 429, 401, a network error, a page that is not JSON, a timeout — gives no exact tier, is logged without the key, is not cached for a day, and is not repeated for 5 minutes", async () => {
  for (const behaviour of ["429", "401", "throw", "html", "hang"]) {
    const r = rig({ rest: behaviour }), s = r.source();
    const got = await s.exact(KEY, "movie", "tt5247022", HASH);
    assert.deepEqual([got.status, got.ids.size], ["failed", 0], behaviour);
    assert.ok(r.logs.some((l) => l.event === "opensubtitles-rest-failed"), behaviour);
    assert.ok(!JSON.stringify(r.logs).includes("secret-key-123"), `${behaviour}: the key is never logged`);
    assert.equal((await s.exact(KEY, "movie", "tt5247022", HASH)).status, "paused", `${behaviour}: not asked again at once`);
    assert.equal(r.rest().length, 1, behaviour);
    r.now += EXACT_RETRY_MS + 1;
    r.restBehaviour = "ok";
    assert.equal((await s.exact(KEY, "movie", "tt5247022", HASH)).status, "ok", `${behaviour}: after 5 minutes it is asked again, and it works`);
  }
});

test("exact: a failed REST call logs the first 6 characters of the hash and nothing else about the file — not the whole hash, not the title's id — and the cache logs of that key say the same (W3, 13/10/2026: the event carried `hash` and `id`; the cache key `exact2:<hash>:<id>` was in two more)", async () => {
  for (const behaviour of ["429", "throw"]) {
    const r = rig({ rest: behaviour }), s = r.source();
    await s.exact(KEY, "movie", "tt5247022", HASH);
    const ev = r.logs.find((l) => l.event === "opensubtitles-rest-failed");
    assert.ok(ev, behaviour);
    assert.equal(ev.hashPrefix, HASH.slice(0, 6), behaviour);
    assert.ok(!("id" in ev) && !("hash" in ev), `${behaviour}: no id and no hash key`);
    assert.ok(!Object.values(ev).includes(HASH), `${behaviour}: no value is the whole hash`);
    assert.ok(!JSON.stringify(r.logs).includes(HASH) && !JSON.stringify(r.logs).includes("tt5247022"), `${behaviour}: nowhere in the logs`);
  }
  // the cache's own failure logs carry the key: for a hash search it is the short form too
  const cacheFails = { default: { match: async () => { throw new Error("edge down"); }, put: async () => { throw new Error("edge down"); } } };
  const r = rig(), s = r.source({ caches: cacheFails });
  assert.equal((await s.exact(KEY, "movie", "tt5247022", HASH)).status, "ok");
  assert.ok(r.logs.some((l) => l.event === "cache-read-failed") && r.logs.some((l) => l.event === "cache-write-failed"));
  assert.ok(!JSON.stringify(r.logs).includes(HASH), "cache-read-failed and cache-write-failed do not carry the hash");
  const r2 = rig({ rest: "ok" }), s2 = r2.source();
  await s2.exact(KEY, "movie", "tt5247022", HASH);
  r2.now += EXACT_TTL_MS + 1;
  r2.restBehaviour = "throw";
  await s2.exact(KEY, "movie", "tt5247022", HASH);
  const stale = r2.logs.find((l) => l.event === "subtitles-source-failed");
  assert.ok(stale && stale.haveStale === true && !JSON.stringify(stale).includes(HASH), "subtitles-source-failed does not carry the hash");
});

test("list: the official list is cached an hour per title (memory, then the Cache API); the last good copy is served for up to a day when the source fails; with none, the error goes up", async () => {
  const r = rig(), s = r.source();
  const a = await s.list({}, "movie", "tt5247022");
  assert.deepEqual([a.from, a.subs.length], ["source", 100]);
  assert.equal(r.official()[0].url, "https://opensubtitles-v3.strem.io/subtitles/movie/tt5247022.json");
  r.now += LIST_TTL_MS - 1000;
  assert.equal((await s.list({}, "movie", "tt5247022")).from, "memory");
  assert.equal(r.official().length, 1);
  assert.equal((await s.list({}, "series", "tt0944947:1:1")).from, "source");
  assert.equal(r.official()[1].url, "https://opensubtitles-v3.strem.io/subtitles/series/tt0944947%3A1%3A1.json");
  // another isolate: the Cache API
  assert.equal((await r.source().list({}, "movie", "tt5247022")).from, "cache");
  assert.equal(r.official().length, 2);
  // past the hour with the source down: the stale copy
  r.now += 2000;
  r.listBehaviour = "down";
  const stale = await s.list({}, "movie", "tt5247022");
  assert.deepEqual([stale.from, stale.subs.length], ["stale", 100]);
  assert.ok(r.logs.some((l) => l.event === "subtitles-source-failed" && l.haveStale));
  r.now += LIST_STALE_MS;
  await assert.rejects(s.list({}, "movie", "tt5247022"), /down/, "a copy older than a day is not served");
  for (const bad of ["500", "html", "empty", "string"]) { const x = rig({ list: bad }); await assert.rejects(x.source().list({}, "movie", "tt1"), /HTTP 500|not a subtitles answer|not valid JSON/, bad); assert.equal(x.edge.size, 0, `${bad}: nothing is kept`); }
  assert.equal((await r.source({ }).list({ SUBTITLES_SOURCE: "https://other.test/" }, "movie", "tt5247022").catch(() => ({ from: "failed" }))).from, "failed", "SUBTITLES_SOURCE points elsewhere (the fake knows only the official address)");
});

// ── the official list has a time limit, a size limit and a host (W2, 13/10/2026: it had none of the three) ──

test("list: 10 seconds and 2 MB are the limits, and the fetch gets a signal", async () => {
  assert.equal(LIST_TIMEOUT_MS, 10e3);
  assert.equal(MAX_LIST_BYTES, 2e6);
  const r = rig();
  await r.source().list({}, "movie", "tt5247022");
  assert.ok(r.official()[0].init.signal instanceof AbortSignal, "the official list's fetch carries a signal");
});

test("list: a source that never answers is given up inside the time limit, whether it heeds the signal or not, and the failure is logged without the title", { timeout: 5000 }, async () => {
  for (const mode of ["hang", "hang-signal"]) {
    const r = rig({ list: mode });
    const t0 = Date.now();
    await assert.rejects(r.source({ listTimeoutMs: 30 }).list({}, "movie", "tt5247022"), /timed out/, mode);
    assert.ok(Date.now() - t0 < 1000, `${mode}: gave up in time`);
    assert.ok(r.official()[0].init.signal.aborted, `${mode}: the request was aborted`);
    const failed = r.logs.find((l) => l.event === "subtitles-source-failed");
    assert.ok(failed && /timed out/.test(failed.error) && !JSON.stringify(failed).includes("tt5247022"), mode);
  }
  // with a good copy older than the hour the stale one is served, as for any failure
  const r = rig();
  const s = r.source({ listTimeoutMs: 30 });
  await s.list({}, "movie", "tt5247022");
  r.now += LIST_TTL_MS + 1;
  r.listBehaviour = "hang";
  assert.equal((await s.list({}, "movie", "tt5247022")).from, "stale");
});

test("withDeadline: the answer or the error of the callee passes through, a callee that outlasts the time is a TimedOut with its signal aborted, and no timer is left running after any of the three", async () => {
  const timers = () => process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
  const before = timers();
  assert.equal(await withDeadline(3600e3, async (signal) => { assert.equal(signal.aborted, false); return "answer"; }), "answer");
  assert.equal(timers(), before, "no timer left after an answer (a limit of an hour would keep the process alive)");
  await assert.rejects(withDeadline(3600e3, async () => { throw new Error("HTTP 500"); }), /HTTP 500/);
  assert.equal(timers(), before, "no timer left after an error");
  let seen;
  await assert.rejects(withDeadline(20, (signal) => { seen = signal; return new Promise(() => {}); }), (e) => e instanceof TimedOut && e.message === "timed out");
  assert.equal(seen.aborted, true);
  assert.equal(timers(), before, "no timer left after a timeout");
});

test("list: the time limit covers the BODY: headers at once and a body that never arrives is a timed out inside the limit, whether the stream heeds the signal or not (W2 review, 13/10/2026: reading the body outside the limit left 238 of 238 green)", { timeout: 5000 }, async () => {
  for (const mode of ["hang-body", "hang-body-deaf"]) {
    const r = rig({ list: mode });
    const t0 = Date.now();
    await assert.rejects(r.source({ listTimeoutMs: 30 }).list({}, "movie", "tt5247022"), /timed out/, mode);
    assert.ok(Date.now() - t0 < 1000, `${mode}: gave up in time`);
    assert.equal(r.edge.size, 0, `${mode}: nothing kept`);
  }
});

test("list: a body over the limit is refused (declared length: unread; streamed: cancelled at the limit) and a copy in hand is not replaced", async () => {
  const header = rig({ list: "bigheader" });
  await assert.rejects(header.source().list({}, "movie", "tt5247022"), /body too big/);
  assert.equal(header.edge.size, 0, "nothing kept");
  const stream = rig({ list: "bigstream" });
  await assert.rejects(stream.source().list({}, "movie", "tt5247022"), /body too big/);
  assert.equal(stream.listCancelled, true, "cancelled");
  assert.ok(stream.listPulled <= 6, `not read to the end (${stream.listPulled} chunks of 500 KB)`);
  assert.equal(stream.edge.size, 0);
  const failed = stream.logs.find((l) => l.event === "subtitles-source-failed");
  assert.match(failed.error, /body too big/);
  // a small injected limit: one byte over fails, the exact size passes
  const size = new TextEncoder().encode(JSON.stringify(REAL)).byteLength;
  const exact = rig();
  assert.equal((await exact.source({ maxListBytes: size }).list({}, "movie", "tt5247022")).subs.length, 100, "exactly at the limit");
  const over = rig();
  await assert.rejects(over.source({ maxListBytes: size - 1 }).list({}, "movie", "tt5247022"), /body too big/, "one byte over");
  const kept = rig();
  const s = kept.source();
  await s.list({}, "movie", "tt5247022");
  kept.now += LIST_TTL_MS + 1;
  kept.listBehaviour = "bigstream";
  assert.equal((await s.list({}, "movie", "tt5247022")).from, "stale", "the copy in hand is served");
});

test("list: the official list is asked only on an allowed host over https: other hosts, other schemes, an IP, and settings the URL parser reads as another host than the text says are refused before anything is sent; :443 is fine", async () => {
  const refused = [
    "https://opensubtitles-v3.strem.io.evil.example", "https://evil.example", "https://127.0.0.1", "https://localhost", "https://other.test/", "https://mirror.example/",
    "http://opensubtitles-v3.strem.io", "ftp://opensubtitles-v3.strem.io", "ws://opensubtitles-v3.strem.io", "//opensubtitles-v3.strem.io", "opensubtitles-v3.strem.io",
    "https://opensubtitles-v3.strem.io@evil.example", "https://opensubtitles-v3.strem.io:pw@evil.example/x", "https://user@opensubtitles-v3.strem.io",
    "https://evil.example?@opensubtitles-v3.strem.io", "https://evil.example#@opensubtitles-v3.strem.io", "https://evil.example/@opensubtitles-v3.strem.io",
    "https://opensubtitles-v3.strem.io\\@evil.example", "https://opensubtitles-v3%2Estrem.io", "https://opensubtitles-v3\uFF0Estrem.io", "https://opensubtitles-v3.str\tem.io", "https://opensubtitles\uFF0Dv3.strem.io",
    "https://opensubtitles-v3.strem.io:8443", "https://opensubtitles-v3.strem.io:80", "not an address", "https://",
  ];
  for (const bad of refused) {
    const r = rig();
    await assert.rejects(r.source().list({ SUBTITLES_SOURCE: bad }, "movie", "tt5247022"), /unexpected source host/, JSON.stringify(bad));
    assert.equal(r.calls.length, 0, `${JSON.stringify(bad)}: fetchImpl was not called`);
  }
  // allowed: the default, with a trailing slash, with :443
  for (const good of [undefined, "https://opensubtitles-v3.strem.io", "https://opensubtitles-v3.strem.io/", "https://opensubtitles-v3.strem.io:443"]) {
    const r = rig();
    assert.equal((await r.source().list(good === undefined ? {} : { SUBTITLES_SOURCE: good }, "movie", "tt5247022")).subs.length, 100, String(good));
    assert.equal(new URL(r.official()[0].url).host, "opensubtitles-v3.strem.io", String(good));
  }
  // the title's id and type cannot change the host: they are escaped
  const r = rig();
  for (const [type, id] of [["movie", "tt1/../../evil.example"], ["movie", "@evil.example"], ["movie", "tt1?x=1#y"], ["mov/ie", "tt1"]]) await r.source().list({}, type, id).catch(() => {});
  assert.ok(r.official().length === 4 && r.calls.every((c) => new URL(c.url).host === "opensubtitles-v3.strem.io"), "every address asked is on the official host");
  assert.equal(whyOf(new Error("unexpected source host")), "Error: unexpected source host");
  assert.equal(whyOf(new Error("timed out")), "Error: timed out");
});

test("the cache of JSON values is bounded: the oldest entries go first", async () => {
  const c = createJsonCache({ caches: undefined, max: 3 });
  for (let i = 0; i < 6; i++) await c.through(`k${i}`, { ttlMs: 1e9, load: async () => i });
  assert.deepEqual([...c._memory.keys()], ["k3", "k4", "k5"]);
});

// ── the whole request ────────────────────────────────────────────────────────

function app(options) {
  const r = rig(options);
  const files = makeFiles();
  const DIR = "https://pages.test/data/";
  const fetchImpl = async (url, init) => (String(url).startsWith(DIR) ? new Response(files[String(url).slice(DIR.length)] || "no", { status: files[String(url).slice(DIR.length)] ? 200 : 404 }) : r.fetchImpl(url, init));
  const handle = createHandler({ store: createStore({ fetchImpl, caches: undefined, log: () => {} }), subtitles: r.source(), languages: r.languageSource() });
  r.get = async (p, env = {}, headers = {}) => { const res = await handle(new Request("https://w.test" + p, { headers }), { INDEX_URL: `${DIR}index.json`, ...env }, undefined); const text = await res.text(); return { status: res.status, headers: res.headers, text, json: JSON.parse(text) }; }; // `headers`: the request's (the User-Agent decides the names of `lang`, 14/11/2026)
  r.private = (p, env = {}, headers = {}) => r.get(`/k/${PRIVATE_TOKEN}${p}`, { SUBTITLES_PRIVATE_TOKEN: PRIVATE_TOKEN, ...env }, headers); // the hash search is made only here (W4, 19/10/2026)
  r.handle = handle;
  return r;
}
const PRIVATE_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
/** What the Worker's ANSWER says in `lang` to every app since 14/11/2026 (Marco: a name of its own, not the code; src/subtitles.js OWN_LANGUAGE_NAMES and OWN_NAMES_USER_AGENT). Written down here, not read from the code under test. shape() itself still gives the codes. */
const OWN = { eng: "English · Mood", pob: "Português (Brasil) · Mood", por: "Português (Portugal) · Mood" };
/** How the Stremio app of a Samsung TV presents itself (the part measured on Marco's UN75RU7100 on 14/11/2026, in AIOStreams, is "SMART-TV; LINUX; Tizen 5.0"; the rest of the text is a usual one for such a set), and apps that are not it. Every one of them gets the same answer today; they are told apart only where a test hands an expression as the criterion. */
const TIZEN = { "User-Agent": "Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) 69.0.3497.106/5.0 TV Safari/537.36" };
const NOT_TIZEN = [
  ["no User-Agent at all", {}], ["an empty User-Agent", { "User-Agent": "" }],
  ["Android TV (the TCL)", { "User-Agent": "Mozilla/5.0 (Linux; Android 12; 55C6K Build/STT1.220915.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Safari/537.36" }],
  ["the Mac app", { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) QtWebEngine/5.15.2 Chrome/83.0.4103.122 Safari/537.36 StremioShell/5.1.28" }],
  ["a browser", { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15" }],
  ["another TV system (webOS)", { "User-Agent": "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36 WebAppManager" }],
  ["a script", { "User-Agent": "curl/8.7.1" }],
];
const PATH = `/subtitles/movie/tt5247022/videoHash=${HASH}&videoSize=${SIZE}&filename=${encodeURIComponent(FILE)}.json`;

test("/subtitles: without the key, the file's name alone puts the same release first; the answer is {subtitles, cacheMaxAge} with CORS and an hour of cache", async () => {
  const r = app();
  const res = await r.get(PATH);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
  assert.equal(res.json.cacheMaxAge, 3600);
  assert.equal(res.headers.get("x-subtitles-exact"), "public", "the public address makes no hash search, key or not (W4)");
  assert.equal((await r.private(PATH)).headers.get("x-subtitles-exact"), "no-key", "the private address without the key: no search either, and the header says why");
  assert.equal(res.headers.get("x-subtitles-file"), "AMIABLE bluray 1080p");
  assert.equal(res.headers.get("x-subtitles"), `${res.json.subtitles.length} from 100`);
  assert.equal(res.json.subtitles[0].label, "English 1 ≈ · BluRay · AMIABLE");
  assert.ok(!res.json.subtitles.some((s) => s.label.includes("✓")), "no exact level without the key");
  assert.equal(r.rest().length, 0);
});

test("/subtitles: the extras in any order and URL-encoded; on the private address with the key (W4: the public address makes no hash search), the hash puts the exact subtitles first; if the REST call fails the answer is the same-release one", async () => {
  const r = app({ rest: "ok" });
  const env = { OPENSUBTITLES_API_KEY: "k" };
  const swapped = `/subtitles/movie/tt5247022/filename=${encodeURIComponent(FILE)}&videoSize=${SIZE}&videoHash=${HASH}.json`;
  const a = await r.private(swapped, env), b = await r.private(PATH, env);
  assert.deepEqual(a.json, b.json);
  assert.equal(a.headers.get("x-subtitles-exact"), "ok (2 ids)");
  const eng = a.json.subtitles.filter((s) => s.lang === OWN.eng);
  // the stub says the hash matched legacy id 6926336 (and a file_id equal to the number where 6926279's address ends: that must NOT make 6926279 exact)
  assert.deepEqual(eng.slice(0, 3).map((s) => s.label), ["English 1 ✓ · BluRay · AMIABLE", "English 2 ≈ · BluRay · AMIABLE", "English 3 ≈ · BluRay · AMIABLE"]);
  assert.equal(eng[0].id, "moodsubs-6926336");
  assert.equal(eng[1].id, "moodsubs-6926279", "same release, not exact, in the official order");
  assert.equal(a.json.subtitles.find((s) => s.lang === OWN.pob).label, "PT-BR 1 ✓ · BluRay · AMIABLE", "6926794 is the pob AMIABLE one");
  const down = app({ rest: "429" });
  const c = await down.private(PATH, env);
  assert.equal(c.status, 200);
  assert.equal(c.headers.get("x-subtitles-exact"), "failed");
  assert.equal(c.json.subtitles[0].label, "English 1 ≈ · BluRay · AMIABLE", "the same-release order, as without a key");
  assert.ok(!c.json.subtitles.some((s) => s.label.includes("✓")));
});

test("/subtitles: no file name and no hash (some players send neither) still answers with the official list in the official order; an episode id works; nonsense gives no subtitles; a source that is down gives no subtitles for 30 seconds", async () => {
  const r = app();
  const plain = await r.get("/subtitles/movie/tt5247022.json");
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get("x-subtitles-file"), "unknown");
  assert.ok(plain.json.subtitles.length > 20 && !plain.json.subtitles.some((s) => s.label.includes("≈") || s.label.includes("✓")));
  assert.deepEqual(plain.json.subtitles.filter((s) => s.lang === OWN.eng).map((s) => s.id), REAL.subtitles.filter((s) => s.lang === "eng").map((s) => `moodsubs-${s.id}`), "the official order");
  const ep = await r.get(`/subtitles/series/tt0944947%3A1%3A1/filename=${encodeURIComponent("Game.of.Thrones.S01E01.1080p.BluRay.x264-DEMAND.mkv")}.json`);
  assert.equal(ep.status, 200);
  assert.equal(r.official().at(-1).url, "https://opensubtitles-v3.strem.io/subtitles/series/tt0944947%3A1%3A1.json");
  assert.equal(ep.headers.get("x-subtitles-file"), "DEMAND bluray 1080p");
  for (const bad of ["/subtitles/movie/notatitle.json", "/subtitles/movie/tt12abc.json", "/subtitles/tv/tt5247022.json", "/subtitles/movie/tt5247022:1:1x.json", "/subtitles/series/tt5247022:1.json"]) {
    const x = await r.get(bad);
    assert.deepEqual([x.status, x.json.subtitles], [200, []], bad);
    assert.equal(x.headers.get("x-subtitles"), "not-a-title");
  }
  const calls = r.official().length;
  await r.get("/subtitles/movie/tt1234567.json");
  const dead = app({ list: "down" });
  const d = await dead.get(PATH);
  assert.deepEqual([d.status, d.json.subtitles, d.headers.get("cache-control"), d.headers.get("x-subtitles")], [200, [], "public, max-age=30", "source-down"]);
  assert.ok(calls < r.official().length + 1);
  assert.equal((await r.get("/subtitles")).status, 404, "not a subtitles request");
  assert.equal(parseSubtitlesPath("/catalog/movie/x.json", parseExtras, decode), null);
});

test("/subtitles: the official list and the hash search are asked TOGETHER (the answer waits for the slower, not for both): the list is held back until the hash search has started", async () => {
  const r = rig();
  let released; const gate = new Promise((res) => { released = res; });
  const inner = r.fetchImpl;
  r.fetchImpl = async (url, init) => { if (String(url).startsWith("https://api.opensubtitles.com")) released(); if (String(url).startsWith("https://opensubtitles-v3.strem.io")) await gate; return inner(url, init); };
  const files = makeFiles();
  const DIR = "https://pages.test/data/";
  const h = createHandler({ store: createStore({ fetchImpl: async (u) => new Response(files[String(u).slice(DIR.length)] || "no", { status: 200 }), caches: undefined, log: () => {} }), subtitles: r.source(), languages: r.languageSource() });
  const outcome = await Promise.race([h(new Request(`https://w.test/k/${PRIVATE_TOKEN}${PATH}`), { OPENSUBTITLES_API_KEY: "k", SUBTITLES_PRIVATE_TOKEN: PRIVATE_TOKEN }, undefined).then((x) => x.status), new Promise((res) => setTimeout(() => res("waited for ever"), 1500))]);
  assert.equal(outcome, 200);
});

test("the manifest declares the subtitles resource for movies and series with the IMDb prefix, next to the catalogs", async () => {
  const r = app();
  const res = await r.get("/manifest.json");
  assert.deepEqual(res.json.resources, ["catalog", { name: "subtitles", types: ["movie", "series"], idPrefixes: ["tt"] }]);
  assert.equal(res.json.catalogs.length, 9);
});

// ── the film's language decides the languages (Marco, 10/10/2026) ─────────────
// Signed 12/10/2026: "original audio + English subtitle; Portuguese only for a film in Portuguese". What these guard: the order for a Portuguese
// film (pob, por, eng), English alone for any other known language, the fallback to Portuguese when the list has no English, today's order when
// the language is not known, and that the language is read only from an index the isolate already holds (it never makes subtitles wait or fail).

const keysOf = (list) => list.map((l) => l.key);
const ALL = new Set(["eng", "pob", "por"]);
const langsOf = (rows) => [...new Set(rows.map((r) => languageOf(r.lang).key))];

test("knownLanguage: a code, lower-cased and trimmed; nothing, a blank and TMDB's 'xx' (no spoken language) are not a language", () => {
  assert.equal(knownLanguage("pt"), "pt");
  assert.equal(knownLanguage(" SV "), "sv");
  for (const none of [undefined, null, "", "   ", "xx", "XX"]) assert.equal(knownLanguage(none), null, JSON.stringify(none));
});

test("languagesFor: Portuguese film → pob, por, English; another known language → English only; unknown → English, pob, por (the order before this rule)", () => {
  assert.deepEqual(keysOf(languagesFor("pt", ALL)), ["pob", "por", "eng"]);
  assert.deepEqual(keysOf(languagesFor(" PT ", ALL)), ["pob", "por", "eng"], "case and spaces do not matter");
  for (const other of ["en", "sv", "fr", "ja", "cn", "zh"]) assert.deepEqual(keysOf(languagesFor(other, ALL)), ["eng"], other);
  for (const unknown of [undefined, null, "", "  ", "xx"]) assert.deepEqual(keysOf(languagesFor(unknown, ALL)), ["eng", "pob", "por"], JSON.stringify(unknown));
  assert.deepEqual(keysOf(languagesFor()), ["eng", "pob", "por"], "no argument at all");
});

test("languagesFor: a film in another language whose list has no English keeps the Portuguese ones; the fallback is for that case only", () => {
  assert.deepEqual(keysOf(languagesFor("sv", new Set(["pob", "por"]))), ["pob", "por"]);
  assert.deepEqual(keysOf(languagesFor("sv", new Set(["por"]))), ["pob", "por"], "the missing one simply has no rows");
  assert.deepEqual(keysOf(languagesFor("sv", new Set(["eng", "pob", "por"]))), ["eng"], "with English the Portuguese ones stay out");
  assert.deepEqual(keysOf(languagesFor("sv", new Set(["eng"]))), ["eng"]);
  assert.deepEqual(keysOf(languagesFor("pt", new Set(["eng"]))), ["pob", "por", "eng"], "a Portuguese film never needs the fallback");
  assert.deepEqual(keysOf(languagesFor(null, new Set(["pob"]))), ["eng", "pob", "por"], "an unknown language never reads `available`");
});

test("shape with the film's language on the real list for Paterson (12 eng, 7 pob, 5 por): 'pt' lists pob, then por, then English; 'sv' English only; unknown or 'xx' exactly as before", () => {
  const file = describeFile(FILE);
  const before = shape(REAL.subtitles, file);
  assert.deepEqual(langsOf(before), ["eng", "pob", "por"]);
  assert.deepEqual(shape(REAL.subtitles, file, new Set(), { filmLanguage: null }), before);
  assert.deepEqual(shape(REAL.subtitles, file, new Set(), { filmLanguage: "xx" }), before);
  const byLang = (l) => before.filter((r) => languageOf(r.lang).key === l);
  const pt = shape(REAL.subtitles, file, new Set(), { filmLanguage: "pt" });
  assert.deepEqual(pt, [...byLang("pob"), ...byLang("por"), ...byLang("eng")], "the same rows and labels, only the order of the languages changes");
  assert.equal(pt[0].lang, "pob");
  assert.deepEqual(langsOf(pt), ["pob", "por", "eng"]);
  const sv = shape(REAL.subtitles, file, new Set(), { filmLanguage: "sv" });
  assert.deepEqual(sv, byLang("eng"));
  assert.ok(sv.length > 0 && sv.every((r) => r.lang === "eng" && r.id.startsWith("moodsubs-")));
});

test("shape with the film's language: English missing from the list → the Portuguese ones (pob, por) for another language; 'pt' keeps pob, por; the tiers, the 15 a language and the labels are untouched", () => {
  const file = describeFile(FILE);
  const noEnglish = REAL.subtitles.filter((s) => languageOf(s.lang) !== LANGUAGES[0]);
  const sv = shape(noEnglish, file, new Set(), { filmLanguage: "sv" });
  assert.deepEqual(langsOf(sv), ["pob", "por"]);
  assert.deepEqual(sv, shape(noEnglish, file));
  assert.deepEqual(shape(noEnglish, file, new Set(), { filmLanguage: "pt" }), sv);
  const unusable = REAL.subtitles.map((s) => (languageOf(s.lang) === LANGUAGES[0] ? { ...s, url: "" } : s)); // English rows exist but none can be offered: same as none
  assert.deepEqual(langsOf(shape(unusable, file, new Set(), { filmLanguage: "sv" })), ["pob", "por"]);
  assert.deepEqual(shape([], file, new Set(), { filmLanguage: "sv" }), []);
  assert.deepEqual(shape(undefined, file, new Set(), { filmLanguage: "pt" }), []);
  const many = Array.from({ length: 40 }, (_, i) => sub({ id: String(i + 1), lang: "pob" }));
  assert.equal(shape(many, file, new Set(), { filmLanguage: "pt" }).length, PER_LANGUAGE);
  assert.equal(shape(many, file, new Set(), { filmLanguage: "pt", perLanguage: 2 }).length, 2);
  const exact = shape(REAL.subtitles, file, new Set(["6926794"]), { filmLanguage: "pt" });
  assert.equal(exact[0].label, "PT-BR 1 ✓ · BluRay · AMIABLE", "6926794 is the pob AMIABLE one: exact first inside its language");
});

test("parseLanguages and languageFromFile: Portuguese is 'pt', any other real language 'other', the rest null; an id is never matched as part of another; a file that is not the build's is refused", () => {
  const file = parseLanguages(JSON.stringify({ v: 1, builtAt: "x", pt: "|0000009|0111161|", known: "|0000001|0050083|", extra: "dropped" }));
  assert.deepEqual(file, { v: 1, pt: "|0000009|0111161|", known: "|0000001|0050083|" });
  assert.equal(languageFromFile(file, "tt0000009"), "pt");
  assert.equal(languageFromFile(file, "tt0111161"), "pt");
  assert.equal(languageFromFile(file, "tt0000001"), "other");
  assert.equal(languageFromFile(file, "tt0050083"), "other");
  for (const tt of ["tt0000002", "tt000000", "tt00000009", "tt9", "tt111161", "tt0111", "0000009", "tt0000009:1:1", "tmdb:5", "", undefined, null]) assert.equal(languageFromFile(file, tt), null, String(tt));
  const empty = parseLanguages(JSON.stringify({ v: 1, pt: "|", known: "|" }));
  assert.equal(languageFromFile(empty, "tt0000001"), null, "an empty list is a single bar");
  for (const bad of [null, undefined, {}, { pt: "|", known: 1 }, { pt: "|1|" }, { pt: "1", known: "|" }]) assert.equal(languageFromFile(bad, "tt0000001"), null, JSON.stringify(bad));
  for (const text of ["{nope", "[]", "null", '"x"', JSON.stringify({ v: 2, pt: "|", known: "|" }), JSON.stringify({ pt: "|", known: "|" }), JSON.stringify({ v: 1, pt: "0000009", known: "|" }), JSON.stringify({ v: 1, pt: "|", known: "0000001" }), JSON.stringify({ v: 1, pt: "|" })]) assert.throws(() => parseLanguages(text), (e) => e instanceof Error, text);
});

test("the language source: the file is read once and kept (memory, then the Cache API); fresh for 30 minutes like the index, served stale for a week when the network fails, then given up on", async () => {
  const r = rig(), s = r.languageSource();
  const URL_ = "https://pages.test/data/film-languages.json";
  assert.deepEqual(await s.lookup(URL_, "tt0000009"), { language: "pt", status: "ok" });
  assert.deepEqual(await s.lookup(URL_, "tt0000001"), { language: "other", status: "ok" });
  assert.deepEqual(await s.lookup(URL_, "tt0000002"), { language: null, status: "ok" }, "a film that is in neither list is not known (and that is not a failure)");
  assert.equal(r.languageCalls.length, 1, "one fetch for three lookups");
  assert.equal(r.languageCalls[0].init.cache, "no-store", "never the edge cache: a 404 stored before the first publication must not be read back (store.js, 11/10/2026)");
  assert.equal(r.languageCalls[0].init.cf, undefined);
  const other = r.languageSource(); // a second isolate of the same data centre: the Cache API has it
  assert.equal((await other.lookup(URL_, "tt0000009")).language, "pt");
  assert.equal(r.languageCalls.length, 1, "read from the Cache API, no fetch");
  r.now += 30 * 60e3 + 1; // (literal: the 30 minutes of the index, not the constant under test)
  assert.equal((await s.lookup(URL_, "tt0000009")).language, "pt");
  assert.equal(r.languageCalls.length, 2, "after 30 minutes it is read again");
  r.languagesBehaviour = "throw";
  r.now += 30 * 60e3 + 1; // (literal: the 30 minutes of the index, not the constant under test)
  assert.deepEqual(await s.lookup(URL_, "tt0000009"), { language: "pt", status: "stale" }, "the network is down: the last good copy answers, and says it is old");
  assert.ok(r.logs.some((l) => l.event === "subtitles-source-failed" && l.haveStale === true));
  const calls = r.languageCalls.length;
  assert.deepEqual(await s.lookup(URL_, "tt0000001"), { language: "other", status: "stale" }, "and the next lookups do not wait for the failing network again");
  assert.equal(r.languageCalls.length, calls, "a minute's pause after the failure");
  r.now += 7 * 24 * 3600e3; // a week, like the index's MAX_STALE_MS
  r.languageCalls.length = 0;
  const gone = await s.lookup(URL_, "tt0000009");
  assert.deepEqual(gone, { language: null, status: "failed" }, "a week old and the network down: not known");
});

test("the language source: a file that is missing, malformed, of another version or too slow gives 'not known' without failing, is logged, and is not asked again for a minute", async () => {
  const URL_ = "https://pages.test/data/film-languages.json";
  for (const behaviour of ["missing", "html", "version2", "no-bars", "throw", "hang"]) {
    const r = rig(), s = r.languageSource({ timeoutMs: 40 });
    r.languagesBehaviour = behaviour;
    const t0 = Date.now();
    assert.deepEqual(await s.lookup(URL_, "tt0000009"), { language: null, status: "failed" }, behaviour);
    assert.ok(Date.now() - t0 < 1000, `${behaviour}: bounded by the timeout`);
    assert.ok(r.logs.some((l) => l.event === "film-languages-unavailable" && l.url === URL_), behaviour);
    assert.equal(r.languageCalls.length, 1);
    assert.deepEqual(await s.lookup(URL_, "tt0000009"), { language: null, status: "paused" }, behaviour);
    assert.equal(r.languageCalls.length, 1, `${behaviour}: not asked again within a minute`);
    r.now += 60e3 + 1;
    r.languagesBehaviour = "ok";
    assert.deepEqual(await s.lookup(URL_, "tt0000009"), { language: "pt", status: "ok" }, `${behaviour}: after a minute it asks again and recovers`);
  }
  const r = rig(), s = r.languageSource();
  for (const tt of ["tt0000009:1:1", "nope", undefined]) assert.deepEqual(await s.lookup(URL_, tt), { language: null, status: "not-a-film" });
  assert.equal(r.languageCalls.length, 0, "an episode or a bad id never fetches the file");
});

// the whole request: the language comes from the build's small file
const subPath = (tt, type = "movie") => `/subtitles/${type}/${tt}/videoHash=${HASH}&filename=${encodeURIComponent(FILE)}.json`;
const LANG = "x-subtitles-film-language";
const langs = (json) => [...new Set(json.subtitles.map((s) => s.lang))];

test("/subtitles: a film the file says is in another language gets English only; one in Portuguese gets pob, por, English; one in neither list, or not in the file, keeps English, pob, por", async () => {
  const r = app();
  const before = (await r.get(subPath("tt0000002"))).json.subtitles; // in neither list
  const byLang = (l) => before.filter((s) => s.lang === OWN[l]);
  assert.deepEqual(langs({ subtitles: before }), [OWN.eng, OWN.pob, OWN.por]);

  const other = await r.get(subPath("tt0000001"));
  assert.equal(other.status, 200);
  assert.equal(other.headers.get(LANG), "other");
  assert.equal(other.headers.get("x-subtitles-languages-file"), "ok");
  assert.deepEqual(other.json.subtitles, byLang("eng"));
  assert.ok(other.json.subtitles.length > 0);

  const pt = await r.get(subPath("tt0000009"));
  assert.equal(pt.headers.get(LANG), "pt");
  assert.equal(pt.json.subtitles[0].lang, OWN.pob);
  assert.deepEqual(pt.json.subtitles, [...byLang("pob"), ...byLang("por"), ...byLang("eng")]);
  assert.equal(pt.headers.get("x-subtitles"), `${pt.json.subtitles.length} from 100`);
  assert.equal(pt.json.cacheMaxAge, 3600);

  for (const tt of ["tt0000002", "tt5247022"]) {
    const x = await r.get(subPath(tt));
    assert.deepEqual(x.json.subtitles, before, tt);
    assert.equal(x.headers.get(LANG), "unknown", tt);
    assert.equal(x.headers.get("x-subtitles-languages-file"), "ok", "the file was read; the film is simply not in it");
  }
  assert.equal(r.languageCalls.length, 1, "one fetch of the file for all of it");
});

test("/subtitles: an episode or a series id is never looked up, even when the same number is a film in the file; the file is not even fetched for it", async () => {
  const r = app();
  const before = (await r.get(subPath("tt5247022"))).json.subtitles;
  r.languageCalls.length = 0;
  const ep = await r.get(subPath("tt0000001%3A1%3A1", "series"));
  assert.deepEqual(ep.json.subtitles, before);
  assert.equal(ep.headers.get(LANG), "unknown");
  assert.equal(ep.headers.get("x-subtitles-languages-file"), "not-a-film");
  assert.equal((await r.get(subPath("tt0000001", "series"))).headers.get(LANG), "unknown");
  assert.equal((await r.get(subPath("tt0000001%3A1%3A1", "movie"))).headers.get(LANG), "unknown");
  assert.equal(r.languageCalls.length, 0);
  assert.equal((await r.get(subPath("tt0000001"))).headers.get(LANG), "other", "control: the same film as a movie is looked up");
});

test("/subtitles: the same on every isolate — a cold one reads the file (the index is never fetched or parsed for it) and gives the language on the first request", async () => {
  const r = app();
  let indexFetches = 0;
  const DIR_ = "https://pages.test/data/";
  const store = createStore({ fetchImpl: async () => { indexFetches++; return new Response("no", { status: 404 }); }, caches: undefined, log: () => {} });
  const handle = createHandler({ store, subtitles: r.source(), languages: r.languageSource() });
  const res = await handle(new Request("https://w.test" + subPath("tt0000009")), { INDEX_URL: `${DIR_}index.json` }, undefined);
  assert.equal(res.headers.get(LANG), "pt", "the very first request on a cold isolate");
  assert.equal((await res.json()).subtitles[0].lang, OWN.pob);
  assert.equal(indexFetches, 0);
  assert.equal(r.languageCalls[0].url, `${DIR_}film-languages.json`, "next to the index");
});

test("the language source: a Cache API that never answers is cut at the timeout too, and a fetch that hangs is aborted (the connection is freed, not only ignored)", async () => {
  const URL_ = "https://pages.test/data/film-languages.json";
  const r = rig();
  const stuck = { default: { match: () => new Promise(() => {}), put: async () => {} } };
  const t0 = Date.now();
  assert.deepEqual(await r.languageSource({ caches: stuck, timeoutMs: 40 }).lookup(URL_, "tt0000009"), { language: null, status: "failed" });
  assert.ok(Date.now() - t0 < 1000);
  const h = rig();
  h.languagesBehaviour = "hang";
  await h.languageSource({ timeoutMs: 40 }).lookup(URL_, "tt0000009");
  await new Promise((res) => setTimeout(res, 120)); // (the answer and the abort are two timers set a moment apart)
  assert.equal(h.languageCalls[0].init.signal.aborted, true);
});

test("/subtitles: the official list and the language file are asked TOGETHER: the list is held back until the file has been asked for", async () => {
  const r = rig();
  let released; const gate = new Promise((res) => { released = res; });
  const inner = r.fetchImpl;
  r.fetchImpl = async (url, init) => { if (String(url).endsWith("/film-languages.json")) released(); if (String(url).startsWith("https://opensubtitles-v3.strem.io")) await gate; return inner(url, init); };
  const h = createHandler({ store: createStore({ fetchImpl: async () => new Response("no", { status: 404 }), caches: undefined, log: () => {} }), subtitles: r.source(), languages: r.languageSource() });
  const outcome = await Promise.race([h(new Request(`https://w.test${subPath("tt0000009")}`), { INDEX_URL: "https://pages.test/data/index.json" }, undefined).then((x) => x.status), new Promise((res) => setTimeout(() => res("waited for ever"), 1500))]);
  assert.equal(outcome, 200);
  // and the other way round: the language file is held back until the official list has been asked for
  const q = rig();
  let started; const gate2 = new Promise((res) => { started = res; });
  const inner2 = q.fetchImpl;
  q.fetchImpl = async (url, init) => { if (String(url).startsWith("https://opensubtitles-v3.strem.io")) started(); if (String(url).endsWith("/film-languages.json")) await gate2; return inner2(url, init); };
  const h2 = createHandler({ store: createStore({ fetchImpl: async () => new Response("no", { status: 404 }), caches: undefined, log: () => {} }), subtitles: q.source(), languages: q.languageSource({ timeoutMs: 1000 }) });
  const outcome2 = await Promise.race([h2(new Request(`https://w.test${subPath("tt0000009")}`), { INDEX_URL: "https://pages.test/data/index.json" }, undefined).then((x) => x.status), new Promise((res) => setTimeout(() => res("waited for ever"), 700))]);
  assert.equal(outcome2, 200);
});

test("/subtitles: a file that is missing, malformed or too slow never fails the subtitles: the answer is the one without the language, in time", async () => {
  const plain = (await app().get(subPath("tt0000002"))).json.subtitles;
  for (const behaviour of ["missing", "html", "version2", "no-bars", "throw", "hang"]) {
    const r = app();
    r.languagesBehaviour = behaviour;
    const t0 = Date.now();
    const x = await r.get(subPath("tt0000001"));
    assert.equal(x.status, 200, behaviour);
    assert.deepEqual(x.json.subtitles, plain, behaviour);
    assert.equal(x.headers.get(LANG), "unknown", behaviour);
    assert.equal(x.headers.get("x-subtitles-languages-file"), "failed", behaviour);
    assert.equal(x.headers.get("cache-control"), "public, max-age=300", `${behaviour}: a degraded answer (the language could not be read) is remembered for 5 minutes, not an hour`);
    assert.equal(x.json.cacheMaxAge, 300, behaviour);
    assert.ok(Date.now() - t0 < 1000, `${behaviour}: not held back`);
  }
});

test("the language source: a slow file does not lose the copy this isolate holds — the old language answers (stale), and the answer is not degraded", async () => {
  const r = app();
  assert.equal((await r.get(subPath("tt0000009"))).headers.get(LANG), "pt");
  r.now += 31 * 60e3; // the copy is now older than 30 minutes: the next lookup reads the file again
  r.languagesBehaviour = "hang";
  const slow = await r.get(subPath("tt0000009"));
  assert.equal(slow.headers.get(LANG), "pt", "the held copy answers when the read times out");
  assert.equal(slow.headers.get("x-subtitles-languages-file"), "stale");
  assert.equal(slow.headers.get("cache-control"), "public, max-age=3600", "the language is right, only its source is old: not degraded");
});

test("the language source: an isolate that holds nothing still gets the older copy from the Cache API when the network is down (stale-if-error)", async () => {
  const URL_ = "https://pages.test/data/film-languages.json";
  const r = rig();
  assert.equal((await r.languageSource().lookup(URL_, "tt0000009")).language, "pt");
  r.now += 31 * 60e3;
  r.languagesBehaviour = "throw";
  assert.deepEqual(await r.languageSource().lookup(URL_, "tt0000009"), { language: "pt", status: "stale" }, "a new isolate: empty memory, the edge copy answers");
});

test("the language source: a Cache API that stops answering does not lose the copy this isolate holds either, and the pause makes the next lookups instant", async () => {
  const URL_ = "https://pages.test/data/film-languages.json";
  const r = rig();
  let stuck = false;
  const caches = { default: { match: (u) => (stuck ? new Promise(() => {}) : r.caches.default.match(u)), put: (u, x) => r.caches.default.put(u, x) } };
  const s = r.languageSource({ caches, timeoutMs: 40 });
  assert.equal((await s.lookup(URL_, "tt0000009")).language, "pt");
  r.now += 31 * 60e3;
  stuck = true;
  const t0 = Date.now();
  assert.deepEqual(await s.lookup(URL_, "tt0000009"), { language: "pt", status: "stale" });
  assert.ok(Date.now() - t0 < 1000);
  const t1 = Date.now();
  assert.deepEqual(await s.lookup(URL_, "tt0000001"), { language: "other", status: "stale" }, "within the minute's pause: no waiting at all");
  assert.ok(Date.now() - t1 < 20);
  const cold = r.languageSource({ caches, timeoutMs: 40 });
  assert.deepEqual(await cold.lookup(URL_, "tt0000009"), { language: null, status: "failed" }, "an isolate that holds nothing has nothing to fall back on");
  assert.deepEqual(await cold.lookup(URL_, "tt0000009"), { language: null, status: "paused" });
});

test("/subtitles: when the official list is down the answer is still the empty one, whatever the language file says", async () => {
  const r = app({ list: "down" });
  const x = await r.get(subPath("tt0000009"));
  assert.deepEqual([x.status, x.json.subtitles, x.headers.get("x-subtitles")], [200, [], "source-down"]);
});

// ── what the logs and the headers may say about a file (second round of W, 13/10/2026) ──

test("logs: with the official list down, with a Cache API that fails, and with a stale copy served, no log line holds the title's id — the cache key says `list:movie`, not `list:<source>:movie:tt…` (W1 review, 13/10/2026: the list's key fell back to itself)", async () => {
  const broken = { default: { match: async () => { throw new Error("edge down"); }, put: async () => { throw new Error("edge down"); } } };
  const r = rig({ list: "down" });
  await assert.rejects(r.source().list({}, "movie", "tt5247022"), /down/);
  const w = rig(), ws = w.source({ caches: broken });
  await ws.list({}, "movie", "tt5247022"); // reads and writes of the Cache API fail: cache-read-failed, cache-write-failed
  w.now += LIST_TTL_MS + 1;
  w.listBehaviour = "down";
  assert.equal((await ws.list({}, "movie", "tt5247022")).from, "stale");
  for (const [what, logs] of [["down, nothing kept", r.logs], ["Cache API failing and a stale copy", w.logs]]) {
    assert.ok(logs.some((l) => l.event === "subtitles-source-failed"), what);
    assert.ok(!JSON.stringify(logs).includes("tt5247022"), `${what}: the id is nowhere in the logs`);
  }
  assert.ok(w.logs.some((l) => l.event === "cache-read-failed") && w.logs.some((l) => l.event === "cache-write-failed"));
  assert.equal(r.logs.find((l) => l.event === "subtitles-source-failed").key, "list:movie");
});

test("logs: a failure of the REST call is logged by its name and a fixed message, never by its text — a network error that quotes the address (hash and imdb_id) and a JSON.parse error that quotes the body say nothing of either (W1 review, 13/10/2026: `error: String(e)`)", async () => {
  const quoting = [
    ["a network error naming the address", async (url) => { throw new TypeError(`fetch failed: ${url}`); }, /^TypeError: details withheld$/],
    ["a body that is not JSON", async () => new Response("<<SECRETBODY>> not json", { status: 200 }), /^SyntaxError: details withheld$/],
    ["an HTTP status (the code's own message stays: it is what the operator needs)", async () => new Response("no", { status: 429 }), /^Error: HTTP 429$/],
  ];
  for (const [what, onRest, expected] of quoting) {
    const r = rig();
    const s = r.source({ fetchImpl: async (url, init) => (String(url).startsWith("https://api.opensubtitles.com/") ? onRest(String(url), init) : r.fetchImpl(url, init)) });
    assert.equal((await s.exact(KEY, "movie", "tt5247022", HASH)).status, "failed", what);
    const text = JSON.stringify(r.logs);
    for (const secret of [HASH, "5247022", "SECRETBODY", "imdb_id", "moviehash"]) assert.ok(!text.includes(secret), `${what}: no \`${secret}\` in the logs`);
    assert.match(r.logs.find((l) => l.event === "opensubtitles-rest-failed").error, expected, what);
  }
});

test("/subtitles: X-Subtitles-File is printable ASCII, 64 characters at most, whatever the player's file name holds — a group in Chinese, a line break inside the brackets and a 100-letter group all answer 200 (W1 review, 13/10/2026: the first made the Response constructor throw, a bare 500 with no nosniff)", async () => {
  const r = app();
  const ask = (name) => r.get(`/subtitles/movie/tt5247022/filename=${encodeURIComponent(name)}.json`);
  for (const name of ["[字幕组] Film [1080p].mkv", "Film [a\r\nb].mkv", "[a\u0007bé] Film [BluRay].mkv"]) {
    const res = await ask(name);
    assert.equal(res.status, 200, JSON.stringify(name));
    assert.match(res.headers.get("x-subtitles-file"), /^[\x20-\x7E]+$/, JSON.stringify(name));
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", JSON.stringify(name));
  }
  assert.equal((await ask("[字幕组] Film [1080p].mkv")).headers.get("x-subtitles-file"), "1080p", "what is not ASCII is dropped, the rest of the header stays");
  assert.equal((await ask(`[${"x".repeat(100)}] Film.mkv`)).headers.get("x-subtitles-file"), "x".repeat(64));
  assert.equal((await ask("Film.2016.1080p.BluRay.x264-AMIABLE.mkv")).headers.get("x-subtitles-file"), "AMIABLE bluray 1080p", "an ordinary name is unchanged");
});

// ── `lang` is a language name of the Worker's own, not a language code, for EVERY app (Marco, 14/11/2026) ───────────────────────────────
//
// On the Samsung TV the subtitles inside the file are in the list, but Stremio starts with one of this addon's. The fix Marco chose: the subtitles say in `lang` a NAME ("English · Mood") that is
// not the language's code, so an app that picks by language code is expected to land on the file's own subtitle, and these stay in the list to be picked by hand. The costs he accepted: a film
// whose file has no subtitle of its own gets none chosen by itself, on every app; and on Android TV the name of the language may show as a blank or "Unknown" (reported by others, not verified).
// The same day the main session restricted the names to the Samsung (a request with "Tizen" in its User-Agent), after the review showed the Android TV cost; asked, Marco undid that:
// "All devices, as first approved". So the criterion of the app (src/subtitles.js OWN_NAMES_USER_AGENT) is null, EVERY request gets the names, and the restriction stays in the code as an
// option: an expression in the criterion's place. What these tests hold:
//   (a) no subtitle of any answer, to any app, has a `lang` that is a language code (2 or 3 letters), a tag like pt-BR, or a text an app could split into one;
//   (b) one language, one group: the same `lang` for every subtitle of a language, whatever spelling the source used, and another for each other language;
//   (c) ids, addresses, order and the "number + version" labels of 30/10/2026 are those of shape() on the same list, which is the answer of before; with the switch off the answer IS shape()'s;
//   (d) the language rule of 10/10/2026 still orders the answer (Portuguese first only for a film in Portuguese; English alone for another language);
//   (device) every request gets the same body, identified or not, and says no `Vary`; with an expression as the criterion only the app it names gets the names, and `Vary` is said.
// What an app SHOWS for such a `lang`, and what it then picks by itself, is its own business: read in stremio-web's code (see OWN_LANGUAGE_NAMES), seen on no device.

const CODE = /^[a-z]{2,3}$/i, TAG = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})+$/i;
const wordsOf = (text) => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** Why `lang` could be read as a language code by an app, or null when it cannot. */
function codeLike(lang) {
  if (typeof lang !== "string" || !lang.trim()) return "empty";
  if (CODE.test(lang.trim())) return "a 2- or 3-letter code";
  if (TAG.test(lang.trim())) return "a tag like pt-BR";
  if (LANGUAGES.some((l) => l.codes.includes(lang.trim().toLowerCase().replace(/_/g, "-")))) return "a spelling the Worker itself reads as a code";
  const short = wordsOf(lang).find((w) => w.length <= 3);
  return short ? `it holds "${short}", a word of 3 letters or fewer` : null;
}
/** Every kind of subtitles request the Worker answers with rows, asked with `headers`: [name, answer]. Public and private, a film in another language, in Portuguese, unknown, an episode, a profile, with and without the file's name and hash. */
async function everyAnswer(headers, r = app({ rest: "ok" })) {
  const env = { OPENSUBTITLES_API_KEY: "k" };
  const episode = `/subtitles/series/tt0944947%3A1%3A1/videoHash=${HASH}&filename=${encodeURIComponent("Game.of.Thrones.S01E01.1080p.BluRay.x264-AMIABLE.mkv")}.json`;
  const asks = [
    ["public, film in another language", () => r.get(subPath("tt0000001"), {}, headers)], ["public, film in Portuguese", () => r.get(subPath("tt0000009"), {}, headers)], ["public, language unknown", () => r.get(subPath("tt5247022"), {}, headers)],
    ["public, no file name and no hash", () => r.get("/subtitles/movie/tt5247022.json", {}, headers)], ["public, an episode", () => r.get(episode, {}, headers)], ["public, under a profile", () => r.get(`/p/night${subPath("tt0000009")}`, {}, headers)],
    ["private with the key, film in Portuguese", () => r.private(subPath("tt0000009"), env, headers)], ["private with the key, language unknown", () => r.private(PATH, env, headers)], ["private with the key, an episode", () => r.private(episode, env, headers)], ["private without the key", () => r.private(PATH, {}, headers)],
  ];
  const out = [];
  for (const [name, ask] of asks) { const res = await ask(); assert.equal(res.status, 200, name); assert.ok(res.json.subtitles.length > 0, `${name}: (control: the answer has rows)`); out.push([name, res]); }
  return out;
}
/** Every kind of app the tests ask as: none, the others, the Samsung. */
const EVERY_APP = [...NOT_TIZEN, ["the Samsung TV", TIZEN]];

test("lang (a): no subtitle of any answer, to any app, public or private, film or episode, carries a language code in `lang`, nor a tag like pt-BR, nor a text with a word an app could take for a code", async () => {
  let rows = 0;
  for (const [who, headers] of [EVERY_APP[0], EVERY_APP[2], EVERY_APP.at(-1)]) for (const [name, res] of await everyAnswer(headers)) for (const s of res.json.subtitles) { rows++; assert.equal(codeLike(s.lang), null, `${who}, ${name}: ${s.id} says lang ${JSON.stringify(s.lang)}`); }
  assert.ok(rows > 450, `${rows} rows looked at`);
  // the instrument sees the defect: the codes and spellings of before are all refused by it, and so is a name that only hides one
  for (const code of ["eng", "pob", "por", "en", "pt", "PT", "pt-BR", "pt_br", "PT-PT", "ptbr", " eng ", "", "PT-BR · Mood", "en · Mood", "Mood (eng)"]) assert.notEqual(codeLike(code), null, JSON.stringify(code));
  for (const name of Object.values(OWN)) assert.equal(codeLike(name), null, name);
  assert.equal(OWN_LANGUAGE_NAMES, true, "the switch is on");
});

test("lang (device): EVERY request gets the names — with no User-Agent, as Android TV, the Mac app, a browser, a script or the Samsung, the answer is byte for byte the same, and it is the answer of before with only `lang` changed", async () => {
  const none = await everyAnswer({});
  // the answer is shape()'s rows (the answer of before; the public address makes no hash search) with `lang` renamed, written as the handler writes it
  const file = describeFile(FILE);
  for (const [i, filmLanguage] of [[0, "other"], [1, "pt"], [2, null]]) {
    const before = shape(REAL.subtitles, file, new Set(), { filmLanguage });
    assert.equal(none[i][1].text, JSON.stringify({ subtitles: ownLanguageNames(before, true), cacheMaxAge: 3600 }), `${none[i][0]}: shape()'s rows with only lang renamed`);
    assert.notEqual(none[i][1].text, JSON.stringify({ subtitles: before, cacheMaxAge: 3600 }), `${none[i][0]}: (control: not the answer with the codes)`);
  }
  assert.equal(none[7][1].text, JSON.stringify({ subtitles: ownLanguageNames(shape(REAL.subtitles, file, new Set(["6926336", "6926794"]), { filmLanguage: null }), true), cacheMaxAge: 3600 }), `${none[7][0]}: the same with the hash matches`);
  for (const [name, res] of none) for (const s of res.json.subtitles) assert.ok(Object.values(OWN).includes(s.lang), `${name}: ${s.id} says a name (${s.lang})`);
  // every app, identified or not: the very same bytes and the same headers
  for (const [who, headers] of EVERY_APP) {
    const got = await everyAnswer(headers);
    for (const [i, [name, res]] of got.entries()) {
      assert.equal(res.text, none[i][1].text, `${who}, ${name}: byte for byte the answer with no User-Agent`);
      for (const header of ["x-subtitles", "x-subtitles-exact", "x-subtitles-file", "x-subtitles-film-language", "x-subtitles-languages-file", "cache-control", "content-type", "vary"]) assert.equal(res.headers.get(header), none[i][1].headers.get(header), `${who}, ${name}: ${header}`);
    }
  }
});

test("lang (device): the answer does not depend on the app, so it says no `Vary`: the same address asked by the Samsung and by other apps, in either order and on one isolate, gives one and the same body; `Vary: User-Agent` is for a criterion that is an expression", async () => {
  for (const [what, address, cache] of [["public", (r, h) => r.get(PATH, {}, h), "public, max-age=3600"], ["private", (r, h) => r.private(PATH, { OPENSUBTITLES_API_KEY: "k" }, h), "private, max-age=3600"]]) {
    for (const order of [[TIZEN, {}, TIZEN, NOT_TIZEN[2][1], {}, TIZEN], [{}, TIZEN, {}, NOT_TIZEN[3][1], TIZEN, {}]]) {
      const r = what === "private" ? app({ rest: "ok" }) : app();
      const bodies = new Set();
      for (const headers of order) {
        const res = await address(r, headers);
        assert.equal(res.headers.get("vary"), null, `${what}: every app gets the same body, so no Vary`);
        assert.equal(res.headers.get("cache-control"), cache, what);
        assert.deepEqual([...new Set(res.json.subtitles.map((s) => s.lang))], [OWN.eng, OWN.pob, OWN.por], what);
        bodies.add(res.text);
      }
      assert.equal(bodies.size, 1, `${what}: one body for the six requests`);
      assert.equal(r.official().length, 1, `${what}: (control: the official list was fetched once for the six requests)`);
    }
  }
  assert.equal(variesByUserAgent(), false, "the criterion as it is: the answer does not vary");
  assert.equal(variesByUserAgent(null), false);
  assert.equal(variesByUserAgent(/Tizen/), true, "with an expression as the criterion the answer does vary, and the handler says Vary: User-Agent");
});

test("wantsOwnNames: the criterion as it is (null) gives the names to every request, identified or not; the switch off gives them to nobody; an expression in the criterion's place gives them only to the app it names", () => {
  assert.equal(OWN_NAMES_USER_AGENT, null, "every app (Marco, 14/11/2026: \"All devices, as first approved\")");
  assert.equal(OWN_LANGUAGE_NAMES, true);
  const everything = [undefined, null, "", TIZEN["User-Agent"], ...NOT_TIZEN.map(([, h]) => h["User-Agent"]), "Tizen", "tizen", 5, {}, ["x"]];
  for (const ua of everything) assert.equal(wantsOwnNames(ua), true, `the defaults: ${JSON.stringify(ua) ?? String(ua)}`);
  for (const ua of everything) assert.equal(wantsOwnNames(ua, true, null), true, `switch on, criterion null: ${JSON.stringify(ua) ?? String(ua)}`);
  // the switch off: nobody, whatever the criterion
  for (const ua of everything) for (const device of [null, /Tizen/, /./]) assert.equal(wantsOwnNames(ua, false, device), false, `switch off, ${device}: ${JSON.stringify(ua) ?? String(ua)}`);
  // the restriction, kept as an option: an expression where the null is
  const SAMSUNG = /Tizen/;
  assert.equal(wantsOwnNames(TIZEN["User-Agent"], true, SAMSUNG), true);
  assert.equal(wantsOwnNames("Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.0) AppleWebKit/537.36", true, SAMSUNG), true, "the part measured on the UN75RU7100");
  assert.equal(wantsOwnNames("Tizen", true, SAMSUNG), true, "a made-up User-Agent with the text gets them too");
  for (const [who, headers] of NOT_TIZEN) assert.equal(wantsOwnNames(headers["User-Agent"], true, SAMSUNG), false, who);
  for (const other of ["tizen", "TIZEN", "Mozilla/5.0 (SMART-TV; LINUX; TIZEN 5.0)", "T izen"]) assert.equal(wantsOwnNames(other, true, SAMSUNG), false, `only that spelling: ${other}`);
  for (const odd of [undefined, null, 0, 5, true, {}, [], ["Tizen"], { toString: () => "Tizen" }]) assert.equal(wantsOwnNames(odd, true, SAMSUNG), false, `what is no text: ${JSON.stringify(odd) ?? String(odd)}`);
});

test("the restriction to one kind of app still works when the criterion is an expression: only that app's rows are renamed, and every other app gets shape()'s rows untouched, byte for byte the answer of before", () => {
  const before = shape(REAL.subtitles, describeFile(FILE), new Set(["6926336"]), { filmLanguage: "pt" });
  const answer = (userAgent, device) => ownLanguageNames(before, wantsOwnNames(userAgent, true, device)); // what the handler does, with the criterion handed in
  const SAMSUNG = /Tizen/;
  assert.deepEqual(answer(TIZEN["User-Agent"], SAMSUNG), ownLanguageNames(before, true), "the Samsung: the names");
  assert.deepEqual([...new Set(answer(TIZEN["User-Agent"], SAMSUNG).map((s) => s.lang))], [OWN.pob, OWN.por, OWN.eng]);
  for (const [who, headers] of NOT_TIZEN) {
    assert.equal(answer(headers["User-Agent"], SAMSUNG), before, `${who}: shape()'s very rows`);
    assert.equal(JSON.stringify(answer(headers["User-Agent"], SAMSUNG)), JSON.stringify(before), who);
  }
  // and with the criterion as it is, null, the same request of every app is the Samsung's answer
  for (const [who, headers] of EVERY_APP) assert.deepEqual(answer(headers["User-Agent"], null), ownLanguageNames(before, true), who);
  assert.deepEqual(answer(TIZEN["User-Agent"], /Android/), before, "another expression, another app");
});

test("lang (b): one language, one group — every subtitle of a language says the same `lang`, whatever spelling the source used, and the three languages say three different ones; each starts with the language as a person reads it", async () => {
  const groups = new Map(); // lang → the languages (by the label's short name) of the rows that say it
  for (const [, res] of await everyAnswer({})) for (const s of res.json.subtitles) {
    const language = LANGUAGES.find((l) => s.label.startsWith(`${l.short} `));
    assert.ok(language, s.label);
    groups.set(s.lang, (groups.get(s.lang) || new Set()).add(language.key));
  }
  assert.deepEqual(Object.fromEntries([...groups].map(([lang, keys]) => [lang, [...keys]])), { [OWN.eng]: ["eng"], [OWN.pob]: ["pob"], [OWN.por]: ["por"] }, "three groups, one language in each");
  // the source's spellings of one language pass through shape(), each its own group ("en" beside "eng"): in the answer they are one
  const mixed = [["1", "eng"], ["2", "en"], ["3", "EN"], ["4", "pob"], ["5", "pt-BR"], ["6", "PT_BR"], ["7", "ptbr"], ["8", "por"], ["9", "pt-pt"], ["10", "pt"], ["11", "fra"]].map(([id, lang]) => ({ id, lang, url: `https://s.test/${id}.srt` }));
  const shaped = shape(mixed, describeFile(""), new Set());
  assert.deepEqual(shaped.map((o) => o.lang), ["eng", "en", "EN", "pob", "pt-BR", "PT_BR", "ptbr", "por", "pt-pt", "pt"], "(control: shape() keeps the source's spelling, seven spellings for three languages)");
  assert.deepEqual(ownLanguageNames(shaped, true).map((o) => o.lang), [OWN.eng, OWN.eng, OWN.eng, OWN.pob, OWN.pob, OWN.pob, OWN.pob, OWN.por, OWN.por, OWN.por]);
  assert.equal(new Set(Object.values(OWN)).size, 3);
  assert.deepEqual(OWN_NAMES, OWN, "the names, as written down in this file");
  assert.deepEqual(Object.keys(OWN_NAMES), LANGUAGES.map((l) => l.key), "one for each language offered");
  assert.ok(OWN.eng.startsWith("English") && OWN.pob.startsWith("Português (Brasil)") && OWN.por.startsWith("Português (Portugal)"), "readable: the language first");
  for (const name of Object.values(OWN)) { assert.ok(name.endsWith(" · Mood"), name); assert.ok(!name.includes("-") && !name.includes("_"), `${name}: no hyphen, an app may split a tag there`); }
});

test("lang (c): ids, addresses, order and the number + version labels are those of before — the answer is shape() of the same list with only `lang` changed, and with the switch off it is shape()'s rows themselves, byte for byte", async () => {
  const r = app({ rest: "ok" });
  const file = describeFile(FILE);
  // the public address: no hash search, so the answer of before is shape() over the official list and the file's name
  for (const [tt, filmLanguage] of [["tt5247022", null], ["tt0000001", "other"], ["tt0000009", "pt"]]) {
    const before = shape(REAL.subtitles, file, new Set(), { filmLanguage });
    const now = (await r.get(subPath(tt))).json.subtitles;
    assert.deepEqual(now.map(({ lang, ...rest }) => rest), before.map(({ lang, ...rest }) => rest), `${tt}: id, url and label of every row, in the same order`);
    assert.deepEqual(now.map((s) => Object.keys(s)), before.map((s) => Object.keys(s)), `${tt}: the same fields in the same order on the wire`);
    assert.deepEqual(now.map((s) => s.lang), before.map((s) => OWN[languageOf(s.lang).key]), `${tt}: lang is the name of the language the row had`);
    assert.deepEqual(now, ownLanguageNames(before, true), tt);
    // the switch off (OWN_LANGUAGE_NAMES false): what the handler computes is shape()'s rows themselves, the answer of origin/main, for every app and whatever the criterion
    for (const [who, headers] of EVERY_APP) for (const device of [null, /Tizen/]) {
      const off = ownLanguageNames(before, wantsOwnNames(headers["User-Agent"], false, device));
      assert.equal(off, before, `${tt}, switch off, ${who}: the very rows of before`);
      assert.equal(JSON.stringify({ subtitles: off, cacheMaxAge: 3600 }), JSON.stringify({ subtitles: before, cacheMaxAge: 3600 }), `${tt}, switch off, ${who}: byte for byte`);
    }
  }
  // the private address with the key: the hash search marks the exact ones (the stub: 6926336 and 6926794)
  const beforePrivate = shape(REAL.subtitles, file, new Set(["6926336", "6926794"]), { filmLanguage: null });
  const nowPrivate = (await r.private(PATH, { OPENSUBTITLES_API_KEY: "k" })).json.subtitles;
  assert.deepEqual(nowPrivate.map(({ lang, ...rest }) => rest), beforePrivate.map(({ lang, ...rest }) => rest), "private: id, url and label of every row, in the same order");
  // the labels of 30/10/2026, literally: number + version, restarting per language
  const labels = nowPrivate.map((s) => s.label);
  assert.deepEqual(labels.slice(0, 3), ["English 1 ✓ · BluRay · AMIABLE", "English 2 ≈ · BluRay · AMIABLE", "English 3 ≈ · BluRay · AMIABLE"]);
  assert.equal(nowPrivate.find((s) => s.lang === OWN.pob).label, "PT-BR 1 ✓ · BluRay · AMIABLE");
  assert.match(nowPrivate.find((s) => s.lang === OWN.por).label, /^PT-PT 1(?: [✓≈])?(?: · .+)?$/);
  for (const name of Object.values(OWN)) {
    const mine = nowPrivate.filter((s) => s.lang === name).map((s) => Number(/^\S+ (\d+)/.exec(s.label)[1]));
    assert.deepEqual(mine, mine.map((_, i) => i + 1), `${name}: numbered 1, 2, 3… inside its group`);
  }
  assert.ok(nowPrivate.every((s) => s.id.startsWith("moodsubs-") && /^https:\/\//.test(s.url)));
  assert.ok(!labels.some((l) => l.includes("Mood")), "the label does not repeat the group's name");
});

test("lang (d): the language rule still orders the answer — a film in Portuguese: Português (Brasil), Português (Portugal), English; a film in another language: English only; unknown: English, then the two Portuguese", async () => {
  const r = app();
  const groupsOf = async (tt) => [...new Set((await r.get(subPath(tt))).json.subtitles.map((s) => s.lang))];
  assert.deepEqual(await groupsOf("tt0000009"), [OWN.pob, OWN.por, OWN.eng], "a film in Portuguese");
  assert.deepEqual(await groupsOf("tt0000001"), [OWN.eng], "a film in another language");
  assert.deepEqual(await groupsOf("tt0000002"), [OWN.eng, OWN.pob, OWN.por], "language not known");
  // each language's rows are together, never interleaved
  for (const tt of ["tt0000009", "tt0000002"]) {
    const seq = (await r.get(subPath(tt))).json.subtitles.map((s) => s.lang);
    assert.deepEqual(seq.filter((l, i) => l !== seq[i - 1]), [...new Set(seq)], `${tt}: one run for each language`);
  }
  // a film in another language whose list has no English keeps the Portuguese ones (the fallback of 12/10/2026), under their own names
  const noEnglish = REAL.subtitles.filter((s) => languageOf(s.lang) !== LANGUAGES[0]);
  assert.deepEqual([...new Set(ownLanguageNames(shape(noEnglish, describeFile(FILE), new Set(), { filmLanguage: "sv" }), true).map((s) => s.lang))], [OWN.pob, OWN.por]);
});

test("ownLanguageNames: asked to (true), only `lang` changes, in place among the fields; a row whose language it does not know is left alone; nothing is mutated; not asked to, the very rows come back", () => {
  const rows = [{ id: "moodsubs-1", url: "https://s.test/1", lang: "eng", label: "English 1" }, { id: "moodsubs-2", url: "https://s.test/2", lang: "PT_BR", label: "PT-BR 1" }, { id: "x", url: "https://s.test/x", lang: "fra", label: "?" }];
  const copy = JSON.parse(JSON.stringify(rows));
  const out = ownLanguageNames(rows, true);
  assert.deepEqual(out, [{ id: "moodsubs-1", url: "https://s.test/1", lang: OWN.eng, label: "English 1" }, { id: "moodsubs-2", url: "https://s.test/2", lang: OWN.pob, label: "PT-BR 1" }, { id: "x", url: "https://s.test/x", lang: "fra", label: "?" }]);
  assert.equal(JSON.stringify(out[0]), `{"id":"moodsubs-1","url":"https://s.test/1","lang":"English · Mood","label":"English 1"}`, "the fields in the order of before");
  assert.deepEqual(rows, copy, "the rows given are not changed");
  assert.deepEqual(ownLanguageNames([], true), []);
  assert.equal(ownLanguageNames(rows, false), rows, "not asked to: the very rows, untouched");
  assert.equal(ownLanguageNames(rows), rows, "said nothing: the same (the handler says, by wantsOwnNames)");
});
