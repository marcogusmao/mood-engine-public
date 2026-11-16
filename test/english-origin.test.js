// node --test            (no dependencies; no cache read: the facts are written here as TMDB and Wikidata gave them, cache/tmdb.json and cache/directors.json of 14/11/2026)
// Marco, 14/11/2026 ("Database country wins when it lists only one"): a film whose original language is English and whose TMDB origin_country names ONE country is that country, before the
// director's citizenship. The director decides an English film only when the origin names several countries, or none. Every other language keeps the rule of 23/10/2026 ("Roma é do México").
// Mutations: test-support/lugares-mutacoes.js country.

const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../lib/countries");
const { passes } = require("../lib/moods");

const dirs = (o) => new Map(Object.entries(o));
const why = (film, map) => C.mainCountryWhy(film, undefined, undefined, dirs(map));
const D = (ids) => ids.map((id) => ({ id }));

test("English, one origin: the origin, not the director (Blade Runner, Gladiator, Revolutionary Road, The Hours were British until today)", () => {
  assert.deepEqual(why({ countries: ["US", "HK", "GB"], lang: "en", origin: ["US"], directors: D([578]) }, { 578: ["GB"] }), { iso: "US", from: "origin" }, "Blade Runner, Ridley Scott");
  assert.deepEqual(why({ countries: ["GB", "US"], lang: "en", origin: ["US"], directors: D([578]) }, { 578: ["GB"] }), { iso: "US", from: "origin" }, "Gladiator");
  assert.deepEqual(why({ countries: ["GB", "US"], lang: "en", origin: ["US"], directors: D([39]) }, { 39: ["GB"] }), { iso: "US", from: "origin" }, "Revolutionary Road, Sam Mendes");
  // and the other way: an origin of GB alone is British whatever the American director
  assert.deepEqual(why({ countries: ["GB", "US"], lang: "en", origin: ["GB"], directors: D([240]) }, { 240: ["US"] }), { iso: "GB", from: "origin" }, "Dr. Strangelove, Kubrick");
});

test("English, one origin that is NOT a producer: the director, as before (Marco, 15/11/2026: \"Only when that country is one of the producers\")", () => {
  assert.deepEqual(why({ countries: ["DE"], lang: "en", origin: ["GB"], directors: D([6111]) }, { 6111: ["DE"] }), { iso: "DE", from: "director" }, "Little Dieter Needs to Fly, Herzog");
  assert.deepEqual(why({ countries: ["GB"], lang: "en", origin: ["US"], directors: D([1]) }, { 1: ["GB"] }), { iso: "GB", from: "director" }, "McCullin");
  // and one that keeps changing: the origin is a producer
  assert.deepEqual(why({ countries: ["NZ", "US"], lang: "en", origin: ["US"], directors: D([108]) }, { 108: ["NZ"] }), { iso: "US", from: "origin" }, "The Return of the King, Peter Jackson: US, a producer");
});

test("English, several origins or none: the director as before (a producer of her country)", () => {
  assert.deepEqual(why({ countries: ["GB", "US"], lang: "en", origin: ["GB", "US"], directors: D([578]) }, { 578: ["GB"] }), { iso: "GB", from: "director" });
  assert.deepEqual(why({ countries: ["GB", "US"], lang: "en", origin: [], directors: D([578]) }, { 578: ["GB"] }), { iso: "GB", from: "director" });
  assert.deepEqual(why({ countries: ["GB", "US"], lang: "en", directors: D([578]) }, { 578: ["GB"] }), { iso: "GB", from: "director" }, "a record with no origin field");
});

test("another language: nothing changes, the director first (Roma is Mexican, Amour Austrian)", () => {
  assert.deepEqual(why({ countries: ["GB", "US"], lang: "es", origin: ["US"], directors: D([11218]) }, { 11218: ["MX"] }), { iso: "MX", from: "director" }, "Roma");
  assert.deepEqual(why({ countries: ["FR", "DE", "AT"], lang: "fr", origin: ["FR"], directors: D([6011]) }, { 6011: ["AT"] }), { iso: "AT", from: "director" }, "Amour");
});

test("the Board's regions read the same answer: Blade Runner leaves British and Irish cinema, Dr. Strangelove enters it", () => {
  const prev = C.setDirectors(dirs({ 578: ["GB"], 240: ["US"] }));
  try {
    assert.equal(passes({ film: { countries: ["US", "HK", "GB"], lang: "en", origin: ["US"], directors: D([578]) } }, { region: "british" }), false);
    assert.equal(passes({ film: { countries: ["GB", "US"], lang: "en", origin: ["GB"], directors: D([240]) } }, { region: "british" }), true);
  } finally { C.setDirectors(prev); }
});
