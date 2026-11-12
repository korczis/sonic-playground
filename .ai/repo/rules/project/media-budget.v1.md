---
id: project.media-budget
version: 1
kind: rule
title: A page shows derived, sized images within the budget, never a source
description: Every local image the content shows (a figure, a review's cover_image) is served as AVIF and WebP variants rendered by scripts/images.py at the widths of data/media.toml; every <img> carries its width and height; no image a built page references weighs more than data/media.toml budget.image_kb.
statement: Show a local image only through the figure component or a card still, both of which read the derived variants (static/data/images.json, written by scripts/images.py from data/media.toml); give every <img> its width and height; keep scripts/images.py --check and scripts/check-built.py green; change widths, formats, qualities or the budget in data/media.toml, never per image.
status: active
class: blocking
depends_on: [project.site-static-serverless@1, project.ui-components@1]
tags: [performance, images, media, quality]
x-majordomus:
  tests: [scripts/images.py, scripts/check-built.py]
---

# Rationale

The baseline measurement of production on 2026-11-12 (10c73fa) found the welcome page moving
5039 kB of images and the author page 3695 kB: illustrations of 1.5-2.2 MB each served as PNG
at full size into a 720 px column, with no width or height, so both pages shifted as they loaded
(CLS 0.098 and 0.095). Review stills (cover_image) of up to 1.4 MB were shown in 160 px cards.
A rule that only advised "optimise images" had nothing to check; this one is a gate.

# Required behaviour

- Sources stay where the content names them (`static/images/…`); they are the input only.
- `scripts/images.py` renders each source the content shows at `data/media.toml` `widths` (a
  narrower source at its own width) in every `formats` entry with its `quality` into
  `static/images/derived/`, and records each in `static/data/images.json` with its intrinsic
  size, the hash of its bytes and of the parameters, and every variant's bytes. It renders only
  what is missing or stale and removes only its own files that nothing references.
- The figure component renders a `<picture>` of every format and width with `width`/`height`;
  `scripts/catalog.py` gives a card the smallest variant at least `card_width` wide.
- Every `<img>` of a built page has `width` and `height` (an image positioned over a box still
  states them: the check cannot tell, and the cost is two attributes).

# Failure behaviour

`scripts/images.py --check` (pre-commit, CI, no encoder needed) refuses a shown source without
variants, a stale manifest (source or parameters changed), a missing or altered variant, a variant
over the budget, an orphan derived file, and a manifest that does not carry the parameters.
`scripts/check-built.py` (CI, after `zola build`) refuses any `<img>` without width and height and
any image a page references that weighs more than `budget.image_kb`, whatever produced it.

# Verification

```sh
python3 scripts/images.py --check
bash scripts/verify.sh     # check-built over every page of the artefact
```
