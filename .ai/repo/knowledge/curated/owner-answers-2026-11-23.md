---
schema: knowledge/v1
id: owner-answers-2026-11-23
kind: knowledge
class: fact
title: "The owner's orders of 2026-11-22/23 on the visualiser: follow the real sound, state-of-the-art mapping in every dimension, no microphone, a configurable port"
description: "Before changing how the visualiser hears music, where its sound comes from, how a mode maps music to the picture, or how a local server picks its port."
status: verified
epistemics: observed
date: 2026-11-23
tags:
  - decisions
  - visualiser
  - tooling
provenance:
  origin: authored
---

# The owner's orders of 2026-11-22/23 on the visualiser

Given in Claude Code session `2d41c4c7-6e87-4e09-a97e-213553f83e61`, as messages (the later ones
through `/orchestrate`), not through a question dialog. Quoted as given (Czech, unaccented).

## The pictures must follow the real sound

- Order: "vzdyt ty realne zvukove visualizace ala winamp vubec nereaguji spravne na zvuk; vse si
  dohledej a oprav to" (the real Winamp-style sound visualisations do not react to the sound
  properly at all; look everything up and fix it).
- Found: the analysis read 8-bit levels clipped at -20 dB, so on mastered music it found 1 of 25
  kicks and no tempo; see [[visualizer-music-grammar]] for the measurements and the fix.

## State of the art, every dimension

- Order: "ty visualizace musi byt state of the art visualniho umeni, mapovani zvuku a hudby;
  vsechny dimenze" (the visualisations must be state-of-the-art visual art and mapping of sound
  and music; every dimension).
- What follows: the analysis hears stereo, harmony (chroma, key), timbre, loudness and
  dynamics, beat, bar and the song's sections; every mode maps them through one grammar,
  static/js/viz-map.js ([[visualizer-music-grammar]]).

## No microphone: straight from the browser and the device

- Order: "vse at se ale cte primo z js/browser api pro audio, at neni treba mit zapnuty mikrofon
  (a nerusi to) a cte to rovnou z device" (read everything straight from the browser's audio API,
  so the microphone need not be on, and straight from the device).
- What follows, within the browser's rules: the player is a cross-origin YouTube iframe whose
  audio no page can read silently. The sources are this tab (getDisplayMedia, the default on a
  Chromium computer), the whole computer's sound, and an input device such as a loopback
  (BlackHole, Stereo Mix, a PipeWire monitor), remembered and started again without a prompt once
  allowed; the microphone only when picked.

## A configurable port

- Order (on a probe server whose fixed port another server held): "musi byt configurable via
  env variable, cli option and confign" (it must be configurable by environment variable, CLI
  option and config).
- What follows: scripts/port.mjs resolves `--port`, then `SONIC_PORT`, then package.json
  `config.port`, then 1111, for `npm run dev`, `npm run serve` and `npm run preview`
  (README.md, "Ports").

## Proceeding

- The owner sent the same `/orchestrate` request again after its plan was presented with the
  choices continue / refine / proceed / exit; that was taken as "proceed" (an interpretation,
  recorded as one).
