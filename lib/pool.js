// The v2 pool and everything cut from it.
//
// The pool is every film you have not seen that sits on your live watchlist, in one of the curated lists, on a
// friend's watchlist or in a friend's top picks, and that has an IMDb id (tt…). One record per tt: a film that is in
// three lists is one film with three tags. Its facts come from the TMDB cache when it has the film, and from the
// Letterboxd page (cache/friends.json) when it does not; a fact neither knows is missing, never guessed, and a
// film with a missing fact is left out of the cut that needs it (the build log counts them).
//
// Pure functions. build.js feeds them the caches; test/v2.test.js feeds them small fakes.

const { bayes, zscore } = require("./util");
const { score, reasons, personEvidence } = require("./taste");

/** "Bia 4.5★ · Ana 4★ · Caio · +3 more": at most `max` names, the rated ones first. */
function namesList(parts, max = 4) {
  const shown = parts.slice(0, max);
  return parts.length > max ? [...shown, `+${parts.length - max} more`].join(" · ") : shown.join(" · ");
}

// The Discover catalogs these rows and cuts are (lib/plan.js DISCOVER ids; a test checks they agree)
const IDS = { lists: "mood-engine-lists", listsUnseen: "mood-engine-lists-unseen", decade: "mood-engine-decade", runtime: "mood-engine-runtime", country: "mood-engine-country", rating: "mood-engine-rating" };

const MIN_FEATURE_MINUTES = 40; // below this a Letterboxd "film" is a short; "Short and good" and the runtime cuts mean feature films
/**
 * Marco, 14/11/2026 ("Keep shorts only in the Short row"): the number lives in ONE place, config.json shortRow.minMinutes (40), and every row that RECOMMENDS a film he has not seen asks
 * isShort() before it takes a film: the mood rows and Tonight (lib/rows.js), the v2 Board's moods, filters and combined rows (lib/board-rows.js), the special rows that recommend (lib/special-rows.js:
 * top-picks, friends-split, untried-directors, actor-week, friends-month), Friends loved, Friends watched this week, Best of your lists, New releases and the Discover cuts (By decade, runtime, country, rating).
 * The rows that SHOW what a source holds keep their shorts: your watchlist, Worth watching again (films you saw), Friends want to see this too, the prize row, the single-list rows, Loved by your
 * directors, Lists, Lists (unseen) and the friends' collections. A film whose runtime is NOT known is not a short (the rule the cuts already had: such a film is counted "without a runtime", never
 * among the shorts), so it stays. A config without the key reads MIN_FEATURE_MINUTES.
 */
const minFeatureMinutes = (cfg) => (cfg && cfg.shortRow && cfg.shortRow.minMinutes != null ? cfg.shortRow.minMinutes : MIN_FEATURE_MINUTES);
const isShort = (minutes, min = MIN_FEATURE_MINUTES) => typeof minutes === "number" && minutes > 0 && minutes < min;
/** The web page's mood picker (data/engine.json `films`, runtime in `r`) without its shorts (Marco, 15/11/2026: it recommends). A film with no runtime stays. */
const dropShortPicks = (films, min = MIN_FEATURE_MINUTES) => (films || []).filter((x) => !isShort(x && x.r, min));

// ── small helpers ────────────────────────────────────────────────────────────

const round2 = (n) => Math.round(n * 100) / 100;
const fmtStars = (r) => `${Number.isInteger(r) ? r : r.toFixed(1)}★`;
const PT_NAMES = { HK: "Hong Kong", MO: "Macau", TW: "Taiwan", SU: "Soviet Union", XC: "Czechoslovakia", XG: "East Germany", YU: "Yugoslavia", XK: "Kosovo", XI: "Northern Ireland" };
// Letterboxd and ICU disagree on a few names; the menu uses one spelling each.
const ALIAS = {
  USA: "United States", UK: "United Kingdom", USSR: "Soviet Union", "Türkiye": "Turkey", "Czech Republic": "Czechia", "Hong Kong SAR China": "Hong Kong",
  "Macao SAR China": "Macau", Macao: "Macau", "Russian Federation": "Russia", "Korea, South": "South Korea", "Korea, North": "North Korea",
  "Bosnia & Herzegovina": "Bosnia and Herzegovina", "State of Palestine": "Palestine", "Palestinian Territories": "Palestine", "Palestinian Territory": "Palestine",
};
const REGIONS = (() => { try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; } })();

/** "FR" → "France", "USA" → "United States", "HK" → "Hong Kong". Also accepts a name already spelled out. */
function countryLabel(x) {
  const s = String(x || "").trim();
  if (!s) return null;
  if (/^[A-Z]{2}$/.test(s)) return PT_NAMES[s] || ALIAS[(REGIONS && REGIONS.of(s)) || s] || (REGIONS && REGIONS.of(s)) || s;
  return ALIAS[s] || s;
}

/** The four facts a cut reads, from a pool record: runtime (min), countries (names), rating {value, origin}, decade. */
const runtimeOf = (rec) => {
  const m = (rec.detail && rec.detail.runtime) || rec.lbRuntime || null;
  return m && m > 0 ? m : null;
};
/**
 * The film's countries (TMDB codes) with its MAIN one first: lib/countries.js mainCountry, the same country the Board's regions read (Marco, 22/10/2026 and 23/10/2026: card, row and flag never disagree;
 * the director's country when she is a producer's citizen or speaks the film's language (not English), else TMDB's origin_country when it names one, else the producer that speaks the film's
 * language: "I Vitelloni", it + [FR, IT], is Italian, not French). Until 22/10/2026 this followed the
 * cover flag's rule (pickCountry) and the regions followed mainIso: Topsy-Turvy read United Kingdom on the card and sat in no British row. A main country that is not among the production
 * countries (a language's home, or an origin the producers do not list) is put in front all the same: it IS the film's country. No main country (no production country, no origin): `codes` as they are.
 */
function mainFirst(codes, lang, origin, directors) {
  const C = require("./countries");
  const main = C.mainCountry({ countries: codes, lang, origin, directors });
  return main ? [main, ...codes.filter((c) => String(c).toUpperCase() !== main)] : codes;
}

/**
 * The two facts a plan item carries for the first lines of its description (lib/describe.js): `countries`, the main ones in English (TMDB's
 * production countries, else the ones of the Letterboxd page) and `cast`, the first five names of the TMDB cast (the description shows three). `d`: a TMDB record or nothing.
 * (The third group of line 2, the film's mood words, is put on the item by build.js from the index.)
 */
const cardFacts = (d, lbCountries) => {
  const codes = (d && d.countries) || [];
  const first = d ? mainFirst(codes, d.lang, d.origin, d.directors) : []; // the main country first; empty only when the record has neither a production country nor an origin
  const list = first.length ? first : lbCountries || [];
  return { countries: [...new Set(list.map(countryLabel).filter(Boolean))].slice(0, 2), cast: ((d && d.cast) || []).map((x) => x && x.name).filter(Boolean).slice(0, 5) };
};
const countriesOf = (rec) => {
  const codes = (rec.detail && rec.detail.countries) || [];
  const list = codes.length ? codes : rec.lbCountries || [];
  return [...new Set(list.map(countryLabel).filter(Boolean))];
};
const ratingOf = (rec) => {
  if (rec.lb != null) return { value: round2(rec.lb), origin: "Letterboxd" };
  const d = rec.detail;
  if (d && d.va > 0 && d.vc > 0) return { value: round2(d.va / 2), origin: "TMDB", raw: d.va };
  return null;
};
/**
 * The year of a film, for the cover, the index (`year`, `decade`) and the catalogs by decade: ONE rule, so they cannot disagree.
 * Marco, 13/10/2026: Letterboxd's year first (`rec.year`: the pool record's, else the film's own Letterboxd page, else the plan item's), TMDB's only as the
 * reserve, and only from the film's OWN record (its `imdb` is the film's `id`): a record of another title lends no year. Before, the index read TMDB first,
 * and `release_date` there is often the date of a later screening (Elvis: The '68 Comeback Special 1968, TMDB 2018): measured against the IMDb dataset,
 * Letterboxd gave the IMDb year for 781 of the 802 films where the two differed (97.8% of the whole index against 90.9% for TMDB first).
 */
const yearOf = (rec) => rec.year || (rec.detail && rec.detail.imdb === rec.id && rec.detail.year) || null;
const decadeOf = (rec) => (yearOf(rec) ? `${Math.floor(yearOf(rec) / 10) * 10}s` : null);
/** 1920s … the decade of `today` (YYYY-MM-DD). Anything older than 1920 is too rare to be a menu entry. */
const decadeLabels = (today) => {
  const out = [];
  for (let y = 1920; y <= Math.floor(Number(String(today).slice(0, 4)) / 10) * 10; y += 10) out.push(`${y}s`);
  return out;
};

// ── the pool ─────────────────────────────────────────────────────────────────

/**
 * entries: [{ slug, tag }] where tag is one of
 *   { type: "watchlist" }
 *   { type: "list", id, name, pos, popular? }          pos = 1-based place in the curator's order
 *   { type: "fwatch", name }                           on a friend's watchlist
 *   { type: "ftop", name, rating }                     a friend's top pick
 * extra: [{ tt, tmdb, detail, title, year, tag }]      films known by TMDB only (watchlist.csv fallback: no Letterboxd slug)
 * view.films: slug → Letterboxd film record from cache/friends.json
 * isSeen(rec): true when you have seen it. detail(rec): the TMDB record from the cache or null.
 * → { pool: Map(tt → rec), stats: { entries, pending, gone, noImdb, seen } }
 */
function buildPool({ entries, extra = [], view, isSeen, detail = () => null }) {
  const pool = new Map();
  const stats = { entries: entries.length + extra.length, pending: 0, gone: 0, noImdb: 0, seen: 0 };
  const take = (rec, tag) => {
    let p = pool.get(rec.id);
    if (!p) {
      p = { ...rec, tags: { watchlist: false, lists: new Map(), friendsWatch: new Map(), friendsTop: new Map(), popular: false } };
      pool.set(rec.id, p);
    }
    if (!p.detail && rec.detail) p.detail = rec.detail;
    const t = p.tags;
    if (tag.type === "watchlist") t.watchlist = true;
    else if (tag.type === "list") { if (!t.lists.has(tag.id)) t.lists.set(tag.id, { name: tag.name, pos: tag.pos }); if (tag.popular) t.popular = true; }
    else if (tag.type === "fwatch") t.friendsWatch.set(tag.name, true);
    else if (tag.type === "ftop") t.friendsTop.set(tag.name, tag.rating);
  };
  const seenTt = new Set(); // a film met through five lists is checked once; and if any page of an IMDb id is seen, the film is
  const unseen = (rec) => {
    if (seenTt.has(rec.id)) return false;
    if (!isSeen(rec)) return true;
    seenTt.add(rec.id);
    pool.delete(rec.id); // taken earlier through another page of the same film
    return false;
  };

  for (const { slug, tag } of entries) {
    const r = view.films[slug];
    if (!r) { stats.pending++; continue; }
    if (r.gone) { stats.gone++; continue; }
    if (!r.imdbId) { stats.noImdb++; continue; }
    const rec = { id: r.imdbId, imdbId: r.imdbId, slug, tmdbId: r.tmdbId || null, canon: r.canon, title: r.title, year: r.year, lb: r.r ?? null, lbCount: r.rn ?? null, lbRuntime: r.rt ?? null, lbCountries: r.c || [] };
    rec.detail = detail(rec);
    if (!unseen(rec)) { stats.seen++; continue; }
    take(rec, tag);
  }
  for (const x of extra) {
    const rec = { id: x.tt, imdbId: x.tt, slug: null, tmdbId: x.tmdb, title: x.title, year: x.year, lb: null, lbCount: null, lbRuntime: null, lbCountries: [], detail: x.detail };
    if (!unseen(rec)) { stats.seen++; continue; }
    take(rec, x.tag);
  }
  return { pool, stats };
}

/**
 * Your taste and the film's quality, as z-scores over the pool, then rank = taste + 0.7 × quality (the same weights
 * as "Your watchlist, best first"). Taste needs the TMDB record: without it the film is neutral (0), it neither gains
 * nor loses. Quality is Letterboxd's average (×2, so it sits on TMDB's 0–10 scale) or TMDB's weighted vote; a film
 * with neither sorts below the average (−1) rather than in the middle.
 */
function rankPool(pool, model) {
  const recs = [...pool.values()];
  const withTaste = [], withQuality = [];
  for (const r of recs) {
    r.contributions = [];
    if (r.detail) { const t = score(r.detail, model); r.tasteRaw = t.score; r.contributions = t.contributions; withTaste.push(r); } else r.tasteRaw = null;
    r.qualityRaw = r.lb != null ? r.lb * 2 : r.detail && r.detail.vc > 0 ? bayes(r.detail.va, r.detail.vc) : null;
    if (r.qualityRaw != null) withQuality.push(r);
  }
  zscore(withTaste, (r) => r.tasteRaw, (r, v) => (r.tasteZ = v));
  zscore(withQuality, (r) => r.qualityRaw, (r, v) => (r.qualityZ = v));
  for (const r of recs) {
    if (r.tasteRaw == null) r.tasteZ = 0;
    if (r.qualityRaw == null) r.qualityZ = -1;
    r.rank = r.tasteZ + 0.7 * r.qualityZ;
  }
  return recs;
}

const byRank = (a, b) => b.rank - a.rank || String(a.title).localeCompare(String(b.title));

// ── items ────────────────────────────────────────────────────────────────────

/** The row item the publisher turns into a Stremio meta. `why` is the list of reasons, shown joined by " • ". */
function toItem(rec, why) {
  const d = rec.detail;
  return {
    id: rec.id, tmdb: rec.tmdbId || (d && d.id) || null, slug: rec.slug || null, canon: rec.canon,
    title: (d && d.title) || rec.title, originalTitle: d && d.originalTitle, year: yearOf(rec),
    runtime: runtimeOf(rec), genres: (d && d.genres) || [], directors: ((d && d.directors) || []).map((x) => x.name),
    poster: (d && d.poster) || null, va: (d && d.va) || 0, vc: (d && d.vc) || 0,
    why: why.filter(Boolean), overview: (d && d.overview) || "", ...cardFacts(d, rec.lbCountries),
  };
}

/** Why a pool film is in the pool: its strongest tag, in the order you would care about. Phrased to follow a name ("on your watchlist"); a plan item's `why`, no longer in the Stremio description since 20/10/2026 (only the reason rows lead with it). */
function sourceWhy(rec) {
  const t = rec.tags, names = (m) => [...m.keys()];
  if (t.watchlist) return "on your watchlist";
  if (t.lists.size === 1) return `in “${[...t.lists.values()][0].name}”`;
  if (t.lists.size > 1) return `in ${t.lists.size} of your lists`;
  if (t.friendsTop.size) return `${names(t.friendsTop).slice(0, 2).join(" & ")} ${t.friendsTop.size > 1 ? "love it" : `rated it ${fmtStars([...t.friendsTop.values()][0])}`}`;
  if (t.friendsWatch.size) return `on the watchlist of ${names(t.friendsWatch).slice(0, 3).join(", ")}`;
  return null;
}

/**
 * The rating a "By rating" bucket was chosen by, when the film's own Letterboxd number is not what shows: TMDB's vote ÷ 2 for a film
 * Letterboxd has no average for. A Letterboxd average needs no note: Stremio shows the rating beside the description (the ★ of the old facts line is gone, 20/10/2026).
 */
const ratingNote = (rec) => {
  const r = ratingOf(rec);
  return r && r.origin === "TMDB" ? `TMDB ${r.raw.toFixed(1)}/10 (≈ ${r.value.toFixed(2)}★), no Letterboxd average` : null;
};
const taste = (rec) => reasons(rec.contributions || [], 1)[0] || null;

// ── the rows that sit on the Board ───────────────────────────────────────────

/** 🎞️ From your lists: the best unseen film across the curated lists; taste + quality + how many lists it is in. */
function fromListsRow(recs, size) {
  const inLists = recs.filter((r) => r.tags.lists.size);
  const sc = (r) => r.rank + 0.5 * Math.log2(r.tags.lists.size);
  return inLists.sort((a, b) => sc(b) - sc(a) || byRank(a, b)).slice(0, size).map((r) => {
    const lead = r.tags.lists.size === 1 ? `in “${[...r.tags.lists.values()][0].name}”` : `in ${r.tags.lists.size} of your lists`;
    return toItem(r, [lead, taste(r)]);
  });
}

/** ⏱️ Short and good: feature films of 95 minutes or less (never a short), taste + quality. */
function shortRow(recs, { max = 95, min = MIN_FEATURE_MINUTES, size = 30 } = {}) {
  const ok = recs.filter((r) => { const m = runtimeOf(r); return m != null && m >= min && m <= max; });
  return ok.sort(byRank).slice(0, size).map((r) => toItem(r, [sourceWhy(r), taste(r)]));
}

// ── the music rule (rule D) and 🆕 New for you ───────────────────────────────

/**
 * What the music rule calls a "music film" (Marco, 22/10/2026, rule D of the measurement of that day; since ~06:40 UTC for every recommendation row, see musicAllowed), read from the TMDB record of the film:
 * genre Music AND (genre Documentary, OR a keyword of a live show, OR a title that says Tour / Live / Concert / Unplugged / In Cinemas).
 * It covers the concert films ("ATEEZ WORLD TOUR", "Taylor Swift | The Eras Tour") and the music documentaries ("Ritas", "It's Never Over, Jeff Buckley").
 * It does NOT cover a film whose TMDB record is missing or has no Music genre (a missing fact is never guessed), nor a film with the Music genre that has no
 * Documentary genre, no live keyword and no such word in its title (Whiplash, La La Land).
 * LIMITS, measured on the caches of 21/10/2026 and pinned in test/new-releases-music.test.js with the real records: the rule reads genres and keywords, it does not know
 * what is fiction. A fiction film that carries the Music genre AND a live keyword IS marked: "Trap" (2024: Crime|Thriller|Horror|Music, keyword "concert"), "A Star Is Born"
 * (2018), "Walk the Line", "The Blues Brothers" (accepted: such a film needs the same evidence to be recommended, and few are recent; narrowing it by the other genres
 * would also drop real concert films such as "Les Misérables: 25th Anniversary in Concert", Music|History). A concert TMDB tags only with Music and a keyword nobody
 * listed ("Apple Music Live: Lady Gaga MAYHEM Requiem", keyword "nostalgic") is found by its title word alone; "Wicked: One Wonderful Night" (Music, "tv special",
 * "musical performance") by the keyword "musical performance"; a concert with neither is NOT marked.
 * Borders: "Noah Kahan: Out of Body" (a tour documentary) is one only because TMDB gives it Music AND Documentary; "Dying for Sex" has no genre in the cache and is
 * not; a documentary about a band that TMDB tags Documentary alone (no Music) is not.
 */
const LIVE_KEYWORDS = new Set(["concert", "concert film", "live performance", "live concert", "live musical performance", "musical performance", "live show", "live music", "music live", "concert footage", "rock concert", "music concert", "live", "touring", "stage performance"]);
const LIVE_TITLE = /\b(tour|live|concert|unplugged|in cinemas)\b/i;
function isMusicFilm(rec) {
  const d = rec.detail;
  const genres = (d && d.genres) || [];
  if (!genres.includes("Music")) return false;
  if (genres.includes("Documentary")) return true;
  if (((d && d.keywords) || []).some((k) => LIVE_KEYWORDS.has(String(k).toLowerCase()))) return true;
  return LIVE_TITLE.test(rec.title || "");
}

/**
 * The evidence from Marco's own Letterboxd that lets a music film be recommended, or null. In this order:
 *  "person"  the taste model names a director he rated in ≥ 2 films, or a cast member in ≥ 3, with a weight above 0.12 (lib/taste.js personEvidence: the same
 *            thresholds as the card's "you rate Paul Thomas Anderson 4.5★ over 11 films");
 *  "watchlist"  the film is on his own watchlist (he chose it);
 *  "list"    the film is in a list whose trust is critic or director (`vouchLists`: the ids of those lists; a fan list grants nothing).
 */
function musicEvidence(rec, vouchLists = new Set()) {
  if (personEvidence(rec.contributions).length) return "person";
  if (rec.tags.watchlist) return "watchlist";
  for (const id of rec.tags.lists.keys()) if (vouchLists.has(id)) return "list";
  return null;
}

/**
 * The music rule as a configuration (Marco, 22/10/2026). `music.needsEvidence` of config.json (Marco's config only) is read when it is exactly `true`; the key of the first
 * version, `newReleases.musicNeedsEvidence` (22/10/2026 ~03:50 UTC, New releases alone), is still read when `music.needsEvidence` is ABSENT, so a config written before the
 * rename keeps its rule; a `music.needsEvidence` that is there decides, whatever the old key says (`false` turns the rule off). `vouchLists`: the ids of the lists whose trust is
 * critic or director (lib/list-signal.js VOUCHES). `exemptMoods` (Marco, 22/10/2026 ~15:15 UTC, "Music 1 of 4": `music.exemptMoods: ["music"]`): the ids of the moods whose OWN menu option shows a music
 * film with no evidence (the mood named Music, "it is the only place where I ask for music when I open the app"); nothing else is exempt, and the gate itself does not know it (it is a question
 * about a film; the exemption is about the surface that asks). A key that is absent is the empty list: the rule holds everywhere, as before. A key that is not a list of the ids of config.json
 * `moods` stops the build (a typo must not quietly turn an exemption off, nor a wrong shape quietly turn it on). → { needsEvidence, vouchLists, exemptMoods }, the options of musicAllowed and musicGate.
 */
function musicOptions(cfg) {
  const { VOUCHES } = require("./list-signal");
  const c = cfg || {}, key = c.music && Object.hasOwn(c.music, "needsEvidence") ? c.music.needsEvidence : c.newReleases && c.newReleases.musicNeedsEvidence;
  return { needsEvidence: key === true, vouchLists: new Set((c.lists || []).filter((l) => VOUCHES.has(l.trust)).map((l) => l.id)), exemptMoods: musicExemptMoods(c) };
}

/** The ids of config.json `music.exemptMoods` as a Set (empty when the key is absent); throws on anything but a list of ids of config.json `moods`. */
function musicExemptMoods(c) {
  if (!c.music || !Object.hasOwn(c.music, "exemptMoods")) return new Set();
  const ids = c.music.exemptMoods, known = Array.isArray(c.moods) ? new Set(c.moods.map((m) => m.id)) : null;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new Error(`config.json music.exemptMoods must be a list of mood ids, got ${JSON.stringify(ids)}`);
  for (const id of ids) if (known && !known.has(id)) throw new Error(`config.json music.exemptMoods: "${id}" is not a mood of config.json`);
  return new Set(ids);
}

/**
 * ONE question for every place that recommends a film (Marco, 22/10/2026 ~06:40 UTC: "extend rule D to ALL the rows of the Board and to the cuts by country and decade"):
 * may this film be recommended? `rec` is a pool record (title, detail, contributions, tags); `options` come from musicOptions. A film that is not a music film is always allowed;
 * a music film is allowed with musicEvidence. With `needsEvidence` false (or no options at all) everything is allowed: the rule is off. The catalogs by country and by decade call this
 * (or the `ok(tt)` of musicGate, which build.js hands to the rows) on every candidate before they cut.
 */
function musicAllowed(rec, { needsEvidence = false, vouchLists = new Set() } = {}) {
  return !needsEvidence || !isMusicFilm(rec) || !!musicEvidence(rec, vouchLists);
}

/**
 * The gate the build hands to the builders of every recommendation row: `ok(tt)` is false for a music film Marco has not seen and has no evidence for. Asked by IMDb id, once per
 * film (the answer is kept). `recOf(tt)` → a pool-like record { title, detail, contributions, tags: { watchlist, lists: Map } } or null (a film the build knows nothing about is
 * allowed: a missing fact is never guessed); `seen(tt)` → true for a film he has seen (Old friends, the diary: a film he watched is not a recommendation, whatever it is).
 * → { on, ok, refused }: `refused` is a Map(tt → record) of the films the rule kept out of a row that asked (the build counts and names them).
 */
function musicGate({ options, recOf, seen = () => false }) {
  const kept = new Map(), refused = new Map();
  const ok = (tt) => {
    if (!options.needsEvidence) return true;
    if (kept.has(tt)) return kept.get(tt);
    let allowed = true;
    if (!seen(tt)) {
      const rec = recOf(tt);
      if (rec && !musicAllowed(rec, options)) { allowed = false; refused.set(tt, rec); }
    }
    kept.set(tt, allowed);
    return allowed;
  };
  return { on: options.needsEvidence, ok, refused };
}

/**
 * The facts musicGate asks, from what build.js holds. → recOf(tt): a pool-like record { title, detail, contributions, tags: { watchlist, lists } } for the film with that IMDb id, or null
 * when nothing known is the film's own record (a missing fact is never guessed).
 *   films            slug → Letterboxd film record (view.films); a page that is `gone` or has no IMDb id is not a film here
 *   lists            [{ id, items: [{ slug }] }] (lib/lists.js): every list that holds the film, whatever its trust (musicEvidence keeps the ones that vouch)
 *   watchlistSlugs   the slugs of his watchlist (the live page, else the CSV)
 *   cands            the candidates { film, watchlist } of the moods (TMDB records found by IMDb id): a film the Letterboxd page does not name by TMDB id is read from here, and `watchlist` counts
 *   peek(tmdbId)     the TMDB cache; model: lib/taste.js learn()
 * The TMDB record is the film's OWN (ownDetail: its IMDb id is the page's), the candidates' first; `contributions` are the taste model's, read only for a music film (a getter).
 */
function musicRecords({ films = {}, lists = [], watchlistSlugs = [], cands = [], peek, model }) {
  const lbOf = new Map();
  for (const r of Object.values(films || {})) if (r && !r.gone && r.imdbId && !lbOf.has(r.imdbId)) lbOf.set(r.imdbId, r);
  const candFilm = new Map(cands.filter((c) => c.film && c.film.imdb).map((c) => [c.film.imdb, c.film]));
  const own = ownDetail(peek);
  const watch = new Set(cands.filter((c) => c.watchlist && c.film && c.film.imdb).map((c) => c.film.imdb));
  for (const slug of watchlistSlugs) if (films[slug] && films[slug].imdbId) watch.add(films[slug].imdbId);
  const inLists = new Map();
  for (const l of lists) for (const it of l.items || []) {
    const tt = films[it.slug] && films[it.slug].imdbId;
    if (tt) (inLists.get(tt) || inLists.set(tt, new Map()).get(tt)).set(l.id, {});
  }
  return (tt) => {
    const film = candFilm.get(tt) || (lbOf.has(tt) ? own(lbOf.get(tt)) : null);
    if (!film) return null;
    return { title: (lbOf.get(tt) && lbOf.get(tt).title) || film.title, detail: film, get contributions() { return score(film, model).contributions; }, tags: { watchlist: watch.has(tt), lists: inLists.get(tt) || new Map() } };
  };
}

/**
 * The films New for you may show: the last two years in the pool, plus everything on Popular this week (whatever its year). The music rule is NOT here any more (it was, from
 * 22/10/2026 ~03:50 to ~06:40 UTC): build.js hands this function the films that pass `recommendable`, the same ones every other row is made from. The order is the caller's.
 */
function newCandidates(recs, { fromYear } = {}) {
  return recs.filter((r) => (yearOf(r) && yearOf(r) >= fromYear) || r.tags.popular);
}

/** 🆕 New for you: films from the last two years in the pool, plus everything on Popular this week; best `rank` first (the music rule has already left its films out of `recs`). */
function newRow(recs, opts = {}) {
  const { size = 30 } = opts;
  return newCandidates(recs, opts).sort(byRank).slice(0, size).map((r) => toItem(r, [r.tags.popular ? "popular on Letterboxd this week" : sourceWhy(r), taste(r)]));
}

/** The options newRow takes, from the build's date: the window of two years. */
function newRowOptions(cfg, { today, size }) {
  return { fromYear: Number(String(today).slice(0, 4)) - 1, size };
}

// ── the cross cuts of Discover ───────────────────────────────────────────────

const RUNTIME_BUCKETS = [
  ["Under 90 min", (m) => m < 90],
  ["90–120 min", (m) => m >= 90 && m <= 120],
  ["120–150 min", (m) => m > 120 && m <= 150],
  ["Over 150 min", (m) => m > 150],
];
const RATING_BUCKETS = [
  ["4.2+", (v) => v >= 4.2],
  ["4.0–4.2", (v) => v >= 4.0 && v < 4.2],
  ["3.8–4.0", (v) => v >= 3.8 && v < 4.0],
  ["Under 3.8", (v) => v < 3.8],
];

/**
 * → { decade, runtime, country, rating }: each a list of { label, items } (empty options are left out), plus
 *   `missing`: how many pool films each cut had to leave out for lacking the fact it reads.
 */
function cuts(recs, { size = 60, countries = 12, minRuntime = MIN_FEATURE_MINUTES, today = "" } = {}) {
  const out = { decade: [], runtime: [], country: [], rating: [] };
  const missing = { decade: 0, outOfRange: 0, runtime: 0, country: 0, rating: 0, shortFilms: 0 };
  // Marco, 14/11/2026 ("Keep shorts only in the Short row"): a short (a known runtime under minRuntime) is in NO cut, the decade, country and rating ones included (until then only the runtime cut left it out)
  const sorted = recs.filter((r) => { if (isShort(runtimeOf(r), minRuntime)) { missing.shortFilms++; return false; } return true; }).sort(byRank);
  const by = (id) => sorted;
  const make = (rec, ...why) => toItem(rec, why);
  const top = (list) => list.slice(0, size);

  // decade: 1920s … the current decade
  const dec = new Map();
  for (const r of by(IDS.decade)) {
    const d = decadeOf(r);
    if (!d) { missing.decade++; continue; }
    (dec.get(d) || dec.set(d, []).get(d)).push(r);
  }
  const labels = decadeLabels(today || "2029-01-01");
  for (const [d, list] of dec) if (!labels.includes(d)) missing.outOfRange += list.length; // before the 1920s, or a year that has not come yet
  for (const label of labels) {
    const list = dec.get(label);
    if (list && list.length) out.decade.push({ label, count: list.length, items: top(list).map((r) => make(r, sourceWhy(r), taste(r))) });
  }

  // runtime
  const byRt = RUNTIME_BUCKETS.map(([label]) => ({ label, list: [] }));
  for (const r of by(IDS.runtime)) {
    const m = runtimeOf(r);
    if (m == null) { missing.runtime++; continue; }
    const i = RUNTIME_BUCKETS.findIndex(([, f]) => f(m));
    if (i >= 0) byRt[i].list.push(r);
  }
  for (const b of byRt) if (b.list.length) out.runtime.push({ label: b.label, count: b.list.length, items: top(b.list).map((r) => make(r, sourceWhy(r), taste(r))) });

  // country: the most frequent ones in the pool. It counts EVERY producer of a film (countriesOf), not its main country: a film whose main country is no producer (Roma: Mexico, 23/10/2026) is cut
  // under its producers, not under the country its card and region say; the same gap as the Worker's hasCountry (BACKLOG.md, 23/10/2026: proposal).
  const byC = new Map();
  for (const r of by(IDS.country)) {
    const cs = countriesOf(r);
    if (!cs.length) { missing.country++; continue; }
    for (const c of cs) (byC.get(c) || byC.set(c, []).get(c)).push(r);
  }
  const common = [...byC].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0, countries);
  for (const [label, list] of common) out.country.push({ label, count: list.length, items: top(list).map((r) => make(r, sourceWhy(r), taste(r))) });

  // rating: Letterboxd's average, or TMDB's vote ÷ 2 when Letterboxd has none (the why says which)
  const byR = RATING_BUCKETS.map(([label]) => ({ label, list: [] }));
  for (const r of by(IDS.rating)) {
    const x = ratingOf(r);
    if (!x) { missing.rating++; continue; }
    const i = RATING_BUCKETS.findIndex(([, f]) => f(x.value));
    if (i >= 0) byR[i].list.push(r);
  }
  for (const b of byR) if (b.list.length) out.rating.push({ label: b.label, count: b.list.length, items: top(b.list).map((r) => make(r, ratingNote(r), sourceWhy(r), taste(r))) });

  return { ...out, missing };
}

// ── 👥 Friends watched this week ─────────────────────────────────────────────

/**
 * week: Map(slug → [{ name, rating, watched }]) from lists.watchedThisWeek(). period: how the reason names the span ("this week"; the v2 Board's month row says "in the last 30 days")
 * Ordered by number of people × their average rating (people who logged it without a rating count as 3.0 for the
 * ordering only; no rating is ever shown that nobody gave), then your taste, then the newest log.
 * eligible(imdb id): the recommendation rule (Marco, 13/10/2026: the row refills what the rule opens); a film it refuses is left out BEFORE the order is decided, so the taste z-scores
 * of the rest are measured without it. Default: everything passes.
 * → { items, stats: { films, pending, gone, noImdb, seen } } and, only when `eligible` refused a film, stats.refused
 */
function weekRow({ week, view, isSeen, tasteScore = () => null, detail = () => null, size = 30, eligible = () => true, period = "this week", minRuntime = 0 }) {
  const stats = { films: week.size, pending: 0, gone: 0, noImdb: 0, seen: 0 };
  const byTt = new Map(); // two Letterboxd pages can be one film: its people are all of theirs, each person once
  for (const [slug, people] of week) {
    const r = view.films[slug];
    if (!r) { stats.pending++; continue; }
    if (r.gone) { stats.gone++; continue; }
    if (!r.imdbId) { stats.noImdb++; continue; }
    const rec = { slug, ...r };
    if (isSeen(rec)) { stats.seen++; continue; }
    if (!eligible(r.imdbId)) { stats.refused = (stats.refused || 0) + 1; continue; } // the recommendation rule (Marco, 13/10/2026: the row refills the place it opens)
    if (minRuntime && isShort((detail(rec) && detail(rec).runtime) || rec.rt, minRuntime)) { stats.shorts = (stats.shorts || 0) + 1; continue; } // Marco, 14/11/2026: a short is in no row that recommends (minRuntime: config.json shortRow.minMinutes; 0 = no floor)
    const c = byTt.get(r.imdbId) || byTt.set(r.imdbId, { rec, people: [] }).get(r.imdbId);
    for (const p of people) {
      const mine = c.people.find((x) => x.name === p.name);
      if (!mine) c.people.push({ ...p });
      else { if (p.rating != null && mine.rating == null) mine.rating = p.rating; if (p.watched > mine.watched) mine.watched = p.watched; }
    }
  }
  const cands = [...byTt.values()].map(({ rec, people }) => {
    const rated = people.filter((p) => p.rating != null);
    const mean = rated.length ? rated.reduce((a, p) => a + p.rating, 0) / rated.length : 3;
    return { rec, people, score: people.length * mean, newest: people.reduce((a, p) => (p.watched > a ? p.watched : a), "") };
  });
  const t = new Map();
  const raw = cands.map((c) => ({ c, v: tasteScore(c.rec) })).filter((x) => x.v != null);
  zscore(raw, (x) => x.v, (x, z) => t.set(x.c.rec.slug, z));
  cands.sort((a, b) => b.score - a.score || (t.get(b.rec.slug) ?? 0) - (t.get(a.rec.slug) ?? 0) || b.newest.localeCompare(a.newest) || String(a.rec.title).localeCompare(String(b.rec.title)));
  const items = [];
  for (const c of cands) {
    const d = detail(c.rec);
    const who = c.people.slice().sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || a.name.localeCompare(b.name)).map((p) => (p.rating != null ? `${p.name} ${fmtStars(p.rating)}` : p.name));
    items.push({
      id: c.rec.imdbId, tmdb: c.rec.tmdbId || (d && d.id) || null, slug: c.rec.slug, canon: c.rec.canon,
      title: (d && d.title) || c.rec.title, originalTitle: d && d.originalTitle, year: c.rec.year || (d && d.year) || null, runtime: (d && d.runtime) || c.rec.rt || null, // Letterboxd's year first, TMDB's as the reserve: the rule of yearOf (22/10/2026, test/card-year.test.js)
      genres: (d && d.genres) || [], directors: ((d && d.directors) || []).map((x) => x.name), poster: (d && d.poster) || null,
      va: (d && d.va) || 0, vc: (d && d.vc) || 0, why: [`watched ${period} by ${namesList(who)}`], overview: (d && d.overview) || "", ...cardFacts(d, c.rec.lbCountries || c.rec.c),
    });
    if (items.length >= size) break;
  }
  return { items, stats };
}

// ── 📂 the curated lists (Discover: inteiras, and only the unseen) ───────────

/**
 * The TMDB record a Letterboxd film record takes its displayed facts from (title, year, runtime, genres, directors, synopsis): the one under the record's
 * `tmdbId` in the cache, and only when it carries the film's OWN IMDb id (`rec.imdbId`), the rule the index (lib/index-export.js) and the covers
 * (lib/cover-facts.js ownRecords) have applied since 13/10/2026. `peek(tmdbId)` is the cache read (lib/tmdb.js).
 * Letterboxd's TMDB id for a miniseries or a TV movie is a TMDB *series* id, and the same number is another film in the movie cache.
 * lib/tmdb-identity.js drops the ids whose cached movie names ANOTHER IMDb id (59 on 20/10/2026) but leaves those whose cached movie has NO IMDb id
 * (3: lib/list-signal.js counts them as refused). Until 20/10/2026 the static rows asked nothing more: tt0204394 (The Iceman Cometh, 1960) was published as
 * TMDB 318693, "Leontyne Price: The Art of Verdi: Aida: Act III", with its synopsis, and tt8101850 (Undone) as 86340, "Unnatural Selection" (a documentary).
 * build.js `shown` and lib/special-rows.js `shown` give this reader to the rows built from a Letterboxd list, a friend's list, the week or month diary and a friend's films.
 * Since 21/10/2026 (Marco: "the ranking also uses only the film's own record") build.js gives it to `buildPool` too, so the pool (its taste and quality in `rankPool`, the runtime,
 * country, rating and genres of `toItem`, `runtimeOf`, `countriesOf`, `ratingOf`, and with them By decade, By country, Short and good; the moods only through the `rank` column of the index) holds the own record or none:
 * a film without one is a film "without a record", as the cache's not-yet-fetched films already are (Letterboxd's runtime, countries and average stand in). The taste of the friends' and the
 * week's rows, and the seen test (`seenRec` of build.js, also the pool's `isSeen`: foreign `tmdbId` and foreign `originalTitle`), still read the raw record (BACKLOG 21/10/2026).
 */
function ownDetail(peek, findOf = null) {
  return (rec) => {
    const d = rec && rec.tmdbId ? peek(rec.tmdbId) : null;
    if (d && rec.imdbId && d.imdb === rec.imdbId) return d;
    // 22/10/2026 (review of friends-cards): when the number Letterboxd names is another film's (or empty), the record that TMDB's /find found for the IMDb id is the film's own, if it carries that IMDb id.
    // `findOf(imdb)` → the TMDB id the cache found for an IMDb id, or null (build.js and lib/special-rows.js hand it in; absent, the reader is what it was)
    const id = findOf && rec && rec.imdbId ? findOf(rec.imdbId) : null;
    const f = id && id !== rec.tmdbId ? peek(id) : null;
    return f && f.imdb === rec.imdbId ? f : null;
  };
}

/**
 * The order a list is SHOWN in, as indexes of `l.items` (Marco, 22/10/2026 ~19:30 UTC: the Beyond the Sight & Sound A-List "por nota média do Letterboxd, maior primeiro").
 * No `order` in config.json: the source's order (the curator's), unchanged. `order: "rating"`: by the film's Letterboxd average, highest first; a film with no average (or not
 * looked up yet, or gone) goes to the end, and among those, and among equal averages, the source's order stays. ONE function for both addons: listCatalogs (the static files)
 * and lib/index-export.js (the position the Worker sorts by) call it, so they cannot disagree. The agreement signal of lib/list-signal.js keeps reading the curator's position.
 */
function listSequence(l, films) {
  const idx = l.items.map((_, i) => i);
  if (l.order !== "rating") return idx;
  const avg = (i) => { const r = films[l.items[i].slug]; return r && !r.gone && typeof r.r === "number" ? r.r : null; };
  return idx.sort((a, b) => {
    const x = avg(a), y = avg(b);
    if (x === null || y === null) return x === y ? a - b : x === null ? 1 : -1;
    return y - x || a - b;
  });
}

/**
 * lists: lib/lists.js refreshLists().lists. For each list, in the order it is SHOWN in (listSequence above: the curator's, or the rating's for `order: "rating"`), up to `size` items:
 *   all    every film with a tt, seen or not
 *   unseen the same minus what you have seen (the position "#N" still counts the whole list, in that same order, unusable films included)
 * stats per list: read, withTt, noImdb, pending, gone, seen, dup. A film twice in a list (two slugs with one IMDb id) is kept at its first place IN THAT ORDER, in the files and in the index alike.
 */
function listCatalogs({ lists, view, isSeen, detail = () => null, size = 300 }) {
  const out = [];
  for (const l of lists) {
    const stats = { read: l.items.length, withTt: 0, noImdb: 0, pending: 0, gone: 0, seen: 0, dup: 0 };
    const all = [], unseen = [], tts = new Set();
    for (const [rank, i] of listSequence(l, view.films).entries()) {
      const it = l.items[i];
      const r = view.films[it.slug];
      if (!r) { stats.pending++; continue; }
      if (r.gone) { stats.gone++; continue; }
      if (!r.imdbId) { stats.noImdb++; continue; }
      if (tts.has(r.imdbId)) { stats.dup++; continue; }
      tts.add(r.imdbId);
      stats.withTt++;
      const rec = { slug: it.slug, ...r };
      const d = detail(rec);
      const item = {
        id: r.imdbId, tmdb: r.tmdbId || (d && d.id) || null, slug: it.slug, canon: r.canon,
        title: (d && d.title) || r.title || it.title, originalTitle: d && d.originalTitle, year: (d && d.year) || r.year || it.year, runtime: (d && d.runtime) || r.rt || null,
        genres: (d && d.genres) || [], directors: ((d && d.directors) || []).map((x) => x.name), poster: (d && d.poster) || null,
        va: (d && d.va) || 0, vc: (d && d.vc) || 0, why: [l.popular ? `#${rank + 1} on Letterboxd this week` : `#${rank + 1} in “${l.name}”`], overview: (d && d.overview) || "", ...cardFacts(d, r.lbCountries || r.c),
      };
      all.push(item);
      if (isSeen(rec)) stats.seen++;
      else unseen.push(item);
    }
    const shown = all, shownUnseen = unseen;
    out.push({ id: l.id, name: l.name, ...(l.short !== undefined ? { short: l.short } : {}), popular: !!l.popular, all: shown.slice(0, size), unseen: shownUnseen.slice(0, size), stats });
  }
  return out;
}

module.exports = {
  buildPool, ownDetail, rankPool, toItem, sourceWhy, taste, fromListsRow, shortRow, newRow, newCandidates, newRowOptions, isMusicFilm, musicEvidence, LIVE_KEYWORDS, LIVE_TITLE, musicOptions, musicAllowed, musicGate, musicRecords, cuts, weekRow, listCatalogs, listSequence,
  countryLabel, cardFacts, runtimeOf, IDS, countriesOf, ratingOf, decadeOf, yearOf, decadeLabels, RUNTIME_BUCKETS, RATING_BUCKETS, MIN_FEATURE_MINUTES, minFeatureMinutes, isShort, dropShortPicks,
};
