"use strict";
// 20/10/2026 — hygiene of the nightly workflow (.github/workflows/mood-engine.yml), read as text: no YAML library is installed in the repository.
//   S3 (BACKLOG, review of 8e37c23): a job that can mint an OIDC token (`id-token: write`) must not install third-party code (`npm ci`, `npm install`):
//   the install scripts of esbuild, workerd and fsevents would run where the token can be issued. Before the fix the `build` job had both (id-token at line 67, `npm ci` at line 81).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WORKFLOWS = path.join(ROOT, ".github", "workflows");

/** Drops whole-line comments and trailing ` # comment` (the workflow has no `#` inside a quoted string followed by a space except in `name:`, which this reader does not execute). */
const code = (text) => text.split("\n").filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s#\s.*$/, "")).join("\n");

/** { workflowPermissions: text, jobs: { name: text } } from the workflow's text. A job starts at `  name:` (two spaces) under `jobs:` and ends at the next one. */
function parse(yml) {
  const at = yml.search(/^jobs:\s*$/m);
  assert.ok(at >= 0, "the workflow has a jobs: section");
  const head = yml.slice(0, at), body = yml.slice(at).split("\n").slice(1).join("\n");
  const jobs = {};
  const starts = [...body.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)];
  starts.forEach((m, i) => {
    jobs[m[1]] = body.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : body.length);
  });
  return { head, jobs };
}

/** The permissions a block grants: a `permissions:` mapping (keys at any deeper indent), or the one-line forms `write-all` / `{}`. */
function permissionsOf(text) {
  const out = {};
  const lines = code(text).split("\n");
  const i = lines.findIndex((l) => /^\s*permissions:/.test(l));
  if (i < 0) return { declared: false, grants: out };
  const first = lines[i].match(/^(\s*)permissions:\s*(.*)$/);
  if (first[2].trim() === "write-all") return { declared: true, grants: { "id-token": "write", contents: "write", "write-all": "write" } };
  const indent = first[1].length;
  for (let j = i + 1; j < lines.length; j++) {
    const m = lines[j].match(/^(\s*)([a-z-]+):\s*(\w[\w-]*)\s*$/);
    if (!lines[j].trim()) continue;
    if (!m || m[1].length <= indent) break;
    out[m[2]] = m[3];
  }
  return { declared: true, grants: out };
}

/** Commands that install third-party code. Comments are removed first: the workflow explains itself in comments that name these commands. */
const INSTALL = /\b(?:npm\s+(?:ci|install|i|add)\b|pnpm\s+(?:install|i|add)\b|yarn\s+(?:install|add)\b|npx\b|bun\s+(?:install|add)\b)/;
const installs = (jobText) => INSTALL.test(code(jobText));

/** The (workflow, job) pairs that can mint an OIDC token and also run an install, as "file:job" strings. */
function offenders(files) {
  const bad = [];
  for (const [file, yml] of files) {
    const { head, jobs } = parse(yml);
    const wide = permissionsOf(head);
    for (const [name, text] of Object.entries(jobs)) {
      const own = permissionsOf(text);
      const grants = own.declared ? own.grants : wide.grants;
      if (grants["id-token"] === "write" && installs(text)) bad.push(`${file}:${name}`);
    }
  }
  return bad;
}

const files = () => fs.readdirSync(WORKFLOWS).filter((n) => /\.ya?ml$/.test(n)).map((n) => [n, fs.readFileSync(path.join(WORKFLOWS, n), "utf8")]);
const nightly = fs.readFileSync(path.join(WORKFLOWS, "mood-engine.yml"), "utf8");

test("S3: no job of any workflow holds `id-token: write` and also runs npm ci / npm install", () => {
  assert.deepEqual(offenders(files()), []);
});

test("S3 control: the check sees the defect — the nightly as it was (build holding id-token with `npm ci`), a workflow-wide id-token, `write-all`, and `npm install`", () => {
  // putting the install and the token in one job again: the old build job
  const merged = nightly.replace(/(  build:[\s\S]*?      - uses: actions\/setup-node[^\n]*\n        with:\n          node-version: 22\n)/, "$1\n      - name: Install\n        run: npm ci\n");
  assert.notEqual(merged, nightly, "the control edit found the build job's setup-node step");
  assert.deepEqual(offenders([["mood-engine.yml", merged]]), ["mood-engine.yml:build"]);
  const noBlock = "permissions:\n  id-token: write\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: npm ci\n";
  assert.deepEqual(offenders([["b.yml", noBlock]]), ["b.yml:t"], "a job with no block of its own inherits the workflow-wide token");
  assert.deepEqual(offenders([["c.yml", "jobs:\n  t:\n    permissions: write-all\n    steps:\n      - run: |\n          cd w\n          npm install\n"]]), ["c.yml:t"]);
  assert.deepEqual(offenders([["d.yml", "jobs:\n  t:\n    permissions:\n      id-token: write\n    steps:\n      # npm ci is only named in this comment\n      - run: node x.js # npm ci\n"]]), [], "a command named in a comment is not run");
});

test("S3: the install lives in the `test` job, which has contents: read and nothing else, no secret and no environment; `build` runs no install and still holds the token", () => {
  const { jobs } = parse(nightly);
  assert.deepEqual(Object.keys(jobs), ["reconcile-will", "test", "build", "commit-cache", "deploy", "prune-covers-cache"]);
  assert.deepEqual(permissionsOf(jobs.test), { declared: true, grants: { contents: "read" } });
  assert.ok(installs(jobs.test), "the test job installs the locked Worker dependencies");
  assert.match(code(jobs.test), /working-directory: worker\n\s+run: npm ci/);
  assert.ok(!/secrets\.|environment:/.test(code(jobs.test)), "no secret, no environment");
  assert.ok(!installs(jobs.build), "the build job installs nothing with npm");
  assert.equal(permissionsOf(jobs.build).grants["id-token"], "write", "the build still gets the build-role token when Will is on");
  assert.ok(!/node --test|unittest/.test(code(jobs.build)), "the suite runs in the test job, not where the token is");
  for (const name of ["reconcile-will", "commit-cache", "deploy"]) assert.ok(!installs(jobs[name]), `${name} installs nothing`);
});

test("S3: the build waits for a green test job (a failed or skipped test stops the night before any page is read); the Will job may be skipped", () => {
  const { jobs } = parse(nightly);
  assert.match(jobs.build, /needs: \[reconcile-will, test\]/);
  assert.match(code(jobs.build), /if: always\(\) && needs\.test\.result == 'success' && \(needs\.reconcile-will\.result == 'success' \|\| needs\.reconcile-will\.result == 'skipped'\)/);
  assert.match(jobs.deploy, /needs: build/, "the deploy waits for the build, which waits for the tests");
  assert.match(code(jobs.test), /git archive d503ae03e3af87b8aa55e00f5225735d8ad7a128/, "the reference the suite reads is prepared in the job that runs it");
  assert.match(code(jobs.test), /fetch-depth: 0/, "git archive of a past commit needs the history");
});

// ── Stremio BACKLOG item 14 (20/10/2026): the covers' cache is one entry per run; the old ones are removed after the build ─────────────────────────────────
// Measured 20/10/2026 with the API: 11 `posters-*` entries of 948-953 MB = 10.46 GB, at the repository's 10 GiB limit. The conservative fix keeps the per-run key (a fixed key brings back
// "Cache hit occurred ... not saving cache") and adds a later job, because the cache action saves its entry in the post step of the build job.

const prune = () => parse(nightly).jobs["prune-covers-cache"];
/** The shell text of the prune step, as the runner would receive it. */
function pruneScript() {
  const text = code(prune());
  const at = text.indexOf("run: |\n");
  assert.ok(at >= 0, "the prune job has a run block");
  return text.slice(at + "run: |\n".length).split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
}
/** Runs the prune script with a fake `gh` that lists `ids` (newest first, as asked) and records every call. */
function runPrune(ids, script = pruneScript(), failList = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prune-covers-"));
  try {
    const log = path.join(dir, "calls.log"), list = path.join(dir, "ids.txt");
    fs.writeFileSync(list, ids.map((i) => i + "\n").join(""));
    fs.writeFileSync(path.join(dir, "gh"), '#!/bin/sh\necho "$@" >> "$FAKE_LOG"\ncase "$1 $2" in\n  "cache list") [ -n "$FAKE_FAIL" ] && exit 1; cat "$FAKE_IDS" ;;\n  "cache delete") ;;\n  *) exit 9 ;;\nesac\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "run.sh"), script);
    const r = spawnSync("bash", ["-e", path.join(dir, "run.sh")], { encoding: "utf8", env: { PATH: dir + path.delimiter + process.env.PATH, FAKE_LOG: log, FAKE_IDS: list, FAKE_FAIL: failList ? "1" : "", REPO: "owner/repo", REF: "refs/heads/main", GH_TOKEN: "not-a-token" } });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
    return { status: r.status, out: r.stdout, err: r.stderr, calls, deleted: calls.filter((c) => c.startsWith("cache delete")).map((c) => c.split(" ")[2]), listed: calls.filter((c) => c.startsWith("cache list")) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("covers cache: the prune job runs after the build, with `actions: write` and nothing else, no checkout, no action, no secret, and never fails the night", () => {
  const job = prune(), c = code(job);
  assert.match(c, /needs: build\n/);
  assert.match(c, /if: always\(\) && \(needs\.build\.result == 'success' \|\| needs\.build\.result == 'failure'\)/, "not when the build never started (a failed test job)");
  assert.deepEqual(permissionsOf(job), { declared: true, grants: { actions: "write" } });
  assert.ok(!/uses:/.test(c), "no checkout and no third-party action: nothing of ours or anyone's runs with this permission but the few shell lines");
  assert.ok(!/secrets\./.test(c), "no repository secret");
  assert.match(c, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(c, /continue-on-error: true/, "a failed cleanup does not fail the night");
  assert.ok(!/\$\{\{/.test(pruneScript()), "no expression is spliced into the shell text; the values arrive through env:");
  assert.ok(!installs(job));
});

test("covers cache: the key stays per run (a fixed key brings back the old 'not saving cache' defect) and restores by the prefix", () => {
  const { jobs } = parse(nightly);
  assert.match(jobs.build, /key: posters-\$\{\{ github\.run_id \}\}\n\s+restore-keys: posters-\n/);
});

test("covers cache: it asks for this ref's posters-* entries newest first by creation time, keeps two and removes every older one by id", () => {
  const six = runPrune(["60", "50", "40", "30", "20", "10"]);
  assert.equal(six.status, 0, six.err);
  assert.deepEqual(six.deleted, ["40", "30", "20", "10"], "the two newest (60, 50) stay");
  assert.equal(six.listed.length, 1);
  for (const piece of ["-R owner/repo", "--ref refs/heads/main", "--key posters-", "--sort created_at", "--order desc", "--limit 100"]) assert.ok(six.listed[0].includes(piece), `the listing asks for ${piece}: ${six.listed[0]}`);
  assert.ok(six.calls.filter((c) => c.startsWith("cache delete")).every((c) => c.endsWith("-R owner/repo")), "each removal names the repository (there is no checkout to infer it from)");
  const eleven = runPrune(Array.from({ length: 11 }, (_, i) => String(110 - i)));
  assert.equal(eleven.deleted.length, 9, "the 11 entries measured on 20/10 become 2");
  assert.ok(!eleven.deleted.includes("110") && !eleven.deleted.includes("109"));
});

test("covers cache: with two, one or no entry it removes nothing and succeeds", () => {
  for (const ids of [["2", "1"], ["1"], []]) {
    const r = runPrune(ids);
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(r.deleted, [], `ids ${JSON.stringify(ids)}`);
  }
});

test("covers cache: control — the same harness catches a script that keeps one, keeps three, or lists by last access or without the prefix", () => {
  const good = pruneScript();
  assert.deepEqual(runPrune(["4", "3", "2", "1"], good.replace("tail -n +3", "tail -n +2")).deleted, ["3", "2", "1"], "keeping one removes the entry the next night restores from");
  assert.deepEqual(runPrune(["4", "3", "2", "1"], good.replace("tail -n +3", "tail -n +4")).deleted, ["1"]);
  assert.ok(!runPrune(["4", "3", "2", "1"], good.replace("--sort created_at ", "")).listed[0].includes("--sort created_at"), "dropping the sort is visible to the listing assertion (gh then sorts by last access)");
  assert.ok(!runPrune(["4", "3", "2", "1"], good.replace("--key posters- ", "")).listed[0].includes("--key posters-"), "dropping the prefix would let it remove the npm caches");
  assert.ok(!runPrune(["4", "3", "2", "1"], good.replace("--limit 100", "--limit 2")).listed[0].includes("--limit 100"), "a smaller limit would list two and never remove anything (survived the first round of mutations, 20/10/2026)");
});

test("covers cache: when gh itself fails, the step ends in error with a ::warning:: annotation (continue-on-error keeps the night green, so the log is where it shows) and removes nothing", () => {
  const r = runPrune(["4", "3", "2", "1"], pruneScript(), true);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /::warning::covers cache not pruned/);
  assert.deepEqual(r.deleted, []);
  assert.ok(!/::warning::/.test(runPrune(["4", "3", "2", "1"]).out), "no warning on a good run");
});

// ── review of 20/10/2026 (clean context) ──────────────────────────────────────────────────────────────────────────────────────────────────

test("the test job's time limit comes from the runner: at least 120 minutes (the root suite took 2,329 to 3,746 s there in the last 15 runs; a limit of 60 skips build and deploy)", () => {
  const { jobs } = parse(nightly);
  const m = code(jobs.test).match(/^    timeout-minutes: (\d+)\s*$/m);
  assert.ok(m, "the test job declares timeout-minutes");
  assert.ok(Number(m[1]) >= 120, `timeout-minutes is ${m[1]}`);
  const was = nightly.replace(/^    timeout-minutes: 150$/m, "    timeout-minutes: 60");
  assert.notEqual(was, nightly, "the control edit found the limit");
  assert.equal(Number(code(parse(was).jobs.test).match(/^    timeout-minutes: (\d+)/m)[1]) >= 120, false, "control: the reader sees a limit of 60 as below the floor");
});

/** Lines whose plain (unquoted) one-line value contains ": " — a YAML error ("mapping values are not allowed here") that these text readers cannot see; block scalars (run: |) are skipped. */
function plainScalarsWithColon(yml) {
  const bad = [];
  let skipIndent = -1;
  yml.split("\n").forEach((line, i) => {
    const indent = line.length - line.trimStart().length;
    if (skipIndent >= 0) { if (!line.trim() || indent > skipIndent) return; skipIndent = -1; }
    if (/^\s*#/.test(line)) return;
    const block = line.match(/^(\s*)(?:- )?[\w.-]+:\s*[|>][-+]?\s*(#.*)?$/);
    if (block) { skipIndent = block[1].length; return; }
    const m = line.replace(/\s#\s.*$/, "").match(/^\s*(?:- )?[\w.-]+:\s+(?!["'|>\[{&*!])(.*\S)\s*$/);
    if (m && /:\s/.test(m[1])) bad.push(`${i + 1}: ${line.trim().slice(0, 90)}`);
  });
  return bad;
}

test("YAML pitfall the text readers cannot see (found 20/10/2026 in `run: pip install --only-binary=:all: pillow`, which PyYAML refused): no plain one-line value contains ': '", () => {
  for (const [f, yml] of files()) assert.deepEqual(plainScalarsWithColon(yml), [], f);
  const broken = nightly.replace('run: "pip install --only-binary=:all: pillow==12.3.0"', "run: pip install --only-binary=:all: pillow==12.3.0");
  assert.notEqual(broken, nightly, "the control edit found the quoted step");
  assert.equal(plainScalarsWithColon(broken).length, 1, "control: the unquoted form is seen");
  assert.deepEqual(plainScalarsWithColon("a:\n  run: |\n    echo \"x: y\"\n  if: \"${{ a == 'b: c' }}\"\n"), [], "block scalars and quoted values are left alone");
});

test("every pip install in the nightly takes binary wheels only, so no setup code of a source package runs where the token can be minted", () => {
  const lines = code(nightly).split("\n").filter((l) => /\bpip install\b/.test(l));
  assert.equal(lines.length, 2, "the test job and the build job");
  for (const l of lines) assert.match(l, /--only-binary=:all:/, l.trim());
});

/** Active triggers under `on:` (comments removed): the keys two spaces in. */
function triggers(yml) { const c = code(yml); const m = c.match(/^on:[ \t]*\n((?:(?:  .*)?\n)*)/m); assert.ok(m, "an on: block"); return [...m[1].matchAll(/^  ([a-z_]+):/gm)].map((x) => x[1]); }

test("21/10/2026 (Marco: the nightly runs on the Mac, scripts/noturna-mac.sh): mood-engine.yml starts only by hand; schedule and push stay as comments", () => {
  assert.deepEqual(triggers(nightly), ["workflow_dispatch"]);
  assert.match(nightly, /^  # schedule:\n  #   - cron: "10 9 \* \* \*"/m);
  assert.match(nightly, /^  # push:\n  #   branches: \[main\]\n  #   paths: \[/m);
  const back = nightly.replace(/^  # schedule:\n  #   - cron:/m, "  schedule:\n    - cron:");
  assert.notEqual(back, nightly, "the control edit found the commented schedule");
  assert.deepEqual(triggers(back), ["schedule", "workflow_dispatch"], "control: an active schedule is seen");
});
