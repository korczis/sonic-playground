---
schema: knowledge/v1
id: zola-023-tera2-idioms
kind: knowledge
class: lesson
title: "Zola 0.23 (Tera 2): components take {expressions}, see no page context, and several Tera 1 filters are gone"
description: "When writing or changing anything under templates/, or upgrading Zola."
status: verified
epistemics: observed
date: 2026-11-12
tags:
  - zola
  - templates
  - tera
provenance:
  origin: authored
---

# Zola 0.23 (Tera 2): components take {expressions}, see no page context, and several Tera 1 filters are gone

## What was observed

Building this site on Zola 0.23.4 (measured in a scratch site, 2026-11-12):

- A component is defined in `templates/components.html` with
  `{% component name(arg, opt="default") %}…{% endcomponent name %}` and called as
  `{{ <name arg="literal" other={expression} /> }}`. A bare `{{ x }}` or an integer as a prop is a
  parse error ("Expected \"string\" or {expression}"); spread (`...x`) is not supported.
- A component sees only its props and global functions (`get_url`, `get_taxonomy_url`,
  `load_data`): `config`, `page`, `section` are undefined inside it ("Variable `config` is not
  defined. Available variables: …"). Pass what it needs as props.
- `slice`, `map`, `filter` are unknown filters. Use subscript slicing (`items[:n]`, `items[1:3]`),
  `starting_with(pat=…)` tests, `get(key=…)`, `sort(attribute=…)`, `round | int`.
- A child template may hold only `extends`, `block` and `component` at the top level; Tera 1
  templates with anything else (even an HTML comment) fail.
- Inside `{{ … }}` a map literal ending in `}}` closes the expression early: write `} }`.
- `default(value=…)` replaces only an undefined value; a field present as `none` (an unset page
  `description`) still reaches a component typed as string and fails. Guard with `{% if %}`.
- `get_url(path="dir/")` drops the trailing slash unless `trailing_slash=true`; link pages by
  their source (`get_url(path="@/" ~ source)`) so the link checker validates them.
- `page.content` keeps root-absolute image URLs (`/images/x.png`); on a project Pages site
  (`/sonic-playground/`) they 404. `templates/page.html` rewrites them with
  `replace(from='src="/images/', to=…get_url(path="images", trailing_slash=true))`.

## How to apply

Read this before touching `templates/`. A new idiom confirmed in a build belongs here.
