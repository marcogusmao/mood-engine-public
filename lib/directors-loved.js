// "Loved by your directors" (Marco, 11/10/2026): films that the directors Marco loves have said they love, and he has not seen.
//
// The source is data/directors-loved.json: per director, the sources (a Sight and Sound ballot, a Criterion Closet visit, their own
// Letterboxd list, an interview…) each with a confidence, and the films with their IMDb / TMDB ids taken from the film's Letterboxd page.
// Only high and medium confidence sources enter (Marco, 11/10/2026, decision 8); validate() refuses anything else.
//
// Who is a favourite director, three ways, then one veto:
//   ratings    automatic: the taste model's director stat (lib/taste.js) with at least `minFilms` films rated and an average of `minAvg`★
//   include    names in config.json → directorsLoved.include
//   following  a Letterboxd account Marco follows (cache/friends.json → following) that config maps to a director (`accounts`). The map is
//              explicit: most "director" accounts on Letterboxd are fans (davidlynch, scorsese, tarantino, seanbaker…), so none is deduced.
//   exclude    names in directorsLoved.exclude never count (Jeff Tremaine and Jimmy Chin reach the automatic bar on a few documentaries)
// A director's weight is Marco's own taste weight for them (the stat's `w`); an included or followed director gets at least `defaultWeight`.
//
// A film's score is the sum, over the favourite directors who love it, of weight × confidence (1.0 high, 0.6 medium): consensus rises.
// The Board row keeps at most `perDirector` films per lead director (the lover with the largest share of the film's score), so one
// director with 80 films on file cannot fill the row. The Discover menu has one option per favourite director with at least `menuMin`
// unseen films, in the order of Marco's weight.
//
// The recommendation floor (Letterboxd ≥ 3.5, lib/recommendation-quality.js) does not apply to these films: a director's endorsement counts
// as a trusted list (Marco, 11/10/2026, decision 5). It is the SAME exception as a critic or director list: vouched() below hands the
// films to lib/recommendation-quality.js index() (`loved`), which marks them cv: 1, so the Board, every Discover cut, the browser picker
// and the Worker's `eligible` flag agree. The items' `trust: "director"` is a label only; the floor reads the film, never the item.
//
// Pure functions; build.js wires them to the caches. test/directors-loved.test.js feeds them small fakes and validates the real file.

const fs = require("fs");
const path = require("path");
const { lovedBy } = require("./loved-by");

const CONFIDENCE = Object.freeze({ high: 1.0, medium: 0.6 });
const DEFAULTS = Object.freeze({ file: "data/directors-loved.json", minFilms: 3, minAvg: 4.0, defaultWeight: 0.5, perDirector: 2, menuMin: 5, size: 30, include: [], exclude: [], accounts: {}, aliases: {}, labels: {} });
/** How a source is named in a description, by kind. An interview is dated by its year. */
const KIND_LABEL = {
  "sight-and-sound-2022": "Sight & Sound 2022 ballot",
  "sight-and-sound-2012": "Sight & Sound 2012 ballot",
  "criterion-closet": "Criterion Closet",
  "criterion-top10": "Criterion Top 10",
  "letterboxd-own": "own Letterboxd list",
  documentary: "documentary",
  interview: "interview",
};

/** "Alejandro G. Iñárritu" → "alejandro g inarritu". */
const norm = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function load(root, cfg = {}) {
  const file = path.resolve(root, cfg.file || DEFAULTS.file);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Every problem of the file, as a sentence. [] when it is fit to use. */
function validate(data) {
  const out = [];
  if (!data || !Array.isArray(data.directors)) return ["directors-loved: no directors list"];
  const ids = new Set();
  for (const d of data.directors) {
    const at = `directors-loved: ${d && d.name}`;
    if (!d || typeof d.name !== "string" || !d.name.trim()) { out.push("directors-loved: a director without a name"); continue; }
    const own = new Set();
    for (const s of d.sources || []) {
      if (!s || typeof s.id !== "string" || !s.id) { out.push(`${at}: a source without an id`); continue; }
      if (ids.has(s.id)) out.push(`${at}: source id ${s.id} is used twice`);
      ids.add(s.id); own.add(s.id);
      if (!(s.confidence in CONFIDENCE)) out.push(`${at}: source ${s.id} has confidence "${s.confidence}" (only high and medium enter)`);
      if (!(s.kind in KIND_LABEL)) out.push(`${at}: source ${s.id} has an unknown kind "${s.kind}"`);
      if (!/^https?:\/\/\S+$/.test(String(s.url || ""))) out.push(`${at}: source ${s.id} has no address`);
      if (typeof s.title !== "string" || !s.title) out.push(`${at}: source ${s.id} has no title`);
      if (s.short !== undefined && (typeof s.short !== "string" || !s.short || s.short.length > 40)) out.push(`${at}: source ${s.id} has a short name that is not a text of up to 40 characters`);
      if (s.with !== undefined && (typeof s.with !== "string" || !s.with.trim() || s.with.length > 60)) out.push(`${at}: source ${s.id} has a "with" (the other half of a pair) that is not a name of up to 60 characters`);
    }
    const seen = new Set();
    for (const f of d.films || []) {
      const ft = `${at}: ${f && f.title} (${f && f.year})`;
      if (!f || typeof f.title !== "string" || !f.title) { out.push(`${at}: a film without a title`); continue; }
      if (!/^tt\d{7,}$/.test(String(f.imdb))) out.push(`${ft}: IMDb id "${f.imdb}"`);
      if (!(Number.isInteger(f.tmdb) && f.tmdb > 0)) out.push(`${ft}: TMDB id "${f.tmdb}"`);
      if (!["movie", "tv"].includes(f.tmdbType)) out.push(`${ft}: tmdbType "${f.tmdbType}"`);
      if (!(Number.isInteger(f.year) && f.year >= 1880 && f.year <= 2100)) out.push(`${ft}: year "${f.year}"`);
      if (seen.has(f.imdb)) out.push(`${ft}: listed twice for this director`);
      seen.add(f.imdb);
      if (!Array.isArray(f.sources) || !f.sources.length) out.push(`${ft}: no source`);
      for (const id of f.sources || []) if (!own.has(id)) out.push(`${ft}: source ${id} is not one of this director's sources`);
    }
  }
  return out;
}

/** Short names for the descriptions and the menu: the surname, unless two directors share it (Coppola), then the full name. `labels` overrides. */
function shortNames(names, labels = {}) {
  const last = (n) => n.trim().split(/\s+/).pop();
  const count = new Map();
  for (const n of names) count.set(norm(last(n)), (count.get(norm(last(n))) || 0) + 1);
  return new Map(names.map((n) => [n, labels[n] || (count.get(norm(last(n))) > 1 ? n : last(n))]));
}

/**
 * The taste model's stat for a director named in the file: by alias, then by the same normalised name, then by the same first and last
 * word when exactly one rated director has them ("Alejandro G. Iñárritu" = "Alejandro González Iñárritu"). null when none.
 */
function statFor(name, stats, aliases = {}) {
  const want = norm(aliases[name] || name);
  const exact = stats.filter((s) => norm(s.label) === want);
  if (exact.length) return exact.sort((a, b) => b.n - a.n)[0];
  const w = want.split(" ");
  const ends = stats.filter((s) => { const t = norm(s.label).split(" "); return t.length > 1 && w.length > 1 && t[0] === w[0] && t[t.length - 1] === w[w.length - 1]; });
  return ends.length === 1 ? ends[0] : null;
}

/**
 * stats      the taste model's stats (lib/taste.js learn().stats values); only type "director" is read
 * following  the Letterboxd accounts Marco follows: [user, …]
 * → { list: [{ name, label, weight, via: [...], stat }] best weight first (only directors the file has films for),
 *     auto: [names of the automatic favourites, with or without films on file], excluded: [names vetoed] }
 */
function favorites({ data, stats = [], cfg = {}, following = [] }) {
  const c = { ...DEFAULTS, ...cfg };
  const dirStats = stats.filter((s) => s.type === "director");
  const vetoed = new Set((c.exclude || []).map(norm));
  const byName = new Map();
  const put = (name, via, stat) => {
    if (vetoed.has(norm(name))) return;
    const k = norm(name);
    const e = byName.get(k) || byName.set(k, { name, via: [], stat: stat || null }).get(k);
    if (!e.via.includes(via)) e.via.push(via);
    if (stat && !e.stat) e.stat = stat;
  };
  const fileNames = new Map((data?.directors || []).map((d) => [norm(d.name), d.name]));
  const nameOf = (n) => fileNames.get(norm(n)) || n;
  const auto = [];
  for (const s of dirStats) if (s.n >= c.minFilms && s.avg >= c.minAvg && !vetoed.has(norm(s.label))) {
    // the stat's label is TMDB's spelling; the file may spell the same person differently
    const inFile = [...fileNames.values()].find((n) => statFor(n, [s], c.aliases) === s);
    auto.push(inFile || s.label);
    put(inFile || s.label, "ratings", s);
  }
  for (const n of c.include || []) put(nameOf(n), "manual", statFor(nameOf(n), dirStats, c.aliases));
  const follows = new Set(following.map((u) => String(u).toLowerCase()));
  for (const [user, n] of Object.entries(c.accounts || {})) if (follows.has(user.toLowerCase())) put(nameOf(n), "following", statFor(nameOf(n), dirStats, c.aliases));

  const withFilms = (data?.directors || []).filter((d) => (d.films || []).length);
  const labels = shortNames(withFilms.map((d) => d.name), c.labels);
  const list = [];
  for (const e of byName.values()) {
    const d = withFilms.find((x) => norm(x.name) === norm(e.name));
    if (!d) continue;
    const own = e.stat && e.stat.w > 0 ? e.stat.w : 0;
    const weight = e.via.some((v) => v !== "ratings") ? Math.max(own, c.defaultWeight) : own;
    if (!(weight > 0)) continue;
    list.push({ name: d.name, label: labels.get(d.name), weight, via: e.via, stat: e.stat });
  }
  list.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  return { list, auto, excluded: (c.exclude || []).slice() };
}

/**
 * Did `fav` direct this film? (Marco, 11/10/2026: a director's love of their OWN film is left out of "Loved by your directors": Kings of
 * the Road for Wenders, 8½ for Fellini, Rumble Fish for Francis Ford Coppola, The Virgin Suicides for Sofia Coppola, Secrets & Lies for
 * Leigh.) Read from the film's TMDB record, and only a record JOINED by IMDb id (detail: p.imdb === the file's imdb; otherwise null and
 * nobody is taken for its director): a director of the record is the favourite when the taste model's stat is that person (d:<TMDB
 * person id>) or the names agree as statFor() reads them (alias, the same normalised name, the same first and last word).
 */
function directs(detail, fav, aliases = {}) {
  if (!detail) return false;
  return (detail.directors || []).some((p) => (fav.stat && p.id != null && fav.stat.key === `d:${p.id}`) || (p.name && statFor(fav.name, [{ label: p.name, n: 1 }], aliases) !== null));
}

/**
 * The unseen films the favourite directors love, best first.
 * isSeen({ imdb, tmdb, slug, title, originalTitle, year })  the build's "seen" test; `tmdb` is given only when the join below confirmed it
 * peek(tmdbId)  the TMDB movie cache record, or null. It is JOINED only when its IMDb id is the file's: a TMDB id that names another film
 *               (the TV ids of old records) gives no detail and no TMDB id, and the film is published by its IMDb id alone.
 *               The joined record also says who directed the film: a favourite's love of their own film is left out (directs() above);
 *               a film another favourite loves stays, through that one (Rumble Fish stays by Sofia Coppola).
 * aliases       config.json directorsLoved.aliases (the file's spelling → TMDB's), for directs()
 * → [{ imdb, tmdb, slug, title, year, detail, score, lovers: [{ name, label, weight, conf, share, sources: [source] }] }]
 */
function lovedFilms({ data, favorites: favs, isSeen = () => false, peek = () => null, aliases = {} }) {
  const byDir = new Map((data?.directors || []).map((d) => [norm(d.name), d]));
  const films = new Map();
  const detailOf = (f) => { const p = peek(f.tmdb); return p && p.imdb === f.imdb ? p : null; };
  for (const fav of favs) {
    const d = byDir.get(norm(fav.name));
    if (!d) continue;
    const src = new Map((d.sources || []).map((s) => [s.id, s]));
    for (const f of d.films || []) {
      if (f.tmdbType !== "movie") continue; // a miniseries is not a film of this catalog
      const sources = f.sources.map((id) => src.get(id)).filter((s) => s && s.confidence in CONFIDENCE);
      if (!sources.length) continue;
      if (directs(detailOf(f), fav, aliases)) continue; // their own film is not a film they love for this catalog (Marco, 11/10/2026)
      let c = films.get(f.imdb);
      if (!c) {
        const detail = detailOf(f);
        const rec = { imdb: f.imdb, tmdb: detail ? f.tmdb : null, slug: f.letterboxd || null, title: detail?.title || f.title, originalTitle: detail?.originalTitle, year: detail?.year || f.year };
        if (isSeen(rec)) { films.set(f.imdb, null); continue; }
        c = { ...rec, detail, score: 0, lovers: [] };
        films.set(f.imdb, c);
      }
      if (c === null) continue; // seen
      const conf = Math.max(...sources.map((s) => CONFIDENCE[s.confidence]));
      const share = fav.weight * conf;
      c.lovers.push({ name: fav.name, label: fav.label, weight: fav.weight, conf, share, sources });
      c.score += share;
    }
  }
  const out = [...films.values()].filter(Boolean);
  for (const c of out) c.lovers.sort((a, b) => b.share - a.share || a.name.localeCompare(b.name));
  return out.sort(byScore);
}
const byScore = (a, b) => b.score - a.score || b.lovers.length - a.lovers.length || String(a.title).localeCompare(String(b.title)) || a.imdb.localeCompare(b.imdb);

/** The Board row: best score first, at most `perDirector` films per lead director (the lover with the largest share). */
function row(films, { size = DEFAULTS.size, perDirector = DEFAULTS.perDirector } = {}) {
  const count = new Map(), out = [];
  for (const c of films) {
    const lead = c.lovers[0].name;
    if ((count.get(lead) || 0) >= perDirector) continue;
    count.set(lead, (count.get(lead) || 0) + 1);
    out.push(c);
    if (out.length >= size) break;
  }
  return out;
}

/** The Discover menu: [{ name, label: "Lynch loves", films }] for each favourite with at least `min` unseen films, by Marco's weight. */
function menu(films, favs, { min = DEFAULTS.menuMin } = {}) {
  const out = [];
  for (const fav of favs) {
    const mine = films.filter((c) => c.lovers.some((l) => l.name === fav.name));
    if (mine.length < min) continue;
    const conf = (c) => c.lovers.find((l) => l.name === fav.name).conf;
    out.push({ name: fav.name, label: `${fav.label} loves`, films: mine.slice().sort((a, b) => conf(b) - conf(a) || byScore(a, b)) });
  }
  return out;
}

const sourceLabel = (s) => s.short || (s.kind === "interview" && /^\d{4}/.test(String(s.date || "")) ? `interview (${String(s.date).slice(0, 4)})` : KIND_LABEL[s.kind] || s.kind);

/**
 * A pair's pick (Marco, 11/10/2026: Closet Picks chosen by two people count as the director's love, with the pair written): the
 * director's name gains "(with Ariane Labed)" when EVERY source through which this director loves this film names a `with`.
 * A film the director also chose alone (a solo source) is the director's own choice and reads without the pair.
 */
function loverName(l) {
  const pair = l.sources.length && l.sources.every((s) => s.with) ? [...new Set(l.sources.map((s) => s.with))] : [];
  return pair.length ? `${l.label} (with ${pair.join(", ")})` : l.label;
}

/**
 * "Loved by Lynch and Scorsese · Sight & Sound 2022 ballot, Criterion Closet": up to three names (+N more), then up to two kinds of source.
 * "Loved by Lanthimos (with Ariane Labed) · Criterion Closet": a pair's pick names the pair (loverName above).
 * `first`: the director whose menu is on screen comes first.
 */
function lovedLine(c, first = null) {
  const lovers = first ? [...c.lovers.filter((l) => l.name === first), ...c.lovers.filter((l) => l.name !== first)] : c.lovers;
  const names = lovers.slice(0, 3).map(loverName);
  const more = lovers.length - names.length;
  const kinds = [...new Set(lovers.flatMap((l) => l.sources.slice().sort((a, b) => CONFIDENCE[b.confidence] - CONFIDENCE[a.confidence]).map(sourceLabel)))].slice(0, 2);
  return `${lovedBy(names, more)}${kinds.length ? ` · ${kinds.join(", ")}` : ""}`; // lib/loved-by.js: the same words as the friends' rows (Marco, 21/10/2026, D2)
}

/** A plan item (lib/rows.js item() shape) + `loved` (the line above) + `trust`. `why`: extra reasons (the taste reasons of the build). */
function toItem(c, { first = null, why = [] } = {}) {
  const d = c.detail;
  return {
    id: c.imdb,
    tmdb: c.tmdb,
    slug: c.slug || undefined,
    title: c.title,
    originalTitle: d?.originalTitle,
    year: c.year,
    runtime: d?.runtime ?? null,
    genres: d?.genres || [],
    directors: (d?.directors || []).map((x) => x.name),
    poster: d?.poster || null,
    va: d?.va || 0,
    vc: d?.vc || 0,
    loved: lovedLine(c, first),
    trust: "director",
    why: why.filter(Boolean),
    overview: d?.overview || "",
    ...require("./pool").cardFacts(d),
  };
}

/**
 * The director half of the one floor exception (decision 5): every film of the file that a favourite director loves through a high or
 * medium source, seen or not (the floor never decides a seen film) → Map tt → { list, trust: "director", why }.
 * Built from the same inputs by build.js and by the learning replay (lib/learning/evaluate.js): the file, the taste model's stats, the
 * config, the accounts Marco follows and the TMDB movie cache (`peek`), read only to know who directed a film (a director's own film is
 * not their love: directs()). build.js fetches the missing records BEFORE calling this, so the vouch and the row read the same cache.
 */
function vouched({ data, stats = [], cfg = {}, following = [], peek = () => null }) {
  const out = new Map();
  if (!data) return out;
  const fav = favorites({ data, stats, cfg, following });
  for (const c of lovedFilms({ data, favorites: fav.list, peek, aliases: cfg.aliases || {} })) out.set(c.imdb, { list: "Loved by your directors", trust: "director", why: lovedLine(c) });
  return out;
}

module.exports = { CONFIDENCE, DEFAULTS, KIND_LABEL, norm, load, validate, shortNames, statFor, favorites, directs, lovedFilms, row, menu, lovedLine, loverName, sourceLabel, toItem, vouched };
