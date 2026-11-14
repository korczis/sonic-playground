---
id: project.router-navigation
version: 1
kind: rule
title: Every in-site navigation of the browser code goes through the router, into the page's language
description: A click that opens another page of the site (a link, a chart, a menu) goes through window.SonicRouter so the persistent player keeps playing, and to the page in the current language; a full page load is a fallback or a stated exception.
statement: Navigate with window.SonicRouter.go (falling back to location only when the router is absent, on the same line); build a site path with Sonic.localPath, trackPath or termPath; mark any other full load with a `// full load:` comment that says why; keep test/test_navigation.py and the smoke test green.
status: active
class: blocking
depends_on: [project.navigation-integrity@1, project.ui-localised@1]
tags: [router, player, i18n, quality]
x-majordomus:
  tests: [test/test_navigation.py, test/e2e/smoke.cjs]
---

# Rationale

A third independent review (Codex, 2026-11-14) found that a chart click assigned `location.href`.
That full page load stopped the music. The monthly chart also opened the English archive from a
Czech page. Confirmed in a real browser: `/cs/insights/` to `/archive/#m-2026-11`, reloaded.

# Required behaviour

- `static/js/charts.js` navigates through `window.SonicRouter.go`, and the monthly chart's
  archive path is `Sonic.localPath('archive/')`.
- In `static/js/`, a line that assigns `location` (`href =`, `assign`, `replace`) outside
  `router.js` names `window.SonicRouter` (the guarded fallback) or carries `// full load: <why>`
  (the entry redirect, a page without the router).

# Failure behaviour

- `test/test_navigation.py` (unit tests, CI) names every other location assignment.
- The smoke test clicks a bar of the monthly chart on `/cs/insights/` during playback. It fails
  unless the Czech archive opens at that month without a reload, with the player's frame still
  there.

# Verification

```sh
bash scripts/verify.sh
```
