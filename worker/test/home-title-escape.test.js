// S7d of the 20/10/2026 security review: the owner's home page wrote `person.name` into <title> and <h1> without escaping,
// while the profile pages escape their title. The registry is a closed list today ("Will"), so the real name cannot be hostile; this test
// runs the REAL handler against a copy of src/ whose registry holds a name with markup, so the escaping is proven on the actual route
// (GET /u/friend-a/) and not on a helper. Nothing in src/ is changed for it: no injection point exists only for the test.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REVISION = "r-" + "1".repeat(32);
const ENV = { INDEX_URL: "https://pages.test/mood-engine/data/index.json" };
const HOSTILE = `Wi<ll> & "Co" 'x' </title><script>alert(1)</script>`;
const ESCAPED = "Wi&#60;ll&#62; &#38; &#34;Co&#34; &#39;x&#39; &#60;/title&#62;&#60;script&#62;alert(1)&#60;/script&#62;";

/** A copy of worker/src (plus the three files it imports from outside) whose single registered owner is called `name`. */
function copyWithOwnerName(name) {
  const dir = mkdtempSync(join(tmpdir(), "mood-home-title-"));
  cpSync(join(ROOT, "worker/src"), join(dir, "worker/src"), { recursive: true });
  mkdirSync(join(dir, "data"));
  for (const f of ["list-names.source.json", "list-names.final.json"]) cpSync(join(ROOT, "data", f), join(dir, "data", f));
  mkdirSync(join(dir, "contracts"));
  cpSync(join(ROOT, "contracts/will-upload-v1.json"), join(dir, "contracts/will-upload-v1.json"));
  const peopleFile = join(dir, "worker/src/people.js"), text = readFileSync(peopleFile, "utf8");
  assert.equal(text.split('name: "Will"').length - 1, 1, 'worker/src/people.js no longer declares the owner as name: "Will"; update this test');
  writeFileSync(peopleFile, text.replace('name: "Will"', `name: ${JSON.stringify(name)}`));
  return dir;
}
async function homeOf(dir, path) {
  const { createHandler } = await import(pathToFileURL(join(dir, "worker/src/handler.js")).href);
  const touched = () => { throw new Error("the home page must not read the index"); };
  const handle = createHandler({ publication: async () => ({ revision: REVISION }), store: { get: touched }, log: () => {} });
  const res = await handle(new Request(`https://worker.test${path}`), ENV);
  return { status: res.status, text: await res.text() };
}

test("the owner's home page escapes the name in <title> and <h1>: < > & quotes become character references", async (t) => {
  const dir = copyWithOwnerName(HOSTILE);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { status, text } = await homeOf(dir, "/u/friend-a/");
  assert.equal(status, 200);
  assert.ok(text.includes(`<title>Mood Engine · ${ESCAPED}</title>`), text);
  assert.ok(text.includes(`<h1>Mood Engine · ${ESCAPED}</h1>`), text);
  // The only tags in the answer are the page's own: nothing from the name became markup.
  assert.ok(!text.includes("<script"), "no script element");
  assert.equal((text.match(/<\/title>/g) || []).length, 1, "the name did not close <title>");
  assert.equal((text.match(/<title>/g) || []).length, 1);
  assert.equal((text.match(/<h1>/g) || []).length, 1);
  assert.ok(!text.includes(HOSTILE), "the raw name appears nowhere");
});

test("control: a plain name and Marco's own home page come out unchanged by the escaping", async (t) => {
  const dir = copyWithOwnerName("Will");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const will = await homeOf(dir, "/u/friend-a/");
  assert.ok(will.text.includes("<title>Mood Engine · Will</title>") && will.text.includes("<h1>Mood Engine · Will</h1>"));
  const marco = await homeOf(dir, "/");
  assert.ok(marco.text.includes("<title>Mood Engine</title>") && marco.text.includes("<h1>Mood Engine</h1>"));
  // The same bytes as the unmodified source tree (the real registry) for the real name.
  const real = await homeOf(ROOT, "/u/friend-a/");
  assert.equal(real.text, will.text);
});
