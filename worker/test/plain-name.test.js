import test from 'node:test';
import assert from 'node:assert/strict';
import { sameName } from '../src/meta.js';
import { plain } from '../src/mood-group.js';

let instance = 0;
const fresh = async () => (await import(`../src/plain-name.js?test=${++instance}`)).plainName;
const original = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function countLower(fn) {
  const lower = String.prototype.toLowerCase;
  let calls = 0;
  String.prototype.toLowerCase = function () { calls++; return lower.call(this); };
  try { fn(); return calls; } finally { String.prototype.toLowerCase = lower; }
}

test('name normalization keeps Unicode, punctuation, spacing and long strings exactly as before, on misses and hits', async () => {
  const normalize = await fresh();
  const values = ['', '!!!', '🌃 Night drive', 'São Paulo', 'Amélie', 'İSTANBUL', 'Straße',
    '東京物語', '𐐀 𐐨', 'e\u0301', 'ＡＢＣ１２３', '8½', '  Noir—COMEDY\t\n', '\ud800',
    'class', 'classes', 'Documentaries', 'Science Fictions', 'İ'.repeat(256), 'LONG!'.repeat(300)];
  for (const value of values) {
    const expected = original(value);
    assert.equal(normalize(value), expected);
    assert.equal(normalize(value), expected);
  }
});

test('repeated names, including an empty normalized value, run the transformation once', async () => {
  const normalize = await fresh();
  assert.equal(countLower(() => {
    for (let i = 0; i < 100; i++) assert.equal(normalize('🌃 Noir'), 'noir');
    for (let i = 0; i < 100; i++) assert.equal(normalize('!!!'), '');
  }), 2);
});

test('the cache retains at most 512 names and admits new names after eviction', async () => {
  const normalize = await fresh();
  assert.equal(countLower(() => {
    for (let i = 0; i < 512; i++) normalize(`Name ${i}`);
  }), 512);
  assert.equal(countLower(() => normalize('Name 0')), 0);
  assert.equal(countLower(() => normalize('Name 512')), 1);
  assert.equal(countLower(() => normalize('Name 0')), 1, 'oldest name was evicted');
  assert.equal(countLower(() => normalize('Name 512')), 0, 'new name is retained');
});

test('both input and output are limited to 256 code units; larger names remain correct and are never retained', async () => {
  const normalize = await fresh();
  const boundary = 'A'.repeat(256);
  assert.equal(countLower(() => { normalize(boundary); normalize(boundary); }), 1);
  for (const value of ['A'.repeat(257), '!'.repeat(257), 'İ'.repeat(256)]) {
    const expected = original(value);
    assert.equal(countLower(() => { assert.equal(normalize(value), expected); assert.equal(normalize(value), expected); }), 2);
  }
  assert.equal(countLower(() => normalize(boundary)), 0, 'oversized input does not clear the short names');
});

test('both callers reuse the same string result while keeping their different null coercion', () => {
  const unique = 'CacheSpec shared name';
  assert.equal(countLower(() => { assert.equal(sameName(unique, unique), true); assert.equal(plain(unique), 'cachespec shared name'); }), 1);
  assert.equal(sameName(null, ''), true);
  assert.equal(sameName(undefined, ''), true);
  assert.equal(sameName(null, 'null'), false);
  assert.equal(plain(null), 'null');
  assert.equal(plain(undefined), 'undefined');
  for (const value of [0, false, NaN, 42n, Symbol('Noir')]) assert.equal(plain(value), original(String(value)));
});

test('objects are converted on every call, even when their earlier string was cached; conversion errors still propagate', () => {
  let calls = 0;
  const changing = { toString() { return ++calls === 1 ? 'FIRST' : 'SECOND'; } };
  assert.equal(plain(changing), 'first');
  assert.equal(plain(changing), 'second');
  assert.equal(calls, 2);
  assert.equal(sameName({ toString: () => 'COMEDIES' }, 'Comedy'), true);
  const failure = new Error('conversion failed');
  const bad = { toString() { throw failure; } };
  assert.throws(() => plain(bad), e => e === failure);
  assert.throws(() => sameName(bad, ''), e => e === failure);
});


test('4096 distinct inputs never retain more than 512 entries; separate instances do not share state', async () => {
  const first = await fresh(), second = await fresh();
  const set = Map.prototype.set;
  let largest = 0;
  Map.prototype.set = function (key, value) {
    const result = set.call(this, key, value);
    largest = Math.max(largest, this.size);
    return result;
  };
  try {
    for (let i = 0; i < 4096; i++) assert.equal(first(`Distinct ${i}`), `distinct ${i}`);
  } finally { Map.prototype.set = set; }
  assert.equal(largest, 512);
  assert.equal(countLower(() => first('Distinct 4095')), 0);
  assert.equal(countLower(() => second('Distinct 4095')), 1);
});
