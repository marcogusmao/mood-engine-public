const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const SN = require('../lib/learning/snapshot'), E = require('../lib/learning/experience');
const CLI = require('../scripts/learning');

for (const file of ['experience.json', 'embeddings.json']) test('capture refuses '+file+' symlink before reading private content', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-read-boundary-'));
  try {
    const root = path.join(temp, 'source'), dir = path.join(temp, 'private');
    fs.mkdirSync(root); fs.mkdirSync(dir); fs.writeFileSync(path.join(root, 'config.json'), '{}');
    const external = path.join(temp, 'external.json');
    fs.writeFileSync(external, JSON.stringify(file === 'experience.json' ? E.empty() : {}));
    fs.symlinkSync(external, path.join(dir, file));
    assert.throws(() => SN.capture({root, dir, date:'2026-10-10', capturedAt:'2026-10-10T12:00:00.000Z'}), /Symlink in private target/);
    assert(!fs.existsSync(path.join(dir, 'snapshots')));
  } finally { fs.rmSync(temp, {recursive:true, force:true}); }
});

test('experience export refuses private source symlink without creating export', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-export-boundary-'));
  try {
    const root = path.join(temp, 'source'), dir = path.join(temp, 'private');
    fs.mkdirSync(root); fs.mkdirSync(dir);
    const external = path.join(temp, 'external.json');
    fs.writeFileSync(external, JSON.stringify(E.empty())); fs.symlinkSync(external, path.join(dir, 'experience.json'));
    assert.throws(() => CLI.main(['export-experience','--source',root,'--private-dir',dir]), /Symlink in private target/);
    assert(!fs.existsSync(path.join(dir, 'experience-export.json')));
  } finally { fs.rmSync(temp, {recursive:true, force:true}); }
});
