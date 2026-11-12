#!/usr/bin/env bash
# Conventional Commits gate, shared by the commit-msg hook and CI.
# usage: lint-commits.sh <rev-range>     check every commit subject on the first-parent line of the range
#        (histories merged in from other repositories keep their original messages)
#        lint-commits.sh --file <path>   check one commit message file (commit-msg hook)
set -euo pipefail

PATTERN='^(feat|fix|perf|refactor|docs|style|test|build|ci|chore|revert)(\([a-z0-9._/-]+\))?!?: .{1,100}$'
EXEMPT='^(Merge |Revert ")'

valid() {
  [[ "$1" =~ $EXEMPT ]] || [[ "$1" =~ $PATTERN ]]
}

explain() {
  echo "expected: type(scope): description" >&2
  echo "types:    feat fix perf refactor docs style test build ci chore revert (add ! for breaking)" >&2
}

if [[ "${1:-}" == "--file" ]]; then
  subject="$(head -n1 "${2:?--file needs a path}")"
  if valid "$subject"; then
    exit 0
  fi
  echo "commit-msg: not a conventional commit: $subject" >&2
  explain
  exit 1
fi

RANGE="${1:?usage: lint-commits.sh <rev-range> | --file <path>}"
bad=0
count=0
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  count=$((count + 1))
  if ! valid "${line#* }"; then
    echo "✗ $line" >&2
    bad=1
  fi
done < <(git log --first-parent --format='%h %s' "$RANGE")

if [[ "$bad" == 1 ]]; then
  explain
  exit 1
fi
echo "conventional commits: $count checked, PASS"
