---
id: project.ui-localised
version: 1
kind: rule
title: Every page and every interface string exists in every language of the site
description: The site is bilingual (ADR 0006). Interface strings are keys of data/i18n/<locale>.toml; every page has its translation beside it (<name>.<lang>.md), current and structurally equal to its English page; every taxonomy term in use has a label in every language; the language switch opens a page's counterpart.
statement: Write every interface string as a key in data/i18n/<locale>.toml for every locale, render it through the tr/tx components or a data-i18n* attribute in templates and Sonic.t() in browser code, a count as a table of the locale's plural forms; give every page its translation in every language of config.toml (skill translate) and every term in use its label (data/i18n/terms/<lang>.toml, data/concepts/<slug>.toml); keep scripts/i18n.py --check and scripts/catalog.py --check green.
status: active
class: blocking
depends_on: [project.ui-components@1]
tags: [ui, i18n, localisation, content]
x-majordomus:
  tests: [scripts/i18n.py, scripts/catalog.py, scripts/check-components.py, test/test_i18n.py, test/test_translation.py, test/e2e/smoke.cjs]
---

# Rationale

The owner asked for everything localised and switchable, with nothing hard-coded (2026-11-12), and
then for the whole site to be bilingual: every page, review, description and term in Czech and
English, the language chosen automatically, all of it tested. A string written in a template
cannot be switched, translated or checked; a key can be all three. A page that exists in one
language only cannot be linked, shared or found in the other (ADR 0006).

# Required behaviour

- Strings: `data/i18n/en.toml` (default, `config.toml default_language`) and every other locale
  file, flat keys, `{name}` placeholders identical across locales.
- Plurals (CLDR): every locale declares `"locale.plural"`, its rule for integer counts (category
  -> the integers it takes, every other integer `other`), proven equal to `Intl.PluralRules` by
  `test/test_i18n.py`. A string with the count `{n}` is a table of exactly the locale's forms
  (`{ one = "{n} track", other = "{n} tracks" }`); a number with no noun to agree with is
  `{total}`; a hedge such as "track(s)" is refused. One formatter fills a string: the `tr`
  component (bare, for attributes and `{% set %}` blocks; `tx` wraps it in a switchable span) and
  `Sonic.t` read the same rule; `scripts/check-components.py` refuses any template that fills
  `{placeholders}` itself.
- Templates: `{{ <tx key="…" l={l} vars={ {…} } /> }}` or an element with `data-i18n="key"`
  (`data-i18n-placeholder`, `-aria-label`, `-title`, `-alt` for attributes,
  `data-i18n-vars` for values). Components that show interface text take `l`.
- Browser code: `Sonic.t('key', vars)`; listen to `sonic:locale` to re-render.
- `scripts/i18n.py --check` (pre-commit, CI) refuses a missing, extra or empty key, a
  placeholder mismatch, a used key that does not exist, and a stale `static/data/i18n.json`;
  it reports keys nothing uses.
- Pages (ADR 0006): English at the root, every other language of `config.toml [languages]` under
  `/<lang>/`. A page's translation is `<name>.<lang>.md` beside it and holds only language; facts
  stay in the English file and the template reads them from there. `scripts/catalog.py --check`
  (through `scripts/translation.py`) refuses a translation that is stale (`extra.translation.of`),
  whose date, taxonomies, connections, learning shape, components or headings differ from the
  English page's, whose content links lack `lang="<lang>"`, that keeps a scaffold marker or an
  English paragraph, or that does not read as the language; with `x-sonic.translation.required` it
  refuses a missing one. Skill `translate`, tool `scripts/translate.py`.
- Terms keep one identity in every language (`/genre/house/`, `/cs/genre/house/`); a label is
  data (`data/i18n/terms/<lang>.toml`, `[<lang>] term` of a concept), bundled by `scripts/i18n.py`
  as `term.<facet>.<term>`; a term in use without a label is an error.
- The switch links each page's counterpart (`<link rel="alternate" hreflang>`, `data-locale-href`)
  and is remembered; the default language's home page takes a browser that prefers another
  language there on a first visit; no other URL redirects.
- A new locale is a new `data/i18n/<code>.toml`, `data/i18n/terms/<code>.toml` and
  `[languages.<code>]` in `config.toml`; the switcher lists it automatically.

# Failure behaviour

The pre-commit hook and CI stop on any finding of `scripts/i18n.py --check` or
`scripts/catalog.py --check`; `test/test_translation.py` proves each refusal on a broken copy of
a real translation; the smoke test fails when the root does not take a Czech-preferring browser to
`/cs/`, a Czech URL redirects, the switch does not open the counterpart under the persistent
player or is not remembered, or any page of either language logs a console error.

# Verification

```sh
python3 scripts/i18n.py --check
python3 scripts/catalog.py --check
python3 scripts/translate.py status
bash scripts/verify.sh
```
