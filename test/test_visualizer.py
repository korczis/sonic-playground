"""The visualiser is one list of modes (data/visualizer.json) that everything else agrees with:
at least 25 modes, each drawn by exactly one engine (p5 in static/js/viz-2d.js, three.js in
static/js/viz-gl.js), every WebGL mode with a p5 fallback, every live control from one
vocabulary, a name and an homage credit in each locale, the settings rendered from the same list,
both libraries vendored and loaded on demand only, the fullscreen layer under the player so the
playing video is never covered (cinema included), and the URL carrying the song and the picture.
"""

import json
import re
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONF = json.loads((ROOT / "data/visualizer.json").read_text(encoding="utf-8"))
JS = (ROOT / "static/js/visualizer.js").read_text(encoding="utf-8")
JS_2D = (ROOT / "static/js/viz-2d.js").read_text(encoding="utf-8")
JS_GL = (ROOT / "static/js/viz-gl.js").read_text(encoding="utf-8")
PLAYER = (ROOT / "static/js/player.js").read_text(encoding="utf-8")
SHELL = (ROOT / "templates/partials/visualizer.html").read_text(encoding="utf-8")
BASE = (ROOT / "templates/base.html").read_text(encoding="utf-8")
CSS = (ROOT / "styles/app.css").read_text(encoding="utf-8")
MODES = [m["id"] for m in CONF["modes"]]
BY = {m["id"]: m for m in CONF["modes"]}


def engine(name):
    return [m["id"] for m in CONF["modes"] if m["engine"] == name]


class Visualizer(unittest.TestCase):
    def test_at_least_25_unique_modes_on_two_engines(self):
        self.assertGreaterEqual(len(MODES), 25)
        self.assertEqual(len(MODES), len(set(MODES)))
        self.assertEqual({m["engine"] for m in CONF["modes"]}, {"p5", "gl"})
        for m in CONF["modes"]:
            self.assertRegex(m["id"], r"^[a-z]+$")
            self.assertIn(m["group"], ("plugin", "preset"))

    def test_every_p5_mode_draws_in_viz_2d(self):
        found = re.search(r"window\.SonicViz2D = \{(.*)\n  \};", JS_2D, re.S)
        assert found, "viz-2d.js assigns window.SonicViz2D = { ... }"
        drawn = set(re.findall(r"^    ([a-z]+): ", found.group(1), re.M))
        self.assertEqual(drawn, set(engine("p5")))

    def test_every_gl_mode_draws_in_viz_gl(self):
        ids = re.search(r"var IDS = \[([^\]]*)\];", JS_GL)
        assert ids, "viz-gl.js declares var IDS = [...]"
        self.assertEqual(re.findall(r"'([a-z]+)'", ids.group(1)), engine("gl"))
        table = JS_GL[JS_GL.index("var MODES = {"):]
        table = table[:table.index("\n  };")]
        built = set(re.findall(r"^    ([a-z]+): ", table, re.M))
        self.assertEqual(built, set(engine("gl")))

    def test_every_gl_mode_falls_back_to_a_p5_mode(self):
        for mode in engine("gl"):
            self.assertIn(BY[mode].get("fallback"), engine("p5"), mode)

    def test_live_controls_come_from_one_vocabulary(self):
        params = CONF["params"]
        for p in params.values():
            self.assertLessEqual(p["min"], p["default"])
            self.assertLessEqual(p["default"], p["max"])
            self.assertGreater(p["step"], 0)
        for m in CONF["modes"]:
            self.assertTrue(m["params"], m["id"])
            self.assertTrue(set(m["params"]) <= set(params), m["id"])
            for name, value in m.get("defaults", {}).items():
                self.assertIn(name, m["params"], m["id"])
                self.assertTrue(params[name]["min"] <= value <= params[name]["max"], m["id"])

    def test_the_calm_background_and_old_modes_resolve(self):
        self.assertIn(CONF["calm"], engine("p5"))
        self.assertTrue(set(CONF["background"]) <= set(engine("p5")))
        for old, new in CONF["aliases"].items():
            self.assertNotIn(old, MODES)
            self.assertIn(new, MODES)

    def test_the_settings_render_the_one_list(self):
        self.assertIn('load_data(path="data/visualizer.json")', SHELL)
        self.assertIn('data-viz-mode="{{ m.id }}"', SHELL)
        self.assertIn('data-viz-param="{{ name }}"', SHELL)
        self.assertIn('id="viz-conf"', SHELL)
        self.assertNotRegex(SHELL, r'data-viz-mode="[a-z]+"', "no hand-written mode buttons")

    def test_every_mode_and_control_has_words_in_each_locale(self):
        for locale in ("en", "cs"):
            strings = tomllib.loads((ROOT / f"data/i18n/{locale}.toml").read_text(encoding="utf-8"))
            for mode in MODES:
                self.assertIn(f"viz.mode.{mode}", strings, f"{locale}: viz.mode.{mode}")
                self.assertIn(f"viz.hint.{mode}", strings, f"{locale}: viz.hint.{mode}")
            for name in CONF["params"]:
                self.assertIn(f"viz.param.{name}", strings, f"{locale}: viz.param.{name}")

    def test_libraries_are_vendored_and_loaded_on_demand(self):
        manifest = json.loads((ROOT / "static/data/vendor.json").read_text(encoding="utf-8"))
        for lib, attr in (("p5", "data-p5="), ("three", "data-three=")):
            self.assertIn(lib, manifest["libs"])
            self.assertTrue((ROOT / "static" / manifest["libs"][lib]["js"]).is_file())
            self.assertIn(attr, BASE)
            self.assertNotIn(f"vendor.libs.{lib}.js) }}}}\" defer", BASE, f"{lib} is never a page-load script")
        scripts = re.search(r'\{%- for script in \[([^\]]*)\] %\}', BASE)
        assert scripts, "base.html loads its page scripts in one list"
        for script in ("viz-2d", "viz-gl"):
            self.assertIn(f"data-{script}=", BASE)
            self.assertNotIn(f'"{script}"', scripts.group(1), f"{script} is not a page-load script")

    def test_three_is_referenced_only_by_name(self):
        # scripts/vendor.mjs builds three.js from the THREE.<Name> it finds; any other access
        # would reach a name the bundle does not carry.
        code = "\n".join(line for line in JS_GL.splitlines() if not line.strip().startswith("//"))
        self.assertNotRegex(code, r"THREE\s*\[")
        self.assertNotRegex(code, r"\{[^}]*\}\s*=\s*THREE\b")

    def test_the_fullscreen_layer_is_under_the_player(self):
        layer = re.search(r'id="visualizer-full"[^>]*class="[^"]*\bz-\[(\d+)\]', SHELL)
        assert layer is not None, "the fullscreen layer has an explicit z-[n]"
        player = (ROOT / "templates/partials/player.html").read_text(encoding="utf-8")
        panel = re.search(r'id="player-panel"[^>]*class="[^"]*\bz-(\d+)', player)
        assert panel is not None, "the video panel has a z-n class"
        self.assertLess(int(layer.group(1)), int(panel.group(1)))

    def test_cinema_moves_the_video_and_never_covers_it(self):
        # Every cinema rule yields to the queue and the track menu, whose own rules move the video
        # beside them (an independent review found the open queue over the cinema video).
        rules = re.findall(r'^\s*(html\[data-viz-video="cinema"\][^{]*)\{', CSS, re.M)
        self.assertTrue(rules)
        for selector in rules:
            if "transition" in CSS[CSS.index(selector):CSS.index(selector) + len(selector) + 40]:
                continue
            self.assertIn(':not([data-player-queue-state="open"])', selector)
            self.assertIn(':not([data-track-menu-state="open"])', selector)
        head = next(r for r in rules if r.rstrip().endswith("#player-panel") and "data-viz-settings=\"open\"]) " in r)
        rule = CSS[CSS.index(head):]
        rule = rule[:rule.index("}")]
        self.assertIn("pointer-events: none", rule, "the full-screen panel lets clicks through")
        self.assertNotRegex(JS, r"(opacity|mix-blend-mode)[^;\n]*player-(panel|video)",
                            "nothing blends or fades the video itself (YouTube's terms)")

    def test_no_source_listens_by_itself(self):
        # getDisplayMedia / getUserMedia run only in listen(), and listen() is called only from
        # the toolbar's click handler (or by a caller of the public API): nothing asks on load.
        handler = JS.index("s.addEventListener('click'")
        handler_end = JS.index("s.addEventListener('input'")
        self.assertEqual(JS.count("getDisplayMedia("), 1)
        self.assertEqual(JS.count("getUserMedia("), 1)
        calls = [m.start() for m in re.finditer(r"(?<![\w.])(?<!function )listen\(", JS)]
        self.assertTrue(calls)
        for at in calls:
            self.assertTrue(handler < at < handler_end, JS[at - 80:at + 20])

    def test_the_url_carries_the_song_and_the_picture(self):
        for key in ("'play'", "'t'"):
            self.assertIn(f"searchParams.set({key}", PLAYER)
        self.assertIn("searchParams.set('viz'", JS)
        self.assertIn("'viz.' + k", JS)
        self.assertIn("'viz.video'", JS)
        # Song changes never add history entries: Back keeps meaning the previous page.
        self.assertNotIn("pushState", PLAYER)
        self.assertNotIn("pushState", JS)

    def test_the_background_layer_is_behind_everything_and_inert(self):
        layer = re.search(r'<div id="visualizer-bg"[^>]*>', SHELL)
        assert layer is not None, "partials/visualizer.html holds #visualizer-bg"
        self.assertIn('aria-hidden="true"', layer.group(0))
        self.assertIn("pointer-events-none", layer.group(0))
        self.assertIn("-z-10", layer.group(0))
        self.assertIn("html[data-visualizer-bg] #visualizer-bg", CSS)
        self.assertRegex(CSS, r"prefers-reduced-motion: reduce\)\s*\{\s*#visualizer-bg \{ display: none; \}")


if __name__ == "__main__":
    unittest.main()
