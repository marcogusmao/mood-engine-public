#!/usr/bin/env node
// Offline seed of shared film facts. Never imports a person's viewing history.
const fs = require('node:fs');
const path = require('node:path');
const { personArg, personPaths, resolvePerson, noSymlinks, pick } = require('../lib/people');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireObject = (value, name) => { if (!object(value)) throw new Error(`Invalid metadata shape: ${name}`); };

// Owner blocks have no meaning in shared film metadata, including inside records.
function neutral(value) {
  if (Array.isArray(value)) return value.map(neutral);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !['me', 'watchlist', 'following', 'feedback', 'history'].includes(k)).map(([k, v]) => [k, neutral(v)]));
}

function projectMetadata(name, source) {
  requireObject(source, name);
  let projected;
  if (name === 'friends.json') {
    requireObject(source.films, `${name}.films`);
    const films = Object.fromEntries(Object.entries(source.films).map(([slug, record]) => {
      requireObject(record, `${name}.films record`);
      return [slug, pick(record, ['title', 'year', 'tmdbId', 'tmdbType', 'imdbId', 't', 'v', 'r', 'rn', 'rt', 'c', 'synopsis'])];
    }));
    projected = { version: 1, films, users: {}, lists: {} };
  } else if (name === 'tmdb.json') {
    for (const key of ['movie', 'recs', 'person', 'find', 'search']) if (Object.hasOwn(source, key)) requireObject(source[key], `${name}.${key}`);
    projected = pick(source, ['movie', 'recs', 'person', 'find', 'search']);
    if (!Object.keys(projected).length) throw new Error('Invalid metadata shape: tmdb.json');
  } else if (name === 'lists.json') {
    requireObject(source.lists, `${name}.lists`);
    for (const key of ['urls', 'menus']) if (Object.hasOwn(source, key)) requireObject(source[key], `${name}.${key}`);
    projected = pick(source, ['version', 'urls', 'lists', 'menus']);
  } else if (name === 'imdb-ratings.json') {
    requireObject(source.ratings, `${name}.ratings`);
    if (!Array.isArray(source.none)) throw new Error(`Invalid metadata shape: ${name}.none`);
    projected = pick(source, ['version', 'date', 'ratings', 'none']);
  } else if (name === 'mubi.json') {
    if (require('../lib/mubi-cache').cacheProblems(source).length) throw new Error('Invalid metadata shape: mubi.json');
    projected = pick(source, ['schema', 'source', 'updatedAt', 'films']);
  } else throw new Error('Unknown metadata file.');
  return neutral(projected);
}

function preparePerson(root, id, privateDir) {
  const person = resolvePerson(id);
  root = path.resolve(root);
  const { cacheDir } = personPaths(root, person, privateDir);
  const sourceDir = path.join(root, 'cache');
  noSymlinks(root, cacheDir);
  if (fs.existsSync(cacheDir) && !fs.statSync(cacheDir).isDirectory()) throw new Error('Person cache destination must be a directory.');
  const pending = [];
  for (const name of ['tmdb.json', 'lists.json', 'imdb-ratings.json', 'mubi.json', 'friends.json']) {
    const target = path.join(cacheDir, name);
    noSymlinks(root, target);
    if (fs.existsSync(target)) {
      if (!fs.statSync(target).isFile()) throw new Error('Person cache target must be a regular file.');
      continue; // never replace any existing personal cache, even if it no longer matches the seed
    }
    const from = path.join(sourceDir, name);
    noSymlinks(root, from);
    if (!fs.existsSync(from)) {
      if (name === 'friends.json') pending.push([target, { version: 1, films: {}, users: {}, lists: {} }]);
      continue;
    }
    if (!fs.statSync(from).isFile()) throw new Error('Metadata source must be a regular file.');
    pending.push([target, projectMetadata(name, JSON.parse(fs.readFileSync(from, 'utf8')))]);
  }
  // Validate every source/target before making even the destination directory.
  if (pending.length) require('../lib/learning/paths').mkdirPrivate(cacheDir);
  for (const [target, value] of pending) {
    noSymlinks(root, target);
    fs.writeFileSync(target, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return { cacheDir, created: pending.map(([file]) => path.basename(file)) };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2), person = personArg(args);
    if (!person || !args.includes('--private-dir') || args.length !== 4) throw new Error('Usage: node scripts/prepare-person.js --person friend-a --private-dir <private-run-dir>');
    const result = preparePerson(path.join(__dirname, '..'), person.id, args[args.indexOf('--private-dir')+1]);
    console.log(`Prepared ${result.created.length} files → ${result.cacheDir}`);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { preparePerson, projectMetadata };
