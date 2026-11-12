---
schema: skill/v1
id: translate
version: 1
title: Translate a page or a review into Czech
description: Write the Czech counterpart of an English page (content/<name>.cs.md) through scripts/translate.py, so it holds only language, mirrors the English page's structure, translates its current text and passes the translation contract.
status: active
tags: [i18n, content, czech]
inputs:
  - an English page or review (content/<name>.md), or a batch from scripts/translate.py batches N
outputs:
  - content/<name>.cs.md per page, checked by python3 scripts/translate.py check
---
# Purpose

Every page of the site exists in English and in Czech (ADR 0006). A translation holds only what
is language: title, description, body, the learning guide's texts and the reason of each
connection. Every fact (video, ISRC, credits, release, sources) stays in the English file and the
Czech page reads it from there. The contract (`scripts/translation.py`, run by
`scripts/catalog.py --check`) refuses a translation that is missing, stale, structurally different
from its English page, or not Czech. Not for writing a new review (skill `add-song`, which ends by
running this one) or for the interface strings (`data/i18n/cs.toml`).

# When to use

For a page or review without its Czech counterpart, one the contract reports stale (its English
text changed: translate the change, then `bless`), or a batch of `scripts/translate.py batches N`.

# Procedure

1. **Scaffold.** `python3 scripts/translate.py scaffold content/<name>.md` writes
   `content/<name>.cs.md`: the date, taxonomies, structure and the English text it translates
   (`extra.translation.of`) filled in, every text still English and marked `TODO(translate)`,
   every `concept_link` and `track_link` naming `lang="cs"`. It never overwrites a translation.
2. **Translate in place.** Replace every English text and remove every `TODO(translate)`:
   `description`, each `extra.connections[].why`, each `extra.learning` objective, listening note
   (`part`, `what`; keep `at` as it is) and question, and the body. Keep the `title` as published
   when it is "Artist - Track" or a song title; translate a page's title.
3. **Decline terms with `text=`.** A `concept_link` shows the concept's Czech name in the
   nominative. Where the sentence needs another case, give the inflected form:
   `{{ <concept_link name="falsetto" text="falzetem" lang="cs" /> }}`; never twist a sentence to
   fit the nominative.
4. **Keep the structure.** The same headings, in order (translated; the table below), the same
   components with the same `name`/`source`/`id`/`src`, each `concept_link` and `track_link` with
   `lang="cs"` as its last attribute. A heading or a component more or less is refused.
5. **Keep the facts.** Translate, never add, drop or soften a claim. Names, numbers, dates, chart
   positions, labels, awards and places are the English page's. A sentence that is interpretation
   in English stays interpretation.
6. **Check.** `python3 scripts/translate.py check content/<name>.cs.md` until it reports
   0 problems. Do not run `npm run derive`, `catalog.py` without `--check`, or any git command while
   others translate in the same worktree: the integrator derives and commits.
7. **A stale translation** (the English changed): translate what changed, then
   `python3 scripts/translate.py bless content/<name>.cs.md`, then check.

# Czech style

- Natural, educated Czech of popular-science music journalism: precise, readable, not literal.
  Translate meaning and rhythm, not word order; split or join sentences when Czech reads better.
- Song, album and artist names, labels and the titles of English works stay as published. A book,
  film or series with an established Czech title takes it (Where the Wild Things Are: Max a
  divočina); otherwise the original. Quoted lyric fragments stay in the original language, at most
  a few words, with a Czech gloss when the meaning matters; never translate or add lyrics.
- Terms: a genre, feeling, instrument or concept named in prose takes its label from
  `data/i18n/terms/cs.toml` (concepts: `[cs] term` of `data/concepts/<slug>.toml`), declined as
  Czech needs (house, techno and the other loanwords decline normally: "v house", "technem").
- Music vocabulary: skladba, píseň, singl, album, sloka, refrén, most (bridge), úvod, závěr,
  gradace (build-up), drop, beat, groove, riff, hook, basová linka, syntezátor, bicí, sampl,
  smyčka (loop), aranžmá, produkce, nahrávka, verze (radio edit: rádiová verze; extended mix:
  prodloužená verze; remix stays remix).
- Typography: Czech quotation marks „…“, a non-breaking reading of ordinals ("75. místo"),
  "2010s" as "2010s" or "léta 2010–2019" never "2010-tky".
- The reader is addressed with "vy" (formal plural), as the English addresses "you".

# Headings

| English | Czech |
| --- | --- |
| Genre and Mood | Žánr a nálada |
| Song Summary | O skladbě |
| Musical Breakdown | Hudební rozbor |
| Concepts in Focus | Pojmy v centru pozornosti |
| Artistic Context | Umělecký kontext |
| Impact and Reception | Ohlas a dopad |
| Intro / Verse 1 / Verse 2 / Chorus / Bridge | Úvod / Sloka 1 / Sloka 2 / Refrén / Most |
| Build-up / Climax / Breakdown / Drop / Outro | Gradace / Vyvrcholení / Breakdown / Drop / Závěr |
| Main Section | Hlavní část |
| Conclusion / Cultural Impact / Overall Vibe | Závěrem / Kulturní dopad / Celková nálada |
| Sound Breakdown / Lyrics Breakdown / Lyrical Themes | Rozbor zvuku / Rozbor textu / Témata textu |
| About the Artist(s) / Music Video / Legacy | O interpretovi (O interpretech) / Videoklip / Odkaz |

A heading with a subtitle ("Bridge: A Moment of Reflection") keeps its form: "Most: chvíle
zamyšlení".

# Output

`content/<name>.cs.md` per page, each passing `python3 scripts/translate.py check`; the integrator
then runs `npm run derive` and `bash scripts/verify.sh` and commits.
