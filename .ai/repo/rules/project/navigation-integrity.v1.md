---
id: project.navigation-integrity
version: 1
kind: rule
title: Every page is reachable, a client-side navigation leaves the page a reload would, and a failed fetch is retried
description: No built page lacks a link from another page; after the router swaps a page, every link and form of the persistent shell points where a reload of that page points it; a failed catalogue or play index fetch is forgotten, so the next action asks again.
statement: Give every listing its pager (the pager component) and every page a link from another; mark a shell destination that depends on the page (its language) with data-follows-page so the router copies it; never cache a rejected fetch; keep scripts/check-built.py and the smoke test green.
status: active
class: blocking
depends_on: [project.ui-components@1, project.ui-localised@1, project.site-static-serverless@1]
tags: [navigation, router, resilience, quality]
x-majordomus:
  tests: [scripts/check-built.py, test/e2e/smoke.cjs]
---

# Rationale

An independent review (Codex, read-only, 2026-11-14) found three defects that every existing gate
let through. Each was confirmed against the source and the build before it was fixed:

- The concept pages paginate at 24 tracks but rendered no pager. 26 pages (EN and CS, from
  `page/2/` on) were linked from nowhere; "hook" has 70 tracks and showed 24.
- `Sonic.catalog()` and `Sonic.playIndex()` kept a rejected fetch for the life of the page.
  `playIndex()` also preferred a failed catalogue over the play index. One 503, which GitHub
  Pages does answer, left Play, Queue and Random dead until a reload.
- After a language switch the router replaced the content and the sidebar, but not the navbar's
  logo, search form and feed link, nor the head's feed link. They kept pointing at the previous
  language.

The gates written for these classes of defect, not for the three instances, are
reachability, a shell compared with a reload, and a fetch that fails once and then recovers.

# Required behaviour

- A paginated listing renders the `pager` component; every built page (other than the site root)
  is the target of an `<a href>` on another page.
- An element of the persistent shell whose `href` or `action` depends on the page carries
  `data-follows-page="<name>"`; `static/js/router.js` copies those attributes from the incoming page.
- A data fetch (the catalogue, the play index) forgets a rejection; the play index falls back from
  a failed catalogue to `play.json`.
- A script load (`Sonic.script`: the YouTube API, ECharts) forgets a rejection with its element, so
  the next Play or chart asks again. A fourth review (2026-11-14) found the same cached rejection
  there; the smoke test fails the first YouTube API request and expects the next Play to play.
- Back and Forward return the reader to where they were. The router keeps each entry's scroll
  position and restores it after the page mounts, and the explorer keeps its open results
  (`explorerLimit`) in the entry. The smoke test opens 72 results, scrolls, opens a review and goes
  Back (the old code reset to 24 at the top).
- The position is saved while the reader scrolls (debounced), not only when a link is followed:
  Back and Forward leave a page through native history with no moment to save it. A fifth review
  found Forward returning to the top; the smoke test reads a review to 900 px, then goes Back and
  Forward (the old code returned 0).

# Failure behaviour

- `scripts/check-built.py` names every page no other page links to.
- The smoke test fails if, after the language switch, the shell's links and forms differ from those
  of a reload of the same page; they are compared as multisets, so a duplicate URL cannot hide a
  stale one.
- The smoke test fails if, after a 503 on the first `play.json`, the next Play does not play.

# Verification

```sh
bash scripts/verify.sh
```
