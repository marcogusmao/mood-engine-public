// Which films a catalog request shows, in which order. The Worker only re-orders and filters what the build already approved.
//
//   Board rows   index.rows[id], in the order the build calculated, minus anything seen (except "Old friends", which is a rewatch row)
//   moods        films that fit the mood, best mood rank first, at most 2 films per director (like the Moods row of the build)
//   lists        the curator's order; seen films stay (this is the one catalog besides Old friends that may show them)
//   lists-unseen the same minus what you have seen
//   friends      the friend's option exactly as the build ordered it
//   director-picks  "Loved by directors" (Marco, 11/10/2026): the director's option as the build ordered it, each film with the build's own
//                text ("Loved by Lynch and Scorsese · …"). The build marks these films eligible when they pass the rule below (a
//                favourite director's love is a vouch: the floor is 2.5, and a film with no Letterboxd average passes).
//   explore      every unseen film in the index, best rank first
//   places, eras, genres, themes, critics, directors, letterboxd, seasons   the Discover catalogs of the v2 family (3.4.0; Marco, 22/10/2026), the ones `index.discover` declares. Their option is either
//                a calculated one (the build wrote the ids of its films: the unseen ones that the recommendation rule lets through, as Explore shows them, plus the seen ones with "Include seen"; pages 1 to 3 are read from the option's own piece, optionPage below) or a list
//                (the handler answers it from the list's own piece, as Lists / Lists (unseen) did: the curator's order, no recommendation rule).
//   explore      every unseen film in the index, best rank first; with `index.discover.explore` and a Genre other than "All" (3.5.0; Marco, 28/10/2026): the ids of that genre in the Genres catalog, same rule, same order as the build gave
//   curated      an option of the Discover marked `curated` by the build (3.5.0): a union of lists or a director's card. A collection, not a recommendation: no recommendation rule, no music rule, the seen films only with "Include seen"; a card says "Loved by …"
//   search       see search.js
//
// All of Discover but Lists takes the four optional menus (decade, runtime, country, rating) on top.
//
// The recommendation rule (lib/recommendation-quality.js qualifies(); Marco, 10/10/2026 and 11/10/2026), on the film's IMDb identity:
//   - any film: the unrounded Letterboxd average is at least 3.5, OR a configured friend's own rating is at least 3.5;
//   - a vouched film (in a critic or director list, in a fan list's critics' subset such as the Cannes prizes, or loved by one of Marco's
//     favourite directors): a Letterboxd average of at least 2.5 is enough, and a vouched film with NO average passes;
//   - anything else with no Letterboxd average and no friend rating is NOT eligible (TMDB never stands in for either).
// The build decides that once per film and writes it as the flag `eligible`; the Worker only reads it, never recomputes it. It applies to
// what the Worker builds from the pool: Explore, Search, Moods, and every combination of the menus with them, the rating menu included. It does not apply to the Board rows (the build already filtered them), nor to Lists, Lists (unseen) and Friends, which are
// direct curator and friend collections. The index's `rules.exemptCatalogs` say which; DEFAULT_RULES stand only when an index has none.
//
// Filtering keeps the order of the survivors and fills no gap: the page is the first 100 eligible films in the catalog's own order.
//
// The music rule (Marco, 22/10/2026 ~06:40 UTC; lib/pool.js musicGate): a music film he has not seen and has no evidence for is held back by the build (bit 8 of the film's flags,
// `musicOut`) and is NOT recommended: Moods and Explore, with every menu on top of them, show `recommendable` films (eligible and not held back). Search answers to country, decade, genre and keyword too,
// which is a cut like the menus, so a held-back film is found there only by its TITLE (src/search.js: every word of the search is a word of the title). Lists, Lists (unseen), Friends, "Loved by directors"
// and the Board rows (the build already filtered them) are served as before. An index without the bit behaves exactly as before: recommendable is eligible.
// One exception (Marco, 22/10/2026 ~15:15 UTC, "Music 1 of 4": "it is the only place where I ask for music when I open the app"): the Moods option of a mood the index names in `rules.musicExemptMoods`
// (the mood Music) shows `eligible` films, held-back ones included, with the menus on top of it. Nothing else changes.
//
// The shorts (Marco, 15/11/2026, questionnaire, on where films under 40 minutes may still appear: "Only where you or a source put them (recommended)"): a film whose known runtime is under
// config.json shortRow.minMinutes (40) leaves everything that RECOMMENDS and stays where he or a source put it. The build says which films (bit 16 of the flags, `shortOut`: lib/pool.js isShort on the index's own
// runtime; a film with no known runtime is no short) and `recommendable` reads it together with the music bit, so the shorts leave exactly where the held-back music films leave: Moods (the Music option too),
// Explore and its Genre, every menu on top of them, the calculated options of the Discover with or without "Include seen" (the build counts their totals the same way; apart from the options the build marks `shorts: true`: the eras with a file, which keep the shorts their files name, and the Silent era, by Marco's answer of 15/11/2026, "Keep shorts in the Silent era only (recommended)"), and the profiles' Tonight, Under 100 min, themes
// and What it is. They STAY in Search (by any word, not only the title: a search is asked for), Lists, Lists (unseen), Friends, "Loved by directors", the curated options (unions of lists, directors' cards), the
// profiles' Watchlist, Who vouches and Closet rows, the Board rows (the build's own decision, row by row), the film page and the subtitles. An index without the bit behaves exactly as before.

import { matchList, matchOption, skipOf } from "./extras.js";
import { compileFilters } from "./filters.js";
import { search } from "./search.js";
import { cmp } from "./text.js";

export const PAGE = 100;
export const DEFAULT_RULES = { rule: "letterboxd-average-or-configured-friend", minStars: 3.5, exemptCatalogs: ["lists", "lists-unseen", "friends"] };

/** { rules, from } — the rules in force for this index, and whether they came from the index or are the defaults. */
export function rulesOf(index) {
  return { rules: { ...DEFAULT_RULES, ...(index.rules || {}) }, from: index.rules ? "index" : "default" };
}

/** The catalogs that RECOMMEND: they show `recommendable` films (the music rule and the shorts too). Search and "Loved by directors" ask `eligible` alone. */
export const RECOMMENDING = new Set(["moods", "explore"]);
/** The recommendation rule as a test on a film (the build's `eligible` flag; for a catalog that recommends, `recommendable`: eligible and not held back by the music rule), or null when this catalog is exempt from it. Board rows are always exempt. */
export function eligibleTest(index, id, moodId) {
  const { rules } = rulesOf(index);
  if ((index.rows && index.rows[id]) || (rules.exemptCatalogs || []).includes(id)) return null;
  // Marco, 22/10/2026 ~15:15 UTC ("Music 1 of 4"): the Moods menu's option of a mood the index lists in `rules.musicExemptMoods` (the mood named Music) ignores the music rule's bit: `eligible`, like a catalog that does not recommend. Only Moods
  // asks with a mood, and only the options the index names; Explore, the other options, the profiles and Search are untouched. An index without the key (every index built before) exempts nothing.
  // That exemption is from the MUSIC rule alone: a short (bit 16, Marco, 15/11/2026) is out of this option too, as of every other that recommends.
  if (id === "moods" && moodId !== undefined && (rules.musicExemptMoods || []).includes(moodId)) return (e) => e.eligible && !e.shortOut;
  return RECOMMENDING.has(id) || discoverCatalog(index, id) ? (e) => e.recommendable : (e) => e.eligible; // a calculated option of the Discover recommends, like Explore: the music rule holds there too, and the exemption of a mood above is the Moods menu's alone, never an option of the Discover
}

/** The Discover catalog `id` of this index (3.4.0), or undefined: an index with no `discover`, or an id it does not declare. */
export const discoverCatalog = (index, id) => ((index.discover && index.discover.catalogs) || []).find((c) => c.id === id);

/**
 * The option of a Discover catalog that a `genre` stands for: the label, or the same words (matchOption); in a catalog of lists also the list's FULL name, which the older installs and the Nuvio
 * profiles still send (matchList). No `genre` at all (NuvioTV's Discover opens on "Default" and asks with none): the first option, not an empty page. A value that fits nothing: null (an empty page).
 */
export function discoverOption(cat, genre, lists = []) {
  const options = cat.options || [];
  if (genre === undefined || genre === null) return options[0] || null;
  const label = matchOption(genre, options.map((o) => o.label));
  if (label !== null) return options.find((o) => o.label === label);
  const list = matchList(genre, lists);
  return (list && options.find((o) => o.list === list.id)) || null;
}

/** The build's own "Loved by …" text for a director's card: tt → text, from the "loves" option of that name in index.directors.options (the films of the card that are not in it keep the film's general text). An unknown name gives no text at all. */
function directorDescs(index, name) {
  const opt = ((index.directors && index.directors.options) || []).find((o) => o.label === name);
  return new Map(opt ? opt.ids.map((tt, i) => [tt, (opt.descs || [])[i]]).filter(([, d]) => d !== undefined) : []);
}

/** Did the request ask for the seen films too? The filter the index declares (`discover.seen`, "Include seen"): its value is the option, matched on the words. */
export function includeSeen(extras, index) {
  const seen = index.discover && index.discover.seen;
  return !!seen && matchOption(extras[seen.name], [seen.option]) !== null;
}
/** Seen films may appear in these, and in a catalog of the Discover by subject when "Include seen" is asked (3.4.0, 22/10/2026: the branch of select() for `discover`; includeSeen), and nowhere else. Mirrors GUARD_EXEMPT in lib/plan.js: "Lists" (whole) and "Old friends". */
export const SEEN_OK = new Set(["lists", "oldfriends"]);
const PER_DIRECTOR = 2;

/** The entries for a list of IMDb ids, in that order. One pass over the films, no Map of all of them. */
function pick(index, ids) {
  const want = new Set(ids);
  const found = new Map();
  for (const e of index.films) if (want.has(e.tt)) found.set(e.tt, e);
  return ids.map((tt) => found.get(tt)).filter(Boolean);
}

/** At most `n` films by the same (first) director; films with no known director are never held back. */
function diversify(list, n = PER_DIRECTOR) {
  const count = new Map();
  return list.filter((e) => {
    const d = e.director ? e.director.split(", ")[0] : null;
    if (!d) return true;
    const c = count.get(d) || 0;
    if (c >= n) return false;
    count.set(d, c + 1);
    return true;
  });
}

/**
 * → { entries, context } where context says what to add to each description ("#12 in …"); null for a catalog that does not exist.
 * opts.rowMenus: a Board row served as an option of the Moods menu ("Friends this week", v2) takes the four optional menus on top; as a Board row of its own it ignores them, as always.
 * opts.seen: (film) → true when the viewer has seen it; absent, the film's own flag, which is Marco's. The friends' routes pass the friend's.
 * Even then it keeps the Board's exemption from the recommendation rule: the build already filtered the row.
 */
export function select(index, id, extras, opts = {}) {
  const meta = index.meta || {};
  const f = compileFilters(extras, meta);
  const rule = eligibleTest(index, id);
  const keep = (list, test = rule) => { if (f.none) return []; const l = test ? list.filter(test) : list; return f.active ? l.filter(f.test) : l; };
  // Marco's own "seen" is the flag of the film; the friends' routes (/u/<friend>/, worker/src/friends.js; 29/10/2026) hand in `opts.seen`, the friend's: every catalog below, Search included, asks THIS test and no other.
  const unseen = opts.seen ? (e) => !opts.seen(e) : (e) => !e.seen;

  // a Board row
  const row = index.rows && index.rows[id];
  if (row) {
    const list = pick(index, row);
    const own = (index.rowDesc && index.rowDesc[id]) || [];
    const shown = SEEN_OK.has(id) ? list : list.filter(unseen);
    return { entries: opts.rowMenus ? (f.none ? [] : f.active ? shown.filter(f.test) : shown) : shown, context: { descs: new Map(row.map((tt, i) => [tt, own[i]]).filter(([, d]) => d !== undefined)) } }; // a row keeps its own reasons
  }

  const dc = discoverCatalog(index, id);
  if (dc) {
    const opt = discoverOption(dc, extras.genre, index.lists || []);
    if (!opt || !opt.ids) return { entries: [], context: {} }; // no such option; or a list option, which the handler answers from the list's own piece
    const all = includeSeen(extras, index);
    // 3.5.0 (Marco, 28/10/2026, proposal 5): an option the build marks `curated` is an editorial collection (a union of lists, a director's card): every film of its ids, seen or not (the seen ones only with "Include seen"), with NO recommendation rule, as a list
    // is. A director's card (`director`) also carries the build's "Loved by …" text for the films of that director's "loves" option, read from index.directors.options like the old "Loved by directors" catalog did.
    // 15/11/2026: an option that says `shorts: true` (an era of data/eras: the build's director door takes no short, so a short in its ids is one the era's file names) keeps the recommendation rule and the music rule and is not asked the short bit:
    // "Only where you or a source put them" (Marco). One period carries the mark too, the Silent era (Marco, 15/11/2026: "Keep shorts in the Silent era only (recommended)"; lib/discover-catalogs.js SHORTS_PERIODS); the other eight periods do not.
    // The build counts the option's totals the same way (lib/index-export.js optionCut). An index without the key: the rule of every calculated option.
    const test = opt.curated === true ? null : opt.shorts === true ? (e) => e.recommendableOrShort : rule;
    return { entries: keep(pick(index, opt.ids).filter((e) => all || unseen(e)), test), context: opt.director !== undefined ? { kind: "directors", descs: directorDescs(index, opt.director) } : { kind: "explore" } }; // a cut, with no row's name (Marco, 13/10/2026), and no film out of the order the build gave
  }

  if (id === "moods") {
    const mood = (index.moods || []).find((m) => m.label === matchOption(extras.genre, (index.moods || []).map((x) => x.label)));
    if (!mood) return { entries: [], context: {} };
    const rank = (e) => e.mood(mood.id)[1];
    const list = index.films.filter((e) => e.mood(mood.id) && unseen(e));
    return { entries: diversify(keep(list, eligibleTest(index, id, mood.id)).sort((a, b) => rank(b) - rank(a) || cmp(a.tt, b.tt))), context: { kind: "moods", name: mood.name } };
  }

  if (id === "lists" || id === "lists-unseen") {
    const list = matchList(extras.genre, index.lists || []); // the short name of the menu, or the full name of an install from before it
    if (!list) return { entries: [], context: {} };
    const films = index.films.filter((e) => e.listPos(list.id) !== undefined && (SEEN_OK.has(id) || unseen(e)));
    return { entries: keep(films).sort((a, b) => a.listPos(list.id) - b.listPos(list.id) || cmp(a.tt, b.tt)), context: { kind: "list", list } };
  }

  if (id === "friends") {
    const options = index.friends?.options || [];
    const opt = options.find((o) => o.label === matchOption(extras.genre, options.map((x) => x.label)));
    if (!opt) return { entries: [], context: {} };
    return { entries: keep(pick(index, opt.ids).filter(unseen)), context: { kind: "friends", name: opt.label } };
  }

  if (id === "director-picks") {
    const options = (index.directors && index.directors.options) || [];
    const opt = options.find((o) => o.label === matchOption(extras.genre, options.map((x) => x.label)));
    if (!opt) return { entries: [], context: {} };
    return { entries: keep(pick(index, opt.ids).filter(unseen)), context: { kind: "directors", descs: new Map(opt.ids.map((tt, i) => [tt, opt.descs[i]]).filter(([, d]) => d !== undefined)) } };
  }

  if (id === "explore") {
    // 3.5.0 (Marco, 28/10/2026): Explore's Genre menu is "All" and the 19 genres, when the index says which catalog holds them (`discover.explore.genre`, the id of the Genres catalog). A genre is the option of that catalog with the same label,
    // its ids read the same way (unseen, recommendable, the four menus on top); a value that is no genre of it is an empty page, never the whole index. "All", or no genre at all (NuvioTV), is Explore as always; so is an index with no `explore` key.
    const ex = index.discover && index.discover.explore;
    const g = extras.genre;
    if (ex && g !== undefined && matchOption(g, ["All"]) === null) {
      const cat = discoverCatalog(index, ex.genre);
      const opt = cat && (cat.options || []).find((o) => o.label === matchOption(g, cat.options.map((x) => x.label)));
      if (!opt || !opt.ids) return { entries: [], context: { kind: "explore" } };
      return { entries: keep(pick(index, opt.ids).filter(unseen)), context: { kind: "explore" } };
    }
    return { entries: keep(index.films.filter(unseen)), context: { kind: "explore" } }; // the file is already best-rank-first
  }

  if (id === "search") {
    const found = search(index, extras.search, { seen: opts.seen });
    return { entries: keep(found), context: { kind: "search" } };
  }
  return null;
}

/** Identity and row coverage shared by complete and prefix pieces. Totals themselves are build facts, checked by verify.js. */
function pieceOption(index, catalogId, optionId, extras) {
  if (index.meta?.part !== `v2-opt:${catalogId}:${optionId}`) return null;
  const dc = discoverCatalog(index, catalogId);
  const opt = dc && (dc.options || []).find((o) => o.id === optionId);
  if (!opt || !Array.isArray(opt.ids) || !Number.isInteger(opt.total) || !Number.isInteger(opt.totalAll)
      || opt.total < 0 || opt.totalAll < opt.total) return null;
  if (discoverOption(dc, extras.genre, index.lists || []) !== opt) return null;
  const ids = new Set(opt.ids);
  if (ids.size !== opt.ids.length || opt.ids.some((tt) => typeof tt !== "string" || !/^tt\d+$/.test(tt))) return null;
  if (index.films.length !== ids.size) return null;
  const films = new Set(index.films.map((e) => e.tt));
  if (films.size !== ids.size || [...ids].some((tt) => !films.has(tt))) return null;
  return opt;
}

/** A complete current-format piece can answer any viewer, filter and skip using the original selection and pagination.
 * Count the unfiltered Include seen selection, not raw ids: recommendation and music rules may hold some ids back.
 * Equality relies on the build's truthful totalAll (verify.js); it cannot detect forged totals hiding missing candidates.
 */
export function completeOptionPage(index, catalogId, optionId, extras, opts) {
  const opt = pieceOption(index, catalogId, optionId, extras);
  const seen = index.discover?.seen;
  if (!opt || !seen) return null;
  const all = select(index, catalogId, { genre: extras.genre, [seen.name]: seen.option });
  if (!all || all.entries.length !== opt.totalAll) return null;
  return page(index, catalogId, extras, opts);
}

/**
 * A page of a calculated option of the Discover read from the option's OWN piece (lib/index-export.js optionPieces; Marco, 29/10/2026), or null when the piece cannot give that page exactly and the whole v2 index has to answer.
 * The piece holds the films of the first ids of the option and the two totals of the WHOLE option (`total`: unseen and recommendable, `totalAll`: with "Include seen"). Because the films are a prefix of the ids and select() keeps their order,
 * the films it shows from the piece are a prefix of what the whole index would show; so the page is the same when the piece shows enough of them to fill it (`skip` + 100), or when it shows all the option has (its count equals the total).
 * The total is the whole option's: X-Total never says what the piece holds. What this cannot see is a `total` LARGER than the truth: the piece holds no count to check it against (a total smaller than what the piece shows is refused above); verify.js is the barrier for that. No menu on top (decade, runtime, country, rating): a cut would need films past the piece to know the total, so this prefix path refuses it (completeOptionPage can answer when all candidates are present). → page() of the piece, with the total.
 */
export function optionPage(index, catalogId, optionId, extras, opts) {
  const opt = pieceOption(index, catalogId, optionId, extras);
  if (!opt) return null;
  if (compileFilters(extras, index.meta || {}).active) return null;
  const out = page(index, catalogId, extras, opts);
  if (!out) return null;
  const total = includeSeen(extras, index) ? opt.totalAll : opt.total;
  if (out.total > total || (out.total < total && out.total < skipOf(extras) + PAGE)) return null; // a piece that shows more than the option, or a page it cannot fill
  return { ...out, total };
}

/** One page of a catalog: { metas-to-be: entries, context } for `skip` … `skip` + 100. null when the catalog does not exist. */
export function page(index, id, extras, opts) {
  const sel = select(index, id, extras, opts);
  if (!sel) return null;
  const skip = skipOf(extras);
  const meta = index.meta || {};
  return { entries: sel.entries.slice(skip, skip + PAGE), total: sel.entries.length, context: { ...sel.context, separator: meta.separator || "\n\n" } };
}
