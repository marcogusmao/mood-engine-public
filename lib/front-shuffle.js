// The front shuffle of the v2 Board (Marco, 14/10/2026): design C of the spec .context/pesquisa/2026-10-14-shuffle-inteligente-spec.md of the Stremio repository.
//
// A Board row is ordered best first and that order is the same every day, so the same few classics stand in the first screen of many rows at once, day after day.
// "The front" is the first `front` films of a row (8: one TV screen). Each day every shuffled row draws its order again, three rules deep:
//
//   1. a draw weighted by position      key = -pos/tau + G - (penalty/tau) * E, sorted descending. G is Gumbel(0,1), one number per (date, row, film) from seeded(): a film's noise does not
//                                       depend on the other films of the row, so taking one out of a row leaves the order of the rest as it was. -pos/tau makes the film `tau` places
//                                       lower 1/e as likely to come first (Plackett-Luce by Gumbel top-k): the top stays the favourite and is not fixed.
//   2. a cap across rows                the rows are walked in the Board's order; a film may be in the front of at most `maxFronts` rows and may open (stand first in) at most `maxLeads`.
//                                       A film over the cap is demoted, not removed: it stays in the row, right after the front. Only when a row cannot fill its front without it (a
//                                       short row, everything blocked) is the cap exceeded, and `forced` counts those places.
//   3. memory of what was up front      E[tt] = sum over k = 1..memoryDays of 2^(-(k-1)/halfLifeDays) * (rows whose front held tt, k days ago): each front of yesterday pushes the film
//                                       `penalty` places down today, and the push halves every `halfLifeDays` days. Today's own entry is never part of the sum, so a second build of the
//                                       same day reads the same memory and draws the same order. The memory is cache/front-memory.json, written once per night by the scheduled build.
//
// Rows in `keep` (Tonight, the Watchlist) are not reordered, but their front counts for the cap and the memory. A row with place "menu" (friends-week) is not on the Board: not shuffled, not counted.
// Pure: no network and no clock (the date is an argument), apart from readMemory/writeMemory/rememberFront, which touch the one file they are given.
// The legacy family never sees any of it: applyToPlan reorders plan.board2 and nothing else (test/legacy-parity.test.js proves it against a build with no board).

const fs = require("fs");
const path = require("path");
const { seeded } = require("./util");

const DEFAULTS = { front: 8, tau: 8, penalty: 7, maxFronts: 2, maxLeads: 1, memory: "file", memoryDays: 7, halfLifeDays: 2, keep: ["tonight", "watchlist"] };
const MEMORY_VERSION = 1;
const MEMORY_FILE = "front-memory.json";
const MAX_COUNT = 54; // a film cannot be in the front of more rows than the Board has
const DATE = /^\d{4}-\d{2}-\d{2}$/, TT = /^tt\d+$/;

/** Gumbel(0,1), one number per (date, row, film), from the repository's seeded(). u is never 0 or 1. */
function gumbel(today, rowId, tt) {
  const u = seeded(`${today}|${rowId}|${tt}`)() + 0.5 / 4294967296;
  return -Math.log(-Math.log(u));
}

/** "YYYY-MM-DD" shifted by k days (UTC, noon: no time zone or daylight saving can move it). */
function shiftDate(date, k) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
}

/** A real calendar day written YYYY-MM-DD ("2026-02-30" and "9999-99-99" are not). */
function isDate(date) {
  return typeof date === "string" && DATE.test(date) && Number.isFinite(Date.parse(`${date}T12:00:00Z`)) && shiftDate(date, 0) === date;
}

/** The dates of the memory that count for `today`: today-memoryDays … today-1, sorted. (Today's own entry, left by an earlier build of the day, is never read; older ones wait for the next write to be pruned.) */
function usedDays(days, today, spec) {
  const first = shiftDate(today, -spec.memoryDays), last = shiftDate(today, -1);
  return [...days.keys()].filter((d) => d >= first && d <= last).sort();
}

/** The dates of the memory that lie after `today`: a clock or a date typed by hand gone wrong. They are not read and the next write drops them. */
function futureDays(days, today) {
  return [...days.keys()].filter((d) => d > today).sort();
}

/** E[tt] for `today`: days is the Map date → Map(tt → rows whose front held tt) of readMemory(); only the dates today-memoryDays … today-1 count. → Map tt → number */
function exposure(days, today, spec) {
  const e = new Map();
  for (let k = 1; k <= spec.memoryDays; k++) {
    const day = days.get(shiftDate(today, -k));
    if (!day) continue;
    const weight = Math.pow(2, -(k - 1) / spec.halfLifeDays);
    for (const [tt, n] of day) e.set(tt, (e.get(tt) || 0) + weight * n);
  }
  return e;
}

/**
 * The day's order. rows: [{ id, place: "board" | "menu", ids: [tt …] }] in the Board's order, ids in the row's strict order. exposure: Map tt → E (empty = no memory).
 * → { order: Map rowId → [tt …], fronts: Map tt → rows whose front holds it, leads: Map tt → rows it opens, skipped: [row ids left in strict order], shuffled: n, kept: n,
 *     forced: the places that went over a cap, each counted once: the film that opens a row while already opening maxLeads rows (or already in maxFronts fronts), and a front place filled by a film already in maxFronts fronts }
 */
function orderRows(rows, today, spec, expo = new Map()) {
  const keep = new Set(spec.keep);
  const order = new Map(), fronts = new Map(), leads = new Map(), skipped = [];
  let forced = 0, shuffled = 0, kept = 0;
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const r of rows) {
    let out = r.ids.slice();
    const onBoard = r.place === "board";
    if (onBoard && !keep.has(r.id)) {
      if (new Set(r.ids).size !== r.ids.length) skipped.push(r.id); // a film twice in one row: the draw has one number per film, so the row stays strict
      else {
        shuffled++;
        const sorted = r.ids.map((tt, pos) => ({ tt, pos, key: -pos / spec.tau + gumbel(today, r.id, tt) - (spec.penalty / spec.tau) * (expo.get(tt) || 0) })).sort((a, b) => b.key - a.key || a.pos - b.pos);
        const ok = (x) => (fronts.get(x.tt) || 0) < spec.maxFronts;
        const okLead = (x) => ok(x) && (leads.get(x.tt) || 0) < spec.maxLeads;
        const front = [], used = new Set();
        const take = (x) => { front.push(x); used.add(x.tt); };
        if (sorted.length) {
          const lead = sorted.find(okLead) || sorted.find(ok) || sorted[0];
          if (!okLead(lead)) forced++; // the film that opens this row is over a cap (it already opens maxLeads rows, or every film of the row is already in maxFronts fronts): the place is counted
          take(lead);
        }
        for (const x of sorted) { if (front.length >= spec.front) break; if (!used.has(x.tt) && ok(x)) take(x); }
        for (const x of sorted) { if (front.length >= spec.front) break; if (!used.has(x.tt)) { take(x); forced++; } } // a short row, or everything blocked: complete by the draw and count it
        out = [...front, ...sorted.filter((x) => !used.has(x.tt))].map((x) => x.tt);
      }
    } else if (onBoard) kept++;
    order.set(r.id, out);
    if (onBoard) {
      for (const tt of out.slice(0, spec.front)) bump(fronts, tt); // a kept row's front counts too: Tonight's films are in the first screen all the same
      if (out.length) bump(leads, out[0]);
    }
  }
  return { order, fronts, leads, forced, skipped, shuffled, kept };
}

/** What the fronts of an order look like: { films: distinct films in the front places, places: front places, maxFronts: most rows one film stands in the front of, maxLeads: most rows one film opens }. Rows with place "menu" are not on the Board. */
function frontReport(order, rows, front) {
  const fronts = new Map(), leads = new Map();
  let places = 0;
  for (const r of rows) {
    if (r.place !== "board") continue;
    const ids = order.get(r.id) || [];
    for (const tt of ids.slice(0, front)) { fronts.set(tt, (fronts.get(tt) || 0) + 1); places++; }
    if (ids.length) leads.set(ids[0], (leads.get(ids[0]) || 0) + 1);
  }
  return { films: fronts.size, places, maxFronts: Math.max(0, ...fronts.values()), maxLeads: Math.max(0, ...leads.values()) };
}

/**
 * The shuffle of a plan: plan.board2 rows with place "board" outside spec.keep get a new `items` array; nothing else is touched (not plan.board, not an item object, not a menu row).
 * days: Map of readMemory() (or empty). → { report, strictReport, fronts, forced, skipped, shuffled, kept, exposed }
 * strictReport is the same measure on the order before the shuffle: the positive control of the log (a Board that is not shuffled shows its repetition there).
 */
function applyToPlan(plan, today, spec, days = new Map()) {
  const board2 = (plan.board2 || []).filter((r) => !r.series);
  const rows = board2.map((r) => ({ id: r.id, place: r.place, ids: r.items.map((it) => it.id) }));
  const strict = new Map(rows.map((r) => [r.id, r.ids]));
  const expo = spec.memory === "file" ? exposure(days, today, spec) : new Map();
  const day = orderRows(rows, today, spec, expo);
  const items = new Map(board2.map((r) => [r.id, new Map(r.items.map((it) => [it.id, it]))]));
  for (const r of board2) {
    if (r.place !== "board" || spec.keep.includes(r.id) || day.skipped.includes(r.id)) continue;
    r.items = day.order.get(r.id).map((tt) => items.get(r.id).get(tt));
  }
  return { report: frontReport(day.order, rows, spec.front), strictReport: frontReport(strict, rows, spec.front), fronts: day.fronts, forced: day.forced, skipped: day.skipped, shuffled: day.shuffled, kept: day.kept, exposed: expo.size };
}

// ── the memory file ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** cache/front-memory.json → { days: Map date → Map(tt → n), problem: string | null }. A missing file is an empty memory with no problem; a file that cannot be used is an empty memory and the reason (in English, for the log). */
function readMemory(file) {
  const none = (problem) => ({ days: new Map(), problem });
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return none(e.code === "ENOENT" ? null : `${path.basename(file)} cannot be read (${e.code || e.message})`); }
  let json;
  try { json = JSON.parse(text); } catch { return none(`${path.basename(file)} is not valid JSON`); }
  const isObject = (x) => !!x && typeof x === "object" && !Array.isArray(x);
  if (!isObject(json) || json.version !== MEMORY_VERSION) return none(`version ${JSON.stringify(isObject(json) ? json.version : undefined)} is not ${MEMORY_VERSION}`);
  if (!isObject(json.days)) return none("days is not an object");
  const days = new Map();
  for (const [date, films] of Object.entries(json.days)) {
    if (!isDate(date)) return none(`"${date}" is not a date`);
    if (!isObject(films)) return none(`${date} is not an object`);
    const day = new Map();
    for (const [tt, n] of Object.entries(films)) {
      if (!TT.test(tt)) return none(`${date}: "${tt}" is not an IMDb id`);
      if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) return none(`${date}: ${tt} has the count ${JSON.stringify(n)}, expected a whole number from 1 to ${MAX_COUNT}`);
      day.set(tt, n);
    }
    days.set(date, day);
  }
  return { days, problem: null };
}

/** The text of the memory file: `days` with today's entry REPLACED by `fronts` (Map tt → n), every date older than today-memoryDays or after today dropped, dates and films sorted, one line per day. */
function memoryText(days, today, fronts, spec) {
  const all = new Map(days);
  all.set(today, new Map(fronts));
  const oldest = shiftDate(today, -spec.memoryDays);
  for (const date of [...all.keys()]) if (date < oldest || date > today) all.delete(date);
  const lines = [...all.keys()].sort().map((date) => `${JSON.stringify(date)}:${JSON.stringify(Object.fromEntries([...all.get(date)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))}`);
  return `{"version":${MEMORY_VERSION},"days":{\n${lines.join(",\n")}\n}}\n`;
}

/** Writes the memory file atomically (a temporary file, then rename: a build that dies half way leaves the old file). */
function writeMemory(file, days, today, fronts, spec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, memoryText(days, today, fronts, spec));
  fs.renameSync(tmp, file);
}

/**
 * Whether this build records today's front, and does it. Only the scheduled build does (FRONT_MEMORY_WRITE=1, set for the scheduled run alone: scripts/noturna-mac.sh --agendada since 21/10/2026; the workflow's schedule before) and never a --cache-only one:
 * a build of a push or of a test reads the memory and writes nothing, so the front changes once a day. → { written: boolean, why: string } for the log.
 */
function rememberFront({ file, days, today, fronts, spec, env, cacheOnly }) {
  if (spec.memory !== "file") return { written: false, why: `memory is ${spec.memory}` };
  if (env.FRONT_MEMORY_WRITE !== "1") return { written: false, why: "FRONT_MEMORY_WRITE is not 1: only the scheduled build writes" };
  if (cacheOnly) return { written: false, why: "--cache-only writes no cache" };
  writeMemory(file, days, today, fronts, spec);
  return { written: true, why: `${path.basename(file)} now holds ${fronts.size} films for ${today}` };
}

/**
 * The whole of what build.js does with the shuffle, so that a test can run the same code without a network: reads the memory file of `cacheDir`, shuffles plan.board2 (or, without `shuffle`, only measures the
 * strict order), writes the log lines, and hands back remember(env, cacheOnly), which build.js calls once the files are published. → { remember }
 */
function runInBuild({ plan, today, shuffle, cacheDir, log }) {
  const spec = shuffle || { ...DEFAULTS, keep: [] };
  const file = path.join(cacheDir, MEMORY_FILE);
  const mem = shuffle && spec.memory === "file" ? readMemory(file) : { days: new Map(), problem: null };
  if (mem.problem) log(`  ! front memory: ${mem.problem} — starting from no memory`);
  const future = futureDays(mem.days, today), dates = usedDays(mem.days, today, spec);
  if (future.length) log(`  ! front memory: ${future.length} date${future.length === 1 ? "" : "s"} after ${today} (${future[0]}${future.length > 1 ? ` … ${future[future.length - 1]}` : ""}) ignored; the next write drops ${future.length === 1 ? "it" : "them"}`);
  const measure = (r) => `front ${r.films} films in ${r.places} places, at most ${r.maxFronts} fronts for one film, ${r.maxLeads} leads`;
  if (!shuffle) {
    const strict = applyToPlan(plan, today, { ...spec, keep: plan.board2.map((x) => x.id) }); // every row "kept": nothing is reordered, the measure is of the strict order
    log(`     Front shuffle (v2 Board): off · strict: ${measure(strict.strictReport)}`);
    return { remember: () => ({ written: false, why: "no board.shuffle" }) };
  }
  const r = applyToPlan(plan, today, spec, mem.days);
  const memory = spec.memory === "none" ? "none" : `${dates.length} day${dates.length === 1 ? "" : "s"} read${dates.length ? ` (${dates[0]} to ${dates[dates.length - 1]})` : ""}, ${r.exposed} films carry a penalty`;
  log(`     Front shuffle (v2 Board): ${r.shuffled} rows shuffled, ${r.kept} kept · tau ${spec.tau}, penalty ${spec.penalty}, front ${spec.front}, at most ${spec.maxFronts} fronts and ${spec.maxLeads} lead per film · memory: ${memory} · forced ${r.forced} · skipped ${r.skipped.length} · ${measure(r.report)} (strict: ${measure(r.strictReport)})`);
  return {
    remember(env, cacheOnly) {
      const w = rememberFront({ file, days: mem.days, today, fronts: r.fronts, spec, env, cacheOnly });
      log(`     Front memory: ${w.written ? "today's front written" : "not written"} (${w.why})`);
      return w;
    },
  };
}

module.exports = { DEFAULTS, MEMORY_FILE, MEMORY_VERSION, MAX_COUNT, gumbel, shiftDate, exposure, orderRows, frontReport, applyToPlan, readMemory, memoryText, writeMemory, rememberFront, usedDays, futureDays, runInBuild };
