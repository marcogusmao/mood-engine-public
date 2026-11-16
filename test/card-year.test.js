// The year of a film in the friends' rows and in the week row (22/10/2026 night, the gate of the merge of discover-catalogs with origin/main fcc0b24).
// Defect: lib/pool.js weekRow and lib/rows.js item() wrote the TMDB record's year FIRST (`d.year || r.year`), while the index and the cover write Letterboxd's first (lib/pool.js yearOf, Marco 13/10/2026:
// "ONE year in every surface"; Letterboxd gave the IMDb year for 97.8% of the films where the two differ). build.js overrides the year of a card with the index's WHEN the film is in the index
// and keeps the row's own when it is not. So the same film (The Night House, tt9731534: Letterboxd 2020, TMDB 2021) showed 2020 in the build where the index had it and 2021 in the build where a
// private "Not for me" took it out of the index (the friends' collections are exempt from the feedback, so the web row still lists it): test/review-fixes.test.js "full build VM preserves ..." went red
// the day the nightly cache gained TMDB's record of that film (origin/main fcc0b24; 4d27d2d without that cache was green).
// Mutations that must turn this red: weekRow back to `(d && d.year) || c.rec.year`; rows.js item() back to `d?.year || r.year`.
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../lib/pool");
const F = require("../lib/friends");
const { buildFriendRows } = require("../lib/rows");

const record = (year) => ({ id: 547565, imdb: "tt0000001", title: "The Film", year, runtime: 108, genres: ["Horror"], directors: [], countries: ["US"], poster: null, overview: "" });

test("week row: Letterboxd's year first, TMDB's only when Letterboxd has none (the index and the cover read the same way)", () => {
  const mk = (lbYear) => ({ week: new Map([["film", [{ name: "Ana", rating: 4, watched: "2026-10-20" }]]]), view: { films: { film: { title: "The Film", year: lbYear, tmdbId: 547565, imdbId: "tt0000001", t: 1 } } }, isSeen: () => false, detail: () => record(2021), size: 6 });
  assert.equal(P.weekRow(mk(2020)).items[0].year, 2020, "Letterboxd says 2020, TMDB 2021");
  assert.equal(P.weekRow(mk(null)).items[0].year, 2021, "no Letterboxd year: TMDB's, as the reserve");
});

const CFG = {
  letterboxd: "me", friends: [{ user: "ana", name: "Ana" }, { user: "bia", name: "Bia" }], friendLists: [],
  friendRows: { love: { minFriends: 2, minStars: 4, soloStars: 4.5 }, top: { minStars: 4.5 }, session: { minShared: 1 }, list: {} }, sizes: { friendsDiscover: 60 },
};
function view(year) {
  const cache = F.loadCache("/nonexistent");
  cache.users.ana = { films: [["film", "The Film", year, 5]], watchlist: [] };
  cache.users.bia = { films: [["film", "The Film", year, 4.5]], watchlist: [] };
  cache.films = { film: { title: "The Film", year, tmdbId: 547565, imdbId: "tt0000001", t: 1 } };
  cache.me = { slugs: [] };
  return F.viewFriends(cache, CFG);
}

test("friends' rows: the card's year is Letterboxd's, TMDB's only as the reserve", () => {
  const out = (lb) => buildFriendRows({ view: view(lb), cfg: CFG, isSeen: () => false, onMyWatchlist: () => true, keepEmpty: true, detail: () => record(2021) });
  const years = (o) => Object.values(o.rows).flat().map((i) => i.year);
  assert.ok(years(out(2020)).length > 0 && years(out(2020)).every((y) => y === 2020), `Letterboxd 2020 against TMDB 2021: ${years(out(2020))}`);
  assert.ok(years(out(null)).every((y) => y === 2021), "no Letterboxd year: TMDB's");
});
