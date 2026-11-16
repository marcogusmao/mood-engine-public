#!/usr/bin/env node
// A stand-in for `chrome --headless=new … --dump-dom <url>` (test/chrome.test.js; it lives outside test/ because `node --test` would run every .js file in there). What it does depends on the last word of the
// address's path; like the real one it does NOT exit after printing, and it has a child of its own, so the tests can prove that the
// whole process group is killed. Env: FAKE_LOG (a file: one JSON line per call), FAKE_STATE (a folder: a counter per path).
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const args = process.argv.slice(2);
const url = new URL(args[args.length - 1]);
const kind = url.pathname.split("/").filter(Boolean).pop() || "root";
const log = (o) => process.env.FAKE_LOG && fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ at: Date.now(), kind, ...o }) + "\n");
const page = (title, body = "") => `<html><head><title>${title}</title></head><body>${body}${" ".repeat(400)}</body></html>\n`;
const poster = (slug, name) => `<li class="griditem"><div data-item-name="${name}" data-item-slug="${slug}"><img alt="${name.replace(/ \(\d+\)$/, "")}"/></div></li>`;
const counter = () => {
  const f = path.join(process.env.FAKE_STATE || require("os").tmpdir(), `fake-chrome-${kind}`);
  const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0) + 1;
  fs.writeFileSync(f, String(n));
  return n;
};

const child = spawn("sleep", ["300"], { stdio: "ignore" }); // same process group as this script: the group kill must reach it
log({ event: "start", pid: process.pid, child: child.pid, args, secrets: Object.keys(process.env).filter((k) => /TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL/i.test(k) && !/^FAKE_/.test(k)) }); // 21/10/2026: names only, never the values
setInterval(() => {}, 1000); // never exits by itself, like Chrome in some versions

const say = (text) => { log({ event: "printed" }); process.stdout.write(text); }; // logged first: the page is killed as soon as it arrives
const after = (ms, fn) => setTimeout(fn, ms);

if (kind === "hang") { /* prints nothing at all */ }
else if (kind === "exits") { log({ event: "exit" }); process.exit(1); }
else if (kind === "challenge") say(page("Just a moment...", "<p>Enable JavaScript and cookies to continue</p>"));
else if (kind === "missing") say(page("Letterboxd - Not Found"));
else if (kind === "flaky") say(counter() === 1 ? page("Just a moment...") : page("Fine", poster("a", "A (2000)")));
else if (kind === "slow") after(400, () => say(page("Slow", poster("s", "S (2001)"))));
else if (kind === "shell") say(page("Browse Films", '<div class="csi js-csi" data-src="/csi/films/films-browser-list/popular/this/week/?esiAllowFilters=true">Calculating…</div>'));
else if (url.pathname.startsWith("/csi/")) say(page("fragment", `<ul class="grid">${poster("one", "One (1999)")}${poster("two", "Two (2001)")}</ul>`));
else say(page("Fine", `<ul class="grid">${poster("a", "A (2000)")}</ul>`));
