#!/usr/bin/env python3
"""Contact sheets of the step screenshots from a Device CI run, printed into the job log.

The CI artifact holds every screenshot, but the log is the one thing every reader can fetch
(`get_job_logs`), so each sheet is also printed as base64 lines:

    CORAL-SHEET <name> <i>/<n> <chunk>

One sheet per test case, from the latest run of it through the server (`server-runs/`), or from
`coral run` (`coral-run/`) when the server run has none. Step directories follow the local and
downloaded layout `<slug>/<index>-<step_id>/screenshot.png`.

Usage: ci-contact-sheet.py <device-results dir> <out dir>   (needs Pillow)
"""

import base64
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

TILE_WIDTH = 216
LABEL_HEIGHT = 16
CHUNK = 3000
STEP_DIR = re.compile(r"^(\d+)-(.+)$")


def step_dirs(slug_dir: Path) -> list[tuple[int, str, Path]]:
    steps = []
    for child in slug_dir.iterdir():
        match = STEP_DIR.match(child.name)
        if match and (child / "screenshot.png").is_file():
            steps.append((int(match[1]), match[2], child / "screenshot.png"))
    return sorted(steps)


def latest_runs(root: Path) -> dict[str, Path]:
    """slug → its step directories' parent: the server run with the highest id (UUIDv7 sorts by
    time), else the local `coral run` output."""
    found: dict[str, Path] = {}
    for slug_dir in sorted((root / "coral-run").glob("*/")):
        if step_dirs(slug_dir):
            found[slug_dir.name] = slug_dir
    for slug_dir in sorted((root / "server-runs").glob("*/*/")):
        if step_dirs(slug_dir):
            found[slug_dir.name] = slug_dir
    return found


def sheet(slug_dir: Path) -> Image.Image:
    steps = step_dirs(slug_dir)
    tiles = []
    for index, step_id, png in steps:
        with Image.open(png) as shot:
            height = round(shot.height * TILE_WIDTH / shot.width)
            tile = Image.new("RGB", (TILE_WIDTH, height + LABEL_HEIGHT), "white")
            tile.paste(shot.convert("RGB").resize((TILE_WIDTH, height), Image.LANCZOS))
        ImageDraw.Draw(tile).text((4, height + 3), f"{index} {step_id}", fill="black")
        tiles.append(tile)
    width = sum(t.width for t in tiles) + 4 * (len(tiles) - 1)
    out = Image.new("RGB", (width, max(t.height for t in tiles)), "#888888")
    x = 0
    for tile in tiles:
        out.paste(tile, (x, 0))
        x += tile.width + 4
    return out


def main() -> int:
    root, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    runs = latest_runs(root)
    if not runs:
        print("no step screenshots found")
        return 0
    for slug, slug_dir in runs.items():
        path = out_dir / f"{slug}.jpg"
        sheet(slug_dir).save(path, "JPEG", quality=60, optimize=True)
        data = base64.b64encode(path.read_bytes()).decode()
        chunks = [data[i : i + CHUNK] for i in range(0, len(data), CHUNK)]
        print(f"{slug}: {slug_dir.relative_to(root)} → {path} ({path.stat().st_size} bytes)")
        for i, chunk in enumerate(chunks, 1):
            print(f"CORAL-SHEET {slug} {i}/{len(chunks)} {chunk}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
