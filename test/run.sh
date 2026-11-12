#!/usr/bin/env bash
# The skill and policy cases (test/cases/*.sh), each in its own shell and under a bound.
#
#   bash test/run.sh                    every case
#   bash test/run.sh 10_add_song ...    the named cases (a name that matches nothing is an error)
#   MJ_TEST_REPORT=<file> bash test/run.sh
#                                       also write one TSV row per case (name, PASS|FAIL|TIMEOUT,
#                                       seconds, phase), the report `majordomus-cli evidence
#                                       record --suite <file>` turns into the evidence ledger
#
# scripts/verify.sh runs it; a case that fails fails the gate.
set -euo pipefail
cd "$(dirname "$0")/.."

BOUND="${MJ_CASE_TIMEOUT:-600}"
report="${MJ_TEST_REPORT:-}"
[ -n "$report" ] && : > "$report"

cases=()
if [ "$#" -eq 0 ]; then
  cases=(test/cases/*.sh)
else
  for name in "$@"; do
    file="test/cases/${name%.sh}.sh"
    [ -f "$file" ] || { echo "run.sh: no case '$name' in test/cases/" >&2; exit 2; }
    cases+=("$file")
  done
fi

failed=0
for file in "${cases[@]}"; do
  name="$(basename "$file" .sh)"
  start=$SECONDS
  bash "$file" < /dev/null &
  pid=$!
  # The watchdog kills its own sleep when it is stopped, so no child outlives the case and
  # holds a pipe open.
  ( trap 'kill "$s" 2>/dev/null; exit 0' TERM; sleep "$BOUND" & s=$!; wait "$s"
    kill -TERM "$pid" 2>/dev/null ) > /dev/null 2>&1 &
  watchdog=$!
  if wait "$pid"; then word=PASS; else code=$?; word=FAIL; [ "$code" -eq 143 ] && word=TIMEOUT; fi
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  sec=$((SECONDS - start))
  [ -n "$report" ] && printf '%s\t%s\t%s\t%s\n' "$name" "$word" "$sec" serial >> "$report"
  if [ "$word" != PASS ]; then
    echo "run.sh: $name $word after ${sec}s" >&2
    failed=$((failed + 1))
  fi
done

[ "$failed" -eq 0 ] || { echo "run.sh: $failed of ${#cases[@]} case(s) failed" >&2; exit 1; }
echo "run.sh: ${#cases[@]} case(s) passed"
