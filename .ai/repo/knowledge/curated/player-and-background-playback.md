---
schema: knowledge/v1
id: player-and-background-playback
kind: knowledge
class: fact
title: "The bottom-bar player keeps playing across pages; a locked phone stops any embedded YouTube video, so the queue opens in the YouTube app"
description: "When changing the player, the router, playlists or anything about playback on phones."
status: verified
epistemics: observed
date: 2026-11-12
tags:
  - player
  - youtube
  - mobile
provenance:
  origin: authored
---

# The bottom-bar player and background playback

## How it works

- `static/js/router.js` navigates without reloading: it fetches the next page, swaps
  `#main-content` and the sidebar's navigation, and remounts the page modules (`core.js`). The
  player (`templates/partials/player.html`, `static/js/player.js`) lives outside `#main-content`,
  so the YouTube frame is never destroyed: music keeps playing while the reader browses. The
  smoke test proves the frame is the same object after navigating and that back remounts the
  explorer.
- One control, one effect (owner finding 2026-11-12: "play" used to queue a whole page or a
  track's radio, 5 to dozens of tracks, and "+ Queue" appended duplicates). The queue holds each
  track once (by catalogue source). `data-play` plays that one track now and keeps what is queued
  after it; `data-play-next` inserts after the current track; `data-queue` is a toggle
  (`aria-pressed`) that adds to the end or takes the track out; only `data-play-radio` and
  `data-play-all`, labelled as replacing the queue, replace it, and a toast says so. The
  component `track_actions` (variants overlay, row, bar) is the only place these controls are
  written.
- The bar: previous (restarts past 3 s), next, repeat (off, all, one), the queue panel (now
  playing, up next with reorder and remove, played; shuffle, clear, Escape closes it), the video
  small (default, and always on a phone) or large, minimise to a corner pill, close. State flags
  on `<html>`: `data-player-state`, `-view-state`, `-video-state`, `-queue-state`
  (knowledge html-state-flags-never-collide).
- Better than a bare embed: removed or non-embeddable videos are skipped (`onError` → next),
  never requested at all when `data/videos.json` knows they are gone; the queue, position and
  time survive a reload (localStorage; nothing third-party loads until play is pressed again);
  lock-screen and hardware media keys work through the Media Session API while the page is
  active; the video stays visible while it plays (YouTube's API terms require a visible player).

## What a browser cannot do, and the legitimate answer

An embedded YouTube player stops when a phone locks or the browser goes to the background.
Background playback is a YouTube Premium feature of the YouTube app; extracting the audio stream
to keep playing would break YouTube's terms. So the site does not try. Instead:

- the queue panel's "Open in the YouTube app" opens the queue from the current track as an ad-hoc
  YouTube playlist (`watch_videos?video_ids=…`, at most 50), which the YouTube app plays in the
  background for Premium members;
- every track page has a "Listen" card with search links (derived from artist and track) to
  YouTube Music, Spotify, Apple Music and Discogs, whose apps play in the background.

## How to apply

Keep anything that must survive navigation outside `#main-content`; anything inside it is a page
module with an unmount. Never add an inline `<iframe>` (rule `project.console-clean`); play
through `track_actions` / `play_all`, never a hand-written `data-play*` button that does two
things. A change to the queue model updates the player block of `test/e2e/smoke.cjs` (desktop and
phone), which asserts every operation and that nothing is ever duplicated.
