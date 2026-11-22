"""Unit tests of scripts/check-components.py's page-layout check (rule project.page-layout).

    python3 -m unittest discover -s test -p 'test_check_components.py'
"""
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("check_components", ROOT / "scripts" / "check-components.py")
assert spec is not None and spec.loader is not None
check: Any = importlib.util.module_from_spec(spec)
sys.modules["check_components"] = check
spec.loader.exec_module(check)

LIBRARY = ('{% component layout(part) %}{% if part == "gutter" %}px-4 xl:px-8{% else %}px-4 pt-6 xl:px-8'
           '{% endif %}{% endcomponent layout %}\n'
           '{% component prose(html) %}<div class="format format-sm">{{ html | safe }}</div>'
           '{% endcomponent prose %}\n')
GOOD = '{% extends "base.html" %}\n<div class="{{ <layout part="body" /> }} space-y-4">{{ <prose html={x} /> }}</div>\n'


class PageLayout(unittest.TestCase):
    def problems(self, page: str) -> list[str]:
        with tempfile.TemporaryDirectory() as tmp:
            templates = Path(tmp) / "templates"
            templates.mkdir()
            (templates / "components.html").write_text(LIBRARY, encoding="utf-8")
            (templates / "page.html").write_text(page, encoding="utf-8")
            return check.layout_problems(templates)

    def test_the_components_and_a_page_that_uses_them_pass(self):
        self.assertEqual(self.problems(GOOD), [])

    def test_a_page_without_the_layout_is_refused(self):
        found = self.problems('{% extends "base.html" %}\n<div class="space-y-4">x</div>\n')
        self.assertEqual(len(found), 1)
        self.assertIn("does not open its body", found[0])

    def test_a_typed_gutter_is_refused(self):
        found = self.problems(GOOD + '<div class="grid px-4 pt-6 xl:px-8">x</div>\n')
        self.assertEqual(len(found), 1)
        self.assertIn("page.html:3 types the page gutter", found[0])

    def test_a_bare_typography_box_is_refused_but_not_format(self):
        found = self.problems(GOOD + '<div class="format format-lg">x</div>\n<figure class="not-format">\n')
        self.assertEqual(len(found), 1)
        self.assertIn("page.html:3 sets the typography box", found[0])

    def test_the_repository_passes(self):
        self.assertEqual(check.layout_problems(), [])


if __name__ == "__main__":
    unittest.main()
