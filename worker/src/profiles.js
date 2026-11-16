// Profiles (Marco, 11/10/2026): six addresses, one per Nuvio profile, each with its own manifest, name and rows.
//
//   GET /p/<profile>/manifest.json
//   GET /p/<profile>/catalog/<type>/<id>[/<extras>].json
//   GET /p/<profile>/subtitles/…                         the same subtitles as the old address
//
// The old address, /manifest.json and everything under it, is left exactly as it was (Marco, 11/10/2026: "keep it the same and make six
// new addresses"; test/profiles.test.js compares it with the manifest of 8226964). Decisions are in the stremio repo,
// docs/2026-10-11-perfis-e-categorias.md (1–12) and this repo's worker/README.md "Profiles" (13 onwards).
//
// What a profile row is:
//   board      a Board row of the index as it is (Directors you trust, Loved by your directors; every row of the Marco profile)
//   mood       the mood's Board row as it is, under its new dry name (decision 10)
//   tonight    six films from the profile's moods only, drawn HERE: each pick from the top 12 of one mood, rotated daily, no memory of earlier days, the moods
//              taking turns (Marco, 11/10/2026: six films, the moods taking turns); line 2 of each card names the mood the pick was DRAWN for, in
//              the profile's name for it (Marco, 21/10/2026 ~19:40 UTC, C: `context.drawn`, worker/src/meta.js compose), not the film's best fit
//   watchlist  your watchlist, films that fit one of the profile's moods, best first (taste + 0.7 × quality as the index writes them: the
//              formula of the Board's row, not its exact order, which the build computes on its own unrounded scores)
//   short      "Under 100 min": features (index meta minFeatureMinutes, 40) of 100 minutes or less that fit one of the profile's moods, best
//              rank first (Marco, 11/10/2026: "cortar em 100, como o nome diz"; the old address's "Short and good" stays at 95)
//   theme      every film of the lists of one theme (What it is), best rank first
//   lists      the films of one list (or a few, the first list first), in the curator's order: the two Criterion Closet rows
//              (Marco, 11/10/2026: two rows, Most picked and All picks)
// "Fits a mood" is the index's own membership (the build wrote the film under that mood: film.mood(id)), the same test as the Moods menu.
// Rows built here from the pool (tonight, watchlist, short, theme) obey the recommendation rule (the build's `eligible`), like Moods and Explore; tonight, short and theme also obey the music rule
// (`recommendable`: eligible and not held back, Marco, 22/10/2026 ~06:40 UTC; the watchlist row cannot hold a held-back film: a film on his watchlist is its own evidence);
// rows built from curators' lists in their order (lists, Who vouches) are exempt, like Lists. None of them ever shows a film you have seen.

import { LIST_NAMES, GROUPS, THEMES, byName } from "./list-names.js";
import { cmp } from "./text.js";
import { C } from "./film.js";

export const PROFILE_VERSION = "3.2.1"; // 3.2.0 until 24/10/2026; 3.2.1 (Marco, 24/10/2026) so that "Refresh addon" in each Nuvio profile renews the menus with the eight lists of 23/10/2026

export const SHORT_MAX = 100; // "Under 100 min" (Marco, 11/10/2026)

/**
 * The Marco profile's other Board rows under dry names, no emoji, like the five other profiles (Marco, 11/10/2026: "nomes secos como nos
 * outros perfis"). "Short and good" keeps its name: it is the Board's row of 95 minutes or less, not the profiles' Under 100 min.
 * A Board row added later and missing here loses its leading emoji (dryName).
 */
export const BOARD_NAMES = {
  tonight: "Tonight",
  watchlist: "Watchlist",
  "my-series": "My series",
  fromlists: "From your lists",
  "friends-love": "Friends loved",
  "friends-week": "Friends this week",
  short: "Short and good",
  because: "Because you loved",
  newforyou: "New for you",
  directors: "Directors you trust",
  "directors-loved": "Loved by your directors",
  oldfriends: "Old friends",
};
/** "🎯 Tonight" → "Tonight": the leading emoji (with its variation selector and joiners) and the space after it go. */
export const dryName = (name) => String(name).replace(/^[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u200d\ufe0f\s]+/u, "").replace(/…$/, "");

/** Decision 10: the moods' rows under dry English names, no emoji. */
export const MOOD_NAMES = {
  lift: "Warm and funny",
  escape: "Pure entertainment",
  reinvent: "Identity and reinvention",
  letin: "Cathartic drama",
  night: "Neon and tension",
  wicked: "Art-house horror",
  wander: "World cinema",
  music: "Music films",
  slow: "Slow cinema",
};

const slug = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const R = {
  tonight: () => ({ kind: "tonight", id: "tonight", name: "Tonight" }),
  watchlist: () => ({ kind: "watchlist", id: "watchlist", name: "Watchlist" }),
  short: () => ({ kind: "short", id: "short", name: "Under 100 min" }),
  mood: (mood) => ({ kind: "mood", id: mood, mood, name: MOOD_NAMES[mood] }),
  theme: (theme, name = theme) => ({ kind: "theme", id: `theme-${slug(theme)}`, theme, name }),
  board: (id, name) => ({ kind: "board", id, name }),
  lists: (id, name, lists) => ({ kind: "lists", id, name, lists }),
};

/**
 * The six profiles (decision 9; names ≤ 20 characters, the Nuvio TV limit). `moods`: the moods whose films the profile's Tonight, Watchlist
 * and Under 100 min may show (null: no mood filter). `rows`: the Board, in order; null for Marco, whose Board is the index's, all of it.
 */
export const PROFILES = new Map([
  ["marco", { name: "Marco", moods: null, rows: null }],
  ["light", { name: "Light and fun", moods: ["lift", "escape", "music"], rows: [R.tonight(), R.mood("lift"), R.mood("escape"), R.mood("music"), R.theme("Comedy & comfort", "Comedy & comfort (lists)"), R.theme("Action & heist", "Action & heist (lists)"), R.short(), R.watchlist()] }],
  ["heavy", { name: "Heavy drama", moods: ["letin", "reinvent"], rows: [R.tonight(), R.mood("letin"), R.mood("reinvent"), R.theme("Heavy drama", "Heavy drama (lists)"), R.theme("Romance", "Romance (lists)"), R.short(), R.watchlist()] }],
  ["night", { name: "Night and horror", moods: ["night", "wicked"], rows: [R.tonight(), R.mood("night"), R.mood("wicked"), R.theme("Noir & night", "Noir & night (lists)"), R.theme("Horror", "Horror (lists)"), R.theme("Halloween"), R.short(), R.watchlist()] }],
  ["world", { name: "World and slow", moods: ["wander", "slow"], rows: [R.tonight(), R.mood("wander"), R.mood("slow"), R.theme("Asian cinema"), R.theme("Brazilian cinema"), R.board("directors", "Directors you trust"), R.watchlist()] }],
  ["critics", { name: "Critics & directors", moods: null, rows: [R.board("directors-loved", "Loved by your directors"), R.board("directors", "Directors you trust"), R.theme("All-time canon"), R.theme("21st century"), R.theme("1970s"), R.theme("1980s–90s"), R.theme("Classic Hollywood"), R.lists("closet-most-picked", "Criterion Closet · Most picked", ["tp03m"]), R.lists("closet-all-picks", "Criterion Closet · All picks", ["snFyM"])] }],
]);

/** The profile for an address segment, or null. Only the six: "__proto__", "Marco" or "" are not profiles. */
export const profileOf = (key) => (PROFILES.has(key) ? { key, ...PROFILES.get(key) } : null);

/** Who vouches (decision 3): one Discover catalog per group, its required menu the group's lists by their new names. */
export const VOUCH = GROUPS.map((group) => ({ id: `vouch-${slug(group)}`, name: `Who vouches · ${group}`, group }));
export const WHAT = { id: "what-it-is", name: "What it is" };

/** The lists of a group that the index has, A to Z by name (the menu is read on a TV: alphabetical is the order you can scan). */
export const listsOfGroup = (index, group) => { const have = new Set((index.lists || []).map((l) => l.id)); return LIST_NAMES.filter((l) => l.group === group && have.has(l.id)).sort((a, b) => byName(a.name, b.name)); };
/** The ids of the lists of a theme that the index has. */
export const listsOfTheme = (index, theme) => { const have = new Set((index.lists || []).map((l) => l.id)); return LIST_NAMES.filter((l) => l.themes.includes(theme) && have.has(l.id)).map((l) => l.id); };
/** The themes that have at least one list in the index, in menu order. */
export const themesOf = (index) => THEMES.filter((t) => listsOfTheme(index, t).length);

// ── Tonight ──────────────────────────────────────────────────────────────────

/** The build's generator (lib/util.js seeded): the same date gives the same draw on every isolate. */
export function seeded(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353), (h = (h << 13) | (h >>> 19));
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const TONIGHT_SIZE = 6; // the profiles' own Tonight (PRODUCT.md decision 13): six, whatever config.json sizes.tonight says for the Board
const TONIGHT_TOP = 12; // each pick comes from the top 12 of its mood. This Worker's own number: it is not read from the index, and the Board's Tonight (the build's draw) has a window of its own
// Marco, 19/10/2026 (questionnaire; PR #47): the profiles' Tonight draws EVENLY among the top 12 of each mood (the questionnaire decided the same for the Board's Tonight; what the build draws from, how, and what it remembers is the build's and is not stated here). The
// exponent of `rand() ** TONIGHT_BIAS`; the index does not carry it, so it is this constant (it was 1.6, a lean to the very top). Keep the `**` even at 1:
// the draw must stay ONE rand() call per pick, or every later pick (and every other day's order) moves.
const TONIGHT_BIAS = 1;
const SAO_PAULO_MS = -3 * 3600e3; // UTC−3 all year: Brazil has had no daylight saving time since 2019 (Decree 9,772 of 25/04/2019)

/** "2026-10-11": the day in São Paulo, the day Tonight rotates on. Not Intl.DateTimeFormat: a cold isolate pays ~10 ms to start it (text.js cmp). */
export const dayOf = (ms) => new Date(ms + SAO_PAULO_MS).toISOString().slice(0, 10);

/**
 * Six picks from `moods`, with the moods taking turns until there are six: the order of the moods is
 * drawn once a day, each pick comes from the top 12 of its mood (best mood rank first, unseen and recommendable) drawn evenly (TONIGHT_BIAS 1), and a
 * film picked once is not picked again among the six. A mood with nothing left is skipped; fewer than six when the moods run out.
 * No memory: nothing of an earlier day is read, so a film can be picked again the next day. This is all of the profiles' Tonight; the Board's Tonight is drawn by the build, by the build's rules.
 * → [{ e, mood }]: each pick and the id of the mood it was drawn for (Marco, 21/10/2026 ~19:40 UTC, C: line 2 of its card names THAT mood, see profileRow).
 */
export function tonightPicks(films, moods, { day, seedKey = "" }) {
  const rand = seeded(`${day}|${seedKey}`);
  const ranked = new Map(moods.map((m) => {
    const fit = []; // the mood's rank read once per film: e.mood() takes its column apart on every call
    for (const e of films) { const v = e.mood(m); if (v) fit.push([e, v[1]]); }
    return [m, fit.sort((a, b) => b[1] - a[1] || cmp(a[0].tt, b[0].tt)).map(([e]) => e)];
  }));
  const order = moods.slice();
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const out = [], taken = new Set();
  for (let round = 0; out.length < TONIGHT_SIZE; round++) {
    let added = 0;
    for (const m of order) {
      if (out.length >= TONIGHT_SIZE) break;
      const top = ranked.get(m).filter((e) => !taken.has(e.tt)).slice(0, TONIGHT_TOP);
      if (!top.length) continue;
      const pick = top[Math.floor(rand() ** TONIGHT_BIAS * top.length)];
      taken.add(pick.tt);
      out.push({ e: pick, mood: m });
      added++;
    }
    if (!added) break;
  }
  return out;
}
/**
 * The profile's name for each of its moods, by the name the BUILD writes after "Mood:" for that mood in this index (its `moods[].name`: the name of the mood's Board row when it has one, else the mood's own; lib/best-mood.js) → Map(build's name → profile's name).
 * Marco, 21/10/2026 ~22:15 UTC: a profile has ONE name per mood in every row it serves ("Neon and tension" for 🌃 Night drive in its Tonight, Under 100 min, Watchlist, themes and Board rows alike). A profile with no moods (Marco, Critics & directors) has none.
 */
export function relabelOf(profile, index) {
  const out = new Map();
  for (const id of (profile && profile.moods) || []) {
    const m = ((index && index.moods) || []).find((x) => x.id === id);
    if (m && m.name && MOOD_NAMES[id]) out.set(m.name, MOOD_NAMES[id]);
  }
  return out;
}
/** The six films of tonightPicks(), without the mood each was drawn for. */
export const tonight = (films, moods, opts) => tonightPicks(films, moods, opts).map((p) => p.e);

// ── a profile row ────────────────────────────────────────────────────────────

const fitsAny = (moods) => (e) => moods.some((m) => e.mood(m) !== undefined);
const unseenEligible = (e) => !e.seen && e.eligible;
/** Unseen and recommendable: eligible, not held back by the music rule and not a short (film.js `recommendable`; the shorts since 15/11/2026). Tonight, Under 100 min and the themes recommend; the watchlist and the lists show what he chose or what a curator listed, shorts included. */
const unseenRecommendable = (e) => !e.seen && e.recommendable;

/** The row's name starts the reason line of its films (Marco, 13/10/2026), the way a Board row's own text does. */
const named = (row) => (row.name ? { name: row.name } : {});

/**
 * The films of a row the profile builds itself (tonight, watchlist, short, theme, lists, a Who vouches list) → { entries, context } in order,
 * before any page is cut. `films`: the films of the file this row reads (the moods piece, or the union of the list pieces). `keep`: the four
 * optional menus, when the catalog has them (What it is); identity otherwise. No film appears twice.
 */
export function profileRow(row, films, { profile, meta = {}, day, keep = (l) => l }) {
  const moods = profile.moods || [];
  const once = (list) => { const seen = new Set(); return list.filter((e) => !seen.has(e.tt) && seen.add(e.tt)); };
  if (row.kind === "tonight") {
    // Marco, 21/10/2026 ~19:40 UTC (questionnaire, C): line 2 of a Tonight pick names the mood it was DRAWN for, not the mood the film fits best (the general text's label), the way the Board's Tonight does ("Tonight · <mood>", lib/rows.js);
    // in the profile's own name for that mood ("Warm and funny"), the one its mood row shows. Since Marco's answer of 21/10/2026 ~22:15 UTC EVERY row of the profile says that name for a mood of the profile (relabelOf below, applied by
    // worker/src/meta.js compose to the rows built here and to the Board rows the profile serves): the label of Under 100 min, Watchlist, a theme, Closet and What it is is the profile's name too, and a label that names a mood the profile does not have stays as the build wrote it.
    const picks = tonightPicks(films.filter(unseenRecommendable), moods, { day, seedKey: profile.key });
    return { entries: picks.map((p) => p.e), context: { ...named(row), drawn: new Map(picks.map((p) => [p.e.tt, MOOD_NAMES[p.mood]])), drawnMood: new Map(picks.map((p) => [p.e.tt, p.mood])) } }; // drawnMood: the same by mood id, for the card's first chip (worker/src/meta.js cardLinks; Marco, 28/10/2026)
  }
  if (row.kind === "watchlist") {
    const score = (e) => (e.taste ?? 0) + 0.7 * (e.quality ?? 0);
    return { entries: once(films.filter((e) => e.watchlist && unseenEligible(e) && fitsAny(moods)(e))).sort((a, b) => score(b) - score(a) || cmp(a.tt, b.tt)), context: named(row) };
  }
  if (row.kind === "short") {
    const min = meta.minFeatureMinutes ?? 40, max = SHORT_MAX;
    return { entries: once(films.filter((e) => unseenRecommendable(e) && e.runtime != null && e.runtime >= min && e.runtime <= max && fitsAny(moods)(e))).sort(byRank), context: named(row) };
  }
  if (row.kind === "theme") {
    const ids = row.lists;
    const inLists = (e) => { const s = e.r[C.lists]; return !!s && ids.some((id) => s.startsWith(`${id}:`) || s.includes(`,${id}:`)); }; // listPos() without the number: this runs over thousands of films cold
    return { entries: keep(once(films.filter((e) => unseenRecommendable(e) && inLists(e))).sort(byRank)), context: { kind: "theme", ...named(row) } };
  }
  if (row.kind === "lists") {
    // the curators' order: the first list's films by their place there, then the next list's films that were not in it, and so on
    const out = [], seen = new Set();
    for (const id of row.lists) {
      const inList = films.filter((e) => !e.seen && e.listPos(id) !== undefined && !seen.has(e.tt)).sort((a, b) => a.listPos(id) - b.listPos(id) || cmp(a.tt, b.tt));
      for (const e of inList) { seen.add(e.tt); out.push(e); }
    }
    // the row's name leads the reason line and the film's place follows ("Criterion Closet · All picks · #5"): in the first of the row's lists that holds it
    const list = row.label || row.name ? { id: row.lists[0], label: row.label || row.name } : null;
    return { entries: keep(out), context: list ? { kind: "list", list, lists: row.lists, ...named(row) } : {} };
  }
  throw new Error(`profileRow: ${row.kind} is not a row the profile builds`);
}

/** Best rank first, then by IMDb id (the order of the index file and of Explore). */
const byRank = (a, b) => (b.rank ?? -Infinity) - (a.rank ?? -Infinity) || cmp(a.tt, b.tt);
