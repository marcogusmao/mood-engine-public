// The "All friends loved" option of the Friends menu (Marco, 28/10/2026, Discover proposal 5; plan docs/2026-10-28-discover-plano-implementacao.md §5.4).
// lib/friends.js allFriendsLoved decides WHO loved which film; this puts the answer into a built index: only the films the index already holds (the option never adds one), the ones you have not seen,
// in the order of the index (best rank first) and then spread() over the directors, the way every calculated option of the Discover is ordered (lib/discover-catalogs.js). It sits in
// index.friends.options after the "Top" options and before the "Watch together" ones. Kept out of lib/discover-catalogs.js on purpose: that file is another front's.

const { spread } = require("./discover-catalogs");

/** The spread of the Discover when data/discover-catalogs.json is absent (Marco, 22/10/2026; the file's own `spread` is the same values today). */
const DEFAULT_SPREAD = { per: 2, perAfterFirstPage: 5, window: 20 };

/**
 * index: a buildIndex() object, changed in place (index.friends.options).
 * label: the option's menu label. tts: allFriendsLoved(...). at: the position in the options (clamped to 0..length).
 * spreadSpec: the Discover's { per, perAfterFirstPage, window }. → { label, total (films in the option; the Worker serves all of them), at }
 * An index with no friends options at all (a person's build: config.friends is empty) gets none: the menu would have an option and nobody to love anything. → null
 */
function addFriendsOption(index, { label, tts, at, spreadSpec = DEFAULT_SPREAD }) {
  const options = index.friends && index.friends.options;
  if (!options || !options.length) return null;
  if (options.some((o) => o.label === label)) throw new Error(`friends option "${label}" is already in the index`);
  const want = new Set(tts);
  const byTt = new Map(index.films.map((e) => [e.tt, e]));
  const directorOf = (tt) => { const e = byTt.get(tt); return e && e.director ? e.director.split(", ")[0] : null; };
  // What the Worker shows in THIS option is every unseen film: the catalog `friends` is exempt from the recommendation rule (worker/src/catalogs.js:43 `exemptCatalogs` and :54 `eligibleTest` → null, so select() at :152-156 filters
  // only `seen`), the music rule's held-back films included. Measured 29/10/2026 by running the Worker's handler page by page: all 1,632 films of the option, none held back. The spread must count what is on the screen.
  const shownByDefault = (tt) => { const e = byTt.get(tt); return !e.seen; };
  const ids = spread(index.films.filter((e) => want.has(e.tt) && !e.seen).map((e) => e.tt), directorOf, spreadSpec, shownByDefault);
  const pos = Math.max(0, Math.min(options.length, at));
  options.splice(pos, 0, { label, ids });
  return { label, total: ids.length, at: pos };
}

/** Where the option goes: right after the last "Top" option. `topWords`: the labels of the Top options (build.js reads them from the friends meta). */
function positionAfterTops(options, topWords) {
  const tops = new Set(topWords);
  let at = 0;
  options.forEach((o, i) => { if (tops.has(o.label)) at = i + 1; });
  return at;
}

module.exports = { addFriendsOption, positionAfterTops, DEFAULT_SPREAD };
