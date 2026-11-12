---
id: project.site-static-serverless
version: 1
kind: rule
title: The site is static and serverless, and fully functional in the browser
description: Zola builds every page at deploy time; every dynamic behaviour runs in the browser over data the build derived. No server, database or runtime process exists.
statement: Ship the site only as a static Zola build on GitHub Pages and implement every interactive behaviour (explorer, search, random track, video) as browser code over static/data/catalog.json, so a page works fully from the static files alone and degrades to a complete server-rendered page without JavaScript.
status: active
class: blocking
depends_on: [project.catalogue-derived@1]
tags: [site, architecture, serverless]
x-majordomus:
  tests: [test/e2e/smoke.cjs, scripts/verify.sh]
---

# Rationale

ADR 0001. The repository carried a Phoenix application that never compiled, a Rust NIF and a
fly.io machine for what is a static music journal. Every part of the product is computable from
the articles at build time; a server adds cost, an attack surface and a failure mode, and buys
nothing a reader can see.

# Required behaviour

- No server-side code, container, database or long-running process in the repository; no
  deploy target but GitHub Pages (`project.deploy-gate`).
- Interactivity is progressive enhancement: the server-rendered page is complete (every card in
  the explorer, every related track, every facet link) and `static/js/*.js` only filters, sorts,
  plays and navigates over what is already there or in `static/data/catalog.json`.
- State a reader can share lives in the URL (`?q=&genre=&sentiment=&mood=&sort=`).
- Third-party requests are limited to YouTube stills and the youtube-nocookie player on demand;
  every library is vendored and self-hosted (`scripts/vendor.mjs`).

# Failure behaviour

A change that adds a runtime dependency on a server, or breaks a page without JavaScript, is
reworked before it merges; `test/e2e/smoke.cjs` fails on a console error, a failed same-origin
request or a broken explorer.

# Verification

```sh
bash scripts/verify.sh            # build + browser smoke (CHROME_PATH=<chrome> locally)
```
