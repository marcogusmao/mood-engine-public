'use strict';
// S7b of the 20/10/2026 security review: GH_TOKEN was in the environment of `register` and `revoke` too, though only `abandon`
// uses it (to read the terminal run through the GitHub API). Now it is set only when the operation is `abandon`.
const test = require('node:test'), a = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/will-invitation.yml'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'scripts/will-invitation.js'), 'utf8');

test('GH_TOKEN reaches the step only for the abandon operation, and github.token appears nowhere else in the workflow', () => {
  const lines = workflow.split('\n').filter(l => /^\s*GH_TOKEN:/.test(l));
  a.equal(lines.length, 1);
  a.match(lines[0], /^\s*GH_TOKEN: \$\{\{ inputs\.operation == 'abandon' && github\.token \|\| '' \}\}\s*$/);
  a.equal(workflow.split('github.token').length - 1, 1);
  a.ok(!/secrets\./.test(workflow), 'no repository secret is handed to the invitation job');
  a.ok(!/GITHUB_TOKEN|GH_TOKEN/.test(workflow.replace(lines[0], '').replace(/^\s*#.*$/gm, '')), 'no second route for the token');
});

test('the script reads GH_TOKEN only inside the abandon branch', () => {
  const uses = [...script.matchAll(/process\.env\.GH_TOKEN/g)];
  a.equal(uses.length, 1);
  a.ok(uses[0].index > script.indexOf("command==='abandon'"), 'the read comes after the abandon branch starts');
  a.ok(uses[0].index < script.indexOf("else throw Error('Unknown invitation operation')"), 'and before the branch chain ends');
});

test('the invitation job keeps its fences: main only, the intake variable, the admin environment, no raw invitation input', () => {
  a.match(workflow, /if: github\.ref == 'refs\/heads\/main' && vars\.WILL_UPLOAD_ENABLED == 'true'/);
  a.match(workflow, /environment: mood-will-admin/);
  a.match(workflow, /permissions: \{\}\n/);
  a.ok(!/inputs\.token|inputs\.invite\b/.test(workflow));
});
