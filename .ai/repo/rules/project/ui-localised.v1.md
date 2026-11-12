---
id: project.ui-localised
version: 1
kind: rule
title: Every interface string comes from the locale files and the language is switchable
description: Templates and browser code write no interface text; they use keys of data/i18n/<locale>.toml (default locale from config.toml), every locale carries every key with the same placeholders, and static/js/i18n.js switches the page without a reload.
statement: Write every interface string as a key in data/i18n/<locale>.toml for every locale, render it through the tx component or a data-i18n* attribute in templates and Sonic.t() in browser code, and keep scripts/i18n.py --check green; content (reviews, facet terms) is not interface and stays as written.
status: active
class: blocking
depends_on: [project.ui-components@1]
tags: [ui, i18n, localisation]
x-majordomus:
  tests: [scripts/i18n.py, test/e2e/smoke.cjs]
---

# Rationale

The owner asked for everything localised and switchable, with nothing hard-coded. A string written
in a template cannot be switched, translated or checked; a key can be all three.

# Required behaviour

- Strings: `data/i18n/en.toml` (default, `config.toml default_language`) and every other locale
  file, flat keys, `{name}` placeholders identical across locales.
- Templates: `{{ <tx key="…" l={l} vars={ {…} } /> }}` or an element with `data-i18n="key"`
  (`data-i18n-placeholder`, `-aria-label`, `-title`, `-alt` for attributes,
  `data-i18n-vars` for values). Components that show interface text take `l`.
- Browser code: `Sonic.t('key', vars)`; listen to `sonic:locale` to re-render.
- `scripts/i18n.py --check` (pre-commit, CI) refuses a missing, extra or empty key, a
  placeholder mismatch, a used key that does not exist, and a stale `static/data/i18n.json`;
  it reports keys nothing uses.
- A new locale is a new `data/i18n/<code>.toml`; the switcher lists it automatically.

# Failure behaviour

The pre-commit hook and CI stop on any finding of `scripts/i18n.py --check`; the smoke test
fails when switching does not translate templates and browser-written strings, or does not
survive navigation and a reload.

# Verification

```sh
python3 scripts/i18n.py --check
bash scripts/verify.sh
```
