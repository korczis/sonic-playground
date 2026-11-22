---
id: project.new-code-tested
version: 1
kind: rule
title: Every line a change adds runs under the tests, the site's code in a real browser
description: A change to static/js, scripts/*.mjs|cjs or scripts/*.py ships with tests that run every line it adds or modifies; the site's scripts are exercised end to end by the Playwright smoke test in a real browser. scripts/coverage.mjs refuses a changed line no test ran, unless the line carries a written reason why it cannot run under the tests.
statement: Cover every line a change adds or modifies with tests that run it - the site's browser code through test/e2e/smoke.cjs in a real browser (V8 block coverage of every page the feature checks open), the Node scripts through the gate's own runs (NODE_V8_COVERAGE), the Python scripts through the unit suite (test/pycov.py) - and keep scripts/coverage.mjs green in scripts/verify.sh; a line that cannot run under the tests carries `// untested: <reason>` (or a block between `// untested-begin: <reason>` and `// untested-end`; `#` in Python), and every exemption is listed in every run.
status: active
class: blocking
depends_on: [project.deploy-gate@1, project.console-clean@1]
tags: [testing, coverage, e2e, playwright, quality]
x-majordomus:
  tests: [scripts/coverage.mjs, test/cases/69_new_code_tested.sh, test/e2e/smoke.cjs]
---

# Rationale

The owner, 2026-11-22: "pokryj vse end-to-end playwright real testy; tyto testy a pozadavek na
pokryti veskereho noveho kodu testy od ted nyni vzdy enforce" (cover everything with end-to-end,
real Playwright tests; enforce these tests and the requirement that all new code is covered by
tests, from now on, always).

The same day showed why a check per feature is not enough. The visualiser grew from 7 to 25
modes with green unit tests, a green type check and a smoke test that every mode "draws". An
independent review then found two high defects in code no test had run: the cinema video covered
by the open queue, and a close that threw when a mode was left before its first frame, leaving
the page inert. The first browser run of every mode had already found a constructor that threw
and leaked a canvas per switch. Code a test never runs is code whose defects only a reader finds.

# Required behaviour

- The change is the diff from a base: `COVERAGE_BASE` (CI: the pull request's base, or the
  commit before the push), else the merge base with origin/main; where that is HEAD itself, HEAD
  when the working tree holds the change, else HEAD's first parent. Untracked files count whole.
- Judged: `static/js/*.js` by the browser's coverage, recorded by `test/e2e/smoke.cjs` with
  `SMOKE_COVERAGE` from every page its feature checks open (instrumented before navigation;
  the sitemap sweep is not recorded); `scripts/*.mjs|cjs` by Node's own coverage of the gate's
  runs; `scripts/*.py` by `test/pycov.py` over the unit suite (a script a test runs in a
  subprocess is not seen: such a line needs a unit test of its own, or a reason).
- A changed line is covered when any of its characters ran (a statement on the line executed).
  Blank lines, comments and punctuation-only lines are never judged.
- An exemption is a trailing `// untested: <reason>` on the line, or alone on the line above it,
  or a block between `// untested-begin: <reason>` and `// untested-end` (`#` in Python). A
  marker without a reason is refused. Every exemption is printed with its reason in every run,
  so the count stays visible.
- `scripts/verify.sh` runs the check as its last step. With `--no-browser` (the pre-push hook)
  the browser scripts are named and left to the full gate; CI's site job runs the full gate on
  every pull request and every deploy.

# Failure behaviour

`scripts/coverage.mjs` exits 1 and names every changed line no test ran
(`<file>:<line>: never ran under the tests: <code>`), every marker without a reason, and a
missing coverage reading; a repository with no base to diff against is refused, never judged
against nothing.

# Verification

```sh
bash test/run.sh 69_new_code_tested     # the checker: refuses, accepts, exempts, needs a reason
bash scripts/verify.sh                   # step 7 judges the change against the real readings
```
