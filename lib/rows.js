// Turns the scored pool into Stremio rows. Every row item carries its own "why".

const { fit } = require("./moods");
const { reasons } = require("./taste");
const { seeded, monthYear, zscore } = require("./util");
const { cardFacts, isShort, minFeatureMinutes } = require("./pool");

const fmtStars = (r) => `${Number.isInteger(r) ? r : r.toFixed(1)}★`;

// lists: how much Marco agrees with the film's curated lists (c.lw, 0–1); vouch: in a critic or director list (c.cv). Marco, 11/10/2026:
// both are light and constant (lib/list-signal.js); the browser picker uses the same two (web/selector.js VOUCH, LISTS).
const W = { fit: 1.1, taste: 1.0, quality: 0.55, lists: 0.3, vouch: 0.15 };

function moodRank(c, mood, f) {
  let s = W.fit * Math.min(f.norm, 1.6) + W.taste * c.tasteZ + W.quality * c.qualityZ;
  if (c.lw) s += W.lists * c.lw;
  if (c.cv) s += W.vouch;
  if (c.watchlist) s += 0.35;
  if (c.recCount) s += 0.12 * Math.log2(1 + c.recCount);
  if (c.pins?.includes(mood.id)) s += 10;
  return s;
}

/** Keep variety: at most `perDirector` films by the same director in a row. */
function diversify(list, n, perDirector = 2) {
  const out = [], count = new Map();
  for (const c of list) {
    const d = c.film.directors?.[0]?.id;
    if (d && (count.get(d) || 0) >= perDirector) continue;
    if (d) count.set(d, (count.get(d) || 0) + 1);
    out.push(c);
    if (out.length >= n) break;
  }
  return out;
}

function interleave(lists, n) {
  const out = [], seen = new Set();
  for (let i = 0; out.length < n && lists.some((l) => i < l.length); i++)
    for (const l of lists) if (l[i] && !seen.has(l[i].film.id) && out.length < n) { seen.add(l[i].film.id); out.push(l[i]); }
  return out;
}

/** The reasons behind a pick, kept on the plan item as `why`, phrased to follow a name ("on your watchlist since Aug 2022"); since 20/10/2026 the description does not show them (lib/describe.js description v3), only the reason rows lead with the first one: "you rate … 4.6★ over 9 films". */
function why(c, lead) {
  const parts = [];
  if (lead) parts.push(lead);
  if (c.watchlist && !/watchlist/i.test(lead || "")) parts.push(`on your watchlist${c.watchlistedOn ? ` since ${monthYear(c.watchlistedOn)}` : ""}`);
  parts.push(...reasons(c.contributions, lead ? 1 : 2));
  if (c.seeds?.length && !/because/i.test(lead || "")) parts.push(`because you gave ${c.seeds[0].title} ${fmtStars(c.seeds[0].rating)}`);
  return parts;
}


/**
 * eligible(imdb id) → bool: the recommendation rule (lib/recommendation-quality.js qualifies). Marco, 13/10/2026: every row refills the place the rule opens, up to its cap, so each row
 * below is made from the films that pass it and the later quality step (Q.applyPlan) finds nothing left to remove. `ranked` (the picker, the Moods slices) keeps every film that fits.
 * The default lets everything through (the tests that call buildRows without a rule).
 */
/**
 * Marco, 14/11/2026 (questionnaire, "Bigger pool + 30 days without repeating"): how many of a mood's best films Tonight draws from when config.json says nothing (tonight.depth), and for how many
 * days a film that was in Tonight stays out of it (tonight.noRepeatDays). Until then the draw was over the top TWELVE (Marco, 19/10/2026) and nothing remembered the day before.
 */
const TONIGHT_DEPTH = 40;
const TONIGHT_NO_REPEAT_DAYS = 30;
/**
 * The exponent of Tonight's first-pass draw, `top[floor(rand() ** bias * top.length)]`: 1 is a uniform draw over the mood's top films (tonight.depth), above 1 leans to the very top
 * (it was 1.6 until 19/10/2026), below 1 leans to the bottom. A config without `tonight.bias` (the older fixtures) draws uniformly: Marco's decision of
 * 19/10/2026 is the rule, and a missing key must not bring the old lean back without anyone writing it. A key that is there and is not a positive number stops the build.
 */
function tonightBias(cfg) {
  const b = cfg.tonight?.bias;
  if (b === undefined) return 1;
  if (!Number.isFinite(b) || b <= 0) throw new Error(`config.json tonight.bias must be a positive number (1 = a uniform draw over the top films of each mood), got ${JSON.stringify(b)}`);
  return b;
}
/**
 * Tonight's three numbers, from config.json "tonight": { bias, depth, noRepeatDays }. A config without `depth` or `noRepeatDays` (the older fixtures, a person's config) gets the rule of
 * 14/11/2026 (40 and 30), NOT the one before it (12 and no memory): a missing key must not bring the small pool back without anyone writing it. depth is a whole number from 1; noRepeatDays a
 * whole number from 0, and 0 means no memory at all (nothing held back, no file read or written). Anything else stops the build with the value in the message.
 */
function tonightSpec(cfg) {
  const t = cfg.tonight || {};
  const depth = t.depth === undefined ? TONIGHT_DEPTH : t.depth, noRepeatDays = t.noRepeatDays === undefined ? TONIGHT_NO_REPEAT_DAYS : t.noRepeatDays;
  if (!Number.isInteger(depth) || depth < 1) throw new Error(`config.json tonight.depth must be a whole number from 1 (how many of a mood's best films Tonight draws from; ${TONIGHT_DEPTH} when absent), got ${JSON.stringify(t.depth)}`);
  if (!Number.isInteger(noRepeatDays) || noRepeatDays < 0) throw new Error(`config.json tonight.noRepeatDays must be a whole number from 0 (days a film of Tonight stays out of it; ${TONIGHT_NO_REPEAT_DAYS} when absent, 0 = no memory), got ${JSON.stringify(t.noRepeatDays)}`);
  return { bias: tonightBias(cfg), depth, noRepeatDays };
}

/**
 * exempt (Marco, 22/10/2026 ~15:15 UTC, "Music 1 of 4"): { moods: Set of mood ids, eligible } or absent. For a mood in the set the result also carries `menu[mood id]`, the list that mood's option of
 * the Moods menu shows (Discover, lib/plan.js `menuRows`): the same walk as the row, with the same repetition ceiling read at the same moment, but its films are asked `exempt.eligible` (the
 * quality rule alone) instead of `eligible` (the quality rule and the music rule). The row, Tonight, `ranked` and the repetition count that later moods read are exactly what `eligible` makes
 * them: the exemption lives in that one list. Without `exempt`, `menu` is empty and the result is what it was.
 *
 * tonightShown (Marco, 14/11/2026): Map IMDb id → the last day ("YYYY-MM-DD") the film was in Tonight, holding ONLY the films of the last tonight.noRepeatDays days before `today`
 * (lib/tonight-memory.js lastShown(); the caller cuts the window and never hands over today's own entry). A film in it is not drawn tonight. Absent or empty: no memory, nothing held back.
 * The result also carries `tonightRelief`: the picks the memory moved out of the ordinary draw, [{ id, mood, kind: "deeper" | "moved" | "repeat", from? }] (see the Tonight block below), for the log.
 */
function buildRows({ pool, rewatch, moods, cfg, model, recentSeeds, today, eligible = () => true, exempt = null, tonightShown = new Map() }) {
  const { bias, depth } = tonightSpec(cfg);
  // Marco, 14/11/2026 ("Keep shorts only in the Short row"): a short (a known runtime under config.json shortRow.minMinutes, 40) is in no mood row, the Moods menu, Tonight, Because you loved
  // or Directors you trust; `ranked` keeps it (the index's mood membership and the picker), and the watchlist and Old friends, which show what Marco's own lists hold, keep theirs (lib/pool.js isShort).
  const minMinutes = minFeatureMinutes(cfg);
  const ok = (c) => eligible(c.film.imdb) && !isShort(c.film.runtime, minMinutes);
  const rand = seeded(today);
  const month = Number(today.slice(5, 7));
  const rows = {};
  const usage = new Map(); // a film appears in at most 2 mood rows
  const menu = {};

  // --- mood rows ------------------------------------------------------------
  const ranked = {};
  for (const mood of moods) {
    const fitting = [];
    for (const c of pool) {
      const f = fit(c.film, mood, { lists: c.lists });
      if (!f.ok && !c.pins?.includes(mood.id)) continue;
      fitting.push({ ...c, fitInfo: f, rank: moodRank(c, mood, f) });
    }
    const list = fitting;
    list.sort((a, b) => b.rank - a.rank);
    ranked[mood.id] = list;
    const pickFor = (asks) => {
      const out = [];
      for (const c of diversify(list.filter((c) => asks(c) && !isShort(c.film.runtime, minMinutes)), cfg.sizes.discover * 2)) { // no short in the row nor in the menu list (14/11/2026)
        const u = usage.get(c.film.id) || 0;
        if (u >= 2 && !c.pins?.includes(mood.id)) continue;
        out.push(c);
        if (out.length >= cfg.sizes.discover) break;
      }
      return out;
    };
    const picked = pickFor(ok);
    if (exempt && exempt.moods.has(mood.id)) { // read BEFORE this mood's films count in `usage`, and never written to it: the later moods see the row, not this list
      const exemptOk = (c) => exempt.eligible(c.film.imdb);
      menu[mood.id] = pickFor(exemptOk).map((c) => item(c, why(c, c.pins?.includes(mood.id) ? "pinned pick" : null), { mood: mood.name }));
    }
    // Marco, 13/10/2026: how many of a mood row's films count toward "a film is in at most 2 mood rows" is its own size, sizes.moodRepeatWindow (30). It was
    // sizes.row, which went from 30 to 50 for the rows that show more; the cap must not loosen with it. A config without the key keeps reading sizes.row.
    picked.slice(0, cfg.sizes.moodRepeatWindow ?? cfg.sizes.row).forEach((c) => usage.set(c.film.id, (usage.get(c.film.id) || 0) + 1));
    // the mood's name is the item's `mood`: line 2 of the description starts "Mood: ☀️ Lift me out" (lib/describe.js, description v3, 20/10/2026; the old reason line is gone).
    // Until 13/10/2026 `mood` was the mood's own signals ("film noir, heist") and the line said "Mood: …"; Marco asked for the name instead.
    rows[mood.id] = picked.map((c) => item(c, why(c, c.pins?.includes(mood.id) ? "pinned pick" : null), { mood: mood.name }));
  }

  // --- 🎯 Tonight: one pick per mood, drawn evenly from the top films of each mood (tonight.depth, 40), rotated daily, no film of the last 30 days -------
  const inSeason = moods.filter((m) => m.season?.includes(month)).map((m) => m.id);
  const order = moods.map((m) => m.id).filter((id) => ranked[id]?.some(ok)); // a mood none of whose films passes the rule has no pick tonight
  const forced = inSeason.filter((id) => order.includes(id));
  // Seasonal moods are guaranteed a slot, but never get to lead the row.
  const rest = order.filter((id) => !forced.includes(id)).sort(() => rand() - 0.5);
  const sequence = [...rest];
  forced.forEach((id, i) => sequence.splice(Math.min(sequence.length, 1 + i * 2 + Math.floor(rand() * 3)), 0, id));
  // Marco, 13/10/2026: Tonight holds 10 films, one more than there are moods. The first pass takes one film per mood, by a draw; when sizes.tonight is larger than the moods that have a film,
  // further passes walk the SAME sequence and take the best-ranked film of that mood not taken yet (no draw, so the daily rotation of the other rows is not disturbed), until
  // the row is full or no mood has one left. With sizes.tonight <= the moods, the first pass fills the row and nothing below runs (unless a mood gave up its place: rule 3 below).
  // Marco, 19/10/2026 (questionnaire): the first pass draws EVENLY among the mood's top films. It was `rand() ** 1.6`, which put the mood's #1 in Tonight about one day in four; the exponent is
  // config.json tonight.bias, 1 in production (`rand() ** 1` is `rand()`).
  // Marco, 14/11/2026 (questionnaire, "Bigger pool + 30 days without repeating"): the draw is over the top 40 of each mood (tonight.depth; it was 12), and a film that was in Tonight in the
  // last 30 days (tonight.noRepeatDays; `tonightShown`, from lib/tonight-memory.js) is not a candidate, in the first pass, in the later ones and whether or not it is pinned. In a mood:
  //   1. the candidates are the films of the mood's top `depth` (among those that pass the rule and are not in tonight's row yet) that are NOT in the memory; the first pass draws one of them;
  //   2. relief "deeper": when none of those `depth` is free, the best-ranked free film BELOW them is taken (no draw: the mood is small or its top is all in the memory);
  //   3. relief "moved" (review of 14/11/2026: the decision is "never show a film again within 30 days", so the mood's place gives way before the rule does): when every film of the mood is in
  //      the memory, the mood gets NO film in the first pass; its place is filled by the later passes, which take the best free film of the first mood of the day's sequence that has one;
  //   4. relief "repeat": only when NO mood has a free film left is a film of the memory taken, the one shown longest ago of each mood in turn (the best-ranked of them when two share the day).
  // The later passes take the mood's best free film at any depth (which is rule 1, then rule 2). The row is never shorter than sizes.tonight while the moods hold that many different films
  // that pass the rule, and no film is in it twice. What rule 3 trades: a night can have no film of a mood (and two of another) rather than a film Marco saw in the row less than a month ago.
  // The first pass makes exactly ONE rand() call per mood it visits that still has a film outside tonight's row, whichever rule gives the pick, and a mood that gives up its place (rule 3) makes its
  // call too. So WHEN sizes.tonight >= the number of moods (production: 10 places, 9 moods) the first pass visits every mood whatever the memory holds, the calls are as many as before 14/11/2026,
  // and Old friends, which reads the next numbers, keeps its order of the day. That is the promise, and its condition (second pass of the review, 15/11/2026, N1): with FEWER places than moods a
  // mood that gives up its place lets the first pass reach one mood more, which draws; that day there is one call more, Old friends can change its order, the place goes to that next mood by its
  // ordinary draw (not to "the best free film of the first mood", which is what rule 3 does when every mood was visited) and tonightRelief names no moved place.
  // Measured in test/tonight-memory.test.js, nine moods, one of them wholly in the memory, 40 days: 10 and 9 places, Old friends moved on 0 days; 6 places, on 29.
  const tonight = [], taken = new Set(), tonightRelief = [], waiting = []; // waiting: the moods whose every film was shown, in the day's order: each is owed a place
  const size = cfg.sizes.tonight;
  const free = (c) => !tonightShown.has(c.film.imdb);
  const left = (id) => ranked[id].filter((c) => !taken.has(c.film.id) && ok(c)); // the mood's films that may still enter tonight's row, best first
  const oldest = (list) => list.reduce((a, c) => (tonightShown.get(c.film.imdb) < tonightShown.get(a.film.imdb) ? c : a)); // every film of `list` is in the memory; the first of equal dates stays (the best-ranked)
  const take = (id, pick, kind, from) => {
    taken.add(pick.film.id);
    const mood = moods.find((m) => m.id === id);
    if (kind) tonightRelief.push({ id: pick.film.imdb, mood: id, kind, ...(from ? { from } : {}) });
    // Marco, 13/10/2026: the `mood` of a Tonight film is "Tonight · <the mood's name>" (the description says "Mood: <the mood's name>" since 20/10/2026) (it said "the “…” pick for Tuesday" and ran the personal reasons after it)
    tonight.push(item(pick, why(pick, null), { mood: `Tonight · ${mood.name}` }));
  };
  for (const id of sequence) { // the first pass: one film per mood, by the draw
    if (tonight.length >= size) break;
    const all = left(id);
    if (!all.length) continue;
    const u = rand() ** bias; // the one draw of this mood, made before the memory is looked at
    const top = all.slice(0, depth).filter(free);
    if (top.length) { take(id, top[Math.floor(u * top.length)]); continue; }
    const below = all.slice(depth).find(free);
    if (below) take(id, below, "deeper");
    else waiting.push(id); // every film of the mood was shown in the window: no film of it now; a free film of another mood takes the place in the passes below
  }
  for (let before = -1; tonight.length < size && tonight.length > before;) { // the later passes: the best free film of each mood, no draw
    before = tonight.length;
    for (const id of sequence) {
      if (tonight.length >= size) break;
      const all = left(id), at = all.findIndex(free);
      if (at < 0) continue;
      const from = waiting.shift(); // the place a mood wholly in the memory could not fill, when there is one; else an ordinary later place (the tenth film)
      take(id, all[at], from ? "moved" : at >= depth ? "deeper" : null, from);
    }
  }
  for (let before = -1; tonight.length < size && tonight.length > before;) { // no mood has a free film left and the row is not full: films of the memory, the one shown longest ago of each mood
    before = tonight.length;
    for (const id of sequence) {
      if (tonight.length >= size) break;
      const all = left(id);
      if (all.length) take(id, oldest(all), "repeat");
    }
  }
  rows.tonight = tonight;

  // --- 💛 Because you loved… ------------------------------------------------
  const lists = recentSeeds.map((seed) =>
    pool.filter((c) => c.seedIds?.has(seed.tmdbId) && ok(c))
      .sort((a, b) => b.tasteZ + 0.7 * b.qualityZ - (a.tasteZ + 0.7 * a.qualityZ))
      .slice(0, 6)
      .map((c) => ({ ...c, _lead: `because you gave ${seed.title} ${fmtStars(seed.rating)}${seed.watchedDate ? ` (${monthYear(seed.watchedDate)})` : ""}` }))
  );
  rows.because = interleave(lists, cfg.sizes.because).map((c) => item(c, why(c, c._lead)));

  // --- 🎬 Directors you trust ---------------------------------------------------
  const trusted = [...model.stats.values()]
    .filter((s) => s.type === "director" && s.n >= 2 && s.w > 0.15)
    .sort((a, b) => b.w - a.w)
    .slice(0, cfg.build.directors);
  const dLists = trusted.map((s) => {
    const id = Number(s.key.slice(2));
    return pool.filter((c) => c.film.directors?.some((d) => d.id === id) && ok(c))
      .sort((a, b) => b.qualityZ + 0.5 * b.tasteZ - (a.qualityZ + 0.5 * a.tasteZ))
      .slice(0, 3)
      .map((c) => ({ ...c, _lead: `you rate ${s.label} ${s.avg.toFixed(1)}★ over ${s.n} films` }));
  });
  rows.directors = interleave(dLists, cfg.sizes.directors).map((c) => item(c, why(c, c._lead)));

  // --- 📼 Old friends: loved films you haven't seen in a while, rotated daily ------
  // Marco, 15/11/2026 (questionnaire, "Reserve places by rating"): places reserved per rating (config.json build.rewatchShares: 40 at 5★, 35 at 4.5★, 25 at 4★), drawn inside each group as before
  rows.oldfriends = oldFriendsPicks(rewatch.filter((r) => eligible(r.film.imdb)), { size: cfg.sizes.oldFriends, shares: rewatchShares(cfg), rand })
    .map(({ r }) => item({ film: r.film }, [`you gave it ${fmtStars(r.rating)}`, r.lastSeen ? `last logged ${monthYear(r.lastSeen)}` : null]));

  // --- 📋 Watchlist, best first ------------------------------------------------
  rows.watchlist = pool.filter((c) => c.watchlist && eligible(c.film.imdb)) // a source row: its shorts stay (14/11/2026)
    .sort((a, b) => b.tasteZ + 0.7 * b.qualityZ - (a.tasteZ + 0.7 * a.qualityZ))
    .slice(0, cfg.sizes.watchlist)
    .map((c) => item(c, why(c, `on your watchlist${c.watchlistedOn ? ` since ${monthYear(c.watchlistedOn)}` : ""}`)));

  return { rows, ranked, menu, tonightRelief };
}

/**
 * config.json build.rewatchShares: [{ stars, places }] best rating first (Marco, 15/11/2026: 5★ 40, 4.5★ 35, 4★ 25). Absent: those three. Anything else stops the build.
 */
const REWATCH_SHARES = [{ stars: 5, places: 40 }, { stars: 4.5, places: 35 }, { stars: 4, places: 25 }];
function rewatchShares(cfg) {
  const v = cfg.build && cfg.build.rewatchShares;
  if (v === undefined) return REWATCH_SHARES;
  const ok = Array.isArray(v) && v.length > 0 && v.every((b, i) => b && Number.isFinite(b.stars) && Number.isInteger(b.places) && b.places >= 0 && (i === 0 || b.stars < v[i - 1].stars));
  if (!ok) throw new Error(`config.json build.rewatchShares must be [{ stars, places }] with the ratings in descending order and whole places, got ${JSON.stringify(v)}`);
  return v;
}
/**
 * Worth watching again (Old friends) with places reserved by rating. list: the rewatch films that pass the rule, each { rating, liked }. Every film gets its key as before, rating + 0.25 if liked
 * + rand() * 0.9 (one rand() per film, in the list's order: the draws after this row do not move), and its group: the first share whose `stars` is at or below its rating (a rating between two
 * shares falls in the lower one; under the last, in the last). Each group gives its best `places` by key. A group with fewer films than its places gives the rest to the group just below, then
 * the next below, then the groups above, nearest first (the session's rule, 15/11/2026). The row is the chosen films by key, best first, each once, at most `size`.
 */
function oldFriendsPicks(list, { size, shares = REWATCH_SHARES, rand }) {
  const keyed = list.map((r) => ({ r, k: r.rating + (r.liked ? 0.25 : 0) + rand() * 0.9 }));
  const groupOf = (rating) => { const i = shares.findIndex((b) => rating >= b.stars); return i < 0 ? shares.length - 1 : i; };
  const groups = shares.map(() => []);
  for (const x of keyed) groups[groupOf(x.r.rating)].push(x);
  groups.forEach((g) => g.sort((a, b) => b.k - a.k));
  // the shares are places of a row of their sum (100); a row of another size takes them in proportion, the largest remainders first (ties: the better rating)
  const total = shares.reduce((a, b) => a + b.places, 0) || 1, exact = shares.map((b) => (b.places * size) / total);
  const places = exact.map(Math.floor), avail = groups.map((g) => g.length);
  exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, size - places.reduce((a, n) => a + n, 0)).forEach(([, i]) => places[i]++);
  for (let i = 0; i < places.length; i++) {
    let extra = places[i] - avail[i];
    if (extra <= 0) continue;
    places[i] = avail[i];
    const order = [...Array.from({ length: places.length - i - 1 }, (_, j) => i + 1 + j), ...Array.from({ length: i }, (_, j) => i - 1 - j)];
    for (const j of order) { const room = avail[j] - places[j]; if (room <= 0) continue; const g = Math.min(room, extra); places[j] += g; extra -= g; if (!extra) break; }
  }
  return groups.flatMap((g, i) => g.slice(0, places[i])).sort((a, b) => b.k - a.k).slice(0, size);
}

function item(c, whyParts, extra = {}) {
  const f = c.film;
  return {
    ...extra,
    id: f.imdb,
    tmdb: f.id,
    title: f.title,
    originalTitle: f.originalTitle,
    year: f.year,
    runtime: f.runtime,
    genres: f.genres,
    directors: (f.directors || []).map((d) => d.name),
    poster: f.poster,
    va: f.va,
    vc: f.vc,
    why: whyParts.filter(Boolean),
    overview: f.overview,
    ...cardFacts(f),
  };
}

// ── Friends rows ─────────────────────────────────────────────────────────────
// Built from lib/friends.js's view. Every item is a film with an IMDb id (tt…) that you have not seen.

/** "Bia 4.5★ · Ana 4★ · Caio 4★ · +12 more": the best-rated first, at most `max` names (the crowd is 51 people). */
function peopleList(votes, max = 3) {
  const sorted = votes.slice().sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));
  const shown = sorted.slice(0, max).map((v) => `${v.name} ${fmtStars(v.rating)}`);
  return sorted.length > max ? [...shown, `+${sorted.length - max} more`].join(" · ") : shown.join(" · ");
}
const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
const slugId = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * view         lib/friends.js viewFriends()
 * cfg          config.json (friendRows, sizes)
 * isSeen(rec)  true if you have seen it (rec = { slug, title, year, tmdbId, canon, imdbId })
 * onMyWatchlist(rec)  true if it is on your watchlist
 * tasteScore(rec)     raw taste score from your model, or null when TMDB data is not in the cache
 * detail(rec)  trimmed TMDB record from the cache, or null
 * eligible    eligible(imdb id): the recommendation rule; "Friends loved" is made from the films that pass it (Marco, 13/10/2026: a row refills what the rule opens). The Discover friends options are
 *              direct collections and are not filtered
 * unrecorded   unrecorded({ imdbId, tmdbId }) → bool (lib/tmdb.js noRecord): true when TMDB was asked and has no MOVIE record of the film, which is what its series and episodes are. Marco, 22/10/2026 ~21:40 UTC
 *              ("Esconder séries das fileiras de filmes dos amigos"): such a film is in NO friends row, the Discover collections included (the quality floor still does not govern those: only this one condition does;
 *              the reading of the session for the collections, reversible by passing nothing). Counted per row in stats[id].droppedNoRecord
 * keepEmpty    every friend's Top and Watch together, and every friend list, gets its row even when it is empty tonight
 *              (build.js: the Discover menu is fixed when the addon is installed, so an entry must not come and go with the data)
 * → { rows: { id → items }, meta: [{ id, name, word, kind }], stats: { id → { items, droppedSeen, droppedNoRecord } }, noImdb, noRecord (films left out for having no TMDB movie, each once) }
 */
function buildFriendRows({ view, cfg, isSeen, onMyWatchlist, tasteScore = () => null, detail = () => null, keepEmpty = false, eligible = () => true, unrecorded = () => false }) {
  const fr = cfg.friendRows || {};
  const size = cfg.sizes?.friendsDiscover ?? cfg.sizes?.discover ?? 60;
  const rows = {}, meta = [], stats = {};
  const ownerName = new Map(view.users.map((u) => [u.user.toLowerCase(), u.name]));

  const stat = (id) => (stats[id] ||= { items: 0, droppedSeen: 0, droppedNoRecord: 0 });
  // Only films with an IMDb id can reach a row; `noImdb` counts the ones that were left out for that.
  let noImdb = 0;
  const countedNoImdb = new Set();
  const noRecord = new Set(); // the films left out for having no TMDB movie (`unrecorded`), each once whatever the rows
  const rec = (slug, rowId) => {
    const r = view.films[slug];
    if (!r || r.gone) return null;
    if (!r.imdbId) { if (!countedNoImdb.has(slug)) { countedNoImdb.add(slug); noImdb++; } return null; }
    const full = { slug, ...r };
    if (isSeen(full)) { if (rowId) stat(rowId).droppedSeen++; return null; }
    if (unrecorded({ imdbId: r.imdbId, tmdbId: r.tmdbId || null })) { noRecord.add(r.imdbId); if (rowId) stat(rowId).droppedNoRecord++; return null; } // a series or an episode in TMDB: not in a row of films (22/10/2026)
    return full;
  };

  const tasteZ = (recs) => {
    const raw = new Map();
    for (const r of recs) { const t = tasteScore(r); if (t != null) raw.set(r.slug, { slug: r.slug, t }); }
    const list = [...raw.values()];
    zscore(list, (x) => x.t, (x, v) => (x.z = v));
    return new Map(list.map((x) => [x.slug, x.z]));
  };

  const item = (r, why) => {
    const d = detail(r);
    return {
      id: r.imdbId, tmdb: r.tmdbId || d?.id || null, slug: r.slug, canon: r.canon, title: d?.title || r.title, originalTitle: d?.originalTitle, year: r.year || d?.year || null, // Letterboxd's year first, TMDB's as the reserve: the rule of yearOf in lib/pool.js (22/10/2026, test/card-year.test.js)
      runtime: d?.runtime ?? r.rt ?? null, genres: d?.genres || [], directors: (d?.directors || []).map((x) => x.name),
      poster: d?.poster || null, va: d?.va || 0, vc: d?.vc || 0, why: why.filter(Boolean), overview: d?.overview || "", ...cardFacts(d, r.lbCountries || r.c),
    };
  };
  const add = (id, name, word, kind, items) => {
    items = items.filter((it, i) => items.findIndex((x) => x.id === it.id) === i); // two Letterboxd pages can point at one IMDb id
    if (!items.length && !(keepEmpty && kind !== "love")) return;
    rows[id] = items;
    meta.push({ id, name, word, kind });
    stat(id).items = items.length;
  };
  const byName = (a, b) => String(a.title).localeCompare(String(b.title));

  // 👥 Loved by two or more people you follow (≥ 4★), or by one at ≥ 4.5★ — everyone you follow (view.crowd), not only the configured friends
  const love = fr.love || {};
  {
    const id = "friends-love";
    const by = new Map();
    for (const u of view.crowd || view.users)
      for (const f of u.films.values())
        if (f.rating != null && f.rating >= (love.minStars ?? 4)) (by.get(f.slug) || by.set(f.slug, []).get(f.slug)).push({ name: u.name, rating: f.rating });
    const cands = [];
    for (const [slug, votes] of by) {
      if (votes.length < (love.minFriends ?? 2) && Math.max(...votes.map((v) => v.rating)) < (love.soloStars ?? 4.5)) continue;
      const r = rec(slug, id);
      if (r && eligible(r.imdbId) && !isShort((detail(r) && detail(r).runtime) || r.rt, minFeatureMinutes(cfg))) cands.push({ r, votes, mean: votes.reduce((a, v) => a + v.rating, 0) / votes.length }); // no short (14/11/2026); the friends' collections below keep theirs
    }
    const z = tasteZ(cands.map((c) => c.r));
    cands.sort((a, b) => b.votes.length * b.mean - a.votes.length * a.mean || (z.get(b.r.slug) ?? 0) - (z.get(a.r.slug) ?? 0) || b.mean - a.mean || byName(a.r, b.r));
    add(id, love.name || "👥 Friends loved, you haven't seen", love.word || "Loved", "love",
      cands.slice(0, cfg.sizes?.friends ?? size).map((c) => item(c.r, [`loved by ${peopleList(c.votes)}`]))); // a Board row (the Friends menu leaves it out): sizes.friends, 100 since 14/11/2026, not the Discover cap
  }

  // ⭐ Each friend's top picks: ≥ 4.5★ from them, best rating first, then the most recent
  const top = fr.top || {};
  for (const u of view.users) {
    const id = `friends-top-${slugId(u.user)}`;
    const found = [];
    for (const f of u.films.values()) {
      if (f.rating == null || f.rating < (top.minStars ?? 4.5)) continue;
      const r = rec(f.slug, id);
      if (r) found.push({ r, f });
    }
    const picks = found;
    // Same rating → newer RSS date first; films without one follow in the order of their /films/ page (newest first).
    picks.sort((a, b) => b.f.rating - a.f.rating || (b.f.watched ? 1 : 0) - (a.f.watched ? 1 : 0) || (b.f.watched || "").localeCompare(a.f.watched || "") || a.f.order - b.f.order || byName(a.r, b.r));
    const vars = { name: u.name };
    add(id, fill(top.name || "⭐ {name}'s top picks", vars), fill(top.word || "Top · {name}", vars), "top",
      picks.slice(0, size).map(({ r, f }) => item(r, [`${u.name} gave it ${fmtStars(f.rating)}${f.watched ? ` (watched ${monthYear(f.watched)})` : ""}`])));
  }

  // 🎟️ Films that are on your watchlist and on a friend's
  const ses = fr.session || {};
  {
    const shared = view.users.map((u) => {
      const id = `friends-session-${slugId(u.user)}`;
      const found = [];
      for (const w of u.watchlist.values()) {
        const r = rec(w.slug, id);
        if (r && onMyWatchlist(r)) found.push(r);
      }
      return { u, id, list: found };
    });
    const allRecs = [...new Map(shared.flatMap((s) => s.list).map((r) => [r.slug, r])).values()];
    const z = tasteZ(allRecs);
    const order = (a, b) => (z.get(b.slug) ?? 0) - (z.get(a.slug) ?? 0) || byName(a, b);
    const minShared = ses.minShared ?? 5;
    const alone = keepEmpty ? shared : shared.filter((s) => s.list.length >= minShared);
    for (const s of alone) {
      const vars = { name: s.u.name };
      add(s.id, fill(ses.name || "🎟️ Watch together with {name}", vars), fill(ses.word || "Watch together · {name}", vars), "session",
        s.list.slice().sort(order).slice(0, size).map((r) => item(r, [`on your watchlist and ${s.u.name}'s`])));
    }
    const merged = new Map();
    for (const s of shared.filter((x) => !alone.includes(x) && x.list.length))
      for (const r of s.list) (merged.get(r.slug) || merged.set(r.slug, { r, names: [] }).get(r.slug)).names.push(s.u.name);
    const m = [...merged.values()].sort((a, b) => b.names.length - a.names.length || order(a.r, b.r));
    if (m.length) add("friends-session", ses.mergedName || "🎟️ Watch together", ses.mergedWord || "Watch together", "session",
      m.slice(0, size).map(({ r, names }) => item(r, [`on your watchlist and ${names.map((n) => `${n}'s`).join(", ")}`])));
  }

  // 📂 Friends' public lists, in the owner's order
  const lst = fr.list || {};
  for (const l of view.lists) {
    const id = `friends-list-${slugId(l.owner)}-${slugId(l.slug)}`;
    const owner = ownerName.get(l.owner.toLowerCase()) || l.owner;
    const out = [];
    l.items.forEach((it, i) => {
      const r = rec(it.slug, id);
      if (r) out.push({ r, it: item(r, [`#${i + 1} in “${l.name}” by ${owner}`]) });
    });
    const keptOut = out.map((x) => x.it);
    const vars = { list: l.word || l.name, owner };
    add(id, fill(lst.name || "📂 {list} ({owner})", { list: l.name, owner }), fill(lst.word || "{list} ({owner})", vars), "list", keptOut.slice(0, size));
  }

  return { rows, meta, stats, noImdb, noRecord: noRecord.size };
}

module.exports = { buildRows, oldFriendsPicks, rewatchShares, REWATCH_SHARES, tonightBias, tonightSpec, TONIGHT_DEPTH, TONIGHT_NO_REPEAT_DAYS, buildFriendRows, W, moodRank, diversify, item, why };
