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
2. **Read the web player (snapshot).** In the owner's logged-in Chrome tab at
   https://open.spotify.com/, inject `scripts/spotify-web-crawl.js` (Claude in Chrome
   `javascript_tool`, or DevTools), then run `SonicCrawl.run()` without awaiting it, and poll
   `SonicCrawl.progress` until it is `done`. `SonicCrawl.result` names any playlist short of its
   count. What the script does:
   - it reads the library grid, the liked songs, every playlist and the profile's top lists off
     the rendered page;
   - it never reads the session's credentials and never calls Spotify's API (tested in
     `test/test_spotify_history.py` `Crawl`);
   - it carries the lessons of the first crawl: skeleton rows, restored scroll positions,
     trimmed names, top tracks without links, empty playlists.

   The snapshot goes to the origin's localStorage. Chrome allows one automatic download per
   tab, so open a fresh tab at https://open.spotify.com/robots.txt, inject the script again and
   run `SonicCrawl.download()`, which saves `sonic-spotify-snapshot-<day>.json` and clears the
   key. The tool output masks 22-character ids, which is why the snapshot travels as a download.
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
