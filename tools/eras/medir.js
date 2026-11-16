// Membership of the eras of the Discover in the index of today: it reimplements nothing, it calls DC.parse() and DC.build() of the checkout over a public index-v2.json and the
// TMDB records of cache/tmdb.json (a film is joined by tmdb.movie[id].v.imdb), as the nightly build does with its own records.
// usage: node tools/eras/medir.js <root of the checkout> <data/discover-catalogs.json or another file> <index-v2.json> <output.json>
// The output has, for every option "e-..." of Decades & eras: label, all (the ids), shown (not seen and not held by the music rule), and the films (tt, name, year, lb, seen, shows, dirs).
// MEDIR_SHORT_MIN=0 turns the short rule of the director door off (to measure what else changed); without it the minimum is the config's shortRow.minMinutes.
// Light on the machine: run it as `taskpolicy -b nice -n 19 node tools/eras/medir.js ...`.
const fs = require("fs"), path = require("path");
const [root, specFile, indexFile, outFile] = process.argv.slice(2).map((a) => path.resolve(a)); // a relative path (`.`) is resolved against the working directory: `require` would take it for a module
const req = (p) => require(path.join(root, p));
const DC = req("lib/discover-catalogs"), CO = req("lib/countries"), DR = req("lib/directors");
const CONFIG = req("config.json");
const { keywordTerms } = req("lib/index-export");
const BOARD = req("lib/board").parse(CONFIG, "config.json board");
CO.setDirectors(DR.citizenshipMap(DR.load(path.join(root, "cache", "directors.json"))));
const spec = DC.parse(JSON.parse(fs.readFileSync(specFile, "utf8")), { lists: CONFIG.lists, today: "2026-11-14", existingIds: [...CONFIG.board.order, ...CONFIG.moods.map((m) => m.id)], keywordTerms: keywordTerms([...CONFIG.moods, ...BOARD.moods]) });
const idx = JSON.parse(fs.readFileSync(indexFile, "utf8"));
const col = Object.fromEntries(idx.cols.map((c, i) => [c, i]));
const num = (x) => (x === "" || x == null ? undefined : Number(x));
const films = idx.films.map((r) => {
  const flags = Number(r[col.flags]) || 0;
  const lists = {}; for (const p of String(r[col.lists] || "").split(",")) if (p) lists[p.split(":")[0]] = Number(p.split(":")[1]);
  const year = num(r[col.year]);
  return { tt: r[col.tt], name: r[col.name], year, decade: year ? `${Math.floor(year / 10) * 10}s` : undefined, runtime: num(r[col.runtime]), lbRating: num(r[col.lbRating]), imdbRating: num(r[col.imdbRating]), director: r[col.director] || null,
    seen: (flags & 1) === 1, eligible: (flags & 4) === 4, musicOut: (flags & 8) === 8, lists, countries: r[col.countries] ? String(r[col.countries]).split("|") : undefined, country: r[col.country] || undefined };
});
const tmdb = JSON.parse(fs.readFileSync(path.join(root, "cache", "tmdb.json"), "utf8"));
const byImdb = new Map();
for (const e of Object.values(tmdb.movie)) if (e && e.v && e.v.imdb) { const o = byImdb.get(e.v.imdb); if (!o || (e.t || 0) > (o.t || 0)) byImdb.set(e.v.imdb, e); }
const rec = (tt) => (byImdb.get(tt) || {}).v || null;
const out = DC.build({ spec, index: { films, directors: { options: [] }, lists: [] }, recordOf: rec, minFeatureMinutes: process.env.MEDIR_SHORT_MIN !== undefined ? Number(process.env.MEDIR_SHORT_MIN) : require(path.join(root, "lib/pool")).minFeatureMinutes(CONFIG) });
const eras = out.catalogs.find((c) => c.id === "eras").options;
const byTt = new Map(films.map((f) => [f.tt, f]));
const res = {};
for (const o of eras) if (/^[ex]-/.test(o.id)) {
  const ids = o.ids || [];
  res[o.id] = { label: o.label, all: ids.length, shown: ids.filter((tt) => { const f = byTt.get(tt); return !f.seen && !f.musicOut; }).length,
    films: ids.map((tt) => { const f = byTt.get(tt); return { tt, name: f.name, year: f.year, lb: f.lbRating ?? null, seen: f.seen, shows: !f.seen && !f.musicOut, dirs: (rec(tt)?.directors || []).map((d) => d.name).join(", ") }; }) };
}
fs.writeFileSync(outFile, JSON.stringify({ built: idx.meta.builtAt, films: films.length, withRecord: films.filter((f) => rec(f.tt)).length, eras: res }, null, 1));
console.log("ok", Object.keys(res).length, "eras;", films.length, "films;", films.filter((f) => rec(f.tt)).length, "with a record");
