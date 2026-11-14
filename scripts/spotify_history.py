#!/usr/bin/env python3
"""The owner's Spotify history as one record per song, playlist and library (data/spotify/).

Development-time only: the public site never talks to Spotify (ADR 0001), and the owner decided
where each part lives (ADR 0007, knowledge owner-answers-2026-11-14):

- public, committed: data/spotify/tracks/<id>.md, playlists/<id>.md, library.md and index.json.
  Catalogue identity (title, artists, album, Spotify track/album/artist ids) and relationships
  (liked, the playlists and yearbooks a song is in and where, the review it resolves to). No
  date of adding, no play, no account or user identifier, no playlist id.
- private, never committed: data/spotify/private/ (ignored by git). The raw sources (web-player
  snapshots, the account data export) and the same records with the private fields added:
  when a song was liked or added, and its plays.

Every record is Markdown with a YAML front matter whose values are JSON literals (JSON is YAML
1.2), one key per line or a block list of JSON items: any YAML or JSON reader takes it, and so
does this file without a dependency. The body is a short derived summary for people.

    python3 scripts/spotify_history.py ingest-snapshot <file.json>   keep a web-player snapshot
    python3 scripts/spotify_history.py import-export <folder>        keep Spotify's data export
    python3 scripts/spotify_history.py build [--write]               derive every record
    python3 scripts/spotify_history.py --check                       the gate (CI and hooks)
    python3 scripts/spotify_history.py stats                         what the history holds

`build` without --write reports what would change. It also writes the annual "Your Top Songs"
playlists as yearbooks (data/backlog/yearbook-<year>.toml) through scripts/spotify.py, so the
catalogue derives the yearbook pages (ADR 0005). A snapshot comes from the owner's logged-in web
player, read off the rendered page (docs: .ai/repo/skills/import-spotify-history/SKILL.md).
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import catalog as cat  # noqa: E402
import spotify  # noqa: E402

ROOT = cat.ROOT
BASE = ROOT / "data" / "spotify"
PRIVATE = BASE / "private"
SNAPSHOTS = PRIVATE / "snapshots"
EXPORTS = PRIVATE / "export"
SCHEMA_DIR = ROOT / "data"
SNAPSHOT_SCHEMA = "spotify-web-snapshot/v1"
ID22 = re.compile(r"^[0-9A-Za-z]{22}$")
# Keys that hold time or identity of the account: refused anywhere in a public record.
PRIVATE_KEYS = {"added", "plays", "ts", "played", "ip_addr", "user", "user_id", "owner_id",
                "username", "email", "playlist_id", "conn_country", "platform"}
KINDS = ("liked", "own", "yearbook", "made-for-you", "followed")


class HistoryError(Exception):
    pass


# --- Front matter: YAML whose values are JSON literals. -------------------------------------

def dump_record(meta: dict, body: str) -> str:
    lines = ["---"]
    for key, value in meta.items():
        if value is None:
            continue
        if isinstance(value, list) and value and isinstance(value[0], dict):
            lines.append(f"{key}:")
            lines += [f"  - {json.dumps(v, ensure_ascii=False)}" for v in value]
        else:
            lines.append(f"{key}: {json.dumps(value, ensure_ascii=False)}")
    lines.append("---")
    body = "\n".join(line.rstrip() for line in body.strip().split("\n"))
    return "\n".join(lines) + "\n\n" + body + "\n"


def load_record(text: str, name: str = "record") -> tuple[dict, str]:
    if not text.startswith("---\n"):
        raise HistoryError(f"{name}: no front matter (must start with ---)")
    end = text.find("\n---\n", 4)
    if end < 0:
        raise HistoryError(f"{name}: front matter is not closed")
    meta: dict = {}
    key = None
    for n, line in enumerate(text[4:end].split("\n"), start=2):
        if not line.strip():
            continue
        if line.startswith("  - ") and key is not None and isinstance(meta.get(key), list):
            try:
                meta[key].append(json.loads(line[4:]))
            except json.JSONDecodeError as exc:
                raise HistoryError(f"{name}:{n}: list item is not a JSON literal ({exc.msg})") from None
            continue
        m = re.fullmatch(r"([a-z_][a-z0-9_]*):(?: (.*))?", line)
        if not m:
            raise HistoryError(f"{name}:{n}: expected 'key: <json>' or '  - <json>'")
        key, raw = m.group(1), m.group(2)
        if key in meta:
            raise HistoryError(f"{name}:{n}: '{key}' appears twice")
        if raw is None:
            meta[key] = []
            continue
        try:
            meta[key] = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise HistoryError(f"{name}:{n}: value of '{key}' is not a JSON literal ({exc.msg})") from None
    return meta, text[end + 5:]


# --- Sources. ---------------------------------------------------------------------------------

def id_of(uri_or_id: str | None, kind: str) -> str | None:
    if not uri_or_id:
        return None
    m = re.fullmatch(rf"(?:spotify:{kind}:)?([0-9A-Za-z]{{22}})", uri_or_id)
    return m.group(1) if m else None


MONTHS = {m: i for i, m in enumerate(
    ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), start=1)}


def added_date(text: str | None, captured: str) -> dict | None:
    """The web player's "Date added" cell as a date: '9 Oct 2026', 'Oct 9, 2026' exactly,
    '4 weeks ago' approximately (relative to the capture day)."""
    if not text:
        return None
    t = text.strip().lower()
    m = re.fullmatch(r"(\d{1,2}) ([a-z]{3})[a-z]* (\d{4})", t) or None
    if m and m.group(2) in MONTHS:
        return {"date": date(int(m.group(3)), MONTHS[m.group(2)], int(m.group(1))).isoformat()}
    m = re.fullmatch(r"([a-z]{3})[a-z]* (\d{1,2}), (\d{4})", t)
    if m and m.group(1) in MONTHS:
        return {"date": date(int(m.group(3)), MONTHS[m.group(1)], int(m.group(2))).isoformat()}
    m = re.fullmatch(r"(\d+|an?) (second|minute|hour|day|week|month|year)s? ago", t)
    if m:
        n = 1 if m.group(1) in ("a", "an") else int(m.group(1))
        days = {"second": 0, "minute": 0, "hour": 0, "day": 1, "week": 7, "month": 30, "year": 365}[m.group(2)] * n
        return {"date": (date.fromisoformat(captured) - timedelta(days=days)).isoformat(), "approx": True}
    return {"text": text}


def snapshot_items(raw: list[dict]) -> list[dict]:
    """A snapshot's rows as items: position, identity, and the private 'added' text."""
    out = []
    for r in raw:
        if r.get("unavailable") or not r.get("title"):
            out.append({"n": r["n"], "unavailable": True})
            continue
        artists = [(a["name"] if isinstance(a, dict) else a or "").strip() for a in r.get("artists", [])]
        artist_ids = [a.get("id") for a in r.get("artists", []) if isinstance(a, dict)]
        if not any(artists):  # a local file or a row without artist links: no catalogue identity
            out.append({"n": r["n"], "unavailable": True})
            continue
        album = r.get("album")
        item = {"n": r["n"], "title": r["title"].strip(), "artists": [a for a in artists if a],
                "album": (((album or {}).get("name") if isinstance(album, dict) else album) or "").strip() or None,
                "duration": r.get("duration") or None, "explicit": bool(r.get("explicit")),
                "track_id": id_of(r.get("track_id"), "track"),
                "album_id": id_of((album or {}).get("id") if isinstance(album, dict) else None, "album"),
                "artist_ids": [i for i in artist_ids if i and ID22.match(i)],
                "episode": bool(r.get("episode_id")), "added_text": r.get("added")}
        out.append(item)
    return out


def load_snapshots(folder: Path = SNAPSHOTS) -> list[dict]:
    snaps = []
    for path in sorted(folder.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("schema") != SNAPSHOT_SCHEMA:
            raise HistoryError(f"{path.name}: schema must be {SNAPSHOT_SCHEMA}")
        snaps.append({**data, "file": path.name})
    return snaps


def merge_liked(playlists: list[dict], plain: list[dict] | None) -> list[dict]:
    """A liked-songs crawl with ids that stopped short is completed from a full one without ids,
    row by row (same capture, same order)."""
    if not plain:
        return playlists
    for p in playlists:
        if p.get("uri") == "spotify:collection:tracks":
            have = {r["n"]: r for r in p["items"]}
            for r in plain:
                if r["n"] not in have:
                    have[r["n"]] = r
            p["items"] = [have[n] for n in sorted(have)]
            p["expected"] = max(p.get("expected") or 0, len(plain))
    return playlists


def ingest_snapshot(path: Path, plain: Path | None = None) -> Path:
    """Copy a web-player snapshot into the private store, normalised and named by its day."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema") not in (None, SNAPSHOT_SCHEMA):
        raise HistoryError(f"{path}: unknown schema {data.get('schema')}")
    captured = data.get("captured") or date.today().isoformat()
    playlists = data.get("playlists", [])
    if plain:
        playlists = merge_liked(playlists, json.loads(plain.read_text(encoding="utf-8")).get("items"))
    out = {"schema": SNAPSHOT_SCHEMA, "captured": captured,
           "source": data.get("source", "open.spotify.com, the owner's logged-in web player (rendered page)"),
           "library": data.get("library", []), "playlists": playlists}
    if data.get("top"):
        out["top"] = data["top"]
    SNAPSHOTS.mkdir(parents=True, exist_ok=True)
    suffix = "-top" if data.get("top") and not playlists else ""
    target = SNAPSHOTS / f"web-{captured}{suffix}.json"
    target.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    commit_private(f"snapshot: web player {captured}")
    return target


def import_export(folder: Path) -> dict:
    """Copy Spotify's account data export (YourLibrary.json, Playlist*.json, StreamingHistory*,
    Streaming_History_Audio_*) into the private store. Nothing of it is committed."""
    names = [p for p in folder.rglob("*.json")
             if re.match(r"(YourLibrary|Playlist\d*|StreamingHistory|Streaming_History_Audio|Follow|Userdata)", p.name)]
    if not names:
        raise HistoryError(f"{folder}: no Spotify export files (YourLibrary.json, Playlist*.json, "
                           "StreamingHistory*.json, Streaming_History_Audio_*.json)")
    EXPORTS.mkdir(parents=True, exist_ok=True)
    for p in names:
        shutil.copy2(p, EXPORTS / p.name)
    commit_private(f"export: {len(names)} file(s) from {folder.name}")
    return {"copied": sorted(p.name for p in names), "into": EXPORTS.relative_to(ROOT).as_posix()}


def export_sources(folder: Path = EXPORTS) -> dict:
    """The export as items and plays: liked tracks, playlists, play events (private)."""
    out: dict = {"liked": [], "playlists": [], "plays": []}
    lib = folder / "YourLibrary.json"
    if lib.exists():
        data = json.loads(lib.read_text(encoding="utf-8"))
        for n, t in enumerate(data.get("tracks", []), start=1):
            out["liked"].append({"n": n, "title": t.get("track", ""), "artists": [t["artist"]] if t.get("artist") else [],
                                 "album": t.get("album"), "track_id": id_of(t.get("uri"), "track")})
    for path in sorted(folder.glob("Playlist*.json")):
        for p in json.loads(path.read_text(encoding="utf-8")).get("playlists", []):
            items = []
            for n, e in enumerate(p.get("items", []), start=1):
                it = spotify.item_from_export(n, e)
                items.append({"n": n, "title": it.get("title"), "artists": it.get("artists", []),
                              "album": it.get("album"), "track_id": it.get("spotify"),
                              "added_text": e.get("addedDate"), "unavailable": bool(it.get("uncertain") or it.get("skip"))})
            out["playlists"].append({"name": p.get("name", ""), "items": items, "export": path.name,
                                     "description": p.get("description") or ""})
    for path in sorted(folder.glob("Streaming_History_Audio_*.json")) + sorted(folder.glob("StreamingHistory_music_*.json")):
        for e in json.loads(path.read_text(encoding="utf-8")):
            if "ts" in e:  # extended streaming history
                if not e.get("master_metadata_track_name"):
                    continue
                out["plays"].append({"ts": e["ts"], "ms": e.get("ms_played", 0),
                                     "title": e["master_metadata_track_name"],
                                     "artist": e.get("master_metadata_album_artist_name") or "",
                                     "track_id": id_of(e.get("spotify_track_uri"), "track")})
            else:  # the account data's last year
                out["plays"].append({"ts": e.get("endTime", ""), "ms": e.get("msPlayed", 0),
                                     "title": e.get("trackName", ""), "artist": e.get("artistName", ""),
                                     "track_id": None})
    return out


# --- The model: songs, playlists, library. ----------------------------------------------------

def key_of(item: dict) -> tuple:
    if item.get("track_id"):
        return ("id", item["track_id"])
    return ("as", cat.fold(item["artists"][0]) if item.get("artists") else "", cat.fold(cat.song(item.get("title", ""))))


def classify(p: dict, self_name: str | None) -> str:
    if p.get("uri") == "spotify:collection:tracks":
        return "liked"
    sub = (p.get("library_subtitle") or "").lower()
    if spotify.year_of(p.get("name", "")) and ("made for" in sub or "spotify" in sub):
        return "yearbook"
    if "made for" in sub:
        return "made-for-you"
    owner = (p.get("owner") or {}).get("name") or sub.split("•")[-1].strip()
    if self_name and owner.strip().lower() == self_name.strip().lower():
        return "own"
    return "followed"


def model(snaps: list[dict], export: dict | None = None) -> dict:
    """Every source folded into songs keyed by identity, playlists in order, the library."""
    songs: dict[tuple, dict] = {}
    alias: dict[tuple, tuple] = {}  # artist+song key -> id key, to join id-less rows
    playlists: list[dict] = []
    library: dict[str, Any] = {"albums": {}, "artists": {}}
    plays: dict[tuple, dict] = defaultdict(lambda: {"count": 0, "ms": 0, "first": None, "last": None})
    sources = []

    def song_for(item: dict) -> dict:
        k = key_of(item)
        if k[0] == "as" and k in alias:
            k = alias[k]
        s = songs.get(k)
        if s is None:
            s = songs[k] = {"key": k, "title": item["title"], "artists": list(item["artists"]),
                            "album": item.get("album"), "duration": item.get("duration"),
                            "explicit": bool(item.get("explicit")), "track_id": item.get("track_id"),
                            "album_id": item.get("album_id"), "artist_ids": item.get("artist_ids") or [],
                            "liked": False, "liked_added": None, "playlists": [], "top": [], "sources": set()}
        else:  # fill what an earlier source lacked
            for f in ("album", "duration", "album_id"):
                s[f] = s[f] or item.get(f)
            s["artist_ids"] = s["artist_ids"] or item.get("artist_ids") or []
            s["explicit"] = s["explicit"] or bool(item.get("explicit"))
        if k[0] == "id" and item.get("artists"):
            alias.setdefault(("as", cat.fold(item["artists"][0]), cat.fold(cat.song(item["title"]))), k)
        return s

    # Id-bearing rows first, so that id-less rows of the same song join them.
    ordered = sorted(snaps, key=lambda s: s["captured"])
    self_name = None
    for snap in ordered:
        for p in snap.get("playlists", []):
            if p.get("uri") == "spotify:collection:tracks" and (p.get("owner") or {}).get("name"):
                self_name = p["owner"]["name"]
    for snap in ordered:
        tag = f"web-player:{snap['captured']}"
        sources.append(tag)
        for lib in snap.get("library", []):
            uri = lib.get("uri") or ""
            kind = uri.split(":")[1] if uri.count(":") >= 2 else None
            if kind == "album" and id_of(uri, "album"):
                artist = (lib.get("sub") or "").split("•")[-1].strip() or None
                library["albums"][id_of(uri, "album")] = {"name": lib.get("name"), "artist": artist, "id": id_of(uri, "album")}
            elif kind == "artist" and id_of(uri, "artist"):
                library["artists"][id_of(uri, "artist")] = {"name": lib.get("name"), "id": id_of(uri, "artist")}
        for p in snap.get("playlists", []):
            items = snapshot_items(p.get("items", []))
            for first_pass in (True, False):
                for it in items:
                    if it.get("unavailable") or it.get("episode") or bool(it.get("track_id")) != first_pass:
                        continue
                    song_for(it)
            pl = {"name": (p.get("name") or "").strip(), "uri": p.get("uri"), "kind": classify(p, self_name),
                  "library_subtitle": p.get("library_subtitle"), "owner": p.get("owner"),
                  "description": (p.get("description") or "").strip(), "expected": p.get("expected"),
                  "captured": snap["captured"], "rows": []}
            for it in items:
                if it.get("unavailable") or it.get("episode"):
                    pl["rows"].append({"n": it["n"], "song": None, "added": None})
                    continue
                s = song_for(it)
                s["sources"].add(tag)
                added = added_date(it.get("added_text"), snap["captured"])
                pl["rows"].append({"n": it["n"], "song": s["key"], "added": added})
                if pl["kind"] == "liked":
                    s["liked"], s["liked_added"] = True, added
            playlists.append(pl)
    if export:
        tag = "spotify-export"
        if export["liked"] or export["playlists"] or export["plays"]:
            sources.append(tag)
        for it in export["liked"]:
            if it.get("title") and it.get("artists"):
                s = song_for(it)
                s["liked"] = True
                s["sources"].add(tag)
        for e in export["plays"]:
            item = {"title": e["title"], "artists": [e["artist"]] if e["artist"] else [], "track_id": e["track_id"]}
            if not item["title"] or not item["artists"]:
                continue
            k = key_of(item)
            k = alias.get(("as", cat.fold(e["artist"]), cat.fold(cat.song(e["title"]))), k) if k[0] == "as" else k
            if k not in songs:
                s = song_for(item)
                s["sources"].add(tag)
                k = s["key"]
            pr = plays[k]
            pr["count"] += 1
            pr["ms"] += int(e.get("ms") or 0)
            ts = (e.get("ts") or "")[:19]
            pr["first"] = min(filter(None, (pr["first"], ts)), default=None)
            pr["last"] = max(filter(None, (pr["last"], ts)), default=None)
    # Top lists last: their rows carry no track id and join the songs the playlists named.
    top_artists: list[dict] = []
    for snap in ordered:
        top = snap.get("top")
        if not top:
            continue
        tag = f"web-player:{snap['captured']}"
        rng = {"short_term": "month", "medium_term": "half-year", "long_term": "all-time"}.get(top.get("range", ""), "month")
        for it in snapshot_items(top.get("tracks", [])):
            if it.get("unavailable"):
                continue
            s = song_for(it)
            s["sources"].add(tag)
            s["top"] = [t for t in s["top"] if t["range"] != rng] + [{"range": rng, "rank": it["n"], "read": snap["captured"]}]
        top_artists = [a for a in top_artists if a["range"] != rng] + [
            {"range": rng, "rank": a["rank"], "name": a["name"], **({"id": a["id"]} if id_of(a.get("id"), "artist") else {}),
             "read": snap["captured"]} for a in top.get("artists", [])]
    # Newer snapshots of a playlist replace older ones (one playlist, its latest reading).
    latest: dict[str, dict] = {}
    for pl in playlists:
        latest[pl["uri"] or pl["name"]] = pl
    library["top_artists"] = top_artists
    return {"songs": songs, "playlists": list(latest.values()), "library": library,
            "plays": dict(plays), "sources": sources, "self": self_name}


# --- Identity of records: stable, readable file names. --------------------------------------

def assign_ids(m: dict) -> None:
    taken: dict[str, tuple] = {}
    for s in sorted(m["songs"].values(), key=lambda s: (cat.slugify(f"{s['artists'][0]} {s['title']}"), s["track_id"] or "")):
        base = cat.slugify(f"{s['artists'][0]} {s['title']}")[:90].strip("-") or "track"
        sid = base
        if sid in taken:
            sid = f"{base}-{(s['track_id'] or 'x')[:6].lower()}"
        n = 2
        while sid in taken:
            sid, n = f"{base}-{n}", n + 1
        taken[sid] = s["key"]
        s["id"] = sid
    names: dict[str, int] = {}
    for pl in m["playlists"]:
        base = "liked-songs" if pl["kind"] == "liked" else (cat.slugify(pl["name"])[:80].strip("-") or "playlist")
        names[base] = names.get(base, 0) + 1
        pl["id"] = base if names[base] == 1 else f"{base}-{names[base]}"


def playlist_overrides() -> dict:
    """The owner's review=/skip= decisions in data/backlog/*.toml (ADR 0005), keyed by the
    item's Spotify id and by its folded main artist and song: a record of the same recording
    resolves the way its yearbook or playlist item does."""
    out: dict = {}
    for path in sorted(cat.BACKLOG.glob("*.toml")):
        for it in cat.tomllib.loads(path.read_text(encoding="utf-8")).get("track", []):
            decision = {k: it[k] for k in ("review", "skip") if it.get(k)}
            if not decision:
                continue
            if it.get("spotify"):
                out[it["spotify"]] = decision
            if it.get("artists") and it.get("title"):
                out[(cat.fold(it["artists"][0]), cat.fold(cat.song(it["title"])))] = decision
    return out


def resolve_reviews(m: dict) -> None:
    errors: list[str] = []
    tracks = [t for t in (cat.load_track(p, errors) for p in cat.review_files()) if t]
    index = cat.identity_index(tracks)
    extra = {t.source: t.full_extra for t in tracks}
    overrides = playlist_overrides()
    for s in m["songs"].values():
        first = cat.fold(s["artists"][0]) if s["artists"] else ""
        forced = overrides.get(s["track_id"] or "") or overrides.get((first, cat.fold(cat.song(s["title"]))))
        r = cat.resolve_item({"title": s["title"], "artists": s["artists"], **(forced or {})}, index)
        s["review"] = r["source"] if r["status"] == "present" else None
        s["status"] = r["status"]
        x = extra.get(s["review"] or "", {})
        mb = x.get("musicbrainz") or {}
        s["review_keys"] = {k: v for k, v in (("isrc", x.get("isrc")),
                                              ("musicbrainz", mb.get("recording") if isinstance(mb, dict) else None),
                                              ("wikidata", x.get("wikidata"))) if v}


# --- Records. -----------------------------------------------------------------------------------

def memberships(m: dict) -> dict[tuple, list]:
    """Per song, every (playlist, row) it appears in: computed once per model."""
    if "_member" not in m:
        member: dict[tuple, list] = defaultdict(list)
        for pl in m["playlists"]:
            for row in pl["rows"]:
                if row["song"]:
                    member[row["song"]].append((pl, row))
        m["_member"] = member
    return m["_member"]


def join_keys(s: dict) -> dict:
    """Keys another dataset can join this song on: the folded artist and song (the catalogue's
    identity, scripts/catalog.py fold/song), and the review's ISRC, MusicBrainz and Wikidata."""
    first = s["artists"][0] if s["artists"] else ""
    return {"fold": f"{cat.fold(first)}|{cat.fold(cat.song(s['title']))}", **(s.get("review_keys") or {})}


def song_meta(s: dict, m: dict, private: bool) -> dict:
    yearbooks, member = [], []
    for pl, row in memberships(m).get(s["key"], []):
        if True:
            if pl["kind"] == "yearbook":
                yearbooks.append({"year": spotify.year_of(pl["name"]), "n": row["n"]})
            elif pl["kind"] != "liked":
                entry = {"playlist": pl["id"], "n": row["n"]}
                if private and row.get("added"):
                    entry["added"] = row["added"]
                member.append(entry)
    ids = {k: v for k, v in (("track", s["track_id"]), ("album", s["album_id"])) if v}
    if s["artist_ids"]:
        ids["artists"] = s["artist_ids"]
    meta = {"schema": "spotify-track/v1", "id": s["id"], "title": s["title"], "artists": s["artists"],
            "album": s["album"], "duration": s["duration"], "explicit": s["explicit"] or None,
            "spotify": ids or None, "keys": join_keys(s), "review": s.get("review"), "status": s.get("status"),
            "liked": s["liked"], "yearbooks": sorted(yearbooks, key=lambda y: y["year"]) or None,
            "playlists": sorted(member, key=lambda e: (e["playlist"], e["n"])) or None,
            "top": sorted(s.get("top") or [], key=lambda t: t["range"]) or None,
            "sources": sorted(s["sources"])}
    if private:
        meta["added"] = s["liked_added"]
        meta["plays"] = m["plays"].get(s["key"])
    return meta


def song_body(meta: dict, m: dict) -> str:
    names = {pl["id"]: pl["name"] for pl in m["playlists"]}
    lines = [f"# {meta['title']} · {', '.join(meta['artists'])}", ""]
    if meta.get("album"):
        lines.append(f"From the album *{meta['album']}*" + (f", {meta['duration']}." if meta.get("duration") else "."))
    lines.append("A liked song." if meta["liked"] else "Not among the liked songs.")
    for t in meta.get("top") or []:
        lines.append(f"Top tracks of the {t['range']} (read {t['read']}): #{t['rank']}.")
    for y in meta.get("yearbooks") or []:
        lines.append(f"Your Top Songs {y['year']}: #{y['n']}.")
    if meta.get("playlists"):
        lines.append("In " + "; ".join(f"{names.get(e['playlist'], e['playlist'])} (#{e['n']})" for e in meta["playlists"]) + ".")
    if meta.get("review"):
        lines.append(f"Reviewed: content/{meta['review']}.")
    elif meta.get("status") == "ambiguous":
        lines.append("Matches more than one review: the yearbook or playlist item needs review= (never guessed).")
    else:
        lines.append("No review yet.")
    if meta.get("plays"):
        p = meta["plays"]
        lines.append(f"Played {p['count']} times, {round(p['ms'] / 60000)} minutes, first {p['first']}, last {p['last']}.")
    return "\n".join(lines)


def playlist_meta(pl: dict, m: dict, private: bool) -> dict:
    keys = {s["key"]: s["id"] for s in m["songs"].values()}
    tracks = []
    for row in pl["rows"]:
        entry = {"n": row["n"], "track": keys.get(row["song"])} if row["song"] else {"n": row["n"], "unavailable": True}
        if private and row.get("added"):
            entry["added"] = row["added"]
        tracks.append(entry)
    owner = (pl.get("owner") or {}).get("name") or ""
    meta = {"schema": "spotify-playlist/v1", "id": pl["id"], "name": pl["name"], "kind": pl["kind"],
            "year": spotify.year_of(pl["name"]) if pl["kind"] == "yearbook" else None,
            "curator": "Spotify" if pl["kind"] in ("yearbook", "made-for-you") or owner == "Spotify" else None,
            "description": pl["description"] or None, "expected": pl.get("expected"),
            "retrieved": sum(1 for t in tracks if not t.get("unavailable")),
            "unavailable": sum(1 for t in tracks if t.get("unavailable")) or None,
            "read": pl["captured"], "tracks": tracks}
    if private:
        meta["owner"] = owner or None
        meta["playlist_id"] = id_of(pl.get("uri"), "playlist")
    return meta


def playlist_body(meta: dict, m: dict) -> str:
    kind = {"liked": "The liked songs", "own": "A playlist of the owner's", "yearbook": "The annual Top Songs",
            "made-for-you": "Made by Spotify for the owner", "followed": "A playlist the owner follows"}[meta["kind"]]
    reviewed = {s["id"] for s in m["songs"].values() if s.get("review")}
    n_rev = sum(1 for t in meta["tracks"] if t.get("track") in reviewed)
    return (f"# {meta['name']}\n\n{kind}: {meta['retrieved']} of {meta.get('expected') or meta['retrieved']} "
            f"items read on {meta['read']}, {n_rev} of them reviewed on the site.")


def library_meta(m: dict) -> dict:
    kinds = defaultdict(list)
    for pl in sorted(m["playlists"], key=lambda p: (KINDS.index(p["kind"]), p["id"])):
        kinds[pl["kind"]].append(pl["id"])
    return {"schema": "spotify-library/v1", "id": "library",
            "songs": len(m["songs"]), "liked": sum(1 for s in m["songs"].values() if s["liked"]),
            "reviewed": sum(1 for s in m["songs"].values() if s.get("review")),
            "sources": m["sources"],
            "playlists": [{"kind": k, "ids": v} for k, v in kinds.items()] or None,
            "albums": sorted(m["library"]["albums"].values(), key=lambda a: (a["name"] or "").lower()) or None,
            "artists": sorted(m["library"]["artists"].values(), key=lambda a: (a["name"] or "").lower()) or None,
            "top_artists": sorted(m["library"].get("top_artists") or [], key=lambda a: (a["range"], a["rank"])) or None}


def index_json(m: dict) -> dict:
    """One machine-readable summary per review: what the history says about that song."""
    by_review: dict[str, dict] = {}
    for s in sorted(m["songs"].values(), key=lambda s: s["id"]):
        if not s.get("review"):
            continue
        meta = song_meta(s, m, private=False)
        r = by_review.setdefault(s["review"], {"records": [], "liked": False, "yearbooks": [], "playlists": 0})
        r["records"].append(s["id"])
        if s["track_id"] and "track" not in r:
            r["track"] = s["track_id"]
        r["liked"] = r["liked"] or s["liked"]
        r["yearbooks"] = sorted({y["year"] for y in meta.get("yearbooks") or []} | set(r["yearbooks"]))
        r["playlists"] += len(meta.get("playlists") or [])
    lib = library_meta(m)
    return {"schema": "spotify-index/v1", "songs": lib["songs"], "liked": lib["liked"], "reviewed": lib["reviewed"],
            "playlists": len(m["playlists"]), "reviews": by_review}


def records(m: dict, private: bool) -> dict[Path, str]:
    base = PRIVATE if private else BASE
    out: dict[Path, str] = {}
    for s in m["songs"].values():
        meta = song_meta(s, m, private)
        out[base / "tracks" / f"{s['id']}.md"] = dump_record(meta, song_body(meta, m))
    for pl in m["playlists"]:
        meta = playlist_meta(pl, m, private)
        out[base / "playlists" / f"{pl['id']}.md"] = dump_record(meta, playlist_body(meta, m))
    lib = library_meta(m)
    out[base / "library.md"] = dump_record(lib, (
        f"# The owner's Spotify library\n\n{lib['songs']} songs ({lib['liked']} liked, {lib['reviewed']} reviewed "
        f"on the site), {len(m['playlists'])} playlists, {len(lib.get('albums') or [])} saved albums and "
        f"{len(lib.get('artists') or [])} followed artists. Derived by scripts/spotify_history.py; never edit by hand."))
    if not private:
        out[base / "index.json"] = json.dumps(index_json(m), ensure_ascii=False, indent=1, sort_keys=True) + "\n"
    return out


def jsonl(rows: list[dict]) -> str:
    return "".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in rows)


def tables(m: dict) -> dict[Path, str]:
    """Flat, joinable tables (JSON Lines) for integration, indexing, search and materialisation:
    one row per track, playlist, membership edge, artist and album, keyed by the record ids and
    the public catalogue ids. The manifest describes every file, its key and its foreign keys."""
    tracks, edges, artists, albums = [], [], {}, {}
    for s in sorted(m["songs"].values(), key=lambda s: s["id"]):
        meta = song_meta(s, m, private=False)
        tracks.append({"id": s["id"], "title": s["title"], "artists": s["artists"], "album": s["album"],
                       "duration": s["duration"], "explicit": s["explicit"], "spotify_track": s["track_id"],
                       "spotify_album": s["album_id"], "spotify_artists": s["artist_ids"], "liked": s["liked"],
                       "review": s.get("review"), "status": s.get("status"), **{f"key_{k}": v for k, v in join_keys(s).items()},
                       "yearbook_years": [y["year"] for y in meta.get("yearbooks") or []],
                       "playlist_count": len(meta.get("playlists") or []), "record": f"data/spotify/tracks/{s['id']}.md"})
        for i, name in enumerate(s["artists"]):
            aid = s["artist_ids"][i] if i < len(s["artist_ids"]) else None
            a = artists.setdefault(aid or cat.fold(name), {"id": cat.slugify(name) or "artist", "name": name, "spotify_artist": aid,
                                                           "tracks": 0, "liked": 0, "reviewed": 0, "followed": False})
            for t in m["library"].get("top_artists") or []:
                if (aid and t.get("id") == aid) or cat.fold(t["name"]) == cat.fold(name):
                    a[f"top_{t['range'].replace('-', '_')}"] = t["rank"]
            a["tracks"] += 1
            a["liked"] += s["liked"]
            a["reviewed"] += bool(s.get("review"))
        if s["album"]:
            al = albums.setdefault(s["album_id"] or cat.fold(s["album"]), {"name": s["album"], "spotify_album": s["album_id"],
                                                                        "artist": s["artists"][0] if s["artists"] else None,
                                                                        "tracks": 0, "saved": False})
            al["tracks"] += 1
    for aid, a in m["library"]["artists"].items():
        artists.setdefault(aid, {"id": cat.slugify(a["name"] or "") or "artist", "name": a["name"], "spotify_artist": aid,
                                 "tracks": 0, "liked": 0, "reviewed": 0})["followed"] = True
    for aid, a in m["library"]["albums"].items():
        albums.setdefault(aid, {"name": a["name"], "spotify_album": aid, "artist": a.get("artist"), "tracks": 0})["saved"] = True
    keys = {s["key"]: s["id"] for s in m["songs"].values()}
    pls = []
    for pl in sorted(m["playlists"], key=lambda p: p["id"]):
        year = spotify.year_of(pl["name"]) if pl["kind"] == "yearbook" else None
        rows = [r for r in pl["rows"] if r["song"]]
        pls.append({"id": pl["id"], "name": pl["name"], "kind": pl["kind"], "year": year, "items": len(pl["rows"]),
                    "available": len(rows), "read": pl["captured"], "record": f"data/spotify/playlists/{pl['id']}.md"})
        for r in rows:
            edges.append({"track": keys[r["song"]], "playlist": pl["id"], "kind": pl["kind"], "n": r["n"], "year": year})
    out = {BASE / "tables" / "tracks.jsonl": jsonl(tracks), BASE / "tables" / "playlists.jsonl": jsonl(pls),
           BASE / "tables" / "memberships.jsonl": jsonl(edges),
           BASE / "tables" / "artists.jsonl": jsonl(sorted(artists.values(), key=lambda a: (a["name"] or "").lower())),
           BASE / "tables" / "albums.jsonl": jsonl(sorted(albums.values(), key=lambda a: (a["name"] or "").lower()))}
    manifest = {
        "schema": "spotify-manifest/v1",
        "description": "The owner's Spotify history: public identity and relationships (ADR 0007). Derived by "
                       "scripts/spotify_history.py build --write; never edited by hand.",
        "sources": m["sources"],
        "records": {"track": {"glob": "data/spotify/tracks/*.md", "schema": "data/spotify-track.schema.json",
                              "format": "Markdown, YAML front matter of JSON literals", "key": "id"},
                    "playlist": {"glob": "data/spotify/playlists/*.md", "schema": "data/spotify-playlist.schema.json",
                                 "format": "Markdown, YAML front matter of JSON literals", "key": "id"},
                    "library": {"path": "data/spotify/library.md", "schema": "data/spotify-library.schema.json"}},
        "tables": {
            "tracks": {"path": "data/spotify/tables/tracks.jsonl", "rows": len(tracks), "key": "id",
                       "join": {"spotify_track": "Spotify track id", "key_fold": "catalogue identity (artist|song folded)",
                                "key_isrc": "ISRC", "key_musicbrainz": "MusicBrainz recording", "key_wikidata": "Wikidata item",
                                "review": "content/<review> (static/data/catalog.json tracks[].source)"}},
            "playlists": {"path": "data/spotify/tables/playlists.jsonl", "rows": len(pls), "key": "id"},
            "memberships": {"path": "data/spotify/tables/memberships.jsonl", "rows": len(edges), "key": ["playlist", "n"],
                            "foreign": {"track": "tracks.id", "playlist": "playlists.id"}},
            "artists": {"path": "data/spotify/tables/artists.jsonl", "rows": len(artists), "key": "spotify_artist",
                        "join": {"name": "tracks.artists[]"}},
            "albums": {"path": "data/spotify/tables/albums.jsonl", "rows": len(albums), "key": "spotify_album",
                       "join": {"name": "tracks.album"}}},
        "index": {"path": "data/spotify/index.json", "key": "reviews.<review file>", "use": "templates/page.html"},
        "counts": {"tracks": len(tracks), "liked": sum(1 for t in tracks if t["liked"]),
                   "reviewed": sum(1 for t in tracks if t["review"]), "playlists": len(pls), "memberships": len(edges),
                   "artists": len(artists), "albums": len(albums),
                   "playlists_by_kind": {k: sum(1 for p in pls if p["kind"] == k) for k in KINDS}},
        "private": "data/spotify/private/ (ignored; its own local git repository): raw sources, dates added, plays",
    }
    out[BASE / "manifest.json"] = json.dumps(manifest, ensure_ascii=False, indent=1) + "\n"
    return out


def commit_private(message: str) -> str | None:
    """The private store is its own local git repository (no remote): every source and
    derivation is versioned without being published."""
    if not (PRIVATE / ".git").exists():
        return None
    run = lambda *a: subprocess.run(["git", "-C", str(PRIVATE), *a], capture_output=True, text=True)  # noqa: E731
    run("add", "-A")
    if run("diff", "--cached", "--quiet").returncode == 0:
        return None
    run("commit", "-qm", message)
    return run("rev-parse", "--short", "HEAD").stdout.strip()


def yearbook_items(pl: dict, m: dict) -> list[dict]:
    items = []
    for row in pl["rows"]:
        if not row["song"]:
            items.append({"n": row["n"], "uncertain": True, "note": "the item is not available on Spotify"})
            continue
        s = m["songs"][row["song"]]
        it = {"n": row["n"], "title": s["title"], "artists": s["artists"]}
        for key, value in (("album", s["album"]), ("duration", s["duration"]), ("spotify", s["track_id"])):
            if value:
                it[key] = value
        items.append(it)
    return items


def build(write: bool, snaps: list[dict] | None = None, export: dict | None = None) -> dict:
    snaps = load_snapshots() if snaps is None else snaps
    if export is None and EXPORTS.exists():
        export = export_sources()
    if not snaps and not (export and (export["liked"] or export["playlists"] or export["plays"])):
        raise HistoryError("no source: ingest a web-player snapshot (ingest-snapshot) or an export (import-export)")
    m = model(snaps, export)
    assign_ids(m)
    resolve_reviews(m)
    wanted = {**records(m, private=False), **tables(m), **records(m, private=True)}
    changed, removed = [], []
    for path, text in wanted.items():
        if not path.exists() or path.read_text(encoding="utf-8") != text:
            changed.append(path)
            if write:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text, encoding="utf-8")
    for folder in (BASE / "tracks", BASE / "playlists", PRIVATE / "tracks", PRIVATE / "playlists"):
        for path in folder.glob("*.md") if folder.exists() else []:
            if path not in wanted:
                removed.append(path)
                if write:
                    path.unlink()
    books = []
    for pl in m["playlists"]:
        year = spotify.year_of(pl["name"])
        if pl["kind"] == "yearbook" and year:
            source = (f"Spotify web player, the owner's playlist \"{pl['name']}\", read off the rendered page "
                      f"on {pl['captured']} (scripts/spotify_history.py)")
            books.append(spotify.write_yearbook(year, pl["name"], source,
                                                yearbook_items(pl, m), pl.get("expected"), write))
    private_commit = commit_private(f"build: {len(m['songs'])} songs, {len(m['playlists'])} playlists") if write else None
    return {"songs": len(m["songs"]), "playlists": len(m["playlists"]), "changed": len(changed),
            "removed": len(removed), "yearbooks": books, "written": write, "private_commit": private_commit}


# --- The gate. --------------------------------------------------------------------------------

def schema(name: str) -> dict:
    return json.loads((SCHEMA_DIR / f"spotify-{name}.schema.json").read_text(encoding="utf-8"))


def find_private_keys(value, where: str = "") -> list[str]:
    found = []
    if isinstance(value, dict):
        for k, v in value.items():
            if k in PRIVATE_KEYS:
                found.append(f"{where}.{k}" if where else k)
            found += find_private_keys(v, f"{where}.{k}" if where else k)
    elif isinstance(value, list):
        for i, v in enumerate(value):
            found += find_private_keys(v, f"{where}[{i}]")
    return found


def tracked(path: str) -> list[str]:
    try:
        out = subprocess.run(["git", "ls-files", "--", path], cwd=ROOT, capture_output=True, text=True, check=True)
    except (OSError, subprocess.CalledProcessError):
        return []
    return [line for line in out.stdout.splitlines() if line]


def check() -> list[str]:
    errors: list[str] = []
    rel = PRIVATE.relative_to(ROOT).as_posix()
    for leaked in tracked(rel):
        errors.append(f"{leaked}: private Spotify data is tracked by git (ADR 0007): git rm --cached it")
    ignore = (ROOT / ".gitignore").read_text(encoding="utf-8") if (ROOT / ".gitignore").exists() else ""
    if not ({f"/{rel}", f"/{rel}/"} & set(ignore.split())):
        errors.append(f".gitignore: must ignore /{rel}/ (ADR 0007)")
    schemas = {k: schema(k) for k in ("track", "playlist", "library")}
    for v in schemas.values():
        for bad in cat.unsupported(v):
            errors.append(f"schema keyword not supported by the validator: {bad}")
    ids: dict[str, set] = {"track": set(), "playlist": set()}
    metas: dict[str, list] = {"track": [], "playlist": []}
    for kind, folder in (("track", BASE / "tracks"), ("playlist", BASE / "playlists")):
        for path in sorted(folder.glob("*.md")) if folder.exists() else []:
            name = path.relative_to(ROOT).as_posix()
            try:
                meta, _ = load_record(path.read_text(encoding="utf-8"), name)
            except HistoryError as exc:
                errors.append(str(exc))
                continue
            errors += [f"{name}: {p}" for p in cat.validate(meta, schemas[kind])]
            errors += [f"{name}: '{k}' is private and never committed (ADR 0007)" for k in find_private_keys(meta)]
            if meta.get("id") != path.stem:
                errors.append(f"{name}: id '{meta.get('id')}' must equal the file name")
            ids[kind].add(path.stem)
            metas[kind].append((name, meta))
    for name, meta in metas["track"]:
        if meta.get("review") and not (cat.CONTENT / meta["review"]).is_file():
            errors.append(f"{name}: review={meta['review']} names no review")
        for e in meta.get("playlists") or []:
            if e.get("playlist") not in ids["playlist"]:
                errors.append(f"{name}: playlist '{e.get('playlist')}' has no record")
    for name, meta in metas["playlist"]:
        for t in meta.get("tracks") or []:
            if t.get("track") and t["track"] not in ids["track"]:
                errors.append(f"{name} #{t.get('n')}: track '{t['track']}' has no record")
    lib = BASE / "library.md"
    if lib.exists():
        try:
            meta, _ = load_record(lib.read_text(encoding="utf-8"), "data/spotify/library.md")
            errors += [f"data/spotify/library.md: {p}" for p in cat.validate(meta, schemas["library"])]
            errors += [f"data/spotify/library.md: '{k}' is private (ADR 0007)" for k in find_private_keys(meta)]
        except HistoryError as exc:
            errors.append(str(exc))
    # With the private sources present (the owner's machine), the records must be current.
    if SNAPSHOTS.exists() and any(SNAPSHOTS.glob("*.json")):
        try:
            report = build(write=False)
            if report["changed"] or report["removed"]:
                errors.append(f"data/spotify: {report['changed']} record(s) stale, {report['removed']} leftover: "
                              "run python3 scripts/spotify_history.py build --write")
            stale = [b["file"] for b in report["yearbooks"] if b["changed"]]
            if stale:
                errors.append(f"yearbooks stale: {', '.join(stale)}: run python3 scripts/spotify_history.py build --write")
        except HistoryError as exc:
            errors.append(str(exc))
    return errors


def stats() -> dict:
    out = {"tracks": 0, "liked": 0, "reviewed": 0, "ambiguous": 0, "playlists": defaultdict(int), "years": []}
    for path in sorted((BASE / "tracks").glob("*.md")) if (BASE / "tracks").exists() else []:
        meta, _ = load_record(path.read_text(encoding="utf-8"), path.name)
        out["tracks"] += 1
        out["liked"] += bool(meta.get("liked"))
        out["reviewed"] += bool(meta.get("review"))
        out["ambiguous"] += meta.get("status") == "ambiguous"
    for path in sorted((BASE / "playlists").glob("*.md")) if (BASE / "playlists").exists() else []:
        meta, _ = load_record(path.read_text(encoding="utf-8"), path.name)
        out["playlists"][meta["kind"]] += 1
        if meta.get("year"):
            out["years"].append(meta["year"])
    out["playlists"] = dict(out["playlists"])
    out["years"] = sorted(out["years"])
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=(__doc__ or "").split("\n")[0])
    ap.add_argument("--check", action="store_true", help="the gate: records valid, nothing private committed")
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("ingest-snapshot", help="keep a web-player snapshot in the private store")
    s.add_argument("file", type=Path)
    s.add_argument("--plain", type=Path, help="a full liked-songs reading without ids, to complete a short one")
    e = sub.add_parser("import-export", help="keep Spotify's account data export in the private store")
    e.add_argument("folder", type=Path)
    b = sub.add_parser("build", help="derive every record (and the yearbooks) from the private store")
    b.add_argument("--write", action="store_true")
    sub.add_parser("stats", help="what the committed history holds")
    args = ap.parse_args()
    try:
        if args.check:
            errors = check()
            for err in errors:
                print(f"spotify-history: {err}", file=sys.stderr)
            if not errors:
                print(f"spotify-history: ok ({json.dumps(stats())})")
            return 1 if errors else 0
        if args.cmd == "ingest-snapshot":
            print(ingest_snapshot(args.file, args.plain).relative_to(ROOT).as_posix())
        elif args.cmd == "import-export":
            print(json.dumps(import_export(args.folder), indent=1))
        elif args.cmd == "build":
            print(json.dumps(build(args.write), indent=1, ensure_ascii=False))
        elif args.cmd == "stats":
            print(json.dumps(stats(), indent=1))
        else:
            ap.print_help()
            return 2
    except HistoryError as exc:
        print(f"spotify-history: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
