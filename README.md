# Mood Engine

A personal film recommender for [Stremio](https://www.stremio.com/), rebuilt every night from my own [Letterboxd](https://letterboxd.com/) history.

I wanted one place that answers "what do I watch tonight?" the way a friend who knows my taste would. Mood Engine reads my ratings, learns what I love, finds films I haven't seen and sorts them into moods. Anything I log on Letterboxd disappears from my picks the next morning.

## What it does

- **Learns taste from ratings:** directors, actors, themes, countries and decades I rate highly.
- **Finds unseen films:** my watchlist, around 90 curated lists, festival winners, friends' watchlists and top picks, and recommendations drawn from everything I rated 4.5 stars or more.
- **Sorts them into moods and rows:** "Lift me out", "Under 95 minutes", "Loved by your directors", "Friends loved, you haven't seen" and others, plus a "Tonight" pick that doesn't repeat for 30 days.
- **Never shows a film I've already seen:** if one slips into a row, the build refuses to publish.
- **Friends' views:** a friend gets my catalogue filtered by their own public Letterboxd data, at their own address.
- **Fast:** everything is static files, so Stremio opens a row in a fraction of a second.

About 12,800 films are indexed.

## How it works

```
Letterboxd export ─┐
TMDB / lists ──────┼─> build.js (nightly) ─> static index (GitHub Pages) ─> Cloudflare Worker ─> Stremio
Friends' public data┘         │
                         verify.js: no seen film, no broken row, or no publish
```

- `build.js` and `lib/`: the nightly build (taste model, candidate pools, moods, rows).
- `verify.js` and `scripts/verify-*`: gates that block a bad publish.
- `worker/`: the Cloudflare Worker that serves the Stremio add-on (manifest, catalogs, film pages).
- `web/`: the mood-picker page.
- `test/`, `worker/test/`: about 1,200 tests run in GitHub Actions on every push (`node scripts/public-tests.mjs`). Another 89 test files need my private data, are listed in `PRIVATE-DATA-TESTS.txt` and run on my machine.

## How I built it

I'm not a software engineer by trade. I run operations and partnerships at a São Paulo events company, and I build my tools with AI coding agents.

- **Agents:** Claude Code and OpenAI Codex, several running in parallel in [Conductor](https://conductor.build/), each in its own branch.
- **Method:** I write the product rules and acceptance criteria, the agents write the code, and separate review and security agents check it before it merges. Every rule in the code points back to a dated decision.
- **Pace:** about 800 commits between October and November 2026.

## Run your own

You need Node 22, a [TMDB API token](https://developer.themoviedb.org/) and your own Letterboxd data export.

1. Put your Letterboxd export CSVs in `data/letterboxd/` (see `import-letterboxd.js`).
2. Set your Letterboxd username and friends in `config.json` (`people.example.json` shows the shape).
3. `TMDB_TOKEN=... node build.js` builds the index; `node verify.js docs` checks it.
4. Deploy the Worker from `worker/` with Wrangler (see `worker/README.md`).

Personal data, caches and my friends' data are not in this repository. The build creates the caches on first run.

## Data and credits

This product uses the TMDB API but is not endorsed or certified by TMDB. Film data from TMDB; ratings and lists from Letterboxd. Not affiliated with Stremio or Letterboxd.

## License

MIT. See `LICENSE`. Film data and posters belong to their sources and are not covered by this license.
