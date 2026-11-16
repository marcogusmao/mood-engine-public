#!/usr/bin/env node
'use strict';
// films — measures the CLI's eligibility (`elig`) against the index the build published (Fase A, 12/10/2026). Read only.
//
//   node tools/films/compare-published.js <published-index.json> [--root <repo>] [--examples 15]
//
// The published index is the Worker's (rows + `cols`): flag bit 4 of the `flags` column is `eligible`, the build's Q.qualifies() AND the
// private feedback of that build (`permits`: "not tonight" / "not for me" take a film out). So "published false / CLI true" may be feedback
// the CLI cannot see; it is reported apart from the rest. The file is private and local (.context/ is ignored by git): the path is an argument.
// Meta: the CLI reads the caches of THIS checkout, which the nightly build may have moved since the published build; where the Letterboxd average
// differs between the two, the divergence is still counted in `divergences`, but its cause is labelled "average moved": it is not evidence
// against the rule.
// Lists (M1, 12/10/2026): the `lists` column of a published row is "listId:position,…" (the curator's 1-based position, the first one when a film
// is twice in a list). The CLI's index.lists carries the same pairs; the comparison covers the films both sides have and says, per list, how many
// memberships are only in the published index, only in the CLI, or in both at another position (positions are compared only when the CLI index
// carries them).

const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./store');
const Q = require('../../lib/recommendation-quality');

/** "a:3,b:10" → { a: 3, b: 10 } (the published `lists` column). */
const parseLists = (cell) => (cell ? Object.fromEntries(String(cell).split(',').map((x) => { const [id, pos] = x.split(':'); return [id, Number(pos)]; })) : {});

/** The CLI's memberships: tt → { listId: position | null }. position is null when the index does not carry positions. */
function cliMemberships(index) {
  const m = new Map();
  for (const [lid, l] of Object.entries(index.lists || {})) {
    const hasPos = Array.isArray(l.positions) && l.positions.length === l.ids.length;
    l.ids.forEach((id, i) => { if (!m.has(id)) m.set(id, {}); m.get(id)[lid] = hasPos ? l.positions[i] : null; });
  }
  return m;
}

function compareLists(published, index, { examples = 15 } = {}) {
  const col = Object.fromEntries(published.cols.map((c, i) => [c, i]));
  if (col.lists === undefined) return { error: 'the published index has no "lists" column' };
  const names = Object.fromEntries((published.lists || []).map((l) => [l.id, l.label]));
  const cli = cliMemberships(index);
  const byId = new Set(index.films.map((f) => f.id));
  const out = { filmsCompared: 0, positionsCompared: Object.values(index.lists || {}).some((l) => Array.isArray(l.positions)), memberships: { published: 0, cli: 0, agree: 0 },
    divergences: { 'published only': 0, 'CLI only': 0, 'position differs': 0 }, byList: {}, examples: [] };
  const list = (id) => (out.byList[id] ||= { name: names[id] ?? index.lists?.[id]?.name ?? null, 'published only': 0, 'CLI only': 0, 'position differs': 0 });
  const note = (kind, id, tt, row, extra) => {
    out.divergences[kind]++;
    list(id)[kind]++;
    if (out.examples.length < examples) out.examples.push({ id: tt, title: row[col.name], list: id, listName: names[id] ?? null, kind, ...extra });
  };
  for (const row of published.films) {
    const tt = row[col.tt];
    if (!byId.has(tt)) continue;
    out.filmsCompared++;
    const pub = parseLists(row[col.lists]), mine = cli.get(tt) || {};
    out.memberships.published += Object.keys(pub).length;
    out.memberships.cli += Object.keys(mine).length;
    for (const id of new Set([...Object.keys(pub), ...Object.keys(mine)])) {
      if (!(id in mine)) note('published only', id, tt, row, { published: pub[id] });
      else if (!(id in pub)) note('CLI only', id, tt, row, { cli: mine[id] });
      else if (mine[id] !== null && mine[id] !== pub[id]) note('position differs', id, tt, row, { published: pub[id], cli: mine[id] });
      else out.memberships.agree++;
    }
  }
  return out;
}

function compare(published, index, { examples = 15 } = {}) {
  const col = Object.fromEntries(published.cols.map((c, i) => [c, i]));
  for (const need of ['tt', 'flags', 'lbRating']) if (col[need] === undefined) throw new Error(`published index has no "${need}" column (cols: ${published.cols.join(',')})`);
  const cli = new Map(index.films.map((f) => [f.id, f]));
  const out = { published: { films: published.films.length, builtAt: published.meta?.builtAt ?? null, version: published.meta?.version ?? null }, cli: { films: index.films.length, indexBuiltAt: index.meta.builtAt ?? null },
    agree: { eligible: 0, notEligible: 0 }, notInCli: 0, divergences: { 'published true / CLI false': 0, 'published false / CLI true': 0 }, causes: {}, examples: [] };
  const seenIds = new Set();
  for (const row of published.films) {
    const tt = row[col.tt];
    seenIds.add(tt);
    const f = cli.get(tt);
    if (!f) { out.notInCli++; continue; }
    const pub = (row[col.flags] & 4) === 4;
    const mine = f.elig === true;
    if (pub === mine) { out.agree[pub ? 'eligible' : 'notEligible']++; continue; }
    const kind = pub ? 'published true / CLI false' : 'published false / CLI true';
    out.divergences[kind]++;
    const pubLb = row[col.lbRating];
    const moved = (Number.isFinite(pubLb) || Number.isFinite(f.lb)) && !(Number.isFinite(pubLb) && Number.isFinite(f.lb) && Math.abs(pubLb - f.lb) < 0.005);
    const cause = moved ? 'average moved since the published build (or one side has none)'
      : !pub && mine ? (f.cv ? 'CLI passes through the vouched exception: feedback in the published build, or a vouch the build did not have' : 'CLI passes by average or friend: private feedback in the published build, or a friend rating newer than it')
      : f.cv && Number.isFinite(f.lb) && f.lb < Q.VOUCHED_MIN_STARS ? `CLI refuses a vouched film whose average ${f.lb} is under the vouched floor of ${Q.VOUCHED_MIN_STARS}, while the published build let it through at the same average: investigate`
      : f.cv ? 'CLI refuses a vouched film for a reason other than the vouched floor: investigate'
      : 'CLI refuses, average unchanged: investigate';
    out.causes[`${kind}: ${cause}`] = (out.causes[`${kind}: ${cause}`] || 0) + 1;
    if (out.examples.length < examples) out.examples.push({ id: tt, title: row[col.name] ?? f.title, kind, published: { lb: pubLb ?? null, flags: row[col.flags] }, cli: { lb: f.lb, friends: f.fr, vouched: f.cv ? f.cvList : false, why: f.eligWhy }, cause });
  }
  out.notInPublished = { films: index.films.filter((f) => !seenIds.has(f.id)).length, ofWhichEligibleInCli: index.films.filter((f) => !seenIds.has(f.id) && f.elig === true).length,
    note: 'the published index holds the build\'s candidates and pools, not every film on file: absence there is not a divergence' };
  out.lists = compareLists(published, index, { examples });
  return out;
}

function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const file = args.find((a) => a !== opt('root') && a !== opt('examples'));
  if (!file) throw new Error('usage: node tools/films/compare-published.js <published-index.json> [--root <repo>] [--examples 15]');
  const root = path.resolve(opt('root', path.resolve(__dirname, '..', '..')));
  const published = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { index } = load(root, { write: false }); // read only: the comparison never writes an index
  return compare(published, index, { examples: Number(opt('examples', 15)) });
}

module.exports = { compare, main };

if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 1)); } catch (e) { console.error(JSON.stringify({ error: e.message })); process.exitCode = 1; }
}
