---
id: project.catalogue-derived
version: 1
kind: rule
title: Everything the site shows about tracks is derived from the articles
description: scripts/catalog.py derives artist, track, URL, thumbnail, facets, related tracks, the review outline and every statistic from the front matter into static/data/catalog.json; templates and browser code read only that file.
statement: Derive every fact the site shows about tracks with scripts/catalog.py into static/data/catalog.json, read it from templates and browser code instead of restating it, never hand-write a count, list or relation, and keep the committed catalogue current (catalog.py --check).
status: active
class: blocking
depends_on: [project.content-contract@1]
tags: [derived, catalogue, data]
x-majordomus:
  tests: [test/test_catalog.py, test/test_track.py]
---

# Rationale

The previous theme showed numbers and lists that drifted from the content, and the article
titles follow three different conventions. One derivation, inferring what it must (artist and
track from title and file name, related tracks from shared facets) and showing how it inferred
it, keeps every surface consistent and lets a new article appear everywhere without a template
change.

# Required behaviour

- `scripts/catalog.py` is the only producer of `static/data/catalog.json` (`sonic-catalog/v1`):
  tracks with their inferred artist/track and the rule used, facets, related tracks with the
  shared terms, the corpus outline, facet counts, genre x feeling pairs, months, artists.
- Templates load it once (`templates/base.html`) and look tracks up by `catalog.lookup`;
  `static/js/` reads the cards' data attributes or the file. No template or script restates a
  number, list or relation the catalogue has.
- Inference is visible: a track page names the rule that inferred its artist.
- The catalogue is committed and current: the pre-commit hook and CI run `--check`.

# Failure behaviour

`python3 scripts/catalog.py --check` exits 1 when the catalogue is stale or an article breaks
the contract; the commit or the deploy stops there.

# Verification

```sh
python3 scripts/catalog.py --check
python3 -m unittest discover -s test -p 'test_*.py'
```
