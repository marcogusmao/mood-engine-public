// node --test test/music-exempt-mood.test.js
// The mood named Music is EXEMPT from the music rule in its own option of the Moods menu (Marco, 22/10/2026 ~15:15 UTC, questionnaire "Music 1 of 4":
// "it is the only place where I ask for music when I open the app"). Everything else keeps the rule: the Board's row of the same mood, Tonight, the other moods,
// the cuts, Explore, the profiles. The Worker reads the exemption from the index (`rules.musicExemptMoods`, test/index-export.test.js and worker/test/music-exempt-mood.test.js).
// This file: the configuration (lib/pool.js musicOptions), the list the exempt mood's option shows (lib/rows.js buildRows `exempt` / `menu`) and where the plan puts it (lib/plan.js `menuRows`).
// test/music-all-rows-build.test.js builds the real caches and pins the whole surface list.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const P = require("../lib/pool");
const PEOPLE = require("../lib/people");
const { buildRows } = require("../lib/rows");
const { buildPlan } = require("../lib/plan");
const { compile } = require("../lib/moods");

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));

// ── the configuration ────────────────────────────────────────────────────────

test("musicOptions: `music.exemptMoods` is a list of ids of config.json moods; no key (or an empty list) exempts nothing, which is the rule of every night until 22/10/2026", () => {
  const ex = (cfg) => [...P.musicOptions({ lists: [], ...cfg }).exemptMoods];
  assert.deepEqual(ex({ music: { needsEvidence: true } }), []);
  assert.deepEqual(ex({ music: { needsEvidence: true, exemptMoods: [] } }), []);
  assert.deepEqual(ex({}), [], "no music block at all (a person's build)");
  assert.deepEqual(ex({ music: { needsEvidence: true, exemptMoods: ["music"] } }), ["music"], "no `moods` in the config to check against: the id is taken as written");
  assert.deepEqual(ex({ moods: [{ id: "music" }, { id: "noir" }], music: { needsEvidence: true, exemptMoods: ["music"] } }), ["music"]);
  assert.deepEqual(ex({ moods: [{ id: "music" }, { id: "noir" }], music: { needsEvidence: true, exemptMoods: ["music", "noir"] } }).sort(), ["music", "noir"]);
  assert.deepEqual(P.musicOptions(undefined).exemptMoods.size, 0);
});

test("musicOptions: a `music.exemptMoods` that is not a list of strings, or names a mood config.json does not have, stops the build (a typo must not quietly drop the exemption, nor a wrong shape quietly widen it)", () => {
  for (const v of ["music", true, 1, null, {}, [1], [null], [["music"]]]) assert.throws(() => P.musicOptions({ music: { needsEvidence: true, exemptMoods: v } }), /music\.exemptMoods must be a list of mood ids/, JSON.stringify(v));
  assert.throws(() => P.musicOptions({ moods: [{ id: "music" }], music: { needsEvidence: true, exemptMoods: ["musik"] } }), /music\.exemptMoods: "musik" is not a mood of config\.json/);
});

test("config.json: the exempt mood is Music, only Music, and it is a mood of config.json; a person's derived config (Will) exempts nothing", () => {
  assert.deepEqual(CONFIG.music.exemptMoods, ["music"]);
  const o = P.musicOptions(CONFIG);
  assert.deepEqual([...o.exemptMoods], ["music"]);
  assert.ok(CONFIG.moods.some((m) => m.id === "music" && m.word === "Music"), "the mood whose Moods-menu option is called Music");
  assert.equal(P.musicOptions(PEOPLE.deriveConfig(CONFIG, { id: "friend-a" })).exemptMoods.size, 0);
});

// ── the list of the exempt mood's option ─────────────────────────────────────

let n = 0;
/** A pool candidate. Film k has the IMDb id tt000000k; `genres` decide which mood it fits; `taste` its order. */
function cand(title, genres, taste, o = {}) {
  const id = ++n;
  const film = { id, imdb: `tt${String(id).padStart(7, "0")}`, title, year: 1990, runtime: 100, genres, keywords: [], directors: [{ id: 9000 + id, name: `Director ${id}` }], countries: ["US"], lang: "en", va: 7, vc: 3000, ...o };
  return { id, film, tasteZ: taste, qualityZ: 0, contributions: [], seeds: [], seedIds: new Set(), pins: [], recCount: 0 };
}
const SHOW = cand("Arena Tour", ["Music"], 9); //                      music film with no evidence: the music rule refuses it
const GIG = cand("Gig With Evidence", ["Music"], 8); //                music film the rule lets in
const POOR = cand("Music Under The Floor", ["Music"], 7); //           fails the QUALITY rule: no exemption brings it back
const BOTH = cand("Music And Comedy", ["Music", "Comedy"], 6); //      fits both moods, the rule lets it in
const FUN = cand("Plain Comedy", ["Comedy"], 5);
const POOL = [SHOW, GIG, POOR, BOTH, FUN];
const MOODS = compile([{ id: "music", name: "Turn it up", word: "Music", genres: { Music: 3 }, minFit: 2 }, { id: "fun", name: "Fun", word: "Fun", genres: { Comedy: 3 }, minFit: 2 }]);
const SIZES = { tonight: 10, row: 50, discover: 100, moodRepeatWindow: 30, because: 20, directors: 24, oldFriends: 24, watchlist: 100 };
const imdb = (xs) => xs.map((x) => x.id);
const tt = (c) => c.film.imdb;
const quality = (x) => x !== tt(POOR); //                     the quality rule alone
const recommendable = (x) => quality(x) && x !== tt(SHOW); //   the quality rule and the music rule
const run = (o = {}) => buildRows({ pool: POOL, rewatch: [], moods: MOODS, cfg: { sizes: SIZES, build: { directors: 15 } }, model: { stats: new Map() }, recentSeeds: [], today: "2026-10-22", eligible: recommendable, ...o });
const EXEMPT_MUSIC = { moods: new Set(["music"]), eligible: quality };

test("buildRows: the exempt mood's menu list holds the music film the rule refused; the quality rule still applies to it", () => {
  const { rows, menu } = run({ exempt: EXEMPT_MUSIC });
  assert.deepEqual(imdb(menu.music), [tt(SHOW), tt(GIG), tt(BOTH)], "taste order, the refused show included, the film under the quality floor not");
  assert.equal(menu.music[0].mood, "Turn it up", "the card says the mood's name, like the row");
  assert.deepEqual(imdb(rows.music), [tt(GIG), tt(BOTH)], "control: the Board's row of the same mood is what the rule makes it");
});

test("buildRows: only the exempt mood has a menu list; no exemption (absent, empty set) leaves `menu` empty", () => {
  assert.deepEqual(Object.keys(run({ exempt: EXEMPT_MUSIC }).menu), ["music"], "the other mood (fun) has none: its option shows its row");
  assert.deepEqual(run().menu, {});
  assert.deepEqual(run({ exempt: null }).menu, {});
  assert.deepEqual(run({ exempt: { moods: new Set(), eligible: quality } }).menu, {});
  assert.deepEqual(Object.keys(run({ exempt: { moods: new Set(["fun"]), eligible: quality } }).menu), ["fun"], "another mood is exempt only when it is named");
});

test("buildRows: the exemption lives in that one list: the rows, Tonight, `ranked` and every later mood row are the same as without it, repetition ceiling included", () => {
  const without = run(), withIt = run({ exempt: EXEMPT_MUSIC });
  assert.deepEqual(withIt.rows, without.rows);
  assert.deepEqual(withIt.ranked, without.ranked);
  // a film may be in at most two mood rows; the exempt list reads that count and must not add to it. T fits Music and Comedy: it is in the row of Music (1) and, right after it, in the row of the
  // Comedy mood m4 (2). If the exempt list spent a place of its own, T would already be at 2 when m4 asks and m4 would lose it.
  const T = cand("Both Moods", ["Music", "Comedy"], 20);
  const moods = compile([{ id: "music", name: "Turn it up", word: "Music", genres: { Music: 3 }, minFit: 2 }, { id: "m4", name: "Four", word: "Four", genres: { Comedy: 3 }, minFit: 2 }]);
  const base = { pool: [T], rewatch: [], moods, cfg: { sizes: SIZES, build: { directors: 15 } }, model: { stats: new Map() }, recentSeeds: [], today: "2026-10-22", eligible: () => true };
  const plain = buildRows(base), exempt = buildRows({ ...base, exempt: { moods: new Set(["music"]), eligible: () => true } });
  assert.deepEqual(imdb(plain.rows.m4), [tt(T)], "control: with no exemption m4 holds T");
  assert.deepEqual(imdb(exempt.rows.m4), [tt(T)], "the fourth mood sees the count the row left, not the list's");
  assert.deepEqual(imdb(exempt.menu.music), [tt(T)]);
});

test("buildRows: the exempt mood's menu list has the size of the other options (sizes.discover), not the Board row's (sizes.row)", () => {
  // review of 22/10/2026 (LOW 2): `.slice(0, cfg.sizes.row)` on the menu list (50 instead of 100) survived every test
  const many = Array.from({ length: 130 }, (_, i) => cand(`Music Film ${i}`, ["Music"], 200 - i));
  const sizes = { ...SIZES, row: 50, discover: 100 };
  const { rows, menu } = buildRows({ pool: many, rewatch: [], moods: MOODS, cfg: { sizes, build: { directors: 15 } }, model: { stats: new Map() }, recentSeeds: [], today: "2026-10-22", eligible: () => true, exempt: { moods: new Set(["music"]), eligible: () => true } });
  assert.equal(menu.music.length, sizes.discover);
  assert.equal(rows.music.length, sizes.discover, "control: the row of the mood is the same size");
  assert.deepEqual(imdb(menu.music), imdb(rows.music), "and with nothing refused they are the same list");
});

// ── where the plan puts it ───────────────────────────────────────────────────

test("buildPlan: the Discover Moods option of the exempt mood shows `menuRows`; the Board row of the same id, and every other option, show the rows", () => {
  const { rows, menu } = run({ exempt: EXEMPT_MUSIC });
  const plan = (menuRows) => buildPlan({ moods: MOODS, rows, extra: { fromlists: [], short: [], newforyou: [], "friends-week": [] }, sizes: SIZES, withFriends: false, menuRows });
  const opt = (p, word) => p.discover.find((c) => c.id === "mood-engine").options.find((o) => o.label === word).items.map((i) => i.id);
  const board = (p, id) => p.board.find((r) => r.id === id).items.map((i) => i.id);
  const withMenu = plan(menu);
  assert.deepEqual(opt(withMenu, "Music"), [tt(SHOW), tt(GIG), tt(BOTH)], "the option: the show is in it");
  assert.deepEqual(board(withMenu, "music"), [tt(GIG), tt(BOTH)], "the Board row of the same mood: the rule holds");
  assert.deepEqual(opt(withMenu, "Fun"), board(withMenu, "fun"), "an option with no menu list shows its row");
  const without = plan({});
  assert.deepEqual(opt(without, "Music"), [tt(GIG), tt(BOTH)], "no menu list (the default, a person's build): the option is its row, as before");
  assert.deepEqual(plan(undefined).discover, without.discover);
});
