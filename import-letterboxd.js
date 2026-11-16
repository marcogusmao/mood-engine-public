#!/usr/bin/env node
// Copies ONLY the files the engine needs out of a Letterboxd export into data/letterboxd/.
// The export also contains profile.csv (your email, name), comments and reviews —
// those never leave the zip, so your public repo only holds what your public profile already shows.
//
//   node import-letterboxd.js ~/Downloads/letterboxd-mgusmao-2026-10-10.zip
//
// The zip is unpacked and checked in a temp directory first (watched.csv must be there). Only then is data/letterboxd/ swapped
// for the new copy (old one renamed aside, new one moved in, old one deleted; restored if the move fails), so a wrong zip
// never destroys the data that is already there. The temp folders are removed on every way out. LETTERBOXD_OUT_DIR overrides the output folder (tests point it at a temp dir).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const PEOPLE = require("./lib/people");

const args = process.argv.slice(2);
let person, out;
try {
  person = PEOPLE.personArg(args);
  if (person && Object.hasOwn(process.env, "LETTERBOXD_OUT_DIR")) throw new Error('LETTERBOXD_OUT_DIR cannot be used with --person.');
  if (person) {
    const at=args.indexOf('--private-dir');
    if(at<0||args.lastIndexOf('--private-dir')!==at||!args[at+1])throw Error('--private-dir is required');
    const positions=[];for(let i=0;i<args.length;i++){if(['--person','--private-dir'].includes(args[i])){i++;continue;}if(args[i].startsWith('--'))throw Error('Unknown personal import option');positions.push(args[i]);}
    if(positions.length!==1)throw Error('Exactly one export ZIP is required');
    const archive=positions[0];
    const h=require('./lib/person-input').importArchive({root:__dirname,privateDir:args[at+1],archive,capturedAt:new Date().toISOString(),requestId:require('crypto').randomUUID()});
    console.log('Imported normalized private history for '+h.personId);process.exit(0);
  }
  out = process.env.LETTERBOXD_OUT_DIR ? path.resolve(process.env.LETTERBOXD_OUT_DIR) : path.join(__dirname, 'data/letterboxd');
} catch (e) { console.error(e.message); process.exit(1); }

const KEEP = ["watched.csv", "ratings.csv", "diary.csv", "watchlist.csv", "likes/films.csv"];
const positional = args.filter((_, i) => args[i] !== '--person' && (i === 0 || args[i - 1] !== '--person'));
const src = positional[0];
if (!src || !fs.existsSync(src)) {
  console.log("Usage: node import-letterboxd.js path/to/letterboxd-export.zip");
  process.exit(1);
}

const aside = `${out}.old-${process.pid}`;
let tmp = null;   // where the zip is unpacked
let stage = null; // next to `out`, so the final rename stays on one filesystem
const cleanup = () => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  if (stage) fs.rmSync(stage, { recursive: true, force: true });
};

/** Returns the process exit code. Every way out (return or throw) goes through the finally below, which removes the temp folders. */
function run() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lbx-"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  stage = fs.mkdtempSync(path.join(path.dirname(out), `.${path.basename(out)}-new-`));
  // mkdtemp makes a 0700 folder; the folder that ends up as `out` is made by mkdir so it keeps the usual mode (umask), as before.
  const fresh = path.join(stage, "letterboxd");
  fs.mkdirSync(fresh);
  try {
    execFileSync("unzip", ["-q", "-o", src, ...KEEP, "-d", tmp], { stdio: "pipe" });
  } catch (e) {
    // unzip exits non-zero if an optional file (e.g. likes/films.csv) is missing; check below.
  }
  let n = 0;
  for (const rel of KEEP) {
    const from = path.join(tmp, rel);
    if (!fs.existsSync(from)) { if (rel !== "likes/films.csv") console.warn(`  ! ${rel} missing from export`); continue; }
    fs.mkdirSync(path.dirname(path.join(fresh, rel)), { recursive: true });
    fs.copyFileSync(from, path.join(fresh, rel));
    const rows = fs.readFileSync(from, "utf8").trim().split("\n").length - 1;
    console.log(`  ✓ ${rel.padEnd(16)} ${rows} rows`);
    n++;
  }
  if (!fs.existsSync(path.join(fresh, "watched.csv"))) {
    console.error("That doesn't look like a Letterboxd export (no watched.csv). Nothing was changed.");
    return 1;
  }
  // Valid export: swap it in. The old folder is renamed aside first and put back if the move fails.
  const hadOld = fs.existsSync(out);
  let movedAside = false;
  try {
    if (hadOld) { fs.renameSync(out, aside); movedAside = true; }
    fs.renameSync(fresh, out);
  } catch (e) {
    if (!movedAside) {
      console.error(`Could not replace ${out}: ${e.message}. The previous data was kept.`);
      return 1;
    }
    try {
      fs.renameSync(aside, out);
      console.error(`Could not replace ${out}: ${e.message}. The previous data was kept.`);
    } catch (e2) {
      console.error(`Could not replace ${out}: ${e.message}. Putting the previous data back failed too (${e2.message}); it is in ${aside}.`);
    }
    return 1;
  }
  if (hadOld) {
    try { fs.rmSync(aside, { recursive: true, force: true }); }
    catch (e) { console.warn(`  ! Imported, but the previous data could not be deleted (${e.message}); it is still in ${aside}.`); }
  }
  console.log(`Imported ${n} files → ${out}. Now run: node build.js${person ? ` --person ${person.id}` : ''}`);
  return 0;
}

let code;
try { code = run(); } finally { cleanup(); }
process.exit(code);
