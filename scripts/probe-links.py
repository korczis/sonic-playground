#!/usr/bin/env python3
"""Probe every external link the reviews and pages make (network; never part of the deploy gate).

Internal links are proved offline on every build (Zola's link checker, scripts/check-built.py);
external ones can only be proved by asking the web, which changes on its own. This asks every
http(s) URL of content/: the links of the bodies and every URL of the front matter (the cited
sources, extra.sources[].url, are most of them; extra.youtube is probe-videos.py's), and reports
the ones that do not answer, so a dead or invented
link (two were found on 2026-11-12: codecandflexor.com, northernlite.com/remix) is fixed instead
of shipped. Runs weekly in .github/workflows/content-health.yml, beside probe-videos.py.

    python3 scripts/probe-links.py           report; exit 1 when a link is dead
    python3 scripts/probe-links.py --json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LINK = re.compile(r"\]\((https?://[^)\s]+)\)|href=\"(https?://[^\"]+)\"")
FRONT = re.compile(r"\A\+\+\+\r?\n(.*?)\r?\n\+\+\+\r?\n?(.*)\Z", re.S)
# Front matter keys whose URLs another probe owns.
OWNED_ELSEWHERE = {"extra.youtube"}  # scripts/probe-videos.py
# Hosts that refuse automated requests while serving people; asked, but a 403/429 is not "dead".
# juno.co.uk answers 403 to every automated request, its home page included (2026-11-15).
GUARDED = ("discogs.com", "x.com", "twitter.com", "instagram.com", "facebook.com", "juno.co.uk")


def guarded(url: str) -> bool:
    """The URL's host is a guarded host or one of its subdomains (not merely a string that
    contains one: dropbox.com is not x.com, nor is a path that mentions discogs.com)."""
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    return any(host == h or host.endswith("." + h) for h in GUARDED)


def front_urls(value: object, key: str = "") -> list[str]:
    """Every http(s) string of a parsed front matter, with the dotted key it sits under."""
    if isinstance(value, dict):
        return [u for k, v in value.items() for u in front_urls(v, f"{key}.{k}" if key else k)]
    if isinstance(value, list):
        return [u for v in value for u in front_urls(v, key)]
    if isinstance(value, str) and re.match(r"https?://", value) and key not in OWNED_ELSEWHERE:
        return [value]
    return []


def links(root: Path = ROOT) -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    for path in sorted((root / "content").rglob("*.md")):
        text = path.read_text(encoding="utf-8")
        match = FRONT.match(text)
        front, rest = (match.group(1), match.group(2)) if match else ("", text)
        where = path.relative_to(root).as_posix()
        for url in front_urls(tomllib.loads(front)) if front else []:
            found.setdefault(url, []).append(where)
        body = "\n".join(l for l in rest.splitlines() if not l.startswith("[//]: #"))
        for a, b in LINK.findall(body):
            found.setdefault(a or b, []).append(where)
    return found


def probe(url: str) -> int:
    headers = {"User-Agent": "Mozilla/5.0 (sonic-playground link probe)"}
    for method in ("HEAD", "GET"):
        try:
            request = urllib.request.Request(url, method=method, headers=headers)
            with urllib.request.urlopen(request, timeout=20) as response:
                return response.status
        except urllib.error.HTTPError as exc:
            if method == "HEAD" and exc.code in (403, 405, 501):
                continue
            return exc.code
        except (urllib.error.URLError, TimeoutError, ValueError):
            if method == "HEAD":
                continue
            return 0
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    found = links()
    with ThreadPoolExecutor(max_workers=8) as pool:
        codes = dict(zip(found, pool.map(probe, found)))
    dead = {u: c for u, c in codes.items()
            if (c == 0 or c >= 400) and not (c in (403, 429) and guarded(u))}
    if args.json:
        print(json.dumps({"probed": len(found), "dead": [{"url": u, "status": c, "in": found[u]}
                                                         for u, c in sorted(dead.items())]}, indent=1))
    else:
        for url, code in sorted(dead.items()):
            print(f"dead ({code or 'unreachable'}): {url}  in {', '.join(found[url])}")
        print(f"probe-links: {len(found)} external links, {len(dead)} dead")
    return 1 if dead else 0


if __name__ == "__main__":
    sys.exit(main())
