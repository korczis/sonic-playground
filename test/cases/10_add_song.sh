#!/usr/bin/env bash
# majordomus-skill: add-song
# The add-song procedure end to end, offline: resolve a name, refuse a duplicate, write a skeleton
# into a scratch copy of content/, prove the contract refuses it while TODO(write) remains and
# accepts it once written, and that the catalogue then integrates it with related tracks.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/add-song.XXXXXX")
trap 'rm -rf "$work"' EXIT
cp -R "$root/content" "$root/data" "$root/archetypes" "$root/scripts" "$work/"
mkdir -p "$work/static/data" && cp -R "$root/static/data/." "$work/static/data/"
cp -R "$root/static/images" "$work/static/images"
cd "$work"

python3 scripts/track.py resolve "Bakermat - The River" --offline >/dev/null && {
  echo "FAIL: an existing track was not reported"; exit 1; } || [ $? = 3 ]

python3 scripts/track.py new "Moderat - A New Error" --offline \
  --youtube "https://youtu.be/dQw4w9WgXcQ" --genre electronic techno --sentiment hypnotic \
  --date 2026-01-02 --description "A slow-burning electronic piece with a hypnotic pulse." >/dev/null
file=content/moderat-a-new-error.md
[ -f "$file" ] || { echo "FAIL: $file not written"; exit 1; }

if python3 scripts/catalog.py >/dev/null 2>&1; then
  echo "FAIL: an unfinished skeleton passed the contract"; exit 1
fi

sed -i.bak 's/TODO(write): /Written prose. /' "$file" && rm -f "$file.bak"
python3 scripts/track.py check "$file" >/dev/null
python3 scripts/catalog.py >/dev/null
python3 - <<'EOF'
import json
c = json.load(open("static/data/catalog.json"))
t = c["tracks"][c["lookup"]["moderat-a-new-error.md"]]
assert (t["artist"], t["track"]) == ("Moderat", "A New Error"), t
assert t["youtube"] == "dQw4w9WgXcQ"
assert t["related"], "no related tracks"
print("ok   add-song: skeleton refused until written, then integrated with",
      len(t["related"]), "related tracks")
EOF
