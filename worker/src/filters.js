// The four optional menus of Discover: decade, runtime, country, rating. Same buckets as the static addon's cuts
// (lib/pool.js RUNTIME_BUCKETS / RATING_BUCKETS; test/worker.test.js compares them value by value).

import { matchOption } from "./extras.js";
import { round2 } from "./text.js";

export const RUNTIME_BUCKETS = [
  ["Under 90 min", (m) => m < 90],
  ["90–120 min", (m) => m >= 90 && m <= 120],
  ["120–150 min", (m) => m > 120 && m <= 150],
  ["Over 150 min", (m) => m > 150],
];
export const RATING_BUCKETS = [
  ["4.2+", (v) => v >= 4.2],
  ["4.0–4.2", (v) => v >= 4.0 && v < 4.2],
  ["3.8–4.0", (v) => v >= 3.8 && v < 4.0],
  ["Under 3.8", (v) => v < 3.8],
];
export const RUNTIME_LABELS = RUNTIME_BUCKETS.map(([l]) => l);
export const RATING_LABELS = RATING_BUCKETS.map(([l]) => l);

/** Letterboxd's average, or TMDB's vote ÷ 2 when Letterboxd has none (the same fallback as the static "By rating"); null when neither. */
export const ratingOf = (e) => (e.lbRating != null ? e.lbRating : e.tmdbRating != null ? round2(e.tmdbRating / 2) : null);

/** The country menu of an index: the v2 family's frozen one (`countriesAll`, 46 names, 14/10/2026) when the file has it, else the legacy 12. The legacy files never carry `countriesAll`, so the five profiles keep their 12. */
export const countryMenu = (meta = {}) => meta.countriesAll || meta.countries || [];

/**
 * extras: the parsed request. meta: index.meta. → { none, test(entry) }
 * `none` is true when a menu was given a value that is not one of its options (a menu of an older install): the answer is an
 * empty page, never "ignore the filter and show everything".
 * A film with no runtime / no country / no rating never matches a filter on that fact: it is not guessed.
 */
export function compileFilters(extras, meta) {
  const tests = [];
  let none = false;

  if (extras.decade) {
    const d = matchOption(extras.decade, meta.decades || []);
    if (d === null) none = true;
    else tests.push((e) => e.decade === d);
  }
  if (extras.runtime) {
    const bucket = RUNTIME_BUCKETS.find(([l]) => l === matchOption(extras.runtime, RUNTIME_LABELS));
    const min = meta.minFeatureMinutes ?? 40; // below this a Letterboxd "film" is a short, and the runtime menus mean features
    if (!bucket) none = true;
    else tests.push((e) => e.runtime != null && e.runtime >= min && bucket[1](e.runtime));
  }
  if (extras.country) {
    const label = matchOption(extras.country, countryMenu(meta)) ?? String(extras.country).trim(); // a country outside the menu still filters, by its exact name
    if (!label) none = true;
    else tests.push((e) => e.hasCountry(label));
  }
  if (extras.rating) {
    const bucket = RATING_BUCKETS.find(([l]) => l === matchOption(extras.rating, RATING_LABELS));
    if (!bucket) none = true;
    else tests.push((e) => { const v = ratingOf(e); return v != null && bucket[1](v); });
  }
  return { none, test: (e) => tests.every((t) => t(e)), active: tests.length > 0 || none };
}
