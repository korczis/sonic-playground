#!/usr/bin/env bash
# The gate, in the order CI runs it (.github/workflows/ci.yml). It builds the site exactly once,
# with the production base_url, and tests those bytes; CI deploys that same directory.
#   1. scripts/catalog.py --check    content contract; static/data/catalog.json is current
#      scripts/spotify_history.py    the Spotify records: valid, current, nothing private (ADR 0007)
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
#   SMOKE_SHARD=k/n                     step 6 sweeps only its n-th of the sitemap (CI's site job)
#
# Off CI (CI unset) step 6 sweeps only the pages the change can affect: every page of a content
# file changed since the merge base with origin/main (committed, staged, unstaged or untracked) in
# both languages, the home pages and the term pages of its facets; a change that can reach every
# page (templates, styles, static/js, config.toml, interface strings, a build script, any path not
# classified below) sweeps all of them, and so does VERIFY_FULL=1. CI always sweeps everything.
#   scripts/verify.sh --changed-pages <public dir> <file listing changed paths>
#                                       print that set (one /path per line) or "full: <reason>"
#   scripts/verify.sh --sweep-plan <public dir>
#                                       dry run: the mode and pages this checkout's sweep would
#                                       visit for a site built there; no gate, no browser
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

# The pages of the built site (<public dir>/sitemap.xml) a list of changed repository paths can
# affect, or "full: <reason>" when one of them can affect any page. Paths are classified from
# the most specific: content -> its pages; a concept -> its term pages; derived data and files the
# build never reads -> nothing of their own; anything else -> full.
changed_pages() {
  python3 - "$1" "$2" <<'EOF'
import json, re, sys, tomllib, unicodedata
from pathlib import Path

public, listing = Path(sys.argv[1]), Path(sys.argv[2])
base = tomllib.load(open("config.toml", "rb"))["base_url"].rstrip("/") + "/"
locs = re.findall(r"<loc>([^<]+)</loc>", (public / "sitemap.xml").read_text())
site = {loc[len(base):] for loc in locs if loc.startswith(base)}
catalog = json.loads(Path("static/data/catalog.json").read_text())
tracks = {t["source"]: t for t in catalog["tracks"]}
# Derived from content in the same change (the catalogue, the search and player indexes, term
# labels, the Spotify records, JSON-LD, the backlog), or never read by the build.
QUIET = re.compile(r"static/data/(catalog|search|search\.cs|play|i18n)\.json$"
                   r"|data/(i18n/terms|spotify|backlog|derived)/"
                   r"|(test|\.ai|\.github|\.githooks|\.claude|types)/|[^/]+\.md$|LICENSE$"
                   r"|\.gitignore$|scripts/verify\.sh$|(tsconfig|pyrightconfig)\.json$")


def slug(term):
    """Zola's slug of a term or file name: ASCII, lower case, other runs of characters '-'."""
    ascii_ = unicodedata.normalize("NFKD", term).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_.lower()).strip("-")


def page_path(file):
    """The site path Zola gives a content file: its front matter path, else its place."""
    if file.exists():
        front = file.read_text().split("+++")[1]
        m = re.search(r'^path\s*=\s*"([^"]*)"', front, re.M)
        if m:
            return (m.group(1).strip("/") + "/").lstrip("/")
    rel = str(file.relative_to("content"))[: -len(".md")]
    lang = "cs/" if rel.endswith(".cs") else ""
    rel = rel.removesuffix(".cs").removesuffix("_index")
    return lang + "".join(slug(part) + "/" for part in rel.split("/") if part)


def full(reason):
    print(f"full: {reason}")
    sys.exit(0)


def terms(kind, names):
    for name in names:
        yield from (f"{kind}/{slug(name)}/", f"cs/{kind}/{slug(name)}/")


pages = {"", "cs/"}
for path in sorted({line.strip() for line in listing.read_text().splitlines() if line.strip()}):
    if path.startswith("content/") and path.endswith(".md"):
        stem = path.removesuffix(".md").removesuffix(".cs")
        for sibling in (Path(stem + ".md"), Path(stem + ".cs.md")):
            if page_path(sibling) in site:
                pages.add(page_path(sibling))
            elif sibling.exists():
                full(f"{sibling} is no page of the sitemap")
        track = tracks.get(stem.removeprefix("content/") + ".md")
        for kind, names in (track or {}).get("facets", {}).items():
            pages.update(t for t in terms(kind, names) if t in site)
    elif re.fullmatch(r"data/concepts/[^/]+\.toml", path):
        name = Path(path).stem
        if Path(path).exists():
            name = tomllib.loads(Path(path).read_text()).get("term", name)
        pages.update(t for t in terms("concept", [name]) if t in site)
    elif not QUIET.match(path):
        full(f"{path} can change any page")
for page in sorted(pages & site):
    print("/" + page)
EOF
}

# The sweep step 6 runs off CI for the built site in $1: sets sweep_mode, prints it with the pages,
# and for a changed-pages sweep exports SMOKE_PATHS_FILE (a file removed when verify exits).
plan_sweep() {
  if [ "${VERIFY_FULL:-0}" = 1 ]; then
    sweep_mode="full, VERIFY_FULL=1"
  elif [ -n "${SMOKE_PATHS_FILE:-}" ]; then
    sweep_mode="the paths SMOKE_PATHS_FILE lists"
  elif merge_base=$(git merge-base HEAD origin/main 2>/dev/null); then
    scope=$(mktemp -d "${TMPDIR:-/tmp}/sonic-scope.XXXXXX")
    trap 'rm -rf "$scope" ${public_tmp:+"$public_tmp"}' EXIT
    { git -c core.quotePath=false diff --name-only --no-renames "$merge_base" --
      git -c core.quotePath=false ls-files --others --exclude-standard; } > "$scope/changed"
    changed_pages "$1" "$scope/changed" > "$scope/pages"
    if grep -q '^full: ' "$scope/pages"; then
      sweep_mode="full, $(sed 's/^full: //' "$scope/pages")"
    else
      export SMOKE_PATHS_FILE="$scope/pages"
      sweep_mode="changed, $(wc -l < "$scope/pages" | tr -d ' ') page(s) from $(wc -l \
        < "$scope/changed" | tr -d ' ') path(s) changed since ${merge_base:0:8}"
    fi
  else
    sweep_mode="full, no merge base with origin/main"
  fi
  echo "verify: sweep mode $sweep_mode (VERIFY_FULL=1 sweeps every page)"
  if [ -n "${scope:-}" ] && [ "${SMOKE_PATHS_FILE:-}" = "$scope/pages" ]; then
    sed -n "1,${SWEEP_LIST_MAX:-20}s/^/  /p" "$scope/pages"
    [ "$(wc -l < "$scope/pages")" -le "${SWEEP_LIST_MAX:-20}" ] || echo "  ..."
  fi
}

browser=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-browser) browser=0 ;;
    --changed-pages)
      [ "$#" -eq 3 ] || { echo "verify: --changed-pages <public dir> <paths file>" >&2; exit 2; }
      changed_pages "$2" "$3"
      exit 0 ;;
    --sweep-plan)
      [ "$#" -eq 2 ] || { echo "verify: --sweep-plan <public dir>" >&2; exit 2; }
      SWEEP_LIST_MAX=100000 plan_sweep "$2"
      exit 0 ;;
    *) echo "verify: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

# Every step reports how long the one before it took, and the end prints the profile: a slow gate
# is profiled before anyone raises a bound or skips a step.
step_name=""; step_start=$SECONDS; profile=""
step_done() {
  if [ -n "$step_name" ]; then profile="$profile$(printf '%5ss  %s' $((SECONDS - step_start)) "$step_name")\n"; fi
}
step() { step_done; step_name="$1"; step_start=$SECONDS; printf '\n== %s\n' "$1"; }

step "catalogue: content contract and currency"
python3 scripts/catalog.py --check

step "spotify history: records valid, nothing private committed (ADR 0007)"
python3 scripts/spotify_history.py --check

step "interface strings: every locale complete, every used key defined, bundle current"
python3 scripts/i18n.py --check

step "images: every shown image has current derived variants within the budget"
python3 scripts/images.py --check

step "unit tests"
python3 -m unittest discover -s test -p 'test_*.py'

step "skill cases (test/cases)"
bash test/run.sh

if [ -d node_modules ]; then
  # Every later step reads the installed toolchain: a checkout whose node_modules predates its
  # package-lock.json (a merged dependency) fails here with the fix, not later with a stack trace.
  step "toolchain: node_modules matches package-lock.json"
  if ! npm ls --depth=0 >/dev/null 2>&1; then
    npm ls --depth=0 2>&1 | grep -E 'missing|invalid|ERR' | head -5 >&2 || true
    echo "verify: node_modules does not match package-lock.json; run npm ci" >&2
    exit 1
  fi

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
  public_tmp=$public
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

# Off CI, the sweep of step 6 covers what the change can affect (the header says how).
sweep_mode=""
if [ "$browser" = 1 ] && [ -z "${CI:-}" ]; then
  step "changed pages: what the change since origin/main can affect"
  plan_sweep "$public"
fi

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

step_done
printf '\nverify: profile (seconds per step, %ss in all)\n%b' "$SECONDS" "$profile"
[ -z "$sweep_mode" ] || printf '\nverify: browser sweep mode %s\n' "$sweep_mode"
printf '\nverify: all gates passed\n'
