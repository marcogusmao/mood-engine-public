// The small index of the profile tests (test/profiles.test.js, test/profile-parity.test.js): the nine moods, six real lists, the films that make each profile row interesting.
// Moved out of profiles.test.js on 14/10/2026 so the parity test reads the very same files; nothing in it changed.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const rows = require("../../lib/index-rows.js");
const exporter = require("../../lib/index-export.js");

// ── a small index with the nine moods and six real lists ─────────────────────

export const MOODS = [
  ["lift", "Uplift", "☀️ Lift me out"], ["escape", "Escape", "🎳 Full escape"], ["reinvent", "Reinvention", "🧭 Starting over"], ["letin", "Catharsis", "🌧️ Let it in"],
  ["night", "Nocturnal", "🌃 Night drive"], ["wicked", "Wicked", "🎃 Something wicked"], ["wander", "Wanderlust", "🌍 Somewhere else"], ["slow", "Slow", "🕯️ Slow and still"], ["music", "Music", "🎵 Turn it up"],
].map(([id, label, name]) => ({ id, label, name }));
// Horror (poxvK), Horror + Halloween (dCcac), Noir & night (jMnm, Letterboxd & community), the two Criterion Closet lists (no theme), All-time canon (eEESu, Critics)
export const LISTS = ["poxvK", "dCcac", "jMnm", "tp03m", "snFyM", "eEESu"].map((id) => ({ id, label: `Old label of ${id}`, popular: false, films: 3 }));

let n = 0;
const film = (name, x = {}) => ({ tt: `tt${String(++n).padStart(7, "0")}`, name, year: x.year ?? 1990, runtime: x.runtime ?? 100, lbRating: x.lbRating ?? 4.0, rank: x.rank ?? 1, taste: x.taste ?? 0, quality: x.quality ?? 0, ...x });
const NIGHT = Array.from({ length: 14 }, (_, i) => film(`Night ${i + 1}`, { rank: 3 - i * 0.1, moods: { night: [1, 20 - i] }, director: `Night Director ${i}` }));
const WICKED = Array.from({ length: 4 }, (_, i) => film(`Wicked ${i + 1}`, { rank: 2 - i * 0.1, moods: { wicked: [1, 15 - i] } }));
const LIFT = Array.from({ length: 8 }, (_, i) => film(`Lift ${i + 1}`, { rank: 5 - i * 0.1, runtime: 85, watchlist: true, taste: 3, quality: 3, moods: { lift: [1, 30 - i] } })); // the best of everything, and never in Night and horror
const SPECIAL = [
  film("Seen Night Top", { seen: true, rank: 9, watchlist: true, runtime: 80, moods: { night: [2, 99] }, lists: { poxvK: 1, tp03m: 1 } }), // seen: never served by a profile
  film("Below Floor Night", { lbRating: 3.2, rank: 8, watchlist: true, runtime: 80, moods: { night: [2, 98] }, lists: { poxvK: 2, tp03m: 2 } }), // not eligible: out of the pool rows, in the curators' rows
  film("Night Watchlist Short", { rank: 0.5, runtime: 90, watchlist: true, taste: 1, quality: 1, moods: { night: [1, 1] } }),
  film("Wicked Watchlist Long", { rank: 0.4, runtime: 130, watchlist: true, taste: 2, quality: 0, moods: { wicked: [1, 1] } }),
  film("Night and Lift", { rank: 0.3, runtime: 70, watchlist: true, moods: { night: [1, 0.5], lift: [1, 40] } }),
  film("Too Short", { rank: 0.2, runtime: 30, moods: { night: [1, 0.2] } }), // a short film is not a feature: not in Under 100 min
  film("Horror Both Lists", { rank: 1.5, lists: { poxvK: 3, dCcac: 1, snFyM: 4 } }), // in two Horror lists: once in the row
  film("Halloween Only", { rank: 1.4, year: 1978, lists: { dCcac: 2 } }),
  film("Noir Film", { rank: 1.3, year: 1946, lists: { jMnm: 1 } }),
  film("Closet Most Picked", { rank: 0.1, lists: { tp03m: 3, snFyM: 2 } }),
  film("Closet All Only", { rank: 0.05, lists: { snFyM: 1 } }),
  film("Canon Film", { rank: 1.2, lbRating: 4.13, lists: { eEESu: 1 } }), // 4.13: in "4.0–4.2", and the ★ of a rating band has two decimals
  film("Night 100 Minutes", { rank: 0.15, runtime: 100, moods: { night: [1, 0.15] } }), // Under 100 min ends at 100 (Marco, 11/10/2026): in
  film("Night 101 Minutes", { rank: 0.14, runtime: 101, moods: { night: [1, 0.14] } }), // and out
  film("In A Lookalike List", { rank: 7, lists: { XpoxvK: 1 } }), // a list id that ends like a Horror list's: not in Horror
];
export const FILMS = [...NIGHT, ...WICKED, ...LIFT, ...SPECIAL].map((f) => {
  const e = { ...f, decade: `${Math.floor(f.year / 10) * 10}s`, desc: `${f.name} cast\n${f.name} genres.\n\nSynopsis of ${f.name}.`, find: ` ${f.name.toLowerCase()}` };
  if (e.lbRating >= 3.5) e.eligible = true;
  return e;
}).sort((a, b) => b.rank - a.rank || a.tt.localeCompare(b.tt));
export const tt = (name) => FILMS.find((f) => f.name === name).tt;
export const fitsAny = (moods) => (id) => { const f = FILMS.find((x) => x.tt === id); return !!f.moods && moods.some((m) => f.moods[m]); };

export function makeObject() {
  const boardRows = { tonight: [tt("Lift 1"), tt("Night 1")], watchlist: [tt("Lift 1"), tt("Night Watchlist Short")], short: [tt("Lift 2")], directors: [tt("Canon Film")], "directors-loved": [tt("Noir Film")] };
  for (const m of MOODS) boardRows[m.id] = FILMS.filter((f) => f.moods && f.moods[m.id] && !f.seen).map((f) => f.tt);
  boardRows["a-later-row"] = [tt("Canon Film")]; // a Board row the profiles do not know yet, with an emoji: the Marco profile drops the emoji
  const board = ["tonight", "watchlist", "short", ...MOODS.map((m) => m.id), "directors", "directors-loved", "a-later-row"].map((id) => ({ id, name: MOODS.find((m) => m.id === id)?.name || (id === "a-later-row" ? "🧪 A later row" : `Old ${id}`) }));
  return {
    meta: { builtAt: "2026-10-11T22:00:00.000Z", version: "2.4.0", schema: 1, part: "full", separator: "\n\n", today: "2026-10-11", count: FILMS.length, loveStars: 4, minFeatureMinutes: 40, shortMaxMinutes: 95, decades: ["1940s", "1970s", "1990s"], countries: [] },
    moods: MOODS, lists: LISTS, friends: { people: [], options: [] }, directors: { options: [] },
    board, rows: boardRows, rowDesc: Object.fromEntries(MOODS.map((m) => [m.id, boardRows[m.id].map((id) => `${FILMS.find((f) => f.tt === id).name} cast\nMood: ${m.name} · genres of the row.`)])),
    rules: { rule: "letterboxd-average-or-configured-friend-or-vouched", minStars: 3.5, exemptCatalogs: ["lists", "lists-unseen", "friends"] },
    films: FILMS,
  };
}
export function files(change) { // `change(object)`, when given, edits the index object before it is written (card-links.test.js: a synopsis that starts "MUBI:", 28/10/2026)
  const o = makeObject();
  if (change) change(o);
  const out = { "index.json": JSON.stringify(rows.encode(o)) };
  for (const p of exporter.pieces(o)) out[p.rel.split("/").pop()] = JSON.stringify(rows.encode(p.obj));
  return out;
}

