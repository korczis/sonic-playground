# Sonic Playground

A hand-picked music journal: one review per track, explored by genre, feeling and mood.
Live at **https://korczis.github.io/sonic-playground/**.

The site is static and serverless (ADR 0001): Zola builds every page, GitHub Pages serves it, and
everything dynamic runs in the browser over a catalogue the build derives from the articles
(ADR 0002). The UI is the owner's Flowbite Pro admin shell on Tailwind 4.

## What derives what

| Source (written) | Derived by | Result |
| --- | --- | --- |
| `content/<artist>-<track>.md` front matter | `scripts/catalog.py` | `static/data/catalog.json`: inferred artist/track, URL, thumbnail, facets, related tracks, review outline, statistics |
| `data/track.schema.json` | `scripts/catalog.py` (validator) | the content contract every article must meet |
| a YouTube link or "Artist - Track" | `scripts/track.py new` | a new article from `archetypes/track.md` with the derived outline and `data/review.toml` guidance |
| `package.json` pins | `scripts/vendor.mjs`, `npm run css` | self-hosted Flowbite JS, `static/css/app.css` |
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

## Develop

Requirements: Zola (`.zola-version`), Node 22, Python 3.11+ (`.tool-versions`), and
[Majordomus](https://majordomus.dev) for the git hooks.

```sh
npm ci                     # also wires .githooks (core.hooksPath)
npm run dev                # vendor + CSS + catalogue, then zola serve
npm test                   # unit tests (catalogue, engine)
bash scripts/verify.sh     # the whole gate CI runs, browser smoke test included
                           # (CHROME_PATH=<local Chrome> without Playwright's chromium)
python3 scripts/probe-videos.py   # which videos disappeared from YouTube (network)
```

## Deploy

Pushing `main` to GitHub deploys: `.github/workflows/pages.yml` runs the CI gate
(`ci.yml`: conventional commits, `majordomus doctor`, catalogue, tests, vendored assets,
`zola build`, browser smoke), deploys that artefact to GitHub Pages and verifies production serves
the commit. There is no other deploy target (rule `project.deploy-gate`).

## Repository layout

```
content/            reviews (front matter = the database) and pages/ (welcome, author, archive, insights)
data/               track.schema.json (contract), review.toml (section guidance)
archetypes/         track.md, the template of a new review
templates/          components.html (UI components), partials/ (shell), page templates
static/js/          site.js (shell, video, random track), explorer.js (facets, search, sort, URL state)
static/data/        catalog.json (derived, committed), vendor.json
scripts/            catalog.py, track.py, probe-videos.py, vendor.mjs, verify.sh, lint-commits.sh
test/               unit tests, e2e/smoke.cjs (Playwright)
.ai/                Majordomus layer: policy, rules, skills, ADRs, knowledge
```

## Licence

Reviews and images: CC BY-SA 4.0. Code: see `LICENSE`.

## AI agents

This repository is supervised by Majordomus. An agent starts at [AGENTS.md](AGENTS.md).
