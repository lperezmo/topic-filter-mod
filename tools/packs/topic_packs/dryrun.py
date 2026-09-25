"""Counts where candidate terms show up in the user's own files.

The corpus stands for ordinary work, so a term found across many of its files
would hide ordinary text: those terms go to review. Only counts leave this
module; file paths never reach the report, which is committed publicly.

Checkouts of topic-filter itself are always skipped: their packs and reports
hold exactly the terms being counted.
"""

import json
import math
import os
import time
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

from topic_packs.matcher import Matcher

TEXT_SUFFIXES = frozenset(
    {".md", ".txt", ".py", ".ts", ".tsx", ".js", ".json", ".toml", ".yaml", ".yml"}
    | {".html", ".css", ".rs", ".go", ".java", ".cs", ".ps1", ".sh"}
)
SKIP_DIRS = frozenset(
    {"node_modules", ".git", ".venv", "venv", "dist", "build", "target", "__pycache__", ".next"}
)
MAX_FILE_BYTES = 1_000_000
MAX_FILES = 20_000
PLUGIN_NAME = "topic-filter"


@dataclass
class DryRun:
    """What a dry run saw, as counts only."""

    #: Text files found by the walk, and how many of them were read.
    files_found: int = 0
    files: int = 0
    bytes: int = 0
    skipped_checkouts: int = 0
    seconds: float = 0.0
    hits: Counter[str] = field(default_factory=Counter)
    files_with: Counter[str] = field(default_factory=Counter)


def is_topic_filter_checkout(directory: Path) -> bool:
    """True for a checkout of this repository: its plugin manifest names topic-filter."""
    manifest = directory / ".claude-plugin" / "plugin.json"
    try:
        return json.loads(manifest.read_text(encoding="utf-8")).get("name") == PLUGIN_NAME
    except (OSError, ValueError, AttributeError):
        return False


def _is_text_file(name: str, size: int) -> bool:
    return os.path.splitext(name)[1].lower() in TEXT_SUFFIXES and size <= MAX_FILE_BYTES


def walk(roots: list[Path], exclude: list[Path], run: DryRun) -> Iterator[Path]:
    """Text files under the roots, in a stable order, minus skipped and excluded trees."""
    excluded = {os.path.normcase(p.resolve()) for p in exclude}
    dirs = []
    for root in sorted(r.resolve() for r in roots):
        if os.path.normcase(root) in excluded:
            continue
        if root.is_dir():
            dirs.append(root)
        elif root.is_file() and _is_text_file(root.name, root.stat().st_size):
            yield root

    stack = dirs[::-1]
    while stack:
        directory = stack.pop()
        if is_topic_filter_checkout(directory):
            run.skipped_checkouts += 1
            continue
        try:
            entries = sorted(os.scandir(directory), key=lambda e: e.name)
        except OSError:
            continue
        subdirs = []
        for entry in entries:
            try:
                if entry.is_symlink() or entry.is_junction() or os.path.normcase(entry.path) in excluded:
                    continue
                if entry.is_dir():
                    if entry.name not in SKIP_DIRS:
                        subdirs.append(Path(entry.path))
                elif _is_text_file(entry.name, entry.stat().st_size):
                    yield Path(entry.path)
            except OSError:
                continue
        stack.extend(reversed(subdirs))


def dry_run(matcher: Matcher, roots: list[Path], exclude: list[Path], max_files: int = MAX_FILES) -> DryRun:
    """Counts hits and distinct files per folded term across the corpus.

    Past `max_files`, files are sampled evenly across the whole walk rather
    than taken from the front, so one large project cannot crowd out the rest.
    """
    run = DryRun()
    started = time.monotonic()
    paths = list(walk(roots, exclude, run))
    run.files_found = len(paths)
    step = max(1, math.ceil(len(paths) / max_files))
    for path in paths[::step]:
        try:
            data = path.read_bytes()
        except OSError:
            continue
        if b"\0" in data[:8192]:
            continue
        run.files += 1
        run.bytes += len(data)
        counts = matcher.count(data.decode("utf-8", errors="replace"))
        run.hits.update(counts)
        run.files_with.update(counts.keys())
    run.seconds = time.monotonic() - started
    return run
