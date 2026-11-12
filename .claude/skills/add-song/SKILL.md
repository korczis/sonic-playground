---
name: add-song
description: Add a song to Sonic Playground from a YouTube link or "Artist - Track" - the engine infers artist, track, video, file and outline, you research and write the review, the catalogue and site derive the rest, then verify and deploy. Use for /add-song, "add this track", "write a review of <song>".
argument-hint: "[YouTube link | Artist - Track]"
---

# /add-song $ARGUMENTS

This is the Claude Code entry point of the repository skill `add-song`. The procedure is
canonical in `.ai/repo/skills/add-song/SKILL.md` (Majordomus: `majordomus skills show add-song`).
Read it and follow it step by step for the input `$ARGUMENTS`.

Claude-specific notes:

- Research step: use WebSearch (standard first, extended when thin) to find the official upload
  for a name input and to source year, album, label and context; cite nothing you could not
  verify.
- Run the engine with Bash: `python3 scripts/track.py resolve "$ARGUMENTS"` first; JSON comes
  back on stdout, exit 3 means the track already exists.
- Write the review with Edit on the file the engine created, replacing every `TODO(write)`.
- Finish with `bash scripts/verify.sh` (set `CHROME_PATH` to a local Chrome when Playwright's
  chromium is not installed) and report the page path, the facets and the gate result.
