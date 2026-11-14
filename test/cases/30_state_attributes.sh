#!/usr/bin/env bash
# A state flag the browser code writes on <html> (document.documentElement.dataset.X, i.e.
# data-x="…") must not share its name with an attribute that templates or code select elements
# by ([data-x]): the selector would match <html> itself. Twice on 2026-11-12 this broke the site
# (explorer: form lookup hit <html>; i18n: textContent of <html> replaced the whole document).
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
python3 - <<'PY'
import re, sys
from pathlib import Path
js = {p: p.read_text() for p in Path("static/js").glob("*.js")}
flags = set()
for text in js.values():
    for name in re.findall(r"documentElement\.dataset\.([A-Za-z0-9]+)", text):
        flags.add(re.sub(r"([A-Z])", lambda m: "-" + m.group(1).lower(), name))
selected = set()
for text in list(js.values()) + [p.read_text() for p in Path("templates").rglob("*.html")]:
    selected |= set(re.findall(r"\[data-([a-z0-9-]+)(?:[\]=~^$*|])", text))
clash = sorted(flags & selected)
if clash:
    print("FAIL: state flags on <html> also used as element selectors:", ", ".join("data-" + c for c in clash))
    sys.exit(1)
# The same holds for <body>: its data-* attributes carry configuration (the URLs of the derived
# data), and a delegated handler that looks for the closest [data-x] reaches <body> from every
# element. 2026-11-14: <body data-play="…play.json"> made the player treat every click on the page
# as Play and cancel it (the autoplay switch, the queue's controls).
tag = re.search(r"<body\b[^>]*>", Path("templates/base.html").read_text(), re.S)
body = set(re.findall(r"\sdata-([a-z0-9-]+)=", tag.group(0))) if tag else set()
clash = sorted(body & selected)
if clash:
    print("FAIL: attributes on <body> also used as element selectors:", ", ".join("data-" + c for c in clash))
    sys.exit(1)
print(f"ok   state flags on <html> ({len(flags)}) and attributes on <body> ({len(body)}) never collide with element selectors")
PY
