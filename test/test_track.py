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
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("track", ROOT / "scripts" / "track.py")
track = importlib.util.module_from_spec(spec)
sys.modules["track"] = track
spec.loader.exec_module(track)
cat = track.cat


class Links(unittest.TestCase):
    def test_every_youtube_form(self):
        for url in ("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10",
                    "https://youtu.be/dQw4w9WgXcQ?si=x", "youtube.com/embed/dQw4w9WgXcQ",
                    "https://m.youtube.com/shorts/dQw4w9WgXcQ",
                    "https://music.youtube.com/watch?v=dQw4w9WgXcQ"):
            self.assertEqual(track.youtube_id(url), "dQw4w9WgXcQ", url)

    def test_names_are_not_links(self):
        self.assertIsNone(track.youtube_id("Moderat - A New Error"))
        self.assertIsNone(track.youtube_id("dQw4w9WgXcQ"))


class Names(unittest.TestCase):
    def test_decorations_dropped_remix_kept(self):
        self.assertEqual(track.split_name("Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)"),
                         ("Rick Astley", "Never Gonna Give You Up"))
        self.assertEqual(track.split_name("Louisahhh - Love Is a Punk (Vitalic Remix) [Official Audio]"),
                         ("Louisahhh", "Love Is a Punk (Vitalic Remix)"))

    def test_channel_is_the_artist_when_the_title_has_no_dash(self):
        self.assertEqual(track.split_name("alt-J (∆) Breezeblocks", "alt-J"), ("alt-J", "Breezeblocks"))
        self.assertEqual(track.split_name("Primitive", "Róisín Murphy - Topic"), ("Róisín Murphy", "Primitive"))


class NewArticle(unittest.TestCase):
    def run_new(self, text, **kw):
        args = argparse.Namespace(offline=True, youtube=None, artist=None, track=None,
                                  description=None, date="2026-01-02", dry_run=True, force=False,
                                  genre=["electronic"], sentiment=["hypnotic"], mood=None, tags=None)
        for k, v in kw.items():
            setattr(args, k, v)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = track.new(text, args)
        return code, json.loads(out.getvalue())

    def test_written_article_meets_the_contract_once_written(self):
        code, plan = self.run_new("Moderat - A New Error",
                                  youtube="https://youtu.be/dQw4w9WgXcQ")
        self.assertEqual(code, 0)
        self.assertEqual(plan["file"], "content/moderat-a-new-error.md")
        text = plan["preview"]
        self.assertIn('youtube = "https://www.youtube.com/embed/dQw4w9WgXcQ"', text)
        for section in plan["outline"]:
            self.assertIn(section.split()[0].capitalize(), text)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "moderat-a-new-error.md"
            path.write_text(text, encoding="utf-8")
            old = cat.CONTENT
            cat.CONTENT = Path(tmp)
            try:
                errors = []
                cat.load_track(path, errors)
                self.assertTrue(any("TODO(write)" in e for e in errors), "skeleton is unfinished")
                done = text.replace("TODO(write): ", "Written prose for this section. ")
                path.write_text(done, encoding="utf-8")
                errors = []
                result = cat.load_track(path, errors)
                self.assertEqual(errors, [])
                self.assertEqual((result.artist, result.track), ("Moderat", "A New Error"))
            finally:
                cat.CONTENT = old

    def test_existing_track_is_not_duplicated(self):
        code, plan = self.run_new("Bakermat - The River")
        self.assertEqual(code, 3)
        self.assertEqual(plan["exists"]["source"], "content/bakermat-the-river.md")


if __name__ == "__main__":
    unittest.main()
