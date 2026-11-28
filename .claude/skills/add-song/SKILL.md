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
- Versions (step 8): `python3 scripts/track.py versions content/<file>.md --json`, pick with
  `--write --pick <id>[:<kind>]`, write the sourced notes with Edit, end on `--verify` with 0
  diffs. Never put the versions in the prose as links.
- Fact-check (step 10): launch the read-only `fact-checker` agent (`.claude/agents/`) on the
  page, its translation and its sources, with `.ai/repo/prompts/fact-check.md` as its brief; when
  `command -v codex` answers, also run
  `codex exec --skip-git-repo-check -s read-only "<the same prompt>" < /dev/null`. Resolve every
  finding from its source before the commit; neither report is an authority.
- Consult: discuss the structure with Codex as above and with the peer sessions that ListAgents
  shows (and `majordomus peers`), and say in the report what each changed.
- Finish with `bash scripts/verify.sh` (set `CHROME_PATH` to a local Chrome when Playwright's
  chromium is not installed). After the push, the `deploy-verifier` agent, or you, runs
  `npm run live -- <slug> --expect <sha>`; the song is done only when it passes. Report the page
  path, the facets, the versions, the fact-check, the gate result and the live result.
