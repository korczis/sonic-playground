---
schema: adr/v1
id: adr-0005
kind: adr
title: Yearbooks are resolved relationships from the owner's Spotify playlists, pages derived
status: proposed
date: 2026-11-12
tags:
  - yearbook
  - spotify
provenance:
  origin: extracted
  derived_from:
    - session:7e1d03a3-52cc-40aa-a61a-4f9713c27f2a
    - file:scripts/spotify.py
    - file:data/backlog.schema.json
---

# 5. Yearbooks are resolved relationships from the owner's Spotify playlists, pages derived

## Context

The owner asked for every song of every annual Spotify "Top Songs" playlist to have exactly one
page, with the yearbooks as first-class derived collections (2026-11-12, the "yearbook corpus
expansion" brief). A song may recur in several years and under several recordings. Spotify no
longer lets new API clients read Spotify-owned playlists, which the annual ones are; the import
must work from a copy in the owner's own playlists or from the account data export, and the
public site must never talk to Spotify.

## Decision

- **A yearbook is a playlist file.** `data/backlog/yearbook-<year>.toml` (`kind = "yearbook"`,
  `year`, items in order with title, artists, album, duration, Spotify track id and ISRC) per
  `data/backlog.schema.json`; it holds relationships, never review metadata, and no account
  identifier.
- **One identity resolution.** `scripts/catalog.py resolve_item`, shared with
  `scripts/backlog.py`: an explicit `review=`, a `skip=` reason, an unreadable item, a unique ISRC
  (filled into reviews by `track.py enrich`), then a unique artist-and-song match (featured
  artists and version suffixes folded, remixes kept); several candidates are `ambiguous`.
- **Derived pages.** The catalogue derives each yearbook (order, counts, artists, genres), each
  review's memberships and the recurring songs; the pages under `content/yearbook/` are
  generated stubs rendered by one template, checked for staleness.
- **A development-time importer.** `scripts/spotify.py` (OAuth PKCE, token outside the
  repository; paged, rate-limit aware, idempotent, keeping the owner's overrides) and the data
  export reader; tests run on fixtures, never on the account.

## Alternatives rejected

- **Yearbook data in the articles**: a song in five years would carry five copies.
- **Reading Spotify from the browser**: secrets in a public site, and the API refuses anyway.
- **Matching by normalised title alone**: remixes and covers would merge.

## Consequences

- Rule `project.yearbook-integrity` binds it. A missing song is created through add-song; an
  ambiguous item gets `review=` or `skip=` from the owner, never a guess.
- The yearbook pages and the menu entry exist only once a yearbook does.
