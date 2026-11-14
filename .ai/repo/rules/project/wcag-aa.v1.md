---
id: project.wcag-aa
version: 1
kind: rule
title: Every kind of page meets WCAG 2.2 A and AA as axe-core measures it, light and dark
description: An independent instrument (axe-core, its WCAG 2.0-2.2 A and AA rules, colour contrast included) reports nothing on one page of every kind the sitemap has, in the light and the dark theme, on the artefact before deploy and on production after it.
statement: Keep the smoke test's wcag check green; fix a reported element in its component, never by excluding a rule, a page kind or a selector; give text its contrast with colour and weight, never with opacity over a coloured background; use a brand colour that meets 4.5:1 under white text (Facebook's #0866FF, not #1877F2).
status: active
class: blocking
depends_on: [project.ui-components@1, project.accessible-names@1, project.target-size@1]
tags: [ui, accessibility, quality]
x-majordomus:
  tests: [test/e2e/smoke.cjs]
---

# Rationale

The site's own checks prove two WCAG criteria: accessible names (4.1.2, check-built) and target
size (2.5.8, the smoke test). Nothing measured the rest. On 2026-11-14 axe-core 4.14.0 run over
one page of each of 41 kinds, light and dark, desktop and phone, found one class of defect, all
of it on the home page (EN and CS): colour contrast (1.4.3) on 328 elements.

- Term chip counts dimmed with `opacity-70` over a tinted chip: 3.3-4.2:1 in both themes.
- The Facebook share button: white on #1877F2, 4.23:1 at 14 px.

The counts are now set apart by weight and tabular figures at full colour, and the button uses
Facebook's current brand blue #0866FF (4.82:1). A hand-made check per criterion would always
lag the criteria, so the instrument is a maintained engine, pinned as a dev dependency.

# Required behaviour

- `test/e2e/smoke.cjs` derives the kinds of page from the sitemap: the language, then home, a
  review, a top-level page, or a taxonomy's index, term or term page. It loads one page of each
  kind in the light and the dark theme and runs axe-core with the tags `wcag2a`, `wcag2aa`,
  `wcag21a`, `wcag21aa` and `wcag22aa`.
- A new page kind is covered by being in the sitemap; nothing lists the kinds by hand.
- A reported element is fixed where it is made (its component). No rule, kind or selector is
  excluded to turn the check green.

# Failure behaviour

The smoke test (`scripts/verify.sh`, CI on the artefact, and the production verification after
deploy) fails with the theme, the page, the rule, the count and the first element with its
measured ratio, for up to twelve findings.

# Verification

```sh
bash scripts/verify.sh
```
