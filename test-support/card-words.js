// What a test that compares a legacy file of the 30-mood build with the file of the build reduced to the nine legacy moods may let differ (Marco, 21/10/2026, 01:35 UTC; narrowed by the review of the description v3,
// 21/10/2026; widened by the least that Marco's answers of 21/10/2026 ~15:00 UTC need). Used by test/legacy-parity.test.js (PRODUCTION config) and test/special-rows.test.js ("real build: … every legacy file").
//
// Line 2 of the card is "[lead] · [genres] · [words]." and these may differ, in a legacy file of the two builds, ONLY in:
//   1  the WORD GROUP, the last one: the mood words come from every mood of config.json in both families (Marco, 21/10/2026 01:35 UTC), so the two builds say other words. AT MOST ONE group may follow the genres (the review of
//      21/10/2026 found that cutting everything after the genres forgave a planted extra group; D6 of the same review); a line with more is compared whole.
//   2  the MOOD LABEL "Mood: <name>" of a line that is NOT in a mood row (D3, Marco 21/10/2026 ~15:00 UTC): in the film's general text (`desc`), the lists, the decades, the countries… the label is the mood the film fits best,
//      worked out over the moods the build has (nine in the reduced build, 30 in the other: lib/best-mood.js), so it may be absent, or another, between the two. It must still be the NAME OF A MOOD of config.json. And the genre group
//      goes with it: the genre that is the label's name is left out of the line (D5), so the group is checked against the film's own genres, label by label, and then compared as the film's three genres.
//      NOT forgiven: the label of a MOOD ROW (a legacy mood's row, Tonight, the Moods menu): there both builds write the row's own mood, and any difference is caught. NOT forgiven either: a reason that opens the line.
//
// Not the credits line, not a third card line, not the synopsis, not the order, not the films, not any other column or byte.
//
// `relaxed(buf, rel)` brings a file to its comparable form: the line 2 of every description (the static `description` of a catalog meta; `desc`, `rowDesc` and the directors' texts of an index file) is cut as above, found by the film's
// own genres (the first three, from the meta or from the index column); a line that does not have the shape above, or a film the piece does not hold, is compared whole. The index files go through the row codec (decode, then
// encode): what is compared there is the decoded value of every cell, so the re-spelling of a number ("1.2" for "1.20") or of an empty cell is not seen (limit, BACKLOG 21/10/2026); the catalogs and every other file are compared as
// text, builtAt aside.

const fs = require("fs");
const path = require("path");
const { decode: decodeRows, encode: encodeRows } = require("../lib/index-rows");

const ROOT = path.join(__dirname, "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const SEP = CONFIG.descriptionSeparator || "\n\n"; // between the card and the synopsis (config.json); both builds read the same one
const MOOD_NAMES = new Set([...CONFIG.moods, ...((CONFIG.board && CONFIG.board.moods) || [])].map((m) => m.name)); // the names a "Mood:" label may carry
const STRICT_ROWS = new Set(["tonight", ...((CONFIG.board && CONFIG.board.legacyMoods) || [])]); // the rows of the legacy Board that ARE moods (a Tonight pick says the mood it was drawn for)
const HAS_BUILT_AT = /^data\/(?:index(?:-[A-Za-z0-9_-]+)?|film-languages)\.json$/;
const LABEL = "Mood: ";
const slash = (f) => f.split(path.sep).join("/");
const normalised = (buf) => buf.toString("utf8").replace(/"builtAt":"[^"]*"/g, '"builtAt":"X"');
const plain = (x) => String(x == null ? "" : x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// Singular and plural are one name (Marco, 21/10/2026 ~19:40 UTC, A): "Documentaries" is "Documentary". Written again here, in another shape (the last word's endings stripped, then compared), and not imported from lib/describe.js.
const stem = (x) => {
  const w = plain(x).split(" "), last = w.pop() || "";
  const ends = [last.endsWith("ies") ? `${last.slice(0, -3)}y` : "", last.endsWith("es") ? last.slice(0, -2) : "", last.endsWith("s") && !last.endsWith("ss") ? last.slice(0, -1) : ""].filter(Boolean);
  return [w.join(" "), [last, ...ends]];
};
const sameName = (a, b) => { const [pa, fa] = stem(a), [pb, fb] = stem(b); return pa === pb && fa.some((f) => fb.includes(f)); };
/** The first three genres of the film, without the one that is the name of the label (lib/describe.js genresShown; the test must not import the code it guards, so it is written again here). */
const shownGenres = (genres, label = "") => (genres || []).slice(0, 3).filter((g) => !label || !sameName(g, label));

/**
 * Line 2 brought to its comparable form (see the top). `genres`: the film's (the first three are on the line). `forgiveLabel`: the line is not in a mood row, so its "Mood:" label may differ.
 * Unchanged when the line does not have the shape [lead] [genres] [at most one group of words].
 */
function withoutWords(line, genres, forgiveLabel = false) {
  if (typeof line !== "string" || !line) return line;
  const groups = line.replace(/\.$/, "").split(" · ");
  const raw = shownGenres(genres).join(", ");
  const labelled = groups[0].startsWith(LABEL);
  const name = labelled ? groups[0].slice(LABEL.length) : "";
  let rest, kept; // kept: what stays in the comparable form; rest: the groups after the genres (the words)
  if (raw && groups[0] === raw) { kept = [raw]; rest = groups.slice(1); } // no lead
  else if (labelled && (!forgiveLabel || MOOD_NAMES.has(name))) {
    const want = shownGenres(genres, name).join(", ");
    if (want) { if (groups[1] !== want) return line; rest = groups.slice(2); } else rest = groups.slice(1);
    kept = forgiveLabel ? (raw ? [raw] : []) : [groups[0], ...(want ? [want] : [])]; // a label that may differ is cut with its genres, which are compared as the film's three
  } else if (!labelled && raw && groups[1] === raw) { kept = [groups[0], raw]; rest = groups.slice(2); } // a reason leads
  else if (!raw && !labelled && groups.length >= 2) { kept = [groups[0]]; rest = groups.slice(1); } // a reason leads, the film has no genres
  else if (!raw && !labelled) { kept = []; rest = groups; } // no genres, no lead: the line is the words alone
  else return line;
  if (rest.length > 1) return line; // AT MOST ONE group after the genres: more is not the word group
  return kept.join(" · ");
}

/**
 * The card as it is, with line 2 brought to its comparable form: "credits\nline 2\n\nsynopsis" (every other line of the card and the synopsis kept). The static `description` has a card of one or two lines, then the
 * separator; the index's `desc` (positional, lib/describe.js liveDescription) always has two lines, the first possibly empty, and the first separator AFTER them ends the card ("\n\n\nSyn" is an empty card and the synopsis).
 * `forgiveLabel`: the film is not in a mood row (see withoutWords).
 */
function marked(text, genres, positional = false, forgiveLabel = false) {
  if (typeof text !== "string" || !text) return text;
  const nl = text.indexOf("\n");
  const sep = positional ? (nl < 0 ? -1 : text.indexOf(SEP, nl + 1)) : text.indexOf(SEP);
  const lines = (sep < 0 ? text : text.slice(0, sep)).split("\n"), rest = sep < 0 ? "" : text.slice(sep);
  if (lines.length > 1) lines[1] = withoutWords(lines[1], genres, forgiveLabel);
  if (!positional && lines[1] === "") lines.splice(1, 1); // a static card with no lead and no genres has a line 2 of words alone: without them it has no line 2, exactly like the reduced build's (Our Trip to Africa, 21/10/2026)
  return lines.join("\n") + rest;
}

/** Is this file of the static addon the row of a mood (Tonight, a legacy mood's row, an option of the Moods menu)? */
const staticMoodRow = (r) => {
  const m = /^catalog\/movie\/(.+)\.json$/.exec(r);
  if (!m) return false;
  return STRICT_ROWS.has(m[1]) || /^mood-engine\/genre=/.test(m[1]);
};

function relaxed(buf, rel) {
  const r = slash(rel);
  if (/^catalog\/movie\/.+\.json$/.test(r)) {
    const j = JSON.parse(buf.toString("utf8"));
    const forgive = !staticMoodRow(r);
    return JSON.stringify({ ...j, metas: (j.metas || []).map((m) => ({ ...m, description: marked(m.description, m.genres, false, forgive) })) });
  }
  if (HAS_BUILT_AT.test(r) && r !== "data/film-languages.json") {
    const ix = decodeRows(JSON.parse(buf.toString("utf8")));
    const genresOf = new Map(ix.films.map((f) => [f.tt, f.genres || []]));
    for (const f of ix.films) if (f.desc != null) f.desc = marked(f.desc, f.genres, true, true); // a film's general text is no mood row
    // a film the piece does not hold has no genres to find the group by: its text is compared whole (a line that has genres is then left whole)
    const known = (tt) => (genresOf.has(tt) ? genresOf.get(tt) : ["\u0000"]);
    for (const k of Object.keys(ix.rowDesc || {})) ix.rowDesc[k] = ix.rowDesc[k].map((t, i) => marked(t, known(((ix.rows || {})[k] || [])[i]), true, !STRICT_ROWS.has(k)));
    for (const o of (ix.directors && ix.directors.options) || []) o.descs = (o.descs || []).map((t, i) => marked(t, known((o.ids || [])[i]), true, true));
    return JSON.stringify(encodeRows(ix)).replace(/"builtAt":"[^"]*"/g, '"builtAt":"X"');
  }
  return normalised(buf);
}

/** The legacy files (paths relative to the build folders) that moved between two builds, what is forgiven above aside: ["<file> (differs beyond the word group and the best-fit label of line 2 of the card)", …]. */
function movedBeyondWords(legacy, dirA, dirB) {
  const out = [];
  for (const f of legacy) {
    const x = fs.readFileSync(path.join(dirA, f)), y = fs.readFileSync(path.join(dirB, f));
    if (x.equals(y)) continue;
    if (relaxed(x, f) !== relaxed(y, f)) out.push(`${f} (differs beyond the word group and the best-fit label of line 2 of the card)`);
  }
  return out;
}

module.exports = { withoutWords, marked, relaxed, movedBeyondWords, staticMoodRow, SEP, MOOD_NAMES, STRICT_ROWS };
