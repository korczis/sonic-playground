#!/usr/bin/env python3
"""Check the built site: every same-origin URL any page or feed references (src, href, srcset,
poster; any quoting; absolute, root-relative or relative, resolved against the page's deployed
URL) is a file of the build under the site path, and no page embeds a raw iframe (videos go
through the video component). Every <img> has its width and height (nothing shifts as it loads),
and no image a page references weighs more than data/media.toml budget.image_kb (rule
project.media-budget: a page shows derived variants, never a source). Every page has exactly one
<h1>, its title: content headings start at ## (a redirect stub has no <html> and is skipped).
Every page's social card is a .jpg (or the format data/media.toml [social] names) within its
card_kb budget.
Every link and button has an accessible name (its text, an aria-label, aria-labelledby, a title or
an image's alt) or is out of reach entirely (aria-hidden="true" and tabindex="-1": a redundant
link beside the one that carries the name), or sits in a subtree not exposed yet (an ancestor or
itself `hidden` or aria-hidden: the player bar and the explorer's "more" button are filled by the
browser when they appear). WCAG 4.1.2.

Zola's link checker validates Markdown links to other pages; it does not see raw HTML in the
reviews or attributes the templates compute. This reads what a browser would request.

    python3 scripts/check-built.py <public dir> <base url>     exit 1 on any finding
"""
from __future__ import annotations

import html
import os
import sys
import tomllib
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit

URL_ATTRS = {"src", "href", "poster", "data-copy-link"}
# The social cards are rendered by scripts/og.cjs (a browser); without one (the pre-push gate) the
# tags are still checked, the files are not: CHECK_OG_FILES=0.
OG_FILES = os.environ.get("CHECK_OG_FILES", "1") != "0"
MEDIA = tomllib.loads((Path(__file__).resolve().parent.parent / "data" / "media.toml").read_text(encoding="utf-8"))
IMAGE_BYTES = MEDIA["budget"]["image_kb"] * 1024
CARD = MEDIA["social"]
CARD_EXT = "jpg" if CARD["format"] == "jpeg" else CARD["format"]
CARD_BYTES = CARD["card_kb"] * 1024
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}


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
        self.images: list[str] = []
        self.h1 = 0
        self.controls: list[dict] = []   # open <a href> / <button>: their name so far
        self.hidden: list[str] = []      # open elements inside a hidden subtree (hidden, aria-hidden)
        self.unnamed: list[str] = []
        self.unsized: list[str] = []

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        if self.hidden and self.hidden[-1] == tag:
            self.hidden.pop()
        if tag in ("a", "button") and self.controls and self.controls[-1]["tag"] == tag:
            c = self.controls.pop()
            if not c["name"].strip() and not c["hidden"]:
                self.unnamed.append(c["desc"])

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        for c in self.controls:
            c["name"] += data

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "title":
            self.in_title = True
        name = a.get("property") or a.get("name")
        if tag == "meta" and name:
            self.meta[name] = a.get("content") or ""
        if tag == "link" and a.get("rel") == "canonical":
            self.canonical = a.get("href") or ""
        if tag == "iframe":
            self.iframes += 1
        if tag == "h1":
            self.h1 += 1
        concealed = bool(self.hidden) or "hidden" in a or a.get("aria-hidden") == "true"
        if concealed and tag not in VOID:
            self.hidden.append(tag)
        if (tag == "a" and a.get("href") is not None) or tag == "button":
            named = " ".join(filter(None, [a.get("aria-label"), a.get("aria-labelledby"), a.get("title")]))
            hidden = concealed and (a.get("tabindex") == "-1" or len(self.hidden) > 1 or "hidden" in a)
            self.controls.append({"tag": tag, "name": named, "hidden": hidden,
                                  "desc": f"<{tag} {'href=' + (a.get('href') or '')[:60] if tag == 'a' else 'class=' + (a.get('class') or '')[:40]}>"})
        if tag == "img" and a.get("alt"):
            for c in self.controls:
                c["name"] += a["alt"]
        if tag == "img" and not (a.get("width") and a.get("height")):
            self.unsized.append(a.get("src") or "?")
        if tag in ("img", "source"):
            src = a.get("src")
            if src:
                self.images.append(src)
            self.images += [part.strip().split(" ")[0] for part in (a.get("srcset") or "").split(",") if part.strip()]
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
        print((__doc__ or "").strip().splitlines()[-1], file=sys.stderr)
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
            missing = [k for k in SOCIAL if not (parser.meta.get(k) or "").strip()]
            if missing:
                problems.append(f"{rel}: social preview incomplete, missing {', '.join(missing)}")
            if not parser.title.strip() or not parser.canonical:
                problems.append(f"{rel}: no <title> or canonical link")
            for desc in sorted(set(parser.unnamed))[:5]:
                problems.append(f"{rel}: {desc} has no accessible name (text, aria-label, title or an "
                                f"image's alt), and is not hidden as a redundant link")
            if parser.h1 != 1:
                problems.append(f"{rel}: {parser.h1} <h1> elements; a page has exactly one, its title "
                                f"(content starts at ##)")
            image = parser.meta.get("og:image", "")
            if image and image != parser.meta.get("twitter:image"):
                problems.append(f"{rel}: og:image and twitter:image differ")
            if image and not image.startswith(origin + prefix):
                problems.append(f"{rel}: og:image {image} is not an absolute URL of this site")
            elif image and not image.endswith("." + CARD_EXT):
                problems.append(f"{rel}: og:image {image} is not a .{CARD_EXT} card (data/media.toml [social])")
            elif image and OG_FILES:
                card = public / unquote(urlsplit(image).path[len(prefix):])
                if not card.is_file():
                    problems.append(f"{rel}: og:image {image} does not exist in the build (scripts/og.cjs)")
                elif card.stat().st_size > CARD_BYTES:
                    problems.append(f"{rel}: its social card weighs {card.stat().st_size // 1024} kB, over the "
                                    f"budget of {CARD['card_kb']} kB (data/media.toml [social])")
        here = page_url(base, rel)
        if file.suffix == ".html":
            for src in sorted(set(parser.unsized)):
                problems.append(f"{rel}: <img src={src}> has no width and height (the page shifts as it loads)")
            for raw in sorted(set(parser.images)):
                target = urlsplit(urljoin(here, raw))
                if (target.scheme, target.netloc) == (site.scheme, site.netloc) and target.path.startswith(prefix):
                    local = public / unquote(target.path[len(prefix):])
                    if local.is_file() and local.stat().st_size > IMAGE_BYTES:
                        problems.append(f"{rel}: {raw} weighs {local.stat().st_size // 1024} kB, over the budget of "
                                        f"{IMAGE_BYTES // 1024} kB (data/media.toml): show its derived variants")
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
