#!/usr/bin/env node
// The mutation receipts of the five changes of 14/11/2026 (branch lugares-e-fileiras: shorts, whole keywords, the country of an English-language film, rows up to 100, Worth watching again at 4★).
// Each mutation puts one defect back in a COPY of the code (lib/, test/, test-support/, build.js, config.json and cache/ are copied; every other top-level entry is a link) and runs the test files named
// for it; it is "caught" when at least one test turns red. The unchanged copy runs first and must be green, or nothing below means anything.
//   node test-support/lugares-mutacoes.js [group]      group: shorts, keywords, country, sizes, rewatch (default: all)
// Load (Marco, 20/10/2026 and 22/10/2026): one `node --test --test-concurrency=1` at a time, under taskpolicy -b nice -n 19; before each run it waits while 3 or more heavy node processes run.
// Mutations no test catches are listed in SURVIVORS with the reason, and the runner prints them: they are information, not a failure to hide.

const fs = require("fs"), os = require("os"), path = require("path");
const { spawnSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const COPY = ["lib", "test", "test-support", "build.js", "config.json", "cache"]; // cache too: a test that runs a build may write a cache file, and it must not be the checkout's

const T = { shorts: ["test/shorts-floor.test.js"], keywords: ["test/keywords-whole.test.js", "test/slow-mood.test.js"], country: ["test/english-origin.test.js", "test/origin-country.test.js"],
  sizes: ["test/row-sizes.test.js::config.json sizes|Friends loved takes|2-mood|window of 50|moodRepeatWindow", "test/special-rows.test.js::top-picks: the 4.5|top-picks: a film Marco has seen", "test/board-production.test.js::special rows carry"],
  rewatch: ["test/rewatch-four-stars.test.js", "test/rewatch-shares.test.js"] };

// [group, name, file, from, to, tests]
const MUTATIONS = [
  ["shorts", "S1 Tonight, Because and Directors ignore the floor (ok asks the rule alone)", "lib/rows.js", "const ok = (c) => eligible(c.film.imdb) && !isShort(c.film.runtime, minMinutes);", "const ok = (c) => eligible(c.film.imdb);", T.shorts],
  ["shorts", "S2 the mood rows and the menu list ignore the floor", "lib/rows.js", "list.filter((c) => asks(c) && !isShort(c.film.runtime, minMinutes))", "list.filter((c) => asks(c))", T.shorts],
  ["shorts", "S3 a film of exactly 40 minutes is a short", "lib/pool.js", "minutes > 0 && minutes < min;", "minutes > 0 && minutes <= min;", T.shorts],
  ["shorts", "S4 a film with no runtime is a short", "lib/pool.js", "const isShort = (minutes, min = MIN_FEATURE_MINUTES) => typeof minutes === \"number\" && minutes > 0 && minutes < min;", "const isShort = (minutes, min = MIN_FEATURE_MINUTES) => !(minutes >= min);", T.shorts],
  ["shorts", "S5 the number of config.json is not read (40 written in the code)", "lib/pool.js", "cfg.shortRow.minMinutes != null ? cfg.shortRow.minMinutes : MIN_FEATURE_MINUTES", "false ? cfg.shortRow.minMinutes : MIN_FEATURE_MINUTES", T.shorts],
  ["shorts", "S6 the v2 Board's floor lets everything through", "lib/board-rows.js", "const feature = (c) => !isShort(c.film.runtime, minMinutes);", "const feature = (c) => true;", T.shorts],
  ["shorts", "S7 the v2 filter rows ignore the floor", "lib/board-rows.js", "eligible(c.film.imdb) && feature(c)), size);", "eligible(c.film.imdb)), size);", T.shorts],
  ["shorts", "S8 the v2 combined rows ignore the floor", "lib/board-rows.js", "accept: (c) => eligible(c.film.imdb) && feature(c) && room(c) });", "accept: (c) => eligible(c.film.imdb) && room(c) });", T.shorts],
  ["shorts", "S9 the v2 mood rows ignore the floor", "lib/board-rows.js", "eligible(x.film.imdb) && feature(x)), size * 2)", "eligible(x.film.imdb)), size * 2)", T.shorts],
  ["shorts", "S10 the v2 watchlist loses its shorts", "lib/board-rows.js", "newestFirst(watchlistCands.filter((c) => eligible(c.film.imdb))", "newestFirst(watchlistCands.filter((c) => eligible(c.film.imdb) && feature(c))", T.shorts],
  ["shorts", "S11 the legacy watchlist loses its shorts", "lib/rows.js", "pool.filter((c) => c.watchlist && eligible(c.film.imdb))", "pool.filter((c) => c.watchlist && ok(c))", T.shorts],
  ["shorts", "S12 Friend's top picks takes a short", "lib/special-rows.js", "    if (ctx.short(rec)) return; // no short (14/11/2026)\n", "", T.shorts],
  ["shorts", "S13 Friends can't agree takes a short", "lib/special-rows.js", "    if (ctx.short(rec)) continue; // no short (14/11/2026)\n", "", T.shorts],
  ["shorts", "S14 Great directors you've never seen takes a short", "lib/special-rows.js", "ctx.filmSeen(c.film) || P.isShort(c.film.runtime, ctx.minMinutes)) continue;", "ctx.filmSeen(c.film)) continue;", T.shorts],
  ["shorts", "S15 Actor of the week takes a short", "lib/special-rows.js", "    if (P.isShort(c.film.runtime, ctx.minMinutes)) continue; // no short (14/11/2026)\n", "", T.shorts],
  ["shorts", "S16 Friends watched this month is not handed the floor", "lib/special-rows.js", "period: `in the last ${spec.days} days`, minRuntime: ctx.minMinutes });", "period: `in the last ${spec.days} days` });", T.shorts],
  ["shorts", "S17 a ctx without the number has no floor", "lib/special-rows.js", "ctx.minFeatureMinutes ?? P.MIN_FEATURE_MINUTES;", "ctx.minFeatureMinutes ?? 0;", T.shorts],
  ["shorts", "S18 weekRow's floor is gone", "lib/pool.js", "if (minRuntime && isShort((detail(rec) && detail(rec).runtime) || rec.rt, minRuntime)) {", "if (false) {", T.shorts],
  ["shorts", "S19 Friends loved takes a short", "lib/rows.js", "eligible(r.imdbId) && !isShort((detail(r) && detail(r).runtime) || r.rt, minFeatureMinutes(cfg))", "eligible(r.imdbId)", T.shorts],
  ["shorts", "S20 the decade, country and rating cuts take shorts again", "lib/pool.js", "if (isShort(runtimeOf(r), minRuntime)) { missing.shortFilms++; return false; } return true;", "return true;", T.shorts],
  ["shorts", "S21 build.js does not hand the number to the special rows", "build.js", " minFeatureMinutes: P.minFeatureMinutes(cfg), // no short", " // no short", T.shorts],
  ["shorts", "S22 build.js: Best of your lists and New releases take shorts", "build.js", "const features = passing.filter((r) => !P.isShort(P.runtimeOf(r), P.minFeatureMinutes(cfg)));", "const features = passing;", T.shorts],
  ["shorts", "S23 build.js: Friends watched this week is not handed the floor", "build.js", "eligible: recommendable, minRuntime: P.minFeatureMinutes(cfg) }), (w) => w.items);", "eligible: recommendable }), (w) => w.items);", T.shorts],
  ["shorts", "S25 build.js: `features` is `passing`, the filter kept only in a comment (the reviewer's mutant)", "build.js", "    const features = passing.filter((r) => !P.isShort(P.runtimeOf(r), P.minFeatureMinutes(cfg)));", "    const features = passing; // const features = passing.filter((r) => !P.isShort(P.runtimeOf(r), P.minFeatureMinutes(cfg)));", T.shorts],
  ["shorts", "S26 the web picker keeps its shorts", "lib/pool.js", "(films || []).filter((x) => !isShort(x && x.r, min));", "(films || []);", T.shorts],
  ["shorts", "S27 the web picker's Tonight ids do not follow the films that stay", "build.js", "    webData.films = P.dropShortPicks(webData.films, P.minFeatureMinutes(cfg));\n    const kept = new Set(webData.films.map((x) => x.t));\n    webData.tonight = webData.tonight.filter((id) => kept.has(id));", "    webData.films = P.dropShortPicks(webData.films, P.minFeatureMinutes(cfg));", T.shorts],
  ["shorts", "S28 build.js does not run the web picker's floor", "build.js", "    webData.films = P.dropShortPicks(webData.films, P.minFeatureMinutes(cfg));", "    webData.films = webData.films;", T.shorts],
  ["shorts", "S24 config.json floor at 30 minutes", "config.json", "\"minMinutes\": 40", "\"minMinutes\": 30", T.shorts],
  ["keywords", "K1 every term matches inside any keyword again (the code of 1f53579)", "lib/moods.js", "const matches = inside ? (k) => t.re.test(k) : (k) => k === tn || (named.has(k) && t.re.test(k));", "const matches = (k) => t.re.test(k);", T.keywords],
  ["keywords", "K2 the compounds a recipe names are ignored", "lib/moods.js", "(named.has(k) && t.re.test(k))", "false", T.keywords],
  ["keywords", "K3 a NEGATIVE term matches only the whole keyword (the review's defect: holocaust (shoah), suicide attempt)", "lib/moods.js", "const inside = t.w <= 0 ||", "const inside = false ||", T.keywords],
  ["keywords", "K4 keywords compared raw (no trim, no case, no inner space)", "lib/moods.js", "const kws = (film.keywords || []).map(kwNorm);", "const kws = film.keywords || [];", T.keywords],
  ["keywords", "K5 no trim at the ends (\"simulated reality \")", "lib/moods.js", "String(k == null ? \"\" : k).trim().replace(", "String(k == null ? \"\" : k).replace(", T.keywords],
  ["keywords", "K6 a family counts more than once (the dedup removed)", "lib/moods.js", "if (hits.some((h) => h.includes(t.term) || t.term.includes(h))) continue;", "", T.keywords],
  ["keywords", "K7 the compounds enter the terms, and so the index's search words (allowlist)", "lib/moods.js", "_terms: Object.entries(m.keywords || {}).map(", "_terms: Object.entries({ ...(m.keywords || {}), ...Object.fromEntries((m.compoundKeywords || []).map((k) => [k, 2])) }).map(", T.keywords],
  ["keywords", "K8 Noir's mark removed from config.json", "config.json", "\"insideKeywords\": { \"noir\":", "\"insideKeywordsOff\": { \"noir\":", T.keywords],
  ["keywords", "K9 the mark is not read by the code", "lib/moods.js", "!!(mood.insideKeywords && Object.hasOwn(mood.insideKeywords, t.term))", "false", T.keywords],
  ["keywords", "K10 the index's matcher moves to the whole keyword", "lib/moods.js", "re: new RegExp(`(^|[^a-z])${esc(term)}([^a-z]|$)`) })),", "re: new RegExp(`^${esc(term)}$`) })),", T.keywords],
  ["keywords", "K11 every positive term treated as marked (inside any keyword)", "lib/moods.js", "const inside = t.w <= 0 ||", "const inside = true ||", T.keywords],
  ["keywords", "K12 Lift loses \"female friendship\"", "config.json", "\"female friendship\",", "", T.keywords],
  ["keywords", "K14 Night drive answers \"money heist\" otherwise than Noir, Escape and Action (one answer per compound)", "config.json", "\"compoundKeywords\": [\"french noir\",\"japanese noir\",\"tech noir\",\"western noir\",\"british noir\",\"future noir\",\"nordic noir\",\"night life\",\"night shift\",\"stormy night\",\"night train\",\"bank heist\",\"heist gone wrong\",\"jewelry heist\",\"diamond heist\",\"art heist\",\"money heist\",\"gold heist\",\"botched heist\",\"former gangster\",\"female gangster\",\"gangster boss\",\"bank robbery\",\"armed robbery\",\"hold-up robbery\",\"botched robbery\",\"train robbery\",\"attempted robbery\",\"armored car robbery\",\"payroll robbery\",\"police detective\",\"amateur detective\",\"detective inspector\",\"narcotics detective\",\"detective story\",\"former detective\",\"female detective\",\"hardboiled detective\",\"railroad detective\",\"art detective\",\"eccentric detective\",\"retired detective\",\"conspiracy thriller\",\"corporate conspiracy\",\"police corruption\",\"political corruption\",\"systemic corruption\",\"government corruption\",\"mob corruption\"]", "\"compoundKeywords\": [\"french noir\",\"japanese noir\",\"tech noir\",\"western noir\",\"british noir\",\"future noir\",\"nordic noir\",\"night life\",\"night shift\",\"stormy night\",\"night train\",\"bank heist\",\"heist gone wrong\",\"jewelry heist\",\"diamond heist\",\"art heist\",\"gold heist\",\"botched heist\",\"former gangster\",\"female gangster\",\"gangster boss\",\"bank robbery\",\"armed robbery\",\"hold-up robbery\",\"botched robbery\",\"train robbery\",\"attempted robbery\",\"armored car robbery\",\"payroll robbery\",\"police detective\",\"amateur detective\",\"detective inspector\",\"narcotics detective\",\"detective story\",\"former detective\",\"female detective\",\"hardboiled detective\",\"railroad detective\",\"art detective\",\"eccentric detective\",\"retired detective\",\"conspiracy thriller\",\"corporate conspiracy\",\"police corruption\",\"political corruption\",\"systemic corruption\",\"government corruption\",\"mob corruption\"]", T.keywords],
  ["keywords", "K13 Somewhere else takes \"time travel\"", "config.json", "\"village life\"", "\"time travel\", \"village life\"", T.keywords],
  ["country", "C1 the English rule is gone (the director first again, the code of 1f53579)", "lib/countries.js", "  if (claimed.length === 1 && languageCode(lang) === \"en\" && prod.includes(claimed[0])) return { iso: claimed[0], from: \"origin\" };\n", "", T.country],
  ["country", "C2 the rule for every language (Roma would be American)", "lib/countries.js", "if (claimed.length === 1 && languageCode(lang) === \"en\" && prod.includes(claimed[0])) return", "if (claimed.length === 1 && prod.includes(claimed[0])) return", T.country],
  ["country", "C3 the rule with several origins too (the first one wins)", "lib/countries.js", "if (claimed.length === 1 && languageCode(lang) === \"en\" && prod", "if (claimed.length >= 1 && languageCode(lang) === \"en\" && prod", T.country],
  ["country", "C5 the single origin wins even when it is no producer (the rule of 14/11, before Marco's answer of 15/11)", "lib/countries.js", " && prod.includes(claimed[0])) return { iso: claimed[0], from: \"origin\" };", ") return { iso: claimed[0], from: \"origin\" };", T.country],
  ["country", "C4 the rule for the films NOT in English", "lib/countries.js", "languageCode(lang) === \"en\" && prod.includes(claimed[0])) return { iso: claimed[0]", "languageCode(lang) !== \"en\" && prod.includes(claimed[0])) return { iso: claimed[0]", T.country],
  ["sizes", "Z1 sizes.row back to 50", "config.json", "\"row\": 100,", "\"row\": 50,", T.sizes],
  ["sizes", "Z2 sizes.because back to 20", "config.json", "\"because\": 100,", "\"because\": 20,", T.sizes],
  ["sizes", "Z3 sizes.directors back to 24", "config.json", "\"directors\": 100,", "\"directors\": 24,", T.sizes],
  ["sizes", "Z4 sizes.oldFriends back to 24", "config.json", "\"oldFriends\": 100,", "\"oldFriends\": 24,", T.sizes],
  ["sizes", "Z5 sizes.friends back to 50", "config.json", "\"friends\": 100,", "\"friends\": 50,", T.sizes],
  ["sizes", "Z6 Friend's top picks back to 60 in config.json", "config.json", "\"fillStars\": 4, \"size\": 100}", "\"fillStars\": 4, \"size\": 60}", T.sizes],
  ["sizes", "Z7 Loved by your directors back to its default 30", "config.json", "    \"size\": 100,\n    \"_doc\": \"Loved by your directors", "    \"_doc\": \"Loved by your directors", T.sizes],
  ["sizes", "Z8 Friends loved cut at the Discover cap again", "lib/rows.js", "cands.slice(0, cfg.sizes?.friends ?? size)", "cands.slice(0, size)", T.sizes],
  ["sizes", "Z9 the default top-picks row of lib/special-rows.js back to 60", "lib/special-rows.js", "fillStars: 4, size: 100 },", "fillStars: 4, size: 60 },", T.sizes],
  ["sizes", "Z10 tonight grows too", "config.json", "\"tonight\": 10,", "\"tonight\": 100,", T.sizes],
  ["sizes", "Z11 the Discover cuts back to 60", "config.json", "\"cuts\": 100,", "\"cuts\": 60,", T.sizes],
  ["sizes", "Z12 the friends' Discover collections back to 60", "config.json", "\"friendsDiscover\": 100,", "\"friendsDiscover\": 60,", T.sizes],
  ["rewatch", "R1 config.json back to 4.5", "config.json", "\"rewatchMinStars\": 4", "\"rewatchMinStars\": 4.5", T.rewatch],
  ["rewatch", "R2 build.js filters with a 4.5 of its own", "build.js", "!excluded.has(f.film.imdb) && f.rating >= REWATCH_MIN)", "!excluded.has(f.film.imdb) && f.rating >= 4.5)", T.rewatch],
  ["rewatch", "R3 a config without the key gets the number of before", "build.js", "  if (v === undefined) return 4;\n", "  if (v === undefined) return 4.5;\n", T.rewatch],
  ["rewatch", "R4 a value that is not a number is let through", "build.js", "if (typeof v !== \"number\" || !Number.isFinite(v) || v < 0.5 || v > 5) throw", "if (false) throw", T.rewatch],
  ["rewatch", "R6 a second filter at 4.5 after the 730 days (the reviewer's mutant)", "build.js", "    .filter((r) => !r.lastSeen || r.lastSeen < daysAgo(cfg.build.rewatchAfterDays));", "    .filter((r) => !r.lastSeen || r.lastSeen < daysAgo(cfg.build.rewatchAfterDays)).filter((r) => r.rating >= 4.5);", T.rewatch],
  ["rewatch", "Q1 a quota changed: 5★ 30 instead of 40", "config.json", "{ \"stars\": 5, \"places\": 40 }", "{ \"stars\": 5, \"places\": 30 }", T.rewatch],
  ["rewatch", "Q2 the rest of a short group goes UP first", "lib/rows.js", "const order = [...Array.from({ length: places.length - i - 1 }, (_, j) => i + 1 + j), ...Array.from({ length: i }, (_, j) => i - 1 - j)];", "const order = [...Array.from({ length: i }, (_, j) => i - 1 - j), ...Array.from({ length: places.length - i - 1 }, (_, j) => i + 1 + j)];", T.rewatch],
  ["rewatch", "Q3 the groups ignored (every film in the first)", "lib/rows.js", "const groupOf = (rating) => { const i = shares.findIndex((b) => rating >= b.stars); return i < 0 ? shares.length - 1 : i; };", "const groupOf = (rating) => 0;", T.rewatch],
  ["rewatch", "Q4 a rating between two shares falls in the upper one", "lib/rows.js", "shares.findIndex((b) => rating >= b.stars)", "Math.max(0, shares.findIndex((b) => rating >= b.stars) - (shares.some((b) => b.stars === rating) ? 0 : 1))", T.rewatch],
  ["rewatch", "Q5 the rest of a short group is lost", "lib/rows.js", "    for (const j of order) { const room", "    for (const j of []) { const room", T.rewatch],
  ["rewatch", "Q6 the shares not taken in proportion of the row's size", "lib/rows.js", "exact = shares.map((b) => (b.places * size) / total)", "exact = shares.map((b) => b.places)", T.rewatch],
  ["rewatch", "R5 the order of Old friends: a draw of up to 1.2 instead of 0.9", "lib/rows.js", "r.rating + (r.liked ? 0.25 : 0) + rand() * 0.9", "r.rating + (r.liked ? 0.25 : 0) + rand() * 1.2", T.rewatch],
];
const SURVIVORS = [
  ["rewatch", "R5 the draw of Old friends up to 1.2 instead of 0.9", "since the places are reserved by rating (15/11/2026) a group holds one rating, so the width of the draw does not change which films a group takes; it would change only the weight of the +0.25 of a liked film (no film is liked in the export) and the order between groups, where the chosen 5★ films sit above 5.5 and a 4★ film reaches 5.2 at most: an equivalent mutation on today's data"],
];

function heavy() { const r = spawnSync("/bin/sh", ["-c", "ps -axo command | grep -E \"^(/[^ ]*/)?node .*(build\\.js|--test)\" | grep -v grep | wc -l"], { encoding: "utf8" }); return Number(r.stdout.trim()) || 0; }
function waitLoad() { while (heavy() >= 3) spawnSync("/bin/sleep", ["15"]); }
function copyTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lugares-mut-"));
  for (const e of fs.readdirSync(ROOT)) {
    if (e === ".git") continue;
    if (COPY.includes(e)) fs.cpSync(path.join(ROOT, e), path.join(dir, e), { recursive: true });
    else fs.symlinkSync(path.join(ROOT, e), path.join(dir, e));
  }
  return dir;
}
function runTests(dir, files) {
  for (const f of files) {
    waitLoad();
    const [file, pattern] = f.split("::"); // "file::pattern" runs only the tests whose name matches (a file whose other tests run a whole build)
    const r = spawnSync("taskpolicy", ["-b", "nice", "-n", "19", process.execPath, "--test", "--test-concurrency=1", ...(pattern ? [`--test-name-pattern=${pattern}`] : []), file], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const fail = /# fail (\d+)|ℹ fail (\d+)/.exec(r.stdout);
    const n = fail ? Number(fail[1] || fail[2]) : NaN;
    if (r.status !== 0 || n > 0) return { red: true, file: f, failed: Number.isNaN(n) ? "?" : n };
  }
  return { red: false };
}

const group = process.argv[2] || null;
const list = MUTATIONS.filter((m) => !group || m[0] === group);
const files = [...new Set(list.flatMap((m) => m[5]))];
const base = copyTree();
const green = runTests(base, files);
fs.rmSync(base, { recursive: true, force: true });
if (green.red) { console.log(`the unchanged copy is RED (${green.file}): no receipt`); process.exit(2); }
console.log(`unchanged copy: green (${files.join(", ")})`);
let caught = 0;
for (const [g, name, file, from, to, tests] of list) {
  const dir = copyTree();
  try {
    const p = path.join(dir, file), src = fs.readFileSync(p, "utf8");
    const at = src.indexOf(from);
    if (at < 0 || src.indexOf(from, at + 1) >= 0) { console.log(`?? ${name}: the text to mutate is ${at < 0 ? "missing" : "there twice"} in ${file}`); continue; }
    fs.writeFileSync(p, src.slice(0, at) + to + src.slice(at + from.length));
    const r = runTests(dir, tests);
    if (r.red) caught++;
    console.log(`${r.red ? "caught" : "SURVIVED"} ${name}${r.red ? ` — ${r.file}: ${r.failed} red` : ""}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
console.log(`${caught} of ${list.length} caught`);
for (const [g, name, why] of SURVIVORS.filter((s) => !group || s[0] === group)) console.log(`not caught by any test: ${name} — ${why}`);
