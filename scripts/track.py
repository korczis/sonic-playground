#!/usr/bin/env python3
"""The track engine: from a YouTube link or "Artist - Track" to a new review that fits the site.

Everything it writes is inferred or derived, never made up:

  - resolve   the input: a YouTube URL (watch, youtu.be, embed, shorts, music) gives the video id,
              and YouTube's oEmbed gives the video title and channel, from which the artist and
              the track are inferred (decorations such as "(Official Video)" dropped, remixes and
              features kept; the channel decides which side of a separator is the artist); a
              name "Artist - Track" is split the same way;
  - identity  the file name content/<slug(artist track)>.md, artist first, exactly what
              scripts/catalog.py infers the artist back from; an existing track (same video,
              same artist and track, same file, drafts included) is reported, never duplicated;
  - facets    the terms given are normalised and checked against the corpus vocabulary, with
              the nearest existing term suggested for each new one;
  - related   the tracks the new one would sit next to (the catalogue's similarity);
  - outline   the sections the corpus shares, in their usual order (catalogue "outline"), each
              with the guidance of data/review.toml as a TODO(write) line;
  - article   archetypes/track.md filled in, then proved before it is written: it parses, it
              validates against data/track.schema.json, and the catalogue infers the same artist
              and track from it (otherwise extra.artist/extra.track are written to pin them).

The prose is the writer's: the skill add-song (.ai/repo/skills/add-song/SKILL.md) researches
the track and replaces every TODO(write); `check` then proves the article meets the contract.

    python3 scripts/track.py resolve "<link or Artist - Track>" [--offline]
    python3 scripts/track.py new "<link or Artist - Track>" --genre g ... --sentiment s ...
                             [--mood m ...] [--description "..."] [--artist A]
                             [--track T] [--youtube URL] [--date YYYY-MM-DD] [--dry-run]
                             [--offline] [--force]
    python3 scripts/track.py refresh content/<file>.md [--youtube URL] [--album A]
                             [--release-year YYYY] [--publisher P]   (prose untouched)
    python3 scripts/track.py check content/<file>.md
    python3 scripts/track.py enrich content/<file>.md [--write] [--force] [--offline]
    python3 scripts/track.py audit-mb [content/<file>.md ...] [--fix] [--offline]
    python3 scripts/track.py vocab [--facet genre] [--limit N]
    python3 scripts/track.py suggest --genre g ... --sentiment s ...
    python3 scripts/track.py outline
    python3 scripts/track.py versions content/<file>.md [--query Q ...] [--json] [--refresh]
                             [--write --pick ID[:kind] ...]   (extra.versions from YouTube)
    python3 scripts/track.py versions content/<file>.md --verify | --verify --all
  --oembed-fixture <file.json> answers oEmbed from a file ({"<video id>": {"title", "author_name"}})

Every command prints JSON. Exit codes: 0 ok, 1 contract violation or unfinished article,
2 usage, 3 the track exists.
"""
from __future__ import annotations

import argparse
import atexit
import difflib
import json
import os
import re
import sys
import tempfile
import time
import tomllib
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path
from string import Template
from typing import NoReturn

sys.path.insert(0, str(Path(__file__).resolve().parent))
import catalog as cat  # noqa: E402  (the same inference and contract the build uses)
import youtube as yt  # noqa: E402  (YouTube's search and watch pages as data, never streams)

ROOT = cat.ROOT
ARCHETYPE = ROOT / "archetypes" / "track.md"
REVIEW = ROOT / "data" / "review.toml"
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
DECORATION = re.compile(
    r"\s*[\(\[][^)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|mv|clip|"
    r"music video|full album|remaster(?:ed)?(?: \d{4})?)\b[^)\]]*[\)\]]",
    re.I)
# Only suffixes YouTube itself adds to a channel name; "Roxy Music" stays "Roxy Music".
CHANNEL_NOISE = re.compile(r"\s*(?:-\s*topic|vevo)\s*$", re.I)
SEPARATORS = (" - ", " – ", " — ", " | ")


def out(data: dict) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=1))


def fail(message: str, code: int = 2) -> NoReturn:
    print(json.dumps({"error": message}, ensure_ascii=False), file=sys.stderr)
    sys.exit(code)


def youtube_id(text: str | None) -> str | None:
    """The video id of any YouTube URL form, or None."""
    if not text:
        return None
    text = text.strip()
    if VIDEO_ID.match(text):
        return None  # a bare 11-character word is a name, not a link
    try:
        url = urllib.parse.urlparse(text if "//" in text else "https://" + text)
    except ValueError:
        return None
    host = (url.hostname or "").removeprefix("www.").removeprefix("m.").removeprefix("music.")
    candidate = None
    if host == "youtu.be":
        candidate = url.path.strip("/").split("/")[0]
    elif host in ("youtube.com", "youtube-nocookie.com"):
        query = urllib.parse.parse_qs(url.query)
        if "v" in query:
            candidate = query["v"][0]
        else:
            parts = url.path.strip("/").split("/")
            if len(parts) >= 2 and parts[0] in ("embed", "shorts", "live", "v"):
                candidate = parts[1]
    return candidate if candidate and VIDEO_ID.match(candidate) else None


def oembed(video: str, args) -> dict:
    fixture = getattr(args, "oembed_fixture", None)
    if fixture:
        data = json.loads(Path(fixture).read_text(encoding="utf-8")).get(video)
        if data is None:
            return {"error": "not in the oEmbed fixture"}
        return {"title": data.get("title", ""), "author": data.get("author_name", "")}
    if getattr(args, "offline", False):
        return {}
    url = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(
        f"https://www.youtube.com/watch?v={video}", safe="")
    request = urllib.request.Request(url, headers={"User-Agent": "sonic-playground-track-engine"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            data = json.loads(response.read().decode("utf-8"))
            return {"title": data.get("title", ""), "author": data.get("author_name", "")}
    except urllib.error.HTTPError as exc:
        return {"error": f"oEmbed HTTP {exc.code} (video removed, private or not embeddable)"}
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        return {"error": f"oEmbed unreachable: {exc}"}


def clean(text: str) -> str:
    return re.sub(r"\s{2,}", " ", DECORATION.sub("", text)).strip(" -|·")


def fold(text: str) -> str:
    return "".join(cat.words(text))


def split_name(name: str, channel: str = "") -> tuple[str, str]:
    """(artist, track) from a title. The channel, when known, decides which side of the first
    separator is the artist; without it 'Artist - Track' and 'Track | Artist' (the corpus
    conventions) apply. A title without a separator is the track, the channel the artist."""
    name = clean(name)
    artist_hint = fold(CHANNEL_NOISE.sub("", channel))
    for sep in SEPARATORS:
        if sep in name:
            left, right = (p.strip() for p in name.split(sep, 1))
            if artist_hint:
                # An exact match decides; a prefix match decides only when one side alone has it.
                if fold(left) == artist_hint and fold(right) != artist_hint:
                    return left, right
                if fold(right) == artist_hint and fold(left) != artist_hint:
                    return right, left

                def prefixed(side: str) -> bool:
                    f = fold(side)
                    return bool(f) and (f.startswith(artist_hint) or artist_hint.startswith(f))

                if prefixed(left) != prefixed(right):
                    return (left, right) if prefixed(left) else (right, left)
            return (right, left) if sep == " | " else (left, right)
    artist = CHANNEL_NOISE.sub("", channel).strip()
    if artist and name.lower().startswith(artist.lower()):
        # "alt-J (∆) Breezeblocks" from the channel "alt-J": the title repeats the artist.
        rest = re.sub(r"^\s*[\(\[][^)\]]*[\)\]]", "", name[len(artist):]).strip(" -:|")
        if rest:
            return artist, rest
    return artist, name


def corpus() -> list[dict]:
    """Every article's identity, drafts and unparseable files included (so nothing is ever
    overwritten): file, title, inferred artist and track, video id."""
    found = []
    for path in cat.review_files():
        entry = {"source": f"content/{path.name}", "stem": path.stem, "artist": "", "track": "",
                 "youtube": None, "title": "", "draft": False}
        try:
            raw, _ = cat.split_front_matter(path.read_text(encoding="utf-8"), path.name)
            meta = tomllib.loads(raw)
        except (ValueError, tomllib.TOMLDecodeError):
            found.append(entry)
            continue
        # A draft may be malformed in any way TOML allows; read only what has the right type.
        raw_extra, raw_title = meta.get("extra"), meta.get("title")
        extra: dict = raw_extra if isinstance(raw_extra, dict) else {}
        title: str = raw_title if isinstance(raw_title, str) else ""
        artist, track, _ = cat.infer_artist_track(title, path.stem)
        match = cat.YOUTUBE_ID.search(str(extra.get("youtube", "")))
        entry.update(title=title,
                     artist=extra["artist"] if isinstance(extra.get("artist"), str) else artist,
                     track=extra["track"] if isinstance(extra.get("track"), str) else track,
                     draft=meta.get("draft") is True,
                     youtube=match.group(1) if match else None)
        found.append(entry)
    return found


def resolve(text: str, args) -> dict:
    link = youtube_id(text)
    video = link or youtube_id(getattr(args, "youtube", None))
    meta = oembed(video, args) if video else {}
    if link:
        kind = "youtube"
        artist, track = split_name(meta.get("title", ""), meta.get("author", ""))
    else:
        kind = "name"
        artist, track = split_name(text)
    artist = (getattr(args, "artist", None) or artist).strip()
    track = (getattr(args, "track", None) or track).strip()
    slug = cat.slugify(f"{artist} {track}") if artist and track else ""

    existing = None
    for e in corpus():
        same_video = bool(video) and e["youtube"] == video
        same_name = bool(artist and track) and (fold(e["artist"]), fold(e["track"])) == (
            fold(artist), fold(track))
        same_file = bool(slug) and cat.slugify(e["stem"]) == slug
        if same_video or same_name or same_file:
            why = "same video" if same_video else "same artist and track" if same_name else "same file"
            existing = {"source": e["source"], "title": e["title"], "draft": e["draft"], "why": why}
            break
    problems = []
    if not (artist and track):
        problems.append("cannot infer both artist and track; pass --artist and --track")
    elif not slug:
        problems.append("the name has no Latin letters to build a file name from; pass a "
                        "transliterated --artist/--track (the original can stay in the title)")
    return {
        "input": text, "kind": kind, "youtube": video, "oembed": meta,
        "artist": artist, "track": track, "title": f"{artist} - {track}" if artist else track,
        "file": f"content/{slug}.md" if slug else "", "exists": existing,
        "complete": not problems, "problems": problems,
    }


def vocabulary() -> dict[str, dict[str, int]]:
    data = json.loads(cat.OUTPUT.read_text(encoding="utf-8"))
    return {f: {x["term"]: x["count"] for x in data["facets"][f]} for f in cat.FACETS}


def suggest(facets: dict[str, list[str]]) -> dict:
    vocab = vocabulary()
    result = {}
    for facet, terms in facets.items():
        rows = []
        for raw in terms:
            term = raw.strip().lower()
            known = term in vocab[facet]
            near = [] if known else difflib.get_close_matches(term, list(vocab[facet]), n=3, cutoff=0.6)
            rows.append({"term": term, "known": known, "uses": vocab[facet].get(term, 0),
                         "nearest": near})
        result[facet] = rows
    return result


def loaded_tracks() -> list:
    errors: list[str] = []
    return [t for t in (cat.load_track(p, errors) for p in cat.review_files()) if t]


def related_preview(facets: dict[str, list[str]]) -> list[dict]:
    tracks = loaded_tracks()
    by_source = {t.source: t for t in tracks}
    return [{**r, "title": by_source[r["source"]].title} for r in cat.related_to(facets, tracks)]


def toml_string(value: str) -> str:
    """A complete TOML basic string (JSON string syntax is a subset TOML accepts)."""
    return json.dumps(value, ensure_ascii=False)


def toml_list(terms: list[str]) -> str:
    return "[" + ", ".join(toml_string(t) for t in terms) + "]"


def render_body(outline: list[dict]) -> str:
    review = tomllib.loads(REVIEW.read_text(encoding="utf-8"))
    sections = review.get("sections", {})
    default = review["defaults"]["guidance"]
    marker = cat.UNFINISHED
    chunks = []
    # A required section the outline does not have yet goes after its anchor (or last).
    names = [s["name"] for s in outline]
    outline = list(outline)
    for name, conf in sections.items():
        if conf.get("required") and name not in names:
            anchor = conf.get("after")
            at = names.index(anchor) + 1 if anchor in names else len(outline)
            outline.insert(at, {"name": name, "subsections": []})
            names.insert(at, name)
    for s in outline:
        conf = sections.get(s["name"], {})
        heading = conf.get("heading", s["name"].title())
        chunks.append(f"## {heading}\n\n{marker}: {conf.get('guidance', default)}\n")
        parts = conf.get("parts", {})
        for sub in s["subsections"]:
            chunks.append(f"### {parts.get(sub, sub.title())}\n\n{marker}: one short paragraph.\n")
    return "\n".join(chunks)


def render(plan: dict, facets: dict, args, pin: bool) -> str:
    catalog = json.loads(cat.OUTPUT.read_text(encoding="utf-8"))
    extra = []
    if plan["youtube"]:
        extra.append(f'youtube = "https://www.youtube.com/embed/{plan["youtube"]}"')
    if pin:
        extra.append(f"artist = {toml_string(plan['artist'])}")
        extra.append(f"track = {toml_string(plan['track'])}")
    description = args.description or f"{cat.UNFINISHED}: one or two sentences on the vibe of the track."
    return Template(ARCHETYPE.read_text(encoding="utf-8")).substitute(
        title=toml_string(plan["title"])[1:-1],
        date=args.date or date.today().isoformat(),
        description=toml_string(" ".join(description.split()))[1:-1],
        taxonomies="\n".join(f"{f} = {toml_list(t)}" for f, t in facets.items() if t),
        extra="\n".join(extra),
        body=render_body(catalog["outline"]),
    )


def prove(text: str, name: str, plan: dict) -> tuple[list[str], tuple[str, str]]:
    """Parse, validate and re-infer the rendered article exactly as the build will."""
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / name
        path.write_text(text, encoding="utf-8")
        old = cat.CONTENT
        cat.CONTENT = Path(tmp)
        try:
            errors: list[str] = []
            track = cat.load_track(path, errors, include_drafts=True)
        finally:
            cat.CONTENT = old
    errors = [e for e in errors if cat.UNFINISHED not in e]  # the skeleton is unfinished by design
    inferred = (track.artist, track.track) if track else ("", "")
    return errors, inferred


def new(text: str, args) -> int:
    if args.date:
        try:
            date.fromisoformat(args.date)
        except ValueError:
            fail(f"--date must be YYYY-MM-DD, got {args.date}")
    plan = resolve(text, args)
    if not plan["complete"]:
        fail("; ".join(plan["problems"]))
    target = cat.CONTENT / Path(plan["file"]).name
    if (plan["exists"] or target.exists()) and not args.force:
        out({**plan, "written": False,
             "hint": "refresh the existing review (scripts/track.py refresh) instead of a second one"})
        return 3
    facets = {f: [t.strip().lower() for t in (getattr(args, f, None) or [])] for f in cat.FACETS}
    if not facets["genre"] or not facets["sentiment"]:
        fail("--genre and --sentiment are required (see: scripts/track.py vocab)")

    text_out = render(plan, facets, args, pin=False)
    errors, inferred = prove(text_out, target.name, plan)
    pinned = False
    if not errors and inferred != (plan["artist"], plan["track"]):
        # The catalogue would read the title differently: pin the resolved identity.
        text_out = render(plan, facets, args, pin=True)
        errors, inferred = prove(text_out, target.name, plan)
        pinned = True
    if errors or inferred != (plan["artist"], plan["track"]):
        out({**plan, "written": False, "errors": errors, "inferred": inferred})
        return 1

    catalog = json.loads(cat.OUTPUT.read_text(encoding="utf-8"))
    result = {**plan, "facets": suggest(facets), "related": related_preview(facets),
              "outline": [s["name"] for s in catalog["outline"]],
              "median_words": catalog["stats"]["median_words"], "identity_pinned": pinned,
              "written": not args.dry_run}
    if args.dry_run:
        result["preview"] = text_out
    else:
        with open(target, "w" if args.force else "x", encoding="utf-8") as handle:
            handle.write(text_out)
    out(result)
    return 0


def content_path(path: str) -> Path:
    file = (ROOT / path).resolve() if not Path(path).is_absolute() else Path(path).resolve()
    if file.parent != cat.CONTENT.resolve() or file.suffix != ".md" or not file.is_file():
        fail(f"{path} is not an article in content/")
    return cat.CONTENT / file.name  # as the catalogue names it (symlinked temp dirs included)


def refresh(path: str, args) -> int:
    """Update what a review references without touching its prose: the video, album, year,
    label. Each value replaces the existing key in [extra] or is added to it."""
    file = content_path(path)
    text = file.read_text(encoding="utf-8")
    raw, body = cat.split_front_matter(text, file.name)
    updates = {}
    if args.youtube:
        video = youtube_id(args.youtube)
        if not video:
            fail(f"not a YouTube link: {args.youtube}")
        updates["youtube"] = f"https://www.youtube.com/embed/{video}"
    for key in ("album", "release_year", "publisher"):
        value = getattr(args, key)
        if value:
            updates[key] = value
    if not updates:
        fail("nothing to refresh: pass --youtube, --album, --release-year or --publisher")
    return write_extra(file, path, updates)


def toml_value(value) -> str:
    """A TOML value for [extra]: strings, integers, booleans, lists and inline tables."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return toml_string(value)
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{ " + ", ".join(f"{k} = {toml_value(v)}" for k, v in value.items()) + " }"
    raise TypeError(f"no TOML form for {type(value).__name__}")


def write_extra(file: Path, path: str, updates: dict, quiet: bool = False) -> int:
    """Set keys of [extra] (replace or add), prove the article still meets the contract and now
    says what was asked, then write it. The prose is never touched."""
    text = file.read_text(encoding="utf-8")
    raw, body = cat.split_front_matter(text, file.name)
    lines = raw.splitlines()
    if "[extra]" not in (line.strip() for line in lines):
        lines.append("")
        lines.append("[extra]")
    start = next(i for i, line in enumerate(lines) if line.strip() == "[extra]")
    for key, value in updates.items():
        new_line = f"{key} = {toml_value(value)}"
        pattern = re.compile(rf"^\s*#?\s*{key}\s*=")
        end = next((i for i in range(start + 1, len(lines)) if lines[i].lstrip().startswith("[")),
                   len(lines))  # [extra] ends at the next table or at the end
        hit = next((i for i in range(start + 1, end) if pattern.match(lines[i])), None)
        if hit is None:
            lines.insert(start + 1, new_line)
        else:
            lines[hit] = new_line
    rewritten = "+++\n" + "\n".join(lines) + "\n+++\n" + body
    errors, _ = prove(rewritten, file.name, {})
    if not errors:
        # Prove the article now says what was asked, not just that it still parses.
        extra = tomllib.loads(cat.split_front_matter(rewritten, file.name)[0]).get("extra", {})
        errors = [f"extra.{k} is {extra.get(k)!r} after the rewrite, not {v!r}"
                  for k, v in updates.items() if extra.get(k) != v]
    if errors:
        if not quiet:
            out({"file": path, "written": False, "errors": errors})
        return 1
    file.write_text(rewritten, encoding="utf-8")
    if not quiet:
        out({"file": path, "written": True, "updated": updates})
    return 0


# --- MusicBrainz: identifiers and facts a review should not have to type. --------------------

MB = "https://musicbrainz.org/ws/2/"
MB_AGENT = "sonic-playground/1.0 (+https://github.com/korczis/sonic-playground)"
MB_CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "sonic-playground" / "musicbrainz.json"


def mb_cache() -> dict:
    """The MusicBrainz cache; a missing or unreadable file is an empty cache, never an error."""
    try:
        return json.loads(MB_CACHE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


_mb_last = [0.0]
_mb_seen: dict[str, dict] = {}  # per cache file: what this process has read or fetched


def mb_get(url: str, args) -> dict:
    """GET a MusicBrainz JSON document: from the fixture (tests), the cache (outside the
    repository), or the API at most once a second, as its terms ask."""
    if getattr(args, "mb_fixture", None):
        data = json.loads(Path(args.mb_fixture).read_text(encoding="utf-8"))
        return data.get(url, {})
    seen = _mb_seen.get(str(MB_CACHE))
    if seen is None:  # the cache is parsed once per process, not once per answer
        seen = _mb_seen[str(MB_CACHE)] = mb_cache()
    if url in seen:
        return seen[url]
    if getattr(args, "offline", False):
        raise MBOffline(f"not in the MusicBrainz cache: {url}")
    wait = 1.1 - (time.monotonic() - _mb_last[0])
    if wait > 0:
        time.sleep(wait)
    request = urllib.request.Request(url, headers={"User-Agent": MB_AGENT, "Accept": "application/json"})
    data: dict = {}
    for attempt in range(6):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.loads(response.read().decode("utf-8"))
            if "error" in data and attempt < 5:  # "the web server is currently busy": retry, never cache
                time.sleep(2 ** attempt * 2)
                continue
            break
        except urllib.error.HTTPError as exc:
            if exc.code in (429, 503) and attempt < 5:
                # The service's rate limit: wait as long as it asks (else back off), then retry.
                after = exc.headers.get("Retry-After", "") if exc.headers else ""
                time.sleep(min(int(after) if after.isdigit() else 2 ** attempt * 2, 30))
                continue
            if exc.code == 404:
                data = {}
                break
            raise
    _mb_last[0] = time.monotonic()
    if "error" in data:  # still busy after every retry: an answer about the service, not the query
        raise RuntimeError(f"MusicBrainz is busy, not cached: {url}")
    seen[url] = data
    _mb_pending[url] = data
    if len(_mb_pending) >= MB_FLUSH_EVERY:
        mb_flush()
    return data


MB_FLUSH_EVERY = 25  # answers held before the cache file (tens of MB) is rewritten
_mb_pending: dict[str, dict] = {}


def mb_flush() -> None:
    """Merge this process's new answers into the cache file. The read, merge and replace run
    under an exclusive lock, so two writers running side by side never drop each other's
    answers; the replace is atomic, so a reader never sees half a file."""
    if not _mb_pending:
        return
    import fcntl

    MB_CACHE.parent.mkdir(parents=True, exist_ok=True)
    with open(MB_CACHE.with_name(f"{MB_CACHE.name}.lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        cache = {**mb_cache(), **_mb_pending}
        tmp = MB_CACHE.with_name(f"{MB_CACHE.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, MB_CACHE)
    _mb_pending.clear()


atexit.register(mb_flush)


def mb_quote(text: str) -> str:
    return '"' + re.sub(r'([+\-&|!(){}\[\]^"~*?:\\/])', r"\\\1", text) + '"'


def seconds(text: str | None) -> int | None:
    """'m:ss' or 'h:mm:ss' in seconds; anything else is unknown."""
    if not text or not re.fullmatch(r"(\d{1,2}:)?\d{1,2}:\d{2}", text):
        return None
    total = 0
    for part in text.split(":"):
        total = total * 60 + int(part)
    return total


def mmss(value: int | None) -> str:
    return "?" if value is None else f"{value // 60}:{value % 60:02d}"


# --- Which recording and release a review is about. ------------------------------------------
#
# A search finds many recordings of one song: the album track, DJ-mix and live copies, music
# videos, instrumentals, excerpts. The review is about the one its own facts name: the length of
# its Spotify recording (data/spotify, ADR 0007), the album it names, and failing those the
# earliest Official release. Whatever those facts cannot tell apart is left out, never guessed.

WINDOW = 3  # seconds a recording's length may differ from the review's known duration
VIDEO_WINDOW = 30  # a video's length is only a hint: intros and outros make it longer
SPOTIFY = ROOT / "data" / "spotify"
VARIOUS = "89ad4ac3-39f7-470e-963a-56509c546377"  # MusicBrainz's "Various Artists"
# Versions a review is not about unless its own track title or album says so.
MARKERS = {
    "live": re.compile(r"\b(live|unplugged|in concert)\b"),
    "dj-mix": re.compile(r"\b(dj-?mix(ed)?|mixed by|continuous mix|mix ?cut)\b"),
    "instrumental": re.compile(r"\binstrumentals?\b"),
    "excerpt": re.compile(r"\b(excerpt|snippet)\b"),
    "karaoke": re.compile(r"\bkaraoke\b"),
    "a cappella": re.compile(r"\b(a ?cappella|acapella)\b"),
}
# Release-group secondary types that are a version of their own, and the marker each means.
MARKED_TYPES = {"Live": "live", "DJ-mix": "dj-mix", "Mixtape/Street": "dj-mix"}
DASHES = re.compile(r"[‐-―−]")
EDITION = re.compile(r"\s*[\(\[][^)\]]*[\)\]]|\s+-\s+.*$")
PRIMARY = {"Album": 0, "EP": 1, "Single": 2}
RECORDING_FLAGS = ("missing", "length", "version", "video", "only-on")


class MBOffline(LookupError):
    """--offline and the answer is not in the cache."""


def markers(text: str) -> set[str]:
    text = DASHES.sub("-", text.lower())
    return {name for name, rx in MARKERS.items() if rx.search(text)}


def marks(text: str, allowed: str = "") -> set[str]:
    """The version markers of text (live, DJ-mix, instrumental, excerpt, karaoke, a cappella)
    that allowed (the review's own title or album) does not carry itself."""
    return markers(text) - markers(allowed)


_spotify: dict[str, dict[str, list[dict]]] = {}


def spotify_rows(name: str) -> list[dict]:
    """The rows of the owner's Spotify history (data/spotify/tables/tracks.jsonl) whose review
    is this page; a missing or unreadable table is no rows."""
    key = str(SPOTIFY)
    if key not in _spotify:
        by_review: dict[str, list[dict]] = {}
        try:
            lines = (SPOTIFY / "tables" / "tracks.jsonl").read_text(encoding="utf-8").splitlines()
            for line in lines:
                row = json.loads(line) if line.strip() else {}
                if row.get("review"):
                    by_review.setdefault(row["review"], []).append(row)
        except (OSError, ValueError):
            by_review = {}
        _spotify[key] = by_review
    return _spotify[key].get(name, [])


def spotify_facts(name: str, track: str) -> dict:
    """The duration and album(s) the owner's Spotify history gives a review, from its rows that
    are the song itself (an instrumental or live row its title does not name is left out).
    Durations that disagree by more than WINDOW give none."""
    rows = [r for r in spotify_rows(name)
            if not marks(f"{r.get('title', '')} {r.get('album', '')}", track)]
    found = sorted({d for d in (seconds(r.get("duration")) for r in rows) if d})
    albums = sorted({r["album"] for r in rows if r.get("album")})
    if not found:
        return {"albums": albums}
    if found[-1] - found[0] > WINDOW:
        return {"albums": albums,
                "note": "Spotify durations disagree: " + ", ".join(mmss(d) for d in found)}
    return {"albums": albums, "duration": found[0]}


def page_facts(t) -> dict:
    """What a review says about its recording: artist, track, album (else Spotify's), the
    artist's country, and the known duration with its source (Spotify; else the video's, which
    is only a hint)."""
    extra = t.full_extra
    album = extra.get("album") if isinstance(extra.get("album"), str) else ""
    spotify = spotify_facts(Path(t.source).name, t.track)
    video = seconds(extra.get("video_duration")) if isinstance(extra.get("video_duration"),
                                                              str) else None
    duration, source = (spotify["duration"], "spotify") if spotify.get("duration") else (
        (video, "video") if video else (None, ""))
    return {"artist": t.artist, "track": t.track,
            "albums": [album] if album else spotify.get("albums", []),
            "album_source": "page" if album else ("spotify" if spotify.get("albums") else ""),
            "duration": duration, "duration_source": source,
            "country": extra.get("country") if isinstance(extra.get("country"), str) else "",
            "notes": [spotify["note"]] if spotify.get("note") else []}


def album_tier(title: str, albums: list[str]) -> int:
    """0 the release is titled as the album (folded), 1 the same once edition qualifiers such
    as "(Deluxe Edition)" or " - Remastered" are dropped, 2 another title or no album known."""
    if any(fold(a) and fold(title) == fold(a) for a in albums):
        return 0
    bare = fold(EDITION.sub("", title))
    return 1 if bare and any(bare == fold(EDITION.sub("", a)) for a in albums) else 2


def release_flags(rel: dict, albums: list[str], track: str = "") -> list[str]:
    """Why a release is not one a review would name: a status other than Official (bootleg,
    promotion, none), or a live, DJ-mix, instrumental, excerpt, karaoke or a cappella edition
    (by its release group, title or disambiguation) that neither the review's album nor its
    track title names (a review of a live or instrumental version keeps such releases)."""
    status = rel.get("status")
    flags = [] if status == "Official" else [(status or "no status").lower()]
    group = rel.get("release-group") or {}
    kinds = {MARKED_TYPES[t] for t in group.get("secondary-types") or [] if t in MARKED_TYPES}
    kinds |= markers(f"{rel.get('title', '')} {rel.get('disambiguation') or ''}")
    return flags + sorted(kinds - markers(" ".join([*albums, track])))


def is_compilation(rel: dict) -> bool:
    group = rel.get("release-group") or {}
    return ("Compilation" in (group.get("secondary-types") or [])
            or any((c.get("artist") or {}).get("id") == VARIOUS
                   for c in rel.get("artist-credit") or [] if isinstance(c, dict)))


def date_key(value: str | None) -> str:
    """A release date for sorting: a year or month alone sorts after every full date in it."""
    if not value or not re.fullmatch(r"\d{4}(-\d{2}){0,2}", value):
        return "9999-99-99"
    return (value + "-99-99")[:10]


def first_year(releases: list[dict], albums: list[str], track: str = "") -> str:
    first = min((date_key(r.get("date")) for r in releases
                 if not release_flags(r, albums, track)),
                default="9999")
    return "" if first.startswith("9999") else first[:4]


def pick_release(releases: list[dict], albums: list[str], country: str = "",
                 track: str = "") -> dict:
    """The release a review names among its recording's: Official and not another version,
    titled as the review's album (folded), not a compilation, earliest; then the artist's
    country, then worldwide, an album before an EP or single. Pressings that still tie are one
    release (the lowest id wins); different titles that still tie, an album no release is
    titled as, or only compilations without an album are ambiguous: no release, and why."""
    usable = [r for r in releases if not release_flags(r, albums, track)]
    if not usable:
        return {"release": "", "why": "no Official release of the recording that is not live, "
                "a DJ-mix, an instrumental or an excerpt"}
    if albums:
        usable = [r for r in usable if album_tier(r.get("title", ""), albums) < 2]
        if not usable:
            return {"release": "", "why": "no Official release of the recording is titled "
                    + " or ".join(repr(a) for a in albums)}

    def key(r: dict) -> tuple:
        group = r.get("release-group") or {}
        place = 0 if country and r.get("country") == country else (
            1 if r.get("country") == "XW" else 2)
        return (album_tier(r.get("title", ""), albums), is_compilation(r),
                date_key(r.get("date")), place, PRIMARY.get(group.get("primary-type") or "", 3),
                r.get("id", ""))

    usable.sort(key=key)
    best = usable[0]
    tied = {r.get("title", "") for r in usable if key(r)[:-1] == key(best)[:-1]}
    if len({fold(t) for t in tied}) > 1:
        return {"release": "", "why": "releases tie: " + ", ".join(sorted(tied))}
    if not albums and is_compilation(best):
        return {"release": "", "why": "only compilations carry the recording and the review "
                "names no album"}
    return {"release": best["id"], "title": best.get("title", ""), "date": best.get("date", ""),
            "why": ""}


def main_artist(artist: str) -> str:
    return re.split(r",| feat\.? | & | x ", artist, maxsplit=1)[0].strip()


def song_title(track: str) -> str:
    return re.sub(r"\s*\((feat\.|ft\.)[^)]*\)", "", track).strip()


def credits_of(r: dict) -> list[dict]:
    return [c for c in r.get("artist-credit") or [] if isinstance(c, dict) and c.get("artist")]


def credit_id(r: dict, artist: str) -> str:
    """The id of the review's main artist among a recording's credits (else the first)."""
    want = fold(main_artist(artist))
    credits = credits_of(r)
    exact = [c["artist"]["id"] for c in credits
             if want in (fold(c.get("name", "")), fold(c["artist"].get("name", "")))]
    return exact[0] if exact else (credits[0]["artist"]["id"] if credits else "")


def length_of(r: dict) -> int | None:
    return round(r["length"] / 1000) if r.get("length") else None


def within(length: int | None, facts: dict) -> bool | None:
    """Whether a recording's length agrees with the review's duration; None when either is
    unknown. A video's duration allows VIDEO_WINDOW, Spotify's WINDOW."""
    duration = facts.get("duration")
    if not length or not duration:
        return None
    window = WINDOW if facts.get("duration_source") == "spotify" else VIDEO_WINDOW
    return abs(length - duration) <= window


def credit_agrees(r: dict, artist: str) -> bool:
    """Whether a recording credits the review's artist by name: one credit is the main artist
    or the whole artist (folded), or the credits joined are the whole artist ("Simon &
    Garfunkel" as one credit, "Dr. Dre feat. Eminem" as two). "Fixture Artistry" is not
    "Fixture Artist": a looser credit is only a candidate, never proved by a length."""
    whole, main = fold(artist), fold(main_artist(artist))
    names = {fold(n) for c in credits_of(r)
             for n in (c.get("name", ""), c["artist"].get("name", ""))}
    joined = fold("".join(c.get("name", "") + (c.get("joinphrase") or "") for c in credits_of(r)))
    return bool({whole, main} & names) or (bool(whole) and joined == whole)


def mb_candidates(found: list[dict], facts: dict) -> tuple[list[dict], dict[str, int]]:
    """The recordings of a search that are the review's song by its artist and could be the
    one it is about, best first, and how many others were rejected for which reason.

    Not candidates: another title (folded, featured artists dropped), or no credit naming the
    artist at all. Rejected: a music video; a recording whose title or disambiguation marks a
    version the review's own title does not (live, DJ-mix, instrumental, excerpt, karaoke, a
    cappella: a review of the live version keeps live recordings); one only on such releases or
    bootlegs; one whose length is off the Spotify duration by more than WINDOW. Ranked: the
    artist credited by name before a looser credit, on a release titled as the review's album,
    length within the window, on an artist release before compilations only, earliest usable
    release, id. A compilation only ranks: one recording spans many releases."""
    track = facts["track"]
    want_title, want_artist = fold(song_title(track)), fold(main_artist(facts["artist"]))
    albums = facts["albums"]
    strict = facts.get("duration_source") == "spotify"
    kept: list[dict] = []
    rejected: dict[str, int] = {}
    for r in found:
        credits = " ".join(c.get("name", "") + " " + c["artist"].get("name", "")
                           for c in credits_of(r))
        if fold(r.get("title", "")) != want_title or want_artist not in fold(credits):
            continue  # another song or another artist: not a candidate at all
        releases = r.get("releases") or []
        clean = [x for x in releases
                 if not set(release_flags(x, albums, track)) & (set(MARKERS) | {"bootleg"})]
        usable = [x for x in releases if not release_flags(x, albums, track)]
        version = marks(f"{r.get('title', '')} {r.get('disambiguation') or ''}", track)
        length = length_of(r)
        fits = within(length, facts)
        reason = ("video" if r.get("video") else ", ".join(sorted(version)) if version
                  else "no release" if not releases
                  else "only on live, DJ-mix, instrumental or bootleg releases" if not clean
                  else f"length off {mmss(facts['duration'])}" if strict and fits is False
                  else "")
        if reason:
            rejected[reason] = rejected.get(reason, 0) + 1
            continue
        kept.append({
            "r": r, "id": r["id"], "length": length, "fits": fits,
            "credited": credit_agrees(r, facts["artist"]),
            "album": min((album_tier(x.get("title", ""), albums) for x in usable), default=2),
            "compilation": all(is_compilation(x) for x in usable) if usable else True,
            "first": min((date_key(x.get("date")) for x in usable), default="9999-99-99")})
    kept.sort(key=lambda c: (not c["credited"], c["album"], 0 if c["fits"] else 1,
                             c["compilation"], c["first"], c["id"]))
    return kept, rejected


def evidence_of(c: dict) -> str:
    """What singles a candidate out: the album it is on, else its length. A length alone
    supports a recording that credits the artist by name; it never proves a looser one."""
    if c["album"] < 2:
        return "album"
    return "duration" if c["fits"] and c["credited"] else ""


def mb_search_url(query: str, limit: int) -> str:
    return MB + "recording?" + urllib.parse.urlencode({"query": query, "fmt": "json",
                                                       "limit": limit})


def mb_releases_url(recording: str) -> str:
    return MB + "release?" + urllib.parse.urlencode(
        {"recording": recording, "inc": "artist-credits release-groups", "limit": 100,
         "fmt": "json"})


def mb_recording_url(recording: str) -> str:
    return MB + f"recording/{recording}?" + urllib.parse.urlencode(
        {"inc": "isrcs artist-credits", "fmt": "json"})


def mb_release_url(release: str) -> str:
    return MB + f"release/{release}?" + urllib.parse.urlencode(
        {"inc": "recordings release-groups artist-credits", "fmt": "json"})


def mb_search(facts: dict, args) -> tuple[list[dict], str]:
    """The recordings MusicBrainz finds for the song: on a release titled as each album the
    review names, then without the album; one recording's releases from both are merged."""
    q = (f"recording:{mb_quote(song_title(facts['track']))} "
         f"AND artist:{mb_quote(main_artist(facts['artist']))}")
    urls = [mb_search_url(f"{q} AND release:{mb_quote(a)}", 25) for a in facts["albums"][:2]]
    merged: dict[str, dict] = {}
    for url in urls + [mb_search_url(q, 50)]:
        for r in mb_get(url, args).get("recordings") or []:
            known = merged.setdefault(r["id"], {**r, "releases": []})
            ids = {x.get("id") for x in known["releases"]}
            known["releases"] += [x for x in r.get("releases") or [] if x.get("id") not in ids]
    return list(merged.values()), q


def mb_match(facts: dict, args) -> dict:
    """The MusicBrainz recording and release a review is about (mb_candidates, pick_release).
    Several candidates that neither the album nor a known duration tells apart are ambiguous;
    a release the facts cannot single out is left empty with the reason in notes."""
    found, query = mb_search(facts, args)
    kept, rejected = mb_candidates(found, facts)
    base = {"query": query, "rejected": rejected, "candidates": len(kept)}
    if not kept:
        return {**base, "status": "no-match",
                "why": "no recording of the song by the artist" + (
                    " that is not " + ", ".join(sorted(rejected)) if rejected else "")}
    best = kept[0]
    evidence = evidence_of(best)
    if not best["credited"] and not evidence:
        return {**base, "status": "ambiguous",
                "why": "no recording credits " + repr(facts["artist"]) + " by name, and no "
                       "album confirms a looser credit"}
    if len(kept) > 1 and not evidence:
        return {**base, "status": "ambiguous",
                "why": f"{len(kept)} recordings remain and neither an album nor a known duration "
                       "tells them apart (set extra.album, or fill ids by hand)"}
    r = best["r"]
    artist_id = credit_id(r, facts["artist"])
    found_artist = mb_get(MB + f"artist/{artist_id}?fmt=json", args) if artist_id else {}
    country = found_artist.get("country") or ""
    releases = mb_get(mb_releases_url(r["id"]), args).get("releases") or r.get("releases") or []
    rel = pick_release(releases, facts["albums"], facts.get("country") or country,
                       facts["track"])
    notes = list(facts.get("notes", []))
    if rel["why"]:
        notes.append("release left out: " + rel["why"])
    if not evidence:
        notes.append("the only candidate; neither an album nor a known duration confirms it")
    return {**base, "status": "matched", "recording": r["id"], "artist": artist_id,
            "release": rel["release"], "release_title": rel.get("title", ""),
            "isrc": sorted(r.get("isrcs") or [])[:1],
            "year": first_year(releases, facts["albums"], facts["track"]),
            "country": country, "length": best["length"], "evidence": evidence,
            "notes": notes}


def say(command: str, rel: str, message: str) -> None:
    print(f"{command}: {rel}: {message}", file=sys.stderr)


def enrich(paths: list[str], args) -> int:
    """Fill what MusicBrainz knows into [extra]: the recording, artist and release ids, the
    ISRC, the artist's country, and the release year when the review has none. A value the
    review already has is kept; without --write this only reports. What the review's facts
    cannot single out is written as nothing, and the report says why."""
    files = cat.review_files() if args.all else [content_path(p) for p in paths]
    report: dict[str, list] = {"matched": [], "unchanged": [], "ambiguous": [], "no-match": [],
                               "failed": []}
    for file in files:
        if file.name == "_index.md" or cat.tr.translation_name(file.name):
            continue
        errors: list[str] = []
        t = cat.load_track(file, errors)
        if not t:
            continue
        rel = f"content/{file.name}"
        old = t.full_extra.get("musicbrainz")
        old = old if isinstance(old, dict) else {}
        if old.get("recording") and not args.force:
            report["unchanged"].append(rel)
            continue
        facts = page_facts(t)
        try:
            m = mb_match(facts, args)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, MBOffline) as exc:
            report["failed"].append({"file": rel, "error": str(exc) or type(exc).__name__})
            continue
        if m["status"] != "matched":
            report[m["status"]].append({"file": rel, "why": m["why"], "query": m["query"],
                                        "rejected": m["rejected"]})
            say("enrich", rel, f"nothing written: {m['why']}")
            continue
        ids = {k: m[k] for k in ("recording", "artist", "release") if m[k]}
        if not ids.get("release") and old.get("release") and old.get("recording") == m["recording"]:
            ids["release"] = old["release"]  # --force keeps a release the match cannot replace
        updates: dict = {"musicbrainz": ids}
        if m["isrc"] and not t.full_extra.get("isrc"):
            updates["isrc"] = m["isrc"][0]
        # MusicBrainz uses XW (worldwide), XE (Europe) and XU (unknown) for areas, not countries.
        if (m["country"] and re.fullmatch(r"[A-Z]{2}", m["country"])
                and m["country"] not in ("XW", "XE", "XU") and not t.full_extra.get("country")):
            updates["country"] = m["country"]
        if m["year"] and not t.full_extra.get("release_year"):
            updates["release_year"] = m["year"]
        entry = {"file": rel, "updates": updates, "candidates": m["candidates"],
                 "rejected": m["rejected"], "length": mmss(m["length"]),
                 "duration": f"{mmss(facts['duration'])} ({facts['duration_source'] or 'none'})",
                 "release_title": m["release_title"], "notes": m["notes"]}
        for note in m["notes"]:
            say("enrich", rel, note)
        if args.write and write_extra(file, rel, updates, quiet=True) != 0:
            report["failed"].append({"file": rel,
                                     "error": "the rewritten article fails the contract"})
            continue
        report["matched"].append(entry)
    out({"written": bool(args.write), **report,
         "counts": {k: len(v) for k, v in report.items()}})
    return 1 if report["failed"] else 0


# --- Audit: ids already written that look wrong. ---------------------------------------------

def mb_flags(facts: dict, ids: dict, recording: dict, releases: list[dict],
             release: dict | None, member: bool | None) -> list[dict]:
    """What looks wrong with a review's MusicBrainz ids, each {field, kind, detail}: the
    recording (missing, its length against the review's duration, a version marker, a video,
    only on live/DJ-mix/bootleg releases), its artist, the ISRC not on the recording, the
    release (missing, not carrying the recording, not Official or another version, not the
    review's album, a compilation when the artist's own release exists)."""
    flags: list[dict] = []

    def flag(field: str, kind: str, detail: str) -> None:
        flags.append({"field": field, "kind": kind, "detail": detail})

    albums, track = facts["albums"], facts["track"]
    if not recording:
        flag("recording", "missing", f"recording {ids.get('recording')} is not in MusicBrainz")
    else:
        length = length_of(recording)
        if within(length, facts) is False:
            flag("recording", "length", f"recording is {mmss(length)}, the review's duration "
                 f"{mmss(facts['duration'])} ({facts['duration_source']})")
        version = marks(f"{recording.get('title', '')} {recording.get('disambiguation') or ''}",
                        facts["track"])
        if version:
            flag("recording", "version", f"recording {recording.get('title', '')!r} "
                 f"({recording.get('disambiguation') or 'no disambiguation'}) is "
                 + ", ".join(sorted(version)))
        if recording.get("video"):
            flag("recording", "video", "the recording is a music video")
        clean = [x for x in releases
                 if not set(release_flags(x, albums, track)) & (set(MARKERS) | {"bootleg"})]
        if releases and not clean:
            flag("recording", "only-on", "every release of the recording is live, a DJ-mix, an "
                 "instrumental or a bootleg")
        credit_ids = {c["artist"]["id"] for c in credits_of(recording)}
        if ids.get("artist") and ids["artist"] not in credit_ids:
            flag("artist", "artist", f"artist {ids['artist']} is not credited on the recording")
        if ids.get("isrc") and ids["isrc"] not in (recording.get("isrcs") or []):
            flag("isrc", "isrc", f"ISRC {ids['isrc']} is not on the recording (it has "
                 + (", ".join(recording.get("isrcs") or []) or "none") + ")")
    if ids.get("release"):
        if release is None:
            pass  # not looked up
        elif not release:
            flag("release", "missing", f"release {ids['release']} is not in MusicBrainz")
        else:
            title = release.get("title", "")
            if member is False:
                flag("release", "not-of-recording", f"release {title!r} does not carry the "
                     "recording")
            bad = release_flags(release, albums, track)
            if bad:
                flag("release", "release-version", f"release {title!r} is " + ", ".join(bad))
            if albums and album_tier(title, albums) == 2:
                flag("release", "album", f"release {title!r} is not the album "
                     + " or ".join(repr(a) for a in albums) + f" ({facts['album_source']})")
            elif not albums and is_compilation(release) and any(
                    not is_compilation(x) and not release_flags(x, albums, track)
                    for x in releases):
                flag("release", "compilation", f"release {title!r} is a compilation and the "
                     "recording has an artist release")
    return flags


def release_carries(release: dict, recording: str) -> bool:
    return any((tr.get("recording") or {}).get("id") == recording
               for medium in release.get("media") or [] for tr in medium.get("tracks") or [])


def mb_propose(facts: dict, ids: dict, flags: list[dict], recording: dict,
               releases: list[dict], args) -> tuple[dict, str]:
    """The correction for flagged ids, only when it is unambiguous: a new recording (and its
    release) when the recording is flagged, else a release among the recording's, the credited
    artist, the recording's ISRC. Returns (updates of [extra], why nothing when empty)."""
    fields = {f["field"] for f in flags}
    mb = {k: ids[k] for k in ("recording", "artist", "release") if ids.get(k)}
    rec = recording
    if "recording" in fields:
        m = mb_match(facts, args)
        if m["status"] != "matched":
            return {}, m["why"]
        if m["recording"] == ids.get("recording"):
            return {}, "the match is the same recording"
        rec = mb_get(mb_recording_url(m["recording"]), args)
        mb = {k: m[k] for k in ("recording", "artist", "release") if m[k]}
        if not m["release"]:
            return {}, "a new recording without a release: " + "; ".join(m["notes"])
    else:
        if "release" in fields:
            rel = pick_release(releases, facts["albums"], facts.get("country") or "",
                               facts["track"])
            if not rel["release"]:
                return {}, rel["why"]
            mb["release"] = rel["release"]
        if "artist" in fields:
            artist = credit_id(recording, facts["artist"])
            if not artist:
                return {}, "the recording credits no artist"
            mb["artist"] = artist
    updates: dict = {}
    if mb != {k: ids[k] for k in ("recording", "artist", "release") if ids.get(k)}:
        updates["musicbrainz"] = mb
    isrcs = sorted(rec.get("isrcs") or [])
    if ids.get("isrc") and ids["isrc"] not in isrcs:
        if not isrcs:
            return updates, ("" if updates
                             else "the recording has no ISRC; remove extra.isrc by hand")
        updates["isrc"] = isrcs[0]
    return updates, "" if updates else "nothing to change"


def audit_mb(paths: list[str], args) -> int:
    """Report the reviews whose MusicBrainz ids look wrong (mb_flags), with the unambiguous
    correction where there is one; --fix writes those corrections and nothing else. A report,
    not a gate: exit 0."""
    files = ([content_path(p) for p in paths] if paths else cat.review_files())
    report: dict[str, list] = {"flagged": [], "ok": [], "unenriched": [], "unreachable": []}
    for file in files:
        if file.name == "_index.md" or cat.tr.translation_name(file.name):
            continue
        errors: list[str] = []
        t = cat.load_track(file, errors, include_drafts=True)
        if not t:
            continue
        rel = f"content/{file.name}"
        mb = t.full_extra.get("musicbrainz")
        mb = mb if isinstance(mb, dict) else {}
        if not mb.get("recording"):
            report["unenriched"].append(rel)
            continue
        ids = {**{k: mb.get(k, "") for k in ("recording", "artist", "release")},
               "isrc": t.full_extra.get("isrc") or ""}
        facts = page_facts(t)
        try:
            recording = mb_get(mb_recording_url(ids["recording"]), args)
            releases = (mb_get(mb_releases_url(ids["recording"]), args).get("releases") or []
                        if recording else [])
            release, member = None, None
            if ids["release"]:
                release = next((r for r in releases if r.get("id") == ids["release"]), None)
                member = True if release else None
                if release is None:
                    release = mb_get(mb_release_url(ids["release"]), args)
                    member = release_carries(release, ids["recording"]) if release else None
            flags = mb_flags(facts, ids, recording, releases, release, member)
            proposed, why_not = (mb_propose(facts, ids, flags, recording, releases, args)
                                 if flags else ({}, ""))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, MBOffline) as exc:
            report["unreachable"].append({"file": rel, "error": str(exc) or type(exc).__name__})
            continue
        if not flags:
            report["ok"].append(rel)
            continue
        entry = {"file": rel, "ids": ids, "album": facts["albums"],
                 "duration": f"{mmss(facts['duration'])} ({facts['duration_source'] or 'none'})",
                 "length": mmss(length_of(recording)) if recording else "?",
                 "release_title": (release or {}).get("title", ""),
                 "flags": flags, "proposed": proposed, "fixed": False}
        if why_not:
            entry["why_not"] = why_not
        if args.fix and proposed:
            entry["fixed"] = write_extra(file, rel, proposed, quiet=True) == 0
        report["flagged"].append(entry)
    kinds: dict[str, int] = {}
    for entry in report["flagged"]:
        for f in entry["flags"]:
            kinds[f["kind"]] = kinds.get(f["kind"], 0) + 1
    counts = {k: len(v) for k, v in report.items()}
    proposals = sum(1 for e in report["flagged"] if e["proposed"])
    fixed = sum(1 for e in report["flagged"] if e["fixed"])
    summary = (f"{sum(counts.values())} reviews: {counts['ok']} ok, {counts['flagged']} flagged"
               + (" (" + ", ".join(f"{k} {n}" for k, n in sorted(kinds.items())) + ")"
                  if kinds else "")
               + f", {counts['unenriched']} without ids, {counts['unreachable']} unreachable; "
               + f"{proposals} unambiguous corrections"
               + (f", {fixed} written" if args.fix else " (--fix writes them)"))
    out({"fixed": bool(args.fix), **report, "counts": counts, "flags": kinds,
         "summary": summary})
    for entry in report["flagged"]:
        say("audit-mb", entry["file"], "; ".join(f["detail"] for f in entry["flags"]))
    print(f"audit-mb: {summary}", file=sys.stderr)
    return 0


# --- Versions: the song's family on YouTube, as extra.versions data. --------------------------
#
# A song lives on YouTube in many uploads: the artist's video, the Topic channel's release (once
# self-released through a distributor, later perhaps under licence to a label), the artist's own
# remix, other producers' remixes, a line dance, a short. `versions` searches for them, keeps the
# results whose title names the song, reads each one's watch page (never its stream) and
# suggests a kind with the reasons; the writer picks, `--write --pick` appends the tables, and
# `--verify` re-reads every listed version against YouTube.

VERSION_QUERIES = ("", "remix", "edit", "extended", "live", "cover", "line dance")
VERSION_KINDS = tuple(cat.TRACK_SCHEMA["properties"]["extra"]["properties"]["versions"]
                      ["items"]["properties"]["kind"]["enum"])
ARTIST_SIDE = re.compile(r"\s*-\s*topic\s*$", re.I)
KIND_RULES = (  # (kind, title pattern, reason): the first that matches decides, in this order
    ("dance", re.compile(r"line ?dance|choreo", re.I), "the title names a (line) dance"),
    ("live", re.compile(r"\blive\b", re.I), "the title says live"),
    ("cover", re.compile(r"\bcover\b", re.I), "the title says cover"),
)
REMIX = re.compile(r"\b(remix|rmx|rework|bootleg|flip)\b", re.I)
EDITS = (("edit", re.compile(r"\bedit\b", re.I)), ("extended", re.compile(r"\bextended\b", re.I)))
REMIXER = re.compile(r"[\(\[]\s*([^()\[\]]+?)\s+(?:remix|rmx|edit|rework|bootleg)\s*[\)\]]", re.I)
DURATION_SLACK = 1  # seconds: YouTube's search rounds a length up, the watch page floors it
MAX_WATCHED = 40  # watch pages read per discovery, at most


def names_song(text: str, song: str) -> bool:
    """Whether text names the song: its folded words appear in a row ("Linedance Lauter
    MAINVIBE" names "Lauter"; "Lautersound" does not)."""
    want, have = cat.words(song), cat.words(text)
    return bool(want) and any(have[i:i + len(want)] == want
                              for i in range(len(have) - len(want) + 1))


def channel_name(channel: str) -> str:
    return CHANNEL_NOISE.sub("", channel).strip()


def version_queries(artist: str, song: str, extra: list[str]) -> list[str]:
    base = f"{main_artist(artist)} {song}"
    queries = [f"{base} {q}".strip() for q in VERSION_QUERIES] + list(extra)
    return list(dict.fromkeys(queries))


def credited_by(title: str, channel: str) -> str:
    """Who made a version by someone else: the remixer the title names, in the channel's
    spelling when the channel is that person ("ROCKMAX | Tom Kenzler" for "(TOM KENZLER REMIX)"),
    else the channel."""
    name = channel_name(channel)
    parts = [p.strip() for p in re.split(r"\s+[|·]\s+", name) if p.strip()]
    m = REMIXER.search(title)
    if m:
        remixer = fold(m.group(1))
        same = next((p for p in parts if fold(p) == remixer), "")
        return same or (name if fold(name) == remixer else m.group(1).strip())
    named = [p for p in parts if len(parts) > 1 and names_song(title, p)]
    return named[0] if named else name


def suggest_kind(title: str, channel: str, artist_side: bool, seconds: int | None, short: bool,
                 facts: dict) -> tuple[str | None, list[str]]:
    """The kind a version most likely is, and why; None when no rule decides."""
    for kind, pattern, reason in KIND_RULES:
        if pattern.search(title):
            return kind, [reason]
    if short or (seconds is not None and seconds < 60):
        return "excerpt", ["a YouTube short" if short else f"only {seconds} s long"]
    side = "the artist's channel" if artist_side else f"another channel ({channel or 'unknown'})"
    if REMIX.search(title):
        return ("official-remix" if artist_side else "remix"), [f"the title says remix, on {side}"]
    for kind, pattern in EDITS:
        if pattern.search(title):
            return kind, [f"the title says {kind}"]
    provider = facts.get("provider")
    if provider:
        if facts.get("diy"):
            return "self-release", [f"a Topic upload provided by {provider}, a DIY distributor"]
        return "licensed-release", [f"a Topic upload provided by {provider}, not a DIY distributor"]
    if ARTIST_SIDE.search(channel):
        return "original", ["a Topic upload whose description names no provider"]
    if artist_side:
        return "official-video", [f"uploaded by {side}"]
    return None, [f"no rule decides for an upload by {side}: pick a kind by hand"]


def version_candidate(found: dict, watch: dict | None, t, own_channel: str,
                      fetched: int | None) -> dict:
    """A search result (with its watch page when it could be read) as a version candidate:
    the entry --write would append, the suggested kind with its reasons and confidence."""
    w = watch or {}
    facts = w.get("facts") or {}
    channel = w.get("author") or found.get("channel", "")
    channel_id = w.get("channel_id") or found.get("channel_id", "")
    artist = main_artist(t.artist)
    artist_side = (fold(channel_name(channel)) == fold(artist)
                   or bool(own_channel and channel_id == own_channel)
                   or any(fold(a) == fold(artist) for a in facts.get("artists", [])))
    title = w.get("title") or found.get("title", "")
    short = found.get("format") == "short" or bool(w.get("short"))
    kind, reasons = suggest_kind(title, channel, artist_side, w.get("seconds"), short, facts)
    if watch is None:
        reasons.append("the watch page could not be read: from the search result only")
    confidence = ("low" if watch is None or kind is None
                  else "high" if facts.get("provider") or (artist_side and kind != "excerpt")
                  else "medium")
    country = t.full_extra.get("country") if isinstance(t.full_extra.get("country"), str) else ""
    published = w.get("publish_date", "")
    day = facts.get("released") or (yt.local_date(published, country) if published else "")
    entry: dict = {"kind": kind, "title": display_title(title),
                   "by": t.artist if artist_side else credited_by(title, channel),
                   "youtube": found["id"]}
    if short:
        entry["url"] = f"https://www.youtube.com/shorts/{found['id']}"
    entry["format"] = "short" if short else ("audio" if facts.get("provider") else "video")
    duration = w.get("duration") or found.get("duration", "")
    if duration:
        entry["duration"] = duration
    if day:
        entry["date"] = day
    if facts.get("rights"):
        entry["rights"] = facts["rights"]
    count = w.get("views") if w.get("views") is not None else found.get("views")
    return {
        "entry": entry, "suggested_kind": kind, "confidence": confidence, "reasons": reasons,
        "evidence": entry.get("url") or yt.watch_url(found["id"]), "channel": channel,
        "date_source": ("the description's Released on" if facts.get("released") else
                        f"the upload time in {country or 'UTC'}" if published else ""),
        "credits": facts.get("credits", []),
        "views": {"count": count, "as_of": date.fromtimestamp(fetched).isoformat()
                  if fetched else date.today().isoformat(),
                  "note": "a snapshot of YouTube's counter, not a fact for the page"},
    }


def listed_versions(t) -> list[dict]:
    return [v for v in t.full_extra.get("versions") or [] if isinstance(v, dict)]


def display_title(title: str) -> str:
    """A version's title as a page shows it: the upload's title without its emoji and other
    pictographs (Unicode category So, variation selectors), spaces collapsed."""
    kept = "".join(ch for ch in title
                   if unicodedata.category(ch) != "So" and not 0xFE00 <= ord(ch) <= 0xFE0F)
    return re.sub(r"\s+", " ", kept).strip()


def version_diffs(listed: dict, derived: dict) -> list[dict]:
    """Where a listed version and what YouTube says now disagree: title, by, duration (within
    DURATION_SLACK), date; also kind, format and rights, which a writer may have chosen."""
    diffs = []
    for key in ("title", "by", "duration", "date", "kind", "format", "rights"):
        mine, theirs = listed.get(key), derived.get(key)
        if mine is None or theirs is None or mine == theirs:
            continue
        if key == "by" and fold(str(mine)) == fold(str(theirs)):
            continue
        if key == "duration":
            a, b = seconds(str(mine)), seconds(str(theirs))
            if a is not None and b is not None and abs(a - b) <= DURATION_SLACK:
                continue
        diffs.append({"field": key, "listed": mine, "youtube": theirs,
                      "chosen": key in ("kind", "format", "rights")})
    return diffs


def own_channel_of(t, client) -> str:
    if not t.youtube_id:
        return ""
    try:
        return client.watch(t.youtube_id).get("channel_id", "")
    except (yt.YouTubeError, ValueError):
        return ""


def discover(t, client, extra_queries: list[str]) -> dict:
    """Search the song's versions, keep the results that name the song and the artist, read
    their watch pages, and report candidates (best known first), rejections and the listed
    versions the searches did not find."""
    song = cat.song(t.track)
    artist = main_artist(t.artist)
    queries, results = [], {}
    for q in version_queries(t.artist, song, extra_queries):
        row: dict = {"query": q}
        try:
            found = client.search(q)
            row["results"] = len(found)
            for r in found:
                results.setdefault(r["id"], r)
        except yt.YouTubeError as exc:
            row["error"] = str(exc)
        queries.append(row)
    listed = {cat.version_key(v): v for v in listed_versions(t)}
    own_channel = own_channel_of(t, client)
    rejected: dict[str, list[str]] = {}
    candidates = []
    for r in results.values():
        about = f"{r['title']} {r['channel']} {r['snippet']}"
        if not (names_song(r["title"], song) or names_song(r["snippet"], song)):
            rejected.setdefault("the title does not name the song", []).append(r["id"])
            continue
        if fold(artist) not in fold(about):
            rejected.setdefault("neither title nor channel names the artist", []).append(r["id"])
            continue
        watch = None
        if len(candidates) < MAX_WATCHED:
            try:
                watch = client.watch(r["id"])
            except yt.YouTubeError:
                watch = None
        if watch and not names_song(watch["title"], song):
            rejected.setdefault("only the description names the song", []).append(r["id"])
            continue
        c = version_candidate(r, watch, t, own_channel,
                              client.fetched_at(yt.watch_url(r["id"])))
        c["in_page"] = r["id"] in listed
        if c["in_page"]:
            c["differs"] = version_diffs(listed[r["id"]], c["entry"])
        candidates.append(c)
    candidates.sort(key=lambda c: (not c["in_page"], c["entry"]["kind"] is None))
    found_ids = {c["entry"]["youtube"] for c in candidates}
    return {"file": f"content/{t.source}", "artist": t.artist, "song": song, "queries": queries,
            "candidates": candidates,
            "listed_not_found": [k for k in listed if k not in found_ids],
            "rejected": {k: len(v) for k, v in rejected.items()}}


def toml_tables(name: str, rows: list[dict]) -> str:
    """Rows as TOML array-of-tables entries ([[name]] then key = value lines)."""
    chunks = []
    for row in rows:
        lines = [f"[[{name}]]"] + [f"{k} = {toml_value(v)}" for k, v in row.items()
                                    if v is not None]
        chunks.append("\n".join(lines) + "\n")
    return "\n".join(chunks)


def write_versions(file: Path, rel: str, rows: list[dict]) -> list[str]:
    """Append rows as [[extra.versions]] at the end of the front matter, prove the article
    still meets the contract and now lists them, then write it. The prose is never touched."""
    raw, body = cat.split_front_matter(file.read_text(encoding="utf-8"), file.name)
    rewritten = ("+++\n" + raw.rstrip("\n") + "\n\n" + toml_tables("extra.versions", rows)
                 + "+++\n" + body)
    errors, _ = prove(rewritten, file.name, {})
    if not errors:
        extra = tomllib.loads(cat.split_front_matter(rewritten, file.name)[0]).get("extra", {})
        if (extra.get("versions") or [])[-len(rows):] != rows:
            errors = ["extra.versions does not end with the picked versions after the rewrite"]
    if not errors:
        file.write_text(rewritten, encoding="utf-8")
    return errors


def pick_versions(t, file: Path, picks: list[str], report: dict, client) -> tuple[dict, int]:
    """--write --pick ID[:kind]: the picked candidates (or videos read on their own) appended
    as extra.versions, with the suggested kind unless one is given; duplicates refused."""
    by_id = {c["entry"]["youtube"]: c for c in report["candidates"]}
    listed = {cat.version_key(v) for v in listed_versions(t)}
    rows, problems = [], []
    for pick in picks:
        video, _, kind = pick.partition(":")
        if not VIDEO_ID.match(video):
            problems.append(f"{pick}: not a YouTube video id")
            continue
        if video in listed or any(r["youtube"] == video for r in rows):
            problems.append(f"{video}: already in extra.versions")
            continue
        c = by_id.get(video)
        if c is None:
            try:
                watch = client.watch(video)
            except yt.YouTubeError as exc:
                problems.append(f"{video}: {exc}")
                continue
            c = version_candidate({"id": video, "title": "", "channel": "", "channel_id": "",
                                   "duration": "", "format": "video"}, watch, t,
                                  own_channel_of(t, client), None)
        kind = kind or c["suggested_kind"]
        if kind not in VERSION_KINDS:
            problems.append(f"{video}: kind {kind or '(none suggested)'} is not one of "
                            + ", ".join(VERSION_KINDS) + "; give it as ID:kind")
            continue
        rows.append({**c["entry"], "kind": kind})
    rel = f"content/{file.name}"
    if problems or not rows:
        return {"file": rel, "written": False, "errors": problems or ["nothing picked"]}, 1
    errors = write_versions(file, rel, rows)
    if errors:
        return {"file": rel, "written": False, "errors": errors}, 1
    say("versions", rel, f"{len(rows)} version(s) appended without notes; a note added later "
        "must be translated in each translation (versions = [{ youtube, note }]), which is "
        "stale until then: python3 scripts/translate.py status")
    return {"file": rel, "written": True, "added": rows}, 0


def verify_versions(t, client) -> dict:
    """Re-read every listed version's watch page and compare it with the entry."""
    country = t.full_extra.get("country") if isinstance(t.full_extra.get("country"), str) else ""
    checked, diffs = 0, []
    for v in listed_versions(t):
        video = v.get("youtube")
        if not video:
            continue
        checked += 1
        try:
            w = client.watch(video)
        except yt.YouTubeError as exc:
            diffs.append({"youtube": video, "field": "available", "listed": True,
                          "youtube_says": str(exc)})
            continue
        if not w["playable"]:
            diffs.append({"youtube": video, "field": "available", "listed": True,
                          "youtube_says": w["reason"] or "not playable"})
            continue
        facts = w["facts"]
        artist_side = v.get("kind") in cat.ARTIST_KINDS
        day = facts.get("released") or yt.local_date(w["publish_date"], country)
        derived = {"title": display_title(w["title"]),
                   "by": t.artist if artist_side else credited_by(w["title"], w["author"]),
                   "duration": w["duration"] or None, "date": day or None}
        for d in version_diffs(v, derived):
            diffs.append({"youtube": video, "field": d["field"], "listed": d["listed"],
                          "youtube_says": d["youtube"]})
    return {"file": f"content/{t.source}", "checked": checked, "diffs": diffs}


def print_versions(report: dict) -> None:
    """The discovery report for a person: one line per candidate, then what was left out."""
    print(f"{report['file']}: {report['artist']} - {report['song']}")
    for c in report["candidates"]:
        e = c["entry"]
        mark = "listed " if c["in_page"] else "new    "
        print(f"  {mark}{e['kind'] or '?':16} {c['confidence']:6} {e['youtube']} "
              f"{e.get('duration', '?'):>7} {e.get('date', '?'):10} {e['by']}: {e['title']}")
        print(f"         {'; '.join(c['reasons'])}")
        for d in c.get("differs", []):
            print(f"         differs: {d['field']} listed {d['listed']!r}, YouTube {d['youtube']!r}")
    for k in report["listed_not_found"]:
        print(f"  listed but not found by the searches: {k}")
    for reason, n in report["rejected"].items():
        print(f"  left out: {n} result(s): {reason}")
    for q in report["queries"]:
        if "error" in q:
            print(f"  query {q['query']!r} failed: {q['error']}")


def versions(args) -> int:
    client = yt.YouTube(fixture=args.youtube_fixture, refresh=args.refresh or args.verify)
    if args.all:
        if not args.verify:
            fail("--all goes with --verify (discovery is one review at a time)")
        files = [f for f in cat.review_files()
                 if f.name != "_index.md" and not cat.tr.translation_name(f.name)]
    elif args.file:
        files = [content_path(args.file)]
    else:
        fail("name a review (content/<file>.md), or --verify --all")
    if args.write and not args.pick:
        fail("--write needs --pick ID[:kind] for each version to append")
    if args.verify:
        reports = []
        for file in files:
            errors: list[str] = []
            t = cat.load_track(file, errors, include_drafts=True)
            if t and listed_versions(t):
                reports.append(verify_versions(t, client))
        total = sum(len(r["diffs"]) for r in reports)
        out({"verified": reports, "diffs": total})
        for r in reports:
            for d in r["diffs"]:
                say("versions", r["file"], f"{d['youtube']} {d['field']}: listed "
                    f"{d['listed']!r}, YouTube says {d['youtube_says']!r}")
        return 1 if total else 0
    file = files[0]
    errors = []
    t = cat.load_track(file, errors, include_drafts=True)
    if not t:
        fail(f"{args.file} does not load: " + "; ".join(errors), 1)
    report = discover(t, client, args.query or [])
    if args.write:
        result, code = pick_versions(t, file, args.pick, report, client)
        out(result)
        return code
    if args.json:
        out(report)
    else:
        print_versions(report)
    return 0


def check(path: str) -> int:
    file = content_path(path)
    if cat.tr.translation_name(file.name):
        # A translation has its own contract (ADR 0006, scripts/translation.py).
        import translate  # noqa: E402  (scripts/ is on the path)
        problems = translate.check_files([file])
        out({"file": path, "translation_of": translate.english_of(file).relative_to(cat.ROOT).as_posix(),
             "errors": problems})
        return 1 if problems else 0
    errors: list[str] = []
    track = cat.load_track(file, errors, include_drafts=True)
    if track:
        errors += cat.edu_problems(track)
    todo = file.read_text(encoding="utf-8").count(cat.UNFINISHED)
    report = {"file": path, "errors": errors, "unfinished": todo}
    if track:
        report.update({"artist": track.artist, "track": track.track, "inferred": track.inferred,
                       "words": track.words, "slug": track.path})
    out(report)
    return 1 if errors or todo else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p):
        p.add_argument("input")
        p.add_argument("--offline", action="store_true", help="do not ask YouTube's oEmbed")
        p.add_argument("--oembed-fixture", help="answer oEmbed from a JSON file (tests)")
        p.add_argument("--youtube", help="the video, when the input is a name")
        p.add_argument("--artist")
        p.add_argument("--track")

    common(sub.add_parser("resolve", help="infer artist, track, video and file; find duplicates"))
    p_new = sub.add_parser("new", help="write content/<slug>.md from the archetype")
    common(p_new)
    for f in cat.FACETS:
        p_new.add_argument(f"--{f}", nargs="+", action="extend")  # --genre a --genre b, or --genre a b
    p_new.add_argument("--description")
    p_new.add_argument("--date")
    p_new.add_argument("--dry-run", action="store_true")
    p_new.add_argument("--force", action="store_true", help="overwrite although the track exists")
    p_ref = sub.add_parser("refresh", help="update video/album/year/label, prose untouched")
    p_ref.add_argument("file")
    p_ref.add_argument("--youtube")
    p_ref.add_argument("--album")
    p_ref.add_argument("--release-year", dest="release_year")
    p_ref.add_argument("--publisher")
    sub.add_parser("check", help="validate one article").add_argument("file")
    p_en = sub.add_parser("enrich", help="identifiers and facts from MusicBrainz into [extra]")
    p_en.add_argument("files", nargs="*")
    p_en.add_argument("--all", action="store_true", help="every review")
    p_en.add_argument("--write", action="store_true", help="write (default: report only)")
    p_en.add_argument("--force", action="store_true", help="also reviews that have identifiers")
    p_en.add_argument("--mb-fixture", help="MusicBrainz answers from a JSON file (tests)")
    p_en.add_argument("--offline", action="store_true", help="the MusicBrainz cache only")
    p_au = sub.add_parser("audit-mb", help="report reviews whose MusicBrainz ids look wrong")
    p_au.add_argument("files", nargs="*", help="reviews (default: every review)")
    p_au.add_argument("--fix", action="store_true", help="write the unambiguous corrections")
    p_au.add_argument("--mb-fixture", help="MusicBrainz answers from a JSON file (tests)")
    p_au.add_argument("--offline", action="store_true", help="the MusicBrainz cache only")
    p_vocab = sub.add_parser("vocab", help="the facet vocabulary, most used first")
    p_vocab.add_argument("--facet", choices=cat.FACETS)
    p_vocab.add_argument("--limit", type=int, default=0)
    p_sug = sub.add_parser("suggest", help="normalise terms, nearest existing ones, related tracks")
    for f in cat.FACETS:
        p_sug.add_argument(f"--{f}", nargs="+", action="extend")
    sub.add_parser("outline", help="the review outline the corpus shares")
    p_ve = sub.add_parser(
        "versions", help="the song's versions on YouTube: candidates for extra.versions",
        description="Search YouTube for the versions of a review's song (the artist's video, "
        "Topic releases, remixes, edits, live, covers, dances, shorts), read each candidate's "
        "watch page (never a stream) and suggest a kind with its reasons; --write --pick "
        "appends [[extra.versions]] tables; --verify re-reads every listed version.")
    p_ve.add_argument("file", nargs="?", help="the review (content/<file>.md)")
    p_ve.add_argument("--query", action="append", help="another search, besides the derived ones")
    p_ve.add_argument("--json", action="store_true", help="the report as JSON")
    p_ve.add_argument("--write", action="store_true", help="append the picked versions")
    p_ve.add_argument("--pick", action="append", metavar="ID[:kind]",
                      help="a version to append (its suggested kind unless one is given)")
    p_ve.add_argument("--verify", action="store_true",
                      help="re-read every listed version; exit 1 when one differs")
    p_ve.add_argument("--all", action="store_true", help="with --verify: every review")
    p_ve.add_argument("--refresh", action="store_true", help="bypass the YouTube cache")
    p_ve.add_argument("--youtube-fixture", help="answer from saved pages in a directory (tests)")
    args = parser.parse_args()

    if args.command == "resolve":
        plan = resolve(args.input, args)
        out(plan)
        return 3 if plan["exists"] else (0 if plan["complete"] else 2)
    if args.command == "new":
        return new(args.input, args)
    if args.command == "refresh":
        return refresh(args.file, args)
    if args.command == "enrich":
        return enrich(args.files, args)
    if args.command == "audit-mb":
        return audit_mb(args.files, args)
    if args.command == "check":
        return check(args.file)
    if args.command == "versions":
        return versions(args)
    if args.command == "vocab":
        vocab = vocabulary()
        facets = [args.facet] if args.facet else list(cat.FACETS)
        out({f: dict(list(vocab[f].items())[:args.limit or None]) for f in facets})
        return 0
    if args.command == "suggest":
        facets = {f: getattr(args, f, None) or [] for f in cat.FACETS}
        out({"facets": suggest(facets), "related": related_preview(facets)})
        return 0
    if args.command == "outline":
        out({"outline": json.loads(cat.OUTPUT.read_text(encoding="utf-8"))["outline"]})
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
