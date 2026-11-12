#!/usr/bin/env python3
"""Check the built site: every same-origin URL any page or feed references (src, href, srcset,
poster; any quoting; absolute, root-relative or relative, resolved against the page's deployed
URL) is a file of the build under the site path, and no page embeds a raw iframe (videos go
through the video component).

Zola's link checker validates Markdown links to other pages; it does not see raw HTML in the
reviews or attributes the templates compute. This reads what a browser would request.

    python3 scripts/check-built.py <public dir> <base url>     exit 1 on any finding
"""
from __future__ import annotations

import html
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit

URL_ATTRS = {"src", "href", "poster", "data-copy-link"}


class Refs(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.urls: list[str] = []
        self.iframes = 0

    def handle_starttag(self, tag, attrs):
        if tag == "iframe":
            self.iframes += 1
        for name, value in attrs:
            if not value:
                continue
            if name in URL_ATTRS:
                self.urls.append(value)
            elif name == "srcset":
                self.urls += [part.strip().split(" ")[0] for part in value.split(",") if part.strip()]


def page_url(base: str, rel: str) -> str:
    """The URL the page is served at: dir/index.html is dir/."""
    if rel.endswith("index.html"):
        rel = rel[: -len("index.html")]
    return urljoin(base, rel)


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    public = Path(sys.argv[1]).resolve()
    base = sys.argv[2].rstrip("/") + "/"
    site = urlsplit(base)
    prefix = site.path  # e.g. /sonic-playground/
    problems: list[str] = []
    files = sorted(public.rglob("*.html")) + sorted(public.rglob("*.xml"))
    for file in files:
        rel = file.relative_to(public).as_posix()
        text = file.read_text(encoding="utf-8", errors="replace")
        parser = Refs()
        # A feed carries its entries' HTML escaped inside the XML: unescape it to parse it.
        parser.feed(html.unescape(text) if file.suffix == ".xml" else text)
        if parser.iframes and file.suffix == ".html":
            problems.append(f"{rel}: raw <iframe> (use the video component or a link)")
        here = page_url(base, rel)
        for raw in set(parser.urls):
            if raw.startswith(("#", "mailto:", "tel:", "javascript:", "data:")):
                continue
            target = urlsplit(urljoin(here, raw))
            if (target.scheme, target.netloc) != (site.scheme, site.netloc):
                continue  # a third party: not ours to resolve
            path = target.path
            if path == prefix.rstrip("/"):
                path = prefix  # the site root without its slash (feeds link it that way)
            if not path.startswith(prefix):
                problems.append(f"{rel}: {raw} resolves outside the site path {prefix}")
                continue
            local = public / unquote(path[len(prefix):])
            if path.endswith("/") or local.is_dir():
                local = local / "index.html"
            if not local.is_file():
                problems.append(f"{rel}: {raw} does not exist in the build")
    for p in problems:
        print(f"check-built: {p}", file=sys.stderr)
    print(f"check-built: {len(files)} pages and feeds, {len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
