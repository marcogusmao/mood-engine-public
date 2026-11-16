// The rows of the v2 Board that the legacy build does not make (Marco, 13/10/2026, board-final.md: 54 fixed rows). PR2 of the Board; the legacy family never calls this.
//
//   moods of the v2 family alone   ranked like a mood of today (lib/rows.js moodRank) after the `where` gate; the Moods menu serves every film that fits, a Board row the top 100
//   kind "filter"                  decades and regions: every candidate that passes `where`, ranked with no mood at all (fit 0), 2 films per director
//   kind "combine"                 2 to 4 moods with equal shares, interleaved A1 B1 C1 A2 …; no film twice; `boost` and `tune` change the shares and nothing else
//   watchlist                      the 100 added last, most recent first (the order of Letterboxd's own page; the CSV's date when the page was not read)
//
// Shared rules. Size: at most V2_ROW_MAX (100, the Worker's PAGE) films. Floor (Marco, 13/10/2026: every row refills the place the rule opens, up to its cap): a row is filled from the films
// that pass the recommendation rule (`eligible`), so a film the rule refuses does not take a place that a later film could have had; the watchlist too. exclude.films is another thing: the
// v2 watchlist takes its 100 from the candidates before it, so an excluded film leaves a gap (the rule of 10/10, which stands for exclusion). Director: two films by
// the same director at most. Repetition: a film is in at most 2 of the mood and combined rows of the v2 Board, counted over the first sizes.moodRepeatWindow films of each, in the Board's
// order. That ceiling is a second one, next to the legacy one that buildRows keeps for the nine moods of today: the nine are exactly what they were, and the new rows never move them.
// Filters, lists and the friends' rows are outside it.

const { fit, passes } = require("./moods");
const { moodRank, diversify, item, why } = require("./rows");
const { V2_ROW_MAX } = require("./board-shared");
const { monthYear } = require("./util");
const { isShort, minFeatureMinutes } = require("./pool");

const REPEAT = 2; // a film is in at most this many mood or combined rows of the v2 Board

/** Every candidate that passes the mood's `where` and fits it, best rank first: the legacy mood loop of buildRows with the gate in front (a v2 mood has no pins). */
function rankMood(cands, mood) {
  const list = [];
  for (const c of cands) {
    if (mood.where && !passes(c, mood.where)) continue;
    const f = fit(c.film, mood, { lists: c.lists });
    if (f.ok) list.push({ ...c, fitInfo: f, rank: moodRank(c, mood, f) });
  }
  return list.sort((a, b) => b.rank - a.rank);
}

/** Every candidate that passes `where`, ranked with no mood: the fit counts for nothing (norm 0), so taste, quality, lists and the watchlist decide. */
function rankFilter(cands, where, id) {
  return cands.filter((c) => passes(c, where)).map((c) => ({ ...c, rank: moodRank(c, { id }, { norm: 0 }) })).sort((a, b) => b.rank - a.rank);
}

/** The weekday (0 = Sunday) and month (1-12) of a build date, YYYY-MM-DD. */
const dayOf = (today) => ({ weekday: new Date(`${today}T12:00:00Z`).getUTCDay(), month: Number(today.slice(5, 7)) });

/**
 * The weight of each part of a combined row: 1, times the boosts that apply on `today`, and with tune "taste" first the part's weight (L + 1) / (R + 4), L = the films Marco rated 4.5 or more that
 * fit the part, R = all he rated that fit it: a part he loves more often gets a larger share, and a part he has rarely seen is not driven to nothing.
 * parts: [{ id, mood (compiled) }] or, for a part that is a filter, [{ id, mood: null, where }]   def: the row's recipe   rated: [{ film, rating }]   listsOf(tt) → the ids of the lists a film is in
 * → [{ id, weight, note }]  note: what changed the weight, for the log
 */
function partWeights(parts, def, { today, rated = [], listsOf = () => [] }) {
  const { weekday, month } = dayOf(today);
  return parts.map(({ id, mood, where }) => {
    let weight = 1;
    const note = [];
    if (def.tune === "taste") {
      let L = 0, R = 0;
      for (const r of rated) {
        if (!passes({ film: r.film, lbYear: null }, mood ? mood.where : where) || (mood && !fit(r.film, mood, { lists: listsOf(r.film.imdb) }).ok)) continue;
        R++;
        if (r.rating >= 4.5) L++;
      }
      weight = (L + 1) / (R + 4);
      note.push(`taste ${L}/${R}`);
    }
    for (const b of def.boost || []) {
      if (b.part !== id) continue;
      if (b.months && !b.months.includes(month)) continue;
      if (b.weekdays && !b.weekdays.includes(weekday)) continue;
      weight *= b.x;
      note.push(`×${b.x} ${b.weekdays ? "weekday" : "months"}`);
    }
    return { id, weight, note: note.join(", ") };
  });
}

/** Whole shares of `size` in proportion to the weights, the largest remainder winning the leftovers (ties: the earlier part). → [n, …] summing to size */
function shares(weights, size) {
  const total = weights.reduce((a, w) => a + w, 0);
  const exact = weights.map((w) => (w / total) * size);
  const out = exact.map(Math.floor);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const left = size - out.reduce((a, n) => a + n, 0); // counted once: the loop below changes `out`
  for (let k = 0; k < left; k++) out[order[k][1]]++;
  return out;
}

/**
 * The places of a combined row, in order: part p's k-th place is at time (k + 0.5) / share_p, and the places are sorted by that time, a tie going to the earlier part. Equal shares give
 * A1 B1 C1 A2 B2 C2 …; a part with twice the share comes twice as often. → [part index, …]
 */
function weave(share) {
  const slots = [];
  share.forEach((n, p) => { for (let k = 0; k < n; k++) slots.push([(k + 0.5) / n, p]); });
  return slots.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((s) => s[1]);
}

/**
 * The films of a combined row. parts: [{ id, list (ranked), weight }]; size; accept(c) → false for a film the row may not take (the floor, the repetition ceiling).
 * Pass 1 walks the places of weave(): each takes the next film of its part's list that is not in the row, passes accept() and keeps its director under two. A part that runs dry leaves its
 * places empty; pass 2 gives the empty places, one part after the other, to the parts that still have films. → { picked, share, short: { part id → places it could not fill } }
 */
function combine({ parts, size, accept = () => true, perDirector = 2 }) {
  const share = shares(parts.map((p) => p.weight), size);
  const taken = new Set(), byDirector = new Map(), picked = [];
  const at = parts.map(() => 0);
  const pull = (p) => {
    const list = parts[p].list;
    while (at[p] < list.length) {
      const c = list[at[p]++], tt = c.film.imdb, d = c.film.directors?.[0]?.id;
      if (taken.has(tt) || !accept(c) || (d && (byDirector.get(d) || 0) >= perDirector)) continue;
      taken.add(tt);
      if (d) byDirector.set(d, (byDirector.get(d) || 0) + 1);
      return { ...c, _part: parts[p].id };
    }
    return null;
  };
  const short = {};
  for (const p of weave(share)) {
    if (picked.length >= size) break;
    const c = pull(p);
    if (c) picked.push(c); else short[parts[p].id] = (short[parts[p].id] || 0) + 1;
  }
  for (let again = true; again && picked.length < size;) {
    again = false;
    for (let p = 0; p < parts.length && picked.length < size; p++) {
      const c = pull(p);
      if (c) { picked.push(c); again = true; }
    }
  }
  return { picked, share, short };
}

/** The watchlist, the most recently added first. live: Letterboxd's page was read, so `watchlistPos` (0 = the top of the page) is the order; otherwise the CSV's date, newest first, a film with no date on top, ties by title. */
function newestFirst(list, live) {
  const title = (a, b) => String(a.film.title).localeCompare(String(b.film.title));
  const usePosition = live && list.every((c) => Number.isInteger(c.watchlistPos));
  return list.slice().sort(usePosition
    ? (a, b) => a.watchlistPos - b.watchlistPos || title(a, b)
    : (a, b) => (b.watchlistedOn || "9999-99-99").localeCompare(a.watchlistedOn || "9999-99-99") || title(a, b));
}

/**
 * cands          the candidates the moods are ranked over (build.js: after exclude.films), decorated with lbYear, lb, lbCount                  watchlistCands   the watchlist's, BEFORE exclude.films
 * moods          every compiled mood of the v2 family            legacy   Set of the ids of the nine moods of today        ranked   buildRows()'s ranked lists, by mood id
 * spec           lib/board.js parse()                              cfg      config.json (sizes)       today  YYYY-MM-DD
 * eligible(tt)   the recommendation rule (lib/recommendation-quality.js qualifies on the film's identity)
 * rated          [{ film, rating }] what Marco rated (for tune "taste")       listsOf(tt)  the lists a film is in       liveWatchlist  true when Letterboxd's page was read
 * → { ranked: { mood id → ranked list } for the moods the v2 family adds, rows: { row id → items } for the rows it makes itself, report: [{ id, kind, count, note? }] }
 */
function buildBoardRows({ cands, watchlistCands = [], moods, legacy, ranked: legacyRanked, spec, cfg, today, eligible = () => true, rated = [], listsOf = () => [], liveWatchlist = false }) {
  const size = Math.min(cfg.sizes?.discover ?? V2_ROW_MAX, V2_ROW_MAX);
  const window = cfg.sizes?.moodRepeatWindow ?? cfg.sizes?.row ?? 30;
  // Marco, 14/11/2026 ("Keep shorts only in the Short row"): the mood, filter and combined rows take no short (a known runtime under config.json shortRow.minMinutes); the watchlist keeps its shorts
  const minMinutes = minFeatureMinutes(cfg);
  const feature = (c) => !isShort(c.film.runtime, minMinutes);
  const byId = new Map(moods.map((m) => [m.id, m]));
  const ranked = {}; // the moods only the v2 family has, over every candidate: their Moods menu slice is all of it
  for (const m of moods) if (!legacy.has(m.id)) ranked[m.id] = rankMood(cands, m);
  const partLists = {}; // the filters that are parts of a combined row, ranked once
  const listOf = (id) => legacyRanked[id] || ranked[id] || partLists[id] || (partLists[id] = rankFilter(cands, spec.rows[id].where, id));

  const usage = new Map(); // film (TMDB id) → how many mood or combined rows of the v2 Board it is in (the first `window` films of each)
  const room = (c) => (usage.get(c.film.id) || 0) < REPEAT;
  const count = (picked) => picked.slice(0, window).forEach((c) => usage.set(c.film.id, (usage.get(c.film.id) || 0) + 1));
  const rows = {}, report = [];
  const made = (id, kind, items, note) => { rows[id] = items; report.push({ id, kind, count: items.length, ...(note ? { note } : {}) }); };

  for (const e of spec.entries) {
    if (e.series || e.place === "menu") continue;
    const id = e.id, def = spec.rows[id];
    if (def && def.kind === "filter") {
      const picked = diversify(rankFilter(cands, def.where, id).filter((c) => eligible(c.film.imdb) && feature(c)), size);
      made(id, "filter", picked.map((c) => item(c, why(c, null))));
    } else if (def && def.kind === "combine") {
      const parts = partWeights(def.parts.map((p) => (byId.has(p) ? { id: p, mood: byId.get(p) } : { id: p, mood: null, where: spec.rows[p].where })), def, { today, rated, listsOf });
      const { picked, share, short } = combine({ parts: parts.map((p) => ({ id: p.id, weight: p.weight, list: listOf(p.id) })), size, accept: (c) => eligible(c.film.imdb) && feature(c) && room(c) });
      count(picked);
      const note = parts.map((p, i) => `${p.id} ${share[i]}${p.note ? ` (${p.note})` : ""}${short[p.id] ? ` — ${short[p.id]} places it could not fill` : ""}`).join(" · ");
      made(id, "combine", picked.map((c) => item(c, why(c, null), { mood: c.fitInfo && c.fitInfo.hits.length ? c.fitInfo.hits.join(", ") : undefined })), note);
    } else if (id === "watchlist") {
      const picked = newestFirst(watchlistCands.filter((c) => eligible(c.film.imdb)), liveWatchlist).slice(0, Math.min(cfg.sizes?.watchlist ?? V2_ROW_MAX, V2_ROW_MAX));
      made(id, "watchlist", picked.map((c) => item(c, why(c, `on your watchlist${c.watchlistedOn ? ` since ${monthYear(c.watchlistedOn)}` : ""}`))), liveWatchlist ? "the order of Letterboxd's page" : "the CSV's date, newest first");
    } else if (byId.has(id) && !legacy.has(id)) {
      const picked = [];
      for (const c of diversify(ranked[id].filter((x) => eligible(x.film.imdb) && feature(x)), size * 2)) {
        if (!room(c)) continue;
        picked.push(c);
        if (picked.length >= size) break;
      }
      count(picked);
      made(id, "mood", picked.map((c) => item(c, why(c, null), { mood: c.fitInfo.hits.length ? c.fitInfo.hits.join(", ") : undefined })));
    }
  }
  return { ranked, rows, report };
}

module.exports = { buildBoardRows, rankMood, rankFilter, partWeights, shares, weave, combine, newestFirst, dayOf, REPEAT };
