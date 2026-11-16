'use strict';

// Marco, 10/10/2026: general Letterboxd >= 3.5 OR one configured friend >= 3.5.
// Only ratings joined by the film's IMDb identity qualify; TMDB is never a substitute.
// Marco, 11/10/2026 (decision 5), ONE exception: a film vouched for needs no 3.5 floor (cv: 1, exactly the number 1; since later that day, 2.5: below). Vouched means
// in a critic or director list (config.json lists[].trust, lib/list-signal.js; a fan list grants nothing) OR loved by one of Marco's
// favourite directors through a high or medium source (data/directors-loved.json, lib/directors-loved.js vouched()). The same entry
// decides Board/Discover, the browser picker (cv: 1 in the web data) and the Worker's `eligible` flag.
// Marco, 11/10/2026 (later the same day): the exception is no longer "no floor at all": a vouched film needs a Letterboxd average of at
// least 2.5 (VOUCHED_MIN_STARS); a vouched film with NO average still passes (Letterboxd never showed it, or a director's file names it).
const MIN_STARS = 3.5;
const VOUCHED_MIN_STARS = 2.5;
// Marco, 22/10/2026 (~06:40 UTC, lot 2): a film with NO record in TMDB stays out of the rows until it has one (East of Eden 2026, tt21097264, 4.08 on Letterboxd and nothing else, was
// the one empty card of the Board). `noRecord: true` on an entry (index() below, `unrecorded`) refuses the film whatever its average, its friends or its vouching: it is a condition of
// the same rule, so every surface that asks it (the Board rows, the Discover cuts, the picker, the Worker's `eligible` flag) answers alike. Only the exempt collections (below, applyPlan) keep it.
const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 5;
const qualifies = ({ lb = null, fr = null, cv = null, noRecord = false } = {}) =>
  noRecord !== true && ((valid(lb) && lb >= MIN_STARS) || (valid(fr) && fr >= MIN_STARS) || (cv === 1 && (!valid(lb) || lb >= VOUCHED_MIN_STARS)));

// vouched: tt → { list, trust } (lib/list-signal.js vouched()); films outside view.films never get an entry (a list is read from Letterboxd)
// loved:   tt → { list, trust: "director", why } (lib/directors-loved.js vouched()); the IMDb id comes from the curated file, so a film
//          Letterboxd never showed gets an entry of its own (no average, no friend), vouched. A list's vouch, when both, is kept.
// unrecorded: ({ imdbId, tmdbId }) → bool, true when TMDB was asked and has no record of the film (lib/tmdb.js noRecord; build.js hands it the live cache, and the learning replay lib/learning/evaluate.js shadowRows hands it the frozen one, lib/tmdb.js unrecordedFrom, since 22/10/2026: without it the replay's row candidates differ from the frozen ones). Omitted: every film counts as recorded
//          (the tests of the 3.5 rule). Each entry carries `noRecord`, read when the rule is asked and not when the index is made: the nightly fills the TMDB cache while it builds, and a
//          film whose record arrives at step 5 must not stay out for the whole night. A film with several Letterboxd pages is without a record only if each page's TMDB id says so.
function index(view = { films: {}, users: [] }, { vouched = new Map(), loved = new Map(), unrecorded = null } = {}) {
  view ||= { films: {}, users: [] };
  const result = new Map(), pages = new Map();
  const track = (tt, tmdbId) => {
    if (!unrecorded) return;
    if (!pages.has(tt)) {
      const ids = new Set();
      pages.set(tt, ids);
      Object.defineProperty(result.get(tt), 'noRecord', { enumerable: true, get: () => [...ids].every(id => unrecorded({ imdbId: tt, tmdbId: id })) });
    }
    pages.get(tt).add(tmdbId || null);
  };
  for (const film of Object.values(view.films || {})) {
    if (film.gone || !/^tt\d+$/.test(film.imdbId || '')) continue;
    const entry = result.get(film.imdbId) || { lb: null, fr: null, friend: null };
    // Multiple slugs for one identity: use the lower average if they disagree.
    if (valid(film.r)) entry.lb = entry.lb === null ? film.r : Math.min(entry.lb, film.r);
    result.set(film.imdbId, entry);
    track(film.imdbId, film.tmdbId);
  }
  for (const user of view.users || []) for (const [slug, vote] of user.films || []) {
    const film = view.films?.[slug];
    if (film?.gone || !film?.imdbId || !valid(vote.rating)) continue;
    const entry = result.get(film.imdbId);
    if (entry && (entry.fr === null || vote.rating > entry.fr)) {
      entry.fr = vote.rating;
      entry.friend = user.name || user.user;
    }
  }
  for (const [tt, v] of vouched) {
    const entry = result.get(tt);
    if (entry) { entry.cv = 1; entry.cvList = v.list; entry.cvTrust = v.trust; if (v.why) entry.cvWhy = v.why; }
  }
  for (const [tt, v] of loved) {
    if (!/^tt\d+$/.test(tt)) continue;
    const entry = result.get(tt) || result.set(tt, { lb: null, fr: null, friend: null }).get(tt);
    if (!pages.has(tt)) track(tt, null); // a loved film Letterboxd never showed; one it showed was tracked with its page's TMDB id
    if (entry.cv !== 1) { entry.cv = 1; entry.cvList = v.list; entry.cvTrust = v.trust; entry.cvWhy = v.why; }
  }
  return result;
}

function reason(entry) {
  if (!qualifies(entry)) return null;
  if (valid(entry.lb) && entry.lb >= MIN_STARS) return `Letterboxd ${entry.lb.toFixed(2)}★`;
  if (valid(entry.fr) && entry.fr >= MIN_STARS) return `${entry.friend} rated it ${entry.fr.toFixed(1)}★ on Letterboxd`;
  if (entry.cvWhy) return entry.cvWhy; // "Loved by Lynch and Scorsese · Sight & Sound 2022 ballot"
  return `in “${entry.cvList}”, a ${entry.cvTrust === 'director' ? "director's" : "critics'"} list`;
}

/**
 * The reason a Board row or a Discover cut shows for a film that passed the rule (Marco, 13/10/2026): the Letterboxd average is NOT one (the first line of
 * the description already shows it as "★ 4.0"), a friend is "friend-g 4.5★", and a vouched film says who vouched. reason() above is the longer wording
 * of the browser picker.
 */
const stars = r => `${Number.isInteger(r) ? r : r.toFixed(1)}★`; // "5★", "4.5★": how every friends row writes a rating (lib/rows.js fmtStars, lib/pool.js)
function planReason(entry) {
  if (!qualifies(entry)) return null;
  if (valid(entry.lb) && entry.lb >= MIN_STARS) return null;
  if (valid(entry.fr) && entry.fr >= MIN_STARS) return `${entry.friend} ${stars(entry.fr)}`;
  return reason(entry);
}

// The one rule, film by film: an item's own fields (`trust`, `loved`) never decide.
function filter(items, ratings) {
  return items.filter(item => qualifies(ratings.get(item.id)));
}

function applyPlan(plan, ratings) {
  const generated = items => filter(items, ratings).map(item => {
    const entry = ratings.get(item.id), why = planReason(entry);
    // a "Loved by your directors" item already says who loves it (item.loved, lib/describe.js): the same words are not repeated
    // a friend the item already names (with a rating, in whatever format) is not named again: compared by the friend, not by the text ("friend-e 5★ · friend-e 5.0★")
    const names = (text, friend) => !!friend && new RegExp(`(^|[^\\p{L}\\p{N}_])${friend.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\d(\\.\\d)?★`, 'u').test(text);
    if (!why || item.why?.some(text => text.includes(why)) || (valid(entry.fr) && entry.fr >= MIN_STARS && !(valid(entry.lb) && entry.lb >= MIN_STARS) && item.why?.some(text => names(text, entry.friend))) || (item.loved && why === entry.cvWhy)) return item;
    const parts = [...(item.why || [])];
    if (parts.length >= 2) parts[1] += ` · ${why}`; else parts.push(why);
    return { ...item, why: parts };
  });
  for (const row of require("./plan").boardRows(plan)) row.items = generated(row.items); // the v2 Board (plan.board2) answers to the same floor as the legacy one
  // These are direct curator/friend collections, not generated recommendations.
  const editorial = new Set(['mood-engine-lists', 'mood-engine-lists-unseen', 'mood-engine-friends']);
  for (const catalog of plan.discover) if (!editorial.has(catalog.id))
    for (const option of catalog.options) option.items = generated(option.items);
  return plan;
}

function applyWeb(data, ratings) {
  for (const kind of ['films', 'rewatch']) data[kind] = data[kind].flatMap(item => {
    const entry = ratings.get(item.i);
    if (!qualifies(entry)) return [];
    const why = reason(entry);
    return [{ ...item, lb: entry.lb, fr: entry.fr, ...(entry.cv === 1 ? { cv: 1 } : {}), why: item.why?.some(text=>text.includes(why)) ? item.why : [...(item.why || []), why] }];
  });
  const ids = new Set(data.films.map(item => item.t));
  data.tonight = data.tonight.filter(id => ids.has(id));
  return data;
}

// The films the record condition ALONE keeps out: they would pass the rule (the average, a friend, the exception) and TMDB was asked and has no record. build.js logs their number and the first names.
const refusedForRecord = (ratings) => [...ratings].filter(([, entry]) => entry.noRecord === true && qualifies({ ...entry, noRecord: false })).map(([tt]) => tt);

// A film that passes ONLY through the exception: vouched, and neither its Letterboxd average nor a configured friend reaches 3.5.
const onlyByException = (entry) => !!entry && qualifies(entry) && entry.cv === 1 && !(valid(entry.lb) && entry.lb >= MIN_STARS) && !(valid(entry.fr) && entry.fr >= MIN_STARS);

module.exports = { refusedForRecord, onlyByException, MIN_STARS, VOUCHED_MIN_STARS, valid, qualifies, index, reason, planReason, filter, applyPlan, applyWeb };
