// node --test            (no dependencies)
// Prose that went stale and was mended (review of the description v3, 21/10/2026): each entry names a sentence that was FALSE after the commits of that day, the file that said it, and the sentence that must be there instead.
// This is not a spell checker: the sentence below is a fact that code or a measurement contradicts, and the day someone writes it again the test says which one and why. Comments and docs steer the next session (Marco's method).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

// [file, a phrase that must NOT be there, why it is false]
const STALE = [
  ["PRODUCT.md", /\b38 films of the index of that night showed one actor/, "the questionnaire's 38 was never measured; the offline build of 878b347 counts 39 (the films whose two-actor line passes 80 characters)"],
  ["README.md", /\b38 films of the index of 21\/10\/2026 showed one actor/, "same: 39 measured"],
  ["lib/describe.js", /\b38 films of the index showed one actor/, "same: 39 measured"],
  ["README.md", /differ from the reduced build in the word group of line 2 of the card \(its last group\) and in nothing else/, "since D3 legacy-parity also lets the best-fit `Mood:` label of a line that is not in a mood row differ (test-support/card-words.js)"],
  ["build.js", /in the word group of line 2 of the card \(the last group\), and in nothing else/, "same"],
  ["lib/index-export.js", /in the word group of line 2 of the card, and in nothing else\)/, "same"],
  ["test/legacy-parity.test.js", /^\/\/ Two things are allowed to differ/m, "three: builtAt, the word group, the best-fit label"],
  ["worker/test/real-index.test.js", /the genres alone in every other row \(Marco, 20\/10\/2026\)/, "since D3 (21/10/2026) every other row that is no reason row opens with the film's best fit"],
  ["lib/plan.js", /^\s*\/\/ Marco, 13\/10\/2026 \(changed 20\/10\/2026: line 2 says "Mood: <name>" only where the row is a mood, lib\/describe.js\)/m, "D3 changed it again"],
  ["lib/best-mood.js", /the one the Moods menu and the mood rows show/, "five rows of the v2 Board show another name (board.names) than config.json's moods"],
  ["worker/test/handler.test.js", /and nowhere else \(Lists, Friends, Explore, Search\)/, "Lists, Friends, Explore and Search keep the film's best-fit label since D3"],
  // Round 3 of the description v3, 21/10/2026 ~19:40 UTC (Marco's questionnaire A, B, C and the re-verification's M-a, M-b)
  ["PRODUCT.md", /\(3\) D5 compares equal letters only/, "A: singular and plural are one genre since 21/10/2026 ~19:40 UTC (the session's narrow reading was asked and answered)"],
  ["test/describe.test.js", /only the same letters: 'Documentary' is not 'Documentaries'/, "A: the assertion of the narrow reading is the opposite now"],
  ["lib/best-mood.js", /97 of those 159 films are also in a row of such a mood/, "the 97 counts the films in ANY of the five rows; the films that read two names for ONE mood are 91 (re-verification M-b, 21/10/2026)"],
  ["lib/best-mood.js", /five rows of the v2 Board use board\.names/, "since 21/10/2026 ~19:40 UTC (B) the five rows take the mood's name; the comment says what it WAS"],
  ["test/best-mood.test.js", /five moods are named differently on the Board \(a session choice/, "B: the Board and the mood have one name now"],
  ["worker/README.md", /The rows a profile builds itself \(Tonight, Under 100 min, Watchlist, themes\) show the general line/, "C (21/10/2026 ~19:40 UTC): the Tonight of a profile names the mood each pick was drawn for"],
  ["README.md", /The Worker's own Tonight\/Under 100 min\/Watchlist rows of a profile show the general text/, "C: same"],
  ["BACKLOG.md", /97 of those 159 films are also in a row of such a mood under the other name/, "M-b: the 97 counts the films in ANY of the five rows; the pairs that name one mood twice are 91 (corrected 21/10/2026)"],
  ["BACKLOG.md", /which the review had counted and nobody had measured/, "the 38 is the count of the review of 3a1d497, not rechecked then; 39 were measured on the offline build of 878b347"],
  ["PRODUCT.md", /the review's count, not measured\)/, "same: where the 38 came from"],
  ["README.md", /the questionnaire's 38 was not\)/, "same"],
  ["worker/test/profiles.test.js", /Tonight does not say the mood the pick was drawn for/, "C: it does"],
  ["worker/test/profiles.test.js", /Directors you trust says no mood, whatever name the profile gives it/, "M-a: since D3 (21/10/2026) that row opens with the film's best fit; the test says that the profile's name for the row does not appear"],
  // Marco, 21/10/2026 ~22:15 UTC (questionnaire): B's premise, that the Moods menu shows the mood's name, was wrong (it shows the word) and the rename of the five Board rows was reverted; the label takes the Board's name when the mood has a row
  ["README.md", /Since 21\/10\/2026 ~19:40 UTC \(Marco, questionnaire B, the option the session did not recommend\) five rows of this table carry the name of their MOOD/, "B was reverted at ~22:15 UTC: the five rows keep their names (Fun and adventure, Action and thrills, Horror, Sad and beautiful, Slow and quiet)"],
  ["lib/best-mood.js", /The name written is the mood's `name` in config\.json `moods` \("🌃 Night drive"\), the one the Moods menu shows\./, "the Moods menu shows the mood's word, not its name"],
  ["worker/src/profiles.js", /so a profile has one name per mood\. The other rows built here keep the film's general text/, "false since ~22:15 UTC: every row of a profile says the profile's name for a mood of the profile (relabelOf)"],
  // The music rule, 22/10/2026 ~06:40 UTC (Marco, batch 2: every row that recommends, not New for you alone)
  ["README.md", /`newReleases\.musicNeedsEvidence` \(Marco, 22\/10\/2026; `true` in `config\.json`\): a \*\*music film\*\* enters 🆕 New for you only/, "the key is music.needsEvidence and the rule holds in every row that recommends (the old key is only still read)"],
  ["README.md", /\(Marco, 22\/10\/2026; see `newReleases` below\)/, "New for you points at The music rule, not at a newReleases key"],
  ["config.json", /"newReleases"\s*:/, "the key moved to music.needsEvidence (lib/pool.js musicOptions still reads the old one)"],
  ["lib/pool.js", /Marco's row only\), a music film only with musicEvidence/, "the rule is not in newCandidates any more: musicGate, handed to every builder by build.js"],
];
// [file, a phrase that MUST be there]
const PRESENT = [
  ["README.md", /SESSION choice, never asked of Marco, 21\/10\/2026/, "the profile rows' best-fit label is a session choice, with the question open in the BACKLOG"],
  ["worker/README.md", /SESSION choice, never asked of Marco, 21\/10\/2026/, "same, in the Worker's README"],
  ["lib/describe.js", /the 38 of the questionnaire was the count of the review of 3a1d497, not rechecked then/, "the measured 39 and where the 38 came from"],
  ["PRODUCT.md", /singular and plural count as the SAME genre in that rule/, "A (21/10/2026 ~19:40 UTC): the genre rule compares singular and plural"],
  ["lib/best-mood.js", /it counts "in any of the five rows"/, "M-b: 97 is the films in any of the five rows, 91 the films with two names for one mood"],
  ["lib/best-mood.js", /the name of the mood's ROW in the Board the family has/, "B, replaced at ~22:15 UTC: the label takes the Board's row name when the mood has a row"],
  ["worker/README.md", /Tonight of a profile names the mood each pick was DRAWN for/, "C: the Worker's README says it"],
  ["README.md", /Tonight of a profile names the mood each pick was DRAWN for/, "C: the root README says it"],
  ["PRODUCT.md", /SUPERSEDED on 21\/10\/2026 ~22:15 UTC by the decision that follows this one/, "B (~19:40 UTC) is told as history and marked superseded, with the premise corrected next to it"],
  ["PRODUCT.md", /THE PREMISE OF B WAS WRONG/, "the Moods menu shows the mood's word, not its name"],
  ["README.md", /KEEP it\. At ~19:40 UTC he had renamed them/, "the five Board names are the old ones again"],
  ["BACKLOG.md", /91 in the row of the SAME mood \(the 97 counts "in any of the five rows"/, "M-b: the two numbers, each with what it counts"],
  ["PRODUCT.md", /\(2\) the best fit is worked out over `cfg\.moods`, ONE ranking for the two index families/, "the best fit over cfg.moods for the two families is a session choice, never inside D3 as Marco answered it (3,717 of 6,445 labels of the legacy index name a mood outside the nine)"],
  ["README.md", /### The music rule \(Marco, 22\/10\/2026\)/, "the table of the rows that ask the gate and the ones that do not"],
  ["PRODUCT.md", /## The music rule in every row that recommends — 22\/10\/2026 ~06:40 UTC/, "Marco's decision of ~06:40 UTC, with the rows asked and not asked"],
  ["PRODUCT.md", /\[Answered by Marco, 22\/10\/2026 ~06:40 UTC: yes, to all of them; see the next section\.\]/, "the question of the first review is marked answered next to it"],
];

test("docs and comments: no sentence that the code or a measurement of 21/10/2026 contradicts is back", () => {
  const back = STALE.filter(([file, re]) => re.test(read(file))).map(([file, re, why]) => `${file} says again what is false: ${re} — ${why}`);
  assert.deepEqual(back, []);
});

test("docs and comments: the sentences that replaced them are there", () => {
  const lost = PRESENT.filter(([file, re]) => !re.test(read(file))).map(([file, re, why]) => `${file} lost the sentence ${re} — ${why}`);
  assert.deepEqual(lost, []);
});
