---
schema: knowledge/v1
id: content-defects-found-by-the-contract
kind: knowledge
class: lesson
title: "The restored reviews carried placeholder ids, broken images and LLM template stubs; the contract caught 22 defects"
description: "When adding or editing reviews, or when a video tile shows the placeholder instead of a still."
status: verified
epistemics: observed
date: 2026-11-12
tags:
  - content
  - contract
  - youtube
provenance:
  origin: authored
---

# The restored reviews carried placeholder ids, broken images and LLM template stubs; the contract caught 22 defects

## What was observed

The first run of `scripts/catalog.py` over the 113 articles restored from `2efd679` reported 22
contract violations (2026-11-12):

- Video ids that were template placeholders (`sample-video-id`, `your-video-id`), one truncated to
  10 characters (`tubbe-in-berlin.md`) and one doubled (`feist-my-man-my-mood.md`).
- One article (`c2c-feat-pigeon-john-because-of-you.md`) with a full social-card stub from the old
  prompt: `og_*`, `twitter_*`, `schema_org_type`, an `og_audio` on `example.com` and an `og_image`
  on `yourwebsite.com`.
- Five `cover_image` paths to files that never existed (one with a trailing space).
- One title with no artist that could not be inferred (`lulu-rouge-lulu-theme.md`), fixed with
  `extra.artist`.

Fixes kept the owner's prose untouched: placeholder video lines became commented-out lines marked
`TODO(owner)`, missing covers were dropped (the YouTube still is derived instead), the stub keys
were removed.

Separately, `scripts/probe-videos.py` found 6 videos removed from YouTube (their stills answer 404):
`chicks-on-speed-euro-trash-girl`, `inigo-montoya-es`, `freeland-under-control`,
`the-horroris-one-night-in-nyc`, `vitalic-cocaine`, `timo-maas-shifter`. The site shows the
placeholder tile for them (`static/js/site.js`); the weekly `Content health` workflow keeps naming
them until the owner replaces the ids.

## How to apply

Never fill an unknown fact with a placeholder; leave it out or mark it `TODO(owner)` in a comment.
Start new reviews with `scripts/track.py new`, which writes only inferred values.
