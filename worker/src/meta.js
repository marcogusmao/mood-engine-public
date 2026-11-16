// An index entry → the meta object Stremio shows in a catalog.
//
// The description (Marco, 20/10/2026, "description v3"; lib/describe.js is the build's side) is a card of two lines, one separator (config.json → descriptionSeparator) and the synopsis.
// Each line of the card ends with a full stop (on the Mac the line breaks turn into spaces):
//
//   Akira Kurosawa · 2h22 · Toshirō Mifune, Tatsuya Nakadai, Kyōko Kagawa.                     the credits: built HERE from the entry's columns (director, runtime) and the actors of `desc`
//   Mood: 🌃 Night drive · Crime, Thriller, Mystery · Film noir, Investigation, Anxious.  the mood, the genres, the mood words: line 2 of `desc`, with the mood of the catalog in front of it
//
// The credits line is built here, not stored in the index (the director and the runtime are columns already), by creditsLine(), the same function as lib/describe.js (a test compares them
// over every combination): up to three actors from the first line of `desc`, two when the finished line passes 80 characters (the second never goes: Marco, 21/10/2026 ~15:00 UTC, D4). The entry's `desc` is "<actors>\n<line 2>" + separator
// + synopsis (lib/describe.js liveDescription(): positional, the actors empty when the film has none); line 2 of a film's general text is "Mood: <the mood the film fits best> · <genres> · <up to four mood words>" (an initial capital each;
// Marco, 21/10/2026 ~15:00 UTC, D3: lib/best-mood.js, ONE ranking for both addon families, written with the mood's Board row's name in the v2 family when the Board has one, ~22:15 UTC; no label for a film that fits no mood). Every catalog that is no mood shows it as it is, the first three words (the one that IS the mood's name dropped).
// The Moods menu (context.kind "moods": `name` is the mood's) puts ITS mood in the best fit's place and drops the word that IS its name (Noir in the Noir menu) before it shows three; the genre that is the leading mood's name is left out (D5: "Mood: 😂 Comedy · Drama"), which is why the Worker recomputes the genre group from the entry's `genres` column (rewords(), the same rules as lib/describe.js pickWords() and genresShown(); a parity test compares them over every combination).
// A Board row's text from the index (`rowDesc`) has its own finished line 2, which starts "Mood: <the row's mood>" when the row is a mood, with the mood the film fits best when it is not, and in the nine reason rows with the reason ("Loved by Lynch and Scorsese · Drama, Crime · Investigation, Anxious.", "Cannes Palme d'Or 1953 · …"; lib/plan.js REASON_ROWS, Marco 20 and 21/10/2026); in a profile the profile's name for the row ("Warm and funny") takes the Board's name's place in that "Mood:" (boardName).
// A profile's Tonight (worker/src/profiles.js hands `context.drawn`, Marco, 21/10/2026 ~19:40 UTC, C) does the same with the mood each pick was DRAWN for, in the profile's name for that mood ("Mood: Neon and tension"), not the best fit of the film's text.
// A film that fits no mood has a line that starts with the genres in every catalog but the Moods menu and a profile's Tonight. There is no reasons line (the place in a list, what the friends said, "on your watchlist…")
// and no numbers line (IMDb, Friends, want to see).
// A synopsis that starts "MUBI:" gets a long dash in front of it (Marco, 28/10/2026, 20:26 UTC; dashMubi() below): on the Mac and the web the blank line is a space, and the credits ran into "MUBI:".

import { LIST_NAMES } from "./list-names.js";
import { moodGroup, link, searchLink, backgroundOf } from "./mood-group.js";
import { dryName } from "./profiles.js";
import { takenWords, listChip } from "./text.js";
import { plainName } from "./plain-name.js";

const metahub = (tt) => `https://images.metahub.space/poster/medium/${tt}/img`; // the poster service of the static addon, for a film that has no cover with the ratings on it

// ── the credits line (the same as lib/describe.js creditsLine) ──

export const CREDITS_CHARS = 80;
export const CAST_NAMES = 3;
export const CAST_MIN = 2; // the 80 characters decide only whether the THIRD actor comes in (Marco, 21/10/2026 ~15:00 UTC, D4)
const DIRECTORS_SHOWN = 2;
export const MOOD_LABEL = "Mood: ";
export const CAST_SEP = "; "; // between the actors in `desc` (lib/describe.js CAST_SEP): a name can hold ", "

export function duration(minutes) {
  const m = Math.round(Number(minutes));
  if (!(m > 0)) return "";
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}

const names = (list) => (Array.isArray(list) ? list : []).map((n) => String(n == null ? "" : n).trim()).filter(Boolean);
const stop = (line) => (line && !/[.!?…]$/.test(line) ? `${line}.` : line);

/** "Akira Kurosawa · 2h22 · Toshirō Mifune, Tatsuya Nakadai, Kyōko Kagawa.": director(s), duration and the first three actors, ended by a full stop; the third goes when the line passes 80 characters, two stay whatever the length. */
export function creditsLine({ directors, runtime, cast } = {}) {
  const head = [names(directors).slice(0, DIRECTORS_SHOWN).join(", "), duration(runtime)].filter(Boolean);
  const actors = names(cast).slice(0, CAST_NAMES);
  const line = (n) => stop([...head, actors.slice(0, n).join(", ")].filter(Boolean).join(" · "));
  for (let n = actors.length; n > CAST_MIN; n--) if (line(n).length <= CREDITS_CHARS) return line(n);
  return line(Math.min(CAST_MIN, actors.length));
}

// ── the mood words (the same as lib/describe.js plain() and pickWords()) ──

const plain = (x) => plainName(String(x == null ? "" : x));
/**
 * Up to `n` words for a row: the word that IS the row's mood (same letters, no emoji, no capitals) is skipped, and so is a word that is one of the genres shown on the same line
 * (the first three of `genres`: "Romance" after "Drama, Romance ·"), then the first n. The same as lib/describe.js pickWords().
 */
export function pickWords(list, mood, n = 3, genres = []) {
  const own = plain(String(mood || "").replace(/^Tonight · /, ""));
  const shown = new Set(names(genres).slice(0, 3).map(plain));
  return names(list).filter((w) => (!own || plain(w) !== own) && !shown.has(plain(w))).slice(0, n);
}
/**
 * Singular and plural are ONE name for the genre rule (Marco, 21/10/2026 ~19:40 UTC, A): "Documentaries" (the mood) and "Documentary" (the genre) are the same, "Comedies" and "Comedy" too. Only the LAST word may differ,
 * by a plural ending ("ies" for "y", "es" or "s" for nothing, never "ss"). The same as lib/describe.js sameName(); a parity test runs both over every name config.json gives a mood or a Board row against every TMDB genre.
 */
const pluralForms = (w) => new Set([w, ...(w.endsWith("ies") ? [`${w.slice(0, -3)}y`] : []), ...(w.endsWith("es") ? [w.slice(0, -2)] : []), ...(w.endsWith("s") && !w.endsWith("ss") ? [w.slice(0, -1)] : [])]);
export function sameName(a, b) {
  const x = plain(a), y = plain(b), i = x.lastIndexOf(" ") + 1, j = y.lastIndexOf(" ") + 1;
  if (x === y) return true;
  if (!x || !y || x.slice(0, i) !== y.slice(0, j)) return false;
  const forms = pluralForms(y.slice(j));
  return [...pluralForms(x.slice(i))].some((w) => forms.has(w));
}
/**
 * The genres of line 2: the first three, without the one that IS the name of the mood leading the line (Marco, 21/10/2026, D5: "Mood: 😂 Comedy · Comedy, Drama" says Drama only; singular and plural count as one, A of
 * 21/10/2026 ~19:40 UTC: "Mood: 🎥 Documentaries · Documentary, History" says History only). The same as lib/describe.js genresShown().
 */
export function genresShown(genres, mood = "") {
  const own = String(mood || "").replace(/^Tonight · /, "");
  return names(genres).slice(0, 3).filter((g) => !plain(own) || !sameName(g, own));
}

/**
 * Line 2 of a film's general text is "[Mood: <the mood the film fits best> · ]<genres> · <words>." with up to four words (the build keeps one spare): the Worker shows three, and drops the one that is the name of the lead mood
 * (the film's own best-fit mood, or the mood of the Moods menu, `mood`, which takes the best-fit's place). The genres are the entry's `genres` column, minus the one that is the lead mood's name, which is what the build wrote first; a line
 * that does not start with them (or a film with no genres and a line that is not words) is left as it is. A finished line of a Board row (it starts with "Mood: <the row's mood>", or with a reason) goes through here unchanged.
 */
export function rewords(line, e, mood) {
  if (!line) return line;
  const groups = line.replace(/\.$/, "").split(" · ");
  const lead = groups[0].startsWith(MOOD_LABEL) ? groups.shift().slice(MOOD_LABEL.length) : ""; // the mood the build put there: the film's best fit, or the row's
  const first = genresShown(e.genres, lead).join(", ");
  let rest = groups;
  if (first) {
    if (rest[0] !== first) return line;
    rest = rest.slice(1);
  }
  if (rest.length > 1) return line;
  const target = mood || lead; // the Moods menu's mood replaces the best fit
  const kept = pickWords(rest.length ? rest[0].split(", ") : [], target, 3, names(e.genres).slice(0, 3)).join(", ");
  return stop([target ? `${MOOD_LABEL}${target}` : "", genresShown(e.genres, target).join(", "), kept].filter(Boolean).join(" · "));
}

/** A `desc` taken apart: { cast: line 1, rest: line 2, synopsis }, each "" when missing. */
let lastCard = null; // the card of the last text split: a general card is split by compose() and read again by cardTerms() for its words (28/10/2026)
function splitCard(desc, separator) {
  if (lastCard && lastCard.desc === desc && lastCard.separator === separator) return lastCard.out;
  const out = splitCardOf(desc, separator);
  lastCard = { desc, separator, out };
  return out;
}
function splitCardOf(desc, separator) {
  const text = desc || "";
  // the card is two lines ("<actors>\n<line 2>", either may be empty) and the first separator AFTER them ends it: an empty line 2 leaves "\n" + the separator, which starts with "\n"
  const nl = text.indexOf("\n");
  let at = nl < 0 ? -1 : text.indexOf(separator, nl + 1);
  if (at < 0) at = text.indexOf(separator);
  const card = at < 0 ? text : text.slice(0, at);
  const synopsis = at < 0 ? "" : text.slice(at + separator.length);
  const [cast = "", rest = ""] = card.split("\n");
  return { cast, rest, synopsis };
}

/** The whole description: the credits from the columns, line 2 (with the catalog's mood in front when the catalog is a mood), the separator and the synopsis. */
export function compose(e, context, desc) {
  const separator = context.separator ?? "\n\n";
  const { cast, rest, synopsis } = splitCard(desc, separator);
  // the mood that takes the film's best fit's place: the Moods menu's, or (a profile's Tonight, Marco, 21/10/2026 ~19:40 UTC, C) the one this pick was drawn for (`context.drawn`: tt → the mood's name, profiles.js)
  const moods = (context.kind === "moods" && context.name) || (context.drawn && context.drawn.get(e.tt)) || "";
  let second = rewords(rest, e, moods);
  if (moods) {
    // rewords() put that mood in place of the film's best fit; a line it could not read gets the label in front (and a film with no line 2 gets the label alone)
    if (!second.startsWith(MOOD_LABEL)) second = second ? `${MOOD_LABEL}${moods} · ${second}` : stop(`${MOOD_LABEL}${moods}`);
  } else {
    let renamed = false;
    if (context.boardName && context.name && context.name !== context.boardName) {
      // a profile says its own name for a Board row ("Warm and funny"): in a mood row the Board's name inside "Mood: …" gives way
      const lead = `${MOOD_LABEL}${context.boardName}`;
      if (rest === `${lead}.` || rest.startsWith(`${lead} · `)) { second = `${MOOD_LABEL}${context.name}${rest.slice(lead.length)}`; renamed = true; }
    }
    if (!renamed && context.relabel && context.relabel.size) {
      // every other row of a profile (Under 100 min, Watchlist, a theme, Closet, What it is, a Board row that is no mood; Marco, 21/10/2026 ~22:15 UTC): when the label names a mood of the PROFILE, the profile's name for it takes the build's name's place
      // ("Mood: 🌃 Night drive" is "Mood: Neon and tension"), the genre group and the words recomputed for the new name like the Moods menu's (rewords); a label that names a mood the profile does not have stays as the build wrote it
      const first = rest.replace(/\.$/, "").split(" · ")[0];
      const to = first.startsWith(MOOD_LABEL) ? context.relabel.get(first.slice(MOOD_LABEL.length)) : undefined;
      if (to) second = rewords(rest, e, to);
    }
  }
  // The card with chips (context.menus, toMeta) says the mood, the genres and the words as chips, so the line "Mood: …" is not written (Marco, 28/10/2026): the card keeps the credits, then the separator and the synopsis.
  // A line that does not start with "Mood: " (a reason row's "Loved by Lynch · …", "Cannes Palme d'Or 1953 · …") is the row's own reason and stays.
  if (context.menus && second.startsWith(MOOD_LABEL)) second = "";
  const credits = creditsLine({ directors: String(e.director || "").split(", "), runtime: e.runtime, cast: cast.split(CAST_SEP) });
  const body = [credits, second].filter(Boolean).join("\n");
  return [body, body ? dashMubi(synopsis) : synopsis].filter(Boolean).join(separator);
}

/** A synopsis that starts "MUBI: …" gets a long dash in front when something comes before it (Marco, 28/10/2026, 20:26 UTC): on the Mac and the web the blank line turns into one space ("Watanabe. — MUBI: Meaty action…"),
 * on Nuvio and the TV the paragraph keeps its break and starts "— MUBI:". Any other synopsis is left as it is, and so is one that already starts with the dash (the film page's "… — MUBI" is a different text, page.js). */
export const MUBI_LEAD = "MUBI:";
export const MUBI_DASH = "\u2014 ";
function dashMubi(synopsis) {
  return synopsis.startsWith(MUBI_LEAD) ? `${MUBI_DASH}${synopsis}` : synopsis;
}

// ── the chips of the card (Marco, 28/10/2026, "T2") ──
//
// The side preview of the Discover (stremio-web MetaPreview, mode compact) shows the CATALOG ITEM, not the film page, and draws the item's `links` as groups of chips under the description. When an item
// carries `links` the core ignores its `imdbRating` and `genres` (docs/2026-10-20-meta-pagina-de-detalhe-spec.md, line 37 of the stremio repo), so the item carries the `imdb` link too, or "7.9 IMDb" would go.
// `imdbRating` and `genres` stay on the item for the clients that read those fields (Nuvio, Fusion).
// Groups, in order: imdb, Mood (mood-group.js: moods, genres, terms; the film page's rules and order, and its chips where the card reads the same menus: not in the profiles and the old pieces, see mood-group.js), Lists (up to three, as on the film page). No Ratings group and no Letterboxd average (T2, "sem nota").
// The terms are the words of line 2 of the film's general `desc` (the build writes them there, up to four, after the genres), so no new data in the index and the same words as the film page's `kw`.
// The lists are the critic and director ones, as on the film page (the build's `listIds` keeps only those; here list-names.js says who vouches, the same table as config.json: 147 of 147 equal).

const CHIP_LISTS = 3;
const TRUSTED_LISTS = new Set(LIST_NAMES.filter((l) => l.trust === "critic" || l.trust === "director").map((l) => l.id));
const chipMenus = new WeakMap();
const nonEmpty = (x) => typeof x === "string" && x.trim() !== "";
/** What the chips of an index need, made once per index object: the moods by id, the Moods menu (label and order), the trusted lists in the index's order. An index with no `moodMenu` (the legacy files) uses its `moods`. */
function menusOf(index) {
  let m = chipMenus.get(index);
  if (m) return m;
  const moods = (Array.isArray(index.moods) ? index.moods : []).filter((x) => x && nonEmpty(x.id) && nonEmpty(x.name));
  const menu = Array.isArray(index.moodMenu) && index.moodMenu.length ? index.moodMenu : Array.isArray(index.moods) ? index.moods : [];
  const lists = new Map();
  // A list chip says its short name (22/10/2026), the full name of a build that has none; the search opens the list by either. A short that is a mood's or a genre's word is SAID but not searched: the term is the full name (text.js listChip).
  const taken = takenWords(index.moods, index.moodMenu);
  (Array.isArray(index.lists) ? index.lists : []).forEach((l, order) => { if (l && TRUSTED_LISTS.has(l.id) && nonEmpty(l.label)) lists.set(l.id, { ...listChip(l, taken), order }); });
  m = { byId: new Map(moods.map((x) => [x.id, { ...x, dry: dryName(x.name), key: plain(dryName(x.name)) }])), menu: new Map(menu.filter((x) => x && nonEmpty(x.id) && nonEmpty(x.label)).map((x, order) => [x.id, { label: x.label, order }])), lists };
  chipMenus.set(index, m);
  return m;
}

/**
 * The words of line 2 of a film's general text, after the mood and the genres: "Mood: ☀️ Lift me out · Comedy · Joyous, Whimsical, Restaurant." gives ["Joyous", "Whimsical", "Restaurant"].
 * Read like rewords() reads the line: the optional "Mood: …" group, then the genre group the entry's `genres` column gives; a line that does not read that way (or has more groups) gives [].
 */
export function cardTerms(e, desc, separator = "\n\n") {
  const { rest } = splitCard(desc, separator);
  if (!rest) return [];
  const groups = rest.replace(/\.$/, "").split(" · ");
  const lead = groups[0].startsWith(MOOD_LABEL) ? groups.shift().slice(MOOD_LABEL.length) : "";
  const first = genresShown(e.genres, lead).join(", ");
  if (first) {
    if (groups[0] !== first) return [];
    groups.shift();
  }
  return groups.length === 1 ? groups[0].split(", ").filter(Boolean) : [];
}

/** The `links` of a catalog item: imdb, the Mood group, the Lists group. [] when the film has none of them. `context.menus` is the index the catalog was read from. */
export function cardLinks(e, context) {
  const links = [];
  if (e.imdbRating != null) links.push(link("imdb", e.imdbRating.toFixed(1), `https://imdb.com/title/${e.tt}`));
  const { byId, menu, lists } = menusOf(context.menus);
  const genres = Array.isArray(e.genres) ? e.genres : [];
  // a profile's Tonight: the mood each pick was drawn for (profiles.js `drawnMood`, tt → mood id) is the first chip, in the profile's name for it
  links.push(...moodGroup({ mo: e.moodFits || [], g: genres, kw: cardTerms(e, e.desc, context.separator) }, byId, menu, context.relabel, context.drawnMood && context.drawnMood.get(e.tt)));
  const inLists = (e.listIds || []).filter((id) => lists.has(id)).sort((a, b) => lists.get(a).order - lists.get(b).order).slice(0, CHIP_LISTS);
  for (const id of inLists) { const { text, term } = lists.get(id); links.push(link("Lists", text, searchLink(term))); }
  return links;
}

export function toMeta(e, context = {}) {
  const desc = context.descs && context.descs.has(e.tt) ? context.descs.get(e.tt) : e.desc;
  const description = compose(e, context, desc);
  const links = context.menus ? cardLinks(e, context) : [];
  return {
    id: e.tt,
    type: "movie",
    name: e.name,
    poster: e.poster || metahub(e.tt),
    posterShape: "poster",
    // The image behind the title (Marco, 14/11/2026: on the Samsung TV a card without one showed the POSTER enlarged there, "it shouldnt do that"): the film page's own rule and source (mood-group.js backgroundOf),
    // on every film card of every catalog. The poster above is not touched. Not seen on the TV when it was written.
    // An id that is not "tt" and up to 10 digits has no address (backgroundOf gives undefined), and the card goes out without the field, like the other undefined ones here.
    background: backgroundOf(e.tt),
    releaseInfo: e.year ? String(e.year) : undefined,
    runtime: e.runtime ? `${e.runtime} min` : undefined,
    genres: e.genres && e.genres.length ? e.genres : undefined,
    imdbRating: e.imdbRating != null ? e.imdbRating.toFixed(1) : undefined,
    // Always a string, "" for a film with no card and no synopsis: it is what the static addon writes (lib/publish.js toMeta -> lib/describe.js describe()), and the two are compared film by film
    // (test/real-index.test.js, test/parity.test.js). `description || undefined` left the key out of the JSON for such a film: the one empty card of the Board, East of Eden 2026 (tt21097264, no TMDB record:
    // no credits, no genres, no synopsis), 22/10/2026. Stremio reads "" and an absent key the same (nothing under the title); the contract here is "same as the static addon".
    description,
    ...(links.length ? { links } : {}),
    ...(context.defaultVideo ? { behaviorHints: { defaultVideoId: e.tt } } : {}),
  };
}
