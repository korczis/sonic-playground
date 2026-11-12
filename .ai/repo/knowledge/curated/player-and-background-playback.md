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
- Playlists are derived from where play is pressed: the visible cards of a `[data-playlist]`
  container in the order shown (explorer filter and sort, a genre page, an archive month), a
  track's radio (the track, its related tracks, theirs), or "Play all".
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
through `data-play*` attributes.
