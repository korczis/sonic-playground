#!/usr/bin/env python3
"""Translations of the site's pages (ADR 0006): every content page has its counterpart in every
language of config.toml beside it, <name>.<lang>.md. The contract is scripts/translation.py; this
is the tool a translator (a person or the translator agent) works with.

    python3 scripts/translate.py status [--lang cs] [--json]
        every page and review: missing, stale (the English changed since), or current
    python3 scripts/translate.py scaffold <content/x.md>... [--lang cs] [--missing]
        write the translation's skeleton: the derived parts filled in (date, taxonomies, the
        structure, the English text it translates), every text marked TODO(translate) in English,
        which the contract refuses until it is translated; an existing translation is never touched
    python3 scripts/translate.py check <content/x.cs.md>...
        the contract on these translations only (what a translator runs; catalog.py --check runs
        it on all of them): exit 1 with every problem, 0 when each is a complete translation
    python3 scripts/translate.py bless <content/x.cs.md>...
        record that the translation translates the English page as it is now (extra.translation.of)
    python3 scripts/translate.py sync [--lang cs]
        rewrite every translation's date and taxonomies from its English page
    python3 scripts/translate.py batches N [--lang cs]
        the reviews still to translate (missing or stale), as JSON, in N balanced batches
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import catalog as cat  # noqa: E402
import translation as tr  # noqa: E402

MARK = cat.TRANSLATION["untranslated_marker"]


def toml_value(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        if v and all(isinstance(x, dict) for x in v):
            return "[\n" + "".join(f"  {toml_value(x)},\n" for x in v) + "]"
        return "[" + ", ".join(toml_value(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{ " + ", ".join(f"{json.dumps(k) if not re.fullmatch(r'[A-Za-z0-9_-]+', k) else k} = {toml_value(x)}"
                                for k, x in v.items()) + " }"
    raise TypeError(v)


def table(name: str, d: dict) -> str:
    lines = [f"[{name}]"]
    for k, v in d.items():
        key = k if re.fullmatch(r"[A-Za-z0-9_-]+", k) else json.dumps(k)
        lines.append(f"{key} = {toml_value(v)}")
    return "\n".join(lines)


def english_of(path: Path) -> Path:
    name, _ = tr.split_name(path.name)
    return path.with_name(name)


def read(path: Path) -> tuple[dict, str]:
    raw, body = cat.split_front_matter(path.read_text(encoding="utf-8"), path.name)
    return tomllib.loads(raw), body


def is_review(path: Path) -> bool:
    return path.parent == cat.CONTENT and path.name != "_index.md"


def marked(text: str) -> str:
    return f"{MARK} {text}" if text else text


def scaffold_text(src: Path, lang: str) -> str:
    meta, body = read(src)
    of = tr.prose_hash(meta, body)
    if not is_review(src):
        # A page or a section: every key as in English but its words, which wait for a translator.
        out = {k: v for k, v in meta.items() if k not in ("extra", "taxonomies")}
        out["title"] = marked(str(meta.get("title", "")))
        if meta.get("description"):
            out["description"] = marked(str(meta["description"]))
        if meta.get("path"):  # Zola does not prefix a custom path with the language
            out["path"] = f"{lang}/{meta['path']}"
        head = [f"{k} = {toml_value(v)}" for k, v in out.items()]
        tables = []
        if meta.get("taxonomies"):
            tables.append(table("taxonomies", meta["taxonomies"]))
        extra = {k: v for k, v in (meta.get("extra") or {}).items()}
        tables.append(table("extra", {k: v for k, v in extra.items() if not isinstance(v, dict)}))
        for k, v in extra.items():
            if isinstance(v, dict):
                tables.append(table(f"extra.{k}", v))
        tables.append(table("extra.translation", {"of": of}))
        return "+++\n" + "\n".join(head) + "\n\n" + "\n\n".join(tables) + "\n+++\n" + f"{MARK}\n\n" + tr.localise_links(body.lstrip("\n"), lang)
    extra = meta.get("extra") or {}
    learning = extra.get("learning") or {}
    lines = [f"title = {toml_value(str(meta.get('title', '')))}",
             f"date = {toml_value(str(meta.get('date', '')))}",
             f"description = {toml_value(marked(str(meta.get('description', ''))))}", "",
             table("taxonomies", meta.get("taxonomies") or {}), "",
             table("extra.translation", {"of": of})]
    if extra.get("connections"):
        lines += ["", "[extra]", "connections = " + toml_value(
            [{"source": c["source"], "why": marked(c["why"])} for c in extra["connections"]])]
    if learning:
        lt = tr.learning_text(learning)
        listen = [{k: (marked(v) if k != "at" else v) for k, v in m.items() if v} for m in lt["listen_for"]]
        lines += ["", table("extra.learning", {"objectives": [marked(o) for o in lt["objectives"]],
                                               "listen_for": listen,
                                               "questions": [marked(q) for q in lt["questions"]]})]
    return "+++\n" + "\n".join(lines) + "\n+++\n" + f"{MARK}\n\n" + tr.localise_links(body.lstrip("\n"), lang)


def status(lang: str) -> list[dict]:
    rows = []
    for src in sorted(p for p in cat.CONTENT.rglob("*.md")
                      if not tr.translation_name(p.name) and not p.relative_to(cat.CONTENT).as_posix().startswith("yearbook/")):
        meta, body = read(src)
        if meta.get("draft") is True:
            continue
        other = src.with_name(src.name[:-3] + f".{lang}.md")
        state = "missing"
        if other.is_file():
            ometa, obody = read(other)
            of = ((ometa.get("extra") or {}).get("translation") or {}).get("of", "")
            text = json.dumps(ometa, ensure_ascii=False) + obody
            state = ("untranslated" if MARK in text else
                     "current" if of == tr.prose_hash(meta, body) else "stale")
        rows.append({"source": src.relative_to(cat.CONTENT).as_posix(), "kind": "review" if is_review(src) else "page",
                     "state": state, "translation": other.relative_to(cat.ROOT).as_posix(),
                     "words": len(re.findall(r"\w+", body))})
    return rows


def check_files(paths: list[Path]) -> list[str]:
    problems = []
    cat.KNOWN_CONCEPTS.update(cat.load_concepts([]))
    for path in paths:
        rel = path.relative_to(cat.CONTENT).as_posix()
        if not tr.translation_name(path.name) or not path.is_file():
            problems.append(f"{rel}: is not a translation (<name>.<lang>.md)")
            continue
        src = english_of(path)
        meta, body = read(src)
        ometa, obody = read(path)
        if is_review(src):
            found = cat.validate(ometa, cat.TRANSLATION_SCHEMA) + tr.check(rel, ometa, obody, tr.fingerprint(meta, body), cat.TRANSLATION)
        else:
            errors: list[str] = []
            cat.page_translations(errors)
            found = [e.split(": ", 1)[1] for e in errors if e.startswith(rel + ":")]
        problems += [f"{rel}: {p}" for p in found]
    return problems


def bless(path: Path) -> str:
    src = english_of(path)
    meta, body = read(src)
    of = tr.prose_hash(meta, body)
    text = path.read_text(encoding="utf-8")
    new, n = re.subn(r'(\[extra\.translation\]\nof = )"[0-9a-f]*"', rf'\g<1>"{of}"', text, count=1)
    if not n:
        raise SystemExit(f"translate: {path}: no [extra.translation] table with of = to update")
    path.write_text(new, encoding="utf-8")
    return of


def sync(lang: str) -> list[str]:
    changed = []
    for path in tr.files(cat.CONTENT):
        if tr.split_name(path.name)[1] != lang or not is_review(english_of(path)):
            continue
        meta, _ = read(english_of(path))
        text = path.read_text(encoding="utf-8")
        new = re.sub(r'^date = .*$', f"date = {toml_value(str(meta.get('date', '')))}", text, count=1, flags=re.M)
        new = re.sub(r'\[taxonomies\]\n(?:[^\[\n+][^\n]*\n)*', table("taxonomies", meta.get("taxonomies") or {}) + "\n", new, count=1)
        if new != text:
            path.write_text(new, encoding="utf-8")
            changed.append(path.relative_to(cat.ROOT).as_posix())
    return changed


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("status"); p.add_argument("--lang", default="cs"); p.add_argument("--json", action="store_true")
    p = sub.add_parser("scaffold"); p.add_argument("files", nargs="*"); p.add_argument("--lang", default="cs")
    p.add_argument("--missing", action="store_true", help="every page and review without a translation")
    p = sub.add_parser("check"); p.add_argument("files", nargs="+")
    p = sub.add_parser("bless"); p.add_argument("files", nargs="+")
    p = sub.add_parser("sync"); p.add_argument("--lang", default="cs")
    p = sub.add_parser("batches"); p.add_argument("n", type=int); p.add_argument("--lang", default="cs")
    args = parser.parse_args()
    if getattr(args, "lang", None) and args.lang not in cat.LANGUAGES:
        print(f"translate: '{args.lang}' is no language of config.toml (have {cat.LANGUAGES})", file=sys.stderr)
        return 2

    if args.command == "status":
        rows = status(args.lang)
        if args.json:
            print(json.dumps(rows, ensure_ascii=False, indent=1))
        else:
            for r in rows:
                if r["state"] != "current":
                    print(f"{r['state']:<13} {r['kind']:<6} {r['source']}")
            counts = {s: sum(1 for r in rows if r["state"] == s) for s in ("current", "stale", "untranslated", "missing")}
            print(f"translate: {args.lang}: " + ", ".join(f"{v} {k}" for k, v in counts.items()) + f" of {len(rows)}")
        return 0
    if args.command == "scaffold":
        targets = [cat.ROOT / f for f in args.files]
        if args.missing:
            targets += [cat.CONTENT / r["source"] for r in status(args.lang) if r["state"] == "missing"]
        for src in targets:
            if tr.translation_name(src.name) or not src.is_file():
                print(f"translate: {src} is not an English page", file=sys.stderr)
                return 2
            out = src.with_name(src.name[:-3] + f".{args.lang}.md")
            if out.exists():
                print(f"translate: {out.relative_to(cat.ROOT)} exists; left as it is")
                continue
            out.write_text(scaffold_text(src, args.lang), encoding="utf-8")
            print(f"translate: wrote {out.relative_to(cat.ROOT)}")
        return 0
    if args.command == "check":
        problems = check_files([cat.ROOT / f for f in args.files])
        for pr in problems:
            print(f"translate: {pr}", file=sys.stderr)
        print(f"translate: {len(args.files)} translation(s), {len(problems)} problem(s)")
        return 1 if problems else 0
    if args.command == "bless":
        for f in args.files:
            path = cat.ROOT / f
            print(f"translate: {f} translates {english_of(path).relative_to(cat.ROOT)} at {bless(path)}")
        return 0
    if args.command == "sync":
        for f in sync(args.lang):
            print(f"translate: synced {f}")
        return 0
    if args.command == "batches":
        todo = [r for r in status(args.lang) if r["kind"] == "review" and r["state"] != "current"]
        todo.sort(key=lambda r: -r["words"])
        batches: list[list[dict]] = [[] for _ in range(max(1, args.n))]
        for r in todo:  # longest first into the lightest batch: balanced by words
            min(batches, key=lambda b: sum(x["words"] for x in b)).append(r)
        print(json.dumps([[r["source"] for r in b] for b in batches], ensure_ascii=False, indent=1))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
