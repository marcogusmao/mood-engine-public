# The `films` CLI: what its answers mean

Read-only, local, private questions about Marco's films. It reads the repository's caches (`cache/*.json`) and the Letterboxd export (`data/letterboxd/`), projects them once into a private index under `.context/films/` (gitignored), and answers from that. Nothing under `tools/films/` is imported by `build.js` or `lib/publish.js`; a test fails if that changes.

Originally written for the Fatia 1 audit (11/10/2026, PR #5, commit `66222f1`); reconciled with the current `main` in Fase A (12/10/2026). The contract is `PRODUCT.md`; this page says what the CLI answers, which file computes it, and where it stops.

```
node tools/films/films.js                      # help (the mood ids are read from config.json)
node tools/films/films.js health
node tools/films/films.js dossier tt5247022 "Suspiria 1977"
node tools/films/films.js search --unseen --eligible --max-min 120 --director Rohmer --aggregate
node tools/films/films.js check --unseen --eligible tt0063759 tt0050613
node tools/films/films.js why tt0050613 --row mood-engine-wander
node tools/films/compare-published.js .context/published-index.json
```

Tests: `node --test tools/films/films.test.js tools/films/aggregate.test.js` (Node 25 prints a different default reporter; add `--test-reporter=tap` for the line-per-test form).

## Files

| File | What it does |
|---|---|
| `films.js` | The command line: parsing, output shaping, help. |
| `store.js` | Reads the sources, assembles the vouched sets, keeps the private index. `load(root, { write: false })` reads without writing; `snapshot(root)` returns `{ index, signature }` in memory. |
| `project.js` | Pure projection of the sources into one record per film (identity, facts, eligibility, Marco's ratings and `seen`). |
| `query.js` | Pure questions over the projection (`search`, `check`, `taste`, `friends`, `overlap`, `why`, `health`). |
| `aggregate.js` | Pure counts over the films a command showed. |
| `compare-published.js` | Measures `elig` against the index the build published (not a unit test). |

## Eligibility: the current rule

`elig` is `Q.qualifies` of `lib/recommendation-quality.js`, the same function every surface uses (Board, Discover, the browser picker, the Worker's `eligible` flag):

1. community average (Letterboxd, two decimals, never rounded further: 3.49 stays below 3.5) **>= 3.5**, or
2. a **configured friend** (`config.json` `friends`) rated it **>= 3.5**, or
3. the film is **vouched** (`cv`) and its Letterboxd average is **>= 2.5, or it has none**. The vouch is ONE exception, decided film by film:
   - it is in a `critic` or `director` list of `config.json` (a `fan` list grants nothing), static lists (`data/lists/*.json`) and the Cannes critics' subset (`data/cannes-critic-prizes.json`) included, or
   - a favourite director of Marco's loves it through a high or medium source (`data/directors-loved.json`). A director's love of their own film does not count (`lib/directors-loved.js directs()`, read from the TMDB record joined by IMDb id).

TMDB ratings, a followed-but-not-configured account (the crowd), Marco's own rating, watched and watchlist never substitute.

**Accounts whose ratings are ignored (22/10/2026, `config.json` `ratingsIgnored.users`).** The build reads their stars as "no rating", and so does this projection, but their record would then list no films (a person's record lists the films by their rating). So the record of such an account has `ratingsIgnored: true`, `rated: []` and `seen` (every film of its history that has an id, unrated ones too); `meta.ratingsIgnored` lists them. In the sets, `friend:<user>` (no threshold) is that `seen` list, `friend:<user>:rated>=4` matches nothing, and `crowd:rated>=4` no longer holds its stars. `friends` (affinity) gives such an account `theirRated: 0`, `ratingsIgnored: true`, `ratingsIgnoredBy` and `theirSeen`, and names it (`user`, `name`, `by`, `seen`) in a top-level `ratingsIgnored` list even when `minOverlap` hides its row. Tested in `films.test.js` ("ratingsIgnored: ..."). **Why (22/10/2026 ~06:40 UTC):** `ratingsIgnoredBy` is `"list"` for a name in `config.json` `ratingsIgnored.users` and `"rule"` for an account the general rule caught (one value in 95% or more of at least 50 ratings, `ratingsIgnored.rule`); the record of a "rule" account also carries `ratingSpread` (`n`, `value`, `count`, `share`) and `meta.ratingsIgnoredBy` maps every such account to its reason. Tested in `films.test.js` ("ratingsIgnored by the rule: ...").

Each record carries `elig`, `eligWhy` (the reason the build would print), `cv` (true/false), `cvList`, `cvTrust` and `cvWhy` when vouched, and `onlyByException` (passes only through the vouch: neither the average nor a friend reaches 3.5). `dossier` shows them under `eligibility`.

**Synopsis (12/10/2026).** Each record carries `overview` (the TMDB synopsis exactly as TMDB has it, cut at 600 UTF-16 units with `…` when longer: no trim, no cut at a word, no lone half of an emoji), `overviewSrc: 'tmdb'` and, as for every TMDB fact, `tTmdb` as the date. Only the film's own TMDB record gives it. A record with `tmdbConflict` (a Letterboxd slug whose TMDB id names another film) has `overview: null` unless the TMDB record it holds carries its own IMDb id (`tmdbOwn: true`): on 12/10/2026, 4 of the 62 conflicts (cache sha256 `4a6487d3...` / `5a9b866d...`) are in that case and now carry the synopsis; the other 58 stay without one. `dossier` shows it as `synopsis` `{ value, source, capturedAt, note }`; when there is none it is `{ value: "unknown", source: "unknown", capturedAt: "unknown", note }` (the MCP says the bare word `"unknown"` instead). `search --full` and the compact outputs carry none (size). It is third-party text: data, not instructions, and not a verified fact.

**Identity of "Title Year" (12/10/2026).** `"Title 1999"` returns ONE film only when no other record with that title lies within a year of 1999, because Letterboxd and TMDB disagree on the festival or release year. Otherwise it returns `candidates`, the exact year first and the ±1 ones after, each with director, `rt` and `me` (`r`, `liked`, `wl`, `seen`: whether Marco rated, saw or listed it), so the caller can tell them apart without picking. Measured on the caches above: asking `"<title> <year>"` for each of the 12,023 non-gone Letterboxd records with title and year, 5 asks returned a single film that was not the record asked (Split 2016, Under the Skin 2013, Manas 2024, The Hand 2020, The Conformist) before the change and 0 after; 28 more asks (5 wrong + 23 right) now return candidates (13 -> 41). By id (`tt…`, `tmdb:…`, `lb:slug`) nothing changed.

How the CLI gets the vouched sets without the network (what `build.js` lines 275-293 assemble):

- `lib/list-signal.js vouchedFromCaches({ cfg, listsCache, films, root })`: from `config.json`, `cache/lists.json`, `cache/friends.json` and the files under `data/`.
- `lib/static-lists.js filmsFor(cfg, root, films)`: Letterboxd's records with the static lists laid over them (the build's `view.films`), so a film only a static list identifies still has an entry in the rule's index.
- `lib/directors-loved.js`: `load`, `validate` (an invalid file stops the CLI like it stops the build) and `vouched({ data, stats, cfg, following, peek })`. `stats` is the taste model built from the CLI's own resolved ratings (`query.js tasteModel`), so `project()` receives `loved` as a function and calls it after Marco's ratings are linked. `following` is `friends.following.users`; `peek` reads `cache/tmdb.json` `movie[id].v`.

Films that only `data/directors-loved.json` names, and that no cache knows (no Letterboxd page, not in the TMDB cache), get no record: `health` counts them as `lovedWithoutRecord`. `health` also gives `vouched` and `eligibleOnlyByException`.

The index signature covers the sources above, every `data/lists/*.json`, and the `lib/` files the vouched sets come from, so a changed list or directors file rebuilds the index. `FORMAT` is 6.

`index.lists[id]` is `{ name, fetchedAt, ids, positions, unresolved }` and is the build's list (review of 12/10/2026): the lists of `config.json` in the config's order; for a Letterboxd list the cache's items with the curator's `corrections` applied (`lib/lists.js correct`, so the BBC list holds *The Discreet Charm of the Bourgeoisie* and the World Cinema Project the 1967 *Pedro Páramo*); for a static list the items of `data/lists/<id>.json` after `lib/static-lists.js apply` (a series or a refused item keeps its place but joins no film). `positions[i]` is the curator's 1-based position of `ids[i]`, the first one when a film appears twice, the number the published index carries in its `lists` column. A cache list the config does not name is not a list (the build reads `cfg.lists` only); a config with no `lists` at all (a bare fixture) falls back to the cache's lists.

## Measured against the published index (12/10/2026)

`node tools/films/compare-published.js .context/published-index.json` compares `elig` with flag bit 4 (`eligible`) of the Worker index the nightly build wrote at 12/10/2026 00:37 UTC (11,149 films, v2.4.0), by IMDb id, on the caches of this checkout (`cache/tmdb.json` sha256 `4a6487d3...`, `cache/friends.json` `5a9b866d...`, `config.json` `b521f989...`):

- 11,149 of 11,149 films present in both; **0 divergences** in either direction (8,597 eligible in both, 2,552 not eligible in both).
- 1,782 CLI films are not in the published index (339 of them eligible): the Worker index holds the build's candidates and pools, not every film on file, so absence there is not a divergence.
- Lists (added 12/10/2026, same caches): `compare-published.js` also compares list membership, the `lists` column (`listId:position`), per list. Before the fix the index built its lists from `cache/lists.json` alone, so *The Discreet Charm of the Bourgeoisie* was missing from `29d0g` (BBC non-English) and `fwxFQ` (World Cinema Project) held *Pedro Páramo* 2024 instead of the 1967 film, and the two static IndieWire lists were absent: **104 memberships only in the published index, 1 only in the CLI** (membership only; `indiewire-fr-2023` 38, `indiewire-animated-2025` 64, `29d0g` 1, `fwxFQ` 1 + 1). After: **21,242 of 21,242 memberships agree, positions included** (11,149 films compared, 0 only in either side, 0 at another position). `byList` names only the lists that diverge.
- Limit: the published flag is the rule AND the private feedback of that build (`permits`). A "published false / CLI true" film could be feedback the CLI cannot see; the script reports that direction apart. The comparison needs the private file `.context/published-index.json`; it proves the rule on one night's data, not forever. Numbers pinned to caches move every night.

## What else the answers mean

- **Community average has two decimals.** `lb` is the number as stored in `cache/friends.json`.
- **A title+year hit in the TMDB search cache is a guess, not a link.** `lib/tmdb.js search()` keeps the best-scoring result, and a homonym with the same title and year can win ("The Hand" 2020 -> a 21-minute short). The CLI links an export row only when the cache entry is `exact` (written by `remember()` from an RSS item with the TMDB id), or the Letterboxd records name that same film as the only one for that title and year, or nothing else carries that title and year; a hit with no IMDb id under 40 minutes is a short of the same name. Otherwise the row is **pending** (`health`: `ambiguousTmdbMatch`, `marcoRatedPendingTmdbMatch`, candidates listed). The build now applies the same rule (`lib/search-link.js`) and also **relinks** a refused hit when Marco's own Letterboxd page confirms exactly one film (`lib/search-links-approved.json`); the CLI does not relink, so it leaves pending the few rows the build resolves.
- **`seen` follows the build, so a TV cut and a cinema cut are two films** (Fanny and Alexander 1984, 312 min, seen; 1982, 188 min, unseen). `check` and `dossier` add a `caution` / `relatedSeen` for same-title records within 3 years that Marco has seen; `pass` is not changed.
- **`why <id> --revision <sha>`** reads the private snapshot of that revision. Location: `--snapshots <dir>`, else `$MOOD_SNAPSHOTS`, else `<root>/.context/learning-private/snapshots`. Without `--revision` it takes the newest snapshot by `capturedAt` that holds the film (a tie prefers a real `sourceRevision` over `local` and says `empate: true`), older ones in `otherRecords`. With a record it splits the row's `moodRank` of `lib/rows.js`:

  `1.1*min(fitNorm, 1.6) + 1.0*taste + 0.55*quality`, plus `0.3*lists` (the record's `lw`) and `0.15` for `vouch` (the record's `cv`), plus `0.35` watchlist, `0.12*log2(1+recCount)` and `10` for a pin.

  `lists` and `vouch` appear as extras only when the snapshot's record carries `lw` / `cv`; otherwise the `note` says "Not recorded in this record" and names the term (it may be 0, or the snapshot may predate the field). `recCount` is never recorded. The constants are pinned to `lib/rows.js` by a test. `lw` in a snapshot is rounded to two decimals, so the product can differ by a cent from the build's. `--now` adds today's recomputation, which does not prove the past decision.
- **Moods.** `search --mood <id>` and `check --mood <id>` take any id in `config.json` `moods` (30 since 14/10/2026: the nine moods of the legacy family, `slow` included, then the 21 of the v2 Board; `board.legacyMoods` names the nine); the help prints the ids of the checkout it runs in. A mood with a hard gate (`where`: `hidden` = Letterboxd 3.8+ on under 10,000 ratings, `docs` = a documentary) is applied the way the build does it (`lib/board-rows.js` `rankMood`: `passes()` before `fit()`), so a film that fails the gate is not in the mood whatever its fit; `why` shows `ok: false` for it. Before 14/10/2026 the tool only ran `fit()`: `search --unseen --mood hidden` answered 10,358 films where the build had 1,006 (the tool counts every unseen film of the index, the build only its candidates, so the two numbers still differ: 1,037 against 1,006 on the caches of 14/10/2026; `test/` compares them on a fixture, with the build's own function). Like the build (`build.js` `compile(cfg.moods, cfg.lists)`, `lib/rows.js` `fit(film, mood, { lists })`), the recipes are compiled with the config lists that signal a mood (`index.moodLists`: id, name, `{ mood: weight }`) and `fit()` gets the ids of the lists that hold the film (`index.lists[id].ids`). `why`'s `moodFitNow` and `moodRankNow` use the same fit. Measured 12/10/2026 on the caches named above: `search --mood slow --ids --limit 0` 253 films without the list signal, 345 with it (the two slow-cinema canons hold 256 films, weight 2; the other eight moods do not change). The two numbers need the cache hashes above.
- **Unknown in `search`.** `excludedAsUnknown` counts, per filter, the films that filter alone left out because the fact is unknown (the film fails no other filter). The bands overlap: a film unknown on two filters is counted in both, so their sum is not a number of films. `excludedAsUnknownFilms` is: the distinct films left out only because a fact is unknown (unknown on at least one filter, failing none). It is always present, 0 when nothing is unknown.
- **Counts.** `search --aggregate` adds `aggregate` and `aggregateOver: "shown"`: counts over the films shown after `--limit`, never over the whole match (`total` is the whole match). By country, director, decade, language and genre, each a number of films (a film with two countries counts once in each), ordered by count then name. A fact a film does not carry goes to `unknown`, never to a bucket and never as zero.
- **`--limit 0`** means all rows in every command that lists, `taste` included. `check` refuses `--fields` (it answers pass/fails/unknown per id).
- **Reading without writing.** `load(root, { write: false })` reads a prepared index with the same signature, otherwise projects in memory and creates neither the file nor its directory. The CLI itself still writes its cache to `.context/films/` as before (a different `--root` keeps its index in this checkout's `.context/`).

## Known limits

- **List signal for moods** reads `index.lists` (corrections applied, static lists included, since 12/10/2026), so a static list that declares `moods` is seen like a Letterboxd one. None does today (only the two slow-cinema canons, both Letterboxd lists).
- **Pending homonyms the build relinks** (see above) stay pending here, so a favourite-director average or a "seen" test can differ slightly from the build's. The comparison above shows no effect on eligibility on 12/10/2026.
- **The taste model** is learned from rated films that have TMDB details, as the build does, but over the CLI's own links; a director near the 3 films / 4.0 threshold could flip on a pending homonym.
- **A film that only a list names and no cache knows** has no record (counted for the directors' file as `lovedWithoutRecord`; static-list films with no Letterboxd record and not in the TMDB cache are not counted and are not members of `index.lists`: the list holds the films the index has a record for).
- **`moodRank` can only be split for what a snapshot recorded;** the taste and quality z-scores of today are not recomputable without rebuilding the whole candidate pool.
- **Cache numbers move every night;** a number measured on one snapshot needs its cache hash next to it.
