#!/usr/bin/env python3
"""Prevent duplicate and dead UI components (rule project.ui-components).

  - every component in templates/components.html is defined once;
  - every component is used (called as {{ <name … /> }} in templates/ or in content/);
  - every component a template or a review calls exists;
  - no markup is duplicated between templates: a line of 100+ characters (an element with its
    classes) that appears in two different template files is a component waiting to be
    extracted; the same line twice in one file is reported too;
  - one formatter: no template fills an interface string's {placeholders} itself
    (replace(from="{…")); the `tr` component does, plural forms included;
  - one still: no template or review writes a YouTube still (i.ytimg.com) or a track's thumbnail
    as an <img> src itself; the `still` component does, with the srcset data/media.toml names;
  - no literal words in what assistive technology reads: an aria-label, title, alt, placeholder or
    aria-description of a template is empty or comes from a string (tr, l[...]), never typed in
    one language (Czech pages announced "Breadcrumb", "Main", "Site").

  - one page layout (rule project.page-layout): every page template opens its body with the
    `layout` component, no template types the gutter classes (px-4 with xl:px-8) itself, and long
    text renders only through `prose` (no template sets the bare `format` class).

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
STILL = re.compile(r'i\.ytimg\.com|src="\{\{[^"]*thumb')
SPOKEN = re.compile(r'\s(aria-label|aria-description|title|alt|placeholder)="([^"{]+)"')
# The Flowbite Pro verifier (~/.claude/skills/flowbite-pro/verify.mjs) recognises the Pro shell by
# these English landmark names in the template; they stay literal and i18n.js translates them in
# the browser, so each must carry its data-i18n-aria-label. The Majordomus half (the kit's
# recognition of localised landmarks) is issue I4594 in prismatic-majordomus (milestone
# one-kit-on-every-surface, korczis/prismatic-majordomus#3034); the verify.mjs half is the
# owner's. Once both accept a localised name, this set and its exemption go.
PRO_ANCHORS = {"Sidebar", "Breadcrumb"}
COMMENT = re.compile(r"\{#.*?#\}", re.S)
CLASS = re.compile(r'class="([^"]*)"')
GUTTER = (re.compile(r"(?:^|\s)px-4(?:\s|$)"), re.compile(r"(?:^|\s)xl:px-8(?:\s|$)"))
BARE_FORMAT = re.compile(r"(?:^|\s)format(?:\s|$)")
LAYOUT_DEFINITION = re.compile(r"\{%\s*component\s+(layout|prose)\((.*?)\{%\s*endcomponent\s+\1\s*%\}", re.S)
LAYOUT_CALL = re.compile(r'\{\{\s*<layout\s+part="(gutter|body)"')
STILL_DEFINITION = re.compile(r"\{%\s*component\s+still\((.*?)\{%\s*endcomponent\s+still\s*%\}", re.S)


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

    # One still: a YouTube still or a track's thumbnail reaches an <img> only through `still`, which
    # offers every still data/media.toml [youtube] names as a srcset sized for the page.
    for path in sources:
        text = path.read_text(encoding="utf-8")
        if path.name == "components.html":
            text = STILL_DEFINITION.sub(lambda m: "\n" * m.group(0).count("\n"), text)
        for number, line in enumerate(text.splitlines(), 1):
            if STILL.search(line):
                problems.append(f"{path.relative_to(ROOT).as_posix()}:{number} writes a still by hand; "
                                f"use <img {{{{ <still t={{t}} sizes=\"…\" /> }}}} …>")

    # Spoken words come from strings: a literal accessible name is in one language on every page.
    for path in sorted(TEMPLATES.rglob("*.html")):
        text = COMMENT.sub(lambda m: "\n" * m.group(0).count("\n"), path.read_text(encoding="utf-8"))
        for number, line in enumerate(text.splitlines(), 1):
            for attr, value in SPOKEN.findall(line):
                if attr == "aria-label" and value in PRO_ANCHORS and "data-i18n-aria-label=" in line:
                    continue
                if value.strip():
                    problems.append(f"{path.relative_to(ROOT).as_posix()}:{number} {attr}=\"{value}\" is typed in one "
                                    f"language; use {attr}=\"{{{{ <tr key=… l={{l}} /> }}}}\" data-i18n-{attr}=\"…\"")

    problems += layout_problems()

    for p in problems:
        print(f"check-components: {p}", file=sys.stderr)
    print(f"check-components: {len(set(defined))} components, {sum(len(v) for v in calls.values())} calls, "
          f"{len(problems)} problem(s)")
    return 1 if problems else 0


def layout_problems(templates: Path = TEMPLATES) -> list[str]:
    """One page layout: the gutter and the text box come only from `layout` and `prose`, and every
    page template (one that extends base.html) opens its body with `layout`."""
    problems: list[str] = []
    for path in sorted(templates.rglob("*.html")):
        text = COMMENT.sub(lambda m: "\n" * m.group(0).count("\n"), path.read_text(encoding="utf-8"))
        if path.name == "components.html":
            text = LAYOUT_DEFINITION.sub(lambda m: "\n" * m.group(0).count("\n"), text)
        name = path.relative_to(templates.parent).as_posix()
        if '{% extends "base.html" %}' in text and not LAYOUT_CALL.search(text):
            problems.append(f"{name} does not open its body with {{{{ <layout part=\"body\" /> }}}}")
        for number, line in enumerate(text.splitlines(), 1):
            for classes in CLASS.findall(line):
                if all(g.search(classes) for g in GUTTER):
                    problems.append(f"{name}:{number} types the page gutter (px-4 … xl:px-8); use "
                                    f"class=\"{{{{ <layout part=\"gutter\" /> }}}} …\"")
                if BARE_FORMAT.search(classes):
                    problems.append(f"{name}:{number} sets the typography box itself; use "
                                    f"{{{{ <prose html={{…}} /> }}}}")
    return problems


if __name__ == "__main__":
    sys.exit(main())
