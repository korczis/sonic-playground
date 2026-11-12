---
schema: adr/v1
id: adr-0004
kind: adr
title: Every review is an educational article whose facts live in its front matter
status: proposed
date: 2026-11-12
tags:
  - content
  - education
provenance:
  origin: extracted
  derived_from:
    - session:7e1d03a3-52cc-40aa-a61a-4f9713c27f2a
    - file:data/track.schema.json
    - file:data/concept.schema.json
---

# 4. Every review is an educational article whose facts live in its front matter

## Context

The owner (session `7e1d03a3-52cc-40aa-a61a-4f9713c27f2a`, 2026-11-12): "kazda stranka zaroven musi
byt akademicky / popularne naucny / vzdelavaci prolinkovany clanek pro edukativni / didakticke /
nazorne ucely", "vse musi byt maximalne popsano ve frontmatter, at se da do budoucna linkovat,
inferovat, derivovat, delat dynamicke projekce, systemy, surfaces", "vse musi byt as much as
possible data driven, convention over configuration". The reviews were prose with five facts in
the front matter; nothing a reader could learn from was addressable, and nothing linked a review
to the ideas it shows or to open data.

## Decision

- **The contract grows, the format does not.** `data/track.schema.json` v2 adds the taxonomies
  `concept` and `instrument` and, under `[extra]`, `learning` (level, objectives, a timed
  `listen_for` guide, questions), `sources` (cited, typed), `credits`, `connections` (curated
  links with a reason), `influences`, `samples`, `country`, `bpm`, `key`, `time_signature`,
  `isrc`, `musicbrainz` and `wikidata`. Facets are derived from the schema's taxonomies, so the
  explorer, related tracks, term pages and strings take a new taxonomy without code changes.
- **Concepts are data.** `data/concepts/<slug>.toml` defines each concept once (term, category,
  a definition in every locale, related concepts); each gets a page that explains it and lists
  the tracks that demonstrate it, and the glossary groups them by category. Prose links them
  through the `concept_link` and `track_link` components, which the contract checks.
- **Identifiers are inferred.** `scripts/track.py enrich` asks MusicBrainz (cached, one request
  a second) for the recording, artist and release ids, the ISRC, the artist's country and a
  missing release year; a value a review already has is kept.
- **Pages and projections are derived.** The listening guide seeks the player; references,
  questions, connections, credits and open-data links render from the front matter; schema.org
  `Article` + `LearningResource` + `MusicRecording` is derived into `data/derived/jsonld.json`
  (build-time only, so the browser's catalogue stays lean); `catalog.education` measures the
  corpus, and `x-sonic.edu_required` turns completeness into a requirement.

## Alternatives rejected

- **Educational content in prose only**: unlinkable, unprojectable, the owner's objection.
- **A separate database of facts**: a second source of truth beside the articles.
- **Everything in the browser catalogue**: the explorer would download every source and
  question of every review on the home page.

## Consequences

- Rule `project.educational-article` binds it; the skill add-song and the agent song-writer
  write the layer for every new review, and the existing corpus is enriched in batches.
- A new concept is a new file with every locale's definition, or the contract refuses it.
- `edu_required` is switched on only when `catalog.education.complete` equals the track count.

## Acceptance

Accepted by the owner on 2026-11-12. The question was "ADRs 0001-0005 (static serverless site,
derived catalogue, router + social cards, educational layer, yearbooks) are still marked proposed.
Accept them?", and the answer was "Accept all five" (session
7e1d03a3-52cc-40aa-a61a-4f9713c27f2a). The record is knowledge `owner-answers-2026-11-12`.
