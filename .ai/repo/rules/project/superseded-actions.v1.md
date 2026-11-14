---
id: project.superseded-actions
version: 1
kind: rule
title: An asynchronous action that the reader has superseded never lands
description: The router commits only the latest navigation and aborts older requests; the player drops a load whose YouTube API arrives after Close or after a newer load, so a dismissed player never starts on its own.
statement: Give every asynchronous action that ends in a visible change a token taken when it starts and checked when it lands; take a new token when the reader supersedes it (a newer click, Close); abort what can be aborted; keep the smoke test green.
status: active
class: blocking
depends_on: [project.navigation-integrity@1]
tags: [router, player, resilience, quality]
x-majordomus:
  tests: [test/e2e/smoke.cjs]
---

# Rationale

A second independent review (Codex, 2026-11-14) reproduced two races in a VM, and both reproduced
in a real browser:

- **Router.** Archive was clicked first and answered slowly, a genre page second and fast. The
  older response was committed over the newer page, and the URL ended on the archive. An obsolete
  failure would also have forced a full load of the stale URL.
- **Player.** Play, then Close before the YouTube API arrived. The API's arrival built the frame
  and played the closed track, with the bar hidden: 1 play call, 1 frame.

# Required behaviour

- `static/js/explorer.js` ignores its review index when it arrives after the explorer unmounted.
  A late answer used to write the left page's `?q=` into the next page's URL (a third review,
  2026-11-14); the smoke test delays the index across a navigation.
- `static/js/player.js` ties every command that waits for the play index (Play, Queue, Radio, Play
  all) to the close epoch it began in, and Close starts a new epoch. A fifth review found a Play
  clicked just before Close reopening the player when the index arrived. The smoke test delays
  `play.json` across a Close (old: 1 queued, 1 YouTube API request).
- `static/js/router.js` numbers each navigation, aborts the previous request, and drops a response
  or a failure that is not the latest.
- `static/js/player.js` takes a token in `load()` and checks it when the API arrives and when it
  fails. `stop()` takes a new token and clears the pending video; `onReady` plays only while a
  track is current.

# Failure behaviour

The smoke test fails when a slow, earlier navigation lands over the latest one. It also fails
when, after Close before the API arrives, the player plays or builds its frame.

# Verification

```sh
bash scripts/verify.sh
```
