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

    def test_a_guarded_host_is_matched_by_host_not_by_substring(self):
        for url in ("https://www.discogs.com/release/1", "https://x.com/a", "https://www.juno.co.uk/reviews/x/"):
            self.assertTrue(probe_links.guarded(url), url)
        for url in ("https://www.dropbox.com/s/a", "https://www.netflix.com/title/1",
                    "https://example.org/see-discogs.com", "https://notjuno.co.uk/"):
            self.assertFalse(probe_links.guarded(url), url)

    def test_a_guarded_hosts_refusal_is_not_dead_but_its_404_is(self):
        found = {"https://www.juno.co.uk/r/": ["a.md"], "https://www.dropbox.com/s/": ["b.md"],
                 "https://www.discogs.com/gone": ["c.md"]}
        codes = {"https://www.juno.co.uk/r/": 403, "https://www.dropbox.com/s/": 403,
                 "https://www.discogs.com/gone": 404}
        out = io.StringIO()
        with mock.patch.object(probe_links, "links", lambda: found), \
                mock.patch.object(probe_links, "probe", codes.__getitem__), \
                mock.patch.object(sys, "argv", ["probe-links.py"]), redirect_stdout(out):
            self.assertEqual(probe_links.main(), 1)
        self.assertNotIn("juno", out.getvalue())
        self.assertIn("dead (403): https://www.dropbox.com/s/", out.getvalue())
        self.assertIn("dead (404): https://www.discogs.com/gone", out.getvalue())


if __name__ == "__main__":
    unittest.main()
