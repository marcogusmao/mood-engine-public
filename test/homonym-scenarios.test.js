'use strict';
// The nightly build rewrites cache/friends.json and cache/tmdb.json; the v2.1 pin must not stop it over the homonym list (review P1,
// Marco 11/10/2026: "Continuar publicando e anotar no registro o que mudou"). Three changes the reviewer measured are planted on copies
// of the repository and of the v2.3 reference: the pin stays green and the build log names what entered, left or changed.
// These scenarios start from the APPROVED inputs (lib/search-links-approved.json): on any other inputs (a nightly build) they are
// skipped, never failed — the caches they assume may already have moved (a record read, a film watched).
const test = require('node:test');
const a = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../test-support/integration-reference');

const ROOT = path.resolve(__dirname, '..');
const REFERENCE = path.join(ROOT, '.context/v23-reference');
const SKIP = new Set(['.git', '.context', 'docs', 'node_modules', 'worker']);

async function scenario(change) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'homonym-scenario-'));
  try {
    const root = path.join(tmp, 'root'), reference = path.join(tmp, 'reference');
    for (const n of fs.readdirSync(ROOT)) if (!SKIP.has(n)) fs.cpSync(path.join(ROOT, n), path.join(root, n), { recursive: true });
    fs.cpSync(REFERENCE, reference, { recursive: true });
    const read = (n) => JSON.parse(fs.readFileSync(path.join(root, 'cache', n), 'utf8'));
    const caches = { tmdb: read('tmdb.json'), friends: read('friends.json') };
    change(caches);
    for (const [k, v] of Object.entries(caches)) for (const dir of [root, reference]) fs.writeFileSync(path.join(dir, 'cache', `${k}.json`), JSON.stringify(v));
    return await R.homonymPin(root, reference);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
/** The items of the "! HOMONYM CORRECTION" line, by section: { in: [...], out: [...], changed: [...] }; each item compared on its own. */
function items(log) {
  const line = log.split('\n').find((l) => l.includes('HOMONYM CORRECTION')) || '';
  const out = { in: [], out: [], changed: [] };
  for (const part of line.replace(/^.*?approved [^:]*: /, '').split(' · ')) {
    const m = /^(in|out|changed): (.*)$/.exec(part);
    if (m) out[m[1]].push(...m[2].split('; '));
  }
  return out;
}
const approvedHere = JSON.stringify(R.searchInputs(ROOT)) === JSON.stringify(require('../lib/search-links-approved.json').inputs);
const onApproved = { skip: approvedHere ? false : 'inputs differ from lib/search-links-approved.json (nightly caches): the scenarios assume the approved ones' };

test('Marco watches Manas (the RSS remembers its exact TMDB id): pin green, the log says it left the list', onApproved, async () => {
  const { approvedInputs, now } = await scenario(({ tmdb, friends }) => {
    tmdb.search['manas|2024'] = { t: Date.now(), v: 1256408, exact: true };
    friends.me.slugs.push('manas');
    friends.watchlist.items = friends.watchlist.items.filter(([slug]) => slug !== 'manas');
  });
  a.equal(approvedInputs, false);
  a(items(now.log).out.includes('Manas (2024) relinked to tt27911420'), now.log);
});

test('The Curse leaves Marco\'s watchlist: pin green, the log says its entry changed', onApproved, async () => {
  const { approvedInputs, now } = await scenario(({ friends }) => {
    friends.watchlist.items = friends.watchlist.items.filter(([slug]) => slug !== 'the-curse-2023');
  });
  a.equal(approvedInputs, false);
  a(items(now.log).changed.includes('The Curse (2023) pending (page names tt13623608) → pending (ambiguous)'), now.log);
});

test('the nightly lookup reads the one-day-2024 record on Marco\'s page: pin green, the log says One Day changed', onApproved, async () => {
  const { approvedInputs, now } = await scenario(({ friends }) => {
    a(friends.me.slugs.includes('one-day-2024') && !friends.films['one-day-2024'], 'fixture: the slug is on his page, the record is not cached');
    friends.films['one-day-2024'] = { title: 'One Day', year: 2024, imdbId: 'tt9999901', tmdbId: 999999901, t: Date.now(), v: 2 }; // planted ids
  });
  a.equal(approvedInputs, false);
  a(items(now.log).changed.includes('One Day (2024) pending (short-without-imdb) → pending (page names tt9999901)'), now.log);
});

// Positive control of the pin itself, on the approved inputs only (in a nightly build the inputs differ and this is skipped, never failed):
// a rule that accepts every search, and an approved list from before the TMDB cache update, must both turn the pin red.
async function mutated(file, from, to) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'homonym-control-'));
  try {
    const root = path.join(tmp, 'root');
    for (const n of fs.readdirSync(ROOT)) if (!SKIP.has(n)) fs.cpSync(path.join(ROOT, n), path.join(root, n), { recursive: true });
    const p = path.join(root, file), s = fs.readFileSync(p, 'utf8');
    a(s.includes(from), `control target missing in ${file}`);
    fs.writeFileSync(p, s.replace(from, to));
    return await R.homonymPin(root, REFERENCE).then(() => 'green', (e) => e);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
test('on the approved inputs the pin compares the list: accept-every-search and a stale approved list are both red', onApproved, async () => {
  const accept = await mutated('lib/search-link.js', '    if (entry?.exact) return { ok: true };', '    return { ok: true };');
  a(accept instanceof Error, 'a rule that accepts every search passed the pin');
  const stale = await mutated('lib/search-links-approved.json', '"tt4972582", 381288]', '"tt4972582", null]');
  a(stale instanceof Error, 'an approved list that leaves Split pending passed the pin');
});
