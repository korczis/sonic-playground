#!/usr/bin/env bash
# Off CI, scripts/verify.sh sweeps only the pages a change can affect (a full local sweep of
# 4,400+ pages took 25-37 minutes and once ran the machine out of memory). The set must be right:
# a changed review's pages in both languages, the home pages and its term pages, nothing a file
# the build never reads adds, and a full sweep whenever a change can reach every page. A fixture
# site (the real config.toml, a fabricated catalogue and sitemap) proves --changed-pages, and a
# scratch repository with an origin/main proves the git listing behind --sweep-plan.
set -euo pipefail
# A hook exports an absolute GIT_DIR; the scratch repository must never act on the calling one.
# shellcheck disable=SC2046
unset $(git rev-parse --local-env-vars)
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/changed-pages.XXXXXX")
trap 'rm -rf "$work"' EXIT
site="$work/site"
mkdir -p "$site/scripts" "$site/static/data" "$site/content/pages" "$site/data/concepts" \
  "$site/public"
cp "$root/scripts/verify.sh" "$site/scripts/"
cp "$root/config.toml" "$site/"
cd "$site"
base=$(python3 -c 'import tomllib; print(tomllib.load(open("config.toml", "rb"))["base_url"])')

page() { printf '+++\ntitle = "%s"\n%b+++\nBody.\n' "$1" "${2:-}" > "content/$1"; }
page alpha-song.md; page alpha-song.cs.md
page beta_tune.md; page beta_tune.cs.md
page pages/about.md 'path = "about"\n'; page pages/about.cs.md 'path = "cs/about"\n'
printf 'term = "call and response"\ncategory = "form"\n' > data/concepts/call-and-response.toml
cat > static/data/catalog.json <<'EOF'
{"tracks": [
  {"source": "alpha-song.md", "path": "alpha-song/",
   "facets": {"genre": ["deep house"], "mood": ["Café"], "concept": ["call and response"]}},
  {"source": "beta_tune.md", "path": "beta-tune/", "facets": {"genre": ["rock"]}}
]}
EOF
pages=(
  "" cs/ alpha-song/ cs/alpha-song/ beta-tune/ cs/beta-tune/ about/ cs/about/
  genre/deep-house/ cs/genre/deep-house/ genre/deep-house/page/2/ mood/cafe/ cs/mood/cafe/
  concept/call-and-response/ cs/concept/call-and-response/ genre/rock/ cs/genre/rock/
)
{ echo '<urlset>'
  for p in "${pages[@]}"; do echo "<url><loc>${base%/}/$p</loc></url>"; done
  echo '</urlset>'; } > public/sitemap.xml

fail() { echo "FAIL changed-pages: $1" >&2; exit 1; }
# expect <label> <expected output, one line per page> <changed path>...
expect() {
  local label=$1 want=$2 got
  shift 2
  printf '%s\n' "$@" > "$work/changed"
  got=$(bash scripts/verify.sh --changed-pages public "$work/changed")
  [ "$got" = "$want" ] || { printf 'want:\n%s\ngot:\n%s\n' "$want" "$got" >&2; fail "$label"; }
  echo "ok   changed-pages: $label"
}
homes=$'/\n/cs/'

expect "a changed translation sweeps the review in both languages, the homes and its terms" \
  "$(printf '%s\n' / /alpha-song/ /concept/call-and-response/ /cs/ /cs/alpha-song/ \
    /cs/concept/call-and-response/ /cs/genre/deep-house/ /cs/mood/cafe/ /genre/deep-house/ \
    /mood/cafe/)" content/alpha-song.cs.md
expect "a file name is slugged as Zola slugs it (beta_tune -> beta-tune)" \
  "$(printf '%s\n' / /beta-tune/ /cs/ /cs/beta-tune/ /cs/genre/rock/ /genre/rock/)" \
  content/beta_tune.md
expect "a page with a front matter path is swept at that path" \
  "$(printf '%s\n' / /about/ /cs/ /cs/about/)" content/pages/about.cs.md
expect "a concept sweeps its term pages" \
  "$(printf '%s\n' / /concept/call-and-response/ /cs/ /cs/concept/call-and-response/)" \
  data/concepts/call-and-response.toml
expect "derived data and files the build never reads add nothing beyond the homes" "$homes" \
  README.md test/cases/68_verify_changed_pages.sh .ai/repo/policy.yaml scripts/verify.sh \
  static/data/catalog.json static/data/search.cs.json data/i18n/terms/cs.toml \
  data/spotify/index.json data/derived/jsonld.json
expect "a deleted review adds nothing (check-built catches links to it)" "$homes" \
  content/gone-song.md
for path in templates/base.html styles/app.css static/js/player.js static/css/app.css \
    static/vendor/flowbite.min.js config.toml data/i18n/en.toml scripts/catalog.py \
    package-lock.json data/media.toml; do
  expect "$path sweeps every page" "full: $path can change any page" README.md "$path"
done
page orphan.md
expect "a content file the sitemap lacks sweeps every page" \
  "full: content/orphan.md is no page of the sitemap" content/orphan.md
rm content/orphan.md

# The git listing: committed, unstaged and untracked changes since the merge base with
# origin/main, in a scratch repository whose origin/main is its first commit.
git init -q -b main
git add -A
git -c core.hooksPath=/dev/null -c user.name=case -c user.email=case@example.invalid \
  commit -q -m base
git update-ref refs/remotes/origin/main HEAD
plan() { bash scripts/verify.sh --sweep-plan public 2>&1; }
hint=" (VERIFY_FULL=1 sweeps every page)"
want_line() {
  grep -qxF -- "$2" <<< "$3" || { printf '%s\n' "$3" >&2; fail "$1"; }
  echo "ok   sweep-plan: $1"
}
out=$(plan)
want_line "no change sweeps the homes" \
  "verify: sweep mode changed, 2 page(s) from 0 path(s) changed since $(git rev-parse \
  --short=8 HEAD)$hint" "$out"
printf 'Edited.\n' >> content/beta_tune.cs.md
printf 'More.\n' >> content/pages/about.md
git -c core.hooksPath=/dev/null -c user.name=case -c user.email=case@example.invalid \
  commit -q -am about
out=$(plan)
want_line "a committed and an unstaged change are both listed" "  /cs/beta-tune/" "$out"
want_line "the committed page is listed" "  /cs/about/" "$out"
mkdir -p templates
printf '<html></html>\n' > templates/new.html
want_line "an untracked template sweeps every page" \
  "verify: sweep mode full, templates/new.html can change any page$hint" \
  "$(plan)"
rm -r templates
want_line "VERIFY_FULL=1 sweeps every page" \
  "verify: sweep mode full, VERIFY_FULL=1$hint" \
  "$(VERIFY_FULL=1 plan)"
git update-ref -d refs/remotes/origin/main
want_line "no origin/main sweeps every page" \
  "verify: sweep mode full, no merge base with origin/main$hint" \
  "$(plan)"
