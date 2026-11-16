// node --test            (no dependencies)
// The nightly build used to read each followed person's whole /films/ history every 7 days (51 people, 449 pages through Chrome) although
// about 11 of them change in a week. lib/friends.js readUserFilms now reads only the recent news (/films/by/date/ then /films/by/rated-date/)
// and the whole history when it must. Here: which of the two runs, what is asked, what is kept, and what happens when a page fails.
// The fake site below serves one member's pages from a model (films in the order they were added, the order their ratings were given),
// 3 films a page so that a few pages are a "history".

const test = require("node:test");
const assert = require("node:assert/strict");

const F = require("../lib/friends");
const L = require("../lib/lists");

const noSleep = async () => {};
const DAY = 864e5;
const BASE_DAY = Date.parse("2026-10-11T12:00:00Z");

const poster = (slug, rating) => `<li class="griditem"><div data-item-name="${slug} (2000)" data-item-slug="${slug}"><img alt="${slug}"/><span class="rating rated-${rating ? rating * 2 : ""}"></span></div></li>`;
const page = (rows, { next = null, total = null } = {}) =>
  `<html><body>${total != null ? `<h1 class="section-heading"><span class="tooltip" title="${total}&nbsp;films">Watched</span></h1>` : ""}<ul class="grid">${rows.map(([s, r]) => poster(s, r)).join("")}</ul>${next ? `<a class="next" href="${next}">Older</a>` : ""}</body></html>`;

/**
 * One member's three orderings. `added`: [slug, rating] newest added first (also the default /films/ order). `ratedOrder`: the rated slugs,
 * newest rating first (default: the order they were added); unrated films come last in every case, as on Letterboxd. `hidden`: films the
 * page counts but does not show. `overrides`: { path: Error | html } replaces an answer. `size`: films a page.
 */
function site(user, { added, ratedOrder, hidden = 0, size = 3, overrides = {}, noTotal = false }) {
  const rating = new Map(added);
  const rated = [...(ratedOrder || added.filter(([, r]) => r != null).map(([s]) => s))].map((s) => [s, rating.get(s)]);
  const unrated = added.filter(([, r]) => r == null);
  const orders = { "": added, date: added, "rated-date": [...rated, ...unrated] };
  const total = noTotal ? null : added.length + hidden;
  const calls = [];
  return {
    calls,
    total,
    async get(url) {
      const p = new URL(url).pathname;
      calls.push(p);
      if (p in overrides) { const o = overrides[p]; if (o instanceof Error) throw o; return typeof o === "object" ? { ...o, url } : { status: 200, text: o, url }; }
      const m = p.match(new RegExp(`^/${user}/films/(?:by/(date|rated-date)/)?(?:page/(\\d+)/)?$`));
      if (!m) return { status: 404, text: "", url };
      const n = Number(m[2] || 1), list = orders[m[1] || ""];
      const root = `/${user}/films/${m[1] ? `by/${m[1]}/` : ""}`;
      const next = n * size < list.length ? `${root}page/${n + 1}/` : null;
      return { status: 200, text: page(list.slice((n - 1) * size, n * size), { next, total }), url };
    },
  };
}

const ctx = (extra = {}) => {
  const problems = [];
  const guarded = async (what, fn) => { try { return await fn(); } catch (e) { problems.push(`${what}: ${e.message}`); return null; } };
  return { problems, guarded, pageGap: { gapMs: 0, sleepImpl: noSleep }, now: BASE_DAY, ...extra };
};
const iso = (ms) => new Date(ms).toISOString();

/** A noon on which it is (or is not) the account's turn to be read whole. */
function dayWhere(user, turn) {
  for (let d = 0; ; d++) {
    const now = BASE_DAY + d * DAY;
    if (F.onTurn(user, now) === turn) return now;
  }
}

// What the cache holds after a whole read of the "before" account.
const BEFORE = [["a", 4], ["b", 3.5], ["c", 3], ["d", null], ["e", 2], ["f", 4], ["g", 5], ["h", null]];
function cached({ now, fullDaysAgo = 8, at = fullDaysAgo, films = BEFORE, hidden = 0, extra = {} } = {}) {
  return {
    films: films.map(([s, r]) => [s, s, 2000, r]), filmsAt: iso(now - at * DAY), filmsFullAt: iso(now - fullDaysAgo * DAY), filmsPartial: false,
    filmsPages: Math.ceil(films.length / 3), filmsTotal: films.length + hidden, filmsHidden: hidden, filmsMode: "full", ...extra,
  };
}
const slugs = (u) => u.films.map((r) => r[0]);
const ratingOf = (u, s) => u.films.find((r) => r[0] === s)[3];
const BY_DATE = (n = 1) => `/u/films/by/date/${n > 1 ? `page/${n}/` : ""}`;
const BY_RATED = (n = 1) => `/u/films/by/rated-date/${n > 1 ? `page/${n}/` : ""}`;
const FULL = (n = 1) => `/u/films/${n > 1 ? `page/${n}/` : ""}`;

// ── which way a history is read ──────────────────────────────────────────────

test("no films cached: the whole history, /films/ and nothing else", async () => {
  const http = site("u", { added: BEFORE });
  const c = ctx(), u = {};
  const r = await F.readUserFilms({ u, user: "u", http, ...c });
  assert.deepEqual(http.calls, [FULL(1), FULL(2), FULL(3)]);
  assert.deepEqual(r, { read: 8, pages: 3, total: 8, partial: false, mode: "full", pagesRead: 3 });
  assert.equal(u.filmsMode, "full");
  assert.equal(u.filmsFullAt, iso(c.now));
  assert.equal(u.filmsHidden, 0);
  assert.equal(u.filmsReadPages, 3);
  assert.deepEqual(c.problems, []);
});

test("a whole read keeps the page's count minus the films it shows (filmsHidden), the yardstick of the next incremental read", async () => {
  const u = {};
  await F.readUserFilms({ u, user: "u", http: site("u", { added: BEFORE, hidden: 2 }), ...ctx() });
  assert.equal(u.filmsTotal, 10);
  assert.equal(u.filmsHidden, 2);
});

test("a history that did not change costs two pages: by/date page 1 and rated-date page 1, and nothing more", async () => {
  const now = dayWhere("u", false), http = site("u", { added: BEFORE }), c = ctx({ now });
  const u = cached({ now });
  const r = await F.readUserFilms({ u, user: "u", http, ...c });
  assert.deepEqual(http.calls, [BY_DATE(1), BY_RATED(1)]);
  assert.equal(r.mode, "incremental");
  assert.equal(r.pagesRead, 2);
  assert.equal(u.filmsMode, "incremental");
  assert.equal(u.filmsReadPages, 2);
  assert.equal(u.filmsAt, iso(now));
  assert.equal(u.filmsFullAt, iso(now - 8 * DAY), "the last WHOLE read is still the old one");
  assert.deepEqual(slugs(u), BEFORE.map(([s]) => s));
  assert.deepEqual(c.problems, []);
});

test("recent news: a new film is added and a re-rated film (one the by/date pages do not reach) is updated; the rest of the cache stays, in order", async () => {
  const now = dayWhere("u", false);
  // n is new (4.5★) and f, an old film, is now 1★ and the newest rating. by/date: [n a b] [c d e] → stop. rated-date: [f n a] differs on f → [b c e] same → stop.
  const after = [["n", 4.5], ...BEFORE.map(([s, r]) => [s, s === "f" ? 1 : r])];
  const http = site("u", { added: after, ratedOrder: ["f", "n", "a", "b", "c", "e", "g"] });
  const u = cached({ now }), c = ctx({ now });
  const r = await F.readUserFilms({ u, user: "u", http, ...c });
  assert.deepEqual(http.calls, [BY_DATE(1), BY_DATE(2), BY_RATED(1), BY_RATED(2)]);
  assert.deepEqual(slugs(u), ["n", "a", "b", "c", "d", "e", "f", "g", "h"]);
  assert.equal(ratingOf(u, "n"), 4.5);
  assert.equal(ratingOf(u, "f"), 1);
  assert.equal(ratingOf(u, "g"), 5);
  assert.equal(u.filmsTotal, 9);
  assert.equal(u.filmsHidden, 0);
  assert.equal(u.filmsPages, 3, "filmsPages describes the whole history and is not touched by an incremental read");
  assert.equal(u.filmsReadPages, 4);
  assert.deepEqual(r, { read: 7, pages: 3, total: 9, partial: false, mode: "incremental", pagesRead: 4 }); // read: the distinct films the four pages showed
  assert.deepEqual(c.problems, []);
});

test("by/date stops after the first page in which every film is known: a page with news is followed, the next all-known page is the last", async () => {
  const now = dayWhere("u", false);
  const after = [["n1", 4], ["n2", 4], ["n3", 4], ["n4", 3], ...BEFORE]; // by/date: [n1 n2 n3] [n4 a b] [c d e] (the last is all known)
  const http = site("u", { added: after });
  const u = cached({ now });
  await F.readUserFilms({ u, user: "u", http, ...ctx({ now }) });
  assert.deepEqual(http.calls.filter((p) => p.includes("/by/date/")), [BY_DATE(1), BY_DATE(2), BY_DATE(3)]);
  assert.ok(!http.calls.includes(BY_DATE(4)));
  assert.deepEqual(slugs(u).slice(0, 4), ["n1", "n2", "n3", "n4"]);
  assert.equal(u.films.length, 12);
  assert.equal(u.filmsMode, "incremental");
});

test("the rated-date walk compares ratings with the cache as it was BEFORE the call: a rating by/date already brought in still makes it read on", async () => {
  const now = dayWhere("u", false);
  const after = BEFORE.map(([s, r]) => [s, s === "b" ? 5 : r]); // b is on by/date page 1 with its new rating
  const http = site("u", { added: after, ratedOrder: ["b", "a", "c", "e", "f", "g"] });
  const u = cached({ now });
  await F.readUserFilms({ u, user: "u", http, ...ctx({ now }) });
  assert.deepEqual(http.calls, [BY_DATE(1), BY_RATED(1), BY_RATED(2)], "page 1 of rated-date holds b, whose rating differs from the old cache; page 2 is all as before");
  assert.equal(ratingOf(u, "b"), 5);
});

test("a week with many new ratings: an older film re-rated the same week sits behind them on rated-date and is still read", async () => {
  const now = dayWhere("u", false);
  // n1..n3 added and rated this week; g (old, by/date page 3) re-rated to 1 before them: rated-date = [n3 n2 n1] [g a b] [c e f]
  const after = [["n3", 4], ["n2", 4], ["n1", 4], ...BEFORE.map(([s, r]) => [s, s === "g" ? 1 : r])];
  const http = site("u", { added: after, ratedOrder: ["n3", "n2", "n1", "g", "a", "b", "c", "e", "f"] });
  const u = cached({ now }), c = ctx({ now });
  const r = await F.readUserFilms({ u, user: "u", http, ...c });
  assert.equal(r.mode, "incremental");
  assert.equal(ratingOf(u, "g"), 1, "a page made only of the new films would have ended the walk before g");
  assert.deepEqual(http.calls.filter((p) => p.includes("rated-date")), [BY_RATED(1), BY_RATED(2), BY_RATED(3)]);
  assert.deepEqual(c.problems, []);
});

// ── the count that catches what the two orderings cannot ─────────────────────

test("positive control: a film missing from the cache, far from the recent pages, is found by the count and the whole history is read in the same call", async () => {
  const now = dayWhere("u", false), http = site("u", { added: BEFORE }), c = ctx({ now });
  const u = cached({ now, films: BEFORE.filter(([s]) => s !== "g") }); // g was lost: filmsHidden still says 0, the page says 8, the cache holds 7
  u.filmsTotal = 8;
  const r = await F.readUserFilms({ u, user: "u", http, ...c });
  assert.deepEqual(http.calls, [BY_DATE(1), BY_RATED(1), FULL(1), FULL(2), FULL(3)]);
  assert.equal(r.mode, "full");
  assert.equal(r.pagesRead, 5, "the two pages the incremental try used count too");
  assert.ok(slugs(u).includes("g"));
  assert.equal(u.films.length, 8);
  assert.equal(u.filmsFullAt, iso(now));
});

test("a film the member deleted is found the same way (the page's count falls below what the cache holds)", async () => {
  const now = dayWhere("u", false);
  const http = site("u", { added: BEFORE.filter(([s]) => s !== "g") });
  const u = cached({ now });
  await F.readUserFilms({ u, user: "u", http, ...ctx({ now }) });
  assert.equal(u.filmsMode, "full");
  assert.ok(!slugs(u).includes("g"));
  assert.equal(u.films.length, 7);
});

test("a page with no count on it cannot be checked: the whole history is read, after one page", async () => {
  const now = dayWhere("u", false), http = site("u", { added: BEFORE, noTotal: true });
  const u = cached({ now });
  const r = await F.readUserFilms({ u, user: "u", http, ...ctx({ now }) });
  assert.deepEqual(http.calls, [BY_DATE(1), FULL(1), FULL(2), FULL(3)]);
  assert.equal(r.mode, "full");
  assert.equal(r.pagesRead, 4);
});

// ── when the whole history is due ────────────────────────────────────────────

test("slot: FNV-1a of the lower-cased name mod 28; the same name always lands on the same day, and 51 names spread over the cycle", () => {
  assert.equal(F.FULL_EVERY, 28);
  assert.equal(F.slot("a"), 0xe40c292c % 28); // the published FNV-1a 32-bit vector for "a"
  for (const n of ["friend-c", "friend-a", "Ana", "MARCO", "Dave"]) assert.equal(F.slot(n), F.slot(n.toLowerCase()), n); // the name is lower-cased first (Letterboxd addresses are not case-sensitive)
  assert.notEqual(new Set(["friend-c", "friend-a", "Ana", "MARCO", "Dave"].map((n) => F.slot(n.toLowerCase()))).size, 1);
  const names = Array.from({ length: 51 }, (_, i) => `member${i}`);
  const slots = names.map(F.slot);
  assert.ok(slots.every((s) => Number.isInteger(s) && s >= 0 && s < 28));
  assert.ok(new Set(slots).size >= 15, `51 names fell on only ${new Set(slots).size} of 28 days`);
});

test("the account's turn: the whole history is read, but not twice in a week", async () => {
  const user = "u", now = dayWhere(user, true);
  const http = site("u", { added: BEFORE }), u = cached({ now });
  await F.readUserFilms({ u, user, http, ...ctx({ now }) });
  assert.equal(http.calls[0], FULL(1), "its turn, last whole read 8 days ago");
  assert.equal(u.filmsMode, "full");

  const again = site("u", { added: BEFORE }), v = cached({ now, fullDaysAgo: 3, at: 3 });
  await F.readUserFilms({ u: v, user, http: again, ...ctx({ now }) });
  assert.equal(again.calls[0], BY_DATE(1), "its turn, but the last whole read was 3 days ago");
  assert.equal(v.filmsMode, "incremental");
});

test("a whole read older than 35 days is redone on any day; one of 34 days is not", async () => {
  const now = dayWhere("u", false);
  assert.equal(F.FULL_MAX_AGE, 35 * DAY);
  const old = site("u", { added: BEFORE }), u = cached({ now, fullDaysAgo: 36, at: 8 });
  await F.readUserFilms({ u, user: "u", http: old, ...ctx({ now }) });
  assert.equal(old.calls[0], FULL(1));
  assert.equal(u.filmsMode, "full");
  const ok = site("u", { added: BEFORE }), v = cached({ now, fullDaysAgo: 34, at: 8 });
  await F.readUserFilms({ u: v, user: "u", http: ok, ...ctx({ now }) });
  assert.equal(ok.calls[0], BY_DATE(1));
});

test("an old record (films, a complete read, no filmsFullAt) counts filmsAt as its last whole read", async () => {
  const now = dayWhere("u", false);
  const legacy = (days) => { const u = cached({ now, at: days }); delete u.filmsFullAt; delete u.filmsHidden; delete u.filmsMode; return u; };
  const http = site("u", { added: BEFORE }), u = legacy(8);
  await F.readUserFilms({ u, user: "u", http, ...ctx({ now }) });
  assert.equal(http.calls[0], BY_DATE(1), "8 days old: incremental; hidden is worked out from filmsTotal and the films held");
  assert.equal(u.filmsFullAt, iso(now - 8 * DAY), "and the migration is written down");
  assert.equal(u.filmsHidden, 0);
  const stale = site("u", { added: BEFORE }), v = legacy(36);
  await F.readUserFilms({ u: v, user: "u", http: stale, ...ctx({ now }) });
  assert.equal(stale.calls[0], FULL(1), "36 days old: whole");
});

test("a partial last read, a forced read, or no count to measure against: whole", async () => {
  const now = dayWhere("u", false);
  const partial = site("u", { added: BEFORE }), p = cached({ now, extra: { filmsPartial: true } });
  await F.readUserFilms({ u: p, user: "u", http: partial, ...ctx({ now }) });
  assert.equal(partial.calls[0], FULL(1));
  assert.equal(p.filmsPartial, false);
  const forced = site("u", { added: BEFORE }), f = cached({ now });
  await F.readUserFilms({ u: f, user: "u", http: forced, ...ctx({ now }), force: true });
  assert.equal(forced.calls[0], FULL(1));
  const blind = site("u", { added: BEFORE }), b = cached({ now });
  delete b.filmsHidden; b.filmsTotal = null;
  await F.readUserFilms({ u: b, user: "u", http: blind, ...ctx({ now }) });
  assert.equal(blind.calls[0], FULL(1));
});

// ── the ceiling ──────────────────────────────────────────────────────────────

test("five pages of by/date that still find news: give up and read the whole history in the same call", async () => {
  const now = dayWhere("u", false);
  const news = Array.from({ length: 12 }, (_, i) => [`n${i}`, 4]); // 6 pages of 2 that are all new
  const added = [...news, ["a", 4]];
  const http = site("u", { added, size: 2 });
  const u = cached({ now, films: [["a", 4]] });
  const r = await F.readUserFilms({ u, user: "u", http, ...ctx({ now }) });
  const dates = http.calls.filter((p) => p.includes("/by/date/"));
  assert.equal(F.INCREMENTAL_MAX_PAGES, 5);
  assert.equal(dates.length, 5);
  assert.ok(!http.calls.includes(BY_DATE(6)));
  assert.ok(!http.calls.some((p) => p.includes("rated-date")), "it did not go on to the other ordering");
  assert.equal(r.mode, "full");
  assert.equal(r.pagesRead, 5 + 7);
  assert.equal(u.films.length, 13);
});

test("a fifth page that is all known is not a ceiling: the walk ends there", async () => {
  const now = dayWhere("u", false);
  const news = Array.from({ length: 8 }, (_, i) => [`n${i}`, 4]); // 4 pages of 2 new; page 5 = [n.. none] → a, b known
  const http = site("u", { added: [...news, ["a", 4], ["b", 4], ["c", 4]], size: 2 });
  const u = cached({ now, films: [["a", 4], ["b", 4], ["c", 4]] });
  const r = await F.readUserFilms({ u, user: "u", http, ...ctx({ now }) });
  assert.equal(http.calls.filter((p) => p.includes("/by/date/")).length, 5);
  assert.equal(r.mode, "incremental");
  assert.equal(u.films.length, 11);
});

test("five pages of rated-date that still show changed ratings: give up and read the whole history, without a sixth rated-date page", async () => {
  const now = dayWhere("u", false);
  const before = [["x1", 4], ["x2", 4], ...Array.from({ length: 10 }, (_, i) => [`y${i + 1}`, 4])];
  const changed = new Set(["y2", "y4", "y6", "y8", "y10"]);
  const added = before.map(([s, r]) => [s, changed.has(s) ? 3 : r]); // by/date page 1 (x1 x2) is unchanged; one changed film on each of the first five rated-date pages
  const http = site("u", { added, size: 2, ratedOrder: ["y10", "x1", "y8", "x2", "y6", "y1", "y4", "y3", "y2", "y5", "y7", "y9"] });
  const u = cached({ now, films: before }), c = ctx({ now });
  const r = await F.readUserFilms({ u, user: "u", http, ...c });
  assert.deepEqual(http.calls.filter((p) => p.includes("rated-date")), [BY_RATED(1), BY_RATED(2), BY_RATED(3), BY_RATED(4), BY_RATED(5)]);
  assert.equal(r.mode, "full");
  assert.equal(r.pagesRead, 1 + 5 + 6);
  assert.equal(ratingOf(u, "y10"), 3);
  assert.equal(u.filmsFullAt, iso(now));
});

test("a film that rated-date shows and the cache does not know is kept, ahead of the rest", async () => {
  const now = dayWhere("u", false);
  const added = [...BEFORE, ["n", 4.5]]; // by/date page 1 is all known; n only turns up on rated-date
  const http = site("u", { added, ratedOrder: ["n", "a", "b", "c", "e", "f", "g"] });
  const u = cached({ now });
  const r = await F.readUserFilms({ u, user: "u", http, ...ctx({ now }) });
  assert.equal(r.mode, "incremental");
  assert.equal(slugs(u)[0], "n");
  assert.equal(u.films.length, 9);
});

test("a whole read that is partial (page 2 fails) is not a whole read: no filmsFullAt, no filmsHidden, retried tomorrow, whole", async () => {
  const http = site("u", { added: BEFORE, overrides: { [FULL(2)]: new Error("boom") } });
  const u = {}, c = ctx();
  const r = await F.readUserFilms({ u, user: "u", http, ...c });
  assert.equal(r.partial, true);
  assert.equal(u.filmsPartial, true);
  assert.equal(u.filmsFullAt, undefined);
  assert.equal(u.filmsHidden, undefined);
  assert.equal(F.filmsPlan(u, "u", c.now + DAY).mode, "full");
});

// ── an incremental read that does not reach its end ──────────────────────────

const AFTER_RERATE = BEFORE.map(([s, r]) => [s, ["c", "e", "f", "g"].includes(s) ? 1 : r]); // four films re-rated: rated-date = [c e f] [g a b] [d h]
const RERATE_ORDER = ["c", "e", "f", "g", "a", "b"];

test("rated-date page 2 fails one night: what came is kept, filmsAt stays, and the next night reads the whole history (g's new rating is not lost)", async () => {
  const now = dayWhere("u", false);
  const u = cached({ now }), at = u.filmsAt, c1 = ctx({ now });
  const night1 = site("u", { added: AFTER_RERATE, ratedOrder: RERATE_ORDER, overrides: { [BY_RATED(2)]: new Error("challenge") } });
  const r1 = await F.readUserFilms({ u, user: "u", http: night1, ...c1 });
  assert.equal(r1.partial, true);
  assert.equal(u.filmsAt, at, "an unfinished read does not count as a read");
  assert.equal(u.filmsNeedsFull, true);
  assert.equal(ratingOf(u, "f"), 1, "page 1 was merged");
  assert.equal(ratingOf(u, "g"), 5, "page 2 never came");
  assert.match(c1.problems.join("\n"), /incremental read stopped after 2 page\(s\)/);
  assert.equal(F.filmsPlan(u, "u", now + DAY).mode, "full");
  assert.match(F.filmsPlan(u, "u", now + DAY).why, /did not finish/);

  const night2 = site("u", { added: AFTER_RERATE, ratedOrder: RERATE_ORDER });
  const r2 = await F.readUserFilms({ u, user: "u", http: night2, ...ctx({ now: now + DAY }) });
  assert.equal(night2.calls[0], FULL(1));
  assert.equal(r2.mode, "full");
  assert.equal(ratingOf(u, "g"), 1);
  assert.equal(u.filmsNeedsFull, undefined, "a whole read that succeeds clears the mark");
  assert.equal(u.filmsFullAt, iso(now + DAY));
});

for (const ordering of ["date", "rated-date"]) {
  test(`${ordering} page 2 answers 404: preserve partial news and force a whole retry, including ratings beyond the missing page`, async () => {
    const now = dayWhere("u", false);
    const added = ordering === "date" ? [["n", 4], ...AFTER_RERATE] : AFTER_RERATE;
    const missing = ordering === "date" ? BY_DATE(2) : BY_RATED(2);
    const u = cached({ now }), at = u.filmsAt, c = ctx({ now });
    const first = site("u", { added, ratedOrder: RERATE_ORDER, overrides: { [missing]: { status: 404, text: "" } } });
    const result = await F.readUserFilms({ u, user: "u", http: first, ...c });
    assert.equal(result.partial, true);
    assert.equal(u.filmsAt, at);
    assert.equal(u.filmsNeedsFull, true);
    assert.equal(ratingOf(u, "g"), 5, "unread rating stays until the whole retry");
    assert.match(c.problems.join("\n"), /404/);
    if (ordering === "date") assert.equal(slugs(u)[0], "n");
    else assert.equal(ratingOf(u, "f"), 1);
    const next = site("u", { added, ratedOrder: RERATE_ORDER });
    const retry = await F.readUserFilms({ u, user: "u", http: next, ...ctx({ now: now + DAY }) });
    assert.equal(next.calls[0], FULL(1));
    assert.equal(retry.mode, "full");
    assert.equal(ratingOf(u, "g"), 1);
    assert.equal(u.filmsNeedsFull, undefined);
  });
}

test("a page with no film on it after the first is never 'every film known': in either ordering the read stops, keeps what came, and asks for a whole read", async () => {
  const now = dayWhere("u", false);
  const empty = (order, total) => page([], { total, next: `/u/films/by/${order}/page/3/` });
  // rated-date page 2 empty
  const u = cached({ now }), at = u.filmsAt, c = ctx({ now });
  const s = site("u", { added: AFTER_RERATE, ratedOrder: RERATE_ORDER, overrides: { [BY_RATED(2)]: empty("rated-date", 8) } });
  const r = await F.readUserFilms({ u, user: "u", http: s, ...c });
  assert.equal(r.partial, true);
  assert.equal(u.filmsAt, at);
  assert.equal(u.filmsNeedsFull, true);
  assert.equal(ratingOf(u, "f"), 1);
  assert.match(c.problems.join("\n"), /page 2 of \/films\/by\/rated-date\/ showed no film/);
  assert.ok(!s.calls.includes(BY_RATED(3)));
  // by/date page 2 empty, after a page with news
  const v = cached({ now }), c2 = ctx({ now });
  const s2 = site("u", { added: [["n", 4], ...BEFORE], overrides: { [BY_DATE(2)]: empty("date", 9) } });
  const r2 = await F.readUserFilms({ u: v, user: "u", http: s2, ...c2 });
  assert.equal(r2.partial, true);
  assert.equal(v.filmsAt, at);
  assert.equal(v.filmsNeedsFull, true);
  assert.equal(slugs(v)[0], "n", "page 1's news is kept");
  assert.match(c2.problems.join("\n"), /page 2 of \/films\/by\/date\/ showed no film/);
  assert.ok(!s2.calls.some((p) => p.includes("rated-date")));
});

test("an incremental read of an old record (no filmsHidden) that stops early pins the yardstick before the cache grows", async () => {
  const now = dayWhere("u", false);
  const added = [["n1", 4], ["n2", 4], ["n3", 4], ["n4", 4], ...BEFORE];
  const u = cached({ now }); delete u.filmsHidden; delete u.filmsFullAt; delete u.filmsMode;
  await F.readUserFilms({ u, user: "u", http: site("u", { added, overrides: { [BY_DATE(2)]: new Error("boom") } }), ...ctx({ now }) });
  assert.equal(u.films.length, 11);
  assert.equal(F.filmsPlan(u, "u", now + DAY).hidden, 0, "the page hides nothing; 8 − 11 would be nonsense");
  const next = site("u", { added });
  await F.readUserFilms({ u, user: "u", http: next, ...ctx({ now: now + DAY }) });
  assert.equal(next.calls[0], FULL(1));
  assert.equal(u.films.length, 12);
});

// ── a whole read that is short ───────────────────────────────────────────────

test("a whole read that comes up short against the page's count is stored but is not the yardstick: filmsHidden null, no filmsFullAt, the next due read is whole", async () => {
  const now = dayWhere("u", false);
  const u = {}, c = ctx({ now: now - 7 * DAY });
  await F.readUserFilms({ u, user: "u", http: site("u", { added: BEFORE, overrides: { [FULL(2)]: { status: 404, text: "" } } }), ...c });
  assert.equal(u.films.length, 3, "page 2 answered 404: three films of eight");
  assert.match(c.problems[0], /read 3 films but the page says 8/);
  assert.equal(u.filmsHidden, null);
  assert.equal(u.filmsFullAt, undefined);
  assert.equal(u.filmsPartial, false);
  assert.ok(u.filmsAt, "the rows and filmsAt are kept, as before");
  assert.equal(F.filmsPlan(u, "u", now).mode, "full");
  assert.match(F.filmsPlan(u, "u", now).why, /no whole read|hidden count unknown/);
  const week2 = site("u", { added: BEFORE });
  await F.readUserFilms({ u, user: "u", http: week2, ...ctx({ now }) });
  assert.equal(week2.calls[0], FULL(1));
  assert.equal(u.films.length, 8);
  assert.equal(u.filmsHidden, 0);
  assert.equal(u.filmsFullAt, iso(now));
});

// ── no Chrome ────────────────────────────────────────────────────────────────

test("no Chrome (routed() without a browser): every due history is read the v2 way, page 1 of /films/ by HTTP, merged; with a Chrome it is incremental", async () => {
  const { routed } = require("../lib/fetch-chrome");
  const now = dayWhere("u", false);
  const real = site("u", { added: [["n", 4], ...BEFORE] });
  const seen = [];
  const closed = { async get(url) { // as Cloudflare does: by/date, by/rated-date and /films/page/N/ are closed to HTTP
    const p = new URL(url).pathname; seen.push(p);
    if (/\/by\/|\/page\/\d+\/$/.test(p)) throw new F.BlockedError(url);
    return real.get(url);
  } };
  const u = cached({ now }), c = ctx({ now });
  const r = await F.readUserFilms({ u, user: "u", http: routed({ http: closed, chrome: null }), ...c });
  assert.deepEqual(seen, [FULL(1), FULL(2)], "page 1 of /films/ and the refused page 2; nothing of by/date");
  assert.equal(r.mode, "full");
  assert.equal(u.filmsPartial, true);
  assert.equal(slugs(u)[0], "n", "page 1 holds the news");
  assert.equal(u.films.length, 9, "merged over the cache, as in v2");
  assert.ok(F.stale(u.filmsAt, now + 25 * 3600e3, true), "retried tomorrow");

  const chromeSite = site("u", { added: [["n", 4], ...BEFORE] });
  const withChrome = routed({ http: closed, chrome: chromeSite });
  assert.equal(withChrome.viaChrome, true);
  const v = cached({ now });
  const r2 = await F.readUserFilms({ u: v, user: "u", http: withChrome, ...ctx({ now }) });
  assert.equal(r2.mode, "incremental");
  assert.equal(chromeSite.calls[0], BY_DATE(1));
});

// ── a count with hidden films ────────────────────────────────────────────────

test("a grid that hides 2 films: the incremental read trusts a count of 2, and a third hidden film makes it read the whole history", async () => {
  const now = dayWhere("u", false);
  const same = site("u", { added: BEFORE, hidden: 2 }), u = cached({ now, hidden: 2 });
  assert.equal((await F.readUserFilms({ u, user: "u", http: same, ...ctx({ now }) })).mode, "incremental");
  assert.equal(u.filmsHidden, 2);
  assert.equal(u.filmsTotal, 10);
  const more = site("u", { added: BEFORE, hidden: 3 }), v = cached({ now, hidden: 2 });
  assert.equal((await F.readUserFilms({ u: v, user: "u", http: more, ...ctx({ now }) })).mode, "full");
  assert.equal(v.filmsHidden, 3);
  // an old record (no filmsHidden): worked out from its count and the films it held
  const legacy = cached({ now, hidden: 2 }); delete legacy.filmsHidden; delete legacy.filmsMode;
  assert.equal(F.filmsPlan(legacy, "u", now).hidden, 2);
  const old = site("u", { added: BEFORE, hidden: 2 });
  assert.equal((await F.readUserFilms({ u: legacy, user: "u", http: old, ...ctx({ now }) })).mode, "incremental");
});

test("refreshFriends with force (--friends-refresh) reads the configured friends' histories whole, though they were read yesterday", async () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const now = dayWhere("u", false), dir = fs.mkdtempSync(path.join(os.tmpdir(), "friends-incr-"));
  const cfg = { friends: [{ user: "u", name: "U" }], friendLists: [] };
  const run = async (force) => {
    const s = site("u", { added: BEFORE }), cache = F.loadCache("/nonexistent");
    cache.users.u = cached({ now, at: 1 }); // read a day ago: not due without force
    await F.refreshFriends({ cfg, file: path.join(dir, "friends.json"), http: s, cache, force, limit: 0, log: () => {}, now, sleepImpl: noSleep });
    return s.calls.filter((p) => p.startsWith("/u/films"));
  };
  try {
    assert.deepEqual(await run(true), [FULL(1), FULL(2), FULL(3)]);
    assert.deepEqual(await run(false), [], "read yesterday: nothing asked");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── a layout change ──────────────────────────────────────────────────────────

test("a page that shows a count but none of its films stores nothing, says so, and fails the read (by/date first page, or rated-date first page)", async () => {
  const now = dayWhere("u", false);
  const empty = page([], { total: 40 });
  const snapshot = () => cached({ now });
  const first = site("u", { added: BEFORE, overrides: { [BY_DATE(1)]: empty } });
  const u = snapshot(), c = ctx({ now });
  assert.equal(await F.readUserFilms({ u, user: "u", http: first, ...c }), null);
  assert.deepEqual(u, snapshot());
  assert.match(c.problems[0], /u\/films\/by\/date: the page says 40 films but none could be read \(layout change\?\); kept the cache/);

  const second = site("u", { added: [["n", 4], ...BEFORE], overrides: { [BY_RATED(1)]: empty } });
  const v = snapshot(), c2 = ctx({ now });
  assert.equal(await F.readUserFilms({ u: v, user: "u", http: second, ...c2 }), null);
  assert.deepEqual(v, snapshot(), "the new film by/date found is not stored either");
  assert.match(c2.problems[0], /by\/rated-date: the page says 9 films but none could be read/);
});

// ── a page that fails ────────────────────────────────────────────────────────

test("an error on by/date page 2 keeps page 1's news, reports it, and leaves filmsAt alone so the next night tries again", async () => {
  const now = dayWhere("u", false);
  const http = site("u", { added: [["n", 4], ...BEFORE], overrides: { [BY_DATE(2)]: new Error("boom") } });
  const u = cached({ now }), c = ctx({ now }), at = u.filmsAt;
  const r = await F.readUserFilms({ u, user: "u", http, ...c });
  assert.equal(r.partial, true);
  assert.equal(r.mode, "incremental");
  assert.equal(u.filmsAt, at);
  assert.equal(u.filmsMode, "full", "the record still describes the last successful read");
  assert.equal(slugs(u)[0], "n");
  assert.equal(u.films.length, 9);
  assert.match(c.problems[0], /u\/films: incremental read stopped after 1 page\(s\) \(boom\)/);
  assert.ok(!http.calls.some((p) => p.includes("rated-date")));
  assert.ok(F.stale(u.filmsAt, now + 25 * 3600e3), "due again tomorrow");
});

test("an error on the first rated-date page keeps what by/date brought and leaves filmsAt alone", async () => {
  const now = dayWhere("u", false);
  const http = site("u", { added: [["n", 4], ...BEFORE], overrides: { [BY_RATED(1)]: new Error("down") } });
  const u = cached({ now }), c = ctx({ now }), at = u.filmsAt;
  const r = await F.readUserFilms({ u, user: "u", http, ...c });
  assert.equal(r.partial, true);
  assert.equal(u.filmsAt, at);
  assert.equal(slugs(u)[0], "n");
  assert.match(c.problems.join("\n"), /u\/films\/by\/rated-date: down/);
});

test("an error on the very first page changes nothing and is reported, as it always was", async () => {
  const now = dayWhere("u", false);
  const http = site("u", { added: BEFORE, overrides: { [BY_DATE(1)]: new F.BlockedError("x") } });
  const u = cached({ now }), c = ctx({ now });
  assert.equal(await F.readUserFilms({ u, user: "u", http, ...c }), null);
  assert.deepEqual(u, cached({ now }));
  assert.match(c.problems[0], /u\/films\/by\/date: .*403/);
});

// ── the crowd ────────────────────────────────────────────────────────────────

test("readCrowd counts the pages and how each history was read, and shows them in the progress line", async () => {
  const now = dayWhere("p1", false);
  const sites = { p1: site("p1", { added: BEFORE }), p2: site("p2", { added: BEFORE }) };
  const calls = [];
  const http = { async get(url) { const user = new URL(url).pathname.split("/")[1]; if (/watchlist/.test(url)) return { status: 200, text: "<html><body><ul class=\"grid\"></ul></body></html>", url }; calls.push(new URL(url).pathname); return sites[user].get(url); } };
  const cache = F.loadCache("/nonexistent");
  cache.users.p1 = cached({ now }); // already known: incremental, 2 pages
  const people = [{ user: "p1", name: "P1", configured: false }, { user: "p2", name: "P2", configured: false }];
  const lines = [];
  const c = ctx({ now });
  const r = await L.readCrowd({ cfg: { friends: [] }, cache, people, http, ...c, force: false, log: (l) => lines.push(l) });
  assert.equal(r.filmsRead, 2);
  assert.equal(r.filmsFull, 1, "p2 had nothing: whole (3 pages)");
  assert.equal(r.filmsIncremental, 1, "p1: 2 pages");
  assert.equal(r.filmsPagesRead, 5);
  assert.match(lines.join("\n"), /histories: 1 whole, 1 incremental, 5 pages/);
  assert.ok(!calls.includes("/p1/films/"), "p1's whole history was not asked for");
});

test("readCrowd with force (--friends-refresh) reads every history whole", async () => {
  const now = dayWhere("p1", false), s = site("p1", { added: BEFORE });
  const cache = F.loadCache("/nonexistent");
  cache.users.p1 = cached({ now });
  const http = { async get(url) { return /watchlist/.test(url) ? { status: 200, text: "<html><body><ul class=\"grid\"></ul></body></html>", url } : s.get(url); } };
  const r = await L.readCrowd({ cfg: { friends: [] }, cache, people: [{ user: "p1", name: "P1", configured: false }], http, ...ctx({ now }), force: true });
  assert.equal(r.filmsFull, 1);
  assert.equal(r.filmsIncremental, 0);
  assert.equal(s.calls[0], "/p1/films/");
});

test("the turn meets weekly reads: over 16 weekly reads every account is read whole exactly 4 times, 28 days apart", () => {
  // A one-day turn would line up with 1 weekly read in 7; the 7-day window must meet exactly one per cycle, for any start day.
  const names = Array.from({ length: 51 }, (_, i) => `member${i}`);
  for (const start of [0, 3, 6]) {
    for (const user of names) {
      let fullAt = BASE_DAY + start * DAY - 8 * DAY; // last whole read 8 days before the first weekly read
      const fulls = [];
      for (let w = 0; w < 16; w++) {
        const now = BASE_DAY + (start + w * 7) * DAY;
        const u = { films: [["a", "a", 2000, 4]], filmsAt: iso(now - 7 * DAY), filmsFullAt: iso(fullAt), filmsPartial: false, filmsHidden: 0 };
        if (F.filmsPlan(u, user, now).mode === "full") { fulls.push(w); fullAt = now; }
      }
      assert.equal(fulls.length, 4, `${user} start ${start}: whole reads at weeks ${fulls}`);
      for (let k = 1; k < fulls.length; k++) assert.equal(fulls[k] - fulls[k - 1], 4, `${user} start ${start}: whole reads at weeks ${fulls}`);
    }
  }
});
