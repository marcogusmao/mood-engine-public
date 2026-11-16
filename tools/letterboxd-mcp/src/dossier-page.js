'use strict';
// Stateless continuation over an ordered query list. Hashes bind context, not authority:
// this is neither a signed cursor nor an authorization token. No queries or editorial data travel in it.
const { createHash } = require('node:crypto');
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const KEYS = ['version', 'offset', 'signature', 'hash'];

function dossierPage({ queries, view, maxChars, cursor, source, notes, result, scrub, InputError }) {
  const budget = maxChars === undefined ? 20000 : maxChars;
  const hash = digest([queries, view, budget]);
  // Hash the source signature so even an unusual source label cannot introduce paths into the cursor.
  const signature = digest(source.signature);
  const refuse = () => { throw new InputError('film_dossier: invalid or changed continuation context; restart the query with the same queries, view and maxChars'); };
  let offset = 0;
  if (cursor !== undefined) {
    if (!cursor || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) refuse();
    let data;
    try {
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.toString('base64url') !== cursor) refuse();
      data = JSON.parse(bytes.toString('utf8'));
    } catch { refuse(); }
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        Object.keys(data).length !== KEYS.length || !KEYS.every((key) => Object.hasOwn(data, key)) ||
        encode(data) !== cursor || data.version !== 1 || !Number.isInteger(data.offset) || data.offset < 1 || data.offset >= queries.length ||
        typeof data.signature !== 'string' || !/^[a-f0-9]{64}$/.test(data.signature) ||
        typeof data.hash !== 'string' || !/^[a-f0-9]{64}$/.test(data.hash) ||
        data.signature !== signature || data.hash !== hash) refuse();
    offset = data.offset;
  }
  const total = queries.length;
  const results = queries.slice(offset).map(result);
  const make = (shown) => scrub({ source, view: 'mubi', mubiNotes: notes, results: results.slice(0, shown), page: {
    total, offset, shown, remaining: total - offset - shown,
    nextCursor: offset + shown === total ? null : encode({ version: 1, offset: offset + shown, signature, hash }),
    maxChars: budget,
  } });
  // Test every prefix: the final null cursor can shrink a page, so an oversized
  // intermediate prefix does not prove that a longer, final prefix is too large.
  let best;
  for (let shown = 1; shown <= results.length; shown++) {
    const candidate = make(shown);
    if (JSON.stringify(candidate).length <= budget) best = candidate;
  }
  if (!best) {
    const minimum = JSON.stringify(make(1)).length;
    throw new InputError(`film_dossier: result at position ${offset} cannot fit maxChars ${budget}; minimum ${minimum} UTF-16 units for the first whole result and page metadata; raise maxChars up to 30000 or request an exact ID for an ambiguity`);
  }
  return best;
}
module.exports = { dossierPage };
