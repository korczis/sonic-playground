#!/usr/bin/env bash
# majordomus-skill: fleet-flowbite-pro
# The UI is the Flowbite Pro shell built from components: the shell landmarks exist, Flowbite JS is
# self-hosted (no CDN), every page template composes components, no component is duplicated,
# dead or undefined, no markup is duplicated between templates (scripts/check-components.py),
# and the owner's verifier passes where it is installed.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
fail() { echo "FAIL: $1"; exit 1; }

grep -q 'aside id="sidebar"' templates/partials/sidebar.html || fail "Pro sidebar drawer missing"
grep -q 'data-drawer-toggle="sidebar"' templates/partials/nav.html || fail "drawer toggle missing"
grep -q "vendor.libs.flowbite.js" templates/base.html || fail "Flowbite JS not self-hosted"
if grep -rqE 'cdn\.|unpkg\.com|jsdelivr' templates static/js; then fail "a CDN reference"; fi
for t in index page pages archive insights taxonomy_list taxonomy_single; do
  grep -q '{{ <' "templates/$t.html" || fail "templates/$t.html composes no component"
done
python3 scripts/check-components.py >/dev/null || { python3 scripts/check-components.py; fail "components"; }
if [ -f "$HOME/.claude/skills/flowbite-pro/verify.mjs" ]; then
  node "$HOME/.claude/skills/flowbite-pro/verify.mjs" . >/dev/null || fail "flowbite-pro verify.mjs"
fi
echo "ok   ui: Pro shell, self-hosted Flowbite, components unique, used and not duplicated"
