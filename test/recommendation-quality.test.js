const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../lib/recommendation-quality');
const selector = require('../web/selector');

const view = () => ({ films: {
  general: { imdbId: 'tt1', r: 3.5 },
  friend: { imdbId: 'tt2', r: 3.1 },
  low: { imdbId: 'tt3', r: 3.49 },
  unknown: { imdbId: 'tt4', r: null },
  unresolved: { imdbId: null, r: 5 },
  alias: { imdbId: 'tt2', r: 3.0 },
}, users: [{ user: 'fixture', name: 'Synthetic friend', films: new Map([
  ['friend', { rating: 3.5 }], ['low', { rating: 3 }], ['unknown', { rating: null }],
  ['unresolved', { rating: 5 }],
]) }] });

test('3.5 boundary or friend exception; no rounding, TMDB, watchlist or unknown substitute', () => {
  const ratings = Q.index(view());
  assert(Q.qualifies(ratings.get('tt1')));
  assert(Q.qualifies(ratings.get('tt2')));
  assert.match(Q.reason(ratings.get('tt2')), /Synthetic friend rated it 3.5/);
  for (const id of ['tt3', 'tt4', 'tt99']) assert(!Q.qualifies(ratings.get(id)));
  for (const value of [3.49, NaN, Infinity, 5.1, '3.5', null]) assert(!Q.qualifies({ lb: value, va: 10, rating: 5, w: 1 }));
  assert(Q.qualifies({ lb: null, fr: 3.5 }));
  assert.equal(ratings.get('tt2').lb, 3);
});

test('all generated Board/cut recommendations obey the floor; curator order and content survive', () => {
  const items = [3, 2, 1, 4].map(id => ({ id: 'tt' + id, why: [] }));
  const plan = { board: ['tonight', 'lift', 'watchlist', 'oldfriends', 'friends-love'].map(id => ({ id, items: items.slice() })), discover: [
    { id: 'mood-engine-runtime', options: [{ items: items.slice() }] },
    ...['mood-engine-lists', 'mood-engine-lists-unseen', 'mood-engine-friends'].map(id => ({ id, options: [{ items: items.slice() }] })),
  ] };
  const editorialBefore = structuredClone(plan.discover.slice(1));
  Q.applyPlan(plan, Q.index(view()));
  for (const row of plan.board) assert.deepEqual(row.items.map(item => item.id), ['tt2', 'tt1']);
  assert.deepEqual(plan.discover[0].options[0].items.map(item => item.id), ['tt2', 'tt1']);
  assert.deepEqual(plan.discover.slice(1), editorialBefore);
});

test('Wildcard at every dial/roll refuses low, unknown and TMDB-only data; friend 3.5 passes', () => {
  const make = n => ({ i: 'tt' + n, t: n, n: 'Synthetic', f: { lift: 1 }, vc: 100, va: 10, ts: 0, q: 0, r: 90, rating: 4, last: '2024-01-01', why: [] });
  const data = { today: '2026-10-10', tonight: [1, 2, 3, 4], films: [1, 2, 3, 4].map(make), rewatch: [1, 2, 3, 4].map(make) };
  Q.applyWeb(data, Q.index(view()));
  assert.deepEqual(data.tonight, [1, 2]);
  // Include unqualified records to exercise the selector itself, not only the build filter.
  data.films.push({ ...make(3), lb: 3.49, fr: 3 }, make(4));
  data.rewatch.push({ ...make(3), lb: 3.49, fr: 3, rating: 5 }, make(4));
  for (const safe of [0, .3, 1]) for (const roll of [0, 1, 20]) for (const kind of ['new', 'rewatch']) {
    const picks = selector.rank(data, { mood: 'lift', time: 0, kind, safe, roll });
    assert.deepEqual(picks.map(pick => pick.x.i).sort(), ['tt1', 'tt2']);
  }
});

// Exercise the config boundary: an unconfigured cached user cannot grant the exception.
test('only configured friends grant the exception; missing community rating can qualify', () => {
  const F = require('../lib/friends');
  const cache = { films: { lower: { imdbId: 'tt50', r: 3 }, missing: { imdbId: 'tt51', r: null } }, users: {
    configured: { films: [['lower', 'Synthetic lower', 2000, 3.5], ['missing', 'Synthetic missing', 2000, 4]] },
    outsider: { films: [['lower', 'Synthetic lower', 2000, 5]] },
  }, lists: {} };
  assert(!Q.qualifies(Q.index(F.viewFriends(cache, {friends: []})).get('tt50')));
  const ratings = Q.index(F.viewFriends(cache, {friends: [{user: 'configured', name: 'Fixture friend'}]}));
  assert.equal(ratings.get('tt50').fr, 3.5);
  assert(Q.qualifies(ratings.get('tt50')));
  assert(Q.qualifies(ratings.get('tt51')));
});

// Marco, 28/10/2026 (answer (b) of question 4 of the Discover proposal 5): friend-b, friend-g and Francesca are WHOLE friends, so the "one configured friend at 3.5★" leg of the floor reads them too.
// Written against: the plan's estimate for the answer (a) that nothing changes (docs/2026-10-28-discover-plano-implementacao.md §5.4: "a friend-b's 3.5 does not unlock a film"); under (b) it does. The test says what the
// code DOES with config.json as it is: a film with a 3.0 average and a 3.5★ from friend-b alone passes, and says so in the reason line; with the four old friends it does not.
test('config.json friends: a film only friend-b rated 3.5 is recommendable now, and was not with the four friends of before 28/10/2026', () => {
  const F = require('../lib/friends');
  const cfg = require('../config.json');
  const cache = { films: { solo: { imdbId: 'tt60', r: 3 }, nobody: { imdbId: 'tt61', r: 3 }, low: { imdbId: 'tt62', r: 3 } }, users: {
    friend-b: { films: [['solo', 'Synthetic solo', 2000, 3.5], ['low', 'Synthetic low', 2000, 3.0]] },
    friend-a: { films: [['nobody', 'Synthetic nobody', 2000, 3.0]] },
  }, lists: {} };
  const OLD = ['friend-a', 'friend-e', 'friend-d', 'friend-c'];
  const before = Q.index(F.viewFriends(cache, { friends: cfg.friends.filter((f) => OLD.includes(f.user)) }));
  assert(!Q.qualifies(before.get('tt60')), 'the four friends of before: friend-b is nobody to the floor');
  const now = Q.index(F.viewFriends(cache, { friends: cfg.friends }));
  assert(Q.qualifies(now.get('tt60')), 'the seven: her 3.5 opens the film');
  assert.match(Q.reason(now.get('tt60')), /friend-b rated it 3\.5★ on Letterboxd/);
  assert(!Q.qualifies(now.get('tt62')), 'control: a 3.0 from her opens nothing (the bar is 3.5)');
  assert(!Q.qualifies(now.get('tt61')), 'control: nor does a 3.0 from William');
});
