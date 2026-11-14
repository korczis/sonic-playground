---
schema: skill/v1
id: import-spotify-history
version: 1
title: Import the owner's Spotify history as one record per song
description: Read the owner's library from their logged-in web player (or the account data export), keep the raw sources private, derive one public record per song and playlist plus the yearbooks, verify and deploy.
status: active
tags: [spotify, data, privacy, yearbook, derived]
inputs:
  - the owner's logged-in Spotify web player (Claude in Chrome), or the account data export folder
outputs:
  - data/spotify/tracks/*.md, playlists/*.md, library.md, index.json (public, ADR 0007)
  - data/spotify/private/ (ignored): raw snapshots, export, private records with dates and plays
  - data/backlog/yearbook-<year>.toml for every "Your Top Songs <year>" (ADR 0005)
---
# Purpose

Turns the owner's Spotify library into machine-readable records: one per song, one per playlist,
one for the library. Each record has a YAML front matter whose values are JSON literals, and a
short summary for people. The records are public, and the times stay private (ADR 0007, rule
`project.spotify-history`). This is not for writing reviews (skill add-song) or for editing a
yearbook by hand.

# When to use

When the owner asks for their Spotify history, library, playlists or Top Songs. Also when the
data export arrives, and to refresh the records after the library changes.

# Procedure

1. **Branch and task.** `majordomus worktree create feature/spotify-<topic>`, then
   `majordomus start "…" --scope data/spotify,data/backlog,content,static/data`.
2. **Read the web player (snapshot).** In the owner's logged-in Chrome tab, at open.spotify.com:
   - read the library grid ("Your Library": playlists, albums, artists; each row's
     `aria-labelledby` names its `spotify:<kind>:<id>`);
   - open every playlist and the liked songs through the app's own navigation
     (`history.pushState` and a `popstate` event), and scroll its grid, collecting each
     `[role=row]`: title and track id from the `/track/` link, artists and album from their
     links, the "Date added" cell and the duration. Map the cells through the column headers.
   - Never read or use the session's credentials, and never call Spotify's API with them: the
     page shows everything this needs. The tool output masks 22-character ids, so the page saves
     the result as one JSON download (`schema: spotify-web-snapshot/v1`, `captured`, `library`,
     `playlists[]` with `uri`, `name`, `library_subtitle`, `owner`, `expected`, `items`).
   - Rerun a playlist whose `items` fall short of `expected`, more slowly, until they match.
3. **Keep it private.** `python3 scripts/spotify_history.py ingest-snapshot ~/Downloads/<file>.json`
   (add `--plain <file>` when a full liked-songs reading without ids completes a short one).
   The raw file goes to `data/spotify/private/snapshots/`; delete the download afterwards.
4. **The export.** When Spotify's e-mail arrives (account data in about 5 days, the extended
   streaming history in up to 30), unpack it, then run
   `python3 scripts/spotify_history.py import-export <folder>`. The plays go into the private
   records only.
5. **Derive.** `python3 scripts/spotify_history.py build` reports, and `build --write` writes
   the records, removes leftovers and writes the yearbooks. Then run `npm run derive` so that
   the catalogue picks up the yearbooks.
6. **Resolve and write.** `python3 scripts/spotify.py coverage` shows each yearbook's missing and
   ambiguous items. An ambiguous item gets `review =` and a non-song gets `skip =` in its
   yearbook file, never a guess. Missing songs go to skill add-song
   (`python3 scripts/backlog.py --batches N`).
7. **Prove and deploy.** `python3 scripts/spotify_history.py --check` and
   `bash scripts/verify.sh`. Commit the records with the regenerated catalogue
   (`feat(data): …`), then `majordomus finish`, merge and push.

# Output

Songs, liked songs, playlists by kind, yearbooks (retrieved against expected), the reviewed
share, and anything short or ambiguous, with the commits and the deploy run.
