#!/usr/bin/env python3
"""The song backlog: what the owner listens to minus what is reviewed.

Two sources. `backlog` (the default) is data/backlog/*.toml, the yearbooks and transcribed
playlists, in playlist order. `spotify` is the owner's Spotify history (ADR 0007,
data/spotify/tables/): every song without a review that the owner chose (a current top track, a
liked song or a song in one of the owner's own playlists), ranked by that choice. Songs that only
sit in followed or made-for-you playlists are not the owner's pick and need --all.

A backlog row is a song, not a recording: "Stand Up - Remastered Version" is "Stand Up", "Makeba -
Radio Edit" is "Makeba", while a remix is its own song. A row is pending when no review has the
same main artist and song (the catalogue's inferred artist and track, folded), when it is not a
repeat of an earlier row, and when it is not marked uncertain. Spotify rows are resolved again
against the reviews on disk, so a song written since the last derive is no longer pending. An
item that is not a song (a story reading) or that is a reviewed song under another spelling gets a
skip= or review= decision in data/backlog/decisions.toml; the derive applies it to the Spotify
records, and a skipped item then leaves the list (--all keeps it).

    python3 scripts/backlog.py                     the pending songs, in playlist order
    python3 scripts/backlog.py --json              the same as JSON (input of the skill add-song)
    python3 scripts/backlog.py --batches 8         JSON, split into 8 balanced batches
    python3 scripts/backlog.py --check             exit 1 when a backlog file is malformed
    python3 scripts/backlog.py --source spotify --limit 40 --batches 8
                                                   the owner's 40 strongest picks, in 8 batches
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
SPOTIFY = cat.ROOT / "data" / "spotify"
fold, song = cat.fold, cat.song  # one identity, shared with the catalogue


def jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


SONG_SECONDS = (90, 12 * 60)  # shorter is an interlude or a fragment, longer a mix or a bundle


def seconds(duration: str) -> int | None:
    if not re.fullmatch(r"(\d{1,2}:)?\d{1,2}:\d{2}", duration or ""):
        return None
    total = 0
    for part in duration.split(":"):
        total = total * 60 + int(part)
    return total


def spotify_rows(root: Path = SPOTIFY, everything: bool = False) -> list[dict]:
    """The Spotify songs without a review, strongest owner signal first.

    The rank is derived, never typed: a current top track first (by its rank), then by how many
    of the owner's own choices hold the song (liked, each own playlist), then artist by artist
    (a saved album does not fill a wave with one artist), then by how many playlists hold it.
    An item outside SONG_SECONDS (an interlude, a continuous mix, a hidden-track bundle) is not a
    song to review, nor is an item skipped by a decision (data/backlog/decisions.toml); --all
    keeps both."""
    tracks = jsonl(root / "tables" / "tracks.jsonl")
    own: dict[str, list[str]] = {}
    for m in jsonl(root / "tables" / "memberships.jsonl"):
        if m.get("kind") == "own":
            own.setdefault(m["track"], []).append(m["playlist"])
    index = root / "index.json"
    top = {}
    if index.exists():
        top = {t["record"]: t["rank"] for t in json.loads(index.read_text(encoding="utf-8")).get("top", [])}
    rows = []
    for t in tracks:
        if t.get("status") == "present" or not t.get("artists") or not t.get("title"):
            continue
        if t.get("status") == "skipped" and not everything:
            continue
        mine = sorted(set(own.get(t["id"], [])))
        rank = top.get(t["id"])
        chosen = bool(rank or t.get("liked") or mine)
        length = seconds(t.get("duration", ""))
        a_song = length is None or SONG_SECONDS[0] <= length <= SONG_SECONDS[1]
        if not everything and not (chosen and a_song):
            continue
        why = ([f"top #{rank}"] if rank else []) + (["liked"] if t.get("liked") else []) + mine
        weight = len(mine) + bool(t.get("liked"))
        rows.append({"title": t["title"], "artists": t["artists"], "album": t.get("album", ""),
                     "duration": t.get("duration", ""), "file": t.get("record", ""),
                     "why": ", ".join(why) or "followed playlists",
                     "_key": [rank or 10**6, -weight, 0, -t.get("playlist_count", 0), t["id"]]})
    rows.sort(key=lambda r: r["_key"])
    turn: dict[tuple, int] = {}
    for r in rows:  # the n-th song of an artist within a tier waits for every artist's (n-1)-th
        k = (r["_key"][0], r["_key"][1], fold(r["artists"][0]))
        r["_key"][2] = turn[k] = turn.get(k, -1) + 1
    rows.sort(key=lambda r: r["_key"])
    for n, r in enumerate(rows, 1):
        del r["_key"]
        r["n"] = n
    return rows


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
        if r.get("duration") and not re.fullmatch(r"(\d{1,2}:)?\d{1,2}:\d{2}", r["duration"]):
            problems.append(f"{where}: duration must be m:ss or h:mm:ss")
    return problems


def pending(rows: list[dict]) -> list[dict]:
    """The items no review covers yet, each once: the catalogue's own identity resolution
    (scripts/catalog.py resolve_item: ISRC, then artist and song)."""
    errors: list[str] = []
    files = cat.review_files()
    tracks = [t for t in (cat.load_track(p, errors) for p in files) if t]
    index = cat.identity_index(tracks)
    seen = set()
    out = []
    for r in rows:
        if cat.resolve_item(r, index)["status"] != "missing":
            continue
        key = (fold(r["artists"][0]), fold(song(r["title"])))
        if key in seen:
            continue
        seen.add(key)
        artist = ", ".join(r["artists"])
        item = {"n": r["n"], "title": r["title"], "song": song(r["title"]), "artist": artist,
                "album": r.get("album", ""), "duration": r.get("duration", ""),
                "input": f"{artist} - {r['title']}", "source": r["file"]}
        if r.get("why"):
            item["why"] = r["why"]
        out.append(item)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--batches", type=int, default=0)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--source", choices=("backlog", "spotify"), default="backlog")
    parser.add_argument("--limit", type=int, default=0, help="only the first N pending songs")
    parser.add_argument("--all", action="store_true",
                        help="spotify: also songs only in followed or made-for-you playlists")
    args = parser.parse_args()
    rows = spotify_rows(everything=args.all) if args.source == "spotify" else load()
    problems = check(rows)
    for p in problems:
        print(f"backlog: {p}", file=sys.stderr)
    if args.check or problems:
        print(f"backlog: {len(rows)} rows, {len(problems)} problem(s)")
        return 1 if problems else 0
    todo = pending(rows)
    total = len(todo)
    if args.limit:
        todo = todo[:args.limit]
    if args.batches:
        batches = [todo[i::args.batches] for i in range(args.batches)]
        print(json.dumps(batches, ensure_ascii=False, indent=1))
    elif args.json:
        print(json.dumps(todo, ensure_ascii=False, indent=1))
    else:
        for r in todo:
            why = f"  ({r['why']})" if r.get("why") else ""
            print(f"#{r['n']:>3}  {r['input']}   [{r['album']}, {r['duration']}]{why}")
        print(f"backlog: {len(rows)} rows, {total} pending" + (f", {len(todo)} shown" if args.limit else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
