"""The translation contract (ADR 0006): a page's translation is the file beside it,
<name>.<lang>.md, and holds only what is language. scripts/catalog.py loads every translation
through this module and refuses one that is not a complete, current, faithful counterpart of its
English page; scripts/translate.py scaffolds, lists and blesses them.

What a translation of a review may hold (data/translation.schema.json):
  title, description          its own words
  date, taxonomies            exactly the English page's (one identity per term, ADR 0006)
  extra.translation.of        the English prose it translates (prose_hash); stale when it differs
  extra.learning              objectives, listen_for (part, what; at as in English), questions,
                              each list as long as the English one
  extra.connections           the English connections in the same order, each with its own why
  the body                    the English page's components (concept_link, track_link, video,
                              figure) and as many headings, in its own words

Everything else (video, ISRC, credits, release, sources) is the English page's and the template
reads it from there (get_page(..., lang="en")).
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

COMPONENT = re.compile(r'\{\{\s*<([a-z_]+)\b([^>]*)/>\s*\}\}')
COMPONENT_ID = re.compile(r'\b(?:name|source|id|src)="([^"]+)"')
HEADING = re.compile(r"^#{2,6}\s", re.M)
CZECH = re.compile(r"[áčďéěíňóřšťúůýž]", re.I)
# Letters of another script that look like Latin ones (Cyrillic, Greek): a translation may carry
# one only where its English page does (a name, "alt-J (∆)").
FOREIGN_SCRIPT = re.compile(r"[\u0370-\u03ff\u0400-\u04ff\u2206]")


def translation_name(name: str) -> tuple[str, str] | None:
    """'x.cs.md' -> ('x.md', 'cs'); a file that is not a translation -> None."""
    m = re.fullmatch(r"(.+)\.([a-z]{2})\.md", name)
    return (m.group(1) + ".md", m.group(2)) if m else None


def split_name(name: str) -> tuple[str, str]:
    """translation_name() of a file known to be a translation (tr.files() lists only those)."""
    found = translation_name(name)
    if found is None:
        raise ValueError(f"{name} is not a translation (<name>.<lang>.md)")
    return found


def learning_text(learning: dict) -> dict:
    return {"objectives": list(learning.get("objectives") or []),
            "listen_for": [{k: m.get(k, "") for k in ("at", "part", "what")}
                           for m in learning.get("listen_for") or [] if isinstance(m, dict)],
            "questions": list(learning.get("questions") or [])}


def prose_hash(meta: dict, body: str) -> str:
    """The English text a translation translates: its title, description, body, learning guide
    and the reasons of its connections. Twelve hex digits of sha256."""
    extra = meta.get("extra", {}) or {}
    text = {"title": str(meta.get("title", "")).strip(),
            "description": str(meta.get("description", "")).strip(),
            "body": body.strip(),
            "learning": learning_text(extra.get("learning") or {}),
            "connections": [{"source": c.get("source", ""), "why": c.get("why", "")}
                            for c in extra.get("connections") or [] if isinstance(c, dict)]}
    return hashlib.sha256(json.dumps(text, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]


def localise_links(body: str, lang: str) -> str:
    """The content links of a translation, naming its language: concept_link and track_link
    gain lang="<lang>" as their last attribute."""
    return re.sub(r'(\{\{\s*<(?:concept_link|track_link)\b(?:(?!\blang=)[^>])*?)\s*/>',
                  rf'\1 lang="{lang}" />', body)


def components(body: str) -> list[str]:
    out = []
    for name, attrs in COMPONENT.findall(body):
        ident = COMPONENT_ID.search(attrs)
        out.append(f"{name}:{ident.group(1) if ident else ''}")
    return sorted(out)


def prose_chars(paragraph: str) -> int:
    """The words of a paragraph without its links and URLs: a paragraph that is a link only (a
    playlist, a reference) has nothing to translate."""
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", paragraph)
    return len(re.sub(r"https?://\S+|[\s\W]+", "", text))


def fingerprint(meta: dict, body: str) -> dict:
    """What a translation must keep of its English page."""
    extra = meta.get("extra", {}) or {}
    learning = learning_text(extra.get("learning") or {})
    return {"hash": prose_hash(meta, body), "date": str(meta.get("date", "")),
            "taxonomies": {k: [str(t) for t in v] for k, v in (meta.get("taxonomies") or {}).items()},
            "components": components(body), "headings": len(HEADING.findall(body)),
            "learning": {k: len(v) for k, v in learning.items()},
            "at": [m["at"] for m in learning["listen_for"]],
            "connections": [c.get("source", "") for c in extra.get("connections") or [] if isinstance(c, dict)],
            "paragraphs": {re.sub(r"\s+", " ", p.strip().lower()) for p in re.split(r"\n\s*\n", body)
                           if len(p.strip()) >= 120 and not p.strip().startswith(("#", "{{", "[//]:")) and prose_chars(p) >= 60},
            "scripts": sorted(set(FOREIGN_SCRIPT.findall(body + json.dumps(meta, ensure_ascii=False, default=str)))),
            "words": len(re.findall(r"\w+", body))}


def czech_enough(text: str, ratio: float) -> bool:
    """Czech prose: a share of its words carry Czech diacritics. English left untranslated has
    none; proper names and loanwords do not tip a real Czech text below the share."""
    words = re.findall(r"[^\W\d_]+", re.sub(r"\{\{.*?\}\}|<[^>]+>|\]\([^)]*\)|`[^`]*`", " ", text))
    if len(words) < 8:
        return True  # too short to judge: a name, a label
    return sum(1 for w in words if CZECH.search(w)) / len(words) >= ratio


def check(rel: str, meta: dict, body: str, english: dict, rules: dict) -> list[str]:
    """Every way the translation rel fails its English page's fingerprint."""
    problems = []
    marker = rules["untranslated_marker"]
    extra = meta.get("extra", {}) or {}
    if str(meta.get("date", "")) != english["date"]:
        problems.append(f"date {meta.get('date')} is not the English page's {english['date']} (translate.py sync)")
    taxonomies = {k: [str(t) for t in v] for k, v in (meta.get("taxonomies") or {}).items()}
    if taxonomies != english["taxonomies"]:
        problems.append("taxonomies differ from the English page's; a term has one identity (translate.py sync)")
    of = (extra.get("translation") or {}).get("of", "")
    if of != english["hash"]:
        problems.append(f"translates English text {of or '(none)'} but the English page is now {english['hash']}: "
                        "update the translation, then python3 scripts/translate.py bless " + rel)
    learning = learning_text(extra.get("learning") or {})
    shape = {k: len(v) for k, v in learning.items()}
    if shape != english["learning"]:
        problems.append(f"extra.learning has {shape}, the English page {english['learning']}")
    if [m["at"] for m in learning["listen_for"]] != english["at"]:
        problems.append("extra.learning.listen_for times (at) differ from the English page's")
    sources = [c.get("source", "") for c in extra.get("connections") or [] if isinstance(c, dict)]
    if sources != english["connections"]:
        problems.append("extra.connections must name the English page's connections, in its order")
    lang = rel.rsplit(".", 2)[-2]
    for m in re.finditer(r'\{\{\s*<(concept_link|track_link)\b([^>]*)/>\s*\}\}', body):
        if f'lang="{lang}"' not in m.group(2):
            problems.append(f'{{{{ <{m.group(1)} ... /> }}}} needs lang="{lang}": a component in content sees '
                            f"nothing of its page (python3 scripts/translate.py scaffold writes it)")
    mine = components(body)
    if mine != english["components"]:
        missing = sorted(set(english["components"]) - set(mine))
        extra_c = sorted(set(mine) - set(english["components"]))
        problems.append(f"components differ from the English page's (missing {missing}, extra {extra_c})")
    if len(HEADING.findall(body)) != english["headings"]:
        problems.append(f"{len(HEADING.findall(body))} headings, the English page {english['headings']}")
    texts = {"title": str(meta.get("title", "")), "description": str(meta.get("description", "")), "body": body}
    for k, items in learning.items():
        for i, v in enumerate(items):
            texts[f"extra.learning.{k}[{i}]"] = " ".join(v.values()) if isinstance(v, dict) else str(v)
    for i, c in enumerate(extra.get("connections") or []):
        if isinstance(c, dict):
            texts[f"extra.connections[{i}].why"] = str(c.get("why", ""))
    for where, text in texts.items():
        if marker in text:
            problems.append(f"{where} is not translated yet ({marker})")
        elif where not in ("title",) and not czech_enough(text, rules["czech_word_ratio"]):
            problems.append(f"{where} does not read as Czech (fewer than {rules['czech_word_ratio']:.0%} "
                            "of its words carry Czech diacritics)")
    copied = english["paragraphs"] & {re.sub(r"\s+", " ", p.strip().lower()) for p in re.split(r"\n\s*\n", body)}
    if copied:
        problems.append(f"{len(copied)} paragraph(s) are the English text, not a translation")
    stray = sorted(set(FOREIGN_SCRIPT.findall(body + json.dumps(meta, ensure_ascii=False, default=str))) - set(english.get("scripts", [])))
    if stray:
        problems.append(f"letters of another script ({' '.join(stray)}) that the English page does not have: "
                        "a look-alike slipped in")
    words = len(re.findall(r"\w+", body))
    if english["words"] and words < rules["min_words_ratio"] * english["words"]:
        problems.append(f"{words} words against the English page's {english['words']}: something is missing")
    return problems


def files(content: Path) -> list[Path]:
    return sorted(p for p in content.rglob("*.md") if translation_name(p.name))
