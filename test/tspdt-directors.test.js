// The directors' lists of TSPDT (Marco, 22/10/2026 ~06:45 UTC: "eu quero que voce pega os top 250 das listas, tem os diretores tb, veja tudo que do tspdt"): lib/tspdt-directors.js reads three pages of the site,
// scripts/tspdt-directors.js writes data/tspdt-directors.json. Every test here fails if the named defect is put back (test-support/tspdt-mutations.js plants them).
// The three pages in test/fixtures/tspdt keep the markup of the real pages of 22/10/2026 (the <p> of each entry is the real one); the entries are renumbered 1..N and
// chosen for their variants: a team ("Stanley Donen & Gene Kelly", the title attribute says &#38;), a new entry "(-)" with a trailing "21stC" link, "0 films … / 16 films cited"
// (no "other"), "Top 1000" without the comma, and "Kathyrn" (TSPDT misspells Kathryn Bigelow on both pages).
const test = require("node:test");
const a = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const T = require("../lib/tspdt-directors");

const ROOT = path.resolve(__dirname, "..");
const fx = (n) => fs.readFileSync(path.join(__dirname, "fixtures", "tspdt", n), "utf8");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tspdt-dir-"));

// ── the pages ────────────────────────────────────────────────────────────────

test("the Top 250 page: position, name from the title attribute, last year's position, the films in the list and the others cited", () => {
  const r = T.parseRanked(fx("directors-top250.htm"));
  a.deepEqual(r.map((e) => [e.pos, e.name, e.prev, e.page]), [
    [1, "Alfred Hitchcock", 1, "hitchcockalfred.htm"],
    [2, "Stanley Donen & Gene Kelly", 1, "donenandkelly.htm"], // &#38; in the attribute is read as "&"
    [3, "Ridley Scott", 4, "scottridley.htm"],               // the ▲ outside the link is not part of the position
    [4, "Shohei Imamura", 3, "imamurashohei.htm"],
    [5, "Jordan Peele", null, "peelejordan.htm"],             // "(-)": new this year
    [6, "Kathyrn Bigelow", 6, "kathryn.htm"],
  ]);
  a.deepEqual(r.map((e) => [e.films, e.other]), [[13, 33], [1, 2], [3, 17], [0, 16], [1, 2], [2, 3]]); // "0 films … / 16 films cited" has no "other"; "1 film" is singular
  a.equal(r.length, 6, "the menu links (Home, Directors, Top 250 Directors) and the trailing '21stC' link are not entries");
});

test("the 21st Century Top 100 page says 'Top 1,000' and 'Top 1000'; both are read", () => {
  const r = T.parseRanked(fx("directors-top100.htm"));
  a.deepEqual(r.map((e) => [e.pos, e.name, e.prev, e.films, e.other]), [[1, "Wong Kar-wai", 1, 3, 2], [2, "Alain Guiraudie", null, 2, 6]]);
});

test("50 Key Noir Directors: the numbered lines after the opening sentence, an entity decoded, a team as one entry, the footer left out", () => {
  const r = T.parseNoir(fx("directors-noir50.htm"));
  a.deepEqual(r, [{ pos: 1, name: "Fritz Lang" }, { pos: 2, name: "Robert Siodmak" }, { pos: 3, name: "Joel Coen & Ethan Coen" }, { pos: 4, name: "André de Toth" }, { pos: 5, name: "Felix E. Feist" }]);
  a.throws(() => T.parseNoir("<html><body>1. Fritz Lang<br/></body></html>"), /the sentence that opens the list is not on the page/);
});

test("a half-read page is refused: a gap or a repeat in the positions, no entry at all, a line without its counts, an entity the table does not know", () => {
  const p = (pos, name, stat = "3 films in the 1,000 Greatest / 2 other films cited") => `<p><a href="x${pos}.htm" title="${name}">${pos}. ${name} (${pos})</a><br /><span>${stat}</span></p>`;
  a.throws(() => T.parseRanked(p(1, "A") + p(3, "B")), /entry 2 is numbered 3/);
  a.throws(() => T.parseRanked(p(1, "A") + p(1, "B")), /entry 2 is numbered 1/);
  a.throws(() => T.parseRanked("<html>nothing</html>"), /no director found/);
  a.throws(() => T.parseRanked(p(1, "A", "see the page")), /has no "N films in the/);
  a.throws(() => T.parseRanked(`<p><a href="x.htm" title="A">1. A</a><span>3 films in the 1,000 Greatest / 2 other films cited</span></p>`), /no last-year position/);
  a.throws(() => T.decode("Caf&zzzz;"), /entity &zzzz; is not handled/);
  a.equal(T.decode("Andr&eacute; &amp; M&#252;ller &#x26; &iexcl;"), "André & Müller & ¡");
});

// ── the match to TMDB ────────────────────────────────────────────────────────

const movie = (key, imdb, directors, extra = {}) => [key, { t: 1, v: { id: Number(key), imdb, title: `Film ${key}`, year: 2000, directors, ...extra } }];
const cache = (...rows) => Object.fromEntries(rows);
const H = { id: 2636, name: "Alfred Hitchcock" };

test("a name is matched to a TMDB person by its folded spelling; a name the cache does not have is null, never a guess (negative control)", () => {
  const dirs = T.directorsOf(cache(movie("1", "tt0000001", [H]), movie("2", "tt0000002", [{ id: 14392, name: "Kathryn Bigelow" }])), ["tt0000001", "tt0000002"]);
  a.deepEqual(T.matchMember("ALFRED HITCHCOCK", dirs), { name: "ALFRED HITCHCOCK", tmdb: 2636 });
  a.deepEqual(T.matchMember("Alfred Hitchcok", dirs), { name: "Alfred Hitchcok", tmdb: null }, "a misspelled name does not match by closeness");
  a.deepEqual(T.matchMember("Kathyrn Bigelow", dirs, {}), { name: "Kathyrn Bigelow", tmdb: null }, "without the alias, TSPDT's 'Kathyrn' is not 'Kathryn'");
  a.deepEqual(T.matchMember("Kathyrn Bigelow", dirs), { name: "Kathyrn Bigelow", tmdb: 14392 }, "with ALIASES it is, and ALIASES holds the id read against her films");
  a.deepEqual(T.matchMember("Charles Chaplin", { people: new Map(), byName: new Map() }), { name: "Charles Chaplin", tmdb: 13848 });
  a.deepEqual(T.matchMember("Robert J. Flaherty", { people: new Map(), byName: new Map() }).tmdb, 10092);
  a.deepEqual(T.matchMember("Alejandro González Iñárritu", { people: new Map(), byName: new Map() }).tmdb, 223);
});

test("homonyms: the person with most films in the index wins and is flagged; two with as many films each stay null", () => {
  const J1 = { id: 11, name: "John Smith" }, J2 = { id: 22, name: "John  Smith" };
  const rows = [movie("1", "tt01", [J1]), movie("2", "tt02", [J2]), movie("3", "tt03", [J2]), movie("4", "tt04", [J2])];
  const dirs = T.directorsOf(cache(...rows), ["tt01", "tt02", "tt03"]); // J1 has 1 film in the index, J2 has 2 (the third is outside the index)
  a.deepEqual(T.matchMember("John Smith", dirs), { name: "John Smith", tmdb: 22, ambiguous: true });
  const tie = T.directorsOf(cache(...rows), ["tt01", "tt02"]); // 1 and 1
  a.deepEqual(T.matchMember("John Smith", tie), { name: "John Smith", tmdb: null, ambiguous: true });
});

test("a film joins by its OWN imdb id, not by the key it is stored under (the 50 old records stored under a TV id that names another film)", () => {
  // key "999" holds the record of tt0000002 (another film than the one the key was asked for); the index has tt0000001 and tt0000002
  const m = cache(movie("1", "tt0000001", [H]), movie("999", "tt0000002", [{ id: 5, name: "Somebody Else" }]));
  const dirs = T.directorsOf(m, ["tt0000001", "tt0000002"]);
  a.deepEqual([...dirs.people.get(2636).films], ["tt0000001"]);
  a.deepEqual([...dirs.people.get(5).films], ["tt0000002"]);
  a.equal(T.directorsOf(m, ["tt0000009"]).people.get(2636).films.size, 0, "a film the index does not hold is not counted");
  a.equal(T.directorsOf({ x: null, y: { v: null }, z: { v: { directors: [{ id: "7", name: "Bad" }, null] } } }, []).people.size, 0, "records without a usable director are skipped");
});

test("attach: one director gets his id and his films in the index; a team gets null and one id per member; a film of the team counts once", () => {
  const P = { id: 68424, name: "Michael Powell" }, E = { id: 37846, name: "Emeric Pressburger" };
  const m = cache(movie("1", "tt01", [P, E]), movie("2", "tt02", [P]), movie("3", "tt03", [E]), movie("4", "tt04", [H]));
  const dirs = T.directorsOf(m, ["tt01", "tt02", "tt03", "tt04"]);
  const [solo, team, none] = T.attach([{ pos: 1, name: "Alfred Hitchcock" }, { pos: 2, name: "Michael Powell & Emeric Pressburger" }, { pos: 3, name: "Nobody Known" }], dirs);
  a.equal(solo.tmdb, 2636); a.equal(solo.filmsInIndex, 1);
  a.equal(team.tmdb, null); a.deepEqual(team.members.map((x) => x.tmdb), [68424, 37846]); a.equal(team.filmsInIndex, 3, "tt01 is Powell's and Pressburger's: once");
  a.equal(none.tmdb, null); a.equal(none.filmsInIndex, 0);
  a.deepEqual(T.members("Joel Coen & Ethan Coen"), ["Joel Coen", "Ethan Coen"]);
  a.deepEqual(T.members("Wong Kar-wai"), ["Wong Kar-wai"]);
});

// ── the script ───────────────────────────────────────────────────────────────

function world() {
  const dir = tmp();
  const pages = path.join(dir, "pages");
  fs.mkdirSync(pages);
  for (const [f, n] of [["gf1000_top250directors.htm", "directors-top250.htm"], ["21stcentury_top100directors.htm", "directors-top100.htm"], ["50keynoirdirectors.htm", "directors-noir50.htm"]]) fs.copyFileSync(path.join(__dirname, "fixtures", "tspdt", n), path.join(pages, f));
  const rows = [movie("1", "tt01", [H]), movie("2", "tt02", [H]), movie("3", "tt03", [{ id: 14392, name: "Kathryn Bigelow" }]), movie("4", "tt04", [{ id: 1, name: "Fritz Lang" }])];
  fs.writeFileSync(path.join(dir, "tmdb.json"), JSON.stringify({ movie: cache(...rows) }));
  const films = ["tt01", "tt02", "tt03", "tt04"].map((tt) => [tt, tt === "tt01" ? "R7jhM:5" : ""]);
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ meta: { builtAt: "2026-10-22T04:46:53.756Z", count: 4 }, cols: ["tt", "lists"], films }));
  return { dir, pages, run: (...extra) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "tspdt-directors.js"), "--pages-dir", pages, "--index", path.join(dir, "index.json"), "--tmdb", path.join(dir, "tmdb.json"), "--out", path.join(dir, "out.json"), "--read-on", "2026-10-22", ...extra], { encoding: "utf8" }) };
}

test("the script writes the file: three lists, one director per line, the ids, the films in the index, the first 12 digits of the sha256 of what the counts came from", () => {
  const w = world();
  const r = w.run("--any-count");
  a.equal(r.status, 0, r.stdout + r.stderr);
  const text = fs.readFileSync(path.join(w.dir, "out.json"), "utf8");
  const d = JSON.parse(text);
  a.deepEqual(Object.keys(d.lists), ["top250", "c21top100", "noir50"]);
  a.deepEqual(Object.values(d.lists).map((l) => l.count), [6, 2, 5]);
  const [hitch, team, , , , bigelow] = d.lists.top250.directors;
  a.equal(hitch.tmdb, 2636); a.equal(hitch.filmsInIndex, 2); a.deepEqual([hitch.films, hitch.other], [13, 33]);
  a.equal(team.tmdb, null); a.deepEqual(team.members.map((m) => m.name), ["Stanley Donen", "Gene Kelly"]); a.deepEqual(team.members.map((m) => m.tmdb), [null, null]);
  a.equal(bigelow.tmdb, 14392, "the alias for TSPDT's 'Kathyrn' works through the whole script"); a.equal(bigelow.filmsInIndex, 1);
  a.equal(d.lists.noir50.directors[0].tmdb, 1); a.equal(d.lists.noir50.directors[3].tmdb, null, "André de Toth is not in the cache");
  a.match(d.index.sha256First12, /^[0-9a-f]{12}$/); a.match(d.tmdbCacheSha256First12, /^[0-9a-f]{12}$/);
  a.deepEqual([d.index.builtAt, d.index.count, d.source.readOn], ["2026-10-22T04:46:53.756Z", 4, "2026-10-22"]);
  a.equal(text.split("\n").filter((l) => l.startsWith('{"pos"')).length, 13, "one line per director");
  a.match(r.stdout, /control \(films in the 1,000 Greatest.*\): 0 of 2 agree; off: 1\. Alfred Hitchcock: TSPDT 13, index 1; 6\. Kathyrn Bigelow: TSPDT 2, index 0/, "TSPDT says 13 films of Hitchcock are in the 1,000, the index's list R7jhM holds 1: the disagreement is printed, not hidden");
  fs.rmSync(w.dir, { recursive: true, force: true });
});

test("the script refuses a page that does not hold the count the site publishes (250, 100, 50): 6 entries are a half-read page", () => {
  const w = world();
  const r = w.run();
  a.notEqual(r.status, 0);
  a.match(r.stderr, /top250: 6 directors, the page publishes 250/);
  a.equal(fs.existsSync(path.join(w.dir, "out.json")), false, "nothing is written");
  fs.rmSync(w.dir, { recursive: true, force: true });
});

// ── the file in the repository ───────────────────────────────────────────────

test("data/tspdt-directors.json: 250 + 100 + 50 directors in order, an id or null, a team has null and one id per member, no id taken by two directors", () => {
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "tspdt-directors.json"), "utf8"));
  a.deepEqual(Object.entries(d.lists).map(([k, l]) => [k, l.count, l.directors.length]), [["top250", 250, 250], ["c21top100", 100, 100], ["noir50", 50, 50]]);
  a.match(d.source.readOn, /^\d{4}-\d{2}-\d{2}$/); a.match(d.index.sha256First12, /^[0-9a-f]{12}$/); a.match(d.tmdbCacheSha256First12, /^[0-9a-f]{12}$/);
  for (const [k, l] of Object.entries(d.lists)) {
    const solo = new Map();
    l.directors.forEach((e, i) => {
      const at = `${k} ${i + 1} ${e.name}`;
      a.equal(e.pos, i + 1, at);
      a.ok(e.members.length >= 1, at);
      for (const m of e.members) a.ok(m.tmdb === null || (Number.isInteger(m.tmdb) && m.tmdb > 0), at);
      if (e.members.length === 1) { a.equal(e.tmdb, e.members[0].tmdb, at); if (e.tmdb != null) { a.ok(!solo.has(e.tmdb), `${at}: id ${e.tmdb} also ${solo.get(e.tmdb)}`); solo.set(e.tmdb, e.name); } }
      else a.equal(e.tmdb, null, `${at}: a team has no single id`);
      a.ok(Number.isInteger(e.filmsInIndex) && e.filmsInIndex >= 0, at);
      if (k !== "noir50") a.ok(Number.isInteger(e.films) && Number.isInteger(e.other), at);
    });
  }
  const [h, w, k] = d.lists.top250.directors;
  a.deepEqual([h.name, h.tmdb, w.name, w.tmdb, k.name, k.tmdb], ["Alfred Hitchcock", 2636, "Orson Welles", 40, "Stanley Kubrick", 240], "TMDB's own ids of the first three");
  const byName = (n) => d.lists.top250.directors.find((e) => e.name === n);
  a.equal(byName("Charles Chaplin").tmdb, 13848); a.equal(byName("Kathyrn Bigelow").tmdb, 14392); a.equal(byName("Robert J. Flaherty").tmdb, 10092);
  a.equal(d.lists.c21top100.directors.find((e) => /Iñárritu/.test(e.name)).tmdb, 223);
  a.ok(d.lists.top250.directors.filter((e) => e.members.length > 1).length >= 5, "the teams of the top 250 (Powell & Pressburger, Donen & Kelly, the Coens, the Dardennes…) are entries of several members");
});
