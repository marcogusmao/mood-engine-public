// The shorts in the Worker (Marco, 15/11/2026, questionnaire, on where films under 40 minutes may still appear: "Only where you or a source put them (recommended)").
// The build writes bit 16 of a film's flags (`shortOut`: lib/pool.js isShort on the film's own runtime in the index, a KNOWN runtime under config.json shortRow.minMinutes, 40);
// the film stays `eligible`. The Worker serves what RECOMMENDS from `recommendable` = eligible, not held back by the music rule (bit 8) and not a short: Moods (the Music option too)
// and Explore with every menu on top, the calculated options of the Discover with and without "Include seen", and the profiles' Tonight, Under 100 min, themes and What it is.
// The shorts STAY where he or a source put them: Search (by any word), Lists, Lists (unseen), Friends, "Loved by directors", the curated options of the Discover, the Board rows
// (the build's own decision), the profiles' watchlist and curators' rows, and the ERA options of the Discover (an option the build marks `shorts: true`: an era of data/eras takes a short
// only when a source of its file lists it, so the Worker holds that option to `recommendableOrShort`, the same rule without the short bit). An index without the bit (every index built
// before 15/11/2026) behaves exactly as before.
// The world is small and invented (fixture.js, profile-fixture.js): no real film has to stay in an index for these to pass.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHandler } from "../src/handler.js";
import { createStore } from "../src/store.js";
import { select, page, eligibleTest, completeOptionPage, optionPage } from "../src/catalogs.js";
import { parseExtras } from "../src/extras.js";
import { hydrate, C } from "../src/film.js";
import { words } from "../src/text.js";
import { makeObject, readyOf, names, makeV2Object, v2FilesOf, v2ObjectFrom } from "./fixture.js";
import * as PF from "./profile-fixture.js";

const require = createRequire(import.meta.url);
const rows = require("../../lib/index-rows.js");
const pool = require("../../lib/pool.js");
const exporter = require("../../lib/index-export.js");

// ── a small index with a short and a feature beside it ───────────────────────

const MIN = 40; // config.json shortRow.minMinutes, which the index says in meta.minFeatureMinutes
const film = (tt, name, x = {}) => {
  const e = {
    tt, name, year: 2024, decade: "2020s", runtime: 100, countries: ["South Korea"], director: `Director of ${name}`, lbRating: 4.6, rank: 9, eligible: true, moods: { night: [1.9, 9] }, lists: { crit: 11 }, genres: ["Animation", "Drama"],
    keywords: ["stop motion", "dream"], desc: `${name} cast\n${name} genres.\n\nA synopsis of ${name}.`, ...x,
  };
  e.find = " " + [e.name, e.director, e.keywords.join(" "), e.genres.join(" "), e.countries.join(" ")].map(words).join(" | ");
  return e;
};
/** The build's own verdict for a film of this file: what lib/index-export.js writes (lib/pool.js isShort on the runtime). `bits: false` is an index from before the bit. */
const marked = (e, bits = true) => (bits && pool.isShort(e.runtime, MIN) ? { ...e, shortOut: true } : e);
function worldObject({ bits = true } = {}) {
  const o = makeObject();
  const short = film("tt0000101", "Twelve Minute Dream", { runtime: 12 });
  const feature = film("tt0000102", "Feature Beside It", { rank: 8.9, moods: { night: [1.9, 8.9] }, director: "Another Director" });
  const unknown = film("tt0000103", "Length Unknown", { rank: 8.8, moods: { night: [1.9, 8.8] }, director: "A Third Director", runtime: undefined });
  const edge = film("tt0000104", "Exactly Forty", { rank: 8.7, moods: { night: [1.9, 8.7] }, director: "A Fourth Director", runtime: 40 });
  delete unknown.runtime;
  o.films.push(...[short, feature, unknown, edge]);
  o.films = o.films.map((e) => marked(e, bits));
  o.films.sort((a, b) => (b.rank ?? -Infinity) - (a.rank ?? -Infinity) || a.tt.localeCompare(b.tt));
  o.meta.count = o.films.length;
  o.friends.options[0].ids.push(short.tt); // a friend's option holds the short
  o.rows.tonight = [...o.rows.tonight, short.tt]; // and so does a Board row (the build decides its own rows: here it is hand-made)
  return o;
}
const ix = readyOf(worldObject());
const old = readyOf(worldObject({ bits: false }));
const answer = (index, id, q) => names(select(index, id, parseExtras(q)).entries);
const SHORT = "Twelve Minute Dream", FEATURE = "Feature Beside It", UNKNOWN = "Length Unknown", EDGE = "Exactly Forty";
/** Every short of this index (the one added above and the fixture's own), by name and by id. */
const ALL_SHORTS = worldObject().films.filter((f) => f.shortOut);
const isShortName = (n) => ALL_SHORTS.some((f) => f.name === n), isShortId = (tt) => ALL_SHORTS.some((f) => f.tt === tt);

test("the Film getters: bit 16 is read from the flags; a short is not ineligible; recommendable is eligible AND no music bit AND no short bit, for every combination of the three; an index without the bit reads false", () => {
  const short = ix.films.find((f) => f.name === SHORT), feature = ix.films.find((f) => f.name === FEATURE);
  assert.deepEqual([short.eligible, short.shortOut, short.musicOut, short.recommendable], [true, true, false, false]);
  assert.deepEqual([feature.eligible, feature.shortOut, feature.recommendable], [true, false, true]);
  const before = old.films.find((f) => f.name === SHORT);
  assert.deepEqual([before.eligible, before.shortOut, before.recommendable], [true, false, true], "an index from before the bit: the short is recommendable, as it was");
  // every combination of the bits a film can carry (1 seen, 2 watchlist, 4 eligible, 8 music, 16 short): recommendable is exactly eligible, not music, not short; recommendableOrShort (an era's rule) the same without the short bit
  const one = (flags) => hydrate({ cols: rows.COLS, meta: {}, films: [rows.COLS.map((c) => (c === "tt" ? "tt1" : c === "name" ? "x" : c === "flags" ? flags || null : null))] }).films[0];
  for (let flags = 0; flags < 32; flags++) {
    const f = one(flags);
    assert.deepEqual([f.seen, f.watchlist, f.eligible, f.musicOut, f.shortOut], [!!(flags & 1), !!(flags & 2), !!(flags & 4), !!(flags & 8), !!(flags & 16)], `flags ${flags}`);
    assert.equal(f.recommendable, !!(flags & 4) && !(flags & 8) && !(flags & 16), `flags ${flags}: recommendable`);
    assert.equal(f.recommendableOrShort, !!(flags & 4) && !(flags & 8), `flags ${flags}: recommendableOrShort`);
  }
  // a film with no known runtime and a film of exactly the minimum are no shorts
  for (const name of [UNKNOWN, EDGE]) assert.deepEqual([ix.films.find((f) => f.name === name).shortOut, ix.films.find((f) => f.name === name).recommendable], [false, true], name);
});

test("Moods and Explore do not recommend a short, with every menu on top; a film with no known runtime and one of exactly 40 minutes stay; the control: the same short is there in an index without the bit", () => {
  const cases = [["moods", "genre=Nocturnal"], ["explore", ""], ["explore", "decade=2020s"], ["explore", "country=South%20Korea"], ["explore", "rating=4.2%2B"], ["moods", "genre=Nocturnal&decade=2020s&country=South%20Korea&rating=4.2%2B"], ["explore", "decade=2020s&country=South%20Korea"]];
  for (const [id, q] of cases) {
    assert.ok(!answer(ix, id, q).includes(SHORT), `${id} ${q}: the short is recommended`);
    for (const name of [FEATURE, UNKNOWN, EDGE]) assert.ok(answer(ix, id, q).includes(name), `${id} ${q}: ${name} is there`);
    assert.ok(answer(old, id, q).includes(SHORT), `control, ${id} ${q}: without the bit the short is there`);
    assert.deepEqual(answer(ix, id, q), answer(old, id, q).filter((n) => !isShortName(n)), `${id} ${q}: the same films in the same order, the shorts apart`);
  }
  assert.equal(eligibleTest(ix, "moods")(ix.films.find((f) => f.name === SHORT)), false);
  assert.equal(eligibleTest(ix, "explore")(ix.films.find((f) => f.name === SHORT)), false);
  assert.equal(eligibleTest(ix, "search")(ix.films.find((f) => f.name === SHORT)), true, "Search reads `eligible` alone");
});

test("the Moods option exempt from the MUSIC rule (rules.musicExemptMoods) is not exempt from the shorts: a held-back music film is there, a short is not", () => {
  const o = worldObject();
  o.rules = { rule: "letterboxd-average-or-configured-friend-or-vouched", minStars: 3.5, exemptCatalogs: ["lists", "lists-unseen", "friends"], musicExemptMoods: ["night"] };
  o.films.push(film("tt0000105", "Arena Tour Film", { rank: 8.6, moods: { night: [1.9, 8.6] }, director: "A Fifth Director", musicOut: true }));
  o.films.push(film("tt0000106", "Short Concert Film", { rank: 8.5, moods: { night: [1.9, 8.5] }, director: "A Sixth Director", runtime: 25, musicOut: true, shortOut: true }));
  o.films.sort((a, b) => (b.rank ?? -Infinity) - (a.rank ?? -Infinity) || a.tt.localeCompare(b.tt));
  o.meta.count = o.films.length;
  const exempt = readyOf(o);
  const got = answer(exempt, "moods", "genre=Nocturnal");
  assert.ok(got.includes("Arena Tour Film"), "(control: the option is exempt from the music rule)");
  assert.ok(!got.includes(SHORT), "a short is out of the exempt option too");
  assert.ok(!got.includes("Short Concert Film"), "and so is a music film that is a short");
  assert.ok(got.includes(FEATURE) && got.includes(UNKNOWN));
  assert.ok(!answer(exempt, "explore", "").includes("Arena Tour Film"), "(control: Explore has no exemption)");
});

test("a page is the first hundred RECOMMENDABLE films in the catalog's order: the shorts fill no gap and count in no skip, and X-Total counts none of them", () => {
  const o = worldObject();
  const extra = Array.from({ length: 150 }, (_, i) => marked(film(`tt${String(2000 + i).padStart(7, "0")}`, `Plain ${i}`, { rank: 5 - i / 100, moods: undefined, lists: undefined, runtime: i % 2 === 0 ? 20 : 95 })));
  o.films.push(...extra);
  o.films.sort((a, b) => (b.rank ?? -Infinity) - (a.rank ?? -Infinity) || a.tt.localeCompare(b.tt));
  o.meta.count = o.films.length;
  const big = readyOf(o);
  const keep = o.films.filter((f) => f.eligible && !f.seen && !f.shortOut).map((f) => f.name);
  assert.ok(o.films.filter((f) => f.shortOut).length >= 75, "(control: the index has the shorts)");
  const p1 = page(big, "explore", {}), p2 = page(big, "explore", { skip: "100" });
  assert.deepEqual(p1.entries.map((e) => e.name), keep.slice(0, 100));
  assert.deepEqual(p2.entries.map((e) => e.name), keep.slice(100, 200));
  assert.equal(p1.total, keep.length);
});

test("where he or a source put it, the short stays: Search by any word (title, keyword, genre, country), Lists, Lists (unseen), Friends and a Board row", () => {
  for (const q of ["twelve", "twelve+minute+dream", "stop+motion", "animation", "south+korea", "dream"]) assert.ok(answer(ix, "search", `search=${q}`).includes(SHORT), `Search finds it by "${q}"`);
  assert.ok(answer(ix, "search", "search=twelve&decade=2020s").includes(SHORT), "with a menu on top");
  const crit = "genre=All-time%20Criterion%20Closet%20Picks%20(closetpicks)";
  assert.ok(answer(ix, "lists", crit).includes(SHORT));
  assert.ok(answer(ix, "lists-unseen", crit).includes(SHORT));
  assert.ok(answer(ix, "lists-unseen", crit + "&decade=2020s&country=South%20Korea").includes(SHORT), "and with the menus on top: Lists apply none of the rules");
  assert.ok(answer(ix, "friends", "genre=Top%20%C2%B7%20Gustavo").includes(SHORT));
  assert.ok(answer(ix, "tonight", "").includes(SHORT), "a Board row is served as the build made it");
  for (const id of ["lists", "friends", "tonight"]) assert.equal(eligibleTest(ix, id), null, id);
  // the answers of these are the same with and without the bit
  for (const [id, q] of [["search", "search=twelve"], ["search", "search=animation"], ["lists", crit], ["lists-unseen", crit], ["friends", "genre=Top%20%C2%B7%20Gustavo"], ["tonight", ""], ["oldfriends", ""]]) assert.deepEqual(answer(ix, id, q), answer(old, id, q), `${id} ${q}: the bit changes nothing`);
});

test("the file: bit 16 survives the format, the bits an older Worker reads (1, 2, 4, 8) are where they were, and the build's verdict for every film of the file is lib/pool.js isShort of its runtime", () => {
  const withBit = rows.encode(worldObject()), without = rows.encode(worldObject({ bits: false }));
  const at = withBit.cols.indexOf("flags"), rt = withBit.cols.indexOf("runtime");
  const a = withBit.films.find((r) => r[0] === "tt0000101")[at], b = without.films.find((r) => r[0] === "tt0000101")[at];
  assert.equal(a & 16, 16);
  assert.equal(a & ~16, b, "the other bits are the ones of the index without the bit");
  assert.equal(C.flags, at, "(the Worker reads the same column)");
  const back = rows.decode(JSON.parse(JSON.stringify(withBit)));
  assert.deepEqual(back.films.filter((f) => f.shortOut).map((f) => f.tt).sort(), withBit.films.filter((r) => pool.isShort(r[rt], MIN)).map((r) => r[0]).sort(), "decode gives the bit back, on the shorts and on no other film");
  assert.ok(back.films.filter((f) => f.shortOut).length >= 2, "(control: the fixture has shorts of its own)");
  for (const r of withBit.films) assert.equal(((r[at] || 0) & 16) === 16, pool.isShort(r[rt], MIN), `${r[0]}: the bit is isShort(${r[rt]})`);
  for (const r of without.films) assert.equal((r[at] || 0) & 16, 0, `${r[0]}: an index from before carries no bit`);
});

// ── the calculated options of the Discover, and their own pieces ─────────────

const T = (i) => `tt${8100000 + i}`;
const V2 = makeV2Object();
const MOOD = V2.moods[0].id;
function discoverFiles({ bits = true, totalsWithBit = bits } = {}) {
  // 40 films of one country: every 5th a short, every 8th seen, one seen short
  const plain = Array.from({ length: 40 }, (_, k) => {
    const i = k + 1, year = 1960 + (i % 4) * 10;
    return { tt: T(i), name: `Country Film ${String(i).padStart(2, "0")}`, year, decade: `${Math.floor(year / 10) * 10}s`, runtime: i % 5 === 0 ? 15 + i % 20 : 90, countries: ["Brazil"], director: `Director ${i}`, moods: { [MOOD]: [1.2, 3] }, lbRating: 3.9, rank: 9 - i / 100, eligible: true,
      ...(i % 8 === 0 ? { seen: true } : {}), desc: `Film ${i} cast\nFilm ${i} genres.\n\nSynopsis of film ${i}.`, find: ` country film ${i}` };
  });
  const films = plain.map((e) => marked(e, bits));
  const forTotals = plain.map((e) => marked(e, totalsWithBit));
  const ids = films.map((f) => f.tt).reverse();
  const union = films.slice(0, 30).map((f) => f.tt);
  const o = v2ObjectFrom(makeObject());
  o.films = [...o.films, ...films];
  o.films.sort((a, b) => (b.rank ?? -Infinity) - (a.rank ?? -Infinity) || a.tt.localeCompare(b.tt));
  o.meta.count = o.films.length;
  // an era (data/eras/<id>.json in the build): the same ids as Brazil, with `shorts: true`: the build's director door took no short, so the shorts of its ids are the ones its file names
  const options = [{ id: "c-brazil", label: "Brazil", ids }, { id: "u-union", label: "Union", ids: union, curated: true }, { id: "e-era", label: "Era", ids, shorts: true }];
  // the totals as the build counts them (lib/index-export.js optionCut), over the films as THAT build marked them
  const byTt = new Map(forTotals.map((f) => [f.tt, f]));
  o.discover = { order: ["moods", "places", "explore", "search"], retire: [], seen: { name: "seen", option: "Include seen" }, catalogs: [{ id: "places", name: "Mood Engine · Countries & regions", options: options.map((x) => { const cut = exporter.optionCut(byTt, x); return { ...x, total: cut.total, totalAll: cut.totalAll }; }) }] };
  return { o, films, ids, union };
}
const pieceOf = (o, optionId, ids) => {
  const want = new Set(ids);
  const part = { ...o, meta: { ...o.meta, part: `v2-opt:places:${optionId}`, count: want.size }, films: o.films.filter((f) => want.has(f.tt)), rows: {}, rowDesc: {} };
  return hydrate(JSON.parse(JSON.stringify(rows.encode(part))));
};

test("a calculated option of the Discover does not show a short, with or without \"Include seen\" and with a menu on top; a curated option (a union of lists, a director's card) shows it; the control: without the bit both show it", () => {
  const now = discoverFiles(), before = discoverFiles({ bits: false });
  const full = readyOf(now.o), fullBefore = readyOf(before.o);
  const shorts = new Set(now.films.filter((f) => f.shortOut).map((f) => f.name)), seenShort = now.films.find((f) => f.shortOut && f.seen);
  assert.ok(shorts.size >= 6 && seenShort, "(control: the option has shorts, one of them seen)");
  for (const q of ["genre=Brazil", "genre=Brazil&seen=Include%20seen", "genre=Brazil&decade=1970s", "genre=Brazil&seen=Include%20seen&decade=1970s"]) {
    const got = answer(full, "places", q), was = answer(fullBefore, "places", q);
    assert.ok(got.length > 0 && !got.some((n) => shorts.has(n)), `${q}: no short`);
    assert.deepEqual(got, was.filter((n) => !shorts.has(n)), `${q}: the same films in the same order, the shorts apart`);
    assert.ok(was.some((n) => shorts.has(n)) || q.includes("decade"), `control, ${q}: without the bit the shorts are there`);
  }
  assert.ok(!answer(full, "places", "genre=Brazil&seen=Include%20seen").includes(seenShort.name), "a short he has seen stays out with Include seen");
  // the curated option: every film of its ids that is not seen, shorts included
  const union = answer(full, "places", "genre=Union");
  assert.ok(union.some((n) => shorts.has(n)), "the curated option keeps its shorts");
  assert.deepEqual(union, answer(fullBefore, "places", "genre=Union"), "and is the same with and without the bit");
});

test("the option's own piece still answers when the build counted the totals with the bit (the same three bits as `recommendable`), and no longer can when the totals are of an index that counted the shorts: that is why the Worker reads the build's bit and does not judge the runtime itself", () => {
  const now = discoverFiles();
  const opt = now.o.discover.catalogs[0].options[0];
  const shown = now.films.filter((f) => !f.shortOut);
  assert.deepEqual([opt.total, opt.totalAll], [shown.filter((f) => !f.seen).length, shown.length], "the build's totals count no short (lib/index-export.js optionCut)");
  const piece = pieceOf(now.o, "c-brazil", now.ids);
  for (const q of ["genre=Brazil", "genre=Brazil&seen=Include%20seen", "genre=Brazil&decade=1970s"]) {
    const out = completeOptionPage(piece, "places", "c-brazil", parseExtras(q));
    assert.ok(out, `${q}: the piece answers`);
    assert.ok(out.entries.length > 0 && out.entries.every((e) => !e.shortOut), `${q}: no short in the piece's answer`);
    assert.deepEqual(names(out.entries), names(page(readyOf(now.o), "places", parseExtras(q)).entries), `${q}: the same page as the whole index gives`);
  }
  assert.equal(optionPage(piece, "places", "c-brazil", parseExtras("genre=Brazil")).total, opt.total);
  // an index whose FILMS carry the bit but whose totals were counted without it (a build that marks the films and forgets optionCut): the piece refuses, the whole index would have to answer
  const mixed = discoverFiles({ bits: true, totalsWithBit: false });
  const mixedOpt = mixed.o.discover.catalogs[0].options[0];
  assert.ok(mixedOpt.totalAll > opt.totalAll, "(control: those totals count the shorts)");
  assert.equal(completeOptionPage(pieceOf(mixed.o, "c-brazil", mixed.ids), "places", "c-brazil", parseExtras("genre=Brazil")), null);
  // an index from before the bit, whole: films and totals agree, and the piece answers as it always did, shorts included
  const before = discoverFiles({ bits: false });
  const outBefore = completeOptionPage(pieceOf(before.o, "c-brazil", before.ids), "places", "c-brazil", parseExtras("genre=Brazil"));
  assert.ok(outBefore && outBefore.entries.some((e) => pool.isShort(e.runtime, MIN)), "an index without the bit: the piece answers with its shorts, as before");
});

test("an ERA option of the Discover (`shorts: true`: its file names the shorts in its ids, \"a source put them there\") shows its shorts, seen ones with \"Include seen\", and still holds the recommendation rule and the music rule; its piece answers; the bit changes nothing in it", () => {
  const withMusic = (bits) => {
    const d = discoverFiles({ bits });
    // one feature of the era held back by the music rule, and one that is not eligible: both in the ids, neither shown
    const music = d.o.films.find((f) => f.tt === T(2)), low = d.o.films.find((f) => f.tt === T(3));
    music.musicOut = true; delete low.eligible;
    const era = d.o.discover.catalogs[0].options.find((x) => x.id === "e-era");
    const cut = exporter.optionCut(new Map(d.o.films.map((f) => [f.tt, f])), era);
    era.total = cut.total; era.totalAll = cut.totalAll;
    return d;
  };
  const now = withMusic(true), before = withMusic(false);
  const full = readyOf(now.o);
  const shorts = now.films.filter((f) => f.shortOut), unseenShorts = shorts.filter((f) => !f.seen), seenShort = shorts.find((f) => f.seen);
  assert.ok(unseenShorts.length >= 5 && seenShort, "(control: the era's ids hold shorts, one of them seen)");
  const era = answer(full, "places", "genre=Era"), eraAll = answer(full, "places", "genre=Era&seen=Include%20seen"), country = answer(full, "places", "genre=Brazil");
  for (const f of unseenShorts) assert.ok(era.includes(f.name), `${f.name}: an unseen short the era names is shown`);
  assert.ok(!era.includes(seenShort.name) && eraAll.includes(seenShort.name), "a short he has seen: only with Include seen, as any seen film");
  assert.ok(!country.some((n) => shorts.some((f) => f.name === n)), "(control: the country option with the very same ids shows none of them)");
  assert.deepEqual(era.filter((n) => !shorts.some((f) => f.name === n)), country, "and apart from its shorts the era shows what the country shows, in the same order");
  // the two other rules hold in an era
  const nameOf = (i) => now.o.films.find((f) => f.tt === T(i)).name;
  for (const q of ["genre=Era", "genre=Era&seen=Include%20seen"]) { assert.ok(!answer(full, "places", q).includes(nameOf(2)), `${q}: a film the music rule holds back is not shown`); assert.ok(!answer(full, "places", q).includes(nameOf(3)), `${q}: a film that is not eligible is not shown`); }
  // the totals the build counts for it are what the Worker shows, and the option's own piece answers
  const opt = now.o.discover.catalogs[0].options.find((x) => x.id === "e-era");
  assert.deepEqual([opt.total, opt.totalAll], [era.length, eraAll.length], "optionCut counts an era with its shorts");
  const piece = pieceOf(now.o, "e-era", now.ids);
  for (const q of ["genre=Era", "genre=Era&seen=Include%20seen", "genre=Era&decade=1970s"]) {
    const out = completeOptionPage(piece, "places", "e-era", parseExtras(q));
    assert.ok(out, `${q}: the piece answers`);
    assert.deepEqual(names(out.entries), names(page(full, "places", parseExtras(q)).entries), `${q}: the same page as the whole index gives`);
  }
  assert.ok(completeOptionPage(piece, "places", "e-era", parseExtras("genre=Era")).entries.some((e) => e.shortOut), "(control: the piece's answer has a short)");
  // with and without the bit the era answers the same
  const fullBefore = readyOf(before.o);
  for (const q of ["genre=Era", "genre=Era&seen=Include%20seen", "genre=Era&decade=1970s"]) assert.deepEqual(answer(full, "places", q), answer(fullBefore, "places", q), `${q}: the bit changes nothing in an era`);
  // a calculated option WITHOUT the key is not an era: `shorts` anything but true is the rule of every calculated option
  for (const odd of [false, 1, "true", null]) {
    const d = withMusic(true);
    d.o.discover.catalogs[0].options.find((x) => x.id === "e-era").shorts = odd;
    assert.ok(!answer(readyOf(d.o), "places", "genre=Era").some((n) => shorts.some((f) => f.name === n)), `shorts: ${JSON.stringify(odd)} is not the mark`);
  }
});

// ── the profiles (end to end through the handler) ────────────────────────────

const DIR = "https://pages.test/mood-engine/data/";
const ENV = { INDEX_URL: `${DIR}index.json` };
/** The profiles' fixture with some of its films made shorts (a runtime of 25 minutes), marked as the build marks them, or not marked at all (`bits: false`, an index from before). */
function profileFiles(shortNames, { bits = true } = {}) {
  const o = PF.makeObject();
  o.films = o.films.map((f) => marked(shortNames.includes(f.name) ? { ...f, runtime: 25 } : { ...f }, bits)); // the fixture's films are shared by every caller: never changed in place
  const out = { "index.json": JSON.stringify(rows.encode(o)) };
  for (const p of exporter.pieces(o)) out[p.rel.split("/").pop()] = JSON.stringify(rows.encode(p.obj));
  return out;
}
function rig(files, now) {
  const fetchImpl = async (url) => { const name = url.slice(DIR.length); return files[name] ? new Response(files[name]) : new Response("not found", { status: 404 }); };
  const subtitles = { list: async () => ({ subs: [] }), exact: async () => ({ status: "none", ids: new Set() }) };
  const handle = createHandler({ store: createStore({ fetchImpl, caches: undefined, log: () => {} }), subtitles, now });
  return async (path) => {
    const res = await handle(new Request("https://mood-engine.example.workers.dev" + path), ENV, undefined);
    const json = res.headers.get("content-type")?.includes("json") ? JSON.parse(await res.text()) : null;
    return { status: res.status, total: res.headers.get("x-total"), ids: json && json.metas ? json.metas.map((m) => m.id) : [] };
  };
}
const SHORTS = ["Night 1", "Night Watchlist Short", "Horror Both Lists", "Closet Most Picked"];
const DAY0 = Date.parse("2026-10-11T23:00:00Z");

test("the profiles: Tonight, a theme and What it is do not recommend a short (over forty days of Tonight; the control: in an index without the bit it is drawn); the watchlist, a curator's list, Who vouches and a Board row keep it", async () => {
  const marked_ = rig(profileFiles(SHORTS), () => DAY0), unmarked = rig(profileFiles(SHORTS, { bits: false }), () => DAY0);
  const tt = PF.tt;
  // a theme (Horror lists), and the same theme through What it is
  for (const path of ["/p/night/catalog/movie/theme-horror.json", "/p/night/catalog/movie/what-it-is/genre=Horror.json"]) {
    const was = await unmarked(path), got = await marked_(path);
    assert.ok(was.ids.includes(tt("Horror Both Lists")), `control, ${path}: without the bit the short is there`);
    assert.ok(!got.ids.includes(tt("Horror Both Lists")), `${path}: no short`);
    assert.deepEqual(got.ids, was.ids.filter((id) => id !== tt("Horror Both Lists")), `${path}: the same films in the same order, the short apart`);
    assert.equal(Number(got.total), Number(was.total) - 1, `${path}: the total counts one film fewer`);
  }
  // Tonight: the best of the Night mood (Night 1, rank 20) is in the top twelve the pick is drawn from
  let drawn = 0, drawnShort = 0;
  for (let d = 0; d < 40; d++) {
    const at = DAY0 + d * 86400e3;
    const a = await rig(profileFiles(SHORTS, { bits: false }), () => at)("/p/night/catalog/movie/tonight.json"), b = await rig(profileFiles(SHORTS), () => at)("/p/night/catalog/movie/tonight.json");
    if (a.ids.includes(tt("Night 1"))) drawn++;
    if (b.ids.some((id) => SHORTS.map(tt).includes(id))) drawnShort++;
    assert.equal(b.ids.length, 6, "six films, shorts or no shorts");
  }
  assert.ok(drawn >= 1, `control: without the bit the short Night 1 is drawn on ${drawn} of 40 days`);
  assert.equal(drawnShort, 0, "with the bit no short is ever drawn");
  // Under 100 min already asked for a feature (40 minutes or more) before the bit: the short is in neither
  for (const get of [marked_, unmarked]) assert.ok(!(await get("/p/night/catalog/movie/short.json")).ids.includes(tt("Night Watchlist Short")));
  // what he chose or a curator listed stays, and is the same with and without the bit
  for (const [path, name, why] of [["/p/night/catalog/movie/watchlist.json", "Night Watchlist Short", "his watchlist"], ["/p/critics/catalog/movie/closet-most-picked.json", "Closet Most Picked", "a curator's list"], ["/p/night/catalog/movie/night.json", "Night 1", "a Board row, as the build made it"]]) {
    const got = await marked_(path);
    assert.ok(got.ids.includes(tt(name)), `${why}: the short stays`);
    assert.deepEqual(got.ids, (await unmarked(path)).ids, `${why}: the same answer with and without the bit`);
  }
});

test("through the handler at the old address: Explore, a mood and Search over the same index with and without the bit — the catalogs that recommend lose exactly the shorts, Search and a list lose nothing", async () => {
  const filesOf = (bits) => { const o = worldObject({ bits }); const out = { "index.json": JSON.stringify(rows.encode(o)) }; for (const p of exporter.pieces(o)) out[p.rel.split("/").pop()] = JSON.stringify(rows.encode(p.obj)); return out; };
  const now = rig(filesOf(true), () => DAY0), before = rig(filesOf(false), () => DAY0);
  for (const path of ["/catalog/movie/explore.json", "/catalog/movie/moods/genre=Nocturnal.json", "/catalog/movie/explore/decade=2020s.json"]) {
    const a = await before(path), b = await now(path);
    assert.equal(b.status, 200);
    assert.ok(a.ids.includes("tt0000101") && !b.ids.includes("tt0000101"), `${path}: the short left`);
    assert.deepEqual(b.ids, a.ids.filter((id) => !isShortId(id)), `${path}: nothing else moved`);
    assert.equal(Number(b.total), Number(a.total) - a.ids.filter(isShortId).length, `${path}: X-Total counts the shorts out`);
  }
  for (const path of ["/catalog/movie/search/search=twelve.json", "/catalog/movie/search/search=dream.json", "/catalog/movie/lists/genre=All-time%20Criterion%20Closet%20Picks%20(closetpicks).json", "/catalog/movie/tonight.json", "/catalog/movie/friends/genre=Top%20%C2%B7%20Gustavo.json"]) {
    const a = await before(path), b = await now(path);
    assert.ok(b.ids.includes("tt0000101"), `${path}: the short is there`);
    assert.deepEqual([b.ids, b.total], [a.ids, a.total], `${path}: the same answer`);
  }
});
