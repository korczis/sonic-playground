#!/usr/bin/env bash
# New code is tested (rule project.new-code-tested): scripts/coverage.mjs refuses a changed line
# the tests never ran, accepts one they ran and one exempt with a written reason, refuses a marker
# without a reason and a missing coverage reading, and takes the base from origin/main. A scratch
# repository with an origin/main and fabricated coverage readings proves each side; the real
# script runs from its real path (COVERAGE_ROOT points it at the fixture), so its own coverage
# counts under the gate.
set -euo pipefail
# A hook exports an absolute GIT_DIR; the scratch repository must never act on the calling one.
# shellcheck disable=SC2046
unset $(git rev-parse --local-env-vars)
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/new-code-tested.XXXXXX")
trap 'rm -rf "$work"' EXIT
repo="$work/repo"
mkdir -p "$repo/static/js" "$repo/scripts"
cd "$repo"
git init -q -b main
git config user.email case@example.invalid
git config user.name case
printf 'function old() {\n  return 1;\n}\n' > static/js/app.js
printf 'def old():\n    return 1\n' > scripts/tool.py
git add -A && git commit -qm base
git update-ref refs/remotes/origin/main HEAD

fail() { echo "FAIL new-code-tested: $1" >&2; exit 1; }
run() { COVERAGE_ROOT="$repo" node "$root/scripts/coverage.mjs" --browser "$work/browser.json" --python "$work/py.json" "$@"; }
# A change: two new lines in the browser script (3 and 4), one new function in the Python script.
printf 'function old() {\n  return 1;\n}\nfunction added() { return 2; }\nadded();\n' > static/js/app.js
printf 'def old():\n    return 1\n\ndef added():\n    return 2\n' > scripts/tool.py
py_ran='{"scripts/tool.py": {"executable": [1, 2, 4, 5], "executed": [1, 2, 4, 5]}}'
printf '%s' "$py_ran" > "$work/py.json"

# Line 4 never ran: refused, by name.
printf '{"static/js/app.js": {"covered": [1, 2, 5], "uncovered": [4]}}' > "$work/browser.json"
out=$(run 2>&1) && fail "a changed line the tests never ran passed"
grep -q 'static/js/app.js:4: never ran under the tests' <<<"$out" || fail "the refusal names the line: $out"
grep -q 'since ' <<<"$out" || fail "the report names its base"
echo "ok   new-code-tested: a changed line the tests never ran is refused, by file and line"

# Every changed line ran: accepted.
printf '{"static/js/app.js": {"covered": [1, 2, 4, 5], "uncovered": []}}' > "$work/browser.json"
run > /dev/null 2>&1 || fail "fully covered change refused"
echo "ok   new-code-tested: a change whose every line ran passes"

# Exempt with a reason: accepted and listed; a marker without a reason: refused.
printf 'function old() {\n  return 1;\n}\nfunction added() { return 2; } // untested: only a printer reaches it\nadded();\n' > static/js/app.js
printf '{"static/js/app.js": {"covered": [1, 2, 5], "uncovered": [4]}}' > "$work/browser.json"
out=$(run 2>&1) || fail "an exempt line with a reason was refused: $out"
grep -q 'untested: only a printer reaches it' <<<"$out" || fail "the exemption is listed with its reason"
printf 'function old() {\n  return 1;\n}\nfunction added() { return 2; } // untested\nadded();\n' > static/js/app.js
run > /dev/null 2>&1 && fail "a marker without a reason passed"
printf 'function old() {\n  return 1;\n}\n// untested-begin: a block only a printer reaches\nfunction added() { return 2; }\n// untested-end\nadded();\n' > static/js/app.js
printf '{"static/js/app.js": {"covered": [1, 2, 7], "uncovered": [5]}}' > "$work/browser.json"
out=$(run 2>&1) || fail "a block exempt with a reason was refused: $out"
grep -q 'untested: a block only a printer reaches' <<<"$out" || fail "the block exemption is listed"
printf 'function old() {\n  return 1;\n}\n// untested-begin\nfunction added() { return 2; }\n// untested-end\nadded();\n' > static/js/app.js
run > /dev/null 2>&1 && fail "a block marker without a reason passed"
echo "ok   new-code-tested: an exemption needs a reason, and every exemption is listed"

# A Python line the unit suite never ran: refused; a missing reading: refused.
printf 'function old() {\n  return 1;\n}\nfunction added() { return 2; }\nadded();\n' > static/js/app.js
printf '{"static/js/app.js": {"covered": [1, 2, 4, 5], "uncovered": []}}' > "$work/browser.json"
printf '{"scripts/tool.py": {"executable": [1, 2, 4, 5], "executed": [1, 2]}}' > "$work/py.json"
out=$(run 2>&1) && fail "an unrun Python line passed"
grep -q 'scripts/tool.py:5: never ran' <<<"$out" || fail "the Python refusal names the line: $out"
printf '%s' "$py_ran" > "$work/py.json"
rm "$work/browser.json"
out=$(run 2>&1) && fail "a change judged without its browser reading passed"
grep -q 'no coverage reading for browser' <<<"$out" || fail "the missing reading is named: $out"
echo "ok   new-code-tested: unrun Python lines and a missing reading are refused"

# A browser script no page loaded is unread as a whole: its changed lines are refused.
printf '{"static/js/other.js": {"covered": [1], "uncovered": []}}' > "$work/browser.json"
out=$(run 2>&1) && fail "a changed script no page loaded passed"
grep -q 'static/js/app.js:4: never ran' <<<"$out" || fail "an unloaded script's lines are named: $out"
echo "ok   new-code-tested: a changed script no page loaded is refused"

# A Node script judged by Node's own coverage files (NODE_V8_COVERAGE): one line ran, one never.
printf '{"static/js/app.js": {"covered": [1, 2, 4, 5], "uncovered": []}}' > "$work/browser.json"
printf 'export function a() { return 1; }\nexport function b() { return 2; }\na();\n' > scripts/gate.mjs
src_len=$(wc -c < scripts/gate.mjs | tr -d ' ')
# The offsets come from the file itself: line 2 is function b, from its first character to its last.
b_start=$(head -1 scripts/gate.mjs | wc -c | tr -d ' ')
b_end=$((b_start + $(sed -n 2p scripts/gate.mjs | wc -c | tr -d ' ') - 1))
mkdir -p "$work/node"
cat > "$work/node/coverage-1.json" <<JSON
{"result": [{"url": "file://$repo/scripts/gate.mjs", "functions": [
  {"functionName": "", "ranges": [{"startOffset": 0, "endOffset": $src_len, "count": 1}]},
  {"functionName": "a", "ranges": [{"startOffset": 0, "endOffset": $((b_start - 1)), "count": 1}]},
  {"functionName": "b", "ranges": [{"startOffset": $b_start, "endOffset": $b_end, "count": 0}]}]}]}
JSON
out=$(run --node "$work/node" 2>&1) && fail "an unrun Node line passed"
grep -q 'scripts/gate.mjs:2: never ran' <<<"$out" || fail "the Node refusal names line 2: $out"
grep -q 'scripts/gate.mjs:1:' <<<"$out" && fail "a Node line that ran was refused: $out"
rm scripts/gate.mjs
echo "ok   new-code-tested: a Node script is judged by Node's own coverage"

# COVERAGE_BASE moves the base (CI: the commit before the push); a repository with neither an
# origin/main nor a parent has no base and is refused, never judged against nothing.
git add -A && git commit -qm change
out=$(COVERAGE_BASE=HEAD run 2>&1) || fail "nothing changed since COVERAGE_BASE=HEAD, yet refused: $out"
grep -q '0 changed line' <<<"$out" || fail "COVERAGE_BASE=HEAD judges nothing: $out"
lone="$work/lone"
mkdir -p "$lone" && cd "$lone" && git init -q -b main && git config user.email c@example.invalid \
  && git config user.name c && printf 'x\n' > f && git add f && git commit -qm only
out=$(COVERAGE_ROOT="$lone" node "$root/scripts/coverage.mjs" 2>&1) && fail "a repository with no base passed"
grep -q 'no base' <<<"$out" || fail "the refusal says there is no base: $out"
echo "ok   new-code-tested: COVERAGE_BASE sets the base, and no base is a refusal"

# The pre-push gate has no browser: --no-browser leaves the browser scripts to the full gate, says
# so for each, and still judges the rest.
cd "$repo"
printf 'function old() {\n  return 1;\n}\nfunction added() { return 2; }\n' > static/js/app.js
out=$(COVERAGE_ROOT="$repo" node "$root/scripts/coverage.mjs" --no-browser --python "$work/py.json" 2>&1) || fail "--no-browser refused a browser-only change: $out"
grep -q 'skipped static/js/app.js' <<<"$out" || fail "--no-browser names what it leaves to the full gate: $out"
echo "ok   new-code-tested: without a browser the browser scripts are left, by name, to the full gate"

# A block left open would exempt the rest of the file, and an end without a begin is a slip: both
# are refused. A Python script missing from its reading is unread, never "nothing to run".
printf 'function old() {\n  return 1;\n}\n// untested-begin: forgot to close\nfunction added() { return 2; }\n' > static/js/app.js
printf '{"static/js/app.js": {"covered": [1, 2], "uncovered": [5]}}' > "$work/browser.json"
out=$(run --no-browser 2>&1) && fail "an open exemption block passed"
grep -q 'not closed' <<<"$out" || fail "the open block is named: $out"
printf 'function old() {\n  return 1;\n}\n// untested-end\nfunction added() { return 2; }\n' > static/js/app.js
run --no-browser > /dev/null 2>&1 && fail "an end without a begin passed"
printf 'function old() {\n  return 1;\n}\n' > static/js/app.js
printf 'def old():\n    return 1\n\ndef added():\n    return 2\n' > scripts/tool.py
printf '{}' > "$work/py.json"
out=$(run --no-browser 2>&1) && fail "a Python script missing from its reading passed"
grep -q 'not in the reading' <<<"$out" || fail "the missing Python reading is named: $out"
printf '%s' "$py_ran" > "$work/py.json"
echo "ok   new-code-tested: an open block, an orphan end and a script missing from its reading are refused"

# A diff git cannot make (here a damaged index) is no reading: refused, never "nothing changed".
cp .git/index "$work/index.good"
printf 'not an index' > .git/index
out=$(run --no-browser 2>&1) && fail "a failed git diff passed"
grep -q 'git diff from' <<<"$out" || fail "the failed diff is named: $out"
cp "$work/index.good" .git/index
echo "ok   new-code-tested: a diff git could not make is refused"
