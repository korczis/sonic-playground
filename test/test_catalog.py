"""Unit tests of scripts/catalog.py: the inference rules and the content contract.

    python3 -m unittest discover -s test -p 'test_*.py'
"""
import importlib.util
import sys
import tempfile
import unittest
from typing import Any
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("catalog", ROOT / "scripts" / "catalog.py")
assert spec is not None and spec.loader is not None
catalog: Any = importlib.util.module_from_spec(spec)
sys.modules["catalog"] = catalog
spec.loader.exec_module(catalog)

GOOD = """+++
title = "{title}"
date = "2024-10-06"
description = "A track with a long enough description to satisfy the contract."

[taxonomies]
genre = ["electronic", "house"]
sentiment = ["uplifting"]

[extra]
youtube = "https://www.youtube.com/embed/rVeMiVU77wo"
{extra}+++

Bakermat built The River on a saxophone hook (Lulu Rouge wrote Lulu's Theme, a fixture of the
artist override). """ + " ".join(f"detail{i}" for i in range(320)) + """
"""


class Inference(unittest.TestCase):
    def test_artist_dash_track(self):
        self.assertEqual(catalog.infer_artist_track("Bakermat - The River", "bakermat-the-river")[:2],
                         ("Bakermat", "The River"))

    def test_track_pipe_artist(self):
        self.assertEqual(catalog.infer_artist_track("Breezeblocks | alt-J (∆)", "alt-j-breezeblocks")[:2],
                         ("alt-J (∆)", "Breezeblocks"))

    def test_pipe_with_several_credits(self):
        self.assertEqual(
            catalog.infer_artist_track("Harder, Better | Daft Punk | Pomplamoose", "pomplamoose-x")[:2],
            ("Daft Punk, Pomplamoose", "Harder, Better"))

    def test_track_dash_artist_decided_by_file_name(self):
        artist, track, rule = catalog.infer_artist_track(
            "Time Has Changed (Remix) - Codec & Flexor", "codec-n-flexor-time-has-changed")
        self.assertEqual((artist, track), ("Codec & Flexor", "Time Has Changed (Remix)"))
        self.assertIn("file name", rule)

    def test_artist_from_file_name_when_title_has_no_separator(self):
        self.assertEqual(
            catalog.infer_artist_track("Soul Intoxication (Dub)", "bassement-freaks-soul-intoxication")[:2],
            ("Bassement Freaks", "Soul Intoxication (Dub)"))

    def test_slug_matches_zola(self):
        self.assertEqual(catalog.slugify("mélissa-laveaux_needle in the Hay"),
                         "melissa-laveaux-needle-in-the-hay")


class Contract(unittest.TestCase):
    def load(self, title="Bakermat - The River", extra="", name="bakermat-the-river.md"):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        content = Path(tmp.name)
        old = catalog.CONTENT
        catalog.CONTENT = content
        self.addCleanup(setattr, catalog, "CONTENT", old)
        path = content / name
        path.write_text(GOOD.format(title=title, extra=extra), encoding="utf-8")
        errors = []
        return catalog.load_track(path, errors), errors

    def test_good_article(self):
        track, errors = self.load()
        self.assertEqual(errors, [])
        self.assertEqual(track.facets["genre"], ["electronic", "house"])
        self.assertEqual(track.youtube_id, "rVeMiVU77wo")
        self.assertTrue(track.thumbnail.startswith("https://i.ytimg.com/vi/rVeMiVU77wo/"))
        self.assertEqual(track.path, "bakermat-the-river/")

    def test_unknown_extra_key(self):
        _, errors = self.load(extra='og_title = "x"\n')
        self.assertTrue(any("unknown key 'og_title'" in e for e in errors))

    def test_placeholder_host(self):
        _, errors = self.load(extra='album = "https://example.com/x"\n')
        self.assertTrue(any("placeholder host" in e for e in errors))

    def test_missing_cover_file(self):
        _, errors = self.load(extra='cover_image = "/images/nope.jpg"\n')
        self.assertTrue(any("cover_image" in e for e in errors))

    def test_uppercase_term_is_refused(self):
        tmp = GOOD.format(title="A - B", extra="").replace('genre = ["electronic", "house"]', 'genre = ["Electronic"]')
        errors = catalog.validate(__import__("tomllib").loads(tmp.split("+++")[1]), catalog.TRACK_SCHEMA)
        self.assertTrue(any("taxonomies.genre[0]" in e for e in errors))

    def test_unfinished_section_is_refused(self):
        _, errors = self.load(extra="")
        self.assertEqual(errors, [])
        track, errors = self.load(title="Bakermat - The River", extra="", name="unfinished.md")
        path = catalog.CONTENT / "unfinished.md"
        path.write_text(path.read_text(encoding="utf-8") + "\nTODO(write): more\n", encoding="utf-8")
        errors = []
        catalog.load_track(path, errors)
        self.assertTrue(any("TODO(write)" in e for e in errors))

    def test_word_split_across_lines_is_refused(self):
        _, errors = self.load()
        path = catalog.CONTENT / "bakermat-the-river.md"
        path.write_text(path.read_text(encoding="utf-8") + "\nThe track draws t\nhe listener in.\n", encoding="utf-8")
        errors = []
        catalog.load_track(path, errors)
        self.assertTrue(any("split across lines" in e for e in errors))

    def _append(self, text):
        _, errors = self.load()
        path = catalog.CONTENT / "bakermat-the-river.md"
        path.write_text(path.read_text(encoding="utf-8") + text, encoding="utf-8")
        errors = []
        catalog.load_track(path, errors)
        return errors

    def test_reproduced_lyrics_are_refused_fenced_or_not(self):
        # 2026-11-12: four reviews carried full lyrics, one inside a code fence
        verse = "\n".join(f"line {i} of a sung verse" for i in range(10))
        self.assertTrue(any("reproduced lyrics" in e for e in self._append("\n## Lyrics\n\n" + verse + "\n")))
        self.assertTrue(any("reproduced lyrics" in e for e in self._append("\n```\n" + verse + "\n```\n")))
        self.assertFalse(any("reproduced lyrics" in e for e in self._append("\n" + "- a short list item\n" * 10)))

    def test_educational_references_are_checked(self):
        errors = self._append('\nSee {{ <track_link source="no-such-review.md" /> }} and '
                              '{{ <concept_link name="sidechain compression" /> }}.\n')
        self.assertTrue(any("names no review" in e for e in errors))
        self.assertTrue(any("not in taxonomies.concept" in e for e in errors))
        self.assertTrue(any("not defined" in e for e in self._append('\n{{ <concept_link name="no such idea" /> }}\n')))

    def test_listen_for_needs_a_part_or_a_time(self):
        _, errors = self.load(extra='\n[extra.learning]\nlevel = "introductory"\nobjectives = ["Hear how a thing works in the song.", "Hear another thing that works there."]\n'
                                    'listen_for = [{ what = "the drums come in hard" }, { part = "intro", what = "a quiet pad" }, { at = "1:00", what = "the drop arrives" }]\n'
                                    'questions = ["What changes in the middle?", "Why does it end abruptly?"]\n')
        self.assertTrue(any("listen_for[0] needs a part" in e for e in errors))

    def test_a_review_file_name_is_ascii(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "mélissa-x.md"
            path.write_text(GOOD, encoding="utf-8")
            errors = []
            old = catalog.CONTENT
            catalog.CONTENT = Path(d)
            try:
                catalog.load_track(path, errors)
            finally:
                catalog.CONTENT = old
            self.assertTrue(any("must be ASCII" in e and "melissa-x.md" in e for e in errors), errors)

    def test_a_cliche_is_refused(self):
        self.assertTrue(any("would fit any track" in e for e in self._append("\nA sonic journey.\n")))

    def test_the_review_names_its_artist_and_track(self):
        _, errors = self.load(title="Someone Else - Another Song", name="someone-else-another-song.md")
        self.assertTrue(any("never names its artist (Someone Else)" in e for e in errors))
        self.assertTrue(any("never names its track (Another Song)" in e for e in errors))
        # the credit's first name is enough; a version in brackets is not required
        _, errors = self.load(title="Bakermat & Friends - The River (Extended Mix)")
        self.assertFalse(any("never names" in e for e in errors))

    def test_a_short_review_is_refused_unless_exempt(self):
        short = GOOD.split("+++")
        path_errors = []
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        old = catalog.CONTENT
        catalog.CONTENT = Path(tmp.name)
        self.addCleanup(setattr, catalog, "CONTENT", old)
        for exempt, refused in (("", True), ('edu_exempt = "no source describes it"\n', False)):
            path = catalog.CONTENT / "bakermat-the-river.md"
            path.write_text("+++" + short[1].format(title="Bakermat - The River", extra=exempt)
                            + "+++\n\nBakermat made The River.\n", encoding="utf-8")
            path_errors = []
            catalog.load_track(path, path_errors)
            self.assertEqual(any("a review has at least" in e for e in path_errors), refused, exempt)

    def test_one_song_one_review(self):
        a, _ = self.load()
        b, _ = self.load(name="bakermat-the-river-2.md")
        problems = catalog.uniqueness([a, b])
        self.assertTrue(any("the same artist and song" in p for p in problems))
        self.assertTrue(any("the same video" in p for p in problems))
        self.assertTrue(any("a paragraph is copied" in p for p in problems))
        self.assertEqual(catalog.uniqueness([a]), [])

    def test_artist_override(self):
        track, errors = self.load(title="Lulu's Theme", extra='artist = "Lulu Rouge"\n', name="x.md")
        self.assertEqual(errors, [])
        self.assertEqual(track.artist, "Lulu Rouge")


class Related(unittest.TestCase):
    def test_shared_terms_rank_and_explain(self):
        def t(source, genre, sentiment, when="2024-10-01"):
            return catalog.Track(source=source, path=source, title=source, artist="a", track=source,
                                 inferred="", date=when, description="", youtube_id=None,
                                 thumbnail="", thumbnail_local=False, words=1,
                                 facets={"genre": genre, "sentiment": sentiment, "mood": [], "tags": []})
        a = t("a", ["techno", "industrial"], ["intense"])
        b = t("b", ["techno", "industrial"], ["calm"])
        c = t("c", ["techno"], ["intense"])
        d = t("d", ["jazz"], ["calm"])
        rel = catalog.related([a, b, c, d])["a"]
        self.assertEqual([r["source"] for r in rel], ["b", "c"])
        self.assertEqual(rel[0]["shared"], ["genre:industrial", "genre:techno"])


class Repository(unittest.TestCase):
    def test_catalogue_is_current(self):
        errors = []
        text = catalog.render(catalog.build(errors))
        self.assertEqual(errors, [])
        self.assertEqual(text, catalog.OUTPUT.read_text(encoding="utf-8"),
                         "static/data/catalog.json is stale; run npm run derive")


if __name__ == "__main__":
    unittest.main()
