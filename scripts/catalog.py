#!/usr/bin/env python3
"""Derive the track catalogue from the front matter of content/*.md.

Nothing in the catalogue is written by hand. Every value comes from an article or is inferred
from it, and the templates and the browser read only this file (static/data/catalog.json):

  - the content contract: every article validates against data/track.schema.json (the one
    formal contract), plus the checks a schema cannot express: a calendar date, a cover image
    that exists, local links that resolve, no placeholder hosts, no unfinished section;
  - artist and track, inferred from the title ("Artist - Track", "Track | Artist") and checked
    against the file name, which starts with the artist; `extra.artist`/`extra.track` win;
  - the URL path Zola gives the page (its slugified file name);
  - the thumbnail: `extra.cover_image`, else the video's YouTube still;
  - related tracks: weighted Jaccard similarity over the facets, with the shared terms that
    explain each link;
  - the review outline: the sections most articles share, in their usual order, which
    scripts/track.py writes into a new article;
  - facet counts, genre x sentiment co-occurrence, tracks per month, artists.

    python3 scripts/catalog.py           write static/data/catalog.json
    python3 scripts/catalog.py --check   exit 1 on a contract violation or a stale catalogue
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTENT = ROOT / "content"
STATIC = ROOT / "static"
OUTPUT = STATIC / "data" / "catalog.json"
SEARCH = STATIC / "data" / "search.json"
VIDEO_STATUS = ROOT / "data" / "videos.json"  # written by scripts/probe-videos.py --write
CONTRACT = ROOT / "data" / "track.schema.json"
SCHEMA = "sonic-catalog/v1"

TRACK_SCHEMA = json.loads(CONTRACT.read_text(encoding="utf-8"))
CONCEPT_SCHEMA = json.loads((ROOT / "data" / "concept.schema.json").read_text(encoding="utf-8"))
CONCEPTS_DIR = ROOT / TRACK_SCHEMA["x-sonic"]["concepts_dir"]
LOCALES = sorted(p.stem for p in (ROOT / "data" / "i18n").glob("*.toml"))
# What of [extra] the browser's catalogue carries: what cards, the explorer and charts show. The
# educational fields (ADR 0004) stay in the article: its page reads them from page.extra, and
# the structured data is derived into data/derived/jsonld.json, used by the build only.
CATALOG_EXTRA = ("album", "publisher", "release_year", "video_duration", "country")
JSONLD = ROOT / "data" / "derived" / "jsonld.json"
CONFIG = tomllib.loads((ROOT / "config.toml").read_text(encoding="utf-8"))
CONTENT_LINK = re.compile(r'\{\{\s*<(concept|track)_link\s+(?:name|source)="([^"]+)"[^>]*/>\s*\}\}')
GONE_VIDEOS = (json.loads(VIDEO_STATUS.read_text(encoding="utf-8"))["gone"]
               if VIDEO_STATUS.exists() else {})
RULES = TRACK_SCHEMA["x-sonic"]
FACETS = tuple(TRACK_SCHEMA["properties"]["taxonomies"]["properties"])
FACET_WEIGHTS = RULES["facet_weights"]
RELATED_LIMIT = RULES["related_limit"]
PLACEHOLDER_HOSTS = tuple(RULES["placeholder_hosts"])
UNFINISHED = RULES["unfinished_marker"]
OUTLINE_THRESHOLD = RULES["outline_threshold"]
TOP_PAIRS = 24
YOUTUBE_ID = re.compile(r"/embed/([A-Za-z0-9_-]{11})$")
# A single letter other than "a"/"I" at the end of a line, the word going on on the next line:
# Markdown renders it "T he". Found 33 times in the restored reviews (2026-11-12).
SPLIT_WORD = re.compile(r"(?<![\w’'])[b-hj-zB-HJ-Z] ?\n[a-z]+")
ROOT_ABSOLUTE = re.compile(r'(?:\]\(|\b(?:src|href)=")(/[^)"\s]*)')
SEPARATORS = (" - ", " – ")


# --- The contract: a validator for the JSON Schema subset data/track.schema.json uses. -------

SUPPORTED = {
    "$schema", "$id", "$ref", "$defs", "title", "description", "type", "required",
    "additionalProperties", "properties", "items", "pattern", "minLength", "minItems",
    "uniqueItems", "x-sonic", "enum",
}


def unsupported(schema, where: str = "#") -> list[str]:
    """Keywords this validator does not implement: refused, so a contract change can never be
    silently ignored."""
    found = []
    if isinstance(schema, dict):
        for key, value in schema.items():
            if key not in SUPPORTED:
                found.append(f"{where}/{key}")
            if key in ("properties", "$defs"):
                for name, sub in value.items():
                    found += unsupported(sub, f"{where}/{key}/{name}")
            elif key == "items":
                found += unsupported(value, f"{where}/items")
    return found


def validate(value, schema: dict, where: str = "", root: dict | None = None) -> list[str]:
    """Return one message per violation of `schema` (type, required, additionalProperties,
    properties, items, pattern, minLength, minItems, uniqueItems, $ref into $defs)."""
    root = root or schema
    if "$ref" in schema:
        target = root
        for part in schema["$ref"].lstrip("#/").split("/"):
            target = target[part]
        merged = {**target, **{k: v for k, v in schema.items() if k != "$ref"}}
        return validate(value, merged, where, root)
    at = where or "front matter"
    kind = schema.get("type")
    types = {"object": dict, "array": list, "string": str, "boolean": bool, "integer": int}
    if kind and (not isinstance(value, types[kind]) or (kind == "integer" and isinstance(value, bool))):
        return [f"{at}: must be {kind}, got {type(value).__name__}"]
    if "enum" in schema and value not in schema["enum"]:
        return [f"{at}: '{value}' is not one of {', '.join(map(str, schema['enum']))}"]
    errors: list[str] = []
    if kind == "object":
        props = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{at}: '{key}' is required")
        for key, item in value.items():
            path = f"{where}.{key}" if where else key
            if key in props:
                errors += validate(item, props[key], path, root)
            elif schema.get("additionalProperties") is False:
                errors.append(f"{at}: unknown key '{key}' (allowed: {', '.join(props)})")
    elif kind == "array":
        if len(value) < schema.get("minItems", 0):
            errors.append(f"{at}: needs at least {schema['minItems']} item(s)")
        if schema.get("uniqueItems") and len(set(map(str, value))) != len(value):
            errors.append(f"{at}: repeats an item")
        for i, item in enumerate(value):
            errors += validate(item, schema.get("items", {}), f"{where}[{i}]", root)
    elif kind == "string":
        if len(value) < schema.get("minLength", 0):
            errors.append(f"{at}: shorter than {schema['minLength']} characters")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{at}: '{value}' does not match {schema['pattern']}")
    return errors


# --- Inference. ------------------------------------------------------------------------------

# Letters NFKD does not decompose into a base letter; Zola (deunicode) transliterates them, so must
# this ("Tomas Høffding" is "hoffding", not "hffding": a defect found on 2026-11-12).
TRANSLIT = str.maketrans({"ø": "o", "Ø": "O", "æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE", "ß": "ss",
                          "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "ð": "d", "Ð": "D", "þ": "th",
                          "Þ": "TH", "ı": "i", "ħ": "h", "Ħ": "H"})


def slugify(text: str) -> str:
    """Zola's default slug (slugify = on): transliterate, lowercase, non-alphanumerics to '-'."""
    ascii_text = (unicodedata.normalize("NFKD", text.translate(TRANSLIT))
                  .encode("ascii", "ignore").decode())
    return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")


def words(text: str) -> list[str]:
    return [w for w in slugify(text).split("-") if w]


def split_front_matter(text: str, name: str) -> tuple[str, str]:
    match = re.match(r"\A\+\+\+\r?\n(.*?)\r?\n\+\+\+\r?\n?(.*)\Z", text, re.S)
    if not match:
        raise ValueError(f"{name}: no TOML front matter between +++ lines")
    return match.group(1), match.group(2)


def infer_artist_track(title: str, stem: str) -> tuple[str, str, str]:
    """Return (artist, track, rule). The file name starts with the artist, so it decides."""
    stem_letters = "".join(words(stem))

    def prefix_score(part: str) -> int:
        """How many leading letters of the file name the part spells (hyphens ignored)."""
        n = 0
        for a, b in zip("".join(words(part)), stem_letters):
            if a != b:
                break
            n += 1
        return n

    if " | " in title:
        track, *credits = (p.strip() for p in title.split(" | "))
        return ", ".join(credits), track, "title: track | artist"
    for sep in SEPARATORS:
        if sep in title:
            left, right = (p.strip() for p in title.split(sep, 1))
            if prefix_score(right) > prefix_score(left):
                return right, left, "title: track - artist (file name starts with the artist)"
            return left, right, "title: artist - track"
    # No separator: the title is the track, the artist is what the file name has before it.
    stem_words = words(stem)
    track_words = words(title)
    for i in range(1, len(stem_words)):
        if stem_words[i:i + len(track_words)] == track_words[:len(stem_words) - i]:
            return " ".join(w.capitalize() for w in stem_words[:i]), title, \
                "file name: artist before the title"
    return "", title, "title only (artist unknown)"


def headings(body: str) -> list[tuple[int, str]]:
    """The review's section headings as (level, normalised name): 'Intro: Intriguing Start' and
    'Intro - x' both count as 'intro'."""
    out = []
    for hashes, text in re.findall(r"^(#{2,3}) +(.+?) *$", body, re.M):
        name = re.split(r"\s*[:–—]\s*|\s+-\s+", text.strip(), maxsplit=1)[0].strip().lower()
        out.append((len(hashes), name))
    return out


# --- Identity: which review a recording of a playlist is (one song, one page). ---------------

BACKLOG = ROOT / "data" / "backlog"
BACKLOG_SCHEMA = json.loads((ROOT / "data" / "backlog.schema.json").read_text(encoding="utf-8"))
# Version suffixes that do not make another song; a remix, a mix of another artist, a live take of
# a different arrangement stays a song of its own.
VERSION = re.compile(
    r"\s*(?:-\s*)?(?:\(|\[)?\b(?:remaster(?:ed)?(?: version)?(?: \d{4})?|radio edit|radio version|"
    r"radio mix|original mix|extended version|album version|edit)\b(?:\)|\])?\s*$", re.I)
FEAT = re.compile(r"\s*[\(\[]?\s*\b(?:feat\.?|featuring|ft\.)\s+[^\)\]]*[\)\]]?", re.I)


def fold(text: str) -> str:
    return "".join(words(text))


def song(title: str) -> str:
    """The song a recording title names: without featured artists and version suffixes."""
    base = FEAT.sub("", title)
    previous = None
    while previous != base:
        previous = base
        base = VERSION.sub("", base).strip(" -")
    return base.strip()


def identity_index(tracks: list) -> dict:
    """Keys a playlist item can be matched on: ISRC, and (artist, song) folded, for the main
    artist alone when a review has one artist and for the whole credit always."""
    by_isrc: dict[str, set] = defaultdict(set)
    by_key: dict[tuple, set] = defaultdict(set)
    for t in tracks:
        source, artist, track = (t.source, t.artist, t.track) if isinstance(t, Track) else (
            t["source"], t["artist"], t["track"])
        extra = t.full_extra if isinstance(t, Track) else {}
        if extra.get("isrc"):
            by_isrc[extra["isrc"]].add(source)
        if "," not in artist:
            by_key[(fold(artist.split(" feat")[0]), fold(song(track)))].add(source)
        by_key[(fold(artist), fold(song(track)))].add(source)
    return {"isrc": by_isrc, "key": by_key}


def resolve_item(item: dict, index: dict) -> dict:
    """One playlist item -> one review, or the reason it has none. Evidence in order: an explicit
    review=, skip=, an uncertain reading, the ISRC, then artist and song; several candidates are
    ambiguous and never chosen between."""
    if item.get("review"):
        exists = (CONTENT / item["review"]).is_file()
        return {"status": "present" if exists else "broken", "source": item["review"], "by": "override"}
    if item.get("skip"):
        return {"status": "skipped", "source": None, "by": item["skip"]}
    if item.get("uncertain") or not item.get("title") or not item.get("artists"):
        return {"status": "uncertain", "source": None, "by": "the item could not be read"}
    if item.get("isrc") and len(index["isrc"].get(item["isrc"], ())) == 1:
        return {"status": "present", "source": next(iter(index["isrc"][item["isrc"]])), "by": "isrc"}
    found: set = set()
    for key in ((fold(item["artists"][0]), fold(song(item["title"]))),
                (fold(", ".join(item["artists"])), fold(song(item["title"])))):
        found |= index["key"].get(key, set())
    if len(found) == 1:
        return {"status": "present", "source": next(iter(found)), "by": "artist and song"}
    if len(found) > 1:
        return {"status": "ambiguous", "source": None, "by": ", ".join(sorted(found))}
    return {"status": "missing", "source": None, "by": "no review yet"}


def load_playlists(errors: list[str]) -> list[dict]:
    out = []
    for path in sorted(BACKLOG.glob("*.toml")):
        rel = path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else str(path)
        try:
            data = tomllib.loads(path.read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError as exc:
            errors.append(f"{rel}: {exc}")
            continue
        for problem in validate(data, BACKLOG_SCHEMA):
            errors.append(f"{rel}: {problem}")
        if data.get("kind") == "yearbook" and not isinstance(data.get("year"), int):
            errors.append(f"{rel}: a yearbook needs its year")
        positions = [i.get("n") for i in data.get("track", [])]
        if len(set(positions)) != len(positions):
            errors.append(f"{rel}: a position n repeats")
        out.append({**data, "file": rel})
    out = [p for p in out if p.get("kind") != "yearbook" or isinstance(p.get("year"), int)]
    years = [p["year"] for p in out if p.get("kind") == "yearbook"]
    for y in {y for y in years if years.count(y) > 1}:
        errors.append(f"data/backlog: two yearbooks of {y}")
    return out


def yearbooks(tracks: list[Track], errors: list[str]) -> tuple[list[dict], dict[str, list[dict]]]:
    """The owner's annual Top Songs as derived collections: every item resolved to its review,
    in playlist order, with counts, artists and genres; and per review the years it is in."""
    index = identity_index(tracks)
    by_source = {t.source: t for t in tracks}
    books, member_of = [], defaultdict(list)
    for p in sorted((p for p in load_playlists(errors) if p.get("kind") == "yearbook"),
                    key=lambda p: p["year"], reverse=True):
        items = []
        for item in sorted(p.get("track", []), key=lambda i: i["n"]):
            r = resolve_item(item, index)
            if r["status"] == "broken":
                errors.append(f"{p['file']} #{item['n']}: review={item['review']} names no review")
            if r["source"] and r["source"] not in by_source:
                r = {**r, "status": "missing"}  # a draft or an unpublished review
            items.append({"n": item["n"], "title": item.get("title", ""),
                          "artist": ", ".join(item.get("artists", [])), "status": r["status"],
                          "source": r["source"] if r["status"] == "present" else None})
            if r["status"] == "present":
                member_of[r["source"]].append({"year": p["year"], "n": item["n"]})
        present = [by_source[i["source"]] for i in items if i["source"]]
        artists = Counter(t.artist for t in present)
        genres = Counter(g for t in present for g in t.facets["genre"])
        books.append({
            "year": p["year"], "name": p.get("name", ""), "file": p["file"],
            "expected": p.get("expected"), "items": len(items),
            "songs": len({i["source"] for i in items if i["source"]}),
            **{s: sum(1 for i in items if i["status"] == s)
               for s in ("present", "missing", "ambiguous", "skipped", "uncertain")},
            "artists": [{"term": k, "count": v} for k, v in sorted(artists.items(), key=lambda kv: (-kv[1], kv[0]))[:12]],
            "genres": [{"term": k, "count": v} for k, v in sorted(genres.items(), key=lambda kv: (-kv[1], kv[0]))[:12]],
            "tracks": items,
        })
    return books, {k: sorted(v, key=lambda m: m["year"]) for k, v in member_of.items()}


# --- Concepts (the glossary the articles teach from). ----------------------------------------

def load_concepts(errors: list[str]) -> dict[str, dict]:
    """data/concepts/<slug>.toml, one concept each: its term, category, a definition in every
    locale and the concepts it relates to. The file name is the slug of the term."""
    found: dict[str, dict] = {}
    for path in sorted(CONCEPTS_DIR.glob("*.toml")):
        rel = path.relative_to(ROOT).as_posix()
        try:
            data = tomllib.loads(path.read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError as exc:
            errors.append(f"{rel}: {exc}")
            continue
        for problem in validate(data, CONCEPT_SCHEMA):
            errors.append(f"{rel}: {problem}")
        term = str(data.get("term", ""))
        if slugify(term) != path.stem:
            errors.append(f"{rel}: the file name must be the slug of its term ({slugify(term)}.toml)")
        for code in LOCALES:
            if not (data.get(code) or {}).get("definition"):
                errors.append(f"{rel}: no definition in locale '{code}'")
        found[path.stem] = data
    for slug, data in found.items():
        for other in data.get("see_also", []):
            if slugify(other) not in found:
                errors.append(f"data/concepts/{slug}.toml: see_also '{other}' is not a concept")
    return found


KNOWN_CONCEPTS: dict[str, dict] = {}


def review_exists(source: str) -> bool:
    """A reference to another review: in the content directory, or in the repository's own when
    an article is proven in isolation (scripts/track.py writes through a temporary directory)."""
    return bool(source) and ((CONTENT / source).is_file() or (ROOT / "content" / source).is_file())


# --- One article. ----------------------------------------------------------------------------

@dataclass
class Track:
    source: str
    path: str
    title: str
    artist: str
    track: str
    inferred: str
    date: str
    description: str
    facets: dict[str, list[str]]
    youtube_id: str | None
    thumbnail: str
    thumbnail_local: bool
    words: int
    extra: dict = field(default_factory=dict)
    full_extra: dict = field(default_factory=dict)  # the whole [extra], for derivations only
    outline: list = field(default_factory=list)
    index: str = ""
    video_gone: bool = False


def load_track(path: Path, errors: list[str], include_drafts: bool = False) -> Track | None:
    if not KNOWN_CONCEPTS:  # one article checked alone (scripts/track.py check) needs the glossary
        KNOWN_CONCEPTS.update(load_concepts([]))
    rel = path.relative_to(CONTENT).as_posix()
    text = path.read_text(encoding="utf-8")
    try:
        raw, body = split_front_matter(text, rel)
        meta = tomllib.loads(raw)
    except (ValueError, tomllib.TOMLDecodeError) as exc:
        errors.append(f"{rel}: {exc}")
        return None
    if meta.get("draft") is True and not include_drafts:
        return None

    def err(msg: str) -> None:
        errors.append(f"{rel}: {msg}")

    for problem in validate(meta, TRACK_SCHEMA):
        err(problem)
    extra = meta.get("extra", {}) or {}
    taxonomies = meta.get("taxonomies", {}) or {}
    for key, value in extra.items():
        if isinstance(value, str) and any(h in value for h in PLACEHOLDER_HOSTS):
            err(f"extra.{key} points at a placeholder host: {value}")

    title = str(meta.get("title", "")).strip()
    when = str(meta.get("date", ""))
    try:
        date.fromisoformat(when)
    except ValueError:
        err(f"date '{when}' is not a calendar date")
    description = str(meta.get("description", "")).strip()
    facets = {f: [str(t).strip().lower() for t in taxonomies.get(f, [])] for f in FACETS}

    match = YOUTUBE_ID.search(str(extra.get("youtube", "")))
    youtube_id = match.group(1) if match else None
    # A video YouTube no longer serves (data/videos.json) is neither shown nor its still
    # requested: each would be a console error on every page that lists the track.
    video_gone = bool(youtube_id) and youtube_id in GONE_VIDEOS
    if video_gone:
        youtube_id = None

    thumbnail, local = "", False
    cover = extra.get("cover_image")
    if cover:
        if not (STATIC / str(cover).lstrip("/")).is_file():
            err(f"extra.cover_image '{cover}' is not a file under static/")
        else:
            thumbnail, local = str(cover).lstrip("/"), True
    if not thumbnail and youtube_id:
        thumbnail = f"https://i.ytimg.com/vi/{youtube_id}/hqdefault.jpg"

    artist, track, rule = infer_artist_track(title, path.stem)
    if extra.get("artist"):
        artist, rule = str(extra["artist"]), "front matter: extra.artist"
    if extra.get("track"):
        track = str(extra["track"])
    if not artist:
        err("artist cannot be inferred from the title or the file name; set extra.artist")

    rendered = "\n".join(line for line in body.splitlines() if not line.startswith("[//]: #"))
    for match in ROOT_ABSOLUTE.finditer(rendered):
        err(f"root-absolute URL {match.group(1)} breaks under the Pages sub-path; use "
            '{{ <figure src="images/..." /> }} or a @/ link')
    for match in SPLIT_WORD.finditer(rendered):
        err(f"a word is split across lines ('{match.group(0).replace(chr(10), '⏎')}'); join it")
    if re.search(r"<iframe\b", rendered, re.I):
        err('raw <iframe>: use {{ <video id="..." title="..." /> }} or a plain link')
    for match in re.finditer(r'<figure src="([^"]+)"', rendered):
        if not (STATIC / match.group(1)).is_file():
            err(f"figure {match.group(1)} is not a file under static/")
    for kind, target in CONTENT_LINK.findall(rendered):
        if kind == "track" and not review_exists(target):
            err(f"{{{{ <track_link source=\"{target}\" /> }}}} names no review")
        if kind == "concept" and slugify(target) not in KNOWN_CONCEPTS:
            err(f"{{{{ <concept_link name=\"{target}\" /> }}}} is not defined in {CONCEPTS_DIR.relative_to(ROOT)}/")
        elif kind == "concept" and target not in [str(c) for c in taxonomies.get("concept", [])]:
            err(f"{{{{ <concept_link name=\"{target}\" /> }}}} is linked but not in taxonomies.concept; add it there")
    if UNFINISHED in body or UNFINISHED in description:
        err(f"has an unfinished section ({UNFINISHED}); write it or remove it")

    for term in facets.get("concept", []):
        if slugify(term) not in KNOWN_CONCEPTS:
            err(f"concept '{term}' is not defined: add {CONCEPTS_DIR.relative_to(ROOT)}/{slugify(term)}.toml")
    for i, m in enumerate(((extra.get("learning") or {}).get("listen_for")) or []):
        if isinstance(m, dict) and not (m.get("at") or m.get("part")):
            err(f"extra.learning.listen_for[{i}] needs a part of the song or a sourced time (at)")
    for c in extra.get("connections", []) or []:
        if isinstance(c, dict) and not review_exists(str(c.get("source", ""))):
            err(f"extra.connections names {c.get('source')}, which is no review")
        if isinstance(c, dict) and c.get("source") == rel:
            err("extra.connections names the review itself")
    kept_extra = {k: extra[k] for k in CATALOG_EXTRA if k in extra}
    return Track(
        source=rel, path=f"{slugify(path.stem)}/", title=title, artist=artist, track=track,
        inferred=rule, date=when, description=description, facets=facets,
        youtube_id=youtube_id, thumbnail=thumbnail, thumbnail_local=local,
        words=len(re.findall(r"\w+", body)), extra=kept_extra, outline=headings(body),
        video_gone=video_gone, full_extra=extra,
        index=" ".join(sorted({w for w in words(re.sub(r"\{\{.*?\}\}|<[^>]+>|\]\([^)]*\)", " ", body))
                               if len(w) > 2})),
    )


# --- What the corpus says. -------------------------------------------------------------------

def related_to(facets: dict[str, list[str]], tracks: list[Track], exclude: str = "") -> list[dict]:
    """Weighted Jaccard over the facet terms; ties go to the newer, then the title."""
    def features(fs: dict[str, list[str]]) -> dict[str, float]:
        return {f"{f}:{term}": FACET_WEIGHTS[f] for f in FACETS for term in fs.get(f, [])}

    a = features(facets)
    scored = []
    for u in tracks:
        if u.source == exclude:
            continue
        b = features(u.facets)
        shared = set(a) & set(b)
        if not shared:
            continue
        inter = sum(min(a[k], b[k]) for k in shared)
        union = sum(max(a.get(k, 0), b.get(k, 0)) for k in set(a) | set(b))
        scored.append((round(inter / union, 4), u.date, u.title, u, sorted(shared)))
    scored.sort(key=lambda s: (-s[0], -int(s[1].replace("-", "")), s[2]))
    return [{"source": u.source, "score": score, "shared": shared}
            for score, _, _, u, shared in scored[:RELATED_LIMIT]]


def related(tracks: list[Track]) -> dict[str, list[dict]]:
    return {t.source: related_to(t.facets, tracks, exclude=t.source) for t in tracks}


def outline(tracks: list[Track]) -> list[dict]:
    """The sections at least OUTLINE_THRESHOLD of the reviews share, ordered by where they
    usually sit; each carries the sub-sections its articles share the same way."""
    n = len(tracks) or 1
    h2_count, h2_pos = Counter(), defaultdict(list)
    sub_count, sub_pos = defaultdict(Counter), defaultdict(lambda: defaultdict(list))
    for t in tracks:
        tops = [name for level, name in t.outline if level == 2]
        current = None
        sub_index = 0
        seen, seen_sub = set(), set()
        for level, name in t.outline:
            if level == 2:
                current, sub_index = name, 0
                if name not in seen:
                    seen.add(name)
                    h2_count[name] += 1
                    h2_pos[name].append(tops.index(name) / max(1, len(tops) - 1))
            elif current:
                key = (current, name)
                if key not in seen_sub:
                    seen_sub.add(key)
                    sub_count[current][name] += 1
                    sub_pos[current][name].append(sub_index)
                sub_index += 1
    sections = []
    for name, count in h2_count.items():
        if count / n < OUTLINE_THRESHOLD:
            continue
        subs = [
            {"name": s, "share": round(c / count, 2),
             "position": round(sum(sub_pos[name][s]) / len(sub_pos[name][s]), 2)}
            for s, c in sub_count[name].items() if c / count >= OUTLINE_THRESHOLD
        ]
        subs.sort(key=lambda s: (s["position"], s["name"]))
        sections.append({"name": name, "share": round(count / n, 2),
                         "position": round(sum(h2_pos[name]) / len(h2_pos[name]), 2),
                         "subsections": [s["name"] for s in subs]})
    sections.sort(key=lambda s: (s["position"], s["name"]))
    return sections


def build(errors: list[str]) -> dict:
    for keyword in unsupported(TRACK_SCHEMA):
        errors.append(f"data/track.schema.json: {keyword} is not implemented by the validator")
    KNOWN_CONCEPTS.clear()
    KNOWN_CONCEPTS.update(load_concepts(errors))
    files = sorted(p for p in CONTENT.glob("*.md") if p.name != "_index.md")
    tracks = [t for t in (load_track(p, errors) for p in files) if t]

    seen: dict[str, str] = {}
    for t in tracks:
        if t.path in seen:
            errors.append(f"{t.source}: URL /{t.path} collides with {seen[t.path]}")
        seen[t.path] = t.source

    tracks.sort(key=lambda t: (t.date, t.title), reverse=True)
    rel = related(tracks)
    books, member_of = yearbooks(tracks, errors)
    # Once the corpus is complete, the contract requires every review to teach (ADR 0004).
    if TRACK_SCHEMA["x-sonic"].get("edu_required"):
        for t in tracks:
            missing = [p for p in EDU_PARTS if p not in edu_parts(t)]
            if missing:
                errors.append(f"{t.source}: an educational article needs {', '.join(missing)} (ADR 0004)")
    facet_counts = {f: Counter(term for t in tracks for term in t.facets[f]) for f in FACETS}
    pairs = Counter((g, s) for t in tracks for g in t.facets["genre"] for s in t.facets["sentiment"])
    months = Counter(t.date[:7] for t in tracks)
    artists = Counter(t.artist for t in tracks)
    word_counts = sorted(t.words for t in tracks) or [0]

    def ranked(counter: Counter) -> list[dict]:
        return [{"term": k, "slug": slugify(k), "count": v}
                for k, v in sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))]

    return {
        "schema": SCHEMA,
        "generated_by": "scripts/catalog.py",
        "contract": "data/track.schema.json",
        "stats": {
            "tracks": len(tracks),
            "artists": len(artists),
            "videos": sum(1 for t in tracks if t.youtube_id),
            "videos_gone": sum(1 for t in tracks if t.video_gone),
            "words": sum(t.words for t in tracks),
            "median_words": word_counts[len(word_counts) // 2],
            "first": min((t.date for t in tracks), default=""),
            "last": max((t.date for t in tracks), default=""),
            **{f"{f}_terms": len(facet_counts[f]) for f in FACETS},
            "yearbooks": len(books),
            "recurring": sum(1 for m in member_of.values() if len(m) > 1),
        },
        "outline": outline(tracks),
        "facet_names": list(FACETS),
        "concepts": concept_index(tracks),
        "concept_categories": CONCEPT_SCHEMA["properties"]["category"]["enum"],
        "yearbooks": books,
        "recurring": sorted(s for s, m in member_of.items() if len(m) > 1),
        "education": education(tracks),
        "facets": {f: ranked(facet_counts[f]) for f in FACETS},
        "pairs": [{"genre": g, "sentiment": s, "count": c}
                  for (g, s), c in sorted(pairs.items(), key=lambda kv: (-kv[1], kv[0]))
                  [:TOP_PAIRS]],
        "months": [{"month": m, "count": months[m]} for m in sorted(months)],
        "artists": ranked(artists),
        "lookup": {t.source: i for i, t in enumerate(tracks)},
        "_search": {t.source: t.index for t in tracks},
        "_jsonld": jsonld(tracks),
        "tracks": [
            {
                "source": t.source, "path": t.path, "title": t.title, "artist": t.artist,
                "track": t.track, "inferred": t.inferred, "date": t.date,
                "description": t.description, "facets": t.facets, "youtube": t.youtube_id,
                "thumbnail": t.thumbnail, "thumbnail_local": t.thumbnail_local,
                "words": t.words, "extra": t.extra, "related": rel[t.source],
                "video_gone": t.video_gone, "edu": edu_parts(t),
                "yearbooks": member_of.get(t.source, []),
            }
            for t in tracks
        ],
    }


def concept_index(tracks: list[Track]) -> list[dict]:
    """Every defined concept with the tracks that demonstrate it, by category then term."""
    using: dict[str, list[str]] = {}
    for t in tracks:
        for term in t.facets.get("concept", []):
            using.setdefault(slugify(term), []).append(t.source)
    out = []
    for slug, data in KNOWN_CONCEPTS.items():
        out.append({"slug": slug, "term": data["term"], "category": data["category"],
                    "wikipedia": data.get("wikipedia", ""),
                    "see_also": [slugify(x) for x in data.get("see_also", [])],
                    "definition": {code: data[code]["definition"] for code in LOCALES if code in data},
                    "tracks": sorted(using.get(slug, []))})
    return sorted(out, key=lambda c: (c["category"], c["term"]))


# What makes a review an educational article (ADR 0004); measured, so the corpus shows how far
# it is and the contract can require it once every review has it.
EDU_PARTS = ("concept", "learning", "sources", "credits", "musicbrainz")


def education(tracks: list[Track]) -> dict:
    def has(t: Track, part: str) -> bool:
        return bool(t.facets.get("concept")) if part == "concept" else bool(t.full_extra.get(part))
    return {"parts": list(EDU_PARTS),
            "complete": sum(1 for t in tracks if all(has(t, p) for p in EDU_PARTS)),
            **{p: sum(1 for t in tracks if has(t, p)) for p in EDU_PARTS}}


def edu_parts(t: Track) -> list[str]:
    return [p for p in EDU_PARTS
            if (t.facets.get("concept") if p == "concept" else t.full_extra.get(p))]


def jsonld(tracks: list[Track]) -> dict:
    """schema.org structured data per review: the recording (with its identifiers as sameAs) and
    the review as an Article that is also a LearningResource (what it teaches, its level, the
    sources it cites). Keyed by source; templates/base.html prints the entry of its page."""
    base = CONFIG["base_url"].rstrip("/")
    site = {"@type": "WebSite", "name": CONFIG["title"], "url": base + "/"}
    out = {}
    for t in tracks:
        x = t.full_extra
        url = f"{base}/{t.path}"
        mb = x.get("musicbrainz", {}) or {}
        same = [f"https://musicbrainz.org/recording/{mb['recording']}"] if mb.get("recording") else []
        if x.get("wikidata"):
            same.append(f"https://www.wikidata.org/wiki/{x['wikidata']}")
        if t.youtube_id:
            same.append(f"https://www.youtube.com/watch?v={t.youtube_id}")
        artist = {"@type": "MusicGroup", "name": t.artist}
        if mb.get("artist"):
            artist["sameAs"] = f"https://musicbrainz.org/artist/{mb['artist']}"
        recording = {"@type": "MusicRecording", "@id": url + "#recording", "name": t.track,
                     "byArtist": artist, "genre": t.facets.get("genre", [])}
        for key, prop in (("isrc", "isrcCode"), ("release_year", "datePublished")):
            if x.get(key):
                recording[prop] = x[key]
        if x.get("album"):
            recording["inAlbum"] = {"@type": "MusicAlbum", "name": x["album"]}
        if same:
            recording["sameAs"] = same
        article = {"@type": ["Article", "LearningResource"], "@id": url + "#review",
                   "headline": t.title, "description": t.description, "url": url,
                   "datePublished": t.date, "inLanguage": "en", "about": {"@id": url + "#recording"},
                   "author": {"@type": "Person", "name": CONFIG.get("extra", {}).get("author", CONFIG["title"])},
                   "isPartOf": site, "wordCount": t.words}
        if t.facets.get("concept"):
            article["teaches"] = [{"@type": "DefinedTerm", "name": c,
                                   "url": f"{base}/concept/{slugify(c)}/"} for c in t.facets["concept"]]
        learning = x.get("learning") or {}
        if learning.get("level"):
            article["educationalLevel"] = learning["level"]
            article["learningResourceType"] = "listening guide"
        if x.get("sources"):
            article["citation"] = [{"@type": "CreativeWork", "name": s["title"], "url": s["url"],
                                    **({"publisher": s["publisher"]} if s.get("publisher") else {}),
                                    **({"datePublished": s["year"]} if s.get("year") else {})}
                                   for s in x["sources"]]
        out[t.source] = {"@context": "https://schema.org", "@graph": [recording, article]}
    return out


YEARBOOK_PAGES = CONTENT / "yearbook"


def yearbook_pages(catalog: dict) -> dict[Path, str]:
    """The pages of the yearbooks: a section and one stub per year, front matter only; every
    word and number on them comes from the catalogue (templates/yearbooks.html, yearbook.html).
    Derived, so --check refuses a stale or a leftover one."""
    books = catalog["yearbooks"]
    if not books:
        return {}
    pages = {YEARBOOK_PAGES / "_index.md": (
        "+++\n# Derived by scripts/catalog.py from data/backlog/ (kind = \"yearbook\"); do not edit.\n"
        'title = "Yearbooks"\ntemplate = "yearbooks.html"\nsort_by = "title"\n+++\n')}
    for b in books:
        pages[YEARBOOK_PAGES / f"{b['year']}.md"] = (
            "+++\n# Derived by scripts/catalog.py from " + b["file"] + "; do not edit.\n"
            f'title = "{b["year"]}"\ntemplate = "yearbook.html"\n'
            f'description = "The owner\'s most played songs of {b["year"]}: {b["items"]} recordings, '
            f'{b["songs"]} with a review on Sonic Playground."\n\n[extra]\nyear = {b["year"]}\n+++\n')
    return pages


def render(catalog: dict) -> str:
    return json.dumps({k: v for k, v in catalog.items() if not k.startswith("_")},
                      ensure_ascii=False, indent=1) + "\n"


def render_search(catalog: dict) -> str:
    """The review text index the explorer loads on the first query: per track, the distinct
    folded words of its review (static/data/search.json, sonic-search/v1)."""
    return json.dumps({"schema": "sonic-search/v1", "generated_by": "scripts/catalog.py",
                       "tracks": catalog["_search"]}, ensure_ascii=False, indent=0) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--check", action="store_true",
                        help="fail on a contract violation or a stale catalogue; write nothing")
    args = parser.parse_args()

    errors: list[str] = []
    catalog = build(errors)
    pages = yearbook_pages(catalog)
    leftovers = [p for p in YEARBOOK_PAGES.glob("*.md") if p not in pages] if YEARBOOK_PAGES.exists() else []
    outputs = {**pages, OUTPUT: render(catalog), SEARCH: render_search(catalog),
               JSONLD: json.dumps(catalog["_jsonld"], ensure_ascii=False, indent=1, sort_keys=True) + "\n"}
    count = catalog["stats"]["tracks"]
    for e in errors:
        print(f"catalog: {e}", file=sys.stderr)
    if errors:
        print(f"catalog: {len(errors)} contract violation(s)", file=sys.stderr)
        return 1
    if args.check:
        stale = [p for p, text in outputs.items()
                 if not p.exists() or p.read_text(encoding="utf-8") != text]
        for p in stale:
            print(f"catalog: {p.relative_to(ROOT)} is stale; run npm run derive", file=sys.stderr)
        for p in leftovers:
            print(f"catalog: {p.relative_to(ROOT)} belongs to no yearbook; run npm run derive", file=sys.stderr)
        if stale or leftovers:
            return 1
        print(f"catalog: {count} tracks, contract and catalogue current")
        return 0
    for p in leftovers:
        p.unlink()
    for path, text in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.read_text(encoding="utf-8") == text:
            continue  # unchanged: derivation is idempotent down to the file's timestamp
        path.write_text(text, encoding="utf-8")
        print(f"catalog: wrote {path.relative_to(ROOT)} ({count} tracks)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
