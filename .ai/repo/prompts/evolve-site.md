---
name: evolve-site
description: study the repository and evolve it toward the serverless, derived, Majordomus-supervised site on GitHub Pages
---

# sonic-playground: Majordomus-supervised, serverless Zola site on GitHub Pages

You are working in `~/dev/sonic-playground` (GitHub `korczis/sonic-playground`, public; `gitlab`
is a secondary mirror). Follow `~/.claude/CLAUDE.md`, `~/dev/CLAUDE.md` and the `flowbite-pro`
skill. Reference implementations: `~/dev/atlas-trideni` (Zola 0.23.4 + Flowbite + Pages,
`.githooks`, vendored libs), `~/dev/kompendium-epistemicke-anihilace` (ci.yml/pages.yml split,
commit lint, Majordomus supervision job, production verification), `~/dev/algoglyph`
(`ui.kit: flowbite-pro` + licence evidence secret).

## Facts established before starting

- HEAD `e32d2ca` ("feat: initial commit", 2024-12-24) replaced the working Zola blog with a
  non-compiling Phoenix stub (`BlogKorczisCom` modules in `sonic_playground` files, Rust NIF with
  a mismatched crate name) and deleted all 113 articles from `content/`. The last complete blog
  is `2efd679`.
- Deploy today: fly.io (`fly.toml`, `Dockerfile`, `.github/workflows/fly-deploy.yml`,
  `.gitlab-ci.yml`), `base_url = https://sonic-playground.fly.dev`. GitHub Pages is already
  enabled in legacy mode from a stale `gh-pages` branch (2024-10-05).
- Templates are a local copy of the Kita theme written for Zola 0.19 (Tera 1); Zola 0.23 rejects
  them (Tera 2 child-template rule, `[markdown.highlighting]`).

## Goals

1. **Drop Elixir/Phoenix/Rust NIF/fly.io entirely.** The site is static and serverless.
2. **Restore all article sources** from `2efd679:content/` (sources only, never built `public/`).
3. **Zola 0.23.4**, pinned in `.zola-version`, installed in CI with a SHA-256 check.
4. **UI rebuilt on Flowbite Pro** (Tailwind 4 + `flowbite` 4, vendored and self-hosted, no CDN):
   Pro shell (navbar with search + theme toggle, sidebar drawer of derived facets, page header with
   breadcrumb, cards), dark mode via the `color-theme` contract, accessible, phone-width clean.
5. **Extracted components**: one partial/macro per UI unit (track card, facet badge list, video
   embed, page header, stat card, empty state), no duplicated markup between templates.
6. **Serverless but fully functional, generic, derived, inferred** — everything computed from
   front matter at build time or in the browser, nothing hand-maintained:
   - a derived catalogue `catalog.json` rendered by Zola from every page (title, artist, track,
     date, taxonomies, youtube id, thumbnail, reading time, url);
   - client-side faceted explorer (genre x sentiment x mood x tag, text search, sort), state in
     the URL so every view is linkable;
   - inferred relations: "related tracks" by weighted taxonomy overlap (Jaccard), facet
     co-occurrence, inferred artist/track split from the title, stats page derived from the
     catalogue;
   - Zola's search index for full-text search; atom feeds per taxonomy.
7. **Majordomus, used fully**: `majordomus init` (shared mode, tracked `.ai/repo/`),
   `majordomus update` projections (CLAUDE.md/AGENTS.md/GEMINI.md), `.githooks/` (pre-commit
   doctor, pre-push finish --check + site check, commit-msg lint), enforcement declared in policy,
   `ui.kit: flowbite-pro` with `publish: [public]`, then retrospectively enrich `.ai/repo/` with
   project rules (zola engine, flowbite-pro UI, derived surfaces, content front matter contract,
   serverless-only, deploy gate), skills (add a track, release/deploy), workflows (content, deploy),
   knowledge, an ADR for the Elixir -> static migration, features, deployment record. Run the work
   under `majordomus start` / `check` / `finish`, record decisions with `majordomus decision`.
8. **Rigid deploy to GitHub Pages**: `ci.yml` (commit lint, Majordomus supervision, content
   contract check, vendor check, Zola build with link check, Playwright smoke + axe-free DOM
   assertions) called by `pages.yml` (configure-pages, base URL parity, upload, deploy-pages with
   retry, then "production serves this commit" via `revision.txt` and a smoke test). Switch Pages
   from legacy `gh-pages` to the `workflow` build type via `gh api`. Remove fly/gitlab deploys.
9. **Verify everything**: local `zola build`, the content check, `majordomus doctor`, the e2e smoke
   in a local browser (Chrome via claude-in-chrome) on desktop and phone width, light and dark;
   after push, the CI run, the deployment, and production in the browser.

## Constraints

- Conventional commits with scope, Claude co-author footer; branch `feature/github-pages` in
  worktree `~/dev/sonic-playground-wt/feature/github-pages`, merged `--no-ff` into `main`, then
  pushed to `origin` (GitHub) - pushing `main` is the deploy.
- Never publish Flowbite Pro source files verbatim; adapt markup.
- The licence evidence secret `MAJORDOMUS_KIT_EVIDENCE_FLOWBITE_PRO` must be set by the owner
  (`~/.claude/skills/flowbite-pro/evidence.sh secret | gh secret set ... -R korczis/sonic-playground`).
- Report faithfully: what was verified, what was not, and why.
