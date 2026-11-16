import test from 'node:test';import assert from 'node:assert/strict';
import { createOidcVerifier, ISSUER, JWKS_URL, validateClaims } from '../src/upload/oidc.js';
import { ApiError } from '../src/upload/protocol.js';
import { createUploadApi } from '../src/upload/api.js';
export function claims(role='build',now=Date.now()){const env={build:'mood-will-build',deploy:'github-pages',admin:'mood-will-admin'}[role];return {iss:ISSUER,aud:`urn:mood-engine:friend-a:${role}:v1`,repository:'marcogusmao/mood-engine',repository_id:'1413569629',repository_owner_id:'50679408',ref:'refs/heads/main',ref_type:'branch',runner_environment:'github-hosted',environment:env,sub:`repo:marcogusmao/mood-engine:environment:${env}`,workflow_ref:`marcogusmao/mood-engine/.github/workflows/${role==='admin'?'will-invitation':'mood-engine'}.yml@refs/heads/main`,event_name:'workflow_dispatch',sha:'e'.repeat(40),run_id:'123',run_attempt:'1',iat:Math.floor(now/1000),nbf:Math.floor(now/1000),exp:Math.floor(now/1000)+300};}
const enc=v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url');
test('every regular-workflow trust claim enforced, no reusable workflow claim required',()=>{const now=Date.now(),c=claims('build',now);assert.equal(validateClaims(c,'build',now).role,'build');for(const k of ['iss','aud','repository','repository_id','repository_owner_id','ref','ref_type','runner_environment','environment','sub','workflow_ref','event_name','sha','run_id','run_attempt'])assert.throws(()=>validateClaims({...c,[k]:'wrong'},'build',now),{code:'OIDC_REJECTED'},k);for(const patch of [{exp:c.iat+601},{exp:c.iat-60},{nbf:c.iat+60},{iat:c.iat+60},{fork:false}])assert.throws(()=>validateClaims({...c,...patch},'build',now));for(const role of ['deploy','admin'])assert.throws(()=>validateClaims(c,role,now));});
test('production RS256 verifier rejects signer/algorithm/kid/duplicate claims and fixed JWKS transport',async()=>{const now=Date.now(),keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']),jwk={...await crypto.subtle.exportKey('jwk',keys.publicKey),kid:'local',alg:'RS256',use:'sig'};let reads=0;const verify=createOidcVerifier({now:()=>now,fetchImpl:async u=>{assert.equal(u,JWKS_URL);reads++;return Response.json({keys:[jwk]});}});async function token(header={alg:'RS256',kid:'local'},body=claims('build',now),sign=keys.privateKey){const p=enc(header)+'.'+enc(body);return p+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',sign,new TextEncoder().encode(p))).toString('base64url');}assert.equal((await verify(await token(),'build')).runId,'123');for(const h of [{alg:'none',kid:'local'},{alg:'HS256',kid:'local'},{alg:'RS256',kid:'missing'},{alg:'RS256',kid:'local',jku:'https://evil.test'}])await assert.rejects(()=>token(h).then(t=>verify(t,'build')),{code:'OIDC_REJECTED'});await assert.rejects(()=>token(undefined,JSON.stringify(claims('build',now)).replace('"run_id":"123"','"run_id":"123","run_id":"124"')).then(t=>verify(t,'build')),{code:'OIDC_REJECTED'});const other=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);await assert.rejects(()=>token(undefined,undefined,other.privateKey).then(t=>verify(t,'build')),{code:'OIDC_REJECTED'});assert.equal(reads,1);});  // 20/10/2026 (S7a): was 2. The kid 'missing' arrives at the same instant as the first load, so the 60 s floor skips the refetch; the floor and the rotation case have their own test below.
test('bad OIDC rejected before DO id lookup/storage',async()=>{let touched=0;const api=createUploadApi({verifyOidc:async()=>{throw new ApiError(401,'OIDC_REJECTED');}});const res=await api(new Request('https://worker.test/api/internal/v1/friend-a/claim',{method:'POST',headers:{Authorization:'Bearer invalid','Content-Type':'application/json'},body:'{}'}),{WILL_UPLOAD_ENABLED:'true',WILL_BROWSER_ORIGIN:'https://marcogusmao.github.io',WILL_PAGES_BASE:'https://marcogusmao.github.io/mood-engine',WILL_REPOSITORY_ID:'1413569629',WILL_REPOSITORY_OWNER_ID:'50679408',WILL_STATE:{idFromName(){touched++;}}});assert.equal(touched,0);assert.equal(res.status,401);});

// S7a (review of 20/10/2026): an unknown kid used to refetch the keys on every request (coalesced only while a fetch was in flight).
const rsaPair = () => crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const publicJwk = async (pair, kid) => ({ ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid, alg: 'RS256', use: 'sig' });
async function signedWith(pair, kid, at) {
  const head = enc({ alg: 'RS256', kid }), signing = head + '.' + enc(claims('build', at));
  return signing + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(signing))).toString('base64url');
}
const rejected = (verify, token) => assert.rejects(() => verify(token, 'build'), { code: 'OIDC_REJECTED' });
test('unknown kid: at most one refetch of the keys per 60 s per isolate, and a rotated key is accepted once the floor has passed', async () => {
  const known = await rsaPair(), rotated = await rsaPair(), stranger = await rsaPair();
  let t = Date.now(), calls = 0, published = [await publicJwk(known, 'known')];
  const T0 = t;
  const verify = createOidcVerifier({ now: () => t, fetchImpl: async u => { assert.equal(u, JWKS_URL); calls++; return Response.json({ keys: published }); } });
  // Cold verifier: the first request loads the keys (1 fetch) and does NOT fetch them again for its unknown kid.
  await rejected(verify, await signedWith(stranger, 'ghost-1', t));
  assert.equal(calls, 1);
  // Two more unknown kids inside the 60 s: no fetch at all.
  t = T0 + 10_000; await rejected(verify, await signedWith(stranger, 'ghost-2', t));
  t = T0 + 59_999; await rejected(verify, await signedWith(stranger, 'ghost-3', t));
  assert.equal(calls, 1);
  // A known kid is served from the cache.
  assert.equal((await verify(await signedWith(known, 'known', t), 'build')).runId, '123');
  assert.equal(calls, 1);
  // GitHub rotates; inside the floor the new key is still refused (the cost of the floor, at most 60 s) and still no fetch.
  published = [await publicJwk(known, 'known'), await publicJwk(rotated, 'rotated')];
  await rejected(verify, await signedWith(rotated, 'rotated', t));
  assert.equal(calls, 1);
  // At the floor: one refetch, the rotated key is accepted.
  t = T0 + 60_000;
  assert.equal((await verify(await signedWith(rotated, 'rotated', t), 'build')).runId, '123');
  assert.equal(calls, 2);
  // The floor restarts from that fetch.
  t = T0 + 119_999; await rejected(verify, await signedWith(stranger, 'ghost-4', t));
  assert.equal(calls, 2);
  t = T0 + 120_000; await rejected(verify, await signedWith(stranger, 'ghost-5', t));
  assert.equal(calls, 3);
});
test('unknown kid: a burst of concurrent requests with random kids costs one fetch, cold or warm, and a failing refetch is not retried inside the floor', async () => {
  const known = await rsaPair(), stranger = await rsaPair();
  let t = Date.now(), calls = 0, failing = false;
  const T0 = t;
  const verify = createOidcVerifier({ now: () => t, fetchImpl: async () => { calls++; if (failing) throw Error('JWKS down'); return Response.json({ keys: [await publicJwk(known, 'known')] }); } });
  const burst = async n => { const tokens = await Promise.all(Array.from({ length: n }, (_, i) => signedWith(stranger, `random-${t}-${i}`, t))); await Promise.all(tokens.map(tok => rejected(verify, tok))); };
  await burst(50); assert.equal(calls, 1);               // cold start: one load
  await burst(50); assert.equal(calls, 1);               // same instant, warm
  t = T0 + 120_000; await burst(50); assert.equal(calls, 2); // past the floor, keys still fresh (< 1 h): exactly one refetch for the whole burst
  t = T0 + 130_000; await burst(50); assert.equal(calls, 2);
  failing = true; t = T0 + 190_000; await burst(50); assert.equal(calls, 3); // the forced refetch fails: one attempt, every request rejected
  t = T0 + 200_000; await burst(50); assert.equal(calls, 3); // the failed attempt counts: no retry inside the floor
  failing = false; t = T0 + 250_000; await burst(5); assert.equal(calls, 4);
  assert.equal((await verify(await signedWith(known, 'known', t), 'build')).runId, '123');
});
