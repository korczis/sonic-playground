#!/usr/bin/env python3
"""Probe every video the reviews name on YouTube (network; never part of the deploy gate).

A video removed from YouTube keeps its id in the front matter, but its still answers 404 and the
player shows an error: a console error on every page that shows it. The probe records which videos
are gone in data/videos.json (committed); scripts/catalog.py reads that file, so the site then
requests neither the still nor the player for them and shows the derived artwork instead. The
build stays offline and deterministic; only this script talks to YouTube.

    python3 scripts/probe-videos.py           report; exit 1 when a video is gone
    python3 scripts/probe-videos.py --write   also rewrite data/videos.json, then: npm run derive
    python3 scripts/probe-videos.py --json    the report as JSON

Runs weekly in .github/workflows/content-health.yml, which fails while data/videos.json differs
from what YouTube answers (a video vanished, or a replaced id came back).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import catalog as cat  # noqa: E402  (the reviews, not their translations)

ROOT = Path(__file__).resolve().parent.parent
CONTENT = ROOT / "content"
STATUS = ROOT / "data" / "videos.json"
YOUTUBE_ID = re.compile(r"/embed/([A-Za-z0-9_-]{11})$")


def videos() -> dict[str, str]:
    """Every video id the reviews name, with the review that names it."""
    found = {}
    for path in cat.review_files():
        text = path.read_text(encoding="utf-8")
        match = re.match(r"\A\+\+\+\r?\n(.*?)\r?\n\+\+\+", text, re.S)
        if not match:
            continue
        try:
            extra = tomllib.loads(match.group(1)).get("extra", {})
        except tomllib.TOMLDecodeError:
            continue
        hit = YOUTUBE_ID.search(str(extra.get("youtube", ""))) if isinstance(extra, dict) else None
        if hit:
            found[hit.group(1)] = path.name
    return found


def probe(video_id: str) -> int:
    url = f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
    request = urllib.request.Request(url, method="HEAD",
                                     headers={"User-Agent": "sonic-playground-probe"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except (urllib.error.URLError, TimeoutError):
        return 0


def render(gone: dict[str, str]) -> str:
    return json.dumps({"schema": "sonic-videos/v1", "generated_by": "scripts/probe-videos.py",
                       "gone": dict(sorted(gone.items()))}, indent=1) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--write", action="store_true", help="rewrite data/videos.json")
    args = parser.parse_args()
    ids = videos()
    with ThreadPoolExecutor(max_workers=8) as pool:
        codes = dict(zip(ids, pool.map(probe, ids)))
    gone = {vid: ids[vid] for vid, code in codes.items() if code == 404}
    unknown = sorted(ids[vid] for vid, code in codes.items() if code not in (200, 404))
    if args.write:
        STATUS.write_text(render(gone), encoding="utf-8")
    recorded = STATUS.read_text(encoding="utf-8") if STATUS.exists() else ""
    current = recorded == render(gone)
    if args.json:
        print(json.dumps({"probed": len(ids), "gone": gone, "unreachable": unknown,
                          "recorded": current}, indent=1))
    else:
        for vid, source in sorted(gone.items(), key=lambda kv: kv[1]):
            print(f"gone: {source} (youtube id {vid})")
        for source in unknown:
            print(f"unreachable (not judged): {source}")
        print(f"probe-videos: {len(ids)} videos, {len(gone)} gone, {len(unknown)} not judged; "
              f"data/videos.json {'current' if current else 'STALE (run with --write)'}")
    return 0 if current and not unknown else 1


if __name__ == "__main__":
    sys.exit(main())
