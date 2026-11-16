// Mood Engine, live. index.js exports the fetch handler and the bound WillState class.
// Ordinary constants remain in this module rather than the Worker entry point.
//
//   GET /manifest.json
//   GET /catalog/movie/<id>.json
//   GET /catalog/movie/<id>/<extras>.json        extras in any order: genre, decade, runtime, country, rating, search, skip
//   GET /catalog/series/my-series.json           the fixed "My series" row (series-list.js, 85 titles, in this week's order from series.js rotate()): it reads nothing, not even the index; any other series id is an empty page
//   GET /subtitles/<type>/<id>/<extras>.json     extras in any order: videoHash, videoSize, filename (see subtitles.js)
//   GET /subfile/<file_id>/<exp>/<sig>.srt        a subtitle the official list lacks, downloaded with Marco's OpenSubtitles account (subfile.js); a 404 unless his secrets are set, or after <exp>
//                                                 (an address without <exp> is a 404: that form stopped being accepted on 13/11/2026 and its code is gone)
//   GET /p/<profile>/…                           the same, for one of the six profiles (profiles.js; Marco, 11/10/2026). The paths above, without
//                                                /p/, are the old address and answer exactly as before.
//
//   GET /u/<friend>/…                            Marco's index as one of his seven friends sees it (friends.js; Marco, 29/10/2026): the manifest, the catalogs and the public subtitles, with the friend's "seen" and the friend's Watchlist row.
//                                                /u/friend-a/ is Will's own entry (people.js), not a friend.
//
//   GET /k/<SUBTITLES_PRIVATE_TOKEN>/…           the private address (Marco, 12/10/2026): any path above, served exactly like it, plus the subtitles the official list lacks
//
// It reads the index the nightly build publishes (docs/data/index.json and its pieces) and answers from it. It has no accounts of yours of any kind for films:
// everything it says about films is already public in those files; the My series row is bundled in the Worker itself (series.js, no ratings). The films, the catalogs and the
// profiles write nothing. On this addon's routes the only thing it writes is the optional Workers KV binding SUBS, for the subtitles the official list lacks (subfile.js): 2 writes
// and 1 delete for each subtitle downloaded (the file and the day's counter, W5 of 19/10/2026; the delete clears the health marker), one write when a download fails or the quota
// runs out or a login fails, one write each time the OpenSubtitles login token is renewed (about once a day); nothing about films, nothing from a request on the public address.
// (Will's intake API, upload/, is a separate surface, off by default: when on, it keeps its own state in the WillState Durable Object; see worker/README.md.) The secrets are optional and about OpenSubtitles only: the API key,
// used by /subtitles; for the subtitles the official list lacks, the user name and password of Marco's account (OPENSUBTITLES_USERNAME, OPENSUBTITLES_PASSWORD) and the
// private token that makes the /k/ address and signs the /subfile addresses (SUBTITLES_PRIVATE_TOKEN). None is ever written anywhere (KV included), logged, or sent in an answer.
//
// The selected file affects CPU while preserving the catalog's selection and text. The legacy family reads index-board.json for the Board and manifest,
// index-moods.json for Moods, index-friends.json for Friends, index-directors.json for Loved by directors and index-list-<id>.json for a list.
// Explore, Search and missing-piece fallbacks can read the whole index. Do not infer route CPU from an old parse estimate or a file's size alone:
// the 30/10/2026 Cloudflare observations and their limits are recorded in research/2026-10-30-friends-stability-cpu.md.
//
// The v2 family (3.3.0; Marco, 13 and 14/10/2026), written next to those files by a build with a `board` (lib/index-export.js pieces2): index-v2-menus.json (the menus, the 54 Board rows and
// the Moods menu: no films), index-v2-row-<id>.json (one Board row, at most 100 films), index-v2-mood-<id>.json (every film of one mood), index-v2-opt-<catalog>-<option>.json (a calculated Discover option) and index-v2.json (the whole). Complete options serve filters, friends and pagination from their own piece;
// partial options keep the unfiltered Marco prefix shortcut and otherwise fall back to the whole v2 index. Animation may be completed by the exporter within its encoded byte limit. The old address
// and the Marco profile read them: the manifest from the menus, a Board row from its row slice, a mood (and the Friends this week option) from its slice, Explore and Search from the whole;
// Lists, Lists (unseen), Friends and Loved by directors stay on the legacy files. A v2 file that is missing is replaced by the whole v2 index; no v2 menus at all, and the Worker answers
// exactly as 3.1.0 did, from the legacy files alone (that is the fallback while the build publishes no board). The five other profiles never read a v2 file.

import { decode, matchList, matchOption, parseCatalogPath, parseExtras, skipOf } from "./extras.js";
import { describeFile, ownLanguageNames, parseSubtitlesPath, shape, VALID_ID, variesByUserAgent, wantsOwnNames } from "./subtitles.js";
import { createLanguageSource } from "./film-languages.js";
import { createSubfileSource, expiryFor, linkIsGood, sameSecret, signFileUntil, subfileConfigured, SUBFILE_PATH } from "./subfile.js";
import { createPageSource, shardOf } from "./page-source.js";
import { toPage, parsePagePath } from "./page.js";
import { withDeadline } from "./subtitles-source.js";
import { createSubtitleSource } from "./subtitles-source.js";
import { discoverOption, includeSeen, completeOptionPage, optionPage, page as pageOf, PAGE, rulesOf } from "./catalogs.js";
import { buildManifest, buildProfileManifest, buildPageManifest, isV2 } from "./manifest.js";
import { compileFilters } from "./filters.js";
import { dayOf, listsOfGroup, listsOfTheme, profileOf, profileRow, relabelOf, themesOf, VOUCH, WHAT } from "./profiles.js";
import { SERIES_LIST, SERIES_CATALOG_ID, rotate, toSeriesMeta } from "./series.js";
import { toMeta } from "./meta.js";
import { activePublication, createActivePublication } from "./upload/api.js";
import { headerText } from "./build-header.js";
import { releaseIndex, resolvePerson } from "./people.js";
import { friendOf, NoMasks, pieceId, WATCHLIST_ROW } from "./friends.js";
import { createStore } from "./store.js";

export const DEFAULT_INDEX_URL = "https://marcogusmao.github.io/mood-engine/data/index.json";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" };
const CATALOG_MAX_AGE = 300;
const MAX_PIECES = 8; // a profile's theme reads at most this many list pieces; more lists than that, it reads the whole index once
const DEGRADED_MAX_AGE = 30; // an empty page caused by an outage must not be remembered for long
const SUBTITLES_MAX_AGE = 3600; // the official list is cached for an hour, so is the answer
const SUBTITLES_DEGRADED_MAX_AGE = 300; // an answer that is poorer than it should be (the film's language or the extra rows left out because something failed): asked again in 5 minutes
const LEGACY_ONLY = new Set(["lists", "lists-unseen", "friends", "director-picks"]); // the catalogs the v2 family does not carry (Marco, 14/10/2026): they read the legacy pieces, whatever the build publishes
const RETIRED_CATALOGS = new Set(["lists", "lists-unseen", "director-picks"]); // the catalogs 3.4.0 (Lists, Lists (unseen)) and 3.5.0 (Loved by directors: Marco, 28/10/2026, proposal 5; the index retires it) take out of the manifest and still answers: an install or a Nuvio profile from before keeps asking for them
const PRIVATE_TOKEN = /^[A-Za-z0-9_-]{16,128}$/; // what may stand in /k/<token>/
// (`headerText`, for the header values, lives in build-header.js.)
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`); // for the home pages: the host comes from the request and the owner's name from the registry (S7d, 20/10/2026: the title is escaped like the profile pages' one)

let sharedStore = null; // one per isolate: its memory is what makes the second request cheap
let sharedSubtitles = null;
let sharedLanguages = null;
let sharedSubfiles = null;
let sharedPages = null;

/** Under the private address (`priv`) every answer is `private` for caches and sends no Referer: the address is a secret, so it must not be kept by a shared cache or leak in a header. */
const respond = (request, body, { status = 200, type = "application/json; charset=utf-8", maxAge = null, extra = {} } = {}, priv = false, build = "") => {
  const headers = { ...CORS, "Content-Type": type, "X-Content-Type-Options": "nosniff", ...extra };
  const sha = headerText(build); // X-Build (W8, 19/10/2026): the commit this copy of the Worker was built from, handed in as the GIT_SHA variable when it was published; printable ASCII only, and no header at all when the variable is not set
  if (sha) headers["X-Build"] = sha; // nosniff on everything send() answers (Marco, 13/10/2026): a JSON or text answer is never read as HTML
  if (maxAge != null) headers["Cache-Control"] = `public, max-age=${maxAge}`;
  if (priv) {
    const cc = headers["Cache-Control"];
    headers["Cache-Control"] = !cc ? "private" : cc.startsWith("public") ? cc.replace(/^public/, "private") : `private, ${cc}`;
    headers["Referrer-Policy"] = "no-referrer";
  }
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(request.method === "HEAD" ? null : payload, { status, headers });
};

/** The addresses of the index and of its pieces, from the INDEX_URL setting: the pieces sit in the same folder. */
export function urlsOf(env = {}) {
  const full = env.INDEX_URL || DEFAULT_INDEX_URL;
  const dir = full.slice(0, full.lastIndexOf("/") + 1);
  return { full, page: (nn) => `${dir}page-${nn}.json`, v2: `${dir}index-v2.json`, menus: `${dir}index-v2-menus.json`, row: (id) => `${dir}index-v2-row-${encodeURIComponent(id)}.json`, mood: (id) => `${dir}index-v2-mood-${encodeURIComponent(id)}.json`, opt: (catalogId, optionId) => `${dir}index-v2-opt-${encodeURIComponent(catalogId)}-${encodeURIComponent(optionId)}.json`, board: `${dir}index-board.json`, moods: `${dir}index-moods.json`, friends: `${dir}index-friends.json`, directors: `${dir}index-directors.json`, list: (id) => `${dir}index-list-${encodeURIComponent(id)}.json`, languages: `${dir}film-languages.json` };
}

export function createHandler({ store, pages, subtitles, languages, subfiles, publication = activePublication, publicationCache, pageTimeoutMs = 1750, now = Date.now, log = (o) => console.warn(JSON.stringify(o)) } = {}) {
  // Will's active publication is kept 60 s in the memory of this handler (one per isolate); see createActivePublication in upload/api.js (S1, 20/10/2026). A `publication` given by a test is wrapped the same way, always enabled.
  const activeOf = publicationCache || createActivePublication({ read: publication, now, log, ...(publication === activePublication ? {} : { enabled: () => true }) });
  return async function handle(request, env = {}, ctx) {
    const st = store || (sharedStore ||= createStore({ ttlMs: (Number(env.INDEX_TTL_SECONDS) || 1800) * 1000, ...(Number(env.PIECE_CACHE_MAX) > 0 ? { pieceMax: Number(env.PIECE_CACHE_MAX) } : {}), ...(Number(env.PIECE_CACHE_BYTES) > 0 ? { pieceBytes: Number(env.PIECE_CACHE_BYTES) } : {}) }));
    const subs = subtitles || (sharedSubtitles ||= createSubtitleSource());
    const subfileSource = () => subfiles || (sharedSubfiles ||= createSubfileSource());
    const filmLanguages = languages || (sharedLanguages ||= createLanguageSource());
    let isPrivate = false, base = "";
    let revision = null;
    let friend = null; // /u/<friend>/ (friends.js): { slug, name, bit, seen }, set below once the index has said who the friend is
    const send = (req, body, opts = {}) => respond(req, body, { ...opts, extra: { ...opts.extra, ...(revision ? { "X-Mood-Person": "friend-a", "X-Mood-Revision": revision } : {}), ...(friend ? { "X-Mood-Friend": friend.slug } : {}) } }, isPrivate, env.GIT_SHA);
    // The preflight answers before the owner is looked at, as on main (20/10/2026, owner review item 6): OPTIONS on a path with an invalid /u/ segment used to become a 404.
    if (request.method === "OPTIONS") {
      const priv = new URL(request.url).pathname.startsWith("/k/");
      return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Max-Age": "86400", ...(priv ? { "Cache-Control": "private", "Referrer-Policy": "no-referrer" } : {}) } });
    }
    const url = new URL(request.url);
    const owner = resolvePerson(url.pathname, env.INDEX_URL || DEFAULT_INDEX_URL);
    if (!owner) return send(request, { err: "not found" }, { status: 404 });
    const { person } = owner;
    base = owner.base;
    url.pathname = owner.path;
    // The private address (Marco, 12/10/2026): /k/<SUBTITLES_PRIVATE_TOKEN>/ in front of ANY path is served exactly like the path without it (the manifest is byte for byte the
    // same), and only there are the subtitles the official list lacks listed. A wrong or absent token, or no token set, is a 404, as if the path did not exist.
    if (url.pathname === "/k" || url.pathname.startsWith("/k/")) {
      const parts = url.pathname.split("/"); // ["", "k", token, ...rest]
      const token = parts[2] || "";
      if (!PRIVATE_TOKEN.test(token) || !(await sameSecret(token, env.SUBTITLES_PRIVATE_TOKEN))) return send(request, { err: "not found" }, { status: 404 });
      isPrivate = true; base = `/k/${token}`; // (from here every answer is private)
      url.pathname = "/" + parts.slice(3).join("/");
    }
    if (request.method !== "GET" && request.method !== "HEAD") return send(request, { err: "method not allowed" }, { status: 405 });
    if (person) {
      if (url.pathname.split('/').some(s => ['subtitles', 'subfile', 'series', 'k', 'page', 'meta'].includes(s))) return send(request, { err: 'not found' }, { status: 404 });
      let active;
      try { active = await activeOf(env); } catch { return send(request, { err: 'publication unavailable' }, { status: 503 }); }
      if (!active) return send(request, { err: 'not ready' }, { status: 503 });
      revision = active.revision;
      try { owner.full = releaseIndex(env.INDEX_URL || DEFAULT_INDEX_URL, revision); } catch { return send(request, { err: 'publication unavailable' }, { status: 503 }); }
    }
    const urls = urlsOf(person ? { INDEX_URL: owner.full } : env);
    let incompatible = null;
    // Validate every returned piece, including stale cache copies and every fallback.
    // The legacy Marco files predate owner identity and remain accepted without it.
    const get = async (url, context) => {
      // A fresh cache can predate mask support. Recover only the incompatible file, with the store's
      // shared retry bound; the guards below still refuse an incompatible publication (30/10/2026).
      const accepts = (index) => index.masks && !!friendOf(index, owner.friend);
      const got = owner.friend && st.getCompatible ? await st.getCompatible(url, context, accepts) : await st.get(url, context);
      if (owner.friend && got && !accepts(got.index)) incompatible = got;
      return person && (got?.index.meta?.personId !== person.id || got?.index.meta?.revision !== revision) ? null : got;
    };
    // The Board and the manifest need only the menus and ~500 films: the small file. If a piece is missing, the whole index stands in.
    const small = async () => (await get(urls.board, ctx)) || (await get(urls.full, ctx));
    const piece = async (url) => (await get(url, ctx)) || (await get(urls.full, ctx));
    /** The v2 family's menus, when the build published them (the Board, the Moods menu, the 46 countries; no films); null otherwise, and then everything below answers from the legacy files, as 3.1.0. */
    const v2menus = async () => { const got = await get(urls.menus, ctx); return got && isV2(got.index) ? got : null; };
    /** What the manifest of the old address (and of the Marco profile) is built from: the v2 menus, else the legacy Board part. */
    const top = async () => (await v2menus()) || (await small());
    /** A slice of the v2 family (a row, a mood); a slice that is missing is replaced by the whole v2 index. */
    const slice = async (url) => (await get(url, ctx)) || (await get(urls.v2, ctx));
    /** The smallest file that holds every film this catalog request can show. */
    const indexFor = async ({ id, extras }) => {
      if (id === "explore" || id === "search") return get(urls.full, ctx);
      if (id === "moods") return piece(urls.moods);
      if (id === "friends") return piece(urls.friends);
      if (id === "director-picks") return piece(urls.directors);
      if (id === "lists" || id === "lists-unseen") {
        const menus = await small();
        const list = menus && matchList(extras.genre, menus.index.lists);
        return list ? piece(urls.list(list.id)) : menus; // no such list: the menus answer with an empty page
      }
      return small();
    };
    const info = (got) => {
      if (!got) return { "X-Index-Source": "none" };
      const { rules, from } = rulesOf(got.index); // which rule is in force (its stars), and whether it came from the index or is the Worker's default
      return { "X-Index-Source": got.source, "X-Index-Age-Seconds": String(Math.round(got.ageMs / 1000)), "X-Index-Built-At": got.index.meta.builtAt, "X-Floor": `${rules.minStars} from ${from}` };
    };

    // The friends' view (Marco, 29/10/2026; friends.js). Only the manifest, the catalogs, the public subtitles and the install page exist under /u/<friend>/: the film page, the profiles, the private address
    // and the subtitle downloads do not. The seven addresses are a closed list (friends.js: any other is a 404 before a file is read) and the index says where each friend is (`friends.people`), so a listed friend the index lacks is a 404 too; an index without the masks (built before 29/10/2026) or without the v2 family cannot serve a
    // friend at all, and says so (503), never Marco's own "seen" or Marco's own Watchlist.
    if (owner.friend) {
      const p = url.pathname;
      if (!(p === "/" || p === "" || p === "/manifest.json" || p.startsWith("/catalog/") || p.startsWith("/subtitles/"))) return send(request, { err: "not found" }, { status: 404 });
      const menus = await v2menus();
      if (!menus) return send(request, { err: "the index is not available yet; try again in a minute" }, { status: 503, extra: { ...info(null), "Cache-Control": "no-store" } });
      friend = friendOf(menus.index, owner.friend);
      if (!friend) return send(request, { err: "not found" }, { status: 404 });
      if (!menus.index.masks) return send(request, { err: "the friends' view needs the next build of the index" }, { status: 503, extra: { ...info(menus), "Cache-Control": "no-store" } });
    }
    /** Resolve the friend's bit in the file being read: cached pieces may have a different people order from the menus. Missing masks or a missing friend give a 503. */
    const page = (index, id, extras, opts) => {
      if (!friend) return pageOf(index, id, extras, opts);
      const viewer = friendOf(index, friend.slug);
      if (!index.masks || !viewer) throw new NoMasks(id);
      return pageOf(index, id, extras, { ...opts, seen: viewer.seen });
    };

    // Page routing is before every catalog read, and the person guard above precedes DO.
    if (url.pathname.startsWith("/page/")) {
      const req = parsePagePath(url.pathname);
      if (!req) return send(request, { err: "not found" }, { status: 404 });
      if (req.manifest) return send(request, buildPageManifest(req.variant), { maxAge: 300 });
      if (req.catalog) return send(request, { metas: [] }, { maxAge: 300 }); // the fusion-b trial's search catalog: a required search, nothing to answer
      const unavailable = (status = "failed") => send(request, { err: "page unavailable" }, { status: 503, extra: { "X-Page": status, "Cache-Control": "no-store" } });
      try {
        return await withDeadline(pageTimeoutMs, async () => {
          const source = pages || (sharedPages ||= createPageSource());
          const menuPromise = v2menus().catch(() => null);
          const got = await source.lookup(urls.page(shardOf(req.tt)), req.tt);
          const extra = { "X-Page": got.status, ...(got.builtAt ? { "X-Page-Built-At": headerText(got.builtAt) } : {}) };
          if (got.status === "absent") return send(request, { err: "not found" }, { status: 404, maxAge: 3600, extra });
          if (!got.record || !["ok", "stale"].includes(got.status)) return unavailable(got.status === "paused" ? "paused" : "failed");
          const menus = await menuPromise;
          if (!menus || menus.index.meta?.part !== "v2-menus") return unavailable();
          const mi = menus.index;
          const validMenu = (xs, fields) => Array.isArray(xs) && new Set(xs.map(x => x?.id)).size === xs.length && xs.every(x => x && fields.every(k => typeof x[k] === "string" && x[k].trim()));
          if (!validMenu(mi.moods, ["id", "name", "label"]) || !validMenu(mi.moodMenu, ["id", "label"]) || !validMenu(mi.lists, ["id", "label"])) return unavailable();
          const meta = toPage(got.record, { people: got.people, moods: menus.index.moods, moodMenu: menus.index.moodMenu, lists: menus.index.lists });
          return send(request, { meta, cacheMaxAge: 21600 }, { maxAge: 21600, extra });
        });
      } catch { return unavailable(); }
    }

    if (url.pathname === "/" || url.pathname === "") {
      const host = esc(url.host), link = `stremio://${host}${base}/manifest.json`;
      const title = person ? `Mood Engine · ${person.name}` : friend ? `Mood Engine · ${friend.name}` : "Mood Engine";
      return send(request, `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font:16px system-ui;max-width:34em;margin:3em auto;padding:0 1em"><h1>${esc(title)}</h1><p>Install in Stremio: <a href="${link}">${link}</a></p><p>Or paste <code>https://${host}${base}/manifest.json</code> in Stremio → Addons → Add addon.</p>`, { type: "text/html; charset=utf-8", maxAge: 300 });
    }

    if (url.pathname === "/manifest.json") {
      const got = await top();
      if (!got) return send(request, { err: "the index is not available yet; try again in a minute" }, { status: 503, extra: info(null) });
      return send(request, buildManifest(got.index, { person, friend, exploreOnBoard: String(env.EXPLORE_ON_BOARD ?? "false") === "true" }), { maxAge: CATALOG_MAX_AGE, extra: info(got) });
    }

    const subtitlesFor = async (sreq) => {
      if (person) return send(request, { subtitles: [], cacheMaxAge: SUBTITLES_MAX_AGE }, { maxAge: SUBTITLES_MAX_AGE });
      // Subtitles never wait for the index and never fail loudly: a title the official list does not have, a source that is down, a bad id, all give no subtitles.
      const empty = (maxAge, why) => send(request, { subtitles: [], cacheMaxAge: maxAge }, { maxAge, extra: { "X-Subtitles": why } });
      if ((sreq.type !== "movie" && sreq.type !== "series") || !VALID_ID.test(sreq.id)) return empty(SUBTITLES_MAX_AGE, "not-a-title");
      // the official list and the hash search are independent: asked together, the answer waits for the slower one, not for both
      // and so is the film's language (film-languages.js: a small file, bounded by a short timeout, null when it cannot be had: never a failure)
      // W4 (Marco, 19/10/2026): the hash search of OpenSubtitles' REST API, which spends the account's quota and is the only way to know which subtitles were made for this exact file,
      // is made ONLY when the request came in under the private address. `isPrivate` is set above, and only after the token in /k/<token>/ was compared in full with SUBTITLES_PRIVATE_TOKEN
      // (a wrong or absent token is a 404 before this point), so it is what guards here: not the host, not text in the path or the query. On the public address and on the public
      // profiles (/p/<profile>/, which announce the subtitles resource) the answer is the official list alone, with no exact tier, and nothing is asked of the REST API (status "public").
      // Under /k/<token>/p/<profile>/ the request is private too, so the search is made.
      const exactSearch = isPrivate ? subs.exact(env, sreq.type, sreq.id, sreq.extras.videoHash) : Promise.resolve({ ids: new Set(), extras: [], status: "public" });
      const [list, exact, film] = await Promise.all([subs.list(env, sreq.type, sreq.id).catch(() => null), exactSearch,sreq.type === "movie" ? filmLanguages.lookup(urls.languages, sreq.id) : { language: null, status: "not-a-film" }]);
      if (!list) return empty(DEGRADED_MAX_AGE, "source-down"); // (the failure is logged by the source)
      const file = describeFile(sreq.extras.filename);
      // Subtitles OpenSubtitles says were made for this file but the official list lacks (Marco, 12/10/2026; subfile.js): ONLY under the private address and only with the
      // account's secrets, joined to the exact tier after the official exact ones and before the same-release ones (so an app that picks the first subtitle of its language
      // still picks an official exact one. Since the code of 14/11/2026 every row goes out under a language name instead of the code, see below; an app that picks by language code is then EXPECTED,
      // not verified, to pick none of them by itself, and the quota of 20 downloads a day to be spent only by hand). Not listed at all while the quota is out, the login is being waited out, or the last 3 downloads failed. Never a failure.
      let withExtras = list.subs, exactIds = exact.ids, added = 0, extrasState = null, degraded = film.status === "failed" || film.status === "paused" || exact.status === "failed" || exact.status === "paused"; // an answer poorer than it should be because something failed
      if (isPrivate && subfileConfigured(env)) {
        extrasState = "0";
        try {
          const official = new Set(list.subs.map((s) => String(s && s.id)));
          const lacking = (exact.extras || []).filter((e) => !official.has(e.legacy));
          if (lacking.length) {
            const offer = await subfileSource().offering(env);
            if (!offer.ok) { extrasState = `off-${offer.why}`; degraded = true; }
            else {
              const extra = [];
              const exp = expiryFor(now()); // the same for every row, and all day long: the address of a row does not change within the day
              for (const e of lacking) extra.push({ id: `os${e.fileId}`, url: `${url.origin}/subfile/${e.fileId}/${exp}/${await signFileUntil(env.SUBTITLES_PRIVATE_TOKEN, e.fileId, exp)}.srt`, lang: e.lang, movieReleaseName: e.release });
              withExtras = [...list.subs, ...extra];
              exactIds = new Set([...exact.ids, ...extra.map((s) => s.id)]);
              added = extra.length;
              extrasState = String(added);
            }
          }
        } catch (e) {
          log({ event: "subtitles-extras-failed", error: String(e) }); // (the official list alone)
          extrasState = "off-error"; degraded = true;
        }
      }
      // To EVERY request `lang` says "English · Mood", not "eng" (Marco, 14/11/2026: "All devices, as first approved"; subtitles.js: the switch OWN_LANGUAGE_NAMES, and OWN_NAMES_USER_AGENT, which is null = every app).
      // EXPECTED, NOT VERIFIED: an app that picks a subtitle by its language code then finds none of these and takes the file's own, and these stay in the list (stremio-web's code as read; the comment of a Stremio member in
      // stremio-features#1551; the Samsung app, the reason for this, is closed, and the proof is on the TV after the publication). The costs Marco accepted are beside the switch. Every app gets the same body, so nothing is
      // said to caches about the User-Agent; if OWN_NAMES_USER_AGENT becomes an expression (the names for one kind of app), the body depends on it and the answer says `Vary: User-Agent` by itself (variesByUserAgent, below).
      // Nothing in THIS Worker keeps the shaped answer: its caches hold the official list, the hash search and the film-language file, all of them before shape().
      const out = ownLanguageNames(shape(withExtras, file, exactIds, { filmLanguage: film.language }), wantsOwnNames(request.headers.get("User-Agent")));
      const maxAge = degraded ? SUBTITLES_DEGRADED_MAX_AGE : SUBTITLES_MAX_AGE;
      return send(request, { subtitles: out, cacheMaxAge: maxAge }, { maxAge, extra: { ...(variesByUserAgent() ? { Vary: "User-Agent" } : {}), "X-Subtitles": `${out.length} from ${list.subs.length}`, "X-Subtitles-Exact": `${exact.status}${exact.ids.size ? ` (${exact.ids.size} ids)` : ""}`, "X-Subtitles-File": [headerText(file.group), file.source, file.resolution].filter(Boolean).join(" ") || "unknown", "X-Subtitles-Film-Language": film.language || "unknown", "X-Subtitles-Languages-File": film.status, ...(extrasState !== null ? { "X-Subtitles-Extras": extrasState } : {}) } });
    };
    const sreq = parseSubtitlesPath(url.pathname, parseExtras, decode);
    if (sreq) return subtitlesFor(sreq);

    if (url.pathname.startsWith("/subfile/")) {
      const notFound = () => send(request, { err: "not found" }, { status: 404 });
      if (person) return notFound();
      const m = SUBFILE_PATH.exec(url.pathname);
      if (!m || !subfileConfigured(env) || !(await linkIsGood(env.SUBTITLES_PRIVATE_TOKEN, m, now()))) return notFound(); // (a path that is not /subfile/<file_id>/<exp>/<sig>.srt, which includes the address without an `exp`; a bad signature; an address past its `exp`: before anything is asked of OpenSubtitles)
      // HEAD only looks at what is kept: it never logs in and never downloads, so it can never spend the quota
      const head = request.method === "HEAD";
      const got = await subfileSource().fetchSubtitle(env, m[1], { cacheOnly: head });
      if (!got.ok) return head ? send(request, { err: "not kept; use GET" }, { status: 405, extra: { Allow: "GET", "Cache-Control": "no-store" } }) : send(request, "subtitle unavailable\n", { status: 502, type: "text/plain; charset=utf-8", extra: { "X-Subfile": got.reason, "Cache-Control": "no-store" } });
      return send(request, got.text, { type: "text/plain; charset=utf-8", maxAge: 86400, extra: { "X-Subfile": got.from } });
    }

    const mySeries = (req, extra = {}) => {
      if (person) return send(request, { err: "not found" }, { status: 404 });
      const skip = skipOf(req.extras);
      const list = rotate(SERIES_LIST, new Date(now())); // this week's order (series.js, Brasília week); 85 titles, so one page
      return send(request, { metas: list.slice(skip, skip + PAGE).map(toSeriesMeta), cacheMaxAge: CATALOG_MAX_AGE }, { maxAge: CATALOG_MAX_AGE, extra: { ...extra, "X-Total": String(list.length), "X-Page-Size": String(PAGE) } });
    };
    const degraded = (extra = {}) => send(request, { metas: [], cacheMaxAge: DEGRADED_MAX_AGE }, { status: person ? 503 : 200, maxAge: DEGRADED_MAX_AGE, extra: { ...info(null), ...extra } });
    const answer = (got, out, extra = {}) => send(request, { metas: out.entries.map((e) => toMeta(e, { ...out.context, defaultVideo: isPrivate, menus: got.index })), cacheMaxAge: CATALOG_MAX_AGE }, { maxAge: CATALOG_MAX_AGE, extra: { ...info(got), ...extra, "X-Total": String(out.total), "X-Page-Size": String(PAGE) } });
    /** The old address's catalog answer: a Board row or a Discover catalog of the index. */
    const legacyCatalog = async (req, extra = {}, relabel = null) => {
      const got = await indexFor(req);
      if (!got) return degraded(extra);
      const out = page(got.index, req.id, req.extras);
      if (!out) return send(request, { err: "unknown catalog" }, { status: 404, extra: { ...info(got), ...extra } });
      return answer(got, relabel && relabel.size ? { ...out, context: { ...out.context, relabel } } : out, extra); // relabel: the Search of a profile says the profile's name for a mood of the profile, like the rows it builds (src/profiles.js relabelOf)
    };

    /**
     * The same catalog from the v2 family, or null when this request is not the v2 family's (no v2 files, or an id it does not serve: Lists, Lists (unseen), Friends, Loved by directors,
     * and the ids of the old Board that the new one dropped, such as "because", which an install of before 3.3.0 may still ask for). A file that is missing is replaced by the whole v2 index.
     */
    const v2Catalog = async (req, extra = {}) => {
      if (req.id === "explore" || req.id === "search") {
        const got = await get(urls.v2, ctx);
        return got ? answer(got, page(got.index, req.id, req.extras), extra) : null;
      }
      if (LEGACY_ONLY.has(req.id)) return null;
      const menus = await v2menus();
      if (!menus) return null;
      const ix = menus.index;
      const grouped = ((ix.discover && ix.discover.catalogs) || []).find((c) => c.id === req.id);
      if (grouped) {
        // A catalog of the Discover grouped by subject (3.4.0). No `genre` at all: the first option (NuvioTV); a value that fits nothing: the empty page.
        const opt = discoverOption(grouped, req.extras.genre, ix.lists || []);
        if (!opt) return answer(menus, page(ix, req.id, req.extras), extra); // (the menus have no films: the page is empty whichever way select() reads it)
        if (opt.list) { // a list: its own piece, answered as Lists (unseen) did, or as Lists did when "Include seen" is asked: the curator's order, no recommendation rule, the menu of 12 countries
          const list = (ix.lists || []).find((l) => l.id === opt.list);
          const got = list && (await piece(urls.list(list.id)));
          return got ? answer(got, page(got.index, includeSeen(req.extras, ix) ? "lists" : "lists-unseen", { ...req.extras, genre: list.label }), extra) : degraded(extra);
        }
        // Complete current-format options answer every viewer, filter and page. A partial option keeps the old
        // prefix shortcut for Marco alone, without filters. Fresh full data still wins; the store bounds the piece's wait.
        if (!person && !(st.fresh && st.fresh(urls.v2))) {
          const part = await get(urls.opt(grouped.id, opt.id), ctx);
          const viewer = friend && part && friendOf(part.index, friend.slug);
          // Failure of the optimisation is a full-index fallback; only the full path's existing guard may return 503.
          if (part && (!friend || (part.index.masks && viewer))) {
            const out = completeOptionPage(part.index, grouped.id, opt.id, req.extras, viewer ? { seen: viewer.seen } : undefined)
              || (!friend && optionPage(part.index, grouped.id, opt.id, req.extras));
            if (out) return answer(part, out, extra);
          }
        }
        const got = await get(urls.v2, ctx);
        return got ? answer(got, page(got.index, req.id, req.extras), extra) : degraded(extra);
      }
      // A friend's Watchlist row is the friend's own piece, and nothing stands in for it: the whole v2 index, which a missing slice falls back to, holds MARCO's watchlist (friends.js).
      const rowSlice = async (id) => {
        if (!friend || id !== WATCHLIST_ROW) return slice(urls.row(id));
        const got = await get(urls.row(pieceId(friend.slug)), ctx);
        return got && got.index.meta && got.index.meta.part === `v2-row:${pieceId(friend.slug)}` ? got : null;
      };
      if (req.id === "moods") {
        const options = ix.moodMenu;
        const label = matchOption(req.extras.genre, options.map((o) => o.label));
        const opt = options.find((o) => o.label === label);
        if (!opt) return answer(menus, page(ix, "moods", {}), extra); // no such option: the empty page the legacy Moods gives
        const mood = (ix.moods || []).find((m) => m.id === opt.id);
        if (mood) {
          const got = await slice(urls.mood(mood.id));
          return got ? answer(got, page(got.index, "moods", { ...req.extras, genre: mood.label }), extra) : degraded(extra); // the mood's own label: the slice carries the moods' list
        }
        // an option that is a Board row ("Friends this week"): its row slice, served as the Board serves it (the build's order and reasons), with the four menus on top
        const got = (ix.board || []).some((r) => r.id === opt.id) ? await rowSlice(opt.id) : null;
        return got ? answer(got, page(got.index, opt.id, req.extras, { rowMenus: true }), extra) : degraded(extra);
      }
      if (!(ix.board || []).some((r) => r.id === req.id && r.place === "board" && !r.series)) return null; // not a row of the new Board: the legacy file answers (or says it is unknown)
      const got = await rowSlice(req.id);
      if (!got) return degraded(extra);
      const out = page(got.index, req.id, req.extras);
      return out ? answer(got, out, extra) : send(request, { err: "unknown catalog" }, { status: 404, extra: { ...info(got), ...extra } });
    };
    /** The catalog of the old address, and of the Marco profile's old catalogs: the v2 family where it has the id, else the legacy files. */
    const mainCatalog = async (req, extra = {}) => (await v2Catalog(req, extra)) || (friend && req.id === WATCHLIST_ROW ? send(request, { err: "unknown catalog" }, { status: 404, extra }) : legacyCatalog(req, extra)); // (the legacy Board's `watchlist` is Marco's, never a friend's)

    if (url.pathname === "/p" || url.pathname.startsWith("/p/")) return profileRequest(url.pathname.slice(2) || "/");

    const req = parseCatalogPath(url.pathname);
    if (req) {
      if (req.type === "series" && req.id === SERIES_CATALOG_ID) return mySeries(req);
      if (req.type !== "movie") return send(request, { metas: [], cacheMaxAge: CATALOG_MAX_AGE }, { maxAge: CATALOG_MAX_AGE });
      if (!friend) return mainCatalog(req);
      try { return await mainCatalog(req); } catch (e) {
        if (!(e instanceof NoMasks)) throw e;
        return send(request, { err: "the friends' view needs the next build of the index" }, { status: 503, extra: { ...info(incompatible), "Cache-Control": "no-store" } });
      }
    }

    return send(request, { err: "not found" }, { status: 404 });

    // ── profiles (profiles.js) ──────────────────────────────────────────────────
    /** `rest` is the path after /p: "/night/manifest.json". An unknown profile is a 404, never the Marco profile. */
    async function profileRequest(rest) {
      const parts = rest.split("/");
      const profile = profileOf(decode(parts[1] || ""));
      if (!profile) return send(request, { err: "unknown profile" }, { status: 404 });
      const tag = { "X-Profile": profile.key };
      const path = "/" + parts.slice(2).join("/");
      const opts = { person, exploreOnBoard: String(env.EXPLORE_ON_BOARD ?? "false") === "true" };

      if (path === "/") {
        const title = person ? `Mood Engine · ${person.name} · ${profile.name}` : `Mood Engine · ${profile.name}`;
        const host = esc(url.host), link = `stremio://${host}${base}/p/${profile.key}/manifest.json`;
        return send(request, `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font:16px system-ui;max-width:34em;margin:3em auto;padding:0 1em"><h1>${esc(title)}</h1><p>Install in Stremio: <a href="${link}">${link}</a></p><p>Or paste <code>https://${host}${base}/p/${profile.key}/manifest.json</code> in Stremio, Nuvio or Fusion → Addons → Add addon.</p>`, { type: "text/html; charset=utf-8", maxAge: 300, extra: tag });
      }
      // Marco mirrors the old address (the v2 menus, when there are some); the five others read the legacy Board part alone, as they did before 3.3.0
      const home = () => (profile.rows ? small() : top());
      if (path === "/manifest.json") {
        const got = await home();
        if (!got) return send(request, { err: "the index is not available yet; try again in a minute" }, { status: 503, extra: { ...info(null), ...tag } });
        return send(request, buildProfileManifest(got.index, profile, opts), { maxAge: CATALOG_MAX_AGE, extra: { ...info(got), ...tag } });
      }
      const sreq = parseSubtitlesPath(path, parseExtras, decode);
      if (sreq) return subtitlesFor(sreq);

      const req = parseCatalogPath(path);
      if (!req) return send(request, { err: "not found" }, { status: 404, extra: tag });
      const board = await home();
      if (!board) return degraded(tag);
      // only what this profile's manifest declares: another profile's row, or the old address's catalogs under a mood profile, is a 404
      const declared = buildProfileManifest(board.index, profile, opts).catalogs.find((c) => c.type === req.type && c.id === req.id) || (!profile.rows && req.type === "movie" && RETIRED_CATALOGS.has(req.id)); // the Marco profile keeps answering the three catalogs 3.4.0 and 3.5.0 take out of the manifest (RETIRED_CATALOGS): a Nuvio that still holds the old one gets films, not a 404, until the app is reopened
      if (!declared) return send(request, { err: "unknown catalog" }, { status: 404, extra: { ...info(board), ...tag } });
      if (req.type === "series") return mySeries(req, tag);

      const skip = skipOf(req.extras);
      const relabel = relabelOf(profile, board.index); // the profile's name for each of its moods, by the name the build wrote: every row of the profile says the profile's name (worker/src/meta.js compose)
      const cut = (sel) => ({ entries: sel.entries.slice(skip, skip + PAGE), total: sel.entries.length, context: { ...sel.context, separator: board.index.meta.separator || "\n\n", relabel } });
      // What profileRow needs to build a row. NOT called `ctx`: until 14/11/2026 it was, which hid the Worker's execution context (the `ctx` of handle) from everything below this line, and filmsOfLists
      // handed this object to the store, so the background refresh of the whole index was given to no waitUntil (test/profiles.test.js, "a profile theme of more than 8 lists…").
      const rowCtx = { profile, meta: board.index.meta, day: dayOf(now()) };
      /** The films of some lists: their pieces, together (a missing piece is replaced by the whole index, read once; a film in two pieces is there twice, and profileRow keeps it once). */
      const filmsOfLists = async (ids) => {
        if (ids.length > MAX_PIECES) { // 21st century has 15 lists: one fetch of the whole index instead of 15 (each piece is a fetch plus two Cache API calls; the free plan allows 50 subrequests)
          const whole = await get(urls.full, ctx); // (`ctx` is the execution context of handle)
          return whole && { got: whole, films: whole.index.films };
        }
        const gots = await Promise.all(ids.map((id) => piece(urls.list(id))));
        if (gots.some((g) => !g)) return null;
        const indexes = [...new Set(gots.map((g) => g.index))];
        return { got: gots[0], films: indexes.length === 1 ? indexes[0].films : indexes.flatMap((ix) => ix.films) }; // a film in two lists is in both pieces: profileRow keeps it once
      };
      const menusKeep = () => {
        const f = compileFilters(req.extras, board.index.meta);
        return (list) => (f.none ? [] : f.active ? list.filter(f.test) : list);
      };

      const vouch = VOUCH.find((v) => v.id === req.id);
      if (vouch) {
        const lists = listsOfGroup(board.index, vouch.group);
        // no genre at all: NuvioTV's Discover opens on "Default" and asks with none; it gets the menu's first option, not an empty page
        const name = req.extras.genre === undefined ? lists[0]?.name : matchOption(req.extras.genre, lists.map((l) => l.name));
        const list = lists.find((l) => l.name === name);
        if (!list) return answer(board, cut({ entries: [], context: {} }), tag);
        const got = await filmsOfLists([list.id]);
        if (!got) return degraded(tag);
        return answer(got.got, cut(profileRow({ kind: "lists", lists: [list.id], label: list.name }, got.films, { ...rowCtx, keep: menusKeep() })), tag);
      }
      if (req.id === WHAT.id) {
        const theme = req.extras.genre === undefined ? themesOf(board.index)[0] : matchOption(req.extras.genre, themesOf(board.index)); // no genre: the first theme (NuvioTV, above)
        if (!theme) return answer(board, cut({ entries: [], context: {} }), tag);
        const got = await filmsOfLists(listsOfTheme(board.index, theme));
        if (!got) return degraded(tag);
        return answer(got.got, cut(profileRow({ kind: "theme", name: theme, lists: listsOfTheme(board.index, theme) }, got.films, { ...rowCtx, keep: menusKeep() })), tag);
      }

      const row = profile.rows && profile.rows.find((r) => r.id === req.id);
      if (!row) return profile.rows ? legacyCatalog(req, tag, relabel) : mainCatalog(req, tag); // the Marco profile's old catalogs: as they answer at the old address; every other profile's Search: from the legacy files, as before 3.3.0
      if (row.kind === "board" || row.kind === "mood") {
        const boardId = row.kind === "mood" ? row.mood : row.id;
        const out = page(board.index, boardId, { skip: req.extras.skip });
        // the row says the profile's name for it ("Warm and funny"), not the Board's ("☀️ Lift me out"): the Board's own text starts with the Board's name, which gives way
        if (out) out.context = { ...out.context, name: row.name, boardName: ((board.index.board || []).find((r) => r.id === boardId) || {}).name, relabel };
        return out ? answer(board, out, tag) : degraded(tag);
      }
      if (row.kind === "theme" || row.kind === "lists") {
        const ids = row.kind === "theme" ? listsOfTheme(board.index, row.theme) : row.lists.filter((id) => (board.index.lists || []).some((l) => l.id === id));
        const got = await filmsOfLists(ids);
        if (!got) return degraded(tag);
        return answer(got.got, cut(profileRow({ ...row, lists: ids }, got.films, rowCtx)), tag);
      }
      const got = await piece(urls.moods); // tonight, watchlist, short: every film that fits a mood is in the moods piece
      if (!got) return degraded(tag);
      return answer(got, cut(profileRow(row, got.index.films, rowCtx)), tag);
    }
  };
}

