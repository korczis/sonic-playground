---
schema: skill/v1
id: add-song
version: 2
title: Add a song to the playground
description: From a YouTube link or "Artist - Track", write a new review that the engine infers, the catalogue integrates and the site derives everything else from, then prove it builds.
status: active
tags: [content, engine, derived]
inputs:
  - a YouTube link (watch, youtu.be, embed, shorts, music) or a name "Artist - Track"
  - optionally the owner's own angle on the track (why it belongs here)
outputs:
  - content/<slug(artist track)>.md, every TODO(write) replaced, validated by the contract
  - the song's versions as data ([[extra.versions]]), verified against YouTube with 0 diffs
  - a fact-check report whose every finding is resolved from its source
  - static/data/catalog.json regenerated (facets, related tracks, outline, versions, stats)
  - one commit feat(content) on a feature branch, the gate green
  - the page passing test/e2e/live.cjs on production, en and cs, desktop and phone
---
# Purpose

Adding a track is one command and one review: the engine (`scripts/track.py`) infers the artist,
the track, the video, the file name and the outline from the input and the corpus; the writer
supplies only what cannot be inferred, the prose and the facet choice. Everything the site shows
about the track (card, explorer facets, related tracks both ways, insights, feeds) is derived from
the article by `scripts/catalog.py`. It serves rules `project.content-contract`,
`project.catalogue-derived` and `project.site-static-serverless`. It is not for editing the
engine, the templates or the contract themselves.

# When to use

Whenever a song is to be added, or an existing review is to be refreshed ("updated") from a new
link. Not for bulk imports (run the engine in a loop and review each article).

# Procedure

1. **Branch and task.** In the primary checkout on `main`:
   `majordomus worktree create feature/song-<slug>`, continue in the path it prints, then
   `majordomus start "Add <Artist - Track>" --scope content,static/data`.
2. **Resolve.** `python3 scripts/track.py resolve "<input>"` prints the inferred artist, track,
   video id, oEmbed title and target file. Exit 3 means the track exists: open the reported file
   and refresh that review instead of writing a second one (same video or same artist and track).
   A wrong inference is corrected with `--artist`/`--track`; a name without a video gets
   `--youtube <link>` after finding the official upload.
3. **Research.** Before choosing facets or writing, establish the facts: release year, album,
   label, the artist's context, what the track sounds like (listen notes, credible reviews). Only
   facts you can source go in; unknown facts are left out, never guessed.
   Never download, rip or locally analyse a recording or its video (no yt-dlp, no captions,
   no spectrograms or loudness measurements): how a track sounds comes from cited sources
   only, and where no source describes a passage the review says so and describes less.
4. **Facets.** `python3 scripts/track.py vocab --limit 40` shows the vocabulary. Pick 2-4
   genres and 2-4 feelings, preferring existing terms; `scripts/track.py suggest --genre ...
   --sentiment ...` names the nearest existing term for each new one and previews the related
   tracks. A new term is fine when no existing one is true to the track. A new genre also goes
   into its family in `data/genres.toml` (the site browses genres by family; `npm run derive`
   names a genre left to inference, and `test/test_catalog.py` refuses it).
5. **Write the skeleton.** `python3 scripts/track.py new "<input>" --genre ... --sentiment ...
   [--mood ...] --description "<one or two sentences>"` writes the article from
   `archetypes/track.md`: front matter per `data/track.schema.json` and the outline the corpus
   shares (`scripts/track.py outline`), each section carrying its `data/review.toml` guidance as a
   `TODO(write)` line.
6. **Teach (ADR 0004, rule `project.educational-article`).** Every review is also an educational
   article, described in its front matter:
   - `python3 scripts/track.py enrich content/<file>.md --write` fills the MusicBrainz ids, ISRC,
     the artist's country and a missing year, then `python3 scripts/track.py audit-mb
     content/<file>.md` checks them (see "Many songs");
   - `[taxonomies] concept = [...]` (2-4, from `data/concepts/`; a new concept is a new
     `data/concepts/<slug>.toml` with a definition in every locale) and `instrument = [...]`;
   - `[extra.credits]` (writers, producers, featuring, remixers, vocals) as credited;
   - `[extra.learning]`: `level`, 2-4 `objectives`, at least 3 `listen_for` entries
     (each keyed by `part`, such as "the chorus"; `at = "m:ss"` only when a source gives the
     time, such as the video's chapters or a timed analysis; `what` is what the sources say to
     listen for there) and 2-3 `questions`;
   - `[[extra.sources]]` (at least 2: title, url, kind, publisher, year) for every fact you used;
   - `[[extra.connections]]` to 1-3 other reviews, each with `why`;
   - in "Concepts in Focus", explain the concepts as they sound here, linking each once with
     `{{ <concept_link name="…" /> }}` and other reviews with `{{ <track_link source="….md" /> }}`.
   Claim nothing a cited source does not support: no invented BPM, key, chart position or song
   structure.
7. **Write the review.** Replace every `TODO(write)` with prose in the voice of the existing
   reviews (read two related tracks the engine listed first): concrete, sensory, honest. Keep the
   section order; drop a breakdown part the track does not have, add one it does. Aim for the
   catalogue's median length (`stats.median_words`). Add `extra.album`, `release_year`,
   `publisher` when sourced.
8. **Versions.** A song's family of versions (the official video, the artist's own and licensed
   releases, official remixes, other producers' remixes and edits, live takes, covers, dances,
   excerpts) is data: `[[extra.versions]]` per `data/track.schema.json`, which the page renders
   as its versions list and the player can queue. Never a list of links in the prose: the
   contract refuses a prose link to a listed version.
   - `python3 scripts/track.py versions content/<file>.md --json` searches YouTube for the
     song (with remix, edit, extended, live, cover, line dance) and lists the candidates with a
     suggested kind, its confidence and reasons, and the evidence URL; `--query` adds a search.
   - Pick what is the same song, by its maker or credited: `--write --pick <id>[:<kind>] ...`
     appends the tables (kind, title, by, youtube, format, duration, date, rights) and refuses a
     duplicate. Correct a kind the heuristic got wrong in the `:<kind>` suffix, not afterwards.
   - The page's own video is among them (`official-video`, or `original` for an audio upload);
     a version that has its own review names it (`review = "<file>.md"`).
   - Add a `note` only where a source says what the version is or changes (the uploader's own
     description, a label page, an interview), one sentence, and its `source` when that is not
     the version's own page. The tool never writes a note; a note is translated (step 9).
   - `python3 scripts/track.py versions content/<file>.md --verify` re-reads every listed
     version from YouTube; it must report 0 diffs (title, by, duration, date) before the commit.
9. **Translate (ADR 0006).** Every page is bilingual: write the Czech counterpart through the
   skill `translate` (`python3 scripts/translate.py scaffold content/<file>.md`, translate in
   place, `python3 scripts/translate.py check content/<file>.cs.md`). The contract refuses a
   review without its translation, and a translation older than its English text. The
   scaffold carries each version's note keyed by its `youtube` (or `url`), in the English order.
10. **Fact-check before the commit.** An independent pass, by a worker that did not write the
   page, with the prompt `.ai/repo/prompts/fact-check.md` over the English page, its
   translation and its sources: every date, credit, number, quotation and version claim is
   checked against the source it cites (read-only; it changes nothing). When `codex` is
   installed, take a second opinion as well:
   `codex exec --skip-git-repo-check -s read-only "<the rendered prompt>" < /dev/null`.
   Findings are inputs, never an authority: resolve each one from the source itself, fix what
   the source contradicts, and leave what the source supports.
11. **Prove it.** `python3 scripts/track.py check content/<file>.md` (no errors, `unfinished: 0`),
   then `npm run derive` and `bash scripts/verify.sh` (catalogue, tests, build, browser smoke).
   `majordomus check` before claiming progress.
12. **Commit and finish.** `git add content static/data && git commit -m "feat(content): add
   <Artist> – <Track>"`; `majordomus finish --outcome completed --verify-command "bash
   scripts/verify.sh"`; merge to `main` with `--no-ff` and push — pushing `main` deploys
   (`.github/workflows/pages.yml`), and the run verifies production serves the commit.
13. **Done = live.** A song is done only when production proves it in a real browser:
   `npm run live -- <slug> --expect <sha>` (`test/e2e/live.cjs`) passes, in English and Czech,
   on a desktop and a phone. It derives what to expect from the checkout's catalogue (path,
   video, concepts, connections and backlinks, versions with their stills, the social image,
   the search indexes) and writes screenshots to `--out`; read them. Until it passes, report
   the song as delivered but not done, with the failing lines.

# Consult

The owner wants structure discussed with other models, not decided alone: the outline, the
facet choice, which versions belong and what a disputed fact is. Ask Codex
(`codex exec --skip-git-repo-check -s read-only "..." < /dev/null`) and the peer sessions
working on this repository (the Majordomus MCP tool `majordomus_peers`; in Claude Code,
ListAgents and SendMessage), say in the report whom you asked and what
changed because of it, and keep the decision, with its reason, your own.

# Many songs (the backlog)

`python3 scripts/backlog.py` lists the songs of `data/backlog/*.toml` (the owner's playlists,
transcribed) that have no review: a song, not a recording (version suffixes and featured
artists folded, remixes kept), each once. `--source spotify` lists the songs of the owner's
Spotify history (ADR 0007) the owner chose (current top tracks, liked songs, own playlists),
strongest choice first, without interludes and continuous mixes; `--limit N` takes the head of
the list for one wave. Before batching a wave, screen it: `python3 scripts/backlog.py --source
spotify --screen --limit N [--json]` (`scripts/screen.py`, no model, MusicBrainz at one request a
second, Wikidata and Wikipedia, cached under `~/.cache/sonic-playground`) orders the songs by how
much independent material exists and gives each its tier, score, reason codes and evidence URLs:
`writable` (a song or release article, or two independent substantive sources) is commissioned
first, `ambiguous` (artist-level coverage only, one source, or the identity unclear) next, and
`thin` (catalogue rows only) last. The tier is an order, never a verdict: a thin song is still
written, as a full page that says what no source describes. Hand each writer its row's evidence
as the starting point of step 3. `--batches N` splits it; each batch goes to one
`song-writer` agent (`.claude/agents/song-writer.md`) running this procedure in one shared
worktree, creating only its own files. The integrator then runs `npm run derive` and the gate
once, commits `feat(content)` and deploys. Learned on 2026-11-12 (168 songs, 8 agents):

- Pass every facet as its own quoted argument (`--genre "deep house" --genre techno`, or several
  terms after one flag); an unquoted shell variable joined or split terms in three files.
- Find the video on YouTube's own search page; a general web search rarely returns watch URLs.
  Prefer the artist's channel, VEVO, the label, then "- Topic"; a third-party channel only when
  its upload is the official video, and say so in the report.
- No official upload at all: create the page from the name; it shows the derived artwork.
- A batch row's `why` (top rank, liked, playlists) orders the wave and never enters the prose:
  "here because it is among the owner's most played tracks this month" is stale within weeks
  and says nothing about the music (wave 12, 2026-11-19: eleven pages had it removed). Since
  2026-11-22 the contract refuses any sentence about the owner's listening, in English and
  Czech (rule `project.educational-article`); `track.py check` names it.
- A backlog song that already has a page under another credit or title: the lead artist and
  song match it when only one page fits; a sourced other title ("One Night In NYC" for
  "One Night In New York City") goes in `extra.titles`, never a second page.
- MusicBrainz ids: set `extra.album` (`track.py refresh --album`) before `enrich`; it picks the
  recording within 3 s of the Spotify duration on the album's release and leaves out (and says
  why) what it cannot single out. Then run `track.py audit-mb content/<file>.md`: it flags a
  length off the duration, a live/DJ-mix/instrumental/excerpt copy, a release that is not the
  album, an ISRC not on the recording. Fix every flag (`--fix` writes only unambiguous
  corrections; the rest by hand from musicbrainz.org) before `check`. In recent waves 30-50% of
  enriched pages had a compilation, DJ-mix, live or instrumental copy (Dr. Dre's "2001
  Instrumental", a 64 s Jeff Mills mix excerpt).
- A row that is not a song (an interview, a skit) or whose artist is unclear is skipped and
  reported for the owner, never guessed. Once the integrator confirms it is not a song, it gets a
  `skip = "<reason>"` row in `data/backlog/decisions.toml` (a song reviewed under another
  spelling gets `review = "<file>.md"` there), so the next wave does not draw it again.

# Lessons from MAINVIBE – Lauter (2026-11-28)

- A quotation belongs to the version it describes. Kenzler's description of the "Swing Deep
  House" version was first attached to another version; read the upload the quotation comes
  from and put it on that version's note.
- A licensed upload is not the release. The "- Topic" upload by Universal Music Group was
  posted two weeks after the "Released on" date it states; the version's `date` is the date its
  source shows, and the prose never dates the song by a later upload.
- Midnight in Germany is the previous day in UTC and in YouTube's US dates. The official video
  went up at 00:00 CET on release day; check the upload's timestamp with its offset, or the
  artist's announcement, before writing a day.
- Tags a channel puts on every upload are not genre evidence. Genres come from what sources
  say about this song, not from a channel's keywords.
- YouTube's pages need its consent cookie for a script: `curl -H 'Cookie: CONSENT=YES+1;
  SOCS=CAI' -H 'Accept-Language: en'`; without it the consent page comes back and holds no
  `ytInitialData` (scripts/youtube.py sends it).
- Search titles can be machine-translated ("LOUDER" for "LAUTER" under `Accept-Language: en`):
  the watch page's title is the title; the tool takes it from there and drops emoji.
- Discovery finds more than a hand search: the Force Techno Remix of Lauter appeared only in
  the tool's remix query. A second upload of the same video by the same person (a line dance
  posted twice) is not another version; list one.

# Output

- The article path, the inferred artist/track and the rule that inferred them, the chosen facets
  (new terms named), the related tracks, the word count.
- The versions listed (kind, by, id), the `--verify` result, and the candidates left out with why.
- The fact-check findings, each with how its source resolved it, and whom you consulted.
- The gate result (`scripts/verify.sh`) and, after the push, the Pages run URL, the live page and
  the `test/e2e/live.cjs` result (every FAIL line verbatim).
