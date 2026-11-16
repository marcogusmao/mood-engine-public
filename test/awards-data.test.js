// Venice Golden Lion and Berlin Golden Bear winners (Marco, 13/10/2026): data/venice-golden-lion.json and data/berlin-golden-bear.json,
// the same shape as data/cannes-critic-prizes.json (lib/critic-subset.js). Data only here; since PR3 of the 54-row Board (13/10/2026) lib/special-rows.js loadAwards()
// reads the three files for the "Cannes, Venice and Berlin winners" row of the v2 Board (test/special-rows.test.js). Source: Wikipedia revisions pinned in each file's `fonte`.
// Session decision (13/10/2026, reversible): the five Golden Bears of Berlin 1951 awarded "by genre" do NOT count; their prize string is
// not in premios_criticos, so build() skips them while the films stay in the file.
const test = require("node:test");
const a = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const CS = require("../lib/critic-subset");

const ROOT = path.resolve(__dirname, "..");
const read = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", name), "utf8"));
const venice = read("venice-golden-lion.json");
const berlin = read("berlin-golden-bear.json");
const cannes = read("cannes-critic-prizes.json");
const FILES = { "venice-golden-lion.json": venice, "berlin-golden-bear.json": berlin };

const GENRE_1951 = "Golden Bear (1951, por gênero)";
const GENRE_1951_SLUGS = ["four-in-a-jeep", "without-leaving-an-address", "beaver-valley", "justice-is-done", "cinderella"];

test("both files pass validate() (non-empty premios_criticos, well-formed slugs, imdb ids and prize years)", () => {
  for (const [name, data] of Object.entries(FILES)) a.deepEqual(CS.validate(data), [], name);
});

test("build() counts 70 Venice films and 83 Berlin films (88 in the file, minus the five 1951 genre Bears)", () => {
  a.equal(venice.filmes.length, 70);
  a.equal(berlin.filmes.length, 88);
  a.equal(CS.build(venice, "Venice").size, 70);
  a.equal(CS.build(berlin, "Berlin").size, 83);
});

test("the five Berlin 1951 genre Bears stay in the file but are not counted, and regra says so", () => {
  const inFile = berlin.filmes.filter((f) => f.prizes[GENRE_1951]);
  a.equal(inFile.length, 5);
  a.deepEqual(berlin.premios_criticos, ["Golden Bear (1952-2026)"]);
  a.ok(!berlin.premios_criticos.includes(GENRE_1951));
  const built = CS.build(berlin, "Berlin");
  for (const f of inFile) a.equal(built.has(f.slug), false, `${f.slug} must not count`);
  for (const s of GENRE_1951_SLUGS) a.ok(inFile.some((f) => f.slug === s), `${s} is one of the five`);
  a.match(berlin.regra, /1951/);
  a.match(berlin.regra, /NÃO contam/);
});

test("every imdb is present and looks like tt1234567; no slug repeats inside a file", () => {
  for (const [name, data] of Object.entries(FILES)) {
    for (const f of data.filmes) a.match(f.imdb, /^tt\d+$/, `${name}: ${f.slug}`);
    const slugs = data.filmes.map((f) => f.slug);
    a.equal(new Set(slugs).size, slugs.length, `${name}: repeated slug`);
  }
});

test("the labels name the festival and the year: Venice · Golden Lion 2026, Berlin · Golden Bear 2026", () => {
  a.equal(CS.build(venice, "Venice").get("woman-unknown").label, "Venice · Golden Lion 2026");
  a.equal(CS.build(berlin, "Berlin").get("yellow-letters").label, "Berlin · Golden Bear 2026");
});

test("films in two festivals exist (the row \"Cannes, Venice and Berlin winners\" exists since PR3 and joins them by IMDb id, with the slug as the key for a Cannes entry, which has no imdb: lib/special-rows.js awards): The Wages of Fear in Cannes and Berlin, Justice Is Done in Venice and Berlin", () => {
  const slugs = (d) => new Set(d.filmes.map((f) => f.slug));
  const [c, v, b] = [slugs(cannes), slugs(venice), slugs(berlin)];
  a.ok(c.has("the-wages-of-fear") && b.has("the-wages-of-fear"));
  a.ok(v.has("justice-is-done") && b.has("justice-is-done"));
  const imdbOf = (d, s) => d.filmes.find((f) => f.slug === s).imdb;
  a.equal(imdbOf(venice, "justice-is-done"), imdbOf(berlin, "justice-is-done"), "same film, same imdb in both files");
  // Wages of Fear counts in both Cannes and Berlin (Golden Bear 1953); Justice Is Done counts only in Venice since the 1951 decision
  a.ok(CS.build(cannes, "Cannes").has("the-wages-of-fear") && CS.build(berlin, "Berlin").has("the-wages-of-fear"));
  a.ok(CS.build(venice, "Venice").has("justice-is-done") && !CS.build(berlin, "Berlin").has("justice-is-done"));
  // the three files together name fewer distinct slugs than the sum of their entries
  const all = [...c, ...v, ...b];
  a.ok(new Set(all).size < all.length);
});

test("positive control: a copy with a malformed imdb is refused by validate() and by build()", () => {
  for (const [name, data] of Object.entries(FILES)) {
    const bad = JSON.parse(JSON.stringify(data));
    bad.filmes[3].imdb = "xx";
    const problems = CS.validate(bad);
    a.equal(problems.length, 1, name);
    a.match(problems[0], /imdb must look like tt1234567/);
    a.throws(() => CS.build(bad, "x"), /critic subset: .*imdb must look like/);
  }
});
