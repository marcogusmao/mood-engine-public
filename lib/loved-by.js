// "Loved by Lynch and Scorsese", "Loved by a friend 5★, Cacau 5★ +1 more": the ONE function that writes who loves a film, for the two families that say it (Marco, 21/10/2026, ~15:00 UTC, D2).
// The directors' line (lib/directors-loved.js lovedLine, up to three names) and the lead of line 2 of the friends' rows (lib/describe.js reasonLead, two names) both come through here, so the capital "L",
// the joiner and the "+N more" cannot differ between them again (until 21/10/2026 the directors said "Loved by … +3 more" and the friends "loved by …" with the "+N more" cut off).
// The same joiner writes the other leads of the reason rows (Marco, 21/10/2026, D1): "Watched this week by Bia 4.5★, Ana 4★ +3 more" (peopleLine with another prefix).
//
//   names  the people named on the line, already written the way they show ("a friend 5★", "Lynch", "Lanthimos (with Ariane Labed)")
//   more   how many more are not named (0: none)
//
// One name: "Loved by A". Two or more and nobody left over: "Loved by A, B and C". Somebody left over: "Loved by A, B +N more" (a comma, then the count: the " · " of the card is the separator of the GROUPS of a line).

/** @param {string} prefix "Loved by", "Watched this week by" @param {string[]} names @param {number} [more] */
function peopleLine(prefix, names, more = 0) {
  const list = (Array.isArray(names) ? names : []).map((n) => String(n == null ? "" : n).trim()).filter(Boolean);
  if (!list.length) return "";
  const extra = Math.max(0, Math.floor(Number(more) || 0));
  const who = extra > 0 ? `${list.join(", ")} +${extra} more` : list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : list[0];
  return `${prefix} ${who}`;
}

/** @param {string[]} names @param {number} [more] */
const lovedBy = (names, more = 0) => peopleLine("Loved by", names, more);

module.exports = { lovedBy, peopleLine };
