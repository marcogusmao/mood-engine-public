import test from "node:test";
import assert from "node:assert/strict";
import { shape, describeFile, labelOf, LANGUAGES, TIER } from "../src/subtitles.js";

const row = (id, lang = "eng", extra = {}) => ({ id, lang, url: `https://s.test/${id}`, movieReleaseName: "Film.2000.1080p.BluRay.x264-AMIABLE", ...extra });

test("subtitle choices: repeated releases and exact matches remain distinct in the first 12 characters", () => {
  const list = Array.from({ length: 17 }, (_, i) => row(String(i + 1)));
  const out = shape(list, describeFile("Film.2000.1080p.BluRay.x264-AMIABLE.mkv"), new Set(["2", "4"]));
  assert.equal(out.length, 15);
  assert.deepEqual(out.slice(0, 3).map(x => x.id), ["moodsubs-2", "moodsubs-4", "moodsubs-1"]);
  assert.deepEqual(out.slice(0, 3).map(x => x.label), ["English 1 ✓ · BluRay · AMIABLE", "English 2 ✓ · BluRay · AMIABLE", "English 3 ≈ · BluRay · AMIABLE"]);
  assert.equal(new Set(out.map(x => x.label.slice(0, 12))).size, 15);
  assert.equal(out[14].label, "English 15 ≈ · BluRay · AMIABLE");
});

test("subtitle numbering: after deduplication and sorting, restarting per language including aliases", () => {
  const list = [row("bad", "eng", { url: "" }), row("a", "en"), row("a"), row("b"), row("br", "pt_BR"), row("pt", "por"), row("fr", "fra")];
  const out = shape(list, describeFile(), new Set(["b"]), { filmLanguage: "pt" });
  assert.deepEqual(out.map(({ label, ...rest }) => rest), [
    { id: "moodsubs-br", lang: "pt_BR", url: "https://s.test/br" },
    { id: "moodsubs-pt", lang: "por", url: "https://s.test/pt" },
    { id: "moodsubs-b", lang: "eng", url: "https://s.test/b" },
    { id: "moodsubs-a", lang: "en", url: "https://s.test/a" },
  ]);
  assert.deepEqual(out.map(x => x.label), ["PT-BR 1 · BluRay · AMIABLE", "PT-PT 1 · BluRay · AMIABLE", "English 1 ✓ · BluRay · AMIABLE", "English 2 · BluRay · AMIABLE"]);
  assert.deepEqual(shape(list, describeFile(), new Set(), { filmLanguage: "fr", perLanguage: 1 }).map(x => x.label), ["English 1 · BluRay · AMIABLE"]);
});

test("subtitle details: source and group without repeating the film title; missing metadata leaves a useful numbered label", () => {
  const label = (s, tier = TIER.OTHER) => labelOf(LANGUAGES[0], tier, s, 2);
  assert.equal(label(row("x", "eng", { movieReleaseName: "Film.2000.WEB-DL.x264-FGT" })), "English 2 · WEB-DL · FGT");
  assert.equal(label({ subtitleFileName: "Film.2000.720p.WEBRip-[Group].srt" }), "English 2 · WEBRip · Group");
  assert.equal(label({ releaseFormat: "HDTV", releaseGroup: "Team" }), "English 2 · HDTV · Team");
  assert.equal(label({ movieReleaseName: "Film.2000", subtitleFileName: "Film.2000.1080p.BluRay.x264-AMIABLE.srt" }), "English 2 · BluRay · AMIABLE");
  assert.equal(label({ movieReleaseName: "Film.2000.DVDRip.XviD-LAJ.srt" }), "English 2 · DVDRip · LAJ");
  for (const movieReleaseName of ["", " .SRT ", "Film Without Release Metadata", undefined, null, 123]) {
    assert.equal(label({ movieReleaseName }), "English 2");
    assert.equal(label({ movieReleaseName }, TIER.EXACT), "English 2 ✓");
  }
});

test("subtitle details: external group text is one bounded line without direction overrides or broken Unicode", () => {
  const s = { releaseFormat: "BluRay", releaseGroup: "\u202eTeam\n\tOne\u0000\u2066" };
  assert.equal(labelOf(LANGUAGES[0], TIER.OTHER, s, 1), "English 1 · BluRay · Team One");
  assert.equal(labelOf(LANGUAGES[0], TIER.RELEASE, { releaseGroup: "🎬".repeat(40) }, 15), `English 15 ≈ · ${"🎬".repeat(23)}…`);
  assert.equal(labelOf(LANGUAGES[0], TIER.OTHER, { releaseGroup: { name: "invalid" } }, 1), "English 1");
});
