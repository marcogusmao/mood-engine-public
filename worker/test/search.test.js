// Text search: what Stremio's search bar sends as `search=<text>`. Ten queries with the answer worked out by hand from fixture.js.

import test from "node:test";
import assert from "node:assert/strict";
import { select } from "../src/catalogs.js";
import { makeIndex, names } from "./fixture.js";
import { C } from "../src/film.js";

const ix = makeIndex();
const q = (text) => names(select(ix, "search", { search: text }).entries); // through the catalog: the Search catalog applies the 3.5 floor

test("1. a title: the film itself first, then films whose title contains the word", () => {
  assert.deepEqual(q("killing"), ["The Killing", "The Killing of a Sacred Deer"]);
  assert.deepEqual(q("the killing"), ["The Killing", "The Killing of a Sacred Deer"], "'the' is a stop word, but the whole phrase still ranks the exact title first");
  assert.deepEqual(q("The Killing of a Sacred Deer"), ["The Killing of a Sacred Deer"], "every word must be somewhere (AND): the shorter film lacks 'sacred'");
});

test("2. a director, by surname, prefix or full name; the order is rank", () => {
  assert.deepEqual(q("kubrick"), ["The Killing", "Paths of Glory", "Killer's Kiss"]);
  assert.deepEqual(q("kubr"), ["The Killing", "Paths of Glory", "Killer's Kiss"]);
  assert.deepEqual(q("stanley kubrick"), ["The Killing", "Paths of Glory", "Killer's Kiss"]);
  assert.deepEqual(q("kurosawa"), ["Seven Samurai", "Ikiru", "Rashomon"]);
});

test("3. a director and a decade: '60s' and '1960s' are the same filter", () => {
  assert.deepEqual(q("godard 60s"), ["Pierrot le Fou", "Breathless"]);
  assert.deepEqual(q("godard 1960s"), ["Pierrot le Fou", "Breathless"]);
  assert.deepEqual(q("godard 50s"), []);
  assert.deepEqual(q("fellini 50s"), ["Nights of Cabiria"], "8½ is 1963");
});

test("3b. two-digit decades: 30s–90s are the 1930s–1990s, 00s/10s/20s the 2000s–2020s; four digits say it outright", () => {
  assert.deepEqual(q("30s"), ["M"]);
  assert.deepEqual(q("40s"), ["Casablanca"]);
  assert.deepEqual(q("20s"), ["Anora"], "the 2020s, not the 1920s");
  assert.deepEqual(q("1920s"), []);
  assert.deepEqual(q("10s"), ["The Killing of a Sacred Deer", "Only TMDB Votes"]);
  assert.deepEqual(q("00s"), ["Amélie"], "No Facts At All is from 2005 but is not eligible (no Letterboxd average, no friend's rating)");
  assert.deepEqual(q("'90s"), q("1990s"), "an apostrophe before the digits changes nothing");
  assert.deepEqual(q("1990s japanese"), []);
});

test("4. a nationality and a decade: 'japanese 1950s' = films from Japan in the 1950s", () => {
  assert.deepEqual(q("japanese 1950s"), ["Seven Samurai", "Ikiru", "Rashomon"]);
  assert.deepEqual(q("japan 50s"), ["Seven Samurai", "Ikiru", "Rashomon"]);
  assert.deepEqual(q("french 1990s"), ["A Very Short Film", "Night on Earth"]);
});

test("5. a list: a word of its name or of the curator's finds every film in it", () => {
  assert.deepEqual(q("cannes"), ["Rashomon", "Wild Strawberries", "Pulp Fiction"], "the seen film in the list is not offered");
  assert.deepEqual(q("criterion"), ["Seven Samurai", "The Killing", "Ikiru", "Rashomon", "Wild Strawberries", "Paths of Glory", "Pierrot le Fou", "Breathless"]);
  assert.deepEqual(q("closetpicks japanese"), ["Seven Samurai", "Ikiru", "Rashomon"]);
});

test("6. a mood, by its word or by a word of its name", () => {
  assert.deepEqual(q("nocturnal"), ["The Killing", "Stalker", "Paths of Glory", "Nights of Cabiria", "Pulp Fiction", "Breathless", "Night on Earth", "Killer's Kiss", "Wild at Heart", "A Night to Remember", "Rescued By A Friend"], "every film that fits the mood, all equally relevant, so by rank — with no limit of two per director (that is the Moods catalog's job)");
  assert.deepEqual(q("uplift"), ["Amélie"]);
  assert.deepEqual(q("night drive"), ["Night on Earth", "A Night to Remember", "Nights of Cabiria", "The Killing", "Stalker", "Paths of Glory", "Pulp Fiction", "Breathless", "Killer's Kiss", "Wild at Heart", "Rescued By A Friend"], "'Night drive' is the name of the Nocturnal mood; films with 'night' in the title come first");
});

test("7. a friend and what they did: 'gustavo loved' = rated 4★ or more; 'william wants' = on their watchlist; a name alone matches anything they touched", () => {
  assert.deepEqual(q("gustavo loved"), ["The Killing"]);
  assert.deepEqual(q("william wants"), ["The Killing"]);
  assert.deepEqual(q("william watched"), ["Pierrot le Fou"]);
  assert.deepEqual(q("william loved"), [], "William gave Pierrot le Fou 3.5★: not loved");
  assert.deepEqual(q("loved by gustavo 1950s"), ["The Killing"]);
  assert.deepEqual(q("gustavo"), ["The Killing"]);
  assert.deepEqual(q("william"), ["The Killing", "Pierrot le Fou"]);
});

test("8. a length: '90 min' is at most 90, 'under'/'over' say which side (strictly), a short (12 min) never counts as a feature", () => {
  assert.deepEqual(q("90 min"), ["The Killing", "Rashomon", "Paths of Glory", "Breathless", "Killer's Kiss"]);
  assert.deepEqual(q("under 90 min"), ["The Killing", "Rashomon", "Paths of Glory", "Killer's Kiss"], "less than 90: Breathless (exactly 90) is out, like the menu entry 'Under 90 min'");
  assert.deepEqual(q("under 90"), q("under 90 min"), "the unit may be left out");
  assert.deepEqual(q("over 150 min"), ["Seven Samurai", "Stalker", "Pulp Fiction"]);
  assert.deepEqual(q("kubrick under 80 min"), ["Killer's Kiss"]);
  assert.ok(!q("90 min").includes("A Very Short Film"));
});

test("9. 'short' means a feature of 95 minutes or less, or a title with the word; accents and punctuation do not matter in either direction", () => {
  const short = q("short");
  assert.equal(short[0], "A Very Short Film", "the title word beats the length");
  assert.ok(short.includes("The Killing") && short.includes("Breathless") && !short.includes("Seven Samurai"));
  assert.deepEqual(q("amelie"), ["Amélie"]);
  assert.deepEqual(q("AMÉLIE!"), ["Amélie"]);
  assert.deepEqual(q("8½"), ["8½"]);
  assert.deepEqual(q("killers kiss"), ["Killer's Kiss"], "an apostrophe is dropped, not turned into a space: typing it or not finds the same film");
  assert.deepEqual(q("killer's kiss"), ["Killer's Kiss"]);
  assert.deepEqual(q("Killer’s Kiss"), ["Killer's Kiss"], "a curly apostrophe too");
});

test("10. words combine with AND; nothing found is an empty list; films you have seen are never found; nothing typed finds nothing", () => {
  assert.deepEqual(q("wild"), ["Wild Strawberries", "Wild at Heart"]);
  assert.deepEqual(q("wild heart"), ["Wild at Heart"]);
  assert.deepEqual(q("wild kubrick"), []);
  assert.deepEqual(q("palme winner"), [], "seen");
  assert.deepEqual(q("old friend"), [], "seen");
  assert.deepEqual(q("zzzz"), []);
  for (const empty of ["", "   ", "!!!", undefined, null]) assert.deepEqual(q(empty), []);
  assert.deepEqual(q("1994"), ["Pulp Fiction"], "a year");
});

test("11. the words the moods use, and genres, are searchable (they are in the film's search text, not only in the moods)", () => {
  assert.deepEqual(q("heartwarming"), ["Amélie"]);
  assert.deepEqual(q("noir"), ["The Killing"], "a keyword");
  assert.deepEqual(q("crime"), ["The Killing", "Killer's Kiss"], "a genre");
  assert.deepEqual(q("crime kubrick"), ["The Killing", "Killer's Kiss"]);
  assert.deepEqual(q("war drama"), ["Paths of Glory"]);
});

test("search through the catalog: the same answer as search(); a menu that arrives with it is applied, not ignored", () => {
  assert.deepEqual(names(select(ix, "search", { search: "kubrick" }).entries), q("kubrick"));
  assert.deepEqual(names(select(ix, "search", { search: "kubrick", decade: "1990s" }).entries), [], "Kubrick made nothing in the 1990s");
  assert.equal(select(ix, "search", {}).entries.length, 0);
});

test("search membership matches the complete mood/list key, including a zero score and a key after another entry", () => {
  const local = makeIndex();
  local.films = [local.films.find((film) => film.name === "The Killing")]; // Neither query matches its searchable text.
  const film = local.films[0];
  for (const [column, query, cases] of [
    [C.moods, "nocturnal", [["xnight:1:2", false], ["nightmare:1:2", false], ["night:0:0", true], ["lift:1:2,night:0:0", true]]],
    [C.lists, "cannes", [["xcannes:1", false], ["cannesextra:1", false], ["cannes:1", true], ["crit:2,cannes:1", true]]],
  ]) {
    for (const [cell, present] of cases) {
      film.r[column] = cell;
      assert.deepEqual(names(select(local, "search", { search: query }).entries), present ? ["The Killing"] : [], `${query}: ${cell}`);
    }
  }
});
