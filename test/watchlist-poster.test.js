const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const P = require('../lib/posters');

test('watchlist poster: personal membership reaches the render job and invalidates the cached cover', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-poster-'));
  try {
    const item = { id: 'tt1', ratings: { lb: 4, wantBy: 8 } };
    const plan = { board: [{ id: 'x', items: [item] }], discover: [] };
    const ids = P.watchlistIds([{ film: { imdb: 'tt1' }, watchlist: true }], []);
    const targets = P.collectTargets(plan, { watchlistIds: ids });
    assert.equal(targets.get('tt1').watchlist, true);
    const raw = path.join(dir, 'raw'), out = path.join(dir, 'out');
    fs.mkdirSync(raw); fs.mkdirSync(out);
    fs.writeFileSync(path.join(raw, 'tt1.jpg'), 'raw fixture handled by injected renderer');
    let jobs = [];
    const render = async list => {
      jobs.push(...list);
      for (const j of list) fs.writeFileSync(j.out, 'rendered');
      return { drawn: list.length, failed: [] };
    };
    const run = () => P.drawCovers({ targets, dir: { raw, out, state: path.join(dir, 'state.json') }, today: '2026-10-12', version: 'test', render });
    await run();
    assert.equal(jobs[0].watchlist, true);
    assert.equal(jobs[0].querem, undefined, 'friends watchlist count is not a poster input');
    jobs = [];
    targets.get('tt1').watchlist = false;
    await run();
    assert.equal(jobs.length, 1, 'removing from personal watchlist redraws');
    assert.equal(jobs[0].watchlist, false);
    jobs = [];
    targets.get('tt1').ratings.wantBy = 20;
    await run();
    assert.equal(jobs.length, 0, 'friends count no longer changes the cover');
    targets.get('tt1').ratings = { wantBy: 8 };
    targets.get('tt1').year = 1963;
    targets.get('tt1').watchlist = true;
    await run();
    jobs = [];
    targets.get('tt1').watchlist = false;
    await run();
    assert.equal(jobs.length, 1, 'removal redraws even without any numeric ratings');
    assert.equal(jobs[0].year, 1963, 'year remains when only the marker goes away');
    assert.equal(jobs[0].watchlist, false);
    assert.deepEqual([...P.watchlistIds([{ film: { imdb: 'tt1' }, watchlist: true }], [{ id: 'tt1', tags: { watchlist: false } }])], [], 'same precedence as the Worker index');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('watchlist poster: real pixels show an icon only for own membership at desktop and narrow sizes', () => {
  const check = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, 'tools/selo')
from PIL import Image, ImageChops
from selo import aplicar_v2, layout, bookmark, _fit
from render import draw_one
import tempfile, os
raw = Image.new('RGB', (500, 750), (200, 200, 200))
for width in (342, 150):
    baseline = aplicar_v2(raw, lb=4.2, imdb=8, amigos=3, n_viram=1, ano=1963, largura=width)
    for count in (0, 1, 999):
        absent = aplicar_v2(raw, lb=4.2, imdb=8, amigos=3, n_viram=1, ano=1963, largura=width, n_querem=count)
        assert ImageChops.difference(baseline.convert('RGB'), absent.convert('RGB')).getbbox() is None, 'friends count drew a marker'
    own = aplicar_v2(raw, lb=4.2, imdb=8, amigos=3, n_viram=1, ano=1963, largura=width, na_watchlist=True)
    L = layout(width)
    m, hb, pad = L['margin'], int(L['h'] * .8), L['pad']
    box = (width - 60, 0, width, m + hb + 3)
    diff = ImageChops.difference(baseline.convert('RGB'), own.convert('RGB'))
    bounds = diff.getbbox()
    assert bounds and bounds[1] == m and bounds[3] <= m + hb + 1, bounds
    expected_width = int(pad * .8 + _fit(bookmark(64), int(hb * .6)).width + pad * .8)
    assert bounds[0] == width - m - expected_width, 'marker has room for a count'
    assert own.crop((0, m + hb + 2, width, own.height)).tobytes() == baseline.crop((0, m + hb + 2, width, baseline.height)).tobytes(), 'ratings changed'
    year_only = aplicar_v2(raw, ano=1963, largura=width)
    year_with_marker = aplicar_v2(raw, ano=1963, largura=width, na_watchlist=True)
    assert year_only.crop((0, 0, width//2, 50)).tobytes() == year_with_marker.crop((0, 0, width//2, 50)).tobytes(), 'year changed without ratings'
with tempfile.TemporaryDirectory() as d:
    raw.save(os.path.join(d, 'raw.png'))
    for own in (False, True):
        out = os.path.join(d, str(own) + '.jpg')
        assert draw_one({'raw': os.path.join(d, 'raw.png'), 'out': out, 'watchlist': own, 'querem': 99}) is None
        im = Image.open(out).convert('RGB')
        assert (sum(im.getpixel((329, 25))) < 150) == own, 'job membership not rendered'
print('342px + 150px: own icon only; friends counts ignored; ratings unchanged; JPEG jobs verified')
`], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

// Added 13/10/2026, from the mutation receipt of the rebase onto 7526ee3: two mutations survived the 12/10 tests.
//  (1) an index-only film (in the Worker index, in no row of the plan) had its own membership read as false: collectTargets() took
//      `e.watchlist === true` only for rows of the plan; 4,596 of the 11,148 covers are index-only;
//  (2) render.py took any truthy "watchlist" as membership (`bool(...)` instead of `is True`), so the string "false" drew the bookmark.
test('watchlist poster: an index-only film keeps its own membership, and a job value that is not the boolean true draws no bookmark', () => {
  const plan = { board: [], discover: [] };
  const index = { films: [{ tt: 'tt2', watchlist: true }, { tt: 'tt3', watchlist: false }, { tt: 'tt4' }, { tt: 'tt5', watchlist: 'true' }] };
  const targets = P.collectTargets(plan, { index });
  assert.deepEqual([...targets.values()].map(t => [t.tt, t.watchlist]), [['tt2', true], ['tt3', false], ['tt4', false], ['tt5', false]]);
  const check = spawnSync('python3', ['-c', `
import sys, os, tempfile
sys.path.insert(0, 'tools/selo')
from PIL import Image
from render import draw_one
raw = Image.new('RGB', (500, 750), (200, 200, 200))
with tempfile.TemporaryDirectory() as d:
    raw.save(os.path.join(d, 'raw.png'))
    for value, drawn in ((True, True), (False, False), ('false', False), ('true', False), (1, False), (None, False)):
        out = os.path.join(d, 'out.jpg')
        assert draw_one({'raw': os.path.join(d, 'raw.png'), 'out': out, 'watchlist': value}) is None
        assert (sum(Image.open(out).convert('RGB').getpixel((329, 25))) < 150) == drawn, repr(value)
`], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

// Added 13/10/2026, same receipt: mutation 4c survived. The list of flags to download was cut back to films with a numeric badge
// (`hasNumbers(...)` alone), so a film with a year and a country but no rating and no bookmark (most index-only films) never got its
// flag picture: it was drawn with the year alone, again and again.
test('watchlist poster: the flag of a film with a year and no ratings is downloaded and drawn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-flag-'));
  try {
    const raw = path.join(dir, 'raw'), out = path.join(dir, 'out'), flags = path.join(dir, 'flags');
    fs.mkdirSync(raw); fs.mkdirSync(out);
    fs.writeFileSync(path.join(raw, 'tt1.jpg'), 'raw fixture handled by injected renderer');
    const targets = new Map([['tt1', { tt: 'tt1', watchlist: false, tmdbPoster: null, year: 1963, cc: 'jp', ccFrom: 'language', ratings: { lb: null, imdb: null, friendsAvg: null, seenBy: 0, wantBy: 0 }, items: [] }]]);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]);
    const asked = [];
    const fetchImpl = async u => { asked.push(String(u).split('/').pop()); return { ok: true, status: 200, arrayBuffer: async () => png }; };
    const jobs = [];
    const render = async list => { jobs.push(...list); for (const j of list) fs.writeFileSync(j.out, 'rendered'); return { drawn: list.length, failed: [] }; };
    await P.drawCovers({ targets, dir: { raw, out, flags, state: path.join(dir, 'state.json') }, today: '2026-10-13', version: 'test', render, fetchImpl, sleepImpl: async () => {} });
    assert.deepEqual(asked, ['jp.png'], 'the flag picture was fetched');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].flag, path.join(flags, 'jp.png'));
    assert.equal(jobs[0].year, 1963);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Added 13/10/2026, same receipt: mutation 8 survived. build.js stopped handing the resolved personal membership (watchlistIds) to the cover
// step, and no test noticed: the unit tests above feed collectTargets() by hand, so a real build would have drawn no bookmark on any
// cover. This one runs the real offline build twice in a copy (no network, no Chrome): the first run only reads which films of the index
// are on the personal watchlist, the second has a gray raw cover for one of each and checks the published JPEGs at the bookmark's pixel.
test('watchlist poster: the real offline build draws the bookmark on a watchlist film and not on another', { timeout: 240000 }, () => {
  const root = path.join(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-build-'));
  try {
    for (const rel of ['tools', 'lib', 'web', 'scripts', 'cache', 'data', 'build.js', 'verify.js', 'config.json', 'learning.config.json']) fs.cpSync(path.join(root, rel), path.join(temp, rel), { recursive: true });
    fs.mkdirSync(path.join(temp, '.context'));
    const raw = path.join(temp, 'cache/posters-raw'), drawn = path.join(temp, 'cache/posters-out');
    for (const d of [raw, drawn]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d); }
    fs.rmSync(path.join(temp, 'cache/posters.json'), { force: true });
    const build = out => {
      const r = spawnSync(process.execPath, ['build.js', '--offline', '--cache-only', '--no-chrome', '--captured-at', '2026-10-12T12:00:00.000Z', '--out', out],
        { cwd: temp, env: { ...process.env, SKIP_RSS: '1', MOOD_DATE: '2026-10-12', PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
      assert.equal(r.status, 0, r.stderr.slice(-2000));
    };
    build(path.join(temp, 'first'));
    const films = require('../lib/index-rows').decode(JSON.parse(fs.readFileSync(path.join(temp, 'first/data/index.json')))).films;
    const own = films.find(f => f.watchlist === true), other = films.find(f => f.watchlist !== true);
    assert.ok(own && other, 'the index has a watchlist film and a film that is not');
    const make = spawnSync('python3', ['-c', `
import sys
from PIL import Image
for tt in sys.argv[1:]:
    Image.new('RGB', (500, 750), (200, 200, 200)).save('${raw.replace(/\\/g, '/')}/' + tt + '.jpg', quality=95)
`, own.tt, other.tt], { encoding: 'utf8' });
    assert.equal(make.status, 0, make.stderr);
    build(path.join(temp, 'second'));
    const pixel = tt => spawnSync('python3', ['-c', `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
print(sum(im.getpixel((329, 25))))
`, path.join(temp, 'second/posters', tt + '.jpg')], { encoding: 'utf8' });
    const dark = tt => { const r = pixel(tt); assert.equal(r.status, 0, r.stderr); return Number(r.stdout) < 150; };
    assert.equal(dark(own.tt), true, 'the watchlist film got the bookmark pill at the top right');
    assert.equal(dark(other.tt), false, 'the other film has the corner free');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

// 13/10/2026, adversarial review: build.js called collectTargets() before its try, and collectTargets() throws ("Planned cover missing from full index",
// "Invalid cover identity"), so a plan the index could not cover stopped the whole build, with --skip-posters too, against the promise of the cover step
// ("nothing in it can stop the build"). The real offline build is run in a copy with collectTargets patched to throw when it is given an index.
test('watchlist poster: a plan that cannot become cover targets does not stop the build; --skip-posters never asks for targets', { timeout: 240000 }, () => {
  const root = path.join(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-targets-'));
  try {
    for (const rel of ['tools', 'lib', 'web', 'scripts', 'cache', 'data', 'build.js', 'verify.js', 'config.json', 'learning.config.json']) fs.cpSync(path.join(root, rel), path.join(temp, rel), { recursive: true });
    fs.mkdirSync(path.join(temp, '.context'));
    for (const d of ['cache/posters-raw', 'cache/posters-out']) { fs.rmSync(path.join(temp, d), { recursive: true, force: true }); fs.mkdirSync(path.join(temp, d)); }
    fs.rmSync(path.join(temp, 'cache/posters.json'), { force: true });
    const wrapper = `const PO = require('./lib/posters'), real = PO.collectTargets;
      PO.collectTargets = (plan, o) => { if (o && o.index) { console.log('__TARGETS_ASKED__'); throw new Error('Planned cover missing from full index: tt1'); } return real(plan, o); };
      process.argv = [process.execPath, 'build.js', '--offline', '--cache-only', '--no-chrome', '--captured-at', '2026-10-12T12:00:00.000Z', ...JSON.parse(process.env.EXTRA_ARGS)];
      require('./build.js');`;
    const run = (out, extra) => spawnSync(process.execPath, ['-e', wrapper], { cwd: temp, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, SKIP_RSS: '1', MOOD_DATE: '2026-10-12', PYTHONDONTWRITEBYTECODE: '1', EXTRA_ARGS: JSON.stringify(['--out', out, ...extra]) } });
    const broken = run(path.join(temp, 'broken'), []);
    assert.equal(broken.status, 0, broken.stderr.slice(-1500));
    assert.match(broken.stdout, /__TARGETS_ASKED__/);
    assert.match(broken.stdout, /! Covers: Planned cover missing from full index: tt1 — every film keeps the cover address it had/);
    assert.ok(fs.existsSync(path.join(temp, 'broken/data/index.json')) && fs.existsSync(path.join(temp, 'broken/manifest.json')), 'the addon files are published all the same');
    const skipped = run(path.join(temp, 'skipped'), ['--skip-posters']);
    assert.equal(skipped.status, 0, skipped.stderr.slice(-1500));
    assert.doesNotMatch(skipped.stdout, /__TARGETS_ASKED__/, '--skip-posters does not build targets');
    assert.match(skipped.stdout, /Covers: skipped \(--skip-posters\)/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
