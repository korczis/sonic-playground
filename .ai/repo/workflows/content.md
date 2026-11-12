# Adding and refreshing songs

Every review enters through the track engine and leaves through the deploy gate. The rules it
serves: `project.content-contract`, `project.catalogue-derived`, `project.deploy-gate`. The
procedure for one song is the skill `add-song` (`majordomus://skill/add-song`; `/add-song` in
Claude Code).

| When | Run |
|---|---|
| a new song (link or name) | follow `majordomus://skill/add-song` |
| a year's Spotify Top Songs (yearbook) | follow `majordomus://skill/import-yearbook` |
| the identifiers MusicBrainz knows | `python3 scripts/track.py enrich content/<file>.md --write` (or `--all`) |
| what the yearbooks and playlists still miss | `python3 scripts/backlog.py`; `python3 scripts/spotify.py coverage` |
| is it already here? | `python3 scripts/track.py resolve "<input>"` — exit 3 names the existing file |
| which facets exist | `python3 scripts/track.py vocab --limit 40` |
| a term is new | `python3 scripts/track.py suggest --genre <g> --sentiment <s>` — nearest terms, related tracks |
| the outline new reviews get | `python3 scripts/track.py outline` (derived from the corpus) |
| one article is done | `python3 scripts/track.py check content/<file>.md` — no errors, `unfinished: 0` |
| any content change | `npm run derive` — the committed catalogue must be current |
| before committing | `bash scripts/verify.sh` |
| weekly, or a still shows the placeholder | `python3 scripts/probe-videos.py` — videos removed from YouTube |

## Refreshing an existing review

`resolve` reports the existing file for the same video or the same artist and track. Edit that
file: replace a dead video id (`probe-videos.py` names it), add sourced `extra.album`,
`release_year`, `publisher`, keep the owner's prose unless asked otherwise. Never create a second
article for a track.

## Changing the outline or the guidance

The outline is derived (`scripts/catalog.py`, `x-sonic.outline_threshold` in
`data/track.schema.json`); only the guidance per section is written, in `data/review.toml`. A
contract change is a change to `data/track.schema.json` with its test in `test/test_catalog.py`.
