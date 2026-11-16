// The lists' display names, who vouches for each, and what each is about (Marco, 11/10/2026: decisions 3, 4 and 11 of the stremio
// repo's docs/2026-10-11-perfis-e-categorias.md). Read by the profiles' two menus, Who vouches and What it is (profiles.js).
//
// The table is not typed here. data/list-names.source.json is the stremio repo's docs/2026-10-11-nomes-listas.json at d95cc7a for its
// first 139 rows, byte for byte (sha256 0312bd96… of those rows; test/profiles.test.js pins them), and eight rows that Marco added on
// 23/10/2026 (the five TSPDT lists, then the three of cinematography; the same test pins their group, theme and name);
// data/list-names.final.json holds the names after Marco's review request
// ("make each name that needs it better", 11/10/2026), id → name. A list keeps its id, address and trust: only the name on screen changes,
// and the index (and so the old address /manifest.json) keeps the current label.

import SOURCE from "../../data/list-names.source.json" with { type: "json" };
import FINAL from "../../data/list-names.final.json" with { type: "json" };
import { cmp } from "./text.js";

/** Who vouches, in menu order (decision 3). */
export const GROUPS = ["Critics", "Institutions", "Directors", "Letterboxd & community"];

/** "—" in the table: the list has no theme and is only in Who vouches (decision 11). */
const NO_THEME = "—";

/** [{ id, name, group, themes: [..], description, trust }], in the table's order. */
export const LIST_NAMES = SOURCE.map((r) => ({
  id: r.id,
  name: FINAL[r.id] ?? r.nome_novo,
  group: r.quem,
  themes: [r.tema, r.tema2].filter((t) => t && t !== NO_THEME),
  description: r.descricao,
  trust: r.trust,
}));

/** Text and numbers apart: "Under 90 min" → ["under ", "90", " min"], so 90 comes before 100 inside a name. */
const parts = (s) => s.toLowerCase().match(/\d+|\D+/g) || [];
const natural = (a, b) => {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const nx = /^\d/.test(x[i]), ny = /^\d/.test(y[i]);
    const c = nx && ny && i > 0 ? Number(x[i]) - Number(y[i]) : cmp(x[i], y[i]); // a leading number (1980s, 21st century, 1,000) keeps text order, which reads as a timeline
    if (c) return c;
  }
  return x.length - y.length;
};
/**
 * A to Z the way a person reads a menu, without Intl (a cold isolate pays ~10 ms to start a collator; text.js cmp): what the list is
 * before who vouches ("1970s sensations · Criterion" before "1970s sensations II · Criterion"), numbers by value ("Under 90 min" before
 * "Under 100 min"; a leading number in text order, so "1980s", "2000s", "21st century" read as a timeline), case ignored.
 */
export const byName = (a, b) => {
  const [wa, ...ra] = a.split(" · "), [wb, ...rb] = b.split(" · ");
  return natural(wa, wb) || natural(ra.join(" · "), rb.join(" · ")) || cmp(a, b);
};

/** Every theme, in menu order (byName): the eras come first and read as a timeline ("1970s", "1980s–90s", "21st century"), then A to Z. */
export const THEMES = [...new Set(LIST_NAMES.flatMap((l) => l.themes))].sort(byName);
