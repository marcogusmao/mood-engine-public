// cache/mubi.json: the one MUBI file that IS committed (Marco, 13/10/2026: the Our Take text enters the public descriptions with the credit "MUBI:",
// and the cache grows by 100 requests a day, scripts/mubi-nightly.js). It is written by scripts/collect-mubi.py and merged here.
//
// Because it is committed, it carries an explicit allowlist, the way lib/learning/public.js does for the published files: a record may hold the film's
// title, ids, MUBI's Our Take, the short synopsis, the community rating, dates and the source, and NOTHING ELSE. A key that is not named below (a
// personal rating, a token, a cookie, a header, a raw response) makes the record invalid, at any depth. The collector never writes one; this is the
// door shut in case a future change to it, or a hand edit, tries.
//
// Pure functions, no file or network access. Tests: test/mubi-nightly.test.js.

const STATUSES = ["confirmed", "ambiguous", "not_found_in_search", "error"];
const TT = /^tt\d{5,12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const MAX_TEXT = 4000; // the collector's own ceiling for Our Take and synopsis

// ── value checks ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// A text that has the shape of a credential ("Authorization: …", "api_key=…") is not a film fact. The bare word is fine ("a token gesture"). test/describe.test.js scans the
// committed file with this same pattern; the merge refuses a record that has one, so the next night's test cannot turn red because of a text MUBI sent.
const CREDENTIAL_TEXT = /(api[_-]?key|bearer|cookie|authorization)\s*[:=]/i;
const text = (v) => typeof v === "string" && v.length <= MAX_TEXT && !CREDENTIAL_TEXT.test(v);
const iso = (v) => typeof v === "string" && ISO.test(v);
const count = (v) => Number.isInteger(v) && v >= 0;
const int = (v) => Number.isInteger(v);
const num = (v) => typeof v === "number" && Number.isFinite(v);
const bool = (v) => typeof v === "boolean";
// A spec is a function (a leaf check), a `shape` (an object that may hold only its keys) or a `list` (an array of items that each pass one spec). The combinators below take any of the three:
// `check` is the one walk, and `accepts` asks it a yes/no question. (13/10/2026 review: `list` once called its item as a function, and `candidates: list(shape(...))` threw on every "ambiguous" record.)
const accepts = (spec, v) => { const out = []; check(spec, v, "", out); return out.length === 0; };
const nullable = (spec) => (v) => v === null || accepts(spec, v);
const either = (...specs) => (v) => specs.some((c) => accepts(c, v));
const exactly = (...values) => (v) => values.includes(v);
/** An array of at most `max` items, each passing `item` (a function or a shape). */
const list = (item, max = 50) => ({ items: item, max });
const mubiUrl = (v) => typeof v === "string" && v.length <= 300 && /^https:\/\/mubi\.com\/[^\s?#]*$/.test(v); // a page address, never one with a query string or a fragment
const slug = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(v);
/** An object that may hold ONLY the keys of `spec`, each passing its check. A key outside it is a problem, whatever its value. */
const shape = (spec) => ({ spec });

const FOUND = shape({ title: nullable(text), originalTitle: nullable(text), year: nullable(num), directors: list(text), duration: nullable(num) });
const MUBI = shape({ id: int, slug: nullable(slug), url: nullable(mubiUrl) });
const FIELD = { state: text, reason: text }; // Our Take, short synopsis and rating all say in which state they are
const RECORD = shape({
  status: exactly(...STATUSES),
  capturedAt: iso,
  request: shape({ country: text, acceptLanguage: text, query: text, detail: text, via: text, slug: text }),
  identity: shape({
    asked: shape({ title: text, year: int, directors: list(text), runtime: nullable(int) }),
    found: FOUND, evidence: list(text), note: text,
  }),
  mubi: MUBI,
  locale: text,
  ourTake: shape({ ...FIELD, text }),
  synopsis: shape({ ...FIELD, text, kind: text }),
  rating: shape({ ...FIELD, votes: either(count, exactly("unknown")), outOfTen: num, average: nullable(num) }),
  searched: shape({ results: count }),
  candidates: list(shape({ mubi: MUBI, found: FOUND, evidence: list(text), why: text }), 20),
  error: shape({ at: iso, reason: text }),
  lastError: shape({ at: iso, reason: text }),
  stale: bool,
});
const FILE = shape({ schema: exactly(1), source: text, updatedAt: iso, films: (v) => isObject(v) });
const REPORT = shape({
  schema: exactly(1), date: (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v), generatedAt: iso,
  status: exactly("ok", "merge-failed", "failed"), message: text,
  requestsMade: nullable(count), requestsMax: count, filmsDelivered: count, filmsAsked: count,
  found: count, withoutOurTake: count, notFound: count, ambiguous: count, errors: count,
  stopReason: text, collectorExit: nullable(int),
  cache: shape({ records: count, confirmed: count, withOurTake: count }),
});

function check(spec, value, where, out) {
  if (typeof spec === "function") { if (!spec(value)) out.push(`${where}: invalid value`); return; }
  if (Object.hasOwn(spec, "items")) {
    if (!Array.isArray(value) || value.length > spec.max) out.push(`${where}: invalid value`);
    else value.forEach((item, i) => check(spec.items, item, `${where}[${i}]`, out));
    return;
  }
  if (!isObject(value)) { out.push(`${where}: expected an object`); return; }
  for (const [k, v] of Object.entries(value)) {
    if (!Object.hasOwn(spec.spec, k)) out.push(`${where}.${k}: field not on the allowlist`);
    else check(spec.spec[k], v, `${where}.${k}`, out);
  }
}

/** → [problem…] for one record (empty = allowed). Names the path of every offending key; never prints a value. */
function recordProblems(record) {
  const out = [];
  check(RECORD, record, "record", out);
  if (isObject(record) && !Object.hasOwn(record, "status")) out.push("record.status: missing");
  return out;
}

/** → [problem…] for the file as a whole: the envelope and every record. */
function cacheProblems(cache) {
  const out = [];
  check(FILE, cache, "cache", out);
  if (!isObject(cache) || !isObject(cache.films)) return out.length ? out : ["cache.films: missing"];
  for (const [id, record] of Object.entries(cache.films)) {
    if (!TT.test(id)) out.push(`cache.films[${String(id).slice(0, 20)}]: not an IMDb id`);
    for (const p of recordProblems(record)) out.push(`${id}: ${p}`);
  }
  return out;
}

const reportProblems = (report) => { const out = []; check(REPORT, report, "report", out); return out; };

/** Our Take of a record, or "" when it has none: only a confirmed record's available text counts. */
const ourTakeOf = (r) => (r && r.status === "confirmed" && r.ourTake && r.ourTake.state === "available" && typeof r.ourTake.text === "string" ? r.ourTake.text.trim() : "");

/**
 * The cache after a run: every record of `old` stays, and a record of `fresh` replaces its old one only when it is allowed (recordProblems) and does not
 * trade a confirmed film for something worse. Never loses a film. → { cache, added, replaced, kept, rejected: [{ id, problems }] }.
 * (The collector already keeps a confirmed record when a refresh fails (keep_or_replace); this is the second net, in case the file it was given differs.)
 */
function mergeCaches(old, fresh) {
  const films = { ...old.films };
  const added = [], replaced = [], kept = [], rejected = [];
  for (const [id, record] of Object.entries(fresh.films || {})) {
    const problems = !TT.test(id) ? ["not an IMDb id"] : recordProblems(record);
    if (problems.length) { rejected.push({ id: String(id).slice(0, 20), problems }); continue; }
    const before = films[id];
    if (before && before.status === "confirmed" && record.status !== "confirmed") { kept.push(id); continue; }
    if (before && JSON.stringify(before) === JSON.stringify(record)) continue;
    (before ? replaced : added).push(id);
    films[id] = record;
  }
  const changed = added.length + replaced.length > 0;
  return { cache: { ...old, schema: 1, source: old.source || fresh.source || "api.mubi.com/v3", updatedAt: changed && iso(fresh.updatedAt) ? fresh.updatedAt : old.updatedAt, films }, added, replaced, kept, rejected };
}

module.exports = { CREDENTIAL_TEXT, STATUSES, recordProblems, cacheProblems, reportProblems, mergeCaches, ourTakeOf, TT };
