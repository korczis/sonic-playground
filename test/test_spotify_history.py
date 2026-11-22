"""Unit tests of scripts/spotify_history.py on fixtures: no network, no account, no private data.

majordomus-skill: import-spotify-history

    python3 -m unittest discover -s test -p 'test_*.py'
"""
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("spotify_history", ROOT / "scripts" / "spotify_history.py")
assert spec is not None and spec.loader is not None
sh: Any = importlib.util.module_from_spec(spec)
sys.modules["spotify_history"] = sh
spec.loader.exec_module(sh)

A = "A" * 22
B = "B" * 22
C = "C" * 22


def row(n, title, artists, track_id=None, album="Album", added="9 Oct 2026", duration="3:35"):
    return {"n": n, "title": title, "track_id": track_id, "artists": [{"name": a, "id": None} for a in artists],
            "album": {"name": album, "id": None}, "added": added, "duration": duration, "explicit": False}


def snapshot(**over):
    snap = {"schema": sh.SNAPSHOT_SCHEMA, "captured": "2026-11-14", "library": [
        {"uri": f"spotify:album:{C}", "name": "Aphrodite", "sub": "Album • Aphrodite"},
        {"uri": f"spotify:artist:{B}", "name": "Moloko", "sub": "Artist"}],
        "playlists": [
            {"uri": "spotify:collection:tracks", "name": "Liked Songs", "owner": {"name": "Owner", "id": "u1"},
             "expected": 2, "items": [row(1, "Gooey", ["Glass Animals"], A), row(2, "Sing It Back", ["Moloko"], added="4 weeks ago")]},
            {"uri": f"spotify:playlist:{B}", "name": "Your Top Songs 2019", "library_subtitle": "Playlist • Made for Owner",
             "owner": {"name": "Spotify", "id": "spotify"}, "expected": 2,
             "items": [row(1, "Sing It Back", ["Moloko"]), row(2, "Gooey", ["Glass Animals"], A)]},
            {"uri": f"spotify:playlist:{C}", "name": "Mine", "library_subtitle": "Playlist • Owner",
             "owner": {"name": "Owner", "id": "u1"}, "expected": 2,
             "items": [row(1, "Gooey", ["Glass Animals"], A), {"n": 2, "unavailable": True, "text": "gone"}]}]}
    snap.update(over)
    return snap


def built(snaps=None):
    m = sh.model(snaps or [snapshot()])
    sh.assign_ids(m)
    for s in m["songs"].values():
        s["review"], s["status"] = None, "missing"
    return m


class FrontMatter(unittest.TestCase):
    def test_a_record_reads_back_as_written(self):
        meta = {"schema": "spotify-track/v1", "title": "Déjà \"vu\"", "artists": ["A", "B"],
                "yearbooks": [{"year": 2019, "n": 3}], "liked": True, "album": None}
        meta2, body = sh.load_record(sh.dump_record(meta, "# body"), "t")
        self.assertEqual(meta2, {k: v for k, v in meta.items() if v is not None})
        self.assertEqual(body.strip(), "# body")

    def test_a_malformed_record_is_refused_with_its_line(self):
        for text, said in (("no front matter", "no front matter"), ("---\ntitle: x\n", "not closed"),
                           ("---\ntitle: unquoted\n---\n", ":2:"), ("---\na: 1\na: 2\n---\n", "twice")):
            with self.assertRaises(sh.HistoryError) as ctx:
                sh.load_record(text, "t")
            self.assertIn(said, str(ctx.exception))


class Dates(unittest.TestCase):
    def test_the_date_added_cell_becomes_a_date(self):
        self.assertEqual(sh.added_date("9 Oct 2026", "2026-11-14"), {"date": "2026-10-09"})
        self.assertEqual(sh.added_date("Oct 9, 2026", "2026-11-14"), {"date": "2026-10-09"})
        self.assertEqual(sh.added_date("4 weeks ago", "2026-11-14"), {"date": "2026-10-17", "approx": True})
        self.assertEqual(sh.added_date("an hour ago", "2026-11-14"), {"date": "2026-11-14", "approx": True})
        self.assertEqual(sh.added_date("včera", "2026-11-14"), {"text": "včera"})
        self.assertIsNone(sh.added_date("", "2026-11-14"))


class Model(unittest.TestCase):
    def test_one_song_one_record_across_playlists(self):
        m = built()
        self.assertEqual(len(m["songs"]), 2, "Gooey by id, Sing It Back by artist and song")
        kinds = {p["name"]: p["kind"] for p in m["playlists"]}
        self.assertEqual(kinds, {"Liked Songs": "liked", "Your Top Songs 2019": "yearbook", "Mine": "own"})

    def test_an_id_less_row_joins_the_song_its_id_names(self):
        snap = snapshot()
        snap["playlists"][1]["items"][1]["track_id"] = None  # the yearbook row lacks the id
        m = built([snap])
        self.assertEqual(len(m["songs"]), 2)

    def test_a_short_crawl_is_completed_from_a_full_one(self):
        pls = [{"uri": "spotify:collection:tracks", "expected": 3, "items": [row(1, "X", ["Y"], A)]}]
        plain = [{"n": 1, "title": "X", "artists": ["Y"]}, {"n": 2, "title": "Z", "artists": ["W"]}]
        merged = sh.merge_liked(pls, plain)
        self.assertEqual([r["n"] for r in merged[0]["items"]], [1, 2])
        self.assertEqual(merged[0]["items"][0]["track_id"], A, "the id-bearing row wins")

    def test_colliding_names_stay_distinct_and_stable(self):
        snap = snapshot()
        snap["playlists"][2]["items"].append(row(3, "Gooey", ["Glass Animals"], B))  # another recording
        ids1 = sorted(s["id"] for s in built([snap])["songs"].values())
        ids2 = sorted(s["id"] for s in built([snap])["songs"].values())
        self.assertEqual(ids1, ids2)
        self.assertEqual(len(set(ids1)), 3)


class Classify(unittest.TestCase):
    def test_an_unsaved_top_songs_playlist_is_a_yearbook(self):
        # Read by id with SonicCrawl.playlists(): no library subtitle, the owner shown as "Made for".
        p = {"uri": "spotify:playlist:37i9dQZF1Fa1IIVtEpGUcU", "name": "Your Top Songs 2023",
             "library_subtitle": None, "owner": {"name": "Owner", "id": "owner"}}
        self.assertEqual(sh.classify(p, "Owner"), "yearbook")

    def test_an_own_playlist_named_like_a_year_stays_own(self):
        p = {"uri": "spotify:playlist:5hTq0aBcDeFgHiJkLmNoPq", "name": "Your Top Songs 2023",
             "library_subtitle": "Playlist • Owner", "owner": {"name": "Owner", "id": "owner"}}
        self.assertEqual(sh.classify(p, "Owner"), "own")
        p = {"uri": "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M", "name": "Today's Top Hits 2023",
             "library_subtitle": None, "owner": {"name": "Spotify", "id": "spotify"}}
        self.assertNotEqual(sh.classify(p, "Owner"), "yearbook")


class YearbookDecisions(unittest.TestCase):
    def test_an_identity_decision_carries_into_the_yearbook_item(self):
        song = {"title": "Take Me As I Am", "artists": ["The Streets", "Chris Lorenzo"], "album": None,
                "duration": "3:06", "track_id": "5UjccMIJkNhont0TGSU0iD",
                "decision": {"review": "chris-lorenzo-and-the-streets_take-me-as-i-am.md"}}
        m = {"songs": {"s": song, "t": {**song, "track_id": None, "decision": None}}}
        items = sh.yearbook_items({"rows": [{"n": 1, "song": "s"}, {"n": 2, "song": "t"}, {"n": 3, "song": None}]}, m)
        self.assertEqual(items[0]["review"], "chris-lorenzo-and-the-streets_take-me-as-i-am.md")
        self.assertNotIn("review", items[1])
        self.assertTrue(items[2]["uncertain"])


class Records(unittest.TestCase):
    def setUp(self):
        self.m = built()
        self.public = sh.records(self.m, private=False)
        self.private = sh.records(self.m, private=True)

    def test_public_records_hold_nothing_private_and_validate(self):
        schemas = {k: sh.schema(k) for k in ("track", "playlist", "library")}
        for path, text in self.public.items():
            if path.suffix != ".md":
                continue
            meta, _ = sh.load_record(text, path.name)
            kind = "library" if path.name == "library.md" else path.parent.name.rstrip("s")
            self.assertEqual(sh.cat.validate(meta, schemas[kind]), [], path.name)
            self.assertEqual(sh.find_private_keys(meta), [], path.name)
        self.assertNotIn("u1", "".join(self.public.values()), "no user id in public")

    def test_private_records_keep_the_dates(self):
        texts = [t for p, t in self.private.items() if p.parent.name == "tracks"]
        self.assertTrue(any('"added": {"date": "2026-10-09"}' in t for t in texts))
        self.assertTrue(all(str(p).startswith(str(sh.PRIVATE)) for p in self.private))

    def test_a_yearbook_and_its_items(self):
        pl = next(p for p in self.m["playlists"] if p["kind"] == "yearbook")
        items = sh.yearbook_items(pl, self.m)
        self.assertEqual([(i["n"], i["title"], i.get("spotify")) for i in items],
                         [(1, "Sing It Back", None), (2, "Gooey", A)])
        track = next(t for p, t in self.public.items() if p.name.startswith("glass-animals-gooey"))
        meta, _ = sh.load_record(track)
        self.assertEqual(meta["yearbooks"], [{"year": 2019, "n": 2}])
        self.assertTrue(meta["liked"])

    def test_an_unavailable_item_keeps_its_place(self):
        mine = next(t for p, t in self.public.items() if p.parent.name == "playlists" and p.stem == "mine")
        meta, _ = sh.load_record(mine)
        self.assertEqual(meta["tracks"][1], {"n": 2, "unavailable": True})
        self.assertEqual((meta["retrieved"], meta["unavailable"]), (1, 1))


class Overrides(unittest.TestCase):
    def test_a_record_resolves_the_way_its_yearbook_item_does(self):
        ov = sh.playlist_overrides()
        self.assertEqual(ov.get(("bjorkgudmundsdottir", "katarokkar")), {"review": "bjork-kata-rokkar.md"},
                         "the owner's review= in yearbook-2019.toml, keyed by artist and song")


class Derived(unittest.TestCase):
    def test_a_broken_foreign_key_or_a_private_column_is_refused(self):
        import shutil
        import tempfile
        if not (sh.BASE / "index.json").exists():
            self.skipTest("no committed history")
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            shutil.copy(sh.BASE / "index.json", base / "index.json")
            shutil.copy(sh.BASE / "manifest.json", base / "manifest.json")
            shutil.copytree(sh.BASE / "tables", base / "tables")
            with open(base / "tables" / "memberships.jsonl", "a", encoding="utf-8") as f:
                f.write(json.dumps({"track": "no-such-track", "playlist": "liked-songs", "kind": "liked", "n": 1}) + "\n")
                f.write(json.dumps({"track": "no-such-track", "playlist": "x", "kind": "own", "n": 2, "added": "2026"}) + "\n")
            saved = sh.BASE
            sh.BASE = base
            try:
                errors = sh.check_derived()
            finally:
                sh.BASE = saved
        self.assertTrue(any("foreign key no-such-track" in e for e in errors), errors[:3])
        self.assertTrue(any("'added' is private" in e or "unknown key 'added'" in e for e in errors), errors[:3])


class Crawl(unittest.TestCase):
    """scripts/spotify-web-crawl.js, the repeatable snapshot: valid JavaScript that reads the
    rendered page only (ADR 0007: never the session's credentials, never Spotify's API)."""
    path = ROOT / "scripts" / "spotify-web-crawl.js"

    def test_it_parses(self):
        import shutil
        import subprocess
        if not shutil.which("node"):
            self.skipTest("node is not installed")
        r = subprocess.run(["node", "--check", str(self.path)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_it_never_touches_credentials_or_the_api(self):
        code = self.path.read_text(encoding="utf-8").lower()
        for banned in ("authorization", "bearer", "api.spotify.com", "accounts.spotify.com", "fetch(",
                       "xmlhttprequest", "document.cookie", "/api/token"):
            self.assertNotIn(banned, code, f"the crawl must not use {banned}")

    def test_a_playlist_without_a_name_of_its_own_is_kept(self):
        # The library shows such a playlist as "Playlist • <owner>"; only the unavailable ones
        # ("This playlist is not available") are skipped (the second crawl, 2026-11-14).
        code = self.path.read_text(encoding="utf-8")
        self.assertIn("This playlist is not available", code)
        self.assertNotIn("/^Playlist •/", code)

    def test_the_top_up_reads_every_row_a_seek_renders(self):
        # Reading only the sought row took over 45 minutes on 2,031 liked songs (third crawl,
        # 2026-11-17); every row the seek brought into view is read.
        code = self.path.read_text(encoding="utf-8")
        top_up = code[code.index("await seek(n);"):code.index("unavailable: true")]
        self.assertIn("for (const r of dataRows())", top_up)

    def test_progress_is_visible_from_another_tab(self):
        # The injecting tool can lose its handle on the crawling tab (third crawl, 2026-11-17).
        code = self.path.read_text(encoding="utf-8")
        self.assertIn("'sonicCrawlProgress'", code)
        self.assertIn("localStorage.setItem(PROGRESS", code)

    def test_it_writes_the_snapshot_schema(self):
        code = self.path.read_text(encoding="utf-8")
        self.assertIn(f"schema: '{sh.SNAPSHOT_SCHEMA}'", code)


class Derive(unittest.TestCase):
    def test_without_private_sources_the_derive_leaves_the_records_alone(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            saved = (sh.SNAPSHOTS, sh.EXPORTS)
            sh.SNAPSHOTS, sh.EXPORTS = Path(tmp) / "snapshots", Path(tmp) / "export"
            try:
                self.assertFalse(sh.has_sources(), "a checkout without the store has no source")
                (Path(tmp) / "snapshots").mkdir()
                (Path(tmp) / "snapshots" / "web-2026-11-14.json").write_text("{}")
                self.assertTrue(sh.has_sources())
            finally:
                sh.SNAPSHOTS, sh.EXPORTS = saved


class Currency(unittest.TestCase):
    """Only committed records are judged for currency (the private store is shared by worktrees)."""
    def _check_with(self, report):
        if not sh.has_sources():
            self.skipTest("no private source here")
        saved = sh.build
        sh.build = lambda write=False, **kw: report
        try:
            return [e for e in sh.check() if "stale" in e]
        finally:
            sh.build = saved

    def test_private_only_staleness_does_not_refuse(self):
        self.assertEqual(self._check_with({"changed": 4, "removed": 0, "stale": [], "yearbooks": []}), [])

    def test_a_stale_committed_record_is_named(self):
        errs = self._check_with({"changed": 1, "removed": 0, "stale": ["data/spotify/tracks/x.md"], "yearbooks": []})
        self.assertTrue(errs and "data/spotify/tracks/x.md" in errs[0], errs)


class BacklogSchema(unittest.TestCase):
    def test_an_override_may_name_a_review_with_an_underscore(self):
        schema = json.loads((ROOT / "data" / "backlog.schema.json").read_text(encoding="utf-8"))
        item = schema["$defs"]["item"]
        ok = {"n": 1, "title": "t", "artists": ["a"], "review": "kollektiv-turmstrasse_on-the-streets-let-freedom.md"}
        self.assertEqual(sh.cat.validate(ok, item, "", schema), [])
        self.assertNotEqual(sh.cat.validate({**ok, "review": "Bad Name.md"}, item, "", schema), [])


class Gate(unittest.TestCase):
    def test_private_keys_are_found_anywhere(self):
        self.assertEqual(sh.find_private_keys({"a": [{"added": 1}], "plays": {}}), ["a[0].added", "plays"])

    def test_the_committed_history_passes_the_gate(self):
        self.assertEqual(sh.check(), [])


class Export(unittest.TestCase):
    def test_the_export_is_read_into_liked_playlists_and_plays(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "YourLibrary.json").write_text(json.dumps({"tracks": [
                {"artist": "Moloko", "album": "Things to Make and Do", "track": "Sing It Back", "uri": f"spotify:track:{B}"}]}))
            (d / "Playlist1.json").write_text(json.dumps({"playlists": [{"name": "Your Top Songs 2019", "items": [
                {"track": {"trackName": "Sing It Back", "artistName": "Moloko", "albumName": "X", "trackUri": f"spotify:track:{B}"},
                 "addedDate": "2019-12-01"}]}]}))
            (d / "Streaming_History_Audio_2019.json").write_text(json.dumps([
                {"ts": "2019-05-01T10:00:00Z", "ms_played": 60000, "master_metadata_track_name": "Sing It Back",
                 "master_metadata_album_artist_name": "Moloko", "spotify_track_uri": f"spotify:track:{B}", "ip_addr": "1.2.3.4"},
                {"ts": "2019-05-02T10:00:00Z", "ms_played": 0, "master_metadata_track_name": None}]))
            ex = sh.export_sources(d)
        self.assertEqual(ex["liked"][0]["track_id"], B)
        self.assertEqual(ex["playlists"][0]["items"][0]["track_id"], B)
        self.assertEqual(len(ex["plays"]), 1, "a play with no track (a podcast or a gap) is not a song")
        self.assertNotIn("ip_addr", ex["plays"][0], "the address never leaves the raw file")
        m = sh.model([], ex)
        sh.assign_ids(m)
        self.assertEqual(m["plays"][("id", B)]["count"], 1)


if __name__ == "__main__":
    unittest.main()
