---
schema: knowledge/v1
id: owner-answers-2026-11-22
kind: knowledge
class: fact
title: "The owner's answers of 2026-11-22: thin-source songs are written out, translation stays on the strong model, ADRs 0006 and 0007 accepted"
description: "Before deferring a backlog song for thin sources, moving the Czech translation to a cheaper model, or questioning ADR 0006 or 0007."
status: verified
epistemics: observed
date: 2026-11-22
tags:
  - decisions
  - backlog
  - translation
provenance:
  origin: authored
---

# The owner's answers of 2026-11-22

Given in Claude Code session `5583d296-7e91-453d-a28e-a3d1f3410121` on 2026-11-22, as a message
after a strategy consultation with other models and sessions, not through a question dialog. The
answers are quoted as given.

## Songs with thin sources

- The open question: after independent advisors recommended capping the 910-song "liked" tail,
  should songs whose sources are thin be deferred permanently, or shown only as rows in a listing
  instead of pages?
- Answer: "tenke pisne rozepis" (write the thin songs out).
- What follows: thin-source songs get full pages, as decided on 2026-11-15
  ([[owner-answers-2026-11-15]]): each page states what no source describes and claims nothing
  more. A researchability screen may order the backlog (well-sourced songs first) but does not
  remove songs from it; "deferred: thin sources" decisions are withdrawn.

## A cheaper model for the Czech translation

- The open question: should the English-to-Czech translation move to a cheaper model behind
  structural and grammatical checks?
- Answer: "nechci pouzit levnejsi model" (I do not want to use a cheaper model).
- What follows: writers keep translating with the same model that writes the English.

## ADRs 0006 and 0007 are accepted

- Given in a different session, `7e1d03a3-52cc-40aa-a61a-4f9713c27f2a`, on 2026-11-22 at about
  06:25Z, as a chat message and not through a question dialog.
- The open question: the session's closing reports said that ADR 0006 (the site is bilingual) and
  ADR 0007 (the owner's Spotify history is one record per song) were still `proposed`, and that
  only the owner could accept them.
- Answer, quoted as typed: "schvaluji to yde" ("I approve it here"; "yde" is a typo of "zde").
- What follows: both ADRs have `status: accepted` and `provenance.origin: authored`, as ADRs
  0001-0005 got on 2026-11-12 ([[owner-answers-2026-11-12]]).
