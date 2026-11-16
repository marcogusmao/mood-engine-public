import { boundedBytes, reject, strictJson } from './protocol.js';
export const ISSUER = 'https://token.actions.githubusercontent.com';
export const JWKS_URL = ISSUER + '/.well-known/jwks';
export const REPOSITORY = 'marcogusmao/mood-engine';
export const REPOSITORY_ID = '1413569629';
export const OWNER_ID = '50679408';
const roles = {
  build: { environment: 'mood-will-build', workflow: 'mood-engine.yml', events: ['schedule', 'push', 'workflow_dispatch'] },
  deploy: { environment: 'github-pages', workflow: 'mood-engine.yml', events: ['schedule', 'push', 'workflow_dispatch'] },
  admin: { environment: 'mood-will-admin', workflow: 'will-invitation.yml', events: ['workflow_dispatch'] },
};
export function validateClaims(c, role, now = Date.now()) {
  const r = roles[role], seconds = now / 1000;
  if (!r || c.iss !== ISSUER || c.aud !== `urn:mood-engine:friend-a:${role}:v1` || c.repository !== REPOSITORY || c.repository_id !== REPOSITORY_ID || c.repository_owner_id !== OWNER_ID || c.ref !== 'refs/heads/main' || c.ref_type !== 'branch' || c.runner_environment !== 'github-hosted' || c.environment !== r.environment || c.sub !== `repo:${REPOSITORY}:environment:${r.environment}` || c.workflow_ref !== `${REPOSITORY}/.github/workflows/${r.workflow}@refs/heads/main` || !r.events.includes(c.event_name) || !/^[0-9a-f]{40}$/.test(c.sha || '') || !/^[0-9]+$/.test(c.run_id || '') || !/^[0-9]+$/.test(c.run_attempt || '') || typeof c.run_id !== 'string' || typeof c.run_attempt !== 'string' || ['exp','iat','nbf'].some(k => !Number.isSafeInteger(c[k])) || c.exp <= seconds - 30 || c.nbf > seconds + 30 || c.iat > seconds + 30 || c.exp <= c.iat || c.exp - c.iat > 600 || c.nbf > c.exp || ['pull_request','pull_request_target','dynamic','fork'].some(k => Object.hasOwn(c,k))) reject(401, 'OIDC_REJECTED');
  return { role, runId: c.run_id, runAttempt: c.run_attempt, codeSha: c.sha };
}
function decode(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) reject(401, 'OIDC_REJECTED');
  return Uint8Array.from(atob(part.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
}
// S7a (review of 20/10/2026): an unknown `kid` forces a refetch of the keys, because GitHub rotates them. Without a floor, tokens with random kids made one fetch each (coalesced only while a fetch was in flight). Now at most one fetch per 60 s per isolate, counted from the START of the last fetch attempt, successful or not: a cold verifier that has just loaded the keys does not fetch them again for the same unknown kid, and a failing fetch is not retried on every request.
export const UNKNOWN_KID_REFETCH_FLOOR_MS = 60000;
// Tests inject transport/clock here, never through env, JWT headers or a production route.
export function createOidcVerifier({ fetchImpl = (...a) => fetch(...a), now = Date.now } = {}) {
  let keys = null, fetchedAt = 0, inflight, attemptedAt = -Infinity;
  async function load(force = false) {
    if (!force && keys && now() - fetchedAt < 3600000) return keys;
    if (inflight) return inflight;
    attemptedAt = now();
    inflight = (async () => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetchImpl(JWKS_URL, { signal: controller.signal, redirect: 'error', cache: 'no-store' });
        if (!res.ok) throw Error();
        const j = strictJson(new TextDecoder().decode(await boundedBytes(res, 65536, { allowEncoding: true })));
        if (!Array.isArray(j.keys) || j.keys.length > 32) throw Error();
        keys = j.keys; fetchedAt = now(); return keys;
      } finally { clearTimeout(timer); }
    })().finally(() => { inflight = null; });
    return inflight;
  }
  return async function verify(token, role) {
    try {
      if (typeof token !== 'string' || token.length > 16384) throw Error();
      const p = token.split('.'); if (p.length !== 3) throw Error();
      const header = strictJson(new TextDecoder('utf-8', { fatal: true }).decode(decode(p[0])));
      const claims = strictJson(new TextDecoder('utf-8', { fatal: true }).decode(decode(p[1])));
      if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 256 || Object.keys(header).some(k => !['alg','kid','typ'].includes(k)) || (header.typ && header.typ !== 'JWT')) throw Error();
      let trusted = await load(), found = trusted.filter(k => k.kid === header.kid);
      if (!found.length && now() - attemptedAt >= UNKNOWN_KID_REFETCH_FLOOR_MS) { trusted = await load(true); found = trusted.filter(k => k.kid === header.kid); }
      if (found.length !== 1) throw Error(); const jwk = found[0];
      if (jwk.kty !== 'RSA' || (jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig') || jwk.d) throw Error();
      const key = await crypto.subtle.importKey('jwk', jwk, { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' }, false, ['verify']);
      if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(p[2]), new TextEncoder().encode(p[0]+'.'+p[1])))) throw Error();
      return validateClaims(claims, role, now());
    } catch { reject(401, 'OIDC_REJECTED'); }
  };
}
