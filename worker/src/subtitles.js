// Subtitles: the official OpenSubtitles addon's list, re-ordered by how well each subtitle fits the file that is playing.
//
// Stremio asks `/subtitles/{type}/{id}/{extras}.json` with the extras videoHash, videoSize and filename of the stream the person opened.
// The official addon (opensubtitles-v3.strem.io) ignores the hash and returns up to 100 subtitles in an order of its own. Here each one is
// put in one of three tiers and the list is sorted by tier:
//
//   2  exact         OpenSubtitles says the subtitle was made for a file with THIS hash (REST `moviehash_match`; needs the API key). It is matched to the
//                    official list by the subtitle's id only: REST `legacy_subtitle_id` is the official list's `id`. (REST `files[].file_id` is NOT the
//                    number the official download address ends with — measured on Paterson, they never agree — so it is not used: a number that
//                    agrees by accident would mark an unrelated subtitle as exact.)
//   1  same release  the subtitle's release group is the file's, or it is the same source (BluRay / WEB-DL / WEBRip / HDTV) at the same resolution
//   0  the others
//
// Which languages are offered depends on the film's original language (Marco, 10/10/2026: "original audio + English subtitle; Portuguese only for
// a film in Portuguese"): see languagesFor().
//
// Nothing here is fetched: the functions are pure, and test/subtitles.test.js drives them with the real shape of the official list.

/** The languages offered, in the order they are listed. `codes` are the spellings seen in `lang` (lower case, "_" as "-"). What the answer says in `lang` is in OWN_NAMES, below. */
export const LANGUAGES = [
  { key: "eng", name: "English", short: "English", codes: ["eng", "en"] },
  { key: "pob", name: "Português (BR)", short: "PT-BR", codes: ["pob", "pt-br", "ptbr"] },
  { key: "por", name: "Português (PT)", short: "PT-PT", codes: ["por", "pt-pt", "pt", "ptpt"] },
];
// `short` is what the label uses: the Stremio Desktop selector shows about 18 characters of a label before cutting it
// (13/10/2026 print). Short language names leave room for the alternative number and match mark.
export const PER_LANGUAGE = 15;
export const ID_PREFIX = "moodsubs-";
export const TIER = { OTHER: 0, RELEASE: 1, EXACT: 2 };

const KEYS = LANGUAGES.map((l) => l.key);
const BY_KEY = new Map(LANGUAGES.map((l) => [l.key, l]));
const BY_CODE = new Map(LANGUAGES.flatMap((l) => l.codes.map((c) => [c, l])));
export const languageOf = (lang) => BY_CODE.get(String(lang || "").toLowerCase().replace(/_/g, "-")) || null;

// ── the film's language decides which languages are offered ──────────────────

/**
 * The original language of a film as the index writes it (ISO 639-1, "pt", "sv"), or null when it is not known: nothing, a blank, or "xx",
 * which TMDB uses for "no spoken language" (silent films, music): a code that is not a language cannot say which subtitle fits.
 */
export function knownLanguage(code) {
  const c = String(code ?? "").trim().toLowerCase();
  return c && c !== "xx" ? c : null;
}

/**
 * The languages to list, in order (Marco, 10/10/2026: original audio + English subtitle; Portuguese only for a film in Portuguese).
 *   film in Portuguese ("pt")        Português (BR), Português (PT), English
 *   film in any other known language English only; when the official list has no English for it, the Portuguese ones (better than nothing)
 *   language not known                English, Português (BR), Português (PT): the order before this rule
 * `filmLanguage`: "pt", or anything else for "another real language" (the Worker passes "other": film-languages.js only knows Portuguese or not), or nothing.
 * `available`: the keys (eng, pob, por) of the languages the official list has at least one usable subtitle in; only the fallback reads it.
 */
export function languagesFor(filmLanguage, available = new Set(KEYS)) {
  const code = knownLanguage(filmLanguage);
  const pick = (keys) => keys.map((k) => BY_KEY.get(k));
  if (code === null) return [...LANGUAGES];
  if (code === "pt") return pick(["pob", "por", "eng"]);
  return available.has("eng") ? pick(["eng"]) : pick(["pob", "por"]);
}

// ── the file ─────────────────────────────────────────────────────────────────

const EXTENSION = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|m2ts|srt|ass|ssa|sub|vtt)$/i;
/** What a release name has that is not a group: a resolution, a source, a codec, an audio format, a flag. */
const NOT_A_GROUP = /^(?:\d{3,4}[pi]|4k|uhd|hdr\d*|dv|x26[45]|h26[45]|hevc|avc|aac\d*|ac3|eac3|dts|dtshd|ddp?\d*|dd\d*|atmos|truehd|flac|bluray|blu|ray|bdrip|brrip|webrip|web|dl|rip|hdtv|pdtv|dvdrip|dvd|remux|proper|repack|extended|unrated|imax|multi|dual|subs?|10bit|8bit|mkv|mp4|avi|hd|sd|\d+(?:\.\d+)?)$/i;

/** The release group of a file or release name: `-GROUP` at the end, or the last `[GROUP]` that is neither a quality tag nor a CRC (anime puts the group first and the 8-hex CRC last). null when there is none. */
export function groupOf(name) {
  const base = String(name || "").trim().replace(EXTENSION, "");
  if (!base) return null;
  const bracketed = [...base.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim()).filter((t) => t && !NOT_A_GROUP.test(t) && !/^[0-9a-f]{8}$/i.test(t));
  if (bracketed.length) return bracketed[bracketed.length - 1];
  const suffix = base.match(/-([A-Za-z0-9]+)$/);
  return suffix && !NOT_A_GROUP.test(suffix[1]) ? suffix[1] : null;
}

/** "bluray" | "web-dl" | "webrip" | "hdtv" | null, from a release name or a source tag. */
export function sourceOf(text) {
  const t = ` ${String(text || "").toLowerCase().replace(/[._\-[\]()]+/g, " ")} `;
  if (/ (?:blu ?ray|bd ?rip|br ?rip|bd ?remux|remux) /.test(t)) return "bluray";
  if (/ web ?dl /.test(t)) return "web-dl";
  if (/ web ?rip /.test(t)) return "webrip";
  if (/ (?:hdtv|pdtv) /.test(t)) return "hdtv";
  return null;
}

/** "2160p" | "1080p" | "720p" | "576p" | "480p" | null. 4K and UHD are 2160p. */
export function resolutionOf(text) {
  const t = String(text || "").toLowerCase();
  const m = t.match(/(?:^|[^0-9a-z])(2160|1080|720|576|480)p(?![a-z])/);
  if (m) return `${m[1]}p`;
  return /(?:^|[^0-9a-z])(?:4k|uhd)(?![a-z0-9])/.test(t) ? "2160p" : null;
}

/** What is known about the file that is playing: { filename, group, source, resolution }. */
export function describeFile(filename) {
  return { filename: filename || null, group: groupOf(filename), source: sourceOf(filename), resolution: resolutionOf(filename) };
}

// ── one subtitle ─────────────────────────────────────────────────────────────

const releaseNameOf = (s) => s.movieReleaseName || s.subtitleFileName || "";

/** 2 exact, 1 same release, 0 other. `exactIds`: Set of strings (REST legacy_subtitle_id of the subtitles whose moviehash_match is true). */
export function tierOf(sub, file, exactIds = new Set()) {
  if (exactIds.size && exactIds.has(String(sub.id))) return TIER.EXACT;
  const subGroup = sub.releaseGroup || groupOf(sub.movieReleaseName) || groupOf(sub.subtitleFileName);
  if (file.group && subGroup && file.group.toLowerCase() === String(subGroup).toLowerCase()) return TIER.RELEASE;
  const name = releaseNameOf(sub);
  const source = sourceOf(sub.releaseFormat) || sourceOf(name);
  if (file.source && file.resolution && source === file.source && resolutionOf(name) === file.resolution) return TIER.RELEASE;
  return TIER.OTHER;
}

const MARK = { [TIER.EXACT]: "✓", [TIER.RELEASE]: "≈", [TIER.OTHER]: "" };
const SOURCE_LABEL = { bluray: "BluRay", "web-dl": "WEB-DL", webrip: "WEBRip", hdtv: "HDTV" };
const textOf = (value) => typeof value === "string" ? value : "";
// Provider text belongs on one line. Drop controls that can reorder the prefix; cap by code points.
const groupLabel = (value) => {
  const chars = [...textOf(value).replace(/\s+/gu, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").trim()];
  return chars.length > 24 ? `${chars.slice(0, 23).join("")}…` : chars.join("");
};

/** Display-only details; the matching rules above stay independent of this shorter text. */
function releaseDetails(sub) {
  const release = textOf(sub.movieReleaseName).trim();
  const filename = textOf(sub.subtitleFileName).trim();
  const format = textOf(sub.releaseFormat);
  const source = SOURCE_LABEL[sourceOf(format) || sourceOf(release) || sourceOf(filename)]
    || (/\bdvd[ ._-]?rip\b/i.test(`${format} ${release} ${filename}`) ? "DVDRip" : /\bdvd\b/i.test(`${format} ${release} ${filename}`) ? "DVD" : "");
  const group = groupLabel(sub.releaseGroup) || groupLabel(groupOf(release)) || groupLabel(groupOf(filename));
  return [source, group].filter(Boolean);
}

/**
 * Marco, 30/10/2026: language + alternative number first, then the existing match mark and source/group.
 * Example: "English 2 ✓ · BluRay · AMIABLE". The number is the final position within that language,
 * after filtering, deduplication and sorting; it is not a subtitle identity or a synchronization score.
 * With no metadata, "English 2" still distinguishes the choice. No film title consumes the prefix.
 * Clients that discard `label` still need device validation; this cannot replace their provider name.
 */
export function labelOf(language, tier, sub, ordinal = 1) {
  const prefix = `${language.short || language.name} ${ordinal}${MARK[tier] ? ` ${MARK[tier]}` : ""}`;
  return [prefix, ...releaseDetails(sub)].join(" · ");
}

/**
 * The answer: only English and Portuguese, in the order languagesFor(filmLanguage) gives, each language's subtitles exact first, then same
 * release, then the rest (the official order inside a tier), at most 15 a language, ids prefixed `moodsubs-`. `lang` is, HERE, the official addon's own
 * code (eng, por, pob) as the source spelled it; what the Worker answers is ownLanguageNames(shape(…), true), where `lang` is the language's own name, for every app
 * (Marco, 14/11/2026; OWN_LANGUAGE_NAMES and OWN_NAMES_USER_AGENT, below). The tier goes in `label`.
 * subs: the official list. file: describeFile(). exactIds: Set of strings. filmLanguage: the film's original language, or nothing when unknown.
 */
export function shape(subs, file, exactIds = new Set(), { perLanguage = PER_LANGUAGE, filmLanguage = null } = {}) {
  const candidates = new Map();
  for (const language of LANGUAGES) {
    const seen = new Set();
    const mine = [];
    (Array.isArray(subs) ? subs : []).forEach((sub, order) => {
      if (!sub || !sub.url || sub.id == null || languageOf(sub.lang) !== language || seen.has(String(sub.id))) return;
      seen.add(String(sub.id));
      mine.push({ sub, order, tier: tierOf(sub, file, exactIds) });
    });
    mine.sort((a, b) => b.tier - a.tier || a.order - b.order);
    candidates.set(language, mine);
  }
  const available = new Set(LANGUAGES.filter((l) => candidates.get(l).length).map((l) => l.key));
  const out = [];
  for (const language of languagesFor(filmLanguage, available)) {
    for (const [index, { sub, tier }] of candidates.get(language).slice(0, perLanguage).entries()) out.push({ id: `${ID_PREFIX}${sub.id}`, url: sub.url, lang: sub.lang, label: labelOf(language, tier, sub, index + 1) });
  }
  return out;
}

// ── the language name the answer carries ─────────────────────────────────────

/**
 * THE SWITCH (Marco, 14/11/2026). true: every subtitle this Worker answers says, in `lang`, a language NAME of this addon's own ("English · Mood") and not the language's code ("eng"),
 * for the apps OWN_NAMES_USER_AGENT (below) lets in, which today is every app. false: nobody gets a name; `lang` is the official addon's code, exactly as before 14/11/2026.
 * Either way nothing else changes: ids, addresses, order and labels are the same.
 *
 * Why. On Marco's Samsung TV the subtitles inside the file are in the list, but Stremio starts with one of this addon's. An app that picks a subtitle by itself looks for the
 * language CODE it prefers; with a name that is no code these rows are expected not to match, so that the choice falls on the file's own subtitle and these stay in the list to be
 * picked by hand. A member of the Stremio organisation says as much of such a `lang` (stremio-features#1551, 21/01/2026): "your subtitles won't be able to be properly selected
 * automatically with the preferred languages settings". Here that is the purpose.
 *
 * THE COST Marco accepted, in two parts, for EVERY app (his answer of 14/11/2026, below):
 *   · a film whose file has NO subtitle of its own no longer gets one chosen by itself, on any app; it has to be picked in the list;
 *   · on Stremio for Android TV (his TCL) the NAME of the language may show as a blank or as "Unknown" in the list (reported by other people, not verified on his TV), and there
 *     `label` is not shown either, so the list may not tell English from Portuguese.
 * THE WAY BACK: OWN_NAMES_USER_AGENT (the names for one kind of app only) or this switch (the names for nobody). Each is a change of one word and a publication.
 *
 * What the apps do with a `lang` that is no code (code and issues read on 14/11/2026; run on no device; EXPECTED, NOT VERIFIED):
 *   stremio-web 9d1d526 (the Mac, the browser): the automatic choice takes the first track whose `lang`, trimmed, is exactly a 2-letter code, one of the 3-letter codes or the IETF tag of its
 *     table (useSubtitles.ts normalizeLanguage → languages.find, nodejs-langs e5a3af7), else the same lower-cased; "English · Mood" is none, so it is never chosen by itself. The menu groups by the
 *     text of `lang` and shows a text it does not know as it is (SubtitlesMenu.js, languages.label): one entry "English · Mood", sorted right after "English".
 *   Samsung (Tizen): closed code. NOT VERIFIED that it behaves as stremio-web; the proof is Marco opening a film on the TV after the publication.
 *   Stremio for Android TV (the TCL): closed code. stremio-features#1551 (opened 08/12/2025): a `lang` that is no code was shown as "und"; comments there: "unknown" until Android TV
 *     1.9.2, an empty space in 1.9.2 (04/02/2026) and in 1.9.5 (17/02/2026; the "undefined" of that comment is Android MOBILE). stremio-core#936 (comment of 18/09/2026, Android TV): a
 *     free-text `lang` is "dropped from the display" and the row shows the addon's name. On that app `label` is not shown either (stremio repository,
 *     docs/research/2026-10-12-legendas-clientes.md).
 *   Nuvio, Fusion: not read for this.
 * The names: the language as a person reads it, then " · Mood" (whose subtitle it is). No part of a name is a word of 2 or 3 letters ("PT-BR · Mood" would hold "PT", which an app that
 * splits the text could read as a code), and the separator is not a hyphen (an IETF tag is `xx-YY`). Two spellings of one language ("eng", "en") get the SAME name, so they are one group.
 */
export const OWN_LANGUAGE_NAMES = true;
/**
 * WHICH APP gets the names. null: EVERY app, whatever its `User-Agent`, and a request with none (Marco, 14/11/2026, ~23:05 UTC, questionnaire: "All devices, as first approved").
 * A regular expression instead: only a request whose `User-Agent` matches it gets the names, every other gets the codes, and the answer then says `Vary: User-Agent` by itself
 * (variesByUserAgent, below; handler.js). TO RESTRICT THE NAMES TO ONE KIND OF APP AGAIN, put the expression here: /Tizen/ is the Samsung TV.
 *
 * How it got here, all on 14/11/2026: Marco approved the fix as proposed, for every app; the first version did that (93ed5c7); the review showed the cost on Android TV, and the main
 * session, not Marco, restricted the names to the Samsung with /Tizen/ here (0ec6c75); asked whether to keep that restriction, with the risk on the TCL written in the option, Marco
 * answered "All devices, as first approved", and this constant went to null.
 * About /Tizen/, should it come back: measured on 14/11/2026 in AIOStreams, the Stremio app on Marco's Samsung UN75RU7100 asks for STREAMS as "…SMART-TV; LINUX; Tizen 5.0…" (the TCL is
 * Android, the Mac has no "Tizen"); that it sends the same with its SUBTITLES request to this Worker is inferred, not measured; any User-Agent holding that text gets the names, a
 * made-up one included, and only that spelling ("tizen", "TIZEN" would get the codes); it would decide a display name and guard nothing.
 */
export const OWN_NAMES_USER_AGENT = null;
/** What `lang` says for each language (by its key). */
export const OWN_NAMES = { eng: "English · Mood", pob: "Português (Brasil) · Mood", por: "Português (Portugal) · Mood" };

/** Does the request with this `User-Agent` get the names? Nobody with the switch off; with it on, everybody when the criterion is null, else only a text the criterion matches. */
export function wantsOwnNames(userAgent, enabled = OWN_LANGUAGE_NAMES, device = OWN_NAMES_USER_AGENT) {
  if (!enabled) return false;
  if (device === null) return true;
  return typeof userAgent === "string" && device.test(userAgent);
}
/** Does the answer depend on the request's `User-Agent`? Only when the criterion is an expression: then it has to say `Vary: User-Agent`. With null every app gets the same body. */
export const variesByUserAgent = (device = OWN_NAMES_USER_AGENT) => device !== null;

/** The rows of shape() as the Worker answers them. `on` (wantsOwnNames of the request): `lang` is the language's own name, every other field and the order untouched. Otherwise the same rows, as they came. */
export function ownLanguageNames(rows, on = false) {
  if (!on) return rows;
  return rows.map((row) => { const language = languageOf(row.lang); return language ? { ...row, lang: OWN_NAMES[language.key] } : row; });
}

// ── the request ──────────────────────────────────────────────────────────────

/** `/subtitles/movie/tt5247022/videoHash=…&filename=….json` → { type, id, extras } (the id of an episode is tt0944947:1:1). null when it is not a subtitles request. */
export function parseSubtitlesPath(pathname, parseExtras, decode) {
  const parts = String(pathname).split("/").filter(Boolean);
  if (parts[0] !== "subtitles" || parts.length < 3 || parts.length > 4) return null;
  const last = parts[parts.length - 1];
  if (!last.endsWith(".json")) return null;
  parts[parts.length - 1] = last.slice(0, -".json".length);
  return { type: decode(parts[1]), id: decode(parts[2]), extras: parseExtras(parts[3] ?? "") };
}

export const VALID_HASH = /^[0-9a-f]{16}$/i;
export const VALID_ID = /^tt\d+(?::\d+:\d+)?$/;
