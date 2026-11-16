'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
for (const worker of [false, true]) {
  test(`FP validation: ${worker ? 'Worker' : 'publisher'} handles long text without quadratic scanning`, () => {
    const code = `(async () => {
      const assert = require('node:assert/strict');
      const validate = ${worker ? "(await import('./worker/src/page-source.js')).validatePageShard" : "require('./lib/page-validation').validateShard"};
      const s = { v: 1, builtAt: '2026-10-24T12:00:00Z', shard: '01', people: [], films: [{ t: 'tt1', n: 'x'.repeat(200 * 1024) }] };
      validate(s, '01');
      s.films[0].n += '@'; validate(s, '01');
      s.films[0].n += 'domain.test'; assert.throws(() => validate(s, '01'));
      for (const n of ['private@example.test', 'https://example.test/k/private', 'you rate 4']) {
        s.films[0].n = n; assert.throws(() => validate(s, '01'));
      }
      process.stdout.write('bounded scans and privacy checks passed');
    })().catch(e => { console.error(e); process.exitCode = 1; });`;
    const got = spawnSync(process.execPath, ['-e', code], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 3000 });
    assert.equal(got.error?.code, undefined, 'validation exceeded the independent three-second deadline');
    assert.equal(got.status, 0, got.stderr);
    assert.equal(got.stdout, 'bounded scans and privacy checks passed');
  });
}
