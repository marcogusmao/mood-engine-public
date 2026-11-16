#!/usr/bin/env node
"use strict";
// Receipts of mutation for the TSPDT work (22/10/2026): lists[].top (lib/lists.js, lib/list-signal.js), the four TSPDT lists of config.json and the directors' lists
// (lib/tspdt-directors.js, scripts/tspdt-directors.js). Plants one defect at a time in a COPY of the code and requires the named tests to turn red.
// Lives in test-support/ and not in test/ because everything in test/ runs as a test.
//
//   node test-support/tspdt-mutations.js [--so T1,D3]     (--so: only these ids)
//
// How: the original suite first (it must be green, else nothing is measured). For each mutation a temporary root is built (lib/, scripts/, config.json, data/ and the three
// test files are COPIES; every other top-level entry is a symlink to the repository), the edit is applied to the copy and must find EXACTLY ONE occurrence of the text
// ("NOT APPLICABLE" otherwise: the instrument is blind, not the test), and `node --test` runs the three test files there. Killed = at least one test is red.
// The working tree is never touched. A survivor is a test that is missing: write it, or write why in BACKLOG.md and in the commit; never delete the mutation.
// Run with Node 22 at low priority (the project's rule): taskpolicy -b nice -n 19 <node22> test-support/tspdt-mutations.js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const TESTS = ["test/list-top.test.js", "test/tspdt-lists.test.js", "test/tspdt-directors.test.js"];
const COPIED = ["lib", "scripts", "config.json", "data", "test"];

// id, file, text to find (exactly once), replacement, what it is
const M = [
  // lists[].top: the reading
  ["T1", "lib/lists.js", "maxPages: l.popular ? 1 : 60, stopWhen, onPage", "maxPages: l.popular ? 1 : 60, onPage", "the reading does not stop at the page that holds the Nth film (ten pages for 250)"],
  ["T2", "lib/lists.js", "return got.size >= top; }", "return got.size > top; }", "the stop needs one film more than the cut (a cut on a page boundary reads a page too many)"],
  ["T3", "lib/lists.js", "const cutTop = (rows, top) => (top ? rows.slice(0, top) : rows);", "const cutTop = (rows, top) => rows;", "the cut drops nothing"],
  ["T4", "lib/lists.js", "const cutTop = (rows, top) => (top ? rows.slice(0, top) : rows);", "const cutTop = (rows, top) => (top ? rows.slice(0, top - 1) : rows);", "the cut keeps N-1"],
  ["T5", "lib/lists.js", "(c.top ?? null) !== top || ", "", "a changed cut does not read the list again before the 7 days"],
  ["T6", "lib/lists.js", "...(top ? { top } : {}), items:", "items:", "the cache does not remember the cut it was read with (every run reads again)"],
  ["T7", "lib/lists.js", "cutTop((k && k.items) || [], top).map(", "((k && k.items) || []).map(", "the cut is not applied on the way out (--cache-only over a cache written before the cut)"],
  ["T8", "lib/lists.js", "(k && k.total && top ? Math.min(k.total, top) : k && k.total) || null", "(k && k.total) || null", "total stays the list's 1,000 (build.js reads items < total as a partial read)"],
  ["T9", "lib/lists.js", "const want = top && meta.total ? Math.min(top, meta.total) : meta.total;", "const want = meta.total;", "a healthy cut alarms 'read 250 of 1000 films'"],
  ["T10", "lib/lists.js", "items: cutTop(r.partial ? F.mergeRows(rows, c && c.items) : rows, top) }", "items: r.partial ? F.mergeRows(rows, c && c.items) : rows }", "a partial read stores the new rows plus every older row (450 for a cut of 250)"],
  // lists[].top: the config check
  ["V1", "lib/list-signal.js", "if (!Number.isInteger(l.top) || l.top < 1) problems.push", "if (false) problems.push", "top 0, 2.5 or '250' is accepted"],
  ["V2", "lib/list-signal.js", "else if (l.source === \"static\") problems.push(`${at}: top cuts", "else if (false) problems.push(`${at}: top cuts", "a cut on a static list is accepted"],
  ["V3", "lib/list-signal.js", "else if (l.popular) problems.push(`${at}: top does not apply", "else if (false) problems.push(`${at}: top does not apply", "a cut on Popular this week is accepted"],
  ["V4", "lib/lists.js", "Number.isInteger(l.top) && l.top > 0 ? l.top : null", "Number(l.top) > 0 ? l.top : null", "topOf takes 2.5 and '250'"],
  // the four lists of config.json
  ["C1", "config.json", "\"url\": \"https://letterboxd.com/tspdtfanaccount/list/the-2026-tspdt-poll-your-favourite-films/\",\n      \"trust\": \"fan\",\n      \"top\": 250,", "\"url\": \"https://letterboxd.com/tspdtfanaccount/list/the-2026-tspdt-poll-your-favourite-films/\",\n      \"trust\": \"fan\",\n      \"top\": 300,", "the 2026 poll cut at 300"],
  ["C2", "config.json", "\"url\": \"https://letterboxd.com/tspdtfanaccount/list/the-2026-tspdt-poll-your-favourite-films/\",\n      \"trust\": \"fan\",", "\"url\": \"https://letterboxd.com/tspdtfanaccount/list/the-2026-tspdt-poll-your-favourite-films/\",\n      \"trust\": \"critic\",", "the 2026 poll vouches like a critics' list"],
  ["C3", "config.json", "\"name\": \"TSPDT · 21st Century top 250\"", "\"name\": \"TSPDT · The 21st Century's Most Acclaimed top 250\"", "a menu name over 28 characters"],
  ["C4", "config.json", "\"short\": \"TSPDT · 2021 Poll top 250\"", "\"short\": \"TSPDT 2021 Poll\"", "a short name different from the name"],
  // the directors' pages
  ["D1", "lib/tspdt-directors.js", "(\\d+) (?:other )?films? cited", "(\\d+) other films? cited", "'0 films in the 1,000 Greatest / 16 films cited' (no 'other') is refused"],
  ["D2", "lib/tspdt-directors.js", "Top 1,?000", "Top 1,000", "the 21st Century page says 'Top 1000' without a comma"],
  ["D3", "lib/tspdt-directors.js", "if (r.pos !== i + 1) throw", "if (false) throw", "a gap or a repeat in the positions is accepted"],
  ["D4", "lib/tspdt-directors.js", "prev: prev.trim() === \"-\" ? null : Number(prev)", "prev: Number(prev)", "'(-)' becomes NaN, not null"],
  ["D5", "lib/tspdt-directors.js", "name: decode(title),", "name: decode(label),", "the name is the link text ('Name (1)') and not the title attribute"],
  ["D6", "lib/tspdt-directors.js", "const key = norm(name);\n  if (Object.hasOwn(aliases, key))", "const key = name;\n  if (Object.hasOwn(aliases, key))", "names are not folded: 'ALFRED HITCHCOCK' misses"],
  ["D7", "lib/tspdt-directors.js", "if (ranked[0][1] === ranked[1][1]) return", "if (false) return", "two homonyms with as many films each: the first wins"],
  ["D8", "lib/tspdt-directors.js", "b[1] - a[1] || a[0] - b[0]", "a[1] - b[1] || a[0] - b[0]", "the homonym with FEWEST films in the index wins"],
  ["D9", "lib/tspdt-directors.js", "if (v.imdb && inIndex.has(v.imdb)) p.films.add(v.imdb);", "if (v.imdb) p.films.add(v.imdb);", "a film the index does not hold is counted"],
  ["D10", "lib/tspdt-directors.js", "tmdb: ms.length === 1 ? ms[0].tmdb : null,", "tmdb: ms[0].tmdb,", "a team carries its first member's id"],
  ["D11", "lib/tspdt-directors.js", "filmsInIndex: films.size", "filmsInIndex: ms.reduce((n, m) => n + (dirs.people.get(m.tmdb)?.films.size || 0), 0)", "a film of the team counts once per member"],
  ["D12", "lib/tspdt-directors.js", "  charleschaplin: 13848,", "  charleschaplinX: 13848,", "the alias for 'Charles Chaplin' (TMDB: Charlie) is gone"],
  ["D13", "lib/tspdt-directors.js", "if (out.length && /\\S/.test(line) && /Introduction|1,000 Noir Films/.test(line)) break;", "if (false) break;", "the Noir list reads on into the footer"],
  ["D14", "scripts/tspdt-directors.js", "parsed.length !== p.count", "false", "a half-read page (6 entries for 250) is written"],
  ["D15", "lib/tspdt-directors.js", "if (!films || !other) throw", "if (false) throw", "a line without its counts is accepted"],
];

function root(mut) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tspdt-mut-"));
  for (const name of fs.readdirSync(ROOT)) {
    if (name === ".git") continue;
    const from = path.join(ROOT, name), to = path.join(dir, name);
    if (!COPIED.includes(name)) { fs.symlinkSync(from, to); continue; }
    if (name === "config.json") { fs.copyFileSync(from, to); continue; }
    if (name === "test") { // only the three test files are copies; fixtures are read through a link
      fs.mkdirSync(to);
      for (const t of TESTS) fs.copyFileSync(path.join(ROOT, t), path.join(dir, t));
      fs.symlinkSync(path.join(ROOT, "test", "fixtures"), path.join(to, "fixtures"));
      continue;
    }
    fs.cpSync(from, to, { recursive: true });
  }
  if (mut) {
    const [id, file, find, repl] = mut;
    const f = path.join(dir, file);
    const text = fs.readFileSync(f, "utf8");
    const n = text.split(find).length - 1;
    if (n !== 1) { fs.rmSync(dir, { recursive: true, force: true }); return { dir: null, why: `NOT APPLICABLE: ${n} occurrences of the text in ${file}` }; }
    fs.writeFileSync(f, text.replace(find, () => repl));
  }
  return { dir };
}

function run(dir) {
  const r = spawnSync(process.execPath, ["--test", "--test-concurrency=3", ...TESTS], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = r.stdout + r.stderr;
  const num = (k) => Number((out.match(new RegExp(`^# ${k} (\\d+)`, "m")) || [])[1] ?? NaN);
  const red = [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
  return { tests: num("tests"), pass: num("pass"), fail: num("fail"), red, out };
}

function main() {
  const only = (process.argv.includes("--so") ? process.argv[process.argv.indexOf("--so") + 1] : "").split(",").filter(Boolean);
  const base = root(null);
  const b = run(base.dir);
  fs.rmSync(base.dir, { recursive: true, force: true });
  console.log(`original: ${b.pass} of ${b.tests} green, ${b.fail} red`);
  if (b.fail !== 0 || !(b.tests > 0)) { console.log(b.out.slice(-3000)); console.error("the original must be green: nothing was measured"); process.exit(2); }
  let killed = 0, survived = [], na = [];
  for (const m of M.filter((x) => !only.length || only.includes(x[0]))) {
    const { dir, why } = root(m);
    if (!dir) { na.push(m[0]); console.log(`${m[0]}  ${why}  (${m[4]})`); continue; }
    const r = run(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    if (r.fail > 0) { killed++; console.log(`${m[0]}  KILLED by ${r.red.length} test(s): ${r.red.slice(0, 2).map((x) => x.slice(0, 60)).join(" | ")}  (${m[4]})`); }
    else { survived.push(m[0]); console.log(`${m[0]}  SURVIVED  (${m[4]})`); }
  }
  console.log(`\n${killed} killed, ${survived.length} survived${survived.length ? ` (${survived.join(", ")})` : ""}, ${na.length} not applicable${na.length ? ` (${na.join(", ")})` : ""}, of ${killed + survived.length + na.length}`);
  process.exit(survived.length || na.length ? 1 : 0);
}
main();
