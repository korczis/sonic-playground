---
id: project.console-clean
version: 1
kind: rule
title: Every page loads with zero console errors, warnings and failed requests
description: The browser smoke test sweeps every sitemap URL of the artefact before deploy and of production after it; any console error or warning of the site, uncaught exception or failed request of the site or of a YouTube still fails the gate.
statement: Keep every page of the site free of console errors, console warnings, uncaught exceptions and failed requests, prove it with the sitemap sweep of test/e2e/smoke.cjs before and after every deploy, and record each new root cause with its prevention in knowledge console-clean-by-construction.
status: active
class: blocking
depends_on: [project.deploy-gate@1, project.site-static-serverless@1]
tags: [testing, console, deploy, quality]
x-majordomus:
  tests: [test/e2e/smoke.cjs, scripts/check-built.py]
---

# Rationale

The owner's first look at the deployed site was a console full of resolution failures, permission
violations and WebGL warnings. A console that is clean only by luck regresses with the next
taxonomy, video or template; a console that is clean by construction is checked on every page,
every deploy.

# Required behaviour

- Nothing the site does logs an error or a warning: no failed request of the site, no missing
  asset, no uncaught exception, no request to a YouTube still that no longer exists
  (`data/videos.json`, `scripts/probe-videos.py --write`).
- Third-party content loads only on the reader's action (the video facade); what it logs inside
  its own frame is reported as a notice, never counted as a pass of the site.
- A new root cause is documented in `.ai/repo/knowledge/curated/console-clean-by-construction.md`
  with the gate that now refuses it, in the same change that fixes it.

# Failure behaviour

`test/e2e/smoke.cjs` exits 1 and names the page and the message; CI does not deploy, or the
Verify production job fails the deploy.

# Verification

```sh
CHROME_PATH=<chrome> bash scripts/verify.sh          # artefact, 533 pages swept
node test/e2e/smoke.cjs --url https://korczis.github.io/sonic-playground/   # production
```
