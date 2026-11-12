---
schema: knowledge/v1
id: html-state-flags-never-collide
kind: knowledge
class: lesson
title: "A state flag on <html> must not share its name with a data attribute elements are selected by; flags end in -state"
description: "When browser code records state on document.documentElement.dataset, or adds a [data-…] selector."
status: verified
epistemics: observed
date: 2026-11-12
tags:
  - javascript
  - router
  - i18n
provenance:
  origin: authored
---

# A state flag on <html> must not share its name with an element selector

## What was observed (2026-11-12)

- `explorer.js` marked itself ready with `<html data-explorer="ready">`; after the first router
  navigation `document.querySelector('[data-explorer]')` returned `<html>` instead of the form,
  and the explorer failed to mount on the way back.
- `i18n.js` marked itself ready with `<html data-i18n="ready">`; on the next page swap its
  `querySelectorAll('[data-i18n]')` matched `<html>` and set its `textContent` to the translation
  of "ready" — the whole document vanished (empty title, no `#main-content`), the charts then
  failed inside a detached tree.

## The rule now in force

- State flags on `<html>` are named `…State` (`data-explorer-state`, `data-charts-state`,
  `data-player-state`, `data-reviews-state`, `data-navigating-state`, `data-i18n-state`).
- Selectors that apply content (`i18n.js`) run under `document.body`, never the whole document.
- `test/cases/30_state_attributes.sh` (part of `scripts/verify.sh`) fails when any flag written on
  `documentElement.dataset` is also used as a `[data-…]` selector in templates or code.
