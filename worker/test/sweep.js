// A sweep of the Worker's answers, for comparing two Workers (the code of origin/main against this one) over the same published files: test/profile-parity.test.js, test/real-index.test.js.
// Not a test: it exports what the tests share. (`node --test` also loads it, and finds nothing to run.)

import crypto from "node:crypto";
import { PROFILE_VERSION } from "../src/profiles.js";

/** The Worker module's handler over `files` (file name → text; a name that is not there is a 404), a clock fixed at `now` and no subtitle source. `calls` collects the file names it asks for. */
export function handlerOver(mod, store, files, { now, dir, calls = [] }) {
  const fetchImpl = async (url) => { const name = url.slice(dir.length); calls.push(name); return files[name] != null ? new Response(files[name]) : new Response("not found", { status: 404 }); };
  const subtitles = { list: async () => ({ subs: [] }), exact: async () => ({ status: "none", ids: new Set() }) };
  const handle = mod.createHandler({ store: store.createStore({ fetchImpl, caches: undefined, log: () => {} }), subtitles, now });
  return async (path) => {
    const res = await handle(new Request("https://mood-engine.example.workers.dev" + path), { INDEX_URL: `${dir}index.json` }, undefined);
    return { status: res.status, text: await res.text(), headers: res.headers };
  };
}

/**
 * The fourth deliberate difference from the reference (Marco, 20/10/2026, "description v3"; lib/describe.js; numbered after the My series row of the third, which reached origin/main first): the `description` of a FILM meta is a new format, so it cannot be compared with the
 * reference's. The digest leaves it out of the film metas (the series metas keep theirs) and keeps every other byte of the answer: the films, their order, their ids, names, posters, years, genres,
 * the headers and the count. fixtures/origin-main-answers.json was rewritten with this digest FROM THE REFERENCE CODE (REFERENCE_WORKER_SRC, 6331bd6), not from this one; the descriptions of this
 * Worker are pinned by test/handler.test.js, test/v2.test.js, test/profiles.test.js and test/real-index.test.js.
 */
/**
 * The sixth deliberate difference (Marco, 28/10/2026 ~04:20 UTC, questionnaire, the recommended option, after "os 5 perfis NÃO mudam" of 14/10/2026): the cards of the Worker carry chips, so a film meta has a `links` key that the reference's does not.
 * The digest leaves `links` out of the film metas as well, next to `description` (the card's text, the fourth difference). What stays pinned against the reference, and is OBSERVABLE with the fixture of the profiles: the status and the headers, the manifests byte for byte, and in every catalog the films, their
 * order, ids, names, posters, years, runtimes, the total and the page size. The digest also covers the IMDb grade and the genres, but test/profile-fixture.js builds its films with NO `imdbRating` and NO `genres`, so a change of either leaves the tests green (found by the independent review of 28/10/2026, on the base too; open, BACKLOG.md). The reference's metas have no `links`, so leaving it out changes no digest of the golden: the golden was regenerated from the reference code (REFERENCE_WORKER_SRC, 6331bd6)
 * and came out byte for byte the same. The RISK accepted: the text and the chips of a profile's cards are no longer compared with the reference; they are pinned by test/card-links.test.js and test/profiles.test.js.
 */
/**
 * The seventh deliberate difference (Marco, 14/11/2026: on the Samsung TV a card with no `background` showed the poster enlarged behind the title): every FILM card carries `background`, the address the film page
 * already used for the same id (worker/src/mood-group.js backgroundOf), which the reference's cards did not have. `cardBackground(id)` is that address written down HERE, not imported from the code under test.
 * `withoutCardBackground(text)` takes the key out of a film card ONLY when its value is exactly that address for the card's own id, and leaves every other byte: a card with another image, or with the image of
 * another film, keeps its key and so differs from the reference. A card with NO background is the reference's card and passes these comparisons, which is why test/card-background.test.js asks for the key on
 * every film card of every catalog. The digest below does the same, so fixtures/origin-main-answers.json and fixtures/friend-view-public-routes.json stay the reference's: neither was rewritten for this.
 */
export const cardBackground = (id) => `https://images.metahub.space/background/medium/${id}/img`;
const isReferenceKey = (m, k) => !(k === "background" && m[k] === cardBackground(m.id));
export function withoutCardBackground(text) {
  try {
    const j = JSON.parse(text);
    if (j && Array.isArray(j.metas) && j.metas.some((m) => m && m.type === "movie" && "background" in m)) return JSON.stringify({ ...j, metas: j.metas.map((m) => (m && m.type === "movie" ? Object.fromEntries(Object.entries(m).filter(([k]) => isReferenceKey(m, k))) : m)) });
  } catch { /* not JSON: left as it is */ }
  return text;
}
const CARD_KEYS = new Set(["description", "links"]);
export function withoutFilmDescriptions(text) {
  try {
    const j = JSON.parse(text);
    if (j && Array.isArray(j.metas) && j.metas.some((m) => m && m.type === "movie")) return JSON.stringify({ ...j, metas: j.metas.map((m) => (m && m.type === "movie" ? Object.fromEntries(Object.entries(m).filter(([k]) => !CARD_KEYS.has(k) && isReferenceKey(m, k))) : m)) });
  } catch { /* not JSON: hashed as it is */ }
  return text;
}

/** What identifies an answer: the status, the headers a client acts on, and the sha256 of the body. */
export const digest = (r) => [r.status, r.headers.get("content-type"), r.headers.get("cache-control"), r.headers.get("x-total"), r.headers.get("x-page-size"), r.headers.get("x-profile"), crypto.createHash("sha256").update(withoutFilmDescriptions(r.text)).digest("hex").slice(0, 24)].join("|");

/**
 * The requests that visit a manifest: the manifest itself and every catalog it declares, each bare, with its first three menu options (bare, with a decade, a second page) and one country when it has the menu.
 * prefix: "" for the old address, "/p/<profile>" for a profile.
 */
export function pathsOf(prefix, manifest) {
  const enc = encodeURIComponent;
  const out = [`${prefix}/manifest.json`];
  for (const c of manifest.catalogs) {
    const base = `${prefix}/catalog/${c.type}/${c.id}`;
    const genre = (c.extra || []).find((e) => e.name === "genre" && e.isRequired);
    const country = (c.extra || []).find((e) => e.name === "country");
    if (c.id === "search") { out.push(`${base}/search=${enc("the")}.json`, `${base}/search=${enc("night")}&skip=100.json`); continue; }
    if (!genre) { out.push(`${base}.json`, `${base}/skip=100.json`); continue; }
    out.push(`${base}.json`); // asked with no menu at all, as NuvioTV does
    for (const [i, o] of genre.options.slice(0, 3).entries()) {
      out.push(`${base}/genre=${enc(o)}.json`);
      if (i === 0) out.push(`${base}/decade=1990s&genre=${enc(o)}.json`, `${base}/genre=${enc(o)}&skip=100.json`, `${base}/rating=${enc("4.0–4.2")}&genre=${enc(o)}.json`);
      if (i === 0 && country && country.options.length) out.push(`${base}/country=${enc(country.options[0])}&genre=${enc(o)}.json`);
    }
  }
  return out;
}

/** path → digest, for every path, in order. */
export async function sweep(get, paths) {
  const out = {};
  for (const p of paths) out[p] = digest(await get(p));
  return out;
}

/**
 * One deliberate difference between the manifests of this Worker (the five profiles, the Marco profile and, since 19/10/2026, the main /manifest.json) and the reference (origin/main 6331bd6): the sentence about subtitles in the description (19/10/2026, W4: the
 * hash search that finds "the ones made for your file" is only on the private address, so the old promise was no longer true). `asReference(get)` puts the reference's sentence back into the
 * text of a profile manifest or of the main one (Marco's decision of 19/10/2026: the main description says the same sentence), so that every OTHER byte is still compared with the golden digests (fixtures/origin-main-answers.json) and the golden stays the reference's (its only rewrite is the film-description digest of the fourth difference, below). That the new sentence is
 * the one in the manifests is pinned by test/profiles.test.js (profiles) and by fixtures/manifest-3.3.0.json and legacy-manifest.json (main).
 */
export const SUBTITLES_SENTENCE = { now: "Also English and Portuguese subtitles: the official list, and the ones made for your file first only on the private address.", reference: "Also English and Portuguese subtitles, the ones made for your file first." };
/**
 * The fifth deliberate difference (Marco, 24/10/2026, questionnaire: "Subir a versão dos perfis para 3.2.1"): the profiles' manifests say PROFILE_VERSION (3.2.1) where the reference said 3.2.0, so that
 * "Refresh addon" in each Nuvio profile renews the menus with the eight lists of 23/10/2026. `asReference` puts the reference's version back into a profile manifest, so every OTHER byte is still compared.
 */
export const REFERENCE_PROFILE_VERSION = "3.2.0";
export const asReference = (get) => async (path) => {
  const r = await get(path);
  if (!/^(\/p\/[^/]+)?\/manifest\.json$/.test(path)) return r;
  let text = r.text.split(SUBTITLES_SENTENCE.now).join(SUBTITLES_SENTENCE.reference);
  if (path.startsWith("/p/")) text = text.split(`"version":"${PROFILE_VERSION}"`).join(`"version":"${REFERENCE_PROFILE_VERSION}"`);
  return { ...r, text };
};

/**
 * The second deliberate difference from the reference (Marco, 19/10/2026, questionnaire; PR #47): the profiles' own Tonight (src/profiles.js) draws EVENLY over a mood's top 12, where the reference drew with
 * `rand() ** 1.6`, so the picks of `/p/<profile>/catalog/movie/tonight.json` are not the golden's, and no neutralising of the text can put the old picks back (a different draw is a different film list).
 * `withoutTonight(paths)` leaves those addresses out of a comparison with the reference; test/profile-parity.test.js pins what is left out (exactly these addresses, still answering 200 with the golden's
 * headers and x-total, with the bodies differing) so the exception cannot grow into other rows. The golden stays the reference's: it is not regenerated from this code (the one rewrite of it, the film-description digest of the fourth difference, was made from the reference's code).
 */
export const isProfileTonight = (p) => /^\/p\/[^/]+\/catalog\/movie\/tonight\.json$/.test(p);
export const withoutTonight = (paths) => paths.filter((p) => !isProfileTonight(p));

/**
 * The third deliberate difference from the reference (Marco, 20/10/2026, questionnaire; written 21/10/2026): the My series row is no longer the reference's 25 titles in a fixed order but 85 in this week's order
 * (series-list.js, series.js `rotate`), so the four golden addresses of the row (`/catalog/series/my-series.json` and `/skip=100.json`, bare and under `/p/marco`) differ from the golden in their total and,
 * for the full page, in their body. `withoutMySeries(paths)` leaves them out of a comparison with the reference; test/profile-parity.test.js pins what is left out (exactly these four addresses, with the golden's
 * status, content type, cache and page size, and a total of 85). The golden stays the reference's for this row (the fixture was not edited for it; the only rewrite of fixtures/origin-main-answers.json is the film-description digest of the fourth difference above, made from the reference's own code); the manifests, which are unchanged, are still compared byte for byte.
 */
export const isMySeries = (p) => /^(\/p\/marco)?\/catalog\/series\/my-series(\/[^/]*)?\.json$/.test(p);
export const withoutMySeries = (paths) => paths.filter((p) => !isMySeries(p));
