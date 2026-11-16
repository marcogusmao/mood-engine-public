'use strict';
// The repository's root `node --test` also discovers every .js under a directory named `test`, including this package's, whose
// dependencies live in tools/letterboxd-mcp/node_modules and are not installed by the root CI step. Without them each test
// file registers one skipped test (visible in the report) instead of failing on require. With them (npm ci, then npm test) it runs.
// Used as the first lines of every *.test.js here: `if (!require('./gate').run(__filename)) return;`

function available() {
  try {
    for (const m of ['zod', '@modelcontextprotocol/server', '@modelcontextprotocol/client']) require.resolve(m);
    return true;
  } catch { return false; }
}

function run(file) {
  if (available()) return true;
  require('node:test')(`${require('node:path').basename(file)}: skipped, run npm ci in tools/letterboxd-mcp first`, { skip: true }, () => {});
  return false;
}

module.exports = { available, run };
