---
schema: knowledge/v1
id: owner-answers-2026-11-12
kind: knowledge
class: fact
title: "The owner's answers of 2026-11-12: the Spotify source, ADRs 0001-0005, the stale master branches, the Majordomus path-hashing bug"
description: "Before importing a yearbook, changing an ADR's status, recreating a master branch, or working around the Majordomus gate recorder's non-ASCII path bug."
status: verified
epistemics: observed
date: 2026-11-12
tags:
  - decisions
  - spotify
  - adr
  - git
provenance:
  origin: authored
---

# The owner's answers of 2026-11-12

Asked by Claude Code in session `7e1d03a3-52cc-40aa-a61a-4f9713c27f2a`, answered by the owner at
about 2026-11-12T16:10Z. Each question and answer is quoted as given.

## Spotify source of the yearbooks

- Question: "Your Spotify Top Songs yearbooks can't be imported yet: there is no Spotify token on
  this machine, and new apps can't read Spotify-owned 'Your Top Songs' playlists directly. How do
  you want to provide them?"
- Answer: "Data export (Recommended)", that is: request the account data from Spotify (Privacy
  settings, Download your data) and hand over the folder containing `Playlist*.json`, which
  `python3 scripts/spotify.py import-export <folder>` imports. No app or token is involved.
- Consequence: the import waits for the export to arrive. Skill `import-yearbook` then runs from
  the export.

## ADRs 0001-0005

- Question: "ADRs 0001-0005 (static serverless site, derived catalogue, router + social cards,
  educational layer, yearbooks) are still marked proposed. Accept them?"
- Answer: "Accept all five".
- Consequence: each of ADRs 0001-0005 carries an Acceptance section that names this record. The
  status itself is the owner's edit to make: `majordomus adr check` refuses `accepted` on a record
  with `provenance.origin: extracted`, because "acceptance is the person's act". The owner flips it
  (status `accepted`, origin `authored`, the owner taking authorship), and then the change is
  committed.

## The stale master branches

- Question: "The stale branches origin/master and gitlab/master point at the initial commit and
  are the likely reason new Majordomus worktrees start from it. Delete them on both remotes?"
- Answer: "Delete both".
- Consequence: `master` was deleted on GitHub (`origin`) and GitLab (`gitlab`). Both pointed at
  `e32d2ca` (the initial commit); `main` is the default branch and holds all history.
  The deletion also showed that GitLab's `main` is still at `e32d2ca`: the GitLab mirror has never
  received any later commit.

## The Majordomus gate recorder and non-ASCII paths

- Question: "Majordomus bug: its gate recorder hashes git's quoted paths, so any non-ASCII tracked
  file makes every recorded gate run read back as stale. Shall I file it in prismatic-majordomus?"
- Answer: "File an issue".
- Consequence: filed as https://github.com/korczis/prismatic-majordomus/issues/3014. This
  repository already avoids the bug: `scripts/catalog.py` refuses a review whose file name is
  not ASCII.
