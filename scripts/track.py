#!/usr/bin/env python3
"""The track engine: from a YouTube link or "Artist - Track" to a new review that fits the site.

Everything it writes is inferred or derived, never made up:

  - resolve   the input: a YouTube URL (watch, youtu.be, embed, shorts, music) gives the video id,
              and YouTube's oEmbed gives the video title and channel, from which the artist and
              the track are inferred (decorations such as "(Official Video)" dropped, remixes and
              features kept); a name "Artist - Track" is split the same way;
  - identity  the file name content/<slug(artist track)>.md, artist first, exactly what
              scripts/catalog.py infers the artist back from; an existing track (same video,
              same slug, same artist and track) is reported, never duplicated;
  - facets    the terms given are normalised and checked against the corpus vocabulary, with
              the nearest existing term suggested for each new one;
  - related   the tracks the new one would sit next to (the catalogue's similarity);
  - outline   the sections the corpus shares, in their usual order (catalogue "outline"), each
              with the guidance of data/review.toml as a TODO(write) line;
  - article   archetypes/track.md filled in, validated against data/track.schema.json.

The prose is the writer's: the skill add-song (.ai/repo/skills/add-song/SKILL.md) researches
the track and replaces every TODO(write); `check` then proves the article meets the contract.

    python3 scripts/track.py resolve "<link or Artist - Track>" [--offline]
    python3 scripts/track.py new "<link or Artist - Track>" [--genre g ...] [--sentiment s ...]
                             [--mood m ...] [--description "..."] [--artist A] [--track T]
                             [--youtube URL] [--date YYYY-MM-DD] [--dry-run] [--offline]
    python3 scripts/track.py check content/<file>.md
    python3 scripts/track.py vocab [--facet genre] [--limit N]
    python3 scripts/track.py suggest --genre g ... --sentiment s ...
    python3 scripts/track.py outline

Every command prints JSON. Exit codes: 0 ok, 1 contract violation, 2 usage, 3 the track exists.
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
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
CHANNEL_NOISE = re.compile(r"\s*(-\s*topic|vevo|official|music|records?)\s*$", re.I)


def fail(message: str, code: int = 2) -> None:
    print(json.dumps({"error": message}, ensure_ascii=False), file=sys.stderr)
    sys.exit(code)


def youtube_id(text: str) -> str | None:
    """The video id of any YouTube URL form, or None."""
    text = text.strip()
    if VIDEO_ID.match(text):
        return None  # a bare 11-char word is a name, not a link
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


def oembed(video: str, offline: bool) -> dict:
    if offline:
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


def split_name(name: str, channel: str = "") -> tuple[str, str]:
    """'Artist - Track' (any dash) -> (artist, track); without a dash the channel is the artist."""
    name = clean(name)
    for sep in (" - ", " – ", " — ", " | "):
        if sep in name:
            left, right = (p.strip() for p in name.split(sep, 1))
            return (right, left) if sep == " | " else (left, right)
    artist = CHANNEL_NOISE.sub("", channel).strip()
    if artist and name.lower().startswith(artist.lower()):
        # "alt-J (∆) Breezeblocks" from the channel "alt-J": the title repeats the artist.
        rest = re.sub(r"^\s*[\(\[][^)\]]*[\)\]]", "", name[len(artist):]).strip(" -:|")
        if rest:
            return artist, rest
    return artist, name


def fold(text: str) -> str:
    return "".join(cat.words(text))


def resolve(text: str, args) -> dict:
    video = youtube_id(text) or (youtube_id(args.youtube) if getattr(args, "youtube", None) else None)
    meta = oembed(video, args.offline) if video else {}
    if youtube_id(text):
        source = "youtube"
        artist, track = split_name(meta.get("title", ""), meta.get("author", ""))
    else:
        source = "name"
        artist, track = split_name(text)
    artist = getattr(args, "artist", None) or artist
    track = getattr(args, "track", None) or track
    slug = cat.slugify(f"{artist} {track}") if artist and track else ""

    errors: list[str] = []
    tracks = [t for t in (cat.load_track(p, errors) for p in sorted(cat.CONTENT.glob("*.md"))
                          if p.name != "_index.md") if t]
    existing = None
    for t in tracks:
        same_video = video and t.youtube_id == video
        same_name = artist and track and fold(t.artist + t.track) == fold(artist + track)
        if same_video or same_name or (slug and t.path == f"{slug}/"):
            existing = {"source": f"content/{t.source}", "title": t.title, "path": t.path,
                        "why": "same video" if same_video else "same artist and track"}
            break
    return {
        "input": text, "kind": source, "youtube": video, "oembed": meta,
        "artist": artist, "track": track, "title": f"{artist} - {track}" if artist else track,
        "file": f"content/{slug}.md" if slug else "", "exists": existing,
        "complete": bool(artist and track),
    }


def vocabulary() -> dict[str, dict[str, int]]:
    data = json.loads(cat.OUTPUT.read_text(encoding="utf-8"))
    return {f: {x["term"]: x["count"] for x in data["facets"][f]} for f in cat.FACETS}


def suggest(facets: dict[str, list[str]]) -> dict:
    vocab = vocabulary()
    out = {}
    for facet, terms in facets.items():
        rows = []
        for raw in terms:
            term = raw.strip().lower()
            known = term in vocab[facet]
            near = [] if known else difflib.get_close_matches(term, list(vocab[facet]), n=3, cutoff=0.6)
            rows.append({"term": term, "known": known, "uses": vocab[facet].get(term, 0),
                         "nearest": near})
        out[facet] = rows
    return out


def related_preview(facets: dict[str, list[str]]) -> list[dict]:
    errors: list[str] = []
    tracks = [t for t in (cat.load_track(p, errors) for p in sorted(cat.CONTENT.glob("*.md"))
                          if p.name != "_index.md") if t]
    by_source = {t.source: t for t in tracks}
    return [{**r, "title": by_source[r["source"]].title} for r in cat.related_to(facets, tracks)]


def toml_list(terms: list[str]) -> str:
    return "[" + ", ".join(json.dumps(t, ensure_ascii=False) for t in terms) + "]"


def render_body(outline: list[dict]) -> str:
    review = tomllib.loads(REVIEW.read_text(encoding="utf-8"))
    sections = review.get("sections", {})
    default = review["defaults"]["guidance"]
    marker = cat.UNFINISHED
    chunks = []
    for s in outline:
        conf = sections.get(s["name"], {})
        heading = conf.get("heading", s["name"].title())
        chunks.append(f"## {heading}\n\n{marker}: {conf.get('guidance', default)}\n")
        parts = conf.get("parts", {})
        for sub in s["subsections"]:
            chunks.append(f"### {parts.get(sub, sub.title())}\n\n{marker}: one short paragraph.\n")
    return "\n".join(chunks)


def new(text: str, args) -> int:
    plan = resolve(text, args)
    if not plan["complete"]:
        fail("cannot infer both artist and track; pass --artist and --track", 2)
    if plan["exists"] and not args.force:
        print(json.dumps({**plan, "written": False}, ensure_ascii=False, indent=1))
        return 3
    facets = {f: [t.strip().lower() for t in (getattr(args, f) or [])] for f in cat.FACETS}
    if not facets["genre"] or not facets["sentiment"]:
        fail("--genre and --sentiment are required (see: scripts/track.py vocab)", 2)
    catalog = json.loads(cat.OUTPUT.read_text(encoding="utf-8"))
    taxonomies = "\n".join(f"{f} = {toml_list(terms)}" for f, terms in facets.items() if terms)
    extra = []
    if plan["youtube"]:
        extra.append(f'youtube = "https://www.youtube.com/embed/{plan["youtube"]}"')
    if args.artist:
        extra.append(f"artist = {json.dumps(args.artist, ensure_ascii=False)}")
    description = args.description or f"{cat.UNFINISHED}: one or two sentences on the vibe of the track."
    text_out = Template(ARCHETYPE.read_text(encoding="utf-8")).substitute(
        title=plan["title"].replace('"', '\\"'),
        date=args.date or date.today().isoformat(),
        description=description.replace('"', '\\"'),
        taxonomies=taxonomies,
        extra="\n".join(extra),
        body=render_body(catalog["outline"]),
    )
    target = ROOT / plan["file"]
    result = {**plan, "facets": suggest(facets), "related": related_preview(facets),
              "outline": [s["name"] for s in catalog["outline"]],
              "words_target": tomllib.loads(REVIEW.read_text(encoding="utf-8"))["defaults"]["words_target"],
              "written": not args.dry_run}
    if not args.dry_run:
        target.write_text(text_out, encoding="utf-8")
    else:
        result["preview"] = text_out
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return 0


def check(path: str) -> int:
    file = (ROOT / path).resolve()
    errors: list[str] = []
    track = cat.load_track(file, errors)
    todo = file.read_text(encoding="utf-8").count(cat.UNFINISHED)
    report = {"file": path, "errors": errors, "unfinished": todo}
    if track:
        report.update({"artist": track.artist, "track": track.track, "inferred": track.inferred,
                       "words": track.words, "slug": track.path})
    print(json.dumps(report, ensure_ascii=False, indent=1))
    return 1 if errors else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p):
        p.add_argument("input")
        p.add_argument("--offline", action="store_true", help="do not ask YouTube's oEmbed")
        p.add_argument("--youtube", help="the video, when the input is a name")
        p.add_argument("--artist")
        p.add_argument("--track")

    common(sub.add_parser("resolve", help="infer artist, track, video and file; find duplicates"))
    p_new = sub.add_parser("new", help="write content/<slug>.md from the archetype")
    common(p_new)
    for f in cat.FACETS:
        p_new.add_argument(f"--{f}", nargs="+")
    p_new.add_argument("--description")
    p_new.add_argument("--date")
    p_new.add_argument("--dry-run", action="store_true")
    p_new.add_argument("--force", action="store_true", help="write although the track exists")
    sub.add_parser("check", help="validate one article").add_argument("file")
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
        print(json.dumps(plan, ensure_ascii=False, indent=1))
        return 3 if plan["exists"] else 0
    if args.command == "new":
        return new(args.input, args)
    if args.command == "check":
        return check(args.file)
    if args.command == "vocab":
        vocab = vocabulary()
        facets = [args.facet] if args.facet else list(cat.FACETS)
        out = {f: dict(list(vocab[f].items())[:args.limit or None]) for f in facets}
        print(json.dumps(out, ensure_ascii=False, indent=1))
        return 0
    if args.command == "suggest":
        facets = {f: getattr(args, f) or [] for f in cat.FACETS}
        print(json.dumps({"facets": suggest(facets), "related": related_preview(facets)},
                         ensure_ascii=False, indent=1))
        return 0
    if args.command == "outline":
        print(json.dumps(json.loads(cat.OUTPUT.read_text(encoding="utf-8"))["outline"], indent=1))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
