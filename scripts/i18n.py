#!/usr/bin/env python3
"""The interface strings: one TOML file per locale (data/i18n/<locale>.toml), checked and bundled.

  - every locale has exactly the keys of the default locale (config.toml default_language);
  - no value is empty unless it is empty in the default too, and every value uses exactly the
    placeholders ({name}) the default's value uses;
  - plurals: every locale declares its plural rule for integer counts, "locale.plural" (CLDR
    category -> the integers it takes, every other integer "other"; test/test_i18n.py proves it
    equal to Intl.PluralRules). A string with the count {n} is a table of exactly the locale's
    forms ({ one = "{n} track", other = "{n} tracks" }), chosen for n by templates/components.html
    `tr` and static/js/i18n.js alike; a number with no noun to agree with is {total}, and a
    hedge such as "track(s)" is refused;
  - every key the templates and the browser code use exists: l["key"] and data-i18n*="key" in
    templates/, t('key') in static/js/; a key nothing uses is reported (a dead string);
  - static/data/i18n.json (sonic-i18n/v1) bundles every locale for static/js/i18n.js and for the
    templates, which read the strings of the page's own language from it (ADR 0006). The bundle
    adds what is derived, never written: "lang" (the locale's code) and a label for every taxonomy
    term in use, "term.<facet>.<term>": the term itself in the default locale, its label from
    data/i18n/terms/<locale>.toml (a concept's from data/concepts/<slug>.toml) in every other;
    a term in use without a label is an error.

    python3 scripts/i18n.py           write static/data/i18n.json
    python3 scripts/i18n.py --check   exit 1 on any finding or a stale bundle
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCALES = ROOT / "data" / "i18n"
TERMS = LOCALES / "terms"
CONCEPTS = ROOT / "data" / "concepts"
CATALOG = ROOT / "static" / "data" / "catalog.json"
BUNDLE = ROOT / "static" / "data" / "i18n.json"
PLACEHOLDER = re.compile(r"\{([a-z_]+)\}")
USES = [
    (ROOT / "templates", "*.html", re.compile(r'l\["([a-z0-9_.]+)"\]|data-i18n(?:-[a-z-]+)?="([a-z0-9_.]+)"')),
    (ROOT / "static" / "js", "*.js", re.compile(r"\bt\('([a-z0-9_.]+)'")),
]
# Keys composed at run time from a known prefix and a facet or chart name; their full forms are
# listed here so the check can prove them (and does, below).
# The facets come from the content contract's taxonomies, so a new taxonomy needs its strings.
CONTRACT = json.loads((ROOT / "data" / "track.schema.json").read_text(encoding="utf-8"))
FACET_NAMES = list(CONTRACT["properties"]["taxonomies"]["properties"])
EXTRA = CONTRACT["properties"]["extra"]["properties"]
CONCEPT_CATEGORIES = json.loads((ROOT / "data" / "concept.schema.json").read_text(encoding="utf-8"))[
    "properties"]["category"]["enum"]
DYNAMIC = {
    "side.all.": ["genre", "sentiment"], "side.": ["genre", "sentiment"],
    "explorer.facet.": FACET_NAMES, "explorer.any.": FACET_NAMES,
    "explorer.sort.": ["new", "old", "artist", "title"],
    "tax.name.": FACET_NAMES, "tax.one.": FACET_NAMES,
    "concept.category.": CONCEPT_CATEGORIES,
    "yearbook.status.": ["present", "missing", "ambiguous", "skipped", "uncertain"],
    "yearbook.k.": ["items", "songs", "present", "missing"],
    "track.": ["album", "release_year", "publisher", "video_duration", "country", "bpm", "key",
               "time_signature", "isrc"],
    "track.credits.": list(EXTRA["credits"]["properties"]),
    "learn.level.": EXTRA["learning"]["properties"]["level"]["enum"],
    "learn.kind.": EXTRA["sources"]["items"]["properties"]["kind"]["enum"],
    "menu.": [m["key"].split(".", 1)[1] for m in tomllib.loads(
        (ROOT / "config.toml").read_text(encoding="utf-8"))["extra"]["menu"]],
    "player.": ["play", "pause"],
    "yearbook.page_": ["title", "description"],  # scripts/catalog.py, the derived yearbook pages
}


def default_locale() -> str:
    return tomllib.loads((ROOT / "config.toml").read_text(encoding="utf-8"))["default_language"]


def load() -> dict[str, dict]:
    return {p.stem: tomllib.loads(p.read_text(encoding="utf-8")) for p in sorted(LOCALES.glob("*.toml"))}


def terms_in_use() -> dict[str, list[str]]:
    """Every term of every facet the catalogue lists, and every concept of the glossary."""
    facets = json.loads(CATALOG.read_text(encoding="utf-8"))["facets"] if CATALOG.exists() else {}
    out = {kind: sorted({f["term"] for f in facets.get(kind, [])}) for kind in FACET_NAMES}
    out["concept"] = sorted(set(out.get("concept", [])) | {
        tomllib.loads(p.read_text(encoding="utf-8"))["term"] for p in CONCEPTS.glob("*.toml")})
    return out


def derived(code: str, default: str, errors: list[str]) -> dict[str, str]:
    """The strings of a locale nobody writes by hand: its code and the label of every term."""
    out = {"lang": code}
    labels = tomllib.loads((TERMS / f"{code}.toml").read_text(encoding="utf-8")) if (TERMS / f"{code}.toml").exists() else {}
    concepts = {}
    for p in CONCEPTS.glob("*.toml"):
        c = tomllib.loads(p.read_text(encoding="utf-8"))
        concepts[c["term"]] = c.get(code, {}).get("term", "")
    for kind, terms in terms_in_use().items():
        for term in terms:
            if code == default:
                label = term
            elif kind == "concept":
                label = concepts.get(term, "")
                if not label:
                    errors.append(f"{code}: concept '{term}' has no [{code}] term (data/concepts/)")
            else:
                label = labels.get(kind, {}).get(term, "")
                if not label:
                    errors.append(f"{code}: {kind} '{term}' has no label in data/i18n/terms/{code}.toml")
            out[f"term.{kind}.{term}"] = label or term
    if code != default:
        for kind, table in labels.items():
            for term in sorted(set(table) - set(terms_in_use().get(kind, []))):
                errors.append(f"{code}: data/i18n/terms/{code}.toml labels {kind} '{term}', which no review uses")
    return out


COMPONENT_KEY = re.compile(r'\b(key|lkey|tkey|xkey|ckey|lead_key)="([a-z0-9_.]+)"')

# Plurals (CLDR categories). A locale declares its rule for integer counts as "locale.plural":
# category -> the integers it takes, every other integer is "other" ({ one = [1], few = [2, 3, 4] }
# for Czech). templates/components.html `tr` and static/js/i18n.js read that one table;
# test/test_i18n.py proves it equal to Intl.PluralRules (CLDR) for every count the site can show.
PLURAL = "locale.plural"
CATEGORIES = ("zero", "one", "two", "few", "many")
# "track(s)", "skladba(y)": a plural written as a hedge instead of its forms.
HEDGE = re.compile(r"\w\((?:s|es|ies|y|ů|ek|a|i|e|ch)\)")


def placeholders(value: object) -> set[str]:
    texts = value.values() if isinstance(value, dict) else [value]
    return {name for text in texts if isinstance(text, str) for name in PLACEHOLDER.findall(text)}


def rule_problems(rule: object) -> list[str]:
    if not isinstance(rule, dict):
        return [f"{PLURAL} is missing: the table category -> integers of the locale's plural rule"]
    out = []
    for cat, numbers in rule.items():
        if cat not in CATEGORIES:
            out.append(f"{PLURAL}: '{cat}' is not a CLDR category {CATEGORIES} ('other' is implied)")
        if not isinstance(numbers, list) or not all(isinstance(n, int) and n >= 0 for n in numbers):
            out.append(f"{PLURAL}: '{cat}' must list non-negative integers")
    taken = [n for numbers in rule.values() if isinstance(numbers, list) for n in numbers]
    if len(taken) != len(set(taken)):
        out.append(f"{PLURAL}: an integer is in two categories")
    return out


def plural_forms(rule: object) -> set[str]:
    return (set(rule) if isinstance(rule, dict) else set()) | {"other"}


def plural(value: object, n: int, rule: dict[str, list[int]]) -> str:
    """The form of a count string for n: the Python twin of `tr` and Sonic.t (for tests and tools)."""
    if not isinstance(value, dict):
        return str(value)
    for cat, numbers in rule.items():
        if n in numbers and cat in value:
            return value[cat]
    return value["other"]


def used_keys() -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    for folder, pattern, regex in USES:
        for path in sorted(folder.rglob(pattern)):
            text = path.read_text(encoding="utf-8")
            if path.suffix == ".js":  # a comment's example is not a use
                text = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("//"))
            where = path.relative_to(ROOT).as_posix()
            for match in regex.finditer(text):
                found.setdefault(next(g for g in match.groups() if g), []).append(where)
            if path.suffix == ".html":
                # component props: <tx key="…">, lkey/xkey (a label), tkey (chart: .title, .caption)
                for prop, key in COMPONENT_KEY.findall(text):
                    keys = [key + ".title", key + ".caption"] if prop == "ckey" else [key]
                    for k in keys:
                        found.setdefault(k, []).append(where)
    for prefix, names in DYNAMIC.items():
        for name in names:
            found.setdefault(prefix + name, []).append("(composed at run time)")
    return found


def check(locales: dict[str, dict], default: str) -> tuple[list[str], list[str]]:
    errors, notices = [], []
    if default not in locales:
        return [f"data/i18n/{default}.toml is missing (config.toml default_language)"], notices
    base = locales[default]
    for code, strings in locales.items():
        errors += [f"{code}: {e}" for e in rule_problems(strings.get(PLURAL))]
        forms = plural_forms(strings.get(PLURAL))
        for key in sorted(set(base) - set(strings)):
            errors.append(f"{code}: missing key {key}")
        for key in sorted(set(strings) - set(base)):
            errors.append(f"{code}: key {key} is not in {default}")
        for key in sorted((set(base) & set(strings)) - {PLURAL}):
            value, want = strings[key], placeholders(base[key])
            texts = value.values() if isinstance(value, dict) else [value]
            if isinstance(value, dict):
                if set(value) != forms:
                    errors.append(f"{code}: {key} has the plural forms {sorted(value)}, the locale's rule "
                                  f"({PLURAL}) has {sorted(forms)}")
                if "n" not in want:
                    errors.append(f"{code}: {key} is a plural table without the count {{n}}")
            elif not isinstance(value, str):
                errors.append(f"{code}: {key} is neither a string nor a table of plural forms")
                continue
            elif "n" in want:
                errors.append(f"{code}: {key} counts {{n}} in one fixed form; a count string is a table "
                              f"of the plural forms {sorted(forms)} (a number with no noun to agree with "
                              f"is {{total}})")
            for text in texts:
                if not isinstance(text, str):
                    errors.append(f"{code}: {key} has a plural form that is not a string")
                    continue
                if not text and any(base[key].values() if isinstance(base[key], dict) else [base[key]]):
                    errors.append(f"{code}: {key} is empty")
                if set(PLACEHOLDER.findall(text)) != want:
                    errors.append(f"{code}: {key} has placeholders {sorted(set(PLACEHOLDER.findall(text)))}, "
                                  f"{default} has {sorted(want)}")
                hedge = HEDGE.search(text)
                if hedge:
                    errors.append(f"{code}: {key} hedges a plural ({hedge.group(0)}); write "
                                  f"the forms out as a plural table")
    used = used_keys()
    for key, where in sorted(used.items()):
        if key not in base and key != "lang":
            errors.append(f"key {key} used in {', '.join(sorted(set(where)))} is not in data/i18n/{default}.toml")
    for key in sorted(set(base) - set(used)):
        if not key.startswith("locale."):
            notices.append(f"key {key} is not used anywhere")
    return errors, notices


def render(locales: dict[str, dict], default: str, errors: list[str] | None = None) -> str:
    errors = [] if errors is None else errors
    return json.dumps({
        "schema": "sonic-i18n/v1", "generated_by": "scripts/i18n.py", "default": default,
        "locales": {code: {"name": s["locale.name"], "short": s["locale.short"],
                           "strings": {**s, **derived(code, default, errors)}}
                    for code, s in locales.items()},
    }, ensure_ascii=False, indent=0, sort_keys=True) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    default = default_locale()
    locales = load()
    errors, notices = check(locales, default)
    text = render(locales, default, errors)
    for n in notices:
        print(f"i18n: notice: {n}", file=sys.stderr)
    for e in errors:
        print(f"i18n: {e}", file=sys.stderr)
    if errors:
        print(f"i18n: {len(errors)} problem(s)", file=sys.stderr)
        return 1
    if args.check:
        if not BUNDLE.exists() or BUNDLE.read_text(encoding="utf-8") != text:
            print("i18n: static/data/i18n.json is stale; run python3 scripts/i18n.py", file=sys.stderr)
            return 1
        print(f"i18n: {len(locales)} locales, {len(locales[default])} keys, consistent and bundled")
        return 0
    BUNDLE.write_text(text, encoding="utf-8")
    print(f"i18n: wrote {BUNDLE.relative_to(ROOT)} ({', '.join(locales)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
