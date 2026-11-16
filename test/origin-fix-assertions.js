const assert = require("node:assert/strict");

function historical(DR) {
  assert.equal(DR.codeOf({ label: "Czechoslovakia", iso: "CS" }), "XC");
  assert.equal(DR.codeOf({ label: "Serbia and Montenegro", iso: "CS" }), "RS");
  assert.equal(DR.codeOf({ label: "East Germany", iso: "DD" }), "XG");
  assert.equal(DR.codeOf({ label: "Mexico", iso: "mx" }), "MX");
  for (const label of ["__proto__", "constructor", "toString"]) {
    assert.equal(DR.codeOf({ label }), null, label);
    assert.equal(DR.codeOf({ label, iso: "MX" }), "MX");
  }
}

async function emptyAnswers(DR) {
  const now = 1000;
  const labels = ["__proto__", "constructor", "toString"];
  const answers = Object.fromEntries(labels.map((label, i) => [String(i + 1), { cit: [{ label }] }]));
  const bindings = labels.map((label, i) => ({ tmdb: { value: String(i + 1) }, country: { value: "Q1" }, countryLabel: { value: label } }));
  const caches = [{}, {}];
  DR.backfill(caches[0], answers, now);
  await DR.refresh(caches[1], Object.keys(answers), {
    now, sleepImpl: async () => {},
    fetchImpl: async () => ({ ok: true, status: 200, body: null, text: async () => JSON.stringify({ results: { bindings } }) }),
  });
  for (const original of caches) {
    const cache = JSON.parse(JSON.stringify(original));
    for (const id of Object.keys(answers)) assert.deepEqual(cache[id], { cit: [], t: now });
    assert.deepEqual(DR.toAsk(cache, Object.keys(answers), now + DR.REASK_EMPTY_MS - 1), []);
    assert.deepEqual(DR.toAsk(cache, Object.keys(answers), now + DR.REASK_EMPTY_MS), Object.keys(answers));
  }
}

function frozenBackfill(DR, C) {
  const cache = { 3556: { cit: ["PL", "FR"], t: 5 }, 1: { cit: ["MX"], t: 7 } };
  const bytes = JSON.stringify(cache);
  for (const cit of [[{ iso: "FR" }, { iso: "PL" }], [{ iso: "ES" }], []]) {
    const n = DR.backfill(cache, { 3556: { cit }, 1: { cit: [{ iso: "ES" }] } }, 999);
    assert.equal(n.changed, 0);
    assert.equal(n.unchanged, 2);
    assert.equal(JSON.stringify(cache), bytes, "nonempty entries keep their order, date and bytes");
    assert.equal(C.mainCountry({ countries: ["FR", "DE", "PL", "GB"], lang: "en", origin: ["GB", "FR", "DE"], directors: [{ id: 3556 }] }, undefined, undefined, DR.citizenshipMap(cache)), "PL", "The Pianist stays Poland"); // the record's three origins: with ONE, an English film takes it (Marco, 14/11/2026)
  }
  DR.backfill(cache, { 2: { cit: [] } }, 10);
  DR.backfill(cache, { 2: { cit: [] } }, 20);
  assert.deepEqual(cache[2], { cit: [], t: 10 });
  DR.backfill(cache, { 2: { cit: [{ iso: "JP" }] } }, 30);
  assert.deepEqual(cache[2], { cit: ["JP"], t: 30 });
}

module.exports = { historical, emptyAnswers, frozenBackfill };
