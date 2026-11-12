#!/usr/bin/env python3
"""Probe every video of the catalogue on YouTube (network; never part of the deploy gate).

A video removed from YouTube keeps its id in the front matter but its still answers 404; the
site then shows the placeholder tile (static/js/site.js). This names those tracks so the owner
can replace the id. Runs weekly in .github/workflows/content-health.yml.

    python3 scripts/probe-videos.py           report; exit 1 when a video is gone
    python3 scripts/probe-videos.py --json    the same as JSON
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

CATALOG = Path(__file__).resolve().parent.parent / "static" / "data" / "catalog.json"


def probe(video_id: str) -> int:
    url = f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
    request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "sonic-playground-probe"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except (urllib.error.URLError, TimeoutError):
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    tracks = [t for t in json.loads(CATALOG.read_text(encoding="utf-8"))["tracks"] if t["youtube"]]
    with ThreadPoolExecutor(max_workers=8) as pool:
        codes = list(pool.map(lambda t: probe(t["youtube"]), tracks))
    gone = [{"source": t["source"], "youtube": t["youtube"], "status": c}
            for t, c in zip(tracks, codes) if c == 404]
    unknown = [t["source"] for t, c in zip(tracks, codes) if c not in (200, 404)]
    if args.json:
        print(json.dumps({"probed": len(tracks), "gone": gone, "unreachable": unknown}, indent=1))
    else:
        for g in gone:
            print(f"gone: {g['source']} (youtube id {g['youtube']})")
        for u in unknown:
            print(f"unreachable (not judged): {u}")
        print(f"probe-videos: {len(tracks)} videos, {len(gone)} gone, {len(unknown)} not judged")
    return 1 if gone else 0


if __name__ == "__main__":
    sys.exit(main())
