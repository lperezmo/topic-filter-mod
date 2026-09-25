"""Writes the review report: what went into a pack, from where, and why.

The report is where a human reads the terms, so it holds them all; it is
committed publicly, so the dry run appears as counts and nothing else.
"""

from topic_packs.build import Build
from topic_packs.clean import Candidate

MAX_DROPPED = 200


def _cell(text: str) -> str:
    return text.replace("|", "\\|")


def _sources(c: Candidate, build: Build) -> str:
    labels = list(dict.fromkeys(build.recipe.sources[o.source].label for o in c.origins))
    shown = "; ".join(labels[:2])
    return shown + (f"; +{len(labels) - 2}" if len(labels) > 2 else "")


def _decision(c: Candidate, unsettled: set[str]) -> str:
    if c.key in unsettled:
        return f"{c.decision}, needs a human"
    return f"{c.decision} (judge)"


def render(build: Build) -> str:
    recipe, t = build.recipe, build.recipe.thresholds
    terms = build.of("term")
    hints = build.of("hint")
    dropped = build.of("drop")
    reviewed = build.reviewed()
    unsettled = {c.key for c in build.unsettled()}
    dry = build.dry_run
    has_dry = dry is not None

    out = [
        f"# Pack report: {recipe.name}",
        "",
        f"Version {build.version}. {recipe.description}",
        "",
        "Built by `tools/packs`. Terms are hidden by topic-filter; hints are not (yet).",
        "",
        "## Summary",
        "",
        "| Bucket | Count |",
        "| --- | --- |",
        f"| Terms | {len(terms)} |",
        f"| Hints | {len(hints)} |",
        f"| Reviewed (ambiguous) | {len(reviewed)}, {len(unsettled)} still need a human |",
        f"| Dropped | {len(dropped)} |",
        "",
        (
            f"Thresholds: term below Zipf {t.term_below}, review single words below {t.review_below}, "
            f"drop from {t.drop_from}; a name of words all at least {t.common_word} is reviewed; "
            f"vocabulary below {t.rare_vocabulary} is a term; review past {t.corpus_files} corpus files; "
            f"judge term at {t.judge_term}, hint at {t.judge_hint}."
        ),
        "",
    ]
    if has_dry:
        out += [
            f"Dry run: {dry.files} files read ({dry.files_found} found, {dry.bytes / 1e6:.1f} MB), "
            f"{sum(1 for c in build.candidates if c.files)} candidates seen in them, "
            f"{build.corpus_flagged} terms sent to review for appearing in more than {t.corpus_files} files. "
            f"{dry.skipped_checkouts} topic-filter checkout(s) skipped.",
            "",
        ]
    else:
        out += ["Dry run: not run (no `--corpus`).", ""]
    if build.judge_stats:
        s = build.judge_stats
        out += [
            f"Judge: Jev ({s.model or 'all answers cached'}), {s.requests} requests, "
            f"{s.asked} questions asked, "
            f"{s.cached} answered from cache, {s.seconds:.1f} s, ${s.cost:.6f}.",
            "",
        ]
    if build.judge_error:
        out += [f"Judge failed: {build.judge_error}. Unanswered candidates stayed hints.", ""]

    out += ["## Sources", "", "| Source | Role | Depth | Found | Kept |", "| --- | --- | --- | --- | --- |"]
    for source, (found, kept) in zip(recipe.sources, build.source_counts, strict=True):
        depth = "" if source.depth is None else str(source.depth)
        out.append(f"| {_cell(source.label)} | {source.role} | {depth} | {found} | {kept} |")

    dash = "-"
    out += [
        "",
        f"## Terms ({len(terms)})",
        "",
        "| Term | Source | Zipf | Files | Hits |",
        "| --- | --- | --- | --- | --- |",
    ]
    for c in terms:
        files, hits = (c.files, c.hits) if has_dry else (dash, dash)
        out.append(f"| {_cell(c.text)} | {_cell(_sources(c, build))} | {c.zipf:.2f} | {files} | {hits} |")

    out += ["", f"## Reviewed ({len(reviewed)})", ""]
    if reviewed:
        out += [
            "| Candidate | Why | Zipf | Files | Judge | Decision |",
            "| --- | --- | --- | --- | --- | --- |",
        ]
        for c in reviewed:
            judge = dash if c.judge is None else f"{c.judge:.2f}"
            files = c.files if has_dry else dash
            why = _cell("; ".join(c.review))
            out.append(
                f"| {_cell(c.text)} | {why} | {c.zipf:.2f} | {files} | {judge} | {_decision(c, unsettled)} |"
            )
    else:
        out.append("Nothing needed review.")

    out += ["", f"## Hints ({len(hints)})", "", ", ".join(c.text for c in hints) or "None.", ""]

    out += [f"## Dropped ({len(dropped)})", "", "| Candidate | Reason |", "| --- | --- |"]
    for c in sorted(dropped, key=lambda c: (c.reason, c.key))[:MAX_DROPPED]:
        out.append(f"| {_cell(c.text)} | {c.reason} |")
    if len(dropped) > MAX_DROPPED:
        out += ["", f"And {len(dropped) - MAX_DROPPED} more."]
    return "\n".join(out) + "\n"
