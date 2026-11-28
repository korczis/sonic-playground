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
  - facet counts, genre x sentiment co-occurrence, tracks per month, artists;
  - the genre families (data/genres.toml): each family's terms and tracks, a term no family
    lists placed by inference and reported, so browsing never hides a scene behind an umbrella.

    python3 scripts/catalog.py           write static/data/catalog.json
    python3 scripts/catalog.py --check   exit 1 on a contract violation or a stale catalogue
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import tomllib
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import translation as tr  # noqa: E402  (the translation contract, ADR 0006)

ROOT = Path(__file__).resolve().parent.parent
CONTENT = ROOT / "content"
STATIC = ROOT / "static"
OUTPUT = STATIC / "data" / "catalog.json"
SEARCH = STATIC / "data" / "search.json"
PLAY = STATIC / "data" / "play.json"
# The player's index (static/data/play.json): a projection of each catalogue track onto what the
# player, the track menu and the random button read, in the catalogue's own shape (a field here
# is that field of catalog.json, related items keep only their source, i18n only each path). The
# first play of a page without charts loads this (~20 kB gzip), not the catalogue (~160 kB).
PLAY_FIELDS = ("source", "path", "artist", "track", "youtube")
VIDEO_STATUS = ROOT / "data" / "videos.json"  # written by scripts/probe-videos.py --write
MEDIA = STATIC / "data" / "images.json"  # written by scripts/images.py (data/media.toml)


def card_still(src: str) -> str:
    """A local still as a card shows it: the smallest derived variant at least card_width wide in
    the fallback format (scripts/images.py), else the source until the variants are rendered
    (scripts/images.py --check refuses that state)."""
    media = json.loads(MEDIA.read_text(encoding="utf-8")) if MEDIA.exists() else {}
    entry = media.get("images", {}).get(src)
    if not entry:
        return src
    rows = sorted(entry["variants"][media["formats"][-1]])
    wide = [r for r in rows if r[0] >= media["card_width"]]
    return (wide[0] if wide else rows[-1])[2]
CONTRACT = ROOT / "data" / "track.schema.json"
SCHEMA = "sonic-catalog/v1"

TRACK_SCHEMA = json.loads(CONTRACT.read_text(encoding="utf-8"))
CONCEPT_SCHEMA = json.loads((ROOT / "data" / "concept.schema.json").read_text(encoding="utf-8"))
CONCEPTS_DIR = ROOT / TRACK_SCHEMA["x-sonic"]["concepts_dir"]
GENRES = ROOT / "data" / "genres.toml"
LOCALES = sorted(p.stem for p in (ROOT / "data" / "i18n").glob("*.toml"))
# What of [extra] the browser's catalogue carries: what cards, the explorer and charts show. The
# educational fields (ADR 0004) stay in the article: its page reads them from page.extra, and
# the structured data is derived into data/derived/jsonld.json, used by the build only.
CATALOG_EXTRA = ("album", "publisher", "release_year", "video_duration", "country")
JSONLD = ROOT / "data" / "derived" / "jsonld.json"
# When each review entered the repository (sonic-published/v1): a tracked record, so the
# catalogue's order derives from the tree alone, never from a history a copy may not carry.
PUBLISHED = ROOT / "data" / "published.json"
CONFIG = tomllib.loads((ROOT / "config.toml").read_text(encoding="utf-8"))
DEFAULT_LANG = CONFIG["default_language"]
LANGUAGES = sorted(CONFIG.get("languages", {}))  # the languages besides the default (ADR 0006)
TRANSLATION_SCHEMA = json.loads((ROOT / "data" / "translation.schema.json").read_text(encoding="utf-8"))
LYRIC_RUN = 8
CONTENT_LINK = re.compile(r'\{\{\s*<(concept|track)_link\s+(?:name|source)="([^"]+)"[^>]*/>\s*\}\}')
GONE_VIDEOS = (json.loads(VIDEO_STATUS.read_text(encoding="utf-8"))["gone"]
               if VIDEO_STATUS.exists() else {})
RULES = TRACK_SCHEMA["x-sonic"]
FACETS = tuple(TRACK_SCHEMA["properties"]["taxonomies"]["properties"])
FACET_WEIGHTS = RULES["facet_weights"]
RELATED_LIMIT = RULES["related_limit"]
PLACEHOLDER_HOSTS = tuple(RULES["placeholder_hosts"])
UNFINISHED = RULES["unfinished_marker"]
TRANSLATION = RULES["translation"]
# Phrases that would fit any track say nothing about this one (rule educational-article).
CLICHES = tuple(c.lower() for c in RULES["cliches"])
SHARED_PARAGRAPH = RULES["shared_paragraph_chars"]
# A review is about the song, never about the site owner's listening (rule educational-article):
# "here because it was among the owner's most played songs of 2022" was written into 36 reviews
# and their translations by 2026-11-22, and says nothing about the music. Narrow on purpose: the
# owner named outright ("the owner", "majitel", "vlastník") next to a listening word. "The
# duo's most played song", a station's playlist or "the label owner" are not refused.
_EN_OWNER = r"\b[Tt]he\s+(?:site(?:'s|’s)?\s+)?owner"  # lower-case: the song "The Owner" is not
_CS_LISTEN = (r"(?:poslouch|poslech|přehrá|pouště|streamov|ročen[kc]|playlist|nejposlouchanějš"
              r"|nejpřehrávanějš|nejhranějš|oblíben)\w*")
_CS_OWNER = r"\b(?:majitel|vlastník)\w*"
OWNER_LISTENING = tuple(re.compile(p) for p in (
    _EN_OWNER + r"(?:'s|’s)\s+(?:(?i:own|spotify|annual)\s+)?(?i:most[- ]played|most[- ]streamed"
    r"|top|favou?rites?|listening|playlists?|yearbooks?|library|songs?|tracks?|picks?|rotation"
    r"|liked|plays|streams|collection|history)\b",
    _EN_OWNER + r"\s+(?:(?i:has|had|often|kept|keeps)\s+)?(?i:played|plays|listened|listens"
    r"|streamed|streams|liked|likes|saved|replayed)\b",
    r"(?i)" + _CS_OWNER + r"(?:\W+\w+){0,4}?\W+" + _CS_LISTEN,
    r"(?i)" + _CS_LISTEN + r"(?:\W+\w+){0,4}?\W+" + _CS_OWNER,
    r"(?i)\b(?:písn|píseň|skladb)\w*\s+" + _CS_OWNER,
    r"(?i)\b(?:majitelov|vlastníkov)\w*\s+(?:písn|píseň|skladb|seznam|výběr)\w*",
))
WORDS_MIN = tomllib.loads((ROOT / "data" / "review.toml").read_text(encoding="utf-8"))["defaults"]["words_min"]
# The credit's first name: "A & B", "A x B", "A, B", "A feat. B" all name A first.
MAIN_ARTIST = re.compile(r"\s*(?:,|&| x | and |\bfeat\.?|\bft\.|\bfeaturing\b|\bvs\.?)\s*", re.I)
OUTLINE_THRESHOLD = RULES["outline_threshold"]
TOP_PAIRS = 24
NOTES: list[str] = []  # findings that are reported but violate no contract (an inferred family)
YOUTUBE_ID = re.compile(r"/embed/([A-Za-z0-9_-]{11})$")
# A link in a review's prose to a YouTube video (watch, shorts, youtu.be): extra.versions renders
# the song's versions, so the prose never repeats one as a link.
WATCH_LINK = re.compile(r"\]\(https://(?:www\.)?(?:youtube\.com/(?:watch\?v=|shorts/)|youtu\.be/)([A-Za-z0-9_-]{11})")
# The kinds of extra.versions that come from the artist (and their label); the rest are what
# others made of the song. The page shows the two groups apart.
ARTIST_KINDS = ("official-video", "original", "self-release", "licensed-release", "official-remix")
DURATION = re.compile(r"^(\d+:[0-5]\d|\d{1,2}):[0-5]\d$")  # data/track.schema.json versions[].duration
VERSION_FIELDS = ("kind", "title", "by", "youtube", "url", "format", "duration", "date", "rights",
                  "note", "review", "source")
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
TRANSLIT_MAP = {"ø": "o", "Ø": "O", "æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE", "ß": "ss",
                          "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "ð": "d", "Ð": "D", "þ": "th",
                          "Þ": "TH", "ı": "i", "ħ": "h", "Ħ": "H"}
TRANSLIT = str.maketrans(TRANSLIT_MAP)


def slugify(text: str) -> str:
    """Zola's default slug (slugify = on): transliterate, lowercase, non-alphanumerics to '-'."""
    ascii_text = (unicodedata.normalize("NFKD", text.translate(TRANSLIT))
                  .encode("ascii", "ignore").decode())
    return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")


def words(text: str) -> list[str]:
    return [w for w in slugify(text).split("-") if w]


# The explorer's search (static/js/explorer.js) and its index (static/data/search.json) read
# words alike: the same folding, the same cuts, the same word forms. The browser takes both
# tables from catalog.json `search`, so they are written once, here and in data/i18n/forms/.
SEARCH_FOLD = {k: v for k, v in TRANSLIT_MAP.items() if k == k.lower()}
SEARCH_FORMS = {p.stem: tomllib.loads(p.read_text(encoding="utf-8"))
                for p in sorted((ROOT / "data" / "i18n" / "forms").glob("*.toml"))}
SEARCH_FOLD_TABLE = str.maketrans(SEARCH_FOLD)
MARKS = re.compile(r"[\u0300-\u036f]")


def word_form(word: str, forms: dict) -> str:
    """A word in its search form (data/i18n/forms/<lang>.toml): the first suffix that ends it
    decides; a stem shorter than min_stem leaves the word as it is."""
    for suffix, to in forms.get("suffixes", []):
        if word.endswith(suffix):
            stem = word[:len(word) - len(suffix)]
            return stem + to if len(stem) >= forms["min_stem"] else word
    return word


def search_tokens(text: str, lang: str = DEFAULT_LANG) -> list[str]:
    """The explorer's tokens of a text, as static/js/explorer.js `tokens` cuts a query: lowercase,
    the letters of SEARCH_FOLD, NFKD without its combining marks, split at every character that
    is not a-z or 0-9, each token in its word form; a possessive is its word. Every token is kept, in order, short ones and
    digits included: "TB-303" is "tb 303", and a phrase is tokens side by side."""
    # A possessive is its word ("punk's" is "punk", "dj's" "dj"), a decade its plural ("80's"
    # is "80s"), never a token "s".
    lower = re.sub(r"([0-9])['\u2019]s(?![a-z0-9])", r"\1s", text.lower())
    lower = re.sub(r"(\S)['\u2019]s(?![a-z0-9])", r"\1", lower)
    folded = MARKS.sub("", unicodedata.normalize("NFKD", lower.translate(SEARCH_FOLD_TABLE)))
    forms = SEARCH_FORMS.get(lang, {})
    return [word_form(w, forms) for w in re.split(r"[^a-z0-9]+", folded) if w]


def search_text(body: str, lang: str = DEFAULT_LANG) -> str:
    """A review's entry in the search index (sonic-search/v2): its prose as search tokens in
    order, without shortcodes, HTML and link targets."""
    return " ".join(search_tokens(re.sub(r"\{\{.*?\}\}|<[^>]+>|\]\([^)]*\)", " ", body), lang))


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
# a different arrangement stays a song of its own. The phrase is the whole of a bracket or follows
# " - ": "[Moodymann Edit]" is another artist's edit, "- Edit" and "(Edit)" are versions.
_VERSION = (r"(?:(?:\d{4} )?(?:digital )?remaster(?:ed|isée|isé|izado)?(?: version)?(?: \d{4})?|radio edit|"
            r"radio version|radio mix|original mix|original|extended (?:version|mix)|album version|"
            r"single version|bonus track|mixed|edit)")
VERSION = re.compile(rf"\s*(?:-\s*{_VERSION}|\(\s*{_VERSION}\s*\)|\[\s*{_VERSION}\s*\])\s*$", re.I)
# A featured artist: "feat. X" anywhere, or "(with X)" as a whole bracket ("Giant (with Rag'n'Bone
# Man)"); a bare "with" is part of a title ("Dancing with Myself").
FEAT = re.compile(r"\s*(?:[\(\[]?\s*\b(?:feat\.?|featuring|ft\.)\s+[^\)\]]*[\)\]]?"
                  r"|[\(\[]\s*with\s+[^\)\]]*[\)\]])", re.I)


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
    by_lead: dict[tuple, set] = defaultdict(set)  # the review's first artist; a last resort
    for t in tracks:
        source, artist, track = (t.source, t.artist, t.track) if isinstance(t, Track) else (
            t["source"], t["artist"], t["track"])
        extra = t.full_extra if isinstance(t, Track) else {}
        if extra.get("isrc"):
            by_isrc[extra["isrc"]].add(source)
        for name in (track, *extra.get("titles", ())):
            if "," not in artist:
                by_key[(fold(artist.split(" feat")[0]), fold(song(name)))].add(source)
            by_key[(fold(artist), fold(song(name)))].add(source)
            by_key[(credit(artist.split(", ")), fold(song(name)))].add(source)
            by_lead[(fold(artist.split(", ")[0].split(" feat")[0]), fold(song(name)))].add(source)
    return {"isrc": by_isrc, "key": by_key, "lead": by_lead}


def credit(artists: list[str]) -> str:
    """A credit of several artists in any order: "Alok, Zeeba, Bruno Martini" is the credit
    "Alok, Bruno Martini, Zeeba"."""
    return "&".join(sorted(fold(a) for a in artists))


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
                (fold(", ".join(item["artists"])), fold(song(item["title"]))),
                (credit(item["artists"]), fold(song(item["title"])))):
        found |= index["key"].get(key, set())
    if not found:  # "Stimming - November Morning" is the review "Stimming, David Christensen, ..."
        lead = index.get("lead", {}).get((fold(item["artists"][0]), fold(song(item["title"]))), set())
        if len(lead) == 1:
            return {"status": "present", "source": next(iter(lead)), "by": "lead artist and song"}
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
        for item in data.get("track", []):
            if item.get("review") and not (CONTENT / item["review"]).is_file():
                errors.append(f"{rel} #{item.get('n')}: review={item['review']} names no review")
        positions = [i.get("n") for i in data.get("track", [])]
        if len(set(positions)) != len(positions):
            errors.append(f"{rel}: a position n repeats")
        out.append({**data, "file": rel})
    out = [p for p in out if p.get("kind") != "yearbook" or isinstance(p.get("year"), int)]
    years = [p["year"] for p in out if p.get("kind") == "yearbook"]
    for y in {y for y in years if years.count(y) > 1}:
        errors.append(f"data/backlog: two yearbooks of {y}")
    return out


def yearbooks(tracks: list[Track], errors: list[str],
              families: list[dict] | None = None) -> tuple[list[dict], dict[str, list[dict]]]:
    """The owner's annual Top Songs as derived collections: every item resolved to its review,
    in playlist order, with counts, artists, genres and genre families (a song counts once in a
    family); and per review the years it is in."""
    family_of = {x["term"]: f["id"] for f in families or [] for x in f["terms"]}
    umbrella = {f["id"] for f in families or [] if f["umbrella"]}
    index = identity_index(tracks)
    by_source = {t.source: t for t in tracks}
    books, member_of = [], defaultdict(list)
    for p in sorted((p for p in load_playlists(errors) if p.get("kind") == "yearbook"),
                    key=lambda p: p["year"], reverse=True):
        items = []
        for item in sorted(p.get("track", []), key=lambda i: i["n"]):
            r = resolve_item(item, index)
            if r["source"] and r["source"] not in by_source:
                r = {**r, "status": "missing"}  # a draft or an unpublished review
            items.append({"n": item["n"], "title": item.get("title", ""),
                          "artist": ", ".join(item.get("artists", [])), "status": r["status"],
                          "source": r["source"] if r["status"] == "present" else None})
            # Two recordings of one song in one year (a single and its album version) are one
            # membership, at the higher place.
            if r["status"] == "present" and not any(m["year"] == p["year"] for m in member_of[r["source"]]):
                member_of[r["source"]].append({"year": p["year"], "n": item["n"]})
        present = [by_source[i["source"]] for i in items if i["source"]]
        artists = Counter(t.artist for t in present)
        genres = Counter(g for t in present for g in t.facets["genre"])
        fams = Counter(fid for t in {t.source: t for t in present}.values()
                       for fid in {family_of[g] for g in t.facets["genre"] if g in family_of})
        books.append({
            "year": p["year"], "name": p.get("name", ""), "file": p["file"],
            "expected": p.get("expected"), "items": len(items),
            "songs": len({i["source"] for i in items if i["source"]}),
            **{s: sum(1 for i in items if i["status"] == s)
               for s in ("present", "missing", "ambiguous", "skipped", "uncertain")},
            "artists": [{"term": k, "count": v} for k, v in sorted(artists.items(), key=lambda kv: (-kv[1], kv[0]))[:12]],
            "genres": [{"term": k, "count": v} for k, v in sorted(genres.items(), key=lambda kv: (-kv[1], kv[0]))[:12]],
            "families": [{"id": k, "count": v} for k, v in sorted(
                fams.items(), key=lambda kv: (kv[0] in umbrella, -kv[1], kv[0]))],
            "tracks": items,
        })
    return books, {k: sorted(v, key=lambda m: m["year"]) for k, v in member_of.items()}


# --- Genre families (data/genres.toml). -------------------------------------------------------

def load_genre_families(errors: list[str]) -> list[dict]:
    """data/genres.toml: the families, each with an id, a name in every language and its terms.
    A term in two families, or a family without a name, is a contract violation."""
    if not GENRES.exists():
        return []
    families = tomllib.loads(GENRES.read_text(encoding="utf-8")).get("family", [])
    owner: dict[str, str] = {}
    ids: set[str] = set()
    for f in families:
        fid = f.get("id", "")
        if not re.fullmatch(r"[a-z][a-z0-9-]*", fid) or fid in ids:
            errors.append(f"data/genres.toml: family id '{fid}' is missing, malformed or repeated")
        ids.add(fid)
        for lang in [DEFAULT_LANG] + LANGUAGES:
            if not str(f.get(lang, "")).strip():
                errors.append(f"data/genres.toml: family '{fid}' has no {lang} name")
        for term in f.get("terms", []):
            if term in owner:
                errors.append(f"data/genres.toml: '{term}' is in '{owner[term]}' and '{fid}'")
            owner[term] = fid
    return families


def genre_families(tracks: list[Track], families: list[dict], notes: list[str]) -> list[dict]:
    """Each family with the terms in use, their counts and the family's tracks (a track counts
    once however many of its terms the family holds), largest first. A term no family lists goes
    to the family of the listed term it shares the most reviews with; it is marked `inferred`
    and named in `notes`, and a term that shares none goes to the last family. An `umbrella`
    family (terms that name no scene) comes after every other."""
    if not families:
        return []
    by_term: dict[str, set[str]] = defaultdict(set)
    for t in tracks:
        for g in t.facets["genre"]:
            by_term[g].add(t.source)
    written = {term: f["id"] for f in families for term in f.get("terms", [])}
    placed = {term: fid for term, fid in written.items() if term in by_term}
    inferred = set()
    for term in sorted(set(by_term) - set(written)):
        shared = Counter()
        for other, fid in placed.items():
            if other not in inferred:
                shared[fid] += len(by_term[term] & by_term[other])
        fid = shared.most_common(1)[0][0] if shared and shared.most_common(1)[0][1] else families[-1]["id"]
        placed[term] = fid
        inferred.add(term)
        notes.append(f"genre '{term}' is in no family of data/genres.toml; placed in '{fid}' by inference")
    out = []
    for f in families:
        terms = sorted((term for term, fid in placed.items() if fid == f["id"]),
                       key=lambda term: (-len(by_term[term]), term))
        if not terms:
            continue
        members = set().union(*(by_term[term] for term in terms))
        out.append({"id": f["id"], "count": len(members), "umbrella": bool(f.get("umbrella")),
                    "names": terms,
                    "terms": [{"term": term, "slug": slugify(term), "count": len(by_term[term]),
                               **({"inferred": True} if term in inferred else {})} for term in terms]})
    return sorted(out, key=lambda f: (f["umbrella"], -f["count"], f["id"]))


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


def review_files() -> list[Path]:
    """The reviews: every content/*.md but the section and the translations (<name>.<lang>.md)."""
    return sorted(p for p in CONTENT.glob("*.md") if p.name != "_index.md" and not tr.translation_name(p.name))


def first_added(log: str) -> dict[str, int]:
    """When each review entered the repository, from `git log --diff-filter=A --no-renames
    --format=%x00%at --name-only -- content`: file name -> the author time of its oldest add."""
    added: dict[str, int] = {}
    when = 0
    for line in log.splitlines():
        if line.startswith("\x00"):
            when = int(line[1:])
        elif line.startswith("content/") and line.count("/") == 1:
            added[line.removeprefix("content/")] = when  # the log runs newest first
    return added


def publication_order(tracks: list[Track], added: dict[str, int]) -> None:
    """Newest first: by date, then within a day by the time the review entered the repository
    (one not yet committed is the newest), then by title."""
    newest = max(added.values(), default=0) + 1
    tracks.sort(key=lambda t: (t.date, added.get(t.source, newest), t.title), reverse=True)


def load_published() -> dict[str, int]:
    """data/published.json: review file -> when it entered the repository (Unix seconds)."""
    if not PUBLISHED.exists():
        return {}
    return {k: int(v) for k, v in json.loads(PUBLISHED.read_text(encoding="utf-8"))["reviews"].items()}


def published_times(sources: list[str], recorded: dict[str, int], added: dict[str, int],
                    now: int) -> tuple[dict[str, int], list[str]]:
    """Every review's time, the recorded one first, else when git first added it, else now; and
    the reviews that had no record (`npm run derive` writes them, `--check` refuses them)."""
    times: dict[str, int] = {}
    missing: list[str] = []
    for s in sorted(sources):
        if s in recorded:
            times[s] = recorded[s]
        else:
            missing.append(s)
            times[s] = added.get(s, now)
    return times, missing


def render_published(times: dict[str, int]) -> str:
    """One review per line, sorted, so two branches that add reviews merge line by line."""
    return json.dumps({"schema": "sonic-published/v1", "generated_by": "scripts/catalog.py",
                       "reviews": times}, indent=1, sort_keys=True) + "\n"


def git_added() -> dict[str, int]:
    """first_added() of this checkout's history; empty outside a git work tree."""
    try:
        log = subprocess.run(
            ["git", "log", "--diff-filter=A", "--no-renames", "--format=%x00%at", "--name-only",
             "--", "content"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return {}
    return first_added(log)


def load_translations(tracks: list[Track], errors: list[str]) -> dict[str, dict[str, dict]]:
    """Per language, per review: what its translation says (title, description, path, words,
    index), each checked against its English page (scripts/translation.py). A missing one is an
    error once x-sonic.translation.required is true."""
    out: dict[str, dict[str, dict]] = {lang: {} for lang in LANGUAGES}
    by_source = {t.source: t for t in tracks}
    for path in tr.files(CONTENT):
        rel = path.relative_to(CONTENT).as_posix()
        english, lang = tr.split_name(path.name)
        english = (path.parent / english).relative_to(CONTENT).as_posix()
        if lang not in LANGUAGES:
            errors.append(f"{rel}: '{lang}' is no language of config.toml ([languages.{lang}])")
            continue
        if not (CONTENT / english).is_file():
            errors.append(f"{rel}: translates {english}, which does not exist")
            continue
        if english not in by_source:
            continue  # a page or a section: page_translations() checks it
        t = by_source[english]
        try:
            raw, body = split_front_matter(path.read_text(encoding="utf-8"), rel)
            meta = tomllib.loads(raw)
        except (ValueError, tomllib.TOMLDecodeError) as exc:
            errors.append(f"{rel}: {exc}")
            continue
        problems = (validate(meta, TRANSLATION_SCHEMA) + tr.check(rel, meta, body, t.fingerprint, TRANSLATION)
                    + owner_listening_problems(meta, body))
        errors += [f"{rel}: {p}" for p in problems]
        out[lang][english] = {
            "title": str(meta.get("title", "")).strip(), "description": str(meta.get("description", "")).strip(),
            "path": f"{lang}/{t.path}", "words": len(re.findall(r"\w+", body)),
            "index": search_text(body, lang),
        }
    for lang in LANGUAGES:
        missing = [t.source for t in tracks if t.source not in out[lang]]
        if missing and TRANSLATION["required"]:
            errors += [f"{s}: has no {lang} translation ({s[:-3]}.{lang}.md; python3 scripts/translate.py scaffold {s})"
                       for s in missing]
    return out


def page_translations(errors: list[str]) -> dict[str, list[str]]:
    """The pages and sections that are not reviews (_index.md, pages/*.md): each has its
    translation beside it, current (translation.of), and identical to it but for its words
    (title, description, body). Derived pages (yearbook/) are written in every language."""
    present: dict[str, list[str]] = {lang: [] for lang in LANGUAGES}
    reviews = {p.relative_to(CONTENT).as_posix() for p in review_files()}
    for path in sorted(CONTENT.rglob("*.md")):
        rel = path.relative_to(CONTENT).as_posix()
        if tr.translation_name(path.name) or rel in reviews or rel.startswith("yearbook/"):
            continue
        raw, body = split_front_matter(path.read_text(encoding="utf-8"), rel)
        meta = tomllib.loads(raw)
        if meta.get("draft") is True:
            continue
        for lang in LANGUAGES:
            other = path.with_name(path.name[:-3] + f".{lang}.md")
            orel = other.relative_to(CONTENT).as_posix()
            if not other.is_file():
                if TRANSLATION["required"]:
                    errors.append(f"{rel}: has no {lang} translation ({orel})")
                continue
            present[lang].append(rel)
            oraw, obody = split_front_matter(other.read_text(encoding="utf-8"), orel)
            ometa = tomllib.loads(oraw)
            of = ((ometa.get("extra") or {}).get("translation") or {}).get("of", "")
            if of != tr.prose_hash(meta, body):
                errors.append(f"{orel}: translates English text {of or '(none)'} but {rel} is now "
                              f"{tr.prose_hash(meta, body)}: update it, then python3 scripts/translate.py bless {orel}")
            if meta.get("path") and ometa.get("path") != f"{lang}/{meta['path']}":
                errors.append(f"{orel}: path must be \"{lang}/{meta['path']}\" (Zola does not prefix a custom path)")
            def facts(m):
                x = {k: v for k, v in m.items() if k not in ("title", "description", "extra", "path")}
                x["extra"] = {k: v for k, v in (m.get("extra") or {}).items() if k != "translation"}
                return x
            if facts(ometa) != facts(meta):
                errors.append(f"{orel}: front matter other than title and description differs from {rel}")
            marker = TRANSLATION["untranslated_marker"]
            for where, text in (("title", ometa.get("title", "")), ("description", ometa.get("description", "")), ("body", obody)):
                if marker in str(text):
                    errors.append(f"{orel}: {where} is not translated yet ({marker})")
                elif where != "title" and not tr.czech_enough(str(text), TRANSLATION["czech_word_ratio"]):
                    errors.append(f"{orel}: {where} does not read as Czech")
    return present


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
    paragraphs: list = field(default_factory=list)  # the long ones, normalised: shared-text check
    fingerprint: dict = field(default_factory=dict)  # what a translation keeps (scripts/translation.py)


def owner_listening(text: str) -> list[str]:
    """The phrases of text that speak of the site owner's listening (OWNER_LISTENING)."""
    found = (m.group(0) for p in OWNER_LISTENING for m in p.finditer(text))
    return sorted({re.sub(r"\s+", " ", f) for f in found})


def owner_listening_problems(meta: dict, body: str) -> list[str]:
    """Every place of a review or a translation, front matter and prose, that speaks of the
    owner's listening: a review is about the song (rule educational-article)."""
    def strings(value, where: str):
        if isinstance(value, str):
            yield where, value
        elif isinstance(value, dict):
            for k, v in value.items():
                yield from strings(v, f"{where}.{k}" if where else str(k))
        elif isinstance(value, list):
            for i, v in enumerate(value):
                yield from strings(v, f"{where}[{i}]")

    prose = "\n".join(line for line in body.splitlines() if not line.startswith("[//]: #"))
    problems = []
    for where, text in [*strings(meta, ""), ("the body", prose)]:
        for phrase in owner_listening(text):
            problems.append(f"{where} says '{phrase}': a review is about the song, never about the "
                            "owner's listening; remove the sentence (rule educational-article)")
    return problems


def load_track(path: Path, errors: list[str], include_drafts: bool = False) -> Track | None:
    if not KNOWN_CONCEPTS:  # one article checked alone (scripts/track.py check) needs the glossary
        KNOWN_CONCEPTS.update(load_concepts([]))
    rel = path.relative_to(CONTENT).as_posix()
    text = path.read_text(encoding="utf-8")
    if not rel.isascii():
        # The URL is the transliterated slug either way; an accented file name only breaks the
        # tools that hash git's quoted paths (the Majordomus gate recorder among them).
        errors.append(f"{rel}: the file name must be ASCII (scripts/track.py names it {slugify(path.stem)}.md)")
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
    own_video = youtube_id  # before a gone video is cleared: extra.versions must still list it
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
            thumbnail, local = card_still(str(cover).lstrip("/")), True
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
    # Reproduced lyrics have a shape prose never has: many short lines in a row (fenced or not).
    # Four reviews carried full lyrics until 2026-11-12; a review quotes a few words at most.
    run = longest = 0
    for line in rendered.splitlines():
        text = line.strip()
        if text.startswith("```"):
            continue
        if text and len(text) < 70 and not text.startswith(("#", "-", "*", "|", ">", "{{", "[//]", "+")):
            run += 1
            longest = max(longest, run)
        elif text:
            run = 0
    if longest >= LYRIC_RUN:
        err(f"{longest} short lines in a row look like reproduced lyrics; describe the lyric, "
            "quote a few words at most")
    for kind, target in CONTENT_LINK.findall(rendered):
        if kind == "track" and not review_exists(target):
            err(f"{{{{ <track_link source=\"{target}\" /> }}}} names no review")
        if kind == "concept" and slugify(target) not in KNOWN_CONCEPTS:
            err(f"{{{{ <concept_link name=\"{target}\" /> }}}} is not defined in {CONCEPTS_DIR.relative_to(ROOT)}/")
        elif kind == "concept" and target not in [str(c) for c in taxonomies.get("concept", [])]:
            err(f"{{{{ <concept_link name=\"{target}\" /> }}}} is linked but not in taxonomies.concept; add it there")
    if UNFINISHED in body or UNFINISHED in description:
        err(f"has an unfinished section ({UNFINISHED}); write it or remove it")
    prose = rendered.lower()
    for phrase in CLICHES:
        if phrase in prose:
            err(f"'{phrase}' would fit any track; say what this one does instead "
                "(x-sonic.cliches in data/track.schema.json)")
    for problem in owner_listening_problems(meta, body):
        err(problem)

    for term in facets.get("concept", []):
        if slugify(term) not in KNOWN_CONCEPTS:
            err(f"concept '{term}' is not defined: add {CONCEPTS_DIR.relative_to(ROOT)}/{slugify(term)}.toml")
    for i, m in enumerate(((extra.get("learning") or {}).get("listen_for")) or []):
        if isinstance(m, dict) and not (m.get("at") or m.get("part")):
            err(f"extra.learning.listen_for[{i}] needs a part of the song or a sourced time (at)")
    for problem in version_problems(extra.get("versions") or [], own_video, body):
        err(problem)
    for c in extra.get("connections", []) or []:
        if isinstance(c, dict) and not review_exists(str(c.get("source", ""))):
            err(f"extra.connections names {c.get('source')}, which is no review")
        if isinstance(c, dict) and c.get("source") == rel:
            err("extra.connections names the review itself")
    # The review is about this recording: its prose names the artist and the song (a review
    # pasted onto the wrong track names someone else's), and it has the length to say something.
    # A skeleton is refused as unfinished above; these apply once it is written.
    written = UNFINISHED not in body
    folded = fold(rendered)
    main = MAIN_ARTIST.split(artist)[0] if artist and written else ""
    if main and fold(main) not in folded:
        err(f"the review never names its artist ({main})")
    named = re.sub(r"\s*[\(\[][^\)\]]*[\)\]]", "", song(track)) if track and written else ""
    if named and fold(named) not in folded:
        err(f"the review never names its track ({named})")
    body_words = len(re.findall(r"\w+", body))
    if written and body_words < WORDS_MIN and not extra.get("edu_exempt"):
        err(f"{body_words} words; a review has at least {WORDS_MIN} (data/review.toml)")
    paragraphs = sorted({re.sub(r"\s+", " ", p.strip().lower()) for p in re.split(r"\n\s*\n", rendered)
                         if len(p.strip()) >= SHARED_PARAGRAPH and not p.strip().startswith(("#", "{{"))})
    kept_extra = {k: extra[k] for k in CATALOG_EXTRA if k in extra}
    return Track(
        source=rel, path=f"{slugify(path.stem)}/", title=title, artist=artist, track=track,
        inferred=rule, date=when, description=description, facets=facets,
        youtube_id=youtube_id, thumbnail=thumbnail, thumbnail_local=local,
        words=body_words, extra=kept_extra, outline=headings(body),
        video_gone=video_gone, full_extra=extra, paragraphs=paragraphs,
        fingerprint=tr.fingerprint(meta, body),
        index=search_text(body),
    )


def version_key(v: dict) -> str:
    """What identifies a version: its video id, or its url when it has none."""
    return str(v.get("youtube") or v.get("url") or "")


def version_problems(versions: list, own: str | None, body: str) -> list[str]:
    """A review's extra.versions: each version reachable and listed once, an own review that
    exists, the page's own video among them, and none repeated as a link in the prose."""
    problems, keys = [], []
    for i, v in enumerate(versions):
        if not isinstance(v, dict):
            continue
        key = version_key(v)
        if not key:
            problems.append(f"extra.versions[{i}] ({v.get('title')}) needs a youtube id or a url")
        elif key in keys:
            problems.append(f"extra.versions[{i}] lists {key} a second time")
        keys.append(key)
        if v.get("date"):
            try:
                date.fromisoformat(str(v["date"]))
            except ValueError:
                problems.append(f"extra.versions[{i}] date {v['date']} is not a calendar date")
        if v.get("review") and not review_exists(str(v["review"])):
            problems.append(f"extra.versions[{i}] names the review {v['review']}, which does not exist")
    if keys and own and own not in keys:
        problems.append(f"extra.versions lists the song's versions but not the page's own video {own}: "
                        "add it (kind official-video, or original for an audio upload)")
    linked = sorted(set(WATCH_LINK.findall(body)) & set(keys))
    if linked:
        problems.append(f"the prose links versions that extra.versions already shows ({', '.join(linked)}): "
                        "drop the links, the page renders the list")
    return problems


def version_reviews(tracks: list[Track]) -> list[str]:
    """A version that is another review's video names that review (extra.versions[].review), so
    the list leads to its page instead of playing it as a stranger."""
    owner = {}
    for t in tracks:
        match = YOUTUBE_ID.search(str(t.full_extra.get("youtube", "")))
        if match:
            owner[match.group(1)] = t.source
    problems = []
    for t in tracks:
        for v in t.full_extra.get("versions") or []:
            other = owner.get(str(v.get("youtube", ""))) if isinstance(v, dict) else None
            if other and other != t.source and v.get("review") != other:
                problems.append(f"{t.source}: extra.versions lists {v['youtube']}, the video of {other}; "
                                f'add review = "{other}" to that version')
    return problems


def seconds(duration: str) -> int:
    """'2:45' or '1:02:45' as seconds."""
    total = 0
    for part in duration.split(":"):
        total = total * 60 + int(part)
    return total


def versions_of(t: Track) -> list[dict]:
    """The catalogue's view of a review's versions, in the author's order: the authored fields,
    the group (the artist's own, by kind or by credit, or others'), where to watch, the length in seconds, and whether
    it is this page's own video or one YouTube no longer serves."""
    out = []
    for v in t.full_extra.get("versions") or []:
        if not isinstance(v, dict):
            continue  # the schema has refused it; the catalogue does not crash on it
        entry = {k: v[k] for k in VERSION_FIELDS if k in v}
        video = v.get("youtube")
        # The artist's own: an official kind, or anything the artist made (a short, a live take).
        mine = v.get("kind") in ARTIST_KINDS or (bool(t.artist) and fold(str(v.get("by", ""))) == fold(t.artist))
        entry["group"] = "artist" if mine else "others"
        entry["watch"] = v.get("url") or f"https://www.youtube.com/watch?v={video}"
        if DURATION.match(str(v.get("duration", ""))):
            entry["seconds"] = seconds(v["duration"])
        if video and video in GONE_VIDEOS:
            entry["gone"] = True
        if video and video == t.youtube_id:
            entry["this_page"] = True
        out.append(entry)
    return out


# --- What the corpus says. -------------------------------------------------------------------

def uniqueness(tracks: list[Track]) -> list[str]:
    """One song, one review (rule yearbook-integrity): no two reviews share an artist and song,
    an ISRC or a video; no paragraph is copied from one review into another."""
    problems = []
    keys = (("artist and song", lambda t: (fold(t.artist), fold(song(t.track))) if t.track else None),
            ("ISRC", lambda t: t.full_extra.get("isrc")),
            ("video", lambda t: t.youtube_id))
    for what, key in keys:
        owners: dict = defaultdict(list)
        for t in tracks:
            if key(t):
                owners[key(t)].append(t.source)
        problems += [f"{', '.join(sorted(v))}: the same {what} in two reviews; one song has one review"
                     for v in owners.values() if len(v) > 1]
    shared: dict[str, list[str]] = defaultdict(list)
    for t in tracks:
        for p in t.paragraphs:
            shared[p].append(t.source)
    problems += [f"{', '.join(sorted(v))}: a paragraph is copied between reviews ('{p[:60]}...')"
                 for p, v in shared.items() if len(v) > 1]
    return sorted(problems)


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
    files = review_files()
    tracks = [t for t in (load_track(p, errors) for p in files) if t]

    seen: dict[str, str] = {}
    for t in tracks:
        if t.path in seen:
            errors.append(f"{t.source}: URL /{t.path} collides with {seen[t.path]}")
        seen[t.path] = t.source

    recorded = load_published()
    sources = [t.source for t in tracks]
    # History is read only for a review the record lacks (a new one, or a record merged away).
    added = git_added() if any(s not in recorded for s in sources) else {}
    published, unrecorded = published_times(sources, recorded, added, int(time.time()))
    publication_order(tracks, published)
    errors += uniqueness(tracks)
    errors += version_reviews(tracks)
    families = genre_families(tracks, load_genre_families(errors), NOTES)
    translated = load_translations(tracks, errors)
    pages_translated = page_translations(errors)
    rel = related(tracks)
    books, member_of = yearbooks(tracks, errors, families)
    # One artist, one home country: the reviews of an artist must agree (Mount Sims was DE in some
    # and US in others on 2026-11-12).
    countries: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    for t in tracks:
        if t.full_extra.get("country"):
            countries[t.artist][t.full_extra["country"]].append(t.source)
    for artist, by_country in sorted(countries.items()):
        if len(by_country) > 1:
            errors.append(f"{artist}: the reviews disagree on the country "
                          + "; ".join(f"{c} in {', '.join(sorted(v))}" for c, v in sorted(by_country.items())))
    # Once the corpus is complete, the contract requires every review to teach (ADR 0004).
    # The parts every review must have are listed in the contract (x-sonic.edu_required_parts);
    # credits and identifiers are measured, since not every recording has a source for them. A
    # review with no source at all says why in extra.edu_exempt instead of passing silently.
    for t in tracks:
        errors += edu_problems(t)
    facet_counts = {f: Counter(term for t in tracks for term in t.facets[f]) for f in FACETS}
    pairs = Counter((g, s) for t in tracks for g in t.facets["genre"] for s in t.facets["sentiment"])
    months = Counter(t.date[:7] for t in tracks)
    artists = Counter(t.artist for t in tracks)
    word_counts = sorted(t.words for t in tracks) or [0]

    def ranked(counter: Counter) -> list[dict]:
        return [{"term": k, "slug": slugify(k), "count": v}
                for k, v in sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))]

    return {
        "_published": published, "_unrecorded": unrecorded,
        "schema": SCHEMA,
        "generated_by": "scripts/catalog.py",
        "contract": "data/track.schema.json",
        "stats": {
            "tracks": len(tracks),
            "artists": len(artists),
            "videos": sum(1 for t in tracks if t.youtube_id),
            "videos_gone": sum(1 for t in tracks if t.video_gone),
            "versions": sum(len(t.full_extra.get("versions") or []) for t in tracks),
            "words": sum(t.words for t in tracks),
            "median_words": word_counts[len(word_counts) // 2],
            "first": min((t.date for t in tracks), default=""),
            "last": max((t.date for t in tracks), default=""),
            **{f"{f}_terms": len(facet_counts[f]) for f in FACETS},
            "genre_families": len(families),
            "yearbooks": len(books),
            "recurring": sum(1 for m in member_of.values() if len(m) > 1),
            "translations": {lang: {"reviews": len(translated[lang]), "pages": len(pages_translated[lang])}
                             for lang in LANGUAGES},
        },
        "languages": [DEFAULT_LANG] + LANGUAGES,
        # The terms each language has a page for: those of its translated reviews. A link to a
        # term the language has no page for yet goes to the default language's (ADR 0006).
        "lang_terms": {lang: {f: sorted({term for t in tracks if t.source in translated[lang] for term in t.facets[f]})
                              for f in FACETS} for lang in LANGUAGES},
        "outline": outline(tracks),
        "facet_names": list(FACETS),
        "concepts": concept_index(tracks),
        "concept_categories": CONCEPT_SCHEMA["properties"]["category"]["enum"],
        "genre_families": families,
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
        "search": {"fold": SEARCH_FOLD, "forms": SEARCH_FORMS},
        "_search": {t.source: t.index for t in tracks},
        "_search_i18n": {lang: {s: x["index"] for s, x in translated[lang].items()} for lang in LANGUAGES},
        "_jsonld": jsonld(tracks, translated),
        "tracks": [
            {
                "source": t.source, "path": t.path, "title": t.title, "artist": t.artist,
                "track": t.track, "inferred": t.inferred, "date": t.date,
                "description": t.description, "facets": t.facets, "youtube": t.youtube_id,
                "thumbnail": t.thumbnail, "thumbnail_local": t.thumbnail_local,
                "words": t.words, "extra": t.extra, "related": rel[t.source],
                "video_gone": t.video_gone, "edu": edu_parts(t),
                "yearbooks": member_of.get(t.source, []),
                "langs": [DEFAULT_LANG] + [lang for lang in LANGUAGES if t.source in translated[lang]],
                "i18n": {lang: {k: translated[lang][t.source][k] for k in ("title", "description", "path")}
                         for lang in LANGUAGES if t.source in translated[lang]},
                **({"versions": versions_of(t)} if t.full_extra.get("versions") else {}),
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
            "exempt": sum(1 for t in tracks if t.full_extra.get("edu_exempt")),
            "complete": sum(1 for t in tracks if all(has(t, p) for p in EDU_PARTS)),
            **{p: sum(1 for t in tracks if has(t, p)) for p in EDU_PARTS}}


def edu_problems(t: Track) -> list[str]:
    """What keeps a review from being the educational article the contract requires (ADR 0004):
    the parts of x-sonic.edu_required_parts it lacks, unless extra.edu_exempt gives the reason."""
    if not TRACK_SCHEMA["x-sonic"].get("edu_required") or t.full_extra.get("edu_exempt"):
        return []
    required = TRACK_SCHEMA["x-sonic"].get("edu_required_parts", list(EDU_PARTS))
    missing = [p for p in required if p not in edu_parts(t)]
    return [f"{t.source}: an educational article needs {', '.join(missing)} (ADR 0004), "
            "or extra.edu_exempt with the reason"] if missing else []


def edu_parts(t: Track) -> list[str]:
    return [p for p in EDU_PARTS
            if (t.facets.get("concept") if p == "concept" else t.full_extra.get(p))]


def jsonld(tracks: list[Track], translated: dict[str, dict[str, dict]] | None = None) -> dict:
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
        out.setdefault(DEFAULT_LANG, {})[t.source] = {"@context": "https://schema.org", "@graph": [recording, article]}
        for lang, by_source in (translated or {}).items():
            if t.source in by_source:
                x = by_source[t.source]
                local = {**article, "@id": f"{base}/{x['path']}#review", "headline": x["title"],
                         "description": x["description"], "url": f"{base}/{x['path']}", "inLanguage": lang,
                         "wordCount": x["words"], "translationOfWork": {"@id": url + "#review"}}
                if t.facets.get("concept"):
                    local["teaches"] = [{**d, "url": f"{base}/{lang}/concept/{slugify(d['name'])}/"} for d in article["teaches"]]
                out.setdefault(lang, {})[t.source] = {"@context": "https://schema.org", "@graph": [recording, local]}
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
    # Every language gets the same pages in its own words (ADR 0006); the words are data
    # (data/i18n/<lang>.toml: yearbook.page_title, yearbook.page_description).
    for lang in LANGUAGES:
        strings = tomllib.loads((ROOT / "data" / "i18n" / f"{lang}.toml").read_text(encoding="utf-8"))
        pages[YEARBOOK_PAGES / f"_index.{lang}.md"] = (
            "+++\n# Derived by scripts/catalog.py from data/backlog/ (kind = \"yearbook\"); do not edit.\n"
            f'title = "{strings["yearbook.page_title"]}"\ntemplate = "yearbooks.html"\nsort_by = "title"\n+++\n')
        for b in books:
            text = strings["yearbook.page_description"].replace("{year}", str(b["year"])).replace(
                "{items}", str(b["items"])).replace("{songs}", str(b["songs"]))
            pages[YEARBOOK_PAGES / f"{b['year']}.{lang}.md"] = (
                "+++\n# Derived by scripts/catalog.py from " + b["file"] + "; do not edit.\n"
                f'title = "{b["year"]}"\ntemplate = "yearbook.html"\n'
                f'description = "{text}"\n\n[extra]\nyear = {b["year"]}\n+++\n')
    return pages


def render(catalog: dict) -> str:
    return json.dumps({k: v for k, v in catalog.items() if not k.startswith("_")},
                      ensure_ascii=False, indent=1) + "\n"


def render_search(catalog: dict, lang: str = "") -> str:
    """The review text index the explorer loads on the first query: per track, the tokens of its
    review in order (search_text; static/data/search.json, sonic-search/v2). In order, not a set
    of distinct words, so that a quoted phrase finds only words side by side."""
    index = catalog["_search_i18n"][lang] if lang else catalog["_search"]
    return json.dumps({"schema": "sonic-search/v2", "generated_by": "scripts/catalog.py",
                       "tracks": index}, ensure_ascii=False, indent=0) + "\n"


def play_track(t: dict) -> dict:
    """One catalogue track projected onto the player's index (PLAY_FIELDS, related sources, paths)."""
    out = {k: t.get(k) for k in PLAY_FIELDS}
    out["related"] = [{"source": r["source"]} for r in t.get("related", [])]
    out["i18n"] = {lang: {"path": v.get("path")} for lang, v in (t.get("i18n") or {}).items()}
    # The versions the player can queue after the page's own video: playable, not gone.
    playable = [{"youtube": v["youtube"], "track": v.get("title", ""), "artist": v.get("by", "")}
                for v in t.get("versions") or [] if v.get("youtube") and not v.get("gone") and not v.get("this_page")]
    if playable:
        out["versions"] = playable
    return out


def render_play(catalog: dict) -> str:
    """static/data/play.json (sonic-play/v1): every track as play_track projects it."""
    return json.dumps({"schema": "sonic-play/v1", "generated_by": "scripts/catalog.py",
                       "tracks": [play_track(t) for t in catalog["tracks"]]},
                      ensure_ascii=False, separators=(",", ":")) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--check", action="store_true",
                        help="fail on a contract violation or a stale catalogue; write nothing")
    args = parser.parse_args()

    errors: list[str] = []
    catalog = build(errors)
    pages = yearbook_pages(catalog)
    leftovers = [p for p in YEARBOOK_PAGES.glob("*.md") if p not in pages] if YEARBOOK_PAGES.exists() else []
    outputs = {**pages, OUTPUT: render(catalog), PLAY: render_play(catalog), SEARCH: render_search(catalog),
               **{SEARCH.with_name(f"search.{lang}.json"): render_search(catalog, lang) for lang in LANGUAGES},
               JSONLD: json.dumps(catalog["_jsonld"], ensure_ascii=False, indent=1, sort_keys=True) + "\n",
               PUBLISHED: render_published(catalog["_published"])}
    count = catalog["stats"]["tracks"]
    for e in errors:
        print(f"catalog: {e}", file=sys.stderr)
    for n in NOTES:
        print(f"catalog: note: {n}", file=sys.stderr)
    if errors:
        print(f"catalog: {len(errors)} contract violation(s)", file=sys.stderr)
        return 1
    if args.check:
        for s in catalog["_unrecorded"]:
            print(f"catalog: {s} has no time in data/published.json; run npm run derive", file=sys.stderr)
        stale = [p for p, text in outputs.items()
                 if not p.exists() or p.read_text(encoding="utf-8") != text]
        for p in stale:
            print(f"catalog: {p.relative_to(ROOT)} is stale; run npm run derive", file=sys.stderr)
        for p in leftovers:
            print(f"catalog: {p.relative_to(ROOT)} belongs to no yearbook; run npm run derive", file=sys.stderr)
        if stale or leftovers or catalog["_unrecorded"]:
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
