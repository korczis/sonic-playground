---
name: import-yearbook
description: Import the owner's annual Spotify "Top Songs" playlists into Sonic Playground as yearbooks - authorise, discover, import, resolve every item to one review, write the missing songs via add-song, derive, verify, deploy. Use for /import-yearbook, "import my Top Songs", "add my Spotify yearbooks".
argument-hint: "[year | playlist link | export folder]"
---

# /import-yearbook $ARGUMENTS

The Claude Code entry point of the repository skill `import-yearbook`. The procedure is canonical
in `.ai/repo/skills/import-yearbook/SKILL.md`; read it and follow it for `$ARGUMENTS`.

Claude-specific notes: the authorisation (step 2) is the owner's; give them the exact commands
(`! export SPOTIFY_CLIENT_ID=…`, `! python3 scripts/spotify.py auth`) and never read, print or
store a token. Fan out the missing songs to `song-writer` agents in one shared worktree, then
derive and verify once as the integrator.
