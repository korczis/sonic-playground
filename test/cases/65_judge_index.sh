#!/usr/bin/env bash
# The pre-commit gate judges the tree the commit records (.githooks/pre-commit --judge-index),
# not the working tree. Two cases a working-tree check gets wrong, both met on 2026-11-14
# while 41 reviews were written beside the commits that had to land first:
# - unrelated work left unstaged or untracked must not refuse a commit whose own tree is sound;
# - a catalogue that lists a review the commit lacks must be refused, although the review exists
#   (untracked) in the working tree, where `git diff --quiet` never looks.
set -euo pipefail
# A hook (pre-push in a linked worktree) exports an absolute GIT_DIR; inherited here, the
# scratch repository's git init and commit would act on the calling repository instead
# (2026-11-15: core.bare=true and a moved main). Drop git's whole local environment first.
unset $(git rev-parse --local-env-vars)
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/judge-index.XXXXXX")
trap 'rm -rf "$work"' EXIT
git -C "$root" archive HEAD | tar -x -C "$work"
cp "$root/.githooks/pre-commit" "$work/.githooks/pre-commit"
cd "$work"
git init -q
git add -A
git -c core.hooksPath=/dev/null -c user.name=case -c user.email=case@example.invalid \
  commit -q -m base
judge() { bash .githooks/pre-commit --judge-index >"$work/.judge.log" 2>&1; }
fail() { cat "$work/.judge.log"; echo "FAIL judge-index: $1" >&2; exit 1; }

judge || fail "refuses a sound tree"

printf '+++\ntitle = "Fixture Draft - Unfinished"\n+++\nTODO(write)\n' > content/zz-fixture-draft.md
printf '\n# an unstaged edit nothing derives from yet\n' >> data/media.toml
judge || fail "unrelated untracked or unstaged work refused a sound commit"
git checkout -q -- data/media.toml
rm content/zz-fixture-draft.md

review=$(git ls-files 'content/*.md' \
  | grep -v -e '\.cs\.md$' -e '_index' -e '^content/pages/' -e '^content/yearbook/' | head -1)
git rm -q --cached "$review"
if judge; then
  echo "FAIL judge-index: a catalogue listing $review passed although the commit lacks it" >&2
  exit 1
fi
grep -q "$(basename "$review")\|stale" "$work/.judge.log" || fail "refused without naming the cause"
echo "ok   judge-index: a sound commit passes beside unrelated work;" \
  "a catalogue listing a review the commit lacks is refused"
