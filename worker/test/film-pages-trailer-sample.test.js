// The trailer gate of scripts/check-film-pages.mjs (trailerSample), on records made here: no build, no cache, no real film has to stay in the index for these to pass.
// The same gate runs on the real build in real-index.test.js ("FP export: one real build covers every indexed movie…"), which was red on 14/11/2026 because one of the 30 sample
// films (Mira, tt15296186) had left the index: see the comment over SAMPLE_MAX_WITHOUT in the script for why it left and what the gate asks now.

import test from "node:test";
import assert from "node:assert/strict";
import { SAMPLE, SAMPLE_MAX_WITHOUT, SAMPLE_MIN_PRESENT, trailerSample } from "../../scripts/check-film-pages.mjs";

/** The page records of the first `present` sample films, the first `withTrailer` of them with a trailer; `others` more films that are not in the sample, all with a trailer. */
function records(present, withTrailer, others = 5) {
  const m = new Map();
  SAMPLE.slice(0, present).forEach((tt, i) => m.set(tt, { t: tt, n: `Film ${i}`, ...(i < withTrailer ? { yt: "dQw4w9WgXcQ" } : {}) }));
  for (let i = 0; i < others; i++) m.set(`tt99000${i}`, { t: `tt99000${i}`, n: `Other ${i}`, yt: "dQw4w9WgXcQ" });
  return m;
}

test("the sample is 30 distinct IMDb ids, and the two numbers of the gate are the ones the script's comment explains", () => {
  assert.equal(SAMPLE.length, 30);
  assert.equal(new Set(SAMPLE).size, 30);
  for (const tt of SAMPLE) assert.match(tt, /^tt\d{7,8}$/);
  assert.equal(SAMPLE_MAX_WITHOUT, 8, "30 − 22: the spec's gate, said from the other side");
  assert.equal(SAMPLE_MIN_PRESENT, 24);
});

test("all 30 sample films in the index: the gate is the original one, at least 22 with a trailer", () => {
  assert.deepEqual(trailerSample(records(30, 22)), { samplePresent: 30, sampleWithTrailer: 22, sampleSize: 30, sampleAbsent: [] });
  assert.equal(trailerSample(records(30, 30)).sampleWithTrailer, 30);
  assert.throws(() => trailerSample(records(30, 21)), /trailer gate: 9 of the 30 sample films in the index have no trailer \(21 have one\), more than 8/);
});

test("a sample film that left the index does not fail the gate (14/11/2026: 29 present, 22 with a trailer), and the answer says which one left", () => {
  const got = trailerSample(records(29, 22));
  assert.deepEqual(got, { samplePresent: 29, sampleWithTrailer: 22, sampleSize: 30, sampleAbsent: [SAMPLE[29]] });
  // down to the minimum: 24 present, and the same 8 may lack a trailer
  assert.equal(trailerSample(records(24, 16)).sampleWithTrailer, 16);
  // a film WITH a trailer leaving never fails it either: the 8 without are the same 8
  const m = records(30, 22);
  for (const tt of SAMPLE.slice(0, 6)) m.delete(tt);
  assert.deepEqual([trailerSample(m).samplePresent, trailerSample(m).sampleWithTrailer], [24, 16]);
});

test("the trailer field gone from every page fails the gate, whichever sample films are in the index", () => {
  for (const present of [30, 29, 27, 24]) {
    const m = records(present, present);
    for (const r of m.values()) delete r.yt;
    assert.throws(() => trailerSample(m), new RegExp(`trailer gate: ${present} of the ${present} sample films in the index have no trailer \\(0 have one\\), more than 8`), `${present} present`);
  }
  // an empty trailer is no trailer
  const empty = records(30, 30);
  for (const r of empty.values()) r.yt = "";
  assert.throws(() => trailerSample(empty), /trailer gate: 30 of the 30/);
  // one more than the allowance, at any size
  assert.throws(() => trailerSample(records(29, 20)), /trailer gate: 9 of the 29/);
  assert.throws(() => trailerSample(records(24, 15)), /trailer gate: 9 of the 24/);
});

test("fewer than 24 of the 30 sample films in the index: the sample is too thin and has to be drawn again, even when every one left has a trailer", () => {
  assert.throws(() => trailerSample(records(23, 23)), /trailer sample too thin: 23 of its 30 films are in the index, fewer than 24; draw a new sample \(absent: /);
  assert.throws(() => trailerSample(records(0, 0)), /trailer sample too thin: 0 of its 30/);
  assert.throws(() => trailerSample(new Map()), /trailer sample too thin/);
});

test("gate: false only counts and never fails (what scanFilmPages({ trailerGate: false }) asks for)", () => {
  assert.deepEqual(trailerSample(records(3, 0), { gate: false }), { samplePresent: 3, sampleWithTrailer: 0, sampleSize: 30, sampleAbsent: SAMPLE.slice(3) });
});
