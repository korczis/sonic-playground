"""Unit tests of the translation contract (ADR 0006): scripts/translation.py, its use by
scripts/catalog.py, scripts/translate.py and the term labels of scripts/i18n.py.

The positive case is a real translation of the corpus; every negative case is that translation
with one thing broken, and must be refused for exactly that reason.

majordomus-skill: translate

    python3 -m unittest discover -s test -p 'test_*.py'
"""
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))


def load(name: str) -> Any:
    import importlib
    return importlib.import_module(name)


cat: Any = load("catalog")
tr: Any = load("translation")

EN = ROOT / "content" / "alt-j-breezeblocks.md"
CS = ROOT / "content" / "alt-j-breezeblocks.cs.md"


def parts(path: Path) -> tuple[dict, str]:
    raw, body = cat.split_front_matter(path.read_text(encoding="utf-8"), path.name)
    return tomllib.loads(raw), body


class Contract(unittest.TestCase):
    def setUp(self):
        meta, body = parts(EN)
        self.english = tr.fingerprint(meta, body)
        self.text = CS.read_text(encoding="utf-8")

    def problems(self, text: str) -> list[str]:
        raw, body = cat.split_front_matter(text, CS.name)
        meta = tomllib.loads(raw)
        return cat.validate(meta, cat.TRANSLATION_SCHEMA) + tr.check(CS.name, meta, body, self.english, cat.TRANSLATION)

    def broken(self, old: str, new: str, count: int = 1) -> str:
        self.assertIn(old, self.text)
        return self.text.replace(old, new, count)

    def assertRefused(self, text: str, reason: str):
        found = self.problems(text)
        self.assertTrue(any(reason in p for p in found), f"expected '{reason}' in {found}")

    def test_the_corpus_translation_is_accepted(self):
        self.assertEqual(self.problems(self.text), [])

    def test_a_stale_translation_is_refused(self):
        self.assertRefused(self.broken(f'of = "{self.english["hash"]}"', 'of = "000000000000"'), "update the translation")

    def test_other_taxonomies_are_refused(self):
        self.assertRefused(self.broken('genre = ["indie rock", "alternative", "art rock"]', 'genre = ["indie rock"]'),
                           "taxonomies differ")

    def test_another_date_is_refused(self):
        self.assertRefused(self.broken('date = "2024-10-06"', 'date = "2024-10-07"'), "is not the English page's")

    def test_a_dropped_component_is_refused(self):
        self.assertRefused(self.broken('{{ <concept_link name="build-up" lang="cs" /> }}', 'gradace'), "components differ")

    def test_a_content_link_without_its_language_is_refused(self):
        self.assertRefused(self.broken('name="build-up" lang="cs"', 'name="build-up"'), 'needs lang="cs"')

    def test_a_missing_heading_is_refused(self):
        self.assertRefused(self.broken("### Refrén\n", "**Refrén**\n"), "headings")

    def test_english_left_in_place_is_refused(self):
        en_meta, en_body = parts(EN)
        paragraph = next(p for p in re.split(r"\n\s*\n", en_body) if len(p) > 200 and not p.startswith(("#", "{{")))
        cs_paragraph = next(p for p in re.split(r"\n\s*\n", self.text) if p.startswith("**alt-J** udělali"))
        self.assertRefused(self.text.replace(cs_paragraph, paragraph), "paragraph(s) are the English text")

    def test_an_english_field_is_refused(self):
        text = re.sub(r'^description = ".*"$', 'description = "A lullaby with teeth: an obsessive love song wrapped in plucked guitar and close harmonies."',
                      self.text, count=1, flags=re.M)
        self.assertRefused(text, "description does not read as Czech")

    def test_a_look_alike_letter_is_refused(self):
        self.assertRefused(self.broken("Úsečný, nosový", "Úsečný, nоsový"), "letters of another script")

    def test_the_scaffold_marker_is_refused(self):
        self.assertRefused(self.broken("## Žánr a nálada\n\n", "## Žánr a nálada\n\nTODO(translate)\n\n"),
                           "body is not translated yet")

    def test_learning_must_mirror_the_english(self):
        self.assertRefused(self.broken('  { part = "závěrečná část", what = "Dřívější verše se zpívají přes sebe a opakují; skladba roste hromaděním, ne rychlostí." },\n', ''),
                           "extra.learning has")

    def test_a_fact_in_a_translation_is_refused(self):
        self.assertRefused(self.broken("[extra.translation]\n", '[extra.translation]\n'.replace("translation]", "translation]") , 1)
                           .replace("[extra]\nconnections", '[extra]\nisrc = "GBZUZ1100058"\nconnections'), "isrc")


LAUTER_EN = ROOT / "content" / "mainvibe-lauter.md"
LAUTER_CS = ROOT / "content" / "mainvibe-lauter.cs.md"


class Versions(unittest.TestCase):
    """The notes of extra.versions are the only text of a version a translation carries: keyed by
    the version's youtube (or url), in the English order, each one translated."""
    def setUp(self):
        self.meta, self.body = parts(LAUTER_EN)
        self.english = tr.fingerprint(self.meta, self.body)
        self.text = LAUTER_CS.read_text(encoding="utf-8")

    def problems(self, text: str) -> list[str]:
        raw, body = cat.split_front_matter(text, LAUTER_CS.name)
        meta = tomllib.loads(raw)
        return (cat.validate(meta, cat.TRANSLATION_SCHEMA)
                + tr.check(LAUTER_CS.name, meta, body, self.english, cat.TRANSLATION))

    def assertRefused(self, text: str, reason: str):
        found = self.problems(text)
        self.assertTrue(any(reason in p for p in found), f"expected '{reason}' in {found}")

    def note_line(self, video: str) -> str:
        line = next(x for x in self.text.splitlines() if f'youtube = "{video}"' in x)
        return line + "\n"

    def test_notes_are_keyed_and_ordered_as_the_english(self):
        extra = {"versions": [{"youtube": "AAAAAAAAAAA", "note": "First note, long enough."},
                              {"youtube": "BBBBBBBBBBB"},
                              {"url": "https://example.org/x", "note": "A note on a link."},
                              "not a table"]}
        self.assertEqual(tr.version_notes(extra), [
            {"key": "AAAAAAAAAAA", "note": "First note, long enough."},
            {"key": "https://example.org/x", "note": "A note on a link."}])
        self.assertEqual(tr.version_notes({}), [])
        keys = [v.get("youtube") for v in self.meta["extra"]["versions"] if v.get("note")]
        self.assertEqual(self.english["versions"], keys)
        self.assertTrue(keys and len(keys) < len(self.meta["extra"]["versions"]))  # some versions have no note

    def test_the_hash_of_a_page_without_notes_is_unchanged(self):
        meta, body = parts(EN)
        found = re.search(r'of = "([0-9a-f]{12})"', CS.read_text(encoding="utf-8"))
        assert found is not None
        blessed = found.group(1)
        self.assertEqual(tr.prose_hash(meta, body), blessed)
        no_notes = {**meta, "extra": {**meta["extra"], "versions": [{"youtube": "AAAAAAAAAAA"}]}}
        self.assertEqual(tr.prose_hash(no_notes, body), blessed)
        noted = {**meta, "extra": {**meta["extra"], "versions": [
            {"youtube": "AAAAAAAAAAA", "note": "A remix that changes everything."}]}}
        self.assertNotEqual(tr.prose_hash(noted, body), blessed)
        self.assertEqual(tr.fingerprint(meta, body)["versions"], [])

    def test_a_changed_note_makes_the_translation_stale(self):
        changed = {**self.meta, "extra": {**self.meta["extra"], "versions": [
            {**v, "note": v["note"] + " Changed."} if v.get("note") else v
            for v in self.meta["extra"]["versions"]]}}
        self.assertNotEqual(tr.prose_hash(changed, self.body), tr.prose_hash(self.meta, self.body))

    def test_the_corpus_translation_with_versions_is_accepted(self):
        self.assertEqual(self.problems(self.text), [])

    def test_a_missing_note_is_refused(self):
        line = self.note_line("WaxPYwst85k")
        self.assertRefused(self.text.replace(line, ""), "extra.versions must carry a note")

    def test_reordered_notes_are_refused(self):
        first, second = self.note_line("DgC7FGgsm4A"), self.note_line("WaxPYwst85k")
        self.assertRefused(self.text.replace(first + second, second + first), "in its order")

    def test_a_note_for_a_version_without_one_is_refused(self):
        line = self.note_line("WaxPYwst85k")
        extra = '  { youtube = "LFZDZ8d-NFo", note = "Remix jiného producenta, který je delší." },\n'
        self.assertRefused(self.text.replace(line, line + extra), "extra.versions must carry a note")

    def test_an_untranslated_note_is_refused(self):
        line = self.note_line("WaxPYwst85k")
        marker = cat.TRANSLATION["untranslated_marker"]
        todo = f'  {{ youtube = "WaxPYwst85k", note = "{marker} The single as the artist released it." }},\n'
        self.assertRefused(self.text.replace(line, todo), "extra.versions[1].note is not translated yet")

    def test_an_english_note_is_refused(self):
        line = self.note_line("WaxPYwst85k")
        english = ('  { youtube = "WaxPYwst85k", note = "The single as the artist released it himself, '
                   'through the distributor DistroKid." },\n')
        self.assertRefused(self.text.replace(line, english), "extra.versions[1].note does not read as Czech")

    def test_the_scaffold_carries_marked_notes(self):
        translate = load("translate")
        marker = cat.TRANSLATION["untranslated_marker"]
        text = translate.scaffold_text(LAUTER_EN, "cs")
        raw, _ = cat.split_front_matter(text, LAUTER_CS.name)
        versions = tomllib.loads(raw)["extra"]["versions"]
        self.assertEqual([v["youtube"] for v in versions], self.english["versions"])
        self.assertTrue(all(v["note"].startswith(marker) for v in versions), versions)
        self.assertIn('[extra]\nconnections = ', text)

    def test_the_scaffold_keys_a_link_by_its_url(self):
        translate = load("translate")
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        old = cat.CONTENT
        cat.CONTENT = tmp
        self.addCleanup(setattr, cat, "CONTENT", old)
        src = tmp / "x-y.md"
        src.write_text('+++\ntitle = "X - Y"\ndate = "2026-11-28"\ndescription = "A song."\n\n'
                       '[extra]\nversions = [\n  { kind = "cover", title = "Y", by = "Z", '
                       'url = "https://example.org/y", note = "A cover on a label page." },\n'
                       ']\n+++\n\nX made Y.\n', encoding="utf-8")
        raw, _ = cat.split_front_matter(translate.scaffold_text(src, "cs"), "x-y.cs.md")
        extra = tomllib.loads(raw)["extra"]
        self.assertNotIn("connections", extra)
        self.assertEqual(extra["versions"], [{"url": "https://example.org/y",
                                              "note": f"{translate.MARK} A cover on a label page."}])


class Catalogue(unittest.TestCase):
    def test_the_catalogue_carries_the_translation_layer(self):
        errors = []
        c = cat.build(errors)
        self.assertEqual(errors, [])
        t = c["tracks"][c["lookup"]["alt-j-breezeblocks.md"]]
        self.assertEqual(t["langs"], ["en", "cs"])
        self.assertEqual(t["i18n"]["cs"]["path"], "cs/alt-j-breezeblocks/")
        self.assertIn("indie rock", c["lang_terms"]["cs"]["genre"])
        self.assertIn("alt-j-breezeblocks.md", c["_jsonld"]["cs"])
        self.assertEqual(c["_jsonld"]["cs"]["alt-j-breezeblocks.md"]["@graph"][1]["inLanguage"], "cs")

    def test_reviews_are_not_their_translations(self):
        names = [p.name for p in cat.review_files()]
        self.assertIn("alt-j-breezeblocks.md", names)
        self.assertFalse(any(tr.translation_name(n) for n in names))

    def test_translation_names(self):
        self.assertEqual(tr.translation_name("x.cs.md"), ("x.md", "cs"))
        self.assertIsNone(tr.translation_name("x.md"))
        self.assertIsNone(tr.translation_name("_index.md"))
        self.assertEqual(tr.translation_name("_index.cs.md"), ("_index.md", "cs"))

    def test_localised_links_name_their_language_last(self):
        self.assertEqual(tr.localise_links('a {{ <concept_link name="x" /> }} {{ <track_link source="y.md" lang="cs" /> }}', "cs"),
                         'a {{ <concept_link name="x" lang="cs" /> }} {{ <track_link source="y.md" lang="cs" /> }}')


class Tool(unittest.TestCase):
    """scripts/translate.py on a copy of the content directory."""
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        shutil.copytree(ROOT / "content", self.tmp / "content")
        for name in ("config.toml",):
            shutil.copy(ROOT / name, self.tmp / name)
        for folder in ("data", "scripts", "static/data"):
            shutil.copytree(ROOT / folder, self.tmp / folder)

    def run_tool(self, *args):
        return subprocess.run([sys.executable, str(self.tmp / "scripts" / "translate.py"), *args],
                              capture_output=True, text=True, cwd=self.tmp)

    def test_a_scaffold_is_refused_until_translated_and_never_overwrites(self):
        src = "content/glass-animals-gooey.md"
        (self.tmp / "content" / "glass-animals-gooey.cs.md").unlink(missing_ok=True)
        out = self.run_tool("scaffold", src)
        self.assertEqual(out.returncode, 0, out.stderr)
        scaffold = self.tmp / "content" / "glass-animals-gooey.cs.md"
        text = scaffold.read_text()
        self.assertIn("TODO(translate)", text)
        self.assertIn('lang="cs" />', text if "<concept_link" in text else 'lang="cs" />')
        again = self.run_tool("scaffold", src)
        self.assertIn("left as it is", again.stdout)
        check = subprocess.run([sys.executable, str(self.tmp / "scripts" / "catalog.py"), "--check"],
                               capture_output=True, text=True, cwd=self.tmp)
        self.assertNotEqual(check.returncode, 0)
        self.assertIn("glass-animals-gooey.cs.md: body is not translated yet", check.stderr)

    def test_bless_records_the_english_text(self):
        cs = self.tmp / "content" / "alt-j-breezeblocks.cs.md"
        cs.write_text(re.sub(r'of = "[0-9a-f]{12}"', 'of = "000000000000"', cs.read_text()))
        out = self.run_tool("bless", "content/alt-j-breezeblocks.cs.md")
        self.assertEqual(out.returncode, 0, out.stderr)
        meta, body = parts(EN)
        self.assertIn(f'of = "{tr.prose_hash(meta, body)}"', cs.read_text())

    def test_the_owners_listening_is_refused_in_a_translation(self):
        cs = self.tmp / "content" / "alt-j-breezeblocks.cs.md"
        cs.write_text(cs.read_text() + "\nJe tu proto, že patřila k nejposlouchanějším skladbám majitele v roce 2014.\n")
        out = self.run_tool("check", "content/alt-j-breezeblocks.cs.md")
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("never about the owner's listening", out.stdout + out.stderr)
        check = subprocess.run([sys.executable, str(self.tmp / "scripts" / "catalog.py"), "--check"],
                               capture_output=True, text=True, cwd=self.tmp)
        self.assertNotEqual(check.returncode, 0)
        self.assertIn("alt-j-breezeblocks.cs.md: the body says", check.stderr)

    def test_status_counts_every_page(self):
        out = self.run_tool("status")
        self.assertRegex(out.stdout, r"translate: cs: \d+ current, \d+ stale, \d+ untranslated, \d+ missing of \d+")


class Terms(unittest.TestCase):
    def test_every_term_in_use_has_a_czech_label(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("i18n", ROOT / "scripts" / "i18n.py")
        assert spec and spec.loader
        i18n = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(i18n)
        errors = []
        strings = i18n.derived("cs", "en", errors)
        self.assertEqual(errors, [])
        self.assertEqual(strings["term.sentiment.melancholic"], "melancholická")
        self.assertEqual(strings["term.concept.build-up"], "gradace")
        self.assertEqual(i18n.derived("en", "en", [])["term.concept.build-up"], "build-up")


if __name__ == "__main__":
    unittest.main()
