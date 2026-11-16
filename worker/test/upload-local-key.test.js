// S7c (20/10/2026): the RS256 pair that signs the local fixture tokens is generated at run time, not versioned.
// These tests check the mechanism without starting wrangler: the token the fixture mints is accepted by the production verifier against the
// JWKS the fixture publishes, the pair is new in every process that starts alone, and a child process started by a test shares the parent's pair.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createOidcVerifier, JWKS_URL } from '../src/upload/oidc.js';
import { jwt, localKey, LOCAL_KID } from './upload-fixtures/runtime.mjs';

const RUNTIME = pathToFileURL(fileURLToPath(new URL('./upload-fixtures/runtime.mjs', import.meta.url))).href;
const modulusIn = (env) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const {localKey}=await import(${JSON.stringify(RUNTIME)});process.stdout.write((await localKey()).jwks.keys[0].n);`], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test('a fixture token for each role verifies against the published fixture JWKS with the production verifier', async () => {
  const { jwks } = await localKey();
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys[0].kid, LOCAL_KID);
  for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi']) assert.ok(!(field in jwks.keys[0]), `the published key carries no private member ${field}`);
  const verify = createOidcVerifier({ fetchImpl: async (url) => { assert.equal(url, JWKS_URL); return Response.json(jwks); } });
  for (const role of ['build', 'deploy', 'admin']) assert.equal((await verify(await jwt(role, '321'), role)).runId, '321');
  // A token signed by any other pair is refused: the JWKS is this run's pair and nothing else.
  const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const [head, body] = (await jwt('build')).split('.');
  const forged = head + '.' + body + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', other.privateKey, new TextEncoder().encode(head + '.' + body))).toString('base64url');
  await assert.rejects(() => verify(forged, 'build'), { code: 'OIDC_REJECTED' });
});

test('the pair is generated per run: a process started alone gets a new one, a child that inherits the environment gets the parent\'s', async () => {
  const mine = (await localKey()).jwks.keys[0].n;
  const inherited = modulusIn({ ...process.env });
  assert.equal(inherited, mine, 'a child of the test process signs with the same pair (race-client.mjs relies on this)');
  const { WILL_LOCAL_SIGNING_KEY, ...without } = process.env;
  assert.ok(WILL_LOCAL_SIGNING_KEY, 'the parent published its private half to the environment for its children');
  const alone = modulusIn(without), aloneAgain = modulusIn(without);
  assert.notEqual(alone, mine);
  assert.notEqual(alone, aloneAgain, 'two runs never share a pair');
});
