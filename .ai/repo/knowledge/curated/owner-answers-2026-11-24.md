---
schema: knowledge/v1
id: owner-answers-2026-11-24
kind: knowledge
class: fact
title: "The owner's orders of 2026-11-24: three analysis passes, the latest algoglyph features where they make sense, knowledge in both directions"
description: "Before an analysis or improvement round on the visualiser, before writing a signal-processing or simulation algorithm the owner's algoglyph collection already has, or when a lesson learnt here could serve algoglyph."
status: verified
epistemics: observed
date: 2026-11-24
tags:
  - decisions
  - visualiser
  - algoglyph
provenance:
  origin: authored
---

# The owner's orders of 2026-11-24

Given in Claude Code session `2d41c4c7-6e87-4e09-a97e-213553f83e61` through `/orchestrate`, not
through a question dialog. Quoted as given (Czech, unaccented).

## Three analysis passes

- Order: "prvne napis prompt na analyzu; pak ten prompt spust; pak reaguj na vysledky; ano udelej
  to na tri pruchody" (first write an analysis prompt, then run it, then react to its results; do
  it in three passes).
- What follows: each pass's brief is written out, run by an analyst, and answered with measured
  fixes; the next brief is written from the last pass's results. Pass 1 measured the analysis on
  freely licensed recordings and replaced the tempo ([[visualizer-music-grammar]]).

## The latest algoglyph features, where they make sense

- Order: "nezapomen pouzit vzdy latest algoglyph features tam kde to dava smysl" (do not forget
  to always use the latest algoglyph features where it makes sense).
- What follows: algoglyph (~/dev/algoglyph, https://korczis.github.io/algoglyph/) is the owner's
  collection of algorithms drawn as seeded, measured simulations, with typed kernels under
  `src/kernels/` (signal: stft-spectrogram, window-leakage, yin-pitch, xcorr-alignment,
  hilbert-analytic, biquad-filters, kuramoto; stochastic: page-hinkley; numeric: hurst-dfa,
  recurrence-plot). Before writing such an algorithm here, look there first; reuse its method
  (this site has no bundler, so a kernel is ported, credited with its plate's link) rather than
  inventing another.

## Knowledge in both directions

- Order: "bidirectional knowledge".
- What follows: what algoglyph teaches is credited here (code comments name the plate); what is
  measured here (tempo by novelty autocorrelation on real recordings, frame/audio-block aliasing,
  a room's noise periodicity, key profiles) is offered back to algoglyph as knowledge in its own
  `.ai` layer and as proposed plates, through its own workflow and branches.

## 2026-11-25: push algoglyph, then three more passes

- The open question: should the algoglyph branch `chore/knowledge-music-analysis`, which offers
  sonic-playground's measured lessons back as a curated note, be pushed?
- Answer (through `/orchestrate`): "ano pushni, mergni a pak ... prvne napis prompt na analyzu,
  pak ten prompt spust, pak reaguj na vysledky; ano udelej to na tri pruchody" (yes, push it,
  merge it, and then: write an analysis prompt, run it, react to the results; three passes).
- What follows: the note goes through algoglyph's own gate and a pull request, and a second round
  of three analysis passes runs on the deployed visualiser.

## 2026-11-25: verifies stopped for memory, restart them one at a time

- The question (AskUserQuestion, session 2d41c4c7-6e87-4e09-a97e-213553f83e61, 2026-11-25 about
  09:15 CET): "Claude Code stopped two background jobs because the Mac ran critically low on
  memory: the full verify of waves 33-35 (71 songs, needed before merging) and the algoglyph fast
  gate. Both are committed work waiting only on these gates, and visualizer-r2 (3075ac28) needs
  its own full verify after them. How should I proceed?"
- Answer: "Restart, one at a time (Recommended)". The option described re-running the waves'
  verify with 2 smoke workers instead of 4, then r2's verify, then the algoglyph gate.
- What follows: the full local verify stays the gate before a merge. Under memory pressure, the
  heavy gates run one after another with fewer smoke workers, rather than being skipped for CI.
