// Writes the static Stremio addon + the data file the mood-picker page reads, from a catalog plan (lib/plan.js).

const fs = require("fs");
const path = require("path");
const { describe } = require("./describe");

const metahub = (imdb) => `https://images.metahub.space/poster/medium/${imdb}/img`;
const tmdbImg = (p, size = "w342") => (p ? `https://image.tmdb.org/t/p/${size}${p}` : null);

const isUrl = (u) => /^https?:\/\/\S+$/i.test(String(u || ""));

/**
 * One Stremio meta. `poster` is the cover with the badges when lib/posters.js drew one (item.poster is then its address), else the
 * metahub cover by IMDb id. `imdbRating` and `genres` are what Stremio shows beside the description. The description is lib/describe.js:
 * the credits line and the mood line (two lines, each ended by a full stop; description v3, 20/10/2026), then `separator` (config.json → descriptionSeparator) and the synopsis.
 */
function toMeta(it, { separator = "\n\n" } = {}) {
  const imdb = it.ratings && it.ratings.imdb;
  return {
    id: it.id,
    type: "movie",
    name: it.title,
    poster: isUrl(it.poster) ? it.poster : metahub(it.id),
    posterShape: "poster",
    releaseInfo: it.year ? String(it.year) : undefined,
    runtime: it.runtime ? `${it.runtime} min` : undefined,
    genres: it.genres?.length ? it.genres : undefined,
    imdbRating: imdb != null ? imdb.toFixed(1) : undefined,
    description: describe(it, separator),
  };
}

/**
 * The manifest for a plan: every Board row, then every Discover catalog. A Discover catalog has exactly one extra,
 * `genre`, required (⇒ off the Board) and with `options` (⇒ a dropdown). No `skip`: the whole list is one file.
 */
function manifestFor(cfg, plan) {
  return {
    id: cfg.addon.id,
    version: cfg.addon.version,
    name: cfg.addon.name,
    description: cfg.addon.description,
    logo: "https://raw.githubusercontent.com/twitter/twemoji/master/assets/72x72/1f3ac.png",
    resources: ["catalog"],
    types: ["movie"],
    idPrefixes: ["tt"],
    catalogs: [
      ...plan.board.map((r) => ({ type: "movie", id: r.id, name: r.name })),
      ...plan.discover.map((c) => ({ type: "movie", id: c.id, name: c.name, extra: [{ name: "genre", isRequired: true, options: c.options.map((o) => o.label) }] })),
    ],
    behaviorHints: { configurable: false, configurationRequired: false },
  };
}

/**
 * Writes everything. `index2`: the v2 index (lib/index-export.js buildIndex with `v2`), written next to the legacy index and its pieces; it needs `index`. `posters`: { dir, tts } copies dir/<tt>.jpg into <out>/posters for each tt in `tts` (the covers lib/posters.js drew;
 * they live outside the output folder; publication verifies a stage before replacing the previous output).
 */
function publish({ outDir, webDir, cfg, plan, webData, seen, privacy, posters = null, index = null, index2 = null, pageFacts = null }) {
  const meta = (it) => toMeta(it, { separator: cfg.descriptionSeparator ?? "\n\n" });
  const { validatePublication, verifyPublic } = require("./learning/public");
  if (index) {
    require("./index-validation").validateIndex(index);
    if (privacy) require("./learning/public").assertPrivateAbsent(index,privacy);
  }
  if (index2) {
    if (!index) throw new Error("The v2 index is written next to the full index, never alone");
    require("./index-validation").validateIndex(index2, "index-v2");
    if (privacy) require("./learning/public").assertPrivateAbsent(index2,privacy);
  }
  const referenced = require("./learning/plan-posters").publishedIds(plan,index);
  if (index2) for (const tt of require("./learning/plan-posters").indexIds(index2)) referenced.add(tt);
  // Marco, 14/10/2026: every Will release identifies its owner and reserved revision.
  if (cfg.personContext) webData = { ...webData, meta: cfg.personContext };
  webData = validatePublication(plan, webData, seen, privacy);
  const destination = require("./learning/paths").validateDestination(outDir,path.dirname(path.resolve(webDir)),null,false);
  if (destination === path.parse(destination).root || destination === path.resolve(webDir) || path.resolve(webDir).startsWith(destination + path.sep)) throw new Error("Unsafe publication destination");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const staging = fs.mkdtempSync(destination + ".staging-");
  const backup = destination + ".previous-" + require("crypto").randomUUID();
  let moved = false;
  outDir = staging;
  try {
  fs.mkdirSync(path.join(outDir, "catalog", "movie"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "data"), { recursive: true });

  const manifest = manifestFor(cfg, plan);
  write(outDir, "manifest.json", manifest);

  for (const r of plan.board) write(outDir, `catalog/movie/${r.id}.json`, { metas: r.items.map(meta), cacheMaxAge: 3 * 3600 });
  let files = plan.board.length;
  for (const c of plan.discover)
    for (const o of c.options) {
      const body = { metas: o.items.map(meta), cacheMaxAge: 3 * 3600 };
      // Stremio may ask for the option as typed or percent-encoded; a static host decodes, but write both to be safe.
      write(outDir, `catalog/movie/${c.id}/genre=${o.label}.json`, body);
      files++;
      if (encodeURIComponent(o.label) !== o.label) { write(outDir, `catalog/movie/${c.id}/genre=${encodeURIComponent(o.label)}.json`, body); files++; }
    }

  const indexStats = index ? require("./index-export").writeIndex(outDir,index,index2) : null;
  const pages = index2 && !cfg.personContext && !index2.meta.personId ? require("./page-export").writePages(outDir, index2, pageFacts) : null;
  let covers = 0;
  if (posters) {
    fs.mkdirSync(path.join(outDir, "posters"), { recursive: true });
    for (const tt of posters.tts) {
      if (!/^tt\d+$/.test(tt)) throw new Error("Invalid poster identity");
      const from = path.join(posters.dir, `${tt}.jpg`);
      const Paths = require("./learning/paths");
      Paths.noAliases(from, path.resolve(posters.dir));
      if (!fs.statSync(from).isFile() || !Paths.within(fs.realpathSync(from), fs.realpathSync(posters.dir))) throw new Error("Unsafe poster source");
      const bytes = fs.readFileSync(from);
      require("./learning/public").jpeg(bytes);
      if (!referenced.has(tt)) throw new Error("Unreferenced poster");
      fs.writeFileSync(path.join(outDir, "posters", `${tt}.jpg`), bytes); covers++;
    }
  }
  write(outDir, "data/engine.json", webData);
  let html = fs.readFileSync(path.join(webDir, "index.html"), "utf8");
  if (cfg.letterboxd === "friend-a") {
    const marker = 'data-owner="mgusmao"';
    if (html.split(marker).length !== 2) throw new Error("Will page requires exactly one owner marker");
    html = html.replace(marker, 'data-owner="friend-a"');
  }
  fs.writeFileSync(path.join(outDir, "index.html"), html);
  fs.mkdirSync(path.join(outDir, "assets"), { recursive: true });
  for (const name of ["selector.js", "feedback.js", "person.js", "upload.js"]) if (fs.existsSync(path.join(webDir, name))) fs.copyFileSync(path.join(webDir, name), path.join(outDir, "assets", name));
  fs.copyFileSync(path.join(__dirname, "learning/feedback.js"), path.join(outDir, "assets/feedback-core.js"));
  fs.writeFileSync(path.join(outDir, ".nojekyll"), "");
  const checked = require("../verify").verifyDir(staging);
  if (!checked.ok) throw new Error("Staged publication invalid: " + checked.problems.join("; "));
  verifyPublic(staging,privacy);
  // Compare serialized descriptions to the approved incumbent renderer, not a keyword filter.
  for (const row of plan.board) {
    const actual = JSON.parse(fs.readFileSync(path.join(staging, "catalog/movie", row.id + ".json"), "utf8"));
    if (JSON.stringify(actual.metas) !== JSON.stringify(row.items.map(meta))) throw new Error("Catalog projection changed");
  }
  for (const catalog of plan.discover) for (const option of catalog.options) {
    const file = path.join(staging, "catalog/movie", catalog.id, "genre=" + option.label + ".json");
    const actual = JSON.parse(fs.readFileSync(file, "utf8"));
    if (JSON.stringify(actual.metas) !== JSON.stringify(option.items.map(meta))) throw new Error("Discover projection changed");
  }
  if (fs.existsSync(destination)) { fs.renameSync(destination, backup); moved = true; }
  try { fs.renameSync(staging, destination); } catch (e) { if (moved) fs.renameSync(backup, destination); throw e; }
  fs.rmSync(backup, { recursive: true, force: true });
  return { manifest, catalogs: manifest.catalogs.length, files, covers, index: indexStats, pages };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

function write(dir, rel, obj) {
  if (path.isAbsolute(rel) || rel.includes("\\") || rel.split("/").some(x => x === ".." || x === ".")) throw new Error("Unsafe catalog path");
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
}

module.exports = { publish, manifestFor, toMeta, tmdbImg };
