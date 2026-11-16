// Prose that steers the next session, pinned (review round of the branch will-pre-activation-2, 21/10/2026; signatures below). What the Rate Limiting binding does and does not do, and how the first
// publication that carries it is made, is written in worker/wrangler.toml, worker/README.md and BACKLOG.md; a sentence that is wrong there sends whoever reads it to a wrong plan, so each fact is held
// by a line here and by a mutation (block "RP:" of mutation.mjs) that puts the wrong sentence back. Reads files only; nothing here runs the Worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RATE_LIMIT_CHARGES, RATE_WINDOW_MS } from '../src/upload/limiter.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const FILES = { 'worker/wrangler.toml': read('../wrangler.toml'), 'worker/src/upload/limiter.js': read('../src/upload/limiter.js'), 'worker/src/upload/api.js': read('../src/upload/api.js'), 'worker/README.md': read('../README.md') };
const BACKLOG = read('../../BACKLOG.md');
const TEST_OF_BINDING = read('./will-rate-limit-binding.test.js');

// Signature (MEDIUM 1 of the review, 21/10/2026): five places said that `wrangler dev` has no binding ("the local runner, `wrangler dev`, every test"), and the BACKLOG said in another line that it was never
// measured. Measured by the reviewer and again by the author with wrangler 4.149.0: `wrangler dev --local` on a config with the same block gives the Worker a simulated binding (25 calls, 20 true, 5 false).
// Only the node tests and the generated config of test/upload-fixtures/runtime.mjs have none. With the old sentence back in any of the five files this test is red.
test('prose: no file says that `wrangler dev` runs without the binding, and each says that `wrangler dev --local` gets a simulated one', () => {
  const wrong = /local runner, `wrangler dev`|`wrangler dev`, (?:every|the)(?: other)? tests?\b|\(the local runner[^)]*\bwrangler dev/;
  for (const [name, text] of Object.entries({ ...FILES, 'worker/test/will-rate-limit-binding.test.js': TEST_OF_BINDING })) {
    assert.ok(!wrong.test(text), `${name} still says that wrangler dev has no binding`);
  }
  for (const name of ['worker/wrangler.toml', 'worker/src/upload/limiter.js', 'worker/src/upload/api.js', 'worker/README.md', 'worker/test/will-rate-limit-binding.test.js']) {
    const text = FILES[name] ?? TEST_OF_BINDING;
    assert.match(text, /`wrangler dev --local`[^.]{0,80}(?:simulated|THIS file|wrangler\.toml)/, `${name} does not say that wrangler dev --local gets a simulated binding`);
  }
  assert.match(FILES['worker/README.md'], /\*\*`wrangler dev --local` \(`npm run dev`\) with this `wrangler\.toml` DOES get a simulated local binding\*\*/);
  assert.match(FILES['worker/README.md'], /25 calls with one key returned 20 `success: true` and then 5 false/);
  assert.match(FILES['worker/wrangler.toml'], /the first 20 `success: true`, the last 5 false; the real Cloudflare counter is not that one/);
});

test('prose: the BACKLOG keeps the old statement beside the corrected one, dated, and no longer says that the local behaviour is unmeasured without the measurement beside it', () => {
  assert.match(BACKLOG, /\[CORRECTED 21\/10\/2026, review round: `wrangler dev` is NOT without the binding\./);
  assert.match(BACKLOG, /whether `wrangler dev --local` honours `\[\[ratelimits\]\]` locally is unmeasured\. \[MEASURED 21\/10\/2026, review round: it does\./);
});

// Signature (MEDIUM 2 of the review, 21/10/2026): the session chose the binding's number (20 per 60 s), its key (the /64) and failing open, and the 20/10/2026 BACKLOG listed none of them as awaiting Marco, whose
// answer of 21/10/2026 named only the binding itself and the confirmed 20 tokens per 10 minutes. Over 10 minutes 20 per 60 s is 200 per key per location, ten times the confirmed number, and Cloudflare's
// counter is approximate and per location. The numbers below are read from wrangler.toml and the limiter, so a changed limit or period makes the sentence stale and this test red.
const block = (FILES['worker/wrangler.toml'].match(/^\[\[ratelimits\]\]\n((?:(?!\[).*\n?)*)/m) || [])[1] || '';
const { limit, period } = (block.match(/^simple = \{ limit = (?<limit>\d+), period = (?<period>\d+) \}$/m) || {}).groups || {};
const perWindow = Number(limit) * (RATE_WINDOW_MS / 1000 / Number(period));

// Marco, 28/10/2026 (questionnaire): the three choices above are DECIDED: (i) 20 per 60 s stays, (ii) the key is the sha256 of the token and NOT the /64 (not the option the session recommended; the risk he accepted is written
// beside it), (iii) failing open stays. Signature: with the sentences of 21/10/2026 ("PENDING MARCO'S CONFIRMATION ... the /64 as the key") still in the README, the toml and limiter.js, the assertions on "Decided by Marco, 28/10/2026"
// and on the risk are red; the BACKLOG keeps its entries of 21/10/2026 as history (fact that is superseded is not erased), so they are still asserted, and beside them the answer of 28/10/2026.
test('prose: the binding\'s number, key and failing open are DECIDED by Marco on 28/10/2026 everywhere they are written, with the risk he accepted, and the earlier "pending" sentences survive only as dated history in the BACKLOG', () => {
  assert.equal(perWindow, 200, 'the sentences below say 200; if the limit or the period changes, rewrite them and this line together');
  assert.equal(perWindow / RATE_LIMIT_CHARGES, 10);
  const readme = FILES['worker/README.md'], toml = FILES['worker/wrangler.toml'], limiter = FILES['worker/src/upload/limiter.js'], api = FILES['worker/src/upload/api.js'];
  assert.match(readme, /\*\*Decided by Marco, 28\/10\/2026, 03:17 UTC \(questionnaire[^]*?\):\*\* \(i\) the binding's \*\*20 per 60 s\*\* stays[^]*\(ii\) its \*\*key\*\* is the \*\*sha256 of the token\*\*[^]*\*\*not the \/64\*\*[^]*\(iii\) \*\*failing open\*\* when the binding errs stays/);
  assert.match(readme, /\(ii\) was NOT the option the session recommended/);
  assert.match(readme, /\*\*Risk accepted by Marco in \(ii\): a caller that changes token on every request is never limited by the binding\*\*, because every key is new; only the table holds that caller/);
  assert.match(readme, /Over 10 minutes 20 per 60 s is 200 calls per \*\*token\*\* per Cloudflare location, \*\*ten times the confirmed 20 per 10 minutes\*\*/);
  assert.match(readme, /with the sha256 of the caller's token as the key, not the \/64 the table uses\*\* \(Marco, 28\/10\/2026/);
  assert.match(toml, /# DECIDED BY MARCO, 28\/10\/2026, 03:17 UTC \(questionnaire;[^\n]*the key is the token's sha256 \(his choice, not the recommended \/64; accepted risk: a caller that changes token on every request is never limited by this binding[^\n]*200 per key per location, ten times the confirmed 20 per 10 minutes/);
  assert.match(toml, /keyed by the sha256 of the caller's token \(NOT the \/64 or the address: Marco, 28\/10\/2026\)/);
  assert.match(limiter, /\/\/ DECIDED BY MARCO, 28\/10\/2026 \(questionnaire;[^\n]*\(ii\) the key is the token's sha256, NOT the \/64[^\n]*\n\/\/ when the binding errs\. Over 10 minutes 20 per 60 s is 200 per key per Cloudflare location, ten times the confirmed 20 per 10 minutes/);
  assert.match(api, /THE KEY IS THE TOKEN'S sha256 \(`actor\.hash`\), NOT THE ADDRESS \(Marco, 28\/10\/2026; the table above keeps the \/64\)/);
  for (const [name, text] of [['worker/README.md', readme], ['worker/wrangler.toml', toml], ['worker/src/upload/limiter.js', limiter]]) {
    assert.ok(!/pending marco's confirmation \(a choice of the session of 21\/10\/2026/i.test(text), `${name} still says that the binding's number, key and failing open are pending`);
    assert.ok(!/the \/64 as the key and failing open/.test(text), `${name} still names the /64 as the binding's key`);
  }
  // the BACKLOG keeps what it said on 21/10/2026, dated, and says beside it what was answered on 28/10/2026
  assert.match(BACKLOG, /Choice of N, the session's \[21\/10\/2026, review round: PENDING MARCO'S CONFIRMATION, with the \/64 key and failing open;/);
  assert.match(BACKLOG, /STILL PENDING, not named in his answer \[21\/10\/2026, review round: and the binding's 20 per 60 s, its \/64 key and failing open when it errs, all the session's, see below\]/);
  assert.match(BACKLOG, /QUESTIONS FOR MARCO \(not asked yet;[^]*Q1, the binding's number per \/64:[^]*Q2, when the binding errs:[^]*Q3, the key:/);
  assert.match(BACKLOG, /\[ANSWERED 28\/10\/2026 \(Marco, questionnaire\): Q1 \(a\) keep 20 per 60 s; Q2 \(a\) fail open; Q3 the token's sha256, NOT the \/64 \(not the recommended option;/);
  // PRODUCT.md and the GitHub side, as told on 28/10/2026
  assert.match(PRODUCT, /Marco, 28\/10\/2026, 03:17 UTC — the key of Will's Rate Limiting binding \(questionnaire, the time as told by the main session; \*\*NOT the option the session recommended\*\*/);
  assert.match(PRODUCT, /`WILL_RATE_LIMIT` is the sha256 of the token, not the \/64/);
  // the mechanism, as corrected by the independent review of 28/10/2026 (the first reading, "once per token per isolate per 5 minutes", held only for a token the object accepted)
  assert.match(readme, /\*\*What the binding still protects: it limits, to about 20 per 60 s per Cloudflare location, the requests of ONE token that the tables charge, whether they come from many isolates, from several \/64 in one isolate, or from resends while the object fails[^]*against a caller that changes token on every request it does nothing\.\*\*/);
  assert.match(readme, /is true only for a token the object \*\*accepted\*\*[^]*renews at every request[^]*A token the object \*\*refused\*\* is asked once per 60 s[^]*Nothing is remembered when the object fails or when the binding itself refused, so then the token is asked on \*\*every\*\* request[^]*25 at once of a valid token from 2 \/64 are 25 asks and 5 refusals, 429; a \*\*new effect of the token key\*\*/);
  assert.match(BACKLOG, /\[CORRECTED 28\/10\/2026, independent review: the first version of this item said "the table asks the binding once per token per isolate per 5 minutes[^\]]*that holds only for a token the object ACCEPTED\][^]*case B: 25 at once of a valid token from 2 \/64 are 25 asks and 5 refusals, 429, a NEW effect of the token key/);
  assert.match(BACKLOG, /ANSWERED BY MARCO \(questionnaire, 28\/10\/2026, 03:17 UTC, the time as told by the main session\)/);
  assert.match(BACKLOG, /Tests, FOUR files: `will-rate-limit-binding\.test\.js` \(20;[^]*`will-confirmed-parameters\.test\.js` \(7;/);
  assert.match(BACKLOG, /\[ANSWERED 28\/10\/2026 \(Marco, questionnaire\): the binding's 20 per 60 s stays, its key is the token's sha256 and NOT the \/64, and it fails open;/);
  assert.match(BACKLOG, /admin one requires a reviewer \(not visible from the repo\) \[28\/10\/2026, as told by the main session: both environments were created[^\]]*REFUSED by GitHub \(HTTP 422[^\]]*so the reviewer requirement is NOT in force;/);
  assert.match(PRODUCT, /\*\*Risk accepted by him:\*\* a caller that changes token on every request is never limited by the binding/);
  assert.match(BACKLOG, /between 03:18 and 03:20 UTC the environments `mood-will-build` and `mood-will-admin` were created with a deployment-branch policy of only `main`/);
  assert.match(BACKLOG, /repository variable `WILL_UPLOAD_ENABLED` = `false` was created/);
  assert.match(BACKLOG, /the required-reviewer rule of `mood-will-admin` was REFUSED by GitHub \(HTTP 422[^)]*private repositor[^)]*\), so the S7 requirement of a reviewer is NOT in force/);
});

test('prose: what Cloudflare\'s documentation says about the binding (approximate, per location, IP keys not recommended) is written as read on 21/10/2026, not as "not re-read"', () => {
  const readme = FILES['worker/README.md'];
  assert.match(readme, /"Rate limits are approximate and apply separately in each Cloudflare location\. Requests can exceed your configured limit while counts update in the background\."/);
  assert.match(readme, /IP addresses as keys are "not recommended"/);
  assert.ok(!/not re-read and not measured/.test(readme + BACKLOG), 'the documentation was re-read on 21/10/2026');
  assert.match(BACKLOG, /\[21\/10\/2026, review round: the documentation WAS re-read/);
});

// Signature (MEDIUM 3 of the review, 21/10/2026): BACKLOG "FOR THE PUBLICATION (a)" warned that a binding the account rejects fails the publication of everything, and worker/README.md did not mention it; nothing said how to
// try first, what to write down, or what to do if the account refuses. The review suggested a version upload that takes no traffic; the installed wrangler 4.149.0 refuses that while the Durable Object migration is pending,
// and this branch's first publication is the one that applies it. The recipe is therefore pinned step by step, and the two messages of wrangler it quotes are looked up in the installed wrangler, so the sentence goes red if
// wrangler stops saying it (or if the version it names is not the one installed).
const section = (() => { const text = FILES['worker/README.md'], at = text.indexOf('**The first publication that carries the binding: the recipe'); return at < 0 ? '' : text.slice(at, text.indexOf('Tests: `test/will-rate-limit-binding.test.js`', at)); })();
const cli = (() => { try { return read('../node_modules/wrangler/wrangler-dist/cli.js'); } catch { return null; } })();
const installed = (() => { try { return JSON.parse(read('../node_modules/wrangler/package.json')).version; } catch { return null; } })();

test('prose: the recipe of the first publication has its five steps: the id of the active version, the dry run, no version upload while the migration is pending, the two orders, and the way out', () => {
  assert.ok(section.length > 1500, 'the section "The first publication that carries the binding: the recipe" exists in worker/README.md');
  assert.match(section, /\(1\) \*\*Before, write down the id of the version that is active\*\* \(as was done for the rollback `4e72f520` of 19\/10\/2026\)/);
  assert.match(section, /the migration removes every earlier version from the rollback list, so the way back is the rehearsed redeploy of that commit from a clean checkout/);
  assert.match(section, /\(2\) \*\*Rehearse with `npx wrangler deploy --dry-run` inside `worker\/`\*\*/);
  assert.match(section, /wrangler 4\.149\.0 reads `wrangler\.toml` with its own schema, builds the upload/);
  assert.match(section, /it cannot tell what the account refuses \(the plan, a `namespace_id` that collides\)/);
  assert.match(section, /\(3\) \*\*`wrangler versions upload`[^]*is NOT available for this first publication\*\*: wrangler 4\.149\.0 refuses it while a Durable Object migration is pending/);
  assert.match(section, /\(4\) \*\*Two orders, the main session's call with Marco\.\*\* A: one publication with the block;[^]*\*\*expected, not verified\*\*[^]*B \(suggested[^]*a copy of `wrangler\.toml` without the `\[\[ratelimits\]\]` block, passed with `--config` and kept out of git/);
  assert.match(section, /\(5\) \*\*If the account will not take the binding at all\*\*: remove the block in a commit together with `test\/will-rate-limit-binding\.test\.js`/);
  assert.match(FILES['worker/README.md'], /What is left for the publication is in BACKLOG\.md \(21\/10\/2026\), and the recipe for its first run is just below\./);
});

test('prose: the recipe names the migration tag that wrangler.toml declares, and the two messages of wrangler it quotes are the ones the installed wrangler prints', { skip: !cli && 'wrangler is not installed in worker/node_modules' }, () => {
  const tag = (FILES['worker/wrangler.toml'].match(/^tag = "([^"]+)"/m) || [])[1];
  assert.equal(tag, '2026-10-14-will-state-sqlite-v1');
  assert.ok(section.includes('`' + tag + '`'), 'the recipe names the pending migration');
  assert.match(section, /stops at "--dry-run: exiting now\." before the upload/);
  assert.ok(cli.includes('`--dry-run: exiting now.`'), 'the installed wrangler prints the line of the dry run');
  assert.match(section, /refuses it while a Durable Object migration is pending \("cannot be applied by `wrangler versions upload`"\)/);
  assert.ok(cli.includes('cannot be applied by `wrangler versions upload`'), 'the installed wrangler refuses a version upload with a pending migration');
  assert.equal(installed, '4.149.0', 'the recipe names wrangler 4.149.0; if the installed one changed, read it again and rewrite the recipe');
});

test('prose: the BACKLOG points to the recipe from "FOR THE PUBLICATION (a)" and records what was checked and what was not', () => {
  assert.match(BACKLOG, /so a rejected binding fails the publication of everything\. \[21\/10\/2026, review round, MEDIUM 3: the recipe for this first publication is now in `worker\/README\.md`/);
  assert.match(BACKLOG, /That a rejected upload leaves the running version untouched is EXPECTED, NOT VERIFIED/);
  assert.match(BACKLOG, /MEDIUM 3, FIXED IN PROSE \(no step was run against the account\)\./);
  assert.match(BACKLOG, /Not verified: that a rejected upload leaves the running version untouched\./);
});

// Signature (re-verification of the branch, 21/10/2026; 1 MEDIUM and 6 LOW closed in prose): (MEDIUM) the recipe started at "write down the id" and spoke of "the rehearsed redeploy" as if it were done, while Marco's
// condition of 20/10/2026 (PRODUCT.md) is that this rehearsal, from a clean checkout, comes BEFORE the first publication of this code: it is step (0). (LOW) the recipe called the guard hook "the project's" and the dry run
// "the one form it lets a subagent run" (the hook is the Stremio repository's and accepts exactly the bare line, never `cd worker && ...`); both commands of order B need `--var GIT_SHA:...` or the version
// goes out with no X-Build, which step (0) reads; plan B listed only the binding test, but the prose test reads that file when it loads and so also has to go, with the `RP:` block; the root README's "First-deployment order"
// did not say that order B is safe only with the flag false, nor that the first publication comes before the activation; the BACKLOG named the wrong test as the guard of the `wrangler dev` sentence, gave "up to 200" where a fixed
// 60 s window gives 220, and did not say that the session measures the requests of a real Will session before Q1.
const ROOT_README = read('../../README.md');
const PRODUCT = read('../../PRODUCT.md');

test('prose: step (0) of the recipe is the rehearsal of the way back from a clean checkout, before everything else, and the hook, order B, plan B, the root README and the BACKLOG say what was verified on 21/10/2026', () => {
  const at = section.indexOf('(0) **First of all, rehearse the way back'), one = section.indexOf('(1) **Before, write down');
  assert.ok(at >= 0 && one > at, 'step (0) comes before step (1)');
  const zero = section.slice(at, one);
  assert.match(zero, /Marco's condition for the first publication of this code \(20\/10\/2026; PRODUCT\.md/);
  assert.match(zero, /the one the Worker names in its `X-Build` header/);
  assert.match(zero, /`git worktree add <an empty folder outside the repository> <that commit>`, and inside it `cd worker && npm ci && npx wrangler deploy --dry-run`/);
  assert.match(zero, /The real redeploy of that checkout is made only in the window, by the main session, and only if the way back is needed; the rehearsal is not it\./);
  assert.match(zero, /Until \(0\) has been done once, the way back that \(1\) relies on is written down and NOT rehearsed\. Not done on 21\/10\/2026/);
  assert.match(PRODUCT, /before the FIRST deploy of this branch, a `wrangler deploy` of the Worker commit then live is rehearsed from a clean checkout/);
  assert.match(section, /that rehearsal is step \(0\)\./);
  assert.match(section, /This repository has no hook; the guard hook is the Stremio repository's `\.claude\/hooks\/trava-subagente\.py`, and for a subagent it lets through exactly the line `npx wrangler deploy --dry-run`[^]*`cd worker && npx wrangler deploy --dry-run` is refused/);
  assert.ok(!section.includes("the one form the project's guard hook lets a subagent run"));
  assert.match(section, /\*\*order B is safe only while that flag is `"false"`\*\*: a copy without the block carries no global layer, so never publish it with the flag `true`/);
  assert.match(section, /\*\*Both commands of order B carry `--var GIT_SHA:\$\(git rev-parse --short HEAD\)`\*\*/);
  assert.match(section, /\*\*and `test\/will-rate-limit-prose\.test\.js` with the `RP:` block of `mutation\.mjs`\*\*: that test reads the binding's test file when it loads/);
  assert.match(FILES['worker/README.md'], /Tests: `test\/will-rate-limit-prose\.test\.js` \(8\) reads this recipe/);
  assert.match(ROOT_README, /\*\*The first publication of this code comes here, before the activation of step 3 \(21\/10\/2026\):\*\* `worker\/wrangler\.toml` still says `WILL_UPLOAD_ENABLED = "false"`/);
  assert.match(ROOT_README, /\*\*Order B \(a copy of `wrangler\.toml` without the `\[\[ratelimits\]\]` block\) is safe only with `WILL_UPLOAD_ENABLED` `"false"`: never publish without the block with the flag `true`\.\*\*/);
  assert.match(ROOT_README, /is in `worker\/README\.md`, "The first publication that carries the binding: the recipe"/);
  assert.match(FILES['worker/wrangler.toml'], /^WILL_UPLOAD_ENABLED = "false"$/m, 'the root README says the flag is false in wrangler.toml');
  assert.match(BACKLOG, /that last clause was wrong\. `will-rate-limit-binding\.test\.js` pins the block of `wrangler\.toml` and the behaviour of `api\.js`, not this sentence; what holds the sentence is `worker\/test\/will-rate-limit-prose\.test\.js` \(test 1\)/);
  assert.match(BACKLOG, /about 200 object calls per \/64 per location in 10 minutes \(up to 220 if the counter is a fixed window of 60 s, since 10 minutes touch 11 windows; more with Cloudflare's approximate counter\)/);
  assert.match(BACKLOG, /before asking Marco, the main session MEASURES how many requests with a token the isolate has not seen/);
});
