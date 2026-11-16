// Before-red entry: imports only the existing publisher and this synthetic fixture.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { publish } = require('../lib/publish');
const { fixture } = require('../test-support/film-page-fixture');
test('FP export: real publisher writes 100 shards covering the complete v2 index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-page-'));
  try {
    const f = fixture(), outDir = path.join(root, 'site'); assert.doesNotThrow(() => publish({ ...f, outDir }));
    const names = fs.readdirSync(path.join(outDir, 'data')).filter(n => n.startsWith('page-')); assert.equal(names.length, 100);
    const films = names.flatMap(n => JSON.parse(fs.readFileSync(path.join(outDir, 'data', n))).films); assert.deepEqual(films.map(r => r.t), f.index2.films.map(r => r.tt));
    const movie = JSON.parse(fs.readFileSync(path.join(outDir, 'data/page-65.json'))).films[0]; assert.ok(movie, 'the movie belongs to shard 65'); assert.equal(movie.syn, 'A quiet arrival. An unexpected meeting.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
