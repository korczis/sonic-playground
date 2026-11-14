#!/usr/bin/env bash
# majordomus-skill: import-spotify-history
# The Spotify history on fixtures: records round-trip through their front matter, public records
# validate and hold nothing private, one song is one record across playlists, a short crawl is
# completed, the export's plays stay private, and the committed history passes the gate.
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 -m unittest discover -s test -p 'test_spotify_history.py' 2>&1 | tail -1 | grep -qx OK
python3 scripts/spotify_history.py --check >/dev/null
echo "ok   import-spotify-history: records, privacy split, identity, export and the gate"
