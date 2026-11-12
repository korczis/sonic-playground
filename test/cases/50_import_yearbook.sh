#!/usr/bin/env bash
# majordomus-skill: import-yearbook
# The yearbook import on fixtures: Spotify pages read in order and counted, a re-import changes
# nothing and keeps the owner's overrides, the data export is read, and every item resolves to
# one review (one song in two years is one page with two memberships). No network, no account.
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 -m unittest discover -s test -p 'test_spotify.py' 2>&1 | tail -1 | grep -qx OK
echo "ok   import-yearbook: import, idempotence, overrides, export and identity resolution"
