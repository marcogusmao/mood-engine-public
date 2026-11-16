'use strict';
const test = require('node:test'), a = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const F = require('../test-support/people/fixture'), I = require('../lib/person-input');
const P = require('../lib/people'), B = require('../scripts/verify-artifact-boundaries');
const shuffle = require('../lib/front-shuffle');
const at = '2026-10-15T12:00:00.000Z', date = '2026-10-15';
const memory = {version: 1, days: {'2026-10-14': {tt1234567: 2}}};
function input(t) {
  const f = F.fixture(t), h = F.history();
  for (const [name, data] of Object.entries({'history.json': h, 'identities.json': {}, 'coverage.json': h.coverage})) I.write(path.join(f.privateDir, name), data);
  return {...f, sourceRequestId: h.sourceRequestId, codeSha: 'a'.repeat(40), capturedAt: at, selectionDate: date};
}
test('root cache handoff accepts front memory, refuses private and extra paths', t => {
  const f = F.fixture(t), dir = path.join(f.root, 'handoff');
  f.write('handoff/front-memory.json', memory);
  a.equal(B.verifyCache(dir), true);
  for (const name of ['friend-a/front-memory.json', 'history.json', 'front-memory-extra.json']) {
    const file = f.write('handoff/' + name, memory);
    a.throws(() => B.verifyCache(dir), /Unexpected cache-update/);
    fs.rmSync(file);
  }
});
test('fresh runner preserves Will front memory and next-day exposure', t => {
  const f = input(t);
  I.write(path.join(f.privateDir, 'cache/front-memory.json'), memory);
  const bytes = I.snapshot(f), dest = path.join(f.root, '.context/private/friend-a/fresh');
  I.restore({...f, privateDir: dest, bytes});
  const restored = JSON.parse(fs.readFileSync(path.join(dest, 'cache/front-memory.json')));
  a.deepEqual(restored, memory);
  const read = shuffle.readMemory(path.join(dest, 'cache/front-memory.json'));
  a.equal(read.problem, null);
  a.equal(shuffle.exposure(read.days, date, shuffle.DEFAULTS).get('tt1234567'), 2);
  a.equal(fs.statSync(path.join(dest, 'cache/front-memory.json')).mode & 0o777, 0o600);
});
test('new personal input never seeds Marco front memory', t => {
  const f = input(t);
  f.write('cache/front-memory.json', memory);
  require('../scripts/prepare-person').preparePerson(f.root, 'friend-a', f.privateDir);
  a(!fs.existsSync(path.join(f.privateDir, 'cache/front-memory.json')));
  a(!JSON.parse(I.snapshot(f)).files.some(file => file.path === 'cache/front-memory.json'));
  a.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'cache/front-memory.json'))), memory);
});
test('malformed front memory with a valid digest is rejected before restore writes', t => {
  const f = input(t), good = JSON.parse(I.snapshot(f));
  const bad = [
    {...memory, owner: 'marco'}, {version: 2, days: {}}, {version: 1, days: []},
    {version: 1, days: {'2026-02-30': {tt1234567: 1}}},
    {version: 1, days: {'2026-10-14': {notImdb: 1}}},
    ...[0, 55, 1.5, '2'].map(n => ({version: 1, days: {'2026-10-14': {tt1234567: n}}})),
  ];
  for (let n = 0; n < bad.length; n++) {
    const data = bad[n], raw = Buffer.from(I.canonical(data));
    const s = {...good, files: [...good.files, {path: 'cache/front-memory.json', data, bytes: raw.length, sha256: I.sha(raw)}]};
    const dest = path.join(f.root, '.context/private/friend-a/bad-' + n);
    a.throws(() => I.restore({...f, privateDir: dest, bytes: Buffer.from(I.canonical(s))}));
    a(!fs.existsSync(dest));
  }
});
test('personal front memory symlink is refused before build access', t => {
  const f = input(t), target = f.write('cache/front-memory.json', memory);
  fs.mkdirSync(path.join(f.privateDir, 'cache'), {recursive: true});
  fs.symlinkSync(target, path.join(f.privateDir, 'cache/front-memory.json'));
  a.throws(() => P.buildPersonOptions(f.root, ['--person', 'friend-a', '--private-dir', f.privateDir, '--person-input', path.join(f.privateDir, 'history.json')]), /Symlink/);
});
