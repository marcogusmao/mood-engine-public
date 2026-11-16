#!/usr/bin/env node
// node verify.js [dir]      (default: ./docs)
//
// Compares what the manifest PROMISES with the files that were written, so Stremio never asks for a file that is not there:
//   - every catalog without extras has catalog/movie/<id>.json
//   - every catalog with a `genre` extra has exactly that extra, required, no `skip`, unique options, and one
//     catalog/movie/<id>/genre=<option>.json per option (plus its percent-encoded twin when the name has such characters)
//   - every file parses, holds `metas`, every meta id is an IMDb id (tt…), none twice, no more than 300 per file
//   - every meta's poster is a valid http(s) address; one that points at /posters/<tt>.jpg (a cover with the ratings drawn on it) must be
//     the film's own tt and exist as <dir>/posters/<tt>.jpg, not empty; imdbRating, when present, looks like "7.3"
//   - no file sits in catalog/movie that the manifest does not declare
//   - data/index.json and its pieces: index-board.json, index-moods.json, index-friends.json, index-directors.json, index-list-<id>.json (what the live Worker reads; verifyIndex below)
//   - the v2 family, when data/index-v2.json exists (lib/board.js, lib/index-export.js): index-v2.json whole, index-v2-menus.json (no films), one index-v2-row-<id>.json per
//     row that is not a series row, one index-v2-mood-<id>.json per mood of the Moods menu; each slice holds exactly its films, and no v2 file sits there that the index does not account for
//   - data/film-languages.json: the original language of each film (Portuguese / another / not known), cut out of index.json for the Worker's /subtitles
// Exit code 0 only when nothing is wrong.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const { ROW_ID } = require("./lib/board-shared");
const MAX_ITEMS = 300;
const MAX_LANGUAGES_BYTES = 400e3; // the Worker downloads this on a cold isolate for each subtitles request: 87 KB for 11,148 films on 12/10/2026
const MAX_INDEX_GZIP = 4e6; // the Worker downloads this on a cold start: over 4 MB gzipped is a build that grew by accident
const validUrl = (u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };
/**
 * The `?v=` of a cover address (lib/posters.js, 19/10/2026) is the first 8 characters of the sha256 of the JPEG the address points at: a TV keeps an image by its address, so an address that
 * says v=abc12345 for a file that is another drawing would keep showing the old one. → null when the address has no `?v=` or it is the file's own, else a sentence. `seen` memoizes the hash per file.
 */
function coverVersionProblem(dir, poster, seen) {
  const m = String(poster).match(/\/posters\/([^/?#]+)\.jpg\?v=([0-9a-f]{8})$/);
  if (!m) return null;
  const f = path.join(dir, "posters", `${m[1]}.jpg`);
  if (!fs.existsSync(f)) return null; // the missing file is its own problem, reported where the address is read
  if (!seen.has(m[1])) seen.set(m[1], require("crypto").createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 8));
  return seen.get(m[1]) === m[2] ? null : `${m[1]}: the address says v=${m[2]} but posters/${m[1]}.jpg is the drawing ${seen.get(m[1])}`;
}

function verifyDir(dir) {
  const problems = [];
  const rows = [];
  const covers = new Set(); // the covers the files point at, and that exist
  const coverShas = new Map(); // tt -> first 8 characters of the sha256 of its JPEG, read once
  const bad = (m) => problems.push(m);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch (e) {
    return { ok: false, problems: [`manifest.json unreadable: ${e.message}`], rows };
  }
  const cat = path.join(dir, "catalog", "movie");
  const readMetas = (file, label) => {
    let body;
    try { body = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { bad(`${label}: ${path.relative(dir, file)} ${fs.existsSync(file) ? "does not parse" : "is missing"}`); return null; }
    if (!Array.isArray(body.metas)) { bad(`${label}: ${path.relative(dir, file)} has no metas array`); return null; }
    const ids = new Set();
    for (const m of body.metas) {
      if (!/^tt\d+$/.test(String(m.id))) bad(`${label}: "${m.name}" has id ${m.id}, not an IMDb id`);
      if (ids.has(m.id)) bad(`${label}: ${m.id} (${m.name}) appears twice`);
      ids.add(m.id);
      if (!validUrl(m.poster)) bad(`${label}: ${m.id} (${m.name}) has poster ${JSON.stringify(m.poster)}, not an http(s) address`);
      else {
        const own = String(m.poster).match(/\/posters\/([^/?#]+)\.jpg(?:\?v=[0-9a-f]{8})?$/);
        if (own) {
          if (own[1] !== m.id) bad(`${label}: ${m.id} (${m.name}) shows the cover of ${own[1]}`);
          const f = path.join(dir, "posters", `${own[1]}.jpg`);
          if (!fs.existsSync(f) || fs.statSync(f).size < 1000) bad(`${label}: ${m.id} (${m.name}) points at posters/${own[1]}.jpg, which is ${fs.existsSync(f) ? "empty" : "missing"}`);
          else {
            covers.add(own[1]);
            const vp = coverVersionProblem(dir, m.poster, coverShas);
            if (vp) bad(`${label}: ${m.id} (${m.name}) ${vp}`);
          }
        }
      }
      if (m.imdbRating != null && !/^\d{1,2}\.\d$/.test(String(m.imdbRating))) bad(`${label}: ${m.id} (${m.name}) has imdbRating ${JSON.stringify(m.imdbRating)}`);
    }
    if (body.metas.length > MAX_ITEMS) bad(`${label}: ${body.metas.length} items, more than ${MAX_ITEMS}`);
    return body.metas;
  };

  const declared = new Set(); // paths (relative to catalog/movie) the manifest accounts for
  const seenIds = new Set();
  for (const c of manifest.catalogs || []) {
    if (seenIds.has(c.id)) bad(`catalog id ${c.id} is declared twice`);
    seenIds.add(c.id);
    if (c.type !== "movie") bad(`${c.id}: type is ${c.type}, not movie`);
    if (!c.extra || !c.extra.length) {
      declared.add(`${c.id}.json`);
      const metas = readMetas(path.join(cat, `${c.id}.json`), c.id);
      rows.push({ catalog: c.id, kind: "board", option: "", items: metas ? metas.length : null, ok: !!metas });
      continue;
    }
    const extras = c.extra;
    if (extras.length !== 1 || extras[0].name !== "genre") bad(`${c.id}: must have exactly one extra, "genre" (found ${extras.map((e) => e.name).join(", ")})`);
    for (const e of extras) {
      if (e.name === "skip") bad(`${c.id}: declares skip, but the whole list is one file`);
      if (e.name === "genre" && e.isRequired !== true) bad(`${c.id}: the genre extra is not required, so the catalog would show on the Board`);
    }
    const g = extras.find((e) => e.name === "genre") || { options: [] };
    const opts = g.options || [];
    if (!opts.length) bad(`${c.id}: the genre extra has no options`);
    if (new Set(opts).size !== opts.length) bad(`${c.id}: duplicate options`);
    for (const o of opts) {
      if (/[\/\\?#%]/.test(o)) bad(`${c.id}: option "${o}" has a character that cannot be a file name`);
      const names = [...new Set([`genre=${o}.json`, `genre=${encodeURIComponent(o)}.json`])];
      for (const n of names) declared.add(`${c.id}/${n}`);
      const metas = readMetas(path.join(cat, c.id, names[0]), `${c.id}/${o}`);
      for (const twin of names.slice(1)) if (!fs.existsSync(path.join(cat, c.id, twin))) bad(`${c.id}/${o}: encoded twin ${twin} is missing`);
      rows.push({ catalog: c.id, kind: "discover", option: o, items: metas ? metas.length : null, ok: !!metas });
    }
  }

  // anything under catalog/movie the manifest does not account for
  const walk = (d, rel = "") => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]) : [];
  for (const f of walk(cat)) if (!declared.has(f)) bad(`orphan file catalog/movie/${f} is not declared in the manifest`);

  return { ok: problems.length === 0, problems, rows, version: manifest.version, catalogs: (manifest.catalogs || []).length, covers: covers.size };
}

/**
 * The index the Worker reads (lib/index-export.js). Every problem is a sentence; an empty list means the file is fit to publish:
 *   - parses, schema 1, a build time, a version; `meta.count` is the number of films
 *   - each piece (Board, moods, friends, directors, one per list) holds exactly the films of its family, identical to the same film in the whole index, with the same menus
 *   - every film has a unique IMDb id and a name; no key outside the allowed list (a personal field cannot slip in); numbers in range
 *   - every tt of every Board row, friends option, directors option and list is in the films; no film you have seen in a Board row (except Old
 *     friends), a friends option or a directors option; each directors option has one text per film
 *   - films refer only to moods and lists the index declares, and friends only to people it declares
 *   - nothing that looks like an e-mail, and none of `forbid` (your Letterboxd user name) anywhere in the text
 *   - at most 4 MB gzipped
 *   - the v2 family (data/index-v2*.json), when index-v2.json is there: the same checks over its own slices, see the top of this file
 *   - data/film-languages.json: version 1, the build time of the index, two strings of "|number|" ids, exactly what lib/index-export.js languagesFile() makes of the index
 */
function verifyIndex(dir, { forbid = [] } = {}) {
  const { ENTRY_KEYS, languagesFile, LANGUAGES_VERSION, discoverLabels, optionCut, ANIMATION_PIECE_MAX_BYTES, v2OptFile } = require("./lib/index-export");
  const { decode, encode, FORMAT } = require("./lib/index-rows");
  const problems = [];
  const bad = (m) => problems.push(m);
  const read = (rel) => {
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) { bad(`${rel} is missing`); return null; }
    const text = fs.readFileSync(file, "utf8");
    try { return { text, json: JSON.parse(text), gzip: zlib.gzipSync(text, { level: 9 }).length }; } catch (e) { bad(`${rel} does not parse: ${e.message}`); return null; }
  };
  const full = read("data/index.json");
  const stats = { films: 0, bytes: 0, gzip: 0, board: { films: 0, bytes: 0, gzip: 0 }, pieces: { files: 0, bytes: 0, gzip: 0, largest: 0 } };
  const check = (part, f, name = null) => {
    try { return require("./lib/index-validation").checkIndex(part, f.json, problems, name); }
    catch (e) { bad("Invalid index: " + e.message); return null; }
  };

  const privacy = (name, f) => {
    const email = f.text.includes("@") && f.text.match(/[\w.+-]{1,64}@[\w-]{1,63}\.[a-z]{2,63}/i);
    if (email) bad(`${name} contains something that looks like an e-mail address: ${email[0]}`);
    for (const word of forbid.filter(Boolean)) if (f.text.toLowerCase().includes(String(word).toLowerCase())) bad(`${name} contains "${word}"`);
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  const coverShas = new Map();
  let ix = null;
  if (full) {
    ix = check("full", full);
    stats.films = full.json.films?.length || 0; stats.bytes = Buffer.byteLength(full.text); stats.gzip = full.gzip;
    if (full.gzip > MAX_INDEX_GZIP) bad(`index.json is ${(full.gzip / 1e6).toFixed(2)} MB gzipped, more than ${MAX_INDEX_GZIP / 1e6} MB`);
    privacy("index.json", full);
  }
  if (ix) {
    try {
      const ids = require("./lib/learning/plan-posters").indexIds(ix);
      for (const tt of ids) {
        const f = path.join(dir,"posters",tt+".jpg");
        require("./lib/learning/paths").noAliases(f,path.resolve(dir));
        if (!fs.existsSync(f)||!fs.statSync(f).isFile()||fs.statSync(f).size<1000) throw Error("Missing local index poster: " + tt);
        require("./lib/learning/public").jpeg(fs.readFileSync(f));
      }
      for (const e of ix.films) { const vp = typeof e.poster === "string" && coverVersionProblem(dir, e.poster, coverShas); if (vp) bad(`index.json: ${vp}`); }
    } catch(e) { bad(e.message); }
    // The pieces the Worker reads for one catalog family. Each must hold EXACTLY the films its family can show: one missing would
    // silently drop results, one extra would show a film in a catalog that does not own it.
    const have = new Map(ix.films.map((e) => [e.tt, e]));
    const inRows = new Set(Object.values(ix.rows || {}).flat()), inFriends = new Set(((ix.friends && ix.friends.options) || []).flatMap((o) => o.ids));
    const dirOptions = (x) => (x.directors && x.directors.options) || [], inDirectors = new Set(dirOptions(ix).flatMap((o) => o.ids));
    const specs = [
      { part: "board", rel: "index-board.json", want: (e) => inRows.has(e.tt) },
      { part: "moods", rel: "index-moods.json", want: (e) => !!e.moods && Object.keys(e.moods).length > 0 },
      { part: "friends", rel: "index-friends.json", want: (e) => inFriends.has(e.tt) },
      { part: "directors", rel: "index-directors.json", want: (e) => inDirectors.has(e.tt) },
    ];
    for (const l of ix.lists || []) {
      if (!/^[A-Za-z0-9_-]+$/.test(String(l.id))) { bad(`index: list id "${l.id}" cannot be part of a file name`); continue; }
      specs.push({ part: `list:${l.id}`, rel: `index-list-${l.id}.json`, want: (e) => !!e.lists && l.id in e.lists });
    }
    const sizes = { files: 0, bytes: 0, gzip: 0, largest: 0 };
    for (const sp of specs) {
      const f = read(`data/${sp.rel}`);
      if (!f) continue;
      const px = check(sp.part, f);
      privacy(sp.rel, f);
      if (sp.part === "board") stats.board = { films: f.json.films.length, bytes: Buffer.byteLength(f.text), gzip: f.gzip };
      else { sizes.files++; sizes.bytes += Buffer.byteLength(f.text); sizes.gzip += f.gzip; sizes.largest = Math.max(sizes.largest, f.json.films.length); }
      if (!px) continue;
      const name = `index-${sp.part.replace(/:/g, "-")}`;
      const got = new Set(px.films.map((e) => e.tt)), wanted = ix.films.filter(sp.want);
      const missing = wanted.filter((e) => !got.has(e.tt)), extra = px.films.filter((e) => !sp.want(have.get(e.tt) || {}));
      if (missing.length) bad(`${name}: ${missing.length} film(s) it should hold are missing (${missing.slice(0, 3).map((e) => e.name).join(", ")})`);
      if (extra.length) bad(`${name}: ${extra.length} film(s) it should not hold (${extra.slice(0, 3).map((e) => e.name).join(", ")})`);
      for (const e of px.films) if (have.has(e.tt) && !same(e, have.get(e.tt))) bad(`${name}: ${e.tt} differs from the same film in index`);
      for (const k of ["moods", "lists", "rules"]) if (!same(px[k], ix[k])) bad(`${name}: ${k} differs from index`);
      if (sp.part === "board") { for (const k of ["rows", "board", "rowDesc"]) if (!same(px[k], ix[k])) bad(`${name}: ${k} differs from index`); }
      else if (px.board.length || Object.keys(px.rows).length) bad(`${name}: only the Board part carries Board rows`);
      if (!same(px.meta.countries, ix.meta.countries) || !same(px.meta.decades, ix.meta.decades)) bad(`${name}: the country or decade menu differs from index`);
      if (!same(px.friends.people, ix.friends.people) || !same(px.friends.options.map((o) => o.label), ix.friends.options.map((o) => o.label))) bad(`${name}: the friends menu differs from index`);
      if (sp.part === "friends") { if (!same(px.friends.options, ix.friends.options)) bad(`${name}: the friends options differ from index`); }
      else if (px.friends.options.some((o) => o.ids.length)) bad(`${name}: only the friends piece carries the films of the friends options`);
      if (!same(dirOptions(px).map((o) => o.label), dirOptions(ix).map((o) => o.label))) bad(`${name}: the directors menu differs from index`);
      if (sp.part === "directors") { if (!same(dirOptions(px), dirOptions(ix))) bad(`${name}: the directors options differ from index`); }
      else if (dirOptions(px).some((o) => o.ids.length || o.descs.length)) bad(`${name}: only the directors piece carries the films of the directors options`);
    }
    stats.pieces = sizes;
    // the languages file: the Worker's /subtitles reads it, so it must exist, be the shape the Worker reads, and say what the index says (a stale or hand-edited list would pick the wrong subtitle language)
    const lang = read("data/film-languages.json");
    if (lang) {
      privacy("film-languages.json", lang);
      stats.languages = { bytes: Buffer.byteLength(lang.text), gzip: lang.gzip };
      if (stats.languages.bytes > MAX_LANGUAGES_BYTES) bad(`film-languages.json is ${stats.languages.bytes} bytes, more than ${MAX_LANGUAGES_BYTES}`);
      const j = lang.json;
      const IDS = /^\|(?:\d+\|)*$/;
      if (!j || typeof j !== "object" || Array.isArray(j)) bad("film-languages.json is not an object");
      else {
        for (const k of Object.keys(j)) if (!["v", "builtAt", "pt", "known"].includes(k)) bad(`film-languages.json: unexpected key "${k}"`);
        if (j.v !== LANGUAGES_VERSION) bad(`film-languages.json: v is ${j.v}, the Worker reads ${LANGUAGES_VERSION}`);
        for (const k of ["pt", "known"]) if (typeof j[k] !== "string" || !IDS.test(j[k])) bad(`film-languages.json: ${k} must be "|number|number|" (a single bar when empty)`);
        if (typeof j.pt === "string" && typeof j.known === "string" && IDS.test(j.pt) && IDS.test(j.known)) {
          const want = languagesFile(ix);
          if (j.builtAt !== ix.meta.builtAt) bad(`film-languages.json: builtAt ${j.builtAt} is not the index's ${ix.meta.builtAt}`);
          for (const k of ["pt", "known"]) if (j[k] !== want[k]) bad(`film-languages.json: ${k} is not what the index's language column says (${j[k].split("|").length - 2} ids, expected ${want[k].split("|").length - 2})`);
        }
      }
    }
  }

  // ── the v2 family (Marco, 13/10/2026): written next to the legacy files, read by the 3.3.0 Worker only. Each slice holds EXACTLY its films. ──
  const dataFiles = fs.existsSync(path.join(dir, "data")) ? fs.readdirSync(path.join(dir, "data")).filter((n) => /^index-v2/.test(n)) : [];
  const full2 = dataFiles.includes("index-v2.json") ? read("data/index-v2.json") : null;
  if (!full2) { try { require("./lib/page-validation").verifyPages(dir, null, privacy); } catch (e) { bad(e.message); } }
  if (!full2 && dataFiles.length) bad(`data/${dataFiles[0]} is there and data/index-v2.json is not`);
  if (full2) {
    const dirOptions = (x) => (x.directors && x.directors.options) || [];
    const ix2 = check("full", full2, "index-v2");
    stats.v2 = { films: full2.json.films?.length || 0, bytes: Buffer.byteLength(full2.text), gzip: full2.gzip, rows: 0, pieces: { files: 0, bytes: 0, gzip: 0, largest: 0 }, options: { files: 0, bytes: 0, gzip: 0, largest: 0 } };
    if (full2.gzip > MAX_INDEX_GZIP) bad(`index-v2.json is ${(full2.gzip / 1e6).toFixed(2)} MB gzipped, more than ${MAX_INDEX_GZIP / 1e6} MB`);
    privacy("index-v2.json", full2);
    if (ix2) { try { stats.pages = require("./lib/page-validation").verifyPages(dir, ix2, privacy); } catch (e) { bad(e.message); } }
    if (ix2 && !ix2.moodMenu) bad("index-v2: no moodMenu, so this is not a v2 index");
    if (ix2 && ix2.moodMenu) {
      try {
        for (const tt of require("./lib/learning/plan-posters").indexIds(ix2)) {
          const f = path.join(dir, "posters", tt + ".jpg");
          if (!fs.existsSync(f) || !fs.statSync(f).isFile() || fs.statSync(f).size < 1000) throw Error("Missing local index poster: " + tt);
        }
        for (const e of ix2.films) { const vp = typeof e.poster === "string" && coverVersionProblem(dir, e.poster, coverShas); if (vp) bad(`index-v2: ${vp}`); }
      } catch (e) { bad("index-v2: " + e.message); }
      const have2 = new Map(ix2.films.map((e) => [e.tt, e]));
      const specs2 = [{ part: "v2-menus", rel: "index-v2-menus.json", want: () => false }];
      for (const r of ix2.board) {
        if (!ROW_ID.test(String(r.id))) { bad(`index-v2: row id "${r.id}" cannot be part of a file name`); continue; }
        if (r.series) continue; // the Worker builds it: no file
        const ids = new Set(ix2.rows[r.id] || []);
        specs2.push({ part: `v2-row:${r.id}`, rel: `index-v2-row-${r.id}.json`, row: r, want: (e) => ids.has(e.tt) });
      }
      // The friends' view (Marco, 29/10/2026; lib/friend-view.js): the watchlist row of each configured friend, one file per friend, in Marco's index only. Each holds EXACTLY the films that friend wants, has not seen and the rule lets through.
      if (!ix2.meta.personId) {
        const FV = require("./lib/friend-view");
        const entry = ix2.board.find((r) => r.id === FV.WATCHLIST_ROW && r.place === "board" && !r.series);
        try {
          const slugs = FV.slugsOf(ix2.friends.people);
          if (entry) ix2.friends.people.forEach((_, i) => {
            const films = FV.watchlistFilms(ix2, i), ids = new Set(films.map((e) => e.tt));
            specs2.push({ part: FV.piecePart(slugs[i]), rel: path.basename(FV.pieceFile(slugs[i])), friendRow: { entry, rows: { [FV.WATCHLIST_ROW]: films.map((e) => e.tt) }, rowDesc: { [FV.WATCHLIST_ROW]: films.map((e) => e.desc || "") } }, want: (e) => ids.has(e.tt) });
          });
        } catch (e) { bad(`index-v2: ${e.message}`); }
      }
      const moodIds = new Set(ix2.moods.map((m) => m.id));
      for (const o of ix2.moodMenu) if (moodIds.has(o.id)) specs2.push({ part: `v2-mood:${o.id}`, rel: `index-v2-mood-${o.id}.json`, mood: o.id, want: (e) => !!e.moods && o.id in e.moods });
      const have2byTt = new Map(ix2.films.map((e) => [e.tt, e]));
      for (const [ci, c] of ((ix2.discover && ix2.discover.catalogs) || []).entries()) for (const [oi, o] of c.options.entries()) {
        if (!o.ids) continue;
        const cut = optionCut(have2byTt, o);
        const loves = o.director !== undefined ? dirOptions(ix2).find((d) => d.label === o.director) : null;
        let ids = o.ids.slice(0, cut.n);
        if (!ix2.meta.personId && c.id === "genres" && o.id === "g-animation" && cut.n < o.ids.length) {
          // Assemble the expected full envelope independently from the exporter and from the piece on disk.
          // Sharing the byte policy is safe; calling optionPieces here would also trust its coverage bugs.
          const all = new Set(o.ids), films = ix2.films.filter((e) => all.has(e.tt));
          const labels = discoverLabels(ix2.discover);
          const candidate = { ...ix2, meta: { ...ix2.meta, part: `v2-opt:${c.id}:${o.id}`, count: films.length }, board: [], rows: {}, rowDesc: {},
            friends: { people: ix2.friends.people, options: ix2.friends.options.map((f) => ({ label: f.label, ids: [] })) },
            directors: { options: dirOptions(ix2).map((d) => loves && d.label === loves.label ? loves : { label: d.label, ids: [], descs: [] }) },
            discover: { ...labels, catalogs: labels.catalogs.map((cat, k) => k !== ci ? cat : { ...cat, options: cat.options.map((x, j) => j !== oi ? x : { ...x, ids: o.ids, total: cut.total, totalAll: cut.totalAll }) }) }, films };
          if (Buffer.byteLength(JSON.stringify(encode(candidate))) <= ANIMATION_PIECE_MAX_BYTES) ids = o.ids.slice();
        }
        const keep = new Set(ids);
        specs2.push({ part: `v2-opt:${c.id}:${o.id}`, rel: path.basename(v2OptFile(c.id, o.id)), want: (e) => keep.has(e.tt), opt: { ci, oi, ids, total: cut.total, totalAll: cut.totalAll, loves } });
      }
      stats.v2.rows = ix2.board.length;
      const expected = new Set(["index-v2.json", ...specs2.map((s) => s.rel)]);
      for (const n of dataFiles) if (!expected.has(n)) bad(`data/${n} is a v2 file the index does not account for`);
      for (const sp of specs2) {
        const f = read(`data/${sp.rel}`);
        if (!f) continue;
        const px = check(sp.part, f);
        privacy(sp.rel, f);
        const s = sp.opt ? stats.v2.options : stats.v2.pieces; s.files++; s.bytes += Buffer.byteLength(f.text); s.gzip += f.gzip; s.largest = Math.max(s.largest, f.json.films.length);
        if (!px) continue;
        const name = `index-${sp.part.replace(/:/g, "-")}`;
        const got = new Set(px.films.map((e) => e.tt)), wanted = ix2.films.filter(sp.want);
        const missing = wanted.filter((e) => !got.has(e.tt)), extra = px.films.filter((e) => !sp.want(have2.get(e.tt) || {}));
        if (missing.length) bad(`${name}: ${missing.length} film(s) it should hold are missing (${missing.slice(0, 3).map((e) => e.name).join(", ")})`);
        if (extra.length) bad(`${name}: ${extra.length} film(s) it should not hold (${extra.slice(0, 3).map((e) => e.name).join(", ")})`);
        for (const e of px.films) if (have2.has(e.tt) && !same(e, have2.get(e.tt))) bad(`${name}: ${e.tt} differs from the same film in index-v2`);
        for (const k of ["moods", "moodMenu", "lists", "rules"]) if (!same(px[k], ix2[k])) bad(`${name}: ${k} differs from index-v2`);
        if (!same(px.meta.countries, ix2.meta.countries) || !same(px.meta.countriesAll, ix2.meta.countriesAll) || !same(px.meta.decades, ix2.meta.decades)) bad(`${name}: the country or decade menu differs from index-v2`);
        if (!same(px.friends.people, ix2.friends.people) || !same(px.friends.options.map((o) => o.label), ix2.friends.options.map((o) => o.label))) bad(`${name}: the friends menu differs from index-v2`);
        if (px.friends.options.some((o) => o.ids.length)) bad(`${name}: only the whole index carries the films of the friends options`);
        if (!same(dirOptions(px).map((o) => o.label), dirOptions(ix2).map((o) => o.label))) bad(`${name}: the directors menu differs from index-v2`);
        if (dirOptions(px).some((o) => (o.ids.length || o.descs.length) && !(sp.opt && sp.opt.loves && same(o, sp.opt.loves)))) bad(`${name}: only the whole index carries the films of the directors options${sp.opt ? " (a card of a director keeps its own \"X loves\" option, as the index has it)" : ""}`);
        // the Discover grouped by subject (22/10/2026): the whole index carries the ids of the calculated options (checkIndex has seen that they are films of it, eligible, each once), every other file the same menus with `ids: []`
        const labels = discoverLabels(ix2.discover);
        const wantDiscover = !sp.opt || !labels ? labels : { ...labels, catalogs: labels.catalogs.map((c, ci) => (ci !== sp.opt.ci ? c : { ...c, options: c.options.map((x, oi) => (oi !== sp.opt.oi ? x : { ...x, ids: sp.opt.ids, total: sp.opt.total, totalAll: sp.opt.totalAll })) })) };
        if (!same(px.discover, wantDiscover)) bad(sp.opt ? `${name}: the Discover menus, or the option's ids and totals (the first ${sp.opt.ids.length} ids, ${sp.opt.total} films by default, ${sp.opt.totalAll} with Include seen), differ from index-v2's` : `${name}: the Discover menus differ from index-v2's, or carry films (only the whole index carries them)`);
        if (sp.part === "v2-menus") {
          if (!same(px.board, ix2.board)) bad(`${name}: board differs from index-v2`);
          if (!same(Object.keys(px.rows), Object.keys(ix2.rows)) || Object.values(px.rows).some((l) => l.length)) bad(`${name}: rows must name every row of index-v2 with an empty list`);
          if (!same(Object.keys(px.rowDesc), Object.keys(ix2.rowDesc)) || Object.values(px.rowDesc).some((l) => l.length)) bad(`${name}: rowDesc must name every row of index-v2 with an empty list`);
        } else if (sp.friendRow) {
          if (!same(px.board, [sp.friendRow.entry])) bad(`${name}: board must be the watchlist row's entry alone, as in index-v2`);
          if (!same(px.rows, sp.friendRow.rows) || !same(px.rowDesc, sp.friendRow.rowDesc)) bad(`${name}: rows or rowDesc are not that friend's watchlist (wanted, not seen by the friend, eligible, in the order of the index)`);
        } else if (sp.row) {
          if (!same(px.board, [sp.row])) bad(`${name}: board must be this row's entry alone, as in index-v2`);
          if (!same(px.rows, { [sp.row.id]: ix2.rows[sp.row.id] }) || !same(px.rowDesc, { [sp.row.id]: ix2.rowDesc[sp.row.id] })) bad(`${name}: rows or rowDesc differ from index-v2`);
        } else if (px.board.length || Object.keys(px.rows).length) bad(`${name}: a mood's or an option's slice carries no Board rows`);
      }
    }
  }
  return { ok: problems.length === 0, problems, stats };
}

module.exports = { verifyDir, verifyIndex, MAX_INDEX_GZIP, MAX_LANGUAGES_BYTES };

if (require.main === module && process.argv.includes("--people")) {
 try{require("./lib/people-publication").verifyAggregate(path.resolve(process.argv[2]));console.log("OK: public people aggregate");}catch(e){console.error(e.message);process.exitCode=1;}
} else if (require.main === module) {
  const dir = path.resolve(process.argv[2] || path.join(__dirname, "docs"));
  const r = verifyDir(dir);
  let username = null;
  try { username = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")).letterboxd; } catch { /* no config next to verify.js: nothing to forbid */ }
  const ix = verifyIndex(dir, { forbid: [username] });
  const pad = (s, n) => String(s).slice(0, n).padEnd(n);
  console.log(`manifest ${r.version || "?"} · ${r.catalogs || 0} catalogs · ${dir}`);
  for (const x of r.rows) console.log(`  ${x.ok ? "ok " : "BAD"} ${pad(x.kind, 8)} ${pad(x.catalog, 26)} ${pad(x.option, 56)} ${x.items == null ? "-" : String(x.items).padStart(3)} items`);
  const options = r.rows.filter((x) => x.kind === "discover").length;
  console.log(`\n${r.rows.filter((x) => x.kind === "board").length} Board files · ${options} Discover options, each with its genre= file · ${r.covers || 0} distinct covers drawn, each present`);
  if (r.ok) console.log("OK: every catalog and every declared option has its file; no orphans.");
  else { console.log(`\n${r.problems.length} problem(s):`); for (const p of r.problems) console.log("  ✖ " + p); }
  if (ix.stats.v2) console.log(`\nindex v2 for the 3.3.0 and 3.4.x Workers: ${ix.stats.v2.films} films · ${(ix.stats.v2.bytes / 1e6).toFixed(2)} MB · ${(ix.stats.v2.gzip / 1e6).toFixed(2)} MB gzipped · ${ix.stats.v2.rows} Board rows · ${ix.stats.v2.pieces.files} slices (menus, one per row, one per mood), ${(ix.stats.v2.pieces.bytes / 1e6).toFixed(2)} MB, the largest ${ix.stats.v2.pieces.largest} films${ix.stats.v2.options.files ? ` · ${ix.stats.v2.options.files} option pieces of the Discover, ${(ix.stats.v2.options.bytes / 1e6).toFixed(2)} MB, the largest ${ix.stats.v2.options.largest} films` : ""}`);
  console.log(`\nindex for the Worker: ${ix.stats.films} films · ${(ix.stats.bytes / 1e6).toFixed(2)} MB · ${(ix.stats.gzip / 1e6).toFixed(2)} MB gzipped (limit ${MAX_INDEX_GZIP / 1e6} MB) · Board part ${ix.stats.board.films} films, ${(ix.stats.board.bytes / 1e3).toFixed(0)} KB · ${ix.stats.pieces.files} other pieces, ${(ix.stats.pieces.bytes / 1e6).toFixed(2)} MB, the largest ${ix.stats.pieces.largest} films`);
  if (ix.ok) console.log("OK: the index has every tt of every row, no personal field, no seen film outside Old friends, and fits the size limit.");
  else { console.log(`\n${ix.problems.length} index problem(s):`); for (const p of ix.problems.slice(0, 40)) console.log("  ✖ " + p); }
  process.exit(r.ok && ix.ok ? 0 : 1);
}
