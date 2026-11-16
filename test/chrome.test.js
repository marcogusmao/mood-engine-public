// node --test            (no dependencies)
// The Chrome reading layer (lib/fetch-chrome.js), proved against a stand-in Chrome (test-support/fake-chrome.js) that prints a page and
// then never exits, with a child process of its own — exactly what the real one does in some versions.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const C = require("../lib/fetch-chrome");
const F = require("../lib/friends");
const L = require("../lib/lists");

const FAKE = path.join(__dirname, "..", "test-support", "fake-chrome.js"); // outside test/: `node --test` would run it as a test
const tmp = (p = "mood-chrome-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const noSleep = async () => {};

/** An executable that runs the stand-in. Returns { exe, log, state, dir }. */
function fake() {
  const dir = tmp();
  const exe = path.join(dir, "chrome");
  fs.writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const log = path.join(dir, "calls.log"), state = path.join(dir, "state");
  fs.mkdirSync(state);
  process.env.FAKE_LOG = log;
  process.env.FAKE_STATE = state;
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { exe, dir, calls, done: () => { delete process.env.FAKE_LOG; delete process.env.FAKE_STATE; rm(dir); } };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return fn();
}
const make = (f, o = {}) => C.makeChrome({ chrome: f.exe, sleepImpl: noSleep, gapMs: 0, profileRoot: path.join(f.dir, "profiles"), ...o });

test("a page is returned as soon as </html> arrives, and the whole process group (Chrome and its child) is killed — it never exits by itself", async () => {
  const f = fake();
  try {
    const chrome = make(f);
    const r = await chrome.get("https://letterboxd.com/ok/");
    assert.equal(r.status, 200);
    assert.match(r.text, /data-item-slug="a"/);
    const start = f.calls().find((c) => c.event === "start");
    assert.ok(start.pid && start.child);
    assert.ok(await until(() => !alive(start.pid) && !alive(start.child)), "Chrome or its child is still running after the page was read");
  } finally { f.done(); }
});

test("a Chrome that sends nothing is killed after the time limit (with its child), and the call fails instead of hanging", async () => {
  const f = fake();
  try {
    const chrome = make(f, { timeoutMs: 700, retries: 0 });
    await assert.rejects(chrome.get("https://letterboxd.com/hang/"), /sent no page in 1 s|could not read/);
    const start = f.calls().find((c) => c.event === "start");
    assert.ok(await until(() => !alive(start.pid) && !alive(start.child)), "the hung Chrome was not killed");
  } finally { f.done(); }
});

test("a Chrome that exits without a page is a failed try, retried; a Letterboxd 'Not Found' page is status 404, not an error", async () => {
  const f = fake();
  try {
    const chrome = make(f, { retries: 1 });
    await assert.rejects(chrome.get("https://letterboxd.com/exits/"), /could not read/);
    assert.equal(f.calls().filter((c) => c.event === "start").length, 2); // the try and its one retry
    const r = await chrome.get("https://letterboxd.com/missing/");
    assert.equal(r.status, 404);
    assert.equal(r.text, "");
  } finally { f.done(); }
});

test("a Cloudflare challenge that does not give way is a BlockedError; after 3 in a row nothing more is asked this run", async () => {
  const f = fake();
  try {
    const chrome = make(f, { retries: 0, circuit: 3 });
    for (let i = 0; i < 3; i++) await assert.rejects(chrome.get(`https://letterboxd.com/challenge/?n=${i}`), (e) => e instanceof F.BlockedError);
    const before = f.calls().filter((c) => c.event === "start").length;
    await assert.rejects(chrome.get("https://letterboxd.com/ok/"), (e) => e instanceof F.BlockedError);
    assert.equal(f.calls().filter((c) => c.event === "start").length, before, "a fourth page was asked for after three refusals");
    assert.equal(chrome.stats.blocked, 3); // the fourth was refused by the breaker, not by Letterboxd
  } finally { f.done(); }
});

test("a challenge page on the first try is retried in the other mode (--timeout first, --virtual-time-budget second) and then read", async () => {
  const f = fake();
  try {
    const chrome = make(f, { retries: 2 });
    const r = await chrome.get("https://letterboxd.com/flaky/");
    assert.equal(r.status, 200);
    const starts = f.calls().filter((c) => c.event === "start");
    assert.equal(starts.length, 2);
    assert.ok(starts[0].args.includes("--timeout=20000") && !starts[0].args.some((a) => a.startsWith("--virtual-time-budget")));
    assert.ok(starts[1].args.includes("--virtual-time-budget=15000") && !starts[1].args.some((a) => a.startsWith("--timeout")));
    for (const flag of ["--headless=new", "--disable-gpu", "--dump-dom"]) assert.ok(starts[0].args.includes(flag), flag);
    assert.equal(starts[0].args.includes("--no-sandbox"), process.platform !== "darwin", "the sandbox is kept on macOS only (21/10/2026)");
    assert.ok(starts[0].args.some((a) => a.startsWith("--user-agent=Mozilla/5.0 (X11; Linux x86_64)")));
    assert.equal(starts[0].args.at(-1), "https://letterboxd.com/flaky/");
    assert.equal(chrome.stats.retried, 1);
  } finally { f.done(); }
});

// 21/10/2026 — the nightly moved to Marco's Mac. What broke: lib/fetch-chrome.js:120 always passed --no-sandbox, and spawn() gave the browser the whole environment of build.js,
// TMDB_TOKEN included, so a hostile page ran unsandboxed, as Marco, next to the key. Now: no --no-sandbox on macOS, and no variable that names a secret reaches the browser.
test("on macOS Chrome keeps its sandbox; elsewhere (the runner) it gets --no-sandbox", () => {
  const args = (platform) => C.chromeArgs({ profile: "/tmp/p", url: "https://letterboxd.com/", platform });
  assert.ok(!args("darwin").includes("--no-sandbox"));
  assert.ok(args("linux").includes("--no-sandbox"));
  assert.ok(args("darwin").includes("--headless=new") && args("darwin").includes("--dump-dom"), "the rest of the flags are the same");
});

test("the browser gets the environment without TMDB_TOKEN, TMDB_API_KEY or a GitHub token, and with what it needs (PATH, HOME, LANG)", () => {
  const e = C.chromeEnv({ PATH: "/usr/bin", HOME: "/h", LANG: "C", TMDB_TOKEN: "t", TMDB_API_KEY: "k", GH_TOKEN: "g", GITHUB_TOKEN: "g2", MY_SECRET: "s", DB_PASSWORD: "p" });
  assert.deepEqual(Object.keys(e).sort(), ["HOME", "LANG", "PATH"]);
});

test("a spawned Chrome really receives no secret in its environment (positive control: with env = process.env it does)", async () => {
  const f = fake();
  const planted = { TMDB_TOKEN: "canario-tmdb", TMDB_API_KEY: "canario-key", GH_TOKEN: "canario-gh" };
  Object.assign(process.env, planted);
  try {
    await make(f).get("https://letterboxd.com/ok/");
    const limpo = f.calls().find((c) => c.event === "start");
    assert.deepEqual(limpo.secrets, [], "Chrome received a variable that names a secret");
    assert.ok(limpo.args.length > 0 && (process.platform === "darwin" ? !limpo.args.includes("--no-sandbox") : limpo.args.includes("--no-sandbox")));
    // the instrument sees the defect: handing over the whole environment shows the three names
    await make(f, { env: process.env }).get("https://letterboxd.com/ok/?control=1");
    const sujo = f.calls().filter((c) => c.event === "start").at(-1);
    assert.deepEqual(sujo.secrets.filter((k) => k in planted).sort(), Object.keys(planted).sort());
  } finally { for (const k of Object.keys(planted)) delete process.env[k]; f.done(); }
});

test("at most 2 Chromes at once, each with its own profile folder", async () => {
  const f = fake();
  try {
    const chrome = make(f, { slots: 2 });
    await Promise.all([1, 2, 3, 4].map((n) => chrome.get(`https://letterboxd.com/slow/?n=${n}`)));
    const calls = f.calls();
    let open = 0, max = 0;
    for (const c of calls.filter((c) => c.event === "start" || c.event === "printed").sort((a, b) => a.at - b.at)) {
      open += c.event === "start" ? 1 : -1;
      max = Math.max(max, open);
    }
    assert.equal(max, 2);
    const profiles = new Set(calls.filter((c) => c.event === "start").map((c) => c.args.find((a) => a.startsWith("--user-data-dir="))));
    assert.equal(profiles.size, 2, "two slots, two profile folders");
  } finally { f.done(); }
});

test("a page that loads its film grid by script ('Calculating…' and a data-src) is followed to the fragment, and the fragment is the grid", async () => {
  const f = fake();
  try {
    const chrome = make(f);
    const r = await chrome.get("https://letterboxd.com/films/popular/this/week/shell/"); // the stand-in answers "shell" for this path
    assert.deepEqual(F.parsePosters(r.text).map((p) => p.slug), ["one", "two"]);
    const urls = f.calls().filter((c) => c.event === "start").map((c) => c.args.at(-1));
    assert.deepEqual(urls, ["https://letterboxd.com/films/popular/this/week/shell/", "https://letterboxd.com/csi/films/films-browser-list/popular/this/week/?esiAllowFilters=true"]);
  } finally { f.done(); }
});

test("lazyGridPath: only a page with no poster of its own and a films-browser-list data-src; &amp; is decoded", () => {
  const shell = '<div class="csi js-csi" data-src="/csi/films/films-browser-list/popular/this/week/?a=1&amp;b=2">Calculating…</div>';
  assert.equal(C.lazyGridPath(shell), "/csi/films/films-browser-list/popular/this/week/?a=1&b=2");
  assert.equal(C.lazyGridPath(shell + '<div data-item-slug="x"></div>'), null);
  assert.equal(C.lazyGridPath('<div data-src="/csi/other/thing/">x</div>'), null);
});

test("which addresses go through Chrome: a member's /films/ pages, /following/ pages and Popular this week — nothing else", () => {
  const yes = ["https://letterboxd.com/friend-c/films/", "https://letterboxd.com/friend-c/films/page/3/", "https://letterboxd.com/mgusmao/following/", "https://letterboxd.com/mgusmao/following/page/2/", "https://letterboxd.com/films/popular/this/week/"];
  const no = ["https://letterboxd.com/friend-c/watchlist/", "https://letterboxd.com/friend-c/watchlist/page/2/", "https://letterboxd.com/friend-c/rss/", "https://letterboxd.com/film/perfect-days/", "https://letterboxd.com/friend-c/list/br/", "https://letterboxd.com/official/list/letterboxds-top-500-films/page/2/", "not a url"];
  for (const u of yes) assert.equal(C.needsChrome(u), true, u);
  for (const u of no) assert.equal(C.needsChrome(u), false, u);
});

test("the incremental history read: by/date and by/rated-date go through Chrome, with or without page/N; other orderings and other sites of the same shape do not", () => {
  const yes = ["https://letterboxd.com/friend-c/films/by/date/", "https://letterboxd.com/friend-c/films/by/date/page/2/", "https://letterboxd.com/friend-c/films/by/rated-date/", "https://letterboxd.com/friend-c/films/by/rated-date/page/4/"];
  const no = ["https://letterboxd.com/friend-c/films/by/popular/", "https://letterboxd.com/friend-c/films/by/popular/page/2/", "https://letterboxd.com/friend-c/films/by/date/page/", "https://letterboxd.com/friend-c/films/by/rated-date/extra/", "https://letterboxd.com/films/by/date/", "https://letterboxd.com/friend-c/watchlist/by/date/"];
  for (const u of yes) assert.equal(C.needsChrome(u), true, u);
  for (const u of no) assert.equal(C.needsChrome(u), false, u);
  const seen = [];
  const r = C.routed({ http: { get: async (u) => { seen.push(["http", u]); return { status: 200, text: "", url: u }; } }, chrome: { get: async (u) => { seen.push(["chrome", u]); return { status: 200, text: "", url: u }; } } });
  return Promise.all([r.get(yes[0]), r.get(yes[3]), r.get(no[0])]).then(() => assert.deepEqual(seen.map((s) => s[0]), ["chrome", "chrome", "http"]));
});

test("routed: Chrome for the closed routes, HTTP for the rest; with no Chrome everything goes by HTTP", async () => {
  const seen = [];
  const http = { get: async (u) => { seen.push(["http", u]); return { status: 200, text: "", url: u }; } };
  const chrome = { get: async (u) => { seen.push(["chrome", u]); return { status: 200, text: "", url: u }; } };
  const r = C.routed({ http, chrome });
  await r.get("https://letterboxd.com/a/films/page/2/");
  await r.get("https://letterboxd.com/a/watchlist/");
  await r.get("https://letterboxd.com/film/x/");
  await C.routed({ http, chrome: null }).get("https://letterboxd.com/a/films/page/2/");
  assert.deepEqual(seen.map((s) => s[0]), ["chrome", "http", "http", "http"]);
});

test("classify: a challenge, a Letterboxd 404, an empty page and a real one", () => {
  assert.equal(C.classify("<html><head><title>Just a moment...</title></head><body></body></html>"), "challenge");
  assert.equal(C.classify("<html><head><title>Letterboxd - Not Found</title></head><body>" + " ".repeat(400) + "</body></html>"), "notfound");
  assert.equal(C.classify("<html><head><title>Letterboxd - Forbidden</title></head><body>" + " ".repeat(400) + "</body></html>"), "notfound"); // a private page
  assert.equal(C.classify("<html></html>"), "empty");
  assert.equal(C.classify("<html><head><title>William Kim’s films • Letterboxd</title></head><body>" + "x".repeat(400) + "</body></html>"), "ok");
  // a normal page that merely has Cloudflare's script on it is not a challenge
  assert.equal(C.classify('<html><head><title>Films</title></head><body><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>' + "x".repeat(400) + "</body></html>"), "ok");
});

test("findChrome: CHROME_PATH first, then the Mac app, then the usual names on the PATH; null when there is none", () => {
  const has = (...paths) => (p) => paths.includes(p);
  assert.equal(C.findChrome({ env: { CHROME_PATH: "/opt/c" }, exists: has("/opt/c", C.MAC_CHROME), pathDirs: [] }), "/opt/c");
  assert.equal(C.findChrome({ env: {}, exists: has(C.MAC_CHROME), pathDirs: [] }), C.MAC_CHROME);
  assert.equal(C.findChrome({ env: {}, exists: has("/usr/bin/google-chrome"), pathDirs: ["/bin", "/usr/bin"] }), "/usr/bin/google-chrome");
  assert.equal(C.findChrome({ env: {}, exists: has(), pathDirs: ["/usr/bin"] }), null);
});

// ── the pages Chrome reads, through the same crawl as the plain ones ─────────

const followingPage = (names, next) => `<html><body>${names.map((n) => `<h3 class="title-3"><a href="/${n}/" class="name">Name ${n}</a></h3>`).join("")}${next ? `<a class="next" href="${next}">Older</a>` : ""}</body></html>`;

test("/following/ across three pages: every person once, in order, and a repeated one is not counted twice", async () => {
  const pages = {
    "/me/following/": followingPage(["ana", "bia"], "/me/following/page/2/"),
    "/me/following/page/2/": followingPage(["caio", "ana"], "/me/following/page/3/"),
    "/me/following/page/3/": followingPage(["duda"], null),
  };
  const asked = [];
  const http = { get: async (u) => { asked.push(new URL(u).pathname); return { status: 200, text: pages[new URL(u).pathname], url: u }; } };
  const r = await F.crawl(http, "/me/following/", L.parseFollowingPage, { sleepImpl: noSleep, maxPages: 40 });
  assert.deepEqual(r.items.map((i) => i.user), ["ana", "bia", "caio", "duda"]);
  assert.equal(r.pages, 3);
  assert.equal(r.partial, false);
  assert.deepEqual(asked, Object.keys(pages));
});

const fx = (n) => fs.readFileSync(path.join(__dirname, "fixtures", n), "utf8");

test("pages exactly as Chrome dumped them on 10/10/2026: /following/ page 2 (names, 'Next' link) and a /films/ page 2 (ratings, the member's count, the Older link)", () => {
  const follow = fx("following-page-chrome.html"); // page 2 of mgusmao's /following/, trimmed to 3 people
  assert.deepEqual(L.parseFollowingPage(follow).map((p) => [p.user, p.name]), [["mscorsese", "Martin Scorsese"], ["benreiss", "a friend"], ["girlactress", "girlactress"]]);
  assert.equal(F.parseNext(follow), "/mgusmao/following/page/3/");
  const films = fx("films-page-chrome.html"); // page 2 of friend-a's /films/
  assert.deepEqual(F.parseFilmsPage(films).map((i) => [i.slug, i.year, i.rating]), [
    ["nosferatu-2024", 2024, 4], ["wicked-2024", 2024, 4], ["radical-love-the-life-and-legacy-of-satish", 2024, 3.5], ["smile-2-2024", 2024, 4], ["looking-she-said-i-forget", 2024, null],
  ]);
  assert.equal(F.parseFilmsTotal(films), 1696);
  assert.equal(F.parseNext(films), "/friend-a/films/page/3/");
});

test("/films/ total: the page's own count (title=\"1,696&nbsp;films\" on Watched), null when absent", () => {
  assert.equal(F.parseFilmsTotal('<h1 class="section-heading"><span class="tooltip" title="1,696&nbsp;films">Watched</span></h1>'), 1696);
  assert.equal(F.parseFilmsTotal('<span class="tooltip" title="1 film">Watched</span>'), 1);
  assert.equal(F.parseFilmsTotal("<html></html>"), null);
});
