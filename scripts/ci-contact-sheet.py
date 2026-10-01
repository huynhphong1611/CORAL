#!/usr/bin/env python3
"""Contact sheets of the step screenshots from a Device CI run.

Sheets `local-<slug>` for each `coral run` (`coral-run/<slug>/`), `test-<slug>` for the run of
the `coral run` device test (`coral-run-test/<slug>/`) and `server-<slug>` for the latest run of
each test case through the server (`server-runs/<run>/<slug>/`), plus `server-<slug>-<run>` for
every server run that did not pass; `explore-appmap` and `explore-trace` from the Explorer check
(`explore/appmap/*.jpg`, `explore/trace/*.jpg`, T036). A run that did not pass also gets its last step described in
the log: windows and texts from `tree.json`, and
the activity-manager lines of its `device.log`. Step directories follow the local and downloaded
layout `<slug>/<index>-<step_id>/screenshot.png`. The workflow stores each sheet as a
git blob (no ref, no commit) and logs its sha, so a report can fetch it through the API when the
artifact's storage is out of reach.

Usage: ci-contact-sheet.py <device-results dir> <out dir>   (needs Pillow)
"""

import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

TILE_WIDTH = 216
LABEL_HEIGHT = 16
STEP_DIR = re.compile(r"^(\d+)-(.+)$")
LOG_OF_INTEREST = re.compile(
    r"ActivityTaskManager|ActivityManager|AndroidRuntime|WindowManager|mydemoapp|SplashScreen|ANR"
)


def step_dirs(slug_dir: Path) -> list[tuple[int, str, Path]]:
    steps = []
    for child in slug_dir.iterdir():
        match = STEP_DIR.match(child.name)
        if match and (child / "screenshot.png").is_file():
            steps.append((int(match[1]), match[2], child / "screenshot.png"))
    return sorted(steps)


def groups(root: Path) -> dict[str, Path]:
    """Sheet name → the directory holding its step directories."""
    found: dict[str, Path] = {}
    for slug_dir in sorted((root / "coral-run").glob("*/")):
        if step_dirs(slug_dir):
            found[f"local-{slug_dir.name}"] = slug_dir
    for slug_dir in sorted((root / "coral-run-test").glob("*/")):
        if step_dirs(slug_dir):
            found[f"test-{slug_dir.name}"] = slug_dir
    # Run ids are UUIDv7: sorted by time, so the last one per test case wins.
    for slug_dir in sorted((root / "server-runs").glob("*/*/")):
        if step_dirs(slug_dir):
            found[f"server-{slug_dir.name}"] = slug_dir
    for slug_dir in sorted((root / "server-runs").glob("*/*/")):
        if step_dirs(slug_dir) and not passed(slug_dir):
            found[f"server-{slug_dir.name}-{slug_dir.parent.name[:8]}"] = slug_dir
    return found


def passed(slug_dir: Path) -> bool:
    result_file = slug_dir / "result.json"
    return not result_file.is_file() or json.loads(result_file.read_text()).get("status") == "passed"


def describe_failure(slug_dir: Path) -> None:
    """Prints what was on screen at the last step of a run that did not pass."""
    if passed(slug_dir):
        return
    result = json.loads((slug_dir / "result.json").read_text())
    index, step_id, png = step_dirs(slug_dir)[-1]
    print(f"  {result.get('status')} {result.get('failure_code')}: {result.get('message')}")
    tree_file = png.parent / "tree.json"
    if not tree_file.is_file():
        return
    windows = json.loads(tree_file.read_text())
    texts: list[str] = []

    def walk(node: dict) -> None:
        label = node.get("text") or node.get("desc")
        if label and len(texts) < 20:
            texts.append(label)
        for child in node.get("children", []):
            walk(child)

    for window in windows:
        walk(window)
    print(f"  step {index} {step_id} windows (bottom-most first):")
    for window in windows:
        print(f"    {window.get('package_or_bundle')} {json.dumps(window.get('bounds'))}")
    print(f"  texts: {json.dumps(texts, ensure_ascii=False)}")
    log_file = png.parent / "device.log"
    if log_file.is_file():
        lines = [
            line
            for line in log_file.read_text(errors="replace").splitlines()
            if LOG_OF_INTEREST.search(line)
        ]
        print(f"  device.log ({len(lines)} activity/app lines, last 40):")
        for line in lines[-40:]:
            print(f"    {line}")


def sheet(slug_dir: Path) -> Image.Image:
    return render([(f"{index} {step_id}", png) for index, step_id, png in step_dirs(slug_dir)])


def render(pictures: list[tuple[str, Path]]) -> Image.Image:
    tiles = []
    for label, picture in pictures:
        with Image.open(picture) as shot:
            height = round(shot.height * TILE_WIDTH / shot.width)
            tile = Image.new("RGB", (TILE_WIDTH, height + LABEL_HEIGHT), "white")
            tile.paste(shot.convert("RGB").resize((TILE_WIDTH, height), Image.LANCZOS))
        ImageDraw.Draw(tile).text((4, height + 3), label, fill="black")
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
    found = groups(root)
    for name, slug_dir in found.items():
        path = out_dir / f"{name}.jpg"
        sheet(slug_dir).save(path, "JPEG", quality=60, optimize=True)
        print(f"{name}: {slug_dir.relative_to(root)} → {path} ({path.stat().st_size} bytes)")
        describe_failure(slug_dir)
    # The Explorer's app map (one picture per screen) and its trace (one per step).
    explored = 0
    for name in ("appmap", "trace"):
        pictures = sorted((root / "explore" / name).glob("*.jpg"))
        if not pictures:
            continue
        path = out_dir / f"explore-{name}.jpg"
        render([(p.stem, p) for p in pictures]).save(path, "JPEG", quality=60, optimize=True)
        print(f"explore-{name}: {len(pictures)} pictures → {path} ({path.stat().st_size} bytes)")
        explored += 1
    if not found and not explored:
        print("no step screenshots found")
    return 0


if __name__ == "__main__":
    sys.exit(main())
