"""The weekly link probe asks every cited source (scripts/probe-links.py).

An independent review (2026-11-14) found it read only the links of the review bodies: 8 of the
808 external URLs of content/, while the 800 cited sources in extra.sources were never asked.
"""

import importlib.util
import io
import re
import sys
import tempfile
import tomllib
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("probe_links", ROOT / "scripts" / "probe-links.py")
assert SPEC and SPEC.loader
probe_links = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe_links)

REVIEW = """+++
title = "Artist - Track"
[extra]
youtube = "https://www.youtube.com/watch?v=abcdefghijk"
[[extra.sources]]
title = "A review"
url = "https://example.org/dead-citation"
+++
Body with [a link](https://example.org/body-link).
"""


class ProbeLinks(unittest.TestCase):
    def test_every_cited_source_is_probed(self):
        found = probe_links.links()
        cited = set()
        for path in (ROOT / "content").rglob("*.md"):
            match = re.match(r"\A\+\+\+\r?\n(.*?)\r?\n\+\+\+", path.read_text(encoding="utf-8"), re.S)
            if match:
                extra = tomllib.loads(match.group(1)).get("extra", {})
                cited |= {s["url"] for s in extra.get("sources", []) if s.get("url")}
        self.assertGreater(len(cited), 100)
        self.assertEqual(sorted(cited - set(found)), [])

    def test_a_dead_citation_fails_the_probe(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "content").mkdir()
            (Path(tmp) / "content" / "artist-track.md").write_text(REVIEW, encoding="utf-8")
            found = probe_links.links(Path(tmp))
            self.assertEqual(sorted(found), ["https://example.org/body-link", "https://example.org/dead-citation"])
            out = io.StringIO()
            with mock.patch.object(probe_links, "links", lambda: found), \
                    mock.patch.object(probe_links, "probe", lambda url: 404 if "dead" in url else 200), \
                    mock.patch.object(sys, "argv", ["probe-links.py"]), redirect_stdout(out):
                code = probe_links.main()
            self.assertEqual(code, 1)
            self.assertIn("dead (404): https://example.org/dead-citation", out.getvalue())

    def test_the_video_is_left_to_probe_videos(self):
        self.assertEqual(probe_links.front_urls(tomllib.loads(REVIEW.split("+++")[1])),
                         ["https://example.org/dead-citation"])

    def test_a_refusal_is_about_the_client_and_fails_nothing(self):
        found = {"https://earmilk.com/a": ["a.md"], "https://en.wikipedia.org/wiki/A": ["b.md"],
                 "https://ok.example/": ["c.md"]}
        codes = {"https://earmilk.com/a": 403, "https://en.wikipedia.org/wiki/A": 429,
                 "https://ok.example/": 200}
        out = io.StringIO()
        with mock.patch.object(probe_links, "links", lambda: found), \
                mock.patch.object(probe_links, "probe", codes.__getitem__), \
                mock.patch.object(sys, "argv", ["probe-links.py"]), redirect_stdout(out):
            self.assertEqual(probe_links.main(), 0)
        self.assertIn("refused (403) by earmilk.com: 1 link(s)", out.getvalue())
        self.assertIn("refused (429) by en.wikipedia.org: 1 link(s)", out.getvalue())
        self.assertIn("3 external links, 0 dead, 2 refused", out.getvalue())

    def test_what_a_removed_page_answers_is_dead(self):
        for code in (0, 404, 410, 400, 500, 503):
            self.assertEqual(probe_links.verdict(code), "dead", code)
        for code in (200, 204, 301, 302):
            self.assertEqual(probe_links.verdict(code), "ok", code)

    def test_one_host_is_asked_one_request_at_a_time(self):
        lock, active, most = __import__("threading").Lock(), [0], [0]
        def one(url):
            with lock:
                active[0] += 1
                most[0] = max(most[0], active[0])
            __import__("time").sleep(0.01)
            with lock:
                active[0] -= 1
            return 200
        urls = [f"https://en.wikipedia.org/wiki/{i}" for i in range(12)]
        gaps = []
        codes = probe_links.probe_all(urls, one, sleep=gaps.append)
        self.assertEqual(set(codes.values()), {200})
        self.assertEqual(most[0], 1)
        self.assertEqual(gaps, [probe_links.PACE_S] * 11)

    def test_a_429_is_asked_again_after_its_retry_after(self):
        answers = iter([(429, 7.0), (429, None), (200, None)])
        waits = []
        with mock.patch.object(probe_links, "ask", lambda url: next(answers)):
            self.assertEqual(probe_links.probe("https://en.wikipedia.org/wiki/A", sleep=waits.append), 200)
        self.assertEqual(waits, [7.0, 4.0])

    def test_a_url_is_asked_as_a_browser_sends_it(self):
        self.assertEqual(probe_links.as_uri("https://en.wikipedia.org/wiki/Lunático"),
                         "https://en.wikipedia.org/wiki/Lun%C3%A1tico")
        for url in ("https://en.wikipedia.org/wiki/%C3%B7_(album)", "https://www.last.fm/music/S.R.+Krebs/+wiki",
                    "https://serato.com/playlists/id:5137077/7-12-15", "https://x.example/a?b=c&d=e%20f"):
            self.assertEqual(probe_links.as_uri(url), url)
        self.assertEqual(probe_links.as_uri("https://bücher.example/a#top"), "https://xn--bcher-kva.example/a")

    def test_a_retry_after_is_bounded(self):
        answers = iter([(429, 3600.0)] * (probe_links.RETRIES + 1))
        waits = []
        with mock.patch.object(probe_links, "ask", lambda url: next(answers)):
            self.assertEqual(probe_links.probe("https://x.example/", sleep=waits.append), 429)
        self.assertEqual(waits, [probe_links.RETRY_CAP_S] * probe_links.RETRIES)

if __name__ == "__main__":
    unittest.main()
