// The directors' lists of They Shoot Pictures, Don't They? (Marco, 22/10/2026 ~06:45 UTC: "eu quero que voce pega os top 250 das listas, tem os diretores tb,
// veja tudo que do tspdt"). Three pages of the site, all static HTML, read by scripts/tspdt-directors.js into data/tspdt-directors.json:
//   top250   https://theyshootpictures.com/gf1000_top250directors.htm      "The Top 250 Directors", 2026 edition: "<pos>. <name> (<last year's pos or ->)" and
//                                                                           "N films in the 1,000 Greatest / M other films cited"
//   c21top100 https://theyshootpictures.com/21stcentury_top100directors.htm the same markup for the 21st Century: "N films in the Top 1,000 / M other films cited"
//   noir50   https://theyshootpictures.com/50keynoirdirectors.htm           "50 Key Noir Directors": a plain numbered list 1..50, no ties (parseNoir and `sequential` refuse a repeated or skipped number)
// A team is one entry ("Michael Powell & Emeric Pressburger"): its members are matched to TMDB one by one.
//
// Matching a name to a TMDB person (the only key the cache has for a director: cache/tmdb.json movie[id].v.directors = [{ id, name }]):
//   - the name is folded (lib/util norm: accents, case, punctuation) and looked up among every director of the cache; one id → that id;
//   - several ids with the same folded name (homonyms) → the one with most films in the index, flagged `ambiguous`; a tie is left null;
//   - a spelling the cache does not share with TSPDT is in ALIASES, each one checked by hand against the director's films; no id → null (never a guess).
// Pure functions; scripts/tspdt-directors.js does the reading and writing.

const { norm } = require("./util");

// the named entities of the pages: Latin-1 letters and signs (160–255, in the order of the HTML standard), plus the five of XML
const LATIN1 = "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(" ");
const NAMED = Object.fromEntries([...LATIN1.map((n, i) => [n, String.fromCharCode(160 + i)]), ["amp", "&"], ["quot", '"'], ["apos", "'"], ["lt", "<"], ["gt", ">"]]);
const decode = (s) => String(s || "")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([A-Za-z][A-Za-z0-9]*);/g, (m, n) => { if (Object.hasOwn(NAMED, n)) return NAMED[n]; throw new Error(`HTML entity ${m} is not handled: add it to NAMED (lib/tspdt-directors.js)`); });
const text = (html) => decode(String(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/**
 * "The Top 250 Directors" and "Top 100 Directors" pages → [{ pos, name, prev, page, films, other }] in the page's order.
 *   name  the link's title attribute ("Stanley Donen & Gene Kelly"), decoded
 *   prev  last year's position, null for a new entry ("(-)")
 *   page  the director's page on the site (hitchcockalfred.htm)
 *   films "N films in the 1,000 Greatest" (or "in the Top 1,000"), other "M other films cited"
 * Throws unless the positions run 1..N with no gap and no repeat: a half-read page must not become a data file.
 */
function parseRanked(html) {
  const out = [];
  for (const m of String(html).matchAll(/<a href="([^"]+\.htm)" title="([^"]*)">\s*(\d+)\.\s*([^<]*?)\s*<\/a>([\s\S]*?)<\/p>/g)) {
    const [, page, title, pos, label, rest] = m;
    const prev = (label.match(/\(([^)]*)\)\s*$/) || [])[1];
    const stat = text(rest);
    const films = stat.match(/(\d+) films? in the (?:1,000 Greatest|Top 1,?000)/), other = stat.match(/(\d+) (?:other )?films? cited/); // "0 films in the 1,000 Greatest / 16 films cited": with none in the list, "other" is dropped
    if (!films || !other) throw new Error(`director ${pos} (${title}): the line "${stat}" has no "N films in the … / M (other) films cited"`);
    if (prev === undefined || !/^(\d+|-)$/.test(prev.trim())) throw new Error(`director ${pos} (${title}): no last-year position in "${text(label)}"`);
    out.push({ pos: Number(pos), name: decode(title), prev: prev.trim() === "-" ? null : Number(prev), page, films: Number(films[1]), other: Number(other[1]) });
  }
  sequential(out, "ranked directors page");
  return out;
}

/** "50 Key Noir Directors" → [{ pos, name }]: "1. Fritz Lang" … "29. Joel Coen & Ethan Coen"; the page numbers are 1..50 with no ties. */
function parseNoir(html) {
  const t = String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "").replace(/<(?:br|\/p|\/div|\/li)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, "");
  const from = t.indexOf("have most often been mentioned/cited as film noirs");
  if (from < 0) throw new Error("50 Key Noir Directors: the sentence that opens the list is not on the page (layout changed)");
  const out = [];
  for (const line of decode(t.slice(from)).split("\n")) {
    const m = line.trim().match(/^(\d+)\.\s+(\S.*)$/);
    if (m) out.push({ pos: Number(m[1]), name: m[2].trim() });
    else if (out.length && /\S/.test(line) && /Introduction|1,000 Noir Films/.test(line)) break; // the page footer repeats the menu after the list
  }
  sequential(out, "50 Key Noir Directors");
  return out;
}

function sequential(rows, what) {
  if (!rows.length) throw new Error(`${what}: no director found (layout changed?)`);
  rows.forEach((r, i) => { if (r.pos !== i + 1) throw new Error(`${what}: entry ${i + 1} is numbered ${r.pos}`); });
}

// ── matching to TMDB ─────────────────────────────────────────────────────────

/** Spellings TSPDT and TMDB do not share (folded TSPDT name → TMDB person id). Each one was read against the person's films in cache/tmdb.json. */
const ALIASES = {
  charleschaplin: 13848,            // TMDB: "Charlie Chaplin" (City Lights, The Gold Rush, Modern Times)
  robertjflaherty: 10092,           // TMDB: "Robert Flaherty" (Nanook of the North, Man of Aran) — not Frances H. Flaherty, 1840038
  kathyrnbigelow: 14392,            // TSPDT misspells it ("Kathyrn", on both pages); TMDB: "Kathryn Bigelow" (Strange Days, Point Break)
  alejandrogonzalezinarritu: 223,   // TMDB: "Alejandro G. Iñárritu" (Amores Perros, 21 Grams, Babel)
};

/** "A & B" → ["A", "B"]; a name with no " & " is one member. */
const members = (name) => name.split(/\s+&\s+/).map((s) => s.trim()).filter(Boolean);

/**
 * cache/tmdb.json `movie` + the IMDb ids of the index → Map(person id → { name, films: [imdb ids in the index] }) and byName (folded name → [person ids]).
 * A film joins by its OWN imdb id (`v.imdb`), never by the key it is stored under: 50 old records are stored under a TV id that names another film.
 */
function directorsOf(movies, indexTts) {
  const people = new Map(), byName = new Map();
  const inIndex = new Set(indexTts);
  for (const rec of Object.values(movies || {})) {
    const v = rec && rec.v;
    if (!v || !Array.isArray(v.directors)) continue;
    for (const d of v.directors) {
      if (!d || !Number.isInteger(d.id) || typeof d.name !== "string") continue;
      let p = people.get(d.id);
      if (!p) { p = { name: d.name, films: new Set() }; people.set(d.id, p); const k = norm(d.name); (byName.get(k) || byName.set(k, []).get(k)).push(d.id); }
      if (v.imdb && inIndex.has(v.imdb)) p.films.add(v.imdb);
    }
  }
  return { people, byName };
}

/** One member name → { name, tmdb, ambiguous? }: tmdb is a person id or null. */
function matchMember(name, { people, byName }, aliases = ALIASES) {
  const key = norm(name);
  if (Object.hasOwn(aliases, key)) return { name, tmdb: aliases[key] };
  const ids = byName.get(key) || [];
  if (ids.length === 1) return { name, tmdb: ids[0] };
  if (!ids.length) return { name, tmdb: null };
  const ranked = ids.map((id) => [id, people.get(id).films.size]).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  if (ranked[0][1] === ranked[1][1]) return { name, tmdb: null, ambiguous: true }; // two people, as many films each: not decidable from the index
  return { name, tmdb: ranked[0][0], ambiguous: true };
}

/**
 * Entries of a page → entries with the TMDB ids and the count of his films in the index:
 *   { ...entry, tmdb (the person id for one director; null for a team or an unmatched name), members: [{ name, tmdb, ambiguous? }], filmsInIndex }
 * filmsInIndex: films of the index directed by any member (a film of the team counts once).
 */
function attach(entries, dirs, aliases = ALIASES) {
  return entries.map((e) => {
    const ms = members(e.name).map((n) => matchMember(n, dirs, aliases));
    const films = new Set();
    for (const m of ms) if (m.tmdb != null) for (const tt of dirs.people.get(m.tmdb)?.films || []) films.add(tt);
    return { ...e, tmdb: ms.length === 1 ? ms[0].tmdb : null, members: ms, filmsInIndex: films.size };
  });
}

module.exports = { parseRanked, parseNoir, decode, members, directorsOf, matchMember, attach, ALIASES };
