// node --test
// The learning smoke (scripts/learning.js smoke) runs in CI here, so a stale Board count or mood count fails the suite instead of
// waiting for someone to run it by hand (review 11/10/2026: it expected 19 rows and "Eight moods" while the build published 20 and nine).

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const { expectedBoard } = require("../scripts/learning");
const P = require("../lib/plan");
const S = require("../lib/learning/schema");
const { legacyConfig } = require("../lib/board-shared");
const cfg = legacyConfig(require("../config.json")); // Marco, 14/10/2026 (PR5): config.json "moods" holds the 21 moods of the v2 Board too; the legacy Board, the picker and the learning schema count the nine of board.legacyMoods

test("the smoke's Board count is derived from lib/plan.js and config.json (7 before the moods, the moods, 4 after)", () => {
  assert.equal(expectedBoard(ROOT), P.BOARD_BEFORE_MOODS.length + cfg.moods.length + P.BOARD_AFTER_MOODS.length);
  assert.equal(expectedBoard(ROOT), 20);
  assert.equal(cfg.moods.length, S.MOODS.length);
});

test("node scripts/learning.js smoke --date 2026-10-10 passes: two offline builds, the replays, the guard", { timeout: 600000 }, () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "learning.js"), "smoke", "--date", "2026-10-10"], { cwd: ROOT, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `smoke failed: ${r.stderr.slice(0, 2000)}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "pass");
  assert.equal(out.board, expectedBoard(ROOT));
  assert.equal(out.moods, S.MOODS.length);
  assert.equal(out.zeroNetwork, true);
});
