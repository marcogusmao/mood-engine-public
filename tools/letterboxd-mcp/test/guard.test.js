'use strict';
// Positive control for test/guard.cjs: a minimal script that tries every forbidden thing under the preload must be accused once
// per attempt; the same script without the preload must really write. A guard that never fires proves nothing about the server.
// Run only these: node --test test/guard.test.js
if (!require('./gate').run(__filename)) return;
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const H = require('./helpers');

after(H.cleanup);

const ATTEMPTS = {
  'fs.writeFileSync': "fs.writeFileSync(path.join(dir, 'a.txt'), 'x')",
  'fs.appendFileSync': "fs.appendFileSync(path.join(dir, 'b.txt'), 'x')",
  'fs.mkdirSync': "fs.mkdirSync(path.join(dir, 'sub'))",
  'fs.renameSync': "fs.renameSync(path.join(dir, 'seed.txt'), path.join(dir, 'moved.txt'))",
  'fs.rmSync': "fs.rmSync(path.join(dir, 'seed.txt'))",
  'fs.unlinkSync': "fs.unlinkSync(path.join(dir, 'seed.txt'))",
  'fs.createWriteStream': "fs.createWriteStream(path.join(dir, 'c.txt'))",
  'fs.openSync(write)': "fs.openSync(path.join(dir, 'd.txt'), 'w')",
  'fs.writeSync(fd n)': "fs.writeSync(9, 'x')",
  'fs.promises.writeFile': "fs.promises.writeFile(path.join(dir, 'e.txt'), 'x')",
  'fs.promises.appendFile': "fs.promises.appendFile(path.join(dir, 'f.txt'), 'x')",
  'net.connect': "require('net').connect(9, '127.0.0.1')",
  'net.createConnection': "require('net').createConnection(9, '127.0.0.1')",
  'net.Socket.prototype.connect': "new (require('net').Socket)().connect(9, '127.0.0.1')",
  'http.request': "require('http').request('http://127.0.0.1:9/')",
  'http.get': "require('http').get('http://127.0.0.1:9/')",
  'https.request': "require('https').request('https://127.0.0.1:9/')",
  'https.get': "require('https').get('https://127.0.0.1:9/')",
  'fetch': "fetch('http://127.0.0.1:9/')",
  'dns.lookup': "require('dns').lookup('example.invalid', () => {})",
  'dns.promises.lookup': "require('dns').promises.lookup('example.invalid')",
  'dns.resolve': "require('dns').resolve('example.invalid', () => {})",
  'dns.resolve4': "require('dns').resolve4('example.invalid', () => {})",
  'dns.reverse': "require('dns').reverse('127.0.0.1', () => {})",
  'dns.lookupService': "require('dns').lookupService('127.0.0.1', 80, () => {})",
  'dns.promises.resolve': "require('dns').promises.resolve('example.invalid')",
  'dns.promises.resolveTxt': "require('dns').promises.resolveTxt('example.invalid')",
  'dns.Resolver.prototype.resolve4': "new (require('dns').Resolver)().resolve4('example.invalid', () => {})",
  'dns.promises.Resolver.prototype.resolve4': "new (require('dns').promises.Resolver)().resolve4('example.invalid')",
  'net.createServer': "require('net').createServer()",
  'net.Server.prototype.listen': "new (require('net').Server)().listen(0, '127.0.0.1')",
  'http.createServer().listen': "require('http').createServer().listen(0, '127.0.0.1')",
  'child_process.spawn': "require('child_process').spawn('true')",
  'child_process.execSync': "require('child_process').execSync('true')",
};

// an attempt whose guard accuses a lower layer than the one it names: http listens through net.Server
const ACCUSED_AS = { 'http.createServer().listen': 'net.Server.prototype.listen' };

function runUnder(attempt, guard) {
  const dir = H.mkdtemp('mcp-guard-');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed');
  const script = path.join(dir, 'probe.cjs');
  fs.writeFileSync(script, `const fs = require('fs'), path = require('path'); const dir = ${JSON.stringify(dir)};\ntry { ${attempt}; } catch (e) { console.log('threw: ' + e.message); }\nsetTimeout(() => {}, 50);\n`);
  const r = spawnSync(process.execPath, [...(guard ? ['--require', H.GUARD] : []), script], { encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH } });
  return { r, dir };
}

for (const [label, attempt] of Object.entries(ATTEMPTS)) {
  test(`guard accuses ${label}`, () => {
    const { r, dir } = runUnder(attempt, true);
    assert.match(r.stderr, new RegExp(`GUARD-VIOLATION ${(ACCUSED_AS[label] || label).replace(/[.()]/g, '\\$&').replace(/ n\\\)/, '.*')}`), r.stderr);
    assert.match(r.stdout, /threw: GUARD-VIOLATION/, 'and the attempt is stopped, not just reported');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['probe.cjs', 'seed.txt'], 'nothing was created or removed');
  });
}

test('without the preload the same file attempt really writes (so the guard is what stopped it)', () => {
  const { r, dir } = runUnder(ATTEMPTS['fs.writeFileSync'], false);
  assert.equal(r.stderr, '');
  assert.ok(fs.existsSync(path.join(dir, 'a.txt')));
});

test('reading files and writing to stdout and stderr stay allowed under the guard', () => {
  const { r } = runUnder("console.log('read: ' + fs.readFileSync(path.join(dir, 'seed.txt'), 'utf8')); fs.writeSync(2, 'to stderr\\n'); fs.readdirSync(dir); fs.statSync(dir)", true);
  assert.match(r.stdout, /read: seed/);
  assert.ok(!r.stderr.includes('GUARD-VIOLATION'), r.stderr);
});
