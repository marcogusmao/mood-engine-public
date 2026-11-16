'use strict';
// Preload for the server process under test (NODE_OPTIONS=--require test/guard.cjs): every way this server could write to disk,
// open or accept a connection, ask a name server or start a process is replaced by a function that writes `GUARD-VIOLATION <name>` to stderr and throws.
// Writes to fd 1 and 2 (the protocol and the log line) stay allowed. Read-only fs calls are untouched.
// Proven alive by test/guard.test.js (a script that tries each of them and must be accused). Not loaded in production.

const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const http2 = require('node:http2');
const tls = require('node:tls');
const dns = require('node:dns');
const dgram = require('node:dgram');
const cp = require('node:child_process');

const say = fs.writeSync.bind(fs); // kept before fs.writeSync is replaced
const violation = (name) => {
  say(2, `GUARD-VIOLATION ${name}\n`);
  return new Error(`GUARD-VIOLATION ${name}`);
};
const deny = (owner, key, label) => {
  if (typeof owner[key] !== 'function') return;
  owner[key] = function guarded() { throw violation(`${label}.${key}`); };
};

const WRITERS = ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rename', 'rm', 'rmdir', 'unlink', 'copyFile', 'cp', 'truncate', 'ftruncate',
  'symlink', 'link', 'chmod', 'chown', 'utimes', 'futimes', 'lutimes', 'lchown', 'lchmod', 'fchmod', 'fchown', 'fsync', 'fdatasync', 'writev', 'createWriteStream'];
for (const w of WRITERS) { deny(fs, w, 'fs'); deny(fs, `${w}Sync`, 'fs'); deny(fs.promises, w, 'fs.promises'); }

// An open for writing is a write: flags with w, a or +, or the numeric O_WRONLY / O_RDWR / O_CREAT / O_TRUNC / O_APPEND bits.
const writeFlag = (f) => (typeof f === 'string' ? /[wa+]/.test(f) : typeof f === 'number' ? (f & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0 : false);
for (const key of ['openSync', 'open']) {
  const real = fs[key];
  fs[key] = function guardedOpen(p, flags, ...rest) {
    if (writeFlag(flags)) throw violation(`fs.${key}(write)`);
    return real.call(fs, p, flags, ...rest);
  };
}
{
  const real = fs.promises.open;
  fs.promises.open = function guardedOpen(p, flags, ...rest) {
    if (writeFlag(flags)) throw violation('fs.promises.open(write)');
    return real.call(fs.promises, p, flags, ...rest);
  };
}
for (const key of ['writeSync', 'write']) {
  const real = fs[key];
  fs[key] = function guardedWrite(fd, ...rest) {
    if (fd === 1 || fd === 2) return real.call(fs, fd, ...rest);
    throw violation(`fs.${key}(fd ${typeof fd === 'number' ? 'n' : '?'})`);
  };
}

deny(net, 'connect', 'net'); deny(net, 'createConnection', 'net');
deny(net.Socket.prototype, 'connect', 'net.Socket.prototype');
deny(tls, 'connect', 'tls');
deny(http, 'request', 'http'); deny(http, 'get', 'http');
deny(https, 'request', 'https'); deny(https, 'get', 'https');
deny(http2, 'connect', 'http2');
deny(dgram, 'createSocket', 'dgram');
deny(dns, 'lookup', 'dns'); deny(dns.promises, 'lookup', 'dns.promises');
// B3 (review 12/10/2026): a server could also listen, or ask a name server directly (resolve*, reverse, lookupService — callbacks, promises, Resolver).
deny(net, 'createServer', 'net'); deny(net.Server.prototype, 'listen', 'net.Server.prototype');
const DNS_QUERY = /^(resolve|reverse|lookupService)/;
for (const owner of [[dns, 'dns'], [dns.promises, 'dns.promises'], [dns.Resolver.prototype, 'dns.Resolver.prototype'], [dns.promises.Resolver.prototype, 'dns.promises.Resolver.prototype']])
  for (const key of Object.getOwnPropertyNames(owner[0])) if (DNS_QUERY.test(key)) deny(owner[0], key, owner[1]);
if (typeof globalThis.fetch === 'function') globalThis.fetch = function guardedFetch() { throw violation('fetch'); };
for (const k of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) deny(cp, k, 'child_process');
