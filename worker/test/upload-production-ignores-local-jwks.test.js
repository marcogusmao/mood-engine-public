// Round of the clean-context review (L1) on S7c: the local acceptance entry gets its public keys from the WILL_LOCAL_JWKS variable.
// This proves the PRODUCTION Worker (src/index.js, the file wrangler deploys) never reads that variable: with it set to an attacker's key,
// a token signed by the attacker is refused with 401 before the Durable Object is touched, while a token signed by the key GitHub publishes
// (the only JWKS the production verifier trusts, fetched from the fixed issuer address) goes through to the object.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ISSUER, JWKS_URL } from '../src/upload/oidc.js';
import { jwt, LOCAL_KID } from './upload-fixtures/runtime.mjs';

const rsaPair = () => crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const publicJwk = async (pair, kid) => ({ ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid, alg: 'RS256', use: 'sig' });
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
/** The claims of a valid build-role token (the fixture's own), re-signed with `pair` under `kid`. */
async function signedBy(pair, kid) {
  const claimsPart = (await jwt('build', '777')).split('.')[1], signing = b64({ alg: 'RS256', kid, typ: 'JWT' }) + '.' + claimsPart;
  return signing + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(signing))).toString('base64url');
}

test('production index.js: WILL_LOCAL_JWKS naming an attacker key changes nothing; only the key GitHub publishes is trusted', async (t) => {
  assert.equal(ISSUER, 'https://token.actions.githubusercontent.com');
  const github = await rsaPair(), attacker = await rsaPair();
  const realFetch = globalThis.fetch, jwksCalls = [];
  globalThis.fetch = async (url) => {
    if (String(url) !== JWKS_URL) throw new Error('unexpected network call: ' + url);
    jwksCalls.push(String(url));
    return Response.json({ keys: [await publicJwk(github, 'github-key-1')] });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  let touched = 0;
  const env = {
    WILL_UPLOAD_ENABLED: 'true', WILL_BROWSER_ORIGIN: 'https://marcogusmao.github.io', WILL_PAGES_BASE: 'https://marcogusmao.github.io/mood-engine',
    WILL_REPOSITORY_ID: '1413569629', WILL_REPOSITORY_OWNER_ID: '50679408',
    WILL_STATE: { idFromName: () => 'friend-a-v1', get: () => ({ fetch: async () => { touched++; return new Response(null, { status: 204 }); } }) },
    WILL_LOCAL_JWKS: JSON.stringify({ keys: [await publicJwk(attacker, LOCAL_KID)] }),
  };
  const { default: worker } = await import('../src/index.js');
  const claim = async (token) => worker.fetch(new Request('https://worker.test/api/internal/v1/friend-a/claim', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, personId: 'friend-a' }),
  }), env, {});

  // Control: the token signed by the key GitHub publishes is accepted, so the 401s below are the verifier's doing and not a broken request.
  const good = await claim(await signedBy(github, 'github-key-1'));
  assert.equal(good.status, 204);
  assert.equal(touched, 1);
  assert.deepEqual(jwksCalls, [JWKS_URL]);

  // The attacker's key, under the kid the variable publishes it with: refused, the object not touched.
  for (const token of [await signedBy(attacker, LOCAL_KID), await signedBy(attacker, 'github-key-1'), await jwt('build', '778')]) {
    const res = await claim(token);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'OIDC_REJECTED');
  }
  assert.equal(touched, 1, 'a refused token never reaches the Durable Object');
});
