#!/usr/bin/env node
"use strict";
// Reads the directors' lists of They Shoot Pictures, Don't They? and writes data/tspdt-directors.json (Marco, 22/10/2026 ~06:45 UTC: "tem os diretores tb, veja tudo
// que do tspdt"). Nothing is built from the file yet: no catalog and no row read it (BACKLOG.md, 22/10/2026: the question for Marco).
//
//   node scripts/tspdt-directors.js [--out data/tspdt-directors.json] [--pages-dir DIR] [--index FILE|URL] [--tmdb cache/tmdb.json] [--read-on YYYY-MM-DD]
//     --pages-dir  read gf1000_top250directors.htm, 21stcentury_top100directors.htm and 50keynoirdirectors.htm from DIR instead of the site (tests, a second run)
//     --index      the published index (default: https://marcogusmao.github.io/mood-engine/data/index.json): it says which films the index holds
//     --any-count  do not require 250 / 100 / 50 directors per page (the tests read pages of a few entries; a real read never uses it)
//     --tmdb       the TMDB cache that names each film's directors (cache/tmdb.json, movie[id].v.directors)
// Asks the site three pages, one second apart (public pages, no login); the index is the published file. No key, no account.
// The file says which index (builtAt, count, first 12 digits of the sha256) and which TMDB cache (first 12 digits of the sha256) the counts of films were taken from: they change every night.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const T = require("../lib/tspdt-directors");

const ROOT = path.resolve(__dirname, "..");
const SITE = "https://theyshootpictures.com/";
const INDEX_URL = "https://marcogusmao.github.io/mood-engine/data/index.json";
const UA = "Mozilla/5.0 (compatible; mood-engine/1.0; personal Stremio addon; reads public pages)";
const MAX_BYTES = 12e6;
const PAGES = [
  { id: "top250", count: 250, file: "gf1000_top250directors.htm", title: "The Top 250 Directors (2026 Edition)", parse: T.parseRanked, listOf: "the 1,000 Greatest Films" },
  { id: "c21top100", count: 100, file: "21stcentury_top100directors.htm", title: "The 21st Century's Top 100 Directors (2026 Edition)", parse: T.parseRanked, listOf: "the 21st Century's 1,000 Most Acclaimed Films" },
  { id: "noir50", count: 50, file: "50keynoirdirectors.htm", title: "50 Key Noir Directors", parse: T.parseNoir, listOf: null },
];

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const prefix = (buf) => sha256(buf).slice(0, 12); // the first 12 hex digits name a cache state, as in the docs; a whole digest in a data file is what the secret scan reads as a key
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, what) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(90e3) });
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`${what}: ${buf.length} bytes, over the ${MAX_BYTES} cap`);
  return buf;
}

/** The published index → { meta, tts: [imdb ids], listOf(listId) → Set of imdb ids }, and the bytes' sha256. */
function readIndex(buf) {
  const ix = JSON.parse(buf.toString("utf8"));
  const col = (n) => ix.cols.indexOf(n);
  const tt = col("tt"), lists = col("lists");
  if (tt < 0 || lists < 0 || !Array.isArray(ix.films)) throw new Error("index: no tt/lists columns");
  const inList = new Map();
  for (const f of ix.films) for (const part of String(f[lists] || "").split(",")) { const id = part.split(":")[0]; if (id) (inList.get(id) || inList.set(id, new Set()).get(id)).add(f[tt]); }
  return { meta: ix.meta, tts: ix.films.map((f) => f[tt]), inList, sha256First12: prefix(buf) };
}

/** How many of the claimed "films in the 1,000 Greatest" the index confirms for the matched person: the control that a homonym was not taken. */
function gfCheck(entries, dirs, gf) {
  let agree = 0, checked = 0;
  const off = [];
  for (const e of entries) {
    if (e.tmdb == null || !gf) continue;
    const mine = [...(dirs.people.get(e.tmdb)?.films || [])].filter((tt) => gf.has(tt)).length;
    checked++;
    if (mine === e.films) agree++; else off.push(`${e.pos}. ${e.name}: TSPDT ${e.films}, index ${mine}`);
  }
  return { checked, agree, off };
}

async function main(argv) {
  const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const out = path.resolve(ROOT, arg("--out", "data/tspdt-directors.json"));
  const pagesDir = arg("--pages-dir", null);
  const tmdbFile = path.resolve(ROOT, arg("--tmdb", "cache/tmdb.json"));
  const readOn = arg("--read-on", new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(readOn)) throw new Error("--read-on must be YYYY-MM-DD");
  const idx = arg("--index", INDEX_URL);

  const indexBuf = /^https?:/.test(idx) ? await get(idx, "index") : fs.readFileSync(idx);
  const index = readIndex(indexBuf);
  const tmdbBuf = fs.readFileSync(tmdbFile);
  const dirs = T.directorsOf(JSON.parse(tmdbBuf.toString("utf8")).movie, index.tts);

  const lists = {};
  for (const p of PAGES) {
    let html;
    if (pagesDir) html = fs.readFileSync(path.join(pagesDir, p.file), "utf8");
    else { html = (await get(SITE + p.file, p.file)).toString("utf8"); await sleep(1000); }
    const parsed = p.parse(html);
    if (!argv.includes("--any-count") && parsed.length !== p.count) throw new Error(`${p.id}: ${parsed.length} directors, the page publishes ${p.count} (a half-read page, or the site changed)`);
    const entries = T.attach(parsed, dirs);
    const unmatched = entries.flatMap((e) => e.members.filter((m) => m.tmdb == null).map((m) => `${e.pos}. ${m.name}${m.ambiguous ? " (homonyms, undecided)" : ""}`));
    const ambiguous = entries.flatMap((e) => e.members.filter((m) => m.ambiguous && m.tmdb != null).map((m) => `${e.pos}. ${m.name}`));
    lists[p.id] = { title: p.title, url: SITE + p.file, count: entries.length, directors: entries.map((e) => ({ ...e, ...(e.members.some((m) => m.ambiguous) ? { ambiguous: true } : {}) })) };
    const chk = p.id === "top250" ? gfCheck(entries, dirs, index.inList.get("R7jhM")) : null;
    console.log(`${p.id}: ${entries.length} directors · ${entries.filter((e) => e.members.every((m) => m.tmdb != null)).length} with every TMDB id · ${unmatched.length} names without one · ${ambiguous.length} decided among homonyms · ${entries.filter((e) => e.filmsInIndex > 0).length} with films in the index`);
    if (unmatched.length) console.log(`   without an id: ${unmatched.join("; ")}`);
    if (ambiguous.length) console.log(`   homonyms decided by films in the index: ${ambiguous.join("; ")}`);
    if (chk) console.log(`   control (films in the 1,000 Greatest, TSPDT's count against the index's list R7jhM): ${chk.agree} of ${chk.checked} agree${chk.off.length ? `; off: ${chk.off.slice(0, 40).join("; ")}${chk.off.length > 40 ? ` (+${chk.off.length - 40})` : ""}` : ""}`);
  }

  const doc = {
    source: { site: "They Shoot Pictures, Don't They? (theyshootpictures.com)", edition: "2026", readOn, note: "Listas de diretores do site, na ordem dele; cada diretor casado com o id TMDB por nome (cache/tmdb.json: crew de direção); null = sem casamento. Equipes ('A & B') têm um id por membro em `members` e `tmdb: null`." },
    index: { builtAt: index.meta.builtAt, count: index.meta.count, sha256First12: index.sha256First12 },
    tmdbCacheSha256First12: prefix(tmdbBuf),
    lists,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, format(doc));
  console.log(`wrote ${path.relative(ROOT, out)}`);
}

/** One director per line, so a diff of two reads shows the directors that moved. */
function format(doc) {
  const j = JSON.stringify;
  const lists = Object.entries(doc.lists).map(([id, l]) => `${j(id)}: {\n"title": ${j(l.title)},\n"url": ${j(l.url)},\n"count": ${l.count},\n"directors": [\n${l.directors.map((d) => j(d)).join(",\n")}\n]\n}`);
  return `{\n"source": ${j(doc.source)},\n"index": ${j(doc.index)},\n"tmdbCacheSha256First12": ${j(doc.tmdbCacheSha256First12)},\n"lists": {\n${lists.join(",\n")}\n}\n}\n`;
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error("✖ " + e.message); process.exit(1); });
module.exports = { readIndex, gfCheck, format, PAGES };
