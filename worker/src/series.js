// The "My series" row (Marco, 11/10/2026: approved "a new row 'My series' on the Stremio home screen, made by Mood Engine").
// A fixed list, bundled with the Worker: nothing here is fetched, and the index plays no part in it. The list is in series-list.js (85 titles in five types: four on 20/10/2026, the fourth split in two on 21/10/2026); to change it, edit that file and deploy again.
// Marco, 20/10/2026: a bigger fixed list whose FRONT rotates every week. `rotate()` below is the whole rule: pure, no state, no storage, no clock of its own, so every isolate and every device sees the same order in the same week.
// The descriptions give the reason in words and carry no star rating: this file is public (Marco, 11/10/2026).

import { SERIES_LIST, SERIES_TYPES, TYPE_LABELS } from "./series-list.js";

export { SERIES_LIST, SERIES_TYPES, TYPE_LABELS };
export const SERIES_CATALOG_ID = "my-series";
export const SERIES_CATALOG_NAME = "📺 My series to watch";

/** How many titles of each type go to the front every week (the front is FRONT_PER_TYPE × SERIES_TYPES.length = 2 × 5 = 10 titles since 21/10/2026; it was 2 × 4 = 8). */
export const FRONT_PER_TYPE = 2;

// The week turns on Monday at 00:00 in Brasília, which is UTC−3 all year (Brazil has had no daylight saving since 2019; if it came back, this constant is the one line to change).
const BRASILIA_OFFSET_MS = -3 * 3600e3;
const DAY_MS = 86400e3;
const WEEK_MS = 7 * DAY_MS;
const FIRST_MONDAY_MS = 4 * DAY_MS; // 1970-01-05 00:00, the first Monday after the epoch: week 0
const STEP = 0x9e3779b1; // how far the rest of the list slides on its hash circle each week (a golden-ratio step: consecutive weeks land far apart)

/** FNV-1a, 32 bits, of a string: the same number in every runtime. */
function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * The week of a moment, in Brasília: `index` counts Monday-to-Monday weeks from 1970-01-05 (it never jumps at New Year, which is what the rotation uses), and `year`/`week` are the ISO 8601
 * name of the same week (the week belongs to the year of its Thursday), for logs and for people. `now` is a Date or milliseconds; the instant is UTC.
 */
export function weekOf(now) {
  const local = new Date(now).getTime() + BRASILIA_OFFSET_MS; // read the UTC fields of this number as the clock on the wall in Brasília
  const index = Math.floor((local - FIRST_MONDAY_MS) / WEEK_MS);
  const thursday = new Date(FIRST_MONDAY_MS + index * WEEK_MS + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const dayOfYear = Math.round((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS); // 0-based
  return { index, year, week: Math.floor(dayOfYear / 7) + 1 };
}

/**
 * The list in the order of this week (Marco, 20/10/2026). Nothing is added or dropped: the same titles, a different order.
 *   1. Each type has a fixed ring: its titles by `order`, then by id. The front takes `perType` titles of each type from a window on its ring that moves `perType` places forward every week and wraps
 *      around the end, so the windows of consecutive weeks tile the ring and every title is in the front once every ceil(ring / perType) weeks (at most 14 weeks with today's list; the small rings, animation 11 and documentary 7, go round sooner and so show the same titles again sooner).
 *   2. Positions 1 to 5 are the first title of each window, one per type in the order of SERIES_TYPES (sitcom, drama, arthouse, animation, documentary); positions 6 to 10 the second of each, and so on.
 *   3. The rest follows, ordered on a circle of 32-bit hashes of the ids that turns by a fixed step every week: still deterministic, different every week, and independent of where a title sits in the array.
 * The week is the Brasília one (weekOf). The 25 old titles are in the rings like any other. Unknown types go to the rest. `list` is not changed.
 */
export function rotate(list, now, { perType = FRONT_PER_TYPE } = {}) {
  const { index: week } = weekOf(now);
  const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const rings = SERIES_TYPES.map((type) => list.filter((s) => s.type === type).sort(byOrder));
  const windows = rings.map((ring) => {
    if (!ring.length) return [];
    const size = Math.min(perType, ring.length);
    const start = (((week * perType) % ring.length) + ring.length) % ring.length;
    return Array.from({ length: size }, (_, j) => ring[(start + j) % ring.length]);
  });
  const front = [];
  for (let j = 0; j < perType; j++) for (const w of windows) if (j < w.length) front.push(w[j]);
  const taken = new Set(front);
  const slide = (week * STEP) >>> 0;
  const key = (s) => (hash32(s.id) + slide) >>> 0;
  const rest = list.filter((s) => !taken.has(s)).sort((a, b) => key(a) - key(b) || (a.id < b.id ? -1 : 1));
  return [...front, ...rest];
}

/** One series as Stremio wants it. The cover is the same poster service the films fall back to (src/meta.js). A title with no reason of its own says its type and year. */
export function toSeriesMeta(s) {
  const meta = { id: s.id, type: "series", name: s.name, poster: `https://images.metahub.space/poster/medium/${s.id}/img`, posterShape: "poster", releaseInfo: String(s.year) };
  const description = s.description || (TYPE_LABELS[s.type] ? `${TYPE_LABELS[s.type]} · ${s.year}` : "");
  if (description) meta.description = description;
  return meta;
}
