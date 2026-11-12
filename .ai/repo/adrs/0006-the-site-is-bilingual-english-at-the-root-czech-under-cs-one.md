---
schema: adr/v1
id: adr-0006
kind: adr
title: The site is bilingual: English at the root, Czech under /cs/, one source of facts
status: proposed
date: 2026-11-12
tags:
  - i18n
  - content
provenance:
  origin: extracted
  derived_from:
    - file:config.toml
    - file:data/i18n
    - session:7e1d03a3-52cc-40aa-a61a-4f9713c27f2a
---

# 6. The site is bilingual: English at the root, Czech under /cs/, one source of facts

## Context

On 2026-11-12 the owner asked for the whole site to be bilingual: every page, every term, every
description and every review in Czech and English, with an automatic language selector, all of it
tested. Until then only the interface was bilingual: `data/i18n/<locale>.toml`, switched in the
browser by `static/js/i18n.js` over pages Zola built in English. The 70 glossary definitions had a
Czech text; the 284 reviews (about 312,000 words), the four pages, the section pages and the 326
taxonomy terms did not.

## Decision

- Zola's own multilingual model: English is the default language at the root, unchanged; Czech is
  `[languages.cs]` and lives under `/cs/`. A page's translation is the file beside it, `<name>.cs.md`
  (`_index.cs.md` for a section), so every URL has its counterpart at `/cs/<same path>`.
- One source of facts. A Czech review holds only what is language: its title, description, body,
  the learning guide's objectives, listening notes and questions, and the reason for each connection.
  Everything else (video, ISRC, credits, release, sources, the derived catalogue) stays in the English
  file, and the Czech page reads it from there (`get_page(path=..., lang="en")`). Its date and
  taxonomies are the English file's, written by `scripts/translate.py` and refused by the contract
  when they differ.
- Terms keep one identity. A taxonomy term is the same key in both languages (`/genre/deep-house/`,
  `/cs/genre/deep-house/`); its Czech label is data (`data/i18n/terms.cs.toml`, and `[cs] term` of a
  glossary concept), and every term in use must have one.
- A translation records the English text it translates (`extra.translation.of`, a hash of the English
  prose); when the English changes, the contract reports the translation stale. A review is complete
  only in both languages, so `add-song` writes both.
- The language selector links each page to its counterpart. On a first visit with no stored choice,
  a browser that prefers Czech is taken to the Czech counterpart; an explicit choice is remembered and
  always wins. Interface strings follow the language of the page being shown, including after a
  router navigation under the persistent player.
- Both languages are tested: the contract (every page translated, current, structurally equal to its
  English page; every term labelled), the built-site check and the browser sweep over every URL of
  both languages.

## Alternatives rejected

- Client-side translation of English pages (the previous interface switch extended to content): a
  Czech page would not exist for search engines, social cards or links, and every review would have to
  ship both texts to every reader.
- A Czech copy of the whole front matter: every fact twice, edited in two places, which the derived
  catalogue exists to prevent (ADR 0002).
- Czech term slugs (`/cs/zanr/hluboky-house/`): two identities for one term, and every derived
  relation (related tracks, yearbooks, facets) would need a mapping.
- Machine translation at build time: no review of the text, and a dependency on a service the static
  site must not have (ADR 0001).

## Consequences

- The site has twice as many pages; build, social cards and the sweep take about twice as long.
- Every review change now owes its Czech counterpart, and `scripts/catalog.py --check` refuses a stale
  or missing translation.
- The catalogue gains a per-language layer for what readers see (title, description, URL); facts are
  not duplicated.
- Song and album titles, artist names and quoted titles stay as published; genre names that Czech
  uses as loanwords (house, techno, drum and bass) stay as they are.
