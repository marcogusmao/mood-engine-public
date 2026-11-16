// A limit BEFORE the Durable Object for the browser routes that carry a bearer token (S2 of the review of 8e37c23, 20/10/2026).
// Before this, api.js checked only the 43-character shape of the token; the real check (CREDENTIAL_INVALID, INVITE_INVALID, expiry) and the quotas run inside the Durable Object and count only authorized
// requests, so 1,000 random tokens were 1,000 reads/waits of the single object that also serves Will's uploads. Two things, both in the memory of the isolate:
//  1. a bucket per `cf-connecting-ip`: at most RATE_LIMIT_CHARGES tokens this isolate has not seen accepted may go to the object per RATE_WINDOW_MS. A request is charged when it is admitted
//     (so a burst of 1,000 at once is stopped at the same number as 1,000 in a row) and the charge is given back only when the object RECOGNIZED the token (any answer but an auth refusal);
//     a refusal, a 5xx or a thrown error keeps it. Over the limit: 429 RATE_LIMITED with Retry-After = seconds to the end of the window.
//  2. a short negative cache of the sha256 of tokens the object refused (REFUSED_TTL_MS): the same bad token (an expired credential in an open tab) is answered with the same refusal at no cost.
//     A token the object accepted is remembered KNOWN_GOOD_TTL_MS and is not charged (a person behind the same address as an attacker keeps working; a valid token the isolate has never seen,
//     arriving after the limit, waits for Retry-After). A successful /session forgets the refusal of the credential it registers.
// What this is NOT: best effort, per isolate. Cloudflare may run many isolates in many places and an attacker spread over them gets the limit once per isolate. Since 21/10/2026 (Marco, lote 1,
// item 4: a global limit before the intake is turned on) this table is the layer the request meets FIRST and the binding the second: when the Worker has the Rate Limiting binding WILL_RATE_LIMIT (wrangler.toml, `[[ratelimits]]`), api.js asks it,
// after this table, keyed by the token's sha256 and not by the address (Marco, 28/10/2026: two addresses with one token share a count, two tokens behind one address have two), only for the requests this table charged, and a refusal there is the same 429 RATE_LIMITED. The binding is shared by the isolates of one Cloudflare location (per location,
// not worldwide, and eventually consistent: not measured here); the table stays as the only layer where the binding does not exist (the node tests and the config that the Worker's local-runtime test rig generates,
// which declare none; `wrangler dev --local` with wrangler.toml DOES get a simulated binding, measured 21/10/2026) and as the one that gives a recognized token its charge back, which the binding cannot. Which layer refused is counted and logged (createLayerCounter below).
// The key is the header Cloudflare sets and overwrites, with an IPv6 address taken as its /64 prefix (addressKey: one subscriber usually holds a whole /64, so rotating the low 64 bits would
// otherwise be a new bucket for every request; measured by the review of 20/10/2026: 1,000 addresses of one /64 were 1,000 calls of the object); an IPv4 address (and an IPv4-mapped IPv6 one) stays
// one key per address. Without the header (the local runner) every request shares the key "no-ip". Memory is bounded (MAX_* below). When the table of addresses is full the bucket let go is an
// expired one, else the one with the FEWEST charges (oldest first), and never the bucket just made (`keep`; without it a new address on a full table would get a bucket that is dropped at once
// and pass without limit): a flood of other /64 prefixes does not reopen a bucket that is used up (it reopened only after 40,961 other prefixes, about 41,000 calls spent to reopen ONE bucket).
// THE LIMIT IS PER /64 (20 per 10 minutes). THERE IS NO CEILING PER ISOLATE for distinct prefixes: measured by the review, 5,000 /64 gave 100,000 calls of the object and 20,000 /64 gave 400,000 in
// one window (one /48 holds 65,536 /64). An attacker with many prefixes still reaches the object without limit, and the binding does not close that either: keyed by the token (Marco, 28/10/2026) it does not see the address at all, and an attacker who changes token on every request is never limited by it (the risk he accepted); only this table holds that caller,
// per /64 and per isolate. A limit that does not depend on the caller (a constant key, or a counter in the object) would close it, and its number is Marco's decision, not made here (BACKLOG.md, 21/10/2026). [29/10/2026: decided by Marco, a second binding WILL_RATE_LIMIT_GLOBAL with one constant key, 60 per 60 s for the whole intake, asked after the per-token one (see GLOBAL_BINDING_* below); it caps the calls of many prefixes and of a rotating token at 60 per minute per Cloudflare location, it does not make the many-prefixes case impossible.]
import { ApiError } from './protocol.js';

// 20 tokens per 10 minutes per /64 (or IPv4 address): the session's choice of 20/10/2026, confirmed by Marco, 21/10/2026 (lote 1, item 4). test/will-confirmed-parameters.test.js pins both numbers.
export const RATE_LIMIT_CHARGES = 20;
export const RATE_WINDOW_MS = 10 * 60e3;
export const REFUSED_TTL_MS = 60e3;
export const KNOWN_GOOD_TTL_MS = 5 * 60e3;
const MAX_BUCKETS = 2048, MAX_REFUSED = 512, MAX_GOOD = 256;
/** The answers of the object that mean "this token is not (or no longer) valid". Anything else means the object knew the token. */
const AUTH_REFUSALS = new Set(['CREDENTIAL_INVALID', 'CREDENTIAL_EXPIRED', 'INVITE_INVALID', 'INVITE_EXPIRED']);
export const isAuthRefusal = code => AUTH_REFUSALS.has(code);

/**
 * The key of the bucket for an address: IPv6 -> its /64 prefix (first four groups, lower case, no leading zeros, so every spelling of one prefix is one key); IPv4 and IPv4-mapped IPv6 -> the IPv4 address;
 * a missing header -> "no-ip"; anything that is not an address is kept as text (cut to 64 characters) so that it still has a bucket.
 */
export function addressKey(raw) {
  const text = String(raw || '').trim().toLowerCase().split('%')[0];
  if (!text) return 'no-ip';
  if (!text.includes(':')) return text.slice(0, 64);
  let v6 = text;
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v6);
  if (dotted) v6 = dotted[1] + ((+dotted[2] << 8) | +dotted[3]).toString(16) + ':' + ((+dotted[4] << 8) | +dotted[5]).toString(16);
  const halves = v6.split('::');
  if (halves.length > 2) return text.slice(0, 64);
  const head = halves[0] ? halves[0].split(':') : [], tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  if (groups.length !== 8 || !groups.every(g => /^[0-9a-f]{1,4}$/.test(g))) return text.slice(0, 64);
  const num = groups.map(g => parseInt(g, 16));
  if (num.slice(0, 5).every(n => n === 0) && num[5] === 0xffff) return [num[6] >> 8, num[6] & 255, num[7] >> 8, num[7] & 255].join('.'); // IPv4-mapped, written in hex
  return '6:' + groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':');
}

export const rateLimited = seconds => { const e = new ApiError(429, 'RATE_LIMITED', true); e.retryAfter = Math.max(1, seconds); return e; };
/** Oldest entries out (a Map keeps insertion order). */
const trim = (map, max) => { while (map.size > max) map.delete(map.keys().next().value); };

export function createLimiter({ now = Date.now } = {}) {
  const buckets = new Map(); // ip -> { start, charges }
  const refused = new Map(); // token sha256 -> { at, status, code }
  const good = new Map(); // token sha256 -> at

  /** The table of addresses is over its size: let go of expired buckets first, then of the ones with the fewest charges (oldest first). The bucket just made is never the one. */
  function makeRoom(t, keep) {
    while (buckets.size > MAX_BUCKETS) {
      let victim = null, best = null;
      for (const [key, b] of buckets) {
        if (b === keep) continue;
        const rank = t - b.start >= RATE_WINDOW_MS ? -1 : b.charges;
        if (best === null || rank < best) { best = rank; victim = key; if (rank === -1) break; }
      }
      if (victim === null) break;
      buckets.delete(victim);
    }
  }

  /**
   * Before the object is asked. Throws the ApiError to answer with, or returns a ticket; the caller reports the outcome with ticket.done(status, code).
   * A ticket never reported keeps its charge (a thrown error or a timeout is not a recognized token).
   */
  function admit(ip, hash) {
    const t = now();
    const bad = refused.get(hash);
    if (bad) {
      if (t - bad.at < REFUSED_TTL_MS) throw new ApiError(bad.status, bad.code, false);
      refused.delete(hash);
    }
    const seen = good.get(hash);
    const known = seen !== undefined && t - seen < KNOWN_GOOD_TTL_MS;
    let bucket = null;
    if (!known) {
      bucket = buckets.get(ip);
      if (!bucket || t - bucket.start >= RATE_WINDOW_MS) { bucket = { start: t, charges: 0 }; buckets.delete(ip); buckets.set(ip, bucket); makeRoom(t, bucket); }
      if (bucket.charges >= RATE_LIMIT_CHARGES) throw rateLimited(Math.ceil((bucket.start + RATE_WINDOW_MS - t) / 1000));
      bucket.charges++;
    }
    return {
      /** True when this request took a charge in the table (a token the isolate has not seen accepted): the only requests the Rate Limiting binding is asked about. */
      charged: bucket !== null,
      /** The request ended before the object was asked: give the charge back. */
      skip() { if (bucket) { bucket.charges = Math.max(0, bucket.charges - 1); bucket = null; } },
      done(status, code) {
        const at = now();
        if ((status === 401 || status === 403) && isAuthRefusal(code)) { good.delete(hash); refused.set(hash, { at, status, code }); trim(refused, MAX_REFUSED); return; }
        if (status >= 500) return;
        // the object knew this token: give the charge back and remember it
        if (bucket) { bucket.charges = Math.max(0, bucket.charges - 1); bucket = null; }
        good.delete(hash); good.set(hash, at); trim(good, MAX_GOOD);
      },
    };
  }
  /** A credential was just registered (a successful /session): an earlier refusal of that exact token no longer holds. */
  const forget = hash => { refused.delete(hash); };
  return { admit, forget, _state: { buckets, refused, good } };
}

// ---- the Rate Limiting binding (21/10/2026) ----------------------------------------------------------------------------------------------------------------------------------------------------------
// Cloudflare's binding counts per key over a `period` of 10 or 60 seconds (nothing else is accepted); the limit and the period are in wrangler.toml, not here. The configured window (60 s) is NOT the table's
// (10 minutes): 20 per 60 s per token is a ceiling on the speed of one token across the isolates of one location, the table's 20 per 10 minutes is the budget of one isolate. The binding has no give-back, so it is asked only
// for the requests the table charges (`ticket.charged`); the 5-minute memory of tokens the object accepted keeps a person who is working from being counted on every request.
// DECIDED BY MARCO, 28/10/2026 (questionnaire; the three choices of the session of 21/10/2026): (i) the 20 per 60 s stays; (ii) the key is the token's sha256, NOT the /64 (his choice was not the recommended one: accepted risk, a caller that changes token on every request is never limited by the binding, only by the table); (iii) failing open stays
// when the binding errs. Over 10 minutes 20 per 60 s is 200 per key per Cloudflare location, ten times the confirmed 20 per 10 minutes, and Cloudflare's counter is approximate and per location (worker/README.md, "The global layer"; BACKLOG.md, 28/10/2026).
export const BINDING_NAME = 'WILL_RATE_LIMIT';
export const BINDING_PERIOD_S = 60; // must equal `simple.period` of [[ratelimits]] in wrangler.toml (test/will-rate-limit-binding.test.js); it is also the Retry-After of a refusal by the binding
/** Whether the binding lets the key through. Throws when the binding fails or answers something other than { success: boolean }: the caller then relies on the table alone (fail open, logged). */
export async function bindingAllows(binding, key) {
  const answer = await binding.limit({ key });
  if (!answer || typeof answer.success !== 'boolean') throw new TypeError('unexpected answer of the Rate Limiting binding');
  return answer.success;
}
// The ceiling of the whole intake (Marco, 29/10/2026, questionnaire): a SECOND binding, WILL_RATE_LIMIT_GLOBAL (wrangler.toml, 60 per 60 s), asked with ONE CONSTANT key so that every caller shares one count. It is asked for the same requests as the first
// (the ones the table charged), after it, and a refusal is the same 429 RATE_LIMITED with Retry-After = its period; a binding that is missing or errs fails open (the table and the object's own checks remain). The key is a constant, never the token, the address or anything of the caller.
// Accepted risk: a persistent attacker keeps the ceiling used up and Will waits a minute at a time; the counters are per Cloudflare location and approximate.
export const GLOBAL_BINDING_NAME = 'WILL_RATE_LIMIT_GLOBAL';
export const GLOBAL_BINDING_KEY = 'will-intake';
export const LAYER_LOG_FLOOR_MS = 60e3;
/**
 * Which layer refused, as a counter of the isolate (`counts`) and as a log line at most once per LAYER_LOG_FLOOR_MS per layer (a scan of 1,000 requests is not 1,000 lines). Layers: `memory` (the table in this file),
 * `binding` (the per-token Rate Limiting binding refused) and `binding-error` (it threw or answered nonsense and the request went on to the table alone); since 29/10/2026 also `binding-global` (the ceiling of the whole intake refused)
 * and `binding-global-error` (that binding threw or answered nonsense; the request went on). No key, address or token is logged.
 */
export function createLayerCounter({ now = Date.now, log = () => {} } = {}) {
  const counts = { memory: 0, binding: 0, 'binding-error': 0, 'binding-global': 0, 'binding-global-error': 0 }, last = {};
  function note(layer) {
    counts[layer]++;
    const t = now();
    if (last[layer] !== undefined && t - last[layer] < LAYER_LOG_FLOOR_MS) return;
    last[layer] = t;
    try { log(layer === 'binding-global-error' ? { event: 'will-rate-limit-global-error', message: 'the Rate Limiting binding of the whole intake failed; the request goes on without that ceiling', total: counts[layer] } : layer === 'binding-error' ? { event: 'will-rate-limit-binding-error', message: 'the Rate Limiting binding failed; only the isolate\'s own limit applies to this request', total: counts[layer] } : { event: 'will-rate-limited', layer, total: counts[layer] }); } catch { /* a failing log never changes the answer */ }
  }
  return { note, counts };
}
