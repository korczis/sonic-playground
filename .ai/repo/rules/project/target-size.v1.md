---
id: project.target-size
version: 1
kind: rule
title: Every control a finger has to hit is at least 24 by 24 px
description: WCAG 2.2 2.5.8 Target Size (AA) on every page class at phone width; one base CSS rule gives every link, button and field a 24 px minimum height, and a link inside running text keeps its line height, the criterion's own exception.
statement: Keep the base rule in styles/app.css (min-height 1.5rem on a[href], button, [role=button], select and input) instead of sizing controls one by one; give a control that is a flex item its own alignment (inline-flex items-center); keep the target-size check of test/e2e/smoke.cjs green at 390 px.
status: active
class: blocking
depends_on: [project.ui-components@1]
tags: [ui, accessibility, phone]
x-majordomus:
  tests: [test/e2e/smoke.cjs]
---

# Rationale

Measured on production a54ac1b at 390 px (2026-11-12): 257 facet badges were 20 px tall, plus
breadcrumbs, stat-card labels and standalone links, across every page class: 135 controls under
24 px on the home page, 75 on a genre page. A per-component fix decays with the next component;
one base rule cannot.

# Required behaviour

- `styles/app.css` `@layer base`: `min-height: 1.5rem` on every `a[href]`, `button`,
  `[role='button']`, `select` and text `input`. `min-height` does not apply to inline boxes, so a
  link in a sentence or a heading's line keeps its line height (the WCAG exception).
- A control laid out as a flex item centres its own content (`inline-flex items-center`), so the
  extra height does not push its text to the top.

# Failure behaviour

`test/e2e/smoke.cjs` measures every visible, non-inline control of the home, track, insights and
genre-term pages at 390 px and fails on any smaller than 24 px either way, naming the first ones.
A visually hidden control (the skip link, 1x1 px until focused) is not a target.

# Verification

```sh
bash scripts/verify.sh
```
