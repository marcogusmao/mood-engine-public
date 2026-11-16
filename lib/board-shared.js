// The few constants and helpers of the v2 Board that more than one module needs, in ONE place (no dependencies, so any module may require it).
//
//   ROW_ID / ROW_ID_SOURCE   the shape of a row or mood id that becomes part of a file name: data/index-v2-row-<id>.json, index-v2-mood-<id>.json.
//                            lib/board.js validates ids with it, verify.js checks the files with it and lib/learning/public.js builds its allowlist from it.
//   V2_ROW_MAX               the most films a v2 row file may hold (spec 13/10/2026 §F1: a row's file is read on every Stremio start).
//   SERIES_ROWS              the rows the Worker builds itself: a board entry with `series: true`, no films, no file.
//   legacyConfig(cfg)        the config the LEGACY family is built from: without `board`, and with only the moods of board.legacyMoods. Without a board it is cfg itself.
//   withRehearsalBoard(cfg, board)  cfg with a REHEARSAL board in place of its own (build.js --board <file>, the tests): since PR5 (14/10/2026) config.json carries the 21 moods of the v2 Board in
//                            "moods", and a rehearsal board that defines moods of its own (test/fixtures/board-v2-pr2.json, worker/test/fixtures/board-54.json) takes the place of the
//                            config's mood of the same id, so a fixture is still sound next to the production config.

const ROW_ID_SOURCE = "[a-z0-9]+(?:-[a-z0-9]+)*";
const ROW_ID = new RegExp(`^${ROW_ID_SOURCE}$`);
const V2_ROW_MAX = 100;
const SERIES_ROWS = ["my-series"];

/** cfg → the config that feeds the legacy plan, index, pool pins and ranking: the moods outside board.legacyMoods exist only in the v2 family (Marco, 13/10/2026). */
function legacyConfig(cfg) {
  if (!cfg.board) return cfg;
  const { board, ...rest } = cfg;
  return { ...rest, moods: (cfg.moods || []).filter((m) => board.legacyMoods.includes(m.id)) };
}

/** cfg with `board` in place of cfg.board: the moods the rehearsal board defines in board.moods replace the config's moods of the same id (they keep their place in the list's order after the nine). */
function withRehearsalBoard(cfg, board) {
  const own = new Set(((board && board.moods) || []).map((m) => m && m.id));
  return { ...cfg, board, moods: (cfg.moods || []).filter((m) => !own.has(m.id)) };
}

module.exports = { ROW_ID, ROW_ID_SOURCE, V2_ROW_MAX, SERIES_ROWS, legacyConfig, withRehearsalBoard };
