---
id: project.educational-article
version: 1
kind: rule
title: Every review is also an educational article, described in its front matter
description: A review teaches named concepts (defined once in data/concepts/), carries a timed listening guide, objectives, discussion questions, cited sources, credits and open identifiers in its front matter; everything that links, explains or projects them is derived, and the contract checks every reference.
statement: Describe each review's educational layer in its front matter per data/track.schema.json v2 (taxonomies.concept, extra.learning, extra.sources, extra.credits, extra.musicbrainz and the rest), define every concept in data/concepts/<slug>.toml with a definition in every locale, link concepts and other reviews in prose only through the concept_link and track_link components, and keep scripts/catalog.py (references, completeness) and the tests green.
status: active
class: blocking
depends_on: [project.content-contract@1, project.catalogue-derived@1, project.ui-localised@1]
tags: [content, education, derived, schema]
x-majordomus:
  tests: [scripts/catalog.py, test/test_catalog.py, test/test_track.py, test/e2e/smoke.cjs]
---

# Rationale

The owner (2026-11-12): every page must also be an academic, popular-science, educational and
interlinked article, and everything must be described in the front matter so it can be linked,
inferred, derived and projected later. A fact written once in the front matter feeds the page,
the concept pages, the structured data and any future surface; a fact written in prose feeds
nothing.

# Required behaviour

- `data/track.schema.json` (v2) describes the educational fields; `data/concept.schema.json` one
  concept. `scripts/catalog.py` refuses: a concept in `taxonomies.concept` or a
  `{{ <concept_link name="…" /> }}` that `data/concepts/` does not define; a linked concept that is not in
  the review's `taxonomies.concept`; a `{{ <track_link source="…" /> }}` or `extra.connections` entry that
  names no review; a concept without a definition in every locale of `data/i18n/`.
- `catalog.education` measures how many reviews have each part; `x-sonic.edu_required = true`
  makes every part required, and is switched on once every review has them.
- `scripts/track.py new` writes the required section "Concepts in Focus" (data/review.toml);
  `scripts/track.py enrich` fills the identifiers MusicBrainz knows.
- Structured data (`Article` + `LearningResource` + `MusicRecording`) is derived into
  `data/derived/jsonld.json`; concept pages, the glossary, the listening guide, references and
  connections are derived from the front matter by the templates.

# Failure behaviour

The catalogue check fails, so the pre-commit hook and the gate refuse the change.

# Verification

```sh
python3 scripts/catalog.py --check && python3 -m unittest discover -s test -p 'test_*.py'
```
