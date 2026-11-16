'use strict';
// Shared by the tests of this package: fixture copies, directory listings, and a connected official MCP client.
// Heavy requires are lazy so the root `node --test` can load this file without the package's node_modules (see gate.js).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const PKG = path.resolve(__dirname, '..');
const SERVER = path.join(PKG, 'src', 'server.js');
const GUARD = path.join(__dirname, 'guard.cjs');
const FIXTURE = path.join(__dirname, 'fixture');

const made = [];
const open = []; // clients still connected: a failing assertion must not leave a server process alive and hang the run
/** A fresh temp dir, removed by cleanup() (call it from `after`). */
const mkdtemp = (prefix) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); made.push(d); return d; };
const cleanup = async () => {
  for (const c of open.splice(0)) await c.close().catch(() => {});
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
};

/**
 * Copy of the fixture root in a temp dir, named `fixture` so source.root is predictable. `research: true` also writes the small invented research
 * package (test/research-fixture.js) into the copy: the fixture itself carries none, so nothing binary is versioned.
 */
function copyFixture({ research = false } = {}) {
  const dir = path.join(mkdtemp('mcp-fixture-'), 'fixture');
  fs.cpSync(FIXTURE, dir, { recursive: true });
  if (research) require('./research-fixture').writePackage(dir);
  return dir;
}

/** Every file and directory under dir: relative path → kind, size, mtimeMs, sha256 (files). */
function listing(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), rel = path.relative(dir, p), s = fs.statSync(p);
      if (e.isDirectory()) { out[rel] = { kind: 'dir', mtimeMs: s.mtimeMs }; walk(p); } else out[rel] = { kind: 'file', size: s.size, mtimeMs: s.mtimeMs, sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') };
    }
  };
  walk(dir);
  return out;
}

/**
 * Spawns the server with the official client. opts: { root, args, env, guard (default true) }.
 * → { client, stderr() (all stderr so far), close() }. The guard is preloaded in the SERVER process only.
 */
async function connect({ root = FIXTURE, args, env = {}, guard = true } = {}) {
  const { Client } = require('@modelcontextprotocol/client');
  const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/client/stdio');
  const e = { ...getDefaultEnvironment(), ...env };
  if (guard) e.NODE_OPTIONS = `--require ${GUARD}`;
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, ...(args || ['--root', root])], env: e, cwd: PKG, stderr: 'pipe' });
  let err = '';
  transport.stderr.on('data', (d) => { err += d.toString(); });
  const client = new Client({ name: 'mcp-test', version: '0.0.0' });
  await client.connect(transport);
  open.push(client);
  return { client, stderr: () => err, close: () => client.close() };
}

/** One valid call per tool on the fixture, plus the one tool-specific name each result is checked by. */
const VALID_CALLS = [
  ['film_health', {}],
  ['film_dossier', { queries: ['tt0000007', 'Suspiria', 'Suspiria 2018', 'no such film 1900'] }],
  ['film_search', { unseen: true, eligible: true, maxMinutes: 100, limit: 5 }],
  ['film_check', { ids: ['tt0000006', 'tt0000007'], maxMinutes: 100 }],
  ['film_overlap', { a: { kind: 'watchlist' }, b: { kind: 'friends', op: '>=', value: 4 }, limit: 10 }],
  ['film_taste', { facet: 'genre', minFilms: 1, limit: 5 }],
  ['film_friends', { scope: 'all', limit: 5 }],
  ['film_why', { query: 'tt0000007' }],
  ['film_research_evidence', { ids: ['tt0000007', 'tt0000016', 'tt0099999'] }],
];

module.exports = { PKG, SERVER, GUARD, FIXTURE, mkdtemp, cleanup, copyFixture, listing, connect, VALID_CALLS };
