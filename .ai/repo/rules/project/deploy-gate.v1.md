---
id: project.deploy-gate
version: 1
kind: rule
title: GitHub Pages is the only deploy target, behind the same gate as a merge
description: Pushing main runs pages.yml, which calls ci.yml (commit lint, Majordomus doctor, catalogue, tests, vendored assets, zola build, browser smoke), deploys the validated artefact to GitHub Pages with retry, and verifies production serves the commit.
statement: Deploy only by pushing main to GitHub (origin), let pages.yml deploy the artefact ci.yml validated, and treat a deploy as done only when the Verify production job proves the live site serves the commit and passes the browser smoke test.
status: active
class: blocking
depends_on: [project.site-static-serverless@1]
tags: [deploy, ci, github-pages]
x-majordomus:
  tests: [scripts/verify.sh, test/e2e/smoke.cjs]
---

# Rationale

ADR 0001. Deploys used to go from two CI systems to fly.io without any gate. One path, gated
exactly like a merge and verified against production, makes a green run mean a working site.

# Required behaviour

- `origin` (github.com/korczis/sonic-playground) is the primary remote; `gitlab` is a mirror
  and deploys nothing.
- `.github/workflows/ci.yml` runs on pull requests and branches and is called by
  `pages.yml` for `main`. Zola is pinned by `.zola-version` and a SHA-256 digest, Majordomus by
  `MAJORDOMUS_VERSION`, Node libraries by exact versions.
- `pages.yml` checks the Pages base URL equals `config.toml` `base_url`, deploys the very
  artefact CI built (its `revision.txt` is the commit), retries a hung deployment with a fresh
  artefact, then waits for production to serve the commit and runs `test/e2e/smoke.cjs --url`.
- GitHub Pages builds from the workflow (`build_type: workflow`), never from a branch.

# Failure behaviour

Any failed job stops the chain; a deploy whose production verification fails is reported as
failed, never as done.

# Verification

```sh
bash scripts/verify.sh
gh run list -R korczis/sonic-playground -w Pages -L 1
```
