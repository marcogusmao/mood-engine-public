// Subtitles the official list lacks, downloaded with Marco's own OpenSubtitles account (Marco, 12/10/2026).
//
// The official addon's list (subtitles-source.js) misses some of the subtitles OpenSubtitles says were made for the playing file (Paterson: two of three). The REST search
// that finds the hash matches also gives their `file_id`; this module turns such a subtitle into a row (`moodsubs-os<file_id>`, address `/subfile/<file_id>/<exp>/<sig>.srt` on
// this Worker) and, when Stremio asks for that address, downloads it:
//
//   1. POST {api}/login {username, password}                     → token (valid ~24 h; limits 1 a second, 10 a minute, 30 an hour) and `base_url`
//   2. POST {base_url}/api/v1/download {file_id}                 → { link, remaining, reset_time_utc, … }; the free account's quota is 20 distinct files a
//                                                                  day (the same file again within 3 hours is not counted), reset at midnight UTC
//   3. GET link                                                  → the SRT (UTF-8), no authorization needed (OpenSubtitles staff, 24/03/2026)
//
// Who may use it. Only requests under the private address (/k/<SUBTITLES_PRIVATE_TOKEN>/, handler.js) list these rows, and the address of each carries a signature: the first 16 hex
// digits of HMAC-SHA256(a key derived from SUBTITLES_PRIVATE_TOKEN, `${file_id}\n${exp}`), where `exp` is the moment (epoch seconds, 10 digits) the address stops working: 30 days
// from the day it was listed, rounded up to the day (the same 30 days the subtitle is kept), so the address is the same all day and a cache can keep it. The key comes from the
// private token, never from the OpenSubtitles password. A bad signature, or an `exp` in the past, is a 404 before anything else happens. This limits who can spend Marco's quota
// to those who hold the private address or one of the signed rows it handed out (a row is a bearer address: whoever sees it can open it until `exp`, or until the token changes).
// The address with `exp` is the only one there is. The earlier one, `/subfile/<file_id>/<sig>.srt` (no `exp`, the file id alone signed, another key), was accepted for 30 days after
// 13/10/2026, until 2026-11-13T00:00Z, and was a 404 from that moment; its code was taken out on 14/11/2026 and it is still a 404, because the path does not match SUBFILE_PATH
// (test/subfile.test.js, "the address without an expiry…"). Marco did not fix the 30 days of `exp`: the choice is the session's (13/10/2026).
//
// State. Cloudflare's Cache API does keep entries on workers.dev (measured 13/10/2026), but per data centre and it may evict at any time, so what must outlive an isolate and be shared by all of them is in an optional Workers KV binding `SUBS` (wrangler.toml): the subtitle (30 days
// per file_id), the login token (about 20 hours, one fixed key), the time the quota comes back, a stamp for a failed login (10 minutes), and how many downloads in a row failed.
// Without the binding it is all in the isolate's memory: nothing breaks, a cold isolate just starts again (and may log in again: the login is limited to 30 an hour).
// The token is never a hash of the credentials, and no key anywhere is derived from them.
//
// Failures. A refused download (406 quota, 429, 5xx) is a 502 with a short reason in `X-Subfile`. The quota left (`remaining`, a number) is logged; the user name, the password, the
// token and the link are never logged and never in an answer. The day's counter (`os:remaining:<yyyy-mm-dd>` in KV, 19/10/2026) is written after every download answer that carries `remaining`; at 0
// the next download is a 502 'quota' with no call to OpenSubtitles, and one `opensubtitles-paused` event ({ until }, an ISO time) is logged; an answer with no `remaining` writes nothing and pauses nothing. The link is fetched only on https://*.opensubtitles.com or .org, redirects are followed by hand (each hop checked),
// and the body is cut at 2 MB while it streams. While the quota is out, the login is paused, or the last 3 downloads failed, handler.js stops listing the rows (offering()).
// Research and sources: stremio repository, .context/2026-10-12-opensubtitles-download.md.

import { API_HOST, readBoundedText, restBaseOf, TooBig } from "./subtitles-source.js";
import { ADDON_VERSION } from "./manifest.js";

/** /subfile/<file_id>/<exp>/<sig>.srt (exp: epoch seconds, 10 digits). Groups: file id, exp, signature. Nothing else is a subtitle address: without the `exp` it is a 404. */
export const SUBFILE_PATH = /^\/subfile\/(\d{1,12})\/(\d{10})\/([0-9a-f]{16})\.srt$/;
export const TOKEN_TTL_MS = 20 * 60 * 60e3; // the token lasts ~24 h; renewed with room to spare
export const FILE_TTL_MS = 30 * 24 * 60 * 60e3;
const DAY_MS = 24 * 60 * 60e3;
export const LOGIN_BACKOFF_MS = 10 * 60e3;
export const QUOTA_PAUSE_MS = 10 * 60e3; // when the answer does not say when the quota comes back
export const QUOTA_PAUSE_MAX_MS = 24 * 60 * 60e3;
export const HEALTH_TTL_MS = 60 * 60e3; // a run of failures is forgotten after an hour without news
export const FAILURES_TO_HIDE = 3;
export const FETCH_TIMEOUT_MS = 8000;
export const OFFERING_TIMEOUT_MS = 300;
export const MAX_SRT_BYTES = 2e6;
export const MAX_JSON_BYTES = 100e3;
export const KEYS = { token: "token:v1", quota: "quota:v1", loginFailed: "loginfail:v1", health: "health:v1", srt: (id) => `srt:${id}`, remaining: (day) => `os:remaining:${day}` };
/** The hosts a subtitle link may be on, and so the only ones a redirect may lead to. */
const LINK_HOST = /(?:^|\.)opensubtitles\.(?:com|org)$/;
const TEXT = new TextEncoder();
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** All four are needed: the account (user name, password), the API key, and the private token that signs the rows. Without them nothing about this exists. */
export const subfileConfigured = (env) => !!(env && env.OPENSUBTITLES_USERNAME && env.OPENSUBTITLES_PASSWORD && env.OPENSUBTITLES_API_KEY && env.SUBTITLES_PRIVATE_TOKEN);

// ── secrets compared and signatures ──────────────────────────────────────────

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Do two secrets match? Both are hashed first (whatever they are, so nothing is skipped for a wrong type or an empty one), then every byte of the hashes is compared, so neither
 * the length nor the first difference shows in the time. An empty or non-text secret never matches.
 */
export async function sameSecret(a, b) {
  const valid = typeof a === "string" && typeof b === "string" && a.length > 0 && b.length > 0; // (when not, two different texts are hashed instead, so the verdict below is false)
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", TEXT.encode(valid ? a : "")), crypto.subtle.digest("SHA-256", TEXT.encode(valid ? b : "-"))]);
  const p = new Uint8Array(x), q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0;
}

const DOMAIN = { v3: "mood-engine/subfile/v3\0" }; // (domain-separated: this key signs a file id with its expiry and nothing else; "v2" was the label of the address without an expiry, gone on 14/11/2026, and is not to be used again)
const keyMemo = new Map(); // domain → { token, key }
async function hmacKey(token, domain) {
  const memo = keyMemo.get(domain);
  if (memo && memo.token === token) return memo.key;
  const raw = await crypto.subtle.digest("SHA-256", TEXT.encode(`${domain}${token}`));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  keyMemo.set(domain, { token, key });
  return key;
}
const sign16 = async (token, domain, message) => hex(await crypto.subtle.sign("HMAC", await hmacKey(token, domain), TEXT.encode(message))).slice(0, 16);

/** Are two texts the same? Every character is compared, whatever the first difference; a different length or a non-text is false. */
function sameText(want, got) {
  if (typeof got !== "string" || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

/** The moment, in epoch seconds, an address listed at `nowMs` stops working: 30 days later, rounded up to the day (so it is the same all day). */
export function expiryFor(nowMs) {
  return Math.ceil((nowMs + FILE_TTL_MS) / DAY_MS) * (DAY_MS / 1000);
}

/** The 16 hex digits that go in the address of file `fileId` valid until `exp` (epoch seconds): HMAC of `${fileId}\n${exp}`, so neither can be changed without the token. */
export async function signFileUntil(token, fileId, exp) {
  return sign16(token, DOMAIN.v3, `${fileId}\n${exp}`);
}

/** Is `sig` the signature of `fileId` valid until `exp`, and is `exp` still in the future at `nowMs`? The signature is always computed and compared in full, even for an `exp` in the past. */
export async function verifyUntil(token, fileId, exp, sig, nowMs) {
  const signed = sameText(await signFileUntil(token, fileId, exp), sig);
  const live = /^\d{10}$/.test(String(exp)) && Number(exp) * 1000 > nowMs;
  return signed && live;
}

/** May the address that SUBFILE_PATH matched (`m`) be served at `nowMs`? Only when the signature covers its file id and its `exp`, and the `exp` has not passed. */
export async function linkIsGood(token, m, nowMs) {
  const [, fileId, exp, sig] = m;
  return verifyUntil(token, fileId, exp, sig, nowMs);
}

// ── the download ─────────────────────────────────────────────────────────────

/** An error whose message is a short reason and nothing else: it is logged, so it must never carry a token, a password or an address with one. */
class SubfileError extends Error {
  constructor(reason, { skipped = false } = {}) { super(reason); this.reason = reason; this.skipped = skipped; } // skipped: refused here, OpenSubtitles was not asked (nothing to record)
}
/** The failures that say OpenSubtitles (or its file host) is not working, as opposed to a quota, a login, or one bad file id. Three in a row hide the rows. */
const COUNTS_AS_FAILING = new Set(["busy", "download-failed", "no-link", "file-failed", "bad-file"]);
/** Of those, the ones that say the SERVICE is failing (429, 5xx, the network): only these stop download() from asking (19/10/2026). A bad file (no link, a page instead of a subtitle) is one file's problem: it hides the rows, it does not stop another file from opening. */
const SERVICE_FAILURES = new Set(["busy", "download-failed"]);

/** `href` (resolved against `base` when it is relative) as a URL, or null unless it is https on opensubtitles.com or .org, with no credentials and no port. */
const okLink = (href, base) => {
  try {
    const u = new URL(href, base);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && LINK_HOST.test(u.hostname) ? u : null;
  } catch { return null; }
};

export function createSubfileSource({ fetchImpl = (...a) => fetch(...a), now = Date.now, log = (o) => console.warn(JSON.stringify(o)), timeoutMs = FETCH_TIMEOUT_MS, offeringTimeoutMs = OFFERING_TIMEOUT_MS } = {}) {
  const mem = { files: new Map(), token: null, quotaUntil: 0, loginFailedAt: 0, fails: 0, serviceFails: 0, failsAt: 0, osPausedUntil: 0 };
  const inflight = new Map(); // file_id → promise: the same subtitle asked twice at once is downloaded once
  let loginInflight = null;
  const userAgent = `MoodEngine v${ADDON_VERSION}`;

  // ── the shared state: KV when it is bound, else only this isolate's memory ──
  const kvOf = (env) => (env && env.SUBS && typeof env.SUBS.get === "function" && typeof env.SUBS.put === "function" ? env.SUBS : null);
  async function kvGet(env, what, key, type = "text") {
    const kv = kvOf(env);
    if (!kv) return null;
    try { return await kv.get(key, type); } catch { log({ event: "subs-kv-failed", op: "get", what }); return null; }
  }
  async function kvPut(env, what, key, value, ttlMs) {
    const kv = kvOf(env);
    if (!kv) return;
    try { await kv.put(key, typeof value === "string" ? value : JSON.stringify(value), { expirationTtl: Math.max(60, Math.ceil(ttlMs / 1000)) }); } catch { log({ event: "subs-kv-failed", op: "put", what }); }
  }
  async function kvDelete(env, what, key) {
    const kv = kvOf(env);
    if (!kv || typeof kv.delete !== "function") return;
    try { await kv.delete(key); } catch { log({ event: "subs-kv-failed", op: "delete", what }); }
  }
  const stamp = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

  /** When the quota comes back (a time in ms), or 0. */
  async function quotaUntil(env) {
    return Math.max(mem.quotaUntil, stamp(await kvGet(env, "quota", KEYS.quota)));
  }
  /**
   * The day's counter (W5 of the 13/10/2026 plan, 19/10/2026): every download answer that says `remaining` is written to KV as `os:remaining:<yyyy-mm-dd>` = { remaining, until }, where
   * the day is the UTC date of the window the answer closes (the moment before `reset_time_utc`; the next midnight UTC when the answer gives none) and `until` is that reset moment in ms.
   * It lives until `until`. A counter at 0 or below pauses every download until `until`: the next one is not sent to OpenSubtitles at all (see download()).
   */
  async function recordRemaining(env, body, remaining) {
    const t = Date.parse(body && body.reset_time_utc);
    const until = Number.isFinite(t) && t > now() ? Math.min(t, now() + QUOTA_PAUSE_MAX_MS) : (Math.floor(now() / DAY_MS) + 1) * DAY_MS;
    mem.osPausedUntil = remaining <= 0 ? until : 0;
    await kvPut(env, "remaining", KEYS.remaining(utcDay(until - 1)), { remaining, until }, until - now());
  }
  /** Until when OpenSubtitles must not be asked (a time in ms), or 0: a counter at 0 or below in this isolate or in KV whose reset moment is still ahead. Today's key and tomorrow's are read (an answer's window can end after midnight). */
  async function pausedUntil(env) {
    const days = [utcDay(now()), utcDay(now() + DAY_MS)];
    const stored = await Promise.all(days.map((d) => kvGet(env, "remaining", KEYS.remaining(d), "json")));
    let until = mem.osPausedUntil;
    for (const v of stored) if (v && Number.isFinite(v.remaining) && v.remaining <= 0) until = Math.max(until, Math.min(stamp(v.until), now() + QUOTA_PAUSE_MAX_MS)); // (never more than a day ahead, whatever a damaged value says: new Date(1e300) cannot be written as a time)
    return until;
  }
  /** When a failed login may be tried again, or 0. */
  async function loginPausedUntil(env) {
    return Math.max(mem.loginFailedAt ? mem.loginFailedAt + LOGIN_BACKOFF_MS : 0, stamp(await kvGet(env, "loginfail", KEYS.loginFailed)));
  }
  /** The run of failed downloads, forgotten after an hour: { fails: all of them, service: those of SERVICE_FAILURES only }. An entry an earlier version wrote has no `service`: 0. */
  async function health(env) {
    const kv = await kvGet(env, "health", KEYS.health, "json");
    const fresh = kv && now() - stamp(kv.at) < HEALTH_TTL_MS;
    const fromKv = (n) => (fresh && Number.isFinite(n) && n > 0 ? n : 0);
    const memFresh = now() - mem.failsAt < HEALTH_TTL_MS;
    return { fails: Math.max(fromKv(kv && kv.fails), memFresh ? mem.fails : 0), service: Math.max(fromKv(kv && kv.service), memFresh ? mem.serviceFails : 0) };
  }
  /** How many downloads in a row failed, for any reason (forgotten after an hour): 3 hide the rows. */
  const failures = async (env) => (await health(env)).fails;
  /** How many in a row failed because the service did (429, 5xx, the network): 3 stop download() from asking. */
  const serviceFailures = async (env) => (await health(env)).service;
  async function recordFailure(env, service) {
    const h = await health(env);
    const fails = h.fails + 1, serviceCount = h.service + (service ? 1 : 0);
    mem.fails = fails; mem.serviceFails = serviceCount; mem.failsAt = now();
    await kvPut(env, "health", KEYS.health, { fails, service: serviceCount, at: now() }, HEALTH_TTL_MS);
  }
  async function recordSuccess(env) {
    if (!mem.fails && !kvOf(env)) return;
    mem.fails = 0; mem.serviceFails = 0; mem.failsAt = 0;
    await kvDelete(env, "health", KEYS.health);
  }

  /**
   * Should the rows be listed now? → { ok: true } or { ok: false, why: "quota" | "login-paused" | "failing" | "kv-timeout" }.
   * Not while the quota is out (quota:v1, or the day's counter os:remaining:<date> at 0), not while a failed login is being waited out, not after 3 downloads in a row failed: a row that cannot be opened is worse than no row. The KV
   * reads together get `offeringTimeoutMs` (300 ms): a KV that does not answer in time means no rows this time (the caller marks the answer degraded), never a slow subtitles answer.
   * The reads cannot throw (kvGet catches); a bug here reaches the handler, which logs it.
   */
  async function offering(env) {
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), offeringTimeoutMs); });
    try {
      const state = await Promise.race([Promise.all([quotaUntil(env), loginPausedUntil(env), failures(env), pausedUntil(env)]), late]);
      if (!state) { log({ event: "subs-kv-slow", what: "offering" }); return { ok: false, why: "kv-timeout" }; }
      const [q, l, f, p] = state;
      if (q > now()) return { ok: false, why: "quota" };
      if (p > now()) return { ok: false, why: "quota" }; // the day's counter (os:remaining:<date>) is at 0: download() would refuse, so no row is listed (19/10/2026; quota:v1 alone ends after 10 minutes when the answer gave no reset moment)
      if (l > now()) return { ok: false, why: "login-paused" };
      if (f >= FAILURES_TO_HIDE) return { ok: false, why: "failing" };
      return { ok: true };
    } finally {
      clearTimeout(timer);
    }
  }

  // ── the network ──
  /**
   * One request, with a time limit over the whole of it (the answer's body included) and a byte limit on the body. Redirects are never followed (`redirect: "manual"`): the key,
   * the credentials and the token travel in these requests, and a redirect would carry them to whatever host the answer names; a 3xx comes back as a status and every caller
   * treats it as a failure (the link fetch follows its own redirects by hand, host by host). Any failure is a SubfileError(reason).
   */
  async function fetchBounded(reason, url, init, maxBytes) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { redirect: "manual", ...init, signal: ctl.signal });
      const status = res.status, ok = res.ok, headers = res.headers;
      if (status >= 300 && status < 400) { try { await res.body?.cancel(); } catch { /* nothing to read */ } return { status, ok, headers, text: "" }; }
      return { status, ok, headers, text: await readBoundedText(res, maxBytes) };
    } catch (e) {
      if (e instanceof TooBig) throw new SubfileError(reason === "file-failed" ? "bad-file" : reason);
      throw e instanceof SubfileError ? e : new SubfileError(reason);
    } finally {
      clearTimeout(timer);
    }
  }
  const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
  const apiHeaders = (env, token) => ({ "Api-Key": env.OPENSUBTITLES_API_KEY, "User-Agent": userAgent, Accept: "*/*", "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) });

  /** → { token, baseUrl }. One login at a time in this isolate; a failure is remembered for 10 minutes here and in KV (so a cold isolate does not repeat it). */
  function login(env) {
    if (loginInflight) return loginInflight;
    loginInflight = (async () => {
      try {
        const until = await loginPausedUntil(env);
        if (until > now()) throw new SubfileError("login-paused");
        const base = restBaseOf(env, log);
        let res;
        try {
          res = await fetchBounded("login-failed", `${base}/login`, { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ username: env.OPENSUBTITLES_USERNAME, password: env.OPENSUBTITLES_PASSWORD }) }, MAX_JSON_BYTES);
        } catch (e) {
          log({ event: "opensubtitles-login-error" }); // (the request itself failed: network or time)
          throw e;
        }
        if (!res.ok) { log({ event: "opensubtitles-login-rejected", status: res.status }); throw new SubfileError("login-failed"); }
        const body = parse(res.text);
        if (!body || typeof body.token !== "string" || !body.token) { log({ event: "opensubtitles-login-bad-answer" }); throw new SubfileError("login-failed"); }
        // the host to use afterwards; one that is not OpenSubtitles' own API is ignored, so the token is never sent anywhere else
        const host = typeof body.base_url === "string" ? body.base_url.replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase() : "";
        const baseUrl = env.OPENSUBTITLES_REST ? base : API_HOST.test(host) ? `https://${host}/api/v1` : base;
        const value = { token: body.token, baseUrl, until: now() + TOKEN_TTL_MS };
        mem.token = value; mem.loginFailedAt = 0;
        await kvPut(env, "token", KEYS.token, value, TOKEN_TTL_MS);
        return value;
      } catch (e) {
        if (!(e instanceof SubfileError && e.reason === "login-paused")) {
          mem.loginFailedAt = now();
          await kvPut(env, "loginfail", KEYS.loginFailed, String(now() + LOGIN_BACKOFF_MS), LOGIN_BACKOFF_MS);
        }
        throw e instanceof SubfileError ? e : new SubfileError("login-failed");
      } finally {
        loginInflight = null;
      }
    })();
    return loginInflight;
  }

  /** A stored login: a token, not expired (`until`, in this isolate's memory as in KV), on https at one of OpenSubtitles' API hosts and nowhere else. */
  const usable = (v) => {
    try {
      if (!v || typeof v.token !== "string" || !v.token || !(stamp(v.until) > now()) || typeof v.baseUrl !== "string") return false;
      const u = new URL(v.baseUrl);
      return u.protocol === "https:" && API_HOST.test(u.hostname) && !u.username && !u.password && !u.port;
    } catch { return false; }
  };

  /** The token: this isolate's, else KV's, else a login. After a refusal (`refused` is the token that was refused) a newer one in KV is used before logging in again. */
  async function auth(env, refused = null) {
    if (usable(mem.token) && mem.token.token !== refused) return mem.token;
    const shared = await kvGet(env, "token", KEYS.token, "json");
    if (usable(shared) && shared.token !== refused) { mem.token = shared; return shared; }
    return login(env);
  }

  /** The quota is spent until the reset time the answer gave (at most 24 hours; 10 minutes when it gave none): here and in KV. */
  async function markQuotaOut(env, body, remaining) {
    const resetAt = Date.parse(body && body.reset_time_utc);
    const until = now() + (Number.isFinite(resetAt) && resetAt > now() ? Math.min(resetAt - now(), QUOTA_PAUSE_MAX_MS) : QUOTA_PAUSE_MS);
    mem.quotaUntil = until;
    await kvPut(env, "quota", KEYS.quota, String(until), until - now());
    log({ event: "opensubtitles-quota-out", remaining });
  }

  /** The subtitle's text, downloaded now. Throws SubfileError(reason): quota | login-paused | login-failed | busy | rejected | download-failed | no-link | file-failed | bad-file. */
  async function download(env, fileId) {
    const paused = await pausedUntil(env);
    if (paused > now()) { log({ event: "opensubtitles-paused", until: new Date(paused).toISOString() }); throw new SubfileError("quota"); } // the day's counter is at 0: not asked at all (no key, no hash in the log)
    if ((await quotaUntil(env)) > now()) throw new SubfileError("quota");
    // OpenSubtitles is failing (3 downloads in a row failed for the SERVICE's own reasons, 429, 5xx or the network, not for one bad file; forgotten after an hour without news): not asked again, nothing written. Without this a signed address opened again and again while the
    // service is down cost one call and one KV write each (5xx carries no `remaining`, so the day's counter cannot pause it; measured by the security review of 19/10/2026: 50 requests, 51 writes).
    // Once the hour has passed the count is forgotten and 3 more are tried.
    if ((await serviceFailures(env)) >= FAILURES_TO_HIDE) throw new SubfileError("busy", { skipped: true });
    const post = (a) => fetchBounded("download-failed", `${a.baseUrl}/download`, { method: "POST", headers: apiHeaders(env, a.token), body: JSON.stringify({ file_id: Number(fileId) }) }, MAX_JSON_BYTES);
    let a = await auth(env);
    let res = await post(a);
    if (res.status === 401) { a = await auth(env, a.token); res = await post(a); } // the token was refused (expired early): a newer one, or one new login, and one retry
    const body = parse(res.text);
    const remaining = body && Number.isFinite(body.remaining) ? body.remaining : null;
    if (remaining !== null) await recordRemaining(env, body, remaining);
    if (res.status === 406) {
      if (remaining !== null && remaining <= 0) { // the day's quota is spent (406 also means an invalid file_id, with no `remaining`)
        await markQuotaOut(env, body, remaining);
        throw new SubfileError("quota");
      }
      log({ event: "opensubtitles-download-rejected", status: 406 });
      throw new SubfileError("rejected");
    }
    if (!res.ok) { log({ event: "opensubtitles-download-failed", status: res.status }); throw new SubfileError(res.status === 429 || res.status >= 500 ? "busy" : "download-failed"); }
    log({ event: "opensubtitles-download", remaining }); // the quota left, a number
    if (remaining !== null && remaining <= 0) await markQuotaOut(env, body, remaining); // this download was the last of the day: the rows go now, this subtitle is still served
    let link = body && typeof body.link === "string" ? okLink(body.link) : null;
    if (!link) throw new SubfileError("no-link");
    let file = null;
    for (let hop = 0; hop < 4 && link; hop++) { // redirects by hand: every address, the first and each next, must be https on opensubtitles.com or .org
      file = await fetchBounded("file-failed", link.href, { headers: { "User-Agent": userAgent, Accept: "*/*" } }, MAX_SRT_BYTES); // (no key, no token: the link needs neither)
      if (file.status < 300 || file.status >= 400) break;
      const next = file.headers.get("location");
      link = next ? okLink(next, link) : null;
      file = null;
    }
    if (!file) throw new SubfileError("no-link");
    if (!file.ok) { log({ event: "opensubtitles-file-failed", status: file.status }); throw new SubfileError("file-failed"); }
    const text = file.text;
    if (!text.trim() || /^\s*</.test(text)) throw new SubfileError("bad-file"); // empty, or a page instead of a subtitle
    return text;
  }

  const remember = (id, text) => {
    mem.files.delete(id);
    mem.files.set(id, { text, at: now() });
    while (mem.files.size > 8) mem.files.delete(mem.files.keys().next().value);
  };
  /** The subtitle kept for this file: { text, from: "memory" | "kv" } or null. */
  async function kept(env, id) {
    const m = mem.files.get(id);
    if (m && now() - m.at < FILE_TTL_MS) return { text: m.text, from: "memory" };
    const text = await kvGet(env, "srt", KEYS.srt(id));
    if (typeof text === "string" && text) { remember(id, text); return { text, from: "kv" }; }
    return null;
  }

  /**
   * → { ok: true, text, from: "memory" | "kv" | "source" } | { ok: false, reason }. Never throws.
   * `cacheOnly`: only what is already kept; never logs in and never downloads, so it can never spend the quota (HEAD uses it).
   */
  function fetchSubtitle(env, fileId, { cacheOnly = false } = {}) {
    const id = String(fileId);
    if (cacheOnly) return kept(env, id).then((k) => (k ? { ok: true, ...k } : { ok: false, reason: "not-kept" }), () => ({ ok: false, reason: "not-kept" }));
    if (inflight.has(id)) return inflight.get(id);
    const p = (async () => {
      try {
        const have = await kept(env, id);
        if (have) return { ok: true, ...have };
        const text = await download(env, id);
        remember(id, text);
        await kvPut(env, "srt", KEYS.srt(id), text, FILE_TTL_MS);
        await recordSuccess(env);
        return { ok: true, text, from: "source" };
      } catch (e) {
        const reason = e instanceof SubfileError ? e.reason : "failed";
        if (COUNTS_AS_FAILING.has(reason) && !(e instanceof SubfileError && e.skipped)) await recordFailure(env, SERVICE_FAILURES.has(reason));
        return { ok: false, reason };
      }
    })().finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  }
  return { fetchSubtitle, offering, _mem: mem };
}
