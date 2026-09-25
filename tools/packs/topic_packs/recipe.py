"""Reads a recipe: where a pack's candidates come from and how they are sorted.

Errors name a position (`wikipedia[2].depth`) and what was expected, so a typo
in a recipe fails loudly instead of quietly building a smaller pack.
"""

import re
import tomllib
from dataclasses import dataclass, field, fields
from pathlib import Path

#: The mod's pack-name rule (SLUG in hooks/config.ts): also safe as a file name.
NAME = re.compile(r"^[a-z0-9][a-z0-9-]*$")

MAX_DEPTH = 3
ROLES = ("terms", "hints")


class RecipeError(Exception):
    """A recipe that cannot be built as written."""


@dataclass(frozen=True)
class Thresholds:
    """Zipf cut-offs (wordfreq's 0-8 scale) and the dry-run and judge limits."""

    #: A word rarer than this is a term candidate.
    term_below: float = 3.0
    #: A word at least this common is dropped: hiding it would hide ordinary text.
    drop_from: float = 4.5
    #: A single word from a terms source between term_below and this goes to review.
    review_below: float = 4.0
    #: A multi-word name whose every word is at least this common goes to review.
    common_word: float = 3.5
    #: Vocabulary rarer than this becomes a term as well as a hint.
    rare_vocabulary: float = 2.0
    #: A term found in more corpus files than this goes to review.
    corpus_files: int = 3
    #: Judge probability at or above which a reviewed candidate becomes a term.
    judge_term: float = 0.7
    #: Judge probability at or below which a reviewed candidate becomes a hint.
    judge_hint: float = 0.3


@dataclass(frozen=True)
class Source:
    """One place candidates come from. `role` says which list they aim for."""

    kind: str
    query: str
    role: str
    depth: int | None = None

    @property
    def label(self) -> str:
        """A short name for reports: `wikipedia: Maya sites`."""
        return f"{self.kind.split('-')[0]}: {self.query}"


@dataclass(frozen=True)
class Recipe:
    name: str
    description: str
    sources: list[Source]
    extra_terms: list[str] = field(default_factory=list)
    extra_hints: list[str] = field(default_factory=list)
    exclude: list[str] = field(default_factory=list)
    thresholds: Thresholds = field(default_factory=Thresholds)


_TOP_KEYS = {
    "name",
    "description",
    "wikipedia",
    "wiktionary",
    "datamuse",
    "extra_terms",
    "extra_hints",
    "exclude",
    "thresholds",
}


def load_recipe(path: Path) -> Recipe:
    """Reads and checks a recipe file."""
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise RecipeError(f"no recipe at {path}") from None
    except tomllib.TOMLDecodeError as err:
        raise RecipeError(f"{path.name} is not valid TOML: {err}") from None
    return parse_recipe(raw)


def parse_recipe(raw: dict) -> Recipe:
    """Checks a parsed recipe and fills in defaults."""
    _no_unknown(raw, _TOP_KEYS, "recipe")

    name = raw.get("name")
    if not isinstance(name, str) or not NAME.match(name):
        raise RecipeError("name must be lowercase letters, digits and hyphens")
    description = raw.get("description")
    if not isinstance(description, str) or not description.strip():
        raise RecipeError("description must be a non-empty string")

    sources = [
        *_categories(raw.get("wikipedia", []), "wikipedia", "wikipedia-category", default_role="terms"),
        *_categories(raw.get("wiktionary", []), "wiktionary", "wiktionary-category", default_role="hints"),
        *[
            Source("datamuse-rel-trg", seed, "hints")
            for seed in _strings(raw.get("datamuse", []), "datamuse")
        ],
    ]
    extra_terms = _strings(raw.get("extra_terms", []), "extra_terms")
    extra_hints = _strings(raw.get("extra_hints", []), "extra_hints")
    if extra_terms:
        sources.append(Source("recipe", "extra_terms", "terms"))
    if extra_hints:
        sources.append(Source("recipe", "extra_hints", "hints"))
    if not sources:
        raise RecipeError("a recipe needs at least one source or extra_terms")

    return Recipe(
        name=name,
        description=" ".join(description.split()),
        sources=sources,
        extra_terms=extra_terms,
        extra_hints=extra_hints,
        exclude=_strings(raw.get("exclude", []), "exclude"),
        thresholds=_thresholds(raw.get("thresholds", {})),
    )


def _categories(entries: object, where: str, kind: str, default_role: str) -> list[Source]:
    if not isinstance(entries, list):
        raise RecipeError(f"{where} must be an array of tables ([[{where}]])")
    sources = []
    for i, entry in enumerate(entries):
        at = f"{where}[{i}]"
        if not isinstance(entry, dict):
            raise RecipeError(f"{at} must be a table")
        _no_unknown(entry, {"category", "depth", "role"}, at)

        category = entry.get("category")
        if not isinstance(category, str) or not category.strip():
            raise RecipeError(f"{at}.category must be a category name")
        category = " ".join(category.replace("_", " ").split())
        if category.lower().startswith("category:"):
            raise RecipeError(f'{at}.category is written without the "Category:" prefix')

        depth = entry.get("depth", 0)
        if not isinstance(depth, int) or isinstance(depth, bool) or not 0 <= depth <= MAX_DEPTH:
            raise RecipeError(f"{at}.depth must be an integer from 0 to {MAX_DEPTH}")

        role = entry.get("role", default_role)
        if role not in ROLES:
            raise RecipeError(f"{at}.role must be one of {', '.join(ROLES)}")

        sources.append(Source(kind, category, role, depth))
    return sources


def _thresholds(raw: object) -> Thresholds:
    if not isinstance(raw, dict):
        raise RecipeError("thresholds must be a table")
    known = {f.name: f for f in fields(Thresholds)}
    _no_unknown(raw, set(known), "thresholds")
    values = {}
    for key, value in raw.items():
        wanted = int if known[key].type is int else float
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise RecipeError(f"thresholds.{key} must be a number")
        if wanted is int and not isinstance(value, int):
            raise RecipeError(f"thresholds.{key} must be a whole number")
        values[key] = wanted(value)
    t = Thresholds(**values)
    if not t.term_below <= t.review_below <= t.drop_from:
        raise RecipeError("thresholds must keep term_below <= review_below <= drop_from")
    if not 0 <= t.judge_hint < t.judge_term <= 1:
        raise RecipeError("thresholds must keep 0 <= judge_hint < judge_term <= 1")
    return t


def _strings(value: object, where: str) -> list[str]:
    if not isinstance(value, list):
        raise RecipeError(f"{where} must be an array of strings")
    for i, item in enumerate(value):
        if not isinstance(item, str) or not item.strip():
            raise RecipeError(f"{where}[{i}] must be a non-empty string")
    return [" ".join(item.split()) for item in value]


def _no_unknown(table: dict, allowed: set[str], where: str) -> None:
    unknown = sorted(set(table) - allowed)
    if unknown:
        raise RecipeError(
            f"{where} has unknown keys: {', '.join(unknown)} (allowed: {', '.join(sorted(allowed))})"
        )
