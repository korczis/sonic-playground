#!/usr/bin/env python3
"""YouTube's public pages as data: a search's results and a video's details, never its streams.

The transport reads two kinds of page and nothing else: a search (https://www.youtube.com/results)
and a watch page (https://www.youtube.com/watch). It parses the JSON YouTube embeds in them
(`var ytInitialData = {...};`, `var ytInitialPlayerResponse = {...};`) and keeps only what a
review's list of versions needs: ids, titles, channels, lengths, dates, the description. The
player response's stream addresses (streamingData), ads, captions and storyboards are deleted
before anything is returned or cached, and no URL other than those two pages is ever fetched:
this tool never downloads, plays or analyses audio or video (rule in
.ai/repo/skills/add-song/SKILL.md).

    yt = YouTube()                       the network, through the cache
    yt = YouTube(refresh=True)           the network, the cache only written (a re-check)
    yt = YouTube(fixture="<dir>")        answers from <dir>/index.json ({"<url>": "<file>"}),
                                         small saved pages: what the tests use, no network
    yt.search("Artist Track")            [{id, title, channel, channel_id, duration, published,
                                           views, snippet, format, badges}]
    yt.watch("<11-char id>")             {id, title, author, channel_id, seconds, duration,
                                          description, views, publish_date, upload_date,
                                          category, playable, reason, facts}

Requests carry YouTube's consent cookie (`CONSENT=YES+1; SOCS=CAI`, so no consent wall answers
instead of the page) and `Accept-Language: en`, run at least INTERVAL seconds apart and back off
and retry on 429 and 5xx. The cache (~/.cache/sonic-playground/youtube.json, outside the
repository) holds each page's parsed data with the time it was fetched.
"""
from __future__ import annotations

import http.client
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import zoneinfo
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PAGES = ("https://www.youtube.com/results?", "https://www.youtube.com/watch?")
HEADERS = {
    "Cookie": "CONSENT=YES+1; SOCS=CAI",
    "Accept-Language": "en",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/124.0 Safari/537.36",
}
CACHE = (Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "sonic-playground"
         / "youtube.json")
INTERVAL = 1.0  # seconds between two requests, at least
ATTEMPTS = 4
# What a player response carries that is not a fact about the video: never kept, never cached.
DROPPED = ("streamingData", "playerAds", "adPlacements", "adSlots", "captions", "storyboards",
           "heartbeatParams", "playbackTracking", "playerConfig", "annotations", "attestation",
           "endscreen", "cards", "frameworkUpdates")
DIY_DISTRIBUTORS = ("DistroKid", "TuneCore", "CD Baby", "Amuse", "RouteNote", "Ditto",
                    "UnitedMasters")
CREDIT = re.compile(r"^([A-Z][A-Za-z ,&/-]{1,80}):\s+(\S.*)$")
VIEWS = re.compile(r"([\d.,]+)\s*([KMB])?", re.I)


class YouTubeError(RuntimeError):
    """A page YouTube did not answer with (an HTTP error, a consent wall, no fixture entry)."""


def search_url(query: str) -> str:
    return PAGES[0] + urllib.parse.urlencode({"search_query": query})


def watch_url(video: str) -> str:
    return PAGES[1] + urllib.parse.urlencode({"v": video})


def embedded(html: str, name: str) -> dict | None:
    """The JSON object a page assigns to `var <name> =` (or `window["<name>"] =`), or None."""
    m = re.search(r'(?:var\s+' + name + r'|window\["' + name + r'"\])\s*=\s*(?=\{)', html)
    if not m:
        return None
    try:
        value, _ = json.JSONDecoder().raw_decode(html, m.end())
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def walk(node, key: str):
    """Every value stored under key anywhere in a JSON tree, in document order."""
    if isinstance(node, dict):
        for k, v in node.items():
            if k == key:
                yield v
            yield from walk(v, key)
    elif isinstance(node, list):
        for v in node:
            yield from walk(v, key)


def text(node) -> str:
    """The text of a YouTube text object ({simpleText} or {runs: [{text}]}, or {content})."""
    if not isinstance(node, dict):
        return ""
    if "simpleText" in node:
        return str(node["simpleText"])
    if "content" in node:
        return str(node["content"])
    return "".join(str(r.get("text", "")) for r in node.get("runs") or [])


def views(label: str) -> int | None:
    """'192,500 views', '3.7K views', '1.2M views' as a number; 'No views' is 0."""
    if label.lower().startswith("no views"):
        return 0
    m = VIEWS.search(label)
    if not m:
        return None
    number = float(m.group(1).replace(",", ""))
    scale = {"k": 1e3, "m": 1e6, "b": 1e9}.get((m.group(2) or "").lower(), 1)
    return int(round(number * scale))


def mmss(seconds: int) -> str:
    hours, rest = divmod(seconds, 3600)
    return (f"{hours}:{rest // 60:02d}:{rest % 60:02d}" if hours
            else f"{rest // 60}:{rest % 60:02d}")


def result_items(data: dict) -> list[dict]:
    """The items of a search page's result sections. A page without the sections is not a
    search result YouTube still lays out as this parser knows: an error, never "no results"."""
    sections = list(walk(data, "itemSectionRenderer"))
    if not sections:
        raise YouTubeError("the search page has no result sections (itemSectionRenderer): "
                           "YouTube changed its layout?")
    return [i for sec in sections if isinstance(sec, dict)
            for i in sec.get("contents") or [] if isinstance(i, dict)]


def parse_search(html: str) -> list[dict]:
    """The videos and shorts of a search page, in the page's order, each id once. An honest
    "No results" page is []; a page whose items are none of the renderers read here
    (videoRenderer, a shelf of shortsLockupViewModel) is an error, so a change of YouTube's
    layout never reads as a song without versions."""
    data = embedded(html, "ytInitialData")
    if data is None:
        raise YouTubeError("no ytInitialData in the search page" + (
            " (a consent wall)" if "consent.youtube.com" in html else ""))
    items = result_items(data)
    if any("backgroundPromoRenderer" in i for i in items):
        return []  # YouTube's own "No results found"
    known = [i for i in items
             if "videoRenderer" in i or next(walk(i, "shortsLockupViewModel"), None) is not None]
    if not known:
        kinds = sorted({k for i in items for k in i})
        raise YouTubeError("none of the search page's items is a known renderer ("
                           + (", ".join(kinds) or "no items") + "): YouTube changed its layout?")
    found: dict[str, dict] = {}
    for vr in walk(data, "videoRenderer"):
        video = vr.get("videoId")
        if not isinstance(video, str) or video in found:
            continue
        owner = (vr.get("ownerText") or vr.get("longBylineText") or {}).get("runs") or [{}]
        browse = (owner[0].get("navigationEndpoint") or {}).get("browseEndpoint") or {}
        snippets = [text(s.get("snippetText")) for s in vr.get("detailedMetadataSnippets") or []]
        badges = [b["metadataBadgeRenderer"].get("tooltip") or b["metadataBadgeRenderer"].get("label")
                  for b in (vr.get("ownerBadges") or []) + (vr.get("badges") or [])
                  if isinstance(b, dict) and "metadataBadgeRenderer" in b]
        found[video] = {
            "id": video, "title": text(vr.get("title")).strip(),
            "channel": text({"runs": owner}).strip(), "channel_id": browse.get("browseId", ""),
            "duration": text(vr.get("lengthText")), "published": text(vr.get("publishedTimeText")),
            "views": views(text(vr.get("viewCountText"))), "snippet": " ".join(snippets).strip(),
            "format": "video", "badges": [b for b in badges if b],
        }
    for sv in walk(data, "shortsLockupViewModel"):
        reel = ((sv.get("onTap") or {}).get("innertubeCommand") or {}).get("reelWatchEndpoint")
        video = (reel or {}).get("videoId") or str(sv.get("entityId", "")).rsplit("-item-", 1)[-1]
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video) or video in found:
            continue
        overlay = sv.get("overlayMetadata") or {}
        found[video] = {
            "id": video, "title": text(overlay.get("primaryText")).strip(), "channel": "",
            "channel_id": "", "duration": "", "published": "",
            "views": views(text(overlay.get("secondaryText"))), "snippet": "", "format": "short",
            "badges": [],
        }
    return list(found.values())


def description_facts(description: str) -> dict:
    """What a description states about a release: who provided it to YouTube (an auto-generated
    Topic upload), its '<title> · <artist>' line, the ℗ line, 'Released on: YYYY-MM-DD', and
    the credit lines ('Producer, Composer: Name')."""
    lines = [line.strip() for line in description.splitlines()]
    facts: dict = {}
    m = re.search(r"^Provided to YouTube by (.+?)\s*$", description, re.M)
    if m:
        facts["provider"] = m.group(1)
        facts["diy"] = any(m.group(1).lower().startswith(d.lower()) for d in DIY_DISTRIBUTORS)
        dotted = next((line for line in lines if " · " in line), "")
        if dotted:
            title, *artists = [p.strip() for p in dotted.split(" · ")]
            facts["release_title"], facts["artists"] = title, artists
    rights = next((line for line in lines if line.startswith("℗")), "")
    if rights:
        facts["rights"] = rights
    m = re.search(r"^Released on:\s*(\d{4}-\d{2}-\d{2})\s*$", description, re.M)
    if m:
        facts["released"] = m.group(1)
    credits = []
    if "provider" in facts:  # credit lines are a Topic upload's convention; prose has colons too
        for line in lines:
            c = CREDIT.match(line)
            if c and not line.startswith(("Released on", "Provided to", "Auto-generated")):
                credits.append({"roles": [r.strip() for r in c.group(1).split(",")],
                                "name": c.group(2).strip()})
    if credits:
        facts["credits"] = credits
    return facts


def parse_watch(html: str, video: str) -> dict:
    """A watch page's facts about its video; the stream addresses and everything else the
    player needs are deleted first (DROPPED) and never reach the caller or the cache."""
    player = embedded(html, "ytInitialPlayerResponse")
    if player is None:
        raise YouTubeError(f"no ytInitialPlayerResponse in the watch page of {video}" + (
            " (a consent wall)" if "consent.youtube.com" in html else ""))
    for key in DROPPED:
        player.pop(key, None)
    status = player.get("playabilityStatus") or {}
    details = player.get("videoDetails") or {}
    micro = (player.get("microformat") or {}).get("playerMicroformatRenderer") or {}
    length = str(details.get("lengthSeconds") or "")
    seconds = int(length) if length.isdigit() else None
    description = str(details.get("shortDescription") or "")
    count = str(details.get("viewCount") or "")
    return {
        "id": details.get("videoId") or video, "title": str(details.get("title") or "").strip(),
        "author": str(details.get("author") or micro.get("ownerChannelName") or "").strip(),
        "channel_id": details.get("channelId") or micro.get("externalChannelId") or "",
        "seconds": seconds, "duration": mmss(seconds) if seconds is not None else "",
        "description": description, "views": int(count) if count.isdigit() else None,
        "publish_date": micro.get("publishDate", ""), "upload_date": micro.get("uploadDate", ""),
        "category": micro.get("category", ""), "short": bool(micro.get("isShortsEligible")),
        "playable": status.get("status", "OK") == "OK", "reason": status.get("reason", ""),
        "facts": description_facts(description),
    }


def country_zone(country: str) -> zoneinfo.ZoneInfo | timezone:
    """The time zone of a country (ISO 3166 code) as the system's tz database lists it first
    (zone.tab: DE is Europe/Berlin); UTC when there is no such country or no table."""
    if country:
        for base in zoneinfo.TZPATH:
            try:
                rows = (Path(base) / "zone.tab").read_text(encoding="utf-8").splitlines()
            except OSError:
                continue
            for row in rows:
                cols = row.split("\t")
                if len(cols) >= 3 and cols[0] == country:
                    return zoneinfo.ZoneInfo(cols[2])
    return timezone.utc


def local_date(stamp: str, country: str = "") -> str:
    """The calendar date of a YouTube timestamp ('2026-11-11T15:00:08-08:00') where the artist
    is: midnight in Germany is still the afternoon before in California, where YouTube dates."""
    try:
        moment = datetime.fromisoformat(stamp)
    except ValueError:
        return ""
    if moment.tzinfo is None:
        return moment.date().isoformat()
    return moment.astimezone(country_zone(country)).date().isoformat()


_last = [0.0]


def get(url: str) -> str:
    """GET one search or watch page: INTERVAL after the previous request, retried with backoff
    on 429, 5xx and network errors. Any other URL is refused: never a stream, never media."""
    if not url.startswith(PAGES):
        raise ValueError(f"only YouTube search and watch pages are read, not {url}")
    last: Exception | None = None
    for attempt in range(ATTEMPTS):
        wait = INTERVAL - (time.monotonic() - _last[0])
        if wait > 0:
            time.sleep(wait)
        request = urllib.request.Request(url, headers=HEADERS)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = response.read().decode("utf-8", "replace")
            _last[0] = time.monotonic()
            return body
        except urllib.error.HTTPError as exc:
            _last[0] = time.monotonic()
            if exc.code != 429 and exc.code < 500:
                raise YouTubeError(f"HTTP {exc.code} for {url}") from exc
            last = exc
        except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException) as exc:
            # A dropped connection (RemoteDisconnected, ConnectionResetError) or a truncated
            # body (IncompleteRead) is as passing as a timeout: retried like one.
            _last[0] = time.monotonic()
            last = exc
        if attempt < ATTEMPTS - 1:
            time.sleep(min(2 ** attempt * 2, 30))
    raise YouTubeError(f"no answer after {ATTEMPTS} attempts for {url}: {last}")


def read_cache(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


class YouTube:
    """Search and watch through the cache (or a fixture directory, for the tests)."""

    def __init__(self, fixture: str | Path | None = None, refresh: bool = False,
                 cache: Path | None = None):
        self.fixture = Path(fixture) if fixture else None
        self.refresh = refresh
        self.cache_file = cache or CACHE
        self.fetched: list[str] = []  # every URL this instance read from the network or fixture
        self._cache: dict | None = None
        self.seen: dict[str, Any] = {}  # what this instance has read, by URL

    def page(self, url: str) -> str:
        self.fetched.append(url)
        if self.fixture:
            index = json.loads((self.fixture / "index.json").read_text(encoding="utf-8"))
            if url not in index:
                raise YouTubeError(f"not in the fixture: {url}")
            return (self.fixture / index[url]).read_text(encoding="utf-8")
        return get(url)

    def cache(self) -> dict:
        """The cache file's entries ({url: {at, data}}); none in fixture mode, and a missing or
        unreadable file is an empty cache, never an error."""
        if self._cache is None:
            self._cache = {} if self.fixture else read_cache(self.cache_file)
        return self._cache

    def store(self, url: str, data) -> None:
        """Remember a page's data; outside fixture mode merge it into the cache file as it is
        now (another process may have written since) and replace the file atomically."""
        entry = {"at": int(time.time()), "data": data}
        self.cache()[url] = entry
        if self.fixture:
            return  # the tests' answers never reach the real cache
        merged = {**read_cache(self.cache_file), url: entry}
        self.cache_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.cache_file.with_name(f"{self.cache_file.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(merged, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self.cache_file)

    def fetched_at(self, url: str) -> int | None:
        hit = self.cache().get(url)
        return hit.get("at") if isinstance(hit, dict) else None

    def cached(self, url: str, parse, keep=lambda data: True):
        """A page's data: read once per instance; from the cache unless refresh or a fixture.
        Data keep() refuses (an empty search) is neither remembered nor cached, and a cached
        copy of it is read again: an empty answer may be YouTube's passing failure."""
        if url in self.seen:
            return self.seen[url]
        hit = None if self.refresh or self.fixture else self.cache().get(url)
        if isinstance(hit, dict) and "data" in hit and keep(hit["data"]):
            data = hit["data"]
        else:
            data = parse(self.page(url))
            if not keep(data):
                return data
            self.store(url, data)
        self.seen[url] = data
        return data

    def search(self, query: str) -> list[dict]:
        return self.cached(search_url(query), parse_search, keep=bool)

    def watch(self, video: str) -> dict:
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video):
            raise ValueError(f"not a YouTube video id: {video}")
        return self.cached(watch_url(video), lambda html: parse_watch(html, video))
