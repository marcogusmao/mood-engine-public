// lists[].top (Marco, 22/10/2026 ~06:45 UTC: "eu quero que voce pega os top 250 das listas", about the lists of the TSPDT): only the first N films of a Letterboxd list
// enter, in the curator's order; the page is read up to the one that holds the Nth film; the cache keeps N; a changed cut reads the list again at once.
// Every test here fails if the named defect is put back (test-support/tspdt-mutations.js plants them in a copy).
const test = require("node:test");
const a = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const L = require("../lib/lists");
const F = require("../lib/friends");
const LW = require("../lib/list-signal");

const noSleep = async () => {};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "list-top-"));
const NOW = Date.parse("2026-10-22T07:00:00Z");

/** A Letterboxd list page: films `from`..`to` of a list of `total`, 100 a page, with the "Older" link on every page but the last. */
function page(base, n, total, size = 100, offset = 0) {
  const from = (n - 1) * size + 1 + offset, to = Math.min(n * size, total) + offset;
  const li = (i) => `<li class="posteritem"><div class="react-component" data-item-name="Film ${i} (${1900 + (i % 100)})" data-item-slug="film-${i}"><img alt="Film ${i}"/></div></li>`;
  const items = Array.from({ length: Math.max(0, to - from + 1) }, (_, k) => li(from + k)).join("\n");
  const next = to < total + offset ? `<div class="pagination"><a class="next" href="${base}page/${n + 1}/">Older</a></div>` : "";
  return `<html><head><meta property="og:title" content="The Big List"><meta name="description" content="A list of ${total.toLocaleString("en-US")} films compiled on Letterboxd, including Film 1."></head><body><ul class="poster-list -p125 -grid">\n${items}\n</ul>${next}</body></html>`;
}
/** fake http for one list of `total` films at /u/list/big/ */
function site(total, { failFrom = null, base = "/u/list/big/", offset = 0 } = {}) {
  return {
    calls: [],
    async get(url) {
      this.calls.push(url);
      const p = new URL(url).pathname;
      const m = p.match(/^\/u\/list\/big\/(?:page\/(\d+)\/)?$/);
      if (!m) return { status: 404, text: "", url };
      const n = Number(m[1] || 1);
      if (failFrom && n >= failFrom) throw new Error("HTTP 500");
      if (n > Math.ceil(total / 100)) return { status: 404, text: "", url };
      return { status: 200, text: page(base, n, total, 100, offset), url };
    },
  };
}
const entry = (over = {}) => ({ id: "big", name: "Big", url: "https://letterboxd.com/u/list/big/", trust: "critic", ...over });
const read = (cfgList, http, file, now = NOW, extra = {}) => L.refreshLists({ cfg: { lists: [cfgList] }, file, http, now, sleepImpl: noSleep, gapMs: 0, ...extra });
const slugs = (l) => l.items.map((i) => i.slug);

test("top: 250 on a list of 1,000 reads three pages, keeps the first 250 in the page's order and stops there (control: without the cut, ten pages and 1,000)", async () => {
  const dir = tmp();
  const http = site(1000);
  const r = await read(entry({ top: 250 }), http, path.join(dir, "lists.json"));
  const l = r.lists[0];
  a.equal(l.items.length, 250);
  a.equal(l.items[0].slug, "film-1"); a.equal(l.items[99].slug, "film-100", "the end of page 1"); a.equal(l.items[100].slug, "film-101", "the start of page 2: pagination respected");
  a.equal(l.items[249].slug, "film-250", "the 250th is the 50th of page 3");
  a.ok(!slugs(l).includes("film-251"), "film 251 sits on page 3 too and is cut");
  a.deepEqual(http.calls.map((u) => new URL(u).pathname), ["/u/list/big/", "/u/list/big/page/2/", "/u/list/big/page/3/"], "three pages, not ten");
  a.deepEqual(r.problems, [], r.problems.join("|"));
  a.equal(l.total, 250, "the list holds 250 for us; build.js reads `items < total` as a partial read");
  a.equal(JSON.parse(fs.readFileSync(path.join(dir, "lists.json"), "utf8")).lists.big.items.length, 250, "the cache keeps 250");

  const whole = site(1000);
  const w = await read(entry(), whole, path.join(dir, "whole.json"));
  a.equal(w.lists[0].items.length, 1000); a.equal(whole.calls.length, 10);
  a.deepEqual(slugs(w.lists[0]).slice(0, 250), slugs(l), "the cut is the head of the whole list, same order");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("top: a cut that falls on a page boundary (200) reads two pages; a list shorter than the cut enters whole and raises no problem", async () => {
  const dir = tmp();
  const two = site(1000);
  const r = await read(entry({ top: 200 }), two, path.join(dir, "a.json"));
  a.equal(r.lists[0].items.length, 200); a.equal(two.calls.length, 2, "the 200th film is the last of page 2: the third page is not asked");
  const short = site(50);
  const s = await read(entry({ top: 250 }), short, path.join(dir, "b.json"));
  a.equal(s.lists[0].items.length, 50); a.equal(s.lists[0].total, 50); a.deepEqual(s.problems, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("top: a read that stops short of the cut is named (100 of 250), a healthy cut raises no 'read 250 of 1000' alarm", async () => {
  const dir = tmp();
  const broken = site(1000, { failFrom: 2 }); // page 2 unreachable
  const r = await read(entry({ top: 250 }), broken, path.join(dir, "a.json"));
  a.equal(r.lists[0].items.length, 100);
  a.ok(r.problems.some((p) => /list big .*read 100 of 250 films/.test(p)), r.problems.join("|"));
  a.ok(r.problems.some((p) => /the rest is unreachable/.test(p)));
  const ok = await read(entry({ top: 250 }), site(1000), path.join(dir, "b.json"));
  a.ok(!ok.problems.some((p) => /read \d+ of/.test(p)), "250 of 250 is no problem");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("top: a changed cut reads the list again at once (250 → 100, none → 250), inside the 7 days", async () => {
  const dir = tmp(), file = path.join(dir, "lists.json");
  await read(entry({ top: 250 }), site(1000), file);
  const same = site(1000);
  await read(entry({ top: 250 }), same, file, NOW + 864e5);
  a.equal(same.calls.length, 0, "the same cut, one day later: the cache is fresh");
  const narrower = site(1000);
  const r = await read(entry({ top: 100 }), narrower, file, NOW + 864e5);
  a.equal(narrower.calls.length, 1, "100 is read again, one page");
  a.equal(r.lists[0].items.length, 100); a.equal(r.lists[0].total, 100);
  const widened = site(1000);
  const w = await read(entry({ top: 250 }), widened, file, NOW + 2 * 864e5);
  a.equal(widened.calls.length, 3); a.equal(w.lists[0].items.length, 250);
  const dropped = site(1000);
  const d = await read(entry(), dropped, file, NOW + 3 * 864e5);
  a.equal(dropped.calls.length, 10, "no cut any more: the whole list is read again"); a.equal(d.lists[0].items.length, 1000); a.equal(d.lists[0].total, 1000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("top: --cache-only asks nobody and still gives the cut, even over a longer cache written before the cut existed", async () => {
  const dir = tmp(), file = path.join(dir, "lists.json");
  await read(entry(), site(1000), file); // the whole list, as the nightly wrote it before the cut
  const none = site(1000);
  const r = await read(entry({ top: 250 }), none, file, NOW + 99 * 864e5, { cacheOnly: true });
  a.equal(none.calls.length, 0);
  a.equal(r.lists[0].items.length, 250); a.equal(r.lists[0].items[249].slug, "film-250"); a.equal(r.lists[0].total, 250);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("top: a partial read keeps at most N films, the new ones first and the older cached rows behind them", async () => {
  const dir = tmp(), file = path.join(dir, "lists.json");
  await read(entry({ top: 250 }), site(1000), file);
  const flaky = site(1000, { failFrom: 3 }); // pages 1 and 2 arrive, page 3 does not: the same films, so 200 new + the 50 older rows the new read did not reach
  const r = await read(entry({ top: 250 }), flaky, file, NOW + 8 * 864e5);
  a.equal(r.lists[0].partial, true);
  a.equal(r.lists[0].items.length, 250);
  a.deepEqual(slugs(r.lists[0]).slice(0, 3), ["film-1", "film-2", "film-3"]);
  // the curator reordered: the new pages share no film with the cache. 200 new + 250 older rows are 450; the cut keeps the first 250
  const file2 = path.join(dir, "lists2.json");
  await read(entry({ top: 250 }), site(1000), file2);
  const moved = site(1000, { failFrom: 3, offset: 5000 });
  const m = await read(entry({ top: 250 }), moved, file2, NOW + 8 * 864e5);
  a.equal(m.lists[0].items.length, 250, "not 450");
  a.equal(m.lists[0].items[0].slug, "film-5001"); a.equal(m.lists[0].items[199].slug, "film-5200"); a.equal(m.lists[0].items[200].slug, "film-1", "the older rows follow the 200 new ones");
  a.equal(JSON.parse(fs.readFileSync(file2, "utf8")).lists.big.items.length, 250, "and the cache keeps 250 too");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("top: the config accepts a whole number of films and refuses 0, 2.5, '250', a static list and 'Popular this week'", () => {
  const ok = { id: "x", name: "X", url: "https://letterboxd.com/u/list/x/", trust: "fan" };
  a.doesNotThrow(() => LW.validateLists([{ ...ok, top: 250 }]));
  for (const bad of [0, -1, 2.5, "250", null, true]) a.throws(() => LW.validateLists([{ ...ok, top: bad }]), /top must be a whole number of films, 1 or more/, String(bad));
  a.throws(() => LW.validateLists([{ ...ok, top: 10, source: "static", file: "data/lists/x.json" }]), /a static list is cut in its own file/);
  a.throws(() => LW.validateLists([{ ...ok, top: 10, popular: true }]), /does not apply to "Popular this week"/);
  a.equal(L.topOf({ top: 250 }), 250); a.equal(L.topOf({}), null); a.equal(L.topOf({ top: 0 }), null); a.equal(L.topOf({ top: 2.5 }), null); a.equal(L.topOf({ top: "250" }), null); a.equal(L.topOf(null), null);
});
