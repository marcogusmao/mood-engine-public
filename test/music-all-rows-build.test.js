// node --test test/music-all-rows-build.test.js
// The music rule in every recommending row, on the REAL caches of the repository, built twice offline with the same date and the same clock: once as config.json is (the rule on) and
// once with `music.needsEvidence: false`. (Marco, 22/10/2026 ~06:40 UTC, batch 2.) test/music-all-rows.test.js has the small world, the configuration and the pieces; this file is what proves
// that build.js hands the gate to the right builders and to no other, whatever the caches of the night hold. It reads no number of today's caches: only relations between the two builds.
//   1. what the rule takes out of a row is music films (a film that is not a music film never leaves a row because of it; Tonight draws at random, so it is compared on its own terms)
//   2. the rows and files that show what a source holds are the same bytes in the two builds (the watchlist, Friends want to see, the prize row, the single-list rows,
//      Loved by your directors, Old friends, Lists, Lists (unseen), Friends); the Moods slices of the index differ only by the bit that holds the shows back (bit 8 of the flags), which the Worker reads
//   3. the main claim, from the index the build writes: every film it marks as held back (bit 8, `musicOut`) is in NO surface that recommends (the v2 rows, the static catalogs, the web picker) of the build with the rule on, and
//      was in some of them in the build with the rule off (76 appearances of the seven names, 22/10/2026); the mark leaves `eligible` alone
//   4. the rule did something (the world has music films), and the build says how many it kept out only when it is on
// Mutations this file is meant to turn red (recorded in the commit): a recommending builder handed `eligibleTt` instead of `recommendable`; a mirror row handed `recommendable`.

const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const P = require("../lib/pool");
const { decode } = require("../lib/index-rows");

const ROOT = path.join(__dirname, "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const work = {};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "music-all-rows-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function build(name, needsEvidence) {
  if (work[name]) return work[name];
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, "cache"), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, "cache"))) if (f.endsWith(".json")) fs.copyFileSync(path.join(ROOT, "cache", f), path.join(dir, "cache", f));
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({ ...CONFIG, music: { ...CONFIG.music, needsEvidence } }));
  const out = path.join(dir, "out");
  const r = spawnSync(process.execPath, [path.join(ROOT, "build.js"), "--offline", "--cache-only", "--skip-posters", "--date", "2026-10-22", "--captured-at", "2026-10-22T07:00:00.000Z", "--config", config, "--cache-dir", path.join(dir, "cache"), "--out", out], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" },
  });
  assert.equal(r.status, 0, `the build failed\n${(r.stderr || "").slice(-1500)}`);
  work[name] = { out, log: r.stdout, cache: path.join(dir, "cache") };
  return work[name];
}

const walk = (dir, rel = "") => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(dir, path.join(rel, e.name)) : [path.join(rel, e.name).split(path.sep).join("/")]));
const read = (b, f) => fs.readFileSync(path.join(b.out, f));
const rowsOf = (b) => {
  const out = {};
  for (const f of walk(b.out, "data").filter((x) => /^data\/index-v2-row-.*\.json$/.test(x))) {
    const j = JSON.parse(read(b, f));
    const names = new Map(j.films.map((r) => [r[0], r[1]]));
    for (const [id, tts] of Object.entries(j.rows)) out[id] = tts.map((tt) => ({ tt, title: names.get(tt) }));
  }
  return out;
};
const metasOf = (b) => {
  const out = {};
  for (const f of walk(b.out, "catalog").filter((x) => x.endsWith(".json"))) {
    const j = JSON.parse(read(b, f));
    if (j.metas) out[f] = j.metas.map((m) => ({ tt: m.id, title: m.name }));
  }
  return out;
};
const musicFilms = (b) => {
  const movie = JSON.parse(fs.readFileSync(path.join(b.cache, "tmdb.json"), "utf8")).movie, byTt = new Map();
  for (const e of Object.values(movie)) if (e.v && e.v.imdb) byTt.set(e.v.imdb, e.v);
  return (x) => !!byTt.get(x.tt) && P.isMusicFilm({ title: x.title, detail: byTt.get(x.tt) });
};

// the rows and catalogs that show what a source holds
const MIRROR_ROWS = ["watchlist", "friends-watchlist", "awards", "criterion", "sight-sound", "lb250", "directors-loved", "oldfriends"];
const MIRROR_FILES = /^catalog\/movie\/(mood-engine-lists|mood-engine-lists-unseen|mood-engine-friends|mood-engine-directors-loved)\//;

test("the real caches, rule on and off: what the rule takes out of the v2 Board rows and of the Discover cuts is music films, and nothing else leaves", () => {
  const on = build("on", true), off = build("off", false);
  const rOn = rowsOf(on), rOff = rowsOf(off), isMusic = musicFilms(on);
  assert.deepEqual(Object.keys(rOn).sort(), Object.keys(rOff).sort(), "the same rows");
  let rowsChanged = 0, left = 0;
  for (const id of Object.keys(rOff)) {
    if (id === "tonight" || MIRROR_ROWS.includes(id)) continue; // Tonight draws at random from the top of each mood; the mirrors are below
    const now = new Set(rOn[id].map((x) => x.tt));
    const gone = rOff[id].filter((x) => !now.has(x.tt));
    if (gone.length) rowsChanged++;
    left += gone.length;
    assert.deepEqual(gone.filter((x) => !isMusic(x)).map((x) => x.title), [], `${id}: a film that is not a music film left the row`);
    assert.ok(rOn[id].length >= rOff[id].length - gone.length, `${id}: the row never loses more than the music films that left it (${rOn[id].length} against ${rOff[id].length}, ${gone.length} left; a row whose candidates run out stays short, like africa)`);
  }
  assert.ok(rowsChanged >= 5 && left >= 10, `the rule did something on the real caches (${rowsChanged} rows lost ${left} music films)`);
  // the Discover cuts by decade, runtime, country and rating (static catalogs)
  const mOn = metasOf(on), mOff = metasOf(off);
  let cutsChanged = 0;
  for (const f of Object.keys(mOff)) {
    if (!/^catalog\/movie\/mood-engine-(decade|runtime|country|rating)\//.test(f)) continue;
    const now = new Set(mOn[f].map((x) => x.tt));
    const gone = mOff[f].filter((x) => !now.has(x.tt));
    if (gone.length) cutsChanged++;
    assert.deepEqual(gone.filter((x) => !isMusic(x)).map((x) => x.title), [], `${f}: a film that is not a music film left the cut`);
  }
  assert.ok(cutsChanged >= 3, `and in the cuts of Discover (${cutsChanged} files)`);
});

test("the real caches, rule on and off: the rows and files that show what a source holds are the same bytes, and the Moods slices of the index differ only by the bit that holds the shows back", () => {
  const on = build("on", true), off = build("off", false);
  const rOn = rowsOf(on), rOff = rowsOf(off);
  for (const id of MIRROR_ROWS) if (id in rOff) assert.deepEqual(rOn[id].map((x) => x.tt), rOff[id].map((x) => x.tt), `${id}: the same films in the same order`);
  assert.ok(MIRROR_ROWS.filter((id) => id in rOff).length >= 8, "and the build has these rows (an absent row would pass for the wrong reason)");
  const mOn = metasOf(on), mOff = metasOf(off);
  const files = Object.keys(mOff).filter((f) => MIRROR_FILES.test(f));
  assert.ok(files.length > 50, `Lists, Lists (unseen), Friends and Loved by directors: ${files.length} files`);
  for (const f of files) assert.deepEqual(mOn[f], mOff[f], f);
  // the Moods slices the Worker serves (index-v2-mood-*.json) carry the verdict too (bit 8 of the flags, which is how the Worker holds the shows back): with that bit cleared they are the same bytes
  const moodFiles = walk(on.out, "data").filter((f) => /^data\/index-v2-mood-/.test(f));
  assert.ok(moodFiles.length >= 20);
  const norm = (buf, clear) => {
    const j = JSON.parse(buf.toString("utf8"));
    const at = j.cols.indexOf("flags");
    if (clear) for (const r of j.films) if (r[at]) { r[at] &= ~8; if (!r[at]) r[at] = null; }
    if (clear && j.rules) delete j.rules.musicExemptMoods; // Marco, 22/10/2026 ~15:15 UTC: the build with the rule on also tells the Worker which mood is exempt (checked below); the off build has no such key
    return JSON.stringify(j).replace(/"builtAt":\s*"[^"]*"/g, '"builtAt":"X"');
  };
  let carried = 0;
  for (const f of moodFiles) {
    assert.equal(norm(read(on, f), true), norm(read(off, f), true), f);
    if (norm(read(on, f), false) !== norm(read(on, f), true)) carried++;
  }
  assert.ok(carried >= 3, `${carried} mood slices carry the bit`);
  // the exemption of 22/10/2026 reaches every slice the Worker reads, only when the rule is on (with the rule off nothing is held back, so there is nothing to exempt)
  for (const f of moodFiles) {
    assert.deepEqual(JSON.parse(read(on, f)).rules.musicExemptMoods, ["music"], `${f}: the exempt mood is named`);
    assert.equal(JSON.parse(read(off, f)).rules.musicExemptMoods, undefined, `${f}: off: no key`);
  }
});

test("the real caches: the build says how many music films it kept out, only when the rule is on, and names the rule's three doors", () => {
  const on = build("on", true), off = build("off", false);
  const line = on.log.split("\n").find((l) => l.includes("Music rule:"));
  assert.ok(line, "a line in the log");
  const n = Number((line.match(/Music rule: (\d+) music film/) || [])[1]);
  assert.ok(n >= 10, `${n} kept out`);
  assert.match(line, /a director or artist you rate, your watchlist, or a critics'\/directors' list/);
  assert.ok(!off.log.includes("Music rule:"), "off: nothing to say");
  assert.ok(!on.log.includes("music films need evidence from your Letterboxd"), "the New for you line of the first version is gone");
  assert.match(on.log, /Quality net on the Board rows: 0 film\(s\) removed/, "and the quality net still finds nothing: the rule is asked before the cut, not after");
});

// ── the main claim ───────────────────────────────────────────────────────────

const heldBack = (b) => decode(JSON.parse(read(b, "data/index.json"))).films;
const MIRROR_FILES_STATIC = new Set(MIRROR_ROWS.map((id) => `catalog/movie/${id}.json`));
// Marco, 22/10/2026 ~15:15 UTC ("Music 1 of 4", config.json music.exemptMoods): the Music option of the static Moods menu is the ONE surface that shows the held-back films; `recommendingSurfaces` leaves it out unless asked.
const EXEMPT_OPTION = "catalog/movie/mood-engine/genre=Music.json";
/** Every film id of every surface that recommends, by surface name: the v2 rows, the static catalogs (rows and Discover options) and the web picker. */
function recommendingSurfaces(b, withExempt = false) {
  const out = {};
  const rows = rowsOf(b);
  for (const [id, xs] of Object.entries(rows)) if (!MIRROR_ROWS.includes(id)) out[`v2:${id}`] = xs.map((x) => x.tt);
  for (const [f, xs] of Object.entries(metasOf(b))) if (!MIRROR_FILES.test(f) && !MIRROR_FILES_STATIC.has(f)) out[f] = xs.map((x) => x.tt);
  if (!withExempt) delete out[EXEMPT_OPTION];
  out["engine.json films"] = JSON.parse(read(b, "data/engine.json")).films.map((x) => x.i);
  return out;
}

test("the real caches: every film the index marks as held back by the music rule is in no surface that recommends, it was in some without the rule, and the mark leaves `eligible` alone", () => {
  const on = build("on", true), off = build("off", false);
  const isMusic = musicFilms(on);
  const fOn = heldBack(on), fOff = heldBack(off);
  const held = fOn.filter((f) => f.musicOut);
  assert.ok(held.length >= 10, `${held.length} films carry the bit`);
  assert.ok(held.every((f) => isMusic({ tt: f.tt, title: f.name }) && !f.seen), "only music films he has not seen");
  assert.equal(fOff.filter((f) => f.musicOut).length, 0, "the build with the rule off marks nothing");
  assert.deepEqual(fOn.filter((f) => f.eligible).map((f) => f.tt), fOff.filter((f) => f.eligible).map((f) => f.tt), "and the mark does not touch `eligible`: Search and the collections still find the film");
  const bad = new Set(held.map((f) => f.tt));
  const leaks = [];
  for (const [surface, tts] of Object.entries(recommendingSurfaces(on))) for (const tt of tts) if (bad.has(tt)) leaks.push(`${surface}: ${tt}`);
  assert.deepEqual(leaks, [], "a held-back film is in a surface that recommends");
  // the one exception: the Music option of the Moods menu (the legacy Board's row of the same mood, catalog/movie/music.json, is a surface of its own and is in `recommendingSurfaces`: it holds none)
  const exempt = recommendingSurfaces(on, true)[EXEMPT_OPTION].filter((tt) => bad.has(tt));
  assert.ok(exempt.length >= 10, `the exempt Music option holds ${exempt.length} held-back films`);
  assert.equal(recommendingSurfaces(on, true)[EXEMPT_OPTION].length, CONFIG.sizes.discover, "and it is as long as the other options of the menu (sizes.discover; review of 22/10/2026)");
  assert.equal(recommendingSurfaces(off, true)[EXEMPT_OPTION].filter((tt) => bad.has(tt)).length > 0, true, "control: without the rule that option held them too");
  // the control: without the rule the same surfaces DO hold them (the claim is not true for lack of films)
  let before = 0;
  for (const tts of Object.values(recommendingSurfaces(off))) for (const tt of tts) if (bad.has(tt)) before++;
  assert.ok(before >= 20, `without the rule ${before} appearances of these films are in the surfaces that recommend`);
  // and in the surfaces that show a source they are still there where the source holds them
  const lists = metasOf(on);
  assert.ok(Object.entries(lists).some(([f, xs]) => MIRROR_FILES.test(f) && xs.some((x) => bad.has(x.tt))), "Lists still show them");
});
