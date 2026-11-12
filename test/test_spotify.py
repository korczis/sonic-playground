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

    def test_a_yearbook_without_its_year_is_refused(self):
        (cat.BACKLOG / "broken.toml").write_text('kind = "yearbook"\nsource = "fixture of the unit tests"\n')
        errors = []
        cat.load_playlists(errors)
        self.assertTrue(any("needs its year" in e for e in errors))


if __name__ == "__main__":
    unittest.main()
