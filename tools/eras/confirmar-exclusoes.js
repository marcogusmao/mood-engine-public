// What the written exclusions of data/eras/*.json do, over a public index-v2.json and the TMDB records of cache/tmdb.json (specification 1.2 and 5.2). The list STARTS EMPTY (15/11/2026): with no exclusion the
// script prints "0 exclusions, 0 finding(s)" and exits 0. When the curation writes exclusions (a reason and a source each), run it again.
// usage: node tools/eras/confirmar-exclusoes.js <root of the checkout> <index-v2.json> [--paises] [--plantar]
// For every exclusion of every school, three states of the era:
//   written   the era as it is: the film must NOT be a member (the exclusion wins over both doors);
//   unwritten the same era without its exclusions: out = "redundant" (the country of the school already leaves it out); IN = "changes the membership" (the exclusion is what keeps it out: a blockbuster, say);
//   no gate   without the exclusions and without the country: IN = a door brings the film today; OUT = no door brings it today (defensive: the film is named by a source and left out, or a film that the curation could add).
// A FINDING (exit 1): the film is still a member as written (the exclusion does not hold), or the id is not a film that this repository knows at all (a typo: it is neither in the public index nor in the curation snapshot nor in an era file).
//   --paises   prints the films of a director of a list that the country of the school takes out today (with the MAIN country that takes them out), the list that research/2026-11-15-eras-v2-antes-depois.md keeps
//   --plantar  plants an exclusion with an id that no film has in the first school, to show that the script accuses it (the exit code must be 1)
const fs = require("fs"), path = require("path");
const [root, indexFile] = process.argv.slice(2).filter((a) => !a.startsWith("--")).map((a) => path.resolve(a)); // a relative path (`.`) is resolved against the working directory
const req = (p) => require(path.join(root, p));
const DC = req("lib/discover-catalogs"), ERA = req("lib/era-lists"), CO = req("lib/countries"), DR = req("lib/directors");
const CONFIG = req("config.json"), { keywordTerms } = req("lib/index-export"), BOARD = req("lib/board").parse(CONFIG, "config.json board");
CO.setDirectors(DR.citizenshipMap(DR.load(path.join(root, "cache", "directors.json"))));
const idx = JSON.parse(fs.readFileSync(indexFile, "utf8"));
const col = Object.fromEntries(idx.cols.map((c, i) => [c, i]));
const num = (x) => (x === "" || x == null ? undefined : Number(x));
const films = idx.films.map((r) => { const flags = Number(r[col.flags]) || 0; const lists = {}; for (const p of String(r[col.lists] || "").split(",")) if (p) lists[p.split(":")[0]] = 1;
  return { tt: r[col.tt], name: r[col.name], year: num(r[col.year]), lbRating: num(r[col.lbRating]), seen: (flags & 1) === 1, eligible: (flags & 4) === 4, musicOut: (flags & 8) === 8, lists, director: r[col.director] || null }; });
const tmdb = JSON.parse(fs.readFileSync(path.join(root, "cache", "tmdb.json"), "utf8"));
const byImdb = new Map();
for (const e of Object.values(tmdb.movie)) if (e && e.v && e.v.imdb) { const o = byImdb.get(e.v.imdb); if (!o || (e.t || 0) > (o.t || 0)) byImdb.set(e.v.imdb, e); }
const rec = (tt) => (byImdb.get(tt) || {}).v || null;
const json = DC.load();
const opts = { lists: CONFIG.lists, today: "2026-11-14", existingIds: [...CONFIG.board.order, ...CONFIG.moods.map((m) => m.id)], keywordTerms: keywordTerms([...CONFIG.moods, ...BOARD.moods]) };
const members = (eraId, change) => {
  const eras = (id) => { const d = JSON.parse(JSON.stringify(ERA.read(id))); if (id === eraId) change(d); return d; };
  const out = DC.build({ spec: DC.parse(json, { ...opts, eras }), index: { films, directors: { options: [] }, lists: [] }, recordOf: rec });
  return new Set(out.catalogs.find((c) => c.id === "eras").options.find((o) => o.id === eraId).ids);
};
const { passes } = req("lib/moods");
/** The era without the country gate and without its exclusions: the two doors as they were before the country (the list, and the directors in the years). */
const noGate = (eraId) => {
  const era = ERA.prepare(ERA.read(eraId)), where = { years: era.years, directorsAny: era.directors };
  return new Set(films.filter((e) => e.eligible && ((era.listed(e.tt) && ERA.within(e.year, era.years)) || (rec(e.tt) && passes({ film: rec(e.tt), lbYear: e.year, lb: e.lbRating, lists: Object.keys(e.lists) }, where)))).map((e) => e.tt));
};
const plant = process.argv.includes("--plantar");
if (process.argv.includes("--paises")) {
  const rows = [];
  for (const id of ERA.ids()) {
    const d = ERA.read(id);
    if (d.type !== "school") continue;
    const gated = members(id, (x) => { x.exclude = []; }), open_ = noGate(id), byTt = new Map(films.map((f) => [f.tt, f]));
    for (const tt of open_) if (!gated.has(tt)) { const f = byTt.get(tt); rows.push(`${id}\t${f.name}\t${f.year}\t${CO.mainCountry(rec(tt)) || "?"}`); }
  }
  console.log("era\tfilm\tyear\tmain country (the one that takes it out)\n" + rows.sort().join("\n"));
  console.log(`${rows.length} films`);
  process.exit(0);
}
const knownTt = new Set(films.map((f) => f.tt));
for (const f of fs.readdirSync(path.join(root, "research", "2026-11-15-curadoria"))) {
  const snap = JSON.parse(fs.readFileSync(path.join(root, "research", "2026-11-15-curadoria", f), "utf8"));
  for (const x of [...snap.films, ...snap.exclusionsOfCuration]) if (x.imdb) knownTt.add(x.imdb);
}
for (const id of ERA.ids()) { const d = ERA.read(id); for (const x of [...d.films, ...((d.school && d.school.candidates) || [])]) knownTt.add(x.imdb); }
let findings = 0, checked = 0;
for (const id of ERA.ids()) {
  const data = ERA.read(id);
  if (plant && data.type === "school" && id === ERA.ids().find((x) => ERA.read(x).type === "school")) data.exclude.push({ imdb: "tt0000000", title: "Planted (no film has this id)", why: "planted by the script to show that it accuses an exclusion with no object" });
  if (!data.exclude.length) continue;
  const written = members(id, () => {}), unwritten = members(id, (d) => { d.exclude = []; }), nogate = noGate(id); // (the planted one is only in `data`, not in the file: `written` cannot hold it, so it is judged by `nogate`)
  for (const x of data.exclude) {
    const row = [written.has(x.imdb) ? "IN" : "out", unwritten.has(x.imdb) ? "IN" : "out", nogate.has(x.imdb) ? "in" : "OUT"];
    const known = knownTt.has(x.imdb);
    const ok = row[0] === "out" && known;
    checked++; if (!ok) findings++;
    const meaning = !ok ? (row[0] === "IN" ? "does not hold: the film is still a member" : "the id is not a film this repository knows (a typo?)") : row[1] === "IN" ? "changes the membership" : row[2] === "in" ? "redundant: the country already leaves it out" : "defensive: no door brings this film today";
    console.log(`${ok ? "ok     " : "FINDING"} ${id.padEnd(20)} ${x.title} (${x.imdb})  written ${row[0]} | unwritten ${row[1]} | no gate ${row[2]}  — ${meaning}`);
  }
}
console.log(`${checked} exclusions, ${findings} finding(s)`);
process.exit(findings ? 1 : 0);
