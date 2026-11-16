// The critics' subset of a fan list (Marco, 11/10/2026): in moviewithus/cannes-winners only the films that won the Palme d'Or (every
// form), the Grand Prix, Direction, the Jury Prize or Screenplay count as a critic's endorsement; the rest of the list stays "fan" and
// still needs the 3.5 average. lib/critic-subset.js + lib/list-signal.js signals().
const test = require("node:test");
const a = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const CS = require("../lib/critic-subset");
const LW = require("../lib/list-signal");
const Q = require("../lib/recommendation-quality");

const ROOT = path.resolve(__dirname, "..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const real = JSON.parse(fs.readFileSync(path.join(ROOT, "data/cannes-critic-prizes.json"), "utf8"));

const CRITIC = ["Direção", "Palme d'Or (1955-63 e 1975-2026)", "Prêmio do Júri", "Roteiro"];
const file = (filmes) => ({ premios_criticos: CRITIC, filmes });
const fixture = file([
  { slug: "pulp-fiction", title: "Pulp Fiction", year: 1994, prizes: { "Palme d'Or (1955-63 e 1975-2026)": [1994] } },
  { slug: "jury-film", prizes: { "Prêmio do Júri": [1999], "Atriz": [1999] } },
  { slug: "actress-only", prizes: { "Atriz": [1990] } },       // in the file with a prize that is NOT a critics' one
]);
// the list holds all of them plus a film that won nothing the file names; every film's Letterboxd average is 3.2 (under the 3.5 floor)
const films = Object.fromEntries(["pulp-fiction", "jury-film", "actress-only", "not-in-file"].map((s, i) => [s, { imdbId: `tt10${i}`, tmdbId: 10 + i, r: 3.2 }]));
const list = { id: "cw", name: "Cannes Winners (x)", trust: "fan", criticSubset: "data/x.json", criticSubsetLabel: "Cannes", items: Object.keys(films).map((slug) => ({ slug })) };
const subsets = (data = fixture) => new Map([["cw", CS.build(data, "Cannes")]]);
const run = (ratingOf = () => null, extra = {}) => {
  const sig = LW.signals({ lists: [list], films, ratingOf, overall: 3.67, subsets: subsets(), ...extra });
  return { sig, ratings: Q.index({ films, users: [] }, { vouched: LW.vouched(sig) }) };
};

test("a Cannes film with only an acting prize and a 3.2 average does not pass; with the Jury Prize and 3.2 it passes", () => {
  const { ratings } = run();
  a.equal(Q.qualifies(ratings.get("tt102")), false, "actress-only: Atriz is not a critics' prize");
  a.equal(Q.qualifies(ratings.get("tt103")), false, "in the list, in no prize of the file");
  a.equal(Q.qualifies(ratings.get("tt101")), true, "Prêmio do Júri 1999 (its Atriz prize is ignored, not an error)");
  a.equal(Q.qualifies(ratings.get("tt100")), true);
});

test("the reason of a released film names the prize: Cannes · Palme d'Or 1994", () => {
  const { ratings } = run();
  a.equal(Q.reason(ratings.get("tt100")), "Cannes · Palme d'Or 1994");
  a.equal(Q.reason(ratings.get("tt101")), "Cannes · Prêmio do Júri 1999");
  a.equal(ratings.get("tt100").cvTrust, "critic");
});

test("the agreement weight (lw) is still computed over the WHOLE list, not the endorsed subset", () => {
  // Marco rated the three films the subset leaves out at 5★ and the endorsed one at 1★: the list's weight comes from all four
  const ratingOf = (r) => ({ 10: 1, 11: 5, 12: 5, 13: 5 })[r.tmdbId] ?? null;
  const { sig } = run(ratingOf);
  const l = sig.lists[0];
  a.equal(l.n, 4);
  a.ok(l.weight > 0, `weight ${l.weight}`);
  a.ok(sig.byTt.get("tt103").lw > 0, "a film outside the subset still carries the list's weight");
  a.equal(sig.byTt.get("tt103").cv, undefined, "...but no endorsement");
});

test("the subset is checked: a slug missing from the list is warned, a file that is malformed stops", () => {
  const bad = file([...fixture.filmes, { slug: "ghost-1999", prizes: { Roteiro: [1999] } }]);
  const { sig } = run(() => null, { subsets: subsets(bad) });
  a.equal(sig.subsetWarnings.length, 1);
  a.match(sig.subsetWarnings[0], /1 of 3 critic-subset films are not in the list: ghost-1999/);
  a.ok(CS.validate(file([{ slug: "x", prizes: {} }])).length, "no prizes");
  a.ok(CS.validate(file([{ slug: "x", prizes: { Roteiro: [1999] } }, { slug: "x", prizes: { Roteiro: [1999] } }])).some((p) => /used twice/.test(p)));
  a.ok(CS.validate(file([{ slug: "x", imdb: "12", prizes: { Roteiro: [1999] } }])).some((p) => /imdb/.test(p)));
  a.ok(CS.validate({ premios_criticos: [], filmes: [] }).length >= 2);
  a.throws(() => CS.build(file([{ slug: "Bad Slug", prizes: { Roteiro: [1999] } }])), /slug missing or malformed/);
});

test("a film whose imdb in the file disagrees with Letterboxd's page is warned and NOT vouched", () => {
  const data = file([{ slug: "pulp-fiction", imdb: "tt999", prizes: { "Palme d'Or (1955-63 e 1975-2026)": [1994] } }]);
  const { sig, ratings } = run(() => null, { subsets: subsets(data) });
  a.ok(sig.subsetWarnings.some((w) => /pulp-fiction says tt999 but Letterboxd names tt100; not vouched/.test(w)));
  a.equal(Q.qualifies(ratings.get("tt100")), false);
  const ok = file([{ slug: "pulp-fiction", imdb: "tt100", prizes: { "Palme d'Or (1955-63 e 1975-2026)": [1994] } }]);
  a.equal(Q.qualifies(run(() => null, { subsets: subsets(ok) }).ratings.get("tt100")), true);
});

test("config: criticSubset only on a fan list; a configured subset that was not loaded stops instead of going fan silently", () => {
  a.throws(() => LW.validateLists([{ id: "z", name: "z", trust: "critic", criticSubset: "data/x.json" }]), /criticSubset only on a "fan" list/);
  a.throws(() => LW.validateLists([{ id: "z", name: "z", trust: "fan", criticSubset: "" }]), /criticSubset must be a file path/);
  a.throws(() => LW.signals({ lists: [list], films, overall: 3.67 }), /was not loaded/);
});

test("a whole critic list still vouches for every film (the subset is only for fan lists)", () => {
  const sig = LW.signals({ lists: [{ ...list, trust: "critic", criticSubset: undefined }], films, overall: 3.67 });
  a.equal(sig.byTt.get("tt103").cv, 1);
});

test("the real list: moviewithus/cannes-winners is fan + the Cannes file; 369 films, each with a critics' prize; the lists cache holds them", () => {
  const l = cfg.lists.find((x) => x.id === "f6ZGq");
  a.equal(l.trust, "fan");
  a.equal(l.criticSubset, "data/cannes-critic-prizes.json");
  a.deepEqual(CS.validate(real), []);
  const sub = CS.loadAll(ROOT, cfg.lists).get("f6ZGq");
  a.equal(sub.size, 369);
  a.equal(sub.get("pulp-fiction").label, "Cannes · Palme d'Or 1994");
  a.equal(sub.has("not-a-film"), false);
  const cache = path.join(ROOT, "cache/lists.json");
  if (!fs.existsSync(cache)) return;
  const items = JSON.parse(fs.readFileSync(cache, "utf8")).lists?.f6ZGq?.items || [];
  if (!items.length) return;
  const slugs = new Set(items.map(([s]) => s));
  const missing = [...sub.keys()].filter((s) => !slugs.has(s));
  a.deepEqual(missing, [], "every slug of the file is in the list as the cache read it");
  a.ok(items.length > sub.size, "the list holds films the endorsement does not cover");
});
