/**
 * A header value from text that is not ours, so printable ASCII only, trimmed, 64 characters at most. Anything else makes the Response constructor throw, and Cloudflare answers a bare 500
 * (13/10/2026, the release group in a file name sent by the player). Used for the two such headers: `X-Subtitles-File` (the release group read from the file name the player sent; handler.js, the subtitles answer) and `X-Build`
 * (from the GIT_SHA variable, W8 19/10/2026), the latter shared by the addon answers (handler.js) and the Will intake API (upload/api.js), so both send the same header for the same variable.
 */
export const headerText = (t) => String(t ?? "").replace(/[^\x20-\x7E]/g, "").trim().slice(0, 64);
