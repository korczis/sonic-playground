---
schema: knowledge/v1
id: console-clean-by-construction
kind: knowledge
class: lesson
title: "A page must load with zero console errors, warnings and failed requests; each cause found so far, and the gate that now refuses it"
description: "When a browser console shows anything on the site, when adding a page type, a taxonomy, a video or a third-party resource, or when the smoke test's sweep fails."
status: verified
epistemics: observed
date: 2026-11-12
tags:
  - testing
  - console
  - deploy
provenance:
  origin: authored
---

# A page must load with zero console errors, warnings and failed requests

## What was observed (2026-11-12)

| Symptom in the console | Root cause | Prevention now in force |
| --- | --- | --- |
| `main.css`, `theme.svg`, `favicon.ico`: `ERR_NAME_NOT_RESOLVED`; unstyled page (owner's screenshot of production) | The legacy `gh-pages` build had `base_url = korczis.github.com` (a domain that does not exist) and Pages served that branch | Pages builds from the workflow only (ADR 0001); `pages.yml` checks the Pages base URL equals `config.toml`; `check-built.py` refuses any same-origin URL outside `/sonic-playground/` |
| 45 x `Permissions policy violation: compute-pressure`, 15 x `Too many active WebGL contexts` | The legacy pages embedded every YouTube player as a raw `<iframe>` at load | Videos are a facade (`video` component): a still and a button; the youtube-nocookie player is created on click. `catalog.py` and `check-built.py` refuse raw iframes |
| `GET https://i.ytimg.com/vi/<id>/hqdefault.jpg 404` (6 videos) | Videos removed from YouTube; their stills 404 on every list that shows them | `probe-videos.py --write` records them in `data/videos.json`; `catalog.py` then shows the derived artwork and a note, never requests the still; the weekly `Content health` run fails while the file is stale |
| `GET /sonic-playground/tags/ 404` from `sitemap.xml` | A taxonomy declared in `config.toml` that no article uses: Zola lists it in the sitemap but renders no page | The `tags` taxonomy was removed; the sweep loads every sitemap URL, so any repeat fails the deploy gate |
| Images `/images/...` 404 under `/sonic-playground/` | Root-absolute URLs in reviews and templates | `figure` component; the contract refuses root-absolute URLs in reviews |
| `Unrecognized feature: 'web-share'` (CI's Linux Chromium only; local Chrome knows it) | The `allow` list of the YouTube iframe (ours, then the IFrame API's own) named a feature that browser does not implement; CI stopped the deploy of 08ae614 | The player builds the iframe itself with `allow="autoplay; encrypted-media; picture-in-picture; fullscreen"` and attaches the API to it; run the smoke test locally without `CHROME_PATH` to use the same Chromium as CI |

Third-party noise the site cannot change (YouTube's player logging CORS errors for its own ad
beacons inside its iframe, after a click) is reported as a notice, never hidden as a pass.

## The gate

`test/e2e/smoke.cjs` fails on any console error or warning of the site's own frame, any uncaught
exception, any failed request of the site or of a YouTube still. Its sweep loads every URL of
`sitemap.xml` (533 pages), scrolls each to the end so lazy images load, and requires zero
findings. It runs on the artefact before deploy (`--artifact --as`, CI) and against production
after deploy (`--url`, cache-busted with `REVISION`). Rule `project.console-clean` makes it
blocking.

## How to apply

Reproduce with `CHROME_PATH=<chrome> bash scripts/verify.sh` (or `SMOKE_SWEEP=0` for the fast
pass while iterating). A new finding gets a row here: symptom, root cause, the gate that now
refuses it.
