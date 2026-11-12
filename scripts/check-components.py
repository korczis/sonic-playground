#!/usr/bin/env python3
"""Prevent duplicate and dead UI components (rule project.ui-components).

  - every component in templates/components.html is defined once;
  - every component is used (called as {{ <name … /> }} in templates/ or in content/);
  - every component a template or a review calls exists;
  - no markup is duplicated between templates: a line of 100+ characters (an element with its
    classes) that appears in two different template files is a component waiting to be
    extracted; the same line twice in one file is reported too;
  - one formatter: no template fills an interface string's {placeholders} itself
    (replace(from="{…")); the `tr` component does, plural forms included.

    python3 scripts/check-components.py     exit 1 on any finding
"""
from __future__ import annotations

import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEMPLATES = ROOT / "templates"
DEFINE = re.compile(r"\{%\s*component\s+([a-z_]+)\s*\(")
CALL = re.compile(r"\{\{\s*<([a-z_]+)[\s/]")
MIN_LINE = 100
# Lines that are layout plumbing rather than a component (closing tags, Tera control lines).
IGNORE = re.compile(r"^\s*(\{%|\{#|</|<!--|\{\{\s*<)")  # a component call is reuse, not duplication
FORMAT = re.compile(r'replace\(from="\{')
TR_DEFINITION = re.compile(r"\{%\s*component\s+tr\(")


def main() -> int:
    problems: list[str] = []
    library = (TEMPLATES / "components.html").read_text(encoding="utf-8")
    defined = DEFINE.findall(library)
    for name in sorted({n for n in defined if defined.count(n) > 1}):
        problems.append(f"component {name} is defined {defined.count(name)} times")

    calls: dict[str, list[str]] = defaultdict(list)
    sources = sorted(TEMPLATES.rglob("*.html")) + sorted((ROOT / "content").rglob("*.md"))
    for path in sources:
        for name in CALL.findall(path.read_text(encoding="utf-8")):
            calls[name].append(path.relative_to(ROOT).as_posix())
    for name in sorted(set(defined) - set(calls)):
        problems.append(f"component {name} is defined but never used (remove it)")
    for name in sorted(set(calls) - set(defined)):
        problems.append(f"component {name} is called in {', '.join(sorted(set(calls[name])))} but not defined")

    seen: dict[str, list[str]] = defaultdict(list)
    for path in sorted(TEMPLATES.rglob("*.html")):
        if path.name == "components.html":
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            text = line.strip()
            if len(text) >= MIN_LINE and not IGNORE.match(text):
                seen[text].append(f"{path.relative_to(ROOT).as_posix()}:{number}")
    for text, where in sorted(seen.items(), key=lambda kv: kv[1]):
        if len(where) > 1:
            problems.append(f"duplicated markup ({len(where)}x: {', '.join(where)}): {text[:90]}…")

    # One formatter: an interface string's {placeholders} and plural form are filled only by the
    # `tr` component (and Sonic.t in the browser), never by a template's own replace().
    for path in sorted(TEMPLATES.rglob("*.html")):
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if FORMAT.search(line) and not TR_DEFINITION.search(line):
                problems.append(f"{path.relative_to(ROOT).as_posix()}:{number} formats an interface string "
                                f"by hand (replace(from=\"{{…\")); use {{{{ <tr key=… l={{l}} vars=… /> }}}}")

    for p in problems:
        print(f"check-components: {p}", file=sys.stderr)
    print(f"check-components: {len(set(defined))} components, {sum(len(v) for v in calls.values())} calls, "
          f"{len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
