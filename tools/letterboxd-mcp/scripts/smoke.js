#!/usr/bin/env node
'use strict';
// Smoke run: the official MCP client spawns the server on a real root and prints tools/list plus a summary of two calls.
//   node scripts/smoke.js [root]        (default: the repository this package lives in, ../..)
// Prints counts, ids, titles and public facts; never a friend's rating, never an absolute path.

const path = require('node:path');
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');

const pkg = path.resolve(__dirname, '..');
const root = path.resolve(process.argv[2] || path.join(pkg, '..', '..'));

(async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(pkg, 'src', 'server.js'), '--root', root], cwd: pkg, stderr: 'pipe' });
  let errBytes = 0;
  transport.stderr?.on('data', (d) => { errBytes += d.length; });
  const client = new Client({ name: 'smoke', version: '0.0.0' });
  const t0 = Date.now();
  await client.connect(transport);
  console.log('connected in', Date.now() - t0, 'ms; server', JSON.stringify(client.getServerVersion()));

  const { tools } = await client.listTools();
  console.log(`tools/list: ${tools.length} tools`);
  for (const t of tools) console.log(`  ${t.name}  annotations=${JSON.stringify(t.annotations)}  inputKeys=${Object.keys(t.inputSchema.properties || {}).length}`);

  const call = async (name, args) => {
    const t1 = Date.now();
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`${name} failed: ${r.content?.[0]?.text}`);
    return [r.structuredContent, Date.now() - t1];
  };

  const [h, hms] = await call('film_health', {});
  const ages = Object.values(h.sources).filter((s) => typeof s === 'object').map((s) => s.fileModifiedHoursAgo);
  console.log(`film_health (${hms} ms): source.root=${h.source.root} films=${h.films} eligible=${h.eligible} accounts=${h.accounts} sources=${Object.keys(h.sources).length} (file mtimes up to ${Math.max(...ages)} h ago: checkout time, not data age) pending=${JSON.stringify(h.pending)}`);
  console.log(`  capturedAt=${JSON.stringify(h.capturedAt)} signature=${h.source.signature}`);

  const q = { unseen: true, eligible: true, maxMinutes: 100, limit: 5 };
  const [s, sms] = await call('film_search', q);
  console.log(`film_search ${JSON.stringify(q)} (${sms} ms): total=${s.total} shown=${s.shown} aggregateOver=${s.aggregateOver} aggregate.n=${s.aggregate.n} excludedAsUnknown=${JSON.stringify(s.excludedAsUnknown)}`);
  for (const f of s.films) console.log(`  ${f.id}  ${f.title} (${f.year})  ${f.rt} min  lb ${f.lb}`);

  // The research package (evidence and proposals, never applied). Without the package in the root the answer is { available: false, reason }.
  const rq = { ids: ['tt5247022', 'tt0076786', 'tmdb:603', 'lb:the-matrix'] };
  const t2 = Date.now();
  const raw = await client.callTool({ name: 'film_research_evidence', arguments: rq });
  if (raw.isError) throw new Error(`film_research_evidence failed: ${raw.content?.[0]?.text}`);
  const r = raw.structuredContent;
  if (!r.available) console.log(`film_research_evidence (${Date.now() - t2} ms): available=false reason=${r.reason}`);
  else {
    console.log(`film_research_evidence ${JSON.stringify(rq)} (${Date.now() - t2} ms, ${Buffer.byteLength(raw.content[0].text)} bytes of text): package.records=${r.package.records} generatedAt=${r.package.generatedAt} withoutPage=${JSON.stringify(r.package.withoutPage)} identityNotConfirmed=${JSON.stringify(r.package.identityNotConfirmed)} package.applied=${r.package.applied}`);
    for (const f of r.results) console.log(`  requested=${f.requested} id=${f.id}  found=${f.found}${f.found ? `  ${f.title} (${f.year})  editorialStatus=${f.editorialStatus}  proposal=${f.editorialProposal ? f.editorialProposal.status : 'none'}  applied=${f.applied}` : ''}`);
  }

  await client.close();
  console.log(`server stderr: ${errBytes} bytes (one JSON line per call)`);
})().catch((e) => { console.error('smoke failed:', e.message); process.exit(1); });
