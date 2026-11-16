import { isFriendSlug } from "./friends.js";
// Public owners are a closed registry. A mood profile is a separate routing axis.
const WILL = Object.freeze({ id: "friend-a", name: "Will" });
export const PEOPLE = Object.freeze({ friend-a: WILL });

/** Resolve before private-token handling, without decoding an owner alias into a valid id.
 * null means an invalid owner path; person:null preserves the legacy address.
 */
export function resolvePerson(path, full) {
  // Split first, decode each segment alone (20/10/2026): "search=x%2Fu%2Fy.json" is ONE segment of Marco's search, not an owner marker, while "/%75/friend-a/" still is.
  const segments = path.split("/").map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const hasOwner = segments.includes("u");
  if (!hasOwner) return { person: null, path, base: "", full };
  if (!path.startsWith("/u/") || segments.includes("k")) return null;
  const parts = path.split("/");
  if (segments.filter((s) => s === "u").length !== 1) return null;
  // A friend of Marco's (29/10/2026, worker/src/friends.js): one of the seven addresses of its closed list, spelled exactly (no decoding: "/u/wil%6Ciam/" is not "/u/william/"); any other is null, a 404 before anything is read. Whether the index has that friend is the handler's question.
  // Not a person: Marco's index with the friend's "seen" and watchlist. It has no revision, no release, and reads Marco's files.
  if (parts[2] !== WILL.id) return isFriendSlug(parts[2]) ? { person: null, friend: parts[2], path: "/" + parts.slice(3).join("/"), base: `/u/${parts[2]}`, full } : null;
  return { person: WILL, path: "/" + parts.slice(3).join("/"), base: `/u/${WILL.id}`, full: new URL(`../u/${WILL.id}/data/index.json`, full).href };
}

/** Only an acknowledged release may supply Will's indices. No mutable path or root fallback. */
export function releaseIndex(full, revision) {
  if (!/^r-[0-9a-f]{32}$/.test(revision || '')) throw new Error('invalid public revision');
  return new URL(`../u/friend-a/r/${revision}/data/index.json`, full).href;
}
