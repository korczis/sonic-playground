"""The unit suite with line coverage of scripts/ (rule project.new-code-tested).

    python3 test/pycov.py <out.json>      runs `unittest discover -s test -p 'test_*.py'`

It records, through sys.monitoring (Python 3.12+, about as fast as the suite alone: each line is
reported once and then disabled), which lines of scripts/*.py ran, and lists each file's
executable lines from its compiled code objects. scripts/coverage.mjs judges a change's lines
against both. A script run in a subprocess by a test is not seen: a line only a skill case
reaches needs a unit test of its own, or a written reason. The exit code is the suite's.
"""

import json
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"


def executable(path: Path) -> list[int]:
    """Every line number a code object of the file maps an instruction to."""
    lines: set[int] = set()

    def walk(code: types.CodeType) -> None:
        # Python 3.14 compiles annotations into a lazy __annotate__ (PEP 649) that only runs when
        # someone reads them: a signature's continuation line lives there and never "runs".
        if code.co_name == "__annotate__":
            return
        for _, _, line in code.co_lines():
            if line is not None:
                lines.add(line)
        for const in code.co_consts:
            if isinstance(const, types.CodeType):
                walk(const)

    try:
        walk(compile(path.read_text(encoding="utf-8"), str(path), "exec"))
    except SyntaxError:
        return []
    return sorted(lines)


def main() -> int:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    mon = sys.monitoring
    tool = mon.COVERAGE_ID
    ran: dict[str, set[int]] = {}
    prefix = str(SCRIPTS) + "/"

    def on_line(code: types.CodeType, line: int):
        if code.co_filename.startswith(prefix):
            ran.setdefault(code.co_filename, set()).add(line)
        return mon.DISABLE

    mon.use_tool_id(tool, "pycov")
    mon.register_callback(tool, mon.events.LINE, on_line)
    mon.set_events(tool, mon.events.LINE)
    try:
        suite = unittest.defaultTestLoader.discover(str(ROOT / "test"), pattern="test_*.py")
        result = unittest.TextTestRunner(verbosity=1).run(suite)
    finally:
        mon.set_events(tool, 0)
        mon.free_tool_id(tool)
    if out:
        report = {}
        for path in sorted(SCRIPTS.glob("*.py")):
            report[path.relative_to(ROOT).as_posix()] = {
                "executable": executable(path),
                "executed": sorted(ran.get(str(path), set())),
            }
        out.write_text(json.dumps(report), encoding="utf-8")
        print(f"pycov: {len(report)} script(s), {sum(len(v) for v in ran.values())} line(s) ran -> {out}")
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
