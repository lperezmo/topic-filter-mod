"""Sorts candidates into terms, hints, drops and a review list by word frequency.

A term is hidden on sight, so it must be rare in ordinary English: wordfreq's
Zipf scale (0-8, where 3 is about once per million words) is the measure.
Names made only of everyday words ("Baking Pot") and moderately common single
names ("Maya") are neither safe to hide nor safe to ignore, so they go to
review, where the dry run and the judge can settle them.
"""

from collections.abc import Callable

from wordfreq import zipf_frequency

from topic_packs.clean import Candidate
from topic_packs.matcher import fold_term
from topic_packs.recipe import Recipe, Thresholds

Zipf = Callable[[str], float]


def english_zipf(text: str) -> float:
    return zipf_frequency(text, "en")


def zipf_of(text: str, zipf: Zipf) -> float:
    """The commoner of the spelling as written and as folded (accents and hyphens gone)."""
    folded = fold_term(text)
    return max(zipf(text), zipf(folded)) if folded != text else zipf(text)


def classify(candidates: list[Candidate], recipe: Recipe, zipf: Zipf = english_zipf) -> None:
    """Sets each candidate's decision, and its review reasons when it needs one."""
    excluded = {fold_term(x) for x in recipe.exclude}
    for c in candidates:
        c.zipf = round(zipf_of(c.text, zipf), 2)
        roles = {o.role for o in c.origins if o.kind == "recipe"}
        if c.key in excluded:
            c.decision, c.reason = "drop", "excluded by the recipe"
        elif "terms" in roles:
            c.decision, c.reason = "term", "listed in extra_terms"
        elif "hints" in roles:
            c.decision, c.reason = "hint", "listed in extra_hints"
        else:
            _by_frequency(c, recipe.thresholds, zipf)


def _by_frequency(c: Candidate, t: Thresholds, zipf: Zipf) -> None:
    words = c.key.split(" ")
    # wordfreq scores a phrase about as rare as its rarest word, so phrases go by their words.
    rarest = min(zipf(w) for w in words) if len(words) > 1 else c.zipf
    from_terms = any(o.role == "terms" for o in c.origins)
    # Datamuse associations are loose by nature: they only ever feed hints.
    promotable = any(o.kind != "datamuse-rel-trg" for o in c.origins)

    if from_terms and len(words) > 1:
        if c.zipf >= t.drop_from:
            c.decision, c.reason = "drop", "every word is very common"
        elif rarest >= t.common_word:
            c.decision = "hint"
            c.review.append("every word is common")
        else:
            c.decision = "term"
    elif from_terms:
        if c.zipf >= t.drop_from:
            c.decision, c.reason = "drop", "common word"
        elif c.zipf < t.term_below:
            c.decision = "term"
        elif c.zipf < t.review_below:
            c.decision = "hint"
            c.review.append("moderately common word")
        else:
            c.decision = "hint"
    elif len(words) == 1 and c.zipf >= t.drop_from:
        c.decision, c.reason = "drop", "common word"
    elif promotable and rarest < t.rare_vocabulary:
        c.decision, c.reason = "term", "rare vocabulary"
    else:
        c.decision = "hint"


def flag_corpus_hits(candidates: list[Candidate], t: Thresholds) -> int:
    """Sends terms found in too many of the user's own files to review; returns how many."""
    moved = 0
    for c in candidates:
        if c.decision == "term" and c.reason != "listed in extra_terms" and c.files > t.corpus_files:
            c.decision = "hint"
            c.review.append(f"in {c.files} corpus files")
            moved += 1
    return moved


def resolve(candidates: list[Candidate], t: Thresholds) -> None:
    """Applies judge probabilities to reviewed candidates; the rest stay hints."""
    for c in candidates:
        if not c.review or c.judge is None:
            continue
        if c.judge >= t.judge_term:
            c.decision = "term"
        elif c.judge <= t.judge_hint:
            c.decision = "hint"
