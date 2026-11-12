---
schema: context/v1
id: ai.repo.automation
kind: context
title: Automation inventory
description: Every shell unit of the repository, declared with its disposition and the condition of its removal.
status: active
scope: subtree
providers: ["*"]
audience: [human, agent]
composition: extend
order: 100
---

# Automation inventory

`inventory.jsonl` declares every shell unit (`majordomus shell check`, run in CI): its
disposition (A typed capability, B Rhai scripted capability, F platform adaptor), why it is
still shell and what removes it. Majordomus ADR 0069 is the direction: orchestration becomes a
scripted capability when scripted capabilities ship (I1801); a new shell unit without a record
is refused.
