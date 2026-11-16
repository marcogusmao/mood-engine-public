// Reads what Stremio puts in the address of a catalog request.
//
//   /catalog/movie/<id>.json
//   /catalog/movie/<id>/<extras>.json          extras = k=v&k=v, URL-encoded, in ANY order
//
// Order matters nowhere: stremio-core's extend_one puts the extra that was just changed in FRONT of the others
// (src/types/addon/request.rs:26-53), so the same screen can ask for `decade=1990s&genre=Nocturnal` or
// `genre=Nocturnal&decade=1990s` depending on which menu the person touched last.

import { words } from "./text.js";

/** "a+b%20c" → "a b c". A "+" is a space (form encoding); a literal plus arrives as %2B. Never throws on bad percent signs. */
export function decode(s) {
  const t = String(s).replace(/\+/g, " ");
  try {
    return decodeURIComponent(t);
  } catch {
    return t.replace(/%[0-9a-f]{2}/gi, (m) => {
      try { return decodeURIComponent(m); } catch { return m; }
    });
  }
}

/** "decade=1990s&genre=Night%20drive" → { decade: "1990s", genre: "Night drive" }. The first value of a repeated name wins. */
export function parseExtras(raw) {
  const out = {};
  const text = String(raw ?? "").replace(/^\?/, "");
  if (!text) return out;
  for (const piece of text.split("&")) {
    if (!piece) continue;
    const i = piece.indexOf("=");
    const name = decode(i < 0 ? piece : piece.slice(0, i)).trim();
    if (!name || name in out) continue;
    out[name] = i < 0 ? "" : decode(piece.slice(i + 1));
  }
  return out;
}

/**
 * "/catalog/movie/moods/genre=Nocturnal&decade=1990s.json" → { type: "movie", id: "moods", extras: { genre, decade } }
 * Anything that is not a catalog request → null.
 */
export function parseCatalogPath(pathname) {
  const parts = String(pathname).split("/").filter(Boolean);
  if (parts[0] !== "catalog" || parts.length < 3 || parts.length > 4) return null;
  const last = parts[parts.length - 1];
  if (!last.endsWith(".json")) return null;
  parts[parts.length - 1] = last.slice(0, -".json".length);
  return { type: decode(parts[1]), id: decode(parts[2]), extras: parseExtras(parts[3] ?? "") };
}

/** `skip` as a whole number of items already shown (0 when missing or nonsense). */
export function skipOf(extras) {
  const n = Number.parseInt(extras.skip, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The option a value stands for. Stremio sends back the label it was given, but the encoding can have changed a character on
 * the way ("+" for a space, "4.2+" read as "4.2 ", an en dash typed as a hyphen), so after the exact match comes a match on
 * the words alone. null when no option fits: the caller answers with an empty page, like a static host would for a missing file.
 */
export function matchOption(value, options) {
  const v = String(value ?? "");
  if (!v) return null;
  const exact = options.find((o) => o === v);
  if (exact !== undefined) return exact;
  const key = words(v);
  if (!key) return null;
  return options.find((o) => words(o) === key) ?? null;
}

/**
 * The list a Lists / Lists (unseen) request names (22/10/2026, Marco ~04:05 UTC). The menu shows each list's `short` (one line on the phone);
 * the index keeps `label`, the full name with its author, because every install made before still asks for it, and so do the Nuvio profiles
 * and Fusion until they are reinstalled. Either one reaches the same list. A build from before the short names has no `short`: then `label` is the menu.
 * undefined when the value is neither (the caller answers with an empty page, as for any unknown option).
 */
export function matchList(value, lists) {
  const options = lists.flatMap((l) => [l.short, l.label].filter((o) => typeof o === "string" && o));
  const hit = matchOption(value, options);
  return hit === null ? undefined : lists.find((l) => l.short === hit || l.label === hit);
}

/** What the Lists menus offer: each list's `short`, else its `label`. */
export const listMenu = (lists) => lists.map((l) => l.short || l.label);
