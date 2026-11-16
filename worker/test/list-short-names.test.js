// node --test            (from worker/ or from the repository root)
// The short names of the 147 curated lists (config.json lists[].short; 142 on 22/10/2026 at the first writing, 146 after the rebase on #72, which brought the four TSPDT top 250 lists, each with its own short, 147 after Marco's decision of ~15:05 UTC that the Beyond the Sight & Sound Canon A-List enters): the entry each list has in the Discover menus Lists and Lists (unseen).
//
// Marco, 22/10/2026 ~04:05 UTC (questionnaire, after a print of Stremio on his phone): the entries were cutting into two and three lines and overlapping (142 options, mean 40 characters,
// longest 72, 125 above 28). Decision: one line, up to 28 characters, the source abbreviated in front, no author's handle in parentheses; the full name and the author were to stay in the cards'
// description (that condition does not hold since description v3, PR #67: no card prints its list's name; the full name is in config.json `name` and in the index's `label`; Marco accepted it, 22/10/2026 ~19:10 UTC: "Aceitar: só o nome curto no Stremio"). The table name -> short is in BACKLOG.md (22/10/2026), where he checks it. This file reads config.json itself, not a copy: a list added later without a short name, a short
// of 29 characters or a repeated one is red here, and the Worker's Pull Request workflow runs this suite whenever config.json changes.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { listMenu, matchList, parseExtras } from "../src/extras.js";
import { buildManifest } from "../src/manifest.js";
import { makeIndex } from "./fixture.js";
import { words } from "../src/text.js";

const MENU_LINE = 28; // lib/list-signal.js SHORT_MAX; asserted equal below
const config = JSON.parse(fs.readFileSync(new URL("../../config.json", import.meta.url), "utf8"));
const lists = config.lists;

test("every list of config.json has a short name: a string, 28 characters at most, not empty (a list added without one is red here)", () => {
  assert.ok(lists.length > 0, "config.json has lists"); // the count is not pinned here: test/board-production.test.js, test/catalog-expansion.test.js and test/v2.test.js pin it
  const bad = lists.filter((l) => typeof l.short !== "string" || !l.short.trim() || l.short.length > MENU_LINE).map((l) => `${l.id}: ${JSON.stringify(l.short)} (${l.short?.length})`);
  assert.deepEqual(bad, []);
  assert.equal(MENU_LINE, createRequire(import.meta.url)("../../lib/list-signal.js").SHORT_MAX, "the limit of the build (validateLists) and the one of this test are one number");
});

test("the short names are unique, also by the words alone (the match ignores case, apostrophes and punctuation), and none is another list's full name", () => {
  const shorts = lists.map((l) => l.short);
  assert.equal(new Set(shorts).size, shorts.length, "two lists with the same entry");
  assert.equal(new Set(shorts.map(words)).size, shorts.length, "two entries that the match cannot tell apart");
  const full = new Set(lists.map((l) => words(l.name)));
  assert.deepEqual(lists.filter((l) => full.has(words(l.short)) && words(l.short) !== words(l.name)).map((l) => l.id), [], "an entry that is another list's old name would open the wrong list for the older installs");
});

test("no short name has a parenthesis, a path character, or the handle of the author that the full name carries in parentheses", () => {
  assert.deepEqual(lists.filter((l) => /[()\\/?#%]/.test(l.short)).map((l) => l.id), []);
  const SOURCE_ACCOUNTS = new Set(["abraccine"]); // the account IS the publication, which Marco keeps in front as it is ("Abraccine")
  const handles = lists.map((l) => [l, (l.name.match(/\(([a-z][a-z0-9_.]*)\)$/) || [])[1]]).filter(([, h]) => h && !SOURCE_ACCOUNTS.has(h)); // a lower-case token that starts with a letter: a Letterboxd account ((MUBI), (Oscars) and (2023) are not one)
  assert.ok(handles.length > 70, `${handles.length} lists carry a handle`);
  assert.deepEqual(handles.filter(([l, h]) => l.short.toLowerCase().includes(h.toLowerCase())).map(([l, h]) => `${l.id}: ${h} in "${l.short}"`), []);
  assert.deepEqual(lists.filter((l) => l.short !== l.short.trim() || /\s{2,}/.test(l.short)).map((l) => l.id), [], "no stray spaces");
});

test("the examples Marco approved (22/10/2026) are exactly these", () => {
  const short = (id) => lists.find((l) => l.id === id).short;
  assert.equal(short("jlyNq"), "S&S greatest films 2022"); // Sight and Sound greatest films 2022 (sightsoundmag)
  assert.equal(short("R7jhM"), "TSPDT 1,000 greatest 2026"); // TSPDT 1,000 greatest films 2026 (tspdtfanaccount)
  assert.equal(short("hGHCU"), "CC · Questioning Love II"); // Films to Watch When You’re Questioning Love, Part II (Criterion Channel)
  assert.ok(short("IbCKK").startsWith("NYT "));
  assert.ok(short("LOj8").startsWith("BBC "));
  assert.ok(short("nVqt6").startsWith("LB "));
  assert.ok(short("oA1xE").startsWith("IW "));
  assert.ok(short("2mL0U").startsWith("ASC "));
  assert.ok(short("UrNbQ").startsWith("Abraccine "));
  // 22/10/2026, rebase on #72: the four TSPDT top 250 lists came with their own short (the same words as their name, which already has no author); the source stays in front
  assert.deepEqual(["tspdt-21c-250", "tspdt-poll26-250", "tspdt-poll21-250", "tspdt-2025-50"].map(short), ["TSPDT · 21st Century top 250", "TSPDT · 2026 Poll top 250", "TSPDT · 2021 Poll top 250", "TSPDT · 50 best of 2025"]);
  // 22/10/2026 ~15:05 UTC (Marco, questionnaire TSPDT 2 of 3): the Beyond the Sight & Sound Canon A-List enters, as a list of critics; source first, 25 characters, no parenthesis, no author
  assert.equal(short("tspdt-beyond-ss-alist"), "TSPDT · Beyond S&S A-List");
});

test("the menu the Worker builds from the lists of config.json: one entry for each, of one line each; every entry, sent the way a phone sends it, opens its own list; so does every full name of the older installs", () => {
  const index = lists.map((l) => ({ id: l.id, label: l.name, short: l.short, popular: false, films: 1 }));
  const menu = listMenu(index);
  assert.deepEqual(menu, lists.map((l) => l.short));
  assert.equal(menu.length, lists.length);
  assert.ok(menu.every((m) => m.length <= MENU_LINE));
  for (const l of index) {
    for (const sent of [encodeURIComponent(l.short), encodeURIComponent(l.short).replace(/%20/g, "+")]) {
      assert.equal(matchList(parseExtras(`decade=1990s&genre=${sent}`).genre, index)?.id, l.id, `short ${l.id} sent as ${sent}`);
    }
    assert.equal(matchList(parseExtras(`genre=${encodeURIComponent(l.label)}`).genre, index)?.id, l.id, `full name ${l.id}`);
  }
  // 22/10/2026 (review): "&" is a menu character for the first time (S&S, TSPDT · Beyond S&S A-List) and "+" already was (CC · LGBTQ+). The way extras.test.js sends the labels: raw, with no encoding at all.
  // A raw "&" cannot work: parseExtras splits the extras at it, so "genre=S&S greatest films 2022" is the genre "S" and an extra called "S greatest films 2022". Stremio encodes (%26), which the loop above sends;
  // Nuvio and Fusion were NOT tested (BACKLOG.md, 22/10/2026). This pins the limit, so that a client that does not encode is a known case and not a surprise.
  for (const l of index) {
    const raw = matchList(parseExtras(`genre=${l.short}`).genre, index)?.id;
    if (l.short.includes("&")) assert.equal(raw, undefined, `short ${l.id} sent raw: the "&" ends the genre, so no list opens (the client must encode it)`);
    else assert.equal(raw, l.id, `short ${l.id} sent with no encoding`);
  }
  const ix = makeIndex();
  const m = buildManifest({ ...ix, lists: index });
  for (const id of ["lists", "lists-unseen"]) assert.deepEqual(m.catalogs.find((c) => c.id === id).extra.find((e) => e.name === "genre").options, menu, id);
});
