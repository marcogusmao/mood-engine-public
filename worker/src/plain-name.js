// Pure name normalization shared by cards and film-page chips. Cache strings only:
// no film, viewer, menu, origin or index result survives here. Callers keep their
// own coercion rules (meta treats null/undefined as empty; mood-group does not).
const MAX_NAMES = 512;
const MAX_CHARS = 256;
const names = new Map();

export function plainName(text) {
  const cached = names.get(text);
  if (cached !== undefined) return cached;
  const value = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  // Bound both entries and string sizes. Long inputs still receive the exact
  // transformation; they are not retained and cannot evict the short names.
  if (text.length <= MAX_CHARS && value.length <= MAX_CHARS) {
    if (names.size === MAX_NAMES) names.delete(names.keys().next().value);
    names.set(text, value);
  }
  return value;
}
