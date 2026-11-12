"""Unit tests of scripts/spotify.py and the yearbook derivation of scripts/catalog.py, on
fixtures: no network, no account.

majordomus-skill: import-yearbook

    python3 -m unittest discover -s test -p 'test_*.py'
"""
import importlib.util
import json
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("spotify", ROOT / "scripts" / "spotify.py")
assert spec is not None and spec.loader is not None
spotify: Any = importlib.util.module_from_spec(spec)
sys.modules["spotify"] = spotify
spec.loader.exec_module(spotify)
cat = spotify.cat


def api_track(i, name, artists, isrc=None, kind="track", local=False, ms=215000):
    return {"track": {"id": f"{i:022d}"[-22:].replace("0", "A"), "name": name, "type": kind,
                      "is_local": local, "duration_ms": ms, "artists": [{"name": a} for a in artists],
                      "album": {"name": "Album"}, "external_ids": {"isrc": isrc} if isrc else {}}}


class FakeApi:
    """Pages of 2 items, like a real paged collection, and the playlist's meta."""
    def __init__(self, name, entries):
        self.name, self.entries, self.calls = name, entries, []

    def __call__(self, url):
        self.calls.append(url)
        if "/tracks?" in url or "offset=" in url:
            offset = int(url.split("offset=")[1]) if "offset=" in url else 0
            page = self.entries[offset:offset + 2]
            nxt = f"https://api.spotify.com/v1/playlists/x/tracks?offset={offset + 2}" if offset + 2 < len(self.entries) else None
            return {"items": page, "next": nxt, "total": len(self.entries)}
        return {"name": self.name, "tracks": {"total": len(self.entries)}}


class Items(unittest.TestCase):
    def test_a_track_keeps_its_identity(self):
        it = spotify.item_from_api(3, api_track(1, "Gooey", ["Glass Animals"], isrc="gbum71401234"))
        self.assertEqual((it["n"], it["title"], it["artists"], it["duration"], it["isrc"]),
                         (3, "Gooey", ["Glass Animals"], "3:35", "GBUM71401234"))
        self.assertEqual(len(it["spotify"]), 22)

    def test_what_is_not_a_song_is_said_so(self):
        self.assertIn("skip", spotify.item_from_api(1, api_track(1, "Ep. 4", ["Pod"], kind="episode")))
        self.assertTrue(spotify.item_from_api(1, api_track(1, "demo", ["me"], local=True))["uncertain"])
        self.assertTrue(spotify.item_from_api(1, {"track": None})["uncertain"])
        self.assertTrue(spotify.item_from_api(1, api_track(1, "", []))["uncertain"])

    def test_yearbook_names(self):
        for name, year in (("Your Top Songs 2019", 2019), ("Top Songs 2024", 2024),
                           ("Wrapped 2021", 2021), ("Vaše top skladby 2022", 2022),
                           ("Deine Top-Songs 2020", 2020)):
            self.assertEqual(spotify.year_of(name), year, name)
        self.assertIsNone(spotify.year_of("Chill 2019 vibes"))
        self.assertIsNone(spotify.year_of("Running"))


class Import(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.old = cat.BACKLOG
        cat.BACKLOG = Path(self.tmp.name)
        self.addCleanup(lambda: setattr(cat, "BACKLOG", self.old))

    def entries(self):
        return [api_track(i, f"Song {i}", [f"Artist {i}"], isrc=f"GBAAA2300{i:03d}") for i in range(1, 6)]

    def test_every_page_is_read_in_order_and_counted(self):
        fake = FakeApi("Your Top Songs 2023", self.entries())
        report = spotify.import_playlist("x" * 22, None, True, get=fake)
        self.assertEqual((report["year"], report["expected"], report["retrieved"], report["complete"]),
                         (2023, 5, 5, True))
        data = tomllib.loads((cat.BACKLOG / "yearbook-2023.toml").read_text())
        self.assertEqual([t["n"] for t in data["track"]], [1, 2, 3, 4, 5])
        self.assertEqual(data["kind"], "yearbook")
        self.assertEqual(len([c for c in fake.calls if "/tracks?" in c]), 3)  # 2 + 2 + 1

    def test_a_second_import_of_the_same_items_changes_nothing(self):
        spotify.import_playlist("x" * 22, None, True, get=FakeApi("Your Top Songs 2023", self.entries()))
        path = cat.BACKLOG / "yearbook-2023.toml"
        before = path.read_text()
        report = spotify.import_playlist("x" * 22, None, True, get=FakeApi("Your Top Songs 2023", self.entries()))
        self.assertFalse(report["changed"])
        self.assertEqual(path.read_text(), before)

    def test_an_owner_override_survives_a_reimport(self):
        spotify.import_playlist("x" * 22, None, True, get=FakeApi("Your Top Songs 2023", self.entries()))
        path = cat.BACKLOG / "yearbook-2023.toml"
        path.write_text(path.read_text().replace('title = "Song 2"', 'title = "Song 2"\nskip = "a skit, not a song"'))
        spotify.import_playlist("x" * 22, None, True, get=FakeApi("Your Top Songs 2023", self.entries()))
        items = tomllib.loads(path.read_text())["track"]
        self.assertEqual(items[1].get("skip"), "a skit, not a song")

    def test_without_write_nothing_is_written(self):
        report = spotify.import_playlist("x" * 22, 2018, False, get=FakeApi("Mix", self.entries()))
        self.assertFalse(report["written"])
        self.assertFalse((cat.BACKLOG / "yearbook-2018.toml").exists())

    def test_the_data_export_is_read(self):
        folder = Path(self.tmp.name) / "export"
        folder.mkdir()
        (folder / "Playlist1.json").write_text(json.dumps({"playlists": [
            {"name": "Your Top Songs 2017", "items": [
                {"track": {"trackName": "Glue", "artistName": "Bicep", "albumName": "Bicep",
                           "trackUri": "spotify:track:" + "B" * 22}},
                {"track": None, "episode": {"episodeName": "Ep"}},
            ]},
            {"name": "Running", "items": []},
        ]}))
        reports = spotify.import_export(folder, True)
        self.assertEqual([r["year"] for r in reports], [2017])
        items = tomllib.loads((cat.BACKLOG / "yearbook-2017.toml").read_text())["track"]
        self.assertEqual((items[0]["title"], items[0]["spotify"]), ("Glue", "B" * 22))
        self.assertIn("skip", items[1])


class Http(unittest.TestCase):
    """http_get against a fake urlopen: the rate limit is waited out, a refused playlist is said
    to be Spotify's policy, a missing authorisation is said as such."""
    def setUp(self):
        self.sleeps = []
        for name, value in (("token", lambda: "t"), ("time", type("T", (), {
                "sleep": staticmethod(self.sleeps.append), "time": staticmethod(lambda: 0)}))):
            old = getattr(spotify, name)
            setattr(spotify, name, value)
            self.addCleanup(setattr, spotify, name, old)

    def answer(self, *responses):
        calls = iter(responses)

        def urlopen(request, timeout=0):
            r = next(calls)
            if isinstance(r, int):
                headers = {"Retry-After": "3"} if r == 429 else {}
                raise spotify.urllib.error.HTTPError(request.full_url, r, "x", headers, None)

            class Body:
                def __enter__(self): return self
                def __exit__(self, *a): return False
                def read(self): return json.dumps(r).encode()
            return Body()
        old = spotify.urllib.request.urlopen
        spotify.urllib.request.urlopen = urlopen
        self.addCleanup(setattr, spotify.urllib.request, "urlopen", old)

    def test_the_rate_limit_is_waited_out(self):
        self.answer(429, 503, {"ok": 1})
        self.assertEqual(spotify.http_get("https://api.spotify.com/v1/x"), {"ok": 1})
        self.assertEqual(self.sleeps[0], 4)  # Retry-After 3, plus one

    def test_a_refused_playlist_names_the_policy(self):
        self.answer(403)
        with self.assertRaises(spotify.SpotifyError) as ctx:
            spotify.http_get("https://api.spotify.com/v1/playlists/x/tracks")
        self.assertIn("Spotify-owned playlist", str(ctx.exception))

    def test_a_rate_limit_that_never_ends_fails(self):
        self.answer(*([429] * 6))
        with self.assertRaises(spotify.SpotifyError):
            spotify.http_get("https://api.spotify.com/v1/x")

    def test_without_authorisation_the_command_says_so(self):
        old = spotify.TOKEN
        spotify.TOKEN = Path(tempfile.gettempdir()) / "no-such-spotify-token.json"
        self.addCleanup(setattr, spotify, "TOKEN", old)
        token = spotify.__dict__.get("token")
        setattr(spotify, "token", type(self).real_token)
        self.addCleanup(setattr, spotify, "token", token)
        with self.assertRaises(spotify.SpotifyError) as ctx:
            spotify.token()
        self.assertIn("not authorised", str(ctx.exception))

    real_token = staticmethod(spotify.token)


class Identity(unittest.TestCase):
    """resolve_item over a small fixture index: versions that are the same song match, versions
    that are another recording do not, several candidates are ambiguous."""
    def setUp(self):
        reviews = [("bicep-glue.md", "Bicep", "Glue"),
                   ("royksopp-eple.md", "Röyksopp", "Eple"),
                   ("moderat-bad-kingdom.md", "Moderat", "Bad Kingdom"),
                   ("moderat-bad-kingdom-dj-koze-remix.md", "Moderat", "Bad Kingdom (DJ Koze Remix)"),
                   ("a-one.md", "Twin", "Same Name"), ("b-one.md", "Twin", "Same Name - Remastered 2011")]
        self.index = cat.identity_index([{"source": s, "artist": a, "track": t} for s, a, t in reviews])
        self.index["isrc"]["GBAAA0000001"] = {"bicep-glue.md"}

    def of(self, title, *artists, **kw):
        return cat.resolve_item({"n": 1, "title": title, "artists": list(artists), **kw}, self.index)

    def test_versions_of_the_same_recording_match(self):
        for title in ("Glue", "Glue - Radio Edit", "Glue (Remastered 2019)", "Glue - Extended Version",
                      "Glue (feat. Someone)", "glue"):
            self.assertEqual(self.of(title, "Bicep")["source"], "bicep-glue.md", title)
        self.assertEqual(self.of("Glue", "Bicep", "Someone Featured")["source"], "bicep-glue.md")

    def test_unicode_and_spelling_fold(self):
        self.assertEqual(self.of("Eple", "Royksopp")["source"], "royksopp-eple.md")
        self.assertEqual(self.of("EPLE", "RÖYKSOPP")["source"], "royksopp-eple.md")

    def test_a_remix_or_a_live_recording_is_another_page(self):
        self.assertEqual(self.of("Bad Kingdom - DJ Koze Remix", "Moderat")["source"],
                         "moderat-bad-kingdom-dj-koze-remix.md")
        self.assertEqual(self.of("Bad Kingdom", "Moderat")["source"], "moderat-bad-kingdom.md")
        self.assertEqual(self.of("Bad Kingdom - Live", "Moderat")["status"], "missing")

    def test_the_isrc_wins_and_collisions_are_never_chosen(self):
        self.assertEqual(self.of("Another Title", "X", isrc="GBAAA0000001")["by"], "isrc")
        r = self.of("Same Name", "Twin")
        self.assertEqual((r["status"], r["by"]), ("ambiguous", "a-one.md, b-one.md"))

    def test_an_override_names_the_review(self):
        self.assertEqual(self.of("Whatever", "Y", review="bicep-glue.md")["by"], "override")


class Derivation(unittest.TestCase):
    """catalog.py: items resolve to one review each; a song in two years is one page with two
    memberships; ambiguity and gaps are reported, never guessed."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.old = cat.BACKLOG
        cat.BACKLOG = Path(self.tmp.name)
        self.addCleanup(lambda: setattr(cat, "BACKLOG", self.old))
        errors = []
        files = sorted(p for p in cat.CONTENT.glob("*.md") if p.name != "_index.md")
        self.tracks = [t for t in (cat.load_track(p, errors) for p in files) if t]
        self.sample = next(t for t in self.tracks if "," not in t.artist and t.youtube_id)

    def book(self, year, items):
        lines = ['kind = "yearbook"', f"year = {year}", 'source = "fixture of the unit tests"']
        for it in items:
            lines.append("[[track]]")
            lines += [f"{k} = {json.dumps(v)}" for k, v in it.items()]
        (cat.BACKLOG / f"yearbook-{year}.toml").write_text("\n".join(lines) + "\n")

    def test_one_song_in_two_years_is_one_page_with_two_memberships(self):
        t = self.sample
        self.book(2020, [{"n": 1, "title": t.track, "artists": [t.artist]},
                         {"n": 2, "title": "Nothing Like It", "artists": ["Nobody At All"]}])
        self.book(2021, [{"n": 7, "title": t.track + " - Radio Edit", "artists": [t.artist]}])
        errors = []
        books, member_of = cat.yearbooks(self.tracks, errors)
        self.assertEqual(errors, [])
        self.assertEqual([b["year"] for b in books], [2021, 2020])
        self.assertEqual(member_of[t.source], [{"year": 2020, "n": 1}, {"year": 2021, "n": 7}])
        y2020 = books[1]
        self.assertEqual((y2020["items"], y2020["present"], y2020["missing"]), (2, 1, 1))

    def test_two_recordings_of_one_song_in_one_year_are_one_membership(self):
        t = self.sample
        self.book(2016, [{"n": 3, "title": t.track, "artists": [t.artist]},
                         {"n": 9, "title": t.track + " - Radio Edit", "artists": [t.artist]}])
        books, member_of = cat.yearbooks(self.tracks, [])
        self.assertEqual(member_of[t.source], [{"year": 2016, "n": 3}])
        self.assertEqual((books[0]["items"], books[0]["songs"]), (2, 1))

    def test_an_empty_yearbook_counts_nothing(self):
        self.book(2015, [])
        books, _ = cat.yearbooks(self.tracks, [])
        self.assertEqual((books[0]["items"], books[0]["songs"], books[0]["present"]), (0, 0, 0))

    def test_derivation_is_deterministic(self):
        t = self.sample
        self.book(2020, [{"n": 1, "title": t.track, "artists": [t.artist]}])
        first = json.dumps(cat.yearbooks(self.tracks, []), sort_keys=True)
        self.assertEqual(json.dumps(cat.yearbooks(list(reversed(self.tracks)), []), sort_keys=True), first)

    def test_an_isrc_resolves_before_names(self):
        t = next(t for t in self.tracks if t.full_extra.get("isrc")) if any(
            t.full_extra.get("isrc") for t in self.tracks) else None
        if t is None:
            self.skipTest("no review carries an ISRC yet")
        self.book(2019, [{"n": 1, "title": "Completely Different Title", "artists": ["X"], "isrc": t.full_extra["isrc"]}])
        books, member_of = cat.yearbooks(self.tracks, [])
        self.assertEqual(member_of[t.source], [{"year": 2019, "n": 1}])

    def test_overrides_skips_and_uncertain_items(self):
        t = self.sample
        self.book(2018, [{"n": 1, "title": "Whatever", "artists": ["Someone"], "review": t.source},
                         {"n": 2, "title": "A Skit", "artists": ["Someone"], "skip": "not a song at all"},
                         {"n": 3, "uncertain": True},
                         {"n": 4, "title": "X", "artists": ["Y"], "review": "no-such-review.md"}])
        errors = []
        books, member_of = cat.yearbooks(self.tracks, errors)
        statuses = [i["status"] for i in books[0]["tracks"]]
        self.assertEqual(statuses[:3], ["present", "skipped", "uncertain"])
        self.assertTrue(any("no-such-review.md names no review" in e for e in errors))

    def test_an_override_naming_no_review_is_refused_in_any_playlist(self):
        (cat.BACKLOG / "mix.toml").write_text(
            'kind = "playlist"\nsource = "fixture of the unit tests"\n'
            '[[track]]\nn = 1\ntitle = "X"\nartists = ["Y"]\nreview = "no-such-review.md"\n')
        errors = []
        cat.load_playlists(errors)
        self.assertEqual([e.split("/")[-1] for e in errors],
                         ["mix.toml #1: review=no-such-review.md names no review"])

    def test_a_yearbook_without_its_year_is_refused(self):
        (cat.BACKLOG / "broken.toml").write_text('kind = "yearbook"\nsource = "fixture of the unit tests"\n')
        errors = []
        cat.load_playlists(errors)
        self.assertTrue(any("needs its year" in e for e in errors))


if __name__ == "__main__":
    unittest.main()
