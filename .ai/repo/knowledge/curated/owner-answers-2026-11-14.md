---
schema: knowledge/v1
id: owner-answers-2026-11-14
kind: knowledge
class: fact
title: "The owner's answers of 2026-11-14: where the Spotify history lives (split public and private), and the data export request"
description: "Before storing anything from the owner's Spotify account in this public repository, deciding what a per-song record may hold, or importing the Spotify data export."
status: verified
epistemics: observed
date: 2026-11-14
tags:
  - decisions
  - spotify
  - privacy
provenance:
  origin: authored
---

# The owner's answers of 2026-11-14

Asked by Claude Code in session `e290e809-a468-45bf-91be-e27d9cc26bab` at about
2026-11-14T17:20Z, after the owner asked to extract "every single piece of my history" from the
logged-in Spotify web player into this repository, song by song, in a machine-readable
frontmatter format, with tooling, UI, documentation and enforcement. Each question and answer is
quoted as given.

## Where the history is stored

- Question: "The sonic-playground repo is PUBLIC (GitHub + Pages), and its yearbook rule currently
  allows public catalogue ids only, never account identifiers. Where should your raw Spotify
  history go? (The play-by-play history with timestamps shows your daily routine; git history in
  a public repo can't be fully taken back.)"
- Options: "Split (Recommended)": public repo: tracks, playlists, liked songs, top lists as
  per-song frontmatter records (no timestamps, no account ids); raw history with timestamps: same
  format but gitignored, in a local folder that is never pushed. "Everything public". "Private
  repo".
- Answer: "Split (Recommended)".
- Consequence: ADR 0007 and rule `project.spotify-history`. Public records under `data/spotify/`
  hold catalogue identity and relationships only (which playlists, yearbooks and top lists a song
  is in, whether it is a liked song, which review it resolves to). Dates of adding, play events
  and account identifiers stay in `data/spotify/private/`, which `.gitignore` excludes and
  `scripts/spotify_history.py --check` refuses to find tracked.

## The data export

- Question: "The Spotify web player only shows your library, playlists, top lists and the last 50
  plays. Your full play history (every play, all years) exists only in Spotify's data export
  (Account > Privacy > Download your data; Spotify emails it within days). Should I click the
  request button in your logged-in Spotify?"
- Answer: "Yes, request it".
- Consequence: on 2026-11-14 at about 17:22Z the request was submitted on
  spotify.com/cz/account/privacy with "Account data" and "Extended streaming history" selected
  (technical logs not selected). Spotify sends one confirmation e-mail per part, which the owner
  must confirm; it states 5 days for the account data and up to 30 days for the extended history.
  When the archive arrives, `python3 scripts/spotify_history.py import-export <folder>` imports it.
