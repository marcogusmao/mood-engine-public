// The crowd: everyone you follow on Letterboxd plus the configured friends (51 people on 10/10/2026). For every film in a row it
// counts, over those people:
//
//   seenBy      how many have seen it (it is on their /films/ page, or in their recent diary)
//   friendsAvg  the average of the stars of those who saw it AND rated it (null when none did)
//   wantBy      how many have it on their watchlist and have NOT seen it (a person who both saw it and still has it saved counts as
//               having seen it, once, and not as wanting it: find() leaves out of the wanters everyone who is a viewer, whichever page
//               of the film the watchlist or the history knows)
//
// A film is found through whichever identity the row knows: the Letterboxd slug (and the address it redirects to), the IMDb id of
// any Letterboxd page that was looked up, or the title and year. Looking up every one of the ~20,000 films the crowd has seen would
// take hours, so a person's films that were never looked up are still found by title and year (exact year, so a remake is not
// its original). The people found through different identities are one set: nobody counts twice.
//
// Pure. build.js feeds it viewFriends().crowd and the film records of cache/friends.json.

const { norm } = require("./util");
const { DISCOVER } = require("./plan");

const sKey = (slug) => `s:${slug}`;
const iKey = (tt) => `i:${tt}`;
const tKey = (title, year) => (title && year ? `t:${norm(title)}|${year}` : null);

/**
 * crowd: [{ user, films: Map(slug → { slug, title, year, rating }), watchlist: Map(slug → { slug, title, year }) }]
 * films: slug → Letterboxd film record ({ imdbId, canon, title, year }) from cache/friends.json; a slug not in it was never looked up
 * → { people, find(item) }  where item is { id (tt), slug, canon, title, originalTitle, year } and find returns { seenBy, friendsAvg, wantBy }
 */
function crowdIndex({ crowd, films = {} }) {
  const seen = new Map(); // key → Map(user → rating | null)
  const want = new Map(); // key → Set(user)
  const put = (map, key, make) => (map.get(key) || map.set(key, make()).get(key));
  const keysOf = (slug, title, year) => {
    const rec = films[slug];
    const keys = [sKey(slug)];
    if (rec && rec.imdbId) keys.push(iKey(rec.imdbId));
    if (rec && rec.canon) keys.push(sKey(rec.canon));
    const t = tKey(title || (rec && rec.title), year || (rec && rec.year));
    if (t) keys.push(t);
    return keys;
  };
  for (const p of crowd) {
    for (const f of p.films.values()) {
      for (const k of keysOf(f.slug, f.title, f.year)) {
        const m = put(seen, k, () => new Map());
        if (f.rating != null || !m.has(p.user)) m.set(p.user, f.rating ?? m.get(p.user) ?? null);
      }
    }
    for (const w of p.watchlist.values()) {
      for (const k of keysOf(w.slug, w.title, w.year)) put(want, k, () => new Set()).add(p.user);
    }
  }
  const find = (item) => {
    const keys = [item.slug && sKey(item.slug), item.canon && sKey(item.canon), item.id && iKey(item.id), tKey(item.title, item.year), tKey(item.originalTitle, item.year)].filter(Boolean);
    const viewers = new Map();
    for (const k of keys) for (const [user, rating] of seen.get(k) || []) if (rating != null || !viewers.has(user)) viewers.set(user, rating ?? viewers.get(user) ?? null);
    const wanters = new Set();
    for (const k of keys) for (const user of want.get(k) || []) if (!viewers.has(user)) wanters.add(user);
    const rated = [...viewers.values()].filter((r) => r != null);
    return { seenBy: viewers.size, friendsAvg: rated.length ? rated.reduce((a, r) => a + r, 0) / rated.length : null, wantBy: wanters.size };
  };
  return { people: crowd.length, find };
}

/** tt → the Letterboxd average (0–5) of the page that was looked up for it; the one with a value wins when two pages share a tt. */
function letterboxdAverages(films) {
  const out = new Map();
  for (const r of Object.values(films || {})) if (r && r.imdbId && r.r != null && !out.has(r.imdbId)) out.set(r.imdbId, r.r);
  return out;
}

/** Every item of the plan (Board rows, v2 Board rows when the plan has them, then every Discover option), with the catalog it sits in: [{ item, where, v2? }] (v2: the item is in a row of plan.board2). */
function planItems(plan) {
  const out = [];
  for (const r of plan.board) for (const item of r.items) out.push({ item, where: r.id });
  for (const r of plan.board2 || []) for (const item of r.items) out.push({ item, where: r.id, v2: true });
  for (const c of plan.discover) for (const o of c.options) for (const item of o.items) out.push({ item, where: c.id });
  return out;
}

/**
 * Gives every item of the plan its `ratings`: { lb, imdb, friendsAvg, seenBy, wantBy } (imdb is filled in later, by build.js imdbStep, on the targets of lib/posters.js collectTargets).
 * The same film has the same numbers everywhere: one object per IMDb id, shared by every item that carries it.
 * Items in "By rating" show the Letterboxd average with two decimals (`lbDigits`), because the bucket "4.0–4.2" must never show "4.2".
 */
function attachRatings(plan, { find, lb = new Map() }) {
  // `byTt` (the `numbers` map both index exports consult for a pool film no legacy file shows) holds only the films of the legacy plan:
  // a film that only a v2 Board row carries still gets its shared ratings object (the covers and the v2 row read it, and build.js imdbStep
  // fills its imdb), but the legacy index must not learn its numbers through the Board (legacy parity, 14/10/2026: Demolition, Entourage and
  // Marighella, held by friends-split alone, moved data/index.json). The three counters are on the same legacy basis as `films`.
  const byTt = new Map(), all = new Map();
  let withCrowd = 0, withLb = 0;
  for (const { item, where, v2 } of planItems(plan)) {
    let r = all.get(item.id);
    if (!r) {
      const c = find(item);
      r = { lb: lb.has(item.id) ? lb.get(item.id) : null, imdb: null, friendsAvg: c.friendsAvg, seenBy: c.seenBy, wantBy: c.wantBy };
      all.set(item.id, r);
    }
    if (!v2 && !byTt.has(item.id)) {
      byTt.set(item.id, r);
      if (r.seenBy || r.wantBy) withCrowd++;
      if (r.lb != null) withLb++;
    }
    item.ratings = r;
    if (where === DISCOVER.rating.id) item.lbDigits = 2;
  }
  return { films: byTt.size, withCrowd, withLb, byTt };
}

module.exports = { crowdIndex, letterboxdAverages, planItems, attachRatings };
