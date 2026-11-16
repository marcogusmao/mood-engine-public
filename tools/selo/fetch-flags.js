#!/usr/bin/env node
// Downloads every flag the country table can produce (tools/selo/countries.json) that is not in cache/flags/ yet.
//
//   node tools/selo/fetch-flags.js                 flags missing from cache/flags/
//   node tools/selo/fetch-flags.js --dir some/dir  another folder
//
// The nightly build downloads a missing flag by itself, so this is only for filling the folder in one go (about 250 files of a few
// hundred bytes each, from https://flagcdn.com/w80/<code>.png). Exit 0 when every flag is there, 3 when some could not be downloaded.
const path = require("path");
const { allFlagCodes, ensureFlags } = require("../../lib/countries");

const i = process.argv.indexOf("--dir");
const dir = path.resolve(i > 0 ? process.argv[i + 1] : path.join(__dirname, "..", "..", "cache", "flags"));
ensureFlags(allFlagCodes(), { dir }).then((r) => {
  console.log(`flags in ${dir}: ${r.present} were there, ${r.downloaded} downloaded, ${r.failed.length} failed`);
  for (const f of r.failed) console.log(`  ! ${f.cc}: ${f.error}`);
  process.exit(r.failed.length ? 3 : 0);
});
