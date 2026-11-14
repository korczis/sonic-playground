---
id: project.accessible-names
version: 1
kind: rule
title: Every link and button a page exposes has an accessible name
description: WCAG 4.1.2 on every built page; a redundant link beside the one that carries the name is hidden from assistive technology and the tab order together, and a control the browser fills later sits in a hidden subtree until then.
statement: Give every link and button its name (text, aria-label, aria-labelledby, title or an image's alt); hide a redundant link with aria-hidden="true" and tabindex="-1" together; keep an empty control the browser fills inside a hidden subtree until it is filled; keep scripts/check-built.py green.
status: active
class: blocking
depends_on: [project.ui-components@1]
tags: [ui, accessibility]
x-majordomus:
  tests: [scripts/check-built.py]
---

# Rationale

The measurement of 2026-11-14 counted 81 card image links without a name on six pages. The source
showed they were already hidden as redundant links (`aria-hidden="true" tabindex="-1"` beside the
title link), so nothing was broken. The rule was still kept only by habit, and a component that
drops either attribute would make every card a nameless tab stop. Removing them from the track
card is a mutation the check reports on 2543 pages.

# Required behaviour

- A link or button carries its name in its text, `aria-label`, `aria-labelledby`, `title` or an
  image's `alt`.
- A redundant link (a card's still, beside the title link to the same page) carries
  `aria-hidden="true"` and `tabindex="-1"` together: hidden alone would leave a nameless tab stop.
- A control the browser fills when it appears (the player's title, the explorer's "more") stays
  inside a `hidden` subtree until then.

# Failure behaviour

`scripts/check-built.py` (CI, after `zola build`) refuses any `<a href>` or `<button>` of a built
page that has no name and is neither hidden as a redundant link nor inside a hidden subtree,
naming up to five per page.

# Verification

```sh
bash scripts/verify.sh
```
