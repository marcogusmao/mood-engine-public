// The real build with a fake TMDB (test-support/fake-tmdb-fetch.js), on a copy of the committed caches (Marco, 22/10/2026 ~21:40 UTC, frente friends-cards; unit tests: test/friends-records.test.js).
// Written against: 25 of the 243 cards of the friends' rows of the live Board with no credits line (Intermissions, Inside Out 2 ...) because nobody had asked TMDB for the records of films outside the pool;
// and a series typed as a film (Ripley, tt11016042) in Friend's top picks, its `find` never asked, so the recommendation rule could not tell. ONE build (a build takes about a minute; two took 538 s under load).
// The scene is planted in the copy: Francesca (friend-f, the friend of the day on 2026-10-22: day 20748 mod 7 = 0 since 29/10/2026, mod 6 before: the same person either way) rates Intermissions 5★ and Ripley 4.5★; the cache has never heard of either (no movie,
// no find); the fake TMDB knows every film of cache/friends.json as a movie, except Ripley, which it knows as a series (404 for its number, nothing in /find).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const NO_CACHE = !fs.existsSync(path.join(ROOT, "cache", "tmdb.json")) || !fs.existsSync(path.join(ROOT, "cache", "friends.json"));
const PLANTED = { movie: { slug: "intermissions", tt: "tt0430059", stars: 5 }, series: { slug: "ripley", tt: "tt11016042", stars: 4.5 } };
// Two more films of the diary of the week (review of 22/10/2026): `wrongId`, whose Letterboxd number is ANOTHER film's (tt9999990) while /find gives the right movie (88888888); `hiddenMovie`, whose Letterboxd number came back
// EMPTY in a cache that never asked /find (noRecord hides it from every row) while /find has a movie (77777777).
const EXTRA = { wrongId: { slug: "fixture-wrong-id", tt: "tt9999993", id: 99999993, found: 88888888, other: "tt9999990" }, badFind: { slug: "fixture-bad-find", tt: "tt9999995", id: 99999995, found: 66666666, other: "tt9999996" }, hiddenMovie: { slug: "fixture-hidden-movie", tt: "tt9999994", id: 99999994, found: 77777777 } };
// Marco, 28/10/2026 (Discover proposal 5, "All friends loved"): a film that only a person OUTSIDE the menu loved. Anna Mendes follows nobody's menu (she is one of the 51 people Marco follows, not one of the seven friends)
// and rates it 5★; William has it on his watchlist, which is what brings it into the pool and so into the index. Written against: the option read from the seven friends (view.users) and not from the whole crowd.
const CROWD = { slug: "fixture-crowd-only", tt: "tt9999997", id: 99999997, title: "Fixture Crowd Only", lover: "annamendesc", stars: 5 };
// and the bar itself, on the same two terms: a 4★ from Anna is enough (the bar is 4★ and AT it counts), a 3.5★ is not
const CROWD_BAR = [{ slug: "fixture-crowd-four", tt: "tt9999998", id: 99999998, title: "Fixture Crowd Four", stars: 4, loved: true }, { slug: "fixture-crowd-three-half", tt: "tt9999988", id: 99999988, title: "Fixture Crowd Three Half", stars: 3.5, loved: false }];
// 29/10/2026, review of front C (mutation that survived): reading the crowd of build.js (`view.crowd`) with the ratings of config.json `ratingsIgnored` given back did not turn any test red. A film that only benreiss (ratingsIgnored.users) rated 5★,
// brought into the index by William's watchlist like the two above, must NOT be in the option: an ignored rating loves nothing. Written against: allFriendsLoved fed from a reading of the 51 that skips the list and the rule of userView.
const IGNORED = { slug: "fixture-ignored-lover", tt: "tt9999987", id: 99999987, title: "Fixture Ignored Lover", lover: "benreiss", stars: 5 };
const WEEK = { movie: { slug: "fixture-movie-of-the-week", tt: "tt9999992", id: 99999992 }, series: { slug: "fixture-series-of-the-week", tt: "tt9999991", id: 99999991 } };
// Whole lists (Marco, 23/10/2026, "cada opção mostra a lista inteira do amigo"): Gustavo's list "Comedy" gets 130 invented films nobody rates, saves or asked TMDB about, more than the Discover cap (config.json sizes.friendsDiscover).
// Written against: `make = () =>` in build.js ignored the config friendsFull passed, so the Worker's options (index-friends.json) stopped at the cap, 60 films each, from the merge 4a40105 (11/10/2026, whose first parent had `make = (c = cfg)`) to 23/10/2026; and the films
// beyond the cap of a friend's LIST reach no other step that asks TMDB (the pool takes the friends' watchlists and their 4.5★ picks, not their lists), so their record is asked by the build's pass over the whole lists.
const WHOLE = Array.from({ length: 130 }, (_, i) => { const n = String(i + 1).padStart(3, "0"); return { slug: `fixture-whole-list-${n}`, tt: `tt98000${n}`, id: 98000000 + i + 1, title: `Fixture Whole List ${n}` }; }); // 130: more than the Discover cap of 100 (15/11/2026; it was 70 over a cap of 60)
const WHOLE_LABEL = "Comedy (Gustavo)";
const FRIEND_ROWS = ["top-picks", "friends-split", "friends-month", "friends-watchlist", "friends-love", "friends-week"]; // the rows of the Board that show what the people he follows did
const read = (out, ...p) => JSON.parse(fs.readFileSync(path.join(out, ...p), "utf8"));

test("build: the films of the friends' rows get their TMDB record (a credits line), a series (no TMDB movie) is in no friends row, the Friends collections of Discover included", { skip: NO_CACHE, timeout: 1800000 }, (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "me-fcards-out-")), cache = fs.mkdtempSync(path.join(os.tmpdir(), "me-fcards-cache-")), aux = fs.mkdtempSync(path.join(os.tmpdir(), "me-fcards-aux-"));
  try {
    for (const f of ["lists.json", "directors.json", "imdb-ratings.json", "mubi.json"]) fs.copyFileSync(path.join(ROOT, "cache", f), path.join(cache, f));
    const friends = JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "friends.json"), "utf8"));
    const tmdb = JSON.parse(fs.readFileSync(path.join(ROOT, "cache", "tmdb.json"), "utf8"));
    // the scene: Francesca rates the two films; the cache has never asked about them
    const francesca = friends.users.friend-f, william = friends.users.friend-a; // William is a configured friend: his "Top" option of the Discover Friends collection is where a series would show
    for (const p of Object.values(PLANTED)) {
      const film = friends.films[p.slug];
      assert.ok(film && film.imdbId === p.tt && film.tmdbId, `the fixture: cache/friends.json names ${p.slug} (${p.tt}) with a TMDB id`);
      for (const [who, stars] of [[francesca, p.stars], [william, 5]]) {
        const row = who.films.find((x) => x[0] === p.slug);
        if (row) row[3] = stars; else who.films.push([p.slug, film.title, film.year, stars]);
      }
      delete tmdb.movie[film.tmdbId]; delete tmdb.find[p.tt];
    }
    // two invented films that only William's diary of the last week holds (nobody rates them 4★ or more, so no other friends' row reaches them): a movie and a series (the fake TMDB has no movie for the series)
    const invent = (slug, tt, id, title) => { friends.films[slug] = { title, year: 2024, tmdbId: id, imdbId: tt, r: 4.2, rn: 5000, rt: 100, c: ["USA"], t: Date.now(), v: 2 }; };
    invent(WEEK.movie.slug, WEEK.movie.tt, WEEK.movie.id, "Fixture Movie of the Week");
    invent(WEEK.series.slug, WEEK.series.tt, WEEK.series.id, "Fixture Series of the Week");
    invent(EXTRA.wrongId.slug, EXTRA.wrongId.tt, EXTRA.wrongId.id, "Fixture Wrong Id");
    invent(EXTRA.badFind.slug, EXTRA.badFind.tt, EXTRA.badFind.id, "Fixture Bad Find");
    invent(EXTRA.hiddenMovie.slug, EXTRA.hiddenMovie.tt, EXTRA.hiddenMovie.id, "Fixture Hidden Movie");
    for (const c of [CROWD, ...CROWD_BAR, IGNORED]) invent(c.slug, c.tt, c.id, c.title);
    assert.ok(friends.users[CROWD.lover], "the fixture: the person outside the menu is in the cache");
    assert.ok(friends.users[IGNORED.lover] && JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")).ratingsIgnored.users.includes(IGNORED.lover), "the fixture: the person whose ratings are ignored is in the cache and in config.json ratingsIgnored.users");
    william.watchlist.push([IGNORED.slug, IGNORED.title, 2024]); friends.users[IGNORED.lover].films.push([IGNORED.slug, IGNORED.title, 2024, IGNORED.stars]);
    for (const c of [CROWD, ...CROWD_BAR]) { william.watchlist.push([c.slug, c.title, 2024]); friends.users[CROWD.lover].films.push([c.slug, c.title, 2024, c.stars]); }
    for (const w of WHOLE) invent(w.slug, w.tt, w.id, w.title); // not in the cache of TMDB: only the fake knows them
    friends.lists["friend-c/comedia"].items = WHOLE.map((w) => [w.slug, w.title, 2024]); // the owner's order: the first 100 (sizes.friendsDiscover) are the static collection's
    tmdb.movie[EXTRA.hiddenMovie.id] = { t: Date.now(), v: null }; // asked on its Letterboxd number: empty; /find never asked
    for (const w of [...Object.values(WEEK), EXTRA.wrongId, EXTRA.hiddenMovie, EXTRA.badFind]) william.rss.push([w.slug, friends.films[w.slug].title, 2024, 2, "2026-10-21"]);
    fs.writeFileSync(path.join(cache, "friends.json"), JSON.stringify(friends));
    fs.writeFileSync(path.join(cache, "tmdb.json"), JSON.stringify(tmdb));
    // the fake TMDB: every film of friends.json is a movie under the number Letterboxd names, except the planted series
    const movies = {}, finds = {};
    for (const f of Object.values(friends.films)) if (f.tmdbId && f.imdbId && f.imdbId !== PLANTED.series.tt && f.imdbId !== WEEK.series.tt) { movies[f.tmdbId] = f.imdbId; finds[f.imdbId] = f.tmdbId; }
    movies[EXTRA.wrongId.id] = EXTRA.wrongId.other; finds[EXTRA.wrongId.tt] = EXTRA.wrongId.found; movies[EXTRA.wrongId.found] = EXTRA.wrongId.tt;
    movies[EXTRA.badFind.id] = EXTRA.badFind.other; finds[EXTRA.badFind.tt] = EXTRA.badFind.found; movies[EXTRA.badFind.found] = EXTRA.badFind.other; // /find gives a record that names ANOTHER film: no card and no index entry may use it
    delete movies[EXTRA.hiddenMovie.id]; finds[EXTRA.hiddenMovie.tt] = EXTRA.hiddenMovie.found; movies[EXTRA.hiddenMovie.found] = EXTRA.hiddenMovie.tt;
    const log = path.join(aux, "asked.log");
    fs.writeFileSync(log, "");
    fs.writeFileSync(path.join(aux, "fake.json"), JSON.stringify({ movies, finds, log }));
    const r = spawnSync(process.execPath, ["--require", path.join(ROOT, "test-support", "fake-tmdb-fetch.js"), "build.js", "--cache-only", "--skip-posters", "--date", "2026-10-22", "--captured-at", "2026-10-22T23:18:00.000Z", "--cache-dir", cache, "--out", out],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, SKIP_RSS: "1", TMDB_TOKEN: "x".repeat(40), MUBI_CACHE: "", OFFLINE: "", FAKE_TMDB: path.join(aux, "fake.json") } });
    assert.equal(r.status, 0, r.stderr + r.stdout.slice(-3000));
    const asked = new Set(fs.readFileSync(log, "utf8").split("\n").filter(Boolean));

    // 1  the planted film that is a movie: asked, and in Friend's top picks with its credits
    const top = read(out, "data", "index-v2-row-top-picks.json");
    const col = (j, name) => j.cols.indexOf(name);
    const cardOf = (j, tt) => j.films.find((f) => f[0] === tt);
    const inter = cardOf(top, PLANTED.movie.tt);
    assert.ok(inter, "Intermissions (Francesca 5★) is in Friend's top picks on 2026-10-22");
    assert.ok(inter[col(top, "director")], "and has its director");
    assert.match(inter[col(top, "desc")].split("\n")[0], /Fixture Actor 1/, "and its cast (the first line of `desc` is the actors of the credits line)");
    assert.ok(asked.has(`/3/movie/${friends.films[PLANTED.movie.slug].tmdbId}`), "the build asked TMDB for the movie under the number Letterboxd names");

    // 2  the series: find asked (so the rule can say TMDB has no movie of it), and in no friends row
    assert.ok(asked.has(`/3/find/${PLANTED.series.tt}`), "find was asked about the series");
    const holders = [];
    for (const f of fs.readdirSync(path.join(out, "data")).filter((n) => /^index-v2-row-.*\.json$/.test(n))) {
      const j = read(out, "data", f);
      if (Object.values(j.rows).some((tts) => tts.includes(PLANTED.series.tt))) holders.push(f);
    }
    assert.deepEqual(holders.filter((f) => FRIEND_ROWS.some((id) => f === `index-v2-row-${id}.json`)), [], "the series is in no friends row of the Board");
    const friendsIndex = JSON.stringify(read(out, "data", "index-friends.json").films.map((f) => f[0]));
    assert.ok(!friendsIndex.includes(PLANTED.series.tt), "nor in the index of the friends' Discover collections");
    const dir = path.join(out, "catalog", "movie", "mood-engine-friends");
    for (const f of fs.readdirSync(dir)) assert.ok(!read(dir, f).metas.some((m) => m.id === PLANTED.series.tt), `${f}: no series in a Friends collection`);
    const williamTop = read(dir, "genre=Top · William.json").metas.map((m) => m.id);
    assert.ok(williamTop.length > 10 && williamTop.includes(PLANTED.movie.tt), "control: William's Top option holds the planted film that is a movie (so the series is missing from it for a reason)");

    // 2a  WHOLE LISTS: the Worker's option of Gustavo's list holds all 130 films in the owner's order, the static collection stops at the Discover cap, and the films beyond the cap got their TMDB record
    const cap = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")).sizes.friendsDiscover;
    assert.ok(Number.isInteger(cap) && cap > 0 && cap < WHOLE.length, `the fixture needs a cap below ${WHOLE.length} planted films (config.json sizes.friendsDiscover = ${cap})`);
    assert.deepEqual(read(dir, `genre=${WHOLE_LABEL}.json`).metas.map((m) => m.id), WHOLE.slice(0, cap).map((w) => w.tt), "the static collection stops at the Discover cap, in the owner's order");
    const friendsFile = read(out, "data", "index-friends.json");
    const wholeIds = friendsFile.friends.options.find((o) => o.label === WHOLE_LABEL).ids;
    assert.deepEqual(wholeIds, WHOLE.map((w) => w.tt), "the Worker's option holds the whole list (more than the cap), in the owner's order");
    // 2a2  Marco, 28/10/2026, answer (b) of question 4 (Discover proposal 5): seven whole friends in his order, and "All friends loved" right after the last Top option, before the first Watch together.
    // Written against: the option at the end of the menu, the three new friends in the order they were added (after the four), and the option missing from one of the two indices.
    const labels = friendsFile.friends.options.map((o) => o.label);
    assert.deepEqual(labels.slice(0, 9), ["Top · William", "Top · friend-b", "Top · Gustavo", "Top · friend-d", "Top · friend-e", "Top · Francesca", "Top · friend-g", "All friends loved", "Watch together · William"], "the seven Top options in Marco's order, then All friends loved, then Watch together");
    assert.deepEqual(friendsFile.friends.people, ["William", "friend-b", "Gustavo", "friend-d", "friend-e", "Francesca", "friend-g"], "and the index names the seven people in the same order");
    const allLoved = friendsFile.friends.options.find((o) => o.label === "All friends loved").ids;
    const heldBy0 = new Set(read(out, "data", "index-v2.json").films.map((f) => f[0]));
    assert.ok(allLoved.length > 100 && new Set(allLoved).size === allLoved.length, `All friends loved holds many films, each once (${allLoved.length})`);
    assert.ok(allLoved.includes(PLANTED.movie.tt), "Intermissions (William and Francesca gave it 5★) is in it");
    assert.ok(allLoved.includes(CROWD.tt), "a film only Anna Mendes (outside the seven) loved is in it: the option reads the whole crowd");
    assert.ok(!friendsFile.friends.people.includes("Anna Mendes"), "control: she is not one of the people of the menu");
    for (const c of CROWD_BAR) {
      assert.ok(heldBy0.has(c.tt), `control: ${c.title} is a film of the index (William's watchlist brought it), so the option could hold it`);
      assert.equal(allLoved.includes(c.tt), c.loved, `${c.title}: Anna gave it ${c.stars}★, and the bar of All friends loved is 4★, met AT it`);
    }
    assert.ok(heldBy0.has(IGNORED.tt), `control: ${IGNORED.title} is a film of the index (William's watchlist brought it), so the option could hold it`);
    assert.ok(!allLoved.includes(IGNORED.tt), `${IGNORED.title}: only ${IGNORED.lover} (ratingsIgnored) gave it ${IGNORED.stars}★, and an ignored rating loves nothing`);
    assert.ok(!allLoved.includes(PLANTED.series.tt), "Ripley (a series for TMDB) is not, whoever loved it");
    const heldBy = new Set(friendsFile.films.map((f) => f[0]));
    assert.ok(allLoved.every((tt) => heldBy.has(tt)), "every film of the option is a film of the index (the option adds none)");
    assert.equal(read(out, "data", "index-v2.json").friends.options.map((o) => o.label).indexOf("All friends loved"), 7, "and the v2 index has it at the same position");
    assert.equal(read(out, "data", "index.json").friends.options.map((o) => o.label).indexOf("All friends loved"), 7, "and so has the legacy index");
    assert.match(r.stdout, /Friends option "All friends loved" \(index v2\): \d+ unseen films/);
    assert.ok(!fs.existsSync(path.join(dir, "genre=All friends loved.json")), "the static addon does not carry it (it is the Worker's option: ~1,600 films)");
    for (const w of WHOLE.slice(cap)) assert.ok(asked.has(`/3/movie/${w.id}`), `${w.slug}: beyond the cap, and the build asked TMDB for its record`);
    const lastCard = cardOf(friendsFile, WHOLE[WHOLE.length - 1].tt);
    assert.ok(lastCard && lastCard[col(friendsFile, "director")], "and its card has the credits line, like the films of the static collection");
    assert.match(r.stdout, /Friends' options for the Worker \(whole lists, \d+ films\): \d+ film\(s\) asked of TMDB for their record in \d round\(s\)/);

    // 2b  the week row is built before the pool and before the Board's special rows: it must ask by itself (the series of the week is only in it)
    assert.ok(asked.has(`/3/find/${WEEK.series.tt}`), "find was asked about the series of the week");
    const week = read(out, "catalog", "movie", "friends-week.json").metas;
    const weekMovie = week.find((m) => m.id === WEEK.movie.tt);
    assert.ok(weekMovie, "control: the movie of the week is in Friends watched this week");
    assert.match(String(weekMovie.description).split("\n")[0], /Fixture Director/, "with its credits line");
    assert.ok(!week.some((m) => m.id === WEEK.series.tt), "the series of the week is not");

    // 2c  the number Letterboxd names is another film's: the card reads the record /find found (static card and index); a film hidden by an empty number comes back when /find has a movie for it
    const weekIndex = read(out, "data", "index-v2-row-friends-week.json");
    for (const x of [EXTRA.wrongId, EXTRA.hiddenMovie]) {
      assert.ok(asked.has(`/3/find/${x.tt}`), `find was asked about ${x.slug}`);
      const meta = week.find((m) => m.id === x.tt);
      assert.ok(meta, `${x.slug} is in Friends watched this week`);
      assert.match(String(meta.description).split("\n")[0], new RegExp(`Fixture Director ${x.tt}`), `${x.slug}: the static card has the credits of the record /find found`);
      assert.equal(meta.name, `Fixture ${x.tt}`, `${x.slug}: the static card is named by the record /find found (the title of the Letterboxd page is "${friends.films[x.slug].title}")`);
      assert.equal(cardOf(weekIndex, x.tt)[col(weekIndex, "director")], `Fixture Director ${x.tt}`, `${x.slug}: so does the index (the live card)`);
    }

    // 2d  a record that /find found but that names another IMDb id is used by nobody: not the static card, not the index (review: taking `own()` off `detailOfImdb` in lib/index-export.js left the build test green)
    const bad = cardOf(weekIndex, EXTRA.badFind.tt);
    assert.ok(bad, "the film with a bad find is still a film of the week");
    assert.ok(!bad[col(weekIndex, "director")], "the index does not take the director of the other film's record");
    assert.ok(!String(bad[col(weekIndex, "desc")] || "").includes("Fixture Actor"), "nor its cast");
    assert.ok(!/Fixture Director/.test(String(week.find((m) => m.id === EXTRA.badFind.tt)?.description || "")), "nor does the static card");

    // 3  no card of a friends row lacks its credits line (the fake TMDB knows every film of friends.json), and the log says what was asked
    const bare = [];
    let cards = 0;
    for (const id of FRIEND_ROWS) {
      const j = read(out, "data", `index-v2-row-${id}.json`);
      for (const tt of j.rows[id] || []) {
        cards++;
        if (tt === EXTRA.badFind.tt) continue; // the one card that has no record on purpose (2d)
        const c = cardOf(j, tt);
        if (!c[col(j, "director")] && !String(c[col(j, "desc")] || "").split("\n")[0]) bare.push(`${id}:${c[col(j, "name")]} (${tt})`);
      }
    }
    assert.ok(cards >= 100, `the friends' rows hold cards (${cards})`);
    assert.deepEqual(bare, [], "every card of every friends row has a director or a cast (Dekalog, find -> an empty movie, is out of friends-month since 22/10/2026: noRecord)");
    // 3b  the STATIC cards of the two Friends rows that are made from the plan item when the row is built (the index above reads the final cache, so it hides a row that was built before its records came)
    for (const id of ["friends-love", "friends-week"]) {
      for (const m of read(out, "catalog", "movie", `${id}.json`).metas) {
        if (m.id === EXTRA.badFind.tt) continue; // no record on purpose (2d)
        const first = String(m.description || "").split("\n")[0];
        assert.ok(first && !/^(\d+h\d\d|\d+m)\.$/.test(first), `${id}: ${m.name} opens with no director or cast: ${JSON.stringify(first)}`);
      }
    }
    // Dekalog (tt0092337, a series): find -> 37452 and the movie 37452 asked and empty in the committed cache; the rule takes it out of friends-month (review of 22/10/2026). Asserted while the cache is in that state.
    if (tmdb.find.tt0092337?.v && tmdb.movie[tmdb.find.tt0092337.v]?.v === null) assert.ok(!read(out, "data", "index-v2-row-friends-month.json").rows["friends-month"].includes("tt0092337"), "Dekalog is out of Friends watched this month");
    else t.diagnostic("cache/tmdb.json no longer holds Dekalog as find -> an empty movie: its assertion was not made");
    t.diagnostic(`asks: ${asked.size} distinct (${[...asked].filter((x) => x.includes("/movie/")).length} movie, ${[...asked].filter((x) => x.includes("/find/")).length} find)`);
    for (const l of r.stdout.split("\n").filter((x) => /Friends' cards|Friends' rows of the v2|Friends watched this week: \d+ film\(s\) asked|Films TMDB has no movie of/.test(x))) t.diagnostic(l.trim());
    assert.match(r.stdout, /Films TMDB has no movie of \(kept out of the rows\): \d+ looked at, \d+ asked in \/find now/);
    assert.match(r.stdout, /Friends' rows of the v2 Board: \d+ film\(s\) asked of TMDB for their record in \d round\(s\)/);
    assert.match(r.stdout, /Friends' cards \(Friends loved and the Discover collections\): \d+ film\(s\) asked of TMDB for their record in \d round\(s\)/);
  } finally { for (const d of [out, cache, aux]) fs.rmSync(d, { recursive: true, force: true }); }
});
