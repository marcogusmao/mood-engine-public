// The addon manifest, built from the menus in the index (moods, lists, friends, countries, decades).
// Stremio reads it when the addon is installed and keeps it: after a build that changes a menu, remove the addon and install it again.

import { listMenu } from "./extras.js";
import { RATING_LABELS, RUNTIME_LABELS, countryMenu } from "./filters.js";
import { SERIES_CATALOG_ID, SERIES_CATALOG_NAME } from "./series.js";
import { BOARD_NAMES, MOOD_NAMES, PROFILE_VERSION, VOUCH, WHAT, dryName, listsOfGroup, themesOf } from "./profiles.js";

export const ADDON_ID = "com.mgusmao.moodengine.live";
export const ADDON_VERSION = "3.3.0"; // the Worker, and the manifest while the index has the v2 family (index-v2-menus.json)
export const DISCOVER_VERSION = "3.5.0"; // the manifest while the v2 index carries `discover` (the Discover grouped by subject: Countries & regions, Decades & eras, the lists in six catalogs; Marco, 22/10/2026; 3.5.0, Marco, 28/10/2026, proposal 5: Craft & form instead of Loved by directors, the Genre filter of Explore, 67 catalogs). Without `discover` it stays ADDON_VERSION, byte for byte. An index with `discover` but none of the 3.5.0 keys (`explore`) makes the 3.4.1 manifest with this version (test/discover.test.js)
export const LEGACY_MANIFEST_VERSION = "3.1.0"; // the manifest while it has none: the Worker then answers byte for byte as 3.1.0 did, version included

/** Is this the v2 family's menus (or whole index)? Only the v2 files carry `moodMenu` (lib/index-export.js). */
export const isV2 = (index) => !!index && Array.isArray(index.moodMenu);

/** Discover catalogs, in order. `genre` is the one required menu where there is one (it keeps the catalog off the Board). */
export const DISCOVER = [
  { id: "moods", name: "Mood Engine · Moods" },
  { id: "lists", name: "Mood Engine · Lists" },
  { id: "lists-unseen", name: "Mood Engine · Lists (unseen)" },
  { id: "friends", name: "Mood Engine · Friends" },
  { id: "director-picks", name: "Mood Engine · Loved by directors" }, // Marco, 11/10/2026: one option per favourite director
  { id: "explore", name: "Mood Engine · Explore" },
  { id: "search", name: "Mood Engine · Search" },
];

/**
 * The Genre menu of Explore (3.5.0; Marco, 28/10/2026): "All" first, then the labels of the catalog the index names in `discover.explore.genre` (the Genres catalog, 19 genres). The menu is REQUIRED, always: that is what keeps Explore off the Board
 * (README, "Explore stays out of the Board"), however many options it has. An index with no `explore` key, or one that names a catalog it does not have, gets the single entry "All", as 3.4.1 did.
 */
function exploreGenres(dc) {
  const cat = dc && dc.explore && dc.catalogs.find((c) => c.id === dc.explore.genre);
  return ["All", ...(cat ? cat.options.map((o) => o.label) : [])];
}

/**
 * The Discover catalogs that read LEGACY pieces (Lists, Lists (unseen), Friends, Loved by directors; the Marco profile's Who vouches and What it is read lists too): the legacy files keep for each film
 * only its first two countries and the 12 of the legacy menu (lib/index-export.js), so a 46-country menu would offer 34 countries that match too few films or none. They keep the 12 until the build
 * writes v2 pieces of them (Marco's decision, not taken: worker/README.md). Moods and Explore read v2 files and have the 46; Search has no country menu.
 */
export const LEGACY_PIECE_CATALOGS = new Set(["lists", "lists-unseen", "friends", "director-picks"]);

/** Board rows of the v2 family that keep the id of a legacy mood but mix several (Horror = wicked + slasher + horror-comedy): the mood's dry name from decision 10 ("Art-house horror") would be wrong for them. */
export const MIXED_IN_V2 = new Set(["wicked"]);

/**
 * The sentence of the manifest's description about the films he has seen. 3.3.0 and before: "except Old friends and the full Lists" (byte for byte, fixtures/manifest-3.3.0.json). With the Discover by subject
 * (3.4.0, 22/10/2026) there is no Lists catalog in the manifest, and "Include seen" brings the seen films back in every grouped catalog, so the sentence says that instead (Marco has not decided the wording: PRODUCT.md, "not decided").
 */
const SEEN_SENTENCE = { plain: "Never shows what you've already seen (except Old friends and the full Lists).", discover: "Never shows what you've already seen (except Old friends, and in the lists and cuts of the Discover when you ask with Include seen)." };
const optional = (name, options) => ({ name, isRequired: false, options });
const skip = { name: "skip" };

/**
 * The description of a friend's manifest (/u/<friend>/, 29/10/2026, worker/src/friends.js): Marco's Mood Engine as the friend sees it. Says which two things are the friend's and which are Marco's, so nobody expects the rows to follow the friend's taste.
 * The sentence about the films already seen is the public one, with the friend as the one who has seen them.
 */
const friendDescription = (name, dc) => `Mood Engine · ${name}: Marco's Mood Engine seen through ${name}. What it hides as already seen, and the Watchlist row, are ${name}'s own (from Letterboxd); the taste behind the rows, the lists, the Board and the friends are Marco's. Combine mood, list or friend with decade, runtime, country and rating, and search by title, director, list, mood, country, decade, length or friend. ${dc ? `Never shows what ${name} has already seen (except Old friends, and in the lists and cuts of the Discover when you ask with Include seen).` : `Never shows what ${name} has already seen (except Old friends and the full Lists).`} Also English and Portuguese subtitles from the official list.`;

/**
 * index: either part of the index (the Board part is enough: menus only), or the v2 family's menus (index-v2-menus.json).
 * opts.exploreOnBoard (default false, Marco 10/10/2026: Explore stays off the Board): Explore gets a required `genre` menu with the single
 * option "All", and so lives in Discover only. With true it has only the four optional menus, and Stremio lists it on the Board too, as
 * one more row. (stremio-core AggrRequest::AllCatalogs: the Board asks for every catalog that is_extra_supported(&[]), i.e. with no required extra.)
 *
 * The legacy index (3.1.0, and still the answer while the build publishes no v2 family):
 * My series (Marco, 11/10/2026, a deliberate extra Board row): one series catalog with no extra at all, so Stremio puts it on the
 * Board. It sits right after the Board row "watchlist" when the index has one, else right after the last Board row, before the Discover catalogs.
 * Its list is fixed and bundled (series.js); the index is read for the menus only, as before.
 *
 * The v2 index (3.3.0; Marco, 13 and 14/10/2026): the seven "Mood Engine · …" catalogs come FIRST, so Discover opens on Moods, then the Board rows in the
 * order and under the names the build wrote (`board`, the entries with place "board"; "menu" ones such as Friends this week are options of the Moods menu
 * and not catalogs). My series is one of those entries (`series: true`, its place and name are the index's). The Moods menu is `moodMenu`
 * (every mood and the menu rows, under their labels) and the country menu of Moods and Explore is `meta.countriesAll` (46; the four catalogs of legacy pieces keep the 12, LEGACY_PIECE_CATALOGS). The version is 3.3.0.
 */
export function buildManifest(index, { exploreOnBoard = false, person = null, friend = null } = {}) {
  const meta = index.meta || {};
  const v2 = isV2(index);
  const dc = v2 && index.discover ? index.discover : null; // the Discover grouped by subject (3.4.0)
  const grouped = new Set((dc ? dc.catalogs : []).map((c) => c.id));
  // the grouped catalogs read list pieces for their lists, which keep the 12 countries of the legacy menu (the same reason as LEGACY_PIECE_CATALOGS), so the 12 are their menu too
  const cuts = (id) => [optional("decade", meta.decades || []), optional("runtime", RUNTIME_LABELS), optional("country", LEGACY_PIECE_CATALOGS.has(id) || grouped.has(id) ? meta.countries || [] : countryMenu(meta)), optional("rating", RATING_LABELS)];
  const genre = (labels) => ({ name: "genre", isRequired: true, options: labels });
  const rows = [];
  if (v2) {
    for (const r of index.board || []) if (r.place === "board" && (!person || (!r.series && r.id !== SERIES_CATALOG_ID))) rows.push({ type: r.series ? "series" : "movie", id: r.id, name: r.name });
  } else {
    rows.push(...(index.board || []).filter((r) => !person || (!r.series && r.id !== SERIES_CATALOG_ID)).map((r) => ({ type: "movie", id: r.id, name: r.name })));
    const after = rows.findIndex((c) => c.id === "watchlist");
    if (!person) rows.splice(after >= 0 ? after + 1 : rows.length, 0, { type: "series", id: SERIES_CATALOG_ID, name: SERIES_CATALOG_NAME });
  }
  const menus = {
    moods: v2 ? (index.moodMenu || []).map((m) => m.label) : (index.moods || []).map((m) => m.label),
    lists: listMenu(index.lists || []),
    friends: ((index.friends && index.friends.options) || []).map((o) => o.label),
    "director-picks": ((index.directors && index.directors.options) || []).map((o) => o.label),
  };
  const discover = [];
  for (const c of DISCOVER) {
    if (c.id === "search") discover.push({ type: "movie", id: c.id, name: c.name, extra: [{ name: "search", isRequired: true }, skip] });
    else if (c.id === "explore") discover.push({ type: "movie", id: c.id, name: c.name, extra: [...(exploreOnBoard ? [] : [genre(exploreGenres(dc))]), ...cuts(c.id), skip] });
    else {
      const key = c.id === "lists-unseen" ? "lists" : c.id;
      if (!menus[key].length) continue; // a menu with no options cannot be shown (a build with no lists, no friends, or an index from before the directors' menu)
      discover.push({ type: "movie", id: c.id, name: c.name, extra: [genre(menus[key]), ...cuts(c.id), skip] });
    }
  }
  if (dc) {
    // 3.4.0: the catalogs in the order of the index (`discover.order`), the grouped ones made here, the retired ones (Lists, Lists (unseen): the Worker still answers them) left out
    const made = new Map(discover.map((c) => [c.id, c]));
    for (const c of dc.catalogs) {
      const labels = c.options.map((o) => o.label);
      if (labels.length) made.set(c.id, { type: "movie", id: c.id, name: c.name, extra: [genre(labels), ...cuts(c.id), optional(dc.seen.name, [dc.seen.option]), skip] });
    }
    discover.splice(0, discover.length, ...dc.order.filter((id) => !dc.retire.includes(id) && made.has(id)).map((id) => made.get(id)));
  }
  // A friend's watchlist has no addition dates in this index; it follows rank.
  // Keep the public row's wording, but never promise "newest first" to a friend.
  if (friend) for (const row of rows) if (row.id === "watchlist") row.name = "Your watchlist";
  const catalogs = v2 ? [...discover, ...rows] : [...rows, ...discover];
  return {
    id: person ? `${ADDON_ID}.${person.id}` : friend ? `${ADDON_ID}.u.${friend.slug}` : ADDON_ID,
    version: v2 ? (dc ? DISCOVER_VERSION : ADDON_VERSION) : LEGACY_MANIFEST_VERSION,
    name: person ? `Mood Engine · ${person.name}` : friend ? `Mood Engine · ${friend.name}` : "Mood Engine",
    description: person ? `Mood Engine · ${person.name}: your own film rows, menus and recommendations, live.` : friend ? friendDescription(friend.name, dc) : `Your Mood Engine rows, live: combine mood, list or friend with decade, runtime, country and rating, and search by title, director, list, mood, country, decade, length or friend. ${SEEN_SENTENCE[dc ? "discover" : "plain"]} Also English and Portuguese subtitles: the official list, and the ones made for your file first only on the private address.`,
    logo: "https://raw.githubusercontent.com/twitter/twemoji/master/assets/72x72/1f3ac.png",
    // subtitles: films and episodes (their id is tt0944947:1:1), IMDb ids only. The catalogs are films, plus one series row (My series).
    resources: person ? ["catalog"] : ["catalog", { name: "subtitles", types: ["movie", "series"], idPrefixes: ["tt"] }],
    types: person ? ["movie"] : ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs,
    behaviorHints: { configurable: false, configurationRequired: false },
  };
}

/**
 * A profile's manifest (profiles.js; Marco, 11/10/2026). Its own id (`com.mgusmao.moodengine.live.<profile>`, so the six can live side by side in
 * Fusion, which has no profiles, and next to the old address), its name (≤ 20 characters, the Nuvio TV limit), its Board, then Discover.
 *   Marco      the old manifest's catalogs, Board and Discover, every Board row under a dry name (decision 10 for the moods, BOARD_NAMES for the
 *              rest, Marco 11/10/2026), plus Who vouches and What it is
 *   the others their Board (profiles.js), then Who vouches, What it is and Search
 * Who vouches is one catalog per group, its required menu the group's lists; What it is has the themes. Both take the four optional menus.
 * A menu with no options is left out, as in the old manifest. Every catalog with a required menu says `showInHome: false` (NuvioTV, below).
 *
 * v2 (14/10/2026): the five profiles with rows are handed the LEGACY index and never see the v2 family (their manifests are the ones of 3.2.0, test/profile-parity.test.js).
 * Only Marco mirrors the main address: given the v2 menus, its catalogs are the main manifest's (Discover first) under dry names, and its Moods and Explore menus use the 46 countries (Who vouches and What it is read legacy list pieces: the 12).
 */
export function buildProfileManifest(index, profile, { exploreOnBoard = false, person = null } = {}) {
  const meta = index.meta || {};
  const v2 = isV2(index);
  const dc = v2 && index.discover ? index.discover : null; // the Marco profile mirrors the main address: the Discover by subject, when the index has it
  const cuts = () => [optional("decade", meta.decades || []), optional("runtime", RUNTIME_LABELS), optional("country", meta.countries || []), optional("rating", RATING_LABELS)]; // Who vouches and What it is read lists: the legacy 12, whatever the index
  const genre = (labels) => ({ name: "genre", isRequired: true, options: labels });
  const menus = [];
  for (const v of VOUCH) {
    const names = listsOfGroup(index, v.group).map((l) => l.name);
    if (names.length) menus.push({ type: "movie", id: v.id, name: v.name, extra: [genre(names), ...cuts(), skip] });
  }
  const themes = themesOf(index);
  if (themes.length) menus.push({ type: "movie", id: WHAT.id, name: WHAT.name, extra: [genre(themes), ...cuts(), skip] });

  let catalogs;
  if (!profile.rows) {
    const moods = new Set((index.moods || []).map((m) => m.id));
    const board = new Set([...(index.board || []).map((r) => r.id), SERIES_CATALOG_ID]);
    const dry = (c) => (c.type === "movie" && moods.has(c.id) && MOOD_NAMES[c.id] && !(v2 && MIXED_IN_V2.has(c.id)) ? MOOD_NAMES[c.id] : board.has(c.id) ? BOARD_NAMES[c.id] || dryName(c.name) : c.name);
    catalogs = buildManifest(index, { exploreOnBoard, person }).catalogs.map((c) => ({ ...c, name: dry(c) }));
    const at = catalogs.findIndex((c) => c.id === "explore");
    catalogs.splice(at >= 0 ? at : catalogs.length, 0, ...menus);
  } else {
    catalogs = [...profile.rows.map((r) => ({ type: "movie", id: r.id, name: r.name })), ...menus, { type: "movie", id: "search", name: "Search", extra: [{ name: "search", isRequired: true }, skip] }];
  }
  // NuvioTV puts a catalog with a required `genre` on its Home and asks for it with no menu at all; only `showInHome: false` (Nuvio's own
  // field, which Stremio ignores) keeps it in Discover (research of 11/10/2026, NuvioTV df66819 HomeViewModelCatalogUtils.kt L361-368).
  catalogs = catalogs.map((c) => ((c.extra || []).some((e) => e.isRequired) ? { ...c, showInHome: false } : c));
  return {
    id: `${ADDON_ID}.${person ? `${person.id}.` : ""}${profile.key}`,
    version: PROFILE_VERSION,
    name: person ? `Mood Engine · ${person.name}` : profile.name,
    // The subtitles sentence is one text true on both addresses (19/10/2026, W4): the manifest under /k/<token>/ is byte for byte the public one (tested), and since W4 only the private address makes the hash search that finds "the ones made for your file". The main manifest says the same sentence since 19/10/2026 (Marco's decision; pinned byte for byte by test/fixtures/manifest-3.3.0.json and legacy-manifest.json, version kept at 3.3.0).
    description: person ? `Mood Engine · ${person.name}, profile ${profile.name}: your own film rows and Discover menus, live.` : profile.rows
      ? `Mood Engine, profile ${profile.name}: its own rows, live, plus Who vouches and What it is in Discover. Never shows what you've already seen. Also English and Portuguese subtitles: the official list, and the ones made for your file first only on the private address.`
      : `Mood Engine, profile Marco: all your rows, live, plus Who vouches and What it is in Discover. ${SEEN_SENTENCE[dc ? "discover" : "plain"]} Also English and Portuguese subtitles: the official list, and the ones made for your file first only on the private address.`,
    logo: "https://raw.githubusercontent.com/twitter/twemoji/master/assets/72x72/1f3ac.png",
    resources: person ? ["catalog"] : ["catalog", { name: "subtitles", types: ["movie", "series"], idPrefixes: ["tt"] }],
    types: person ? ["movie"] : ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs,
    behaviorHints: { configurable: false, configurationRequired: false },
  };
}

/** Marco, 20/10/2026 §9: a separate public film page, never meta in a catalog addon. */
export function buildPageManifest(variant = null) {
  const base = { id: 'com.mgusmao.moodengine.page', version: '1.0.0', name: 'Mood Engine · Film page', description: "Synopses, moods, ratings and critics' and directors' lists for films in the Mood index. Other films and series keep Cinemeta's page.", logo: 'https://raw.githubusercontent.com/twitter/twemoji/master/assets/72x72/1f3ac.png', resources: [{ name: 'meta', types: ['movie'], idPrefixes: ['tt'] }], types: ['movie'], idPrefixes: ['tt'], catalogs: [], behaviorHints: { configurable: false, configurationRequired: false } };
  // The Fusion trials (page.js PAGE_VARIANTS, 29/10/2026): their own ids, so Fusion does not take one for the other; the page itself is the same.
  if (variant === 'fusion-a') return { ...base, id: `${base.id}.fusion-a`, resources: ['meta'] };
  if (variant === 'fusion-b') return { ...base, id: `${base.id}.fusion-b`, resources: ['meta', 'catalog'], catalogs: [{ type: 'movie', id: 'page-search', name: 'Mood Engine · Film page', extra: [{ name: 'search', isRequired: true }] }] };
  return base;
}
