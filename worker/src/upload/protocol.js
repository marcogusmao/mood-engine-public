import contract from '../../../contracts/will-upload-v1.json' with { type: 'json' };
export const CONTRACT = contract;
export const LIMITS = Object.freeze(contract.constants);
export const PERSON = 'friend-a';
export const UUID = new RegExp(contract.patterns.uuid);
export const REVISION = new RegExp(contract.patterns.revision);
export class ApiError extends Error {
  constructor(status, code, retryable = false) { super(code); this.status = status; this.code = code; this.retryable = retryable; }
}
export const reject = (status, code, retryable = false) => { throw new ApiError(status, code, retryable); };
// Parse once, while checking keys at every depth. JSON.parse alone loses duplicate claims.
export function strictJson(text) {
  if (typeof text !== 'string') reject(400, 'INVALID_JSON');
  let i = 0, depth = 0;
  const ws = () => { while (/\s/.test(text[i] || '') && i < text.length) i++; };
  function str() {
    const start = i++;
    while (i < text.length) { const c = text[i++]; if (c === '\\') i++; else if (c === '"') return JSON.parse(text.slice(start, i)); }
    throw Error();
  }
  function val() {
    ws(); if (++depth > 64) throw Error();
    if (text[i] === '{') {
      i++; ws(); const keys = new Set();
      if (text[i] !== '}') while (true) {
        ws(); if (text[i] !== '"') throw Error(); const key = str(); if (keys.has(key)) throw Error(); keys.add(key);
        ws(); if (text[i++] !== ':') throw Error(); val(); ws(); if (text[i] !== ',') break; i++;
      }
      if (text[i++] !== '}') throw Error();
    } else if (text[i] === '[') {
      i++; ws(); if (text[i] !== ']') while (true) { val(); ws(); if (text[i] !== ',') break; i++; }
      if (text[i++] !== ']') throw Error();
    } else if (text[i] === '"') str();
    else { const m = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i)); if (!m) throw Error(); i += m[0].length; }
    depth--;
  }
  try { val(); ws(); if (i !== text.length) throw Error(); const result = JSON.parse(text); canonical(result); return result; } catch { reject(400, 'INVALID_JSON'); }
}
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  reject(400, 'INVALID_JSON');
}
function check(s, v) {
  if ('const' in s && v !== s.const) return false;
  if (s.enum && !s.enum.includes(v)) return false;
  if (!s.type) return true;
  if (s.type === 'object') return !!v && !Array.isArray(v) && typeof v === 'object' && s.required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => Object.hasOwn(s.properties, k) && check(s.properties[k], v[k]));
  if (s.type === 'array') return Array.isArray(v) && v.length >= s.minItems && v.length <= s.maxItems && v.every(x => check(s.items, x));
  if (s.type === 'integer') return Number.isSafeInteger(v) && v >= s.minimum && v <= s.maximum;
  if (typeof v !== s.type) return false;
  if (s.pattern && !new RegExp(s.pattern).test(v)) return false;
  if (s.format === 'utc-date-time') return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
  return true;
}
export function validate(name, value) {
  if (name === 'intake' && typeof value?.bytes === 'number' && value.bytes > LIMITS.archiveBytes) reject(413, 'ZIP_TOO_LARGE');
  if (name === 'snapshot' && typeof value?.bytes === 'number' && value.bytes > LIMITS.snapshotBytes) reject(413, 'SNAPSHOT_TOO_LARGE');
  if (!CONTRACT.schemas[name] || !check(CONTRACT.schemas[name], value)) reject(400, 'INVALID_SCHEMA');
  if (name === 'intake' || name === 'snapshot') {
    if (value.chunks.length !== Math.ceil(value.bytes / LIMITS.chunkBytes) || value.chunks.some((c, n) => c.ordinal !== n || c.bytes !== Math.min(LIMITS.chunkBytes, value.bytes - n * LIMITS.chunkBytes))) reject(400, 'INVALID_CHUNKS');
  }
  return value;
}
export async function digest(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes)), b => b.toString(16).padStart(2, '0')).join(''); }
export async function boundedBytes(request, max, { allowEncoding = false } = {}) {
  if (!allowEncoding && request.headers.get('content-encoding')) reject(415, 'CONTENT_ENCODING');
  const len = request.headers.get('content-length');
  if (len && (!/^\d+$/.test(len) || Number(len) > max)) reject(413, 'BODY_TOO_LARGE');
  const parts = []; let size = 0; const reader = request.body?.getReader();
  if (reader) try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > max) { await reader.cancel(); reject(413, 'BODY_TOO_LARGE'); } parts.push(value); } } finally { reader.releaseLock(); }
  const out = new Uint8Array(size); let pos = 0; for (const p of parts) { out.set(p, pos); pos += p.byteLength; } return out;
}
export async function jsonBody(request, schema) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') reject(415, 'CONTENT_TYPE');
  const bytes = await boundedBytes(request, schema === 'snapshot' ? LIMITS.manifestBytes : LIMITS.jsonBytes);
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { reject(400, 'INVALID_JSON'); }
  return validate(schema, strictJson(text));
}
export const identity = (extra = {}) => ({ schemaVersion: 1, personId: PERSON, ...extra });
export const nextScheduled = now => { const d = new Date(now); d.setUTCHours(9, 10, 0, 0); if (+d <= now) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString(); };
