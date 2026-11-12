#!/usr/bin/env bash
# The CI model (.ai/repo/ci/gates.yaml) and the workflow that executes it (.github/workflows/ci.yml)
# name the same jobs, and each gate's command is one the workflow runs. Majordomus judges a task
# from the model; a gate the workflow never runs, or a job the model does not know, would make
# that judgement about a pipeline that does not exist.
set -euo pipefail
cd "$(dirname "$0")/../.."

python3 - <<'EOF'
import re, sys
from pathlib import Path

model = Path(".ai/repo/ci/gates.yaml").read_text()
workflow = Path(".github/workflows/ci.yml").read_text()

gate_jobs = re.findall(r"^    job: (\S+)$", model, re.M)
gate_runs = re.findall(r"^    runs: (.+)$", model, re.M)
jobs_block = workflow.split("\njobs:\n", 1)[1]
workflow_jobs = re.findall(r"^  ([a-z][\w-]*):$", jobs_block, re.M)

problems = []
if sorted(gate_jobs) != sorted(workflow_jobs):
    problems.append(f"model jobs {sorted(gate_jobs)} != ci.yml jobs {sorted(workflow_jobs)}")
for runs in gate_runs:
    for command in (c.strip() for c in runs.split("&&")):
        head = " ".join(command.split()[:3]) if command.startswith("majordomus") else command.split()[0]
        if command.startswith("bash "):
            head = command
        if head not in workflow:
            problems.append(f"gate command '{command}' is not run by ci.yml (looked for '{head}')")
for p in problems:
    print(f"FAIL ci-model: {p}", file=sys.stderr)
if problems:
    sys.exit(1)
print(f"ok   ci-model: {len(gate_jobs)} gates, the jobs of ci.yml, every command run there")
EOF

# negative: a gate whose job ci.yml does not have is refused
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/.ai/repo/ci" "$tmp/.github/workflows" "$tmp/test/cases"
cp .github/workflows/ci.yml "$tmp/.github/workflows/"
sed 's/^    job: site$/    job: nowhere/' .ai/repo/ci/gates.yaml > "$tmp/.ai/repo/ci/gates.yaml"
sed -n '/^python3 - <<.EOF.$/,/^EOF$/p' "$0" > "$tmp/check.sh"
if (cd "$tmp" && bash check.sh 2>/dev/null); then
  echo "FAIL ci-model: a gate naming a job ci.yml lacks was accepted" >&2; exit 1
fi
echo "ok   ci-model: a gate naming a job ci.yml lacks is refused"
