---
schema: skill/v1
id: import-yearbook
version: 1
title: Import the owner's annual Spotify Top Songs as a yearbook
description: Authorise read access, find the annual playlists, import each as data/backlog/yearbook-<year>.toml, resolve every item to one review, write the missing ones through add-song, derive, verify and deploy.
status: active
tags: [yearbook, spotify, content, derived]
inputs:
  - the owner's Spotify account (authorisation by the owner), or the account data export folder
outputs:
  - data/backlog/yearbook-<year>.toml per year, items in order, no account identifier
  - one review per missing song (skill add-song), yearbook pages derived
---
# Purpose

Turns the owner's "Your Top Songs <year>" playlists into yearbooks: one canonical review per song,
any number of yearbook memberships, every page and count derived (ADR 0005, rule
`project.yearbook-integrity`). Not for editing reviews (add-song) or the site.

# When to use

When the owner asks for a year's (or every year's) Top Songs, or a new year's playlist appears.

# Procedure

1. **Branch and task.** `majordomus worktree create feature/yearbook-<year>`, then
   `majordomus start "Import yearbook <year>" --scope data/backlog,content,static/data,data/derived`.
2. **Access (owner).** Spotify does not let new API clients read Spotify-owned playlists, and the
   annual ones are owned by Spotify. Either the owner copies each into a playlist of their own
   (in the app: … > Add to other playlist > New playlist) and authorises read access
   (`export SPOTIFY_CLIENT_ID=…`; `python3 scripts/spotify.py auth`), or the owner requests the
   account data ("Download your data") and hands over the folder with `Playlist*.json`.
3. **Discover.** `python3 scripts/spotify.py discover` lists the owner's playlists whose names name
   a year (English, Czech, German, Spanish, French patterns). Confirm each is the owner's annual
   Top Songs before importing; never substitute an editorial chart.
4. **Import.** `python3 scripts/spotify.py import <id> --year <year>` reports expected against
   retrieved; add `--write` when complete. From an export: `import-export <folder> --write`.
   A re-import of unchanged items changes nothing and keeps the owner's `review=`/`skip=`.
5. **Resolve.** `npm run derive`, then `python3 scripts/spotify.py coverage`: per year the items
   present, missing, ambiguous, skipped, uncertain. Give an ambiguous item `review = "<file>.md"`;
   an item that is no song `skip = "<why>"`. Never guess.
6. **Write the missing songs.** `python3 scripts/backlog.py --batches N` splits what has no review;
   each batch goes to a `song-writer` agent (skill add-song, educational layer included). Then
   `python3 scripts/track.py enrich --all --write` so new reviews get their ISRC and resolve.
7. **Prove and deploy.** `npm run derive && bash scripts/verify.sh`, commit (`feat(content): …`),
   `majordomus finish --outcome completed --verify-command "bash scripts/verify.sh"`, merge to
   `main` and push; then verify production (agent deploy-verifier): every yearbook URL and its
   songs serve.

# Output

Per year: retrieved against expected, present, created, ambiguous, skipped, uncertain; the
commits; the deploy run; the yearbook URLs.
