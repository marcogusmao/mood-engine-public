'use strict';
// S4 of the 20/10/2026 security review: `generate` must not print the raw invitation (the `#invite=<token>` link).
// It writes the link to a 0600 file under .context/ and prints only the file path and the registration (hash, never the token).
const test = require('node:test'), a = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const I = require('../scripts/will-invitation');
const INVITE_ID = '11111111-2222-4333-8444-555555555555';
// A fake random source: the token is known in advance, so the test can search for it.
function fakeRandom(byte = 0xab) { return { randomBytes: n => Buffer.alloc(n, byte), randomUUID: () => INVITE_ID }; }
const TOKEN = (byte = 0xab) => Buffer.alloc(32, byte).toString('base64url');
// The command line needs both limits spelled out: without `--expires-in-hours` the option reader hands back args[0] ('generate'), which is NaN, and `generate` refuses (BACKLOG 20/10/2026).
const GENERATE = ['generate', '--person', 'friend-a', '--expires-in-hours', '24', '--expected-auth-epoch', '0'];
function tmp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'will-inv-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('generate: stdout has neither the token nor the link, only the file path and the registration; the file is 0600 and holds the link', async t => {
  const contextDir = path.join(tmp(t), '.context'); // does not exist yet: the script must create it
  const lines = [];
  await I.main(GENERATE, { log: x => lines.push(x), contextDir, random: fakeRandom() });
  const out = lines.join('\n');
  a.equal(lines.length, 1);
  a.ok(!out.includes(TOKEN()), 'the token must not reach stdout');
  a.ok(!out.includes('#invite='), 'the private link must not reach stdout');
  a.ok(!out.includes('https://'), 'no URL at all on stdout');
  const printed = JSON.parse(out);
  a.deepEqual(Object.keys(printed).sort(), ['privateLinkFile', 'registration']);
  const file = path.join(contextDir, `will-invitation-${INVITE_ID}.txt`);
  a.equal(printed.privateLinkFile, file);
  a.equal(printed.registration.inviteId, INVITE_ID);
  a.match(printed.registration.tokenHash, /^[0-9a-f]{64}$/);
  a.equal(printed.registration.tokenHash, require('node:crypto').createHash('sha256').update(TOKEN()).digest('hex'));
  a.equal(fs.statSync(file).mode & 0o777, 0o600);
  a.equal(fs.statSync(contextDir).mode & 0o777, 0o700);
  a.equal(fs.readFileSync(file, 'utf8'), `https://marcogusmao.github.io/mood-engine/u/friend-a/#invite=${TOKEN()}&id=${INVITE_ID}\n`);
});

test('generate: the file mode is 0600 even under a permissive umask, and an existing file is never overwritten', async t => {
  const contextDir = path.join(tmp(t), '.context');
  const before = process.umask(0o000);
  try {
    await I.main(GENERATE, { log() {}, contextDir, random: fakeRandom() });
  } finally { process.umask(before); }
  const file = path.join(contextDir, `will-invitation-${INVITE_ID}.txt`);
  a.equal(fs.statSync(file).mode & 0o777, 0o600);
  const kept = fs.readFileSync(file, 'utf8');
  // Same invitation id again: the exclusive create refuses instead of replacing the link.
  await a.rejects(I.main(GENERATE, { log() {}, contextDir, random: fakeRandom(0xcd) }), /EEXIST/);
  a.equal(fs.readFileSync(file, 'utf8'), kept);
});

test('generate: an invitation id that is not a UUID is refused before any path is built', t => {
  const contextDir = path.join(tmp(t), '.context');
  for (const bad of ['../../etc/passwd', 'x', '', '11111111-2222-4333-8444-55555555555G'])
    a.throws(() => I.writePrivateLink('https://x/#invite=T', bad, { contextDir }), /Invalid invitation id/);
  a.equal(fs.existsSync(contextDir), false);
});

test('generate through the real command line: the real stdout carries no token (the default console.log path)', t => {
  const contextDir = path.join(tmp(t), '.context');
  const script = "const I=require(process.argv[1]);const r={randomBytes:n=>Buffer.alloc(n,0x5a),randomUUID:()=>process.argv[3]};" +
    "I.main(['generate','--person','friend-a','--expires-in-hours','24','--expected-auth-epoch','0'],{contextDir:process.argv[2],random:r}).catch(e=>{console.error(e.message);process.exitCode=1;});";
  const res = spawnSync(process.execPath, ['-e', script, path.resolve(__dirname, '../scripts/will-invitation'), contextDir, INVITE_ID], { encoding: 'utf8' });
  a.equal(res.status, 0, res.stderr);
  a.ok(!res.stdout.includes(TOKEN(0x5a)) && !res.stdout.includes('#invite=') && !res.stderr.includes(TOKEN(0x5a)));
  a.ok(fs.readFileSync(path.join(contextDir, `will-invitation-${INVITE_ID}.txt`), 'utf8').includes(TOKEN(0x5a)));
});

test('generate without a person is still refused, and the default directory is the gitignored .context/ of the repository', async () => {
  await a.rejects(I.main(['generate', '--person', 'someone'], { log() {} }), /friend-a/);
  const ignore = fs.readFileSync(path.resolve(__dirname, '../.gitignore'), 'utf8').split('\n');
  a.ok(ignore.includes('.context/'));
  a.ok(fs.readFileSync(path.resolve(__dirname, '../scripts/will-invitation.js'), 'utf8').includes("path.resolve(__dirname,'..','.context')"));
});
