// The complete public movie meta. Input fields are projected explicitly, never spread.
import { PAGE_ID, YOUTUBE_ID, privatePageText } from './page-source.js';
import { link, moodGroup, searchLink, genreLink, backgroundOf } from './mood-group.js';
import { takenWords, listChip } from './text.js';
export { searchLink, genreLink }; // they live in mood-group.js now (the catalog cards use the same links); the page keeps exporting them
export function toPage(r, { people = [], moods = [], moodMenu = [], lists = [] } = {}) {
  if (!r || !PAGE_ID.test(r.t)) throw Error('invalid page id');
  for (const text of [...moods.flatMap(m => [m.name, m.label]), ...moodMenu.map(m => m.label), ...lists.flatMap(l => [l.label, l.short])].filter(s => typeof s === 'string'))
    if (privatePageText(text)) throw Error('private page menu');
  const lb = `https://letterboxd.com/imdb/${r.t}/`;
  // No Ratings group (Marco, 28/10/2026): the Letterboxd score lives only on the poster cover.
  const links = [];
  if (r.im != null) links.push(link('imdb', r.im.toFixed(1), `https://imdb.com/title/${r.t}`));
  links.push(link('share', r.n, lb));
  for (const name of (r.d || []).slice(0, 2)) links.push(link('Directors', name, searchLink(name)));
  for (const name of (r.c || []).slice(0, 5)) links.push(link('Cast', name, searchLink(name)));
  const byId = new Map(moods.map(m => [m.id, m])), menu = new Map(moodMenu.map((m, i) => [m.id, { ...m, order: i }]));
  // Even a reference beyond the four shown must resolve. Adjacent build timestamps are allowed.
  for (const [id] of r.mo || []) if (!byId.has(id) || !menu.has(id)) throw Error('unresolved page mood');
  for (const [id] of r.li || []) if (!lists.some(l => l.id === id)) throw Error('unresolved page list');
  // The Mood group (moods, genres, terms; the rules are in mood-group.js) is shared with the cards of the catalogs.
  links.push(...moodGroup(r, byId, menu));
  // The Lists chip says the short name (22/10/2026), the full name of a build that has none; the search opens the list by either. A short that is a mood's or a genre's word is SAID but not searched (text.js listChip).
  const taken = takenWords(moods, moodMenu);
  for (const [id] of (r.li || []).slice(0, 3)) { const { text, term } = listChip(lists.find(l => l.id === id), taken); links.push(link('Lists', text, searchLink(term))); }
  const result = { id: r.t, type: 'movie', name: r.n, poster: `https://images.metahub.space/poster/small/${r.t}/img`, posterShape: 'poster', background: backgroundOf(r.t), logo: `https://images.metahub.space/logo/medium/${r.t}/img`, ...(r.y != null ? { releaseInfo: String(r.y) } : {}), ...(r.rt != null ? { runtime: `${r.rt} min` } : {}), description: r.syn || '', links,
    ...(typeof r.yt === 'string' && YOUTUBE_ID.test(r.yt) ? { trailerStreams: [{ title: r.n, ytId: r.yt }] } : {}),
    videos: [], behaviorHints: { defaultVideoId: r.t, hasScheduledVideos: false } };
  // Menus contribute labels and search terms after shard validation. Guard the final projection too.
  if (privatePageText(JSON.stringify(result))) throw Error('private page content');
  return result;
}
// Marco, 29/10/2026 ("eh pro fusion"): Fusion Media Center refused the page manifest ("manifesto inválido") and keeps no log of why; nothing in it
// is without precedent in the manifests Fusion already holds except being meta-only with resources in object form. Two variants of the same addon,
// each at its own base so Fusion derives its base root from the URL: `fusion-a` says `resources` as strings; `fusion-b` adds a catalog hidden behind
// a required search (empty answer), for a validator that wants a catalog. Same meta, same page; the variants exist only to be tried in Fusion.
export const PAGE_VARIANTS = ['fusion-a', 'fusion-b'];
export function parsePagePath(path) {
  const v = /^\/page(?:\/(fusion-[a-z]))?(\/.*)$/.exec(path);
  if (!v) return null;
  const variant = v[1] || null, rest = v[2];
  if (variant && !PAGE_VARIANTS.includes(variant)) return null;
  if (rest === '/manifest.json') return { manifest: true, variant };
  if (variant === 'fusion-b' && /^\/catalog\/movie\/page-search(?:\/search=[^/]*)?\.json$/.test(rest)) return { catalog: true, variant };
  const m = /^\/meta\/movie\/(tt\d{1,10})\.json$/.exec(rest);
  return m ? { tt: m[1], variant } : null;
}
