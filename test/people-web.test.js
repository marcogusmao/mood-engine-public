const test = require('node:test');
const a = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const UI = require('../web/feedback');
const Core = require('../lib/learning/feedback');
const S = require('../lib/learning/schema');
const { publish } = require('../lib/publish');
const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
const at = '2026-10-14T12:00:00.000Z';
const tick = () => new Promise(resolve => setImmediate(resolve));
const memory = () => ({ load: async () => ({ events: [], candidateSets: [] }), save: async () => {} });
const controller = (owner = 'mgusmao', extra = {}) => UI.createController({ owner, storage: memory(), clock: () => at, hash: async x => S.hash(x), uuid: () => crypto.randomUUID(), ...extra });

// A transaction finishes asynchronously, after getAll/put; databases are keyed by the actual open name.
// Mutation receipt, 2026-10-14, Node 22.23.3:
// Replaced indexedStore's owner-based database name with mood-learning-v1 for both owners.
// --test --test-name-pattern='IndexedDB separates owners' test/people-web.test.js:
// 0 pass, 1 fail, exit 1, ERR_ASSERTION: Will loaded [{eventId:'marco-only'}] instead of [].
// Restored feedback.js byte-for-byte; the final three-file acceptance run is reported in the handoff.
function indexedFixture() {
  const databases = new Map(), opened = [];
  return { opened, open(name, version) {
    opened.push([name, version]);
    const request = {};
    queueMicrotask(() => {
      const fresh = !databases.has(name);
      if (fresh) databases.set(name, new Map());
      const stores = databases.get(name);
      request.result = {
        createObjectStore: key => stores.set(key, new Map()),
        transaction() {
          const tx = { objectStore(key) { return {
            getAll: () => ({ result: [...stores.get(key).values()] }),
            put: value => stores.get(key).set(value.eventId || value.id, structuredClone(value))
          }; } };
          queueMicrotask(() => tx.oncomplete());
          return tx;
        }
      };
      if (fresh) request.onupgradeneeded();
      request.onsuccess();
    });
    return request;
  } };
}

test('IndexedDB separates owners, retains Marco legacy name and never falls back for Will', async () => {
  const idb = indexedFixture();
  const marco = UI.indexedStore(idb), will = UI.indexedStore(idb, 'friend-a');
  await marco.save([{ eventId: 'marco-only' }], []);
  a.deepEqual(await will.load(), { events: [], candidateSets: [] });
  await will.save([{ eventId: 'will-only' }], []);
  a.deepEqual((await UI.indexedStore(idb).load()).events, [{ eventId: 'marco-only' }]);
  a.deepEqual((await UI.indexedStore(idb, 'friend-a').load()).events, [{ eventId: 'will-only' }]);
  a.deepEqual(idb.opened.map(x => x[0]), ['mood-learning-v1', 'mood-learning-v1:friend-a', 'mood-learning-v1', 'mood-learning-v1:friend-a']);
  const failedNames = [];
  await a.rejects(UI.indexedStore({ open(name) { failedNames.push(name); const r = {}; queueMicrotask(() => r.onerror()); return r; } }, 'friend-a').load());
  a.deepEqual(failedNames, ['mood-learning-v1:friend-a']);
});

test('unknown owners and Will remote adapters are refused before storage calls', () => {
  const storage = { load() { a.fail('storage opened'); }, save() { a.fail('storage opened'); } };
  for (const owner of ['', 'other', null, '__proto__']) {
    a.throws(() => UI.indexedStore({ open() { a.fail('database opened'); } }, owner), /Unknown page owner/);
    a.throws(() => controller(owner, { storage }), /Unknown page owner/);
  }
  a.throws(() => controller('friend-a', { storage, adapter: {} }), /owner protocol/);
});

test('Will backup wraps a validated legacy batch; owner and hash failures preserve state', async () => {
  const marco = controller(), will = controller('friend-a');
  await marco.record('not_for_me', 'tt1');
  const candidates = await will.candidateSet(['tt2'], {});
  await will.record('seen', 'tt2', {}, { watchedDate: null }, { candidateSetId: candidates.id });
  const legacy = (await marco.exportBatches())[0], envelope = (await will.exportBatches())[0];
  a.equal(legacy.schemaVersion, 1);
  a.equal('owner' in legacy, false);
  a.deepEqual(Object.keys(envelope).sort(), ['batch', 'personId', 'schemaVersion']);
  a.equal(envelope.personId, 'friend-a'); a.equal(envelope.schemaVersion, 2);
  Core.validateBatch(envelope.batch);
  a.equal(envelope.batch.batchId, S.hash({ events: envelope.batch.events, candidateSets: envelope.batch.candidateSets }));
  const prior = JSON.stringify([will.events, will.candidateSets]);
  const corruptHash = structuredClone(envelope); corruptHash.batch.batchId = '0'.repeat(64);
  const invalidEvent = structuredClone(envelope); invalidEvent.batch.events[0].type = 'unknown';
  for (const bad of [legacy, {schemaVersion:2,owner:'friend-a',batch:envelope.batch}, { ...envelope, personId: 'mgusmao' }, { ...envelope, personId: 'other' }, { ...envelope, extra: true }, { ...envelope, schemaVersion: 1 }, corruptHash, invalidEvent]) {
    await a.rejects(will.importBatch(bad));
    a.equal(JSON.stringify([will.events, will.candidateSets]), prior);
  }
  const marcoPrior = JSON.stringify(marco.events);
  await a.rejects(marco.importBatch(envelope), /another owner/);
  a.equal(JSON.stringify(marco.events), marcoPrior);
  const restored = controller('friend-a');
  await restored.importBatch(envelope); await restored.importBatch(envelope);
  a.deepEqual(restored.events, will.events);
  a.equal(restored.state().seen.has('tt2'), true);
  await marco.importBatch(legacy); a.equal(marco.events.length, 1);
});

test('legacy skip migration reads only Marco and never reads a legacy key for Will', async () => {
  let reads = 0;
  const local = { getItem() { reads++; return '[1]'; } };
  const will = controller('friend-a'), marco = controller();
  await will.migrate(local, [{ t: 1, i: 'tt1' }]);
  a.equal(reads, 0); a.equal(will.events.length, 0);
  await marco.migrate(local, [{ t: 1, i: 'tt1' }]);
  a.equal(reads, 1); a.equal(marco.events.length, 1);
});

function element() {
  return { disabled: true, hidden: true, textContent: '', innerHTML: '', value: '70', focus() { this.focused = true; }, select() { this.selected = true; }, addEventListener() {}, querySelectorAll: () => [] };
}
function installFixture(navigator = {}) {
  const install = element(), copy = element(), field = element(), fallback = element(), status = element();
  const location = { href: 'https://fixture.invalid/people/friend-a/?query=1#part' };
  return { install, copy, field, fallback, status, location, control: UI.installation({ install, copy, field, fallback, status, location, navigator }) };
}
test('install/copy are gated, manifest stays in the current directory, clipboard fallback selects URL', async () => {
  const f = installFixture();
  a.equal(f.install.disabled, true); a.equal(f.copy.disabled, true);
  await f.copy.onclick(); f.install.onclick();
  a.equal(f.field.selected, undefined); a.match(f.location.href, /query/);
  f.control.setReady(true); a.equal(f.install.disabled, false); a.equal(f.copy.disabled, false);
  await f.copy.onclick();
  a.equal(f.fallback.hidden, false); a.equal(f.field.focused, true); a.equal(f.field.selected, true);
  a.equal(f.field.value, 'https://fixture.invalid/people/friend-a/manifest.json');
  a.match(f.status.textContent, /Copy unavailable/); a.doesNotMatch(f.status.textContent, /copied/);
  f.install.onclick(); a.equal(f.location.href, 'stremio://fixture.invalid/people/friend-a/manifest.json');
  f.control.setReady(false); a.equal(f.copy.disabled, true); a.equal(f.fallback.hidden, true);
});
test('copy confirms only after clipboard write resolves; rejected writes show fallback', async () => {
  let resolveWrite, copied;
  const f = installFixture({ clipboard: { writeText: value => { copied = value; return new Promise(resolve => { resolveWrite = resolve; }); } } });
  f.control.setReady(true); const pending = f.copy.onclick();
  a.doesNotMatch(f.status.textContent, /copied/);
  resolveWrite(); await pending;
  a.equal(copied, 'https://fixture.invalid/people/friend-a/manifest.json'); a.equal(f.status.textContent, 'Addon URL copied');
  const rejected = installFixture({ clipboard: { writeText: async () => { throw Error('denied'); } } });
  rejected.control.setReady(true); await rejected.copy.onclick(); a.equal(rejected.field.selected, true);
});

// Executes the shipped inline script with narrow DOM/transport fixtures; no browser or network.
function page(owner, answer) {
  const nodes = new Map();
  const get = key => { if (!nodes.has(key)) nodes.set(key, element()); return nodes.get(key); };
  const sessions = new Map([['mood-session', 'marco-session']]), sessionCalls = [], owners = [];
  let fetches = 0, localReads = 0;
  const document = { body: { dataset: { owner, willApiOrigin:'https://worker.fixture.invalid' } }, querySelector: get, querySelectorAll: () => [], title: 'Mood Engine' };
  const sandbox = { document, URL, navigator: {}, location: { href: 'https://fixture.invalid/people/friend-a/' }, crypto, console,
    fetch: async url => { if(String(url).endsWith('person.json'))return {ok:true,json:async()=>personContext};fetches++; const response=typeof answer==='function'?await answer():{ok:true,json:async()=>answer};if(response.ok){const json=response.json;response.json=async()=>({...await json(),meta:{personId:'friend-a',revision}});}return response; },
    MoodPerson:require('../web/person'), MoodUpload:{mount:options=>options.onPublication(active)}, history:{replaceState(){}},
    sessionStorage: { getItem(key) { sessionCalls.push(['get', key]); return sessions.get(key); }, setItem(key, value) { sessionCalls.push(['set', key]); sessions.set(key, value); } },
    localStorage: { getItem() { localReads++; return '[]'; } },
    window: { indexedDB: {}, addEventListener() {} }, setTimeout: () => 0,
    MoodFeedback: Core, MoodSelector: { rank: () => [] },
    MoodFeedbackUI: { ...UI, indexedStore(idb, selectedOwner) { owners.push(['store', selectedOwner]); return memory(); }, createController(options) { owners.push(['controller', options.owner]); return controller(options.owner, { ...options, hash: async x => S.hash(x) }); } }
  };
  vm.runInNewContext(html.match(/<script>\s*([\s\S]*?)<\/script>/)[1], sandbox);
  return { get, document, sessions, sessionCalls, owners, get fetches() { return fetches; }, get localReads() { return localReads; } };
}
const revision='r-'+'1'.repeat(32), active={revision,publishedAt:at,pagePath:'/mood-engine/u/friend-a/',releasePath:`/mood-engine/u/friend-a/r/${revision}/`,addonPath:'/u/friend-a/manifest.json'};
const personContext={schemaVersion:1,personId:'friend-a',letterboxdUser:'friend-a',revision,dataBase:'./data/',addonPath:'/u/friend-a/manifest.json',inputUpdatedAt:at,coverage:{history:'export',likes:'unknown'}};
const emptyData = { generated: at, today: '2026-10-14', stats: { watched: 0 }, films: [], rewatch: [], moods: [], tonight: [] };
test('shipped page waits for fetch and recovers from a failed request through Retry', async () => {
  let resolveFetch, attempts = 0;
  const p = page('friend-a', () => {
    attempts++;
    if (attempts === 1) return new Promise(resolve => { resolveFetch = resolve; });
    return { ok: true, json: async () => emptyData };
  });
  a.equal(p.get('#install').disabled, true); a.equal(p.get('#copyManifest').disabled, true);
  a.equal(p.owners.length, 0);
  await tick(); resolveFetch({ ok: false }); await tick();
  a.equal(p.get('#install').disabled, true); a.equal(p.owners.length, 0);
  await p.get('#retry').onclick();
  a.equal(attempts, 2); a.equal(p.get('#install').disabled, false); a.equal(p.get('#copyManifest').disabled, false);
});
test('shipped page passes explicit owner, isolates initial/New session and identifies Will', async () => {
  const will = page('friend-a', emptyData); await tick();
  a.deepEqual(will.owners, [['store', 'friend-a'], ['controller', 'friend-a']]);
  a.equal(will.document.title, 'Will’s Mood Engine'); a.equal(will.get('#brand').textContent, 'Will’s Mood Engine');
  a.equal(will.get('#ownerLink').href, 'https://letterboxd.com/friend-a/');
  a.equal(will.localReads, 0); a.equal(will.get('#install').disabled, false);
  const oldSession = will.sessions.get('mood-session:friend-a');
  will.get('#newSession').onclick();
  a.notEqual(will.sessions.get('mood-session:friend-a'), oldSession);
  a.equal(will.sessions.get('mood-session'), 'marco-session');
  a(will.sessionCalls.every(([, key]) => key === 'mood-session:friend-a'));
  const marco = page('mgusmao', emptyData); await tick();
  marco.get('#newSession').onclick();
  a(marco.sessionCalls.every(([, key]) => key === 'mood-session'));
  a.equal(marco.localReads, 1);
});
test('shipped page rejects unknown owner without fetch/storage and provides native Retry; invalid data stays disabled', async () => {
  const unknown = page('nobody', emptyData); await tick();
  a.equal(unknown.fetches, 0); a.equal(unknown.owners.length, 0); a.equal(unknown.sessionCalls.length, 0);
  a.equal(unknown.get('#install').disabled, true); a.match(unknown.get('#stage').innerHTML, /<button[^>]+id="retry"/);
  unknown.get('#retry').onclick(); await tick(); a.equal(unknown.fetches, 0);
  const invalid = page('friend-a', {}); await tick();
  a.equal(invalid.get('#install').disabled, true); a.equal(invalid.get('#copyManifest').disabled, true);
  a.equal(invalid.owners.length, 0); a.doesNotMatch(invalid.get('#stage').innerHTML, /build.*running/);
});

test('publisher selects Will only for exact letterboxd; data bytes stay equal and bad marker retains previous output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'people-web-'));
  const webDir = path.join(__dirname, '../web');
  const cfg = { addon: { id: 'fixture', version: '1.0.0', name: 'Fixture', description: 'Artificial fixture' } };
  const run = (name, config, web = webDir) => { const outDir = path.join(root, name); publish({ outDir, webDir: web, cfg: config, plan: { board: [{ id: 'fixture-row', name: 'Fixture row', items: [{ id: 'tt3', title: 'Fixture film', year: 2000, why: [] }] }], discover: [] }, webData: require('./fixtures/learning/public-engine.json') }); return outDir; };
  try {
    const baseline = run('baseline', cfg), marco = run('marco', { ...cfg, letterboxd: 'mgusmao' }), will = run('will', { ...cfg, letterboxd: 'friend-a' });
    a.match(fs.readFileSync(path.join(will, 'index.html'), 'utf8'), /<body data-owner="friend-a" data-will-api-origin="">/);
    a.equal(fs.readFileSync(path.join(marco, 'index.html'), 'utf8'), html);
    for (const rel of ['data/engine.json', 'catalog/movie/fixture-row.json', 'manifest.json', 'assets/feedback.js', 'assets/selector.js', 'assets/feedback-core.js']) {
      a.deepEqual(fs.readFileSync(path.join(baseline, rel)), fs.readFileSync(path.join(marco, rel)));
      a.deepEqual(fs.readFileSync(path.join(baseline, rel)), fs.readFileSync(path.join(will, rel)));
    }
    const other = run('other', { ...cfg, letterboxd: 'friend-a-other' });
    a.match(fs.readFileSync(path.join(other, 'index.html'), 'utf8'), /data-owner="mgusmao"/);
    const fixtureWeb = path.join(root, 'web'); fs.mkdirSync(fixtureWeb);
    for (const name of ['selector.js', 'feedback.js']) fs.copyFileSync(path.join(webDir, name), path.join(fixtureWeb, name));
    for (const modified of [html.replace('data-owner="mgusmao"', ''), html.replace('data-owner="mgusmao"', 'data-owner="mgusmao" data-owner="mgusmao"')]) {
      fs.writeFileSync(path.join(fixtureWeb, 'index.html'), modified);
      a.throws(() => run('will', { ...cfg, letterboxd: 'friend-a' }, fixtureWeb), /exactly one owner marker/);
      a.match(fs.readFileSync(path.join(will, 'index.html'), 'utf8'), /<body data-owner="friend-a" data-will-api-origin="">/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
