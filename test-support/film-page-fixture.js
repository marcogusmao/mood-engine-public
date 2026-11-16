// Synthetic, no build, network, account or cache-file reads.
const path = require('node:path');
const { buildIndex } = require('../lib/index-export');
function fixture({ person = false, separator = '\n\n', overview = 'A quiet arrival. An unexpected meeting.', title = 'Synthetic film', extra = [] } = {}) {
  const cfg = { addon: { id: 'fixture', version: '1.0.0', name: 'Fixture', description: 'Fixture' }, moods: [], lists: [{ id: 'critic', trust: 'critic' }, { id: 'fan', trust: 'fan' }], ...(person ? { personContext: { personId: 'friend-a', revision: 'r-' + 'a'.repeat(32) } } : {}) };
  const item = { id: 'tt0057565', title, year: 1963, overview, genres: ['Drama'], directors: ['Director, Jr.'], cast: ['Actor #1'], runtime: 142 };
  const plan = { board: [{ id: 'tonight', name: 'Tonight', items: [item, ...extra] }], discover: [] };
  const args = { cfg, today: '2026-10-24', builtAt: '2026-10-24T12:00:00.000Z', plan, separator };
  const index = buildIndex(args), pageFacts = new Map();
  const index2 = buildIndex({ ...args, pageFacts, plan: { ...plan, board: plan.board.map(r => ({ ...r, place: 'board' })) }, v2: { menu: [], countries: [] } });
  return { cfg, plan, index, index2, pageFacts, webData: {}, webDir: path.join(__dirname, '../web') };
}
// 24/10/2026: verify.js now requires the 100 page shards next to any v2 index. Tests that write only index-v2*.json with writeIndex and then run verifyIndex add the shards with the least facts the family accepts (no cast, no directors, no synopsis).
function writeMinimalPages(outDir, index2) {
  const facts = new Map(index2.films.map(e => [e.tt, { cast: [], directors: [], keywords: [], synopsis: '', synopsisSource: 'none', listIds: [] }]));
  return require('../lib/page-export').writePages(outDir, index2, facts);
}
module.exports = { fixture, writeMinimalPages };
