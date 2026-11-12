#!/usr/bin/env bash
# Every workflow job that runs on a machine has a deadline (timeout-minutes): without one GitHub
# waits six hours, and a stuck job holds the Pages concurrency group, so no later commit deploys
# (2026-11-12: a production smoke test hung for 45 minutes and blocked the deploy queue).
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 - <<'PY'
import re, sys
from pathlib import Path
bad = []
for f in sorted(Path(".github/workflows").glob("*.yml")):
    text = f.read_text(encoding="utf-8")
    if "\njobs:\n" not in text:
        continue
    for job in re.split(r"(?m)^(?=  [A-Za-z0-9_-]+:\s*$)", text.split("\njobs:\n", 1)[1]):
        if "runs-on:" in job and "timeout-minutes:" not in job:
            bad.append(f"{f}: job {job.split(':')[0].strip()} has no timeout-minutes")
for b in bad:
    print(f"workflow-deadlines: {b}", file=sys.stderr)
print(f"workflow-deadlines: {len(bad)} job(s) without a deadline")
sys.exit(1 if bad else 0)
PY
