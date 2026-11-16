// node --test            (no dependencies)
// The friends' view, the build's half (Marco, 29/10/2026, questionnaire: /u/<friend>/ shows what the FRIEND has seen and the FRIEND's watchlist; worker/src/friends.js is the Worker's half, worker/test/friend-view.test.js).
// What the build writes for it, on a synthetic index with the 7 friends of config.json, through the real buildIndex / encode / pieces2 / writeIndex / verifyIndex:
//   the two columns seenMask and wantMask of every row (bit i = friends.people[i], the order of config.json; a film two friends saw has two bits), derived from `friends` and checked back by decode
//   one watchlist piece per friend (data/index-v2-row-watchlist-<friend>.json): wanted, not seen by that friend, eligible, in the index's order, at most 100, written even when empty
//   an index built for a person (Will's) keeps its 27 columns and gets neither the masks nor the pieces
//   verify.js and the validator accept the pieces, even though one holds a film Marco has seen (it is the friend's list), and refuse each way a piece or a mask can be wrong

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildIndex, writeIndex, pieces2 } = require("../lib/index-export");
const { encode, decode, encodeFilm, decodeFilm, COLS, COLS_NO_MASKS } = require("../lib/index-rows");
const FV = require("../lib/friend-view");
const { verifyIndex } = require("../verify");
const { validateIndex } = require("../lib/index-validation");
const { V2_ROW_MAX } = require("../lib/board-shared");

const CONFIG = require("../config.json");
const PEOPLE = CONFIG.friends.map((f) => f.name || f.user); // William, friend-b, Gustavo, friend-d, friend-e, Francesca, friend-g
const [WILLIAM, friend-b, GUSTAVO, GOTH, LINEN, FRANCESCA, friend-g] = PEOPLE;
const tt = (n) => `tt${String(n).padStart(7, "0")}`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mood-friend-view-"));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

// 105 films wanted by Francesca (the row is cut at 100), and a handful with a known story
const MANY = Array.from({ length: 105 }, (_, i) => 100 + i);
const STORIES = {
  1: { seen: [WILLIAM, GUSTAVO] },                  // seen by two friends: two bits
  2: { want: [friend-b] },
  3: { seen: [friend-g], want: [WILLIAM] },          // Marco has seen it too (seenTts below)
  4: { want: [WILLIAM, FRANCESCA] },
  5: { seen: [WILLIAM], want: [WILLIAM] },          // on William's list and seen by him: out of his piece
  6: { want: [WILLIAM] },                           // not eligible: out of his piece
  7: {},                                            // nobody
};
for (const n of MANY) STORIES[n] = { want: [FRANCESCA] };
const MARCO_SEEN = new Set([tt(3)]);
const INELIGIBLE = new Set([tt(6)]);

/** The index of one small world: `people` friends, the stories above, a Board of Tonight and Watchlist (v2 when `v2`). */
function world({ people = PEOPLE, v2 = true, personId = null } = {}) {
  const ids = Object.keys(STORIES).map(Number);
  const films = Object.fromEntries(ids.map((n) => [`f${n}`, { slug: `f${n}`, imdbId: tt(n), title: `Film ${n}`, year: 2000 }]));
  const users = people.map((name) => ({
    user: name.toLowerCase(), name,
    films: new Map(ids.filter((n) => (STORIES[n].seen || []).includes(name)).map((n) => [`f${n}`, { slug: `f${n}`, rating: n % 2 ? 4 : null }])),
    watchlist: new Map(ids.filter((n) => (STORIES[n].want || []).includes(name)).map((n) => [`f${n}`, { slug: `f${n}` }])),
  }));
  const item = (n) => ({ id: tt(n), tmdb: null, slug: null, title: `Film ${n}`, year: 2000, why: ["row"], overview: "", genres: [], directors: [] });
  const mk = (place) => (id, name, list) => ({ id, name, ...(place ? { place } : {}), items: list.map(item) });
  // a film enters the index through a row of the Board: Marco has seen tt3 and tt6 is below the rule, so they sit in Old friends (the one row that may hold what Marco has seen or what the rule refuses); no row holds more than 100
  const board = (place) => [mk(place)("tonight", "Tonight", [1, 2, 4, 5, 7]), mk(place)("watchlist", "Your watchlist, newest first", [5]), mk(place)("oldfriends", "Worth watching again", [3, 6]), mk(place)("more-a", "More A", MANY.slice(0, 100)), mk(place)("more-b", "More B", MANY.slice(100))];
  const base = { cfg: { ...CONFIG, addon: { version: "2.0.0" }, moods: [], ...(personId ? { personContext: { personId, revision: "r-" + "1".repeat(32) } } : {}) }, today: "2026-10-29", builtAt: "2026-10-29T12:00:00.000Z", view: { films, users }, seenTts: MARCO_SEEN, quality: { eligible: (t) => !INELIGIBLE.has(t), minStars: 3.5 } };
  return {
    ix: buildIndex({ ...base, plan: { board: board(null), discover: [] } }),
    ix2: v2 ? buildIndex({ ...base, plan: { board: board("board"), discover: [] }, v2: { menu: [], countries: null } }) : null,
  };
}
const row = (ix, n) => encode(ix).films.find((r) => r[0] === tt(n));
const cell = (r, col) => r[COLS.indexOf(col)] ?? null;
const bits = (...names) => names.reduce((m, n) => m | (1 << PEOPLE.indexOf(n)), 0);

test("the 7 friends are the friends of config.json, in its order, and bit i of a mask is friends.people[i]", () => {
  const { ix2 } = world();
  assert.deepEqual(ix2.friends.people, PEOPLE);
  assert.deepEqual(PEOPLE, ["William", "friend-b", "Gustavo", "friend-d", "friend-e", "Francesca", "friend-g"]);
  assert.deepEqual(FV.slugsOf(PEOPLE), ["william", "friend-b", "gustavo", "friend-d", "friend-e", "francesca", "friend-g"]);
  assert.deepEqual(COLS.slice(-2), ["seenMask", "wantMask"]);
  assert.deepEqual(COLS_NO_MASKS, COLS.slice(0, -2));
});

test("the masks: a film two friends saw has two bits, the bits follow the order of the config, a want is not a seen, and a film nobody touched has neither (the cell is not even written)", () => {
  const { ix2 } = world();
  assert.equal(cell(row(ix2, 1), "seenMask"), bits(WILLIAM, GUSTAVO), "William (0) and Gustavo (2): 0b101");
  assert.equal(bits(WILLIAM, GUSTAVO), 0b101);
  assert.equal(cell(row(ix2, 1), "wantMask"), null);
  assert.equal(cell(row(ix2, 2), "wantMask"), bits(friend-b), "friend-b is person 1");
  assert.equal(cell(row(ix2, 2), "seenMask"), null);
  assert.equal(cell(row(ix2, 3), "seenMask"), bits(friend-g), "friend-g is the seventh: bit 6");
  assert.equal(cell(row(ix2, 3), "wantMask"), bits(WILLIAM));
  assert.equal(cell(row(ix2, 4), "wantMask"), bits(WILLIAM, FRANCESCA));
  assert.equal(cell(row(ix2, 5), "seenMask"), bits(WILLIAM));
  assert.equal(cell(row(ix2, 5), "wantMask"), bits(WILLIAM));
  assert.equal(row(ix2, 7).length <= COLS.indexOf("seenMask"), true, "no friend: the trailing nulls are cut, both cells are gone");
  // every person, every film: bit i is set exactly when people[i] is in the film's friends
  for (const e of ix2.films) {
    const r = encode(ix2).films.find((x) => x[0] === e.tt);
    PEOPLE.forEach((name, i) => {
      assert.equal(((cell(r, "seenMask") >> i) & 1) === 1, !!e.friends && e.friends.seenBy.some(([n]) => n === name), `${e.tt} seen by ${name}`);
      assert.equal(((cell(r, "wantMask") >> i) & 1) === 1, !!e.friends && e.friends.wantBy.includes(name), `${e.tt} wanted by ${name}`);
    });
  }
});

test("the masks are in every file of both families, derived from `friends` (the object form carries none), and decode(encode(x)) is x", () => {
  const { ix, ix2 } = world();
  assert.ok(ix2.films.every((e) => !("seenMask" in e) && !("wantMask" in e)), "the object form has no mask: they are columns of the file");
  for (const obj of [ix, ix2, ...pieces2(ix2).map((p) => p.obj)]) {
    const file = encode(obj);
    assert.deepEqual(file.cols, COLS);
    assert.deepEqual(decode(JSON.parse(JSON.stringify(file))), obj);
  }
});

test("a file whose masks disagree with its friends, or with one cell too many, is refused when read — the masks cannot drift from the friends", () => {
  const { ix2 } = world();
  const file = JSON.parse(JSON.stringify(encode(ix2)));
  const at = file.films.findIndex((r) => r[0] === tt(1));
  const bad = (mut, re) => { const f = JSON.parse(JSON.stringify(file)); mut(f); assert.throws(() => decode(f), re); };
  bad((f) => { f.films[at][COLS.indexOf("seenMask")] = bits(WILLIAM); }, /has seenMask 1 but its friends say 5/);
  bad((f) => { f.films[at][COLS.indexOf("wantMask")] = 4; }, /has wantMask 4 but its friends say null/);
  bad((f) => { f.films[at][COLS.indexOf("seenMask")] = null; }, /has seenMask null but its friends say 5/);
  bad((f) => { f.films[at].length = COLS_NO_MASKS.length; }, /has seenMask undefined but its friends say 5/);
  bad((f) => { f.films.find((r) => r[0] === tt(2)).length = COLS.indexOf("wantMask"); }, /has wantMask undefined but its friends say 2/);
  bad((f) => { f.cols = COLS_NO_MASKS; }, /has \d+ cells, the file has 27 columns/);
  assert.throws(() => encodeFilm({ tt: tt(1), name: "X", friends: { seenBy: [["Stranger", 4]], wantBy: [] } }, PEOPLE), /not in friends\.people/);
  assert.throws(() => encodeFilm({ tt: tt(1), name: "X", friends: { seenBy: [["p31", 4]], wantBy: [] } }, [...Array.from({ length: 31 }, (_, i) => `p${i}`), "p31"]), /a mask holds 31 people/);
});

test("an index built for a person (Will's) keeps the 27 columns it always had: no masks, no pieces, and the rows are the old rows byte for byte", () => {
  const { ix, ix2 } = world({ personId: "friend-a" });
  assert.equal(ix2.meta.personId, "friend-a");
  const file = encode(ix2);
  assert.deepEqual(file.cols, COLS_NO_MASKS);
  assert.ok(file.films.every((r) => r.length <= COLS_NO_MASKS.length));
  assert.equal(JSON.stringify(file.films), JSON.stringify(ix2.films.map((e) => encodeFilm(e, PEOPLE, { masks: false }))));
  assert.deepEqual(decode(JSON.parse(JSON.stringify(file))), ix2);
  assert.deepEqual(pieces2(ix2).filter((p) => p.part.startsWith("v2-row:watchlist-")), []);
  assert.ok(pieces2(ix2).some((p) => p.part === "v2-row:watchlist"), "…while his own watchlist row is a row like any other");
  assert.deepEqual(encode(ix).cols, COLS_NO_MASKS);
});

test("pieces2: one watchlist piece per friend, in the config's order, each exactly its row — wanted, not seen by that friend, eligible, the order of the index, at most 100 — empty ones written too", () => {
  const world2 = world().ix2;
  const ix2 = { ...world2, films: world2.films.map((e) => ({ ...e, desc: `Text of ${e.name}` })) };
  const mine = pieces2(ix2).filter((p) => p.part.startsWith("v2-row:watchlist-"));
  assert.deepEqual(mine.map((p) => p.part), FV.slugsOf(PEOPLE).map((s) => `v2-row:watchlist-${s}`));
  assert.deepEqual(mine.map((p) => p.rel), FV.slugsOf(PEOPLE).map((s) => path.join("data", `index-v2-row-watchlist-${s}.json`)));
  const rows = Object.fromEntries(mine.map((p) => [p.part.slice("v2-row:watchlist-".length), p.obj.rows.watchlist]));
  assert.deepEqual(rows.william, [tt(3), tt(4)], "5 he saw, 6 is not eligible; 3 is a film Marco has seen and it stays");
  assert.deepEqual(rows.friend-b, [tt(2)]);
  for (const s of ["gustavo", "friend-d", "friend-e", "friend-g"]) assert.deepEqual(rows[s], [], `${s}: an empty piece is an answer`);
  assert.equal(rows.francesca.length, V2_ROW_MAX, "105 wanted, 100 kept");
  assert.deepEqual(rows.francesca, [tt(4), ...MANY.slice(0, 99).map(tt)], "the order of the index: tt0000004 first, then the 99 first of the others");
  for (const p of mine) {
    const o = p.obj, ids = o.rows.watchlist;
    assert.deepEqual(o.films.map((e) => e.tt), ids, "exactly its films, in the row's order");
    assert.deepEqual(o.board, [ix2.board.find((r) => r.id === "watchlist")]);
    assert.deepEqual(Object.keys(o.rowDesc), ["watchlist"]);
    assert.equal(o.rowDesc.watchlist.length, ids.length);
    assert.ok(o.rowDesc.watchlist.every((t) => typeof t === "string"));
    assert.deepEqual(o.rowDesc.watchlist, o.films.map((e) => `Text of ${e.name}`), "the row's text is the film's general text (the index does not hold the friend's reasons)");
    assert.equal(o.meta.count, ids.length);
    assert.equal(o.meta.part, p.part);
    assert.deepEqual(o.friends.people, PEOPLE, "the people, in the order the masks use");
  }
  assert.deepEqual(ix2.rows.watchlist, [tt(5)], "Marco's own row is not touched");
});

test("pieces2: no Watchlist row on the Board, no friend pieces; names that cannot be addresses stop the build", () => {
  const { ix2 } = world();
  const noRow = { ...ix2, board: ix2.board.filter((r) => r.id !== "watchlist") };
  assert.deepEqual(pieces2(noRow).filter((p) => p.part.startsWith("v2-row:watchlist-")), []);
  const dup = { ...ix2, friends: { ...ix2.friends, people: ["Ana", "ANA"] } };
  assert.throws(() => pieces2(dup), /"ANA" and "Ana" give the same address "ana"/);
  assert.throws(() => pieces2({ ...ix2, friends: { ...ix2.friends, people: ["Ana Maria"] } }), /not lower case letters and digits/);
  assert.throws(() => pieces2({ ...ix2, friends: { ...ix2.friends, people: ["Will" + "Cloak"] } }), /Will's/);
});

test("on disk: writeIndex writes the 7 pieces next to the rows, verify.js accepts them — a film Marco has seen in a friend's list included — and names each way a piece or a mask can be wrong", () => {
  const out = tmp();
  try {
    const { ix, ix2 } = world();
    const w = writeIndex(out, ix, ix2);
    require("../test-support/film-page-fixture").writeMinimalPages(out, ix2);
    const files = fs.readdirSync(path.join(out, "data")).filter((n) => n.startsWith("index-v2-row-watchlist-")).sort();
    assert.deepEqual(files, FV.slugsOf(PEOPLE).map((s) => `index-v2-row-watchlist-${s}.json`).sort());
    assert.equal(w.v2.files, pieces2(ix2).length, "counted with the others");
    const ok = verifyIndex(out);
    assert.equal(ok.ok, true, ok.problems.join("\n"));
    const william = JSON.parse(fs.readFileSync(path.join(out, "data", "index-v2-row-watchlist-william.json"), "utf8"));
    assert.deepEqual(william.rows.watchlist, [tt(3), tt(4)]);
    assert.ok(decode(william).films.find((e) => e.tt === tt(3)).seen, "tt0000003 is a film Marco has seen, and it sits in William's row");
    assert.doesNotThrow(() => validateIndex(ix2));

    const edit = (name, fn) => {
      const file = path.join(out, "data", name), before = fs.readFileSync(file, "utf8"), j = JSON.parse(before);
      fn(j);
      fs.writeFileSync(file, JSON.stringify(j));
      try { return verifyIndex(out).problems.join("\n"); } finally { fs.writeFileSync(file, before); }
    };
    const whole = JSON.parse(fs.readFileSync(path.join(out, "data", "index-v2.json"), "utf8"));
    const rowOf = (n) => whole.films.find((r) => r[0] === tt(n));
    // a film the friend has seen, or one the rule refuses, or one he does not want, slipped into his piece; one missing from it
    assert.match(edit("index-v2-row-watchlist-william.json", (j) => { j.films.push(rowOf(5)); j.rows.watchlist.push(tt(5)); j.rowDesc.watchlist.push("x"); j.meta.count++; }), /index-v2-row-watchlist-william: 1 film\(s\) it should not hold \(Film 5\)/);
    assert.match(edit("index-v2-row-watchlist-william.json", (j) => { j.films.push(rowOf(6)); j.rows.watchlist.push(tt(6)); j.rowDesc.watchlist.push("x"); j.meta.count++; }), /index-v2-row-watchlist-william: 1 film\(s\) it should not hold \(Film 6\)/);
    assert.match(edit("index-v2-row-watchlist-william.json", (j) => { j.films.pop(); j.rows.watchlist.pop(); j.rowDesc.watchlist.pop(); j.meta.count--; }), /index-v2-row-watchlist-william: 1 film\(s\) it should hold are missing/);
    // the right films in the wrong order, and another friend's list under his name
    assert.match(edit("index-v2-row-watchlist-william.json", (j) => { j.films.reverse(); j.rows.watchlist.reverse(); j.rowDesc.watchlist.reverse(); }), /index-v2-row-watchlist-william: rows or rowDesc are not that friend's watchlist/);
    const nardo = fs.readFileSync(path.join(out, "data", "index-v2-row-watchlist-friend-b.json"), "utf8");
    assert.match(edit("index-v2-row-watchlist-william.json", (j) => { Object.assign(j, JSON.parse(nardo)); }), /index-v2-row-watchlist-william: meta.part is v2-row:watchlist-friend-b|not that friend's watchlist/);
    // Marco's own row is a row of the Board and keeps the rule: a film he has seen in it is still refused
    assert.match(edit("index-v2-row-watchlist.json", (j) => { j.films.push(rowOf(3)); j.rows.watchlist.push(tt(3)); j.rowDesc.watchlist.push("x"); j.meta.count++; }), /tt0000003 \(Film 3\) is marked seen and sits in row watchlist|should not hold/);
    // a mask that is not what the friends say
    assert.match(edit("index-v2.json", (j) => { j.films.find((r) => r[0] === tt(1))[COLS.indexOf("seenMask")] = 1; }), /index-v2: the rows cannot be read: index: tt0000001 has seenMask 1 but its friends say 5/);
    // a piece the index does not account for, and one friend's missing
    fs.writeFileSync(path.join(out, "data", "index-v2-row-watchlist-ghost.json"), "{}");
    assert.match(verifyIndex(out).problems.join("\n"), /data\/index-v2-row-watchlist-ghost\.json is a v2 file the index does not account for/);
    fs.rmSync(path.join(out, "data", "index-v2-row-watchlist-ghost.json"));
    const jf = path.join(out, "data", "index-v2-row-watchlist-friend-g.json"), keep = fs.readFileSync(jf);
    fs.rmSync(jf);
    assert.match(verifyIndex(out).problems.join("\n"), /index-v2-row-watchlist-friend-g/);
    fs.writeFileSync(jf, keep);
    assert.equal(verifyIndex(out).ok, true);
  } finally { rm(out); }
});
