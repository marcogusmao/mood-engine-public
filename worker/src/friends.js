// The friends' view (Marco, 29/10/2026, questionnaire): /u/<friend>/ serves the same index as Marco's with two swaps. "Seen" is what the FRIEND has seen, and the Watchlist row is the FRIEND's watchlist. Everything else is
// Marco's, as it is at the public address: the taste, the lists, the Board's order, the friends of Marco. The decision and its limits are in worker/README.md ("The friends' view").
//
//   GET /u/<friend>/manifest.json         the public manifest under its own id and name (manifest.js), the same catalogs
//   GET /u/<friend>/catalog/…             the public catalogs; "seen" is the friend's, the Watchlist row is the friend's piece
//   GET /u/<friend>/subtitles/…           the public subtitles (the official list; never the private address's)
//   GET /u/<friend>/                      the install page
//   anything else under /u/<friend>/ (/p/, /k/, /page/, /subfile/, /meta/) is a 404; the film page /page/ is shared and stays at its own address
//
// <friend> is the name in config.json "friends", lower case. The seven addresses are FRIEND_SLUGS below, a closed list like people.js's registry of owners: any other address is a 404 before a single file is read (the
// contract of test/people.test.js "unknown owners return 404 before secrets or sources"), and a test compares the list with config.json. The index then says WHERE each one is: `friends.people`, in the order the masks use;
// a name in the list that the index does not have is a 404 too. A new friend is one more line here (and a Worker publication) next to the line in config.json. The segment `friend-a` is Will's own entry (people.js), never a friend.
//
// How the swaps are read (the build writes them, lib/friend-view.js and lib/index-rows.js):
//   seen       bit i of the film's `seenMask` (i = the friend's place in friends.people), instead of bit 1 of its flags, which is Marco's
//   Watchlist  index-v2-row-watchlist-<friend>.json, never Marco's index-v2-row-watchlist.json and never the whole index (its `watchlist` row is Marco's): a missing piece is an empty page, not his list
// An index with no masks (a file from before 29/10/2026) cannot serve a friend: the answer is a 503, never the films with nothing seen.

export const SLUG = /^[a-z0-9]{1,32}$/;
const RESERVED = new Set(["friend-a"]);
/** The friends of config.json, as addresses, in the config's order (test/friend-view.test.js compares them with config.json and with lib/friend-view.js). */
export const FRIEND_SLUGS = Object.freeze(["william", "friend-b", "gustavo", "friend-d", "friend-e", "francesca", "friend-g"]);
const KNOWN = new Set(FRIEND_SLUGS);
/** A friend's name → the address segment. lib/friend-view.js slugOf is the same function (test/friend-view.test.js compares them). */
export const slugOf = (name) => String(name).toLowerCase();
/** The Board row whose films are the friend's own. */
export const WATCHLIST_ROW = "watchlist";
/** The part of the row's file name after "index-v2-row-". */
export const pieceId = (slug) => `${WATCHLIST_ROW}-${slug}`;

/** Is this segment one of the seven addresses? (Whether the index lists the friend is `friendOf`.) Exactly spelled: no case folding, no decoding. */
export const isFriendSlug = (s) => typeof s === "string" && SLUG.test(s) && !RESERVED.has(s) && KNOWN.has(s);

/**
 * The friend `slug` in this index: { slug, name, bit, seen } or null. `bit` is the friend's place in friends.people, `seen(film)` the friend's "seen". Two names that give the same address are not told apart
 * (the build refuses them); the first wins.
 */
export function friendOf(index, slug) {
  const people = (index && index.friends && index.friends.people) || [];
  const bit = people.findIndex((n) => slugOf(n) === slug);
  if (!isFriendSlug(slug) || bit < 0 || bit >= 31) return null;
  const mask = 1 << bit;
  return { slug, name: people[bit], bit, seen: (e) => (e.seenMask & mask) !== 0 };
}

/** Thrown when a file has no masks or does not list the requested friend. The handler turns it into a 503. */
export class NoMasks extends Error {}
