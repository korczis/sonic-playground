---
schema: adr/v1
id: adr-0007
kind: adr
title: The owner's Spotify history is one record per song, public identity and relationships, private time
status: accepted
date: 2026-11-14
tags:
  - spotify
  - privacy
  - data
provenance:
  origin: authored
  derived_from:
    - session:e290e809-a468-45bf-91be-e27d9cc26bab
    - file:scripts/spotify_history.py
    - file:.ai/repo/knowledge/curated/owner-answers-2026-11-14.md
    - file:.ai/repo/knowledge/curated/spotify-history-format.md
---

# 7. The owner's Spotify history is one record per song, public identity and relationships, private time

## Context

On 2026-11-14 the owner asked for "every single piece" of their Spotify history to be stored in
this repository, song by song, in a format that people, LLMs and Majordomus can all read. They
also asked for tooling, documentation and enforcement. The repository is public and deployed.
A play-by-play history with timestamps shows the owner's daily routine, and git history cannot
be fully taken back. Spotify exposes the library through two channels:
- the owner's logged-in web player shows the liked songs, playlists (including the Spotify-owned
  "Your Top Songs" playlists the API refuses, ADR 0005), saved albums and followed artists;
- the account data export holds every play.

## Decision

- **Split (the owner's answer, knowledge `owner-answers-2026-11-14`).** Public and committed
  under `data/spotify/`:
  - `tracks/<id>.md`, one per recording;
  - `playlists/<id>.md`, one per playlist;
  - `library.md`;
  - `index.json` (per review: liked, the yearbook years, the number of playlists).

  They hold catalogue identity (title, artists, album, duration, Spotify track/album/artist ids)
  and relationships (liked, playlist and yearbook positions, the resolved review). Private and
  never committed: `data/spotify/private/` (ignored), holding the raw sources and the same
  records with the dates of adding, the plays and the owner's display name and ids.
- **One format.** Markdown with a YAML front matter whose values are JSON literals (JSON is YAML
  1.2), one key per line or a block list of JSON items. Any YAML or JSON reader takes it, and the
  standard library parses it. Schemas: `data/spotify-{track,playlist,library}.schema.json`.
- **Derived, never hand-edited.** `scripts/spotify_history.py build --write` derives every
  record from the private store (web-player snapshots, the export), deletes leftovers, resolves
  each song to its review through `scripts/catalog.py resolve_item`, and writes the annual Top
  Songs as yearbooks through `scripts/spotify.py write_yearbook` (ADR 0005).
- **Reading the web player.** A snapshot is read off the rendered page of the owner's own
  session (titles, artists, albums, durations, the date-added cells, and the ids in the page's
  links). The session's credentials are not read and Spotify's API is not called with them.
- **Enforced.** Rule `project.spotify-history`: `--check` validates every record against its
  schema, refuses a private key in a public record and private data tracked by git, checks
  that every relationship resolves, and, where the private sources exist, that the records are
  current.

## Scope and localisation

- **Scope.** The web player's library, every playlist with its items in order, the saved albums,
  the followed artists, and the profile's top tracks and artists. Every play comes with the data
  export, and only into the private records. The full map of what is covered and missed is
  knowledge `spotify-history-format`.
- **Localisation.** Records and tables are language-neutral data (English keys, Spotify's own
  names, ISO dates). Bodies are English summaries. What the site shows from them is localised
  through `data/i18n/` like every other string (ADR 0006).
- **Formalised.** Every derived file has a schema (`data/spotify-*.schema.json`), and so does the
  private snapshot. `--check` validates them, the table rows and their foreign keys, and
  `ingest-snapshot` refuses a snapshot that is not `spotify-web-snapshot/v1`.
- **Integrated.** Review pages read `index.json` (liked, playlists, the recording's Spotify
  link). The landing's "On repeat this month" shows the reviewed top tracks in rank order.

## Alternatives rejected

- **Everything public**: the timestamps are personal and the publication is irreversible.
- **A private repository**: a second repository to keep in step, for data the site does not
  show.
- **One file per source (a dump)**: unreviewable diffs, no per-song identity, and LLM context
  would have to load everything to answer about one song.
- **Calling Spotify's API with the web player's token**: it handles the owner's credentials,
  and the tool that captured them was refused, rightly.

## Consequences

- A yearbook can be imported from the web player, which unblocks ADR 0005 without an API app.
- The full play history waits for the export the owner requested on 2026-11-14 (up to 30 days).
  `import-export` then adds the plays to the private records.
- Songs without a review are visible per record (`status: missing`), and they form the
  backlog of skill add-song.
