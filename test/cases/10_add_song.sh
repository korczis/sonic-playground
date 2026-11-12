#!/usr/bin/env bash
# majordomus-skill: add-song
# majordomus-skill: translate
# The add-song procedure end to end, offline: resolve a name, refuse a duplicate, write a skeleton
# into a scratch copy of content/, prove the contract refuses it while TODO(write) remains or its
# Czech translation is missing or untranslated, and accepts it once written and translated, and that the catalogue then integrates it with related tracks.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/add-song.XXXXXX")
trap 'rm -rf "$work"' EXIT
cp -R "$root/content" "$root/data" "$root/archetypes" "$root/scripts" "$root/config.toml" "$work/"
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
# Written prose alone is not a review any more (ADR 0004): without the educational layer the
# contract refuses it; with concepts, a learning guide and sources it passes.
if python3 scripts/track.py check "$file" >/dev/null 2>&1; then
  echo "FAIL: a review without the educational layer passed the contract"; exit 1
fi
python3 - "$file" <<'EOF2'
import sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
fm, body = text.split("+++", 2)[1], text.split("+++", 2)[2]
fm = fm.replace('sentiment = ["hypnotic"]', 'sentiment = ["hypnotic"]\nconcept = ["four-on-the-floor"]')
fm += """
[extra.learning]
level = "introductory"
objectives = ["Hear how a steady kick drum anchors a slow-burning track.", "Follow how the arrangement adds layers over the pulse."]
listen_for = [{ part = "the intro", what = "the pulse arrives alone" }, { part = "the middle", what = "pads widen over the kick" }, { part = "the end", what = "the layers fall away again" }]
questions = ["What keeps the track moving when nothing else changes?", "Where does it feel fullest, and why?"]

[[extra.sources]]
title = "Moderat"
url = "https://en.wikipedia.org/wiki/Moderat"
kind = "encyclopedia"

[[extra.sources]]
title = "Moderat discography"
url = "https://www.discogs.com/artist/1121428-Moderat"
kind = "database"
"""
# The written review names its recording and has the contract's length (data/review.toml).
body += "\nModerat let A New Error grow from a single pulse. " + " ".join(f"detail{i}" for i in range(320)) + "\n"
open(path, "w", encoding="utf-8").write("+++" + fm + "+++" + body)
EOF2
python3 scripts/track.py check "$file" >/dev/null
# Every page is bilingual (ADR 0006): the English review alone is refused, its scaffold too, its
# translation is accepted.
if python3 scripts/catalog.py >/dev/null 2>&1; then
  echo "FAIL: a review without its Czech translation passed the contract"; exit 1
fi
python3 scripts/translate.py scaffold "$file" >/dev/null
cs=content/moderat-a-new-error.cs.md
if python3 scripts/translate.py check "$cs" >/dev/null 2>&1; then
  echo "FAIL: an untranslated scaffold passed the contract"; exit 1
fi
python3 - "$cs" <<'EOF3'
import re, sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
_, fm, body = text.split("+++", 2)
n = iter(range(1, 1000))
fm = re.sub(r'TODO\(translate\) [^"]*', lambda m: f"Česká věta číslo {next(n)}, která vysvětluje, jak skladba plyne.", fm)
lines = []
for line in body.replace("TODO(translate)", "").splitlines():
    if line.strip() and not line.startswith(("#", "{{")):
        line = "Skladba Moderat A New Error roste z jediného pulzu, který se nemění. " + "příklad " * (len(line.split()) // 1)
    lines.append(line)
open(path, "w", encoding="utf-8").write("+++" + fm + "+++" + "\n".join(lines) + "\n")
EOF3
python3 scripts/translate.py check "$cs" >/dev/null
python3 scripts/catalog.py >/dev/null
python3 - <<'EOF'
import json
c = json.load(open("static/data/catalog.json"))
t = c["tracks"][c["lookup"]["moderat-a-new-error.md"]]
assert (t["artist"], t["track"]) == ("Moderat", "A New Error"), t
assert t["youtube"] == "dQw4w9WgXcQ"
assert t["related"], "no related tracks"
assert t["langs"] == ["en", "cs"] and t["i18n"]["cs"]["path"] == "cs/moderat-a-new-error/", t["langs"]
print("ok   add-song: skeleton refused until written, taught and translated, then integrated in both languages with",
      len(t["related"]), "related tracks")
EOF
