"""The visualiser (static/js/visualizer.js) is one list of modes that everything else agrees with:
the fullscreen toolbar offers exactly those modes, every mode has a drawing and a label in each
locale, there are at least seven of them, p5 is vendored and loaded on demand only, and the
fullscreen layer sits under the player so the playing video is never covered.
"""

import json
import re
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JS = (ROOT / "static/js/visualizer.js").read_text(encoding="utf-8")
SHELL = (ROOT / "templates/partials/visualizer.html").read_text(encoding="utf-8")
BASE = (ROOT / "templates/base.html").read_text(encoding="utf-8")


def modes():
    found = re.search(r"var MODES = \[([^\]]*)\];", JS)
    assert found, "visualizer.js declares var MODES = [...]"
    return re.findall(r"'([a-z]+)'", found.group(1))


class Visualizer(unittest.TestCase):
    def test_at_least_seven_modes(self):
        self.assertGreaterEqual(len(modes()), 7)
        self.assertEqual(len(modes()), len(set(modes())))

    def test_every_mode_draws(self):
        drawn = set(re.findall(r"^    ([a-z]+): function \(p, a, s\)", JS, re.M))
        self.assertEqual(set(modes()), drawn)

    def test_the_toolbar_offers_exactly_the_modes(self):
        listed = re.search(r'{%- for mode in \[([^\]]*)\] %}', SHELL)
        assert listed is not None, "the toolbar lists its modes in one loop"
        self.assertEqual(re.findall(r'"([a-z]+)"', listed.group(1)), modes())

    def test_every_mode_has_a_label_in_each_locale(self):
        for locale in ("en", "cs"):
            strings = tomllib.loads((ROOT / f"data/i18n/{locale}.toml").read_text(encoding="utf-8"))
            for mode in modes():
                self.assertIn(f"viz.mode.{mode}", strings, f"{locale}: viz.mode.{mode}")

    def test_p5_is_vendored_and_loaded_on_demand(self):
        manifest = json.loads((ROOT / "static/data/vendor.json").read_text(encoding="utf-8"))
        self.assertIn("p5", manifest["libs"])
        self.assertTrue((ROOT / "static" / manifest["libs"]["p5"]["js"]).is_file())
        self.assertIn("data-p5=", BASE)
        self.assertNotIn("vendor.libs.p5.js) }}\" defer", BASE, "p5 is never a page-load script")

    def test_the_fullscreen_layer_is_under_the_player(self):
        layer = re.search(r'id="visualizer-full"[^>]*class="[^"]*\bz-\[(\d+)\]', SHELL)
        assert layer is not None, "the fullscreen layer has an explicit z-[n]"
        player = (ROOT / "templates/partials/player.html").read_text(encoding="utf-8")
        panel = re.search(r'id="player-panel"[^>]*class="[^"]*\bz-(\d+)', player)
        assert panel is not None, "the video panel has a z-n class"
        self.assertLess(int(layer.group(1)), int(panel.group(1)))

    def test_no_source_listens_by_itself(self):
        # getDisplayMedia / getUserMedia run only in listen(), and listen() is called only from
        # the toolbar's click handler (or by a caller of the public API): nothing asks on load.
        handler = JS.index("s.addEventListener('click'")
        handler_end = JS.index("s.addEventListener('keydown'")
        self.assertEqual(JS.count("getDisplayMedia("), 1)
        self.assertEqual(JS.count("getUserMedia("), 1)
        calls = [m.start() for m in re.finditer(r"(?<![\w.])(?<!function )listen\(", JS)]
        self.assertTrue(calls)
        for at in calls:
            self.assertTrue(handler < at < handler_end, JS[at - 80:at + 20])


if __name__ == "__main__":
    unittest.main()
