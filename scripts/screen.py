#!/usr/bin/env python3
"""The researchability screen: how much independent source material a backlog song has.

A review claims only what a cited source supports (skill add-song), so a song nobody has written
about costs a writer the search before it costs the prose. The screen asks free public catalogues
first, deterministically and without a model, and hands every row its evidence:

  - MusicBrainz (the engine's client, scripts/track.py mb_get: its cache, its 1 request a second):
    a recording with the main artist, the song and the row's version (a remix keeps its remixer),
    its length within LENGTH_TOLERANCE of the row's; how many releases hold it and whether one is
    not a compilation; the url relations of the artist and of the release groups (Wikidata,
    Wikipedia, reviews, AllMusic, Discogs, the artist's own pages);
  - Wikidata: the items of that artist and those release groups (MusicBrainz ids P434, P436),
    and the Wikipedia articles they have in every language;
  - Wikipedia: a search for the song (and its album) in English and, when the artist's country
    names one, in the artist's language, kept only when the title is the song's and the artist is
    named.
Discogs needs credentials for search, so it is not queried; its pages found through MusicBrainz
are recorded as catalogue rows.

Each finding is a reason code with a weight (WEIGHTS); the score is their sum and orders rows
within a tier. The tier orders the backlog, it never removes a song (a song with thin sources is
still written, saying what no source describes):

  writable   a song or release article exists, or at least WRITABLE_MIN_SOURCES independent
             substantive sources (articles, reviews, AllMusic release pages); a remix or other
             version needs the sources, since an article about the original is context only;
  ambiguous  artist-level coverage only, a single substantive source, the identity unclear (the
             song is in MusicBrainz but not at the row's length, or no recording and several
             artists of that name), or the screen failed;
  thin       catalogue rows only, or nothing at all.

    python3 scripts/backlog.py --source spotify --screen [--limit N] [--json]
    python3 scripts/screen.py "Artist - Song" --duration 3:30 [--album A] [--json]

Responses are cached under ~/.cache/sonic-playground (never in the repository).
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
import catalog as cat  # noqa: E402
import track  # noqa: E402  (the MusicBrainz client: cache, rate limit, User-Agent)

fold = cat.fold
Fetch = Callable[[str], dict]

# --- Named thresholds (documented in the module docstring and the skill add-song). -----------
LENGTH_TOLERANCE = 5         # seconds between the row's length and the recording's
MB_MIN_SCORE = 85            # MusicBrainz search score below which a hit is not considered
MAX_RELEASE_GROUPS = 2       # release groups whose url relations and Wikidata items are read
MANY_RELEASES = 5            # releases holding the recording that count as a widely issued song
ARTIST_WIDE_WIKIS = 10       # Wikipedia editions with an artist article that count as wide
WRITABLE_MIN_SOURCES = 2     # independent substantive sources that make a song writable
QUALIFIER_MATCH = 0.5        # share of a version's distinctive words a recording must carry
RETRY_PAUSE = 20             # seconds before a row whose source failed is screened once more

# A reason code's weight in the score; the codes are the evidence's vocabulary.
WEIGHTS = {
    "song-article": 6,        # a Wikipedia article on the song (or its single)
    "release-article": 4,     # a Wikipedia article on an album or EP holding it (not a compilation)
    "review": 2,              # a review linked from the release group in MusicBrainz, per site
    "allmusic-release": 1,    # an AllMusic release page (often a review)
    "artist-article": 2,      # a Wikipedia article on the main artist
    "artist-wide": 1,         # ... in at least ARTIST_WIDE_WIKIS languages
    "mb-confirmed": 1,        # MusicBrainz has the recording at the row's length
    "own-release": 1,         # ... on a release that is not a compilation
    "many-releases": 1,       # ... on at least MANY_RELEASES releases
    "compilation-only": -1,   # ... only on compilations and DJ mixes
    "mb-length-off": 0,       # the song is in MusicBrainz, but no recording at the row's length
    "mb-none": -1,            # no recording in MusicBrainz
    "artist-namesakes": 0,    # ... and several MusicBrainz artists carry the artist's name
    "catalogue": 0,           # catalogue rows only (Discogs, databases, the artist's own pages)
    "version": 0,             # a remix or version: articles on the original are context
    "compilation-article": 0,  # an article on a compilation that carries it
    "screen-error": 0,        # a source failed; screen again later
}
TIERS = ("writable", "ambiguous", "thin")

# Words that name a kind of version rather than whose version it is.
VERSION_WORDS = frozenset(
    "remix rmx mix mixed edit version radio original extended club remaster remastered vs versus "
    "by for the and a of feat ft with video single album rework re".split())
COMPILATION_TYPES = frozenset({"compilation", "dj-mix", "mixtape/street"})
ALBUM_NOISE = re.compile(r"\s*[\(\[][^)\]]*\b(deluxe|edition|version|remaster(ed)?|expanded|bonus|"
                         r"anniversary|special)\b[^)\]]*[\)\]]", re.I)
RELEASE_WORDS = frozenset({"album", "ep", "mixtape", "soundtrack"})
# The Wikipedia an artist's country writes in, when it is not English.
LANG_BY_COUNTRY = {"CZ": "cs", "SK": "sk", "DE": "de", "AT": "de", "CH": "de", "FR": "fr",
                   "BE": "fr", "PL": "pl", "SE": "sv", "NO": "no", "DK": "da", "NL": "nl",
                   "ES": "es", "IT": "it", "PT": "pt", "BR": "pt", "HU": "hu", "FI": "fi",
                   "IS": "is", "RU": "ru", "UA": "uk"}
# MusicBrainz url relation types by what they are to a writer; any other type (streaming,
# purchase, social networks, images, the artist's blog) is not evidence and is not kept.
SUBSTANTIVE_RELS = {"review": "review", "allmusic": "allmusic"}
CATALOGUE_RELS = frozenset({"discogs", "other databases", "secondhandsongs", "rateyourmusic",
                            "official homepage", "bandcamp", "BBC Music page", "lyrics", "VIAF",
                            "IMDb", "last.fm", "songkick", "soundcloud"})


# --- Transport: MusicBrainz through the engine, Wikimedia with its own cache. ---------------

WM_AGENT = "sonic-playground-screen/1.0 (research screen; python-urllib)"
WM_CACHE = track.MB_CACHE.with_name("wikimedia.json")
WM_INTERVAL = 0.25
_wm = {"last": 0.0, "stamp": None, "data": {}}


def wm_cache() -> dict:
    try:
        st = WM_CACHE.stat()
        stamp = (st.st_mtime_ns, st.st_size)
        if _wm["stamp"] != stamp:
            _wm["data"], _wm["stamp"] = json.loads(WM_CACHE.read_text(encoding="utf-8")), stamp
        return _wm["data"]
    except (OSError, ValueError):
        return {}


def wm_get(url: str) -> dict:
    """GET a Wikidata or Wikipedia API document: the cache, or the API one request at a time,
    WM_INTERVAL apart, backing off on 429/503."""
    cache = wm_cache()
    if url in cache:
        return cache[url]
    wait = WM_INTERVAL - (time.monotonic() - _wm["last"])
    if wait > 0:
        time.sleep(wait)
    request = urllib.request.Request(url, headers={"User-Agent": WM_AGENT, "Accept": "application/json"})
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
            raise
    _wm["last"] = time.monotonic()
    if "error" in data:
        raise urllib.error.URLError(f"wikimedia: {data['error']}")
    WM_CACHE.parent.mkdir(parents=True, exist_ok=True)
    merged = {**wm_cache(), url: data}
    tmp = WM_CACHE.with_name(f"{WM_CACHE.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(merged, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, WM_CACHE)
    _wm["data"] = merged
    st = WM_CACHE.stat()
    _wm["stamp"] = (st.st_mtime_ns, st.st_size)
    return data


def fetch(url: str) -> dict:
    return track.mb_get(url, None) if url.startswith(track.MB) else wm_get(url)


# --- URLs (the tests build their fixtures from the same functions). --------------------------

def mb_search_url(base: str, artist: str) -> str:
    q = f"recording:{track.mb_quote(base)} AND artist:{track.mb_quote(artist)}"
    return track.MB + "recording?" + urllib.parse.urlencode({"query": q, "fmt": "json", "limit": 25})


def mb_artist_search_url(artist: str) -> str:
    q = f"artist:{track.mb_quote(artist)}"
    return track.MB + "artist?" + urllib.parse.urlencode({"query": q, "fmt": "json", "limit": 5})


def mb_entity_url(kind: str, mbid: str) -> str:
    return track.MB + f"{kind}/{mbid}?inc=url-rels&fmt=json"


def wd_search_url(prop: str, mbid: str) -> str:
    return "https://www.wikidata.org/w/api.php?" + urllib.parse.urlencode(
        {"action": "query", "list": "search", "format": "json", "srlimit": 5,
         "srsearch": f"haswbstatement:{prop}={mbid}"})


def wd_sitelinks_url(qids: list[str]) -> str:
    return "https://www.wikidata.org/w/api.php?" + urllib.parse.urlencode(
        {"action": "wbgetentities", "format": "json", "props": "sitelinks", "ids": "|".join(qids)})


def wp_page_url(lang: str, title: str) -> str:
    return f"https://{lang}.wikipedia.org/w/api.php?" + urllib.parse.urlencode(
        {"action": "query", "format": "json", "prop": "pageprops", "ppprop": "disambiguation",
         "titles": title})


def disambiguation(found: dict) -> bool:
    return any("disambiguation" in page.get("pageprops", {})
               for page in found.get("query", {}).get("pages", {}).values())


def wp_search_url(lang: str, name: str, artist: str) -> str:
    return f"https://{lang}.wikipedia.org/w/api.php?" + urllib.parse.urlencode(
        {"action": "query", "list": "search", "format": "json", "srlimit": 5, "srprop": "snippet",
         "srsearch": f'"{name}" {artist}'})


# --- Parsing. ---------------------------------------------------------------------------------

def split_title(title: str) -> tuple[str, str]:
    """A recording title as (song, version): "Go All Night - Booka Shade Remix" is ("Go All
    Night", "Booka Shade Remix"); featured artists and plain version suffixes are dropped first."""
    plain = cat.song(title)
    m = re.match(r"^(.+?)(?:\s+-\s+|\s*[\(\[])(.*)$", plain)
    if not m or not m.group(1).strip():
        return plain.strip(), ""
    return m.group(1).strip(), m.group(2).strip(" )]-")


def distinctive(version: str) -> list[str]:
    """The words of a version that say whose version it is (a remixer, "unplugged", "dub")."""
    return [w for w in cat.words(version) if w not in VERSION_WORDS and not w.isdigit() and len(w) > 1]


def length_of(r: dict) -> int | None:
    return (r.get("length") or 0) // 1000 or None


def credits(r: dict) -> str:
    return " ".join(c.get("name", "") + " " + c.get("artist", {}).get("name", "")
                    for c in r.get("artist-credit", []))


def candidates(found: dict, base: str, artist: str, version: str) -> list[dict]:
    """The recordings of a search that are the row's song by its artist, in the row's version."""
    want = distinctive(version)
    out = []
    for r in found.get("recordings", []):
        if int(r.get("score", 0)) < MB_MIN_SCORE:
            continue
        mb_base, mb_version = split_title(r.get("title", ""))
        if fold(mb_base) != fold(base) or fold(artist) not in fold(credits(r)):
            continue
        hay = fold(" ".join([r.get("title", ""), r.get("disambiguation", ""), credits(r)]))
        if want:
            if sum(w in hay for w in want) < QUALIFIER_MATCH * len(want):
                continue
        elif distinctive(mb_version):
            continue  # the row is the original, this recording is someone's version
        out.append(r)
    return out


def rg_of(release: dict) -> dict:
    return release.get("release-group") or {}


def is_compilation(rg: dict) -> bool:
    return bool({t.lower() for t in rg.get("secondary-types", []) or []} & COMPILATION_TYPES)


def url_rels(entity: dict) -> list[tuple[str, str]]:
    return [(r.get("type", ""), r.get("url", {}).get("resource", ""))
            for r in entity.get("relations", []) if r.get("url", {}).get("resource")]


def qid(url: str) -> str:
    m = re.search(r"wikidata\.org/wiki/(Q\d+)", url)
    return m.group(1) if m else ""


def wikipedias(sitelinks: dict) -> dict[str, str]:
    """Language code to article URL, Wikipedias only (not Commons, Wikiquote, ...)."""
    out = {}
    for site, link in sorted(sitelinks.items()):
        if re.fullmatch(r"[a-z]{2,3}(?:_[a-z]+)*wiki", site):
            lang = site[:-4].replace("_", "-")
            title = (link.get("title", "") if isinstance(link, dict) else str(link)).replace(" ", "_")
            out[lang] = f"https://{lang}.wikipedia.org/wiki/{urllib.parse.quote(title)}"
    return out


def article_hit(title: str, snippet: str, name: str, artist: str, default: str) -> str | None:
    """The level ("song" or "release") of a Wikipedia search hit, or None when the hit is not
    about this name by this artist: the title must be the name, with any disambiguation naming
    the artist or a kind (song, single, album, EP), and the artist must be named."""
    m = re.match(r"^(.*?)\s*\(([^)]*)\)\s*$", title)
    head, paren = (m.group(1), m.group(2)) if m else (title, "")
    if fold(head) != fold(name):
        return None
    text = fold(re.sub(r"<[^>]+>", "", html.unescape(snippet)))
    kinds = set(cat.words(paren))
    in_paren = fold(artist) in fold(paren)
    if not (in_paren or fold(artist) in text):
        return None
    if paren and not in_paren and not kinds <= RELEASE_WORDS | {"song", "single"}:
        return None  # "Mother (Pink Floyd song)" is another artist's song
    if kinds & RELEASE_WORDS:
        return "release"
    if kinds & {"song", "single"}:
        return "song"
    return default


def article_name(url: str) -> str:
    """The folded subject of a Wikipedia article URL: "Tasty_(Kelis_album)" is "tasty"."""
    title = urllib.parse.unquote(url.rsplit("/", 1)[-1]).replace("_", " ")
    return fold(re.sub(r"\s*\([^)]*\)\s*$", "", title))


# --- The screen. ------------------------------------------------------------------------------

def assess(ev: dict) -> tuple[str, int, list[str]]:
    """Tier, score and reason codes from the evidence of one row."""
    reasons: list[str] = []
    identity = ev.get("identity", "unknown")
    mb = ev.get("musicbrainz", {})
    version = bool(ev.get("version"))
    if ev.get("error"):
        reasons.append("screen-error")
    reasons.append({"confirmed": "mb-confirmed", "unclear": "mb-length-off"}.get(identity, "mb-none"))
    if mb.get("artist_candidates", 0) > 1:
        reasons.append("artist-namesakes")
    if mb.get("own_releases"):
        reasons.append("own-release")
    elif mb.get("releases"):
        reasons.append("compilation-only")
    if mb.get("releases", 0) >= MANY_RELEASES:
        reasons.append("many-releases")
    if version:
        reasons.append("version")
    substantive: set[str] = set()
    song_level = release_level = False
    for a in ev.get("articles", []):
        if a["level"] == "song":
            if "song-article" not in reasons:
                reasons.append("song-article")
            substantive.add("song")
            song_level = True
        elif a["level"] == "release":
            if "release-article" not in reasons:
                reasons.append("release-article")
            substantive.add("release:" + article_name(a["url"]))  # one album, any language
            release_level = True
        elif a["level"] == "compilation" and "compilation-article" not in reasons:
            reasons.append("compilation-article")
    for link in ev.get("links", []):
        if link["kind"] == "review":
            host = urllib.parse.urlparse(link["url"]).netloc
            if "review:" + host not in substantive:
                substantive.add("review:" + host)
                reasons.append("review")
        elif link["kind"] == "allmusic" and link["level"] == "release":
            if "allmusic" not in substantive:
                substantive.add("allmusic")
                reasons.append("allmusic-release")
    artist_wikis = ev.get("artist_wikis", 0)
    if artist_wikis:
        reasons.append("artist-article")
    if artist_wikis >= ARTIST_WIDE_WIKIS:
        reasons.append("artist-wide")
    if not substantive and not artist_wikis and any(link["kind"] == "catalogue" for link in ev.get("links", [])):
        reasons.append("catalogue")
    score = sum(WEIGHTS[r] for r in reasons)
    if ((song_level or release_level) and not version) or len(substantive) >= WRITABLE_MIN_SOURCES:
        tier = "writable"
    elif (artist_wikis or substantive or identity == "unclear" or ev.get("error")
          or {"compilation-article", "artist-namesakes"} & set(reasons)):
        tier = "ambiguous"
    else:
        tier = "thin"
    return tier, score, reasons


def gather(row: dict, get: Fetch) -> dict:
    """The evidence for one backlog row (backlog.pending's shape: title, artist, album,
    duration). Every URL found is kept with its level and kind."""
    artist = row["artist"].split(", ", 1)[0].strip()  # backlog joins the credited artists with ", "
    base, version_text = split_title(row["title"])
    want = track.seconds(row.get("duration"))
    ev: dict = {"identity": "unknown", "version": " ".join(distinctive(version_text)),
                "musicbrainz": {}, "articles": [], "links": [], "artist_wikis": 0}
    found = candidates(get(mb_search_url(base, artist)), base, artist, version_text)
    timed = [r for r in found if want and abs((length_of(r) or -10**6) - want) <= LENGTH_TOLERANCE]
    chosen = timed or found
    artist_id = ""
    rgs: list[dict] = []
    if chosen:
        ev["identity"] = "confirmed" if timed else "unclear"
        best = min(chosen, key=lambda r: abs((length_of(r) or 10**6) - (want or 0)))
        artist_id = next((c["artist"]["id"] for c in best.get("artist-credit", [])
                          if fold(artist) in fold(c.get("name", "") + c.get("artist", {}).get("name", ""))),
                         "")
        releases = {x["id"]: x for r in chosen for x in r.get("releases", [])}
        own = [x for x in releases.values() if not is_compilation(rg_of(x))]
        by_rg: dict[str, dict] = {}
        for x in sorted(own, key=lambda x: x.get("date") or "9999"):
            by_rg.setdefault(rg_of(x).get("id", ""), rg_of(x))
        by_rg.pop("", None)
        singles = [g for g in by_rg.values() if (g.get("primary-type") or "") in ("Single", "EP")
                   and fold(split_title(g.get("title", ""))[0]) == fold(base)]
        rgs = (singles + [g for g in by_rg.values() if g not in singles])[:MAX_RELEASE_GROUPS]
        ev["musicbrainz"] = {
            "recording": f"https://musicbrainz.org/recording/{best['id']}",
            "title": best.get("title", ""), "length": length_of(best),
            "releases": len(releases), "own_releases": len(own),
            "release_groups": [{"title": g.get("title", ""), "type": g.get("primary-type", ""),
                                "url": f"https://musicbrainz.org/release-group/{g['id']}"} for g in rgs]}
    else:
        hits = [a for a in get(mb_artist_search_url(artist)).get("artists", [])
                if int(a.get("score", 0)) >= MB_MIN_SCORE and fold(a.get("name", "")) == fold(artist)]
        if len(hits) == 1:
            artist_id = hits[0]["id"]
        elif hits:
            ev["musicbrainz"]["artist_candidates"] = len(hits)
    # Artist: url relations, Wikidata, articles.
    lang_extra = ""
    entities: dict[str, tuple[str, str]] = {}  # qid -> (level, entity)
    if artist_id:
        a = get(mb_entity_url("artist", artist_id))
        ev["musicbrainz"]["artist"] = f"https://musicbrainz.org/artist/{artist_id}"
        lang_extra = LANG_BY_COUNTRY.get(a.get("country") or "", "")
        q = add_links(ev, url_rels(a), "artist")
        q = q or first_qid(get(wd_search_url("P434", artist_id)))
        if q:
            entities[q] = ("artist", artist_id)
    for g in rgs:
        level = "song" if (g.get("primary-type") in ("Single", "EP")
                           and fold(split_title(g.get("title", ""))[0]) == fold(base)) else "release"
        q = add_links(ev, url_rels(get(mb_entity_url("release-group", g["id"]))), "release")
        q = q or first_qid(get(wd_search_url("P436", g["id"])))
        if q:
            entities.setdefault(q, (level, g["id"]))
    if entities:
        found_links = get(wd_sitelinks_url(sorted(entities))).get("entities", {})
        for q, (level, entity) in entities.items():
            pages = wikipedias(found_links.get(q, {}).get("sitelinks", {}))
            ev["wikidata"] = ev.get("wikidata", []) + [f"https://www.wikidata.org/wiki/{q}"]
            if not pages:
                continue
            lang = next((x for x in ("en", lang_extra) if x in pages), next(iter(pages)))
            if level == "artist":
                ev["artist_wikis"] = max(ev["artist_wikis"], len(pages))
                ev["artist_article"] = pages[lang]
                continue
            ev["articles"].append({"level": level, "lang": lang, "url": pages[lang], "wikis": len(pages),
                                   "entity": entity, "via": "wikidata"})
    # Name search on Wikipedia: the song, and the album when it is named otherwise.
    album = ALBUM_NOISE.sub("", row.get("album", "")).strip()
    searches = [(base, "song")]
    if album and fold(album) != fold(base):
        searches.append((album, "release"))
    for lang in ["en"] + ([lang_extra] if lang_extra and lang_extra != "en" else []):
        for name, default in searches:
            for hit in get(wp_search_url(lang, name, artist)).get("query", {}).get("search", []):
                level = article_hit(hit.get("title", ""), hit.get("snippet", ""), name, artist, default)
                if not level:
                    continue
                if "(" not in hit["title"] and disambiguation(get(wp_page_url(lang, hit["title"]))):
                    continue  # "My Love" lists every "My Love (… song)"; it is about none of them
                mb = ev["musicbrainz"]
                if default == "release" and mb.get("releases") and not mb.get("own_releases"):
                    level = "compilation"  # the row's album is a compilation that carries it
                url = f"https://{lang}.wikipedia.org/wiki/" + urllib.parse.quote(hit["title"].replace(" ", "_"))
                if all(a["url"] != url for a in ev["articles"]):
                    ev["articles"].append({"level": level, "lang": lang, "url": url,
                                           "entity": hit["title"], "via": "wikipedia search"})
                break
    return ev


def first_qid(found: dict) -> str:
    hits = found.get("query", {}).get("search", [])
    return hits[0]["title"] if hits and re.fullmatch(r"Q\d+", hits[0].get("title", "")) else ""


def add_links(ev: dict, rels: list[tuple[str, str]], level: str) -> str:
    """Record the url relations of an entity; return its Wikidata id when it has one."""
    q = ""
    for kind, url in rels:
        if kind == "wikidata":
            q = q or qid(url)
            continue
        if kind == "wikipedia":
            if level == "artist":
                ev["artist_wikis"] = max(ev["artist_wikis"], 1)
            else:
                ev["articles"].append({"level": level, "lang": urllib.parse.urlparse(url).netloc.split(".")[0],
                                       "url": url, "entity": url, "via": "musicbrainz"})
            continue
        bucket = SUBSTANTIVE_RELS.get(kind) or ("catalogue" if kind in CATALOGUE_RELS else "")
        if bucket and all(link["url"] != url for link in ev["links"]):
            ev["links"].append({"level": level, "kind": bucket, "type": kind, "url": url})
    return q


def screen_row(row: dict, get: Fetch = fetch) -> dict:
    try:
        ev = gather(row, get)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError, KeyError) as exc:
        ev = {"identity": "unknown", "error": f"{type(exc).__name__}: {exc}"}
    tier, score, reasons = assess(ev)
    return {**row, "screen": {"tier": tier, "score": score, "reasons": reasons, "evidence": ev}}


def screen(rows: list[dict], get: Fetch = fetch, progress=None, pause: float = RETRY_PAUSE) -> list[dict]:
    """Screen every row and rank them: tier, then score, then the backlog's own order. A row
    whose source failed (MusicBrainz answers 503 when busy) is screened once more after a pause;
    what succeeded the first time comes from the cache."""
    out = []
    for i, row in enumerate(rows, 1):
        r = screen_row(row, get)
        if r["screen"]["evidence"].get("error") and pause:
            time.sleep(pause)
            r = screen_row(row, get)
        out.append(r)
        if progress:
            print(f"screen: {i}/{len(rows)} {row.get('input', row['title'])}: "
                  f"{r['screen']['tier']} {r['screen']['score']}", file=progress, flush=True)
    out.sort(key=lambda r: (TIERS.index(r["screen"]["tier"]), -r["screen"]["score"], r.get("n", 0)))
    return out


def summary(rows: list[dict]) -> dict[str, int]:
    return {t: sum(r["screen"]["tier"] == t for r in rows) for t in TIERS}


def print_table(rows: list[dict], seconds: float) -> None:
    for r in rows:
        s = r["screen"]
        print(f"#{r.get('n', 0):>3}  {s['tier']:<9} {s['score']:>3}  {r.get('input', r['title'])}"
              f"   [{', '.join(s['reasons'])}]")
    counts = summary(rows)
    print(f"screen: {len(rows)} songs, " + ", ".join(f"{v} {k}" for k, v in counts.items())
          + f" ({seconds:.0f} s)")


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("input", help='"Artist - Song"')
    parser.add_argument("--duration", default="", help="m:ss, the row's length")
    parser.add_argument("--album", default="")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    artist, _, title = args.input.partition(" - ")
    if not title:
        parser.error('input must be "Artist - Song"')
    row = {"n": 1, "title": title, "artist": artist, "album": args.album,
           "duration": args.duration, "input": args.input}
    started = time.monotonic()
    rows = screen([row])
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=1))
    else:
        print_table(rows, time.monotonic() - started)
    return 0


if __name__ == "__main__":
    sys.exit(main())
