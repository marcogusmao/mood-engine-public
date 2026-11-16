'use strict';
// letterboxd-mcp — the live projection: built in memory at start, rebuilt in memory when the sources change. Never written.
// Uses store.signature (stat only) and store.readSources + project directly, not store.load, because load writes the index file.
// The research package (research/2026-10-12-film-research/) is read the same way, in memory, by src/research.js; its three files are part of the
// signature this module reports, and a change in them alone reloads the package without re-projecting the films. A package that is missing or
// unreadable never refuses a call: only film_research_evidence says `available: false`.
// The MUBI cache (<root>/cache/mubi.json or MOOD_MUBI, src/mubi.js) is read the same way and fixed at start like the snapshots folder; its stat is the third
// part of the signature, and a change in it alone reloads the cache without re-projecting the films and without inflating the research package again. A cache that
// is missing or unreadable never refuses a call: film_dossier says `unknown` with the reason in its three MUBI fields.
// Covered by test/state.test.js (re-projection on change, no write), test/research.test.js (the package reloads on change) and test/mubi.test.js (the cache does).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('../../films/store');
const { project } = require('../../films/project');
const { createAdapter } = require('./adapter');
const { loadResearch, researchSignature } = require('./research');
const { loadMubi, mubiSignature, mubiPathFor, mubiWhere } = require('./mubi');

/** Where the MUBI cache is, decided once: the file and the label film_health shows for it. Nothing here reads the environment again after start. */
const mubiSpot = (root, env) => ({ file: mubiPathFor(root, env), where: mubiWhere(env) });

/** The private snapshots folder is fixed at start from the environment or the root; a tool input can never name it. */
const snapshotsFor = (root, env = process.env) => path.resolve(env.MOOD_SNAPSHOTS || path.join(root, '.context', 'learning-private', 'snapshots'));

/** The signature every answer reports: the film sources and code (store.signature), the three files of the research package and the MUBI cache. */
const combine = (storeStamp, researchStamp, mubiStamp) => crypto.createHash('sha256').update(`${storeStamp}\n${researchStamp}\n${mubiStamp}`).digest('hex').slice(0, 16);

/** The MUBI cache as the adapter gets it: what loadMubi read, and where it came from (a label, never the path). */
const readMubi = (spot) => ({ ...loadMubi(spot.file), where: spot.where });

/** `spot` is the cache place resolved ONCE at start (createState): a rebuild must not read the environment again. Called alone, it resolves it from `env`. */
function build(root, env = process.env, spot = mubiSpot(root, env)) {
  const storeStamp = store.signature(root); // before reading: a source that changes mid-read is picked up by the next call
  const stamp = combine(storeStamp, researchSignature(root), mubiSignature(spot.file));
  const index = project(store.readSources(root));
  return { index, signature: stamp, storeStamp, research: loadResearch(root), mubi: readMubi(spot), builtAt: new Date().toISOString() };
}

function createState(root, env = process.env) {
  const snapshots = snapshotsFor(root, env);
  const spot = mubiSpot(root, env); // fixed here, at start: a tool input can never name it
  const make = (b) => ({ ...b, adapter: createAdapter({ ...b, root, snapshots }) });
  let current = make(build(root, env, spot));
  return {
    get current() { return current; },
    /**
     * Cheap on every call (a stat per source); re-projects only when the signature moved. When the sources changed and cannot be read
     * (a half-written cache, a merge marker), this REFUSES the call: it never answers from the projection of the old sources as if it
     * were current. `current` keeps the last good projection only so the next call can compare signatures; the server is not broken by
     * this and needs no restart. The next call tries again and answers as soon as the sources read again (a restart while they are still
     * broken would fail at start and take the server down).
     * If only the research package or the MUBI cache moved, the films are not re-projected: the one that moved is reloaded (neither throws; the other is kept as it
     * was read) and the adapter is rebuilt over the same index.
     */
    refresh() {
      const storeStamp = store.signature(root);
      const researchStamp = researchSignature(root), mubiStamp = mubiSignature(spot.file);
      const stamp = combine(storeStamp, researchStamp, mubiStamp);
      if (stamp === current.signature) return current;
      try {
        if (storeStamp === current.storeStamp) {
          const { index, builtAt } = current;
          const research = researchStamp === current.research.stamp ? current.research : loadResearch(root);
          const mubi = mubiStamp === current.mubi.stamp ? current.mubi : readMubi(spot);
          current = make({ index, builtAt, storeStamp, research, mubi, signature: stamp });
        } else current = make(build(root, env, spot));
      } catch (e) { throw new Error(`sources changed and could not be re-read (${e.code || e.name}); answers resume when the sources read again — do not restart while they are broken`); }
      return current;
    },
  };
}

function checkRoot(root) {
  if (!fs.existsSync(path.join(root, 'config.json'))) throw new Error(`root "${path.basename(root)}" has no config.json`);
}

module.exports = { createState, snapshotsFor, checkRoot, build };
