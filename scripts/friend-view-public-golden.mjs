// Writes worker/test/fixtures/friend-view-public-routes.json: how the PUBLIC addresses answer on the fixture of worker/test/friend-view-fixture.js.
//
// The golden is made by the code BEFORE the friends' view, so that worker/test/friend-view.test.js can say "byte for byte as before" (Marco, 29/10/2026: "nothing changes in the existing routes"):
//   git archive 415bd4e lib worker config.json contracts data/list-names.source.json data/list-names.final.json | tar -x -C /tmp/fv-base       (origin/main when the friends' view was written)
//   ln -s <repo>/node_modules /tmp/fv-base/node_modules; ln -s <repo>/worker/node_modules /tmp/fv-base/worker/node_modules
//   cp worker/test/friend-view-fixture.js /tmp/fv-base/worker/test/; cp scripts/friend-view-public-golden.mjs /tmp/fv-base/scripts/ (mkdir it)
//   cd /tmp/fv-base && node scripts/friend-view-public-golden.mjs worker/test/fixtures/friend-view-public-routes.json 415bd4e
// Run in the repo itself, with the same arguments, it writes what the code of today answers: `git diff --stat` on the file must then be empty.
// The bodies are kept whole (the fixture is made up: no film of Marco's, no account), so a difference can be read in the diff and not only counted. Reads only the fixture in memory: no network.

import fs from "node:fs";
import { createHandler } from "../worker/src/handler.js";
import { createStore } from "../worker/src/store.js";
import { filesOf, rigOf, PUBLIC_ROUTES } from "../worker/test/friend-view-fixture.js";

const [out, base = "unknown"] = process.argv.slice(2);
if (!out) throw new Error("usage: node scripts/friend-view-public-golden.mjs <out.json> [code revision]");
const r = rigOf(filesOf(), createHandler, createStore);
const routes = {};
for (const [name, path] of PUBLIC_ROUTES) {
  const res = await r.get(path);
  routes[name] = { status: res.status, type: res.headers.get("content-type"), cache: res.headers.get("cache-control"), total: res.headers.get("x-total"), text: res.text };
}
fs.mkdirSync(new URL("./", `file://${process.cwd()}/${out}`).pathname, { recursive: true });
fs.writeFileSync(out, JSON.stringify({ _doc: `How the public routes answer on the fixture of worker/test/friend-view-fixture.js, made by the code of ${base} (before the friends' view, 29/10/2026). scripts/friend-view-public-golden.mjs says how.`, base, routes }, null, 1) + "\n");
console.log(`${Object.keys(routes).length} routes -> ${out}`);
for (const [n, v] of Object.entries(routes)) console.log(String(v.status), String(Buffer.byteLength(v.text)).padStart(7), n);
