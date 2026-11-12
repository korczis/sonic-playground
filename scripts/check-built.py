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
import os
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit

URL_ATTRS = {"src", "href", "poster", "data-copy-link"}
# The social cards are rendered by scripts/og.cjs (a browser); without one (the pre-push gate) the
# tags are still checked, the files are not: CHECK_OG_FILES=0.
OG_FILES = os.environ.get("CHECK_OG_FILES", "1") != "0"


# Every page carries a complete social preview (rule project.social-preview).
SOCIAL = ["og:title", "og:description", "og:url", "og:image", "og:image:width", "og:image:height",
          "og:image:alt", "og:type", "og:site_name", "twitter:card", "twitter:title",
          "twitter:description", "twitter:image", "description"]


class Refs(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.urls: list[str] = []
        self.iframes = 0
        self.meta: dict[str, str] = {}
        self.canonical = ""
        self.in_title = False
        self.title = ""

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False

    def handle_data(self, data):
        if self.in_title:
            self.title += data

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "title":
            self.in_title = True
        if tag == "meta" and (a.get("property") or a.get("name")):
            self.meta[a.get("property") or a.get("name")] = a.get("content") or ""
        if tag == "link" and a.get("rel") == "canonical":
            self.canonical = a.get("href") or ""
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
    origin = f"{site.scheme}://{site.netloc}"
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
        if file.suffix == ".html" and "<html" in text[:300]:
            missing = [k for k in SOCIAL if not parser.meta.get(k, "").strip()]
            if missing:
                problems.append(f"{rel}: social preview incomplete, missing {', '.join(missing)}")
            if not parser.title.strip() or not parser.canonical:
                problems.append(f"{rel}: no <title> or canonical link")
            image = parser.meta.get("og:image", "")
            if image and image != parser.meta.get("twitter:image"):
                problems.append(f"{rel}: og:image and twitter:image differ")
            if image and not image.startswith(origin + prefix):
                problems.append(f"{rel}: og:image {image} is not an absolute URL of this site")
            elif image and OG_FILES:
                card = public / unquote(urlsplit(image).path[len(prefix):])
                if not card.is_file():
                    problems.append(f"{rel}: og:image {image} does not exist in the build (scripts/og.cjs)")
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
