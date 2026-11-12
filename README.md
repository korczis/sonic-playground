# Sonic Playground

A hand-picked music journal: one review per track, explored by genre, feeling and mood, played in
a bottom-bar player that keeps going while you browse.
Live at **https://korczis.github.io/sonic-playground/**.

The site is static and serverless (ADR 0001): Zola builds every page, GitHub Pages serves it, and
everything dynamic runs in the browser over a catalogue the build derives from the articles
(ADR 0002). A router swaps pages under a persistent player, and every page has a social card
rendered from its own data (ADR 0003). The UI is the owner's Flowbite Pro admin shell on
Tailwind 4, in English and Czech, switchable without a reload.

## What derives what

| Source (written) | Derived by | Result |
| --- | --- | --- |
| `content/<artist>-<track>.md` front matter | `scripts/catalog.py` | `static/data/catalog.json` (inferred artist/track, URL, thumbnail, facets, related tracks, review outline, statistics) and `search.json` |
| `data/track.schema.json` | `scripts/catalog.py` (validator) | the content contract every article must meet |
| a YouTube link or "Artist - Track" | `scripts/track.py new` | a new article from `archetypes/track.md` with the derived outline and `data/review.toml` guidance |
| `data/backlog/*.toml` (the owner's playlists and yearbooks) | `scripts/catalog.py`, `scripts/backlog.py` | yearbook pages, counts and each song's years; the songs not reviewed yet, in batches for `/add-song` |
| the owner's Spotify playlists or data export | `scripts/spotify.py` | `data/backlog/yearbook-<year>.toml` (ADR 0005) |
| `data/concepts/<slug>.toml` | `scripts/catalog.py`, templates | the glossary, one page per concept with the tracks that demonstrate it (ADR 0004) |
| the educational front matter of a review | templates, `scripts/catalog.py` | the learning guide (seeking the player), references, connections, credits; `data/derived/jsonld.json` (Article + LearningResource + MusicRecording) |
| MusicBrainz | `scripts/track.py enrich` | recording, artist and release ids, ISRC, country, missing years in `[extra]` |
| `data/videos.json` (written by `scripts/probe-videos.py`) | `scripts/catalog.py` | videos gone from YouTube: no still, no player, the derived artwork |
| `data/i18n/<locale>.toml` | `scripts/i18n.py` | `static/data/i18n.json`; every key proven in every locale and every use |
| every built page | `scripts/og.cjs` (Playwright) | `og/<slug>.png`, the 1200x630 card its Open Graph / X tags name |
| `package.json` pins | `scripts/vendor.mjs`, `npm run css` | self-hosted Flowbite JS and ECharts, `static/css/app.css` |
| `templates/components.html` | Zola 0.23 (Tera 2) | every page: explorer, track, archive, insights, taxonomies, 404 |

## Add a song

In Claude Code: `/add-song <YouTube link | Artist - Track>`. The procedure is the repository skill
`.ai/repo/skills/add-song/SKILL.md`; by hand:

```sh
python3 scripts/track.py resolve "https://youtu.be/<id>"       # infer artist, track, file; exit 3 = exists
python3 scripts/track.py vocab --limit 40                       # existing genres and feelings
python3 scripts/track.py new "https://youtu.be/<id>" --genre ... --sentiment ... --description "..."
# replace every TODO(write) in the new file, then:
python3 scripts/track.py check content/<file>.md
npm run derive && bash scripts/verify.sh
```

Many songs at once: `python3 scripts/backlog.py` lists what the owner's playlists hold and the
journal does not; `--batches N` splits it for N `song-writer` agents (`.claude/agents/`), each
running the same skill.

## Every review teaches

A review is also an educational article (ADR 0004, rule `project.educational-article`): the
concepts it demonstrates (`taxonomies.concept`, defined once in `data/concepts/` in every locale),
a listening guide by part of the song (and by time where sourced, which seeks the player),
objectives, questions, cited sources, credits and open identifiers live in its front matter, and
the page, the concept pages, the glossary and the structured data are derived from them.
`catalog.education` measures the corpus; `x-sonic.edu_required` makes it a requirement.

## Yearbooks

The owner's annual Spotify "Top Songs" playlists become yearbooks (ADR 0005, rule
`project.yearbook-integrity`, skill `import-yearbook`): `scripts/spotify.py` imports them into
`data/backlog/yearbook-<year>.toml`, every item resolves to one review (ISRC, then artist and
song; `review=` / `skip=` from the owner), and the yearbook pages, counts and each song's years
are derived. A song in several years is one page.

```sh
export SPOTIFY_CLIENT_ID=<your Spotify app>   # redirect URI http://127.0.0.1:8765/callback
python3 scripts/spotify.py auth               # once; the token stays outside the repository
python3 scripts/spotify.py discover           # your playlists that name a year
python3 scripts/spotify.py import <playlist> --year 2023 --write
python3 scripts/spotify.py import-export <data export folder> --write
python3 scripts/spotify.py coverage           # per year: present, missing, ambiguous, ...
```

## The player

Every track has the same controls, one effect each (component `track_actions`): **Play** plays
that track now, **Play next** puts it after the current one, the **queue** button adds it or
takes it out again, **Radio** and **Play all** replace the queue and say so; the "⋯" menu on
every card lists them all, labelled. When the queue runs out, autoplay (on by default) plays a
random track. The bar: previous,
play/pause, next, repeat, the queue (reorder, remove, shuffle, clear), a small or large video,
minimise, close. The queue survives navigation and reloads. A locked phone stops any embedded
video; "Open in the YouTube app" hands the queue to an app that keeps playing. Details:
knowledge `player-and-background-playback`.

## Develop

Requirements: Zola (`.zola-version`), Node 22, Python 3.11+ (`.tool-versions`), and
[Majordomus](https://majordomus.dev) for the git hooks.

```sh
npm ci                     # also wires .githooks (core.hooksPath)
npm run dev                # vendor + CSS + catalogue, then zola serve
npm test                   # unit tests (catalogue, engine)
npm run typecheck          # tsc --checkJs over static/js, pyright over scripts/ and test/
bash scripts/verify.sh     # the whole gate CI runs, browser smoke test included
                           # (CHROME_PATH=<local Chrome> without Playwright's chromium)
python3 scripts/probe-videos.py   # which videos disappeared from YouTube (network)
python3 scripts/probe-links.py    # which external links stopped answering (network)
```

`scripts/verify.sh` runs, in order: the content contract (schema, references, one song one
review, prose that names its recording, the minimum length, no stock phrases) and catalogue
currency, the locales,
unit tests, the skill cases (`test/cases/`), type checks, vendored assets and CSS, `zola build`
(internal links are errors), the social cards, the built-site check (every local URL resolves,
every page has complete social tags), and the browser smoke test (every page class, the
explorer, the player on desktop and phone, the router, the locales, and a sweep of every sitemap
page for console errors, warnings and failed requests).

## Deploy

Pushing `main` deploys: `.github/workflows/pages.yml` runs the CI gate (`ci.yml`: conventional
commits, `majordomus doctor`, the gate above), deploys exactly the tested artefact to GitHub
Pages, waits until production serves the commit (`revision.txt`) and runs the smoke test against
production. Every job has a deadline (`test/cases/40_workflow_deadlines.sh`). There is no other
deploy target (rule `project.deploy-gate`). `content-health.yml` probes videos and external links
weekly.

## Repository layout

```
content/            reviews (front matter = the database) and pages/ (welcome, author, archive, insights)
data/               track.schema.json (contract), review.toml, i18n/, backlog/, videos.json
archetypes/         track.md, the template of a new review
templates/          components.html (UI components), partials/ (shell, player), page templates
static/js/          core (modules), router, player, track-menu, explorer, charts, i18n, site (shell)
static/data/        catalog.json, search.json, i18n.json (derived, committed), vendor.json
scripts/            catalog, track, backlog, i18n, og, check-built, check-components, probes, verify
test/               unit tests, cases/ (skill and policy cases), e2e/smoke.cjs (Playwright)
types/              sonic.d.ts (the catalogue, i18n and module API, for tsc --checkJs)
.ai/                Majordomus layer: policy, rules, skills, ADRs, knowledge, workflows
.claude/            Claude Code: the add-song skill and the agents
```

## Licence

Reviews and images: CC BY-SA 4.0. Code: see `LICENSE`.

## AI agents

This repository is supervised by Majordomus. An agent starts at [AGENTS.md](AGENTS.md).
Claude Code subagents (`.claude/agents/`) carry no rules of their own; each serves the `.ai/`
layer:

| Agent | Serves | Use |
| --- | --- | --- |
| `song-writer` | skill `add-song` | a batch of songs from `scripts/backlog.py --batches N` |
| `ui-reviewer` | rules ui-components, ui-localised, console-clean | after a change to templates, scripts or styles |
| `deploy-verifier` | rule deploy-gate | after pushing `main`, or when production looks wrong |
