// Static lists (Marco, 11/10/2026): a list that exists only as a magazine article (IndieWire's 2023 French and 2025 animation
// editions have no Letterboxd copy) is kept in the repository, in the editor's order, and enters the build by the same door as a
// Letterboxd list: config.json lists[] with  source: "static", file: "data/lists/<id>.json".
//
// The file (the article's address and date are in it, so is every film's identity as it was checked on its Letterboxd film page):
//   { "id", "source": { "publication", "title", "url", "edition" (YYYY-MM-DD), "readOn" (YYYY-MM-DD) },
//     "items": [{ "slug", "title", "year", "imdb": "tt…", "tmdb": 123, "tmdbType": "movie" | "tv" }] }   position = order of "items"
//
// What the build does with it (lib/lists.js refreshLists reads the file instead of a page; build.js lays apply() over view.films):
//   - a film joins by the IMDb id written in the file. If Letterboxd's own record of that slug names another IMDb id, the item is
//     refused (and named in the build's problems); if the record has none or the slug was never looked up, the file supplies the
//     identity (imdbId, tmdbId). The TMDB movie is then joined by lib/list-signal.js joinTmdb, which takes the TMDB id only when
//     that movie's own IMDb id is the file's (tmdb.movie[id].imdb === imdb), exactly as for the Letterboxd lists.
//   - an item with tmdbType "tv" (a series: Li'L Quinquin, When the Levees Broke) keeps its position but is no film of this list: it
//     moves to a slug of this list alone ("tv:<list>:<slug>"), marked "gone", so neither this list's catalogs nor the pool or the signal
//     take it through this list, and it is counted in the log. Letterboxd's record of the real slug is never touched: another list that
//     names the same slug keeps it (review S4-B, 11/10/2026: overlaying the slug itself took Li'l Quinquin out of Slant's 2010s and
//     of the older IndieWire French copy).
// Pure functions except load().

const fs = require("fs");
const path = require("path");

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isStatic = (l) => !!l && l.source === "static";

/** The problems of a parsed file, [] when it is sound. `l` is the config entry (its id and file). */
function validate(data, l = {}) {
  const at = `${l.file || "static list"}`;
  const out = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) return [`${at}: not an object`];
  if (l.id && data.id !== l.id) out.push(`${at}: id is ${JSON.stringify(data.id)}, config.json says ${JSON.stringify(l.id)}`);
  const s = data.source;
  if (!s || typeof s !== "object") out.push(`${at}: no source`);
  else {
    if (!/^https?:\/\/\S+$/.test(String(s.url || ""))) out.push(`${at}: source.url is not an address`);
    if (typeof s.title !== "string" || !s.title) out.push(`${at}: source.title missing`);
    if (typeof s.publication !== "string" || !s.publication) out.push(`${at}: source.publication missing`);
    if (!DATE.test(s.edition || "")) out.push(`${at}: source.edition must be YYYY-MM-DD`);
    if (!DATE.test(s.readOn || "")) out.push(`${at}: source.readOn must be YYYY-MM-DD`);
  }
  if (!Array.isArray(data.items) || !data.items.length) { out.push(`${at}: items must be a non-empty array`); return out; }
  const slugs = new Set(), imdbs = new Set();
  data.items.forEach((it, i) => {
    const w = `${at} item ${i + 1}${it && it.slug ? ` (${it.slug})` : ""}`;
    if (!it || typeof it !== "object") { out.push(`${w}: not an object`); return; }
    if (typeof it.slug !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(it.slug)) out.push(`${w}: slug is not a Letterboxd slug`);
    else if (slugs.has(it.slug)) out.push(`${w}: slug used twice`);
    else slugs.add(it.slug);
    if (typeof it.title !== "string" || !it.title) out.push(`${w}: no title`);
    if (!Number.isInteger(it.year) || it.year < 1880 || it.year > 2100) out.push(`${w}: year must be an integer`);
    if (typeof it.imdb !== "string" || !/^tt\d{5,}$/.test(it.imdb)) out.push(`${w}: imdb must look like tt1234567`);
    else if (imdbs.has(it.imdb)) out.push(`${w}: imdb ${it.imdb} used twice`);
    else imdbs.add(it.imdb);
    if (!Number.isInteger(it.tmdb) || it.tmdb <= 0) out.push(`${w}: tmdb must be a positive integer`);
    if (it.tmdbType !== "movie" && it.tmdbType !== "tv") out.push(`${w}: tmdbType must be "movie" or "tv"`);
  });
  return out;
}

/** Reads and validates data/lists/<id>.json (or takes it from `files`, name → parsed, when frozen). A malformed file stops the build, naming what is wrong. → the parsed file. */
function load(root, l, files = null) {
  if (typeof l.file !== "string" || !/^data\/lists\/[A-Za-z0-9_.-]+\.json$/.test(l.file)) throw new Error(`list ${l.id}: a static list needs file: "data/lists/<id>.json", not ${JSON.stringify(l.file)}`);
  let data;
  if (files) { // frozen: the learning snapshot holds the parsed files (a replay never reads the disk)
    data = files[l.file];
    if (data === undefined) throw new Error(`list ${l.id}: ${l.file} is not among the frozen sources`);
  } else {
    try { data = JSON.parse(fs.readFileSync(path.join(root, l.file), "utf8")); }
    catch (e) { throw new Error(`list ${l.id}: ${l.file} cannot be read (${e.message})`); }
  }
  const problems = validate(data, l);
  if (problems.length) throw new Error(`list ${l.id}: ${problems.slice(0, 6).join("; ")}${problems.length > 6 ? ` (+${problems.length - 6} more)` : ""}`);
  return data;
}

/** The items the way refreshLists hands every list on: { slug, title, year } in the editor's order, plus what the file knows. */
const itemsOf = (data) => data.items.map((it) => ({ slug: it.slug, title: it.title, year: it.year, imdb: it.imdb, tmdb: it.tmdb, tmdbType: it.tmdbType, tv: it.tmdbType === "tv" }));

/** "IndieWire, 25/09/2023 — <article> — <url>": what the config and the log say about where a static list comes from. */
const describe = (data) => `${data.source.publication}, edition ${data.source.edition}: ${data.source.title} — ${data.source.url} (${data.items.length} films, in the editor's order; read ${data.source.readOn})`;

/**
 * Lays the static lists over Letterboxd's film records. `films` is cache.films and is never changed: the result is a copy.
 * → { films, problems, stats: [{ id, items, tv, supplied, agreed, refused, gone }] }
 *   tv: a series (tmdbType "tv"): the item keeps its place under a slug of this list alone, marked gone (Letterboxd's record of the slug is untouched)
 *   supplied: no usable Letterboxd record yet, the file gives the identity · agreed: the record names the same IMDb id
 *   refused: the record names another IMDb id (the item keeps its place in list.items, under a dead slug marked gone: no surface takes it)
 *   gone: Letterboxd's record says the page is gone (left alone)
 */
function apply({ lists, films }) {
  const out = { ...films };
  const problems = [], stats = [];
  for (const l of lists) {
    if (!isStatic(l)) continue;
    const st = { id: l.id, items: l.items.length, tv: 0, supplied: 0, agreed: 0, refused: 0, gone: 0 };
    const items = [];
    for (const it of l.items) {
      if (it.tv) {
        // a series is no film of THIS list: it keeps its place under a slug of this list alone, marked gone (review S4-B, 11/10/2026).
        // Letterboxd's own record of the slug is left as it is: the other lists that name it (Slant's 2010s, the older IndieWire copy)
        // keep it, and whether it is a film for the pool and the signal stays the business of the TMDB join by IMDb id.
        const dead = `tv:${l.id}:${it.slug}`;
        out[dead] = { gone: true, tv: true, title: it.title, year: it.year };
        st.tv++; items.push({ ...it, slug: dead }); continue;
      }
      const r = films[it.slug];
      if (r && r.gone) { st.gone++; items.push(it); continue; }
      if (r && r.imdbId) {
        if (r.imdbId === it.imdb) { st.agreed++; items.push(it); continue; }
        // the slug is another film than the one the editor named: not for this list, whatever the other lists do with the slug.
        // The item keeps its place (the positions after it do not move) under a slug no page has, marked gone.
        const dead = `refused:${l.id}:${it.slug}`;
        out[dead] = { gone: true, refused: true, title: it.title, year: it.year };
        problems.push(`list ${l.id} (${l.name}): ${it.slug} is ${it.imdb} in the file but Letterboxd's record says ${r.imdbId}; refused`);
        st.refused++; items.push({ ...it, slug: dead }); continue;
      }
      out[it.slug] = { ...(r || {}), canon: (r && r.canon) || it.slug, title: (r && r.title) || it.title, year: (r && r.year) || it.year, imdbId: it.imdb, tmdbId: it.tmdb };
      st.supplied++; items.push(it);
    }
    l.items = items;
    stats.push(st);
  }
  return { films: out, problems, stats };
}

/**
 * Letterboxd's film records with every static list of `cfg` laid over them, read from `root`: what a build sees as view.films. For whoever
 * recomputes the recommendation rule from the caches outside build.js (the tests, the learning replay). `films` is not changed.
 */
function filmsFor(cfg, root, films, files = null) {
  const lists = (cfg.lists || []).filter(isStatic).map((l) => ({ ...l, items: itemsOf(load(root, l, files)) }));
  return lists.length ? apply({ lists, films }).films : films;
}

module.exports = { isStatic, validate, load, itemsOf, describe, apply, filmsFor };
