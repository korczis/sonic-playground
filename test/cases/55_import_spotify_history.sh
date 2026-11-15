#!/usr/bin/env bash
# majordomus-skill: import-spotify-history
# The Spotify history on fixtures: records round-trip through their front matter, public records
# validate and hold nothing private, one song is one record across playlists, a short crawl is
# completed, the export's plays stay private, and the committed history passes the gate.
set -euo pipefail
cd "$(dirname "$0")/../.."
# The exit status, not the last line: without the private store (CI, a clean worktree) the
# tests that need it are skipped and unittest ends with "OK (skipped=N)".
if ! out=$(python3 -m unittest discover -s test -p 'test_spotify_history.py' 2>&1); then
  printf '%s\n' "$out" | tail -20 >&2
  echo "FAIL import-spotify-history: unit tests" >&2
  exit 1
fi
python3 scripts/spotify_history.py --check >/dev/null
echo "ok   import-spotify-history: records, privacy split, identity, export and the gate"
