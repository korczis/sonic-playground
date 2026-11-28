---
schema: knowledge/v1
id: owner-answers-2026-11-28
kind: knowledge
class: fact
title: "The owner's orders of 2026-11-28: a song in full quality with its remixes, not done until verified live in a browser, versions as data-driven tooling"
description: "Before adding a song (or its remixes and other versions), before calling a song or a deploy done, or when changing how versions are found, stored, shown or checked."
status: verified
epistemics: observed
date: 2026-11-28
tags:
  - decisions
  - content
  - versions
  - deploy
provenance:
  origin: authored
---

# The owner's orders of 2026-11-28

Given in Claude Code session `cfef4139-22f2-4467-b830-50f71bcc95c9` on 2026-11-28, as messages,
not through a question dialog. Quoted as given (Czech, unaccented).

## MAINVIBE - Lauter, with its remixes, in full quality

- Order: "pridej song lauter + mainvibe vcetne odkazu na remixy, nastuduj si jakou kvalitu maji
  ostatni clanky, vse diskutuj s ostatnimi ais/llms/ pridej clanek, deploy, asap, ve full kvalite
  ci ne lepsi - znamena vsechny nahledy, embedingy, meta, nahledy, cleneni, ..." (add the song
  Lauter by MAINVIBE including links to its remixes; study the quality the other articles have;
  discuss everything with the other AIs/LLMs; add the article, deploy, as soon as possible, in
  full quality or better: that means every preview, embed, meta, still, the structure, ...).
- What follows: `content/mainvibe-lauter.md` and its translation are written to the corpus's
  standard (every still, embed, social meta and section of an existing review), the structure is
  discussed with other models (Codex) and peer sessions before it is settled, and the remixes are
  part of the page. The add-song skill's step "Consult" keeps the discussion for every song.

## Not done until verified in a browser on the delivery

- Order: "dokud neni overen v browseru via playwright delivery, tak neni hotovo" (until it is
  verified in a browser via Playwright on the delivery, it is not done).
- What follows: a song is done only when `test/e2e/live.cjs` (`npm run live -- <slug> --expect
  <sha>`) passes against production in a real browser, in English and Czech, on a desktop and a
  phone (add-song step "Done = live"; the `deploy-verifier` agent runs it for each changed
  review). A green gate and a served revision are delivered, not done.

## Versions as data, tooling and process

- Order: "pro pridavani songu s timto ci rozsirenejsim, data driven, in repo persisted, .ai/
  integrated, skill mode, prompt, tooling, ui, ux, dx" (for adding songs with this or more:
  data-driven, persisted in the repository, integrated into .ai/, as a skill, a prompt, tooling,
  UI, UX and DX).
- What follows: a song's versions are front matter (`[[extra.versions]]`, `data/track.schema.json`),
  never a link list in the prose; `scripts/track.py versions` finds, writes and verifies them;
  the catalogue derives their groups and the player's queue; the page renders and plays them;
  the add-song skill gains the steps "Versions", "Fact-check before the commit" (prompt
  `.ai/repo/prompts/fact-check.md`, agent `fact-checker`) and "Done = live".
