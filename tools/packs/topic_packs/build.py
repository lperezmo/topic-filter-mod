"""Builds one pack from a recipe: fetch, clean, classify, dry run, judge."""

import json
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

from topic_packs.classify import Zipf, classify, english_zipf, flag_corpus_hits, resolve
from topic_packs.clean import Candidate, Origin, merge
from topic_packs.dryrun import DryRun, dry_run
from topic_packs.judge import Jev, JudgeError, JudgeStats
from topic_packs.matcher import Matcher
from topic_packs.recipe import Recipe
from topic_packs.sources import Http, fetch


@dataclass
class Build:
    """Everything a build learned; the pack and the report are both views of it."""

    recipe: Recipe
    version: str
    candidates: list[Candidate]
    #: (found, kept) per recipe source, in recipe order.
    source_counts: list[tuple[int, int]] = field(default_factory=list)
    #: Raw items that cleaning removed (lists, years, acronyms...), deduplicated.
    cleaned_away: int = 0
    dry_run: DryRun | None = None
    corpus_flagged: int = 0
    judge_stats: JudgeStats | None = None
    judge_error: str = ""

    def of(self, decision: str) -> list[Candidate]:
        return sorted((c for c in self.candidates if c.decision == decision), key=lambda c: (c.key, c.text))

    def reviewed(self) -> list[Candidate]:
        return sorted((c for c in self.candidates if c.review), key=lambda c: (c.key, c.text))

    def unsettled(self) -> list[Candidate]:
        """Reviewed candidates the judge did not settle: they stay hints until a human looks."""
        t = self.recipe.thresholds
        return [c for c in self.reviewed() if c.judge is None or t.judge_hint < c.judge < t.judge_term]

    def pack(self) -> dict[str, Any]:
        """The pack file's content, keys in the order the mod's contract gives."""
        sources = []
        for source, (found, kept) in zip(self.recipe.sources, self.source_counts, strict=True):
            entry: dict[str, Any] = {"kind": source.kind, "query": source.query}
            if source.depth is not None:
                entry["depth"] = source.depth
            sources.append({**entry, "found": found, "kept": kept})
        return {
            "name": self.recipe.name,
            "version": self.version,
            "description": self.recipe.description,
            "terms": [c.text for c in self.of("term")],
            "hints": [c.text for c in self.of("hint")],
            "sources": sources,
        }


def build(
    recipe: Recipe,
    http: Http,
    *,
    corpus: list[Path] | None = None,
    exclude: list[Path] | None = None,
    judge: Jev | None = None,
    zipf: Zipf = english_zipf,
    today: date | None = None,
) -> Build:
    items: list[tuple[str, Origin]] = []
    found = []
    for i, source in enumerate(recipe.sources):
        if source.kind == "recipe":
            raw = recipe.extra_terms if source.query == "extra_terms" else recipe.extra_hints
        else:
            raw = fetch(http, source)
        found.append(len(raw))
        items += [(title, Origin(i, source.kind, source.role)) for title in raw]

    kept, cleaned_away = merge(items)
    classify(kept, recipe, zipf)
    result = Build(recipe, (today or date.today()).strftime("%Y.%m.%d"), kept + cleaned_away)
    result.cleaned_away = len(cleaned_away)

    if corpus:
        matcher = Matcher()
        for c in kept:
            if c.decision == "term" or c.review:
                matcher.add(c.text)
        result.dry_run = dry_run(matcher, corpus, exclude or [])
        for c in kept:
            c.hits = result.dry_run.hits[c.key]
            c.files = result.dry_run.files_with[c.key]
        result.corpus_flagged = flag_corpus_hits(kept, recipe.thresholds)

    if judge is not None:
        pending = [c for c in kept if c.review]
        try:
            answers = judge.judge([c.text for c in pending])
        except JudgeError as err:
            result.judge_error = str(err)
            answers = err.answers
        for c in pending:
            c.judge = answers.get(c.text)
        resolve(kept, recipe.thresholds)
        result.judge_stats = judge.stats

    for i in range(len(recipe.sources)):
        kept_here = sum(1 for c in kept if c.decision != "drop" and any(o.source == i for o in c.origins))
        result.source_counts.append((found[i], kept_here))
    return result


def write_pack(result: Build, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(result.pack(), indent=2, ensure_ascii=False) + "\n"
    path.write_text(text, encoding="utf-8", newline="\n")
