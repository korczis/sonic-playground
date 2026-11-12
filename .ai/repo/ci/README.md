---
schema: context/v1
id: ai.repo.ci
kind: context
title: CI model
description: The validation gates .github/workflows/ci.yml runs, as the model Majordomus plans and judges a task from.
status: active
scope: subtree
providers: ["*"]
audience: [human, agent]
composition: extend
order: 100
---

# CI model

`gates.yaml` lists the gates `.github/workflows/ci.yml` runs (commits, supervision, site), the
job that runs each and the command that reproduces it locally. The workflow executes them; this
file is how `majordomus check` and `finish` know which gates a change owes and whether each has
reported (`majordomus evidence --gate <id> --exit <status> --command "<runs>"`). The two must name
the same jobs: `test/cases/60_ci_model.sh` refuses a model and a workflow that drift apart.

The skill cases run through `test/run.sh`; with `MJ_TEST_REPORT=<file>` it writes the report
that `majordomus-cli evidence record --suite <file>` records in `.ai/repo/evidence/`, which is how
a skill's test counts as run.
