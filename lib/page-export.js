'use strict';
// Marco, 20/10/2026, final specification §9: synopsis only, no why/own rating.
const D = require('./describe');
const ID = /^tt\d{1,10}$/;
const YT = /^[A-Za-z0-9_-]{11}$/;
const shardOf = tt => tt.slice(2).slice(-2).padStart(2, '0');
// Bound only the page projection; legacy card/index bytes remain unchanged.
const bounded = (text, limit) => text.length <= limit ? text : text.slice(0, limit - 1).trimEnd() + '.';
function pageSynopsis(canonical, source) {
  if (!canonical) return '';
  if (source !== 'mubi') return bounded(canonical, 280);
  const body = canonical.replace(/^MUBI:\s*/, '').replace(/(?:\s*— MUBI)+$/, '').trim();
  return body ? bounded(D.synopsis(body, { maxChars: 273 }), 273) + ' — MUBI' : '';
}
// The one rule for "private text" in a page: an e-mail address, the private address marker "/k/" or the personal-reason phrase "you rate". Shared by the shard check (lib/page-validation.js), so the regex is the same on both sides and was not loosened.
const privateText = raw => (raw.includes('@') && /[\w.+-]{1,64}@[\w-]{1,63}\.[a-z]{2,63}/i.test(raw)) || /\/k\/|you rate\b/i.test(raw);
// Review 27/10/2026 (Baixo 6): a public synopsis that trips that rule ("a/k/a ...") used to make writePages refuse the whole family and the night fail. It now loses its `syn` alone; every other field, the name included, keeps the refusal.
const publicSynopsis = (canonical, source) => { const s = pageSynopsis(canonical, source); return privateText(s) ? '' : s; };
function pageShards(index, facts, stats = null) {
  if (!(facts instanceof Map)) throw Error('Page facts Map required');
  const shards = Array.from({ length: 100 }, (_, i) => ({ v: 1, builtAt: index.meta.builtAt, shard: String(i).padStart(2, '0'), people: [...index.friends.people], films: [] }));
  for (const e of [...index.films].sort((a, b) => a.tt < b.tt ? -1 : a.tt > b.tt ? 1 : 0)) {
    if (!ID.test(e.tt)) throw Error('Invalid page identity');
    const f = facts.get(e.tt); if (!f) throw Error('Missing page facts: ' + e.tt);
    const r = { t: e.tt, n: e.name };
    const put = (k, v) => { if (v != null && v !== '' && (!Array.isArray(v) || v.length)) r[k] = v; };
    for (const [k, col] of Object.entries({ y: 'year', rt: 'runtime', g: 'genres', im: 'imdbRating', lb: 'lbRating', sb: 'seenBy', fa: 'friendsAvg', wb: 'wantBy' })) put(k, e[col]);
    put('d', f.directors); put('c', f.cast); put('kw', f.keywords);
    put('mo', Object.entries(e.moods || {}).map(([id, v]) => [id, v[0]]));
    put('li', index.lists.filter(l => f.listIds.includes(l.id) && Object.hasOwn(e.lists || {}, l.id)).map(l => [l.id, e.lists[l.id]]));
    if (e.friends) {
      const s = (e.friends.seenBy || []).map(([n, v]) => [index.friends.people.indexOf(n), v]);
      const w = (e.friends.wantBy || []).map(n => index.friends.people.indexOf(n));
      if (s.length || w.length) r.fr = { s, w };
    }
    const syn = publicSynopsis(f.synopsis, f.synopsisSource);
    if (stats && !syn && pageSynopsis(f.synopsis, f.synopsisSource)) stats.synOmitted++;
    put('syn', syn);
    if (typeof f.trailer === 'string' && YT.test(f.trailer)) r.yt = f.trailer;
    shards[Number(shardOf(e.tt))].films.push(r);
  }
  return shards;
}
function writePages(outDir, index, facts) {
  const fs = require('fs'), path = require('path'), Paths = require('./learning/paths');
  const stats = { synOmitted: 0 }, shards = pageShards(index, facts, stats), sizes = [];
  // Validate the entire family before any page is written, still inside staging.
  require('./page-validation').validatePages(index, shards);
  for (const shard of shards) {
    const rel = `data/page-${shard.shard}.json`;
    if (!/^data\/page-\d{2}\.json$/.test(rel)) throw Error('Unsafe page path');
    const file = path.join(outDir, rel); Paths.noAliases(file, path.resolve(outDir));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = JSON.stringify(shard); fs.writeFileSync(file, text); sizes.push({ shard: shard.shard, bytes: Buffer.byteLength(text) });
  }
  const values = index.films.map(e => facts.get(e.tt));
  return { files: 100, films: index.films.length, bytes: sizes.reduce((a, x) => a + x.bytes, 0), largest: sizes.reduce((a, x) => x.bytes > a.bytes ? x : a, sizes[0]), trailers: values.filter(f => typeof f.trailer === 'string' && YT.test(f.trailer)).length, noTrailer: values.filter(f => f.trailer === null).length, unknownTrailer: values.filter(f => !Object.hasOwn(f, 'trailer') || f.trailer === undefined).length, synOmitted: stats.synOmitted };
}
module.exports = { pageSynopsis, publicSynopsis, privateText, pageShards, writePages, shardOf, ID, YT };
