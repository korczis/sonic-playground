---
schema: skill/v1
id: add-song
version: 1
title: Add a song to the playground
description: From a YouTube link or "Artist - Track", write a new review that the engine infers, the catalogue integrates and the site derives everything else from, then prove it builds.
status: active
tags: [content, engine, derived]
inputs:
  - a YouTube link (watch, youtu.be, embed, shorts, music) or a name "Artist - Track"
  - optionally the owner's own angle on the track (why it belongs here)
outputs:
  - content/<slug(artist track)>.md, every TODO(write) replaced, validated by the contract
  - static/data/catalog.json regenerated (facets, related tracks, outline, stats)
  - one commit feat(content) on a feature branch, the gate green
---
# Purpose

Adding a track is one command and one review: the engine (`scripts/track.py`) infers the artist,
the track, the video, the file name and the outline from the input and the corpus; the writer
supplies only what cannot be inferred, the prose and the facet choice. Everything the site shows
about the track (card, explorer facets, related tracks both ways, insights, feeds) is derived from
the article by `scripts/catalog.py`. It serves rules `project.content-contract`,
`project.catalogue-derived` and `project.site-static-serverless`. It is not for editing the
engine, the templates or the contract themselves.

# When to use

Whenever a song is to be added, or an existing review is to be refreshed ("updated") from a new
link. Not for bulk imports (run the engine in a loop and review each article).

# Procedure

1. **Branch and task.** In the primary checkout on `main`:
   `majordomus worktree create feature/song-<slug>`, continue in the path it prints, then
   `majordomus start "Add <Artist - Track>" --scope content,static/data`.
2. **Resolve.** `python3 scripts/track.py resolve "<input>"` prints the inferred artist, track,
   video id, oEmbed title and target file. Exit 3 means the track exists: open the reported file
   and refresh that review instead of writing a second one (same video or same artist and track).
   A wrong inference is corrected with `--artist`/`--track`; a name without a video gets
   `--youtube <link>` after finding the official upload.
3. **Research.** Before choosing facets or writing, establish the facts: release year, album,
   label, the artist's context, what the track sounds like (listen notes, credible reviews). Only
   facts you can source go in; unknown facts are left out, never guessed.
4. **Facets.** `python3 scripts/track.py vocab --limit 40` shows the vocabulary. Pick 2-4
   genres and 2-4 feelings, preferring existing terms; `scripts/track.py suggest --genre ...
   --sentiment ...` names the nearest existing term for each new one and previews the related
   tracks. A new term is fine when no existing one is true to the track.
5. **Write the skeleton.** `python3 scripts/track.py new "<input>" --genre ... --sentiment ...
   [--mood ...] --description "<one or two sentences>"` writes the article from
   `archetypes/track.md`: front matter per `data/track.schema.json` and the outline the corpus
   shares (`scripts/track.py outline`), each section carrying its `data/review.toml` guidance as a
   `TODO(write)` line.
6. **Write the review.** Replace every `TODO(write)` with prose in the voice of the existing
   reviews (read two related tracks the engine listed first): concrete, sensory, honest. Keep the
   section order; drop a breakdown part the track does not have, add one it does. Aim for the
   catalogue's median length (`stats.median_words`). Add `extra.album`, `release_year`,
   `publisher` when sourced.
7. **Prove it.** `python3 scripts/track.py check content/<file>.md` (no errors, `unfinished: 0`),
   then `npm run derive` and `bash scripts/verify.sh` (catalogue, tests, build, browser smoke).
   `majordomus check` before claiming progress.
8. **Commit and finish.** `git add content static/data && git commit -m "feat(content): add
   <Artist> – <Track>"`; `majordomus finish --outcome completed --verify-command "bash
   scripts/verify.sh"`; merge to `main` with `--no-ff` and push — pushing `main` deploys
   (`.github/workflows/pages.yml`), and the run verifies production serves the commit.

# Output

- The article path, the inferred artist/track and the rule that inferred them, the chosen facets
  (new terms named), the related tracks, the word count.
- The gate result (`scripts/verify.sh`) and, after the push, the Pages run URL and the live page.
