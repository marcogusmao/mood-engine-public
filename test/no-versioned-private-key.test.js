'use strict';
// S7c of the 20/10/2026 security review: worker/test/upload-fixtures/local-signing-key.json was a versioned RSA private key
// (used only to sign fixture tokens). The pair is now generated at the start of each test run (worker/test/upload-fixtures/runtime.mjs).
//
// What this file checks, exactly (round of the clean-context review, L1):
//   1. In every file git lists (tracked, or untracked and not ignored; every file under the directory when there is no git):
//      no PEM private key header (any extension); in `.json` files no object (nested at any depth) that has `kty` and a string `d` of 16+ characters;
//      in `.js` `.mjs` `.cjs` `.ts` files no file that names `kty` and also holds a `d` of 80+ base64url characters as a quoted or object-literal member
//      (an RSA 2048 private exponent is 342); and, in those code files, not the kid of the old key (it is a tripwire: a pasted copy of the old file names it).
//   2. The two old fixture files are gone.
//   3. Nothing in worker/src, scripts, lib or .github imports or names the fixtures directory, the fixture key files or the two WILL_LOCAL_* variables.
// What it does NOT check: a private key written in a form it cannot recognise (raw DER in base64 without a PEM header, a `d` split across string
// pieces, a `d` shorter than 80 characters in a code file, an extension other than the ones above, any `.md`). The behaviour that matters, that the production
// Worker ignores WILL_LOCAL_JWKS, is proved by worker/test/upload-production-ignores-local-jwks.test.js, not here.
const test = require('node:test'), a = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const PEM = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/;
const OLD_KID = 'local-only-' + '2026-10-14'; // written in two pieces so that this file does not hold it itself
const CODE = /\.(?:js|mjs|cjs|ts)$/;
const D_MEMBER = /(?:["']d["']|\bd)\s*:\s*["'][A-Za-z0-9_-]{80,}["']/;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.context', '.wrangler']);

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out); else if (e.isFile()) out.push(path.relative(base, full));
  }
  return out;
}
/** Every tracked file, and every untracked one that is not ignored, when git answers; otherwise (a source snapshot without .git) every file under the directory. */
function files(dir) {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: dir, encoding: 'utf8' });
  return r.status === 0 && r.stdout ? r.stdout.split('\0').filter(Boolean).filter(f => fs.existsSync(path.join(dir, f))) : walk(dir);
}
function hasPrivateJwk(value) {
  if (Array.isArray(value)) return value.some(hasPrivateJwk);
  if (value && typeof value === 'object') {
    if (typeof value.kty === 'string' && typeof value.d === 'string' && value.d.length >= 16) return true;
    return Object.values(value).some(hasPrivateJwk);
  }
  return false;
}
/** The files that hold a private key (or name the old key's kid in code), by relative path. */
function privateKeyFiles(dir) {
  const hits = [];
  for (const rel of files(dir)) {
    const full = path.join(dir, rel);
    if (fs.statSync(full).size > 4 * 1024 * 1024) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (PEM.test(text)) { hits.push(rel); continue; }
    if (/\.json$/.test(rel)) {
      if (text.includes(OLD_KID)) { hits.push(rel); continue; }
      if (/"kty"\s*:/.test(text)) {
        try { if (hasPrivateJwk(JSON.parse(text))) hits.push(rel); } catch { /* not JSON: the PEM test above is the check */ }
      }
    } else if (CODE.test(rel)) {
      if (text.includes(OLD_KID) || (/\bkty\b/.test(text) && D_MEMBER.test(text))) hits.push(rel);
    }
  }
  return hits;
}

test('control: the scanner sees a private key in every shape it claims to (JWK file, nested JWK, PEM, JWK pasted into .js/.mjs/.cjs/.ts, the old kid in code) and not public keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-priv-key-'));
  try {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = privateKey.export({ format: 'jwk' }), pub = publicKey.export({ format: 'jwk' });
    fs.writeFileSync(path.join(dir, 'private-jwk.json'), JSON.stringify(jwk));
    fs.writeFileSync(path.join(dir, 'nested.json'), JSON.stringify({ keys: [{ kid: 'x', ...jwk }] }));
    fs.writeFileSync(path.join(dir, 'key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
    fs.writeFileSync(path.join(dir, 'pasted.mjs'), `export default { kty: 'RSA', n: '${jwk.n}', e: 'AQAB', d: '${jwk.d}' };\n`);
    fs.writeFileSync(path.join(dir, 'quoted.cjs'), `module.exports = JSON.parse('{"kty":"RSA","n":"${jwk.n}","e":"AQAB","d":"${jwk.d}"}');\n`);
    fs.writeFileSync(path.join(dir, 'typed.ts'), `export const key = { "kty": "RSA", "d": "${jwk.d}", "n": "${jwk.n}" } as const;\n`);
    fs.writeFileSync(path.join(dir, 'embedded-pem.js'), `module.exports = \`${privateKey.export({ type: 'pkcs8', format: 'pem' })}\`;\n`);
    fs.writeFileSync(path.join(dir, 'old-kid.js'), `export const KID = '${OLD_KID}';\n`);
    fs.writeFileSync(path.join(dir, 'old-kid.json'), JSON.stringify({ keys: [{ kid: OLD_KID, kty: 'RSA' }] }));
    // Not private keys:
    fs.writeFileSync(path.join(dir, 'public-jwk.json'), JSON.stringify({ keys: [pub] }));
    fs.writeFileSync(path.join(dir, 'public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
    fs.writeFileSync(path.join(dir, 'public.mjs'), `export default { kty: 'RSA', n: '${pub.n}', e: 'AQAB', d: 'short' };\n`);
    fs.writeFileSync(path.join(dir, 'long-d-without-kty.js'), `const x = { d: '${jwk.d}' };\n`);
    fs.writeFileSync(path.join(dir, 'notes.md'), `The old key had the kid ${OLD_KID}.\n`);
    a.deepEqual(privateKeyFiles(dir).sort(), ['embedded-pem.js', 'key.pem', 'nested.json', 'old-kid.js', 'old-kid.json', 'pasted.mjs', 'private-jwk.json', 'quoted.cjs', 'typed.ts']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no file of the repository holds a private key or the old kid in code, and the old fixture key files are gone', () => {
  a.deepEqual(privateKeyFiles(ROOT), []);
  a.equal(fs.existsSync(path.join(ROOT, 'worker/test/upload-fixtures/local-signing-key.json')), false);
  a.equal(fs.existsSync(path.join(ROOT, 'worker/test/upload-fixtures/local-jwks.json')), false);
});

test('nothing in worker/src, scripts, lib or .github imports or names the fixture key, the fixture JWKS, the fixtures directory or the WILL_LOCAL_* variables', () => {
  const offenders = [];
  for (const rel of files(ROOT)) {
    if (!/^(worker\/src|scripts|lib|\.github)\//.test(rel)) continue;
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (/local-signing-key|local-jwks|upload-fixtures|WILL_LOCAL_SIGNING_KEY|WILL_LOCAL_JWKS/.test(text)) offenders.push(rel);
  }
  a.deepEqual(offenders, []);
});
