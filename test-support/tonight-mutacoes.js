#!/usr/bin/env node
"use strict";
// Receipts of mutation for Tonight's bigger pool and its memory of 30 days (Marco, 14/11/2026; lib/rows.js, lib/tonight-memory.js, build.js, the nightly's list of caches).
// Plants the defects below, one at a time, in a COPY of the code, and says which tests of test/tonight-memory.test.js, test/tonight-draw.test.js and test/tonight-exclude.test.js turn red.
// Lives in test-support/ and not in test/ because everything in test/ runs as a test.
//
//   taskpolicy -b nice -n 19 node test-support/tonight-mutacoes.js [--so M4,M7] [--com-cache [--teste "<pattern of test names>"]]
//     --so          only these ids
//     --com-cache   link the repository's cache/ into the copy, so the tests that BUILD run too (each build is one to two minutes at low priority): the way to show that the executed build of
//                   test/tonight-exclude.test.js, and not only the test that reads the text of build.js, sees M43, M44, M45 and S2. Use it with --so and --teste; the whole list with builds is hours.
//     --teste       run only the tests whose name matches (node --test-name-pattern)
//
// How: the work tree is never edited. A temporary folder gets real copies of lib/, scripts/, .github/, build.js, config.json and the three test files, and links to the folders that are only read (data/, web/, tools/ …); it has NO cache/, so the
// tests that build from the caches are skipped there (the executed build of test/tonight-exclude.test.js is run by hand on the work tree, not here). First the three files run on the unchanged copy and must be
// green ("bateria original: verde"; otherwise the instrument is broken and nothing is measured). For each mutation every edit must find EXACTLY ONE occurrence of its text ("MUTAÇÃO NÃO APLICÁVEL" otherwise:
// the instrument is blind, not the test) and the mutated file must still parse (`node --check`; "ERRO DE EXECUÇÃO" otherwise: a file that does not load proves nothing). Then the tests run with the TAP
// reporter and the red test names are read from it. MORTA: one of the tests named in `testes` is red. MORTA POR OUTRO TESTE: red, but none of the named ones. SOBREVIVEU: all green.
// A mutation marked `sobrevive: "<why>"` is one we EXPECT no test of the copy to see; it is listed so that the next person reads what is not guarded. One of those that dies, or one of the others that
// survives, makes the run fail.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const TESTS = ["test/tonight-memory.test.js", "test/tonight-draw.test.js", "test/tonight-exclude.test.js"];
const COPIED = ["lib", "scripts", ".github", "build.js", "config.json"];
const COM_CACHE = process.argv.includes("--com-cache");
const TESTE = process.argv.includes("--teste") ? process.argv[process.argv.indexOf("--teste") + 1] : null;
const NOT_LINKED = new Set([...COPIED, "test", ...(COM_CACHE ? [] : ["cache"]), "docs", "worker", "node_modules", ".git", ".context", ".DS_Store"]); // everything else at the top of the repository is linked (data/, web/, tools/ …): read, never mutated
const ROWS = "lib/rows.js", MEM = "lib/tonight-memory.js", BUILD = "build.js", CFG = "config.json", SH = "scripts/noturna-mac.sh", YML = ".github/workflows/mood-engine.yml", BOUNDARY = "scripts/verify-artifact-boundaries.js";

const T = {
  sixty: "^60 days in a row with the memory file",
  control: "^control of the measure above",
  config: "^config\\.json says tonight\\.depth 40",
  bad: "^tonight\\.depth must be a whole number",
  badBuild: "^a bad tonight\\.depth or tonight\\.noRepeatDays in the config stops build\\.js",
  depth: "^the draw reads tonight\\.depth",
  window: "^the window reads tonight\\.noRepeatDays",
  deeper: "^relief, first step",
  moved: "^relief, second step",
  repeat: "^relief, third step",
  short: "^relief never shortens the row",
  later: "^a film of the memory enters the row only after every free film",
  twoMoods: "^a film that is at the top of two moods",
  badFile: "^the memory file that cannot be used",
  nightGoesOn: "^the night goes on with a memory file that cannot be used",
  whoWrites: "^today's Tonight is written only by a build that publishes",
  file: "^the memory file: a second write on the same day",
  inBuild: "^the code build\\.js runs",
  published: "^what is recorded is the row as published",
  seeded: "^the draw is seeded by the day",
  oldFriends: "^Old friends keeps the order of the day when a mood is wholly in the memory",
  pinTop: "^a pinned film obeys the 30 days",
  pinForty: "^a pinned film inside the top 40",
  tenth: "^the tenth film obeys the 30 days",
  wiring: "^build\\.js reads the memory before the draw",
  nightly: "^the nightly saves the file and sets its switch",
  even: "^Tonight's first pass draws evenly among the top `depth`",
  pinned1310: "^Tonight with sizes\\.tonight 6 is what it was before the extension",
  person: "^a person's build \\(Will\\) draws Tonight by Marco's rule",
  personMemory: "^a person's memory is a file of the person's own",
  personStrict: "^the list of published revisions and the pending rows",
  personLink: "^a symbolic link at the person's cache/tonight-memory\\.json is refused",
  pinsConfig: "^no film is pinned and excluded at once",
  pinsBuild: "^build\\.js stops at its first step when a film is pinned and excluded",
  plantedBuild: "^build --cache-only with a planted tonight-memory\\.json", // runs only with --com-cache
};

/** [id, what the defect is, [[file, text, replacement] …], [tests expected red], sobrevive? (why no test of the copy sees it), true when that only holds WITHOUT the caches (with --com-cache the named test must turn red)] */
const MUTACOES = [
  // the five the request names
  ["M1", "the pool is twelve again when the config says nothing (the default depth 12)", [[ROWS, "const TONIGHT_DEPTH = 40;", "const TONIGHT_DEPTH = 12;"]], [T.config, T.depth]],
  ["M2", "the window is ignored by the draw (no film is ever held back)", [[ROWS, "const free = (c) => !tonightShown.has(c.film.imdb);", "const free = () => true;"]], [T.sixty, T.deeper, T.pinTop, T.tenth]],
  ["M3", "today's own entry is read (a second build of the day holds back the films of the first)", [[MEM, "const first = shiftDate(today, -noRepeatDays), last = shiftDate(today, -1);", "const first = shiftDate(today, -noRepeatDays), last = today;"]], [T.inBuild, T.window]],
  ["M4", "a build that does not publish writes the memory (TONIGHT_MEMORY_WRITE not asked: a rehearsal, a test, a build typed in a terminal)", [[MEM, '  if (env.TONIGHT_MEMORY_WRITE !== "1") return { written: false, why: "TONIGHT_MEMORY_WRITE is not 1: only a build that publishes writes" };\n', ""]], [T.whoWrites, T.inBuild, T.nightGoesOn]],
  ["M53", "the memory follows the front memory's switch again: --manual publishes Tonight and records nothing (the defect of before the review of 14/11/2026)", [[MEM, 'if (env.TONIGHT_MEMORY_WRITE !== "1")', 'if (env.FRONT_MEMORY_WRITE !== "1")']], [T.whoWrites, T.inBuild, T.sixty]],
  ["M5", "the relief gives a short row (the films of the memory never return to complete it)", [[ROWS, '      if (all.length) take(id, oldest(all), "repeat");', "      if (all.length) continue;"]], [T.short, T.later]],
  // the pool
  ["M6", "config.json says depth 12", [[CFG, '"depth": 40', '"depth": 12']], [T.config]],
  ["M7", "config.json says noRepeatDays 0", [[CFG, '"noRepeatDays": 30', '"noRepeatDays": 0']], [T.config]],
  ["M8", "tonight.depth is not read (the constant instead)", [[ROWS, "const depth = t.depth === undefined ? TONIGHT_DEPTH : t.depth,", "const depth = TONIGHT_DEPTH,"]], [T.depth, T.config, T.even, T.pinned1310]],
  ["M9", "the default window is 0 days when the config says nothing", [[ROWS, "const TONIGHT_NO_REPEAT_DAYS = 30;", "const TONIGHT_NO_REPEAT_DAYS = 0;"]], [T.config]],
  ["M10", "tonight.depth 0 is accepted", [[ROWS, "if (!Number.isInteger(depth) || depth < 1)", "if (!Number.isInteger(depth) || depth < 0)"]], [T.bad, T.badBuild]],
  ["M11", "tonight.noRepeatDays 2.5 or \"30\" is accepted", [[ROWS, "if (!Number.isInteger(noRepeatDays) || noRepeatDays < 0)", "if (noRepeatDays < 0)"]], [T.bad, T.badBuild]],
  ["M12", "the draw leans to the top again (exponent 1.6 whatever the config)", [[ROWS, "const u = rand() ** bias;", "const u = rand() ** 1.6;"]], [T.even, T.depth]],
  // the window
  ["M13", "the window is 29 days (the 30th day back is free)", [[MEM, "const first = shiftDate(today, -noRepeatDays), last", "const first = shiftDate(today, -noRepeatDays + 1), last"]], [T.pinTop, T.window, T.sixty]],
  ["M14", "the window is 31 days", [[MEM, "const first = shiftDate(today, -noRepeatDays), last", "const first = shiftDate(today, -noRepeatDays - 1), last"]], [T.pinTop, T.window]],
  ["M15", "dates after today are read", [[MEM, "return [...days.keys()].filter((d) => d >= first && d <= last).sort();", "return [...days.keys()].filter((d) => d >= first).sort();"]], [T.inBuild, T.window]],
  ["M16", "a pinned film is exempt from the memory", [[ROWS, "const free = (c) => !tonightShown.has(c.film.imdb);", "const free = (c) => !tonightShown.has(c.film.imdb) || c.pins?.length > 0;"]], [T.pinTop, T.pinForty]],
  ["M17", "the tenth film ignores the memory (the mood's best film not in the row)", [[ROWS, "const all = left(id), at = all.findIndex(free);", "const all = left(id), at = all.length ? 0 : -1;"]], [T.tenth, T.later]],
  // the relief
  ["M18", "no relief \"deeper\": a mood whose top 40 was shown gives up its place though it has free films below the forty", [[ROWS, "const below = all.slice(depth).find(free);", "const below = null;"]], [T.deeper]],
  ["M19", "the relief \"deeper\" takes the WORST free film below the forty", [[ROWS, "const below = all.slice(depth).find(free);", "const below = all.slice(depth).reverse().find(free);"]], [T.deeper]],
  ["M20", "the relief \"repeat\" brings back the film shown most RECENTLY", [[ROWS, "(tonightShown.get(c.film.imdb) < tonightShown.get(a.film.imdb) ? c : a)", "(tonightShown.get(c.film.imdb) > tonightShown.get(a.film.imdb) ? c : a)"]], [T.repeat, T.later]],
  ["M21", "of two films shown the same oldest day the WORSE-ranked returns", [[ROWS, "(tonightShown.get(c.film.imdb) < tonightShown.get(a.film.imdb) ? c : a)", "(tonightShown.get(c.film.imdb) <= tonightShown.get(a.film.imdb) ? c : a)"]], [T.repeat]],
  ["M22", "a mood wholly in the memory repeats a film though another mood has a free one (the order of before the review of 14/11/2026)", [[ROWS, "    else waiting.push(id);", "    else take(id, oldest(all), \"repeat\");"]], [T.moved, T.later]],
  ["M23", "the relief makes no draw: a mood in relief shifts the random numbers of the moods after it", [[ROWS, "    const u = rand() ** bias; // the one draw of this mood, made before the memory is looked at\n", ""], [ROWS, "take(id, top[Math.floor(u * top.length)]); continue; }", "take(id, top[Math.floor(rand() ** bias * top.length)]); continue; }"]], [T.deeper, T.seeded, T.oldFriends]],
  ["M24", "the later passes repeat a film of the memory before the free films of the other moods are used", [[ROWS, "      if (at < 0) continue;", "      if (at < 0) { if (all.length) take(id, oldest(all), \"repeat\"); continue; }"]], [T.later, T.moved]],
  ["M25", "a film already in the row can be taken again (the row's own films are not left out)", [[ROWS, "const left = (id) => ranked[id].filter((c) => !taken.has(c.film.id) && ok(c));", "const left = (id) => ranked[id].filter((c) => ok(c));"]], [T.twoMoods, T.short, T.sixty]],
  ["M26", "the log entry of a later place below the forty does not say \"deeper\"", [[ROWS, 'at >= depth ? "deeper" : null, from);', "null, from);"]], [T.tenth]],
  ["M51", "the place a mood gave up is not told apart from the tenth film (no \"moved\" in the log entry)", [[ROWS, 'from ? "moved" : at >= depth', 'false ? "moved" : at >= depth']], [T.moved, T.later]],
  ["M52", "a mood that waits is owed two places (it is never taken off the list of the moods that wait)", [[ROWS, "const from = waiting.shift();", "const from = waiting[0];"]], [T.moved, T.later]],
  // the file
  ["M27", "a file that is not JSON stops the night", [[MEM, "  try { json = JSON.parse(text); } catch { return none(`${path.basename(file)} is not valid JSON`); }", "  json = JSON.parse(text);"]], [T.badFile, T.nightGoesOn]],
  ["M28", "a bad file is used silently (no line in the log)", [[MEM, "  if (mem.problem) log(", "  if (false) log("]], [T.nightGoesOn]],
  ["M29", "a film that is not an IMDb id is accepted from the file", [[MEM, "    for (const tt of films) if (typeof tt !== \"string\" || !TT.test(tt)) return none(`${date}: ${JSON.stringify(tt)} is not an IMDb id`);\n", ""]], [T.badFile]],
  ["M30", "another version of the file is accepted", [[MEM, "if (!isObject(json) || json.version !== MEMORY_VERSION)", "if (!isObject(json))"]], [T.badFile, T.nightGoesOn]],
  ["M31", "--cache-only writes the memory", [[MEM, '  if (cacheOnly) return { written: false, why: "--cache-only writes no cache" };\n', ""]], [T.whoWrites, T.inBuild]],
  ["M32", "noRepeatDays 0 still writes the file", [[MEM, '  if (!(noRepeatDays > 0)) return { written: false, why: "tonight.noRepeatDays is 0: no memory is kept" };\n', ""]], [T.whoWrites, T.inBuild, T.control]],
  ["M33", "noRepeatDays 0 still reads the file", [[MEM, "const mem = noRepeatDays > 0 ? readMemory(file) : { days: new Map(), problem: null };", "const mem = readMemory(file);"]], [T.inBuild]],
  ["M34", "a second write of the day adds to the day's entry instead of replacing it", [[MEM, "  all.set(today, [...new Set(shown)].filter(", "  all.set(today, [...new Set([...(all.get(today) || []), ...shown])].filter("]], [T.file, T.inBuild]],
  ["M35", "the write keeps nothing older than 29 days (the file is one day short; the draw itself reads the same 30 days)", [[MEM, "  const oldest = shiftDate(today, -noRepeatDays);\n  for (const date of [...all.keys()]) if (date < oldest || date > today) all.delete(date);", "  const oldest = shiftDate(today, -noRepeatDays + 1);\n  for (const date of [...all.keys()]) if (date < oldest || date > today) all.delete(date);"]], [T.file, T.sixty]],
  ["M36", "the write keeps only 28 days: the film of 30 days ago is free again", [[MEM, "  const oldest = shiftDate(today, -noRepeatDays);\n  for (const date of [...all.keys()]) if (date < oldest || date > today) all.delete(date);", "  const oldest = shiftDate(today, -noRepeatDays + 2);\n  for (const date of [...all.keys()]) if (date < oldest || date > today) all.delete(date);"]], [T.pinTop, T.sixty, T.file]],
  ["M37", "the write never drops an old or a future date", [[MEM, "  for (const date of [...all.keys()]) if (date < oldest || date > today) all.delete(date);\n", ""]], [T.file, T.inBuild]],
  ["M38", "the write is not atomic (straight into the file)", [[MEM, "  fs.writeFileSync(tmp, memoryText(days, today, shown, noRepeatDays));\n  fs.renameSync(tmp, file);", "  fs.writeFileSync(file, memoryText(days, today, shown, noRepeatDays));"]], [T.file]],
  ["M39", "a film is written twice in a day's entry, and what is not an id is written", [[MEM, "  all.set(today, [...new Set(shown)].filter((tt) => typeof tt === \"string\" && TT.test(tt)));", "  all.set(today, [...shown]);"]], [T.file]],
  ["M40", "what is recorded is every row of the Board, not Tonight", [[MEM, 'if (row.id === "tonight") for (const it of row.items || [])', 'if (row.id !== "my-series") for (const it of row.items || [])']], [T.published, T.inBuild]],
  ["M41", "what is recorded is the legacy Board's Tonight alone", [[MEM, "for (const board of [plan.board2, plan.board])", "for (const board of [plan.board])"]], [T.published]],
  ["M42", "the films of the memory are remembered by their FIRST day, not their last", [[MEM, "for (const tt of days.get(date)) shown.set(tt, date);", "for (const tt of days.get(date)) if (!shown.has(tt)) shown.set(tt, date);"]], [T.window]],
  ["M50", "a day's entry may hold 5,000 films instead of 500", [[MEM, "const MAX_FILMS = 500;", "const MAX_FILMS = 5000;"]], [T.badFile]],
  // build.js and the nightly
  ["M43", "build.js does not hand the memory to the draw", [[BUILD, " tonightShown: tonightStep.shown, exempt:", " exempt:"]], [T.wiring, T.plantedBuild]],
  ["M44", "build.js never writes the memory", [[BUILD, "  tonightStep.remember(plan, process.env, CACHE_ONLY); //", "  //"]], [T.wiring, T.plantedBuild]],
  ["M45", "build.js writes the memory in a --cache-only build", [[BUILD, "tonightStep.remember(plan, process.env, CACHE_ONLY);", "tonightStep.remember(plan, process.env, false);"]], [T.wiring, T.plantedBuild]],
  ["M46", "build.js reads the memory with a window of its own (30, whatever the config)", [[BUILD, "runInBuild({ noRepeatDays: TONIGHT.noRepeatDays, today, cacheDir: CACHE_DIR, log, person: tonightPerson });", "runInBuild({ noRepeatDays: 30, today, cacheDir: CACHE_DIR, log, person: tonightPerson });"]], [T.wiring]],
  ["M47", "the nightly does not save the file (CACHES of scripts/noturna-mac.sh)", [[SH, " front-memory.json tonight-memory.json directors.json\"", " front-memory.json directors.json\""]], [T.nightly]],
  ["M48", "the boundary check refuses the file", [[BOUNDARY, "'front-memory.json','tonight-memory.json','directors.json'", "'front-memory.json','directors.json'"]], [T.nightly]],
  ["M49", "the workflow does not git add the file", [[YML, "          git add cache/tonight-memory.json || true\n", ""]], [T.nightly]],
  ["M54", "scripts/noturna-mac.sh sets the switch in the scheduled night alone (--manual does not record what it publishes); the executed proof is M126 of test-support/noturna-mutacoes.js", [[SH, 'if [ "$MODO" = agendada ] || [ "$MODO" = manual ]; then TM=1; fi', 'if [ "$MODO" = agendada ]; then TM=1; fi']], [T.nightly]],
  ["M55", "the offline build line of scripts/noturna-mac.sh does not hand the switch over", [[SH, ' TONIGHT_MEMORY_WRITE="$TM"\n      sem_credencial\n      com_limite "$NOTURNA_LIMITE_BUILD_S" "$NOTURNA_NODE" build.js --offline', '\n      sem_credencial\n      com_limite "$NOTURNA_LIMITE_BUILD_S" "$NOTURNA_NODE" build.js --offline']], [T.nightly]],
  ["M56", "the workflow writes the memory on every run, \"Run workflow\" included (which publishes nothing today)", [[YML, "          TONIGHT_MEMORY_WRITE: ${{ github.event_name == 'schedule' && '1' || '' }}", "          TONIGHT_MEMORY_WRITE: '1'"]], [T.nightly]],
  ["M57", "a person's build (Will) is back on the Tonight of before: the top 12 and no memory (the state until Marco's answer of 15/11/2026)", [["lib/people.js", "  cfg.tonight = pick(base.tonight || {}, ['bias', 'depth', 'noRepeatDays']);", "  cfg.tonight = { depth: 12, noRepeatDays: 0 };"]], [T.person]],
  ["M63", "a person's pending row is counted before its build is published", [[MEM, "    if (published.has(p.revision)) { out.set(p.date, p.films.slice()); confirmed.push(p); } else left.push(p);", "    out.set(p.date, p.films.slice()); confirmed.push(p);"]], [T.personMemory, T.personStrict]],
  ["M64", "a person's build writes its row straight into the days, as Marco's does (counted the next day, published or not)", [[MEM, "      const w = own\n", "      const w = false\n"]], [T.personMemory]],
  ["M65", "the rows of a person's published builds are never counted", [[MEM, "  const days = own ? own.days : mem.days;", "  const days = mem.days;"]], [T.personMemory]],
  ["M66", "a person's memory file is readable by everybody", [[MEM, "  fs.chmodSync(tmp, 0o600);\n", ""], [MEM, "{ mode: 0o600 });", "{ mode: 0o644 });"]], [T.personMemory]],
  ["M67", "build.js gives a person's build no revision and no list of publications (its file is written like Marco's)", [[BUILD, "const tonightPerson = cfg.personContext ? {", "const tonightPerson = false ? {"]], [T.wiring]],
  ["M68", "a malformed revision counts as a publication", [[MEM, ".filter((s) => REVISION.test(s)));", ");"]], [T.personStrict]],
  ["M69", "the pending rows of a person's file never leave it (not cut to the window)", [[MEM, "].filter((p) => inWindow(p.date)).sort(", "].sort("]], [T.personMemory]],
  ["M70", "the person's folder is not checked against a symbolic link at cache/tonight-memory.json (a link to Marco's memory is followed)", [["lib/people.js", "'cache/front-memory.json','cache/tonight-memory.json','cache/posters-raw'", "'cache/front-memory.json','cache/posters-raw'"]], [T.personLink]],
  // Marco, 15/11/2026: "Keep the pins, except Paterson": a film in exclude.films cannot be in a mood's pins
  ["M58", "config.json pins Paterson to lift again, though it is in exclude.films", [[CFG, '      "pins": [\n        "tt0117615",\n        "tt0092048",', '      "pins": [\n        "tt5247022",\n        "tt0117615",\n        "tt0092048",']], [T.pinsConfig]],
  ["M59", "the check lets a film be pinned and excluded at once", [["lib/exclude.js", "  if (both.length) throw new Error(", "  if (false) throw new Error("]], [T.pinsConfig, T.pinsBuild]],
  ["M60", "build.js does not run the check (a film pinned and excluded is dropped without a word, as before 15/11/2026)", [[BUILD, "EX0.assertNotPinned(EX0.parse(cfg.exclude), cfg.moods);", "EX0.parse(cfg.exclude);"]], [T.pinsBuild]],
  ["M61", "the check reads the first mood of a film alone (the message names one mood where the film is pinned to two)", [["lib/exclude.js", "(out.get(id) || out.set(id, []).get(id)).push(m.id);", "if (!out.has(id)) out.set(id, [m.id]);"]], [T.pinsConfig, T.pinsBuild]],
  ["M62", "one of Marco's pins is lost with Paterson's (Local Hero leaves reinvent)", [[CFG, '      "pins": [\n        "tt0117615",\n        "tt0085859"\n      ],', '      "pins": [\n        "tt0117615"\n      ],']], [T.pinsConfig]],
  // the ones we expect NO test of the copy to see (written down, not hidden)
  ["S1", "build.js does not warn when a film is shown again inside 30 days", [[BUILD, "    if (repeat.length) log(", "    if (false) log("]], [], "the line is log only; no test builds a world where the real build must repeat a film"],
  ["S4", "build.js does not warn when a mood has no film tonight because its every film was shown (the place moved to another mood)", [[BUILD, "    if (moved.length) log(", "    if (false) log("]], [], "the line is log only, like S1; lib/rows.js reports the moved place in tonightRelief, which the tests do read"],
  ["S5", "with FEWER places than moods, a mood that waits holds its place in the first pass (the next mood does not draw in its stead)", [[ROWS, "    if (tonight.length >= size) break;\n    const all = left(id);\n    if (!all.length) continue;", "    if (tonight.length + waiting.length >= size) break;\n    const all = left(id);\n    if (!all.length) continue;"]], [], "the other behaviour for a row with fewer places than moods, which nothing promises and no test fixes (second pass of the review, N1): with it Old friends would keep its order there too; production has 10 places and 9 moods, where the two are the same"],
  ["S2", "build.js does not print the line \"Tonight: 10 of 10 films, drawn from the top 40 …\"", [[BUILD, "    log(`     Tonight: ${rows.tonight.length} of ${cfg.sizes.tonight} films", "    void (`     Tonight: ${rows.tonight.length} of ${cfg.sizes.tonight} films"]], [T.plantedBuild], "seen only by the executed build of test/tonight-exclude.test.js, which needs the caches and is skipped in the copy", true],
  ["S3", "the memory of Tonight is written after the front memory instead of before it", [[BUILD, "  tonightStep.remember(plan, process.env, CACHE_ONLY); // the memory of Tonight (14/11/2026)", "  // the memory of Tonight (14/11/2026)"], [BUILD, "  if (frontStep) frontStep.remember(process.env, CACHE_ONLY);", "  if (frontStep) frontStep.remember(process.env, CACHE_ONLY); tonightStep.remember(plan, process.env, CACHE_ONLY);"]], [], "the two writes are independent files: their order is not a rule"],
];

function copyTree(work) {
  for (const rel of COPIED) fs.cpSync(path.join(ROOT, rel), path.join(work, rel), { recursive: true });
  fs.mkdirSync(path.join(work, "test"));
  for (const t of TESTS) fs.copyFileSync(path.join(ROOT, t), path.join(work, t));
  for (const rel of fs.readdirSync(ROOT)) if (!NOT_LINKED.has(rel)) fs.symlinkSync(path.join(ROOT, rel), path.join(work, rel));
}

/** Runs the three test files of the copy. → { red: [test names], files: [test files that failed], status } */
function runTests(work) {
  const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap", ...(TESTE ? [`--test-name-pattern=${TESTE}`] : []), ...TESTS], { cwd: work, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, FRONT_MEMORY_WRITE: "", TONIGHT_MEMORY_WRITE: "" } });
  const names = [...(r.stdout || "").matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1].replace(/ # .*$/, ""));
  return { red: names.filter((n) => !/\.test\.js$/.test(n)), files: names.filter((n) => /\.test\.js$/.test(n)), status: r.status, out: r.stdout + r.stderr };
}

function main() {
  const only = process.argv.includes("--so") ? new Set(process.argv[process.argv.indexOf("--so") + 1].split(",")) : null;
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tonight-mutacoes-")));
  let failed = 0;
  try {
    copyTree(work);
    const base = runTests(work);
    if (base.status !== 0 || base.red.length || base.files.length) { console.log(`bateria original: VERMELHA (${[...base.red, ...base.files].join(" | ")})\n${base.out.slice(-3000)}`); process.exitCode = 2; return; }
    const count = (base.out.match(/^# pass (\d+)/m) || [])[1], skipped = (base.out.match(/^# skipped (\d+)/m) || [])[1];
    console.log(`bateria original: verde (${count} testes passam, ${skipped} pulados${COM_CACHE ? "" : " por falta de cache na cópia"}${TESTE ? `; só os testes que casam com /${TESTE}/` : ""})`);
    const tally = { morta: 0, outro: 0, sobreviveu: 0, esperadaSobrevive: 0 };
    for (const [id, what, edits, tests, survivesAlways, onlyWithoutCache] of MUTACOES) {
      if (only && !only.has(id)) continue;
      const survives = onlyWithoutCache && COM_CACHE ? null : survivesAlways;
      const originals = new Map();
      let verdict;
      try {
        for (const [rel, from, to] of edits) {
          const file = path.join(work, rel), text = fs.readFileSync(file, "utf8");
          if (!originals.has(file)) originals.set(file, text);
          if (text.split(from).length !== 2) { verdict = `MUTAÇÃO NÃO APLICÁVEL (${text.split(from).length - 1} ocorrências em ${rel})`; break; }
          fs.writeFileSync(file, text.replace(from, () => to));
        }
        if (!verdict) for (const file of originals.keys()) if (file.endsWith(".js") && spawnSync(process.execPath, ["--check", file]).status !== 0) verdict = `ERRO DE EXECUÇÃO (${path.relative(work, file)} não carrega)`;
        if (!verdict) {
          const r = runTests(work), hit = r.red.filter((n) => tests.some((t) => new RegExp(t).test(n)));
          if (r.files.length && !r.red.length) verdict = `ERRO DE EXECUÇÃO (arquivo de teste não rodou: ${r.files.join(", ")})`;
          else if (hit.length) { verdict = `MORTA por ${r.red.length} teste(s): ${r.red.map((n) => n.slice(0, 70)).join(" | ")}`; tally.morta++; if (survives) { verdict += "  ← ESPERAVA-SE QUE SOBREVIVESSE"; failed++; } }
          else if (r.red.length) { verdict = `MORTA POR OUTRO TESTE: ${r.red.map((n) => n.slice(0, 70)).join(" | ")}`; tally.outro++; failed++; }
          else if (survives) { verdict = `SOBREVIVEU (esperado: ${survives})`; tally.esperadaSobrevive++; }
          else { verdict = "SOBREVIVEU  ← FALTA TESTE"; tally.sobreviveu++; failed++; }
        }
        if (/NÃO APLICÁVEL|ERRO DE EXECUÇÃO/.test(verdict)) failed++;
      } finally { for (const [file, text] of originals) fs.writeFileSync(file, text); }
      console.log(`${id}  ${what}\n      ${verdict}`);
    }
    console.log(`\nmortas pelo teste nomeado: ${tally.morta} · mortas só por outro teste: ${tally.outro} · sobreviveram sem aviso: ${tally.sobreviveu} · sobreviveram como esperado: ${tally.esperadaSobrevive}`);
    if (failed) process.exitCode = 1;
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
main();
