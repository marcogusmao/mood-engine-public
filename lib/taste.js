// Your taste, learned from your own ratings.
//
// Every rated film is broken into features (its director, lead cast, genres, TMDB
// keywords, country, language, decade). For each feature we ask: "when a film has
// this, does Marco rate it above or below his own average?" — then shrink that answer
// toward zero when it rests on only a few films, so one fluke 5★ doesn't make a
// director your favourite. Scoring an unseen film = adding up what its features say.

const ALPHA = { director: 1.6, keyword: 1.2, cast: 0.6, genre: 0.6, country: 0.5, lang: 0.4, decade: 0.3 };
const SHRINK = { director: 1.5, cast: 3, keyword: 4, genre: 10, country: 6, lang: 6, decade: 8 };
const LIKE_BONUS = 0.25; // a ❤ on Letterboxd counts like a quarter star extra

const LANGS = { en: "English", fr: "French", ja: "Japanese", zh: "Chinese", ko: "Korean", es: "Spanish", pt: "Portuguese", it: "Italian", de: "German", fa: "Persian", sv: "Swedish", no: "Norwegian", da: "Danish", ru: "Russian", hi: "Hindi", ar: "Arabic", tr: "Turkish", pl: "Polish", ro: "Romanian", el: "Greek", th: "Thai", cn: "Cantonese", he: "Hebrew", nl: "Dutch", fi: "Finnish", hu: "Hungarian", cs: "Czech", sr: "Serbian" };

function featuresOf(f) {
  const out = [];
  for (const d of f.directors || []) out.push({ key: `d:${d.id}`, type: "director", label: d.name });
  for (const c of (f.cast || []).slice(0, 4)) out.push({ key: `c:${c.id}`, type: "cast", label: c.name });
  for (const g of f.genres || []) out.push({ key: `g:${g}`, type: "genre", label: g });
  for (const k of f.keywords || []) out.push({ key: `k:${k}`, type: "keyword", label: k });
  for (const n of (f.countries || []).slice(0, 2)) out.push({ key: `n:${n}`, type: "country", label: n });
  if (f.lang) out.push({ key: `l:${f.lang}`, type: "lang", label: LANGS[f.lang] || f.lang });
  if (f.year) out.push({ key: `e:${Math.floor(f.year / 10) * 10}`, type: "decade", label: `${Math.floor(f.year / 10) * 10}s` });
  return out;
}

/** rated: [{ film, rating (0.5–5), liked }] */
function learn(rated) {
  const usable = rated.filter((r) => r.film && r.rating != null);
  const mean = usable.reduce((a, r) => a + r.rating, 0) / (usable.length || 1);
  const stats = new Map();
  for (const r of usable) {
    const dev = r.rating - mean + (r.liked ? LIKE_BONUS : 0);
    const seen = new Set();
    for (const ft of featuresOf(r.film)) {
      if (seen.has(ft.key)) continue;
      seen.add(ft.key);
      const s = stats.get(ft.key) || { ...ft, n: 0, sum: 0, ratingSum: 0, films: [] };
      s.n++; s.sum += dev; s.ratingSum += r.rating;
      if (s.films.length < 4) s.films.push(r.film.title);
      stats.set(ft.key, s);
    }
  }
  for (const s of stats.values()) {
    s.w = s.sum / (s.n + SHRINK[s.type]);
    s.avg = s.ratingSum / s.n;
  }
  return { mean, count: usable.length, stats };
}

/** How much this film looks like the films you rate highly. */
function score(film, model) {
  const byType = {};
  const contributions = [];
  const seen = new Set();
  for (const ft of featuresOf(film)) {
    if (seen.has(ft.key)) continue;
    seen.add(ft.key);
    const t = (byType[ft.type] ||= { sum: 0, n: 0 });
    t.n++;
    const s = model.stats.get(ft.key);
    if (s) { t.sum += s.w; contributions.push(s); }
  }
  let total = 0;
  for (const [type, t] of Object.entries(byType)) total += (ALPHA[type] || 0) * (t.sum / Math.sqrt(t.n));
  return { score: total, contributions };
}

// Only keywords that say something about taste make it into a "why". Plot mechanics
// ("private detective", "prostitute", "courtroom") still shape the score, but never the explanation.
const SAYABLE = new Set([
  "black and white", "slice of life", "coming of age", "friendship", "loneliness", "road trip", "small town", "family relationships",
  "surreal", "surrealism", "dark comedy", "satire", "absurd", "melancholy", "bittersweet", "nostalgic", "contemplative", "reflective",
  "intimate", "tender", "heartwarming", "hopeful", "whimsical", "neo-noir", "film noir", "independent film", "new york city", "paris, france",
  "tokyo, japan", "taipei, taiwan", "rio de janeiro", "são paulo", "brazil", "music", "musician", "concert", "concert film", "jazz", "rock music",
  "music documentary", "dance", "food", "cooking", "multiple storylines", "nonlinear timeline", "ensemble cast", "long take", "one location",
  "marriage", "divorce", "relationship", "father son relationship", "father daughter relationship", "mother daughter relationship",
  "mother son relationship", "brother brother relationship", "sister sister relationship", "grief", "memory", "existentialism",
  "midlife crisis", "self-discovery", "artist", "writer", "poetry", "filmmaking", "cinema", "new wave", "nouvelle vague", "experimental",
  "psychological thriller", "folk horror", "body horror", "slasher", "heist", "gangster", "western", "samurai", "martial arts", "skateboarding",
  "youth", "teenager", "summer", "countryside", "village", "island", "city life", "nightlife", "1970s", "1980s", "1990s",
]);
const REGION_NAMES = { HK: "Hong Kong", MO: "Macau", TW: "Taiwan", US: "the US", GB: "the UK", SU: "the Soviet Union", XC: "Czechoslovakia", XG: "East Germany", YU: "Yugoslavia" };
const REGION = (() => {
  let d = null;
  try { d = new Intl.DisplayNames(["en"], { type: "region" }); } catch {}
  return (c) => REGION_NAMES[c] || (d && d.of(c)) || c;
})();

// What a feature needs before the card may say "you rate X …": enough rated films and a weight above the floor. One source: `reasons` and `personEvidence`
// (the New releases music rule, lib/pool.js, 22/10/2026) read these two, so the card and the rule cannot drift apart.
const REASON_MIN_N = { director: 2, cast: 3, keyword: 6, country: 6, lang: 6 };
const REASON_MIN_W = 0.12;

/** The contributions of a film that name a PERSON Marco rates: a director over ≥ 2 of his films or a cast member over ≥ 3, with a weight above REASON_MIN_W (the card's own thresholds). */
function personEvidence(contributions) {
  return (contributions || []).filter((s) => (s.type === "director" || s.type === "cast") && s.n >= REASON_MIN_N[s.type] && s.w > REASON_MIN_W);
}

/** Human reasons, strongest first, phrased to follow the row's name on the reason line — "you rate Edward Yang 4.7★ over 3 films". */
function reasons(contributions, max = 2) {
  const MIN_N = REASON_MIN_N;
  const picked = contributions
    .filter((s) => MIN_N[s.type] && s.n >= MIN_N[s.type] && s.w > REASON_MIN_W)
    .filter((s) => s.type !== "keyword" || SAYABLE.has(s.label))
    .sort((a, b) => b.w * (ALPHA[b.type] || 0) - a.w * (ALPHA[a.type] || 0));
  const out = [];
  const usedTypes = new Set();
  for (const s of picked) {
    if (out.length >= max) break;
    if (usedTypes.has(s.type) && s.type !== "director") continue;
    usedTypes.add(s.type);
    const avg = s.avg.toFixed(1);
    if (s.type === "director") out.push(`you rate ${s.label} ${avg}★ over ${s.n} films`);
    else if (s.type === "cast") out.push(`you rate ${s.label} ${avg}★ over ${s.n} films`);
    else if (s.type === "keyword") out.push(`you rate ${s.label} films ${avg}★ (${s.n} rated)`);
    else if (s.type === "lang") out.push(`you rate ${s.label}-language films ${avg}★`);
    else if (s.type === "country") out.push(`you rate films from ${REGION(s.label)} ${avg}★`);
  }
  return out;
}

/** A readable portrait of the model, for the web page. */
function fingerprint(model) {
  const all = [...model.stats.values()];
  const top = (type, minN, n, dir = 1) =>
    all
      .filter((s) => s.type === type && s.n >= minN)
      .sort((a, b) => dir * (b.w - a.w))
      .slice(0, n)
      .map((s) => ({ label: s.label, avg: +s.avg.toFixed(2), n: s.n, w: +s.w.toFixed(3), films: s.films }));
  return {
    mean: +model.mean.toFixed(2),
    rated: model.count,
    directors: top("director", 3, 8),
    cast: top("cast", 4, 6),
    keywords: top("keyword", 8, 10),
    languages: top("lang", 6, 5),
    decades: top("decade", 10, 3),
    coldGenres: top("genre", 15, 3, -1),
  };
}

module.exports = { learn, score, reasons, personEvidence, fingerprint, featuresOf, ALPHA: Object.freeze(ALPHA), REASON_MIN_N: Object.freeze({ ...REASON_MIN_N }), REASON_MIN_W };
