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
import unittest.mock

# Prose that meets the contract's length and names its recording (rule educational-article).
PROSE = ("Fixture Artist built Fixture Song on a slow pulse. "
         + " ".join(f"detail{i}" for i in range(320)))
# A song no review will ever be about (test_writer_lessons holds it).
NEW_FILE = "fixture-artist-fixture-song.md"
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
        self.assertIsNone(track.youtube_id("Fixture Artist - Fixture Song"))
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
                plan = track.resolve("Fixture Artist - Fixture Song", namespace())
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
                path = Path(tmp) / NEW_FILE
                path.write_text(
                    '+++\ntitle = "Fixture Artist - Fixture Song"\ndate = "2026-01-02"\n'
                    'description = "A slow-burning electronic piece with a hypnotic pulse."\n\n'
                    '[extra]\nyoutube = "https://www.youtube.com/embed/dQw4w9WgXcQ"\n\n'
                    '[taxonomies]\ngenre = ["electronic"]\nsentiment = ["hypnotic"]\n+++\n\n' + PROSE + '\n',
                    encoding="utf-8")
                code, report = capture(track.refresh, str(path), argparse.Namespace(
                    youtube=None, album="III", release_year="2016", publisher=None))
                self.assertEqual(code, 0, report)
                meta = tomllib.loads(path.read_text().split("+++")[1])
                self.assertEqual((meta["extra"]["album"], meta["extra"]["release_year"]), ("III", "2016"))
                self.assertIn(PROSE, path.read_text())
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
        code, plan = self.run_new("Fixture Artist - Fixture Song", youtube="https://youtu.be/dQw4w9WgXcQ")
        self.assertEqual(code, 0)
        self.assertEqual(plan["file"], "content/fixture-artist-fixture-song.md")
        text = plan["preview"]
        self.assertIn('youtube = "https://www.youtube.com/embed/dQw4w9WgXcQ"', text)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / NEW_FILE
            path.write_text(text, encoding="utf-8")
            old = cat.CONTENT
            cat.CONTENT = Path(tmp)
            try:
                errors = []
                cat.load_track(path, errors)
                self.assertTrue(any("TODO(write)" in e for e in errors), "skeleton is unfinished")
                written = text.replace("TODO(write): ", "Written prose. ")
                path.write_text(written + "\n" + PROSE + "\n", encoding="utf-8")
                errors = []
                result = cat.load_track(path, errors)
                self.assertEqual(errors, [])
                self.assertEqual((result.artist, result.track), ("Fixture Artist", "Fixture Song"))
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
        code, plan = self.run_new("Bakermat - The River")  # fixture: an existing review
        self.assertEqual(code, 3)
        self.assertEqual(plan["exists"]["source"], "content/bakermat-the-river.md")

    def test_a_draft_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = cat.CONTENT
            cat.CONTENT = Path(tmp)
            try:
                (Path(tmp) / NEW_FILE).write_text(
                    '+++\ntitle = "Fixture Artist - Fixture Song"\ndraft = true\n+++\nprose\n',
                    encoding="utf-8")
                code, plan = self.run_new("Fixture Artist - Fixture Song")
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
                code, plan = capture(track.new, "Fixture Artist - Fixture Song",
                                     namespace(dry_run=False))
                self.assertEqual(code, 0)
                code, report = capture(track.check, str(Path(tmp) / NEW_FILE))
                self.assertEqual(code, 1)
                self.assertGreater(report["unfinished"], 0)
                code, report = capture(track.refresh, str(Path(tmp) / NEW_FILE),
                                       argparse.Namespace(youtube="https://youtu.be/dQw4w9WgXcQ",
                                                          album="Moderat III", release_year=None,
                                                          publisher=None))
                self.assertEqual(code, 0)
                meta = tomllib.loads((Path(tmp) / NEW_FILE).read_text().split("+++")[1])
                self.assertEqual(meta["extra"]["album"], "Moderat III")
                self.assertTrue(meta["extra"]["youtube"].endswith("dQw4w9WgXcQ"))
            finally:
                cat.CONTENT = old
        with self.assertRaises(SystemExit):
            with contextlib.redirect_stderr(io.StringIO()):
                track.check("README.md")


class Cli(unittest.TestCase):
    def test_a_repeated_facet_flag_adds_terms(self):
        import subprocess
        out = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "track.py"), "new", "Nobody Atall - Test Song",
             "--offline", "--genre", "house", "--genre", "techno", "disco", "--sentiment", "calm",
             "--dry-run"], capture_output=True, text=True, check=True, cwd=ROOT)
        terms = [r["term"] for r in json.loads(out.stdout)["facets"]["genre"]]
        self.assertEqual(terms, ["house", "techno", "disco"])



# --- versions: the song's family on YouTube, from the saved pages of test/fixtures/youtube. ----

YT_FIXTURE = str(ROOT / "test" / "fixtures" / "youtube")
LAUTER = ROOT / "content" / "mainvibe-lauter.md"
# A review of the fixture's song: its own video and the self-release listed, nothing else.
VERSIONS_PAGE = (
    '+++\ntitle = "MAINVIBE - Lauter"\ndate = "2026-11-28"\n'
    'description = "A fixture review of an electro-swing single and its versions on YouTube."\n\n'
    '[taxonomies]\ngenre = ["electronic"]\nsentiment = ["playful"]\n\n'
    '[extra]\ncountry = "DE"\nyoutube = "https://www.youtube.com/embed/DgC7FGgsm4A"\n\n'
    '[[extra.versions]]\nkind = "official-video"\ntitle = "MAINVIBE – Lauter | Electro Swing meets Techno"\n'
    'by = "MAINVIBE"\nyoutube = "DgC7FGgsm4A"\nformat = "video"\nduration = "2:45"\n'
    'date = "2026-11-12"\n\n'
    '[[extra.versions]]\nkind = "self-release"\ntitle = "Lauter"\nby = "MAINVIBE"\n'
    'youtube = "WaxPYwst85k"\nformat = "audio"\nduration = "2:45"\ndate = "2026-11-12"\n'
    'rights = "℗ MAINVIBE"\n+++\n\n'
    "MAINVIBE built Lauter on a swing loop. " + " ".join(f"detail{i}" for i in range(320)) + "\n")


def versions_args(**kw):
    args = argparse.Namespace(file=None, query=None, json=True, write=False, pick=None,
                              verify=False, all=False, refresh=False, youtube_fixture=YT_FIXTURE)
    for k, v in kw.items():
        setattr(args, k, v)
    return args


def run_quiet(fn, *a) -> tuple[int, Any, str]:
    """fn's exit code, stdout as JSON (or text) and stderr."""
    buf, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(err):
        code = fn(*a)
    text = buf.getvalue()
    try:
        return code, json.loads(text), err.getvalue()
    except ValueError:
        return code, text, err.getvalue()


class VersionsPage(unittest.TestCase):
    """A scratch content/ with the fixture review in it."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        old = cat.CONTENT
        cat.CONTENT = Path(tmp.name)
        self.addCleanup(setattr, cat, "CONTENT", old)
        self.page = Path(tmp.name) / "mainvibe-lauter.md"
        self.page.write_text(VERSIONS_PAGE, encoding="utf-8")

    def versions(self, **kw):
        return run_quiet(track.versions, versions_args(file=str(self.page), **kw))

    def meta(self):
        return tomllib.loads(self.page.read_text(encoding="utf-8").split("+++")[1])


class VersionsOfLauter(unittest.TestCase):
    def test_the_lauter_page_lists_what_the_tool_finds(self):
        # The hand-made list of content/mainvibe-lauter.md, rediscovered from the saved pages:
        # every listed version the fixture can show is found, with the kind it was given.
        code, report, _ = run_quiet(track.versions, versions_args(file=str(LAUTER)))
        self.assertEqual(code, 0)
        found = {c["entry"]["youtube"]: c for c in report["candidates"]}
        index = json.loads((Path(YT_FIXTURE) / "index.json").read_text(encoding="utf-8"))
        watched = {k.rsplit("=", 1)[1] for k in index if "watch?v=" in k}
        listed = [v for v in tomllib.loads(LAUTER.read_text(encoding="utf-8").split("+++")[1])
                  ["extra"]["versions"] if v.get("youtube") in watched]
        self.assertGreaterEqual(len(listed), 10)
        for v in listed:
            c = found[v["youtube"]]
            self.assertTrue(c["in_page"], v["youtube"])
            self.assertEqual(c["suggested_kind"], v["kind"], v["youtube"])
            self.assertEqual(c["differs"], [], v["youtube"])


class VersionsDiscovery(VersionsPage):
    def test_candidates_kinds_reasons_and_what_is_left_out(self):
        code, report, _ = self.versions()
        self.assertEqual(code, 0)
        self.assertEqual(report["file"], "content/mainvibe-lauter.md")
        found = {c["entry"]["youtube"]: c for c in report["candidates"]}
        self.assertEqual([c["in_page"] for c in report["candidates"][:2]], [True, True])
        licensed = found["O23UZaT7GnY"]
        self.assertEqual((licensed["suggested_kind"], licensed["confidence"]),
                         ("licensed-release", "high"))
        self.assertEqual(licensed["entry"]["date"], "2026-11-12")
        self.assertEqual(licensed["date_source"], "the description's Released on")
        self.assertEqual(licensed["views"]["note"],
                         "a snapshot of YouTube's counter, not a fact for the page")
        video = found["DgC7FGgsm4A"]
        self.assertEqual(video["entry"]["date"], "2026-11-12")  # midnight in Germany
        self.assertEqual(video["date_source"], "the upload time in DE")
        kenzler = found["eTrOJfm4ncY"]  # search says LOUDER, the watch page the real title
        self.assertEqual((kenzler["entry"]["title"], kenzler["entry"]["by"]),
                         ("MAINVIBE – LAUTER (TOM KENZLER REMIX)", "Tom Kenzler"))
        self.assertEqual(found["zjGvlMUKGYc"]["entry"]["by"], "NVKLɅS")
        short = found["iJxrEHv_RcM"]
        self.assertEqual((short["suggested_kind"], short["entry"]["format"], short["entry"]["url"]),
                         ("excerpt", "short", "https://www.youtube.com/shorts/iJxrEHv_RcM"))
        unread = found["ShHUgWj6yS0"]  # no watch page in the fixture
        self.assertEqual(unread["confidence"], "low")
        self.assertIn("could not be read", unread["reasons"][-1])
        self.assertEqual(report["listed_not_found"], [])
        self.assertIn("the title does not name the song", report["rejected"])
        self.assertIn("neither title nor channel names the artist", report["rejected"])
        failed = [q for q in report["queries"] if "error" in q]
        self.assertEqual([q["query"] for q in failed], ["MAINVIBE Lauter cover"])

    def test_a_result_only_its_description_ties_to_the_song_is_left_out(self):
        # A search snippet may name the song (so the result is read), the video itself not.
        search = {"contents": {"itemSectionRenderer": {"contents": [{"videoRenderer": {
            "videoId": "abcdefghijk", "title": {"runs": [{"text": "MAINVIBE - Blumenkorb"}]},
            "ownerText": {"runs": [{"text": "MAINVIBE"}]},
            "detailedMetadataSnippets": [{"snippetText": {"runs": [{"text": "after Lauter"}]}}]}}]}}}
        watch = {"videoDetails": {"videoId": "abcdefghijk", "title": "MAINVIBE - Blumenkorb",
                                  "author": "MAINVIBE", "lengthSeconds": "155"}}
        with tempfile.TemporaryDirectory() as tmp:
            index = {track.yt.search_url(q): "s.html"
                     for q in track.version_queries("MAINVIBE", "Lauter", [])}
            index[track.yt.watch_url("abcdefghijk")] = "w.html"
            (Path(tmp) / "index.json").write_text(json.dumps(index), encoding="utf-8")
            (Path(tmp) / "s.html").write_text(
                "var ytInitialData = " + json.dumps(search) + ";", encoding="utf-8")
            (Path(tmp) / "w.html").write_text(
                "var ytInitialPlayerResponse = " + json.dumps(watch) + ";", encoding="utf-8")
            code, report, _ = self.versions(youtube_fixture=tmp)
        self.assertEqual(code, 0)
        self.assertEqual(report["candidates"], [])
        self.assertEqual(report["rejected"], {"only the description names the song": 1})
        self.assertEqual(sorted(report["listed_not_found"]), ["DgC7FGgsm4A", "WaxPYwst85k"])

    def test_searches_that_give_nothing_exit_4(self):
        # Every query failed or found nothing: no evidence about the song's versions, not "none".
        with tempfile.TemporaryDirectory() as tmp:
            empty = (Path(YT_FIXTURE) / "search-empty.html").read_text(encoding="utf-8")
            (Path(tmp) / "empty.html").write_text(empty, encoding="utf-8")
            index = {track.yt.search_url("MAINVIBE Lauter"): "empty.html"}
            (Path(tmp) / "index.json").write_text(json.dumps(index), encoding="utf-8")
            code, report, err = self.versions(youtube_fixture=tmp)
            self.assertEqual(code, 4)
            self.assertEqual(report["candidates"], [])
            self.assertIn("6 of 7 queries failed", err)
            self.assertIn("first error: not in the fixture", err)
            index = {track.yt.search_url(q): "empty.html"
                     for q in track.version_queries("MAINVIBE", "Lauter", [])}
            (Path(tmp) / "index.json").write_text(json.dumps(index), encoding="utf-8")
            code, _, err = self.versions(youtube_fixture=tmp)
            self.assertEqual(code, 4)
            self.assertIn("0 of 7 queries failed, the rest returned no results", err)

    def test_the_human_report(self):
        text = VERSIONS_PAGE.replace('title = "Lauter"\nby', 'title = "Lauter (old)"\nby')
        text = text.replace('rights = "℗ MAINVIBE"\n', 'rights = "℗ MAINVIBE"\n\n'
                            '[[extra.versions]]\nkind = "cover"\ntitle = "Gone"\nby = "Someone"\n'
                            'youtube = "zzzzzzzzzzz"\n')
        self.page.write_text(text, encoding="utf-8")
        code, out, _ = self.versions(json=False, query=["MAINVIBE Lauter remix"])
        self.assertEqual(code, 0)
        self.assertIn("listed self-release", out)
        self.assertIn("differs: title listed 'Lauter (old)', YouTube 'Lauter'", out)
        self.assertIn("listed but not found by the searches: zzzzzzzzzzz", out)
        self.assertIn("left out:", out)
        self.assertIn("query 'MAINVIBE Lauter cover' failed", out)

    def test_a_review_without_a_video_and_a_watch_that_fails(self):
        self.page.write_text(VERSIONS_PAGE.replace(
            'youtube = "https://www.youtube.com/embed/DgC7FGgsm4A"\n', ""), encoding="utf-8")
        t = cat.load_track(self.page, [], include_drafts=True)
        client = track.yt.YouTube(fixture=YT_FIXTURE)
        self.assertEqual(track.own_channel_of(t, client), "")
        t.youtube_id = "zzzzzzzzzzz"
        self.assertEqual(track.own_channel_of(t, client), "")

    def test_main_runs_the_subcommand(self):
        argv = ["track.py", "versions", str(self.page), "--json", "--youtube-fixture", YT_FIXTURE]
        buf = io.StringIO()
        with unittest.mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(buf):
            self.assertEqual(track.main(), 0)
        self.assertIn("candidates", json.loads(buf.getvalue()))


class VersionsWrite(VersionsPage):
    def test_picks_are_appended_as_tables_without_notes(self):
        code, result, err = self.versions(write=True, pick=["O23UZaT7GnY", "uDpzHhUbegA:official-remix",
                                                            "HhW9lPMJdjs"])
        self.assertEqual(code, 0, result)
        self.assertTrue(result["written"])
        versions = self.meta()["extra"]["versions"]
        self.assertEqual([v["youtube"] for v in versions],
                         ["DgC7FGgsm4A", "WaxPYwst85k", "O23UZaT7GnY", "uDpzHhUbegA", "HhW9lPMJdjs"])
        licensed = versions[2]
        self.assertEqual((licensed["kind"], licensed["format"], licensed["duration"], licensed["date"]),
                         ("licensed-release", "audio", "2:44", "2026-11-12"))
        self.assertTrue(licensed["rights"].startswith("℗ 2026"))
        self.assertTrue(all("note" not in v for v in versions))
        self.assertIn("translate.py status", err)
        self.assertIn("MAINVIBE built Lauter", self.page.read_text(encoding="utf-8"))

    def test_a_pick_outside_the_searches_is_read_on_its_own(self):
        with unittest.mock.patch.object(track, "discover", return_value={"candidates": []}):
            code, result, _ = self.versions(write=True, pick=["LFZDZ8d-NFo"])
        self.assertEqual(code, 0, result)
        added = result["added"][0]
        self.assertEqual((added["kind"], added["by"], added["duration"]), ("remix", "Andy Sossna", "3:22"))

    def test_a_video_youtube_does_not_play_is_not_written(self):
        gone = {"id": "LFZDZ8d-NFo", "title": "Lauter - (MAINVIBE) Andy Sossna Remix", "author": "Andy Sossna",
                "channel_id": "", "seconds": 202, "duration": "3:22", "facts": {}, "publish_date": "",
                "playable": False, "reason": "Video unavailable", "views": None, "short": False}
        with unittest.mock.patch.object(track, "discover", return_value={"candidates": []}), \
                unittest.mock.patch.object(track.yt.YouTube, "watch", return_value=gone):
            code, result, _ = self.versions(write=True, pick=["LFZDZ8d-NFo"])
        self.assertEqual(code, 1, result)
        self.assertIn("does not play it (Video unavailable)", " ".join(result["errors"]))

    def test_refusals_write_nothing(self):
        before = self.page.read_text(encoding="utf-8")
        cases = {
            "already in extra.versions": ["WaxPYwst85k"],
            "not a YouTube video id": ["nope"],
            "not in the fixture": ["zzzzzzzzzzz"],
            "is not one of": ["O23UZaT7GnY:bootleg"],
        }
        for why, picks in cases.items():
            code, result, _ = self.versions(write=True, pick=picks)
            self.assertEqual(code, 1, why)
            self.assertIn(why, " ".join(result["errors"]))
        code, result, _ = self.versions(write=True, pick=["O23UZaT7GnY", "O23UZaT7GnY"])
        self.assertIn("already in extra.versions", result["errors"][0])
        self.assertEqual(self.page.read_text(encoding="utf-8"), before)

    def test_a_write_the_contract_refuses_is_not_written(self):
        # Without the page's own video among them the contract refuses a list of versions.
        text = VERSIONS_PAGE.split("[[extra.versions]]")[0].rstrip() + "\n+++\n\nprose\n"
        self.page.write_text(text, encoding="utf-8")
        code, result, _ = self.versions(write=True, pick=["O23UZaT7GnY"])
        self.assertEqual(code, 1)
        self.assertTrue(any("own video" in e for e in result["errors"]), result)
        self.assertEqual(self.page.read_text(encoding="utf-8"), text)

    def test_a_rewrite_that_does_not_end_with_the_picks_is_refused(self):
        with unittest.mock.patch.object(track, "toml_tables", return_value=""):
            errors = track.write_versions(self.page, "content/x.md", [{"kind": "cover"}])
        self.assertIn("does not end with the picked versions", errors[0])

    def test_toml_tables(self):
        text = track.toml_tables("extra.versions", [{"kind": "remix", "title": 'A "b"', "x": None},
                                                    {"kind": "dance"}])
        self.assertEqual(tomllib.loads(text)["extra"]["versions"],
                         [{"kind": "remix", "title": 'A "b"'}, {"kind": "dance"}])


class VersionsVerify(VersionsPage):
    def test_a_page_that_matches_youtube_passes(self):
        code, report, _ = self.versions(verify=True)
        self.assertEqual(code, 0, report)
        self.assertEqual((report["verified"][0]["checked"], report["diffs"]), (2, 0))

    def test_every_difference_is_reported_and_fails(self):
        text = (VERSIONS_PAGE.replace('duration = "2:45"\ndate = "2026-11-12"\n\n',
                                      'duration = "2:55"\ndate = "2026-11-11"\n\n', 1)
                .replace('title = "Lauter"\nby = "MAINVIBE"', 'title = "Lauter"\nby = "Somebody"'))
        text = text.replace('rights = "℗ MAINVIBE"\n', 'rights = "℗ MAINVIBE"\n\n'
                            '[[extra.versions]]\nkind = "remix"\ntitle = "Gone"\nby = "Someone"\n'
                            'youtube = "zzzzzzzzzzz"\n\n'
                            '[[extra.versions]]\nkind = "remix"\ntitle = "Elsewhere"\nby = "Someone"\n'
                            'url = "https://example.org/remix"\n')
        self.page.write_text(text, encoding="utf-8")
        code, report, err = self.versions(verify=True)
        self.assertEqual(code, 1)
        fields = sorted((d["youtube"], d["field"]) for d in report["verified"][0]["diffs"])
        self.assertEqual(fields, [("DgC7FGgsm4A", "date"), ("DgC7FGgsm4A", "duration"),
                                  ("WaxPYwst85k", "by"), ("zzzzzzzzzzz", "available")])
        self.assertIn("YouTube says", err)

    def test_a_listed_id_that_is_no_video_id_is_a_difference(self):
        self.page.write_text(VERSIONS_PAGE.replace('youtube = "WaxPYwst85k"', 'youtube = "not an id"'),
                             encoding="utf-8")
        code, report, _ = self.versions(verify=True)
        self.assertEqual(code, 1)
        diff = report["verified"][0]["diffs"][0]
        self.assertEqual((diff["youtube"], diff["field"]), ("not an id", "available"))
        self.assertIn("not a YouTube video id", diff["youtube_says"])

    def test_a_review_that_does_not_load_fails_the_verification(self):
        # 2026-11-28 review: a broken front matter was skipped and the run reported 0 diffs.
        broken = self.page.with_name("broken-page.md")
        broken.write_text("+++\ntitle = \n+++\n", encoding="utf-8")
        code, report, err = run_quiet(track.versions, versions_args(verify=True, all=True))
        self.assertEqual(code, 1)
        self.assertEqual((report["diffs"], report["failures"]), (0, 1))
        self.assertEqual(report["unloadable"][0]["file"], "content/broken-page.md")
        self.assertIn("does not load, not verified", err)
        code, report, _ = run_quiet(track.versions, versions_args(verify=True, file=str(broken)))
        self.assertEqual(code, 1)
        self.assertTrue(report["unloadable"][0]["errors"])
        with unittest.mock.patch.object(track.cat, "load_track", return_value=None):
            code, report, _ = run_quiet(track.versions, versions_args(verify=True, file=str(broken)))
        self.assertEqual(report["unloadable"][0]["errors"], ["the review does not load"])

    def test_an_unplayable_video_is_a_difference(self):
        with tempfile.TemporaryDirectory() as tmp:
            index = {track.yt.watch_url(v): f"{v}.html" for v in ("DgC7FGgsm4A", "WaxPYwst85k")}
            (Path(tmp) / "index.json").write_text(json.dumps(index), encoding="utf-8")
            for v in ("DgC7FGgsm4A", "WaxPYwst85k"):
                (Path(tmp) / f"{v}.html").write_text(
                    'var ytInitialPlayerResponse = {"playabilityStatus": {"status": "ERROR"}};',
                    encoding="utf-8")
            code, report, _ = self.versions(verify=True, youtube_fixture=tmp)
        self.assertEqual(code, 1)
        self.assertEqual({d["youtube_says"] for d in report["verified"][0]["diffs"]}, {"not playable"})

    def test_all_reviews(self):
        code, report, _ = run_quiet(track.versions, versions_args(verify=True, all=True))
        self.assertEqual(code, 0, report)
        self.assertEqual([r["file"] for r in report["verified"]], ["content/mainvibe-lauter.md"])

    def test_usage_errors(self):
        for kw in ({"all": True}, {}, {"file": str(self.page), "write": True}):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                track.versions(versions_args(**kw))
        self.page.write_text("+++\ntitle = \n+++\n", encoding="utf-8")
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            track.versions(versions_args(file=str(self.page)))


class VersionsHeuristic(unittest.TestCase):
    def test_kind_rules(self):
        def kind(title, channel="Someone", artist=False, seconds=200, short=False, facts=None):
            return track.suggest_kind(title, channel, artist, seconds, short, facts or {})[0]

        self.assertEqual(kind("Song (Live at KEXP)"), "live")
        self.assertEqual(kind("Song - piano cover"), "cover")
        self.assertEqual(kind("Song", seconds=30), "excerpt")
        self.assertEqual(kind("Song (Deichbrecher Edit)"), "edit")
        self.assertEqual(kind("Song (Extended Mix)"), "extended")
        self.assertEqual(kind("Song", channel="Artist - Topic"), "original")
        self.assertIsNone(kind("Song"))
        self.assertEqual(kind("Song", artist=True), "official-video")

    def test_names_and_credits(self):
        self.assertTrue(track.names_song("Linedance Lauter MAINVIBE", "Lauter"))
        self.assertFalse(track.names_song("Lautersound", "Lauter"))
        self.assertFalse(track.names_song("x", "你好"))
        self.assertEqual(track.credited_by("Song (Jane Doe Remix)", "Jane Doe"), "Jane Doe")
        self.assertEqual(track.credited_by("Song (Jane Doe Remix)", "Label"), "Jane Doe")
        self.assertEqual(track.credited_by("Song by Jane Doe", "Label | Jane Doe"), "Jane Doe")
        self.assertEqual(track.credited_by("Song", "Label | Jane Doe"), "Label | Jane Doe")
        self.assertEqual(track.version_queries("A feat. B", "S", ["A S"]),
                         ["A S", "A S remix", "A S edit", "A S extended", "A S live", "A S cover",
                          "A S line dance"])

    def test_differences(self):
        diffs = track.version_diffs({"title": "T", "by": "Tom Kenzler", "duration": "2:45",
                                     "kind": "remix", "date": "2026-01-01"},
                                    {"title": "T", "by": "TOM KENZLER", "duration": "2:44",
                                     "kind": "edit", "date": None})
        self.assertEqual(diffs, [{"field": "kind", "listed": "remix", "youtube": "edit",
                                  "chosen": True}])


if __name__ == "__main__":
    unittest.main()


class VersionTitles(unittest.TestCase):
    def test_a_title_drops_its_emoji_and_keeps_its_letters(self):
        self.assertEqual(track.display_title("🔥 MAINVIBE – Lauter (Force Techno Remix 2026) 🔥 FREE DL"),
                         "MAINVIBE – Lauter (Force Techno Remix 2026) FREE DL")
        self.assertEqual(track.display_title("Mainvibe - Lauter (NVKLΛS Remix)"),
                         "Mainvibe - Lauter (NVKLΛS Remix)")
        self.assertEqual(track.display_title("„Lauter“ von MAINVIBE ❤️ tanzen"), "„Lauter“ von MAINVIBE tanzen")
