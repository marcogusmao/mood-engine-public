// node --test
// P0 (13/10/2026): import-letterboxd.js used to delete data/letterboxd BEFORE checking that the zip held watched.csv, so a wrong
// zip destroyed the data already there. Now the zip is unpacked and checked in a temp folder, and the output folder is only
// swapped once the export is known to be good.
//   1. a zip without watched.csv: exit code != 0, and the existing output folder (with a sentinel file) is intact byte for byte.
//   2. a minimal valid zip (the 5 CSVs the script keeps, each with a header): output filled, old sentinel gone, output folder mode
//      the same as a folder made with mkdir (not mkdtemp's 0700).
//   3. review of 13/10/2026: the move of the new folder into place fails -> old data restored (exit 1, no letterboxd.old-* left);
//      restoring fails too -> the message names the folder holding the old data; deleting the old data after a good swap fails ->
//      exit 0 with a warning; an unexpected error while copying -> output intact. In every case the script's own temp folders
//      (TMPDIR points at an empty folder of the test) and the folders next to the output are gone.
// Faults are injected into the child process by test-support/import-letterboxd-faults.js (NODE_OPTIONS=--require).
// No network. The zip is built with the system `zip`, the script unpacks with the system `unzip`.
// IMPORT_SCRIPT points the test at another copy of the script (used to show case 1 failing against the pre-fix original).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

const SCRIPT = process.env.IMPORT_SCRIPT ? path.resolve(process.env.IMPORT_SCRIPT) : path.join(__dirname, "..", "import-letterboxd.js");
const KEEP = ["watched.csv", "ratings.csv", "diary.csv", "watchlist.csv", "likes/films.csv"];

/** A temp work folder with `export/` (files to zip), `out/` (a pre-existing output with a sentinel) and the zip path. */
function scenario(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lbx-test-"));
  const exp = path.join(root, "export");
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(exp, rel)), { recursive: true });
    fs.writeFileSync(path.join(exp, rel), text);
  }
  const zip = path.join(root, "export.zip");
  execFileSync("zip", ["-q", "-r", zip, "."], { cwd: exp });
  const tmpdir = path.join(root, "tmp"); // the script's TMPDIR: must be empty again when it exits
  fs.mkdirSync(tmpdir);
  const out = path.join(root, "data", "letterboxd");
  fs.mkdirSync(out, { recursive: true });
  const sentinel = path.join(out, "sentinel.txt");
  fs.writeFileSync(sentinel, "keep me\n\x00\xff");
  return { root, zip, out, tmpdir, sentinel, sentinelBytes: fs.readFileSync(sentinel) };
}
const FAULTS = path.join(__dirname, "..", "test-support", "import-letterboxd-faults.js");
/** Runs the script on the scenario's zip. `faults` are env vars read by the preload (FAIL_RENAME_CALLS, FAIL_COPY, FAIL_RM_OLD). */
const run = (s, faults = {}) => spawnSync(process.execPath, [SCRIPT, s.zip], {
  env: { ...process.env, LETTERBOXD_OUT_DIR: s.out, TMPDIR: s.tmpdir, ...faults, ...(Object.keys(faults).length ? { NODE_OPTIONS: `--require ${FAULTS}` } : {}) },
  encoding: "utf8",
});
/** Nothing of the script is left: its temp folder is empty and only the output folder sits in data/ (no staging, no .old-*). */
function assertNoLeftovers(s, { allow = [], outExists = true } = {}) {
  assert.deepEqual(fs.readdirSync(s.tmpdir), [], "the script left its temp folder behind");
  assert.deepEqual(fs.readdirSync(path.dirname(s.out)).sort(), [...(outExists ? ["letterboxd"] : []), ...allow].sort(), "staging or aside folders were left next to the output");
}
const validFiles = () => { const f = {}; for (const rel of KEEP) f[rel] = `Date,Name,Year,Letterboxd URI\n2026-01-01,Film ${rel},2020,https://boxd.it/${rel.length}\n`; return f; };
const cleanup = (s) => fs.rmSync(s.root, { recursive: true, force: true });

test("a zip without watched.csv exits non-zero and leaves the existing output folder untouched", () => {
  const s = scenario({ "profile.csv": "Date Joined,Username\n2020-01-01,x\n", "ratings.csv": "Date,Name,Year,Letterboxd URI,Rating\n" });
  try {
    const r = run(s);
    assert.notEqual(r.status, 0, `expected a failure exit, got ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /watched\.csv/);
    assert.ok(fs.existsSync(s.sentinel), "the sentinel file in the old output was deleted");
    assert.deepEqual(fs.readFileSync(s.sentinel), s.sentinelBytes);
    assert.deepEqual(fs.readdirSync(s.out), ["sentinel.txt"], "the old output folder gained or lost files");
    assertNoLeftovers(s);
  } finally { cleanup(s); }
});

test("a file that is not a zip at all also leaves the existing output folder untouched", () => {
  const s = scenario({ "watched.csv": "Date,Name,Year,Letterboxd URI\n" });
  try {
    fs.writeFileSync(s.zip, "this is not a zip");
    const r = run(s);
    assert.notEqual(r.status, 0);
    assert.ok(fs.existsSync(s.sentinel), "the sentinel file in the old output was deleted");
    assert.deepEqual(fs.readFileSync(s.sentinel), s.sentinelBytes);
    assertNoLeftovers(s);
  } finally { cleanup(s); }
});

test("a minimal valid zip fills the output and removes the old content", () => {
  const files = validFiles();
  files["profile.csv"] = "Email,Name\nprivate@example.com,Private\n"; // must never be copied
  const s = scenario(files);
  try {
    const r = run(s);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /Imported 5 files/);
    assert.ok(!fs.existsSync(s.sentinel), "the old sentinel should be gone after a valid import");
    for (const rel of KEEP) {
      assert.ok(fs.existsSync(path.join(s.out, rel)), `${rel} was not imported`);
      assert.equal(fs.readFileSync(path.join(s.out, rel), "utf8"), files[rel], rel);
    }
    assert.ok(!fs.existsSync(path.join(s.out, "profile.csv")), "profile.csv must stay in the zip");
    assertNoLeftovers(s);
    // mkdtemp makes 0700; a folder made with mkdir under the same umask is what the output used to be.
    const ref = path.join(s.root, "reference"); fs.mkdirSync(ref);
    assert.equal(fs.statSync(s.out).mode & 0o777, fs.statSync(ref).mode & 0o777, "the output folder has a different mode from a mkdir folder");
    assert.equal(fs.statSync(path.join(s.out, "likes")).mode & 0o777, fs.statSync(ref).mode & 0o777);
  } finally { cleanup(s); }
});

test("a valid import into a folder that does not exist yet creates it", () => {
  const s = scenario(validFiles());
  try {
    fs.rmSync(s.out, { recursive: true });
    const r = run(s);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.ok(fs.existsSync(path.join(s.out, "watched.csv")));
  } finally { cleanup(s); }
});

test("if moving the new folder into place fails, the old data is put back (exit 1, nothing left behind)", () => {
  const s = scenario(validFiles());
  try {
    const r = run(s, { FAIL_RENAME_CALLS: "2" });
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /previous data was kept/);
    assert.ok(fs.existsSync(s.sentinel), "the old data was not restored");
    assert.deepEqual(fs.readFileSync(s.sentinel), s.sentinelBytes);
    assert.deepEqual(fs.readdirSync(s.out), ["sentinel.txt"]);
    assertNoLeftovers(s);
  } finally { cleanup(s); }
});

test("if the restore fails too, the message names the folder that holds the old data and the first error", () => {
  const s = scenario(validFiles());
  try {
    const r = run(s, { FAIL_RENAME_CALLS: "2,3" });
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stderr, /previous data was kept/);
    assert.match(r.stderr, /injected rename failure #2/);
    const aside = fs.readdirSync(path.dirname(s.out)).filter((f) => f.startsWith("letterboxd.old-"));
    assert.equal(aside.length, 1, "the old data should be in letterboxd.old-<pid>");
    assert.ok(r.stderr.includes(path.join(path.dirname(s.out), aside[0])), `the message does not name ${aside[0]}\n${r.stderr}`);
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(s.out), aside[0], "sentinel.txt")), s.sentinelBytes);
    assertNoLeftovers(s, { allow: aside, outExists: false });
  } finally { cleanup(s); }
});

test("if deleting the old data after a good swap fails, the import still counts (exit 0) and the warning names where the old data is", () => {
  const s = scenario(validFiles());
  try {
    const r = run(s, { FAIL_RM_OLD: "1" });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Imported, but the previous data could not be deleted/);
    assert.ok(fs.existsSync(path.join(s.out, "watched.csv")));
    assert.ok(!fs.existsSync(s.sentinel));
    const aside = fs.readdirSync(path.dirname(s.out)).filter((f) => f.startsWith("letterboxd.old-"));
    assert.equal(aside.length, 1);
    assert.ok(r.stderr.includes(aside[0]));
    assertNoLeftovers(s, { allow: aside });
  } finally { cleanup(s); }
});

test("an unexpected error before the watched.csv check leaves the output intact and removes the script's temp folders", () => {
  const s = scenario(validFiles());
  try {
    const r = run(s, { FAIL_COPY: "1" });
    assert.notEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /injected copy failure/);
    assert.ok(fs.existsSync(s.sentinel), "the old data was touched");
    assert.deepEqual(fs.readFileSync(s.sentinel), s.sentinelBytes);
    assertNoLeftovers(s);
  } finally { cleanup(s); }
});
