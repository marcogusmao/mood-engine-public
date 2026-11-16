// The memory of Tonight (Marco, 14/11/2026, questionnaire: "Bigger pool + 30 days without repeating").
//
// Tonight (lib/rows.js) drew ten films a day from the top twelve of each of nine moods, and nothing remembered what was shown the day before. On 14/11/2026 those twelve-a-mood were 91 different
// films (the films that pass the recommendation rule and that he has not seen; the "104" of the audit also counted films the rule refuses). MEASURED on the seven days published from 08 to 14/11/2026:
// 1.50 of the 10 films of a day were films of the day before. SIMULATED by the audit on the code: 1.36 of 10, and a film at the top of two moods in the row one day in three. Since 14/11/2026 the draw is over the top 40 of each mood
// (config.json tonight.depth) and a film that was in Tonight on one of the `tonight.noRepeatDays` (30) days before today is not drawn today. This file is the second half: which films were shown, and when.
//
//   the file      <cache dir>/tonight-memory.json: { "version": 1, "days": { "YYYY-MM-DD": ["tt…", …] } }, one line a day, the films in the order of the row as it was published.
//   who reads     every build (runInBuild): the dates today-noRepeatDays … today-1. Today's own entry, left by an earlier build of the day, is never read: a second build of the day sees the same memory
//                 and draws the same ten films (if it read its own entry, it would hold back the films of the first build and Tonight would change in the middle of the day).
//   who writes    every build that PUBLISHES, and no other (review of 14/11/2026, R5): TONIGHT_MEMORY_WRITE=1 and never --cache-only. scripts/noturna-mac.sh sets it in --agendada AND in --manual
//                 (both push the site); a rehearsal (--ensaio, NOTURNA_BUILD=offline), a build typed in a terminal and a test write nothing. It is NOT the front memory's switch (FRONT_MEMORY_WRITE,
//                 the scheduled night alone): a night started by hand publishes Tonight with no front memory, and if it did not record its ten films they could be drawn again the next day.
//                 A second publishing build of the day REPLACES today's entry (so of two different rows published on one day only the last is remembered). The write drops what is older than
//                 today-noRepeatDays and what lies after today.
//   when it counts  WRITTEN IS NOT YET REMEMBERED (15/11/2026). This module writes the entry into the build's own cache file, before anything is published. What the next night reads is the file
//                 of `main`, and the nightly sends it there only AFTER the site is on gh-pages, in a commit of its own (scripts/noturna-mac.sh salvar_memoria_tonight; salvar_caches leaves the
//                 file out). On the first real night, 15/11/2026, the file went with the other caches and then the publication failed: main held ten films as shown that nobody saw.
//                 A night that publishes and whose entry then does not reach main says so (MEMÓRIA DO TONIGHT PERDIDA, the warning 53) and those films are free again; BACKLOG.md, 14/11/2026,
//                 says how the next night could rebuild the entry from the published catalog/movie/tonight.json.
//   a bad file    missing, unreadable, not JSON, another version, a day that is not a date, a film that is not an IMDb id: the night goes on with an EMPTY memory and one line in the log
//                 ("! tonight memory: … — starting from no memory"), the way the front memory does.
//
// Why a file of its own and not a field of cache/front-memory.json: that file has one writer (memoryText of lib/front-shuffle.js) that rewrites it whole and keeps 7 days; a second writer with a
// 30-day window would have to change that function and the checks of the people's snapshot (lib/person-input-validation.js frontMemory). With its own file lib/front-shuffle.js is not edited
// and each file is proved alone.
// What moves and what does not (review of 14/11/2026, R1; an earlier text here said "the order of the other rows cannot move", which is more than the code does): in what buildRows returns, and so in
// the legacy family, ONLY the row `tonight` changes with this memory. In the shuffled v2 Board it can reach another row: Tonight is a kept row there, the films of its first screen count for the cap
// across rows (a film in the front of at most maxFronts rows) and enter the front memory of the next days, so a different Tonight can change the FRONT of another row. The reviewer measured it on
// the real Board: the front of 1 of the 53 rows (sight-sound). test/tonight-memory.test.js holds that path on a world of two rows; no test measures it on the real Board.
// Pure apart from readMemory/writeMemory/remember, which touch the one file they are given: no network and no clock (the date is an argument).

const fs = require("fs");
const path = require("path");

const MEMORY_VERSION = 1;
const MEMORY_FILE = "tonight-memory.json";
const MAX_FILMS = 500; // a day's entry is one row of Tonight (10 films in production); a longer list than this is not something this file's writer made
const DATE = /^\d{4}-\d{2}-\d{2}$/, TT = /^tt\d+$/;
const REVISION = /^r-[a-f0-9]{32}$/; // the revision of a person's build (build.js --revision, lib/people-publication.js)
const MAX_PENDING = 200; // rows of a person's builds that wait for their publication: one per build, pruned with the window

/** "YYYY-MM-DD" shifted by k days (UTC, noon: no time zone or daylight saving can move it). The rule of lib/front-shuffle.js shiftDate. */
function shiftDate(date, k) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
}

/** A real calendar day written YYYY-MM-DD ("2026-02-30" and "9999-99-99" are not). */
function isDate(date) {
  return typeof date === "string" && DATE.test(date) && Number.isFinite(Date.parse(`${date}T12:00:00Z`)) && shiftDate(date, 0) === date;
}

/** The dates of the memory that count for `today`: today-noRepeatDays … today-1, sorted. Today's own entry is never one of them. */
function usedDays(days, today, noRepeatDays) {
  const first = shiftDate(today, -noRepeatDays), last = shiftDate(today, -1);
  return [...days.keys()].filter((d) => d >= first && d <= last).sort();
}

/** The dates of the memory that lie after `today`: a clock or a date typed by hand gone wrong. They are not read and the next write drops them. */
function futureDays(days, today) {
  return [...days.keys()].filter((d) => d > today).sort();
}

/**
 * The films Tonight must not show today: days is the Map date → [tt …] of readMemory(); only the dates today-noRepeatDays … today-1 count.
 * → Map tt → the LAST of those dates the film was in Tonight (lib/rows.js reads it: a film in the Map is held back, and when a mood has nothing else the film whose date is the oldest comes back first).
 */
function lastShown(days, today, noRepeatDays) {
  const shown = new Map();
  for (const date of usedDays(days, today, noRepeatDays)) for (const tt of days.get(date)) shown.set(tt, date); // the dates come sorted: a later date overwrites an earlier one
  return shown;
}

/** cache/tonight-memory.json → { days: Map date → [tt …], problem: string | null }. A missing file is an empty memory with no problem; a file that cannot be used is an empty memory and the reason (in English, for the log). */
function readMemory(file) {
  const none = (problem) => ({ days: new Map(), pending: [], problem });
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
    if (!Array.isArray(films)) return none(`${date} is not a list of films`);
    if (films.length > MAX_FILMS) return none(`${date} holds ${films.length} films, more than ${MAX_FILMS}`);
    for (const tt of films) if (typeof tt !== "string" || !TT.test(tt)) return none(`${date}: ${JSON.stringify(tt)} is not an IMDb id`);
    days.set(date, films.slice());
  }
  // `pending` exists only in a person's file (see "A person's memory" below): rows that were drawn and are not counted until the build that drew them is published
  const pending = [];
  if (json.pending !== undefined) {
    if (!Array.isArray(json.pending)) return none("pending is not a list");
    if (json.pending.length > MAX_PENDING) return none(`pending holds ${json.pending.length} rows, more than ${MAX_PENDING}`);
    for (const p of json.pending) {
      if (!isObject(p) || !isDate(p.date)) return none("a pending row has no date");
      if (typeof p.revision !== "string" || !REVISION.test(p.revision)) return none(`${p.date}: the pending row has no revision (r- and 32 hex digits)`);
      if (!Array.isArray(p.films) || p.films.length > MAX_FILMS || p.films.some((tt) => typeof tt !== "string" || !TT.test(tt))) return none(`${p.date}: the pending row is not a list of IMDb ids`);
      pending.push({ date: p.date, revision: p.revision, films: p.films.slice() });
    }
  }
  return { days, pending, problem: null };
}

/** The text of the memory file: `days` with today's entry REPLACED by `shown` ([tt …], the row as published), every date older than today-noRepeatDays or after today dropped, dates sorted, one line per day. */
function memoryText(days, today, shown, noRepeatDays) {
  const all = new Map(days);
  all.set(today, [...new Set(shown)].filter((tt) => typeof tt === "string" && TT.test(tt)));
  const oldest = shiftDate(today, -noRepeatDays);
  for (const date of [...all.keys()]) if (date < oldest || date > today) all.delete(date);
  const lines = [...all.keys()].sort().map((date) => `${JSON.stringify(date)}:${JSON.stringify(all.get(date))}`);
  return `{"version":${MEMORY_VERSION},"days":{\n${lines.join(",\n")}\n}}\n`;
}

/** Writes the memory file atomically (a temporary file, then rename: a build that dies half way leaves the old file). */
function writeMemory(file, days, today, shown, noRepeatDays) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, memoryText(days, today, shown, noRepeatDays));
  fs.renameSync(tmp, file);
}

/**
 * Whether this build records today's Tonight, and does it. The switch is this file's own, TONIGHT_MEMORY_WRITE=1: "this build is going to be published" (scripts/noturna-mac.sh --agendada and --manual;
 * review of 14/11/2026, R5: with the front memory's switch a night started by hand published a row that nothing remembered). A --cache-only build never writes a cache. A rehearsal, a build typed in a
 * terminal and a test read the memory and write nothing. → { written: boolean, why: string } for the log.
 * refusal(): the three reasons not to write, shared with a person's file (rememberPending); null when the build may write.
 */
function refusal({ noRepeatDays, env, cacheOnly }) {
  if (!(noRepeatDays > 0)) return { written: false, why: "tonight.noRepeatDays is 0: no memory is kept" };
  if (env.TONIGHT_MEMORY_WRITE !== "1") return { written: false, why: "TONIGHT_MEMORY_WRITE is not 1: only a build that publishes writes" };
  if (cacheOnly) return { written: false, why: "--cache-only writes no cache" };
  return null;
}
function remember({ file, days, today, shown, noRepeatDays, env, cacheOnly }) {
  const no = refusal({ noRepeatDays, env, cacheOnly });
  if (no) return no;
  writeMemory(file, days, today, shown, noRepeatDays);
  return { written: true, why: `${path.basename(file)} now holds ${new Set(shown).size} films for ${today}` };
}

// ── A person's memory (Marco, 15/11/2026, questionnaire: "Yes, same rule, his own memory") ─────────────────────────────────────────────────────────────────
// A person's build (Will) draws Tonight by the same rule, from a file of ITS OWN: <the person's private folder>/cache/tonight-memory.json, never Marco's cache/. The guarantee of 15/11/2026 holds
// there too, by another road, because nothing in a person's build knows when it is published: the build writes its row under `pending`, with the revision of the build
// ({ "date", "revision", "films" }); a pending row is NOT counted; a later build that is told which revisions were published (TONIGHT_PUBLISHED_REVISIONS, a list of revisions) moves the rows
// of those revisions into `days`, and only then are their films held back. A row whose build was never published is never counted, and leaves the file with the window.
// Marco's own file never has `pending`: his night sends the file to main only after the site is published (scripts/noturna-mac.sh salvar_memoria_tonight).

/** "r-…,r-…" (the environment's list of published revisions) → Set of the well-formed ones. */
function revisionsOf(text) {
  return new Set(String(text || "").split(",").map((s) => s.trim()).filter((s) => REVISION.test(s)));
}

/** The rows of `pending` whose revision is in `published` become days (a later row of the same date replaces an earlier one). → { days, pending: the rows still waiting, confirmed: the rows moved } */
function confirmPublished(days, pending, published) {
  const out = new Map(days), left = [], confirmed = [];
  for (const p of pending) {
    if (published.has(p.revision)) { out.set(p.date, p.films.slice()); confirmed.push(p); } else left.push(p);
  }
  return { days: out, pending: left, confirmed };
}

/** The text of a person's file: `days` as they are (nothing of today is added to them), `pending` with this build's row added (a row of the same revision replaced), both cut to today-noRepeatDays … today. */
function personText(days, pending, today, row, noRepeatDays) {
  const oldest = shiftDate(today, -noRepeatDays), inWindow = (date) => date >= oldest && date <= today;
  const films = [...new Set(row.films)].filter((tt) => typeof tt === "string" && TT.test(tt));
  const rows = [...pending.filter((p) => p.revision !== row.revision), { date: today, revision: row.revision, films }].filter((p) => inWindow(p.date)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.revision < b.revision ? -1 : 1));
  const dayLines = [...days.keys()].filter(inWindow).sort().map((date) => `${JSON.stringify(date)}:${JSON.stringify(days.get(date))}`);
  return `{"version":${MEMORY_VERSION},"days":{\n${dayLines.join(",\n")}\n},"pending":[\n${rows.map((p) => JSON.stringify(p)).join(",\n")}\n]}\n`;
}

/** A person's build records its row as PENDING, under the conditions of remember(); the file is private (mode 0600, as every file of a person's folder). → { written, why } */
function rememberPending({ file, days, pending, today, shown, revision, noRepeatDays, env, cacheOnly }) {
  const no = refusal({ noRepeatDays, env, cacheOnly }); // the same three conditions as Marco's file
  if (no) return no;
  if (!REVISION.test(String(revision))) return { written: false, why: "the person's build has no revision to file the row under" };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, personText(days, pending, today, { revision, films: shown }, noRepeatDays), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return { written: true, why: `${path.basename(file)} holds ${new Set(shown).size} films for ${today} as a row waiting for the publication of ${revision}; it is counted once a later build is told that revision was published` };
}

/** The films of Tonight as the plan publishes them: the row "tonight" of the v2 Board and of the legacy Board (the same films unless a later step took one out of one of them), each film once, in the row's order. */
function publishedTonight(plan) {
  const ids = [];
  for (const board of [plan.board2, plan.board]) for (const row of board || []) if (row.id === "tonight") for (const it of row.items || []) if (!ids.includes(it.id)) ids.push(it.id);
  return ids;
}

/**
 * The whole of what build.js does with this memory, so that a test can run the same code without a network: reads the file of `cacheDir`, says in the log what it read, and hands back
 * `shown` (lastShown(): what lib/rows.js buildRows takes as `tonightShown`) and remember(plan, env, cacheOnly), which build.js calls once the files are published.
 * noRepeatDays 0 reads no file and writes none (Tonight as it was before 14/11/2026, with whatever tonight.depth says).
 */
function runInBuild({ noRepeatDays, today, cacheDir, log, person = null }) {
  const file = path.join(cacheDir, MEMORY_FILE);
  const mem = noRepeatDays > 0 ? readMemory(file) : { days: new Map(), problem: null };
  if (mem.problem) log(`  ! tonight memory: ${mem.problem} — starting from no memory`);
  // person: { revision, published: Set of revisions } in a person's build (build.js, cfg.personContext), absent in Marco's. The rows of published revisions are counted from here on; the others wait.
  const own = person && noRepeatDays > 0 ? confirmPublished(mem.days, mem.pending || [], person.published || new Set()) : null;
  const days = own ? own.days : mem.days;
  if (own) log(`     Tonight memory of this person: ${own.confirmed.length} row${own.confirmed.length === 1 ? "" : "s"} now counted, their build was published${own.confirmed.length ? ` (${own.confirmed.map((p) => p.date).join(", ")})` : ""}; ${own.pending.length} waiting for a publication and NOT counted`);
  const future = futureDays(days, today), dates = usedDays(days, today, noRepeatDays);
  if (future.length) log(`  ! tonight memory: ${future.length} date${future.length === 1 ? "" : "s"} after ${today} (${future[0]}${future.length > 1 ? ` … ${future[future.length - 1]}` : ""}) ignored; the next write drops ${future.length === 1 ? "it" : "them"}`);
  const shown = lastShown(days, today, noRepeatDays);
  log(noRepeatDays > 0
    ? `     Tonight memory: ${dates.length} day${dates.length === 1 ? "" : "s"} read${dates.length ? ` (${dates[0]} to ${dates[dates.length - 1]})` : ""}, ${shown.size} film${shown.size === 1 ? "" : "s"} held back (shown in Tonight in the last ${noRepeatDays} days)`
    : "     Tonight memory: off (tonight.noRepeatDays is 0)");
  return {
    shown,
    remember(plan, env, cacheOnly) {
      const w = own
        ? rememberPending({ file, days, pending: own.pending, today, shown: publishedTonight(plan), revision: person.revision, noRepeatDays, env, cacheOnly })
        : remember({ file, days: mem.days, today, shown: publishedTonight(plan), noRepeatDays, env, cacheOnly });
      log(`     Tonight memory: ${w.written ? "today's row written" : "not written"} (${w.why})`);
      return w;
    },
  };
}

module.exports = { MAX_PENDING, REVISION, revisionsOf, confirmPublished, personText, rememberPending, MEMORY_FILE, MEMORY_VERSION, MAX_FILMS, shiftDate, isDate, usedDays, futureDays, lastShown, readMemory, memoryText, writeMemory, remember, publishedTonight, runInBuild };
