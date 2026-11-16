// node --test            (no dependencies; reads config.json, no cache)
// The session's choice of 14/11/2026 (not asked of Marco; measured by the audit of the Stremio project, docs/research/2026-11-14-auditoria-dados.md 1e): a mood's POSITIVE keyword matches a TMDB
// keyword that IS the term, or a compound the recipe itself names. Until then it matched as a whole word INSIDE any compound: "travel" took "time travel" (72 films), "party" took
// "nsdap (nazi party)", "night" took "one-night stand". A NEGATIVE term matches as before (the review of 14/11/2026: whole negatives lost "holocaust (shoah)" and "suicide attempt").
// Keywords are compared trimmed, inner spaces joined, lower case (TMDB stores "simulated reality " on The Matrix). Mutations: test-support/lugares-mutacoes.js keywords.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { compile, fit } = require("../lib/moods");
const { allowlist } = require("../lib/index-export");

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));
const mood = (keywords, o = {}) => compile([{ id: "x", name: "X", word: "X", genres: {}, keywords, minFit: 2, ...o }])[0];
const film = (keywords, o = {}) => ({ id: 1, imdb: "tt1", title: "F", genres: [], keywords, directors: [], countries: [], ...o });

test("a positive term matches the whole keyword, not a word inside a compound the recipe does not name", () => {
  const m = mood({ travel: 2.5, party: 2.5, night: 2.5 });
  for (const k of ["time travel", "space travel", "travel agent", "nsdap (nazi party)", "birthday party", "one-night stand", "one night", "night watchman", "midnight"]) {
    assert.equal(fit(film([k]), m).ok, false, `"${k}"`);
    assert.equal(fit(film([k]), m).fit, 0, `"${k}" adds nothing`);
  }
  for (const k of ["travel", "party", "night"]) assert.equal(fit(film([k]), m).ok, true, `control: "${k}" itself fits`);
});

test("a negative term still matches a whole word inside any keyword: \"holocaust (shoah)\" and \"suicide attempt\" push the film away as before", () => {
  const m = mood({ holocaust: -3, suicide: -1.2 }, { genres: { Comedy: 2.5 } });
  assert.equal(fit(film(["holocaust (shoah)"], { genres: ["Comedy"] }), m).fit, -0.5);
  assert.equal(fit(film(["suicide attempt"], { genres: ["Comedy"] }), m).fit, 1.3);
  assert.equal(fit(film(["suicide attempt"], { genres: ["Comedy"] }), m).ok, false, "City Lights, The Kid, Rango … do not enter lol by losing their penalty");
  assert.equal(fit(film(["comedy"], { genres: ["Comedy"] }), m).fit, 2.5, "control");
});

test("keywords are compared trimmed, with inner spaces joined, in lower case", () => {
  assert.equal(fit(film(["simulated reality "]), mood({ "simulated reality": 2.5 })).ok, true, "The Matrix's keyword as TMDB stores it");
  assert.equal(fit(film(["film  noir"]), mood({ "film noir": 2.5 })).ok, true);
  assert.equal(fit(film(["Neo-Noir"]), mood({ "neo-noir": 2.5 })).ok, true);
  assert.equal(fit(film([" Simulated  Reality "]), mood({ "simulated reality": -3, z: 0 })).fit, -3, "a negative term too");
});

test("a compound the recipe names (a term or a compoundKeywords entry) still lets its root term match inside it, once", () => {
  const m = mood({ noir: 2 }, { compoundKeywords: ["film noir", "japanese noir"] });
  assert.equal(fit(film(["film noir"]), m).fit, 2);
  assert.equal(fit(film(["film noir", "japanese noir"]), m).fit, 2, "two named compounds of one root count once, as \"noir\" inside them did");
  assert.equal(fit(film(["tech noir"]), m).fit, 0, "a compound nobody named does not");
  const n = mood({ chase: 0.8, "police chase": 1 });
  assert.equal(fit(film(["police chase"]), n).fit, 0.8, "the root matches inside a compound that is itself a term, and the dedup keeps the first: the score of before");
});

test("Noir: \"noir\" is marked insideKeywords and matches inside any keyword, as before (Marco, 15/11/2026: \"Everything with \"noir\" in the tag, as before\"); the family scores once", () => {
  const noir = cfg.moods.find((m) => m.id === "noir");
  assert.ok(noir.insideKeywords && typeof noir.insideKeywords.noir === "string" && noir.insideKeywords.noir.length > 20, "the mark, with its reason beside it");
  const marked = cfg.moods.flatMap((m) => Object.keys(m.insideKeywords || {}).filter((t) => (m.keywords || {})[t] > 0).map((t) => `${m.id}:${t}`));
  assert.deepEqual(marked, ["noir:noir"], "the only positive term so marked");
  const [m] = compile([noir]);
  for (const k of ["tech noir", "future noir", "horror noir", "neo-noir", "film noir"]) assert.equal(fit(film([k], { genres: ["Crime"] }), m).ok, true, k);
  assert.equal(fit(film(["film noir", "japanese noir", "tech noir"]), m).fit, fit(film(["film noir"]), m).fit, "three noir keywords count once");
  const night = compile([cfg.moods.find((x) => x.id === "night")])[0];
  assert.equal(fit(film(["one-night stand"]), night).fit, fit(film([]), night).fit, "another mood's term is not marked: Night drive's \"night\" does not take \"one-night stand\"");
});

test("the moods name their compounds (Marco, 15/11/2026: \"write out the longer tags that belong, mood by mood\"), and those never enter the index's search words", () => {
  const byId = Object.fromEntries(cfg.moods.map((m) => [m.id, m]));
  assert.ok(byId.letin.compoundKeywords.includes("loss of loved one"));
  for (const k of ["female friendship", "male friendship"]) assert.ok(byId.lift.compoundKeywords.includes(k), k);
  assert.ok(byId.reinvent.compoundKeywords.includes("life and career"));
  for (const [id, k] of [["wander", "time travel"], ["escape", "nsdap (nazi party)"], ["night", "one-night stand"], ["letin", "memory loss"]]) assert.ok(!(byId[id].compoundKeywords || []).includes(k), `${id} must not name ${k}`);
  const [lift] = compile([byId.lift]);
  assert.equal(fit(film(["female friendship"]), lift).fit, fit(film(["friendship"]), lift).fit, "a compound scores its term's weight");
  assert.equal(fit(film(["female friendship", "male friendship", "friendship"]), lift).fit, fit(film(["friendship"]), lift).fit, "a family once");
  // the index's search words (lib/index-export.js allowlist) are exactly the positive terms of the recipes: the compounds add none and move none
  const words = allowlist(cfg.moods).map((t) => t.term).sort();
  const terms = [...new Set(cfg.moods.flatMap((m) => Object.entries(m.keywords || {}).filter(([, w]) => w > 0).map(([t]) => t)))].sort();
  assert.deepEqual(words, terms);
});

// The compounds whose term means something else in one mood (research/2026-11-15-compostas-dos-moods.md, "Exceptions"): refused there, named everywhere else.
const SENSE_DIFFERS = { "hero's journey": ["wander", "road"], "personal journey": ["wander", "road"], "spiritual journey": ["wander", "road"], "car journey": ["reinvent"], "journey around the world": ["reinvent"], "journey on foot": ["reinvent"], "loss of job": ["letin"], "high school teacher": ["comingofage"], "passion and romance": ["reinvent"] };
test("one answer per compound in every mood (the review of 15/11/2026): a compound one mood names is named by every mood where it holds a positive term, except where the sense differs", () => {
  const { kwNorm } = require("../lib/moods");
  const named = new Set(cfg.moods.flatMap((m) => m.compoundKeywords || []));
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const missing = [];
  for (const k of named) for (const m of cfg.moods) {
    const own = Object.keys(m.keywords || {}).map(kwNorm);
    if (own.includes(k) || (m.compoundKeywords || []).includes(k) || (SENSE_DIFFERS[k] || []).includes(m.id)) continue;
    const holds = Object.entries(m.keywords || {}).some(([t, w]) => w > 0 && !(m.insideKeywords && m.insideKeywords[t]) && new RegExp(`(^|[^a-z])${esc(t)}([^a-z]|$)`).test(k));
    if (holds) missing.push(`${m.id}: ${k}`);
  }
  assert.deepEqual(missing, []);
  for (const [k, moods] of Object.entries(SENSE_DIFFERS)) for (const id of moods) assert.ok(!(cfg.moods.find((m) => m.id === id).compoundKeywords || []).includes(k), `${id} must not name ${k}`);
  for (const k of ["coney island", "long island, new york", "venice beach, california", "jeju island", "brighton beach", "moral corruption"]) assert.ok(!named.has(k), `${k} is refused in every mood`);
});

test("Noir keeps the seven films Marco kept, through \"noir\" inside their keywords", () => {
  const [noir] = compile([cfg.moods.find((m) => m.id === "noir")]);
  for (const [title, kws] of [["Blade Runner 2049", ["tech noir"]], ["Twelve Monkeys", ["future noir"]], ["The Terminator", ["tech noir"]], ["Minority Report", ["tech noir", "future noir"]], ["The Spiral Staircase", ["horror noir"]], ["Possessor", ["tech noir"]], ["Nineteen Eighty-Four", ["future noir"]]])
    assert.ok(fit(film(kws), noir).fit >= 2, `${title}: "noir" counts inside ${kws.join(", ")}`);
});

test("the index's matcher `re` is the word inside a keyword, as before (the column, the card and the search text read it)", () => {
  const t = mood({ travel: 1 })._terms[0];
  assert.equal(t.re.test("time travel"), true);
  assert.equal(t.re.test("travelogue"), false, "a whole word");
});

test("two terms of one recipe on one film (\"noir\" and \"film noir\") count once", () => {
  const m = mood({ noir: 2, "film noir": 2 });
  const r = fit(film(["noir", "film noir"]), m);
  assert.equal(r.fit, 2);
  assert.deepEqual(r.hits, ["noir"]);
});
