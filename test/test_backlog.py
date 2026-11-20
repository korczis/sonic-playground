"""Unit tests of scripts/backlog.py's Spotify source on fixtures: no account, no private data.

    python3 -m unittest discover -s test -p 'test_*.py'
"""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("backlog", ROOT / "scripts" / "backlog.py")
assert spec is not None and spec.loader is not None
backlog: Any = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backlog)


def track(id_, title, artists, liked=False, duration="3:30", status="missing", playlists=1):
    return {"id": id_, "title": title, "artists": artists, "album": "Album", "duration": duration,
            "liked": liked, "playlist_count": playlists, "record": f"data/spotify/tracks/{id_}.md",
            "status": status}


class SpotifyRows(unittest.TestCase):
    def rows(self, tracks, memberships=(), top=(), everything=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "tables").mkdir()
            (root / "tables" / "tracks.jsonl").write_text(
                "".join(json.dumps(t) + "\n" for t in tracks), encoding="utf-8")
            (root / "tables" / "memberships.jsonl").write_text(
                "".join(json.dumps(m) + "\n" for m in memberships), encoding="utf-8")
            (root / "index.json").write_text(json.dumps({"top": list(top)}), encoding="utf-8")
            return backlog.spotify_rows(root, everything)

    def test_ranked_by_the_owners_choice(self):
        rows = self.rows(
            [track("a-liked", "Liked", ["A"], liked=True),
             track("b-own", "Own", ["B"], liked=True),
             track("c-top", "Top", ["C"]),
             track("d-followed", "Followed", ["D"], playlists=5)],
            memberships=[{"kind": "own", "playlist": "mine", "track": "b-own"},
                         {"kind": "followed", "playlist": "theirs", "track": "d-followed"}],
            top=[{"record": "c-top", "rank": 3}])
        self.assertEqual([r["title"] for r in rows], ["Top", "Own", "Liked"])
        self.assertEqual([r["n"] for r in rows], [1, 2, 3])
        self.assertEqual(rows[0]["why"], "top #3")
        self.assertEqual(rows[1]["why"], "liked, mine")

    def test_followed_only_and_non_songs_need_all(self):
        tracks = [track("d-followed", "Followed", ["D"]),
                  track("e-interlude", "Interlude", ["E"], liked=True, duration="0:45"),
                  track("f-mix", "Continuous Mix", ["F"], liked=True, duration="1:10:05"),
                  track("g-reviewed", "Reviewed", ["G"], liked=True, status="present")]
        self.assertEqual(self.rows(tracks), [])
        self.assertEqual(sorted(r["title"] for r in self.rows(tracks, everything=True)),
                         ["Continuous Mix", "Followed", "Interlude"])

    def test_a_saved_album_does_not_fill_the_wave(self):
        rows = self.rows([track(f"k-{i}", f"K{i}", ["Khan"], liked=True) for i in range(3)]
                         + [track("z-1", "Z1", ["Zed"], liked=True)])
        self.assertEqual([r["artists"][0] for r in rows][:2], ["Khan", "Zed"])

    def test_a_skipped_item_needs_all(self):
        tracks = [track("r-story", "A Story, Pt. 1", ["Reader"], liked=True, status="skipped"),
                  track("r-song", "A Song", ["Reader"], liked=True)]
        self.assertEqual([r["title"] for r in self.rows(tracks)], ["A Song"])
        self.assertEqual(len(self.rows(tracks, everything=True)), 2)

    def test_rows_pass_the_backlog_check(self):
        rows = self.rows([track("f-mix", "Mix", ["F"], liked=True, duration="1:10:05")],
                         everything=True)
        self.assertEqual(backlog.check(rows), [])


if __name__ == "__main__":
    unittest.main()
