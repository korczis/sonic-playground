"""Unit tests of scripts/youtube.py (YouTube's search and watch pages as data) on fixtures.

majordomus-skill: add-song

    python3 -m unittest test.test_youtube

test/fixtures/youtube/ holds small saved pages (the embedded JSON trimmed to what the parsers
read, stream addresses dropped), indexed by the module's own URL builders in index.json. No test
here reaches the network: the transport is exercised against a fake urlopen.
"""
import importlib.util
import io
import json
import sys
import tempfile
import unittest
import urllib.error
from datetime import timezone
from pathlib import Path
from typing import Any
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "test" / "fixtures" / "youtube"
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("youtube", ROOT / "scripts" / "youtube.py")
assert spec is not None and spec.loader is not None
yt: Any = importlib.util.module_from_spec(spec)
sys.modules["youtube"] = yt
spec.loader.exec_module(yt)


def player_page(player: dict) -> str:
    return "<script>var ytInitialPlayerResponse = " + json.dumps(player) + ";</script>"


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc) -> None:
        self.close()


def http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://www.youtube.com/watch?v=x", code, "x", {}, None)  # type: ignore[arg-type]


class Parsers(unittest.TestCase):
    def setUp(self):
        self.client = yt.YouTube(fixture=FIXTURE)

    def test_search_reads_videos_and_shorts(self):
        found = {r["id"]: r for r in self.client.search("MAINVIBE Lauter")}
        topic = found["WaxPYwst85k"]
        self.assertEqual((topic["title"], topic["channel"], topic["duration"]),
                         ("Lauter", "MAINVIBE - Topic", "2:45"))
        self.assertEqual(topic["channel_id"], "UCR5fAOifRz97WxIH5_22n9w")
        self.assertIn("Provided to YouTube by DistroKid", topic["snippet"])
        self.assertEqual(topic["views"], 192500)
        kenzler = found["eTrOJfm4ncY"]
        # Under Accept-Language: en YouTube's search serves a machine-translated title.
        self.assertEqual(kenzler["title"], "MAINVIBE – LOUDER (TOM KENZLER REMIX)")
        self.assertIn("Official Artist Channel", kenzler["badges"])
        self.assertEqual(kenzler["published"], "5d ago")
        short = found["iJxrEHv_RcM"]
        self.assertEqual((short["format"], short["title"], short["views"]),
                         ("short", "„Lauter“ von MAINVIBE – Electro Swing trifft Techno.", 3700))
        self.assertEqual(len(found), len(set(found)))

    def test_watch_reads_details_and_description_facts(self):
        w = self.client.watch("O23UZaT7GnY")
        self.assertEqual((w["title"], w["author"], w["seconds"], w["duration"]),
                         ("Lauter", "MAINVIBE - Topic", 164, "2:44"))
        self.assertEqual(w["publish_date"], "2026-11-27T11:01:19-08:00")
        self.assertTrue(w["playable"])
        facts = w["facts"]
        self.assertEqual(facts["provider"], "Universal Music Group")
        self.assertFalse(facts["diy"])
        self.assertEqual(facts["released"], "2026-11-12")
        self.assertTrue(facts["rights"].startswith("℗ 2026 Global Basss One Management"))
        self.assertEqual((facts["release_title"], facts["artists"]), ("Lauter", ["MAINVIBE"]))
        self.assertIn({"roles": ["Vocalist"], "name": "Caroline von Brünken"}, facts["credits"])
        self.assertTrue(self.client.watch("WaxPYwst85k")["facts"]["diy"])
        self.assertNotIn("credits", self.client.watch("eTrOJfm4ncY")["facts"])

    def test_a_watch_never_returns_or_requests_a_stream(self):
        player = {"videoDetails": {"videoId": "abcdefghijk", "title": "T", "author": "A",
                                   "lengthSeconds": "3723", "viewCount": "x"},
                  "streamingData": {"formats": [{"url": "https://rr1.googlevideo.com/videoplayback"}]},
                  "captions": {}, "storyboards": {}, "playabilityStatus": {"status": "OK"}}
        w = yt.parse_watch(player_page(player), "abcdefghijk")
        self.assertNotIn("googlevideo", json.dumps(w))
        self.assertEqual((w["duration"], w["views"]), ("1:02:03", None))
        with self.assertRaises(ValueError):
            yt.get("https://rr1.googlevideo.com/videoplayback?id=1")
        self.client.search("MAINVIBE Lauter")
        self.client.watch("DgC7FGgsm4A")
        self.assertTrue(all(u.startswith(yt.PAGES) for u in self.client.fetched))

    def test_an_unavailable_video_is_reported_not_raised(self):
        page = player_page({"playabilityStatus": {"status": "ERROR", "reason": "Video unavailable"}})
        w = yt.parse_watch(page, "abcdefghijk")
        self.assertEqual((w["id"], w["playable"], w["reason"], w["seconds"], w["duration"]),
                         ("abcdefghijk", False, "Video unavailable", None, ""))

    def test_pages_without_their_data_are_errors(self):
        with self.assertRaisesRegex(yt.YouTubeError, "consent wall"):
            yt.parse_search('<a href="https://consent.youtube.com/m">')
        with self.assertRaisesRegex(yt.YouTubeError, "no ytInitialData"):
            yt.parse_search("<html></html>")
        with self.assertRaisesRegex(yt.YouTubeError, "no ytInitialPlayerResponse"):
            yt.parse_watch("<html></html>", "abcdefghijk")
        self.assertIsNone(yt.embedded("var ytInitialData = {broken;", "ytInitialData"))
        self.assertEqual(yt.embedded('window["ytInitialData"] = {"a": 1};', "ytInitialData"),
                         {"a": 1})

    def test_search_skips_repeats_and_malformed_shorts(self):
        data = {"a": [{"videoRenderer": {"videoId": "abcdefghijk", "title": {"runs": [{"text": "x"}]}}},
                      {"videoRenderer": {"videoId": "abcdefghijk"}},
                      {"videoRenderer": {}},
                      {"shortsLockupViewModel": {"entityId": "shorts-shelf-item-abcdefghijk"}},
                      {"shortsLockupViewModel": {"entityId": "shorts-shelf-item-bad"}},
                      {"shortsLockupViewModel": {"entityId": "shorts-shelf-item-bcdefghijkl"}}]}
        found = yt.parse_search("var ytInitialData = " + json.dumps(data) + ";")
        self.assertEqual([r["id"] for r in found], ["abcdefghijk", "bcdefghijkl"])
        self.assertEqual(found[0]["channel"], "")

    def test_small_parsers(self):
        self.assertEqual(yt.views("No views"), 0)
        self.assertEqual(yt.views("1.2M views"), 1200000)
        self.assertIsNone(yt.views(""))
        self.assertEqual(yt.text(None), "")
        self.assertEqual(yt.text({"content": "c"}), "c")
        self.assertEqual(yt.description_facts("Just a video: with a colon"), {})

    def test_dates_are_the_artists_calendar_day(self):
        # 15:00 in California on 11 November is midnight in Germany on the 12th.
        self.assertEqual(yt.local_date("2026-11-11T15:00:08-08:00", "DE"), "2026-11-12")
        self.assertEqual(yt.local_date("2026-11-11T15:00:08-08:00"), "2026-11-11")
        self.assertEqual(yt.local_date("2026-11-11T15:00:08"), "2026-11-11")
        self.assertEqual(yt.local_date("yesterday"), "")
        self.assertIs(yt.country_zone("ZZ"), timezone.utc)
        with mock.patch.object(yt.zoneinfo, "TZPATH", ("/nonexistent",) + tuple(yt.zoneinfo.TZPATH)):
            self.assertEqual(str(yt.country_zone("DE")), "Europe/Berlin")

    def test_watch_refuses_what_is_not_an_id(self):
        with self.assertRaises(ValueError):
            self.client.watch("not an id")
        with self.assertRaisesRegex(yt.YouTubeError, "not in the fixture"):
            self.client.watch("zzzzzzzzzzz")


class Transport(unittest.TestCase):
    def setUp(self):
        sleep = mock.patch.object(yt.time, "sleep")
        self.sleep = sleep.start()
        self.addCleanup(sleep.stop)

    def test_headers_rate_limit_and_retry(self):
        calls = []

        def urlopen(request, timeout):
            calls.append(request)
            if len(calls) == 1:
                raise http_error(503)
            if len(calls) == 2:
                raise urllib.error.URLError("reset")
            return Response(b"<html>ok</html>")

        yt._last[0] = yt.time.monotonic()  # a request just ran: the next one waits
        with mock.patch.object(yt.urllib.request, "urlopen", urlopen):
            self.assertEqual(yt.get(yt.watch_url("abcdefghijk")), "<html>ok</html>")
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[0].get_header("Cookie"), "CONSENT=YES+1; SOCS=CAI")
        self.assertEqual(calls[0].get_header("Accept-language"), "en")
        self.assertTrue(self.sleep.called)

    def test_a_client_error_is_not_retried_and_a_dead_service_gives_up(self):
        with mock.patch.object(yt.urllib.request, "urlopen", side_effect=http_error(404)) as op:
            with self.assertRaisesRegex(yt.YouTubeError, "HTTP 404"):
                yt.get(yt.search_url("x"))
            self.assertEqual(op.call_count, 1)
        with mock.patch.object(yt.urllib.request, "urlopen", side_effect=TimeoutError()) as op:
            with self.assertRaisesRegex(yt.YouTubeError, "no answer after"):
                yt.get(yt.search_url("x"))
            self.assertEqual(op.call_count, yt.ATTEMPTS)


class Cache(unittest.TestCase):
    def test_pages_are_cached_with_their_time_and_refresh_rereads(self):
        page = (FIXTURE / "watch-DgC7FGgsm4A.html").read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "sub" / "youtube.json"
            with mock.patch.object(yt, "get", return_value=page) as get:
                first = yt.YouTube(cache=file)
                self.assertEqual(first.watch("DgC7FGgsm4A")["author"], "MAINVIBE")
                first.watch("DgC7FGgsm4A")  # read once per instance
                self.assertEqual(get.call_count, 1)
                stored = json.loads(file.read_text(encoding="utf-8"))
                url = yt.watch_url("DgC7FGgsm4A")
                self.assertIsInstance(stored[url]["at"], int)
                self.assertNotIn("streamingData", json.dumps(stored))
                second = yt.YouTube(cache=file)
                second.watch("DgC7FGgsm4A")
                self.assertEqual(get.call_count, 1)  # from the cache
                self.assertIsInstance(second.fetched_at(url), int)
                self.assertIsNone(second.fetched_at(yt.watch_url("zzzzzzzzzzz")))
                yt.YouTube(cache=file, refresh=True).watch("DgC7FGgsm4A")
                self.assertEqual(get.call_count, 2)

    def test_an_unreadable_cache_is_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "youtube.json"
            file.write_text("[1, 2]", encoding="utf-8")
            self.assertEqual(yt.read_cache(file), {})
            file.write_text("{not json", encoding="utf-8")
            self.assertEqual(yt.YouTube(cache=file).cache(), {})

    def test_a_fixture_never_reads_or_writes_the_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "youtube.json"
            client = yt.YouTube(fixture=FIXTURE, cache=file)
            client.watch("DgC7FGgsm4A")
            self.assertFalse(file.exists())
            self.assertIsInstance(client.fetched_at(yt.watch_url("DgC7FGgsm4A")), int)


if __name__ == "__main__":
    unittest.main()
