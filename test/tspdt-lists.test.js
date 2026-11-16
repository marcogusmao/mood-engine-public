// The four TSPDT lists of config.json (Marco, 22/10/2026 ~06:45 UTC: "eu quero que voce pega os top 250 das listas"): the menu name, the `short`, the trust, the cut and the checks.
// Every test here fails if the named defect is put back (test-support/tspdt-mutations.js plants them in a copy).
const test = require("node:test");
const a = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const LW = require("../lib/list-signal");

const ROOT = path.resolve(__dirname, "..");

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const by = (id) => cfg.lists.find((l) => l.id === id);

test("config.json: the TSPDT top 250 lists have a menu name of one line (28 or fewer, no parenthesis), a `short` equal to it, a trust, their cut and where they were checked", () => {
  const ids = ["tspdt-21c-250", "tspdt-poll26-250", "tspdt-poll21-250", "tspdt-2025-50"];
  a.doesNotThrow(() => LW.validateLists(cfg.lists), "the whole config still validates");
  for (const id of ids) {
    const l = by(id);
    a.ok(l, id);
    a.ok(l.name.length <= 28 && !/[()]/.test(l.name) && l.name.startsWith("TSPDT · "), `${id}: "${l.name}" (${l.name.length})`);
    a.equal(l.short, l.name, `${id}: the short name of the lists-short-names branch is the name itself, so the merge changes nothing`);
    a.match(l.description, /Marco, 22\/10\/2026 ~06:45 UTC/);
  }
  a.deepEqual(ids.map((id) => by(id).trust), ["critic", "fan", "fan", "critic"], "the two polls are the public's, not critics'");
  a.deepEqual(ids.map((id) => by(id).top ?? null), [null, 250, 250, null], "the polls are copies of 1,049 and 1,005 films, cut at 250; the other two are 250 and 50 whole");
  a.deepEqual([by("tspdt-21c-250").checked, by("tspdt-2025-50").checked], [{ on: "2026-10-22", films: 250 }, { on: "2026-10-22", films: 50 }]);
  a.equal(by("R7jhM").top, undefined, "the 1,000 Greatest is read whole, as before (its first 250 are in it)");
  a.equal(new Set(cfg.lists.map((l) => l.name)).size, cfg.lists.length, "no two lists share a full name (the older installs' menu entry)");
  a.equal(new Set(cfg.lists.map((l) => l.short ?? l.name)).size, cfg.lists.length, "no two lists share a menu entry (the `short`, since 22/10/2026)");
  const own = cfg.lists.filter((l) => l.top !== undefined).map((l) => l.id);
  a.deepEqual(own, ["tspdt-poll26-250", "tspdt-poll21-250"], "no other list carries a cut");
});

// Marco, 22/10/2026 ~15:05 UTC (questionnaire TSPDT 2 of 3): of the TSPDT lists with no position on the site only the Beyond the Sight & Sound Canon A-List enters, as a list of critics. Defects guarded:
// it read with a cut (`top`), as the public's (`fan`), from another copy than the one the site links (angelg), with a menu entry over 28 characters, or the Noir 1,000 / Recommendations sneaking in with it.
test("config.json: the Beyond the Sight & Sound Canon A-List is a list of critics, whole, from the copy the site links, with a one-line short; the Noir 1,000 and the Recommendations are not in", () => {
  const l = by("tspdt-beyond-ss-alist");
  a.ok(l);
  a.equal(l.trust, "critic");
  a.equal(l.top, undefined, "no cut: the site gives no order to cut by, and Marco wants the whole list");
  a.equal(l.url, "https://letterboxd.com/angelg/list/beyond-the-sight-sound-canon/");
  a.equal(l.short, "TSPDT · Beyond S&S A-List");
  a.ok(l.short.length <= 28 && !/[()]/.test(l.short));
  a.match(l.description, /Marco, 22\/10\/2026 ~15:05 UTC/);
  a.doesNotThrow(() => LW.validateLists(cfg.lists));
  a.deepEqual(cfg.lists.filter((x) => /theyshootpictures|tspdt/i.test(x.id + " " + x.name + " " + (x.url || ""))).map((x) => x.id).sort(), ["R7jhM", "tspdt-2025-50", "tspdt-21c-250", "tspdt-beyond-ss-alist", "tspdt-poll21-250", "tspdt-poll26-250"], "the TSPDT lists are the 1,000 Greatest and these five: the Noir 1,000 and the Recommendations stay out");
});
