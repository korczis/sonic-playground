#!/usr/bin/env python3
"""The owner's annual Spotify "Top Songs" playlists as yearbooks (data/backlog/yearbook-<year>.toml).

Development-time only: the public site never talks to Spotify. Read access is authorised by the
owner (OAuth PKCE, no client secret); the token lives outside the repository. Spotify does not
let new API clients read Spotify-owned playlists, and the "Your Top Songs" playlists are owned by
Spotify: copy one into a playlist of your own in the app (… > Add to other playlist > New
playlist), or use the account data export ("Download your data"), which this also reads.

    export SPOTIFY_CLIENT_ID=<your app's client id>      redirect URI http://127.0.0.1:8765/callback
    python3 scripts/spotify.py auth                     authorise once (opens the browser)
    python3 scripts/spotify.py discover                 your playlists that look like yearbooks
    python3 scripts/spotify.py import <playlist id|url> --year 2023 [--write]
    python3 scripts/spotify.py import-export <dir> [--write]    from Spotify's data export
    python3 scripts/spotify.py coverage                 per year: items, resolved, missing, ...

Without --write an import only reports. A write is idempotent: unchanged items leave the file as
it is. No account identifier is stored; a track's Spotify id and ISRC are public catalogue ids.
Every item resolves to one review through scripts/catalog.py (resolve_item); `python3
scripts/backlog.py` lists what still needs a review (skill add-song).
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import catalog as cat  # noqa: E402

API = "https://api.spotify.com/v1/"
ACCOUNTS = "https://accounts.spotify.com/"
REDIRECT = "http://127.0.0.1:8765/callback"
SCOPES = "playlist-read-private playlist-read-collaborative"
TOKEN = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "sonic-playground" / "spotify.json"
# Names Spotify gives the annual playlists, in the languages the account may use.
YEARBOOK = re.compile(
    r"(?i)\b(?:your\s+top\s+songs|top\s+songs|wrapped|tvoje\s+nej\w*\s+skladby|vaše\s+top\s+skladby|"
    r"deine\s+top-?songs|tus\s+canciones\s+top|tes\s+titres\s+pr[ée]f[ée]r[ée]s)\D*(20\d\d)\b")


class SpotifyError(Exception):
    pass


# --- Authorisation (PKCE). ------------------------------------------------------------------

def client_id() -> str:
    cid = os.environ.get("SPOTIFY_CLIENT_ID", "")
    if not cid:
        raise SpotifyError("SPOTIFY_CLIENT_ID is not set: create an app at developer.spotify.com "
                           f"with the redirect URI {REDIRECT} and export its client id")
    return cid


def post_form(url: str, form: dict) -> dict:
    body = urllib.parse.urlencode(form).encode()
    request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode())


def save_token(data: dict) -> None:
    data = {**data, "expires_at": int(time.time()) + int(data.get("expires_in", 3600)) - 60}
    TOKEN.parent.mkdir(parents=True, exist_ok=True)
    TOKEN.write_text(json.dumps(data), encoding="utf-8")
    TOKEN.chmod(0o600)


def auth() -> int:
    verifier = secrets.token_urlsafe(64)[:96]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)
    url = ACCOUNTS + "authorize?" + urllib.parse.urlencode({
        "client_id": client_id(), "response_type": "code", "redirect_uri": REDIRECT, "scope": SCOPES,
        "code_challenge_method": "S256", "code_challenge": challenge, "state": state})
    got: dict = {}

    class Callback(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 (the stdlib's name)
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            got.update({k: v[0] for k, v in query.items()})
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write("Sonic Playground: authorised, you can close this tab.".encode())

        def log_message(self, format, *args):  # noqa: A002 (the stdlib's signature)
            pass

    print(f"spotify: open this URL to authorise read access to your playlists:\n{url}", file=sys.stderr)
    webbrowser.open(url)
    with http.server.HTTPServer(("127.0.0.1", 8765), Callback) as server:
        server.timeout = 300
        server.handle_request()
    if got.get("state") != state or "code" not in got:
        raise SpotifyError(f"authorisation did not complete: {got.get('error', 'no code returned')}")
    save_token(post_form(ACCOUNTS + "api/token", {
        "grant_type": "authorization_code", "code": got["code"], "redirect_uri": REDIRECT,
        "client_id": client_id(), "code_verifier": verifier}))
    print(f"spotify: authorised; token saved to {TOKEN} (outside the repository)", file=sys.stderr)
    return 0


def token() -> str:
    if not TOKEN.exists():
        raise SpotifyError("not authorised: run python3 scripts/spotify.py auth")
    data = json.loads(TOKEN.read_text(encoding="utf-8"))
    if data.get("expires_at", 0) <= time.time():
        fresh = post_form(ACCOUNTS + "api/token", {"grant_type": "refresh_token",
                                                   "refresh_token": data["refresh_token"],
                                                   "client_id": client_id()})
        fresh.setdefault("refresh_token", data["refresh_token"])
        save_token(fresh)
        data = json.loads(TOKEN.read_text(encoding="utf-8"))
    return data["access_token"]


# --- The Web API, paged and patient. --------------------------------------------------------

def http_get(url: str) -> dict:
    """GET a Spotify API document; waits out 429 (Retry-After), refreshes once on 401, retries
    a server error; a 403/404 on a playlist is Spotify's policy, said as such."""
    refreshed = False
    for attempt in range(6):
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token()}"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                time.sleep(int(exc.headers.get("Retry-After", "2")) + 1)
                continue
            if exc.code == 401 and not refreshed:
                data = json.loads(TOKEN.read_text(encoding="utf-8"))
                data["expires_at"] = 0
                TOKEN.write_text(json.dumps(data), encoding="utf-8")
                refreshed = True
                continue
            if exc.code in (500, 502, 503, 504) and attempt < 5:
                time.sleep(2 ** attempt)
                continue
            if exc.code in (403, 404):
                raise SpotifyError(f"Spotify refused {url.split('?')[0]} ({exc.code}): a Spotify-owned "
                                   "playlist (such as Your Top Songs) cannot be read by the API; copy it "
                                   "into a playlist of your own, or use import-export") from exc
            raise
    raise SpotifyError(f"Spotify kept refusing {url} (rate limit)")


def paged(url: str, get=None) -> tuple[list, int | None]:
    """Every item of a paged collection, following `next`; and the total Spotify reports."""
    get = get or http_get
    items: list = []
    total: int | None = None
    next_url: str | None = url
    while next_url:
        url = next_url
        page = get(url)
        total = page.get("total", total)
        items += page.get("items", [])
        next_url = page.get("next")
    return items, total


# --- Items: one recording per position. -----------------------------------------------------

def duration(ms: int | None) -> str:
    if not ms:
        return ""
    s = round(ms / 1000)
    return f"{s // 60}:{s % 60:02d}"


def item_from_api(n: int, entry: dict) -> dict:
    t = entry.get("track")
    if not t:
        return {"n": n, "uncertain": True, "note": "the item is no longer available on Spotify"}
    if t.get("type") == "episode":
        return {"n": n, "title": t.get("name", ""), "skip": "a podcast episode, not a song"}
    if t.get("is_local"):
        return {"n": n, "title": t.get("name", ""), "artists": [a["name"] for a in t.get("artists", []) if a.get("name")],
                "uncertain": True, "note": "a local file, not a catalogue recording"}
    out = {"n": n, "title": t.get("name", ""), "artists": [a["name"] for a in t.get("artists", []) if a.get("name")]}
    if (t.get("album") or {}).get("name"):
        out["album"] = t["album"]["name"]
    if duration(t.get("duration_ms")):
        out["duration"] = duration(t["duration_ms"])
    if t.get("id") and re.fullmatch(r"[0-9A-Za-z]{22}", t["id"]):
        out["spotify"] = t["id"]
    isrc = ((t.get("external_ids") or {}).get("isrc") or "").upper()
    if re.fullmatch(r"[A-Z]{2}[A-Z0-9]{3}\d{7}", isrc):
        out["isrc"] = isrc
    if not out["title"] or not out["artists"]:
        out["uncertain"] = True
    return out


def item_from_export(n: int, entry: dict) -> dict:
    t = entry.get("track")
    if entry.get("episode"):
        return {"n": n, "title": entry["episode"].get("episodeName", ""), "skip": "a podcast episode, not a song"}
    if entry.get("localTrack") or not t:
        return {"n": n, "uncertain": True, "note": "a local file or an item the export does not describe"}
    out = {"n": n, "title": t.get("trackName", ""), "artists": [t["artistName"]] if t.get("artistName") else []}
    if t.get("albumName"):
        out["album"] = t["albumName"]
    m = re.fullmatch(r"spotify:track:([0-9A-Za-z]{22})", t.get("trackUri", ""))
    if m:
        out["spotify"] = m.group(1)
    if not out["title"] or not out["artists"]:
        out["uncertain"] = True
    return out


def year_of(name: str) -> int | None:
    m = YEARBOOK.search(name or "")
    return int(m.group(1)) if m else None


# --- The yearbook file: written only when its items change. ---------------------------------

def render(year: int, name: str, source: str, items: list[dict], expected: int | None, retrieved: str) -> str:
    lines = [f"# The owner's Spotify yearbook {year} (\"{name}\"), written by scripts/spotify.py.",
             "# Items are recordings in playlist order; scripts/catalog.py resolves each to one review.",
             'kind = "yearbook"', f"year = {year}", f"name = {json.dumps(name, ensure_ascii=False)}",
             f"source = {json.dumps(source, ensure_ascii=False)}", f'retrieved = "{retrieved}"']
    if expected is not None:
        lines.append(f"expected = {expected}")
    for it in items:
        lines.append("")
        lines.append("[[track]]")
        for key in ("n", "title", "artists", "album", "duration", "spotify", "isrc", "uncertain", "skip", "review", "note"):
            if key in it:
                v = it[key]
                lines.append(f"{key} = " + (str(v).lower() if isinstance(v, bool) else
                                            str(v) if isinstance(v, int) else json.dumps(v, ensure_ascii=False)))
    return "\n".join(lines) + "\n"


def write_yearbook(year: int, name: str, source: str, items: list[dict], expected: int | None,
                   write: bool, out_dir: Path | None = None) -> dict:
    """Idempotent: the file is rewritten only when its items differ; an owner's review=/skip=
    overrides on an unchanged item survive a re-import."""
    path = (out_dir or cat.BACKLOG) / f"yearbook-{year}.toml"
    old = cat.tomllib.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    keep = {i.get("spotify") or (i.get("title"), tuple(i.get("artists", []))): i
            for i in old.get("track", [])}
    for it in items:
        prior = keep.get(it.get("spotify") or (it.get("title"), tuple(it.get("artists", []))))
        for key in ("review", "skip", "note"):
            if prior and key in prior and key not in it:
                it[key] = prior[key]
    same = old.get("track") == items and old.get("name") == name and old.get("expected") == expected
    shown = path.relative_to(cat.ROOT).as_posix() if path.is_relative_to(cat.ROOT) else str(path)
    report = {"year": year, "file": shown,
              "expected": expected, "retrieved": len(items),
              "complete": expected is None or expected == len(items), "changed": not same}
    if write and not same:
        path.write_text(render(year, name, source, items, expected, date.today().isoformat()), encoding="utf-8")
    report["written"] = bool(write and not same)
    return report


# --- Commands. ------------------------------------------------------------------------------

def discover(get=None) -> list[dict]:
    playlists, _ = paged(API + "me/playlists?limit=50", get)
    found = []
    for p in playlists:
        year = year_of(p.get("name", ""))
        if year:
            found.append({"id": p["id"], "name": p["name"], "year": year,
                          "owner": (p.get("owner") or {}).get("id") == "spotify" and "spotify" or "you",
                          "items": (p.get("tracks") or p.get("items") or {}).get("total")})
    return sorted(found, key=lambda f: (f["year"], f["name"]))


def playlist_id(text: str) -> str:
    m = re.search(r"(?:playlist[/:])?([0-9A-Za-z]{22})", text)
    if not m:
        raise SpotifyError(f"not a playlist id or link: {text}")
    return m.group(1)


def import_playlist(pid: str, year: int | None, write: bool, get=None) -> dict:
    get = get or http_get
    meta = get(API + f"playlists/{pid}?fields=name,tracks(total)")
    name = meta.get("name", "")
    year = year or year_of(name)
    if not year:
        raise SpotifyError(f"'{name}' does not name its year; pass --year")
    fields = "items(track(id,name,type,is_local,duration_ms,artists(name),album(name),external_ids(isrc))),next,total"
    entries, total = paged(API + f"playlists/{pid}/tracks?limit=100&fields={urllib.parse.quote(fields)}", get)
    items = [item_from_api(i + 1, e) for i, e in enumerate(entries)]
    source = f"Spotify Web API, the owner's playlist \"{name}\""
    return write_yearbook(year, name, source, items, total, write)


def import_export(folder: Path, write: bool) -> list[dict]:
    reports = []
    for path in sorted(folder.glob("Playlist*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        for p in data.get("playlists", []):
            year = year_of(p.get("name", ""))
            if not year:
                continue
            items = [item_from_export(i + 1, e) for i, e in enumerate(p.get("items", []))]
            source = f"Spotify account data export ({path.name}), the owner's playlist \"{p['name']}\""
            reports.append(write_yearbook(year, p["name"], source, items, None, write))
    return reports


def coverage() -> list[dict]:
    errors: list[str] = []
    catalog = cat.build(errors)
    return [{k: b[k] for k in ("year", "name", "expected", "items", "songs", "present", "missing",
                                "ambiguous", "skipped", "uncertain")} for b in catalog["yearbooks"]]


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("auth")
    sub.add_parser("discover")
    p_imp = sub.add_parser("import")
    p_imp.add_argument("playlist")
    p_imp.add_argument("--year", type=int)
    p_imp.add_argument("--write", action="store_true")
    p_exp = sub.add_parser("import-export")
    p_exp.add_argument("folder", type=Path)
    p_exp.add_argument("--write", action="store_true")
    sub.add_parser("coverage")
    args = parser.parse_args()
    try:
        if args.command == "auth":
            return auth()
        if args.command == "discover":
            result = discover()
        elif args.command == "import":
            result = import_playlist(playlist_id(args.playlist), args.year, args.write)
        elif args.command == "import-export":
            result = import_export(args.folder, args.write)
        else:
            result = coverage()
    except SpotifyError as exc:
        print(f"spotify: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
