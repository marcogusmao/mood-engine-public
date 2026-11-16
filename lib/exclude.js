// config.json → exclude.films: films Marco does not want RECOMMENDED (Marco, 13/10/2026: Paterson, tt5247022). Scope, as he narrowed it that day
// ("Paterson não precisa sumir da busca"): every Board row (Tonight, because, directors, new for you …), the film's membership of the moods in the
// exported index (so the Worker's Moods and the profiles' Tonight lose it too) and the Discover catalogs of moods and of directors. Search, Explore
// (`eligible` stays as the rule says), Lists, Lists (unseen) and Friends keep it: they show what exists, not what is recommended.
// The film leaves the candidate pool before any ranking (build.js), so the rows refill with the next film; the plan filter below catches
// the rows that are not made from that pool.

const IMDB_ID = /^tt\d+$/;

/** cfg.exclude → Set of IMDb ids. Throws, naming the entry, when `exclude` or `exclude.films` has the wrong shape or an id is not tt + digits. */
function parse(exclude) {
  if (exclude === undefined) return new Set();
  if (!exclude || typeof exclude !== "object" || Array.isArray(exclude)) throw new Error(`config.json exclude must be { "films": ["tt…"] }, got ${JSON.stringify(exclude)}`);
  const films = exclude.films === undefined ? [] : exclude.films;
  if (!Array.isArray(films)) throw new Error(`config.json exclude.films must be a list of IMDb ids, got ${JSON.stringify(films)}`);
  const bad = films.filter((id) => typeof id !== "string" || !IMDB_ID.test(id));
  if (bad.length) throw new Error(`config.json exclude.films: ${bad.map((id) => JSON.stringify(id)).join(", ")} ${bad.length === 1 ? "is" : "are"} not IMDb id${bad.length === 1 ? "" : "s"} (tt followed by digits, e.g. "tt5247022")`);
  return new Set(films);
}

/**
 * A film cannot be pinned and excluded at once (Marco, 15/11/2026, questionnaire: "Keep the pins, except Paterson"). A pin is his choice by hand that a film belongs to a mood, whatever its keywords
 * say; exclude.films is his choice that a film is never recommended. Until 15/11/2026 Paterson (tt5247022) was both, in the moods lift and reinvent: the exclusion won without a word (build.js takes
 * the film out of the candidates before any ranking), so config.json said "pinned" about a film that was in no row since 13/10/2026.
 * excluded: the Set of parse(); moods: config.json "moods" ([{ id, pins? }]). → [{ id, moods: [mood ids] }], empty when no film is both.
 */
function pinnedAndExcluded(excluded, moods) {
  const out = new Map();
  for (const m of moods || []) for (const id of m.pins || []) if (excluded.has(id)) (out.get(id) || out.set(id, []).get(id)).push(m.id);
  return [...out].map(([id, ms]) => ({ id, moods: ms }));
}

/** Stops the build, naming every film and its moods, when a film is in exclude.films and in a mood's pins. */
function assertNotPinned(excluded, moods) {
  const both = pinnedAndExcluded(excluded, moods);
  if (both.length) throw new Error(`config.json: ${both.map((b) => `${b.id} is in exclude.films and in the pins of ${b.moods.map((m) => `"${m}"`).join(", ")}`).join("; ")}. A film that is never recommended cannot be pinned to a mood (the exclusion wins and the pin does nothing): take it out of the pins, or out of exclude.films`);
}

/** The Discover catalogs that recommend (moods, directors): they lose an excluded film. The other catalogs (cuts by decade, country, runtime, rating; lists; friends) keep it. */
const RECOMMENDING = ["mood-engine", "mood-engine-directors-loved"];

/** Takes the excluded films out of every Board row and out of the two recommending Discover catalogs. Mutates the plan; a row is not refilled here. */
function applyToPlan(plan, excluded) {
  if (!excluded.size) return plan;
  for (const row of require("./plan").boardRows(plan)) row.items = row.items.filter((it) => !excluded.has(it.id)); // the v2 Board too
  for (const catalog of plan.discover) if (RECOMMENDING.includes(catalog.id)) for (const option of catalog.options) option.items = option.items.filter((it) => !excluded.has(it.id));
  return plan;
}

module.exports = { parse, applyToPlan, pinnedAndExcluded, assertNotPinned, RECOMMENDING, IMDB_ID };
