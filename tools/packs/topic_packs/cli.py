"""Command line: `topic-packs build <name>` and `topic-packs categories <query>`.

`build` prints counts only. A pack may cover a topic that a model session
reading this output should not see, so terms go to the report file, where a
human reviews them, and never to stdout.
"""

import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from topic_packs.build import build, write_pack
from topic_packs.judge import BATCH_SIZE, Jev
from topic_packs.recipe import RecipeError, load_recipe
from topic_packs.report import render
from topic_packs.sources import WIKIPEDIA_API, WIKTIONARY_API, FetchError, Http, search_categories

TOOL_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = TOOL_DIR.parents[1]
CACHE_DIR = TOOL_DIR / ".cache"
DEFAULT_ENV_FILE = Path(r"D:\Python\jev-test\.env")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="topic-packs", description="Builds topic-filter packs.")
    commands = parser.add_subparsers(dest="command", required=True)

    b = commands.add_parser("build", help="build packs/<name>.json and its review report")
    b.add_argument("name", help="recipe name: tools/packs/recipes/<name>.toml")
    b.add_argument("--recipe", type=Path, help="recipe file (default: recipes/<name>.toml)")
    b.add_argument("--corpus", type=Path, action="append", default=[], help="folder of your ordinary work")
    b.add_argument("--exclude", type=Path, action="append", default=[], help="path the dry run skips")
    b.add_argument("--judge", choices=["jev"], help="settle the review list with a judge")
    b.add_argument("--judge-batch", type=int, default=BATCH_SIZE, help="questions per judge request")
    b.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE, help="where OPENROUTER_API_KEY lives")
    b.add_argument("--refresh", action="store_true", help="refetch sources instead of using the cache")
    b.add_argument("--offline", action="store_true", help="use cached responses only")
    b.add_argument("--out", type=Path, help="pack file (default: packs/<name>.json in the repo)")
    b.add_argument("--report", type=Path, help="report file (default: tools/packs/reports/<name>.md)")

    c = commands.add_parser("categories", help="find real category names for a recipe (prints names)")
    c.add_argument("query")
    c.add_argument("--wiktionary", action="store_true", help="search Wiktionary instead of Wikipedia")
    c.add_argument("--limit", type=int, default=20)

    args = parser.parse_args(argv)
    try:
        if args.command == "categories":
            return _categories(args)
        return _build(args)
    except (RecipeError, FetchError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 1


def _categories(args: argparse.Namespace) -> int:
    sys.stdout.reconfigure(encoding="utf-8")  # names like Yucatán, even through a Windows pipe
    http = Http(CACHE_DIR)
    api = WIKTIONARY_API if args.wiktionary else WIKIPEDIA_API
    for name in search_categories(http, api, args.query, args.limit):
        print(name)
    return 0


def _judge(args: argparse.Namespace, description: str) -> Jev | None:
    if args.judge != "jev":
        return None
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key and args.env_file.exists():
        load_dotenv(args.env_file)
        key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        print("judge: no OPENROUTER_API_KEY in the environment or --env-file; building without it")
        return None
    return Jev(description, key, CACHE_DIR / "judge.json", batch_size=args.judge_batch)


def _build(args: argparse.Namespace) -> int:
    recipe = load_recipe(args.recipe or TOOL_DIR / "recipes" / f"{args.name}.toml")
    if recipe.name != args.name:
        raise RecipeError(f"the recipe is named {recipe.name!r}, not {args.name!r}")
    for path in args.corpus:
        if not path.exists():
            raise RecipeError(f"--corpus {path} does not exist")

    http = Http(CACHE_DIR, refresh=args.refresh, offline=args.offline)
    judge = _judge(args, recipe.description)
    result = build(recipe, http, corpus=args.corpus, exclude=args.exclude, judge=judge)

    out = args.out or REPO_DIR / "packs" / f"{recipe.name}.json"
    report = args.report or TOOL_DIR / "reports" / f"{recipe.name}.md"
    write_pack(result, out)
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(render(result), encoding="utf-8", newline="\n")

    empty = [str(i + 1) for i, (found, _) in enumerate(result.source_counts) if found == 0]
    raw = sum(found for found, _ in result.source_counts)
    print(f"sources: {len(recipe.sources)}, {http.requests} requests, {http.cache_hits} cached responses")
    if empty:
        print(f"warning: source(s) #{', #'.join(empty)} found nothing; check the names in the recipe")
    print(
        f"candidates: {raw} raw, {len(result.candidates)} distinct, {result.cleaned_away} removed by cleaning"
    )
    if result.dry_run:
        d = result.dry_run
        print(
            f"dry run: {d.files} files read of {d.files_found} found "
            f"({d.bytes / 1e6:.1f} MB, {d.seconds:.1f} s), "
            f"{d.skipped_checkouts} topic-filter checkout(s) skipped, "
            f"{result.corpus_flagged} terms sent to review"
        )
    if result.judge_stats:
        s = result.judge_stats
        print(
            f"judge: {s.requests} requests (batch {args.judge_batch}), {s.asked} asked, {s.cached} cached, "
            f"{s.seconds:.1f} s, ${s.cost:.6f}"
        )
    if result.judge_error:
        print(f"judge failed: {result.judge_error}; unanswered candidates stay hints")
    reviewed = result.reviewed()
    print(
        f"pack: {len(result.of('term'))} terms, {len(result.of('hint'))} hints, "
        f"{len(reviewed)} reviewed ({sum(c.decision == 'term' for c in reviewed)} became terms, "
        f"{len(result.unsettled())} need a human), {len(result.of('drop'))} dropped"
    )
    print(f"wrote {_shown(out)}")
    print(f"wrote {_shown(report)}")
    return 0


def _shown(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO_DIR).as_posix()
    except ValueError:
        return str(path)
