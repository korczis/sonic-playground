---
schema: adr/v1
id: adr-0001
kind: adr
title: Static Zola site on GitHub Pages replaces the Phoenix app and fly.io
status: proposed
date: 2026-11-12
tags:
  - architecture
  - deploy
provenance:
  origin: extracted
  derived_from:
    - commit:e32d2ca
    - file:.github/workflows/pages.yml
---

# 1. Static Zola site on GitHub Pages replaces the Phoenix app and fly.io

## Context

Sonic Playground is a hand-picked music journal: 114 reviews with front matter, no accounts, no
writes from readers. Until `e32d2ca` (2024-12-24) it was a Zola site on a copy of the Kita theme
(Zola 0.19), deployed to fly.io by a Docker image from two CI systems (GitHub Actions and GitLab CI).
That commit replaced it with a Phoenix scaffold that never compiled (modules `BlogKorczisCom*` in
`sonic_playground*` files, a Rust NIF whose crate name did not match) and deleted every article and
the built site, so HEAD could not deploy anything. Zola 0.23 (Tera 2) also rejects the old templates.

The owner asked (session `7e1d03a3-52cc-40aa-a61a-4f9713c27f2a`, 2026-11-12), verbatim excerpts:
"chytre a efektivne prejit na githhub pages, without for elixir", "vse deploynout na github pages",
"zrigidnit deploy", "byt serverless, ale plne funkcni", and "push everything to GitHub (from now on
the primary deploy target)".

## Decision

- The site is a static Zola 0.23.4 build (pinned by `.zola-version` and a SHA-256 digest in CI).
  Phoenix, the NIF, Docker, fly.io and GitLab CI are removed; the 113 articles are restored from
  `2efd679` (sources only).
- GitHub (`origin`) is the primary remote and GitHub Pages the only deploy target, built from the
  workflow (`build_type: workflow`), not from the legacy `gh-pages` branch.
- `pages.yml` deploys only what `ci.yml` validated (the same gate as a merge: commit lint,
  `majordomus doctor`, catalogue contract, unit tests, vendored assets, `zola build` with internal
  links as errors, a Playwright smoke test), retries a hung Pages deployment with a fresh artefact,
  and verifies production serves the commit (`revision.txt`) and passes the smoke test.
- Every interactive behaviour runs in the browser over data derived at build time (ADR 0002).
- The UI is rebuilt on the owner's Flowbite Pro admin shell (Tailwind 4, flowbite 4, self-hosted).

## Alternatives rejected

- **Finish the Phoenix app.** A server for read-only content: cost, an attack surface and a
  runtime to keep alive, for no behaviour a static build cannot give.
- **Keep fly.io serving the static build** (static-web-server image). A second platform, a token
  to manage and no production verification; GitHub Pages is free, already enabled and next to the
  code.
- **Deploy from the `gh-pages` branch** (legacy Pages). Commits build output to git and cannot
  gate a deploy on CI.
- **Stay on Zola 0.19 with the Kita templates.** A dead template engine and a theme the owner's
  Flowbite Pro rule replaces anyway.

## Consequences

- No server-side behaviour is possible; anything dynamic must be derivable at build time or run
  in the browser (`project.site-static-serverless`).
- The live URL moves to `https://korczis.github.io/sonic-playground/`; the fly.io app
  `sonic-playground` is no longer deployed and can be removed by the owner.
- A deploy is done only when the Verify production job passes (`project.deploy-gate`).
- CI needs the `MAJORDOMUS_KIT_EVIDENCE_FLOWBITE_PRO` secret (the repository is public and
  declares the Flowbite Pro kit). It was set on 2026-11-12T01:32:35Z by the agent from
  `~/.claude/skills/flowbite-pro/evidence.sh secret` on the owner's instruction, verbatim:
  "zkopiruj si a uloz sam z jineho ~/dev repo" (session `7e1d03a3-52cc-40aa-a61a-4f9713c27f2a`).
- Pages builds from the workflow since 2026-11-12. The legacy `gh-pages` branch and the fly.io
  app `sonic-playground` were left in place; removing them is the owner's call.

## Acceptance

Accepted by the owner on 2026-11-12. The question was "ADRs 0001-0005 (static serverless site,
derived catalogue, router + social cards, educational layer, yearbooks) are still marked proposed.
Accept them?", and the answer was "Accept all five" (session
7e1d03a3-52cc-40aa-a61a-4f9713c27f2a). The record is knowledge `owner-answers-2026-11-12`.
