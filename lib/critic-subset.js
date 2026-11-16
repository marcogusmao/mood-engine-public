'use strict';

// A "critic subset" of a list (Marco, 11/10/2026): a list made by fans or by the public (trust "fan") in which SOME films carry a
// critics' endorsement of their own. config.json: { "trust": "fan", "criticSubset": "data/cannes-critic-prizes.json", "criticSubsetLabel": "Cannes" }.
// The endorsement is per film × list: the films named in the file are vouched for (cv: 1, the one floor exception of
// lib/recommendation-quality.js), the rest of the list stays "fan" (they still need the 3.5 average or a friend's 3.5). The list's agreement
// weight (lw, lib/list-signal.js) is still computed over the WHOLE list.
//
// File: { filmes: [{ slug, title?, year?, imdb?, prizes: { "<prize>": [year, …] } }], premios_criticos: ["<prize>", …] }
// A film counts when it holds at least one prize named in premios_criticos (the other prizes it holds are ignored, not an error).
// Joined by Letterboxd slug; when a film carries `imdb` it must equal the IMDb id Letterboxd's page names, or the film is NOT vouched.

const fs = require('node:fs');
const path = require('node:path');

const IMDB = /^tt\d+$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** The label of a prize without its explanatory parenthesis: "Palme d'Or (1955-63 e 1975-2026)" → "Palme d'Or". */
const prizeName = (key) => String(key).replace(/\s*\(.*$/, '').trim();

/** → problems (strings) of the parsed file; empty when it is usable. */
function validate(data) {
  const p = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['the file is not an object'];
  if (!Array.isArray(data.premios_criticos) || !data.premios_criticos.length || data.premios_criticos.some((k) => typeof k !== 'string' || !k)) p.push('premios_criticos must be a non-empty list of prize names');
  if (!Array.isArray(data.filmes) || !data.filmes.length) { p.push('filmes must be a non-empty list'); return p; }
  const seen = new Set();
  data.filmes.forEach((f, i) => {
    const at = `filmes[${i}]${f && f.slug ? ` (${f.slug})` : ''}`;
    if (!f || typeof f.slug !== 'string' || !SLUG.test(f.slug)) { p.push(`${at}: slug missing or malformed`); return; }
    if (seen.has(f.slug)) p.push(`${at}: slug used twice`);
    seen.add(f.slug);
    if (f.imdb !== undefined && !(typeof f.imdb === 'string' && IMDB.test(f.imdb))) p.push(`${at}: imdb must look like tt1234567`);
    if (!f.prizes || typeof f.prizes !== 'object' || Array.isArray(f.prizes) || !Object.keys(f.prizes).length) p.push(`${at}: prizes missing`);
    else for (const [k, years] of Object.entries(f.prizes)) if (!Array.isArray(years) || !years.length || years.some((y) => !Number.isInteger(y))) p.push(`${at}: prize "${k}" needs a list of years`);
  });
  return p;
}

/** The parsed file → Map slug → { imdb|null, label: "Cannes · Palme d'Or 1994", prizes: [{ prize, years }] } of the films holding a critics' prize. */
function build(data, label) {
  const bad = validate(data);
  if (bad.length) throw new Error(`critic subset: ${bad.slice(0, 5).join('; ')}${bad.length > 5 ? ` (+${bad.length - 5} more)` : ''}`);
  const critic = new Set(data.premios_criticos);
  const out = new Map();
  for (const f of data.filmes) {
    const prizes = Object.entries(f.prizes).filter(([k]) => critic.has(k)).map(([k, years]) => ({ prize: prizeName(k), years: [...years].sort((a, b) => a - b) }));
    if (!prizes.length) continue;
    // "Palme d'Or 1994"; a film with several: "Direção 1994, Roteiro 1994"; the first two prizes only, the file keeps the rest
    const text = prizes.slice(0, 2).map((x) => `${x.prize} ${x.years.join('/')}`).join(', ');
    out.set(f.slug, { imdb: f.imdb || null, label: `${label ? `${label} · ` : ''}${text}`, prizes });
  }
  return out;
}

/** config.json lists → Map listId → Map slug → entry, reading each list's `criticSubset` file under root. Throws on a missing or invalid file. */
function loadAll(root, lists, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  const out = new Map();
  for (const l of lists || []) {
    if (!l.criticSubset) continue;
    let data;
    try { data = JSON.parse(readFile(path.join(root, l.criticSubset))); } catch (e) { throw new Error(`list ${l.id}: criticSubset ${l.criticSubset}: ${e.message}`); }
    out.set(l.id, build(data, l.criticSubsetLabel));
  }
  return out;
}

/**
 * Warnings against the list as read: slugs of the subset that are not in the list (a typo, a film Letterboxd removed from it, a
 * list read only in part) and entries whose IMDb id disagrees with Letterboxd's page. → strings, for the build log; never an error,
 * because a list is read from the network and may be partial. (A film refused for its IMDb id is not vouched: list-signal.js signals().)
 */
function warnings(list, subset, films = {}) {
  const inList = new Set((list.items || []).map((i) => i.slug));
  const w = [];
  const missing = [...subset.keys()].filter((s) => !inList.has(s));
  if (missing.length) w.push(`list ${list.id} (${list.name}): ${missing.length} of ${subset.size} critic-subset films are not in the list: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''}`);
  for (const [slug, e] of subset) {
    const r = films[slug];
    if (e.imdb && r && r.imdbId && r.imdbId !== e.imdb && inList.has(slug)) w.push(`list ${list.id}: ${slug} says ${e.imdb} but Letterboxd names ${r.imdbId}; not vouched`);
  }
  return w;
}

module.exports = { validate, build, loadAll, warnings, prizeName };
