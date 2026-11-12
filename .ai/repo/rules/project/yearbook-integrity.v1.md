---
id: project.yearbook-integrity
version: 1
kind: rule
title: Yearbooks are relationships to reviews, resolved and derived, one song one page
description: The owner's annual Spotify Top Songs are data/backlog/ files of kind yearbook; every item resolves to exactly one review or states why not, and every yearbook page, count and membership is derived by scripts/catalog.py.
statement: Keep yearbooks as data/backlog/yearbook-<year>.toml per data/backlog.schema.json (written by scripts/spotify.py or a transcription), holding relationships only; let scripts/catalog.py resolve each item (review=, skip=, uncertain, ISRC, artist and song; ambiguity reported) and derive the pages under content/yearbook/, the counts and each review's years; never write an account identifier.
status: active
class: blocking
depends_on: [project.catalogue-derived@1, project.content-contract@1]
tags: [yearbook, spotify, identity, derived]
x-majordomus:
  tests: [scripts/catalog.py, test/test_spotify.py, scripts/backlog.py]
---

# Rationale

A song in five yearbooks is one review with five memberships. Positions, counts and pages that
were typed by hand would drift from the playlists; resolved and derived they cannot.

# Required behaviour

- A playlist file validates against `data/backlog.schema.json`; a yearbook has its year, unique
  positions and is the only one of that year.
- `scripts/catalog.py` resolves every item: `review=` (must name a review), `skip=` (a reason),
  `uncertain`, then a unique ISRC match, then a unique artist-and-song match; more than one match
  is `ambiguous`, none is `missing` (the backlog of skill add-song, `scripts/backlog.py`).
- The yearbook pages are derived stubs; `--check` refuses a stale or leftover one.
- `scripts/spotify.py` writes only on change (idempotent) and keeps the owner's overrides.

# Failure behaviour

The catalogue check fails, so the pre-commit hook and the gate refuse the change.

# Verification

```sh
python3 scripts/catalog.py --check && python3 -m unittest discover -s test -p 'test_spotify.py'
```
