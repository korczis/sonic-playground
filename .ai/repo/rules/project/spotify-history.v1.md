---
id: project.spotify-history
version: 1
kind: rule
title: The Spotify history is derived per song; public records hold identity and relationships, never time or account
description: data/spotify/ holds one schema-valid record per song and playlist, derived by scripts/spotify_history.py; dates, plays and account identifiers live only in the ignored data/spotify/private/.
statement: Derive data/spotify/ only with scripts/spotify_history.py (build --write) from the private store; keep every public record valid against data/spotify-{track,playlist,library}.schema.json with no private key (added, plays, ts, user or owner ids, playlist ids); keep data/spotify/private/ ignored and untracked; never hand-edit a record.
status: active
class: blocking
depends_on: [project.yearbook-integrity@1, project.catalogue-derived@1]
tags: [spotify, privacy, derived, data]
x-majordomus:
  tests: [scripts/spotify_history.py, test/test_spotify_history.py]
---

# Rationale

The repository is public, and the owner chose a split (ADR 0007): the songs and their
relationships are shared, and the times are not. A record typed by hand would drift from its
source. A private field that slipped into a public record would be published for good.

# Required behaviour

- `data/spotify/tracks/<id>.md`, `playlists/<id>.md` and `library.md` validate against their
  schemas, their `id` is their file name, and every playlist entry and track reference names an
  existing record. Every `review` names an existing review.
- No public record has a key from the private set: `added`, `plays`, `ts`, `played`, `ip_addr`,
  `user`, `user_id`, `owner_id`, `username`, `email`, `playlist_id`, `conn_country`,
  `platform`.
- `index.json`, `manifest.json` and every row of `tables/*.jsonl` validate against
  `data/spotify-{index,manifest,tables}.schema.json`. The tables' foreign keys resolve
  (membership to track and playlist, track to its record), and no row has a private key.
- A private snapshot validates against `data/spotify-web-snapshot.schema.json`;
  `ingest-snapshot` refuses one that does not.
- `.gitignore` ignores `/data/spotify/private`, and git tracks nothing under it.
- Where the private sources exist, a build changes nothing: the committed records and the
  yearbooks they write are current. This currency check is local by design. The private store
  never leaves the owner's machine, so CI and every checkout without it check structure and
  privacy only. On the machine that holds it, a merged or new review changes a record's
  status, so `npm run derive` (which runs the history build first) belongs between such a
  merge and its push. The refusal names the stale records. Only the committed records are
  judged: the private records are local derived state, and the linked worktrees share one store.
- A snapshot is read from the rendered web player; the owner's session credentials are never
  read or used.

# Failure behaviour

`python3 scripts/spotify_history.py --check` exits non-zero, so `scripts/verify.sh`, the
pre-commit hook and CI refuse the change.

# Verification

```sh
python3 scripts/spotify_history.py --check && python3 -m unittest discover -s test -p 'test_spotify_history.py'
```
