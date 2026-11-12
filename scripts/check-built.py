#!/usr/bin/env python3
"""Check the built site: every same-origin src/href in every page resolves to a built file, and no
page embeds a raw third-party iframe (videos go through the video component).

Zola's link checker validates Markdown links to other pages; it does not see raw HTML in the
reviews or attributes the templates compute. This reads what a browser would request.

    python3 scripts/check-built.py <public dir> <base url>     exit 1 on any finding
"""
from __future__ import annotations

import html
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

ATTR = re.compile(r'\b(?:src|href)="([^"#?]*)(?:[?#][^"]*)?"')
IFRAME = re.compile(r"<iframe\b", re.I)


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    public = Path(sys.argv[1]).resolve()
    base = urlsplit(sys.argv[2].rstrip("/") + "/")
    prefix = base.path  # e.g. /sonic-playground/
    origin = f"{base.scheme}://{base.netloc}"
    problems: list[str] = []
    # Pages and feeds; a feed carries its entries' HTML entity-escaped.
    pages = sorted(public.rglob("*.html")) + sorted(public.rglob("*.xml"))
    for page in pages:
        text = page.read_text(encoding="utf-8", errors="replace")
        if page.suffix == ".xml":
            text = html.unescape(text)
        rel = page.relative_to(public).as_posix()
        if IFRAME.search(text):
            problems.append(f"{rel}: raw <iframe> (use the video component or a link)")
        for url in set(ATTR.findall(text)):
            if url.startswith(origin):
                url = url[len(origin):]
            if not url.startswith("/") or url.startswith("//"):
                continue  # relative, external or protocol-relative: not ours to resolve here
            if url == prefix.rstrip("/"):
                url = prefix  # the site root without its slash (feeds link it that way)
            if not url.startswith(prefix):
                problems.append(f"{rel}: {url} is outside the site path {prefix}")
                continue
            target = public / unquote(url[len(prefix):])
            if url.endswith("/") or target.is_dir():
                target = target / "index.html"
            if not target.is_file():
                problems.append(f"{rel}: {url} does not exist in the build")
    for p in problems:
        print(f"check-built: {p}", file=sys.stderr)
    print(f"check-built: {len(pages)} pages, {len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
