// The small index of fixture.js with two friends who have seen and want different films (Marco, 29/10/2026, the friends' view: worker/src/friends.js).
//
// People: Gustavo (place 0), William (place 1). What each did, by film (Marco's own flags are the fixture's: `seen` on tt0000019, tt0000020, tt0000025):
//   tt0000001 The Killing          Gustavo saw it; William wants it                       (Marco: neither seen nor wanted)
//   tt0000002 Paths of Glory       William saw it
//   tt0000005 Pierrot le Fou       William saw it
//   tt0000009 Amélie               Gustavo saw it                                         (it is on Marco's Watchlist)
//   tt0000011 Reservoir Dogs       both want it
//   tt0000012 Nights of Cabiria    William wants it
//   tt0000013 8½                   Gustavo wants it
//   tt0000018 Wild at Heart       William has it on the watchlist AND saw it             (a watchlist is not cleaned of what was seen later: the piece leaves it out)
//   tt0000019 Palme Winner You Saw Marco saw it; both friends saw it
//   tt0000020 Old Friend You Saw   Marco saw it; Gustavo saw it; William wants it          (the film Marco has seen that William has not)
//   tt0000029 Just Below The Floor Gustavo wants it; Letterboxd 3.49, so it is not `eligible`: the piece leaves it out, as the Board's own watchlist row leaves it out
// Marco's own Watchlist row (index-v2-row-watchlist.json): Amélie, Pulp Fiction. The Discover catalog "places" has one calculated option, "Picks", with six ids in this order.
// Everything goes through the build's own encoder and cutter (lib/index-rows.js, lib/index-export.js pieces and pieces2), as fixture.js does, so the friends' pieces are the ones the build writes.

import { createRequire } from "node:module";
import { makeObject, makeV2Object, textOf, v2FilesOf } from "./fixture.js";

const require = createRequire(import.meta.url);
const exporter = require("../../lib/index-export.js");

export const DIR = "https://pages.test/mood-engine/data/";
export const ENV = { INDEX_URL: `${DIR}index.json` };
export const NOW = Date.UTC(2026, 9, 29, 12); // the clock of every answer that rotates (My series by week, Tonight by day): the golden must not move with the calendar

export const FRIENDS = {
  tt0000001: { seenBy: [["Gustavo", 4.5]], wantBy: ["William"], friendsAvg: 4.5 },
  tt0000002: { seenBy: [["William", null]], wantBy: [] },
  tt0000005: { seenBy: [["William", 3.5]], wantBy: [], friendsAvg: 3.5 },
  tt0000009: { seenBy: [["Gustavo", 3.5]], wantBy: [], friendsAvg: 3.5 },
  tt0000011: { seenBy: [], wantBy: ["Gustavo", "William"] },
  tt0000012: { seenBy: [], wantBy: ["William"] },
  tt0000013: { seenBy: [], wantBy: ["Gustavo"] },
  tt0000018: { seenBy: [["William", null]], wantBy: ["William"] },
  tt0000019: { seenBy: [["Gustavo", 4], ["William", 4]], wantBy: [] },
  tt0000020: { seenBy: [["Gustavo", 5]], wantBy: ["William"] },
  tt0000029: { seenBy: [], wantBy: ["Gustavo"] },
};
/** The Picks option: [a film Marco saw and both friends saw, a film William saw, Amélie, Breathless, a film Marco saw and only Gustavo saw, a short film]. */
export const PICKS = ["tt0000019", "tt0000005", "tt0000009", "tt0000004", "tt0000020", "tt0000014"];
export const MARCO_WATCHLIST = ["tt0000009", "tt0000010"];
const DISCOVER = {
  order: ["moods", "places", "friends", "explore", "search"],
  retire: ["lists", "lists-unseen", "director-picks"],
  seen: { name: "seen", option: "Include seen" },
  catalogs: [{ id: "places", name: "Mood Engine · Countries & regions", options: [{ id: "p-picks", label: "Picks", ids: PICKS }] }],
};

const withFriends = (o) => ({ ...o, films: o.films.map((f) => (FRIENDS[f.tt] ? { ...f, friends: FRIENDS[f.tt] } : f)) });

/** The legacy index and the v2 index (with a Watchlist row of Marco's, a Discover catalog), in object form. */
export function objects() {
  const legacy = withFriends(makeObject());
  const v2 = withFriends(makeV2Object());
  // the legacy Board also has a `watchlist` row of Marco's (the real one does): the friends' routes must not fall back to it
  legacy.board = [...legacy.board, { id: "watchlist", name: "📋 Your watchlist, best first" }];
  legacy.rows = { ...legacy.rows, watchlist: MARCO_WATCHLIST };
  legacy.rowDesc = { ...legacy.rowDesc, watchlist: MARCO_WATCHLIST.map(() => "Marco's own legacy text.") };
  const byTt = new Map(v2.films.map((f) => [f.tt, f]));
  v2.board.splice(1, 0, { id: "watchlist", name: "📋 Your watchlist, newest first", place: "board" });
  v2.rows.watchlist = MARCO_WATCHLIST;
  v2.rowDesc.watchlist = MARCO_WATCHLIST.map((tt) => `${byTt.get(tt).name} cast\nMarco's own text.`);
  v2.discover = DISCOVER;
  return { legacy, v2 };
}

/** Every file the build would publish for these objects, by file name: the legacy family, the v2 family (the friends' watchlist pieces and the Discover's option pieces included). */
export function filesOf({ legacy, v2 } = objects()) {
  const files = { "index.json": textOf(legacy), ...v2FilesOf(v2) };
  for (const p of exporter.pieces(legacy)) files[p.rel.split("/").pop()] = textOf(p.obj);
  for (const p of exporter.optionPieces ? exporter.optionPieces(v2) : []) files[p.rel.split("/").pop()] = textOf(p.obj); // the option pieces of the Discover (PR #94; the code of 415bd4e has none)
  return files;
}

/** A file in the layout of before the masks (the 27 columns): what an index published before 29/10/2026 looks like. */
export function withoutMasks(text) {
  const j = JSON.parse(text);
  j.cols = j.cols.slice(0, -2);
  j.films = j.films.map((r) => r.slice(0, j.cols.length));
  return JSON.stringify(j);
}

/** A handler on those files; `files` may be edited. r.calls are the file names asked for. */
export function rigOf(files, createHandler, createStore, { env = ENV, handler = {} } = {}) {
  const r = { calls: [] };
  const fetchImpl = async (url) => {
    const name = url.slice(DIR.length);
    r.calls.push(name);
    return files[name] ? new Response(files[name]) : new Response("not found", { status: 404 });
  };
  const handle = createHandler({ store: createStore({ fetchImpl, caches: undefined, log: () => {} }), now: () => NOW, ...handler });
  r.get = async (path, init = {}, e = env) => {
    const res = await handle(new Request("https://mood-engine.example.workers.dev" + path, init), e, undefined);
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null };
  };
  return r;
}

/** The 24 public routes of the parity test: the old address, the profiles, the private-token-free catalogs. A route is [name, path]. */
export const PUBLIC_ROUTES = [
  ["manifest", "/manifest.json"], ["home page", "/"],
  ["tonight", "/catalog/movie/tonight.json"], ["oldfriends", "/catalog/movie/oldfriends.json"], ["europe", "/catalog/movie/europe.json"],
  ["watchlist", "/catalog/movie/watchlist.json"], ["explore 1990s", "/catalog/movie/explore/decade=1990s.json"],
  ["mood Noir", "/catalog/movie/moods/genre=Noir.json"], ["mood Uplift", "/catalog/movie/moods/genre=Uplift.json"], ["moods: Friends this week", "/catalog/movie/moods/genre=Friends%20this%20week.json"],
  ["explore 1950s", "/catalog/movie/explore/decade=1950s.json"], ["explore Sweden", "/catalog/movie/explore/country=Sweden.json"], ["explore skip", "/catalog/movie/explore/skip=5.json"],
  ["search kubrick", "/catalog/movie/search/search=kubrick.json"], ["search paths", "/catalog/movie/search/search=paths.json"], ["search friend loved", "/catalog/movie/search/search=gustavo%20loved.json"],
  ["places Picks", "/catalog/movie/places/genre=Picks.json"], ["places Picks, include seen", "/catalog/movie/places/genre=Picks&seen=Include%20seen.json"], ["places Picks 1990s", "/catalog/movie/places/genre=Picks&decade=1990s.json"],
  ["friends Top", "/catalog/movie/friends/genre=Top%20%C2%B7%20Gustavo.json"],
  ["my-series", "/catalog/series/my-series.json"],
  ["profile marco manifest", "/p/marco/manifest.json"], ["profile night tonight", "/p/night/catalog/movie/tonight.json"], ["profile marco watchlist", "/p/marco/catalog/movie/watchlist.json"],
];
