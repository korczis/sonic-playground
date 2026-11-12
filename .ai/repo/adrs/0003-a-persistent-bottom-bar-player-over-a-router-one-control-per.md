---
schema: adr/v1
id: adr-0003
kind: adr
title: A persistent bottom-bar player over a router, one control per effect, and derived social cards
status: proposed
date: 2026-11-12
tags:
  - player
  - ui
provenance:
  origin: extracted
  derived_from:
    - session:7e1d03a3-52cc-40aa-a61a-4f9713c27f2a
    - file:static/js/player.js
    - file:static/js/router.js
    - file:scripts/og.cjs
---

# 3. A persistent bottom-bar player over a router, one control per effect, and derived social cards

## Context

The site embedded one YouTube iframe per track page: navigating stopped the music, a removed
video showed an error, and nothing played on. The owner asked (session
`7e1d03a3-52cc-40aa-a61a-4f9713c27f2a`, 2026-11-12) for a player "v bottom baru, abych mohl
pustit pisnicku, pak navigovat a ona hrala na pozadi, idealne playlists", that "musi fungovat
lepe nez embeded youtube" and "musi hrat i na pozadi na mobilu". The first version derived its
playlist from where play was pressed, and the owner found it unusable: "je skoro nemozne si
pustit single song", "pridavani do playlist nejak divne kumulativne zapleveluje", "kdyz kliknu
na play, tak mi to castokrat prida mnoho (az desitky songs)", "mela by byt moznost volby jasne
komunikovane, oddelene ovladaci prcky", "it is impossible to hide it". Separately: "kazda jedna
page musi mit og tags, social tags, social preview, image preview, this must be enforced".

## Decision

- **A router keeps one document.** `static/js/router.js` fetches the next page and swaps
  `#main-content` and the sidebar navigation; page modules mount and unmount through
  `static/js/core.js`. The player lives outside `#main-content`, so its YouTube frame
  (youtube-nocookie, IFrame API, a frame built by the site with a known `allow` list) survives
  every navigation.
- **One control, one effect; each track once.** `data-play` plays that one track now and keeps
  the queue after it; `data-play-next` inserts after the current track; `data-queue` toggles the
  track in the queue (`aria-pressed`); only `data-play-radio` and `data-play-all`, labelled as
  replacing the queue, replace it, and a toast says what happened. The controls are written in
  one component, `track_actions` (overlay, row, bar). The bar has previous, next, repeat, a
  small or large video (small by default, always on a phone, never hidden: YouTube's terms
  require it visible), minimise to a pill, close; the queue panel has now playing, up next
  (reorder, remove), played, shuffle and clear.
- **Background playback is handed to an app, not faked.** A locked phone stops any embedded
  video; the queue opens as a YouTube playlist (`watch_videos?video_ids=`) and every track links
  to the apps that play in the background. Extracting the audio would break YouTube's terms.
- **Social cards are derived per page.** `scripts/og.cjs` renders a 1200x630 card for every
  built page from the page's own data (track still, artist, track, facets; or title, lead and a
  mosaic) into `og/<slug>.png`; `templates/base.html` names it in complete Open Graph and X
  tags; `scripts/check-built.py` refuses a page without them or with a missing card.

## Alternatives rejected

- **A playlist derived from the click position** (the first version): one click had several
  effects the reader could not see or undo; rejected by the owner.
- **A single-page application framework**: a build chain and a runtime the static site does not
  need; the router is ~150 lines over server-rendered pages that work without JavaScript.
- **Hiding the video or playing audio only**: forbidden by YouTube's API terms.
- **One generic social card for the site**: every shared link would look the same; the owner
  asked for previews that are "infered / derived / data driven".

## Consequences

- Every interactive element inside `#main-content` is a page module with an unmount; anything
  that must survive navigation lives outside it.
- A change to the queue model updates the player blocks of `test/e2e/smoke.cjs` (desktop and
  phone: every operation, no duplicates, no overlap, no overflow, persistence over a reload).
- The build renders one card per page in a browser (`scripts/og.cjs`), which the gate and CI
  run; a page without a card does not deploy (rule `project.social-preview`).
- Background playback on a locked phone remains the YouTube app's (Premium) or another app's.
