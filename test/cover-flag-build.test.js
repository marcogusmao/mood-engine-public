// node --test            (no dependencies)
// The cover country choice agrees with the card and region (Marco, 23/10/2026: "Bandeira passa a seguir o país do cartão já"). A separate pixel assertion proves Roma is rendered.
// the cover step takes its facts from build.js (`countries`), lib/cover-facts.js (`countries`, `fallback`) and lib/index-export.js (`coverFacts.set`), and a link lost in any of the three leaves
// the flag on the rule of v2.3 while the card says another country (review of 23/10/2026: three mutations survived every other test, one of them left 733 covers with a flag that is not the card's).
//
// Mutations this file is meant to turn red (recorded in the commit of 23/10/2026):
//   build.js: the `directors:` accessor of `countries` removed                    → "Roma", "every cover"
//   lib/cover-facts.js `countries()` returning `directors: []`                     → "every cover"
//   lib/index-export.js `coverFacts.set` writing `directors: []`                   → "every cover"
//   lib/countries.js attachCountries not asking mainCountry for the flag           → "Roma", "every cover"

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const C = require("../lib/countries");
const P = require("../lib/pool");
const { decode } = require("../lib/index-rows");

const ROOT = path.join(__dirname, "..");
const PYTHON = process.env.PYTHON || "python3";
const PIXELS = path.join(__dirname, "cover-flag-pixels.py");
function pixels(...args) {
  const r = spawnSync(PYTHON, [PIXELS, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `cover pixel proof requires Pillow and the existing renderer: ${r.error || ""}\n${r.stderr}\n${r.stdout}`);
}

function buildWithCovers() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flag-build-"))); // the cover receipt refuses a path that goes through a symlink
  const cache = path.join(tmp, "cache"), out = path.join(tmp, "out"), receiptFile = path.join(tmp, "receipt.json");
  fs.cpSync(path.join(ROOT, "cache"), cache, { recursive: true, filter: (src) => !["posters-raw", "posters-out"].includes(path.relative(path.join(ROOT, "cache"), src).split(path.sep)[0]) });
  const roma = JSON.parse(fs.readFileSync(path.join(cache, "tmdb.json"), "utf8")).movie[426426].v;
  pixels("prepare", cache, roma.imdb); // only this raw exists: never render thousands of covers
  const env = { ...process.env, MOOD_DATE: "2026-10-23", SKIP_RSS: "1", TMDB_TOKEN: "" };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["build.js", "--offline", "--cache-only", "--no-chrome", "--cache-dir", cache, "--out", out, "--cover-receipt", receiptFile], { cwd: ROOT, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  const index = decode(JSON.parse(fs.readFileSync(path.join(out, "data", "index-v2.json"), "utf8")));
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  const tmdb = JSON.parse(fs.readFileSync(path.join(cache, "tmdb.json"), "utf8")).movie;
  return { tmp, cache, out, index, receipt, tmdb, stdout: r.stdout };
}

let built = null;
const get = () => built || (built = buildWithCovers());
test.after(() => { if (built) fs.rmSync(built.tmp, { recursive: true, force: true }); });

const cardOf = (e) => e.country || (e.countries && e.countries[0]) || null;

test("the real build: cover country choice for Roma, Holy Spider, Amour, Jeanne Dielman and The Pianist agrees with the card (Mexico, Iran, Austria, Belgium, Poland)", { timeout: 600000 }, () => {
  const { index, receipt, tmdb } = get();
  const flagOf = new Map(receipt.map((x) => [x.tt, x.cc]));
  const entry = (tmdbId) => index.films.find((f) => f.tt === tmdb[tmdbId].v.imdb);
  for (const [id, label, cc] of [[426426, "Mexico", "mx"], [889699, "Iran", "ir"], [86837, "Austria", "at"], [44012, "Belgium", "be"], [423, "Poland", "pl"]]) {
    const e = entry(id);
    assert.ok(e, `${tmdb[id].v.title} is in the index`);
    assert.equal(cardOf(e), label, `${tmdb[id].v.title}: the card`);
    assert.equal(flagOf.get(e.tt), cc, `${tmdb[id].v.title}: the flag of the cover (the receipt of the cover step)`);
  }
});

test("the real build: cover country choice agrees with every card (the exceptions are listed and counted)", { timeout: 600000 }, () => {
  const { index, receipt } = get();
  const byTt = new Map(index.films.map((f) => [f.tt, f]));
  let checked = 0;
  const off = [];
  for (const x of receipt) {
    const e = byTt.get(x.tt);
    if (!e || !x.cc) continue;
    const card = cardOf(e);
    if (!card) continue;
    checked++;
    if (C.flagOfName(card) !== x.cc && C.flagOfName(P.countryLabel(card)) !== x.cc) off.push(`${x.tt} ${e.name}: card ${card}, flag ${x.cc}`);
  }
  assert.ok(checked > 9000, `${checked} covers checked`);
  assert.ok(off.length <= 10, `${off.length} of ${checked} covers have a flag that is not the card's country: ${off.slice(0, 8).join("; ")}`);
});

test("the real build: Roma publishes a ready cover with the chosen Mexico flag actually drawn; pixels differ from a no-flag control", { timeout: 600000 }, () => {
  const { cache, out, receipt, tmdb, stdout, index } = get();
  const tt = tmdb[426426].v.imdb;
  const r = receipt.find((x) => x.tt === tt);
  assert.ok(r);
  assert.equal(r.cc, "mx");
  assert.equal(r.flag, "mx");
  assert.equal(r.ready, true);
  assert.equal(r.reason, "ready");
  const published = path.join(out, "posters", `${tt}.jpg`);
  assert.ok(fs.existsSync(published));
  assert.ok(index.films.find((f) => f.tt === tt).poster, "the index publishes the rendered cover address");
  pixels("check", cache, tt, published, String(r.year));
  const countryLine = stdout.split("\n").find((line) => line.includes("Countries (cover country choice:"));
  assert.ok(countryLine, "the cover step explains its current country choice");
  assert.match(countryLine, /main country by director\/origin, with the old language\/production fallback/);
  const main = countryLine.match(/: (\d+) by main country/);
  assert.ok(main && Number(main[1]) > 0, "cn.main is counted in the existing build log");
  assert.doesNotMatch(countryLine, /v2\.3/);
});
