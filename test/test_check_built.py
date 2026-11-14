"""check-built's accessible-name check resolves aria-labelledby (rule project.accessible-names).

It used to count the attribute's value, an id, as the name: <button aria-labelledby="missing">
passed with no name at all (a review of the gates, 2026-11-14).
"""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("check_built", ROOT / "scripts" / "check-built.py")
assert SPEC and SPEC.loader
check_built = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check_built)


def unnamed(html: str) -> list[str]:
    parser = check_built.Refs()
    parser.feed(html)
    parser.close()
    return parser.unnamed


class LabelledBy(unittest.TestCase):
    def test_a_reference_to_nothing_names_nothing(self):
        self.assertEqual(len(unnamed('<button aria-labelledby="missing"></button>')), 1)

    def test_a_reference_to_an_empty_element_names_nothing(self):
        self.assertEqual(len(unnamed('<span id="e"></span><button aria-labelledby="e"></button>')), 1)

    def test_a_reference_names_the_control_by_its_text(self):
        self.assertEqual(unnamed('<span id="l">Play</span><button aria-labelledby="l"></button>'), [])

    def test_a_reference_may_point_further_down_the_page(self):
        self.assertEqual(unnamed('<a href="/x" aria-labelledby="t"></a><h2 id="t">Title</h2>'), [])

    def test_text_and_aria_label_still_name(self):
        self.assertEqual(unnamed('<button>Play</button><button aria-label="Close"></button>'), [])


if __name__ == "__main__":
    unittest.main()
