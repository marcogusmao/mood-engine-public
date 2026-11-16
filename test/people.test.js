const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const P = require('../lib/people');
const { preparePerson, projectMetadata } = require('../scripts/prepare-person');
// Receipt, 14/10/2026 (Node 22.23.3): temporarily added Marco fixture me/watchlist
// after neutral(projected) in projectMetadata. --test-name-pattern='metadata projection
// drops owner blocks' failed 1/1 with the two unexpected fields. Restored the projection
// and reran this file plus import-letterboxd.test.js: 17/17 pass.
const ROOT = path.resolve(__dirname, '..');
const will = P.resolvePerson('friend-a');
const write = (root, rel, value) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};
function temp(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'people-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const run = (script, args, env = {}) => spawnSync(process.execPath, [script, ...args], {
  encoding: 'utf8', env: { ...process.env, ...env }, timeout: 15000,
});

test('closed registry resolves exact identity, without an active/ready status', () => {
  assert.deepEqual(require('../people.json'), [{ id: 'friend-a', letterboxd: 'friend-a', name: 'Will' }]);
  assert.deepEqual(will, { id: 'friend-a', letterboxd: 'friend-a', name: 'Will' });
  const copy = P.resolvePerson('friend-a'); copy.name = 'changed';
  assert.equal(P.resolvePerson('friend-a').name, 'Will');
  for (const id of ['marco', 'friend-a', '../friend-a', '/friend-a', 'friend-a/..', '__proto__', '', null]) assert.throws(() => P.resolvePerson(id), /Unknown/);
  assert.equal(P.personArg([]), null);
  assert.equal(P.buildPersonOptions(ROOT, []), null);
  for (const args of [['--person'], ['--person', '--out'], ['--person', 'friend-a', '--person', 'friend-a'], ['--person=friend-a']]) assert.throws(() => P.personArg(args), /--person/);
});

test('paths and configuration isolate Will while preserving recipes and the original', () => {
  assert.throws(()=>P.personPaths('/fixture',will),/private-dir/);
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const before = JSON.stringify(base);
  base.personalExtension = { name: 'Marco', series: ['private-series'] };
  const cfg = P.deriveConfig(base, will);
  assert.equal(cfg.addon.id, base.addon.id + '.friend-a');
  assert.equal(cfg.addon.name, 'Mood Engine · Will');
  assert.equal(cfg.letterboxd, 'friend-a');
  assert.equal(cfg.posters.base, 'https://marcogusmao.github.io/mood-engine/u/friend-a/posters/');
  assert.deepEqual(cfg.exclude, { films: [] });
  assert.deepEqual(cfg.friends, []); assert.deepEqual(cfg.friendLists, []);
  assert.deepEqual(cfg.directorsLoved.include, []); assert.deepEqual(cfg.directorsLoved.exclude, []); assert.deepEqual(cfg.directorsLoved.labels, {});
  for (const key of ['file', 'aliases', 'accounts', 'minFilms', 'minAvg', 'defaultWeight', 'perDirector', 'menuMin']) assert.deepEqual(cfg.directorsLoved[key], base.directorsLoved[key]);
  for (const key of ['sizes', 'build', 'weekRow', 'descriptionSeparator', 'shortRow', 'cuts', 'lists', 'moods', 'friendRows', 'limits']) assert.deepEqual(cfg[key], base[key]);
  assert.deepEqual(cfg.board.order, base.board.order.filter(id => id !== 'my-series'));
  assert.equal(Object.hasOwn(cfg.board.names, 'my-series'), false);
  assert.deepEqual(cfg.board.rows, base.board.rows.map(row => Object.hasOwn(row, 'people') ? { ...row, people: [] } : row));
  assert.equal(cfg.board.rows.find(r => r.kind === 'friends-watchlist').onlyConfiguredFriends, false);
  assert.equal(Object.hasOwn(cfg, 'personalExtension'), false);
  // Marco, 22/10/2026: ratingsIgnored names accounts HE follows (benreiss); a profile follows its own people, so deriveConfig copies it to no one (the choice is the session's, not asked yet).
  assert.ok(base.ratingsIgnored.users.length > 0, 'control: the original config has the list');
  assert.equal(Object.hasOwn(cfg, 'ratingsIgnored'), false);
  // Marco, 28/10/2026 (answer (b) of question 4, Discover proposal 5): the seven friends of config.json include friend-b now; none of the seven reaches a profile, and the one new key of the friends menu
  // (friendRows.all, 'All friends loved') travels with friendRows like its siblings but is inert there: a profile has no friends, so lib/friends-option.js finds no menu to put it in (test/friends-option.test.js).
  assert.equal(base.friends.length, 7, 'control: the original config has the seven friends');
  assert.deepEqual(cfg.friends, []);
  assert.deepEqual(cfg.friendRows.all, base.friendRows.all);
  for (const name of ['mgusmao', 'friend-e', 'friend-d', 'friend-c', 'friend-f', 'friend-g', 'friend-b', 'benreiss']) assert.equal(JSON.stringify({ ...cfg, addon: undefined }).includes(name), false, name);
  delete base.personalExtension;
  assert.equal(JSON.stringify(base), before);
  cfg.moods[0].name = 'mutated'; cfg.board.rows[0].where.years.min = 1;
  assert.equal(JSON.stringify(base), before, 'derived objects must not alias the original');
});

test('empty people keeps the row and parses without inheriting Marco friends', () => {
  const cfg = P.deriveConfig(require('../config.json'), will);
  assert.ok(cfg.board.order.includes('top-picks'));
  assert.deepEqual(cfg.board.rows.find(r => r.id === 'top-picks').people, []);
  assert.doesNotThrow(() => require('../lib/board').parse(cfg));
});

test('metadata projection drops owner blocks from shared facts', () => {
  const owner = { me: { user: 'Marco', slugs: ['private'] }, watchlist: { items: ['private'] }, following: ['Marco'] };
  const source = { version: 1, films: { film: { title: 'Fixture film', year: 2000, imdbId: 'tt1234567', r: 4, rn: 10, rt: 100, c: ['BR'], ...owner } }, users: { Marco: {} }, lists: { private: {} }, ...owner };
  const before = JSON.stringify(source);
  assert.deepEqual(projectMetadata('friends.json', source), {
    version: 1, films: { film: { title: 'Fixture film', year: 2000, imdbId: 'tt1234567', r: 4, rn: 10, rt: 100, c: ['BR'] } }, users: {}, lists: {},
  });
  assert.deepEqual(projectMetadata('tmdb.json', { movie: { 1: { title: 'Fixture', ...owner } }, ...owner }), { movie: { 1: { title: 'Fixture' } } });
  assert.equal(JSON.stringify(source), before);
});


test('private paths reject absent context, repository caches, aliases and output overlap',t=>{
 const root=temp(t),dir=path.join(root,'.context/private/friend-a/run');
 const args=['--person','friend-a','--private-dir',dir,'--person-input',path.join(dir,'history.json')];
 assert.equal(P.buildPersonOptions(root,args).cacheDir,path.join(dir,'cache'));
 for(const value of [root,path.join(root,'cache/people/friend-a'),path.join(root,'.context/private/friend-a')])assert.throws(()=>P.privateRoot(root,value));
 assert.throws(()=>P.buildPersonOptions(root,[...args,'--out',dir]),/overlaps/);
 assert.throws(()=>P.buildPersonOptions(root,[...args,'--cache-dir',path.join(root,'cache')]),/private person cache/);
 fs.mkdirSync(path.dirname(dir),{recursive:true});fs.symlinkSync(path.join(root,'cache'),dir);assert.throws(()=>P.privateRoot(root,dir),/Symlink/);
});
test('private seeding preserves personal cache and uses owner-neutral facts only',t=>{
 const root=temp(t),dir=path.join(root,'.context/private/friend-a/run');
 write(root,'cache/friends.json',{version:1,films:{},me:{user:'mgusmao'},users:{mgusmao:{}},following:['mgusmao']});
 const result=preparePerson(root,'friend-a',dir);
 assert.equal(result.cacheDir,path.join(dir,'cache'));assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.cacheDir,'friends.json'))),{version:1,films:{},users:{},lists:{}});
 write(root,path.relative(root,path.join(result.cacheDir,'friends.json')),{personal:true});
 assert.deepEqual(preparePerson(root,'friend-a',dir).created,[]);
 assert.equal(fs.statSync(path.join(result.cacheDir,'friends.json')).mode&0o777,0o600);
});

test('personal cache child symlinks cannot route Will into root data',t=>{
 const root=temp(t),dir=path.join(root,'.context/private/friend-a/run');fs.mkdirSync(path.join(dir,'cache'),{recursive:true});write(root,'cache/friends.json',{me:{user:'mgusmao'}});fs.symlinkSync(path.join(root,'cache/friends.json'),path.join(dir,'cache/friends.json'));
 assert.throws(()=>P.buildPersonOptions(root,['--person','friend-a','--private-dir',dir,'--person-input',path.join(dir,'history.json')]),/Symlink/);
});
