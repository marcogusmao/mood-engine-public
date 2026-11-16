// Text search over the index: what Stremio's global search bar sends as `search=<text>`.
//
// What a query can say, all at once (tokens combine with AND):
//   title, director, a mood word ("nocturnal"), a keyword of the moods ("heartwarming"), a genre, a country ("france",
//   "french"), a list name or the curator's ("cannes", "criterion"), a decade ("90s", "1990s"), a year ("1994"), a length
//   ("90 min", "under 100 min", "over 150 min", "short", "long"), a friend ("gustavo loved", "william wants").
// Ranked by relevance (where in the film the words were found), then by how well it fits your taste.
// A film the build holds back under the music rule (`musicOut`, bit 8) is found only by its NAME: every word of the search is a word of its title, and at least one of them is not a word of the live-show
// vocabulary ("concert", "live", "tour", "music", "documentary" ... alone are terms, not names: they bring a whole genre of films). "bts", "taylor swift", "arena tour" find a film; "korean", "south korea 2020s",
// "concert" and "music documentary" do not. Any other way to reach it (a country, a decade, a genre, a keyword, a mood, a list, a friend) is a cut that recommends, and the rule holds there like in the menus.
//
// Every film's searchable text arrives already normalised in `find` (lib/index-export.js): " title | director | keywords | genres | countries".
// That is what keeps a search to one pass of String.includes over the films instead of normalising thousands of strings per request.

import { cmp, words, shortKey, takenWords } from "./text.js";
import { C } from "./film.js";

const STOP = new Set(["the", "a", "an", "of", "and", "in", "by", "with", "for", "to", "from", "on", "at", "is", "film", "films", "movie", "movies"]);
const LOVED = new Set(["loved", "love", "loves", "liked", "likes", "like", "favorite", "favorites", "favourite", "favourites"]);
const WANTS = new Set(["wants", "want", "wanted", "watchlist", "watchlisted", "saved", "wishlist"]);
const WATCHED = new Set(["watched", "seen", "saw", "rated", "logged"]);
/** A demonym stands for the country words it implies. */
const DEMONYMS = {
  french: "france", japanese: "japan", german: "germany", italian: "italy", british: "united kingdom", american: "united states", canadian: "canada",
  belgian: "belgium", brazilian: "brazil", swedish: "sweden", spanish: "spain", soviet: "soviet union", russian: "russia", korean: "korea", chinese: "china",
  mexican: "mexico", polish: "poland", danish: "denmark", indian: "india", iranian: "iran", argentine: "argentina", argentinian: "argentina", australian: "australia",
  irish: "ireland", dutch: "netherlands", portuguese: "portugal", hungarian: "hungary", turkish: "turkey", greek: "greece", norwegian: "norway", finnish: "finland",
  taiwanese: "taiwan", thai: "thailand", czech: "czech", austrian: "austria", swiss: "switzerland", cuban: "cuba", chilean: "chile", egyptian: "egypt", usa: "united states", uk: "united kingdom",
};
const WEIGHT = { title: 5, director: 4, keyword: 2.5, genre: 2, country: 2, list: 2, mood: 2, friend: 2, other: 1.5 };
const PARTS = ["title", "director", "keyword", "genre", "country"];
/** The words of the live-show vocabulary (lib/pool.js LIVE_KEYWORDS and LIVE_TITLE, and the genres of a music film; a test keeps this list a superset of theirs). Alone, they are a term and not a film's name. */
export const LIVE_WORDS = new Set(["concert", "concerts", "film", "films", "live", "tour", "tours", "touring", "unplugged", "cinemas", "cinema", "music", "musical", "documentary", "documentaries", "performance", "performances", "show", "shows", "stage", "footage", "rock", "session", "sessions"]);
/** A search word that is, or starts like, a word of that vocabulary ("conc", "tou"): a term, not a name. */
const generic = (t) => LIVE_WORDS.has(t) || (t.length >= 3 && [...LIVE_WORDS].some((w) => w.startsWith(t)));

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const prefixOf = (label, t) => words(label).split(" ").some((w) => w.startsWith(t));
// Membership needs no score/position decoding. Match a complete key at a cell boundary.
const hasKey = (cell, key) => !!cell && (cell.startsWith(key) || cell.includes(`,${key}`));
const titleOf = (find = "") => { const at = find.indexOf(" | "); return (at < 0 ? find : find.slice(0, at)).trim(); };

/** "gustavo loved 90s under 100 min" → { decades, runtimeMax, runtimeMin, tokens } (decades and lengths taken out of the text). */
function split(q) {
  let rest = ` ${q} `;
  const out = { decades: [], runtimeMax: null, runtimeMin: null };

  // decades: "90s", "1990s", "00s", "1920s". Two digits: 30s–90s are the 1930s–1990s, 00s/10s/20s are the 2000s–2020s.
  rest = rest.replace(/ (?:(19|20)(\d)0|(\d)0) ?s(?= )/g, (_, c, d, two) => {
    out.decades.push(c ? `${c}${d}0s` : Number(two) >= 3 ? `19${two}0s` : `20${two}0s`);
    return "";
  });
  // lengths. "under 100 min" / "over 150 min" / "90 min" (= at most 90). The unit may be left out after under/over.
  rest = rest.replace(/ (?:under|below|less than|max) (\d{2,3})(?: (?:min|mins|minutes))?(?= )/g, (_, n) => { out.runtimeMax = Number(n) - 1; return ""; }); // "under 90" is less than 90, like the menu entry "Under 90 min"
  rest = rest.replace(/ (?:over|above|more than|longer than|at least) (\d{2,3})(?: (?:min|mins|minutes))?(?= )/g, (_, n) => { out.runtimeMin = Number(n); return ""; });
  rest = rest.replace(/ (\d{2,3}) (?:min|mins|minutes)(?= )/g, (_, n) => { out.runtimeMax = Number(n); return ""; });
  out.tokens = rest.split(" ").filter(Boolean);
  return out;
}

/**
 * index: the parsed index.  raw: what the person typed.  seen: (film) → has the viewer seen it (the film's flag, Marco's, unless the friends' routes hand in the friend's).
 * → { films, … } sorted best first, never a film you have seen. An empty or stop-word-only query finds nothing.
 */
export function search(index, raw, { seen } = {}) {
  const q = words(raw);
  const meta = index.meta || {};
  // A full list label, or its short name (the one the chips and the Lists menu say), is navigation: years/decades/lengths in its name are not filters.
  const byLabel = q ? (index.lists || []).filter(l => words(l.label) === q) : [];
  // by its short name too, unless that is the name or the word of a mood or a genre: then the search stays the mood's (28/10/2026, Marco; text.js takenWords)
  const byShort = q ? (index.lists || []).filter(l => shortKey(l) === q) : [];
  const exactLists = [...byLabel, ...(byShort.length && !takenWords(index.moods, index.moodMenu).has(q) ? byShort : [])].map(l => l.id);
  if (exactLists.length) return index.films.filter(e => !(seen ? seen(e) : e.seen) && !e.musicOut && exactLists.some(id => e.listPos(id) !== undefined))
    .sort((a, b) => (b.rank ?? -9) - (a.rank ?? -9) || cmp(a.name, b.name));
  const s = split(q);
  const people = (index.friends?.people || []).map((name) => ({ name, key: words(name) }));
  const loveStars = meta.loveStars ?? 4;

  // friends: a person's name next to a verb is a filter ("gustavo loved"); a name alone is just a word that may match
  let tokens = s.tokens;
  const verbs = tokens.filter((t) => LOVED.has(t) || WANTS.has(t) || WATCHED.has(t));
  const personOf = (t) => (t.length >= 3 ? people.find((p) => p.key === t || p.key.startsWith(t) || p.key.split(" ").some((w) => w === t)) : undefined);
  const named = tokens.map((t) => ({ t, p: personOf(t) })).filter((x) => x.p);
  const hard = [];
  if (named.length && verbs.length) {
    for (const { p } of named)
      for (const v of verbs) {
        if (LOVED.has(v)) hard.push((e) => !!e.friends && e.friends.seenBy.some(([n, r]) => n === p.name && r != null && r >= loveStars));
        else if (WANTS.has(v)) hard.push((e) => !!e.friends && e.friends.wantBy.includes(p.name));
        else hard.push((e) => !!e.friends && e.friends.seenBy.some(([n]) => n === p.name));
      }
    const used = new Set([...verbs, ...named.map((x) => x.t)]);
    tokens = tokens.filter((t) => !used.has(t));
  }
  for (const d of s.decades) hard.push((e) => e.decade === d);
  const min = meta.minFeatureMinutes ?? 40;
  if (s.runtimeMax != null) hard.push((e) => e.runtime != null && e.runtime >= min && e.runtime <= s.runtimeMax);
  if (s.runtimeMin != null) hard.push((e) => e.runtime != null && e.runtime > s.runtimeMin);

  // what is left are words. Stop words go, unless that would leave nothing to look for.
  const meaningful = tokens.filter((t) => !STOP.has(t) && (t.length > 1 || /\d/.test(t)));
  const wordsLeft = meaningful.length ? meaningful : hard.length ? [] : tokens.filter((t) => t.length > 1 || /\d/.test(t)); // "loved by gustavo": 'by' is not a word to find
  if (!wordsLeft.length && !hard.length) return [];

  const specs = wordsLeft.map((t) => {
    const lists = (index.lists || []).filter((l) => prefixOf(l.label, t)).map((l) => `${l.id}:`);
    const moods = (index.moods || []).filter((m) => prefixOf(m.label, t) || prefixOf(m.name || "", t) || prefixOf(m.alias || "", t)).map((m) => `${m.id}:`);
    const country = DEMONYMS[t] ? ` ${DEMONYMS[t]}` : null;
    const year = /^(19|20)\d\d$/.test(t) ? Number(t) : null;
    const person = personOf(t);
    return { t, needle: ` ${t}`, lists, moods, country, year, person, short: t === "short", long: t === "long" };
  });
  const phrase = tokens.join(" "); // the whole title as typed (stop words and all), minus the filters taken out of it
  const shortMax = meta.shortMaxMinutes ?? 95;

  const hits = [];
  for (const e of index.films) {
    const row = e.r, flags = row[C.flags], find = row[C.find];
    if (seen ? seen(e) : flags & 1) continue; // search is not an exempt catalog: nothing the viewer has seen (Marco's flag; the friend's on /u/<friend>/)
    // The music rule (Marco, 22/10/2026 ~06:40 UTC; review of the same day: a search by country, decade, genre or keyword is a cut like the menus): a film the build holds back is found
    // only by its NAME (every word of the search is in its title and one of them is not live-show vocabulary): "bts", "taylor swift", "arena tour" find it; "korean", "south korea 2020s", "concert" or "music documentary" do not.
    if (flags & 8) {
      const title = ` ${titleOf(find || "")}`;
      if (!(wordsLeft.length && wordsLeft.every((t) => title.includes(` ${t}`)) && wordsLeft.some((t) => !generic(t)))) continue;
    }
    if (hard.length && !hard.every((h) => h(e))) continue;
    let score = 0;
    let parts = null;
    let ok = true;
    for (const sp of specs) {
      let best = 0;
      if (find && find.includes(sp.needle)) {
        parts ??= find.split(" | ").map((p) => p.trim());
        for (let i = 0; i < PARTS.length; i++) {
          const text = parts[i] || "";
          if (!text || !` ${text}`.includes(sp.needle)) continue;
          const exact = ` ${text} `.includes(` ${sp.t} `);
          best = Math.max(best, WEIGHT[PARTS[i]] * (exact ? 1.2 : 1));
        }
      }
      if (sp.lists.length && sp.lists.some((key) => hasKey(row[C.lists], key))) best = Math.max(best, WEIGHT.list);
      if (sp.moods.length && sp.moods.some((key) => hasKey(row[C.moods], key))) best = Math.max(best, WEIGHT.mood);
      if (sp.country && find && find.includes(sp.country)) best = Math.max(best, WEIGHT.country);
      if (sp.year != null && e.year === sp.year) best = Math.max(best, WEIGHT.title);
      if (sp.person && e.friends && (e.friends.seenBy.some(([n]) => n === sp.person.name) || e.friends.wantBy.includes(sp.person.name))) best = Math.max(best, WEIGHT.friend);
      if (sp.short && e.runtime != null && e.runtime >= min && e.runtime <= shortMax) best = Math.max(best, WEIGHT.other);
      if (sp.long && e.runtime != null && e.runtime > 150) best = Math.max(best, WEIGHT.other);
      if (!best) { ok = false; break; }
      score += best;
    }
    if (!ok) continue;
    if (phrase && specs.length) {
      const title = parts ? parts[0] || "" : titleOf(find || "");
      if (title === phrase) score += 10;
      else if (title.startsWith(phrase)) score += 5;
      else if (` ${title} `.includes(` ${phrase} `)) score += 2;
    }
    const rank = e.rank;
    hits.push({ e, rank: rank ?? -9, name: e.name, score: score + 0.3 * clamp(rank ?? -1, -3, 3) });
  }
  hits.sort((a, b) => b.score - a.score || b.rank - a.rank || cmp(a.name, b.name));
  return hits.map((h) => h.e);
}
