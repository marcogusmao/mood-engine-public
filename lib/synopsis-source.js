// Where a film's synopsis comes from (Marco, 13/10/2026): MUBI's Our Take when the film has one, else Letterboxd's synopsis, else TMDB's overview.
// lib/describe.js synopsisText() holds that order and puts the credit "MUBI: " in front of an Our Take; this module holds the first source.
//
// The MUBI cache is cache/mubi.json (Marco, 13/10/2026: it lives in the repository, which is private, and the text is published with the credit; it was
// .context/mubi/mubi.json, outside Git, until then). It is written by scripts/collect-mubi.py, 100 requests a run: by hand, and since 14/10/2026 every night by scripts/mubi-nightly.js (field allowlist: lib/mubi-cache.js). build.js reads <cache dir>/mubi.json
// by default; `--mubi-cache <file>` or `MUBI_CACHE=<file>` name another file instead (an override). Without a file every function here answers "no Our Take"
// and the description falls through to the next source.
//
// The file is read with the same reader as the local Letterboxd MCP (tools/letterboxd-mcp/src/mubi.js), which validates each record alone.

const takes = new Map(); // IMDb id (tt…) → Our Take text

/** Reads the cache at `file`. → { available: true, takes, records, updatedAt } or { available: false, reason }. Replaces what was loaded before. */
function useMubi(file) {
  takes.clear();
  const { loadMubi } = require("../tools/letterboxd-mcp/src/mubi");
  const got = loadMubi(file);
  if (!got.available) return { available: false, reason: got.reason };
  for (const [tt, rec] of got.byId) {
    const take = rec.status === "confirmed" && rec.ourTake && rec.ourTake.state === "available" && typeof rec.ourTake.text === "string" ? rec.ourTake.text.trim() : "";
    if (take) takes.set(tt, take);
  }
  return { available: true, takes: takes.size, records: got.records, updatedAt: got.updatedAt };
}

/** Sets the Our Takes directly (tests): a Map or an object, IMDb id → text. */
function setTakes(entries) {
  takes.clear();
  for (const [tt, text] of entries instanceof Map ? entries : Object.entries(entries || {})) if (typeof text === "string" && text.trim()) takes.set(tt, text.trim());
}

const clear = () => takes.clear();
const ourTake = (tt) => (tt ? takes.get(tt) : undefined);

module.exports = { useMubi, setTakes, clear, ourTake };
