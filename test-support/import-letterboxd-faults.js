'use strict';
// Preload for test/import-letterboxd.test.js (NODE_OPTIONS=--require): makes chosen fs calls fail inside the child process.
//   FAIL_RENAME_CALLS=2,3  the 2nd and 3rd fs.renameSync calls throw (1st = old output aside, 2nd = new into place, 3rd = restore)
//   FAIL_COPY=1            fs.copyFileSync throws (an unexpected error before the watched.csv check)
//   FAIL_RM_OLD=1          fs.rmSync throws for a path holding ".old-" (deleting the previous data after a good swap)
const fs = require('node:fs');
const failing = new Set((process.env.FAIL_RENAME_CALLS || '').split(',').filter(Boolean).map(Number));
if (failing.size) {
  const real = fs.renameSync; let calls = 0;
  fs.renameSync = function (...a) { calls++; if (failing.has(calls)) throw new Error(`injected rename failure #${calls}`); return real.apply(this, a); };
}
if (process.env.FAIL_COPY) fs.copyFileSync = function () { throw new Error('injected copy failure'); };
if (process.env.FAIL_RM_OLD) {
  const real = fs.rmSync;
  fs.rmSync = function (p, ...a) { if (String(p).includes('.old-')) throw new Error('injected rm failure'); return real.call(this, p, ...a); };
}
