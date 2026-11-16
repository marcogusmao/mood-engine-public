// The filters (decade, runtime, country, rating), each alone and together, and what each catalog shows in which order.
// Expected lists are worked out by hand from fixture.js (ranks: Seven Samurai 2.2 > The Killing 2.0 > Ikiru 1.9 > Rashomon 1.8 > …).

import test from "node:test";
import assert from "node:assert/strict";
import { ratingOf, RUNTIME_BUCKETS, RATING_BUCKETS, compileFilters } from "../src/filters.js";
import { select, page, PAGE, SEEN_OK, eligibleTest, rulesOf, DEFAULT_RULES } from "../src/catalogs.js";
import { parseExtras } from "../src/extras.js";
import { makeIndex, makeObject, readyOf, names } from "./fixture.js";

const ix = makeIndex();
const run = (id, q) => names(select(ix, id, parseExtras(q)).entries);

// ── each filter alone ─────────────────────────────────────────────────────────

test("decade: only that decade, best rank first; a decade nobody has, or one that is not a menu entry, is empty (never 'everything')", () => {
  assert.deepEqual(run("explore", "decade=1950s"), ["Seven Samurai", "The Killing", "Ikiru", "Rashomon", "Wild Strawberries", "Paths of Glory", "Nights of Cabiria", "Killer's Kiss", "A Night to Remember"]);
  assert.deepEqual(run("explore", "decade=1920s"), []);
  assert.deepEqual(run("explore", "decade=1890s"), [], "the menu of an older install asking for an entry that is gone");
});

test("runtime: the four buckets of the static cuts; a short (12 min) is in none of them and a film with no runtime is in none", () => {
  assert.deepEqual(run("explore", "runtime=Under%2090%20min"), ["The Killing", "Rashomon", "Paths of Glory", "Killer's Kiss"]);
  assert.deepEqual(run("explore", "runtime=90%E2%80%93120%20min"), ["Wild Strawberries", "Nights of Cabiria", "Pierrot le Fou", "Breathless", "Reservoir Dogs", "Rescued By A Friend", "Only TMDB Votes"]);
  assert.deepEqual(run("explore", "runtime=120%E2%80%93150%20min"), ["Ikiru", "8½", "Amélie", "Night on Earth", "Wild at Heart", "The Killing of a Sacred Deer", "A Night to Remember"]);
  assert.deepEqual(run("explore", "runtime=Over%20150%20min"), ["Seven Samurai", "Stalker", "Pulp Fiction"]);
  const all = ["Under 90 min", "90–120 min", "120–150 min", "Over 150 min"].flatMap((l) => run("explore", `runtime=${encodeURIComponent(l)}`));
  assert.ok(!all.includes("A Very Short Film") && !all.includes("No Facts At All"));
  assert.equal(new Set(all).size, all.length, "no film in two buckets");
});

test("country: any of the film's countries counts (Night on Earth is American and French); a country outside the menu still filters", () => {
  assert.deepEqual(run("explore", "country=France"), ["Pierrot le Fou", "Breathless", "Amélie", "A Very Short Film", "Night on Earth"]);
  assert.deepEqual(run("explore", "country=Japan"), ["Seven Samurai", "Ikiru", "Rashomon"]);
  assert.deepEqual(run("explore", "country=Soviet%20Union"), ["Stalker"]);
  assert.deepEqual(run("explore", "country=Atlantis"), []);
});

test("rating: Letterboxd's average, or TMDB's vote ÷ 2 when it has none (Only TMDB Votes: 7.6 → 3.8); a film with neither is in no bucket", () => {
  assert.deepEqual(run("explore", "rating=4.2%2B"), ["Seven Samurai", "The Killing", "Ikiru", "Rashomon", "Stalker", "Wild Strawberries", "Paths of Glory", "Nights of Cabiria", "8½", "Pulp Fiction", "A Very Short Film"]);
  assert.deepEqual(run("explore", "rating=4.0%E2%80%934.2"), ["Pierrot le Fou", "Amélie", "Reservoir Dogs"]);
  assert.deepEqual(run("explore", "rating=3.8%E2%80%934.0"), ["Breathless", "Night on Earth", "A Night to Remember", "Only TMDB Votes"]);
  assert.deepEqual(run("explore", "rating=Under%203.8"), ["Killer's Kiss", "Wild at Heart", "The Killing of a Sacred Deer", "Rescued By A Friend"], "the low band holds the films of that band that the rule lets in: not Just Below The Floor (3.49, nobody's rating), not Low TMDB Only (2.5★ by its TMDB vote, which the rule never reads)");
  const e = ix.films.find((f) => f.name === "No Facts At All");
  assert.equal(ratingOf(e), null);
  assert.equal(ratingOf(ix.films.find((f) => f.name === "Only TMDB Votes")), 3.8);
});

test("the bucket edges are the static cuts' edges: 89/90/120/121/150/151 minutes, 4.2/4.0/3.8 stars", () => {
  const rt = (m) => RUNTIME_BUCKETS.filter(([, f]) => f(m)).map(([l]) => l);
  assert.deepEqual([89, 90, 120, 121, 150, 151].map(rt), [["Under 90 min"], ["90–120 min"], ["90–120 min"], ["120–150 min"], ["120–150 min"], ["Over 150 min"]]);
  const rate = (v) => RATING_BUCKETS.filter(([, f]) => f(v)).map(([l]) => l);
  assert.deepEqual([4.5, 4.2, 4.19, 4.0, 3.99, 3.8, 3.79].map(rate), [["4.2+"], ["4.2+"], ["4.0–4.2"], ["4.0–4.2"], ["3.8–4.0"], ["3.8–4.0"], ["Under 3.8"]]);
});

// ── together ──────────────────────────────────────────────────────────────────

test("filters combine with AND, and the order they arrive in changes nothing", () => {
  const want = ["The Killing", "Rashomon", "Paths of Glory"];
  const orders = [
    "decade=1950s&runtime=Under%2090%20min&rating=4.2%2B", "rating=4.2%2B&runtime=Under%2090%20min&decade=1950s", "runtime=Under%2090%20min&rating=4.2%2B&decade=1950s",
    "decade=1950s&rating=4.2%2B&runtime=Under%2090%20min&skip=0", "skip=0&rating=4.2%2B&decade=1950s&runtime=Under%2090%20min",
  ];
  for (const q of orders) assert.deepEqual(run("explore", q), want, q);
  assert.deepEqual(run("explore", "country=France&decade=1990s"), ["A Very Short Film", "Night on Earth"]);
  assert.deepEqual(run("explore", "decade=1950s&country=Japan"), ["Seven Samurai", "Ikiru", "Rashomon"]);
  assert.deepEqual(run("explore", "decade=1950s&country=Japan&runtime=Over%20150%20min&rating=4.2%2B"), ["Seven Samurai"]);
  assert.deepEqual(run("explore", "decade=1990s&country=Japan"), []);
});

// ── each catalog ──────────────────────────────────────────────────────────────

test("moods: the mood's own rank, at most two films by the same director (three Kubricks fit Nocturnal; the third is held back), then the menus on top", () => {
  assert.deepEqual(run("moods", "genre=Nocturnal"), ["Stalker", "The Killing", "Nights of Cabiria", "Wild at Heart", "Paths of Glory", "Pulp Fiction", "Night on Earth", "Breathless", "A Night to Remember", "Rescued By A Friend"]);
  assert.ok(!run("moods", "genre=Nocturnal").includes("Seen But Nocturnal"), "a film you have seen that fits the mood — and ranks first in it — is not shown");
  assert.ok(!run("moods", "genre=Nocturnal&decade=1990s").includes("Seen But Nocturnal"));
  assert.deepEqual(run("moods", "genre=Nocturnal&decade=1990s"), ["Wild at Heart", "Pulp Fiction", "Night on Earth"]);
  assert.deepEqual(run("moods", "decade=1990s&genre=Nocturnal"), run("moods", "genre=Nocturnal&decade=1990s"));
  assert.deepEqual(run("moods", "genre=Nocturnal&decade=1950s&country=United%20States"), ["The Killing", "Paths of Glory"], "the director cap applies after the filters");
  assert.deepEqual(run("moods", "genre=Uplift"), ["Amélie"]);
  assert.deepEqual(run("moods", "genre=nocturnal"), run("moods", "genre=Nocturnal"), "another case is the same option");
  assert.deepEqual(run("moods", "genre=Nowhere"), []);
  assert.deepEqual(run("moods", ""), [], "genre is the required menu: without it there is nothing to show");
});

test("lists: the curator's order, seen films included (Lists is exempt); Lists (unseen) is the same without them", () => {
  assert.deepEqual(run("lists", "genre=Cannes%20Winners%20(moviewithus)"), ["Rashomon", "Palme Winner You Saw", "Pulp Fiction", "Wild Strawberries"]);
  assert.deepEqual(run("lists-unseen", "genre=Cannes%20Winners%20(moviewithus)"), ["Rashomon", "Pulp Fiction", "Wild Strawberries"]);
  const crit = "genre=All-time%20Criterion%20Closet%20Picks%20(closetpicks)";
  assert.deepEqual(run("lists", crit), ["Rashomon", "Breathless", "Pierrot le Fou", "Ikiru", "The Killing", "Seven Samurai", "Wild Strawberries", "Seen But Nocturnal", "Paths of Glory", "Just Below The Floor"]);
  assert.deepEqual(run("lists-unseen", crit), ["Rashomon", "Breathless", "Pierrot le Fou", "Ikiru", "The Killing", "Seven Samurai", "Wild Strawberries", "Paths of Glory", "Just Below The Floor"], "the seen film in the list (#8) is the only difference; the floor does not apply to lists");
  assert.deepEqual(run("lists", "genre=All-time%20Criterion%20Closet%20Picks%20(closetpicks)&country=Japan"), ["Rashomon", "Ikiru", "Seven Samurai"], "the order is the list's, not the rank's");
  assert.deepEqual(run("lists", "decade=1990s&genre=Cannes%20Winners%20(moviewithus)"), ["Palme Winner You Saw", "Pulp Fiction"]);
  assert.deepEqual(run("lists-unseen", "decade=1990s&genre=Cannes%20Winners%20(moviewithus)"), ["Pulp Fiction"]);
  assert.deepEqual([...SEEN_OK].sort(), ["lists", "oldfriends"]);
});

// Marco, 22/10/2026 ~04:05 UTC: the menu entry of a list is its short name; the full name still opens it. Defect guarded: select() matching the full label only (a short-name request found no list and
// answered an empty page), or the short only (every install made before, and the profiles that cannot be reinstalled at once, went empty).
test("lists: the short name of the menu and the full name of the older installs open the same list, in Lists and in Lists (unseen), with the menus on top; a name that is neither is an empty page", () => {
  for (const id of ["lists", "lists-unseen"]) {
    assert.deepEqual(run(id, "genre=Cannes%20Winners"), run(id, "genre=Cannes%20Winners%20(moviewithus)"), `${id}: Cannes`);
    assert.deepEqual(run(id, "genre=Closet%20Picks%20%C2%B7%20all-time"), run(id, "genre=All-time%20Criterion%20Closet%20Picks%20(closetpicks)"), `${id}: Closet Picks`);
    assert.deepEqual(run(id, "decade=1990s&genre=Cannes%20Winners"), run(id, "decade=1990s&genre=Cannes%20Winners%20(moviewithus)"), `${id}: with a menu on top`);
    assert.deepEqual(run(id, "genre=Cannes"), [], `${id}: a prefix of the name is no list`);
  }
  assert.deepEqual(run("lists", "genre=Cannes%20Winners"), ["Rashomon", "Palme Winner You Saw", "Pulp Fiction", "Wild Strawberries"]);
  assert.deepEqual(run("lists-unseen", "genre=Cannes%20Winners"), ["Rashomon", "Pulp Fiction", "Wild Strawberries"]);
  assert.equal(select(ix, "lists", parseExtras("genre=Cannes%20Winners")).context.list.label, "Cannes Winners (moviewithus)", "the context keeps the full name, with the author (since description v3, 20/10/2026, no card prints it; the rebase of 22/10/2026 left the assertion as it was)");
});

test("friends: the option as the build ordered it, minus anything seen, with the menus on top", () => {
  assert.deepEqual(run("friends", "genre=Top%20%C2%B7%20Gustavo"), ["Pulp Fiction", "The Killing", "Rashomon", "Just Below The Floor"], "Friends does not apply the 3.5 floor");
  assert.deepEqual(run("friends", "genre=Watch%20together%20%C2%B7%20William"), ["Amélie", "8½"], "the seen film in the middle is dropped");
  assert.deepEqual(run("friends", "genre=Watch%20together%20%C2%B7%20William&decade=1960s"), ["8½"]);
  assert.deepEqual(run("friends", "genre=Top%20%C2%B7%20Nobody"), []);
});

test("explore: every unseen film, best rank first; a film you have seen is never in it", () => {
  const all = run("explore", "");
  assert.deepEqual(all.slice(0, 4), ["Seven Samurai", "The Killing", "Ikiru", "Rashomon"]);
  assert.equal(all.length, ix.films.filter((f) => !f.seen && f.eligible).length, "unseen and eligible");
  assert.ok(!all.includes("Just Below The Floor"));
  assert.ok(!all.includes("Palme Winner You Saw") && !all.includes("Old Friend You Saw"));
  assert.equal(all.at(-1), "Anora", "the lowest rank is last (No Facts At All, which has none, is not eligible and is not here)");
});

test("Board rows: the index's order; a seen film is dropped from every row except Old friends", () => {
  assert.deepEqual(run("tonight", ""), ["The Killing", "Amélie", "Just Below The Floor"], "tt0000020 is seen and sits in the row: it must not be served; the 3.5 floor does not apply to Board rows (the build filtered them)");
  assert.deepEqual(run("oldfriends", ""), ["Old Friend You Saw"]);
  assert.equal(select(ix, "no-such-row", {}), null);
});

test("compileFilters: a request with no menus is not 'active'; one with a menu value that is not an option is 'none'", () => {
  assert.equal(compileFilters({}, ix.meta).active, false);
  assert.equal(compileFilters({ decade: "1990s" }, ix.meta).active, true);
  assert.equal(compileFilters({ decade: "nope" }, ix.meta).none, true);
  assert.equal(compileFilters({ runtime: "forever" }, ix.meta).none, true);
  assert.equal(compileFilters({ rating: "10+" }, ix.meta).none, true);
});

// ── the recommendation rule (Marco, 10/10/2026): Letterboxd average ≥ 3.5 OR a configured friend's own rating ≥ 3.5 ──────────

test("eligible: the build's flag decides — an average of 3.49 and no friend out, 3.5 in, no average and no friend out (TMDB never stands in), no average but a friend's 4★ in, an average of 3.2 rescued by a friend in; Explore, Search and Moods all use it, with the menus on top", () => {
  const ex = run("explore", "");
  assert.ok(!ex.includes("Just Below The Floor"), "3.49 and nobody's rating: out");
  assert.ok(ex.includes("Killer's Kiss"), "3.5 exactly: in");
  assert.ok(!ex.includes("No Facts At All") && !ex.includes("Low TMDB Only"), "no Letterboxd average and no friend's rating: out, whatever TMDB says");
  assert.ok(ex.includes("Only TMDB Votes") && ex.includes("Rescued By A Friend"), "a configured friend's rating lets a film in: with no average, or under 3.5");
  assert.ok(!ix.films.find((f) => f.name === "Low TMDB Only").eligible && ix.films.find((f) => f.name === "Low TMDB Only").tmdbRating === 5, "(its TMDB vote is not what the rule reads)");
  // the film is in the index, in the night mood, in 1972, from Sweden: it is the rule alone that keeps it out of each of these
  assert.deepEqual(run("moods", "genre=Nocturnal&decade=1970s"), ["Stalker", "Rescued By A Friend"]);
  assert.deepEqual(run("search", "search=just+below"), []);
  assert.deepEqual(run("search", "search=floor+tester"), []);
  assert.deepEqual(run("search", "search=sweden+1970s"), ["Rescued By A Friend"]);
  assert.deepEqual(run("search", "search=rescue+tester"), ["Rescued By A Friend"]);
  assert.deepEqual(run("explore", "decade=1970s"), ["Stalker", "Rescued By A Friend"]);
  assert.deepEqual(run("explore", "decade=1970s&country=Sweden"), ["Rescued By A Friend"], "in combination with the cuts too");
  assert.deepEqual(run("explore", "country=Sweden&runtime=90%E2%80%93120%20min&decade=1970s&rating=Under%203.8"), ["Rescued By A Friend"], "the rating menu is not exempt: the low band shows the eligible films of it only");
  assert.deepEqual(run("explore", "decade=1970s&country=Sweden&rating=3.8%E2%80%934.0"), []);
  assert.deepEqual(run("search", "search=kubrick+under+80+min"), ["Killer's Kiss"], "3.5 exactly, found by search");
});

test("eligible: Board rows, Lists, Lists (unseen) and Friends do not apply it (the build filtered the rows; the others are direct collections)", () => {
  assert.ok(run("tonight", "").includes("Just Below The Floor"));
  assert.ok(run("lists", "genre=All-time%20Criterion%20Closet%20Picks%20(closetpicks)").includes("Just Below The Floor"));
  assert.ok(run("lists-unseen", "genre=All-time%20Criterion%20Closet%20Picks%20(closetpicks)").includes("Just Below The Floor"));
  assert.ok(run("lists-unseen", "genre=All-time%20Criterion%20Closet%20Picks%20(closetpicks)&decade=1970s&country=Sweden").includes("Just Below The Floor"), "with the menus on top as well");
  assert.ok(run("friends", "genre=Top%20%C2%B7%20Gustavo&decade=1970s").includes("Just Below The Floor"));
  assert.equal(eligibleTest(ix, "lists"), null);
  assert.equal(eligibleTest(ix, "lists-unseen"), null);
  assert.equal(eligibleTest(ix, "friends"), null);
  for (const row of Object.keys(ix.rows)) assert.equal(eligibleTest(ix, row), null, `Board row ${row} is exempt`);
  for (const id of ["moods", "explore", "search"]) assert.equal(typeof eligibleTest(ix, id), "function", id);
});

test("eligible: the flag is the rule — the Worker does not recompute it from the numbers: a film with an average of 4.5 that the build did not flag is out; one with an average of 2.0 that it flagged is in", () => {
  const o = makeObject();
  o.films.find((f) => f.name === "Seven Samurai").eligible = undefined;
  delete o.films.find((f) => f.name === "Seven Samurai").eligible;
  const low = o.films.find((f) => f.name === "Killer's Kiss");
  low.lbRating = 2.0; low.eligible = true;
  const odd = readyOf(o);
  const names2 = (id, q) => names(select(odd, id, parseExtras(q)).entries);
  assert.ok(!names2("explore", "").includes("Seven Samurai"));
  assert.ok(names2("explore", "").includes("Killer's Kiss"));
  assert.ok(names2("lists", "genre=All-time%20Criterion%20Closet%20Picks%20(closetpicks)").includes("Seven Samurai"), "Lists is exempt: still there");
  assert.ok(!names2("search", "search=samurai").includes("Seven Samurai"));
});

test("eligible: filtering keeps the order of the survivors and fills no gap: a page is the first hundred ELIGIBLE films in the catalog's own order, and skip counts eligible films", () => {
  const o = bigObject(250);
  o.films.forEach((f, i) => { if (i % 3 === 0) f.eligible = false; else f.eligible = true; });
  const big = readyOf(o);
  const survivors = o.films.filter((f) => f.eligible).map((f) => f.name);
  assert.equal(survivors.length, 166);
  const p1 = page(big, "explore", {}), p2 = page(big, "explore", { skip: "100" });
  assert.deepEqual(p1.entries.map((e) => e.name), survivors.slice(0, 100));
  assert.deepEqual(p2.entries.map((e) => e.name), survivors.slice(100));
  assert.equal(p1.total, 166);
  const list = page(big, "lists", { genre: "Cannes Winners (moviewithus)" });
  assert.equal(list.total, 250, "a list is not filtered");
});

test("rulesOf: the index's rules when it has them (merged over the defaults), the defaults when it has none; the index's exempt names win", () => {
  assert.deepEqual(rulesOf(ix), { rules: DEFAULT_RULES, from: "default" });
  assert.deepEqual(DEFAULT_RULES, { rule: "letterboxd-average-or-configured-friend", minStars: 3.5, exemptCatalogs: ["lists", "lists-unseen", "friends"] });
  assert.deepEqual(rulesOf({ rules: { minStars: 3.5, exemptCatalogs: ["lists"] } }), { rules: { rule: DEFAULT_RULES.rule, minStars: 3.5, exemptCatalogs: ["lists"] }, from: "index" });
  const only = { ...ix, rules: { rule: "x", minStars: 3.5, exemptCatalogs: ["lists"] } };
  const names3 = (id, q) => names(select(only, id, parseExtras(q)).entries);
  const crit = "genre=All-time%20Criterion%20Closet%20Picks%20(closetpicks)";
  assert.ok(names3("lists", crit).includes("Just Below The Floor"), "Lists is still exempt");
  assert.ok(!names3("lists-unseen", crit).includes("Just Below The Floor"), "Lists (unseen) is not exempt in these rules");
  assert.ok(!names3("friends", "genre=Top%20%C2%B7%20Gustavo").includes("Just Below The Floor"), "nor is Friends");
  const none = { ...ix, rules: { rule: "x", minStars: 3.5, exemptCatalogs: ["lists", "lists-unseen", "friends", "explore", "moods", "search"] } };
  assert.ok(names(select(none, "explore", {}).entries).includes("Just Below The Floor"), "an index may exempt a catalog");
});

// ── paging ────────────────────────────────────────────────────────────────────

function bigObject(n) {
  const big = makeObject();
  big.films = Array.from({ length: n }, (_, i) => ({ tt: `tt${String(i + 1).padStart(7, "0")}`, name: `Film ${i + 1}`, year: 1995, decade: "1990s", runtime: 100, rank: n - i, eligible: true, lists: { cannes: i + 1 }, find: ` film ${i + 1} |  |  |  | `, desc: "d" }));
  big.rows = { tonight: [], oldfriends: [] };
  big.friends.options = [];
  return big;
}

test("paging: 100 per page, skip=100 and skip=200 continue where the page ended, the last page is short, past the end is empty; no film twice, none missed", () => {
  const big = readyOf(bigObject(250));
  const pages = [0, 100, 200, 250].map((skip) => page(big, "explore", { skip: String(skip) }));
  assert.deepEqual(pages.map((p) => p.entries.length), [100, 100, 50, 0]);
  assert.ok(pages.every((p) => p.total === 250));
  const flat = pages.flatMap((p) => p.entries.map((e) => e.tt));
  assert.equal(new Set(flat).size, 250);
  assert.deepEqual(flat, big.films.map((f) => f.tt), "in order");
  assert.equal(PAGE, 100);
  const lists = [0, 100, 200].map((skip) => page(big, "lists", { genre: "Cannes Winners (moviewithus)", skip: String(skip) }).entries.map((e) => e.name));
  assert.deepEqual(lists.map((l) => l.length), [100, 100, 50]);
  assert.equal(lists[1][0], "Film 101", "a list continues in the curator's order");
});

// Whole lists (Marco, 23/10/2026, "cada opção mostra a lista inteira do amigo"). Written against: build.js `make = () =>` ignored the cap lifted for the Worker's index, so every friends option stopped at 60 films
// (from the merge 4a40105, 11/10/2026); the Worker itself has no cap of its own, and this keeps it that way: an option of 250 films is served whole, a hundred a page, in the order the build wrote it.
test("friends: an option longer than the old 60-film cap is served whole, a hundred a page, in the build's order (not the rank's), the seen film dropped", () => {
  const o = bigObject(250);
  o.films[5].seen = true; // Film 6, in the middle of the first page
  const order = o.films.map((f) => f.tt).reverse(); // the build's order for a friend's Top: not the rank order of the index
  o.friends.options = [{ label: "Top · William", ids: order }];
  const big = readyOf(o);
  const pages = [0, 100, 200, 250].map((skip) => page(big, "friends", { genre: "Top · William", skip: String(skip) }));
  assert.deepEqual(pages.map((p) => p.entries.length), [100, 100, 49, 0], "250 films less the seen one: past the old 60 and past the first page");
  assert.ok(pages.every((p) => p.total === 249));
  const flat = pages.flatMap((p) => p.entries.map((e) => e.tt));
  assert.deepEqual(flat, order.filter((tt) => tt !== o.films[5].tt), "the option's order, no film twice, none missed");
  assert.notDeepEqual(flat.slice(0, 5), o.films.slice(0, 5).map((f) => f.tt), "the control: that is not the order of the rank");
});

test("paging: skip applies after the filters, so page 2 of a filtered view is the next hundred of the FILTERED films", () => {
  const o = bigObject(250);
  for (let i = 0; i < 250; i += 2) { o.films[i].decade = "1980s"; o.films[i].year = 1985; } // 125 films in the 80s
  const big = readyOf(o);
  const p1 = page(big, "explore", { decade: "1980s" }), p2 = page(big, "explore", { decade: "1980s", skip: "100" });
  assert.deepEqual([p1.entries.length, p2.entries.length, p1.total], [100, 25, 125]);
  assert.ok(p1.entries.concat(p2.entries).every((e) => e.decade === "1980s"));
});
