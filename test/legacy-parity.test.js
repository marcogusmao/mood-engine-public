// node --test            (no dependencies)
// Legacy parity (Marco, 13/10/2026, PR1 of the 54-row Board): the 3.1.0 Worker and the five profiles read the legacy files, and the BOARD may not move one of them: the same code builds the
// legacy family with and without a board and the two must agree. (What changed in the legacy files themselves is the refill of every row decided the same day, 13/10/2026, which moves 99
// of them against a build of 393b25a; nothing beyond that decision may.) Real offline builds of the SAME caches, with the same --date and --captured-at:
//   boarded  config.json + two moods that exist in the v2 family alone + a "board" (test/fixtures/board-v2.json, its Moods menu widened to the two new moods)
//   plain    the same config REDUCED the way the legacy family is defined: no "board", and only the moods of board.legacyMoods
// Every file that is not index-v2*.json must be the same in both, manifest.json and catalog/** included. The reference is generated here from the full config, so
// since the day config.json itself carries a "board" (PR5, 14/10/2026) this test keeps comparing the legacy family with what it would be without it, and not a build with itself: its base is legacyConfig(config.json), and
// the last-but-one test builds config.json as it is against that base.
// Three things are allowed to differ, and the test names each: `meta.builtAt` (buildIndex stamps the clock of the moment), which exists only in the index files and film-languages.json, and, in the
// PRODUCTION test alone, the WORD GROUP of line 2 of a card (one group) and the best-fit `Mood:` label of a line that is not in a mood row (below). A difference anywhere else (a catalog, the manifest, engine.json) is not forgiven by the normalisation.
//
// The two new moods are there to break the legacy family if a reader of config.json "moods" forgets the filter: `noir` is `night` again (it would take Tonight picks and a row,
// a Moods menu option, a manifest entry), `road` is `wander` again and PINS a film the pool does not hold (it would join the candidates and change the index).

const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const BOARD = require("./fixtures/board-v2.json");
const BOARD_PR3 = require("./fixtures/board-v2-pr3.json"); // PR3: the ten special rows (friends' picks, prizes, untried directors, the actor of the week, single lists), reaching plan.board2 through rows2
const BOARD_PR2 = require("./fixtures/board-v2-pr2.json"); // PR2: 21 moods of its own, 20 recipes of rows (decades, regions, combined), the watchlist by date added
const V2 = /^data\/index-v2(?:-[a-z0-9-]+)?\.json$/;
// 29/10/2026 (Marco, "peças por opção do Discover"): the v2 family also holds one index-v2-opt-<catalog>-<option>.json per calculated option of the Discover (lib/index-export.js optionPieces). They are counted apart: the other v2 files are the ones
// they always were, and the pieces are as many as the whole index's `discover` has options with ids (none when the build has no discover).
const { slugsOf, pieceFile } = require("../lib/friend-view");
const splitV2 = (files, out) => {
  const index = JSON.parse(fs.readFileSync(path.join(out, "data", "index-v2.json"), "utf8"));
  const opt = files.filter((f) => /index-v2-opt-/.test(slash(f)));
  const optionCount = (index.discover || { catalogs: [] }).catalogs.flatMap((c) => c.options).filter((o) => o.ids).length;
  assert.equal(opt.length, optionCount, "one piece per calculated option of the Discover");
  // Friends add one Watchlist piece each only to Marco's Board. Check their exact names before removing them from the pre-existing v2 count.
  const friends = files.filter((f) => /^data\/index-v2-row-watchlist-[a-z0-9]+\.json$/.test(slash(f)));
  const hasWatchlist = !index.meta.personId && (index.board || []).some((r) => r.id === "watchlist" && r.place === "board" && !r.series);
  const expected = hasWatchlist ? slugsOf(index.friends.people).map((s) => slash(pieceFile(s))) : [];
  assert.deepEqual(friends.map(slash).sort(), expected.sort(), "exactly one Watchlist piece per friend when the Board has Watchlist");
  const separate = new Set([...opt, ...friends]);
  return files.filter((f) => !separate.has(f));
};
const HAS_BUILT_AT = /^data\/(?:index(?:-[A-Za-z0-9_-]+)?|film-languages)\.json$/;
// Marco, 28/10/2026: o arquivo de produção (data/discover-catalogs.json) nomeia palavras-chave que os moods reduzidos não têm; o teste de paridade legada usa o arquivo de 24/10 (cópia fiel de data/discover-catalogs.json de ed6acca, cuja última mudança é 656e500, `perAfterFirstPage`, de 24/10/2026; o catálogo é de 22/10, o nome da fixture é a data da última mudança)
// (test/fixtures/discover-catalogs-2026-10-24.json, passado por --discover-file). O teste de PRODUÇÃO abaixo constrói com config.json inteiro e fica com o arquivo de produção.
const FIXTURE_DISCOVER = path.join(ROOT, "test", "fixtures", "discover-catalogs-2026-10-24.json");
const PIN = "tt0137863"; // Eight Deadly Shots (1972): 20 votes, so only a pin lets it into the candidates; its find record is in cache/tmdb.json

const walk = (dir, rel = "") => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(dir, path.join(rel, e.name)) : [path.join(rel, e.name)]));
const slash = (f) => f.split(path.sep).join("/");
const normalised = (buf) => buf.toString("utf8").replace(/"builtAt":"[^"]*"/g, '"builtAt":"X"');

const { legacyConfig } = require("../lib/board-shared");
const PRODUCTION = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")); // PR5 (14/10/2026): carries the Board of 54 rows and the 21 moods of the v2 family

// ── what the PRODUCTION test lets differ (Marco, 21/10/2026, 01:35 UTC; narrowed by the review of the description v3, 21/10/2026) ─────────────────────────────────────────────────────────────
// The word group of line 2 of the card, the last one ("Mood: <mood> · <genres> · <words>."; at most one group after the genres), and the best-fit label "Mood: <name>" of a line that is NOT in a mood row (D3, 21/10/2026, always the name of a mood of config.json, with the genre group that goes with it), and nothing else: test-support/card-words.js says what is cut and what is kept, and test/special-rows.test.js
// ("real build: … every legacy file") uses the same function. The positive control below plants each of the changes that must still be caught.
const { movedBeyondWords, SEP } = require("../test-support/card-words");

function configs() {
  const base = legacyConfig(PRODUCTION); // what config.json was before PR5: the nine moods, no board (the 21 moods and the board are what the fixtures below lay on top)
  const clone = (from, o) => ({ ...base.moods.find((m) => m.id === from), ...o });
  const legacyMoods = base.moods.map((m) => m.id);
  const board = { ...BOARD, legacyMoods, moodMenu: [...legacyMoods, "noir", "road", "friends-week"] };
  const full = { ...base, moods: [...base.moods, clone("night", { id: "noir", word: "Noir", name: "🌃 Noir", pins: [] }), clone("wander", { id: "road", word: "Road", name: "🛣️ Road", pins: [PIN] })], board };
  const { board: _, ...rest } = full;
  const reduced = { ...rest, moods: full.moods.filter((m) => legacyMoods.includes(m.id)) };
  return { full, reduced };
}

let built = null;
/** Builds both once for the whole file; the work folder is removed by cleanup(). */
function builds() {
  if (built) return built;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mood-parity-"));
  fs.mkdirSync(path.join(work, "cache"));
  for (const n of fs.readdirSync(path.join(ROOT, "cache"))) if (n.endsWith(".json")) fs.copyFileSync(path.join(ROOT, "cache", n), path.join(work, "cache", n)); // a copy: the build must not touch the caches of the repository
  const { full, reduced } = configs();
  const run = (name, config, discover = FIXTURE_DISCOVER) => {
    const file = path.join(work, `${name}.config.json`), out = path.join(work, name);
    fs.writeFileSync(file, JSON.stringify(config));
    const r = spawnSync(process.execPath, [path.join(ROOT, "build.js"), "--offline", "--cache-only", "--skip-posters", "--date", "2026-10-13", "--captured-at", "2026-10-13T12:00:00.000Z", "--config", file, ...(discover ? ["--discover-file", discover] : []), "--cache-dir", path.join(work, "cache"), "--out", out], {
      cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "" },
    });
    assert.equal(r.status, 0, `${name}: the build failed\n${(r.stderr || "").slice(-2000)}\n${(r.stdout || "").slice(-1500)}`);
    return { out, log: r.stdout };
  };
  // the PR2 board: its moods live in board.moods, which the legacy family never reads; same caches, same clock
  const plain = run("plain", reduced), boarded = run("boarded", full), boarded2 = run("boarded2", { ...reduced, board: BOARD_PR2 }), boarded3 = run("boarded3", { ...reduced, board: BOARD_PR3 });
  const production = run("production", PRODUCTION, null); // PR5: config.json as it is, the Board of 54 rows and the 21 moods in it
  return (built = { work, plain, boarded, boarded2, boarded3, production });
}
const cleanup = () => { if (built) fs.rmSync(built.work, { recursive: true, force: true }); built = null; };
after(cleanup);
const same = (rel) => {
  const { plain, boarded } = builds();
  const x = fs.readFileSync(path.join(plain.out, rel)), y = fs.readFileSync(path.join(boarded.out, rel));
  return x.equals(y) || (HAS_BUILT_AT.test(slash(rel)) && normalised(x) === normalised(y));
};

test("legacy parity: every legacy file of the boarded build is the file of the reduced build, builtAt aside; the v2 family is next to them", { timeout: 300000 }, () => {
  const { plain, boarded } = builds();
  const a = walk(plain.out).sort(), b = walk(boarded.out).sort();
  assert.ok(!a.some((f) => V2.test(slash(f))), "without a board there is no v2 file");
  const v2 = splitV2(b.filter((f) => V2.test(slash(f))), boarded.out);
  assert.equal(v2.length, 1 + 1 + 6 + 11, "index-v2.json, the menus, one file per row of the fixture, one per mood of its Moods menu (the nine of today and the two new)");
  const legacy = b.filter((f) => !V2.test(slash(f)) && !/^data\/page-\d{2}\.json$/.test(slash(f)));
  assert.deepEqual(legacy, a, "the same set of legacy files");
  assert.ok(a.includes("manifest.json") && a.some((f) => f.startsWith(path.join("catalog", "movie"))) && a.includes(path.join("data", "index.json")), "the walk saw the manifest, the catalogs and the index");
  const moved = [];
  for (const f of legacy) {
    const x = fs.readFileSync(path.join(plain.out, f)), y = fs.readFileSync(path.join(boarded.out, f));
    if (x.equals(y)) continue;
    if (!HAS_BUILT_AT.test(slash(f))) moved.push(`${f} (not an index file: not even builtAt may explain it)`);
    else if (normalised(x) !== normalised(y)) moved.push(`${f} (differs beyond builtAt)`);
  }
  assert.deepEqual(moved, [], "legacy files that moved");
  assert.match(boarded.log, /Board v2: 6 rows/);
  assert.doesNotMatch(plain.log, /Board v2|index v2/);
});

test("legacy parity, PR2 board (21 moods, decades, regions, combined rows, watchlist by date added): every legacy file is still the file of the reduced build", { timeout: 300000 }, () => {
  const { plain, boarded2 } = builds();
  const a = walk(plain.out).sort(), b = walk(boarded2.out).sort();
  const v2 = splitV2(b.filter((f) => V2.test(slash(f))), boarded2.out);
  assert.equal(v2.length, 1 + 1 + 44 + 30, "index-v2.json, the menus, one file per row but the series row, one per mood of the Moods menu (30)");
  const legacy = b.filter((f) => !V2.test(slash(f)) && !/^data\/page-\d{2}\.json$/.test(slash(f)));
  assert.deepEqual(legacy, a, "the same set of legacy files");
  const moved = [];
  for (const f of legacy) {
    const x = fs.readFileSync(path.join(plain.out, f)), y = fs.readFileSync(path.join(boarded2.out, f));
    if (x.equals(y)) continue;
    if (!HAS_BUILT_AT.test(slash(f))) moved.push(`${f} (not an index file: not even builtAt may explain it)`);
    else if (normalised(x) !== normalised(y)) moved.push(`${f} (differs beyond builtAt)`);
  }
  assert.deepEqual(moved, [], "legacy files that moved");
  assert.match(boarded2.log, /Board v2: 45 rows/);
  const manifest = JSON.parse(fs.readFileSync(path.join(boarded2.out, "manifest.json"), "utf8"));
  assert.ok(!manifest.catalogs.some((c) => ["noir", "lol", "visual", "europe", "1970s", "after-midnight"].includes(c.id)), "no catalog of the v2 Board in the legacy manifest");
});

test("legacy parity, PR3 board (the ten special rows): every legacy file is still the file of the reduced build, and the special rows are in the v2 family only", { timeout: 300000 }, () => {
  const { plain, boarded3 } = builds();
  const a = walk(plain.out).sort(), b = walk(boarded3.out).sort();
  const v2 = b.filter((f) => V2.test(slash(f)));
  const special = ["top-picks", "friends-watchlist", "untried-directors", "criterion", "awards", "friends-split", "sight-sound", "lb250", "actor-week", "friends-month"];
  for (const id of special) assert.ok(v2.map(slash).includes(`data/index-v2-row-${id}.json`), `the v2 family has the row ${id}`);
  const legacy = b.filter((f) => !V2.test(slash(f)) && !/^data\/page-\d{2}\.json$/.test(slash(f)));
  assert.deepEqual(legacy, a, "the same set of legacy files");
  const moved = [];
  for (const f of legacy) {
    const x = fs.readFileSync(path.join(plain.out, f)), y = fs.readFileSync(path.join(boarded3.out, f));
    if (x.equals(y)) continue;
    if (!HAS_BUILT_AT.test(slash(f))) moved.push(`${f} (not an index file: not even builtAt may explain it)`);
    else if (normalised(x) !== normalised(y)) moved.push(`${f} (differs beyond builtAt)`);
  }
  assert.deepEqual(moved, [], "legacy files that moved");
  const manifest = JSON.parse(fs.readFileSync(path.join(boarded3.out, "manifest.json"), "utf8"));
  assert.ok(!manifest.catalogs.some((c) => special.includes(c.id)), "no special row in the legacy manifest");
  assert.match(boarded3.log, /Special rows of the v2 Board/);
});

test("legacy parity, PRODUCTION config (PR5: the Board of 54 rows, the 21 moods in \"moods\"): every legacy file is the file of the same config without the board and with the nine legacy moods; no column, catalog or manifest entry of the v2 Board reaches it", { timeout: 300000 }, () => {
  const { plain, production } = builds();
  const a = walk(plain.out).sort(), b = walk(production.out).sort();
  const v2 = splitV2(b.filter((f) => V2.test(slash(f))), production.out);
  assert.equal(v2.length, 1 + 1 + 54 + 30, "index-v2.json, the menus, one file per row but the series row (54 of the 55 entries of order), one per mood of the Moods menu (30)");
  const legacy = b.filter((f) => !V2.test(slash(f)) && !/^data\/page-\d{2}\.json$/.test(slash(f)));
  assert.deepEqual(legacy, a, "the same set of legacy files");
  const moved = movedBeyondWords(legacy, plain.out, production.out); // the word group of line 2 of the card may differ (the words of the 30 moods), and so may the best-fit label of a line that is not in a mood row (D3); nothing else may
  assert.deepEqual(moved, [], "legacy files that moved");
  assert.match(production.log, /Board: 54 rows declared/);
  const manifest = JSON.parse(fs.readFileSync(path.join(production.out, "manifest.json"), "utf8"));
  assert.ok(!manifest.catalogs.some((c) => ["noir", "lol", "visual", "europe", "1970s", "after-midnight", "top-picks", "awards"].includes(c.id)), "no catalog of the v2 Board in the legacy manifest");
  const ix = JSON.parse(fs.readFileSync(path.join(production.out, "data", "index.json"), "utf8"));
  assert.deepEqual(ix.moods.map((m) => m.id), PRODUCTION.board.legacyMoods, "the legacy index declares the nine moods of board.legacyMoods and no other");
});

// Positive control of the relaxation. The review of the description v3 (21/10/2026) planted a third card line, another "Mood: <name>", another "Loved by …" and other genres in line 2 of copies of the build and the
// first version of this relaxation (it replaced the WHOLE of line 2 and everything after it up to the separator) forgave all of them. Each of those is planted here, in a catalog and in an index file, and must be caught.
// Marco's answers of 21/10/2026 (~15:00 UTC) widened the relaxation by the best-fit label of a line that is not in a mood row (and the genre that goes with it), and the review's item (b) narrowed the word group to AT MOST ONE
// group after the genres: both are planted below, in the two directions (what is forgiven, what must still be caught).
test("legacy parity, the relaxation forgives the word group (one group) and the best-fit label of a line that is not in a mood row, and nothing else (positive control, planted in copies of the reduced build)", { timeout: 300000 }, () => {
  const plainOf = (x) => String(x == null ? "" : x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const NAMES = PRODUCTION.moods.map((m) => m.name);
  const { plain, work } = builds();
  const copy = path.join(work, "control");
  fs.cpSync(plain.out, copy, { recursive: true });
  const legacy = walk(plain.out).filter((f) => !V2.test(slash(f)) && !/^data\/page-\d{2}\.json$/.test(slash(f)));
  assert.deepEqual(movedBeyondWords(legacy, plain.out, copy), [], "an identical copy moves nothing");
  const planted = "Planted, Words";
  // line 2 as { label, genres, words }: the label "Mood: …" if it opens the line, the genres group (the film's first three, without the label's name: D5) and the groups after it
  const split = (line, genres) => {
    const groups = line.replace(/\.$/, "").split(" · ");
    const label = groups[0].startsWith("Mood: ") ? groups.shift() : null;
    const shown = genres.slice(0, 3).filter((g) => !label || plainOf(g) !== plainOf(label.slice(6))).join(", ");
    const g = shown && groups[0] === shown ? groups.shift() : null;
    return { label, genres: g, words: groups };
  };
  const join = ({ label, genres, words }) => `${[label, genres, ...words].filter(Boolean).join(" · ")}.`;
  const genresFor = (genres, label) => genres.slice(0, 3).filter((x) => !label || plainOf(x) !== plainOf(label.slice(6))).join(", ") || null; // D5
  const other = (label) => NAMES.find((n) => `Mood: ${n}` !== label);
  // ── a catalog of the static addon
  const catalogFile = (id) => path.join(copy, "catalog", "movie", id);
  const mutate = (file, pick, fn) => { // the first film of `file` that `pick` accepts, changed by fn; the answer of movedBeyondWords; the file is put back
    const original = fs.readFileSync(file, "utf8"), body = JSON.parse(original), m = body.metas.find(pick);
    assert.ok(m, `${path.basename(file)} has a film for the control`);
    fn(m, body);
    fs.writeFileSync(file, JSON.stringify(body));
    const moved = movedBeyondWords(legacy, plain.out, copy);
    fs.writeFileSync(file, original);
    return moved;
  };
  const card = (m) => m.description.split(SEP);
  const lineTwo = (fn) => (m) => { const [c, ...syn] = card(m); const lines = c.split("\n"); lines[1] = fn(lines[1], m.genres); m.description = [lines.join("\n"), ...syn].join(SEP); };
  const hasLine2 = (kind) => (m) => m.genres && m.genres.length > 1 && (card(m)[0].split("\n")[1] || "").includes(" · ") && (kind === "labelled" ? /^Mood: /.test(card(m)[0].split("\n")[1]) : true);
  // a MOOD ROW (lift.json): its label is the row's own mood, and there nothing but the word group is forgiven
  const lift = catalogFile("lift.json");
  assert.deepEqual(mutate(lift, hasLine2("labelled"), lineTwo((l, g) => join({ ...split(l, g), words: [planted] }))), [], "the word group alone changes: forgiven");
  assert.deepEqual(mutate(lift, hasLine2("labelled"), lineTwo((l, g) => join({ ...split(l, g), words: [] }))), [], "the word group is gone: forgiven");
  assert.equal(mutate(lift, hasLine2("labelled"), lineTwo((l, g) => join({ ...split(l, g), words: [planted, "A group more"] }))).length, 1, "TWO groups after the genres: caught (the first relaxation forgave everything after them)");
  assert.equal(mutate(lift, hasLine2("labelled"), lineTwo((l, g) => join({ ...split(l, g), label: "Mood: 🌃 Planted", words: [planted] }))).length, 1, "another mood name opens the line of a MOOD ROW: caught");
  assert.equal(mutate(lift, hasLine2("labelled"), lineTwo((l, g) => { const p = split(l, g); return join({ ...p, label: `Mood: ${other(p.label)}`, genres: genresFor(g, `Mood: ${other(p.label)}`) }); })).length, 1, "another mood of config.json opens the line of a MOOD ROW: caught");
  assert.equal(mutate(lift, hasLine2("labelled"), lineTwo((l, g) => join({ ...split(l, g), label: null }))).length, 1, "the label of a mood row is gone: caught");
  assert.equal(mutate(lift, hasLine2("labelled"), lineTwo((l, g) => `Loved by Planted Director +2 more · ${l}`)).length, 1, "another lead is added: caught");
  assert.equal(mutate(lift, hasLine2("labelled"), lineTwo((l, g) => join({ ...split(l, g), label: "loved by Ana 5★, Bo 5★" }))).length, 1, "the mood is replaced by a reason: caught");
  assert.equal(mutate(lift, hasLine2("labelled"), lineTwo((l, g) => join({ ...split(l, g), genres: "Planted, Genres" }))).length, 1, "the genres change: caught");
  assert.equal(mutate(lift, hasLine2("labelled"), (m) => { const [c, ...syn] = card(m); m.description = [`${c}\nPlanted third line.`, ...syn].join(SEP); }).length, 1, "a THIRD card line is added: caught (the first relaxation forgave it)");
  assert.equal(mutate(lift, hasLine2("labelled"), (m) => { const [c, ...syn] = card(m); const lines = c.split("\n"); lines[0] = "Planted Director · 9h99."; m.description = [lines.join("\n"), ...syn].join(SEP); }).length, 1, "line 1 (the credits) changes: caught");
  assert.equal(mutate(lift, hasLine2("labelled"), (m) => { const parts = card(m); parts[parts.length - 1] += " Planted sentence."; m.description = parts.join(SEP); }).length, 1, "the synopsis changes: caught");
  assert.equal(mutate(lift, hasLine2("labelled"), (m) => { m.name += " (planted)"; }).length, 1, "another field of the meta changes: caught");
  assert.equal(mutate(lift, hasLine2("labelled"), (m) => { m.id = "tt9999999"; }).length, 1, "the film changes: caught");
  // a row that is NO mood (watchlist.json): its label is the best fit of the build, which has nine moods in one build and 30 in the other
  const watchlist = catalogFile("watchlist.json");
  const fits = hasLine2("labelled");
  assert.deepEqual(mutate(watchlist, fits, lineTwo((l, g) => { const p = split(l, g), label = `Mood: ${other(p.label)}`; return join({ ...p, label, genres: genresFor(g, label), words: [planted] }); })), [], "the best fit is another mood of config.json (and the genre that is its name goes with it): forgiven");
  assert.deepEqual(mutate(watchlist, fits, lineTwo((l, g) => join({ ...split(l, g), label: null, genres: genresFor(g, null) }))), [], "the film has no best fit in the other build: forgiven");
  assert.equal(mutate(watchlist, fits, lineTwo((l, g) => join({ ...split(l, g), label: "Mood: 🌃 Planted" }))).length, 1, "a label that names no mood of config.json: caught");
  assert.equal(mutate(watchlist, fits, lineTwo((l, g) => join({ ...split(l, g), genres: "Planted, Genres" }))).length, 1, "the genres change under a best-fit label: caught");
  assert.equal(mutate(watchlist, fits, lineTwo((l, g) => `Loved by Planted Director +2 more · ${l}`)).length, 1, "a reason is added in front of a best-fit label: caught");
  assert.equal(mutate(watchlist, fits, lineTwo((l, g) => join({ ...split(l, g), words: [planted, "A group more"] }))).length, 1, "TWO groups after the genres: caught");
  assert.equal(mutate(watchlist, fits, (m) => { const [c, ...syn] = card(m); m.description = [`${c}\nPlanted third line.`, ...syn].join(SEP); }).length, 1, "a third line: caught");
  // ── an index file: the word group and the best-fit label of `desc` are forgiven; the actors, the genres, a third line and a column are not; the label of a MOOD ROW's rowDesc is not
  const file = path.join(copy, "data", "index.json"), json = JSON.parse(fs.readFileSync(file, "utf8")), col = json.cols.indexOf("desc"), keep = JSON.stringify(json), gcol = json.cols.indexOf("genres");
  const withRow = (fn) => { const j2 = JSON.parse(keep); fn(j2); fs.writeFileSync(file, JSON.stringify(j2)); const moved = movedBeyondWords(legacy, plain.out, copy); fs.writeFileSync(file, keep); return moved; };
  const row = json.films.findIndex((r) => typeof r[col] === "string" && r[col].includes(SEP) && /^Mood: /.test(r[col].split("\n")[1] || "") && (r[col].split("\n")[1] || "").split(" · ").length >= 3 && r[gcol]);
  assert.ok(row >= 0, "the reduced index has a desc with a best-fit label, genres and a word group in line 2");
  const genresOfRow = json.films[row][gcol].split("|");
  const inDesc = (fn) => (j) => { const l = j.films[row][col].split("\n"); fn(l); j.films[row][col] = l.join("\n"); };
  assert.deepEqual(withRow(inDesc((l) => { l[1] = join({ ...split(l[1], genresOfRow), words: [planted] }); })), [], "desc: the word group alone changes: forgiven");
  assert.deepEqual(withRow(inDesc((l) => { l[1] = join({ ...split(l[1], genresOfRow), words: [] }); })), [], "desc: the word group is gone: forgiven");
  assert.deepEqual(withRow(inDesc((l) => { const p = split(l[1], genresOfRow), label = `Mood: ${other(p.label)}`; l[1] = join({ ...p, label, genres: genresFor(genresOfRow, label) }); })), [], "desc: another best-fit mood: forgiven");
  assert.deepEqual(withRow(inDesc((l) => { l[1] = join({ ...split(l[1], genresOfRow), label: null, genres: genresFor(genresOfRow, null) }); })), [], "desc: no best fit: forgiven");
  assert.equal(withRow(inDesc((l) => { l[0] = "Planted Actor"; })).length, 1, "desc: the actors line is caught");
  assert.equal(withRow(inDesc((l) => { l[1] = join({ ...split(l[1], genresOfRow), label: "Mood: 🌃 Planted" }); })).length, 1, "desc: a label that names no mood is caught");
  assert.equal(withRow(inDesc((l) => { l[1] = join({ ...split(l[1], genresOfRow), genres: "Planted, Genres" }); })).length, 1, "desc: other genres are caught");
  assert.equal(withRow(inDesc((l) => { l[1] = join({ ...split(l[1], genresOfRow), words: [planted, "A group more"] }); })).length, 1, "desc: two groups after the genres are caught");
  assert.equal(withRow(inDesc((l) => { l.splice(2, 0, "Planted third line."); })).length, 1, "desc: a third card line is caught");
  assert.equal(withRow((j) => { j.films[row][json.cols.indexOf("name")] += " (planted)"; }).length, 1, "a column is caught");
  // rowDesc of the index: a mood row (the first one with a label) keeps its label; a row that is no mood forgives it
  const decodeIndex = (j) => require("../lib/index-rows").decode(j);
  const ixObj = decodeIndex(JSON.parse(keep));
  const moodRowId = PRODUCTION.board.legacyMoods.find((id) => (ixObj.rowDesc[id] || []).some((t) => /^[^\n]*\nMood: /.test(t)));
  assert.ok(moodRowId, "a mood row of the legacy index has labelled texts");
  const withRowDesc = (id, fn) => {
    const o = decodeIndex(JSON.parse(keep));
    const i = o.rowDesc[id].findIndex((t) => /^[^\n]*\n(Mood: )?[^\n]*\n\n/.test(t) && (t.split("\n")[1] || "").includes(" · "));
    const tt = o.rows[id][i], genres = (o.films.find((f) => f.tt === tt) || {}).genres || [];
    const l = o.rowDesc[id][i].split("\n");
    fn(l, genres);
    o.rowDesc[id][i] = l.join("\n");
    fs.writeFileSync(file, JSON.stringify(require("../lib/index-rows").encode(o)));
    const moved = movedBeyondWords(legacy, plain.out, copy);
    fs.writeFileSync(file, keep);
    return moved;
  };
  assert.equal(withRowDesc(moodRowId, (l, g) => { const p = split(l[1], g); l[1] = join({ ...p, label: `Mood: ${other(p.label)}`, genres: genresFor(g, `Mood: ${other(p.label)}`) }); }).length, 1, "rowDesc of a MOOD row: another mood is caught");
  assert.deepEqual(withRowDesc(moodRowId, (l, g) => { l[1] = join({ ...split(l[1], g), words: [planted] }); }), [], "rowDesc of a mood row: the word group alone: forgiven");
  assert.deepEqual(withRowDesc("watchlist", (l, g) => { const p = split(l[1], g), label = `Mood: ${other(p.label)}`; l[1] = join({ ...p, label, genres: genresFor(g, label), words: [planted] }); }), [], "rowDesc of a row that is no mood: another best fit and other words: forgiven");
  fs.writeFileSync(file, keep);
});

test("legacy parity, pins: the pin of a mood that exists in the v2 family alone does not join the candidates of the legacy family", { timeout: 300000 }, () => {
  assert.ok(same(path.join("data", "index.json")), "data/index.json differs: the pinned film (or its pool slot) reached the legacy index");
  assert.ok(same(path.join("data", "index-board.json")));
});

test("legacy parity, ranking: new moods do not take Tonight picks or ranking slots from the legacy family", { timeout: 300000 }, () => {
  assert.ok(same(path.join("catalog", "movie", "tonight.json")), "Tonight changed");
  assert.ok(same(path.join("data", "index-moods.json")), "the moods piece changed");
  assert.ok(same(path.join("data", "engine.json")), "the picker's data (moods, buildId) changed");
});

test("legacy parity, plan: a new mood has no Board row, no static catalog and no Discover Moods option in the legacy family", { timeout: 300000 }, () => {
  const { boarded } = builds();
  const manifest = JSON.parse(fs.readFileSync(path.join(boarded.out, "manifest.json"), "utf8"));
  assert.ok(!manifest.catalogs.some((c) => ["noir", "road"].includes(c.id)), "manifest.json lists a catalog of a new mood");
  const moodsCatalog = manifest.catalogs.find((c) => c.id === "mood-engine");
  assert.ok(!moodsCatalog.extra[0].options.some((o) => ["Noir", "Road"].includes(o)), "the static Discover Moods menu offers a new mood");
  assert.ok(!fs.existsSync(path.join(boarded.out, "catalog", "movie", "noir.json")));
  assert.ok(same("manifest.json") && same(path.join("data", "index-board.json")));
});

test("legacy parity, v2 side: the v2 index has the new moods, in the Moods menu and as slices", { timeout: 300000 }, () => {
  const { boarded } = builds();
  const { decode } = require("../lib/index-rows");
  const ix2 = decode(JSON.parse(fs.readFileSync(path.join(boarded.out, "data", "index-v2.json"), "utf8")));
  assert.equal(ix2.moods.length, 11, "the nine of today and the two new");
  assert.deepEqual(ix2.moodMenu.map((o) => o.id), [...BOARD.legacyMoods, "noir", "road", "friends-week"]);
  assert.ok(fs.existsSync(path.join(boarded.out, "data", "index-v2-mood-noir.json")) && fs.existsSync(path.join(boarded.out, "data", "index-v2-mood-road.json")));
});

// Marco, 13/10/2026 (review): verify-public counts the covers a v2 index references. A cover only index-v2.json points at must be accepted; without the pointer it is an orphan.
test("verify-public: a cover referenced only by index-v2.json is referenced; the same file with no reference is an orphan", { timeout: 300000 }, () => {
  const { boarded, work } = builds();
  const { verifyPublic } = require("../lib/learning/public");
  const dir = path.join(work, "planted");
  fs.cpSync(boarded.out, dir, { recursive: true });
  assert.equal(verifyPublic(dir), true, "the copy is a sound publication before anything is planted");
  const file = path.join(dir, "data", "index-v2.json"), json = JSON.parse(fs.readFileSync(file, "utf8"));
  const inSlices = new Set();
  for (const n of fs.readdirSync(path.join(dir, "data")).filter((x) => /^index-v2-(?:row|mood|opt)-/.test(x))) for (const r of JSON.parse(fs.readFileSync(path.join(dir, "data", n), "utf8")).films) inSlices.add(r[0]);
  const row = json.films.find((r) => !inSlices.has(r[0]) && (r[json.cols.indexOf("poster")] == null));
  const col = json.cols.indexOf("poster"), tt = row[0];
  const before = JSON.stringify(json);
  while (row.length <= col) row.push(null);
  row[col] = `https://example.test/posters/${tt}.jpg`;
  fs.writeFileSync(file, JSON.stringify(json));
  fs.mkdirSync(path.join(dir, "posters"), { recursive: true });
  fs.writeFileSync(path.join(dir, "posters", `${tt}.jpg`), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1500), Buffer.from([0xff, 0xd9])]));
  assert.equal(verifyPublic(dir), true, "referenced by the v2 index alone: accepted");
  fs.writeFileSync(file, before);
  assert.throws(() => verifyPublic(dir), /Unreferenced poster/, "no index points at it: an orphan");
});

// 19/10/2026: the address of a cover carries ?v=<8 characters> (lib/posters.js); the public check reads the static catalogs through it and still refuses the cover of another film
test("verify-public: a static catalog meta whose poster is ?v= of ANOTHER film's cover is refused, with or without the version", { timeout: 300000 }, () => {
  const { boarded, work } = builds();
  const { verifyPublic } = require("../lib/learning/public");
  const dir = path.join(work, "planted-v");
  fs.cpSync(boarded.out, dir, { recursive: true });
  assert.equal(verifyPublic(dir), true);
  const file = path.join(dir, "catalog", "movie", fs.readdirSync(path.join(dir, "catalog", "movie")).find((n) => /\.json$/.test(n)));
  const body = JSON.parse(fs.readFileSync(file, "utf8")), meta = body.metas[0];
  const other = meta.id === "tt0000001" ? "tt0000002" : "tt0000001";
  for (const q of ["?v=0123abcd", ""]) {
    meta.poster = `https://marcogusmao.github.io/mood-engine/posters/${other}.jpg${q}`;
    fs.writeFileSync(file, JSON.stringify(body));
    assert.throws(() => verifyPublic(dir), /Poster identity mismatch/, `poster of another film${q ? " with its version" : ""}`);
  }
});

// Marco, 28/10/2026 (answer (b) of question 4, Discover proposal 5): the seven friends are whole friends and the Worker's Friends menu gets "All friends loved" after the Top options. Two things this file has to say:
// (1) the option is part of the LEGACY family and does not depend on the Board: the build without a board (where data/discover-catalogs.json is not read and the default spread is used) and the build with one (which uses the file's
//     `spread`) make the same option, film by film and in the same place; that holds while the file's spread and lib/friends-option.js DEFAULT_SPREAD are the same numbers, and this test is where a change of one of them shows up;
// (2) the STATIC addon does not carry it, and its seven friends are the same seven: the index's menu is the static menu plus that one option (before 28/10/2026 both had the four friends). That difference is intentional.
// Written against: the option inserted only when a Board is present (the legacy index would lose it), and the file's spread drifting from the default one.
test("legacy parity, All friends loved: the legacy index has the option in the same place and with the same films with or without a board, and the static addon has seven friends and not the option", { timeout: 300000 }, () => {
  const { plain, boarded } = builds();
  const { decode } = require("../lib/index-rows");
  const menu = (dir) => decode(JSON.parse(fs.readFileSync(path.join(dir, "data", "index.json"), "utf8"))).friends.options;
  const a = menu(plain.out), b = menu(boarded.out);
  const ALL = "All friends loved", tops = a.filter((o) => o.label.startsWith("Top · ")).length;
  assert.equal(tops, PRODUCTION.friends.length, "one Top option per configured friend: the seven");
  assert.equal(a.findIndex((o) => o.label === ALL), tops, "right after the last Top option");
  assert.deepEqual(a, b, "the whole friends menu of the legacy index, film by film, whether the build has a board or not");
  assert.ok(a.find((o) => o.label === ALL).ids.length > 100, "and it is not empty");
  const man = JSON.parse(fs.readFileSync(path.join(plain.out, "manifest.json"), "utf8"));
  const staticMenu = man.catalogs.find((c) => c.id === "mood-engine-friends").extra[0].options;
  assert.deepEqual(a.map((o) => o.label).filter((l) => l !== ALL), staticMenu, "the static addon has the same seven friends in the same order, and no All friends loved");
  assert.equal(staticMenu.filter((l) => l.startsWith("Top · ")).length, 7);
});
