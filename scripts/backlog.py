#!/usr/bin/env python3
"""The song backlog: what the owner listens to (data/backlog/*.toml) minus what is reviewed.

A backlog row is a song, not a recording: "Stand Up - Remastered Version" is "Stand Up", "Makeba -
Radio Edit" is "Makeba", while a remix is its own song. A row is pending when no review has the
same main artist and song (the catalogue's inferred artist and track, folded), when it is not a
repeat of an earlier row, and when it is not marked uncertain.

    python3 scripts/backlog.py                 the pending songs, in playlist order
    python3 scripts/backlog.py --json          the same as JSON (input of the skill add-song)
    python3 scripts/backlog.py --batches 8     JSON, split into 8 balanced batches
    python3 scripts/backlog.py --check         exit 1 when a backlog file is malformed
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import catalog as cat  # noqa: E402

BACKLOG = cat.ROOT / "data" / "backlog"
# Version suffixes that do not make another song; a remix, a mix of another artist, a live take of
# a different arrangement stays a song of its own.
VERSION = re.compile(
    r"\s*(?:-\s*)?(?:\(|\[)?\b(?:remaster(?:ed)?(?: version)?(?: \d{4})?|radio edit|radio version|"
    r"radio mix|original mix|extended version|album version|edit)\b(?:\)|\])?\s*$", re.I)
FEAT = re.compile(r"\s*[\(\[]?\s*\b(?:feat\.?|featuring|ft\.)\s+[^\)\]]*[\)\]]?", re.I)


def fold(text: str) -> str:
    return "".join(cat.words(text))


def song(title: str) -> str:
    """The song a recording title names: without featured artists and version suffixes."""
    base = FEAT.sub("", title)
    previous = None
    while previous != base:
        previous = base
        base = VERSION.sub("", base).strip(" -")
    return base.strip()


def load() -> list[dict]:
    rows = []
    for path in sorted(BACKLOG.glob("*.toml")):
        data = tomllib.loads(path.read_text(encoding="utf-8"))
        for row in data.get("track", []):
            rows.append({**row, "file": path.relative_to(cat.ROOT).as_posix()})
    return rows


def check(rows: list[dict]) -> list[str]:
    problems = []
    for r in rows:
        where = f"{r['file']} #{r.get('n')}"
        if not isinstance(r.get("n"), int):
            problems.append(f"{where}: n must be an integer")
        if not r.get("uncertain"):
            if not r.get("title"):
                problems.append(f"{where}: title is required (or mark the row uncertain)")
            if not r.get("artists"):
                problems.append(f"{where}: artists are required (or mark the row uncertain)")
        if r.get("duration") and not re.fullmatch(r"\d{1,2}:\d{2}", r["duration"]):
            problems.append(f"{where}: duration must be m:ss")
    return problems


def pending(rows: list[dict]) -> list[dict]:
    reviewed = set()
    for t in json.loads(cat.OUTPUT.read_text(encoding="utf-8"))["tracks"]:
        # A review by several artists (a cover, a collaboration) covers that recording only.
        if "," not in t["artist"]:
            reviewed.add((fold(t["artist"].split(" feat")[0]), fold(song(t["track"]))))
        reviewed.add((fold(t["artist"]), fold(song(t["track"]))))
    seen = set()
    out = []
    for r in rows:
        if r.get("uncertain"):
            continue
        key = (fold(r["artists"][0]), fold(song(r["title"])))
        if key in reviewed or key in seen:
            continue
        seen.add(key)
        artist = ", ".join(r["artists"])
        out.append({"n": r["n"], "title": r["title"], "song": song(r["title"]), "artist": artist,
                    "album": r.get("album", ""), "duration": r.get("duration", ""),
                    "input": f"{artist} - {r['title']}", "source": r["file"]})
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--batches", type=int, default=0)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    rows = load()
    problems = check(rows)
    for p in problems:
        print(f"backlog: {p}", file=sys.stderr)
    if args.check or problems:
        print(f"backlog: {len(rows)} rows, {len(problems)} problem(s)")
        return 1 if problems else 0
    todo = pending(rows)
    if args.batches:
        batches = [todo[i::args.batches] for i in range(args.batches)]
        print(json.dumps(batches, ensure_ascii=False, indent=1))
    elif args.json:
        print(json.dumps(todo, ensure_ascii=False, indent=1))
    else:
        for r in todo:
            print(f"#{r['n']:>3}  {r['input']}   [{r['album']}, {r['duration']}]")
        print(f"backlog: {len(rows)} rows, {len(todo)} pending")
    return 0


if __name__ == "__main__":
    sys.exit(main())
