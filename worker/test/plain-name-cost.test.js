import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { toMeta } from '../src/meta.js';
import { makeObject, readyOf } from './fixture.js';

// node:test runs this file in a fresh process: the module cache starts empty.
test('a complete catalog card computes each repeated name once, then reuses it without changing its body', () => {
  const o = makeObject();
  o.moodMenu = [{ id: 'night', label: 'Nocturnal' }, { id: 'lift', label: 'Uplift' }];
  o.films = o.films.map(f => f.tt === 'tt0000001' ? { ...f,
    genres: ['Crime', 'Thriller'], moods: { lift: [0.9, 9], night: [1.2, 3] },
    desc: 'Sterling Hayden; Coleen Gray\nMood: 🌃 Night drive · Crime, Thriller · Heist, Caper, Noir, Extra.\n\nA synopsis of The Killing.' } : f);
  const ix = readyOf(o), e = ix.films.find(f => f.tt === 'tt0000001');
  const replace = String.prototype.replace;
  let count = 0;
  String.prototype.replace = function (pattern, value) {
    if (pattern instanceof RegExp && pattern.source === String.raw`[^\p{L}\p{N}]+` && pattern.flags === 'gu') count++;
    return replace.call(this, pattern, value);
  };
  let first, second, firstCount, secondCount;
  try {
    first = toMeta(e, { menus: ix, separator: '\n\n' }); firstCount = count;
    count = 0;
    second = toMeta(e, { menus: ix, separator: '\n\n' }); secondCount = count;
  } finally { String.prototype.replace = replace; }
  assert.equal(firstCount, 9, 'base performed 40 transforms for these nine names');
  assert.equal(secondCount, 0, 'base performed another 38 transforms');
  assert.deepEqual(second, first);
  // 14/11/2026: the card also carries `background` (Marco, the Samsung TV; test/card-background.test.js). The digest stays the one of the body this test pinned: the key is taken out
  // after it is checked to be exactly the film page's address for this film, so every other byte of the card is still the body of before.
  const { background, ...before } = first;
  assert.equal(background, 'https://images.metahub.space/background/medium/tt0000001/img');
  assert.deepEqual(Object.keys(first).slice(0, 6), ['id', 'type', 'name', 'poster', 'posterShape', 'background']);
  assert.equal(createHash('sha256').update(JSON.stringify(before)).digest('hex'), 'b2e56708fab26317d241fd9b6385d3ee5e15e756bf5f5cc9ba09165437c0c344');
});
