#!/usr/bin/env bash
# The local gate, in the order CI runs it (.github/workflows/ci.yml):
#   1. scripts/catalog.py --check    content contract; static/data/catalog.json is current
#   2. unit tests and skill cases    inference, contract, engine; add-song end to end, Pro shell
#   3. vendored Flowbite and CSS     static/vendor/ and static/css/app.css are current
#   4. zola build                    internal links are errors (config.toml [link_checker])
#   5. test/e2e/smoke.cjs            every page class in a real browser, desktop and phone
#
#   scripts/verify.sh                 the full gate
#   scripts/verify.sh --no-browser    steps 1-4 (the pre-push hook)
#   SMOKE_REQUIRED=1 scripts/verify.sh   fail instead of skipping when no browser is available (CI)
#   CHROME_PATH=<binary>              the browser for step 5 (default: Playwright's chromium)
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
browser=1
for arg in "$@"; do
  case "$arg" in
    --no-browser) browser=0 ;;
    *) echo "verify: unknown argument $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n== %s\n' "$1"; }

step "catalogue: content contract and currency"
python3 scripts/catalog.py --check

step "unit tests"
python3 -m unittest discover -s test -p 'test_*.py'

step "skill cases (test/cases)"
for case in test/cases/*.sh; do
  bash "$case"
done

if [ -d node_modules ]; then
  step "vendored libraries and CSS are current"
  node scripts/vendor.mjs --check
  css=$(mktemp)
  npx --no-install tailwindcss --input styles/app.css --output "$css" --minify >/dev/null 2>&1
  if ! cmp -s "$css" static/css/app.css; then
    rm -f "$css"
    echo "verify: static/css/app.css is stale; run npm run css" >&2
    exit 1
  fi
  rm -f "$css"
else
  step "vendored libraries and CSS: skipped (no node_modules; run npm ci)"
fi

port=${VERIFY_PORT:-18790}
public=$(mktemp -d "${TMPDIR:-/tmp}/sonic-public.XXXXXX")
trap 'rm -rf "$public"' EXIT
step "zola build (internal links are errors)"
zola build --force --base-url "http://127.0.0.1:${port}" --output-dir "$public"

if [ "$browser" = 1 ]; then
  step "browser smoke test"
  set +e
  node test/e2e/smoke.cjs "$public" "$port"
  code=$?
  set -e
  if [ "$code" = 3 ] && [ "${SMOKE_REQUIRED:-0}" != 1 ]; then
    echo "verify: smoke test skipped (no playwright-core)"
  elif [ "$code" != 0 ]; then
    exit "$code"
  fi
fi

printf '\nverify: all gates passed\n'
