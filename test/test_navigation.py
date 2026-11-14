"""Every in-site navigation of the browser code goes through the router (rule
project.navigation-integrity): a full page load drops the persistent player, so a chart click
used to stop the music (an independent review, 2026-11-14).

A line of static/js/ (the vendored libraries aside) that assigns location (location.href =,
location.assign, location.replace) is allowed only in router.js, when it names window.SonicRouter
(the guarded fallback idiom), or with a `// full load:` comment that says why.
"""

import re
import unittest
from pathlib import Path

JS = Path(__file__).resolve().parent.parent / "static" / "js"
ASSIGN = re.compile(r"location\.href\s*=(?!=)|location\.(assign|replace)\(")


def offenders(files):
    found = []
    for path in files:
        if path.name == "router.js":
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if ASSIGN.search(line) and "SonicRouter" not in line and "// full load:" not in line:
                found.append(f"{path.name}:{number}: {line.strip()}")
    return found


class Navigation(unittest.TestCase):
    def test_browser_code_navigates_through_the_router(self):
        files = sorted(p for p in JS.glob("*.js") if not p.name.startswith(("echarts", "flowbite")))
        self.assertTrue(files)
        self.assertEqual(offenders(files), [])

    def test_a_bare_assignment_is_found(self):
        probe = JS.parent.parent / "test" / "_probe_navigation.js"
        try:
            probe.write_text("function go(url) { window.location.href = url; }\n", encoding="utf-8")
            self.assertEqual(len(offenders([probe])), 1)
        finally:
            probe.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
