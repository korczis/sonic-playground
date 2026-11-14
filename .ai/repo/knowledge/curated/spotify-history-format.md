---
schema: knowledge/v1
id: spotify-history-format
kind: knowledge
class: fact
title: "The Spotify history's format, scope and localisation: what each file is, what it covers and in which language"
description: "Before reading, joining, importing or extending data/spotify/: the record and table formats, their keys, what the history covers and misses, and how it is localised."
status: verified
epistemics: observed
date: 2026-11-14
tags:
  - spotify
  - data
  - schema
  - integration
provenance:
  origin: authored
---

# The Spotify history: format, scope, localisation

Decided in ADR 0007 and enforced by rule `project.spotify-history`. The procedure is skill
`import-spotify-history`. Every file below is derived by `scripts/spotify_history.py build --write`
and never edited by hand. `data/spotify/manifest.json` is the machine-readable entry point.

## Format

| File | Format | Schema | Key |
|---|---|---|---|
| `data/spotify/tracks/<id>.md` | Markdown, YAML front matter of JSON literals | `data/spotify-track.schema.json` | `id` (= file name) |
| `data/spotify/playlists/<id>.md` | same | `data/spotify-playlist.schema.json` | `id` |
| `data/spotify/library.md` | same | `data/spotify-library.schema.json` | `library` |
| `data/spotify/index.json` | JSON | `data/spotify-index.schema.json` | `reviews.<review file>`, `top[]` |
| `data/spotify/tables/{tracks,playlists,memberships,artists,albums}.jsonl` | JSON Lines | `data/spotify-tables.schema.json` (`$defs.<table>`) | in the manifest |
| `data/spotify/manifest.json` | JSON | `data/spotify-manifest.schema.json` | - |
| `data/spotify/private/snapshots/web-<day>[-top].json` (private) | JSON | `data/spotify-web-snapshot.schema.json` | - |

- Front matter: one `key: <JSON>` per line, or `key:` followed by `  - <JSON>` items. JSON is YAML
  1.2, so any YAML or JSON reader takes it. `load_record` parses it with the standard library and
  refuses anything else, giving the line number.
- Join keys of a song: `spotify.track` (catalogue id), `keys.fold` (folded main artist `|` song,
  the identity `scripts/catalog.py` resolves by), and from its review `keys.isrc`,
  `keys.musicbrainz` and `keys.wikidata`. A review joins through `review` (=
  `static/data/catalog.json` `tracks[].source`).
- Foreign keys: `memberships.track` → `tracks.id`, `memberships.playlist` → `playlists.id`,
  `tracks.record` → the record file. `--check` proves every one.
- Identity: one record per recording (a Spotify track id). A row without an id joins the
  record of the same folded artist and song, otherwise it is keyed by that pair. A remix keeps
  its own record (ADR 0005). The owner's `review=`/`skip=` in `data/backlog/*.toml` decides the
  review of a record of the same recording.

## Scope

- Covered (web player, 2026-11-14):
  - the liked songs;
  - every playlist in the library (own, followed, made for the owner, the yearbooks "Your Top
    Songs 2016-2022") with its items in order;
  - the saved albums and followed artists;
  - the profile's top tracks and top artists of the month.
- Not covered yet: every play (the extended streaming history). It comes with the account data
  export, requested 2026-11-14 (up to 30 days), and goes only into the private records.
- Known limits:
  - the top-tracks page shows no track ids, so those rows join by artist and song;
  - an item Spotify no longer offers keeps its position as `unavailable`;
  - empty playlists are records with no tracks;
  - the two library rows "This playlist is not available" have no readable content and are left
    out;
  - a row without artist links (a DJ mix without credits) is `unavailable`.
- Public against private (the owner's answer, `owner-answers-2026-11-14`): dates of adding,
  plays, the owner's display name and every user or playlist id are private. The gate refuses
  them in any public record or table row.

## Localisation

- Records and tables are data: keys in English, values as Spotify names them (titles, artists
  and playlist names in their own language and script, never translated). Dates are ISO 8601.
- The body of a record is a derived summary in English, the repository's language.
- What the site shows is localised through `data/i18n/{en,cs}.toml` (ADR 0006):
  `track.spotify_liked`, `track.spotify_playlists` (plural table), `home.on_repeat`,
  `home.on_repeat_caption`, `home.on_repeat_play` (plural table). The Czech page reads the same
  `index.json`, keyed by the English review file.
