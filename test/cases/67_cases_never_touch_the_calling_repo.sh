#!/usr/bin/env bash
# No case reaches the repository of the git that runs it (test/run.sh). A hook of a linked
# worktree exports an absolute GIT_DIR; on 2026-11-15 case 66, run by pre-push, inherited it and
# re-initialised the real repository. Here the calling repository is a decoy: GIT_DIR points at
# it while run.sh runs case 66, whose scratch repository commits, branches and sets
# core.hooksPath. The decoy's config, refs and HEAD must come out byte-identical.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/calling-repo.XXXXXX")
trap 'rm -rf "$work"' EXIT
git init -q -b trunk "$work/decoy"
git -C "$work/decoy" -c user.name=case -c user.email=case@example.invalid \
  commit -q --allow-empty -m decoy --no-verify
state() {
  { cat "$work/decoy/.git/config" "$work/decoy/.git/HEAD"
    git --git-dir="$work/decoy/.git" for-each-ref --format='%(refname) %(objectname)'; }
}
before=$(state)
runner="${MJ_CASE_RUNNER:-$root/test/run.sh}"
rc=0
GIT_DIR="$work/decoy/.git" bash "$runner" 66_merge_commit_judged > "$work/run.log" 2>&1 || rc=$?
after=$(state)
if [ "$before" != "$after" ]; then
  diff <(echo "$before") <(echo "$after") || true
  echo "FAIL calling-repo: a case changed the repository of the git that ran it" >&2
  exit 1
fi
[ "$rc" -eq 0 ] || { cat "$work/run.log"; echo "FAIL calling-repo: case 66 failed" >&2; exit 1; }
echo "ok   calling-repo: under an inherited GIT_DIR a case leaves the calling repository as it was"
