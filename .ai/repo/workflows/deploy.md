# Deploying

There is one deploy path (rule `project.deploy-gate`, ADR 0001): merge to `main` and push to
`origin` (GitHub). Nothing else deploys; `gitlab` is a mirror.

| Step | Run |
|---|---|
| the work is on a feature branch in its worktree | `majordomus worktree` |
| the local gate passes | `bash scripts/verify.sh` (the pre-push hook runs it without the browser) |
| the task's finish contract holds | `majordomus finish --check` |
| merge | in the primary checkout on `main`: `git merge --no-ff feature/<name>` |
| deploy | `git push origin main` |
| watch | `gh run watch -R korczis/sonic-playground $(gh run list -R korczis/sonic-playground -w Pages -L 1 --json databaseId -q '.[0].databaseId')` |
| proof | the `Verify production` job is green: production serves the commit (`revision.txt`) and passes `test/e2e/smoke.cjs --url` |
| re-run a hung Pages deploy | `gh workflow run pages.yml -R korczis/sonic-playground` |

## One-time setup (done 2026-11-12)

- Pages builds from the workflow: `gh api -X PUT repos/korczis/sonic-playground/pages -f build_type=workflow`.
- The owner sets the licence evidence secret (an agent may not write secrets):
  `~/.claude/skills/flowbite-pro/evidence.sh secret | gh secret set MAJORDOMUS_KIT_EVIDENCE_FLOWBITE_PRO -R korczis/sonic-playground`.
