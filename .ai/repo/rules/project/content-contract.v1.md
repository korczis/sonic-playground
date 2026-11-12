---
id: project.content-contract
version: 1
kind: rule
title: Every track review satisfies the formal front-matter contract
description: data/track.schema.json is the one contract of an article; catalog.py validates it plus calendar dates, existing images, resolvable local links, no placeholder hosts and no unfinished sections; the file name starts with the artist.
statement: Write every review as content/<slug(artist track)>.md whose front matter validates against data/track.schema.json, with no placeholder values and no TODO(write) left, and add new reviews through scripts/track.py (skill add-song) rather than by copying an old file.
status: active
class: blocking
depends_on: []
tags: [content, contract, schema]
x-majordomus:
  tests: [test/test_catalog.py, test/test_track.py]
---

# Rationale

The restored articles carried placeholder video ids (`sample-video-id`, `your-video-id`), a
truncated id, a doubled id, social-card stubs pointing at `example.com` and five cover images
that did not exist. A schema with a validator in the build turns each of those into a build
error instead of a broken page.

# Required behaviour

- Front matter: `title`, `date` (YYYY-MM-DD, a real date), `description` (40+ characters),
  `taxonomies.genre` and `taxonomies.sentiment` (lower-case, unique terms), optional `mood`,
  `tags`, `extra.youtube` (embed URL with an 11-character id), `extra.cover_image` (a file under
  `static/images/`), `extra.artist`/`track`/`album`/`publisher`/`release_year`/`video_duration`.
  Nothing else (`additionalProperties: false`).
- The file name is the slug of "artist track", artist first: the artist inference relies on it.
- An unknown fact is left out, never filled with a placeholder; an unknown video id is a
  commented-out line with `TODO(owner)`.
- `scripts/track.py new` is how an article starts; its `TODO(write)` markers must all be
  replaced before the article can be committed.

# Failure behaviour

`scripts/catalog.py` names the file and the violated constraint and exits 1; the pre-commit hook
refuses the commit.

# Verification

```sh
python3 scripts/catalog.py --check
python3 scripts/track.py check content/<file>.md
```
