"""Unit tests of the plural contract of the interface strings (scripts/i18n.py, data/i18n/).

  - every locale's declared rule ("locale.plural") is CLDR's: equal to Intl.PluralRules for every
    integer count up to COUNTS (node is a requirement of the build: Tailwind, the smoke test);
  - the gate refuses each way a count string can be wrong, for exactly that reason;
  - the real locales pass, and their forms read as expected at the edges (1, 2-4, 5, 21).

    python3 -m unittest discover -s test -p 'test_*.py'
"""
import copy
import json
import subprocess
import sys
import unittest
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import importlib  # noqa: E402

i18n: Any = importlib.import_module("i18n")
COUNTS = 10_000  # more tracks, terms or words than the site will show on one string


def cldr(code: str) -> list[str]:
    script = ("const r = new Intl.PluralRules(process.argv[1]); const out = [];"
              f"for (let n = 0; n <= {COUNTS}; n++) out.push(r.select(n));"
              "console.log(JSON.stringify(out));")
    run = subprocess.run(["node", "-e", script, code], capture_output=True, text=True, check=True)
    return json.loads(run.stdout)


class PluralRules(unittest.TestCase):
    def test_every_locale_declares_cldr(self) -> None:
        locales = i18n.load()
        self.assertGreaterEqual(len(locales), 2)
        for code, strings in locales.items():
            rule = strings[i18n.PLURAL]
            want = cldr(code)
            got = [next((cat for cat, ns in rule.items() if n in ns), "other") for n in range(COUNTS + 1)]
            wrong = [(n, got[n], want[n]) for n in range(COUNTS + 1) if got[n] != want[n]]
            self.assertEqual(wrong[:5], [], f"{code}: locale.plural differs from CLDR (n, declared, CLDR)")
            self.assertEqual(i18n.plural_forms(rule), set(want), f"{code}: the forms a count string needs")

    def test_real_forms_at_the_edges(self) -> None:
        locales = i18n.load()
        cs, en = locales["cs"], locales["en"]
        read = lambda s, key, n: i18n.plural(s[key], n, s[i18n.PLURAL]).replace("{n}", str(n))  # noqa: E731
        self.assertEqual([read(cs, "tax.count", n) for n in (1, 2, 4, 5, 21)],
                         ["1 skladba.", "2 skladby.", "4 skladby.", "5 skladeb.", "21 skladeb."])
        self.assertEqual([read(en, "tax.count", n) for n in (0, 1, 2)], ["0 tracks.", "1 track.", "2 tracks."])


class Gate(unittest.TestCase):
    """Each negative case is the real locales with one thing broken."""

    def setUp(self) -> None:
        self.locales = i18n.load()
        self.default = i18n.default_locale()

    def errors(self, locales: dict) -> list[str]:
        return i18n.check(locales, self.default)[0]

    def test_real_locales_pass(self) -> None:
        self.assertEqual(self.errors(self.locales), [])

    def broken(self, code: str, key: str, value: Any) -> list[str]:
        locales = copy.deepcopy(self.locales)
        locales[code][key] = value
        return self.errors(locales)

    def test_a_count_in_one_fixed_form_is_refused(self) -> None:
        errs = self.broken("en", "tax.count", "{n} tracks.")
        self.assertTrue(any("counts {n} in one fixed form" in e for e in errs), errs)

    def test_a_hedge_is_refused(self) -> None:
        errs = self.broken("en", "tax.count", {"one": "{n} track(s).", "other": "{n} track(s)."})
        self.assertTrue(any("hedges a plural (k(s))" in e for e in errs), errs)
        errs = self.broken("cs", "tax.count", {"one": "{n} skladba.", "few": "{n} skladba(y).", "other": "{n} skladeb."})
        self.assertTrue(any("hedges a plural" in e for e in errs), errs)

    def test_a_missing_form_is_refused(self) -> None:
        errs = self.broken("cs", "tax.count", {"one": "{n} skladba.", "other": "{n} skladeb."})
        self.assertTrue(any("cs: tax.count has the plural forms ['one', 'other']" in e for e in errs), errs)

    def test_a_form_without_the_count_is_refused(self) -> None:
        errs = self.broken("cs", "tax.count", {"one": "Jedna skladba.", "few": "{n} skladby.", "other": "{n} skladeb."})
        self.assertTrue(any("cs: tax.count has placeholders []" in e for e in errs), errs)

    def test_a_table_without_a_count_is_refused(self) -> None:
        locales = copy.deepcopy(self.locales)
        for code in locales:
            locales[code]["player.played"] = {f: "Played" for f in i18n.plural_forms(locales[code][i18n.PLURAL])}
        errs = self.errors(locales)
        self.assertTrue(any("player.played is a plural table without the count {n}" in e for e in errs), errs)

    def test_a_bad_rule_is_refused(self) -> None:
        for rule, why in (({"one": [1], "lots": [5]}, "'lots' is not a CLDR category"),
                          ({"one": [1], "few": [1, 2]}, "an integer is in two categories"),
                          ({"one": ["1"]}, "must list non-negative integers"),
                          (None, "locale.plural is missing")):
            errs = self.broken("cs", i18n.PLURAL, rule)
            self.assertTrue(any(why in e for e in errs), (why, errs))


if __name__ == "__main__":
    unittest.main()
