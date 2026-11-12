#!/usr/bin/env bash
# The gate, in the order CI runs it (.github/workflows/ci.yml). It builds the site exactly once,
# with the production base_url, and tests those bytes; CI deploys that same directory.
#   1. scripts/catalog.py --check    content contract; static/data/catalog.json is current
#   2. unit tests and skill cases    inference, contract, engine; add-song end to end, Pro shell
#   3. vendored Flowbite and CSS     static/vendor/ and static/css/app.css are current
#   4. zola build                    production base_url; internal links are errors
#   5. scripts/check-built.py        every same-origin src/href resolves under the site path,
#                                    no raw iframe, every <img> sized, no image over budget
#   6. test/e2e/smoke.cjs            the artefact in a real browser, served as production
#                                    (--artifact <dir> --as <base_url>), desktop and phone
#
#   scripts/verify.sh                   the full gate (the build goes to a temporary directory)
#   scripts/verify.sh --no-browser      steps 1-5 (the pre-push hook)
#   PUBLIC_DIR=public scripts/verify.sh keep the tested build there (CI uploads it)
#   SMOKE_REQUIRED=1                    fail instead of skipping when no browser is available
#   CHROME_PATH=<binary>                the browser for step 6 (default: Playwright's chromium)
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

step "interface strings: every locale complete, every used key defined, bundle current"
python3 scripts/i18n.py --check

step "images: every shown image has current derived variants within the budget"
python3 scripts/images.py --check

step "unit tests"
python3 -m unittest discover -s test -p 'test_*.py'

step "skill cases (test/cases)"
bash test/run.sh

if [ -d node_modules ]; then
  step "types: browser code (tsc --checkJs) and Python (pyright)"
  npx --no-install tsc -p tsconfig.json
  npx --no-install pyright

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

base_url=$(python3 -c 'import tomllib; print(tomllib.load(open("config.toml", "rb"))["base_url"])')
if [ -n "${PUBLIC_DIR:-}" ]; then
  public=$(cd "$(dirname "$PUBLIC_DIR")" && pwd)/$(basename "$PUBLIC_DIR")
else
  public=$(mktemp -d "${TMPDIR:-/tmp}/sonic-public.XXXXXX")
  trap 'rm -rf "$public"' EXIT
fi

step "zola build ($base_url; internal links are errors)"
zola build --force --output-dir "$public"

if [ "$browser" = 1 ]; then
  step "social cards: one 1200x630 preview per page (scripts/og.cjs)"
  set +e
  node scripts/og.cjs "$public"
  og=$?
  set -e
  if [ "$og" = 3 ] && [ "${SMOKE_REQUIRED:-0}" != 1 ]; then
    export CHECK_OG_FILES=0
  elif [ "$og" != 0 ]; then
    exit "$og"
  fi
else
  export CHECK_OG_FILES=0
fi

step "built site: every local URL resolves, every page has a complete social preview"
python3 scripts/check-built.py "$public" "$base_url"

if [ "$browser" = 1 ]; then
  step "browser smoke test on the artefact, served as $base_url"
  set +e
  node test/e2e/smoke.cjs --artifact "$public" --as "$base_url"
  code=$?
  set -e
  if [ "$code" = 3 ] && [ "${SMOKE_REQUIRED:-0}" != 1 ]; then
    echo "verify: smoke test skipped (no playwright-core)"
  elif [ "$code" != 0 ]; then
    exit "$code"
  fi
fi

printf '\nverify: all gates passed\n'
