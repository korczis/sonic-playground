"""Any review can be a connection target.

The schema's pattern for extra.connections[].source admitted only [a-z0-9-], while 21 reviews
written before the slug rule carry underscores (bronski-beat_small_town_boy.md and others). Three
writers of the 2022/2021 yearbook waves had to drop the connection they meant and link the review
in prose instead (2026-11-14). The pattern is now proven against every review file name.
"""

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OLD_PATTERN = r"^[a-z0-9-]+\.md$"


def source_pattern() -> str:
    schema = json.loads((ROOT / "data/track.schema.json").read_text(encoding="utf-8"))
    found = []

    def walk(node):
        if isinstance(node, dict):
            conn = node.get("properties", {}).get("connections")
            if isinstance(conn, dict):
                found.append(conn["items"]["properties"]["source"]["pattern"])
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(schema)
    assert len(found) == 1, found
    return found[0]


def reviews() -> list[str]:
    return sorted(p.name for p in (ROOT / "content").glob("*.md")
                  if not p.name.startswith("_") and not p.name.endswith(".cs.md"))


class ConnectionTargets(unittest.TestCase):
    def test_every_review_file_name_can_be_a_connection_source(self):
        pattern = re.compile(source_pattern())
        self.assertGreater(len(reviews()), 300)
        self.assertEqual([name for name in reviews() if not pattern.match(name)], [])

    def test_negative_control_the_old_pattern_locks_reviews_out(self):
        old = re.compile(OLD_PATTERN)
        self.assertIn("bronski-beat_small_town_boy.md", [n for n in reviews() if not old.match(n)])

    def test_the_pattern_still_refuses_what_is_no_file_name(self):
        pattern = re.compile(source_pattern())
        for bad in ("../secret.md", "Upper.md", "a b.md", "review", "cs/x.md"):
            self.assertIsNone(pattern.match(bad), bad)


if __name__ == "__main__":
    unittest.main()
