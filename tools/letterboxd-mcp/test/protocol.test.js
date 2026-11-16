'use strict';
// The server through the official MCP client (@modelcontextprotocol/client over stdio): initialize, tools/list, tools/call of
// every tool, and what an invalid call looks like on the wire.
// Run only these: node --test test/protocol.test.js
if (!require('./gate').run(__filename)) return;
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const H = require('./helpers');

let s;
before(async () => { s = await H.connect({ root: H.FIXTURE }); });
after(H.cleanup);

const EXPECTED_TOOLS = ['film_check', 'film_dossier', 'film_friends', 'film_health', 'film_overlap', 'film_research_evidence', 'film_search', 'film_taste', 'film_why'];

test('initialize: the server names itself and offers tools, nothing else', () => {
  assert.equal(s.client.getServerVersion().name, 'letterboxd-mcp');
  const caps = s.client.getServerCapabilities();
  assert.ok(caps.tools);
  assert.equal(caps.resources, undefined);
  assert.equal(caps.prompts, undefined);
});

test('tools/list: nine tools, each read-only, non-destructive, idempotent, closed-world, with an object input schema that refuses extra keys', async () => {
  const { tools } = await s.client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), EXPECTED_TOOLS);
  const evidence = tools.find((t) => t.name === 'film_research_evidence');
  assert.match(evidence.description, /EVIDENCE AND PROPOSALS FOR REVIEW/);
  assert.match(evidence.description, /`applied` is always false and nothing here was applied to production/);
  assert.match(evidence.description, /For up to 5 ids/);
  assert.match(evidence.description, /tmdb:603 and lb:the-matrix reach the film the package keeps as tt0133093/);
  assert.match(evidence.description, /`candidates`, never a pick/);
  assert.match(evidence.description, /`withoutPage` per source.*`identityNotConfirmed` per source/);
  assert.equal(evidence.inputSchema.properties.ids.minItems, 1);
  assert.equal(evidence.inputSchema.properties.ids.maxItems, 5, '12/10/2026 measure in Claude Code 2.1.290: 5 of the largest real records arrive inline, 10 (53 KB) were moved to a saved file');
  assert.equal(tools.find((t) => t.name === 'film_check').inputSchema.properties.ids.maxItems, 50, 'the other tools keep 50: their answers are small');
  assert.deepEqual(evidence.inputSchema.required, ['ids']);
  for (const t of tools) {
    assert.deepEqual(t.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, t.name);
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name}: extra keys must be refused`);
    assert.ok(t.description && t.description.length > 20, t.name);
  }
  const search = tools.find((t) => t.name === 'film_search');
  assert.deepEqual(search.inputSchema.properties.mood.enum, ['lift', 'wander', 'slow'], 'the mood menu is the config’s, read at start');
  assert.equal(search.inputSchema.properties.limit.maximum, 100);
  assert.equal(search.inputSchema.properties.limit.default, 20);
});

test('tools/call: every tool answers with structuredContent and the same JSON as text', async () => {
  for (const [name, args] of H.VALID_CALLS) {
    const r = await s.client.callTool({ name, arguments: args });
    assert.ok(!r.isError, `${name}: ${r.content?.[0]?.text}`);
    assert.equal(r.content[0].type, 'text');
    assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent, name);
    assert.equal(r.structuredContent.source.root, 'fixture', name);
  }
  const search = await s.client.callTool({ name: 'film_search', arguments: { unseen: true, eligible: true, maxMinutes: 100, limit: 5 } });
  assert.equal(search.structuredContent.total, 3);
  assert.equal(search.structuredContent.shown, 3);
});

test('an invalid call comes back as a tool result with isError: true and a message that names the tool; nothing is thrown to the client', async () => {
  for (const [name, args] of [['film_search', { limit: 101 }], ['film_search', { apiKey: 'x' }], ['film_check', { ids: ['../etc'] }], ['film_overlap', { a: { kind: 'friend', user: 'nobody' }, b: { kind: 'seen' } }], ['film_why', { query: 'x', snapshots: '/etc' }], ['film_taste', { facet: 'genre', limit: Infinity }], ['film_research_evidence', { ids: ['../etc/passwd'] }], ['film_research_evidence', { ids: [] }], ['film_research_evidence', { ids: ['tt0000007'], path: '/etc' }]]) {
    const r = await s.client.callTool({ name, arguments: args });
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(r.content[0].text, new RegExp(name));
    assert.equal(r.structuredContent, undefined);
  }
});

test('film_research_evidence through the client on a root WITH the package: found / not found, applied false, the same JSON as text, and no hash on the wire', async () => {
  const root = H.copyFixture({ research: true });
  const withPackage = await H.connect({ root });
  const r = await withPackage.client.callTool({ name: 'film_research_evidence', arguments: { ids: ['tt0000007', 'tt0099999'] } });
  assert.ok(!r.isError, r.content?.[0]?.text);
  assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
  const out = r.structuredContent;
  assert.equal(out.available, true);
  assert.equal(out.package.applied, false);
  assert.deepEqual(out.results.map((x) => [x.id, x.found]), [['tt0000007', true], ['tt0099999', false]]);
  assert.equal(out.results[0].applied, false);
  assert.ok(!/sha256|etag/i.test(r.content[0].text));
  const tooMany = await withPackage.client.callTool({ name: 'film_research_evidence', arguments: { ids: Array.from({ length: 11 }, (_, i) => `tt${1000000 + i}`) } });
  assert.equal(tooMany.isError, true, 'eleven ids are refused through the client too');
  const none = await s.client.callTool({ name: 'film_research_evidence', arguments: { ids: ['tt0000007'] } });
  assert.equal(none.structuredContent.available, false, 'the shared fixture has no package: the answer says so');
  await withPackage.close();
});

test('an unknown tool is the other kind of failure: a protocol error the client throws, not a tool result', async () => {
  await assert.rejects(() => s.client.callTool({ name: 'film_delete', arguments: {} }), (e) => /not found/i.test(e.message));
});

test('stderr holds one JSON line per call with exactly ts, tool, ms, ok — no arguments, no titles, no paths', async () => {
  await s.client.callTool({ name: 'film_dossier', arguments: { queries: ['Community Only'] } });
  // stderr is a separate pipe from the reply: give the last line a moment to arrive before counting.
  const deadline = Date.now() + 3000;
  while (s.stderr().trim().split('\n').length < 10 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  const lines = s.stderr().trim().split('\n');
  assert.ok(lines.length >= 10, `${lines.length} log lines`);
  for (const l of lines) {
    const j = JSON.parse(l);
    assert.deepEqual(Object.keys(j), ['ts', 'tool', 'ms', 'ok']);
    assert.ok(EXPECTED_TOOLS.includes(j.tool));
  }
  // Calls the SDK refuses on the schema never reach the handler, so they leave no line; only calls that ran are logged.
  assert.ok(!s.stderr().includes('Community'));
  assert.ok(!s.stderr().includes(H.FIXTURE));
});

test('stdout carries protocol and nothing else: every line the server prints is a JSON-RPC message', async () => {
  const child = spawn(process.execPath, [H.SERVER, '--root', H.FIXTURE], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/call', params: { name: 'film_health', arguments: {} } });
  send({ id: 3, method: 'tools/call', params: { name: 'film_search', arguments: { limit: 101 } } });
  const deadline = Date.now() + 15000;
  while (!(/"id":3/.test(out)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  child.stdin.end();
  await new Promise((r) => child.on('close', r));
  const lines = out.split('\n').filter(Boolean);
  assert.ok(lines.length >= 3, out);
  for (const l of lines) assert.equal(JSON.parse(l).jsonrpc, '2.0', `not a protocol line: ${l.slice(0, 80)}`);
});

test('film_dossier exposes optional compact parameters on a strict top-level object and refuses their misuse', async () => {
  const { tools } = await s.client.listTools();
  const schema = tools.find((t) => t.name === 'film_dossier').inputSchema;
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['queries']);
  assert.deepEqual(schema.properties.view.enum, ['full', 'mubi']);
  assert.equal(schema.properties.maxChars.minimum, 2000);
  assert.equal(schema.properties.maxChars.maximum, 30000);
  assert.equal(schema.properties.cursor.maxLength, 1024);
  for (const input of [{ queries: ['tt0000007'], maxChars: 2000 }, { queries: ['tt0000007'], view: 'full', cursor: 'x' },
    { queries: ['tt0000007'], view: 'mubi', maxChars: 1999 }, { queries: ['tt0000007'], view: 'mubi', cursor: '=' }]) {
    const r = await s.client.callTool({ name: 'film_dossier', arguments: input });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent, undefined);
  }
});
