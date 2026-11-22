"""Unit tests of scripts/track.py's MusicBrainz identity: which recording and release a review
is about (enrich) and which written ids look wrong (audit-mb). No network: every MusicBrainz
answer is a fixture keyed by the URL track.py asks.

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
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("track", ROOT / "scripts" / "track.py")
assert spec is not None and spec.loader is not None
track: Any = importlib.util.module_from_spec(spec)
sys.modules["track"] = track
spec.loader.exec_module(track)
cat = track.cat

ARTIST = "5f6ab597-f57a-40da-be9e-adad48708203"
OTHER = "b95ce3ff-3d05-4e87-9e01-c97b66af13d4"
NEW_FILE = "fixture-artist-fixture-song.md"
PROSE = ("Fixture Artist built Fixture Song on a slow pulse. "
         + " ".join(f"detail{i}" for i in range(320)))


def uuid(n: int) -> str:
    return f"{n:08x}-0000-4000-8000-000000000000"


def release(n, title, date="1999-11-16", status="Official", types=(), country="US",
            disambiguation="", primary="Album", various=False):
    credit = [{"name": "Various Artists", "artist": {"id": track.VARIOUS,
                                                     "name": "Various Artists"}}] if various else []
    return {"id": uuid(n), "title": title, "date": date, "status": status, "country": country,
            "disambiguation": disambiguation, "artist-credit": credit,
            "release-group": {"primary-type": primary, "secondary-types": list(types)}}


def recording(n, releases, title="Fixture Song", length: int | None = 222, disambiguation="",
              video=False, isrcs=(), artist="Fixture Artist", artist_id=ARTIST, credits=None):
    return {"id": uuid(n), "score": 100, "title": title, "disambiguation": disambiguation,
            "length": length * 1000 if length else None, "video": video, "isrcs": list(isrcs),
            "artist-credit": credits or [{"name": artist, "artist": {"id": artist_id,
                                                                    "name": artist}}],
            "releases": releases}


def facts(albums=("Album",), duration: int | None = 222, source="spotify",
          track_title="Fixture Song", artist="Fixture Artist"):
    return {"artist": artist, "track": track_title, "albums": list(albums),
            "album_source": "page" if albums else "", "duration": duration,
            "duration_source": source if duration else "", "country": "US", "notes": []}


ALBUM = release(100, "Album")
ALBUM_EU = release(101, "Album", date="1999", country="XE")
INSTRUMENTAL = release(102, "Album Instrumental", date="1999")
BEST_OF = release(103, "Best of the Year", date="2000-08-15", types=["Compilation"],
                  various=True)
DJ_MIX = release(104, "Chapter 171", date="", status="", types=["DJ-mix"])
LIVE = release(105, "Up in Smoke Tour", date="2000", types=["Live"])
BOOTLEG = release(106, "After the Goldrush", date="2008", status="Bootleg",
                  types=["DJ-mix", "Mixtape/Street"])
PROMO = release(107, "Promo Only: Radio", date="2000-04", status="Promotion",
                types=["Compilation"])


class Markers(unittest.TestCase):
    def test_a_marker_counts_only_where_the_review_does_not_name_it(self):
        self.assertEqual(track.marks("Song (live, 2000: Up in Smoke Tour)", "Song"), {"live"})
        self.assertEqual(track.marks("Song (Live)", "Song (Live)"), set())
        self.assertEqual(track.marks("Live Forever", "Live Forever"), set())
        self.assertEqual(track.marks("part of a “Mix” DJ‐mix", "Song"), {"dj-mix"})
        self.assertEqual(track.marks("64 second excerpt", "Song"), {"excerpt"})

    def test_release_flags(self):
        self.assertEqual(track.release_flags(ALBUM, ["Album"]), [])
        self.assertEqual(track.release_flags(INSTRUMENTAL, ["Album"]), ["instrumental"])
        self.assertEqual(track.release_flags(LIVE, ["Album"]), ["live"])
        self.assertEqual(track.release_flags(BOOTLEG, []), ["bootleg", "dj-mix"])
        self.assertEqual(track.release_flags(PROMO, []), ["promotion"])
        # A review of the live or instrumental version keeps such releases.
        self.assertEqual(track.release_flags(LIVE, ["Up in Smoke Tour"], "Song (Live)"), [])
        self.assertEqual(track.release_flags(INSTRUMENTAL, [], "Song (Instrumental)"), [])

    def test_partial_dates_sort_after_full_dates_of_their_year(self):
        self.assertLess(track.date_key("1999-11-16"), track.date_key("1999"))
        self.assertLess(track.date_key("1999"), track.date_key("2000-01-01"))
        self.assertEqual(track.date_key(""), "9999-99-99")

    def test_durations(self):
        self.assertEqual(track.seconds("3:42"), 222)
        self.assertEqual(track.seconds("1:02:03"), 3723)
        self.assertIsNone(track.seconds("soon"))
        self.assertEqual(track.mmss(222), "3:42")


class PickRelease(unittest.TestCase):
    def test_the_album_earliest_full_date_and_the_artists_country(self):
        twin = release(99, "Album", country="CA")
        later = release(98, "Album", date="2003-08-25", country="GB")
        rel = track.pick_release([later, ALBUM_EU, INSTRUMENTAL, BEST_OF, twin, ALBUM],
                                 ["Album"], "US")
        self.assertEqual(rel["release"], ALBUM["id"])

    def test_pressings_that_tie_are_one_release(self):
        twin = release(200, "Album")
        rel = track.pick_release([twin, ALBUM], ["Album"], "US")
        self.assertEqual(rel["release"], ALBUM["id"])  # the lowest id, every time

    def test_edition_qualifiers_match_after_the_exact_title(self):
        deluxe = release(120, "Album (Deluxe Edition)", date="1998")
        self.assertEqual(track.pick_release([deluxe], ["Album"])["release"], deluxe["id"])
        self.assertEqual(track.pick_release([deluxe, ALBUM], ["Album"])["release"], ALBUM["id"])

    def test_an_album_no_release_names_is_left_out(self):
        rel = track.pick_release([INSTRUMENTAL, BEST_OF], ["Album"], "US")
        self.assertEqual(rel["release"], "")
        self.assertIn("'Album'", rel["why"])

    def test_without_an_album(self):
        single = release(130, "Fixture Song", date="1999-10-01", primary="Single")
        self.assertEqual(track.pick_release([ALBUM, single, BEST_OF], [])["release"],
                         single["id"])
        only = track.pick_release([BEST_OF, PROMO, DJ_MIX], [])
        self.assertEqual(only["release"], "")
        self.assertIn("compilations", only["why"])
        tie = track.pick_release([ALBUM, release(131, "Other", primary="Album")], [])
        self.assertEqual(tie["release"], "")
        self.assertIn("tie", tie["why"])


class Candidates(unittest.TestCase):
    def test_versions_videos_and_lengths_are_rejected(self):
        found = [
            recording(1, [ALBUM, ALBUM_EU, BEST_OF], length=223),
            recording(2, [DJ_MIX], length=64),
            recording(3, [LIVE], length=0, disambiguation="live, 2000: Up in Smoke Tour"),
            recording(4, [ALBUM], video=True),
            recording(5, [BOOTLEG], length=90),
            recording(6, [INSTRUMENTAL], title="Fixture Song (instrumental)"),  # another title
            recording(7, [ALBUM], length=180),
            recording(8, [ALBUM], artist="Somebody Else", artist_id=OTHER),
        ]
        kept, rejected = track.mb_candidates(found, facts())
        self.assertEqual([c["id"] for c in kept], [uuid(1)])
        self.assertEqual(rejected, {
            "only on live, DJ-mix, instrumental or bootleg releases": 2, "live": 1, "video": 1,
            "length off 3:42": 1})

    def test_a_compilation_only_ranks(self):
        on_best_of = recording(1, [BEST_OF], length=222)
        on_album = recording(2, [ALBUM], length=222)
        kept, rejected = track.mb_candidates([on_best_of, on_album], facts(albums=()))
        self.assertEqual([c["id"] for c in kept], [uuid(2), uuid(1)])
        self.assertEqual(rejected, {})
        kept, _ = track.mb_candidates([on_best_of], facts(albums=()))
        self.assertEqual([c["id"] for c in kept], [uuid(1)])

    def test_the_album_outranks_the_length(self):
        single = recording(1, [release(140, "Fixture Song", primary="Single")], length=222)
        album = recording(2, [ALBUM], length=None)
        kept, _ = track.mb_candidates([single, album], facts())
        self.assertEqual(kept[0]["id"], uuid(2))

    def test_a_review_of_the_live_version_keeps_live_recordings(self):
        live = recording(1, [LIVE], title="Fixture Song (Live)", length=None,
                         disambiguation="live, 2000")
        kept, rejected = track.mb_candidates(
            [live], facts(albums=["Up in Smoke Tour"], track_title="Fixture Song (Live)"))
        self.assertEqual([c["id"] for c in kept], [uuid(1)])
        self.assertEqual(rejected, {})

    def test_a_video_duration_is_only_a_hint(self):
        long_intro = recording(1, [ALBUM], length=222)
        kept, rejected = track.mb_candidates([long_intro], facts(duration=300, source="video"))
        self.assertEqual(len(kept), 1)
        self.assertFalse(kept[0]["fits"])


class Match(unittest.TestCase):
    def match(self, f, found, releases=None, artist=None):
        q = (f"recording:{track.mb_quote(track.song_title(f['track']))} "
             f"AND artist:{track.mb_quote(track.main_artist(f['artist']))}")
        answers = {track.mb_search_url(q, 50): {"recordings": found}}
        for rec, rels in (releases or {}).items():
            answers[track.mb_releases_url(rec)] = {"releases": rels}
        answers[track.MB + f"artist/{ARTIST}?fmt=json"] = artist or {"country": "US"}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tmp:
            json.dump(answers, tmp)
        self.addCleanup(Path(tmp.name).unlink)
        return track.mb_match(f, argparse.Namespace(mb_fixture=tmp.name))

    def test_the_album_recording_and_release(self):
        found = [recording(2, [DJ_MIX], length=64),
                 recording(1, [ALBUM_EU, INSTRUMENTAL], length=223, isrcs=["USIR19915077"])]
        m = self.match(facts(), found, {uuid(1): [ALBUM_EU, ALBUM, INSTRUMENTAL, BEST_OF]})
        self.assertEqual(m["status"], "matched")
        self.assertEqual((m["recording"], m["release"]), (uuid(1), ALBUM["id"]))
        self.assertEqual((m["artist"], m["isrc"], m["year"]), (ARTIST, ["USIR19915077"], "1999"))
        self.assertEqual(m["evidence"], "album")

    def test_candidates_nothing_tells_apart_are_ambiguous(self):
        found = [recording(1, [ALBUM], length=None), recording(2, [ALBUM_EU], length=None)]
        m = self.match(facts(albums=(), duration=None), found)
        self.assertEqual(m["status"], "ambiguous")
        self.assertIn("2 recordings", m["why"])

    def test_a_length_alone_never_proves_a_loose_credit(self):
        credits = [{"name": "Fixture Artistry", "artist": {"id": OTHER,
                                                           "name": "Fixture Artistry"}}]
        found = [recording(1, [ALBUM], length=222, credits=credits)]
        m = self.match(facts(albums=()), found)
        self.assertEqual(m["status"], "ambiguous")
        self.assertIn("by name", m["why"])

    def test_a_release_it_cannot_single_out_is_left_out(self):
        found = [recording(1, [ALBUM], length=222)]
        m = self.match(facts(albums=["Another Album"]), found, {uuid(1): [ALBUM, BEST_OF]})
        self.assertEqual(m["status"], "matched")
        self.assertEqual(m["release"], "")
        self.assertTrue(any("release left out" in n for n in m["notes"]))


class SpotifyFacts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        (base / "tables").mkdir()
        rows = [{"review": "a.md", "title": "Song", "album": "Album", "duration": "3:42"},
                {"review": "a.md", "title": "Song - Instrumental Version",
                 "album": "Album Instrumental", "duration": "3:29"},
                {"review": "b.md", "title": "Song", "album": "Album", "duration": "3:42"},
                {"review": "b.md", "title": "Song", "album": "Single", "duration": "4:30"}]
        (base / "tables" / "tracks.jsonl").write_text(
            "".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
        self.old = track.SPOTIFY
        track.SPOTIFY = base
        self.addCleanup(setattr, track, "SPOTIFY", self.old)

    def test_the_song_itself_gives_the_duration(self):
        self.assertEqual(track.spotify_facts("a.md", "Song"),
                         {"albums": ["Album"], "duration": 222})

    def test_disagreeing_durations_give_none(self):
        got = track.spotify_facts("b.md", "Song")
        self.assertNotIn("duration", got)
        self.assertIn("disagree", got["note"])

    def test_no_rows_no_facts(self):
        self.assertEqual(track.spotify_facts("c.md", "Song"), {"albums": []})


class AuditFlags(unittest.TestCase):
    IDS = {"recording": uuid(1), "artist": ARTIST, "release": ALBUM["id"],
           "isrc": "USIR19915077"}

    def flags(self, rec, releases, rel, member: bool | None = True, f=None, ids=None):
        return [(x["field"], x["kind"]) for x in track.mb_flags(
            f or facts(), ids or self.IDS, rec, releases, rel, member)]

    def test_right_ids_are_not_flagged(self):
        rec = recording(1, [], length=223, isrcs=["USIR19915077"])
        self.assertEqual(self.flags(rec, [ALBUM, BEST_OF], ALBUM), [])

    def test_a_dj_mix_excerpt_on_a_compilation(self):
        rec = recording(1, [], length=64, disambiguation="part of a “Mix” DJ‐mix")
        got = self.flags(rec, [DJ_MIX], DJ_MIX)
        self.assertEqual(got, [("recording", "length"), ("recording", "version"),
                               ("recording", "only-on"), ("isrc", "isrc"),
                               ("release", "release-version"), ("release", "album")])

    def test_the_instrumental_album_and_another_artist(self):
        rec = recording(1, [], length=223, isrcs=["USIR19915077"])
        got = self.flags(rec, [ALBUM, INSTRUMENTAL], INSTRUMENTAL,
                         ids={**self.IDS, "artist": OTHER})
        self.assertEqual(got, [("artist", "artist"), ("release", "release-version"),
                               ("release", "album")])

    def test_a_release_without_the_recording_and_a_missing_recording(self):
        rec = recording(1, [], length=223, isrcs=["USIR19915077"])
        self.assertEqual(self.flags(rec, [], ALBUM, member=False),
                         [("release", "not-of-recording")])
        self.assertEqual(self.flags({}, [], None, member=None), [("recording", "missing")])

    def test_a_compilation_when_the_review_names_no_album(self):
        rec = recording(1, [], length=223, isrcs=["USIR19915077"])
        got = self.flags(rec, [ALBUM, BEST_OF], BEST_OF, f=facts(albums=()))
        self.assertEqual(got, [("release", "compilation")])


class AuditCommand(unittest.TestCase):
    """audit-mb end to end on a page in a temporary content/: reports, and writes only with
    --fix, only the unambiguous correction."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.old = cat.CONTENT, track.SPOTIFY
        cat.CONTENT = Path(self.tmp.name)
        track.SPOTIFY = Path(self.tmp.name) / "no-spotify"
        self.addCleanup(self.restore)
        args = argparse.Namespace(offline=True, oembed_fixture=None, youtube=None, artist=None,
                                  track=None, date="2026-01-02", dry_run=False, force=False,
                                  description="A fixture page about a song that does not exist.",
                                  genre=["electronic"], sentiment=["hypnotic"], mood=None,
                                  tags=None)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(track.new("Fixture Artist - Fixture Song", args), 0)
        self.page = cat.CONTENT / NEW_FILE
        text = self.page.read_text(encoding="utf-8").replace("TODO(write): ", "Prose. ")
        self.page.write_text(text + "\n" + PROSE + "\n", encoding="utf-8")
        mb = {"recording": uuid(1), "artist": ARTIST, "release": INSTRUMENTAL["id"]}
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(track.write_extra(self.page, NEW_FILE,
                                               {"album": "Album", "musicbrainz": mb}), 0)

    def restore(self):
        cat.CONTENT, track.SPOTIFY = self.old

    def audit(self, fix):
        rec = recording(1, [], length=223, isrcs=["USIR19915077"])
        answers = {track.mb_recording_url(uuid(1)): rec,
                   track.mb_releases_url(uuid(1)): {"releases": [INSTRUMENTAL, ALBUM, BEST_OF]}}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tmp:
            json.dump(answers, tmp)
        self.addCleanup(Path(tmp.name).unlink)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = track.audit_mb([str(self.page)], argparse.Namespace(
                fix=fix, mb_fixture=tmp.name, offline=True))
        return code, json.loads(out.getvalue()), err.getvalue()

    def extra(self):
        return tomllib.loads(self.page.read_text(encoding="utf-8").split("+++")[1])["extra"]

    def test_report_then_fix(self):
        code, report, err = self.audit(fix=False)
        self.assertEqual(code, 0)
        self.assertEqual(report["counts"]["flagged"], 1)
        entry = report["flagged"][0]
        self.assertEqual({f["kind"] for f in entry["flags"]}, {"release-version", "album"})
        self.assertEqual(entry["proposed"]["musicbrainz"]["release"], ALBUM["id"])
        self.assertIn("1 flagged", err)
        self.assertEqual(self.extra()["musicbrainz"]["release"], INSTRUMENTAL["id"])  # report only
        code, report, _ = self.audit(fix=True)
        self.assertEqual(code, 0)
        self.assertTrue(report["flagged"][0]["fixed"])
        self.assertEqual(self.extra()["musicbrainz"],
                         {"recording": uuid(1), "artist": ARTIST, "release": ALBUM["id"]})
        _, report, _ = self.audit(fix=False)
        self.assertEqual(report["counts"]["ok"], 1)

    def test_offline_without_cache_is_unreachable_not_an_error(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            old = track.MB_CACHE
            track.MB_CACHE = Path(self.tmp.name) / "empty-cache.json"
            try:
                code = track.audit_mb([str(self.page)], argparse.Namespace(
                    fix=False, mb_fixture=None, offline=True))
            finally:
                track.MB_CACHE = old
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue())["counts"]["unreachable"], 1)


if __name__ == "__main__":
    unittest.main()
