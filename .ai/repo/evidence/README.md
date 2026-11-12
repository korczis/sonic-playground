---
schema: context/v1
id: ai.repo.evidence
kind: context
title: Evidence ledger
description: What ran, against which commit, written by majordomus-cli evidence record and never by hand.
status: active
scope: subtree
providers: ["*"]
audience: [human, agent]
composition: extend
order: 100
---

# Evidence ledger

`ledger.json` is the latest execution of every test case: commit, tree state, digest of the
case's source, time, origin and the command that runs it again. It is written only by the
recorder, from the report the case runner writes:

```sh
MJ_TEST_REPORT=/tmp/cases.tsv bash test/run.sh
majordomus-cli evidence stamp --producer suite --report /tmp/cases.tsv --out /tmp/stamp.json
majordomus-cli evidence record --suite /tmp/cases.tsv --provenance suite=/tmp/stamp.json
```

`majordomus skills status` joins it to the cases that name each skill: a skill is tested when
its case's latest run passed and the case has not changed since. Never edit the ledger by hand;
re-run and record instead.
