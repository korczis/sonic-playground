#!/usr/bin/env bash
# A merge that needs no conflict resolution is committed by git without running pre-commit; it
# runs pre-merge-commit instead. .githooks/pre-merge-commit hands it to pre-commit, so a merge
# commit is judged like any commit. Proven in a scratch repository with a pre-commit stub that
# refuses: the merge must be refused through the real pre-merge-commit, and (negative control)
# without that hook the same merge goes through, which is the gap it closes.
set -euo pipefail
# A hook (pre-push in a linked worktree) exports an absolute GIT_DIR; inherited here, the
# scratch repository's git init and commit would act on the calling repository instead
# (2026-11-15: core.bare=true and a moved main). Drop git's whole local environment first.
unset $(git rev-parse --local-env-vars)
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/merge-commit.XXXXXX")
trap 'rm -rf "$work"' EXIT
cd "$work"
git init -q -b main repo && cd repo
g() { git -c user.name=case -c user.email=case@example.invalid "$@"; }
echo base > file && g add file && g commit -q -m base --no-verify
g checkout -q -b side && echo side > other && g add other && g commit -q -m side --no-verify
g checkout -q main && echo main >> file && g commit -q -am main --no-verify
mkdir hooks
printf '#!/usr/bin/env bash\necho judged > "%s/judged"\nexit 1\n' "$work" > hooks/pre-commit
chmod +x hooks/pre-commit
git config core.hooksPath "$work/repo/hooks"
if g merge -q --no-ff side -m merge 2>/dev/null; then
  merged_without_hook=1
  g reset -q --hard HEAD~1
else
  merged_without_hook=0
fi
[ "$merged_without_hook" = 1 ] || { echo "FAIL merge-commit: negative control, git ran pre-commit on a merge" >&2; exit 1; }
cp "$root/.githooks/pre-merge-commit" hooks/pre-merge-commit
if g merge -q --no-ff side -m merge 2>/dev/null; then
  echo "FAIL merge-commit: a conflict-free merge went in although pre-commit refuses" >&2
  exit 1
fi
[ -f "$work/judged" ] || { echo "FAIL merge-commit: the merge was refused without pre-commit judging it" >&2; exit 1; }
echo "ok   merge-commit: a conflict-free merge is judged by pre-commit (and was not before)"
