'use strict';
// films — reads the sources once, writes the projection to a private file, and reuses it while the sources are unchanged.
// The index lives under .context/ (gitignored): it holds Marco's history and friends' ratings and must never be committed or published.
// Covered by tools/films/films.test.js (rebuild on change, gitignored location).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadHistory } = require('../../lib/letterboxd');
const LW = require('../../lib/list-signal');
const SL = require('../../lib/static-lists');
const DL = require('../../lib/directors-loved');
const { project } = require('./project');
const Qy = require('./query');

const FORMAT = 7; // bump when the projection's shape changes (7: origin, mainCountry and the director's citizenship; 4: eligibility with the vouched exception, cv fields, lovedWithoutRecord; 5: moodLists; 6: lists carry positions, the build's corrections and the static lists)
const SOURCES = ['cache/tmdb.json', 'cache/directors.json', 'cache/friends.json', 'cache/lists.json', 'config.json',
  'data/letterboxd/ratings.csv', 'data/letterboxd/watched.csv', 'data/letterboxd/watchlist.csv', 'data/letterboxd/diary.csv', 'data/letterboxd/likes/films.csv',
  'data/directors-loved.json', 'data/cannes-critic-prizes.json', 'data/venice-golden-lion.json', 'data/berlin-golden-bear.json'];
const CODE = ['tools/films/project.js', 'tools/films/store.js', 'tools/films/query.js', 'lib/countries.js', 'lib/directors.js', 'tools/selo/countries.json', 'lib/recommendation-quality.js', 'lib/friends.js', 'lib/letterboxd.js', 'lib/util.js',
  'lib/list-signal.js', 'lib/static-lists.js', 'lib/critic-subset.js', 'lib/lists.js', 'lib/directors-loved.js', 'lib/taste.js'];

/** Every source file of `root`: the fixed ones plus every static list under data/lists/ (a new list changes the vouched set). */
function sourceFiles(root) {
  const dir = path.join(root, 'data', 'lists');
  const lists = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort().map((n) => `data/lists/${n}`) : [];
  return [...SOURCES, ...lists];
}

/** Index of `root`, kept in `home`'s ignored .context/ (home = this checkout); another root gets its own file named by its path. */
const defaultIndex = (home, root = home) => process.env.FILMS_INDEX || path.join(home, '.context', 'films',
  root === home ? 'index.json' : `index-${crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 12)}.json`);

/** Cheap signature (size + mtime) of every source and of the code that shapes the projection. */
function signature(root) {
  const parts = [`format:${FORMAT}`];
  for (const rel of [...sourceFiles(root), ...CODE]) {
    const p = path.join(root, rel);
    const s = fs.existsSync(p) ? fs.statSync(p) : null;
    parts.push(`${rel}:${s ? `${s.size}:${s.mtimeMs}` : 'missing'}`);
  }
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

function readSources(root) {
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const json = (rel) => (fs.existsSync(path.join(root, rel)) ? JSON.parse(read(rel)) : null);
  const files = {};
  for (const rel of sourceFiles(root)) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) { files[rel] = null; continue; }
    files[rel] = { sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'), modifiedAt: fs.statSync(p).mtime.toISOString() };
  }
  const { films } = loadHistory(path.join(root, 'data', 'letterboxd'));
  // The export carries no capture time; its newest dated row is the honest lower bound (file mtimes are checkout times).
  const newest = [...films.values()].flatMap((f) => [f.ratedOn, f.watchlistedOn, f.lastWatched]).filter(Boolean).sort().at(-1) || null;
  const tmdb = json('cache/tmdb.json') || { movie: {}, search: {} };
  const friends = json('cache/friends.json') || { films: {}, users: {} };
  const lists = json('cache/lists.json') || { lists: {} };
  const cfg = json('config.json') || {};
  const directors = require('../../lib/directors').citizenshipMap(json('cache/directors.json') || {}); // 23/10/2026: the first layer of the main country
  // The two halves of the one floor exception, from the files alone (no network), as build.js:275-293 assembles them.
  // vouched: films in a critic or director list (static lists and the Cannes critics' subset included).
  const vouched = LW.vouchedFromCaches({ cfg, listsCache: lists, films: friends.films || {}, root });
  // The static lists laid over Letterboxd's records: the build's view.films, so a film only a static list identifies has an entry.
  // The static lists with apply() run over them (a series or a refused item moves to a dead slug), once, for both: the records and the lists' members.
  const staticLists = (cfg.lists || []).filter(SL.isStatic).map((l) => { const data = SL.load(root, l); return { ...l, fetchedAt: `${data.source.readOn}T00:00:00.000Z`, items: SL.itemsOf(data) }; });
  const staticFilms = staticLists.length ? SL.apply({ lists: staticLists, films: friends.films || {} }).films : friends.films || {};
  // loved: a favourite director's love. The favourites come from Marco's ratings, so the projection asks for them once those are resolved.
  const lovedCfg = { ...DL.DEFAULTS, ...(cfg.directorsLoved || {}) };
  const lovedData = DL.load(root, lovedCfg);
  if (lovedData) { const problems = DL.validate(lovedData); if (problems.length) throw new Error(`${lovedCfg.file}: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ''}`); }
  const following = (friends.following?.users || []).map(([user]) => user);
  const peek = (id) => (id != null ? tmdb.movie?.[id]?.v || null : null);
  const loved = (records) => (lovedData
    ? DL.vouched({ data: lovedData, stats: [...Qy.tasteModel({ films: records }).stats.values()], cfg: lovedCfg, following, peek })
    : new Map());
  return {
    tmdb, friends, lists, cfg, vouched, staticFilms, staticLists, loved, directors,
    history: films,
    times: { export: newest ? `${newest} (newest row in the export)` : null, files },
  };
}

/** The projection of `root`, in memory: { index, signature }. Reads the sources, writes nothing anywhere. */
function snapshot(root) {
  const signature_ = signature(root);
  const index = project(readSources(root));
  index.meta.signature = signature_;
  index.meta.builtAt = new Date().toISOString();
  index.meta.root = root;
  return { index, signature: signature_ };
}

/**
 * Returns { index, rebuilt, ms }. Rebuilds only when the signature changed (or force).
 * write: false (default true) is a read-only call: a prepared index with the same signature is read; otherwise the projection is made
 * in memory and neither the index file nor its directory is created. `rebuilt` is true in that case too (nothing was reused).
 */
function load(root, { indexFile = defaultIndex(root), force = false, write = true } = {}) {
  const t0 = process.hrtime.bigint();
  const sig = signature(root);
  if (!force && fs.existsSync(indexFile)) {
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    if (index.meta?.signature === sig) return { index, rebuilt: false, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  }
  const { index } = snapshot(root);
  if (write) {
    if (!indexFile.endsWith('.json')) throw new Error(`index must be a .json file: ${indexFile}`);
    fs.mkdirSync(path.dirname(indexFile), { recursive: true, mode: 0o700 });
    const tmp = `${indexFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index), { mode: 0o600 });
    fs.renameSync(tmp, indexFile);
  }
  return { index, rebuilt: true, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

module.exports = { load, snapshot, signature, readSources, defaultIndex, sourceFiles, SOURCES };
