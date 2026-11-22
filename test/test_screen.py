"""Unit tests of scripts/screen.py (the researchability screen) on fixtures: no network.

    python3 -m unittest discover -s test -p 'test_*.py'

test/fixtures/screen.json holds the API answers, keyed by the screen's own URL builders, so a
change of query shape fails here rather than silently missing the cache.
"""
import importlib.util
import json
import sys
import unittest
import urllib.error
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("screen", ROOT / "scripts" / "screen.py")
assert spec is not None and spec.loader is not None
screen: Any = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screen)

FIXTURE = json.loads((ROOT / "test" / "fixtures" / "screen.json").read_text(encoding="utf-8"))


def answers() -> dict:
    out = {}
    for key, value in FIXTURE.items():
        if key.startswith("_"):
            continue
        name, *args = key.split("|")
        if name == "wd_sitelinks_url":
            args = [args[0].split(",")]
        out[getattr(screen, name)(*args)] = value
    return out


ANSWERS = answers()


def get(url: str) -> dict:
    return ANSWERS.get(url, {})


def row(n, artist, title, duration, album=""):
    return {"n": n, "title": title, "artist": artist, "album": album, "duration": duration,
            "input": f"{artist} - {title}"}


class Titles(unittest.TestCase):
    def test_song_and_version(self):
        self.assertEqual(screen.split_title("Go All Night - Booka Shade Remix"),
                         ("Go All Night", "Booka Shade Remix"))
        self.assertEqual(screen.split_title("Hoping (Herbert's High Dub)"), ("Hoping", "Herbert's High Dub"))
        self.assertEqual(screen.split_title("Catch - 2021 Remaster"), ("Catch", ""))
        self.assertEqual(screen.split_title("Say Something (feat. Chris Stapleton)"), ("Say Something", ""))
        self.assertEqual(screen.split_title("F.E.E.L."), ("F.E.E.L.", ""))

    def test_distinctive_words_name_whose_version(self):
        self.assertEqual(screen.distinctive("Booka Shade Remix"), ["booka", "shade"])
        self.assertEqual(screen.distinctive("Video Edit"), [])
        self.assertEqual(screen.distinctive("Unplugged"), ["unplugged"])

    def test_wikipedias_only(self):
        links = {"enwiki": {"title": "A B"}, "zh_yuewiki": {"title": "C"},
                 "commonswiki": {"title": "D"}, "enwikiquote": {"title": "E"}}
        self.assertEqual(screen.wikipedias(links), {"en": "https://en.wikipedia.org/wiki/A_B",
                                                    "zh-yue": "https://zh-yue.wikipedia.org/wiki/C"})

    def test_a_search_hit_must_be_the_song_by_the_artist(self):
        hit = screen.article_hit
        self.assertEqual(hit("Milkshake (song)", "by American singer Kelis", "Milkshake", "Kelis", "song"), "song")
        self.assertEqual(hit("Tasty (Kelis album)", "", "Tasty", "Kelis", "release"), "release")
        self.assertEqual(hit("Ultraviolence (album)", "Lana Del Rey's third", "Ultraviolence",
                             "Lana Del Rey", "song"), "release")
        self.assertIsNone(hit("Mother (Pink Floyd song)", "Florence Welch covered", "Mother",
                              "Florence + The Machine", "song"))
        self.assertIsNone(hit("Milkshake", "a cold beverage", "Milkshake", "Kelis", "song"))
        self.assertIsNone(hit("Milkshake Duck", "Kelis", "Milkshake", "Kelis", "song"))


class Screen(unittest.TestCase):
    def one(self, r):
        return screen.screen_row(r, get)["screen"]

    def test_a_song_with_its_own_article_is_writable(self):
        s = self.one(row(20, "Kelis", "Milkshake", "3:02", "Tasty"))
        self.assertEqual(s["tier"], "writable")
        self.assertEqual(set(s["reasons"]), {"mb-confirmed", "own-release", "song-article", "review",
                                             "allmusic-release", "artist-article", "artist-wide"})
        self.assertEqual(s["score"], 14)
        ev = s["evidence"]
        self.assertEqual(ev["identity"], "confirmed")
        self.assertEqual(ev["musicbrainz"]["releases"], 3)  # not the remix, not the namesake
        self.assertEqual(ev["musicbrainz"]["own_releases"], 2)
        self.assertEqual([g["type"] for g in ev["musicbrainz"]["release_groups"]], ["Single", "Album"])
        self.assertIn("https://en.wikipedia.org/wiki/Milkshake_%28song%29", [a["url"] for a in ev["articles"]])
        self.assertEqual(ev["artist_wikis"], 10)
        kinds = {link["type"] for link in ev["links"]}
        self.assertEqual(kinds, {"discogs", "allmusic", "review"})  # streaming is not evidence

    def test_a_remix_needs_more_than_the_originals_article(self):
        s = self.one(row(24, "Kiesza", "Hideaway - Gorgon City Remix", "5:11", "Sirens (Remixes)"))
        ev = s["evidence"]
        self.assertEqual(ev["identity"], "confirmed")
        self.assertEqual(ev["musicbrainz"]["title"], "Hideaway (Gorgon City remix)")
        self.assertEqual(ev["version"], "gorgon city")
        self.assertIn("compilation-only", s["reasons"])
        self.assertIn("song-article", s["reasons"])
        self.assertEqual(s["tier"], "ambiguous")

    def test_catalogue_rows_only_are_thin(self):
        s = self.one(row(60, "Luke Garcia, Th3 Oth3r", "Hoag", "7:04", "Dantze, Baby II"))
        self.assertEqual(s["tier"], "thin")
        self.assertEqual(set(s["reasons"]), {"mb-confirmed", "own-release", "catalogue"})
        self.assertEqual(len(s["evidence"]["links"]), 2)

    def test_a_recording_at_another_length_is_unclear(self):
        s = self.one(row(58, "Lucky Luke", "F.E.E.L.", "3:24"))
        self.assertEqual(s["evidence"]["identity"], "unclear")
        self.assertIn("mb-length-off", s["reasons"])
        self.assertEqual(s["tier"], "ambiguous")

    def test_no_recording_and_namesakes_is_unclear(self):
        s = self.one(row(33, "Kovacs", "My Love", "3:55", "Shades of Black"))
        self.assertEqual(s["tier"], "ambiguous")
        self.assertEqual(set(s["reasons"]), {"mb-none", "artist-namesakes"})
        self.assertEqual(s["evidence"]["musicbrainz"]["artist_candidates"], 2)

    def test_a_disambiguation_page_is_not_the_songs_article(self):
        s = self.one(row(33, "Kovacs", "My Love", "3:55"))
        self.assertNotIn("song-article", s["reasons"])
        s = self.one(row(1, "Belleruche", "Bird Mess", "4:04"))
        self.assertEqual([a["url"] for a in s["evidence"]["articles"]],
                         ["https://en.wikipedia.org/wiki/Bird_Mess"])

    def test_nothing_found_is_thin(self):
        s = self.one(row(45, "Landhouse, Raddantze", "Alfons Trinkt Gern Schnaps", "5:48"))
        self.assertEqual((s["tier"], s["reasons"]), ("thin", ["mb-none"]))

    def test_a_failed_source_is_ambiguous_not_thin(self):
        def down(url):
            raise urllib.error.URLError("busy")
        rows = screen.screen([row(1, "Kelis", "Milkshake", "3:02")], down, pause=0)
        self.assertEqual(rows[0]["screen"]["tier"], "ambiguous")
        self.assertIn("screen-error", rows[0]["screen"]["reasons"])

    def test_ranked_by_tier_then_score_then_backlog_order(self):
        rows = screen.screen([row(60, "Luke Garcia, Th3 Oth3r", "Hoag", "7:04"),
                              row(58, "Lucky Luke", "F.E.E.L.", "3:24"),
                              row(20, "Kelis", "Milkshake", "3:02", "Tasty")], get, pause=0)
        self.assertEqual([r["n"] for r in rows], [20, 58, 60])
        self.assertEqual(screen.summary(rows), {"writable": 1, "ambiguous": 1, "thin": 1})


class Assess(unittest.TestCase):
    def test_two_independent_sources_make_a_song_writable(self):
        ev = {"identity": "confirmed", "links": [
            {"level": "release", "kind": "review", "url": "https://a.example/r"},
            {"level": "release", "kind": "review", "url": "https://b.example/r"}]}
        self.assertEqual(screen.assess(ev)[0], "writable")
        one_site = {"identity": "confirmed", "links": [
            {"level": "release", "kind": "review", "url": "https://a.example/r1"},
            {"level": "release", "kind": "review", "url": "https://a.example/r2"}]}
        self.assertEqual(screen.assess(one_site)[0], "ambiguous")

    def test_artist_coverage_alone_is_ambiguous(self):
        self.assertEqual(screen.assess({"identity": "confirmed", "artist_wikis": 3})[0], "ambiguous")

    def test_weights_cover_every_reason(self):
        tier, score, reasons = screen.assess({"identity": "unknown", "error": "x"})
        self.assertTrue(set(reasons) <= set(screen.WEIGHTS))
        self.assertEqual(score, sum(screen.WEIGHTS[r] for r in reasons))


if __name__ == "__main__":
    unittest.main()
