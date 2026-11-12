#!/usr/bin/env bash
# majordomus-skill: fleet-flowbite-pro
# The UI is the Flowbite Pro shell built from components: the shell landmarks exist in the
# templates, Flowbite JS is self-hosted (no CDN), every page template composes components, and the
# owner's verifier passes where it is installed.
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
for c in track_card track_row facet_badges video stat_card page_header ranked_terms empty_state icon; do
  grep -q "{% component $c(" templates/components.html || fail "component $c missing"
done
if [ -f "$HOME/.claude/skills/flowbite-pro/verify.mjs" ]; then
  node "$HOME/.claude/skills/flowbite-pro/verify.mjs" . >/dev/null || fail "flowbite-pro verify.mjs"
fi
echo "ok   ui: Pro shell, self-hosted Flowbite, every page composed of components"
