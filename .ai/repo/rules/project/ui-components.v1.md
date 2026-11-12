---
id: project.ui-components
version: 1
kind: rule
title: UI markup lives once, in Tera 2 components on the Flowbite Pro shell
description: Every repeated UI unit (track card, track row, facet badges, video, stat card, page header, ranked terms, empty state, icon) is a component in templates/components.html with explicit props; pages compose components and never copy their markup.
statement: Build every repeated UI unit as a component in templates/components.html adapted from the Flowbite Pro template it starts from, call it with explicit props from page templates, and never duplicate its markup in another template.
status: active
class: blocking
depends_on: [fleet.ui-uses-flowbite-pro@1]
tags: [ui, components, flowbite]
x-majordomus:
  tests: [test/e2e/smoke.cjs]
---

# Rationale

Zola 0.23 (Tera 2) components are isolated: they see only their props and global functions, so a
component cannot silently depend on page context, and one change reaches every page. The theme
this replaced repeated card and badge markup across templates.

# Required behaviour

- `templates/components.html` holds the components; `templates/partials/` holds the shell parts
  (navbar, sidebar, footer) that read site context; page templates (`index`, `page`, `pages`,
  `archive`, `insights`, `taxonomy_*`, `404`) only compose them.
- Each component is adapted from a Flowbite Pro block (product card, list group, stat card, page
  header, empty state, badge) and keeps Pro spacing, radius, colours and dark-mode classes.
- Data attributes the explorer reads (`data-track`, `data-genre`, ...) are emitted only by
  `track_card`.

# Failure behaviour

Duplicated markup or a non-Pro component is a review finding and is reworked before merge.

# Verification

`node ~/.claude/skills/flowbite-pro/verify.mjs .` exits 0 on the owner's machine; the browser
smoke test exercises every page class.
