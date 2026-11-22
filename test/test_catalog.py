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

    def test_the_owners_listening_is_refused_in_prose_and_front_matter(self):
        # 2026-11-22: 36 reviews and their translations said why the owner listened to them
        said = "never about the owner's listening"
        errors = self._append("\nIt is here because it was among the owner's most played songs of 2022.\n")
        self.assertTrue(any(said in e and "the body" in e for e in errors), errors)
        _, errors = self.load(extra='edu_exempt = "Nothing documents this remix beyond the owner\'s playlist."\n')
        self.assertTrue(any(said in e and "extra.edu_exempt" in e for e in errors), errors)
        self.assertFalse(any(said in e for e in self._append("\nIt is the duo's most played song.\n")))

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

    def test_a_version_is_the_same_song_a_remix_is_not(self):
        same = {"Sugar (feat. Francesco Yates) - Extended Mix": "Sugar",
                "Time - 2011 Remastered Version": "Time", "Battery - Remastered": "Battery",
                "Song (2009 Digital Remaster)": "Song", "Makeba - Radio Edit": "Makeba",
                "Hello - Single Version": "Hello",
                "Seven Nation Army - Remasterisée": "Seven Nation Army",
                "The beat goes on - Original": "The beat goes on",
                "Eastern City Lights (Bonus Track)": "Eastern City Lights",
                "Crazy (Noze Remix) - Mixed": "Crazy (Noze Remix)",
                "Giant (with Rag'n'Bone Man)": "Giant", "Dancing with Myself": "Dancing with Myself"}
        for title, expected in same.items():
            self.assertEqual(catalog.song(title), expected, title)
        self.assertEqual(catalog.song("Around (Solomun Vox) [Moodymann Edit] - Mixed"),
                         "Around (Solomun Vox) [Moodymann Edit]")
        for title in ("Kids with Guns - Hot Chip Remix", "Odessa (Junior Boys Mix)",
                      "Around - Moodymann Edit"):
            self.assertEqual(catalog.song(title), title)

    def test_a_credit_matches_in_any_order(self):
        index = catalog.identity_index([{"source": "alok-hear-me-now.md", "track": "Hear Me Now",
                                         "artist": "Alok, Zeeba, Bruno Martini"}])
        item = {"title": "Hear Me Now", "artists": ["Alok", "Bruno Martini", "Zeeba"]}
        self.assertEqual(catalog.resolve_item(item, index)["source"], "alok-hear-me-now.md")

    def test_the_lead_artist_is_a_last_resort(self):
        index = catalog.identity_index([{"source": "stimming.md", "track": "November Morning",
                                         "artist": "Stimming, David Christensen, Bernd Ruf"}])
        item = {"title": "November Morning", "artists": ["Stimming"]}
        self.assertEqual(catalog.resolve_item(item, index)["by"], "lead artist and song")
        index = catalog.identity_index([
            {"source": "a.md", "track": "Song", "artist": "Lead, One"},
            {"source": "b.md", "track": "Song", "artist": "Lead, Two"}])
        self.assertEqual(catalog.resolve_item({"title": "Song", "artists": ["Lead"]}, index)["status"],
                         "missing")

    def test_another_title_of_the_recording_matches(self):
        track, errors = self.load(extra='titles = ["The Stream"]\n', name="x.md")
        self.assertEqual(errors, [])
        index = catalog.identity_index([track])
        item = {"title": "The Stream", "artists": [track.artist]}
        self.assertEqual(catalog.resolve_item(item, index)["status"], "present")

    def test_artist_override(self):
        track, errors = self.load(title="Lulu's Theme", extra='artist = "Lulu Rouge"\n', name="x.md")
        self.assertEqual(errors, [])
        self.assertEqual(track.artist, "Lulu Rouge")


class OwnerListening(unittest.TestCase):
    """catalog.owner_listening: the owner named outright next to a listening word, nothing else."""
    REFUSED = [
        "It is here because it was among the owner's most played songs of 2022.",
        "It is here as one of the owner's songs of 2018.",
        "a vinyl repress seven years later, and a place in the owner's yearbook.",
        "It is here because it stayed in the owner's yearbook.",
        "beyond the owner's playlist, so nothing about its sound could be sourced.",
        "It is on this playground because it is among the owner's top songs of 2017.",
        "It is on this playground because it is in the owner's listening.",
        "It is here because the owner played it often enough for it to make a yearbook.",
        "This page keeps the credit as the owner's Spotify yearbook gives it.",
        "The site owner’s favourite track of the summer.",
        "Je tady proto, že patřila k nejposlouchanějším skladbám majitele v roce 2021.",
        "Je tu proto, že patřila k písním, které majitel v roce 2022 poslouchal nejčastěji.",
        "Je tu jako jedna z majitelových písní roku 2019.",
        "Je tu jako jedna z písní majitele z roku 2018.",
        "Je tu proto, že zůstal v ročence majitele.",
        "Na tomto webu je proto, že patří k tomu, co majitel poslouchá.",
        "Je tu proto, že ji majitel pouštěl tak často, až se dostala do ročenky.",
        "Spotify ročenka majitele tohoto webu ji uvádí jako Manila (Radio Edit).",
        "Patří do playlistu vlastníka stránek.",
    ]
    ACCEPTED = [
        "Soundcharts singles out Rafale as the track that stood out; it is the duo's most played song.",
        "The hook is light enough for a summer playlist and moving enough to stick.",
        "BBC Radio 1 put the single on its A-list playlist for six weeks.",
        "Henneberg works in Berlin as a producer, label owner, mastering engineer and DJ.",
        "Knight, the owner of her label Juana, recorded her debut album.",
        "Robin Schulz shared his remix as a free download, which upset the song's copyright owner.",
        "The Owner plays its hook twice; play The Owner and wait for the chorus.",
        "Do You Like That Song? still named The Owner among the pair's excellent songs.",
        "Soundcharts lists it among her top songs.",
        "Je to nejposlouchanější píseň dua.",
        "Hook je dost lehký pro letní playlist a dost dojemný, aby utkvěl.",
        "Rádio ji zařadilo do svého playlistu na šest týdnů.",
        "Henneberg tam působí jako producent, majitel labelu a DJ.",
        "Coververze ukazuje, co přežije, když píseň změní majitele.",
        "Paape je jedním z majitelů labelu Kompakt.",
    ]

    def test_the_owners_listening_is_found(self):
        for text in self.REFUSED:
            self.assertTrue(catalog.owner_listening(text), text)

    def test_other_owners_and_other_playlists_are_not(self):
        for text in self.ACCEPTED:
            self.assertEqual(catalog.owner_listening(text), [], text)


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


class GenreFamilies(unittest.TestCase):
    """data/genres.toml groups the genre terms; the catalogue derives each family's tracks."""

    @staticmethod
    def t(source, genre):
        return catalog.Track(source=source, path=source, title=source, artist="a", track=source,
                             inferred="", date="2024-10-01", description="", youtube_id=None,
                             thumbnail="", thumbnail_local=False, words=1,
                             facets={"genre": genre, "sentiment": [], "mood": [], "tags": []})

    FAMILIES = [
        {"id": "techno", "en": "Techno", "cs": "Techno", "terms": ["techno", "minimal"]},
        {"id": "bass", "en": "Bass", "cs": "Bass", "terms": ["drum and bass", "jungle"]},
        {"id": "electronic", "en": "Electronic", "cs": "Elektronika", "umbrella": True,
         "terms": ["electronic"]},
    ]

    def test_a_track_counts_once_and_umbrella_families_come_last(self):
        tracks = [self.t("a", ["electronic", "techno", "minimal"]), self.t("b", ["electronic", "jungle"]),
                  self.t("c", ["electronic", "drum and bass", "jungle"]), self.t("d", ["electronic"])]
        notes: list[str] = []
        fams = catalog.genre_families(tracks, self.FAMILIES, notes)
        self.assertEqual([(f["id"], f["count"]) for f in fams], [("bass", 2), ("techno", 1), ("electronic", 4)])
        self.assertEqual([x["term"] for x in fams[0]["terms"]], ["jungle", "drum and bass"])
        self.assertEqual(notes, [])

    def test_an_unlisted_term_is_placed_by_inference_and_reported(self):
        tracks = [self.t("a", ["jungle", "ragga jungle"]), self.t("b", ["techno"])]
        notes: list[str] = []
        fams = {f["id"]: f for f in catalog.genre_families(tracks, self.FAMILIES, notes)}
        placed = {x["term"]: x for x in fams["bass"]["terms"]}
        self.assertTrue(placed["ragga jungle"]["inferred"])
        self.assertEqual(len(notes), 1)
        self.assertIn("ragga jungle", notes[0])

    def test_every_term_in_use_is_written_in_a_family(self):
        # The repository's own corpus: no genre is left to inference (add it to data/genres.toml).
        errors: list[str] = []
        families = catalog.load_genre_families(errors)
        self.assertEqual(errors, [])
        data = catalog.build([])
        inferred = [x["term"] for f in data["genre_families"] for x in f["terms"] if x.get("inferred")]
        self.assertEqual(inferred, [], "add these genres to data/genres.toml")
        self.assertEqual({f["id"] for f in data["genre_families"]} - {f["id"] for f in families}, set())


class Repository(unittest.TestCase):
    def test_catalogue_is_current(self):
        errors = []
        text = catalog.render(catalog.build(errors))
        self.assertEqual(errors, [])
        self.assertEqual(text, catalog.OUTPUT.read_text(encoding="utf-8"),
                         "static/data/catalog.json is stale; run npm run derive")


if __name__ == "__main__":
    unittest.main()
