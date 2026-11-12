"""Unit tests of scripts/track.py: link parsing, name splitting, the written article.

majordomus-skill: add-song

    python3 -m unittest discover -s test -p 'test_*.py'
"""
import argparse
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import tomllib
import unittest
from typing import Any
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("track", ROOT / "scripts" / "track.py")
assert spec is not None and spec.loader is not None
track: Any = importlib.util.module_from_spec(spec)
sys.modules["track"] = track
spec.loader.exec_module(track)
cat = track.cat

FIXTURE = {
    "aaaaaaaaaaa": {"title": "Bicep | Glue (Official Video)", "author_name": "Bicep"},
    "bbbbbbbbbbb": {"title": "Hello | Hania Rani", "author_name": "KEXP"},
    "ccccccccccc": {"title": "Virginia Plain (2012 Remaster)", "author_name": "Roxy Music"},
    "ddddddddddd": {"title": "Primitive", "author_name": "Róisín Murphy - Topic"},
}


def namespace(**kw):
    args = argparse.Namespace(offline=True, oembed_fixture=None, youtube=None, artist=None,
                              track=None, description=None, date="2026-01-02", dry_run=True,
                              force=False, genre=["electronic"], sentiment=["hypnotic"],
                              mood=None, tags=None)
    for k, v in kw.items():
        setattr(args, k, v)
    return args


def capture(fn, *a):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = fn(*a)
    return code, json.loads(buf.getvalue())


class Links(unittest.TestCase):
    def test_every_youtube_form(self):
        for url in ("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10",
                    "https://youtu.be/dQw4w9WgXcQ?si=x", "youtube.com/embed/dQw4w9WgXcQ",
                    "https://m.youtube.com/shorts/dQw4w9WgXcQ",
                    "https://music.youtube.com/watch?v=dQw4w9WgXcQ"):
            self.assertEqual(track.youtube_id(url), "dQw4w9WgXcQ", url)

    def test_slugs_transliterate_like_zola(self):
        # 2026-11-12: "Høffding" became "hffding", "Trentemøller" "trentemller"
        self.assertEqual(cat.slugify("Kölsch - Bloodline (feat. Tomas Høffding)"),
                         "kolsch-bloodline-feat-tomas-hoffding")
        self.assertEqual(cat.slugify("Trentemøller, Æther, Straße, Łódź"), "trentemoller-aether-strasse-lodz")

    def test_names_are_not_links(self):
        self.assertIsNone(track.youtube_id("Moderat - A New Error"))
        self.assertIsNone(track.youtube_id("dQw4w9WgXcQ"))


class Names(unittest.TestCase):
    def test_decorations_dropped_remix_kept(self):
        self.assertEqual(track.split_name("Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)"),
                         ("Rick Astley", "Never Gonna Give You Up"))
        self.assertEqual(track.split_name("Louisahhh - Love Is a Punk (Vitalic Remix) [Official Audio]"),
                         ("Louisahhh", "Love Is a Punk (Vitalic Remix)"))

    def test_channel_orients_the_separator(self):
        self.assertEqual(track.split_name("Bicep | Glue (Official Video)", "Bicep"), ("Bicep", "Glue"))
        self.assertEqual(track.split_name("Glue - Bicep", "Bicep"), ("Bicep", "Glue"))

    def test_channel_is_the_artist_when_the_title_has_no_dash(self):
        self.assertEqual(track.split_name("alt-J (∆) Breezeblocks", "alt-J"), ("alt-J", "Breezeblocks"))
        self.assertEqual(track.split_name("Primitive", "Róisín Murphy - Topic"), ("Róisín Murphy", "Primitive"))

    def test_only_platform_suffixes_are_stripped(self):
        self.assertEqual(track.split_name("Virginia Plain", "Roxy Music"), ("Roxy Music", "Virginia Plain"))

    def test_exact_channel_match_beats_a_prefix(self):
        # review round 2: "Talk | Talk Talk" from the channel "Talk Talk"
        self.assertEqual(track.split_name("Talk | Talk Talk", "Talk Talk"), ("Talk Talk", "Talk"))

    def test_ambiguous_prefix_falls_back_to_the_convention(self):
        self.assertEqual(track.split_name("Moderat - Moderato", "Mod"), ("Moderat", "Moderato"))


class Robustness(unittest.TestCase):
    def test_a_malformed_draft_does_not_break_the_engine(self):
        # review round 2: a draft with extra = "TODO" crashed every resolve/new
        with tempfile.TemporaryDirectory() as tmp:
            old = cat.CONTENT
            cat.CONTENT = Path(tmp)
            try:
                (Path(tmp) / "x-y.md").write_text('+++\ntitle = 3\ndraft = true\nextra = "TODO"\n+++\n',
                                                  encoding="utf-8")
                plan = track.resolve("Moderat - A New Error", namespace())
                self.assertTrue(plan["complete"])
                self.assertIsNone(plan["exists"])
            finally:
                cat.CONTENT = old

    def test_refresh_adds_a_key_when_extra_is_not_the_last_table(self):
        # review round 2: [extra] before [taxonomies] made refresh claim a change it did not make
        with tempfile.TemporaryDirectory() as tmp:
            old = cat.CONTENT
            cat.CONTENT = Path(tmp)
            try:
                path = Path(tmp) / "moderat-a-new-error.md"
                path.write_text(
                    '+++\ntitle = "Moderat - A New Error"\ndate = "2026-01-02"\n'
                    'description = "A slow-burning electronic piece with a hypnotic pulse."\n\n'
                    '[extra]\nyoutube = "https://www.youtube.com/embed/dQw4w9WgXcQ"\n\n'
                    '[taxonomies]\ngenre = ["electronic"]\nsentiment = ["hypnotic"]\n+++\n\nProse.\n',
                    encoding="utf-8")
                code, report = capture(track.refresh, str(path), argparse.Namespace(
                    youtube=None, album="III", release_year="2016", publisher=None))
                self.assertEqual(code, 0, report)
                meta = tomllib.loads(path.read_text().split("+++")[1])
                self.assertEqual((meta["extra"]["album"], meta["extra"]["release_year"]), ("III", "2016"))
                self.assertIn("Prose.", path.read_text())
            finally:
                cat.CONTENT = old


class Resolve(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(FIXTURE, tmp)
        tmp.close()
        self.fixture = tmp.name
        self.addCleanup(Path(tmp.name).unlink)

    def resolve(self, vid):
        return track.resolve(f"https://youtu.be/{vid}", namespace(oembed_fixture=self.fixture))

    def test_oembed_paths(self):
        bicep = self.resolve("aaaaaaaaaaa")
        self.assertEqual((bicep["artist"], bicep["track"]), ("Bicep", "Glue"))
        self.assertEqual(self.resolve("bbbbbbbbbbb")["artist"], "Hania Rani")
        self.assertEqual(self.resolve("ccccccccccc")["artist"], "Roxy Music")
        self.assertEqual(self.resolve("ddddddddddd")["file"], "content/roisin-murphy-primitive.md")

    def test_non_latin_name_is_refused_not_written_to_the_root(self):
        plan = track.resolve("你好 - 世界", namespace())
        self.assertFalse(plan["complete"])
        self.assertEqual(plan["file"], "")


class NewArticle(unittest.TestCase):
    def run_new(self, text, **kw):
        return capture(track.new, text, namespace(**kw))

    def test_written_article_meets_the_contract_once_written(self):
        code, plan = self.run_new("Moderat - A New Error", youtube="https://youtu.be/dQw4w9WgXcQ")
        self.assertEqual(code, 0)
        self.assertEqual(plan["file"], "content/moderat-a-new-error.md")
        text = plan["preview"]
        self.assertIn('youtube = "https://www.youtube.com/embed/dQw4w9WgXcQ"', text)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "moderat-a-new-error.md"
            path.write_text(text, encoding="utf-8")
            old = cat.CONTENT
            cat.CONTENT = Path(tmp)
            try:
                errors = []
                cat.load_track(path, errors)
                self.assertTrue(any("TODO(write)" in e for e in errors), "skeleton is unfinished")
                path.write_text(text.replace("TODO(write): ", "Written prose. "), encoding="utf-8")
                errors = []
                result = cat.load_track(path, errors)
                self.assertEqual(errors, [])
                self.assertEqual((result.artist, result.track), ("Moderat", "A New Error"))
            finally:
                cat.CONTENT = old

    def test_strings_are_serialised_as_toml(self):
        code, plan = self.run_new(r"AC\DC - Back In Black",
                                  description='Riffs "and" a \\ backslash,\nthen a new line that is long')
        self.assertEqual(code, 0)
        meta = tomllib.loads(plan["preview"].split("+++")[1])
        self.assertEqual(meta["title"], r"AC\DC - Back In Black")
        self.assertIn('"and"', meta["description"])

    def test_identity_is_pinned_when_the_title_would_read_differently(self):
        code, plan = self.run_new("x", artist="Moderat", track="Hello | Live")
        self.assertEqual(code, 0)
        self.assertTrue(plan["identity_pinned"])
        meta = tomllib.loads(plan["preview"].split("+++")[1])
        self.assertEqual((meta["extra"]["artist"], meta["extra"]["track"]), ("Moderat", "Hello | Live"))

    def test_existing_track_is_not_duplicated(self):
        code, plan = self.run_new("Bakermat - The River")
        self.assertEqual(code, 3)
        self.assertEqual(plan["exists"]["source"], "content/bakermat-the-river.md")

    def test_a_draft_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = cat.CONTENT
            cat.CONTENT = Path(tmp)
            try:
                (Path(tmp) / "moderat-a-new-error.md").write_text(
                    '+++\ntitle = "Moderat - A New Error"\ndraft = true\n+++\nprose\n', encoding="utf-8")
                code, plan = self.run_new("Moderat - A New Error")
                self.assertEqual(code, 3)
                self.assertTrue(plan["exists"]["draft"])
            finally:
                cat.CONTENT = old


class CheckAndRefresh(unittest.TestCase):
    def test_check_refuses_an_unfinished_article_and_paths_outside_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = cat.CONTENT
            cat.CONTENT = Path(tmp)
            try:
                code, plan = capture(track.new, "Moderat - A New Error", namespace(dry_run=False))
                self.assertEqual(code, 0)
                code, report = capture(track.check, str(Path(tmp) / "moderat-a-new-error.md"))
                self.assertEqual(code, 1)
                self.assertGreater(report["unfinished"], 0)
                code, report = capture(track.refresh, str(Path(tmp) / "moderat-a-new-error.md"),
                                       argparse.Namespace(youtube="https://youtu.be/dQw4w9WgXcQ",
                                                          album="Moderat III", release_year=None,
                                                          publisher=None))
                self.assertEqual(code, 0)
                meta = tomllib.loads((Path(tmp) / "moderat-a-new-error.md").read_text().split("+++")[1])
                self.assertEqual(meta["extra"]["album"], "Moderat III")
                self.assertTrue(meta["extra"]["youtube"].endswith("dQw4w9WgXcQ"))
            finally:
                cat.CONTENT = old
        with self.assertRaises(SystemExit):
            with contextlib.redirect_stderr(io.StringIO()):
                track.check("README.md")


if __name__ == "__main__":
    unittest.main()
