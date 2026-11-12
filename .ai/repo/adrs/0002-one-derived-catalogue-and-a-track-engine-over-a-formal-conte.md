---
schema: adr/v1
id: adr-0002
kind: adr
title: One derived catalogue and a track engine over a formal content contract
status: accepted
date: 2026-11-12
tags:
  - content
  - derived
provenance:
  origin: authored
  derived_from:
    - file:data/track.schema.json
    - file:scripts/track.py
---

# 2. One derived catalogue and a track engine over a formal content contract

## Context

The reviews were written from three prompt files (`PROMPT.md`, `prompts/prompt.md`,
`scripts/prompt_template.txt`) and a `creator.sh` that called an LLM with a fixed template and a
random Unsplash image. The result: titles in three conventions ("Artist - Track", "Track | Artist",
"Track - Artist"), placeholder video ids and `example.com` URLs in published front matter, cover
images that did not exist, and a theme whose counts and lists were written by hand. The owner asked
(session `7e1d03a3-52cc-40aa-a61a-4f9713c27f2a`, 2026-11-12): "vse formalizuj", "vse extrahuj do
templates", and "chci jednim skill /add-song [LINK|NAZEV] vytvorit dynamicky infered/derived/
integrated/updated stranku pro song stejne jako soucasne, analyzuj soucasnou implementaci, zobecni,
vytvor engine, sablony, tooling".

## Decision

- **Contract.** `data/track.schema.json` (JSON Schema 2020-12) is the one definition of a review's
  front matter. `scripts/catalog.py` validates every article against it with a small generic
  validator, plus what a schema cannot say (calendar date, existing images, local links, placeholder
  hosts, unfinished `TODO(write)` sections).
- **Derivation.** `scripts/catalog.py` derives `static/data/catalog.json` (`sonic-catalog/v1`):
  inferred artist and track with the rule used (the file name starts with the artist), URL,
  thumbnail (cover or YouTube still), facets, related tracks by weighted Jaccard similarity with the
  shared terms, the review outline the corpus shares (sections in at least 30 % of reviews, in their
  usual order), and every statistic. Templates and browser code read only this file.
- **Engine.** `scripts/track.py` turns a YouTube link (oEmbed title and channel) or "Artist - Track"
  into a new article: identity and duplicate detection, facet normalisation against the vocabulary
  with nearest-term suggestions, a related-tracks preview, and `archetypes/track.md` filled with the
  derived outline and the guidance of `data/review.toml`. The prose is the writer's, through the
  skill `add-song` (`/add-song` in Claude Code).
- **Templates.** UI markup lives in Tera 2 components (`templates/components.html`).

## Alternatives rejected

- **Generate the prose with an API call in a script** (the old `creator.sh`). Unsourced text,
  invented facts, a key in the environment; the skill researches and writes with a person's review.
- **Infer facets automatically.** Genre and feeling are judgement; the engine proposes the
  vocabulary and the nearest terms, the writer decides.
- **Normalise every title to one convention.** Rewrites the owner's published titles; inference
  with the file name as the tie-breaker reads all three conventions correctly.
- **A database or a headless CMS.** Contradicts ADR 0001; the front matter is the database.

## Consequences

- An article that breaks the contract or carries a `TODO(write)` cannot be committed or deployed.
- A new section the corpus starts to share appears in the outline of new reviews by itself;
  `data/review.toml` only adds guidance for it.
- `static/data/catalog.json` is committed and must be regenerated (`npm run derive`) with every
  content change; the pre-commit hook and CI refuse a stale one.

## Acceptance

Accepted by the owner on 2026-11-12. The question was "ADRs 0001-0005 (static serverless site,
derived catalogue, router + social cards, educational layer, yearbooks) are still marked proposed.
Accept them?", and the answer was "Accept all five" (session
7e1d03a3-52cc-40aa-a61a-4f9713c27f2a). The record is knowledge `owner-answers-2026-11-12`.
