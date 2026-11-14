#!/usr/bin/env python3
"""Derived images: every local image a page shows, served as sized AVIF and WebP variants.

The sources are what the content references: a {{ <figure src="images/…" /> }} in content/ and a
review's extra.cover_image. Each is rendered at the widths, formats and qualities of
data/media.toml into static/images/derived/ and recorded in static/data/images.json
(sonic-images/v1): its intrinsic size, the hash of its bytes and of the parameters, and every
variant with its size in bytes. The figure component renders a <picture> from it (width and height
set, so nothing shifts as it loads) and scripts/catalog.py gives a card the smallest variant at
least data/media.toml card_width wide.

    python3 scripts/images.py           render what is missing or stale (ImageMagick with AVIF
                                        and WebP), drop what nothing references any more
    python3 scripts/images.py --check   exit 1 unless the manifest is current: every source in
                                        it with its hash and parameters, every variant present at
                                        its recorded size and within the budget, no orphan file
                                        (no encoder needed: CI runs this)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
CONTENT = ROOT / "content"
CONFIG = ROOT / "data" / "media.toml"
MANIFEST = STATIC / "data" / "images.json"
DERIVED = "images/derived"
FIGURE = re.compile(r'\{\{\s*<figure\s+src="([^"]+)"')
COVER = re.compile(r'^cover_image\s*=\s*"([^"]+)"', re.M)


def config() -> dict:
    return tomllib.loads(CONFIG.read_text(encoding="utf-8"))


def params_hash(cfg: dict) -> str:
    keep = {k: cfg[k] for k in ("widths", "formats", "quality")}
    return hashlib.sha256(json.dumps(keep, sort_keys=True).encode()).hexdigest()[:12]


def sources() -> dict[str, list[str]]:
    """Every local image the content shows -> the files that show it."""
    found: dict[str, list[str]] = {}
    for md in sorted(CONTENT.rglob("*.md")):
        text = "\n".join(line for line in md.read_text(encoding="utf-8").splitlines()
                         if not line.startswith("[//]: #"))  # a commented-out figure is not shown
        for src in FIGURE.findall(text) + COVER.findall(text):
            if "://" in src:
                continue
            found.setdefault(src.lstrip("/"), []).append(md.relative_to(ROOT).as_posix())
    return found


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def size(path: Path) -> tuple[int, int]:
    out = subprocess.run(["magick", "identify", "-format", "%w %h\n", f"{path}[0]"],
                         capture_output=True, text=True, check=True).stdout.split()
    return int(out[0]), int(out[1])


def widths_for(width: int, cfg: dict) -> list[int]:
    return [w for w in cfg["widths"] if w <= width] or [width]


def variant_path(src: str, width: int, fmt: str) -> str:
    return f"{DERIVED}/{Path(src).with_suffix('').as_posix().removeprefix('images/')}-{width}.{fmt}"


def render(src: str, cfg: dict) -> dict:
    path = STATIC / src
    w0, h0 = size(path)
    variants: dict[str, list[list]] = {}
    for fmt in cfg["formats"]:
        for w in widths_for(w0, cfg):
            rel = variant_path(src, w, fmt)
            out = STATIC / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(["magick", f"{path}[0]", "-auto-orient", "-resize", f"{w}x", "-strip",
                            "-quality", str(cfg["quality"][fmt]), str(out)], check=True)
            h = round(h0 * w / w0)
            variants.setdefault(fmt, []).append([w, h, rel, out.stat().st_size])
    return {"width": w0, "height": h0, "sha256": digest(path), "params": params_hash(cfg),
            "variants": variants}


def load_manifest() -> dict:
    if MANIFEST.exists():
        return json.loads(MANIFEST.read_text(encoding="utf-8"))
    return {"images": {}}


def dump(images: dict, cfg: dict) -> str:
    return json.dumps({"schema": "sonic-images/v1", "generated_by": "scripts/images.py",
                       "formats": cfg["formats"], "card_width": cfg["card_width"], "social": cfg["social"],
                       "images": images},
                      indent=1, sort_keys=True) + "\n"


def problems(cfg: dict) -> list[str]:
    images = load_manifest().get("images", {})
    used = sources()
    out: list[str] = []
    limit = cfg["budget"]["image_kb"] * 1024
    for src, where in sorted(used.items()):
        entry = images.get(src)
        if not (STATIC / src).is_file():
            out.append(f"{src} (shown by {', '.join(where)}) is not a file under static/")
        elif entry is None:
            out.append(f"{src} (shown by {', '.join(where)}) has no derived variants; run python3 scripts/images.py")
        elif entry["sha256"] != digest(STATIC / src) or entry["params"] != params_hash(cfg):
            out.append(f"{src}: its variants are stale (the source or data/media.toml changed); run python3 scripts/images.py")
        else:
            for fmt, rows in entry["variants"].items():
                for w, _h, rel, nbytes in rows:
                    f = STATIC / rel
                    if not f.is_file() or f.stat().st_size != nbytes:
                        out.append(f"{rel} is missing or not the file the manifest records")
                    elif nbytes > limit:
                        out.append(f"{rel} weighs {nbytes // 1024} kB, over the budget of "
                                   f"{cfg['budget']['image_kb']} kB (data/media.toml): lower quality or width")
    manifest = load_manifest()
    if (manifest.get("formats") != cfg["formats"] or manifest.get("card_width") != cfg["card_width"]
            or manifest.get("social") != cfg["social"]):
        out.append("static/data/images.json does not carry data/media.toml's formats, card_width and social; run python3 scripts/images.py")
    for src in sorted(set(images) - set(used)):
        out.append(f"{src} is in the manifest but nothing shows it; run python3 scripts/images.py")
    recorded = {rows[2] for e in images.values() for rs in e["variants"].values() for rows in rs}
    for f in sorted((STATIC / DERIVED).rglob("*")) if (STATIC / DERIVED).exists() else []:
        if f.is_file() and f.relative_to(STATIC).as_posix() not in recorded:
            out.append(f"{f.relative_to(ROOT).as_posix()} is an orphan derived file; run python3 scripts/images.py")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    cfg = config()
    if args.check:
        found = problems(cfg)
        for p in found:
            print(f"images: {p}", file=sys.stderr)
        if found:
            print(f"images: {len(found)} problem(s)", file=sys.stderr)
            return 1
        images = load_manifest()["images"]
        n = sum(len(rs) for e in images.values() for rs in e["variants"].values())
        print(f"images: {len(images)} sources, {n} variants, current and within {cfg['budget']['image_kb']} kB")
        return 0
    old = load_manifest().get("images", {})
    images: dict = {}
    for src in sorted(sources()):
        if not (STATIC / src).is_file():
            continue
        entry = old.get(src)
        fresh = (entry and entry["sha256"] == digest(STATIC / src) and entry["params"] == params_hash(cfg)
                 and all((STATIC / r[2]).is_file() for rs in entry["variants"].values() for r in rs))
        images[src] = entry if fresh else render(src, cfg)
        if not fresh:
            print(f"images: rendered {src}")
    keep = {r[2] for e in images.values() for rs in e["variants"].values() for r in rs}
    if (STATIC / DERIVED).exists():  # only what this tool made: files under images/derived/
        for f in sorted((STATIC / DERIVED).rglob("*")):
            if f.is_file() and f.relative_to(STATIC).as_posix() not in keep:
                f.unlink()
                print(f"images: removed {f.relative_to(ROOT).as_posix()}")
    MANIFEST.write_text(dump(images, cfg), encoding="utf-8")
    return 1 if problems(cfg) else 0


if __name__ == "__main__":
    sys.exit(main())
