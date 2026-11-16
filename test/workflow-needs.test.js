"use strict";
// 20/10/2026 — run 39448820729 (push of 5c0be73): the `deploy` job was SKIPPED with `build` and `commit-cache` green. Cause: `deploy` had `needs: build` and no `if`. Without an `if`, GitHub puts an
// implicit success() in front, and success() is false when ANY job up the `needs` chain was skipped, not only the direct one: `reconcile-will` is skipped while WILL_UPLOAD_ENABLED is not 'true',
// `build` ran anyway because of its own `if: always() && ...`, and `deploy` (two levels down) was skipped. The earlier push runs (39336723574, 39319459037) predate the Will job and published.
// The rule this file guards: a job that reaches a conditional job through `needs` (directly or further up) carries its own `if` with `!cancelled()` or `always()`, and
// unless it is listed as running regardless, it tests `needs.<job>.result` for each job it needs.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WORKFLOWS = path.join(ROOT, ".github", "workflows");

/** Jobs that run on purpose whatever happened before; each needs a reason. */
const RUNS_REGARDLESS = {
  "commit-cache": "saves the night's caches even when the build stopped (14/10/2026: hours of page lookups must not be thrown away with a failed check)",
};

/** { name: { text, needs: [names], iff: string|null } } from the workflow's text; only the `needs: a` and `needs: [a, b]` forms exist in these files, anything else stops the test. */
function jobsOf(yml) {
  const at = yml.search(/^jobs:\s*$/m);
  assert.ok(at >= 0, "a jobs: section");
  const body = yml.slice(at).split("\n").slice(1).join("\n");
  const starts = [...body.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)];
  const jobs = {};
  starts.forEach((m, i) => {
    const text = body.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : body.length);
    const lines = text.split("\n").filter((l) => !/^\s*#/.test(l));
    const need = lines.find((l) => /^    needs:/.test(l));
    let needs = [];
    if (need) {
      const v = need.replace(/^    needs:\s*/, "").replace(/\s#\s.*$/, "").trim();
      const list = v.match(/^\[(.*)\]$/);
      needs = list ? list[1].split(",").map((s) => s.trim()).filter(Boolean) : [v];
      assert.ok(needs.every((n) => /^[A-Za-z0-9_-]+$/.test(n)), `the needs of ${m[1]} is in a form this test reads: ${need.trim()}`);
    }
    const iff = lines.find((l) => /^    if:/.test(l));
    jobs[m[1]] = { text, needs, iff: iff ? iff.replace(/^    if:\s*/, "").replace(/\s#\s.*$/, "").trim() : null };
  });
  return jobs;
}

/** Every job reached from `name` through `needs`, directly or further up. */
function ancestors(jobs, name, seen = new Set()) {
  for (const n of jobs[name].needs) {
    assert.ok(jobs[n], `${name} needs a job that exists: ${n}`);
    if (!seen.has(n)) { seen.add(n); ancestors(jobs, n, seen); }
  }
  return seen;
}

/** The jobs that break the rule, as "job: why". */
function offenders(yml) {
  const jobs = jobsOf(yml), bad = [];
  for (const [name, job] of Object.entries(jobs)) {
    const conditional = [...ancestors(jobs, name)].filter((a) => jobs[a].iff !== null);
    if (!conditional.length) continue;
    const iff = job.iff || "";
    if (!/!cancelled\(\)|\balways\(\)/.test(iff)) { bad.push(`${name}: needs ${[...ancestors(jobs, name)].join(", ")} and ${conditional.join(", ")} has an if, but ${name} has no !cancelled()/always() (implicit success() skips it)`); continue; }
    if (name in RUNS_REGARDLESS) continue;
    for (const n of job.needs) if (!new RegExp(`needs\\.${n.replace(/-/g, "\\-")}\\.result`).test(iff)) bad.push(`${name}: its if does not test needs.${n}.result`);
  }
  return bad;
}

const nightly = fs.readFileSync(path.join(WORKFLOWS, "mood-engine.yml"), "utf8");

test("no job is skipped by a skipped job further up its needs chain: each has its own !cancelled()/always() and tests the result of what it needs", () => {
  for (const f of fs.readdirSync(WORKFLOWS).filter((n) => /\.ya?ml$/.test(n))) {
    assert.deepEqual(offenders(fs.readFileSync(path.join(WORKFLOWS, f), "utf8")), [], f);
  }
});

test("control: the check sees the 20/10/2026 defect (deploy without an if, two levels below the skipped Will job) and its variants", () => {
  const jobs = jobsOf(nightly);
  assert.ok(jobs["reconcile-will"].iff !== null, "the Will job is conditional");
  assert.ok(jobs.build.needs.includes("reconcile-will"), "build is below it");
  assert.deepEqual(jobs.deploy.needs, ["build"]);
  // deploy's if removed: the run of 20/10
  const without = nightly.replace(/^    if: \$\{\{ !cancelled\(\) && needs\.build\.result == 'success' \}\}\n/m, "");
  assert.notEqual(without, nightly, "the control edit found deploy's if");
  assert.match(offenders(without).join("\n"), /^deploy: needs build, reconcile-will/);
  // the same if with the result test dropped would publish after a failed build
  const noResult = nightly.replace("!cancelled() && needs.build.result == 'success'", "!cancelled()");
  assert.deepEqual(offenders(noResult), ["deploy: its if does not test needs.build.result"]);
  // a condition on something else is still an implicit success()
  const other = nightly.replace("!cancelled() && needs.build.result == 'success'", "github.ref == 'refs/heads/main'");
  assert.match(offenders(other).join("\n"), /deploy: .*no !cancelled\(\)\/always\(\)/);
  // a conditional job at the top of a chain of three
  const chain = "jobs:\n  a:\n    if: vars.X == 'true'\n    runs-on: x\n  b:\n    needs: [a]\n    if: always()\n    runs-on: x\n  c:\n    needs: b\n    runs-on: x\n  d:\n    needs: c\n    if: ${{ !cancelled() && needs.c.result == 'success' }}\n    runs-on: x\n";
  assert.match(offenders(chain).join("\n"), /^b: its if does not test needs\.a\.result\nc: needs b, a and b, a has an if/);
});

test("deploy keeps the condition that lets it run with the Will job skipped and the build green, and not after a failed or cancelled build", () => {
  const iff = jobsOf(nightly).deploy.iff;
  assert.equal(iff, "${{ !cancelled() && needs.build.result == 'success' }}");
});
