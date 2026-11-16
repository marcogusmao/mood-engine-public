// The Mood group of the chips, shared by the film page (page.js) and the catalog cards (meta.js).
//
// ONE group (Marco, 28/10/2026): moods (4) -> genres (3) -> terms (3), no repeats. It was extracted from page.js unchanged: the rules and the order are one code for the film page and
// for the card of the Discover's side preview (Marco, 28/10/2026, "T2"). The CHIPS are the same for the same film only when both read the same menus: the old address and the v2 address do
// (4,578 of 4,578 cards equal to the film page, independent review of 28/10/2026). The five profiles (/p/<profile>/) and the old pieces (Lists, Friends, Loved by directors) read the LEGACY files, which
// hold nine moods under their old names ("🎃 Something wicked", not "🎃 Horror"): the other 21 moods are not known there (known() below skips them) and wicked never yields to the genre Horror.
// Measured by the review: 395 of 558 cards of the old pieces and 3,262 of 4,611 cards of the profiles (Tonight apart) differ from the film page; Mood-group moods, card x film page: light 1,456 x 2,482,
// heavy 1,129 x 1,960, night 1,030 x 1,561, world 1,016 x 1,700, critics 830 x 1,660. Moving the profiles to the v2 index would fix it and breaks test/profile-parity.test.js ("not one request reads a v2 file"): Marco's to decide (BACKLOG.md).
import { dryName } from './profiles.js';
import { plainName } from './plain-name.js';
import { PAGE_ID } from './page-source.js';

export const plain = s => plainName(String(s));
export const capital = s => s.charAt(0).toUpperCase() + s.slice(1);
/**
 * The image behind a film's title, by IMDb id: ONE rule and one source for the film page (page.js) and for the catalog cards (meta.js; Marco, 14/11/2026: on the Samsung TV a card with no
 * `background` showed the poster enlarged behind the title). It is the image service's address for the id and nothing else: no column of the index and no field of the page record is read.
 * Only for an id of the shape the film page requires (page-source.js PAGE_ID: "tt" and up to 10 digits); for anything else there is NO address (undefined, and the card goes out
 * without the field), so a damaged id in an index can never write a path, a query or another host's address into a card (security review, 14/11/2026). The page already refused such an id.
 */
export const backgroundOf = tt => (typeof tt === 'string' && PAGE_ID.test(tt) ? `https://images.metahub.space/background/medium/${tt}/img` : undefined);
export const searchLink = name => `stremio:///search?search=${encodeURIComponent(name)}`;
const CINEMETA = encodeURIComponent('https://v3-cinemeta.strem.io/manifest.json'); // the same for every genre chip: encoded once (28/10/2026, CPU of the cards)
const genreLinks = new Map(); // genre name -> its link (about thirty names in the index); a catalog page asks for the same few hundreds of times
export const genreLink = name => {
  let url = genreLinks.get(name);
  if (url === undefined) { url = ['Music', 'TV Movie'].includes(name) ? searchLink(name) : `stremio:///discover/${CINEMETA}/movie/top?genre=${encodeURIComponent(name === 'Science Fiction' ? 'Sci-Fi' : name)}`; if (genreLinks.size < 500) genreLinks.set(name, url); }
  return url;
};
export const link = (category, name, url) => ({ category, name, url });

/**
 * The links of the Mood group for a film.
 *   film   { mo: [[mood id, fit]], g: [genres], kw: [terms] }, the shape of a page record (page-source.js)
 *   byId   Map: mood id -> { name }          the moods of the index (`name` is the build's, with its emoji)
 *   menu   Map: mood id -> { label, order }  the Moods menu: `label` is what a search for the mood is made with, `order` breaks a tie of fits
 *   rename Map (optional): the build's name of a mood -> the name to show instead (a profile's own name for the mood, worker/src/profiles.js relabelOf)
 *   lead   a mood id (optional): shown FIRST, then the best fits without it, four in all. The mood a profile's Tonight drew the film for (Marco, 28/10/2026), which the removed line "Mood: …" used to name.
 *          It is subject to the same rule as any mood: named like a genre of the film, it yields to the genre chip.
 * A mood the maps do not know is left out (the film page refuses the whole page before it gets here: toPage "unresolved page mood"; a catalog card must not fail for it).
 *
 * A mood named like one of the genres to be shown is left out and the next fit takes its slot: the genre chip stays (Marco, 28/10/2026).
 * A chip is skipped when its plain() equals one already shown; a term is also skipped when it is "Film " + a shown name
 * ("Film noir" after "Noir"). No whole-word rule: "Neo-noir" and "Body horror" stay. A skipped term frees its slot for the next one.
 * The rename changes the TEXT of a mood chip only: which moods show is judged on the build's name in the index the card was read from (for a profile, the legacy file: see the top of this file).
 */
// A mood's dry name and its plain() key are fixed data of the index: the cards compute them once per index (meta.js menusOf, `dry` and `key`); the film page computes them here.
const dryOf = m => m.dry ?? dryName(m.name);
const keyOf = m => m.key ?? plain(dryName(m.name));
export function moodGroup({ mo = [], g = [], kw = [] }, byId, menu, rename, lead) {
  const links = [];
  const genreKeys = new Set(g.slice(0, 3).map(plain));
  const known = id => byId.has(id) && menu.has(id);
  const ranked = mo.filter(([id]) => known(id)).sort((a, b) => b[1] - a[1] || menu.get(a[0]).order - menu.get(b[0]).order);
  const fits = (lead !== undefined && known(lead) ? [[lead], ...ranked.filter(([id]) => id !== lead)] : ranked).filter(([id]) => !genreKeys.has(keyOf(byId.get(id)))).slice(0, 4);
  const shown = new Set();
  for (const [id] of fits) { const mood = byId.get(id), name = (rename && rename.get(mood.name)) || dryOf(mood); shown.add(plain(name)); links.push(link('Mood', name, searchLink(menu.get(id).label))); }
  for (const name of g.slice(0, 3)) { const key = plain(name); if (!key || shown.has(key)) continue; shown.add(key); links.push(link('Mood', name, genreLink(name))); }
  let count = 0;
  for (const word of kw) { const key = plain(word); if (!key || shown.has(key) || (key.startsWith('film ') && shown.has(key.slice(5)))) continue; shown.add(key); links.push(link('Mood', capital(word), searchLink(word))); if (++count === 3) break; }
  return links;
}
