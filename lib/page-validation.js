'use strict';
const { ID, YT, shardOf, publicSynopsis, privateText } = require('./page-export');
const TOP_KEYS = ['v', 'builtAt', 'shard', 'people', 'films'];
const FILM_KEYS = 't n y rt g d c im lb mo kw li fr sb fa wb syn yt'.split(' ');
const MAX_SHARD_BYTES = 256 * 1024, MAX_TOTAL_BYTES = 12 * 1000 * 1000;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const check = (ok, reason) => { if (!ok) throw Error('Film pages: ' + reason); };
const keys = (x, allow, label) => { check(object(x), label + ' must be object'); for (const k of Object.keys(x)) check(allow.includes(k), label + ' unexpected key ' + k); };
const text = x => typeof x === 'string' && !!x.trim() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(x);
function validateShard(shard, expected) {
  keys(shard, TOP_KEYS, 'shard');
  check(shard.v === 1, 'schema version'); check(shard.shard === expected && /^\d{2}$/.test(expected), 'shard identity');
  check(typeof shard.builtAt === 'string' && /^\d{4}-\d\d-\d\dT/.test(shard.builtAt) && Number.isFinite(Date.parse(shard.builtAt)), 'builtAt');
  check(Array.isArray(shard.people) && shard.people.every(text) && new Set(shard.people).size === shard.people.length, 'people');
  check(Array.isArray(shard.films), 'films');
  const ids = new Set();
  for (const r of shard.films) {
    keys(r, FILM_KEYS, 'film'); check(typeof r.t === 'string' && ID.test(r.t) && shardOf(r.t) === expected, 'film shard membership'); check(!ids.has(r.t), 'duplicate film'); ids.add(r.t); check(text(r.n), 'film name');
    for (const [k, lo, hi] of [['y', 1850, 2100], ['rt', 1, 6000], ['im', 1, 10], ['lb', 0, 5], ['fa', 0.5, 5], ['sb', 0, Number.MAX_SAFE_INTEGER], ['wb', 0, Number.MAX_SAFE_INTEGER]]) if (Object.hasOwn(r, k)) check(typeof r[k] === 'number' && Number.isFinite(r[k]) && r[k] >= lo && r[k] <= hi && (!['y', 'sb', 'wb'].includes(k) || Number.isInteger(r[k])), 'invalid ' + k);
    for (const [k, max] of [['g', 3], ['d', 2], ['c', 5], ['kw', 4]]) if (Object.hasOwn(r, k)) check(Array.isArray(r[k]) && r[k].length > 0 && r[k].length <= max && r[k].every(text), 'invalid ' + k);
    for (const k of ['mo', 'li']) if (Object.hasOwn(r, k)) {
      check(Array.isArray(r[k]) && r[k].length > 0, 'invalid ' + k); const refs = new Set();
      for (const pair of r[k]) { check(Array.isArray(pair) && pair.length === 2 && text(pair[0]) && /^[A-Za-z0-9_-]+$/.test(pair[0]) && Number.isFinite(pair[1]) && (k !== 'li' || Number.isInteger(pair[1]) && pair[1] >= 1), 'invalid ' + k + ' reference'); check(!refs.has(pair[0]), 'duplicate ' + k); refs.add(pair[0]); }
    }
    if (r.fr !== undefined) {
      keys(r.fr, ['s', 'w'], 'friends'); check(Array.isArray(r.fr.s) && Array.isArray(r.fr.w), 'friends arrays'); const person = i => Number.isInteger(i) && i >= 0 && i < shard.people.length;
      check(r.fr.s.every(p => Array.isArray(p) && p.length === 2 && person(p[0]) && (p[1] === null || Number.isFinite(p[1]) && p[1] >= 0.5 && p[1] <= 5)) && r.fr.w.every(person), 'friends index/rating');
      check(new Set(r.fr.s.map(p => p[0])).size === r.fr.s.length && new Set(r.fr.w).size === r.fr.w.length, 'duplicate friend');
    }
    if (r.syn !== undefined) check(text(r.syn) && r.syn.length <= 280 && !/^MUBI:/.test(r.syn), 'synopsis');
    if (r.yt !== undefined) check(typeof r.yt === 'string' && YT.test(r.yt), 'trailer');
  }
  const raw = JSON.stringify(shard);
  check(!privateText(raw), 'private content');
  return shard;
}
function synopsisOf(e, separator = '\n\n') {
  const desc = e.desc || '', nl = desc.indexOf('\n');
  let at = nl < 0 ? -1 : desc.indexOf(separator, nl + 1);
  if (at < 0) at = desc.indexOf(separator);
  return at < 0 ? '' : desc.slice(at + separator.length);
}
function validatePages(index, shards) {
  check(Array.isArray(shards) && shards.length === 100, 'exactly 100 shards required');
  const expected = new Map(index.films.map(e => [e.tt, e])), seen = new Set(), names = new Set(); let total = 0;
  const moods = new Set(index.moods.map(m => m.id)), lists = new Set(index.lists.map(l => l.id));
  for (const shard of shards) {
    const bytes = Buffer.byteLength(JSON.stringify(shard)); check(bytes <= MAX_SHARD_BYTES, 'shard exceeds 256 KiB'); total += bytes;
    validateShard(shard, shard.shard); check(!names.has(shard.shard), 'duplicate shard'); names.add(shard.shard);
    check(shard.builtAt === index.meta.builtAt, 'builtAt differs from v2'); check(same(shard.people, index.friends.people), 'people differs from v2');
    for (const r of shard.films) {
      check(!seen.has(r.t), 'duplicate film'); seen.add(r.t); const e = expected.get(r.t); check(!!e, 'film absent from v2');
      check(r.n === e.name, 'name differs from v2');
      for (const [k, col] of Object.entries({ y: 'year', rt: 'runtime', g: 'genres', im: 'imdbRating', lb: 'lbRating', sb: 'seenBy', fa: 'friendsAvg', wb: 'wantBy' })) check(same(r[k], e[col]?.length === 0 ? undefined : e[col]), k + ' differs from v2');
      if (r.kw) {
        const desc = e.desc || '', nl = desc.indexOf('\n'), separator = index.meta.separator || '\n\n';
        let at = nl < 0 ? -1 : desc.indexOf(separator, nl + 1); if (at < 0) at = desc.indexOf(separator);
        const card = at < 0 ? desc : desc.slice(0, at), line = card.split('\n')[1] || '';
        const words = line.replace(/\.$/, '').split(' · ').at(-1).split(', ').map(w => w.toLowerCase());
        check(r.kw.every(w => w === w.toLowerCase() && words.includes(w)), 'style differs from description vocabulary');
      }
      const syn = synopsisOf(e, index.meta.separator); check((r.syn || '') === publicSynopsis(syn, /^MUBI: /.test(syn) ? 'mubi' : 'other'), 'synopsis differs from v2');
      check(same(r.mo || [], Object.entries(e.moods || {}).map(([id, v]) => [id, v[0]])), 'moods differ from v2');
      for (const [id, pos] of r.li || []) check(lists.has(id) && e.lists?.[id] === pos, 'list reference differs from v2');
      for (const [id] of r.mo || []) check(moods.has(id), 'unknown mood reference');
      const s = (e.friends?.seenBy || []).map(([n, rating]) => [index.friends.people.indexOf(n), rating]), w = (e.friends?.wantBy || []).map(n => index.friends.people.indexOf(n));
      check(same(r.fr || { s: [], w: [] }, { s, w }), 'friends differ from v2');
    }
  }
  check(total <= MAX_TOTAL_BYTES, 'family exceeds 12 MB'); check(seen.size === expected.size && [...expected.keys()].every(id => seen.has(id)), 'coverage differs from v2');
  return { films: seen.size, bytes: total };
}
function verifyPages(dir, index, privacy = () => {}) {
  const fs = require('fs'), path = require('path'), Paths = require('./learning/paths');
  const data = path.join(dir, 'data'), names = fs.existsSync(data) ? fs.readdirSync(data).filter(n => /^page-/.test(n)) : [];
  if (!index || index.meta.personId) { check(names.length === 0, index ? 'pages forbidden for person' : 'orphan pages without v2'); return null; }
  const want = Array.from({ length: 100 }, (_, i) => `page-${String(i).padStart(2, '0')}.json`);
  check(same([...names].sort(), want), 'exactly 100 named shards required');
  let rawBytes = 0;
  const shards = names.map(n => { const file = path.join(data, n); Paths.noAliases(file, path.resolve(dir)); check(fs.statSync(file).size <= MAX_SHARD_BYTES, 'shard exceeds 256 KiB'); const raw = fs.readFileSync(file, 'utf8'); rawBytes += Buffer.byteLength(raw); const json = JSON.parse(raw); privacy(n, { text: raw, json }); return json; });
  check(rawBytes <= MAX_TOTAL_BYTES, 'family exceeds 12 MB');
  return { ...validatePages(index, shards), bytes: rawBytes };
}
module.exports = { validateShard, validatePages, verifyPages, synopsisOf, FILM_KEYS, TOP_KEYS, MAX_SHARD_BYTES, MAX_TOTAL_BYTES };
