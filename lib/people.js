// Closed identity registry. Registration does not imply imported data or a ready site.
const fs = require('node:fs');
const path = require('node:path');
const clone = (value) => JSON.parse(JSON.stringify(value));
const pick = (value, keys) => Object.fromEntries(keys.filter(k => Object.hasOwn(value, k)).map(k => [k, clone(value[k])]));

function resolvePerson(id) {
  const registry = require('../people.json');
  const person = typeof id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && registry.find(p => p.id === id);
  if (!person) throw new Error('Unknown --person; use an exact registered id (friend-a).');
  return { ...person };
}

// Called before config/cache reads and before any output directories are created.
function personArg(argv) {
  if (argv.some(a => a.startsWith('--person='))) throw new Error('Use --person friend-a.');
  const at = argv.indexOf('--person');
  if (at < 0) return null;
  if (argv.lastIndexOf('--person') !== at || !argv[at + 1] || argv[at + 1].startsWith('--')) throw new Error('--person needs one registered id.');
  return resolvePerson(argv[at + 1]);
}

function privateRoot(root, value) {
  if (!value) throw new Error('--private-dir is required for Will');
  noSymlinks(path.parse(path.resolve(value)).root,path.resolve(value));
  const dest = require('./learning/paths').privateDir(value, root);
  const local = path.join(path.resolve(root), '.context/private/friend-a');
  const runner = process.env.RUNNER_TEMP && path.join(path.resolve(process.env.RUNNER_TEMP), 'mood-private/friend-a');
  if (![local, runner].filter(Boolean).some(base => dest.startsWith(base + path.sep) && path.relative(base,dest).split(path.sep).length === 1 && /^[A-Za-z0-9_-]+$/.test(path.basename(dest)))) throw new Error('Invalid Will private directory');
  noSymlinks(path.parse(dest).root, path.resolve(value));
  return dest;
}
function personPaths(root, person, privateDir) {
  resolvePerson(person.id);
  const dir = privateRoot(root, privateDir);
  return { privateDir: dir, exportDir: dir, cacheDir: path.join(dir,'cache'), outDir: path.join(root,'.context/people',person.id,'site') };
}

function deriveConfig(base, person) {
  person = resolvePerson(person.id);
  // Keys are copied one by one, so a key of Marco's config that is NOT in this list never reaches a person's build. `ratingsIgnored` (Marco's list of followed
  // accounts whose ratings are not used, 22/10/2026, and its general rule for the accounts that give one value only, ~06:40 UTC) is deliberately outside it: the list names people HE follows,
  // and a profile follows its own, so neither the list nor the rule reaches a profile (test/people.test.js).
  const cfg = pick(base, ['sizes', 'build', 'weekRow', 'descriptionSeparator', 'shortRow', 'cuts', 'lists', 'moods', 'friendRows', 'limits', 'board']);
  cfg.addon = { ...pick(base.addon, ['version', 'description']), id: `${base.addon.id}.${person.id}`, name: `Mood Engine · ${person.name}` };
  cfg.letterboxd = person.letterboxd;
  const posterBase = new URL(base.posters.base);
  if (!['https:', 'http:'].includes(posterBase.protocol)) throw new Error('A public poster base URL is required.');
  cfg.posters = { base: new URL(`../u/${person.id}/posters/`, posterBase).href };
  cfg.exclude = { films: [] };
  // Tonight (Marco, 15/11/2026, questionnaire: "Yes, same rule, his own memory"): a person's row is drawn by Marco's rule, the numbers of config.json `tonight` (the top 40 of each mood, no film again
  // inside 30 days), from a memory of the person's OWN: <the person's private folder>/cache/tonight-memory.json (build.js reads the person's cache folder, never Marco's cache/), where a row
  // counts only after the build that drew it is reported as published (lib/tonight-memory.js, "A person's memory"). From the review of 14/11/2026 until this decision the person kept the row of
  // before in words (depth 12, noRepeatDays 0), because nobody had decided. What is NOT done, and keeps the memory empty until it is: the file is not among the ones the person's snapshot carries
  // (lib/person-input.js FILES), and nothing tells the build which revisions were published (BACKLOG.md, 15/11/2026).
  cfg.tonight = pick(base.tonight || {}, ['bias', 'depth', 'noRepeatDays']);
  cfg.friends = [];
  cfg.friendLists = [];
  if (base.directorsLoved) cfg.directorsLoved = {
    ...pick(base.directorsLoved, ['file', 'minFilms', 'minAvg', 'defaultWeight', 'perDirector', 'menuMin', 'aliases', 'accounts']),
    include: [], exclude: [], labels: {},
  };
  if (cfg.board) {
    cfg.board.order = cfg.board.order.filter(id => id !== 'my-series');
    delete cfg.board.names['my-series'];
    for (const row of cfg.board.rows) if (Object.hasOwn(row, 'people')) row.people = [];
  }
  return cfg;
}

function noSymlinks(root, target) {
  root = path.resolve(root); target = path.resolve(target);
  if (target !== root && !target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) throw new Error('Path outside person root.');
  for (let at = target; ; at = path.dirname(at)) {
    try { if (fs.lstatSync(at).isSymbolicLink()) throw new Error('Symlink in person path.'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (at === root) break;
  }
}

function buildPersonOptions(root, argv) {
  const person = personArg(argv);
  if (!person) { if (argv.includes('--person-input')) throw Error('--person-input requires --person'); return null; }
  const value = flag => { const at=argv.indexOf(flag); if(at<0)return null; if(argv.lastIndexOf(flag)!==at||!argv[at+1]||argv[at+1].startsWith('--'))throw Error(flag+' needs one value');return path.resolve(argv[at+1]); };
  for(const flag of ['--config','--board','--mubi-cache'])if(argv.includes(flag))throw Error(flag+' cannot be used with --person');
  if(process.env.MUBI_CACHE)throw Error('MUBI_CACHE cannot override a personal cache');
  const paths=personPaths(root,person,value('--private-dir'));
  for(const rel of ['cache','history.json','cache/tmdb.json','cache/friends.json','cache/lists.json','cache/imdb-ratings.json','cache/mubi.json','cache/posters.json','cache/front-memory.json','cache/tonight-memory.json','cache/posters-raw','cache/posters-out'])noSymlinks(paths.privateDir,path.join(paths.privateDir,rel)); // tonight-memory.json since 15/11/2026: a link planted there to Marco's file would make the person's Tonight hold back Marco's films
  const input=value('--person-input');
  if(input!==path.join(paths.privateDir,'history.json'))throw Error('--person-input must be private history.json');
  if(value('--cache-dir')&&value('--cache-dir')!==paths.cacheDir)throw Error('--cache-dir must be the private person cache');
  const outDir=value('--out')||paths.outDir, P=require('./learning/paths');
  const dest=P.validateDestination(outDir,root,null,false),docs=P.realDestination(path.join(root,'docs'));
  if(dest===docs||docs.startsWith(dest+path.sep)||dest.startsWith(docs+path.sep)||dest===paths.privateDir||dest.startsWith(paths.privateDir+path.sep)||paths.privateDir.startsWith(dest+path.sep))throw Error('Person output overlaps protected input/output');
  return {person,...paths,outDir,input};
}
module.exports = { resolvePerson, personArg, personPaths, privateRoot, deriveConfig, noSymlinks, buildPersonOptions, pick };
