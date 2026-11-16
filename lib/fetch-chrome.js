// Reading layer for the Letterboxd pages a plain HTTP request cannot reach.
//
// On 10/10/2026 Cloudflare answered 403 (a JavaScript challenge) to every script on /<user>/films/page/N/ (N ≥ 2),
// /<user>/following/page/N/ (N ≥ 2) and /films/popular/this/week/. A real Chrome, headless, passes all of them without a
// login and without a cookie: it runs the challenge's JavaScript like any visitor. So those routes, and only those, are read
// through `chrome --headless=new --dump-dom <url>`; everything else (watchlists, lists, film pages, RSS) stays on HTTP.
//
// Two facts measured the same day, both handled here:
//   - Chrome does not exit by itself after the dump in some versions. Each page is read in its own process group, the
//     stdout is read until </html>, and the whole group (Chrome and its helpers) is killed. A page that never arrives is
//     killed after `timeoutMs`.
//   - `--virtual-time-budget` never finishes on /films/popular/ (a pending request keeps virtual time from running out), while
//     `--timeout=20000` answers in 1–4 s on every route. So the first try uses --timeout; a retry uses the virtual-time mode.
//
// Politeness: 2 Chrome processes at most, each with its own profile folder (two Chromes cannot share one), a pause of
// ~700 ms after every page, retries with a growing wait, and after 3 refusals in a row nothing more is asked this run.

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { sleep, mapLimit } = require("./util");
const { BlockedError } = require("./friends");

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAX_BYTES = 20 * 1024 * 1024; // one page; Letterboxd's are 100–500 KB

/** The routes plain HTTP cannot reach (path only, no host). Everything else goes by HTTP. */
const CHROME_ROUTES = [
  /^\/[^/]+\/films\/(?:(?:by\/(?:date|rated-date)\/)?(?:page\/\d+\/)?)$/, // a member's watched history, page by page: the default order, and the two the incremental read uses (by/date: added, by/rated-date: rated)
  /^\/[^/]+\/following\/(?:page\/\d+\/)?$/, // who a member follows
  /^\/films\/popular\//, // Popular this week
];

const needsChrome = (url) => {
  let p;
  try { p = new URL(url).pathname; } catch { return false; }
  return CHROME_ROUTES.some((re) => re.test(p));
};

/** Where Chrome is: $CHROME_PATH, the Mac app, or one of the usual names on the PATH. → absolute path or null. */
function findChrome({ env = process.env, exists = fs.existsSync, pathDirs = String(env.PATH || "").split(path.delimiter) } = {}) {
  const names = [env.CHROME_PATH, MAC_CHROME, "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].filter(Boolean);
  for (const n of names) {
    if (path.isAbsolute(n)) { if (exists(n)) return n; continue; }
    for (const d of pathDirs) if (d && exists(path.join(d, n))) return path.join(d, n);
  }
  return null;
}

/** How the page that came back must be treated: "ok", "notfound" (a Letterboxd 404 page), "challenge" (Cloudflare's, not solved) or "empty". */
function classify(html) {
  const text = String(html || "");
  const title = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  if (/just a moment|attention required|access denied|verify you are human|checking your browser/i.test(title)) return "challenge";
  if (/enable javascript and cookies to continue/i.test(text) && !/<footer\b/i.test(text)) return "challenge";
  if (/\b(?:not found|forbidden)\b/i.test(title) && /letterboxd/i.test(title)) return "notfound"; // a missing page, or a private one ("Letterboxd - Forbidden"): absent either way
  if (!/<body\b/i.test(text) || text.length < 300) return "empty";
  return "ok";
}

/** The address of the grid a page loads by script, when the page has no poster of its own ("Calculating…"); null otherwise. */
function lazyGridPath(html) {
  if (/data-(?:item|film)-slug=/.test(html)) return null;
  const m = String(html).match(/data-src="(\/csi\/[^"]*films-browser-list[^"]*)"/);
  return m ? m[1].replace(/&amp;/g, "&") : null;
}

// ── one page, in a process group of its own ──────────────────────────────────

const active = new Set(); // pids of the Chromes alive right now: killed when this process ends
let exitHook = false;
const killGroup = (pid) => { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } };
function hookExit() {
  if (exitHook) return;
  exitHook = true;
  process.on("exit", () => { for (const pid of active) killGroup(pid); });
}

/**
 * Runs `command args` in a process group of its own, reads its stdout until </html> and kills the group.
 * Rejects when the process ends without a page, when it cannot be started, when nothing arrives in `timeoutMs` (45 s), or when the
 * page passes `maxBytes` (20 MB, the same cap as lib/friends.js makeHttp; added 13/10/2026: the deadline was here already, the cap was not).
 * `spawnImpl` is injected by the tests. `env` is the environment the browser gets (default: chromeEnv(), 21/10/2026).
 */
function dumpDom(command, args, { timeoutMs = 45000, maxBytes = MAX_BYTES, spawnImpl = spawn, env = chromeEnv() } = {}) {
  hookExit();
  return new Promise((resolve, reject) => {
    let child, out = "", bytes = 0, err = "", settled = false, timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child && child.pid) { killGroup(child.pid); active.delete(child.pid); }
      fn(value);
    };
    try {
      child = spawnImpl(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"], env });
    } catch (e) { return reject(e); }
    if (child.pid) active.add(child.pid);
    timer = setTimeout(() => finish(reject, new Error(`Chrome sent no page in ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    child.on("error", (e) => finish(reject, e));
    child.stdout.on("data", (d) => {
      bytes += Buffer.byteLength(d);
      if (bytes > maxBytes) return finish(reject, new Error(`Chrome sent more than ${maxBytes} bytes for one page`)); // a failed try, like the timeout
      out += d;
      if (/<\/html>\s*$/i.test(out)) finish(resolve, out);
    });
    child.stderr.on("data", (d) => { if (err.length < 2000) err += d; });
    child.on("close", () => finish(/<\/html>/i.test(out) ? resolve : reject, /<\/html>/i.test(out) ? out : new Error("Chrome ended without sending a page")));
  });
}

// ── the reader ───────────────────────────────────────────────────────────────

/**
 * What the browser inherits: this process's environment without anything that names a secret (the TMDB key of the build, a GitHub token...). Chrome opens
 * pages from the internet and needs none of them. Added 21/10/2026, when the nightly moved from a throw-away runner to Marco's Mac (README, "The nightly on the Mac", limit 5).
 */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|API_?KEY|CREDENTIAL)/i;
function chromeEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_NAME.test(k)) out[k] = v;
  return out;
}

/**
 * Arguments of one try. Try 0: --timeout (fast, works on every route); later tries: --virtual-time-budget (resolves a slow challenge).
 * `--no-sandbox` only where the sandbox cannot start (the Linux runner, a container, root); on macOS (`platform` "darwin") Chrome keeps its sandbox (21/10/2026).
 */
function chromeArgs({ profile, attempt = 0, ua = UA, url, platform = process.platform }) {
  return [
    "--headless=new", "--disable-gpu", ...(platform === "darwin" ? [] : ["--no-sandbox"]), "--disable-dev-shm-usage", "--no-first-run", "--mute-audio",
    `--user-data-dir=${profile}`, `--user-agent=${ua}`,
    ...(attempt === 0 ? ["--timeout=20000"] : ["--virtual-time-budget=15000"]),
    "--dump-dom", url,
  ];
}

/**
 * A Chrome reader with the same `get(url)` as lib/friends.js makeHttp(): → { status, text, url }.
 *   chrome      path of the executable (findChrome())
 *   slots       Chrome processes at once (2); each has its own profile folder, kept between pages so a solved challenge is remembered
 *   gapMs       pause after every page, before the slot is free again (700)
 *   retries     further tries after a failed one (3), with a wait of 1.5 s, 3 s, 6 s…; a challenge waits longer
 *   circuit     refusals in a row after which nothing more is asked (3)
 * 404 (Letterboxd's "Not Found" page) → status 404. A challenge that never gives way → BlockedError.
 */
function makeChrome({ chrome, slots = 2, gapMs = 700, retries = 3, circuit = 3, timeoutMs = 45000, sleepImpl = sleep, spawnImpl = spawn, ua = UA, platform = process.platform, env, profileRoot = path.join(os.tmpdir(), `mood-engine-chrome-${process.pid}`) } = {}) {
  if (!chrome) throw new Error("makeChrome needs the path of a Chrome executable");
  const free = Array.from({ length: slots }, (_, i) => path.join(profileRoot, `slot${i}`)), waiting = [];
  const stats = { pages: 0, retried: 0, failed: 0, blocked: 0 };
  let blocked = 0;
  const acquire = () => (free.length ? Promise.resolve(free.shift()) : new Promise((r) => waiting.push(r)));
  const release = (profile) => { const next = waiting.shift(); if (next) next(profile); else free.push(profile); };

  async function readOnce(url, profile) {
    let last = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let html;
      try {
        html = await dumpDom(chrome, chromeArgs({ profile, attempt, ua, url, platform }), { timeoutMs, spawnImpl, env });
      } catch (e) {
        last = e;
        stats.retried++;
        await sleepImpl(1500 * 2 ** attempt);
        continue;
      }
      const kind = classify(html);
      if (kind === "notfound") return { status: 404, text: "", url };
      if (kind === "ok") return { status: 200, text: html, url };
      last = kind === "challenge" ? new BlockedError(url) : new Error(`Chrome returned an empty page for ${url}`);
      stats.retried++;
      await sleepImpl(kind === "challenge" ? 5000 * (attempt + 1) : 1500 * 2 ** attempt);
    }
    throw last instanceof BlockedError ? last : new Error(`Chrome could not read ${url} after ${retries + 1} tries: ${last && last.message}`);
  }

  return {
    stats,
    /**
     * → { status, text, url }. 404 returns status 404; an unsolved challenge or three refusals in a row throw BlockedError.
     * A page whose film grid is loaded by script after the page (Popular this week shows "Calculating…" and a `data-src`
     * pointing at /csi/…/films-browser-list/…) is followed to that address: the fragment is the grid, and it is what comes back.
     */
    async get(url) {
      if (blocked >= circuit) throw new BlockedError(url);
      const profile = await acquire();
      try {
        fs.mkdirSync(profile, { recursive: true });
        let r = await readOnce(url, profile);
        const lazy = r.status === 200 ? lazyGridPath(r.text) : null;
        if (lazy) {
          const frag = await readOnce(new URL(lazy, url).href, profile);
          if (frag.status === 200) r = { status: 200, text: frag.text, url };
        }
        blocked = 0;
        stats.pages++;
        return r;
      } catch (e) {
        if (e instanceof BlockedError) { blocked++; stats.blocked++; }
        stats.failed++;
        throw e;
      } finally {
        await sleepImpl(gapMs);
        release(profile);
      }
    },
    /** Removes the profile folders. */
    close() { try { fs.rmSync(profileRoot, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}

/**
 * Routes each address: the ones in CHROME_ROUTES through `chrome`, the rest through `http`. Without a `chrome` everything goes
 * by `http`, and the routes Cloudflare closes to scripts come back partial, as they did in v2. A watchlist or list that HTTP is
 * refused on (a real Cloudflare challenge, not a private page) is tried once more through Chrome.
 */
function routed({ http, chrome }) {
  const lists = (url) => { try { return /\/(?:watchlist|list\/[^/]+)\//.test(new URL(url).pathname); } catch { return false; } };
  return {
    viaChrome: !!chrome,
    async get(url) {
      if (!chrome) return http.get(url);
      if (needsChrome(url)) return chrome.get(url);
      try { return await http.get(url); }
      catch (e) { if (e instanceof BlockedError && lists(url)) return chrome.get(url); throw e; }
    },
  };
}

module.exports = { makeChrome, routed, needsChrome, findChrome, classify, lazyGridPath, dumpDom, chromeArgs, chromeEnv, mapLimit, CHROME_ROUTES, UA, MAC_CHROME, MAX_BYTES };
