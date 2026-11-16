// A fake TMDB for a real build (node --require test-support/fake-tmdb-fetch.js build.js ...), written for test/friends-cards-build.test.js (22/10/2026, frente friends-cards).
// FAKE_TMDB names a JSON file { movies: { "<tmdb id>": "<imdb id>" }, finds: { "<imdb id>": <tmdb id> }, log: "<path>" }:
//   /3/movie/<id>   a record whose IMDb id is movies[id] with a director and three actors; 404 when the id is not in `movies` (TMDB has no movie under that number: a series' id)
//   /3/find/<tt>    movie_results [{ id: finds[tt] }], or no movie result (a series, an episode)
// Every ask is appended to `log` as one line (the path). Any other host throws: a build under this test must reach nobody else.
const fs = require("fs");

const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_TMDB, "utf8"));
const json = (o) => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(o) });
const gone = { status: 404, ok: false, headers: { get: () => null }, text: async () => "{}" };

globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname !== "api.themoviedb.org") throw new Error(`fake-tmdb-fetch: the network is closed (${u.hostname})`);
  const parts = u.pathname.split("/");
  fs.appendFileSync(cfg.log, `${u.pathname}\n`);
  if (parts[2] === "find") {
    const id = cfg.finds[parts[3]];
    return json({ movie_results: id ? [{ id }] : [], tv_results: [{ id: 1 }] });
  }
  if (parts[2] === "movie") {
    const id = Number(parts[3]);
    const imdb = cfg.movies[id];
    if (!imdb) return gone;
    return json({
      id, title: `Fixture ${imdb}`, release_date: "2001-02-03", runtime: 116, external_ids: { imdb_id: imdb },
      credits: { crew: [{ job: "Director", id: 9, name: `Fixture Director ${imdb}` }], cast: [1, 2, 3].map((n) => ({ id: n, name: `Fixture Actor ${n}` })) },
      videos: { results: [] },
    });
  }
  return gone;
};
