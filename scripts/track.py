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
    python3 scripts/track.py vocab [--facet genre] [--limit N]
    python3 scripts/track.py suggest --genre g ... --sentiment s ...
    python3 scripts/track.py outline
  --oembed-fixture <file.json> answers oEmbed from a file ({"<video id>": {"title", "author_name"}})

Every command prints JSON. Exit codes: 0 ok, 1 contract violation or unfinished article,
2 usage, 3 the track exists.
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import sys
import tempfile
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path
from string import Template

sys.path.insert(0, str(Path(__file__).resolve().parent))
import catalog as cat  # noqa: E402  (the same inference and contract the build uses)

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


def fail(message: str, code: int = 2) -> None:
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
_mb_last = [0.0]


def mb_get(url: str, args) -> dict:
    """GET a MusicBrainz JSON document: from the fixture (tests), the cache (outside the
    repository), or the API at most once a second, as its terms ask."""
    if getattr(args, "mb_fixture", None):
        data = json.loads(Path(args.mb_fixture).read_text(encoding="utf-8"))
        return data.get(url, {})
    cache = json.loads(MB_CACHE.read_text(encoding="utf-8")) if MB_CACHE.exists() else {}
    if url in cache:
        return cache[url]
    wait = 1.1 - (time.monotonic() - _mb_last[0])
    if wait > 0:
        time.sleep(wait)
    request = urllib.request.Request(url, headers={"User-Agent": MB_AGENT, "Accept": "application/json"})
    data: dict = {}
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.loads(response.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as exc:
            if exc.code in (429, 503) and attempt < 3:
                time.sleep(2 ** attempt * 2)
                continue
            if exc.code == 404:
                data = {}
                break
            raise
    _mb_last[0] = time.monotonic()
    cache[url] = data
    MB_CACHE.parent.mkdir(parents=True, exist_ok=True)
    MB_CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    return data


def mb_quote(text: str) -> str:
    return '"' + re.sub(r'([+\-&|!(){}\[\]^"~*?:\\/])', r"\\\1", text) + '"'


def seconds(mmss: str | None) -> int | None:
    if not mmss or not re.fullmatch(r"\d{1,2}:\d{2}", mmss):
        return None
    m, s_ = mmss.split(":")
    return int(m) * 60 + int(s_)


def mb_match(artist: str, track: str, duration: int | None, args) -> dict:
    """The MusicBrainz recording of artist - track: a search scored by MusicBrainz, then kept
    only when the title and the main artist agree (folded), the closest length when the video's
    is known, else the earliest release. Ambiguity is reported, never guessed."""
    main = re.split(r",| feat\.? | & | x ", artist, maxsplit=1)[0].strip()
    title = re.sub(r"\s*\((feat\.|ft\.)[^)]*\)", "", track).strip()
    q = f"recording:{mb_quote(title)} AND artist:{mb_quote(main)}"
    found = mb_get(MB + "recording?" + urllib.parse.urlencode({"query": q, "fmt": "json", "limit": 15}), args)
    want_title, want_artist = fold(title), fold(main)
    candidates = []
    for r in found.get("recordings", []):
        credits = " ".join(c.get("name", "") + " " + (c.get("artist", {}).get("name", ""))
                           for c in r.get("artist-credit", []))
        if int(r.get("score", 0)) < 85 or fold(r.get("title", "")) != want_title:
            continue
        if want_artist not in fold(credits):
            continue
        dates = sorted(x.get("date", "") for x in r.get("releases", []) if x.get("date"))
        length = (r.get("length") or 0) // 1000 or None
        candidates.append({"r": r, "first": dates[0] if dates else "9999", "length": length})
    if not candidates:
        return {"status": "no-match", "query": q}
    if duration:
        candidates.sort(key=lambda c: (abs((c["length"] or 10**6) - duration), c["first"]))
    else:
        candidates.sort(key=lambda c: c["first"])
    best = candidates[0]["r"]
    first = candidates[0]["first"]
    artist_id = next((c["artist"]["id"] for c in best.get("artist-credit", []) if "artist" in c), "")
    releases = sorted((x for x in best.get("releases", []) if x.get("date")), key=lambda x: x["date"])
    found_artist = mb_get(MB + f"artist/{artist_id}?fmt=json", args) if artist_id else {}
    return {"status": "matched", "recording": best["id"], "artist": artist_id,
            "release": releases[0]["id"] if releases else "",
            "isrc": sorted(best.get("isrcs", []))[:1],
            "year": first[:4] if first != "9999" else "",
            "country": found_artist.get("country") or "",
            "candidates": len(candidates)}


def enrich(paths: list[str], args) -> int:
    """Fill what MusicBrainz knows into [extra]: the recording, artist and first release ids,
    the ISRC, the artist's country, and the release year when the review has none. A value the
    review already has is kept; without --write this only reports."""
    files = cat.review_files() if args.all else [content_path(p) for p in paths]
    report = {"matched": [], "unchanged": [], "no-match": [], "failed": []}
    for file in files:
        if file.name == "_index.md":
            continue
        errors: list[str] = []
        t = cat.load_track(file, errors)
        if not t:
            continue
        rel = f"content/{file.name}"
        if t.full_extra.get("musicbrainz") and not args.force:
            report["unchanged"].append(rel)
            continue
        try:
            m = mb_match(t.artist, t.track, seconds(t.full_extra.get("video_duration")), args)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            report["failed"].append({"file": rel, "error": str(exc)})
            continue
        if m["status"] != "matched":
            report["no-match"].append({"file": rel, "query": m.get("query")})
            continue
        updates = {"musicbrainz": {k: m[k] for k in ("recording", "artist", "release") if m[k]}}
        if m["isrc"] and not t.full_extra.get("isrc"):
            updates["isrc"] = m["isrc"][0]
        # MusicBrainz uses XW (worldwide), XE (Europe) and XU (unknown) for areas, not countries.
        if (m["country"] and re.fullmatch(r"[A-Z]{2}", m["country"]) and m["country"] not in ("XW", "XE", "XU")
                and not t.full_extra.get("country")):
            updates["country"] = m["country"]
        if m["year"] and not t.full_extra.get("release_year"):
            updates["release_year"] = m["year"]
        entry = {"file": rel, "updates": updates, "candidates": m["candidates"]}
        if args.write and write_extra(file, rel, updates, quiet=True) != 0:
            report["failed"].append({"file": rel, "error": "the rewritten article fails the contract"})
            continue
        report["matched"].append(entry)
    out({"written": bool(args.write), **{k: v for k, v in report.items()},
         "counts": {k: len(v) for k, v in report.items()}})
    return 1 if report["failed"] else 0


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
    p_vocab = sub.add_parser("vocab", help="the facet vocabulary, most used first")
    p_vocab.add_argument("--facet", choices=cat.FACETS)
    p_vocab.add_argument("--limit", type=int, default=0)
    p_sug = sub.add_parser("suggest", help="normalise terms, nearest existing ones, related tracks")
    for f in cat.FACETS:
        p_sug.add_argument(f"--{f}", nargs="+")
    sub.add_parser("outline", help="the review outline the corpus shares")
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
    if args.command == "check":
        return check(args.file)
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
