// Runs every test file except those listed in PRIVATE-DATA-TESTS.txt, which need data that is not in this public repository.
// Usage: node scripts/public-tests.mjs [root|worker]
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const which = process.argv[2] || 'root';
const cwd = which === 'worker' ? 'worker' : '.';
const listed = new Set(
  readFileSync(join(cwd, 'test', 'PRIVATE-DATA-TESTS.txt'), 'utf8')
    .split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'))
);
const files = readdirSync(join(cwd, 'test'))
  .filter(f => /\.test\.(js|mjs)$/.test(f))
  .map(f => `test/${f}`)
  .filter(f => !listed.has(f));
console.log(`${which}: running ${files.length} test files, skipping ${listed.size} that need private data`);
const r = spawnSync(process.execPath, ['--test', ...files], { cwd, stdio: 'inherit' });
process.exit(r.status ?? 1);
