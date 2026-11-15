"""No script that sets pipefail ends a pipeline in an unguarded `head`.

`head` exits after its lines; the command feeding it then dies of SIGPIPE as soon as its output
outgrows the pipe buffer, and pipefail turns that into the script's failure. Case 65 failed this
way, intermittently, once the reviews' file list grew past the buffer (2026-11-15). A pipeline
ending in `head` is allowed only with `|| true` on the same line.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UNGUARDED = re.compile(r"\|\s*head\b(?!.*\|\|\s*true)")


def offenders(texts: dict[str, str]) -> list[str]:
    found = []
    for name, text in texts.items():
        if "pipefail" not in text:
            continue
        for n, line in enumerate(text.splitlines(), 1):
            code = line.split("#", 1)[0]
            if UNGUARDED.search(code):
                found.append(f"{name}:{n}")
    return found


class ShellPipes(unittest.TestCase):
    def test_no_unguarded_head_under_pipefail(self):
        paths = (sorted(ROOT.glob("test/cases/*.sh")) + sorted(ROOT.glob("scripts/*.sh"))
                 + [ROOT / "test/run.sh"])
        texts = {str(p.relative_to(ROOT)): p.read_text(encoding="utf-8")
                 for p in paths if p.exists()}
        self.assertGreater(len(texts), 5)
        self.assertEqual(offenders(texts), [])

    def test_negative_control_the_old_case_65_line_is_refused(self):
        old = "set -euo pipefail\nreview=$(git ls-files 'content/*.md' | grep -v x | head -1)\n"
        self.assertEqual(offenders({"65": old}), ["65:2"])

    def test_a_guarded_head_and_a_comment_are_allowed(self):
        ok = "set -o pipefail\nnpm ls | grep ERR | head -5 >&2 || true\n# a note about | head -1\n"
        self.assertEqual(offenders({"ok": ok}), [])


if __name__ == "__main__":
    unittest.main()
