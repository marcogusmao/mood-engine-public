// Reads your Letterboxd history: the CSV export (full history) + the public RSS feed
// (your latest ~50 diary entries, which carry exact TMDB ids). The RSS is what lets
// the nightly build notice a film you watched yesterday and drop it from every row.

const fs = require("fs");
const path = require("path");
const { parseCsv, filmKey, limitedFetch } = require("./util");

function readCsv(dir, rel) {
  const p = path.join(dir, rel);
  return fs.existsSync(p) ? parseCsv(fs.readFileSync(p, "utf8")) : [];
}

const num = (s) => (s === "" || s == null ? null : Number(s));
const year = (s) => (s ? Number(String(s).slice(0, 4)) : null);

/**
 * Returns a unified history:
 *  films: Map<key, { title, year, tmdbId?, rating?, liked, watched, watchlist, lastWatched?, ratedOn?, watchlistedOn?, rewatches }>
 *  diary: [{ key, title, year, rating, watchedDate, rewatch, tmdbId? }]  (export + RSS, newest first)
 */
function loadHistory(exportDir, rssItems = []) {
  const films = new Map();
  const get = (title, yr) => {
    const key = filmKey(title, yr);
    if (!films.has(key)) films.set(key, { key, title, year: yr, liked: false, watched: false, watchlist: false, rewatches: 0 });
    return films.get(key);
  };

  for (const r of readCsv(exportDir, "watched.csv")) get(r.Name, year(r.Year)).watched = true;

  for (const r of readCsv(exportDir, "ratings.csv")) {
    const f = get(r.Name, year(r.Year));
    f.watched = true;
    f.rating = num(r.Rating);
    f.ratedOn = r.Date || null;
  }

  for (const r of readCsv(exportDir, "likes/films.csv")) {
    const f = get(r.Name, year(r.Year));
    f.liked = true;
  }

  const diary = [];
  for (const r of readCsv(exportDir, "diary.csv")) {
    const f = get(r.Name, year(r.Year));
    f.watched = true;
    const wd = r["Watched Date"] || r.Date;
    if (wd && (!f.lastWatched || wd > f.lastWatched)) f.lastWatched = wd;
    if (/yes/i.test(r.Rewatch || "")) f.rewatches++;
    diary.push({ key: f.key, title: f.title, year: f.year, rating: num(r.Rating), watchedDate: wd, rewatch: /yes/i.test(r.Rewatch || "") });
  }

  for (const r of readCsv(exportDir, "watchlist.csv")) {
    const f = get(r.Name, year(r.Year));
    f.watchlist = true;
    f.watchlistedOn = r.Date || null;
  }

  // RSS: newest activity, exact TMDB ids. Overrides/extends the export.
  for (const it of rssItems) {
    const f = get(it.title, it.year);
    f.watched = true;
    if (it.tmdbId) f.tmdbId = it.tmdbId;
    if (it.rating != null) f.rating = it.rating;
    if (it.liked) f.liked = true;
    if (it.watchedDate && (!f.lastWatched || it.watchedDate > f.lastWatched)) f.lastWatched = it.watchedDate;
    if (!diary.some((d) => d.key === f.key && d.watchedDate === it.watchedDate))
      diary.push({ key: f.key, title: f.title, year: f.year, rating: it.rating, watchedDate: it.watchedDate, rewatch: it.rewatch, tmdbId: it.tmdbId });
  }

  // A watched film is no longer "on the watchlist" for recommendation purposes.
  for (const f of films.values()) if (f.watched) f.watchlist = false;

  diary.sort((a, b) => (b.watchedDate || "").localeCompare(a.watchedDate || ""));
  return { films, diary };
}

/**
 * Replaces the watchlist from watchlist.csv with the live one (`items`: [{ slug, title, year }] read from
 * /<you>/watchlist/). A film still on the list keeps the date the CSV had for it; a film that is only in the CSV
 * has been taken off the list since the export and leaves; a film on the live list that you have watched stays off
 * it (the same rule loadHistory applies to the CSV). Returns { kept, added, removed }.
 */
function applyLiveWatchlist(films, items) {
  const dates = new Map();
  let before = 0;
  for (const f of films.values()) if (f.watchlist) { dates.set(f.key, f.watchlistedOn || null); f.watchlist = false; before++; }
  let kept = 0, added = 0;
  for (const it of items) {
    const key = filmKey(it.title, it.year);
    let f = films.get(key);
    if (!f) { f = { key, title: it.title, year: it.year, liked: false, watched: false, watchlist: false, rewatches: 0 }; films.set(key, f); }
    if (f.watched) continue;
    f.watchlist = true;
    f.slug = it.slug;
    if (dates.has(key)) { f.watchlistedOn = dates.get(key); kept++; } else added++;
  }
  return { kept, added, removed: before - kept };
}

/** Fetch and parse the public diary RSS. Never throws: returns [] on any failure (a deadline or a body past the cap, LIMITS.letterboxdRss, included: the build goes on with the export). */
async function fetchRss(user, { fetchImpl = globalThis.fetch, log = console.warn } = {}) {
  try {
    const { res, body } = await limitedFetch("letterboxdRss", fetchImpl, `https://letterboxd.com/${encodeURIComponent(user)}/rss/`, {
      headers: { "User-Agent": "mood-engine/1.0 (personal Stremio addon)" },
    }, { as: "text", log: () => {} }); // the catch below prints the message once, "limit hit letterboxdRss: …" included
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseRss(body);
  } catch (e) {
    log(`  ! Letterboxd RSS unavailable (${e.message}) — using the export only.`);
    return [];
  }
}

function parseRss(xml) {
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
    return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
  };
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const title = tag(b, "letterboxd:filmTitle");
    if (!title) continue; // lists and other non-diary items
    items.push({
      title: decode(title),
      year: Number(tag(b, "letterboxd:filmYear")) || null,
      watchedDate: tag(b, "letterboxd:watchedDate") || null,
      rewatch: /yes/i.test(tag(b, "letterboxd:rewatch")),
      rating: tag(b, "letterboxd:memberRating") ? Number(tag(b, "letterboxd:memberRating")) : null,
      liked: /yes/i.test(tag(b, "letterboxd:memberLike")),
      tmdbId: Number(tag(b, "tmdb:movieId")) || null,
    });
  }
  return items;
}

function decode(s) {
  return s.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

module.exports = { loadHistory, fetchRss, parseRss, applyLiveWatchlist };
