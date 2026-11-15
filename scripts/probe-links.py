#!/usr/bin/env python3
"""Probe every external link the reviews and pages make (network; never part of the deploy gate).

Internal links are proved offline on every build (Zola's link checker, scripts/check-built.py);
external ones can only be proved by asking the web, which changes on its own. This asks every
http(s) URL of content/: the links of the bodies and every URL of the front matter (the cited
sources, extra.sources[].url, are most of them; extra.youtube is probe-videos.py's), and reports
the ones that do not answer (a host that turns automated clients away is listed apart and
fails nothing; see REFUSED), so a dead or invented
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
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LINK = re.compile(r"\]\((https?://[^)\s]+)\)|href=\"(https?://[^\"]+)\"")
FRONT = re.compile(r"\A\+\+\+\r?\n(.*?)\r?\n\+\+\+\r?\n?(.*)\Z", re.S)
# Front matter keys whose URLs another probe owns.
OWNED_ELSEWHERE = {"extra.youtube"}  # scripts/probe-videos.py
# What an answer proves about the page. A refusal (401, 403, a 429 that outlives its retries) is
# about the client, not the page: bot walls answer it to CI's addresses for pages that people
# read (earmilk.com, qobuz.com, traxsource.com on 2026-11-15), so it is reported by host and
# never fails the probe. Dead is what a removed page or domain answers: 404, 410, any other
# 4xx, a 5xx, or nothing at all. The first run on CI (43655799611) found 141 "dead" of 1960:
# 104 were Wikipedia's 429 to eight parallel requests, about 30 were bot walls' 403.
REFUSED = (401, 403, 429)
# Requests to one host go one at a time with this gap; hosts are asked in parallel.
PACE_S = 0.3
# A 429 or 503 is asked again after its Retry-After (bounded), this many times.
RETRIES = 3
RETRY_CAP_S = 30.0


def verdict(code: int) -> str:
    if 200 <= code < 400:
        return "ok"
    return "refused" if code in REFUSED else "dead"


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


def as_uri(url: str) -> str:
    """The URL as ASCII, the way a browser sends it: an IDNA host, a percent-encoded path and
    query. urllib refuses a raw "https://en.wikipedia.org/wiki/Lunático" (the first CI run
    counted it unreachable), while every reader's browser opens it."""
    parts = urllib.parse.urlsplit(url)
    host = (parts.hostname or "").encode("idna").decode("ascii")
    netloc = host + (f":{parts.port}" if parts.port else "")
    safe = "/%:@!$&'()*+,;=-._~"
    return urllib.parse.urlunsplit((parts.scheme, netloc, urllib.parse.quote(parts.path, safe=safe),
                                    urllib.parse.quote(parts.query, safe=safe + "?"), ""))


def ask(url: str) -> tuple[int, float | None]:
    """The status one request gets, and the Retry-After it carries (seconds), if any."""
    url = as_uri(url)
    headers = {"User-Agent": "Mozilla/5.0 (sonic-playground link probe)"}
    for method in ("HEAD", "GET"):
        try:
            request = urllib.request.Request(url, method=method, headers=headers)
            with urllib.request.urlopen(request, timeout=20) as response:
                return response.status, None
        except urllib.error.HTTPError as exc:
            if method == "HEAD" and exc.code in (403, 405, 501):
                continue
            after = (exc.headers.get("Retry-After") or "").strip() if exc.headers else ""
            return exc.code, float(after) if after.isdigit() else None
        except (urllib.error.URLError, TimeoutError, ValueError):
            if method == "HEAD":
                continue
            return 0, None
    return 0, None


def probe(url: str, sleep: Callable[[float], None] = time.sleep) -> int:
    """The status of the URL; a 429 or 503 is asked again after its Retry-After."""
    code, after = ask(url)
    for attempt in range(RETRIES):
        if code not in (429, 503):
            break
        sleep(min(after if after is not None else 2.0 * 2 ** attempt, RETRY_CAP_S))
        code, after = ask(url)
    return code


def probe_all(urls: list[str], ask_one: Callable[[str], int] | None = None,
              sleep: Callable[[float], None] = time.sleep) -> dict[str, int]:
    """Every URL's status: hosts in parallel, the URLs of one host one at a time, PACE_S apart."""
    one = ask_one or probe
    hosts: dict[str, list[str]] = {}
    for url in urls:
        hosts.setdefault((urllib.parse.urlsplit(url).hostname or "").lower(), []).append(url)

    def walk(group: list[str]) -> list[tuple[str, int]]:
        out = []
        for i, url in enumerate(group):
            if i:
                sleep(PACE_S)
            out.append((url, one(url)))
        return out

    with ThreadPoolExecutor(max_workers=8) as pool:
        return {u: c for group in pool.map(walk, hosts.values()) for u, c in group}


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    found = links()
    codes = probe_all(list(found), probe)
    dead = {u: c for u, c in codes.items() if verdict(c) == "dead"}
    refused: dict[str, dict[int, int]] = {}
    for u, c in codes.items():
        if verdict(c) == "refused":
            host = (urllib.parse.urlsplit(u).hostname or "").lower()
            refused.setdefault(host, {}).setdefault(c, 0)
            refused[host][c] += 1
    if args.json:
        print(json.dumps({"probed": len(found),
                          "dead": [{"url": u, "status": c, "in": found[u]} for u, c in sorted(dead.items())],
                          "refused": [{"host": h, "status": c, "links": n}
                                      for h, by in sorted(refused.items()) for c, n in sorted(by.items())]},
                         indent=1))
    else:
        for url, code in sorted(dead.items()):
            print(f"dead ({code or 'unreachable'}): {url}  in {', '.join(found[url])}")
        for host, by in sorted(refused.items()):
            for code, n in sorted(by.items()):
                print(f"refused ({code}) by {host}: {n} link(s), the host turns automated clients away")
        n_refused = sum(n for by in refused.values() for n in by.values())
        print(f"probe-links: {len(found)} external links, {len(dead)} dead, {n_refused} refused")
    return 1 if dead else 0


if __name__ == "__main__":
    sys.exit(main())
