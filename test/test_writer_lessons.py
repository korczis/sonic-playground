# majordomus-skill: add-song
# majordomus-skill: import-yearbook
"""Lessons of the 2022 yearbook wave (2026-11-14), held by tests.

- A test that writes a "new" review uses a song nobody will ever write: Moderat - A New Error was
  the fixture of two tests and sat in the 2022 backlog, so both failed the day its review landed.
- Writers describe sound from sources only: three of seven song writers downloaded the videos'
  audio on their own, because the brief asked for a guide "timed against the embedded video".
"""

import importlib.util
import json
import re
import subprocess
import sys
import unittest
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("catalog", ROOT / "scripts" / "catalog.py")
assert spec is not None and spec.loader is not None
cat: Any = importlib.util.module_from_spec(spec)
sys.modules.setdefault("catalog", cat)
spec.loader.exec_module(cat)

# A call that must meet an existing review says so on its line.
NEW_CALL = re.compile(r'(?:track\.py new|run_new\(|track\.new,)\s*r?"([^"]+ - [^"]+)"'
                      r'(?!.*# fixture: an existing review)')
BRIEFS = [ROOT / ".claude/agents/song-writer.md", ROOT / ".ai/repo/skills/add-song/SKILL.md"]
INVITES_LISTENING = re.compile(r"timed against the (embedded )?video|in the embedded video"
                               r"|you hear there|cannot hear in the video")


def identity(text: str) -> tuple[str, str]:
    artist, track = text.split(" - ", 1)
    return cat.fold(artist), cat.fold(cat.song(track))


def known_songs() -> set[tuple[str, str]]:
    catalogue = json.loads((ROOT / "static/data/catalog.json").read_text(encoding="utf-8"))
    songs = {identity(f"{t['artist']} - {t['track']}") for t in catalogue["tracks"]}
    out = subprocess.run([sys.executable, str(ROOT / "scripts/backlog.py"), "--json"],
                         capture_output=True, text=True, check=True, cwd=ROOT).stdout
    for row in json.loads(out):
        for artist in [row["artist"], *row["artist"].split(", ")]:
            songs.add(identity(f"{artist} - {row['song']}"))
    return songs


def fixtures(texts: dict[str, str]) -> list[tuple[str, str]]:
    return [(name, m.group(1)) for name, text in texts.items() for m in NEW_CALL.finditer(text)]


def collisions(texts: dict[str, str], songs: set[tuple[str, str]]) -> list[str]:
    return [f"{name}: {song}" for name, song in fixtures(texts) if identity(song) in songs]


def test_texts() -> dict[str, str]:
    paths = sorted((ROOT / "test").glob("test_*.py")) + sorted((ROOT / "test/cases").glob("*.sh"))
    return {p.name: p.read_text(encoding="utf-8") for p in paths if p.name != Path(__file__).name}


class FixturesAreFictional(unittest.TestCase):
    def test_no_new_review_fixture_names_a_song_the_catalogue_or_backlog_holds(self):
        songs = known_songs()
        texts = test_texts()
        self.assertTrue(fixtures(texts), "no fixture found: the pattern is stale")
        self.assertEqual(collisions(texts, songs), [])

    def test_negative_control_the_old_fixture_is_refused(self):
        old = {"test_track.py": 'self.run_new("Moderat - A New Error", youtube="…")'}
        self.assertEqual(collisions(old, known_songs()), ["test_track.py: Moderat - A New Error"])


class WritersDescribeFromSources(unittest.TestCase):
    def test_every_writer_brief_forbids_downloading_and_never_invites_listening(self):
        for path in BRIEFS:
            text = re.sub(r"\s+", " ", path.read_text(encoding="utf-8"))
            with self.subTest(brief=path.name):
                self.assertIn("Never download", text)
                self.assertIsNone(INVITES_LISTENING.search(text))

    def test_negative_control_the_old_wording_is_refused(self):
        old = ("the learning guide timed against the embedded video",
               '(`at = "m:ss"` in the embedded video, `what` you hear there)')
        for text in old:
            self.assertIsNotNone(INVITES_LISTENING.search(text))


if __name__ == "__main__":
    unittest.main()
