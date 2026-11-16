// The text Stremio shows under a film (Marco, 20/10/2026, "descrição v3": on the TV only the first line and a half of the description appear on the
// focused poster, so what was in the later lines never showed).
//
//   1  the credits   Akira Kurosawa · 2h22 · Toshirō Mifune, Tatsuya Nakadai, Kyōko Kagawa.      director(s) · duration · the first three names of the TMDB cast
//   2  the mood      Mood: 🌃 Night drive · Crime, Thriller, Mystery · Film noir, Investigation, Anxious.      the row's mood (else the mood the film fits best, else the reason) · up to three TMDB genres · up to three of the film's mood words
//   ─  one blank line (config.json → descriptionSeparator), the only one
//   3  the synopsis  MUBI: A masterclass in tension …      MUBI's Our Take, else Letterboxd's synopsis, else TMDB's overview; two sentences at most, 280 characters at most
//
// Lines 1 and 2 are the "card", joined by a single line break, and each ENDS WITH A FULL STOP: on the Mac the line breaks of a description turn into
// spaces, and the stop keeps the card readable when the lines run together (the detail page's specification, 20/10/2026; the TV and Android keep the break).
// A line with nothing to say is left out, and so is its break.
//
// Line 1 has no country, year or ★ (Stremio shows the year and the rating beside the description). Up to three actors; when the finished line (full stop
// included) is longer than 80 characters the third goes; TWO stay even when the line is still longer (CREDITS_CHARS, CAST_MIN; Marco, 21/10/2026 ~15:00 UTC, D4: the second used to go too).
// Line 2 starts "Mood: <name>" with the mood of the row in a row that is a mood (`item.mood`, stripped of the "Tonight · " of the Tonight row; a row such as Friends loved is
// not a mood: plan.js marks its items `moodIsRow`) and, in every other row, with the mood the film FITS BEST (`item.fitMood`: lib/best-mood.js, the highest norm of the 30 moods; Marco, 21/10/2026 ~15:00 UTC, D3);
// a film that fits no mood starts with its genres, no label. The genre that is the name of that mood is left out of the line (D5: "Mood: 😂 Comedy · Drama", genresShown()). In the NINE rows whose meaning IS the reason (plan.js REASON_ROWS marks their items `leadsWithReason` with the kind of the reading; the
// "Loved by directors" Discover menu too) it starts with the reason instead of "Mood:" (Marco, 20/10/2026, 20:40 UTC for "Loved by your directors" and "Friends loved"; 21/10/2026 ~15:00 UTC, D1, for Friend's top picks, Friends
// can't agree, Friends want to see this too, Friends watched this month and this week, the prize row and Actor of the week; reasonLead() below has each form):
// "Loved by Lynch and Scorsese · Drama, Crime · Investigation, Anxious." (the director's love up to its first " · ", the source left out), "Loved by a friend 5★, Cacau 5★ +1 more · Drama." (Friends loved: the first two friends, the others counted; ONE function for
// the friends and the directors, lib/loved-by.js, D2), "Cannes Palme d'Or 1953 · …", "With Tilda Swinton · …".
// The third group is the film's MOOD WORDS, never TMDB's raw keywords (Marco, 20/10/2026: "rape, christianity, monk" for Andrei Rublev and "beach, mediterranean, fascism" for Porco Rosso read badly),
// with an initial capital ("Investigation, Anxious"): the words of config.json's moods (weight above zero) that the film's TMDB keywords match, heaviest first, from ONE list for both addon
// families (lib/index-export.js `descMoods`, which build.js fills with EVERY mood of config.json, 30 today, by Marco's decision of 21/10/2026 01:35 UTC: 6,630 of the 10,034 TMDB records with keywords get a word against 5,143 with the nine legacy moods (records, not cards); the legacy `keywords` column keeps the nine legacy moods' words, for the search; test/legacy-parity.test.js lets the legacy files differ from the reduced build in the word group of line 2 (its last group, ONE group) and in the best-fit label of a line that is not in a mood row, and in nothing else: not the label of a mood row, not the reason that opens a line, not the genres, not a third line), put on the plan items by build.js from `descWords`. wordsForDesc() cleans the list (a word contained in another goes, the
// longer, more specific one stays: "noir" inside "film noir", "concert" inside "concert film") and keeps four; pickWords() drops the word that IS the row's mood ("Noir" in the Noir row: no capitals,
// no emoji) and a word that is one of the genres shown on the line ("Romance" after "Drama, Romance ·"; wordsForDesc takes the genres too, so the spare fourth word takes its place) and takes three. A film with no word has a line 2 with the mood and the genres only. Groups are separated by " · ", the items of a group by ", ".
// The personal reasons ("you rate…", "on your watchlist since…", what the friends said) and the numbers are not in the description any more, EXCEPT as the lead of the nine reason rows above (Marco, 20/10/2026 20:40 UTC and 21/10/2026 ~15:00 UTC).
//
// What this change deleted and what stayed (20/10/2026, for the detail page, which reads some of it): DELETED from this file whyLine() (the old third line: row name, "Loved by…", two
// reasons), numbersLine(), factsLine(), surname(), FACTS_CHARS, MAX_REASONS, and from worker/src/meta.js numbersLine(), factsLine(), friendsLine(), ownWords() (the place in a list and the
// friends' words), all recoverable from git history before the commit "Description v3". STAYED: the reasons themselves, as data on the plan items (`why`, `loved`, `ratings`, `mood`) and
// lib/pool.js sourceWhy() / taste() / toItem() that write them, so a page that wants to say "on your watchlist since…" or "Loved by Lynch…" builds its own line from the item;
// moodLine(), creditsLine(), duration(), synopsis() and synopsisText() are exported from here for the same reason. (pickKeywords(), a first version of this change that read TMDB's raw keywords, was
// dropped the same day, Marco's decision: the third group is the film's mood words.)
//
// The live addon (Worker): `liveDescription()` is the `desc` of the index, "<cast>\n<line 2>" + separator + synopsis, without line 1, which the Worker
// builds from the entry's columns (director, runtime) and the cast of `desc` with creditsLine(); line 2 of a generic film opens with the mood the film fits best (four words, the lead mood's own word kept: keepOwnWord) and the Worker
// puts the mood of the catalog it serves (the Moods menu) in its place; a Board row's text (`rowDesc`) has its own line 2, finished.

const SYNOPSIS_CHARS = 280;
const SYNOPSIS_SENTENCES = 2;
const CREDITS_CHARS = 80;
const CAST_NAMES = 3;
const CAST_MIN = 2; // the 80 characters decide only whether the THIRD actor comes in (Marco, 21/10/2026 ~15:00 UTC, D4): two stay whatever the length
const GENRES_SHOWN = 3;
const KEYWORDS_SHOWN = 3;
const WORDS_KEPT = 4; // the live `desc` keeps four words so that the Moods menu can drop the one that is the mood's own name and still show three
const CARD_BREAK = "\n";
const CAST_SEP = "; "; // between the actors in the live `desc`: a name can hold ", " ("Henry Louis Gates, Jr.", "Tyler, The Creator"); none holds a semicolon (cache/tmdb.json, 20/10/2026)
const MUBI_CREDIT = "MUBI: ";
const DIRECTORS_SHOWN = 2;
const MOOD_LABEL = "Mood: ";

const ABBREVIATIONS = /^(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|Mt|vs|No|Inc|Ltd|Co|Prof|Gen|Col|Sgt|Capt|Lt|Rev|Fr|Mme|Mlle|Mons)$/i;

/** A text cut into sentences. A full stop after an abbreviation (Dr.), an initial (J. Edgar) or before a lower-case word is not an end. */
function sentences(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const out = [];
  let start = 0;
  const re = /([.!?…]+["”’)\]]*)\s+(?=\S)/g;
  let m;
  while ((m = re.exec(t))) {
    const word = (t.slice(start, m.index).match(/(\S+)$/) || [])[1] || "";
    const next = t[re.lastIndex];
    const dot = m[1][0] === ".";
    if (dot && (ABBREVIATIONS.test(word) || /^[A-Z]$/.test(word) || /^(?:[A-Za-z]\.)+[A-Za-z]$/.test(word))) continue;
    if (dot && /[a-zà-ÿ]/.test(next)) continue;
    out.push(t.slice(start, m.index + m[1].length));
    start = re.lastIndex;
  }
  if (start < t.length) out.push(t.slice(start));
  return out;
}

const ends = (s) => /[.!?…]["”’)\]]*$/.test(s);

/**
 * The synopsis: up to `maxSentences` whole sentences that fit in `maxChars`. When the first sentence alone is longer, it is cut
 * at a word and closed with a full stop. Always ends in . ! ? or …; "" when there is no text.
 */
function synopsis(text, { maxChars = SYNOPSIS_CHARS, maxSentences = SYNOPSIS_SENTENCES } = {}) {
  const parts = sentences(text);
  if (!parts.length) return "";
  let out = "";
  for (let i = 0; i < parts.length && i < maxSentences; i++) {
    const next = out ? `${out} ${parts[i]}` : parts[i];
    if (next.length > maxChars) {
      if (out) break;
      const cut = parts[i].slice(0, maxChars - 1).replace(/\s+\S*$/, "").replace(/[\s,;:–—-]+$/, "");
      return (cut || parts[i].slice(0, maxChars - 1)) + ".";
    }
    out = next;
  }
  return ends(out) ? out : out + ".";
}


const SOURCES = require("./synopsis-source");
const { lovedBy, peopleLine } = require("./loved-by");

// ── line 1: the credits ─────────────────────────────────────────────────────

/** 107 → "1h47"; 120 → "2h00"; 52 → "52m"; nothing known or not above zero → "". */
function duration(minutes) {
  const m = Math.round(Number(minutes));
  if (!(m > 0)) return "";
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}

const names = (list) => (Array.isArray(list) ? list : []).map((n) => String(n == null ? "" : n).trim()).filter(Boolean);

/** A line ends with a full stop (one that already ends a sentence is left as it is: "Elisha Cook Jr." stays whole). */
const stop = (line) => (line && !/[.!?…]$/.test(line) ? `${line}.` : line);

/**
 * "Akira Kurosawa · 2h22 · Toshirō Mifune, Tatsuya Nakadai, Kyōko Kagawa.": the director(s) (two at most, whole names), the duration and the first three
 * actors, only what exists, ended by a full stop. When the finished line is longer than CREDITS_CHARS (80) the THIRD actor goes; two stay whatever the length
 * (Marco, 21/10/2026 ~15:00 UTC, D4: until then the second went too and 39 films of the index of 21/10/2026 showed one actor: MEASURED on the offline build of 878b347, the 39 films whose two-actor line passes 80 characters; the 38 of the questionnaire was the count of the review of 3a1d497, not rechecked then), and the director and the duration are never cut.
 * A film with one actor in the cast has one. `cast`: names, any number (the first three count).
 * The Worker has the same function (worker/src/meta.js creditsLine); a test compares them.
 */
function creditsLine({ directors, runtime, cast } = {}) {
  const head = [names(directors).slice(0, DIRECTORS_SHOWN).join(", "), duration(runtime)].filter(Boolean);
  const actors = names(cast).slice(0, CAST_NAMES);
  const line = (n) => stop([...head, actors.slice(0, n).join(", ")].filter(Boolean).join(" · "));
  for (let n = actors.length; n > CAST_MIN; n--) if (line(n).length <= CREDITS_CHARS) return line(n);
  return line(Math.min(CAST_MIN, actors.length));
}

const creditsOf = (item) => creditsLine({ directors: item.directors, runtime: item.runtime, cast: item.cast });

/** "Toshirō Mifune; Tatsuya Nakadai; Kyōko Kagawa" for the actors part of the live `desc`: the first three names, joined by CAST_SEP (the Worker splits on it and shows them with ", "). */
function castLine(cast) {
  return names(cast).slice(0, CAST_NAMES).join(CAST_SEP);
}

// ── line 2: the mood, the genres and the keywords ──────────────────────────

const TONIGHT = /^Tonight · /;
/** The mood the item is shown under: `item.mood` ("🌃 Night drive"; "Tonight · ☀️ Lift me out" is "☀️ Lift me out"), unless the row is not a mood (`moodIsRow`: the name is the row's, "Friends loved"). "" when none. */
function moodOf(item) {
  if (!item || item.moodIsRow) return "";
  return String(item.mood == null ? "" : item.mood).replace(TONIGHT, "").trim();
}

/** "Film Noir" and "film-noir" and "🌃 Noir" compare as words: lower case, letters and digits only, one space. */
const plain = (x) => String(x == null ? "" : x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const capital = (x) => (x ? x[0].toLocaleUpperCase("en") + x.slice(1) : x);

/**
 * The words of the description's third group, cleaned: in the given order, a word that is contained in another one of the list goes and the longer, more specific one stays at its own place
 * (whole words: "noir" inside "film noir" or "neo-noir", "concert" inside "concert film"; the same word twice once), then the first `keep` (WORDS_KEPT). Lower case in, lower case out.
 */
const holds = (long, short) => ` ${plain(long)} `.includes(` ${plain(short)} `); // whole words: "noir" is inside "neo-noir", "art" is not inside "party"
function wordsForDesc(list, keep = WORDS_KEPT, genres = []) {
  const shown = new Set(names(genres).slice(0, GENRES_SHOWN).map(plain));
  const all = names(list).filter((w) => !shown.has(plain(w))); // a word that repeats a genre of the same line goes before the cut to `keep`, so the spare one takes its place
  const out = [];
  for (const w of all) {
    const p = plain(w);
    if (!p || out.some((o) => holds(o, w))) continue; // already there, or inside a longer one that is
    for (let i = out.length - 1; i >= 0; i--) if (holds(w, out[i])) out.splice(i, 1); // it holds a shorter one: the shorter goes
    out.push(w);
  }
  // keep the order of the original list (the splice above moved nothing, a later long word is appended: put the survivors back in list order)
  return all.filter((w, i) => out.includes(w) && all.indexOf(w) === i).slice(0, keep);
}

/**
 * Up to `n` words for a row: the word that IS the row's mood (same letters, no emoji) is skipped, and so is a word that is one of the genres shown on the same line
 * ("Romance" after "Drama, Romance ·": the mood Swoon has the word "romance" and TMDB has the genre; 97 films said it twice on 21/10/2026), then the first n.
 * `genres`: the genres of the line, as shown (the first three count). The Worker has the same function (worker/src/meta.js pickWords); a test compares them.
 */
function pickWords(list, mood, n = KEYWORDS_SHOWN, genres = []) {
  const own = plain(String(mood || "").replace(TONIGHT, ""));
  const shown = new Set(names(genres).slice(0, GENRES_SHOWN).map(plain));
  return names(list).filter((w) => (!own || plain(w) !== own) && !shown.has(plain(w))).slice(0, n);
}

const MORE = /^\+(\d+) more$/;
const LEAD_PEOPLE = 2; // the friends named on a lead; the others are the "+N more"
const splitGroups = (text) => String(text == null ? "" : text).split(" · ").map((x) => x.trim()).filter(Boolean);

/** "a friend 5★ · Cacau 5★ · dylan gelula 5★ · +14 more" (already split) → { named: the three, total: 17 }. */
function peopleOf(groups) {
  let extra = 0;
  const named = [];
  for (const g of groups) { const m = MORE.exec(g); if (m) extra += Number(m[1]); else named.push(g); }
  return { named, total: named.length + extra };
}

/**
 * What leads line 2 in the rows whose meaning is the reason: `item.leadsWithReason` (lib/plan.js REASON_ROWS) says which kind. The lead is the item's first reason (`why[0]`, the director's `loved` for the
 * directors), written with an initial capital and, for people, by ONE function (lib/loved-by.js; Marco, 21/10/2026, D2): the friends named are the first two, the rest "+N more".
 *   loved   "Loved by Lynch and Scorsese" (the directors: `item.loved` up to its first " · ") | "Loved by a friend 5★, Cacau 5★ +1 more" (Friends loved: why "loved by A 5★ · B 5★ · C 5★")
 *   pick    "Loved by William 4.5★"  Friend's top picks: the friend of the day and the rating ("William 4.5★ · profile favourite" loses what follows the first part)
 *   pair    "Gustavo 5★, Line 2★"  Friends can't agree: the two extremes and their ratings
 *   want    "On the watchlist of Gustavo, Line and William"  Friends want to see this too
 *   watched "Watched this week by Bia 4.5★, Ana 4★ +3 more"  Friends watched this week / this month ("in the last 30 days")
 *   prize   "Cannes Palme d'Or 1953"  Cannes, Venice and Berlin winners: the festival, the prize and the year, as the row wrote them (lib/special-rows.js loadAwards)
 *   actor   "With Tilda Swinton"  Actor of the week
 * `true` is the old value: the same as "loved". "" for any other item, and for a reason row whose item has no reason (its line then starts as a row without one).
 * The forms of pick, pair, want, watched, prize and actor are the session's wording of Marco's answer "the reason opens line 2 in these rows" (21/10/2026); he chose the rows, not the words.
 */
function reasonLead(item) {
  if (!item || !item.leadsWithReason) return "";
  const kind = item.leadsWithReason === true ? "loved" : String(item.leadsWithReason);
  const first = String((item.why || []).find(Boolean) || "").trim();
  const groups = splitGroups(first);
  if (kind === "loved") {
    const love = String(item.loved || "").split(" · ")[0].trim();
    if (love) return love;
    if (!/^loved by /i.test(first)) return ""; // a first reason that does not say who loves it is not a lead
    const { named, total } = peopleOf(splitGroups(first.replace(/^loved by /i, "")));
    return lovedBy(named.slice(0, LEAD_PEOPLE), total - Math.min(named.length, LEAD_PEOPLE));
  }
  if (!groups.length) return "";
  if (kind === "pick") return lovedBy([groups[0]]);
  if (kind === "pair") return groups.slice(0, 2).join(", ");
  if (kind === "want") return capital(first);
  if (kind === "actor") return `With ${groups[0]}`;
  if (kind === "prize") return first;
  if (kind === "watched") {
    const m = /^(watched .+? by) (.*)$/i.exec(groups[0]);
    if (!m) return capital(first);
    const { named, total } = peopleOf([m[2], ...groups.slice(1)]);
    return peopleLine(capital(m[1]), named.slice(0, LEAD_PEOPLE), total - Math.min(named.length, LEAD_PEOPLE));
  }
  return "";
}

/** The mood the film fits best (`item.fitMood`, put on the plan items by build.js from lib/best-mood.js), the way `moodOf` writes a mood. "" when none. */
const fitOf = (item) => (item && item.fitMood ? String(item.fitMood).replace(TONIGHT, "").trim() : "");

/**
 * Singular and plural are ONE name for the genre rule (Marco, 21/10/2026 ~19:40 UTC, questionnaire, A): "Documentaries" (the mood) and "Documentary" (the TMDB genre) are the same, and so are "Comedies" and "Comedy" or
 * "Westerns" and "Western". The words are compared as `plain` writes them, and only the LAST word may differ, by a plural ending: "ies" for "y", "es" or "s" for nothing (never "ss": "Chess" is not plural).
 * Measured on 21/10/2026, every name config.json gives a mood (30) or a Board row (54) and the names the profiles give the moods, against the 19 genres of TMDB (cache/tmdb.json): the pairs of the SAME letters were Comedy and
 * Horror (D5) and the only pair that is the same word in singular and plural is Documentaries/Documentary: 984 films of the index carried both on the build of 21/10/2026 (878b347 caches), 0 after. The Worker has the same
 * function (worker/src/meta.js sameName); a test compares them over every name against every genre.
 */
const pluralForms = (w) => new Set([w, ...(w.endsWith("ies") ? [`${w.slice(0, -3)}y`] : []), ...(w.endsWith("es") ? [w.slice(0, -2)] : []), ...(w.endsWith("s") && !w.endsWith("ss") ? [w.slice(0, -1)] : [])]);
function sameName(a, b) {
  const x = plain(a), y = plain(b), i = x.lastIndexOf(" ") + 1, j = y.lastIndexOf(" ") + 1;
  if (x === y) return true;
  if (!x || !y || x.slice(0, i) !== y.slice(0, j)) return false;
  const forms = pluralForms(y.slice(j));
  return [...pluralForms(x.slice(i))].some((w) => forms.has(w));
}

/**
 * The genres of line 2: TMDB's first three, without the one that IS the name of the mood leading the line (Marco, 21/10/2026, D5: "Mood: 😂 Comedy · Comedy, Drama" says Drama only; the same rule as the mood word that
 * repeats the mood's name; singular and plural count as one, sameName(): "Mood: 🎥 Documentaries · Documentary, History" says History only). The third genre does not make way for a fourth: the Worker has the first three only
 * (`genres` column). `mood`: the mood that leads, "" when the line has none or leads with a reason. The Worker has the same function.
 */
function genresShown(genres, mood = "") {
  const own = String(mood || "").replace(TONIGHT, "");
  return names(genres).slice(0, GENRES_SHOWN).filter((g) => !plain(own) || !sameName(g, own));
}

/**
 * "Mood: 🌃 Night drive · Crime, Thriller, Mystery · Film noir, Investigation, Anxious.": the mood (with its label), up to three genres, up to `words` mood words (item.keywords: put on the item by
 * build.js; the word that is the mood's own name is skipped; an initial capital), only what exists, ended by a full stop. What opens the line, in this order:
 *   1  the reason, in a row whose meaning is the reason (`leadsWithReason`, reasonLead() above); the mood does not follow it (the session's choice, Marco, 21/10/2026: the line is already longer there)
 *   2  "Mood: <the row's mood>" in a row that IS a mood (moodOf)
 *   3  "Mood: <the mood the film fits best>" in every other row (Marco, 21/10/2026 ~15:00 UTC, D3; `item.fitMood`, lib/best-mood.js)
 *   4  nothing: the line starts with the genres (a film that fits no mood, an item that carries no `fitMood`)
 * The genre that is the name of the mood leading the line is left out (D5, genresShown).
 */
function moodLine(item, words = KEYWORDS_SHOWN, { keepOwnWord = false } = {}) {
  const reason = reasonLead(item);
  const mood = reason ? "" : moodOf(item) || fitOf(item);
  const lead = reason || (mood ? `${MOOD_LABEL}${mood}` : "");
  const genres = genresShown(item.genres, mood).join(", ");
  // keepOwnWord: the film's general text (the live `desc`) keeps the word that is the lead mood's name, because the Moods menu puts ANOTHER mood in the lead's place and the word would be gone; the Worker drops it (worker/src/meta.js rewords)
  const keywords = pickWords(item.keywords, keepOwnWord ? "" : mood, words, item.genres).map(capital).join(", ");
  return stop([lead, genres, keywords].filter(Boolean).join(" · "));
}

// ── the synopsis and the whole ───────────────────────────────────────────────

/**
 * The text the synopsis is cut from: MUBI's Our Take (lib/synopsis-source.js, from cache/mubi.json) with its credit, "MUBI: " at the start of the first
 * sentence (Marco, 13/10/2026; the credit counts toward the 280 characters), else Letterboxd's synopsis (`item.lbSynopsis`), else TMDB's overview.
 */
function synopsisText(item) {
  const take = SOURCES.ourTake(item.id);
  if (take) return `${MUBI_CREDIT}${take}`;
  return (typeof item.lbSynopsis === "string" && item.lbSynopsis.trim()) || item.overview || "";
}

/**
 * The description as the live addon's index stores it (`desc`): "<cast>\n<line 2>", the separator and the synopsis, WITHOUT line 1: the live addon builds it
 * from the entry's columns (director, runtime) and the cast here (creditsLine). The two lines are positional so that the live addon can tell them apart when
 * one is missing: the cast empty when the film has none ("\n<line 2>"). With a synopsis the card ALWAYS exists, even with no cast and no line 2 ("\n"), and the
 * separator is always there before the synopsis: the live addon splits the card from the synopsis by it, and a text that is only a synopsis would be read as a card.
 * Without a synopsis there is a card only when there is something in it. `item.mood` is the mood of a Board row (rowDesc) and nothing for a film's general text.
 */
function liveDescription(item, separator = "\n\n", { words = KEYWORDS_SHOWN, keepOwnWord = false, synopsis: canonicalSynopsis } = {}) {
  const cast = castLine(item.cast), line = moodLine(item, words, { keepOwnWord }), text = canonicalSynopsis === undefined ? synopsis(synopsisText(item)) : canonicalSynopsis;
  const card = line || text ? `${cast}${CARD_BREAK}${line}` : cast;
  return [card, text].filter(Boolean).join(separator);
}

/** The card: the credits and the mood line, each on its own line, joined by a single line break. */
function card(item) {
  return [creditsOf(item), moodLine(item)].filter(Boolean).join(CARD_BREAK);
}

/** The description of one item: the card, then ONE blank line (`separator`, config.json → descriptionSeparator), then the synopsis. */
function describe(item, separator = "\n\n") {
  return [card(item), synopsis(synopsisText(item))].filter(Boolean).join(separator);
}

const SEPARATORS = ["\n\n", " — "];

module.exports = { describe, liveDescription, card, creditsLine, castLine, CAST_SEP, moodLine, moodOf, fitOf, genresShown, sameName, wordsForDesc, pickWords, reasonLead, plain, capital, WORDS_KEPT, synopsis, synopsisText, duration, sentences, SEPARATORS, CREDITS_CHARS, SYNOPSIS_CHARS, CAST_NAMES, CAST_MIN, GENRES_SHOWN, KEYWORDS_SHOWN, MOOD_LABEL };
