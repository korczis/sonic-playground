---
id: project.social-preview
version: 1
kind: rule
title: Every page has a complete social preview with its own generated card
description: Each page carries a derived title and description, canonical URL, the full Open Graph and X card tags, and a 1200x630 card rendered at build time from its own data by scripts/og.cjs; scripts/check-built.py refuses a page without them.
statement: Give every page a derived <title>, meta description, canonical link, og:title/description/url/type/site_name/locale/image(+type, width, height, alt) and twitter:card/title/description/image, with og:image pointing at its own card rendered by scripts/og.cjs, and keep scripts/check-built.py and the smoke test's card check green.
status: active
class: blocking
depends_on: [project.deploy-gate@1]
tags: [seo, social, open-graph, deploy]
x-majordomus:
  tests: [scripts/check-built.py, test/e2e/smoke.cjs, scripts/og.cjs]
---

# Rationale

The owner wants every link shared on Facebook, X or anywhere to look good, consistently and always,
and every value derived. A per-page card rendered from the page's own data (a track's still,
artist, track and genres; any other page's title, description and the newest stills) makes each
share specific without a hand-made image.

# Required behaviour

- `templates/base.html` derives the title and description of every page class (track, page,
  taxonomy, term, 404) from its data and the interface strings (`seo.*`), and points `og:image`
  and `twitter:image` at `og/<page path slugified>.<ext>` ("home" for the root), in the format,
  quality and size budget of `data/media.toml` `[social]` (JPEG, `card_kb`), carried to the
  renderer and the template by `static/data/images.json`.
- `scripts/og.cjs` renders one card per sitemap page (and the 404) in the build, in CI before the
  deploy; `scripts/verify.sh` runs it whenever a browser is available.
- `scripts/check-built.py` refuses a page with any of the tags missing or empty, an `og:image`
  that is not an absolute URL of the site or not a file of the build, or `og:image` and
  `twitter:image` that differ.
- The smoke test fetches the home and a track card and checks their bytes are that format, before
  the deploy and in production; `scripts/check-built.py` refuses a card of another extension or over
  `card_kb`.

# Failure behaviour

The gate stops the deploy; the Verify production job fails when a card is not served.

# Verification

```sh
bash scripts/verify.sh
```
