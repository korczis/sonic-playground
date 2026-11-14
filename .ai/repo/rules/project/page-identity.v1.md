---
id: project.page-identity
version: 1
kind: rule
title: Every page is its own canonical URL and its language counterparts name it back
description: A built page's canonical link is its own URL (page 2 of a listing included), and every hreflang counterpart it names exists and names it in return, the same page of a listing in the other language.
statement: Derive a page's canonical from the URL it is served at, never from the term or section it belongs to; name as a counterpart the same page under the other language's prefix; keep scripts/check-built.py green.
status: active
class: blocking
depends_on: [project.ui-localised@1, project.social-preview@1]
tags: [seo, i18n, quality]
x-majordomus:
  tests: [scripts/check-built.py]
---

# Rationale

A second independent review (Codex, 2026-11-14) found that every later page of a listing named
the listing's first page as its canonical. That tells a search engine to drop the tracks of
pages 2 and up: 116 pages in the build. Their language counterparts also pointed at page 1, so a
language switch on page 3 landed on page 1, and hreflang was not reciprocal. Every review exists
in both languages, so a term has the same pages in each.

# Required behaviour

- `templates/base.html` gives a taxonomy term page the canonical `current_url`, the page it is.
- A taxonomy page names as its counterpart the same path, page included, under the other
  language's prefix, when that language has the term.

# Failure behaviour

`scripts/check-built.py` refuses a page whose canonical is not its own URL, and a counterpart
that does not name the page back. On the build before the fix it reported 116 canonicals and
the matching non-reciprocal counterparts (348 problems).

# Verification

```sh
bash scripts/verify.sh
```
